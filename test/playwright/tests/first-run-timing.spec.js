/* #70 (R14) — the first-run path, timed, with screenshots.
 *
 * #70's acceptance line is "a first-time user reaches a playable card in
 * < 90 s, and in < 10 s if they skip everything", plus "returning users never
 * see it again" and "screenshots in the PR". The 2026-10-07 status comment on
 * #70 left exactly one of those lines as "Evidence not recorded" (item 4): no
 * timed run and no screenshots, because #1142 shipped the persona pick from an
 * autonomous run. This spec is that evidence, recorded mechanically on every
 * CI run instead of once by hand: it boots the SHIPPED index.html + app.js +
 * player/client.js + data/*.json from `lib/site-server.mjs` in a fresh
 * Chromium profile and walks the two first-run paths a listener can take.
 *
 * WHAT THE CLOCK MEASURES. Each bound runs from the page's own first paint
 * (`performance` "first-paint", falling back to "first-contentful-paint") to
 * the moment a playable control on Home — the Home ▶ (`[data-home-play]`) or a
 * card's ▶ (`[data-play]`) — is visible AND is what a tap at its centre lands
 * on (so a sheet still covering it does not count). Both ends are read off the
 * page's own `performance.now()`, never the test runner's clock, so worker
 * scheduling in the runner cannot add to or hide from the number. Playwright
 * presses the buttons with no reading time, so the measured number is the
 * APP'S share of the budget — boot, data load, sheet, re-deal, repaint — and
 * what is left of 10 s / 90 s is the listener's. That is the half a machine
 * can prove; how long a person takes to read the Welcome step is not.
 *
 * WHAT EACH TEST PROVES, and the mutation that kills it:
 *
 *  1. Skip path: a fresh profile gets the first-time sheet, "Skip for now"
 *     closes it, and a playable card is reachable within 10 s of first paint.
 *     MUTATION: in app.js `renderWelcome`, change
 *     `skip.addEventListener("click", dismiss)` to
 *     `skip.addEventListener("click", () => setTimeout(dismiss, 11000))` -> the
 *     card is first hit-testable more than 10 s after first paint and the bound
 *     goes red. MUTATION: delete that listener -> the sheet never closes and the
 *     card is never hit-testable.
 *
 *  2. Persona path: "Get started" -> the persona row (data/personas.json) ->
 *     one persona lit -> "Show my picks" closes the sheet and a playable card
 *     is reachable within 90 s of first paint. MUTATION: in `renderPreferences`,
 *     delete the `dismiss();` call in the "Show my picks" handler -> the sheet
 *     stays over Home and the card is never hit-testable. MUTATION: change
 *     `.filter(p => p && p.id && p.label && …)` on `personaChoices` to
 *     `.filter(() => false)` -> no persona row, and the row assertion fails.
 *
 *  3. Returning listener: a SECOND browser context built from the first one's
 *     saved storage (what "the same phone, next week" is to a browser) never
 *     sees the first-time sheet or the intro popup, and lands straight on a
 *     playable card. MUTATION: delete `lsSet("cp_intro_dismissed", true)` from
 *     `markIntroDismissed` -> the returning visit opens the first-time sheet
 *     again. MUTATION: delete `if (lsGet("cp_intro_dismissed", false)) return
 *     false;` from `showFirstTimeExplainerOnce` -> the same.
 *
 * NOTHING BUT THE SITE SERVER. Every request that is not to this test's own
 * `lib/site-server.mjs` origin is aborted at the context, so a run of this
 * spec sends nothing anywhere (no Supabase, no podcast CDN) and its timings
 * cannot depend on the CI runner's network. Service workers are blocked for
 * the same reason the drawer spec blocks them: one test's cached page must not
 * be served to another.
 *
 * EVIDENCE. Every test attaches its screenshots and a `first-run-timing.json`
 * through `testInfo.attach` (they land in the HTML report written when `CI`
 * is set; the CI job does not upload that report yet, see README.md) and
 * prints one `[first-run-timing]` line with the measured milliseconds, so the
 * numbers are readable in the job log itself. A probe that times out (no
 * playable control, or a sheet button that never showed) attaches a
 * screenshot and a JSON dump of what it saw, and rethrows with that dump in
 * the error message: for each candidate its rect, `disabled`, and the
 * outerHTML of what `elementFromPoint` returns at its centre, plus `scrollY`
 * and every open `.fy-sheet`. MUTATION: replace the `throw await diagnosed(...)`
 * in `playableCardAt` with `throw err` and run test 2 under its `dismiss();`
 * mutation -> the red run is a bare "Timeout 95000ms exceeded" with no
 * `[first-run-timing] playable-timeout` dump naming the covering scrim.
 */
