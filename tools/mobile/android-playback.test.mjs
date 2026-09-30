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
  AIRPLANE_FORAY,
  CLIPS,
  DOZE_FORAY,
  EPISODE,
  FIXTURE_PATH,
  FORAY_ID,
  GATES,
  HELPER_PKG,
  INSETS_EXPRESSION,
  INSTRUMENT_EXPRESSION,
  DIAGNOSTICS_EXPRESSION,
  KNOWN_FAILURES,
  LONG_FORAY,
  NARRATION_LINES,
  NARRATION_PATH,
  PKG,
  PRESSES,
  SCENARIOS,
  SEAMS_FORAY,
  SHOW,
  STATE_EXPRESSION,
  UNREACHABLE_NARRATION_URL,
  a15Trigger,
  advanced,
  applyKnown,
  buildForay,
  callState,
  center,
  currentFocus,
  fixtureDocs,
  focusPhase,
  focusStack,
  foregroundService,
  intLine,
  jingleIn,
  killLine,
  jumpExpression,
  mediaButtonRoute,
  mediaControls,
  mediaLogExpression,
  mediaSessions,
  parseArgs,
  pngInfo,
  receiverOf,
  ringExpression,
  seamStats,
  startEpisodeExpression,
  startForayExpression,
  summaryMarkdown,
  uiNodes,
  verdictAirplane,
  verdictBack,
  verdictBackground,
  verdictCall,
  verdictDoze,
  verdictFocus,
  verdictKill,
  verdictNotification,
  verdictPlay,
  verdictPress,
  verdictSeams,
  wakefulness,
  wasPlaying,
} from "./android-playback.mjs";
import { findForay, indexSegments, indexSources, resolveForay } from "../../player/foray-resolve.js";
import { CLICK_TRACK_DIR } from "../audio/click-tracks.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const FIX = path.join(HERE, "fixtures", "android-playback");
const SERVICES = fs.readFileSync(path.join(FIX, "a03-dumpsys-activity-services.txt"), "utf8");
const SESSIONS = fs.readFileSync(path.join(FIX, "a03-dumpsys-media_session.txt"), "utf8");
const AUDIO = fs.readFileSync(path.join(FIX, "run36551857323-dumpsys-audio-focus.txt"), "utf8");

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

test("(b) a dead process is reported with ActivityManager's own reason", () => {
  /* MUTATION: return the first `Killing` line whatever its pid -> the
     other-process case below names the wrong death. Run 36547348476's reason,
     verbatim: the app died holding GMS's FontsProvider when gms.persistent
     restarted. */
  const log = [
    "09-29 09:14:28.505   520  2239 I ActivityManager: Process com.google.android.gms.persistent (pid 1400) has died: fg  BFGS",
    "09-29 09:14:28.510   520  2239 I ActivityManager: Killing 999:com.example/u0a1 (adj 900): cached",
    "09-29 09:14:28.517   520  2239 I ActivityManager: Killing 2627:ai.jwlabs.foura/u0a192 (adj 200): depends on provider com.google.android.gms/.fonts.provider.FontsProvider in dying proc com.google.android.gms.persistent (adj -10000)",
  ].join("\n");
  const why = killLine(log, "2627");
  assert.match(why, /^Killing 2627:ai\.jwlabs\.foura\/u0a192 \(adj 200\): depends on provider com\.google\.android\.gms\/\.fonts/);
  assert.equal(killLine(log, "3000"), null);
  assert.match(killLine("I ActivityManager: Process ai.jwlabs.foura (pid 41) has died: fg SVC", "41"), /has died/);
  const v = verdictBackground(bgInputs({ pidAfter: null, killedBy: why }));
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => f.includes("FontsProvider")), "the failure carries the reason");
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
  const pausedBefore = at({ index: 0, running: false, elapsedSec: 20 }, [{ action: "x" }]);
  const ok = (kind, foray, action, handled = true) =>
    verdictPress({ kind, before: kind === "play" ? pausedBefore : before, after: at(foray, [{ action: "x" }, { action, handled }]), sinceRemote: 1 });
  assert.equal(ok("pause", { index: 0, running: false, elapsedSec: 20 }, "pause").ok, true);
  assert.equal(ok("play", { index: 0, running: true, elapsedSec: 20 }, "play").ok, true);
  /* MUTATION: drop the before-state clause -> a pause sent to a page that was
     already paused (a set-up that failed) passes with a handler that did
     nothing, and a play sent to a running page likewise. */
  const vacuousPause = verdictPress({ kind: "pause", before: pausedBefore,
    after: at({ index: 0, running: false, elapsedSec: 20 }, [{ action: "x" }, { action: "pause", handled: true }]), sinceRemote: 1 });
  assert.equal(vacuousPause.ok, false, "a pause of a paused page measures nothing");
  const vacuousPlay = verdictPress({ kind: "play", before,
    after: at({ index: 0, running: true, elapsedSec: 21 }, [{ action: "x" }, { action: "play", handled: true }]), sinceRemote: 1 });
  assert.equal(vacuousPlay.ok, false, "a play of a running page measures nothing");
  /* The before clause is not A04-F1's sentence, so it is never excused. */
  assert.equal(applyKnown("transport", vacuousPlay.failures.map((f) => `cmd media_session dispatch play: ${f}`)).ok, false);
  assert.equal(ok("next", { index: 1, running: true, elapsedSec: 85 }, "nexttrack").ok, true);
  assert.equal(ok("previous", { index: 0, running: true, elapsedSec: 0.2 }, "previoustrack").ok, true);

  assert.equal(ok("pause", { index: 0, running: true, elapsedSec: 21 }, "pause").ok, false, "still running");
  assert.equal(ok("pause", { index: 0, running: false, elapsedSec: 20 }, "pause", false).ok, false, "no handler");
  assert.equal(ok("pause", { index: 0, running: false, elapsedSec: 20 }, "play").ok, false, "the wrong action");
  assert.equal(ok("next", { index: 0, running: true, elapsedSec: 25 }, "nexttrack").ok, false, "did not move");
  assert.equal(ok("previous", { index: 0, running: true, elapsedSec: 19.5 }, "previoustrack").ok, false, "half a second is not a previous");
  /* Run 36550714726: in the background, previous moved the clock back and the
     clip never played again. That is a failure of previous, not a pass. */
  assert.equal(ok("previous", { index: 2, running: false, loading: true, elapsedSec: 0 }, "previoustrack").ok, false, "a clock moved back onto silence");
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
  const base = { controls, expected: { title: EPISODE.title, artist: SHOW }, tapped: { at: { x: 1, y: 1 }, playingBefore: true }, after, sinceRemote: 1 };
  assert.equal(verdictNotification(base).ok, true, verdictNotification(base).failures.join("; "));
  for (const k of ["title", "artist", "back15", "forward30"]) {
    assert.equal(verdictNotification({ ...base, controls: { ...controls, [k]: null } }).ok, false, `no ${k} must fail (d)`);
  }
  assert.equal(verdictNotification({ ...base, controls: null }).ok, false, "an unreadable shade");
  assert.equal(verdictNotification({ ...base, tapped: null }).ok, false, "nothing tapped");
  /* MUTATION: drop the playingBefore clause -> a tap on an already-paused page
     passes on state alone. */
  assert.equal(verdictNotification({ ...base, tapped: { ...base.tapped, playingBefore: false } }).ok, false, "not playing before the tap");
  assert.equal(verdictNotification({ ...base, after: { ...after, episodePlaying: true } }).ok, false, "still playing");
  assert.equal(verdictNotification({ ...base, after: { ...after, remote: [{ action: "play" }] } }).ok, false, "the tap never reached the page");
});

