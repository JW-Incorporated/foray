/* K-06(1): the model pin table, and the refusal that makes it worth having.
 *
 * `docs/bundled-voice-plan.md` K-06: "`tools/mobile/fetch-models.mjs` pins
 * `{url, sha256, bytes}` for the model and each voice; CI fails on a
 * mismatch."
 *
 * WHAT THIS SUITE IS FOR, stated once. The file it covers downloads the
 * Kokoro weights central narration renders with (and, until CH-20 took them
 * out of every shell build, weights that were EXECUTED on a listener's phone).
 * There is exactly one thing standing between "the upstream repository
 * re-uploaded this file" and "we render with whatever is now at that URL",
 * and it is a hash comparison. Every test below is a mutation of that
 * comparison or of the table it reads.
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
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  PINS, MODELS_DIR, pinProblems, unfilled, verifyBuffer, verifyOnDisk,
  digest, ensureIgnored, fillPinCommand, FETCH_ATTEMPTS, bundledPins, bundledBytes, BUNDLE_PLATFORMS,
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
  /* Deck §6's slate is twelve. A table that drifted to eleven would silently
     drop a voice the founders were asked to rank.
     MUTATION: remove one id from the voice list in fetch-models.mjs.

     TWO MODELS SINCE KV-R2 (D13): q8f16 (the PC audition's) and the fp32
     export (central narration's, render-profile.json), because every
     fp16-activation export goes NaN on Apple silicon. The q8f16 pin stays
     FIRST: `render-audition.py`'s `read_pins` reads it by name. The only
     kinds are model, voice and tokenizer: KV-R3's Core ML stage pins left
     with the on-device probe (CH-20). */
  const models = PINS.filter((p) => p.kind === "model");
  const voices = PINS.filter((p) => p.kind === "voice");
  assert.deepEqual([...new Set(PINS.map((p) => p.kind))].sort(), ["model", "tokenizer", "voice"]);
  assert.equal(models.length, 2, "q8f16 and fp32");
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

test("a pin name may not carry a path, KV-R3's Core ML shape included", () => {
  /* KV-R3 let ONE shape through the separator rule, a Core ML stage file
     (`kokoro-coreml/<Stage>.mlmodelc/<file>`), for the iOS probe build. The
     probe and its Core ML pins are gone (CH-20), so the exemption went with
     them and every name is a flat file under mobile/models/ again.
     MUTATION: restore the `kind === "coreml"` exemption in `pinProblems` —
     the stage-shaped name is accepted and this goes red. */
  const stageShaped = { ...PINS[0], kind: "coreml", name: "kokoro-coreml/KokoroAlbert.mlmodelc/model.mil" };
  assert.match(pinProblems([stageShaped]).join("\n"), /path separator/);
  for (const p of PINS) assert.ok(!/[\\/]/.test(p.name), `${p.name} is a flat file name`);
});