import { test, expect } from "@playwright/test";
import { startSiteServer } from "../lib/site-server.mjs";

/** #70's two bounds, from first paint to a playable card. */
const SKIP_BOUND_MS = 10_000;
const PERSONA_BOUND_MS = 90_000;

/** The Home controls that start audio: the Home ▶ and a card's ▶. */
const PLAYABLE = "#view [data-home-play], #view [data-play]";

test.use({ serviceWorkers: "block" });

/* The same ceiling, for the same reason, as drawer-and-close.spec.js: each
   test boots the whole real app (~3 MB of data/*.json and a CPU-bound
   search-vocabulary pass), and test 3 boots it twice. It must exceed the 90 s
   bound, or a slow persona run would be reported as a timeout instead of as
   the number it measured. */
test.beforeEach(async ({}, testInfo) => testInfo.setTimeout(180_000));

let site;
test.beforeEach(async () => { site = await startSiteServer(); });
test.afterEach(async () => { await site?.close(); });

/** Aborts every request that is not to this test's own site server. */
async function onlySiteServer(context) {
  await context.route((url) => !url.href.startsWith(site.baseUrl), (route) => route.abort());
}

/** A context of our own (test 3 needs two), with the spec's two rules. */
async function freshContext(browser, options = {}) {
  const context = await browser.newContext({ serviceWorkers: "block", ...options });
  await onlySiteServer(context);
  return context;
}

/** The page's own first-paint timestamp, on its `performance.now()` clock. */
async function firstPaintMs(page) {
  const handle = await page.waitForFunction(() => {
    const paints = performance.getEntriesByType("paint");
    const fp = paints.find((e) => e.name === "first-paint") ||
      paints.find((e) => e.name === "first-contentful-paint");
    return fp ? fp.startTime : null;
  });
  return handle.jsonValue();
}

/* How often the two probes below sample the page. An interval, not
   `polling: "raf"`: a rAF-polled wait depends on Chromium delivering frames
   to the page, and one full-file run sat on a fully rendered, hit-testable
   Home for ~90 s without the probe ever reporting it (the error-context
   snapshot showed the Home ▶ ready; a rerun measured 6.3 s). Each sample is
   still taken INSIDE the page with `performance.now()`, so the clock stays the
   page's own; the interval only adds up to POLL_MS of sampling lag. */
const POLL_MS = 50;

/** Waits until some playable control on Home is visible and is what a tap at
    its centre lands on, and returns that moment on the page's clock — sampled
    inside the page, at the first poll the condition held. On a timeout it
    attaches what the probe saw (see `diagnosePlayable`) and rethrows with
    that summary in the message, so a red run says WHY nothing was playable. */
async function playableCardAt(page, timeout, testInfo) {
  try {
    const handle = await page.waitForFunction((sel) => {
      for (const el of document.querySelectorAll(sel)) {
        if (el.disabled || el.getClientRects().length === 0) continue;
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        const at = document.elementFromPoint(x, y);
        if (at && (at === el || el.contains(at))) return performance.now();
      }
      return null;
    }, PLAYABLE, { timeout, polling: POLL_MS });
    return await handle.jsonValue();
  } catch (err) {
    throw await diagnosed(page, testInfo, "playable-timeout", err, diagnosePlayable);
  }
}

/** Waits until the control `sel` is on screen and returns that moment on the
    page's clock (the same clock as first paint), for the record's breakdown. */
async function shownAt(page, sel, timeout, testInfo) {
  try {
    const handle = await page.waitForFunction((s) => {
      const el = document.querySelector(s);
      return el && el.getClientRects().length > 0 ? performance.now() : null;
    }, sel, { timeout, polling: POLL_MS });
    return await handle.jsonValue();
  } catch (err) {
    throw await diagnosed(page, testInfo, "shown-timeout", err, (p) => diagnoseShown(p, sel));
  }
}

