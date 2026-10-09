/* The web half of ForayDownloads (PQ-17, #29), driven over a fake bridge:
 * when there is one, what each call hands the plugin, that nothing ever
 * rejects, and how the three events come back.
 *
 * WHAT THIS SUITE IS GUARDING AGAINST, beyond the happy path: the two ways a
 * page can hang on a phone. A native call that never answers (plugin missing
 * from this binary, bridge wedged) must become `{ ok: false, reason:
 * "timeout" }` through an injected timer, and a bridge that throws must become
 * `{ ok: false }` rather than a rejection in `deleteMyData`'s `await`. The
 * event fallback matters too: a bridge with `nativeCallback` but no
 * `addListener` still has to deliver `downloadDone`, or a finished download
 * never turns the button green.
 *
 * Every test names the one-line mutation that turns it red (CLAUDE.md).
 */

import test from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";

import {
  DOWNLOADS_PLUGIN, USER_AGENT, CALL_TIMEOUT_MS, DOWNLOAD_EVENTS, SITE_URL,
  DOWNLOAD_ATTEMPT_EVENT, ATTEMPT_DOM_EVENT, attemptSessionDetail,
  createDownloadBridge, userAgentFor,
} from "./download-bridge.js";
import { DiagnosticLog, PlayerDiagnostics, DOWNLOAD_OUTCOMES } from "./diagnostic-log.js";

/** A bridge that records every `nativePromise` call and answers `answer`. */
function fakeBridge({ answer = { ok: true }, throws = null, withAddListener = true, withNativeCallback = true, convertFileSrc } = {}) {
  const calls = [];
  const listeners = new Map();
  const bridge = {
    nativePromise(plugin, method, options) {
      calls.push({ plugin, method, options });
      if (throws) throw throws;
      return Promise.resolve(typeof answer === "function" ? answer(method, options) : answer);
    },
  };
  if (withAddListener) {
    bridge.addListener = (plugin, eventName, fn) => {
      listeners.set(`${plugin}:${eventName}`, fn);
      return { remove() { listeners.delete(`${plugin}:${eventName}`); } };
    };
  }
  if (withNativeCallback) {
    bridge.nativeCallback = (plugin, method, options, fn) => {
      listeners.set(`${plugin}:${options.eventName}:cb`, fn);
    };
  }
  if (convertFileSrc) bridge.convertFileSrc = convertFileSrc;
  return { bridge, calls, listeners };
}

/** A timer that never fires on its own; the test fires it. */
function manualTimer() {
  const pending = [];
  const setTimeoutFn = (fn, ms) => { pending.push({ fn, ms }); return pending.length; };
  return { pending, setTimeoutFn, fire: () => pending.splice(0).forEach((p) => p.fn()) };
}

// Mutation: drop the `typeof bridge?.nativePromise !== "function"` guard.
test("no bridge, or a bridge without nativePromise, gives null — the page draws no Download control", () => {
  assert.equal(createDownloadBridge({ bridge: null }), null);
  assert.equal(createDownloadBridge({ bridge: undefined }), null);
  assert.equal(createDownloadBridge({}), null);
  // A web `window.Capacitor` shim has getPlatform/isNativePlatform but cannot reach native.
  assert.equal(createDownloadBridge({ bridge: { getPlatform: () => "web", isNativePlatform: () => false } }), null);
  // isNativePlatform() throwing is NOT consulted and NOT fatal (shell-invariants' real bridge).
  const { bridge } = fakeBridge();
  bridge.isNativePlatform = () => { throw new Error("not on this bridge"); };
  assert.ok(createDownloadBridge({ bridge }));
});

