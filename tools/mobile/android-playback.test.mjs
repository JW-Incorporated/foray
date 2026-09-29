/* `tools/mobile/android-playback.mjs` (A-04): the half of the playback scenarios
 * that decides PASS or FAIL.
 *
 * WHAT THIS FILE CANNOT DO: run the scenarios. They need the emulator, and only
 * `.github/workflows/android-playback.yml` has one; its run is the evidence, and
 * the PR says which run. What this file CAN do is hold the verdicts to the
 * shapes the platform really prints. The `dumpsys` fixtures are A-03's own
 * output from run 36539778610 (`tools/mobile/fixtures/android-playback/`),
 * copied unedited, so a parser that works here works on what API 34 says.
 *
 * EVERY TEST NAMES THE MUTATION THAT BREAKS IT, and each was run.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import {
  CLIPS,
  EPISODE,
  FIXTURE_PATH,
  FORAY_ID,
  GATES,
  INSETS_EXPRESSION,
  INSTRUMENT_EXPRESSION,
  DIAGNOSTICS_EXPRESSION,
  PKG,
  PRESSES,
  SCENARIOS,
  SHOW,
  STATE_EXPRESSION,
  center,
  fixtureDocs,
  foregroundService,
  jumpExpression,
  mediaControls,
  mediaSessions,
  parseArgs,
  pngInfo,
  startEpisodeExpression,
  startForayExpression,
  summaryMarkdown,
  uiNodes,
  verdictBackground,
  verdictNotification,
  verdictPlay,
  verdictPress,
  wakefulness,
} from "./android-playback.mjs";
import { findForay, indexSegments, indexSources, resolveForay } from "../../player/foray-resolve.js";
import { CLICK_TRACK_DIR } from "../audio/click-tracks.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const FIX = path.join(HERE, "fixtures", "android-playback");
const SERVICES = fs.readFileSync(path.join(FIX, "a03-dumpsys-activity-services.txt"), "utf8");
const SESSIONS = fs.readFileSync(path.join(FIX, "a03-dumpsys-media_session.txt"), "utf8");

/* ─────────────────────────── the fixture Foray ─────────────────────────── */

test("the fixture Foray resolves through the player's own join into three playable clips", () => {
  /* MUTATION: drop `end_sec` from a fixture segment -> fails (the queue skips a
     segment without an out-point). MUTATION: set the Foray to `status: "draft"`
     and drop `unlocked` from the call -> `findForay` answers null.
     The scenarios hand these documents to `ForayPlayer.resolve`, which is this
     same join, so a document the join refuses would fail on the emulator with
     "resolve returned null" at the end of a ten-minute job. Here it fails in
     milliseconds. */
  const docs = fixtureDocs();
  const doc = findForay(docs.forays, FORAY_ID, { unlocked: [FORAY_ID] });
  assert.ok(doc, "the fixture Foray is not findable");
  const resolved = resolveForay(doc, { segments: indexSegments(docs.segments), sources: indexSources(docs.sources) });
  assert.equal(resolved.playable.length, CLIPS.length, `unplayable: ${JSON.stringify(resolved.unplayable)}`);
  assert.deepEqual(resolved.unplayable, []);
  resolved.playable.forEach((item, i) => {
    assert.equal(item.audio_url, `https://localhost${FIXTURE_PATH}${CLIPS[i].file}`);
  });
  assert.deepEqual(resolved.shows, [SHOW]);
});

test("every clip the scenarios play is a committed click track, longer than its out-point", () => {
  /* MUTATION: rename a clip's file to `click-missing.mp3` -> fails. MUTATION:
     set an `endSec` to 95 -> fails (the out-point would be past the file's end,
     and the clip would end by running out rather than by the out-point).
     The job copies CLICK_TRACK_DIR into the APK, so a file that is not there is
     a 404 inside the app. */
  const descriptor = JSON.parse(fs.readFileSync(path.join(ROOT, CLICK_TRACK_DIR, "click-tracks.json"), "utf8"));
  const byFile = new Map(descriptor.fixtures.map((f) => [f.file, f]));
  for (const c of [...CLIPS, { ...EPISODE, endSec: 0 }]) {
    const f = byFile.get(c.file);
    assert.ok(f, `${c.file} is not a committed click track`);
    assert.ok(fs.existsSync(path.join(ROOT, CLICK_TRACK_DIR, c.file)), `${c.file} is named but not on disk`);
    assert.ok(f.durationSec > c.endSec, `${c.file} is ${f.durationSec} s; an out-point at ${c.endSec} s is past its end`);
  }
  assert.equal(new Set(CLIPS.map((c) => c.title)).size, CLIPS.length, "each clip needs its own title, or (a) cannot tell which is playing");
});

