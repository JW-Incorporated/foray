#!/usr/bin/env node
/* The Android playback scenarios in NATIVE MODE (card A-26,
 * `docs/plans/android-assessment.md` §5.4): A-04/A-05's (a)–(d), (g), (h) and (i),
 * and since A-27 (j), run against the native engine's `ForayPlaybackService`
 * instead of the page's player, on the CI emulator, over adb only.
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
 * `doze` (g), `focus` (h), `call` (i), `kill` (j, A-27), `bridge` (A-28),
 * `fallback` (A-29), and `collect` / `summary`. Every one is GATED here (A-26:
 * "must be green on (a)–(d), (g), (h) and (i)"; A-27: "(j) in native mode: after
 * `am kill`, dispatching `play` resumes 4a at the saved position. Gated."; A-28's:
 * "the emulator native leg logs `engine mode native` in the Copy paste"). Each
 * prints its verdict as JSON, writes `DIR/verdict-native-<scenario>.json`, and
 * exits 0 (pass), 1 (the verdict failed) or 2 (it could not run).
 *
 * The pure half (the queue, the dump and broadcast parsers, the verdicts) is
 * exported and pinned by `android-native-playback.test.mjs`.
 *
 * ── THE PAGE'S DOOR (A-28) ───────────────────────────────────────────────────
 *
 * `bridge` is the one scenario that goes through the PAGE, over Chrome DevTools
 * (the JS runner's `connect` / `page`): since A-28 the page asks the Android
 * engine `engineHello`. It reads the stock launch's lane (the engine's legacy
 * answer: the JS player, with the Developer engine row showing Automatic), turns
 * the Developer engine setting to Native through the page's own Developer
 * command (`ForayPlayer.engineDeveloperSend`, the row a listener taps), restarts
 * the app, and reads the diagnostics Copy: `engine=native … reason=override` in
 * its header, an `engineMode native` row in its timeline, and the engine's ring
 * read into it. It runs after the adb-driven scenarios, and puts the
 * setting back to Automatic.
 *
 * ── THE FALLBACK (A-29) ──────────────────────────────────────────────────────
 *
 * `fallback` runs LAST. It proves the card's acceptance, "an emulator mutation
 * (engine throws at hello) falls back to `js` with a diagnostics row", and the
 * strike rule behind it, over four launches of the app:
 *
 *   - the debug driver turns the Developer setting to Native (through the owner,
 *     so the strikes start at 0) and arms the engine's debug fault
 *     (`EngineFaults`: the engine throws while answering engineHello);
 *   - launches 1–3: the lane is native (`reason=override strikes=n-1`), the hello
 *     throws, and the engine gives the process back: a `mode kind=fault at=hello`
 *     row, a page-health strike (`strikes=n`), the core's `mode reason=downgrade
 *     cap=all` row, and the engine's service stopped. The page runs its own player
 *     (lane `js`, an `engineMode js` row in its Copy), and on the first launch the
 *     legacy service STARTS when the page asks for it: a fallback, not silence;
 *   - launch 4: three strikes pin the build to the JS lane (`mode=legacy
 *     reason=crash-loop strikes=3`, sticky to the versionCode), and the engine's
 *     service never starts.
 *
 * The facts are read from logcat (`ForayEngine` rows and `ForayEngine.owner`
 * lines) and from the driver's `keys` answer; the fault and the setting are put
 * back afterwards whatever happened.
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
  mediaButtonRoute,
  mediaControls,
  mediaSessions,
  pidOf,
  pngInfo,
  receiverOf,
  uiNodes,
  wakefulness,
  DIAGNOSTICS_EXPRESSION,
  connect as connectPage,
  page as evalPage,
} from "./android-playback.mjs";

/** Where the page's DevTools socket is forwarded (the JS runner's default). */
export const DEVTOOLS_ENDPOINT = "http://127.0.0.1:9222";

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

