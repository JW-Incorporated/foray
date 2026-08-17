#!/usr/bin/env node
/* Put the measurement probes into a BUILT app bundle's web assets (#38, MP4).
 *
 * WHAT THIS IS FOR
 * #38 exists to settle things nobody has been able to observe from a Windows
 * machine, and all of them need the real page running inside the real shell:
 *
 *   1. Does `window.Capacitor` exist under our CSP? (`docs/mobile-shell.md`'s
 *      top open risk, iOS half.) — ANSWERED, run 32026332637: yes, 0 violations.
 *   2. Does our out-point still fire when the app is not in the foreground?
 *      (`docs/research/mp1-background-audio.md` §8, its own "single most
 *      load-bearing untested claim".) — ANSWERED, run 32026332637: yes, 4 ms
 *      late over a 15.056 s hidden window, with the app never resumed.
 *   3. Does the SEAM TRANSITION survive backgrounding — the 2.0 s beat's
 *      `setTimeout`, then a fresh load of a DIFFERENT episode, then a seek, then
 *      play? (#28's iOS half.) That is a different mechanism from (2) on a
 *      different clock: the same run measured hidden DOM timers aligned to a
 *      median of 1000 ms, so the beat is scheduled on the clock that IS
 *      throttled. If it breaks, a locked-screen listener hears one segment and
 *      then silence — which no amount of out-point accuracy fixes.
 *
 * A WKWebView in CI has no console anyone can type into, so the page has to
 * report for itself. `probe-bridge.js` is added to `index.html` as an EXTERNAL
 * script — `script-src 'self'` allows it, and that matters twice over: the probe
 * must not need the very `'unsafe-inline'` whose absence it is measuring, and an
 * inline probe would have been blocked and told us nothing.
 *
 * WHY CI PATCHES THE BUILT BUNDLE RATHER THAN `mobile/www`
 * Either directory is accepted — both are build artefacts — but the workflow uses
 * the built `.app`'s `public/`, and the reason is the build verdict: the Xcode
 * project does not care what is inside its web assets, so compiling the CLEAN
 * bundle and then patching a COPY of the product gives an honest "it builds" and
 * needs no second xcodebuild on a runner that bills at 10x.
 * `tools/mobile/prepare-webdir.mjs` also deletes and rebuilds its output directory
 * every run, so no probe can survive into a real build even by accident.
 *
 * THE GUARD THAT MATTERS: this refuses to touch the repo's own working tree. The
 * target must be a build artefact, not the checkout — patching the committed
 * `index.html` would put a probe on the live website.
 *
 * USAGE
 *   node tools/mobile/probe/install-probe.mjs <dir containing index.html>
 *   node tools/mobile/probe/install-probe.mjs <dir> --phase seam
 *   node tools/mobile/probe/install-probe.mjs <dir> --list
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROBE_DIR = HERE;
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

/** The files copied in verbatim. `probe-bridge.js` is the only one referenced
 *  from `index.html`; it navigates to `probe-<phase>.html` itself. */
export const PROBE_ASSETS = [
  "probe-bridge.js",
  "probe-outpoint.html",
  "probe-outpoint.js",
  "probe-seam.html",
  "probe-seam.js",
];

/** Which measurement this install is for. `probe-bridge.js` reads it and navigates
 *  accordingly.
 *
 *  TWO PASSES, NOT ONE PAGE, and the reason is that both phases need the same
 *  scarce resource: a window in which the app is backgrounded. The out-point phase
 *  spends its whole window proving a single boundary, and the seam phase needs a
 *  boundary plus two beats plus two cross-file loads. Sharing one page would also
 *  put two `<audio>` elements in play and make "what stopped the audio"
 *  unanswerable. So the workflow installs, measures, re-installs with the other
 *  phase, and measures again — about 95 s more on a runner that bills at 10x, for
 *  two unconfounded results instead of one ambiguous one. */
export const PHASES = ["outpoint", "seam"];
export const DEFAULT_PHASE = "outpoint";

/** The generated one-line file that carries the phase into the page.
 *
 *  A FILE RATHER THAN A SECOND `<script>` TAG IN `index.html`. `PROBE_TAG` is
 *  asserted verbatim by `install-probe.test.mjs` because "external, not inline" is
 *  the property the whole bridge measurement rests on, and widening that tag would
 *  weaken the thing it pins. `probe-bridge.js` loads this dynamically instead —
 *  still an external same-origin script, still allowed by `script-src 'self'`,
 *  still no inline anything. */
