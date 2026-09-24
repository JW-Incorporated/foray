/* The page's engine client (player/native-engine.js; plan §4.6, §5; NE-21).

   What is pinned here, each with the one-line mutation that turns it red:
     - the handshake: native only on a timely, well-formed, native, same-protocol
       hello; a hung, rejected or mismatched one resolves JS AND sends
       relinquish{cap: "all"} before resolving; an older binary (UNIMPLEMENTED)
       or a legacy answer resolves JS with nothing to relinquish;
     - snapshot ordering by (seq, capturedAtMonotonicMs), and coalescing of a
       burst into one notification;
     - validation: an invalid snapshot or event is never believed;
     - send never rejects;
     - extrapolation from the page's own receipt time, clamped and frozen.

   THE FAKE BRIDGE IS NO MORE FORGIVING THAN THE REAL ONE (CLAUDE.md, "a green
   test is not evidence until you have broken it"): replies are JSON copies, a
   hello can hang forever or reject, events arrive on their own turn. The
   integration tests run the same client over parity/reference-engine.js, the real
   manager behind protocol v1. */

import test from "node:test";
import assert from "node:assert/strict";

import {
  createNativeEngine, HELLO_TIMEOUT_MS, BRIDGE_ERROR, snapshotOrder, isUnimplemented, ENGINE_PLUGIN,
} from "./native-engine.js";
import { validateContract, contractSchemaDocument } from "./engine-contract.js";
import { ReferenceEngine } from "./parity/reference-engine.js";
import { manualScheduler, tick } from "./parity/fakes.js";

/* ---------- a scriptable bridge ---------- */

const SNAP = contractSchemaDocument().$defs.snapshot["x-examples"].valid;

/** A snapshot like the contract's `playing` example, overridden. */
const snap = (over = {}) => ({ ...SNAP.playing, ...over });

/**
 * A `window.Capacitor` whose ForayAudio answers are scripted.
 *   hello: a value, a function returning a promise, or "hang" / "reject" / "unimplemented"
 */
function fakeCapacitor({ platform = "ios", hello = null, sendReply = null, readReply = null } = {}) {
  const calls = [];
  const listeners = new Set();
  const cap = {
    calls,
    getPlatform: () => platform,
    isPluginAvailable: (n) => n === ENGINE_PLUGIN,
    nativePromise(plugin, method, payload) {
      calls.push({ method, payload: JSON.parse(JSON.stringify(payload)) });
      if (method === "engineHello") {
        if (hello === "hang") return new Promise(() => {});
        if (hello === "reject") return Promise.reject(new Error("the plugin crashed"));
        if (hello === "unimplemented") return Promise.reject(Object.assign(new Error("not implemented"), { code: "UNIMPLEMENTED" }));
        return Promise.resolve(JSON.parse(JSON.stringify(hello)));
      }
      if (method === "engineSend") {
        const r = typeof sendReply === "function" ? sendReply(payload) : sendReply;
        if (r instanceof Error) return Promise.reject(r);
        return Promise.resolve(JSON.parse(JSON.stringify(r ?? { ok: true, snapshot: SNAP.idle })));
      }
      if (method === "engineRead") return Promise.resolve(JSON.parse(JSON.stringify(readReply ?? SNAP.idle)));
      return Promise.reject(new Error("unknown method"));
    },
    addListener(plugin, event, fn) {
      listeners.add(fn);
      return { remove: () => listeners.delete(fn) };
    },
    /** The engine notifies: on its own turn, as a JSON copy. */
    emit(ev) { for (const fn of [...listeners]) queueMicrotask(() => fn(JSON.parse(JSON.stringify(ev)))); },
    sends: () => calls.filter((c) => c.method === "engineSend").map((c) => c.payload),
  };
  return cap;
}

const nativeHello = (over = {}) => ({
  mode: "native", reason: "build-default", engineVersion: "1.0.0", protocol: 1,
  capabilities: ["episode"], ownedKeyPrefixes: ["cp_pos:", "cp_foray:", "cp_last_episode"],
  snapshot: SNAP.idle, pendingAdvances: [], pendingEvents: [], ...over,
});

/* ---------- the handshake ---------- */

