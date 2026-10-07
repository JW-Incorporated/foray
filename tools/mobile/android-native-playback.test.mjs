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
import { CLIPS, GATES, JS_LANE, PKG, SHOW } from "./android-playback.mjs";
import { pressDone } from "./adb.mjs";
import {
  ASSET_BASE,
  DOZE_QUEUE,
  DUMP_PREFIX,
  EPISODE_QUEUE,
  LONG_QUEUE,
  NATIVE_LANE,
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
  assert.deepEqual(SCENARIOS.map(([id]) => id), ["play", "background", "transport", "notification", "doze", "focus", "call"],
    "the card's (a)-(d), (g), (h), (i)");
  assert.match(summaryMarkdown({ play: { ok: true } }), /\| \(a\) native[^|]*\| \*\*pass\*\* \|/);
  assert.equal(parseArgs(["play", "--art", "d"]).art, "d");
  assert.throws(() => parseArgs(["seams", "--art", "d"]), /first argument/);
  assert.throws(() => parseArgs(["play"]), /--art/);
});

/* ───────────── CH2-20: one copy of the device helpers (adb.mjs), two lanes ───────────── */

test("CH2-20: a press is judged by one predicate, through each lane's view of its state", () => {
  /* One table, both lanes: the native engine's fields as they are, and the same moment as
     the page reports it (`state.foray`, the clock as `elapsedSec`). Where the lanes differ
     the row says so: the engine counts a play only once ExoPlayer sounds and a rewind only
     on the item it started on; the page has no item id and no ExoPlayer flag.
     MUTATION (run): NATIVE_LANE.press.sameItem -> `() => true` -> the "other item" row goes
     red; JS_LANE.press.settled without `!a.loading` -> the "still loading" row goes red;
     pressDone's next without `?? -2` -> the "no before" row is true for index -1. */
  const asPage = (s) => s && { foray: { running: s.running, loading: s.loading ?? false, index: s.index, elapsedSec: s.positionSec } };
  const before = S({ positionSec: 30 });
  const rows = [
    // [kind, after, native, page, why]
    ["pause", S({ running: false, exoPlaying: false, positionSec: 30 }), true, true, "paused"],
    ["pause", S({ positionSec: 31 }), false, false, "still running"],
    ["play", S({ positionSec: 30 }), true, true, "sounding"],
    ["play", S({ exoPlaying: false, positionSec: 30 }), false, true, "engine running, ExoPlayer not yet"],
    ["next", S({ index: 1, item: "a26-1", positionSec: 0.4 }), true, true, "the next item, playing"],
    ["next", S({ index: 2, item: "a26-2", positionSec: 0.4 }), false, false, "skipped two"],
    ["next", S({ index: 1, item: "a26-1", positionSec: 0 }), false, true, "the engine's clock has not moved"],
    ["next", S({ index: 1, item: "a26-1", positionSec: 0.4, loading: true }), true, false, "still loading"],
    ["previous", S({ positionSec: 2 }), true, true, "rewound"],
    ["previous", S({ positionSec: 29.5 }), false, false, "less than previousMinRewindSec"],
    ["previous", S({ item: "a26-other", positionSec: 2 }), false, true, "rewound onto another item"],
    ["previous", S({ running: false, positionSec: 2 }), false, false, "rewound but stopped"],
    ["previous", null, false, false, "no state"],
  ];
  for (const [kind, after, native, page, why] of rows) {
    assert.equal(pressDone(kind, before, NATIVE_LANE.press, GATES.previousMinRewindSec)(after), native, `native ${kind}: ${why}`);
    assert.equal(pressDone(kind, asPage(before), JS_LANE.press, GATES.previousMinRewindSec)(asPage(after)), page, `page ${kind}: ${why}`);
  }
  assert.equal(pressDone("next", null, NATIVE_LANE.press, 1)(S({ index: -1, positionSec: 1 })), true, "no before: the next of index -2");
  assert.equal(pressDone("previous", null, NATIVE_LANE.press, 1)(S({ positionSec: 1 })), false, "no before: nothing to rewind from");
  assert.equal(NATIVE_LANE.isPaused(S({ running: false })), true);
  assert.equal(NATIVE_LANE.isPaused(null), false);
  assert.equal(JS_LANE.isPaused({ episodePlaying: false }), true);
});

test("CH2-20: neither lane keeps its own copy of the device helpers", () => {
  /* The acceptance's `comm -12` over the two runners' top-level declarations: what both
     declare is only each lane's own scenarios, verdicts and CLI, never a helper adb.mjs owns.
     MUTATION (run): paste `async function dumpUi(ctx, name) {…}` back into
     android-native-playback.mjs -> listed here. */
  const src = (f) => fs.readFileSync(path.join(ROOT, "tools", "mobile", f), "utf8");
  const declared = (text) => new Set([...text.matchAll(/^(?:export )?(?:async )?(?:function|const|let) (\w+)/gm)].map((m) => m[1]));
  const js = declared(src("android-playback.mjs"));
  const native = declared(src("android-native-playback.mjs"));
  const shared = ["adb", "sleep", "num", "pidOf", "killLine", "pngInfo", "PKG", "pressDone",
    "shell", "save", "dumpTo", "wakeAndUnlock", "killReason", "waitFor", "window2", "dumpUi", "readShade", "helperLog"];
  for (const name of shared) {
    assert.equal(js.has(name), false, `android-playback.mjs declares its own ${name}`);
    assert.equal(native.has(name), false, `android-native-playback.mjs declares its own ${name}`);
  }
  const both = [...js].filter((n) => native.has(n)).sort();
  assert.deepEqual(both, ["RUNNERS", "SCENARIOS", "SERVICE", "background", "call", "collect", "doze", "ensureRunning", "focus",
    "focusPhase", "main", "notification", "parseArgs", "play", "prepare", "press", "summary", "summaryMarkdown", "transport",
    "verdictBackground", "verdictCall", "verdictDoze", "verdictFocus", "verdictNotification", "verdictPlay", "verdictPress"],
    "each lane's own scenarios, verdicts and CLI: a new shared name is a helper that belongs in adb.mjs");
  for (const text of [src("android-playback.mjs"), src("android-native-playback.mjs")]) {
    assert.match(text, /\} = ?\n? *device\(\{ lane: (JS|NATIVE)_LANE, gates: GATES, helperTag: HELPER_TAG \}\);/);
  }
});
