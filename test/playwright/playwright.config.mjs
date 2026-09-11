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
    /* U-12 (docs/ui-transition-plan.md): the drawer-stacking acceptance is
       "on both viewports the suite already uses" — and until 2026-09-10 the
       suite used exactly one, Desktop Chrome, while F17 (the drawer hidden
       under Now Playing) was reported on a phone. This second project runs
       the app-chrome spec ONLY at an iPhone-class 390x844 viewport with
       touch + mobile emulation, on the same Chromium the CI job installs
       (`npx playwright install chromium`; an iPhone `devices[]` preset would
       select WebKit, which that job does not install). `testMatch` keeps the
       sw.js manifest specs out of it: they never touch layout, and doubling
       them would only double their wall-clock. Still advisory-only in CI —
       see ci.yml's `playwright` job comment. */
    {
      name: "mobile-chromium",
      testMatch: /drawer-and-close\.spec\.js$/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