test("a native hello on our protocol, in time, is native mode, and its snapshot becomes the page's belief", async () => {
  // MUTATION: in hello(), skip `accept(answer.snapshot, "hello")` -> latest() is null.
  const cap = fakeCapacitor({ hello: nativeHello({ snapshot: snap({ seq: 3 }) }) });
  const eng = createNativeEngine({ capacitor: cap, pageBuild: "2026.09.24-1", scheduler: manualScheduler() });
  const d = await eng.engineModeReady;
  assert.equal(d.mode, "native");
  assert.equal(d.reason, "native");
  assert.equal(eng.mode, "native");
  assert.equal(eng.latest().snapshot.seq, 3);
  assert.deepStrictEqual(cap.calls[0], { method: "engineHello", payload: { pageBuild: "2026.09.24-1", protocol: 1 } });
  assert.deepStrictEqual(cap.sends(), [], "a native answer relinquishes nothing");
  assert.strictEqual(eng.engineModeReady, eng.hello(), "one handshake per page, however often it is asked");
});

test("a hello that never answers resolves 'js' at 5 s, and relinquish{cap:'all'} has left the page first", async () => {
  // MUTATION: drop the `send(HANDSHAKE_RELINQUISH...)` in hello() -> no relinquish;
  // MUTATION: HELLO_TIMEOUT_MS = 6000 -> still pending at 5 s.
  assert.equal(HELLO_TIMEOUT_MS, 5000);
  const sched = manualScheduler();
  const cap = fakeCapacitor({ hello: "hang" });
  const eng = createNativeEngine({ capacitor: cap, scheduler: sched });
  let settled = null;
  const order = [];
  eng.engineModeReady.then((d) => { settled = d; order.push("resolved"); });
  const origSend = cap.nativePromise;
  cap.nativePromise = (p, m, a) => { if (m === "engineSend") order.push(`send:${a.cmd}`); return origSend.call(cap, p, m, a); };

  await sched.advance(4999);
  assert.equal(settled, null, "still waiting one millisecond before the bound");
  await sched.advance(1);
  await tick();
  assert.equal(settled?.mode, "js");
  assert.equal(settled.reason, "no-hello");
  const rel = cap.sends().find((s) => s.cmd === "relinquish");
  assert.ok(rel, "a relinquish was sent");
  assert.deepStrictEqual(rel.args, { cap: "all" });
  assert.ok(validateContract("sendRequest", rel).ok, "the relinquish is a well-formed engineSend");
  assert.deepStrictEqual(order, ["send:relinquish", "resolved"], "the relinquish leaves before the page may build audio");
});

test("a REJECTED hello resolves 'js' with a relinquish; an UNIMPLEMENTED one (an older binary) resolves 'js' without", async () => {
  // MUTATION: treat every rejection as isUnimplemented -> the first case sends no relinquish.
  const crashed = fakeCapacitor({ hello: "reject" });
  const a = await createNativeEngine({ capacitor: crashed, scheduler: manualScheduler() }).engineModeReady;
  assert.deepStrictEqual([a.mode, a.reason], ["js", "no-hello"]);
  assert.equal(crashed.sends().filter((s) => s.cmd === "relinquish").length, 1);

  const old = fakeCapacitor({ hello: "unimplemented" });
  const b = await createNativeEngine({ capacitor: old, scheduler: manualScheduler() }).engineModeReady;
  assert.deepStrictEqual([b.mode, b.reason], ["js", "no-method"]);
  assert.deepStrictEqual(old.sends(), [], "nothing native can be running on a binary without the method");
  assert.ok(isUnimplemented({ code: "UNIMPLEMENTED" }));
  assert.ok(!isUnimplemented(new Error("the plugin crashed")));
});

test("a protocol mismatch or an unreadable hello relinquishes; a clear legacy answer does not", async () => {
  // MUTATION: in decideMode, return relinquish false for protocol-mismatch -> red here.
  const cases = [
    [nativeHello({ protocol: 2 }), "protocol-mismatch", 1],
    [{ mode: "native", reason: "build-default" }, "bad-hello", 1],
    [{ mode: "legacy", reason: "not-built" }, "engine-legacy", 0],
  ];
  for (const [hello, reason, relinquishes] of cases) {
    const cap = fakeCapacitor({ hello });
    const d = await createNativeEngine({ capacitor: cap, scheduler: manualScheduler() }).engineModeReady;
    assert.deepStrictEqual([d.mode, d.reason], ["js", reason]);
    assert.equal(cap.sends().filter((s) => s.cmd === "relinquish").length, relinquishes, reason);
  }
});

test("off iOS, or with no plugin, no hello is attempted at all", async () => {
  for (const capacitor of [fakeCapacitor({ platform: "android" }), fakeCapacitor({ platform: "web" }), null]) {
    const d = await createNativeEngine({ capacitor, scheduler: manualScheduler() }).engineModeReady;
    assert.equal(d.mode, "js");
    if (capacitor) assert.deepStrictEqual(capacitor.calls, []);
  }
});

