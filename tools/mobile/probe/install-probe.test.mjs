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
  DEFAULT_PHASE,
  PHASES,
  PHASE_ASSET,
  PROBE_ASSETS,
  PROBE_DIR,
  PROBE_PLAYER_DEPS,
  PROBE_TAG,
  REPO_ROOT,
  TONES,
  TONE_B_NAME,
  TONE_B_SECONDS,
  TONE_C_NAME,
  TONE_NAME,
  TONE_SECONDS,
  assertBuildArtefact,
  installProbe,
  makeToneWav,
  patchIndexHtml,
  phaseScript,
} from "./install-probe.mjs";

/* A minimal stand-in for the real page: the CSP meta tag is what the probe is
   measuring against, so a fixture without one must be refused. */
const PAGE =
  `<!doctype html>\n<html lang="en">\n<head>\n` +
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'">\n` +
  `<title>Foray</title>\n</head>\n<body>\n<div id="app"></div>\n` +
  `<script src="app.js"></script>\n</body>\n</html>\n`;

/** The player modules the probes drive. Both phases run the REAL shipped code —
 *  phase B `HtmlAudioBackend`, phase C `PlayerQueueManager` over it, with the real
 *  `seamGapSec` decision — so a bundle missing any of them must be refused. */
const REQUIRED_PLAYER_FILES = [
  "html-audio-backend.js",
  "queue-manager.js",
  "queue-state.js",
  "queue-strategy.js",
  "seam-gap.js",
  "seek-policy.js",
  "foray-queue.js",
];

