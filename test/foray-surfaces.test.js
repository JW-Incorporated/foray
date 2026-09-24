/* The Foray's LIST surfaces: what the Forays list, Library and Home's cards say
 * about a Foray before its own page opens (audit round 2, lane L8).
 *
 *   honesty-2   a finished Foray left no trace anywhere (its row was cleared at
 *               the end), while a finished episode says "Played" on every row.
 *               Its rows now say "Played"; Jump back in still leaves it out
 *               (founder question 3: finished things leave the rail).
 *   honesty-12  Library read its "N min left" from the Home rail's 3-row cap, so
 *               a fourth part-played Foray had an empty subtitle, and a
 *               part-played draft's label REPLACED its "draft" tag.
 *   p-foray-8   nothing before the Foray page said how long a Foray was; every
 *               row and card now carries "51 min · 22 clips · 7 shows".
 *   p-foray-2   every show credited on the published Foray was plain text with
 *               an arrow labelled "Open X on Apple Podcasts" that opened a
 *               SEARCH; credits now join the show index and the arrow says
 *               where it goes.
 *   p-first-11  the sentence explaining a Foray promised a narrator above the
 *               one listed Foray, which has none, and the intro popup claimed a
 *               stretch Foray that one listed Foray cannot produce.
 *
 * The player's half (the finished row written at the end, `progressLabel`) is
 * pinned in player/foray-progress.test.js and player/transport-reconcile.test.js.
 * This is the PAGE's half, over the REAL resolver and strip modules and the
 * FROZEN fixture (tools/foray/fixtures/frozen/), with the resume list faked
 * because which rows exist is the player's answer, not the page's.
 *
 * Harness: the node:vm DOM stub of test/foray-ribbon-restore.test.js.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8").replace(/\r\n/g, "\n");
const FROZEN = path.join(ROOT, "tools/foray/fixtures/frozen/data");
const readFrozen = (f) => JSON.parse(fs.readFileSync(path.join(FROZEN, f), "utf8"));

const mods = (async () => ({
  resolve: await import("../player/foray-resolve.js"),
  strip: await import("../player/segment-strip.js"),
  progress: await import("../player/foray-progress.js"),
}))();

/** A bridge over the real modules. `rows` is what `forayResumeList` answers:
    `[id, { remainingSec } | { finished: true }]`, labelled through the REAL
    `progressLabel`, so the page is tested against the player's own words. */
async function realBridge(rows = []) {
  const { resolve, strip, progress } = await mods;
  return {
    resolve(doc, { id, segmentsDoc, sourcesDoc, unlocked = [], showDrafts = false } = {}) {
      const f = resolve.findForay(doc, id, { unlocked, showDrafts });
      return f ? resolve.resolveForay(f, { segments: resolve.indexSegments(segmentsDoc), sources: resolve.indexSources(sourcesDoc) }) : null;
    },
    listForays: (doc, opts) => resolve.listableForays(doc, opts),
    stripTally: strip.stripTally,
    segmentStripHtml: strip.segmentStripHtml,
    fmtClock: resolve.fmtClock,
    fmtSpan: resolve.fmtSpan,
    forayResumeList: () => rows.map(([id, p], i) => {
      const point = p.finished
        ? { finished: true, percent: 100, remainingSec: 0 }
        : { finished: false, percent: 40, remainingSec: p.remainingSec };
      return {
        id, title: id, updated_at: `2026-09-2${i}T00:00:00Z`, percent: point.percent,
        finished: point.finished, drift: "unverified", label: progress.progressLabel(point),
      };
    }),
  };
}

