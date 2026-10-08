/* Tactile `search-typing` (Find, typing): the results that replace the mosaic.
 * Redesign 2026, docs/redesign-2026/directions/tactile/BUILD-PLAN.md 2.10,
 * BUILD-NOTES 3.9 and 4.4.
 *
 * WHAT THIS PROVES
 *   1. The closing key: "Make a playlist about <query>" is an ultramarine,
 *      full-width keycap with Phosphor's sparkle ahead of the words, never the
 *      bridge mark, and the query is escaped in the label and in the attribute
 *      (driven with <b>x</b>, a query the scorer would never answer, which is why
 *      the markup builder is separate from the gate that decides when to offer it).
 *      It is the LAST row whether or not a playlist matched (it used to be offered
 *      only when none did).
 *   2. Three groups in the prototype's order, each heading carrying a count that
 *      is the number of matches (Episodes: the listener's own rows plus the
 *      endpoint's, not just one tier; Shows: all matches, not the rows painted so
 *      far; Playlists: own plus generated).
 *   3. The episode row: ONE trailing Play key `sm` (a `data-play` the player
 *      repaints), "+ Up Next" on the meta line (the shared `upNextBtn`), the show's
 *      display name as plain text, the title escaped, no star.
 *   4. The eight fixture show names run through the display-name rule, and the CSS
 *      that gives the name `min-width: 112px` and lets the meta wrap only when
 *      even that cannot fit.
 *   5. The Shows rows are `.row-show` around the same `.show-result` link; the
 *      playlist cards are a two-column grid of collages; the clear key is shown
 *      once there is a query.
 *   6. A settled "No shows found" note says what kind of line it is, so the page
 *      drops it only when another group answered.
 *   7. A row's play key keeps its icon when the player repaints it.
 *   8. The harness has a settled typing step, appended (the four existing steps
 *      keep their order), and the screen map points at it.
 *   9. The block adds no hex literal, transition or animation.
 *
 * WHAT IT CANNOT PROVE: how any of it looks. tools/ui-lab/fidelity.mjs measures
 * that against the prototype in a real browser; this suite runs in node:vm.
 *
 * HARNESS AUDIT (CLAUDE.md "a green test is not evidence until you have broken
 * it"). The page is the real renderAllShows over a DOM stub with recorded
 * listeners, and the painters are the real ones (paintShowResults,
 * paintEpisodeSearchResults, renderPlaylistSearchResults), so a mutation in the
 * source changes what these tests read. The playlist test seeds a playlist that
 * MATCHES the query, the case the old gate skipped, and a scorer that CAN build
 * it (the committed discover/item-tags/semantic data), so the key being absent is
 * the only way it fails. The episode tests seed one saved episode AND one remote
 * row, because a count that read only one tier would pass with either alone. Each
 * test names its mutation; all were run red.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { readAppSource, runAppSource } = require("./helpers/app-source.js");
const { parseRules } = require("./helpers/dial-css.js");

const ROOT = path.join(__dirname, "..");
const APP_SRC = readAppSource();
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8").replace(/\r\n/g, "\n");
const CLIENT_SRC = fs.readFileSync(path.join(ROOT, "player", "client.js"), "utf8").replace(/\r\n/g, "\n");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

process.on("unhandledRejection", () => {});

function makeEl(tag) {
  const listeners = new Map();
  return {
    tagName: String(tag || "div").toUpperCase(),
    id: null, className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {}, children: [],
    offsetHeight: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener() {},
    dispatch(type, evt = {}) {
      const fns = listeners.get(type) || [];
      for (const fn of fns) fn({ type, preventDefault() {}, target: this, ...evt });
      return fns.length;
    },
    appendChild(k) { this.children.push(k); return k; },
    append(...k) { this.children.push(...k); },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, select() {}, click() {}, blur() {}, remove() {},
  };
}

const PAGE_IDS = [
  "view", "drawer", "drawer-overlay", "menu-btn", "refresh-btn", "banner-slot",
  "sh-form", "sh-input", "sh-note", "sh-results", "sh-results-count", "sh-browse", "sh-dismiss",
  "sh-partial-note", "sh-empty-offer", "sh-offline-note",
  "ep-search-results", "pl-search-results", "fy-search-results", "find-more", "find-mosaic",
];

function mount({ seed = {}, boot = false } = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  const byId = new Map(PAGE_IDS.map((id) => { const el = makeEl("div"); el.id = id; return [id, el]; }));
  const body = makeEl("body");
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: () => new Promise(() => {}),
    localStorage: {
      get length() { return store.size; },
      key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    document: {
      body, documentElement: body, readyState: "complete",
      addEventListener() {}, createElement: (t) => makeEl(t),
      querySelector: (sel) => {
        const s = String(sel);
        return s.startsWith("#") && !s.includes(" ") ? byId.get(s.slice(1)) ?? null : null;
      },
      querySelectorAll: () => [],
    },
    navigator: { userAgent: "node", onLine: true },
    addEventListener() {}, removeEventListener() {},
    location: { hash: "#/shows", search: "", pathname: "/", href: "https://x.test/" },
    history: { back() {}, replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    requestAnimationFrame: (fn) => { const t = setTimeout(fn, 0); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
    scrollY: 0,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  runAppSource(APP_SRC, ctx);
  const evalIn = (src) => vm.runInContext(src, ctx);
  const state = evalIn("state");
  state.catalog = { shows: [] };
  state.discover = { items: [] };
  state.cardSlots = [];
  state.taxonomy = { nodes: [] };
  state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  return { ctx, evalIn, store, state, byId, view: () => byId.get("view").innerHTML };
}

const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

/** The rule's declarations as one object (last write wins), for an exact selector list entry. */
const RULES = parseRules(CSS);
function rule(selector, { atRules = [] } = {}) {
  const out = {};
  let found = false;
  for (const r of RULES) {
    if (!r.selectors || !r.selectors.includes(selector)) continue;
    if (JSON.stringify(r.atRules) !== JSON.stringify(atRules)) continue;
    found = true;
    for (const d of r.decls) out[d.prop] = d.value;
  }
  assert.ok(found, `styles.css has no rule for ${selector}`);
  return out;
}

