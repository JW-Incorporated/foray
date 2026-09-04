/* data/forays.json + data/segments.json + data/segment-sources.json  ->  a
   playable, renderable Foray (issues #128, #133, #111).

   ── Why this file exists ──────────────────────────────────────────────────
   `player/foray-queue.js` turns a Foray whose items already carry
   `start_sec`/`end_sec`/`item_id` into a player queue. The Foray we actually
   ship does NOT carry those: `data/forays.json` records the running order as
   `{ type, slot, label, segment_id, role }` and nothing else, on purpose — a
   segment is referenced by id so that correcting one segment fixes every Foray
   using it (see that file's `notes`). The timestamps live in
   `data/segments.json`, keyed by `segment_id`; the audio lives in
   `data/segment-sources.json`, keyed by the segment's `item_id`.

   Joining those three documents is therefore a required step, it is the step
   where a stale or partial deploy shows up, and it is the step a surface must
   not improvise. So it lives here: pure, no DOM, no network, no timers.

   ── What it decides ───────────────────────────────────────────────────────
     - the join, and what to do when either side of it is missing (drop the ONE
       item, name the reason, keep the rest of the Foray)
     - draft visibility: an unpublished Foray is not shown to a visitor who did
       not ask for it by id (HUMAN-ACTIONS.md #2 — only a founder may publish)
     - position <-> segment mapping across the WHOLE Foray, which is the only
       elapsed number a listener recognises: the player's own `currentTime` is
       an offset into somebody else's episode

   ── What it deliberately does NOT decide ──────────────────────────────────
   Whether a segment may play. That is `buildForayQueue` (structure, anchors,
   ADR-0008's pad) and `PlayerQueueManager._segmentGate` (ADR-0007's drift rung,
   at load, against the copy in hand). This module hands them a well-formed
   document and reports what they said.
*/

import {
  buildForayQueue, forayRuntimeSec, itemRuntimeSec, narrationDuration, SEGMENT,
} from "./foray-queue.js";

/** The one status that may be shown to a visitor who did not ask by id. */
export const PUBLISHED = "published";

const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const nonEmpty = (s) => typeof s === "string" && s.trim().length > 0;

/* ---------- the documents ---------- */

/** `{ segments: [...] }` -> Map keyed by segment id. A malformed or absent
    document yields an empty index rather than throwing: the site must survive a
    404 on any one data file, and "no segments" then degrades to "this Foray has
    nothing playable", which the caller can say out loud. */
export function indexSegments(doc) {
  return indexBy(doc?.segments, "id");
}

/** `{ sources: [...] }` -> Map keyed by episode id (a segment's `item_id`). */
export function indexSources(doc) {
  return indexBy(doc?.sources, "id");
}

function indexBy(list, key) {
  const map = new Map();
  if (!Array.isArray(list)) return map;
  for (const row of list) {
    if (row && typeof row === "object" && nonEmpty(row[key])) map.set(row[key], row);
  }
  return map;
}

/** Every Foray in the document, in document order. */
export function allForays(doc) {
  return Array.isArray(doc?.forays) ? doc.forays.filter((f) => f && typeof f === "object") : [];
}

/* ---------- draft visibility ---------- */

/**
 * May this Foray be shown?
 *
 * `status: "draft"` is the state Foray #1 is in, and it is not a formality:
 * publishing is a founder action (HUMAN-ACTIONS.md #2), so a client that
 * surfaces a draft has published it in the only sense a visitor experiences.
 * The rule is therefore not "hide drafts" but "a draft is reachable only by
 * asking for it by id" — the founder needs to play this one to test it, and a
 * keyless, linkable way in beats an access-control system this repo has no
 * server for.
 *
 * @param {object} foray
 * @param {object} [opts]
 * @param {string[]} [opts.unlocked]  ids the visitor named explicitly (`?foray=`)
 * @returns {{ visible: boolean, published: boolean, reason: string }}
 */
