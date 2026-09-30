/* `tools/mobile/android-native-playback.mjs` (A-26): the half of the native-mode
 * scenarios that decides PASS or FAIL. The scenarios themselves need the emulator
 * (`.github/workflows/android-playback.yml`'s native leg); what this file holds is
 * the queue the driver is handed, the two parsers (the service's dump, the
 * broadcast's answer) and the verdicts, each against the shape the platform and
 * the Java print. EVERY TEST NAMES THE MUTATION THAT BREAKS IT.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLIPS, GATES, PKG, SHOW } from "./android-playback.mjs";
import {
  ASSET_BASE,
  DEVTOOLS_ENDPOINT,
  DOZE_QUEUE,
  ENGINE_STATUS_EXPRESSION,
  AIRPLANE_QUEUE,
  FORAY_SEAMS_FORAY,
  LANE_SCENARIOS,
  NATIVE_GATES,
  SEAMS_QUEUE,
  UNREACHABLE_EPISODE_URL,
  airplaneFacts,
  engineRowsFromLogcat,
  episodeSeamStats,
  episodeSeams,
  foraySeamStats,
  foraySeams,
  laneFailures,
  mergeRows,
  parseEngineRow,
  verdictAirplane,
  verdictFirstLaunch,
  verdictSeams,
  verdictForaySeams,
  LEGACY_START_EXPRESSION,
  copyFacts,
  ownerFacts,
  verdictFallback,
  overrideExpression,
  verdictBridge,
  PAGE_EPISODE,
  STOCK_MODE,
  pagePlayExpression,
  DUMP_PREFIX,
  EPISODE_QUEUE,
  KILL,
  KILL_LEGS,
  KILL_QUEUE,
  killQueue,
  LONG_QUEUE,
  RECEIVER_COMPONENT,
  SCENARIOS,
  SERVICE,
  SERVICE_COMPONENT,
  broadcastResult,
  engineDump,
  focusPhase,
  listenedSec,
  moved,
  ourSession,
  parseArgs,
  queueArg,
  summaryMarkdown,
  verdictBackground,
  verdictCall,
  verdictDoze,
  verdictFocus,
  verdictKill,
  verdictNotification,
  verdictPlay,
  verdictPress,
} from "./android-native-playback.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN = path.join(ROOT, "mobile", "plugins", "foray-audio", "android");
const read = (rel) => fs.readFileSync(path.join(PLUGIN, rel), "utf8");

/* A dump as ForayPlaybackService.dump prints it, inside `dumpsys activity service`'s wrapper. */
function dumpText(state, rows = []) {
  return [
    `SERVICE ${SERVICE_COMPONENT} 1a2b3c pid=4242 user=0`,
    "  Client:",
    `    ${DUMP_PREFIX}${JSON.stringify(state)}`,
    ...rows.map((r) => `    ForayEngine.row ${r}`),
  ].join("\n");
}

const S = (o) => ({ hosting: true, legacyRunning: false, running: true, exoPlaying: true, state: "playing", item: "a26-0", index: 0,
  title: CLIPS[0].title, artist: SHOW, ...o });

test("A-26: the names the runner uses are the names the Java declares", () => {
  /* MUTATION: rename the service, the receiver or the dump prefix in the Java only. */
  const service = read("src/main/java/ai/jwlabs/foura/audio/ForayPlaybackService.java");
  assert.match(service, /public class ForayPlaybackService extends MediaSessionService/);
  assert.match(service, new RegExp(`DUMP_PREFIX = "${DUMP_PREFIX}"`));
  assert.equal(SERVICE_COMPONENT, `${PKG}/ai.jwlabs.foura.audio.ForayPlaybackService`);
  assert.ok(SERVICE_COMPONENT.endsWith(SERVICE));
  const receiver = read("src/debug/java/ai/jwlabs/foura/audio/EngineDriveReceiver.java");
  assert.match(receiver, /public final class EngineDriveReceiver extends BroadcastReceiver/);
  assert.equal(RECEIVER_COMPONENT, `${PKG}/ai.jwlabs.foura.audio.EngineDriveReceiver`);
  for (const cmd of ["load", "play", "pause", "next", "previous"]) assert.match(receiver, new RegExp(`case "${cmd}"`));
  assert.match(read("src/debug/AndroidManifest.xml"), /android:name="ai\.jwlabs\.foura\.audio\.EngineDriveReceiver"/);
});

test("A-26: the queues are the click tracks the APK carries, as the deck reads an asset", () => {
  /* MUTATION: an https URL (the deck would reach for the network), or a clip past its 90 s file. */
  for (const q of [LONG_QUEUE, DOZE_QUEUE, EPISODE_QUEUE]) {
    for (const it of q) {
      assert.ok(it.audio_url.startsWith(ASSET_BASE), it.audio_url);
      assert.ok(CLIPS.some((c) => it.audio_url.endsWith(c.file)), it.audio_url);
      assert.equal(it.kind, "episode");
      assert.ok(it.end_sec <= it.duration_sec);
      assert.ok(it.id && it.title && it.show === SHOW);
    }
    assert.equal(new Set(q.map((i) => i.id)).size, q.length, "ids are unique");
  }
  assert.equal(LONG_QUEUE.length, 3);
  assert.ok(DOZE_QUEUE.reduce((s, i) => s + i.end_sec - i.start_sec, 0) > GATES.dozeWaitMs / 1000, "Doze never reaches the end");
  assert.equal(EPISODE_QUEUE.length, 1, "(d) is the single episode");
  assert.deepEqual(JSON.parse(Buffer.from(queueArg(LONG_QUEUE), "base64").toString("utf8")), LONG_QUEUE);
  assert.match(queueArg(DOZE_QUEUE), /^[A-Za-z0-9+/=]+$/, "no character a shell would split or expand");
});

test("A-26: listenedSec counts the finished items' spans and this one's playhead", () => {
  /* MUTATION: count positionSec alone (a seam would read as going backwards). */
  assert.equal(listenedSec({ index: 0, positionSec: 10 }, LONG_QUEUE), 10);
  assert.equal(listenedSec({ index: 2, positionSec: 5 }, LONG_QUEUE), 175);
  assert.equal(listenedSec({ index: -1, positionSec: 5 }, LONG_QUEUE), null);
  assert.equal(listenedSec(null, LONG_QUEUE), null);
});

test("A-26: the dump parser reads the state line and the rows, and survives a bad line", () => {
  /* MUTATION: match the prefix anywhere (ForayEngine.row would be read as state). */
  const { state, rows } = engineDump(dumpText(S({ positionSec: 12.5 }), ["1 2026-09-29T00:00:00.000Z remote {}", "2 x grace {}"]));
  assert.equal(state.positionSec, 12.5);
  assert.equal(rows.length, 2);
  assert.equal(engineDump(`    ${DUMP_PREFIX}{not json`).state.error, "unparseable");
  assert.equal(engineDump("Service not found").state, null);
});

test("A-26: the broadcast answer is read whether am escapes the data or not", () => {
  /* MUTATION: a non-greedy capture stops at the first inner quote. */
  const plain = broadcastResult('Broadcasting: Intent { cmp=x }\nBroadcast completed: result=1, data="{"ok":true,"failures":[]}"');
  assert.deepEqual(plain, { delivered: true, result: 1, answer: { ok: true, failures: [] } });
  const escaped = broadcastResult('Broadcast completed: result=1, data="{\\"ok\\":false,\\"failures\\":[\\"no-service\\"]}"');
  assert.deepEqual(escaped.answer, { ok: false, failures: ["no-service"] });
  assert.deepEqual(broadcastResult("Broadcast completed: result=0"), { delivered: true, result: 0, answer: null });
  assert.equal(broadcastResult("Error: Bad component name").delivered, false);
});

test("A-26 (a): play passes on a moving playhead in a mediaPlayback service with our words published", () => {
  /* MUTATION: drop any one of the checks; each failing input below turns red for its own reason. */
  const service = { found: true, isForeground: true, mediaPlayback: true, types: 2 };
  const sessions = { sessions: [{ package: PKG, state: "PLAYING", description: `${CLIPS[0].title}, ${SHOW}, null` }] };
  const good = { drive: { answer: { ok: true } }, first: S({ positionSec: 1 }), last: S({ positionSec: 6 }), service, sessions };
  assert.equal(verdictPlay(good).ok, true, JSON.stringify(verdictPlay(good).failures));
  assert.equal(verdictPlay({ ...good, last: S({ positionSec: 2 }) }).ok, false, "a frozen playhead");
  assert.equal(verdictPlay({ ...good, last: S({ positionSec: 6, legacyRunning: true }) }).ok, false, "the legacy service beside it");
  assert.equal(verdictPlay({ ...good, service: { ...service, isForeground: false } }).ok, false);
  assert.equal(verdictPlay({ ...good, sessions: { sessions: [{ package: PKG, state: "PAUSED" }] } }).ok, false);
  assert.equal(verdictPlay({ ...good, drive: { answer: { ok: false } } }).ok, false);
  assert.equal(verdictPlay({ ...good, last: null }).ok, false, "no dump");
});

