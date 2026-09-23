/* Issue #684, founder report 2: "when I do click the search bar, type and
 * search something, then hit search, the page jumps around a lot within a
 * second or so. Feels clunky."
 *
 * WHY THIS IS A BROWSER SUITE AND NOT A node:vm ONE. The node:vm suites in
 * `test/` can prove the ORDER of the rows app.js decides to paint — and
 * test/show-search-fallthrough.test.js does exactly that, which is the rule
 * this file is the pixel-level version of. What they cannot see is the thing
 * the founder actually reported: an element's y coordinate changing under a
 * thumb. That needs a real cascade, a real layout and a real scroll container,
 * so it lives here, alongside the other two UI specs, on lib/site-server.mjs's
 * real-bytes origin.
 *
 * WHAT EACH TEST PROVES, and the mutation that kills it:
 *
 *  1. A row that has been painted never moves again for the life of the query.
 *     The two endpoints are held at the latencies the founder's own
 *     diagnostics reported (`net=710ms dir=1533ms`) and the directory is given
 *     a row that would OUTRANK the local answer, so a whole-list re-rank is
 *     visible as motion rather than as an implementation detail.
 *     MUTATION: in app.js's `appendShowResults`, wrap the concatenation in
 *     `SearchEngine.rankShows(query, ...)` — i.e. restore the pre-#684
 *     whole-list re-rank. The directory's rows land above rows already on
 *     screen, every y coordinate below them changes, and this goes red.
 *
 *  2. A browse tile runs the search (report 1) — end to end, in a real
 *     browser, from tap to painted rows.
 *     MUTATION: put `taxonomyChip` back into `browsePillsHtml`. The tile opens
 *     `#/category/science`, which over the committed catalogue holds nothing,
 *     and the "No shows here yet." assertion fires. RUN: failed as named.
 *
 * TWO THINGS THIS FILE MEASURED AND THEN DID NOT KEEP, recorded because the
 * negative result is the useful part and the next person should not spend the
 * afternoon re-deriving it:
 *
 *   - "The empty-state note pushes the results down when they overturn it."
 *     It does not. `paintShowResults` hides `#sh-note` exactly when it shows a
 *     row and vice versa — the two are mutually exclusive, so the rows land at
 *     the note's own y whichever order the template puts them in. A test was
 *     written for it and passed against the unfixed page, which is how the
 *     hypothesis died. No reorder shipped.
 *
 *   - "The page should scroll itself to the top when the browse furniture
 *     unmounts, instead of leaving the viewport to the browser's clamp."
 *     Also measured, also dropped: the A–Z index really does take the document
 *     from 17 809 px to 844 px on focus, and a listener scrolled to 4000 really
 *     does end up at 0 — but Chromium applies that clamp SYNCHRONOUSLY, in the
 *     same turn as the `hidden` writes, so an explicit `scrollPageTo(0)`
 *     changed nothing any assertion could see. The movement is real and
 *     inherent to hiding the catalogue; it is #681's rule to revisit, not this
 *     page's paint order.
 *
 * VIEWPORT: 390x844 with touch and mobile emulation, the iPhone-class size
 * `playwright.config.mjs`'s `mobile-chromium` project already uses. Set here
 * via `test.use` rather than by joining that project, because that project
 * exists to run ONE spec at two widths; everything in this file is a phone
 * report and has no desktop half worth doubling the wall-clock for.
 */
import { test, expect } from "@playwright/test";
import { startSiteServer } from "../lib/site-server.mjs";

test.use({
  /* Nothing here is about the worker, and a worker caching one test's page and
     serving it to another is the cross-test coupling the per-test server
     exists to avoid — same reasoning as drawer-and-close.spec.js. */
  serviceWorkers: "block",
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});

/* Same ceiling and same reason as drawer-and-close.spec.js: each test boots the
   whole real app (~3 MB of data/*.json plus a CPU-bound vocabulary priming
   pass) before it can assert anything. */
