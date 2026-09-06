/* Tests for the forays.json + segments.json + segment-sources.json join
   (issues #128, #133, #111).

   Everything here is pure: fixtures in, plain objects out. The three-document
   join, the draft rule and the position mapping are the parts a surface must
   not improvise, so they are tested away from any DOM.

   The end-to-end proof that Foray #1 actually plays lives in
   player/foray-playback.test.js, against a fake backend and the real data. */

import test from "node:test";
import assert from "node:assert/strict";
import {
  PUBLISHED, indexSegments, indexSources, allForays, forayVisibility,
  listableForays, findForay, hydrateForayItems, resolveForay, groupBySlot,
  segmentStarts, segmentAtElapsed, forayElapsed, fmtClock, fmtSpan, progressSegments,
} from "./foray-resolve.js";
/* The resume half of #40. Imported here rather than tested in
   foray-progress.test.js because `progressSegments` is the adapter between the
   two modules, and a narration bridge is exactly the case where the adapter's
   arithmetic is the thing under test. */
import { makeProgress, resumePoint, DRIFT_EXACT } from "./foray-progress.js";

/* ---------- fixtures ---------- */

const seg = (id, extra = {}) => ({
  id, item_id: "ep-a", start_sec: 100, end_sec: 200,
  reference_duration_sec: 3600, why: "why line", topic: "food/grilling-bbq",
  confidence: "high", ...extra,
});

const src = (id, extra = {}) => ({
  id, show: "A Show", title: "An Episode", audio_url: `https://cdn.test/${id}.mp3`,
  duration_sec: 3600, dai_suspected: false, ...extra,
});

const item = (segment_id, extra = {}) => ({
  type: "segment", slot: "one", label: "L1", role: "explanation", segment_id, ...extra,
});

/** A narration bridge, in the shape `data/forays.json` would carry one. It
    needs an asset or the builder drops it, and a duration or the clock cannot
    see it (`narrationDuration`). */
const bridge = (id, extra = {}) => ({
  type: "narration", id, asset: `https://cdn.test/${id}.mp3`, duration_sec: 40, ...extra,
});

function fixture({ items, slots, status = "draft", segments, sources } = {}) {
  const foray = {
    id: "f1", kind: "deep-dive", title: "A Foray", status,
    slots: slots ?? [{ id: "one", title: "Slot one" }],
    items: items ?? [item("s1"), item("s2")],
  };
  return {
    foray,
    segments: indexSegments({ segments: segments ?? [seg("s1"), seg("s2", { start_sec: 300, end_sec: 360 })] }),
    sources: indexSources({ sources: sources ?? [src("ep-a")] }),
  };
}

const resolved = (over = {}) => {
  const f = fixture(over);
  return resolveForay(f.foray, { segments: f.segments, sources: f.sources });
};

/* ---------- indexing, and surviving a missing document ---------- */

test("indexSegments keys the array by segment id", () => {
  const idx = indexSegments({ segments: [seg("a"), seg("b")] });
  assert.equal(idx.size, 2);
  assert.equal(idx.get("b").id, "b");
});

test("indexSources keys the array by episode id", () => {
  assert.equal(indexSources({ sources: [src("ep-a")] }).get("ep-a").show, "A Show");
});

test("a 404 is an empty index, not a throw — the site must survive one missing file", () => {
  for (const doc of [null, undefined, {}, { segments: null }, "not json"]) {
    assert.equal(indexSegments(doc).size, 0);
    assert.equal(indexSources(doc).size, 0);
  }
});

test("rows with no id are skipped rather than indexed under undefined", () => {
  const idx = indexSegments({ segments: [seg("a"), { start_sec: 1 }, null, { id: "   " }] });
  assert.deepEqual([...idx.keys()], ["a"]);
});

test("allForays tolerates a document with no forays array", () => {
  assert.deepEqual(allForays(null), []);
  assert.deepEqual(allForays({ forays: "nope" }), []);
  assert.equal(allForays({ forays: [{ id: "f1" }, null] }).length, 1);
});

/* ---------- the draft rule (HUMAN-ACTIONS.md #2) ---------- */

test("a published Foray is visible to everyone", () => {
  const v = forayVisibility({ id: "f1", status: PUBLISHED });
  assert.equal(v.visible, true);
  assert.equal(v.published, true);
});

