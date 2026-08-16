/* Seek precision policy (issue #30).

   ONE function decides whether a timestamp can be trusted, and every seek path
   must consult it. Scattering this rule across call sites is how an app ends up
   confidently dropping someone 90 seconds off the thing they asked for.

   ── Why this is not just `currentTime = n` ────────────────────────────────
   docs/brief/05_CORNER_CASES.md #2: a dynamic-ad-insertion host stitches ads
   per request, so the same episode serves different bytes and a total duration
   that moves by 1-4 minutes. A timestamp taken from one copy misaligns against
   another.

   ── The refinement that came out of #22 ───────────────────────────────────
   The flat rule first sketched in #30 was "dai_suspected -> approximate". That
   is too pessimistic, and measuring DAI for #22 showed why: **DAI is designed
   to serve a stable file to a given listener**, because otherwise resuming
   playback would not work. The bytes vary across listeners and across long time
   gaps — not between one listener's own requests.

   So what actually matters is where the timestamp CAME FROM:

     own      the listener made it against the copy they were holding —
              a bookmark, or a saved playback position. Reliable for them.
     foreign  it came from somewhere else — chapter marks authored against
              the un-stitched master, or transcript times from a separate
              fetch. This is the case corner case #2 is really about.

   A local downloaded file is exact for both, because the timeline is frozen
   (#29 additionally forbids re-fetching an episode while a saved position
   exists, which is what keeps that true).

   ── The ADR-0007 ladder (issue #111) ──────────────────────────────────────
   A Foray segment boundary is FOREIGN by definition — it was authored against
   somebody else's copy — so the OWN/FOREIGN split above decided everything and
   the answer was always "approximate, skip it". ADR-0007 adds the rung that
   makes a stitched show playable *sometimes*, by asking a second question:

     1. local downloaded file (#29)          -> EXACT, timeline frozen
     2. not DAI                              -> EXACT via start_sec
     3. DAI, |observed - reference| <= 30s   -> EXACT — the ad load in the copy
                                                in hand matches the copy the
                                                timestamp was authored against,
                                                so the cache is live
     4. DAI, duration drifted                -> resolve the anchor against a
                                                transcript of the copy in hand
     5. anchor unresolvable                  -> APPROXIMATE, and the segment is
                                                SKIPPED, never played at the
                                                wrong place

   **Rung 4 is not implemented and is not faked.** It needs a transcript of the
   listener's own copy, which needs the audio, which needs the download path
   (#29) — ADR-0008 names it the "locate step" and leaves which implementation
   gets funded as its open question 1. `locateStep()` below exists so the gap is
   a named, callable, tested absence rather than a silence: every caller that
   reaches rung 4 lands on rung 5, on purpose.

   ── ADR-0008's pad, and why it is off by default ──────────────────────────
   ADR-0008 (2026-08-16) allows an injected show whose *pad* — `delta_max +
   margin`, over N >= 2 probes of the SAME episode — is <= 120s. Three things
   about it are implemented literally here, because each is a rule the ADR
   states rather than a judgement call:

     - The ceiling is on the PAD, not on a raw delta or a ratio.
     - The pad is an UPPER BOUND. A point estimate is too small about half the
       time, and every such time truncates the payload.
     - The pad extends the STOP only. Content authored at program-time `t` sits
       at `t + cum(t)` in the listener's file, so the seek lands early by cum(t)
       whatever we do — padding cannot buy that back, and padding the START
       would land us earlier still.

   `allowAdPad` defaults to FALSE, and that is the ADR's own position rather
   than caution on our part: its open question 2 — "does the playback pad ship
   before the locate step?" — is addressed to Wyatt and is unanswered. Off, the
   behaviour is exactly what §"What we can do today" describes: a foreign DAI
   timestamp is approximate and the segment is skipped. Nothing in this repo
   records `ad_pad_sec` for any episode either, so turning it on today changes
   no outcome — it is a switch waiting for both a ruling and a measurement.

   ── Honesty rule ──────────────────────────────────────────────────────────
   Corner case #2c: for a stitched copy we say "roughly minute 70", never a
   hard-seek claim. `formatTimestamp` is the only approved way to render one, so
   the tilde cannot be forgotten at a call site.
*/

