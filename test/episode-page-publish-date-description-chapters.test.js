/* Kanban t_d5079285 (recreated — was mistakenly archived as t_623d16a7) —
 * episode page: publish date, full description, chapters, and show-page
 * newest-first sort. Requirements A1.1 (full episode description), A1.2
 * (publish date), A1.5 (chapters), and Joey's Q7 answer ("Newest first, no
 * filter for now") from show-episode-pages-requirements-DRAFT.md, built on
 * top of Stage 3b (kanban t_567b570f, docs/show-pages-plan.md).
 *
 * WHAT THIS PROVES, in order:
 *  1. epRow/archivedRow render a plain-English publish date when
 *     `release_date` is present, and render nothing extra when it's absent
 *     (never "Invalid Date").
 *  2. renderEpisode renders the full publisher description ADDITIVELY next
 *     to 4a's curated `hook` — neither one replaces the other.
 *  3. renderEpisode renders chapter markers in their own section, entirely
 *     separate from any foray-segment markup/classes.
 *  4. episodesForShow (the show page's episode list) sorts newest-first by
 *     release_date, per Joey's Q7 answer — with no filter controls added.
 *  5. fullCatalogueRowToEpRowItem (Stage 3b's per-show endpoint rows) carries
 *     published_at/description_text/chapters straight through so the same
 *     rendering logic above works uniformly for full-catalogue episodes too.
 *
 * Every test names the mutation that kills it, per CLAUDE.md "a green test
 * is not evidence until you have broken it".
 *
 * Harness: the same minimal node:vm DOM stub every show-page suite in this
 * repo uses, duplicated rather than imported (fixture-scoped, not a shared
 * module, matching the existing convention in this test/ directory).
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");

process.on("unhandledRejection", () => {});

function makeEl(tag) {
  return {
    tagName: String(tag || "div").toUpperCase(),
    id: null, className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    appendChild(k) { this.children.push(k); return k; },
    append(...k) { this.children.push(...k); },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, select() {}, click() {},
    remove() {},
  };
}

const PAGE_IDS = [
  "view", "drawer", "drawer-overlay", "drawer-playlists", "family-toggle",
  "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn", "banner-slot", "pl-form",
  "pl-input", "pl-note", "tab-topics", "tab-shows", "sh-form", "sh-input",
  "sh-note", "sh-results", "browse-all-link",
];

function mount() {
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = makeEl("div");
    el.id = id;
    return [id, el];
  }));
  const body = makeEl("body");

  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: () => new Promise(() => {}), // init() never resolves; tests drive state directly
    localStorage: {
      get length() { return 0; },
      key: () => null, getItem: () => null, setItem() {}, removeItem() {},
    },
    document: {
      body, documentElement: body, readyState: "complete",
      addEventListener() {}, createElement: (t) => makeEl(t),
      querySelector: (sel) => {
        const s = String(sel);
        return s.startsWith("#") ? byId.get(s.slice(1)) ?? null : null;
      },
      querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" },
    addEventListener() {}, removeEventListener() {},
    location: { hash: "#/", search: "", pathname: "/", href: "https://x.test/" },
    history: { replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });

  return {
    ctx,
    state: vm.runInContext("state", ctx),
    view: () => byId.get("view").innerHTML,
  };
}

/* ==================================================================== */
/* 1. PUBLISH DATE ON epRow / archivedRow                                */
/* ==================================================================== */

test("epRow renders a plain-English publish date when release_date is present", () => {
  /* MUTATION: drop the `${dateStr ? ...}` branch from epRow's template.
     This assertion fails because no date text appears in the row. */
  const m = mount();
  const item = { id: "e1", title: "Ep One", show: "Some Show", duration_min: 10, release_date: "2026-01-15", audio_url: "https://example.com/a.mp3" };
  const html = m.ctx.epRow(item, 0, "ctx", -1);
  assert.match(html, /Jan 15, 2026/, `expected a formatted publish date, got: ${html}`);
});

test("epRow renders nothing extra (no 'Invalid Date') when release_date is absent", () => {
  const m = mount();
  const item = { id: "e2", title: "Ep Two", show: "Some Show", duration_min: 10, audio_url: "https://example.com/a.mp3" };
  const html = m.ctx.epRow(item, 0, "ctx", -1);
  assert.ok(!html.includes("Invalid Date"), "must never render a literal Invalid Date");
});

test("archivedRow renders a plain-English publish date for a named (gone) episode", () => {
  /* MUTATION: drop the dateStr branch from archivedRow's template. */
  const m = mount();
  const item = { id: "e3", title: "Ep Three", show: "Some Show", duration_min: 12, release_date: "2025-11-03", apple_collection_id: 42 };
  const html = m.ctx.archivedRow(item, 0, "ctx");
  assert.match(html, /Nov 3, 2025/, `expected a formatted publish date, got: ${html}`);
});

/* ==================================================================== */
/* 2. FULL DESCRIPTION ON renderEpisode — ADDITIVE TO hook               */
/* ==================================================================== */

test("renderEpisode renders both the curated hook AND the full publisher description", () => {
  /* MUTATION: replace item.hook with item.description in the fp-s-why
     paragraph (i.e. the description REPLACING the hook instead of being
     additive). This assertion fails because the hook text disappears. */
  const m = mount();
  m.state.itemIndex = {
    "ep-1": {
      id: "ep-1", title: "Ep One", show: "Some Show", duration_min: 20,
      hook: "4a own curated one-liner", description: "The publisher's own full episode description, much longer.",
      audio_url: "https://example.com/a.mp3",
    },
  };
  m.ctx.renderEpisode("ep-1");
  const html = m.view();
  assert.ok(html.includes("4a own curated one-liner"), "hook must still render");
  assert.ok(html.includes("The publisher&#39;s own full episode description, much longer."), "full description must render");
  assert.ok(html.includes('class="ep-description"'), "description must be its own section");
});