/* ─────────────────────────── the system's side ─────────────────────────── */

test("the foreground service is read from API 34's real ServiceRecord", () => {
  /* MUTATION: parse `types=` as decimal, or test bit 0x1 -> the mediaPlayback
     assertions fail. MUTATION: take the first ServiceRecord instead of ours ->
     fails (the first one here IS ours, so the second case below is the one that
     catches it: the WebView's SandboxedProcessService is not foreground).
     A-03's dump says `types=00000002`, not the card's
     `foregroundServiceType=mediaPlayback`; both spellings are accepted. */
  const s = foregroundService(SERVICES);
  assert.deepEqual(
    { found: s.found, isForeground: s.isForeground, types: s.types, mediaPlayback: s.mediaPlayback },
    { found: true, isForeground: true, types: 2, mediaPlayback: true }
  );
  const sandbox = foregroundService(SERVICES, "SandboxedProcessService0");
  assert.equal(sandbox.found, true);
  assert.equal(sandbox.isForeground, false, "the WebView's sandbox is not a foreground service");
  assert.equal(sandbox.mediaPlayback, false);
  const dataSync = foregroundService(SERVICES.replace("types=00000002", "types=00000001"));
  assert.equal(dataSync.mediaPlayback, false, "dataSync (0x1) is not mediaPlayback");
  const named = foregroundService(SERVICES.replace("types=00000002", "foregroundServiceType=mediaPlayback"));
  assert.equal(named.mediaPlayback, true, "the card's spelling is accepted too");
  const stopped = foregroundService(SERVICES.replace("isForeground=true", "isForeground=false"));
  assert.equal(stopped.isForeground, false);
  const gone = foregroundService(SERVICES.replace(/PlaybackKeepAliveService/g, "SomethingElse"));
  assert.equal(gone.found, false, "no record for our service is a not-found, not a pass");
});

test("our media session, its state and its description are read from the real dump", () => {
  /* MUTATION: stop resetting the record on a less-indented line -> the
     Bluetooth session's ERROR state is attributed to ours and fails.
     MUTATION: read `state=` from the first line that has one in the whole dump
     -> the telecom session's `state=null` comes first and fails. */
  const m = mediaSessions(SESSIONS);
  assert.equal(m.mediaButtonSession, `${PKG}/androidx.media3.session.id.foray`);
  const ours = m.sessions.filter((s) => s.package === PKG);
  assert.equal(ours.length, 1);
  assert.equal(ours[0].state, "PLAYING");
  assert.equal(ours[0].description, "A-03 spike, 4a CI, null");
  assert.equal(ours[0].customActions, "");
  const bt = m.sessions.filter((s) => s.package === "com.google.android.bluetooth");
  assert.ok(bt.length >= 1);
  assert.ok(bt.every((s) => s.state === "ERROR"), "the Bluetooth sessions keep their own state");
  const paused = mediaSessions(SESSIONS.replace("state=PLAYING(3)", "state=PAUSED(2)"));
  assert.equal(paused.sessions.find((s) => s.package === PKG).state, "PAUSED");
});

test("wakefulness is read from dumpsys power", () => {
  /* MUTATION: return "Asleep" when the line is absent -> fails. */
  assert.equal(wakefulness("Power Manager State:\n  mWakefulness=Asleep\n  mWakefulnessChanging=false"), "Asleep");
  assert.equal(wakefulness("  mWakefulness=Awake"), "Awake");
  assert.equal(wakefulness("nothing here"), null);
});

/* ─────────────────────────────── (a) play ─────────────────────────────── */

function playInputs(over = {}) {
  const payload = { state: "playing", title: "A-03 spike", artist: "4a CI", album: "" };
  return {
    started: { ok: true, playable: 3 },
    first: { at: 1000, element: { t: 1.0, paused: false }, payload, forayPolyfill: true },
    last: { at: 6100, element: { t: 6.05, paused: false }, payload, forayPolyfill: true },
    service: foregroundService(SERVICES),
    sessions: mediaSessions(SESSIONS),
    expected: { title: "A-03 spike", artist: "4a CI" },
    ...over,
  };
}