const TYPING_START = CSS.lastIndexOf("/*", CSS.indexOf("FIND, TYPING (TACTILE): the results that replace the mosaic"));
const TYPING_END = CSS.indexOf("COMPONENT GALLERY. Development-only");
const TYPING_CSS = CSS.slice(TYPING_START, TYPING_END);

/* ------------------------------------------------------------- 1 the key */

test("the closing key is an ultramarine keycap with the sparkle, never the bridge, and the query is escaped in the label and the attribute", () => {
  /* MUTATION: interpolate `${query}` (not `${esc(query)}`) in the label, or in the
     data attribute, or swap "ph-sparkle" for "bridge", or drop "keycap--ultramarine",
     or put quoteQuery() back in the label (double curly quotes). Each fails below. */
  const m = mount();
  const html = m.ctx.makePlaylistKeyHtml("<b>x</b>");
  assert.ok(!html.includes("<b>x</b>"), `the raw query never reaches the page: ${html}`);
  assert.ok(html.includes("&lt;b&gt;x&lt;/b&gt;"), "it is escaped");
  assert.ok(html.includes('data-create-playlist="&lt;b&gt;x&lt;/b&gt;"'), "and the attribute carries the escaped query too");
  assert.ok(html.includes("Make a playlist about \u2018&lt;b&gt;x&lt;/b&gt;\u2019"), "in the prototype's SINGLE curly pair, after 'Make'");
  assert.ok(!html.includes("\u201c") && !html.includes("\u201d"), "never the double pair the sentences use");
  assert.ok(/class="keycap keycap--md keycap--ultramarine keycap--wide"/.test(html), "ultramarine, full width");
  assert.ok(html.includes('href="#ph-sparkle"'), "Phosphor's sparkle ahead of the words");
  assert.ok(!html.includes("#bridge"), "the bridge mark means Stretch and nothing else");
  assert.strictEqual((html.match(/<button/g) || []).length, 1, "one key");
});

test("the key's lip is the face's own rounded shape offset down, not a flat bar under it", () => {
  /* The primitive's `.keycap::after` is a straight bar as wide as the key. Under a 14px
     radius it leaves a light gap at each bottom corner, so the Play key and the
     ultramarine key read as a button floating above a stray underline (iteration 3's
     fidelity finding). On Find the lip is a hard box-shadow instead, the shape
     `.np .transport .keycap` already uses, and it wraps the rounded bottom.
     MUTATION: delete the `box-shadow` from `body.view-find .keycap` (the key has no lip
     at all), delete the `::after { content: none }` rule (the flat bar returns beside
     the shadow), or drop the `--lip-pressed` shadow from the pressed rule (the base
     moves when the key is pressed). Each fails below. WHAT IT CANNOT PROVE: the look;
     fidelity `search-typing-i6` is where the corners were read. */
  const key = rule("body.view-find .keycap");
  assert.strictEqual(key["box-shadow"], "0 var(--lip) 0 var(--k-lip)", "the lip is the key's own shape, 3px lower, in the key's darker tone");
  assert.strictEqual(key["margin-bottom"], "var(--lip)", "and it has the room the prototype's margin gives it");
  assert.strictEqual(rule("body.view-find .keycap::after").content, "none", "the primitive's flat bar is switched off here");
  assert.strictEqual(rule(":root")["--lip"], "3px");
  const pressed = rule("body.view-find .keycap:active:not(:disabled)");
  assert.strictEqual(pressed["box-shadow"], "0 var(--lip-pressed) 0 var(--k-lip)", "pressed, the face drops and the shadow shrinks, so the base stays put");
  /* The shadow reads `--k-lip`, which only the colour variants set: the two keys on
     this screen must each have one that is not the default hairline. */
  assert.ok(rule(".keycap--persimmon")["--k-lip"] === "var(--persimmon-lip)" && rule(".keycap--ultramarine")["--k-lip"] === "var(--ultramarine-lip)", "a darker tone of the key's own colour");
});

