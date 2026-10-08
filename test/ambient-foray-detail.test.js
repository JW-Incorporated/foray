/* Redesign 2026, ambient direction: the Foray detail page (#/foray/<id>), the second screen on the Afterglow system.
 *
 * WHAT THIS PROVES, in the order the page reads (docs/redesign-2026/directions/ambient/BUILD-NOTES.md 4.6):
 *   1. The stylesheet and the palette script are wired into the page and every shipping path.
 *   2. The Room: fixed behind the page, from the first show's art, its mid scrim stop no lower than the first line of
 *      text (so the contrast the token suite pins at that stop is the contrast under the text), dimmed to 8% / 0.35 when
 *      the Foray cannot play, and the Dawn Room's paper numbers come from the tokens.
 *   3. The strip's geometry on its sill: the sill, the bar heights, the narration lights, the thumbs row.
 *   4. The page itself, rendered by the REAL app.js over the frozen Foray fixture: eyebrow, title, caption, the one
 *      primary button in each of its words, the unavailable and not-narrated pages, the tiles and the clip rows.
 *   5. The rules that need no browser: which bars get a thumb, the show colours, the Room's artwork URL, escaping.
 *
 * Every test names the one-line mutation that turns it red; each was run red before being run green. The floor for
 * this suite lives in test/suite-integrity.test.js.
 *
 * Harness: the REAL app.js in a node:vm over the shared small DOM (test/helpers/fake-dom.js), a bridge over the REAL
 * resolver and the REAL strip module, and the frozen Foray fixture (tools/foray/fixtures/frozen/, never live data).
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
const CSS = stripComments(read("ui/foray-detail.css"));
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
/** Every rule for exactly `sel` (a selector can be declared twice: the page's paint and the Dock's variables), merged in order. */
function declsAll(css, sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|[};])\\s*${esc}\\s*\\{([^{}]*)\\}`, "g");
  const out = {};
  for (const m of css.matchAll(re)) for (const d of m[1].split(";")) { const c = d.indexOf(":"); if (c > 0) out[d.slice(0, c).trim()] = d.slice(c + 1).trim(); }
  return out;
}
const px = (v) => { const m = /^(-?\d+(?:\.\d+)?)px$/.exec(String(v || "").trim()); return m ? Number(m[1]) : null; };

/* ---------- 1. wiring ---------- */

test("the stylesheet and the palette script are wired into the page and every shipping path", async () => {
  /* MUTATION: remove "ui/foray-detail.css" from SHELL in tools/web/prepare-dist.mjs (or tools/ci/generate-manifest.mjs, or
     SHELL_FILES in tools/mobile/prepare-webdir.mjs), or drop the <link> or the palette <script> from index.html -> red,
     naming the path. A stylesheet that ships to the page but not into the generation is the one file sw.js could not verify. */
  const html = read("index.html");
  const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
  assert.ok(links.indexOf("ui/foray-detail.css") > links.indexOf("ui/primitives.css") && links.includes("ui/foray-detail.css"),
    "linked after the primitives it reads");
  assert.match(html, /<script src="ui\/palette\.js"><\/script>/, "the Glow palette loads with the other ui scripts");
  const shell = (rel, re) => { const m = re.exec(read(rel)); assert.ok(m, `${rel}: shell list found`); return m[1]; };
  assert.match(shell("tools/ci/generate-manifest.mjs", /const SHELL = \[([\s\S]*?)\n\];/), /"ui\/foray-detail\.css"/, "generate-manifest SHELL");
  assert.match(shell("tools/web/prepare-dist.mjs", /const SHELL = \[([\s\S]*?)\n\];/), /"ui\/foray-detail\.css"/, "prepare-dist SHELL");
  const { pathToFileURL } = require("node:url");
  const pw = await import(pathToFileURL(path.join(ROOT, "tools", "mobile", "prepare-webdir.mjs")).href);
  assert.ok(pw.SHELL_FILES.includes("ui/foray-detail.css"), "prepare-webdir SHELL_FILES");
  assert.ok(pw.buildPlan(ROOT).includes("ui/foray-detail.css"), "the app bundle's copy plan carries it");
});

test("the stylesheet is scoped under .ag, loads nothing and owns no reduced-motion block", () => {
  /* The page cannot restyle any other screen, and a second reduced-motion block would be a second owner
     (ui/tokens.css has the one, scoped to .ag).
     MUTATION: add a bare \`.fy-row { … }\` rule -> red. MUTATION 2: add \`@media (prefers-reduced-motion: reduce)\` -> red.
     MUTATION 3: add an @import or a url(...) -> red. */
  const flat = CSS.replace(/@(?:media|supports)[^{]*\{/g, "{");   /* @supports joined @media in iteration 4: the Dock's material fallback */
  const heads = [...flat.matchAll(/(?:^|[}])\s*([^{}@][^{}]*)\{/g)].map((m) => m[1].trim()).filter(Boolean);
  /* a selector list, split on the commas that are outside parentheses (`:where(h1, h2)` is one selector) */
  const splitList = (list) => { const out = []; let depth = 0, cur = ""; for (const ch of list) { if (ch === "(") depth++; if (ch === ")") depth--; if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch; } out.push(cur.trim()); return out; };
  for (const list of heads) {
    for (const sel of splitList(list)) {
      assert.ok(/^(\.ag\b|body\.view-foray-detail\b|\.page\.fd-page\b)/.test(sel), `unscoped selector: ${sel}`);
    }
  }
  assert.ok(heads.length >= 25, `fixture assumption: the sheet has its rules (${heads.length})`);
  assert.doesNotMatch(CSS, /prefers-reduced-motion/, "the one block is tokens.css's");
  assert.doesNotMatch(CSS, /@import|url\(/, "no font, no image, no origin");
  assert.strictEqual((CSS.match(/!important/g) || []).length, 1, "nothing wins by force but the one first-paint rule");
  assert.match(CSS, /\.ag\.fd\.is-fresh \*, \.ag\.fd\.is-fresh \*::before, \.ag\.fd\.is-fresh \*::after \{ transition: none !important; \}/);
});

/* ---------- 2. the Room ---------- */

test("the Room is fixed behind the page, takes its Glow and scrim from the tokens, and its mid stop is not below the eyebrow", () => {
  /* The tokens suite pins the contrast of text over the Room AT the mid stop (--rs2), every hue, both schemes; that is
     the contrast under the eyebrow only if the eyebrow starts at or below that stop. The eyebrow's top is the page's own
     arithmetic: 8 (top pad) + 44 (the head's 44px buttons) + 8 (the collage's margin) + 160 (the collage) + 16 = 236
     from the safe top. BUILD-NOTES 10.1's 276 assumed a different stack; the stop here is 236.
     MUTATION: \`--rs2: calc(var(--safe-top) + 276px)\` -> red (the eyebrow would sit in the ramp, under half a scrim).
     MUTATION 2: give .fd-room its own \`background\` -> red (the Glow-room token is the Room). */
  const room = decls(CSS, ".ag .fd-room");
  assert.ok(room, "the Room rule exists");
  assert.strictEqual(room.position, "fixed");
  assert.strictEqual(room.inset, "0");
  assert.strictEqual(room["z-index"], "-1");
  assert.ok(!("background" in room) && !("background-image" in room), "the Room's background is .room's var(--glow-room)");
  /* THE RAMP STARTS BEHIND THE ARTWORK (round-2 fidelity finding: a hard horizontal edge just under the sleeve). The token's
     196 sits a few px above the collage's lower edge (220), so the scrim climbed 0.20 -> 0.89 in 40px right there. The
     page starts it at 120, the prototype's own stop, so the climb is 116px and has no seam.
     MUTATION: delete the \`--rs1\` line from .fd-room (back to the token's 196) -> red. */
  const rs1 = /^calc\(var\(--safe-top\) \+ (\d+)px\)$/.exec(room["--rs1"] || "");
  assert.ok(rs1, `.fd-room sets its own --rs1: ${room["--rs1"]}`);
  assert.strictEqual(Number(rs1[1]), 120);
  const rs2 = /^calc\(var\(--safe-top\) \+ (\d+)px\)$/.exec(room["--rs2"] || "");
  assert.ok(rs2, `--rs2 is a safe-top-relative pixel stop: ${room["--rs2"]}`);
  const space = (n) => px(decls(TOKENS, ":root")[n]);
  const eyebrowTop = space("--s-2") + space("--tap") + space("--s-2") + space("--art-hero") + space("--s-4");
  assert.strictEqual(eyebrowTop, 236);
  assert.ok(Number(rs2[1]) <= eyebrowTop, `the mid stop (${rs2[1]}) is at or above the eyebrow (${eyebrowTop})`);
  const collageBottom = space("--s-2") + space("--tap") + space("--s-2") + space("--art-hero");
  assert.ok(Number(rs1[1]) < collageBottom, `the ramp starts behind the artwork (${rs1[1]} < ${collageBottom})`);
  assert.ok(Number(rs2[1]) - Number(rs1[1]) >= 100, `and takes at least 100px to climb (${Number(rs2[1]) - Number(rs1[1])})`);
  /* The page's own spacing is what the arithmetic read. */
  assert.strictEqual(decls(CSS, ".ag .fd-collage").margin, "var(--s-2) auto 0");
  assert.strictEqual(decls(CSS, ".ag .fd-eyebrow")["margin-top"], "var(--s-4)");
  assert.strictEqual(decls(CSS, ".ag .fd-top")["padding-top"], "calc(var(--safe-top) + var(--s-2))", "the head's buttons start 8px under the safe top");
  assert.ok(decls(CSS, ".ag.fd").padding.startsWith("0 "), "and the page adds no top padding of its own");
});

test("an unavailable Foray turns its lamp down: Glow at 8%, the artwork layer at 0.35, the strip at 60%, the collage at 50%", () => {
  /* MUTATION: \`--mix-room: 8%\` -> 15%, or \`--room-art-opacity: 0.35\` -> 0.9, or the strip's .6 -> 1, or the collage's .5 -> 1 -> red. */
  const dim = decls(CSS, ".ag .fd-room.is-dim");
  assert.strictEqual(dim["--mix-room"], "8%");
  assert.strictEqual(dim["--room-art-opacity"], "0.35");
  assert.strictEqual(decls(CSS, ".ag .fd.is-unavailable .fd-sill .fy-strip, .ag .fd.is-unavailable .fd-thumbs").opacity, ".6");
  assert.strictEqual(decls(CSS, ".ag .fd-collage.is-dim .ag-collage").opacity, ".5");
  /* --mix-room is read by the token on the element that redeclares it (.room), so the override reaches --glow-room. */
  assert.match(TOKENS, /:root, \[data-theme\], \.ag, \.room \{[^}]*--glow-room: color-mix\(in oklab, var\(--bg0\), var\(--glow\) var\(--mix-room\)\)/);
});

test("the Dawn Room is paper: the tokens give it glow-room at 20% and an artwork layer at 0.55, and the page adds nothing of its own", () => {
  /* MUTATION: change Dawn's `--mix-room: 20%` or `--room-art-opacity: 0.55` in ui/tokens.css -> red. MUTATION 2: add a
     [data-theme="dawn"] rule to foray-detail.css -> red (the scheme is the tokens' job). */
  const dawn = decls(TOKENS, `[data-theme="dawn"]`);
  assert.match(dawn["--mix-room"] ? "x" : "", /x/);
  assert.strictEqual(dawn["--room-art-opacity"], "0.55");
  assert.ok(/--mix-room: 20%/.test(read("ui/tokens.css").split(`[data-theme="dawn"] {`)[1].split("}")[0]), "Dawn mixes the room at 20%");
  assert.strictEqual(dawn["--scrim-mid-base"], "rgb(247 242 235 / 0.92)", "the paper scrim");
  assert.doesNotMatch(CSS, /data-theme|prefers-color-scheme/, "the page does not restate a scheme");
  assert.strictEqual(decls(TOKENS, ":root, [data-theme=\"dusk\"]")["--sill"], "rgb(20 17 15 / 0.22)");
  assert.strictEqual(dawn["--sill"], "rgb(255 255 255 / 0.35)");
});

/* ---------- 3. the strip on its sill ---------- */

test("the strip sits on a 10/12 sill: 24px bars on a 28px row, the current bar 4px taller, narration a 6px Lamp pill that never dims, a 20px thumbs row 6px below", () => {
  /* 28 (bars) + 6 (gap) + 20 (thumbs) = 54, the prototype's strip box; with the sill's 10 + 10 it is 74.
     MUTATION: \`.fd-thumbs { margin-top: 6px }\` -> 0 (a thumb would touch the bars) -> red. MUTATION 2: \`.fy-seg.is-here
     { height: 28px }\` -> 24 -> red. MUTATION 3: narration height 6px -> 12px -> red. MUTATION 4: sill padding -> red. MUTATION 5: delete the
     `.has-position .fy-seg--narration { opacity: 1 }` rule -> red (the ivory light dims to tan beside a resume point, the round-2
     finding). MUTATION 6: narration `border-radius` -> `var(--r-xs)` -> red (a dot is not a pill). */
  const sill = decls(CSS, ".ag .fd-sill");
  assert.strictEqual(sill.padding, "10px var(--s-3)");
  assert.strictEqual(sill.background, "var(--sill)");
  assert.strictEqual(sill["border-radius"], "var(--r-lg)");
  assert.strictEqual(px(decls(CSS, ".ag .fd-sill .fy-strip")["--strip-h"]), 28);
  assert.strictEqual(decls(CSS, ".ag .fd-sill .fy-strip").gap, "2px");
  assert.strictEqual(px(decls(CSS, ".ag .fd-sill .fy-seg").height), 24);
  assert.strictEqual(px(decls(CSS, ".ag .fd-sill .fy-seg.is-here").height), 28, "the current bar grows upward only: 4px taller, same floor");
  const narr = decls(CSS, ".ag .fd-sill .fy-seg--narration");
  assert.strictEqual(px(narr.height), 6);
  assert.strictEqual(px(narr["margin-bottom"]), 9, "centred on the 24px bars' mid line: 9 under, 9 over");
  assert.strictEqual(narr["border-radius"], "var(--r-pill)", "a pill, not a dot");
  assert.strictEqual(narr["--seg-tone"], "var(--seg-narration)");
  assert.strictEqual(decls(CSS, ".ag .fd-sill .fy-strip.has-position .fy-seg--narration").opacity, "1", "narration is Lamp ivory at full strength beside a resume point");
  const thumbs = decls(CSS, ".ag .fd-thumbs");
  assert.strictEqual(px(thumbs.height), 20);
  assert.strictEqual(px(thumbs["margin-top"]), 6);
  assert.strictEqual(thumbs["pointer-events"], "none", "the strip's hit box, not the thumbs, takes the tap");
  assert.strictEqual(px(decls(CSS, ".ag .fd-thumb").width), 20);
  assert.strictEqual(decls(CSS, ".ag .fd-thumbs:empty").display, "none", "no bar wide enough: no row, no gap");
  assert.strictEqual(decls(CSS, ".ag .fd-sill .fy-strip.has-position .fy-seg").opacity, "var(--seg-dim)");
  assert.ok(CSS.indexOf(".ag .fd-sill .fy-strip.has-position .fy-seg--narration") > CSS.indexOf(".ag .fd-sill .fy-strip.has-position .fy-seg {"), "the narration rule comes later, so it wins at equal specificity");
});

/* ---------- 4. the page, rendered by the real app.js ---------- */

const playerMods = (async () => ({
  resolve: await import("../player/foray-resolve.js"),
  strip: await import("../player/segment-strip.js"),
}))();
const FZ = "tools/foray/fixtures/frozen/data";
const readJson = (rel) => JSON.parse(read(rel));
const NARRATED = "what-engineers-actually-do-all-day-e08236";
const PLAIN = "capital-types-1";

async function bridgeOver({ resume = null } = {}) {
  const { resolve, strip } = await playerMods;
  return {
    resolve(doc, { id, segmentsDoc, sourcesDoc } = {}) {
      const f = resolve.findForay(doc, id, { unlocked: [id], showDrafts: true });
      return f ? resolve.resolveForay(f, { segments: resolve.indexSegments(segmentsDoc), sources: resolve.indexSources(sourcesDoc) }) : null;
    },
    stripTally: strip.stripTally, stripModel: strip.stripModel,
    fmtClock: resolve.fmtClock, fmtSpan: resolve.fmtSpan, narratorName: strip.NARRATOR_NAME,
    playbackRate: () => 1, rateStops: () => [1], setPlaybackRate() {},
    watchForay: () => null,
    forayResume: (_id, opts = {}) => (resume && (!resume.finished || opts.includeFinished) ? resume : null),
  };
}

function mount(hash, bridge) {
  const body = new El("body");
  const view = new El("main"); view.id = "view"; body.appendChild(view);
  for (const id of ["drawer", "drawer-overlay", "menu-btn", "refresh-btn", "drawer-playlists"]) {
    const e = new El("div"); e.id = id; body.appendChild(e);
  }
  const store = new Map();
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: () => new Promise(() => {}),
    localStorage: {
      get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); },
    },
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
  ctx.ForayPlayer = bridge;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  runAppSource(APP_SRC, ctx);
  const state = vm.runInContext("state", ctx);
  state.ready = true;
  state.session = { session_id: "s", builder: "t", episodes: {}, cards: [] };
  state.discover = { items: [] };
  state.taxonomy = { nodes: [{ id: "business", label: "Business", parent: null }, { id: "engineering", label: "Engineering", parent: null }] };
  state.catalog = { shows: [] };
  return { ctx, state, view, store, html: () => view.innerHTML };
}

async function mountForay(id, { resume = null, tweakSources = null, catalog = null, indexRows = null, setup = null } = {}) {
  const b = await bridgeOver({ resume });
  const m = mount(`#/foray/${id}`, b);
  if (setup) setup(m);
  m.state.forays = readJson(`${FZ}/forays.json`);
  m.state.segments = readJson(`${FZ}/segments.json`);
  const sources = readJson(`${FZ}/segment-sources.json`);
  if (tweakSources) tweakSources(sources);
  m.state.segmentSources = sources;
  if (catalog) m.state.catalog = catalog;
  if (indexRows) { m.ctx.__idx = { keys: [], rows: indexRows }; vm.runInContext("showIndex = __idx;", m.ctx); }
  m.ctx.renderCurrentPage();
  await new Promise((r) => setTimeout(r, 20));
  return m;
}
const text = (html, re) => (re.exec(html) || [])[1] || "";
const caption = (html) => text(html, /<p class="t-caption num fd-caption">([^<]*)<\/p>/);

