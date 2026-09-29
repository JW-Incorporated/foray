#!/usr/bin/env node
/* tools/mobile/inject-interlude.mjs — NE-34's seam jingle, into the generated iOS app.
 *
 * WHY THIS EXISTS (2026-09-29). M2 (#873) shipped the jingle as a SwiftPM
 * resource of the ForayAudioPlugin target. That makes SwiftPM generate a
 * resource-bundle target, the signed archive hands its provisioning settings
 * to every target, and a resource bundle cannot take a profile: release run
 * 36535801479 (build 2026092902) failed in `xcodebuild archive` with
 * "ForayAudio_ForayAudioPlugin does not support provisioning profiles". So the
 * jingle now reaches the app the way the Kokoro weights do
 * (tools/mobile/inject-models.mjs, whose header explains the mechanism):
 * copied into the generated project's `public/` FOLDER REFERENCE after
 * `cap add ios` / `cap sync`, which Xcode copies into `App.app/public/`
 * whole, with no project surgery and no extra target.
 *
 * WHY NOT prepare-webdir.mjs. The web bundle is capped at 3 MB and stood at
 * 2.69 MB when this was written; the jingle is 529 KB. It is also iOS-only:
 * Android's native half does not play it. So it is not a web-bundle file.
 *
 * It lands at `<public>/player/assets/interlude-placeholder.wav`, the same
 * relative path the web serves it from, which is where InterludePlayer.swift
 * looks (after the bundle root). The bytes are verified against the pin in
 * tools/audio/interlude-asset.mjs BEFORE the copy and again by `--check`,
 * and InterludePlayer.swift hashes what it loads before it plays it.
 *
 * USAGE
 *     node tools/mobile/inject-interlude.mjs mobile/ios/App/App/public
 *     node tools/mobile/inject-interlude.mjs mobile/ios/App/App/public --check
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INTERLUDE_APP_PATH, INTERLUDE_SHA256, INTERLUDE_SOURCE, sha256Hex } from "../audio/interlude-asset.mjs";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_DEST = "mobile/ios/App/App/public";

/** Copy the pinned jingle into `dest`. Refuses (and writes nothing) when the
 *  source does not hash to the pin. Returns { copied, problems }. */
export function inject({ dest, root = REPO_ROOT } = {}) {
  const src = path.join(root, INTERLUDE_SOURCE);
  if (!fs.existsSync(src)) return { copied: null, problems: [`${INTERLUDE_SOURCE}: missing`] };
  const buf = fs.readFileSync(src);
  const got = sha256Hex(buf);
  if (got !== INTERLUDE_SHA256) {
    return { copied: null, problems: [`${INTERLUDE_SOURCE}: sha256 ${got}, pinned ${INTERLUDE_SHA256}`] };
  }
  const out = path.join(dest, INTERLUDE_APP_PATH);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buf);
  return { copied: { path: out, bytes: buf.length }, problems: [] };
}

/** Is the jingle in `dest`, and is it the pinned one? Returns problems. */
export function check({ dest } = {}) {
  const abs = path.join(dest, INTERLUDE_APP_PATH);
  if (!fs.existsSync(abs)) return [`${INTERLUDE_APP_PATH}: missing from ${dest}`];
  const got = sha256Hex(fs.readFileSync(abs));
  return got === INTERLUDE_SHA256 ? [] : [`${INTERLUDE_APP_PATH} in ${dest}: sha256 ${got}, pinned ${INTERLUDE_SHA256}`];
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const args = process.argv.slice(2);
  const wantCheck = args.includes("--check");
  const destArg = args.find((a) => !a.startsWith("--"));
  const dest = path.resolve(REPO_ROOT, destArg || DEFAULT_DEST);
  if (wantCheck) {
    const problems = check({ dest });
    for (const p of problems) console.error(`  ${p}`);
    if (problems.length) {
      console.error("The iOS app would ship without the seam jingle: InterludePlayer reports `unavailable` and Foray seams play no jingle.");
      process.exit(1);
    }
    console.log(`${dest}: ${INTERLUDE_APP_PATH} present, sha256 ${INTERLUDE_SHA256.slice(0, 8)} ok`);
    process.exit(0);
  }
  const { copied, problems } = inject({ dest });
  for (const p of problems) console.error(`  ${p}`);
  if (copied) console.log(`  ${INTERLUDE_SOURCE}  ${copied.bytes} bytes  -> ${copied.path}`);
  process.exit(problems.length ? 1 : 0);
}
