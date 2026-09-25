/* The reference engine (player/parity/reference-engine.js; plan §5.6, §6; NE-21):
   protocol v1 over the real PlayerQueueManager, with the warm handover on.

   What is pinned here, each with its killing mutation:
     - it passes the CONTRACT family: every valid example it is sent gets a
       well-formed answer, every invalid one `unknown-cmd`, every event it
       emits validates — the same accept/reject table the Swift engine is held
       to (engine-contract.js's x-examples);
     - events: none while hidden, one snapshot on visible, at most one per
       second while visible, latest winning (NE-20's acceptance, on the JS side);
     - the warm handover: the next segment is prepared while the current one is
       audible, and with the n.* tokens stripped the op log is exactly the
       plain backend's — the handover changes when, never what;
     - the session: no audible command behind a failed activation;
     - relinquish is terminal;
     - the continuation walk and the owned rows. */

import test from "node:test";
import assert from "node:assert/strict";

import { ReferenceEngine, WarmingBackend, SNAPSHOT_EVENT_MIN_MS } from "./reference-engine.js";
import { contractSchemaDocument, validateContract, OWNED_PREFIXES } from "../engine-contract.js";
import { continuationPlan } from "../continuation.js";
import { NATIVE_TOKEN_PREFIX } from "./compare.js";
import { OpLog, FakeBackend, manualScheduler, tick } from "./fakes.js";
import { PlayerQueueManager } from "../queue-manager.js";

const EXAMPLES = Object.fromEntries(
  Object.entries(contractSchemaDocument().$defs).filter(([, d]) => d["x-examples"]).map(([k, d]) => [k, d["x-examples"]]),
);

const episode = (id, extra = {}) => ({
  id, kind: "episode", title: `Title ${id}`, show: `Show ${id}`,
  audio_url: `https://cdn.test/${id}.mp3`, duration_sec: 3600, ...extra,
});

let seq = 0;
const send = (eng, cmd, args, source = "tap") =>
  eng.engineSend({ v: 1, cmdSeq: ++seq, cmd, source, ...(args ? { args } : {}) });

function engine(opts = {}) {
  const scheduler = opts.scheduler ?? manualScheduler();
  const eng = new ReferenceEngine({ scheduler, now: () => 1790000000000, ...opts });
  const events = [];
  eng.addListener((ev) => events.push(ev));
  return { eng, scheduler, events };
}

const playEpisode = (eng, item, extra = {}) =>
  send(eng, "playEpisode", { item, lastEpisodeRow: { id: item.id, title: item.title }, ...extra });

/* ---------- the contract family ---------- */

test("the reference engine passes the contract family: every example is answered in contract", async () => {
  // MUTATION: in _body(), drop `v: PROTOCOL` -> every snapshot fails the schema.
  // MUTATION: in _send(), skip the sendRequest validation -> the invalid
  // examples are executed instead of refused with unknown-cmd.
  const { eng, events } = engine({ capabilities: ["episode", "continuation", "restore", "foray"] });
  const hello = await eng.engineHello(EXAMPLES.helloRequest.valid["page-v1"]);
  assert.ok(validateContract("helloResponse", hello).ok, JSON.stringify(validateContract("helloResponse", hello).errors));
  assert.equal(hello.mode, "native");
  assert.deepStrictEqual(hello.ownedKeyPrefixes, [...OWNED_PREFIXES]);

  for (const [name, req] of Object.entries(EXAMPLES.sendRequest.valid)) {
    const reply = await eng.engineSend(req);
    const v = validateContract("sendResponse", reply);
    assert.ok(v.ok, `${name}: ${v.errors.join("; ")}`);
  }
  // A fresh engine for the refusals: the valid examples above relinquished it.
  const { eng: fresh } = engine();
  for (const [name, req] of Object.entries(EXAMPLES.sendRequest.invalid)) {
    const reply = await fresh.engineSend(req);
    assert.equal(reply.ok, false, name);
    assert.equal(reply.reason, "unknown-cmd", name);
    assert.ok(validateContract("sendResponse", reply).ok, name);
  }
  for (const [name, req] of Object.entries(EXAMPLES.readRequest.valid)) {
    const reply = await fresh.engineRead(req);
    const kind = req.what === "snapshot" ? "snapshot" : req.what === "rows" ? "rowsResponse" : "diagnosticsResponse";
    assert.ok(validateContract(kind, reply).ok, name);
  }
  assert.deepStrictEqual(await fresh.engineRead(EXAMPLES.readRequest.invalid["rows-unowned-prefix"]), { rows: {} },
    "an unowned prefix reads nothing, never something");
  await tick();
  assert.ok(events.length > 0, "the session above emitted events");
  for (const ev of events) assert.ok(validateContract("event", ev).ok, JSON.stringify(ev));

  const legacy = new ReferenceEngine({ mode: "legacy", reason: "not-built", scheduler: manualScheduler() });
  assert.ok(validateContract("helloResponse", await legacy.engineHello({ pageBuild: "", protocol: 1 })).ok);
  for (const e of [eng, fresh, legacy]) e.dispose();
});