test("A-26 (b), (g): the background gates read the queue across seams", () => {
  const service = { found: true, isForeground: true, mediaPlayback: true };
  const b = { first: S({ positionSec: 50 }), last: S({ index: 1, item: "a26-1", positionSec: 20 }), items: LONG_QUEUE,
    pidBefore: "1", pidAfter: "1", wake: "Asleep", service };
  assert.equal(verdictBackground(b).ok, true, JSON.stringify(verdictBackground(b).failures));
  assert.equal(verdictBackground({ ...b, wake: "Awake" }).ok, false);
  assert.equal(verdictBackground({ ...b, pidAfter: "2" }).ok, false);
  assert.equal(verdictBackground({ ...b, last: S({ positionSec: 60 }) }).ok, false, "10 s in a minute");
  const g = { first: S({ positionSec: 5 }), last: S({ index: 3, positionSec: 30 }), items: DOZE_QUEUE, wake: "Asleep", deep: "IDLE",
    bucket: GATES.bucketRare, pidBefore: "1", pidAfter: "1", service };
  assert.equal(verdictDoze(g).ok, true, JSON.stringify(verdictDoze(g).failures));
  assert.equal(verdictDoze({ ...g, deep: "ACTIVE" }).ok, false);
  assert.equal(verdictDoze({ ...g, last: S({ index: 2, positionSec: 30 }) }).ok, false, "195 s of 300");
});

test("A-26 (c): each press is judged on the engine's state, from a before that could have differed", () => {
  const on = S({ positionSec: 20 });
  const off = S({ positionSec: 20, running: false });
  assert.equal(verdictPress({ kind: "pause", before: on, after: off }).ok, true);
  assert.equal(verdictPress({ kind: "pause", before: off, after: off }).ok, false, "a pause of a paused engine measured nothing");
  assert.equal(verdictPress({ kind: "play", before: off, after: on }).ok, true);
  assert.equal(verdictPress({ kind: "next", before: on, after: S({ index: 1, item: "a26-1", positionSec: 1 }) }).ok, true);
  assert.equal(verdictPress({ kind: "next", before: on, after: on }).ok, false);
  assert.equal(verdictPress({ kind: "previous", before: on, after: S({ positionSec: 0.5 }) }).ok, true);
  assert.equal(verdictPress({ kind: "previous", before: on, after: S({ positionSec: 19.5 }) }).ok, false, "not back");
  assert.equal(verdictPress({ kind: "previous", before: on, after: S({ positionSec: 0.5, running: false }) }).ok, false, "back onto silence");
});

test("A-26 (d): the system controls must carry 15/30 in native mode (A04-F2 is the JS lane's, not this one's)", () => {
  const controls = { title: {}, artist: {}, back15: {}, forward30: {}, pause: {} };
  const ok = { controls, expected: { title: "t", artist: "a" }, tapped: { runningBefore: true }, after: { running: false } };
  assert.equal(verdictNotification(ok).ok, true);
  assert.equal(verdictNotification({ ...ok, controls: { ...controls, back15: null } }).ok, false);
  assert.equal(verdictNotification({ ...ok, after: { running: true } }).ok, false);
  assert.equal(verdictNotification({ ...ok, tapped: null }).ok, false);
});

test("A-26 (h): a transient loss must pause and resume; a permanent one must pause and stay paused", () => {
  /* MUTATION: drop the transient resume gate (the card's "a duck becomes pause-and-resume"). */
  const stack = (loss) => ({ entries: [{ pack: PKG, loss }], top: { pack: PKG } });
  const w = (a, b) => [S({ positionSec: a }), S({ positionSec: b })];
  const phase = (mode, held, after) => focusPhase({ mode, stackBefore: stack("none"), stackHeld: stack("LOSS_TRANSIENT"), stackAfter: stack("none"),
    before: w(1, 5), held, after, helperLog: [`mode=${mode} result=1`] });
  const good = [phase("transient", w(6, 6), w(8, 12)), phase("gain", w(6, 6), w(6, 6))];
  assert.equal(verdictFocus({ phases: good }).ok, true, JSON.stringify(verdictFocus({ phases: good }).failures));
  assert.equal(verdictFocus({ phases: [phase("transient", w(6, 10), w(10, 14))] }).ok, false, "kept playing under the helper");
  assert.equal(verdictFocus({ phases: [phase("transient", w(6, 6), w(6, 6))] }).ok, false, "never came back");
  const noFocus = focusPhase({ mode: "gain", stackBefore: { entries: [] }, before: w(1, 5), held: w(6, 6), after: w(6, 6), helperLog: ["mode=gain result=1"] });
  assert.equal(verdictFocus({ phases: [noFocus] }).ok, false, "we held no focus: handleAudioFocus is off");
  /* MUTATION: drop the permanent loss's no-resume gate (FocusMapping maps a lift after AUDIOFOCUS_LOSS as an end). */
  assert.equal(verdictFocus({ phases: [phase("gain", w(6, 6), w(8, 12))] }).ok, false, "a permanent loss came back by itself");
});

test("A-26 (i): the call pauses us and its end resumes us", () => {
  const p = (name, callState, playing) => ({ name, callState, playing, ourEntries: [] });
  const good = [p("before", "IDLE", true), p("ringing", "RINGING", false), p("in-call", "OFFHOOK", false), p("ended", "IDLE", false), p("ended+10s", "IDLE", true)];
  assert.equal(verdictCall({ phases: good }).ok, true, JSON.stringify(verdictCall({ phases: good }).failures));
  assert.equal(verdictCall({ phases: good.map((x) => (x.name === "in-call" ? { ...x, playing: true } : x)) }).ok, false);
  assert.equal(verdictCall({ phases: good.map((x) => (x.name.startsWith("ended") ? { ...x, playing: false } : x)) }).ok, false);
  assert.equal(verdictCall({ phases: good.filter((x) => x.name !== "ringing") }).ok, false);
});

test("A-26: small helpers and the CLI", () => {
  assert.equal(moved(S({ positionSec: 1 }), S({ positionSec: 3.5 })), 2.5);
  assert.equal(moved(S({ positionSec: 1 }), S({ item: "other", positionSec: 3 })), null, "a different item is not comparable");
  assert.equal(ourSession({ sessions: [{ package: "x", state: "PLAYING" }, { package: PKG, state: "PAUSED" }] }).state, "PAUSED");
  assert.deepEqual(SCENARIOS.map(([id]) => id),
    ["first-launch", "play", "background", "transport", "notification", "seams", "foray-seams", "doze", "focus", "call", "kill", "airplane",
      "bridge", "fallback"],
    "A-30's (e), A-26's (a)-(d), A-30's (f), A-40's Foray (f), A-26's (g), (h), (i), A-27's (j), A-30's (k), then A-28's page door, then A-29's fallback");
  assert.match(summaryMarkdown({ play: { ok: true } }), /\| \(a\) native[^|]*\| \*\*pass\*\* \|/);
  assert.equal(parseArgs(["play", "--art", "d"]).art, "d");
  assert.throws(() => parseArgs(["back-home", "--art", "d"]), /first argument/);
  assert.throws(() => parseArgs(["play"]), /--art/);
});

