/* Tests for the keyless-run transport — tools/generation/relay.mjs and its
 * launcher. Run: node --test tools/generation/
 *
 * WHAT IS ACTUALLY AT RISK HERE, AND THEREFORE WHAT THIS SUITE PINS
 * This relay stands in for an API key. Every failure mode it has is a QUIET
 * one — a run that looks like it is going, and is not; a latency number that
 * reads as the pipeline's and is the orchestrator's; a prompt that reached the
 * model slightly edited. A suite that only checked "it answers a POST" would
 * be worthless, so what is pinned here is the list of behaviours the relay's
 * header says it has, each traced to the `I-xx` row that bought it:
 *
 *   I-03  the request passes through unchanged           tests 7, 8
 *   F-67  a prompt can be read before it is answered     tests 9, 10
 *   I-06  ONE fence pair is stripped, and counted        tests 3-6, 15
 *   I-09  a retry joins an entry that is still parked    test 18
 *   I-10  an identical request after an answer is NEW    test 19
 *   I-19  agent_ms is separate from wall_ms, or absent   tests 12-14
 *   I-22  `tools` is recorded per request                tests 2, 16
 *   I-23  identity is the request, not the body;
 *         /reset clears map and queue TOGETHER           tests 17, 20, 21
 *   P-01  concurrent requests are answered concurrently  test 22
 *
 * THE HTTP TESTS GO OVER REAL HTTP, on 127.0.0.1 with an ephemeral port, and
 * the file tests write real files into a real temp directory. Nothing about
 * this transport is worth testing through a fake: I-23's deadlock was a real
 * process waiting on a real file, and a stubbed queue would have "passed"
 * while the relay hung.
 *
 * EVERY TEST NAMES THE ONE-LINE MUTATION THAT MAKES IT PASS FALSELY, per
 * CLAUDE.md § "A green test is not evidence until you have broken it". Each was
 * applied and observed to fail before this file was committed.
 *
 * The floor for this suite lives in test/suite-integrity.test.js.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createRelay,
  roughTokens,
  requestText,
  toolSummary,
  stripOneFence,
  bodyFingerprint,
  messageResponse,
  CHARS_PER_TOKEN,
  RETRY_COUNT_HEADER,
} from "./relay.mjs";
import { splitArgs, driverEnv, driverEntryFromPackage, PLACEHOLDER_KEY, REPO_ROOT } from "./start-run.mjs";

/* ------------------------------------------------------------------ helpers */

function scratchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-"));
}

async function withRelay(fn, opts = {}) {
  const dir = scratchDir();
  const relay = createRelay({ dir, quiet: true, ...opts });
  const port = await relay.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn({ relay, base, dir, port });
  } finally {
    await relay.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Fire a Messages API request the way the SDK does, without awaiting it — the
 *  point of this transport is that the call is PARKED, so every test that
 *  answers one has to hold the promise.
 *
 *  The abort signal is deliberate: a park that is never answered is the failure
 *  shape several of these tests are FOR (I-23), and an un-abortable fetch would
 *  keep the node:test process alive after the assertion already failed, turning
 *  a red test into a hung run. 30 s is ~10x the slowest honest case here. */
function post(base, body, headers = {}) {
  return fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
}

async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await predicate();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const SPINE_BODY = {
  model: "claude-opus-4-1",
  max_tokens: 8000,
  messages: [{ role: "user", content: "Compose a spine for: how engineering disasters repeat." }],
};

function kpiRows(dir) {
  const p = path.join(dir, "kpi.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/* ------------------------------------------------------ 1-6: pure functions */

test("1. roughTokens is chars/4, the estimate §0 commits to", () => {
  // MUTATION: change CHARS_PER_TOKEN to 3, or drop the Math.ceil. Both make a
  // keyless run's token estimates disagree with every number in the run log.
  assert.equal(CHARS_PER_TOKEN, 4);
  assert.equal(roughTokens("abcd"), 1);
  assert.equal(roughTokens("abcde"), 2);
  assert.equal(roughTokens(""), 0);
  assert.equal(roughTokens(undefined), 0);
});

test("2. requestText and toolSummary read what the pipeline actually sends", () => {
  // MUTATION: make toolSummary return `[]` instead of null for a toolless
  // request. I-22's whole point is that "offered no tools" and "the field was
  // unreadable" must not be the same value in kpi.jsonl.
  assert.equal(toolSummary(SPINE_BODY), null);
  const researcher = {
    model: "claude-haiku-4-5",
    max_tokens: 800,
    messages: [{ role: "user", content: "find the genuine controversies" }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
  };
  assert.deepEqual(toolSummary(researcher), [{ name: "web_search", type: "web_search_20250305", max_uses: 5 }]);

  // MUTATION: drop the `system` branch, or the array-of-blocks branch, from
  // requestText. The spine builder's re-ask path sends a 3-turn conversation,
  // and the token estimate would then be counted from one of them.
  const conversation = {
    system: "You are composing a spine.",
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "second" }] },
      { role: "user", content: "third" },
    ],
  };
  assert.equal(requestText(conversation), "You are composing a spine.\nfirst\nsecond\nthird");
});

