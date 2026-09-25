/* The reference engine: protocol v1 spoken by the REAL PlayerQueueManager over
   recording fakes, with the warm handover ON (docs/native-engine-plan.md §5.6,
   §6; card NE-21).

   WHAT IT IS FOR. The page's engine client (native-engine.js) and the facades
   (native-facades.js) are written against a native engine that does not exist
   on this machine and cannot be compiled on it. This file is that engine's JS
   stand-in, so everything page-side is exercised end to end under `node
   --test`: the handshake, every command, the snapshot, the events, the rows.
   NE-22's native-mode.test.js boots the real client.js against it
   (`asCapacitor()` is a `window.Capacitor`), and NE-30j records the `prepare`
   parity family against it.

   WHY THE REAL MANAGER, NOT A MODEL OF ONE. JS is the reference (plan §6). An
   engine written here from the contract would be a second opinion about
   playback, and a page tested against a second opinion is tested against
   nothing. So every transport rule a command reaches — the reducer, the seam
   beat, pendingSeek, the resume row — is queue-manager.js's own, and the only
   things this file owns are what the manager never had: the SESSION (the
   engine-contract.js SessionPolicy table, driving a fake activation), the
   CONTINUATION walk (the page precomputes hops, the engine walks them, §5.5),
   the owned ROWS and the pending logs, and the wire.

   WARM HANDOVER ON. The manager warms the next segment only for a backend
   that implements `prefetch` (queue-manager.js §11), and the shipping
   HtmlAudioBackend keeps it parked. The native engine's DeckPair (NE-32) DOES
   prepare the next segment on a standby deck, so the only JS path to that
   behaviour is here: `WarmingBackend` implements `prefetch`, and a load that
   finds its segment warm writes `n.handover:<id>@<offset>` BEFORE the ordinary
   `load:` token. The `n.*` tokens are native-only and compare.js strips them
   everywhere except the `prepare` family, so a scenario run here and run over
   the plain FakeBackend read the same op log once they are stripped — the
   handover changes WHEN, never WHAT.

   WHAT IS NOT MODELLED, and not claimed: AVFoundation. There is no rendering,
   no route, no real session. `activation` is a function the test controls, a
   stall is a flag the test sets (`deck("stall")`), and time moves only when
   the scheduler does. The engine's 1 Hz event coalescing IS modelled, because
   the page's handling of it is exactly what the page tests need to see.

   WHY IT LIVES IN player/parity/, NOT player/. Every top-level player/*.js
   ships: the deploy manifest lists it and index.html modulepreloads it
   (boot-path.test.js perf-1). This file is test infrastructure built on the
   harness's own fakes, so it sits beside them and never reaches a listener. */

import {
  PROTOCOL, OWNED_PREFIXES, CAPABILITIES, DEFAULT_HOLD_POLICY,
  validateContract, sessionTransition, sessionFailedReason,
} from "../engine-contract.js";
import { PlayerQueueManager } from "../queue-manager.js";
import { PositionStore } from "../position-store.js";
import { OpLog, FakeBackend, MemoryStore, fakeTts } from "./fakes.js";
import { warmOffset, prefetchDecision, warmPromotion } from "../deck-policy.js";

/** What `engineHello` names this engine. */
export const REFERENCE_ENGINE_VERSION = "reference-1";

/** At most one snapshot event per this many ms while visible (§5.4). */
export const SNAPSHOT_EVENT_MIN_MS = 1000;

/** The key the engine writes the last-played pointer to (episode-progress.js
    KEY; an OWNED_PREFIXES entry). */
const LAST_EPISODE_KEY = "cp_last_episode";

const round = (s) => Math.round(s);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/**
 * FakeBackend with the warm handover. Same tokens as FakeBackend (the manager
 * suites' grammar), plus the native-only `n.prepare:<id>@<s>` when a segment is
 * warmed and `n.handover:<id>@<s>` when a load finds it warm.
 *
 * THE DECISIONS ARE THE REAL ONES (NE-30j). Whether to warm and whether a warm
 * load may be promoted are deck-policy.js `prefetchDecision` and
 * `warmPromotion` — what HtmlAudioBackend asks and what the native DeckPair
 * answers identically — so a same-episode seam is not warmed here either (the
 * same-source seek covers it), and a load is handed over only for the SOURCE
 * and in-point that were warmed. A warm load here is ready at once: there is no
 * network, so the race is always won; losing it is the deck family's case.
 */