/** Runs in the page: every PLAYABLE candidate with its rect, `disabled`, the
    point a tap would land on and the outerHTML of what `elementFromPoint`
    returns there, plus the scroll position and every open (not `hidden`) `.fy-sheet`. */
function diagnosePlayable(page) {
  return page.evaluate((sel) => {
    const html = (el, n = 400) => (el ? el.outerHTML.slice(0, n) : null);
    const candidates = [...document.querySelectorAll(sel)].map((el) => {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const inViewport = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
      const at = inViewport ? document.elementFromPoint(x, y) : null;
      return {
        html: html(el, 200),
        rect: { left: r.left, top: r.top, width: r.width, height: r.height },
        rendered: el.getClientRects().length > 0,
        disabled: !!el.disabled,
        centre: { x, y, inViewport },
        hitIsSelf: !!at && (at === el || el.contains(at)),
        elementFromPoint: html(at),
      };
    });
    return {
      now: performance.now(),
      visibilityState: document.visibilityState,
      viewport: { innerWidth, innerHeight },
      scrollY,
      candidateCount: candidates.length,
      candidates,
      openSheets: [...document.querySelectorAll(".fy-sheet:not([hidden])")].map((el) => ({ sheet: el.closest("[id]")?.id || null, html: html(el, 300) })),
    };
  }, PLAYABLE);
}

/** Runs in the page: whether `sel` exists and is rendered, and any open sheet. */
function diagnoseShown(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    return {
      now: performance.now(),
      visibilityState: document.visibilityState,
      selector: s,
      present: !!el,
      rendered: !!el && el.getClientRects().length > 0,
      html: el ? el.outerHTML.slice(0, 400) : null,
      openSheets: [...document.querySelectorAll(".fy-sheet:not([hidden])")].map((e) => e.closest("[id]")?.id || e.className),
    };
  }, sel);
}

/** On a probe timeout: attaches a screenshot and the probe's JSON dump to the
    report, and returns an Error carrying that dump (the CI job does not
    upload the report yet, so the job log must say why on its own). A page
    that cannot be inspected any more still rethrows the original error. */
async function diagnosed(page, testInfo, name, err, diagnose) {
  let dump;
  try {
    dump = await diagnose(page);
  } catch (diagErr) {
    dump = { diagnosisFailed: String(diagErr && diagErr.message || diagErr) };
  }
  if (testInfo) {
    try { await shot(page, testInfo, `${name}.png`); } catch { /* page gone */ }
    await testInfo.attach(`${name}.json`, { body: JSON.stringify(dump, null, 2), contentType: "application/json" });
  }
  const wrapped = new Error(`${err.message}\n[first-run-timing] ${name}: ${JSON.stringify(dump)}`);
  wrapped.cause = err;
  return wrapped;
}

/** One screenshot into the report. */
async function shot(page, testInfo, name) {
  await testInfo.attach(name, { body: await page.screenshot(), contentType: "image/png" });
}

/** The measured record: attached as JSON and printed as one log line. */
async function record(testInfo, timing) {
  await testInfo.attach("first-run-timing.json", {
    body: JSON.stringify(timing, null, 2),
    contentType: "application/json",
  });
  testInfo.annotations.push({ type: "first-run-timing", description: JSON.stringify(timing) });
  console.log(`[first-run-timing] ${JSON.stringify(timing)}`);
}

test("skip path: a fresh profile reaches a playable card within 10 s of first paint", async ({ page, context }, testInfo) => {
  await onlySiteServer(context);
  await page.goto(site.baseUrl);
  const paint = await firstPaintMs(page);

  const sheet = await shownAt(page, "#first-time-sheet-skip", SKIP_BOUND_MS, testInfo);
  await shot(page, testInfo, "1-welcome-sheet");
  await page.locator("#first-time-sheet-skip").click();

  const ready = await playableCardAt(page, SKIP_BOUND_MS + 5_000, testInfo);
  await expect(page.locator("#first-time-sheet")).toHaveCount(0);
  await expect(page.locator("#intro-sheet")).toHaveCount(0);
  await shot(page, testInfo, "2-home-after-skip");

  const elapsed = Math.round(ready - paint);
  await record(testInfo, { path: "skip", firstPaintMs: Math.round(paint), sheetShownMs: Math.round(sheet), playableMs: Math.round(ready), elapsedMs: elapsed, boundMs: SKIP_BOUND_MS });
  expect(elapsed, `first paint -> playable card after Skip took ${elapsed} ms (#70: under ${SKIP_BOUND_MS} ms)`).toBeLessThan(SKIP_BOUND_MS);
});