test("'Up Next' on a row is a drawn plus that repaints to a drawn check, and its text is never rewritten", () => {
  /* The row used to carry "+ Up Next" / "✓ Up Next" as TEXT, a Unicode character
     standing in for an icon, which the direction forbids. The plus and check are now
     Phosphor Bold from the sprite, `paintUpNext` swaps the `<use>` and the accessible
     name, and a text control (every other screen's "+ Up Next") still goes through
     setToggleLabel. The fakes are real enough to matter: the button keeps its text, so
     a repaint that wrote textContent would flatten the icon and fail the first check.
     MUTATION: make paintUpNext always call setToggleLabel (the icon is flattened to
     text), drop `data-upnext-icon` from searchUpNextBtn (the repaint treats the icon
     button as text), or restore the typed "+" in searchUpNextBtn. */
  const m = mount();
  const attrs = new Map();
  const use = { setAttribute: (k, v) => attrs.set("use:" + k, v), getAttribute: (k) => attrs.get("use:" + k) ?? null };
  const btn = { ...makeEl("button"), dataset: { upnextIcon: "1" }, textContent: "Up Next", querySelector: (sel) => (sel === "use" ? use : null), setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k) };
  m.ctx.paintUpNext(btn, true);
  assert.strictEqual(attrs.get("use:href"), "#ph-check", "queued: the drawn check");
  assert.strictEqual(attrs.get("aria-label"), "In Up Next");
  assert.strictEqual(btn.textContent, "Up Next", "the words were not rewritten");
  m.ctx.paintUpNext(btn, false);
  assert.strictEqual(attrs.get("use:href"), "#ph-plus", "not queued: the drawn plus");
  assert.strictEqual(attrs.get("aria-label"), "Add to Up Next");
  assert.strictEqual(btn.textContent, "Up Next");
  const text = { ...makeEl("button"), dataset: {}, textContent: "+ Up Next", setAttribute: () => {}, removeAttribute: () => {} };
  m.ctx.paintUpNext(text, true);
  assert.strictEqual(text.textContent, "✓ Up Next", "a text control still repaints its words, through setToggleLabel");

  /* The builder reads the queue: a queued episode is drawn with the check, named for the state. */
  m.store.set("cp_queue", JSON.stringify(["ep-1"]));
  const html = m.ctx.searchEpisodeRow(ITEM, "ctx");
  const meta = html.slice(html.indexOf('<div class="row__meta">'), html.indexOf("</div>", html.indexOf('<div class="row__meta">')));
  assert.ok(meta.includes('href="#ph-check"') && meta.includes('class="up-next on"') && meta.includes('aria-label="In Up Next"'), `queued row: ${meta}`);
  assert.ok(!meta.includes("✓"), "and no check mark typed into the text");
  /* The gate is upNextBtn's own: an episode addToQueue refuses gets no control. */
  const silent = m.ctx.searchEpisodeRow({ ...ITEM, id: "ep-2", audio_url: null }, "ctx");
  assert.ok(!silent.includes("data-upnext"), "no audio, no Up Next");
});

test("the key's label quotes the query in single curly quotes, once, and escapes it", () => {
  /* MUTATION: return the double pair from quoteKeyQuery, or interpolate without esc(). */
  const m = mount();
  assert.strictEqual(m.ctx.quoteKeyQuery("x"), "‘x’");
  assert.strictEqual(m.evalIn("quoteQuery")("x"), "“x”", "the sentences keep their own pair");
});

test("the key closes the results whether or not a playlist matched, after the playlist cards, and only when the scorer can build one", async () => {
  /* MUTATION: pass nothing to scheduleCreatePlaylistCta in the matched branch
     of renderPlaylistSearchResults (the key then waits for a no-match, as it used
     to), or build the key before the section (`cta + sectionHtml`). The first
     leaves no key, the second puts it above the cards. The second half is the old
     gate: an unbuildable query still gets no key (drop the `status` check in
     createPlaylistCtaHtml and the nonsense query gets one). */
  const m = mount({ seed: { cp_playlists: [{ id: "p1", title: "Meditation Mix", items: [{ id: "e1", title: "Ep", topics: ["wellness/meditation"] }] }] } });
  m.state.discover = readJson("data/discover.json");
  m.state.itemTags = readJson("data/item-tags.json");
  m.state.semantic = readJson("data/semantic-index.json");
  const status = m.evalIn("topicSearchStatus")("meditation").status;
  assert.ok(status === "ok" || status === "sparse", `fixture: the scorer can build "meditation" (got ${status})`);
  m.byId.get("sh-input").value = "meditation";
  m.ctx.renderAllShows();
  m.byId.get("sh-form").dispatch("submit");
  await flush();
  const pl = m.byId.get("pl-search-results").innerHTML;
  const card = pl.indexOf('href="#/playlist/p1"');
  const key = pl.indexOf("data-create-playlist=");
  assert.ok(card >= 0, "the matching playlist is a card");
  assert.ok(key > card, `and the key comes after it, as the last row: ${pl}`);
  assert.ok(!pl.includes("data-cta-pending"), "no pending line stands in once it has answered");

  const none = mount();
  none.byId.get("sh-input").value = "zzz-nonsense-query-zzz";
  none.ctx.renderAllShows();
  none.byId.get("sh-form").dispatch("submit");
  await flush();
  assert.strictEqual(none.evalIn("topicSearchStatus")("zzz-nonsense-query-zzz").status, "empty", "fixture: nothing to build from");
  assert.ok(!none.byId.get("pl-search-results").innerHTML.includes("data-create-playlist"), "no key for a query nothing can build");
});

/* ----------------------------------------------------------- 2 the groups */

