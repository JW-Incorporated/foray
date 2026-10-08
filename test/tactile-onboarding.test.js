/* Onboarding (Redesign 2026, Tactile group F): the first-run screen as the
 * stylesheet, the markup and the app's own engines carry it. Prototype
 * `#/onboarding` and `#/onboarding/return`; docs/redesign-2026/directions/
 * tactile/BUILD-NOTES.md 4.7; screen map `onboarding` and `onboarding-return`.
 *
 * The sheet contract itself (focus moves in, Tab stays, Escape parks, the player
 * stays reachable, once per visit) is test/modal-and-focus.test.js and
 * test/onboarding-sheet-once.test.js, both run unchanged against this screen.
 * The picks write path it no longer calls is test/first-time-onboarding.test.js.
 *
 * WHAT THIS PROVES
 *   1. Over the REAL data files the screen is Today's foray: the card carries
 *      only the 4a brand in its top row, then live artwork, a `detail` band of
 *      the foray's own running order, and the mono counter in the readout row
 *      UNDER the band ("8:52 / 22:10 · 6 shows"), never top-right.
 *   2. The words: the headline, the sub line, "Play today's foray" and "Just show
 *      me", the Play key a full-width persimmon 56px keycap and the text button
 *      after it. No account step.
 *   3. Play starts today's foray (the one the hero shows), writes the
 *      never-again flag and closes; Just show me closes and plays nothing; the
 *      scrim parks without the flag.
 *   4. First mode moves (a needle loop at 8% of the foray per second, 100ms
 *      ticks, stopping when the sheet leaves the document); the returning mode
 *      (`#/onboarding/return`) and reduced motion do not, and the key says
 *      "Play". The draw-in is in the one reduced-motion block.
 *   5. The routes: `#/onboarding` and `#/onboarding/return` render the screen
 *      over Today, are not remembered for relaunch, and leave the address when
 *      the screen closes.
 *   6. The layout is the spec's: card 60dvh / 56dvh / 50dvh, --r-lg, the paper
 *      scrim, keys above safe-b + 16, the text button 11px under the key (8 + the lip).
 *   7. Under the lab flag nothing here signs up or POSTs (the static half is
 *      test/lab-flag.test.js test 6; the running half is here).
 *   8. The harness reaches both modes and the screen map points at them.
 *
 * WHAT IT CANNOT PROVE: how it looks (fidelity.mjs: `sheet` and `primary` within
 * 4px of the prototype), that the headline breaks into two balanced lines at
 * 375/393/412 (the render does), or that the needle really crosses the band in a
 * browser (the loop is driven here against the band's own geometry).
 *
 * HARNESS AUDIT. The DOM is a real tree (ids, classes, attributes, listeners,
 * `_fire`), the data is the committed `data/*.json`, and the Foray bridge is the
 * real foray-resolve and segment-strip modules with ONLY `playForay` replaced by
 * a spy that records the call. The card's inside is markup, and this DOM does not
 * parse markup, so its structure is asserted on the string the screen builds and
 * the loop is driven through the same `querySelector` contract the real card
 * answers; nothing is asserted that the fake answers more kindly than a browser.
 * Every test names its mutation; all were run red.
 */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { readAppSource, runAppSource } = require("./helpers/app-source.js");
const { parseRules } = require("./helpers/dial-css.js");

const ROOT = path.join(__dirname, "..");
const APP_SRC = readAppSource();
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const CSS_TEXT = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
const RULES = parseRules(CSS_TEXT);
const STATES = fs.readFileSync(path.join(ROOT, "tools", "ui-lab", "lib", "states.mjs"), "utf8");
const SCREENS = JSON.parse(fs.readFileSync(path.join(ROOT, "docs", "redesign-2026", "directions", "tactile", "screens.json"), "utf8"));
const DATA = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, "data", name), "utf8"));

process.on("unhandledRejection", () => {});

const DOCS = {
  session: DATA("session.json"),
  validated: DATA("validated-links.json"),
  taxonomy: DATA("taxonomy.json"),
  discover: DATA("discover.json"),
  semantic: DATA("semantic-index.json"),
  itemTags: DATA("item-tags.json"),
  forays: DATA("forays.json"),
  segments: DATA("segments.json"),
  segmentSources: DATA("segment-sources.json"),
  catalog: DATA("catalog-client.json"),
};

/* ---------- a real tree: ids, classes, attributes, listeners ---------- */

const { El: FakeEl } = require("./helpers/fake-dom.js");
let BODY = null;

