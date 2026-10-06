/* `#/episode/<id>?t=N` — the timestamp deep link (issue #30, WP10 UI section).
 *
 * WHAT THIS PROVES
 *  1. `?t=` parses on both spellings — `#/episode/<id>?t=N` (canonical) and
 *     `#/play/<id>?t=N` (issue #30's alias) — as whole seconds or a clock stamp,
 *     and the router hands the episode page the DECODED id and the offset, not
 *     `<id>?t=N` as an id.
 *  2. The alias is rewritten to the canonical address IN PLACE (replaceState,
 *     never pushState), so the link costs no extra history entry.
 *  3. A garbage `t` is ignored: the page renders as a plain episode page, and a
 *     target past the episode's known end draws no button.
 *  4. The "Play from" button is an ordinary `data-ts` control, so the EXISTING
 *     binder (bindEpisodeSeeks) starts it through startEpisodePlay with the
 *     stamp as the start offset (races-1: the seek-during-load path).
 *  5. Precision follows player/seek-policy.js `seekPrecision` for a FOREIGN
 *     stamp: a DAI stream reads "~1:07:30", a static enclosure or a downloaded
 *     file reads an exact "1:07:30". Since CH-1 (#1071) app.js reads the rule
 *     from the module itself (window.ForaySeekPolicy, `chapterPrecision`), so
 *     the harness loads the real module; with none loaded the link reads
 *     approximate (fail honest).
 *  6. Nothing plays on its own: rendering the page, cold or warm, starts no
 *     audio (WebView gesture rules; the shell's cp_last_route relaunch).
 *  7. A shared breadth episode cold-opens on a fresh device (SH-COLD): up to
 *     three pages of its show's list, matched on the show-page id, t= kept;
 *     a late answer repaints nothing; an id naming no servable show is not
 *     found with no request; a failure offers Try again.
 *
 * Dependency-free node:vm harness, the router.test.js shape (history that
 * reflects replaceState into location.hash) with test/episode-page.test.js's
 * episode seeding. Every test names the one-line mutation that kills it.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

process.on("unhandledRejection", () => {});

/* The real seek policy, as player/seek-policy.js publishes it to window. */
const seekPolicy = () => import(pathToFileURL(path.join(ROOT, "player", "seek-policy.js")).href);

function makeEl(tag) {
  return {
    tagName: String(tag || "div").toUpperCase(),
    id: null, className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    appendChild(k) { this.children.push(k); return k; },
    append(...k) { this.children.push(...k); },
    prepend(...k) { this.children.unshift(...k); },
    insertBefore(k) { this.children.push(k); return k; },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {}, hasAttribute: () => false,
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, select() {}, click() {}, remove() {},
  };
}

/* The page's `[data-ts]` controls, read back out of what the render wrote — so
   the binder under test binds the markup renderEpisode actually produced, not a
   hand-made button. One stub per control per paint, carrying its handlers. */
function tsControls(html) {
  const out = [];
  const re = /<button\b([^>]*)>([^<]*)<\/button>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const ts = /\bdata-ts="([^"]*)"/.exec(m[1]);
    if (!ts) continue;
    const handlers = [];
    out.push({
      attrs: m[1], text: m[2], dataset: { ts: ts[1] }, handlers,
      addEventListener(type, fn) { if (type === "click") handlers.push(fn); },
    });
  }
  return out;
}

