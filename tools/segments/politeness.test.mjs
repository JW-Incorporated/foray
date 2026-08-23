/* Tests for the shared host gate (epic #102).
   Run: node --test tools/segments/

   This suite exists because a reviewer mutated `MIN_HOST_INTERVAL_MS` to 0 and
   `retryAfterMs` to always-null against the previous code and BOTH survived:
   the politeness layer — the one thing in this directory that can get the
   project blocked by publishers — had no test at all, while the file headers
   described it in detail. That is the worst place for prose to be the only
   evidence, and it is why the two real bugs below went unnoticed for so long.

   No real clock and no real sleeping: `now` and `sleep` are injected, so a
   60-second `Retry-After` is asserted in microseconds.

   Each test names the one-line mutation that makes it fail, and each was run
   against that mutation before being committed (CLAUDE.md § "A green test is
   not evidence until you have broken it"). */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASE_BACKOFF_MS,
  MAX_RETRY_AFTER_MS,
  AUDIO_UA,
  CONTACT,
  CORPUS_UA,
  MIN_HOST_INTERVAL_MS,
  NIGHTLY_UA,
  REPO_URL,
  UA,
  awaitHostSlot,
  backoffMs,
  holdHost,
  hostKey,
  resetHostGates,
  retryAfterMs,
  waitBeforeRetry,
} from "./politeness.mjs";

/** A clock we control, and a sleep that records instead of sleeping. */
const harness = () => {
  const state = { t: 1_000_000, slept: [] };
  return {
    state,
    now: () => state.t,
    sleep: async (ms) => {
      state.slept.push(ms);
      state.t += ms;
    },
    advance: (ms) => {
      state.t += ms;
    },
  };
};

const headers = (v) => ({ headers: { get: (k) => (k.toLowerCase() === "retry-after" && v !== undefined ? v : null) } });

/* MUTATION: change `MIN_HOST_INTERVAL_MS` from 1200 to 0. Every worker fires
   immediately and the sweep becomes an unthrottled burst at one CDN — the
   behaviour that gets the project blocked, previously untested. Verified
   failing. */
test("consecutive requests to one host are spaced; different hosts are not", async () => {
  resetHostGates();
  const h = harness();
  const opts = { sleep: h.sleep, now: h.now };

  assert.equal(await awaitHostSlot("https://cdn.example/a.vtt", opts), 0, "first request goes straight through");
  assert.equal(await awaitHostSlot("https://cdn.example/b.vtt", opts), MIN_HOST_INTERVAL_MS, "second waits a full interval");
  assert.equal(await awaitHostSlot("https://other.example/c.vtt", opts), 0, "a different host has its own gate");
  assert.ok(MIN_HOST_INTERVAL_MS > 0, "a zero interval is not a throttle");
});

/* THE ONE THAT MATTERED.

   MUTATION: in `holdHost`, replace the body with `return 0;`. A 429 then pauses
   only the worker that received it while its siblings keep firing — verified by
   this test's second assertion dropping to 0. That was the real behaviour of
   both copies of this code, against publishers who had explicitly asked us to
   stop. Verified failing. */
test("Retry-After quiets every worker on that host, not just the one that got it", async () => {
  resetHostGates();
  const h = harness();
  const opts = { sleep: h.sleep, now: h.now };
  const url = "https://cdn.example/a.vtt";

  // Worker A is told to come back in 60s.
  const asked = waitBeforeRetry(url, headers("60"), 1, opts);
  assert.equal(asked, MAX_RETRY_AFTER_MS);

  // Worker B, a different task, now asks for a slot on the same host.
  const waited = await awaitHostSlot(url, opts);
  assert.equal(waited, MAX_RETRY_AFTER_MS, "the sibling worker must wait out the hold too");

  // A host that was never held is unaffected.
  assert.equal(await awaitHostSlot("https://elsewhere.example/x.vtt", opts), 0);
});

/* MUTATION: in `retryAfterMs`, change `return ms > 0 ? Math.min(ms, maxMs) :
   null;` (the numeric branch) to `return Math.min(ms, maxMs);`. `Retry-After: 0`
   then returns 0, `??` cannot fall back from 0, and all three attempts fire
   back to back with no backoff. Verified failing. */