function walk(node, pred, out) {
  for (const c of node.children || []) {
    if (pred(c)) out.push(c);
    walk(c, pred, out);
  }
  return out;
}
function makeEl(tag) {
  const listeners = new Map();
  const attrs = new Map();
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    id: null, _className: "", textContent: "", value: "", type: "",
    hidden: false, disabled: false, style: { setProperty() {} }, children: [],
    /* Markup is PARSED (test/helpers/fake-dom.js, the repo's one innerHTML
       parser) into a detached box, so `.onb__well .needle` and `[data-onb-clock]`
       resolve against what the screen really built, not against a stand-in. */
    get innerHTML() { return this._html || ""; },
    set innerHTML(v) { this._html = String(v); const box = new FakeEl("div"); box.innerHTML = this._html; this._parsed = box; },
    get isConnected() { for (let n = this; n; n = n._parent) if (n === BODY) return true; return false; },
    get className() { return this._className; },
    set className(v) { this._className = v || ""; },
    classList: {
      add(...c) { const s = new Set(el._className.split(/\s+/).filter(Boolean)); c.forEach((x) => s.add(x)); el._className = [...s].join(" "); },
      remove(...c) { const s = new Set(el._className.split(/\s+/).filter(Boolean)); c.forEach((x) => s.delete(x)); el._className = [...s].join(" "); },
      toggle(c, on) { const has = el.classList.contains(c); const want = on ?? !has; if (want) el.classList.add(c); else el.classList.remove(c); return want; },
      contains: (c) => el._className.split(/\s+/).includes(c),
    },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    removeEventListener() {},
    _fire(type, evt) { for (const fn of listeners.get(type) || []) fn(evt || {}); },
    appendChild(k) { this.children.push(k); k._parent = this; return k; },
    append(...ks) { ks.forEach((k) => this.appendChild(k)); },
    setAttribute(name, val) { attrs.set(name, String(val)); },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
    removeAttribute(name) { attrs.delete(name); },
    hasAttribute(name) { return attrs.has(name); },
    closest() { return null; },
    focus() {}, select() {}, click() { this._fire("click"); },
    remove() { if (this._parent) this._parent.children = this._parent.children.filter((c) => c !== this); this._parent = null; },
    querySelector(sel) { return query(sel, this)[0] || null; },
    querySelectorAll(sel) { return query(sel, this); },
    dataset: {},
  };
  return el;
}
/** #id and .class over the real tree; anything else (a descendant chain, an
    attribute) over the parsed markup of every element on the way. */
function query(sel, root) {
  const s = String(sel).trim();
  const out = [];
  if (/^#[\w-]+$/.test(s)) out.push(...walk(root, (n) => n.id === s.slice(1), []));
  else if (/^\.[\w-]+$/.test(s)) out.push(...walk(root, (n) => n.classList.contains(s.slice(1)), []));
  for (const n of [root, ...walk(root, () => true, [])]) {
    if (n._parsed) out.push(...n._parsed.querySelectorAll(s));
  }
  return out;
}

const PAGE_IDS = [
  "view", "drawer", "drawer-overlay", "drawer-playlists", "family-toggle",
  "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn", "banner-slot",
  "pl-form", "pl-input", "pl-note", "sh-form", "sh-input", "sh-note", "sh-results",
];

/** The bridge app.js reads as `window.ForayPlayer`: the real modules, with the
    one engine call that would make sound replaced by a recorder. */
async function realBridge(plays) {
  const fr = await import(pathToFileURL(path.join(ROOT, "player", "foray-resolve.js")).href);
  const strip = await import(pathToFileURL(path.join(ROOT, "player", "segment-strip.js")).href);
  return {
    listForays: (doc, { unlocked = [] } = {}) => fr.listableForays(doc, { unlocked }),
    resolve: (doc, { id, segmentsDoc, sourcesDoc, unlocked = [] } = {}) => {
      const foray = fr.findForay(doc, id, { unlocked });
      if (!foray) return null;
      return fr.resolveForay(foray, { segments: fr.indexSegments(segmentsDoc), sources: fr.indexSources(sourcesDoc) });
    },
    segmentStripHtml: strip.segmentStripHtml,
    stripModel: strip.stripModel,
    stripTally: strip.stripTally,
    fmtSpan: fr.fmtSpan,
    applyStripGrow() {},
    forayResumeList: () => [],
    forayStatus: () => null,
    playForay: async (r, opts) => { plays.push({ id: r.id, opts }); return { ok: true }; },
  };
}

/** A fresh profile over the real documents, the screen's page (Today) not yet
    drawn. `lab` sets the lab flag; `reduced` answers the reduced-motion query;
    `intervals` records every setInterval so the loop can be driven by hand. */
async function mountReal({ lab = false, reduced = false, hash = "#/" } = {}) {
  const store = new Map();
  const body = makeEl("body");
  BODY = body;
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = makeEl("div");
    el.id = id;
    body.appendChild(el);
    return [id, el];
  }));
  const plays = [];
  const posts = [];
  const intervals = [];
  const replaced = [];
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: (url, init) => {
      if (init && String(init.method).toUpperCase() === "POST") {
        posts.push(String(url));
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ access_token: "at", refresh_token: "rt", user: { id: "u" } }) });
      }
      return new Promise(() => {});   // reads park, as in every harness that boots app.js
    },
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
        if (s.startsWith("#") && byId.has(s.slice(1))) return byId.get(s.slice(1));
        return body.querySelector(sel);
      },
      querySelectorAll: (sel) => body.querySelectorAll(sel),
    },
    navigator: { userAgent: "node" },
    addEventListener() {}, removeEventListener() {},
    location: { hash, search: "", pathname: "/", href: "https://x.test/" },
    history: {
      /* What a browser does: an entry with a fragment moves location.hash, one
         without (the router's own state stamping) leaves it. */
      replaceState: (_s, _t, url) => {
        const at = String(url).indexOf("#");
        if (at < 0) return;
        replaced.push(String(url));
        ctx.location.hash = String(url).slice(at);
      },
      pushState() {},
    },
    matchMedia: (q) => ({ matches: reduced && /reduce/.test(q) }),
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    setInterval: (fn, ms) => { const h = { fn, ms, cleared: false }; intervals.push(h); return h; },
    clearInterval: (h) => { if (h) h.cleared = true; },
    encodeURIComponent, decodeURIComponent,
  };
  if (lab) ctx.__FORAY_LAB__ = true;
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  runAppSource(APP_SRC, ctx);
  const evalIn = (src) => vm.runInContext(src, ctx);
  const state = evalIn("state");
  ctx.ForayPlayer = await realBridge(plays);
  Object.assign(state, DOCS);
  ctx.loadInterests();
  evalIn("state.ready = true");
  return { ctx, evalIn, state, store, body, byId, plays, posts, intervals, replaced };
}

