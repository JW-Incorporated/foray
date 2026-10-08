/* Redesign 2026, ambient direction: the Playlist detail (#/playlist/<id>) and the Playlists list (#/playlists).
 *
 * WHAT THIS PROVES, in the order the pages read (docs/redesign-2026/directions/ambient/BUILD-NOTES.md 3 and 4.1):
 *   1. The stylesheet is wired into the page and every shipping path; it is scoped under `.ag`, loads nothing and owns no
 *      reduced-motion block; the Playlists grid is 2-up at the tile widths the notes name (164 at 393, 176 at 412).
 *   2. The detail page, rendered by the REAL app.js: the composite cover (120, a Collage that never crops a square), the
 *      name, "<n> episodes, <h> hr <m> min", "3 of 6 played" in Ember once one has finished, the episodes as EpisodeRows,
 *      the Next marker, the Glow.
 *   3. The Playlists list: the tiles, their length and played lines, the day last played when no episode has finished.
 *   4. The two empty pages: not found, and no playlists. One line, one button, copy that passes the rules.
 *   5. Behaviour: a row's Play starts the PLAYLIST (its ctx, its rows as the continuous-play list, last_played_at), the hero
 *      Play pauses what is playing or starts the next part, the page repaints from the player.
 *
 * Every test names the one-line mutation that turns it red; each was run red before being run green (the table is in
 * the PR description and in PROGRESS.md). The floor for this suite lives in test/suite-integrity.test.js.
 *
 * Harness: the REAL app.js (and ui/*.js) in a node:vm over the shared small DOM (test/helpers/fake-dom.js), which parses
 * innerHTML, so a handler is found in the markup the page wrote and driven, not assumed. The player is a stub that answers
 * only what the pages ask of it, in the shapes the real one does (episodeProgress, isPlaying, isCurrent, play).
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { readAppSource, runAppSource } = require("./helpers/app-source.js");
const { El } = require("./helpers/fake-dom.js");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const APP_SRC = readAppSource();
const SEARCH_SRC = read("search-engine.js");
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, " ");
const CSS = stripComments(read("ui/playlist.css"));
const TOKENS = stripComments(read("ui/tokens.css"));

process.on("unhandledRejection", () => {});

/* ---------- reading a stylesheet ---------- */