function mount({ hash = "#/" } = {}) {
  const byId = new Map();
  const el = (id) => { if (!byId.has(id)) { const e = makeEl("div"); e.id = id; byId.set(id, e); } return byId.get(id); };
  const view = el("view");
  let painted = null;
  let controls = [];
  view.querySelectorAll = (sel) => {
    if (sel !== "[data-ts]") return [];
    if (painted !== view.innerHTML) { painted = view.innerHTML; controls = tsControls(painted); }
    return controls;
  };
  const body = makeEl("body");
  const store = new Map();
  const pushes = [];
  const replaces = [];
  const ctx = {
    console: { ...console, warn() {}, error() {}, info() {} },
    fetch: () => new Promise(() => {}),
    localStorage: {
      get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); },
    },
    sessionStorage: { getItem: () => null, setItem() {} },
    document: {
      body, documentElement: body, readyState: "complete", hidden: false,
      addEventListener() {}, createElement: (t) => makeEl(t),
      querySelector: (sel) => (/^#[\w-]+$/.test(String(sel)) ? el(String(sel).slice(1)) : null),
      querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" },
    addEventListener() {}, removeEventListener() {},
    location: { hash, search: "", pathname: "/", href: "https://x.test/" + hash },
    history: {
      state: null,
      replaceState(state, _t, url) {
        this.state = state;
        replaces.push(url);
        if (url !== undefined && url !== null) {
          const i = String(url).indexOf("#");
          ctx.location.hash = i >= 0 ? String(url).slice(i) : "";
        }
      },
      pushState(_s, _t, url) { pushes.push(url); },
      back() {},
    },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    requestAnimationFrame: (fn) => { const t = setTimeout(fn, 0); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
    scrollY: 0, innerHeight: 800,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
  };
  ctx.scrollTo = (_x, y) => { ctx.scrollY = y; };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });
  const evalIn = (src) => vm.runInContext(src, ctx);
  evalIn(`state.ready = true;
    state.session = { session_id: 's', episodes: {}, cards: [], commute: {} };
    state.discover = { items: [] }; state.catalog = { shows: [] }; state.taxonomy = { nodes: [] };`);
  return { ctx, evalIn, view, pushes, replaces };
}

/* A static-enclosure episode an hour and a half long, and its stitched twin. */
const STATIC = { id: "ep-1", title: "Static Episode", show: "A Show", audio_url: "https://x.test/1.mp3", duration_sec: 5400, dai_suspected: false, topics: ["science"] };
const STITCHED = { id: "ep-dai", title: "Stitched Episode", show: "B Show", audio_url: "https://x.test/2.mp3", duration_sec: 5400, dai_suspected: true, topics: ["science"] };

function seed(m, ...items) {
  for (const it of items) m.evalIn(`state.itemIndex[${JSON.stringify(it.id)}] = ${JSON.stringify(it)};`);
}

/** A ForayPlayer that records every way audio could start. */
function recordingPlayer() {
  const rec = { plays: [], seeks: [], toggles: 0 };
  rec.api = {
    canPlay: () => true,
    isPlaying: () => false,
    isCurrent: () => false,
    play: async (item, opts) => { rec.plays.push({ id: item.id, opts }); return true; },
    seekTo: async (s) => { rec.seeks.push(s); },
    togglePlayback: async () => { rec.toggles += 1; },
    reportPlayFailure: () => {},
  };
  return rec;
}

const ticks = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/* ==================================================================== */
/* 1. ?t= PARSES ON BOTH ROUTES                                          */
/* ==================================================================== */

test("?t= parses on #/episode/ and on the #/play/ alias, as seconds or a clock stamp", () => {
  /* MUTATION: narrow EPISODE_DEEPLINK_RE's alternation to `(episode)` — every
     #/play/ case below parses to null; red. MUTATION 2: drop the
     `kind === "episode" && query === undefined` guard — a plain #/episode/<id>
     is no longer the router's ordinary route (null expected); red. */
  const m = mount();
  const parse = (h) => JSON.parse(JSON.stringify(m.ctx.episodeDeepLink(h)));
  assert.deepStrictEqual(parse("#/episode/ep-1?t=4050"), { seg: "ep-1", t: 4050 });
  assert.deepStrictEqual(parse("#/play/ep-1?t=4050"), { seg: "ep-1", t: 4050 });
  assert.deepStrictEqual(parse("#/play/ep-1?t=1:07:30"), { seg: "ep-1", t: 4050 }, "a clock stamp is the same offset");
  assert.deepStrictEqual(parse("#/play/ep-1?t=4050.9"), { seg: "ep-1", t: 4050 }, "fractional seconds floor");
  assert.deepStrictEqual(parse("#/play/ep-1?x=1&t=90"), { seg: "ep-1", t: 90 }, "t among other params");
  assert.deepStrictEqual(parse("#/play/ep-1"), { seg: "ep-1", t: null }, "the alias with no t is still the alias");
  assert.deepStrictEqual(parse("#/episode/show--https%3A%2F%2Fx.test%2F%3Fp%3D1?t=5"), { seg: "show--https%3A%2F%2Fx.test%2F%3Fp%3D1", t: 5 },
    "an encoded `?` inside the id is the id's; the raw `?` starts the query");
  assert.strictEqual(m.ctx.episodeDeepLink("#/episode/ep-1"), null, "a plain episode route is not a deep link");
  assert.strictEqual(m.ctx.episodeDeepLink("#/playlist/ep-1?t=5"), null, "#/playlist/ is not #/play/");
  assert.strictEqual(m.ctx.episodeDeepLink("#/playlists"), null);
});

