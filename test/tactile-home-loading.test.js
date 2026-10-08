/* Redesign 2026, Tactile Phase 4 group B `home-loading`: Today before its
 * documents land (BUILD-PLAN 2.8). The boot paint is a skeleton at the loaded
 * page's own sizes inside ONE busy region.
 *
 * WHAT THIS SUITE CAN AND CANNOT SEE. There is no browser here: it evaluates the
 * committed stylesheet's box arithmetic (tokens, calc(), margins, heights) and
 * reads the markup the real functions return. The three LOADED_* numbers below
 * are MEASURED constants, not computed ones, from the harness at 393x852 in
 * Cream (`fidelity.mjs --direction tactile --screens home,home-loading`, run
 * home-loading-i3): the seeded `returning` Today's hero is 380px, its Also
 * today row 131 and its Stretch bridge 266. The skeleton lands at 382 / 130 /
 * 265 in the browser, and the arithmetic below reproduces those exact sums, so
 * a changed margin or height moves a number here before it moves the page.
 *
 * Every test names its one-line mutation, and each was run red before push.
 */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { ROOT, CSS, CSS_RULES, load, rule } = require("./helpers/tactile-primitives.js");

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");
const APP = read("app.js");
const HOME = read("ui/home.js");
const STATES = read("tools/ui-lab/lib/states.mjs");
const WALK = read("tools/ui-lab/lib/walk.mjs");

const LOADED_HERO = 380;
const LOADED_ROW = 131;
const LOADED_BRIDGE = 266;
const TOLERANCE = 4;

/* ---- lifting the real functions, never re-typing them ---- */
function lift(src, name) {
  const m = new RegExp("^function " + name + "\\((?:[^()]|\\([^)]*\\))*\\) \\{[\\s\\S]*?\\n\\}", "m").exec(src);
  if (!m) throw new Error(`${name}() is no longer a top-level function`);
  return m[0];
}
function liftConst(src, name) {
  const m = new RegExp("^const " + name + " = [^\\n]*;$", "m").exec(src);
  if (!m) throw new Error(`${name} is no longer a one-line top-level const`);
  return m[0];
}

function liftLet(src, name) {
  const m = new RegExp("^let " + name + " = [^\\n]*;$", "m").exec(src);
  if (!m) throw new Error(`${name} is no longer a one-line top-level let`);
  return m[0];
}

/* The boot paint's collaborators, as a small honest page: a body with a class list, and a tab
   bar that exists once renderTabBar() has run and can be removed. */
const env = { hash: "#/", native: false, relaunch: "#/", bodyClass: null, tabBars: 0, classes: new Set(["ui-v2"]), bar: null };
const bodyClasses = () => [...env.classes].join(" ");
function world({ withToday = true } = {}) {
  const ctx = load({
    currentHash: () => env.hash,
    isNativeShell: () => env.native,
    relaunchRoute: () => env.relaunch,
    setBodyClass: (c) => { env.bodyClass = c; env.classes = new Set([c, "ui-v2"]); },
    renderTabBar: () => { env.tabBars += 1; if (!env.bar) env.bar = { remove: () => { env.bar = null; } }; },
    document: { body: { classList: { remove: (c) => { env.classes.delete(c); } } } },
    $: (sel) => (sel === "#tab-bar" ? env.bar : null),
    Date,
  });
  if (withToday) {
    vm.runInContext([
      liftConst(HOME, "TODAY_DAYS"), liftConst(HOME, "TODAY_MONTHS"),
      lift(HOME, "todayDateLine"), lift(HOME, "todayHeaderHtml"), lift(HOME, "todayLoadingHtml"),
    ].join("\n"), ctx, { filename: "ui/home.js (loading)" });
  }
  vm.runInContext([
    liftConst(APP, "BOOT_LOADING_HTML"), lift(APP, "bootLoadingHtml"), liftLet(APP, "bootChromeUndo"),
    liftLet(APP, "bootKnobPressed"), lift(APP, "settleBootKnob"),
    lift(APP, "paintBootLoading"), lift(APP, "endBootLoadingChrome"),
  ].join("\n"), ctx, { filename: "app.js (boot paint)" });
  return ctx;
}
/* A `const` in a vm context is lexical, not a property of the context object. */
const plainLine = (ctx) => vm.runInContext("BOOT_LOADING_HTML", ctx);
function reset(patch = {}) { Object.assign(env, { hash: "#/", native: false, relaunch: "#/", bodyClass: null, tabBars: 0, classes: new Set(["ui-v2"]), bar: null }, patch); }

