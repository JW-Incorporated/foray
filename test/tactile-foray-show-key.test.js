/* The foray card's shows are a COLOUR KEY to its segment bar (Redesign 2026, Tactile,
 * owner request from the 2026-10-09 review: "the foray segment bar is colour-coded per
 * contributing show, and the contributing podcasts shown below it should be colour-coded
 * to match, so the bar reads as a key").
 *
 * Three surfaces show a foray's multi-colour band beside the shows it is made of:
 *   - Today's hero card: a disc per show, now ringed in the show's enamel;
 *   - the Foray page: the "From" rows, each led by a swatch in the show's enamel;
 *   - Now Playing: the origin rows (pinned in player/now-playing-sheet.test.js, where the
 *     band and the swatches take one `colorIndex`).
 * This file pins the first two, over the REAL resolver and strip modules and the FROZEN
 * fixture (a 7-show foray, so the feature is not hidden by the one-show case), and reads
 * the colour of every bar BACK OUT of the band's own markup rather than re-deriving it.
 *
 * Audit of the fakes: (a) the band is the real `tactileBand` over the real
 * `stripModel`, so a bar's class is whatever the primitive draws; (b) the checks compare
 * a show's ring to the class on THAT show's rects, joined by `data-segment-index` to the
 * model's own segment list, so a swap of two shows' colours is caught, not just a
 * "some colour present"; (c) the fixture foray has seven shows, so at least two distinct
 * enamels are in play (asserted, so the comparison cannot pass over one colour).
 *
 * Every test names the one-line mutation that fails it, and each was run.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { readAppSource, runAppSource } = require("./helpers/app-source.js");
const { rule } = require("./helpers/tactile-primitives.js");

const ROOT = path.join(__dirname, "..");
const SRC = readAppSource().replace(/\r\n/g, "\n");
const FROZEN = path.join(ROOT, "tools/foray/fixtures/frozen/data");
const readFrozen = (f) => JSON.parse(fs.readFileSync(path.join(FROZEN, f), "utf8"));

const mods = (async () => ({
  resolve: await import("../player/foray-resolve.js"),
  strip: await import("../player/segment-strip.js"),
}))();

async function realBridge() {
  const { resolve, strip } = await mods;
  return {
    resolve: () => null,
    listForays: (doc, opts) => resolve.listableForays(doc, opts),
    stripTally: strip.stripTally,
    stripModel: strip.stripModel,
    segmentStripHtml: strip.segmentStripHtml,
    fmtClock: resolve.fmtClock,
    fmtSpan: resolve.fmtSpan,
    forayResumeList: () => [],
  };
}

function loadApp(bridge) {
  const noop = () => {};
  function makeEl() {
    return {
      addEventListener: noop, removeEventListener: noop, appendChild: noop, append: noop,
      setAttribute: noop, removeAttribute: noop,
      classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
      style: {}, dataset: {}, children: [], hidden: false,
      innerHTML: "", textContent: "", className: "",
      querySelector: () => makeEl(), querySelectorAll: () => [],
    };
  }
  const store = new Map();
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
    location: { hash: "#/", href: "https://example.test/#/" },
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
  runAppSource(SRC, ctx);
  return ctx;
}

async function sevenShowForay() {
  const { resolve } = await mods;
  const doc = resolve.findForay(readFrozen("forays.json"), "capital-types-1", {});
  const r = resolve.resolveForay(doc, { segments: resolve.indexSegments(readFrozen("segments.json")), sources: resolve.indexSources(readFrozen("segment-sources.json")) });
  return { doc, r };
}

/** Every drawn bar of a band's markup as { index, enamel }, enamel null for narration. */
function barsOf(html) {
  return [...html.matchAll(/<rect class="t-band__bar ([^"]*)"[^>]*data-segment-index="(\d+)"/g)]
    .map((m) => ({ index: Number(m[2]), enamel: (/t-band__bar--c(\d)/.exec(m[1]) || [])[1] ?? null }));
}

/** show name -> Set of enamels its bars wear, joined through the model's own segments. */
function enamelsByShow(segments, bars) {
  const by = new Map();
  for (const bar of bars) {
    const seg = segments[bar.index];
    if (!seg || seg.narration || bar.enamel === null) continue;
    if (!by.has(seg.show)) by.set(seg.show, new Set());
    by.get(seg.show).add(bar.enamel);
  }
  return by;
}