test("a draft is not visible to a visitor who did not ask for it", () => {
  const v = forayVisibility({ id: "f1", status: "draft" });
  assert.equal(v.visible, false);
  assert.equal(v.published, false);
  assert.match(v.reason, /not published/);
});

test("a draft IS visible to someone who named it — that is the founder's way in", () => {
  const v = forayVisibility({ id: "f1", status: "draft" }, { unlocked: ["f1"] });
  assert.equal(v.visible, true);
  assert.equal(v.published, false, "opening it by id must not make it published");
  assert.match(v.reason, /opened by id/);
});

test("naming a DIFFERENT id does not unlock this draft", () => {
  assert.equal(forayVisibility({ id: "f1", status: "draft" }, { unlocked: ["f2"] }).visible, false);
});

test("an unknown or missing status is treated as unpublished, never as published", () => {
  for (const status of [undefined, null, "", "review", "PUBLISHED", 1]) {
    assert.equal(forayVisibility({ id: "f1", status }).visible, false, `status ${String(status)}`);
  }
});

test("listableForays hides drafts and keeps the unlocked one", () => {
  const doc = { forays: [
    { id: "a", status: PUBLISHED }, { id: "b", status: "draft" }, { id: "c", status: "draft" },
  ] };
  assert.deepEqual(listableForays(doc).map((f) => f.id), ["a"]);
  assert.deepEqual(listableForays(doc, { unlocked: ["c"] }).map((f) => f.id), ["a", "c"]);
});

test("findForay returns null for a hidden draft and for an unknown id alike", () => {
  const doc = { forays: [{ id: "a", status: "draft" }] };
  assert.equal(findForay(doc, "a"), null, "hidden draft");
  assert.equal(findForay(doc, "nope", { unlocked: ["nope"] }), null, "unknown id");
  assert.equal(findForay(doc, "", { unlocked: [""] }), null, "empty id");
  assert.equal(findForay(doc, "a", { unlocked: ["a"] }).id, "a");
});

/* ---------- the join ---------- */

test("hydrate fills timestamps from segments and the show from sources", () => {
  const f = fixture();
  const { items, dropped } = hydrateForayItems(f.foray, { segments: f.segments, sources: f.sources });
  assert.equal(dropped.length, 0);
  assert.equal(items.length, 2);
  assert.equal(items[0].start_sec, 100);
  assert.equal(items[0].end_sec, 200);
  assert.equal(items[0].item_id, "ep-a");
  assert.equal(items[0].show, "A Show");
  assert.equal(items[0].duration_sec, 100);
  assert.equal(items[0].why, "why line");
});

test("hydrate keeps the authored slot and label for the running order", () => {
  const f = fixture({ items: [item("s1", { slot: "two", label: "ORI-7" })] });
  const { items } = hydrateForayItems(f.foray, { segments: f.segments, sources: f.sources });
  assert.equal(items[0].slot, "two");
  assert.equal(items[0].label, "ORI-7");
});

test("a missing SEGMENT drops one item and names it, and the rest still resolve", () => {
  const r = resolved({ items: [item("s1"), item("gone"), item("s2")] });
  assert.equal(r.playable.length, 2);
  assert.equal(r.unplayable.length, 1);
  assert.match(r.unplayable[0].reason, /data\/segments\.json/);
  assert.equal(r.unplayable[0].segment_id, "gone");
});

test("a missing SOURCE drops one item and names the episode, not the segment", () => {
  const r = resolved({ segments: [seg("s1"), seg("s2", { item_id: "ep-missing" })] });
  assert.equal(r.playable.length, 1);
  assert.equal(r.unplayable.length, 1);
  assert.match(r.unplayable[0].reason, /segment-sources\.json/);
  assert.match(r.unplayable[0].reason, /ep-missing/);
});

test("every data file missing at once yields nothing playable, not an exception", () => {
  const f = fixture();
  const r = resolveForay(f.foray, { segments: indexSegments(null), sources: indexSources(null) });
  assert.equal(r.playable.length, 0);
  assert.equal(r.unplayable.length, 2);
  assert.equal(r.totalSec, 0);
});

test("a non-object item is dropped rather than crashing the join", () => {
  const r = resolved({ items: [item("s1"), null, "nope"] });
  assert.equal(r.playable.length, 1);
  assert.equal(r.unplayable.length, 2);
});

