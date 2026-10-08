/* The app target's states: a seeded profile + an ordered list of steps. A step
 * is { label, route, run? }. The walker navigates to `route` (a hash), calls
 * `run(page, ctx)` if present, settles, then hands the page to the consumer
 * (shoot.mjs screenshots it, a11y.mjs runs axe on it). Steps run in order on ONE
 * page per (state, viewport), so a later step may rely on an earlier one
 * (the player is started once, then the Now Playing sheet is opened).
 *
 * Route census (app.js renderCurrentPage + TAB_ROUTES): #/ , #/shows ,
 * #/shows/q/<label> , #/show/<id> , #/episode/<id>[?t=N] , #/category/<id> ,
 * #/playlists , #/playlist/<id> , #/subject/<id> , #/create , #/forays ,
 * #/foray/<id> , #/queue , #/library , #/starred-shows , #/interests.
 * #/subject/<id> is generated from a live search result and has no stable seed,
 * so it is not shot; everything else is.
 */

const wait = (page, ms) => page.waitForTimeout(ms);

/** Start playback of a seeded item through the real player, then pin it: seek to
    a fixed offset and pause, so the mini bar and sheet show a deterministic
    position. (The audio is the silent 60 s fixture, so the bar's time reads
    against that, not the episode's real length.) */
async function startPlayback(page, itemId) {
  await page.evaluate(async (id) => {
    const saved = JSON.parse(localStorage.getItem("cp_saved") || "{}");
    const it = saved[id];
    if (!it) throw new Error("uilab: seeded item missing: " + id);
    await window.ForayPlayer.play(
      { ...it, duration_sec: it.duration_sec || (it.duration_min || 60) * 60 },
      { why: "uilab fixture" }
    );
  }, itemId);
  await page.waitForFunction(() => (window.__audios || []).some((a) => a.src && !a.paused && a.currentTime > 0), null, { timeout: 20000 });
  await page.evaluate(() => {
    for (const a of window.__audios || []) if (a.src) { try { a.currentTime = 21; a.pause(); } catch (_) { /* ignore */ } }
  });
  await page.waitForSelector("#foray-player", { state: "visible", timeout: 10000 });
  await wait(page, 600);
}

async function openNowPlaying(page) {
  await page.locator(".fp-info").first().click();
  await page.waitForSelector(".fp-sheet", { state: "visible", timeout: 10000 });
  await wait(page, 700);
}

async function openForayNowPlaying(page) {
  await page.evaluate(async () => {
    await window.ForayPlayer.stopForDataDeletion();
    const [foraysDoc, segmentsDoc, sourcesDoc, discoverDoc] = await Promise.all([
      fetch("data/forays.json").then((response) => response.json()),
      fetch("data/segments.json").then((response) => response.json()),
      fetch("data/segment-sources.json").then((response) => response.json()),
      fetch("data/discover.json").then((response) => response.json()),
    ]);
    const id = "capital-types-1";
    const resolved = window.ForayPlayer.resolve(foraysDoc, { id, segmentsDoc, sourcesDoc, showDrafts: true });
    if (!resolved) throw new Error("uilab: Tactile Now Playing foray did not resolve");
    window.ForayPlayer.restoreForay(resolved, { startElapsedSec: 760, discoverDoc });
  });
  await page.waitForSelector("#foray-player", { state: "visible", timeout: 10000 });
  await openNowPlaying(page);
}

async function closeNowPlaying(page) {
  const close = page.locator(".fp-close");
  if (await close.count()) await close.first().click().catch(() => {});
  await wait(page, 400);
}

/** The earlier steps leave a Foray on the bar; Yours > Up Next shows the playing
    row only for an episode that is in the list. Put the first one back on the bar
    and repaint the page, so the playing row is drawn the way it was in
    mini-player-library. */
async function queueWithPlaying(page, itemId) {
  await startPlayback(page, itemId);
  await page.evaluate(() => { if (typeof renderCurrentPage === "function") renderCurrentPage(); });
  await wait(page, 400);
}

/** Yours > Up Next: open the action row (the ⋯) of the n-th queue row. Opens
    only when it is not already open, so a step that repeats the route does not
    toggle it shut. */
async function openQueueActions(page, n) {
  await page.waitForSelector("#yours-panel-upnext .yours-qwrap", { state: "visible", timeout: 15000 });
  const row = page.locator("#yours-panel-upnext .yours-qwrap").nth(n);
  if (!(await row.locator(".yours-qtools").count())) await row.locator('[data-action^="more:"]').click();
  await row.locator(".yours-qtools").waitFor({ state: "visible", timeout: 10000 });
  await wait(page, 500);
}

/** Yours > Up Next: press Clear and wait for the confirm sheet. */
async function openClearSheet(page) {
  /* The step before held its undo toast up; it does not belong in this capture. */
  await page.evaluate(() => { if (typeof hideYoursUndo === "function") hideYoursUndo(); });
  await page.waitForSelector('#yours-panel-upnext [data-action="clear"]', { state: "visible", timeout: 15000 });
  await page.locator('#yours-panel-upnext [data-action="clear"]').click();
  await page.waitForSelector("#yours-clear-sheet:not([hidden])", { state: "visible", timeout: 10000 });
  await wait(page, 600);
}