test("renderEpisode renders no description section when description is absent (curated-pool-only episode)", () => {
  const m = mount();
  m.state.itemIndex = {
    "ep-2": { id: "ep-2", title: "Ep Two", show: "Some Show", hook: "Just a hook", audio_url: "https://example.com/a.mp3" },
  };
  m.ctx.renderEpisode("ep-2");
  const html = m.view();
  assert.ok(!html.includes('class="ep-description"'), "must not render an empty description section");
});

/* ==================================================================== */
/* 3. CHAPTERS — GENUINELY SEPARATE FROM FORAY SEGMENTS                  */
/* ==================================================================== */

test("renderEpisode renders chapter markers in their own section with their own classes", () => {
  /* MUTATION: drop episodeChaptersHtml(item) from renderEpisode's template.
     This assertion fails because no chapters text appears. */
  const m = mount();
  m.state.itemIndex = {
    "ep-3": {
      id: "ep-3", title: "Ep Three", show: "Some Show", hook: "hook",
      audio_url: "https://example.com/a.mp3",
      chapters: [
        { title: "Intro", start_time_seconds: 0 },
        { title: "Main topic", start_time_seconds: 125 },
      ],
    },
  };
  m.ctx.renderEpisode("ep-3");
  const html = m.view();
  assert.ok(html.includes('class="ep-chapters"'), "chapters must render in their own section");
  assert.ok(html.includes("Intro"), "must render each chapter title");
  assert.ok(html.includes("Main topic"), "must render each chapter title");
  assert.ok(!html.includes("segment-strip"), "chapters must never reuse foray segment-strip markup");
});

test("renderEpisode renders no chapters section when chapters is null (Stage 3b's lazy-fetch default)", () => {
  const m = mount();
  m.state.itemIndex = {
    "ep-4": { id: "ep-4", title: "Ep Four", show: "Some Show", hook: "hook", audio_url: "https://example.com/a.mp3", chapters: null },
  };
  m.ctx.renderEpisode("ep-4");
  const html = m.view();
  assert.ok(!html.includes('class="ep-chapters"'), "must not render an empty chapters section");
});

/* ==================================================================== */
/* 4. SHOW PAGE: NEWEST-FIRST SORT, NO FILTER (Joey's Q7 answer)         */
/* ==================================================================== */

test("episodesForShow sorts the curated-pool episode list newest-first by release_date", () => {
  /* MUTATION: drop the `.sort(...)` call from episodesForShow. This
     assertion fails because the episodes come back in discover.json's
     insertion order instead of by recency. */
  const m = mount();
  m.state.discover = {
    items: [
      { id: "old", show: "Show A", title: "Old Ep", release_date: "2020-01-01" },
      { id: "new", show: "Show A", title: "New Ep", release_date: "2026-06-01" },
      { id: "mid", show: "Show A", title: "Mid Ep", release_date: "2023-03-15" },
    ],
  };
  const show = { show_id: "show-a", title: "Show A" };
  const result = m.ctx.episodesForShow(show).map((e) => e.id);
  assert.deepStrictEqual(result, ["new", "mid", "old"], `expected newest-first order, got: ${result}`);
});

test("episodesForShow sorts an item with a missing release_date to the end, never throwing", () => {
  const m = mount();
  m.state.discover = {
    items: [
      { id: "no-date", show: "Show A", title: "No Date Ep" },
      { id: "new", show: "Show A", title: "New Ep", release_date: "2026-06-01" },
    ],
  };
  const show = { show_id: "show-a", title: "Show A" };
  let result;
  assert.doesNotThrow(() => { result = m.ctx.episodesForShow(show).map((e) => e.id); });
  assert.deepStrictEqual(result, ["new", "no-date"]);
});

/* ==================================================================== */
/* 5. STAGE 3B ROWS CARRY release_date/description/chapters THROUGH      */
/* ==================================================================== */

test("fullCatalogueRowToEpRowItem passes published_at/description_text/chapters through to the snapshot", () => {
  /* MUTATION: drop any of release_date/description/chapters from
     fullCatalogueRowToEpRowItem's snapshot() call. Whichever field is
     dropped comes back null/undefined here instead of matching the input. */
  const m = mount();
  const show = { show_id: "show-a", title: "Show A" };
  const ep = {
    guid: "g1", title: "Full Ep", description_text: "The full RSS description.",
    audio_url: "https://cdn.example.com/full1.mp3", duration_seconds: 600,
    published_at: "2026-02-03T00:00:00.000Z",
    chapters: [{ title: "Ch 1", start_time_seconds: 10 }],
  };
  const item = m.ctx.fullCatalogueRowToEpRowItem(show, ep);
  assert.strictEqual(item.release_date, "2026-02-03T00:00:00.000Z");
  assert.strictEqual(item.description, "The full RSS description.");
  assert.deepStrictEqual(item.chapters, [{ title: "Ch 1", start_time_seconds: 10 }]);
});

test("fullCatalogueRowToEpRowItem renders a real epRow with the publish date once mapped", () => {
  const m = mount();
  const show = { show_id: "show-a", title: "Show A" };
  const ep = {
    guid: "g1", title: "Full Ep", description_text: "desc",
    audio_url: "https://cdn.example.com/full1.mp3", duration_seconds: 600,
    published_at: "2026-02-03T00:00:00.000Z",
  };
  const item = m.ctx.fullCatalogueRowToEpRowItem(show, ep);
  const html = m.ctx.epRow(item, 0, "ctx", -1);
  assert.match(html, /Feb 3, 2026/, `expected the full-catalogue row to show its publish date, got: ${html}`);
});
