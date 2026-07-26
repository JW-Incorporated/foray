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

/** A saved duration that has drifted by more than this many seconds means the
    ad load changed and the timeline moved under us. 30s is deliberately loose:
    encoders disagree by a second or two on the same file, and we do not want to
    cry drift over rounding. */
export const DRIFT_TOLERANCE_SEC = 30;

/**
 * Can we seek to this timestamp exactly?
 *
 * @param {object} item          catalogue item; only `dai_suspected` is read
 * @param {object} ctx
 * @param {boolean} ctx.isLocalFile   playing a downloaded file (#29)
 * @param {string}  ctx.source        OWN | FOREIGN — defaults to FOREIGN, the
 *                                    safe assumption when a caller forgets
 * @param {number}  [ctx.observedDuration]  duration of the copy in hand
 * @param {number}  [ctx.recordedDuration]  duration when the timestamp was made
 * @returns {{ precision: "exact"|"approximate", reason: string }}
 */
export function seekPrecision(item, ctx = {}) {
  const { isLocalFile = false, source = FOREIGN, observedDuration, recordedDuration } = ctx;

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

  return { precision: APPROXIMATE, reason: "dynamic ad insertion" };
}

/** Convenience: may this timestamp be presented as a hard seek target? */
export function canSeekExactly(item, ctx) {
  return seekPrecision(item, ctx).precision === EXACT;
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