test("each group's heading carries its count: Episodes counts both tiers, Shows counts every match, Playlists counts own plus generated", async () => {
  /* MUTATION: count `remote.length` alone in paintEpisodeSearchResults (the
     listener's own row is then missed: 1, not 2); set the Shows readout from the
     rows painted (`shows.slice(0, cap).length`) instead of `shows.length`; or count
     `own.length` alone for Playlists. */
  const m = mount({ seed: { cp_saved: { "s-1": { id: "s-1", title: "Sleep Toolkit", show: "Huberman Lab", show_id: "h", audio_url: "https://cdn.test/s1.mp3", duration_min: 60, topics: [] } } } });
  const eps = m.byId.get("ep-search-results");
  const local = m.evalIn("localEpisodeMatches")("sleep");
  assert.strictEqual(local.length, 1, "fixture: one saved episode matches");
  m.evalIn("paintEpisodeSearchResults")("sleep", { episodes: [{ show_id: "x", show_title: "Other Show", title: "Sleep Better", guid: "g2", audio_url: "https://cdn.test/g2.mp3" }], source: ["apple"] }, eps, local);
  assert.ok(/<h3>Episodes[\s\S]*?<span class="readout find-count">2<\/span><\/h3>/.test(eps.innerHTML), `Episodes counts the saved row and the endpoint's: ${eps.innerHTML.slice(0, 200)}`);

  const results = m.byId.get("sh-results");
  const total = m.evalIn("SHOW_RESULTS_PAINT_STEP") + 7;
  const shows = Array.from({ length: total }, (_, i) => ({ show_id: `sh${i}`, title: `Show ${i}` }));
  const token = m.evalIn("showSearchToken");
  m.evalIn("paintShowResults")("show", shows, token);
  assert.strictEqual(m.byId.get("sh-results-count").textContent, String(total), "every match, not the first page of rows");
  assert.ok((results.innerHTML.match(/<div class="row-show"><a class="show-result"/g) || []).length < total, "fixture: the list is paged, so the two numbers differ");

  const pls = m.byId.get("pl-search-results");
  m.store.set("cp_playlists", JSON.stringify([{ id: "p1", title: "Sleep Mix", items: [{ id: "e1", title: "Ep", topics: ["sleep"] }] }]));
  /* ...and one GENERATED candidate ("Sleep science", a leaf the listener likes,
     filled from the pool), so a count of the listener's own alone reads 1. */
  m.state.taxonomy = { nodes: [
    { id: "sleep", parent: null, label: "Sleep", weight: 0.5 },
    { id: "sleep/science", parent: "sleep", label: "Sleep science", weight: 0.5 },
  ] };
  m.state.interests = { "sleep/science": 0.8 };
  m.state.discover = { items: [1, 2, 3].map((i) => ({ id: `r${i}`, title: `Sleep ${i}`, show: `S${i}`, topics: ["sleep/science"], release_date: `2026-09-0${i}` })) };
  assert.strictEqual(m.evalIn("playlistSearchMatches")("sleep").generated.length, 1, "fixture: one generated candidate matches");
  m.evalIn("renderPlaylistSearchResults")("sleep", m.evalIn("showSearchToken"));
  assert.ok(/<h3>Playlists<span class="readout find-count">2<\/span><\/h3>/.test(pls.innerHTML), `Playlists counts own plus generated: ${pls.innerHTML.slice(0, 200)}`);
});

test("the page lists Shows, Episodes, Playlists, then Forays, with the Shows heading's count readout", () => {
  /* MUTATION: move `<div id="fy-search-results" hidden></div>` back above the
     Shows tier, or drop the count readout from the Shows heading. */
  const at = (needle) => {
    const i = APP_SRC.indexOf(needle);
    assert.ok(i >= 0, `the Find page template has ${needle}`);
    return i;
  };
  const shows = at('<div class="sh-tier">');
  const eps = at('<div id="ep-search-results" hidden></div>');
  const pls = at('<div id="pl-search-results" hidden></div>');
  const fy = at('<div id="fy-search-results" hidden></div>');
  assert.ok(shows < eps && eps < pls && pls < fy, "Shows, Episodes, Playlists, then the Forays the prototype has no group for");
  assert.ok(APP_SRC.includes('<h3 class="sh-results-head">Shows<span class="readout find-count" id="sh-results-count"></span></h3>'), "the Shows heading carries its count");
});

/* ----------------------------------------------------------- 3 the rows */

const ITEM = {
  id: "ep-1", title: "<b>x</b> Kola", show: "Stuff You Should Know", show_id: "sysk",
  audio_url: "https://cdn.test/ep-1.mp3", duration_min: 46, artwork_url: "https://is1-ssl.mzstatic.com/image/thumb/p/1/600x600bb.jpg",
};