export function forayVisibility(foray, { unlocked = [] } = {}) {
  const status = typeof foray?.status === "string" ? foray.status : "";
  const published = status === PUBLISHED;
  if (published) return { visible: true, published, reason: "published" };
  const asked = Array.isArray(unlocked) && nonEmpty(foray?.id) && unlocked.includes(foray.id);
  if (asked) return { visible: true, published, reason: `${status || "unpublished"}, opened by id` };
  return { visible: false, published, reason: `${status || "unpublished"} — not published` };
}

/** The one Foray that exists to be measured rather than listened to: a single
    narration line that names a marker every ten seconds, so a phone speaking it
    with the screen locked reports how far it got out loud. It is `status:
    "draft"` like any unpublished Foray, so the website never lists it and a
    visitor never sees it — `HUMAN-ACTIONS.md` #29 is the whole reason it exists.
    Authored in `data/forays.json`. */
export const DIAGNOSTIC_FORAY_ID = "tts-locked-screen-check";

/**
 * The unlock list a surface should actually use.
 *
 * WHY THIS EXISTS AND WHY IT IS SHAPED LIKE THIS. `?foray=<id>` is the only way
 * to unlock a draft, and it reads `location.search` — which inside the Capacitor
 * shell is permanently empty, because the webview loads `capacitor://localhost/`
 * and there is no address bar, no `server.url`, and no registered URL scheme to
 * put a query string on. So the draft that has to be played ON A PHONE, in the
 * NATIVE app, using the NATIVE speech plugin, was the one draft no route could
 * reach. Publishing it instead would have put a diagnostic on the public
 * website's home screen, which is the opposite trade.
 *
 * So exactly one id is unlocked, and only inside the shell. The website is
 * untouched: `inShell` is false there, this returns the caller's own list
 * unchanged, and `tts-locked-screen-check` stays invisible unless somebody types
 * its `?foray=` link.
 *
 * PURE ON PURPOSE — this module has no DOM and keeps none. The caller
 * (`client.js`) is what knows whether `window.Capacitor` exists.
 *
 * DELETE THIS WITH THE FORAY. Once #29 has an answer, `DIAGNOSTIC_FORAY_ID`,
 * this function, its call sites and the Foray itself go in one commit — see
 * `HUMAN-ACTIONS.md` #29's own "Worked if".
 *
 * @param {string[]} unlocked  ids the visitor named explicitly (`?foray=`)
 * @param {{ inShell?: boolean }} [opts]
 * @returns {string[]}
 */
export function withDiagnosticUnlock(unlocked, { inShell = false } = {}) {
  const base = Array.isArray(unlocked) ? unlocked : [];
  if (!inShell || base.includes(DIAGNOSTIC_FORAY_ID)) return base;
  return [...base, DIAGNOSTIC_FORAY_ID];
}

/** The Forays a surface may LIST. Deliberately not "all of them minus drafts":
    an unlocked draft is listed too, so the founder testing one sees it where he
    expects it rather than only via the URL he typed. */
export function listableForays(doc, opts = {}) {
  return allForays(doc).filter((f) => forayVisibility(f, opts).visible);
}

/** One Foray by id, with the visibility rule applied. `null` is the honest
    answer for both "no such Foray" and "not yours to see" — a surface that
    distinguishes them leaks the existence of unpublished work. */
export function findForay(doc, id, opts = {}) {
  if (!nonEmpty(id)) return null;
  const foray = allForays(doc).find((f) => f.id === id) ?? null;
  if (!foray) return null;
  return forayVisibility(foray, opts).visible ? foray : null;
}

/* ---------- the join ---------- */

/**
 * Fill in each ordered item from `segments` + `sources`.
 *
 * One item failing the join drops THAT item and records why; it never fails the
 * Foray. A Foray that lost a segment is a shorter Foray and has to say so —
 * same contract `buildForayQueue` already keeps with `skipped`.
 *
 * The output items are in the shape `buildForayQueue` consumes, plus the
 * display fields a running order needs (`slot`, `label`, `show`, `duration_sec`,
 * `why`). Display fields ride along rather than being re-derived later so that
 * the list a listener reads and the queue that plays cannot disagree about
 * which segment is which.
 */
