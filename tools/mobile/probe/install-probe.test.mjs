/* The measurement probes' harness, tested without a Mac (#38, MP4).
 *
 * These probes are the only way a CI runner can ask the shell a question, so the
 * harness has two properties that matter more than anything it measures:
 *
 *   1. IT MUST NOT NEED `'unsafe-inline'`. The probe exists to measure what our
 *      CSP does to Capacitor's inline bridge injection. A probe that itself
 *      required inline script would be blocked by the same rule and would report
 *      nothing — or worse, would only work in a repo that had already given up
 *      the directive. So the tag is external, and that is asserted here.
 *   2. IT MUST NEVER TOUCH THE CHECKOUT. `install-probe` writes into a BUILT app
 *      bundle. Pointed at the repo it would patch the live website's index.html
 *      and copy a probe onto GitHub Pages.
 *
 * Everything below is a pure string/buffer transform or a temp-directory
 * operation. Nothing here claims anything about a build or a device.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PROBE_ASSETS,
  PROBE_DIR,
  PROBE_TAG,
  REPO_ROOT,
  TONE_NAME,
  TONE_SECONDS,
  assertBuildArtefact,
  installProbe,
  makeToneWav,
  patchIndexHtml,
} from "./install-probe.mjs";

/* A minimal stand-in for the real page: the CSP meta tag is what the probe is
   measuring against, so a fixture without one must be refused. */
const PAGE =
  `<!doctype html>\n<html lang="en">\n<head>\n` +
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'">\n` +
  `<title>Foray</title>\n</head>\n<body>\n<div id="app"></div>\n` +
  `<script src="app.js"></script>\n</body>\n</html>\n`;

function tmpBundle(page = PAGE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-probe-"));
  fs.writeFileSync(path.join(dir, "index.html"), page);
  fs.mkdirSync(path.join(dir, "player"));
  fs.writeFileSync(path.join(dir, "player", "html-audio-backend.js"), "export class HtmlAudioBackend {}\n");
  return dir;
}

/* ─────────────────────────── patching index.html ─────────────────────────── */

test("the probe is added as an EXTERNAL script, never inline", () => {
  /* THE LOAD-BEARING ASSERTION IN THIS FILE. `script-src 'self'` allows a file
     and forbids inline. An inline probe would be blocked by exactly the rule
     under test, so the measurement would come back empty and be indistinguishable
     from "the bridge is fine". */
  assert.equal(PROBE_TAG, '<script src="probe-bridge.js"></script>');
  assert.equal(/>[^<]/.test(PROBE_TAG.replace("></script>", "")), false, "the tag has inline content");
  const { html } = patchIndexHtml(PAGE);
  assert.ok(html.includes(PROBE_TAG));
});

test("the tag lands inside <body>, after the app's own scripts", () => {
  const { html, changed } = patchIndexHtml(PAGE);
  assert.equal(changed, true);
  assert.ok(html.indexOf(PROBE_TAG) > html.indexOf('src="app.js"'));
  assert.ok(html.indexOf(PROBE_TAG) < html.indexOf("</body>"));
});

test("patching is idempotent", () => {
  const once = patchIndexHtml(PAGE);
  const twice = patchIndexHtml(once.html);
  assert.equal(twice.changed, false);
  assert.equal(twice.html, once.html);
  assert.equal((twice.html.match(/probe-bridge\.js/g) || []).length, 1);
});

test("a page with no </body> still gets the tag", () => {
  const fragment = `<!doctype html><meta http-equiv="Content-Security-Policy" content="script-src 'self'">\n`;
  const { html, changed } = patchIndexHtml(fragment);
  assert.equal(changed, true);
  assert.ok(html.trimEnd().endsWith(PROBE_TAG));
});

test("a page with no CSP is refused, because there would be nothing to measure", () => {
  const noCsp = PAGE.replace(/<meta http-equiv[^>]*>\n/, "");
  assert.throws(() => patchIndexHtml(noCsp), /no Content-Security-Policy/);
});

test("something that is not HTML is refused", () => {
  for (const bad of ["", "   ", "{}", "console.log(1)", null, 42]) {
    assert.throws(() => patchIndexHtml(bad), /does not look like an HTML document|Content-Security-Policy/);
  }
});

test("everything else in the page is left alone", () => {
  const { html } = patchIndexHtml(PAGE);
  assert.equal(html.replace(PROBE_TAG + "\n", ""), PAGE);
});

