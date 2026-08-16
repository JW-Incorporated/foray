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
  seekPrecision, FOREIGN, APPROXIMATE, AD_PAD_CEILING_SEC,
} from "./seek-policy.js";

/** Foray item types, as authored in the ladder document (#65's schema). */
export const SEGMENT = "segment";
export const NARRATION = "narration";

const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const nonEmpty = (s) => typeof s === "string" && s.trim().length > 0;

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

  source.forEach((raw, index) => {
    const qid = `${forayId}#${index}`;
    const drop = (reason) => skipped.push({ index, id: qid, item_id: raw?.item_id ?? null, reason });

    if (!raw || typeof raw !== "object") return drop("not an object");

    if (raw.type === NARRATION) {
      const url = raw.audio_url ?? raw.asset ?? null;
      // A missing narration line must not stall the Foray — the same rule the
      // manager already applies to a missing TTS bridge (corner case #12).
      if (!nonEmpty(url)) return drop("narration has no asset");
      items.push({
        id: raw.id ?? qid, kind: "tts", audio_url: url,
        title: raw.title ?? "", script: raw.script ?? "",
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
    const needsDriftCheck = provisional.precision === APPROXIMATE;
    if (needsDriftCheck && !isNum(raw.reference_duration_sec)) {
      return drop(
        "DAI segment with no reference_duration_sec — ADR-0007's duration rung cannot be " +
        "evaluated, and its anchor-resolution rung is not implemented"
      );
    }

    items.push({
      id: qid,
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

/** Total authored runtime of a built queue, in seconds. Segments count their
    authored length, not their padded one — the pad is tolerance, not content. */
export function forayRuntimeSec(items) {
  return (items ?? []).reduce((total, i) => {
    const end = isNum(i.authored_end_sec) ? i.authored_end_sec : i.end_sec;
    if (isNum(i.start_sec) && isNum(end)) return total + (end - i.start_sec);
    return total;
  }, 0);
}