/* ---------- events ---------- */

test("1,000 transitions while hidden emit ZERO events, and one snapshot on visible", async () => {
  // MUTATION: in _pump(), drop the `!this.visible` guard -> the first transition emits.
  const { eng, scheduler, events } = engine();
  await send(eng, "setPageVisible", { visible: false });
  await playEpisode(eng, episode("a"));
  await tick();
  events.length = 0;
  // Time passes too — 10 s of it — so a coalescing window cannot be what
  // keeps the hidden page quiet.
  for (let i = 1; i <= 1000; i++) {
    await eng.deck("time", i);
    if (i % 100 === 0) await scheduler.advance(SNAPSHOT_EVENT_MIN_MS);
  }
  await tick();
  assert.equal(events.length, 0, `${events.length} events while hidden`);
  await send(eng, "setPageVisible", { visible: true });
  await tick();
  assert.deepStrictEqual(events.map((e) => e.type), ["snapshot"]);
  assert.equal(events[0].snapshot.positionSec, 1000, "the one snapshot is the latest");
  eng.dispose();
});

test("while visible, snapshot events are coalesced to one a second, the latest winning", async () => {
  // MUTATION: in _pump(), skip `this._coalescing = true` -> one event per transition.
  const { eng, scheduler, events } = engine();
  await playEpisode(eng, episode("a"));
  await tick();
  events.length = 0;
  await scheduler.advance(SNAPSHOT_EVENT_MIN_MS);
  for (let i = 1; i <= 50; i++) await eng.deck("time", i);
  await tick();
  assert.equal(events.length, 1, "the first transition goes at once");
  await scheduler.advance(SNAPSHOT_EVENT_MIN_MS - 1);
  await tick();
  assert.equal(events.length, 1, "nothing more inside the second");
  await scheduler.advance(1);
  await tick();
  assert.equal(events.length, 2);
  assert.equal(events[1].snapshot.positionSec, 50);
  assert.equal(SNAPSHOT_EVENT_MIN_MS, 1000);
  eng.dispose();
});

/* ---------- the warm handover ---------- */

const seg = (id, url, start, end) => ({ type: "segment", id, audio_url: url, start_sec: start, end_sec: end, duration_sec: 3600 });
const FORAY = [
  seg("s0", "https://cdn.test/a.mp3", 100, 200),
  seg("s1", "https://cdn.test/b.mp3", 300, 400),
  seg("s2", "https://cdn.test/c.mp3", 500, 600),
];

async function playThroughTwoSeams(eng, scheduler) {
  await send(eng, "playForay", {
    forayId: "f1", title: "A Foray", items: FORAY, buildReport: {}, isLocalFile: false, allowAdPad: false, voiceId: null,
  });
  for (let n = 0; n < 2; n++) {
    await eng.deck("window");
    await eng.deck("ended", "outPoint");
    await scheduler.advance(2000);
    await eng.deck("time", 0);
  }
}

test("warm handover ON: the next segment is prepared while the current one is audible, at its in-point", async () => {
  // MUTATION: delete WarmingBackend.prefetch -> the manager wires no window and
  // no n.prepare / n.handover token is ever written.
  const { eng, scheduler } = engine({ capabilities: ["foray"] });
  await playThroughTwoSeams(eng, scheduler);
  const native = eng.log.ops.filter((o) => o.startsWith("n."));
  assert.deepStrictEqual(native, ["n.prepare:f1#1@300", "n.handover:f1#1@300", "n.prepare:f1#2@500", "n.handover:f1#2@500"]);
  const i = eng.log.ops.indexOf("n.handover:f1#1@300");
  assert.equal(eng.log.ops[i + 1], "load:f1#1@300", "the handover is the load of the SAME item at the SAME offset");
  eng.dispose();
});

