/* WORKER RESTART MID-REQUEST — real-browser coverage for the same scenario
 * test/sw-generation.test.js covers by simply never calling lifecycle()
 * on a freshly constructed harness (kanban card t_504fd5fd). Here nothing is
 * simulated: `Target.closeTarget` over CDP (harness.mjs's
 * terminateServiceWorker) ends the REAL OS-level service-worker process, and
 * Chrome must spin up a brand-new one to answer the very next request —
 * proving the pin lookup depends on nothing but durable CacheStorage, per
 * sw.js's own header ("nothing in memory to lose").
 */
import { test, expect } from "@playwright/test";
import { startServer, registerAndActivate, terminateServiceWorker } from "../lib/harness.mjs";

test.describe("WORKER RESTART MID-REQUEST (real browser)", () => {
  test("a freshly restarted worker (zero in-memory state) still serves a tagged old generation", async ({
    page,
  }) => {
    const server = await startServer({
      "player/client.js": "export const VALUE = 1;",
      "data/forays.json": '{"forays":["gen-1-data"]}',
    });
    await registerAndActivate(page, server.baseUrl);
    const gen1 = server.currentManifest().deploy_id;

    // A second generation lands and promotes, so "current" is now gen 2 —
    // gen 1 stays retained (RETENTION keeps current + immediately previous).
    server.setFiles({ "data/forays.json": '{"forays":["gen-2-data"]}' });
    await page.evaluate(() =>
      navigator.serviceWorker
        .getRegistration()
        .then((reg) => reg && reg.update())
    );
    await page.waitForTimeout(1500);

    // Kill the live worker process entirely, then fetch through a brand-new
    // one, tagged for the OLD generation.
    await terminateServiceWorker(page);
    const text = await page.evaluate(async (gen1) => {
      const res = await fetch(`data/forays.json?_fdid=${gen1}`, { cache: "no-store" });
      return res.text();
    }, gen1);
    expect(text).toBe('{"forays":["gen-1-data"]}');

    await server.close();
  });

  test("an aged-out or unknown _fdid FAILS VISIBLY rather than silently serving live/current data", async ({
    page,
  }) => {
    const server = await startServer({
      "player/client.js": "export const VALUE = 1;",
      "data/forays.json": '{"forays":["live-data"]}',
    });
    await registerAndActivate(page, server.baseUrl);

    const status = await page.evaluate(async () => {
      const res = await fetch("data/forays.json?_fdid=never-heard-of-this-generation", {
        cache: "no-store",
      });
      return res.status;
    });
    expect(status).toBe(504);

    await server.close();
  });
});
