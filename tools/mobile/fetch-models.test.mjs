/* K-06(1): the model pin table, and the refusal that makes it worth having.
 *
 * `docs/bundled-voice-plan.md` K-06: "`tools/mobile/fetch-models.mjs` pins
 * `{url, sha256, bytes}` for the model and each voice; CI fails on a
 * mismatch."
 *
 * WHAT THIS SUITE IS FOR, stated once. The file it covers downloads ~88 MB of
 * weights that are then EXECUTED on a listener's phone. There is exactly one
 * thing standing between "the upstream repository re-uploaded this file" and
 * "our app runs whatever is now at that URL", and it is a hash comparison.
 * Every test below is a mutation of that comparison or of the table it reads.
 *
 * NOTHING HERE DOWNLOADS ANYTHING. `verifyBuffer` is pure and takes a buffer;
 * `verifyOnDisk` reads a directory a test builds. A suite that hit the network
 * would be a suite that goes red when Hugging Face is slow, which is the fastest
 * way to teach a team to ignore it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PINS, MODELS_DIR, pinProblems, unfilled, verifyBuffer, verifyOnDisk,
  digest, ensureIgnored, fillPinCommand, bundledPins, bundledBytes, PROBE_VOICE, BUNDLE_PLATFORMS,
} from "./fetch-models.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "foray-models-"));

/* ---------- the table ---------- */

test("the shipped pin table is self-consistent", () => {
  assert.deepEqual(pinProblems(), [], "PINS in fetch-models.mjs is malformed");
});

/** MUTATION: make `pinProblems` return `[]` unconditionally — every one of the
    six malformation tests below goes red at once, which is the point of
    keeping them separate from the "real table is fine" test above. */
test("a pin whose url is not https is a problem", () => {
  const bad = [{ ...PINS[0], url: "http://example.invalid/model.onnx" }];
  assert.match(pinProblems(bad).join("\n"), /url must be https/);
});

test("a pin whose name would escape mobile/models is a problem", () => {
  /* MUTATION: drop the `..`/separator check in `pinProblems` — this goes red.
     A pin name becomes a path under `mobile/models/`, so this is the one field
     where a remote URL's own repository gets to influence where bytes land. */
  for (const name of ["../app.js", "sub/dir.onnx", "a\\b.onnx"]) {
    assert.match(pinProblems([{ ...PINS[0], name }]).join("\n"), /path separator or "\.\."/,
      `"${name}" must be rejected`);
  }
});

test("a half-pin — bytes without sha256, or the reverse — is a problem", () => {
  /* THE ONE THAT LOOKS FILLED IN. A pin carrying a byte length and no hash
     passes a glance and verifies nothing about content.
     MUTATION: delete the `(p.sha256 === null) !== (p.bytes === null)` clause. */
  const halfA = [{ ...PINS[0], sha256: null, bytes: 12345 }];
  const halfB = [{ ...PINS[0], sha256: "a".repeat(64), bytes: null }];
  assert.match(pinProblems(halfA).join("\n"), /must be pinned together/);
  assert.match(pinProblems(halfB).join("\n"), /must be pinned together/);
});

test("a malformed sha256 is a problem, and a correct one is not", () => {
  /* MUTATION: loosen SHA256_RE to /^[0-9a-f]+$/ — the 63-character case passes
     and this goes red. Length matters: a truncated hash compared with `===`
     never matches anything, so the failure would be "every fetch is refused",
     diagnosed days later. */
  assert.match(pinProblems([{ ...PINS[0], sha256: "A".repeat(64), bytes: 1 }]).join("\n"), /64 lowercase hex/);
  assert.match(pinProblems([{ ...PINS[0], sha256: "a".repeat(63), bytes: 1 }]).join("\n"), /64 lowercase hex/);
  assert.deepEqual(pinProblems([{ ...PINS[0], sha256: "a".repeat(64), bytes: 1 }]), []);
});

test("a pin with no recorded licence or no https source is a problem", () => {
  /* K-06(4) — the THIRD_PARTY_NOTICES entry is written FROM this table, so a
     pin with no licence recorded is a notice that cannot be written.
     MUTATION: drop either licence check. */
  assert.match(pinProblems([{ ...PINS[0], licence: "" }]).join("\n"), /no licence recorded/);
  assert.match(pinProblems([{ ...PINS[0], source: "not-a-url" }]).join("\n"), /no https source/);
});

test("two pins with the same name are a problem", () => {
  /* MUTATION: drop the `seen` set — the second write silently overwrites the
     first on disk and the build ships one file where it thinks it has two. */
  assert.match(pinProblems([PINS[0], { ...PINS[0] }]).join("\n"), /named twice/);
});