function tmpBundle(page = PAGE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-probe-"));
  fs.writeFileSync(path.join(dir, "index.html"), page);
  fs.mkdirSync(path.join(dir, "player"));
  for (const f of REQUIRED_PLAYER_FILES) {
    fs.writeFileSync(path.join(dir, "player", f), `export const stub = ${JSON.stringify(f)};\n`);
  }
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

test("EVERY player module the probes drive is required, one at a time", () => {
  /* Not a single spot-check on html-audio-backend.js. The seam probe drives
     `PlayerQueueManager` and the real `seamGapSec` rule, and a bundle missing either
     would fail INSIDE the page — an import error in a WKWebView on a CI runner,
     which surfaces as "the probe reported nothing" and is indistinguishable from the
     seam genuinely stalling. That is the one confusion this whole phase exists to
     avoid, so the refusal happens on the host where the message can be read. */
  for (const f of REQUIRED_PLAYER_FILES) {
    const dir = tmpBundle();
    fs.rmSync(path.join(dir, "player", f), { force: true });
    assert.throws(() => assertBuildArtefact(dir), new RegExp(f.replace(/[.]/g, "\\.")));
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  for (const t of TONES) {
    assert.equal(fs.existsSync(path.join(PROBE_DIR, t.name)), false, `${t.name} is committed`);
  }
});

test("there are THREE distinct tones, which is what makes both seams a real load", () => {
  /* THE LOAD-BEARING ASSERTION FOR PHASE C. `html-audio-backend.js` short-circuits
     a same-URL load into a seek with no refetch ("SAME SOURCE = A SEEK, NOT A
     LOAD"), which is correct for consecutive segments of one episode and is the one
     path the seam measurement must not take — a seek inside an already-buffered file
     would answer a far easier question than "does a fresh media load complete while
     hidden". Three names, three frequencies, so they cannot silently collapse. */
  assert.equal(TONES.length, 3, "two tones force an A,B,A queue whose second load may hit the media cache");
  assert.equal(new Set(TONES.map((t) => t.name)).size, 3, "two tones share a name");
  assert.equal(new Set(TONES.map((t) => t.freq)).size, 3, "two tones share a frequency");
  for (const name of [TONE_NAME, TONE_B_NAME, TONE_C_NAME]) {
    assert.ok(TONES.some((t) => t.name === name), `${name} is exported but not in TONES`);
  }
  /* Distinct BYTES, not just distinct names — same-content files would defeat the
     point even with different names, since the measurement is about a cold load. */
  const rendered = TONES.map((t) => makeToneWav({ seconds: 1, freq: t.freq }).subarray(44).toString("hex"));
  assert.equal(new Set(rendered).size, 3, "two tones render identical audio");
  /* Long enough for its own segment plus margin, and no longer: it is only used for
     ~8 s. If it were shorter than the segment it carries, `ended` would fire and a
     natural end would be recorded as a completed transition. */
  assert.ok(TONE_B_SECONDS >= 30, `TONE_B_SECONDS is ${TONE_B_SECONDS}`);
});

/* ─────────────────────────── the phase mechanism ──────────────────────────── */

test("the phase file is a bare assignment and nothing else", () => {
  /* It is loaded into the page under `script-src 'self'`, so it must be a real
     external file with no inline anything, and it must not be able to fail: a phase
     file that threw would leave `probe-bridge.js` navigating nowhere, which is a
     green run that measured nothing. */
  for (const phase of PHASES) {
    const src = phaseScript(phase);
    assert.match(src, /^window\.FORAY_PROBE_PHASE = "[a-z]+";\n$/);
    assert.ok(src.includes(`"${phase}"`));
  }
});

test("an unknown phase is refused BEFORE anything is written", () => {
  /* A typo'd `--phase` must not install a probe that lands on the default and get
     reported as the phase that was asked for — that is a run measuring one thing and
     labelled another. */
  for (const bad of ["native", "outpoints", "", null, undefined, 7]) {
    assert.throws(() => phaseScript(bad), /unknown probe phase/);
  }
  const dir = tmpBundle();
  const before = fs.readdirSync(dir).sort();
  assert.throws(() => installProbe(dir, { phase: "nope" }), /unknown probe phase/);
  assert.deepEqual(fs.readdirSync(dir).sort(), before, "a refused phase still wrote files");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the default phase is the out-point one, so a missing --phase changes nothing", () => {
  assert.equal(DEFAULT_PHASE, "outpoint");
  assert.ok(PHASES.includes("outpoint"));
  assert.ok(PHASES.includes("seam"));
  const dir = tmpBundle();
  const r = installProbe(dir);
  assert.equal(r.phase, "outpoint");
  assert.equal(fs.readFileSync(path.join(dir, PHASE_ASSET), "utf8"), phaseScript("outpoint"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("re-installing with a different phase rewrites only the phase file", () => {
  /* This is how the workflow runs two passes over one built .app. If the phase file
     were not rewritten, pass 2 would silently re-run pass 1 and the report would
     carry a seam verdict of "nothing measured" with no error anywhere. */
  const dir = tmpBundle();
  installProbe(dir, { phase: "outpoint" });
  const indexBefore = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  const r = installProbe(dir, { phase: "seam" });
  assert.equal(r.phase, "seam");
  assert.equal(r.indexPatched, false, "the tag must not be added twice");
  assert.equal(fs.readFileSync(path.join(dir, "index.html"), "utf8"), indexBefore);
  assert.match(fs.readFileSync(path.join(dir, PHASE_ASSET), "utf8"), /"seam"/);
  fs.rmSync(dir, { recursive: true, force: true });
});


/* ──────────────────────────── the whole install ───────────────────────────── */

test("installing puts every asset and both tones into the bundle", () => {
  const dir = tmpBundle();
  const r = installProbe(dir);
  assert.equal(r.indexPatched, true);
  for (const asset of [...PROBE_ASSETS, ...TONES.map((t) => t.name), PHASE_ASSET]) {
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
  for (const asset of [...PROBE_ASSETS, ...TONES.map((t) => t.name), PHASE_ASSET]) {
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

test("no probe is referenced from the committed index.html", () => {
  /* If a stray `install-probe` run were ever committed, the live site would ship
     a probe that navigates away from the app after three seconds. Cheap to
     check, catastrophic to miss. */
  const index = fs.readFileSync(path.join(REPO_ROOT, "index.html"), "utf8");
  for (const marker of ["probe-bridge", "probe-outpoint", "probe-seam", PHASE_ASSET, ...TONES.map((t) => t.name)]) {
    assert.equal(index.includes(marker), false, `index.html references ${marker}`);
  }
});

test("probe-bridge.js knows every phase, and defaults to one of them", () => {
  /* The two lists live in different files by necessity — one is a Node module, the
     other runs in the page — so nothing but a test can hold them together. A phase
     the bridge does not know about is a navigation that never happens, which reads
     as "the probe measured nothing" rather than as a routing bug. */
  const js = asset("probe-bridge.js");
  for (const phase of PHASES) {
    assert.match(
      js,
      new RegExp(`${phase}:\\s*"probe-${phase}\\.html"`),
      `probe-bridge.js has no route for the ${phase} phase`
    );
  }
  assert.match(js, new RegExp(`DEFAULT_PHASE = "${DEFAULT_PHASE}"`));
  assert.match(js, new RegExp(PHASE_ASSET.replace(/[.]/g, "\\.")), "the bridge never loads the phase file");
  /* A dynamically inserted EXTERNAL script, never inline. `script-src 'self'` is
     the rule this harness exists to measure and must not need an exception of its
     own to run. */
  assert.match(js, /createElement\("script"\)/);
  assert.equal(/eval\(|new Function|innerHTML/.test(js), false, "the bridge must not evaluate anything inline");
});

test("the seam probe page forbids inline script and style, like every other page here", () => {
  const html = asset("probe-seam.html");
  const m = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);
  assert.ok(m, "the seam probe page has no Content-Security-Policy meta tag");
  const csp = m[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  /* `media-src 'self'` is the ONE difference from the shipped page's policy, and it
     is what lets the two bundled tones play. The shipped page correctly refuses
     local media. */
  assert.match(csp, /media-src 'self'/);
  for (const bad of ["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'"]) {
    assert.equal(csp.includes(bad), false, `${bad} appeared in the seam probe page's CSP`);
  }
  assert.equal(/<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?<\/script>/.test(html), false, "inline <script> body");
  assert.equal(/<style[\s>]/.test(html), false, "inline <style> block");
  assert.equal(/\sstyle="/.test(html), false, "inline style attribute");
  assert.match(html, /<script type="module" src="probe-seam\.js"><\/script>/);
});

test("the seam probe drives the REAL queue manager, not a copy of the seam logic", () => {
  /* THE ASSERTION THAT MAKES PHASE C WORTH RUNNING. The thing under test is the
     chain `queue-manager.js` runs at a seam — its own `REAL_SCHEDULER` setTimeout for
     the beat, its own reducer, its own cross-episode `load()`. A probe that
     reimplemented "wait 2 s then load the next one" would be measuring its own
     ten lines and would pass while the shipped player stalled. */
  const js = asset("probe-seam.js");
  assert.match(js, /import \{ PlayerQueueManager \} from "\.\/player\/queue-manager\.js"/);
  assert.match(js, /import \{ HtmlAudioBackend \} from "\.\/player\/html-audio-backend\.js"/);
  assert.match(js, /import \{ SEAM_GAP_SEC \} from "\.\/player\/seam-gap\.js"/);
  assert.match(js, /new PlayerQueueManager\(/);
  assert.match(js, /manager\.loadQueue\(/);
  assert.match(js, /manager\.play\(0\)/);
  /* It must NOT inject a fake scheduler. The beat's real `setTimeout` is the clock
     under suspicion — run 32026332637 measured hidden DOM timers at a 1000 ms median
     — so a scheduler override would remove the entire question. */
  assert.equal(/scheduler\s*:/.test(js), false, "the seam probe must not inject a scheduler");
  /* And it must not steal `onItemEnded` from the manager, which would break the very
     advance it is measuring. It wraps and calls through. */
  assert.match(js, /managerItemEnded\(reason\)/);
});

test("CONSECUTIVE queue items use DIFFERENT files, and every item is bounded", () => {
  /* A REVIEW DEFEATED THE FIRST VERSION OF THIS TEST IN ONE EDIT. It asserted
     `new Set(audioUrls).size >= 2` — a property of the SET — so changing seg-c from
     tone A to tone B left it green while making the seg-b -> seg-c transition take
     `html-audio-backend.js`'s `load.sameSource` path: "SAME SOURCE = A SEEK, NOT A
     LOAD", the one path this probe's own header says the measurement must not take.
     The load-bearing property is about CONSECUTIVE pairs, so that is what is
     asserted. (`seamTransitionVerdict` also measures it at runtime off the recorded
     `src` per item, because a test over a source literal is the weaker of the two.) */
  const js = asset("probe-seam.js");
  const urls = [...js.matchAll(/audio_url:\s*(TONE_[A-Z])/g)].map((m) => m[1]);
  assert.ok(urls.length >= 3, `expected at least 3 queue items, found ${urls.length}`);
  for (let i = 1; i < urls.length; i++) {
    assert.notEqual(
      urls[i],
      urls[i - 1],
      `queue items ${i - 1} and ${i} both use ${urls[i]}, so that transition is a seek with no refetch`
    );
  }
  /* And bounded, because an unbounded item arms no out-point and produces no
     transition to measure. */
  const items = [...js.matchAll(/\{ id: "seg-[a-z]", audio_url: [^}]*\}/g)].map((m) => m[0]);
  assert.equal(items.length, urls.length);
  for (const item of items) {
    assert.match(item, /start_sec:/, `queue item has no start_sec: ${item}`);
    assert.match(item, /end_sec:/, `queue item has no end_sec, so it arms no out-point: ${item}`);
  }
});

test("the seam probe cannot shorten the beat it is measuring", () => {
  /* THE SECOND ONE-EDIT DEFEAT A REVIEW FOUND. Adding `seamGapSec: 0.05` to the
     `PlayerQueueManager` options collapsed the 2.0 s beat — the throttled
     `setTimeout` that is the entire stated reason this phase exists — to 50 ms, and
     all 133 tests stayed green while the verdict still printed "the beat ran".
     Three things now stand against it, because one is evidently not enough: this
     assertion, the probe reading `askedGapMs` back off `manager.seamGapSec` rather
     than off the import so the record cannot hide the override, and
     `SEAM_MIN_PLAUSIBLE_MS` in the verdict flooring the OBSERVED gap. */
  const js = asset("probe-seam.js");
  const options = /new PlayerQueueManager\(\{([\s\S]*?)\}\)/.exec(js);
  assert.ok(options, "could not find the PlayerQueueManager construction");
  for (const forbidden of ["seamGapSec", "scheduler"]) {
    assert.equal(
      new RegExp(`${forbidden}\\s*:`).test(options[1]),
      false,
      `the probe overrides \`${forbidden}\`, which removes the mechanism it exists to measure`
    );
  }
  /* And the record must state the number actually in force. */
  assert.match(js, /rec\.askedGapMs = Math\.round\(\(typeof manager\.seamGapSec/);
});

test("the probes' whole player import closure is required, not a spot-check", () => {
  /* The list is read from the module rather than retyped here: two lists that must
     agree, maintained separately, is the drift this repo keeps paying for. */
  assert.deepEqual([...REQUIRED_PLAYER_FILES].sort(), [...PROBE_PLAYER_DEPS].sort());
  /* And every name in it is a real file, so a typo cannot make the guard vacuous. */
  for (const f of PROBE_PLAYER_DEPS) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, "player", f)), `player/${f} does not exist`);
  }
  /* Every module `probe-seam.js` imports directly must be in the list. */
  const js = asset("probe-seam.js");
  for (const m of js.matchAll(/from "\.\/player\/([\w-]+\.js)"/g)) {
    assert.ok(PROBE_PLAYER_DEPS.includes(m[1]), `probe-seam.js imports player/${m[1]}, which is not required`);
  }
});

test("the seam probe arms relative to going hidden, and records whether it did", () => {
  /* THE LESSON FROM THE TWO BAD RUNS, kept in code rather than in a comment. A fixed
     `end_sec` raced `simctl launch com.apple.Preferences` (which returns before
     Settings is actually foregrounded — ~39 s on one run) and produced two different
     verdicts from identical code. `armedWhileHidden` is what lets the verdict tell a
     measurement from a race. */
  const js = asset("probe-seam.js");
  assert.match(js, /visibilitychange/);
  assert.match(js, /ARM_AFTER_HIDDEN_SEC/);
  assert.match(js, /armedWhileHidden/);
  /* And the field that decides whether the run proves anything at all: a transition
     that completed after the app came back proves nothing. */
  assert.match(js, /resumedAtWall/);
  assert.match(js, /hiddenAtBoundary/);
  assert.match(js, /hiddenAtNextPlaying/);
});
