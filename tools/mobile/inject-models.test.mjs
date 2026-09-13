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
import { inject, check, defaultDestFor, PLATFORMS } from "./inject-models.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "foray-inject-models-"));

/** A pin table with real hashes over tiny bodies, so the copy path can be
    exercised end to end without an 82 MB download. The SHAPE is what is under
    test — which files move, where, and what happens when one is wrong. */
function fixture() {
  const bodies = {
    "model.onnx": Buffer.from("weights, pretend"),
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
    pins: [pin("model.onnx", true), pin("voice.bin", true), pin("tokenizer.json", false)],
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
  const { copied, problems } = inject({ dest, root, pins });
  assert.deepEqual(problems, []);
  assert.deepEqual(copied.map((c) => c.name).sort(), ["model.onnx", "voice.bin"]);
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
  const { copied, problems } = inject({ dest, root, pins });
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
  const { problems } = inject({ dest: path.join(tmp(), "out"), root, pins });
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
  assert.equal(check({ dest, pins }).length, 2, "an empty destination is two missing files");
  inject({ dest, root, pins });
  assert.deepEqual(check({ dest, pins }), []);
  fs.writeFileSync(path.join(dest, "voice.bin"), Buffer.from("truncated"));
  assert.match(check({ dest, pins }).join("\n"), /voice\.bin/);
});

/* ---------- the real table ---------- */

test("the real table bundles exactly the two files both native halves name", () => {
  /* The filenames are spelled in four places — the pin table, the Swift
     constants, the Java constants and this script's output. Three of the four
     are pinned against each other elsewhere; this is the fourth.
     MUTATION: rename the voice pin without renaming `VOICE_RESOURCE`. */
  const names = bundledPins(PINS).map((p) => p.name);
  assert.deepEqual(names, ["kokoro-v1_0-q8f16.onnx", "af_heart.bin"]);
  const root = path.join(import.meta.dirname, "..", "..");
  const swift = fs.readFileSync(
    path.join(root, "mobile/plugins/foray-tts/ios/Sources/ForayTtsPlugin/ForayTtsPlugin.swift"), "utf8");
  assert.match(swift, /VOICE_RESOURCE\s*=\s*"af_heart"/);
  const java = fs.readFileSync(
    path.join(root, "mobile/plugins/foray-tts/android/src/main/java/ai/jwlabs/foura/tts/KokoroOrtProbeEngine.java"),
    "utf8");
  assert.match(java, /VOICE_ASSET\s*=\s*"af_heart\.bin"/);
});
