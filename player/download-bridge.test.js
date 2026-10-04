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

import {
  DOWNLOADS_PLUGIN, USER_AGENT, CALL_TIMEOUT_MS, DOWNLOAD_EVENTS, SITE_URL,
  createDownloadBridge, userAgentFor,
} from "./download-bridge.js";

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

// Mutation: drop the `setTimeoutFn(...)` line from `call`.
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
  createDownloadBridge({ bridge, onEvent: (name, payload) => seen.push([name, payload]) });
  assert.deepEqual(DOWNLOAD_EVENTS, ["downloadProgress", "downloadDone", "downloadFailed"]);
  for (const name of DOWNLOAD_EVENTS) assert.ok(listeners.has(`ForayDownloads:${name}`), `${name} subscribed via addListener`);
  listeners.get("ForayDownloads:downloadProgress")({ id: "ep-1", bytes: 43, total: 100 });
  listeners.get("ForayDownloads:downloadDone")({ id: "ep-1", path: "/files/ep-1.mp3", bytes: 100 });
  listeners.get("ForayDownloads:downloadFailed")({ id: "ep-3", reason: "http", status: 403 });
  assert.deepEqual(seen, [
    ["downloadProgress", { id: "ep-1", bytes: 43, total: 100 }],
    ["downloadDone", { id: "ep-1", path: "/files/ep-1.mp3", bytes: 100 }],
    ["downloadFailed", { id: "ep-3", reason: "http", status: 403 }],
  ]);
  // A listener that throws does not break the wire.
  const noisy = fakeBridge();
  createDownloadBridge({ bridge: noisy.bridge, onEvent: () => { throw new Error("page bug"); } });
  assert.doesNotThrow(() => noisy.listeners.get("ForayDownloads:downloadDone")({ id: "x" }));
});

// Mutation: drop the `nativeCallback` fallback branch from `listen`.
test("without addListener, events arrive through nativeCallback(plugin, \"addListener\", {eventName}, fn)", () => {
  const { bridge, listeners } = fakeBridge({ withAddListener: false });
  const seen = [];
  const dl = createDownloadBridge({ bridge, onEvent: (name, payload) => seen.push([name, payload]) });
  assert.ok(dl, "the bridge still exists without addListener");
  for (const name of DOWNLOAD_EVENTS) assert.ok(listeners.has(`ForayDownloads:${name}:cb`), `${name} subscribed via nativeCallback`);
  listeners.get("ForayDownloads:downloadDone:cb")({ id: "ep-1", path: "/files/ep-1.mp3", bytes: 7 });
  assert.deepEqual(seen, [["downloadDone", { id: "ep-1", path: "/files/ep-1.mp3", bytes: 7 }]]);
  // Neither path: still a usable bridge (the page can list() on resume).
  const bare = fakeBridge({ withAddListener: false, withNativeCallback: false });
  assert.ok(createDownloadBridge({ bridge: bare.bridge, onEvent: () => {} }));
  // A throwing addListener is swallowed, not fatal.
  const hostile = { nativePromise: () => Promise.resolve({ ok: true }), addListener: () => { throw new Error("no"); } };
  assert.ok(createDownloadBridge({ bridge: hostile }));
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
   MUTATION: drop the `clearTimeoutFn(timer)` line in `call` and the
   `cleared` assertion fails. */
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