export function hydrateForayItems(foray, { segments, sources } = {}) {
  const segIndex = asMap(segments);
  const srcIndex = asMap(sources);
  const items = [];
  const dropped = [];
  /** The slot the running order is currently inside, so a bridge can inherit it. */
  let lastSlot = null;

  const source = Array.isArray(foray?.items) ? foray.items : [];
  source.forEach((raw, position) => {
    if (!raw || typeof raw !== "object") {
      dropped.push({ position, segment_id: null, reason: "not an object" });
      return;
    }
    /* Narration bridges are the other authored item type (#134). Inventing
       AUDIO for them is not this module's call, so they pass straight through to
       the builder, which drops any that carry no asset — but their LENGTH is
       resolved here as well as there, so that `duration_sec` means the same
       thing on a narration entry as it does on a segment entry and `authoredSec`
       below can sum one field over both. `narrationDuration` keeps its own
       provenance, so resolving in two places cannot promote an estimate. */
    if (raw.type !== SEGMENT) {
      const dur = narrationDuration(raw);
      items.push({
        ...raw, ord: items.length, position,
        duration_sec: dur.sec, duration_source: dur.source,
        /* A bridge with no authored slot inherits the one it is playing inside.
           `groupBySlot` groups on `slot`, so a null one collected every bridge
           into a trailing untitled section — harmless while bridges were
           reported unplayable, and a running order that shows them out of
           authored order now that they are not. The preceding item's slot rather
           than the following one's because the slot check in
           `tools/foray/check-forays.mjs` runs on tape only, so this can never
           make a slot look interleaved. A bridge that OPENS a Foray has nothing
           to inherit and must carry its own `slot`. */
        slot: raw.slot ?? lastSlot,
      });
      return;
    }
    lastSlot = raw.slot ?? lastSlot;

    const seg = segIndex.get(raw.segment_id);
    if (!seg) {
      dropped.push({
        position, segment_id: raw.segment_id ?? null, label: raw.label ?? null,
        reason: `segment ${raw.segment_id} is not in data/segments.json`,
      });
      return;
    }
    const src = srcIndex.get(seg.item_id);
    if (!src) {
      dropped.push({
        position, segment_id: seg.id, label: raw.label ?? null,
        reason: `episode ${seg.item_id} is not in data/segment-sources.json`,
      });
      return;
    }

    items.push({
      type: SEGMENT,
      ord: items.length,
      position,
      /* authored order, carried for display */
      slot: raw.slot ?? null,
      label: raw.label ?? null,
      role: raw.role ?? null,
      segment_id: seg.id,
      /* what buildForayQueue reads */
      item_id: seg.item_id,
      start_sec: seg.start_sec,
      end_sec: seg.end_sec,
      reference_duration_sec: seg.reference_duration_sec ?? null,
      start_anchor: seg.start_anchor ?? null,
      end_anchor: seg.end_anchor ?? null,
      ad_pad_sec: seg.ad_pad_sec ?? null,
      why: seg.why ?? "",
      /* what a running order reads */
      show: src.show ?? "",
      episode_title: src.title ?? "",
      topic: seg.topic ?? null,
      confidence: seg.confidence ?? null,
      duration_sec: spanOf(seg),
    });
  });

  return { items, dropped };
}

function asMap(x) {
  if (x instanceof Map) return x;
  if (x && typeof x === "object") return new Map(Object.entries(x));
  return new Map();
}

function spanOf(seg) {
  return isNum(seg?.start_sec) && isNum(seg?.end_sec) && seg.end_sec > seg.start_sec
    ? seg.end_sec - seg.start_sec
    : 0;
}

/* ---------- reverse lookup: which Forays draw on a given show ----------

   Show pages (#/show/:id, requirements B3/Q6) need this reverse of the join
   above: given a show, which Forays play a segment sourced from it. Lives
   here rather than in app.js because app.js is not allowed to enumerate the
   segment/source pool directly — the mobile bundle ships ONLY the segments
   its bundled Forays reference (tools/mobile/prepare-webdir.mjs, #327), so
   any surface that walks the whole pool renders complete on the website and
   silently short in the app. Doing the walk here keeps that constraint true:
   this module (plus client.js, the bridge) is the one place allowed to read
   `segments`/`sources` beyond an id lookup.

   Same draft-visibility rule as `listableForays`/`findForay`: an unpublished
   Foray is included only when the visitor named it explicitly. */
