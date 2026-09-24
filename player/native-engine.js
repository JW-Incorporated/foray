/* The page's client for the native iOS playback engine (docs/native-engine-plan.md
   §4.6, §5; card NE-21).

   WHAT THIS MODULE IS. The one place the page talks to the engine: the three
   bridge methods (engineHello, engineSend, engineRead), the "engine" event, and
   the page's own view of the engine's state — the latest snapshot and the page
   clock time it ARRIVED at, which is all extrapolation may subtract from
   (engine-contract.js `extrapolate`). client.js (NE-22) builds exactly one of
   these, awaits `engineModeReady` before building anything audible, and reads
   the engine only through it and the facades in native-facades.js.

   WHAT IT DECIDES, AND WHAT IT DOES NOT. It decides nothing about playback. It
   decides three things about the WIRE, each of which is a way a stale or
   hostile answer could otherwise reach the listener:

     - the MODE, once: engineHello answered in time, well-formed, native and on
       our protocol -> native; anything else -> the JS player. When an engine
       might be running and the page is about to run JS anyway (no answer, an
       unreadable one, a protocol mismatch) it sends relinquish{cap: "all"}
       BEFORE resolving, so there is never a native and a JS producer at once
       (plan §3 A-2). decideMode is engine-contract.js's, not restated here.
     - which SNAPSHOT is current: every snapshot — a send's reply, a read, an
       event — is validated against the contract schema and ordered by
       (seq, capturedAtMonotonicMs). An older one is dropped, not applied, so a
       reply that crossed an event on the bridge can never walk the page back.
     - how often SUBSCRIBERS hear about it: a burst of snapshots arriving in one
       turn (a WebView resumed from suspension flushes its queue at once) is
       one notification with the latest, on a microtask.

   NEVER REJECTS. send, read and hello resolve on every path, like the native
   side (§5.1). A failed bridge call is `{ok: false, reason: "bridge-error",
   local: true}` — a page-side reason that never crosses the wire, which is why
   it is not in REFUSALS — because a transport press that throws is a dead
   button, and a dead button in a car is the defect this deck exists to remove.

   HOW IT REACHES THE PLUGIN. Through `window.Capacitor.nativePromise`, exactly
   as durable-store.js reaches Preferences and foray-tts.js reaches its plugin:
   the page needs no import and no bundle, the plugin is compiled into the app
   by `cap sync`. Events arrive through `Capacitor.addListener` (or its thinner
   primitive `nativeCallback`), the pattern foray-media-session.js uses.
   `parity/reference-engine.js` offers the same surface (`asCapacitor()`), so every
   test in this directory drives the real client over a JS engine. */

import {
  PROTOCOL, helloRequest, decideMode, validateSnapshot, validateContract, extrapolate,
} from "./engine-contract.js";

/** The Capacitor plugin the three methods live on (the existing ForayAudio,
    plan §4.1: MPRemoteCommandCenter and AVAudioSession are process-wide, so one
    module owns both). */
export const ENGINE_PLUGIN = "ForayAudio";

/** The event name the engine notifies on (§5.4). */
export const ENGINE_EVENT = "engine";

/** How long the page waits for engineHello before running the JS player
    (§4.6's page boot order: "bounded at 5 s"). The engine's own watchdog is
    15 s, so a page that gave up has always given up first and has already sent
    its relinquish by the time the engine would act alone. */
export const HELLO_TIMEOUT_MS = 5000;

/** The relinquish the page sends when it runs JS over an engine that may be
    running (decideMode's `relinquish: true`). `restore` is the page boot's
    source token (engine-vocabulary.js SOURCES): it is the boot, not a press. */
export const HANDSHAKE_RELINQUISH = Object.freeze({ cmd: "relinquish", args: { cap: "all" }, source: "restore" });

/** Page-side refusal for a bridge call that threw or a payload the page would
    not send. Never on the wire, so never in engine-contract.js REFUSALS. */
