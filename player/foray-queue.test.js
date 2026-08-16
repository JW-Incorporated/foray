/* Tests for the Foray -> queue builder (#111).

   Pure module, pure tests: no backend, no timers. Everything here is about
   which segments are allowed to become queue items and which are refused, so
   the assertions are mostly on `skipped` and its reasons — a segment dropped
   for the wrong reason is as bad as one played at the wrong place. */

import test from "node:test";
import assert from "node:assert/strict";
import { buildForayQueue, forayRuntimeSec, SEGMENT, NARRATION } from "./foray-queue.js";
import { AD_PAD_CEILING_SEC } from "./seek-policy.js";

const CATALOGUE = {
  "static-ep": {
    id: "static-ep", audio_url: "https://cdn.example/static.mp3",
    dai_suspected: false, duration_sec: 3600, title: "Static", show: "Indie Show",
  },
  "dai-ep": {
    id: "dai-ep", audio_url: "https://cdn.example/dai.mp3",
    dai_suspected: true, duration_sec: 2501, title: "Stitched", show: "Big Show",
  },
  "no-audio": { id: "no-audio", audio_url: null, dai_suspected: false, duration_sec: 100 },
};
const resolveItem = (id) => CATALOGUE[id] ?? null;

const seg = (extra = {}) => ({
  type: SEGMENT, item_id: "static-ep", start_sec: 100, end_sec: 210,
  why: "he explains it without hand-waving", ...extra,
});
const daiSeg = (extra = {}) => seg({
  item_id: "dai-ep",
  start_anchor: "so the thing about fire is",
  end_anchor: "and that is why it stuck",
  reference_duration_sec: 2501,
  ...extra,
});
const build = (items, opts = {}) =>
  buildForayQueue({ id: "foray-1", title: "Fire", items }, { resolveItem, ...opts });

/* ---------- the happy path ---------- */

test("an ordered list of slices becomes an ordered queue", () => {
  const { items, skipped } = build([
    seg({ start_sec: 10, end_sec: 120 }),
    seg({ item_id: "dai-ep", ...daiSeg() }),
    seg({ start_sec: 900, end_sec: 1000 }),
  ]);
  assert.deepStrictEqual(skipped, []);
  assert.equal(items.length, 3);
  assert.deepStrictEqual(items.map((i) => [i.start_sec, i.end_sec]), [[10, 120], [100, 210], [900, 1000]]);
});

test("a segment's queue id is its own, never the episode's", () => {
  // Two slices of one episode are two queue entries over one source. Keyed by
  // episode id, every id lookup in the manager would resolve both to the
  // first, and the Foray would loop on segment 1 forever.
  const { items } = build([seg({ start_sec: 10, end_sec: 60 }), seg({ start_sec: 90, end_sec: 140 })]);
  assert.equal(items[0].id, "foray-1#0");
  assert.equal(items[1].id, "foray-1#1");
  assert.notEqual(items[0].id, items[1].id);
  assert.equal(items[0].source_item_id, "static-ep");
  assert.equal(items[1].source_item_id, "static-ep");
});

test("narration lines ride the existing TTS kind rather than a new one", () => {
  const { items } = build([
    { type: NARRATION, id: "nar-1", asset: "narration/fire-1.mp3", script: "..." },
    seg(),
  ]);
  assert.equal(items[0].kind, "tts");
  assert.equal(items[0].audio_url, "narration/fire-1.mp3");
  assert.equal(items[1].kind, "episode");
});

test("a segment carries what the load-time ladder will need", () => {
  const { items } = build([daiSeg()]);
  assert.equal(items[0].dai_suspected, true);
  assert.equal(items[0].reference_duration_sec, 2501);
  assert.equal(items[0].needs_drift_check, true, "a DAI segment is on probation until the audio is in hand");
});

test("a non-DAI segment is settled at build time and never re-gated", () => {
  const { items } = build([seg()]);
  assert.equal(items[0].needs_drift_check, false);
});

