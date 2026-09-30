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
 * engine `engineHello`. Since A-31 (the A1 flip) it reads a STOCK launch (the
 * Developer engine row on Automatic) as the native lane: the page's lane is
 * native, and the diagnostics Copy says `engine=native … caps=episode,continuation
 * reason=build-default` in its header, holds an `engineMode native` row and has
 * the engine's ring read into it. Then the flip itself, end to end: an episode
 * started by the page's own `ForayPlayer.play` (the episode row's call) is the
 * item the ENGINE is playing, in `ForayPlaybackService`, with the legacy service
 * not running. Last, the way back: the Developer engine setting to Web through
 * the page's own Developer command (`ForayPlayer.engineDeveloperSend`, the row a
 * listener taps), a relaunch, and the page's lane is the JS player. It runs after
 * the adb-driven scenarios, and puts the setting back to Automatic.
 *
 * Since A-42 (the A2 flip) the stock launch advertises `foray` too, and `bridge`
 * plays a Foray through the page's own `ForayPlayer.playForay` (the Foray page's
 * main button's call) between the episode and the way back: the ENGINE must be the
 * one playing it (its `forayId` in the dump), cross a seam of it, and the page's
 * lane must still be native afterwards (a relinquish would have put it on js).
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
 *
 * ── A-30: THE WHOLE LEG IN THE NATIVE LANE, (e), (f) AND (k) ─────────────────
 *
 * Card A-30: "Make the native leg of A-04/A-05 required-green on (a)–(e) and
 * (g)–(k). Record the seam numbers for episodes."
 *
 *   - THE LANE. Until A-30 the adb-driven scenarios drove the service from a
 *     process whose page was in the stock JS lane. Now every engine scenario
 *     stores the Developer setting first (the driver's `override`, which also
 *     clears the strikes: Native until A-31, Automatic since, because the stock
 *     lane IS native) and starts the app in a fresh process when the running one
 *     is not native, so the page, the owner, the receiver and the service are
 *     the ones A-31's flip ships. Every dump the scenario reads must
 *     say `nativeLane: true` (the service's own reading of
 *     `EngineOwnership.engineLane`), or the scenario fails: a leg that silently
 *     ran in the JS lane cannot pass as native.
 *   - (e) `first-launch`: a first launch in the native lane (from stopped), the
 *     JS leg's own (e) through the page (the app reaches a usable screen, the
 *     screenshot, the insets), plus the page's lane native and the service
 *     already hosting the engine when the page is up.
 *   - (f) `seams`, RECORDED: a queue of seven episode items (six segments over
 *     the three click tracks, same-source and cross-source, then one whole
 *     episode that ends at its file's end) played to its end with the app on
 *     Home and the screen off. Each seam is read from the engine's own rows
 *     (logcat `ForayEngine`, the device's clock): from the outgoing item's last
 *     `time-control` away from playing (or its `outPoint` stop) to the incoming
 *     item's first `time-control playing`. Gated only on the queue having
 *     crossed every seam, with the screen off, in one process; the gaps are
 *     recorded (A-40's 1 s bar is the Foray tape's, not this card's).
 *   - (f) `foray-seams` (A-40), GATED: a Foray (the page's build of eight 8 s
 *     segments over the click tracks, six seams across sources and one inside
 *     one source) handed to the engine as the contract's `playForay` (the
 *     debug driver's `foray`: the page's bridge refuses it until A-42), played
 *     to its end with the app on Home and the screen off, on the Foray tape's
 *     deck pair. Each seam is read from the engine's rows: from the outgoing
 *     segment's out-point stop to the incoming one's first `time-control
 *     playing`, the 0.5 s beat included, with the engine's own packed `seam`
 *     row beside it (the gap the core measured, and whether the standby deck
 *     had the segment). Gated on every seam crossed, hidden, in one process,
 *     with p95 <= 1 s (A-40's acceptance). Since A-41 a seam across two
 *     sources carries the interlude JINGLE (the engine's own player, the
 *     bundled asset), which is sound, not silence: the gated number is the
 *     SILENCE (the gap less the jingle's span, from its `interlude
 *     kind=started` row to its end row), the raw gap is recorded beside it,
 *     and the jingle must have sounded on at least one seam.
 *   - (k) `airplane`: two halves, both gated. The ENGINE's: in airplane mode an
 *     episode whose file cannot load is stopped by the engine (a `stop` row with
 *     cause `error` or `load-deadline`) within the deck's load deadline plus
 *     slack, nothing is left playing or claiming PLAYING, and a bundled episode
 *     then plays. The PAGE's: until A-42 a Foray tapped in the native lane was
 *     relinquished to the page's player (the binary advertised no `foray`), and
 *     the JS leg's own (k) ran on it; since A-42 it is the ENGINE's (below).
 *
 * ── A-41: (k) THROUGH THE ENGINE ────────────────────────────────────────────
 *
 * Card A-41: "Rendered narration plays as ordinary files. TextToSpeech becomes a
 * seam behind the engine, used only when a file is missing." Acceptance: "A-05
 * (k) is green in native mode." So (k) gains a third half, the ENGINE'S FORAY,
 * still in airplane mode: the debug driver's `foray` (the contract's
 * playForay) hands the engine a clip, a RENDERED line on a bundled file (the
 * job's `a05/` .m4a), a clip, a rendered line on the network (which airplane
 * mode cannot load), and a clip to land on. Gated: the bundled line is heard as
 * a FILE on the deck (the dump shows it as the audible item); the network line
 * falls back (`narration kind=fallback` at the bridge) within the deadline and
 * its script is SPOKEN by the engine's own synthesiser (`speaker
 * kind=line-started`) or skipped, as the JS leg's (k) allows; and the Foray
 * lands on its last clip, playing, in the engine, in one process.
 *
 * ── A-42: THE PAGE'S FORAY IS THE ENGINE'S ─────────────────────────────────
 *
 * Card A-42 (the A2 flip): Android advertises `foray`, so a Foray tapped on the
 * page plays on the engine, as on iOS since NE-37. (k)'s page half is therefore
 * the A-41 Foray again, BUILT BY THE PAGE (`buildForay`, `ForayPlayer.resolve`,
 * `ForayPlayer.playForay`) instead of handed over by the debug driver, in a fresh
 * native-lane process in airplane mode, with the same gates (the bundled line a
 * file, the network line's fallback at its bridge in time and spoken by the
 * engine, the landing), plus: the engine holds the PAGE's Foray, and the Copy has
 * no `engineMode js (relinquished)` row. The page's clips and lines point at the
 * APK's own assets (`asset:///public/…`), because the page's `https://localhost`
 * origin is the WebView's and the engine's deck cannot fetch it.
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
  NARRATION_LINES,
  buildForay,
  startForayExpression,
  UNREACHABLE_NARRATION_URL,
  UNREACHABLE_SCRIPT,
  connect as connectPage,
  firstLaunchScenario,
  page as evalPage,
  ENGINE_STATUS_EXPRESSION,
  broadcastResult,
} from "./android-playback.mjs";

/* A-31 moved these two to the JS runner, whose first step pins the JS lane with them. */
export { ENGINE_STATUS_EXPRESSION, broadcastResult };

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

/** A-31: the episode the page plays through its own `ForayPlayer.play` (the episode row's call),
 *  as the engine's deck reads a bundled asset: the (d) click track, whole. Its id is the flip's
 *  own, so the engine's `item` names this play and no driver's. */
export const PAGE_EPISODE = Object.freeze({
  id: "a31-page-episode",
  title: EPISODE.title,
  show: SHOW,
  audio_url: `${ASSET_BASE}${EPISODE.file}`,
  duration_sec: 90,
});

/** The page plays `item` through `ForayPlayer.play`, as a tap on an episode row does. */
export function pagePlayExpression(item = PAGE_EPISODE) {
  return `(async () => {
  const P = window.ForayPlayer;
  if (!P || typeof P.play !== "function") return { ok: false, error: "window.ForayPlayer.play is missing" };
  try {
    const answered = await P.play(${JSON.stringify(item)});
    return { ok: true, answered };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
})()`;
}

/** A-42: where a page-built Foray's clips and lines point, so the engine's deck reads the APK's own
 *  assets (`asset:///public/a04/…`, `…/a05/…`). The page's `https://localhost` origin is the
 *  WebView's; the engine's ExoPlayer cannot fetch it. */
export const PAGE_ASSET_ORIGIN = "asset:///public";

/** A-42 (the A2 flip): the Foray `bridge` plays through the page's own `ForayPlayer.playForay`:
 *  three click-track clips, two seams across sources. Its id is the flip's own. */
export const PAGE_FORAY = Object.freeze(buildForay({
  id: "a42-page-foray",
  title: "A-42 page Foray",
  origin: PAGE_ASSET_ORIGIN,
  items: [{ clip: CLIPS[0], endSec: 8 }, { clip: CLIPS[1], endSec: 8 }, { clip: CLIPS[2], endSec: 40 }],
}));

/** A-42 (k): AIRPLANE_ENGINE_FORAY's shape, built by the page: a 6 s clip, a rendered line on a
 *  BUNDLED file, a 6 s clip, a rendered line on the NETWORK (airplane mode cannot load it), a clip
 *  to land on. */
export const PAGE_AIRPLANE_FORAY = Object.freeze(buildForay({
  id: "a42-page-air",
  title: "A-42 page airplane",
  origin: PAGE_ASSET_ORIGIN,
  items: [
    { clip: CLIPS[0], endSec: 6 },
    { line: NARRATION_LINES[0] },
    { clip: CLIPS[1], endSec: 6 },
    { url: UNREACHABLE_NARRATION_URL, script: UNREACHABLE_SCRIPT, sec: 4 },
    { clip: CLIPS[2], endSec: 40 },
  ],
}));

/** The queue the page's build (`buildForayQueue`) makes of `docs`, as the engine's dump names it:
 *  `{forayId, items: [{id}]}`, a clip `<foray>#<index>` and a line its own authored id. */
export function pageForayQueue(docs) {
  const items = docs.forays.forays[0].items.map((it, i) => ({ id: it.type === "narration" ? it.id : `${docs.id}#${i}` }));
  return { forayId: docs.id, items };
}

/** A-28's verdict, as A-31 made it: a STOCK launch is the native lane (the page, the Developer
 *  row on Automatic, and the Copy: `engine=native`, `reason=build-default`, `episode` in its caps,
 *  an `engineMode native` row, the ring read); the page's own episode play is the item the engine
 *  is playing (`played`: the page's answer and the engine's dump after it); and the Developer
 *  setting's Web, stored through the page, puts the relaunched page on the JS player. Since A-42
 *  (`foray`): the stock engine advertises `foray`, and the page's own Foray (`forayPlayed`: the
 *  page's answer, the engine once it sounds, the engine past a seam, the page's lane after) is the
 *  engine's, with no relinquish. */
export function verdictBridge({ stock, copy, played, forayPlayed, override, after, service }) {
  const failures = [];
  if (!stock || stock.error) failures.push(`the stock launch could not be read: ${stock?.error ?? "no answer"}`);
  else {
    if (stock.lane !== "native") failures.push(`a stock Android launch must be the native lane since A-31; its lane is ${stock.lane}`);
    if (stock.status?.lane !== "native" || stock.status?.override !== "auto") {
      failures.push(`the stock launch's engine did not answer native/build-default (Developer row ${JSON.stringify(stock.status)})`);
    }
  }
  if (copy.lane !== "native") failures.push(`the stock Copy header is not engine=native: ${copy.header ?? "(no engine= line)"}`);
  else {
    if (copy.reason !== "build-default") failures.push(`the stock Copy header's reason is ${copy.reason}, not build-default`);
    if (copy.proto !== "1") failures.push(`the Copy header's protocol is ${copy.proto}, not 1`);
    for (const cap of ["episode", "foray"]) {
      if (!String(copy.caps ?? "").split(",").includes(cap)) failures.push(`the stock engine does not advertise ${cap} (caps=${copy.caps})`);
    }
  }
  if (!copy.modeRows.some((r) => r.mode === "native")) failures.push("the Copy paste has no `engineMode native` row");
  if (copy.engineRows == null) failures.push(`the Copy did not read the engine's ring: ${copy.readError ?? "no engine rows line"}`);
  if (!played || !played.page || played.page.ok !== true) failures.push(`the page's ForayPlayer.play did not run: ${JSON.stringify(played?.page ?? null)}`);
  const e = played?.engine;
  if (!e) failures.push("the engine could not be read after the page's play");
  else if (e.item !== PAGE_EPISODE.id) {
    failures.push(`the engine holds ${JSON.stringify(e.item)}, not the page's episode ${PAGE_EPISODE.id}: the tap did not reach the engine`);
  } else if (!(e.running === true && e.exoPlaying === true && Number(e.positionSec) > 0)) {
    failures.push(`the engine holds the page's episode but is not playing it (${e.state}, exoPlaying ${e.exoPlaying}, at ${e.positionSec} s)`);
  }
  engineFailures(service, failures);
  /* A-42: the page's own Foray is the engine's. */
  const fp = forayPlayed;
  if (!fp?.page || fp.page.ok !== true) failures.push(`the page's ForayPlayer.playForay did not run: ${JSON.stringify(fp?.page ?? null)}`);
  else if (fp.page.playable !== PAGE_FORAY.segments.segments.length) {
    failures.push(`the page resolved ${fp.page.playable} playable clips of ${PAGE_FORAY.segments.segments.length} (unplayable: ${JSON.stringify(fp.page.unplayable)})`);
  }
  const f = fp?.engine;
  if (!f) failures.push("the engine could not be read after the page's Foray");
  else if (f.forayId !== PAGE_FORAY.id) {
    failures.push(`the engine holds Foray ${JSON.stringify(f.forayId)}, not the page's ${PAGE_FORAY.id}: the Foray tap did not reach the engine`);
  } else if (!(f.running === true && f.exoPlaying === true && Number(f.positionSec) > 0)) {
    failures.push(`the engine holds the page's Foray but is not playing it (${f.state}, exoPlaying ${f.exoPlaying}, at ${f.positionSec} s)`);
  }
  const c = fp?.crossed;
  if (!(c && c.forayId === PAGE_FORAY.id && Number(c.index) >= 1 && c.running === true && c.exoPlaying === true)) {
    failures.push(`the engine did not cross a seam of the page's Foray (last index ${c?.index ?? null}, forayId ${JSON.stringify(c?.forayId ?? null)})`);
  }
  if (fp && fp.laneAfter !== "native") failures.push(`after the page's Foray the page's lane is ${fp.laneAfter}, not native: the tap relinquished`);
  if (!override || override.ok !== true) failures.push(`the Developer engine setting Web was not stored: ${JSON.stringify(override)}`);
  if (!after || after.error) failures.push(`the relaunched page could not be read: ${after?.error ?? "no answer"}`);
  else {
    if (after.lane !== "js") failures.push(`after the Developer setting Web the page's lane is ${after.lane}, not js`);
    if (after.status?.override !== "web") failures.push(`the Developer row does not read Web after the override: ${JSON.stringify(after.status)}`);
  }
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

/* ─────────────────────────── A-30: the lane, (e), (f), (k) ─────────────────────────── */

/** The Developer setting the lane scenarios store: Automatic, the build's default, which is the
 *  native lane since A-31 (the A1 flip; `mobile/ENGINE_DEFAULT.json` android `native`). */
export const STOCK_MODE = "auto";

/** The scenarios that must run in the native LANE: every dump they read says `nativeLane: true`.
 *  Not `bridge` and `fallback`, which set the lane themselves and read it from the page. */
export const LANE_SCENARIOS = Object.freeze(["first-launch", "play", "background", "transport", "notification", "seams",
  "foray-seams", "doze", "focus", "call", "kill", "airplane"]);

/** A-30's numbers. */
export const NATIVE_GATES = Object.freeze({
  /** (f): how often the hidden queue is looked at, and the slack past its own length. */
  seamsPollMs: 5000,
  seamsSlackMs: 90000,
  /** (k): `ExoDeck.DEFAULT_LOAD_DEADLINE_SEC` (20 s, P-13), plus 5 s for the poll and the
   *  broadcast. A load that fails sooner (Media3's retries give up) is decided sooner. */
  loadDeadlineMs: 20000,
  airplaneDecisionMs: 25000,
  /** (k): how long a bundled episode has to sound after the failure, still in airplane mode. */
  recoveryMs: 20000,
  /** A-40 (f): the Foray tape's bar, "p95 seam <= 1 s with the screen off" (the 0.5 s beat included;
   *  since A-41 the jingle's span is not silence and is taken out). */
  foraySeamP95Ms: 1000,
  /** A-41 (k): how long the engine's Foray has, from its start, to land on its last clip. Its
   *  clips and bundled line are about 17 s; the network line's decision is inside the 25 s gate. */
  airplaneForayLandMs: 60000,
});

/** (f): one episode item, bounded or whole. */
function seamItem(clip, i, startSec, endSec) {
  const it = { id: `a30-seam-${i}`, kind: "episode", title: clip.title, show: SHOW, audio_url: `${ASSET_BASE}${clip.file}`, duration_sec: 90 };
  if (endSec != null) Object.assign(it, { start_sec: startSec, end_sec: endSec });
  return Object.freeze(it);
}

/** (f): six 12 s segments over the three click tracks (two seams inside one source, the rest
 *  across sources, one onto the VBR track with no seek table), then the VBR-Xing track WHOLE,
 *  which ends at its file's end as a real episode does, then a 10 s segment to land on. Seven
 *  seams, about three minutes. */
export const SEAMS_QUEUE = Object.freeze([
  seamItem(CLIPS[0], 0, 0, 12),
  seamItem(CLIPS[1], 1, 0, 12),
  seamItem(CLIPS[1], 2, 30, 42),
  seamItem(CLIPS[2], 3, 0, 12),
  seamItem(CLIPS[0], 4, 20, 32),
  seamItem(CLIPS[0], 5, 50, 62),
  seamItem(CLIPS[1], 6, null, null),
  seamItem(CLIPS[2], 7, 0, 10),
]);

/** A-40 (f): one segment of a Foray, in the shape the page's build (`buildForayQueue`) gives
 *  the engine: an episode slice with its in-point, out-point and source. */
function foraySegment(clip, i, startSec, endSec) {
  return Object.freeze({
    id: `a40-foray#${i}`, kind: "episode", title: clip.title, show: SHOW, audio_url: `${ASSET_BASE}${clip.file}`,
    start_sec: startSec, end_sec: endSec, authored_end_sec: endSec, source_item_id: clip.file, duration_sec: 90,
    dai_suspected: false, needs_drift_check: false,
  });
}

/** A-40 (f): eight 8 s segments over the three click tracks. Six seams cross sources (the deck
 *  pair's handover: the standby deck prerolls the next segment while this one plays), one stays
 *  inside one source (item 3 to 4: no warm, the playing deck seeks in its held source), and one
 *  lands on the VBR track with no seek table. About 70 s. */
export const FORAY_SEAMS_FORAY = Object.freeze({
  forayId: "a40-foray",
  title: "A-40 Foray seams",
  items: Object.freeze([
    foraySegment(CLIPS[0], 0, 0, 8),
    foraySegment(CLIPS[1], 1, 0, 8),
    foraySegment(CLIPS[2], 2, 0, 8),
    foraySegment(CLIPS[0], 3, 20, 28),
    foraySegment(CLIPS[0], 4, 40, 48),
    foraySegment(CLIPS[1], 5, 30, 38),
    foraySegment(CLIPS[2], 6, 20, 28),
    foraySegment(CLIPS[0], 7, 60, 68),
  ]),
});

/** A-41 (k): where the job puts the rendered-narration fixtures in the APK (the JS leg's `a05/`),
 *  as the deck reads an asset. */
export const NARRATION_ASSET_BASE = "asset:///public/a05/";

/** A-41 (k): one rendered line of a Foray, in the shape the page's build gives the engine: a `tts`
 *  item with its file and its script (so a file that fails can be spoken instead). */
function renderedLine(i, url, script, sec) {
  return Object.freeze({
    id: `a41-air#${i}`, kind: "tts", audio_url: url, title: "", script, duration_sec: sec, duration_source: "rendered",
  });
}

/** A-41 (k): the engine's own Foray in airplane mode. A 6 s clip; a rendered line on a BUNDLED file
 *  (heard as a file on the deck); a 6 s clip; a rendered line on the NETWORK, which airplane mode
 *  cannot load (its script falls back to the engine's synthesiser); a clip to land on. */
export const AIRPLANE_ENGINE_FORAY = Object.freeze({
  forayId: "a41-airplane",
  title: "A-41 airplane",
  items: Object.freeze([
    Object.freeze({ ...foraySegment(CLIPS[0], 0, 0, 6), id: "a41-air#0" }),
    renderedLine(1, `${NARRATION_ASSET_BASE}${NARRATION_LINES[0].file}`, NARRATION_LINES[0].script, NARRATION_LINES[0].sec),
    Object.freeze({ ...foraySegment(CLIPS[1], 2, 0, 6), id: "a41-air#2" }),
    renderedLine(3, UNREACHABLE_NARRATION_URL, UNREACHABLE_SCRIPT, 4),
    Object.freeze({ ...foraySegment(CLIPS[2], 4, 0, 40), id: "a41-air#4" }),
  ]),
});

/** (k): an episode on the network, in the shape a real one has, that airplane mode cannot
 *  load. The path names no object, so if airplane mode ever failed to engage the load would
 *  still fail (a 404), and the verdict says which it saw. */
export const UNREACHABLE_EPISODE_URL = "https://audio.jwlabs.ai/e/a30-ci/unreachable.mp3";
export const AIRPLANE_QUEUE = Object.freeze([
  Object.freeze({ id: "a30-air-0", kind: "episode", title: "A-30 unreachable episode", show: SHOW, audio_url: UNREACHABLE_EPISODE_URL, duration_sec: 90 }),
]);

const ROW_RE = /(\d+) (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) (\S+)(?: (.*))?$/;

/** One engine row (`EngineLog.line`: `seq iso kind body`), from the dump or from logcat. */
export function parseEngineRow(text) {
  const m = ROW_RE.exec(String(text ?? "").trim());
  if (!m) return null;
  const body = m[4] ?? "";
  let json = null;
  if (body.startsWith("{")) {
    try {
      json = JSON.parse(body);
    } catch {
      json = null;
    }
  }
  return { seq: Number(m[1]), iso: m[2], at: Date.parse(m[2]), kind: m[3], body, json };
}

/** The engine's rows in `adb logcat -v threadtime -s ForayEngine`, for one pid when given. */
export function engineRowsFromLogcat(text, pid = null) {
  const rows = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^\S+ \S+\s+(\d+)\s+\d+ \w ForayEngine\s*: (.*)$/.exec(line);
    if (!m || (pid && m[1] !== String(pid))) continue;
    const r = parseEngineRow(m[2]);
    if (r) rows.push(r);
  }
  return rows;
}

/** Rows from several reads of one process, once each, in the engine's order. */
export function mergeRows(...lists) {
  const seen = new Map();
  for (const list of lists) for (const r of list ?? []) if (r) seen.set(`${r.seq}|${r.iso}`, r);
  return [...seen.values()].sort((a, b) => a.seq - b.seq || a.at - b.at);
}

const ITEM_ENDS = new Set(["ended", "final-end"]);

/** A listener's (or the page's) hand between two items: a remote press, a command that is not
 *  the page's restore bookkeeping, or a stop that is not an item running out. */
function commanded(r) {
  if (r.kind === "remote") return !!r.json?.cmd;
  if (r.kind === "cmd") return r.json?.source !== "restore";
  if (r.kind === "stop") return !ITEM_ENDS.has(r.json?.cause);
  return false;
}

/**
 * (f): the item seams in the engine's rows. A seam runs from the outgoing load's end (its first
 * `time-control` away from playing after it played, or its `outPoint` stop, whichever came
 * first; the next load's `attach`/`reuse` when neither was written) to the incoming load's first
 * `time-control playing`. `via` is the incoming load's row (`attach` for a new source, `reuse`
 * for the same one, `handover` for a segment the deck pair had prepared on its standby deck,
 * A-40: the pair writes `prepare kind=promote` for the core's token and no attach), `cold` the
 * attach's reason. A seam with a command between is `commanded` (a press, not a seam), and kept
 * apart. Pure.
 */
export function episodeSeams(rows) {
  const seams = [];
  let playing = null;
  let endAt = null;
  let endFrom = null;
  let overshootMs = null;
  let dirty = false;
  let pending = null;
  for (const r of rows ?? []) {
    const j = r.json ?? {};
    if (commanded(r)) {
      dirty = true;
      if (pending) pending.commanded = true;
    }
    if (promoted(r, playing)) {
      pending = {
        token: j.token, fromToken: playing.token, via: "handover", cold: "prepared", attachAt: r.at,
        endAt: endAt ?? r.at, endFrom: endAt != null ? endFrom : "promote", overshootMs, commanded: dirty, readyMs: 0,
      };
      continue;
    }
    if (r.kind === "outPoint" && j.kind === "stop" && playing && j.token === playing.token) {
      overshootMs = typeof j.overshootMs === "number" ? j.overshootMs : null;
      if (endAt == null) {
        endAt = r.at;
        endFrom = "outPoint";
      }
      continue;
    }
    if (r.kind !== "deck") continue;
    if (j.kind === "time-control") {
      if (j.status === "playing") {
        if (pending && j.token === pending.token) {
          seams.push({
            fromToken: pending.fromToken, toToken: pending.token, via: pending.via, cold: pending.cold,
            gapMs: r.at - pending.endAt, loadMs: r.at - pending.attachAt, readyMs: pending.readyMs,
            endFrom: pending.endFrom, overshootMs: pending.overshootMs, commanded: pending.commanded,
            at: r.iso,
          });
          pending = null;
        }
        if (!playing || playing.token !== j.token) {
          playing = { token: j.token };
          endAt = null;
          endFrom = null;
          overshootMs = null;
          dirty = false;
        } else if (endAt != null) {
          /* The same load playing again (a stall that recovered): not an end after all. */
          endAt = null;
          endFrom = null;
        }
      } else if (playing && j.token === playing.token && endAt == null) {
        endAt = r.at;
        endFrom = "time-control";
      }
    } else if ((j.kind === "attach" || j.kind === "reuse") && playing && j.token !== playing.token) {
      pending = {
        token: j.token, fromToken: playing.token, via: j.kind, cold: j.kind === "reuse" ? "same-source" : j.cold ?? null,
        attachAt: r.at, endAt: endAt ?? r.at, endFrom: endAt != null ? endFrom : "attach", overshootMs,
        commanded: dirty, readyMs: null,
      };
    } else if (j.kind === "ready" && pending && j.token === pending.token) {
      pending.readyMs = typeof j.elapsedMs === "number" ? j.elapsedMs : null;
    }
  }
  return seams;
}

/* A-40: the deck pair's promotion is the incoming load's row when the standby deck had the
   segment (a `prepare` row, not a `deck` one, so episodeSeams reads it here). */
function promoted(r, playing) {
  return r.kind === "prepare" && r.json?.kind === "promote" && playing && r.json.token !== playing.token;
}

function nearestRank(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** (f): the numbers, over the seams no command touched: all, and by kind of load. Pure. */
export function episodeSeamStats(seams) {
  const clean = (seams ?? []).filter((s) => !s.commanded && typeof s.gapMs === "number");
  const stat = (list) => {
    const gaps = list.map((s) => s.gapMs).sort((a, b) => a - b);
    return { count: gaps.length, minMs: gaps[0] ?? null, medianMs: nearestRank(gaps, 50), p95Ms: nearestRank(gaps, 95), maxMs: gaps[gaps.length - 1] ?? null };
  };
  const byKind = {};
  for (const s of clean) {
    const k = s.via === "reuse" ? "same-source" : "cross-source";
    (byKind[k] ??= []).push(s);
  }
  return {
    ...stat(clean),
    commanded: (seams ?? []).length - clean.length,
    byKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, stat(v)])),
  };
}

/**
 * A-40 (f): the Foray seams in the engine's rows. A seam runs from the outgoing segment's
 * out-point stop (its `outPoint kind=stop` row) to the next `time-control playing` of another
 * load (the incoming segment, on the deck the pair handed the role to, or the same deck's
 * same-source seek). The engine's own packed `seam` row, written between the two, is kept beside
 * it: the gap the core measured (out-point to the play it commanded) and whether the standby deck
 * had the segment (`prepared`). A seam with a command between is `commanded`. Pure.
 */
export function foraySeams(rows) {
  const seams = [];
  let open = null;
  for (const r of rows ?? []) {
    const j = r.json ?? {};
    if (commanded(r) && open) open.commanded = true;
    if (r.kind === "outPoint" && j.kind === "stop") {
      open = {
        fromToken: j.token, endAt: r.at, overshootMs: typeof j.overshootMs === "number" ? j.overshootMs : null, seamRow: null, commanded: false,
        jingleAt: null, jingleEndAt: null, jingleEnd: null,
      };
      continue;
    }
    /* A-41: the jingle the seam carried, from the core's `interlude kind=started` to its end
       (`ended`, the host's `ceiling`, or a `cut`). Sound, not silence. */
    if (r.kind === "interlude" && open) {
      if (j.kind === "started" && open.jingleAt == null) open.jingleAt = r.at;
      else if ((j.kind === "ended" || j.kind === "cut" || j.kind === "ceiling") && open.jingleAt != null && open.jingleEndAt == null) {
        open.jingleEndAt = r.at;
        open.jingleEnd = j.kind === "ended" ? (j.why ?? "ended") : j.kind;
      }
      continue;
    }
    if (r.kind === "seam" && open && !open.seamRow) {
      open.seamRow = {
        observedGapMs: typeof j.observedGapMs === "number" ? j.observedGapMs : null,
        askedGapMs: typeof j.askedGapMs === "number" ? j.askedGapMs : null,
        prepared: j.prepared === true, stages: Array.isArray(j.stages) ? j.stages : [],
      };
      continue;
    }
    if (r.kind === "deck" && j.kind === "time-control" && j.status === "playing" && open && j.token !== open.fromToken) {
      const gapMs = r.at - open.endAt;
      const jingleMs = open.jingleAt != null ? (open.jingleEndAt ?? r.at) - open.jingleAt : null;
      seams.push({
        fromToken: open.fromToken, toToken: j.token, gapMs, overshootMs: open.overshootMs,
        jingle: open.jingleAt != null, jingleMs, jingleEnd: open.jingleEnd,
        silenceMs: jingleMs != null ? Math.max(0, gapMs - jingleMs) : gapMs,
        observedGapMs: open.seamRow?.observedGapMs ?? null, askedGapMs: open.seamRow?.askedGapMs ?? null,
        prepared: open.seamRow?.prepared ?? null, stages: open.seamRow?.stages ?? [], commanded: open.commanded, at: r.iso,
      });
      open = null;
    }
  }
  return seams;
}

/** A-40 (f): the numbers, over the seams no command touched: all, and prepared (handed over) vs not.
 *  The SILENCE is what is measured (A-41: a seam's jingle is sound, so its span is taken out; a seam
 *  with none is its whole gap); the raw gaps are `gap`. Pure. */
export function foraySeamStats(seams) {
  const clean = (seams ?? []).filter((s) => !s.commanded && typeof s.gapMs === "number");
  const silence = (s) => (typeof s.silenceMs === "number" ? s.silenceMs : s.gapMs);
  const stat = (list, of = silence) => {
    const gaps = list.map(of).sort((a, b) => a - b);
    return { count: gaps.length, minMs: gaps[0] ?? null, medianMs: nearestRank(gaps, 50), p95Ms: nearestRank(gaps, 95), maxMs: gaps[gaps.length - 1] ?? null };
  };
  return {
    ...stat(clean),
    commanded: (seams ?? []).length - clean.length,
    prepared: stat(clean.filter((s) => s.prepared === true)),
    unprepared: stat(clean.filter((s) => s.prepared !== true)),
    gap: stat(clean, (s) => s.gapMs),
    jingles: clean.filter((s) => s.jingle === true).length,
    jingle: stat(clean.filter((s) => s.jingle === true), (s) => s.jingleMs),
  };
}

/** A-40 (f) GATED: every seam crossed, hidden, in one process, and p95 <= 1 s of silence. A-41: the
 *  jingle shipped (the dump's `interlude.available`) and sounded on at least one seam. */
export function verdictForaySeams({ drive, wake, pidBefore, pidAfter, last, seams, pair, foray = FORAY_SEAMS_FORAY }) {
  const failures = [];
  const n = foray.items.length;
  if (!drive?.answer?.ok) failures.push(`the driver's playForay did not play: ${JSON.stringify(drive)}`);
  if (!/^(Asleep|Dozing)$/.test(String(wake ?? ""))) failures.push(`the screen did not go off: mWakefulness=${wake}`);
  if (!pidBefore) failures.push("no app process before the screen went off");
  else if (pidAfter !== pidBefore) failures.push(`the pid changed from ${pidBefore} to ${pidAfter}`);
  if (!last || last.index !== n - 1) failures.push(`the Foray stopped at item ${last?.index}, not the last (${n - 1})`);
  if (last && last.forayId !== foray.forayId) failures.push(`the engine was not playing the Foray (forayId ${JSON.stringify(last?.forayId)})`);
  const stats = foraySeamStats(seams);
  if (stats.count < n - 1) failures.push(`${stats.count} of the Foray's ${n - 1} seams were read from the engine's rows (${stats.commanded} with a command between)`);
  if (stats.count && !(stats.p95Ms <= NATIVE_GATES.foraySeamP95Ms)) {
    failures.push(`p95 seam ${stats.p95Ms} ms is over the ${NATIVE_GATES.foraySeamP95Ms} ms bar (silence: the jingle's span is taken out)`);
  }
  if (!pair || !(pair.swaps > 0)) failures.push(`the deck pair handed over no seam (${JSON.stringify(pair)})`);
  if (last?.interlude?.available !== true) failures.push(`the engine has no jingle player (interlude ${JSON.stringify(last?.interlude ?? null)}): the asset did not ship or is not the pinned one`);
  else if (!(stats.jingles > 0)) failures.push("no seam carried the jingle (no `interlude kind=started` row inside a seam)");
  return { ok: failures.length === 0, failures, recorded: stats };
}

/** (f) RECORDED; gated only on the queue having crossed every seam, hidden, in one process. */
export function verdictSeams({ drive, wake, pidBefore, pidAfter, last, seams, items = SEAMS_QUEUE }) {
  const failures = [];
  if (!drive?.answer?.ok) failures.push(`the driver's load did not play: ${JSON.stringify(drive)}`);
  if (!/^(Asleep|Dozing)$/.test(String(wake ?? ""))) failures.push(`the screen did not go off: mWakefulness=${wake}`);
  if (!pidBefore) failures.push("no app process before the screen went off");
  else if (pidAfter !== pidBefore) failures.push(`the pid changed from ${pidBefore} to ${pidAfter}`);
  if (!last || last.index !== items.length - 1) failures.push(`the queue stopped at item ${last?.index}, not the last (${items.length - 1})`);
  const stats = episodeSeamStats(seams);
  if (stats.count < items.length - 1) {
    failures.push(`${stats.count} of the queue's ${items.length - 1} seams were read from the engine's rows (${stats.commanded} with a command between)`);
  }
  return { ok: failures.length === 0, failures, recorded: stats };
}

/** (k), the engine's half: what the rows after the load say. Pure. */
export function airplaneFacts(rows, sinceSeq) {
  const after = (rows ?? []).filter((r) => r.seq > sinceSeq);
  const attach = after.find((r) => r.kind === "deck" && (r.json?.kind === "attach" || r.json?.kind === "reuse")) ?? null;
  const stop = after.find((r) => r.kind === "stop" && (r.json?.cause === "error" || r.json?.cause === "load-deadline")) ?? null;
  const deck = after.filter((r) => r.kind === "deck" && (r.json?.kind === "failed" || r.json?.kind === "deadline")).map((r) => r.json);
  const sounded = after.some((r) => r.kind === "deck" && r.json?.kind === "time-control" && r.json?.status === "playing"
    && (!attach || r.json?.token === attach.json?.token));
  return {
    attachAt: attach?.iso ?? null,
    stop: stop ? { cause: stop.json.cause, at: stop.iso } : null,
    decisionMs: attach && stop ? stop.at - attach.at : null,
    deck,
    sounded,
  };
}

/** A-41 (k), the engine's Foray: what its rows after the mark say. The fallback is the core's
 *  `narration kind=fallback` row; its boundary is the last out-point stop before it (the clip
 *  before the line ran out, which is when the line became the Foray's focus); the speech is the
 *  synthesiser's `speaker kind=line-started` row after it; a synthesiser that could not speak
 *  writes one of the refusal rows instead (`line-refused` at the line itself since the A-41
 *  review), and the core then steps over the line. Pure. */
export function airplaneForayFacts(rows, sinceSeq) {
  const after = (rows ?? []).filter((r) => r.seq > sinceSeq);
  const fi = after.findIndex((r) => r.kind === "narration" && r.json?.kind === "fallback");
  const fallback = fi >= 0 ? after[fi] : null;
  const boundary = fi >= 0 ? [...after.slice(0, fi)].reverse().find((r) => r.kind === "outPoint" && r.json?.kind === "stop") ?? null : null;
  const later = fi >= 0 ? after.slice(fi + 1) : [];
  const spoke = later.find((r) => r.kind === "speaker" && r.json?.kind === "line-started") ?? null;
  const REFUSALS = ["init-failed", "speak-refused", "start-refused", "engine-error", "line-failed", "line-refused"];
  const refused = later.find((r) => r.kind === "speaker" && REFUSALS.includes(r.json?.kind)) ?? null;
  const from = boundary ?? null;
  return {
    fallback: fallback ? { reason: fallback.json.reason ?? null, at: fallback.json.at ?? null, iso: fallback.iso } : null,
    boundaryAt: boundary?.iso ?? null,
    decisionMs: fallback && from ? fallback.at - from.at : null,
    spoken: spoke ? { iso: spoke.iso, engine: spoke.json.engine ?? null, ms: from ? spoke.at - from.at : null } : null,
    refused: refused ? { kind: refused.json.kind, iso: refused.iso } : null,
    speakerRows: after.filter((r) => r.kind === "speaker").map((r) => r.json),
  };
}

/** A-41 (k) GATED: the engine's Foray in airplane mode. The bundled rendered line is heard as a
 *  file; the network one falls back at its bridge within the deadline, and its script is spoken
 *  (or skipped: a synthesiser that could not speak); the Foray lands on its last clip, playing, in
 *  the engine. */
export function verdictAirplaneForay({ drive, facts, renderedAudible, landed, last, pidBefore, pidAfter, foray = AIRPLANE_ENGINE_FORAY,
  via = "the driver's playForay" }) {
  const failures = [];
  const n = foray.items.length;
  if (!drive?.answer?.ok) failures.push(`${via} did not play: ${JSON.stringify(drive)}`);
  if (!renderedAudible) failures.push(`the bundled rendered line (${foray.items[1].id}) was never the audible item: it did not play as a file`);
  if (!facts?.fallback) failures.push("the network line did not fall back (no `narration kind=fallback` row)");
  else {
    if (facts.fallback.at !== "bridge") failures.push(`the fallback was at ${facts.fallback.at}, not the bridge`);
    if (!(facts.decisionMs <= NATIVE_GATES.airplaneDecisionMs)) {
      failures.push(`the line fell back ${facts.decisionMs} ms after the clip before it ran out; the deadline is ${NATIVE_GATES.airplaneDecisionMs} ms`);
    }
    /* A-41 review: the line must have REACHED the engine's synthesiser (a line it spoke, or a
       refusal row it wrote). Landing on the last clip is not enough: a host with no speaker steps
       over the line and still lands, which is the feature deleted. */
    if (!facts.spoken && !facts.refused) failures.push("the fallen-back line was neither spoken by the engine's synthesiser nor refused by it (no `speaker` row after the fallback)");
  }
  if (!landed) failures.push(`the Foray did not land on its last clip (index ${n - 1}) playing within ${NATIVE_GATES.airplaneForayLandMs} ms (last index ${last?.index}, running ${last?.running})`);
  if (last && last.forayId !== foray.forayId) failures.push(`the engine was not playing the Foray (forayId ${JSON.stringify(last?.forayId)})`);
  if (pidBefore && pidAfter !== pidBefore) failures.push(`the pid changed from ${pidBefore} to ${pidAfter}`);
  return { ok: failures.length === 0, failures, outcome: facts?.spoken ? "spoken" : facts?.refused ? "skipped" : null };
}

/** (k) GATED: the engine's half (an unloadable episode stops in time, nothing claims to play,
 *  a bundled one plays after), the engine's own Foray (A-41), and the page's (A-42: a Foray the
 *  page builds and plays in the native lane is the ENGINE's, passes the same gates, and is never
 *  relinquished). */
export function verdictAirplane({ airplane, facts, after, session, recovered, laneBefore, foray, copy, engineForay }) {
  const failures = [];
  if (airplane !== true) failures.push("airplane mode did not engage (settings global airplane_mode_on is not 1)");
  if (!facts?.attachAt) failures.push("the engine never started loading the unreachable episode");
  else if (!facts.stop) failures.push(`the engine did not stop the unreachable episode (no stop row with cause error or load-deadline within ${NATIVE_GATES.airplaneDecisionMs} ms)`);
  else if (!(facts.decisionMs <= NATIVE_GATES.airplaneDecisionMs)) {
    failures.push(`the engine stopped the unreachable episode ${facts.decisionMs} ms after its load; the deadline is ${NATIVE_GATES.airplaneDecisionMs} ms`);
  }
  if (facts?.sounded) failures.push("the unreachable episode reported playing");
  /* A-30 review: no dump after the failure is not "nothing left playing"; it is unread. */
  if (!after) failures.push("after the failure the service's dump did not answer, so nothing shows the engine stopped");
  else if (after.running !== false || after.exoPlaying === true) failures.push(`after the failure the engine is ${after.state} (running ${after.running}, exoPlaying ${after.exoPlaying})`);
  if (session?.state === "PLAYING") failures.push("after the failure our media session still says PLAYING");
  if (!recovered) failures.push(`a bundled episode did not play within ${NATIVE_GATES.recoveryMs / 1000} s of the failure`);
  /* A-41: the engine's own Foray, its rendered lines a file and a fallback. */
  if (!engineForay) failures.push("the engine's Foray half did not run");
  else if (!engineForay.ok) failures.push(...(engineForay.failures ?? []).map((f) => `engine foray: ${f}`));
  if (laneBefore !== "native") failures.push(`the page's lane before the Foray was ${laneBefore}, not native`);
  if (!foray) failures.push("the page's Foray half did not run");
  else if (!foray.ok) failures.push(...(foray.failures ?? []).map((f) => `page foray: ${f}`));
  if ((copy?.modeRows ?? []).some((r) => r.mode === "js" && r.reason === "relinquished")) {
    failures.push("the Copy has an `engineMode js (relinquished)` row: the page's Foray was handed back to the JS player");
  }
  if (copy?.lane !== "native") failures.push(`the Copy after the page's Foray is not engine=native: ${copy?.header ?? "(no engine= line)"}`);
  return { ok: failures.length === 0, failures };
}

/** (e) GATED: the JS leg's first-launch verdict, in the native lane, with the engine up. */
export function verdictFirstLaunch({ launch, status, service }) {
  const failures = [...(launch?.failures ?? [])];
  if (!launch) failures.push("the first-launch probe did not run");
  if (!status || status.error) failures.push(`the page's lane could not be read: ${status?.error ?? "no answer"}`);
  else {
    if (status.lane !== "native") failures.push(`the page's lane is ${status.lane}, not native`);
    /* A-31: the stock lane, not an override: the Developer row reads Automatic. */
    if (status.status?.override !== STOCK_MODE) {
      failures.push(`the first launch is not a stock launch: the Developer row reads ${JSON.stringify(status.status?.override)}, not "auto"`);
    }
  }
  engineFailures(service, failures);
  return { ok: failures.length === 0, failures };
}

/** A-30: every dump a native-lane scenario read said the process's lane is native. Pure. */
export function laneFailures(scenario, seen) {
  if (!LANE_SCENARIOS.includes(scenario)) return [];
  const reads = seen ?? [];
  if (!reads.length) return ["no dump said which lane the process was in (the service never answered with `nativeLane`)"];
  const js = reads.filter((v) => v !== true).length;
  return js ? [`${js} of ${reads.length} engine dumps said the process is not in the native lane`] : [];
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

/** (j) GATED in native mode (A-27), in the native LANE (A-27 review: the Developer setting is
 *  Native for the scenario, `setup`): a paused 4a, on Home, ended four ways (`KILL_LEGS`),
 *  then `cmd media_session dispatch play`. `am kill` (the card's), a swipe then `am kill`, and a
 *  SIGKILL from the app's own uid must each resume 4a at the saved position. `am force-stop`
 *  is the negative control: RECORDED, never gated (A-67). */
export function verdictKill({ legs, setup }) {
  const failures = [];
  /* A-27 review: the scenario runs in the native lane (the Developer setting, stored first). */
  for (const [i, s] of (setup ?? []).entries()) {
    if (!s?.answer || s.answer.ok !== true) failures.push(`setup step ${i + 1} (the Developer setting, Native) was not taken: ${JSON.stringify(s)}`);
  }
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
  ["first-launch", "(e) native: a first launch in the native lane, as a screenshot, with the engine up"],
  ["play", "(a) native: a clip plays in a mediaPlayback service, published"],
  ["background", "(b) native: Home, then screen off, 60 s"],
  ["transport", "(c) native: media_session dispatch + KEYCODE_MEDIA_*"],
  ["notification", "(d) native: system controls: title, show, 15/30, tap pause"],
  ["seams", "(f) native: hidden episode seams, screen off (recorded; gated on crossing every seam)"],
  ["foray-seams", "(f) native Foray (A-40): hidden Foray seams on the deck pair, screen off, p95 <= 1 s"],
  ["doze", "(g) native: Doze, unplugged, rare bucket, 5 min"],
  ["focus", "(h) native: another app takes audio focus; pause, and resume after a transient loss"],
  ["call", "(i) native: a phone call; pause, and resume after it"],
  ["kill", "(j) native: paused, on Home, the process ended; a media play resumes 4a at the saved position"],
  ["airplane", "(k) native: airplane mode; an unloadable episode stops in time; the engine's Foray, handed over and then built by the page (A-42), plays a rendered line as a file and speaks the one that cannot load"],
  ["bridge", "(A-28, A-31, A-42) stock launch: the native lane by default; the page's own episode and Foray plays are the engine's; the Developer setting Web returns the JS lane"],
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

/** A-30: the native LANE for a scenario that drives the engine. Since A-31 that is the STOCK lane:
 *  the Developer setting Automatic is stored through the owner (the driver's `override`, which
 *  also clears the strikes and the pin), and a process that is not already in the native lane is
 *  stopped, so the next launch decides it from the build's default. `fresh` stops the app
 *  whatever it was: (e)'s first launch. Once per scenario. */
async function ensureNativeLane(ctx, { fresh = false } = {}) {
  if (ctx.laneReady && !fresh) return;
  ctx.laneReady = true;
  const now = pidOf(ctx.pkg) ? engine(ctx, { track: false }) : null;
  ctx.laneSetup = drive(ctx, "override", ["--es", "mode", STOCK_MODE]);
  if (fresh || now?.nativeLane !== true) {
    shell("am", "force-stop", ctx.pkg);
    await sleep(1500);
  }
}

/** The app on screen (a foreground app may start the foreground service), awake and unlocked;
 *  in the native lane for a scenario that must run there (A-30). */
async function prepare(ctx) {
  if (LANE_SCENARIOS.includes(ctx.scenario)) await ensureNativeLane(ctx);
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

/** The engine's state now, read from the service's dump, stamped with this runner's clock.
 *  Every read notes the process's lane (A-30: `laneFailures` judges them). */
function engine(ctx, { track = true } = {}) {
  const out = shell("dumpsys", "activity", "service", SERVICE_COMPONENT.replace(PKG, ctx.pkg));
  const { state, rows } = engineDump(out);
  ctx.lastRows = rows;
  if (track && state && typeof state.nativeLane === "boolean") (ctx.laneSeen ??= []).push(state.nativeLane);
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

/** (j). IN THE NATIVE LANE (A-27 review): the Developer engine setting is Automatic for the
 *  scenario, which since A-31 is the native lane (Native before it), and the app starts from
 *  stopped, so the page decides the native lane, as a stock launch does. The cold path is the
 *  native lane's alone: a car's PLAY into a process whose lane is the page's player (the
 *  Developer setting's Web) is dropped by the receiver, whatever record the native engine left. */
async function kill(ctx) {
  const legs = [];
  const setup = [];
  try {
    setup.push(drive(ctx, "override", ["--es", "mode", STOCK_MODE]));
    shell("am", "force-stop", ctx.pkg);
    await sleep(1500);
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
       scenario (A-28's page door) starts from a stopped app, as a launch does, in the stock
       lane: the setting stays Automatic (which also clears the strikes and the pin). */
    drive(ctx, "override", ["--es", "mode", "auto"]);
    shell("am", "force-stop", ctx.pkg);
  }
  const v = verdictKill({ legs, setup });
  return { ...v, measured: { setup, legs }, evidence: fs.readdirSync(ctx.art).filter((f) => f.startsWith("j-")) };
}

/** A-28: the page's door, and since A-31 the flip's own proof. See the header. */
async function bridge(ctx) {
  ctx.endpoint = ctx.endpoint ?? DEVTOOLS_ENDPOINT;
  /* The stock launch this reads first is Automatic, from a stopped app, whatever ran before. */
  const stockSetup = drive(ctx, "override", ["--es", "mode", "auto"]);
  shell("am", "force-stop", ctx.pkg);
  await sleep(1500);
  await prepare(ctx);
  ctx.target = (await connectPage(ctx, { timeoutMs: 90000 })).target;
  const stock = await evalPage(ctx, ENGINE_STATUS_EXPRESSION, { timeoutMs: 45000 });
  save(ctx, "bridge-stock.json", JSON.stringify(stock, null, 2));
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

  /* A-31: the page's own episode play, in the stock lane, is the engine's. */
  let page;
  try {
    page = await evalPage(ctx, pagePlayExpression(PAGE_EPISODE), { gesture: true, timeoutMs: 45000 });
  } catch (e) {
    page = { ok: false, error: String(e?.message ?? e) };
  }
  const playing = await waitFor(ctx, (st) => !!st && st.item === PAGE_EPISODE.id && isPlaying(st), 20000);
  const played = { page, engine: playing };
  save(ctx, "bridge-engine-dump.txt", shell("dumpsys", "activity", "service", SERVICE_COMPONENT.replace(PKG, ctx.pkg)));
  const service = engine(ctx);

  /* A-42: the page's own Foray, in the stock lane, is the engine's, across a seam, unrelinquished. */
  let forayPage;
  try {
    forayPage = await evalPage(ctx, startForayExpression(PAGE_FORAY, PAGE_FORAY.id), { gesture: true, timeoutMs: 45000 });
  } catch (e) {
    forayPage = { ok: false, error: String(e?.message ?? e) };
  }
  const onPageForay = (st) => !!st && st.forayId === PAGE_FORAY.id && isPlaying(st);
  const forayEngine = await waitFor(ctx, onPageForay, 20000);
  const crossed = await waitFor(ctx, (st) => onPageForay(st) && Number(st.index) >= 1, 30000);
  save(ctx, "bridge-foray-engine-dump.txt", shell("dumpsys", "activity", "service", SERVICE_COMPONENT.replace(PKG, ctx.pkg)));
  let laneAfter;
  try {
    laneAfter = (await evalPage(ctx, ENGINE_STATUS_EXPRESSION, { timeoutMs: 30000 }))?.lane ?? null;
  } catch (e) {
    laneAfter = `(unread: ${String(e?.message ?? e)})`;
  }
  const forayPlayed = { page: forayPage, engine: forayEngine, crossed, laneAfter };
  drive(ctx, "pause");

  /* The way back: the Developer setting Web, through the page, applies at the next launch. */
  let override;
  try {
    override = await evalPage(ctx, overrideExpression("web"), { timeoutMs: 30000 });
  } catch (e) {
    override = { error: String(e?.message ?? e) };
  }
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
  save(ctx, "bridge-after-web.json", JSON.stringify(after, null, 2));
  const v = verdictBridge({ stock, copy, played, forayPlayed, override, after, service });
  if (!stockSetup?.answer?.ok) v.failures.unshift(`the Developer setting could not be put to Automatic first: ${JSON.stringify(stockSetup)}`);
  v.ok = v.failures.length === 0;

  // Leave the device as the other scenarios expect it: Automatic (best effort; the next launch).
  let reset = null;
  try {
    reset = await evalPage(ctx, overrideExpression("auto"), { timeoutMs: 20000 });
  } catch (e) {
    reset = { error: String(e?.message ?? e) };
  }
  return {
    ...v,
    measured: { stock, copy, played, forayPlayed, service, override, after, reset },
    evidence: ["bridge-stock.json", "bridge-diagnostics-copy.txt", "bridge-engine-dump.txt", "bridge-foray-engine-dump.txt", "bridge-after-web.json"],
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

/* ─────────────────────────── A-30: (e), (f), (k) ─────────────────────────── */

/** The engine's rows in logcat for one process, merged with its dump's tail (the ring's last
 *  rows, in case logcat rotated), from `sinceIso` on. */
function processRows(ctx, pid, sinceIso = null) {
  const log = adb(["logcat", "-d", "-v", "threadtime", "-s", "ForayEngine"]).stdout;
  const dump = engineDump(shell("dumpsys", "activity", "service", SERVICE_COMPONENT.replace(PKG, ctx.pkg))).rows.map(parseEngineRow);
  const since = sinceIso ? Date.parse(sinceIso) : -Infinity;
  return mergeRows(engineRowsFromLogcat(log, pid), dump).filter((r) => r.at >= since);
}

/** The dump's rows now, parsed. */
function dumpRows(ctx) {
  return engineDump(shell("dumpsys", "activity", "service", SERVICE_COMPONENT.replace(PKG, ctx.pkg))).rows.map(parseEngineRow).filter(Boolean);
}

/** The device's wall clock, as the engine stamps its rows (whole seconds, floored). */
function deviceIso() {
  return shell("date", "-u", "+%Y-%m-%dT%H:%M:%S.000Z").trim();
}

/** (e) A first launch in the native lane: the JS leg's own (e) through the page, then the lane
 *  and the engine. */
async function firstLaunch(ctx) {
  ctx.endpoint = ctx.endpoint ?? DEVTOOLS_ENDPOINT;
  await ensureNativeLane(ctx, { fresh: true });
  await prepare(ctx);
  ctx.target = null;
  const launch = await firstLaunchScenario(ctx);
  let status;
  try {
    status = await evalPage(ctx, ENGINE_STATUS_EXPRESSION, { timeoutMs: 45000 });
  } catch (e) {
    status = { error: String(e?.message ?? e) };
  }
  /* In the native lane the owner binds the service at launch: it is hosting by the time the
     page has answered, and the dump says so. */
  let service = engine(ctx);
  for (let i = 0; i < 10 && service?.hosting !== true; i += 1) {
    await sleep(1000);
    service = engine(ctx);
  }
  save(ctx, "e-engine-dump.txt", shell("dumpsys", "activity", "service", SERVICE_COMPONENT.replace(PKG, ctx.pkg)));
  const v = verdictFirstLaunch({ launch, status, service });
  return {
    ...v,
    measured: { ...launch?.measured, status, engine: service && { hosting: service.hosting, nativeLane: service.nativeLane, state: service.state } },
    evidence: [...(launch?.evidence ?? []), "e-engine-dump.txt"],
  };
}

/** (f) Hidden episode seams, RECORDED. See the header. */
async function seams(ctx) {
  await prepare(ctx);
  const since = deviceIso();
  const d = loadQueue(ctx, SEAMS_QUEUE, 0);
  const started = await waitFor(ctx, isPlaying, 20000);
  const pidBefore = pidOf(ctx.pkg);
  shell("input", "keyevent", "KEYCODE_HOME");
  await sleep(1500);
  shell("input", "keyevent", "KEYCODE_SLEEP");
  await sleep(2000);
  const wake = wakefulness(dumpTo(ctx, "f-dumpsys-power.txt", "dumpsys", "power"));
  const lengthMs = SEAMS_QUEUE.reduce((sum, it) => sum + ((it.end_sec ?? it.duration_sec) - (it.start_sec ?? 0)) * 1000, 0);
  const deadline = Date.now() + lengthMs + NATIVE_GATES.seamsSlackMs;
  const curve = [];
  let last = engine(ctx);
  let reachedLast = false;
  while (Date.now() < deadline) {
    await sleep(NATIVE_GATES.seamsPollMs);
    const s = engine(ctx);
    if (s) last = s;
    curve.push({ at: s?.at, index: s?.index, positionSec: s?.positionSec, running: s?.running, state: s?.state });
    if (s?.index === SEAMS_QUEUE.length - 1) reachedLast = true;
    /* Done once the last item has played and stopped: the queue ran out. */
    if (reachedLast && s && s.running === false) break;
  }
  const pidAfter = pidOf(ctx.pkg);
  const rows = processRows(ctx, pidAfter ?? pidBefore, since);
  save(ctx, "f-engine-rows.txt", rows.map((r) => `${r.seq} ${r.iso} ${r.kind} ${r.body}`).join("\n") + "\n");
  const found = episodeSeams(rows);
  wakeAndUnlock();
  const v = verdictSeams({ drive: d, wake, pidBefore, pidAfter, last, seams: found });
  return {
    ...v,
    measured: { started: !!started, since, wake, pidBefore, pidAfter, seams: found, curve, rows: rows.length },
    evidence: ["f-dumpsys-power.txt", "f-engine-rows.txt"],
  };
}

/** A-40 (f): a Foray handed to the engine, played hidden on the deck pair. See the header. */
async function foraySeamsScenario(ctx) {
  await prepare(ctx);
  const since = deviceIso();
  const d = drive(ctx, "foray", ["--es", "foray", queueArg(FORAY_SEAMS_FORAY)]);
  const started = await waitFor(ctx, isPlaying, 20000);
  const pidBefore = pidOf(ctx.pkg);
  shell("input", "keyevent", "KEYCODE_HOME");
  await sleep(1500);
  shell("input", "keyevent", "KEYCODE_SLEEP");
  await sleep(2000);
  const wake = wakefulness(dumpTo(ctx, "f-foray-dumpsys-power.txt", "dumpsys", "power"));
  const items = FORAY_SEAMS_FORAY.items;
  const lengthMs = items.reduce((sum, it) => sum + (it.end_sec - it.start_sec) * 1000, 0);
  const deadline = Date.now() + lengthMs + NATIVE_GATES.seamsSlackMs;
  const curve = [];
  let last = engine(ctx);
  let reachedLast = false;
  while (Date.now() < deadline) {
    await sleep(NATIVE_GATES.seamsPollMs);
    const s = engine(ctx);
    if (s) last = s;
    curve.push({ at: s?.at, index: s?.index, positionSec: s?.positionSec, running: s?.running, state: s?.state, inSeamGap: s?.inSeamGap, pair: s?.pair });
    if (s?.index === items.length - 1) reachedLast = true;
    /* Done once the last segment has played and stopped: the Foray's final end. */
    if (reachedLast && s && s.running === false) break;
  }
  const pidAfter = pidOf(ctx.pkg);
  const rows = processRows(ctx, pidAfter ?? pidBefore, since);
  save(ctx, "f-foray-engine-rows.txt", rows.map((r) => `${r.seq} ${r.iso} ${r.kind} ${r.body}`).join("\n") + "\n");
  const found = foraySeams(rows);
  wakeAndUnlock();
  const v = verdictForaySeams({ drive: d, wake, pidBefore, pidAfter, last, seams: found, pair: last?.pair });
  return {
    ...v,
    measured: { started: !!started, since, wake, pidBefore, pidAfter, seams: found, pair: last?.pair ?? null, curve, rows: rows.length },
    evidence: ["f-foray-dumpsys-power.txt", "f-foray-engine-rows.txt"],
  };
}

/** A-41 (k): the engine's own Foray in airplane mode (the caller turned it on). See the header. */
async function airplaneEngineForay(ctx) {
  return watchAirplaneForay(ctx, AIRPLANE_ENGINE_FORAY, async () => drive(ctx, "foray", ["--es", "foray", queueArg(AIRPLANE_ENGINE_FORAY)]),
    { rowsFile: "k-foray-engine-rows.txt", via: "the driver's playForay" });
}

/** A-42 (k): the same Foray, built and played by the PAGE (its own `ForayPlayer.playForay`), which
 *  the engine plays since the A2 flip. */
async function airplanePageForay(ctx) {
  const foray = pageForayQueue(PAGE_AIRPLANE_FORAY);
  return watchAirplaneForay(ctx, foray, async () => {
    let page;
    try {
      page = await evalPage(ctx, startForayExpression(PAGE_AIRPLANE_FORAY, PAGE_AIRPLANE_FORAY.id), { gesture: true, timeoutMs: 45000 });
    } catch (e) {
      page = { ok: false, error: String(e?.message ?? e) };
    }
    return { answer: { ok: page?.ok === true }, page };
  }, { rowsFile: "k-page-foray-engine-rows.txt", via: "the page's ForayPlayer.playForay" });
}

/** A Foray in airplane mode, started by `start`, watched until it lands on its last clip: the
 *  engine's rows after the mark, and the verdict. */
async function watchAirplaneForay(ctx, foray, start, { rowsFile, via }) {
  const before = dumpRows(ctx);
  const since = before.length ? before[before.length - 1].seq : 0;
  const d = await start();
  const pidBefore = pidOf(ctx.pkg);
  const items = foray.items;
  const lastIndex = items.length - 1;
  const until = Date.now() + NATIVE_GATES.airplaneForayLandMs;
  const trail = [];
  let renderedAudible = false;
  let landed = false;
  let last = null;
  while (Date.now() < until) {
    await sleep(500);
    const s = engine(ctx);
    if (!s) continue;
    last = s;
    trail.push({ at: s.at, index: s.index, item: s.item, audible: s.audible, running: s.running, exoPlaying: s.exoPlaying, inSeamGap: s.inSeamGap });
    if (s.item === items[1].id && s.audible === true) renderedAudible = true;
    if (s.index === lastIndex && isPlaying(s)) {
      landed = true;
      break;
    }
  }
  const pidAfter = pidOf(ctx.pkg);
  const rows = dumpRows(ctx);
  save(ctx, rowsFile, rows.filter((r) => r.seq > since).map((r) => `${r.seq} ${r.iso} ${r.kind} ${r.body}`).join("\n") + "\n");
  const facts = airplaneForayFacts(rows, since);
  drive(ctx, "pause");
  const v = verdictAirplaneForay({ drive: d, facts, renderedAudible, landed, last, pidBefore, pidAfter, foray, via });
  return { ...v, measured: { drive: d, facts, renderedAudible, landed, speaker: last?.speaker ?? null, trail } };
}

/** (k) Airplane mode: the engine's half, the engine's Foray (A-41), then the page's. See the header. */
async function airplane(ctx) {
  ctx.endpoint = ctx.endpoint ?? DEVTOOLS_ENDPOINT;
  const set = {};
  let facts = null;
  let after = null;
  let session = null;
  let recovered = null;
  let flag = null;
  let engineForay = null;
  try {
    set.enable = shell("cmd", "connectivity", "airplane-mode", "enable").trim();
    await sleep(2000);
    flag = shell("settings", "get", "global", "airplane_mode_on").trim();
    await prepare(ctx);
    const before = dumpRows(ctx);
    const since = before.length ? before[before.length - 1].seq : 0;
    set.load = loadQueue(ctx, AIRPLANE_QUEUE, 0);
    const until = Date.now() + NATIVE_GATES.airplaneDecisionMs + 5000;
    let rows = [];
    while (Date.now() < until) {
      await sleep(500);
      rows = dumpRows(ctx);
      facts = airplaneFacts(rows, since);
      if (facts.stop) break;
    }
    await sleep(1500);
    after = engine(ctx);
    session = ourSession(mediaSessions(dumpTo(ctx, "k-dumpsys-media_session.txt", "dumpsys", "media_session")), ctx.pkg);
    save(ctx, "k-engine-rows.txt", rows.filter((r) => r.seq > since).map((r) => `${r.seq} ${r.iso} ${r.kind} ${r.body}`).join("\n") + "\n");
    /* Still in airplane mode: a bundled episode plays, so the failure left nothing wedged. */
    set.recover = loadQueue(ctx, LONG_QUEUE, 0);
    const r = await waitFor(ctx, isPlaying, NATIVE_GATES.recoveryMs);
    recovered = isPlaying(r) ? { item: r.item, positionSec: r.positionSec } : null;
    set.pause = drive(ctx, "pause");
    /* A-41: the engine's own Foray, still in airplane mode. */
    engineForay = await airplaneEngineForay(ctx);
  } finally {
    set.disable = shell("cmd", "connectivity", "airplane-mode", "disable").trim();
  }

  /* The page's half (A-42), in a fresh native-lane process: the page builds the same Foray and
     plays it with its own ForayPlayer.playForay, which the engine plays since the A2 flip. */
  shell("am", "force-stop", ctx.pkg);
  await sleep(1500);
  ctx.target = null;
  await prepare(ctx);
  ctx.target = (await connectPage(ctx, { timeoutMs: 90000 })).target;
  let lane;
  try {
    lane = await evalPage(ctx, ENGINE_STATUS_EXPRESSION, { timeoutMs: 45000 });
  } catch (e) {
    lane = { error: String(e?.message ?? e) };
  }
  let foray;
  try {
    set.pageEnable = shell("cmd", "connectivity", "airplane-mode", "enable").trim();
    await sleep(2000);
    set.pageAirplaneModeOn = shell("settings", "get", "global", "airplane_mode_on").trim();
    foray = await airplanePageForay(ctx);
    if (set.pageAirplaneModeOn !== "1") foray = { ...foray, ok: false, failures: [...(foray.failures ?? []), "airplane mode did not engage for the page's Foray"] };
  } catch (e) {
    foray = { ok: false, failures: [`the page's Foray could not run: ${String(e?.message ?? e)}`] };
  } finally {
    set.pageDisable = shell("cmd", "connectivity", "airplane-mode", "disable").trim();
  }
  let text;
  try {
    text = String(await evalPage(ctx, DIAGNOSTICS_EXPRESSION, { timeoutMs: 30000 }));
  } catch (e) {
    text = `(the page could not be asked: ${String(e?.message ?? e)})`;
  }
  save(ctx, "k-diagnostics-copy.txt", text);
  const copy = copyFacts(text);
  const v = verdictAirplane({
    airplane: flag === "1", facts, after, session, recovered, laneBefore: lane?.lane ?? lane?.error ?? null, foray, copy, engineForay,
  });
  return {
    ...v,
    measured: {
      set, airplaneModeOn: flag,
      engine: { facts, after: after && { state: after.state, running: after.running, exoPlaying: after.exoPlaying }, session, recovered },
      engineForay: engineForay && { ok: engineForay.ok, failures: engineForay.failures, outcome: engineForay.outcome, measured: engineForay.measured },
      page: { lane, foray: foray && { ok: foray.ok, failures: foray.failures, outcome: foray.outcome, measured: foray.measured }, modeRows: copy.modeRows, copyLane: copy.lane },
    },
    evidence: ["k-dumpsys-media_session.txt", "k-engine-rows.txt", "k-foray-engine-rows.txt", "k-page-foray-engine-rows.txt", "k-diagnostics-copy.txt"],
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

const RUNNERS = {
  "first-launch": firstLaunch, play, background, transport, notification, seams, "foray-seams": foraySeamsScenario, doze, focus, call, kill, airplane,
  bridge, fallback, collect,
};

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
    /* A-30: a scenario that must run in the native lane fails when any dump it read said
       otherwise, or none said at all. */
    const lane = laneFailures(args.scenario, ctx.laneSeen);
    if (lane.length) result = { ...result, ok: false, failures: [...(result.failures ?? []), ...lane] };
    if (LANE_SCENARIOS.includes(args.scenario)) {
      const seen = ctx.laneSeen ?? [];
      result = { ...result, lane: { reads: seen.length, native: seen.filter((v) => v === true).length, setup: ctx.laneSetup ?? null } };
    }
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
