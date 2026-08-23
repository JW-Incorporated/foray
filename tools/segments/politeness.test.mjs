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
import {
  BASE_BACKOFF_MS,
  MAX_RETRY_AFTER_MS,
  MIN_HOST_INTERVAL_MS,
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

/* MUTATION: change `UA` to a string without a contact address. Publishers who
   want to complain instead of blocking lose the ability to, and the repo's
   other fetchers disagree about who we are. Verified failing. */
test("the User-Agent names the project and a way to reach us", () => {
  assert.match(UA, /^Foray\/0\.1 /, "the string every request from this repo has carried");
  assert.match(UA, /wjduvall@gmail\.com/, "a contact address, so blocking is not the only recourse");
});
