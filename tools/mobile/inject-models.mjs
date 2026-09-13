#!/usr/bin/env node
/* tools/mobile/inject-models.mjs — the fetched weights, into the generated app.
 *
 * `docs/bundled-voice-plan.md` K-01/K-06. `fetch-models.mjs` puts verified
 * files in `mobile/models/`; this puts the BUNDLED subset of them where each
 * platform's generated project will pick them up. Two steps, not one, because
 * they fail for different reasons and a founder reading a red build needs to
 * know which: "the download was wrong" is a pin problem, "the app has no
 * weights" is a wiring problem.
 *
 * ── Where each platform's files go, and why there ─────────────────────────
 * ANDROID: `mobile/android/app/src/main/assets/`, at the ROOT. That is where
 * `ForayTtsPlugin.java` looks — `ctx.getAssets().list("")` — and Capacitor's
 * own web bundle lives one level down in `assets/public/`, so the two do not
 * collide.
 *
 * IOS: `mobile/ios/App/App/public/`. This is the one that needs explaining.
 * Capacitor's iOS template carries the web bundle as a FOLDER REFERENCE — the
 * whole directory is copied into `App.app/public/` at build time, whatever is
 * in it — so a file placed there after `cap sync` reaches the built app with
 * no Xcode project surgery at all. The alternative is a Node script editing a
 * `.pbxproj` to add a resource build phase, which is a class of fragility this
 * repo has so far avoided: `inject-app-icon.mjs` and `inject-splash.mjs` both
 * write into an asset catalog, which is a directory of JSON, not a project
 * graph. `ForayTtsPlugin.swift` therefore looks in the bundle root FIRST and
 * `public/` second, so if K-04 ever adds a real resource phase nothing here
 * has to change.
 *
 * ── This does NOT put a model in the web bundle ───────────────────────────
 * `prepare-webdir.mjs`'s `assertNoModelWeights` refuses a model in the WEB
 * BUNDLE — the thing the website serves and `MAX_BYTES` caps at 3 MB — and
 * that gate is untouched and still meaningful. This step runs AFTER
 * `cap sync`, against the generated iOS project's copy, which the website
 * never sees. `--check` below asserts the source webdir is still clean, so the
 * distinction is enforced rather than merely described.
 *
 * ── Only what `bundle: true` says ─────────────────────────────────────────
 * Twelve voices are pinned because K-03's audition renders twelve; ONE is
 * bundled. The tokenizer is pinned because the committed id table was
 * extracted from it; NONE of it ships — deck §4's whole argument is that no
 * text front end reaches the phone. A `cp mobile/models/*` in a workflow would
 * have shipped all thirteen, which is why the copy list comes from the pin
 * table instead of from a glob.
 *
 * USAGE
 *     node tools/mobile/inject-models.mjs ios      mobile/ios/App/App/public
 *     node tools/mobile/inject-models.mjs android  mobile/android/app/src/main/assets
 *     node tools/mobile/inject-models.mjs ios      <dir> --check
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PINS, MODELS_DIR, REPO_ROOT, bundledPins, verifyBuffer } from "./fetch-models.mjs";

export const PLATFORMS = Object.freeze({
  ios: "mobile/ios/App/App/public",
  android: "mobile/android/app/src/main/assets",
});

/** What a platform's default destination is, or null for an unknown one.
    Exported so the workflows and the tests read the same table rather than
    each spelling a path. */
export function defaultDestFor(platform) {
  return Object.prototype.hasOwnProperty.call(PLATFORMS, platform) ? PLATFORMS[platform] : null;
}

/**
 * Copy every `bundle: true` pin from `mobile/models/` into `dest`, verifying
 * each one against its pin FIRST.
 *
 * THE VERIFY IS NOT REDUNDANT with `fetch-models.mjs`'s. Between the fetch and
 * this copy sits a whole workflow — a cache restore, an artifact download, a
 * `cap sync` that rewrites directories. This is the last point at which the
 * bytes about to be executed on a listener's phone can still be checked, so it
 * is checked here too, and the second check costs one read of a file already
 * in the page cache.
 */
export function inject({ dest, root = REPO_ROOT, pins = PINS } = {}) {
  const copied = [];
  const problems = [];
  const from = path.join(root, MODELS_DIR);
  fs.mkdirSync(dest, { recursive: true });
  for (const pin of bundledPins(pins)) {
    const src = path.join(from, pin.name);
    if (!fs.existsSync(src)) {
      problems.push(`${pin.name}: not in ${MODELS_DIR} — run tools/mobile/fetch-models.mjs first`);
      continue;
    }
    const buf = fs.readFileSync(src);
    const ok = verifyBuffer(pin, buf);
    if (!ok.ok) { problems.push(ok.reason); continue; }
    fs.writeFileSync(path.join(dest, pin.name), buf);
    copied.push({ name: pin.name, bytes: buf.length });
  }
  return { copied, problems };
}

/**
 * Are the bundled files present in `dest`, and right?
 *
 * Separate from `inject` and run after it in the workflows, for the reason
 * every `--check` in this directory exists: a copy that silently wrote to the
 * wrong directory is indistinguishable from a copy that worked, until an app
 * ships with no weights and a founder is told `model-absent` on a build that
 * looked green.
 */
export function check({ dest, pins = PINS } = {}) {
  const problems = [];
  for (const pin of bundledPins(pins)) {
    const abs = path.join(dest, pin.name);
    if (!fs.existsSync(abs)) { problems.push(`${pin.name}: missing from ${dest}`); continue; }
    const res = verifyBuffer(pin, fs.readFileSync(abs));
    if (!res.ok) problems.push(res.reason);
  }
  return problems;
}

/* --------------------------------------------------------------------- main */

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const [platform, destArg, ...rest] = process.argv.slice(2);
  const wantCheck = rest.includes("--check");
  const fallback = defaultDestFor(platform);
  if (!fallback) {
    console.error(`Unknown platform ${JSON.stringify(platform)}. Expected one of: ${Object.keys(PLATFORMS).join(", ")}`);
    process.exit(2);
  }
  const dest = path.resolve(REPO_ROOT, destArg || fallback);
  if (wantCheck) {
    const problems = check({ dest });
    for (const p of problems) console.error(`  ${p}`);
    if (problems.length) {
      console.error(`The app would ship with no Kokoro weights, and the probe would answer "model-absent".`);
      process.exit(1);
    }
    console.log(`${dest}: every bundled model file is present and matches its pin.`);
    process.exit(0);
  }
  const { copied, problems } = inject({ dest });
  for (const c of copied) console.log(`  ${c.name}  ${c.bytes} bytes  -> ${dest}`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(problems.length ? 1 : 0);
}