export const PHASE_ASSET = "probe-phase.js";

/** Every `player/` module the probes' import closure needs present in the bundle.
 *
 *  Phase B imports `html-audio-backend.js`; phase C imports `queue-manager.js`,
 *  `html-audio-backend.js` and `seam-gap.js`, and `queue-manager.js` in turn imports
 *  `queue-state.js`, `queue-strategy.js`, `seek-policy.js` and `foray-queue.js`.
 *  Listed in full rather than spot-checked — see `assertBuildArtefact`. */
export const PROBE_PLAYER_DEPS = [
  "html-audio-backend.js",
  "queue-manager.js",
  "queue-state.js",
  "queue-strategy.js",
  "seam-gap.js",
  "seek-policy.js",
  "foray-queue.js",
];

/** The generated tone. Not committed — a 2 MB WAV in a repo that guards a 3 MB
 *  bundle cap would be absurd, and it is deterministic anyway. */
export const TONE_NAME = "probe-tone.wav";
export const TONE_SECONDS = 150;
export const TONE_HZ = 8000;

/** A SECOND, DIFFERENT audio file, and the seam probe cannot work without it.
 *
 *  A Foray's transition loads a DIFFERENT EPISODE, and `html-audio-backend.js`
 *  deliberately short-circuits a same-URL load into a seek with no refetch —
 *  "SAME SOURCE = A SEEK, NOT A LOAD" in its header, because consecutive segments
 *  frequently share an episode and re-assigning `src` would discard the buffer.
 *  That shortcut is correct and it is also the one path the seam measurement must
 *  NOT take: the question is whether a fresh media load completes while the page is
 *  hidden, and a seek within an already-buffered file would answer a much easier
 *  one. Three files (see TONE_C_NAME), at three frequencies so a spectrogram of a
 *  screen recording could tell them apart if anyone ever needs to.
 *
 *  Shorter than the first, because it only has to outlast one segment plus margin:
 *  60 s against **25 s** of use (`probe-seam.js`'s `seg-b` is 12 → 37 as of
 *  2026-08-17; it was 8 s before the window grew). The 23 s of remaining margin is
 *  load-bearing in one specific way — if `seg-b`'s out-point fails to fire while the
 *  page is suspended, the audio has to keep flowing rather than hit the end of the
 *  file, because "the out-point was late" and "the audio ran out" are the two readings
 *  the seam record has to be able to tell apart. Both are generated, so this costs
 *  nothing in git — but do NOT lengthen them for comfort: a `capacitor://` media load
 *  goes through a UIProcess scheme handler that took 3.0 s for this 960 KB file while
 *  hidden (run 32064639785), and a bigger file pushes a hidden load toward
 *  `LOAD_SETTLE_TIMEOUT_HIDDEN_MS`. */
export const TONE_B_NAME = "probe-tone-b.wav";
export const TONE_B_SECONDS = 60;
export const TONE_B_HZ = 660;

/** A THIRD file, so BOTH of the seam probe's transitions load audio the element
 *  has never held.
 *
 *  With only two tones the queue had to be A, B, A — and the second transition
 *  re-loaded A, which WebKit may well satisfy from its media cache. That put the
 *  EASIER load on the transition that matters more: the second one is the one
 *  `MIN_HIDDEN_TRANSITIONS` exists to obtain, because it happens after the page has
 *  been silent through a beat and the audibility assertion may have lapsed. Three
 *  files make A -> B -> C, and every load a cold one. */
export const TONE_C_NAME = "probe-tone-c.wav";
export const TONE_C_SECONDS = 60;
export const TONE_C_HZ = 880;

/** Every generated audio file, as `{name, seconds, freq}`. One list so the writer
 *  and the tests cannot disagree about how many there are. */
export const TONES = [
  { name: TONE_NAME, seconds: TONE_SECONDS, freq: 440 },
  { name: TONE_B_NAME, seconds: TONE_B_SECONDS, freq: TONE_B_HZ },
  { name: TONE_C_NAME, seconds: TONE_C_SECONDS, freq: TONE_C_HZ },
];

