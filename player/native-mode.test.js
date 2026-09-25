/* The real player/client.js, booted inside a pretend iOS shell whose ForayAudio
   plugin is the reference engine (docs/native-engine-plan.md §4.6, §5.6; card
   NE-22).

   WHAT THIS SUITE PINS. The page in native mode owns no audio: it builds no
   <audio> element and no jingle element (not even while engineHello is slow
   to answer), writes nothing to navigator.mediaSession, writes none of the
   engine's rows, never speaks through the page's synthesiser, and — booted
   over an engine that is already playing — only ATTACHES. The one way back to
   today's player is the ordered relinquish a Foray tap runs in M1, and it
   stops the engine before the first element exists; afterwards the page is
   the writer again, starting from exactly the engine's rows. A hello that
   fails lands in the JS lane with a relinquish already sent.

   THE STUB. The same shape transport-reconcile.test.js boots the page with
   (a DOM small enough to read, a spec-shaped <audio> element, a localStorage
   the test can watch), plus `window.Capacitor` =
   `ReferenceEngine.asCapacitor()` — the REAL PlayerQueueManager behind protocol
   v1 — so the page's facades, its engine client and the engine's replies are
   all the shipping code. A second copy rather than an import: importing a
   test file runs its tests. */

import test from "node:test";
import assert from "node:assert/strict";

import { createReferenceEngine } from "./parity/reference-engine.js";
import { __resetInstanceForTests } from "./queue-manager.js";
import { indexSegments, indexSources, resolveForay } from "./foray-resolve.js";
import { OWNED_PREFIXES } from "./engine-contract.js";

/* ==================================================================== */
/* the stub                                                             */
/* ==================================================================== */

/** An <audio> element, spec-shaped where the JS lane reads it. */
class Element {
  constructor(order) {
    this.order = order;
    this.listeners = new Map();
    this.src = "";
    this.currentSrc = "";
    this.currentTime = 0;
    this.duration = 3600;
    this.playbackRate = 1;
    this.volume = 1;
    this.preload = "none";
    this.readyState = 0;
    this.paused = true;
    this.ended = false;
    this.error = null;
  }
  addEventListener(t, fn) {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t).add(fn);
  }
  removeEventListener(t, fn) { this.listeners.get(t)?.delete(fn); }
  fire(t) { for (const fn of [...(this.listeners.get(t) ?? [])]) fn(); }
  load() {
    this.currentSrc = this.src;
    this.currentTime = 0;
    this.readyState = 0;
    queueMicrotask(() => {
      this.readyState = 1;
      this.fire("loadedmetadata");
      queueMicrotask(() => {
        this.readyState = 4;
        if (this.currentTime > 0) this.fire("seeked");
        this.fire("canplay");
      });
    });
  }
  play() {
    this.order.push("element.play");
    this.paused = false;
    queueMicrotask(() => { if (!this.paused) this.fire("playing"); });
    return Promise.resolve();
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.fire("pause");
  }
  removeAttribute() { this.src = ""; }
}

class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = new Map();
    this.listeners = new Map();
    this.style = {};
    this.dataset = {};
    this.className = "";
    this.textContent = "";
    this.hidden = false;
    this.classList = { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false };
  }
  append(...kids) { for (const k of kids) this.children.push(k); }
  appendChild(k) { this.children.push(k); return k; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  addEventListener(t, fn) {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t).add(fn);
  }
  removeEventListener(t, fn) { this.listeners.get(t)?.delete(fn); }
  click() { return Promise.all([...(this.listeners.get("click") ?? [])].map((fn) => fn({}))); }
}

/** localStorage, with every write on record. */
class WatchedStorage {
  constructor() { this.map = new Map(); this.writes = []; }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.writes.push(k); this.map.set(k, String(v)); }
  removeItem(k) { this.writes.push(k); this.map.delete(k); }
}

/** A navigator.mediaSession that records every write the page makes. */
function recordingMediaSession() {
  const writes = [];
  const session = {
    writes,
    setActionHandler: (name) => writes.push(`action:${name}`),
    setPositionState: () => writes.push("position"),
  };
  for (const prop of ["metadata", "playbackState"]) {
    let v = null;
    Object.defineProperty(session, prop, {
      get: () => v,
      set: (x) => { writes.push(prop); v = x; },
    });
  }
  return session;
}

/** The engine's clock: moves only when a test says, so nothing fires unasked. */
function manualScheduler() {
  let mono = 0;
  const due = [];
  return {
    nowMs: () => ++mono,
    schedule(ms, fn) {
      const job = { fn, live: true };
      due.push(job);
      return () => { job.live = false; };
    },
    runAll() { for (const j of due.splice(0)) if (j.live) j.fn(); },
  };
}

const owned = (k) => OWNED_PREFIXES.some((p) => k.startsWith(p));
const drain = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

