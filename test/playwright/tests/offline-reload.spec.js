/* OFFLINE RELOAD — real-browser coverage for the same scenario
 * test/sw-generation.test.js covers with a `network: offline` stub (kanban
 * card t_504fd5fd): a fully offline reload must get one internally
 * consistent generation — the shell AND the data it fetches must both come
 * from the SAME retained generation, never a shell/data mix — using
 * Playwright's real offline emulation (`page.context().setOffline()`)
 * against a real Chromium instance and a real network stack, not a stubbed
 * fetch function.
 */
import { test, expect } from "@playwright/test";
import { startServer, registerAndActivate, runLoads } from "../lib/harness.mjs";

test.describe("OFFLINE RELOAD (real browser)", () => {
  test("a fully offline reload gets one internally consistent generation, never a shell/data mix", async ({
    page,
    context,
  }) => {
    const server = await startServer({
      "player/client.js": "export const VALUE = 1;",
      "data/forays.json": '{"forays":["online-data"]}',
    });
    await registerAndActivate(page, server.baseUrl);

    // Confirm the live (online) load reads current data with no pin.
    const online = await runLoads(page);
    expect(online.pin).toBeNull();
    expect(JSON.parse(online.dataText)).toEqual({ forays: ["online-data"] });

    // Now offline. A reload navigates fresh, with no _fdid — same as any
    // visit (sw.js's own header: "an offline reload is served ... about").
    await context.setOffline(true);
    await page.reload();
    // The reload's OWN navigation is what falls back to the cached shell and
    // gets pinned — wait for that before driving the fixture's own loads.
    await page.waitForFunction(() => document.readyState === "complete");
    const offline = await runLoads(page);

    expect(offline.dataStatus).toBe(200);
    expect(JSON.parse(offline.dataText)).toEqual({ forays: ["online-data"] });
    // Pinned to the SAME generation the shell came from (there has only ever
    // been one generation in this test, so this also proves the pin, once
    // set, is not simply absent).
    expect(offline.pin).toBe(server.currentManifest().deploy_id);

    await context.setOffline(false);
    await server.close();
  });

  test("a page already pinned to a superseded generation keeps reading it after going offline", async ({
    page,
    context,
  }) => {
    const server = await startServer({
      "player/client.js": "export const VALUE = 1;",
      "data/forays.json": '{"forays":["gen-1-data"]}',
    });
    await registerAndActivate(page, server.baseUrl);
    const gen1 = server.currentManifest().deploy_id;

    // Gen 2 lands and promotes (current + previous retention keeps gen 1
    // alive). The page's own tab never navigates, so it is still reading
    // its ORIGINAL (gen 1) code — exactly the "stayed open across a deploy"
    // scenario RETENTION exists for.
    server.setFiles({ "data/forays.json": '{"forays":["gen-2-data"]}' });
    await page.evaluate(() =>
      navigator.serviceWorker.getRegistration().then((reg) => reg && reg.update())
    );
    await page.waitForTimeout(1500);

    await context.setOffline(true);
    const text = await page.evaluate(async (gen1) => {
      const res = await fetch(`data/forays.json?_fdid=${gen1}`, { cache: "no-store" });
      return res.text();
    }, gen1);
    expect(text).toBe('{"forays":["gen-1-data"]}');

    await context.setOffline(false);
    await server.close();
  });
});
