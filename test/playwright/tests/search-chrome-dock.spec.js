/* The search page's bottom edge, in a real browser — founder reports from
 * 2026-09-14, build 2026091419.
 *
 * WHY THESE THREE ARE HERE AND NOT IN A node:vm SUITE. Each one is a real
 * cascade resolving a real `calc()` against a real layout, which is precisely
 * what a DOM stub cannot do. test/keyboard-chrome-and-scroll.test.js pins the
 * MECHANISM (which class goes on, which rule exists, how many times the
 * handler runs); this file measures the PIXELS that mechanism produces, and
 * the two are deliberately different questions. A `--sh-dock` whose terms are
 * all individually correct and whose sum is wrong would pass every assertion
 * in that file and fail every one in this.
 *
 *  1. THE JITTER, MEASURED. Report: "when I scroll, the search text box moves
 *     a bunch and tries to stay above the keyboard but seems to need to
 *     update every time the page moves." Its structural half is that a page
 *     render destroyed `body.kb-open` while `--kb-inset` — which lives on
 *     <html> — survived, so the pill composed a keyboard-OPEN inset with the
 *     keyboard-SHUT dock. This spec puts the page in the keyboard-open state,
 *     re-renders it, and measures how far the pill moved. Before the fix that
 *     number is the tab bar plus the mini bar; after it, zero.
 *
 *  2. THE TAB BAR AND THE ARITHMETIC MOVE TOGETHER. Report: "when the search
 *     bar is up, this home ribbon should go away." A bar that left without
 *     its height leaving `--sh-dock` would drop the pill by the bar's height
 *     at the moment it vanished — fixing a report about a pill that MOVES by
 *     introducing one more way for it to move. Measured as: with the field
 *     focused the pill's gap to the bottom of the viewport is exactly
 *     `--sh-gap`, with nothing reserved for a bar that is not there.
 *
 *  3. SCROLLING DISMISSES. Report: "when I scroll, the keyboard should
 *     naturally collapse." A real scroll, a real focus, a real blur.
 *
 * WHAT THIS FILE STILL CANNOT PROVE, and neither can any other: iOS keyboard
 * timing. Chromium has no soft keyboard, so `body.kb-open` and `--kb-inset`
 * are set here the way installKeyboardChrome would set them, and what is
 * measured is what the CASCADE then does with them. Whether WebKit's
 * `visualViewport` reports the numbers this assumes, and whether one
 * evaluation per animation frame is enough to make the pill look welded to
 * the keyboard under momentum scrolling, are device questions. They are
 * marked as such in the PR rather than implied to be covered here.
 *
 * VIEWPORT: iPhone-class 390x844 with touch, because every one of the three
 * reports is a phone report and the tab bar is phone chrome. The config's
 * `mobile-chromium` project is scoped by `testMatch` to one other spec, so
 * this file sets its own — it runs once, on the `chromium` project, at a
 * phone size.
 */
import { test, expect } from "@playwright/test";
import { startSiteServer } from "../lib/site-server.mjs";

