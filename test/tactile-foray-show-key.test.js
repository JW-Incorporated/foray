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

const keysOf = (html) => [...html.matchAll(/<span class="today-hero__key today-hero__key--c(\d)(?: today-hero__key--last)?" role="listitem" aria-label="([^"]*)"/g)]
  .map((m) => ({ show: m[2].replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"'), enamel: m[1] }));

test("each contributing show's pip on Today's card is the colour of that show's bars", async () => {
  /* KILLING MUTATION: in todayHeroModel, change `enamelOf.set(s.show, s.enamel)` to
     `enamelOf.set(s.show, (s.enamel + 1) % 8)` (the pip reads something the band does not
     draw) — a pip stops matching its show's bars and this is red. */
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
     KILLING MUTATION: in forayEnamelClass, hash `showName + "x"` and ignore `enamels` — a
     swatch stops matching its show's bars and this is red. */
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
    const row = app.forayFromRowHtml(show, codes, band.enamels);
    const swatch = /class="fdet-sw t-band__bar--c(\d)"/.exec(row);
    assert.ok(swatch, `${show.name} has a swatch`);
    assert.deepStrictEqual([...by.get(show.name)], [swatch[1]], `${show.name}: swatch c${swatch[1]} == bars ${[...by.get(show.name)]}`);
  }
});

/** show name -> the enamel digit its bars wear, read back out of a band's own markup. */
function barEnamelOf(segments, svg) {
  const out = new Map();
  for (const [show, set] of enamelsByShow(segments, barsOf(svg))) {
    assert.strictEqual(set.size, 1, `${show} wears one enamel on one band`);
    out.set(show, [...set][0]);
  }
  return out;
}

test("a show is the same colour on Today's card and on that foray's own page", async () => {
  /* The review's blocking finding: Today gave each show its own enamel (tactileDistinctEnamels)
     while the Foray page still hashed, so tapping the card changed a show's colour in exactly
     the seven-show case this feature exists for. Compared on the RAW markup of both screens:
     the card's bars, the page's bars, the page's From swatches and the page's clip-row
     swatches. KILLING MUTATION: in forayBandModel delete the `enamel:` line from the segment
     (or have forayEnamelClass ignore `enamels`) — the page falls back to the hash, three
     shows change colour and this is red. */
  const { r, doc } = await sevenShowForay();
  const app = loadApp(await realBridge());
  const hero = app.todayHeroModel({ foray: doc, r });
  const today = barEnamelOf(hero.segments, app.todayHeroHtml(hero));
  const band = app.forayBandModel(r, app.ForayPlayer);
  const page = barEnamelOf(band.segments, app.tactileBand({ id: "k", kind: "detail", segments: band.segments, renderWidth: 345, progress: 0, currentIndex: 0 }));
  assert.strictEqual(today.size, 7);
  assert.strictEqual(new Set(today.values()).size, 7, "fixture: seven distinct colours on the card, so a hash fallback shows");
  assert.ok(new Set([...today.keys()].map((n) => app.tactileHash(n))).size < 7, "fixture: the plain hash collides here, so a fallback cannot pass");
  assert.deepStrictEqual([...page].sort(), [...today].sort(), "the page's bars wear the card's colour, show for show");
  const shows = app.forayDetailShows(r);
  const codes = app.forayStationCodes(shows);
  for (const show of shows) {
    const from = /class="fdet-sw t-band__bar--c(\d)"/.exec(app.forayFromRowHtml(show, codes, band.enamels));
    assert.strictEqual(from && from[1], today.get(show.name), `${show.name}: From swatch == the card's colour`);
  }
  let rows = 0;
  for (const slot of r.slots) {
    for (const entry of slot.entries) {
      if (!entry.show) continue;
      const m = /class="fdet-sw t-band__bar--c(\d)"/.exec(app.forayRow(entry, codes, band.enamels));
      assert.strictEqual(m && m[1], today.get(entry.show), `${entry.show}: clip-row swatch == the card's colour`);
      rows += 1;
    }
  }
  assert.ok(rows >= 7, "the clip rows were actually checked");
});

test("the player's band, swatches and mini line draw the same per-foray colours", async () => {
  /* dialForaySegments (player/client.js, an ES module with no harness) is lifted out of the
     source and run against the app's own primitives, so what it returns is what Now Playing's
     band and swatches and the mini player's line receive. KILLING MUTATION: in dialForaySegments
     use `dialStationIndex(showId)` for colorIndex (the global hash) — three shows differ from
     the card and this is red. */
  const { r, doc } = await sevenShowForay();
  const app = loadApp(await realBridge());
  const hero = app.todayHeroModel({ foray: doc, r });
  const today = barEnamelOf(hero.segments, app.todayHeroHtml(hero));
  const src = fs.readFileSync(path.join(ROOT, "player/client.js"), "utf8").replace(/\r\n/g, "\n");
  const from = src.indexOf("function dialStationIndex(");
  const stop = src.indexOf("\n/* `buffering` here is what the sheet DRAWS", from);
  assert.ok(from > 0 && stop > from, "found dialForaySegments's neighbourhood in player/client.js");
  vm.runInContext(`var TTS = "tts"; var artworkByShow = new Map();
    function segmentStarts(list) { var t = 0; return list.map(function (i) { var s = t; t += i.duration_sec || 1; return s; }); }
    function itemRuntimeSec(i) { return i.duration_sec || 1; }
    ${src.slice(from, stop)}`, app);
  const resolved = { playable: r.playable.map((i) => (i.kind === "narration" ? { ...i, kind: "tts" } : i)), entries: r.entries || [], sources: new Map() };
  const segs = app.dialForaySegments(resolved, 0);
  const drawn = new Map();
  for (const s of segs) if (!s.narration) { assert.strictEqual(s.enamel, s.colorIndex, "the band's enamel is the swatch's colour"); drawn.set(s.show, String(s.enamel)); }
  assert.strictEqual(drawn.size, 7);
  assert.deepStrictEqual([...drawn].sort(), [...today].sort(), "player == card, show for show");
  const mini = app.tactileBand({ kind: "line", segments: segs.map((s) => ({ showId: s.showId, show: s.show, duration: s.duration, narration: s.narration, enamel: s.enamel })), renderWidth: 345 });
  assert.match(mini, /t-band__bar--c\d/, "the line paints enamel classes");
});

test("the pip takes the band's own colour tokens, never a hex of its own", () => {
  /* KILLING MUTATION: change `.today-hero__key--c3 { --seg: var(--dial-seg-c3) }` to
     `var(--dial-seg-c2)` (or a literal #A67A08), or `.today-hero__pip`'s
     `background: var(--seg)` to `var(--ink-3)` — red. */
  for (let n = 0; n < 8; n += 1) {
    assert.match(rule(`.today-hero__key--c${n}`), new RegExp(`--seg:\\s*var\\(--dial-seg-c${n}\\)`), `pip c${n}`);
    assert.match(rule(`.t-band__bar--c${n}`), new RegExp(`fill:\\s*var\\(--dial-seg-c${n}\\)`), `bar c${n}`);
  }
  const pip = rule(".today-hero__pip");
  assert.match(pip, /background:\s*var\(--seg\)/, "the pip paints the show's colour");
  const all = pip + rule(".today-hero__key") + rule(".today-hero__discs");
  assert.doesNotMatch(all, /#[0-9a-fA-F]{3,8}\b|rgb\(/, "no colour of its own");
  assert.doesNotMatch(all, /\banimation|transition/, "a static mark: nothing for reduced motion to switch off");
});

test("no two shows of one foray wear the same enamel, on the band or on the key", async () => {
  /* The seven-show fixture hashes three of its shows onto one enamel; a key that repeats a
     colour only tells those apart by code. KILLING MUTATION: in todayHeroModel replace
     `enamels[showIdOf(s)]` with `tactileHash(showIdOf(s))` (and the same in the pip's map)
     — the global hash returns and two shows share an enamel, so this is red. */
  const { r, doc } = await sevenShowForay();
  const app = loadApp(await realBridge());
  const hero = app.todayHeroModel({ foray: doc, r });
  const html = app.todayHeroHtml(hero);
  const keys = keysOf(html);
  assert.strictEqual(keys.length, 7);
  assert.strictEqual(new Set(keys.map((k) => k.enamel)).size, 7, "seven shows, seven enamels on the key");
  const by = enamelsByShow(hero.segments, barsOf(html));
  assert.strictEqual(new Set([...by.values()].map((set) => [...set][0])).size, 7, "and seven on the bars");
  const hashed = new Set(hero.segments.filter((s) => !s.narration).map((s) => app.tactileHash(s.showId)));
  assert.ok(hashed.size < 7, "fixture: the plain hash DOES collide here, so the test can fail");
});

test("tactileDistinctEnamels keeps a free show's own hash and walks past a taken one", () => {
  /* KILLING MUTATION: drop the `used[candidate]` check (always take the hash) — the
     collision case returns the same enamel twice and this is red. */
  const app = loadApp({});
  const ids = Array.from({ length: 40 }, (_, i) => `show-${i}`);
  const firstTwo = ids.find((id, i) => ids.slice(0, i).some((o) => app.tactileHash(o) === app.tactileHash(id)));
  assert.ok(firstTwo, "fixture: a colliding pair exists among the ids");
  const pair = ids.slice(0, ids.indexOf(firstTwo) + 1);
  const got = app.tactileDistinctEnamels(pair);
  assert.strictEqual(new Set(Object.values(got)).size, pair.length, "every show distinct");
  assert.strictEqual(got[pair[0]], app.tactileHash(pair[0]), "the first show keeps its own hash enamel");
  const eight = app.tactileDistinctEnamels(ids.slice(0, 8));
  assert.strictEqual(new Set(Object.values(eight)).size, 8, "eight shows use all eight enamels");
  assert.doesNotThrow(() => app.tactileDistinctEnamels(ids), "past eight it repeats rather than failing");
  assert.strictEqual(Object.keys(app.tactileDistinctEnamels(["a", "a", "b"])).length, 2, "a repeated id is one show");
});

test("the key shares ONE line with the readout and adds no new material to the disc", async () => {
  /* KILLING MUTATION: put `flex-wrap: wrap` back on `.today-hero__meta` (the key and the
     readout may stack on two lines again), or give `.today-hero__key` a `padding` and
     `background` (the ring returns) — red. */
  const { r, doc } = await sevenShowForay();
  const app = loadApp(await realBridge());
  const html = app.todayHeroHtml(app.todayHeroModel({ foray: doc, r }));
  assert.match(html, /<div class="today-hero__meta"><span class="today-hero__discs"[^>]*>(?:(?!<\/div>).)*<\/span><span class="readout today-hero__facts">/s, "discs and readout are siblings in one meta row");
  const meta = rule(".today-hero__meta");
  assert.doesNotMatch(meta, /flex-wrap:\s*wrap/, "the row never wraps onto a second line");
  assert.match(meta, /min-height:\s*var\(--art-disc\)/, "the row is the 40px it always was");
  const key = rule(".today-hero__key");
  assert.doesNotMatch(key, /padding|background|border-radius/, "no ring: the disc is the plain artwork");
});

test("the key's discs carry no text, so overlapping them clips nothing, and the readout says 'about'", async () => {
  /* KILLING MUTATION: pass `initials: d.initials` instead of `plain: true` to the disc's
     tactileArtFrame in todayHeroHtml (a disc with no artwork draws its station code, and the
     neighbour laid over it cuts the code to a letter and a half), or drop the "about" prefix
     on `facts` in todayHeroModel: red. (The harness shoots with remote images off, so every
     disc is the no-artwork case here: the state in which the clipping showed.) */
  const { r, doc } = await sevenShowForay();
  const app = loadApp(await realBridge());
  const hero = app.todayHeroModel({ foray: doc, r });
  const html = app.todayHeroHtml(hero);
  const discs = /<span class="today-hero__discs"[^>]*>(.*?)<\/span><span class="readout today-hero__facts">/s.exec(html)[1];
  assert.ok((discs.match(/art-frame--disc/g) || []).length >= 7, "the seven shows' discs are in the row (the check is not over an empty row)");
  assert.doesNotMatch(discs, /art-frame__initials/, "a disc draws no station code: the pip and the show's name carry who it is");
  assert.match(hero.facts, /^about \d+ min · 7 shows$/, "the readout keeps the direction's voice");
});