export function foraysReferencingShow(foraysDoc, showNames, { segments, sources, unlocked = [] } = {}) {
  const wanted = new Set(Array.isArray(showNames) ? showNames.filter(nonEmpty) : [showNames].filter(nonEmpty));
  if (!wanted.size) return [];
  const segIndex = asMap(segments);
  const srcIndex = asMap(sources);

  return allForays(foraysDoc).filter((f) => {
    if (!forayVisibility(f, { unlocked }).visible) return false;
    const items = Array.isArray(f.items) ? f.items : [];
    return items.some((it) => {
      if (!it || it.type !== SEGMENT) return false;
      const seg = segIndex.get(it.segment_id);
      if (!seg) return false;
      const src = srcIndex.get(seg.item_id);
      return !!src && wanted.has(src.show);
    });
  });
}

/* ---------- the whole thing ---------- */

/**
 * Join, build the queue, and pair the two back up.
 *
 * @param {object} foray  a row from data/forays.json
 * @param {object} opts
 * @param {Map|object} opts.segments  index from indexSegments()
 * @param {Map|object} opts.sources   index from indexSources()
 * @param {boolean} [opts.isLocalFile] forwarded to buildForayQueue
 * @param {boolean} [opts.allowAdPad]  forwarded to buildForayQueue
 * @returns {{
 *   id: string, title: string, foray: object,
 *   hydrated: object,              the Foray with its items filled in — hand
 *                                  THIS to setQueueFromForay, never the raw one
 *   sources: Map,                  the index, so a caller can build resolveItem
 *   playable: object[],            the player queue, in order
 *   entries: object[],             one per authored item, playable or not
 *   slots: object[],               entries grouped into the authored slots
 *   totalSec: number,              runtime of what will ACTUALLY play
 *   authoredSec: number,           runtime of what was authored
 *                                  Both are the LISTENER'S clock and both count
 *                                  narration. They are not the sum of the tape.
 *   tapeSec: number,               seconds of somebody else's audio — what
 *                                  attribution is owed against, not a runtime
 *   shows: string[],
 *   unplayable: object[],          every item that will not play, with a reason
 *   warnings: string[],
 * }}
 */
export function resolveForay(foray, opts = {}) {
  const { segments, sources, isLocalFile = false, allowAdPad = false } = opts;
  const srcIndex = asMap(sources);
  const { items, dropped } = hydrateForayItems(foray, { segments, sources: srcIndex });
  const hydrated = { ...foray, items };

  const report = buildForayQueue(hydrated, {
    resolveItem: (itemId) => srcIndex.get(itemId) ?? null,
    isLocalFile,
    allowAdPad,
  });

  /* buildForayQueue keys everything by the item's index in the list it was
     given, which is `ord` — that is the join back to the authored order, and it
     is now carried on the queue item rather than parsed back out of its id.

     THE PARSE WAS A NARRATION BUG. A segment's queue id is `${forayId}#${ord}`,
     so recovering `ord` from it worked; a narration item keeps its AUTHORED id
     (`nar-7`), the parse returned null, and the bridge was left out of
     `queueByOrd` entirely — so a narration item that plays perfectly well was
     reported `playable: false` and listed in `unplayable` as "not queued". */
  const skippedByOrd = new Map(report.skipped.map((s) => [s.index, s]));
  const queueByOrd = new Map();
  report.items.forEach((qi, queueIndex) => {
    if (Number.isInteger(qi?.ord)) queueByOrd.set(qi.ord, { queueIndex, item: qi });
  });

  const entries = [];
  const unplayable = dropped.map((d) => ({ ...d, playable: false }));

  for (const hydrated of items) {
    const hit = queueByOrd.get(hydrated.ord);
    const skip = skippedByOrd.get(hydrated.ord);
    const entry = {
      ...hydrated,
      playable: Boolean(hit),
      queueIndex: hit ? hit.queueIndex : null,
      queueId: hit ? hit.item.id : null,
      audio_url: hit ? hit.item.audio_url : null,
      reason: skip ? skip.reason : null,
    };
    entries.push(entry);
    if (!hit) unplayable.push({ ...entry, reason: skip?.reason ?? "not queued" });
  }

  entries.sort((a, b) => a.position - b.position);
  unplayable.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  return {
    id: report.id,
    title: foray?.title ?? report.title ?? "",
    foray,
    hydrated,
    sources: srcIndex,
    playable: report.items,
    entries,
    slots: groupBySlot(foray, entries),
    totalSec: forayRuntimeSec(report.items),
    authoredSec: entries.reduce((t, e) => t + (isNum(e.duration_sec) ? e.duration_sec : 0), 0),
    /* Seconds of somebody ELSE'S audio, which is a different question from how
       long the Foray is and has a different consumer: attribution. `forayCredits`
       sums per-show seconds, so on a narrated Foray its total is this number and
       not `totalSec` — the narrator has no publisher to credit. Exposed rather
       than left to each caller to re-derive, which is how the tape clock and the
       listener's clock got conflated in the first place. */
    tapeSec: forayRuntimeSec(report.items.filter((i) => i?.kind !== "tts")),
    shows: [...new Set(entries.map((e) => e.show).filter(nonEmpty))],
    unplayable,
    warnings: report.warnings,
  };
}

