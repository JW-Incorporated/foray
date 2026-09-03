/* Playwright fixture app — a deliberately minimal stand-in for app.js, not a
 * copy of it. It only implements the two things sw.js's pin mechanism and
 * data path actually depend on:
 *
 *   1. Read the pin (meta tag for a navigation fallback, or the
 *      self.__forayPinnedDeployId global sw.js prepends to a stale .js
 *      fallback) and tag data/*.json requests with it, exactly as the real
 *      app.js's init() does — see sw.js's own header for why this exists.
 *   2. Load the deferred ES module (player/client.js) the same way app.js
 *      does, so MODULE LOAD TIMEOUT has something real to hang on.
 *
 * Everything below is read back from window.__state by the Playwright specs
 * in test/playwright/tests/. There is no UI here worth rendering — the real
 * app.js already has one, and node:vm coverage of it lives in
 * test/app-security.test.js and friends. This fixture exists only to drive
 * the REAL sw.js (test/playwright/fixture/sw.js is a byte-for-byte copy,
 * refreshed by test/playwright/copy-sw.mjs) through a real browser.
 */
window.__state = { ready: false, pin: null };

(function readPin() {
  const meta = document.querySelector('meta[name="foray-pin-deploy-id"]');
  const globalPin = typeof self !== "undefined" ? self.__forayPinnedDeployId : null;
  window.__forayPinnedDeployId = (meta && meta.content) || globalPin || null;
  window.__state.pin = window.__forayPinnedDeployId;
})();

async function loadData() {
  try {
    let url = "data/forays.json";
    if (window.__forayPinnedDeployId) {
      url += (url.includes("?") ? "&" : "?") + "_fdid=" + encodeURIComponent(window.__forayPinnedDeployId);
    }
    const res = await fetch(url, { cache: "no-store" });
    window.__state.dataStatus = res.status;
    window.__state.dataText = res.ok ? await res.text() : null;
  } catch (e) {
    window.__state.dataError = String(e);
  }
}

async function loadModule() {
  try {
    const mod = await import("./player/client.js?v=" + Date.now());
    window.__state.moduleValue = mod.VALUE;
  } catch (e) {
    window.__state.moduleError = String(e);
  }
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (e) => {
    window.__state.lastMessage = e.data;
  });
}

/** Called explicitly by each spec, after registering (and awaiting) the
 * worker it wants active — keeps test timing under the test's control rather
 * than a fixed page-load race. */
window.__runLoads = async function () {
  await Promise.all([loadData(), loadModule()]);
  window.__state.ready = true;
  return window.__state;
};

window.__registerSW = async function () {
  const reg = await navigator.serviceWorker.register("sw.js");
  window.__state.swScope = reg.scope;
  return reg;
};