/** The declarations of the rule whose selector list is exactly `sel` (outside any @media), as { prop: value }. */
function decls(css, sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|[};])\\s*${esc}\\s*\\{([^{}]*)\\}`).exec(css);
  if (!m) return null;
  const out = {};
  for (const d of m[1].split(";")) {
    const c = d.indexOf(":");
    if (c > 0) out[d.slice(0, c).trim()] = d.slice(c + 1).trim();
  }
  return out;
}
const px = (v) => { const m = /^(-?\d+(?:\.\d+)?)px$/.exec(String(v || "").trim()); return m ? Number(m[1]) : null; };

/* ---------- 1. wiring and the stylesheet ---------- */

test("the stylesheet is wired into the page and every shipping path", async () => {
  /* MUTATION: remove "ui/playlist.css" from SHELL in tools/web/prepare-dist.mjs (or tools/ci/generate-manifest.mjs, or
     SHELL_FILES in tools/mobile/prepare-webdir.mjs), or drop the <link> from index.html -> red, naming the path. A stylesheet
     that ships to the page but not into the generation is the one file sw.js could not verify. */
  const html = read("index.html");
  const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
  assert.ok(links.includes("ui/playlist.css") && links.indexOf("ui/playlist.css") > links.indexOf("ui/primitives.css"),
    "linked after the primitives it reads");
  assert.ok(links.indexOf("ui/playlist.css") > links.indexOf("ui/today.css"), "and after Today's, whose .td-row it reuses");
  const shell = (rel, re) => { const m = re.exec(read(rel)); assert.ok(m, `${rel}: shell list found`); return m[1]; };
  assert.match(shell("tools/ci/generate-manifest.mjs", /const SHELL = \[([\s\S]*?)\n\];/), /"ui\/playlist\.css"/, "generate-manifest SHELL");
  assert.match(shell("tools/web/prepare-dist.mjs", /const SHELL = \[([\s\S]*?)\n\];/), /"ui\/playlist\.css"/, "prepare-dist SHELL");
  const { pathToFileURL } = require("node:url");
  const pw = await import(pathToFileURL(path.join(ROOT, "tools", "mobile", "prepare-webdir.mjs")).href);
  assert.ok(pw.SHELL_FILES.includes("ui/playlist.css"), "prepare-webdir SHELL_FILES");
  assert.ok(pw.buildPlan(ROOT).includes("ui/playlist.css"), "the app bundle's copy plan carries it");
});

test("the stylesheet is scoped under .ag, loads nothing and owns no reduced-motion block", () => {
  /* The page cannot restyle any other screen, and a second reduced-motion block would be a second owner (ui/tokens.css has
     the one, scoped to .ag).
     MUTATION: add a bare `.pl-tile { … }` rule -> red. MUTATION 2: add `@media (prefers-reduced-motion: reduce)` -> red.
     MUTATION 3: add an @import or a url(...) -> red. MUTATION 4: add `!important` -> red. */
  const flat = CSS.replace(/@(?:media|supports)[^{]*\{/g, "{");
  const heads = [...flat.matchAll(/(?:^|[}])\s*([^{}@][^{}]*)\{/g)].map((m) => m[1].trim()).filter(Boolean);
  const splitList = (list) => { const out = []; let depth = 0, cur = ""; for (const ch of list) { if (ch === "(") depth++; if (ch === ")") depth--; if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch; } out.push(cur.trim()); return out; };
  for (const list of heads) {
    for (const sel of splitList(list)) {
      assert.ok(/^(\.ag\b|body\.view-playlist\b)/.test(sel), `unscoped selector: ${sel}`);
    }
  }
  assert.ok(heads.length >= 20, `fixture assumption: the sheet has its rules (${heads.length})`);
  assert.doesNotMatch(CSS, /prefers-reduced-motion/, "the one block is tokens.css's");
  assert.doesNotMatch(CSS, /@import|url\(/, "no font, no image, no origin");
  assert.doesNotMatch(CSS, /!important/, "nothing wins by force");
  /* Every class the sheet defines is a new `pl-` name (or the primitives' own, which it never restyles). */
  const classes = new Set([...CSS.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]));
  /* The only names that are not `pl-*`: the scope, the body class the page sets, the legacy top bar it hides, and the
     primitives and legacy note it places things inside (never restyled: the rules that name them set position and margin). */
  const allowed = new Set(["ag", "view-playlist", "topbar", "note", "on", "ag-btn", "ag-empty", "ag-collage", "ag-progress-copy", "td-row-title", "td-row-why"]);
  for (const c of classes) assert.ok(/^(pl-|is-)/.test(c) || allowed.has(c), `class .${c} is not a new pl- name`);
  assert.ok([...classes].filter((c) => /^pl-/.test(c)).length >= 15, "fixture assumption: the sheet defines its own classes");
  /* And no pl- class the page emits is one styles.css already styles: the first build named the row `pl-row`, which styles.css
     draws as the legacy dark playlist row, so every row on Dawn was a dark slab with dark text. The only exceptions are the
     keep control's own legacy names (`pl-save*`), which the app's markup (savePlaylistControlHtml) emits and this sheet restyles.
     MUTATION: rename `pl-ep` back to `pl-row` in ui/playlist.js -> red. */
  const legacy = new Set([...stripComments(read("styles.css")).matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]));
  const emitted = new Set([...read("ui/playlist.js").matchAll(/class="([^"$]*)/g)].flatMap((m) => m[1].split(/\s+/)).filter((c) => /^pl-/.test(c)));
  assert.ok(emitted.size >= 15, `fixture assumption: the page emits its pl- classes (${emitted.size})`);
  for (const c of emitted) assert.ok(!legacy.has(c), `class .${c} is already a styles.css selector`);
});

test("the Playlists grid is two equal columns, and the tiles come out at the widths the notes name", () => {
  /* BUILD-NOTES 3, PlaylistTile: "2-up", 164 wide at 393, 176 at 412. The width is the arithmetic of the page: the screen minus
     two gutters (20 from 393, 16 below: tokens.css) minus the column gap, over two. Gap 20 gives 166.5 and 176.
     MUTATION: `gap: var(--s-8)` -> 160.5 at 393, red. MUTATION 2: `repeat(3, …)` -> red. MUTATION 3: `1fr` for `minmax(0, 1fr)`
     -> red (a long name would push a column wider than its half). */
  const grid = decls(CSS, ".ag .pl-grid");
  assert.ok(grid, "the grid rule exists");
  assert.strictEqual(grid.display, "grid");
  assert.strictEqual(grid["grid-template-columns"], "repeat(2, minmax(0, 1fr))");
  const token = (name) => px(decls(TOKENS, ":root")[name]);
  const gap = token(/^var\((--s-\d+)\)$/.exec(grid.gap)[1]);
  const gutterAt = (vw) => (vw >= 393 ? 20 : 16);
  assert.strictEqual(token("--ag-gutter"), 16, "fixture assumption: the base gutter");
  assert.match(TOKENS, /@media \(min-width: 393px\) \{ :root \{ --ag-gutter: 20px; \} \}/, "fixture assumption: 20 from 393");
  const tile = (vw) => (vw - 2 * gutterAt(vw) - gap) / 2;
  assert.ok(Math.abs(tile(393) - 164) <= 3, `393 -> ${tile(393)}`);
  assert.ok(Math.abs(tile(412) - 176) <= 3, `412 -> ${tile(412)}`);
});

/* ---------- the harness ---------- */

function mount(hash = "#/playlists") {
  const body = new El("body");
  const view = new El("main"); view.id = "view"; body.appendChild(view);
  for (const id of ["drawer", "drawer-overlay", "menu-btn", "refresh-btn"]) {
    const e = new El("div"); e.id = id; body.appendChild(e);
  }
  const store = new Map();
  const eventLog = {
    rows: [], append(row) { this.rows.push(row); }, async unsynced() { return this.rows; }, async markSynced() {}, async pruneToRetention() {},
    health() { return { ok: true, backend: "memory", pending: 0, ringSize: this.rows.length, faults: [] }; },
  };
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: () => new Promise(() => {}),
    localStorage: {
      get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); },
    },
    forayEventLog: eventLog,
    document: {
      body, documentElement: body, readyState: "complete", hidden: false,
      addEventListener() {}, removeEventListener() {}, createElement: (t) => new El(t),
      querySelector: (s) => {
        const str = String(s).trim();
        if (str === "#view") return view;
        if (str.startsWith("#view ")) return view.querySelector(str.slice(6));
        return body.querySelector(str);
      },
      querySelectorAll: (s) => body.querySelectorAll(s),
    },
    navigator: { userAgent: "node", onLine: true },
    addEventListener() {}, removeEventListener() {},
    location: { hash, search: "", pathname: "/", href: "https://x.test/", protocol: "https:", reload() {} },
    history: { replaceState() {}, pushState() {}, back() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout, queueMicrotask,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  runAppSource(APP_SRC, ctx);
  const state = vm.runInContext("state", ctx);
  state.ready = true;
  return { ctx, state, view, store, html: () => view.innerHTML, run: (js) => vm.runInContext(js, ctx) };
}

function item(n, over = {}) {
  return {
    id: `show-${n}--ep-${n}`, show: `Show ${n}`, title: `Episode ${n}`, duration_min: 20, duration_sec: 1200,
    artwork_url: `https://art.test/${n}.jpg`, audio_url: `https://audio.test/${n}.mp3`, release_date: "2026-05-01",
    topics: [], hook: `Why episode ${n} matters.`, ...over,
  };
}

