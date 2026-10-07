/* Is a store upload configured? The one three-outcome rule both release gates use.
 *
 * `tools/mobile/ios-ci.mjs signing-gate` (TestFlight) and
 * `tools/mobile/release-ci.mjs play-gate` (Play internal track) ask the same
 * question of different secret lists, and until CH2-21 (docs/roadmap/
 * code-health-2.md, T2-11) each carried its own copy of the answer. Two copies
 * of a secret-handling rule is how iOS and Play come to report different states
 * for the same mistake: a trimming fix lands in one and not the other. So the
 * rule lives here once and the two gates pass their lists and their words in as
 * data.
 *
 *   ready   — every secret present. Upload.
 *   absent  — none present. SKIP the upload; the build still runs and ships as
 *             an artifact. Not a failure.
 *   partial — some present. FAILS (both CLIs exit 1 on it, and release.yml's
 *             summary step reads `partial` from either gate). A half-configured
 *             setup that quietly skips the upload is the worst of the three:
 *             someone set most of the secrets, the run went green, and no build
 *             reached the store.
 *
 * A secret counts as present only when it is a string with something other than
 * whitespace in it: GitHub hands an unset secret through as the empty string,
 * never as a missing variable, so `key in env` would call seven blank secrets
 * fully configured.
 *
 * Pure: no env read, no I/O. The callers pass `process.env`.
 */

/**
 * @param {readonly string[]} secretNames  the secrets an upload needs, in the order a report names them
 * @param {Record<string, unknown>} env
 * @param {{ ready: string, absent: string, subject: string }} messages
 *   `ready` and `absent` are the whole one-line summary for those states;
 *   `subject` begins the `partial` line ("Signing", "Play upload"), whose rest —
 *   the counts, the missing names and why it fails — is the same for every gate.
 * @returns {{ state: "ready"|"absent"|"partial", ready: boolean, present: string[], missing: string[], message: string }}
 */
export function readiness(secretNames, env = {}, messages) {
  const present = [];
  const missing = [];
  for (const key of secretNames) {
    const v = env[key];
    if (typeof v === "string" && v.trim() !== "") present.push(key);
    else missing.push(key);
  }
  const state = missing.length === 0 ? "ready" : present.length === 0 ? "absent" : "partial";
  return {
    state,
    ready: state === "ready",
    present,
    missing,
    /** One line for the job summary, written so a founder can act on it. */
    message:
      state === "ready"
        ? messages.ready
        : state === "absent"
          ? messages.absent
          : `${messages.subject} is HALF configured: ${present.length} of ${secretNames.length} secrets are ` +
            `set and ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing. Failing ` +
            `rather than skipping, because a skipped upload on a green run is invisible.`,
  };
}
