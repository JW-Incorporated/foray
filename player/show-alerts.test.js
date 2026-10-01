/* New-episode alerts for followed shows — the rules (PQ-25, #761;
   docs/roadmap/player-features.md §3; README default Q20: alerts on when
   you follow, a per-show switch).

   WHAT IS PINNED. The rules are pure functions over the `cp_starred_shows`
   record (seeded here directly — app.js never runs in this suite) and the
   episode rows the show's API page returns. Each test names the one-line
   mutation in player/show-alerts.js that turns it red; run the mutation
   before trusting a green here (CLAUDE.md, "A green test is not evidence
   until you have broken it"). The page-side wiring — when a check runs, the
   "N new" badge, the show-page switch — is PQ-26's, in app.js tests, not
   here; the native refresh tasks (PQ-28/29) mirror these nine cases.

   THE SEED. A follow record exactly as `toggleShowStar` writes it today:
   four fields, none of the alert fields — so "default on" and "fresh follow
   seeds" test the record every existing follower already has. */

import test from "node:test";
import assert from "node:assert/strict";
import {
  CHECK_INTERVAL_MS,
  alertsOn,
  setAlerts,
  dueForCheck,
  newSince,
  afterCheck,
  markSeen,
  alertText
} from "./show-alerts.js";

const T0 = "2026-09-30T12:00:00.000Z";
const T0_MS = Date.parse(T0);

/** A follow as app.js writes it: no alert fields at all. */
function freshFollow() {
  return {
    show_id: "show-1",
    title: "The Show",
    artwork_url: null,
    starred_at: "2026-09-01T00:00:00.000Z"
  };
}

const row = (id, published_at, title = `Episode ${id}`) => ({ id, title, published_at });

test("alerts are on by default — a record with no `alerts` field, as every existing follow is (mutation: `record.alerts === false` -> `record.alerts === true` in alertsOn)", () => {
  assert.equal(alertsOn(freshFollow()), true);
  assert.equal(alertsOn({ ...freshFollow(), alerts: true }), true);
  // A missing or non-object record is still "on": the switch is the only way off.
  assert.equal(alertsOn(undefined), true);
  assert.equal(CHECK_INTERVAL_MS, 6 * 3600 * 1000);
});

test("the per-show switch turns alerts off and back on, and never mutates the record it was given (mutation: `alerts: Boolean(on)` -> `alerts: true` in setAlerts)", () => {
  const rec = freshFollow();
  const off = setAlerts(rec, false);
  assert.equal(alertsOn(off), false);
  assert.equal(off.alerts, false);
  assert.equal("alerts" in rec, false, "setAlerts returns a copy");
  const on = setAlerts(off, true);
  assert.equal(alertsOn(on), true);
  // The follow's own fields ride along untouched.
  assert.equal(on.show_id, "show-1");
  assert.equal(on.starred_at, rec.starred_at);
});

test("a check is due when never checked, and at exactly 6 h — not one millisecond before (mutation: `>= CHECK_INTERVAL_MS` -> `> CHECK_INTERVAL_MS` in dueForCheck)", () => {
  assert.equal(dueForCheck(freshFollow(), T0_MS), true, "never checked");
  const checked = { ...freshFollow(), checked_at: T0 };
  assert.equal(dueForCheck(checked, T0_MS + CHECK_INTERVAL_MS - 1), false, "one ms early");
  assert.equal(dueForCheck(checked, T0_MS + CHECK_INTERVAL_MS), true, "exactly on the interval");
  assert.equal(dueForCheck(checked, T0_MS + CHECK_INTERVAL_MS + 1), true, "past it");
  // An unparseable stamp is treated as never checked, never as "checked forever".
  assert.equal(dueForCheck({ ...freshFollow(), checked_at: "not a date" }, T0_MS), true);
  // An ISO `now` reads the same as its number.
  assert.equal(dueForCheck(checked, new Date(T0_MS + CHECK_INTERVAL_MS).toISOString()), true);
});

