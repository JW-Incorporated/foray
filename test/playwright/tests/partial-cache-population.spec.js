/* PARTIAL CACHE POPULATION — real-browser coverage for the same scenario
 * test/sw-generation.test.js covers with node:vm (kanban card t_504fd5fd):
 * a torn deploy (one file's live bytes don't match the manifest's recorded
 * hash, or one manifest file fails to fetch at all) must promote nothing,
 * leaving the previous generation's pointer and cache fully intact.
 */
import { test, expect } from "@playwright/test";
import { startServer, registerAndActivate, cacheNames, updateAndAwaitNewWorker } from "../lib/harness.mjs";

test.describe("PARTIAL CACHE POPULATION (real browser)", () => {
  test("a hash mismatch on one file (a torn deploy) promotes nothing", async ({ page }) => {
    const server = await startServer({
      "player/client.js": "export const VALUE = 1;",
      "data/forays.json": '{"forays":["v1"]}',
    });
    // Freeze the manifest to what index.html currently hashes to, THEN
    // change what the origin actually serves for it — simulating GitHub
    // Pages mid-propagation, where the manifest was generated against one
    // set of bytes and the origin is still (or already) answering with
    // another. Without freezeManifestNow() the live-computed manifest would
    // simply follow the mutated content and never disagree with it — see
    // server.mjs's own header on this.
    server.freezeManifestNow();
    server.setFiles({ "index.html": "<!doctype html><title>tampered, not what was hashed</title>" });

    // register() itself resolves; the fetch handler inside sw.js keeps the
    // rejected install from ever promoting. Assert on cache state instead of
    // the registration promise, matching the node:vm test's own assertions.
    await page.goto(server.baseUrl);
    await page.evaluate(() => navigator.serviceWorker.register("sw.js").catch(() => {}));
    await page.waitForTimeout(1500);

    const names = await cacheNames(page);
    expect(names.some((n) => n.startsWith("foray-gen-"))).toBe(false);
    const pointerRes = await page.evaluate(async () => {
      const c = await caches.open("foray-pointer");
      return (await c.match("https://foray.invalid/__generation-pointer__")) ? "has-pointer" : "no-pointer";
    });
    expect(pointerRes).toBe("no-pointer");

    server.unfreezeManifest();
    await server.close();
  });

  test("one file failing mid-manifest voids the whole install, old pointer untouched", async ({
    page,
  }) => {
    const server = await startServer({
      "player/client.js": "export const VALUE = 1;",
      "data/forays.json": '{"forays":["old-data"]}',
    });
    await registerAndActivate(page, server.baseUrl);
    const oldManifest = server.currentManifest();

    // New deploy lands: the data AND player/client.js changed, and the changed
    // module is unreachable. It has to be a CHANGED file: an unchanged one is
    // copied from the current generation at install (sw.js reuseVerified,
    // perf-4) and never fetched, so failing it would prove nothing.
    server.setFiles({
      "data/forays.json": '{"forays":["new-data"]}',
      "player/client.js": "export const VALUE = 2;",
    });
    server.failOn("player/client.js");

    // THE PREMISE (round-3 audit, tests-1): a second worker really installed,
    // and its install failed. register() on an existing registration never
    // re-installs, and the fixture's sw.js bytes never used to change, so the
    // assertions below held for a worker that never ran install at all.
    const second = await updateAndAwaitNewWorker(page);
    expect(second).toEqual({ appeared: true, state: "redundant" });

    const pointer = await page.evaluate(async () => {
      const c = await caches.open("foray-pointer");
      const res = await c.match("https://foray.invalid/__generation-pointer__");
      return res ? await res.text() : null;
    });
    expect(pointer).toBe(oldManifest.deploy_id);

    const names = await cacheNames(page);
    expect(names).toContain("foray-gen-" + oldManifest.deploy_id);
    expect(names.some((n) => n !== "foray-gen-" + oldManifest.deploy_id && n.startsWith("foray-gen-"))).toBe(
      false
    );

    server.clearFaults();
    await server.close();
  });
});