test("the handover changes WHEN, never WHAT: stripped of n.* the op log is the plain backend's", async () => {
  // MUTATION: in WarmingBackend.load, skip `super.load` when warm (a handover
  // with no load token) -> the stripped logs differ.
  const { eng, scheduler } = engine({ capabilities: ["foray"] });
  await playThroughTwoSeams(eng, scheduler);

  // The same seams on the plain FakeBackend (no prefetch, so no window).
  const log = new OpLog();
  const plain = new FakeBackend({ log });
  const sched2 = manualScheduler();
  const m = new PlayerQueueManager({ backend: plain, scheduler: sched2, allowMultiple: true });
  m.setQueueFromForay({ id: "f1", title: "A Foray", items: FORAY }, {});
  await m.play(0);
  for (let n = 0; n < 2; n++) {
    // Floated, as deck() floats it: the beat holds the handler on the clock.
    Promise.resolve(plain.onItemEnded("outPoint")).catch(() => {});
    await tick();
    await sched2.advance(2000);
    plain.currentTime = 0;
  }
  assert.deepStrictEqual(eng.log.ops.filter((o) => !o.startsWith(NATIVE_TOKEN_PREFIX)), log.ops);
  m.dispose();
  eng.dispose();
});

test("WarmingBackend opens the window only while audible with an armed out-point, and warms an item once", () => {
  const log = new OpLog();
  const b = new WarmingBackend({ log });
  let opened = 0;
  b.onPrefetchWindow = () => opened++;
  assert.equal(b.openPrefetchWindow(), false, "no out-point armed");
  b.setOutPoint(200);
  assert.equal(b.openPrefetchWindow(), false, "paused: a silent page is the throttled state");
  b.play();
  assert.equal(b.openPrefetchWindow(), true);
  assert.equal(opened, 1);
  b.prefetch({ id: "x", audio_url: "https://cdn.test/x.mp3" }, { startOffset: 300 });
  b.prefetch({ id: "x", audio_url: "https://cdn.test/x.mp3" }, { startOffset: 300 });
  assert.deepStrictEqual(log.ops.filter((o) => o.startsWith("n.")), ["n.prepare:x@300"]);
});

/* ---------- the session ---------- */

test("a failed activation refuses the play with its token, and NO audible command follows", async () => {
  // MUTATION: in playEpisode, ignore `_ensureSession`'s answer -> the backend
  // logs load and play with the session inactive.
  const { eng } = engine({ activation: () => ({ ok: false, token: "cannot-interrupt-others" }) });
  const r = await playEpisode(eng, episode("a"));
  assert.deepStrictEqual([r.ok, r.reason], [false, "session-failed:cannot-interrupt-others"]);
  assert.equal(r.snapshot.session, "inactive");
  assert.ok(!eng.log.ops.includes("play"), eng.log.ops.join(","));
  eng.dispose();
});

test("a session is activated once for a user play, and a pause keeps it under the default hold", async () => {
  let activations = 0;
  const { eng } = engine({ activation: () => { activations++; return { ok: true }; } });
  await playEpisode(eng, episode("a"));
  await send(eng, "pause");
  const r = await send(eng, "play");
  assert.equal(activations, 1, "S-5: an active session is not re-activated per press");
  assert.equal(r.snapshot.session, "active");
  assert.equal(r.snapshot.state, "playing");
  eng.dispose();
});

test("audition is refused with engine-busy while running, and speaks through an activation while paused", async () => {
  // MUTATION: drop the `_running()` check in audition -> the first answer is ok.
  const { eng } = engine();
  await playEpisode(eng, episode("a"));
  const busy = await send(eng, "audition", { text: "Hello", voiceId: null });
  assert.deepStrictEqual([busy.ok, busy.reason], [false, "engine-busy"]);
  await send(eng, "pause");
  const ok = await send(eng, "audition", { text: "Hello", voiceId: "v1" });
  assert.equal(ok.ok, true);
  assert.ok(eng.log.ops.includes("tts.speak:Hello@1:v1"));
  eng.dispose();
});

/* ---------- relinquish ---------- */