test("main() runs only after the constants it reads exist", () => {
  /* The TDZ trap (#854, also hit running `--fetch ios` for KV-R3): `if
     (isMain) main()` sat ABOVE `FETCH_ATTEMPTS`, and `main` reads it before
     its first `await`, so every CLI fetch threw a ReferenceError while this
     suite (which imports and never runs main) stayed green.
     MUTATION: move the `if (isMain)` line back above the constants. */
  const src = fs.readFileSync(path.join(HERE, "fetch-models.mjs"), "utf8");
  const call = src.indexOf("if (isMain) { main(); }");
  assert.ok(call > 0);
  for (const name of ["export const FETCH_ATTEMPTS", "const FETCH_BACKOFF_MS"]) {
    assert.ok(src.indexOf(name) >= 0 && src.indexOf(name) < call, `${name} is declared before main() is called`);
  }
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

test("no app bundles any pin: both shell builds carry zero Kokoro bytes (CH-20)", () => {
  /* Founder ruling on issue #1076 (2026-10-05): "Remove it all". Until then
     iOS bundled fp32 + af_heart + the 34 Core ML stage files (~409 MiB
     projected) and Android q8f16 + af_heart (~83 MiB), read only by the
     on-device probe. The pins stay, for central narration and the audition;
     no `bundle` list names a platform.
     MUTATION: put "ios" back in fp32's `bundle`, or "android" in q8f16's or
     af_heart's — red. */
  for (const platform of BUNDLE_PLATFORMS) {
    assert.deepEqual(bundledPins(platform), [], `${platform} bundles nothing`);
    assert.equal(bundledBytes(platform), 0, `${platform} carries no model bytes`);
  }
  for (const p of PINS) assert.deepEqual([...p.bundle], [], `${p.name} names no platform`);
});

test("a pin with an implicit bundle value is refused", () => {
  /* `bundle` is never implicit: a pin whose field was dropped in a rebase
     must be an error, not a silent answer about what an app store binary
     carries (every list is `[]` since CH-20, and that is said, not assumed).
     A bare `true` is refused as well: it meant "both apps" before D13, and a
     pin that still says it has not been told which model each app carries.
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

/* ---------- the text the narration tools parse ---------- */

/* `render-audition.py`, `render-foray.py` and `bench-narration.py` do not
   import this module: each regexes the model and voice pins out of the FILE
   TEXT (`read_pins`), so the hashes live in one table. These are their
   patterns, ported verbatim (the audition reads q8f16 by name; the other two
   read every `kokoro-v1_0-*.onnx` model pin). */
const PY_MODEL_RE = /name: "(kokoro-v1_0-[a-z0-9]+\.onnx)",\s*url: "([^"]+)",\s*sha256: "([0-9a-f]{64})",\s*bytes: (\d+)/g;
const PY_VOICE_RE = /\["([a-z]{2}_[a-z]+)", "([0-9a-f]{64})", (\d+)\]/g;

test("the pin text the python parsers regex is exactly what it was, and agrees with PINS", () => {
  /* The parsers read only the spans these regexes match, so the spans are
     hashed: any edit inside one (a field slipped between `url` and `sha256`,
     `bytes` moved above `sha256`, a voice tuple changed) is red here before
     it is a python `ValueError` at render time, and an edit OUTSIDE them
     (CH2-23 deleting the `bundle` fields) provably leaves them alone.
     MUTATION (RUN, red, restored): move `bytes` above `sha256` in the q8f16
     pin — the model regex finds one pin, not two. MUTATION (RUN, red,
     restored): change one character of a voice's sha256 in the tuple list —
     the parsed voices and the span hash both move. */
  const src = fs.readFileSync(path.join(HERE, "fetch-models.mjs"), "utf8");
  const models = [...src.matchAll(PY_MODEL_RE)];
  const voices = [...src.matchAll(PY_VOICE_RE)];
  assert.deepEqual(models.map((m) => ({ name: m[1], url: m[2], sha256: m[3], bytes: Number(m[4]) })),
    PINS.filter((p) => p.kind === "model").map(({ name, url, sha256, bytes }) => ({ name, url, sha256, bytes })),
    "every model pin is visible to the python parsers, in table order");
  assert.deepEqual(voices.map((m) => ({ name: `${m[1]}.bin`, sha256: m[2], bytes: Number(m[3]) })),
    PINS.filter((p) => p.kind === "voice").map(({ name, sha256, bytes }) => ({ name, sha256, bytes })),
    "every voice pin is visible to the python parsers, in table order");
  const spans = [...models, ...voices].map((m) => m[0]).join("\n");
  assert.equal(crypto.createHash("sha256").update(spans).digest("hex"),
    "ed4761ff87467ed09a735138027edeb2e8f5ef5dbfbdaf6d5ccb878f3db87636",
    "the text the narration tools parse changed — rerun their read_pins before updating this hash");
});

/* ---------- the CLI, over a fixture root ---------- */

/** A throwaway repo root holding a COPY of this script, so `REPO_ROOT` (the
    script's `../..`) is the fixture and nothing touches this repo's
    `mobile/models/`. The copy's retry backoff is zeroed so a refused fetch
    takes milliseconds, and `fetch` is replaced by a preload that records each
    URL and answers per `FAKE_FETCH`: "404", or "short" (a 200 with a 5-byte
    body). Nothing in this suite reaches the network. */
function fixtureRoot() {
  const root = tmp();
  const dir = path.join(root, "tools", "mobile");
  fs.mkdirSync(dir, { recursive: true });
  const src = fs.readFileSync(path.join(HERE, "fetch-models.mjs"), "utf8");
  const fast = src.replace("const FETCH_BACKOFF_MS = 10_000;", "const FETCH_BACKOFF_MS = 0;");
  assert.notEqual(fast, src, "the fixture zeroes the retry backoff");
  fs.writeFileSync(path.join(dir, "fetch-models.mjs"), fast);
  const log = path.join(root, "fetched.log");
  const preload = path.join(root, "fake-fetch.mjs");
  fs.writeFileSync(preload, [
    `import fs from "node:fs";`,
    `globalThis.fetch = async (url) => {`,
    `  fs.appendFileSync(${JSON.stringify(log)}, url + "\\n");`,
    `  return process.env.FAKE_FETCH === "short" ? new Response("short") : new Response("", { status: 404 });`,
    `};`,
  ].join("\n"));
  const run = (args, fake = "404") => {
    const r = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, path.join(dir, "fetch-models.mjs"), ...args],
      { encoding: "utf8", env: { ...process.env, FAKE_FETCH: fake }, timeout: 60_000 });
    const fetched = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
    fs.rmSync(log, { force: true });
    return { ...r, fetched };
  };
  return { root, run };
}

