/* Playwright config for the M4 sw.js browser-integration suite (kanban card
 * t_504fd5fd). Deliberately separate from the root's node:test suites — this
 * directory is NOT scanned by tools/ci/run-suites.mjs (specs are named
 * *.spec.js, not *.test.js, so SUITE_RE in that script and in
 * test/suite-integrity.test.js never matches them; see this directory's
 * README.md).
 *
 * No `webServer` entry: each spec starts and stops its OWN fixture HTTP
 * server per test (test/playwright/lib/server.mjs), because several tests
 * need to change what the origin serves MID-TEST (a new deploy landing, a
 * file starting to 404) — a single shared server for the whole run can't
 * do that safely across parallel tests.
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
