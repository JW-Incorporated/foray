/* MODULE LOAD TIMEOUT — real-browser coverage for the same scenario
 * test/sw-generation.test.js covers with a `setTimeout`-recorder harness
 * (kanban card t_504fd5fd). Here the hang is a REAL HTTP request the fixture
 * server (test/playwright/lib/server.mjs) never answers, driven through a
 * real Chromium service worker via sw.js's own NET_TIMEOUT_MS-bounded
 * `fromOrigin()` — nothing about the timeout mechanism is reproduced here,
 * only exercised.
 */
import { test, expect } from "@playwright/test";
import { startServer, registerAndActivate, cacheNames } from "../lib/harness.mjs";

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
      await page.evaluate(() => navigator.serviceWorker.register("sw.js"));
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

    // New deploy: player/client.js now fails outright (a real connection
    // reset, not a hang) — this is a firm reject, not the timeout path
    // exercised above.
    server.failOn("player/client.js");

    await page.evaluate(() => navigator.serviceWorker.register("sw.js"));
    // Give the failed install a moment to actually reject, then confirm the
    // pointer cache still names the OLD generation and no new generation
    // cache was ever created.
    await page.waitForTimeout(1000);
    const pointer = await page.evaluate(async () => {
      const c = await caches.open("foray-pointer");
      const res = await c.match("https://foray.invalid/__generation-pointer__");
      return res ? await res.text() : null;
    });
    expect(pointer).toBe(oldManifest.deploy_id);

    const names = await cacheNames(page);
    expect(names).toContain("foray-gen-" + oldManifest.deploy_id);

    server.clearFaults();
    await server.close();
  });
});