function loadApp(bridge, { showDrafts = true, created = [] } = {}) {
  const noop = () => {};
  function makeEl() {
    const el = {
      addEventListener: noop, removeEventListener: noop, appendChild: noop, append: noop,
      setAttribute: noop, removeAttribute: noop,
      classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
      style: {}, dataset: {}, children: [], hidden: false,
      innerHTML: "", textContent: "", className: "",
      querySelector: () => makeEl(), querySelectorAll: () => [],
    };
    created.push(el);
    return el;
  }
  const store = new Map();
  if (showDrafts) store.set("cp_show_drafts", "true");
  const ctx = {
    console,
    fetch: () => new Promise(() => {}),
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: {
      body: makeEl(), documentElement: makeEl(),
      addEventListener: noop, createElement: makeEl,
      /* No intro sheet is mounted yet: the popup's duplicate guard asks. */
      querySelector: (sel) => (sel === "#intro-sheet" ? null : makeEl()), querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" },
    location: { hash: "#/library", href: "https://example.test/#/library" },
    history: { replaceState: noop, pushState: noop },
    CSS: { escape: (s) => String(s) },
    URL, Math, Date, JSON, Promise, setTimeout, clearTimeout,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.ForayPlayer = bridge;
  vm.createContext(ctx);
  process.on("unhandledRejection", noop);
  vm.runInContext(SRC, ctx, { filename: "app.js" });
  ctx.__docs = { forays: readFrozen("forays.json"), segments: readFrozen("segments.json"), sources: readFrozen("segment-sources.json") };
  vm.runInContext("state.forays = __docs.forays; state.segments = __docs.segments; state.segmentSources = __docs.sources;", ctx);
  return ctx;
}

/** Library's Foray rows as [title, sub] pairs, read from the markup. */
function libraryRows(html) {
  return [...html.matchAll(/<div class="t">([^<]*)<\/div>\s*<div class="s">([^<]*)<\/div>/g)].map((m) => [m[1], m[2]]);
}

const FROZEN_IDS = readFrozen("forays.json").forays.map((f) => f.id);

test("Library labels EVERY part-played Foray, not the Home rail's first three (honesty-12)", async () => {
  /* Four Forays part-played; the rail shows three. KILLING MUTATION: build
     Library's labels from `forayResumeRows()` (the rail's default, capped at 3)
     again. The fourth row's "min left" goes and this is red. */
  assert.equal(FROZEN_IDS.length, 4, "fixture: four Forays, all listed with the test track on");
  const rows = FROZEN_IDS.map((id, i) => [id, { remainingSec: 600 * (i + 1) }]);
  const app = loadApp(await realBridge(rows));
  assert.equal(app.forayResumeRows().length, 3, "the rail keeps its own cap");
  const lib = libraryRows(app.libraryForaysHtml());
  assert.equal(lib.length, 4);
  for (const [title, sub] of lib) assert.match(sub, /\d+ min left/, `every part-played row says how far: ${title} -> "${sub}"`);
});

test("a part-played draft keeps its 'draft' tag beside its progress (honesty-12)", async () => {
  /* KILLING MUTATION: go back to `progress.get(f.id) || "draft"` — the label
     replaces the tag and the first assertion is red. */
  const draft = readFrozen("forays.json").forays.find((f) => f.status !== "published");
  const app = loadApp(await realBridge([[draft.id, { remainingSec: 1200 }]]));
  const row = libraryRows(app.libraryForaysHtml()).find(([t]) => t === draft.title);
  assert.ok(row, "the draft is listed");
  assert.match(row[1], /^draft · 20 min left · /, `draft AND progress: "${row[1]}"`);
});

test("a finished Foray says 'Played' on its rows and leaves Jump back in (honesty-2, founder Q3)", async () => {
  /* KILLING MUTATION 1: drop `includeFinished: true` from forayProgressLabels —
     the finished row falls through to no label, red. KILLING MUTATION 2: let
     the rail include finished rows (`includeFinished = true` default) — the
     rail assertion is red. */
  const app = loadApp(await realBridge([["capital-types-1", { finished: true }]]));
  assert.deepEqual([...app.forayResumeRows()].map((p) => p.id), [], "finished things leave Jump back in");
  const row = libraryRows(app.libraryForaysHtml()).find(([t]) => /types of capital/.test(t));
  assert.ok(row, "capital-types-1 is listed");
  assert.match(row[1], /^Played · /, `Library: "${row[1]}"`);
  const list = app.forayListHtml();
  const cap = /href="#\/foray\/capital-types-1">[\s\S]*?<\/a>/.exec(list)[0];
  assert.match(cap, /<span class="fy-home-sub">Played · /, `the Forays list row: ${cap}`);
});

test("every list row and Home card says how long a Foray is and what it is made of (p-foray-8)", async () => {
  /* capital-types-1 in the frozen fixture: 22 clips of measured tape from 7
     shows. KILLING MUTATION: drop the sub line from forayListHtml (or the
     `facts` span from forayCardV2Html) — red. */
  const { resolve } = await mods;
  const app = loadApp(await realBridge());
  const doc = resolve.findForay(readFrozen("forays.json"), "capital-types-1", {});
  const r = resolve.resolveForay(doc, { segments: resolve.indexSegments(readFrozen("segments.json")), sources: resolve.indexSources(readFrozen("segment-sources.json")) });
  const facts = `${resolve.fmtSpan(r.totalSec)} · 22 clips · 7 shows`;
  assert.match(facts, /^\d+ min · /, `a length in minutes: "${facts}"`);

  const list = app.forayListHtml();
  const row = /href="#\/foray\/capital-types-1">[\s\S]*?<\/a>/.exec(list)[0];
  assert.ok(row.includes(`<span class="fy-home-sub">${facts}</span>`), `the Forays list row: ${row}`);

  const card = app.forayCardV2Html(doc);
  assert.ok(card.includes(`<span class="hv2-foray-sub">${facts}</span>`), `the Home card: ${card.slice(0, 400)}`);

  const lib = libraryRows(app.libraryForaysHtml()).find(([t]) => t === doc.title);
  assert.equal(lib[1], facts, "an unopened Foray's Library row is its length and makeup");
});

test("a narrated Foray's length is hedged on every list surface, and counts the narrator's clips (p-foray-8, states-11)", async () => {
  /* The frozen fixture's one generated Foray: 56 items, 40 narration bridges
     timed from their scripts. KILLING MUTATION: drop the `about` branch from
     forayRuntimeLabel — red. */
  const id = "what-engineers-actually-do-all-day-e08236";
  const app = loadApp(await realBridge());
  const list = app.forayListHtml();
  const row = new RegExp(`href="#/foray/${id}">[\\s\\S]*?</a>`).exec(list)[0];
  assert.match(row, /<span class="fy-home-sub">about \d+ min · 56 clips · \d+ shows?<\/span>/, row);
});

/* ---------- p-first-11: the sentences ABOUT Forays say only what the list does ---------- */

test("the Foray explanation promises a narrator only while a listed Foray has one (p-first-11)", async () => {
  /* With the test track off, the frozen fixture lists capital-types-1 alone:
     22 moments, no narration, four of them from one episode. The sentence said
     "the best moment of each episode ... with a narrator between them" right
     above it. KILLING MUTATION: put the narrator clause back unconditionally —
     the first assertion is red. */
  const plain = loadApp(await realBridge(), { showDrafts: false });
  assert.deepEqual(plain.forayCards().map((f) => f.id), ["capital-types-1"], "fixture: one listed Foray");
  const about = plain.forayAbout();
  assert.doesNotMatch(about, /narrator/, `no narrator is listed, so none is promised: "${about}"`);
  assert.doesNotMatch(about, /best moment of each episode/, "and it does not promise one moment per episode");
  const drafts = loadApp(await realBridge(), { showDrafts: true });
  assert.match(drafts.forayAbout(), /with a narrator between them\.$/, "a listed narrated Foray earns the clause");
});

test("the intro popup claims a stretch Foray only when Home's Forays row has one (p-first-11)", async () => {
  /* One listed Foray is one subject root, so pickWithStretchFloor has no
     branch left over for a stretch pick. KILLING MUTATION: restore the fixed
     sentence "The forays and the episodes each include ..." — red. */
  const created = [];
  const app = loadApp(await realBridge(), { showDrafts: false, created });
  assert.equal(app.foraysForYouPicks().stretchIndex, -1, "fixture: no stretch Foray is possible");
  try { app.showIntroPopupOnce(); } catch (_) { /* the stub cannot open a sheet; the copy is already built */ }
  const sub = created.find((el) => el.className === "fy-sheet-sub" && /outside your usual subjects/.test(el.textContent));
  assert.ok(sub, "the popup's explanation was built");
  assert.match(sub.textContent, /The episodes include one pick outside your usual subjects/);
  assert.doesNotMatch(sub.textContent, /forays/);
});

/* ---------- p-foray-2: every credited show links in-app, or its arrow says "search" ---------- */

/** The credits half of the bridge, over the REAL player/foray-sources.js, taking
    the page's `collectionIds` the way player/client.js does. */
async function withCredits(bridge) {
  const sources = await import("../player/foray-sources.js");
  bridge.forayCredits = (r, { discoverDoc = null, collectionIds = null } = {}) => {
    const ids = new Map(Object.entries(collectionIds || {}));
    for (const [show, id] of sources.collectionIdsByShow(discoverDoc)) ids.set(show, id);
    const credits = sources.forayCredits(r, { collectionIds: ids });
    return { credits, summary: sources.creditsSummary(credits) };
  };
  return bridge;
}

/** Each credit in the "Where this came from" block: [show, in-app href|null, arrow label, arrow href]. */
function sourceCredits(html) {
  return [...html.matchAll(/<span class="fy-src-show">([\s\S]*?)<\/span>\s*<a class="fy-src-out" href="([^"]*)"[^>]*aria-label="([^"]*)">/g)]
    .map((m) => {
      const link = /href="#\/show\/([^"]+)">([^<]*)</.exec(m[1]);
      return { show: link ? link[2] : m[1].trim(), inApp: link ? link[1] : null, label: m[3], out: m[2] };
    });
}

