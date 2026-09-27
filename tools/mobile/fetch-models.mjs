#!/usr/bin/env node
/* tools/mobile/fetch-models.mjs — the Kokoro weights, pinned and verified.
 *
 * `docs/bundled-voice-plan.md` K-06(1): "pins `{url, sha256, bytes}` for the
 * model and each voice; CI fails on a mismatch." K-01's owned-files list names
 * this file as the thing that puts weights into a build without putting them
 * into the repository.
 *
 * ── The rule this file exists to enforce ──────────────────────────────────
 * LARGE BINARIES ARE NEVER COMMITTED (deck §9, the Shows-index release
 * pattern S-04b). The model is ~86 MB; `data/discover.json`, the largest thing
 * this repo ships, is 636 KB. A committed model would be in every clone, every
 * worktree and every one of this repo's ~950 checked-out files forever, and
 * git would keep it after the day it was replaced.
 *
 * ── Why a pin and not just a URL ──────────────────────────────────────────
 * Three separate failures, and the pin catches all three with one comparison:
 *   - the upstream repository re-uploads a file under the same name (Hugging
 *     Face allows it; the onnx-community repo has done it for other models);
 *   - a proxy or a CDN serves a truncated body with a 200;
 *   - somebody points the URL somewhere else in a PR.
 * The third is the one that matters for a file that is loaded and EXECUTED on
 * a listener's phone. `bytes` is pinned alongside `sha256` because a length
 * mismatch is detectable before the whole body has been read, and because the
 * two disagreeing is a different diagnosis from a hash mismatch alone.
 *
 * ── What runs this ────────────────────────────────────────────────────────
 * The `ios-shell` and `android-shell` jobs, one step each, added 2026-09-12
 * with the pins below (deck H3's `founder-approved` sitting). By hand:
 *
 *     node tools/mobile/fetch-models.mjs            # fetch + verify
 *     node tools/mobile/fetch-models.mjs --verify   # verify what is on disk
 *     node tools/mobile/fetch-models.mjs --check    # check the pins only (CI)
 *     node tools/mobile/fetch-models.mjs --bundled ios      # names the files an iOS build copies
 *     node tools/mobile/fetch-models.mjs --bundled android  # ... and an Android one
 *
 * `--check` is the mode CI can run with no download and no secret: it asserts
 * every pin is well-formed and internally consistent, which is what makes
 * "somebody edited the URL and not the hash" a red build rather than a
 * surprise at fetch time. `test/release-gates.test.js` runs the same
 * assertions in-process.
 *
 * ── The pins were FILLED on 2026-09-12, and here is exactly how ───────────
 * Until that date every `sha256` was `null`, because nobody in this repo had
 * downloaded the files and a hash copied out of a model card is an unlabelled
 * claim. The probe on Wyatt's phone could not produce a number without them,
 * so they were measured: each URL below was fetched once and STREAM-hashed —
 * the bytes went through `crypto.createHash("sha256")` chunk by chunk and were
 * never written to disk, so no 86 MB file entered a worktree at any point.
 * `bytes` is the streamed length. The 522,240 of a voice file is its own
 * check: 510 token-lengths x 256 floats x 4 bytes, exactly.
 *
 * A `null` pin still REFUSES TO FETCH — see `verifyBuffer` — so a pin added
 * later without a hash cannot ride along unverified.
 *
 * ── The fp32 pin was filled on 2026-09-26 (KV-R2), the same way, twice ────
 * `onnx/model.onnx` (325.5 MB) was stream-hashed on the founder's Windows PC
 * by two INDEPENDENT downloads — the first also written to the gitignored
 * `mobile/models/`, the second hashed and dropped — and the two agreed:
 *
 *     stream-hash 2026-09-27T02:23:35.590Z model.onnx sha256=8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb bytes=325532232 (504.0s) saved
 *     stream-hash 2026-09-27T02:31:53.696Z model.onnx sha256=8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb bytes=325532232 (497.3s)
 *
 * Two, because the card's stop rule is "two stream-hashes disagree": one
 * download proves only that one response was self-consistent.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");

/** Where fetched weights land. GITIGNORED — see `mobile/models/.gitignore`,
 *  written by this script's own `ensureIgnored()` so the directory cannot come
 *  into existence untracked-but-unignored, which is how a 86 MB file gets
 *  `git add -A`-ed by an agent in a hurry. */