test("Retry-After returns null for anything that is not a real wait", () => {
  const h = harness();
  const opts = { now: h.now };

  assert.equal(retryAfterMs(headers("30"), opts), 30_000);
  assert.equal(retryAfterMs(headers("99999"), opts), MAX_RETRY_AFTER_MS, "capped");
  assert.equal(retryAfterMs(headers(undefined), opts), null, "absent");
  assert.equal(retryAfterMs(headers("later"), opts), null, "unparseable");
  assert.equal(retryAfterMs(headers("0"), opts), null, "zero is not a wait");
  assert.equal(retryAfterMs(headers("-5"), opts), null, "negative is not a wait");

  const past = new Date(h.state.t - 1000).toUTCString();
  assert.equal(retryAfterMs(headers(past), opts), null, "an HTTP-date behind our clock is clock skew, not a wait");
  const future = new Date(h.state.t + 30_000).toUTCString();
  assert.ok(retryAfterMs(headers(future), opts) > 0, "a future HTTP-date is a real wait");
});

/* MUTATION: in `backoffMs`, drop the `+ Math.floor(random() * jitterMs)` term.
   Every worker that took the same 5xx then retries at the identical
   millisecond — a thundering herd aimed at a host that is already failing.
   Verified failing. */
test("backoff grows and is jittered so workers do not retry in lockstep", () => {
  assert.equal(backoffMs(1, { random: () => 0 }), BASE_BACKOFF_MS);
  assert.equal(backoffMs(2, { random: () => 0 }), BASE_BACKOFF_MS * 2);
  assert.equal(backoffMs(3, { random: () => 0 }), BASE_BACKOFF_MS * 4);

  const a = backoffMs(1, { random: () => 0 });
  const b = backoffMs(1, { random: () => 0.9 });
  assert.notEqual(a, b, "two workers must not compute the same retry instant");
});

/* MUTATION: in `waitBeforeRetry`, change `const wait = asked ?? backoffMs(...)`
   to `const wait = asked;`. A 5xx with no Retry-After then produces an
   undefined wait and no hold at all. Verified failing. */
test("a 5xx without Retry-After still backs off and still holds the host", async () => {
  resetHostGates();
  const h = harness();
  const opts = { sleep: h.sleep, now: h.now, random: () => 0 };
  const url = "https://cdn.example/a.vtt";

  const wait = waitBeforeRetry(url, headers(undefined), 1, opts);
  assert.equal(wait, BASE_BACKOFF_MS);
  assert.equal(await awaitHostSlot(url, opts), BASE_BACKOFF_MS, "the host is quiet for the backoff too");
});

/* MUTATION: in `hostKey`, return `String(url)` instead of the parsed host. Every
   distinct URL becomes its own gate, so the per-host throttle silently stops
   throttling anything. Verified failing. */
test("the gate keys on host, and an unparseable URL still gets one", () => {
  assert.equal(hostKey("https://cdn.example/a.vtt"), hostKey("https://cdn.example/b.vtt"));
  assert.notEqual(hostKey("https://cdn.example/a.vtt"), hostKey("https://other.example/a.vtt"));
  assert.equal(hostKey("not a url"), "unknown");
  assert.equal(hostKey(null), "unknown");
});

/* ==========================================================================
   OUR OUTBOUND IDENTITY (#316 follow-up)
   ==========================================================================
   The four strings below are the only thing a publisher sees before deciding
   whether to answer us, and #316 measured what a wrong one costs: a Buzzsprout
   edge answered 403 to a drifted copy and 206 to the canonical string, which
   silently made 423 timed transcripts unmeasurable — 337 of them already being
   anchored. Nothing announced it, because a 403 has no length to measure.

   So these tests ASSERT ON THE BYTES, not on the fact that an import exists. An
   import that resolves to the wrong string is exactly what #316 was, and a test
   that only checked the import would have passed straight through it. */

/* MUTATION: delete ` contact ${CONTACT}` from `UA` in politeness.mjs. Publishers
   who would rather complain than block lose the ability to, and ELEVEN callers
   silently change what they send — the nine this change converted, plus
   `sweep-transcripts.mjs` and `fetch-transcripts.mjs`, which already imported it.
   Verified failing. */
test("the client User-Agent is exactly the string this repo has always sent", () => {
  assert.equal(
    UA,
    "Foray/0.1 (personal podcast client; contact wjduvall@gmail.com)",
    "the bytes every podcast host has seen from this project; #302 renamed the app to 4a and left this alone"
  );
  assert.equal(CONTACT, "wjduvall@gmail.com");
});

/* MUTATION: add ` (scan)` after `ForayBot/0.1` — the exact drift #316 measured a
   403 on. Verified failing. */
test("the audio User-Agent carries no product token beyond the honest one", () => {
  assert.equal(
    AUDIO_UA,
    "ForayBot/0.1 (+https://github.com/JW-Incorporated/foray; wjduvall@gmail.com)",
    "measured 2026-08-23: this exact string draws 206 from Buzzsprout, one extra token draws 403"
  );
  assert.equal(REPO_URL, "https://github.com/JW-Incorporated/foray");
});

