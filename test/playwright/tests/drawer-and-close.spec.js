/* U-12 / U-13 (docs/ui-transition-plan.md; founder feedback F17 and F18).
 *
 * Both defects are about what one layer does to another while audio is
 * playing, and neither is visible to a node:vm suite: F17 is a stacking
 * order (which element wins `elementFromPoint` at a given pixel — a real
 * cascade, a real layout, a real hit test), and F18 is "did the audio
 * element keep playing after the chrome changed". So this is the one suite
 * in the repo that runs the SHIPPED index.html + styles.css + app.js +
 * player/client.js in a real browser and asks those two questions.
 *
 * WHAT EACH TEST PROVES, and the mutation that kills it:
 *
 *  1. F17 — the drawer opens ON TOP of an expanded Now Playing sheet. Its
 *     first item is hit-testable at its own centre, and the scrim covers the
 *     player. MUTATION: put `#drawer-overlay`/`#drawer` back at 30/31 (below
 *     #foray-player's 60) -> `document.elementFromPoint` at the drawer item's
 *     centre returns the player, not the drawer, and this goes red.
 *
 *  2. F18 — closing collapses, it does not stop. Tapping the ✕ leaves the
 *     audio element playing and the mini bar docked above the tab bar, tab
 *     navigation still works, and only the separately labelled Stop ends it.
 *     MUTATION: point `fp-close` back at `stopAndClose()` -> the element is
 *     paused and the bar is gone at the first assertion after the tap.
 *
 *  3. F18 — no control anywhere still carries the old "Stop and close
 *     player" accessible name. MUTATION: restore that aria-label on any
 *     element -> red. This is the one that would catch a revert that
 *     rewired the handler back without anyone reading the label.
 *
 * The fixture origin is `lib/site-server.mjs` (NOT `lib/server.mjs`, which is
 * the sw.js manifest fixture) — see its header for the two narrow deviations
 * from the bytes on disk and why they are needed.
 */
import { test, expect } from "@playwright/test";
import { startSiteServer, AUDIO_PATH } from "../lib/site-server.mjs";

test.use({
  /* app.js registers sw.js on any non-Capacitor origin. Nothing here is about
     the worker, and a worker caching one test's page and serving it to another
     is exactly the cross-test coupling the per-test server exists to avoid. */
  serviceWorkers: "block",
  /* These specs start playback through the real `ForayPlayer.play()` rather
     than through a synthetic click on a card that would need the whole Home
     render to have settled first. Chromium's default autoplay policy would
     reject that `play()` for want of a user gesture — which would be a fact
     about the harness, not about the player. */
  launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
});

/* These are the slow tests in this directory, and deliberately so: each one
   boots the whole real app (~3 MB of data/*.json, then a search-vocabulary
   priming pass that is pure CPU on the same core the assertions poll from)
   and then plays real audio through it. Measured 7-12 s per test with nothing
   else running, 13-40 s at the config's CI worker count, and up to 96 s on a
   developer box oversubscribed 8 workers to 8 threads. The config's shared
   30 s covers the sw.js specs (all under 9 s) and does not cover these, so
   the ceiling is raised HERE rather than for the whole directory — where it
   would turn a real hang in those specs into a three-minute wait. */
test.beforeEach(async ({}, testInfo) => testInfo.setTimeout(180_000));

let site;
test.beforeEach(async () => { site = await startSiteServer(); });
test.afterEach(async () => { await site?.close(); });

/** Loads the real app and waits for the two things every test below needs:
    the player module (a deferred ES module) and the tab bar app.js appends
    after its first paint. Also records every `new Audio()` the player
    constructs, which is the only handle on the element — `HtmlAudioBackend`
    never puts it in the document. */