export const MODELS_DIR = path.join("mobile", "models");

/**
 * THE PINS.
 *
 * `name` is the filename the native halves look for —
 * `ForayTtsPlugin.swift`'s `MODEL_RESOURCE` (iOS: the fp32 pin) and
 * `ForayTtsPlugin.java`'s `MODEL_ASSET` (Android: the q8f16 pin). Changing one
 * without the other is caught by `tools/mobile/fetch-models.test.mjs` and the
 * XCTest pin of the same name.
 *
 * `bundle` IS PER PLATFORM (KV-R2, deck D13): the list of platforms whose app
 * binary carries the file — `["ios"]`, `["android"]`, `["ios", "android"]`,
 * or `[]` for a workstation-only file. There is no implicit value and no
 * boolean: "goes into the app" stopped being one question the day the two
 * platforms stopped shipping the same model.
 *
 * WHY fp32 ON iOS, q8f16 ON ANDROID, AND NOTHING ELSE (deck §10b, D13).
 * The first answer here was q8f16 everywhere — 86 MB, the variant NimbleEdge
 * ships on phones — and it was a starting point, not a finding. The finding
 * came from an ARM64 sweep on GitHub's macos-14 Apple-silicon runners (ORT
 * 1.20.1 Python, 1.22.0 as a cross-check; runs 36280828928, 36281480135 and
 * 36282008323), on the probe passage and `af_heart`:
 *   - EVERY export with fp16 activations goes NON-FINITE on Apple silicon:
 *     `model_q8f16` (86 MB, the one we shipped) and `model_fp16` (163 MB) each
 *     returned NaN samples on one or two lines of four, on the CPU and the
 *     CoreML provider alike, and which lines varied with the ORT version. The
 *     x86 PC renders the same ids on the same file cleanly, which is why no
 *     workstation run ever caught it.
 *   - `model.onnx` (fp32, 325.5 MB) is finite on every line, at a CPU RTF of
 *     0.78–0.98 on a 3-vCPU M1 VM. Its peak RSS reached ~1.3 GB on the
 *     417-token line: activation memory scales with line length, which is why
 *     the probe passage is now sentence chunks.
 *   - The finite small variants are too slow (`model_quantized`, int8 dynamic:
 *     RTF ~1.8, ConvInteger is slow on ARM) or not small (`model_q4`: 305 MB,
 *     RTF ~1.0). No small, finite, fast export exists.
 * So iOS bundles fp32, over the 150 MB ceiling, for TestFlight only
 * (`test/release-gates.test.js` holds its own budget). ANDROID STAYS ON q8f16
 * because Play's base-module limit will not take 325 MB (fp32 there is KV-14,
 * via Play Asset Delivery) — and Android carries the SAME fp16 NaN risk, which
 * nobody has yet measured on an ARM Android phone; its probe reports
 * finiteness per chunk for exactly that reason.
 *
 * THE VOICES ARE THE AUDITION SLATE, twelve of them (deck §6), because K-03
 * renders all twelve and K-04 bundles only the three the founders pick. A
 * voice file is a 256-float style matrix per token length: ~130 KB each.
 */
/** The voice the probe (and only the probe) bundles. K-01 measures ONE voice:
 *  it times the graph, and the graph takes the same time whichever 256-float
 *  style vector it is handed. `af_heart` because it is the voice Wyatt already
 *  judged good in the acceptance fixture (deck §2) and the only A-grade voice
 *  on the slate. The other eleven are pinned for K-03's audition, which renders
 *  them on a workstation, and are NOT bundled — eleven unused voices would add
 *  5.5 MB to every install for a card that is not K-01. */
export const PROBE_VOICE = "af_heart";

/** The platforms a pin's `bundle` list may name — `inject-models.mjs`'s own
    `PLATFORMS` keys. */
export const BUNDLE_PLATFORMS = Object.freeze(["ios", "android"]);