/** (j): two whole EPISODES, with no in- or out-point. A bounded item is a segment, and the
 *  engine keeps no resume point for a segment (`persistPosition`), so the record a car's
 *  PLAY resumes from would say nothing. The first is the CBR track: its seeks are exact
 *  (A-25, measurements §8), so "at the saved position" can be judged to a second. The ids
 *  are the leg's own, so each leg starts from 0: an id another leg left a position for would
 *  resume from there, and the third leg would pause inside the near-end window. */
export function killQueue(leg) {
  return Object.freeze([CLIPS[0], CLIPS[1]].map((c, i) => Object.freeze({
    id: `a27-${leg}-${i}`,
    kind: "episode",
    title: c.title,
    show: SHOW,
    audio_url: `${ASSET_BASE}${c.file}`,
    duration_sec: 90,
  })));
}
export const KILL_QUEUE = killQueue("kill");

/** (j)'s legs, in order: how the process is ended, and what is gated. */
export const KILL_LEGS = Object.freeze([
  /* The card's: `am kill` only ends a process the system considers cached, and a paused Media3
     service stays in the foreground for ten minutes, so this is the warm path (§7 found the same
     on the JS lane). */
  Object.freeze({ leg: "am-kill", gated: true }),
  /* The swipe: the service hears onTaskRemoved (Media3's default stops a paused service), then
     `am kill` ends the cached process, and nothing restarts it. The play reaches nobody but the
     last media button receiver: ours, then Media3's playback resumption. The car-after-swipe
     device check, on the emulator. */
  Object.freeze({ leg: "swipe-am-kill", gated: true, viaReceiver: true }),
  /* What the low-memory killer does. The system restarts the sticky service a second later,
     and the play reaches its (empty) session: Media3's resumption again, by the session door. */
  Object.freeze({ leg: "sigkill", gated: true }),
  /* The negative control the plan names (A-67): recorded, never gated. */
  Object.freeze({ leg: "force-stop", gated: false }),
]);

/** (j)'s numbers. */
export const KILL = Object.freeze({
  /** Played before the pause, so the saved playhead clears the position store's
   *  MIN_RESUME_SEC (10 s: under it an episode resumes from 0) and stays clear of its
   *  NEAR_END_SEC (30 s before the 90 s end). */
  playBeforePauseMs: 18000,
  /** The saved position must be at least this for the leg to measure anything. */
  minSavedSec: 10,
  /** After the kill, before the press: long enough for a SIGKILL to be reported. */
  afterKillMs: 3000,
  /** How long 4a has to be audible again after the press. */
  resumeTimeoutMs: 20000,
  /** "At the saved position": no earlier than this before it (an exact seek on CBR is never
   *  early, A-25), and no later than the time since the press plus this. */
  earlySec: 1,
  lateSlackSec: 2,
});

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

/* ─────────────────────────── the page's door (A-28) ─────────────────────────── */

/** The page's lane once its hello settled, and the Developer engine row's view
 *  (`ForayPlayer.engineDeveloperStatus`: `{lane, override, holdPolicy, commands}`). */
export const ENGINE_STATUS_EXPRESSION = `(async () => {
  const deadline = Date.now() + 20000;
  while (!(window.ForayPlayer && typeof window.ForayPlayer.whenEngineReady === "function") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }
  const P = window.ForayPlayer;
  if (!P || typeof P.whenEngineReady !== "function") return { error: "no ForayPlayer on window" };
  const lane = await P.whenEngineReady();
  const status = typeof P.engineDeveloperStatus === "function" ? P.engineDeveloperStatus() : null;
  return { lane, status };
})()`;

/** The Developer engine setting, through the page's own Developer command: the
 *  row a listener taps ('Playback engine: Automatic / Native / Web'). */
export function overrideExpression(mode) {
  return `(async () => {
  const P = window.ForayPlayer;
  if (!P || typeof P.engineDeveloperSend !== "function") return { error: "no engineDeveloperSend on window.ForayPlayer" };
  const reply = await P.engineDeveloperSend("setModeOverride", { mode: ${JSON.stringify(mode)} });
  return reply ? { ok: reply.ok === true, reason: reply.reason ?? null } : { error: "the page sent nothing (no Developer engine row)" };
})()`;
}

