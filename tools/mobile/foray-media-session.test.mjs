/* #27's Android half: the `navigator.mediaSession` polyfill that carries the page's
 * now-playing state to a native Media3 session and routes transport presses back.
 *
 * WHAT THIS SUITE IS WORTH, STATED FIRST — the same sentence
 * `foray-audio-shell.test.mjs` opens with, for the same reason. It drives the real
 * `mobile/plugins/foray-audio/web/foray-media-session.js` against a fake bridge, a
 * fake `navigator` and a fake scheduler, in Node. So it proves the STATE MACHINE and
 * the payload, and it proves nothing whatsoever about Android: no WebView ran, no
 * `MediaSession` was created and no lock screen rendered anything. A green run here
 * is compatible with the lock screen staying blank on a device.
 *
 * WHAT IT IS DESIGNED TO CATCH, which is the part a fake CAN catch:
 *
 *   1. THE POLYFILL IS FAITHFUL ENOUGH FOR `player/media-session.js` TO DRIVE IT.
 *      That module is written for a browser and is not modified by this change, so
 *      the object it finds has to behave like the real one in the four ways it uses:
 *      assignable `metadata` and `playbackState`, `setPositionState` with and without
 *      an argument, `setActionHandler` with a null handler to remove one — and a
 *      THROW on an action we cannot route, because that is what Chromium does and its
 *      per-action `attempt()` guards are written for it. §2 and §7 drive the real
 *      module's own call sequence, not a paraphrase of it.
 *   2. THE WRITE RATE. `client.js` repaints at 4 Hz, so a naive bridge would make
 *      four native calls a second for an hour. Two mechanisms: coalescing per
 *      scheduler turn (one `update()` is three property writes and must be ONE call)
 *      and a 1 s floor on position-only writes — with the identity check ahead of the
 *      floor, so a title change at a seam is never delayed. §4.
 *   3. THE ADDRESS-SPACE TRANSLATION. The app's own artwork URL is correct inside
 *      the WebView and meaningless to a native bitmap loader. §3.
 *   4. THE SEAM WITH THE FOREGROUND SERVICE. `onLoadedChange` is what lets the
 *      service outlive the audio and stop the instant the player closes. §6.
 *
 * ADVERSARIAL PASS, and each of these is a one-line change that left an earlier draft
 * green:
 *   - deleting the identity comparison and rate-limiting EVERYTHING. Caught only by
 *     a test that changes the title INSIDE the interval; a test that changed the
 *     title after 1 s of fake time passed either way.
 *   - deleting the rate limit entirely. Caught only by asserting the CALL COUNT
 *     across several position writes, not by asserting the latest payload.
 *   - returning the metadata object by reference instead of snapshotting it. Caught
 *     only by mutating the caller's object after assigning it.
 *   - dispatching `seekto` with a missing `positionMs` as a seek to 0. Caught only by
 *     asserting the handler was NOT called, since a `seekTime` of 0 is a legal value.
 *   - reporting `loaded` as "anything but idle". Caught only by the FINISHED-Foray
 *     case — and that one was a BLOCKING review finding rather than a hypothetical: a
 *     finished Foray offers no transport natively, including no stop, so holding the
 *     service open there is an indefinite foreground service behind a button-less
 *     notification, in the state every session ends in. §6 now asserts both directions.
 *   - dropping a rate-limited position write instead of deferring it. Caught only by
 *     scrubbing WHILE PAUSED, where no later write ever arrives to repair it.
 *   - committing `lastIdentity` for a write that was rejected. Same shape: only
 *     detectable while paused, because a moving playhead hides it within a second.
 *   - leaving `lastIdentity` set across an uninstall/install cycle, which makes the
 *     first `flush` after re-installing dedupe itself away and never report `loaded`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createForayMediaSession, mediaSessionApplies, nowPlayingPayload, identityKey,
  transportState, assetUri,
  PLUGIN_NAME, SET_METHOD, TRANSPORT_EVENT, ROUTABLE_ACTIONS,
  SEEK_BACKWARD_SEC, SEEK_FORWARD_SEC, POSITION_MIN_INTERVAL_MS, ASSET_BASE, IOS_ASSET_BASE,
} from "../../mobile/plugins/foray-audio/web/foray-media-session.js";

/* The real thing, imported rather than re-described: §7 drives the module the page
   actually uses, so a change to either side of the contract fails here. */
import { createMediaSession, mediaSessionView, MEDIA_ACTIONS } from "../../player/media-session.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

const ORIGIN = "https://localhost";
const BASE = ORIGIN + "/index.html";

/* --------------------------------------------------------------- the fakes */

function makeCapacitor({
  platform = "android", results = {}, omitNativePromise = false,
  omitAddListener = false, throwOnGetPlatform = false,
} = {}) {
  const calls = [];
  const listeners = [];
  const bridge = {
    calls,
    listeners,
    getPlatform() {
      if (throwOnGetPlatform) throw new Error("bridge not ready");
      return platform;
    },
  };
  if (!omitNativePromise) {
    bridge.nativePromise = (name, method, options) => {
      calls.push({ name, method, options });
      const answer = Object.prototype.hasOwnProperty.call(results, method) ? results[method] : { ok: true };
      if (typeof answer === "function") return answer();
      return Promise.resolve(answer);
    };
  }
  if (!omitAddListener) {
    bridge.addListener = (name, eventName, callback) => {
      const entry = { name, eventName, callback, removed: false };
      listeners.push(entry);
      return { remove() { entry.removed = true; } };
    };
    /** Deliver a native transport event to whatever subscribed. */
    bridge.emit = (payload) => {
      for (const entry of listeners) if (!entry.removed) entry.callback(payload);
    };
  }
  return bridge;
}

/** A scheduler under the test's control, so coalescing is observable rather than
 *  timing-dependent. `schedule` collects; `tick` runs one turn's worth. */