test("an episode row trails ONE Play key, carries '+ Up Next' on the meta line, names the show in plain text and escapes the title", () => {
  /* MUTATION: put starBtn(item.id) back in the row (a second control: the single
     `<button` count and the missing data-star assertion fail), move upNextBtn out
     of `.row__meta`, wrap the show name in showNameLink, or interpolate the title
     without esc(). */
  const m = mount();
  const html = m.ctx.searchEpisodeRow(ITEM, "episode-search-x");
  assert.ok(!html.includes("<b>x</b>"), "the raw title never reaches the page");
  assert.ok(html.includes("&lt;b&gt;x&lt;/b&gt; Kola"), "it is escaped");
  assert.ok(html.includes('href="#/episode/ep-1"'), "the title opens the episode page");
  const buttons = html.match(/<button\b[^>]*>/g) || [];
  assert.strictEqual(buttons.length, 2, `exactly two controls, the Play key and "+ Up Next": ${buttons.join("")}`);
  assert.ok(!html.includes("data-star"), "no star: a second trailing control saving is on the episode page");
  const end = html.slice(html.indexOf('<div class="row__end">'));
  assert.ok(/<button type="button" class="keycap keycap--sm keycap--persimmon row-play" data-play="ep-1" data-ctx="episode-search-x" data-title="&lt;b&gt;x&lt;\/b&gt; Kola" aria-label="Play &lt;b&gt;x&lt;\/b&gt; Kola">/.test(end), `the one trailing key is a keycap sm carrying data-play: ${end}`);
  assert.ok(end.includes('href="#ph-play-fill"'), "with the drawn play icon, not a text glyph");
  const meta = html.slice(html.indexOf('<div class="row__meta">'), html.indexOf("</div>", html.indexOf('<div class="row__meta">')));
  assert.ok(meta.includes('data-upnext="ep-1"') && meta.includes("<span>Up Next</span>"), `"Up Next" sits on the meta line: ${meta}`);
  assert.ok(meta.includes('href="#ph-plus"'), "its glyph is Phosphor Bold's plus, drawn from the sprite");
  assert.ok(!meta.includes("+ Up Next") && !meta.includes("\u2713"), "no '+' or check mark typed into the text: the direction forbids Unicode glyphs as icons");
  assert.ok(meta.includes('data-upnext-icon="1" aria-label="Add to Up Next"'), "the icon form says so, and is named for the action");
  assert.ok(meta.includes('<span class="row__show">Stuff You Should Know</span>'), "the show is named in plain text");
  assert.ok(meta.includes('<span class="readout">46 min</span>'), "with the length as one readout");
  assert.ok(!html.includes('class="show-link"'), "the name is not a second link");
  assert.ok(!html.includes("#bridge"), "no bridge mark on a result row");
});

test("the eight fixture show names go through the display-name rule on the meta line", () => {
  /* MUTATION: drop `tactileDisplayName` from searchEpisodeRow (the meta then
     reads "Catalyst with Shayle Kann"), or drop the generic-noun strip from
     tactileDisplayName ("Lex Fridman Podcast"). */
  const m = mount();
  const names = ["Lex Fridman Podcast", "Titans of Nuclear", "omega tau", "CleanTechies Podcast", "Catalyst with Shayle Kann", "Lab to Market Leadership", "CBC Ideas", "Stuff You Should Know"];
  const shown = names.map((show, i) => {
    const html = m.ctx.searchEpisodeRow({ ...ITEM, id: `e${i}`, title: "T", show }, "ctx");
    return /<span class="row__show">([^<]*)<\/span>/.exec(html)[1];
  });
  assert.deepStrictEqual(shown, ["Lex Fridman", "Titans of Nuclear", "omega tau", "CleanTechies", "Catalyst", "Lab to Market Leadership", "CBC Ideas", "Stuff You Should Know"]);
  const rule = (show) => /<span class="row__show">([^<]*)<\/span>/.exec(m.ctx.searchEpisodeRow({ ...ITEM, show }, "ctx"))[1];
  assert.strictEqual(rule("The Partially Examined Life Philosophy Podcast"), "The Partially Examined Life", "the generic noun is not the name");
  assert.strictEqual(rule("Choiceology with Katy Milkman"), "Choiceology");
  assert.strictEqual(rule("The Podcast"), "The Podcast", "but nothing real is stripped to a bare article");
  assert.strictEqual(rule("Podcast"), "Podcast");
  const clause = m.ctx.searchEpisodeRow({ ...ITEM, show: "Lingthusiasm - A podcast that's enthusiastic about linguistics" }, "ctx");
  assert.ok(clause.includes('<span class="row__show">Lingthusiasm</span>'), "a trailing ' - ...' clause is dropped");
});

test("the show name keeps 112px and takes what the length and the action leave; the meta wraps only when even that cannot fit", () => {
  /* The 393 arithmetic, so the numbers are not folklore: 393 - 2x16 gutter - 56 art
     - 48 key - 2x12 gap = 233 for the body (the key is the prototype's 48 square).
     The length ("46 min", 49.9 measured in Chromium) and "Up Next" with its 16px
     icon and 4px gap (69.5) with their 4px gap and the 6px meta gap leave 103.6:
     BELOW the 112px BUILD-NOTES 3.9 / BUILD-PLAN 2.10 floor, so at 393 and at 375
     (215) the length and the action drop to a second line TOGETHER, and the name
     keeps its 112 on the first. A 96px floor (the earlier iteration's trade for the
     48 key) kept the 393 row on one line but is not the specified number; the
     review of this branch held the spec.
     MUTATION: set `.row__show`'s min-width back to 96px (or 72px, the r2 value that
     cut six of eight names at 393), or its flex-basis to `auto` (a long name then
     wraps the tail before it ellipsises). Each fails the two assertions below. */
  const show = rule("body.view-find .row-episode .row__show");
  assert.strictEqual(show["min-width"], "112px", "BUILD-NOTES 3.9: the name keeps 112px");
  assert.strictEqual(show.flex, "1 1 112px", "basis 112: a name only forces a wrap when 112 itself cannot fit");
  assert.strictEqual(rule("body.view-find .row-episode .row__meta")["flex-wrap"], "wrap");
  assert.strictEqual(rule("body.view-find .row-episode .row__tail").flex, "none", "length and action travel as one");
  const play = rule("body.view-find .row-episode .row-play");
  assert.strictEqual(play.width, "var(--key)", "the Play key is the prototype's 48 square, not the 44 tap target");
  assert.strictEqual(play.height, "var(--key)");
  assert.strictEqual(play["min-width"], "var(--key)", "the primitive's `--sm` min-width (44) must not win");
  assert.strictEqual(rule(":root")["--key"], "48px");
  assert.strictEqual(rule(".row-episode")["grid-template-columns"], "var(--art-row) minmax(0, 1fr) auto");
  assert.strictEqual(rule(":root")["--art-row"], "56px");
  assert.strictEqual(rule(":root")["--tap"], "44px");
  assert.strictEqual(rule("body.view-find .row-episode .row__title").font, "var(--w-label) var(--t-body)/var(--lh-body) var(--font-text)", "the row title restates its font: it sits inside `.ep-more`, whose legacy h3 rule would shrink it to 11.84px");
  assert.strictEqual(rule("body.view-find .row-episode")["min-height"], "0");
  assert.strictEqual(rule("body.view-find .row-episode").padding, "0");
});

