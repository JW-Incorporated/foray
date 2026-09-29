/* MODULE LOAD TIMEOUT — real-browser coverage for the same scenario
 * test/sw-generation.test.js covers with a `setTimeout`-recorder harness
 * (kanban card t_504fd5fd). Here the hang is a REAL HTTP request the fixture
 * server (test/playwright/lib/server.mjs) never answers, driven through a
 * real Chromium service worker via sw.js's own NET_TIMEOUT_MS-bounded
 * `fromOrigin()` — nothing about the timeout mechanism is reproduced here,
 * only exercised.
 */
import { test, expect } from "@playwright/test";
import { startServer, registerAndActivate, cacheNames, updateAndAwaitNewWorker } from "../lib/harness.mjs";

test.describe("MODULE LOAD TIMEOUT (real browser)", () => {
  test("player/client.js hanging during install aborts the whole install", async ({ page }) => {
    test.setTimeout(45_000);
    const server = await startServer({
      "player/client.js": "export const VALUE = 1;",
      "data/forays.json": '{"forays":["v1"]}',
    });
    server.hangOn("player/client.js");

    try {
      await page.goto(server.baseUrl);
      // register() itself resolves once the registration is queued, not once
      // install finishes — the hung fetch inside precache() (sw.js) has no
      // bound of its own at install time (only runtime fetches go through
      // NET_TIMEOUT_MS), so the real assertion is what install never
      // produces, not a race against its own completion. A fixed wait plus a
      // cache-state check is what test/sw-generation.test.js's node:vm
      // version asserts too, just via a `setTimeout` recorder instead of a
      // wall clock.
      //
      // Deliberately NOT awaited: some browsers keep register()'s own
      // returned promise pending until the install microtask queue settles,
      // which here never happens (that's the whole point of the hang) — a
      // real observed CI failure. Firing it and moving on, then polling
      // getRegistration() separately, is what actually exercises "install
      // never completes" instead of blocking the test on the same hang it's
      // trying to observe.
      await page.evaluate(() => {
        navigator.serviceWorker.register("sw.js").catch(() => {});
      });
      await page.waitForTimeout(5000);

      const state = await page.evaluate(async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        const worker = reg && (reg.installing || reg.waiting || reg.active);
        return worker ? worker.state : "no-worker";
      });
      expect(state).toBe("installing");

      const names = await cacheNames(page);
      expect(names.some((n) => n.startsWith("foray-gen-"))).toBe(false);
    } finally {
      server.clearFaults();
      await server.close();
    }
  });

  test("a rejected (not merely slow) module fetch aborts install and leaves the old pointer", async ({
    page,
  }) => {
    // First generation: install a WORKING worker so there is an "old
    // pointer" to prove untouched — mirrors the node:vm test's
    // loadWorker({ generations: { old: ... }, pointer: "old" }) setup.
    const server = await startServer({
      "player/client.js": "export const VALUE = 1;",
      "data/forays.json": '{"forays":["old-data"]}',
    });
    await registerAndActivate(page, server.baseUrl);
    const oldManifest = server.currentManifest();

    // New deploy: player/client.js CHANGED and now fails outright (a real
    // connection reset, not a hang) — a firm reject, not the timeout path
    // exercised above. It must be a changed file: an unchanged module is
    // copied from the current generation at install, never fetched (perf-4).
    server.setFiles({ "player/client.js": "export const VALUE = 2;" });
    server.failOn("player/client.js");

    // THE PREMISE (round-3 audit, tests-1): a second worker installed and
    // failed. register() on an existing registration never re-installs, and an
    // unstamped sw.js never changed bytes, so this used to prove nothing.
    const second = await updateAndAwaitNewWorker(page);
    expect(second).toEqual({ appeared: true, state: "redundant" });
    // Then the pointer cache still names the OLD generation and no new
    // generation cache was ever created.
    const pointer = await page.evaluate(async () => {
      const c = await caches.open("foray-pointer");
      const res = await c.match("https://foray.invalid/__generation-pointer__");
      return res ? await res.text() : null;
    });
    expect(pointer).toBe(oldManifest.deploy_id);

    const names = await cacheNames(page);
    expect(names).toContain("foray-gen-" + oldManifest.deploy_id);
    expect(names.filter((n) => n.startsWith("foray-gen-"))).toEqual(["foray-gen-" + oldManifest.deploy_id]);

    server.clearFaults();
    await server.close();
  });
});