test("against the reference engine: native, then a protocol-2 engine is refused with a relinquish it honours", async () => {
  const ok = new ReferenceEngine({ scheduler: manualScheduler() });
  const d = await createNativeEngine({ capacitor: ok.asCapacitor(), scheduler: ok.scheduler }).engineModeReady;
  assert.equal(d.mode, "native");
  assert.equal(d.hello.engineVersion, "reference-1");
  ok.dispose();

  const newer = new ReferenceEngine({ protocol: 2, scheduler: manualScheduler() });
  const e = await createNativeEngine({ capacitor: newer.asCapacitor(), scheduler: newer.scheduler }).engineModeReady;
  assert.deepStrictEqual([e.mode, e.reason], ["js", "protocol-mismatch"]);
  await newer._queue;
  await tick();
  assert.equal(newer.relinquished, true, "the engine received the relinquish and went terminal");
  assert.equal(newer.session, "relinquished");
  newer.dispose();
});

/* ---------- snapshots: order, validation, coalescing ---------- */

test("an OLDER snapshot never replaces a newer one: a reply that crossed an event is dropped", async () => {
  // MUTATION: in accept(), drop the snapshotOrder check -> the seq-4 reply wins.
  const cap = fakeCapacitor({ hello: nativeHello({ snapshot: snap({ seq: 1 }) }), sendReply: { ok: true, snapshot: snap({ seq: 4, state: "interrupted", running: false, wasPlaying: true, effectiveRate: 0 }) } });
  const eng = createNativeEngine({ capacitor: cap, scheduler: manualScheduler() });
  await eng.engineModeReady;
  cap.emit({ type: "snapshot", snapshot: snap({ seq: 5 }) });
  await tick();
  assert.equal(eng.latest().snapshot.seq, 5);
  await eng.send("pause");
  assert.equal(eng.latest().snapshot.seq, 5, "the reply carried seq 4 and lost");
  assert.equal(eng.latest().snapshot.state, "playing");
  assert.equal(eng.stats.stale, 1);
});

test("the same seq read again LATER is newer (a fresher position); the same capture twice is not", async () => {
  // MUTATION: order by seq alone in snapshotOrder -> the later capture is dropped.
  assert.equal(snapshotOrder({ seq: 2, capturedAtMonotonicMs: 10 }, { seq: 2, capturedAtMonotonicMs: 20 }), -1);
  assert.equal(snapshotOrder({ seq: 3, capturedAtMonotonicMs: 1 }, { seq: 2, capturedAtMonotonicMs: 99 }), 1);
  assert.equal(snapshotOrder({ seq: 2, capturedAtMonotonicMs: 10 }, { seq: 2, capturedAtMonotonicMs: 10 }), 0);
  const cap = fakeCapacitor({ hello: nativeHello({ snapshot: snap({ seq: 2, capturedAtMonotonicMs: 1000, positionSec: 10 }) }) });
  const eng = createNativeEngine({ capacitor: cap, scheduler: manualScheduler() });
  await eng.engineModeReady;
  cap.emit({ type: "snapshot", snapshot: snap({ seq: 2, capturedAtMonotonicMs: 2000, positionSec: 11.5 }) });
  cap.emit({ type: "snapshot", snapshot: snap({ seq: 2, capturedAtMonotonicMs: 2000, positionSec: 99 }) });
  await tick();
  assert.equal(eng.latest().snapshot.positionSec, 11.5);
});

test("a burst of snapshots in one turn reaches a subscriber ONCE, with the latest", async () => {
  // MUTATION: in accept(), call the subscribers synchronously instead of
  // scheduleNotify() -> three notifications.
  const cap = fakeCapacitor({ hello: nativeHello() });
  const eng = createNativeEngine({ capacitor: cap, scheduler: manualScheduler() });
  await eng.engineModeReady;
  await tick();
  const heard = [];
  eng.subscribe((ev) => heard.push(ev));
  for (const seq of [7, 8, 9]) cap.emit({ type: "snapshot", snapshot: snap({ seq }) });
  await tick();
  const snaps = heard.filter((e) => e.type === "snapshot");
  assert.equal(snaps.length, 1, JSON.stringify(heard.map((e) => e.type)));
  assert.equal(snaps[0].snapshot.seq, 9);
  assert.equal(typeof snaps[0].receivedAtMs, "number");
});

