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
 * The lab-only #/gallery route requires ?gallery=1 (or window.__FORAY_LAB__).
 * #/subject/<id> is generated from a live search result and has no stable seed,
 * so it is not shot; everything else is.
 */

import { forayDetailPicks } from "./seed.mjs";

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

async function closeNowPlaying(page) {
  const close = page.locator(".fp-close");
  if (await close.count()) await close.first().click().catch(() => {});
  await wait(page, 400);
}

/* Foray detail: the page, the route and the states below it. The Foray in the first coreRoutes step is a
   draft (the page answers "That foray isn't available"), so this block opens published ones by id. */
const forayRoute = (foray) => "#/foray/" + encodeURIComponent(foray.id);

/* An unavailable Foray: every audio source in the page's document loses its audio URL, in place, so each
   clip of the Foray still resolves (its show, its why-line) but is refused ("no audio url"), nothing is
   playable, and the route is painted again. It takes the Foray without narration: a narrator's bridge needs
   no source and would still play. `state` is the app's own top-level binding, reachable from the page. */
async function openUnavailableForay(page, foray) {
  /* Off the Afterglow page while the scheme goes back to dark (the Dawn step before this one left it light), so no
     drawn page crossfades; the Foray is then painted new. */
  await page.evaluate(() => { location.hash = "#/forays"; });
  await wait(page, 400);
  await page.emulateMedia({ colorScheme: "dark" });
  await wait(page, 400);
  await page.evaluate((hash) => {
    state.segmentSources = { ...state.segmentSources, sources: state.segmentSources.sources.map((row) => ({ ...row, audio_url: null })) };
    location.hash = hash;
  }, forayRoute(foray));
  await page.waitForSelector(".fd.is-unavailable", { timeout: 15000 });
  await wait(page, 700);
}

/* Dawn: the OS asks for the light scheme, the way a phone does. The tokens follow the media query. */
async function goDawn(page) {
  /* Leave the Afterglow page first and come back after the flip, so the scheme change is not a live colour change on a page
     that is already drawn (every .ag element would crossfade for 200ms): the page is painted new, in Dawn. */
  const hash = await page.evaluate(() => { const h = location.hash; location.hash = "#/forays"; return h; });
  await wait(page, 500);
  await page.emulateMedia({ colorScheme: "light" });
  await wait(page, 500);
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForSelector(".fd .fd-title", { timeout: 15000 });
  await wait(page, 700);
}

/* Episode page with publisher notes. The catalogue's episodes carry no description, so this patches one episode's
   record in the app's own item index (a real description: prose, a chapter-style list with stamps, an inline stamp, a
   link) and paints the route again. The item is one the returning seed neither saved nor queued, so Save and Up Next
   start Off and the Up Next add can be shot. `state` and `renderEpisode` are the app's own top-level bindings. */
const EPISODE_NOTES = [
  "A long conversation about how a measurement becomes a fact, recorded over two afternoons in a basement lab.",
  "",
  "00:00 Cold open",
  "02:15 The instrument and its flaws",
  "21:40 Three continents, one argument",
  "48:05 What the data finally said",
  "",
  "The paper is at https://example.org/papers/measurement-and-meaning and the lab notebook is linked from there.",
  "The best exchange starts at 31:20 and runs for six minutes, if you only have a little time.",
  "Thanks to the listeners who wrote in with corrections, and to everyone who sent a photograph of their own bench.",
].join("\n");

async function seedEpisodeNotes(page, id) {
  await page.evaluate(({ id, text }) => {
    state.itemIndex[id] = { ...state.itemIndex[id], description: text, duration_min: 62 };
    renderEpisode(id);
  }, { id, text: EPISODE_NOTES });
  await page.waitForSelector(".ag.ep .ep-description", { timeout: 15000 });
  await wait(page, 500);
  await scrollToEpisodeNotes(page);
}

/** Bring the notes' heading near the top of the viewport, so a viewport shot shows the clamp, the chips and the More button. */
async function scrollToEpisodeNotes(page) {
  await page.evaluate(() => {
    const head = document.querySelector(".ag.ep .ep-description");
    if (head) window.scrollTo(0, window.scrollY + head.getBoundingClientRect().top - 72);
  });
  await wait(page, 300);
}

async function clickEpisodeControl(page, selector, ms = 900) {
  await page.waitForSelector(selector, { timeout: 15000 });
  await page.click(selector);
  await wait(page, ms);
}

async function typeSearch(page, text) {
  await page.waitForSelector("#sh-input", { timeout: 15000 });
  await page.fill("#sh-input", text);
  await wait(page, 1800);
}

async function showGalleryTarget(page, selector) {
  const open = page.locator(`[data-ag-live-sheet]:not([hidden])`);
  if (await open.count()) {
    await page.keyboard.press("Escape");
    await wait(page, 100);
  }
  const target = page.locator(selector).first();
  await target.waitFor({ state: "visible", timeout: 10000 });
  await target.evaluate((node) => node.scrollIntoView({ block: "start", inline: "nearest" }));
  await wait(page, 200);
}

