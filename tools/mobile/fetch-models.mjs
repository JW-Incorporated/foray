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
 * Nothing yet, and that is stated rather than implied. The build-workflow step
 * that calls it is `.github/` and needs `founder-approved` (deck H3), so it is
 * NOT in this PR. Until it lands, this script is run by hand:
 *
 *     node tools/mobile/fetch-models.mjs            # fetch + verify
 *     node tools/mobile/fetch-models.mjs --verify   # verify what is on disk
 *     node tools/mobile/fetch-models.mjs --check    # check the pins only (CI)
 *
 * `--check` is the mode CI can run TODAY with no download and no secret: it
 * asserts every pin is well-formed and internally consistent, which is what
 * makes "somebody edited the URL and not the hash" a red build rather than a
 * surprise at fetch time. `test/release-gates.test.js` runs the same
 * assertions in-process.
 *
 * ── The sha256 values are NOT filled in, and that is the honest state ─────
 * Every `sha256` below is `null`. Nobody in this repo has downloaded these
 * files: this branch was written on a machine that must not pull a
 * multi-hundred-megabyte model into a worktree, and a hash copied out of a
 * model card without having hashed the bytes would be exactly the unlabelled
 * claim `CLAUDE.md` and every research doc here warns against. A `null` pin
 * REFUSES TO FETCH — see `verifyPins` — so the failure mode is "this step
 * cannot run yet", never "it ran unverified". The one command that fills them
 * in is printed by `--check`.
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
 * `ForayTtsPlugin.swift`'s `MODEL_RESOURCE` and `ForayTtsPlugin.java`'s
 * `MODEL_ASSET`. Changing one without the others is caught by
 * `tools/mobile/fetch-models.test.mjs` and the XCTest pin of the same name.
 *
 * WHY q8f16 AND NOT int8 OR fp32. Deck §3's evidence table: fp32 is 326 MB and
 * measured 833 MB peak on a 2018 iPad; plain int8 measured SLOWER than fp32 on
 * that same device (RTF > 1.5); q8f16 is the 86 MB variant NimbleEdge ships on
 * phones. K-01 measures whether that choice survives contact with a real
 * phone — it is a starting point, not a finding.
 *
 * THE VOICES ARE THE AUDITION SLATE, twelve of them (deck §6), because K-03
 * renders all twelve and K-04 bundles only the three the founders pick. A
 * voice file is a 256-float style matrix per token length: ~130 KB each.
 */
export const PINS = Object.freeze([
  Object.freeze({
    kind: "model",
    name: "kokoro-v1_0-q8f16.onnx",
    url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_q8f16.onnx",
    sha256: null,
    bytes: null,
    licence: "Apache-2.0",
    source: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX",
  }),
  ...[
    "af_heart", "af_bella", "af_nicole", "af_sarah", "af_kore", "af_aoede",
    "bf_emma", "am_michael", "am_fenrir", "am_puck", "bm_george", "bm_fable",
  ].map((id) => Object.freeze({
    kind: "voice",
    name: `${id}.bin`,
    url: `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/${id}.bin`,
    sha256: null,
    bytes: null,
    licence: "Apache-2.0",
    source: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX",
  })),
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
    + "# NEVER COMMITTED: the Kokoro model is ~86 MB (docs/bundled-voice-plan.md K-06).\n"
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
async function main() {
  const mode = process.argv[2] ?? "--fetch";
  const problems = pinProblems();
  if (problems.length) {
    console.error("The model pin table is malformed:");
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
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
    console.error("Usage: node tools/mobile/fetch-models.mjs [--fetch|--verify|--check]");
    process.exit(2);
  }
  const dir = path.join(REPO_ROOT, MODELS_DIR);
  let failed = 0;
  for (const pin of PINS) {
    const abs = path.join(dir, pin.name);
    if (fs.existsSync(abs) && verifyBuffer(pin, fs.readFileSync(abs)).ok) continue;
    const res = await fetch(pin.url);
    if (!res.ok) { console.error(`  ${pin.name}: HTTP ${res.status}`); failed++; continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    const check = verifyBuffer(pin, buf);
    if (!check.ok) { console.error(`  ${check.reason}`); failed++; continue; }
    fs.writeFileSync(abs, buf);
    console.log(`  ${pin.name}  ${buf.length} bytes  ok`);
  }
  process.exit(failed ? 1 : 0);
}