test("non-snapshot events keep their order, and follow the snapshot that arrived with them", async () => {
  const cap = fakeCapacitor({ hello: nativeHello() });
  const eng = createNativeEngine({ capacitor: cap, scheduler: manualScheduler() });
  await eng.engineModeReady;
  await tick();
  const heard = [];
  eng.subscribe((ev) => heard.push(ev.type));
  cap.emit({ type: "advanced", hop: { planSeq: 1, hopSeq: 1, nextId: "b" } });
  cap.emit({ type: "snapshot", snapshot: snap({ seq: 11 }) });
  cap.emit({ type: "error", code: "chain-start" });
  await tick();
  assert.deepStrictEqual(heard, ["snapshot", "advanced", "error"]);
});

test("an invalid snapshot or event is never believed", async () => {
  // MUTATION: skip validateContract("event") in onEvent() -> the "tick" and
  // code-less "error" events reach the subscriber.
  const cap = fakeCapacitor({ hello: nativeHello({ snapshot: snap({ seq: 1 }) }) });
  const eng = createNativeEngine({ capacitor: cap, scheduler: manualScheduler() });
  await eng.engineModeReady;
  await tick();
  const heard = [];
  eng.subscribe((ev) => heard.push(ev.type));
  cap.emit({ type: "snapshot", snapshot: { ...snap({ seq: 50 }), v: 2 } });
  cap.emit({ type: "snapshot", snapshot: snap({ seq: 51, state: "paused" }) });
  cap.emit({ type: "tick" });
  cap.emit({ type: "error" });
  await tick();
  assert.equal(eng.latest().snapshot.seq, 1);
  assert.deepStrictEqual(heard, []);
  // The event schema carries the snapshot's, so a bad snapshot event is refused
  // as an EVENT before accept() ever sees it — and accept() refuses it again
  // for a reply or a read (the next assertion).
  assert.equal(eng.stats.invalidEvents, 4);
  await eng.read("snapshot");
  assert.equal(eng.latest().snapshot.seq, 1);
});

test("an invalid snapshot in a READ is refused by accept() itself", async () => {
  // MUTATION: skip validateSnapshot in accept() -> the v:2 read becomes current.
  const cap = fakeCapacitor({ hello: nativeHello({ snapshot: snap({ seq: 1 }) }), readReply: { ...snap({ seq: 50 }), v: 2 } });
  const eng = createNativeEngine({ capacitor: cap, scheduler: manualScheduler() });
  await eng.engineModeReady;
  assert.equal(await eng.read("snapshot"), null);
  assert.equal(eng.latest().snapshot.seq, 1);
  assert.equal(eng.stats.invalid, 1);
});

/* ---------- send and read never reject ---------- */

test("send never rejects: a throwing bridge answers bridge-error, a payload the contract refuses never crosses", async () => {
  // MUTATION: remove the try/catch around bridge.call in send() -> this rejects.
  const cap = fakeCapacitor({ hello: nativeHello({ snapshot: snap({ seq: 1 }) }), sendReply: () => new Error("bridge gone") });
  const eng = createNativeEngine({ capacitor: cap, scheduler: manualScheduler() });
  await eng.engineModeReady;
  const r = await eng.send("pause");
  assert.deepStrictEqual([r.ok, r.reason, r.local], [false, BRIDGE_ERROR, true]);
  assert.equal(r.snapshot.seq, 1, "the reply carries the page's current belief");

  const before = cap.sends().length;
  const bad = await eng.send("relinquish", { cap: "everything" });
  assert.deepStrictEqual([bad.ok, bad.reason, bad.local], [false, "unknown-cmd", true]);
  assert.equal(cap.sends().length, before, "the malformed command never reached the bridge");
});

test("every send carries v:1, the next cmdSeq, the source and the page's wall time", async () => {
  // MUTATION: `cmdSeq: cmdSeq++` (post-increment) -> the first command is 0.
  const cap = fakeCapacitor({ hello: nativeHello() });
  const eng = createNativeEngine({ capacitor: cap, scheduler: manualScheduler(), now: () => 1790000000000 });
  await eng.send("play", undefined, { source: "remote" });
  await eng.send("seekBy", { deltaSec: -15 });
  const [a, b] = cap.sends();
  assert.deepStrictEqual(a, { v: 1, cmdSeq: 1, cmd: "play", source: "remote", issuedAtWallMs: 1790000000000 });
  assert.deepStrictEqual(b, { v: 1, cmdSeq: 2, cmd: "seekBy", source: "tap", issuedAtWallMs: 1790000000000, args: { deltaSec: -15 } });
});

