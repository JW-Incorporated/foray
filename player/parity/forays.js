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
import { resolveForay, indexSegments, indexSources, findForay, segmentStarts, segmentAtElapsed, forayElapsed } from "../foray-resolve.js";
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