/** A mounted app holding `lists` ({ id, title, items }) over a pool of `items`, with a player stub. */
function world({ items, lists, progress = {}, playing = null, hash } = {}) {
  const m = mount(hash);
  m.state.session = { session_id: "s", builder: "t", episodes: {}, cards: [] };
  m.state.discover = { items };
  m.state.taxonomy = { nodes: [] };
  m.state.itemIndex = {};
  m.state.poolIds = new Set();
  m.ctx.fullPool();
  m.ctx.savePlaylists(lists.map((l) => ({
    id: l.id, title: l.title, items: (l.parts || l.items).map((it) => m.ctx.playlistPart(it)),
    created: "2026-08-18T00:00:00.000Z", last_played_at: l.last_played_at ?? null, sparse: false,
  })));
  const calls = { play: [], toggle: 0 };
  const player = {
    episodeProgress: (id) => progress[id] || { state: "unplayed", percent: null, label: null },
    isPlaying: (id) => playing === id,
    /* The real player answers isCurrent for the item it has just been given, so a play that completed reads as current. */
    isCurrent: (id) => playing === id || calls.play[calls.play.length - 1] === id,
    play: async (it) => { calls.play.push(it.id); return true; },
    togglePlayback: async () => { calls.toggle++; },
    reportPlayFailure() {},
  };
  m.ctx.window.ForayPlayer = player;
  return { ...m, calls, player };
}

const FOUR = [1, 2, 3, 4].map((n) => item(n));
const text = (html) => html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
const one = (html, re) => (re.exec(html) || [])[1] || "";
const DONE = { state: "played", percent: 100, label: "Played" };

/* ---------- 2. the detail page ---------- */