test("the router hands renderEpisode the decoded id and the offset, on both spellings", () => {
  /* MUTATION: delete the `episodeDeepLink(h)` line in renderCurrentPage — the
     old `#/episode/(.+)` line reads `ep/1?t=4050` as the id; red. */
  const m = mount();
  const seen = [];
  m.ctx.renderEpisode = (id, opts) => { seen.push([id, opts ? opts.t : undefined]); };
  m.ctx.renderTabBar = () => {};
  for (const h of ["#/episode/ep%2F1?t=4050", "#/play/ep-1?t=90", "#/episode/ep-1", "#/episode/ep-1?t=nope"]) {
    m.ctx.location.hash = h;
    m.evalIn("renderCurrentPage()");
  }
  /* The last: currentHash() canonicalizes a garbage t away, so it is the plain
     episode route — with the id `ep-1`, not `ep-1?t=nope`. */
  assert.deepStrictEqual(seen, [["ep/1", 4050], ["ep-1", 90], ["ep-1", undefined], ["ep-1", undefined]]);
});

/* ==================================================================== */
/* 2. THE ALIAS NORMALIZES IN PLACE                                      */
/* ==================================================================== */

test("#/play/<id>?t=N is rewritten to #/episode/<id>?t=N in place — replaceState, no new history entry", () => {
  /* MUTATION: delete the `replaceHash(h)` line at the top of route() — the
     address keeps the alias spelling; red. (A `location.hash = h` there instead
     would push an entry in a browser; this harness's pushState count is the
     stand-in for that.) */
  const m = mount({ hash: "#/play/ep-1?t=4050" });
  seed(m, STATIC);
  m.evalIn("route()");
  assert.strictEqual(m.ctx.location.hash, "#/episode/ep-1?t=4050");
  assert.ok(m.replaces.some((u) => String(u).endsWith("#/episode/ep-1?t=4050")), "written with replaceState");
  assert.deepStrictEqual(m.pushes, [], "no history entry is added");
  assert.match(m.view.innerHTML, /Static Episode/, "and the episode page is what rendered");

  /* A garbage t is dropped from the canonical spelling too. */
  m.ctx.location.hash = "#/episode/ep-1?t=soon";
  m.evalIn("route()");
  assert.strictEqual(m.ctx.location.hash, "#/episode/ep-1");
});

/* ==================================================================== */
/* 3. GARBAGE IS IGNORED; PAST THE END DOES NOT BREAK THE PAGE           */
/* ==================================================================== */

test("an invalid t is ignored and the page renders with no Play-from button", () => {
  /* MUTATION: loosen deepLinkOffset's seconds pattern to `/^[\d.e+-]+$/` —
     `1e3` parses as 1000 and `-5` reaches the guard; red on `1e3`.
     MUTATION 2: delete playFromHtml's whole first guard line (the
     null/undefined/isSafeInteger/negative check) — t=null slips past
     `null > dur`, fmtChapterTime(null) is "0:00" and a `data-ts="null"`
     "Play from 0:00" button renders; red. (Dropping only `t === null ||`
     is NOT a kill: Number.isSafeInteger(null) is false, so it still bails.) */
  const m = mount();
  for (const raw of ["", "abc", "-5", "1e3", "Infinity", "NaN", "%", "99:99", "1:2:3:4", "0x10"]) {
    assert.strictEqual(m.ctx.deepLinkOffset(`t=${raw}`), null, `t=${raw} must be ignored`);
  }
  assert.strictEqual(m.ctx.deepLinkOffset("t=0"), 0, "zero is a real offset");
  seed(m, STATIC);
  m.ctx.renderEpisode("ep-1", { t: null });
  assert.match(m.view.innerHTML, /Static Episode/);
  assert.doesNotMatch(m.view.innerHTML, /ep-play-from/, "no target, no button");
});