/** Yours > Up Next: Remove on the n-th row, then wait for the undo toast. */
async function removeQueueRow(page, n) {
  await openQueueActions(page, n);
  await page.locator("#yours-panel-upnext .yours-qwrap").nth(n).locator('[data-action^="rm:"]').click();
  await page.waitForSelector("#yours-toast .toast.is-visible", { state: "visible", timeout: 10000 });
  /* The toast's clock stops while it is touched, so a press holds it up for the
     capture instead of racing the 4 seconds the harness's settle may take. */
  await page.locator("#yours-toast .toast").dispatchEvent("pointerdown");
  await wait(page, 500);
}

async function typeSearch(page, text) {
  await page.waitForSelector("#sh-input", { timeout: 15000 });
  await page.fill("#sh-input", text);
  await wait(page, 1800);
}

async function setGalleryTheme(page, scheme) {
  await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, scheme);
}

async function showGallerySection(page, selector, scheme) {
  const openSheet = page.locator("#gallery-sheet:not([hidden])");
  if (await openSheet.count()) await page.locator("#gallery-sheet-close").click();
  await setGalleryTheme(page, scheme);
  await page.locator(selector).evaluate((el) => el.scrollIntoView({ block: "start", inline: "nearest" }));
  await wait(page, 200);
}

async function openGallerySheet(page, scheme) {
  await setGalleryTheme(page, scheme);
  await page.evaluate((value) => {
    const opener = document.querySelector("#gallery-sheet-open");
    const preview = document.querySelector(`#gallery-${value}-navigation .sheet--preview`);
    if (opener && preview && preview.parentElement) preview.parentElement.insertBefore(opener, preview);
  }, scheme);
  await page.locator("#gallery-sheet-open").click();
  await page.waitForSelector("#gallery-sheet:not([hidden])", { timeout: 10000 });
  await wait(page, 300);
}

/** Routes every seeded profile can show. `fx` supplies real ids. */
function coreRoutes(fx, { entities }) {
  const ep = fx.items[0].id;
  const show = fx.shows[0].show_id;
  const foray = fx.forays[0] && fx.forays[0].id;
  const steps = [
    { label: "home", route: "#/" },
    { label: "search", route: "#/shows" },
    { label: "create", route: "#/create" },
    { label: "library", route: "#/library" },
    { label: "up-next", route: "#/queue" },
    { label: "playlists", route: "#/playlists" },
    { label: "starred-shows", route: "#/starred-shows" },
    { label: "interests", route: "#/interests" },
    { label: "forays", route: "#/forays" },
  ];
  if (entities) {
    steps.push(
      { label: "playlist-detail", route: "#/playlist/p1" },
      { label: "show", route: "#/show/" + encodeURIComponent(show) },
      { label: "episode", route: "#/episode/" + encodeURIComponent(ep) },
      { label: "category", route: "#/category/" + encodeURIComponent(fx.category) },
      { label: "browse-pill", route: "#/shows/q/" + encodeURIComponent("History") },
    );
    if (foray) steps.push({ label: "foray", route: "#/foray/" + encodeURIComponent(foray) });
  } else {
    steps.push(
      { label: "playlist-not-found", route: "#/playlist/does-not-exist" },
      { label: "episode-not-found", route: "#/episode/does-not-exist" },
    );
  }
  return steps;
}