// Mutation: rename any key in enqueue's options object, or change DOWNLOADS_PLUGIN.
test("enqueue passes the plugin name, the method and exactly {id, url, userAgent, allowCellular}", async () => {
  const { bridge, calls } = fakeBridge({ answer: { ok: true, id: "ep-1" } });
  const dl = createDownloadBridge({ bridge });
  const r = await dl.enqueue({ id: "ep-1", url: "https://cdn.example/ep1.mp3", userAgent: USER_AGENT, allowCellular: false, extra: "dropped" });
  assert.deepEqual(r, { ok: true, id: "ep-1" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].plugin, "ForayDownloads");
  assert.equal(DOWNLOADS_PLUGIN, "ForayDownloads");
  assert.equal(calls[0].method, "enqueue");
  assert.deepEqual(calls[0].options, { id: "ep-1", url: "https://cdn.example/ep1.mp3", userAgent: USER_AGENT, allowCellular: false });
  // The other id-taking calls carry only the id.
  await dl.cancel({ id: "ep-1" });
  await dl.remove({ id: "ep-1" });
  assert.deepEqual(calls.slice(1).map((c) => [c.method, c.options]), [["cancel", { id: "ep-1" }], ["remove", { id: "ep-1" }]]);
});

// Mutation: remove the rejection handler (`(err) => settle(...)`) from `call`.
test("a throwing bridge resolves {ok:false, reason} — never rejects", async () => {
  const { bridge } = fakeBridge({ throws: new Error("plugin ForayDownloads is not implemented") });
  const dl = createDownloadBridge({ bridge });
  const r = await dl.list();
  assert.equal(r.ok, false);
  assert.match(r.reason, /not implemented/);
  // A bridge that rejects (rather than throws synchronously) is the same answer.
  const rejecting = { nativePromise: () => Promise.reject("busy") };
  const r2 = await createDownloadBridge({ bridge: rejecting }).usage();
  assert.deepEqual(r2, { ok: false, reason: "busy" });
});

// Mutation: in `scheduler`, never call `setTimeoutFn` (`const timer = null`).
test("a call that never answers resolves {ok:false, reason:\"timeout\"} at the 10 s deadline (injected timer)", async () => {
  const bridge = { nativePromise: () => new Promise(() => {}) };
  const timer = manualTimer();
  const dl = createDownloadBridge({ bridge, setTimeoutFn: timer.setTimeoutFn });
  const p = dl.enqueue({ id: "ep-2", url: "https://cdn.example/ep2.mp3", userAgent: USER_AGENT, allowCellular: true });
  assert.equal(timer.pending.length, 1);
  assert.equal(timer.pending[0].ms, CALL_TIMEOUT_MS);
  assert.equal(CALL_TIMEOUT_MS, 10_000);
  timer.fire();
  assert.deepEqual(await p, { ok: false, reason: "timeout" });
  // The deadline firing AFTER a real answer changes nothing (first settle wins).
  const quick = fakeBridge({ answer: { ok: true, bytes: 1 } });
  const t2 = manualTimer();
  const r = await createDownloadBridge({ bridge: quick.bridge, setTimeoutFn: t2.setTimeoutFn }).usage();
  t2.fire();
  assert.deepEqual(r, { ok: true, bytes: 1 });
});

// Mutation: forward `payload` without `name`, or subscribe fewer than the three events.
test("the three plugin events are subscribed via addListener and forwarded as onEvent(name, payload)", () => {
  const { bridge, listeners } = fakeBridge();
  const seen = [];
  const dl = createDownloadBridge({ bridge, onEvent: (name, payload) => seen.push([name, payload]) });
  assert.deepEqual(DOWNLOAD_EVENTS, ["downloadProgress", "downloadDone", "downloadFailed"]);
  for (const name of DOWNLOAD_EVENTS) assert.ok(listeners.has(`ForayDownloads:${name}`), `${name} subscribed via addListener`);
  // CH-12: addListener's own handle comes back, one per event, in DOWNLOAD_EVENTS order.
  assert.equal(dl.handles.length, DOWNLOAD_EVENTS.length);
  for (const h of dl.handles) assert.equal(typeof h?.remove, "function", "the addListener handle is returned");
  listeners.get("ForayDownloads:downloadProgress")({ id: "ep-1", bytes: 43, total: 100 });
  listeners.get("ForayDownloads:downloadDone")({ id: "ep-1", path: "/files/ep-1.mp3", bytes: 100 });
  listeners.get("ForayDownloads:downloadFailed")({ id: "ep-3", reason: "http", status: 403 });
  assert.deepEqual(seen, [
    ["downloadProgress", { id: "ep-1", bytes: 43, total: 100 }],
    ["downloadDone", { id: "ep-1", path: "/files/ep-1.mp3", bytes: 100 }],
    ["downloadFailed", { id: "ep-3", reason: "http", status: 403 }],
  ]);
  dl.handles[1].remove();
  assert.equal(listeners.has("ForayDownloads:downloadDone"), false, "handles[1] is downloadDone's own handle");
  assert.equal(listeners.has("ForayDownloads:downloadProgress"), true);
  // A listener that throws does not break the wire.
  const noisy = fakeBridge();
  createDownloadBridge({ bridge: noisy.bridge, onEvent: () => { throw new Error("page bug"); } });
  assert.doesNotThrow(() => noisy.listeners.get("ForayDownloads:downloadDone")({ id: "x" }));
});