test("a target past the episode's known end keeps the page and draws no button", () => {
  /* MUTATION: delete `if (dur !== null && t > dur) return "";` in playFromHtml —
     a "Play from 2:46:40" button renders on a 90-minute episode; red. */
  const m = mount();
  seed(m, STATIC);
  assert.doesNotThrow(() => m.ctx.renderEpisode("ep-1", { t: 10000 }));
  const html = m.view.innerHTML;
  assert.match(html, /Static Episode/, "the page still renders");
  assert.match(html, /class="play-btn"/, "with its ordinary ▶");
  assert.doesNotMatch(html, /ep-play-from/, "and no button promising a second that does not exist");
  m.ctx.renderEpisode("ep-1", { t: 5400 });
  assert.match(m.view.innerHTML, /data-ts="5400"/, "the last second is still a target");
});

/* ==================================================================== */
/* 4. THE BUTTON IS THE EXISTING BINDER'S                                */
/* ==================================================================== */

test("the Play-from button is a data-ts control: the existing binder starts it through startEpisodePlay at the offset", async () => {
  /* MUTATION: spell the button's attribute `data-at` instead of `data-ts` in
     playFromHtml — bindEpisodeSeeks never sees it, nothing plays; red. */
  const m = mount();
  seed(m, STATIC);
  const rec = recordingPlayer();
  m.ctx.ForayPlayer = rec.api;
  m.ctx.renderEpisode("ep-1", { t: 4050 });
  const btn = m.view.querySelectorAll("[data-ts]").find((c) => /ep-play-from-btn/.test(c.attrs));
  assert.ok(btn, "the page carries a Play-from data-ts control");
  assert.strictEqual(btn.handlers.length, 1, "bound once, by the page's own binder");
  await btn.handlers[0]({ preventDefault() {}, stopPropagation() {} });
  assert.strictEqual(rec.plays.length, 1, "a tap starts the episode");
  assert.strictEqual(rec.plays[0].id, "ep-1");
  assert.strictEqual(rec.plays[0].opts.startOffset, 4050, "with the stamp as the START offset (races-1), not a seek after");
  assert.deepStrictEqual(rec.seeks, [], "no second seek path");
  assert.deepStrictEqual(Array.from(m.evalIn("state.playList")), ["ep-1"], "startEpisodePlay's one-episode list");
});

/* ==================================================================== */
/* 5. PRECISION                                                          */
/* ==================================================================== */

test("a stitched (dai_suspected) stream reads ~<stamp>, and 'about' to a screen reader", async () => {
  /* MUTATION: make deepLinkPrecise `return true` unconditionally — the tilde
     goes and a moved timeline is claimed to the second; red. */
  const m = mount();
  m.ctx.ForaySeekPolicy = await seekPolicy();
  seed(m, STITCHED);
  m.ctx.renderEpisode("ep-dai", { t: 4050 });
  const btn = m.view.querySelectorAll("[data-ts]").find((c) => /ep-play-from-btn/.test(c.attrs));
  assert.ok(btn);
  assert.strictEqual(btn.text, "Play from ~1:07:30");
  assert.match(btn.attrs, /aria-label="Play from about 1:07:30"/);
  assert.match(btn.attrs, /is-approximate/);
  assert.strictEqual(btn.dataset.ts, "4050", "the offset itself is unchanged; only the claim is softened");
});