test("relinquish is terminal: the session is KEPT, the page is told, and every later command answers relinquished", async () => {
  // MUTATION: in _relinquish, skip `this.relinquished = true` -> the next play is honoured.
  const { eng, events } = engine();
  await playEpisode(eng, episode("a"));
  const r = await send(eng, "relinquish", { cap: "foray" });
  assert.equal(r.ok, true);
  assert.equal(r.snapshot.session, "relinquished", "no deactivate, no notify: the session phase is terminal, not inactive");
  await tick();
  assert.ok(events.some((e) => e.type === "modeChanged" && e.mode === "legacy" && e.reason === "downgrade"));
  const after = await send(eng, "play");
  assert.deepStrictEqual([after.ok, after.reason], [false, "relinquished"]);
  eng.dispose();
});

/* ---------- continuation ---------- */

function chainFor(ids) {
  const items = Object.fromEntries(ids.map((id) => [id, episode(id)]));
  return continuationPlan(
    { currentId: ids[0], queue: ids.slice(1), playList: null, playChainId: null, playListCursor: null, items, isPlayable: ids },
    { planSeq: 1, autoAdvance: true },
  );
}

test("an episode's natural end walks the page's next hop, logs it, tells the page, and writes its pointer", async () => {
  // MUTATION: in _onSettled, skip the walk -> the snapshot stays ended on "a".
  const { eng, events } = engine();
  const plan = chainFor(["a", "b", "c"]);
  assert.ok(plan.chain.length >= 2, JSON.stringify(plan));
  await playEpisode(eng, episode("a"));
  await send(eng, "setContinuation", { planSeq: plan.planSeq, autoAdvance: true, chain: plan.chain });
  await eng.deck("ended");
  await eng._queue;
  await tick();
  const s = eng.snapshot();
  assert.equal(s.itemId, "b");
  assert.equal(s.state, "playing");
  assert.equal(s.pendingAdvances, 1);
  assert.ok(events.some((e) => e.type === "advanced" && e.hop.nextId === "b"));
  assert.equal(JSON.parse(eng.storage.getItem("cp_last_episode")).id, "b");
  await send(eng, "ackAdvances", { upToSeq: 1 });
  assert.equal(eng.snapshot().pendingAdvances, 0);
  eng.dispose();
});

test("with Continuous playback OFF the end stops, but next is still offered and walks the hop", async () => {
  // MUTATION: make canNext read `autoAdvance && chain.length` -> canNext false here.
  const { eng } = engine();
  const plan = chainFor(["a", "b"]);
  await playEpisode(eng, episode("a"));
  const r = await send(eng, "setContinuation", { planSeq: 1, autoAdvance: false, chain: plan.chain });
  assert.equal(r.snapshot.canNext, true, "canNext is the chain, regardless of autoAdvance (plan §5.5)");
  await eng.deck("ended");
  await eng._queue;
  assert.equal(eng.snapshot().itemId, "a", "no autoadvance with the switch off");
  const n = await send(eng, "next");
  assert.equal(n.ok, true);
  assert.equal(n.snapshot.itemId, "b");
  eng.dispose();
});

/* ---------- owned rows ---------- */

test("playEpisode stores the page's pointer verbatim plus updated_at, and rows read back only the owned prefixes", async () => {
  // MUTATION: store `{...item}` instead of the page's lastEpisodeRow -> the row differs.
  const { eng } = engine();
  const row = { title: "Title a", show: "Show a", id: "a" };
  await send(eng, "playEpisode", { item: episode("a"), lastEpisodeRow: row });
  eng.storage.setItem("cp_queue", "[]");
  const { rows } = await eng.engineRead({ what: "rows", prefixes: [...OWNED_PREFIXES] });
  assert.equal(rows.cp_last_episode, JSON.stringify({ ...row, updated_at: new Date(1790000000000).toISOString() }));
  assert.ok(!("cp_queue" in rows), "an unowned row is never served");
  const del = await send(eng, "stop", { persist: false });
  assert.equal(del.ok, true);
  assert.deepStrictEqual((await eng.engineRead({ what: "rows" })).rows, {}, "stop{persist:false} is data deletion");
  eng.dispose();
});

test("a gap in cmdSeq is written down, and every command's source is recorded before any refusal", async () => {
  const { eng } = engine();
  await eng.engineSend({ v: 1, cmdSeq: 1, cmd: "pause", source: "remote" });
  await eng.engineSend({ v: 1, cmdSeq: 5, cmd: "pause", source: "tap" });
  const cmds = (await eng.engineRead({ what: "diagnostics" })).rows.filter((r) => r.kind === "cmd");
  assert.deepStrictEqual(cmds.map((r) => [r.cmdSeq, r.source, Boolean(r.seqGap)]), [[1, "remote", false], [5, "tap", true]]);
  eng.dispose();
});