export const BRIDGE_ERROR = "bridge-error";

/** Is `err` a Capacitor "this binary has no such method" rejection? An older
    shell answers engineHello that way, and that is `methodPresent: false`
    (plain JS, nothing to relinquish), not a broken engine. Capacitor spells it
    `code: "UNIMPLEMENTED"`; older bridges only word it. */
export function isUnimplemented(err) {
  if (!err) return false;
  if (err.code === "UNIMPLEMENTED") return true;
  return /not implemented|unimplemented/i.test(String(err.message ?? err));
}

/** (seq, capturedAtMonotonicMs), compared. A snapshot is NEWER when its seq is
    higher, or its seq is equal and it was captured later — the same transition
    read again a second later carries a fresher position. Equal on both is the
    same capture delivered twice. */
export function snapshotOrder(a, b) {
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
  const am = a.capturedAtMonotonicMs;
  const bm = b.capturedAtMonotonicMs;
  if (am === bm) return 0;
  return am < bm ? -1 : 1;
}

const REAL_SCHEDULER = Object.freeze({
  schedule(ms, fn) {
    const h = setTimeout(fn, ms);
    return () => clearTimeout(h);
  },
});

/** The bridge, from `window.Capacitor` or anything shaped like it. */
function bridgeOf(capacitor) {
  const cap = capacitor ?? null;
  const platform = (() => {
    try { return typeof cap?.getPlatform === "function" ? cap.getPlatform() : null; } catch (_) { return null; }
  })();
  const available = (() => {
    if (!cap || typeof cap.nativePromise !== "function") return false;
    try {
      return typeof cap.isPluginAvailable === "function" ? cap.isPluginAvailable(ENGINE_PLUGIN) !== false : true;
    } catch (_) { return false; }
  })();
  return {
    platform,
    available,
    call: (method, payload) => Promise.resolve().then(() => cap.nativePromise(ENGINE_PLUGIN, method, payload)),
    listen(fn) {
      try {
        if (typeof cap?.addListener === "function") return cap.addListener(ENGINE_PLUGIN, ENGINE_EVENT, fn);
        if (typeof cap?.nativeCallback === "function") {
          cap.nativeCallback(ENGINE_PLUGIN, "addListener", { eventName: ENGINE_EVENT }, fn);
          return null;
        }
      } catch (_) { /* a page with no event path still works: it reads on visible */ }
      return null;
    },
  };
}

/**
 * The page's engine client.
 *
 * @param {object} opts
 * @param {object} opts.capacitor      `window.Capacitor`, or reference-engine's `asCapacitor()`
 * @param {string} [opts.pageBuild]    the page's build stamp, sent in engineHello
 * @param {Function} [opts.now]        () => ms, the PAGE's clock for receipt times
 * @param {object} [opts.scheduler]    `{schedule(ms, fn) -> cancel}`; the hello bound
 * @param {number} [opts.helloTimeoutMs]
 * @param {Function} [opts.onDiag]     (row) => void, a line for the page's own record
 */