test("a static enclosure reads an exact stamp, and so does a stitched episode the listener downloaded", async () => {
  /* MUTATION: prefix every stamp with `~` (`const shown = \`~${stamp}\``) —
     the static enclosure is called approximate; red. MUTATION 2: drop the
     download check (`isLocalFile: false` in chapterPrecision) — a downloaded
     file's frozen timeline still reads "~"; red. */
  const m = mount();
  m.ctx.ForaySeekPolicy = await seekPolicy();
  seed(m, STATIC, STITCHED);
  m.ctx.renderEpisode("ep-1", { t: 4050 });
  let btn = m.view.querySelectorAll("[data-ts]").find((c) => /ep-play-from-btn/.test(c.attrs));
  assert.strictEqual(btn.text, "Play from 1:07:30");
  assert.match(btn.attrs, /aria-label="Play from 1:07:30"/);
  assert.doesNotMatch(btn.attrs, /is-approximate/);

  /* The real normaliser, as the player module publishes it. */
  const store = await import(pathToFileURL(path.join(ROOT, "player", "download-store.js")).href);
  /* PQ-19's own decision (playSource): on iOS a `done` record plays from its
     file. On "web" with no webSrc the same record STREAMS, so it stays "~". */
  m.ctx.forayDownloads = { store, platform: "web", recordFor: (id) => m.ctx.downloadsValue().items[id] || null };
  m.ctx.lsSet("cp_downloads", { items: { "ep-dai": { status: "done", path: "file:///d/ep-dai.mp3", bytes: 1, total: 1 } } });
  m.ctx.renderEpisode("ep-dai", { t: 4050 });
  btn = m.view.querySelectorAll("[data-ts]").find((c) => /ep-play-from-btn/.test(c.attrs));
  assert.strictEqual(btn.text, "Play from ~1:07:30", "a record that will not play from the file is not exact");
  m.ctx.forayDownloads.platform = "ios";
  m.ctx.renderEpisode("ep-dai", { t: 4050 });
  btn = m.view.querySelectorAll("[data-ts]").find((c) => /ep-play-from-btn/.test(c.attrs));
  assert.strictEqual(btn.text, "Play from 1:07:30", "a local file is exact (seekPrecision rung 1)");
});

/* ==================================================================== */
/* 6. NO AUTOPLAY                                                        */
/* ==================================================================== */

test("an unclassified show, or no seek policy loaded yet, reads approximate: never exact by default", async () => {
  /* CH-1 (#1071): the one rule is chapterPrecision.
     MUTATION: in chapterPrecision's catch, `return "exact"` — with no policy
     loaded the static enclosure claims "1:07:30"; red on the first assert.
     MUTATION 2: drop `|| item?.dai_known === false` — the unclassified
     episode reads exact; red on the second. */
  const m = mount();
  seed(m, STATIC, { ...STATIC, id: "ep-unk", dai_known: false });
  m.ctx.renderEpisode("ep-1", { t: 4050 });
  let btn = m.view.querySelectorAll("[data-ts]").find((c) => /ep-play-from-btn/.test(c.attrs));
  assert.strictEqual(btn.text, "Play from ~1:07:30", "no policy: approximate");
  m.ctx.ForaySeekPolicy = await seekPolicy();
  m.ctx.renderEpisode("ep-unk", { t: 4050 });
  btn = m.view.querySelectorAll("[data-ts]").find((c) => /ep-play-from-btn/.test(c.attrs));
  assert.strictEqual(btn.text, "Play from ~1:07:30", "unclassified: approximate");
});

test("nothing plays on its own: a cold #/play/ link and a direct render start no audio", async () => {
  /* MUTATION: append `if (t !== null) startEpisodePlay(item.id, item, { ctx: null, list: [], startOffset: t });`
     to renderEpisode — the link plays on arrival; red. */
  const m = mount({ hash: "#/play/ep-1?t=4050" });
  m.ctx.ForaySeekPolicy = await seekPolicy();
  seed(m, STATIC);
  const rec = recordingPlayer();
  m.ctx.ForayPlayer = rec.api;
  m.evalIn("route()");
  m.ctx.renderEpisode("ep-1", { t: 4050 });
  await ticks();
  assert.match(m.view.innerHTML, /Play from 1:07:30/, "the button is there to be pressed");
  assert.deepStrictEqual(rec.plays, [], "no play");
  assert.deepStrictEqual(rec.seeks, [], "no seek");
  assert.strictEqual(rec.toggles, 0, "no toggle");
});