test("(d) on the real API 34 shade (run 36551857323): our title, show and play button, and no 15/30 (A04-F2)", () => {
  /* MUTATION: match the pair on "Previous track" -> back15 is found here and
     this fails. The one real SystemUI dump this job has, from its own run: the
     media panel carries our title and show, play/pause and previous track, and
     none of the pair, which is what A04-F2 records. When F2 is fixed the next
     run's dump replaces this fixture and the last two assertions flip. */
  const xml = fs.readFileSync(path.join(FIX, "run36551857323-shade-expand-settings-paused.xml"), "utf8");
  const c = mediaControls(uiNodes(xml), { title: EPISODE.title, artist: SHOW });
  assert.equal(c.title.id, "com.android.systemui:id/header_title");
  assert.equal(c.artist.id, "com.android.systemui:id/header_artist");
  assert.equal(c.play.id, "com.android.systemui:id/actionPlayPause");
  assert.ok(c.play.bounds.x2 > c.play.bounds.x1);
  assert.equal(c.back15, null);
  assert.equal(c.forward30, null);
  const v = verdictNotification({ controls: c, expected: { title: EPISODE.title, artist: SHOW }, tapped: { at: center(c.play.bounds), playingBefore: true },
    after: { episodePlaying: false, remote: [{ action: "pause", handled: true }] } });
  assert.deepEqual(applyKnown("notification", v.failures).ok, true, "only A04-F2's two sentences fail on the real shade");
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

test("the summary lists all twelve scenarios in the cards' order, and escapes a pipe", () => {
  /* MUTATION: drop a scenario from SCENARIOS -> fails. */
  assert.deepEqual(SCENARIOS.map(([id]) => id), [
    "play", "background", "transport", "notification", "first-launch",
    "seams", "doze", "focus", "call", "kill", "airplane", "back-home",
  ]);
  SCENARIOS.forEach(([, label], i) => assert.ok(label.startsWith(`(${"abcdefghijkl"[i]})`), `${label} is not letter ${"abcdefghijkl"[i]}`));
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
  for (const [id] of SCENARIOS) assert.equal(parseArgs([id, "--art", "x"]).scenario, id, `${id} has no runner`);
});

test("a known product defect is reported as expected-fail, and only the failure it names", () => {
  /* MUTATION: match A04-F2 on any notification failure -> the tap case below
     is excused and fails. MUTATION: drop `knownNotReproduced` -> a fixed defect
     keeps its entry forever and fails the last assertion.
     The job exists to find these; excusing more than the one sentence would
     let the next defect in the same scenario through with the first one's
     permission. */
  const both = ["no back-15 button", "no forward-30 button"];
  const known = applyKnown("notification", both);
  assert.equal(known.ok, true);
  assert.deepEqual(known.expectedFailures.map((e) => e.id), ["A04-F2", "A04-F2"]);
  const plus = applyKnown("notification", [...both, "the page is still playing after the tap on pause"]);
  assert.equal(plus.ok, false);
  assert.deepEqual(plus.failures, ["the page is still playing after the tap on pause"]);
  assert.equal(applyKnown("play", ["no back-15 button"]).ok, false, "a known failure belongs to its scenario only");
  assert.deepEqual(applyKnown("notification", []).knownNotReproduced, ["A04-F2"]);
  /* A04-F1 excuses the BACKGROUND play/previous that does not resume, and
     nothing about the foreground control: that one resumed on run
     36550714726, and it is what makes F1 a statement about the background. */
  const f1 = applyKnown("transport", [
    "cmd media_session dispatch play: the page is not running after play",
    "input keyevent KEYCODE_MEDIA_PREVIOUS: the page is not running after previous",
    "foreground: cmd media_session dispatch play: the page is not running after play",
    "cmd media_session dispatch pause: no pause reached the page (foray:remote)",
  ]);
  assert.deepEqual(f1.expectedFailures.map((e) => e.id), ["A04-F1", "A04-F1"]);
  assert.deepEqual(f1.failures, [
    "foreground: cmd media_session dispatch play: the page is not running after play",
    "cmd media_session dispatch pause: no pause reached the page (foray:remote)",
  ]);
  for (const k of KNOWN_FAILURES) {
    assert.ok(SCENARIOS.some(([id]) => id === k.scenario), `${k.id} names an unknown scenario`);
    assert.match(k.what, /\brun/, `${k.id} must name the run that showed it`);
  }
  assert.match(summaryMarkdown({ notification: { ok: true, expectedFailures: [{ id: "A04-F2" }] } }), /\*\*pass\*\* \(expected-fail: A04-F2\)/);
});

/* ═══════════════════════════════ A-05 ═══════════════════════════════ */

const resolveFixture = (fx) => {
  const doc = findForay(fx.forays, fx.id, { unlocked: [fx.id] });
  assert.ok(doc, `${fx.id} is not findable`);
  return resolveForay(doc, { segments: indexSegments(fx.segments), sources: indexSources(fx.sources) });
};

test("A-05: every fixture Foray resolves through the player's own join, rendered lines included", () => {
  /* MUTATION: drop `script` and `audio_url` from a line -> the queue drops it
     ("narration has no asset or script") and fails. MUTATION: give two clips
     one segment id -> fails. (f) is a clip / line / clip Foray, so a line the
     join refused would turn every seam into a clip-to-clip one. */
  const seams = resolveFixture(SEAMS_FORAY);
  assert.deepEqual(seams.unplayable, []);
  assert.equal(seams.playable.length, 7);
  const lines = seams.playable.filter((p) => p.kind === "tts");
  assert.deepEqual(lines.map((l) => l.audio_url), NARRATION_LINES.map((l) => `https://localhost${NARRATION_PATH}${l.file}`));
  seams.playable.forEach((p, i) => assert.equal(p.kind === "tts", i % 2 === 1, `item ${i} is out of the clip / line order`));
  /* Every clip before a line is at least 20 s, the floor under which the web
     lane's narration warm (PR #867) does not start: the seams are a real
     Foray's, warm included. */
  for (const clip of SEAMS_FORAY.segments.segments) assert.ok(clip.end_sec - clip.start_sec >= 20);
  assert.equal(resolveFixture(DOZE_FORAY).playable.length, 6);
  assert.ok(resolveFixture(DOZE_FORAY).totalSec * 1000 > GATES.dozeWaitMs + 60000, "the Doze Foray must outlast five minutes");
  assert.equal(resolveFixture(LONG_FORAY).playable.length, 3);
  const air = resolveFixture(AIRPLANE_FORAY);
  assert.deepEqual(air.playable.map((p) => p.kind === "tts"), [false, true, false]);
  assert.equal(air.playable[1].audio_url, UNREACHABLE_NARRATION_URL);
  assert.ok(air.playable[1].script.length > 0, "the fallback needs a script to speak");
  const profile = JSON.parse(fs.readFileSync(path.join(ROOT, "tools/narration/render-profile.json"), "utf8"));
  assert.ok(UNREACHABLE_NARRATION_URL.startsWith(`${profile.public_base}/${profile.key_prefix}/`), "the line has a real line's shape");
  assert.ok(NARRATION_LINES.every((l) => l.file.endsWith(`.${profile.render.encode.container}`)));
  const ids = new Set();
  for (const fx of [SEAMS_FORAY, DOZE_FORAY, LONG_FORAY, AIRPLANE_FORAY]) {
    for (const seg of fx.segments.segments) {
      assert.equal(ids.has(seg.id), false, `${seg.id} is used twice`);
      ids.add(seg.id);
    }
  }
  const one = buildForay({ id: "x", title: "x", items: [{ clip: CLIPS[0], endSec: 5 }] });
  assert.equal(one.sources.sources[0].audio_url, `https://localhost${FIXTURE_PATH}${CLIPS[0].file}`);
});

test("A-05: the focus stack is read from API 34's real dumpsys audio (run 36551857323)", () => {
  /* MUTATION: read the top as the FIRST entry -> the two-entry case fails
     (the platform prints "last is top of stack"). MUTATION: keep reading past
     the stack's end -> the empty case picks up nothing, but a later
     `source:` line elsewhere in the dump would; the blank-line case pins it. */
  const f = focusStack(AUDIO);
  assert.equal(f.found, true);
  assert.equal(f.entries.length, 1);
  assert.deepEqual(
    { pack: f.top.pack, gain: f.top.gain, loss: f.top.loss, uid: f.top.uid, usage: f.top.usage },
    { pack: PKG, gain: "GAIN", loss: "none", uid: 10192, usage: "USAGE_MEDIA" }
  );
  assert.match(f.top.client, /AudioFocusDelegate/, "WebView's own focus client, as A-03 found");
  assert.equal(f.inRingOrCall, false);
  const ours = AUDIO.split(/\r?\n/).find((l) => l.includes("-- pack: ai.jwlabs.foura"));
  const helper = ours.replace("pack: ai.jwlabs.foura", `pack: ${HELPER_PKG}`).replace("AudioFocusDelegate", "Helper");
  const lost = ours.replace("loss: none", "loss: LOSS_TRANSIENT");
  const two = focusStack(AUDIO.replace(ours, `${lost}\n${helper}`).replace("In ring or call: false", "In ring or call: true"));
  assert.deepEqual(two.entries.map((e) => [e.pack, e.loss]), [[PKG, "LOSS_TRANSIENT"], [HELPER_PKG, "none"]]);
  assert.equal(two.top.pack, HELPER_PKG);
  assert.equal(two.inRingOrCall, true);
  const empty = focusStack(AUDIO.replace(ours + "\n", ""));
  assert.deepEqual([empty.found, empty.entries.length, empty.top], [true, 0, null]);
  assert.equal(focusStack("no focus here").found, false);
});

test("A-05: the media button route, the call state, the focused window and a bucket are read from their dumps", () => {
  /* MUTATION: take the Global priority session as the button session -> fails
     (telecom is not who gets a media key). MUTATION: read `null` as a receiver
     name -> fails. */
  const r = mediaButtonRoute(SESSIONS);
  assert.deepEqual(r, { session: `${PKG}/androidx.media3.session.id.foray`, sessionPackage: PKG, lastReceiver: null });
  const yt = mediaButtonRoute(SESSIONS.replace("Last MediaButtonReceiver: null", "Last MediaButtonReceiver: MBR {pkg=com.google.android.apps.youtube.music}"));
  assert.equal(yt.lastReceiver, "MBR {pkg=com.google.android.apps.youtube.music}");
  /* Run 36562447644's (j): once our process is gone the dump says "Media
     button session is null", which is nobody, not a package called "null". */
  const gone = mediaButtonRoute(SESSIONS.replace(/Media button session is \S+/, "Media button session is null"));
  assert.deepEqual(gone, { session: null, sessionPackage: null, lastReceiver: null });
  assert.equal(callState("  mCallState=1\n  mRingingCallState=0"), "RINGING");
  assert.equal(callState("mCallState=2"), "OFFHOOK");
  assert.equal(callState("mCallState=0"), "IDLE");
  assert.equal(callState("nothing"), null);
  assert.deepEqual(currentFocus("  mCurrentFocus=Window{2c1e3a1 u0 ai.jwlabs.foura/ai.jwlabs.foura.MainActivity}"),
    { found: true, window: "ai.jwlabs.foura/ai.jwlabs.foura.MainActivity", pkg: PKG });
  assert.equal(currentFocus("mCurrentFocus=Window{9 u0 com.google.android.apps.nexuslauncher/com.google.android.apps.nexuslauncher.NexusLauncherActivity}").pkg,
    "com.google.android.apps.nexuslauncher");
  assert.deepEqual(currentFocus("mCurrentFocus=Window{9 u0 NotificationShade}"), { found: true, window: "NotificationShade", pkg: null });
  assert.deepEqual(currentFocus("mCurrentFocus=null"), { found: true, window: null, pkg: null });
  assert.equal(currentFocus("").found, false);
  assert.equal(intLine("40\n"), 40);
  assert.equal(intLine("Error: no such package"), null);
});

const seam = (seq, gap, extra = {}) => ({ type: "seam", seq, wall: seq, fromId: `a${seq}`, toId: `b${seq}`, observedGapMs: gap, hiddenAtBoundary: true, stages: [], ...extra });

test("A-05 (f): seam statistics count a seam that never became audible as the worst, and leave out cuts and the queue's end", () => {
  /* MUTATION: compute p95 over measured gaps only -> the never-started case
     reads 1200 ms and fails. MUTATION: count the end-of-queue row -> the
     seam count fails. D-A4 is decided on this p95, so a stall that fell out
     of it would read as a good number. */
  const rows = [seam(1, 800), seam(2, 1200), seam(3, 600), seam(4, 3000), seam(5, 900), seam(6, 1000),
    { type: "outPoint", seq: 7 }, seam(8, null, { endOfQueue: true })];
  const st = seamStats(rows);
  assert.deepEqual([st.seams, st.measured, st.neverStarted, st.cut], [6, 6, 0, 0]);
  assert.deepEqual(st.gapsMs, [600, 800, 900, 1000, 1200, 3000]);
  assert.equal(st.p50Ms, 900);
  assert.equal(st.p95Ms, 3000);
  assert.equal(st.maxMs, 3000);
  assert.equal(st.hiddenAtBoundary, 6);
  assert.deepEqual(a15Trigger(st), { triggered: false, on: "gap", why: "p95 gap 3000 ms <= 4000 ms" });
  const stalled = seamStats([...rows, seam(9, null, { lastStage: "load.deadline" })]);
  assert.equal(stalled.neverStarted, 1);
  assert.equal(stalled.p95Ms, "never audible");
  assert.equal(a15Trigger(stalled).triggered, true);
  const cut = seamStats([seam(1, 500), seam(2, null, { cutBy: "pause" })]);
  assert.deepEqual([cut.seams, cut.measured, cut.cut, cut.neverStarted, cut.p95Ms], [2, 1, 1, 0, 500]);
  assert.equal(a15Trigger(seamStats([seam(1, 4001)])).triggered, true);
  assert.equal(a15Trigger(seamStats([seam(1, 4000)])).triggered, false, "the line is > 4 s, not >=");
  assert.equal(a15Trigger(seamStats([])).triggered, null);
});

test("A-05 (f): recorded, not gated: the verdict fails only when there was nothing to record", () => {
  /* MUTATION: fail (f) on p95 > 4 s -> the slow case fails. The card says
     "Record them; do not gate yet". */
  const slow = seamStats([seam(1, 9000), seam(2, 11000)]);
  const ok = verdictSeams({ started: { ok: true }, wake: "Asleep", stats: slow });
  assert.equal(ok.ok, true);
  assert.equal(ok.recorded.a15.triggered, true);
  assert.deepEqual(ok.recorded.gap, { p50Ms: 9000, p95Ms: 11000, maxMs: 11000 });
  assert.match(verdictSeams({ started: { ok: true }, wake: "Awake", stats: slow }).failures.join(), /screen did not go off/);
  assert.match(verdictSeams({ started: { ok: false }, wake: "Asleep", stats: slow }).failures.join(), /did not start/);
  assert.match(verdictSeams({ started: { ok: true }, wake: "Asleep", stats: seamStats([]) }).failures.join(), /no seam row/);
  assert.match(verdictSeams({ started: { ok: true }, wake: "Asleep", stats: null }).failures.join(), /could not be read/);
});

test("A-05 (g): Doze passes on four minutes of clock in the same process, and fails on each thing it gates", () => {
  /* MUTATION: drop the deep-idle check -> the "not entered" case passes.
     MUTATION: gate on 60 s instead of 240 -> the frozen-clock case passes. */
  const first = { at: 0, foray: { elapsedSec: 10 } };
  const last = { at: 300000, foray: { elapsedSec: 309 } };
  const service = { found: true, isForeground: true, mediaPlayback: true };
  const base = { first, last, wake: "Asleep", deep: "IDLE", bucket: 40, pidBefore: "1", pidAfter: "1", service };
  assert.deepEqual(verdictDoze(base).failures, []);
  assert.match(verdictDoze({ ...base, deep: "ACTIVE" }).failures.join(), /Doze was not entered/);
  assert.match(verdictDoze({ ...base, bucket: 10 }).failures.join(), /not rare/);
  assert.match(verdictDoze({ ...base, wake: "Awake" }).failures.join(), /screen did not go off/);
  assert.match(verdictDoze({ ...base, last: { at: 300000, foray: { elapsedSec: 60 } } }).failures.join(), /the gate is 240 s/);
  assert.match(verdictDoze({ ...base, last: { at: 120000, foray: { elapsedSec: 129 } } }).failures.join(), /stopped answering/);
  assert.match(verdictDoze({ ...base, pidAfter: "2", killedBy: "Killing 1:x" }).failures.join(), /died in Doze \(Killing 1:x\)/);
  assert.match(verdictDoze({ ...base, service: { found: true, isForeground: false, mediaPlayback: true } }).failures.join(), /not a mediaPlayback foreground service/);
});

const at = (t, src = "https://localhost/a04/click-cbr.mp3", extra = {}) => ({ element: { t, src, paused: false }, foray: { running: true }, remote: [], ...extra });

test("A-05 (h): a focus phase says whether we paused and came back; the verdict fails only when the helper got no focus", () => {
  /* MUTATION: read "granted" from any helper line -> the refused case passes.
     MUTATION: compare clocks across two files -> the seam case reads as
     playing. */
  assert.equal(advanced(at(1), at(5)), 4);
  assert.equal(advanced(at(1), at(5, "https://localhost/a04/click-vbr-xing.mp3")), null, "two files' clocks are not one clock");
  assert.equal(wasPlaying(at(1), at(5)), true);
  assert.equal(wasPlaying(at(1), at(1.5)), false);
  const stackOurs = focusStack(AUDIO);
  const ours = AUDIO.split(/\r?\n/).find((l) => l.includes("-- pack: ai.jwlabs.foura"));
  const held = focusStack(AUDIO.replace(ours, `${ours.replace("loss: none", "loss: LOSS_TRANSIENT")}\n${ours.replace("pack: ai.jwlabs.foura", `pack: ${HELPER_PKG}`)}`));
  const p = focusPhase({
    mode: "transient", stackBefore: stackOurs, stackHeld: held, stackAfter: stackOurs,
    sPre: at(10), s0: at(14), s1: at(18), s2: at(18.2), s3: at(18.5), s4: at(22.5),
    helperLog: ["mode=transient result=1", "mode=abandon result=1"],
  });
  assert.equal(p.helperGranted, true);
  assert.equal(p.before.playing, true);
  assert.equal(p.whileHeld.top, HELPER_PKG);
  assert.equal(p.whileHeld.ourEntries[0].loss, "LOSS_TRANSIENT");
  assert.equal(p.whileHeld.playing, false);
  assert.equal(p.afterAbandon.playing, true);
  const v = verdictFocus({ phases: [p] });
  assert.equal(v.ok, true);
  assert.deepEqual(v.recorded, [{ mode: "transient", playingBefore: true, heldFocusBefore: true, ourLossWhileHeld: "LOSS_TRANSIENT", pausedWhileHeld: true, resumedAfterAbandon: true }]);
  const refused = focusPhase({ mode: "gain", helperLog: ["mode=gain result=0"], s0: at(1), s4: at(2) });
  assert.match(verdictFocus({ phases: [refused] }).failures.join(), /gain: the helper's AUDIOFOCUS request was not granted/);
  assert.match(verdictFocus({ phases: [] }).failures.join(), /no focus phase ran/);
});

test("A-05 (i): the call verdict fails only when the emulator's call did not ring, answer and hang up", () => {
  /* MUTATION: drop the OFFHOOK check -> a call that was never answered
     passes, and its "in-call" values would be about ringing. */
  const phase = (name, cs, playing) => ({ name, callState: cs, playing, running: playing, top: PKG, ourEntries: [{ loss: "none" }], inRingOrCall: cs !== "IDLE" });
  const phases = [phase("before", "IDLE", true), phase("ringing", "RINGING", false), phase("in-call", "OFFHOOK", false), phase("ended", "IDLE", false), phase("ended+10s", "IDLE", true)];
  const v = verdictCall({ phases });
  assert.equal(v.ok, true);
  assert.deepEqual([v.recorded.ringing.playing, v.recorded.inCall.playing, v.recorded.endedLater.playing], [false, false, true]);
  assert.match(verdictCall({ phases: phases.map((p) => (p.name === "in-call" ? { ...p, callState: "RINGING" } : p)) }).failures.join(), /in-call: mCallState is RINGING, not OFFHOOK/);
  assert.match(verdictCall({ phases: phases.filter((p) => p.name !== "ringing") }).failures.join(), /the ringing phase did not run/);
});

test("A-05 (j): who got the play, and the force-stop control is the only gate", () => {
  /* MUTATION: drop the force-stop pid check -> a control that left the
     process running passes. MUTATION: prefer the button session over a
     PLAYING one -> the YouTube Music case names us. */
  const sessions = mediaSessions(SESSIONS);
  assert.deepEqual(receiverOf(sessions, mediaButtonRoute(SESSIONS)), { by: "a PLAYING session", pkg: PKG });
  const ytPlaying = { sessions: [{ package: "com.google.android.apps.youtube.music", state: "PLAYING" }, { package: PKG, state: "PAUSED" }] };
  assert.equal(receiverOf(ytPlaying, { sessionPackage: PKG }).pkg, "com.google.android.apps.youtube.music");
  assert.deepEqual(receiverOf({ sessions: [{ package: PKG, state: "PAUSED" }] }, { sessionPackage: PKG }), { by: "the media button session (not playing)", pkg: PKG });
  assert.equal(receiverOf({ sessions: [] }, { sessionPackage: null }).pkg, null);
  const leg = (name, extra) => ({ leg: name, pidBefore: "1", killed: true, routeBefore: { session: `${PKG}/x`, lastReceiver: null }, receivedBy: { pkg: null }, pidAfterKill: null, pidAfterDispatch: null, ...extra });
  const legs = [leg("am-kill", { killed: false, pidAfterKill: "1", pidAfterDispatch: "1", pagePlaying: false }), leg("sigkill", { pidAfterDispatch: "7" }), leg("force-stop")];
  const v = verdictKill({ legs });
  assert.equal(v.ok, true);
  assert.deepEqual(v.recorded.map((r) => [r.leg, r.killed, r.restarted]), [["am-kill", false, false], ["sigkill", true, true], ["force-stop", true, false]]);
  assert.match(verdictKill({ legs: [legs[0], legs[1], leg("force-stop", { pidAfterKill: "1" })] }).failures.join(), /force-stop left our process running/);
  assert.match(verdictKill({ legs: [legs[0], legs[1], leg("force-stop", { pidAfterDispatch: "9" })] }).failures.join(), /brought our process back/);
  assert.match(verdictKill({ legs: [legs[0]] }).failures.join(), /force-stop leg did not run/);
});

test("A-05 (k): the airplane fallback passes when the line is spoken or skipped in time and the Foray goes on", () => {
  /* MUTATION: accept a decision at any time -> the late case passes.
     MUTATION: pass a spoken line whose Foray never reached the next clip ->
     the stalled-after case passes. */
  const base = { airplane: true, reachedLine: true, decision: { kind: "spoken", ms: 900 }, landed: true, final: { foray: { index: 2, running: true } } };
  assert.deepEqual(verdictAirplane(base).failures, []);
  assert.deepEqual(verdictAirplane({ ...base, decision: { kind: "skipped", ms: 1200 } }).failures, []);
  assert.match(verdictAirplane({ ...base, decision: { kind: "spoken", ms: GATES.airplaneDecisionMs + 1 } }).failures.join(), /the deadline is/);
  assert.match(verdictAirplane({ ...base, decision: null }).failures.join(), /neither spoken nor skipped/);
  assert.match(verdictAirplane({ ...base, decision: { kind: "stopped", ms: 400, error: "load failed" } }).failures.join(), /stopped at the line/);
  assert.match(verdictAirplane({ ...base, landed: false }).failures.join(), /did not go on to the clip/);
  assert.match(verdictAirplane({ ...base, airplane: false }).failures.join(), /airplane mode did not engage/);
  assert.match(verdictAirplane({ ...base, reachedLine: false }).failures.join(), /never reached the narration line/);
  assert.equal(GATES.airplaneDecisionMs, 15000, "the visible load deadline (10 s) plus 5 s");
});

test("A-05 (l): Back on Home passes when the app left, the process stayed and the clock kept moving", () => {
  /* MUTATION: drop the clock check -> the pre-A-07 exit (process cached,
     service stopped, silence) passes on pid alone. */
  const service = { found: true, isForeground: true, mediaPlayback: true };
  const base = { left: true, presses: 1, pidBefore: "1", pidAfter: "1", first: at(10), last: at(14), service };
  assert.deepEqual(verdictBack(base).failures, []);
  assert.match(verdictBack({ ...base, left: false, presses: 5 }).failures.join(), /never left the app in 5 presses/);
  assert.match(verdictBack({ ...base, last: at(10.2) }).failures.join(), /the audio stopped/);
  assert.match(verdictBack({ ...base, pidAfter: null }).failures.join(), /Back ended the process/);
  assert.match(verdictBack({ ...base, service: { found: false } }).failures.join(), /not a mediaPlayback foreground service/);
  assert.equal(KNOWN_FAILURES.some((k) => k.scenario === "back-home"), false, "A-07 is merged: (l) is gated, not expected-fail");
});

test("A-05: the ring read and the speech instrument run in a fake page", () => {
  /* MUTATION: filter the ring on `seq >= since` -> the row that marked the
     start is counted again. MUTATION: stop passing the plugin call through
     -> the fake bridge's answer is lost and fails. */
  const store = { cp_diag: JSON.stringify({ seq: 12, dropped: 0, entries: [
    { seq: 10, type: "seam", observedGapMs: 1 }, { seq: 11, type: "nowplaying" }, { seq: 12, type: "narration", reason: "network" },
  ] }) };
  const ls = { getItem: (k) => store[k] ?? null };
  const r = vm.runInContext(ringExpression(10), vm.createContext({ localStorage: ls, JSON }));
  assert.equal(r.ok, true);
  assert.equal(r.seq, 12);
  assert.deepEqual(r.entries.map((e) => e.seq), [12]);
  assert.equal(vm.runInContext(ringExpression(Number.MAX_SAFE_INTEGER), vm.createContext({ localStorage: ls, JSON })).entries.length, 0);
  assert.equal(vm.runInContext(ringExpression(0), vm.createContext({ localStorage: { getItem: () => null }, JSON })).ok, false);

  const calls = [];
  const Capacitor = { nativePromise: (plugin, method, opts) => { calls.push([plugin, method, opts?.text]); return Promise.resolve({ voice: "en-us-x" }); } };
  const window = { addEventListener: () => {}, Capacitor, ForayPlayer: {}, ForayMediaSession: null };
  class HTMLMediaElement { play() { return "p"; } }
  const ctx = vm.createContext({ window, HTMLMediaElement, navigator: {}, document: { visibilityState: "visible" }, Date, Promise });
  vm.runInContext(INSTRUMENT_EXPRESSION, ctx);
  const answer = window.Capacitor.nativePromise("ForayTts", "speak", { text: "hello" });
  window.Capacitor.nativePromise("ForayAudio", "state", {});
  vm.runInContext(INSTRUMENT_EXPRESSION, ctx);
  window.Capacitor.nativePromise("ForayTts", "speak", { text: "again" });
  assert.deepEqual(calls.map((c) => c[1]), ["speak", "state", "speak"], "every call passes through, once, after a second install");
  return answer.then((a) => {
    assert.equal(a.voice, "en-us-x");
    const s = JSON.parse(JSON.stringify(vm.runInContext(STATE_EXPRESSION, ctx)));
    assert.deepEqual(s.tts.map((t) => [t.method, t.ok]), [["speak", true], ["speak", true]], "only ForayTts calls are recorded");
    assert.equal(s.tts[0].voice, "en-us-x");
  });
});

test("A-05 (f): the interlude jingle's span is taken out of a seam, and the A-15 line is decided on the silence", () => {
  /* MUTATION: count a jingle that played in ANOTHER seam -> the second row
     reads 3000 ms of jingle and fails. MUTATION: decide a15Trigger on the
     gap when the media log is there -> the jingle case triggers and fails.
     Run 36562447644: every line -> clip seam was ~3.35 s, a 3.0 s jingle plus
     ~0.35 s; the ring cannot say which part was sound. */
  const jingle = "jw-incorporated.github.io/interlude-placeholder.wav";
  const media = [
    { at: 1030, type: "playing", src: jingle },
    { at: 4030, type: "ended", src: jingle },
    { at: 4340, type: "playing", src: "localhost/click-vbr-xing.mp3" },
  ];
  const withJ = seam(1, 3340, { wall: 1000 });
  const without = seam(2, 40, { wall: 9000 });
  assert.equal(jingleIn(withJ, media), 3000);
  assert.equal(jingleIn(without, media), 0);
  assert.equal(jingleIn(seam(3, null, { wall: 1000 }), media), 0, "a seam with no gap has no jingle to take out");
  /* A jingle cut short by the next clip counts only up to the seam's end. */
  assert.equal(jingleIn(seam(4, 2000, { wall: 1000 }), media), 1970);
  const st = seamStats([withJ, without, seam(5, 4600, { wall: 20000 })], [
    ...media,
    { at: 20010, type: "playing", src: jingle },
    { at: 23010, type: "ended", src: jingle },
  ]);
  assert.equal(st.media, true);
  assert.equal(st.withJingle, 2);
  assert.deepEqual(st.gapsMs, [40, 3340, 4600]);
  assert.deepEqual(st.silencesMs, [40, 340, 1600]);
  assert.equal(st.p95Ms, 4600);
  assert.equal(st.silenceP95Ms, 1600);
  assert.deepEqual(a15Trigger(st), { triggered: false, on: "silence", why: "p95 silence 1600 ms <= 4000 ms" });
  assert.deepEqual(st.rows.map((r) => r.jingleMs), [3000, 0, 3000]);
  const noMedia = seamStats([withJ]);
  assert.deepEqual([noMedia.media, noMedia.withJingle, noMedia.silenceP95Ms], [false, null, 3340], "without the log the silence is the whole gap");
});

test("A-05 (f): the instrument logs each element's playing and ended, and the log read filters by time", () => {
  /* MUTATION: log from the A-04 block (guarded by `hooked`) -> a page A-04
     already instrumented never logs, and the second install below fails. */
  const listeners = new Map();
  class HTMLMediaElement {
    addEventListener(n, fn) { listeners.set(`${this.id}:${n}`, fn); }
    play() { return "p"; }
  }
  const window = { addEventListener: () => {}, ForayPlayer: {}, __a04: { remote: [], elements: [], hooked: true } };
  let now = 1000;
  const ctx = vm.createContext({ window, HTMLMediaElement, navigator: {}, document: {}, URL, Date: { now: () => now } });
  vm.runInContext(INSTRUMENT_EXPRESSION, ctx);
  const el = new HTMLMediaElement();
  el.id = "j";
  el.src = "https://jw-incorporated.github.io/foray/player/assets/interlude-placeholder.wav";
  el.play();
  el.play();
  now = 1500;
  listeners.get("j:playing")();
  now = 4500;
  listeners.get("j:ended")();
  const log = JSON.parse(JSON.stringify(vm.runInContext(mediaLogExpression(1200), ctx)));
  assert.deepEqual(log, [
    { at: 1500, type: "playing", src: "jw-incorporated.github.io/interlude-placeholder.wav" },
    { at: 4500, type: "ended", src: "jw-incorporated.github.io/interlude-placeholder.wav" },
  ]);
  assert.equal(vm.runInContext(mediaLogExpression(0), ctx).length, 2, "one listener per element, however often it plays");
});

test("A-31: the JS legs pin the Web setting first, so they measure the page's player under a native stock lane", async () => {
  /* Since A-31 a stock Android launch is the native lane, and every scenario in this runner drives
     the page's own player. MUTATION: point first-launch back at the plain firstLaunch; drop the
     force-stop between storing Web and the relaunch; store any mode but web; pass a lane read as
     native or an override that is not Web. Each fails here. */
  const { JS_LANE_MODE, DRIVER_COMPONENT, jsLaneFailures, PKG } = await import("./android-playback.mjs");
  assert.equal(JS_LANE_MODE, "web");
  assert.equal(DRIVER_COMPONENT, `${PKG}/ai.jwlabs.foura.audio.EngineDriveReceiver`);
  const src = fs.readFileSync(new URL("./android-playback.mjs", import.meta.url), "utf8");
  assert.match(src, /"first-launch": jsFirstLaunch,/, "the JS leg's first step pins the lane");
  const pin = /\nasync function pinJsLane\(ctx\) \{([\s\S]*?)\n\}\n/.exec(src)?.[1] ?? "";
  const store = pin.indexOf('"--es", "cmd", "override", "--es", "mode", JS_LANE_MODE');
  const stop = pin.indexOf('shell("am", "force-stop", ctx.pkg)');
  const start = pin.indexOf('"am", "start"');
  assert.ok(store >= 0 && store < stop && stop < start, "stored, stopped, then relaunched: the lane is decided once per process");

  const stored = { delivered: true, result: 1, answer: { ok: true, override: "web" } };
  const status = { lane: "js", status: { lane: "js", override: "web" } };
  assert.deepEqual(jsLaneFailures({ stored, status }), []);
  assert.match(jsLaneFailures({ stored: { delivered: false, result: null, answer: null }, status })[0], /Web was not stored/);
  assert.match(jsLaneFailures({ stored, status: { lane: "native", status: { lane: "native", override: "web" } } })[0], /native lane, not js/);
  assert.match(jsLaneFailures({ stored, status: { lane: "js", status: { lane: "js", override: "auto" } } })[0], /not "web"/);
  assert.match(jsLaneFailures({ stored, status: { error: "timeout" } })[0], /could not be read: timeout/);
  assert.match(jsLaneFailures(null).join("; "), /not stored.*could not be read/);
});