test("the published Foray: every credited show links in-app, or its arrow says it is a SEARCH (p-foray-2)", async () => {
  /* capital-types-1 from the frozen fixture. None of its seven shows is in the
     curated catalogue and there is no discover doc here, so before the index
     loads every arrow is an Apple search, and it must SAY search. KILLING
     MUTATION: put back the fixed aria-label "Open X on Apple Podcasts" — red. */
  const { resolve } = await mods;
  const app = loadApp(await withCredits(await realBridge()), { showDrafts: false });
  const doc = resolve.findForay(readFrozen("forays.json"), "capital-types-1", {});
  const r = resolve.resolveForay(doc, { segments: resolve.indexSegments(readFrozen("segments.json")), sources: resolve.indexSources(readFrozen("segment-sources.json")) });
  const credits = sourceCredits(app.foraySourcesHtml(r, app.ForayPlayer));
  assert.equal(credits.length, 7, "fixture: seven credited shows");
  for (const c of credits) {
    assert.ok(c.inApp || (c.label === `Search Apple Podcasts for ${c.show}` && /\/search\?term=/.test(c.out)),
      `${c.show}: no in-app page, so the arrow must say it searches: ${JSON.stringify(c)}`);
  }
});

test("once the show index is loaded, a credited show it knows links in-app and to its own Apple page — exact, unique titles only (p-foray-2)", async () => {
  /* A synthetic index (never the live file): two of the Foray's shows by their
     Apple collection ids, and one title carried by TWO rows, which is two shows
     and must not be guessed between. KILLING MUTATION 1: drop the index
     fallback from showIdForShowName — Acquiring Minds has no in-app link, red.
     KILLING MUTATION 2: take the first of two same-titled rows — Feel the Boot
     links, red. KILLING MUTATION 3: stop passing showIndexCollectionIds — the
     arrow stays a search, red. */
  const { resolve } = await mods;
  const app = loadApp(await withCredits(await realBridge()), { showDrafts: false });
  app.__idx = { keys: [], rows: [
    { show_id: "1569715379", title: "Acquiring Minds", tier: "breadth" },
    { show_id: "1236907421", title: "Y Combinator Startup Podcast", tier: "breadth" },
    { show_id: "111", title: "Feel the Boot", tier: "breadth" },
    { show_id: "222", title: "Feel the Boot", tier: "breadth" },
  ] };
  vm.runInContext("showIndex = __idx;", app);
  const doc = resolve.findForay(readFrozen("forays.json"), "capital-types-1", {});
  const r = resolve.resolveForay(doc, { segments: resolve.indexSegments(readFrozen("segments.json")), sources: resolve.indexSources(readFrozen("segment-sources.json")) });
  const byShow = new Map(sourceCredits(app.foraySourcesHtml(r, app.ForayPlayer)).map((c) => [c.show, c]));
  const am = byShow.get("Acquiring Minds");
  assert.equal(am.inApp, "1569715379", "the show page the Shows search would open");
  assert.equal(am.label, "Open Acquiring Minds on Apple Podcasts");
  assert.equal(am.out, "https://podcasts.apple.com/us/podcast/id1569715379", "the show's own page, not a search");
  const ftb = byShow.get("Feel the Boot");
  assert.equal(ftb.inApp, null, "two rows share the title: no guess");
  assert.equal(ftb.label, "Search Apple Podcasts for Feel the Boot");
  const row = app.forayCreditHtml(r.entries.find((e) => e.show === "Y Combinator Startup Podcast"));
  assert.equal(row, `<a class="fy-credit show-link" href="#/show/1236907421">Y Combinator Startup Podcast</a>`, "the clip row's credit links too");
});

test("the index landing after paint relinks the row credits in place (p-foray-2)", async () => {
  /* KILLING MUTATION: make relinkForayCredits skip the `.fy-credit[data-credit-show]`
     pass — the span is never replaced, red. */
  const app = loadApp(await withCredits(await realBridge()), { showDrafts: false });
  const span = { dataset: { creditShow: "Acquiring Minds" }, outerHTML: "<span>" };
  const view = { querySelectorAll: (sel) => (sel === ".fy-credit[data-credit-show]" ? [span] : []), querySelector: () => null };
  app.document.querySelector = (sel) => (sel === "#view" ? view : null);
  app.__idx = { keys: [], rows: [{ show_id: "1569715379", title: "Acquiring Minds", tier: "breadth" }] };
  vm.runInContext("showIndex = __idx;", app);
  app.relinkForayCredits({ entries: [] }, app.ForayPlayer);
  assert.equal(span.outerHTML, `<a class="fy-credit show-link" href="#/show/1569715379">Acquiring Minds</a>`);
});
