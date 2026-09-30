#!/usr/bin/env node
/* The Android playback scenarios in NATIVE MODE (card A-26,
 * `docs/plans/android-assessment.md` §5.4): A-04/A-05's (a)–(d), (g), (h) and (i),
 * run against the native engine's `ForayPlaybackService` instead of the page's
 * player, on the CI emulator, over adb only.
 *
 * ── WHY A SECOND RUNNER ──────────────────────────────────────────────────────
 *
 * `android-playback.mjs` drives the JS lane through the page over Chrome DevTools.
 * The native engine has no page door yet: the bridge (`engineHello` /
 * `engineSend`) is A-28's. So this leg drives the engine the way a client of a
 * Media3 session service does, from outside the page:
 *
 *   - the DEBUG build's `EngineDriveReceiver` (`mobile/plugins/foray-audio/android/
 *     src/debug/`, absent from a release build) binds the service with a
 *     MediaController and hands the engine a queue and a TAP play, over
 *     `adb shell am broadcast`;
 *   - the engine's state is read from the service's own dump
 *     (`dumpsys activity service …/ForayPlaybackService`: one `ForayEngine {json}`
 *     line, read on the engine's thread);
 *   - everything a listener's world does to it is the real thing: the Media3
 *     session's media keys (`cmd media_session dispatch`, `KEYCODE_MEDIA_*`), the
 *     system media controls in the shade, the A-05 focus helper app, the
 *     emulator's modem, Doze.
 *
 * The audio is the committed NE-25a click tracks the job already puts in the
 * debug APK (`assets/public/a04/`), read by the ExoPlayer deck as
 * `asset:///public/a04/…`: no network, the same files the JS lane plays.
 *
 * Per D-A3 no person tests Android until A-42; this leg is the witness that the
 * native engine plays, keeps playing, obeys the controls and hands audio focus
 * back and forth the way the card says.
 *
 * ── ONE SCENARIO PER INVOCATION ──────────────────────────────────────────────
 *
 *   node tools/mobile/android-native-playback.mjs <scenario> --art DIR [--pkg ai.jwlabs.foura]
 *
 * Scenarios: `play` (a), `background` (b), `transport` (c), `notification` (d),
 * `doze` (g), `focus` (h), `call` (i), and `collect` / `summary`. Every one is
 * GATED here (the card: "must be green on (a)–(d), (g), (h) and (i)"). Each
 * prints its verdict as JSON, writes `DIR/verdict-native-<scenario>.json`, and
 * exits 0 (pass), 1 (the verdict failed) or 2 (it could not run).
 *
 * The pure half (the queue, the dump and broadcast parsers, the verdicts) is
 * exported and pinned by `android-native-playback.test.mjs`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLIPS,
  EPISODE,
  GATES,
  HELPER_ACTIVITY,
  HELPER_APK,
  HELPER_PKG,
  HELPER_TAG,
  PKG,
  PRESSES,
  SHOW,
  adb,
  callState,
  center,
  focusStack,
  foregroundService,
  intLine,
  killLine,
  mediaControls,
  mediaSessions,
  pidOf,
  pngInfo,
  uiNodes,
  wakefulness,
} from "./android-playback.mjs";

/** The engine's service, as `dumpsys activity services` names it and as a component. */
export const SERVICE = "ForayPlaybackService";
export const SERVICE_COMPONENT = `${PKG}/ai.jwlabs.foura.audio.ForayPlaybackService`;
/** The debug build's driver. */
export const RECEIVER_COMPONENT = `${PKG}/ai.jwlabs.foura.audio.EngineDriveReceiver`;
/** The dump's state line (`ForayPlaybackService.DUMP_PREFIX`). */
export const DUMP_PREFIX = "ForayEngine ";
/** Where the job puts the click tracks in the APK, as the deck reads an asset. */
export const ASSET_BASE = "asset:///public/a04/";

/* ───────────────────────────── the queues ───────────────────────────── */

/** One engine item (the page's episode shape: id, kind, title, show, audio_url, bounds). */
export function engineItem(clip, i, { endSec = 85, prefix = "a26" } = {}) {
  return {
    id: `${prefix}-${i}`,
    kind: "episode",
    title: clip.title,
    show: SHOW,
    audio_url: `${ASSET_BASE}${clip.file}`,
    duration_sec: 90,
    start_sec: 0,
    end_sec: endSec,
  };
}

/** (a), (b), (c), (h), (i): three 85 s clips; next always has somewhere to go from the first two. */
export const LONG_QUEUE = Object.freeze(CLIPS.map((c, i) => engineItem(c, i)));
/** (g): six 85 s clips, 510 s, so five minutes of Doze never reaches the end. */
export const DOZE_QUEUE = Object.freeze([...CLIPS, ...CLIPS].map((c, i) => engineItem(c, i, { prefix: "a26-doze" })));
/** (d): the single episode, as the JS lane's (d) plays it. */
export const EPISODE_QUEUE = Object.freeze([engineItem({ file: EPISODE.file, title: EPISODE.title }, 0, { prefix: "a26-ep", endSec: 90 })]);

/** The queue as the driver takes it: base64 of the JSON array (no shell quoting to get wrong). */
export function queueArg(items) {
  return Buffer.from(JSON.stringify(items), "utf8").toString("base64");
}

/** How far into the queue the listener is, in seconds of content: every earlier item's
 *  (end - start), plus this one's playhead past its start. Null when unknown. */