test("the cover is a 120 Collage of the playlist's distinct artworks: one is the art, two or three overlap whole squares, four are a 2x2", () => {
  /* BUILD-NOTES 3 (PlaylistTile: composite cover 2x2 of episode arts, 120) and 10.5 (a collage never crops a square: the
     primitive's c1..c4 classes carry the rule in CSS). The cover is decorative, so it is aria-hidden: the name beside it says
     what it is. Four episodes of ONE show are one picture, not the same square four times.
     MUTATIONS: drop the dedupe in playlistCovers -> the one-show case reads c4, red. Pass size 160 -> red. Drop the
     `aria-hidden` from `.pl-cover` -> red. Slice to 3 in playlistCovers -> the four-show case reads c3, red. */
  const cls = (shows) => {
    const items = shows.map((s, i) => item(i + 1, { show: `Show ${s}`, artwork_url: `https://art.test/${s}.jpg` }));
    const w = world({ items, lists: [{ id: "q1", title: "T", items }] });
    w.ctx.renderPlaylistDetail("q1");
    return w.html();
  };
  assert.match(cls(["a", "b", "c", "d"]), /<div class="pl-cover" aria-hidden="true"><span class="ag-collage ag-collage-120 c4 /, "four shows: a 2x2");
  assert.match(cls(["a", "b", "c"]), /ag-collage-120 c3 /, "three: whole squares overlapping");
  assert.match(cls(["a", "b"]), /ag-collage-120 c2 /, "two");
  assert.match(cls(["a", "a", "a", "a"]), /ag-collage-120 c1 /, "one show, four episodes: the art itself");
  assert.match(cls(["a", "b", "c", "d"]), /ag-collage-120/, "120, the BUILD-NOTES size");
});

test("the length line is '<n> episodes, <h> hr <m> min' with a comma, and only the count when a part has no length", () => {
  /* BUILD-NOTES 3. A sum over parts some of which have no length is a shorter number than the truth, so it is all or nothing.
     The line is two unbreakable halves so a narrow tile wraps at the comma and never strands "min".
     MUTATIONS: join with " · " -> red. Drop the all-or-nothing guard in playlistMinutes -> the partial sum prints, red. Drop
     `white-space: nowrap` from `.pl-nb` -> red. */
  const six = [20, 20, 20, 20, 25, 25].map((m, i) => item(i + 1, { duration_min: m, duration_sec: m * 60 }));
  const w = world({ items: six, lists: [{ id: "q1", title: "T", items: six }] });
  w.ctx.renderPlaylistDetail("q1");
  assert.strictEqual(text(one(w.html(), /<p class="t-caption num pl-meta">([\s\S]*?)<\/p>/)), "6 episodes, 2 hr 10 min");
  assert.match(w.html(), /<span class="pl-nb">6 episodes,<\/span> <span class="pl-nb">2 hr 10 min<\/span>/);
  assert.strictEqual(decls(CSS, ".ag .pl-nb")["white-space"], "nowrap");
  const gap = six.map((it, i) => (i === 2 ? { ...it, duration_min: 0, duration_sec: 0 } : it));
  const w2 = world({ items: gap, lists: [{ id: "q1", title: "T", items: gap }] });
  w2.ctx.renderPlaylistDetail("q1");
  assert.strictEqual(text(one(w2.html(), /<p class="t-caption num pl-meta">([\s\S]*?)<\/p>/)), "6 episodes");
});

test("'3 of 6 played' is Ember and appears only once an episode has finished, and the tile says the same", () => {
  /* BUILD-NOTES 3: "3 of 6 played" in Ember when started. Ember is the primitives' `.ag-progress-copy`; "played" is the player's
     verdict (state "played"), never mere opening, so the line cannot disagree with a row that says "31 min left". No zero line.
     MUTATIONS: count `hasOpened` instead of `playlistRowPlayed` -> the in-progress and sampled episodes count, red. Drop
     `ag-progress-copy` from the line -> not Ember, red. Print the line at zero -> red. Give the tile its own count -> they
     can disagree (the two are asserted equal below). */
  const six = [1, 2, 3, 4, 5, 6].map((n) => item(n));
  const progress = {
    [six[0].id]: DONE, [six[1].id]: DONE, [six[2].id]: DONE,
    [six[3].id]: { state: "in-progress", percent: 50, label: "10 min left" }, [six[4].id]: { state: "sampled", percent: null, label: null },
  };
  const w = world({ items: six, lists: [{ id: "q1", title: "T", items: six }], progress });
  w.ctx.renderPlaylistDetail("q1");
  assert.match(w.html(), /<p class="t-caption num ag-progress-copy pl-played">3 of 6 played<\/p>/);
  w.ctx.renderPlaylists();
  assert.match(w.html(), /<p class="t-caption num ag-progress-copy pl-tile-played">3 of 6 played<\/p>/, "the tile reads the same fact");
  const none = world({ items: six, lists: [{ id: "q1", title: "T", items: six }] });
  none.ctx.renderPlaylistDetail("q1");
  assert.doesNotMatch(none.html(), /played/, "nothing finished: no line, and certainly no zero");
  none.ctx.renderPlaylists();
  assert.doesNotMatch(none.html(), /ag-progress-copy/);
  assert.strictEqual(decls(read("ui/primitives.css").replace(/\/\*[\s\S]*?\*\//g, " "), ".ag .ag-progress-copy").color, "var(--ember) !important", "fixture assumption: that class is Ember");
});

test("the episodes are Today's EpisodeRow: art, a two-line title that opens the episode, Play, meta, the why-line; each row's title carries the playlist's ctx", () => {
  /* BUILD-NOTES 3 EpisodeRow (96 min height is `.td-row`'s, ui/today.css). The title link is the row's one real link and logs a
     pick under `playlist-<id>`, which is what stamps last_played_at. Every interpolation crosses esc().
     MUTATIONS: write `data-ctx="today"` for the playlist's ctx -> red. Interpolate `item.title` raw -> the hostile title lands
     as markup, red. Render the row without `td-row` -> red. */
  const hostile = [item(1, { title: `<img src=x onerror="alert(1)">`, show: `"><script>alert(2)</script>` }), item(2)];
  const w = world({ items: hostile, lists: [{ id: "q1", title: `<b>bold</b>`, items: hostile }] });
  w.ctx.renderPlaylistDetail("q1");
  const html = w.html();
  assert.strictEqual((html.match(/<article class="raised td-row pl-ep is-/g) || []).length, 2, "two EpisodeRows");
  assert.match(html, /<a class="td-link" href="#\/episode\/show-2--ep-2" data-ev="picked" data-ep="show-2--ep-2" data-ctx="playlist-q1">Episode 2<\/a>/);
  assert.match(html, /<p class="t-why clamp2 td-row-why">Why episode 2 matters\.<\/p>/, "the why-line, two lines");
  assert.ok(!html.includes("<img src=x") && !html.includes("<script>alert") && !html.includes("<b>bold"), "nothing from a stored title reaches the page as markup");
  assert.ok(html.includes("&lt;img src=x") && html.includes("&lt;b&gt;bold"), "it is there, escaped");
  assert.doesNotMatch(html, /style="/, "no inline style: the strict CSP forbids it");
  /* Heading order (axe heading-order): the name is the h1 and each row's title an h3, so the page needs the h2 between them
     (visually hidden: the page shows no section title). MUTATION: delete `<h2 class="sr-only">Episodes</h2>` from renderPlaylistDetail -> red. */
  const levels = [...html.matchAll(/<h([1-6])\b/g)].map((x) => Number(x[1]));
  assert.deepStrictEqual(levels.slice(0, 3), [1, 2, 3], `headings step down one level at a time: ${levels}`);
  levels.forEach((l, i) => assert.ok(i === 0 || l - levels[i - 1] <= 1, `heading order: ${levels}`));
});

test("'Next' marks the first part the listener has not opened, once the playlist is started, and only on a part that can play", () => {
  /* The marker is `data-pl-next` on the page (the id the hero Play starts) and, once one episode has finished, the word "Next" in
     Lamp on that row. Before that the page says nothing: the hero Play is the way in.
     MUTATIONS: compute the next part over every row (not live ones) -> an archived first part takes it, red. Show the word
     while nothing is played -> red. Mark every row -> red. */
  const items = [1, 2, 3, 4].map((n) => item(n));
  const started = world({ items, lists: [{ id: "q1", title: "T", items }], progress: { [items[0].id]: DONE } });
  started.ctx.renderPlaylistDetail("q1");
  assert.match(started.html(), /data-pl-next="show-2--ep-2"/);
  assert.strictEqual((started.html().match(/class="ag-row-state pl-next">Next</g) || []).length, 1, "one row says Next");
  assert.match(started.html(), /data-pl-ep="show-2--ep-2"[\s\S]*?pl-next">Next<[\s\S]*?data-pl-ep="show-3--ep-3"/, "and it is the second part's");
  const fresh = world({ items, lists: [{ id: "q1", title: "T", items }] });
  fresh.ctx.renderPlaylistDetail("q1");
  assert.match(fresh.html(), /data-pl-next="show-1--ep-1"/);
  assert.doesNotMatch(fresh.html(), /pl-next">Next</, "nothing played: no word");
  /* The first part has left the catalogue: the marker skips it. */
  const gone = world({ items, lists: [{ id: "q1", title: "T", items }] });
  gone.state.discover = { items: items.slice(1) };
  gone.state.itemIndex = {}; gone.state.poolIds = new Set();
  gone.ctx.renderPlaylistDetail("q1");
  assert.match(gone.html(), /data-pl-next="show-2--ep-2"/);
});

test("the page is lit by its first show: the wash carries that show's name for the Glow, and the cover takes the same light", () => {
  /* The Glow is Today's: agSetGlow on the wash and the cover. The name travels as a data attribute, never as a style.
     MUTATIONS: write the last show instead of the first -> red. Drop the cover's agSetGlow line in playlistApplyGlow -> the
     second write below does not happen, red. */
  const shows = [item(1, { show: "Alpha" }), item(2, { show: "Beta" })];
  const w = world({ items: shows, lists: [{ id: "q1", title: "T", items: shows }] });
  w.ctx.renderPlaylistDetail("q1");
  assert.match(w.html(), /<div class="pl-wash" aria-hidden="true" data-glow-show="Alpha"><\/div>/);
  const written = [];
  const wash = new El("div"); wash.dataset.glowShow = "Alpha"; wash.style = { setProperty: (k, v) => written.push([k, v]) };
  const cover = new El("div"); cover.style = { setProperty: (k, v) => written.push([k, v]) };
  const scope = { querySelector: (s) => (s === ".pl-wash" ? wash : s === ".pl-cover .ag-collage" ? cover : null) };
  w.ctx.playlistApplyGlow(scope);
  assert.deepStrictEqual(written.map(([k]) => k), ["--glow", "--art-glow"]);
  assert.strictEqual(written[0][1], w.run('agGlowFor("Alpha")'), "the colour is Alpha's");
});

/* ---------- 3. the Playlists list ---------- */

test("the Playlists list is a grid of tiles: cover, name, length, and the played line or the day last played", () => {
  /* BUILD-NOTES 3 PlaylistTile. One "played" line per tile: the count when one has finished, else "played <day>". The tile is
     one link; its name is the headline style on two lines. Titles cross esc().
     MUTATIONS: empty the `last` fallback -> the unfinished tile loses its day, red. Interpolate `p.title` raw -> red. Wrap the
     grid in a rail (`td-rail`) -> red. */
  const items = [1, 2, 3, 4].map((n) => item(n));
  const w = world({
    items,
    lists: [
      { id: "a", title: "Finished one", items, last_played_at: "2019-09-21T12:00:00.000Z" },
      { id: "b", title: `<i>x</i>`, items: items.slice(2, 4), last_played_at: "2019-09-20T12:00:00.000Z" },
    ],
    progress: { [items[0].id]: DONE },
  });
  w.ctx.renderPlaylists();
  const html = w.html();
  assert.strictEqual((html.match(/<a class="raised ag-playlist-tile pl-tile" href="#\/playlist\/[ab]"/g) || []).length, 2, "two tiles, each one link");
  assert.match(html, /<div class="pl-grid">/);
  assert.doesNotMatch(html, /td-rail/, "a grid, not a rail");
  assert.match(html, /<h2 class="t-headline clamp2 pl-tile-name">Finished one<\/h2>/);
  const tileA = /href="#\/playlist\/a"[\s\S]*?<\/a>/.exec(html)[0];
  assert.match(tileA, /1 of 4 played/, "the finished tile says how far");
  assert.doesNotMatch(tileA, /played Sep/, "and not the day as well");
  const tileB = /href="#\/playlist\/b"[\s\S]*?<\/a>/.exec(html)[0];
  assert.match(tileB, /<p class="t-caption pl-tile-last">played Sep 20, 2019<\/p>/);
  assert.ok(!html.includes("<i>x</i>") && html.includes("&lt;i&gt;x&lt;/i&gt;"), "a stored name is escaped");
  assert.match(html, /<p class="t-caption num pl-count">2 playlists<\/p>/);
  assert.match(html, /<a class="ag-btn ag-btn-icon pl-build" href="#\/create" aria-label="Build a playlist">/, "the one door to the builder");
});

/* ---------- 4. the two empty pages ---------- */

const BANNED = /\b(fascinating|deep dive|delves?|explores?|beat|segment|act|running order|topic)\b/i;
const FIRST_PERSON = /\b(we|us|our|ours|we're|we've|we'll)\b/i;

test("not found is an EmptyState: one line, one button, and the line passes the copy rules", () => {
  /* BUILD-NOTES 3 EmptyState: one line, one button (outlined, pill, 44). The page still has its Back and a heading for the
     router and a screen reader (visually hidden: the page shows the one line).
     MUTATIONS: add a second control (a Retry button) -> red. Write two sentences -> red. Say "we" -> red. Use "topic" or
     "explore" -> red. Drop the heading -> red (the route cannot name the page). Drop `ag-btn-secondary` -> red. */
  const w = world({ items: FOUR, lists: [{ id: "q1", title: "T", items: FOUR }] });
  w.ctx.renderPlaylistDetail("does-not-exist");
  const html = w.html();
  assert.match(html, /<h1 class="sr-only" data-page-heading>Playlist not found<\/h1>/);
  assert.match(html, /<a class="back ag-btn ag-btn-icon" href="#\/playlists" aria-label="Back">/);
  const line = one(html, /<section class="ag-empty pl-empty"><p class="t-body">([^<]*)<\/p>/);
  assert.ok(line, "the one line");
  assert.strictEqual((line.match(/[.!?](?=\s|$)/g) || []).length, 1, `one sentence: ${line}`);
  assert.ok(line.split(/\s+/).length <= 18, "and short");
  assert.doesNotMatch(line, BANNED, "no banned word");
  assert.doesNotMatch(line, FIRST_PERSON, "no we/us/our");
  assert.doesNotMatch(line, /!/, "no exclamation");
  const buttons = [...html.matchAll(/<(?:a|button)\b[^>]*class="[^"]*ag-btn[^"]*"[^>]*>/g)].map((m) => m[0]).filter((t) => !/ag-btn-icon/.test(t));
  assert.strictEqual(buttons.length, 1, `exactly one button besides Back: ${buttons}`);
  assert.match(buttons[0], /class="ag-btn ag-btn-secondary ag-btn-size-44" href="#\/playlists"/);
  assert.doesNotMatch(html, /<button\b/, "and it is a link to one of our own routes");
});

test("the empty list is an EmptyState too: one line, one button to Create", () => {
  /* MUTATION: draw the grid's header plus when the list is empty -> the "+ " and the button are two doors, red. Say anything but
     the fact ("No playlists yet.") -> red. */
  const w = world({ items: FOUR, lists: [] });
  w.ctx.renderPlaylists();
  const html = w.html();
  assert.match(html, /<section class="ag-empty pl-empty"><p class="t-body">No playlists yet\.<\/p><a class="ag-btn ag-btn-secondary ag-btn-size-44" href="#\/create">Build a playlist<\/a><\/section>/);
  assert.doesNotMatch(html, /pl-build/, "the header's plus is for a list that has tiles");
  assert.doesNotMatch(html, /pl-grid/);
});

/* ---------- 5. behaviour ---------- */

const buttonFor = (view, id) => view.querySelector(`[data-pl-play="${id}"]`);

test("a row's Play starts the PLAYLIST: that episode, the page's rows as the continuous-play list, and last_played_at stamped", async () => {
  /* The page's ctx is `playlist-<id>`; startEpisodePlay stamps last_played_at for exactly that shape and records history.
     The play list is the page's own Play buttons in on-screen order.
     MUTATIONS: pass `ctx: null` in playlistPlayPress -> last_played_at stays null, red. Build the list from `[data-play]` (the
     old selector) -> the list is empty, red. */
  const w = world({ items: FOUR, lists: [{ id: "q1", title: "T", items: FOUR }] });
  w.ctx.renderPlaylistDetail("q1");
  const scope = w.view.querySelector(".pl-detail");
  w.ctx.bindPlaylistPlay(scope);
  const lists = [];
  w.run("const __setPlayList = setPlayList; setPlayList = (ids, played) => { globalThis.__lists = (globalThis.__lists || []); globalThis.__lists.push([ids, played]); return __setPlayList(ids, played); };");
  buttonFor(w.view, "show-2--ep-2").click();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(w.calls.play, ["show-2--ep-2"], "that episode played");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(w.ctx.__lists[0])), [["show-1--ep-1", "show-2--ep-2", "show-3--ep-3", "show-4--ep-4"], "show-2--ep-2"],
    "the page's four rows are the continuous-play list, in order, starting from the one pressed");
  const stored = JSON.parse(w.store.get("cp_playlists"));
  assert.ok(stored[0].last_played_at, "the playlist's last_played_at is stamped");
  void lists;
});

test("a row showing Pause pauses: the player's own item toggles and nothing new starts", async () => {
  /* The rule bindPlay learned (founder, 2026-09-22): a button that reads Pause must pause.
     MUTATION: drop the `isCurrent` early return in playlistPlayPress -> the press restarts the episode, red. */
  const w = world({ items: FOUR, lists: [{ id: "q1", title: "T", items: FOUR }], playing: "show-3--ep-3" });
  w.ctx.renderPlaylistDetail("q1");
  w.ctx.bindPlaylistPlay(w.view.querySelector(".pl-detail"));
  buttonFor(w.view, "show-3--ep-3").click();
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(w.calls.toggle, 1);
  assert.deepStrictEqual(w.calls.play, []);
});

test("the hero Play starts the next unopened part, pauses what is playing, and is disabled with nothing to play", async () => {
  /* One control for the whole playlist: Pause when a part of it is playing, else Play at the NEXT part (from the top when every
     part has been opened).
     MUTATIONS: start the first row instead of the next -> red. Ignore the playing row -> red. Drop `disabled: !anyLive` -> red. */
  const started = world({ items: FOUR, lists: [{ id: "q1", title: "T", items: FOUR }], progress: { [FOUR[0].id]: DONE } });
  started.ctx.renderPlaylistDetail("q1");
  started.ctx.bindPlaylistPlay(started.view.querySelector(".pl-detail"));
  started.view.querySelector("[data-pl-playall]").click();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(started.calls.play, ["show-2--ep-2"], "the next part, not the first");

  const playing = world({ items: FOUR, lists: [{ id: "q1", title: "T", items: FOUR }], playing: "show-4--ep-4" });
  playing.ctx.renderPlaylistDetail("q1");
  const scope = playing.view.querySelector(".pl-detail");
  /* The page paints a row as playing from the player; the fake DOM has no layout, so mark it as the sync would. */
  scope.querySelectorAll("[data-pl-ep]").find((r) => r.dataset.plEp === "show-4--ep-4").classList.add("pl-ep", "is-playing");
  playing.ctx.bindPlaylistPlay(scope);
  scope.querySelector("[data-pl-playall]").click();
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(playing.calls.toggle, 1, "a part is playing: the hero pauses it");
  assert.deepStrictEqual(playing.calls.play, []);

  const empty = world({ items: [], lists: [{ id: "q1", title: "T", items: FOUR }] });
  empty.ctx.renderPlaylistDetail("q1");
  assert.match(empty.html(), /data-pl-playall[^>]*disabled aria-disabled="true"/, "nothing live: nothing to play");
});

test("the page repaints from the player: a playing row gets its state, its Pause glyph and name, and the hero turns to Pause", () => {
  /* The shared small DOM has no insertAdjacentHTML: this records what the page inserts so the state line can be read back. */
  El.prototype.insertAdjacentHTML = function (_pos, html) { this.inserted = (this.inserted || []).concat(html); };
  /* The player is the single authority (as Today): playlistSyncPlay reads isPlaying per row and repaints the row's class, its
     Play button's name and the hero's.
     MUTATIONS: stop toggling `is-playing` -> red. Leave the button's aria-label as "Play …" -> red (a voice-control user saying
     "Pause" finds nothing). Skip the hero -> red. */
  let playing = null;
  const w = world({ items: FOUR, lists: [{ id: "q1", title: "Slow", items: FOUR }] });
  w.player.isPlaying = (id) => playing === id;
  w.ctx.renderPlaylistDetail("q1");
  playing = "show-2--ep-2";
  w.ctx.playlistSyncPlay();
  const row = w.view.querySelector("[data-pl-ep]");
  const rows = w.view.querySelectorAll("[data-pl-ep]");
  const second = rows.find((r) => r.dataset.plEp === "show-2--ep-2");
  assert.ok(second.classList.contains("is-playing"), "the playing row is marked");
  assert.ok(!row.classList.contains("is-playing"), "and the others are not");
  assert.strictEqual(second.querySelector("[data-pl-play]").getAttribute("aria-label"), "Pause Episode 2");
  assert.ok((second.querySelector(".td-row-meta").inserted || []).join("").includes("Playing"), "its meta line says Playing (the Lamp state line)");
  assert.strictEqual(w.view.querySelector("[data-pl-playall]").getAttribute("aria-label"), "Pause Slow");
  playing = null;
  w.ctx.playlistSyncPlay();
  assert.ok(!second.classList.contains("is-playing"));
  assert.strictEqual(w.view.querySelector("[data-pl-playall]").getAttribute("aria-label"), "Play Slow");
});

test("a generated playlist or subject queue can be kept and not removed; a listener's own can be removed and not kept", () => {
  /* The two pages keep the controls the old page had, in the new idiom: Remove is a Secondary button at the foot of an own
     playlist, and the keep control (the app's own, with its note) sits under the hero of one that can be kept.
     MUTATIONS: draw Remove on a subject queue -> red. Draw the keep control on an own playlist -> red. Drop the eyebrow -> red. */
  const w = world({ items: FOUR, lists: [{ id: "q1", title: "Mine", items: FOUR }] });
  w.ctx.renderPlaylistDetail("q1");
  assert.match(w.html(), /<button type="button" class="ag-btn ag-btn-secondary pl-remove" id="pl-remove">Remove this playlist<\/button>/);
  assert.doesNotMatch(w.html(), /id="pl-save"/);
  assert.doesNotMatch(w.html(), /Picked for you|Generated for you/);
  w.state.cardSlots = [{ slot: 1, branch: "science", role: "top", item: FOUR[0], items: FOUR }];
  w.state.taxonomy = { nodes: [{ id: "science", parent: null, label: "Science" }] };
  w.ctx.renderPlaylistDetail("subject-science");
  assert.doesNotMatch(w.html(), /id="pl-remove"/);
  assert.match(w.html(), /id="pl-save"/);
  assert.match(w.html(), /<p class="eyebrow lamp">Picked for you<\/p>/);
});