test("a segment whose end is not after its start is refused by the builder, not queued", () => {
  const r = resolved({ segments: [seg("s1"), seg("s2", { start_sec: 400, end_sec: 400 })] });
  assert.equal(r.playable.length, 1);
  assert.match(r.unplayable[0].reason, /end_sec/);
});

test("a source with no audio_url is refused, and the entry says so", () => {
  const r = resolved({ sources: [src("ep-a", { audio_url: "" })] });
  assert.equal(r.playable.length, 0);
  assert.match(r.unplayable[0].reason, /audio_url/);
});

/* ---------- resolve: the pairing back up ---------- */

test("every authored item gets an entry, playable or not, in authored order", () => {
  const r = resolved({ items: [item("s1"), item("gone"), item("s2")] });
  assert.deepEqual(r.entries.map((e) => e.position), [0, 2]);
  assert.deepEqual(r.entries.map((e) => e.playable), [true, true]);
  assert.deepEqual(r.entries.map((e) => e.queueIndex), [0, 1]);
});

test("queueIndex is the index into the queue that actually plays, not the authored one", () => {
  // The first authored item fails, so authored item 2 is queue item 0. Getting
  // this wrong highlights the wrong row for the whole Foray.
  const r = resolved({ items: [item("gone"), item("s1"), item("s2")] });
  assert.deepEqual(r.entries.map((e) => e.queueIndex), [0, 1]);
  assert.equal(r.playable[0].start_sec, 100);
});

test("entries carry the resolved audio url, so a surface never re-joins by hand", () => {
  const r = resolved();
  assert.equal(r.entries[0].audio_url, "https://cdn.test/ep-a.mp3");
});

test("totalSec is what will actually play; authoredSec is what was written", () => {
  const r = resolved({ items: [item("s1"), item("gone"), item("s2")] });
  assert.equal(r.totalSec, 160); // 100 + 60
  assert.equal(r.authoredSec, 160);
  assert.equal(r.shows.length, 1);
});

test("two segments of the same episode stay two distinct queue items", () => {
  // The Foray does this repeatedly. Keyed by episode they would collapse.
  const r = resolved({ items: [item("s1"), item("s2")] });
  assert.equal(r.playable.length, 2);
  assert.notEqual(r.playable[0].id, r.playable[1].id);
  assert.equal(r.playable[0].source_item_id, r.playable[1].source_item_id);
});

/* ---------- slots ---------- */

test("entries group into the authored slots, in authored order", () => {
  const r = resolved({
    slots: [{ id: "one", title: "First" }, { id: "two", title: "Second" }],
    items: [item("s1", { slot: "two" }), item("s2", { slot: "one" })],
  });
  assert.deepEqual(r.slots.map((s) => s.id), ["one", "two"]);
  assert.deepEqual(r.slots.map((s) => s.entries.length), [1, 1]);
  assert.equal(r.slots[0].title, "First");
});

test("a declared slot with no surviving entry is kept empty rather than hidden", () => {
  const r = resolved({
    slots: [{ id: "one", title: "First" }, { id: "empty", title: "Nothing left" }],
  });
  assert.equal(r.slots.length, 2);
  assert.deepEqual(r.slots[1].entries, []);
});

test("an entry in an undeclared slot still gets a section rather than vanishing", () => {
  const groups = groupBySlot({ slots: [{ id: "one", title: "First" }] }, [
    { slot: "one" }, { slot: "surprise" },
  ]);
  assert.deepEqual(groups.map((g) => g.id), ["one", "surprise"]);
});

/* ---------- position across the whole Foray ---------- */

const q = [
  { start_sec: 100, end_sec: 200 },   // 100s
  { start_sec: 0, end_sec: 60 },      //  60s
  { start_sec: 10, authored_end_sec: 50, end_sec: 90 }, // 40s authored, padded end ignored
];

test("segmentStarts accumulates authored lengths, ignoring an ad pad", () => {
  assert.deepEqual(segmentStarts(q), [0, 100, 160]);
});

test("segmentAtElapsed maps a Foray position to a segment and an offset into it", () => {
  assert.deepEqual(segmentAtElapsed(q, 0), { index: 0, into: 0, start: 0 });
  assert.deepEqual(segmentAtElapsed(q, 99), { index: 0, into: 99, start: 0 });
  assert.deepEqual(segmentAtElapsed(q, 100), { index: 1, into: 0, start: 100 });
  assert.deepEqual(segmentAtElapsed(q, 170), { index: 2, into: 10, start: 160 });
});