test("the page is a Room with the collage, the eyebrow, the title and the caption, in that order, wearing the type styles", async () => {
  /* BUILD-NOTES 4.6: chevron-left 44 and share 44, the collage 160, "Foray · <subject>" in Lamp, the title through
     --t-title with a three-line clamp, the caption. The eyebrow is the primitive's `.eyebrow.lamp` (colour --lamp-text,
     contrast pinned in the token suite), and the title is the page's heading (data-page-heading) so the router can name it.
     MUTATIONS: clamp3 -> clamp4 on the title -> red; `ag-collage-160` -> 120 -> red; drop `eyebrow lamp` -> red; swap the
     eyebrow and the title -> red; drop data-page-heading -> red (and landOnPage finds no heading). */
  const m = await mountForay(PLAIN);
  const html = m.html();
  const order = ["fd-room", "fd-top", "fd-collage", "fd-eyebrow", "fd-title", "fd-caption", "fd-sill"].map((c) => html.indexOf(`class="${c}`) >= 0 ? html.indexOf(`class="${c}`) : html.indexOf(` ${c}`));
  assert.ok(order.every((i) => i >= 0), `every piece is there: ${order}`);
  assert.deepStrictEqual([...order].sort((a, b) => a - b), order, "in reading order");
  assert.match(html, /<span class="ag-collage ag-collage-160 c4 lit-art lit-64">/, "the 160 collage, lit by its own colour (four shows: 2x2)");
  assert.match(html, /<p class="eyebrow lamp fd-eyebrow">Foray · Business<\/p>/);
  assert.match(html, /<h1 class="t-title clamp3 fd-title" data-page-heading>The types of capital a startup can raise<\/h1>/);
  assert.ok(m.ctx.pageHeading(m.view), "pageHeading() finds the title: the route's focus and announcement land on it");
  assert.match(html, /<a class="back ag-btn ag-btn-icon" href="#\/forays" aria-label="Back">/, "the chevron is the ordinary back link");
  assert.match(html, /<button type="button" class="ag-btn ag-btn-icon fd-share" aria-label="Share this foray">/);
  assert.doesNotMatch(html, /style="/, "no inline style: the strict CSP forbids it");
  assert.ok(m.view.querySelector("#fd-thumbs"), "the thumbs row exists for the strip to fill");
});

test("the caption is '<n> shows · <m> min · narrated' or 'not narrated yet', counting the shows the strip draws", async () => {
  /* The count is the strip's own tally (audit 2026-09-22, theme L): a show whose only clip will not play is not counted.
     "about" is said when part of the runtime is an estimate (a narrated Foray's bridges are timed from their script).
     MUTATIONS: say "narrated" with no narration -> red. Count `r.shows.length` over playable ones -> red (the ghost test in
     load-states). Drop the `about` hedge -> red. */
  const plain = caption((await mountForay(PLAIN)).html());
  assert.match(plain, /^7 shows · \d+ min · not narrated yet$/, plain);
  const narrated = await mountForay(NARRATED);
  const cap = caption(narrated.html());
  assert.match(cap, /^\d+ shows? · about \d+ min · narrated$/, cap);
  const { strip } = await playerMods;
  assert.strictEqual(Number(/^(\d+)/.exec(cap)[1]), strip.stripTally(narrated.state.foray.playable).shows, "the strip's own count");
});

test("the primary button is Play, 'Resume · N min left', or 'Play again', full width, in the Ember primitive", async () => {
  /* One button, three words; the resume state also fills the strip (that is paintForay's work, pinned in
     player/foray-playback.test.js) and has NO second control: the direction defines one button, and a "Start over" link under
     it (round-2 finding) put 44px of action and 100px between the button and "Why 4a made this" where the prototype has
     24. Starting from the top is the first clip's row and the strip's first bar. The middle dot, never a comma.
     MUTATIONS: join with ", " in forayPrimaryLabel -> red. Drop `finished` from renderForay's label call -> red. Put a
     \`<button id="fy-restart">\` back in renderForay -> red. */
  const fresh = (await mountForay(PLAIN)).html();
  assert.match(fresh, /<button type="button" class="ag-btn ag-btn-primary fd-cta" id="fy-play">Play<\/button>/);
  assert.doesNotMatch(fresh, /fy-restart|fd-resume|Start over/, "one button, nothing under it");
  const mid = (await mountForay(PLAIN, { resume: { elapsedSec: 1180, index: 9, remainingSec: 1900, percent: 38, finished: false, label: "32 min left", clock: "19:40" } })).html();
  assert.match(mid, /id="fy-play" aria-label="Resume, 32 min left">Resume · 32 min left<\/button>/, "the visible words start the accessible name");
  assert.doesNotMatch(mid, /fy-restart|fd-resume|Start over/, "a resume point adds no second action");
  assert.doesNotMatch(mid.replace(/aria-label="[^"]*"/g, ""), /Resume, 32/, "a middle dot on screen, not a comma");
  const done = (await mountForay(PLAIN, { resume: { elapsedSec: 3000, index: 21, remainingSec: 0, percent: 100, finished: true, label: "Played" } })).html();
  assert.match(done, /id="fy-play">Play again<\/button>/);
  assert.doesNotMatch(done, /fy-restart|fd-resume|Start over/);
  assert.strictEqual(decls(CSS, ".ag .fd-resume"), null, "no rule for a control that is not there");
  assert.match(decls(CSS, ".ag .fd-cta").display, /flex/);
  assert.strictEqual(decls(CSS, ".ag .fd-cta").width, "100%");
});

test("a Foray that cannot play dims, says so in one line, and offers Find similar into Discover with the subject", async () => {
  /* Every clip's source loses its audio URL: each still resolves (its show, its why-line) and none will play. The page keeps
     its shape: the collage at 50% with the wifi-slash, the strip still drawn, the shows below; the primary button is a
     link to #/shows/q/<subject> and #fy-play is gone, so nothing can start.
     MUTATIONS: render #fy-play when nothing is playable -> red. Drop the one line -> red. Make Find similar point at #/shows
     without the subject -> red. Drop is-unavailable from the page -> red (it drives the dimming). */
  const m = await mountForay(PLAIN, { tweakSources: (doc) => { for (const row of doc.sources) row.audio_url = null; } });
  const html = m.html();
  assert.strictEqual(m.state.foray.playable.length, 0, "fixture: nothing plays");
  assert.match(html, /<div class="ag fd is-fresh is-unavailable">/);
  assert.match(html, /<div class="room fd-room is-dim" aria-hidden="true">/);
  assert.match(html, /<div class="fd-collage is-dim">[\s\S]*<span class="fd-slash"><svg[^>]*><use href="ui\/icons\.svg#i-wifi-slash">/);
  assert.match(html, /<p class="t-body fd-unavailable">This foray can’t play right now\. Its shows are below\.<\/p>/);
  assert.match(html, /<a class="ag-btn ag-btn-primary fd-cta" id="fy-find" href="#\/shows\/q\/Business">Find similar<\/a>/);
  assert.ok(!/id="fy-play"/.test(html), "nothing can be started");
  assert.ok(m.view.querySelectorAll("#fy-strip .fy-seg").length > 0, "the strip is still drawn from the authored clips");
  assert.match(caption(html), /^7 shows · \d+ min · not narrated yet$/, "its authored shows and length, not zero");
  assert.ok(m.view.querySelectorAll(".fd-tile").length === 7, "the shows are below");
  assert.ok(!/is-unavailable|is-dim/.test((await mountForay(PLAIN)).html()), "an ordinary Foray is not dimmed");
});

test("a Foray with no narration draws no narration bars and says so once, in the caption", async () => {
  /* "nothing else apologises". MUTATION: render the strip's bars from an item list with narrator placeholders -> red.
     MUTATION 2: add an apology line to the page (any 'not yet'/'sorry' outside the caption) -> red. */
  const m = await mountForay(PLAIN);
  const html = m.html();
  assert.ok(!/fy-seg--narration/.test(html) && !/fd-nbar/.test(html), "no narration bar, no narration row");
  const sentences = html.replace(/<[^>]*>/g, " ").match(/not narrated yet/g) || [];
  assert.strictEqual(sentences.length, 1, "said once");
  assert.ok(!/sorry|unfortunately/i.test(html));
});

test("a narrated Foray's clip rows are QueueRows with show art; its narration rows are Lamp, with a light and no art", async () => {
  /* MUTATIONS: drop forayRowLead from the tape row -> red (no art). Render art on a narration row -> red. Drop the
     narrator's .is-narrator credit -> red (Lamp colour is keyed on it). */
  const m = await mountForay(NARRATED);
  const rows = m.html().split('<div class="fy-row').slice(1);
  assert.ok(rows.length > 40, `fixture: a long narrated Foray (${rows.length} rows)`);
  const tape = rows.filter((r) => !/fy-credit is-narrator/.test(r));
  const narr = rows.filter((r) => /fy-credit is-narrator/.test(r));
  assert.ok(tape.length >= 10 && narr.length >= 30, `${tape.length} tape rows, ${narr.length} narration rows`);
  for (const r of tape) assert.match(r, /<span class="fd-rowart" aria-hidden="true"><span class="ag-art ag-art-56/, "tape rows lead with 56px show art");
  for (const r of narr) {
    assert.match(r, /<span class="fd-nbar" aria-hidden="true"><\/span>/, "narration rows lead with a thin light");
    assert.ok(!/fd-rowart|ag-art/.test(r), "and carry no art");
  }
  assert.match(m.html(), /<h2 class="t-headline">Clips, in order<\/h2>/);
  const row = decls(CSS, ".ag .fd-clips .fy-row");
  assert.strictEqual(row["grid-template-columns"], "var(--art-queue) minmax(0, 1fr)");
  assert.strictEqual(decls(CSS, ".ag .fd-clips .fy-credit.is-narrator").color, "var(--lamp-text)");
  assert.strictEqual(decls(CSS, ".ag .fd-clips .fy-row:has(.fd-nbar)").background, "none", "a narration row is not a raised card");
});

test("'Why 4a made this' is the italic why-line in Lamp, three lines at most", async () => {
  /* MUTATIONS: clamp3 -> clamp4 -> red. Render it in --text instead of --lamp-text -> red. Drop the section when there is
     a summary -> red. */
  const m = await mountForay(PLAIN);
  assert.match(m.html(), /<section class="fd-why"><h2 class="t-headline">Why 4a made this<\/h2><p class="t-why clamp3">Eight ways to fund a company/);
  assert.strictEqual(decls(CSS, ".ag .fd-why .t-why").color, "var(--lamp-text)");
  assert.match(TOKENS, /\.t-why \{ font: var\(--t-why\); \}/, "the italic is the token's");
  assert.match(TOKENS, /--t-why: italic /);
});

test("'Where this came from' is three-up tiles; a show the catalogue knows gets Follow, one it does not has none", async () => {
  /* The tile's name clamps to three lines (never cut mid-word), the art is the tile's width, the Follow toggle sits under
     it, and a tap toggles the show through toggleShowStar and repaints the button, the badge and aria-pressed.
     MUTATIONS: the grid's 3 columns -> 4 -> red. clamp3 -> clamp2 -> red. Drop `aria-pressed` -> red. Render Follow for a
     show without a catalogue record -> red. Skip paintForayFollows after the toggle -> red. */
  /* "Feel the Boot" is in the show index but not in the catalogue: its tile links in-app (id "111") yet it has no record
     for Follow to act on. */
  const m = await mountForay(PLAIN, {
    catalog: { shows: [{ show_id: "yc", title: "Y Combinator Startup Podcast", taxonomy_node_ids: [] }] },
    indexRows: [{ show_id: "111", title: "Feel the Boot", tier: "breadth" }],
  });
  assert.match(m.html(), /<a class="fd-tile-face" href="#\/show\/111">[\s\S]*?Feel the Boot<\/span><\/a><\/li>/, "a show the index knows links in-app and has no Follow under it");
  const tiles = m.view.querySelectorAll(".fd-tile");
  assert.strictEqual(tiles.length, 7);
  const follows = m.view.querySelectorAll("[data-fd-follow]");
  assert.strictEqual(follows.length, 1, "only the catalogued show can be followed");
  assert.strictEqual(follows[0].dataset.fdFollow, "yc");
  assert.strictEqual(follows[0].getAttribute("aria-pressed"), "false");
  assert.strictEqual(follows[0].getAttribute("aria-label"), "Follow Y Combinator Startup Podcast");
  assert.match(m.html(), /data-fd-follow="yc" aria-pressed="false"[^>]*>[\s\S]*?<span>Follow<\/span>/);
  assert.match(m.html(), /<span class="t-caption name clamp3">Y Combinator Startup Podcast<\/span>/);
  follows[0].click();
  assert.ok(vm.runInContext(`isShowStarred("yc")`, m.ctx), "the tap followed the show");
  const after = m.view.querySelectorAll("[data-fd-follow]")[0];
  assert.strictEqual(after.getAttribute("aria-pressed"), "true");
  assert.match(after.innerHTML, />Following<\/span>/);
  assert.strictEqual(decls(CSS, ".ag .fd-tiles")["grid-template-columns"], "repeat(3, minmax(0, 1fr))");
  assert.strictEqual(decls(CSS, ".ag .fd-tile .ag-art").width, "100%");
  assert.strictEqual(decls(CSS, ".ag .fd-tile .ag-art-badge").display, "none", "the check badge shows only on a followed tile");
  assert.strictEqual(decls(CSS, ".ag .fd-tile.is-followed .ag-art-badge").display, "block");
  assert.match(m.html(), /Following keeps a show one tap away in your Library/, "what Follow does is said where it is tapped");
});

test("every show name, episode title and URL that reaches the page goes through esc() or safeUrl()", async () => {
  /* A show name and an episode title are somebody else's text. MUTATIONS: drop esc() around the tile's name -> red; around
     the row's art name (agArtwork's aria-label) -> red; drop safeUrl from the external tile's href -> red. */
  const evil = `Evil "<img src=x onerror=alert(1)>" & Co`;
  const m = await mountForay(PLAIN, { tweakSources: (doc) => { for (const row of doc.sources) { row.show = evil; row.title = `<script>alert(2)</script>`; } } });
  const html = m.html();
  assert.ok(!/<img src=x/.test(html) && !/<script>alert/.test(html), "nothing hostile became markup");
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"), "and it is on the page as text");
  /* An external tile link with a hostile URL falls back to '#'. */
  const bridge = await bridgeOver();
  bridge.forayCredits = () => ({ summary: "", credits: [{ show: "No Page Show", link: "javascript:alert(3)", linkKind: "apple-search" }] });
  const m2 = mount(`#/foray/${PLAIN}`, bridge);
  const out = vm.runInContext(`forayCameFromHtml({ shows: ["No Page Show"], entries: [{ show: "No Page Show" }] }, ForayPlayer)`, m2.ctx);
  assert.ok(!/javascript:/.test(out), out);
  assert.match(out, /href="#"/);
});

test("the Room's artwork URL cannot end its own string, and a URL safeUrl refuses is no artwork", () => {
  /* MUTATION: drop the percent-encoding replace in forayRoomArtValue -> red. MUTATION 2: skip safeUrl -> red. */
  const m = mount("#/", null);
  const run = (js) => vm.runInContext(js, m.ctx);
  assert.strictEqual(run(`forayRoomArtValue('https://x.test/a"b.jpg')`), `url("https://x.test/a%22b.jpg")`);
  assert.strictEqual(run(`forayRoomArtValue('https://x.test/a\\\\b.jpg')`), `url("https://x.test/a%5cb.jpg")`);
  assert.strictEqual(run(`forayRoomArtValue("javascript:alert(1)")`), "none");
  assert.strictEqual(run(`forayRoomArtValue("")`), "none");
  assert.ok(!/style="/.test(APP_SRC.slice(APP_SRC.indexOf("function forayRoomArtValue"), APP_SRC.indexOf("function forayRoomArtValue") + 500)));
});

test("the page opens unanimated: is-fresh is on the first markup and comes off a moment later", async () => {
  /* The Room, the bars and the rows must not crossfade into the state they open in (the strip is measured while it is built,
     so the browser has styled it before the player's first paint changes a class). MUTATION: drop the settle call at the end of
     renderForay -> the class never comes off and every later change is frozen; red. MUTATION 2: drop `is-fresh` from the
     template -> red. */
  const m = await mountForay(PLAIN);
  assert.ok(/<div class="ag fd is-fresh"/.test(m.html()), "painted fresh");
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(!m.view.querySelector(".fd").classList.contains("is-fresh"), "and settled");
});

/* ---------- 5. rules that need no browser ---------- */

test("a thumb sits under a tape bar of 12px or more, left-aligned, 4px clear of the last, inside the strip, and under no narration bar", async () => {
  /* The bars' widths are layout, so the rule is read from a stand-in strip: bars reporting offsetWidth and offsetLeft.
     Round-2 finding: the sill had no thumbnail row at all on the 50-clip Foray (bars of 8 to 16px, and the old rule
     wanted 28), so the signature of the sill was missing in the data the lab happens to hold.
     MUTATIONS: \`>= FORAY_THUMB_MIN_BAR_PX\` -> \`> 0\` -> red (an 8px bar gets one). Drop the narration check -> red.
     Use \`offsetLeft + offsetWidth\` for x -> red (a thumb would sit under the bar's end). Drop the \`freeFrom\` test ->
     red (packed bars get overlapping thumbs). Drop the \`stripWidth\` test -> red (a thumb hangs off the right edge). */
  const m = await mountForay(NARRATED);
  const r = m.state.foray;
  const entries = vm.runInContext("forayStripEntries", m.ctx)(r);
  const shows = vm.runInContext("forayShowsOf", m.ctx)(r);
  const tones = new Map([[shows[0].name, "oklch(0.7 0.13 40)"]]);
  const cellsOf = (bars, width) => vm.runInContext("forayThumbCells", m.ctx)(r, shows, tones, bars, width);
  const tape = (i) => entries[i] && entries[i].type !== "narration" && entries[i].show;

  /* Spread out: only the width decides. */
  const spread = entries.map((e, i) => ({ offsetWidth: i % 3 === 0 ? 40 : 8, offsetLeft: i * 50 }));
  const expected = entries.map((e, i) => i).filter((i) => tape(i) && spread[i].offsetWidth >= 12);
  assert.ok(expected.length >= 2, `fixture: some wide tape bars (${expected.length})`);
  const cells = cellsOf(spread);
  assert.deepStrictEqual(Array.from(cells, (c) => c.x), expected.map((i) => i * 50), "left edges, one per wide tape bar");
  assert.strictEqual(vm.runInContext("FORAY_THUMB_MIN_BAR_PX", m.ctx), 12);
  assert.ok(cells.every((c) => c.tone === "oklch(0.7 0.13 40)" || c.tone === ""));
  assert.ok(cells.every((c) => /fd-thumb-mono|<img /.test(c.html)));

  /* Packed (a long Foray): every bar is 14px on a 16px pitch, so a 20px thumb would cover the next bar's. A thumb
     starts only 24px (20 + 4) after the last one. */
  let k = 0;
  const packed = entries.map((e, i) => ({ offsetWidth: 14, offsetLeft: tape(i) ? 16 * k++ : 0 }));
  const xs = Array.from(cellsOf(packed), (c) => c.x);
  assert.ok(xs.length >= 2, `fixture: several thumbs fit (${xs.length})`);
  xs.slice(1).forEach((x, k) => assert.ok(x - xs[k] >= 24, `thumbs ${xs[k]} and ${x} are 4px clear (${x - xs[k]})`));
  /* The first tape bar always gets one, whatever follows. */
  assert.strictEqual(xs[0], 0, "the first tape bar's thumb is never skipped");
  assert.ok(xs.length < k, `and packed bars do not each get one (${xs.length} thumbs, ${k} bars)`);

  /* The right edge: no thumb runs past the strip. */
  const edge = cellsOf(spread, 40 * 0 + (expected[expected.length - 1] * 50 + 19));
  assert.ok(Array.from(edge, (c) => c.x).every((x) => x + 20 <= expected[expected.length - 1] * 50 + 19), "inside the strip");
  assert.strictEqual(edge.length, cells.length - 1, "the last one would hang off the end, so it is dropped");
});

test("show colours: a show's hue from the palette at L .70 (Dusk) or .52 (Dawn), a hue within 24 degrees of an earlier show rotates +30", async () => {
  /* BUILD-NOTES 1.2 step 3. The palette is stubbed so three shows collide on one hue.
     MUTATION: drop the rotation loop in forayTones -> red (all three share 100). MUTATION 2: rotate by 10 -> red (still
     within 24). MUTATION 3: Dawn lightness .70 -> red. */
  const m = mount("#/", null);
  vm.runInContext(`agPaletteFor = () => [100, 0.1]; agGlowLightness = () => 0.66;`, m.ctx);
  const dusk = vm.runInContext(`forayTones(["A", "B", "C"])`, m.ctx);
  const hues = [...dusk.values()].map((v) => Number(/oklch\(0\.7 0\.13 (\d+)\)/.exec(v)[1]));
  assert.deepStrictEqual(hues, [100, 130, 160]);
  for (let i = 0; i < hues.length; i++) for (let j = 0; j < i; j++) assert.ok(Math.abs(hues[i] - hues[j]) >= 24);
  vm.runInContext(`agGlowLightness = () => 0.56;`, m.ctx);
  assert.match([...vm.runInContext(`forayTones(["A"])`, m.ctx).values()][0], /^oklch\(0\.52 0\.13 100\)$/);
  vm.runInContext(`agPaletteFor = undefined;`, m.ctx);
  assert.strictEqual(vm.runInContext(`forayTones(["A"])`, m.ctx).size, 0, "no palette script: no tones, the strip keeps its own");
});

test("the share link is the published site's page for this Foray, never the shell's own origin, and sends nothing to 4a", () => {
  /* MUTATION: build the URL from `location.href` -> red (capacitor://localhost is no address anyone else can open).
     MUTATION 2: add a fetch or logEvent to shareForay -> red. */
  const src = APP_SRC.slice(APP_SRC.indexOf("async function shareForay("), APP_SRC.indexOf("/** Show -> Apple collection id"));
  assert.match(APP_SRC, /const FORAY_SHARE_BASE = "https:\/\/jw-incorporated\.github\.io\/foray\/";/);
  assert.match(src, /`\$\{FORAY_SHARE_BASE\}#\/foray\/\$\{encodeURIComponent\(r\.id\)\}`/);
  assert.ok(!/location\./.test(src), "the shell's origin is not read");
  assert.ok(!/fetch\(|logEvent\(|sendBeacon/.test(src), "share writes nothing anywhere");
});

test("the page has no transport of its own: the bindings still run when the controls that left it are absent", async () => {
  /* renderForay must not throw on a page with no #fy-back / #fy-fwd / #fy-prev / #fy-next / #fy-rate (the real page has
     none). MUTATION: drop a `?.` from a binding in bindForayTransport -> this throws inside renderForay -> red. */
  const m = await mountForay(PLAIN);
  assert.ok(m.view.querySelector("#fy-play"), "the page painted past its bindings");
  assert.strictEqual(m.view.querySelector("#fy-play").listeners("click"), 1, "and the primary button is wired");
  for (const id of ["fy-back", "fy-fwd", "fy-prev", "fy-next", "fy-rate"]) assert.strictEqual(m.view.querySelector(`#${id}`), null, `#${id} is not on the page`);
});

/* ---------- 6. the Dock on this page (iteration 4) ---------- */

test("the Dock on Foray detail is the warm Veil, not the legacy slab: inset, rounded, Glow-tinted, DM Sans title, Ember Play, Glow progress line", () => {
  /* Iteration 3 shipped the legacy full-width violet-black bar (a third hue), a violet Play disc, a Fraunces-bold mini title,
     and an opaque surface under an orange progress line.
     MUTATION 1: change `background: var(--glow-veil)` on `body.view-foray-detail .tab-bar` to `var(--surface)` -> red.
     MUTATION 2: drop `left`/`right` or set `border-radius: 0` on the bar -> red.
     MUTATION 3: delete the `.fp-play` rule, or put `var(--violet)` anywhere in the sheet -> red.
     MUTATION 4: delete the `.fp-title` rule (the legacy Fraunces `--font-display` title returns) or give it `var(--font-display)` -> red.
     MUTATION 5: delete the `.fp-progress` rule (the opaque navy track returns under the line) or set `.fp-fill` to `var(--ember)` -> red.
     MUTATION 6: delete the `@supports not` / `prefers-reduced-transparency` / `prefers-contrast` fallback blocks -> red. */
  const bar = decls(CSS, "body.view-foray-detail .tab-bar");
  assert.ok(bar, "the bar rule exists");
  assert.strictEqual(bar.left, "var(--ag-gutter)");
  assert.strictEqual(bar.right, "var(--ag-gutter)", "a floating Dock, not a full-width bar");
  assert.strictEqual(bar.bottom, "var(--dock-lift)");
  assert.strictEqual(bar["border-radius"], "var(--r-xl)");
  assert.strictEqual(bar.background, "var(--glow-veil)", "the warm Glow-tinted Veil, never the legacy surface");
  assert.match(bar["backdrop-filter"], /blur\(20px\) saturate\(140%\)/);
  assert.match(bar["box-shadow"], /var\(--rim\)/);
  const mini = decls(CSS, "body.view-foray-detail.ui-v2.fp-open #foray-player");
  assert.ok(mini, "the mini rule exists");
  assert.strictEqual(mini.background, "var(--glow-veil)", "the mini is the same Veil, the Dock's top row");
  assert.strictEqual(mini["border-radius"], "var(--r-xl) var(--r-xl) 0 0");
  assert.match(mini["backdrop-filter"], /blur\(20px\)/);
  assert.strictEqual(decls(CSS, "body.view-foray-detail.fp-open .tab-bar")["border-radius"], "0 0 var(--r-xl) var(--r-xl)");
  assert.strictEqual(decls(CSS, "body.view-foray-detail.ui-v2 #foray-player .fp-play").background, "var(--ember)", "Ember on the Veil, never violet");
  assert.doesNotMatch(CSS, /--violet/, "the third hue is nowhere on this page");
  assert.strictEqual(decls(CSS, "body.view-foray-detail #foray-player .fp-title").font, "var(--t-label)", "the mini title is the DM Sans label style, not Fraunces");
  assert.strictEqual(decls(CSS, "body.view-foray-detail #foray-player .fp-progress").background, "transparent", "the line sits on the Veil, not on an opaque track");
  assert.strictEqual(decls(CSS, "body.view-foray-detail #foray-player .fp-fill").background, "var(--glow)");
  assert.strictEqual(declsAll(CSS, "body.view-foray-detail")["--tab-bar-h"], "calc(var(--tab-bar) + var(--dock-inset))", "the legacy sums read the Dock's real height");
  /* MUTATION 7: delete the collapsed `overflow: hidden` -> the progress line pokes out past the rounded top corners -> red.
     MUTATION 8: delete the expanded `backdrop-filter: none` -> the fixed Now Playing sheet is confined to the bar's box -> red. */
  assert.strictEqual(decls(CSS, "body.view-foray-detail.ui-v2.fp-open:not(.fp-expanded) #foray-player").overflow, "hidden");
  assert.strictEqual(decls(CSS, "body.view-foray-detail.ui-v2.fp-open.fp-expanded #foray-player")["backdrop-filter"], "none", "a blurred bar would contain the fixed sheet");
  for (const q of ["@supports not", "@media (prefers-reduced-transparency", "@media (prefers-contrast"]) {
    assert.ok(CSS.includes(q), `the Dock has its ${q} fallback`);
  }
});

test("the last tile is never sliced by the Dock: a fixed fade solid from 32px above the Dock's top row to the screen edge, under the Dock", () => {
  /* MUTATION 1: delete the `body.view-foray-detail::after` rule -> red. MUTATION 2: z-index 56 (over the Dock) or pointer-events
     auto (it would eat taps) -> red. MUTATION 3: end the gradient at `transparent` instead of bg0 -> red. */
  const fade = decls(CSS, "body.view-foray-detail::after");
  assert.ok(fade, "the fade exists");
  assert.strictEqual(fade.position, "fixed");
  assert.strictEqual(fade.bottom, "0");
  assert.strictEqual(fade["pointer-events"], "none");
  assert.ok(Number(fade["z-index"]) < 55 && Number(fade["z-index"]) > 1, "over the content, under the legacy bar (55)");
  assert.strictEqual(fade.height, "calc(var(--fd-dock-h) + var(--s-8))", "32px taller than the Dock");
  assert.strictEqual(fade.background, "linear-gradient(transparent 0, var(--bg0) var(--s-8))");
  assert.strictEqual(declsAll(CSS, "body.view-foray-detail")["--fd-dock-h"], "calc(var(--dock-lift) + var(--tab-bar))");
  assert.strictEqual(decls(CSS, "body.view-foray-detail.fp-open")["--fd-dock-h"], "calc(var(--dock-lift) + var(--tab-bar) + var(--mini))", "the mini row is part of the Dock when something plays");
});

test("the page lights the root's Glow with its first show's, so the Dock (outside the page) is tinted by the Room", () => {
  /* The Dock lives on <body>; a `--glow` set only on `.fd` never reaches it, so the Veil mixed the root's stale Glow.
     MUTATION: delete the forayCssVar(document.documentElement, "--glow", glow) line in ui/foray.js -> red. */
  assert.match(read("ui/foray.js"), /forayCssVar\(document\.documentElement, "--glow", glow\)/);
});

/* ---------- 7. review fixes: the unavailable row's contrast, and the thumbs observer's lifetime ---------- */

test("an unavailable clip row dims its art only: its words keep full strength and clear AA in Dusk and Dawn", () => {
  /* The row carried `opacity: .6` (copied from styles.css:3124), which dims the text with it: over the Room text-2 measured
     3.47:1 and warn 3.86:1 in Dusk, 2.81:1 and 2.61:1 in Dawn, all under 4.5:1. The new unavailable Foray shows every row
     this way. The axe gate cannot see it (the Room is a blurred image), so the numbers are pinned here.
     MUTATIONS: put `opacity: .6` back on `.ag .fd-clips .fy-row.is-out` -> red. Drop the `.fd-rowart` dimming -> red (the
     row would look available). Add any other opacity rule for .is-out to this sheet -> red. */
  const row = declsAll(CSS, ".ag .fd-clips .fy-row.is-out");
  assert.strictEqual(row.opacity, "1", "the row is not group-dimmed; styles.css:3124 and :3879 dim it at 0.6 and this must win");
  assert.strictEqual(declsAll(CSS, ".ag .fd-clips .fy-row.is-out .fd-rowart").opacity, ".6", "the art is what dims");
  const dimmed = [...CSS.matchAll(/([^{}]*\.is-out[^{}]*)\{([^{}]*)\}/g)]
    .filter((m) => /opacity\s*:\s*0?\.[0-9]+/.test(m[2])).map((m) => m[1].trim());
  assert.deepStrictEqual(dimmed, [".ag .fd-clips .fy-row.is-out .fd-rowart"], "nothing else in this sheet dims an .is-out row");
  /* (0,4,0) beats the legacy body.ui-v2 .fy-row.is-out (0,3,1) at styles.css:3879. */
  assert.strictEqual(".ag .fd-clips .fy-row.is-out".split(".").length - 1, 4);

  /* The words that stay at full strength: caption meta and why-line in text-2, the out line in warn, over the row (bg1) or
     the page (bg0). Dusk is the first declaration of each token in tokens.css, Dawn the second (the prefers-color-scheme block). */
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const hexes = (name) => [...TOKENS.matchAll(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`, "g"))].map((m) => m[1]);
  const pick = (name, scheme) => { const h = hexes(name); assert.ok(h.length >= 2, `${name} is declared for both schemes`); return scheme === "Dusk" ? h[0] : h[1]; };
  for (const scheme of ["Dusk", "Dawn"]) {
    for (const bg of ["--bg0", "--bg1"]) {
      for (const fg of ["--text-2", "--warn"]) {
        const r = ratio(pick(fg, scheme), pick(bg, scheme));
        assert.ok(r >= 4.5, `${scheme} ${fg} ${pick(fg, scheme)} on ${bg} ${pick(bg, scheme)} is ${r.toFixed(2)}:1`);
      }
    }
  }
});

/** A ResizeObserver stand-in, honest about the one thing that matters: it never calls back after disconnect(). */
function observerStub() {
  const all = [];
  class RO {
    constructor(cb) { this.cb = cb; this.targets = []; this.disconnected = false; all.push(this); }
    observe(el) { this.targets.push(el); }
    disconnect() { this.disconnected = true; }
    fire() { if (!this.disconnected) this.cb([], this); }
  }
  return { RO, all, live: () => all.filter((o) => !o.disconnected) };
}

/** The fake DOM answers the questions the strip's observer asks the way a browser does: isConnected walks to <body> through
    each parent's CURRENT children (innerHTML drops the old ones), a connected strip is 300 wide and a detached one 0, and
    tape bars are 20px wide on a 24px pitch so every tape bar earns a thumbnail. */
function withBrowserishDom(fn) {
  const P = El.prototype;
  const keys = ["isConnected", "offsetWidth", "offsetLeft", "getBoundingClientRect"];
  const saved = keys.map((k) => [k, Object.getOwnPropertyDescriptor(P, k)]);
  Object.defineProperty(P, "isConnected", { configurable: true, get() {
    let n = this;
    while (n.parent) { if (!n.parent.children.includes(n)) return false; n = n.parent; }
    return n.tagName === "BODY";
  } });
  Object.defineProperty(P, "offsetWidth", { configurable: true, get() { return 20; } });
  Object.defineProperty(P, "offsetLeft", { configurable: true, get() { return this.parent ? this.parent.children.indexOf(this) * 24 : 0; } });
  P.getBoundingClientRect = function () { return { top: 0, left: 0, height: 0, width: this.id === "fy-strip" && this.isConnected ? 300 : 0 }; };
  const restore = () => { for (const [k, d] of saved) { if (d) Object.defineProperty(P, k, d); else delete P[k]; } };
  return Promise.resolve().then(fn).then((v) => { restore(); return v; }, (e) => { restore(); throw e; });
}

test("opening one Foray from another never lets the first page's observer repaint the second's thumbnails", () => {
  /* Repro (review): Foray B is playing, open A's page, open Now Playing, tap its Foray link to #/foray/B. A's strip leaves
     the DOM, its ResizeObserver fires once at width 0 (!= its 300), and the callback re-queried #fy-strip / #fd-thumbs, so it
     redrew B's row with A's shows and artwork against B's bars. Each render also leaked one observer.
     MUTATIONS: delete `disconnectForayStripObserver()` from renderForay -> red (A's observer is still live, two observers
     live). Revert the callback to `paintForayThumbs(r, shows, tones)` (the globals) AND drop the isConnected guard AND the
     disconnect -> red (B's row is rewritten with A's thumbs). */
  return withBrowserishDom(async () => {
    const ro = observerStub();
    const m = await mountForay(PLAIN, { setup: (mm) => { mm.ctx.ResizeObserver = ro.RO; } });
    assert.strictEqual(ro.all.length, 1, "A's page watches its strip");
    const rowA = m.view.querySelector("#fd-thumbs").innerHTML;
    assert.match(rowA, /fd-thumb/, "fixture: A's bars earned thumbnails (else this proves nothing)");

    m.ctx.location.hash = `#/foray/${NARRATED}`;
    m.ctx.renderCurrentPage();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(m.state.foray.id, NARRATED, "fixture: B rendered");
    assert.strictEqual(ro.all.length, 2, "B's page watches its own strip");
    assert.strictEqual(ro.all[0].disconnected, true, "A's observer was disconnected when B's render began");
    assert.strictEqual(ro.live().length, 1, "exactly one live observer: nothing leaks per render");

    const rowB = m.view.querySelector("#fd-thumbs").innerHTML;
    assert.match(rowB, /fd-thumb/);
    assert.notStrictEqual(rowB, rowA, "fixture: the two Forays' thumbnail rows differ");
    ro.all[0].fire(); /* a browser would not call back after disconnect(); the stub agrees */
    ro.all[1].fire(); /* B's own strip is unchanged in width, so it repaints nothing */
    assert.strictEqual(m.view.querySelector("#fd-thumbs").innerHTML, rowB, "B's thumbnails are still B's");
  });
});

test("a strip that has left the document stops its observer and paints nothing, even into another page's #fd-thumbs", () => {
  /* The guard on its own, with no second render to disconnect it: the view is replaced by something that happens to carry
     the same ids, then the first page's observer fires (a removed node reports width 0, which differs from its last).
     MUTATION: delete the `if (!strip.isConnected) {...}` line in ui/foray.js -> red (the observer never disconnects itself, and repaints a detached row). Swap the closure strip/row for the global $("#fy-strip") lookups as well -> red (the sentinel is overwritten). */
  return withBrowserishDom(async () => {
    const ro = observerStub();
    const m = await mountForay(PLAIN, { setup: (mm) => { mm.ctx.ResizeObserver = ro.RO; } });
    assert.strictEqual(ro.live().length, 1);
    m.view.innerHTML = `<div class="fy-strip" id="fy-strip"></div><div class="fd-thumbs" id="fd-thumbs"></div>`;
    m.view.querySelector("#fd-thumbs").innerHTML = "SENTINEL";
    ro.all[0].fire();
    assert.strictEqual(m.view.querySelector("#fd-thumbs").innerHTML, "SENTINEL", "another page's row is left alone");
    assert.strictEqual(ro.all[0].disconnected, true, "and the observer disconnects itself");
  });
});

test("PROGRESS.md does not claim the Foray detail iteration 2 run-suites failures were only the Windows CRLF checks", () => {
  /* That entry once said "the only run-suites failures are the 9 Windows native CRLF checks" while test/legal-citations.test.js
     was also red on this branch (the dropped #fy-restart binding left the legal documents counting an event the code no
     longer emits). A progress log that hides a real failure behind a known environmental one is how it stayed red.
     MUTATION: restore the sentence "the only run-suites failures are the 9 Windows native CRLF checks." to that entry (or
     delete its "legal-citations" correction) in docs/redesign-2026/PROGRESS.md -> red. */
  const lines = read("docs/redesign-2026/PROGRESS.md").split("\n");
  const entry = lines.filter((l) => l.includes("Ambient Foray detail iteration 2 on `redesign/ambient-foray-detail`"));
  assert.strictEqual(entry.length, 1, "fixture: exactly one iteration 2 entry");
  assert.doesNotMatch(entry[0], /the only run-suites failures are the 9 Windows native CRLF checks/);
  assert.match(entry[0], /legal-citations/, "the entry names the suite that was also red");
  const round2 = lines.filter((l) => l.includes("Ambient Foray detail review round 2"));
  assert.strictEqual(round2.length, 1, "the round-2 fix is recorded once");
});
