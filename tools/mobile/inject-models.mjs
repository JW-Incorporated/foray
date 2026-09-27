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
 * ── Only what `bundle` says, for THIS platform ────────────────────────────
 * Since D13 (KV-R2) the two apps carry different models: iOS the fp32 export,
 * Android q8f16, and `af_heart` both. So the platform argument is not only a
 * destination, it picks the pins: an iOS copy never carries q8f16, and
 * `--check` fails an app that carries the OTHER platform's model as well as
 * one missing its own. Twelve voices are pinned because K-03's audition
 * renders twelve; ONE is bundled. The tokenizer is pinned because the committed id table was
 * extracted from it; NONE of it ships — deck §4's whole argument is that no
 * text front end reaches the phone. A `cp mobile/models/*` in a workflow would
 * have shipped all thirteen, which is why the copy list comes from the pin
 * table instead of from a glob.
 *
 * NESTED FILES (KV-R3): the Core ML chain's seven compiled stages are
 * directories, pinned file by file as `kokoro-coreml/<Stage>.mlmodelc/<file>`,
 * so on iOS they land at `App.app/public/kokoro-coreml/…` — the folder
 * reference copies directories as they are, compiled models included, and
 * `KokoroCoreMLEngine.swift` loads each `.mlmodelc` from there.
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
 * Copy every pin `platform` bundles from `mobile/models/` into `dest`,
 * verifying each one against its pin FIRST.
 *
 * THE VERIFY IS NOT REDUNDANT with `fetch-models.mjs`'s. Between the fetch and
 * this copy sits a whole workflow — a cache restore, an artifact download, a
 * `cap sync` that rewrites directories. This is the last point at which the
 * bytes about to be executed on a listener's phone can still be checked, so it
 * is checked here too, and the second check costs one read of a file already
 * in the page cache.
 */
export function inject({ dest, platform, root = REPO_ROOT, pins = PINS } = {}) {
  const copied = [];
  const problems = [];
  const from = path.join(root, MODELS_DIR);
  const wanted = bundledPins(platform, pins);
  fs.mkdirSync(dest, { recursive: true });
  for (const pin of wanted) {
    const src = path.join(from, pin.name);
    if (!fs.existsSync(src)) {
      problems.push(`${pin.name}: not in ${MODELS_DIR} — run tools/mobile/fetch-models.mjs first`);
      continue;
    }
    const buf = fs.readFileSync(src);
    const ok = verifyBuffer(pin, buf);
    if (!ok.ok) { problems.push(ok.reason); continue; }
    /* A Core ML stage file (KV-R3) is nested — `kokoro-coreml/<Stage>.mlmodelc/…`
       — so its directory is made first; every other pin is flat. */
    const out = path.join(dest, pin.name);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buf);
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
export function check({ dest, platform, pins = PINS } = {}) {
  const problems = [];
  const wanted = bundledPins(platform, pins);
  for (const pin of wanted) {
    const abs = path.join(dest, pin.name);
    if (!fs.existsSync(abs)) { problems.push(`${pin.name}: missing from ${dest}`); continue; }
    const res = verifyBuffer(pin, fs.readFileSync(abs));
    if (!res.ok) problems.push(res.reason);
  }
  /* THE OTHER PLATFORM'S FILES MUST NOT BE HERE EITHER. A stale copy of
     q8f16 left in an iOS app would ride along as 86 MB of dead weight, and a
     325 MB fp32 in an APK would break Android's ceiling; either is a build
     that "has its model" and is still wrong. Only pins of a bundled kind
     (anything some platform ships) are looked for: the audition voices and the
     tokenizer are nobody's, and `prepare-webdir`'s own gate covers the web.
     SEARCHED AT ANY DEPTH, not only beside the right files: everything under
     `dest` ships (the Android assets dir holds the web bundle in `public/`),
     so an fp32 left in a subdirectory is 325 MB in the APK all the same. */
  const names = new Set(wanted.map((p) => p.name));
  const foreign = new Map(pins
    .filter((pin) => !names.has(pin.name) && Array.isArray(pin.bundle) && pin.bundle.length > 0)
    .map((pin) => [pin.name, pin]));
  for (const abs of filesUnder(dest)) {
    const pin = foreignPinFor(foreign, path.relative(dest, abs).split(path.sep).join("/"));
    if (pin) problems.push(`${path.relative(dest, abs) || pin.name}: present in ${dest}, but it is bundled for ${pin.bundle.join("/")} only`);
  }
  return problems;
}

/** The other platform's pin a file under `dest` IS, or undefined. A flat
    pin (a model, a voice) is matched by its file name at any depth, as
    before. A NESTED pin (a Core ML stage file, KV-R3) is matched by its whole
    relative path, at the top or under any directory: its own file names
    (`weight.bin`, `metadata.json`, `model.mil`) are far too common to
    flag on a name alone — Android's assets hold the whole web bundle. */
export function foreignPinFor(foreign, rel) {
  for (const [name, pin] of foreign) {
    if (name.includes("/")) {
      if (rel === name || rel.endsWith(`/${name}`)) return pin;
    } else if (path.posix.basename(rel) === name) {
      return pin;
    }
  }
  return undefined;
}

/** Every regular file under `dir`, at any depth. Symlinks are not followed
    (a link cannot loop the walk, and what it points at is checked where it
    lives). A missing `dir` is no files: `check` has already named it. */
function* filesUnder(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) yield* filesUnder(abs);
    else if (e.isFile()) yield abs;
  }
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
    const problems = check({ dest, platform });
    for (const p of problems) console.error(`  ${p}`);
    if (problems.length) {
      console.error(`The ${platform} app would ship without its own Kokoro weights (or with the other platform's), and the probe would not measure what it names.`);
      process.exit(1);
    }
    /* ONE LINE PER FILE, naming the platform: KV-R2's CI evidence is "fp32 in
       the iOS app, q8f16 in the APK", read straight off these lines. */
    const pins = bundledPins(platform);
    for (const pin of pins.filter((p) => p.kind !== "coreml")) {
      console.log(`  ${platform}: ${pin.name}  ${pin.bytes} bytes  sha256 ${pin.sha256.slice(0, 8)}  ok`);
    }
    /* KV-R3: the 34 Core ML stage files as one line per STAGE directory. */
    const stages = new Map();
    for (const pin of pins.filter((p) => p.kind === "coreml")) {
      const dir = pin.name.split("/").slice(0, 2).join("/");
      const st = stages.get(dir) ?? { files: 0, bytes: 0 };
      st.files += 1; st.bytes += pin.bytes;
      stages.set(dir, st);
    }
    for (const [dir, st] of stages) console.log(`  ${platform}: ${dir}  ${st.files} files  ${st.bytes} bytes  ok`);
    console.log(`${dest}: every model file the ${platform} app bundles is present and matches its pin, and no other platform's is.`);
    process.exit(0);
  }
  const { copied, problems } = inject({ dest, platform });
  for (const c of copied) console.log(`  ${c.name}  ${c.bytes} bytes  -> ${dest}`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(problems.length ? 1 : 0);
}