test("(a) passes on A-03's real system state and a clock that moved 5 s", () => {
  /* MUTATION: invert any clause in `verdictPlay` -> this or a case below fails. */
  const v = verdictPlay(playInputs());
  assert.equal(v.ok, true, v.failures.join("; "));
  assert.equal(v.measured.advancedSec, 5.05);
});

test("(a) fails on each thing the card names, one at a time", () => {
  /* MUTATION: drop any one of the five checks -> its case passes and this
     fails. The service case is the card's own mutation ("break the service
     start"): with no service there is no record and no session. */
  const cases = {
    "a clock that moved 2 s": { last: { ...playInputs().last, element: { t: 3.0 } } },
    "no element at all": { first: { ...playInputs().first, element: null } },
    "no service": { service: foregroundService("") },
    "a service that is not foreground": { service: foregroundService(SERVICES.replace("isForeground=true", "isForeground=false")) },
    "a session that is paused": { sessions: mediaSessions(SESSIONS.replace("state=PLAYING(3)", "state=PAUSED(2)")) },
    "no session of ours": { sessions: mediaSessions(SESSIONS.replace(/package=ai\.jwlabs\.foura/g, "package=other")) },
    "a session describing something else": { sessions: mediaSessions(SESSIONS.replace("description=A-03 spike, 4a CI", "description=4a, Playback active")) },
    "a payload that is not the fixture's": { expected: { title: "A-04 click one", artist: SHOW } },
    "the polyfill stepped aside": { last: { ...playInputs().last, forayPolyfill: false } },
    "the Foray never started": { started: { ok: false, error: "resolve returned null" } },
  };
  for (const [name, over] of Object.entries(cases)) {
    const v = verdictPlay(playInputs(over));
    assert.equal(v.ok, false, `${name} must fail (a)`);
    assert.ok(v.failures.length >= 1);
  }
  assert.equal(GATES.playMinAdvanceSec, 3, "the card's number");
  assert.equal(GATES.playWindowMs, 5000, "the card's number");
});

/* ───────────────────────────── (b) background ───────────────────────────── */

function bgInputs(over = {}) {
  return {
    first: { at: 0, foray: { elapsedSec: 12, running: true } },
    last: { at: 60000, foray: { elapsedSec: 71.5, running: true }, visibility: "hidden" },
    pidBefore: "3402",
    pidAfter: "3402",
    wake: "Asleep",
    service: foregroundService(SERVICES),
    ...over,
  };
}

test("(b) passes when the screen is off, the clock moved and the process is the same", () => {
  /* MUTATION: compare pids with `!=` on numbers parsed from different shapes
     -> the restarted case below would still catch it. */
  const v = verdictBackground(bgInputs());
  assert.equal(v.ok, true, v.failures.join("; "));
  assert.equal(v.measured.advancedSec, 59.5);
});

test("(b) fails on a frozen clock, a new pid, or a screen that never went off", () => {
  /* MUTATION: delete the wakefulness clause -> the "Awake" case passes.
     A background scenario whose screen stayed on measured the foreground, and
     would pass for exactly the app this card exists to catch. */
  const cases = {
    "a frozen clock": { last: { ...bgInputs().last, foray: { elapsedSec: 12.4, running: true } } },
    "a restarted process": { pidAfter: "4100" },
    "a dead process": { pidAfter: null },
    "a screen still on": { wake: "Awake" },
    "no clock at all": { first: { at: 0, foray: null } },
  };
  for (const [name, over] of Object.entries(cases)) {
    assert.equal(verdictBackground(bgInputs(over)).ok, false, `${name} must fail (b)`);
  }
  assert.equal(verdictBackground(bgInputs({ wake: "Dozing" })).ok, true, "Dozing is a screen that is off");
  assert.equal(GATES.backgroundWaitMs, 60000, "the card's 60 s");
});

/* ───────────────────────────── (c) transport ───────────────────────────── */

