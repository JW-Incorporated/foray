/* The native engine behind the two surfaces client.js already reads
   (docs/native-engine-plan.md §5.6; card NE-21).

   FACADES, NOT A REWRITE. client.js reads a PlayerQueueManager and an
   HtmlAudioBackend: `manager.state.type`, `currentIndex`, `inSeamGap`,
   `playheadItemId`, `isNarrationPlayhead`, `elementIsAudible`, `rate`, the
   transport methods; `backend.currentTime`, `duration`, `rate`,
   `addMediaListener`, `notePlayGesture`. In native mode (NE-22) it builds these
   two instead, and every one of those reads is answered from the engine's
   snapshot while every transport call becomes an engineSend intent. The page
   keeps its decisions and its painting; it stops owning the audio.

   THE ONE RULE THIS FILE KEEPS: THE PAGE BELIEVES THE ENGINE. transport-
   reconcile.test.js is 117 tests about one failure — the page's belief and the
   element disagreeing, and a press spent correcting the app (#263, #689). Here
   the belief IS the engine's latest snapshot, held by native-engine.js, and
   nothing in this file keeps a second copy of `playing` that could go stale:
   `state`, `elementIsAudible` and the media events are all computed from the
   same snapshot, so the card, the bar and the lock screen cannot disagree.
   Coming back to the page is `attach` — a READ — which can correct the belief
   and can never start audio (the reconcile's own invariant).

   THREE THINGS ARE LOCAL, deliberately, and each says why where it lives: the
   listener's rate and voice (the page still writes cp_rate and cp_voice, §5.2,
   and a label must not flicker back while the send is in flight), and the
   picked item (the page must name what it asked for before the engine has
   answered).

   MEDIA EVENTS ARE SYNTHESISED. client.js repaints and records on element
   events (`play`, `pause`, `playing`, `waiting`, `ended`, `emptied`,
   `timeupdate`). There is no element, so `mediaEventsBetween` derives the same
   events from two consecutive snapshots, in the order an <audio> element fires
   them (a file that runs out fires `pause` BEFORE `ended`), and a visible-only
   1 Hz ticker stands in for `timeupdate` while audio is flowing. */

import { lastEpisodeRow as lastEpisodeRowOf } from "./continuation.js";

/** The stand-in for `timeupdate`: once a second, only while visible and only
    while the snapshot says audio is flowing. 1 Hz is the engine's own snapshot
    rate (§5.4); an element's 4 Hz would repaint a scrubber that has nothing
    new to show between snapshots but extrapolation. */
export const MEDIA_TICK_MS = 1000;

/** What an engine that has said nothing yet looks like: idle. */
const NOTHING = Object.freeze({
  state: "idle", running: false, ended: false, buffering: false, inSeamGap: false,
  itemId: null, positionSec: 0,
});

/** Audio is actually flowing, as far as the snapshot can say. */
const flowing = (s) => s.running === true && s.state === "playing" && s.buffering !== true && s.inSeamGap !== true;

/**
 * The element events an <audio> element would have fired between two
 * snapshots, in its order. Pure, so the mapping is testable without a clock.
 *
 *   another item loaded            emptied
 *   not running -> running         play, then playing (or waiting if stalled)
 *   running, stall begins          waiting
 *   running, stall ends / flows    playing
 *   running -> ended               pause, ended      (runOut's order)
 *   running -> not running         pause
 *   a position that moved          timeupdate        (last: a seek repaints)
 */
export function mediaEventsBetween(prev, next) {
  const a = prev ?? NOTHING;
  const b = next ?? NOTHING;
  const out = [];
  if (a.itemId && b.itemId && a.itemId !== b.itemId) out.push("emptied");
  if (!a.running && b.running) {
    out.push("play");
    if (b.buffering) out.push("waiting");
    else if (flowing(b)) out.push("playing");
  } else if (a.running && b.running) {
    if (!a.buffering && b.buffering) out.push("waiting");
    else if (!flowing(a) && flowing(b)) out.push("playing");
  } else if (a.running && !b.running) {
    out.push("pause");
    if (b.ended && !a.ended) out.push("ended");
  } else if (b.ended && !a.ended) {
    out.push("ended");
  }
  if (a.positionSec !== b.positionSec || a.itemId !== b.itemId) out.push("timeupdate");
  return out;
}