let bootSeq = 0;

/**
 * Boot the real client.js in a pretend iOS shell over a reference engine.
 *
 * @param {object} [opts]
 * @param {object} [opts.engine]      a reference engine to boot over (one built here otherwise)
 * @param {"answer"|"hold"|"reject"} [opts.hello]  how engineHello behaves
 * @param {object} [opts.ledger]      window.forayEngineLedger (app.js's two appliers)
 * @param {Array} [opts.seed]         localStorage rows present at launch
 * @param {string} [opts.platform]    Capacitor's platform: "ios" (the shell), "web" or "android"
 */
async function bootNative(t, { engine = null, hello = "answer", ledger = null, seed = [], platform = "ios" } = {}) {
  const order = [];
  const scheduler = manualScheduler();
  const ref = engine ?? createReferenceEngine({ scheduler, now: () => 1_790_000_000_000 });
  const base = ref.asCapacitor({ platform });
  let releaseHello = null;
  const speechCalls = [];
  const capacitor = {
    ...base,
    nativePromise(plugin, method, payload) {
      if (plugin === "ForayTts") speechCalls.push(method);
      if (plugin === "ForayAudio") {
        order.push(method === "engineSend" ? `send:${payload?.cmd}` : method === "engineRead" ? `read:${payload?.what}` : method);
        if (method === "engineHello" && hello === "reject") return Promise.reject(new Error("the bridge fell over"));
        if (method === "engineHello" && hello === "hold") {
          return new Promise((resolve) => { releaseHello = () => resolve(base.nativePromise(plugin, method, payload)); });
        }
      }
      return base.nativePromise(plugin, method, payload);
    },
  };

  const storage = new WatchedStorage();
  for (const [k, v] of seed) storage.setItem(k, v);
  storage.writes.length = 0;
  const media = recordingMediaSession();
  const elements = [];
  const doc = {
    hidden: false,
    activeElement: null,
    body: new Node("body"),
    createElement: (tag) => {
      if (String(tag).toLowerCase() === "audio") {
        order.push("Audio");
        const el = new Element(order);
        elements.push(el);
        return el;
      }
      return new Node(tag);
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    listeners: new Map(),
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); },
    fire(type) { for (const fn of [...(this.listeners.get(type) ?? [])]) fn(); },
  };
  doc.body.classList = { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false };
  const speech = {
    speak: () => speechCalls.push("speechSynthesis.speak"),
    cancel: () => {}, pause: () => {}, resume: () => {}, getVoices: () => [],
    addEventListener: () => {},
  };
  const win = {
    listeners: new Map(),
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    },
    removeEventListener() {},
    dispatchEvent: () => true,
    Capacitor: capacitor,
    speechSynthesis: speech,
    ForayMediaSession: {
      calls: [],
      install() { this.calls.push("install"); return true; },
      uninstall() { this.calls.push("uninstall"); return true; },
    },
    ...(ledger ? { forayEngineLedger: ledger } : {}),
  };

  const names = ["window", "document", "localStorage", "navigator", "Event", "Audio"];
  const prev = new Map(names.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)]));
  const set = (n, value) => Object.defineProperty(globalThis, n, { value, writable: true, configurable: true });
  const restore = () => {
    for (const [n, d] of prev) {
      if (d) Object.defineProperty(globalThis, n, d);
      else delete globalThis[n];
    }
  };
  set("window", win);
  set("document", doc);
  set("localStorage", storage);
  set("navigator", { storage: { persisted: async () => false }, mediaSession: media });
  set("Event", class { constructor(type) { this.type = type; } });
  set("Audio", function Audio() {
    order.push("Audio");
    const el = new Element(order);
    elements.push(el);
    return el;
  });
  __resetInstanceForTests();

  const client = (await import(`./client.js?native=${++bootSeq}`)).default;
  /* Quiesce before the globals go: hidden stops the facade's 1 Hz ticker (it
     runs only while visible and flowing), and a paused engine stops the rest. */
  t.after(async () => {
    try {
      doc.hidden = true;
      doc.fire("visibilitychange");
      await drain();
    } finally {
      ref.dispose();
      restore();
    }
  });
  return {
    client, ref, doc, win, storage, media, order, elements, scheduler, speechCalls,
    releaseHello: () => releaseHello?.(),
  };
}

const episode = (id = "ep-a", title = "Ep A") => ({
  id, kind: "episode", title, show: "Show A", audio_url: `https://cdn.test/${id}.mp3`, duration_sec: 3600,
});

