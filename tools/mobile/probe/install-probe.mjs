#!/usr/bin/env node
/* Put the two measurement probes into a BUILT app bundle's web assets (#38, MP4).
 *
 * WHAT THIS IS FOR
 * #38 exists to settle two things nobody has been able to observe from a Windows
 * machine, and both need the real page running inside the real shell:
 *
 *   1. Does `window.Capacitor` exist under our CSP? (`docs/mobile-shell.md`'s
 *      top open risk, iOS half.)
 *   2. Does our out-point still fire when the app is not in the foreground?
 *      (`docs/research/mp1-background-audio.md` §8, its own "single most
 *      load-bearing untested claim".)
 *
 * A WKWebView in CI has no console anyone can type into, so the page has to
 * report for itself. `probe-bridge.js` is added to `index.html` as an EXTERNAL
 * script — `script-src 'self'` allows it, and that matters twice over: the probe
 * must not need the very `'unsafe-inline'` whose absence it is measuring, and an
 * inline probe would have been blocked and told us nothing.
 *
 * WHY IT PATCHES THE BUILT BUNDLE AND NOT `mobile/www`
 * The Xcode project does not care what is inside its web assets, so the honest
 * BUILD verdict comes from compiling the CLEAN bundle. The probe then goes into
 * a COPY of the built `.app`, which needs no rebuild — one xcodebuild instead of
 * two on a runner that bills at 10x. `tools/mobile/prepare-webdir.mjs` also
 * deletes and rebuilds its output directory every run, so no probe can survive
 * into a real build even by accident.
 *
 * THE GUARD THAT MATTERS: this refuses to touch the repo's own working tree. The
 * target must be a build artefact, not the checkout — patching the committed
 * `index.html` would put a probe on the live website.
 *
 * USAGE
 *   node tools/mobile/probe/install-probe.mjs <dir containing index.html>
 *   node tools/mobile/probe/install-probe.mjs <dir> --list
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROBE_DIR = HERE;
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

/** The files copied in verbatim. `probe-bridge.js` is the only one referenced
 *  from `index.html`; it navigates to `probe-outpoint.html` itself. */
export const PROBE_ASSETS = ["probe-bridge.js", "probe-outpoint.html", "probe-outpoint.js"];

/** The generated tone. Not committed — a 2 MB WAV in a repo that guards a 3 MB
 *  bundle cap would be absurd, and it is deterministic anyway. */
export const TONE_NAME = "probe-tone.wav";
export const TONE_SECONDS = 150;
export const TONE_HZ = 8000;

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
 * `TONE_SECONDS` is 150 against a ~90 s window on purpose: the file must NEVER
 * be the thing that stops playback.
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
  if (!fs.existsSync(path.join(abs, "player", "html-audio-backend.js"))) {
    throw new Error(
      `${dir} has no player/html-audio-backend.js. The out-point probe drives the REAL backend — ` +
        `a reimplementation would be measuring itself.`
    );
  }
  return abs;
}

export function installProbe(dir, { write = true } = {}) {
  const abs = assertBuildArtefact(dir);
  const indexPath = path.join(abs, "index.html");
  const patched = patchIndexHtml(fs.readFileSync(indexPath, "utf8"));

  const copied = [];
  for (const asset of PROBE_ASSETS) {
    const src = path.join(PROBE_DIR, asset);
    if (!fs.existsSync(src)) throw new Error(`probe asset missing from the repo: ${asset}`);
    if (write) fs.copyFileSync(src, path.join(abs, asset));
    copied.push(asset);
  }
  const tone = makeToneWav();
  if (write) {
    fs.writeFileSync(path.join(abs, TONE_NAME), tone);
    if (patched.changed) fs.writeFileSync(indexPath, patched.html);
  }
  return {
    target: abs,
    indexPatched: patched.changed,
    copied,
    tone: { name: TONE_NAME, bytes: tone.length, seconds: TONE_SECONDS },
  };
}

/* --------------------------------------------------------------------- main */

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const argv = process.argv.slice(2);
  const listOnly = argv.includes("--list");
  const dir = argv.find((a) => !a.startsWith("-"));
  if (!dir) {
    console.error("Usage: node tools/mobile/probe/install-probe.mjs <bundle dir> [--list]");
    process.exit(2);
  }
  try {
    const r = installProbe(dir, { write: !listOnly });
    console.log(
      `${listOnly ? "would install" : "installed"} probe into ${r.target}: ` +
        `${r.copied.join(", ")}, ${r.tone.name} (${(r.tone.bytes / 1024 / 1024).toFixed(2)} MB, ` +
        `${r.tone.seconds}s); index.html ${r.indexPatched ? "patched" : "already patched"}`
    );
  } catch (e) {
    console.error(`install-probe failed: ${e.message}`);
    process.exit(1);
  }
}
