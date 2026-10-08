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
  const sheet = page.locator(".fp-sheet").first();
  if (await sheet.isVisible().catch(() => false)) {
    await wait(page, 200);
    return;
  }
  await page.locator(".fp-info").first().click();
  await page.waitForSelector(".fp-sheet", { state: "visible", timeout: 10000 });
  await wait(page, 700);
}

async function closeNowPlaying(page) {
  const close = page.locator(".fp-close");
  if (await close.first().isVisible().catch(() => false)) {
    await close.first().click().catch(() => {});
    await page.waitForSelector(".fp-sheet", { state: "hidden", timeout: 10000 }).catch(() => {});
  }
  await wait(page, 100);
}

async function resetAmbientNowPlaying(page) {
  await closeNowPlaying(page);
  await page.evaluate(() => {
    document.documentElement.classList.remove("ag-np-textscale");
    document.documentElement.style.removeProperty("font-size");
    const ui = window.__afterglowNowPlayingUi;
    ui?.artSwap?.classList.remove("is-frozen-ending");
    ui?.artSwap?.querySelector(".ag-np-art-out")?.remove();
    ui?.sArt?.classList.remove("ag-np-art-in");
  });
}

async function startForayPlayback(page) {
  await resetAmbientNowPlaying(page);
  await page.waitForSelector("#fy-play", { state: "visible", timeout: 20000 });
  await page.locator("#fy-play").click();
  await page.waitForFunction(() => Boolean(window.ForayPlayer?.forayStatus?.()), null, { timeout: 20000 });
  await page.evaluate(async () => {
    await window.ForayPlayer.foraySeek(21);
    if (!window.ForayPlayer.forayStatus()?.running) await window.ForayPlayer.forayToggle();
  });
  await openNowPlaying(page);
  await page.waitForSelector(".ag-np-strip-button", { state: "visible", timeout: 10000 });
}

async function startEpisodePlayback(page, itemId) {
  await resetAmbientNowPlaying(page);
  await startPlayback(page, itemId);
  await openNowPlaying(page);
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
  const foray0 = fx.forays.find((foray) => foray.status === "published")?.id || fx.forays[0]?.id;
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
      id: "ambient-now-playing",
      description: "Afterglow Now Playing: Foray, episode, paused, transition, detail, ending and large text.",
      seed: "returning",
      steps: [
        {
          label: "now-playing-foray",
          route: "#/foray/" + encodeURIComponent(foray0),
          run: (page) => startForayPlayback(page),
          ready: ".ag-np.is-foray",
        },
        {
          label: "now-playing-episode",
          route: "#/library",
          run: (page) => startEpisodePlayback(page, ep0),
          ready: ".ag-np:not(.is-foray)",
        },
        {
          label: "now-playing-paused",
          route: "#/library",
          run: async (page) => {
            await startEpisodePlayback(page, ep0);
            await page.evaluate(async () => {
              const status = window.ForayPlayer?.forayStatus?.();
              if (status?.running) await window.ForayPlayer.forayToggle();
              for (const audio of window.__audios || []) if (!audio.paused) audio.pause();
            });
            await wait(page, 300);
          },
          ready: ".ag-np.is-paused",
        },
        {
          label: "now-playing-segchange",
          route: "#/foray/" + encodeURIComponent(foray0),
          run: async (page) => {
            await startForayPlayback(page);
            await page.evaluate(async () => {
              await window.ForayPlayer.forayJump(1);
              const ui = window.__afterglowNowPlayingUi;
              const show = ui?.segmentsSection?.querySelectorAll(".ag-np-clip-row .t-caption")?.[1]?.textContent?.split(" \u00b7 ")?.[0] || "Next show";
              window.AfterglowNowPlaying?.flashCaption(ui, `Now: ${show}`, true);
              ui?.roomLayers?.forEach((layer) => layer.classList.add("is-on"));
              ui?.sShow?.classList.add("is-crossfading");
            });
            await wait(page, 120);
          },
          ready: ".ag-np-eyebrow.is-lit",
        },
        {
          label: "now-playing-detail",
          route: "#/foray/" + encodeURIComponent(foray0),
          run: async (page) => {
            await startForayPlayback(page);
            const detail = page.locator(".ag-np-detail");
            await detail.evaluate((node) => node.scrollIntoView({ block: "start" }));
            await wait(page, 300);
          },
          ready: ".ag-np-detail",
        },
        {
          label: "now-playing-ending",
          route: "#/library",
          run: async (page) => {
            await startEpisodePlayback(page, ep0);
            await page.evaluate(() => {
              const ui = window.__afterglowNowPlayingUi;
              const saved = Object.values(JSON.parse(localStorage.getItem("cp_saved") || "{}"));
              const next = saved.find((item) => item.id !== window.ForayPlayer?.currentEpisodeId?.() && item.artwork_url);
              if (!ui || !next) return;
              const previousSrc = ui.sArt.getAttribute("src") || next.artwork_url;
              ui.sArt.src = safeUrl(next.artwork_url);
              ui.sTitle.textContent = next.title || "Up next";
              ui.sShow.textContent = next.show || "";
              window.AfterglowNowPlaying.handoff(ui, previousSrc, next.artwork_url, { freeze: true });
            });
            await wait(page, 120);
          },
          ready: ".ag-np-art-swap.is-frozen-ending",
        },
        {
          label: "now-playing-textscale",
          route: "#/library",
          run: async (page) => {
            await startEpisodePlayback(page, ep0);
            await page.evaluate(() => {
              document.documentElement.classList.add("ag-np-textscale");
              document.documentElement.style.setProperty("font-size", "20.8px");
            });
            await wait(page, 300);
          },
          ready: ".ag-np",
        },
      ],
    },
  ];
}