async function openGallerySheet(page, theme) {
  const open = page.locator(`[data-ag-live-sheet]:not([hidden])`);
  if (await open.count()) await page.keyboard.press("Escape");
  const panel = page.locator(`#ag-gallery-${theme}-scheme`);
  await panel.locator("[data-ag-open-sheet]").click();
  await page.waitForSelector(`#ag-gallery-${theme}-scheme [data-ag-live-sheet]:not([hidden])`, { timeout: 10000 });
  await wait(page, 200);
}

function galleryCaptureSteps(theme) {
  const section = (name) => `#ag-gallery-${theme}-${name}`;
  const step = (label, selector) => ({
    label: `${theme}-${label}`,
    route: "#/gallery",
    run: (page) => showGalleryTarget(page, selector),
  });
  return [
    step("glow", section("glow")),
    step("buttons-top", `${section("buttons")} .ag-gallery-states:nth-child(1)`),
    step("buttons-lower", `${section("buttons")} .ag-gallery-states:nth-child(4)`),
    step("controls-top", `${section("controls")} .ag-gallery-states:nth-child(1)`),
    step("controls-lower", `${section("controls")} .ag-scrubber`),
    step("artwork", section("artwork")),
    step("rows-default", `${section("rows")} .ag-gallery-state:nth-child(1)`),
    step("rows-active", `${section("rows")} .ag-gallery-state:nth-child(4)`),
    step("rows-edge", `${section("rows")} .ag-gallery-state:nth-child(7)`),
    step("rows-queue", `${section("rows")} .ag-gallery-state:nth-child(9)`),
    step("cards-hero", `${section("cards")} .ag-hero-pick`),
    step("cards-stretch-top", `${section("cards")} .ag-gallery-state:nth-child(1)`),
    step("cards-stretch-lower", `${section("cards")} .ag-gallery-state:nth-child(4)`),
    step("cards-foray", `${section("cards")} .ag-foray-card`),
    step("cards-tiles", `${section("cards")} .ag-show-tile`),
    step("navigation", section("navigation")),
    step("feedback", section("feedback")),
    step("icons", section("icons")),
    step("icon-sizes", `${section("icons")} h3.ag-icons-title`),
    {
      label: `${theme}-sheet-open`,
      route: "#/gallery",
      run: (page) => openGallerySheet(page, theme),
      ready: `#ag-gallery-${theme}-scheme [data-ag-live-sheet]:not([hidden])`,
    },
  ];
}

/* Today (Redesign 2026, ambient): the boot held open. The discover document never answers, so init()
   never reaches route() and the page stays on the screen it painted before its first await: on Home,
   Today's skeletons with the lamp sweep. The route is registered AFTER the harness stubs, and a later
   Playwright route wins; a handler that neither fulfils nor continues leaves the request pending. */
async function holdBoot(page) {
  await page.context().route("**/data/discover.json", () => {});
  await page.reload({ waitUntil: "commit" });
  await page.waitForSelector("[data-boot-loading]", { timeout: 15000 });
  await wait(page, 600);
}

/* Today, offline: the page is told it is offline, the way a phone tells it. Today reads navigator.onLine and
   follows the offline event, so the banner and the unplayable rows appear on the page already open. The
   network itself stays up on purpose: on a phone the shell's own files (the icon sprite a new <use> fetches)
   come from the service worker's cache or the app bundle, but a harness context with no network, and no
   service worker, cannot serve them, and the glyphs would vanish for a reason that is not the app's. */
async function goOffline(page) {
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    window.dispatchEvent(new Event("offline"));
  });
  await wait(page, 600);
}

/* Settings, Tuning and About (Redesign 2026, ambient, screen 9). Tuning is the existing `interests` step. These are
   appended to `returning`: the gear's Sheet opened from Today's own gear, "What 4a does" over it, the Settings page
   with Dawn chosen live (the page re-lights without a reload), and the About page. */
async function openGearSheet(page) {
  if (!(await page.locator("#st-menu:not([hidden])").count())) await page.locator("[data-today-gear]").first().click();
  await page.waitForSelector("#st-menu:not([hidden])", { timeout: 10000 });
  await wait(page, 700);
}

async function openWhatSheet(page) {
  await openGearSheet(page);
  await page.locator('#st-menu [data-st-menu="what"]').click();
  await page.waitForSelector("#st-what:not([hidden])", { timeout: 10000 });
  await wait(page, 800);
}

async function chooseDawn(page) {
  await page.locator('[data-st-theme] [data-st-value="dawn"]').click();
  await wait(page, 500);
}