test("3. stripOneFence removes a ```json wrapper (I-06)", () => {
  // MUTATION: `return { text: raw, stripped: false }` unconditionally. Every
  // fenced reply then reaches parseLastJsonBlock wrapped, and F-10 measured
  // that at about half of them.
  const out = stripOneFence('```json\n{"a":1}\n```');
  assert.equal(out.text, '{"a":1}');
  assert.equal(out.stripped, true);
  const bare = stripOneFence('```\n{"a":1}\n```');
  assert.equal(bare.text, '{"a":1}');
  assert.equal(bare.stripped, true);
});

test("4. stripOneFence removes exactly ONE pair, never a nested one (I-06)", () => {
  // MUTATION: replace lastIndexOf with a global regex strip of every "```".
  // A reply whose JSON legitimately contains a fenced block inside a string is
  // then corrupted, and the corruption reads as a model error.
  const nested = '```json\n{"note":"see ```inner``` here"}\n```';
  const out = stripOneFence(nested);
  assert.equal(out.text, '{"note":"see ```inner``` here"}');
  assert.equal(out.stripped, true);
});

test("5. stripOneFence leaves an unfenced or half-fenced reply alone (I-06)", () => {
  // MUTATION: drop the "everything after the close is whitespace" check, or
  // the language-tag shape check. Either turns a prose reply that merely
  // mentions a fence into a mangled one.
  assert.deepEqual(stripOneFence('{"a":1}'), { text: '{"a":1}', stripped: false });
  assert.deepEqual(stripOneFence("```json\nno closing fence"), { text: "```json\nno closing fence", stripped: false });
  const trailing = '```json\n{"a":1}\n```\nand a sentence after';
  assert.equal(stripOneFence(trailing).stripped, false);
  const notAFence = "``` this is prose, not a language tag\nbody\n```";
  assert.equal(stripOneFence(notAFence).stripped, false);
});

test("6. messageResponse is the shape the pipeline's own code reads", () => {
  // MUTATION: drop `usage`, or rename input_tokens. recordUsage() reads exactly
  // those two fields and silently records nothing when they are missing, so a
  // whole run's token totals would come out zero and look like a cheap run.
  const r = messageResponse({ id: "r0001", model: "claude-sonnet-4-5", text: "hi", inputTokens: 10, outputTokens: 2 });
  assert.equal(r.type, "message");
  assert.equal(r.role, "assistant");
  assert.equal(r.model, "claude-sonnet-4-5");
  assert.deepEqual(r.content, [{ type: "text", text: "hi" }]);
  assert.equal(r.stop_reason, "end_turn");
  assert.deepEqual(r.usage, { input_tokens: 10, output_tokens: 2 });
  // MUTATION: return a different model string than the request carried. The
  // tier mapping (opus/sonnet/haiku) is read off this field downstream.
  assert.equal(messageResponse({ id: "x", model: "claude-haiku-4-5", text: "", inputTokens: 0, outputTokens: 0 }).model, "claude-haiku-4-5");
});