/** Two segments from different episodes: a real Foray for the JS lane. */
function synthetic() {
  const foray = {
    id: "f22", kind: "deep-dive", title: "A Foray", status: "published",
    slots: [{ id: "one", title: "Slot one" }],
    items: [
      { type: "segment", slot: "one", label: "L1", role: "explanation", segment_id: "sa" },
      { type: "segment", slot: "one", label: "L2", role: "explanation", segment_id: "sb" },
    ],
  };
  const segments = indexSegments({
    segments: [
      { id: "sa", item_id: "ep-x", start_sec: 100, end_sec: 200, reference_duration_sec: 3600, why: "w", topic: "food/grilling-bbq", confidence: "high" },
      { id: "sb", item_id: "ep-y", start_sec: 500, end_sec: 600, reference_duration_sec: 3600, why: "w", topic: "food/grilling-bbq", confidence: "high" },
    ],
  });
  const sources = indexSources({
    sources: [
      { id: "ep-x", show: "Show X", title: "Ep X", audio_url: "https://cdn.test/x.mp3", duration_sec: 3600, dai_suspected: false },
      { id: "ep-y", show: "Show Y", title: "Ep Y", audio_url: "https://cdn.test/y.mp3", duration_sec: 3600, dai_suspected: false },
    ],
  });
  return resolveForay(foray, { segments, sources });
}

function find(node, cls) {
  if (node.className === cls) return node;
  for (const k of node.children) { const hit = find(k, cls); if (hit) return hit; }
  return null;
}

/** The commands the engine received, by name, from its own record (D-4). */
const cmds = (ref) => ref.diagnostics.filter((r) => r.kind === "cmd").map((r) => r.cmd);

const AUDIBLE_OR_TRANSPORT = new Set([
  "playEpisode", "playForay", "play", "pause", "toggle", "next", "previous", "seekBy", "seekTo", "jump", "stop", "audition",
]);

/* ==================================================================== */
/* the pins                                                             */
/* ==================================================================== */

test("NATIVE: no HtmlAudioBackend and no interlude element — not while hello is slow, not after", async (t) => {
  /* KILLING MUTATION: drop play()'s `await engineModeReady` — ensureBooted
     answers false while the lane is unknown, so the tap is refused instead of
     waiting (and with ensureBooted's gate also gone, an Audio is built before
     hello answers). */
  const h = await bootNative(t, { hello: "hold" });
  const tap = h.client.play(episode());
  await drain();
  assert.deepEqual(h.order.filter((o) => o === "Audio"), [], "hello unanswered: nothing audible exists");
  assert.equal(cmds(h.ref).length, 0, "and nothing is sent: the lane is not known");

  h.releaseHello();
  assert.equal(await tap, true, "the tap waited for the lane and then played through the engine");
  await drain();
  assert.deepEqual(h.order.filter((o) => o === "Audio"), [], "native: never an <audio> element, never the jingle's");
  assert.equal(h.elements.length, 0);
  assert.ok(cmds(h.ref).includes("playEpisode"), "the tap became one playEpisode intent");
  assert.equal(h.ref.manager.state.type, "playing", "and the engine is the one playing");
  assert.equal(find(h.doc.body, "fp-play").getAttribute("aria-label"), "Pause", "the bar paints the engine's word");
});

test("NATIVE: playEpisode carries lastEpisodeRow = makeLastEpisode(item) without updated_at, and the ENGINE stores it", async (t) => {
  const h = await bootNative(t);
  await h.client.play(episode());
  await drain();
  const sent = h.ref.diagnostics.find((r) => r.kind === "cmd" && r.cmd === "playEpisode");
  assert.ok(sent, "sent");
  const row = JSON.parse(h.ref.storage.getItem("cp_last_episode"));
  assert.equal(row.id, "ep-a");
  assert.equal(row.title, "Ep A");
  assert.equal(typeof row.updated_at, "string", "the engine stamped its own time");
  assert.equal(h.storage.getItem("cp_last_episode"), null, "the page did not write the pointer");
});

test("NATIVE: no navigator.mediaSession write and no owned key written by the page, through play, pause, seek and a hide", async (t) => {
  /* KILLING MUTATIONS: drop `engineMode === "native"` from syncMediaSession
     (still inert — so also: build `media` with the real navigator in
     bootNative, and the metadata write lands); drop the native branch of
     flushPositions — a refused cp_pos write lands in health() as a fault. */
  const h = await bootNative(t);
  await h.client.play(episode());
  await drain();
  await h.client.togglePlayback();
  await drain();
  await h.client.seekTo(120);
  await h.client.togglePlayback();
  await drain();
  h.doc.hidden = true;
  h.doc.fire("visibilitychange");
  await drain();
  h.doc.hidden = false;
  h.doc.fire("visibilitychange");
  await drain();
  h.win.listeners.get("pagehide")?.forEach((fn) => fn());
  await drain();

  assert.deepEqual(h.media.writes, [], "the engine's NowPlayingPublisher is the only writer of Now Playing");
  assert.deepEqual(h.storage.writes.filter(owned), [], "no cp_pos:, cp_foray: or cp_last_episode from the page");
  const health = JSON.stringify(h.win.forayStorage.health());
  assert.ok(!health.includes("externally-owned"), "and none was even attempted (no refused-write fault)");
  assert.ok(cmds(h.ref).includes("pause") || cmds(h.ref).includes("toggle"), "the toggles were intents");
  assert.ok(cmds(h.ref).includes("seekTo"), "the seek was an intent");
  assert.ok(h.ref.storage.getItem("cp_pos:ep-a"), "the ENGINE wrote the position");
  assert.deepEqual(h.win.ForayMediaSession.calls, ["uninstall"], "the iOS lock-screen shim is not the lane's");
});