export class WarmingBackend extends FakeBackend {
  constructor(opts = {}) {
    super(opts);
    this._warm = null;
    this._currentUrl = null;
    /** Assigned by the manager when `prefetch` exists (queue-manager.js §11). */
    this.onPrefetchWindow = null;
    this.ended = false;
  }
  prefetch(item, { startOffset = 0 } = {}) {
    const offset = round(warmOffset(startOffset));
    const decision = prefetchDecision({
      available: true, url: item?.audio_url, currentUrl: this._currentUrl, warm: this._warm, offsetSec: offset,
    });
    if (decision === "already") { this._warm.id = item.id; return true; }
    if (decision !== "start") return false;
    this._warm = { id: item.id, url: item.audio_url, offset, ready: true, failed: false };
    this.log.push(`n.prepare:${item.id}@${offset}`);
    return true;
  }
  async load(item, opts = {}) {
    const offset = round(warmOffset(opts.startOffset ?? 0));
    const warm = this._warm;
    this._warm = null;
    const verdict = warmPromotion({ warm, url: item?.audio_url, offsetSec: offset, canPlay: true, atSec: offset });
    if (verdict === "promote") this.log.push(`n.handover:${item.id}@${offset}`);
    this.ended = false;
    this._currentUrl = item?.audio_url ?? null;
    return super.load(item, opts);
  }
  /** The playhead is PREFETCH_LEAD_SEC from an armed out-point while audible:
      what html-audio-backend.js's `_maybeOpenPrefetchWindow` answers. */
  openPrefetchWindow() {
    if (this.outPoint == null || this.paused) return false;
    this.onPrefetchWindow?.();
    return true;
  }
}

/** A scheduler on the wall clock, for a page booted against this engine in a
    test that does not drive time itself. */
const realScheduler = () => ({
  nowMs: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  schedule(ms, fn) {
    const h = setTimeout(fn, ms);
    return () => clearTimeout(h);
  },
});

/** How a command's `source` reaches SessionPolicy's `userPlay` (PLAY_VIAS). */
const viaOf = (source) => (source === "remote" ? "remote" : source === "autoresume" ? "autoresume" : "tap");

/**
 * @param {object} [opts]
 * @param {string[]} [opts.capabilities]  advertised; default episode, continuation, restore
 * @param {string} [opts.mode]            engineHello's `mode` (native | legacy)
 * @param {string} [opts.reason]          engineHello's `reason`
 * @param {number} [opts.protocol]        engineHello's `protocol` (a mismatch test sets 2)
 * @param {object} [opts.scheduler]       `{nowMs, schedule}`; the manager's and the coalescer's
 * @param {Function} [opts.now]           () => wall ms, for rows and `at` stamps
 * @param {Function} [opts.activation]    () => {ok, token?}: setActive(true)'s answer
 * @param {object} [opts.catalogue]       item_id -> episode row, a Foray's resolver table
 * @param {OpLog} [opts.log]              the shared op log
 * @param {object} [opts.backend]         FakeBackend options (failLoadFor, durationById, ...)
 */