test.use({
  serviceWorkers: "block",
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

/* Same budget, and the same reason, as drawer-and-close.spec.js: each test
   boots the whole real app over ~3 MB of data/*.json before it can assert
   anything. */
test.beforeEach(async ({}, testInfo) => testInfo.setTimeout(180_000));

let site;
test.beforeEach(async () => { site = await startSiteServer(); });
test.afterEach(async () => { await site?.close(); });

async function openSearchPage(page) {
  await page.goto(site.baseUrl);
  await page.waitForFunction(() => Boolean(document.querySelector("#tab-bar .tab-btn")));
  await page.waitForSelector("#first-time-sheet", { timeout: 15_000 }).catch(() => null);
  if (await page.locator("#first-time-sheet-skip").count()) {
    await page.locator("#first-time-sheet-skip").click();
  }
  await expect(page.locator("#first-time-sheet")).toHaveCount(0);
  await page.evaluate(() => { window.location.hash = "#/shows"; });
  await page.waitForSelector("#sh-compose #sh-input");
}

/** The pill's distance from the bottom of the viewport, in CSS pixels — the
    one number all three reports are about. Read off a real layout rather than
    off the declared `bottom`, so a rule that resolves to something other than
    what it says is caught. */
const pillGap = (page) => page.evaluate(() => {
  const el = document.querySelector("#sh-compose");
  return Math.round(window.innerHeight - el.getBoundingClientRect().bottom);
});

test("a re-render with the keyboard up does not move the pill — the measurement", async ({ page }) => {
  await openSearchPage(page);

  /* The keyboard-open state, set exactly as installKeyboardChrome sets it:
     the class on <body>, the inset on <html>. Chromium has no soft keyboard,
     so this is the only way to reach the state the report is about — and it
     is faithful, because the two writes ARE the whole of what that function
     publishes. */
  await page.evaluate(() => {
    document.body.classList.add("kb-open");
    document.documentElement.style.setProperty("--kb-inset", "300px");
  });
  /* And something playing, because the un-reported half of this bug is the
     mini-player's reservation: `fp-open` was being destroyed by the same
     line. Set directly rather than by starting audio — what is under test is
     the class's survival, not the player. */
  await page.evaluate(() => document.body.classList.add("fp-open"));

  const before = await pillGap(page);

  /* A page render. `setBodyClass` is what every render function calls, and
     the wholesale `document.body.className =` it used to perform is the
     defect — so this is the narrowest possible way to reproduce a render
     without also changing the page underneath it. */
  await page.evaluate(() => window.setBodyClass("view-page"));

  const after = await pillGap(page);
  const moved = Math.abs(after - before);

  expect(await page.evaluate(() => document.body.classList.contains("kb-open"))).toBe(true);
  expect(await page.evaluate(() => document.body.classList.contains("fp-open"))).toBe(true);
  expect(moved, `the pill moved ${moved}px across a render with the keyboard up`).toBe(0);
});

test("focusing the field takes the tab bar away and its height with it", async ({ page }) => {
  await openSearchPage(page);

  await expect(page.locator("#tab-bar")).toBeVisible();
  const idleGap = await pillGap(page);
  const tabBarH = await page.evaluate(() =>
    Math.round(document.querySelector("#tab-bar").getBoundingClientRect().height));
  /* Idle, the pill clears the bar: gap + the bar's own height. Asserted so
     the focused case below is a comparison against something known, not
     against whatever the sheet happens to produce. */
  expect(idleGap).toBeGreaterThanOrEqual(tabBarH);

  await page.locator("#sh-input").focus();

  await expect(page.locator("#tab-bar")).toBeHidden();
  const focusedGap = await pillGap(page);
  /* `--sh-gap` is 10px. With the bar gone there is nothing else down there on
     this viewport (no player, and Chromium reports a zero safe-area inset),
     so the pill must sit exactly one gap off the floor — not one gap plus a
     reservation for a bar that is no longer on screen. */
  expect(focusedGap).toBe(10);
  expect(idleGap - focusedGap, "the pill should give back exactly the bar's height, no more").toBe(tabBarH);

  /* And back again on blur, because a listener reading results needs the
     app's navigation. */
  await page.locator("#sh-input").blur();
  await expect(page.locator("#tab-bar")).toBeVisible();
  expect(await pillGap(page)).toBe(idleGap);
});

test("no Go button is rendered inside the pill", async ({ page }) => {
  /* Founder: "since the search results are live, the 'go' button is useless,
     delete it." Asserted in the browser as well as in the node suite because
     this is the one place the SHIPPED markup and the SHIPPED stylesheet meet:
     a rule left behind could still paint something at that position. */
  await openSearchPage(page);
  await expect(page.locator("#sh-form button")).toHaveCount(0);
  await expect(page.locator("#sh-compose")).not.toContainText("Go");
});

test("a downward scroll blurs the field; an upward one does not", async ({ page }) => {
  await openSearchPage(page);
  await page.locator("#sh-input").focus();
  await expect(page.locator("#sh-input")).toBeFocused();

  /* THERE HAS TO BE SOMETHING TO SCROLL, and on this page that is not
     automatic — which the first draft of this test got wrong and the browser
     caught. Focusing the field hides the browse furniture and the A-Z index
     (that is PR #681's rule, working), which collapses the document to about
     one viewport: `window.scrollTo(0, 400)` then clamps to 0, the handler
     sees no movement, and the test failed while the feature worked.

     So: type a query first. That is also the honest scenario — a listener who
     scrolls a search page with the keyboard up is scrolling RESULTS, and a
     page with nothing on it is not one anybody scrolls. */
  await page.locator("#sh-input").fill("a");
  await expect(page.locator("#sh-results")).toBeVisible();
  await page.waitForFunction(() => document.documentElement.scrollHeight > window.innerHeight + 400);

  /* Past the 350ms settle window — the guard that stops the keyboard's own
     arrival from being read as the user scrolling. Waited through rather than
     stubbed, because the thing under test is that the window ends. */
  await page.waitForTimeout(500);

  await page.evaluate(() => window.scrollTo(0, 400));
  await expect(page.locator("#sh-input")).not.toBeFocused();

  /* Upward never dismisses: same asymmetry the collapsing header has. */
  await page.locator("#sh-input").focus();
  await page.waitForTimeout(500);
  await page.evaluate(() => window.scrollTo(0, 100));
  await expect(page.locator("#sh-input")).toBeFocused();
});