/**
 * The backend client.js reads, answered by the engine.
 */
export class NativeBackendFacade {
  /**
   * @param {object} opts
   * @param {object} opts.engine      native-engine.js's client
   * @param {object} [opts.scheduler] `{schedule(ms, fn) -> cancel}`; the ticker's
   * @param {number} [opts.tickMs]
   */
  constructor({ engine, scheduler = engine.scheduler, tickMs = MEDIA_TICK_MS }) {
    this.engine = engine;
    this._scheduler = scheduler;
    this._tickMs = tickMs;
    this._listeners = new Map();
    this._prev = null;
    this._cancelTick = null;
    this._released = false;
  }

  /** `backend.addMediaListener(type, fn)`: the same idempotent registry
      HtmlAudioBackend keeps, so a double registration fires once. */
  addMediaListener(type, fn) {
    if (typeof fn !== "function") return;
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }

  removeMediaListener(type, fn) { this._listeners.get(type)?.delete(fn); }

  _fire(type) {
    for (const fn of [...(this._listeners.get(type) ?? [])]) {
      try { fn({ type }); } catch (_) { /* one surface's bad handler must not silence the rest */ }
    }
  }

  /** The playhead, extrapolated from the page's receipt of the latest snapshot
      and frozen while nothing is flowing (engine-contract.js `extrapolate`). */
  get currentTime() { return this.engine.positionAt(); }

  /** Seconds, or null while unknown — HtmlAudioBackend's own contract, so the
      bar paints EMPTY for an unknown duration rather than the last episode's. */
  get duration() {
    const d = this.engine.latest()?.snapshot?.durationSec;
    return typeof d === "number" && Number.isFinite(d) && d > 0 ? d : null;
  }

  /** The rate the engine is playing at. */
  get rate() {
    const r = this.engine.latest()?.snapshot?.rate;
    return typeof r === "number" && r > 0 ? r : 1;
  }

  get paused() { return !this.engine.latest()?.snapshot?.running; }
  get ended() { return this.engine.latest()?.snapshot?.ended === true; }

  /** A tap's autoplay grant is a WebKit element rule. The engine's AVPlayer
      needs none, so there is nothing to spend. */
  notePlayGesture() {}

  release() {
    this._released = true;
    this._stopTick();
  }

  /** A snapshot became current: fire what an element would have, and keep the
      ticker's running state in step. */
  onSnapshot(next) {
    if (this._released) return;
    const events = mediaEventsBetween(this._prev, next);
    this._prev = next;
    for (const type of events) this._fire(type);
    this._syncTick();
  }

  onVisibility() { this._syncTick(); }

  _syncTick() {
    const s = this.engine.latest()?.snapshot;
    const want = !this._released && this.engine.visible && Boolean(s) && flowing(s);
    if (want && !this._cancelTick) this._armTick();
    else if (!want) this._stopTick();
  }

  _armTick() {
    this._cancelTick = this._scheduler.schedule(this._tickMs, () => {
      this._cancelTick = null;
      this._fire("timeupdate");
      this._syncTick();
    });
  }

  _stopTick() {
    if (this._cancelTick) { this._cancelTick(); this._cancelTick = null; }
  }
}

/**
 * The manager client.js reads, answered by the engine. The constructor takes
 * the same repaint hooks PlayerQueueManager does (onStateSettled,
 * onSeamGapChange, onNarrationTick), fired from snapshots instead of effects.
 */
