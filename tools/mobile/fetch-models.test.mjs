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
  digest, ensureIgnored, fillPinCommand,
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

test("the table pins the q8f16 model and the twelve audition voices", () => {
  /* Deck §6's slate is twelve, and K-04 bundles three of them. A table that
     drifted to eleven would silently drop a voice the founders were asked to
     rank. MUTATION: remove one id from the voice list in fetch-models.mjs. */
  const models = PINS.filter((p) => p.kind === "model");
  const voices = PINS.filter((p) => p.kind === "voice");
  assert.equal(models.length, 1, "one model");
  assert.equal(voices.length, 12, "deck §6's slate is twelve voices");
  assert.equal(models[0].name, "kokoro-v1_0-q8f16.onnx");
  for (const want of ["af_heart.bin", "af_bella.bin", "bm_fable.bin"]) {
    assert.ok(voices.some((v) => v.name === want), `${want} is in the slate`);
  }
});

test("the model filename matches what both native halves look for", () => {
  /* THE CROSS-TREE PIN. `ForayTtsPlugin.swift` looks up MODEL_RESOURCE +
     MODEL_EXTENSION; `ForayTtsPlugin.java` looks up MODEL_ASSET. Nothing but
     this test connects a build script's output filename to two native lookups
     in two languages — and a mismatch reports as `model-absent`, which reads
     exactly like "the build skipped the fetch".
     MUTATION: rename the pin without renaming either constant. */
  const model = PINS.find((p) => p.kind === "model");
  const swift = fs.readFileSync(
    path.join(REPO, "mobile/plugins/foray-tts/ios/Sources/ForayTtsPlugin/ForayTtsPlugin.swift"), "utf8");
  const java = fs.readFileSync(
    path.join(REPO, "mobile/plugins/foray-tts/android/src/main/java/ai/jwlabs/foura/tts/ForayTtsPlugin.java"), "utf8");
  const base = model.name.replace(/\.onnx$/, "");
  assert.ok(swift.includes(`MODEL_RESOURCE = "${base}"`), `Swift must look for ${base}`);
  assert.ok(swift.includes('MODEL_EXTENSION = "onnx"'));
  assert.ok(java.includes(`MODEL_ASSET = "${model.name}"`), `Java must look for ${model.name}`);
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

test("the shipped table is honestly unfilled, and says how to fill it", () => {
  /* Nobody in this repo has hashed these files (the module header says so).
     This test pins that the state is DECLARED rather than faked: if a future
     PR fills the pins, this test is the one that has to be updated, in a diff
     that says who downloaded what.
     MUTATION: replace a `sha256: null` with a plausible-looking hex string —
     this goes red, and so does the "refuses to fetch" behaviour it protects. */
  assert.equal(unfilled().length, PINS.length, "no pin has been hashed by anyone here yet");
  assert.match(fillPinCommand(PINS[0]), /^curl -fL "https:\/\/huggingface\.co\//);
  assert.match(fillPinCommand(PINS[0]), /sha256/);
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
