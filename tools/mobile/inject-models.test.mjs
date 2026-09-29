/* The weights-into-the-app step (`tools/mobile/inject-models.mjs`).
 *
 * `docs/bundled-voice-plan.md` K-01/K-06. The failure this whole file guards
 * against is the quiet one: a build that fetched and verified 82 MB of weights
 * correctly and then put them somewhere the app does not look. That build is
 * green, uploads to TestFlight, and tells a founder holding a locked phone
 * `could not measure (model-absent)` — which reads as "the fetch failed" and
 * sends him to look at the wrong step.
 *
 * Every test names the mutation that turns it red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PINS, MODELS_DIR, bundledPins } from "./fetch-models.mjs";
import { inject, check, defaultDestFor, PLATFORMS, foreignPinFor } from "./inject-models.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "foray-inject-models-"));

/** A pin table with real hashes over tiny bodies, so the copy path can be
    exercised end to end without an 82 MB download. The SHAPE is what is under
    test — which files move, where, and what happens when one is wrong. */
function fixture() {
  /* Since D13 the two apps carry different models, so the fixture does too:
     `model.onnx` is iOS's, `other-model.onnx` Android's, and the voice both. */
  const bodies = {
    "model.onnx": Buffer.from("weights, pretend"),
    "other-model.onnx": Buffer.from("the other platform's weights, pretend"),
    "voice.bin": Buffer.from("style matrix, pretend"),
    "tokenizer.json": Buffer.from("{}"),
  };
  const crypto = require("node:crypto");
  const pin = (name, bundle) => ({
    kind: name.endsWith(".onnx") ? "model" : name.endsWith(".bin") ? "voice" : "tokenizer",
    name,
    url: `https://example.invalid/${name}`,
    sha256: crypto.createHash("sha256").update(bodies[name]).digest("hex"),
    bytes: bodies[name].length,
    licence: "Apache-2.0",
    source: "https://example.invalid/",
    bundle,
  });
  return {
    bodies,
    pins: [
      pin("model.onnx", ["ios"]),
      pin("other-model.onnx", ["android"]),
      pin("voice.bin", ["ios", "android"]),
      pin("tokenizer.json", []),
    ],
  };
}

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);

function stage(root, bodies) {
  fs.mkdirSync(path.join(root, MODELS_DIR), { recursive: true });
  for (const [name, buf] of Object.entries(bodies)) {
    fs.writeFileSync(path.join(root, MODELS_DIR, name), buf);
  }
}

/* ---------- where things go ---------- */

test("each platform has one destination, and it is where the native half looks", () => {
  /* The Java half lists `getAssets().list("")`, i.e. the assets ROOT, and
     Capacitor's own web bundle sits one level down in `assets/public` — so a
     model written into `assets/public` would be invisible to
     `ForayTtsPlugin.java` while looking perfectly present in the .aab. The iOS
     path is `App/App/public` for the opposite reason: that directory is a
     folder reference and is copied wholesale, which is the only injection
     point in the generated project that is not a `.pbxproj` edit.
     MUTATION: point android at `assets/public` — the asset listing no longer
     finds the model and every run answers `model-absent`. */
  assert.equal(defaultDestFor("android"), "mobile/android/app/src/main/assets");
  assert.equal(defaultDestFor("ios"), "mobile/ios/App/App/public");
  assert.equal(defaultDestFor("web"), null, "an unknown platform is an error, not a default");
  assert.deepEqual(Object.keys(PLATFORMS).sort(), ["android", "ios"]);
});

test("the iOS destination agrees with the subdirectory the Swift half searches", () => {
  /* Two halves of one fact in two languages: this script writes into
     `.../App/App/public`, and `ForayTtsPlugin.swift` falls back to
     `subdirectory: "public"` when the bundle root has nothing. Neither is
     checkable from the other at run time, so both are pinned here.
     MUTATION: change `RESOURCE_SUBDIR` in the Swift source. */
  const swift = fs.readFileSync(
    path.join(import.meta.dirname, "..", "..",
      "mobile/plugins/foray-tts/ios/Sources/ForayTtsPlugin/ForayTtsPlugin.swift"), "utf8");
  assert.match(swift, /RESOURCE_SUBDIR\s*=\s*"public"/);
  assert.ok(defaultDestFor("ios").endsWith("/public"));
});

/* ---------- the copy ---------- */

test("only the bundled pins are copied — eleven voices and the tokenizer stay behind", () => {
  /* THE TEST THAT KEEPS THE SIZE BUDGET HONEST. A `cp mobile/models/*` in a
     workflow would ship all thirteen pinned files: 5.5 MB of voices nobody
     auditions on a phone, and a tokenizer whose presence is the first step
     back towards a text front end on the device (deck §4).
     MUTATION: copy every pin instead of `bundledPins(pins)`. */
  const { bodies, pins } = fixture();
  const root = tmp();
  stage(root, bodies);
  const dest = path.join(tmp(), "out");
  const { copied, problems } = inject({ dest, platform: "ios", root, pins });
  assert.deepEqual(problems, []);
  assert.deepEqual(copied.map((c) => c.name).sort(), ["model.onnx", "voice.bin"]);
  assert.equal(fs.existsSync(path.join(dest, "other-model.onnx")), false,
    "the other platform's model never reaches this app");
  assert.equal(fs.existsSync(path.join(dest, "tokenizer.json")), false,
    "the id table never reaches a phone");
});