/* MUTATION: change `CORPUS_UA`'s contact back to `sffan15@gmail.com`, the address
   this consolidation ruled stale. Verified failing. */
test("the corpus crawler keeps a distinct token and shares the contact address", () => {
  assert.equal(
    CORPUS_UA,
    "ForayCorpusBot/1.0 (+https://github.com/JW-Incorporated/foray; internal research corpus, one-shot fetches; contact: wjduvall@gmail.com)"
  );
  /* The token is deliberately NOT the client's: robots.txt has to be able to
     allow one and refuse the other. The address deliberately IS the same one. */
  assert.notEqual(CORPUS_UA.split("/")[0], UA.split("/")[0], "a research crawler is not a podcast client");
  assert.ok(CORPUS_UA.includes(CONTACT), "and it is still us");
});

/* MUTATION: change `NIGHTLY_UA` to `foray-nightly/2.0`. Verified failing.
   PINNED RATHER THAN FIXED: it carries no contact address, which is a real gap,
   but it is a DISTINCT token aimed at Apple's lookup API rather than a truncation
   of ours, so changing it is a founder's call and not a consolidation's. This
   test exists so the two former copies cannot drift apart again while it waits. */
test("the Apple-lookup User-Agent is one string, unchanged", () => {
  assert.equal(NIGHTLY_UA, "foray-nightly/1.0");
});

/* ---------- every caller resolves to these same bytes ---------- */

/* MUTATION: in `tools/refresh/backfill-show.mjs`, replace `export { UA }` with a
   fresh `export const UA = "Foray/0.2 (...)"`. The scan below catches the literal;
   THIS catches the value, which is the half that decides what a host receives.
   Verified failing. */
test("the modules that re-export the User-Agent re-export THIS one", async () => {
  const backfillShow = await import("../refresh/backfill-show.mjs");
  const fetchAudio = await import("../transcribe/fetch-audio.mjs");
  const corpus = await import("../corpus/fetcher.mjs");

  assert.equal(backfillShow.UA, UA, "tools/refresh/backfill-show.mjs");
  assert.equal(fetchAudio.UA, UA, "tools/transcribe/fetch-audio.mjs");
  assert.equal(corpus.USER_AGENT, CORPUS_UA, "tools/corpus/fetcher.mjs");

  /* robots.txt groups are matched on the bare token. If it stops being the
     leading product token of what we actually send, every `User-agent:
     ForayCorpusBot` rule in the wild silently stops applying to us — obeying
     robots.txt under a name nobody wrote rules for. */
  assert.equal(corpus.AGENT_TOKEN, CORPUS_UA.split("/")[0]);
});

/* MUTATION: in `tools/refresh/dai.mjs`, put the default parameter back to the
   bare `Foray/0.1` it shipped with. Verified failing.

   THIS ASSERTS ON THE WIRE, NOT ON THE MODULE. `resolveHost` reads its
   User-Agent from a default parameter, so a test that imported a constant would
   never touch the code path that builds the request — the value could be right
   and the header still wrong. `fetch` is stubbed, so this makes NO network
   request: the header object is captured and the call short-circuits.
   `resolveHost` resolves ~38% of the catalogue through download-measurement
   prefixes, and it was the one tool handing publishers no way to reach us. */
test("dai.mjs sends the shared User-Agent, contact address and all", async () => {
  const { resolveHost } = await import("../refresh/dai.mjs");
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    seen.push(opts);
    return { url: "https://dcs-cached.megaphone.fm/x.mp3", status: 206 };
  };
  try {
    await resolveHost("https://pdst.fm/e/x.mp3");
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers["User-Agent"], UA);
  assert.ok(seen[0].headers["User-Agent"].includes(CONTACT), "a host that wants to complain can");
  assert.equal(seen[0].headers.Range, "bytes=0-0", "still a ranged GET, not a HEAD (corner case #1)");
});

/* MUTATION: in `tools/corpus/fetcher.mjs`, set `USER_AGENT` to a fresh literal
   instead of `CORPUS_UA`. Verified failing.

   `fetcher.test.mjs` already asserts that the wire carries `USER_AGENT`; what it
   cannot see is whether `USER_AGENT` is still OURS. This closes that half — the
   wire against the shared constant, and EVERY request including the robots.txt
   one, because a crawler that identifies itself honestly when fetching a page
   and anonymously when fetching robots.txt has the politeness backwards.
   Injected `fetchImpl`, so no network. */