/* ---------- structural refusals ---------- */

test("a segment with no out-point is refused — that is an episode, not a segment", () => {
  const { items, skipped } = build([seg({ end_sec: undefined })]);
  assert.equal(items.length, 0);
  assert.match(skipped[0].reason, /end_sec is missing/);
});

test("end_sec at or before start_sec is refused", () => {
  for (const end of [100, 99, 0, -5]) {
    const { skipped } = build([seg({ start_sec: 100, end_sec: end })]);
    assert.equal(skipped.length, 1, `end_sec ${end}`);
    assert.match(skipped[0].reason, /not after start_sec|end_sec is missing/);
  }
});

test("a missing or negative start_sec is refused", () => {
  assert.match(build([seg({ start_sec: undefined })]).skipped[0].reason, /start_sec/);
  assert.match(build([seg({ start_sec: -1 })]).skipped[0].reason, /start_sec/);
});

test("an unresolvable item_id is refused by name, not by silence", () => {
  const { skipped } = build([seg({ item_id: "ghost" })]);
  assert.match(skipped[0].reason, /ghost does not resolve/);
  assert.equal(skipped[0].index, 0);
});

test("an episode with no audio_url is refused", () => {
  assert.match(build([seg({ item_id: "no-audio" })]).skipped[0].reason, /no audio_url/);
});

test("an unknown item type is refused rather than guessed at", () => {
  assert.match(build([{ type: "chapter", item_id: "static-ep" }]).skipped[0].reason, /unknown item type/);
  assert.match(build([null]).skipped[0].reason, /not an object/);
});

test("a narration with no asset is dropped without stalling the rest of the Foray", () => {
  const { items, skipped } = build([{ type: NARRATION, id: "nar-1" }, seg()]);
  assert.equal(items.length, 1, "the segment still plays");
  assert.match(skipped[0].reason, /no asset/);
});

test("an empty or malformed Foray yields an empty queue rather than throwing", () => {
  assert.deepStrictEqual(buildForayQueue(null, { resolveItem }).items, []);
  assert.deepStrictEqual(buildForayQueue({ id: "x" }, { resolveItem }).items, []);
  assert.equal(buildForayQueue({ id: "x", items: [] }, {}).id, "x");
});

/* ---------- ADR-0007's anchor rule ---------- */

test("a DAI source without both anchors is refused (ADR-0007)", () => {
  for (const missing of [
    { start_anchor: "", end_anchor: "x" },
    { start_anchor: "x", end_anchor: "  " },
    { start_anchor: undefined, end_anchor: undefined },
  ]) {
    const { items, skipped } = build([daiSeg(missing)]);
    assert.equal(items.length, 0);
    assert.match(skipped[0].reason, /DAI source without both anchors/);
  }
});

test("a DAI source WITH both anchors is admitted — #65's flat ban is relaxed", () => {
  const { items, skipped } = build([daiSeg()]);
  assert.deepStrictEqual(skipped, []);
  assert.equal(items.length, 1);
});

test("a non-DAI segment needs no anchors, though it should carry them anyway", () => {
  const { items } = build([seg({ start_anchor: undefined, end_anchor: undefined })]);
  assert.equal(items.length, 1);
});

test("a DAI segment with no reference_duration_sec is refused, naming both dead rungs", () => {
  // Without it the duration rung cannot be evaluated at all, and the rung that
  // would rescue it — anchor resolution — is not implemented.
  const { items, skipped } = build([daiSeg({ reference_duration_sec: undefined })]);
  assert.equal(items.length, 0);
  assert.match(skipped[0].reason, /reference_duration_sec/);
  assert.match(skipped[0].reason, /not implemented/);
});

/* ---------- the duration warning (end_sec past the real audio) ---------- */