const sheetOf = (m) => m.body.querySelector("#first-time-sheet");
const panelOf = (m) => m.body.querySelector(".onb");
const cardHtml = (m) => m.body.querySelector(".onb__card").innerHTML;
const goBtn = (m) => m.body.querySelector("#first-time-sheet-go");
const skipBtn = (m) => m.body.querySelector("#first-time-sheet-skip");
/** The text of the elements a card string holds, tags dropped. */
const textOf = (html) => html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

/* ==================================================================== */
/* 1. THE CARD                                                           */
/* ==================================================================== */

test("the card is Today's foray: the brand alone in its top row, live artwork, a detail band, the counter UNDER the band", async () => {
  /* MUTATION 1: put the counter in `.onb__wm` (the prototype's r4 mistake: a
     counter top-right reads as a fake status bar) -> the top-row assertion fails.
     MUTATION 2: draw `kind: "mini"` instead of `"detail"` -> the band assertion
     fails. MUTATION 3: drop the artwork row -> no <img> and the artwork
     assertion fails. */
  const m = await mountReal();
  assert.strictEqual(m.ctx.showFirstTimeExplainerOnce(), true);
  const html = cardHtml(m);
  const wm = /<div class="onb__wm">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(wm, "the top row exists");
  assert.strictEqual(textOf(wm[1]), "4a", "the 4a brand and nothing else in the top row");
  assert.match(wm[1], /class="heading onb__brand"/, "in the heading role");
  assert.doesNotMatch(wm[1], /readout|\d:\d\d/, "no counter in the top row");

  assert.match(html, /<svg class="band band--detail"/, "a detail band");
  assert.match(html, /<div class="well onb__well"><svg class="band band--detail"/, "in a well");
  assert.match(html, /class="needle"/, "with its needle");
  assert.match(html, /class="band__progress"/, "and the progress clip the needle drags");
  const bandAt = html.indexOf('class="band band--detail"');
  const metaAt = html.indexOf('class="onb__meta"');
  assert.ok(bandAt > 0 && metaAt > bandAt, "the readout row comes after the band");

  const imgs = [...html.matchAll(/<img src="([^"]*)"/g)].map((x) => x[1]);
  assert.ok(imgs.length >= 1 || /art-frame__initials/.test(html), "artwork cells, live or initials");
  for (const src of imgs) assert.match(src, /^https:\/\//, `artwork goes through safeUrl: ${src}`);
});

test("the counter reads 'm:ss / m:ss · N shows' with the running part in ink, under the band, aria-hidden", async () => {
  /* MUTATION 1: print the total only ('22:10') -> the shape assertion fails.
     MUTATION 2: drop aria-hidden from the readout row -> a ticking counter is
     announced; the last assertion fails. */
  const m = await mountReal();
  m.ctx.showFirstTimeExplainerOnce();
  const html = cardHtml(m);
  const meta = /<div class="onb__meta"([^>]*)>([\s\S]*?)<\/div>\s*<\/div>\s*$/.exec(html) || /<div class="onb__meta"([^>]*)>([\s\S]*?)<\/div>/.exec(html);
  assert.ok(meta, "the readout row exists");
  assert.match(textOf(meta[2]), /^\d+:\d\d \/ \d+:\d\d · \d+ shows?$/);
  assert.match(meta[2], /<span class="onb__now" data-onb-clock>\d+:\d\d<\/span>/, "the running part is its own span");
  assert.match(meta[1], /aria-hidden="true"/, "a ticking counter is not read aloud");
  const section = m.body.querySelector(".onb__card");
  assert.match(section.getAttribute("aria-label"), /^Today's foray, .*\d+ shows?/, "the card says the same thing once, still");
});

test("the demo is the foray Today's hero shows, not another", async () => {
  /* MUTATION: pick `forays.picks[1]` (or the last) instead of todayForayPick ->
     the id differs from the hero's and this fails. */
  const m = await mountReal();
  m.ctx.renderHome();
  const hero = m.evalIn("todayForayPick({ forays: foraysForYouPicks() }, null)");
  assert.ok(hero, "fixture: a foray resolves over the real data");
  const model = m.evalIn("onboardingModel()");
  assert.strictEqual(model.pick.foray.id, hero.foray.id);
  assert.ok(model.total > 60, `a real running time: ${model.total}`);
  assert.ok(model.shows.length >= 1, "from at least one show");
  const n = model.shows.length;
  assert.ok(model.hero.facts.endsWith(`${n} show${n === 1 ? "" : "s"}`), `the count on the card is the hero's: ${model.hero.facts}`);
});

/* ==================================================================== */
/* 2. THE WORDS AND THE KEYS                                             */
/* ==================================================================== */

test("headline, sub line, the Play key and Just show me, in that order, with no account step", async () => {
  /* MUTATION 1: change one word of the headline or the sub -> its assertion
     fails. MUTATION 2: render Just show me before Play -> the order fails.
     MUTATION 3: add a sign-in control -> the account assertion fails. */
  const m = await mountReal();
  m.ctx.showFirstTimeExplainerOnce();
  const panel = panelOf(m);
  const title = m.body.querySelector("#first-time-sheet-title");
  assert.strictEqual(title.textContent, "Podcasts, stitched around you.");
  assert.strictEqual(title.tagName, "H2");
  assert.ok(title.classList.contains("display"), "the display role (2.25rem)");
  assert.strictEqual(panel.getAttribute("aria-labelledby"), "first-time-sheet-title");
  const sub = m.body.querySelector(".onb__sub");
  assert.strictEqual(sub.textContent, "4a picks real shows each day and lines up the best parts into one listen.");
  assert.ok(sub.textContent.split(/\s+/).length <= 18, "inside the 18-word line budget");

  const go = goBtn(m);
  assert.ok(go, "the Play key");
  assert.match(go.innerHTML, /<span class="keycap__label">Play today(?:'|&#39;)s foray<\/span>/);
  assert.match(go.innerHTML, /<use href="#ph-play-fill">/, "a sprite icon, not a glyph");
  for (const c of ["keycap", "keycap--lg", "keycap--persimmon", "keycap--wide"]) assert.ok(go.classList.contains(c), `Play is ${c}`);
  assert.strictEqual(go.getAttribute("aria-label"), "Play today's foray");

  const skip = skipBtn(m);
  assert.strictEqual(skip.textContent, "Just show me");
  assert.ok(skip.classList.contains("textbtn"), "a text button");
  const actions = m.body.querySelector(".onb__actions");
  assert.deepStrictEqual(actions.children.map((c) => c.id), ["first-time-sheet-go", "first-time-sheet-skip"], "Play, then the text button");

  const everything = [title.textContent, sub.textContent, go.innerHTML, skip.textContent, cardHtml(m)].join(" ");
  assert.doesNotMatch(everything, /sign in|sign up|log in|account|email|password|Apple|Google/i, "no account step");
});

test("without a foray the screen still has one honest way on: no band, no Play key, a paper key that says Just show me", async () => {
  /* The catalogue may not have loaded or the device may be offline; a demo of
     nothing is worse than none. MUTATION: build the Play key unconditionally ->
     it would start nothing and this fails. */
  const m = await mountReal();
  m.state.forays = null;
  assert.strictEqual(m.evalIn("onboardingModel()"), null);
  assert.strictEqual(m.ctx.showFirstTimeExplainerOnce(), true);
  assert.strictEqual(goBtn(m), null, "no Play key");
  assert.doesNotMatch(cardHtml(m), /band--detail/, "no band");
  assert.match(cardHtml(m), /class="heading onb__brand"/, "the brand is still there");
  const skip = skipBtn(m);
  assert.ok(skip.classList.contains("keycap") && skip.classList.contains("keycap--wide"), "the one exit is a full-width key");
  skip._fire("click");
  assert.strictEqual(sheetOf(m), null);
});

/* ==================================================================== */
/* 3. WHAT THE KEYS DO                                                   */
/* ==================================================================== */

test("Play today's foray starts that foray from its first clip, writes the never-again flag, and closes the screen", async () => {
  /* MUTATION 1: drop `playHomeTarget(...)` from the Play handler -> no play is
     recorded. MUTATION 2: drop `dismiss()` -> the screen stays and the flag is
     unset. MUTATION 3: start `foray.id` of another foray -> the id differs from
     the hero's. */
  const m = await mountReal();
  m.ctx.renderHome();
  m.ctx.showFirstTimeExplainerOnce();
  const hero = m.evalIn("todayForayPick({ forays: foraysForYouPicks() }, null)");
  goBtn(m)._fire("click");
  assert.strictEqual(sheetOf(m), null, "the screen is gone");
  assert.strictEqual(m.store.get("cp_intro_dismissed"), "true", "and does not come back");
  assert.strictEqual(m.plays.length, 1, "one foray started");
  assert.strictEqual(m.plays[0].id, hero.foray.id, "Today's foray, the one the hero shows");
  assert.deepStrictEqual(m.plays[0].opts.startIndex, 0, "from the first clip");
});

test("Just show me closes the screen, writes the flag and plays nothing", async () => {
  /* MUTATION: have the skip handler call the Play path too -> a play is recorded. */
  const m = await mountReal();
  m.ctx.showFirstTimeExplainerOnce();
  skipBtn(m)._fire("click");
  assert.strictEqual(sheetOf(m), null);
  assert.strictEqual(m.store.get("cp_intro_dismissed"), "true");
  assert.deepStrictEqual(m.plays, []);
});

test("the scrim PARKS the screen: closed for the visit, no flag, nothing played, and it does not re-mount", async () => {
  /* MUTATION: bind the scrim to dismiss -> the flag is written and this fails. */
  const m = await mountReal();
  m.ctx.showFirstTimeExplainerOnce();
  m.body.querySelector(".fy-scrim")._fire("click");
  assert.strictEqual(sheetOf(m), null);
  assert.strictEqual(m.store.get("cp_intro_dismissed"), undefined);
  assert.strictEqual(m.ctx.showFirstTimeExplainerOnce(), true, "parked answers 'owned by the explainer'");
  assert.strictEqual(sheetOf(m), null, "and mounts nothing");
  assert.deepStrictEqual(m.plays, []);
});

/* ==================================================================== */
/* 4. MOTION: FIRST MODE MOVES, RETURNING AND REDUCED DO NOT             */
/* ==================================================================== */

/** The three elements the loop moves, from the card the screen really built. */
function liveCard(m) {
  const needle = m.body.querySelector(".onb__well .needle");
  const clip = m.body.querySelector(".onb__well .band__progress");
  const clock = m.body.querySelector("[data-onb-clock]");
  assert.ok(needle && clip && clock, "the card holds a needle, a progress clip and a counter");
  return { needle, clip, clock };
}
const needleX = (card) => Number(/translate\(([\d.]+) 0\)/.exec(card.needle.getAttribute("transform"))[1]);
const secsOf = (t) => t.split(":").reduce((a, p) => a * 60 + Number(p), 0);

test("first mode runs one 100ms loop that moves the needle, the progress clip and the counter at 8% of the foray per second", async () => {
  /* MUTATION 1: ONB_RATE 0.08 -> 0.8 -> the 39% assertion fails.
     MUTATION 2: skip the clip write -> the played part stops following the
     needle and the clip assertion fails. MUTATION 3: never start the interval ->
     none is recorded. */
  const m = await mountReal();
  m.ctx.showFirstTimeExplainerOnce();
  assert.strictEqual(m.intervals.length, 1, "one loop");
  assert.strictEqual(m.intervals[0].ms, 100, "ticking every 100ms");
  const model = m.evalIn("onboardingModel()");
  const card = liveCard(m);
  const x0 = needleX(card);
  assert.ok(x0 > 0, "it starts part-way along (31% of the foray)");
  for (let i = 0; i < 10; i += 1) m.intervals[0].fn();         // one second
  const x1 = needleX(card);
  assert.ok(x1 > x0, "forward");
  assert.strictEqual(Number(card.clip.getAttribute("width")), x1, "the played part ends at the needle");
  const now = secsOf(card.clock.textContent);
  assert.ok(Math.abs(now - Math.floor(model.total * 0.39)) <= 2, `after one second the counter is at 39%: ${now}s of ${model.total}s`);
});

test("the loop wraps at the end, and stops itself the tick after the screen leaves the document", async () => {
  /* MUTATION 1: drop the `at >= 1` wrap -> the counter runs past the total.
     MUTATION 2: drop the isConnected check -> the interval is never cleared and
     keeps writing to a detached card. */
  const m = await mountReal();
  m.ctx.showFirstTimeExplainerOnce();
  const model = m.evalIn("onboardingModel()");
  const card = liveCard(m);
  const h = m.intervals[0];
  for (let i = 0; i < 100; i += 1) h.fn();                     // ten seconds, past the end at 8%/s
  assert.ok(secsOf(card.clock.textContent) <= model.total, "never past the total");
  assert.strictEqual(h.cleared, false, "still running while the screen is up");
  skipBtn(m)._fire("click");
  h.fn();
  assert.strictEqual(h.cleared, true, "stopped once the screen left the document");
});

test("reduced motion starts no loop at all, and neither does the returning mode", async () => {
  /* MUTATION 1: remove `reducedMotion()` from startOnboardingLoop's guard ->
     the reduced run records an interval. MUTATION 2: start the loop for `still`
     too -> the returning run does. The twin proves the fixture CAN start one. */
  const live = await mountReal();
  live.ctx.showFirstTimeExplainerOnce();
  assert.strictEqual(live.intervals.length, 1, "otherwise 'no loop' below proves nothing");

  const reduced = await mountReal({ reduced: true });
  reduced.ctx.showFirstTimeExplainerOnce();
  assert.ok(sheetOf(reduced), "the screen is up");
  assert.strictEqual(reduced.intervals.length, 0);

  const returning = await mountReal();
  returning.evalIn("showFirstTimeExplainerOnce({ returning: true, forced: true })");
  assert.ok(sheetOf(returning), "the screen is up");
  assert.strictEqual(returning.intervals.length, 0);
});

test("returning mode: the key says Play, the panel is still, the band starts at 0:00", async () => {
  /* MUTATION 1: label the key from `still` backwards -> the label assertion
     fails. MUTATION 2: drop the `onb--still` class -> the draw-in would run. */
  const m = await mountReal();
  m.evalIn("showFirstTimeExplainerOnce({ returning: true, forced: true })");
  assert.ok(panelOf(m).classList.contains("onb--still"));
  assert.match(goBtn(m).innerHTML, /<span class="keycap__label">Play<\/span>/);
  assert.strictEqual(goBtn(m).getAttribute("aria-label"), "Play");
  assert.match(cardHtml(m), /<span class="onb__now" data-onb-clock>0:00<\/span>/);
  const first = await mountReal();
  first.ctx.showFirstTimeExplainerOnce();
  assert.ok(!panelOf(first).classList.contains("onb--still"));
  assert.doesNotMatch(cardHtml(first), /data-onb-clock>0:00</, "the first mode starts mid-foray");
});

/* ==================================================================== */
/* 5. THE ROUTES                                                         */
/* ==================================================================== */

test("#/onboarding and #/onboarding/return render the screen over Today; the first is animated, the second still", async () => {
  /* MUTATION 1: drop the router branch -> Today renders alone and no sheet
     mounts. MUTATION 2: pass `Boolean(m[1])` the wrong way round -> the modes
     swap and the second assertion fails. */
  const first = await mountReal({ hash: "#/onboarding" });
  first.ctx.renderCurrentPage();
  assert.ok(sheetOf(first), "the screen is up");
  assert.ok(!panelOf(first).classList.contains("onb--still"));
  assert.match(goBtn(first).innerHTML, /Play today(?:'|&#39;)s foray/);

  const again = await mountReal({ hash: "#/onboarding/return" });
  again.ctx.renderCurrentPage();
  assert.ok(sheetOf(again));
  assert.ok(panelOf(again).classList.contains("onb--still"));
  assert.match(goBtn(again).innerHTML, /<span class="keycap__label">Play<\/span>/);
  assert.match(again.byId.get("view").innerHTML, /today-hero/, "Today is underneath");
});

test("the route works for a listener who is not new: the address asked, so the screen shows", async () => {
  /* MUTATION: drop `forced` -> the isGenuineFirstTimeUser gate answers false and
     no sheet mounts. */
  const m = await mountReal({ hash: "#/onboarding/return" });
  m.ctx.lsSet("cp_history", ["ep-1"]);
  m.ctx.lsSet("cp_intro_dismissed", true);
  m.ctx.renderCurrentPage();
  assert.ok(sheetOf(m));
});

test("closing the screen on its address leaves the address: Play and Just show me land on #/", async () => {
  /* MUTATION: drop `leave()` from dismiss -> the hash stays #/onboarding/return
     and Back would reopen it. */
  for (const key of [goBtn, skipBtn]) {
    const m = await mountReal({ hash: "#/onboarding/return" });
    m.ctx.renderCurrentPage();
    key(m)._fire("click");
    assert.strictEqual(m.ctx.location.hash, "#/");
    assert.deepStrictEqual(m.replaced, ["/#/"], "replaced, not pushed");
  }
  const home = await mountReal();
  home.ctx.showFirstTimeExplainerOnce();
  skipBtn(home)._fire("click");
  assert.deepStrictEqual(home.replaced, [], "on '#/' there is no address to leave");
});

test("navigating from Today to #/onboarding/return opens the returning screen and keeps the address", async () => {
  /* The harness walks "#/" -> "#/onboarding/return", and a listener can follow a
     link the same way. The first screen is closed by the NAVIGATION, through the
     same `park` Escape uses, after the hash has already changed; if `park` then
     rewrote the address to "#/" it would undo the navigation (this is the defect
     the first fidelity run found: the second step shot Today).
     MUTATION: `leave` tests `currentHash()` alone instead of the address the screen
     was opened on -> the hash is rewritten to "#/" and the returning screen never
     opens; both assertions fail. */
  const m = await mountReal();
  m.ctx.renderCurrentPage();
  m.ctx.showFirstTimeExplainerOnce();
  assert.ok(sheetOf(m) && !panelOf(m).classList.contains("onb--still"), "fixture: the first mode is up on Today");
  m.ctx.location.hash = "#/onboarding/return";
  m.ctx.route();
  assert.strictEqual(m.ctx.location.hash, "#/onboarding/return", "the address was not rewritten");
  assert.ok(sheetOf(m), "a screen is up");
  assert.ok(panelOf(m).classList.contains("onb--still"), "and it is the returning mode");
  assert.strictEqual(m.body.querySelectorAll("#first-time-sheet").length, 1, "only one");
});

test("the onboarding address is not remembered for the next launch", async () => {
  /* MUTATION: drop the ONB_ROUTE guard in rememberRouteForRelaunch -> the key is written. */
  const m = await mountReal();
  m.ctx.Capacitor = { isNativePlatform: () => true };   // the shell, as the app detects it
  m.ctx.rememberRouteForRelaunch("#/onboarding/return");
  m.ctx.rememberRouteForRelaunch("#/onboarding");
  assert.strictEqual(m.ctx.lsGet("cp_last_route", null), null);
  m.ctx.rememberRouteForRelaunch("#/library");
  assert.strictEqual(m.ctx.lsGet("cp_last_route", null), "#/library", "the twin: any other route is");
});

/* ==================================================================== */
/* 6. THE LAYOUT                                                         */
/* ==================================================================== */

const decl = (rule, prop) => (rule.decls.find((d) => d.prop === prop) || {}).value;
const rulesFor = (sel, pred = () => true) => RULES.filter((r) => r.selectors.includes(sel) && pred(r));
const base = (sel) => rulesFor(sel, (r) => r.atRules.length === 0);
const atRule = (sel, needle) => rulesFor(sel, (r) => r.atRules.some((a) => a.includes(needle)));

test("the card is 56dvh, 60dvh on a tall phone and 50dvh on a short one, at --r-lg on the card fill", () => {
  /* MUTATION 1: swap 60dvh for 56dvh in the min-height query -> the tall
     assertion fails. MUTATION 2: `border-radius: var(--r-md)` -> the radius
     assertion fails. MUTATION 3: drop `flex: 0 1 auto` (the card stops giving up
     height) -> the shrink assertion fails. */
  const card = base(".onb__card");
  assert.strictEqual(card.length, 1);
  assert.strictEqual(decl(card[0], "height"), "56dvh");
  assert.strictEqual(decl(card[0], "border-radius"), "var(--r-lg)");
  assert.strictEqual(decl(card[0], "background"), "var(--card)");
  assert.strictEqual(decl(card[0], "box-shadow"), "var(--shadow-card)");
  assert.strictEqual(decl(card[0], "flex"), "0 1 auto", "it shrinks before the keys leave the screen");
  assert.strictEqual(decl(atRule(".onb__card", "min-height: 800px")[0], "height"), "60dvh");
  assert.strictEqual(decl(atRule(".onb__card", "max-height: 700px")[0], "height"), "50dvh");
});

test("full screen on paper: the sheet's scrim IS the paper, the panel fills the screen and clears the safe areas by 16px", () => {
  /* MUTATION 1: scrim back to rgba(8,5,12,.62) -> Today shows through dimmed; the
     paper assertion fails. MUTATION 2: lose `top: 0` -> the panel stays a
     bottom sheet. MUTATION 3: padding-bottom without var(--safe-b) -> the keys
     sit under the home indicator. */
  assert.strictEqual(decl(base(".onb-sheet > .fy-scrim")[0], "background"), "var(--paper)");
  const panel = base(".fy-sheet .fy-panel.onb");
  assert.strictEqual(panel.length, 1);
  assert.strictEqual(decl(panel[0], "top"), "0");
  assert.strictEqual(decl(panel[0], "padding"), "calc(var(--safe-t) + var(--s-4)) var(--gutter) calc(var(--safe-b) + var(--s-4))");
  assert.strictEqual(decl(panel[0], "border-radius"), "0");
  assert.strictEqual(decl(panel[0], "animation"), "none", "a page does not slide in");
  assert.ok(!/\btransition\b/.test(panel[0].decls.map((d) => d.prop).join(" ")), "and does not restate the sheet's transition");
});

test("the keys: Play is a 56px full-width keycap, the text button sits 11px under the key (8 + the 3px lip), both inside the safe-area padding", () => {
  /* MUTATION 1: `.onb__actions { gap: var(--s-3) }` (the stated 12 on top of the lip) -> the gap assertion fails, and fidelity reads Play 8px high.
     MUTATION 2: drop `margin-top: auto` -> the keys float up under the copy on a
     tall phone. MUTATION 3: `.keycap--lg` -> `--key` (48) -> the 56 assertion fails. */
  const actions = base(".onb__actions")[0];
  assert.strictEqual(decl(actions, "gap"), "var(--s-2)");   // 8 + the 3px lip: 11 under the key, the nearest to 12 that keeps Play within 4px of the prototype
  assert.strictEqual(decl(actions, "margin-top"), "auto");
  assert.strictEqual(decl(base(".onb__actions .keycap")[0], "margin-bottom"), "var(--lip)");
  assert.strictEqual(decl(base(".keycap--lg")[0], "height"), "var(--key-lg)");
  assert.strictEqual(decl(base(".keycap--wide")[0], "width"), "100%");
  assert.match(CSS_TEXT, /--key-lg:\s*56px/);
  assert.strictEqual(decl(base(".textbtn").find((r) => decl(r, "min-height")), "min-height"), "var(--tap)", "44px");
});

test("the headline balances its lines and the copy is body-lg under it", () => {
  /* MUTATION: drop `text-wrap: balance` -> 'you.' can stand alone on a line at
     393 (r4 measured exactly that); this fails. The two-line, no-widow result at
     375/393/412 is read from the render (build-loop step 4). */
  assert.strictEqual(decl(base(".onb__copy .display")[0], "text-wrap"), "balance");
  assert.match(decl(base(".onb__sub")[0], "font"), /var\(--t-body-lg\)\/var\(--lh-body-lg\)/);
  assert.match(CSS_TEXT, /--t-display:\s*2\.25rem/, "the display role the headline wears is 2.25rem");
});

test("the draw-in is the one reduced-motion block's, the returning mode cuts it, and nothing here animates on its own", () => {
  /* MUTATION 1: remove `.band__draw` from the reduced-motion block -> the first
     assertion fails (it is also what test/ui-tokens.test.js pins for every
     animation). MUTATION 2: remove `.onb--still .band__draw { animation: none }`
     -> the returning mode would draw in. MUTATION 3: add a `@keyframes onb-*` or
     a `transition` on an `.onb*` rule -> the last assertion fails: the only
     motion is the band's draw (a token) and the JS needle loop. */
  const reduced = RULES.filter((r) => r.atRules.some((a) => a.includes("prefers-reduced-motion")));
  assert.ok(reduced.some((r) => r.selectors.includes(".band__draw") && decl(r, "animation") === "none"), "the draw-in is stilled by the one block");
  assert.strictEqual(decl(base(".onb--still .band__draw")[0], "animation"), "none");
  const own = RULES.filter((r) => r.selectors.some((s) => /(^|\s)\.onb(__|-|\b)/.test(s)));
  for (const r of own) {
    for (const d of r.decls) {
      if (d.prop === "animation" && d.value !== "none") assert.fail(`${r.selectors}: animation ${d.value}`);
      if (d.prop === "transition" && d.value !== "none") assert.fail(`${r.selectors}: transition ${d.value}`);
    }
  }
  assert.ok(!/@keyframes\s+onb/.test(CSS_TEXT), "no onboarding keyframes");
  assert.strictEqual(decl(base(".onb .needle")[0], "transition"), "none", "the loop moves the needle every 100ms; a spring on each step would lag it");
});

/* ==================================================================== */
/* 7. THE LAB FLAG                                                       */
/* ==================================================================== */

test("in a lab build Play and Just show me POST nothing: no sign-up, no token refresh, no event row", async () => {
  /* The static half (the screen's source calls no network API) is
     test/lab-flag.test.js test 6. This runs it: both exits, lab flag on, over the
     real engines. The twin proves the spy would have seen a POST. MUTATION: call
     `sbAuth("/auth/v1/signup", {})` from the Play handler -> the lab run records
     a POST and fails (and so does the static test). */
  for (const key of [goBtn, skipBtn]) {
    const lab = await mountReal({ lab: true });
    lab.ctx.showFirstTimeExplainerOnce();
    key(lab)._fire("click");
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(lab.posts, [], "a lab build wrote to production");
  }
  const real = await mountReal();
  await real.evalIn('sbAuth("/auth/v1/signup", {})');
  assert.ok(real.posts.some((u) => /\/auth\/v1\/signup$/.test(u)), "the twin: the real build's sign-up POST is visible to this spy");
});

/* ==================================================================== */
/* 8. THE HARNESS REACHES BOTH MODES                                     */
/* ==================================================================== */

test("the first-run state has an intro-sheet step and an onboarding-return step, and the screen map points at each", () => {
  /* MUTATION 1: drop the second step from states.mjs -> fidelity.mjs refuses the
     map (exit 2) and this fails. MUTATION 2: point `onboarding-return` at the
     first step -> the step assertion fails. */
  const block = /id: "first-run",[\s\S]*?steps: \[([\s\S]*?)\],\s*\},/.exec(STATES);
  assert.ok(block, "the first-run state exists");
  assert.match(block[1], /label: "intro-sheet", route: "#\/", ready: "#first-time-sheet"/);
  assert.match(block[1], /label: "onboarding-return", route: "#\/onboarding\/return", ready: "#first-time-sheet"/);
  assert.deepStrictEqual(SCREENS.screens.onboarding.app, { state: "first-run", step: "intro-sheet" });
  assert.deepStrictEqual(SCREENS.screens["onboarding-return"].app, { state: "first-run", step: "onboarding-return" });
  assert.strictEqual(SCREENS.screens["onboarding-return"].prototype.route, "#/onboarding/return");
  for (const id of ["onboarding", "onboarding-return"]) {
    const regions = SCREENS.screens[id].regions;
    assert.deepStrictEqual(Object.keys(regions).sort(), ["primary", "sheet", "skip", "title"]);
    assert.strictEqual(regions.sheet.app, "#first-time-sheet .onb__card");
    assert.strictEqual(regions.primary.app, "#first-time-sheet-go");
  }
});
