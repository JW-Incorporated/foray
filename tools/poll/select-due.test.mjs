/* Due-set selection + weekly projection for the S-10 watchlist poller
   (tools/poll/select-due.mjs, PKG-06).
   Run:
   node --test tools/poll/select-due.test.mjs

   Every test names the one-line mutation that turns it red; each was applied to
   select-due.mjs, confirmed changed on disk, and seen to fail this suite. The
   rules under test are stated in select-due.mjs's header. weeklyProjection is
   the number founder gate G9 (docs/roadmap/shows-search.md §1) is judged by. */

import test from "node:test";
import assert from "node:assert/strict";
import { selectDue, weeklyProjection } from "./select-due.mjs";
import { PolitenessBudget } from "./politeness.mjs";

const NOW = Date.UTC(2026, 9, 1); // fixed so no test reads the clock

const row = (over = {}) => ({
  pi_id: 1,
  feed_url: "https://feeds.example.com/1.xml",
  tier: "daily",
  next_due_at_ms: NOW - 1000,
  state: "active",
  watch_reasons: ["curated"],
  ...over,
});

/** n rows, each on its own host, so the per-host cap never binds. */
const spread = (n, over = (i) => ({})) =>
  Array.from({ length: n }, (_, i) => row({ pi_id: i + 1, feed_url: `https://h${i}.example.com/feed`, ...over(i) }));

test("dead and not-yet-due rows are skipped and counted", () => {
  // MUTATION: delete the `if (row.state === "dead") { ... }` filter -> red.
  const rows = [
    row({ pi_id: 1, state: "dead" }),
    row({ pi_id: 2, state: "dead", next_due_at_ms: null }),
    row({ pi_id: 3, next_due_at_ms: NOW + 1 }),
    row({ pi_id: 4, next_due_at_ms: NOW }), // exactly now is due
    row({ pi_id: 5 }),
  ];
  const out = selectDue(rows, { nowMs: NOW });
  assert.deepEqual(out.due.map((r) => r.pi_id), [5, 4]);
  assert.deepEqual(out.skipped, { dead: 2, notDue: 1, perRunCap: 0, perHostCap: 0, badUrl: 0 });
  assert.deepEqual(out.hosts, { "feeds.example.com": 2 });
});

test("per-run cap holds at 300; order is next_due then pi_id with null pi_id last", () => {
  // MUTATION: delete `candidates.sort(byDueThenPiId);` -> red.
  // 400 rows in REVERSE order of what the sort must produce.
  const rows = spread(400, (i) => ({ pi_id: 400 - i, next_due_at_ms: NOW - 1000 - (400 - i) })).reverse();
  const out = selectDue(rows, { nowMs: NOW });
  assert.equal(out.due.length, 300);
  assert.equal(out.skipped.perRunCap, 100);
  // smallest next_due first: pi_id 400 has next_due NOW-1400, the oldest
  assert.deepEqual(out.due.slice(0, 3).map((r) => r.pi_id), [400, 399, 398]);
  assert.equal(out.due[299].pi_id, 101);

  const ties = [
    row({ pi_id: null, feed_url: "https://a.example.com/x" }),
    row({ pi_id: 7, feed_url: "https://b.example.com/x" }),
    row({ pi_id: 3, feed_url: "https://c.example.com/x" }),
    row({ pi_id: 9, feed_url: "https://d.example.com/x", next_due_at_ms: null }),
    row({ pi_id: null, feed_url: "https://e.example.com/x", next_due_at_ms: NOW - 5000 }),
  ];
  const t = selectDue(ties, { nowMs: NOW });
  assert.deepEqual(t.due.map((r) => r.pi_id), [9, null, 3, 7, null], "null next_due first; null pi_id after every number");
  assert.deepEqual(t.due.map((r) => new URL(r.feed_url).hostname[0]), ["d", "e", "c", "b", "a"]);
  assert.equal(selectDue(rows, { nowMs: NOW, perRunCap: 10 }).skipped.perRunCap, 390);
});