export class NativeManagerFacade {
  constructor({
    engine, rate = 1, voice = null, interludeEnabled = true,
    onStateSettled = null, onSeamGapChange = null, onNarrationTick = null,
    lastEpisodeRow = lastEpisodeRowOf,
  }) {
    this.engine = engine;
    /* LOCAL: the page owns cp_rate / cp_voice / cp_interlude and paints the
       label from here the instant it is chosen. A snapshot captured before the
       engine applied the change must not flip the label back. */
    this._rate = rate;
    this._voice = typeof voice === "string" && voice ? voice : null;
    this._interludeEnabled = interludeEnabled !== false;
    this._queue = [];
    this._lastEpisodeRow = lastEpisodeRow;
    this._onStateSettled = typeof onStateSettled === "function" ? onStateSettled : null;
    this._onSeamGapChange = typeof onSeamGapChange === "function" ? onSeamGapChange : null;
    this._onNarrationTick = typeof onNarrationTick === "function" ? onNarrationTick : null;
    this._prevGap = false;
    /** The last refusal the engine gave a transport call, for the bar's copy. */
    this.lastRefusal = null;
  }

  _s() { return this.engine.latest()?.snapshot ?? null; }

  /* ---------- what client.js reads ---------- */

  /** `{type}` (plus `wasPlaying` while interrupted): the reducer's shape. */
  get state() {
    const s = this._s();
    if (!s) return { type: "idle" };
    return s.state === "interrupted" ? { type: s.state, wasPlaying: s.wasPlaying === true } : { type: s.state };
  }

  get currentIndex() {
    const s = this._s();
    return s && Number.isInteger(s.index) ? s.index : -1;
  }

  /** The page's pick while it is what the engine holds; otherwise what the
      engine says it holds — a page booted while the engine was already
      playing has no pick of its own, and must not report an empty queue. */
  get queue() {
    const s = this._s();
    if (!s?.itemId) return this._queue;
    if (this._queue.some((i) => i?.id === s.itemId)) return this._queue;
    return [{ id: s.itemId, kind: s.itemKind ?? "episode", title: s.nowPlaying?.title ?? "" }];
  }

  get inSeamGap() { return this._s()?.inSeamGap === true; }
  get inInterlude() { return this._s()?.inInterlude === true; }
  get playheadItemId() { return this._s()?.playheadItemId ?? null; }
  get isNarrationPlayhead() { return this._s()?.isNarrationPlayhead === true; }
  get narrationElapsedSec() {
    const n = this._s()?.narrationElapsedSec;
    return typeof n === "number" ? n : null;
  }

  /** Is sound coming out, by the ENGINE's word (#689). False for a spoken
      line, as the manager's is: client.js composes it with isRunning. */
  get elementIsAudible() {
    const s = this._s();
    return Boolean(s) && !s.isNarrationPlayhead && flowing(s);
  }

  get lastVoiceFallback() {
    const v = this._s()?.voiceFallback;
    return v == null ? null : Boolean(v);
  }

  /** Whether next / previous are offered: the ENGINE's answer (the page's
      chain as the engine holds it, §5.5), so the steering wheel and the bar
      offer exactly what a press would do. */
  get canNext() { return this._s()?.canNext === true; }
  get canPrevious() { return this._s()?.canPrevious === true; }

  get rate() { return this._rate; }
  get voice() { return this._voice; }
  get interludeEnabled() { return this._interludeEnabled; }

  /* ---------- the transport, as intents ---------- */

  async _send(cmd, args, source) {
    const reply = await this.engine.send(cmd, args, { source: source ?? "tap" });
    this.lastRefusal = reply.ok ? null : reply.reason;
    return reply.ok === true;
  }

  /** The strategy's queue for a pick: the pick. */
  setQueueFromPick(item) {
    this._queue = item ? [item] : [];
    return this._queue;
  }

  loadQueue(items) { this._queue = (items || []).filter(Boolean); }

  /**
   * Play the picked item. ONE command carrying its own start (`startSec`), never
   * a play followed by a seek: a press inside the load window must not be able
   * to land the seek on whatever loaded next (audit round 2, races-1). An item
   * with no id sends nothing — the engine could not store a pointer for it.
   * @returns {Promise<boolean>} whether the engine took it
   */
  async play(index = 0, opts = {}) {
    const item = this._queue[index];
    if (!item?.id) return false;
    const args = { item, lastEpisodeRow: this._lastEpisodeRow(item) ?? { id: item.id } };
    const at = Number(opts?.startOffset);
    if (opts?.startOffset != null && Number.isFinite(at) && at >= 0) args.startSec = at;
    return this._send("playEpisode", args, opts?.source);
  }