/** @returns {Array<{id:string, description:string, seed:string, steps:Array}>} */
export function appStates(fx) {
  const ep0 = fx.items[0].id;
  return [
    {
      id: "first-run",
      description: "Brand-new profile: the onboarding explainer sheet over Home.",
      seed: "empty",
      steps: [{ label: "intro-sheet", route: "#/", ready: "#first-time-sheet" }],
    },
    {
      id: "empty",
      description: "Onboarding dismissed, nothing saved: every empty state.",
      seed: "dismissed",
      steps: coreRoutes(fx, { entities: false }),
    },
    {
      id: "returning",
      description: "Returning user: saved episodes, Up Next, playlists, starred shows, history.",
      seed: "returning",
      steps: coreRoutes(fx, { entities: true }),
    },
    {
      id: "player",
      description: "Returning user with an episode loaded: mini player over pages, then the Now Playing sheet.",
      seed: "returning",
      steps: [
        { label: "mini-player-home", route: "#/", run: (page) => startPlayback(page, ep0) },
        { label: "mini-player-library", route: "#/library" },
        { label: "mini-player-up-next", route: "#/queue" },
        { label: "now-playing", route: "#/library", run: (page) => openForayNowPlaying(page) },
        { label: "now-playing-closed", route: "#/library", run: (page) => closeNowPlaying(page) },
        /* Yours, Up Next (tactile `library`, BUILD-PLAN 2.12 and 2.16): the second
           row's action row open, then Remove pressed and the undo toast up. */
        { label: "up-next-actions", route: "#/library", run: async (page) => { await queueWithPlaying(page, ep0); await openQueueActions(page, 1); } },
        { label: "up-next-remove-toast", route: "#/library", run: async (page) => { await queueWithPlaying(page, ep0); await removeQueueRow(page, 1); } },
        { label: "up-next-clear-sheet", route: "#/library", run: async (page) => { await queueWithPlaying(page, ep0); await openClearSheet(page); } },
      ],
    },
    {
      id: "search",
      description: "Search: idle, results, and a query with no results.",
      seed: "returning",
      steps: [
        { label: "search-idle", route: "#/shows" },
        { label: "search-results-fusion", route: "#/shows", run: (page) => typeSearch(page, "fusion") },
        { label: "search-results-history", route: "#/shows", run: (page) => typeSearch(page, "history") },
        { label: "search-no-results", route: "#/shows", run: (page) => typeSearch(page, "zzqxjv") },
      ],
    },
    {
      id: "stress",
      description: "Long-title stress: 150-character titles, a 90-character show name, unbreakable tokens.",
      seed: "stress",
      steps: [
        { label: "home", route: "#/" },
        { label: "library", route: "#/library" },
        { label: "up-next", route: "#/queue" },
        { label: "playlists", route: "#/playlists" },
        { label: "playlist-detail", route: "#/playlist/p1" },
        { label: "starred-shows", route: "#/starred-shows" },
        { label: "episode", route: "#/episode/uilab-stress-1" },
        { label: "episode-token", route: "#/episode/uilab-stress-2" },
        { label: "mini-player", route: "#/library", run: (page) => startPlayback(page, "uilab-stress-1") },
        { label: "now-playing", route: "#/library", run: (page) => openNowPlaying(page) },
      ],
    },
    {
      id: "gallery",
      description: "Tactile foundation gallery: every primitive and state in Cream and Bakelite, plus the icon family.",
      seed: "dismissed",
      steps: [
        { label: "cream-type-and-contrast", route: "?gallery=1#/gallery", ready: "#gallery-light-type" },
        { label: "cream-controls", route: "#/gallery", run: (page) => showGallerySection(page, "#gallery-light-controls", "light") },
        { label: "cream-surfaces", route: "#/gallery", run: (page) => showGallerySection(page, "#gallery-light-surfaces", "light") },
        { label: "cream-band-states", route: "#/gallery", run: (page) => showGallerySection(page, "#gallery-light-surfaces-band-states", "light") },
        { label: "cream-skeletons", route: "#/gallery", run: (page) => showGallerySection(page, "#gallery-light-surfaces-skeletons", "light") },
        { label: "cream-rows", route: "#/gallery", run: (page) => showGallerySection(page, "#gallery-light-rows", "light") },
        { label: "cream-navigation", route: "#/gallery", run: (page) => showGallerySection(page, "#gallery-light-navigation", "light") },
        { label: "cream-playing-mini", route: "#/gallery", run: (page) => showGallerySection(page, "#gallery-light-navigation-playing-mini", "light") },
        { label: "cream-sheet-open", route: "#/gallery", run: (page) => openGallerySheet(page, "light") },
        { label: "bakelite-type-and-contrast", route: "#/gallery", run: (page) => showGallerySection(page, "#gallery-dark-type", "dark") },
        { label: "bakelite-controls", route: "#/gallery", run: (page) => showGallerySection(page, "#gallery-dark-controls", "dark") },
        { label: "bakelite-surfaces", route: "#/gallery", run: (page) => showGallerySection(page, "#gallery-dark-surfaces", "dark") },
        { label: "bakelite-band-states", route: "#/gallery", run: (page) => showGallerySection(page, "#gallery-dark-surfaces-band-states", "dark") },
        { label: "bakelite-skeletons", route: "#/gallery", run: (page) => showGallerySection(page, "#gallery-dark-surfaces-skeletons", "dark") },
        { label: "bakelite-rows", route: "#/gallery", run: (page) => showGallerySection(page, "#gallery-dark-rows", "dark") },
        { label: "bakelite-navigation", route: "#/gallery", run: (page) => showGallerySection(page, "#gallery-dark-navigation", "dark") },
        { label: "bakelite-playing-mini", route: "#/gallery", run: (page) => showGallerySection(page, "#gallery-dark-navigation-playing-mini", "dark") },
        { label: "bakelite-sheet-open", route: "#/gallery", run: (page) => openGallerySheet(page, "dark") },
        { label: "icons-bold", route: "#/gallery", run: (page) => showGallerySection(page, "#gallery-bold-title", "light") },
        { label: "icons-fill", route: "#/gallery", run: (page) => showGallerySection(page, "#gallery-fill-title", "light") },
        { label: "icons-custom", route: "#/gallery", run: (page) => showGallerySection(page, "#gallery-custom-title", "light") },
      ],
    },
  ];
}