/** Timestamp provenance. See the header — this distinction is the whole point. */
export const OWN = "own";
export const FOREIGN = "foreign";

export const EXACT = "exact";
export const APPROXIMATE = "approximate";
/** Playable, but only with ADR-0008's pad on the stop. Never `exact`: a padded
    segment opens on extra run-up and closes on extra tail, by design. */
export const PADDED = "padded";

/** A saved duration that has drifted by more than this many seconds means the
    ad load changed and the timeline moved under us. 30s is deliberately loose:
    encoders disagree by a second or two on the same file, and we do not want to
    cry drift over rounding.

    ADR-0008 is explicit that this constant must NOT be widened to accommodate
    ad padding: it guards the listener's own marker against their own copy,
    which is a different question with a correct answer already. The pad below
    is a separate number for a separate rung. */
export const DRIFT_TOLERANCE_SEC = 30;

/** ADR-0008's admission ceiling, equal to `ANCHOR_TIME_TOLERANCE_SEC` in
    `tools/segments/merge-segments.mjs`. Applied to the pad, never to a raw
    delta — see the header. */
export const AD_PAD_CEILING_SEC = 120;

/**
 * Can we seek to this timestamp exactly?
 *
 * @param {object} item          catalogue item; only `dai_suspected` is read
 * @param {object} ctx
 * @param {boolean} ctx.isLocalFile   playing a downloaded file (#29)
 * @param {string}  ctx.source        OWN | FOREIGN — defaults to FOREIGN, the
 *                                    safe assumption when a caller forgets
 * @param {number}  [ctx.observedDuration]  duration of the copy in hand
 * @param {number}  [ctx.recordedDuration]  duration when the timestamp was made.
 *                                    For a segment this is ADR-0007's
 *                                    `reference_duration_sec`.
 * @param {number}  [ctx.adPadSec]    ADR-0008 pad for this episode, in seconds:
 *                                    `delta_max + margin` over N >= 2 probes.
 * @param {boolean} [ctx.allowAdPad]  opt in to the pad rung. Default false —
 *                                    ADR-0008 open question 2 is unanswered.
 * @returns {{ precision: "exact"|"padded"|"approximate", reason: string,
 *             padSec?: number }}
 */
export function seekPrecision(item, ctx = {}) {
  const {
    isLocalFile = false, source = FOREIGN, observedDuration, recordedDuration,
    adPadSec, allowAdPad = false,
  } = ctx;

  // A downloaded file has a frozen timeline. Nothing else can override this.
  if (isLocalFile) return { precision: EXACT, reason: "local file" };

  if (!item?.dai_suspected) return { precision: EXACT, reason: "static enclosure" };

  // Stitched from here down.
  if (source === OWN) {
    // The listener's own marker against their own copy. Stable within a
    // session — unless the copy demonstrably changed underneath them.
    if (
      typeof observedDuration === "number" &&
      typeof recordedDuration === "number" &&
      Math.abs(observedDuration - recordedDuration) > DRIFT_TOLERANCE_SEC
    ) {
      return {
        precision: APPROXIMATE,
        reason: `ad load changed (${Math.round(Math.abs(observedDuration - recordedDuration))}s duration drift)`,
      };
    }
    return { precision: EXACT, reason: "listener's own marker on their own copy" };
  }

  /* FOREIGN + stitched: ADR-0007's ladder, rungs 3 to 5. */

  // Rung 3. Both durations describe the SAME episode; if they agree, this
  // copy's ad load matches the one the timestamp was authored against, so the
  // cached timestamp is live. One scalar cannot LOCATE a shifted timestamp —
  // that is rung 4 — but it can tell us nothing shifted.
  if (typeof observedDuration === "number" && Number.isFinite(observedDuration) &&
      typeof recordedDuration === "number" && Number.isFinite(recordedDuration)) {
    const drift = Math.abs(observedDuration - recordedDuration);
    if (drift <= DRIFT_TOLERANCE_SEC) {
      return {
        precision: EXACT,
        reason: `ad load matches the reference copy (${Math.round(drift)}s duration drift)`,
      };
    }
  }

  // ADR-0008's pad. Sits between rungs 3 and 4: it does not locate anything,
  // it accepts a bounded displacement and covers it on the stop.
  if (allowAdPad && typeof adPadSec === "number" && Number.isFinite(adPadSec) && adPadSec > 0) {
    if (adPadSec <= AD_PAD_CEILING_SEC) {
      return {
        precision: PADDED,
        padSec: adPadSec,
        reason: `PADDABLE: ${Math.round(adPadSec)}s pad within the ${AD_PAD_CEILING_SEC}s ceiling (ADR-0008)`,
      };
    }
    return {
      precision: APPROXIMATE,
      reason: `LOCATE-REQUIRED: ${Math.round(adPadSec)}s pad exceeds the ${AD_PAD_CEILING_SEC}s ceiling (ADR-0008)`,
    };
  }

  // Rungs 4 and 5 collapse into one until the locate step exists.
  return { precision: APPROXIMATE, reason: `dynamic ad insertion; ${locateStep().reason}` };
}

