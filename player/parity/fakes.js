/* Recording fakes for parity scenarios (NE-03, plan §6.2-6.3).

   A scenario fixture asserts on an OP LOG: the ordered list of everything the
   code under test asked the outside world to do. These fakes are that outside
   world for the JS reference. They write into ONE shared log, because the
   ordering BETWEEN adapters is the assertion that matters most — "the jingle
   stopped before the next segment's play()" is a claim about two fakes.

   THE GRAMMAR IS THE EXISTING ONE. The backend tokens (`load:<id>@<offset>`,
   `play`, `pause`, `seek:<s>`, `outPoint:<s|null>`, `rate:<r>`, `release`)
   are byte-for-byte those of `FakeBackend` in queue-manager.test.js, which 144
   tests already assert on; the plan fixes that grammar ("the op-log grammar is
   unchanged") so that a case recorded here reads the same as the test it came
   from. New adapters get new, prefixed tokens (`tts.`, `interlude.`) rather
   than reusing a backend verb, so no existing reading of a token changes.

   Native-only tokens are `n.*` and never appear here; see compare.js.

   Nothing in this file touches a real clock. `manualScheduler` is the same
   contract queue-manager.test.js's is (`nowMs`, `schedule(ms, fn) -> cancel`),
   and `instantScheduler` fires on the next microtask, never synchronously. */

/** The shared, ordered op log. */
export class OpLog {
  constructor() { this.ops = []; }
  push(op) { this.ops.push(op); }
  /** Ops appended since `mark` (an earlier `length`). */
  since(mark) { return this.ops.slice(mark); }
  get length() { return this.ops.length; }
}

/** Offsets are rounded, as FakeBackend rounds them: the grammar pins where a
    load landed to the second, and sub-second drift is the deck family's job. */
const r = (s) => Math.round(s);

/**
 * The media backend. Same surface and tokens as queue-manager.test.js's
 * FakeBackend, plus a `log` argument so it can share the scenario's log.
 */