async function openApp(page) {
  await page.addInitScript(() => {
    const RealAudio = window.Audio;
    window.__audios = [];
    window.Audio = function (...args) {
      const el = new RealAudio(...args);
      window.__audios.push(el);
      return el;
    };
    window.Audio.prototype = RealAudio.prototype;
  });
  await page.goto(site.baseUrl);
  await page.waitForFunction(
    () => Boolean(window.ForayPlayer) && Boolean(document.querySelector("#tab-bar .tab-btn"))
  );
  /* A genuinely first-time profile — which every fresh browser context is —
     gets the onboarding explainer, itself a `.fy-sheet` at z 70, over the
     whole page. It is not what these specs are about and it covers the
     controls they tap, so dismiss it the way a listener would ("Skip for
     now"). Bounded rather than asserted-present: if onboarding ever stops
     showing here, these specs should carry on, not turn red for it. */
  await page.waitForSelector("#first-time-sheet", { timeout: 15_000 }).catch(() => null);
  if (await page.locator("#first-time-sheet-skip").count()) {
    await page.locator("#first-time-sheet-skip").click();
  }
  await expect(page.locator("#first-time-sheet")).toHaveCount(0);
}

/** Starts one ordinary episode on the fixture audio and waits until the real
    <audio> element is genuinely running (not merely un-paused). */
async function startPlayback(page) {
  await page.evaluate(async (url) => {
    await window.ForayPlayer.play({
      id: "pw-fixture-ep",
      title: "Fixture episode",
      show: "Fixture show",
      audio_url: url,
      duration_sec: 60,
      dai_suspected: false,
    }, { why: "playwright fixture" });
  }, site.audioUrl);
  await page.waitForFunction(
    (name) => {
      const el = (window.__audios || []).find((a) => a.src && a.src.includes(name));
      return Boolean(el) && !el.paused && el.currentTime > 0;
    },
    AUDIO_PATH
  );
  await expect(page.locator("#foray-player")).toBeVisible();
}

/** `{ paused, currentTime }` for the element actually carrying the fixture
    audio — `HtmlAudioBackend` also constructs a warm-up element, so this
    picks by src rather than by construction order. */
function audioState(page) {
  return page.evaluate((name) => {
    const el = (window.__audios || []).find((a) => a.src && a.src.includes(name));
    if (!el) return null;
    return { paused: el.paused, currentTime: el.currentTime };
  }, AUDIO_PATH);
}

/* ---------- U-12 / F17 ---------- */

test("the drawer opens on top of an expanded Now Playing sheet, and its first item is hit-testable", async ({ page }) => {
  await openApp(page);
  await startPlayback(page);

  await page.locator(".fp-info").click();
  await expect(page.locator(".fp-sheet")).toBeVisible();
  await expect(page.locator("body.fp-expanded")).toHaveCount(1);

  await page.locator("#menu-btn").click();
  await expect(page.locator("#drawer")).toBeVisible();

  const hit = await page.evaluate(() => {
    const first = document.querySelector("#drawer .drawer-section");
    if (!first) return { error: "the drawer has no .drawer-section items at all" };
    const r = first.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    /* The same question asked of the player's own centre: with the drawer
       open, its scrim — not the mini bar — must be what a tap lands on. */
    const bar = document.querySelector("#foray-player .fp-bar").getBoundingClientRect();
    const overBar = document.elementFromPoint(bar.left + bar.width / 2, bar.top + bar.height / 2);
    return {
      text: (first.textContent || "").trim(),
      insideDrawer: Boolean(at && at.closest("#drawer")),
      landedOn: at ? (at.id || at.className || at.tagName) : null,
      barCoveredByDrawerLayer: Boolean(
        overBar && (overBar.closest("#drawer") || overBar.id === "drawer-overlay")
      ),
      barLandedOn: overBar ? (overBar.id || overBar.className || overBar.tagName) : null,
    };
  });

  expect(hit.error).toBeUndefined();
  expect(hit.text).toBe("Home");
  expect(
    hit.insideDrawer,
    `the drawer's first item is not hit-testable at its own centre — a tap there lands on "${hit.landedOn}"`
  ).toBe(true);
  expect(
    hit.barCoveredByDrawerLayer,
    `the open drawer does not cover the mini player — a tap over the bar lands on "${hit.barLandedOn}"`
  ).toBe(true);
});