// Mutation: drop the `nativeCallback` fallback branch from native-engine.js's `listenTo` (the helper this file imports, CH-12).
test("without addListener, events arrive through nativeCallback(plugin, \"addListener\", {eventName}, fn)", () => {
  const { bridge, listeners } = fakeBridge({ withAddListener: false });
  const seen = [];
  const dl = createDownloadBridge({ bridge, onEvent: (name, payload) => seen.push([name, payload]) });
  assert.ok(dl, "the bridge still exists without addListener");
  for (const name of DOWNLOAD_EVENTS) assert.ok(listeners.has(`ForayDownloads:${name}:cb`), `${name} subscribed via nativeCallback`);
  /* The three record events and the one diagnostics event (#29, 29-part). */
  assert.equal(listeners.size, DOWNLOAD_EVENTS.length + 1, "nothing registered under any other plugin or event");
  assert.ok(listeners.has(`ForayDownloads:${DOWNLOAD_ATTEMPT_EVENT}:cb`), "the attempt event too");
  // CH-12: the thinner primitive has no handle to give back, so each is null.
  assert.deepEqual(dl.handles, [null, null, null]);
  listeners.get("ForayDownloads:downloadDone:cb")({ id: "ep-1", path: "/files/ep-1.mp3", bytes: 7 });
  assert.deepEqual(seen, [["downloadDone", { id: "ep-1", path: "/files/ep-1.mp3", bytes: 7 }]]);
  // Neither path: still a usable bridge (the page can list() on resume).
  const bare = fakeBridge({ withAddListener: false, withNativeCallback: false });
  const bareDl = createDownloadBridge({ bridge: bare.bridge, onEvent: () => {} });
  assert.ok(bareDl);
  assert.deepEqual(bareDl.handles, [null, null, null]);
  // A throwing addListener is swallowed, not fatal.
  const hostile = { nativePromise: () => Promise.resolve({ ok: true }), addListener: () => { throw new Error("no"); } };
  const hostileDl = createDownloadBridge({ bridge: hostile });
  assert.ok(hostileDl);
  assert.deepEqual(hostileDl.handles, [null, null, null]);
});

// Mutation: return `path` unconditionally from `fileSrc`.
test("fileSrc uses the bridge's convertFileSrc when present, else the path as given", () => {
  const { bridge } = fakeBridge({ convertFileSrc: (p) => `https://localhost/_capacitor_file_${p}` });
  const dl = createDownloadBridge({ bridge });
  assert.equal(dl.fileSrc({ path: "/data/files/ep-1.mp3" }), "https://localhost/_capacitor_file_/data/files/ep-1.mp3");
  const plain = createDownloadBridge({ bridge: fakeBridge().bridge });
  assert.equal(plain.fileSrc({ path: "/data/files/ep-1.mp3" }), "/data/files/ep-1.mp3");
  // Synchronous: it rewrites a string, it asks the phone nothing.
  const { bridge: b2, calls } = fakeBridge({ convertFileSrc: (p) => p });
  createDownloadBridge({ bridge: b2 }).fileSrc({ path: "/x" });
  assert.equal(calls.length, 0);
});

// Mutation: delete `removeAll` from the returned object (deleteMyData's purge would then throw).
test("removeAll, list and usage exist, take no arguments and reach the plugin by name", async () => {
  const { bridge, calls } = fakeBridge({ answer: (method) => ({ ok: true, method }) });
  const dl = createDownloadBridge({ bridge });
  for (const m of ["enqueue", "cancel", "remove", "removeAll", "list", "usage", "fileSrc"]) {
    assert.equal(typeof dl[m], "function", `${m} is a function`);
  }
  assert.deepEqual(await dl.removeAll(), { ok: true, method: "removeAll" });
  assert.deepEqual(await dl.list(), { ok: true, method: "list" });
  assert.deepEqual(await dl.usage(), { ok: true, method: "usage" });
  assert.deepEqual(calls.map((c) => [c.plugin, c.method, c.options]), [
    ["ForayDownloads", "removeAll", {}],
    ["ForayDownloads", "list", {}],
    ["ForayDownloads", "usage", {}],
  ]);
});