test("(c) presses cover four actions by both routes", () => {
  /* MUTATION: drop the KEYCODE_MEDIA_NEXT press -> fails. */
  const byRoute = (route) => PRESSES.filter((p) => p.route === route).map((p) => p.kind);
  assert.deepEqual(byRoute("dispatch"), ["pause", "play", "next", "previous"]);
  assert.deepEqual(byRoute("keyevent"), ["pause", "play", "next", "previous"]);
  for (const p of PRESSES) {
    if (p.route === "dispatch") assert.deepEqual(p.args.slice(0, 3), ["cmd", "media_session", "dispatch"]);
    else assert.match(p.args.join(" "), /^input keyevent KEYCODE_MEDIA_(PAUSE|PLAY|NEXT|PREVIOUS)$/);
  }
});

test("(c) a press passes only when it reached the page AND the page did it", () => {
  /* MUTATION: accept a press with no `foray:remote` row -> the "never arrived"
     case passes. MUTATION: accept an unhandled row -> the "no handler" case
     passes. Comparing state alone could be fooled by the player doing the same
     thing on its own (a clip ending looks like "next"); the row alone could be
     fooled by a handler that ran and did nothing. Both are required. */
  const at = (foray, remote = []) => ({ foray, remote });
  const before = at({ index: 0, running: true, elapsedSec: 20 }, [{ action: "x" }]);
  const ok = (kind, foray, action, handled = true) =>
    verdictPress({ kind, before, after: at(foray, [{ action: "x" }, { action, handled }]), sinceRemote: 1 });
  assert.equal(ok("pause", { index: 0, running: false, elapsedSec: 20 }, "pause").ok, true);
  assert.equal(ok("play", { index: 0, running: true, elapsedSec: 20 }, "play").ok, true);
  assert.equal(ok("next", { index: 1, running: true, elapsedSec: 85 }, "nexttrack").ok, true);
  assert.equal(ok("previous", { index: 0, running: true, elapsedSec: 0.2 }, "previoustrack").ok, true);

  assert.equal(ok("pause", { index: 0, running: true, elapsedSec: 21 }, "pause").ok, false, "still running");
  assert.equal(ok("pause", { index: 0, running: false, elapsedSec: 20 }, "pause", false).ok, false, "no handler");
  assert.equal(ok("pause", { index: 0, running: false, elapsedSec: 20 }, "play").ok, false, "the wrong action");
  assert.equal(ok("next", { index: 0, running: true, elapsedSec: 25 }, "nexttrack").ok, false, "did not move");
  assert.equal(ok("previous", { index: 0, running: true, elapsedSec: 19.5 }, "previoustrack").ok, false, "half a second is not a previous");
  /* The row must be NEW: one from before the press does not count. */
  const stale = verdictPress({
    kind: "pause",
    before: at({ index: 0, running: true, elapsedSec: 20 }, [{ action: "pause", handled: true }]),
    after: at({ index: 0, running: false, elapsedSec: 20 }, [{ action: "pause", handled: true }]),
    sinceRemote: 1,
  });
  assert.equal(stale.ok, false, "never arrived");
});

/* ─────────────────────────── (d) the notification ─────────────────────────── */

/* SYNTHETIC, and marked so: the shape of a `uiautomator dump`, with SystemUI's
   media controls. The first CI run's real dump (`d-window-*.xml`) is the
   evidence for the live shape; this pins the parser and the matching rules. */