/* ---------- the slate ---------- */

test("the table pins two models (q8f16, fp32) and the twelve audition voices", () => {
  /* Deck §6's slate is twelve, and K-04 bundles three of them. A table that
     drifted to eleven would silently drop a voice the founders were asked to
     rank. MUTATION: remove one id from the voice list in fetch-models.mjs.

     TWO MODELS SINCE KV-R2 (D13): q8f16 for Android, and the fp32 export for
     iOS, because every fp16-activation export goes NaN on Apple silicon. The
     q8f16 pin stays FIRST: `render-audition.py`'s `read_pins` reads it by
     name and `kokoro-probe.test.js` finds each platform's pin by bundle. */
  const models = PINS.filter((p) => p.kind === "model");
  const voices = PINS.filter((p) => p.kind === "voice");
  assert.equal(models.length, 2, "one model per platform");
  assert.equal(voices.length, 12, "deck §6's slate is twelve voices");
  assert.equal(models[0].name, "kokoro-v1_0-q8f16.onnx");
  assert.equal(PINS[0], models[0], "q8f16 is still the table's first pin");
  assert.equal(models[1].name, "kokoro-v1_0-fp32.onnx");
  assert.match(models[1].url, /\/resolve\/main\/onnx\/model\.onnx$/, "fp32 is the export's plain model.onnx");
  /* The streamed length and digest of two independent downloads (header). A
     different number here is a different file, whatever the name says. */
  assert.equal(models[1].bytes, 325532232);
  assert.equal(models[1].sha256, "8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb");
  for (const want of ["af_heart.bin", "af_bella.bin", "bm_fable.bin"]) {
    assert.ok(voices.some((v) => v.name === want), `${want} is in the slate`);
  }
});

test("each platform's model filename matches what that platform's native half looks for", () => {
  /* THE CROSS-TREE PIN. `ForayTtsPlugin.swift` looks up MODEL_RESOURCE +
     MODEL_EXTENSION; `ForayTtsPlugin.java` looks up MODEL_ASSET. Nothing but
     this test connects a build script's output filename to two native lookups
     in two languages — and a mismatch reports as `model-absent`, which reads
     exactly like "the build skipped the fetch". Since D13 each half looks for
     ITS platform's model: fp32 on iOS, q8f16 on Android.
     MUTATION: rename a pin without renaming its constant, or point Swift back
     at q8f16. */
  const modelFor = (platform) => bundledPins(platform).filter((p) => p.kind === "model");
  const [ios] = modelFor("ios");
  const [android] = modelFor("android");
  const swift = fs.readFileSync(
    path.join(REPO, "mobile/plugins/foray-tts/ios/Sources/ForayTtsPlugin/ForayTtsPlugin.swift"), "utf8");
  const java = fs.readFileSync(
    path.join(REPO, "mobile/plugins/foray-tts/android/src/main/java/ai/jwlabs/foura/tts/ForayTtsPlugin.java"), "utf8");
  const base = ios.name.replace(/\.onnx$/, "");
  assert.ok(swift.includes(`MODEL_RESOURCE = "${base}"`), `Swift must look for ${base}`);
  assert.ok(swift.includes('MODEL_EXTENSION = "onnx"'));
  assert.ok(java.includes(`MODEL_ASSET = "${android.name}"`), `Java must look for ${android.name}`);
});

/* ---------- the refusal ---------- */

test("an unpinned entry NEVER verifies, however right the bytes are", () => {
  /* THE LOAD-BEARING TEST IN THIS FILE. The tempting shape is "no pin
     recorded, so nothing to check" — and that shape ships an unverified 86 MB
     executable to an app store the first time somebody adds a URL and forgets
     the hash.
     MUTATION: make `verifyBuffer` return `{ ok: true }` when `pin.sha256 ===
     null`. This goes red; nothing else in the repo would notice. */
  const buf = Buffer.from("anything at all");
  const res = verifyBuffer({ name: "x.onnx", sha256: null, bytes: null }, buf);
  assert.equal(res.ok, false);
  assert.match(res.reason, /refusing to accept it unverified/);
});

test("verifyBuffer accepts only the exact bytes and the exact hash", () => {
  const buf = Buffer.from("kokoro weights, pretend");
  const pin = { name: "k.onnx", sha256: digest(buf), bytes: buf.length };
  assert.equal(verifyBuffer(pin, buf).ok, true);
  /* MUTATION: compare `buf.length >= pin.bytes` instead of `===` — a padded
     body passes. */
  assert.match(verifyBuffer(pin, Buffer.concat([buf, Buffer.from("!")])).reason, /bytes, pinned/);
  /* MUTATION: compare the first 8 hex characters instead of the whole digest. */
  assert.match(verifyBuffer({ ...pin, sha256: "b".repeat(64) }, buf).reason, /sha256 /);
});

