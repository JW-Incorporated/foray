/* Foray -> player queue (issues #111 / #65).

   A Foray is an ordered list of items: narration lines we authored, and
   SEGMENTS — a `[start_sec, end_sec]` slice of somebody else's episode, usually
   a different episode each time. This module turns that document into the flat,
   typed queue `PlayerQueueManager` already knows how to play, and refuses the
   ones that must not play.

   Pure: no DOM, no network, no timers, no player import beyond the seek policy.
   Everything it needs about an episode arrives through `resolveItem`.

   ── What is decided HERE, and what is deliberately not ────────────────────

   Here (structure, and one ADR-0007 rule that needs no audio):
     - an item's identity, which is NOT the episode's id — see below
     - `end_sec > start_sec`, both finite
     - a DAI source is permitted if and only if BOTH anchors are present and
       non-empty (ADR-0007's amendment to #65's flat `dai_suspected: false`)
     - ADR-0008's pad tier, because a pad is a recorded measurement rather than
       an observation of the copy in hand

   NOT here (the precision ladder's rung 3):
     `|observed_duration - reference_duration| <= DRIFT_TOLERANCE_SEC` needs the
     duration of the copy the listener actually received, which does not exist
     until the audio is loaded. The catalogue's `duration_sec` is NOT a stand-in:
     ADR-0008 establishes that the feed's declared duration describes the AD-FREE
     program, so on exactly the shows rung 3 exists for it is wrong by
     construction — Stuff You Should Know declares 36.98 min and delivers 46.93.
     So the ladder runs in `PlayerQueueManager._segmentGate`, at load, and a
     segment that fails it is skipped there. A queue built here is a queue of
     CANDIDATES.

   ── Why a segment gets a synthetic id ─────────────────────────────────────
   Queue identity is per-segment, not per-episode (`gastropod-fire#2`), because
   a Foray routinely runs two consecutive slices of one episode and every
   id-keyed lookup in the manager — `_itemFor`, `findIndex` — takes the first
   match. Keyed by episode, segment 5 would resolve to segment 2's entry and the
   Foray would loop. The episode id survives as `source_item_id`.
*/

import {
  seekPrecision, FOREIGN, EXACT, AD_PAD_CEILING_SEC,
} from "./seek-policy.js";

/** Foray item types, as authored in the ladder document (#65's schema). */
export const SEGMENT = "segment";
export const NARRATION = "narration";

const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const nonEmpty = (s) => typeof s === "string" && s.trim().length > 0;

/* ── How long a narration item is ─────────────────────────────────────────

   A segment's length is a subtraction: it is a slice, and the slice knows its
   own bounds. A narration item is not a slice of anything, so its length has to
   be CARRIED, and until it was, it was silently zero — a Foray with 23 minutes
   of narration reported a runtime 23 minutes short of what a listener hears,
   and `check-forays.mjs`'s D1 budget, `progressSegments` and every resume
   arithmetic downstream inherited the shortfall.

   Three sources, in this precedence, and the answer always says WHICH:

     1. `duration_sec` — MEASURED. `tools/narrate/` stamps it at generation time
        from the file it produced (`docs/narrator-pipeline.md` §1's first
        recommendation for this module). This is the only reading that is a fact
        rather than a projection, and it includes the padding baked into the
        asset, because it is a property of the file.
     2. `script` — ESTIMATED at `docs/curation/narration-craft.md` §0's published
        planning rate, 17 characters per second (1,020 chars/min). That document
        derives all six of its mode budgets from this same constant, so an
        estimate made with it agrees with the budget the script was written to.
        Scripts exist before audio does — narration-craft is explicit that "the
        word budgets are the primitive" — so this is the ordinary state of an
        authored-but-unvoiced bridge, not an error.
     3. Neither — FALLBACK, and the item is a defect. See the constant.

   `duration_source` survives a second pass, so resolving twice cannot promote an
   estimate to a measurement.

   NOT INCLUDED, deliberately: the seam beat and the TTS padding. The 2.0 s beat
   is wall clock the manager spends between two items and has never been part of
   authored runtime (`player/seam-gap.js`); the ~0.5 s padding is baked into the
   asset, so a measured duration already carries it and an estimate deliberately
   does not guess it. Which of those two numbers governs a bridge is
   `HUMAN-ACTIONS.md` #3 and is not settled here. */