/* ──────────────── refusing to write anywhere but a build artefact ────────── */

test("the repo root is refused", () => {
  /* The failure this prevents is the worst one available: patching the committed
     index.html would put a probe script, and a navigation away from the app, on
     the live website. */
  assert.throws(() => assertBuildArtefact(REPO_ROOT), /refusing to patch the repo root/);
});

test("anything that looks like a source checkout is refused", () => {
  for (const marker of [".git", "CLAUDE.md", "sw.js", "package.json"]) {
    const dir = tmpBundle();
    fs.writeFileSync(path.join(dir, marker), "x");
    assert.throws(() => assertBuildArtefact(dir), new RegExp(`contains ${marker.replace(".", "\\.")}`));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("`sw.js` being a refusal marker is not an accident", () => {
  /* prepare-webdir.mjs refuses to place sw.js in the bundle at all (#209 §2), so
     a directory that has one is a checkout rather than a bundle. The marker does
     double duty: it also means this script can never patch a directory that
     somehow acquired a service worker. */
  const dir = tmpBundle();
  fs.writeFileSync(path.join(dir, "sw.js"), "self.addEventListener('fetch', () => {});");
  assert.throws(() => assertBuildArtefact(dir), /sw\.js/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a bundle with no player/ is refused", () => {
  /* The out-point probe drives the REAL html-audio-backend.js. If it is not
     there, the probe would be measuring a reimplementation of the thing under
     test, which is worth nothing. */
  const dir = tmpBundle();
  fs.rmSync(path.join(dir, "player"), { recursive: true, force: true });
  assert.throws(() => assertBuildArtefact(dir), /html-audio-backend/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a directory with no index.html is refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-probe-"));
  assert.throws(() => assertBuildArtefact(dir), /no index\.html/);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ────────────────────────────── the tone file ────────────────────────────── */

test("the tone is a valid RIFF/WAVE header with matching sizes", () => {
  const buf = makeToneWav({ seconds: 1, sampleRate: 8000 });
  assert.equal(buf.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(buf.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(buf.subarray(12, 16).toString("ascii"), "fmt ");
  assert.equal(buf.subarray(36, 40).toString("ascii"), "data");
  assert.equal(buf.readUInt16LE(20), 1, "PCM");
  assert.equal(buf.readUInt16LE(22), 1, "mono");
  assert.equal(buf.readUInt32LE(24), 8000, "sample rate");
  assert.equal(buf.readUInt16LE(34), 16, "bits per sample");
  const dataBytes = buf.readUInt32LE(40);
  assert.equal(dataBytes, 8000 * 2);
  assert.equal(buf.length, 44 + dataBytes);
  assert.equal(buf.readUInt32LE(4), 36 + dataBytes, "RIFF size disagrees with the data chunk");
  assert.equal(buf.readUInt32LE(28), 8000 * 2, "byte rate");
});

test("the tone actually contains a signal, not silence", () => {
  /* A silent file would look identical to every structural check above and would
     invalidate the whole measurement: WebKit's background audio assertion is
     gated on the page being AUDIBLE (MP1 §7.4). */
  const buf = makeToneWav({ seconds: 1 });
  let peak = 0;
  for (let i = 44; i < buf.length; i += 2) peak = Math.max(peak, Math.abs(buf.readInt16LE(i)));
  assert.ok(peak > 1000, `peak sample is ${peak}, which is inaudible`);
});

test("the tone outlasts the observation window by a wide margin", () => {
  /* If the file ends first, `ended` fires, the backend reports END_NATURAL, and a
     natural end gets mistaken for an out-point — a false PASS on the exact
     question #38 is asking. The workflow's timeline is ~70 s. */
  assert.ok(TONE_SECONDS >= 120, `TONE_SECONDS is ${TONE_SECONDS}; the probe window is ~70 s`);
});

test("the tone is generated, not committed", () => {
  /* This repo guards a 3 MB native bundle. A ~2.4 MB WAV in git for a CI-only
     probe would be absurd, and it is deterministic anyway. */
  assert.equal(fs.existsSync(path.join(PROBE_DIR, TONE_NAME)), false);
});

/* ──────────────────────────── the whole install ───────────────────────────── */

test("installing puts every asset and the tone into the bundle", () => {
  const dir = tmpBundle();
  const r = installProbe(dir);
  assert.equal(r.indexPatched, true);
  for (const asset of [...PROBE_ASSETS, TONE_NAME]) {
    assert.ok(fs.existsSync(path.join(dir, asset)), `${asset} was not installed`);
  }
  assert.match(fs.readFileSync(path.join(dir, "index.html"), "utf8"), /probe-bridge\.js/);
  /* Re-running must not double the tag or fail. */
  const again = installProbe(dir);
  assert.equal(again.indexPatched, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("installProbe ITSELF refuses the checkout, not just assertBuildArtefact", () => {
  /* AN ADVERSARIAL PASS DEFEATED THIS SUITE HERE. Every guard test above called
     `assertBuildArtefact` directly, so replacing its call inside `installProbe`
     with `path.resolve(dir)` left all 23 tests green — while the entry point the
     workflow actually invokes would happily patch the repo's own index.html and
     copy a probe onto the live website. Test the door, not the lock sitting next
     to it. */
  assert.throws(() => installProbe(REPO_ROOT), /refusing to patch the repo root/);
  assert.throws(() => installProbe(REPO_ROOT, { write: false }), /refusing to patch the repo root/);
  const dir = tmpBundle();
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "x");
  assert.throws(() => installProbe(dir), /source checkout/);
  fs.rmSync(dir, { recursive: true, force: true });
  /* And nothing was written to the repo on the way to throwing. */
  for (const asset of [...PROBE_ASSETS, TONE_NAME]) {
    assert.equal(fs.existsSync(path.join(REPO_ROOT, asset)), false, `${asset} was written to the repo root`);
  }
});

test("--list mode writes nothing", () => {
  const dir = tmpBundle();
  const before = fs.readdirSync(dir).sort();
  installProbe(dir, { write: false });
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ─────────────── the probe assets' own shape, checked as text ─────────────── */

const asset = (name) => fs.readFileSync(path.join(PROBE_DIR, name), "utf8");

test("every declared probe asset exists in the repo", () => {
  for (const a of PROBE_ASSETS) assert.ok(fs.existsSync(path.join(PROBE_DIR, a)), `${a} is missing`);
});

test("the out-point probe page forbids inline script and style, like everything else here", () => {
  /* Its CSP differs from index.html's in exactly one way — `media-src 'self'`
     instead of `media-src https:`, so it can play the bundled tone — and that
     difference is documented in the file. `'unsafe-inline'` must be as absent
     here as in the shipped page; a probe page that relaxed it would be a
     precedent sitting in the repo. */
  const html = asset("probe-outpoint.html");
  const m = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);
  assert.ok(m, "the probe page has no Content-Security-Policy meta tag");
  const csp = m[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /media-src 'self'/);
  for (const bad of ["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'"]) {
    assert.equal(csp.includes(bad), false, `${bad} appeared in the probe page's CSP`);
  }
  /* And no inline script or style bodies, so the CSP above is not merely
     declared but honoured by the page that declares it. */
  assert.equal(/<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?<\/script>/.test(html), false, "inline <script> body");
  assert.equal(/<style[\s>]/.test(html), false, "inline <style> block");
  assert.equal(/\sstyle="/.test(html), false, "inline style attribute");
  assert.match(html, /<script type="module" src="probe-outpoint\.js"><\/script>/);
});

test("the out-point probe drives the real backend rather than a copy of it", () => {
  const js = asset("probe-outpoint.js");
  assert.match(js, /import \{ HtmlAudioBackend \} from "\.\/player\/html-audio-backend\.js"/);
  /* Uses the public contract, so the probe cannot drift from the shipped
     behaviour by reaching into private state. */
  assert.match(js, /\.setOutPoint\(/);
  assert.match(js, /lastOutPointOvershootSec/);
});

test("the bridge probe asks the one question, and reports the consequence", () => {
  const js = asset("probe-bridge.js");
  assert.match(js, /typeof window\.Capacitor/);
  assert.match(js, /isNativePlatform/);
  /* Invariant 3's consequence, measured rather than reasoned about. */
  assert.match(js, /getRegistrations/);
  assert.match(js, /securitypolicyviolation/);
});

test("neither probe is referenced from the committed index.html", () => {
  /* If a stray `install-probe` run were ever committed, the live site would ship
     a probe that navigates away from the app after three seconds. Cheap to
     check, catastrophic to miss. */
  const index = fs.readFileSync(path.join(REPO_ROOT, "index.html"), "utf8");
  for (const marker of ["probe-bridge", "probe-outpoint", TONE_NAME]) {
    assert.equal(index.includes(marker), false, `index.html references ${marker}`);
  }
});
