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

/** Now Playing, paused (Tactile BUILD-PLAN 2.2): the sheet of a foray the
    listener started and then paused with the Play keycap. The foray restores
    paused, so one press starts it (the key turns to Pause) and the next press
    pauses it again, leaving the key reading Play. Everything that differs from
    the playing sheet sits inside that keycap's box. The playhead moves a few
    hundred ms between the presses; the elapsed readout floors to the second
    and the restore point (12:40) leaves a whole second of room. */
async function pausedForayNowPlaying(page) {
  /* This step follows the Up Next steps, which leave the Clear confirm sheet up; it
     would sit over the bar the sheet opens from. */
  await page.keyboard.press("Escape");
  await wait(page, 300);
  await openForayNowPlaying(page);
  const big = page.locator("#foray-player .fp-big");
  await big.click();
  await page.waitForSelector('#foray-player .fp-big[aria-label="Pause"]', { timeout: 10000 });
  await big.click();
  await page.waitForSelector('#foray-player .fp-big[aria-label="Play"]', { timeout: 10000 });
  await wait(page, 600);
}

async function closeNowPlaying(page) {
  const close = page.locator(".fp-close");
  if (await close.count()) await close.first().click().catch(() => {});
  await wait(page, 400);
}

/** Put the phone on a train: one Also-today episode (the second row, as in the prototype's
    offline route) is recorded as on the device, then the radio goes off. The page is loaded
    ONLINE first (an offline context cannot even fetch the local bundle) and the browser's
    own `offline` event repaints Today, which is the path a real listener's phone takes.
    The record is written through the app's lsSet, the same door the Downloads code uses. */
async function goOffline(page) {
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".today .row-episode [data-play]")];
    const key = rows[1] || rows[0];
    if (!key) throw new Error("uilab: no playable Also-today row to mark as downloaded");
    const id = key.getAttribute("data-play");
    window.lsSet("cp_downloads", {
      settings: { cellular: false },
      items: { [id]: { status: "done", bytes: 31457280, total: 31457280, path: "downloads/" + id + ".mp3", updated_at: "2026-10-04T12:00:00.000Z" } },
    });
  });
  await page.context().setOffline(true);
  await page.waitForFunction(() => navigator.onLine === false && document.querySelector(".today .keycap--blocked"), null, { timeout: 10000 });
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

/** Yours > Shows: press the Shows chip and wait for the grid. A chip press only
    moves `hidden`, so the panel is already in the document; it is visible once
    the press has landed. */
async function openYoursShows(page) {
  await page.waitForSelector('[data-yours-chip="shows"]', { state: "visible", timeout: 15000 });
  await page.locator('[data-yours-chip="shows"]').click();
  await page.waitForSelector("#yours-panel-shows .shows-tile", { state: "visible", timeout: 10000 });
  await wait(page, 500);
}

/** Yours > Shows with the first tile's ⋯ pressed: Unfollow revealed over its art. The ⋯ is invisible and inert to a pointer at rest (iteration 3), so it is reached the way a keyboard user does: focus, then Enter. */
async function openYoursShowActions(page) {
  await openYoursShows(page);
  const tile = page.locator("#yours-panel-shows .shows-tile").first();
  if (!(await tile.locator(".shows-tile__actions:not([hidden])").count())) { await tile.locator(".shows-tile__more").focus(); await page.keyboard.press("Enter"); }
  await tile.locator(".shows-tile__actions:not([hidden])").waitFor({ state: "visible", timeout: 10000 });
  await wait(page, 400);
}

async function typeSearch(page, text) {
  await page.waitForSelector("#sh-input", { timeout: 15000 });
  await page.fill("#sh-input", text);
  await wait(page, 1800);
}

/* Type a query, then press return: the phone keyboard's own way of putting it
   away. The field lets go (the submit handler blurs it), so the deck is back
   and the field sits above it, which is the state the Tactile typing screen
   is drawn in; a field that still holds focus hides the deck for the keyboard
   that a headless page never raises. */
