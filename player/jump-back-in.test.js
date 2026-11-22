/* "Jump back in" housekeeping: the x and the age-out (founder, 2026-10-15;
 * player/jump-back-in.js).
 *
 * Every test names the one-line mutation that turns it red (CLAUDE.md).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { visibleJumpBackIn, withDismissed, jbiKey, JBI_MAX_AGE_DAYS, JBI_DISMISS_MAX } from "./jump-back-in.js";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const daysAgo = (d) => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString();
const ids = (rows) => rows.map((r) => r.id);

// MUTATION: `at < cutoff` -> `at > cutoff` (or drop the age check) -> red.
test("an entry last played more than 14 days ago leaves the rail; a recent one stays", () => {
  assert.equal(JBI_MAX_AGE_DAYS, 14);
  const rows = [
    { kind: "episode", id: "fresh", at: daysAgo(1) },
    { kind: "playlist", id: "edge", at: daysAgo(13.9) },
    { kind: "foray", id: "stale", at: daysAgo(15) },
  ];
  assert.deepEqual(ids(visibleJumpBackIn(rows, { now: NOW })), ["fresh", "edge"]);
});

// MUTATION: treat a missing `at` as infinitely old -> red.
test("an entry with no timestamp is never aged out", () => {
  const rows = [{ kind: "foray", id: "undated", at: null }, { kind: "foray", id: "bad", at: "not a date" }];
  assert.deepEqual(ids(visibleJumpBackIn(rows, { now: NOW })), ["undated", "bad"]);
});

// MUTATION: drop the dismissed check -> red.
test("a dismissed entry is hidden, and the others keep their order", () => {
  const rows = [
    { kind: "episode", id: "a", at: daysAgo(1) },
    { kind: "episode", id: "b", at: daysAgo(2) },
    { kind: "playlist", id: "c", at: daysAgo(3) },
  ];
  const dismissed = withDismissed({}, rows[1], NOW);
  assert.deepEqual(ids(visibleJumpBackIn(rows, { dismissed, now: NOW })), ["a", "c"]);
});

// MUTATION: `at <= gone` -> `true` (a dismissal hides forever) -> red.
test("playing a dismissed thing again brings it back", () => {
  const dismissed = withDismissed({}, { kind: "episode", id: "a" }, NOW - 60_000);
  const replayed = [{ kind: "episode", id: "a", at: new Date(NOW).toISOString() }];
  assert.deepEqual(ids(visibleJumpBackIn(replayed, { dismissed, now: NOW })), ["a"]);
  const notReplayed = [{ kind: "episode", id: "a", at: new Date(NOW - 120_000).toISOString() }];
  assert.deepEqual(ids(visibleJumpBackIn(notReplayed, { dismissed, now: NOW })), []);
});

// MUTATION: `at === null ||` removed from the dismissed test -> red.
test("dismissing an entry with no timestamp keeps it off", () => {
  const row = { kind: "foray", id: "undated", at: null };
  assert.deepEqual(visibleJumpBackIn([row], { dismissed: withDismissed({}, row, NOW), now: NOW }), []);
});

// MUTATION: jbiKey returns entry.id alone -> red (an episode and a playlist share an id).
test("kinds do not share dismissals", () => {
  assert.equal(jbiKey({ kind: "episode", id: "x" }), "episode:x");
  const dismissed = withDismissed({}, { kind: "episode", id: "x" }, NOW);
  const rows = [{ kind: "playlist", id: "x", at: daysAgo(1) }];
  assert.deepEqual(ids(visibleJumpBackIn(rows, { dismissed, now: NOW })), ["x"]);
});

// MUTATION: return `next` without the cap (or keep the oldest) -> red.
test("the dismissal record is capped, newest kept, and never mutated in place", () => {
  let record = {};
  for (let i = 0; i < JBI_DISMISS_MAX + 5; i++) record = withDismissed(record, { kind: "episode", id: `e${i}` }, NOW + i * 1000);
  assert.equal(Object.keys(record).length, JBI_DISMISS_MAX);
  assert.ok(record[`episode:e${JBI_DISMISS_MAX + 4}`]);
  assert.equal(record["episode:e0"], undefined);
  const before = { "episode:z": new Date(NOW).toISOString() };
  const snapshot = JSON.stringify(before);
  withDismissed(before, { kind: "episode", id: "y" }, NOW);
  assert.equal(JSON.stringify(before), snapshot);
});

// MUTATION: none needed; garbage in storage must not throw (lsGet can return anything).
test("a corrupt record is ignored, not thrown on", () => {
  const rows = [{ kind: "episode", id: "a", at: daysAgo(1) }];
  for (const dismissed of [null, "oops", 7, ["episode:a"]]) {
    assert.deepEqual(ids(visibleJumpBackIn(rows, { dismissed, now: NOW })), ["a"]);
  }
  assert.deepEqual(Object.keys(withDismissed("oops", rows[0], NOW)), ["episode:a"]);
});
