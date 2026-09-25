/* The committed Forays, as parity inputs (NE-29j, plan §6: "the real committed
   Forays through the $foray macro").

   WHY THIS FILE EXISTS. `$foray: "<id>"` hands a case the RAW authored document
   from data/forays.json — items that name `segment_id`s, not audio. What the
   player (and, on iOS, the engine's `playForay`) actually receives is the page's
   BUILD of that document: `resolveForay` joins it against data/segments.json and
   data/segment-sources.json and runs `buildForayQueue`. The rules these cases
   pin — the lock-screen credit, the Foray clock, the structural check — are
   rules over that build. So each function below takes the raw Foray, builds it
   exactly the way the page does (`resolveForay`, the same call
   media-session.test.js's `realResolved` makes), and asks the real rule.
   Nothing here decides an answer.

   WHY THE ANSWERS ARE INVARIANTS, NOT RECORDINGS. A committed Foray changes
   whenever its data is repaired or regenerated, and a publish must not turn
   `npm test` red for growing or editing the corpus — only for breaking a rule
   (the same argument backend/src/cli/publishSuites.ts makes for
   test/foray-row-links.test.js). So every function returns a count of
   violations or a verdict, and the cases over committed Forays are AUTHORED:
   zero, true, `{ok: true}`. The one exception is `frozenCensus`, which reads the
   FROZEN fixture (tools/foray/fixtures/frozen/data), never data/, exactly as
   interlude.test.js's capital-types-1 test does, so its counts are stable.

   WHAT THE SWIFT RUNNER NEEDS (NE-29s). The same build as input. The engine
   never builds a Foray — `buildForayQueue` and `foray-resolve` stay the page's
   (plan §3 A-1, §11) — so the Swift side of these cases needs the page's build
   of each named Foray, not a Swift resolver. That is NE-29s's harness choice
   (a JS-emitted build table read by ForayEngineParity, or a parity-only join);
   the expects do not depend on which.

   The page never imports this file. It is harness code, like runner.js. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveForay, indexSegments, indexSources, findForay, segmentStarts, segmentAtElapsed, forayElapsed,
  fmtClock, progressSegments,
} from "../foray-resolve.js";
import { makeProgress, resumePoint } from "../foray-progress.js";
import { SEAM_GAP_SEC } from "../seam-gap.js";
import { forayRuntimeSec, itemRuntimeSec } from "../foray-queue.js";
import { mediaMetadata, mediaSessionView, narrationCredit, APP_NAME, APP_ARTWORK_URL } from "../media-session.js";
import { structuralCheck, seamCensus } from "../foray-structure.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FROZEN_DATA = "tools/foray/fixtures/frozen/data";

const docCache = new Map();
function doc(dir, name) {
  const key = `${dir}/${name}`;
  if (!docCache.has(key)) docCache.set(key, JSON.parse(fs.readFileSync(path.join(ROOT, dir, name), "utf8")));
  return docCache.get(key);
}

/** The page's build of a raw Foray against the documents in `dir`. */
function build(foray, dir = "data") {
  if (!foray || typeof foray !== "object" || !Array.isArray(foray.items)) {
    throw new TypeError("a Foray document ({id, title, items}) is required — pass it through $foray");
  }
  return resolveForay(foray, {
    segments: indexSegments(doc(dir, "segments.json")),
    sources: indexSources(doc(dir, "segment-sources.json")),
  });
}

/** The lock-screen metadata of every playable item, as client.js asks for it. */
function rows(r) {
  const total = r.playable.length;
  return r.playable.map((item, index) => ({
    item,
    meta: mediaMetadata({ item, nextItem: r.playable[index + 1] ?? null, forayTitle: r.title, index, total }),
    credit: item.kind === "episode" ? null : narrationCredit({ forayTitle: r.title, nextItem: r.playable[index + 1] ?? null }),
  }));
}

/**
 * "4a is never the artist of anything audible" (L-06 / F15), over one Foray:
 * how many playable items — segment, narration or jingle — the lock screen
 * would credit to the app, through `mediaMetadata` or `narrationCredit`.
 * @returns {number} 0 is the rule
 */