test("NATIVE: booting while the engine is running ATTACHES ONLY — no audible command, the engine's episode on the bar", async (t) => {
  /* KILLING MUTATION: drop the engineHoldsItem branch of restoreLastEpisode —
     the page restores the stored pointer (ep-old) with a restoredPending, and
     the bar shows a Play button over audio that is playing. */
  const scheduler = manualScheduler();
  const ref = createReferenceEngine({ scheduler, now: () => 1_790_000_000_000 });
  // A page before this one started ep-a; it is still playing when this page loads.
  await ref.engineSend({ v: 1, cmdSeq: 1, cmd: "playEpisode", source: "tap", issuedAtWallMs: 1, args: { item: episode(), lastEpisodeRow: { id: "ep-a", title: "Ep A" } } });
  await ref.deck("time", 900);
  const before = cmds(ref).length;
  const h = await bootNative(t, {
    engine: ref,
    seed: [["cp_last_episode", JSON.stringify({ id: "ep-old", title: "Old", updated_at: "2026-09-01T00:00:00.000Z" })]],
  });
  assert.equal(await h.client.whenEngineReady(), "native");
  const painted = h.client.restoreLastEpisode();
  await drain();
  assert.equal(painted?.id, "ep-a", "the bar is the engine's episode, not the stale pointer");
  const sent = cmds(ref).slice(before);
  assert.deepEqual(sent.filter((c) => AUDIBLE_OR_TRANSPORT.has(c)), [], `attach only: ${sent.join(",")}`);
  assert.equal(ref.manager.state.type, "playing", "still playing, untouched");
  assert.equal(find(h.doc.body, "fp-play").getAttribute("aria-label"), "Pause", "and the bar says so: one press pauses");
});

test("NATIVE: the voice preview goes through the engine — ForayTts.speak is never called, and engine-busy comes back while playing", async (t) => {
  /* KILLING MUTATION: drop the native branch of auditionVoice — the page's
     synthesiser speaks and no `audition` reaches the engine. */
  const h = await bootNative(t);
  assert.equal(await h.client.whenEngineReady(), "native");
  const idle = await h.client.auditionVoice("one, two, three", "com.apple.voice.Samantha");
  assert.equal(idle.ok, true, "idle: the engine speaks it");
  assert.ok(cmds(h.ref).includes("audition"));
  assert.ok(h.ref.log.ops.some((o) => String(o).startsWith("tts.speak:one, two, three")), "on the engine's synthesiser");

  await h.client.play(episode());
  await drain();
  const busy = await h.client.auditionVoice("one, two, three", null);
  assert.deepEqual(busy, { ok: false, reason: "engine-busy" }, "playing: refused, and app.js says 'Pause playback to preview'");
  assert.deepEqual(h.speechCalls.filter((c) => c === "speak" || c === "speechSynthesis.speak"), [], "neither ForayTts.speak nor speechSynthesis.speak was ever called");
});

test("NATIVE: app.js paints 'Pause playback to preview' on engine-busy", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(src, /result\.reason === "engine-busy"\)\s*\{\s*paintVoiceNotice\("Pause playback to preview"\)/);
});

test("NATIVE: a Foray tap relinquishes BEFORE any Audio is built, in the plan's order", async (t) => {
  /* KILLING MUTATION: call ensureBooted before relinquishToJs in playForay —
     no Audio (the lane is still native, the facade throws capability-off);
     or swap relinquish and ensureJsBooted inside relinquishToJs — Audio first. */
  const h = await bootNative(t);
  await h.client.play(episode());
  await drain();
  await h.client.playForay(synthetic(), { startIndex: 0 });
  await drain();
  const at = (tok) => h.order.indexOf(tok);
  assert.ok(at("send:relinquish") >= 0, "relinquish{cap:'foray'} was sent");
  assert.ok(at("Audio") > at("send:relinquish"), "the engine stopped before the first element existed");
  const rowsRead = h.order.lastIndexOf("read:rows");
  assert.ok(rowsRead > at("send:relinquish") && rowsRead < at("Audio"), "rows read and adopted between them");
  const relinquish = h.ref.diagnostics.find((r) => r.kind === "cmd" && r.cmd === "relinquish");
  assert.ok(relinquish);
  assert.ok(h.ref.diagnostics.some((r) => r.kind === "mode" && r.reason === "downgrade" && r.cap === "foray"),
    "the engine wrote 'mode reason=downgrade cap=foray' (the NE-27 Copy check)");
  assert.equal(h.ref.relinquished, true);
  assert.ok(h.elements.some((e) => !e.paused), "and the Foray plays in today's player");
  assert.deepEqual(h.win.ForayMediaSession.calls, ["uninstall", "install"], "the legacy lock screen comes back with the legacy lane");
});