test("persona path: a fresh profile picks a persona and reaches a playable card within 90 s of first paint", async ({ page, context }, testInfo) => {
  await onlySiteServer(context);
  await page.goto(site.baseUrl);
  const paint = await firstPaintMs(page);

  const sheet = await shownAt(page, "#first-time-sheet-go", PERSONA_BOUND_MS, testInfo);
  await shot(page, testInfo, "1-welcome-sheet");
  await page.locator("#first-time-sheet-go").click();

  /* The persona row is #70's whole subject: five directed personas from
     data/personas.json, never the generalist. */
  const pills = page.locator("#first-time-sheet-personas .ft-persona");
  await expect(pills.first()).toBeVisible();
  expect(await pills.count(), "the persona row offers no personas").toBeGreaterThan(0);
  const pill = pills.first();
  const persona = await pill.getAttribute("data-persona");
  await pill.click();
  await expect(pill).toHaveAttribute("aria-pressed", "true");
  await shot(page, testInfo, "2-persona-picked");
  await page.locator("#first-time-sheet-prefs-go").click();

  const ready = await playableCardAt(page, PERSONA_BOUND_MS + 5_000, testInfo);
  await expect(page.locator("#first-time-sheet")).toHaveCount(0);
  await expect(page.locator("#intro-sheet")).toHaveCount(0);
  await shot(page, testInfo, "3-home-after-persona");

  const elapsed = Math.round(ready - paint);
  await record(testInfo, { path: "persona", persona, firstPaintMs: Math.round(paint), sheetShownMs: Math.round(sheet), playableMs: Math.round(ready), elapsedMs: elapsed, boundMs: PERSONA_BOUND_MS });
  expect(elapsed, `first paint -> playable card after a persona pick took ${elapsed} ms (#70: under ${PERSONA_BOUND_MS} ms)`).toBeLessThan(PERSONA_BOUND_MS);
});

test("returning listener: a context carrying the dismissed flag never sees the first-run sheet", async ({ browser }, testInfo) => {
  /* Visit one: a first-time profile, dismissed the considered way. */
  const first = await freshContext(browser);
  const page1 = await first.newPage();
  await page1.goto(site.baseUrl);
  await page1.locator("#first-time-sheet-skip").click({ timeout: 30_000 });
  await expect(page1.locator("#first-time-sheet")).toHaveCount(0);
  /* Let the write ride down to every tier before the profile is saved. */
  await page1.evaluate(() => window.forayStorageReady);
  const saved = await first.storageState({ indexedDB: true });
  await first.close();

  /* Visit two: a new context from that saved profile. */
  const second = await freshContext(browser, { storageState: saved });
  try {
    const page2 = await second.newPage();
    await page2.goto(site.baseUrl);
    await expect(page2.locator(PLAYABLE).first()).toBeAttached({ timeout: 30_000 });
    /* `offerHomeOnboarding` defers to the storage settle (app-1-1), so the
       sheet's chance to appear is AFTER hydration, not at the first Home
       paint. Wait for it, give the deferred offer its frames, then look —
       the sheet assertions come before the hit test so a regression is
       reported as the sheet it is, not as a covered card. */
    await page2.evaluate(() => window.forayStorageReady);
    await page2.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page2.waitForTimeout(1_000);
    await shot(page2, testInfo, "1-returning-home");

    await expect(page2.locator("#first-time-sheet"), "a returning listener was shown the first-time sheet again").toHaveCount(0);
    await expect(page2.locator("#intro-sheet"), "a returning listener was shown the intro popup").toHaveCount(0);
    await playableCardAt(page2, 10_000, testInfo);
  } finally {
    await second.close();
  }
});