export function appAsArtist(foray) {
  return rows(build(foray)).filter(({ meta, credit }) => meta.artist === APP_NAME || credit === APP_NAME).length;
}

/**
 * The rest of the lock screen over one Foray, as violation counts (0 is the rule):
 *   blankTitle         an item with no title
 *   blankArtist        an item with no credit (F-89: a jingle resolved to "")
 *   albumMissingForay  an album that does not name the Foray
 *   frozenDisplays     a join where title, artist and album all stay the same —
 *                      a car display that does not change at a seam reads as a
 *                      stuck player
 *   segmentNotShow     a segment credited to anything but its show (Apple
 *                      Podcasts parity)
 *   narrationArtwork   a narration or jingle item wearing anything but the
 *                      app's artwork
 */
export function lockScreenAudit(foray) {
  const r = build(foray);
  const list = rows(r);
  const key = ({ meta }) => `${meta.title}|${meta.artist}|${meta.album}`;
  let frozenDisplays = 0;
  for (let i = 1; i < list.length; i++) if (key(list[i]) === key(list[i - 1])) frozenDisplays += 1;
  return {
    blankTitle: list.filter(({ meta }) => meta.title.length === 0).length,
    blankArtist: list.filter(({ meta }) => meta.artist.length === 0).length,
    albumMissingForay: list.filter(({ meta }) => !meta.album.includes(r.title)).length,
    frozenDisplays,
    segmentNotShow: list.filter(({ item, meta }) => item.kind === "episode" && meta.artist !== item.show).length,
    narrationArtwork: list.filter(({ item, meta }) => item.kind !== "episode"
      && (meta.artwork.length !== 1 || meta.artwork[0].src !== APP_ARTWORK_URL)).length,
  };
}

/**
 * The lock screen reports the FORAY's clock, never the segment's: at the tape
 * item past the Foray's midpoint, halfway through the Foray.
 * @returns {{ tapeItemFound: boolean, durationIsForayTotal: boolean,
 *             durationIsNotSegment: boolean, positionIsForayClock: boolean }}
 */
export function lockScreenClock(foray) {
  const r = build(foray);
  const mid = Math.floor(r.playable.length / 2);
  const index = r.playable.findIndex((it, i) => i >= mid && Number.isFinite(it.end_sec - it.start_sec));
  if (index < 0) return { tapeItemFound: false, durationIsForayTotal: false, durationIsNotSegment: false, positionIsForayClock: false };
  const item = r.playable[index];
  const positionSec = Math.floor(r.totalSec / 2);
  const view = mediaSessionView({
    item, forayTitle: r.title, index, total: r.playable.length,
    durationSec: r.totalSec, positionSec, playing: true,
  });
  return {
    tapeItemFound: true,
    durationIsForayTotal: view.positionState?.duration === r.totalSec,
    durationIsNotSegment: view.positionState?.duration !== item.end_sec - item.start_sec,
    positionIsForayClock: view.positionState?.position === positionSec,
  };
}

/**
 * The Foray clock over one committed Foray (the `foray-clock` family):
 *   statedRuntimeHolds  the document's `runtime_sec` is the build's clock total
 *                       to within check-forays.mjs's 0.5 s — so a jingle counts
 *                       for exactly what the page and the engine count (OQ-6)
 *   startsAreCumulative every item starts where the one before it ends
 *   everyStartMapsBack  `segmentAtElapsed` at each item's start is that item
 *   elapsedRoundTrips   `forayElapsed` of an item's own playhead 1 s in (or its
 *                       start, for an item under 1 s) is that item's start + 1
 * @returns {{[k: string]: boolean}} all true is the rule
 */