export class ReferenceEngine {
  constructor({
    capabilities = ["episode", "continuation", "restore"],
    mode = "native", reason = "build-default", protocol = PROTOCOL,
    scheduler = realScheduler(), now = () => Date.now(),
    activation = () => ({ ok: true }),
    catalogue = {}, log = new OpLog(), backend = {},
    holdPolicy = DEFAULT_HOLD_POLICY, seamGapSec,
  } = {}) {
    this.log = log;
    this.scheduler = scheduler;
    this.now = now;
    this.activation = activation;
    this.catalogue = catalogue;
    this.capabilities = capabilities.filter((c) => CAPABILITIES.includes(c));
    this.mode = mode;
    this.reason = reason;
    this.protocol = protocol;
    this.holdPolicy = holdPolicy;
    this.modeOverride = "auto";

    /** Owned rows (cp_pos:, cp_foray:, cp_last_episode), exactly as stored. */
    this.storage = new MemoryStore();
    this.backend = new WarmingBackend({ log, ...backend });
    this.tts = fakeTts({ log });
    this.positions = new PositionStore({
      storage: this.storage,
      now: () => new Date(this.now()),
      // §5.5: the once-a-minute PositionStore.onSave rule feeds pendingEvents.
      onSave: (id, seconds, meta) => this._pushEvent({
        kind: "position", episode_id: id, seconds, duration: meta?.duration ?? null, at: this.now(),
      }),
    });

    this.manager = new PlayerQueueManager({
      backend: this.backend,
      positionStore: this.positions,
      scheduler,
      tts: this.tts,
      allowMultiple: true,
      ...(seamGapSec !== undefined ? { seamGapSec } : {}),
      onStateSettled: () => this._onSettled(),
      onSeamGapChange: () => this._transition(),
    });

    this.session = "inactive";
    this.relinquished = false;
    this.visible = true;
    this.listeners = new Set();
    this.diagnostics = [];
    this.advanceLog = [];
    this.pendingEvents = [];
    this.continuation = null;     // {planSeq, autoAdvance, chain: [hop]}
    this.playing = null;          // {kind: "episode" | "foray", forayId?, title?}
    this.buffering = false;
    this.lastError = null;
    this.lastCmdSeq = null;

    this._seq = 0;
    this._eventSeq = 0;
    this._lastBody = null;
    this._snapshot = null;
    this._coalescing = false;
    this._dirty = false;
    this._queue = Promise.resolve();
    this._walking = false;
  }

  /* ---------- the three bridge methods (§5.1) ---------- */

  async engineHello(payload) {
    if (!validateContract("helloRequest", payload).ok) this._row({ kind: "hello", invalid: true });
    if (this.mode !== "native") return clone({ mode: this.mode, reason: this.reason, protocol: this.protocol });
    return clone({
      mode: "native", reason: this.reason, engineVersion: REFERENCE_ENGINE_VERSION, protocol: this.protocol,
      capabilities: this.capabilities, ownedKeyPrefixes: [...OWNED_PREFIXES],
      snapshot: this.snapshot(),
      pendingAdvances: this.advanceLog, pendingEvents: this.pendingEvents,
    });
  }

  /** Serial, like the engine on main: a command runs to completion (every
      manager effect settled) before the next one starts. */
  engineSend(payload) {
    const run = this._queue.then(() => this._send(payload));
    this._queue = run.catch(() => {});
    return run.then(clone);
  }

  async engineRead(payload) {
    if (!validateContract("readRequest", payload).ok) {
      // An unowned or unknown prefix reads NOTHING rather than something
      // (NE-20: shared rows only).
      return payload?.what === "diagnostics" ? { rows: [] } : payload?.what === "snapshot" ? clone(this.snapshot()) : { rows: {} };
    }
    if (payload.what === "snapshot") return clone(this.snapshot());
    if (payload.what === "diagnostics") return clone({ rows: this.diagnostics });
    const prefixes = payload.prefixes ?? [...OWNED_PREFIXES];
    const rows = {};
    for (let i = 0; i < this.storage.length; i++) {
      const k = this.storage.key(i);
      if (prefixes.some((p) => k.startsWith(p))) rows[k] = this.storage.getItem(k);
    }
    return clone({ rows });
  }

  /** `addListener("engine", fn)`. Delivery is async (a notifyListeners crosses
      the bridge), and every payload is a JSON copy. */
  addListener(fn) {
    this.listeners.add(fn);
    return { remove: () => this.listeners.delete(fn) };
  }

  /** A `window.Capacitor` whose ForayAudio plugin is this engine. */
  asCapacitor({ platform = "ios", methods = ["engineHello", "engineSend", "engineRead"] } = {}) {
    return {
      getPlatform: () => platform,
      isNativePlatform: () => platform !== "web",
      isPluginAvailable: (name) => name === "ForayAudio",
      nativePromise: (plugin, method, payload) => {
        if (plugin !== "ForayAudio" || !methods.includes(method)) {
          return Promise.reject(Object.assign(new Error(`${plugin}.${method}() is not implemented on ios`), { code: "UNIMPLEMENTED" }));
        }
        return this[method](payload);
      },
      addListener: (plugin, event, fn) => (plugin === "ForayAudio" && event === "engine" ? this.addListener(fn) : { remove() {} }),
    };
  }