/**
 * ADR-0007 rung 4 — resolve the anchor against a transcript of the copy in
 * hand. ADR-0008 calls it the locate step.
 *
 * This function exists to make the gap **callable and asserted** rather than
 * absent. #111's acceptance criterion is literally "the unimplemented
 * live-resolution path is explicitly marked in code, not silently absent", and
 * an absence cannot be tested — a future reader cannot tell a deliberate gap
 * from an oversight, and neither can a test suite. So the ladder asks, gets a
 * `false`, and falls to the honest-skip rung, and there is one place to change
 * when the step lands.
 *
 * Blocked on: the audio (#29, native-only), and on which implementation is
 * funded — windowed on-device ASR or Chromaprint alignment (ADR-0008 open
 * question 1). The search window is `delta_max + margin` wide, for the same
 * upper-bound reason the pad is.
 */
export function locateStep() {
  return {
    implemented: false,
    reason: "anchor resolution (ADR-0007 rung 4 / ADR-0008's locate step) is not implemented — segment skipped rather than played at a stale offset",
  };
}

/** Convenience: may this timestamp be presented as a hard seek target? */
export function canSeekExactly(item, ctx) {
  return seekPrecision(item, ctx).precision === EXACT;
}

/** May we play a segment at this timestamp at all? Exact plays as authored;
    padded plays with an extended stop; approximate is skipped. */
export function canPlaySegment(item, ctx) {
  return seekPrecision(item, ctx).precision !== APPROXIMATE;
}

/* ---------- rendering ---------- */

function hms(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

/**
 * Render a timestamp for display. The ONLY approved way to show one.
 *
 * Exact   -> "1:07:30"
 * Approx  -> "~68 min"
 *
 * Approximate deliberately switches to minute language rather than staying in
 * clock format. Two reasons, both learned by getting it wrong first:
 *   - "~1:08:00" shows seconds on a timeline we have just said has moved —
 *     false precision in a confident voice (corner case #2c).
 *   - "~0:37" would be read as 37 *seconds* anywhere near an mm:ss scrubber.
 * Minutes are unambiguous at any magnitude and read as the estimate they are.
 */
export function formatTimestamp(seconds, precision = EXACT) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "--:--";
  if (precision === EXACT) return hms(seconds);
  return `~${Math.round(seconds / 60)} min`;
}

/** Longer prose form, for a chapter list or a spoken response.
    Deliberately avoids the banned copy words (CLAUDE.md) and never implies
    precision we do not have. */
export function describeTimestamp(seconds, precision = EXACT) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "";
  if (precision === EXACT) return `at ${hms(seconds)}`;
  const mins = Math.round(seconds / 60);
  return `around minute ${mins}`;
}