// Mutation: drop the `(+${SITE_URL})` suffix, or change the site URL.
test("USER_AGENT is `4a/<build> (+https://jw-incorporated.github.io/foray/)`, build \"dev\" off a stamped host", () => {
  assert.equal(SITE_URL, "https://jw-incorporated.github.io/foray/");
  assert.match(USER_AGENT, /^4a\/[^\s()]+ \(\+https:\/\/jw-incorporated\.github\.io\/foray\/\)$/);
  // The default, before the caller knows the build (userAgentFor below).
  assert.equal(USER_AGENT, "4a/dev (+https://jw-incorporated.github.io/foray/)");
});

/* Integration review (2026-10-04): the deadline used to outlive the answer —
   every settled call left a ten-second timer behind (this very suite took
   10 s to exit because of it), and the page will `list()` on every resume.
   MUTATION: make `scheduler`'s cancel a no-op (drop its `clearTimeoutFn(timer)`)
   and the `cleared` assertion fails. */
test("an answered call clears its deadline; the timer is not left running", async () => {
  const pending = new Map();
  const cleared = [];
  let next = 100;
  const setTimeoutFn = (fn, ms) => { const h = next++; pending.set(h, { fn, ms }); return h; };
  const clearTimeoutFn = (h) => { cleared.push(h); pending.delete(h); };
  const { bridge } = fakeBridge({ answer: { ok: true, bytes: 5 } });
  const dl = createDownloadBridge({ bridge, setTimeoutFn, clearTimeoutFn });
  const r = await dl.usage();
  assert.deepEqual(r, { ok: true, bytes: 5 });
  assert.deepEqual(cleared, [100], "the deadline armed for this call is cleared once it answers");
  assert.equal(pending.size, 0, "no timer is left armed");
  // A rejection settles the same way.
  const rejecting = createDownloadBridge({ bridge: { nativePromise: () => Promise.reject("busy") }, setTimeoutFn, clearTimeoutFn });
  assert.deepEqual(await rejecting.list(), { ok: false, reason: "busy" });
  assert.deepEqual(cleared, [100, 101]);
  assert.equal(pending.size, 0);
});

/* MUTATION: return `4a/${String(build)} (+${SITE_URL})` unsanitised in
   `userAgentFor` and the "1.4 (37)" assertion fails; drop the `|| "dev"`
   fallback and the empty-build assertions fail. */
test("userAgentFor composes the build into one product token, and an absent build is dev", () => {
  assert.equal(userAgentFor("37"), "4a/37 (+https://jw-incorporated.github.io/foray/)");
  assert.equal(userAgentFor(37), "4a/37 (+https://jw-incorporated.github.io/foray/)");
  // A marketing version with a build in parentheses is still ONE token.
  assert.equal(userAgentFor("1.4 (37)"), "4a/1.4-37 (+https://jw-incorporated.github.io/foray/)");
  for (const none of [null, undefined, "", "  ", "()", NaN, {}]) {
    assert.equal(userAgentFor(none), "4a/dev (+https://jw-incorporated.github.io/foray/)", String(none));
  }
  assert.equal(USER_AGENT, userAgentFor(null));
});

test("a resolved answer with no ok of its own reads as ok: true; an explicit ok: false is believed", async () => {
  /* Capacitor resolves on success and rejects on error; a plugin that answers
     `list()` with its rows and no `ok` field has succeeded. Callers branch on
     `ok`, so the wire fills it in — and never overrides a plugin that says
     `ok: false` itself. MUTATION: settle `result` as-is and the first two
     asserts fail. */
  const answers = { list: { items: [{ id: "e1" }] }, usage: {}, cancel: { ok: false, reason: "unknown-id" } };
  const bridge = { nativePromise: async (_plugin, method) => answers[method] };
  const dl = createDownloadBridge({ bridge, setTimeoutFn: () => {} });
  const list = await dl.list();
  assert.equal(list.ok, true);
  assert.deepEqual(list.items, [{ id: "e1" }]);
  assert.equal((await dl.usage()).ok, true);
  assert.deepEqual(await dl.cancel({ id: "x" }), { ok: false, reason: "unknown-id" });
});