test("an out-point past the declared duration warns but still plays", () => {
  // The declared duration describes the AD-FREE program (ADR-0008), so this is
  // usually the metadata being wrong rather than the segment. The file's own
  // end takes over at runtime.
  const { items, skipped, warnings } = build([seg({ start_sec: 3500, end_sec: 4000 })]);
  assert.equal(skipped.length, 0);
  assert.equal(items.length, 1);
  assert.match(warnings[0], /past the declared duration/);
});

/* ---------- ADR-0008's pad ---------- */

test("the pad is off by default, so a recorded pad changes nothing", () => {
  // ADR-0008 open question 2 ("does the playback pad ship before the locate
  // step?") is addressed to Wyatt and unanswered. Off is the ADR's position.
  const { items, warnings } = build([daiSeg({ ad_pad_sec: 100 })]);
  assert.equal(items[0].end_sec, 210, "the authored out-point is untouched");
  assert.equal(items[0].ad_pad_applied_sec, 0);
  assert.deepStrictEqual(warnings, []);
});

test("with the pad enabled, it extends the STOP and only the stop", () => {
  // The geometry from ADR-0008: content authored at t sits at t + cum(t) in the
  // listener's file, so the seek is already early by cum(t) and no pad recovers
  // that. Padding the start would land us earlier still.
  const { items } = build([daiSeg({ ad_pad_sec: 100 })], { allowAdPad: true });
  assert.equal(items[0].start_sec, 100, "the in-point must not move");
  assert.equal(items[0].end_sec, 310, "110s segment + 100s pad");
  assert.equal(items[0].authored_end_sec, 210);
  assert.equal(items[0].ad_pad_applied_sec, 100);
});

test("a pad over the 120s ceiling is LOCATE-REQUIRED, not a bigger pad", () => {
  const { items, skipped } = build([daiSeg({ ad_pad_sec: AD_PAD_CEILING_SEC + 1 })], { allowAdPad: true });
  assert.equal(items.length, 0);
  assert.match(skipped[0].reason, /LOCATE-REQUIRED/);
  assert.match(skipped[0].reason, /121s pad exceeds the 120s ceiling/);
});

test("a pad exactly at the ceiling is admitted — the test is <=, per ADR-0008", () => {
  const { items } = build([daiSeg({ ad_pad_sec: AD_PAD_CEILING_SEC })], { allowAdPad: true });
  assert.equal(items.length, 1);
  assert.equal(items[0].ad_pad_applied_sec, AD_PAD_CEILING_SEC);
});

test("a padded segment says out loud what the listener will hear", () => {
  const { warnings } = build([daiSeg({ ad_pad_sec: 100 })], { allowAdPad: true });
  assert.match(warnings[0], /extended by a 100s ad pad/);
  assert.match(warnings[0], /extra tail/);
});

test("a pad on a non-DAI show is ignored — there is no ad load to cover", () => {
  const { items } = build([seg({ ad_pad_sec: 100 })], { allowAdPad: true });
  assert.equal(items[0].end_sec, 210);
  assert.equal(items[0].ad_pad_applied_sec, 0);
});

/* ---------- the download path (#29) ---------- */

test("a downloaded copy freezes the timeline, so a DAI segment needs no probation", () => {
  const { items } = build([daiSeg()], { isLocalFile: true });
  assert.equal(items[0].needs_drift_check, false);
});

/* ---------- reporting ---------- */

test("skipped segments keep their position and their source, for a UI to explain", () => {
  const { items, skipped } = build([seg(), daiSeg({ start_anchor: "" }), seg({ start_sec: 500, end_sec: 600 })]);
  assert.equal(items.length, 2);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].index, 1);
  assert.equal(skipped[0].item_id, "dai-ep");
});

test("runtime counts authored content, never the pad", () => {
  const { items } = build([daiSeg({ ad_pad_sec: 100 }), seg({ start_sec: 0, end_sec: 90 })], { allowAdPad: true });
  assert.equal(forayRuntimeSec(items), 110 + 90);
  assert.equal(forayRuntimeSec([]), 0);
  assert.equal(forayRuntimeSec(undefined), 0);
});