/* ==================================================================== */
/* 7. A SHARED BREADTH EPISODE COLD-OPENS (SH-COLD)                      */
/* ==================================================================== */

/* api/shows/<id>/episodes as a fake: `pages` episode lists, each page's
   next_cursor naming the next one ("c1", "c2", ...), the last none. `hold`
   parks every answer until release(), so a test can move the page first.
   `fail` answers a 500. Every request is recorded. */
function episodesEndpoint(m, pages, { hold = false, fail = false } = {}) {
  const calls = [];
  const parked = [];
  m.ctx.fetch = (url) => {
    const u = String(url);
    calls.push(u);
    const cur = /[?&]cursor=([^&]+)/.exec(u);
    const i = cur ? Number(decodeURIComponent(cur[1]).slice(1)) : 0;
    const body = {
      show: { title: "Founders", description: null, image: "https://x.test/founders.png" },
      episodes: pages[i] || [],
      next_cursor: i + 1 < pages.length ? "c" + (i + 1) : null,
    };
    const answer = fail ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, status: 200, json: async () => body };
    if (!hold) return Promise.resolve(answer);
    return new Promise((resolve) => parked.push(() => resolve(answer)));
  };
  return { calls, release: () => { while (parked.length) parked.shift()(); } };
}

const feedEp = (n) => ({ guid: "g-" + n, title: "Feed episode " + n, audio_url: `https://x.test/f${n}.mp3`, duration_seconds: 3600, published_at: "2026-09-01" });
const feedPage = (from) => Array.from({ length: 100 }, (_, k) => feedEp(from + k));

test("a shared breadth episode cold-opens from page 2 of its show's list, playable, with its t= intact", async () => {
  /* MUTATION: `const COLD_EPISODE_PAGES = 1` -> page 2 is never asked and the
     page says "Episode not found."; red. MUTATION 2: render the hit with
     `renderEpisode(id)` (dropping `{ t }`) -> no Play-from button; red.
     MUTATION 3: drop the resolveMissingEpisode call from renderEpisode's
     not-found branch (paint "Episode not found." there) -> no request; red. */
  const m = mount({ hash: "#/episode/founders--g-150?t=90" });
  const api = episodesEndpoint(m, [feedPage(0), feedPage(100)]);
  m.evalIn("route()");
  assert.match(m.view.innerHTML, /Loading episode…/, "never a blank page while it looks");
  await ticks(30);
  assert.strictEqual(api.calls.length, 2);
  assert.match(api.calls[1], /\/api\/shows\/founders\/episodes\?cursor=c1$/);
  assert.match(m.view.innerHTML, /Feed episode 150/);
  assert.match(m.view.innerHTML, /data-ts="90"/, "the timestamp link's button survived the cold path");
  assert.match(m.view.innerHTML, /class="play-btn"/, "and it plays");
  const item = m.evalIn('state.itemIndex["founders--g-150"]');
  assert.strictEqual(item.audio_url, "https://x.test/f150.mp3");
  assert.strictEqual(item.show_id, "founders");
  assert.strictEqual(item.artwork_url, "https://x.test/founders.png", "the show header's art, as a show page would carry it");
  assert.strictEqual(m.ctx.location.hash, "#/episode/founders--g-150?t=90");
});

test("the cold lookup stops after 3 pages: not found, with a link to the show", async () => {
  /* MUTATION: loop `page < 10` instead of COLD_EPISODE_PAGES -> 10 requests; red. */
  const m = mount({ hash: "#/episode/founders--g-9999" });
  const api = episodesEndpoint(m, Array.from({ length: 10 }, (_, p) => feedPage(p * 100)));
  m.evalIn("route()");
  await ticks(40);
  assert.strictEqual(api.calls.length, 3);
  assert.match(m.view.innerHTML, /Episode not found\./);
  assert.match(m.view.innerHTML, /href="#\/show\/founders"/, "the way on is the show page");
});

