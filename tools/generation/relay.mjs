#!/usr/bin/env node
/* The keyless-run transport: an Anthropic Messages API endpoint that parks each
 * request for a human-paced Claude session to answer, and hands the answer back
 * in the API's own response shape.
 *
 * WHY THIS FILE EXISTS AT ALL (issue #697)
 * This project runs generation with no `ANTHROPIC_API_KEY`, by the founder's
 * choice. `ANTHROPIC_BASE_URL` points the official SDK at this process instead;
 * the pipeline's own code is untouched, which is the load-bearing property of
 * the whole arrangement — `AnthropicSpineBuilder` and its six siblings call
 * `client.messages.create()` exactly as they would against api.anthropic.com,
 * and `parseWithRetry` / `parseLastJsonBlock` parse the reply exactly as they
 * would a real one. Nothing in `backend/src/generation/` knows this file exists,
 * and nothing in it may ever need to.
 *
 * Until #697 the relay lived at `scratchpad/relay/relay.mjs` — untracked,
 * ephemeral, rebuilt from a prose paragraph in a run log before every run. The
 * founder's standing rule (2026-09-14) is that anything the orchestrating
 * session does beyond starting a run and answering a request is a defect, and
 * rebuilding the transport by hand was the highest-frequency instance of it:
 * once per run, before any model call, tested by nothing.
 *
 * ============================================================================
 * WHICH BEHAVIOUR EXISTS BECAUSE OF WHICH FINDING
 * ============================================================================
 * Every rule below was paid for once already, in a run that lost time to not
 * having it. The `I-xx` ids are rows in `docs/curation/generation-findings-
 * tracker.md`; `F-xx` and `P-01` are from `docs/curation/generation-run-
 * 2026-09-09.md`. Do not remove one of these without reading its row first.
 *
 *   I-03  THE REQUEST PASSES THROUGH UNCHANGED. Model name, `max_tokens` and
 *         the composed prompt text arrive at the answering session byte for
 *         byte. The relay parses the JSON to read it and writes the parsed
 *         object straight back out; it never edits, truncates, summarises, or
 *         appends to a prompt. I-07 is the one time a wrapper added a sentence
 *         to a prompt, and the run log had to quarantine that call's answer as
 *         "the one prompt deviation of the exercise". The passthrough is not a
 *         convenience — it is what makes a keyless run's output comparable to a
 *         keyed one's.
 *
 *   F-67  THE PROMPT IS READABLE BEFORE IT IS ANSWERED. Each parked request is
 *         written to disk as both `<id>.request.json` (verbatim) and
 *         `<id>.request.txt` (the same content laid out for reading), and
 *         `GET /pending/:id` returns it. F-67 — a defect in a composed prompt —
 *         was caught by reading a parked prompt before an expensive Opus call
 *         went out. A transport that only exposed "something is waiting" would
 *         have spent that call.
 *
 *   I-06  ONE MARKDOWN FENCE PAIR IS STRIPPED, AND THE STRIPS ARE COUNTED.
 *         Models fence their JSON; F-10 measured "about half the time". The
 *         relay removes exactly one leading fence line and its matching closing
 *         line, never more, and records `fence_stripped` on the call plus a
 *         running total on `GET /kpi`. The counting is the point: I-06's whole
 *         warning is that silently masking the behaviour makes a real model
 *         property invisible. Strip it AND report how often.
 *
 *   I-09  A DUPLICATE IS ONLY DEDUPED WHILE THE ORIGINAL IS IN FLIGHT.
 *   I-10  The SDK's default is a 10-minute timeout and 2 retries (F-07), and a
 *         human-paced answer blows through that, so byte-identical retries are
 *         normal here. I-10 records what the first dedupe did wrong: it served
 *         a LEGITIMATE later re-ask the stale answer of an earlier identical
 *         call, which guaranteed the re-ask failed. So a retry joins an entry
 *         that is still parked, and never an entry that already answered.
 *
 *   I-23  IDENTITY COMES FROM THE REQUEST, NOT FROM THE BODY. This is the
 *         expensive one: ~15 minutes of deadlock and zero model calls. The old
 *         relay keyed its in-flight map on a hash of the request body. After a
 *         queue clear, the driver's first call was byte-identical to a call the
 *         map still remembered, so the relay decided it was already in flight
 *         and waited on a reply file that nothing would ever write.
 *
 *         The fix is `logicalIdFor()` below, and it is worth stating plainly
 *         because a future reader WILL think a body hash is simpler: a fresh
 *         request is ALWAYS a new logical call, no matter what it contains. The
 *         body is consulted only to decide which in-flight entry a retry
 *         belongs to, and a body fingerprint is never a map key, never
 *         persisted, and never consulted for a request that is not a retry.
 *
 *         MEASURED, NOT INFERRED — READ THIS BEFORE "FIXING" IT. #697 asks for
 *         idempotency keyed on "the SDK's request id". @anthropic-ai/sdk 0.68.0
 *         does not send one: `client.js` leaves `this.idempotencyHeader`
 *         undefined, so the idempotency-key branch of `buildHeaders()` never
 *         fires, and `requestLogID` is a local log correlator that never leaves
 *         the process ("Not an API request ID", client.js:224). What the SDK
 *         DOES put on the wire is `X-Stainless-Retry-Count`: `0` on a first
 *         attempt, `1` and `2` on the retries. That header is therefore the
 *         request-level identity signal this relay uses, and `ID_HEADERS` also
 *         honours a real idempotency key if a future SDK or a default header
 *         starts sending one. The property #697 actually wants — "a byte-
 *         identical fresh request must never be mistaken for one in flight" —
 *         is preserved exactly.
 *
 *   I-17  THE ANSWER IS TAKEN VERBATIM AND NO TOOL POLICY IS IMPLIED. A
 *         subagent once reported a tool use despite an instruction not to. The
 *         relay does not police that; it is a transport. What it does instead
 *         is the next rule.
 *
 *   I-22  `tools` IS RECORDED ON EVERY REQUEST. `AnthropicExternalResearcher`
 *         offers the server-side `web_search_20250305` tool with a `max_uses`
 *         cap; other stages offer nothing. On this transport there is no
 *         server-side tool, so whoever answers has to decide per call whether
 *         to go and retrieve. That decision must be made deliberately, which
 *         means seeing the tool list BEFORE answering — so it is on `/pending`,
 *         in the `.request.txt` header, and in `kpi.jsonl`.
 *
 *   I-23  `POST /reset` CLEARS THE MAP AND THE QUEUE TOGETHER. Added after the
 *         deadlock above, and deliberately one operation rather than two: the
 *         deadlock was exactly the state where one of the pair had been cleared
 *         and the other had not.
 *
 *   I-19  `agent_ms` IS RECORDED SEPARATELY FROM `wall_ms`, AND IS ABSENT
 *   §0    RATHER THAN GUESSED. Call #1 of run 1: the answering subagent took
 *         6 s; the relay saw 59.6 s of wall time, because a human-paced
 *         orchestration turn sat between arrival and answer. Every latency KPI
 *         from a keyless run is meaningless unless those two numbers stay
 *         apart, so `kpi.jsonl` carries both. `agent_ms` is taken from the
 *         answerer when it reports one, else measured from the moment the
 *         request was CLAIMED (first read via `GET /pending/:id`, or a
 *         `<id>.claim` file), else written as `null`. It is never quietly set
 *         equal to `wall_ms` — a fabricated agent time would read as a
 *         pipeline number, which is the one thing §0 says it must never do.
 *
 *   P-01  CONCURRENT REQUESTS ARE ANSWERED CONCURRENTLY. Act deepening issues
 *         its three Sonnet calls at once — run 1 saw #4/#5/#6 arrive inside the
 *         same second — and the stage's wall time is one call, not three. A
 *         transport that parked them one at a time would silently turn the
 *         pipeline's only parallel stage into a serial one and nothing would
 *         report it. There is no lock in this file: each request owns its own
 *         pending entry and its own promise, and answers may land in any order.
 *
 * ============================================================================
 * THE TWO SURFACES, AND WHY THERE ARE TWO
 * ============================================================================
 * FILES are the primary surface, because the thing answering these requests is
 * a Claude session whose natural tools are Read and Write. A parked request is
 * a file; an answer is a file. That is also the surface I-23's deadlock was on,
 * so it is the one that has to be right.
 *
 * HTTP is the same queue for anything scripted — `GET /pending`, `GET
 * /pending/:id`, `POST /answer/:id`, `POST /reset`, `GET /kpi`. Both surfaces
 * read and write the same in-memory map; neither is a cache of the other.
 *
 * Answering by file:
 *     <dir>/queue/<id>.request.json   written by the relay, verbatim request
 *     <dir>/queue/<id>.request.txt    written by the relay, the same for humans
 *     <dir>/queue/<id>.reply.txt      write this — the reply text, verbatim
 *   or <dir>/queue/<id>.reply.json    write this — { text, agent_ms?, error? }
 *
 * The relay watches the queue directory and also polls it, because `fs.watch`
 * on Windows misses writes often enough that a transport depending on it alone
 * would reintroduce "waited forever on a file" by a different route.
 *
 * Usage:
 *   node tools/generation/relay.mjs [--port 8788] [--dir data-local/relay]
 *                                   [--park-timeout-ms 0] [--quiet]
 *
 * LOCAL AND AUTHENTICATED (round-3 audit, data-tools-1 + security-8)
 *   - Ids are unique per process: `r<runStamp>-<seq>` (runStamp is random per
 *     createRelay), so a reply file left over from an earlier run can never
 *     answer this run's call of the same sequence number. Leftover queue files
 *     are moved to `done/stale-<ts>/` at start, for the audit trail.
 *   - Any request carrying an `Origin` header (a browser page) is refused, and
 *     so is any request whose `Host` is not 127.0.0.1:<port> or
 *     localhost:<port> (DNS rebinding).
 *   - POST /answer/:id and POST /reset need `Authorization: Bearer <token>`.
 *     The token is per run (or RELAY_TOKEN), printed at startup and written to
 *     `<dir>/token`. The FILE answer surface (`<id>.reply.txt`) needs no token:
 *     writing into the queue directory already takes local file access.
 *   - A header-derived id (an idempotency key) is used as a file name only
 *     after it is reduced to [A-Za-z0-9_-] (or hashed), so it cannot escape the
 *     queue directory.
 *   - The default port is 8788: 8787 was the retired events server's
 *     (data-tools-12 / security-9), which bound every interface.
 *
 * Started for you, together with the driver, by `tools/generation/start-run.mjs`.
 * The floor for this file's suite lives in test/suite-integrity.test.js.
 */

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ------------------------------------------------------------------ constants */