/* ------------------------------------------- 7-11: passthrough and readability */

test("7. the parked request on disk is the request that was sent, byte for byte (I-03)", async () => {
  // MUTATION: JSON.stringify the body through any normaliser, or append an
  // instruction to the prompt the way I-07's wrapper did. The run log had to
  // quarantine that one call's answer; a silent version would taint every call.
  await withRelay(async ({ relay, base, dir }) => {
    const inFlight = post(base, SPINE_BODY);
    const entry = await waitFor(() => [...relay.pending.values()][0], "a parked request");
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "queue", `${entry.id}.request.json`), "utf8"));
    assert.deepEqual(onDisk, SPINE_BODY);
    relay.answer(entry.id, { text: "{}" });
    await inFlight;
  });
});

test("8. model and max_tokens reach the queue unchanged, and the model is echoed back (I-03)", async () => {
  // MUTATION: default max_tokens to some cap when it is large. The pipeline's
  // budget guard prices the call on the max_tokens IT chose; a relay that
  // quietly lowered it would make every keyless output shorter than a keyed one
  // for no visible reason.
  await withRelay(async ({ relay, base }) => {
    const inFlight = post(base, SPINE_BODY);
    const entry = await waitFor(() => [...relay.pending.values()][0], "a parked request");
    assert.equal(entry.body.max_tokens, 8000);
    assert.equal(entry.body.model, "claude-opus-4-1");
    relay.answer(entry.id, { text: "ok" });
    const res = await inFlight;
    const json = await res.json();
    assert.equal(json.model, "claude-opus-4-1");
    assert.equal(json.content[0].text, "ok");
  });
});

test("9. the prompt is readable BEFORE it is answered, over HTTP (F-67)", async () => {
  // MUTATION: make GET /pending/:id return a summary (id, model, length)
  // instead of `request`. F-67 was caught by reading a composed prompt while
  // the Opus call was still parked; a summary would have spent that call.
  await withRelay(async ({ relay, base }) => {
    const inFlight = post(base, SPINE_BODY);
    const entry = await waitFor(() => [...relay.pending.values()][0], "a parked request");
    const seen = await (await fetch(`${base}/pending/${entry.id}`)).json();
    assert.deepEqual(seen.request, SPINE_BODY);
    assert.match(seen.rendered, /how engineering disasters repeat/);
    assert.equal(entry.answered, false, "reading a prompt must not answer it");
    relay.answer(entry.id, { text: "ok" });
    await inFlight;
  });
});

test("10. the prompt is readable before it is answered, as a file (F-67)", async () => {
  // MUTATION: stop writing `<id>.request.txt`, leaving only the JSON. The
  // surface an answering Claude session actually reads is a file; "it is in the
  // JSON somewhere" is not the same as readable.
  await withRelay(async ({ relay, base, dir }) => {
    const inFlight = post(base, SPINE_BODY);
    const entry = await waitFor(() => [...relay.pending.values()][0], "a parked request");
    const txt = fs.readFileSync(path.join(dir, "queue", `${entry.id}.request.txt`), "utf8");
    assert.match(txt, /how engineering disasters repeat/);
    assert.match(txt, /claude-opus-4-1/);
    assert.match(txt, /max_tokens:\s+8000/);
    relay.answer(entry.id, { text: "ok" });
    await inFlight;
  });
});

test("11. an answer written as a file settles the parked call", async () => {
  // MUTATION: delete the poll and keep only fs.watch. On Windows fs.watch drops
  // events, and the relay then waits forever on a file that IS there — I-23's
  // failure mode arrived at from the other direction.
  await withRelay(async ({ relay, base, dir }) => {
    const inFlight = post(base, SPINE_BODY);
    const entry = await waitFor(() => [...relay.pending.values()][0], "a parked request");
    fs.writeFileSync(path.join(dir, "queue", `${entry.id}.reply.txt`), '{"spine":[]}');
    const json = await (await inFlight).json();
    assert.equal(json.content[0].text, '{"spine":[]}');
    assert.equal(json.type, "message");
  });
});