export class FakeBackend {
  constructor({
    log = new OpLog(), failLoadFor = [], durationById = {}, duration = 3600, holdLoads = false, loadTurns = 0,
    prefetch = false, coldLoadMs = 0, scheduler = null, slowFirstPlay = false,
  } = {}) {
    this.log = log;
    /** NE-30j. A load that takes a few MICROTASK turns before it starts —
        queue-manager.test.js's AsyncLoadBackend, "any real network load": the
        window in which a stale wait could resume and arm a boundary the
        replacement load then clears. */
    this.loadTurns = Number.isInteger(loadTurns) && loadTurns > 0 ? loadTurns : 0;
    /** NE-14j. When true a load does not settle until the scenario says so
        (the `deck: "loaded"` / `"loadFailed"` verbs, via `settleLoad`), so a
        superseded load can land AFTER the load that replaced it — the ordering
        a fast tap or a double skip produces on a real network. */
    this.holdLoads = holdLoads === true;
    this._held = [];
    this.currentTime = 0;
    this._duration = duration;
    this.durationById = durationById;
    this._loadedId = null;
    this.outPoint = null;
    this.failLoadFor = new Set(failLoadFor);
    this.paused = true;
    /** NE-14k. The element's own `ended`: set by the scenario's `deck: "ended"`
        and `deck: "ranOut"` verbs, cleared by a load or a play, as an
        <audio> element clears it. The manager reads it in two places (the
        reconcile's "a finished file is not an external stop" and
        `reEnteringLoadedItem`'s "play after the end starts from the top"). */
    this.ended = false;
    this.onItemEnded = null;
    this.onError = null;
    /** NE-39j. The web lane's prefetch contract, opt-in (`prefetch: true`),
        as queue-manager.test.js's PrefetchBackend models it. The manager wires
        `onPrefetchWindow` only for a backend that HAS a `prefetch` method
        (queue-manager.js §11), so the method is put on the instance only when
        a case asks, and every earlier case keeps a backend without one.
          prefetch:<id>@<s>  the ASK: the manager naming the item the next
                             boundary advances to, and its in-point. A later
                             load of that item at that offset is warm.
          prefetch "loses"   the ask is made and the bytes are never ready (the
                             race lost), so the load takes the ordinary path.
        `openPrefetchWindow()` is the deck's playhead watch firing
        PREFETCH_LEAD_SEC before the boundary: the scenario's `deck: "window"`.
        `coldLoadMs` (with the manual scheduler, which the runner hands in): a
        load that finds nothing warm waits that long on the scenario's clock
        before it lands — the 9,153 ms measured on the device (run
        32036295743) — so a seam's length shows as where its `play` falls
        between two clock steps. */
    this._warmed = new Set();
    this._coldLoadMs = Number.isInteger(coldLoadMs) && coldLoadMs > 0 ? coldLoadMs : 0;
    this._scheduler = scheduler;
    if (prefetch === true || prefetch === "loses") {
      const loses = prefetch === "loses";
      this.onPrefetchWindow = null;
      this.prefetch = (item, { startOffset = 0 } = {}) => {
        const key = `${item.id}@${r(startOffset)}`;
        this.log.push(`prefetch:${key}`);
        if (!loses) this._warmed.add(key);
        return true;
      };
      this.openPrefetchWindow = () => { this.onPrefetchWindow?.(); };
    }
    /** NE-39j. queue-manager.test.js's SlowPlayBackend (`slowFirstPlay`): the
        FIRST `play()` does not settle until the next `pause()`, which releases
        it and then takes two turns of its own — a play still awaiting the
        element while a skip-back sits between arming its restart and its load. */
    this._slowFirstPlay = slowFirstPlay === true;
    this._releasePlay = null;
  }
  get calls() { return this.log.ops; }
  /** HtmlAudioBackend's `audible` (CH-37), over this fake's `paused`/`ended`:
      a definite yes only. The manager asks this, not `paused`. */
  get audible() { return this.paused === false && this.ended !== true; }
  get duration() { return this.durationById[this._loadedId] ?? this._duration; }
  set duration(v) { this._duration = v; }
  async load(item, { startOffset = 0 } = {}) {
    for (let i = 0; i < this.loadTurns; i++) await Promise.resolve();
    const warm = this._warmed.delete(`${item.id}@${r(startOffset)}`);
    if (!warm && this._coldLoadMs) {
      if (!this._scheduler?.schedule) throw new Error("coldLoadMs needs the scenario's scheduler");
      await new Promise((resolve) => this._scheduler.schedule(this._coldLoadMs, resolve));
    }
    this._loadedId = item.id;
    this.outPoint = null; // contract: a load drops any armed boundary
    this.paused = true;
    this.ended = false;
    this.currentTime = startOffset;
    this.log.push(`load:${item.id}@${r(startOffset)}`);
    if (this.holdLoads) {
      return new Promise((resolve, reject) => this._held.push({ id: item.id, resolve, reject }));
    }
    if (this.failLoadFor.has(item.id)) throw new Error("missing file");
  }
  /** Settle the oldest held load for `id` (or the oldest of all when `id` is
      null). A load for an id in `failLoadFor` fails however it is settled.
      Returns false when nothing was held. */
  settleLoad(id = null, { fail = false } = {}) {
    const i = this._held.findIndex((h) => id == null || h.id === id);
    if (i < 0) return false;
    const [held] = this._held.splice(i, 1);
    if (fail || this.failLoadFor.has(held.id)) held.reject(new Error("missing file"));
    else held.resolve();
    return true;
  }
  play() {
    this.paused = false;
    this.ended = false;
    this.log.push("play");
    if (!this._slowFirstPlay) return undefined;
    this._slowFirstPlay = false;
    return new Promise((resolve) => { this._releasePlay = resolve; });
  }
  pause() {
    this.paused = true;
    this.log.push("pause");
    if (!this._releasePlay) return undefined;
    // The pending play settles here, while whatever paused is mid-effects.
    const release = this._releasePlay;
    this._releasePlay = null;
    release();
    return tick().then(tick);
  }
  seek(s) { this.currentTime = s; this.log.push(`seek:${r(s)}`); }
  setOutPoint(s) {
    this.outPoint = s;
    this.log.push(`outPoint:${s == null ? "null" : r(s)}`);
  }
  setRate(rate) { this.log.push(`rate:${rate}`); }
  release() { this.log.push("release"); }
}