export const PINS = Object.freeze([
  /* ANDROID's model (D13). Kept FIRST, and kept in this exact field order:
     `render-audition.py`'s `read_pins` parses this pin out of this file's
     text, and the PC audition renders q8f16, which is finite on x86. */
  Object.freeze({
    kind: "model",
    name: "kokoro-v1_0-q8f16.onnx",
    url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_q8f16.onnx",
    sha256: "04c658aec1b6008857c2ad10f8c589d4180d0ec427e7e6118ceb487e215c3cd0",
    bytes: 86033585,
    licence: "Apache-2.0",
    source: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX",
    bundle: Object.freeze(["android"]),
  }),
  /* iOS's model (D13, KV-R2): the fp32 export, the only one finite and near
     real time on Apple silicon. Hashed twice, independently — see the header. */
  Object.freeze({
    kind: "model",
    name: "kokoro-v1_0-fp32.onnx",
    url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model.onnx",
    sha256: "8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb",
    bytes: 325532232,
    licence: "Apache-2.0",
    source: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX",
    bundle: Object.freeze(["ios"]),
  }),
  ...[
    ["af_heart", "d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b", 522240],
    ["af_bella", "f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b", 522240],
    ["af_nicole", "cd2191ab31b914ed7b318416b0e4440fdf392ddad9106a060819aa600a64f59a", 522240],
    ["af_sarah", "4409fbc125afabacc615d94db5398d847006a737b0247d6892b7a9a0007a2f0a", 522240],
    ["af_kore", "9be5221b6a941c04b561959b8ff0b06e809444dcc4ab7e75a7b23606f691819e", 522240],
    ["af_aoede", "4a004c33430762e2461eedb2013fad808ef4ab3121f5300f554476caf58d8361", 522240],
    ["bf_emma", "669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73", 522240],
    ["am_michael", "1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1", 522240],
    ["am_fenrir", "c27989f741f7ee34d273a39d8a595cc0837d35f5ced9a29b7cc162614616df43", 522240],
    ["am_puck", "fcf73c989033e9233e0b98713eca600c8c74dcc1614b37009d5450ff4a2274a0", 522240],
    ["bm_george", "c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc", 522240],
    ["bm_fable", "f889083196807b4adb15e9204252165f503b8d33d3982e681c52443c49d798f1", 522240],
  ].map(([id, sha256, bytes]) => Object.freeze({
    kind: "voice",
    name: `${id}.bin`,
    url: `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/${id}.bin`,
    sha256,
    bytes,
    licence: "Apache-2.0",
    source: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX",
    /* The probe voice goes to BOTH apps; the other eleven to neither. */
    bundle: Object.freeze(id === PROBE_VOICE ? ["ios", "android"] : []),
  })),
  /* THE ID TABLE'S RECEIPT. `tools/narration/kokoro-vocab.json` is the
     phoneme-to-id table, committed because it is 3 KB and because
     `phonemize.py` needs it on any machine that authors a Foray. It was
     EXTRACTED from this file, and this pin is what makes that checkable: the
     committed table records the same sha256 and length, `kokoro-vocab.test.mjs`
     asserts the two agree, and `--fetch` re-downloads the file so the
     extraction can be repeated by hand.

     `bundle: []` — it never reaches a phone. The app receives ids and has
     no text to map; a table in the bundle would be the first step back towards
     a front end on the device, which is the thing deck §4 exists to prevent. */
  Object.freeze({
    kind: "tokenizer",
    name: "kokoro-tokenizer.json",
    url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/tokenizer.json",
    sha256: "77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34",
    bytes: 3497,
    licence: "Apache-2.0",
    source: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX",
    bundle: Object.freeze([]),
  }),
]);

/** The pins ONE PLATFORM's shell build copies into its app. Everything else is
    fetched for a workstation's use (the audition's eleven other voices, the
    tokenizer) or for the other platform, and stays out of this binary — which
    is what keeps each platform's size budget in `test/release-gates.test.js`
    honest rather than aspirational.

    THE PLATFORM IS REQUIRED. "Bundled" with no platform named has no answer
    since D13 (fp32 on iOS, q8f16 on Android), and the old no-argument form
    would have to guess one; an unknown platform throws rather than returning
    an empty list that a build would read as "ship nothing". */