/* ---------------------------------------------- 12-16: what kpi.jsonl records */

test("12. kpi.jsonl records agent_ms SEPARATELY from wall_ms (I-19, §0)", async () => {
  // MUTATION: write `agent_ms: wallMs`. Run 1 call #1 was 6 s of agent inside
  // 59.6 s of wall; equating them publishes the orchestrator's human pace as a
  // pipeline latency, which is the one thing §0 says must never happen.
  await withRelay(async ({ relay, base, dir }) => {
    const inFlight = post(base, SPINE_BODY);
    const entry = await waitFor(() => [...relay.pending.values()][0], "a parked request");
    relay.answer(entry.id, { text: "ok", agent_ms: 6000 });
    await inFlight;
    const [row] = kpiRows(dir);
    assert.equal(row.agent_ms, 6000);
    assert.notEqual(row.agent_ms, row.wall_ms);
    assert.equal(typeof row.wall_ms, "number");
  });
});

test("13. agent_ms is null when nobody claimed and nobody reported it (I-19)", async () => {
  // MUTATION: `agent_ms: agentMs ?? wallMs`. A fabricated agent time reads as a
  // measured one; absent is the honest value and the run log says so.
  await withRelay(async ({ relay, base, dir }) => {
    const inFlight = post(base, SPINE_BODY);
    const entry = await waitFor(() => [...relay.pending.values()][0], "a parked request");
    relay.answer(entry.id, { text: "ok" });
    await inFlight;
    const [row] = kpiRows(dir);
    assert.equal(row.agent_ms, null);
  });
});

test("14. claiming a request starts the agent_ms clock (I-19)", async () => {
  // MUTATION: set claimedAt at park time instead of at claim time. agent_ms
  // then silently becomes wall_ms again, by a route test 12 does not cover.
  await withRelay(async ({ relay, base, dir }) => {
    const inFlight = post(base, SPINE_BODY);
    const entry = await waitFor(() => [...relay.pending.values()][0], "a parked request");
    await new Promise((r) => setTimeout(r, 60));
    await fetch(`${base}/pending/${entry.id}`); // the claim
    relay.answer(entry.id, { text: "ok" });
    await inFlight;
    const [row] = kpiRows(dir);
    assert.ok(row.agent_ms !== null, "a claimed request must get a measured agent_ms");
    assert.ok(row.agent_ms < row.wall_ms, `agent_ms ${row.agent_ms} should exclude the pre-claim wait of ${row.wall_ms}`);
  });
});

test("15. a stripped fence is COUNTED, not just removed (I-06)", async () => {
  // MUTATION: strip the fence and drop the counter. I-06's warning is exactly
  // this: the strip is fine, masking how often it was needed is not, because
  // the frequency is real model behaviour and F-10 tracked it.
  await withRelay(async ({ relay, base, dir }) => {
    const a = post(base, SPINE_BODY);
    const e1 = await waitFor(() => [...relay.pending.values()][0], "a parked request");
    relay.answer(e1.id, { text: '```json\n{"a":1}\n```' });
    const j1 = await (await a).json();
    assert.equal(j1.content[0].text, '{"a":1}');

    const b = post(base, { ...SPINE_BODY, max_tokens: 10 });
    const e2 = await waitFor(() => [...relay.pending.values()][0], "a second parked request");
    relay.answer(e2.id, { text: '{"b":2}' });
    await b;

    const rows = kpiRows(dir);
    assert.deepEqual(
      rows.map((r) => r.fence_stripped),
      [true, false]
    );
    const kpi = await (await fetch(`${base}/kpi`)).json();
    assert.equal(kpi.fenceStripped, 1, "the running total must distinguish one fenced reply from two");
  });
});