test("NATIVE: after the relinquish a Foray position write lands, and the adopted cp_pos equals the engine's", async (t) => {
  /* KILLING MUTATIONS: skip adoptOwnedSet in relinquishToJs — the page's
     cp_pos:ep-a is the launch-time copy, not the engine's; skip
     releaseOwnership — the Foray row is refused and never reaches a tier. */
  const h = await bootNative(t, { seed: [["cp_pos:ep-a", JSON.stringify({ seconds: 5, duration: 3600, updated_at: "2026-09-01T00:00:00.000Z" })]] });
  await h.client.play(episode());
  await drain();
  await h.ref.deck("time", 600);
  await h.client.togglePlayback(); // pause: the engine saves 600
  await drain();
  const engineRow = h.ref.storage.getItem("cp_pos:ep-a");
  assert.ok(engineRow && JSON.parse(engineRow).seconds >= 590, `the engine's row: ${engineRow}`);

  await h.client.playForay(synthetic(), { startIndex: 0 });
  await drain();
  assert.equal(h.storage.getItem("cp_pos:ep-a"), engineRow, "the page's tiers now hold exactly the engine's row");

  const el = h.elements.find((e) => !e.paused);
  el.currentTime = 150;
  el.fire("timeupdate");
  await h.client.forayToggle(); // pause: the forced Foray write
  await drain();
  const forayRow = h.storage.getItem("cp_foray:f22");
  assert.ok(forayRow, "the Foray's own position reached localStorage: the page is the writer again");
  const health = JSON.stringify(h.win.forayStorage.health());
  assert.ok(!health.includes("externally-owned"), "and nothing was refused");
});

test("NATIVE: an engine that relinquished while the page was HIDDEN hands back on return — the page runs today's player", async (t) => {
  /* The hello watchdog (or anything else) tears the engine down while the
     phone is locked: its one modeChanged goes only to a visible page, so this
     page never hears it. KILLING MUTATION: drop the `relinquished` checks in
     native-engine.js (`handBack`) — the lane stays native, every press is
     refused `relinquished`, and nothing can play until a restart. */
  const h = await bootNative(t);
  assert.equal(await h.client.whenEngineReady(), "native");
  await h.client.play(episode());
  await drain();
  await h.client.togglePlayback(); // paused: the engine is idle
  await drain();
  h.doc.hidden = true;
  h.doc.fire("visibilitychange");
  await drain();
  assert.equal(h.ref.visible, false);
  // The engine gives the audio back by itself while the page is hidden.
  await h.ref.engineSend({ v: 1, cmdSeq: 900, cmd: "relinquish", source: "restore", issuedAtWallMs: 1, args: { cap: "all" } });
  await drain();
  assert.equal(h.ref.relinquished, true);

  h.doc.hidden = false;
  h.doc.fire("visibilitychange");
  await drain(20);
  assert.deepEqual(h.win.ForayMediaSession.calls, ["uninstall", "install"], "the legacy lane came back");
  const sentBefore = h.ref.diagnostics.filter((r) => r.kind === "cmd" && r.cmd === "playEpisode").length;
  assert.equal(await h.client.play(episode("ep-b", "Ep B")), true, "a press plays, in today's player");
  await drain();
  assert.ok(h.elements.some((e) => !e.paused), "on the page's own element");
  const sentAfter = h.ref.diagnostics.filter((r) => r.kind === "cmd" && r.cmd === "playEpisode").length;
  assert.equal(sentAfter, sentBefore, "nothing was sent to the torn-down engine");
});

test("DELETE MY DATA after a Foray tap (the engine torn down) still clears the engine's store, and says so", async (t) => {
  /* KILLING MUTATION: in the reference engine (and EngineBridge.send), refuse
     purge `relinquished` like every other command — the engine's rows survive
     and the purge reports the device NOT clear, with no retry that can fix it. */
  const h = await bootNative(t);
  await h.client.play(episode());
  await drain();
  await h.client.togglePlayback();
  await drain();
  assert.ok(h.ref.storage.getItem("cp_last_episode"), "the engine stored rows");
  await h.client.playForay(synthetic(), { startIndex: 0 });
  await drain();
  assert.equal(h.ref.relinquished, true, "the Foray tap tore the engine down");

  const out = await h.win.forayStorage.purge();
  assert.deepEqual(out.engine, { ok: true }, JSON.stringify(out.engine));
  assert.equal(h.ref.storage.length, 0, "every row the engine stored is gone");
  assert.ok(cmds(h.ref).includes("purge"));
});