/** What a diagnostics Copy says about the engine: the header line
 *  (`engineHeaderLine`), the `engineMode` rows of the timeline (L22), and
 *  whether the engine's ring was read into it (NE-26). */
export function copyFacts(text) {
  const t = String(text ?? "");
  const header = /^engine=.*$/m.exec(t)?.[0] ?? null;
  const field = (name) => new RegExp(`(?:^|\\s)${name}=(\\S+)`).exec(header ?? "")?.[1] ?? null;
  const modeRows = [...t.matchAll(/^#\s*\d+\s+\S+\s+engineMode\s+(native|js)\s+\(([^)]*)\)\s*$/gm)]
    .map((m) => ({ mode: m[1], reason: m[2] }));
  const rowsLine = /^engine rows (\d+) of \d+/m.exec(t);
  const notRead = /^engine rows not read \(([^)]*)\)/m.exec(t);
  return {
    header,
    lane: field("engine"),
    reason: field("reason"),
    caps: field("caps"),
    proto: field("proto"),
    modeRows,
    engineRows: rowsLine ? Number(rowsLine[1]) : null,
    readError: notRead ? notRead[1] : null,
  };
}

/** A-28's verdict: the stock launch is the engine's legacy lane, the Developer
 *  override is stored, and the relaunched page drives the native engine, which
 *  the Copy paste says in its header and in an `engineMode native` row. */
export function verdictBridge({ stock, override, after, copy, service }) {
  const failures = [];
  if (!stock || stock.error) failures.push(`the stock launch could not be read: ${stock?.error ?? "no answer"}`);
  else {
    if (stock.lane !== "js") failures.push(`a stock Android launch must run the page's player; its lane is ${stock.lane}`);
    if (stock.status?.lane !== "js" || stock.status?.override !== "auto") {
      failures.push(`the stock launch's engine did not answer legacy/build-default (Developer row ${JSON.stringify(stock.status)})`);
    }
  }
  if (!override || override.ok !== true) failures.push(`the Developer engine setting was not stored: ${JSON.stringify(override)}`);
  if (!after || after.error) failures.push(`the relaunched page could not be read: ${after?.error ?? "no answer"}`);
  else {
    if (after.lane !== "native") failures.push(`after the override the page's lane is ${after.lane}, not native`);
    if (after.status?.override !== "native") failures.push(`the Developer row does not read Native after the override: ${JSON.stringify(after.status)}`);
  }
  if (copy.lane !== "native") failures.push(`the Copy header is not engine=native: ${copy.header ?? "(no engine= line)"}`);
  else {
    if (copy.reason !== "override") failures.push(`the Copy header's reason is ${copy.reason}, not override`);
    if (copy.proto !== "1") failures.push(`the Copy header's protocol is ${copy.proto}, not 1`);
  }
  if (!copy.modeRows.some((r) => r.mode === "native")) failures.push("the Copy paste has no `engineMode native` row");
  if (copy.engineRows == null) failures.push(`the Copy did not read the engine's ring: ${copy.readError ?? "no engine rows line"}`);
  engineFailures(service, failures);
  return { ok: failures.length === 0, failures };
}

/* ─────────────────────────── the fallback (A-29) ─────────────────────────── */

/** The page asks the legacy service to start, reads it, and stops it: what the JS
 *  player's first play does after the engine gave the process back. */
export const LEGACY_START_EXPRESSION = `(async () => {
  const C = window.Capacitor;
  if (!C || typeof C.nativePromise !== "function") return { error: "no Capacitor.nativePromise on window" };
  const started = await C.nativePromise("ForayAudio", "start", {});
  await new Promise((r) => setTimeout(r, 1500));
  const state = await C.nativePromise("ForayAudio", "state", {});
  const stopped = await C.nativePromise("ForayAudio", "stop", {});
  return { started, state, stopped };
})()`;

/** What one launch's logcat (`-s ForayEngine ForayEngine.owner`) says the owner did:
 *  its decision line, and the engine's `mode` rows (the JSON after ` mode `). */
export function ownerFacts(text) {
  const t = String(text ?? "");
  const d = /ForayEngine\.owner mode=(\w+) reason=([\w-]+) strikes=(\d+) sentinelWasSet=([yn]) sticky=(\S+)/.exec(t);
  const rows = [];
  for (const m of t.matchAll(/ mode (\{.*\})\s*$/gm)) {
    try {
      rows.push(JSON.parse(m[1]));
    } catch {
      /* a line cut by logcat: not a row */
    }
  }
  return {
    decision: d
      ? { mode: d[1], reason: d[2], strikes: Number(d[3]), sentinelWasSet: d[4] === "y", sticky: d[5] === "null" ? null : d[5] }
      : null,
    fault: rows.find((r) => r.kind === "fault") ?? null,
    pageHealth: rows.find((r) => r.reason === "page-health") ?? null,
    downgrade: rows.find((r) => r.reason === "downgrade") ?? null,
    armed: /DEBUG fault armed: hello-throws/.test(t),
  };
}

/** A-29's verdict over the four launches. See the header. */
export function verdictFallback({ setup, launches }) {
  const failures = [];
  for (const [i, s] of (setup ?? []).entries()) {
    if (!s?.answer || s.answer.ok !== true) failures.push(`setup step ${i + 1} was not taken: ${JSON.stringify(s)}`);
  }
  const all = launches ?? [];
  if (all.length !== 4) failures.push(`expected 4 launches, ran ${all.length}`);
  for (const l of all) {
    const f = l.facts ?? {};
    const tag = `launch ${l.n}`;
    const lane = l.status?.lane ?? null;
    if (l.status?.error || lane == null) failures.push(`${tag}: the page's lane could not be read: ${l.status?.error ?? "no answer"}`);
    else if (lane !== "js") failures.push(`${tag}: the page's lane is ${lane}; a broken engine must leave the page on the JS player`);
    if (l.engineService) failures.push(`${tag}: ForayPlaybackService is still running after the fallback`);
    if (!(l.copy?.modeRows ?? []).some((r) => r.mode === "js")) failures.push(`${tag}: the page's Copy has no \`engineMode js\` row`);
    if (!f.decision) {
      failures.push(`${tag}: no ForayEngine.owner decision line in logcat`);
      continue;
    }
    if (l.n <= 3) {
      if (f.decision.mode !== "native" || f.decision.reason !== "override") {
        failures.push(`${tag}: the lane was ${f.decision.mode}/${f.decision.reason}, not native/override`);
      }
      if (f.decision.strikes !== l.n - 1) failures.push(`${tag}: decided with ${f.decision.strikes} strikes, expected ${l.n - 1}`);
      if (!f.armed) failures.push(`${tag}: the debug fault was not armed`);
      if (!f.fault || f.fault.at !== "hello") failures.push(`${tag}: no \`mode kind=fault at=hello\` row`);
      if (!f.pageHealth || f.pageHealth.strikes !== l.n) {
        failures.push(`${tag}: no page-health strike to ${l.n}: ${JSON.stringify(f.pageHealth)}`);
      }
      if (!f.downgrade || f.downgrade.cap !== "all") failures.push(`${tag}: the engine did not relinquish (no mode reason=downgrade cap=all row)`);
      const stored = l.keys?.["ForayEngine.strikes"];
      if (stored !== String(l.n)) failures.push(`${tag}: the stored strikes are ${stored}, not ${l.n}`);
    } else {
      if (f.decision.mode !== "legacy" || f.decision.reason !== "crash-loop") {
        failures.push(`${tag}: three strikes must pin the JS lane (crash-loop); decided ${f.decision.mode}/${f.decision.reason}`);
      }
      if (f.decision.strikes !== 3) failures.push(`${tag}: decided with ${f.decision.strikes} strikes, expected 3`);
      const pin = l.keys?.["ForayEngine.stickyLegacyBuild"];
      if (!f.decision.sticky || pin !== f.decision.sticky) {
        failures.push(`${tag}: the crash loop is not sticky to this build: ${f.decision.sticky} / ${pin}`);
      }
      if (f.fault) failures.push(`${tag}: a pinned build must not reach the engine at all, yet a fault row was written`);
    }
    if (l.n === 1) {
      const st = l.legacy?.started;
      if (!st || st.started !== true) {
        failures.push(`launch 1: the legacy service did not start after the fallback: ${JSON.stringify(l.legacy)}`);
      }
    }
  }
  return { ok: failures.length === 0, failures };
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

/** (j) one leg's reads, judged: did the play bring 4a back at the saved position. */
export function killLegVerdict(leg) {
  const failures = [];
  const name = leg?.leg ?? "?";
  const saved = leg?.saved ?? null;
  if (!saved || !num(saved.offsetSec)) failures.push(`${name}: no saved position was read before the kill`);
  else if (saved.offsetSec < KILL.minSavedSec) failures.push(`${name}: the saved position ${saved.offsetSec} s is under the ${KILL.minSavedSec} s resume floor, so the leg measured nothing`);
  if (saved && saved.running !== false) failures.push(`${name}: the engine was not paused before the kill`);
  if ((name === "sigkill" || name === "swipe-am-kill") && !leg.killed) {
    failures.push(`${name}: the process (pid ${leg.pidBefore}) did not die, so the cold path was not exercised`);
  }
  if (name === "swipe-am-kill" && !(leg.receiverStarts > 0)) {
    failures.push("swipe-am-kill: the media button receiver did not start the service, so the play did not come through it");
  }
  const r = leg?.resumed ?? null;
  if (!leg?.pidAfterDispatch) failures.push(`${name}: no 4a process after the play: the press did not bring 4a back`);
  if (!r) failures.push(`${name}: 4a was not playing within ${KILL.resumeTimeoutMs / 1000} s of the play`);
  else if (saved && num(saved.offsetSec)) {
    if (r.item !== saved.item) failures.push(`${name}: 4a resumed ${r.item}, not the saved ${saved.item}`);
    const late = (num(r.afterMs) ? r.afterMs / 1000 : 0) + KILL.lateSlackSec;
    if (!num(r.positionSec)) failures.push(`${name}: the resumed playhead could not be read`);
    else if (r.positionSec < saved.offsetSec - KILL.earlySec || r.positionSec > saved.offsetSec + late) {
      failures.push(`${name}: 4a resumed at ${r.positionSec} s, not at the saved ${saved.offsetSec} s (allowed ${-KILL.earlySec} s to +${late.toFixed(1)} s)`);
    }
  }
  /* A process that died and came back must have come back through the record: the
     service's cold boot painted it (the dump's coldBoot), not a fresh load. */
  if (leg?.killed && r && r.coldBoot !== "painted") failures.push(`${name}: the process died, but the engine that played did not boot from the record (coldBoot ${r.coldBoot})`);
  return failures;
}

/** (j) GATED in native mode (A-27): a paused 4a, on Home, ended four ways (`KILL_LEGS`),
 *  then `cmd media_session dispatch play`. `am kill` (the card's), a swipe then `am kill`, and a
 *  SIGKILL from the app's own uid must each resume 4a at the saved position. `am force-stop`
 *  is the negative control: RECORDED, never gated (A-67). */
export function verdictKill({ legs }) {
  const failures = [];
  const byName = (n) => (legs ?? []).find((l) => l.leg === n) ?? null;
  for (const n of KILL_LEGS.filter((l) => l.gated).map((l) => l.leg)) {
    const leg = byName(n);
    if (!leg) failures.push(`the ${n} leg did not run`);
    else failures.push(...killLegVerdict(leg));
  }
  const recorded = (legs ?? []).map((l) => ({
    leg: l.leg, killed: l.killed, restartedBeforePlay: l.restartedBeforePlay ?? null,
    savedSec: l.saved?.offsetSec ?? null, resumedSec: l.resumed?.positionSec ?? null, resumedAfterMs: l.resumed?.afterMs ?? null,
    coldBoot: l.resumed?.coldBoot ?? null, receiverStarts: l.receiverStarts ?? null, lastReceiverBefore: l.routeBefore?.lastReceiver ?? null,
    receivedBy: l.receivedBy ?? null, ourProcessAfterPlay: !!l.pidAfterDispatch,
  }));
  return { ok: failures.length === 0, failures, recorded };
}

export const SCENARIOS = Object.freeze([
  ["play", "(a) native: a clip plays in a mediaPlayback service, published"],
  ["background", "(b) native: Home, then screen off, 60 s"],
  ["transport", "(c) native: media_session dispatch + KEYCODE_MEDIA_*"],
  ["notification", "(d) native: system controls: title, show, 15/30, tap pause"],
  ["doze", "(g) native: Doze, unplugged, rare bucket, 5 min"],
  ["focus", "(h) native: another app takes audio focus; pause, and resume after a transient loss"],
  ["call", "(i) native: a phone call; pause, and resume after it"],
  ["kill", "(j) native: paused, on Home, the process ended; a media play resumes 4a at the saved position"],
  ["bridge", "(A-28) native: the page asks the engine; the Developer override; `engine mode native` in the Copy"],
  ["fallback", "(A-29) native: the engine throws at hello; the page falls back to js with a fault row; 3 strikes pin the JS lane"],
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

/** (j) paused on Home: the kill queue played long enough to leave a resume point, then paused
 *  by the session's media key (the driver's pause if that did not land), then Home. */
async function pausedOnHome(ctx, leg) {
  await prepare(ctx);
  loadQueue(ctx, killQueue(leg), 0);
  await waitFor(ctx, isPlaying, 20000);
  await sleep(KILL.playBeforePauseMs);
  shell("cmd", "media_session", "dispatch", "pause");
  let s = await waitFor(ctx, (x) => x?.running === false, GATES.pressTimeoutMs);
  if (s?.running !== false) {
    drive(ctx, "pause");
    s = await waitFor(ctx, (x) => x?.running === false, GATES.pressTimeoutMs);
  }
  shell("input", "keyevent", "KEYCODE_HOME");
  await sleep(2000);
  const saved = engine(ctx);
  return saved && { item: saved.item, index: saved.index, positionSec: saved.positionSec, offsetSec: saved.recordOffsetSec,
    record: saved.record, running: saved.running, mediaButtonReceiver: saved.mediaButtonReceiver };
}

/** (j) one leg: end our paused process one way, press play, and read whether 4a came back where it was. */
const RECEIVER_LINE = "media-button receiver start";

function receiverStarts() {
  return String(adb(["logcat", "-d", "-s", "ForayEngine"]).stdout).split(/\r?\n/).filter((l) => l.includes(RECEIVER_LINE)).length;
}

async function killLeg(ctx, leg, kill) {
  const saved = await pausedOnHome(ctx, leg);
  const pidBefore = pidOf(ctx.pkg);
  const receiverBefore = receiverStarts();
  const routeBefore = mediaButtonRoute(dumpTo(ctx, `j-${leg}-0-before-dumpsys-media_session.txt`, "dumpsys", "media_session"));
  const killOut = await kill(pidBefore);
  await sleep(KILL.afterKillMs);
  const pidAfterKill = pidOf(ctx.pkg);
  const killed = !!pidBefore && pidAfterKill !== pidBefore;
  const routeAfterKill = mediaButtonRoute(dumpTo(ctx, `j-${leg}-1-after-kill-dumpsys-media_session.txt`, "dumpsys", "media_session"));
  const pressedAt = Date.now();
  const dispatch = shell("cmd", "media_session", "dispatch", "play").trim();
  let resumed = null;
  const deadline = pressedAt + KILL.resumeTimeoutMs;
  while (Date.now() < deadline) {
    const s = pidOf(ctx.pkg) ? engine(ctx) : null;
    if (isPlaying(s)) {
      resumed = { item: s.item, index: s.index, positionSec: s.positionSec, afterMs: s.at - pressedAt, coldBoot: s.coldBoot ?? null, record: s.record ?? null };
      break;
    }
    await sleep(500);
  }
  const sessionsAfter = dumpTo(ctx, `j-${leg}-2-after-play-dumpsys-media_session.txt`, "dumpsys", "media_session");
  const pidAfterDispatch = pidOf(ctx.pkg);
  const receiver = receiverStarts() - receiverBefore;
  save(ctx, `j-${leg}-3-engine-dump.txt`, shell("dumpsys", "activity", "service", SERVICE_COMPONENT.replace(PKG, ctx.pkg)));
  return {
    leg, saved, pidBefore, killOut: String(killOut ?? "").trim().slice(0, 200), pidAfterKill, killed,
    restartedBeforePlay: killed && !!pidAfterKill, killedBy: killed ? killReason(pidBefore, ctx.pkg) : null,
    routeBefore, routeAfterKill, dispatch: dispatch.slice(0, 200),
    receivedBy: receiverOf(mediaSessions(sessionsAfter), mediaButtonRoute(sessionsAfter)), pidAfterDispatch, resumed,
    receiverStarts: receiver,
  };
}

/** (j) */
async function kill(ctx) {
  const legs = [];
  try {
    const how = {
      "am-kill": () => shell("am", "kill", ctx.pkg),
      "swipe-am-kill": async () => {
        const removed = drive(ctx, "task-removed");
        await sleep(2000);
        return `task-removed ${JSON.stringify(removed.answer)}; am kill: ${shell("am", "kill", ctx.pkg).trim()}`;
      },
      sigkill: (pid) => (pid ? shell("run-as", ctx.pkg, "kill", "-9", pid) : "no pid"),
      "force-stop": () => shell("am", "force-stop", ctx.pkg),
    };
    for (const { leg } of KILL_LEGS) legs.push(await killLeg(ctx, leg, how[leg]));
  } finally {
    /* A play that went to another media app leaves it playing over what comes next. */
    for (const l of legs) {
      for (const p of String(l.receivedBy?.pkg ?? "").split(", ")) {
        if (p && p !== ctx.pkg) shell("am", "force-stop", p);
      }
    }
    /* And ours: the last leg left 4a playing in a process the receiver started. The next
       scenario (A-28's page door) starts from a stopped app, as a launch does. */
    shell("am", "force-stop", ctx.pkg);
  }
  const v = verdictKill({ legs });
  return { ...v, measured: { legs }, evidence: fs.readdirSync(ctx.art).filter((f) => f.startsWith("j-")) };
}

/** A-28: the page's door. See the header. */
async function bridge(ctx) {
  ctx.endpoint = ctx.endpoint ?? DEVTOOLS_ENDPOINT;
  await prepare(ctx);
  ctx.target = (await connectPage(ctx, { timeoutMs: 90000 })).target;
  const stock = await evalPage(ctx, ENGINE_STATUS_EXPRESSION, { timeoutMs: 45000 });
  save(ctx, "bridge-stock.json", JSON.stringify(stock, null, 2));
  const override = await evalPage(ctx, overrideExpression("native"), { timeoutMs: 30000 });

  // The lane is decided once per process: the setting applies at the next launch.
  shell("am", "force-stop", ctx.pkg);
  await sleep(1500);
  ctx.target = null;
  await prepare(ctx);
  ctx.target = (await connectPage(ctx, { timeoutMs: 90000 })).target;
  let after = null;
  try {
    after = await evalPage(ctx, ENGINE_STATUS_EXPRESSION, { timeoutMs: 45000 });
  } catch (e) {
    after = { error: String(e?.message ?? e) };
  }
  // Let the attach finish (the rows read, the first snapshot) before Copy.
  await sleep(3000);
  let text;
  try {
    text = String(await evalPage(ctx, DIAGNOSTICS_EXPRESSION, { timeoutMs: 30000 }));
  } catch (e) {
    text = `(the page could not be asked: ${String(e?.message ?? e)})`;
  }
  save(ctx, "bridge-diagnostics-copy.txt", text);
  const copy = copyFacts(text);
  const service = engine(ctx);
  save(ctx, "bridge-engine-dump.txt", shell("dumpsys", "activity", "service", SERVICE_COMPONENT.replace(PKG, ctx.pkg)));
  const v = verdictBridge({ stock, override, after, copy, service });

  // Leave the device as the other scenarios expect it: Automatic (best effort; the next launch).
  let reset = null;
  try {
    reset = await evalPage(ctx, overrideExpression("auto"), { timeoutMs: 20000 });
  } catch (e) {
    reset = { error: String(e?.message ?? e) };
  }
  return {
    ...v,
    measured: { stock, override, after, copy, service, reset },
    evidence: ["bridge-stock.json", "bridge-diagnostics-copy.txt", "bridge-engine-dump.txt"],
  };
}

/** A-29: the engine throws at hello, over four launches. See the header. */
async function fallback(ctx) {
  ctx.endpoint = ctx.endpoint ?? DEVTOOLS_ENDPOINT;
  const setup = [];
  const launches = [];
  try {
    // The driver's owner commands bind nothing: the lane is decided at the next launch.
    setup.push(drive(ctx, "override", ["--es", "mode", "native"]));
    setup.push(drive(ctx, "fault", ["--es", "fault", "hello-throws"]));
    for (let n = 1; n <= 4; n += 1) {
      shell("am", "force-stop", ctx.pkg);
      await sleep(1500);
      adb(["logcat", "-c"]);
      ctx.target = null;
      await prepare(ctx);
      ctx.target = (await connectPage(ctx, { timeoutMs: 90000 })).target;
      let status;
      try {
        status = await evalPage(ctx, ENGINE_STATUS_EXPRESSION, { timeoutMs: 45000 });
      } catch (e) {
        status = { error: String(e?.message ?? e) };
      }
      /* Past the healthy marker's 5 s run-loop leg, so the sentinel is settled before the next
         launch reads it, and past the hand-over's posted stop. */
      await sleep(6000);
      let legacy = null;
      if (n === 1) {
        try {
          legacy = await evalPage(ctx, LEGACY_START_EXPRESSION, { timeoutMs: 30000 });
        } catch (e) {
          legacy = { error: String(e?.message ?? e) };
        }
      }
      let text;
      try {
        text = String(await evalPage(ctx, DIAGNOSTICS_EXPRESSION, { timeoutMs: 30000 }));
      } catch (e) {
        text = `(the page could not be asked: ${String(e?.message ?? e)})`;
      }
      save(ctx, `fallback-${n}-diagnostics-copy.txt`, text);
      const log = adb(["logcat", "-d", "-s", "ForayEngine", "ForayEngine.owner"]).stdout;
      save(ctx, `fallback-${n}-logcat.txt`, log);
      const svc = shell("dumpsys", "activity", "services", ctx.pkg);
      save(ctx, `fallback-${n}-services.txt`, svc);
      const keys = drive(ctx, "keys").answer;
      launches.push({
        n, status, legacy, keys, facts: ownerFacts(log), copy: copyFacts(text),
        engineService: /ForayPlaybackService/.test(svc),
      });
    }
  } finally {
    // Put the device back whatever happened: no fault, Automatic (which also clears the strikes and the pin).
    drive(ctx, "fault", ["--es", "fault", "none"]);
    drive(ctx, "override", ["--es", "mode", "auto"]);
    shell("am", "force-stop", ctx.pkg);
  }
  const v = verdictFallback({ setup, launches });
  return {
    ...v,
    measured: { setup, launches },
    evidence: fs.readdirSync(ctx.art).filter((f) => f.startsWith("fallback-")),
  };
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

const RUNNERS = { play, background, transport, notification, doze, focus, call, kill, bridge, fallback, collect };

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