/* CH-40 characterization (code-health P2-05). call()'s contract beyond the
   deadline itself: a host whose timer cannot be armed still gets the plugin's
   answer (no deadline, not a lost answer); a clear that throws is swallowed; a
   null timer handle is never handed to clearTimeoutFn; and the timeout answer
   is a fresh object per call.
   MUTATIONS: drop the try around `scheduler.schedule` in deadline.js -> the
   first usage() rejects; drop the try around `cancel()` in deadline.js's
   `settle` -> the second never settles (the test's timeout is the red); drop
   `timer != null` in this module's `scheduler` -> `cleared` holds a null. */
test("CH-40 characterization: no timer, a throwing clear and a null handle all still deliver the answer; each timeout answer is its own object", { timeout: 5000 }, async () => {
  const { bridge } = fakeBridge({ answer: { ok: true, bytes: 7 } });
  const noTimer = createDownloadBridge({ bridge, setTimeoutFn: () => { throw new Error("no timers here"); } });
  assert.deepEqual(await noTimer.usage(), { ok: true, bytes: 7 });
  const badClear = createDownloadBridge({ bridge, setTimeoutFn: () => 1, clearTimeoutFn: () => { throw new Error("cannot clear"); } });
  assert.deepEqual(await badClear.usage(), { ok: true, bytes: 7 });
  const cleared = [];
  const nullHandle = createDownloadBridge({ bridge, setTimeoutFn: () => null, clearTimeoutFn: (h) => cleared.push(h) });
  assert.deepEqual(await nullHandle.usage(), { ok: true, bytes: 7 });
  assert.deepEqual(cleared, [], "a null handle is not cleared");

  const fires = [];
  const hung = createDownloadBridge({
    bridge: { nativePromise: () => new Promise(() => {}) },
    setTimeoutFn: (fn) => { fires.push(fn); return fires.length; },
    clearTimeoutFn: () => {},
  });
  const a = hung.list();
  const b = hung.usage();
  for (const fire of fires) fire();
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual(ra, { ok: false, reason: "timeout" });
  assert.deepEqual(rb, { ok: false, reason: "timeout" });
  assert.notStrictEqual(ra, rb, "a caller that edits its answer cannot edit another's");
});

/* ─────────── #29 (29-part): the download attempt row ───────────

   `DownloadStore.swift` emits `downloadAttempt { reqHost, finalHost, status,
   expected, received, outcome, at }` once per attempt. The bridge does NOT
   hand it to `onEvent` (app.js's `reportFromEvent` keys record statuses, and
   an attempt is not one): it re-broadcasts it on `window` as `foray:session`,
   the channel `player/client.js` already feeds into `diag.sessionEvent`, as a
   row of kind `downloadAttempt` from producer `downloads`. */

/** A window that records what was dispatched on it. */
function fakeWindow() {
  const dispatched = [];
  class CustomEvent {
    constructor(type, init) { this.type = type; this.detail = init?.detail; }
  }
  return { dispatched, win: { CustomEvent, dispatchEvent: (e) => { dispatched.push(e); return true; } } };
}

const ATTEMPT = Object.freeze({
  reqHost: "dts.podtrac.com", finalHost: "traffic.megaphone.fm", status: 200,
  expected: 52_428_800, received: 52_428_800, outcome: "done", at: 1_759_700_000_000,
});