test("DELETE MY DATA in the web-player lane (hello said legacy) reaches the engine's store too", async (t) => {
  /* An earlier native launch left rows behind; this launch runs the web
     player (the Developer switch set to Web). KILLING MUTATION: drop
     `storage.setEnginePurge(...)` from onEngineDecision — the purge never
     asks the engine, reports ok, and the engine's rows survive. */
  const ref = createReferenceEngine({ scheduler: manualScheduler(), now: () => 1_790_000_000_000, mode: "legacy", reason: "override" });
  ref.storage.setItem("cp_last_episode", JSON.stringify({ id: "ep-old", title: "Old" }));
  const h = await bootNative(t, { engine: ref });
  assert.equal(await h.client.whenEngineReady(), "js");
  const out = await h.win.forayStorage.purge();
  assert.deepEqual(out.engine, { ok: true }, "the engine was asked, and cleared");
  assert.equal(ref.storage.length, 0);
  assert.ok(cmds(ref).includes("purge"));
});

test("DELETE MY DATA off the iOS shell asks no engine at all", async (t) => {
  const h = await bootNative(t, { platform: "web" });
  assert.equal(await h.client.whenEngineReady(), "js");
  const out = await h.win.forayStorage.purge();
  assert.equal(out.engine, undefined);
  assert.equal(cmds(h.ref).length, 0);
});

test("A hello that REJECTS lands in the JS lane with relinquish{cap:'all'} already sent", async (t) => {
  /* KILLING MUTATION: drop the relinquish in native-engine.js's hello — the
     engine never hears it, and a native engine that might be running would
     play under the page's own element. */
  const h = await bootNative(t, { hello: "reject" });
  assert.equal(await h.client.whenEngineReady(), "js");
  const sent = h.ref.diagnostics.find((r) => r.kind === "cmd" && r.cmd === "relinquish");
  assert.ok(sent, "relinquish reached the engine");
  assert.equal(h.ref.relinquished, true);
  await h.client.play(episode());
  await drain();
  assert.ok(h.order.indexOf("Audio") > h.order.indexOf("send:relinquish"), "the JS player was built after it");
  assert.equal(h.storage.getItem("cp_last_episode") !== null, true, "and the page writes its own rows again");
});

test("NATIVE: setContinuation reaches the engine, and an advance it walks is applied once through app.js's ledger and acked", async (t) => {
  /* KILLING MUTATION: skip the ack in applyEnginePending — the engine keeps
     the hop, and the next attach hands it over again. */
  const applied = [];
  const ledger = {
    applyEngineAdvance: (hop) => { applied.push(hop.nextId); return true; },
    drainEngineEvents: () => 0,
  };
  const h = await bootNative(t, { ledger });
  assert.equal(await h.client.whenEngineReady(), "native");
  await h.client.play(episode());
  const epB = episode("ep-b", "Ep B");
  const took = await h.client.setContinuation({
    planSeq: 7, autoAdvance: true,
    chain: [{ planSeq: 7, hopSeq: 1, finishedId: "ep-a", nextId: "ep-b", fromList: false, queueAfter: [], item: epB, lastEpisodeRow: { id: "ep-b", title: "Ep B" } }],
  });
  assert.equal(took, true);
  assert.ok(cmds(h.ref).includes("setContinuation"));

  await h.ref.deck("ended");
  await drain(20);
  assert.equal(h.ref.manager.queue[0]?.id, "ep-b", "the engine walked the chain itself");
  assert.deepEqual(applied, ["ep-b"], "the page applied the hop once");
  assert.ok(cmds(h.ref).includes("ackAdvances"), "and acked it");
  assert.equal(h.ref.advanceLog.length, 0, "so the engine holds it no longer");
  assert.equal(find(h.doc.body, "fp-title").textContent, "Ep B", "the bar names the episode the engine moved to");
});

test("NATIVE: with Continuous playback off an episode that ends is announced to the page, which takes it off Up Next (round-3 review, L1)", async (t) => {
  /* app-1-9 removed the finished row in app.js advanceQueueOnEnded, fed only
     by onEpisodeEnded, which returned early in native mode: with the switch
     off the engine walks no hop, so no `advanced` reached the page and the row
     stayed on iOS. KILLING MUTATION: return early for every native end again
     -- `ended` stays empty. And with the switch on the engine walks and the
     page is NOT told (it would start the next episode twice). */
  const h = await bootNative(t);
  assert.equal(await h.client.whenEngineReady(), "native");
  const ended = [];
  h.client.onEpisodeEnded((id) => ended.push(id));
  await h.client.play(episode());
  assert.equal(await h.client.setContinuation({ planSeq: 3, autoAdvance: false, chain: [] }), true);
  await h.ref.deck("ended");
  await drain(20);
  h.scheduler.runAll();                 // the engine's coalesced snapshot goes out
  await drain(20);
  assert.deepEqual(ended, ["ep-a"], "the page heard the end it has to act on");
});

