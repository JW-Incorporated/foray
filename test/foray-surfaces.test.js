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

function loadApp(bridge, { showDrafts = true } = {}) {
  const noop = () => {};
  function makeEl() {
    return {
      addEventListener: noop, removeEventListener: noop, appendChild: noop,
      setAttribute: noop, removeAttribute: noop,
      classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
      style: {}, dataset: {}, children: [], hidden: false,
      innerHTML: "", textContent: "", className: "",
      querySelector: () => makeEl(), querySelectorAll: () => [],
    };
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
      querySelector: () => makeEl(), querySelectorAll: () => [],
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