test("a file that does not match its pin is NOT copied", () => {
  /* THE LAST CHECK BEFORE THE BYTES ARE EXECUTED ON A PHONE. Between the fetch
     and this copy sits a cache restore, an artifact download and a `cap sync`;
     verifying again costs one read of a file already in the page cache.
     MUTATION: drop the `verifyBuffer` call and copy whatever is on disk — a
     corrupted or substituted model reaches the app and ORT runs it. */
  const { bodies, pins } = fixture();
  const root = tmp();
  stage(root, bodies);
  fs.writeFileSync(path.join(root, MODELS_DIR, "model.onnx"), Buffer.from("something else"));
  const dest = path.join(tmp(), "out");
  const { copied, problems } = inject({ dest, platform: "ios", root, pins });
  assert.equal(copied.length, 1, "the good file still moves");
  assert.equal(problems.length, 1);
  assert.match(problems[0], /model\.onnx/);
  assert.equal(fs.existsSync(path.join(dest, "model.onnx")), false);
});

test("a missing fetch is named as a fetch problem, not as a copy problem", () => {
  /* "Run fetch-models.mjs first" and "the bytes are wrong" send a reader to
     two different files. MUTATION: collapse both into one message. */
  const { pins } = fixture();
  const root = tmp();
  fs.mkdirSync(path.join(root, MODELS_DIR), { recursive: true });
  const { problems } = inject({ dest: path.join(tmp(), "out"), platform: "ios", root, pins });
  assert.equal(problems.length, 2);
  for (const p of problems) assert.match(p, /run tools\/mobile\/fetch-models\.mjs first/);
});

/* ---------- the check ---------- */

test("check() fails on an empty destination and passes on a good one", () => {
  /* The step that exists because a copy into the wrong directory looks exactly
     like a copy that worked. MUTATION: return `[]` when the file is absent
     ("nothing to check") — the build goes green with no weights in it. */
  const { bodies, pins } = fixture();
  const root = tmp();
  stage(root, bodies);
  const dest = path.join(tmp(), "out");
  assert.equal(check({ dest, platform: "ios", pins }).length, 2, "an empty destination is two missing files");
  inject({ dest, platform: "ios", root, pins });
  assert.deepEqual(check({ dest, platform: "ios", pins }), []);
  fs.writeFileSync(path.join(dest, "voice.bin"), Buffer.from("truncated"));
  assert.match(check({ dest, platform: "ios", pins }).join("\n"), /voice\.bin/);
});

/* ---------- the real table ---------- */

test("check() fails an app that carries the other platform's model, and names it", () => {
  /* KV-R2 (D13): the iOS app carries fp32 and the APK q8f16. A destination
     holding its own files AND the other platform's model is not "fine with an
     extra file": in the APK it is 325 MB over the ceiling, in the iOS app 86 MB
     of a model that goes NaN on Apple silicon.
     MUTATION: drop the other-platform scan from `check` — this goes green on a
     wrong app. */
  const { bodies, pins } = fixture();
  const root = tmp();
  stage(root, bodies);
  const dest = path.join(tmp(), "out");
  inject({ dest, platform: "android", root, pins });
  assert.deepEqual(check({ dest, platform: "android", pins }), []);
  fs.copyFileSync(path.join(root, MODELS_DIR, "model.onnx"), path.join(dest, "model.onnx"));
  const problems = check({ dest, platform: "android", pins });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /model\.onnx: present in .*bundled for ios only/);
  /* The workstation-only files are nobody's model: their presence is the web
     gate's business, not this one's. */
  fs.copyFileSync(path.join(root, MODELS_DIR, "tokenizer.json"), path.join(dest, "tokenizer.json"));
  assert.equal(check({ dest, platform: "android", pins }).length, 1);
  /* AT ANY DEPTH: everything under the assets dir ships, so the other
     platform's model in a subdirectory (the web bundle's `public/`, say) is in
     the APK all the same. MUTATION: look only at `dest`'s top level — the
     nested copy below goes unreported. */
  fs.rmSync(path.join(dest, "model.onnx"));
  assert.deepEqual(check({ dest, platform: "android", pins }), []);
  fs.mkdirSync(path.join(dest, "public", "deep"), { recursive: true });
  fs.copyFileSync(path.join(root, MODELS_DIR, "model.onnx"), path.join(dest, "public", "deep", "model.onnx"));
  const nested = check({ dest, platform: "android", pins });
  assert.equal(nested.length, 1);
  assert.match(nested[0], /public[\\/]deep[\\/]model\.onnx: present in .*bundled for ios only/);
});