test("a position past the end clamps to the last segment, never to nothing", () => {
  assert.deepEqual(segmentAtElapsed(q, 1e6), { index: 2, into: 40, start: 160 });
  assert.deepEqual(segmentAtElapsed(q, -5), { index: 0, into: 0, start: 0 });
  assert.equal(segmentAtElapsed([], 10), null);
});

test("forayElapsed converts a playhead inside somebody else's episode into Foray time", () => {
  // Segment 1 starts 100s into its source; 130s on that source's clock is 30s
  // into the segment, which is 30s into the Foray.
  assert.equal(forayElapsed(q, 0, 130), 30);
  // Segment 3 starts at 160s of the Foray and 10s into its source.
  assert.equal(forayElapsed(q, 2, 25), 175);
});

test("forayElapsed clamps a playhead outside the segment to that segment's span", () => {
  assert.equal(forayElapsed(q, 1, -100), 100, "before the in-point");
  assert.equal(forayElapsed(q, 2, 5000), 200, "past the out-point");
  assert.equal(forayElapsed(q, 0, null), 0, "no playhead yet");
});

test("forayElapsed and segmentAtElapsed are inverses at a segment boundary", () => {
  const at = segmentAtElapsed(q, 160);
  assert.equal(forayElapsed(q, at.index, q[at.index].start_sec + at.into), 160);
});

test("forayElapsed survives a bad index rather than returning NaN", () => {
  assert.equal(forayElapsed(q, -1, 10), 0);
  assert.equal(forayElapsed(q, 99, 10), 160);
  assert.equal(forayElapsed([], 0, 10), 0);
});

/* ---------- the stored-progress view (#40) ----------

   `progressSegments` is the adapter between a resolved Foray and a stored resume
   row. It exists because a queue item's id is `${forayId}#${ord}` — a POSITION,
   which stops meaning anything the moment the running order changes — while the
   authored `segment_id` survives that. */

test("progressSegments pairs every playable item with its AUTHORED segment id", () => {
  const r = resolved();
  const desc = progressSegments(r);
  assert.equal(desc.length, r.playable.length);
  assert.deepEqual(desc.map((d) => d.id), ["s1", "s2"]);
});

test("progressSegments carries the Foray-clock start and the authored length", () => {
  const r = resolved();
  const desc = progressSegments(r);
  assert.deepEqual(desc.map((d) => d.startSec), segmentStarts(r.playable));
  assert.equal(desc[0].durationSec, 100);
});

test("progressSegments skips the unplayable, because the resume index is a QUEUE index", () => {
  // A dropped segment is not in the queue, so pairing on authored position would
  // offset every id by one and anchor a resume to the wrong audio.
  const r = resolved({ items: [item("s1"), item("missing"), item("s2")] });
  assert.equal(r.playable.length, 2);
  assert.deepEqual(progressSegments(r).map((d) => d.id), ["s1", "s2"]);
});

test("progressSegments reports null rather than inventing an id it does not have", () => {
  assert.deepEqual(progressSegments(null), []);
  assert.deepEqual(progressSegments({}), []);
  const r = resolved();
  const noEntries = progressSegments({ playable: r.playable, entries: [] });
  assert.deepEqual(noEntries.map((d) => d.id), [null, null]);
});

/* ---------- narration occupies the Foray clock ----------

   The fixture below is `s1` (100 s), a 40 s bridge, then `s2` (60 s): 200 s of
   playback of which 40 s is our own narrator. Everything in this block used to
   read that Foray as 160 s long, which put every segment after the bridge 40 s
   earlier on the clock than the listener reaches it. */

const bridged = () => resolved({ items: [item("s1"), bridge("nar-1"), item("s2")] });

test("a bridge is a queue item, and the Foray is as long as the listener's ear says", () => {
  /* Mutation: delete the `duration_sec` branch of `itemRuntimeSec` in
     foray-queue.js and both numbers fall to 160 — which is what shipped. */
  const r = bridged();
  assert.equal(r.playable.length, 3);
  assert.equal(r.playable[1].kind, "tts");
  assert.equal(r.totalSec, 200);
  assert.equal(r.authoredSec, 200);
});

