/* Incoming links (#1071): a shared https://foray-web-seven.vercel.app/#/<route>
   opens the same page in the app, and nothing else is let into the address.

   MUTATIONS, each run and red (the test that kills it in brackets):
     - drop the host check (`u.host !== SHARE_HOST`)             [foreign hosts]
     - compare with `endsWith(SHARE_HOST)` instead of `!==`        [lookalike hosts]
     - drop the `https:` check                                    [http and other schemes]
     - drop the `pathname !== "/"` check                          [/api and other paths]
     - drop ROUTE_RE.test(hash)                                   [a hash that is not a route]
     - return "#/" instead of the hash                            [maps a shared route]
     - drop the `?foray=` branch                                  [?foray= maps to the Foray page]
     - drop `arrivedBare === true &&`                             [a reload does not replay the launch URL]
     - call `navigate` before `inAppRouteFor` filters             [a foreign appUrlOpen does not navigate]
     - drop the `getLaunchUrl` read                               [a cold launch from a link lands on it]

   THE FAKE APP PLUGIN delivers exactly what Capacitor's does: `appUrlOpen`
   listeners called with `{ url }`, and `getLaunchUrl()` resolving to `{ url }`
   or to `{}` (an ordinary launch: Capacitor answers with no url, not with
   null). It never calls a listener on its own, so every navigation a test sees
   was caused by the event the test fired. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SHARE_ORIGIN, inAppRouteFor, bindIncomingLinks } from "./incoming-link.js";

function fakeApp({ launchUrl } = {}) {
  const listeners = [];
  return {
    listeners,
    addListener(name, fn) {
      listeners.push({ name, fn });
      return Promise.resolve({ remove: () => {} });
    },
    getLaunchUrl() {
      return Promise.resolve(launchUrl === undefined ? {} : { url: launchUrl });
    },
    fire(url) {
      for (const l of listeners) if (l.name === "appUrlOpen") l.fn({ url });
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));

test("the share origin is the Vercel deployment", () => {
  assert.equal(SHARE_ORIGIN, "https://foray-web-seven.vercel.app");
});

test("maps a shared route to the same in-app hash route", () => {
  assert.equal(inAppRouteFor("https://foray-web-seven.vercel.app/#/show/abc123"), "#/show/abc123");
  assert.equal(inAppRouteFor("https://foray-web-seven.vercel.app/#/foray/grilling-history-2"), "#/foray/grilling-history-2");
  assert.equal(inAppRouteFor("https://foray-web-seven.vercel.app/#/episode/e%2F1?t=30"), "#/episode/e%2F1?t=30");
  // The host is case-insensitive in a URL; the URL parser lowercases it.
  assert.equal(inAppRouteFor("https://FORAY-web-seven.vercel.app/#/search"), "#/search");
  // The bare root, with or without an empty hash, is Home.
  assert.equal(inAppRouteFor("https://foray-web-seven.vercel.app/"), "#/");
  assert.equal(inAppRouteFor("https://foray-web-seven.vercel.app"), "#/");
  assert.equal(inAppRouteFor("https://foray-web-seven.vercel.app/#"), "#/");
  assert.equal(inAppRouteFor("https://foray-web-seven.vercel.app/#/"), "#/");
});

test("?foray= maps to the Foray page", () => {
  assert.equal(inAppRouteFor("https://foray-web-seven.vercel.app/?foray=grilling-history-2"), "#/foray/grilling-history-2");
  assert.equal(inAppRouteFor("https://foray-web-seven.vercel.app/?foray=a%20b"), "#/foray/a%20b");
  // A hash route wins over the query, as it does on the web (enterForayFromQuery).
  assert.equal(inAppRouteFor("https://foray-web-seven.vercel.app/?foray=x#/show/y"), "#/show/y");
});

test("foreign hosts are ignored", () => {
  for (const url of [
    "https://example.com/#/show/abc",
    "https://jw-incorporated.github.io/foray/#/show/abc",
    "https://vercel.app/#/show/abc",
    "https://other-web-seven.vercel.app/#/show/abc",
  ]) assert.equal(inAppRouteFor(url), null, url);
});

test("lookalike hosts are ignored", () => {
  for (const url of [
    "https://foray-web-seven.vercel.app.example.com/#/show/abc",
    "https://evil-foray-web-seven.vercel.app/#/show/abc",
    "https://www.foray-web-seven.vercel.app/#/show/abc",
  ]) assert.equal(inAppRouteFor(url), null, url);
});

test("http and other schemes are ignored", () => {
  for (const url of [
    "http://foray-web-seven.vercel.app/#/show/abc",
    "capacitor://foray-web-seven.vercel.app/#/show/abc",
    "javascript:alert(1)//foray-web-seven.vercel.app/#/show/abc",
  ]) assert.equal(inAppRouteFor(url), null, url);
});

test("a port or a login part is ignored", () => {
  assert.equal(inAppRouteFor("https://foray-web-seven.vercel.app:8443/#/show/abc"), null);
  assert.equal(inAppRouteFor("https://user:pw@foray-web-seven.vercel.app/#/show/abc"), null);
});

test("/api and other paths are ignored", () => {
  for (const url of [
    "https://foray-web-seven.vercel.app/api/session#/show/abc",
    "https://foray-web-seven.vercel.app/api/",
    "https://foray-web-seven.vercel.app/privacy#/show/abc",
    "https://foray-web-seven.vercel.app/index.html#/show/abc",
  ]) assert.equal(inAppRouteFor(url), null, url);
});

test("a hash that is not a route is ignored", () => {
  for (const url of [
    "https://foray-web-seven.vercel.app/#show/abc",
    "https://foray-web-seven.vercel.app/#top",
    `https://foray-web-seven.vercel.app/#/${"a".repeat(2050)}`,
  ]) assert.equal(inAppRouteFor(url), null, url.slice(0, 80));
  // Not a URL at all.
  for (const junk of [undefined, null, 42, "", "not a url", "#/show/abc"]) {
    assert.equal(inAppRouteFor(junk), null, String(junk));
  }
});

test("appUrlOpen routes a shared link in place", () => {
  const app = fakeApp();
  const went = [];
  assert.equal(bindIncomingLinks({ app, navigate: (h) => went.push(h) }), true);
  assert.deepEqual(app.listeners.map((l) => l.name), ["appUrlOpen"]);
  app.fire("https://foray-web-seven.vercel.app/#/show/abc123");
  assert.deepEqual(went, ["#/show/abc123"]);
});

test("a foreign appUrlOpen does not navigate", () => {
  const app = fakeApp();
  const went = [];
  bindIncomingLinks({ app, navigate: (h) => went.push(h) });
  app.fire("https://example.com/#/show/abc123");
  app.fire("https://foray-web-seven.vercel.app/api/session");
  app.fire(undefined);
  assert.deepEqual(went, []);
});

test("a cold launch from a link lands on it", async () => {
  const app = fakeApp({ launchUrl: "https://foray-web-seven.vercel.app/#/foray/grilling-history-2" });
  const went = [];
  bindIncomingLinks({ app, navigate: (h) => went.push(h), arrivedBare: true });
  await tick();
  assert.deepEqual(went, ["#/foray/grilling-history-2"]);
});

test("an ordinary launch navigates nowhere", async () => {
  const app = fakeApp();
  const went = [];
  bindIncomingLinks({ app, navigate: (h) => went.push(h), arrivedBare: true });
  await tick();
  assert.deepEqual(went, []);
});

test("a reload does not replay the launch URL", async () => {
  /* The launch URL is the same for the life of the process. A reload keeps its
     hash, so arrivedBare is false and the listener stays where they went. */
  const app = fakeApp({ launchUrl: "https://foray-web-seven.vercel.app/#/show/abc123" });
  const went = [];
  bindIncomingLinks({ app, navigate: (h) => went.push(h), arrivedBare: false });
  await tick();
  assert.deepEqual(went, []);
  // The event still works on that page.
  app.fire("https://foray-web-seven.vercel.app/#/show/def");
  assert.deepEqual(went, ["#/show/def"]);
});