test("inject and check refuse to guess a platform", () => {
  /* "Which app?" has no default since D13. MUTATION: default `platform` to
     "ios" — an Android build would then copy fp32 into the APK. */
  const { bodies, pins } = fixture();
  const root = tmp();
  stage(root, bodies);
  assert.throws(() => inject({ dest: path.join(tmp(), "out"), root, pins }), /unknown platform/);
  assert.throws(() => check({ dest: tmp(), pins }), /unknown platform/);
});

test("the real table bundles exactly the files each native half names", () => {
  /* The filenames are spelled in four places — the pin table, the Swift
     constants, the Java constants and this script's output. Three of the four
     are pinned against each other elsewhere; this is the fourth. Per platform
     since D13: fp32 in the iOS app, q8f16 in the APK, af_heart in both.
     MUTATION: rename the voice pin without renaming `VOICE_RESOURCE`. */
  /* KV-R3: plus the Core ML chain's 34 stage files, all under kokoro-coreml/. */
  const ios = bundledPins("ios", PINS);
  assert.deepEqual(ios.filter((p) => p.kind !== "coreml").map((p) => p.name), ["kokoro-v1_0-fp32.onnx", "af_heart.bin"]);
  assert.equal(ios.filter((p) => p.kind === "coreml").length, 34);
  assert.ok(ios.filter((p) => p.kind === "coreml").every((p) => p.name.startsWith("kokoro-coreml/")));
  assert.deepEqual(bundledPins("android", PINS).map((p) => p.name), ["kokoro-v1_0-q8f16.onnx", "af_heart.bin"]);
  const root = path.join(import.meta.dirname, "..", "..");
  const swift = fs.readFileSync(
    path.join(root, "mobile/plugins/foray-tts/ios/Sources/ForayTtsPlugin/ForayTtsPlugin.swift"), "utf8");
  assert.match(swift, /VOICE_RESOURCE\s*=\s*"af_heart"/);
  const java = fs.readFileSync(
    path.join(root, "mobile/plugins/foray-tts/android/src/main/java/ai/jwlabs/foura/tts/KokoroOrtProbeEngine.java"),
    "utf8");
  assert.match(java, /VOICE_ASSET\s*=\s*"af_heart\.bin"/);
});

test("a nested Core ML stage file lands at its path, and only its whole path is foreign", () => {
  /* KV-R3: a compiled Core ML stage is a DIRECTORY, pinned file by file as
     `kokoro-coreml/<Stage>.mlmodelc/<file>`. The copy must recreate the
     path (the Swift engine loads the directory), and the other-platform scan
     must match the whole path: `weight.bin` or `metadata.json` alone is a
     name the Android web bundle may well carry.
     MUTATION: match nested pins by basename — the web bundle's own
     `public/weights/weight.bin` below is reported as a Core ML file. */
  const crypto = require("node:crypto");
  const body = Buffer.from("compiled stage, pretend");
  const name = "kokoro-coreml/KokoroAlbert.mlmodelc/weights/weight.bin";
  const pins = [{
    kind: "coreml", name, url: "https://example.invalid/w", bytes: body.length,
    sha256: crypto.createHash("sha256").update(body).digest("hex"),
    licence: "Apache-2.0", source: "https://example.invalid/", bundle: ["ios"],
  }];
  const root = tmp();
  fs.mkdirSync(path.join(root, MODELS_DIR, path.dirname(name)), { recursive: true });
  fs.writeFileSync(path.join(root, MODELS_DIR, name), body);
  const ios = path.join(tmp(), "ios");
  const { copied, problems } = inject({ dest: ios, platform: "ios", root, pins });
  assert.deepEqual(problems, []);
  assert.deepEqual(copied.map((c) => c.name), [name]);
  assert.ok(fs.existsSync(path.join(ios, ...name.split("/"))), "the stage directory is recreated");
  assert.deepEqual(check({ dest: ios, platform: "ios", pins }), []);

  const android = path.join(tmp(), "android");
  fs.mkdirSync(path.join(android, "public", "weights"), { recursive: true });
  fs.writeFileSync(path.join(android, "public", "weights", "weight.bin"), "a web asset");
  assert.deepEqual(check({ dest: android, platform: "android", pins }), [], "a same-named web file is not the stage");
  fs.cpSync(path.join(ios, "kokoro-coreml"), path.join(android, "kokoro-coreml"), { recursive: true });
  const foreign = check({ dest: android, platform: "android", pins });
  assert.equal(foreign.length, 1);
  assert.match(foreign[0], /bundled for ios only/);

  const map = new Map(pins.map((p) => [p.name, p]));
  assert.equal(foreignPinFor(map, name), pins[0]);
  assert.equal(foreignPinFor(map, `public/${name}`), pins[0]);
  assert.equal(foreignPinFor(map, "public/weights/weight.bin"), undefined);
  assert.equal(foreignPinFor(new Map([["model.onnx", pins[0]]]), "public/deep/model.onnx"), pins[0], "flat pins still match by name");
});