async function typeSearchThenReturn(page, text) {
  await page.waitForSelector("#sh-input", { timeout: 15000 });
  await page.fill("#sh-input", text);
  await wait(page, 600);
  await page.press("#sh-input", "Enter");
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

/** Hold the catalog document for the life of the page: the request is answered
    never, so init() stays at `await documentsP` and `#view` keeps the boot paint.
    Closing the context aborts the pending request. The pattern is the document
    the boot path fetches (`fetchJson("data/catalog-client.json")`, query string
    allowed). */
/** Today: press the knob keycap and wait for the Settings sheet (tactile
    `settings`). The sheet is the app's own modal, so `#settings-sheet` loses its
    `hidden` once `openSheet` has taken it; the beat after is the sheet settling. */
async function openSettingsFromKnob(page) {
  await page.waitForSelector("#today-knob", { state: "visible", timeout: 15000 });
  /* A listener who has turned two dials: the first two the sheet would offer sit
     at +2 and -1 (the prototype's own sample: Engineering 7, History 4), the third
     stays at 4a's setting. Through the app's own writers, so the sheet reads real
     state; without this every readout is empty (it is empty at the detent) and the
     only carrier of a setting is the needle. */
  await page.evaluate(() => {
    const [a, b] = settingsDialNodes();
    for (const [n, pos] of [[a, 7], [b, 4]]) if (n) setInterest(n.id, settingsDialValue(pos, settingsAnchor(n)));
    saveInterests();
  });
  await page.locator("#today-knob").click();
  await page.waitForSelector("#settings-sheet:not([hidden])", { state: "visible", timeout: 10000 });
  await wait(page, 600);
}

async function holdCatalog(page) {
  await page.route("**/data/catalog-client.json*", () => { /* held on purpose */ });
}

/* Tactile `foray` (Foray detail): the four states the page draws beyond its fresh one.
 * A step shares one page with the steps before it, and the player reads a Foray's stored
 * place once at boot (its store is authoritative in memory), so a state that needs a place
 * writes the `cp_foray:<id>` row the app itself writes, then loads the page again on the
 * Foray's address. A draft Foray (the un-narrated one) is opened the way a listener opens
 * one: by name, `?foray=<id>`, which is also what unlocks it. */
const FORAY_NARRATED = "how-ai-actually-gets-built-3b83e1";
const FORAY_UNNARRATED = "grilling-history-2";

async function openForayDetail(page, id, { unlock = false, at = null } = {}) {
  /* Through the durable store the app itself writes with (memory, localStorage and IndexedDB
     together: clearing localStorage alone lets a stale row come back from IndexedDB), after the
     player lets go of what it has loaded (it would save its own place over the row as the page
     unloads). The place is worked out against the real resolver. */
  await page.evaluate(async ({ id, at }) => {
    try { await window.ForayPlayer.stopForDataDeletion(); } catch (_) { /* nothing was loaded */ }
    const store = window.forayStorage;
    for (const key of store.keys("cp_foray:")) store.removeItem(key);
    if (at != null) {
      const [foraysDoc, segmentsDoc, sourcesDoc] = await Promise.all([
        fetch("data/forays.json").then((response) => response.json()),
        fetch("data/segments.json").then((response) => response.json()),
        fetch("data/segment-sources.json").then((response) => response.json()),
      ]);
      const resolved = window.ForayPlayer.resolve(foraysDoc, { id, segmentsDoc, sourcesDoc, showDrafts: true });
      if (!resolved) throw new Error("uilab: Foray detail fixture did not resolve: " + id);
      const elapsed = at === "end" ? resolved.totalSec : at;
      const place = window.ForayPlayer.segmentAt(resolved.playable, elapsed);
      store.setItem("cp_foray:" + id, JSON.stringify({
        foray_id: id, title: resolved.title, elapsed_sec: elapsed, total_sec: resolved.totalSec,
        index: place ? place.index : -1, segment_id: null, into_sec: place ? place.into : 0, updated_at: new Date().toISOString(),
      }));
    }
    await store.flush();
  }, { id, at });
  const url = new URL(page.url());
  url.search = unlock ? "?foray=" + encodeURIComponent(id) : "";
  url.hash = "#/foray/" + encodeURIComponent(id);
  /* The same address is a hash navigation to itself, which loads nothing: reload it instead. */
  if (url.href === page.url()) await page.reload({ waitUntil: "load" });
  else await page.goto(url.href, { waitUntil: "load" });
  await page.waitForFunction(
    () => Boolean(window.ForayPlayer) && Boolean(document.querySelector("#tab-bar .tab-btn")) && Boolean(document.querySelector(".fdet")),
    null,
    { timeout: 45000 }
  );
  await wait(page, 900);
}

/** Routes every seeded profile can show. `fx` supplies real ids. */
function coreRoutes(fx, { entities }) {
  const ep = fx.items[0].id;
  const show = fx.shows[0].show_id;
  /* The first PUBLISHED Foray, not the first in the file: that one is a draft, which the page
     (correctly) refuses without `?foray=`, so this step used to shoot "isn't available". */
  const published = fx.forays.find((f) => f.status === "published");
  const foray = published && published.id;
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
      description: "Brand-new profile: the Tactile onboarding screen over Home, then its returning mode (#/onboarding/return).",
      seed: "empty",
      steps: [
        { label: "intro-sheet", route: "#/", ready: "#first-time-sheet" },
        { label: "onboarding-return", route: "#/onboarding/return", ready: "#first-time-sheet" },
      ],
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
      steps: [
        ...coreRoutes(fx, { entities: true }),
        /* Yours, Shows (tactile `library-shows`, BUILD-PLAN 2.14): the Shows chip pressed, then the first tile's ⋯ open. */
        { label: "yours-shows", route: "#/library", run: (page) => openYoursShows(page) },
        { label: "yours-shows-actions", route: "#/library", run: (page) => openYoursShowActions(page) },
        /* Appended by Tactile `foray`: the Foray detail page beyond its fresh state. In progress
           (12:40 in, the prototype's Resume at 12:40), played to the end, a Foray with no
           narration (BR BR at 412 is this one), and one that is not there. */
        { label: "foray-progress", route: "#/foray/" + FORAY_NARRATED, run: (page) => openForayDetail(page, FORAY_NARRATED, { at: 760 }) },
        { label: "foray-done", route: "#/foray/" + FORAY_NARRATED, run: (page) => openForayDetail(page, FORAY_NARRATED, { at: "end" }) },
        { label: "foray-unnarrated", route: "#/foray/" + FORAY_UNNARRATED, run: (page) => openForayDetail(page, FORAY_UNNARRATED, { unlock: true }) },
        { label: "foray-unavailable", route: "#/foray/does-not-exist", run: (page) => openForayDetail(page, "does-not-exist") },
        /* Appended by Tactile `settings` (BUILD-PLAN 2.19): Today with the knob
           pressed and the Settings sheet up. */
        { label: "settings-sheet", route: "#/", run: (page) => openSettingsFromKnob(page) },
      ],
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
        { label: "now-playing-paused", route: "#/library", run: (page) => pausedForayNowPlaying(page), ready: '#foray-player .fp-play[aria-label="Play"]' },
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
        { label: "search-results-typing", route: "#/shows", run: (page) => typeSearchThenReturn(page, "geoengineering") },
        /* Appended by Tactile `search-none`: the settled no-results screen the way the
           prototype draws it (deck up, field above it). "instrument" finds no show and names
           one subject that holds four, so the sentence, its tile and the key all show;
           `search-no-results` keeps the no-subject case, with the field still focused. */
        { label: "search-no-results-subject", route: "#/shows", run: (page) => typeSearchThenReturn(page, "instrument") },
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
    {
      id: "loading",
      description: "Returning user, Today while the catalog document is still on the wire (held by page.route until the shot): the boot skeleton.",
      seed: "returning",
      steps: [{ label: "home-loading", route: "#/", before: holdCatalog, held: true, ready: ".skel" }],
    },
    {
      id: "resume-home",
      description: "Returning user with a part-played episode (25 of 60 min): Today shows the Resume card.",
      seed: "resuming",
      steps: [{ label: "home-resume", route: "#/", ready: ".today-resume" }],
    },
    {
      id: "offline",
      description: "Returning user with the radio off: Today and the Foray page with one episode on the device (live key, downloaded mark) and every other Play key blocked.",
      seed: "returning",
      steps: [
        { label: "home", route: "#/", ready: ".today .row-episode", run: (page) => goOffline(page) },
        ...(fx.forays[0] ? [{ label: "foray", route: "#/foray/" + encodeURIComponent(fx.forays[0].id) }] : []),
      ],
    },
  ];
}