test("NATIVE: with Continuous playback on the engine walks at an end, and the page is not told a second time (round-3 review, L1)", async (t) => {
  const on = await bootNative(t);
  assert.equal(await on.client.whenEngineReady(), "native");
  const endedOn = [];
  on.client.onEpisodeEnded((id) => endedOn.push(id));
  await on.client.play(episode());
  const epB = episode("ep-b", "Ep B");
  await on.client.setContinuation({
    planSeq: 4, autoAdvance: true,
    chain: [{ planSeq: 4, hopSeq: 1, finishedId: "ep-a", nextId: "ep-b", fromList: false, queueAfter: [], item: epB, lastEpisodeRow: { id: "ep-b", title: "Ep B" } }],
  });
  await on.ref.deck("ended");
  await drain(20);
  on.scheduler.runAll();
  await drain(20);
  assert.deepEqual(endedOn, [], "with the switch on the engine walks, and the page is not told a second time");
});

test("NATIVE: a play superseded while the engine loads answers false; the one that replaced it answers true", async (t) => {
  /* transport-reconcile's ROUND 2 p-impatient-2, in native mode (facades.json
     maps it here): `play()` answers for THIS item, not for whoever owns the
     engine when the reply lands, so A never enters History for a load B
     superseded. The engine is serial, so A's reply arrives while B is the
     page's current. KILLING MUTATION: `return manager.state?.type !== "idle";`
     in play() — A answers true. */
  const scheduler = manualScheduler();
  const ref = createReferenceEngine({ scheduler, now: () => 1_790_000_000_000, backend: { holdLoads: true } });
  const h = await bootNative(t, { engine: ref });
  assert.equal(await h.client.whenEngineReady(), "native");
  const first = h.client.play(episode("ep-a", "Ep A"));
  await drain();
  const second = h.client.play(episode("ep-b", "Ep B"));
  await drain();
  ref.backend.settleLoad("ep-a");
  await drain();
  ref.backend.settleLoad("ep-b");
  assert.equal(await first, false, "A never made a sound");
  assert.equal(await second, true, "B did");
  assert.equal(h.client.isCurrent("ep-b"), true);
});

/* ==================================================================== */
/* the Developer engine rows' commands (NE-22d)                         */
/* ==================================================================== */

/* app.js draws the four rows the M1 car test drives; client.js decides which
   exist (`engineDeveloperStatus`) and is the only sender of their commands
   (`engineDeveloperSend`). test/engine-developer-rows.test.js pins the drawer
   half; these pin the half that reaches the bridge. */

const engineCalls = (h) => h.order.filter((o) => o.startsWith("send:") || o === "engineHello" || o.startsWith("read:"));

for (const platform of ["web", "android"]) {
  test(`DEVELOPER (${platform}): no engine, so no rows and nothing is ever sent`, async (t) => {
    /* KILLING MUTATION: drop `if (!engine) return null;` from
       engineDeveloperStatus — it throws on `engine.decision` here, and a
       guard that answered a status instead would send through an engine
       client that does not exist. */
    const h = await bootNative(t, { platform });
    assert.equal(await h.client.whenEngineReady(), "js");
    assert.equal(h.client.engineDeveloperStatus(), null, "no rows");
    for (const [cmd, args] of [["setModeOverride", { mode: "native" }], ["setHoldPolicy", { policy: "none" }],
      ["simulateTermination", undefined], ["probeSession", undefined]]) {
      assert.equal(await h.client.engineDeveloperSend(cmd, args), null, `${cmd}: nothing to send it to`);
    }
    assert.deepEqual(engineCalls(h), [], "the bridge was never called");
    assert.equal(cmds(h.ref).length, 0);
  });
}

test("DEVELOPER: while engineHello is unanswered there are no rows and nothing is sent", async (t) => {
  const h = await bootNative(t, { hello: "hold" });
  await drain();
  assert.equal(h.client.engineDeveloperStatus(), null);
  assert.equal(await h.client.engineDeveloperSend("setHoldPolicy", { policy: "none" }), null);
  assert.equal(cmds(h.ref).length, 0);
  h.releaseHello();
  assert.equal(await h.client.whenEngineReady(), "native");
});