test("a bridge with an authored id is reported as playing, not as a lost item", () => {
  /* The entries<->queue join used to recover an item's authored position by
     parsing `${forayId}#${n}` out of its queue id. A narration item keeps its
     AUTHORED id, so the parse returned null and the bridge was reported
     `playable: false` with reason "not queued" — a running order would have
     shown every bridge as dropped.

     Mutation: change `ord: index` to `ord: null` in the narration branch of
     `buildForayQueue`, or key `queueByOrd` off the id again. */
  const r = bridged();
  const entry = r.entries.find((e) => e.type === "narration");
  assert.equal(entry.playable, true);
  assert.equal(entry.queueIndex, 1);
  assert.equal(entry.queueId, "nar-1");
  assert.deepEqual(r.unplayable, [], "nothing was lost");
});

test("a bridge shifts the Foray-clock start of every segment after it", () => {
  // Mutation: as above — the starts collapse to [0, 100, 100] and `s2` claims a
  // start 40 s before the listener gets there.
  const r = bridged();
  assert.deepEqual(segmentStarts(r.playable), [0, 100, 140]);
});

test("segmentAtElapsed can land on a bridge, and lands after it correctly", () => {
  /* Mutation: as above. With the bridge worth 0 s, 120 s into this Foray
     resolves to `s2` at +20 s — 20 seconds of tape the listener has not heard —
     instead of to the narrator, mid-line. */
  const r = bridged();
  assert.deepEqual(segmentAtElapsed(r.playable, 120), { index: 1, into: 20, start: 100 });
  assert.deepEqual(segmentAtElapsed(r.playable, 150), { index: 2, into: 10, start: 140 });
  // Clamped at the end against the LISTENER'S total, not the tape's.
  assert.equal(segmentAtElapsed(r.playable, 200).index, 2);
});

test("progressSegments gives a bridge a row: a real duration, and no id to anchor to", () => {
  /* Both halves matter and they fail differently. Dropping the row (mutation:
     filter `kind === "tts"` out of `progressSegments`) puts every later row at
     the wrong `startSec`. Inventing an id for it (mutation: `?? item.id`) lets a
     stored row anchor a resume to a bridge, which never resumes mid-sentence. */
  const desc = progressSegments(bridged());
  assert.deepEqual(desc, [
    { id: "s1", startSec: 0, durationSec: 100 },
    { id: null, startSec: 100, durationSec: 40 },
    { id: "s2", startSec: 140, durationSec: 60 },
  ]);
});

test("forayElapsed reads a playhead inside a post-bridge segment on the Foray clock", () => {
  // `s2` runs 300-360 s of its episode. Mutation: as above — this returns 130,
  // and the listener is told they are 40 s less far through than they are.
  const r = bridged();
  assert.equal(forayElapsed(r.playable, 2, 330), 170);
});

test("the Foray clock advances DURING a bridge, not only after it", () => {
  /* A segment's playhead is an offset into somebody else's episode, so the
     in-point is subtracted. A bridge has no in-point — it is a whole file of our
     own that always starts at zero — so its playhead already IS the offset.
     Reading the missing `start_sec` as "no progress" froze the clock at the
     bridge's start for the bridge's whole length: up to 180 s of a transport
     display that does not move, and any progress row written during a bridge
     storing the wrong second.

     Mutation: go back to `if (isNum(playheadSec) && isNum(item.start_sec))`, and
     all three of these collapse to 100. */
  const r = bridged();
  assert.equal(forayElapsed(r.playable, 1, 0), 100, "the bridge begins where s1 ended");
  assert.equal(forayElapsed(r.playable, 1, 20), 120);
  // Clamped at the bridge's own length, so a playhead past its end cannot spill
  // into the next segment's share of the clock.
  assert.equal(forayElapsed(r.playable, 1, 99), 140);
});

test("a bridge inherits the slot it plays inside, rather than falling out of the running order", () => {
  /* `groupBySlot` groups on `slot` and a narration record carries none, so every
     bridge collected into a trailing untitled section. That was invisible while
     bridges were reported unplayable; now that they play, it would render them
     out of authored order.

     Mutation: drop `slot: raw.slot ?? lastSlot` from `hydrateForayItems` — a
     second group appears and the bridge leaves the slot it belongs to. */
  const r = bridged();
  assert.deepEqual(r.slots.map((s) => [s.id, s.entries.length]), [["one", 3]]);
  assert.equal(r.entries[1].slot, "one");
  // An authored slot still wins over the inherited one.
  const explicit = resolved({ items: [item("s1"), bridge("nar-1", { slot: "two" }), item("s2")] });
  assert.equal(explicit.entries[1].slot, "two");
});

