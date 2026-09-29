/* Shared setup for the Playwright browser-integration specs (kanban card
 * t_504fd5fd). One real Chromium tab, one real `foray-sw-fixture` origin per
 * test (test/playwright/lib/server.mjs) serving the copied REAL sw.js
 * (test/playwright/fixture/sw.js — refreshed by copy-sw.mjs, see this repo's
 * package.json "pretest") alongside the minimal fixture app.js/index.html.
 *
 * Deliberately NOT a re-implementation of app.js: the fixture only reads the
 * pin sw.js hands it and tags data/*.json requests with it — see
 * fixture/app.js's own header.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { startFixtureServer } from "./server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, "..", "fixture");

export function fixtureFile(name) {
  return readFileSync(path.join(FIXTURE_DIR, name), "utf8");
}

/**
 * Starts a fixture origin serving index.html, app.js, sw.js (all static,
 * from test/playwright/fixture/) plus whatever `files` the caller supplies
 * for the manifest-tracked set (index.html/app.js/player/client.js/
 * data/forays.json — see server.mjs's TRACKED).
 */
export async function startServer(files) {
  const staticFiles = {
    "index.html": fixtureFile("index.html"),
    "app.js": fixtureFile("app.js"),
    "sw.js": fixtureFile("sw.js"),
  };
  return startFixtureServer({ ...staticFiles, ...files });
}

/** Navigates to the fixture origin and registers sw.js, waiting for it to
 * become the ACTIVE worker (i.e. install + activate both completed) before
 * returning. */
export async function registerAndActivate(page, baseUrl) {
  await page.goto(baseUrl);
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.register("sw.js");
    await new Promise((resolve, reject) => {
      if (reg.active) return resolve();
      const worker = reg.installing || reg.waiting;
      if (!worker) return reject(new Error("no installing/waiting worker after register()"));
      worker.addEventListener("statechange", () => {
        if (worker.state === "activated") resolve();
        if (worker.state === "redundant") reject(new Error("worker became redundant (install failed)"));
      });
    });
  });
}

/** Runs the fixture's data+module fetches and returns window.__state. */
export async function runLoads(page) {
  return page.evaluate(() => window.__runLoads());
}

/** All CacheStorage cache names visible to the fixture origin. */
export async function cacheNames(page) {
  return page.evaluate(() => caches.keys());
}

/**
 * Forces the browser to tear down its current service worker PROCESS for
 * this origin via CDP (real termination, not a page reload) and confirms a
 * fresh instance answers the very next request — the real-browser analogue
 * of test/sw-generation.test.js's "WORKER RESTART MID-REQUEST" suite, which
 * simulates this by simply never calling lifecycle('install') on a freshly
 * constructed harness. Here nothing is simulated: `Target.closeTarget` on
 * the worker's OWN CDP target ends that real OS-level process, and Chrome
 * must spin up a brand new one (with zero in-memory state) to serve the
 * request right after — proving the pin lookup depends on nothing but
 * durable CacheStorage, exactly as sw.js's header claims.
 */
export async function terminateServiceWorker(page) {
  const client = await page.context().newCDPSession(page);
  await client.send("Target.setDiscoverTargets", { discover: true });
  const { targetInfos } = await client.send("Target.getTargets");
  const swTarget = targetInfos.find((t) => t.type === "service_worker");
  if (!swTarget) throw new Error("no service_worker CDP target found to terminate");
  await client.send("Target.closeTarget", { targetId: swTarget.targetId });
  await client.detach();
}

/**
 * Asks the registration for an update and reports what the SECOND worker did
 * (round-3 audit, tests-1). Every "a new deploy lands" spec used to call
 * register()/update() and then assert that the old generation survived, which
 * holds trivially when no second worker ever installs, and one never did while
 * the fixture served sw.js unstamped. Each such spec now asserts this premise
 * first: a new worker appeared (`appeared`) and reached `activated` (a good
 * deploy) or `redundant` (an install that must promote nothing).
 *
 * The `updatefound` listener is attached BEFORE update() runs, so an install
 * that fails fast (already redundant by the time update()'s promise settles)
 * is still seen.
 */
export async function updateAndAwaitNewWorker(page, { timeoutMs = 15000 } = {}) {
  return page.evaluate(async (timeoutMs) => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return { appeared: false, state: "no-registration" };
    const found = new Promise((resolve) => {
      reg.addEventListener("updatefound", () => resolve(reg.installing), { once: true });
    });
    await reg.update().catch(() => {});
    const worker = await Promise.race([found, new Promise((r) => setTimeout(() => r(null), 3000))]);
    if (!worker) return { appeared: false, state: "none" };
    const settled = (s) => s === "activated" || s === "redundant";
    if (settled(worker.state)) return { appeared: true, state: worker.state };
    const state = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(worker.state), timeoutMs);
      worker.addEventListener("statechange", () => {
        if (settled(worker.state)) { clearTimeout(t); resolve(worker.state); }
      });
    });
    return { appeared: true, state };
  }, timeoutMs);
}