test("DEVELOPER (native lane): all four rows; each command goes out as one engineSend with the right args", async (t) => {
  /* KILLING MUTATION: send under a different cmd name, or skip `engine.send`
     — the engine's own command record diverges. */
  const h = await bootNative(t);
  assert.equal(await h.client.whenEngineReady(), "native");
  const st = h.client.engineDeveloperStatus();
  assert.deepEqual(st.commands, ["setModeOverride", "setHoldPolicy", "simulateTermination", "probeSession"]);
  assert.equal(st.lane, "native");
  assert.equal(st.holdPolicy, "forever", "read back from the engine's snapshot");
  assert.equal(st.override, "auto", "build-default decided this launch: Automatic");

  const r1 = await h.client.engineDeveloperSend("setHoldPolicy", { policy: "none" });
  assert.equal(r1.ok, true);
  assert.equal(h.ref.holdPolicy, "none", "the engine holds the new policy");
  assert.equal(h.client.engineDeveloperStatus().holdPolicy, "none", "and the page reads it back from the reply's snapshot");

  const r2 = await h.client.engineDeveloperSend("setModeOverride", { mode: "web" });
  assert.equal(r2.ok, true);
  assert.equal(h.ref.modeOverride, "web");
  assert.equal(h.client.engineDeveloperStatus().override, "web", "the value the engine confirmed storing");
  assert.equal(h.client.engineDeveloperStatus().lane, "native", "the running lane is unchanged: it applies after restart");

  const r3 = await h.client.engineDeveloperSend("probeSession");
  assert.equal(r3.ok, true);
  const r4 = await h.client.engineDeveloperSend("simulateTermination");
  assert.equal(r4.ok, false, "nothing loaded: refused, as the Swift core refuses it");
  assert.equal(r4.reason, "not-loaded");

  const dev = ["setHoldPolicy", "setModeOverride", "probeSession", "simulateTermination"];
  const sent = h.ref.diagnostics.filter((r) => r.kind === "cmd" && dev.includes(r.cmd));
  assert.deepEqual(sent.map((r) => r.cmd), dev);
  assert.ok(sent.every((r) => r.source === "tap"), "a Developer row is a tap");
});

test("DEVELOPER: only the four commands go through engineDeveloperSend", async (t) => {
  /* KILLING MUTATION: drop the `commands.includes(cmd)` check — a transport
     command would reach the engine through a Developer path. */
  const h = await bootNative(t);
  await h.client.whenEngineReady();
  const before = cmds(h.ref).length;
  assert.equal(await h.client.engineDeveloperSend("play"), null);
  assert.equal(await h.client.engineDeveloperSend("purge"), null);
  assert.equal(cmds(h.ref).length, before);
});

test("DEVELOPER (legacy lane): only the engine setting, read back from the launch's own reason", async (t) => {
  /* The native side takes setModeOverride in every lane (EngineBridge.send):
     it is how the web player asks for the native one at the next launch.
     KILLING MUTATION: in native-engine.js, stop keeping the engine's own
     {mode, reason} for a legacy hello — the override reads "not known". */
  const ref = createReferenceEngine({
    scheduler: manualScheduler(), now: () => 1_790_000_000_000, mode: "legacy", reason: "override",
  });
  const h = await bootNative(t, { engine: ref });
  assert.equal(await h.client.whenEngineReady(), "js");
  const st = h.client.engineDeveloperStatus();
  assert.deepEqual(st.commands, ["setModeOverride"], "the three that need a running engine are absent");
  assert.equal(st.override, "web", "a legacy launch decided by the override: Web");
  assert.equal(st.holdPolicy, null);
  assert.equal(await h.client.engineDeveloperSend("setHoldPolicy", { policy: "none" }), null, "not sent");
  assert.equal(await h.client.engineDeveloperSend("probeSession"), null, "not sent");
  const reply = await h.client.engineDeveloperSend("setModeOverride", { mode: "native" });
  assert.equal(reply.ok, true);
  assert.equal(ref.modeOverride, "native");
  assert.equal(h.client.engineDeveloperStatus().override, "native");
  assert.deepEqual(cmds(ref), ["setModeOverride"], "one command reached the engine, and only that one");
});

const devRef = (reason, mode) => createReferenceEngine({ scheduler: manualScheduler(), now: () => 1_790_000_000_000, reason, mode });

test("DEVELOPER: a native launch decided by the override reads Native", async (t) => {
  const h = await bootNative(t, { engine: devRef("override", "native") });
  await h.client.whenEngineReady();
  assert.equal(h.client.engineDeveloperStatus().override, "native");
});

test("DEVELOPER: a crash-loop launch reads the setting as not known, never a guess", async (t) => {
  const h = await bootNative(t, { engine: devRef("crash-loop", "legacy") });
  await h.client.whenEngineReady();
  assert.equal(h.client.engineDeveloperStatus().override, null);
});