test("CLI --check: the pin table's verdict, no download, exit 0", () => {
  /* What render-narration.yml runs. MUTATION (RUN, red, restored): make
     `--check` fall through to the fetch path — the fake records requests. */
  const { run } = fixtureRoot();
  const r = run(["--check"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.split("\n")[0], `${PINS.length} pins, all well-formed.`);
  assert.ok(!/carry no sha256/.test(r.stdout), "every pin is filled");
  assert.deepEqual(r.fetched, [], "--check downloads nothing");
});

test("CLI --verify: a fixture with nothing fetched names every pin and exits 1", () => {
  /* MUTATION (RUN, red, restored): treat a missing file as ok in
     `verifyOnDisk` — no "not fetched" lines. MUTATION: let `--verify` exit 0
     whatever `verifyOnDisk` says. */
  const { root, run } = fixtureRoot();
  fs.mkdirSync(path.join(root, MODELS_DIR), { recursive: true });
  fs.writeFileSync(path.join(root, MODELS_DIR, "af_heart.bin"), "short");
  const r = run(["--verify"]);
  assert.equal(r.status, 1);
  assert.deepEqual(r.fetched, [], "--verify downloads nothing");
  const lines = r.stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  assert.equal(lines.length, PINS.length, r.stderr);
  assert.ok(lines.includes("af_heart.bin: 5 bytes, pinned 522240"), "a wrong file is named with its length");
  for (const p of PINS.filter((x) => x.name !== "af_heart.bin")) assert.ok(lines.includes(`${p.name}: not fetched`), p.name);
  assert.ok(fs.existsSync(path.join(root, MODELS_DIR, ".gitignore")), "--verify writes the ignore file first");
});

test("CLI --fetch: every pin, FETCH_ATTEMPTS tries each, and a bad body is never written", () => {
  /* Bare `--fetch` (also the no-argument default) is a workstation's fetch of
     every pin. MUTATION (RUN, red, restored): write the body before
     `verifyBuffer` accepts it — the short file lands on disk. MUTATION: one
     attempt instead of FETCH_ATTEMPTS — the request count drops. */
  const { root, run } = fixtureRoot();
  for (const fake of ["404", "short"]) {
    const r = run(["--fetch"], fake);
    assert.equal(r.status, 1, `${fake}: a refused pin fails the run`);
    assert.deepEqual(r.fetched, PINS.flatMap((p) => Array(FETCH_ATTEMPTS).fill(p.url)), `${fake}: every pin, in order, retried`);
    assert.match(r.stderr, fake === "404" ? /kokoro-v1_0-q8f16\.onnx: HTTP 404\r?\n/ : /af_heart\.bin: 5 bytes, pinned 522240\r?\n/);
    assert.deepEqual(fs.readdirSync(path.join(root, MODELS_DIR)), [".gitignore"], `${fake}: nothing unverified reaches disk`);
  }
  assert.equal(run([]).fetched.length, PINS.length * FETCH_ATTEMPTS, "no argument means --fetch");
});

test("CLI --fetch <platform>: today fetches what that platform bundles, which is nothing", () => {
  /* CHARACTERIZATION of the platform argument CH2-23 deletes. */
  const { run } = fixtureRoot();
  for (const platform of ["ios", "android"]) {
    const r = run(["--fetch", platform]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.fetched, []);
  }
  const web = run(["--fetch", "web"]);
  assert.equal(web.status, 2);
  assert.deepEqual(web.fetched, []);
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