test("the corpus fetcher puts the shared corpus identity on every request", async () => {
  const { createFetcher } = await import("../corpus/fetcher.mjs");
  const seen = [];
  const res = (body) => ({
    status: 200,
    headers: { get: (k) => (k.toLowerCase() === "content-type" ? "text/plain" : null) },
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  });
  const fetchImpl = async (url, opts) => {
    seen.push({ url, opts });
    return res(url.endsWith("/robots.txt") ? "User-agent: *\nDisallow:" : "hello");
  };
  const f = createFetcher({ fetchImpl, sleep: async () => {}, now: () => 0 });
  const r = await f.fetchUrl("https://example.com/a.txt");
  assert.equal(r.ok, true);

  const urls = seen.map((s) => s.url);
  assert.ok(urls.some((u) => u.endsWith("/robots.txt")), "robots.txt was fetched");
  assert.ok(urls.some((u) => u.endsWith("/a.txt")), "and so was the page");
  for (const s of seen) {
    assert.equal(s.opts.headers["user-agent"], CORPUS_UA, s.url);
  }
});

/* ==========================================================================
   THE ELEVENTH COPY (#316 follow-up)
   ==========================================================================
   The client string was spelled out TEN separate times: here, `tools/refresh/`'s
   scan, backfill-show and backfill-audio, `tools/classify/prepare-batch.mjs`,
   `tools/transcribe/fetch-audio.mjs`, `tools/harvest-catalog.mjs`,
   `tools/harvest-episodes.mjs`, `tools/refresh-feeds.mjs` and
   `backend/src/config/env.ts`. Two more sites had already drifted: `dai.mjs` to a
   bare product token with no contact address at all, and `tools/corpus/fetcher.mjs`
   to a different address. A fourth identity, `foray-nightly/1.0`, sat in two
   copies nobody had noticed at all.

   Consolidation is worth nothing if the eleventh copy lands next month, so:

   THIS SCAN IS DELIBERATELY BLUNT, AND THAT IS THE WHOLE DESIGN. It greps raw
   text for a foray-ish product token and a version, and it fails on EVERY hit
   outside a short allowlist — comments included.

   The first version of this test was clever instead: a hand-rolled lexer that
   skipped comments so that prose could quote a User-Agent freely. A reviewer
   broke it in one line. The lexer had no regex-literal state, so an ordinary
   unicode-class regex containing an apostrophe, sitting in unrelated code,
   opened a phantom string that swallowed the rest of the file — and eleven
   tracked files under `tools/` were
   ALREADY blind, including `tools/corpus/chunk.mjs` and `tools/ci/pr-triage.mjs`.
   Inserting one innocuous regex above a hardcoded User-Agent defeated it in
   every fetching file tried. Worse, whether it worked in a given file depended on
   the parity of quote characters elsewhere in that file, so an unrelated edit
   could switch the guard off silently.

   That is a guard that FAILS OPEN, which for this particular invariant is the
   one unacceptable direction: #316 was a drifted User-Agent that nothing
   announced, and a scan that quietly stops looking reproduces it exactly. A
   blunt scan can only fail CLOSED — the cost is that a new file wanting to quote
   a User-Agent in a comment must add a line here, with a reason. That is a cost
   worth paying, and it is one line.

   SCAN THE TRACKED SET, NOT THE DIRECTORY TREE — the same reason
   `test/search-matcher.test.js` does it: walking the filesystem made that test
   depend on local scratch, failing on `dist/` build output (#310) and three at a
   time on agent worktrees. Ask git what is actually in the repo.

   WHAT IT STILL DOES NOT REACH, stated rather than discovered later: a
   User-Agent assembled from concatenated pieces, or one built at runtime from a
   variable. No regex can describe those, and the value assertions above are what
   guard them — every module that exports a User-Agent is compared against these
   constants by identity, and two of them are read back off a stubbed wire. */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

/** `Foray/0.1`, `ForayBot/0.1`, `ForayCorpusBot/1.0`, `foray-nightly/1.0` — and
    whatever the next one is called. Matched anywhere in the raw bytes. */
const UA_MENTION = /\bforay[a-z0-9-]*\/[0-9]/i;

/** The ONLY files allowed to spell a User-Agent out. Everything else imports.
    Keep this list short and keep the reasons honest: each entry is a place the
    string can drift without the scan noticing, so each one needs another test
    watching it. All three below have one. */
const MAY_SPELL_IT_OUT = new Map([
  [
    "tools/segments/politeness.mjs",
    "the owner — this is the one place the four strings are defined",
  ],
  [
    "tools/segments/politeness.test.mjs",
    "this file, which pins their exact bytes; a literal that drifted here would " +
      "fail the equality assertions above, so it is the pin rather than a copy",
  ],
  [
    "tools/transcribe/ad-inflation.test.mjs",
    "quotes the 403-drawing string in prose to document #316 — deleting that " +
      "documentation to satisfy a scan would be the wrong trade",
  ],
]);

