/* Notification taps (#761, PQ-28 step (2), the JS half): a tapped new-episode
   alert opens `#/show/<id>`, and nothing else reaches the address.

   MUTATIONS, each run and red (the test that kills it in brackets):
     - hard-code a different event name ("alertTapped")           [subscribes to ForayNotify/alertOpened]
     - hard-code a different plugin name ("ForayAlerts")          [subscribes to ForayNotify/alertOpened]
     - drop the try/catch around navigate (the guard)             [a throwing navigate does not escape]
     - drop `if (route === null) return;`                         [navigate is not called for a null route]
     - drop encodeURIComponent                                    [routes a showId]
     - drop the `showId === ""` check                             [null for an empty string or a non-string]
     - drop the `typeof showId !== "string"` check                [null for an empty string or a non-string]
     - return null instead of listenTo's handle                   [subscribes to ForayNotify/alertOpened]
     - paste listenTo's body in place of the import               [one listenTo]

   THE FAKE BRIDGE is shaped like `window.Capacitor`: `addListener(plugin,
   eventName, fn)` records the subscription and returns a handle with
   `remove()`. It never calls a listener on its own, so every navigation a test
   sees was caused by the event the test fired. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ALERT_PLUGIN, ALERT_EVENT, routeForAlert, bindAlertOpen } from "./alert-open.js";

function fakeBridge() {
  const subs = [];
  return {
    subs,
    addListener(plugin, eventName, fn) {
      const handle = { plugin, eventName, removed: false, remove() { this.removed = true; } };
      subs.push({ plugin, eventName, fn, handle });
      return handle;
    },
    fire(plugin, eventName, payload) {
      for (const s of subs) if (s.plugin === plugin && s.eventName === eventName) s.fn(payload);
    },
  };
}

test("routes a showId to its show page, encoded", () => {
  assert.equal(routeForAlert({ showId: "abc" }), "#/show/abc");
  assert.equal(routeForAlert({ showId: "pi:1234" }), "#/show/pi%3A1234");
  assert.equal(routeForAlert({ showId: "a/b c#d" }), "#/show/a%2Fb%20c%23d");
});

test("null with no showId", () => {
  assert.equal(routeForAlert(undefined), null);
  assert.equal(routeForAlert(null), null);
  assert.equal(routeForAlert({}), null);
  assert.equal(routeForAlert({ show_id: "abc" }), null);
  assert.equal(routeForAlert("abc"), null);
});

test("null for an empty string or a non-string", () => {
  assert.equal(routeForAlert({ showId: "" }), null);
  assert.equal(routeForAlert({ showId: 42 }), null);
  assert.equal(routeForAlert({ showId: null }), null);
  assert.equal(routeForAlert({ showId: ["abc"] }), null);
  assert.equal(routeForAlert({ showId: { id: "abc" } }), null);
  assert.equal(routeForAlert({ showId: true }), null);
});

test("subscribes to ForayNotify/alertOpened through addListener and returns the handle", () => {
  assert.equal(ALERT_PLUGIN, "ForayNotify");
  assert.equal(ALERT_EVENT, "alertOpened");
  const bridge = fakeBridge();
  const seen = [];
  const handle = bindAlertOpen(bridge, (route) => seen.push(route));
  assert.equal(bridge.subs.length, 1);
  assert.equal(bridge.subs[0].plugin, "ForayNotify");
  assert.equal(bridge.subs[0].eventName, "alertOpened");
  assert.equal(handle, bridge.subs[0].handle, "the handle addListener returned, so PQ-28 can remove() it");
  bridge.fire("ForayNotify", "alertOpened", { showId: "s-1" });
  assert.deepEqual(seen, ["#/show/s-1"]);
});

test("navigate is not called for a null route", () => {
  const bridge = fakeBridge();
  const seen = [];
  bindAlertOpen(bridge, (route) => seen.push(route));
  bridge.fire("ForayNotify", "alertOpened", {});
  bridge.fire("ForayNotify", "alertOpened", { showId: "" });
  bridge.fire("ForayNotify", "alertOpened", { showId: 7 });
  bridge.fire("ForayNotify", "alertOpened", undefined);
  assert.deepEqual(seen, []);
});

test("a throwing navigate does not escape the listener", () => {
  const bridge = fakeBridge();
  let calls = 0;
  bindAlertOpen(bridge, () => { calls += 1; throw new Error("cannot set hash"); });
  assert.doesNotThrow(() => bridge.fire("ForayNotify", "alertOpened", { showId: "s-1" }));
  assert.equal(calls, 1, "navigate was reached, and its throw was swallowed");
});

test("never throws on a missing bridge, a bridge with no event path, or a throwing addListener", () => {
  assert.equal(bindAlertOpen(null, () => {}), null);
  assert.equal(bindAlertOpen(undefined, () => {}), null);
  assert.equal(bindAlertOpen({}, () => {}), null);
  assert.equal(bindAlertOpen({ addListener() { throw new Error("no plugin"); } }, () => {}), null);
  const bridge = fakeBridge();
  bindAlertOpen(bridge, "not a function");
  assert.doesNotThrow(() => bridge.fire("ForayNotify", "alertOpened", { showId: "s-1" }));
});

test("one listenTo (CH-12): imported from native-engine.js, its body never copied", () => {
  const src = readFileSync(new URL("./alert-open.js", import.meta.url), "utf8");
  assert.match(src, /import \{ listenTo \} from "\.\/native-engine\.js";/);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\.addListener\(|nativeCallback/, "the subscription goes through listenTo, not a copy of it");
});
