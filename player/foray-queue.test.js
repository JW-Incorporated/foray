/* Tests for the Foray -> queue builder (#111).

   Pure module, pure tests: no backend, no timers. Everything here is about
   which segments are allowed to become queue items and which are refused, so
   the assertions are mostly on `skipped` and its reasons — a segment dropped
   for the wrong reason is as bad as one played at the wrong place. */

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildForayQueue, forayRuntimeSec, itemRuntimeSec, narrationDuration,
  NARRATION_CHARS_PER_SEC, NARRATION_FALLBACK_SEC,
  DURATION_MEASURED, DURATION_ESTIMATED, DURATION_FALLBACK,
  SEGMENT, NARRATION, JINGLE, JINGLE_ASSET_URL, JINGLE_DURATION_SEC,
} from "./foray-queue.js";
import { AD_PAD_CEILING_SEC } from "./seek-policy.js";

/** 85 characters, which is 5.0 s at narration-craft.md §0's 17 chars/s — a
    Hinge, the commonest and shortest real narration item. Exact so that a test
    reading it as a duration is reading an arithmetic fact, not a rounding. */
const SCRIPT_5S = "x".repeat(5 * NARRATION_CHARS_PER_SEC);

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

test("a narration with neither asset nor script is dropped without stalling the rest of the Foray", () => {
  const { items, skipped } = build([{ type: NARRATION, id: "nar-1" }, seg()]);
  assert.equal(items.length, 1, "the segment still plays");
  assert.match(skipped[0].reason, /no asset or script/);
});

/* ---------- generation-architecture.md §7 item 1: script, no asset ---------- */

test("a script-only narration item is playable, not dropped — on-device narration's common case", () => {
  const { items, skipped } = build([
    { type: NARRATION, id: "nar-1", script: SCRIPT_5S },
    seg(),
  ]);
  assert.deepStrictEqual(skipped, []);
  assert.equal(items.length, 2, "both the narration and the segment resolve");
  assert.equal(items[0].kind, "tts");
  assert.equal(items[0].audio_url, null, "no file exists — the plugin speaks the script, nothing loads one");
  assert.equal(items[0].script, SCRIPT_5S);
});

test("an item with both script and asset still prefers asset (§1.2), even with a script present", () => {
  const { items } = build([
    { type: NARRATION, id: "nar-1", asset: "narration/fire-1.mp3", script: SCRIPT_5S },
    seg(),
  ]);
  assert.equal(items[0].audio_url, "narration/fire-1.mp3", "the pre-rendered asset wins, per §1.2");
  assert.equal(items[0].script, SCRIPT_5S, "the script still rides along — a bridge may carry both");
});