test("a read answers the page's current belief: never an older reply, null for an unreadable one", async () => {
  const cap = fakeCapacitor({ hello: nativeHello({ snapshot: snap({ seq: 6 }) }), readReply: snap({ seq: 4 }) });
  const eng = createNativeEngine({ capacitor: cap, scheduler: manualScheduler() });
  await eng.engineModeReady;
  assert.equal((await eng.read("snapshot")).seq, 6, "the stale read lost to what the page already held");
  const junk = createNativeEngine({ capacitor: fakeCapacitor({ readReply: { rows: 3 } }), scheduler: manualScheduler() });
  assert.equal(await junk.read("rows"), null);
});

/* ---------- where the playhead is ---------- */

test("positionAt extrapolates from the PAGE's receipt time, clamps to the duration, and freezes when nothing flows", async () => {
  // MUTATION: in extrapolate(), use capturedAtWallMs instead of receivedAtMs ->
  // the page's clock minus the engine's is garbage and the first assert fails.
  let pageNow = 5_000;
  const start = snap({ seq: 1, positionSec: 100, durationSec: 110, effectiveRate: 1.5, capturedAtWallMs: 1 });
  const cap = fakeCapacitor({ hello: nativeHello({ snapshot: start }) });
  const eng = createNativeEngine({ capacitor: cap, scheduler: manualScheduler(), now: () => pageNow });
  await eng.engineModeReady;
  pageNow += 2_000;
  assert.equal(eng.positionAt(), 103, "2 s at 1.5x from the moment the page received it");
  pageNow += 60_000;
  assert.equal(eng.positionAt(), 110, "clamped to the duration");
  assert.equal(eng.positionAt(4_000), 100, "a clock that went backwards counts as no time");
  for (const [over, why] of [[{ running: false }, "paused"], [{ inSeamGap: true }, "seam beat"], [{ buffering: true }, "stall"]]) {
    cap.emit({ type: "snapshot", snapshot: { ...start, seq: eng.latest().snapshot.seq + 1, ...over } });
    await tick();
    pageNow += 3_000;
    assert.equal(eng.positionAt(), 100, `frozen while ${why}`);
  }
});

/* ---------- visibility ---------- */

test("setVisible tells the engine, and coming back READS the snapshot instead of waiting for an event", async () => {
  // MUTATION: drop `if (visible) await read("snapshot")` -> the read never happens.
  const cap = fakeCapacitor({ hello: nativeHello({ snapshot: snap({ seq: 1 }) }), readReply: snap({ seq: 9 }) });
  const eng = createNativeEngine({ capacitor: cap, scheduler: manualScheduler() });
  await eng.engineModeReady;
  const heard = [];
  eng.subscribe((ev) => heard.push(ev.type === "visibility" ? `visibility:${ev.visible}` : ev.type));
  await eng.setVisible(false);
  assert.equal(eng.visible, false);
  assert.equal(cap.calls.filter((c) => c.method === "engineRead").length, 0);
  await eng.setVisible(true);
  await tick();
  assert.deepStrictEqual(cap.sends().map((s) => [s.cmd, s.args.visible]), [["setPageVisible", false], ["setPageVisible", true]]);
  assert.equal(cap.calls.filter((c) => c.method === "engineRead").length, 1);
  assert.equal(eng.latest().snapshot.seq, 9);
  assert.ok(heard.includes("visibility:false") && heard.includes("visibility:true"));
});

/* ---------- the name that crosses the bridge ---------- */

test("the client calls the plugin the Swift side registers, and engineHello is one of its methods", async () => {
  // If ENGINE_PLUGIN and the Swift jsName disagree, every nativePromise answers
  // "plugin not implemented", the page reads that as an older binary
  // (no-method), and the native engine is silently never used — every test
  // above stays green. MUTATION: ENGINE_PLUGIN = "ForayEngine" -> red.
  // engineSend / engineRead join this pin when NE-20 declares them (its own
  // shell-invariants pin checks all three against BRIDGE_METHODS).
  const fs = await import("node:fs");
  const swift = fs.readFileSync(new URL("../mobile/plugins/foray-audio/ios/Sources/ForayAudioPlugin/ForayAudioPlugin.swift", import.meta.url), "utf8");
  assert.equal(/public\s+let\s+jsName\s*=\s*"([^"]+)"/.exec(swift)?.[1], ENGINE_PLUGIN);
  assert.match(swift, /CAPPluginMethod\(name:\s*"engineHello"/);
});