export function createNativeEngine({
  capacitor = typeof window !== "undefined" ? window.Capacitor : null,
  pageBuild = "",
  now = () => Date.now(),
  scheduler = REAL_SCHEDULER,
  helloTimeoutMs = HELLO_TIMEOUT_MS,
  onDiag = null,
} = {}) {
  const bridge = bridgeOf(capacitor);
  const subscribers = new Set();
  let cmdSeq = 0;
  let latest = null;          // {snapshot, receivedAtMs}
  let visible = true;
  let helloPromise = null;
  let decided = null;         // {mode, reason, relinquish, hello}
  let listening = false;
  let pendingNotify = false;
  let pendingEvents = [];
  const stats = { accepted: 0, stale: 0, invalid: 0, invalidEvents: 0, bridgeErrors: 0 };

  const diag = (row) => { try { onDiag?.(row); } catch (_) { /* a record must never cost a press */ } };

  /* ---------- snapshots ---------- */

  /** Take a snapshot if it is valid and newer than the one we hold. Returns
      whether it became current. */
  function accept(snapshot, via) {
    if (!validateSnapshot(snapshot).ok) {
      stats.invalid++;
      diag({ kind: "engine", what: "snapshot-invalid", via });
      return false;
    }
    if (latest && snapshotOrder(snapshot, latest.snapshot) <= 0) {
      stats.stale++;
      return false;
    }
    latest = { snapshot, receivedAtMs: now() };
    stats.accepted++;
    scheduleNotify();
    return true;
  }

  function scheduleNotify() {
    pendingNotify = true;
    flushSoon();
  }

  let flushQueued = false;
  function flushSoon() {
    if (flushQueued) return;
    flushQueued = true;
    queueMicrotask(flush);
  }

  /* The snapshot first, then the other events in arrival order: a subscriber
     that repaints on `advanced` reads a snapshot at least as new as the one
     the engine sent with it. */
  function flush() {
    flushQueued = false;
    const out = [];
    if (pendingNotify && latest) out.push({ type: "snapshot", snapshot: latest.snapshot, receivedAtMs: latest.receivedAtMs });
    pendingNotify = false;
    out.push(...pendingEvents);
    pendingEvents = [];
    for (const ev of out) {
      for (const fn of [...subscribers]) {
        try { fn(ev); } catch (err) { diag({ kind: "engine", what: "subscriber-threw", message: String(err?.message ?? err) }); }
      }
    }
  }

  function onEvent(ev) {
    if (!validateContract("event", ev).ok) {
      stats.invalidEvents++;
      diag({ kind: "engine", what: "event-invalid" });
      return;
    }
    if (ev.type === "snapshot") { accept(ev.snapshot, "event"); return; }
    pendingEvents.push(ev);
    flushSoon();
  }

  function ensureListening() {
    if (listening) return;
    listening = true;
    bridge.listen((ev) => onEvent(ev));
  }

  /* ---------- the handshake ---------- */

  /** One engineHello per page, bounded. Resolves {mode, reason, hello}. */
  function hello() {
    if (helloPromise) return helloPromise;
    helloPromise = (async () => {
      const platform = bridge.platform;
      let methodPresent = bridge.available;
      let answer = null;
      if (platform === "ios" && methodPresent) {
        ensureListening();
        answer = await new Promise((resolve) => {
          let done = false;
          const finish = (v) => { if (!done) { done = true; cancel(); resolve(v); } };
          const cancel = scheduler.schedule(helloTimeoutMs, () => {
            diag({ kind: "engine", what: "hello-timeout", ms: helloTimeoutMs });
            finish(null);
          });
          bridge.call("engineHello", helloRequest(pageBuild)).then(
            (h) => finish(h ?? null),
            (err) => {
              if (isUnimplemented(err)) methodPresent = false;
              diag({ kind: "engine", what: "hello-rejected", message: String(err?.message ?? err) });
              finish(null);
            },
          );
        });
      }
      const verdict = decideMode({ platform, methodPresent, hello: answer });
      decided = { ...verdict, hello: verdict.mode === "native" ? answer : null };
      diag({ kind: "engine", what: "mode", mode: verdict.mode, reason: verdict.reason });
      if (verdict.relinquish) {
        /* SENT, NOT AWAITED. The reply may never come — a hung hello is the
           usual reason we are here — and the page must not wait on it before
           running the player. The call has left the page before this promise
           resolves, which is the ordering A-2 needs: the engine sees the
           relinquish before the page can build a single audible thing. */
        send(HANDSHAKE_RELINQUISH.cmd, HANDSHAKE_RELINQUISH.args, { source: HANDSHAKE_RELINQUISH.source });
      }
      if (verdict.mode === "native" && answer.snapshot) accept(answer.snapshot, "hello");
      return decided;
    })();
    return helloPromise;
  }

  /* ---------- commands and reads ---------- */

  /**
   * engineSend. Always resolves `{ok, reason?, snapshot}`; the reply's snapshot
   * is offered to `accept` like any other.
   */
  async function send(cmd, args, { source = "tap" } = {}) {
    const payload = { v: PROTOCOL, cmdSeq: ++cmdSeq, cmd, source, issuedAtWallMs: Math.max(0, now()) };
    if (args !== undefined) payload.args = args;
    /* A payload the contract would refuse never crosses: the engine would
       answer unknown-cmd anyway (NE-20), and a page bug is cheaper to see in
       the page's own record than in a native row. */
    const check = validateContract("sendRequest", payload);
    if (!check.ok) {
      diag({ kind: "engine", what: "send-refused-locally", cmd, errors: check.errors.slice(0, 3) });
      return { ok: false, reason: "unknown-cmd", snapshot: latest?.snapshot ?? null, local: true };
    }
    let reply;
    try {
      reply = await bridge.call("engineSend", payload);
    } catch (err) {
      stats.bridgeErrors++;
      diag({ kind: "engine", what: "send-failed", cmd, message: String(err?.message ?? err) });
      return { ok: false, reason: BRIDGE_ERROR, snapshot: latest?.snapshot ?? null, local: true };
    }
    if (!validateContract("sendResponse", reply).ok) {
      stats.invalid++;
      diag({ kind: "engine", what: "reply-invalid", cmd });
      return { ok: false, reason: BRIDGE_ERROR, snapshot: latest?.snapshot ?? null, local: true };
    }
    accept(reply.snapshot, `send:${cmd}`);
    return reply;
  }

  /** engineRead. `what` is snapshot | rows | diagnostics. Resolves the reply,
      or null when the bridge failed or answered something unreadable. */
  async function read(what, { prefixes } = {}) {
    const payload = prefixes ? { what, prefixes } : { what };
    let reply;
    try {
      reply = await bridge.call("engineRead", payload);
    } catch (err) {
      stats.bridgeErrors++;
      diag({ kind: "engine", what: "read-failed", read: what, message: String(err?.message ?? err) });
      return null;
    }
    /* A read answers with the page's CURRENT belief, which is the reply or
       something newer: a read can lose the race to an event too. */
    if (what === "snapshot") return accept(reply, "read") || validateSnapshot(reply).ok ? latest.snapshot : null;
    const kind = what === "rows" ? "rowsResponse" : "diagnosticsResponse";
    return validateContract(kind, reply).ok ? reply : null;
  }

  /* ---------- the page's side of visibility ---------- */

  /** The page became visible or hidden (visibilitychange, pageshow, resume).
      The engine gates its events on this (§5.4); coming back, the page READS
      the snapshot rather than waiting for an event that may have been dropped
      while it slept. */
  async function setVisible(v) {
    visible = v === true;
    /* Told to subscribers too, as a PAGE-LOCAL event (never on the wire, so
       not in EVENTS): the backend facade's ticker runs only while visible. */
    pendingEvents.push({ type: "visibility", visible, local: true });
    flushSoon();
    await send("setPageVisible", { visible }, { source: "restore" });
    if (visible) await read("snapshot");
  }

  return {
    hello,
    get engineModeReady() { return hello(); },
    /** The decided mode, or null before the handshake settles. */
    get mode() { return decided?.mode ?? null; },
    get decision() { return decided; },
    send,
    read,
    setVisible,
    get visible() { return visible; },
    /** `{snapshot, receivedAtMs}` or null: the page's current belief. */
    latest: () => latest,
    /** Where the playhead is at page time `atMs` (default now), per §5.4. */
    positionAt(atMs = now()) {
      return latest ? extrapolate(latest.snapshot, latest.receivedAtMs, atMs) : 0;
    },
    /** Hear snapshots (coalesced) and events. Returns unsubscribe. */
    subscribe(fn) {
      if (typeof fn !== "function") return () => {};
      ensureListening();
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    now,
    scheduler,
    stats,
  };
}