/** `docs/curation/narration-craft.md` §0: 170 wpm x 6.0 chars/word. Characters
    rather than words because characters are what the pipeline bills and counts
    exactly, and because the rate is stated per character. */
export const NARRATION_CHARS_PER_SEC = 17;

/** An estimate is rounded to the millisecond. `50 / 17` is 2.9411764705882355
    and a duration derived from a character count has no business claiming
    femtoseconds — but the reason is not tidiness. These values are summed into
    the cumulative clock D1 compares against a 600.000 s window, and a start
    landing at 599.9999999999999 instead of 600 changes a verdict. Rounding here
    also makes the number reproducible and diffable, which a projection that
    lands in a report should be. */
const toMs = (sec) => Math.round(sec * 1000) / 1000;

/** What a narration item with neither a duration nor a script is worth.

    NOT ZERO. Zero is the bug: it makes an item that a listener sits through for
    eight seconds free, everywhere, silently. `tools/foray/check-forays.mjs`
    REJECTS such an item, so this number should never be reached by anything that
    passed CI — it exists so that a hand-edited or half-deployed document
    degrades to a visible over-estimate instead of an invisible omission.

    8 s is the transition ceiling from `docs/brief/04_VOICE_AUDIO_SPEC.md` and
    narration-craft §0: the largest a bridge — the commonest narration item — is
    allowed to be. Erring long is the safe direction here, because an
    over-counted bridge lands a resume slightly EARLY, and re-hearing four
    seconds of a narrator is recoverable where skipping past content is not. */
export const NARRATION_FALLBACK_SEC = 8;

export const DURATION_MEASURED = "measured";
export const DURATION_ESTIMATED = "estimated";
export const DURATION_FALLBACK = "fallback";

/**
 * How long a narration item runs, and on what authority.
 *
 * @param {object} item  an authored or hydrated narration item
 * @returns {{ sec: number, source: string }}
 */
export function narrationDuration(item) {
  if (isNum(item?.duration_sec) && item.duration_sec > 0) {
    /* An already-resolved item keeps its provenance. Without this, running the
       resolver twice would relabel an estimate as a measurement — the field
       would be present the second time, and "present" is what `measured`
       means. */
    return {
      sec: item.duration_sec,
      source: nonEmpty(item.duration_source) ? item.duration_source : DURATION_MEASURED,
    };
  }
  const script = typeof item?.script === "string" ? item.script.trim() : "";
  if (script.length > 0) {
    return { sec: toMs(script.length / NARRATION_CHARS_PER_SEC), source: DURATION_ESTIMATED };
  }
  return { sec: NARRATION_FALLBACK_SEC, source: DURATION_FALLBACK };
}

/**
 * One queue item's contribution to the Foray clock, in seconds.
 *
 * THE ONLY definition of "how long is this item", and it is exported so it stays
 * that way. `forayRuntimeSec` below, and `segmentStarts` / `segmentAtElapsed` /
 * `forayElapsed` / `progressSegments` in `foray-resolve.js`, all route through
 * it — four private copies of this subtraction is how narration came to be worth
 * 0 s in every one of them at once, and how a fix could have landed in one and
 * not the others.
 *
 * A segment's authored length wins over its padded one: the pad is tolerance,
 * not content (ADR-0008). A narration item has no bounds and falls through to
 * the duration `buildForayQueue` stamped on it.
 */
export function itemRuntimeSec(item) {
  const end = isNum(item?.authored_end_sec) ? item.authored_end_sec : item?.end_sec;
  if (isNum(item?.start_sec) && isNum(end) && end > item.start_sec) return end - item.start_sec;
  if (isNum(item?.duration_sec) && item.duration_sec > 0) return item.duration_sec;
  return 0;
}

/**
 * @param {object} foray  `{ id, title, items: [...] }`
 * @param {object} [opts]
 * @param {Function} [opts.resolveItem]  (item_id) => catalogue item, or null.
 *   Required for any segment that does not carry its own `audio_url`.
 * @param {boolean}  [opts.isLocalFile]  the audio is a completed download (#29)
 * @param {boolean}  [opts.allowAdPad]   opt in to ADR-0008's pad. Default false;
 *   the ADR's open question 2 is unanswered and no episode in this repo records
 *   a pad, so this changes nothing until both land.
 * @returns {{ id, title, items: object[], skipped: object[], warnings: string[] }}
 *   `items` is a player queue. `skipped` is every segment that must not play,
 *   each with a reason — a Foray that loses a segment says so out loud rather
 *   than quietly playing a shorter thing.
 */