test("16. kpi.jsonl records the tools the request offered (I-22)", async () => {
  // MUTATION: drop `tools` from the KPI row. A keyless run cannot answer a
  // server-side-tool call the way the API would, so which calls offered one has
  // to be visible per call rather than decided globally.
  await withRelay(async ({ relay, base, dir }) => {
    const body = {
      model: "claude-haiku-4-5",
      max_tokens: 800,
      messages: [{ role: "user", content: "controversies?" }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
    };
    const inFlight = post(base, body);
    const entry = await waitFor(() => [...relay.pending.values()][0], "a parked request");
    const listed = await (await fetch(`${base}/pending`)).json();
    assert.equal(listed.pending[0].tools[0].name, "web_search", "the tool list must be visible BEFORE answering");
    relay.answer(entry.id, { text: "{}" });
    await inFlight;
    const [row] = kpiRows(dir);
    assert.deepEqual(row.tools, [{ name: "web_search", type: "web_search_20250305", max_uses: 5 }]);
  });
});

/* ---------------------------------------- 17-21: identity, dedupe and /reset */

test("17. a byte-identical request against a cleared queue is a NEW call, not a deadlock (I-23)", async () => {
  // THE 15-MINUTE BUG, REPRODUCED. I-23's state is "the map remembers a call
  // whose queue file is gone": the old relay keyed idempotency on a hash of the
  // request body, so the next byte-identical request joined that orphan and
  // waited on a reply file nothing would ever write. The queue files are
  // deleted below to put the relay in exactly that state before the duplicate
  // arrives.
  //
  // MUTATION: make logicalIdFor() match on bodyFingerprint regardless of
  // retry-count (i.e. `const retryCount = 1`). The second request then joins
  // the orphaned entry, no second entry is ever parked, no request file is ever
  // written for it, and this test times out — which is what the real deadlock
  // did, for about 15 minutes.
  await withRelay(async ({ relay, base, dir }) => {
    const first = post(base, SPINE_BODY);
    const e1 = await waitFor(() => [...relay.pending.values()][0], "the first parked request");
    for (const f of fs.readdirSync(path.join(dir, "queue"))) fs.rmSync(path.join(dir, "queue", f));

    const second = post(base, SPINE_BODY); // byte-identical, deliberately
    await waitFor(() => (relay.pending.size === 2 ? true : false), "the SECOND request to park as its own call");
    const e2 = [...relay.pending.values()].find((e) => e.id !== e1.id);
    assert.ok(e2, "a fresh request must never inherit a remembered call's identity");
    assert.ok(
      fs.existsSync(path.join(dir, "queue", `${e2.id}.request.txt`)),
      "a call nobody can read is a call nobody can answer — that IS the deadlock"
    );
    relay.answer(e2.id, { text: "ok" });
    assert.equal((await (await second).json()).content[0].text, "ok");
    relay.answer(e1.id, { text: "also ok" });
    await first;
  });
});

test("18. an SDK retry joins the entry that is still parked (I-09, F-07)", async () => {
  // MUTATION: ignore x-stainless-retry-count and always mint a fresh id. The
  // SDK's 10-min timeout then mints a SECOND parked copy of the same call, the
  // orchestrator answers both, and the pipeline pays twice for one stage.
  await withRelay(async ({ relay, base }) => {
    const first = post(base, SPINE_BODY, { [RETRY_COUNT_HEADER]: "0" });
    const e1 = await waitFor(() => [...relay.pending.values()][0], "the first parked request");
    const retry = post(base, SPINE_BODY, { [RETRY_COUNT_HEADER]: "1" });
    await waitFor(async () => relay.counters.retriesJoined === 1, "the retry to join");
    assert.equal(relay.pending.size, 1, "a retry must not park a second copy");

    relay.answer(e1.id, { text: "ok" });
    const [a, b] = await Promise.all([first, retry]);
    assert.equal((await a.json()).content[0].text, "ok");
    assert.equal((await b.json()).content[0].text, "ok", "both attempts get the one answer");
  });
});

test("19. an identical request AFTER the first was answered is a new call (I-10)", async () => {
  // MUTATION: delete `pending.delete(id)` from answer(). An answered entry then
  // stays in the map with its promise already resolved, the re-ask below joins
  // it, and receives "first answer". That is I-10 verbatim: the dedupe served a
  // legitimate re-ask a stale answer, which guaranteed the re-ask failed, and it
  // cost run 1 attempt 2. The `answered` flag is deliberately NOT a second guard
  // here — leaving the map on answer is the whole rule, in one place.
  await withRelay(async ({ relay, base }) => {
    const first = post(base, SPINE_BODY, { [RETRY_COUNT_HEADER]: "0" });
    const e1 = await waitFor(() => [...relay.pending.values()][0], "the first parked request");
    relay.answer(e1.id, { text: "first answer" });
    assert.equal((await (await first).json()).content[0].text, "first answer");
    assert.equal(relay.pending.has(e1.id), false, "an answered call must leave the map, or it stays joinable");

    const reask = post(base, SPINE_BODY, { [RETRY_COUNT_HEADER]: "1" });
    const e2 = await waitFor(() => [...relay.pending.values()][0], "the re-ask to park");
    assert.notEqual(e2.id, e1.id);
    relay.answer(e2.id, { text: "second answer" });
    assert.equal((await (await reask).json()).content[0].text, "second answer");
  });
});

test("20. /reset clears the in-memory map and the queue TOGETHER (I-23)", async () => {
  // MUTATION: clear the map and leave the files, or clear the files and leave
  // the map. Either half-reset IS the deadlock state: I-23 is precisely what
  // happens when one of the two survives the other.
  await withRelay(async ({ relay, base, dir }) => {
    const inFlight = post(base, SPINE_BODY);
    await waitFor(() => [...relay.pending.values()][0], "a parked request");
    assert.ok(fs.readdirSync(path.join(dir, "queue")).length > 0);

    const out = await (await fetch(`${base}/reset`, { method: "POST" })).json();
    assert.equal(out.cleared, 1);
    assert.ok(out.files >= 2, "both the .json and the .txt request files are swept");
    assert.equal(relay.pending.size, 0);
    assert.deepEqual(fs.readdirSync(path.join(dir, "queue")), []);
    await inFlight.catch(() => {});
  });
});

test("21. an idempotency header, if one is ever sent, wins over the retry-count signal (I-23)", async () => {
  // MUTATION: delete the ID_HEADERS loop. @anthropic-ai/sdk 0.68.0 sends no
  // request id (this relay's header records why), so the loop is dormant today
  // — but it is the branch that keeps the design honest to #697's wording, and
  // a future SDK that starts sending one must not fall through to body matching.
  await withRelay(async ({ relay, base }) => {
    const first = post(base, SPINE_BODY, { "idempotency-key": "call-42" });
    await waitFor(() => relay.pending.has("call-42"), "the keyed request");
    const second = post(base, { ...SPINE_BODY, max_tokens: 1 }, { "idempotency-key": "call-42" });
    await waitFor(async () => relay.counters.retriesJoined === 1, "the keyed duplicate to join");
    assert.equal(relay.pending.size, 1, "the same key is the same call even with a different body");
    relay.answer("call-42", { text: "ok" });
    await Promise.all([first, second]);
  });
});

/* ------------------------------------------------------- 22: concurrency */

test("22. three concurrent requests park and answer concurrently (P-01)", async () => {
  // MUTATION: await each park behind a shared lock (or answer in arrival
  // order). Act deepening issues its three Sonnet calls at once and the stage's
  // wall time is ONE call; serialising them turns the pipeline's only parallel
  // stage into three sequential ones, and nothing else in the repo reports it.
  await withRelay(async ({ relay, base }) => {
    const acts = [1, 2, 3].map((n) =>
      post(base, { model: "claude-sonnet-4-5", max_tokens: 4000, messages: [{ role: "user", content: `deepen act ${n}` }] })
    );
    await waitFor(() => (relay.pending.size === 3 ? true : false), "all three to be parked AT ONCE");

    const ids = [...relay.pending.keys()];
    // Answered deliberately out of arrival order: nothing may depend on it.
    relay.answer(ids[2], { text: "act3" });
    relay.answer(ids[0], { text: "act1" });
    relay.answer(ids[1], { text: "act2" });

    const texts = await Promise.all(acts.map(async (p) => (await (await p).json()).content[0].text));
    assert.deepEqual(texts, ["act1", "act2", "act3"], "each caller gets ITS OWN answer, not the first one written");
  });
});

/* ------------------------------------------------ 23-25: the launcher */

test("23. everything after `--` reaches the driver verbatim", () => {
  // MUTATION: re-parse the driver's flags instead of passing them through. Every
  // flag generateForays.ts grows would then have to be mirrored here, and the
  // first one that is not becomes a silently ignored argument.
  const a = splitArgs(["--port", "9001", "--", "--prompts", "p.json", "--duration", "medium", "--dry-run"]);
  assert.equal(a.port, 9001);
  assert.deepEqual(a.driverArgs, ["--prompts", "p.json", "--duration", "medium", "--dry-run"]);
  assert.equal(a.relayOnly, false);

  const b = splitArgs(["--relay-only"]);
  assert.equal(b.relayOnly, true);
  assert.deepEqual(b.driverArgs, []);
});

test("24. the driver is pointed at the relay AND given a key-shaped value", () => {
  // MUTATION: drop the ANTHROPIC_API_KEY line. env.anthropicDryRun is
  // `apiKey === undefined`, so every create*() returns a Stub, the driver makes
  // ZERO http calls, and the relay sits empty while the run looks healthy —
  // the exact silent failure this launcher exists to remove.
  const env = driverEnv({ PATH: "/usr/bin" }, 8787);
  assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8787");
  assert.equal(env.ANTHROPIC_API_KEY, PLACEHOLDER_KEY);
  assert.equal(env.PATH, "/usr/bin", "the rest of the environment is carried through");
});

test("25. a real key is never clobbered by the placeholder", () => {
  // MUTATION: `ANTHROPIC_API_KEY: placeholder`. A keyed run launched through the
  // relay would then quietly stop being keyed, and its KPI numbers would be
  // filed as API latency when they are orchestrator latency.
  const env = driverEnv({ ANTHROPIC_API_KEY: "sk-ant-real" }, 1234);
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-real");
  assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:1234");
});

test("27. the launcher and backend/package.json still agree on what the driver is", () => {
  // MUTATION: hardcode "src/cli/generateForays.ts" in the launcher. The two
  // then drift the day the script moves, and the launcher spawns a path that no
  // longer exists — after the relay is already up, which reads as a transport
  // fault rather than a stale launcher. Asserted against the REAL package.json,
  // because the whole risk is that the real one changed.
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "backend", "package.json"), "utf8"));
  const entry = driverEntryFromPackage(pkg);
  assert.match(entry, /\.ts$/);
  assert.ok(fs.existsSync(path.join(REPO_ROOT, "backend", entry)), `${entry} does not exist`);
  assert.throws(() => driverEntryFromPackage({ scripts: { "generate-forays": "node dist/cli.js" } }), /no longer ends in a \.ts entry/);
});

/* ------------------------------------------------------- 26: fingerprint */

test("26. bodyFingerprint distinguishes the prompts a retry must not confuse", () => {
  // MUTATION: fingerprint the model alone. Two different Sonnet calls in flight
  // at once — which is exactly what act deepening does (P-01) — would then let a
  // retry of one join the other and receive the wrong act's answer.
  const a = { model: "claude-sonnet-4-5", max_tokens: 4000, messages: [{ role: "user", content: "deepen act 1" }] };
  const b = { model: "claude-sonnet-4-5", max_tokens: 4000, messages: [{ role: "user", content: "deepen act 2" }] };
  assert.notEqual(bodyFingerprint(a), bodyFingerprint(b));
  assert.equal(bodyFingerprint(a), bodyFingerprint({ ...a }));
});