function makeScheduler() {
  let queued = [];
  return {
    schedule(fn) {
      queued.push(fn);
    },
    pending() {
      return queued.length;
    },
    tick() {
      const run = queued;
      queued = [];
      for (const fn of run) fn();
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(opts = {}) {
  const capacitor = opts.capacitor || makeCapacitor(opts.bridge);
  const scheduler = makeScheduler();
  const nav = opts.nav || {};
  const loaded = [];
  const answers = [];
  const logs = [];
  let t = 1_000_000;
  /* A timer list rather than real timeouts, so the trailing position write is
     observable without waiting a second. Same shape as `foray-audio-shell.test.mjs`'s
     clock: `advance` moves `now`, `fireTimers` runs callbacks, and a test that forgets
     the second one proves nothing. */
  const timers = new Map();
  let nextTimer = 1;
  const session = createForayMediaSession({
    capacitor,
    nav,
    schedule: scheduler.schedule,
    now: () => t,
    setTimeout: opts.noTimer ? undefined : (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: opts.noTimer ? undefined : (id) => timers.delete(id),
    onNativeAnswer: (result) => answers.push(result),
    onLoadedChange: opts.onLoadedChange === null ? undefined : (v) => loaded.push(v),
    positionMinIntervalMs: opts.positionMinIntervalMs,
    baseUrl: opts.baseUrl === null ? "" : (opts.baseUrl || BASE),
    origin: opts.origin === null ? "" : (opts.origin || ORIGIN),
    log: (m, e) => logs.push({ m, e }),
  });
  return {
    capacitor, scheduler, nav, loaded, answers, logs, session,
    advance(ms) { t += ms; },
    /** Every armed trailing timer's delay, so a test can assert one exists. */
    timerDelays() {
      return [...timers.values()].map((x) => x.ms);
    },
    fireTimers() {
      for (const id of [...timers.keys()]) {
        const timer = timers.get(id);
        timers.delete(id);
        timer.fn();
      }
    },
    /**
     * One whole turn: run the coalescing callback, then let the promise chain that
     * serialises bridge calls drain.
     *
     * BOTH HALVES ARE NEEDED, and the first draft of this suite had only the first —
     * eighteen tests failed with "cannot read properties of null" because the payload
     * had been QUEUED and not yet dispatched. That is not an artefact of the fake: the
     * chain is what stops two writes landing out of order and leaving the lock screen
     * showing the older one, and it means a write is never observable in the same tick
     * it was made.
     */
    async turn() {
      scheduler.tick();
      await flush();
    },
    /** Every payload sent to native, in order. */
    sent() {
      return capacitor.calls.filter((c) => c.method === SET_METHOD).map((c) => c.options);
    },
    last() {
      const all = capacitor.calls.filter((c) => c.method === SET_METHOD);
      return all.length ? all[all.length - 1].options : null;
    },
  };
}

/** A metadata object of the shape `player/media-session.js` assigns. */
function meta(over = {}) {
  return {
    title: "The brisket episode",
    artist: "Smoke & Fire",
    album: "The history of grilling · part 12 of 32",
    artwork: [{ src: "https://is1.example/mza/600x600bb.jpg", sizes: "600x600", type: "image/jpeg" }],
    ...over,
  };
}

/** Install a session with every action handler registered, and return the recorder. */
function withHandlers(session, nav, actions = ROUTABLE_ACTIONS) {
  const seen = [];
  for (const action of actions) {
    nav.mediaSession.setActionHandler(action, (details) => seen.push({ action, details }));
  }
  return seen;
}

/* ------------------------------------------------- 1. where it applies at all */

test("mediaSessionApplies on Android and iOS, and only with a bridge that can reach native", () => {
  assert.equal(mediaSessionApplies(makeCapacitor()), true);
  assert.equal(mediaSessionApplies(makeCapacitor({ platform: "ios" })), true);
  assert.equal(mediaSessionApplies(makeCapacitor({ platform: "web" })), false);
  assert.equal(mediaSessionApplies(makeCapacitor({ platform: "ios", omitNativePromise: true })), false);
  assert.equal(mediaSessionApplies(makeCapacitor({ omitNativePromise: true })), false);
  assert.equal(mediaSessionApplies(undefined), false);
  assert.equal(mediaSessionApplies({}), false);
});

test("a bridge whose getPlatform throws fails closed", () => {
  assert.equal(mediaSessionApplies(makeCapacitor({ throwOnGetPlatform: true })), false);
});

test("install defines navigator.mediaSession, and uninstall removes it again", () => {
  const { session, nav } = setup();
  assert.equal("mediaSession" in nav, false);
  assert.equal(session.install(), true);
  assert.equal(typeof nav.mediaSession, "object");
  assert.equal(nav.mediaSession.forayPolyfill, true);
  assert.equal(session.install(), false, "installing twice should be a no-op");
  assert.equal(session.uninstall(), true);
  assert.equal("mediaSession" in nav, false, "uninstall left a property behind");
  assert.equal(session.uninstall(), false);
});

test("AN ENGINE THAT ALREADY HAS mediaSession IS LEFT ALONE — ANDROID ONLY", () => {
  /* The whole premise — that Android WebView switches the API off — is source-derived
     rather than measured (MP1 §5.4). If a WebView ever ships it on, the real
     implementation must win: a polyfill that overwrites a working platform API is how
     a fix becomes a regression on the next OS release. iOS is the opposite case (M-01
     measured a live, present mediaSession) and is covered in §1b below. */
  const real = { metadata: null, setActionHandler() {} };
  const nav = { mediaSession: real };
  const { session } = setup({ nav });
  assert.equal(session.install(), false);
  assert.equal(nav.mediaSession, real);
});

test("on the web navigator is never touched and native is never called", () => {
  const { session, nav, capacitor } = setup({ bridge: { platform: "web" } });
  assert.equal(session.install(), false);
  assert.equal("mediaSession" in nav, false);
  assert.equal(capacitor.calls.length, 0);
});

/* --------------------------------------------------- 1b. iOS takeover (L-02) */

test("iOS with no existing mediaSession installs exactly as Android does", () => {
  const { session, nav } = setup({ bridge: { platform: "ios" } });
  assert.equal("mediaSession" in nav, false);
  assert.equal(session.install(), true);
  assert.equal(nav.mediaSession.forayPolyfill, true);
  assert.equal(session.uninstall(), true);
  assert.equal("mediaSession" in nav, false);
});

test("iOS TAKES OVER a present-but-inert mediaSession when the property is configurable", () => {
  /* Measured, not assumed: `docs/ios-lock-screen.md` §0 (run 34043193990) found
     WKWebView exposing a live, writable navigator.mediaSession with WebKit
     actively publishing to it. `client.js`'s one-time read at init must land on
     OURS, so install() must replace the property outright when it can. */
  const fake = { metadata: null, playbackState: "none", setActionHandler() {}, setPositionState() {} };
  const nav = { mediaSession: fake };
  const { session } = setup({ bridge: { platform: "ios" }, nav });
  assert.equal(session.install(), true);
  assert.notEqual(nav.mediaSession, fake, "client.js would still read WebKit's inert object");
  assert.equal(nav.mediaSession.forayPolyfill, true, "the marker property a device pass reads");
});

test("iOS WRAPS an existing mediaSession's methods when the property is not configurable", () => {
  /* The other half of the plan's conditional: `Object.defineProperty` on the
     whole property fails when a real engine marked it non-configurable, so
     install() must fall back to intercepting the existing object's own
     metadata/playbackState/setPositionState/setActionHandler instead. */
  const fake = { metadata: null, playbackState: "none", setActionHandler() {}, setPositionState() {} };
  const nav = {};
  Object.defineProperty(nav, "mediaSession", {
    value: fake, writable: true, configurable: false, enumerable: true,
  });
  const { session, scheduler, last, turn } = setup({ bridge: { platform: "ios" }, nav });
  assert.equal(session.install(), true);
  assert.equal(nav.mediaSession, fake, "a non-configurable property cannot be replaced");
  assert.equal(nav.mediaSession.forayPolyfill, true, "the marker still lands on the wrapped object");
  /* client.js's writes now reach us through the wrapped setters/methods. */
  nav.mediaSession.metadata = meta();
  return turn().then(() => {
    assert.equal(last().title, "The brisket episode", "a write through the wrapped object never reached native");
  });
});

test("MUTATION: leaving WebKit's original mediaSession in place is caught", () => {
  /* If install() forgot the takeover branch entirely and simply refused
     whenever something was already there (the Android rule, applied
     unconditionally), this is the test that goes red: client.js would keep
     reading WebKit's inert object and no setNowPlaying call would ever reach
     native. */
  const fake = { metadata: null, playbackState: "none", setActionHandler() {}, setPositionState() {} };
  const nav = { mediaSession: fake };
  const { session } = setup({ bridge: { platform: "ios" }, nav });
  session.install();
  assert.equal(nav.mediaSession.forayPolyfill, true, "ours must be the one client.js finds");
});

test("iOS takeover (replace path) restores WebKit's original object on uninstall", () => {
  const fake = { metadata: null, playbackState: "none", setActionHandler() {}, setPositionState() {} };
  const nav = { mediaSession: fake };
  const { session } = setup({ bridge: { platform: "ios" }, nav });
  session.install();
  assert.equal(session.uninstall(), true);
  assert.equal(nav.mediaSession, fake, "uninstall must give WebKit's object back, not delete the property");
});

test("iOS takeover (wrap path) restores the wrapped members on uninstall", () => {
  const originalSetActionHandler = function () {};
  const fake = {
    metadata: null, playbackState: "none",
    setActionHandler: originalSetActionHandler, setPositionState() {},
  };
  const nav = {};
  Object.defineProperty(nav, "mediaSession", {
    value: fake, writable: true, configurable: false, enumerable: true,
  });
  const { session } = setup({ bridge: { platform: "ios" }, nav });
  session.install();
  assert.equal(session.uninstall(), true);
  assert.equal(nav.mediaSession, fake, "the property itself was never replaced in wrap mode");
  assert.equal(nav.mediaSession.setActionHandler, originalSetActionHandler, "the original method was not restored");
  assert.equal(Object.prototype.hasOwnProperty.call(nav.mediaSession, "forayPolyfill"), false, "the marker outlived uninstall");
});

test("iOS artwork addresses use the bundle scheme, not Android's asset path", () => {
  assert.equal(
    assetUri("icon-512.png", { baseUrl: BASE, origin: ORIGIN, assetBase: IOS_ASSET_BASE }),
    IOS_ASSET_BASE + "icon-512.png"
  );
  assert.notEqual(IOS_ASSET_BASE, ASSET_BASE);
});

test("iOS payloads carry a bundle:// artwork URI end to end, not Android's asset path", async () => {
  const { session, nav, turn, last } = setup({ bridge: { platform: "ios" } });
  session.install();
  nav.mediaSession.metadata = meta({
    artwork: [{ src: "icon-512.png", sizes: "512x512", type: "image/png" }],
  });
  await turn();
  assert.equal(last().artworkUri, IOS_ASSET_BASE + "icon-512.png");
});

test("install subscribes to the transport event, by that plugin and event name", () => {
  const { session, capacitor } = setup();
  session.install();
  assert.deepEqual(
    capacitor.listeners.map((l) => ({ name: l.name, eventName: l.eventName })),
    [{ name: PLUGIN_NAME, eventName: TRANSPORT_EVENT }]
  );
  session.uninstall();
  assert.equal(capacitor.listeners[0].removed, true, "uninstall left a native listener attached");
});

test("a bridge with no addListener falls back to nativeCallback", () => {
  const calls = [];
  const capacitor = {
    getPlatform: () => "android",
    nativePromise: () => Promise.resolve({ ok: true }),
    nativeCallback: (name, method, options) => calls.push({ name, method, options }),
  };
  const { session } = setup({ capacitor });
  assert.equal(session.install(), true);
  assert.deepEqual(calls, [{
    name: PLUGIN_NAME, method: "addListener", options: { eventName: TRANSPORT_EVENT },
  }]);
});

test("a bridge with NEITHER subscription method still installs", () => {
  /* The metadata half is worth having on its own: a lock screen that shows the right
     title with dead buttons is better than no lock screen, and it is what the OS's own
     play/pause routing would still drive. */
  const capacitor = { getPlatform: () => "android", nativePromise: () => Promise.resolve({ ok: true }) };
  const { session, nav } = setup({ capacitor });
  assert.equal(session.install(), true);
  assert.equal(typeof nav.mediaSession, "object");
});

/* --------------------------------------------------- 2. the polyfill's surface */

test("setActionHandler THROWS on an action we cannot route", () => {
  /* Chromium's behaviour, and the reason `media-session.js` wraps every
     `setActionHandler` in its own `attempt()` and keeps a set of the ones that did not
     throw. Answering "fine" would put an action in that set and then a car display
     would carry a button that does nothing. */
  const { session, nav } = setup();
  session.install();
  assert.throws(() => nav.mediaSession.setActionHandler("skipad", () => {}), TypeError);
  assert.throws(() => nav.mediaSession.setActionHandler("togglemicrophone", () => {}), TypeError);
  for (const action of ROUTABLE_ACTIONS) {
    nav.mediaSession.setActionHandler(action, () => {});
  }
});

test("every action `player/media-session.js` can install is routable", () => {
  /* Both directions. A routable action the player never installs is dead code here; an
     action the player installs and we cannot route is a button that does nothing. */
  assert.deepEqual([...ROUTABLE_ACTIONS].sort(), [...MEDIA_ACTIONS].sort());
});

test("the seek increments are the same numbers the player uses", () => {
  /* Duplicated constants, kept honest by reading the other file — the same trick
     `shell-invariants.test.mjs` uses for the plugin name against the Java. The shell's
     copy exists because this file is copied to the bundle root and must not depend on
     `player/`'s module graph resolving from there. */
  const source = fs.readFileSync(path.join(REPO_ROOT, "player", "media-session.js"), "utf8");
  const back = /export const SEEK_BACKWARD_SEC = (\d+);/.exec(source);
  const fwd = /export const SEEK_FORWARD_SEC = (\d+);/.exec(source);
  assert.ok(back && fwd, "player/media-session.js no longer declares the seek increments");
  assert.equal(SEEK_BACKWARD_SEC, Number(back[1]));
  assert.equal(SEEK_FORWARD_SEC, Number(fwd[1]));
});

test("metadata is SNAPSHOTTED, not held by reference", async () => {
  /* `client.js` passes `window.MediaMetadata` when the engine has it, and a real
     `MediaMetadata`'s `artwork` is a live platform list. Copying the four fields we
     read means one code path either way — and it means a caller reusing its object
     cannot rewrite what we already reported. */
  const { session, nav, scheduler, last, turn } = setup();
  session.install();
  const original = meta();
  nav.mediaSession.metadata = original;
  await turn();
  original.title = "something else";
  assert.equal(last().title, "The brisket episode");
  assert.equal(nav.mediaSession.metadata.title, "The brisket episode");
});

test("setPositionState with no argument clears it, per spec", async () => {
  const { session, nav, scheduler, last, turn } = setup();
  session.install();
  nav.mediaSession.metadata = meta();
  nav.mediaSession.setPositionState({ duration: 3600, position: 60, playbackRate: 1 });
  await turn();
  assert.equal(last().durationMs, 3_600_000);
  nav.mediaSession.setPositionState();
  await turn();
  assert.equal(last().durationMs, 0, "a cleared position state still claimed a duration");
});

/* ------------------------------------------------------------- 3. the artwork */

test("assetUri passes an https URL through untouched", () => {
  const url = "https://is1.example/mza/600x600bb.jpg";
  assert.equal(assetUri(url, { baseUrl: BASE, origin: ORIGIN }), url);
});

test("ASSETURI REWRITES THE APP'S OWN ICON INTO AN ASSET URI", () => {
  /* The bug this exists for: `icon-512.png` resolves to `https://localhost/icon-512.png`,
     an origin served by Capacitor's `WebViewLocalServer` INSIDE the WebView and by
     nothing else in the process. A native bitmap loader asked for it gets a refused
     connection, so the fallback artwork — which `media-session.js` §5 says is what
     eleven of twelve shows get — would silently never load. */
  assert.equal(
    assetUri("icon-512.png", { baseUrl: BASE, origin: ORIGIN }),
    ASSET_BASE + "icon-512.png"
  );
  assert.equal(
    assetUri(ORIGIN + "/icon-512.png", { baseUrl: BASE, origin: ORIGIN }),
    ASSET_BASE + "icon-512.png"
  );
});

test("a query or a fragment is dropped from a bundled asset path", () => {
  /* They would otherwise become part of the FILENAME an asset loader looks for. */
  assert.equal(
    assetUri("icon-512.png?v=3#x", { baseUrl: BASE, origin: ORIGIN }),
    ASSET_BASE + "icon-512.png"
  );
});

test("a data:image URI is passed through and never parsed as a URL", () => {
  const uri = "data:image/png;base64,iVBORw0KGgo=";
  assert.equal(assetUri(uri, { baseUrl: BASE, origin: ORIGIN }), uri);
});

test("assetUri refuses everything else, and refuses it as an empty string", () => {
  for (const bad of [
    "", "   ", null, undefined, 7,
    "http://insecure.example/a.jpg",
    "ftp://host/a.jpg",
    "data:text/html,<b>x</b>",
  ]) {
    assert.equal(assetUri(bad, { baseUrl: BASE, origin: ORIGIN }), "", `accepted ${String(bad)}`);
  }
});

test("a relative path with no base is refused rather than guessed", () => {
  assert.equal(assetUri("icon-512.png", { baseUrl: "", origin: ORIGIN }), "");
});

test("the payload carries the FIRST artwork entry, not the largest", () => {
  /* `mediaArtworkList` returns exactly one image — the publisher's square when we have
     it, ours when we do not — and its own comment says offering both is "a coin flip
     over whose mark shows". Picking by size here would reintroduce the coin flip. */
  const payload = nowPlayingPayload({
    metadata: meta({
      artwork: [
        { src: "https://a.example/small/64x64.png", sizes: "64x64" },
        { src: "https://a.example/big/1200x1200.png", sizes: "1200x1200" },
      ],
    }),
    uri: { baseUrl: BASE, origin: ORIGIN },
  });
  assert.equal(payload.artworkUri, "https://a.example/small/64x64.png");
});

/* ---------------------------------------------------------- 4. the write rate */

test("ONE update() IS ONE NATIVE CALL, not three", async () => {
  /* `media-session.js`'s `update()` writes metadata, then `playbackState`, then calls
     `setPositionState` — three property writes per repaint. Coalescing per scheduler
     turn is what makes that one bridge round-trip. */
  const { session, nav, scheduler, capacitor, turn } = setup();
  session.install();
  nav.mediaSession.metadata = meta();
  nav.mediaSession.playbackState = "playing";
  nav.mediaSession.setPositionState({ duration: 3600, position: 10, playbackRate: 1 });
  assert.equal(capacitor.calls.length, 0, "a write reached native before the turn ended");
  await turn();
  assert.equal(capacitor.calls.filter((c) => c.method === SET_METHOD).length, 1);
});

test("A POSITION-ONLY CHANGE IS RATE-LIMITED", async () => {
  /* `client.js` repaints at 4 Hz for 51 minutes. Without this that is ~12,000 bridge
     round-trips per Foray for a number Media3 extrapolates on its own. */
  const s = setup({ positionMinIntervalMs: 1000 });
  s.session.install();
  s.nav.mediaSession.metadata = meta();
  s.nav.mediaSession.playbackState = "playing";
  s.nav.mediaSession.setPositionState({ duration: 3600, position: 10, playbackRate: 1 });
  await s.turn();
  assert.equal(s.sent().length, 1);

  for (const position of [10.25, 10.5, 10.75, 11]) {
    s.advance(250);
    s.nav.mediaSession.setPositionState({ duration: 3600, position, playbackRate: 1 });
    await s.turn();
  }
  /* 1,000 ms of fake time has passed across four writes, so exactly one of them is
     due — the fourth. */
  assert.equal(s.sent().length, 2, "the playhead was written more than once a second");
  assert.equal(s.last().positionMs, 11_000);
});

test("AN IDENTITY CHANGE IS SENT AT ONCE, INSIDE THE RATE LIMIT", async () => {
  /* The ordering that makes the limit safe. A cross-episode seam changes the title and
     the show — which is what a listener SEES — and it can land 100 ms after a position
     write. Rate-limiting that would leave a car display showing the previous
     publisher's name for up to a second at the one moment it changed. */
  const s = setup({ positionMinIntervalMs: 1000 });
  s.session.install();
  s.nav.mediaSession.metadata = meta();
  s.nav.mediaSession.playbackState = "playing";
  s.nav.mediaSession.setPositionState({ duration: 3600, position: 10, playbackRate: 1 });
  await s.turn();
  assert.equal(s.sent().length, 1);

  s.advance(100);
  s.nav.mediaSession.metadata = meta({ title: "The next segment", artist: "Another show" });
  s.nav.mediaSession.setPositionState({ duration: 3600, position: 10.1, playbackRate: 1 });
  await s.turn();
  assert.equal(s.sent().length, 2, "a seam's metadata change waited for the rate limit");
  assert.equal(s.last().title, "The next segment");
  assert.equal(s.last().artist, "Another show");
});

test("an unchanged repaint sends nothing at all", async () => {
  const s = setup({ positionMinIntervalMs: 1000 });
  s.session.install();
  s.nav.mediaSession.metadata = meta();
  s.nav.mediaSession.playbackState = "playing";
  s.nav.mediaSession.setPositionState({ duration: 3600, position: 10, playbackRate: 1 });
  await s.turn();
  s.advance(5000);
  s.nav.mediaSession.setPositionState({ duration: 3600, position: 10, playbackRate: 1 });
  await s.turn();
  assert.equal(s.sent().length, 1, "a still playhead kept writing");
});

test("a playback-rate change is an identity change, because Media3 extrapolates with it", async () => {
  /* #242's speed control. The OS advances the playhead as `position + rate x wall`
     between our reports, so a stale rate is a scrubber that drifts away from the audio
     — which `media-session.js` calls worse than no scrubber. */
  const s = setup({ positionMinIntervalMs: 1000 });
  s.session.install();
  s.nav.mediaSession.metadata = meta();
  s.nav.mediaSession.playbackState = "playing";
  s.nav.mediaSession.setPositionState({ duration: 3600, position: 10, playbackRate: 1 });
  await s.turn();
  s.advance(50);
  s.nav.mediaSession.setPositionState({ duration: 3600, position: 10, playbackRate: 1.5 });
  await s.turn();
  assert.equal(s.sent().length, 2);
  assert.equal(s.last().playbackRate, 1.5);
});

test("identityKey ignores the playhead and nothing else", () => {
  const base = nowPlayingPayload({
    metadata: meta(), positionState: { duration: 3600, position: 10, playbackRate: 1 },
    playbackState: "playing", actions: ROUTABLE_ACTIONS, uri: { baseUrl: BASE, origin: ORIGIN },
  });
  const moved = { ...base, positionMs: 999_000 };
  assert.equal(identityKey(moved), identityKey(base));
  for (const [field, value] of [
    ["state", "paused"], ["title", "x"], ["artist", "x"], ["album", "x"],
    ["artworkUri", "x"], ["durationMs", 1], ["playbackRate", 2],
    ["canPlay", false], ["canPause", false], ["canStop", false],
    ["hasNext", false], ["hasPrevious", false],
    ["canSeekBack", false], ["canSeekForward", false], ["canSeekTo", false],
    ["seekBackMs", 1], ["seekForwardMs", 1],
  ]) {
    assert.notEqual(
      identityKey({ ...base, [field]: value }), identityKey(base),
      `${field} is not part of the identity, so a change to it would be rate-limited`
    );
  }
});

test("A RATE-LIMITED POSITION WRITE IS DEFERRED, NOT DROPPED", async () => {
  /* THE SEQUENCE A REVIEW PASS FOUND: scrub from the lock screen WHILE PAUSED. The
     identity does not change, the write lands inside the interval, and with a bare
     `return` nothing ever re-arms — paused means no further `timeupdate`, and Media3
     only extrapolates while playing. So the lock-screen playhead would stick at the
     pre-seek position until playback resumed. */
  const s = setup({ positionMinIntervalMs: 1000 });
  s.session.install();
  s.nav.mediaSession.metadata = meta();
  s.nav.mediaSession.playbackState = "paused";
  s.nav.mediaSession.setPositionState({ duration: 3600, position: 10, playbackRate: 1 });
  await s.turn();
  assert.equal(s.sent().length, 1);

  s.advance(200);
  s.nav.mediaSession.setPositionState({ duration: 3600, position: 1800, playbackRate: 1 });
  await s.turn();
  assert.equal(s.sent().length, 1, "the write should not have gone out yet");
  assert.deepEqual(s.timerDelays(), [800], "no trailing write was armed for the remainder");

  s.advance(800);
  s.fireTimers();
  /* `turn()`, not a bare `flush()`: the timer does not write, it SCHEDULES a write —
     so the deferred path goes back through the same coalescing turn as every other
     write and cannot become a second way to reach native. */
  await s.turn();
  assert.equal(s.sent().length, 2, "the deferred position write never arrived");
  assert.equal(s.last().positionMs, 1_800_000);
});

test("only ONE trailing write is armed, however many repaints are refused", async () => {
  /* At 4 Hz a dropped write per repaint would arm four timers a second, and the pending
     one is always for the earliest moment a write is allowed anyway. */
  const s = setup({ positionMinIntervalMs: 1000 });
  s.session.install();
  s.nav.mediaSession.metadata = meta();
  s.nav.mediaSession.playbackState = "playing";
  s.nav.mediaSession.setPositionState({ duration: 3600, position: 10, playbackRate: 1 });
  await s.turn();
  for (const position of [10.25, 10.5, 10.75]) {
    s.advance(100);
    s.nav.mediaSession.setPositionState({ duration: 3600, position, playbackRate: 1 });
    await s.turn();
  }
  assert.equal(s.timerDelays().length, 1, "one timer per refused write");
});

test("a write that DOES go out cancels a trailing one", async () => {
  const s = setup({ positionMinIntervalMs: 1000 });
  s.session.install();
  s.nav.mediaSession.metadata = meta();
  s.nav.mediaSession.playbackState = "playing";
  s.nav.mediaSession.setPositionState({ duration: 3600, position: 10, playbackRate: 1 });
  await s.turn();
  s.advance(100);
  s.nav.mediaSession.setPositionState({ duration: 3600, position: 11, playbackRate: 1 });
  await s.turn();
  assert.equal(s.timerDelays().length, 1);
  /* A metadata change is an identity change and goes out at once, carrying the position
     with it — so the trailing timer has nothing left to deliver. */
  s.nav.mediaSession.metadata = meta({ title: "next segment" });
  await s.turn();
  assert.equal(s.timerDelays().length, 0, "a stale trailing write was left armed");
  assert.equal(s.last().positionMs, 11_000);
});

test("with no timer injected a refused write is dropped, not thrown", async () => {
  /* Degraded rather than broken, which is why the timer is optional at all: a platform
     with no `setTimeout` still gets every identity change. */
  const s = setup({ positionMinIntervalMs: 1000, noTimer: true });
  s.session.install();
  s.nav.mediaSession.metadata = meta();
  s.nav.mediaSession.playbackState = "playing";
  s.nav.mediaSession.setPositionState({ duration: 3600, position: 10, playbackRate: 1 });
  await s.turn();
  s.advance(100);
  s.nav.mediaSession.setPositionState({ duration: 3600, position: 11, playbackRate: 1 });
  await s.turn();
  assert.equal(s.sent().length, 1);
});

test("the default rate limit is what an unconfigured session uses", () => {
  assert.equal(POSITION_MIN_INTERVAL_MS, 1000);
});

/* ------------------------------------------------------------- 5. the payload */

test("the payload carries the three strings the player decided on, unchanged", () => {
  const payload = nowPlayingPayload({
    metadata: meta(),
    positionState: { duration: 3661, position: 61.4, playbackRate: 1.5 },
    playbackState: "playing",
    actions: ROUTABLE_ACTIONS,
    uri: { baseUrl: BASE, origin: ORIGIN },
  });
  assert.equal(payload.title, "The brisket episode");
  assert.equal(payload.artist, "Smoke & Fire");
  assert.equal(payload.album, "The history of grilling · part 12 of 32");
  assert.equal(payload.durationMs, 3_661_000);
  assert.equal(payload.positionMs, 61_400, "seconds should become whole milliseconds");
  assert.equal(payload.playbackRate, 1.5);
  assert.equal(payload.seekBackMs, SEEK_BACKWARD_SEC * 1000);
  assert.equal(payload.seekForwardMs, SEEK_FORWARD_SEC * 1000);
});

test("THE CAPABILITY FLAGS COME FROM WHICH HANDLERS THE PAGE INSTALLED", () => {
  /* Which is how single-episode playback renders honestly: `episodeMediaSurface` has
     no next/previous (the queue is one item, product principle 1 — no autoplay
     chains), so no `nexttrack` handler, so no flag, so no `Player` command, so the OS
     greys the button out. */
  const episode = nowPlayingPayload({
    metadata: meta(), playbackState: "playing",
    actions: ["play", "pause", "stop", "seekbackward", "seekforward", "seekto"],
  });
  assert.equal(episode.hasNext, false);
  assert.equal(episode.hasPrevious, false);
  assert.equal(episode.canPlay, true);
  assert.equal(episode.canSeekTo, true);

  const foray = nowPlayingPayload({
    metadata: meta(), playbackState: "playing", actions: ROUTABLE_ACTIONS,
  });
  assert.equal(foray.hasNext, true);
  assert.equal(foray.hasPrevious, true);
});

test("a missing position state is zero, never a guess", () => {
  const payload = nowPlayingPayload({ metadata: meta(), playbackState: "paused" });
  assert.equal(payload.durationMs, 0);
  assert.equal(payload.positionMs, 0);
  assert.equal(payload.playbackRate, 1);
});

test("a nonsense position state is clamped rather than forwarded", () => {
  const payload = nowPlayingPayload({
    metadata: meta(),
    positionState: { duration: -5, position: -1, playbackRate: 0 },
    playbackState: "playing",
  });
  assert.equal(payload.durationMs, 0);
  assert.equal(payload.positionMs, 0);
  assert.equal(payload.playbackRate, 1, "a zero rate would be a TypeError in the spec and a throw in Media3");
});

test("no metadata means idle, and idle carries nothing", () => {
  const payload = nowPlayingPayload({ metadata: null, playbackState: "playing", actions: ROUTABLE_ACTIONS });
  assert.equal(payload.state, "idle");
  assert.equal(payload.title, "");
});

/* ------------------------------------------------------- 6. loaded, and ended */

test("transportState maps the spec's four cases", () => {
  assert.equal(transportState({ metadata: null, playbackState: "none" }), "idle");
  assert.equal(transportState({ metadata: null, playbackState: "playing" }), "idle");
  assert.equal(transportState({ metadata: meta(), playbackState: "playing" }), "playing");
  assert.equal(transportState({ metadata: meta(), playbackState: "paused" }), "paused");
  assert.equal(transportState({ metadata: meta(), playbackState: "none" }), "ended");
  assert.equal(transportState({ metadata: meta(), playbackState: "invented" }), "paused");
});

test("A FINISHED FORAY IS REPORTED ENDED, AND IS NOT LOADED", async () => {
  /* THIS TEST USED TO ASSERT THE OPPOSITE, AND THE OPPOSITE WAS A BLOCKING REVIEW
     FINDING. The reasoning was that `media-session.js` §4 reports the spec's `"none"`
     for a finished Foray on purpose, so keying the service's lifetime on
     `playbackState` would tear the session down the moment one ended — true, and it
     led to keying it on "anything but idle", which is worse.

     A finished Foray has NO transport to offer: `NowPlaying.acceptsTransport()` is
     false natively, so every notification action is skipped INCLUDING STOP. Holding the
     service open there is an indefinite foreground service behind a button-less
     notification, in the state every session ends in, with no exit but unlocking the
     phone. So `isTransportable` — playing or paused — is the rule on both sides: the
     surface with no controls is also the surface that does not hold a service open.

     The payload still says `"ended"` rather than `"idle"`, because the two are
     different things to a controller and the metadata is still worth showing. */
  const { session, nav, loaded, last, turn } = setup();
  session.install();
  nav.mediaSession.metadata = meta();
  nav.mediaSession.playbackState = "playing";
  await turn();
  assert.deepEqual(loaded, [true]);

  nav.mediaSession.playbackState = "none";
  await turn();
  assert.equal(last().state, "ended", "an ended Foray must not be reported as idle");
  assert.deepEqual(loaded, [true, false], "a finished Foray kept the foreground service open");
});

test("a PAUSED Foray is still loaded, because pausing is the case the session exists for", async () => {
  /* The other side of the same rule, and the one that must not regress: the whole
     reason the service's lifetime changed is that pausing from the lock screen must not
     take the buttons away. */
  const { session, nav, loaded, turn } = setup();
  session.install();
  nav.mediaSession.metadata = meta();
  nav.mediaSession.playbackState = "playing";
  await turn();
  nav.mediaSession.playbackState = "paused";
  await turn();
  assert.deepEqual(loaded, [true], "a pause was reported as unloaded");
});

test("CLEARING THE METADATA REPORTS UNLOADED, WHICH IS WHAT STOPS THE SERVICE", async () => {
  /* `client.js` calls `media.release()` from `stopAndClose` and nowhere else, and
     `release()` nulls the metadata. That is the attributable "the player closed"
     signal #244's header said would fix its own 25 s notification defect. */
  const { session, nav, scheduler, loaded, last, turn } = setup();
  session.install();
  nav.mediaSession.metadata = meta();
  nav.mediaSession.playbackState = "playing";
  await turn();
  nav.mediaSession.metadata = null;
  nav.mediaSession.playbackState = "none";
  nav.mediaSession.setPositionState();
  await turn();
  assert.equal(last().state, "idle");
  assert.deepEqual(loaded, [true, false]);
});

test("uninstall reports unloaded, so the service is never stranded", async () => {
  /* An uninstalled polyfill will never report `idle` again, and leaving `mediaLoaded`
     true in the shell would leave the foreground service with no JS able to stop it —
     the same hole `foray-audio-shell.js`'s own `uninstall` closes. */
  const { session, nav, scheduler, loaded, turn } = setup();
  session.install();
  nav.mediaSession.metadata = meta();
  /* PLAYING, explicitly. With the default `"none"` this would be a FINISHED Foray,
     which is not "loaded" — so without this line the test would assert its own premise
     away and pass for the wrong reason. */
  nav.mediaSession.playbackState = "playing";
  await turn();
  assert.deepEqual(loaded, [true]);
  session.uninstall();
  assert.deepEqual(loaded, [true, false]);
});

test("uninstall with nothing loaded reports nothing", () => {
  const { session, loaded } = setup();
  session.install();
  session.uninstall();
  assert.deepEqual(loaded, []);
});

test("an onLoadedChange that throws costs nothing", async () => {
  const capacitor = makeCapacitor();
  const scheduler = makeScheduler();
  const nav = {};
  const session = createForayMediaSession({
    capacitor, nav, schedule: scheduler.schedule, baseUrl: BASE, origin: ORIGIN,
    onLoadedChange: () => { throw new Error("shell exploded"); },
  });
  session.install();
  nav.mediaSession.metadata = meta();
  scheduler.tick();
  await flush();
  assert.equal(capacitor.calls.filter((c) => c.method === SET_METHOD).length, 1, "the write was lost");
});

/* ------------------------------------------------- 7. the real player drives it */

test("player/media-session.js DRIVES THIS POLYFILL END TO END", async () => {
  /* The contract test. `createMediaSession` is the code `client.js` runs, unmodified
     by this change, and it is what decides the three strings, the clock and the seam
     beat. If the polyfill is not faithful enough for it — a missing method, a getter
     it reads back, an action that should throw and does not — this is where that
     shows, rather than on a device. */
  const { session, nav, scheduler, last, turn } = setup();
  session.install();
  const media = createMediaSession({ nav, MediaMetadata: null });
  assert.equal(media.supported, true, "the real bridge did not recognise the polyfill");

  const calls = [];
  const surface = {
    play: () => calls.push("play"),
    pause: () => calls.push("pause"),
    stop: () => calls.push("stop"),
    next: () => calls.push("next"),
    previous: () => calls.push("previous"),
    seekBy: (offset) => calls.push(`seekBy:${offset}`),
    seekTo: (position) => calls.push(`seekTo:${position}`),
  };
  assert.deepEqual(media.setActions(surface), [...MEDIA_ACTIONS]);

  media.update(mediaSessionView({
    item: { title: "The brisket episode", show: "Smoke & Fire" },
    forayTitle: "The history of grilling",
    index: 11,
    total: 32,
    showArtworkUrl: "https://is1.example/mza/600x600bb.jpg",
    durationSec: 3661,
    positionSec: 61,
    playbackRate: 1,
    playing: true,
  }));
  await turn();

  const payload = last();
  assert.equal(payload.state, "playing");
  assert.equal(payload.title, "The brisket episode");
  assert.equal(payload.artist, "Smoke & Fire");
  assert.equal(payload.album, "The history of grilling · part 12 of 32");
  assert.equal(payload.artworkUri, "https://is1.example/mza/600x600bb.jpg");
  assert.equal(payload.durationMs, 3_661_000);
  assert.equal(payload.positionMs, 61_000);
  assert.equal(payload.hasNext, true);
  assert.equal(payload.hasPrevious, true);

  /* And the presses land on the page's own surface, which is what "routes back to the
     web player" has to mean. */
  session.dispatch({ action: "nexttrack" });
  session.dispatch({ action: "previoustrack" });
  session.dispatch({ action: "seekbackward", offsetMs: SEEK_BACKWARD_SEC * 1000 });
  session.dispatch({ action: "seekto", positionMs: 1_800_000 });
  assert.deepEqual(calls, ["next", "previous", `seekBy:-${SEEK_BACKWARD_SEC}`, "seekTo:1800"]);
});

test("A SINGLE EPISODE GETS NO SKIP BUTTONS, THROUGH THE REAL PLAYER", async () => {
  /* `episodeMediaSurface`'s shape: no `next`, no `previous`. The real
     `mediaSessionActions` therefore installs neither, so the payload's flags are false
     and `WebViewPlayer` declares no seek-to-next command. A dim button is honest; one
     that silently does nothing is not. */
  const { session, nav, scheduler, last, turn } = setup();
  session.install();
  const media = createMediaSession({ nav, MediaMetadata: null });
  media.setActions({
    play: () => {}, pause: () => {}, stop: () => {}, seekBy: () => {}, seekTo: () => {},
  });
  media.update(mediaSessionView({
    item: { title: "One episode", show: "A show" },
    forayTitle: "", index: 0, total: 0,
    durationSec: 1800, positionSec: 0, playbackRate: 1, playing: false,
  }));
  await turn();
  assert.equal(last().hasNext, false);
  assert.equal(last().hasPrevious, false);
  assert.equal(last().canPlay, true);
});

test("THE SEAM BEAT REPORTS PLAYING, THROUGH THE REAL PLAYER", async () => {
  /* `media-session.js` §4 widens "playing" by exactly one state so a display does not
     blink 31 times an hour. It has to survive the trip: reporting `paused` to Media3
     for 2.0 s would make the lock screen flicker and — because the service's own
     lifetime is keyed off the page — arm a settle window at every seam. */
  const { session, nav, scheduler, last, turn } = setup();
  session.install();
  const media = createMediaSession({ nav, MediaMetadata: null });
  media.update(mediaSessionView({
    item: { title: "Between two segments", show: "A show" },
    forayTitle: "F", index: 3, total: 10,
    durationSec: 600, positionSec: 100, playbackRate: 1,
    playing: false, inSeamGap: true,
  }));
  await turn();
  assert.equal(last().state, "playing");
});

test("the real player's release() reaches native as one idle write", async () => {
  /* `release()` is `clear()` plus eight `setActionHandler(action, null)` calls — ten
     property writes and method calls in one turn. Coalescing has to make that one
     bridge round-trip, and the last thing native hears has to be `idle`. */
  const { session, nav, scheduler, capacitor, last, turn } = setup();
  session.install();
  const media = createMediaSession({ nav, MediaMetadata: null });
  media.setActions({ play: () => {}, pause: () => {}, stop: () => {}, next: () => {}, previous: () => {}, seekBy: () => {}, seekTo: () => {} });
  media.update(mediaSessionView({
    item: { title: "x", show: "y" }, forayTitle: "F", index: 0, total: 2,
    durationSec: 100, positionSec: 1, playbackRate: 1, playing: true,
  }));
  await turn();
  const before = capacitor.calls.filter((c) => c.method === SET_METHOD).length;
  media.release();
  await turn();
  assert.equal(capacitor.calls.filter((c) => c.method === SET_METHOD).length, before + 1);
  assert.equal(last().state, "idle");
  assert.equal(last().canPlay, false, "the handlers were removed but the flags still claimed them");
});

/* ------------------------------------------------------ 8. transport dispatch */

test("each action reaches the handler the page registered", () => {
  const { session, nav, capacitor } = setup();
  session.install();
  const seen = withHandlers(session, nav);
  for (const action of ["play", "pause", "stop", "previoustrack", "nexttrack"]) {
    capacitor.emit({ action });
  }
  assert.deepEqual(seen.map((s) => s.action), ["play", "pause", "stop", "previoustrack", "nexttrack"]);
  assert.deepEqual(seen.map((s) => s.details), [undefined, undefined, undefined, undefined, undefined]);
});

test("MILLISECONDS BECOME SECONDS, because the spec's details are in seconds", () => {
  /* The bridge is in ms — Android's unit everywhere — and the handlers are the
     browser's, written against `seekTime` and `seekOffset` in seconds. Getting this
     backwards would seek 1,800,000 seconds into a 61-minute Foray. */
  const { session, nav, capacitor } = setup();
  session.install();
  const seen = withHandlers(session, nav);
  capacitor.emit({ action: "seekto", positionMs: 1_800_500 });
  capacitor.emit({ action: "seekbackward", offsetMs: 15_000 });
  capacitor.emit({ action: "seekforward", offsetMs: 30_000 });
  assert.deepEqual(seen.map((s) => s.details), [
    { seekTime: 1800.5 }, { seekOffset: 15 }, { seekOffset: 30 },
  ]);
});

test("`fastSeek` is never sent", () => {
  /* Whether a seek may be approximate is `player/seek-policy.js`'s decision
     (ADR-0007/0008) and `media-session.js` drops the field deliberately. Inventing it
     here would smuggle a head unit's opinion into a DAI source's landing. */
  const { session, nav, capacitor } = setup();
  session.install();
  const seen = withHandlers(session, nav);
  capacitor.emit({ action: "seekto", positionMs: 1000 });
  assert.deepEqual(Object.keys(seen[0].details), ["seekTime"]);
});

test("A SEEKTO WITH NO POSITION IS REFUSED, NOT TREATED AS ZERO", () => {
  /* `seekTime: 0` is a legal value, so the only way to catch this is to assert the
     handler was not called at all. Treating a missing time as zero would send an
     hour-long Foray back to the start from a malformed native event. */
  const { session, nav, capacitor } = setup();
  session.install();
  const seen = withHandlers(session, nav);
  capacitor.emit({ action: "seekto" });
  capacitor.emit({ action: "seekto", positionMs: -1 });
  capacitor.emit({ action: "seekto", positionMs: "600" });
  assert.deepEqual(seen, []);
  capacitor.emit({ action: "seekto", positionMs: 0 });
  assert.deepEqual(seen.map((s) => s.details), [{ seekTime: 0 }]);
});

test("a ± press with no offset falls through to the page's own ±15/30", () => {
  /* `media-session.js`'s `offsetOf(details, fallback)` supplies the spec's numbers when
     the platform has none, which is exactly the case an empty details object produces. */
  const { session, nav, capacitor } = setup();
  session.install();
  const seen = withHandlers(session, nav);
  capacitor.emit({ action: "seekbackward" });
  capacitor.emit({ action: "seekforward", offsetMs: 0 });
  assert.deepEqual(seen.map((s) => s.details), [{}, {}]);
});

test("an action with no handler is a no-op, not a throw", () => {
  const { session, nav, capacitor, logs } = setup();
  session.install();
  withHandlers(session, nav, ["play", "pause"]);
  capacitor.emit({ action: "nexttrack" });
  capacitor.emit({ action: "" });
  capacitor.emit({});
  assert.equal(logs.length, 3);
});

test("a handler that throws does not escape into the bridge callback", () => {
  const { session, nav, capacitor } = setup();
  session.install();
  nav.mediaSession.setActionHandler("play", () => { throw new Error("player exploded"); });
  assert.equal(capacitor.emit({ action: "play" }), undefined);
});

test("a handler that returns a rejecting promise does not become an unhandled rejection", async () => {
  const { session, nav, capacitor } = setup();
  session.install();
  nav.mediaSession.setActionHandler("pause", () => Promise.reject(new Error("nope")));
  capacitor.emit({ action: "pause" });
  await flush();
});

test("dispatch after uninstall does nothing", () => {
  const { session, nav, capacitor } = setup();
  session.install();
  const seen = withHandlers(session, nav);
  session.uninstall();
  capacitor.emit({ action: "play" });
  assert.deepEqual(seen, []);
});

test("a removed handler stops receiving, and stops being claimed", async () => {
  /* `setActions` removes an action the new surface does not offer — switching from a
     Foray to a single episode drops `nexttrack`. A stale handler would be a lock
     screen skipping inside a Foray that is no longer loaded. */
  const { session, nav, capacitor, scheduler, last, turn } = setup();
  session.install();
  const seen = withHandlers(session, nav);
  nav.mediaSession.metadata = meta();
  await turn();
  assert.equal(last().hasNext, true);

  nav.mediaSession.setActionHandler("nexttrack", null);
  await turn();
  assert.equal(last().hasNext, false);
  capacitor.emit({ action: "nexttrack" });
  assert.deepEqual(seen.map((s) => s.action), []);
});

/* --------------------------------------------------------- 9. failure paths */

test("a bridge that throws synchronously does not stop later writes", async () => {
  let throwNext = true;
  const capacitor = makeCapacitor();
  const inner = capacitor.nativePromise;
  capacitor.nativePromise = (name, method, options) => {
    if (throwNext) {
      throwNext = false;
      throw new Error("bridge not ready");
    }
    return inner(name, method, options);
  };
  const { session, nav, scheduler, sent, turn } = setup({ capacitor });
  session.install();
  nav.mediaSession.metadata = meta();
  await turn();
  nav.mediaSession.metadata = meta({ title: "second" });
  await turn();
  assert.equal(sent().length, 1, "the write after a throwing one was lost");
  assert.equal(sent()[0].title, "second");
});

test("A REJECTED WRITE DOES NOT POISON THE QUEUE FOR THE REST OF THE SESSION", async () => {
  /* A rejected promise chain is PERMANENT — every later `.then` is skipped — and the
     lock screen would freeze on one segment's title for the rest of the Foray with
     nothing in the console. */
  const { session, nav, scheduler, sent, turn } = setup({
    bridge: { results: { [SET_METHOD]: () => Promise.reject(new Error("plugin not implemented")) } },
  });
  session.install();
  nav.mediaSession.metadata = meta();
  await turn();
  await flush();
  nav.mediaSession.metadata = meta({ title: "second" });
  await turn();
  await flush();
  assert.equal(sent().length, 2);
  assert.equal(session.inspect().lastReason, "plugin not implemented");
});

test("a scheduler that throws does not leave the flush latched off", async () => {
  /* `flushQueued` is what makes coalescing work, so a scheduler that threw with the
     flag set would stop every future write silently. */
  let explode = true;
  const capacitor = makeCapacitor();
  const nav = {};
  const session = createForayMediaSession({
    capacitor, nav, baseUrl: BASE, origin: ORIGIN,
    schedule(fn) {
      if (explode) {
        explode = false;
        throw new Error("no microtasks");
      }
      fn();
    },
  });
  session.install();
  nav.mediaSession.metadata = meta();
  nav.mediaSession.metadata = meta({ title: "second" });
  await flush();
  assert.equal(capacitor.calls.filter((c) => c.method === SET_METHOD).length, 1);
});

test("A REJECTED WRITE IS RE-SENT, because the record of it is torn up", async () => {
  /* `flush` commits `lastIdentity` before dispatching, so a rejected write leaves us
     believing native knows something it does not. While PLAYING the next position write
     repairs it within a second; while PAUSED the playhead never moves again, so the lock
     screen would sit on "playing" with a pause button for the whole pause. */
  let failNext = true;
  const capacitor = makeCapacitor();
  const inner = capacitor.nativePromise;
  capacitor.nativePromise = (name, method, options) => {
    inner(name, method, options);
    if (failNext) {
      failNext = false;
      return Promise.reject(new Error("bridge asleep"));
    }
    return Promise.resolve({ ok: true });
  };
  const s = setup({ capacitor, positionMinIntervalMs: 1000 });
  s.session.install();
  s.nav.mediaSession.metadata = meta();
  s.nav.mediaSession.playbackState = "playing";
  await s.turn();
  assert.equal(s.sent().length, 1);

  /* The same payload again — which without the reset would be deduped away for ever. */
  s.nav.mediaSession.playbackState = "playing";
  s.nav.mediaSession.metadata = meta();
  await s.turn();
  assert.equal(s.sent().length, 2, "the payload native never received was never re-sent");
});

test("native's answer is handed to the shell, so a lost service can be noticed", async () => {
  /* `setNowPlaying` is the only regular traffic to native while a Foray plays, so its
     answer is the cheapest health check available. The shell uses `running` to recover
     when the foreground service goes away without being asked. */
  const s = setup({ bridge: { results: { [SET_METHOD]: { ok: true, running: false, sessionActive: true } } } });
  s.session.install();
  s.nav.mediaSession.metadata = meta();
  s.nav.mediaSession.playbackState = "playing";
  await s.turn();
  assert.deepEqual(s.answers, [{ ok: true, running: false, sessionActive: true }]);
});

test("an onNativeAnswer that throws does not poison the queue", async () => {
  const capacitor = makeCapacitor();
  const nav = {};
  const scheduler = makeScheduler();
  const session = createForayMediaSession({
    capacitor, nav, schedule: scheduler.schedule, baseUrl: BASE, origin: ORIGIN,
    onNativeAnswer: () => { throw new Error("shell exploded"); },
  });
  session.install();
  nav.mediaSession.metadata = meta();
  nav.mediaSession.playbackState = "playing";
  scheduler.tick();
  await flush();
  nav.mediaSession.metadata = meta({ title: "second" });
  scheduler.tick();
  await flush();
  assert.equal(capacitor.calls.filter((c) => c.method === SET_METHOD).length, 2);
});

test("UNINSTALL FORGETS WHAT IT SENT, so a re-install does not dedupe itself away", async () => {
  /* Otherwise the same metadata at the same position hashes equal after an
     uninstall/install cycle, `flush` returns before reporting `loaded`, the shell's
     `mediaLoaded` stays false, and its next settle window tears the session down under a
     Foray that is loaded and playing. */
  const s = setup();
  s.session.install();
  s.nav.mediaSession.metadata = meta();
  s.nav.mediaSession.playbackState = "playing";
  await s.turn();
  assert.deepEqual(s.loaded, [true]);
  s.session.uninstall();
  assert.deepEqual(s.loaded, [true, false]);

  s.session.install();
  s.nav.mediaSession.metadata = meta();
  s.nav.mediaSession.playbackState = "playing";
  await s.turn();
  assert.deepEqual(s.loaded, [true, false, true], "the re-installed session never reported loaded");
  assert.equal(s.sent().length, 2);
});

test("inspect and peek answer without writing anything", async () => {
  const { session, nav, capacitor, scheduler, turn } = setup();
  session.install();
  nav.mediaSession.metadata = meta();
  nav.mediaSession.playbackState = "playing";
  await turn();
  const before = capacitor.calls.length;
  assert.equal(session.peek().title, "The brisket episode");
  assert.equal(session.inspect().state, "playing");
  assert.equal(session.inspect().sends, 1);
  assert.equal(session.inspect().installed, true);
  assert.equal(capacitor.calls.length, before, "a diagnostic wrote to the bridge");
});

test("the plugin name and the method name are the ones the Java answers to", () => {
  /* Asserted against the Java itself in `shell-invariants.test.mjs`; pinned here so a
     rename shows up in both places. */
  assert.equal(PLUGIN_NAME, "ForayAudio");
  assert.equal(SET_METHOD, "setNowPlaying");
  assert.equal(TRANSPORT_EVENT, "transport");
});


test("TWO DIFFERENT DISPLAYS CANNOT HASH TO THE SAME IDENTITY", () => {
  /* A MUTATION FOUND THIS GAP: replacing the separator with `""` left every test green,
     because the suite only ever changed ONE field at a time and single-field changes
     differ under any separator. The collision needs two fields moving in opposite
     directions — `{title:"ab", artist:"c"}` against `{title:"a", artist:"bc"}` — which
     is a real shape at a seam, where the title and the show change together.

     What the collision costs: `flush` classifies the change as position-only, so it is
     delayed by up to a second, or never sent at all if the playhead happens to be still
     (paused). The lock screen then keeps the previous segment's text. */
  const left = nowPlayingPayload({
    metadata: meta({ title: "ab", artist: "c" }), playbackState: "playing",
  });
  const right = nowPlayingPayload({
    metadata: meta({ title: "a", artist: "bc" }), playbackState: "playing",
  });
  assert.notEqual(
    identityKey(left), identityKey(right),
    "two different displays hash equal, so one of them will never reach the lock screen"
  );

  /* And the same shape end to end, because the key is only interesting through `flush`. */
  const s = setup({ positionMinIntervalMs: 1000 });
  s.session.install();
  s.nav.mediaSession.metadata = meta({ title: "ab", artist: "c" });
  s.nav.mediaSession.playbackState = "playing";
  s.nav.mediaSession.setPositionState({ duration: 3600, position: 10, playbackRate: 1 });
  return s.turn().then(() => {
    assert.equal(s.sent().length, 1);
    s.advance(50);
    s.nav.mediaSession.metadata = meta({ title: "a", artist: "bc" });
    return s.turn().then(() => {
      assert.equal(s.sent().length, 2, "a title and show change inside the rate limit was not sent");
      assert.equal(s.last().title, "a");
    });
  });
});