/**
 * Entries grouped into the Foray's authored slots, in authored slot order.
 *
 * A slot the author declared but that has no surviving entry is kept, empty:
 * the running order is the argument for the Foray's shape, and silently
 * dropping "US regional divergence" because its segments failed to resolve
 * misrepresents the thing rather than reporting a fault. A slot NOT declared in
 * `slots` still gets a section, appended, so no entry can go unrendered.
 */
export function groupBySlot(foray, entries) {
  const declared = Array.isArray(foray?.slots) ? foray.slots : [];
  const out = [];
  const byId = new Map();
  const add = (id, title) => {
    const slot = { id, title: title || id || "Segments", entries: [] };
    byId.set(id, slot);
    out.push(slot);
    return slot;
  };
  for (const s of declared) {
    if (s && typeof s === "object") add(s.id ?? null, s.title ?? s.id ?? "");
  }
  for (const e of entries) {
    const id = e.slot ?? null;
    (byId.get(id) ?? add(id, e.slot ?? "")).entries.push(e);
  }
  return out;
}

/* ---------- position across the whole Foray ---------- */

/** Cumulative authored start of every queue item, in Foray seconds. */
export function segmentStarts(items) {
  const starts = [];
  let acc = 0;
  for (const item of items ?? []) {
    starts.push(acc);
    acc += lengthOf(item);
  }
  return starts;
}

/* Every Foray-clock calculation in this file — `segmentStarts`,
   `segmentAtElapsed`, `forayElapsed`, `progressSegments` — measures an item with
   this one function, and it is `foray-queue.js`'s `itemRuntimeSec` rather than a
   local subtraction. It used to be a local subtraction, and that is precisely
   how a narration item came to be worth 0 s here AND in `forayRuntimeSec`: two
   copies of the same rule, both wrong the same way, either of which could have
   been fixed without the other. */
function lengthOf(item) {
  return itemRuntimeSec(item);
}

/**
 * Which queue item is `elapsed` seconds into the Foray, and how far into it.
 *
 * The inverse of `forayElapsed`. Clamped at both ends on purpose: a scrub to
 * exactly the total, or a rounding error past it, must land on the last segment
 * rather than on nothing.
 *
 * @returns {{ index: number, into: number, start: number } | null}
 */
export function segmentAtElapsed(items, elapsed) {
  const list = items ?? [];
  if (!list.length) return null;
  const target = isNum(elapsed) && elapsed > 0 ? elapsed : 0;
  const starts = segmentStarts(list);
  for (let i = 0; i < list.length; i++) {
    const len = lengthOf(list[i]);
    if (target < starts[i] + len) return { index: i, into: target - starts[i], start: starts[i] };
  }
  const last = list.length - 1;
  return { index: last, into: lengthOf(list[last]), start: starts[last] };
}

