/* Tactile `library-forays` (Yours, Forays): one card per Foray with its band.
 * Redesign 2026, docs/redesign-2026/directions/tactile/BUILD-PLAN.md 2.13,
 * BUILD-NOTES 4.5. Code: ui/library.js ("THE FORAYS PANEL" block and the
 * renderLibrary call that binds Play), styles.css ("Forays: one card per Foray"),
 * tools/ui-lab/lib/states.mjs (`yours-forays`, `yours-forays-progress`).
 *
 * WHAT THIS PROVES
 *   1. A card is NOT a link: it is an <article>, the title is the one link
 *      (through safeUrl to #/foray/<id>) and Play is a keycap beside the readout,
 *      the two siblings and neither inside the other.
 *   2. The band is the 8px `mini` size drawn from the real strip: one bar per
 *      strip segment, each show bar coloured by the primitive's own hash of its
 *      show, narration as solid ticks (no hatch fill).
 *   3. The readout is the mono line "about 22 min · 4 shows" (Today's hero
 *      facts), then "N min left" or "Played"; a draft says "draft" first.
 *   4. Resume is on the band: a part-played Foray has a needle and a fill clip
 *      strictly inside the band and keeps the 40% for the unplayed bars; a Foray
 *      not started or finished has neither, and sits at full enamel.
 *   5. Play is `[data-home-play]` and renderLibrary binds it on the Forays panel.
 *   6. A title with markup in it reaches the page inert.
 *   7. The sheet's rules: the title is 700 at the 17px step clamped to two lines,
 *      the link and the sm keycap are at least the --tap target, not-started
 *      cards restore full enamel.
 *   8. The harness steps and the screen map point at each other and at selectors
 *      the markup really has.
 *
 * WHAT IT CANNOT PROVE: how any of it looks (tools/ui-lab/fidelity.mjs measures
 * the card, title, band and key against the prototype in a real browser) or that
 * a press starts audio (the player has its own suites; here the press is only
 * proven to be wired to the same hook Today's keys use).
 *
 * HARNESS AUDIT (CLAUDE.md "a green test is not evidence until you have broken
 * it"). The real app.js and ui/*.js run in a node:vm over the REAL resolver and
 * strip modules and the FROZEN fixture; only the resume list is faked, because
 * which rows exist is the player's answer, not the page's. The fake's rows carry
 * percent 40 for a part-played Foray, so the needle test cannot pass on a
 * default of zero, and the not-started cases are asserted separately. Each test
 * names its mutation; all were run red.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { readAppSource, runAppSource } = require("./helpers/app-source.js");

const ROOT = path.join(__dirname, "..");
const SRC = readAppSource().replace(/\r\n/g, "\n");
const CSS = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
const LIBRARY_SRC = fs.readFileSync(path.join(ROOT, "ui", "library.js"), "utf8");
const STATES_SRC = fs.readFileSync(path.join(ROOT, "tools", "ui-lab", "lib", "states.mjs"), "utf8");
const SCREENS = JSON.parse(fs.readFileSync(path.join(ROOT, "docs", "redesign-2026", "directions", "tactile", "screens.json"), "utf8"));
const FROZEN = path.join(ROOT, "tools/foray/fixtures/frozen/data");
const readFrozen = (f) => JSON.parse(fs.readFileSync(path.join(FROZEN, f), "utf8"));

const mods = (async () => ({
  resolve: await import("../player/foray-resolve.js"),
  strip: await import("../player/segment-strip.js"),
  progress: await import("../player/foray-progress.js"),
}))();

const NARRATED = "what-engineers-actually-do-all-day-e08236";   // 40 bridges between clips
const PUBLISHED = "capital-types-1";
const DRAFT = readFrozen("forays.json").forays.find((f) => f.status !== "published").id;

/** A bridge over the real modules; `rows` is `[id, { remainingSec, percent } | { finished: true }]`. */
async function realBridge(rows = []) {
  const { resolve, strip, progress } = await mods;
  return {
    resolve(doc, { id, segmentsDoc, sourcesDoc, unlocked = [], showDrafts = false } = {}) {
      const f = resolve.findForay(doc, id, { unlocked, showDrafts });
      return f ? resolve.resolveForay(f, { segments: resolve.indexSegments(segmentsDoc), sources: resolve.indexSources(sourcesDoc) }) : null;
    },
    listForays: (doc, opts) => resolve.listableForays(doc, opts),
    stripTally: strip.stripTally,
    stripModel: strip.stripModel,
    segmentStripHtml: strip.segmentStripHtml,
    fmtClock: resolve.fmtClock,
    fmtSpan: resolve.fmtSpan,
    forayResumeList: () => rows.map(([id, p], i) => {
      const point = p.finished
        ? { finished: true, percent: 100, remainingSec: 0 }
        : { finished: false, percent: p.percent == null ? 40 : p.percent, remainingSec: p.remainingSec };
      return {
        id, title: id, updated_at: `2026-09-2${i}T00:00:00Z`, percent: point.percent,
        finished: point.finished, drift: "unverified", label: progress.progressLabel(point),
      };
    }),
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
  const store = new Map([["cp_show_drafts", "true"]]);
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
  runAppSource(SRC, ctx);
  ctx.__docs = { forays: readFrozen("forays.json"), segments: readFrozen("segments.json"), sources: readFrozen("segment-sources.json") };
  vm.runInContext("state.forays = __docs.forays; state.segments = __docs.segments; state.segmentSources = __docs.sources;", ctx);
  return ctx;
}

/** The card for one Foray id, as markup. */
function cardFor(html, id) {
  const cards = html.split(/(?=<article class="card yours-foray)/).filter((c) => c.startsWith("<article"));
  const card = cards.find((c) => c.includes(`href="#/foray/${id}"`));
  assert.ok(card, `a card for ${id} in: ${html.slice(0, 200)}`);
  return card;
}

test("a card is an article; the title link and the Play key are siblings, neither inside the other (card is not a link)", async () => {
  /* MUTATION: wrap the card in <a class="yours-foray" href=...> (the old whole-row link) - the
     article/anchor assertions go red. MUTATION 2: put the keycap inside the title link - the
     sibling assertion goes red. */
  const app = loadApp(await realBridge());
  const html = app.libraryForaysHtml();
  const card = cardFor(html, PUBLISHED);
  assert.match(card, /^<article class="card yours-foray"/, "an <article>, not a link");
  assert.equal((card.match(/<a /g) || []).length, 1, "exactly one link in the card: the title");
  assert.match(card, /<h3 class="yours-foray__title"><a class="yours-foray__link" href="#\/foray\/capital-types-1"><span class="yours-foray__text">[^<]+<\/span><\/a><\/h3>/);
  const link = /<a [\s\S]*?<\/a>/.exec(card)[0];
  assert.ok(!link.includes("<button"), "Play is not inside the link");
  const foot = /<div class="yours-foray__foot">([\s\S]*?)<\/div>\s*<\/article>/.exec(card);
  assert.ok(foot && /<button type="button" class="keycap [^"]*keycap--sm[^"]*keycap--persimmon[^"]*keycap--round[^"]*"[^>]*data-home-play="capital-types-1"/.test(foot[1]), `Play is a sm persimmon round keycap carrying data-home-play in the foot: ${foot && foot[1]}`);
  assert.ok(html.startsWith('<div class="yours-forays">'), "cards sit inside the .yours-forays list");
});

test("every listed Foray gets a card, uncapped, and the 'All N forays' link is gone", async () => {
  /* MUTATION: re-add `.slice(0, 5)` (the old LIBRARY_SECTION_CAP) - fixture has 4 Forays so this
     one is pinned by the 'All N' assertion and the count together: restore the link and it is red. */
  const app = loadApp(await realBridge());
  const html = app.libraryForaysHtml();
  const ids = readFrozen("forays.json").forays.map((f) => f.id);
  assert.equal((html.match(/<article class="card yours-foray/g) || []).length, ids.length, "a card per Foray");
  for (const id of ids) assert.ok(html.includes(`href="#/foray/${id}"`), `${id} is linked`);
  assert.ok(!/All \d+ forays/.test(html) && !html.includes("lib-more"), "no capped summary and no link to the directory");
});

test("the band is the 8px mini size drawn from the real strip: bar per segment, show hash colours, solid narration ticks", async () => {
  /* MUTATION 1: kind "detail" for "mini" in yoursForayCardHtml - the band--mini assertion is red
     (and narration would be hatched). MUTATION 2: pass hero.segments reversed or capped - the
     per-segment count/colour assertions go red. */
  const app = loadApp(await realBridge());
  const html = app.libraryForaysHtml();
  const card = cardFor(html, NARRATED);
  assert.match(card, /<svg class="band band--mini"/, "the mini band");
  assert.ok(!card.includes("band--detail") && !card.includes("band--scrub"));
  const { strip } = await mods;
  const f = readFrozen("forays.json").forays.find((x) => x.id === NARRATED);
  const r = app.resolveListedForay(f.id);
  const expected = strip.stripModel(r.playable, { mergeNarration: true }).segments;
  const base = /<g class="t-band__base">([\s\S]*?)<\/g>/.exec(card)[1];
  const bars = [...base.matchAll(/<rect class="([^"]+)"([^>]*)><\/rect>/g)];
  assert.equal(bars.length, expected.length, "one bar per strip segment (the same model Today's hero draws)");
  assert.ok(expected.some((s) => s.kind === "narration") && expected.some((s) => s.kind !== "narration"), "fixture: narration and shows both present");
  bars.forEach((b, i) => {
    const seg = expected[i];
    if (seg.kind === "narration") {
      assert.match(b[1], /t-band__bar--narration t-band__bar--tick/, `segment ${i}: a solid tick`);
      assert.ok(!/fill="url\(/.test(b[2]), `segment ${i}: narration has no hatch fill in the mini`);
    } else {
      assert.ok(b[1].includes(`t-band__bar--c${app.tactileHash(seg.show || seg.sourceKey || "show")}`), `segment ${i}: coloured by the hash of its show (${seg.show}) -> ${b[1]}`);
    }
  });
});

test("the readout is the mono line 'about N min · N shows', draft first, progress last", async () => {
  /* MUTATION: drop `hero.facts` from the joinMeta in yoursForayCardHtml (or the .readout class) -
     the pattern assertions go red. */
  const app = loadApp(await realBridge([[PUBLISHED, { remainingSec: 1200 }], [DRAFT, { remainingSec: 600 }]]));
  const html = app.libraryForaysHtml();
  const narrated = cardFor(html, NARRATED);
  assert.match(narrated, /<span class="readout yours-foray__readout">draft · about \d+ min · \d+ shows?<\/span>/, "a narrated Foray is hedged with 'about', as on Today; this one is also a draft");
  const part = cardFor(html, PUBLISHED);
  assert.match(part, /<span class="readout yours-foray__readout">\d+ min · 7 shows · 20 min left<\/span>/, "part-played: facts then how much is left");
  const draft = cardFor(html, DRAFT);
  assert.match(draft, /<span class="readout yours-foray__readout">draft · .+ · 10 min left<\/span>/, "a draft says draft first");
});

test("resume is on the band: part-played has a needle and a fill clip strictly inside it; not started and finished have neither", async () => {
  /* MUTATION 1: pass `progress: 0` always to tactileBand - the needle and the clip width go red.
     MUTATION 2: pass `place.percent` for a finished Foray too (drop `!place.finished`) - the
     finished card grows a needle and is-part, red. */
  const app = loadApp(await realBridge([[PUBLISHED, { remainingSec: 1800, percent: 40 }], [NARRATED, { finished: true }]]));
  const html = app.libraryForaysHtml();
  const part = cardFor(html, PUBLISHED);
  assert.match(part, /^<article class="card yours-foray is-part"/);
  assert.ok(part.includes('<g class="needle"'), "the needle is in place");
  const clip = /<rect class="band__progress" x="0" y="0" width="([\d.]+)"/.exec(part);
  assert.ok(clip && Number(clip[1]) > 0 && Number(clip[1]) < 1000, `the played part is a strict slice of the band: ${clip && clip[1]}`);
  assert.ok(part.includes('<g class="t-band__fill"'), "the played bars are drawn again, full, over the 40% base");

  const fresh = cardFor(html, DRAFT);
  assert.ok(!fresh.includes('<g class="needle"') && !/ is-part/.test(fresh.split(">")[0]), "not started: no needle, not is-part");
  const clip0 = /<rect class="band__progress" x="0" y="0" width="([\d.]+)"/.exec(fresh);
  assert.equal(Number(clip0[1]), 0, "not started: an empty progress clip");

  const done = cardFor(html, NARRATED);
  assert.ok(!done.includes('<g class="needle"') && !/ is-part/.test(done.split(">")[0]), "finished: no needle, not is-part");
  assert.match(done, / · Played<\/span>/, "finished says Played in words");
});

test("Play carries the hook Today's keys use, and renderLibrary binds it on the Forays panel", () => {
  /* MUTATION: delete the `bindHomePlay($("#yours-panel-forays"))` line in renderLibrary - red.
     MUTATION 2: rename data-home-play in the card - the first assertion is red. */
  assert.match(LIBRARY_SRC, /data: \{ "home-play": f\.id \}/, "the card's key is [data-home-play]");
  assert.match(LIBRARY_SRC, /bindHomePlay\(\$\("#yours-panel-forays"\)\);/, "renderLibrary binds Play on the Forays panel");
  const home = fs.readFileSync(path.join(ROOT, "ui", "home.js"), "utf8");
  assert.match(home, /querySelectorAll\("\[data-home-play\]"\)/, "and that is the hook bindHomePlay reads");
});

test("a title with markup in it reaches the page inert", async () => {
  /* MUTATION: drop esc() around the title in the card - the raw <img> is in the markup, red. */
  const app = loadApp(await realBridge());
  vm.runInContext(`state.forays.forays[0].title = '<img src=x onerror=alert(1)> "q"'; state.forays.forays[0].status = 'published';`, app);
  const html = app.libraryForaysHtml();
  assert.ok(!html.includes("<img src=x"), "no live tag from a title");
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"), "the title is shown as text");
});

test("sheet rules: title 700 at the 17px step clamped to two lines, 44px link and key, full enamel when not started", () => {
  /* MUTATION 1: change the title font to var(--w-label) / drop the clamp - red.
     MUTATION 2: delete the link's `padding-block` (the 44px target) - red; put `min-height: var(--tap)` back
     on it instead and the one-line title reserves a 44px slot with ~10px of dead space under the text - red.
     MUTATION 3: delete the `.yours-foray:not(.is-part) .t-band__base` rule - the not-started band
     would sit at the primitive's 40% as if it were part played - red. */
  const rule = (sel) => {
    const at = CSS.indexOf(`\n${sel} {`);
    assert.ok(at >= 0, `rule ${sel}`);
    return CSS.slice(at, CSS.indexOf("}", at));
  };
  assert.match(rule(".yours-foray__title"), /font: 700 var\(--t-body-lg\)\/var\(--lh-body-lg\)/);
  const link = rule(".yours-foray__link");
  const text = rule(".yours-foray__text");
  assert.match(text, /-webkit-line-clamp: 2/);
  assert.match(text, /overflow: hidden/);
  /* MUTATION 5: move the clamp + overflow back onto `.yours-foray__link` (or add padding to
     `.yours-foray__text`) - red. overflow clips at the PADDING box, so with ~11px of padding the
     top of line 3 of a 3+ line title paints under the ellipsis line (seen in Chromium 151 on the
     real 59-char title "The chain reaction: how engineering disasters really happen" at 280px). */
  assert.ok(!/overflow|line-clamp/.test(link), "the clamp is not on the padded link");
  assert.ok(!/padding|margin/.test(text), "the clamped box carries no padding, so nothing of line 3 sits inside it");
  assert.match(link, /display: block/);
  assert.match(link, /padding-block: calc\(\(var\(--tap\) - var\(--lh-body-lg\)\) \/ 2\)/, "the link is a 44px target by padding...");
  assert.match(link, /margin-block: calc\(\(var\(--tap\) - var\(--lh-body-lg\)\) \/ -2\)/, "...paid back by an equal negative margin, so the band sits one gap under the title's last line");
  assert.ok(!/min-height/.test(link), "no reserved-height slot under a one-line title");
  assert.match(CSS, /\.keycap--sm \{ min-width: var\(--tap\); height: var\(--tap\);/, "the sm key is the 44px target");
  /* MUTATION 4: delete the `.yours-foray__foot .keycap--sm` rule - the key falls back to 44x44
     (48 wide by padding), 16px narrower than the prototype's, and this is red. */
  assert.match(CSS, /\.yours-foray__foot \.keycap--sm \{ min-width: calc\(var\(--key\) \+ var\(--s-4\)\); height: var\(--key\); \}/, "the key keeps the prototype's 64x48 footprint, never under the 44px target");
  assert.match(CSS, /\.yours-foray:not\(\.is-part\) \.t-band__base \{ opacity: 1; \}/);
  assert.match(CSS, /\.t-band__base \{ opacity: \.4; \}/, "and the primitive keeps its 40% for what is left of a part-played one");
  assert.ok(!/\.yours-foray[^{]*\{[^}]*(transition|animation)/.test(CSS), "no transition or animation added (the one reduced-motion block needs no new name)");
});

test("the harness steps and the screen map point at each other and at selectors the markup has", async () => {
  /* MUTATION: rename the `yours-forays` step in states.mjs (or the step in screens.json) - red.
     MUTATION 2: change a region selector in screens.json to one the markup lacks - red. */
  assert.match(STATES_SRC, /label: "yours-forays", route: "#\/library", run: \(page\) => openYoursForays\(page\)/);
  assert.match(STATES_SRC, /label: "yours-forays-progress"[^\n]*openYoursForays\(page, \{ id: FORAY_NARRATED, at: 760 \}\)/);
  const entry = SCREENS.screens ? SCREENS.screens["library-forays"] : SCREENS["library-forays"];
  const entries = entry || Object.values(SCREENS).find((v) => v && v["library-forays"])["library-forays"];
  assert.equal(entries.app.step, "yours-forays");
  const app = loadApp(await realBridge());
  const card = cardFor(app.libraryForaysHtml(), PUBLISHED);
  const has = { ".yours-foray": "yours-foray", ".yours-foray__title": "yours-foray__title", ".yours-foray__band": "yours-foray__band", ".yours-foray .keycap": 'class="keycap ' };
  for (const [name, region] of Object.entries(entries.regions)) {
    if (!has[region.app]) continue;
    assert.ok(card.includes(has[region.app]), `region ${name}: the app selector ${region.app} matches the markup`);
  }
  for (const name of ["card", "title", "band", "play"]) assert.ok(entries.regions[name], `region ${name} is mapped`);
});