const SHADE = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.android.systemui" content-desc="" bounds="[0,0][1080,2400]">
<node index="1" text="A-04 single episode" resource-id="com.android.systemui:id/header_title" class="android.widget.TextView" package="com.android.systemui" content-desc="" bounds="[80,300][800,360]" />
<node index="2" text="4a CI fixtures" resource-id="com.android.systemui:id/header_artist" class="android.widget.TextView" package="com.android.systemui" content-desc="" bounds="[80,360][800,410]" />
<node index="3" text="" resource-id="com.android.systemui:id/action0" class="android.widget.ImageButton" package="com.android.systemui" content-desc="Back 15 seconds" bounds="[100,500][220,620]" />
<node index="4" text="" resource-id="com.android.systemui:id/actionPlayPause" class="android.widget.ImageButton" package="com.android.systemui" content-desc="Pause" bounds="[300,500][420,620]" />
<node index="5" text="" resource-id="com.android.systemui:id/action1" class="android.widget.ImageButton" package="com.android.systemui" content-desc="Forward 30 seconds" bounds="[500,500][620,620]" />
<node index="6" text="Tom &amp; Jerry &quot;live&quot;" resource-id="" class="android.widget.TextView" package="com.android.systemui" content-desc="" bounds="[0,0][0,0]" />
</node></hierarchy>`;

test("(d) the shade's controls are found by our title, our show, their labels and their bounds", () => {
  /* MUTATION: match the 15 button on /15/ alone -> the "15 minutes ago" case
     finds a timestamp. MUTATION: drop the zero-area filter -> a collapsed node
     is tapped at 0,0. */
  const nodes = uiNodes(SHADE);
  assert.equal(nodes.length, 7);
  assert.equal(nodes[6].text, 'Tom & Jerry "live"', "entities are decoded");
  const c = mediaControls(nodes, { title: EPISODE.title, artist: SHOW });
  assert.equal(c.title.id, "com.android.systemui:id/header_title");
  assert.equal(c.artist.id, "com.android.systemui:id/header_artist");
  assert.equal(c.back15.desc, "Back 15 seconds");
  assert.equal(c.forward30.desc, "Forward 30 seconds");
  assert.deepEqual(center(c.pause.bounds), { x: 360, y: 560 });
  assert.equal(c.play, null);
  const noise = uiNodes(SHADE.replace('content-desc="Back 15 seconds"', 'content-desc="15 minutes ago"'));
  assert.equal(mediaControls(noise, { title: EPISODE.title, artist: SHOW }).back15, null);
  const hidden = uiNodes(SHADE.replace('bounds="[300,500][420,620]"', 'bounds="[0,0][0,0]"'));
  assert.equal(mediaControls(hidden, { title: EPISODE.title, artist: SHOW }).pause, null);
});

test("(d) passes only with all four controls shown and a tap that paused the page", () => {
  /* MUTATION: drop the forward30 clause -> the case without it passes. */
  const controls = mediaControls(uiNodes(SHADE), { title: EPISODE.title, artist: SHOW });
  const after = { foray: null, episodePlaying: false, remote: [{ action: "play" }, { action: "pause", handled: true }] };
  const base = { controls, expected: { title: EPISODE.title, artist: SHOW }, tapped: { at: { x: 1, y: 1 } }, after, sinceRemote: 1 };
  assert.equal(verdictNotification(base).ok, true, verdictNotification(base).failures.join("; "));
  for (const k of ["title", "artist", "back15", "forward30"]) {
    assert.equal(verdictNotification({ ...base, controls: { ...controls, [k]: null } }).ok, false, `no ${k} must fail (d)`);
  }
  assert.equal(verdictNotification({ ...base, controls: null }).ok, false, "an unreadable shade");
  assert.equal(verdictNotification({ ...base, tapped: null }).ok, false, "nothing tapped");
  assert.equal(verdictNotification({ ...base, after: { ...after, episodePlaying: true } }).ok, false, "still playing");
  assert.equal(verdictNotification({ ...base, after: { ...after, remote: [{ action: "play" }] } }).ok, false, "the tap never reached the page");
});

/* ───────────────────────────── (e) and the rest ───────────────────────────── */

test("(e) a screenshot is a PNG with a size, or it is not a screenshot", () => {
  /* MUTATION: return an object for any buffer -> the empty case passes. */
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(1080, 16);
  png.writeUInt32BE(2400, 20);
  assert.deepEqual(pngInfo(png), { width: 1080, height: 2400, bytes: 33 });
  assert.equal(pngInfo(Buffer.alloc(0)), null);
  assert.equal(pngInfo(Buffer.from("error: device offline, and some more bytes to pass 24")), null);
});

test("the page expressions compile, and the instrument and the state read run in a fake page", () => {
  /* MUTATION: a syntax error in any expression -> fails here rather than as a
     `the page threw` at the end of a CI job. MUTATION: stop recording
     `foray:remote` in the instrument -> the remote row assertion fails. */
  for (const expr of [
    INSTRUMENT_EXPRESSION, STATE_EXPRESSION, INSETS_EXPRESSION, DIAGNOSTICS_EXPRESSION,
    startForayExpression(), startEpisodeExpression(), jumpExpression(2),
  ]) {
    assert.doesNotThrow(() => new vm.Script(`(${expr})`), expr.slice(0, 80));
  }
  const listeners = {};
  class HTMLMediaElement {
    play() {
      this.paused = false;
      return "played";
    }
  }
  const window = {
    addEventListener: (n, fn) => {
      listeners[n] = fn;
    },
    ForayPlayer: {
      forayStatus: () => ({ index: 1, playing: true, running: true, loading: false, gap: false, ended: false, elapsedSec: 90, totalSec: 255, error: null }),
      isPlaying: () => false,
    },
    ForayMediaSession: {
      peek: () => ({ state: "playing", title: "A-04 click two", artist: SHOW, album: "x" }),
      inspect: () => ({ installed: true, actions: ["play"], sends: 3, state: "playing" }),
    },
  };
  const ctx = vm.createContext({
    window,
    HTMLMediaElement,
    navigator: { mediaSession: { forayPolyfill: true } },
    document: { visibilityState: "hidden" },
    Date,
  });
  assert.equal(vm.runInContext(INSTRUMENT_EXPRESSION, ctx), true);
  const el = new HTMLMediaElement();
  el.src = `https://localhost${FIXTURE_PATH}click-vbr-xing.mp3`;
  el.currentTime = 4.5;
  el.paused = true;
  assert.equal(el.play(), "played", "the wrapper returns what play() returns");
  const other = new HTMLMediaElement();
  other.src = "https://example.com/not-ours.mp3";
  other.play();
  listeners["foray:remote"]({ detail: { action: "pause", handled: true, origin: "media3" } });
  /* Through JSON, as DevTools' `returnByValue` delivers it (and so the arrays
     are this realm's, not the sandbox's). */
  const s = JSON.parse(JSON.stringify(vm.runInContext(STATE_EXPRESSION, ctx)));
  assert.equal(s.elements, 1, "only our fixture's elements are counted");
  assert.equal(s.element.t, 4.5);
  assert.equal(s.foray.index, 1);
  assert.equal(s.payload.title, "A-04 click two");
  assert.equal(s.forayPolyfill, true);
  assert.deepEqual(s.remote.map((r) => [r.action, r.handled]), [["pause", true]]);
  assert.equal(vm.runInContext(INSTRUMENT_EXPRESSION, ctx), true);
  other.play();
  assert.equal(vm.runInContext(STATE_EXPRESSION, ctx).elements, 1, "installing twice does not double-wrap");
});