/**
 * The stored-progress view of a running order: one row per playable item, in
 * play order, carrying the AUTHORED segment id alongside its Foray-clock start
 * and length.
 *
 * WHY THIS SHAPE (issue #40, the freshness half)
 * A queue item's own `id` is `${forayId}#${ord}`, which is a POSITION — it
 * changes when the running order changes, so it cannot tell a stored row that
 * segment 9 is now segment 7. The authored `segment_id` can, and it lives on
 * `entries`, joined back to the queue by `queueIndex`. `player/foray-progress.js`
 * is deliberately pure and knows nothing about resolved Forays, so this is the
 * adapter between the two: `resumePoint(record, { segments: progressSegments(r) })`.
 *
 * `id` is null for any item with no authored segment (a narration bridge)
 * rather than invented — an unidentifiable item simply cannot anchor a resume,
 * and saying so is better than matching the wrong thing.
 *
 * A NARRATION BRIDGE STILL GETS A ROW, with its real `durationSec`. It has to:
 * `startSec` is cumulative, so a bridge counted as 0 s would leave every segment
 * after it claiming a Foray-clock start earlier than the one the listener
 * reaches, and `reconcileSegment` would then re-derive a resume point short by
 * the total narration ahead of it. The row is unanchorable, not absent.
 */
export function progressSegments(resolved) {
  const items = resolved?.playable ?? [];
  const starts = segmentStarts(items);
  const idByQueueIndex = new Map();
  for (const e of resolved?.entries ?? []) {
    if (e && e.playable && Number.isInteger(e.queueIndex)) idByQueueIndex.set(e.queueIndex, e.segment_id ?? null);
  }
  return items.map((item, i) => ({
    id: idByQueueIndex.get(i) ?? null,
    startSec: starts[i],
    durationSec: lengthOf(item),
  }));
}

/**
 * Elapsed across the whole Foray, from the queue index and the playhead inside
 * the SOURCE episode.
 *
 * `playheadSec` is the audio element's own `currentTime` — an offset into
 * somebody else's episode, which for segment 20 of this Foray is around 31
 * minutes and means nothing to a listener. This converts it into the only
 * number that does.
 */
export function forayElapsed(items, index, playheadSec = null) {
  const list = items ?? [];
  if (!list.length || !Number.isInteger(index) || index < 0) return 0;
  const i = Math.min(index, list.length - 1);
  const starts = segmentStarts(list);
  const item = list[i];
  /* A segment's playhead is an offset into somebody else's episode, so the
     in-point has to be subtracted. A NARRATION item has no in-point: it is a
     whole file of our own and "a bridge always starts at zero, never resumes
     mid-sentence" (docs/narrator-pipeline.md §1), so its playhead already IS the
     offset. Reading the missing `start_sec` as "no progress" instead froze the
     Foray clock for the bridge's whole length — up to 180 s of a transport
     display that does not move, and any progress row written during a bridge
     stored the bridge's start. */
  const base = isNum(item?.start_sec) ? item.start_sec : 0;
  let into = 0;
  if (isNum(playheadSec)) {
    into = Math.min(Math.max(0, playheadSec - base), lengthOf(item));
  }
  return starts[i] + into;
}

/* ---------- display ---------- */

/** `m:ss`, or `h:mm:ss` past an hour. Foray-length, not episode-length: the
    seek-policy's formatTimestamp exists for a position in one episode and
    deliberately signals imprecision, which is not this number's problem. */
export function fmtClock(sec) {
  const total = isNum(sec) && sec > 0 ? Math.floor(sec) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** "2 min" / "45 sec". Rounded, because a segment's length is a measurement of
    somebody else's audio and second-precision would overstate it. */
export function fmtSpan(sec) {
  const total = isNum(sec) && sec > 0 ? Math.round(sec) : 0;
  if (total < 90) return `${total} sec`;
  return `${Math.round(total / 60)} min`;
}