test("every pin is filled, and the fill command is still printable for the next one", () => {
  /* THIS TEST WAS INVERTED ON 2026-09-12. It used to assert
     `unfilled().length === PINS.length` with the note "if a future PR fills
     the pins, this test is the one that has to be updated, in a diff that says
     who downloaded what". This is that diff.

     WHO DOWNLOADED WHAT: every URL in the table was fetched once from a
     Windows workstation and STREAM-hashed — `crypto.createHash("sha256")` over
     the response body chunk by chunk, with nothing written to disk, so no
     86 MB file ever entered a worktree. `bytes` is the streamed length.

     The voice lengths are self-checking and that is why they are asserted
     here rather than taken on trust: 522,240 = 510 token-lengths x 256 floats
     x 4 bytes, which is the style matrix's documented shape. A voice file of
     any other length is not a Kokoro v1.0 voice.
     MUTATION: null one pin's sha256 — the fetch path refuses again, and a
     build that used to produce weights silently stops. */
  assert.equal(unfilled().length, 0, "an unfilled pin cannot be fetched at all");
  for (const p of PINS) {
    assert.match(p.sha256, /^[0-9a-f]{64}$/, `${p.name}: no measured digest`);
    assert.ok(Number.isInteger(p.bytes) && p.bytes > 0, `${p.name}: no measured length`);
  }
  for (const v of PINS.filter((p) => p.kind === "voice")) {
    assert.equal(v.bytes, 510 * 256 * 4, `${v.name} is not shaped like a Kokoro style matrix`);
  }
  assert.match(fillPinCommand(PINS[0]), /^curl -fL "https:\/\/huggingface\.co\//);
  assert.match(fillPinCommand(PINS[0]), /sha256/);
});

test("each app bundles its own model and ONE voice, and nothing else", () => {
  /* The size budget is enforced by what `bundle` says, not by what a
     workflow's glob happens to match. Twelve voices are pinned because K-03's
     audition renders twelve; eleven of them have no business in an app store
     binary, and the tokenizer has no business on a phone at all (deck §4: no
     text front end on the device).
     MUTATION: add a platform to a second voice's `bundle` — that platform's
     byte count moves and this goes red before the .ipa does. */
  assert.deepEqual(bundledPins("ios").map((p) => p.name), ["kokoro-v1_0-fp32.onnx", `${PROBE_VOICE}.bin`]);
  assert.deepEqual(bundledPins("android").map((p) => p.name), ["kokoro-v1_0-q8f16.onnx", `${PROBE_VOICE}.bin`]);
  assert.equal(bundledBytes("ios"), 325532232 + 522240);
  assert.equal(bundledBytes("android"), 86033585 + 522240);
  for (const p of PINS.filter((p) => p.kind === "tokenizer")) {
    assert.deepEqual([...p.bundle], [], "the id table never ships to a phone");
  }
});

test("fp32 is bundled on iOS only and q8f16 on Android only", () => {
  /* D13, both halves. fp32 is 325.5 MB: in an APK it breaks Android's 150 MB
     ceiling and Play's base-module limit. q8f16 goes NaN on Apple silicon: in
     the iOS app it is 86 MB of a model the phone cannot sing with, beside the
     one it can. And the probe voice is in both, or one probe has no voice.
     MUTATION: bundle fp32 on Android (`bundle: ["ios", "android"]`) — red.
     MUTATION: bundle q8f16 on iOS — red. */
  const byName = (name) => PINS.find((p) => p.name === name);
  assert.deepEqual([...byName("kokoro-v1_0-fp32.onnx").bundle], ["ios"]);
  assert.deepEqual([...byName("kokoro-v1_0-q8f16.onnx").bundle], ["android"]);
  assert.deepEqual([...byName(`${PROBE_VOICE}.bin`).bundle].sort(), ["android", "ios"]);
  assert.ok(!bundledPins("android").some((p) => p.name === "kokoro-v1_0-fp32.onnx"), "fp32 never reaches the APK");
  assert.ok(!bundledPins("ios").some((p) => p.name === "kokoro-v1_0-q8f16.onnx"), "q8f16 never reaches the iOS app");
  assert.equal(bundledPins("ios").filter((p) => p.kind === "model").length, 1, "one model per app");
  assert.equal(bundledPins("android").filter((p) => p.kind === "model").length, 1, "one model per app");
});

test("a pin with an implicit bundle value is refused", () => {
  /* The dangerous default is falsy: a model pin whose `bundle` was dropped in
     a rebase would stop being copied, the app would ship without weights, and
     the probe would answer `model-absent` — which reads as "the build did not
     fetch the weights" and sends a founder to look at the wrong thing. A bare
     `true` is refused as well: it meant "both apps" before D13, and a pin that
     still says it has not been told which model each app carries.
     MUTATION: fall back to `p.bundle ?? []` in `pinProblems`, or accept
     `true` as "every platform". */
  const { bundle, ...noBundle } = PINS[0];
  const refused = /bundle must be a list of platforms/;
  assert.match(pinProblems([noBundle]).join("\n"), refused);
  assert.match(pinProblems([{ ...PINS[0], bundle: true }]).join("\n"), refused);
  assert.match(pinProblems([{ ...PINS[0], bundle: false }]).join("\n"), refused);
  assert.match(pinProblems([{ ...PINS[0], bundle: "ios" }]).join("\n"), refused);
  assert.match(pinProblems([{ ...PINS[0], bundle: ["web"] }]).join("\n"), /unknown platform "web"/);
  assert.match(pinProblems([{ ...PINS[0], bundle: ["ios", "ios"] }]).join("\n"), /platform twice/);
  assert.deepEqual(pinProblems([{ ...PINS[0], bundle: [] }]), [], "[] is an explicit 'none'");
  /* And a caller cannot ask "bundled?" without naming the platform. */
  assert.throws(() => bundledPins(), /unknown platform/);
  assert.throws(() => bundledPins("web"), /unknown platform/);
  assert.deepEqual([...BUNDLE_PLATFORMS], ["ios", "android"]);
});

/* ---------- the directory ---------- */

test("verifyOnDisk reports a missing file as not fetched, not as ok", () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, MODELS_DIR), { recursive: true });
  const pin = { name: "k.onnx", sha256: "a".repeat(64), bytes: 3, licence: "x", source: "https://x/" };
  const [r] = verifyOnDisk([pin], root);
  /* MUTATION: treat `!fs.existsSync` as `ok: true` ("nothing to check"). */
  assert.equal(r.ok, false);
  assert.match(r.reason, /not fetched/);
});

