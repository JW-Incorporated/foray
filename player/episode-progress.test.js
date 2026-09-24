/* The pointer to the ordinary episode that was last playing.
 *
 * FOUNDER, 2026-09-18: "When I come back to 4a after a day, the podcast I was
 * listening to should still be in the now playing ribbon at the bottom."
 *
 * WHAT THIS SUITE IS GUARDING AGAINST, beyond the happy path: the temptation to
 * make this module store a POSITION. It must not. `position-store.js` has owned
 * that since #26 (`cp_pos:<id>`, durable, with its own resume rules), and a
 * second opinion on where the listener got to is the shape of bug that ends
 * with the bar and the home card disagreeing on screen. Two tests below exist
 * only to pin that separation.
 *
 * Every test names the one-line mutation that turns it red (CLAUDE.md).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  KEY, MAX_AGE_H,
  episodeSnapshot, makeLastEpisode,
  writeLastEpisode, readLastEpisode, lastEpisodeState,
  episodePercentDone, episodeRemainingLabel, episodeProgress,
} from "./episode-progress.js";
import { PositionStore, NEAR_END_SEC, MIN_RESUME_SEC } from "./position-store.js";

/** A Storage-shaped fake that can also be made to fail, because a refused write
    is a path this module has an opinion about. */
function fakeStorage({ failWrites = false } = {}) {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { if (failWrites) return false; map.set(k, v); return true; },
    removeItem: (k) => { map.delete(k); },
  };
}

const EPISODE = {
  id: "lex-353",
  title: "Dennis Whyte: Nuclear Fusion",
  show: "Lex Fridman Podcast",
  artwork_url: "https://example.com/a.jpg",
  audio_url: "https://example.com/a.mp3",
  duration_sec: 7200,
  /* Fields a real row carries that must NOT ride along — see the snapshot test. */
  topics: ["fusion", "energy"],
  hook: "a curated one-liner",
  score: 0.91,
};

/* ---------- the snapshot is a closed list ------------------------------- */

test("the snapshot keeps what the bar needs and drops what it does not", () => {
  /* The record is rewritten every time something starts playing. Carrying the
     whole item would drag topics, scores and provenance into storage for no
     reader. MUTATION: spread `...item` instead of walking SNAPSHOT_FIELDS. */
  const snap = episodeSnapshot(EPISODE);
  assert.deepEqual(Object.keys(snap).sort(), ["artwork_url", "audio_url", "duration_sec", "id", "show", "title"]);
  assert.equal(snap.topics, undefined);
  assert.equal(snap.score, undefined);
});

test("audio_url is kept, because a bar that cannot play is the old bug", () => {
  /* `bannerHtml`'s own comment records what a partial snapshot costs: a live
     episode with a play button that does nothing. MUTATION: drop "audio_url"
     from SNAPSHOT_FIELDS. */
  assert.equal(episodeSnapshot(EPISODE).audio_url, "https://example.com/a.mp3");
});

test("a missing field is omitted rather than stored as null", () => {
  const snap = episodeSnapshot({ id: "x", title: "T" });
  assert.deepEqual(Object.keys(snap).sort(), ["id", "title"]);
});

/* ---------- make / write / read ----------------------------------------- */

test("makeLastEpisode stamps the time and refuses an item with no id", () => {
  const rec = makeLastEpisode(EPISODE, { now: Date.parse("2026-09-18T10:00:00Z") });
  assert.equal(rec.id, "lex-353");
  assert.equal(rec.updated_at, "2026-09-18T10:00:00.000Z");
  assert.equal(makeLastEpisode(null), null);
  assert.equal(makeLastEpisode({ title: "no id" }), null);
});

test("a record round-trips through storage", () => {
  const s = fakeStorage();
  assert.equal(writeLastEpisode(s, makeLastEpisode(EPISODE)), true);
  assert.equal(readLastEpisode(s).id, "lex-353");
  assert.equal(readLastEpisode(s).title, EPISODE.title);
});

test("writing null clears the row", () => {
  const s = fakeStorage();
  writeLastEpisode(s, makeLastEpisode(EPISODE));
  writeLastEpisode(s, null);
  assert.equal(readLastEpisode(s), null);
  assert.equal(s.map.has(KEY), false);
});

