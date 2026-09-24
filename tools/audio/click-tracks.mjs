/* NE-25a's click tracks, as the repo's audio guards see them.
 *
 * Two suites refuse committed audio: tools/transcribe/fetch-audio.test.mjs
 * (no episode audio anywhere outside player/assets/) and
 * tools/narration/render-audition.test.mjs (no audition clip under mobile/).
 * Both exist because one careless `git add -A` of a 170 MB episode is
 * unrecoverable without a history rewrite.
 *
 * The click tracks are audio under mobile/ on purpose: synthesised test
 * fixtures for the native engine's in-point / out-point measurement
 * (tools/audio/make-click-tracks.py), 964 KB for the set. So the guards
 * exempt them, and this is the ONE definition of the exemption, narrow enough
 * that the guards keep meaning what they say:
 *
 *   - only files inside CLICK_TRACK_DIR,
 *   - that click-tracks.json names,
 *   - whose bytes hash to the sha256 it records,
 *   - while the whole set is under 1 MB (else this throws, and both guards
 *     go red rather than exempting anything).
 *
 * A stray episode dropped into the fixtures directory is not named by the
 * descriptor and stays an offender; a fixture swapped for something larger
 * fails its hash or the cap.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const CLICK_TRACK_DIR = "mobile/plugins/foray-audio/ios/Tests/ForayAudioPluginTests/Fixtures/ClickTracks";
export const CLICK_TRACK_CAP_BYTES = 1_000_000;

/** Repo-relative, forward-slash paths of the click tracks the guards may skip. */
export function exemptClickTrackPaths(root) {
  const dir = path.join(root, CLICK_TRACK_DIR);
  const descriptorPath = path.join(dir, "click-tracks.json");
  if (!fs.existsSync(descriptorPath)) return new Set();
  const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
  const exempt = new Set();
  let total = 0;
  for (const f of descriptor.fixtures) {
    if (path.basename(f.file) !== f.file) continue;
    const abs = path.join(dir, f.file);
    if (!fs.existsSync(abs)) continue;
    const buf = fs.readFileSync(abs);
    total += buf.length;
    if (crypto.createHash("sha256").update(buf).digest("hex") === f.sha256) exempt.add(`${CLICK_TRACK_DIR}/${f.file}`);
  }
  if (total >= CLICK_TRACK_CAP_BYTES) {
    throw new Error(`the click tracks total ${total} bytes; the exemption covers under ${CLICK_TRACK_CAP_BYTES} (card NE-25a)`);
  }
  return exempt;
}