/** Exactly what gets appended to `index.html`. Pinned because "external, not
 *  inline" is the whole reason the probe can run at all. */
export const PROBE_TAG = '<script src="probe-bridge.js"></script>';

/* ------------------------------------------------------------------ the tone */

/**
 * A mono 16-bit PCM sine WAV, built with no dependencies.
 *
 * WHY A LOCAL FILE AND NOT A REAL EPISODE. The measurement needs audio that is
 * (a) long enough to outlast the whole observation window — otherwise the file
 * ends first, `ended` fires, and a natural end gets mistaken for an out-point —
 * and (b) not a podcast CDN, because product principle #3 says we never rehost
 * or reuse episode audio and a CI job hammering someone's CDN is exactly the
 * kind of thing that principle is about.
 *
 * `TONE_SECONDS` is 150 s, and BE PRECISE ABOUT WHAT PROTECTS THE FIRST SEGMENT NOW,
 * because "150 against a ~90 s window" stopped being the reason on 2026-08-17: the
 * seam window is 175 s, longer than the tone. What keeps the file from ending first is
 * the BOUNDARY, which lands at ~75-114 s of media (`ARM_AFTER_HIDDEN_SEC` = 60 s after
 * the page goes hidden, and the page goes hidden 15-54 s in), or at ~130 s via the 70 s
 * fallback arm — all of them inside 150 s. Phase B is unaffected: its window is ~67 s.
 * If either the arm or the seam window grows again, redo that arithmetic rather than
 * assuming this margin.
 */
export function makeToneWav({ seconds = TONE_SECONDS, sampleRate = TONE_HZ, freq = 440, amplitude = 0.25 } = {}) {
  const frames = Math.floor(seconds * sampleRate);
  const dataBytes = frames * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  const peak = Math.round(32767 * amplitude);
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(Math.round(peak * Math.sin((2 * Math.PI * freq * i) / sampleRate)), 44 + i * 2);
  }
  return buf;
}

/* ---------------------------------------------------------------- the patch */

/** Append the probe tag to `index.html`'s markup, idempotently.
 *  Split out from the filesystem work so the string transform is testable. */
export function patchIndexHtml(html) {
  if (typeof html !== "string" || !/<html|<!doctype|<head|<body/i.test(html)) {
    throw new Error("that does not look like an HTML document — refusing to patch it");
  }
  if (!/Content-Security-Policy/i.test(html)) {
    throw new Error(
      "index.html carries no Content-Security-Policy meta tag. The probe exists to measure what " +
        "that CSP does to Capacitor's bridge, so patching a page without one would measure nothing."
    );
  }
  if (html.includes(PROBE_TAG)) return { html, changed: false };
  const close = html.lastIndexOf("</body>");
  const out =
    close < 0
      ? `${html.replace(/\s*$/, "")}\n${PROBE_TAG}\n`
      : `${html.slice(0, close)}${PROBE_TAG}\n${html.slice(close)}`;
  return { html: out, changed: true };
}

/** Refuse anything that is not a build artefact. A wrong path here would patch
 *  the committed site. CLAUDE.md § Never discard uncommitted work is the same
 *  instinct: a script that writes must know what it is allowed to write to. */
export function assertBuildArtefact(dir) {
  const abs = path.resolve(dir);
  if (path.resolve(REPO_ROOT) === abs) {
    throw new Error(
      "refusing to patch the repo root — that is the live website's index.html, not a build artefact"
    );
  }
  for (const marker of [".git", "CLAUDE.md", "sw.js", "package.json"]) {
    if (fs.existsSync(path.join(abs, marker))) {
      throw new Error(
        `${dir} contains ${marker}, so it is a source checkout rather than a built bundle. The ` +
          `probe only ever goes into mobile/www or a built .app's public/ directory.`
      );
    }
  }
  if (!fs.existsSync(path.join(abs, "index.html"))) {
    throw new Error(`${dir} has no index.html, so it is not a web bundle`);
  }
  /* Both probes drive the REAL shipped code — the out-point probe drives
     `HtmlAudioBackend`, the seam probe drives `PlayerQueueManager` on top of it —
     so a bundle missing either would have the probe measuring a reimplementation
     of the thing under test, which is worth nothing. */
  /* THE WHOLE IMPORT CLOSURE, not a spot-check on three of it. A review pointed out
     that `queue-manager.js` also pulls in `queue-state.js`, `queue-strategy.js`,
     `seek-policy.js` and `foray-queue.js`, and a bundle missing any of them dies as
     an unreadable module error inside a WKWebView on a CI runner — which surfaces as
     "the probe reported nothing" and is indistinguishable from the seam genuinely
     stalling. That is the one confusion this phase exists to avoid, so the refusal
     belongs here, on the host, where the message can be read. */
  for (const needed of PROBE_PLAYER_DEPS) {
    if (!fs.existsSync(path.join(abs, "player", needed))) {
      throw new Error(
        `${dir} has no player/${needed}. The probes drive the REAL player — ` +
          `a reimplementation would be measuring itself.`
      );
    }
  }
  return abs;
}