// Mutation: forward `downloadAttempt` through `forward(name, payload)` like the three record events.
test("#29: downloadAttempt is re-broadcast as a foray:session row and never reaches onEvent", () => {
  const { bridge, listeners } = fakeBridge();
  const { dispatched, win } = fakeWindow();
  const seen = [];
  const dl = createDownloadBridge({ bridge, onEvent: (name) => seen.push(name), win });
  assert.equal(DOWNLOAD_ATTEMPT_EVENT, "downloadAttempt");
  assert.equal(ATTEMPT_DOM_EVENT, "foray:session");
  assert.ok(!DOWNLOAD_EVENTS.includes(DOWNLOAD_ATTEMPT_EVENT), "not a record-status event");
  assert.equal(typeof dl.attemptHandle?.remove, "function", "its addListener handle is kept apart from handles");
  listeners.get(`ForayDownloads:${DOWNLOAD_ATTEMPT_EVENT}`)({ ...ATTEMPT });
  assert.deepEqual(seen, []);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].type, "foray:session");
  assert.deepEqual(dispatched[0].detail, {
    kind: "downloadAttempt", producer: "downloads", reason: "done", at: 1_759_700_000_000,
    reqHost: "dts.podtrac.com", finalHost: "traffic.megaphone.fm", status: 200,
    expected: 52_428_800, received: 52_428_800,
  });
  // No window, or one that throws, is no row and no crash.
  const thrower = { CustomEvent: fakeWindow().win.CustomEvent, dispatchEvent: () => { throw new Error("no"); } };
  const quiet = fakeBridge();
  createDownloadBridge({ bridge: quiet.bridge, win: thrower });
  assert.doesNotThrow(() => quiet.listeners.get(`ForayDownloads:${DOWNLOAD_ATTEMPT_EVENT}`)({ ...ATTEMPT }));
  const none = fakeBridge();
  createDownloadBridge({ bridge: none.bridge, win: null });
  assert.doesNotThrow(() => none.listeners.get(`ForayDownloads:${DOWNLOAD_ATTEMPT_EVENT}`)({ ...ATTEMPT }));
});

// Mutation: build the detail as `{ ...payload, kind, producer }` -> `url` rides along.
test("#29: the attempt detail TAKES its six fields and forces kind and producer, so the plugin cannot pose as a session event", () => {
  /* `foray:session` also reaches client.js's `onNativeSession`, which pauses
     on `routeChange`/`old-device-gone`: a payload that could set `kind` could
     pause playback. */
  const detail = attemptSessionDetail({
    ...ATTEMPT, kind: "routeChange", reason: "old-device-gone", producer: "audio",
    url: "https://dts.podtrac.com/redirect.mp3/x?token=abc",
  });
  assert.equal(detail.kind, "downloadAttempt");
  assert.equal(detail.producer, "downloads");
  assert.equal(detail.reason, "done", "reason is the payload's outcome, not its reason");
  assert.deepEqual(Object.keys(detail).sort(),
    ["at", "expected", "finalHost", "kind", "producer", "reason", "received", "reqHost", "status"]);
  assert.deepEqual(attemptSessionDetail(null), {
    kind: "downloadAttempt", producer: "downloads", reason: null, at: null,
    reqHost: null, finalHost: null, status: null, expected: null, received: null,
  });
});

// Mutation: drop "downloadAttempt" from diagnostic-log.js's SESSION_KINDS -> no row.
test("#29: end to end, the bridge's row lands in the diagnostics record with hosts only", () => {
  const { bridge, listeners } = fakeBridge();
  const storage = { map: new Map(), getItem(k) { return this.map.get(k) ?? null; }, setItem(k, v) { this.map.set(k, v); }, removeItem(k) { this.map.delete(k); } };
  const log = new DiagnosticLog({ storage, now: () => 1_759_700_000_100 });
  const diag = new PlayerDiagnostics({ log, now: () => 1_759_700_000_100 });
  const win = { CustomEvent: fakeWindow().win.CustomEvent, dispatchEvent: (e) => { diag.sessionEvent(e.detail); return true; } };
  createDownloadBridge({ bridge, win });
  listeners.get(`ForayDownloads:${DOWNLOAD_ATTEMPT_EVENT}`)({ ...ATTEMPT, reqHost: "https://dts.podtrac.com/x?t=1" });
  const rows = log.read().entries.filter((e) => e.type === "session");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "downloadAttempt");
  assert.equal(rows[0].producer, "downloads");
  assert.equal(rows[0].reason, "done");
  assert.equal(rows[0].reqHost, undefined, "a URL is refused by the record");
  assert.equal(rows[0].finalHost, "traffic.megaphone.fm");
  assert.equal(rows[0].lagMs, 100);
  assert.doesNotMatch(JSON.stringify(log.read()), /token|\?t=|https:/);
});