export function clockAudit(foray) {
  const r = build(foray);
  const items = r.playable;
  const starts = segmentStarts(items);
  const total = forayRuntimeSec(items);
  let acc = 0;
  let cumulative = true;
  let mapsBack = true;
  let roundTrips = true;
  items.forEach((item, i) => {
    const len = itemRuntimeSec(item);
    if (Math.abs(starts[i] - acc) > 1e-9) cumulative = false;
    acc += len;
    if (len > 0 && segmentAtElapsed(items, starts[i])?.index !== i) mapsBack = false;
    const into = Math.min(1, len);
    const base = Number.isFinite(item.start_sec) ? item.start_sec : 0;
    if (Math.abs(forayElapsed(items, i, base + into) - (starts[i] + into)) > 1e-9) roundTrips = false;
  });
  return {
    statedRuntimeHolds: typeof foray.runtime_sec === "number" ? Math.abs(foray.runtime_sec - total) <= 0.5 : true,
    startsAreCumulative: cumulative && Math.abs(acc - total) <= 1e-9,
    everyStartMapsBack: mapsBack,
    elapsedRoundTrips: roundTrips,
  };
}

/** J-4 over one committed Foray: the page's build passes the engine's
    structural check. `{ok: true, reason: null, problems: []}` is the rule. */
export function structureOf(foray) {
  return structuralCheck(build(foray).playable);
}

/** The seam census of a Foray in the FROZEN fixture, by id (never data/: these
    counts are pinned, and a publish must not move them). */
export function frozenCensus(id) {
  const foray = findForay(doc(FROZEN_DATA, "forays.json"), id, {});
  if (!foray) throw new TypeError(`${id} is not in the frozen fixture`);
  return seamCensus(build(foray, FROZEN_DATA).playable);
}

/** The committed-Foray suite's own precondition: data/forays.json still has
    at least two Forays to run these rules over. */
export function committedForays() {
  const list = doc("data", "forays.json").forays ?? [];
  return { atLeastTwo: list.length >= 2 };
}

/* ---------- the foray-data family (NE-30j): the page's build, JS only ----------

   foray-playback.test.js runs REAL curated Forays end to end, and part of what
   it pins is not playback at all but the page's build of the documents — every
   authored segment resolves to https audio, the running order is the authored
   one, the clock renders the runtime, a resume row over the real order
   reconciles. The engine never builds a Foray (plan §3 A-1): the page resolves
   and sends items. So these are recorded in a JS-ONLY family (`foray-data`,
   schema `jsOnly`): owed to no Swift card, and still a case that goes red when
   the build or the data breaks a rule. Each answer is a set of named booleans
   (or counts), and the cases are AUTHORED at the rule (all true, zero). */

/** Every committed Foray's build: every authored segment resolves to a
    playable entry with https audio (foray-playback's shipped-data half). */
export function resolveAudit(foray) {
  const r = build(foray);
  const authored = (foray.items ?? []).filter((i) => i.type === "segment").length;
  const resolved = r.entries.filter((e) => e.segment_id);
  return {
    everyAuthoredSegmentHasAnEntry: resolved.length === authored,
    unplayable: resolved.filter((e) => e.playable !== true).length,
    notHttps: resolved.filter((e) => !/^https:/.test(String(e.audio_url))).length,
  };
}

function frozenForay(id) {
  const foray = findForay(doc(FROZEN_DATA, "forays.json"), id, { unlocked: [id] });
  if (!foray) throw new TypeError(`${id} is not in the frozen fixture`);
  return foray;
}

/** A clock string parsed back to whole seconds, hours optional (M:SS or H:MM:SS). */
function clockSeconds(clock) {
  if (!/^(?:\d+:[0-5]\d|[0-9]{1,2}):[0-5]\d$/.test(clock)) return null;
  return clock.split(":").map(Number).reverse().reduce((t, v, i) => t + v * [1, 60, 3600][i], 0);
}

/**
 * The premises and the page-side rules foray-playback.test.js pins over a
 * FROZEN Foray (never data/: these are stable by construction). All true is
 * the rule.
 */
