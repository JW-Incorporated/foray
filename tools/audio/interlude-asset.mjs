/* NE-34's jingle, as the repo's tools see it.
 *
 * The native engine's InterludePlayer plays the seam jingle from the APP
 * BUNDLE, at `App.app/public/player/assets/interlude-placeholder.wav`: the
 * same repo-relative path the web serves it from, placed into the generated
 * iOS project's `public/` folder reference by tools/mobile/inject-interlude.mjs
 * after `cap add ios` / `cap sync` (the same injection point the retired
 * tools/mobile/inject-models.mjs used for the Kokoro weights until CH-20).
 *
 * IT IS NOT A SWIFTPM RESOURCE ANY MORE, AND MUST NOT BECOME ONE AGAIN. M2
 * (#873) shipped it as `resources: [.copy(...)]` on the ForayAudioPlugin
 * target, which makes SwiftPM generate a resource-bundle target
 * (`ForayAudio_ForayAudioPlugin`). The signed archive passes its provisioning
 * settings to EVERY target in the build, and a resource bundle cannot take a
 * profile, so release run 36535801479 (build 2026092902) died in
 * `xcodebuild archive` with "ForayAudio_ForayAudioPlugin does not support
 * provisioning profiles" (exit 65). The unsigned ios-shell build never sees
 * that. tools/mobile/shell-invariants.test.mjs now refuses a `resources:` on
 * any shipping target under mobile/plugins.
 *
 * There is ONE copy of the bytes in the repo (INTERLUDE_SOURCE, the web's
 * jingle) and this module is the ONE definition of the pin on it:
 *
 *   - INTERLUDE_SHA256 is the SHA-256 the file must hash to, and the same
 *     literal InterludePlayer.swift carries as `assetSHA256`. The Swift side
 *     hashes the file it actually loads before it will play it, and the
 *     injector verifies it before and after the copy.
 *   - INTERLUDE_APP_PATH is where, under the app's `public/`, it lands.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const INTERLUDE_SOURCE = "player/assets/interlude-placeholder.wav";
/** Relative to the generated project's `public/` (and so to `App.app/public/`).
 *  Mirrors the web path on purpose: InterludePlayer.swift looks here. */
export const INTERLUDE_APP_PATH = "player/assets/interlude-placeholder.wav";
export const INTERLUDE_SHA256 = "597c4fbad12846431d5c6c78bf6a4fc469b2c2d416f53f50bcb26d2e823f83af";

/** The hex SHA-256 of a buffer. */
export function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** The hex SHA-256 of a repo-relative file, or null when it is missing. */
export function sha256Of(root, rel) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return null;
  return sha256Hex(fs.readFileSync(abs));
}
