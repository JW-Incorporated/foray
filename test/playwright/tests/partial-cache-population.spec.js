/* PARTIAL CACHE POPULATION — real-browser coverage for the same scenario
 * test/sw-generation.test.js covers with node:vm (kanban card t_504fd5fd):
 * a torn deploy (one file's live bytes don't match the manifest's recorded
 * hash, or one manifest file fails to fetch at all) must promote nothing,
 * leaving the previous generation's pointer and cache fully intact.
 */
import { test, expect } from "@playwright/test";
import { startServer, registerAndActivate, cacheNames } from "../lib/harness.mjs";

test.describe("PARTIAL CACHE POPULATION (real browser)", () => {
  test("a hash mismatch on one file (a torn deploy) promotes nothing", async ({ page }) => {
    const server = await startServer({
      "player/client.js": "export const VALUE = 1;",
      "data/forays.json": '{"forays":["v1"]}',
    });
    // computeManifest() hashes whatever `files` currently holds — so to get
    // a manifest that disagrees with what the origin actually serves, take
    // the manifest snapshot BEFORE mutating index.html, then let the origin
    // serve the mutated (unhashed) bytes.
    const manifest = server.currentManifest();
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
    void manifest; // documents intent above; no direct assertion needed on it

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

    // New deploy lands, but search-engine.js — one of the manifest's SHELL
    // entries — is unreachable. (search-engine.js is not part of this
    // fixture's own served set; adding it to `files` here would make it
    // manifest-tracked and then failOn() takes over identically to
    // player/client.js in module-load-timeout.spec.js.)
    server.setFiles({ "data/forays.json": '{"forays":["new-data"]}' });
    server.failOn("player/client.js");

    await page.evaluate(() => navigator.serviceWorker.register("sw.js").catch(() => {}));
    await page.waitForTimeout(1500);

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