test("one host cannot exceed perHostCap", () => {
  // MUTATION: delete `taken.set(host, count + 1);` -> red.
  const rows = Array.from({ length: 25 }, (_, i) => row({ pi_id: i + 1, feed_url: `https://FEEDS.libsyn.com/show${i}/rss` }));
  rows.push(row({ pi_id: 99, feed_url: "https://other.example.com/rss" }));
  const out = selectDue(rows, { nowMs: NOW });
  assert.equal(out.due.length, 21);
  assert.equal(out.skipped.perHostCap, 5);
  assert.deepEqual(out.hosts, { "feeds.libsyn.com": 20, "other.example.com": 1 });
  assert.deepEqual(out.due.filter((r) => r.feed_url.includes("libsyn")).map((r) => r.pi_id), Array.from({ length: 20 }, (_, i) => i + 1));
});

test("null next_due_at is due; a null pi_id row is eligible; a bad URL is counted not thrown", () => {
  // MUTATION: `row.next_due_at_ms != null && row.next_due_at_ms > nowMs` -> `(row.next_due_at_ms ?? Infinity) > nowMs` -> red.
  const rows = [
    row({ pi_id: 1, next_due_at_ms: null }),
    row({ pi_id: null, feed_url: "https://unmapped.example.com/rss", watch_reasons: ["curated", "unmapped"] }),
    row({ pi_id: 3, feed_url: "not a url" }),
    row({ pi_id: 4, feed_url: "" }),
  ];
  const out = selectDue(rows, { nowMs: NOW });
  assert.deepEqual(out.due.map((r) => r.pi_id), [1, null]);
  assert.deepEqual(out.skipped, { dead: 0, notDue: 0, perRunCap: 0, perHostCap: 0, badUrl: 2 });
  assert.deepEqual(out.hosts, { "feeds.example.com": 1, "unmapped.example.com": 1 });
});

test("the dry-run never advances the budget clock; a host the caller put in backoff is skipped", () => {
  // MUTATION: add `budget.recordRequestStart(host, nowMs);` after `due.push(row);` -> red.
  const budget = new PolitenessBudget();
  budget.recordFailure("blocked.example.com", NOW);
  const rows = [
    row({ pi_id: 1 }),
    row({ pi_id: 2 }),
    row({ pi_id: 3, feed_url: "https://blocked.example.com/rss" }),
  ];
  const out = selectDue(rows, { nowMs: NOW, budget });
  assert.deepEqual(out.due.map((r) => r.pi_id), [1, 2], "two rows on one host in one run: no 2 s spacing applied");
  assert.equal(out.skipped.perHostCap, 1);
  assert.equal(budget.msUntilAllowed("feeds.example.com", NOW), 0, "selection left the budget untouched");
});

test("weeklyProjection: 5,000 daily rows -> 35,000/week; a dead row -> 0", () => {
  // MUTATION: `if (row.state !== "active") continue;` deleted -> red.
  const daily = spread(5000);
  const p = weeklyProjection([...daily, row({ pi_id: 9999, state: "dead" })]);
  assert.equal(p.requestsPerWeek, 35000);
  assert.deepEqual(p.byTier, { daily: { rows: 5000, requestsPerWeek: 35000 } });
  assert.ok(p.requestsPerWeek < 40000, "the G9 default target");

  assert.deepEqual(weeklyProjection([row({ state: "dead", tier: "hourly" })]), { requestsPerWeek: 0, byTier: {} });
  const mixed = weeklyProjection([row({ tier: "hourly" }), row({ tier: "several_daily" }), row({ tier: "weekly" })]);
  assert.equal(mixed.requestsPerWeek, 168 + 28 + 1);
  assert.throws(() => weeklyProjection([row({ tier: "monthly" })]), RangeError);
});