test("a missing `now` is the wall clock and an unreadable one means due — never \"not due\", which would silence a show's alerts for good (mutation: drop `if (!Number.isFinite(at)) return true;` in dueForCheck)", () => {
  const checked = { ...freshFollow(), checked_at: T0 };
  assert.equal(dueForCheck(checked, "garbage"), true, "unreadable now -> due");
  assert.equal(dueForCheck(checked, NaN), true, "NaN now -> due");
  const justNow = { ...freshFollow(), checked_at: new Date().toISOString() };
  assert.equal(dueForCheck(justNow), false, "no now -> wall clock, and a check a moment ago is not due");
  const longAgo = { ...freshFollow(), checked_at: "2020-01-01T00:00:00.000Z" };
  assert.equal(dueForCheck(longAgo), true, "no now -> wall clock, and an old check is due");
});

test("the latest and the watermark never move backwards — a page that lost a row does not make that row new again when it returns (mutation: `laterOf(latestOf(rows), base.latest_published_at)` -> `latestOf(rows) ?? base.latest_published_at ?? null` in afterCheck)", () => {
  const e1 = row("e1", "2026-09-10T00:00:00.000Z");
  const e2 = row("e2", "2026-09-29T00:00:00.000Z");
  let rec = afterCheck(freshFollow(), [e1], T0_MS); // watermark e1
  rec = afterCheck(rec, [e2, e1], T0_MS + CHECK_INTERVAL_MS); // e2 arrives: 1 new
  assert.equal(rec.unseen_count, 1);
  rec = markSeen(rec); // the listener saw e2
  assert.equal(rec.seen_published_at, e2.published_at);
  // The next page has lost e2 (unpublished, or a transient answer).
  rec = afterCheck(rec, [e1], T0_MS + 2 * CHECK_INTERVAL_MS);
  assert.equal(rec.latest_published_at, e2.published_at, "the latest does not follow a shrunk page down");
  assert.equal(rec.unseen_count, 0);
  rec = markSeen(rec);
  assert.equal(rec.seen_published_at, e2.published_at, "markSeen does not lower the watermark");
  // e2 comes back: it was seen, so it is not new.
  rec = afterCheck(rec, [e2, e1], T0_MS + 3 * CHECK_INTERVAL_MS);
  assert.equal(rec.unseen_count, 0, "a row already seen is never new again");
  assert.deepEqual(newSince([e2, e1], rec), []);
  // And markSeen on a record whose latest somehow trails its watermark keeps the watermark.
  const trailing = { ...freshFollow(), seen_published_at: e2.published_at, latest_published_at: e1.published_at, unseen_count: 1 };
  assert.equal(markSeen(trailing).seen_published_at, e2.published_at);
});

test("a fresh follow's first check seeds the watermark to the newest row and reports 0 new — following is not a backlog (mutation: `hadWatermark ? base.seen_published_at : latest ?? null` -> `base.seen_published_at ?? null` in afterCheck, i.e. drop the seed)", () => {
  const rows = [row("e3", "2026-09-29T00:00:00.000Z"), row("e2", "2026-09-20T00:00:00.000Z"), row("e1", "2026-09-10T00:00:00.000Z")];
  const after = afterCheck(freshFollow(), rows, T0_MS);
  assert.equal(after.checked_at, T0);
  assert.equal(after.latest_published_at, "2026-09-29T00:00:00.000Z");
  assert.equal(after.seen_published_at, "2026-09-29T00:00:00.000Z", "seeded to the latest");
  assert.equal(after.unseen_count, 0);
  // And with no watermark at all, nothing is "new" by the watermark rule either.
  assert.deepEqual(newSince(rows, freshFollow()), []);
  // The follow's own fields survive the check.
  assert.equal(after.title, "The Show");
  assert.equal(after.starred_at, freshFollow().starred_at);
});