test("the start expressions call the page's own player with the fixture", () => {
  /* MUTATION: build the queue in the expression instead of calling playForay
     -> fails. The point of A-04 over A-03 is that the audio goes through the
     real player. */
  const f = startForayExpression();
  assert.match(f, /P\.resolve\(/);
  assert.match(f, /P\.playForay\(resolved/);
  assert.ok(f.includes(JSON.stringify(FORAY_ID)));
  assert.ok(f.includes(`https://localhost${FIXTURE_PATH}click-cbr.mp3`));
  const e = startEpisodeExpression();
  assert.match(e, /P\.play\(/);
  assert.ok(e.includes(EPISODE.title));
});

test("the summary lists all five scenarios in the card's order, and escapes a pipe", () => {
  /* MUTATION: drop a scenario from SCENARIOS -> fails. */
  assert.deepEqual(SCENARIOS.map(([id]) => id), ["play", "background", "transport", "notification", "first-launch"]);
  const md = summaryMarkdown({ play: { ok: true }, background: { ok: false, failures: ["a | b"] } });
  assert.match(md, /\(a\) play a bundled clip \| \*\*pass\*\*/);
  assert.match(md, /\(b\).*\*\*FAIL\*\* \| a \\\| b/);
  assert.match(md, /\(e\) first-launch screenshot \| not run/);
});

test("arguments: a scenario and an evidence directory, or a sentence saying which is missing", () => {
  /* MUTATION: default `--art` to the cwd -> the missing-art case passes, and a
     verdict lands somewhere the upload does not look. */
  assert.deepEqual(parseArgs(["play", "--art", "/tmp/x"]), { scenario: "play", endpoint: "http://127.0.0.1:9222", pkg: PKG, art: "/tmp/x" });
  assert.throws(() => parseArgs(["play"]), /--art DIR is required/);
  assert.throws(() => parseArgs(["dance", "--art", "x"]), /first argument must be one of/);
  assert.throws(() => parseArgs(["play", "--art"]), /--art needs a value/);
  assert.throws(() => parseArgs(["play", "--art", "x", "--wat"]), /unknown argument --wat/);
  assert.equal(parseArgs(["summary", "--art", "x"]).scenario, "summary");
});