/* ---------- U-13 / F18 ---------- */

test("closing the expanded sheet collapses to a mini bar that keeps playing, and only Stop stops", async ({ page }) => {
  await openApp(page);
  await startPlayback(page);

  await page.locator(".fp-info").click();
  await expect(page.locator(".fp-sheet")).toBeVisible();

  const beforeClose = await audioState(page);
  await page.locator(".fp-close").click();

  /* 1. It collapsed rather than closed. */
  await expect(page.locator(".fp-sheet")).toBeHidden();
  await expect(page.locator("body.fp-expanded")).toHaveCount(0);
  await expect(page.locator("body.fp-open")).toHaveCount(1);

  /* 2. The audio element never stopped, and is still advancing. */
  const afterClose = await audioState(page);
  expect(afterClose, "the audio element the player was using no longer exists").not.toBeNull();
  expect(afterClose.paused, "closing the Now Playing sheet paused playback (F18)").toBe(false);
  await page.waitForFunction(
    ([name, t]) => {
      const el = (window.__audios || []).find((a) => a.src && a.src.includes(name));
      return Boolean(el) && !el.paused && el.currentTime > t;
    },
    [AUDIO_PATH, beforeClose.currentTime]
  );

  /* 3. The mini bar is still there, and docked ABOVE the tab bar. */
  await expect(page.locator("#foray-player")).toBeVisible();
  const stack = await page.evaluate(() => {
    const bar = document.querySelector("#foray-player .fp-bar").getBoundingClientRect();
    const tabs = document.querySelector("#tab-bar").getBoundingClientRect();
    const at = document.elementFromPoint(bar.left + bar.width / 2, bar.top + bar.height / 2);
    return {
      barBottom: bar.bottom,
      tabsTop: tabs.top,
      hitInsidePlayer: Boolean(at && at.closest("#foray-player")),
      landedOn: at ? (at.id || at.className || at.tagName) : null,
    };
  });
  expect(
    stack.barBottom,
    "the mini bar overlaps the tab bar instead of docking above it"
  ).toBeLessThanOrEqual(stack.tabsTop + 1);
  expect(
    stack.hitInsidePlayer,
    `the mini bar is not hit-testable — a tap on it lands on "${stack.landedOn}"`
  ).toBe(true);

  /* 4. The app is usable again: tab navigation works with the bar up, and
        the bar survives the navigation (it is the way back). */
  await page.locator('#tab-bar a[data-tab-key="library"]').click();
  await expect(page).toHaveURL(/#\/library$/);
  await expect(page.locator('#tab-bar a[data-tab-key="library"]')).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#view")).not.toBeEmpty();
  await expect(page.locator("#foray-player")).toBeVisible();
  expect((await audioState(page)).paused).toBe(false);

  /* 5. Stop — the separately labelled control — is what ends it. */
  await page.locator(".fp-info").click();
  await expect(page.locator(".fp-sheet")).toBeVisible();
  await page.locator(".fp-stop").click();

  await expect(page.locator("#foray-player")).toBeHidden();
  await expect(page.locator("body.fp-open")).toHaveCount(0);
  await expect.poll(async () => (await audioState(page)).paused).toBe(true);
});

test("nothing in the player is labelled \"Stop and close player\" any more", async ({ page }) => {
  await openApp(page);
  await startPlayback(page);
  await page.locator(".fp-info").click();
  await expect(page.locator(".fp-sheet")).toBeVisible();

  /* The whole document with the player fully built and expanded — both rows
     of the sheet and the mini bar are in the DOM at this point. */
  await expect(page.locator('[aria-label="Stop and close player"]')).toHaveCount(0);
  await expect(page.getByLabel("Stop and close player")).toHaveCount(0);

  /* And the two controls that replaced it say what they do. */
  await expect(page.locator(".fp-close")).toHaveAttribute("aria-label", "Collapse player");
  await expect(page.locator(".fp-stop")).toHaveAttribute("aria-label", "Stop");
  await expect(page.locator(".fp-stop")).toHaveText("Stop");
});