test("A-27 (j): the kill queue is whole episodes the store keeps a resume point for", () => {
  /* MUTATION: give the items an end_sec (a segment keeps no resume point, so the record says 0),
     or pause before the position store's 10 s floor. */
  assert.equal(KILL_QUEUE.length, 2);
  for (const it of KILL_QUEUE) {
    assert.equal(it.kind, "episode");
    assert.ok(it.audio_url.startsWith(ASSET_BASE));
    assert.equal("start_sec" in it, false, "no in-point");
    assert.equal("end_sec" in it, false, "no out-point");
  }
  assert.ok(KILL_QUEUE[0].audio_url.endsWith("click-cbr.mp3"), "the exact-seek track");
  const ids = KILL_LEGS.flatMap(({ leg }) => killQueue(leg).map((i) => i.id));
  assert.equal(new Set(ids).size, ids.length, "each leg's own ids: no leg resumes from another's position");
  const pausedAt = KILL.playBeforePauseMs / 1000;
  assert.ok(pausedAt > KILL.minSavedSec + 2 && pausedAt < 90 - 30 - 5, "clear of MIN_RESUME_SEC and NEAR_END_SEC");
  const java = fs.readFileSync(path.join(ROOT, "mobile/plugins/foray-audio/android/foray-engine-core-jvm/src/main/java/ai/jwlabs/foura/engine/EngineConstants.java"), "utf8");
  const store = /class PositionStore \{[\s\S]*?MIN_RESUME_SEC = ([\d.]+);[\s\S]*?NEAR_END_SEC = ([\d.]+);/.exec(java);
  assert.ok(store, "the position store's constants");
  assert.equal(Number(store[1]), KILL.minSavedSec, "the runner's floor is the engine's");
  assert.ok(pausedAt < 90 - Number(store[2]), "the pause is before the near-end rule");
});

const swap0 = (legs, name, o) => legs.map((l) => (l.leg === name ? { ...l, ...o } : l));

test("A-27 (j): a kill-then-play must bring 4a back at the saved position; force-stop is only recorded", () => {
  /* MUTATION: accept any resumed position; accept a SIGKILL that did not kill; gate the
     force-stop control; accept a died-and-back engine that did not boot from the record. */
  assert.deepEqual(KILL_LEGS.map((l) => [l.leg, l.gated]), [["am-kill", true], ["swipe-am-kill", true], ["sigkill", true], ["force-stop", false]]);
  const saved = { item: "a27-kill-0", offsetSec: 18.4, positionSec: 18.4, running: false };
  const leg = (name, o = {}) => ({ leg: name, saved, pidBefore: "100", pidAfterKill: name === "am-kill" ? "100" : null,
    killed: name !== "am-kill", pidAfterDispatch: "200", receivedBy: { pkg: PKG }, receiverStarts: name === "swipe-am-kill" ? 1 : 0,
    resumed: { item: "a27-kill-0", positionSec: 18.9, afterMs: 1500, coldBoot: name === "am-kill" ? null : "painted" }, ...o });
  const good = [leg("am-kill"), leg("swipe-am-kill"), leg("sigkill"),
    leg("force-stop", { resumed: null, pidAfterDispatch: null, receivedBy: { pkg: null } })];
  const v = verdictKill({ legs: good });
  assert.equal(v.ok, true, JSON.stringify(v.failures));
  assert.equal(v.recorded.length, 4, "the control is recorded");
  assert.equal(v.recorded[3].ourProcessAfterPlay, false);
  assert.equal(verdictKill({ legs: swap0(good, "swipe-am-kill", { receiverStarts: 0 }) }).ok, false, "the swipe's play must come through the receiver");
  assert.equal(verdictKill({ legs: swap0(good, "swipe-am-kill", { killed: false }) }).ok, false, "a swipe whose process lived measured nothing");

  const swap = (name, o) => swap0(good, name, o);
  assert.equal(verdictKill({ legs: swap("am-kill", { resumed: { ...good[0].resumed, positionSec: 0.4 } }) }).ok, false, "resumed from 0");
  assert.equal(verdictKill({ legs: swap("am-kill", { resumed: { ...good[0].resumed, positionSec: 40 } }) }).ok, false, "resumed far ahead");
  assert.equal(verdictKill({ legs: swap("sigkill", { killed: false }) }).ok, false, "a SIGKILL that did not kill measured nothing");
  assert.equal(verdictKill({ legs: swap("sigkill", { resumed: { ...good[2].resumed, coldBoot: null } }) }).ok, false, "not through the record");
  assert.equal(verdictKill({ legs: swap("sigkill", { resumed: null }) }).ok, false, "not playing");
  assert.equal(verdictKill({ legs: swap("sigkill", { resumed: { ...good[2].resumed, item: "a27-kill-1" } }) }).ok, false, "the wrong item");
  assert.equal(verdictKill({ legs: swap("am-kill", { saved: { ...saved, offsetSec: 3 } }) }).ok, false, "under the resume floor");
  assert.equal(verdictKill({ legs: swap("am-kill", { saved: { ...saved, running: true } }) }).ok, false, "never paused");
  assert.equal(verdictKill({ legs: good.filter((l) => l.leg !== "sigkill") }).ok, false, "a leg that did not run");
  assert.equal(verdictKill({ legs: swap("force-stop", { resumed: good[0].resumed, pidAfterDispatch: "300" }) }).ok, true, "the control is never gated");
  const later = swap("sigkill", { resumed: { ...good[2].resumed, positionSec: 18.4 + 6, afterMs: 5000 } });
  assert.equal(verdictKill({ legs: later }).ok, true, "a slow resume may have played on for as long as it took");

  /* A-27 review: (j) runs in the native lane. MUTATION: drop the setup check from verdictKill. */
  const stored = { delivered: true, result: 0, answer: { ok: true, override: "native" } };
  assert.equal(verdictKill({ legs: good, setup: [stored] }).ok, true);
  assert.equal(verdictKill({ legs: good, setup: [{ delivered: false, result: null, answer: null }] }).ok, false, "the setting was never stored");
  assert.equal(verdictKill({ legs: good, setup: [{ ...stored, answer: { ok: false, failures: ["bad-mode:x"] } }] }).ok, false);
});

test("A-27 review (j): the scenario stores the stock (native) lane first and puts Automatic back, whatever happened", () => {
  /* MUTATION: drop either drive, or move the reset out of the finally. A-31: the lane it stores
     is the stock one, Automatic, which is native since the flip. */
  const src = fs.readFileSync(new URL("./android-native-playback.mjs", import.meta.url), "utf8");
  const body = /\nasync function kill\(ctx\) \{([\s\S]*?)\n\}\n/.exec(src)?.[1] ?? "";
  const native = body.indexOf('drive(ctx, "override", ["--es", "mode", STOCK_MODE])');
  const firstLeg = body.indexOf("killLeg(ctx");
  const fin = body.indexOf("} finally {");
  const auto = body.indexOf('drive(ctx, "override", ["--es", "mode", "auto"])');
  assert.equal(STOCK_MODE, "auto", "A-31: the stock lane is the native lane");
  assert.ok(native >= 0 && native < firstLeg, "the stock lane is stored before the first leg");
  assert.ok(fin >= 0 && auto > fin, "Automatic is put back in the finally");
  assert.match(body, /verdictKill\(\{ legs, setup \}\)/, "and the setup is judged");
});

test("A-27 (j): the dump fields the runner reads are the ones the Java writes", () => {
  /* MUTATION: rename recordOffsetSec, coldBoot or mediaButtonReceiver in the service only. */
  const service = read("src/main/java/ai/jwlabs/foura/audio/ForayPlaybackService.java");
  for (const field of ["record", "recordOffsetSec", "coldBoot", "mediaButtonReceiver"]) {
    assert.match(service, new RegExp(`JsonNode\\.member\\("${field}"`), field);
  }
  const host = read("src/main/java/ai/jwlabs/foura/audio/engine/ForayEngineHost.java");
  assert.match(host, /PAINTED\("painted"\)/, "the token the verdict reads");
  const manifest = read("src/main/AndroidManifest.xml");
  assert.match(manifest, /android:name="ai\.jwlabs\.foura\.audio\.ForayMediaButtonReceiver"\s+android:enabled="false"\s+android:exported="true"/,
    "the receiver ships off, and the service turns it on");
  assert.match(manifest, /<action android:name="android\.intent\.action\.MEDIA_BUTTON" \/>/);
  const driver = read("src/debug/java/ai/jwlabs/foura/audio/EngineDriveReceiver.java");
  assert.match(driver, /case "task-removed" -> \{[\s\S]*?held\.release\(\);[\s\S]*?service\.onTaskRemoved\(null\);/,
    "the swipe lets go of the binding, then is Media3's onTaskRemoved");
  const receiver = read("src/main/java/ai/jwlabs/foura/audio/ForayMediaButtonReceiver.java");
  assert.match(receiver, /"media-button receiver " \+ \(resumable \? "start" : "drop"\)/, "the logcat line the swipe leg counts");
});

/* ─────────── A-28: the page's door ─────────── */

const NATIVE_COPY = [
  "#   1 12:00:00.000 boot       web=abc",
  "#   2 12:00:00.400 engineMode native (override)",
  "engine=native v1.0.0 proto=1 caps=none reason=override strikes=? hold=forever build=2026092901 | web=abc",
  "engine rows 4 of 2000, #1..#4",
].join("\n");

/* A-31: a stock launch's Copy, the native lane by the build's default. */
const STOCK_COPY = [
  "#   1 12:00:00.000 boot       web=abc",
  "#   2 12:00:00.400 engineMode native (native)",
  "engine=native v1.0.0 proto=1 caps=episode,continuation reason=build-default strikes=0 hold=forever build=2026093001 | web=abc",
  "engine rows 6 of 2000, #1..#6",
].join("\n");

const STOCK = { lane: "native", status: { lane: "native", override: "auto", holdPolicy: "forever", commands: ["setModeOverride"] } };
const AFTER = { lane: "js", status: { lane: "js", override: "web", holdPolicy: null, commands: ["setModeOverride"] } };
const HOSTING = { hosting: true, legacyRunning: false };
const PLAYED = {
  page: { ok: true, answered: true },
  engine: { item: "a31-page-episode", state: "playing", running: true, exoPlaying: true, positionSec: 1.8 },
};

test("A-28: the Copy's engine facts are read from its header, its timeline and its ring line", () => {
  /* MUTATION: read the lane from anywhere but the `engine=` header, or accept an engineMode js
     row as native. Each fails. */
  const f = copyFacts(NATIVE_COPY);
  assert.equal(f.lane, "native");
  assert.equal(f.reason, "override");
  assert.equal(f.proto, "1");
  assert.equal(f.caps, "none");
  assert.deepEqual(f.modeRows, [{ mode: "native", reason: "override" }]);
  assert.equal(f.engineRows, 4);
  const js = copyFacts("#   2 12:00:00.400 engineMode js (engine-legacy)\nengine=js reason=engine-legacy build=? | web=x\nengine rows not read (no-engine)");
  assert.equal(js.lane, "js");
  assert.deepEqual(js.modeRows, [{ mode: "js", reason: "engine-legacy" }]);
  assert.equal(js.engineRows, null);
  assert.equal(js.readError, "no-engine");
  assert.equal(copyFacts("").header, null);
});

test("A-31: the verdict passes a native stock launch, the page's episode on the engine and Web's way back, and fails each gap", () => {
  /* MUTATION: drop any one check in verdictBridge; its case below stays green. The pre-A-31
     verdict (a stock launch in the JS lane, an override to Native) fails here on its first line. */
  const good = { stock: STOCK, copy: copyFacts(STOCK_COPY), played: PLAYED, override: { ok: true }, after: AFTER, service: HOSTING };
  assert.deepEqual(verdictBridge(good), { ok: true, failures: [] });
  const fails = (patch, re) => {
    const v = verdictBridge({ ...good, ...patch });
    assert.equal(v.ok, false, JSON.stringify(patch));
    assert.ok(v.failures.some((f) => re.test(f)), `${JSON.stringify(patch)} -> ${v.failures.join("; ")}`);
  };
  fails({ stock: { lane: "js", status: STOCK.status } }, /stock Android launch must be the native lane since A-31; its lane is js/);
  fails({ stock: { lane: "native", status: { lane: "native", override: "native" } } }, /native\/build-default/);
  fails({ stock: { error: "no ForayPlayer on window" } }, /stock launch could not be read/);
  fails({ copy: copyFacts(STOCK_COPY.replace(/engine=native .* reason=build-default/, "engine=js reason=engine-legacy")) }, /not engine=native/);
  fails({ copy: copyFacts(STOCK_COPY.replace("reason=build-default", "reason=override")) }, /reason is override, not build-default/);
  fails({ copy: copyFacts(STOCK_COPY.replace("caps=episode,continuation", "caps=continuation")) }, /does not advertise episode/);
  fails({ copy: copyFacts(STOCK_COPY.replace("engineMode native (native)", "engineMode js (engine-legacy)")) }, /engineMode native/);
  fails({ copy: copyFacts(STOCK_COPY.replace("engine rows 6 of 2000, #1..#6", "engine rows not read (timeout)")) }, /did not read the engine's ring: timeout/);
  fails({ played: { ...PLAYED, page: { ok: false, error: "window.ForayPlayer.play is missing" } } }, /ForayPlayer\.play did not run/);
  fails({ played: { ...PLAYED, engine: null } }, /could not be read after the page's play/);
  fails({ played: { ...PLAYED, engine: { ...PLAYED.engine, item: "a26-0" } } }, /did not reach the engine/);
  fails({ played: { ...PLAYED, engine: { ...PLAYED.engine, item: null } } }, /did not reach the engine/);
  fails({ played: { ...PLAYED, engine: { ...PLAYED.engine, exoPlaying: false } } }, /not playing it/);
  fails({ played: { ...PLAYED, engine: { ...PLAYED.engine, positionSec: 0 } } }, /not playing it/);
  fails({ service: null }, /not running/);
  fails({ service: { hosting: true, legacyRunning: true } }, /legacy PlaybackKeepAliveService is running/);
  fails({ override: { ok: false, reason: "capability-off" } }, /Web was not stored/);
  fails({ after: { lane: "native", status: AFTER.status } }, /lane is native, not js/);
  fails({ after: { lane: "js", status: { ...AFTER.status, override: "auto" } } }, /does not read Web/);
  fails({ after: { error: "timeout" } }, /relaunched page could not be read: timeout/);
});

test("A-31: the page's episode is the flip's own id over a bundled asset, played through ForayPlayer.play", () => {
  /* MUTATION: an https or app-origin URL the deck cannot read offline; the driver's id prefix;
     a raw engineSend instead of the page's own play. */
  assert.equal(PAGE_EPISODE.id, "a31-page-episode");
  assert.ok(PAGE_EPISODE.audio_url.startsWith(ASSET_BASE), PAGE_EPISODE.audio_url);
  const expr = pagePlayExpression();
  assert.match(expr, /P\.play\(\{"id":"a31-page-episode"/);
  assert.doesNotMatch(expr, /engineSend|nativePromise/);
});

test("A-28: the page expressions go through the page's own Developer row, and the CLI takes the scenario", () => {
  /* The override is the row a listener taps (engineDeveloperSend), never a raw engineSend the
     page's client did not count; and the status waits for the page to boot. */
  assert.match(overrideExpression("native"), /engineDeveloperSend\("setModeOverride", \{ mode: "native" \}\)/);
  assert.doesNotMatch(overrideExpression("native"), /nativePromise|engineSend"/);
  assert.match(ENGINE_STATUS_EXPRESSION, /whenEngineReady\(\)/);
  assert.match(ENGINE_STATUS_EXPRESSION, /engineDeveloperStatus\(\)/);
  assert.equal(DEVTOOLS_ENDPOINT, "http://127.0.0.1:9222");
  assert.equal(parseArgs(["bridge", "--art", "d"]).scenario, "bridge");
});

/* ─────────── A-29: the fallback ─────────── */

/* Logcat as `adb logcat -d -s ForayEngine ForayEngine.owner` prints one faulted native launch:
   the owner's decision line, then the engine's rows (EngineLog: `seq iso kind {json}`). */
function faultLog(n, { decision = `mode=native reason=override strikes=${n - 1} sentinelWasSet=n sticky=null`, rows } = {}) {
  const at = "09-30 12:00:00.000  4242  4242";
  const lines = [
    `${at} W ForayEngine.owner: ForayEngine.owner DEBUG fault armed: hello-throws`,
    `${at} I ForayEngine.owner: ForayEngine.owner ${decision}`,
    ...(rows ?? [
      `{"mode":"native","reason":"override","strikes":${n - 1},"sentinelWasSet":"n","build":"2026093001"}`,
      '{"kind":"fault","at":"hello","error":"Injected"}',
      `{"reason":"page-health","strikes":${n}}`,
      '{"reason":"downgrade","cap":"all"}',
    ]).map((r, i) => `${at} I ForayEngine: ${i + 1} 2026-09-30T12:00:00.000Z mode ${r}`),
    `${at} I ForayEngine.owner: ForayEngine.owner relinquish cap=all source=restore failures=[]`,
  ];
  return lines.join("\n");
}

const JS_COPY = copyFacts("#   2 12:00:00.400 engineMode js (engine-legacy)\nengine=js reason=engine-legacy strikes=1 build=? | web=x");

function launchOf(n) {
  const pinned = n === 4;
  return {
    n,
    status: { lane: "js", status: { lane: "js", override: "native" } },
    legacy: n === 1 ? { started: { alreadyRunning: false, started: true, reason: "" } } : null,
    keys: pinned
      ? { ok: true, "ForayEngine.strikes": "3", "ForayEngine.stickyLegacyBuild": "2026093001" }
      : { ok: true, "ForayEngine.strikes": String(n) },
    facts: ownerFacts(pinned
      ? faultLog(4, { decision: "mode=legacy reason=crash-loop strikes=3 sentinelWasSet=n sticky=2026093001", rows: [] })
      : faultLog(n)),
    copy: JS_COPY,
    engineService: false,
  };
}

const GOOD_FALLBACK = {
  setup: [{ answer: { ok: true, override: "native" } }, { answer: { ok: true, fault: "hello-throws" } }],
  launches: [1, 2, 3, 4].map(launchOf),
};

test("A-29: ownerFacts reads the decision line and the engine's mode rows from logcat", () => {
  /* MUTATION: read the strikes from the wrong group, parse the rows without the ` mode ` anchor
     (a cmd row with a `reason` would pass for a downgrade), or read `sticky=null` as a pin. */
  const f = ownerFacts(faultLog(2));
  assert.deepEqual(f.decision, { mode: "native", reason: "override", strikes: 1, sentinelWasSet: false, sticky: null });
  assert.deepEqual(f.fault, { kind: "fault", at: "hello", error: "Injected" });
  assert.deepEqual(f.pageHealth, { reason: "page-health", strikes: 2 });
  assert.deepEqual(f.downgrade, { reason: "downgrade", cap: "all" });
  assert.equal(f.armed, true);
  const cmd = ownerFacts('x I ForayEngine: 3 2026-09-30T12:00:00.000Z cmd {"cmd":"play","reason":"downgrade"}');
  assert.equal(cmd.downgrade, null, "only a mode row is a downgrade");
  const pinned = ownerFacts("x I ForayEngine.owner: ForayEngine.owner mode=legacy reason=crash-loop strikes=3 sentinelWasSet=y sticky=2026093001");
  assert.deepEqual(pinned.decision, { mode: "legacy", reason: "crash-loop", strikes: 3, sentinelWasSet: true, sticky: "2026093001" });
  assert.equal(ownerFacts("").decision, null);
});

test("A-29: the fallback verdict passes three faulted native launches and a pinned fourth, and fails each gap", () => {
  /* MUTATION: drop any one check in verdictFallback; its case below stays green. */
  assert.deepEqual(verdictFallback(GOOD_FALLBACK), { ok: true, failures: [] });
  const fails = (mutate, re) => {
    const input = structuredClone(GOOD_FALLBACK);
    mutate(input);
    const v = verdictFallback(input);
    assert.equal(v.ok, false, String(mutate));
    assert.ok(v.failures.some((f) => re.test(f)), `${String(mutate)} -> ${v.failures.join("; ")}`);
  };
  fails((i) => { i.setup[1].answer.ok = false; }, /setup step 2/);
  fails((i) => { i.launches.pop(); }, /expected 4 launches/);
  fails((i) => { i.launches[0].status = { lane: "native" }; }, /launch 1: the page's lane is native/);
  fails((i) => { i.launches[1].status = { error: "no ForayPlayer on window" }; }, /launch 2: the page's lane could not be read/);
  fails((i) => { i.launches[0].engineService = true; }, /still running after the fallback/);
  fails((i) => { i.launches[2].copy = copyFacts(""); }, /launch 3: the page's Copy has no `engineMode js` row/);
  fails((i) => { i.launches[0].facts = ownerFacts(""); }, /launch 1: no ForayEngine.owner decision line/);
  fails((i) => { i.launches[1].facts.decision.mode = "legacy"; }, /launch 2: the lane was legacy\/override/);
  fails((i) => { i.launches[1].facts.decision.strikes = 0; }, /launch 2: decided with 0 strikes, expected 1/);
  fails((i) => { i.launches[0].facts.armed = false; }, /launch 1: the debug fault was not armed/);
  fails((i) => { i.launches[0].facts.fault = null; }, /launch 1: no `mode kind=fault at=hello` row/);
  fails((i) => { i.launches[2].facts.pageHealth = { reason: "page-health", strikes: 1 }; }, /launch 3: no page-health strike to 3/);
  fails((i) => { i.launches[0].facts.downgrade = null; }, /launch 1: the engine did not relinquish/);
  fails((i) => { i.launches[1].keys["ForayEngine.strikes"] = "0"; }, /launch 2: the stored strikes are 0, not 2/);
  fails((i) => { i.launches[3].facts.decision.reason = "override"; i.launches[3].facts.decision.mode = "native"; },
    /launch 4: three strikes must pin the JS lane/);
  fails((i) => { i.launches[3].facts.decision.strikes = 2; }, /launch 4: decided with 2 strikes, expected 3/);
  fails((i) => { i.launches[3].keys["ForayEngine.stickyLegacyBuild"] = null; }, /launch 4: the crash loop is not sticky/);
  fails((i) => { i.launches[3].facts.fault = { kind: "fault", at: "hello" }; }, /launch 4: a pinned build must not reach the engine/);
  fails((i) => { i.launches[0].legacy = { started: { started: false, reason: "native-engine" } }; },
    /launch 1: the legacy service did not start after the fallback/);
});

test("A-29: the fallback's page expression asks the legacy service through the plugin and stops it, and the driver's commands exist", () => {
  /* MUTATION: ask for a start without the stop (the next scenario inherits a running service),
     or rename a driver command in the Java only. */
  assert.match(LEGACY_START_EXPRESSION, /nativePromise\("ForayAudio", "start", \{\}\)/);
  assert.match(LEGACY_START_EXPRESSION, /nativePromise\("ForayAudio", "stop", \{\}\)/);
  const receiver = read("src/debug/java/ai/jwlabs/foura/audio/EngineDriveReceiver.java");
  for (const cmd of ["fault", "override", "keys"]) assert.match(receiver, new RegExp(`case "${cmd}" ->`), `the driver has no ${cmd} command`);
  assert.match(read("src/main/java/ai/jwlabs/foura/audio/engine/EngineFaults.java"), /HELLO = "hello-throws"/);
  assert.match(read("src/main/java/ai/jwlabs/foura/audio/EngineOwnership.java"),
    /"ForayEngine\.owner mode=" \+ d\.mode\(\)\.token \+ " reason=" \+ d\.reason\(\)\.token \+ " strikes=" \+ d\.strikes\(\)/,
    "ownerFacts reads the owner's decision line as EngineOwnership writes it");
  assert.equal(parseArgs(["fallback", "--art", "d"]).scenario, "fallback");
});

/* ─────────── A-30: the native lane, (e), (f), (k) ─────────── */

/* The engine's rows from run 36688133433's native (g) Doze (verdict-native-doze.json): a tap
   pause and a play of the same item (a press, not a seam), a load of item 0 after a remote pause,
   then three out-point seams crossed while dozing, each to a new source. As logcat prints them. */
const DOZE_ROWS = [
  '96 2026-09-30T08:18:41.402Z stop {"cause":"pause","source":"tap","item":"a26-ep-0","positionSec":30.193,"state":"playing"}',
  '97 2026-09-30T08:18:41.426Z deck {"kind":"time-control","token":9,"status":"paused","reason":null,"step":"ready","positionSec":30.193,"bufferedAheadSec":59.879,"suppressed":0,"rate":1}',
  '98 2026-09-30T08:18:44.167Z deck {"kind":"reuse","token":10,"startSec":30.391,"fromSec":30.391,"bufferedAheadSec":59.681,"idleSec":2.745}',
  '99 2026-09-30T08:18:44.170Z deck {"kind":"time-control","token":10,"status":"paused","reason":null,"step":"seek","positionSec":30.391,"bufferedAheadSec":59.681,"suppressed":0,"rate":1}',
  '100 2026-09-30T08:18:44.184Z deck {"kind":"ready","token":10,"landedSec":30.391,"targetSec":30.391,"prerolled":true,"reuse":true,"elapsedMs":14,"attempts":0,"marks":{"readiness":14,"ready":14},"bufferedAheadSec":59.681}',
  '102 2026-09-30T08:18:44.198Z deck {"kind":"time-control","token":10,"status":"playing","reason":null,"step":"ready","positionSec":30.391,"bufferedAheadSec":59.681,"suppressed":0,"rate":1}',
  '103 2026-09-30T08:18:46.590Z remote {"cmd":"pause","dupCandidate":"n","route":null,"thread":"main","state":"playing","grace":"n","graceReason":null,"bgRemainingMs":null}',
  '104 2026-09-30T08:18:46.592Z stop {"cause":"pause","source":"remote","item":"a26-ep-0","positionSec":32.735,"state":"playing"}',
  '105 2026-09-30T08:18:46.595Z deck {"kind":"time-control","token":10,"status":"paused","reason":null,"step":"ready","positionSec":32.745,"bufferedAheadSec":57.327,"suppressed":0,"rate":1}',
  '106 2026-09-30T08:18:46.650Z remote {"kind":"status","cmd":"pause","status":"success"}',
  '107 2026-09-30T08:18:49.662Z deck {"kind":"reuse","token":11,"startSec":0,"fromSec":32.745,"bufferedAheadSec":57.327,"idleSec":3.066}',
  '109 2026-09-30T08:18:49.741Z deck {"kind":"ready","token":11,"landedSec":0,"targetSec":0,"prerolled":true,"reuse":true,"elapsedMs":80,"attempts":0,"marks":{"readiness":80,"ready":80},"bufferedAheadSec":90.036}',
  '110 2026-09-30T08:18:49.757Z restore write',
  '111 2026-09-30T08:18:49.761Z deck {"kind":"time-control","token":11,"status":"playing","reason":null,"step":"ready","positionSec":0,"bufferedAheadSec":90.036,"suppressed":0,"rate":1}',
  '112 2026-09-30T08:20:15.088Z deck {"kind":"time-control","token":11,"status":"paused","reason":null,"step":"ready","positionSec":85.241,"bufferedAheadSec":4.831,"suppressed":0,"rate":1}',
  '113 2026-09-30T08:20:15.090Z outPoint {"kind":"stop","layer":"boundary","overshootMs":241,"rate":1,"token":11}',
  '114 2026-09-30T08:20:15.091Z deck {"kind":"attach","token":12,"startSec":0,"precise":true,"host":null,"cold":"other-source","idleSec":0.004}',
  '117 2026-09-30T08:20:15.144Z deck {"kind":"ready","token":12,"landedSec":0,"targetSec":0,"prerolled":true,"reuse":false,"elapsedMs":52,"attempts":0,"marks":{"duration":46,"readiness":52,"ready":52},"bufferedAheadSec":12.528}',
  '119 2026-09-30T08:20:15.162Z deck {"kind":"time-control","token":12,"status":"playing","reason":null,"step":"ready","positionSec":0,"bufferedAheadSec":12.528,"suppressed":0,"rate":1}',
  '120 2026-09-30T08:21:40.342Z deck {"kind":"time-control","token":12,"status":"paused","reason":null,"step":"ready","positionSec":85.132,"bufferedAheadSec":4.939,"suppressed":0,"rate":1}',
  '121 2026-09-30T08:21:40.343Z outPoint {"kind":"stop","layer":"boundary","overshootMs":132,"rate":1,"token":12}',
  '122 2026-09-30T08:21:40.345Z deck {"kind":"attach","token":13,"startSec":0,"precise":true,"host":null,"cold":"other-source","idleSec":0.003}',
  '125 2026-09-30T08:21:40.410Z deck {"kind":"ready","token":13,"landedSec":0,"targetSec":0,"prerolled":true,"reuse":false,"elapsedMs":66,"attempts":0,"marks":{"duration":57,"readiness":66,"ready":66},"bufferedAheadSec":22.032}',
  '127 2026-09-30T08:21:40.427Z deck {"kind":"time-control","token":13,"status":"playing","reason":null,"step":"ready","positionSec":0,"bufferedAheadSec":22.032,"suppressed":0,"rate":1}',
  '128 2026-09-30T08:23:05.708Z deck {"kind":"time-control","token":13,"status":"paused","reason":null,"step":"ready","positionSec":85.225,"bufferedAheadSec":66.839,"suppressed":0,"rate":1}',
  '129 2026-09-30T08:23:05.709Z outPoint {"kind":"stop","layer":"boundary","overshootMs":225,"rate":1,"token":13}',
  '130 2026-09-30T08:23:05.711Z deck {"kind":"attach","token":14,"startSec":0,"precise":true,"host":null,"cold":"other-source","idleSec":0.006}',
  '133 2026-09-30T08:23:05.777Z deck {"kind":"ready","token":14,"landedSec":0,"targetSec":0,"prerolled":true,"reuse":false,"elapsedMs":66,"attempts":0,"marks":{"duration":58,"readiness":66,"ready":66},"bufferedAheadSec":35.964}',
  '135 2026-09-30T08:23:05.799Z deck {"kind":"time-control","token":14,"status":"playing","reason":null,"step":"ready","positionSec":0,"bufferedAheadSec":35.964,"suppressed":0,"rate":1}',
];
const logcatOf = (rows, pid = 5488) => rows.map((r) => `09-30 08:20:15.091  ${pid}  ${pid} I ForayEngine: ${r}`).join("\n");

test("A-30: the dump says which lane the process is in, and every lane scenario is judged on it", () => {
  /* MUTATION: rename nativeLane in the service only; drop a scenario from LANE_SCENARIOS; pass a
     scenario that read no lane at all, or one JS-lane read among native ones. */
  const service = read("src/main/java/ai/jwlabs/foura/audio/ForayPlaybackService.java");
  assert.match(service, /JsonNode\.member\("nativeLane", JsonNode\.bool\(EngineOwnership\.engineLane\(this\)\)\)/);
  assert.deepEqual([...LANE_SCENARIOS].sort(),
    SCENARIOS.map(([id]) => id).filter((id) => id !== "bridge" && id !== "fallback").sort(),
    "every engine scenario runs in the native lane; the page's door and the fallback set their own");
  assert.deepEqual(laneFailures("play", [true, true, true]), []);
  assert.match(laneFailures("play", [true, false, true])[0], /1 of 3 engine dumps said the process is not in the native lane/);
  assert.match(laneFailures("doze", [])[0], /no dump said which lane/);
  assert.match(laneFailures("seams", undefined)[0], /no dump said which lane/);
  assert.deepEqual(laneFailures("bridge", []), [], "the page's door is not a lane scenario");
  assert.deepEqual(laneFailures("fallback", [false]), []);
});

test("A-30: the lane is stored before the app starts, and the page's door starts from Automatic", () => {
  /* MUTATION: call ensureNativeLane after `am start` in prepare; drop the force-stop for a process
     that is not native; drop bridge's reset (it would read the native lane as the stock one). */
  const src = fs.readFileSync(new URL("./android-native-playback.mjs", import.meta.url), "utf8");
  const prep = /\nasync function prepare\(ctx\) \{([\s\S]*?)\n\}\n/.exec(src)?.[1] ?? "";
  assert.ok(prep.indexOf("ensureNativeLane(ctx)") >= 0 && prep.indexOf("ensureNativeLane(ctx)") < prep.indexOf('"am", "start"'),
    "the lane is set before the launch");
  assert.match(prep, /LANE_SCENARIOS\.includes\(ctx\.scenario\)/);
  const ensure = /\nasync function ensureNativeLane\(ctx, \{ fresh = false \} = \{\}\) \{([\s\S]*?)\n\}\n/.exec(src)?.[1] ?? "";
  /* A-31: the lane scenarios run in the stock lane (Automatic), which is native since the flip. */
  assert.match(ensure, /drive\(ctx, "override", \["--es", "mode", STOCK_MODE\]\)/);
  assert.equal(STOCK_MODE, "auto");
  assert.match(ensure, /if \(fresh \|\| now\?\.nativeLane !== true\) \{\s*shell\("am", "force-stop", ctx\.pkg\);/);
  const bridge = /\nasync function bridge\(ctx\) \{([\s\S]*?)\n\}\n/.exec(src)?.[1] ?? "";
  const auto = bridge.indexOf('drive(ctx, "override", ["--es", "mode", "auto"])');
  assert.ok(auto >= 0 && auto < bridge.indexOf("await prepare(ctx)"), "bridge puts Automatic back before its stock launch");
  assert.match(src, /const lane = laneFailures\(args\.scenario, ctx\.laneSeen\);/, "main judges the lane");
});

test("A-30 (f): the seams queue is the click tracks, segments then a whole episode, seven seams", () => {
  /* MUTATION: an https URL; a segment past its file; drop the whole episode (no natural end). */
  assert.equal(SEAMS_QUEUE.length, 8);
  assert.equal(new Set(SEAMS_QUEUE.map((i) => i.id)).size, SEAMS_QUEUE.length);
  for (const it of SEAMS_QUEUE) {
    assert.ok(it.audio_url.startsWith(ASSET_BASE), it.audio_url);
    assert.ok(CLIPS.some((c) => it.audio_url.endsWith(c.file)));
    assert.equal(it.kind, "episode");
    if (it.end_sec != null) assert.ok(it.start_sec >= 0 && it.end_sec > it.start_sec && it.end_sec <= it.duration_sec);
  }
  const whole = SEAMS_QUEUE.filter((i) => i.end_sec == null);
  assert.equal(whole.length, 1, "one whole episode, which ends at its file's end");
  assert.equal(whole[0].start_sec, undefined, "whole: no in-point either");
  const same = SEAMS_QUEUE.slice(1).filter((it, i) => it.audio_url === SEAMS_QUEUE[i].audio_url).length;
  assert.equal(same, 2, "two seams inside one source");
  assert.ok(SEAMS_QUEUE.some((i) => i.audio_url.endsWith(CLIPS[2].file)), "one onto the VBR track with no seek table");
});

test("A-30 (f): engine rows parse from the dump and from logcat, once each, in order", () => {
  /* MUTATION: parse the body as JSON when it is not an object; keep another pid's rows; keep a
     row twice when the dump and logcat both carry it. */
  const r = parseEngineRow(DOZE_ROWS[13]);
  assert.equal(r.seq, 111);
  assert.equal(r.kind, "deck");
  assert.equal(r.json.status, "playing");
  assert.equal(r.at, Date.parse("2026-09-30T08:18:49.761Z"));
  assert.equal(parseEngineRow("110 2026-09-30T08:18:49.757Z restore write").json, null);
  assert.equal(parseEngineRow("no row here"), null);
  const log = `${logcatOf(DOZE_ROWS.slice(0, 5))}\n${logcatOf(DOZE_ROWS.slice(5, 7), 9999)}\n--------- beginning of main`;
  assert.equal(engineRowsFromLogcat(log).length, 7);
  assert.equal(engineRowsFromLogcat(log, 5488).length, 5, "one process's rows");
  const merged = mergeRows(engineRowsFromLogcat(logcatOf(DOZE_ROWS.slice(0, 10))), DOZE_ROWS.slice(5).map(parseEngineRow));
  assert.equal(merged.length, DOZE_ROWS.length);
  assert.deepEqual(merged.map((x) => x.seq), DOZE_ROWS.map((x) => Number(x.split(" ")[0])));
});

test("A-30 (f): a seam runs from the outgoing load's end to the incoming load's first playing; a press is not a seam", () => {
  /* MUTATION: measure from the attach (drops the out-point's own time); count the load after a
     remote pause as a seam; end a load on a stall it recovered from. */
  const seams = episodeSeams(DOZE_ROWS.map(parseEngineRow));
  const clean = seams.filter((s) => !s.commanded);
  assert.deepEqual(clean.map((s) => s.gapMs), [74, 85, 91], "run 36688133433's three dozing seams");
  assert.deepEqual(clean.map((s) => s.endFrom), ["time-control", "time-control", "time-control"]);
  assert.deepEqual(clean.map((s) => s.via), ["attach", "attach", "attach"]);
  assert.deepEqual(clean.map((s) => s.cold), ["other-source", "other-source", "other-source"]);
  assert.deepEqual(clean.map((s) => s.readyMs), [52, 66, 66]);
  assert.deepEqual(clean.map((s) => s.overshootMs), [241, 132, 225]);
  assert.equal(clean[0].loadMs, 71, "attach to playing");
  assert.equal(seams.filter((s) => s.commanded).length, 1, "the load after a remote pause (the resume after the tap pause has no load playing before it)");
  // A natural end: no outPoint, the load ends on its own time-control, a same-source reuse follows.
  const natural = [
    '1 2026-09-30T00:00:00.000Z deck {"kind":"attach","token":1,"cold":"no-item"}',
    '2 2026-09-30T00:00:00.500Z deck {"kind":"time-control","token":1,"status":"playing"}',
    '3 2026-09-30T00:01:30.000Z deck {"kind":"time-control","token":1,"status":"waiting"}',
    '4 2026-09-30T00:01:30.100Z deck {"kind":"time-control","token":1,"status":"playing"}',
    '5 2026-09-30T00:01:31.000Z deck {"kind":"time-control","token":1,"status":"paused"}',
    '6 2026-09-30T00:01:31.010Z deck {"kind":"reuse","token":2}',
    '7 2026-09-30T00:01:31.020Z deck {"kind":"ready","token":2,"elapsedMs":9}',
    '8 2026-09-30T00:01:31.060Z deck {"kind":"time-control","token":2,"status":"playing"}',
  ].map(parseEngineRow);
  const [n] = episodeSeams(natural);
  assert.equal(n.gapMs, 60, "a stall that recovered is not the end; the pause after it is");
  assert.equal(n.via, "reuse");
  assert.equal(n.cold, "same-source");
  assert.equal(n.readyMs, 9);
  assert.equal(n.commanded, false);
});

test("A-30 (f): the numbers are nearest-rank over the clean seams, by kind; the gate is crossing every seam", () => {
  /* MUTATION: include commanded seams in the numbers; pass a queue that stopped short; pass with
     the screen on or a new pid. */
  const seams = [
    { gapMs: 80, via: "attach" }, { gapMs: 60, via: "reuse" }, { gapMs: 120, via: "attach" }, { gapMs: 70, via: "attach" },
    { gapMs: 90, via: "attach" }, { gapMs: 50, via: "reuse" }, { gapMs: 400, via: "attach" }, { gapMs: 9000, via: "attach", commanded: true },
  ];
  const st = episodeSeamStats(seams);
  assert.equal(st.count, 7);
  assert.equal(st.commanded, 1);
  assert.equal(st.minMs, 50);
  assert.equal(st.medianMs, 80);
  assert.equal(st.p95Ms, 400);
  assert.equal(st.maxMs, 400);
  assert.deepEqual(st.byKind["same-source"], { count: 2, minMs: 50, medianMs: 50, p95Ms: 60, maxMs: 60 });
  assert.equal(st.byKind["cross-source"].count, 5);
  const good = { drive: { answer: { ok: true } }, wake: "Asleep", pidBefore: "1", pidAfter: "1", last: { index: SEAMS_QUEUE.length - 1 }, seams };
  assert.equal(verdictSeams(good).ok, true);
  assert.equal(verdictSeams(good).recorded.p95Ms, 400, "recorded, never gated on the gap");
  assert.match(verdictSeams({ ...good, last: { index: 4 } }).failures[0], /stopped at item 4/);
  assert.match(verdictSeams({ ...good, wake: "Awake" }).failures[0], /screen did not go off/);
  assert.match(verdictSeams({ ...good, pidAfter: "2" }).failures[0], /pid changed/);
  assert.match(verdictSeams({ ...good, seams: seams.slice(0, 4) }).failures[0], /4 of the queue's 7 seams/);
  assert.match(verdictSeams({ ...good, drive: { answer: { ok: false } } }).failures[0], /load did not play/);
});

test("A-30 (k): the engine's half reads the load, the stop and whether anything sounded, after the mark", () => {
  /* MUTATION: read rows from before the load (an earlier item's stop would count); accept a pause
     stop as the decision; miss a playing time-control on the failed load. */
  const rows = [
    '40 2026-09-30T00:00:00.000Z stop {"cause":"error","item":"old"}',
    '41 2026-09-30T00:00:01.000Z deck {"kind":"attach","token":7,"cold":"other-source"}',
    '42 2026-09-30T00:00:02.000Z stop {"cause":"pause","source":"tap"}',
    '43 2026-09-30T00:00:07.500Z deck {"kind":"failed","token":7,"code":2001}',
    '44 2026-09-30T00:00:07.501Z stop {"cause":"error","item":"a30-air-0"}',
  ].map(parseEngineRow);
  const f = airplaneFacts(rows, 40);
  assert.equal(f.decisionMs, 6501);
  assert.deepEqual(f.stop, { cause: "error", at: "2026-09-30T00:00:07.501Z" });
  assert.deepEqual(f.deck, [{ kind: "failed", token: 7, code: 2001 }]);
  assert.equal(f.sounded, false);
  assert.equal(airplaneFacts(rows, 44).stop, null);
  const late = airplaneFacts([rows[1], parseEngineRow('45 2026-09-30T00:00:21.000Z stop {"cause":"load-deadline"}')], 40);
  assert.equal(late.decisionMs, 20000);
  assert.equal(airplaneFacts([rows[1], parseEngineRow('46 2026-09-30T00:00:03.000Z deck {"kind":"time-control","token":7,"status":"playing"}')], 40).sounded, true);
  assert.equal(AIRPLANE_QUEUE[0].audio_url, UNREACHABLE_EPISODE_URL);
  assert.ok(UNREACHABLE_EPISODE_URL.startsWith("https://"), "the network, not an asset");
  assert.equal(NATIVE_GATES.airplaneDecisionMs, NATIVE_GATES.loadDeadlineMs + 5000);
  assert.match(read("src/main/java/ai/jwlabs/foura/audio/engine/ExoDeck.java"), /DEFAULT_LOAD_DEADLINE_SEC = 20;/,
    "the gate is the deck's own deadline");
});

test("A-30 (k): both halves are gated, and the Foray must go through the relinquish", () => {
  /* MUTATION: drop any one check; each failing input below turns red for its own reason. */
  const copy = copyFacts("#   2 12:00:00.400 engineMode native (override)\n#   9 12:00:09.000 engineMode js (relinquished)\nengine=js reason=override");
  const good = {
    airplane: true, facts: { attachAt: "x", stop: { cause: "error" }, decisionMs: 6500, sounded: false },
    after: { state: "idle", running: false, exoPlaying: false }, session: { state: "PAUSED" }, recovered: { item: "a26-0" },
    laneBefore: "native", foray: { ok: true, failures: [] }, copy,
  };
  assert.equal(verdictAirplane(good).ok, true, JSON.stringify(verdictAirplane(good).failures));
  const bad = (patch, re) => {
    const v = verdictAirplane({ ...good, ...patch });
    assert.equal(v.ok, false);
    assert.ok(v.failures.some((f) => re.test(f)), `${re} not in ${JSON.stringify(v.failures)}`);
  };
  bad({ airplane: false }, /airplane mode did not engage/);
  bad({ facts: { ...good.facts, attachAt: null } }, /never started loading/);
  bad({ facts: { ...good.facts, stop: null } }, /did not stop the unreachable episode/);
  bad({ facts: { ...good.facts, decisionMs: 25001 } }, /25001 ms after its load/);
  bad({ facts: { ...good.facts, sounded: true } }, /reported playing/);
  bad({ after: { state: "playing", running: true } }, /after the failure the engine is playing/);
  bad({ after: null }, /dump did not answer/);
  bad({ session: { state: "PLAYING" } }, /still says PLAYING/);
  bad({ recovered: null }, /bundled episode did not play/);
  bad({ laneBefore: "js" }, /lane before the Foray was js/);
  bad({ foray: { ok: false, failures: ["the line was neither spoken nor skipped within 15000 ms"] } }, /^foray: the line was neither spoken/);
  bad({ foray: null }, /Foray half did not run/);
  bad({ copy: copyFacts("#   2 12:00:00.400 engineMode native (override)") }, /no `engineMode js \(relinquished\)` row/);
});

test("A-30 (e): the first launch is the JS leg's verdict plus the native lane and a hosting engine", () => {
  /* MUTATION: drop the lane check, or the engine check. */
  const good = { launch: { ok: true, failures: [] }, status: { lane: "native", status: { lane: "native", override: "auto" } }, service: { hosting: true, legacyRunning: false } };
  assert.equal(verdictFirstLaunch(good).ok, true);
  /* A-31: a first launch in the native lane by an override is not the stock launch. */
  assert.match(verdictFirstLaunch({ ...good, status: { lane: "native", status: { lane: "native", override: "native" } } }).failures[0], /not a stock launch/);
  assert.match(verdictFirstLaunch({ ...good, launch: { ok: false, failures: ["screencap returned no PNG"] } }).failures[0], /screencap/);
  assert.match(verdictFirstLaunch({ ...good, status: { lane: "js" } }).failures[0], /lane is js, not native/);
  assert.match(verdictFirstLaunch({ ...good, status: { error: "timeout" } }).failures[0], /could not be read: timeout/);
  assert.match(verdictFirstLaunch({ ...good, service: null }).failures[0], /service is not running/);
  assert.match(verdictFirstLaunch({ ...good, service: { hosting: false } }).failures[0], /not hosting/);
  assert.equal(parseArgs(["first-launch", "--art", "d"]).scenario, "first-launch");
  assert.equal(parseArgs(["airplane", "--art", "d"]).scenario, "airplane");
});

/* ─────────────────────────── A-40: the Foray tape's (f) ─────────────────────────── */

test("A-40 (f): the Foray is the page's build of eight click-track segments, six seams across sources and one inside one", () => {
  /* MUTATION: an https URL; a segment past its file; a bad-bounds segment (the core refuses the
     whole Foray, refused-structure); drop the same-source seam; make two ids equal. */
  const { forayId, title, items } = FORAY_SEAMS_FORAY;
  assert.equal(forayId, "a40-foray");
  assert.ok(title);
  assert.equal(items.length, 8);
  assert.equal(new Set(items.map((i) => i.id)).size, items.length, "every id once (J-4's duplicate-id)");
  for (const it of items) {
    assert.ok(it.audio_url.startsWith(ASSET_BASE), it.audio_url);
    assert.ok(CLIPS.some((c) => it.audio_url.endsWith(c.file)));
    assert.equal(it.kind, "episode");
    assert.ok(Number.isFinite(it.start_sec) && it.start_sec >= 0 && it.end_sec > it.start_sec && it.end_sec <= it.duration_sec, it.id);
    assert.equal(it.dai_suspected, false);
    assert.equal(it.needs_drift_check, false);
  }
  const same = items.slice(1).filter((it, i) => it.audio_url === items[i].audio_url).length;
  assert.equal(same, 1, "one seam inside one source (a seek, no warm)");
  assert.ok(items.some((i) => i.audio_url.endsWith(CLIPS[2].file)), "one onto the VBR track with no seek table");
});

/* Rows in the shape the Android engine writes them: a handed-over seam, a same-source one, and one a press sat in. */
const FORAY_ROWS = [
  '10 2026-09-30T00:00:00.000Z deck {"kind":"attach","token":1,"cold":"no-item"}',
  '11 2026-09-30T00:00:00.100Z deck {"kind":"time-control","token":1,"status":"playing"}',
  '12 2026-09-30T00:00:00.120Z deck {"kind":"attach","token":-1,"cold":"no-item"}',
  '13 2026-09-30T00:00:00.300Z deck {"kind":"time-control","token":-1,"status":"paused"}',
  '14 2026-09-30T00:00:08.100Z outPoint {"kind":"stop","layer":"boundary","overshootMs":4,"rate":1,"token":1}',
  '15 2026-09-30T00:00:08.101Z deck {"kind":"time-control","token":1,"status":"paused"}',
  '16 2026-09-30T00:00:08.102Z prepare {"kind":"promote","token":2}',
  '17 2026-09-30T00:00:08.603Z seam {"observedGapMs":501,"askedGapMs":500,"prepared":true,"grace":false,"bgRemainingMs":null,"stages":["attach","duration","readiness","seek","preroll","ready","play"]}',
  '18 2026-09-30T00:00:08.640Z deck {"kind":"time-control","token":2,"status":"playing"}',
  '19 2026-09-30T00:00:16.640Z outPoint {"kind":"stop","layer":"boundary","overshootMs":3,"rate":1,"token":2}',
  '20 2026-09-30T00:00:16.650Z deck {"kind":"reuse","token":3}',
  '21 2026-09-30T00:00:17.141Z seam {"observedGapMs":501,"askedGapMs":500,"prepared":false,"grace":false,"bgRemainingMs":null,"stages":["ready","play"]}',
  '22 2026-09-30T00:00:17.300Z deck {"kind":"time-control","token":3,"status":"playing"}',
  '23 2026-09-30T00:00:25.300Z outPoint {"kind":"stop","layer":"boundary","overshootMs":2,"rate":1,"token":3}',
  '24 2026-09-30T00:00:25.310Z remote {"cmd":"pause"}',
  '25 2026-09-30T00:00:26.500Z deck {"kind":"time-control","token":4,"status":"playing"}',
].map(parseEngineRow);

test("A-40 (f): a Foray seam runs from the out-point stop to the next load's first playing, with the engine's seam row beside it", () => {
  /* MUTATION: measure from the seam row (drops the beat); close a seam on the outgoing token's own
     playing; count the seam a press sat in; lose the prepared flag. */
  const seams = foraySeams(FORAY_ROWS);
  assert.equal(seams.length, 3);
  assert.deepEqual(seams.map((s) => s.gapMs), [540, 660, 1200]);
  assert.deepEqual(seams.map((s) => s.prepared), [true, false, null]);
  assert.deepEqual(seams.map((s) => s.observedGapMs), [501, 501, null]);
  assert.deepEqual(seams.map((s) => s.commanded), [false, false, true]);
  assert.deepEqual(seams.map((s) => [s.fromToken, s.toToken]), [[1, 2], [2, 3], [3, 4]]);
  assert.deepEqual(seams[0].stages.slice(-2), ["ready", "play"]);
  const st = foraySeamStats(seams);
  assert.equal(st.count, 2);
  assert.equal(st.commanded, 1);
  assert.equal(st.p95Ms, 660);
  assert.equal(st.prepared.count, 1);
  assert.equal(st.unprepared.count, 1);
});

test("A-40 (f): GATED on every seam crossed, hidden, in one process, on the pair, with p95 <= 1 s", () => {
  /* MUTATION: drop the p95 gate (a 1.2 s seam passes); pass with no handover; pass a Foray that
     stopped short or with another forayId; pass with the screen on. */
  const n = FORAY_SEAMS_FORAY.items.length;
  const seams = Array.from({ length: n - 1 }, (_, i) => ({ gapMs: 520 + i * 10, prepared: i !== 3, commanded: false }));
  const good = {
    drive: { answer: { ok: true } }, wake: "Asleep", pidBefore: "1", pidAfter: "1",
    last: { index: n - 1, forayId: FORAY_SEAMS_FORAY.forayId }, seams, pair: { active: 1, swaps: 6, available: true },
  };
  assert.equal(verdictForaySeams(good).ok, true, JSON.stringify(verdictForaySeams(good).failures));
  assert.equal(NATIVE_GATES.foraySeamP95Ms, 1000);
  const slow = seams.map((s, i) => (i === 2 ? { ...s, gapMs: 1200 } : s));
  assert.match(verdictForaySeams({ ...good, seams: slow }).failures[0], /p95 seam 1200 ms is over the 1000 ms bar/);
  assert.match(verdictForaySeams({ ...good, pair: { swaps: 0 } }).failures[0], /handed over no seam/);
  assert.match(verdictForaySeams({ ...good, last: { index: 3, forayId: "a40-foray" } }).failures[0], /stopped at item 3/);
  assert.match(verdictForaySeams({ ...good, last: { index: n - 1, forayId: null } }).failures[0], /not playing the Foray/);
  assert.match(verdictForaySeams({ ...good, wake: "Awake" }).failures[0], /screen did not go off/);
  assert.match(verdictForaySeams({ ...good, seams: seams.slice(0, 4) }).failures[0], /4 of the Foray's 7 seams/);
  assert.match(verdictForaySeams({ ...good, drive: { answer: { ok: false } } }).failures[0], /playForay did not play/);
});

test("A-40 (f): the debug driver's foray is the contract's playForay, and the service's dump says which deck plays", () => {
  /* MUTATION: build a queue load instead of playForay (the tape's structural check would be
     bypassed); drop the dump's pair or forayId; build the service with one deck or the tape off. */
  const driver = read("src/debug/java/ai/jwlabs/foura/audio/EngineDriveReceiver.java");
  assert.match(driver, /case "foray" -> \{[\s\S]*?new EngineContract\.Command\.PlayForay\(/);
  const service = read("src/main/java/ai/jwlabs/foura/audio/ForayPlaybackService.java");
  assert.match(service, /JsonNode\.member\("pair", new JsonNode\.Obj\(pm\)\)/);
  assert.match(service, /JsonNode\.member\("forayId", /);
  assert.match(service, /attach\(new ExoPlayer\.Builder\(this\)\.build\(\), new ExoPlayer\.Builder\(this\)\.build\(\)\)/,
    "the service builds the Foray tape's deck pair");
  assert.match(service, /withForayTape\(true, standby != null\)/, "the engine is built with the tape on");
});
