/* The locate step's arithmetic — where to search for an authored segment's
   anchors in the copy in hand, and whether what was found is believable
   (docs/roadmap/dai.md DAI-10; ADR-0008).

   ADR-0008 §"What a large delta costs, and what recovers it": on an
   ad-injecting show the authored timestamps are a stale cache, and only finding
   the anchors in the downloaded copy turns them back into times. This module is
   the pure half of that step, the JS reference a native or worker implementation
   is checked against. It does no fetching, no decoding and no matching; it
   answers three questions with numbers:

     1. locateWindow — which stretch of the file must be fetched and searched.
        Injected ads only ever push content LATER (dai-playback-brief §3: the
        seek lands early), so each search range opens at the authored time and
        runs `delta_max + margin` past it, the same upper bound the pad uses
        (ADR-0008, the window is `delta_max + margin` wide). The margin may not
        be below the observed spread between two loads of one episode (ADR-0008
        decision 3).
     2. windowBytes — what that stretch costs to fetch at a given bitrate.
     3. locatedBounds — the located start and end, the shift of each end from
        the authored time, or a refusal. A located span may be LONGER than the
        authored one (a mid-roll inside the segment plays, never cut) by up to
        the search range's width, but never shorter than authored by more than
        LOCATED_SPAN_TOLERANCE_SEC: content does not shrink under ad load.

   `player/seek-policy.js` `locateStep()` stays `{ implemented: false }`; this
   file wires nothing. Not on the boot path (CH-07): it is a JS reference
   nothing in the page imports, so the web neither modulepreloads, precaches
   nor deploys it until a caller imports it (tools/ci/generate-manifest.mjs
   lists only player/client.js's import closure); the native webdir still
   copies it, so it stays dependency-free and small. */

/** How much shorter than authored a located span may be (anchor-match jitter). */
export const LOCATED_SPAN_TOLERANCE_SEC = 2;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

function requireField(name, value, min, inclusive = true) {
  if (!isNum(value)) throw new RangeError(`${name} must be a finite number`);
  if (inclusive ? value < min : value <= min) {
    throw new RangeError(`${name} must be ${inclusive ? ">=" : ">"} ${min}`);
  }
}

/**
 * The fetch window and the two search ranges for one authored segment.
 * Throws a RangeError naming the bad field.
 */
export function locateWindow(opts) {
  if (opts === null || typeof opts !== "object") {
    throw new RangeError("locateWindow needs an options object");
  }
  const { start_sec, end_sec, delta_max_sec, spread_sec, margin_sec = spread_sec, lead_sec = 0 } = opts;
  requireField("start_sec", start_sec, 0);
  if (!isNum(end_sec)) throw new RangeError("end_sec must be a finite number");
  if (!(end_sec > start_sec)) throw new RangeError("end_sec must be > start_sec");
  requireField("delta_max_sec", delta_max_sec, 0);
  requireField("spread_sec", spread_sec, 0);
  requireField("lead_sec", lead_sec, 0);
  if (!isNum(margin_sec)) throw new RangeError("margin_sec must be a finite number");
  if (margin_sec < spread_sec) {
    throw new RangeError("margin below the observed spread (ADR-0008 decision 3)");
  }
  const reach = delta_max_sec + margin_sec;
  const fetch_start_sec = Math.max(0, start_sec - lead_sec);
  const fetch_end_sec = end_sec + reach;
  return {
    fetch_start_sec,
    fetch_end_sec,
    span_sec: fetch_end_sec - fetch_start_sec,
    search_start: { from_sec: start_sec, to_sec: start_sec + reach },
    search_end: { from_sec: end_sec, to_sec: end_sec + reach },
  };
}

/** Bytes in `span_sec` seconds at `bitrate_bps`, rounded up; null on bad input. */
export function windowBytes(span_sec, bitrate_bps) {
  if (!isNum(span_sec) || !isNum(bitrate_bps) || span_sec <= 0 || bitrate_bps <= 0) return null;
  return Math.ceil((span_sec * bitrate_bps) / 8);
}

function requireRange(name, range) {
  if (range === null || typeof range !== "object" || !isNum(range.from_sec) || !isNum(range.to_sec)) {
    throw new RangeError(`${name} must be a { from_sec, to_sec } range of finite numbers`);
  }
}

/**
 * The located bounds and per-end shifts, or `{ refused: reason }`.
 * A malformed `authored` or `window` is a caller bug and throws a RangeError;
 * a hit that cannot be believed is a data outcome and is refused.
 */
export function locatedBounds(opts) {
  if (opts === null || typeof opts !== "object") {
    throw new RangeError("locatedBounds needs an options object");
  }
  const { start_hit_sec, end_hit_sec, authored, window } = opts;
  if (authored === null || typeof authored !== "object" || !isNum(authored.start_sec) || !isNum(authored.end_sec)) {
    throw new RangeError("authored must carry finite start_sec and end_sec");
  }
  if (window === null || typeof window !== "object") throw new RangeError("window must be a locateWindow() result");
  requireRange("window.search_start", window.search_start);
  requireRange("window.search_end", window.search_end);

  if (!isNum(start_hit_sec) || !isNum(end_hit_sec)) return { refused: "hit not a number" };
  const ss = window.search_start;
  const se = window.search_end;
  if (start_hit_sec < ss.from_sec || start_hit_sec > ss.to_sec) {
    return { refused: "start hit outside its search range" };
  }
  if (end_hit_sec < se.from_sec || end_hit_sec > se.to_sec) {
    return { refused: "end hit outside its search range" };
  }
  if (end_hit_sec <= start_hit_sec) return { refused: "end before start" };
  const authoredSpan = authored.end_sec - authored.start_sec;
  const locatedSpan = end_hit_sec - start_hit_sec;
  if (locatedSpan < authoredSpan - LOCATED_SPAN_TOLERANCE_SEC) {
    return { refused: "located span shorter than authored" };
  }
  if (locatedSpan > authoredSpan + (se.to_sec - se.from_sec)) {
    return { refused: "located span longer than the window allows" };
  }
  return {
    start_sec: start_hit_sec,
    end_sec: end_hit_sec,
    shift_start_sec: start_hit_sec - authored.start_sec,
    shift_end_sec: end_hit_sec - authored.end_sec,
  };
}