test("verifyOnDisk accepts a file that matches and rejects one that does not", () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, MODELS_DIR), { recursive: true });
  const body = Buffer.from("weights");
  fs.writeFileSync(path.join(root, MODELS_DIR, "k.onnx"), body);
  const good = { name: "k.onnx", sha256: digest(body), bytes: body.length };
  assert.equal(verifyOnDisk([good], root)[0].ok, true);
  const wrong = { ...good, sha256: digest(Buffer.from("other")) };
  assert.equal(verifyOnDisk([wrong], root)[0].ok, false);
});

test("the models directory ignores everything but its own .gitignore", () => {
  /* A 86 MB file in an untracked-but-unignored directory is one `git add -A`
     away from the history, and git keeps it after the day it is replaced.
     MUTATION: drop the `*` line from the written body — this goes red. */
  const root = tmp();
  const dir = ensureIgnored(root);
  const body = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
  assert.match(body, /^\*$/m, "everything is ignored");
  assert.match(body, /^!\.gitignore$/m, "except the ignore file itself");
  assert.equal(path.relative(root, dir).split(path.sep).join("/"), "mobile/models");
});

test("nothing model-shaped is committed to the repository", () => {
  /* The rule the whole file exists for (deck §9), asserted against the real
     tree rather than against intent. Walks `mobile/` because that is where a
     fetched model would land; the web bundle's own gate is
     `prepare-webdir.mjs`'s `assertNoModelWeights`.
     MUTATION: commit a `.onnx` under `mobile/` — this goes red. */
  const exts = [".onnx", ".onnx_data", ".ort", ".gguf", ".safetensors", ".pt"];
  const offenders = [];
  const walk = (rel) => {
    /* `mobile/models/` is the fetch's own landing directory, and everything in
       it is IGNORED by the `.gitignore` the test above pins, so a file there is
       fetched, not committed. Skipped so that a workstation that ran the fetch
       (KV-R2's did: the 325 MB fp32 file lives there) can still run this. */
    if (rel === MODELS_DIR.split(path.sep).join("/")) return;
    const abs = path.join(REPO, rel);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const next = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(next);
      else if (exts.some((x) => e.name.toLowerCase().endsWith(x))) offenders.push(next);
    }
  };
  walk("mobile");
  assert.deepEqual(offenders, [], "model weights are fetched, never committed");
});