test("Shows rows are .row-show (56) around the same .show-result link, with the station code on blank art", () => {
  /* MUTATION: drop the `.row-show` wrapper in paintShowResults (the show-row
     heights go back to the legacy card), or the data-i on the blank art. */
  const m = mount();
  m.evalIn("paintShowResults")("show", [{ show_id: "a", title: "Alpha Beta" }], m.evalIn("showSearchToken"));
  const html = m.byId.get("sh-results").innerHTML;
  assert.ok(/^<div class="row-show"><a class="show-result" href="#\/show\/a" title="Alpha Beta">/.test(html.trim()), `the link every other list of shows uses, wrapped: ${html}`);
  assert.ok(html.includes('class="show-result-art show-result-art-blank" data-i="AB"'), "the station code stands in for missing artwork");
  assert.strictEqual(rule(".row-show")["min-height"], "var(--row-show)");
  assert.strictEqual(rule(":root")["--row-show"], "56px");
  assert.strictEqual(rule("body.view-find .row-show > .show-result")["min-height"], "var(--row-show)");
  assert.strictEqual(rule("body.view-find .row-show .show-result-title")["-webkit-line-clamp"], "1", "one line, the whole name on the row's title attribute");
});

test("a playlist is a card: a collage of its shows' covers, its name and length, two to a row", () => {
  /* MUTATION: draw the cards one per row (`.pgrid` columns `1fr`), or render the
     title without esc(). */
  const m = mount();
  m.state.catalog = { shows: [{ show_id: "sh", title: "S", artwork_url: "https://is1-ssl.mzstatic.com/image/thumb/p/9/600x600bb.jpg" }] };
  m.store.set("cp_playlists", JSON.stringify([{ id: "p1", title: "<i>Mix</i> of sleep", items: [{ id: "a", title: "A", show: "S", show_id: "sh", topics: ["sleep"] }, { id: "b", title: "B", show: "S", show_id: "sh", topics: ["sleep"] }] }]));
  m.evalIn("renderPlaylistSearchResults")("sleep", m.evalIn("showSearchToken"));
  const html = m.byId.get("pl-search-results").innerHTML;
  assert.ok(html.includes('<a class="pcard pl-card" href="#/playlist/p1">'), `a card, linking the playlist: ${html}`);
  assert.ok(html.includes("&lt;i&gt;Mix&lt;/i&gt; of sleep") && !html.includes("<i>Mix</i>"), "its name is escaped");
  assert.ok(html.includes('class="find-collage find-collage--card'), "with a collage");
  assert.ok(html.includes('<span class="readout muted">2 episodes</span>'), "and its length as a readout");
  assert.strictEqual(rule("body.view-find .pgrid")["grid-template-columns"], "1fr 1fr");
  assert.strictEqual(rule("body.view-find .pgrid").gap, "var(--gap)");
});

/* ----------------------------------------------------- 4 field and note */

test("the clear key is shown once there is a query, and the settled 'No shows found' line says what it is", () => {
  /* MUTATION: leave `dismiss.hidden` true whatever the field holds, or write the
     note's state as "empty" while the passes are still owed (the "Searching for"
     line would then be dropped as if it were an answer). */
  const m = mount();
  m.ctx.renderAllShows();
  const input = m.byId.get("sh-input");
  input.value = "";
  m.evalIn("updateShowBrowseVisibility")();
  assert.strictEqual(m.byId.get("sh-dismiss").hidden, true, "nothing to clear");
  input.value = "kola";
  m.evalIn("updateShowBrowseVisibility")();
  assert.strictEqual(m.byId.get("sh-dismiss").hidden, false, "a query makes the clear key appear");
  assert.strictEqual(rule("body.view-find #sh-dismiss").width, "var(--tap)");
  assert.strictEqual(rule("body.view-find #sh-dismiss").height, "var(--tap)");

  const note = m.byId.get("sh-note");
  const token = m.evalIn("showSearchToken");
  m.evalIn("paintShowResults")("kola", [], token);
  assert.strictEqual(note.dataset.state, "searching", "with passes still owed it says it is searching");
  m.evalIn("showSearchSettled = { token: showSearchToken, query: 'kola' }");
  m.evalIn("paintShowResults")("kola", [], token);
  assert.strictEqual(note.dataset.state, "empty", "once every pass has answered it is a settled 'none'");
  assert.ok(/No shows found/.test(note.textContent));
  assert.ok(TYPING_CSS.includes('#sh-note[data-state="empty"]:is(:has(~ #ep-search-results:not([hidden])), :has(~ #pl-search-results .fy-playlist-search), :has(~ #fy-search-results:not([hidden])))'), "and only that line gives way, to an Episodes, Playlists or Forays group that answered");
});