  /* ---------- the harness's hands ---------- */

  /**
   * What the world does to the deck, the parity `deck` verb's vocabulary plus
   * the two only an engine has: `window` (the prefetch window opened) and
   * `stall` / `flowing` (waitingToPlayAtSpecifiedRate, and back).
   */
  async deck(event, arg) {
    const b = this.backend;
    /* An end or an error is FLOATED, not awaited, as the parity runner floats
       its `deck` verbs: at a seam the manager's handler holds the beat on the
       scheduler, so awaiting it here would wait on a clock only the caller can
       move. */
    const float = (p) => { Promise.resolve(p).catch(() => {}); };
    if (event === "ended") { b.ended = true; b.paused = true; float(b.onItemEnded?.(arg ?? "natural")); }
    else if (event === "error") float(b.onError?.(arg ?? "error"));
    else if (event === "time") b.currentTime = arg;
    else if (event === "duration") b.duration = arg;
    else if (event === "window") b.openPrefetchWindow();
    else if (event === "stall") this.buffering = true;
    else if (event === "flowing") this.buffering = false;
    else throw new RangeError(`unknown deck event ${JSON.stringify(event)}`);
    await this._queue;
    await new Promise((r) => setImmediate(r));
    this._transition();
  }

  dispose() { this.manager.dispose(); }

  /* ---------- the snapshot (§5.3) ---------- */

  _currentItem() {
    const m = this.manager;
    return m.queue[m.currentIndex] ?? null;
  }

  /** Everything but the capture stamps; `seq` moves when this changes. */
  _body() {
    const m = this.manager;
    const type = m.state?.type ?? "idle";
    const item = this.playing ? this._currentItem() : null;
    const loaded = Boolean(item) && m.playheadItemId != null;
    const running = ["playing", "loadingItem", "transitioning"].includes(type);
    const inSeamGap = m.inSeamGap === true;
    const rate = m.rate;
    const body = {
      v: PROTOCOL,
      mode: this.playing ? this.playing.kind : "none",
      ...(this.playing?.forayId ? { forayId: this.playing.forayId } : {}),
      index: item ? m.currentIndex : null,
      itemId: item?.id ?? null,
      itemKind: item?.kind ?? null,
      state: type,
      ...(type === "interrupted" ? { wasPlaying: m.state.wasPlaying === true } : {}),
      running,
      inSeamGap,
      inInterlude: m.inInterlude === true,
      buffering: this.buffering,
      ended: type === "ended",
      positionSec: Math.max(0, loaded ? this.backend.currentTime : 0),
      durationSec: loaded && Number.isFinite(this.backend.duration) && this.backend.duration > 0 ? this.backend.duration : null,
      sourceTimeSec: loaded ? Math.max(0, this.backend.currentTime) : null,
      playheadItemId: m.playheadItemId ?? null,
      isNarrationPlayhead: m.isNarrationPlayhead === true,
      rate,
      effectiveRate: type === "playing" && !inSeamGap && !this.buffering ? rate : 0,
      canNext: this.playing?.kind === "foray"
        ? m.currentIndex >= 0 && m.currentIndex < m.queue.length - 1
        : Boolean(this.continuation?.chain?.length),
      canPrevious: Boolean(item),
      autoAdvance: this.continuation ? this.continuation.autoAdvance : true,
      lastError: this.lastError,
      skippedSegments: 0,
      pendingAdvances: this.advanceLog.length,
      pendingEvents: this.pendingEvents.length,
      session: this.session,
      holdPolicy: this.holdPolicy,
      nowPlaying: {
        title: typeof item?.title === "string" ? item.title : "",
        artist: typeof item?.show === "string" ? item.show : "",
        album: typeof this.playing?.title === "string" ? this.playing.title : "",
      },
    };
    const narr = m.narrationElapsedSec;
    if (Number.isFinite(narr) && narr >= 0) body.narrationElapsedSec = narr;
    return body;
  }