// Mutation: rename `eventAttempt` in DownloadPolicy.swift, or a payload key, or an outcome constant -> red.
test("#29: DownloadPolicy.swift's attempt event, payload keys and outcomes are the ones this side reads", () => {
  const swiftDir = new URL("../mobile/plugins/foray-downloads/ios/Sources/ForayDownloadsPlugin/", import.meta.url);
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const policy = strip(fs.readFileSync(new URL("DownloadPolicy.swift", swiftDir), "utf8"));
  const store = strip(fs.readFileSync(new URL("DownloadStore.swift", swiftDir), "utf8"));
  assert.match(policy, new RegExp(`public static let eventAttempt = "${DOWNLOAD_ATTEMPT_EVENT}"`));
  const body = /func attemptPayload\([^)]*\) -> \[String: Any\] \{([^}]*)\}/.exec(policy)?.[1] ?? "";
  const keys = [...body.matchAll(/"([A-Za-z]+)":/g)].map((m) => m[1]).sort();
  assert.deepEqual(keys, ["at", "expected", "finalHost", "outcome", "received", "reqHost", "status"]);
  const outcomes = [...policy.matchAll(/public static let outcome[A-Z][A-Za-z]* = "([a-z-]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(outcomes, [...DOWNLOAD_OUTCOMES].sort());
  /* Hosts only: the payload is built from `hostOf`, never `absoluteString`. */
  assert.match(body, /"reqHost": nullable\(hostOf\(requested\)\)/);
  assert.match(body, /"finalHost": nullable\(hostOf\(landed\)\)/);
  assert.doesNotMatch(body, /absoluteString|\.path\b|\.query\b/);
  assert.match(store, /emit\?\(DownloadPolicy\.eventAttempt,/);
});

/* ─────────── CH3-05: the native index is the one truth ───────────

   iOS moves the app's container on every update, so a download's absolute
   path changes; ForayDownloadsPlugin.swift's header says the page should take
   paths from `list()`. And a transfer that finished (or was flipped to
   `interrupted`) while 4a was not running emitted its event before the page
   listened. Both heal only if the page re-reads the native index. */

const NEW_PATH = "/var/mobile/Containers/Data/Application/NEW-UUID/Library/Application Support/foray-downloads/e1.bin";

/** Wait out the bridge's own promise chain (call -> withinMs -> then). */
const settleBridge = () => new Promise((r) => setImmediate(r));

/* CH3-05 characterization (R4-02/R4-04): today a bridge built WITH a listener
   asks the plugin nothing — `list()` has no production caller (the only
   `.list(` calls in app.js and player/ are forayProgress's). */
test("CH3-05 characterization: a bridge with a listener asks the plugin nothing; list() has no production caller", async () => {
  const { bridge, calls } = fakeBridge({ answer: { items: [] } });
  createDownloadBridge({ bridge, onEvent: () => {} });
  await settleBridge();
  assert.deepEqual(calls.map((c) => c.method), []);
  const callers = ["../app.js", "./client.js", "./download-store.js", "./download-bridge.js"]
    .flatMap((rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").split("\n").filter((l) => /\.list\(/.test(l) && !/forayProgress\.list\(/.test(l)));
  assert.deepEqual(callers.filter((l) => !/list: \(\) =>|list\(\): Promise/.test(l)), []);
});

// RED on main: R4-02 — nothing calls list(), so the listener never hears today's path.
/* MUTATION: drop the boot replay in createDownloadBridge -> nothing is heard. */
test("CH3-05: a listener hears the native index at subscription: a done row is replayed as downloadDone with TODAY's path", async () => {
  const { bridge, calls } = fakeBridge({
    answer: (method) => (method === "list" ? { items: [{ id: "e1", status: "done", bytes: 1234, total: 1234, reason: null, path: NEW_PATH }] } : {}),
  });
  const seen = [];
  createDownloadBridge({ bridge, onEvent: (name, payload) => seen.push([name, payload]) });
  await settleBridge();
  assert.deepEqual(calls.map((c) => c.method), ["list"]);
  assert.deepEqual(seen, [["downloadDone", { id: "e1", path: NEW_PATH, bytes: 1234 }]]);
});