test("a row published after the watermark is counted, and becomes the latest (mutation: `r.published_at > seen` -> `r.published_at < seen` in newSince)", () => {
  const seeded = afterCheck(freshFollow(), [row("e1", "2026-09-10T00:00:00.000Z")], T0_MS);
  const later = [row("e2", "2026-09-29T00:00:00.000Z"), row("e1", "2026-09-10T00:00:00.000Z")];
  assert.deepEqual(newSince(later, seeded).map((r) => r.id), ["e2"]);
  const after = afterCheck(seeded, later, T0_MS + CHECK_INTERVAL_MS);
  assert.equal(after.unseen_count, 1);
  assert.equal(after.latest_published_at, "2026-09-29T00:00:00.000Z");
  assert.equal(after.seen_published_at, "2026-09-10T00:00:00.000Z", "the watermark does not move on a check");
  assert.equal(after.checked_at, new Date(T0_MS + CHECK_INTERVAL_MS).toISOString());
});

test("a row published at exactly the watermark is not new (mutation: `>` -> `>=` in newSince)", () => {
  const seeded = { ...freshFollow(), seen_published_at: "2026-09-10T00:00:00.000Z", latest_published_at: "2026-09-10T00:00:00.000Z" };
  const same = [row("e1", "2026-09-10T00:00:00.000Z")];
  assert.deepEqual(newSince(same, seeded), []);
  assert.equal(afterCheck(seeded, same, T0_MS).unseen_count, 0);
});

test("markSeen zeroes the count and moves the watermark up to the latest (mutation: `seen_published_at: base.latest_published_at ?? ...` -> `base.seen_published_at` in markSeen)", () => {
  const seeded = afterCheck(freshFollow(), [row("e1", "2026-09-10T00:00:00.000Z")], T0_MS);
  const after = afterCheck(seeded, [row("e2", "2026-09-29T00:00:00.000Z"), row("e1", "2026-09-10T00:00:00.000Z")], T0_MS + CHECK_INTERVAL_MS);
  assert.equal(after.unseen_count, 1);
  const seen = markSeen(after);
  assert.equal(seen.unseen_count, 0);
  assert.equal(seen.seen_published_at, "2026-09-29T00:00:00.000Z");
  assert.equal(after.unseen_count, 1, "markSeen returns a copy");
  // A later check with the same rows now finds nothing new.
  assert.equal(afterCheck(seen, [row("e2", "2026-09-29T00:00:00.000Z")], T0_MS + 2 * CHECK_INTERVAL_MS).unseen_count, 0);
});

test("alertText is the show's title over the newest episode's title (mutation: swap `title` and `body` in alertText)", () => {
  const newest = row("e2", "2026-09-29T00:00:00.000Z", "The newest one");
  assert.deepEqual(alertText(freshFollow(), newest), { title: "The Show", body: "The newest one" });
  // Missing pieces print as empty strings, never "undefined".
  assert.deepEqual(alertText({}, {}), { title: "", body: "" });
});

test("a row without published_at is ignored — never new, never the latest (mutation: drop the `typeof r.published_at === \"string\"` filter in datedRows)", () => {
  const seeded = { ...freshFollow(), seen_published_at: "2026-09-10T00:00:00.000Z", latest_published_at: "2026-09-10T00:00:00.000Z" };
  const rows = [{ id: "x", title: "No date" }, row("y", "", "Empty date"), { id: "z", title: "Numeric", published_at: 1759190400000 }, row("e2", "2026-09-29T00:00:00.000Z")];
  assert.deepEqual(newSince(rows, seeded).map((r) => r.id), ["e2"]);
  const after = afterCheck(seeded, rows, T0_MS);
  assert.equal(after.unseen_count, 1);
  assert.equal(after.latest_published_at, "2026-09-29T00:00:00.000Z");
  // All undated: nothing new, and the latest stays what it was.
  const undated = afterCheck(seeded, [{ id: "x" }], T0_MS);
  assert.equal(undated.unseen_count, 0);
  assert.equal(undated.latest_published_at, "2026-09-10T00:00:00.000Z");
  // A fresh follow whose first page is all undated gets no watermark yet.
  assert.equal(afterCheck(freshFollow(), [{ id: "x" }], T0_MS).seen_published_at, null);
});