/** Fires on the next microtask. The default for scenarios about ORDER. */
export function instantScheduler() {
  return {
    nowMs: () => 0,
    schedule: (_ms, fn) => {
      let dead = false;
      queueMicrotask(() => { if (!dead) fn(); });
      return () => { dead = true; };
    },
  };
}

/** Drain the microtask queue and one macrotask turn. */
export const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Nothing fires until `advance(ms)`. The default for scenarios about TIME. */
export function manualScheduler() {
  let now = 0;
  const pending = [];
  return {
    nowMs: () => now,
    schedule(ms, fn) {
      const entry = { at: now + ms, fn, dead: false };
      pending.push(entry);
      return () => { entry.dead = true; };
    },
    /** Move the clock and run what came due, in due order, then settle. */
    async advance(ms) {
      now += ms;
      const due = pending.filter((e) => !e.dead && e.at <= now).sort((a, b) => a.at - b.at);
      for (const entry of due) {
        if (entry.dead) continue;
        entry.dead = true;
        entry.fn();
      }
      await tick();
    },
    get live() { return pending.filter((e) => !e.dead).length; },
  };
}

/**
 * A Storage (`getItem`/`setItem`/`removeItem`/`key`/`length`) and, on the same
 * object, the manager's `positionStore` (`save(id, seconds)`/`load(id)`).
 * Writes are logged as `store.set:<key>` / `store.save:<id>@<s>` so a scenario
 * can assert on WHEN a row was written, not only what it ended up holding.
 */
export class MemoryStore {
  constructor({ log = null, initial = {} } = {}) {
    this.log = log;
    this.map = new Map(Object.entries(initial));
    this.positions = new Map();
  }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); this.log?.push(`store.set:${k}`); }
  removeItem(k) { this.map.delete(k); this.log?.push(`store.remove:${k}`); }
  save(id, seconds) { this.positions.set(id, { seconds }); this.log?.push(`store.save:${id}@${r(seconds)}`); }
  load(id) { return this.positions.get(id) ?? null; }
}

/**
 * The on-device narration bridge: `speak`, the optional `onFinished`, and the
 * L-05 transport (`pause`/`resume`/`stop`). `finish()` is the scenario's
 * `tts` verb standing in for `speechSynthesizer(_:didFinish:)`.
 *
 * NE-31j. The shapes queue-manager.test.js's narration suites hand the
 * manager, each opt-in so a plain `tts: true` is exactly the fake it was:
 *
 *   refuse         speak answers { ok: false } (a synthesiser that will not)
 *   voiceFallback  speak answers { ok: true, voiceFallback: true } (the plugin
 *                  spoke in another voice than the one asked for)
 *   onFinished     false: the bridge has no `onFinished` at all (an older
 *                  shell) — no ticker, no auto-advance
 *   transport      false: no `pause`/`resume`/`stop` (a shell built before L-05)
 *   pause          "rejects": the pause call is made (`tts.pause`) and throws;
 *                  "held" (NE-39j): it is made and waits for the scenario's
 *                  `tts: "releasePause"`
 *   resume         an answer object: what `resume` resolves (Android's
 *                  `{fromStart: true}`, an older shell's `{accepted: false}`)
 *   state          true: the bridge answers `state()` — `speaking` from a
 *                  speak until finish/stop, `paused` between pause and resume,
 *                  `idle` otherwise. The scenario's `tts: "silent"` is the
 *                  session taken from under the utterance: the synthesiser
 *                  stops and tells nobody (ForayTtsPlugin.swift), so only
 *                  `state()` says so. A read, never an op.
 */