export function buildForayQueue(foray, opts = {}) {
  const { resolveItem = null, isLocalFile = false, allowAdPad = false } = opts;
  const items = [];
  const skipped = [];
  const warnings = [];

  const forayId = foray?.id ?? "foray";
  const source = Array.isArray(foray?.items) ? foray.items : [];
  /* Queue ids must be unique across the whole Foray: every lookup in the
     manager takes the first match, so a duplicate makes one entry unreachable
     and the other play twice. Segment ids are unique by construction (index);
     an authored narration id is not, so it is checked rather than trusted. */
  const usedIds = new Set();

  source.forEach((raw, index) => {
    const qid = `${forayId}#${index}`;
    const drop = (reason) => skipped.push({ index, id: qid, item_id: raw?.item_id ?? null, reason });
    const uniqueId = (preferred) => {
      if (!nonEmpty(preferred) || usedIds.has(preferred)) {
        if (nonEmpty(preferred)) warnings.push(`${qid}: duplicate item id ${preferred} — using ${qid} instead`);
        usedIds.add(qid);
        return qid;
      }
      usedIds.add(preferred);
      return preferred;
    };

    if (!raw || typeof raw !== "object") return drop("not an object");

    if (raw.type === NARRATION) {
      const url = raw.audio_url ?? raw.asset ?? null;
      // A missing narration line must not stall the Foray — the same rule the
      // manager already applies to a missing TTS bridge (corner case #12).
      if (!nonEmpty(url)) return drop("narration has no asset");
      /* The duration is resolved HERE, once, and carried on the queue item. The
         alternative — every consumer calling `narrationDuration` on the authored
         record — puts the precedence rule in five places and guarantees that one
         of them keeps the old answer of zero. */
      const dur = narrationDuration(raw);
      if (dur.source === DURATION_FALLBACK) {
        warnings.push(
          `${qid}: narration has neither a duration_sec nor a script — counted as ` +
          `${NARRATION_FALLBACK_SEC}s so it is not free, but the runtime is a guess`
        );
      }
      items.push({
        id: uniqueId(raw.id), ord: index, kind: "tts", audio_url: url,
        title: raw.title ?? "", script: raw.script ?? "",
        duration_sec: dur.sec, duration_source: dur.source,
      });
      return;
    }

    if (raw.type !== SEGMENT) return drop(`unknown item type ${JSON.stringify(raw.type)}`);

    /* ---- resolve the source episode ---- */
    const episode = raw.audio_url ? raw : (resolveItem ? resolveItem(raw.item_id) : null);
    if (!episode) return drop(`item_id ${raw.item_id} does not resolve to a catalogue item`);
    if (!nonEmpty(episode.audio_url)) return drop(`item_id ${raw.item_id} has no audio_url`);

    /* ---- bounds ---- */
    const startSec = isNum(raw.start_sec) ? raw.start_sec : null;
    const authoredEnd = isNum(raw.end_sec) ? raw.end_sec : null;
    if (startSec == null || startSec < 0) return drop("start_sec is missing or negative");
    if (authoredEnd == null) return drop("end_sec is missing — a segment without an out-point is an episode");
    if (authoredEnd <= startSec) return drop(`end_sec ${authoredEnd} is not after start_sec ${startSec}`);

    // An out-point past the real audio is not fatal and must not be treated as
    // such: the declared duration describes the ad-free program (ADR-0008), so
    // "beyond duration_sec" is often the metadata being wrong rather than the
    // segment. The file simply ends first and the natural end takes over. Say
    // it, then carry on.
    if (isNum(episode.duration_sec) && authoredEnd > episode.duration_sec) {
      warnings.push(
        `${qid}: end_sec ${Math.round(authoredEnd)}s is past the declared duration ` +
        `${Math.round(episode.duration_sec)}s — the file's own end will stop it`
      );
    }

    /* ---- ADR-0007: a DAI source needs both anchors, verbatim ---- */
    if (episode.dai_suspected && !(nonEmpty(raw.start_anchor) && nonEmpty(raw.end_anchor))) {
      return drop("DAI source without both anchors (ADR-0007) — the timestamp cache has nothing to fall back on");
    }

    /* ---- ADR-0008's pad tier ----
       A pad is `delta_max + margin` over N >= 2 probes of the same episode, and
       it extends the STOP ONLY. Padding the start would land us earlier still:
       content authored at program-time t sits at t + cum(t) in the listener's
       file, so the seek is already early by cum(t) and no pad recovers that.
       ADR-0008 §"The pad must be an UPPER BOUND" is explicit about the geometry
       and about the asymmetry — a short pad truncates the payload, a generous
       one only adds tail. */
    const padSec = isNum(raw.ad_pad_sec) && raw.ad_pad_sec > 0 ? raw.ad_pad_sec : null;
    let appliedPad = 0;
    if (allowAdPad && padSec != null && episode.dai_suspected) {
      if (padSec > AD_PAD_CEILING_SEC) {
        return drop(
          `LOCATE-REQUIRED: ${Math.round(padSec)}s pad exceeds the ${AD_PAD_CEILING_SEC}s ceiling (ADR-0008)`
        );
      }
      appliedPad = padSec;
      warnings.push(
        `${qid}: stop extended by a ${Math.round(padSec)}s ad pad — the segment ` +
        `closes on up to that much extra tail, and opens early by this copy's own ad load`
      );
    }

    /* ---- the rung that CAN be answered without audio ----
       With no observedDuration this deliberately cannot reach rung 3; it is
       here to reject the cases that no observation could rescue (a padded tier
       over the ceiling, above) and to record the reason a DAI segment is on
       probation. A non-DAI segment settles as EXACT right here and never
       consults the gate again. */
    const provisional = seekPrecision(episode, {
      isLocalFile, source: FOREIGN,
      adPadSec: padSec ?? undefined, allowAdPad,
    });
    // `!== EXACT`, not `=== APPROXIMATE`. A PADDED segment must ALSO be gated
    // at load: the pad is a bound on the displacement, and whether this copy
    // stays inside it is a question only the observed duration can answer.
    // Reading this as "padded means settled" is how a 60s pad ends up waving
    // through a 28-minute drift.
    const needsDriftCheck = provisional.precision !== EXACT;
    if (needsDriftCheck && !isNum(raw.reference_duration_sec)) {
      return drop(
        "DAI segment with no reference_duration_sec — ADR-0007's duration rung cannot be " +
        "evaluated, and its anchor-resolution rung is not implemented"
      );
    }

    items.push({
      id: uniqueId(qid),
      /* The item's position in the AUTHORED list, carried rather than recovered
         from the id. `foray-resolve.js` used to parse `${forayId}#${n}` back out
         of the id to pair a queue item with the authored item it came from,
         which works for a segment and fails for a narration item — those keep an
         authored id like `nar-7`, so the parse returned null and the bridge was
         reported as an item that would not play. */
      ord: index,
      kind: "episode",
      audio_url: episode.audio_url,
      start_sec: startSec,
      end_sec: authoredEnd + appliedPad,
      authored_end_sec: authoredEnd,
      ad_pad_applied_sec: appliedPad,
      // Everything the load-time gate needs, carried on the item so the gate
      // never has to go back to a catalogue it does not own.
      source_item_id: episode.id ?? raw.item_id ?? null,
      dai_suspected: Boolean(episode.dai_suspected),
      reference_duration_sec: isNum(raw.reference_duration_sec) ? raw.reference_duration_sec : null,
      ad_pad_sec: padSec,
      needs_drift_check: needsDriftCheck,
      start_anchor: raw.start_anchor ?? null,
      end_anchor: raw.end_anchor ?? null,
      why: raw.why ?? "",
      title: episode.title ?? "",
      show: episode.show ?? "",
    });
  });

  return { id: forayId, title: foray?.title ?? "", items, skipped, warnings };
}

/** Total authored runtime of a built queue, in seconds — the LISTENER'S clock,
    so narration counts. Segments count their authored length, not their padded
    one: the pad is tolerance, not content. */
export function forayRuntimeSec(items) {
  return (items ?? []).reduce((total, i) => total + itemRuntimeSec(i), 0);
}