/** The phase file's contents. A plain assignment, no logic — the page's own
 *  default lives in `probe-bridge.js` so a missing file degrades rather than
 *  breaks. */
export function phaseScript(phase) {
  if (!PHASES.includes(phase)) {
    throw new Error(`unknown probe phase ${JSON.stringify(phase)}; expected one of ${PHASES.join(", ")}`);
  }
  return `window.FORAY_PROBE_PHASE = ${JSON.stringify(phase)};\n`;
}

export function installProbe(dir, { write = true, phase = DEFAULT_PHASE } = {}) {
  const abs = assertBuildArtefact(dir);
  const script = phaseScript(phase); // validates `phase` before anything is written
  const indexPath = path.join(abs, "index.html");
  const patched = patchIndexHtml(fs.readFileSync(indexPath, "utf8"));

  const copied = [];
  for (const asset of PROBE_ASSETS) {
    const src = path.join(PROBE_DIR, asset);
    if (!fs.existsSync(src)) throw new Error(`probe asset missing from the repo: ${asset}`);
    if (write) fs.copyFileSync(src, path.join(abs, asset));
    copied.push(asset);
  }
  const tones = TONES.map((t) => ({ ...t, bytes: makeToneWav(t) }));
  if (write) {
    fs.writeFileSync(path.join(abs, PHASE_ASSET), script);
    for (const t of tones) fs.writeFileSync(path.join(abs, t.name), t.bytes);
    if (patched.changed) fs.writeFileSync(indexPath, patched.html);
  }
  return {
    target: abs,
    indexPatched: patched.changed,
    copied,
    phase,
    tones: tones.map((t) => ({ name: t.name, bytes: t.bytes.length, seconds: t.seconds })),
  };
}

/* --------------------------------------------------------------------- main */

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const argv = process.argv.slice(2);
  const listOnly = argv.includes("--list");
  const phaseIdx = argv.indexOf("--phase");
  const phase = phaseIdx >= 0 ? argv[phaseIdx + 1] : DEFAULT_PHASE;
  /* `phaseIdx + 1` IS ONLY THE PHASE'S ARGUMENT WHEN `--phase` IS PRESENT. Written
     without that guard, `phaseIdx` is -1 with no flag, `phaseIdx + 1` is 0, and the
     FIRST positional — the bundle directory — was excluded, so the documented
     `install-probe.mjs <dir> --list` invocation printed usage and exited 2. CI never
     saw it because both call sites pass `--phase`; a human debugging by hand would
     have hit it immediately. */
  const phaseArgIdx = phaseIdx >= 0 ? phaseIdx + 1 : -1;
  const dir = argv.find((a, i) => !a.startsWith("-") && i !== phaseArgIdx);
  if (!dir) {
    console.error(
      `Usage: node tools/mobile/probe/install-probe.mjs <bundle dir> [--phase ${PHASES.join("|")}] [--list]`
    );
    process.exit(2);
  }
  try {
    const r = installProbe(dir, { write: !listOnly, phase });
    console.log(
      `${listOnly ? "would install" : "installed"} probe (phase ${r.phase}) into ${r.target}: ` +
        `${r.copied.join(", ")}; tones ` +
        r.tones
          .map((t) => `${t.name} (${(t.bytes / 1024 / 1024).toFixed(2)} MB, ${t.seconds}s)`)
          .join(", ") +
        `; index.html ${r.indexPatched ? "patched" : "already patched"}`
    );
  } catch (e) {
    console.error(`install-probe failed: ${e.message}`);
    process.exit(1);
  }
}