test("a refused write reports false rather than pretending", () => {
  /* The caller cannot act on it, but a function that reports it can be tested —
     `lsSet`'s contract, and the reason `PositionStore` counts refusedWrites.
     MUTATION: `return true` unconditionally from writeLastEpisode. */
  assert.equal(writeLastEpisode(fakeStorage({ failWrites: true }), makeLastEpisode(EPISODE)), false);
});

test("a corrupt or empty row reads as nothing, never as a throw", () => {
  /* Losing the ribbon beats a boot that dies on a JSON parse.
     MUTATION: drop the try/catch in readLastEpisode. */
  const s = fakeStorage();
  s.map.set(KEY, "{not json");
  assert.equal(readLastEpisode(s), null);
  s.map.set(KEY, JSON.stringify({ title: "no id here" }));
  assert.equal(readLastEpisode(s), null);
  assert.equal(readLastEpisode(null), null);
});

/* ---------- the verdict -------------------------------------------------- */

test("a fresh record resumes at the position the CALLER supplies", () => {
  /* The position comes from PositionStore, never from here. MUTATION: read
     `record.position_sec` instead of the argument — every case below still
     passes except this one, because the record has no such field at all. */
  const rec = makeLastEpisode(EPISODE);
  assert.deepEqual(lastEpisodeState(rec, { positionSec: 1200 }), { state: "resume", positionSec: 1200 });
});

test("this module stores no position of its own", () => {
  /* The separation, pinned. `cp_pos:` owns positions; two definitions of "where
     the listener got to" is how the bar and the home card come apart.
     MUTATION: add `position_sec` to SNAPSHOT_FIELDS or to makeLastEpisode. */
  const rec = makeLastEpisode({ ...EPISODE, position_sec: 999, seconds: 999 });
  assert.equal(rec.position_sec, undefined);
  assert.equal(rec.seconds, undefined);
});

test("a record older than the age limit is not offered", () => {
  const now = Date.parse("2026-09-18T10:00:00Z");
  const old = makeLastEpisode(EPISODE, { now: now - (MAX_AGE_H + 1) * 3.6e6 });
  assert.equal(lastEpisodeState(old, { positionSec: 60, now }).state, "none");
  const justInside = makeLastEpisode(EPISODE, { now: now - (MAX_AGE_H - 1) * 3.6e6 });
  assert.equal(lastEpisodeState(justInside, { positionSec: 60, now }).state, "resume");
});

test("a day old is comfortably inside the limit — the founder's own case", () => {
  /* The headline of the report is "after a day". The retired `cp_lastpick` card
     used 72 hours, which is uncomfortably close to it.
     MUTATION: set MAX_AGE_H to 24 and this still passes; set it to 12 and it
     goes red, which is the number worth guarding against. */
  const now = Date.parse("2026-09-18T10:00:00Z");
  const yesterday = makeLastEpisode(EPISODE, { now: now - 25 * 3.6e6 });
  assert.equal(lastEpisodeState(yesterday, { positionSec: 60, now }).state, "resume");
});

test("a finished episode is STILL offered, at zero", () => {
  /* Deliberately unlike the Foray rule. `resumeOffset` already collapses
     "finished" to 0, and an episode you finished is still the podcast you were
     listening to — dropping it from the bar would be the founder's complaint
     again on the day he finishes something.
     MUTATION: add a `finished` branch returning `{ state: "none" }`. */
  const rec = makeLastEpisode(EPISODE);
  assert.deepEqual(lastEpisodeState(rec, { positionSec: 0 }), { state: "resume", positionSec: 0 });
});

test("nothing stored, or an unparseable timestamp, is `none`", () => {
  assert.equal(lastEpisodeState(null).state, "none");
  assert.equal(lastEpisodeState({ id: "x" }).state, "none");
  assert.equal(lastEpisodeState({ id: "x", updated_at: "not a date" }).state, "none");
});

/* ---------- the two labels ---------------------------------------------- */