/* ---- the stylesheet's own arithmetic ---- */
function token(name) {
  const m = new RegExp("(?:^|[\\s;{])" + name.replace(/[-]/g, "\\-") + ":\\s*([^;]+);").exec(CSS_RULES);
  if (!m) throw new Error(`no token ${name}`);
  return m[1].trim();
}
function px(value) {
  let s = String(value).trim();
  for (let i = 0; i < 8 && /var\(/.test(s); i += 1) s = s.replace(/var\((--[\w-]+)\)/g, (_, n) => "(" + token(n) + ")");
  s = s.replace(/calc/g, "").replace(/px/g, "");
  if (!/^[\d\s+\-*/().]+$/.test(s)) throw new Error(`cannot evaluate ${value}`);
  return Function("return (" + s + ")")();
}
function decl(selector, prop, { first = false } = {}) {
  const body = rule(selector);
  if (!body) throw new Error(`no rule for ${selector}`);
  const all = [...body.matchAll(new RegExp("(?:^|[;\\s])" + prop + ":\\s*([^;]+);?", "g"))];
  if (!all.length) throw new Error(`${selector} has no ${prop}`);
  return (first ? all[0] : all[all.length - 1])[1].trim();
}
const h = (selector, prop = "height") => px(decl(selector, prop));

test("the skeleton is one busy region: aria-busy on the root, every block aria-hidden, the knob the one live control", () => {
  // MUTATION: drop `decorative: true` from the `sk` helper in todayLoadingHtml -> every block says aria-busy/aria-label "Loading" instead of aria-hidden and this fails; put `disabled: true` back on the knob in todayHeaderHtml (the iteration-1 flat tile) -> the not-disabled assertion fails.
  reset();
  const html = world().todayLoadingHtml();
  assert.match(html, /^<div class="today today--loading" data-boot-loading role="region" aria-label="Today" aria-busy="true">/);
  const skels = [...html.matchAll(/<div class="skel skel--[a-z]+"([^>]*)>/g)];
  assert.strictEqual(skels.length, 1 + 4 + 2, "hero, row/bridge/row/row, two playlist cards");
  for (const [, attrs] of skels) {
    assert.strictEqual(attrs.trim(), 'aria-hidden="true"', "a block is hidden from assistive tech, not announced");
  }
  assert.strictEqual((html.match(/aria-busy="true"/g) || []).length, 1, "exactly one busy region");
  assert.doesNotMatch(html, /aria-label="Loading"/);
  /* Nothing in the skeleton is a link. The only control is the knob, and it is a
     real paper keycap, not a disabled tile (the disabled keycap recolours its fill
     and ink to the skeleton's own tones, which read as a placeholder): a press
     before the drawer is bound is remembered, see the next test. */
  assert.doesNotMatch(html, /<a[\s>]/);
  const buttons = html.match(/<button\b[^>]*>/g) || [];
  assert.strictEqual(buttons.length, 1);
  assert.match(buttons[0], /id="today-knob"/);
  assert.match(buttons[0], /keycap--paper/);
  assert.doesNotMatch(buttons[0], /\bdisabled\b|aria-disabled/);
  assert.doesNotMatch(html, /\sstyle=|<script|javascript:/i, "strict CSP: no inline style or script");
});

test("the hero skeleton draws the specified shapes and the Also today slot keeps the loaded order", () => {
  // MUTATION: drop the sk("bridge") from todayLoadingHtml (the Stretch slot) -> the order assertion fails; delete one `skel__shape` title span from tactileSkeleton("hero") -> the three-title-lines assertion fails.
  reset();
  const html = world().todayLoadingHtml();
  const hero = /<div class="skel skel--hero"[^>]*>([\s\S]*?)<\/div><\/div>(?=\s*<div class="today-sect")/.exec(html);
  assert.ok(hero, "hero skeleton is in the page");
  const title = /<div class="skel__title">([\s\S]*?)<\/div>/.exec(hero[1])[1];
  const discs = /<span class="skel__discs">([\s\S]*?)<\/span><span class="skel__shape skel__readout">/.exec(hero[1])[1];
  const why = /<div class="skel__why">([\s\S]*?)<\/div>/.exec(hero[1])[1];
  assert.strictEqual((title.match(/skel__shape/g) || []).length, 3, "three title lines");
  assert.strictEqual((discs.match(/skel__shape/g) || []).length, 3, "three discs");
  assert.strictEqual((why.match(/skel__shape/g) || []).length, 2, "two why-lines");
  for (const part of ["skel__eyebrow", "skel__band", "skel__readout", "skel__primary", "skel__secondary"]) assert.match(hero[1], new RegExp(part));
  /* Raw order of the Also today blocks: row, Stretch bridge, row, row (todayAlsoHtml). */
  const also = /Also today<\/h2>([\s\S]*?)<h2 class="heading">Playlists/.exec(html)[1];
  const kinds = [...also.matchAll(/class="skel skel--([a-z]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(kinds, ["row", "bridge", "row", "row"]);
  assert.strictEqual((also.match(/skel__row-why/g) || []).length, 3, "each row carries its two why-line bars");
  const cards = /Playlists for you<\/h2>([\s\S]*)$/.exec(html)[1];
  assert.strictEqual((cards.match(/class="skel skel--card"/g) || []).length, 2);
});

test("the hero skeleton's box sums to the loaded hero within 4px, so nothing jumps", () => {
  // MUTATION: change `.today--loading .skel--hero > .skel__why { margin-top: var(--s-3) }` to `var(--s-8)` -> the sum is 402 and this fails; delete `min-height: 0` from the hero override -> the primitive's 404px floor returns and the min-height assertion fails.
  const root = ".today--loading .skel--hero";
  assert.strictEqual(px(decl(root, "min-height")), 0, "no min-height floor: the height IS the shapes");
  assert.strictEqual(px(decl(root, "gap")), 0);
  const padding = h(root, "padding");
  assert.strictEqual(padding, 20, "the hero card's own padding (--s-5)");
  const titleBlock = 3 * h(".skel__title > span") + 2 * px(decl(".skel__title", "gap"));
  const whyBlock = 2 * h(".skel__why > span") + px(decl(".skel__why", "gap"));
  const pieces = [
    padding,
    h(".skel__eyebrow"),
    h(root + " > .skel__title", "margin-top"), titleBlock,
    h(root + " > .skel__band", "margin-top"), h(".skel__band"),
    h(root + " > .skel__meta", "margin-top"), h(".skel__meta", "min-height"),
    h(root + " > .skel__why", "margin-top"), whyBlock,
    h(root + " > .skel__actions", "margin-top"), h(".skel__primary"),
    padding,
  ];
  const total = pieces.reduce((a, b) => a + b, 0);
  assert.strictEqual(h(".skel__eyebrow"), 24, "eyebrow pill 24 tall");
  assert.strictEqual(h(".skel__title > span"), 28, "title lines 28");
  assert.strictEqual(h(".skel__band"), 8, "band well 8");
  assert.strictEqual(h(".skel__why > span"), 17, "why-lines 17");
  assert.strictEqual(h(".skel__primary"), 80, "play circle 80");
  assert.ok(Math.abs(total - LOADED_HERO) <= TOLERANCE, `hero skeleton ${total}px vs loaded ${LOADED_HERO}px`);
});

test("the row and bridge skeletons sum to the loaded Also today row and Stretch bridge within 4px", () => {
  // MUTATION: change `.today--loading .skel--row { padding: var(--s-3) }` to `var(--s-8)` -> the row is 154 and this fails; raise `.skel__bridge-sentence`'s min-height to var(--key-glance) -> the bridge is 313 and this fails.
  const row = ".today--loading .skel--row";
  const rowPad = px(decl(row, "padding"));
  const rowTotal = 2 * rowPad + h(".skel__row-art") + px(decl(row, "row-gap")) + (2 * h(".skel__why > span") + px(decl(".skel__why", "gap")));
  assert.ok(Math.abs(rowTotal - LOADED_ROW) <= TOLERANCE, `row skeleton ${rowTotal}px vs loaded ${LOADED_ROW}px`);
  assert.strictEqual(h(".skel__row-art"), 56, "row art 56");
  assert.strictEqual(h(".skel__row-control"), 44, "trailing square 44");
  assert.strictEqual(h(".skel__row-lines > .skel__row-meta"), 13, "meta bar 13");

  const bridge = ".today--loading .skel--bridge";
  const gap = px(decl(bridge, "gap"));
  const pick = h(".today--loading .skel__bridge-lines > .skel__bridge-tag") + px(decl(".today--loading .skel__bridge-lines > .skel__bridge-tag", "margin-bottom"))
    + 2 * h(".today--loading .skel__bridge-lines > span") + px(decl(".today--loading .skel__bridge-lines", "gap")) * 3
    + h(".today--loading .skel__bridge-lines > .skel__row-meta") + px(decl(".today--loading .skel__bridge-lines > .skel__row-meta", "margin-top"));
  const bridgeTotal = 2 * px(decl(bridge, "padding")) + h(".today--loading .skel__bridge-sentence", "min-height") + gap
    + h(".today--loading .skel__bridge-arc", "min-height") + gap + pick;
  assert.ok(Math.abs(bridgeTotal - LOADED_BRIDGE) <= TOLERANCE, `bridge skeleton ${bridgeTotal}px vs loaded ${LOADED_BRIDGE}px`);
});

test("the shimmer is opacity only at 1.2s, and the one reduced-motion block stills it", () => {
  // MUTATION: add `transform: scale(1.02)` to @keyframes tactile-shimmer's `to` -> the opacity-only assertion fails; delete `.skel` from the reduced-motion block's `animation: none` list -> the stilled assertion fails.
  const frames = /@keyframes tactile-shimmer\s*\{([\s\S]*?\})\s*\}/.exec(CSS_RULES);
  assert.ok(frames, "tactile-shimmer exists");
  const props = new Set([...frames[1].matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]));
  assert.deepStrictEqual([...props], ["opacity"], "the shimmer changes nothing but opacity");
  assert.match(decl(".skel", "animation", { first: true }), /tactile-shimmer\s+var\(--d-skeleton\)/);
  assert.strictEqual(token("--d-skeleton"), "1200ms");
  /* One block names it: the selector list that ends in `animation: none`. */
  const blocks = CSS.match(/@media \(prefers-reduced-motion: reduce\)/g) || [];
  assert.strictEqual(blocks.length, 1, "exactly one reduced-motion block");
  const block = CSS.slice(CSS.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(block, /\.skel \{ animation: none; \}/);
  /* Today's overrides add no motion of their own. */
  for (const m of CSS_RULES.matchAll(/([^{}]*\.today--loading[^{}]*)\{([^{}]*)\}/g)) {
    assert.doesNotMatch(m[2], /animation|transition/, `${m[1].trim()} adds no motion`);
  }
});

test("the boot paint is Today's skeleton only on Today's address, and plain everywhere else", () => {
  // MUTATION: delete `currentHash() === "#/" &&` from bootLoadingHtml -> an episode address paints Today's skeleton and this fails; make the native-shell clause `||` true -> the relaunch-to-Yours case fails.
  const w = world();
  const plain = plainLine(w);
  assert.match(plain, /^<div class="page" data-boot-loading><p class="note">Loading 4a…<\/p><\/div>$/);

  reset();
  assert.match(w.bootLoadingHtml(), /today--loading/);
  for (const hash of ["#/show/abc", "#/library", "#/episode/x?t=4", "#/shows"]) {
    reset({ hash });
    assert.strictEqual(w.bootLoadingHtml(), plain, `${hash} keeps the plain line`);
  }
  /* The native shell reopens the last page on a bare arrival: Yours does not get a Today skeleton. */
  reset({ native: true, relaunch: "#/library" });
  assert.strictEqual(w.bootLoadingHtml(), plain);
  reset({ native: true, relaunch: "#/" });
  assert.match(w.bootLoadingHtml(), /today--loading/);
  /* An environment without the Today module (or the primitives) is still painted. */
  reset();
  assert.strictEqual(world({ withToday: false }).bootLoadingHtml(), plain);
});

test("a press on the skeleton's knob is remembered and answered once the drawer is bound, never dropped", () => {
  // MUTATION: delete the `bootKnobPressed = true` line in paintBootLoading's click handler -> the drawer never opens; delete `bootKnobPressed = false` in settleBootKnob -> a second settle reopens the drawer; delete the `settleBootKnob();` line after bindDrawerChrome() in init() -> the source assertion fails.
  reset();
  const w = world();
  const opened = [];
  w.openDrawer = (open) => { opened.push(open); };
  let press = null;
  const knob = { addEventListener: (type, fn) => { if (type === "click") press = fn; } };
  const view = { innerHTML: "", querySelector: (sel) => (sel === "#today-knob" ? knob : null) };
  w.paintBootLoading(view);
  assert.strictEqual(typeof press, "function", "the knob in the boot paint gets a click handler");
  w.settleBootKnob();
  assert.deepStrictEqual(opened, [], "no press, no drawer");
  press();
  w.settleBootKnob();
  assert.deepStrictEqual(opened, [true], "the remembered press opens the drawer");
  w.settleBootKnob();
  assert.deepStrictEqual(opened, [true], "answered once");
  const init = /^async function init\(\) \{[\s\S]*?\n\}/m.exec(APP)[0];
  assert.match(init, /bindDrawerChrome\(\);\s*settleBootKnob\(\);/, "answered right after the drawer's handlers are bound");
});

test("painting Today's skeleton also takes Today's body class and puts the tab row up, the plain line does neither", () => {
  // MUTATION: delete `if (html === BOOT_LOADING_HTML) return;` from paintBootLoading -> the plain screen also claims the Today body class and a tab row; delete the setBodyClass call -> the Today case fails.
  const w = world();
  const view = { innerHTML: "" };
  reset();
  w.paintBootLoading(view);
  assert.match(view.innerHTML, /data-boot-loading/);
  assert.match(view.innerHTML, /today--loading/);
  assert.strictEqual(env.bodyClass, "view-home");
  assert.strictEqual(env.tabBars, 1);

  reset({ hash: "#/show/abc" });
  const other = { innerHTML: "" };
  w.paintBootLoading(other);
  assert.strictEqual(other.innerHTML, plainLine(w));
  assert.strictEqual(env.bodyClass, null);
  assert.strictEqual(env.tabBars, 0);
});

test("a boot that FAILS gives the skeleton's chrome back: the body class, and the tab row only if the skeleton added it", () => {
  // MUTATION: delete the `endBootLoadingChrome();` line in init()'s catch block -> the call-site count drops to 1 and this fails; make endBootLoadingChrome remove the bar unconditionally (drop `undo.tabBar &&`) -> the pre-existing-bar case fails; delete its `classList.remove("view-home")` -> the first case fails.
  const w = world();
  const view = { innerHTML: "" };
  reset();
  w.paintBootLoading(view);
  assert.strictEqual(bodyClasses(), "view-home ui-v2");
  assert.ok(env.bar, "the skeleton put the tab row up");
  w.endBootLoadingChrome();
  assert.strictEqual(bodyClasses(), "ui-v2", "the failure note gets the legacy page back (index.html's body is `ui-v2`)");
  assert.strictEqual(env.bar, null, "and no tab row whose links do nothing before state.ready");
  w.endBootLoadingChrome(); // idempotent: a second call finds nothing to undo
  assert.strictEqual(bodyClasses(), "ui-v2");

  /* A tab row that was already there is not the skeleton's to remove. */
  reset();
  const existing = { remove: () => { env.bar = null; } };
  env.bar = existing;
  const w2 = world();
  w2.paintBootLoading({ innerHTML: "" });
  w2.endBootLoadingChrome();
  assert.strictEqual(env.bar, existing);

  /* The plain line took no chrome, so a failure after it has nothing to give back. */
  reset({ hash: "#/library" });
  const w3 = world();
  w3.paintBootLoading({ innerHTML: "" });
  env.classes = new Set(["view-home", "ui-v2"]);   /* a page that is NOT the skeleton's */
  w3.endBootLoadingChrome();
  assert.strictEqual(bodyClasses(), "view-home ui-v2");

  const init = /^async function init\(\) \{[\s\S]*?\n\}/m.exec(APP)[0];
  assert.strictEqual((init.match(/endBootLoadingChrome\(\);/g) || []).length, 2, "both failure paints (no session, and the caught boot error) call it");
  assert.ok(init.indexOf("endBootLoadingChrome();") < init.indexOf("Couldn't load 4a"), "the session-failure path restores before it paints its note");
});

test("init() paints through paintBootLoading and still waits for the documents before the first route", () => {
  // MUTATION: put `view.innerHTML = BOOT_LOADING_HTML` back in init() -> the paint assertion fails.
  const init = /^async function init\(\) \{[\s\S]*?\n\}/m.exec(APP)[0];
  assert.match(init, /if \(view && !view\.firstElementChild\) paintBootLoading\(view\);/);
  assert.doesNotMatch(init, /view\.innerHTML = BOOT_LOADING_HTML/);
  assert.ok(init.indexOf("await documentsP") !== -1 && init.indexOf("await documentsP") < init.indexOf("route();"), "the first route waits for documentsP");
  assert.match(init, /fetchJson\("data\/catalog-client\.json"\)/);
  /* The webview probe's constant is unchanged: the probe and the boot tests read this exact shape. */
  assert.match(APP, /const BOOT_LOADING_HTML = `<div class="page" data-boot-loading><p class="note">Loading 4a…<\/p><\/div>`;/);
  assert.match(HOME, /function todayLoadingHtml\(\)[\s\S]*data-boot-loading/);
});

test("the harness `loading` state holds the very document init() waits on, and shoots with the app still booting", () => {
  // MUTATION: change the route pattern in holdCatalog to `**/data/catalog.json*` (the unprojected file the boot never fetches) -> the pattern no longer matches the request and this fails; drop `held: true` -> walk.mjs waits for the tab bar the held boot never reaches (asserted on the state).
  const pattern = /page\.route\("([^"]+)"/.exec(STATES);
  assert.ok(pattern, "holdCatalog routes one pattern");
  const re = new RegExp("^" + pattern[1].replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "(?:.*/)?").replace(/\*/g, ".*") + "$");
  for (const url of ["http://127.0.0.1:5173/data/catalog-client.json", "http://127.0.0.1:5173/data/catalog-client.json?deploy=abc"]) {
    assert.match(url, re, `${url} is held`);
  }
  assert.doesNotMatch("http://127.0.0.1:5173/data/session.json", re, "only the catalog is held");
  assert.doesNotMatch("http://127.0.0.1:5173/data/catalog.json", re);

  const block = /id: "loading",[\s\S]*?\n    \},/.exec(STATES)[0];
  assert.match(block, /seed: "returning"/);
  assert.match(block, /route: "#\/"/);
  assert.match(block, /before: holdCatalog/);
  assert.match(block, /held: true/);
  assert.match(block, /ready: "\.skel"/);
  assert.match(block, /label: "home-loading"/);
  /* The walker honours both flags on the first navigation only, and `held` skips appReady. */
  assert.match(WALK, /if \(step\.before\) await step\.before\(page, \{ fx \}\);/);
  assert.match(WALK, /if \(step\.held\) await page\.waitForSelector\(step\.ready/);
  assert.ok(WALK.indexOf("step.before") < WALK.indexOf("await page.goto(base + (step.route"), "before runs ahead of the first goto");
});

test("screens.json repoints home-loading at the loading state and its regions at the skeleton", () => {
  // MUTATION: set "app" back to null in screens.json -> fidelity skips the screen and this fails.
  const screens = JSON.parse(read("docs/redesign-2026/directions/tactile/screens.json"));
  const s = screens.screens["home-loading"];
  assert.deepStrictEqual(s.app, { state: "loading", step: "home-loading" });
  assert.strictEqual(s.regions.header.app, ".today-top");
  assert.match(s.regions.hero.app, /\.skel--hero$/);
  assert.match(s.regions.rows.app, /\.skel--row$/);
  assert.match(s.regions.bridge.app, /\.skel--bridge$/);
  assert.strictEqual(s.regions.rows.mode, "all");
  for (const [name, region] of Object.entries(s.regions)) assert.ok(region.app, `${name} has an app selector (no region left null)`);
});
