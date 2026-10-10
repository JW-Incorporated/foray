/* One no-DB poll cycle of the S-10 watchlist poller (tools/poll/poll-cycle.mjs,
   PKG-10 core).
   Run:
   node --test tools/poll/poll-cycle.test.mjs

   The fixture is a node:http server on 127.0.0.1:0 serving 50 feeds
   (/feed/0 .. /feed/49), each with its own ETag and answering 304 to a matching
   If-None-Match; a per-path override map makes a feed answer 500, 404 or 410.
   The clock is fake: each run is handed `nowMs` from a counter the test
   advances, so day 29 and day 30 are exact and nothing reads Date.now(). Every
   fixture feed shares ONE host, so perHostCap is passed explicitly.

   Every test names the one-line mutation that turns it red; each was applied to
   poll-cycle.mjs and seen to fail this suite. */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Buffer } from "node:buffer";
import { PolitenessBudget } from "./politeness.mjs";
import { TIER_INTERVAL_MS } from "./tiers.mjs";
import { createMemoryStore, runPollCycle } from "./poll-cycle.mjs";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1);
const FEEDS = 50;

async function withFixture(fn) {
  const requests = [];
  const override = new Map(); // path -> status
  const chunked = new Set(); // paths whose 200 is streamed with no Content-Length
  const server = http.createServer((req, res) => {
    const inm = req.headers["if-none-match"] ?? null;
    requests.push({ path: req.url, ifNoneMatch: inm });
    const forced = override.get(req.url);
    if (forced) {
      res.writeHead(forced);
      return res.end();
    }
    const m = /^\/feed\/(\d+)$/.exec(req.url);
    if (!m) {
      res.writeHead(404);
      return res.end();
    }
    const etag = `"v1-${m[1]}"`;
    if (inm === etag) {
      res.writeHead(304, { ETag: etag });
      return res.end();
    }
    const body = `<rss><channel><title>feed ${m[1]}</title></channel></rss>`;
    if (chunked.has(req.url)) {
      res.writeHead(200, { ETag: etag, "Content-Type": "application/rss+xml" }); // no length -> chunked
      res.write(body.slice(0, 10));
      return res.end(body.slice(10));
    }
    res.writeHead(200, { ETag: etag, "Content-Type": "application/rss+xml", "Content-Length": String(Buffer.byteLength(body)) });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const rows = Array.from({ length: FEEDS }, (_, i) => ({
    pi_id: 1000 + i,
    feed_url: `${base}/feed/${i}`,
    tier: "daily",
    next_due_at_ms: null,
    state: "active",
    watch_reasons: ["chart"],
  }));
  try {
    return await fn({ base, rows, requests, override, chunked });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const run = (rows, store, nowMs, extra = {}) =>
  runPollCycle({ rows, store, fetchImpl: fetch, nowMs, perRunCap: 300, perHostCap: FEEDS, ...extra });

test("first run stores each 200's ETag; the second sends If-None-Match, gets 304 and advances next_due by the tier interval", async () => {
  // MUTATION: drop `etag: res.etag,` from the success merge in runPollCycle -> red (no If-None-Match on run 2).
  // MUTATION: `next.next_due_at_ms = nextDueAt(next.tier, nowMs)` -> `= nowMs` -> red.
  // MUTATION: selection on the bare rows (`return { ...row, __row: row }`, stored state not laid over) -> red.
  await withFixture(async ({ rows, requests }) => {
    const store = createMemoryStore();
    const first = await run(rows, store, T0);
    assert.equal(first.outcomes.length, FEEDS);
    assert.ok(first.outcomes.every((o) => o.status === 200 && o.ok && !o.notModified));
    assert.ok(requests.every((r) => r.ifNoneMatch === null), "run 1 has no validators to send");
    for (let i = 0; i < FEEDS; i++) {
      const st = store.get(rows[i].feed_url);
      assert.equal(st.etag, `"v1-${i}"`);
      assert.equal(st.next_due_at_ms, T0 + TIER_INTERVAL_MS.daily);
    }

    const notYet = await run(rows, store, T0 + DAY - 1);
    assert.equal(notYet.outcomes.length, 0, "nothing is due a millisecond early");
    assert.equal(notYet.skipped.notDue, FEEDS);

    requests.length = 0;
    const t1 = T0 + DAY;
    const second = await run(rows, store, t1);
    assert.equal(second.outcomes.length, FEEDS);
    assert.equal(requests.length, FEEDS);
    requests.forEach((r) => assert.equal(r.ifNoneMatch, `"v1-${r.path.split("/")[2]}"`));
    for (const o of second.outcomes) {
      assert.equal(o.status, 304);
      assert.equal(o.notModified, true);
      assert.equal(o.ok, true);
      assert.equal(o.tier, "daily");
      assert.equal(o.next_due_at_ms, t1 + TIER_INTERVAL_MS.daily);
      assert.equal(store.get(o.feed_url).etag, `"v1-${o.feed_url.split("/").pop()}"`, "a 304 keeps the stored ETag");
    }
  });
});

test("5 consecutive 500s move a feed to backoff and keep its ETag; a later success moves it to weekly", async () => {
  // MUTATION: `next = { ...applySuccess(prior), ...}` -> `next = { ...prior, ...}` -> red (stays backoff).
  // MUTATION: failure branch `next = applyFailure(...)` -> `{ ...applyFailure(...), etag: res.etag }` -> red (ETag lost).
  // MUTATION: `if (isHostFailure(res.status))` -> `if (false)` -> red (budget never hears the 500).
  await withFixture(async ({ rows, override }) => {
    const feed = rows.slice(0, 1);
    const store = createMemoryStore();
    const budget = new PolitenessBudget();
    let now = T0;
    await run(feed, store, now, { budget });
    assert.equal(store.get(feed[0].feed_url).etag, '"v1-0"');

    override.set("/feed/0", 500);
    for (let n = 1; n <= 5; n++) {
      now = store.get(feed[0].feed_url).next_due_at_ms;
      const { outcomes } = await run(feed, store, now, { budget });
      assert.equal(outcomes.length, 1, `failure ${n} was fetched`);
      assert.equal(outcomes[0].status, 500);
      assert.equal(outcomes[0].ok, false);
      assert.equal(outcomes[0].tier, n < 5 ? "daily" : "backoff", `tier after failure ${n}`);
      assert.equal(budget.consecutiveFailuresFor("127.0.0.1"), n, "a 5xx is a host failure");
    }
    const st = store.get(feed[0].feed_url);
    assert.equal(st.consecutiveFailures, 5);
    assert.equal(st.etag, '"v1-0"', "a failure keeps the stored validators");
    assert.equal(st.next_due_at_ms, now + TIER_INTERVAL_MS.backoff);

    override.delete("/feed/0");
    now = st.next_due_at_ms;
    const { outcomes } = await run(feed, store, now, { budget });
    assert.equal(outcomes[0].status, 304);
    assert.equal(outcomes[0].tier, "weekly");
    assert.equal(outcomes[0].next_due_at_ms, now + TIER_INTERVAL_MS.weekly);
    assert.equal(store.get(feed[0].feed_url).consecutiveFailures, 0);
    assert.equal(budget.consecutiveFailuresFor("127.0.0.1"), 0);
  });
});

test("410 is dead at once and never fetched again; 404 is dead at day 30, not day 29, and neither is a host failure", async () => {
  // MUTATION: `applyFailure(prior, { status: res.status, nowMs })` -> `{ status: 500, nowMs }` -> red.
  // MUTATION: `next = applyFailure(prior, ...)` -> `applyFailure({ ...prior, firstNotFoundAtMs: null }, ...)` -> red (404 never dies).
  // MUTATION: `isHostFailure` -> `return true` -> red (404/410 would block the host).
  await withFixture(async ({ rows, override, requests }) => {
    const gone = rows[1];
    const missing = rows[2];
    override.set("/feed/1", 410);
    override.set("/feed/2", 404);
    const store = createMemoryStore();
    const budget = new PolitenessBudget();

    const day0 = await run([gone, missing], store, T0, { budget });
    const byUrl = Object.fromEntries(day0.outcomes.map((o) => [o.feed_url, o]));
    assert.equal(byUrl[gone.feed_url].state, "dead");
    assert.equal(byUrl[missing.feed_url].state, "active");
    assert.equal(budget.consecutiveFailuresFor("127.0.0.1"), 0);

    const day29 = await run([gone, missing], store, T0 + 29 * DAY, { budget });
    assert.equal(day29.skipped.dead, 1, "the 410 feed is skipped as dead");
    assert.deepEqual(day29.outcomes.map((o) => [o.feed_url, o.state]), [[missing.feed_url, "active"]]);

    const day30 = await run([gone, missing], store, T0 + 30 * DAY, { budget });
    assert.deepEqual(day30.outcomes.map((o) => [o.feed_url, o.status, o.state]), [[missing.feed_url, 404, "dead"]]);
    assert.equal(requests.filter((r) => r.path === "/feed/1").length, 1, "the 410 feed was requested once");
    assert.equal((await run([gone, missing], store, T0 + 60 * DAY, { budget })).outcomes.length, 0);
  });
});

test("perHostCap holds on a single-host fixture and the rest are reported skipped", async () => {
  // MUTATION: drop `if (perHostCap !== undefined) selectOpts.perHostCap = perHostCap;` -> red (default 20 taken).
  await withFixture(async ({ rows, requests }) => {
    const store = createMemoryStore();
    const r = await run(rows, store, T0, { perHostCap: 7 });
    assert.equal(r.outcomes.length, 7);
    assert.equal(requests.length, 7, "only the capped rows reached the server");
    assert.equal(r.skipped.perHostCap, FEEDS - 7);
    assert.deepEqual(r.hosts, { "127.0.0.1": 7 });
    assert.deepEqual(
      r.outcomes.map((o) => o.pi_id),
      [1000, 1001, 1002, 1003, 1004, 1005, 1006],
    );
    assert.equal(store.entries().length, 7, "a feed that was not fetched is not written");
  });
});

test("a declared and a streamed oversize body are both failed polls that keep the stored validators", async () => {
  // MUTATION: `const ok = !res.error && isSuccess(res.status)` -> `const ok = isSuccess(res.status)` -> red
  //   (the declared-oversize 200 would count as a success and wipe the ETag).
  // (A status-0 result always carries an `error`, so the streamed case is held by
  //  the same `!res.error` clause; isSuccess's status range is belt-and-braces.)
  await withFixture(async ({ rows, chunked }) => {
    const declared = rows[3];
    const streamed = rows[4];
    chunked.add("/feed/4");
    const store = createMemoryStore();
    await run([declared, streamed], store, T0);
    // Spoil the stored ETags so run 2 gets a full body, not a 304.
    for (const r of [declared, streamed]) store.set(r.feed_url, { ...store.get(r.feed_url), etag: '"stale"' });

    const { outcomes } = await run([declared, streamed], store, T0 + DAY, { fetchOpts: { maxBytes: 16 } });
    const byUrl = Object.fromEntries(outcomes.map((o) => [o.feed_url, o]));
    assert.equal(byUrl[declared.feed_url].status, 200);
    assert.match(byUrl[declared.feed_url].error, /^declared Content-Length \d+ exceeds 16 byte limit$/);
    assert.equal(byUrl[streamed.feed_url].status, 0);
    assert.match(byUrl[streamed.feed_url].error, /exceeded 16 bytes \(aborted mid-stream\)/);
    for (const r of [declared, streamed]) {
      assert.equal(byUrl[r.feed_url].ok, false);
      const st = store.get(r.feed_url);
      assert.equal(st.etag, '"stale"', "a rejected body keeps the stored validators");
      assert.equal(st.consecutiveFailures, 1);
      assert.equal(st.state, "active");
    }
  });
});