export const DEFAULT_PORT = 8788;
export const DEFAULT_DIR = "data-local/relay";

/* A real idempotency key, if anything ever sends one. Checked before the
   retry-count signal so that a future SDK release that DOES mint per-request
   ids upgrades this relay for free. See I-23's note above for why none of
   these is present today. */
export const ID_HEADERS = ["idempotency-key", "anthropic-idempotency-key", "x-idempotency-key", "x-request-id"];

/* The header @anthropic-ai/sdk 0.68.0 actually sends: "0" on a first attempt,
   "1"/"2" on its automatic retries (client.js buildHeaders). */
export const RETRY_COUNT_HEADER = "x-stainless-retry-count";

/* Token counts on this path are estimates and are recorded as such (§0). There
   is no API meter behind a relay, and a number that LOOKS metered is worse than
   one that is labelled an estimate. */
export const CHARS_PER_TOKEN = 4;

const POLL_MS = 250;

/* ------------------------------------------------------------ pure functions */

/** chars/4, the estimate §0 commits to. Exported so the tests pin the divisor
 *  rather than re-deriving it. */
export function roughTokens(text) {
  return Math.ceil((text || "").length / CHARS_PER_TOKEN);
}

/**
 * Every scrap of text the request carries, in order, for the input-token
 * estimate and for the readable rendering. `content` may be a string or an
 * array of blocks (the spine builder's re-ask path sends a 3-turn conversation).
 */