export function frozenAudit(id) {
  const foray = frozenForay(id);
  const r = build(foray, FROZEN_DATA);
  const items = r.playable;
  const segs = r.entries.filter((e) => e.segment_id);
  const authored = foray.items.filter((i) => i.type === "segment");
  const last = items.length - 1;

  let mapsBack = true;
  items.forEach((item, i) => {
    const into = Math.min(5, (item.authored_end_sec ?? item.end_sec) - item.start_sec - 0.5);
    const back = segmentAtElapsed(items, forayElapsed(items, i, item.start_sec + into));
    if (back?.index !== i || Math.abs(back.into - into) >= 0.001) mapsBack = false;
  });
  const mid = Math.floor(items.length / 2);
  const midElapsed = forayElapsed(items, mid, items[mid].start_sec + 5);

  const progress = (over) => makeProgress({ forayId: r.id, title: r.title, now: new Date(0), ...over });
  const closing = resumePoint(progress({ elapsedSec: r.totalSec - 10, totalSec: r.totalSec, index: last }), { totalSec: r.totalSec });
  const longer = resumePoint(progress({ elapsedSec: r.totalSec + 600, totalSec: r.totalSec + 900, index: 99 }), { totalSec: r.totalSec });
  const ps = progressSegments(r);
  const at = ps[9];
  const row = progress({ elapsedSec: at.startSec + 30, totalSec: r.totalSec, index: 9, segmentId: at.id, intoSec: 30 });
  const exact = resumePoint(row, { totalSec: r.totalSec, maxIndex: last, segments: ps });
  let acc = 0;
  const reclocked = ps.filter((_, i) => i !== 9).map((s) => { const out = { ...s, startSec: acc }; acc += s.durationSec; return out; });
  const dropped = resumePoint(row, { totalSec: acc, maxIndex: reclocked.length - 1, segments: reclocked });

  return {
    isDraft: foray.status === "draft",
    itemsAreTyped: foray.items.every((i) => i.type === "segment" || i.type === "narration"),
    noBridges: foray.items.every((i) => i.type === "segment"),
    everySegmentResolves: r.unplayable.length === 0 && segs.length === authored.length && segs.every((e) => e.playable === true),
    allHttps: items.every((i) => /^https:\/\//.test(i.audio_url)),
    runningOrderIsAuthored: JSON.stringify(r.entries.map((e) => e.label)) === JSON.stringify(foray.items.map((i) => i.label))
      && JSON.stringify(r.slots.map((s) => s.id)) === JSON.stringify((foray.slots ?? []).map((s) => s.id)),
    slotsCoverEntries: r.slots.reduce((n, s) => n + s.entries.length, 0) === r.entries.length,
    runtimeMatchesDeclared: Math.abs(r.totalSec - foray.runtime_sec) < 1,
    clockRendersRuntime: clockSeconds(fmtClock(r.totalSec)) === Math.floor(r.totalSec),
    moreThanOneShow: r.shows.length >= 2 && r.entries.every((e) => e.show),
    repeatsAnEpisode: items.some((it, i) => i > 0 && items[i - 1].source_item_id === it.source_item_id),
    beatsWithinTheD3Share: ((items.length - 1) * SEAM_GAP_SEC) / r.totalSec <= SEAM_GAP_SEC / 90,
    elapsedIsForayTime: Math.round(forayElapsed(items, 0, items[0].start_sec + 30)) === 30
      && midElapsed > 0 && midElapsed < r.totalSec && segmentAtElapsed(items, midElapsed).index === mid,
    elapsedNeverExceedsTotal: forayElapsed(items, last, items[last].end_sec + 999) <= r.totalSec + 0.001,
    everySecondMapsBack: mapsBack,
    closingSegmentIsFinished: closing?.finished === true,
    longerVersionClampsToTotal: longer?.elapsedSec === r.totalSec && segmentAtElapsed(items, longer.elapsedSec)?.index === last,
    ownOrderReconcilesExact: exact?.drift === "exact" && exact.index === 9 && Math.round(exact.elapsedSec) === Math.round(at.startSec + 30),
    droppedSegmentDegrades: dropped?.drift === "dropped" && dropped.index === -1 && dropped.elapsedSec <= acc,
  };
}

/** The cross-episode seams of a frozen Foray: the seams that reassign a source,
    which is where an engine resets its rate (foray-playback's speed premise). */
export function frozenSeams(id) {
  const items = build(frozenForay(id), FROZEN_DATA).playable;
  let crossEpisode = 0;
  for (let i = 1; i < items.length; i++) if (items[i].audio_url !== items[i - 1].audio_url) crossEpisode++;
  return { playable: items.length, crossEpisodeAtLeastFive: crossEpisode >= 5 };
}
