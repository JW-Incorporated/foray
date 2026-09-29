/* NE-34's bundled jingle, as the repo's audio guards see it.
 *
 * The native engine's InterludePlayer plays the seam jingle from the iOS
 * plugin's own resources (mobile/plugins/foray-audio/ios/Sources/
 * ForayAudioPlugin/Resources/interlude-placeholder.wav), because a SwiftPM
 * resource must live inside its target. That file is a byte-identical COPY of
 * player/assets/interlude-placeholder.wav, the web's jingle, and this module
 * is the ONE definition of the pin that keeps it so:
 *
 *   - INTERLUDE_SHA256 is the SHA-256 both files must hash to, and the same
 *     literal InterludePlayer.swift carries as `assetSHA256` (the XCTest
 *     hashes the bundled copy on the Simulator against that);
 *   - exemptInterludePaths() is the narrow exemption the two audio guards
 *     (tools/transcribe/fetch-audio.test.mjs, tools/narration/
 *     render-audition.test.mjs) grant it: the one path, only while its bytes
 *     hash to the pin AND the web asset still does too. A different WAV
 *     dropped at that path, or a re-exported web jingle nobody copied across,
 *     exempts nothing and both guards go red.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const INTERLUDE_SOURCE = "player/assets/interlude-placeholder.wav";
export const INTERLUDE_BUNDLED = "mobile/plugins/foray-audio/ios/Sources/ForayAudioPlugin/Resources/interlude-placeholder.wav";
export const INTERLUDE_SHA256 = "597c4fbad12846431d5c6c78bf6a4fc469b2c2d416f53f50bcb26d2e823f83af";

/** The hex SHA-256 of a repo-relative file, or null when it is missing. */
export function sha256Of(root, rel) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
}

/** Repo-relative, forward-slash paths of the bundled jingle the guards may skip. */
export function exemptInterludePaths(root) {
  const exempt = new Set();
  if (sha256Of(root, INTERLUDE_SOURCE) === INTERLUDE_SHA256 && sha256Of(root, INTERLUDE_BUNDLED) === INTERLUDE_SHA256) {
    exempt.add(INTERLUDE_BUNDLED);
  }
  return exempt;
}