/* ---------------------------------------------------- 5 the player repaint */

test("a row's Play key keeps its icon when the player repaints it: the <use> swaps, no text is written", () => {
  /* MUTATION: have syncCardButtons call paintControl(b, ...) again for every
     button (the old line). The key's textContent becomes "❚❚" and its <use> never
     changes, so both assertions fail. */
  const fnSrc = (name) => {
    const start = CLIENT_SRC.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `player/client.js has no function ${name}`);
    let depth = 0;
    for (let i = CLIENT_SRC.indexOf("{", start); i < CLIENT_SRC.length; i++) {
      if (CLIENT_SRC[i] === "{") depth++;
      else if (CLIENT_SRC[i] === "}" && --depth === 0) return CLIENT_SRC.slice(start, i + 1);
    }
    throw new Error(`unbalanced ${name}`);
  };
  const attrs = new Map();
  const use = { attrs: new Map([["href", "#ph-play-fill"]]), getAttribute(k) { return this.attrs.get(k) ?? null; }, setAttribute(k, v) { this.attrs.set(k, v); } };
  const key = {
    dataset: { play: "e-1", title: "Kola" }, textContent: "", _text: 0,
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null), setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k),
    querySelector: (sel) => (sel === "use" ? use : null),
  };
  let text = "";
  Object.defineProperty(key, "textContent", { get: () => text, set: (v) => { text = v; } });
  const glyph = { dataset: { play: "e-2", title: "Other" }, textContent: "▶", getAttribute: () => null, setAttribute() {}, removeAttribute() {}, querySelector: () => null };
  const ctx = { current: { id: "e-1" }, transportIsRunning: () => true, document: { querySelectorAll: () => [key, glyph] } };
  vm.createContext(ctx);
  for (const n of ["paintControl", "paintCardControl", "syncCardButtons"]) vm.runInContext(fnSrc(n), ctx);
  ctx.syncCardButtons();
  assert.strictEqual(use.getAttribute("href"), "#ph-pause-fill", "the keycap's drawn icon swaps to pause");
  assert.strictEqual(key.textContent, "", "and no text glyph is written over it");
  assert.strictEqual(attrs.get("aria-label"), "Pause Kola", "its name follows in the same write");
  assert.strictEqual(glyph.textContent, "▶", "a legacy glyph button on another row is left as it was");
  ctx.transportIsRunning = () => false;
  ctx.syncCardButtons();
  assert.strictEqual(use.getAttribute("href"), "#ph-play-fill", "and back to play when it stops");
  assert.strictEqual(attrs.get("aria-label"), "Play Kola");
});

/* --------------------------------------------------------- 6 the harness */

test("the harness has a settled typing step appended after the four it already had, and the screen map points at it with the key as a region", () => {
  /* MUTATION: delete the appended step, or reorder it ahead of the existing
     four (fidelity.mjs refuses a map naming a step that is gone, and the labels
     below fail in order). */
  const states = fs.readFileSync(path.join(ROOT, "tools", "ui-lab", "lib", "states.mjs"), "utf8").replace(/\r\n/g, "\n");
  const block = states.slice(states.indexOf('id: "search",'), states.indexOf('id: "stress",'));
  const labels = [...block.matchAll(/label: "([^"]+)"/g)].map((x) => x[1]);
  assert.deepStrictEqual(labels, ["search-idle", "search-results-fusion", "search-results-history", "search-no-results", "search-results-typing"], "the existing four keep their order; the new one is appended");
  assert.ok(/typeSearchThenReturn\(page, "geoengineering"\)/.test(block), "it types a query with one saved episode, no show and a buildable subject, then presses return so the field lets go and the deck is back");
  assert.ok(/await page\.press\("#sh-input", "Enter"\)/.test(states), "return is how a phone keyboard puts the field away");
  const map = readJson("docs/redesign-2026/directions/tactile/screens.json").screens["search-typing"];
  assert.deepStrictEqual(map.app, { state: "search", step: "search-results-typing" });
  assert.strictEqual(map.regions.primary.app, ".sh-create-cta .keycap");
  assert.strictEqual(map.regions.primary.prototype, "#results .keycap--ultramarine");
  assert.strictEqual(map.regions.rows.app, "#sh-results .row-show, #ep-search-results .row-episode");
});

/* ---------------------------------------------------------- 7 the block */