test("a script-only narration item's duration is estimated, exactly as before", () => {
  const { items } = build([{ type: NARRATION, id: "nar-1", script: SCRIPT_5S }, seg()]);
  assert.equal(items[0].duration_sec, 5);
  assert.equal(items[0].duration_source, DURATION_ESTIMATED);
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

test("a padded segment is still gated at load — the pad does not settle it", () => {
  // `needs_drift_check` must be true for PADDED as well as APPROXIMATE. Reading
  // "padded" as "settled" is how a 60s pad ends up waving a 28-minute drift
  // through to playback, which is the bad cut the ladder exists to refuse.
  const { items } = build([daiSeg({ ad_pad_sec: 100 })], { allowAdPad: true });
  assert.equal(items[0].needs_drift_check, true);
  assert.equal(items[0].ad_pad_sec, 100, "and the gate is given the pad to check against");
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

test("a duplicate authored id is replaced, not allowed to shadow another item", () => {
  // Every lookup in the manager takes the first match, so a duplicate makes one
  // entry unreachable and plays the other twice.
  const { items, warnings } = build([
    { type: NARRATION, id: "nar-1", asset: "a.mp3", script: SCRIPT_5S },
    { type: NARRATION, id: "nar-1", asset: "b.mp3", script: SCRIPT_5S },
    seg(),
  ]);
  assert.equal(new Set(items.map((i) => i.id)).size, 3);
  assert.equal(items[1].id, "foray-1#1");
  /* Joined rather than indexed: this assertion is about the duplicate, and
     pinning it to `warnings[0]` made it fail the day the builder gained an
     unrelated warning to emit first. */
  assert.match(warnings.join("\n"), /duplicate item id nar-1/);
});

test("runtime counts authored content, never the pad", () => {
  const { items } = build([daiSeg({ ad_pad_sec: 100 }), seg({ start_sec: 0, end_sec: 90 })], { allowAdPad: true });
  assert.equal(forayRuntimeSec(items), 110 + 90);
  assert.equal(forayRuntimeSec([]), 0);
  assert.equal(forayRuntimeSec(undefined), 0);
});

/* ---------- how long a narration item is ----------

   A narration item is not a slice of anything, so its length cannot be a
   subtraction and has to be carried. Until it was, it was zero: a Foray with
   narration reported a runtime short by all of it, and D1, `progressSegments`
   and every resume arithmetic downstream inherited the shortfall. These tests
   are about the three sources of the number and about the one answer that is
   never acceptable. */

test("a measured duration_sec beats an estimate from the script", () => {
  // Mutation that kills this: swap the `duration_sec` and `script` branches in
  // `narrationDuration` — a voiced line would then be timed from its text.
  const d = narrationDuration({ duration_sec: 41.5, script: SCRIPT_5S });
  assert.equal(d.sec, 41.5);
  assert.equal(d.source, DURATION_MEASURED);
});

test("with no duration, the script is timed at narration-craft's 17 chars/s", () => {
  // Mutation: `NARRATION_CHARS_PER_SEC = 16`, or return the fallback here.
  assert.equal(NARRATION_CHARS_PER_SEC, 17, "narration-craft.md §0's planning rate");
  const d = narrationDuration({ script: SCRIPT_5S });
  assert.equal(d.sec, 5);
  assert.equal(d.source, DURATION_ESTIMATED);
  // Whitespace is not a script. A record whose script is blank is the same
  // record as one with no script at all.
  assert.equal(narrationDuration({ script: "   \n " }).source, DURATION_FALLBACK);
});

test("a narration item with neither a duration nor a script is never worth 0 s", () => {
  /* THIS IS THE BUG, stated as an assertion. Mutation that kills it:
     `return { sec: 0, source: DURATION_FALLBACK }` — which is exactly the
     behaviour that shipped, and which no other test in this file could see. */
  const d = narrationDuration({ id: "nar-1" });
  assert.ok(d.sec > 0, "a listener sits through it, so it costs something");
  assert.equal(d.sec, NARRATION_FALLBACK_SEC);
  assert.equal(d.source, DURATION_FALLBACK);
  // And the same for the shapes a hand-edited document actually produces.
  for (const bad of [{}, { duration_sec: 0 }, { duration_sec: -4 }, { duration_sec: "8" }, { duration_sec: NaN }]) {
    assert.equal(narrationDuration(bad).sec, NARRATION_FALLBACK_SEC, JSON.stringify(bad));
  }
});

test("resolving twice cannot promote an estimate to a measurement", () => {
  /* The resolver runs in two places — `hydrateForayItems` and
     `buildForayQueue` — and the second sees the first's output. Mutation:
     delete the `nonEmpty(item.duration_source)` branch, so the second pass sees
     a `duration_sec` that is present and calls it measured. A projection would
     then launder itself into a fact by being passed along. */
  const once = narrationDuration({ script: SCRIPT_5S });
  const twice = narrationDuration({ script: SCRIPT_5S, duration_sec: once.sec, duration_source: once.source });
  assert.deepStrictEqual(twice, once);
  assert.equal(twice.source, DURATION_ESTIMATED);
});

test("the builder stamps the duration on the queue item, with its provenance", () => {
  // Mutation: drop `duration_sec` from the pushed narration item — the queue
  // would play a line the clock cannot see.
  const { items, warnings } = build([
    { type: NARRATION, id: "n-measured", asset: "a.mp3", duration_sec: 12 },
    { type: NARRATION, id: "n-scripted", asset: "b.mp3", script: SCRIPT_5S },
    { type: NARRATION, id: "n-bare", asset: "c.mp3" },
  ]);
  assert.deepStrictEqual(items.map((i) => i.duration_sec), [12, 5, NARRATION_FALLBACK_SEC]);
  assert.deepStrictEqual(
    items.map((i) => i.duration_source),
    [DURATION_MEASURED, DURATION_ESTIMATED, DURATION_FALLBACK]
  );
  // The guessed one says so. A silent guess is how the runtime got wrong.
  assert.match(warnings.join("\n"), /neither a duration_sec nor a script/);
});

test("forayRuntimeSec is the listener's clock, so narration is in it", () => {
  /* Mutation: delete the `duration_sec` branch of `itemRuntimeSec` and this
     drops back to 200 — the original defect, in one line. */
  const { items } = build([
    seg({ start_sec: 0, end_sec: 110 }),
    { type: NARRATION, id: "nar-1", asset: "a.mp3", duration_sec: 40 },
    seg({ start_sec: 200, end_sec: 290 }),
  ]);
  assert.equal(items.length, 3);
  assert.equal(forayRuntimeSec(items), 110 + 40 + 90);
  assert.notEqual(forayRuntimeSec(items), 110 + 90, "the bridge is not free");
});

test("itemRuntimeSec reads bounds before duration_sec, so a pad never becomes content", () => {
  /* A hydrated segment entry carries BOTH its bounds and a `duration_sec`
     display field, so the order of these two branches decides which one wins.
     Mutation: put the `duration_sec` branch first — a padded segment would then
     be measured by whichever of the two the join happened to write, and
     ADR-0008's "the pad is tolerance, not content" would stop holding. */
  assert.equal(itemRuntimeSec({ start_sec: 10, end_sec: 130, duration_sec: 999 }), 120);
  assert.equal(itemRuntimeSec({ start_sec: 10, end_sec: 200, authored_end_sec: 130 }), 120);
  assert.equal(itemRuntimeSec({ kind: "tts", duration_sec: 8 }), 8);
  // Nothing coherent to measure is 0, not NaN — this feeds a bar width.
  for (const junk of [null, undefined, {}, { start_sec: 10 }, { start_sec: 10, end_sec: 10 }]) {
    assert.equal(itemRuntimeSec(junk), 0, JSON.stringify(junk));
  }
  /* Reversed bounds fall THROUGH to `duration_sec` rather than returning a
     negative length. Unreachable via `buildForayQueue`, which drops
     `end_sec <= start_sec`, and unreachable via a hydrated entry, whose
     `duration_sec` comes from `spanOf` and is 0 on exactly these bounds — but
     pinned, because the old `forayRuntimeSec` required only `isNum(end)` and
     would have returned -5 here. A negative contribution to a runtime is never
     the answer; falling through to a stated duration at least is one. */
  assert.equal(itemRuntimeSec({ start_sec: 10, end_sec: 5, duration_sec: 999 }), 999);
  assert.equal(itemRuntimeSec({ start_sec: 10, end_sec: 5 }), 0);
});

test("an estimated duration is rounded to the millisecond", () => {
  /* 50 / 17 is 2.9411764705882355. These values are summed into the cumulative
     clock D1 compares against a 600.000 s window, and a start landing at
     599.9999999999999 rather than 600 changes a verdict — so the estimate is not
     allowed to carry precision it does not have.

     Mutation: drop `toMs` from the estimate branch. The first assertion fails,
     and `tools/foray/check-forays.mjs`'s 50-character Hinge boundary — which is
     rounded the same way so the two agree — becomes a float coin toss. */
  assert.equal(narrationDuration({ script: "x".repeat(50) }).sec, 2.941);
  assert.equal(narrationDuration({ script: "x".repeat(340) }).sec, 20);
  // A MEASURED duration is passed through untouched: it is a fact about a file,
  // not a projection, and rounding somebody's measurement is not ours to do.
  assert.equal(narrationDuration({ duration_sec: 2.9411764705882355 }).sec, 2.9411764705882355);
});

/* ---------- generation-architecture.md §7 item 4: the jingle ---------- */

test("a jingle item round-trips to a playable, non-spoken queue item", () => {
  const { items, skipped } = build([
    seg({ start_sec: 10, end_sec: 60 }),
    { type: JINGLE, id: "jingle-1" },
    seg({ start_sec: 900, end_sec: 1000 }),
  ]);
  assert.deepStrictEqual(skipped, [], "a jingle is never skipped — it is a fixed, always-valid asset");
  assert.equal(items.length, 3);
  const jingle = items[1];
  // It is its own kind, not a disguised narration item — see foray-queue.js's
  // note on why NARRATION+flag was rejected. The player must be able to tell
  // "jingle" from "narration" without inspecting anything else on the item.
  assert.equal(jingle.kind, JINGLE);
  assert.notEqual(jingle.kind, "tts", "a jingle must never route into the on-device TTS plugin");
  assert.equal(jingle.audio_url, JINGLE_ASSET_URL);
  assert.equal(jingle.duration_sec, JINGLE_DURATION_SEC);
  assert.equal(jingle.duration_source, DURATION_MEASURED, "the asset's length is a fact, not an estimate");
  // It contributes to the Foray's clock exactly like any other bounded-less
  // item with a duration_sec — the same arithmetic a narration bridge uses.
  assert.equal(itemRuntimeSec(jingle), JINGLE_DURATION_SEC);
});

test("a jingle needs no start_sec/end_sec — it is not a segment for seam purposes", () => {
  // player/seam-gap.js's isSegment() rejects anything without bounds, so a
  // jingle produces no seam beat on either side by construction — the
  // "bridge and gap are alternatives, never both" rule (§4.8) without any new
  // code in seam-gap.js itself.
  const { items } = build([{ type: JINGLE, id: "jingle-1" }]);
  assert.equal(items[0].start_sec, undefined);
  assert.equal(items[0].end_sec, undefined);
});