test.beforeEach(async ({}, testInfo) => testInfo.setTimeout(180_000));

let site;
test.beforeEach(async () => { site = await startSiteServer(); });
test.afterEach(async () => { await site?.close(); });

/** The two latencies out of the founder's own diagnostics record for this
    page — `search qLen=3 local=0ms/1h net=710ms/25h dir=1533ms/45h`. Held
    exactly rather than approximated, because the whole complaint is about what
    lands a second and a half after the first paint. */
const NET_MS = 710;
const DIR_MS = 1533;

const row = (id, title, source) => ({
  show_id: id, title, artwork_url: null, artist_name: null,
  editorial_note: null, taxonomy_node_ids: [], tier: "breadth", source,
});

/** Answers the two show-search requests on the reported schedule. `directory`
    is what the `fallthrough=1` pass returns; `net` is the catalogue pass. */
async function stubSearch(page, { net = [], directory = [] } = {}) {
  await page.route(/api\/shows\/search.*fallthrough=1/, async (r) => {
    await new Promise((s) => setTimeout(s, DIR_MS));
    await r.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ shows: directory, degraded: false, fallthrough: { attempted: true, error: null } }),
    });
  });
  await page.route(/api\/shows\/search(?!.*fallthrough=1)/, async (r) => {
    await new Promise((s) => setTimeout(s, NET_MS));
    await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ shows: net, degraded: false }) });
  });
  /* The episode tier is a third request on the same tick. It is not what this
     file measures and it renders BELOW the show list, but leaving it to hit
     the real origin would make every test here depend on the network. */
  await page.route(/api\/episodes\/search/, (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ episodes: [] }) }));
}

/** Boots the real app on #/shows and waits for the search field the page owns.
    The first-time sheet is removed rather than dismissed through its own
    button: this file is not testing onboarding, and a sheet that swallows
    clicks would make every failure below read as "the tap did nothing". */
async function openShowsPage(page) {
  await page.goto(site.baseUrl + "#/shows");
  await page.waitForFunction(() => !!document.querySelector("#sh-input"), null, { timeout: 60_000 });
  await page.waitForFunction(() => document.querySelectorAll("#view .show-result").length > 0, null, { timeout: 60_000 });
  await page.evaluate(() => { document.querySelector("#first-time-sheet")?.remove(); });
}

/** Installs a MutationObserver on `#sh-results` that records the full row list
    — title and absolute y — every time the list is repainted.

    WHY AN OBSERVER AND NOT THREE READS AT THREE MOMENTS. The first draft
    snapshotted after the submit, after the catalogue pass and after the
    directory pass, and compared each against the last. That is four passes
    pretending to be three: `loadShowIndex` resolves on its own schedule, and
    when the show index lands mid-query `repaintShowSearchForIndex` repaints
    too. Under CI's two workers it landed inside the window between two reads
    often enough to be flaky — a test failing because it guessed wrong about
    WHEN, not about WHAT.

    Observing every repaint removes the guess entirely and states the invariant
    directly: whatever the passes are, however many there are, and in whatever
    order they answer, each repaint must be an EXTENSION of the one before it. */
async function recordRepaints(page) {
  await page.evaluate(() => {
    const grab = () => [...document.querySelectorAll("#sh-results .show-result")].map((a) => ({
      title: a.querySelector(".show-result-title").textContent,
      y: Math.round(a.getBoundingClientRect().y + window.scrollY),
    }));
    window.__repaints = [];
    /* `getBoundingClientRect` inside the callback forces the layout that has
       just been invalidated, so these are the coordinates the frame will
       actually paint, not stale ones. */
    new MutationObserver(() => window.__repaints.push(grab()))
      .observe(document.querySelector("#sh-results"), { childList: true, subtree: true });
  });
}