test("tapeSec is somebody else's audio; totalSec is the Foray", () => {
  /* Attribution is owed against tape, not against runtime — `forayCredits` sums
     per-show seconds and the narrator has no publisher. Exposed so that callers
     stop re-deriving it, which is how the two clocks got conflated.
     Mutation: `tapeSec: forayRuntimeSec(report.items)` and the two collapse. */
  const r = bridged();
  assert.equal(r.tapeSec, 160);
  assert.equal(r.totalSec, 200);
  // With no narration they are the same number, which is why nothing shipped noticed.
  const plain = resolved();
  assert.equal(plain.tapeSec, plain.totalSec);
});

test("a bridge with no duration and no script is still not free", () => {
  /* The player must keep playing whatever shipped; `check-forays.mjs` is what
     refuses to ship this. So the requirement here is only that the number is
     not zero and that the provenance says it is a guess.
     Mutation: return 0 from `narrationDuration`'s last branch. */
  const r = resolved({ items: [item("s1"), { type: "narration", id: "nar-1", asset: "https://cdn.test/n.mp3" }] });
  const entry = r.entries.find((e) => e.type === "narration");
  assert.ok(entry.duration_sec > 0);
  assert.equal(entry.duration_source, "fallback");
  assert.equal(r.totalSec, 100 + entry.duration_sec);
});

test("an estimated bridge keeps its provenance through both resolution passes", () => {
  /* `hydrateForayItems` resolves the length and `buildForayQueue` sees the
     result, so a naive second pass would relabel the estimate as measured.
     Mutation: in `narrationDuration`, return `DURATION_MEASURED` unconditionally
     when `duration_sec` is present. */
  const script = "x".repeat(170);   // 10.0 s at 17 chars/s
  const r = resolved({ items: [item("s1"), { type: "narration", id: "nar-1", asset: "https://cdn.test/n.mp3", script }] });
  assert.equal(r.playable[1].duration_sec, 10);
  assert.equal(r.playable[1].duration_source, "estimated");
  assert.equal(r.entries[1].duration_source, "estimated");
});

test("a resume anchored after a bridge re-derives to the post-bridge clock", () => {
  /* The end-to-end reason this defect mattered: `resumePoint` reasons in elapsed
     seconds against the live running order, and the live running order is
     `progressSegments`. A listener 30 s into `s2` is 170 s into this Foray, and
     with the bridge worth 0 s the stored row would come back at 130 — the same
     30 s into `s2`, but reported and painted 40 s early, and re-derived as
     `moved` on an order that never moved.

     Mutation: delete the `duration_sec` branch of `itemRuntimeSec`. */
  const r = bridged();
  const segments = progressSegments(r);
  const row = makeProgress({
    forayId: "f1", elapsedSec: 170, totalSec: r.totalSec, index: 2,
    segmentId: "s2", intoSec: 30,
  });
  const point = resumePoint(row, { totalSec: r.totalSec, maxIndex: r.playable.length - 1, segments });
  assert.equal(point.elapsedSec, 170);
  assert.equal(point.index, 2);
  assert.equal(point.drift, DRIFT_EXACT, "the order did not move; only the clock was ever wrong");
});

/* ---------- display ---------- */

test("fmtClock is m:ss under an hour and h:mm:ss over it", () => {
  assert.equal(fmtClock(0), "0:00");
  assert.equal(fmtClock(9), "0:09");
  assert.equal(fmtClock(605), "10:05");
  assert.equal(fmtClock(3673), "1:01:13");
});

test("fmtClock treats junk as zero rather than printing NaN", () => {
  for (const bad of [null, undefined, NaN, -5, "x"]) assert.equal(fmtClock(bad), "0:00");
});

test("fmtSpan reads in seconds when short and minutes when not", () => {
  assert.equal(fmtSpan(45), "45 sec");
  assert.equal(fmtSpan(152.5), "3 min");
  assert.equal(fmtSpan(0), "0 sec");
});