export function listenedSec(state, items) {
  if (!state || !Number.isInteger(state.index) || state.index < 0 || typeof state.positionSec !== "number") return null;
  let sum = 0;
  for (let i = 0; i < state.index && i < items.length; i += 1) sum += (items[i].end_sec ?? 0) - (items[i].start_sec ?? 0);
  const start = items[state.index]?.start_sec ?? 0;
  return +(sum + Math.max(0, state.positionSec - start)).toFixed(3);
}

/* ───────────────────────────── parsers ───────────────────────────── */

/** The service's dump: the state object from its `ForayEngine {json}` line, and its rows. */
export function engineDump(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  let state = null;
  const rows = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith(DUMP_PREFIX) && state == null) {
      try {
        state = JSON.parse(t.slice(DUMP_PREFIX.length));
      } catch {
        state = { error: "unparseable", raw: t.slice(0, 200) };
      }
    } else if (t.startsWith("ForayEngine.row ")) {
      rows.push(t.slice("ForayEngine.row ".length));
    }
  }
  return { state, rows };
}

/** `am broadcast`'s answer: `Broadcast completed: result=1, data="{…}"`. */
export function broadcastResult(out) {
  const text = String(out ?? "");
  /* `am` prints the data between quotes WITHOUT escaping it, so the data is everything up to the
     last quote on its line (greedy); an escaped form is tried second. */
  const m = /Broadcast completed: result=(-?\d+)(?:, data="(.*)")?[ \t]*$/m.exec(text);
  if (!m) return { delivered: false, result: null, answer: null };
  let answer = null;
  if (m[2] != null) {
    answer = { raw: m[2] };
    for (const raw of [m[2], m[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\")]) {
      try {
        answer = JSON.parse(raw);
        break;
      } catch {
        /* try the next spelling */
      }
    }
  }
  return { delivered: true, result: Number(m[1]), answer };
}

/** Our session in `dumpsys media_session`: the engine's (Media3 names it by its id). */
export function ourSession(sessions, pkg = PKG) {
  const ours = (sessions?.sessions ?? []).filter((s) => s.package === pkg);
  return ours.find((s) => s.state === "PLAYING") ?? ours[0] ?? null;
}

const num = (n) => typeof n === "number" && Number.isFinite(n);

/** The playhead moved between two reads of the SAME item, in seconds; null when not comparable. */
export function moved(a, b) {
  if (!a || !b || a.item == null || a.item !== b.item || !num(a.positionSec) || !num(b.positionSec)) return null;
  return +(b.positionSec - a.positionSec).toFixed(3);
}

/** Playing, as a listener would say it: the playhead moved at least `playingMinAdvanceSec`. */
export function playingBetween(a, b) {
  const d = moved(a, b);
  return d == null ? null : d >= GATES.playingMinAdvanceSec;
}

/* ───────────────────────────── verdicts ───────────────────────────── */

function engineFailures(state, failures) {
  if (!state) failures.push(`${SERVICE}'s dump has no ${DUMP_PREFIX.trim()} line: the service is not running`);
  else if (state.error) failures.push(`the engine dump failed: ${state.error}`);
  else {
    if (state.hosting !== true) failures.push("the service is not hosting the engine");
    if (state.legacyRunning === true) failures.push("the legacy PlaybackKeepAliveService is running beside the native engine");
  }
}

/** (a) the engine plays a clip, in a mediaPlayback foreground service, published to the system. */
export function verdictPlay({ drive, first, last, service, sessions, expected = { title: CLIPS[0].title, artist: SHOW } }) {
  const failures = [];
  if (!drive?.answer?.ok) failures.push(`the driver's load did not play: ${JSON.stringify(drive)}`);
  engineFailures(last, failures);
  const d = moved(first, last);
  if (d == null) failures.push("the playhead could not be read twice on the same item");
  else if (d < GATES.playMinAdvanceSec) failures.push(`the playhead advanced ${d} s over ${GATES.playWindowMs / 1000} s; the gate is ${GATES.playMinAdvanceSec} s`);
  if (last && last.running !== true) failures.push(`the engine is ${last.state}, not running`);
  if (last && last.exoPlaying !== true) failures.push("the deck's ExoPlayer is not playing");
  if (!service?.found) failures.push(`no ${SERVICE} in dumpsys activity services`);
  else {
    if (!service.isForeground) failures.push(`${SERVICE} is not a foreground service`);
    if (!service.mediaPlayback) failures.push(`${SERVICE}'s foreground types ${service.types} do not include mediaPlayback`);
  }
  const ours = ourSession(sessions);
  if (!ours) failures.push(`dumpsys media_session lists no session for ${PKG}`);
  else if (ours.state !== "PLAYING") failures.push(`our media session is ${ours.state}, not PLAYING`);
  else if (!String(ours.description ?? "").startsWith(`${expected.title}, ${expected.artist}`)) {
    failures.push(`our media session describes ${JSON.stringify(ours.description)}, not ${JSON.stringify(`${expected.title}, ${expected.artist}`)}`);
  }
  if (last && (last.title !== expected.title || last.artist !== expected.artist)) {
    failures.push(`the engine's surface says ${JSON.stringify([last.title, last.artist])}`);
  }
  return { ok: failures.length === 0, failures, measured: { advancedSec: d, service, session: ours, engine: last } };
}

/** (b) Home, then the screen off: a minute later the queue has moved on, same process. */
export function verdictBackground({ first, last, items, pidBefore, pidAfter, wake, service, killedBy = null }) {
  const failures = [];
  if (!/^(Asleep|Dozing)$/.test(String(wake ?? ""))) failures.push(`the screen did not go off: mWakefulness=${wake}`);
  const l0 = listenedSec(first, items);
  const l1 = listenedSec(last, items);
  const advancedSec = num(l0) && num(l1) ? +(l1 - l0).toFixed(3) : null;
  if (advancedSec == null) failures.push("the engine's playhead could not be read before and after");
  else if (advancedSec < GATES.backgroundMinAdvanceSec) {
    failures.push(`the queue advanced ${advancedSec} s with the screen off; the gate is ${GATES.backgroundMinAdvanceSec} s`);
  }
  if (!pidBefore) failures.push("no app process before the screen went off");
  else if (pidAfter !== pidBefore) failures.push(`the pid changed from ${pidBefore} to ${pidAfter}${killedBy ? ` (${killedBy})` : ""}`);
  if (!service?.found || !service.isForeground || !service.mediaPlayback) failures.push(`${SERVICE} is not a mediaPlayback foreground service after a minute off`);
  return { ok: failures.length === 0, failures, measured: { advancedSec, wake, pidBefore, pidAfter, killedBy } };
}

/** (c) one press, by the media session: did the engine do the thing. */
export function verdictPress({ kind, before, after }) {
  const failures = [];
  if (kind === "pause" && before?.running !== true) failures.push("the engine was not running before pause, so the pause measured nothing");
  if (kind === "play" && before?.running !== false) failures.push("the engine was already running before play, so the play measured nothing");
  if (!after) failures.push("no engine state after the press");
  else if (kind === "pause" && after.running !== false) failures.push("the engine is still running after pause");
  else if (kind === "play" && after.running !== true) failures.push("the engine is not running after play");
  else if (kind === "next" && !(before && after.index === before.index + 1 && after.running === true)) {
    failures.push(`next moved the queue from item ${before?.index} to ${after.index} (running ${after.running})`);
  } else if (kind === "previous" && !(before && num(before.positionSec) && num(after.positionSec)
      && after.item === before.item && after.positionSec <= before.positionSec - GATES.previousMinRewindSec && after.running === true)) {
    failures.push(`previous moved the playhead from ${before?.positionSec} to ${after.positionSec} (item ${before?.item} → ${after.item}, running ${after.running})`);
  }
  return { ok: failures.length === 0, failures };
}

/** (d) the system media controls: our title, our show, 15/30, and their pause pauses the engine. */
export function verdictNotification({ controls, expected, tapped, after }) {
  const failures = [];
  if (!controls) failures.push("the shade could not be read (uiautomator dump)");
  else {
    if (!controls.title) failures.push(`no control shows our title ${JSON.stringify(expected?.title)}`);
    if (!controls.artist) failures.push(`no control shows our show ${JSON.stringify(expected?.artist)}`);
    if (!controls.back15) failures.push("no back-15 button");
    if (!controls.forward30) failures.push("no forward-30 button");
  }
  if (!tapped) failures.push("no pause button was tapped");
  else {
    if (tapped.runningBefore !== true) failures.push("the engine was not running before the tap, so the tap measured nothing");
    if (after?.running !== false) failures.push("the engine is still running after the tap on pause");
  }
  return { ok: failures.length === 0, failures };
}

/** (g) GATED: forced Doze, unplugged, rare bucket, five minutes: the queue covered four of them. */
export function verdictDoze({ first, last, items, wake, deep, bucket, pidBefore, pidAfter, service, killedBy = null }) {
  const failures = [];
  if (!/^(Asleep|Dozing)$/.test(String(wake ?? ""))) failures.push(`the screen did not go off: mWakefulness=${wake}`);
  if (deep !== "IDLE") failures.push(`Doze was not entered: deviceidle's deep state is ${deep}`);
  if (bucket !== GATES.bucketRare) failures.push(`the standby bucket reads ${bucket}, not rare (${GATES.bucketRare})`);
  const l0 = listenedSec(first, items);
  const l1 = listenedSec(last, items);
  const advancedSec = num(l0) && num(l1) ? +(l1 - l0).toFixed(3) : null;
  if (advancedSec == null) failures.push("the engine's playhead could not be read before and after");
  else if (advancedSec < GATES.dozeMinAdvanceSec) failures.push(`the queue advanced ${advancedSec} s in Doze; the gate is ${GATES.dozeMinAdvanceSec} s`);
  if (!pidBefore) failures.push("no app process before Doze");
  else if (pidAfter !== pidBefore) failures.push(`the pid changed from ${pidBefore} to ${pidAfter}${killedBy ? ` (${killedBy})` : ""}`);
  if (!service?.found || !service.isForeground || !service.mediaPlayback) failures.push(`${SERVICE} is not a mediaPlayback foreground service after Doze`);
  return { ok: failures.length === 0, failures, measured: { advancedSec, wake, deep, bucket, pidBefore, pidAfter, killedBy } };
}

/** (h) one phase's reads, pure. */
export function focusPhase({ mode, stackBefore, stackHeld, stackAfter, before, held, after, helperLog }) {
  const ours = (stack) => (stack?.entries ?? []).filter((e) => e.pack === PKG);
  const [b0, b1] = before ?? [];
  const [h0, h1] = held ?? [];
  const [a0, a1] = after ?? [];
  return {
    mode,
    helperGranted: (helperLog ?? []).some((l) => l.includes(`mode=${mode} result=1`)),
    before: { playing: playingBetween(b0, b1), ourEntries: ours(stackBefore) },
    whileHeld: { top: stackHeld?.top?.pack ?? null, ourEntries: ours(stackHeld), playing: playingBetween(h0, h1), running: h1?.running ?? null },
    afterAbandon: { top: stackAfter?.top?.pack ?? null, ourEntries: ours(stackAfter), playing: playingBetween(a0, a1), running: a1?.running ?? null },
    helperLog: helperLog ?? [],
  };
}

/** (h) GATED in native mode: we hold focus while playing; a transient loss (a duck on speech
 *  included) pauses us and its end resumes us; a permanent loss pauses us and never resumes. */
export function verdictFocus({ phases }) {
  const failures = [];
  if (!phases?.length) failures.push("no focus phase ran");
  for (const p of phases ?? []) {
    if (!p.helperGranted) {
      failures.push(`${p.mode}: the helper's AUDIOFOCUS request was not granted, so nothing took focus from us`);
      continue;
    }
    if (p.before.playing !== true) failures.push(`${p.mode}: the engine was not playing before the helper asked`);
    if (!p.before.ourEntries.length) failures.push(`${p.mode}: we held no audio focus while playing (the deck's handleAudioFocus)`);
    if (p.whileHeld.playing !== false) failures.push(`${p.mode}: still playing while the helper held focus`);
    if (p.mode === "transient" && p.afterAbandon.playing !== true) failures.push("transient: did not resume after the helper abandoned focus");
    /* A permanent loss is an interruption with no end (FocusMapping): the helper letting go
       gives us nothing back, so nothing may start playing again by itself. */
    if (p.mode === "gain" && p.afterAbandon.playing !== false) failures.push("gain: a permanent loss resumed by itself after the helper abandoned focus");
  }
  const recorded = (phases ?? []).map((p) => ({
    mode: p.mode, heldFocusBefore: p.before.ourEntries.length > 0, pausedWhileHeld: p.whileHeld.playing === false,
    resumedAfterAbandon: p.afterAbandon.playing === true, ourLossWhileHeld: p.whileHeld.ourEntries[0]?.loss ?? "(no entry)",
  }));
  return { ok: failures.length === 0, failures, recorded };
}

/** (i) GATED in native mode: the call rings, is answered and hangs up; we pause for it and resume after it. */
export function verdictCall({ phases }) {
  const failures = [];
  const at = (name) => (phases ?? []).find((p) => p.name === name) ?? null;
  for (const [name, state] of [["ringing", "RINGING"], ["in-call", "OFFHOOK"], ["ended", "IDLE"]]) {
    const p = at(name);
    if (!p) failures.push(`the ${name} phase did not run`);
    else if (p.callState !== state) failures.push(`${name}: mCallState is ${p.callState}, not ${state}`);
  }
  if (at("before")?.playing !== true) failures.push("the engine was not playing before the call");
  if (at("ringing")?.playing !== false) failures.push("still playing while the phone rang");
  if (at("in-call")?.playing !== false) failures.push("still playing during the call");
  if (at("ended")?.playing !== true && at("ended+10s")?.playing !== true) failures.push("did not resume after the call ended");
  const rec = (name) => {
    const p = at(name);
    return p ? { playing: p.playing, running: p.running, callState: p.callState, ourLoss: p.ourEntries?.[0]?.loss ?? "(no entry)" } : null;
  };
  return { ok: failures.length === 0, failures, recorded: { before: rec("before"), ringing: rec("ringing"), inCall: rec("in-call"), ended: rec("ended"), endedLater: rec("ended+10s") } };
}

export const SCENARIOS = Object.freeze([
  ["play", "(a) native: a clip plays in a mediaPlayback service, published"],
  ["background", "(b) native: Home, then screen off, 60 s"],
  ["transport", "(c) native: media_session dispatch + KEYCODE_MEDIA_*"],
  ["notification", "(d) native: system controls: title, show, 15/30, tap pause"],
  ["doze", "(g) native: Doze, unplugged, rare bucket, 5 min"],
  ["focus", "(h) native: another app takes audio focus; pause, and resume after a transient loss"],
  ["call", "(i) native: a phone call; pause, and resume after it"],
]);

export function summaryMarkdown(verdicts) {
  const lines = ["| Scenario | Verdict | Failures |", "|---|---|---|"];
  for (const [id, label] of SCENARIOS) {
    const v = verdicts[id];
    const verdict = !v ? "not run" : v.ok ? "**pass**" : "**FAIL**";
    const why = v && !v.ok ? (v.failures ?? []).join("; ").replace(/\|/g, "\\|").slice(0, 400) : "";
    lines.push(`| ${label} | ${verdict} | ${why} |`);
  }
  return lines.join("\n");
}

/* ─────────────────────────── the live half ─────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shell = (...args) => adb(["shell", ...args]).stdout;

function save(ctx, name, content) {
  fs.writeFileSync(path.join(ctx.art, name), content);
  return name;
}

function dumpTo(ctx, name, ...args) {
  const out = shell(...args);
  save(ctx, name, out);
  return out;
}

function wakeAndUnlock() {
  shell("input", "keyevent", "KEYCODE_WAKEUP");
  shell("wm", "dismiss-keyguard");
}

/** The app on screen (a foreground app may start the foreground service), awake and unlocked. */
async function prepare(ctx) {
  wakeAndUnlock();
  await sleep(800);
  shell("am", "start", "-W", "-n", `${ctx.pkg}/.MainActivity`);
  await sleep(1500);
  return pidOf(ctx.pkg);
}

/** One driver broadcast, and its answer. */
function drive(ctx, cmd, extra = []) {
  const out = adb(["shell", "am", "broadcast", "-n", RECEIVER_COMPONENT.replace(PKG, ctx.pkg), "--es", "cmd", cmd, ...extra], { timeoutMs: 30000 });
  const r = broadcastResult(`${out.stdout}${out.stderr}`);
  ctx.drives = (ctx.drives ?? []).concat([{ cmd, ...r }]);
  return r;
}

function loadQueue(ctx, items, index = 0) {
  return drive(ctx, "load", ["--es", "queue", queueArg(items), "--ei", "index", String(index)]);
}

/** The engine's state now, read from the service's dump, stamped with this runner's clock. */
function engine(ctx) {
  const out = shell("dumpsys", "activity", "service", SERVICE_COMPONENT.replace(PKG, ctx.pkg));
  const { state, rows } = engineDump(out);
  ctx.lastRows = rows;
  return state ? { ...state, at: Date.now() } : null;
}

async function waitFor(ctx, pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let s = engine(ctx);
  while (!pred(s) && Date.now() < deadline) {
    await sleep(500);
    s = engine(ctx);
  }
  return s;
}

const isPlaying = (s) => !!s && s.running === true && s.exoPlaying === true && num(s.positionSec) && s.positionSec > 0;

/** Load a queue fresh (the app on screen) and wait for it to sound. */
async function startQueue(ctx, items, index = 0) {
  await prepare(ctx);
  const d = loadQueue(ctx, items, index);
  const s = await waitFor(ctx, isPlaying, 20000);
  return { drive: d, s };
}

async function window2(ctx) {
  const a = engine(ctx);
  await sleep(GATES.windowMs);
  const b = engine(ctx);
  return [a, b];
}

function services(ctx) {
  return foregroundService(shell("dumpsys", "activity", "services", ctx.pkg), SERVICE);
}

function killReason(pid, pkg) {
  return pid ? killLine(adb(["logcat", "-d", "-b", "system"]).stdout, pid, pkg) : null;
}

/** (a) */
async function play(ctx) {
  const { drive: d } = await startQueue(ctx, LONG_QUEUE);
  const first = engine(ctx);
  await sleep(GATES.playWindowMs);
  const last = engine(ctx);
  let service = null;
  let sessionsDump = "";
  let servicesDump = "";
  for (let i = 0; i < 3; i += 1) {
    servicesDump = shell("dumpsys", "activity", "services", ctx.pkg);
    sessionsDump = shell("dumpsys", "media_session");
    service = foregroundService(servicesDump, SERVICE);
    const ours = ourSession(mediaSessions(sessionsDump), ctx.pkg);
    if (service.isForeground && service.mediaPlayback && ours?.state === "PLAYING") break;
    await sleep(1000);
  }
  save(ctx, "a-dumpsys-activity-services.txt", servicesDump);
  save(ctx, "a-dumpsys-media_session.txt", sessionsDump);
  const v = verdictPlay({ drive: d, first, last, service, sessions: mediaSessions(sessionsDump) });
  return { ...v, measured: { ...v.measured, first }, evidence: ["a-dumpsys-activity-services.txt", "a-dumpsys-media_session.txt"] };
}

/** (b) */
async function background(ctx) {
  const { s: started } = await startQueue(ctx, LONG_QUEUE);
  const pidBefore = pidOf(ctx.pkg);
  shell("input", "keyevent", "KEYCODE_HOME");
  await sleep(1500);
  shell("input", "keyevent", "KEYCODE_SLEEP");
  await sleep(2000);
  const wake = wakefulness(dumpTo(ctx, "b-dumpsys-power.txt", "dumpsys", "power"));
  const first = engine(ctx);
  const curve = [{ at: first?.at, index: first?.index, positionSec: first?.positionSec }];
  const end = Date.now() + GATES.backgroundWaitMs;
  let last = first;
  while (Date.now() < end) {
    await sleep(Math.min(10000, Math.max(0, end - Date.now())));
    const s = engine(ctx);
    if (s) last = s;
    curve.push({ at: s?.at, index: s?.index, positionSec: s?.positionSec, running: s?.running });
  }
  const pidAfter = pidOf(ctx.pkg);
  const service = services(ctx);
  const v = verdictBackground({
    first, last, items: LONG_QUEUE, pidBefore, pidAfter, wake, service,
    killedBy: pidAfter === pidBefore ? null : killReason(pidBefore, ctx.pkg),
  });
  return { ...v, measured: { ...v.measured, started: !!started, curve }, evidence: ["b-dumpsys-power.txt"] };
}

function pressDone(kind, before) {
  return (s) => {
    if (!s) return false;
    if (kind === "pause") return s.running === false;
    if (kind === "play") return s.running === true && s.exoPlaying === true;
    if (kind === "next") return s.index === (before?.index ?? -2) + 1 && isPlaying(s);
    return s.item === before?.item && num(s.positionSec) && num(before?.positionSec)
      && s.positionSec <= before.positionSec - GATES.previousMinRewindSec && isPlaying(s);
  };
}

async function press(ctx, p) {
  const before = engine(ctx);
  const out = shell(...p.args);
  const after = await waitFor(ctx, pressDone(p.kind, before), GATES.pressTimeoutMs);
  const v = verdictPress({ kind: p.kind, before, after });
  return { route: p.route, kind: p.kind, press: p.args.join(" "), ok: v.ok, failures: v.failures, output: String(out).trim().slice(0, 200),
    before: before && { state: before.state, index: before.index, positionSec: before.positionSec, running: before.running },
    after: after && { state: after.state, index: after.index, positionSec: after.positionSec, running: after.running } };
}

/** The engine playing, not on the last item when a next is next. The driver's own TAP play or a
 *  fresh load, never a media key: a failed press must not set up the next one. */
async function ensureRunning(ctx, { notLast = false } = {}) {
  let s = engine(ctx);
  if (isPlaying(s) && !(notLast && s.index >= LONG_QUEUE.length - 1)) return s;
  if (s && s.queue === LONG_QUEUE.length && !(notLast && s.index >= LONG_QUEUE.length - 1)) {
    drive(ctx, "play");
    s = await waitFor(ctx, isPlaying, 10000);
    if (isPlaying(s)) return s;
  }
  loadQueue(ctx, LONG_QUEUE, 0);
  return waitFor(ctx, isPlaying, 20000);
}

/** (c) Every press, by both routes: a foreground control first, then with the app on Home. */
async function transport(ctx) {
  await startQueue(ctx, LONG_QUEUE);
  const control = [];
  for (const p of PRESSES.filter((x) => x.route === "dispatch" && (x.kind === "pause" || x.kind === "play"))) {
    control.push(await press(ctx, p));
    await sleep(1500);
  }
  shell("input", "keyevent", "KEYCODE_HOME");
  await sleep(2000);
  const presses = [];
  for (const p of PRESSES) {
    if (p.kind !== "play") await ensureRunning(ctx, { notLast: p.kind === "next" });
    if (p.kind === "previous") await sleep(GATES.previousSettleMs);
    presses.push(await press(ctx, p));
    await sleep(1500);
  }
  save(ctx, "c-dumpsys-media_session.txt", shell("dumpsys", "media_session"));
  const failures = [
    ...control.filter((p) => !p.ok).map((p) => `foreground: ${p.press}: ${p.failures.join("; ")}`),
    ...presses.filter((p) => !p.ok).flatMap((p) => p.failures.map((f) => `${p.press}: ${f}`)),
  ];
  return { ok: failures.length === 0, failures, measured: { foregroundControl: control, presses }, evidence: ["c-dumpsys-media_session.txt"] };
}

async function dumpUi(ctx, name) {
  const attempts = [];
  for (let i = 0; i < 2; i += 1) {
    const r = adb(["shell", "uiautomator", "dump", "/sdcard/window_dump.xml"], { timeoutMs: 45000 });
    const said = `${r.stdout}${r.stderr}`.trim();
    attempts.push(said.slice(0, 200));
    if (/dumped to/i.test(said)) {
      const xml = shell("cat", "/sdcard/window_dump.xml");
      save(ctx, name, xml);
      return { xml, attempts };
    }
    await sleep(1000);
  }
  return { xml: null, attempts };
}

/** One shade layout; a playing panel animates and `uiautomator` may refuse it, so the fallback
 *  reads it paused (by the driver, not a media key) and resumes. */
async function readShade(ctx, how, log) {
  shell("cmd", "statusbar", how);
  await sleep(2500);
  const shot = adb(["exec-out", "screencap", "-p"], { binary: true });
  if (pngInfo(shot.stdout)) save(ctx, `d-shade-${how}.png`, shot.stdout);
  let dump = await dumpUi(ctx, `d-window-${how}.xml`);
  log.push({ how, dump: dump.attempts });
  let paused = false;
  if (!dump.xml) {
    drive(ctx, "pause");
    await waitFor(ctx, (s) => s?.running === false, GATES.pressTimeoutMs);
    dump = await dumpUi(ctx, `d-window-${how}-paused.xml`);
    log.push({ how, pausedDump: dump.attempts });
    paused = true;
  }
  return { how, paused, xml: dump.xml };
}

/** (d) */
async function notification(ctx) {
  const { drive: d, s } = await startQueue(ctx, EPISODE_QUEUE);
  const expected = { title: s?.title ?? EPISODE.title, artist: s?.artist ?? SHOW };
  const log = [];
  let chosen = null;
  for (const how of ["expand-notifications", "expand-settings"]) {
    const read = await readShade(ctx, how, log);
    if (read.paused) {
      drive(ctx, "play");
      await waitFor(ctx, isPlaying, GATES.pressTimeoutMs);
    }
    if (!read.xml) continue;
    const controls = mediaControls(uiNodes(read.xml), expected);
    log.push({ how, found: Object.fromEntries(Object.entries(controls).map(([k, v]) => [k, !!v])) });
    const usable = controls.title && (controls.pause || controls.play);
    const complete = usable && controls.back15 && controls.forward30;
    if (usable && (!chosen || complete)) chosen = { how, controls, paused: read.paused };
    if (complete) break;
  }
  let tapped = null;
  if (chosen) {
    shell("cmd", "statusbar", chosen.how);
    await sleep(2000);
    const button = chosen.controls.pause ?? chosen.controls.play;
    const before = engine(ctx);
    const at = center(button.bounds);
    shell("input", "tap", String(at.x), String(at.y));
    tapped = { how: chosen.how, at, label: button.desc || button.text, viaPausedDump: chosen.paused, runningBefore: before?.running ?? null };
  }
  const after = tapped ? await waitFor(ctx, (x) => x?.running === false, GATES.pressTimeoutMs) : engine(ctx);
  shell("cmd", "statusbar", "collapse");
  const sessionsDump = dumpTo(ctx, "d-dumpsys-media_session.txt", "dumpsys", "media_session");
  const controls = chosen?.controls ?? null;
  const v = verdictNotification({ controls, expected, tapped, after });
  const found = controls
    ? Object.fromEntries(Object.entries(controls).map(([k, n]) => [k, n ? { text: n.text, desc: n.desc, bounds: n.bounds } : null]))
    : null;
  return {
    ...v,
    measured: { drive: d, expected, found, tapped, log, sessionCustomActions: ourSession(mediaSessions(sessionsDump), ctx.pkg)?.customActions ?? null,
      after: after && { state: after.state, running: after.running } },
    evidence: fs.readdirSync(ctx.art).filter((f) => f.startsWith("d-")),
  };
}

/** (g) */
async function doze(ctx) {
  await startQueue(ctx, DOZE_QUEUE);
  const pidBefore = pidOf(ctx.pkg);
  const set = {};
  try {
    shell("input", "keyevent", "KEYCODE_HOME");
    await sleep(1500);
    set.unplug = shell("dumpsys", "battery", "unplug").trim();
    shell("input", "keyevent", "KEYCODE_SLEEP");
    await sleep(2000);
    set.enable = shell("dumpsys", "deviceidle", "enable").trim();
    set.forceIdle = shell("dumpsys", "deviceidle", "force-idle").trim();
    set.bucket = shell("am", "set-standby-bucket", ctx.pkg, "rare").trim();
    const wake = wakefulness(dumpTo(ctx, "g-dumpsys-power.txt", "dumpsys", "power"));
    const deep = shell("dumpsys", "deviceidle", "get", "deep").trim();
    const bucket = intLine(shell("am", "get-standby-bucket", ctx.pkg));
    const first = engine(ctx);
    const curve = [{ at: first?.at, index: first?.index, positionSec: first?.positionSec, deep }];
    const end = Date.now() + GATES.dozeWaitMs;
    let last = first;
    while (Date.now() < end) {
      await sleep(Math.min(GATES.dozeSampleMs, Math.max(0, end - Date.now())));
      const s = engine(ctx);
      if (s) last = s;
      curve.push({ at: s?.at, index: s?.index, positionSec: s?.positionSec, running: s?.running, deep: shell("dumpsys", "deviceidle", "get", "deep").trim() });
    }
    const pidAfter = pidOf(ctx.pkg);
    const service = foregroundService(dumpTo(ctx, "g-dumpsys-activity-services.txt", "dumpsys", "activity", "services", ctx.pkg), SERVICE);
    const v = verdictDoze({
      first, last, items: DOZE_QUEUE, wake, deep, bucket, pidBefore, pidAfter, service,
      killedBy: pidAfter === pidBefore ? null : killReason(pidBefore, ctx.pkg),
    });
    return { ...v, measured: { ...v.measured, set, curve }, evidence: ["g-dumpsys-power.txt", "g-dumpsys-activity-services.txt"] };
  } finally {
    shell("dumpsys", "deviceidle", "unforce");
    shell("dumpsys", "battery", "reset");
    shell("am", "set-standby-bucket", ctx.pkg, "active");
  }
}

function helperLog() {
  return String(adb(["logcat", "-d", "-s", HELPER_TAG]).stdout)
    .split(/\r?\n/)
    .filter((l) => l.includes(HELPER_TAG) && /mode=|focusChange=/.test(l))
    .map((l) => l.replace(/^.*?A05Focus\s*:\s*/, "").trim());
}

/** (h) */
async function focus(ctx) {
  const apk = path.join(ctx.art, HELPER_APK);
  if (!fs.existsSync(apk)) throw new Error(`no helper APK at ${apk}: the job's helper build step did not run`);
  const install = adb(["install", "-r", apk], { timeoutMs: 120000 });
  const installOut = `${install.stdout}${install.stderr}`.trim();
  if (!/Success/.test(installOut)) throw new Error(`the helper APK did not install: ${installOut.slice(0, 200)}`);
  const phases = [];
  try {
    for (const mode of ["transient", "gain"]) {
      await startQueue(ctx, LONG_QUEUE);
      const before = await window2(ctx);
      const stackBefore = focusStack(dumpTo(ctx, `h-${mode}-0-before-dumpsys-audio.txt`, "dumpsys", "audio"));
      const logFrom = helperLog().length;
      shell("am", "start", "-W", "-n", HELPER_ACTIVITY, "--es", "mode", mode);
      await sleep(GATES.settleMs);
      const held = await window2(ctx);
      const stackHeld = focusStack(dumpTo(ctx, `h-${mode}-1-held-dumpsys-audio.txt`, "dumpsys", "audio"));
      shell("am", "start", "-W", "-n", HELPER_ACTIVITY, "--es", "mode", "abandon");
      await sleep(GATES.settleMs);
      const after = await window2(ctx);
      const stackAfter = focusStack(dumpTo(ctx, `h-${mode}-2-abandoned-dumpsys-audio.txt`, "dumpsys", "audio"));
      phases.push(focusPhase({ mode, stackBefore, stackHeld, stackAfter, before, held, after, helperLog: helperLog().slice(logFrom) }));
    }
  } finally {
    shell("am", "force-stop", HELPER_PKG);
  }
  const v = verdictFocus({ phases });
  return { ...v, measured: { phases }, evidence: fs.readdirSync(ctx.art).filter((f) => f.startsWith("h-")) };
}

/** (i) */
async function call(ctx) {
  const number = "5550105";
  await startQueue(ctx, LONG_QUEUE);
  shell("input", "keyevent", "KEYCODE_HOME");
  await sleep(1500);
  const phases = [];
  const measure = async (name, settle) => {
    await sleep(settle);
    const [a, b] = await window2(ctx);
    const stack = focusStack(dumpTo(ctx, `i-${phases.length}-${name}-dumpsys-audio.txt`, "dumpsys", "audio"));
    phases.push({
      name, callState: callState(shell("dumpsys", "telephony.registry")), top: stack.top?.pack ?? null,
      ourEntries: stack.entries.filter((e) => e.pack === ctx.pkg), advancedSec: moved(a, b), playing: playingBetween(a, b), running: b?.running ?? null,
    });
  };
  const emu = {};
  try {
    await measure("before", 0);
    emu.call = `${adb(["emu", "gsm", "call", number]).stdout}`.trim();
    await measure("ringing", GATES.settleMs);
    emu.accept = `${adb(["emu", "gsm", "accept", number]).stdout}`.trim();
    await measure("in-call", GATES.settleMs);
    emu.cancel = `${adb(["emu", "gsm", "cancel", number]).stdout}`.trim();
    await measure("ended", 3000);
    await measure("ended+10s", 2000);
  } finally {
    adb(["emu", "gsm", "cancel", number]);
  }
  const v = verdictCall({ phases });
  return { ...v, measured: { number, emu, phases }, evidence: fs.readdirSync(ctx.art).filter((f) => f.startsWith("i-")) };
}

/** The evidence: the engine's dump and rows, logcat, the system's view. Never fails. */
async function collect(ctx) {
  save(ctx, "native-engine-dump.txt", shell("dumpsys", "activity", "service", SERVICE_COMPONENT.replace(PKG, ctx.pkg)));
  save(ctx, "logcat-ForayEngine.txt", adb(["logcat", "-d", "-s", "ForayEngine", "ForayEngine.drive", "ForayEngine.ExoDeck", "ForayAudio"]).stdout);
  save(ctx, "logcat.txt", adb(["logcat", "-d"]).stdout);
  save(ctx, "final-dumpsys-media_session.txt", shell("dumpsys", "media_session"));
  save(ctx, "final-dumpsys-activity-services.txt", shell("dumpsys", "activity", "services", ctx.pkg));
  save(ctx, "final-dumpsys-audio.txt", shell("dumpsys", "audio"));
  return { ok: true, failures: [], evidence: ["native-engine-dump.txt", "logcat-ForayEngine.txt", "logcat.txt"] };
}

function summary(ctx) {
  const verdicts = {};
  for (const [id] of SCENARIOS) {
    try {
      verdicts[id] = JSON.parse(fs.readFileSync(path.join(ctx.art, `verdict-native-${id}.json`), "utf8"));
    } catch {
      /* not run */
    }
  }
  console.log(summaryMarkdown(verdicts));
}

const RUNNERS = { play, background, transport, notification, doze, focus, call, collect };

export function parseArgs(argv) {
  const [scenario, ...rest] = argv;
  if (!scenario || !(scenario in RUNNERS || scenario === "summary")) {
    throw new Error(`first argument must be one of ${[...Object.keys(RUNNERS), "summary"].join(", ")}; got ${JSON.stringify(scenario)}`);
  }
  const out = { scenario, pkg: PKG, art: null };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    const v = rest[i + 1];
    if ((a === "--pkg" || a === "--art") && (v === undefined || v.startsWith("--"))) throw new Error(`${a} needs a value`);
    if (a === "--pkg") out.pkg = rest[++i];
    else if (a === "--art") out.art = rest[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.art) throw new Error("--art DIR is required: every scenario writes its verdict and evidence there");
  return out;
}

async function main(argv) {
  const args = parseArgs(argv);
  fs.mkdirSync(args.art, { recursive: true });
  const ctx = { ...args };
  if (args.scenario === "summary") {
    summary(ctx);
    return 0;
  }
  let result;
  let code;
  try {
    result = await RUNNERS[args.scenario](ctx);
    code = result.ok ? 0 : 1;
  } catch (e) {
    result = { ok: false, failures: [`the scenario could not run: ${String(e?.message ?? e)}`], error: String(e?.stack ?? e) };
    code = 2;
  }
  const verdict = { scenario: args.scenario, mode: "native", at: new Date().toISOString(), ...result, drives: ctx.drives ?? [],
    engineRows: (ctx.lastRows ?? []).slice(-40) };
  const json = JSON.stringify(verdict, null, 2);
  fs.writeFileSync(path.join(args.art, `verdict-native-${args.scenario}.json`), json + "\n");
  console.log(json);
  if (!verdict.ok) {
    console.error(`\nnative ${args.scenario}: FAIL`);
    for (const f of verdict.failures) console.error(`  - ${f}`);
  } else {
    console.log(`\nnative ${args.scenario}: pass`);
  }
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (err) => {
      console.error(String(err?.message ?? err));
      process.exit(2);
    }
  );
}
