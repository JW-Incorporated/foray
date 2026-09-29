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
  DOZE_QUEUE,
  DUMP_PREFIX,
  EPISODE_QUEUE,
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

test("A-26 (h): a transient loss must pause and resume; a permanent one must pause", () => {
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
  assert.deepEqual(SCENARIOS.map(([id]) => id), ["play", "background", "transport", "notification", "doze", "focus", "call"],
    "the card's (a)-(d), (g), (h), (i)");
  assert.match(summaryMarkdown({ play: { ok: true } }), /\| \(a\) native[^|]*\| \*\*pass\*\* \|/);
  assert.equal(parseArgs(["play", "--art", "d"]).art, "d");
  assert.throws(() => parseArgs(["seams", "--art", "d"]), /first argument/);
  assert.throws(() => parseArgs(["play"]), /--art/);
});