const keysOf = (html) => [...html.matchAll(/<span class="today-hero__key today-hero__key--c(\d)" role="listitem" aria-label="([^"]*)"/g)]
  .map((m) => ({ show: m[2].replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"'), enamel: m[1] }));

test("each contributing show's ring on Today's card is the colour of that show's bars", async () => {
  /* KILLING MUTATION: in todayHeroModel, change `tactileHash(s.showId)` to
     `tactileHash(s.showId + "x")` (the ring hashes something the band does not) — a
     ring stops matching its show's bars and this is red. */
  const { r, doc } = await sevenShowForay();
  const app = loadApp(await realBridge());
  const hero = app.todayHeroModel({ foray: doc, r });
  const html = app.todayHeroHtml(hero);
  const keys = keysOf(html);
  const by = enamelsByShow(hero.segments, barsOf(html));
  assert.strictEqual(keys.length, 7, "one ring per contributing show, all seven");
  assert.strictEqual(by.size, 7, "and the band has bars for all seven");
  assert.ok(new Set(keys.map((k) => k.enamel)).size >= 2, "the fixture is multi-colour, so the comparison below is not over one enamel");
  for (const key of keys) {
    assert.ok(by.has(key.show), `the band has bars for ${key.show}`);
    assert.deepStrictEqual([...by.get(key.show)], [key.enamel], `${key.show}: ring c${key.enamel} == bars ${[...by.get(key.show)]}`);
  }
});

test("the key lists each show once, in the order the band first meets it", async () => {
  /* KILLING MUTATION: build `shows` from `items.map(s => s.show)` without the Set — a
     show with two clips gets two rings and the length assertion is red. */
  const { r, doc } = await sevenShowForay();
  const app = loadApp(await realBridge());
  const hero = app.todayHeroModel({ foray: doc, r });
  const order = [];
  for (const s of hero.segments) if (!s.narration && s.show && !order.includes(s.show)) order.push(s.show);
  assert.deepStrictEqual(keysOf(app.todayHeroHtml(hero)).map((k) => k.show), order);
  assert.ok(hero.segments.filter((s) => !s.narration).length > order.length, "fixture: some show has several clips, so a duplicate would show");
});

test("a one-show foray is one ring, and every bar wears its colour", async () => {
  /* KILLING MUTATION: give the ring a fixed `c0` (drop the lookup) — the one show's bars
     hash elsewhere (this show is not c0) and the assertion is red. */
  const { r, doc } = await sevenShowForay();
  const app = loadApp(await realBridge());
  const first = r.playable.find((i) => i && i.show).show;
  const one = { ...r, playable: r.playable.filter((i) => i && i.show === first) };
  const hero = app.todayHeroModel({ foray: doc, r: one });
  const html = app.todayHeroHtml(hero);
  const keys = keysOf(html);
  assert.strictEqual(keys.length, 1);
  const bars = barsOf(html).filter((b) => b.enamel !== null);
  assert.ok(bars.length >= 1);
  assert.deepStrictEqual([...new Set(bars.map((b) => b.enamel))], [keys[0].enamel], "single-colour band, ring to match");
  assert.notStrictEqual(keys[0].enamel, "0", "fixture: the show is not c0, so a hard-coded c0 would be caught");
});

test("a foray over eight shows keys the first eight and counts the rest", async () => {
  /* KILLING MUTATION: drop the `moreShows` field (or its +N span) — the overflow is
     silent and this is red. */
  const app = loadApp(await realBridge());
  const items = Array.from({ length: 11 }, (_, i) => ({ kind: "episode", show: `Show Number ${i}`, source_item_id: `s${i}` }));
  const hero = app.todayHeroModel({ foray: { id: "x", title: "X", summary: "" }, r: { playable: items, totalSec: 600 } });
  assert.ok(hero.discs.length <= 8, "capped at the palette's length");
  const html = app.todayHeroHtml(hero);
  if (hero.moreShows > 0) assert.match(html, new RegExp(`class="readout today-hero__more"[^>]*>\\+${hero.moreShows}<`));
  assert.strictEqual(hero.discs.length + hero.moreShows, new Set(hero.segments.filter((s) => !s.narration).map((s) => s.show)).size, "every show is either keyed or counted");
});

test("the Foray page's From swatch is the colour of that show's bars", async () => {
  /* The swatch pre-dates this request; pinned here because it IS the key on that page.
     KILLING MUTATION: in forayEnamelClass, hash `showName + "x"` — a swatch stops
     matching its show's bars and this is red. */
  const { r } = await sevenShowForay();
  const app = loadApp(await realBridge());
  const band = app.forayBandModel(r, app.ForayPlayer);
  const svg = app.tactileBand({ id: "k", kind: "detail", segments: band.segments, renderWidth: 345, progress: 0, currentIndex: 0 });
  const by = enamelsByShow(band.segments, barsOf(svg));
  const shows = app.forayDetailShows(r);
  const codes = app.forayStationCodes(shows);
  assert.strictEqual(shows.length, 7);
  assert.ok(new Set(shows.map((s) => [...by.get(s.name)][0])).size >= 2, "multi-colour fixture");
  for (const show of shows) {
    const row = app.forayFromRowHtml(show, codes);
    const swatch = /class="fdet-sw t-band__bar--c(\d)"/.exec(row);
    assert.ok(swatch, `${show.name} has a swatch`);
    assert.deepStrictEqual([...by.get(show.name)], [swatch[1]], `${show.name}: swatch c${swatch[1]} == bars ${[...by.get(show.name)]}`);
  }
});

test("the ring takes the band's own colour tokens, never a hex of its own", () => {
  /* KILLING MUTATION: change `.today-hero__key--c3 { --seg: var(--dial-seg-c3) }` to
     `var(--dial-seg-c2)` (or a literal #A67A08) — red. */
  for (let n = 0; n < 8; n += 1) {
    assert.match(rule(`.today-hero__key--c${n}`), new RegExp(`--seg:\\s*var\\(--dial-seg-c${n}\\)`), `ring c${n}`);
    assert.match(rule(`.t-band__bar--c${n}`), new RegExp(`fill:\\s*var\\(--dial-seg-c${n}\\)`), `bar c${n}`);
  }
  const base = rule(".today-hero__key");
  assert.match(base, /background:\s*var\(--seg\)/, "the ring paints the show's colour");
  assert.doesNotMatch(base + rule(".today-hero__discs"), /#[0-9a-fA-F]{3,8}\b|rgb\(/, "no colour of its own");
  assert.doesNotMatch(base, /\banimation|transition/, "a static mark: nothing for reduced motion to switch off");
});