export function requestText(body) {
  const parts = [];
  if (typeof body?.system === "string") parts.push(body.system);
  else if (Array.isArray(body?.system)) for (const b of body.system) if (typeof b?.text === "string") parts.push(b.text);
  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    if (typeof m?.content === "string") parts.push(m.content);
    else if (Array.isArray(m?.content)) for (const b of m.content) if (typeof b?.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

/**
 * I-22: the tool list, reduced to what a person answering needs to see. Null
 * when the request offered none, so "no tools" and "tools I failed to read"
 * are different values in `kpi.jsonl` rather than the same empty array.
 */
export function toolSummary(body) {
  const tools = body?.tools;
  if (!Array.isArray(tools) || tools.length === 0) return null;
  return tools.map((t) => ({
    name: typeof t?.name === "string" ? t.name : null,
    type: typeof t?.type === "string" ? t.type : null,
    ...(typeof t?.max_uses === "number" ? { max_uses: t.max_uses } : {}),
  }));
}

/**
 * I-06: remove EXACTLY ONE markdown fence pair, and say whether one was there.
 *
 * One pair, not all of them: a reply whose JSON legitimately contains a fenced
 * block inside a string would be corrupted by a greedy strip, and `parseWith
 * Retry` is perfectly able to find the JSON once the outer wrapper is gone.
 * The boolean is half the feature — see the header.
 */
export function stripOneFence(text) {
  const raw = typeof text === "string" ? text : "";
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) return { text: raw, stripped: false };
  const newline = trimmed.indexOf("\n");
  if (newline === -1) return { text: raw, stripped: false };
  const openLine = trimmed.slice(3, newline).trim();
  /* An opening fence carries a language tag or nothing. Anything else is not a
     fence line and the reply is left alone. */
  if (openLine && !/^[A-Za-z0-9_+-]+$/.test(openLine)) return { text: raw, stripped: false };
  const rest = trimmed.slice(newline + 1);
  const close = rest.lastIndexOf("```");
  if (close === -1) return { text: raw, stripped: false };
  /* Everything after the closing fence must be whitespace, or the "```" found
     was an inner one and this is not a wrapped reply. */
  if (rest.slice(close + 3).trim() !== "") return { text: raw, stripped: false };
  return { text: rest.slice(0, close).replace(/\n$/, ""), stripped: true };
}

/**
 * A fingerprint of the request body, used for ONE purpose: deciding which
 * in-flight entry an SDK retry belongs to. Read I-23 in the header before
 * giving this function any other job. It is not a map key and it is never
 * persisted.
 */
export function bodyFingerprint(body) {
  return JSON.stringify([body?.model ?? null, body?.max_tokens ?? null, body?.system ?? null, body?.messages ?? null]);
}

/**
 * The Messages API success envelope. Built here rather than inline so the tests
 * can assert the exact shape `parseWithRetry` and `recordUsage` receive: a
 * `content` array with a text block, and a `usage` object with both token
 * fields (`usageTracking.recordUsage` reads `input_tokens`/`output_tokens` and
 * silently records nothing for a response that omits them).
 */
export function messageResponse({ id, model, text, inputTokens, outputTokens }) {
  return {
    id: `msg_relay_${id}`,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

/** The readable rendering an orchestrating session reads before answering
 *  (F-67). Everything a decision needs is above the prompt: which tier is being
 *  spent, how much output is allowed, and whether a tool was offered (I-22). */
export function renderRequest(entry) {
  const lines = [
    `# relay request ${entry.id}`,
    `model:       ${entry.body?.model ?? "(none)"}`,
    `max_tokens:  ${entry.body?.max_tokens ?? "(none)"}`,
    `tools:       ${entry.tools ? JSON.stringify(entry.tools) : "(none)"}`,
    `retry_count: ${entry.retryCount}`,
    `received:    ${new Date(entry.receivedAt).toISOString()}`,
    "",
    `answer by writing ${entry.id}.reply.txt beside this file, or POST /answer/${entry.id}`,
    "",
    "---- prompt (verbatim, as the pipeline composed it) ----",
    "",
    requestText(entry.body),
    "",
  ];
  return lines.join("\n");
}

/**
 * security-8 / data-tools-1: an id that came from a request header becomes a
 * file name, so it is reduced to a safe alphabet first. A value already made of
 * [A-Za-z0-9_-] (up to 64 chars) is kept; anything else is replaced by a hash,
 * so "../x" can never name a path outside the queue.
 */
export function safeHeaderId(value) {
  const v = String(value ?? "").trim();
  if (/^[A-Za-z0-9_-]{1,64}$/.test(v)) return v;
  return `h${crypto.createHash("sha1").update(v).digest("hex").slice(0, 16)}`;
}

/**
 * data-tools-1: move whatever an earlier run left in the queue (unanswered
 * requests, a reply written after that run died) into `done/stale-<ts>/`, so
 * none of it can be read as this run's. Returns how many files moved.
 */
export function sweepStaleQueue(queueDir, doneDir, stamp = new Date().toISOString().replace(/[:.]/g, "-")) {
  let names;
  try {
    names = fs.readdirSync(queueDir);
  } catch {
    return 0;
  }
  if (names.length === 0) return 0;
  const staleDir = path.join(doneDir, `stale-${stamp}`);
  fs.mkdirSync(staleDir, { recursive: true });
  for (const name of names) fs.renameSync(path.join(queueDir, name), path.join(staleDir, name));
  return names.length;
}

/* ------------------------------------------------------------------- the relay */

export function createRelay({
  dir = DEFAULT_DIR,
  parkTimeoutMs = 0,
  quiet = false,
  now = Date.now,
  token = process.env.RELAY_TOKEN || crypto.randomUUID(),
  runStamp = crypto.randomBytes(3).toString("hex"),
} = {}) {
  const rootDir = path.resolve(dir);
  const queueDir = path.join(rootDir, "queue");
  const doneDir = path.join(rootDir, "done");
  const kpiPath = path.join(rootDir, "kpi.jsonl");
  const tokenPath = path.join(rootDir, "token");

  fs.mkdirSync(queueDir, { recursive: true });
  fs.mkdirSync(doneDir, { recursive: true });
  /* data-tools-1: nothing an earlier process left in queue/ is this run's. */
  const staleMoved = sweepStaleQueue(queueDir, doneDir);
  /* security-8: the per-run bearer token, where a local answerer can read it. */
  fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  let boundPort = null;

  /** id -> entry. The ONLY map. Keyed on a logical call id (I-23), never on a
   *  body hash. */
  const pending = new Map();
  const counters = { calls: 0, answered: 0, errors: 0, fenceStripped: 0, retriesJoined: 0, timedOut: 0 };
  let seq = 0;

  const log = (...a) => {
    if (!quiet) console.log("[relay]", ...a);
  };
  if (staleMoved > 0) log(`moved ${staleMoved} leftover queue file(s) from an earlier run to ${doneDir}${path.sep}stale-*`);

  /* data-tools-1 + security-8: unique per PROCESS (runStamp) and not
     guessable across runs. `r0001` restarted with every process, so a
     leftover r0003.reply.txt answered the next run's third call. */
  function mintId() {
    seq += 1;
    return `r${runStamp}-${String(seq).padStart(4, "0")}`;
  }

  /**
   * I-23, in one function. A request that is not a retry is ALWAYS a new call.
   * A retry joins an entry that is still parked, and only then does the body
   * come into it. Nothing here can wait on a reply nobody is going to write.
   */
  function logicalIdFor(headers, body) {
    for (const h of ID_HEADERS) {
      const v = headers?.[h];
      if (typeof v === "string" && v.trim()) {
        const id = safeHeaderId(v);
        return { id, joined: pending.has(id) };
      }
    }
    const retryCount = Number(headers?.[RETRY_COUNT_HEADER] ?? 0) || 0;
    if (retryCount > 0) {
      const fp = bodyFingerprint(body);
      for (const [id, entry] of pending) {
        /* I-10 IS THE INVARIANT THAT AN ENTRY LEAVES `pending` THE INSTANT IT
           ANSWERS (see the `pending.delete(id)` at the end of `answer()`), so
           everything still in this map is still parked and this scan needs no
           second "is it answered" flag to stay correct. One rule, in one place,
           rather than two that can drift: the first dedupe served a legitimate
           re-ask the stale answer of an earlier identical call, which
           guaranteed the re-ask failed and cost run 1 attempt 2. */
        if (entry.fingerprint === fp) return { id, joined: true };
      }
    }
    return { id: mintId(), joined: false };
  }

  function queueFile(id, suffix) {
    return path.join(queueDir, `${id}${suffix}`);
  }

  function park(body, headers) {
    const { id, joined } = logicalIdFor(headers, body);
    if (joined) {
      counters.retriesJoined += 1;
      log(`retry joined in-flight ${id} (retry-count ${headers?.[RETRY_COUNT_HEADER] ?? "?"})`);
      return pending.get(id);
    }

    const entry = {
      id,
      body,
      tools: toolSummary(body),
      retryCount: Number(headers?.[RETRY_COUNT_HEADER] ?? 0) || 0,
      fingerprint: bodyFingerprint(body),
      receivedAt: now(),
      claimedAt: null,
      answered: false,
      waiters: 0,
    };
    entry.promise = new Promise((resolve) => {
      entry.resolve = resolve;
    });
    pending.set(id, entry);
    counters.calls += 1;

    /* Verbatim first, readable second. If the process dies between the two, the
       machine-readable copy is the one that survived. */
    fs.writeFileSync(queueFile(id, ".request.json"), JSON.stringify(body, null, 2));
    fs.writeFileSync(queueFile(id, ".request.txt"), renderRequest(entry));
    log(
      `parked ${id} model=${body?.model} max_tokens=${body?.max_tokens} ` +
        `tools=${entry.tools ? entry.tools.map((t) => t.name || t.type).join(",") : "none"} -> ${queueFile(id, ".request.txt")}`
    );
    return entry;
  }

  /** F-67 / I-19: reading a parked request is also what starts its `agent_ms`
   *  clock, so "how long the answer took" excludes the orchestrator's dispatch
   *  delay without anyone having to remember to say so. */
  function claim(id) {
    const entry = pending.get(id);
    if (!entry) return null;
    if (entry.claimedAt === null) entry.claimedAt = now();
    return entry;
  }

  function appendKpi(row) {
    fs.appendFileSync(kpiPath, `${JSON.stringify(row)}\n`);
  }

  /**
   * Settle one parked call. `payload` is `{ text }`, `{ text, agent_ms }`, or
   * `{ error }`. Everything that has to be true exactly once per call — the
   * fence strip and its count, the KPI row, the file sweep — happens here and
   * nowhere else, so the file surface and the HTTP surface cannot disagree.
   */
  function answer(id, payload) {
    const entry = pending.get(id);
    if (!entry) return { ok: false, reason: "unknown id" };
    if (entry.answered) return { ok: false, reason: "already answered" };

    entry.answered = true;
    const answeredAt = now();
    const wallMs = answeredAt - entry.receivedAt;

    /* I-19: taken, measured, or absent — in that order, and never invented. */
    let agentMs = null;
    if (typeof payload?.agent_ms === "number" && Number.isFinite(payload.agent_ms)) agentMs = Math.round(payload.agent_ms);
    else if (entry.claimedAt !== null) agentMs = answeredAt - entry.claimedAt;

    let outText = "";
    let stripped = false;
    let errored = false;
    if (payload?.error) {
      errored = true;
      counters.errors += 1;
    } else {
      const s = stripOneFence(payload?.text ?? "");
      outText = s.text;
      stripped = s.stripped;
      if (stripped) counters.fenceStripped += 1;
      counters.answered += 1;
    }

    const inputTokens = roughTokens(requestText(entry.body));
    const outputTokens = roughTokens(outText);

    appendKpi({
      ts: new Date(answeredAt).toISOString(),
      id: entry.id,
      model: entry.body?.model ?? null,
      max_tokens: entry.body?.max_tokens ?? null,
      /* Labelled `approx_` because they are chars/4 and there is no meter on
         this path (§0). A future reader must not average these into a bill. */
      approx_tokens_in: inputTokens,
      approx_tokens_out: outputTokens,
      wall_ms: wallMs,
      agent_ms: agentMs,
      tools: entry.tools,
      fence_stripped: stripped,
      retry_count: entry.retryCount,
      waiters: entry.waiters,
      status: errored ? "error" : "ok",
      ...(errored ? { error: payload.error } : {}),
    });

    /* Keep the pair, so a run can be audited afterwards from the queue alone. */
    for (const suffix of [".request.json", ".request.txt", ".reply.txt", ".reply.json"]) {
      const from = queueFile(id, suffix);
      if (fs.existsSync(from)) fs.renameSync(from, path.join(doneDir, `${id}${suffix}`));
    }
    if (!errored) fs.writeFileSync(path.join(doneDir, `${id}.answer.txt`), outText);

    entry.resolve(
      errored
        ? { error: payload.error, status: Number(payload.status) || 500 }
        : { response: messageResponse({ id: entry.id, model: entry.body?.model ?? null, text: outText, inputTokens, outputTokens }) }
    );
    pending.delete(id);
    log(`answered ${id} wall=${wallMs}ms agent=${agentMs === null ? "n/a" : `${agentMs}ms`} fenced=${stripped}`);
    return { ok: true };
  }

  /**
   * I-23: the map and the queue clear TOGETHER. The deadlock was the state in
   * which one of them had been cleared and the other had not, so this is
   * deliberately one call and not two — there is no `/reset?map-only`.
   */
  function reset() {
    for (const [, entry] of pending) {
      if (!entry.answered) {
        entry.answered = true;
        entry.resolve({ error: { type: "api_error", message: "relay reset" }, status: 503 });
      }
    }
    const cleared = pending.size;
    pending.clear();
    let files = 0;
    for (const f of fs.readdirSync(queueDir)) {
      fs.rmSync(path.join(queueDir, f), { force: true });
      files += 1;
    }
    log(`reset: ${cleared} in-flight entr(ies) and ${files} queue file(s) cleared together`);
    return { cleared, files };
  }

  /* --------------------------------------------------- the file answer surface */

  /** Pick up `<id>.reply.txt` / `<id>.reply.json` written by an orchestrating
   *  session. Polled as well as watched: `fs.watch` on Windows drops events,
   *  and a transport that missed one would hang exactly the way I-23 did. */
  function sweepReplies() {
    let names;
    try {
      names = fs.readdirSync(queueDir);
    } catch {
      return;
    }
    for (const name of names) {
      const json = name.endsWith(".reply.json");
      const txt = name.endsWith(".reply.txt");
      if (!json && !txt) continue;
      const id = name.slice(0, name.length - (json ? ".reply.json".length : ".reply.txt".length));
      const entry = pending.get(id);
      if (!entry || entry.answered) continue;
      let payload;
      try {
        const raw = fs.readFileSync(path.join(queueDir, name), "utf8");
        payload = json ? JSON.parse(raw) : { text: raw };
      } catch {
        /* A half-written file: leave it, the next sweep gets it whole. */
        continue;
      }
      answer(id, payload);
    }
    /* A `<id>.claim` file is the file-surface equivalent of GET /pending/:id,
       for an answerer that never speaks HTTP (I-19). */
    for (const name of names) {
      if (!name.endsWith(".claim")) continue;
      claim(name.slice(0, name.length - ".claim".length));
    }
  }

  /* ------------------------------------------------------------------ HTTP */

  function json(res, status, obj) {
    const buf = Buffer.from(JSON.stringify(obj));
    res.writeHead(status, { "content-type": "application/json", "content-length": buf.length });
    res.end(buf);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  /** security-8: who may talk to this process at all. A browser page sends
   *  `Origin`; the SDK and curl do not. A rebinding page sends its own Host. */
  function refusedCaller(req) {
    if (req.headers.origin !== undefined) return "requests from a web page (Origin header) are refused";
    if (boundPort !== null) {
      const host = String(req.headers.host ?? "").toLowerCase();
      if (host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`) return `Host "${host}" is not this relay`;
    }
    return null;
  }

  function authorized(req) {
    const header = String(req.headers.authorization ?? "");
    const expected = `Bearer ${token}`;
    return header.length === expected.length && crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const route = url.pathname;
    try {
      const refused = refusedCaller(req);
      if (refused) return json(res, 403, { type: "error", error: { type: "permission_error", message: refused } });

      if (req.method === "GET" && (route === "/health" || route === "/")) return json(res, 200, { ok: true, pending: pending.size });

      if (req.method === "GET" && route === "/kpi") {
        return json(res, 200, { ...counters, pending: pending.size, kpiPath, queueDir });
      }

      if (req.method === "GET" && route === "/pending") {
        return json(res, 200, {
          pending: [...pending.values()].map((e) => ({
            id: e.id,
            model: e.body?.model ?? null,
            max_tokens: e.body?.max_tokens ?? null,
            tools: e.tools,
            retry_count: e.retryCount,
            claimed: e.claimedAt !== null,
            waited_ms: now() - e.receivedAt,
            request_file: queueFile(e.id, ".request.txt"),
          })),
        });
      }

      if (req.method === "GET" && route.startsWith("/pending/")) {
        const entry = claim(route.slice("/pending/".length));
        if (!entry) return json(res, 404, { error: "unknown id" });
        /* F-67: the whole request, not a summary. */
        return json(res, 200, { id: entry.id, request: entry.body, tools: entry.tools, rendered: renderRequest(entry) });
      }

      if (req.method === "POST" && (route.startsWith("/answer/") || route === "/reset") && !authorized(req)) {
        return json(res, 401, { type: "error", error: { type: "authentication_error", message: `${route} needs Authorization: Bearer <token> (printed at startup, and in ${tokenPath})` } });
      }

      if (req.method === "POST" && route.startsWith("/answer/")) {
        const id = route.slice("/answer/".length);
        const raw = await readBody(req);
        let payload;
        try {
          payload = raw.trim().startsWith("{") ? JSON.parse(raw) : { text: raw };
        } catch {
          payload = { text: raw };
        }
        const out = answer(id, payload);
        return json(res, out.ok ? 200 : 409, out);
      }

      if (req.method === "POST" && route === "/reset") return json(res, 200, reset());

      if (req.method === "POST" && route === "/v1/messages") {
        const raw = await readBody(req);
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "body was not JSON" } });
        }
        const entry = park(body, req.headers);
        entry.waiters += 1;

        let timer = null;
        const settled = await Promise.race([
          entry.promise,
          parkTimeoutMs > 0
            ? new Promise((resolve) => {
                timer = setTimeout(() => resolve({ timeout: true }), parkTimeoutMs);
              })
            : new Promise(() => {}),
        ]);
        if (timer) clearTimeout(timer);

        if (settled?.timeout) {
          counters.timedOut += 1;
          /* 429-shaped so the SDK's own retry policy applies rather than the
             call dying — the retry then joins this same entry (I-09). */
          return json(res, 429, { type: "error", error: { type: "rate_limit_error", message: `relay park timeout after ${parkTimeoutMs}ms` } });
        }
        if (settled?.error) return json(res, settled.status ?? 500, { type: "error", error: settled.error });
        return json(res, 200, settled.response);
      }

      return json(res, 404, { type: "error", error: { type: "not_found_error", message: `no route ${req.method} ${route}` } });
    } catch (err) {
      return json(res, 500, { type: "error", error: { type: "api_error", message: String(err?.message ?? err) } });
    }
  });

  let poll = null;
  let watcher = null;

  async function listen(port = DEFAULT_PORT) {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    poll = setInterval(sweepReplies, POLL_MS);
    if (typeof poll.unref === "function") poll.unref();
    try {
      watcher = fs.watch(queueDir, () => sweepReplies());
    } catch {
      watcher = null; /* poll alone is sufficient, just slower. */
    }
    const actual = server.address().port;
    boundPort = actual;
    log(`listening on http://127.0.0.1:${actual}  queue=${queueDir}  kpi=${kpiPath}`);
    log(`answer token (POST /answer/:id and /reset need "Authorization: Bearer <token>"): ${token}  (also in ${tokenPath})`);
    return actual;
  }

  async function close() {
    if (poll) clearInterval(poll);
    if (watcher) watcher.close();
    await new Promise((resolve) => server.close(resolve));
  }

  return { server, listen, close, park, answer, claim, reset, sweepReplies, pending, counters, token, runStamp, dirs: { rootDir, queueDir, doneDir, kpiPath, tokenPath } };
}

/* ------------------------------------------------------------------- the CLI */

export function parseArgs(argv) {
  const val = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i === -1 || i === argv.length - 1 ? fallback : argv[i + 1];
  };
  return {
    port: Number(val("--port", process.env.RELAY_PORT ?? DEFAULT_PORT)),
    dir: val("--dir", process.env.RELAY_DIR ?? DEFAULT_DIR),
    parkTimeoutMs: Number(val("--park-timeout-ms", 0)),
    quiet: argv.includes("--quiet"),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const relay = createRelay(args);
  await relay.listen(args.port);
  const stop = async () => {
    await relay.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