test("percent and remaining agree, and both come from the caller's position", () => {
  const rec = makeLastEpisode(EPISODE); // 7200 s
  assert.equal(episodePercentDone(rec, 1800), 0.25);
  /* Past the hour it rolls over (audit round 2, copy-2): the row beside it
     says "2 hr", so this says "1 hr 30 min left", never "90 min left". */
  assert.equal(episodeRemainingLabel(rec, 1800), "1 hr 30 min left");
  assert.equal(episodeRemainingLabel(rec, 4200), "50 min left");
});

test("an unknown duration produces no numbers rather than wrong ones", () => {
  /* MUTATION: default the duration to 0 or to some constant — both of these
     start returning a confident, meaningless answer. */
  const rec = makeLastEpisode({ id: "x", title: "T" });
  assert.equal(episodePercentDone(rec, 60), null);
  assert.equal(episodeRemainingLabel(rec, 60), null);
});

test("duration_min is accepted where duration_sec is absent", () => {
  /* Episode rows carry one or the other depending on which endpoint built them. */
  const rec = makeLastEpisode({ id: "x", title: "T", duration_min: 60 });
  assert.equal(episodePercentDone(rec, 900), 0.25);
});

test("percent is clamped to 0..1", () => {
  const rec = makeLastEpisode(EPISODE);
  assert.equal(episodePercentDone(rec, -5), 0);
  assert.equal(episodePercentDone(rec, 999999), 1);
});

test("a position at or past the end reads as finished, not as negative time", () => {
  const rec = makeLastEpisode(EPISODE);
  assert.equal(episodeRemainingLabel(rec, 7200), "finished");
  assert.equal(episodeRemainingLabel(rec, 999999), "finished");
});

/* ---------- episodeProgress: ONE reading of a position (audit 2026-09-22) --- */

test("a finished episode reads 'Played' with a full bar — never its whole runtime left", () => {
  /* The Jump-back-in card fed `resumeOffset` (which collapses "finished" to 0)
     into its bar and label, and told the listener a three-hour episode they had
     just finished had "180 min left". The raw stored position is what a card
     must read, and near the end it is "Played".
     MUTATION: delete the `played` branch. The label becomes "0 min left"-shaped
     ("finished") at 100% and this goes red. */
  const rec = { duration_sec: 3 * 3600 };
  const near = 3 * 3600 - 5;
  assert.deepEqual(episodeProgress(rec, near), { state: "played", percent: 100, label: "Played" });
  /* The contrast that is the bug: the resume offset for the same stored row is
     0, and the card must not be built from it. */
  const store = new PositionStore({ storage: { getItem: () => JSON.stringify({ seconds: near, duration: 3 * 3600 }), setItem() {}, removeItem() {} } });
  assert.equal(store.resumeOffset("x"), 0, "fixture: play would start over");
  assert.equal(episodeProgress(rec, store.load("x").seconds).state, "played");
});

test("episodeProgress uses position-store's own thresholds, so 'finished' means one thing", () => {
  /* MUTATION: restate a private 60-second near-end here. The first assertion
     goes red where the resume and the card would now disagree. */
  const rec = { duration_sec: 3600 };
  assert.equal(episodeProgress(rec, 3600 - NEAR_END_SEC + 1).state, "played");
  assert.equal(episodeProgress(rec, 3600 - NEAR_END_SEC - 1).state, "in-progress");
  assert.equal(episodeProgress(rec, MIN_RESUME_SEC - 1).state, "sampled", "opened, not listened to");
  assert.equal(episodeProgress(rec, MIN_RESUME_SEC - 1).label, null, "a sample earns no label");
});

test("in progress: percent and 'NN min left' from the same position; unknown duration gives neither", () => {
  assert.deepEqual(episodeProgress({ duration_sec: 3600 }, 900), { state: "in-progress", percent: 25, label: "45 min left" });
  assert.deepEqual(episodeProgress({ duration_min: 60 }, 900), { state: "in-progress", percent: 25, label: "45 min left" });
  assert.deepEqual(episodeProgress({}, 900), { state: "in-progress", percent: null, label: null });
});

test("nothing stored is unplayed", () => {
  for (const p of [null, undefined, 0, -3, NaN]) {
    assert.deepEqual(episodeProgress({ duration_sec: 3600 }, p), { state: "unplayed", percent: null, label: null }, String(p));
  }
});