  /** The current snapshot. `seq` is a content version: it moves exactly when
      something other than the capture time changed. */
  snapshot() {
    const body = this._body();
    const key = JSON.stringify(body);
    if (key !== this._lastBody) { this._lastBody = key; this._seq++; }
    this._snapshot = {
      ...body, seq: this._seq,
      capturedAtWallMs: Math.max(0, this.now()),
      capturedAtMonotonicMs: Math.max(0, this.scheduler.nowMs()),
    };
    return this._snapshot;
  }

  /* ---------- events (§5.4) ---------- */

  _emit(ev) {
    const payload = clone(ev);
    for (const fn of [...this.listeners]) queueMicrotask(() => fn(payload));
  }

  /** A transition happened: bump the snapshot and, if visible, send it — at
      most one per SNAPSHOT_EVENT_MIN_MS, the latest winning, and none while
      hidden (the page reads on visible instead). */
  _transition() {
    const before = this._seq;
    this.snapshot();
    if (this._seq === before) return;
    this._dirty = true;
    this._pump();
  }

  _pump() {
    if (!this.visible || this._coalescing || !this._dirty || this.relinquished) return;
    this._dirty = false;
    this._emit({ type: "snapshot", snapshot: this.snapshot() });
    this._coalescing = true;
    this.scheduler.schedule(SNAPSHOT_EVENT_MIN_MS, () => {
      this._coalescing = false;
      this._pump();
    });
  }

  _row(row) {
    this.diagnostics.push({ seq: this.diagnostics.length + 1, at: this.now(), ...row });
  }

  _pushEvent(e) {
    this.pendingEvents.push({ seq: ++this._eventSeq, ...e });
  }

  /* ---------- the session (§4.4), through the JS reference table ---------- */

  _session(input) {
    const t = sessionTransition(this.session, input, this.holdPolicy);
    this.session = t.phase;
    if (t.row) this._row({ kind: "session", row: t.row });
    return t;
  }

  /** userPlay: activate if the policy asks, and feed the answer straight back
      (a request and a response inside one turn, §4.2). Returns null when the
      session is active, or the refusal reason when activation failed — in
      which case the caller must issue NO audible command. */
  _ensureSession(via) {
    const t = this._session({ kind: "userPlay", via });
    if (!t.actions.includes("activate")) return null;
    const answer = this.activation() ?? { ok: true };
    const r = this._session({ kind: "sessionResult", ok: answer.ok === true, token: answer.token });
    this._row({ kind: "session", activate: answer.ok === true ? "ok" : "failed", ...(answer.token ? { token: answer.token } : {}) });
    return r.reason ?? null;
  }

  /* ---------- commands (§5.2) ---------- */