test("a row that has been painted never moves again, however late the next pass lands", async ({ page }) => {
  await stubSearch(page, {
    net: [row("net-1", "Science Matters Daily", "catalog")],
    /* An EXACT title match for the query. Under a whole-list re-rank it sorts
       to the top, above the curated rows already on screen — which is what
       made the list jump. */
    directory: [row("dir-exact", "Science", "apple"), row("dir-2", "Science Weekly", "apple")],
  });
  await openShowsPage(page);
  await recordRepaints(page);

  await page.click("#sh-input");
  await page.fill("#sh-input", "science");
  /* SUBMIT FROM THE KEYBOARD, NOT FROM A BUTTON.
     This line clicked `#sh-form button[type=submit]` — the "Go" pill — until
     2026-09-14, when #696 deleted it at the founder's request ("since the
     search results are live, the go button is useless"). #692 added this test
     and #696 removed the control it clicked; each PR was green on its own
     branch and `main` went red the moment both were in, because `page.click`
     waits for an element that no longer exists and times out at 180 s.

     Enter is not a substitute for the deleted button, it is the path that
     always mattered: it is how a phone keyboard dismisses, and it is the
     reason #696 kept the form's submit handler when it deleted the control.
     A test that drives the real submit path cannot be invalidated by a
     change of chrome again.

     MUTATION: restore `page.click("#sh-form button[type=submit]")`. It fails
     with a 180 s timeout, which is how this was found. */
  await page.press("#sh-input", "Enter");

  /* Both endpoints have answered and the last merge has painted. */
  await page.waitForFunction(
    () => [...document.querySelectorAll("#sh-results .show-result-title")].some((t) => t.textContent === "Science"),
    null, { timeout: 30_000 });
  await page.waitForTimeout(250);

  const repaints = await page.evaluate(() => window.__repaints);

  /* Not vacuous: the local pass, the catalogue pass and the directory pass are
     three separate repaints at minimum, and the list really did grow. */
  expect(repaints.length).toBeGreaterThanOrEqual(3);
  expect(repaints[0].length).toBeGreaterThan(0);
  expect(repaints[repaints.length - 1].length).toBeGreaterThan(repaints[0].length);

  /* THE INVARIANT. Every repaint extends the previous one: same rows, same
     titles, same pixels, plus more underneath. */
  for (let i = 1; i < repaints.length; i++) {
    const before = repaints[i - 1];
    const after = repaints[i];
    expect(after.length).toBeGreaterThanOrEqual(before.length);
    expect(after.slice(0, before.length)).toEqual(before);
  }

  /* And the late rows really were the ones that would have jumped the queue,
     so the loop above is not passing on an empty merge. */
  const last = repaints[repaints.length - 1].map((r) => r.title);
  expect(last).toContain("Science");
  expect(last.indexOf("Science")).toBeGreaterThan(0);
});

test("a browse tile runs the ordinary search for its own label", async ({ page }) => {
  /* Report 1, end to end. `Science` is the tile whose category page holds
     nothing at all over the committed catalogue (32 of the 41 do — see
     test/category-browse.test.js), so a tile still linking to `#/category/` is
     visible here as an empty page rather than as a different href. */
  await stubSearch(page, { directory: [row("dir-1", "Science Vs Everything", "apple")] });
  await openShowsPage(page);

  const tile = page.locator('#sh-browse .fy-chip', { hasText: /^Science$/ });
  await expect(tile).toHaveCount(1);
  await tile.click();

  /* "Search", not "Shows": the audit (theme K / R6, 2026-09-23) gave each
     destination one name, and the tab bar's wins, so the page is titled for
     the tab that opens it. */
  await expect(page.locator("#view h2")).toHaveText("Search");
  await expect(page.locator("#sh-input")).toHaveValue("Science");
  await page.waitForFunction(() => document.querySelectorAll("#sh-results .show-result").length > 0, null, { timeout: 30_000 });
  await expect(page.locator("#view")).not.toContainText("No shows here yet.");
});
