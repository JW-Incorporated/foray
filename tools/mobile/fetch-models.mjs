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
 * NO SHELL BUILD, SINCE CH-20 (docs/roadmap/code-health.md, N1-03; founder
 * ruling on issue #1076, 2026-10-05: "Remove it all"). From 2026-09-12 the
 * `ios-shell`/`android-shell` jobs and both release composites fetched the
 * bundled pins and copied them into the apps for the on-device Kokoro probe;
 * the probe is gone, and CH2-23 (docs/roadmap/code-health-2.md, T2-12) then
 * deleted the per-platform `bundle` lists, `--bundled` and `--fetch <platform>`,
 * which could only answer "nothing". No build path calls this file
 * (`test/release-gates.test.js` scans every composite action and both build
 * workflows for it). What still reads it: `render-narration.yml` runs `--check`,
 * and the central narration tools (`tools/narration/render-foray.py`,
 * `render-audition.py`, `bench-narration.py`) parse the model and voice pins
 * out of this file's text, so the hashes live in ONE table. By hand:
 *
 *     node tools/mobile/fetch-models.mjs            # fetch + verify
 *     node tools/mobile/fetch-models.mjs --verify   # verify what is on disk
 *     node tools/mobile/fetch-models.mjs --check    # check the pins only (CI)
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
 * claim. The (since removed) probe on Wyatt's phone could not produce a number
 * without them, so they were measured: each URL below was fetched once and STREAM-hashed —
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
 *
 * ── The Core ML pins are gone (CH-20) ─────────────────────────────────────
 * KV-R3 (2026-09-27) pinned the 34 files of FluidInference's seven-stage
 * Core ML chain for the iOS probe build only. Nothing outside the deleted
 * probe ever read them (render-narration.yml names none), so they left with
 * it; git history has the hashes and how they were measured.
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
 * `name` is the filename under `mobile/models/` (and, until CH-20, the name
 * the on-device probe looked the bundled file up by). The narration tools
 * find the model pins by it, so it is not cosmetic.
 *
 * NO PIN GOES INTO AN APP. Until CH2-23 every pin carried a per-platform
 * `bundle` list (KV-R2, deck D13), each `[]` since CH-20; the lists, and the
 * `--bundled` answer they fed, are deleted. Shipping weights again is a
 * founder ruling (issue #1076 is the one that took them out) plus a build
 * step, and `test/release-gates.test.js` goes red on any build path that
 * names this file.
 *
 * WHY fp32 ON iOS, q8f16 ON ANDROID (deck §10b, D13), kept as the record of
 * the probe-era choice. The first answer here was q8f16 everywhere — 86 MB,
 * the variant NimbleEdge ships on phones — and it was a starting point, not a
 * finding. The finding
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
 * So the iOS probe build bundled fp32 and Android q8f16 (Play's base-module
 * limit will not take 325 MB). Central narration renders fp32 on a CPU
 * (`tools/narration/render-profile.json`), where it is finite; the PC
 * audition renders q8f16, which is finite on x86.
 *
 * THE VOICES ARE THE AUDITION SLATE, twelve of them (deck §6), because K-03
 * renders all twelve. A voice file is a 256-float style matrix per token
 * length: ~130 KB each.
 */

/** Download attempts per pin, and the linear backoff step between them. */
export const FETCH_ATTEMPTS = 4;
const FETCH_BACKOFF_MS = 10_000;

export const PINS = Object.freeze([
  /* The q8f16 export (the probe-era Android model, D13). Kept FIRST, and
     kept in this exact field order: `render-audition.py`'s `read_pins` parses
     this pin out of this file's text, and the PC audition renders q8f16,
     which is finite on x86. */
  Object.freeze({
    kind: "model",
    name: "kokoro-v1_0-q8f16.onnx",
    url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_q8f16.onnx",
    sha256: "04c658aec1b6008857c2ad10f8c589d4180d0ec427e7e6118ceb487e215c3cd0",
    bytes: 86033585,
    licence: "Apache-2.0",
    source: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX",
  }),
  /* The fp32 export (D13, KV-R2): the only one finite and near real time on
     Apple silicon, and the model central narration renders with
     (render-profile.json). Hashed twice, independently — see the header. */
  Object.freeze({
    kind: "model",
    name: "kokoro-v1_0-fp32.onnx",
    url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model.onnx",
    sha256: "8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb",
    bytes: 325532232,
    licence: "Apache-2.0",
    source: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX",
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
  })),
  /* THE ID TABLE'S RECEIPT. `tools/narration/kokoro-vocab.json` is the
     phoneme-to-id table, committed because it is 3 KB and because
     `phonemize.py` needs it on any machine that authors a Foray. It was
     EXTRACTED from this file, and this pin is what makes that checkable: the
     committed table records the same sha256 and length, `kokoro-vocab.test.mjs`
     asserts the two agree, and `--fetch` re-downloads the file so the
     extraction can be repeated by hand.

     It never reaches a phone. The app receives ids and has no text to map;
     a table in the bundle would be the first step back towards a front end
     on the device, which is the thing deck §4 exists to prevent. */
  Object.freeze({
    kind: "tokenizer",
    name: "kokoro-tokenizer.json",
    url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/tokenizer.json",
    sha256: "77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34",
    bytes: 3497,
    licence: "Apache-2.0",
    source: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX",
  }),
]);

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

const USAGE = "Usage: node tools/mobile/fetch-models.mjs [--fetch|--verify|--check]";

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

/* Wrapped in a function rather than run at module scope so this file carries NO
   top-level await: `test/release-gates.test.js` is a CommonJS suite and imports
   the pin table, and a module with top-level await cannot be required. */
if (isMain) { main(); }

async function main() {
  const mode = process.argv[2] ?? "--fetch";
  const problems = pinProblems();
  if (problems.length) {
    console.error("The model pin table is malformed:");
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  if (process.argv.length > 3) {
    /* No mode takes an argument since CH2-23 deleted `--bundled <platform>`
       and `--fetch <platform>`; a stray one is a caller still asking those. */
    console.error(`Unexpected argument: ${process.argv[3]}`);
    console.error(USAGE);
    process.exit(2);
  }
  const missing = unfilled();
  if (mode === "--check") {
    console.log(`${PINS.length} pins, all well-formed.`);
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
    console.error(USAGE);
    process.exit(2);
  }
  /* `--fetch` fetches every pin, for a workstation. */
  const dir = path.join(REPO_ROOT, MODELS_DIR);
  let failed = 0;
  for (const pin of PINS) {
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
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
    console.log(`  ${pin.name}  ${buf.length} bytes  ok`);
  }
  process.exit(failed ? 1 : 0);
}