  async _send(payload) {
    const refuse = (reason) => ({ ok: false, reason, snapshot: this.snapshot() });
    const okReply = () => ({ ok: true, snapshot: this.snapshot() });
    if (!validateContract("sendRequest", payload).ok) {
      this._row({ kind: "cmd", invalid: true, cmd: typeof payload?.cmd === "string" ? payload.cmd : null });
      return refuse("unknown-cmd");
    }
    const { cmd, args = {}, source, cmdSeq } = payload;
    // D-4: the source is on record before any no-op return.
    const gap = this.lastCmdSeq !== null && cmdSeq !== this.lastCmdSeq + 1;
    this.lastCmdSeq = cmdSeq;
    this._row({ kind: "cmd", cmd, source, cmdSeq, ...(gap ? { seqGap: true } : {}) });
    if (this.relinquished) {
      /* As EngineBridge.send: "Delete my data" still reaches the store after
         the engine is gone (every Foray tap in M1 relinquishes), because what
         it stored is still on the device. Nothing else is honoured. */
      if (cmd === "purge") { this._purge(); return okReply(); }
      return refuse("relinquished");
    }

    const m = this.manager;
    const result = await (async () => {
      switch (cmd) {
        case "playEpisode": {
          if (!this.capabilities.includes("episode")) return "capability-off";
          const failed = this._ensureSession(viaOf(source));
          if (failed) return failed;
          await this._playEpisode(args.item, args.lastEpisodeRow, args.startSec);
          return null;
        }
        case "playForay": {
          if (!this.capabilities.includes("foray")) return "capability-off";
          const failed = this._ensureSession(viaOf(source));
          if (failed) return failed;
          this.playing = { kind: "foray", forayId: args.forayId, title: args.title };
          const report = m.setQueueFromForay({ id: args.forayId, title: args.title, items: args.items }, {
            isLocalFile: args.isLocalFile, allowAdPad: args.allowAdPad,
            resolveItem: (id) => this.catalogue[id] ?? null,
          });
          if (!report.items.length) { this.playing = null; return "refused-structure"; }
          await m.play(0);
          return null;
        }
        case "setContinuation":
          this.continuation = { planSeq: args.planSeq, autoAdvance: args.autoAdvance, chain: [...args.chain] };
          return null;
        case "play": case "toggle": {
          if (cmd === "toggle" && this._running()) { await this._pause(); return null; }
          if (!this.playing || !this._currentItem()) return "not-loaded";
          const failed = this._ensureSession(viaOf(source));
          if (failed) return failed;
          await m.resume();
          return null;
        }
        case "pause":
          if (!this.playing) return "not-loaded";
          await this._pause();
          return null;
        case "next":
          if (!this.playing) return "not-loaded";
          if (this.playing.kind === "foray") {
            if (m.currentIndex >= m.queue.length - 1) return "no-next";
            await m.skipToNext();
            return null;
          }
          if (!this.continuation?.chain?.length) return "no-next";
          return this._walk(source);
        case "previous":
          if (!this.playing || !this._currentItem()) return "no-previous";
          await m.skipToPrevious();
          return null;
        case "seekBy": case "seekTo": {
          if (!this.playing || !this._currentItem()) return "not-loaded";
          const at = cmd === "seekTo" ? args.sec : Math.max(0, this.backend.currentTime + args.deltaSec);
          await m.seek(at, { precise: true });
          return null;
        }
        case "jump":
          if (!this.playing || args.index >= m.queue.length) return "not-loaded";
          await m.play(args.index);
          return null;
        case "stop":
          await m.stop();
          this._session({ kind: args.persist === false ? "dataDeletion" : "close" });
          if (args.persist === false) this._purge();
          this.playing = null;
          return null;
        case "setRate": m.setRate(args.rate); return null;
        case "setVoice": m.setVoice(args.voiceId); return null;
        case "setInterludeEnabled": m.setInterludeEnabled(args.enabled); return null;
        case "setPageVisible":
          this.visible = args.visible;
          // One snapshot on visible, whatever piled up while hidden (NE-20).
          if (this.visible) { this._dirty = true; this._coalescing = false; this._pump(); }
          return null;
        case "ackAdvances":
          this.advanceLog = this.advanceLog.filter((h) => h.hopSeq > args.upToSeq);
          return null;
        case "ackEvents":
          this.pendingEvents = this.pendingEvents.filter((e) => e.seq > args.upToSeq);
          return null;
        case "restoreBar":
          // Now Playing painted at rate 0 WITHOUT activation (S-3): no session edge.
          this._row({ kind: "nowplaying", restore: true });
          return null;
        case "purge": this._purge(); return null;
        case "relinquish": await this._relinquish(args.cap); return null;
        case "audition": {
          if (this._running()) return "engine-busy";
          const failed = this._ensureSession("auditionTap");
          if (failed) return failed;
          await this.tts.speak(args.text, { rate: 1, ...(args.voiceId ? { voice: args.voiceId } : {}) });
          return null;
        }
        case "setModeOverride": this.modeOverride = args.mode; return null;
        case "setHoldPolicy": this.holdPolicy = args.policy; return null;
        case "probeSession": this._row({ kind: "probe" }); return null;
        /* Developer only (NE-24, DV-7a): the native engine persists its
           restore record and exits at the next background entry while
           paused. The reference has no process to end; it only refuses what
           the Swift refuses, an empty queue. */
        case "simulateTermination":
          if (!this.playing || !this._currentItem()) return "not-loaded";
          this._row({ kind: "restore", event: "sim-termination-armed" });
          return null;
        default: return "unknown-cmd";
      }
    })();
    this._transition();
    return result ? refuse(result) : okReply();
  }