test("the typing block reads tokens only and adds no transition or animation the one reduced-motion block would have to name", () => {
  /* MUTATION: hard-code a hex in `.pcard`, or add `transition: transform .2s` to
     it. */
  assert.ok(TYPING_START > 0 && TYPING_END > TYPING_START, "the typing block is delimited");
  const rules = TYPING_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.deepStrictEqual(rules.match(/#[0-9a-fA-F]{3,8}\b/g) || [], [], "no hex literal: every colour is a token");
  assert.ok(!/\btransition\b|\banimation\b|@keyframes/.test(rules), "no motion of its own");
  assert.ok(!/!important/.test(rules), "specificity, not !important, wins against the legacy rules");
  const searchJs = fs.readFileSync(path.join(ROOT, "ui", "search.js"), "utf8");
  const from = searchJs.indexOf("function searchEpisodeRow");
  assert.ok(!/\bstyle=/.test(searchJs.slice(from, searchJs.indexOf("function paintEpisodeSearchResults", from))), "no inline style in the row markup");
});

/* ----------------------------------------------------- 5 the hrefs the typing results write */

/* THE RULE, AND WHY THESE TWO HREFS DO NOT CALL safeUrl. CLAUDE.md: every href goes
 * through safeUrl(). safeUrl gates SCHEMES (it runs `new URL`), and on a bare hash
 * route it answers "#" (app.js safeUrl; ui/browse.js `browseTile` documents the same),
 * so wrapping `#/playlist/p1` would turn every playlist card and every episode title
 * into a dead "#" link. The repo's answer, which app-security's census and `playlistRoute`
 * both state, is that an in-app route keeps its `#/` LITERAL in the template and only a
 * percent-encoded path is interpolated after it: no scheme can be injected because the
 * href can only ever begin `#/`. These tests pin exactly that, on hostile ids, so the
 * rule is held by a test rather than by a reading of the template.
 *
 * MUTATION 1: in `renderPlaylistSearchResults` change `href="#/${esc(playlistRoute(p))}"`
 *   to `href="${esc(playlistRoute(p))}"` (the prefix interpolated) -> the census and the
 *   card test fail.
 * MUTATION 2: in `searchEpisodeRow` drop `encodeURIComponent` from the title link ->
 *   the `a/b#c?d%e` id leaks a raw `/`, `#`, `?` and `%` into the route and the
 *   episode test fails.
 * MUTATION 3: in the card, replace `playlistRoute(p)` with `"playlist/" + p.id` -> the
 *   `gen-history/technology` id keeps its slash and the card test fails. */
test("the playlist card and the episode title link keep a literal #/ and an encoded path, on hostile ids", () => {
  const m = mount();
  m.state.catalog = { shows: [{ show_id: "sh", title: "S" }] };
  const hostileId = 'gen-history/technology" onclick="x';
  m.store.set("cp_playlists", JSON.stringify([{ id: hostileId, title: "Mix of sleep", items: [{ id: "a", title: "A", show: "S", show_id: "sh", topics: ["sleep"] }] }]));
  m.evalIn("renderPlaylistSearchResults")("sleep", m.evalIn("showSearchToken"));
  const html = m.byId.get("pl-search-results").innerHTML;
  const hrefs = [...html.matchAll(/<a class="pcard pl-card" href="([^"]*)"/g)].map((x) => x[1]);
  assert.strictEqual(hrefs.length, 1, `one card, and its href is one attribute (a quote in the id did not end it): ${html}`);
  assert.strictEqual(hrefs[0], "#/playlist/gen-history%2Ftechnology%22%20onclick%3D%22x", "literal #/, then the encoded id");
  assert.ok(!/onclick="/.test(html), "the hostile id grew no attribute");

  const row = m.ctx.searchEpisodeRow({ ...ITEM, id: "a/b#c?d%e" }, "ctx");
  const link = /<a class="ep-title-link" href="([^"]*)"/.exec(row);
  assert.ok(link, `the title link: ${row}`);
  assert.strictEqual(link[1], "#/episode/a%2Fb%23c%3Fd%25e", "a `/`, `#`, `?` and `%` in an id cannot break the route");
  const scheme = m.ctx.searchEpisodeRow({ ...ITEM, id: "javascript:alert(1)" }, "ctx");
  assert.ok(scheme.includes('href="#/episode/javascript%3Aalert(1)"'), `a scheme-shaped id stays a path segment: ${scheme}`);

  /* The reason safeUrl is not the guard here, asserted so the comment above cannot rot. */
  assert.strictEqual(m.ctx.safeUrl("#/playlist/p1"), "#", "safeUrl would kill an in-app route");
});

test("every interpolated href in ui/search.js opens with a literal #/ or goes through safeUrl", () => {
  /* The census app-security.test.js runs over app.js, scoped to this file and widened
     one step: an href that OPENS with an interpolation must name safeUrl. MUTATION: see
     MUTATION 1 above (or add `href="${esc(url)}"` anywhere in ui/search.js). */
  const searchJs = fs.readFileSync(path.join(ROOT, "ui", "search.js"), "utf8");
  const hrefs = searchJs.match(/\b(?:href|src)\s*=\s*"[^"\n]*\$\{[^}]*\}[^"\n]*"/g) || [];
  assert.ok(hrefs.length >= 3, `expected the show, playlist and episode links to be seen, saw ${hrefs.length}`);
  const bad = hrefs.filter((h) => !/=\s*"#\//.test(h) && !h.includes("safeUrl("));
  assert.deepStrictEqual(bad, [], `these href/src interpolations are neither a literal #/ route nor safeUrl'd:\n${bad.join("\n")}`);
});