export function bundledPins(platform, pins = PINS) {
  if (!BUNDLE_PLATFORMS.includes(platform)) {
    throw new Error(`bundledPins: unknown platform ${JSON.stringify(platform)} — expected one of ${BUNDLE_PLATFORMS.join(", ")}`);
  }
  return pins.filter((p) => Array.isArray(p.bundle) && p.bundle.includes(platform));
}

/** Total bytes ONE PLATFORM's build adds to its app. Exported so each size
    budget is checked against the real pinned lengths instead of estimates. */
export function bundledBytes(platform, pins = PINS) {
  return bundledPins(platform, pins).reduce((n, p) => n + (p.bytes ?? 0), 0);
}

/** The single command that turns a `null` pin into a real one. Printed rather
    than run: filling a pin is a deliberate act by somebody who then looks at
    what they downloaded. */
export function fillPinCommand(pin) {
  return `curl -fL "${pin.url}" -o "${MODELS_DIR}/${pin.name}" && ` +
    `node -e "const c=require('crypto'),f=require('fs');const b=f.readFileSync('${MODELS_DIR}/${pin.name}');` +
    `console.log(JSON.stringify({sha256:c.createHash('sha256').update(b).digest('hex'),bytes:b.length}))"`;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * Everything wrong with the pin table, as a list of sentences. Empty means
 * "the table is self-consistent", which is NOT the same as "the pins are
 * filled in" — `unfilled()` answers that separately, because CI must be able
 * to go red on a malformed pin today while a null pin is the known state.
 */
export function pinProblems(pins = PINS) {
  const problems = [];
  const seen = new Set();
  for (const p of pins) {
    const at = p && p.name ? p.name : "(unnamed pin)";
    if (!p || typeof p !== "object") { problems.push(`${at}: not an object`); continue; }
    if (typeof p.name !== "string" || !p.name) problems.push(`${at}: no name`);
    if (seen.has(p.name)) problems.push(`${at}: named twice — a second pin would overwrite the first on disk`);
    seen.add(p.name);
    if (p.name && (p.name.includes("/") || p.name.includes("\\") || p.name.includes(".."))) {
      /* A pin's name becomes a path under `mobile/models/`. A `..` in it writes
         outside the directory, and this file's whole job is to be the one place
         a remote URL is allowed to decide what lands on disk. */
      problems.push(`${at}: a name may not contain a path separator or ".."`);
    }
    if (typeof p.url !== "string" || !/^https:\/\//.test(p.url)) {
      problems.push(`${at}: url must be https (got ${JSON.stringify(p.url)})`);
    }
    if (p.sha256 !== null && !SHA256_RE.test(String(p.sha256))) {
      problems.push(`${at}: sha256 must be 64 lowercase hex characters or null`);
    }
    if (p.bytes !== null && !(Number.isInteger(p.bytes) && p.bytes > 0)) {
      problems.push(`${at}: bytes must be a positive integer or null`);
    }
    /* THE HALF-PINNED CASE IS THE ONE THAT MATTERS. A pin with bytes and no
       hash looks filled in at a glance and verifies nothing about content. */
    if ((p.sha256 === null) !== (p.bytes === null)) {
      problems.push(`${at}: sha256 and bytes must be pinned together — a half-pin verifies nothing`);
    }
    /* `bundle` decides whether a 86–326 MB file goes into an app store
       binary, and since D13 it answers that PER PLATFORM. A pin that merely
       FORGOT the field would default to falsy and silently stop shipping the
       model — the probe would then answer `model-absent` on a build that
       fetched everything correctly. Required, and a LIST of known platforms
       (`[]` for none), so the omission is the error. A bare `true` is refused
       too: it used to mean "both", and "both" is now a thing a pin has to say. */
    if (!Array.isArray(p.bundle)) {
      problems.push(`${at}: bundle must be a list of platforms (${BUNDLE_PLATFORMS.map((x) => `"${x}"`).join(", ")}, or [] for none) — "goes into the app" is never left implicit`);
    } else {
      for (const platform of p.bundle) {
        if (!BUNDLE_PLATFORMS.includes(platform)) problems.push(`${at}: bundle names an unknown platform ${JSON.stringify(platform)}`);
      }
      if (new Set(p.bundle).size !== p.bundle.length) problems.push(`${at}: bundle names a platform twice`);
    }
    if (typeof p.licence !== "string" || !p.licence) problems.push(`${at}: no licence recorded`);
    if (typeof p.source !== "string" || !/^https:\/\//.test(p.source || "")) {
      problems.push(`${at}: no https source recorded for the licence claim`);
    }
  }
  return problems;
}

/** The pins nobody has hashed yet. */
export function unfilled(pins = PINS) {
  return pins.filter((p) => p.sha256 === null);
}

/** sha256 of a buffer, lowercase hex. */
export function digest(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Does this buffer match this pin? Returns `{ ok, reason }`.
 *
 * A NULL PIN NEVER MATCHES. That is the load-bearing line in this file: the
 * tempting shape is "no pin recorded, so nothing to check", and that shape
 * ships an unverified 86 MB binary into an app store the first time somebody
 * adds a URL and forgets the hash.
 */
export function verifyBuffer(pin, buf) {
  if (!pin || pin.sha256 === null || pin.bytes === null) {
    return { ok: false, reason: `${pin?.name ?? "?"} has no sha256/bytes pin — refusing to accept it unverified` };
  }
  if (buf.length !== pin.bytes) {
    return { ok: false, reason: `${pin.name}: ${buf.length} bytes, pinned ${pin.bytes}` };
  }
  const got = digest(buf);
  if (got !== pin.sha256) {
    return { ok: false, reason: `${pin.name}: sha256 ${got}, pinned ${pin.sha256}` };
  }
  return { ok: true, reason: "" };
}

/** `mobile/models/` exists and is ignored. Written every run, because the
    directory is gitignored and therefore cannot itself carry the file in a
    fresh clone. */
export function ensureIgnored(root = REPO_ROOT) {
  const dir = path.join(root, MODELS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  const body = "# Fetched by tools/mobile/fetch-models.mjs against a pinned sha256.\n"
    + "# NEVER COMMITTED: the Kokoro models are 86 MB (q8f16) and 326 MB (fp32) (docs/bundled-voice-plan.md K-06).\n"
    + "*\n!.gitignore\n";
  if (!fs.existsSync(ignore) || fs.readFileSync(ignore, "utf8") !== body) {
    fs.writeFileSync(ignore, body);
  }
  return dir;
}

/** Verify what is already on disk. Used by `--verify` and by the fetch path
    after a download, so there is one implementation of "is this file right". */
export function verifyOnDisk(pins = PINS, root = REPO_ROOT) {
  const results = [];
  for (const pin of pins) {
    const abs = path.join(root, MODELS_DIR, pin.name);
    if (!fs.existsSync(abs)) { results.push({ pin, ok: false, reason: `${pin.name}: not fetched` }); continue; }
    results.push({ pin, ...verifyBuffer(pin, fs.readFileSync(abs)) });
  }
  return results;
}

/* --------------------------------------------------------------------- main */

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) { main(); }

/* Wrapped in a function rather than run at module scope so this file carries NO
   top-level await: `test/release-gates.test.js` is a CommonJS suite and imports
   the pin table, and a module with top-level await cannot be required. */
/** Download attempts per pin, and the linear backoff step between them. */
export const FETCH_ATTEMPTS = 4;
const FETCH_BACKOFF_MS = 10_000;

async function main() {
  const mode = process.argv[2] ?? "--fetch";
  const problems = pinProblems();
  if (problems.length) {
    console.error("The model pin table is malformed:");
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  const missing = unfilled();
  if (mode === "--bundled") {
    /* One filename per line, for a build step to read. Deliberately NOT a glob
       over `mobile/models/` in the workflow: the fetch pulls twelve voices and
       a tokenizer that must NOT reach the binary, and a `cp mobile/models/*`
       would ship all of them. The decision belongs to the pin table, in the
       same file as the hashes, where a reviewer sees both at once.
       Per platform since D13: an iOS build and an Android build carry
       different models. */
    const platform = process.argv[3];
    if (!BUNDLE_PLATFORMS.includes(platform)) {
      console.error(`Usage: node tools/mobile/fetch-models.mjs --bundled <${BUNDLE_PLATFORMS.join("|")}>`);
      process.exit(2);
    }
    for (const pin of bundledPins(platform)) console.log(pin.name);
    process.exit(0);
  }
  if (mode === "--check") {
    console.log(`${PINS.length} pins, all well-formed.`);
    /* One line PER PLATFORM (KV-R2's CI evidence): the iOS app carries fp32,
       the APK q8f16, and a log that summed them would describe neither. */
    for (const platform of BUNDLE_PLATFORMS) {
      const names = bundledPins(platform).map((p) => p.name);
      console.log(`${platform}: ${names.length} bundled (${names.join(", ")}): `
        + `${(bundledBytes(platform) / (1024 * 1024)).toFixed(1)} MiB.`);
    }
    if (missing.length) {
      console.log(`${missing.length} of them carry no sha256 yet. Fill one with:`);
      console.log(`  ${fillPinCommand(missing[0])}`);
      console.log("Then paste the sha256/bytes into PINS in this file.");
    }
    process.exit(0);
  }
  if (missing.length) {
    console.error(`Refusing to ${mode === "--verify" ? "verify" : "fetch"}: ${missing.length} of ${PINS.length} pins have no sha256.`);
    console.error("A model that is executed on a listener's phone is never accepted unverified.");
    console.error(`Fill the first one with:\n  ${fillPinCommand(missing[0])}`);
    process.exit(1);
  }
  ensureIgnored();
  if (mode === "--verify") {
    const bad = verifyOnDisk().filter((r) => !r.ok);
    for (const r of bad) console.error(`  ${r.reason}`);
    process.exit(bad.length ? 1 : 0);
  }
  if (mode !== "--fetch") {
    console.error(`Unknown argument: ${mode}`);
    console.error("Usage: node tools/mobile/fetch-models.mjs [--fetch [ios|android]|--verify|--check|--bundled <ios|android>]");
    process.exit(2);
  }
  /* `--fetch <ios|android>` fetches only what that platform bundles. A shell
     or release build needs two files, not the audition's twelve voices — and
     every extra download is one more chance for Hugging Face to answer 504,
     which is what failed release 36295569334 (2026-09-27). Bare `--fetch`
     still fetches every pin, for a workstation. */
  const platform = process.argv[3];
  if (platform !== undefined && !BUNDLE_PLATFORMS.includes(platform)) {
    console.error(`--fetch takes an optional platform (${BUNDLE_PLATFORMS.join("|")}), not ${JSON.stringify(platform)}`);
    process.exit(2);
  }
  const wanted = platform === undefined ? PINS : bundledPins(platform);
  const dir = path.join(REPO_ROOT, MODELS_DIR);
  let failed = 0;
  for (const pin of wanted) {
    const abs = path.join(dir, pin.name);
    if (fs.existsSync(abs) && verifyBuffer(pin, fs.readFileSync(abs)).ok) continue;
    /* RETRIED: a 5xx or a dropped connection is the CDN, not the pin. A hash
       mismatch is retried too (a truncated body), but never accepted. */
    let last = "";
    let buf = null;
    for (let attempt = 1; attempt <= FETCH_ATTEMPTS && !buf; attempt++) {
      try {
        const res = await fetch(pin.url);
        if (!res.ok) { last = `HTTP ${res.status}`; }
        else {
          const got = Buffer.from(await res.arrayBuffer());
          const check = verifyBuffer(pin, got);
          if (check.ok) buf = got; else last = check.reason;
        }
      } catch (e) {
        last = `network: ${e?.message ?? e}`;
      }
      if (!buf && attempt < FETCH_ATTEMPTS) {
        console.error(`  ${pin.name}: ${last} (attempt ${attempt} of ${FETCH_ATTEMPTS}); retrying`);
        await new Promise((r) => setTimeout(r, FETCH_BACKOFF_MS * attempt));
      }
    }
    if (!buf) { console.error(`  ${pin.name}: ${last}`); failed++; continue; }
    fs.writeFileSync(abs, buf);
    console.log(`  ${pin.name}  ${buf.length} bytes  ok`);
  }
  process.exit(failed ? 1 : 0);
}