/** Tracked files, as git sees them. */
function tracked(...pathspecs) {
  return execFileSync("git", ["ls-files", "-z", ...pathspecs], {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 1 << 24,
  })
    .split("\0")
    .filter(Boolean);
}

/* MUTATION, run before committing: add
     const UA = "Foray/0.1 (personal podcast client; contact wjduvall@gmail.com)";
   to `tools/refresh/scan.mjs` — i.e. put back the copy this change removed.
   Verified failing, with:
     these files under tools/ spell out a User-Agent instead of importing
     politeness.mjs's: tools/refresh/scan.mjs
   Reverted.

   ALSO RUN, because the reviewer's break of the previous version is the reason
   this one exists: the same mutation preceded by a regex literal containing a
   quote — `const RE = /won't/;` — which the LEXER version silently missed in
   every fetching file tried, and which this version catches. Verified failing.
   And the eleven files the lexer was already blind in (`tools/corpus/chunk.mjs`,
   `tools/ci/pr-triage.mjs`, `tools/narrate/cache.mjs` and eight more) were each
   given a hardcoded UA under this version: all eleven now fail. */
test("no file under tools/ spells out a User-Agent (#316 follow-up)", () => {
  const files = tracked("tools/").filter((f) => f.endsWith(".mjs") || f.endsWith(".js"));
  assert.ok(files.length > 50, "the ls-files call returned a plausible tree, not nothing");

  const offenders = [];
  for (const rel of files) {
    if (MAY_SPELL_IT_OUT.has(rel)) continue;
    if (UA_MENTION.test(readFileSync(join(REPO, rel), "utf8"))) offenders.push(rel);
  }

  assert.deepEqual(
    offenders,
    [],
    "these files under tools/ spell out a User-Agent instead of importing " +
      `politeness.mjs's: ${offenders.join(", ")}. ` +
      "Ten copies existed and two had drifted; a drifted copy was 403'd by " +
      "Buzzsprout and cost 423 unmeasurable transcripts (#316). Import UA / " +
      "AUDIO_UA / CORPUS_UA / NIGHTLY_UA instead. If the file genuinely needs to " +
      "QUOTE one — documentation, not a request — add it to MAY_SPELL_IT_OUT " +
      "with a reason and make sure something else pins its bytes."
  );
});

/* MUTATION: change the literal in `backend/src/config/env.ts` to `Foray/0.2 (...)`.
   Verified failing. Second mutation: add
   `headers: { "User-Agent": "Foray/0.1 (...)" }` to
   `backend/src/clients/itunes.ts`, bypassing `env.userAgent` — verified failing
   on the second assertion, which is the one the reviewer asked for.

   WHY A TEXT PIN RATHER THAN AN IMPORT. `backend/` is a separately built
   TypeScript service; making its config import a `.mjs` out of `tools/` would
   couple its build to the dev-tooling tree for the sake of one string. It is also
   on `DENIED_PREFIXES` in `tools/ci/path-policy.mjs`, so an agent cannot edit it
   without a founder — which is exactly why it needs pinning FROM THIS SIDE: it is
   the copy least likely to be updated alongside the others. Internally the
   backend is already consolidated on `env.userAgent`, read by all four outbound
   clients (itunes, podcastIndex, conditionalGet, redirect); this asserts both
   that its one declaration still agrees with ours AND that no fifth caller has
   quietly started spelling its own. */
test("the backend service sends the same User-Agent as the tools (#316 follow-up)", () => {
  const ENV = "backend/src/config/env.ts";
  const src = readFileSync(join(REPO, ENV), "utf8");
  const m = src.match(/userAgent:\s*"([^"]*)"/);
  assert.ok(m, `${ENV} still declares a userAgent literal`);
  assert.equal(
    m[1],
    UA,
    `${ENV} has drifted from tools/segments/politeness.mjs. It is a DENIED path, ` +
      "so fixing it needs a founder — but shipping two identities does not become " +
      "acceptable because one of them is harder to edit."
  );

  /* `env.ts` is the backend's single source; nothing else there may spell one. */
  const others = tracked("backend/src/").filter(
    (f) => f !== ENV && UA_MENTION.test(readFileSync(join(REPO, f), "utf8"))
  );
  assert.deepEqual(
    others,
    [],
    `these backend files spell out a User-Agent instead of reading env.userAgent: ${others.join(", ")}`
  );
});