test("a late answer never repaints a page re-rendered since (the render token)", async () => {
  /* The same route, repainted with the episode now resolvable (a ↻ or a
     settings switch after another surface seeded it), and the stale lookup
     then fails. MUTATION: drop `isCurrentRender() &&` from stillHere -> the
     failure paints "Couldn't load" over the real page; red. */
  const m = mount({ hash: "#/episode/founders--g-5" });
  const api = episodesEndpoint(m, [feedPage(0)], { hold: true, fail: true });
  m.evalIn("route()");
  assert.match(m.view.innerHTML, /Loading episode…/);
  seed(m, { ...STATIC, id: "founders--g-5", title: "Seeded since" });
  m.evalIn("renderCurrentPage()");
  assert.match(m.view.innerHTML, /Seeded since/);
  api.release();
  await ticks(30);
  assert.match(m.view.innerHTML, /Seeded since/, "the stale answer was dropped");
  assert.doesNotMatch(m.view.innerHTML, /Couldn't load/);
});

test("a late answer never repaints another route (the route check)", async () => {
  /* A render outside the router does not move the token, so the route is the
     guard. MUTATION: drop `&& currentHash() === askedOn` -> the episode paints
     over the other page; red. */
  const m = mount({ hash: "#/episode/founders--g-5" });
  const api = episodesEndpoint(m, [feedPage(0)], { hold: true });
  m.ctx.renderEpisode("founders--g-5");
  m.ctx.location.hash = "#/library";
  m.view.innerHTML = "OTHER PAGE";
  api.release();
  await ticks(30);
  assert.strictEqual(api.calls.length, 1, "the lookup did run");
  assert.strictEqual(m.view.innerHTML, "OTHER PAGE");
});

test("an id that names no servable show is not found at once, with no request", async () => {
  /* MUTATION: drop `!guid ||` -> `founders--` asks the endpoint; red.
     MUTATION 2: drop `|| show_id.startsWith("pi:")` -> the pi: id asks an
     endpoint that does not serve it; red. */
  const m = mount();
  const api = episodesEndpoint(m, [feedPage(0)]);
  for (const id of ["solo", "--g-1", "founders--", "pi:77--g-1", "apple:founders"]) {
    m.ctx.renderEpisode(id);
    assert.match(m.view.innerHTML, /Episode not found\./, id);
    assert.doesNotMatch(m.view.innerHTML, /Loading/, id);
  }
  await ticks(10);
  assert.deepStrictEqual(api.calls, []);
});

test("a failed lookup says so with Try again, which runs the same lookup", async () => {
  /* MUTATION: paint the failure without `retry` / bindRetry -> no data-retry
     control is wired; red. */
  const m = mount({ hash: "#/episode/founders--g-7?t=30" });
  const api = episodesEndpoint(m, [feedPage(0)], { fail: true });
  let retry = null;
  m.view.querySelector = (sel) => (sel === "[data-retry]" && /data-retry/.test(m.view.innerHTML)
    ? { addEventListener: (type, fn) => { if (type === "click") retry = fn; } } : null);
  m.evalIn("route()");
  await ticks(20);
  assert.match(m.view.innerHTML, /Couldn't load this episode\./);
  assert.ok(retry, "Try again is wired");
  episodesEndpoint(m, [feedPage(0)]);
  retry({ preventDefault() {} });
  await ticks(20);
  assert.match(m.view.innerHTML, /Feed episode 7/);
  assert.match(m.view.innerHTML, /data-ts="30"/, "and the retry kept t=");
  assert.strictEqual(api.calls.length, 1);
});

test("the apple:<show>:<guid> spelling of an episode cold-opens under the id it was shared by", async () => {
  /* MUTATION: drop `if (row.id !== id) snapshot(id, row)` -> the hit is
     indexed only as founders--g-3 and the shared id is "not found"; red. */
  const m = mount({ hash: "#/episode/" + encodeURIComponent("apple:founders:g-3") });
  episodesEndpoint(m, [feedPage(0)]);
  m.evalIn("route()");
  await ticks(20);
  assert.match(m.view.innerHTML, /Feed episode 3/);
  assert.strictEqual(m.evalIn('state.itemIndex["apple:founders:g-3"]').audio_url, "https://x.test/f3.mp3");
});