export function fakeTts({
  log = new OpLog(), refuse = false, voiceFallback = false, onFinished = true,
  transport = true, pause = "ok", resume = null, state = false,
} = {}) {
  const listeners = new Set();
  let word = "idle";
  /** NE-39j. `pause: "held"`: each pause call waits until the scenario's
      `tts: "releasePause"` answers it (the bridge round trip a real
      synthesiser takes), so a second transport action can run meanwhile. */
  const heldPauses = [];
  const bridge = {
    log,
    async speak(text, opts = {}) {
      log.push(`tts.speak:${text}@${opts.rate ?? "-"}${opts.voice ? `:${opts.voice}` : ""}`);
      if (refuse) return { ok: false, reason: "refused" };
      word = "speaking";
      return voiceFallback ? { ok: true, voiceFallback: true } : { ok: true };
    },
    finish() { word = "idle"; for (const fn of [...listeners]) fn(); },
    /** The session was taken: the synthesiser is silent and reports nothing. */
    silence() { word = "idle"; },
    /** Answer every held pause (`pause: "held"`). False when none was held. */
    releasePause() {
      if (!heldPauses.length) return false;
      for (const resolve of heldPauses.splice(0)) resolve();
      return true;
    },
  };
  if (onFinished !== false) {
    bridge.onFinished = (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    };
  }
  if (transport !== false) {
    bridge.pause = async () => {
      log.push("tts.pause");
      if (pause === "rejects") throw new Error("the bridge is gone");
      if (pause === "held") await new Promise((resolve) => heldPauses.push(resolve));
      if (word === "speaking") word = "paused";
      return { ok: true, accepted: true, path: "native" };
    };
    bridge.resume = async () => {
      log.push("tts.resume");
      if (resume && typeof resume === "object") {
        if (resume.accepted === true) word = "speaking";
        return { ...resume };
      }
      if (word === "paused") word = "speaking";
      return { ok: true, accepted: true, path: "native" };
    };
    bridge.stop = async () => {
      log.push("tts.stop");
      word = "idle";
      return { ok: true, accepted: true, path: "native" };
    };
  }
  if (state === true) bridge.state = async () => ({ ok: true, state: word });
  return bridge;
}

/** The jingle player: `start() -> bool`, `stop()`, assignable `onEnded`.
    Answers the way the real element can — refused, ended, or never ended. */
export function fakeInterlude({ log = new OpLog(), refuse = false } = {}) {
  return {
    log,
    active: false,
    onEnded: null,
    start() {
      if (refuse || this.active) { log.push("interlude.refused"); return false; }
      this.active = true;
      log.push("interlude.start");
      return true;
    },
    stop() {
      if (this.active) log.push("interlude.stop");
      this.active = false;
    },
    /** The element reporting its own end — the scenario's `interlude` verb. */
    finish(reason = "ended") {
      if (!this.active) return;
      this.active = false;
      log.push(`interlude.ended:${reason}`);
      if (typeof this.onEnded === "function") this.onEnded(reason);
    },
    release() { log.push("interlude.release"); },
  };
}

/**
 * NE-47: the engine's PREVIEW deck, where an audition that names a rendered
 * `preview.m4a` plays (the voice picker's preview, Spark §3.3). A deck of its
 * own, so a preview never disturbs the item the main deck holds. Tokens are
 * prefixed like every other adapter's: `preview.load:<url>` when a load is
 * asked, `preview.play` when the loaded file starts, `preview.stop` when a
 * preview in flight is cut. A load for a url in `failUrls` fails (a 404, a
 * dead host, a load past its deadline: to the engine they are one failure).
 */
export function fakePreview({ log = new OpLog(), failUrls = [] } = {}) {
  const failing = new Set(failUrls);
  return {
    log,
    /** A preview is loading or sounding: what a stop has to cut. */
    active: false,
    async load(url) {
      log.push(`preview.load:${url}`);
      this.active = true;
      if (failing.has(url)) {
        this.active = false;
        throw new Error("preview did not load");
      }
    },
    play() { log.push("preview.play"); },
    stop() {
      if (!this.active) return;
      this.active = false;
      log.push("preview.stop");
    },
    /** The file ran out (natively the preview deck's `.ended`). */
    finish() { this.active = false; },
  };
}