test("the web, or a shell without the App plugin, binds nothing", () => {
  assert.equal(bindIncomingLinks({ app: null, navigate: () => {} }), false);
  assert.equal(bindIncomingLinks({ app: {}, navigate: () => {} }), false);
  assert.equal(bindIncomingLinks({ app: fakeApp() }), false);
  assert.equal(bindIncomingLinks(), false);
  const throwing = { addListener() { throw new Error("no plugin"); } };
  assert.equal(bindIncomingLinks({ app: throwing, navigate: () => {} }), false);
});

test("client.js binds it at module evaluation with the shell's App plugin, the page hash and a bare-arrival flag", () => {
  /* A SOURCE PIN, deliberately: booting the real client.js takes the whole
     shell harness (player/native-mode.test.js), and what can go wrong here is
     the wiring itself — the call removed, the plugin read from the wrong place,
     arrivedBare hard-coded true (a reload replays the launch URL) or computed
     after app.js could have written a hash. MUTATIONS: delete the
     bindIncomingLinks({...}) call -> red; read `Plugins.ForayAudio` -> red;
     pass `arrivedBare: true` -> red. */
  const src = readFileSync(new URL("./client.js", import.meta.url), "utf8");
  assert.match(src, /^import \{ bindIncomingLinks \} from "\.\/incoming-link\.js";$/m);
  const call = /^ {2}bindIncomingLinks\(\{([\s\S]*?)\n {2}\}\);$/m.exec(src);
  assert.ok(call, "client.js calls bindIncomingLinks({...}) at the top level");
  assert.match(call[1], /app: [^\n]*window\.Capacitor\?\.Plugins\?\.App\b/);
  assert.match(call[1], /navigate: \(hash\) => \{ if \(location\.hash !== hash\) location\.hash = hash; \}/);
  assert.match(call[1], /arrivedBare: [^\n]*\(location\.hash === "" \|\| location\.hash === "#"\)/);
  // Early in module evaluation (inside the top-level try, before the player is
  // published), not left to a later hook that might run after app.js's boot.
  assert.ok(src.indexOf("bindIncomingLinks({") < src.indexOf("window.ForayPlayer = ForayPlayer;"));
});

test("a navigate that throws, or a launch URL that rejects, is contained", async () => {
  const app = fakeApp();
  app.getLaunchUrl = () => Promise.reject(new Error("bridge gone"));
  bindIncomingLinks({ app, navigate: () => { throw new Error("no hash"); }, arrivedBare: true });
  assert.doesNotThrow(() => app.fire("https://foray-web-seven.vercel.app/#/show/abc"));
  await tick();
});