  resume(opts) { return this._send("play", undefined, opts?.source); }
  pause(opts) { return this._send("pause", undefined, opts?.source); }
  toggle(opts) { return this._send("toggle", undefined, opts?.source); }
  stop(opts) { return this._send("stop", { persist: true }, opts?.source); }
  skipToNext(opts) { return this._send("next", undefined, opts?.source); }
  skipToPrevious(opts) { return this._send("previous", undefined, opts?.source); }
  seek(seconds, opts) {
    const sec = Number(seconds);
    return this._send("seekTo", { sec: Number.isFinite(sec) ? Math.max(0, sec) : 0 }, opts?.source);
  }

  setRate(rate) {
    this._rate = rate;
    return this._send("setRate", { rate });
  }

  setVoice(id) {
    this._voice = typeof id === "string" && id ? id : null;
    return this._send("setVoice", { voiceId: this._voice });
  }

  setInterludeEnabled(on) {
    this._interludeEnabled = on !== false;
    return this._send("setInterludeEnabled", { enabled: this._interludeEnabled });
  }

  /* ---------- coming back ---------- */

  /**
   * `reconcileOnReturn` becomes this (§5.6). A READ of the engine's snapshot:
   * the belief is replaced by the engine's word, and nothing is sent, so
   * coming back to the page can never start audio.
   * @returns {Promise<boolean>} true iff the belief actually changed
   */
  async attach(_why = "visible") {
    const before = beliefKey(this._s());
    await this.engine.read("snapshot");
    return beliefKey(this._s()) !== before;
  }

  /** The manager's name for it; client.js calls this on every return. */
  reconcileWithBackend(why) { return this.attach(why); }

  /* The engine owns the session in native mode (§4.4): a route change or an
     interruption reaches IT through AVAudioSession, not the page through the
     legacy plugin's events. These exist so a stray legacy event is a no-op,
     never a second decision about the same interruption. */
  async routeChanged() { return false; }
  async interruptionBegan() { return false; }
  async interruptionEnded() { return false; }

  /** Positions are the engine's rows (OWNED_PREFIXES); the page writes none. */
  _persistPosition() {}

  /** M1: Forays play in the JS player after an ordered relinquish (NE-22). A
      Foray reaching the facade is a missed relinquish, and saying so loudly
      beats a silent tap. */
  setQueueFromForay() {
    throw new Error("capability-off: the native engine does not play Forays in this build — relinquish first (NE-22)");
  }

  /* ---------- repaint hooks ---------- */

  onSnapshot(next) {
    const gap = next?.inSeamGap === true;
    if (gap !== this._prevGap) { this._prevGap = gap; this._onSeamGapChange?.(gap); }
    if (next?.isNarrationPlayhead) this._onNarrationTick?.();
    this._onStateSettled?.(this.state);
  }

  dispose() {}
}

/** What `attach` compares: the reads a surface paints from. */
function beliefKey(s) {
  if (!s) return "none";
  return JSON.stringify([s.state, s.running, s.ended, s.buffering, s.itemId, s.playheadItemId, s.index]);
}

/**
 * Both facades over one engine client, on one subscription: the backend's
 * media events fire before the manager's settled hook, the order an element
 * event and the reducer's settle arrive in.
 * @returns {{manager: NativeManagerFacade, backend: NativeBackendFacade, dispose: Function}}
 */
export function createNativeFacades({ engine, scheduler, tickMs, ...managerOpts }) {
  const backend = new NativeBackendFacade({ engine, scheduler, tickMs });
  const manager = new NativeManagerFacade({ engine, ...managerOpts });
  const off = engine.subscribe((ev) => {
    if (ev.type === "snapshot") {
      backend.onSnapshot(ev.snapshot);
      manager.onSnapshot(ev.snapshot);
    } else if (ev.type === "visibility") {
      backend.onVisibility();
    }
  });
  // An engine already holding a snapshot (hello answered first) is painted now.
  const s = engine.latest()?.snapshot;
  if (s) { backend.onSnapshot(s); manager.onSnapshot(s); }
  return {
    manager, backend,
    dispose() { off(); backend.release(); manager.dispose(); },
  };
}