function settingsSteps() {
  return [
    { label: "gear-sheet", route: "#/", run: (page) => openGearSheet(page), ready: "#st-menu:not([hidden])" },
    { label: "what-4a-does", route: "#/", run: (page) => openWhatSheet(page), ready: "#st-what:not([hidden])" },
    { label: "settings", route: "#/settings", ready: ".st-page[data-st-page=settings]" },
    { label: "about", route: "#/about", ready: ".st-page[data-st-page=about]" },
    { label: "settings-dawn-chosen", route: "#/settings", run: (page) => chooseDawn(page), ready: ".st-page[data-st-page=settings]" },
  ];
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
      id: "gallery",
      description: "Afterglow primitives in every state, shown in Dusk and Dawn.",
      seed: "dismissed",
      steps: [
        { label: "dusk-overview", route: "?gallery=1#/gallery", ready: ".ag-gallery" },
        ...galleryCaptureSteps("dusk"),
        ...galleryCaptureSteps("dawn"),
      ],
    },
    {
      id: "first-run",
      description: "Brand-new profile: the first-run Room (Redesign 2026, ambient) over Home. The step keeps its old label, intro-sheet, because other directions' screens.json rows name it.",
      seed: "empty",
      steps: [{ label: "intro-sheet", route: "#/", ready: "#onboarding-room" }],
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
      steps: [...coreRoutes(fx, { entities: true }), ...settingsSteps()],
    },
    {
      id: "player",
      description: "Returning user with an episode loaded: mini player over pages, then the Now Playing sheet.",
      seed: "returning",
      steps: [
        { label: "mini-player-home", route: "#/", run: (page) => startPlayback(page, ep0) },
        { label: "mini-player-library", route: "#/library" },
        { label: "mini-player-up-next", route: "#/queue" },
        { label: "now-playing", route: "#/library", run: (page) => openNowPlaying(page) },
        { label: "now-playing-closed", route: "#/library", run: (page) => closeNowPlaying(page) },
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
      id: "foray-detail",
      description: "Foray detail: a narrated Foray, an unnarrated one, the Dawn scheme, and one that cannot play (its audio sources refused).",
      seed: "returning",
      steps: (() => {
        const { narrated, plain } = forayDetailPicks(fx);
        return [
          { label: "foray", route: forayRoute(narrated), ready: ".fd .fd-title" },
          { label: "foray-unnarrated", route: forayRoute(plain), ready: ".fd .fd-title" },
          { label: "foray-dawn", route: forayRoute(plain), run: (page) => goDawn(page), ready: ".fd .fd-title" },
          { label: "foray-unavailable", route: forayRoute(plain), run: (page) => openUnavailableForay(page, plain) },
        ];
      })(),
    },
    {
      id: "foray-resume",
      description: "Foray detail with the narrated Foray half played: the strip filled to the stored point and the button reading Resume.",
      seed: "foray-resume",
      steps: [{ label: "foray-resume", route: forayRoute(forayDetailPicks(fx).narrated), ready: ".fd #fy-play" }],
    },
    {
      id: "episode-notes",
      description: "Episode page with publisher notes: four lines and More, timestamp chips, a chapter-style list, then the notes opened, then Up Next added (the art flies to the Library tab and its count goes up).",
      seed: "returning",
      steps: (() => {
        const id = (fx.items[11] || fx.items[10] || fx.items[9]).id;
        const route = "#/episode/" + encodeURIComponent(id);
        return [
          { label: "episode-notes", route, run: (page) => seedEpisodeNotes(page, id) },
          { label: "episode-notes-open", route, run: async (page) => { await clickEpisodeControl(page, ".ag.ep .ep-notes-more", 600); await scrollToEpisodeNotes(page); } },
          { label: "episode-upnext-added", route, run: async (page) => { await page.evaluate(() => window.scrollTo(0, 0)); await clickEpisodeControl(page, "[data-ep-upnext]", 1100); } },
        ];
      })(),
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
      id: "loading",
      description: "Today while the boot is held open: skeletons for the hero and four rows, the wash at the default Glow.",
      seed: "dismissed",
      steps: [{ label: "home", route: "#/", run: (page) => holdBoot(page) }],
    },
    {
      id: "offline",
      description: "Today with the network down: the Offline banner, downloaded items playable, the rest at half art with Play disabled.",
      seed: "returning",
      steps: [{ label: "home", route: "#/", run: (page) => goOffline(page) }],
    },
    {
      id: "midlisten",
      description: "Today with an episode part-played (40 minutes in): Keep listening, and the ribbon restored over the page.",
      seed: "midlisten",
      steps: [{ label: "home", route: "#/", ready: ".td-keep" }],
    },
    {
      id: "show",
      description: "A fresh profile on a show page (Redesign 2026, ambient): the Room lit by the show, Follow in its off state (the Regular plus), the latest episode first. The returning state's `show` step is the followed state.",
      seed: "dismissed",
      steps: [{ label: "show-unfollowed", route: "#/show/" + encodeURIComponent(fx.shows[0].show_id), ready: "[data-sh-room]" }],
    },
  ];
}