  _running() {
    return ["playing", "loadingItem", "transitioning"].includes(this.manager.state?.type);
  }

  async _pause() {
    await this.manager.pause();
    const t = this._session({ kind: "pause" });
    if (t.actions.includes("deactivate")) this._row({ kind: "session", deactivate: true });
  }

  async _playEpisode(item, lastEpisodeRow, startSec) {
    const m = this.manager;
    this.playing = { kind: "episode" };
    this.lastError = null;
    // Stored verbatim plus the engine's own time (§5.2): byte-for-byte the row
    // the page's makeLastEpisode would have written.
    if (lastEpisodeRow?.id) {
      this.storage.setItem(LAST_EPISODE_KEY, JSON.stringify({ ...lastEpisodeRow, updated_at: new Date(this.now()).toISOString() }));
    }
    m.setQueueFromPick(item);
    await m.play(0, Number.isFinite(startSec) ? { startOffset: startSec } : undefined);
    if (m.playheadItemId !== item.id && m.state?.type !== "loadingItem") this.lastError = "load-failed";
  }

  /** Walk one hop of the page's chain (§5.5): log it, tell the page, play it. */
  async _walk(source) {
    /* A press (a steering-wheel next) is a user play and may activate. An
       autoadvance is not: it walks only on the session the ending episode was
       already holding, because an autoadvance that activated would be an
       audible start nobody caused (the session-invariant family's mutation). */
    if (source !== "autoadvance") {
      const failed = this._ensureSession(viaOf(source));
      if (failed) return failed;
    } else if (this.session !== "active") {
      this._row({ kind: "chain", stop: `session-${this.session}` });
      return null;
    }
    const hop = this.continuation.chain.shift();
    this.advanceLog.push({ planSeq: hop.planSeq, hopSeq: hop.hopSeq, nextId: hop.nextId, at: this.now() });
    this._emit({ type: "advanced", hop: { planSeq: hop.planSeq, hopSeq: hop.hopSeq, nextId: hop.nextId } });
    this._row({ kind: "advance", nextId: hop.nextId, source });
    await this._playEpisode(hop.item ?? { id: hop.nextId }, hop.lastEpisodeRow, undefined);
    if (this.lastError) {
      this._emit({ type: "error", code: "chain-start" });
      return "not-loaded";
    }
    return null;
  }

  _onSettled() {
    this._transition();
    const m = this.manager;
    if (m.state?.type !== "ended" || this.playing?.kind !== "episode" || this._walking) return;
    // Walked on the command queue, never inside the manager's own effect loop.
    this._walking = true;
    this._queue = this._queue.then(async () => {
      try {
        if (!this.continuation?.autoAdvance) { this._row({ kind: "chain", stop: "autoAdvance-off" }); return; }
        if (!this.continuation.chain.length) { this._row({ kind: "chain", exhausted: true }); return; }
        await this._walk("autoadvance");
      } finally {
        this._walking = false;
        this._transition();
      }
    }).catch(() => {});
  }

  _purge() {
    for (const k of [...this.storage.map.keys()]) {
      if (OWNED_PREFIXES.some((p) => k.startsWith(p))) this.storage.removeItem(k);
    }
    this.advanceLog = [];
    this.pendingEvents = [];
  }

  /** §4.6's native side, in its order: stop with persistence, keep the session
      (no deactivate, no notify), go terminal, say so. */
  async _relinquish(cap) {
    await this.manager.stop();
    this._session({ kind: "relinquish" });
    this.relinquished = true;
    this.playing = null;
    this._row({ kind: "mode", reason: "downgrade", cap });
    /* Said once, and only to a visible page, as EngineBridge.transitioned
       says it: a hidden page never hears it, and learns it from the next
       reply or snapshot instead (native-engine.js `handBack`). */
    if (this.visible) this._emit({ type: "modeChanged", mode: "legacy", reason: "downgrade" });
  }
}

/** Build one. */
export function createReferenceEngine(opts) {
  return new ReferenceEngine(opts);
}
