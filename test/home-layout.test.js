/* The home screen's geometry, under DEVICE conditions.
 *
 * WHY THIS SUITE EXISTS
 * Every bug it pins shipped to TestFlight and none of them was visible in a
 * desktop browser, because all of them turn on `env(safe-area-inset-top)`,
 * which is 0 on a desktop and ~59px on a notched iPhone. The founder's verdict
 * on the build was "complete garbage". The numbering below is this file's own
 * section order, one section per defect:
 *
 *   1. `.topbar` set `height: var(--topbar-h)` (44px) AND
 *      `padding-top: env(safe-area-inset-top)`. Under
 *      `* { box-sizing: border-box }` the 44px is the TOTAL, so 59px of
 *      padding left a negative content box: the <h1> spilled out below the bar
 *      and `border-bottom` painted straight through the title text.
 *   2. `#view` correctly offset by `calc(var(--topbar-h) + env(...))` = 103px
 *      while the bar's own box was 44px — a 43px dead band under the header.
 *   3. Elements marked `hidden` still rendered, because `[hidden] {display:none}`
 *      is a UA-stylesheet rule and ANY author `display` declaration beats the
 *      UA origin. `#sh-form`, `#sh-results` and `#browse-all-link` all carry
 *      one, so a second search box and a "Browse all shows" button drew on the
 *      home screen permanently. (Those elements have since left Home — the
 *      search lives on the Shows page and the link is gone — so the pin now
 *      reads renderAllShows(), and separately asserts Home hides nothing.)
 *   4. `.home` was a FIXED-height flex column whose only `flex: 1` child is
 *      `.cards4`, so any optional sibling took its space off the four subject
 *      cards. A continue banner plus three "Jump back in" rows crushed
 *      `.cards4` to 63.8px and each card to 26px (`.mini-card` sets
 *      `overflow: hidden`, so it looked deliberate rather than broken).
 *   5. `#banner-slot` is emitted on every home render and is empty most of the
 *      time, and an empty flex item still claimed one of the column's gaps.
 *
 * HOW IT TESTS THEM WITHOUT A BROWSER
 * It parses the real `styles.css` and evaluates the CSS box model over it:
 * `var()` against `:root`, `env()` against a substituted inset, `calc()`
 * arithmetic, and border-box height = content + padding + border. Every
 * assertion below is a NUMBER computed from the committed stylesheet at two
 * inset values (0px = desktop, 59px = iPhone 16 Pro Max), not a grep for a
 * string. That matters: a wrong fix that merely mentions `env(...)` — say
 * `height: calc(var(--topbar-h) + 20px)` — still fails here.
 *
 * WHAT IT IS NOT
 * It is not a browser. It models the specific cascade and box-model rules
 * these bugs turned on; it does not lay out text, so `TITLE_LINE_BOX`
 * below is a measured constant, not a computed one. The browser proof (Chrome
 * headless at 440x956 @3x with the insets textually substituted into the
 * served stylesheet, before and after) is in the PR that added this file,
 * along with the numbers each test here reproduces.
 *
 * THREE THINGS A REVIEW ROUND BROKE, kept here because each one is a way this
 * kind of suite goes quietly vacuous and each is now the reason for a specific
 * line below:
 *   - It flattened `@media` bodies into the unconditional cascade, so the
 *     shipped `.topbar` bug plus a correcting `@media print` block passed
 *     everything. Rules now carry their at-rule stack; `rulesFor` ignores
 *     conditional ones.
 *   - `displayWhenHidden` answered "none" whenever an `!important [hidden]`
 *     rule existed anywhere, which made its own per-element loop dead code and
 *     let `#sh-form { display: flex !important }` through. It now resolves the
 *     cascade: important, then specificity, then order.
 *   - The `.cards4` floor summed padding by hand and forgot `.mini-card`'s
 *     border — and the stylesheet's calc made the same omission, so the two
 *     agreed on a floor that clipped 2px of artwork. It reads the card's whole
 *     box now, so the border cannot be dropped from one side only.
 *
 * Every test names the one-line mutation that makes it fail, per CLAUDE.md.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { readAppSource } = require("./helpers/app-source.js");

const ROOT = path.join(__dirname, "..");
const CSS = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
const APP = readAppSource();

/* The two conditions that matter. 59px is an iPhone 16 Pro Max's top inset in
   portrait; 0px is every desktop browser, i.e. the condition under which all
   four bugs were invisible. Any invariant here must hold at BOTH. */
const DESKTOP = { top: 0, bottom: 0 };
const NOTCHED = { top: 59, bottom: 34 };

/* Height of the rendered line box for `.topbar h1 a` (1.2rem, 700, var(--serif))
   plus the flex line it sits on. Measured in Chrome at 440x956 @3x: 26.9px.
   Rounded DOWN to 26 so this is a floor the title genuinely needs, not a
   number tuned to today's font metrics. */
const TITLE_LINE_BOX = 26;

/* ==================================================================== */
/* A MINIMAL CSS BOX-MODEL EVALUATOR                                     */
/* ==================================================================== */

/**
 * Every rule in the sheet, each carrying the at-rules it is nested inside.
 *
 * `atRules` is not decoration. Without it this parser flattens `@media` bodies
 * into the unconditional cascade, and then a fix parked inside an at-rule that
 * never matches a phone satisfies every assertion below: `.topbar { height:
 * var(--topbar-h) }` — the shipped TestFlight bug, verbatim — plus a
 * `@media print` block with the correct height passed all five tests before
 * this was added. That is exactly the "the fixture is more forgiving than the
 * thing it stands for" shape CLAUDE.md enumerates, in the one file standing
 * between this bug class and another device.
 */
function parseRules(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  const stack = [];
  let buf = "";
  for (const ch of src) {
    if (ch === "{") { stack.push(buf.trim()); buf = ""; }
    else if (ch === "}") {
      const prelude = stack.pop();
      // An at-rule's body is the rules inside it, already collected; only a
      // style rule's own buffer holds declarations.
      if (prelude && !prelude.startsWith("@")) {
        rules.push({ prelude, decls: parseDecls(buf), atRules: stack.filter((s) => s.startsWith("@")) });
      }
      buf = "";
    } else buf += ch;
  }
  return rules;
}

/** Declarations in source order (later wins), each { prop, value, important }. */
function parseDecls(block) {
  const out = [];
  for (const raw of block.split(";")) {
    const chunk = raw.trim();
    if (!chunk) continue;
    const colon = chunk.indexOf(":");
    if (colon < 0) continue;
    const prop = chunk.slice(0, colon).trim().toLowerCase();
    let value = chunk.slice(colon + 1).trim();
    const important = /!\s*important$/i.test(value);
    if (important) value = value.replace(/!\s*important$/i, "").trim();
    out.push({ prop, value, important });
  }
  return out;
}

const RULES = parseRules(CSS);

/**
 * Rules that apply UNCONDITIONALLY and whose selector list contains `sel`
 * exactly (a simple selector).
 *
 * "Unconditionally" is the load-bearing half: a rule inside any at-rule is
 * ignored, because whether it applies depends on a condition this file does
 * not model. That is deliberately strict — it means a legitimate future fix
 * placed inside `@media (max-width: …)` will fail here and have to be made
 * unconditional or the test taught about it, which is the right direction for
 * a guard whose whole job is to be less forgiving than a desktop browser.
 */
function rulesFor(sel) {
  return RULES.filter(
    (r) => r.atRules.length === 0 && r.prelude.split(",").some((p) => p.trim() === sel)
  );
}

/** Every unconditional rule in the sheet, in source order. */
const UNCONDITIONAL = RULES.filter((r) => r.atRules.length === 0);

/** Every declaration of `sel`, in source order across all its rules. */
function declsOf(sel) {
  return rulesFor(sel).flatMap((r) => r.decls);
}

/** All values a property is given on `sel`, in source order (fallback chains). */
function valuesOf(sel, prop) {
  return declsOf(sel).filter((d) => d.prop === prop).map((d) => d.value);
}

/** The winning (last) value of `prop` on `sel`, or null. */
function valueOf(sel, prop) {
  const all = valuesOf(sel, prop);
  return all.length ? all[all.length - 1] : null;
}

/** Custom properties declared on `:root`. */
const ROOT_VARS = (() => {
  const vars = new Map();
  for (const d of declsOf(":root")) if (d.prop.startsWith("--")) vars.set(d.prop, d.value);
  return vars;
})();

/** Substitute var()/env(), innermost first, until nothing is left to expand. */
function substitute(expr, env) {
  let out = String(expr);
  for (let guard = 0; guard < 20; guard++) {
    const before = out;
    out = out.replace(/\bvar\(\s*(--[\w-]+)\s*(?:,([^()]*))?\)/g, (_m, name, fb) => {
      if (ROOT_VARS.has(name)) return ROOT_VARS.get(name);
      if (fb !== undefined) return fb.trim();
      throw new Error(`unresolvable ${name} in "${expr}"`);
    });
    out = out.replace(/\benv\(\s*safe-area-inset-(top|bottom|left|right)\s*(?:,[^()]*)?\)/g,
      (_m, side) => `${env[side] ?? 0}px`);
    if (out === before) break;
  }
  if (/\b(var|env)\(/.test(out)) throw new Error(`unresolved substitution in "${out}"`);
  return out;
}

/* A tiny recursive-descent arithmetic parser. Deliberately NOT eval/Function:
   this file reads a stylesheet off disk and must never execute what it reads. */
function evalArithmetic(src, ctx) {
  const tokens = String(src).match(/\d*\.?\d+[a-z%]*|[()+\-*/]/gi) || [];
  let i = 0;
  const peek = () => tokens[i];
  const eat = () => tokens[i++];

  function toPx(tok) {
    const m = /^(\d*\.?\d+)([a-z%]*)$/i.exec(tok);
    if (!m) throw new Error(`not a number: ${tok}`);
    const n = Number(m[1]);
    switch (m[2].toLowerCase()) {
      case "": return n;              // a bare multiplier, e.g. `4 * 80px`
      case "px": return n;
      case "rem": case "em": return n * ctx.rootFontSize;
      // vh/svh/dvh differ only in which viewport height they track; this
      // evaluator is given one, which is exactly the point of `svh` (see the
      // `.home` comment in styles.css).
      case "vh": case "svh": case "dvh": return (n / 100) * ctx.viewportH;
      case "vw": case "svw": case "dvw": return (n / 100) * ctx.viewportW;
      default: throw new Error(`unsupported unit in ${tok}`);
    }
  }
  function primary() {
    if (peek() === "(") { eat(); const v = expr(); if (eat() !== ")") throw new Error("unbalanced ()"); return v; }
    if (peek() === "-") { eat(); return -primary(); }
    if (peek() === "+") { eat(); return primary(); }
    return toPx(eat());
  }
  function term() {
    let v = primary();
    while (peek() === "*" || peek() === "/") { const op = eat(); const r = primary(); v = op === "*" ? v * r : v / r; }
    return v;
  }
  function expr() {
    let v = term();
    while (peek() === "+" || peek() === "-") { const op = eat(); const r = term(); v = op === "+" ? v + r : v - r; }
    return v;
  }
  const v = expr();
  if (i !== tokens.length) throw new Error(`trailing tokens in "${src}"`);
  return v;
}

/** Resolve a CSS length expression to pixels. */
function px(expr, { env = DESKTOP, viewportH = 956, viewportW = 440, rootFontSize = 16 } = {}) {
  if (expr == null) return null;
  // `calc(a + b)` is just parenthesised arithmetic once var()/env() are gone.
  const flat = substitute(expr, env).replace(/\bcalc\(/g, "(");
  return evalArithmetic(flat, { viewportH, viewportW, rootFontSize });
}

/** The first length token of a shorthand like `1px solid var(--line)`. */
const firstLength = (v) => (v == null ? null : v.trim().split(/\s+/)[0]);

/** Width from a `border`-family shorthand. `none` and `0` are both zero. */
function borderWidth(value, opts) {
  const first = firstLength(value);
  if (!first || first === "none") return 0;
  return px(first, opts);
}

/**
 * The used box metrics of a selector under `box-sizing: border-box`, folding
 * `padding` / `padding-top` / `border-bottom` shorthands in source order.
 */
function boxOf(sel, opts) {
  const b = { height: null, minHeight: null, paddingTop: 0, paddingBottom: 0, borderTop: 0, borderBottom: 0 };
  for (const d of declsOf(sel)) {
    switch (d.prop) {
      case "height": b.height = px(d.value, opts); break;
      case "min-height": b.minHeight = px(d.value, opts); break;
      case "padding": {
        const parts = d.value.trim().split(/\s+(?![^(]*\))/);
        b.paddingTop = px(parts[0], opts);
        b.paddingBottom = px(parts.length >= 3 ? parts[2] : parts[0], opts);
        break;
      }
      case "padding-top": b.paddingTop = px(d.value, opts); break;
      case "padding-bottom": b.paddingBottom = px(d.value, opts); break;
      /* The `border` SHORTHAND, which is how `.mini-card` actually declares its
         border — and leaving it out here is what let two mutations survive:
         `.mini-card { border: 6px solid }` (12px of clipped artwork) and a
         `.cards4` floor that omitted the border entirely both read as zero
         border and passed. `none`/`0` resolve to 0 through firstLength. */
      case "border": {
        const w = borderWidth(d.value, opts);
        b.borderTop = w; b.borderBottom = w;
        break;
      }
      case "border-width": {
        const parts = d.value.trim().split(/\s+/);
        b.borderTop = px(parts[0], opts);
        b.borderBottom = px(parts.length >= 3 ? parts[2] : parts[0], opts);
        break;
      }
      case "border-top": b.borderTop = borderWidth(d.value, opts); break;
      case "border-bottom": b.borderBottom = borderWidth(d.value, opts); break;
      case "border-top-width": b.borderTop = px(d.value, opts); break;
      case "border-bottom-width": b.borderBottom = px(d.value, opts); break;
      default: break;
    }
  }
  // border-box: the declared height IS the border box.
  b.borderBox = b.height != null ? b.height : b.minHeight;
  b.contentHeight = b.borderBox == null ? null
    : b.borderBox - b.paddingTop - b.paddingBottom - b.borderTop - b.borderBottom;
  return b;
}

/* ==================================================================== */
/* BUG 1 — THE TOPBAR'S BORDER DRAWS THROUGH ITS OWN TITLE               */
/* ==================================================================== */

test("the topbar's content box still fits its title once the safe-area inset is inside it", () => {
  /* The whole defect in one number. `box-sizing: border-box` (declared on `*`,
     asserted below so this test cannot be quietly defeated by removing it)
     makes `height` the border box, so `height - padding-top - border` is the
     space the <h1> actually gets. At a 59px inset the old rule produced
     44 - 59 - 1 = -16px, and Chrome clamped the bar to 60px while the title
     ran 45.6 -> 72.4 and the 1px border painted at y=59, through the text.

     MUTATION: `.topbar { height: var(--topbar-h); }` (i.e. drop the
     `calc(... + env(safe-area-inset-top))`). The 59px case goes to -16px and
     this fails. The 0px case still passes, which is the point of asserting
     both — a desktop browser could never have caught this. */
  // LAST-wins, like every other declaration this file reads: a later
  // `* { box-sizing: content-box }` would invalidate every number below, and a
  // first-wins guard would not notice it.
  const boxSizing = declsOf("*").filter((d) => d.prop === "box-sizing").pop();
  assert.strictEqual(boxSizing?.value, "border-box",
    "this suite's arithmetic assumes the sheet's `* { box-sizing: border-box }`");

  /* The <h1> is not actually the tightest thing in the bar — the menu and
     refresh buttons are, at 42px against the title's ~27px line box. Both are
     asserted, from the rule rather than from a constant, because pinning only
     the looser one leaves real slack: `--topbar-h: 40px` would overflow the
     buttons while still clearing a 26px title. */
  const buttonHeight = px(valueOf(".topbar button", "height"));
  assert.ok(buttonHeight > 0, ".topbar's buttons must declare a height");

  for (const [label, env] of [["desktop (inset 0)", DESKTOP], ["notched iPhone (inset 59px)", NOTCHED]]) {
    const bar = boxOf(".topbar", { env });
    assert.ok(bar.borderBox != null, ".topbar must declare a height");
    assert.strictEqual(bar.paddingTop, env.top,
      `${label}: .topbar must still reserve the safe-area inset as padding`);
    assert.ok(
      bar.contentHeight >= TITLE_LINE_BOX,
      `${label}: .topbar's content box is ${bar.contentHeight}px, which cannot ` +
      `hold a ${TITLE_LINE_BOX}px title — its border-bottom paints through the text`
    );
    assert.ok(
      bar.contentHeight >= buttonHeight,
      `${label}: .topbar's content box is ${bar.contentHeight}px but its own buttons ` +
      `are ${buttonHeight}px — the menu and refresh controls overflow the bar`
    );
  }
});

/* ==================================================================== */
/* BUG 2 — A DEAD GAP BETWEEN THE BAR AND THE CONTENT                    */
/* ==================================================================== */

test("every offset that reserves room for the fixed topbar equals the topbar's own height", () => {
  /* `.topbar` is `position: fixed`, so it is out of flow and four separate
     rules reserve its space by hand. When the bar's own box disagreed with
     them the difference was visible as empty space: bar 44px, offset 103px,
     43px of nothing under the header.

     (`.home`, which subtracted the same reservation from the viewport, went with
     the retired one-screen grid; Today hides the bar and zeroes the offset
     together, which the last test of this file pins.)

     MUTATION: `#view { padding-top: var(--topbar-h); }`. At a 59px inset the
     offset is 44 while the bar is 103, and this fails by 59px. Same for
     `.shell-notice { top: var(--topbar-h); }` or `.fy-transport`. */
  const VIEWPORT_H = 956;
  for (const [label, env] of [["desktop (inset 0)", DESKTOP], ["notched iPhone (inset 59px)", NOTCHED]]) {
    const opts = { env, viewportH: VIEWPORT_H };
    const bar = boxOf(".topbar", opts).borderBox;

    const offsets = [
      ["#view padding-top", px(valueOf("#view", "padding-top"), opts)],
      [".shell-notice top", px(valueOf(".shell-notice", "top"), opts)],
      [".fy-transport top", px(valueOf(".fy-transport", "top"), opts)],
    ];
    for (const [what, value] of offsets) {
      assert.strictEqual(value, bar,
        `${label}: ${what} is ${value}px but the topbar's box is ${bar}px — ` +
        `the difference is dead space under the header (or content hidden behind it)`
      );
    }
  }
});

/* ==================================================================== */
/* BUG 3 — THINGS MARKED `hidden` THAT RENDER ANYWAY                     */
/* ==================================================================== */

/** Elements in one render function's template that carry the `hidden`
    attribute. Was renderHome()-only: the bug was found on the home screen,
    and the elements that carried it (#sh-form, #sh-results, #browse-all-link)
    lived there. Since 2026-09-03 Home renders nothing hidden at all — the
    search moved to the Shows page (renderAllShows) and the browse-all link is
    gone — so the mechanism is pinned where the hidden elements now are. The
    cascade defect is page-independent: an author `display` on an id or class
    beats the UA `[hidden]` rule on any page. */
function hiddenElementsIn(fnName) {
  /* `function <name>(` rather than `function <name>()`: renderAllShows took
     an optional `initialQuery` when the browse tiles started routing through
     it (#684), and a matcher pinned to the empty parameter list would have
     stopped finding the function and failed with "must exist in app.js" —
     a red that says nothing about the cascade defect this guards. */
  const start = APP.indexOf(`function ${fnName}(`);
  assert.ok(start > 0, `${fnName}() must exist in app.js`);
  const template = APP.slice(start, APP.indexOf("\n}", start));
  const out = [];
  for (const tag of template.match(/<[a-z][^>]*\bhidden\b[^>]*>/g) || []) {
    out.push({
      tag,
      id: (/\bid="([^"]+)"/.exec(tag) || [])[1] || null,
      classes: ((/\bclass="([^"]+)"/.exec(tag) || [])[1] || "").split(/\s+/).filter(Boolean),
    });
  }
  return out;
}

/** CSS specificity of a simple selector, as [ids, classes/attrs/pseudos, types]. */
function specificity(sel) {
  const ids = (sel.match(/#[\w-]+/g) || []).length;
  const classes = (sel.match(/\.[\w-]+|\[[^\]]*\]|:[a-z-]+/gi) || []).length;
  const types = (sel.match(/(^|[\s>+~])[a-z][\w-]*/gi) || []).length;
  return [ids, classes, types];
}

const beats = (a, b) => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];

/**
 * Author `display` declarations that could apply to this element, each with
 * the selector that carries it. `[hidden]` is INCLUDED — the fix and the bug
 * compete in the same cascade, and modelling only one side is how the first
 * version of this function ended up unable to fail.
 */
function displayDeclarations(el) {
  const selectors = [
    "[hidden]",
    el.id ? `#${el.id}` : null,
    ...el.classes.map((c) => `.${c}`),
  ].filter(Boolean);
  const out = [];
  for (const sel of selectors) {
    for (const rule of rulesFor(sel)) {
      const order = UNCONDITIONAL.indexOf(rule);
      for (const d of rule.decls) {
        if (d.prop === "display") out.push({ sel, value: d.value, important: d.important, order });
      }
    }
  }
  return out;
}

/**
 * What `display` an element with the `hidden` attribute actually computes to.
 *
 * The rule that caused the bug: `[hidden] { display: none }` lives in the UA
 * origin, and an author declaration beats the UA origin at ANY specificity —
 * so one `.foo { display: block }` defeats `hidden` outright. Within the
 * author origin the ordinary cascade then applies, which is why this resolves
 * important-first, then specificity, then source order rather than simply
 * answering "none" if an `!important` rule exists anywhere. It has to: with
 * the short-circuit version, `#sh-form { display: flex !important }`
 * (specificity 1,0,0 — it really does beat `[hidden]`'s 0,1,0 and really does
 * render) came back as "none" and the suite stayed green.
 */
function displayWhenHidden(el) {
  const decls = displayDeclarations(el);
  if (!decls.length) return "none"; // nothing authored; the UA `[hidden]` rule stands
  const important = decls.filter((d) => d.important);
  const pool = important.length ? important : decls;
  let winner = pool[0];
  for (const d of pool.slice(1)) {
    const s = specificity(d.sel), w = specificity(winner.sel);
    if (beats(s, w) || (!beats(w, s) && d.order >= winner.order)) winner = d;
  }
  return winner.value;
}

/** Author `display` declarations from the element's OWN id/class rules. */
function competingDisplayRules(el) {
  return displayDeclarations(el).filter((d) => d.sel !== "[hidden]");
}

test("nothing carrying the `hidden` attribute can render — pinned on the Shows page, where the search's hidden elements now live", () => {
  /* `hidden` is this app's only hiding mechanism — app.js and
     player/client.js toggle `el.hidden` in ~30 places and never touch
     `display`. Three home-screen elements carried a class or id `display`
     declaration that silently overrode it, so the Shows search form (52px),
     its results container and "Browse all shows ›" (46px) drew permanently,
     inside a column where vertical space is the scarce resource.

     Those elements moved to the Shows page with the search (founder
     instruction, 2026-09-03), so this reads renderAllShows() now. Home is
     also checked, the other way round: it must mark NOTHING hidden, because
     a hidden element on Home is an element that should not be on Home at all.

     MUTATION: drop `!important` from `[hidden] { display: none !important }`
     in styles.css. `#sh-results` (`.show-results { display: flex }`) resolves
     to `flex` and this fails, naming it. MUTATION 2: delete the `[hidden]`
     rule outright — same failure. MUTATION 3: add `hidden` to any element in
     renderHome()'s template — the Home assertion fails. */
  assert.strictEqual(hiddenElementsIn("renderHome").length, 0,
    "renderHome() must mark nothing hidden — Home is the four cards and the banner, with nothing to hide");
  const hidden = hiddenElementsIn("renderAllShows");
  assert.ok(hidden.length >= 2, `expected renderAllShows() to mark its search note and results hidden, found ${hidden.length}`);

  /* Not vacuous: at least one of them must actually have a competing author
     `display`, or this test would pass on an empty stylesheet. This is the
     assertion that would have failed on `main` before the fix. */
  const contested = hidden.filter((el) => competingDisplayRules(el).length > 0);
  assert.ok(contested.length > 0,
    "no hidden home element has a competing `display` declaration — either the " +
    "stylesheet changed shape or this test is no longer testing anything");

  for (const el of hidden) {
    assert.strictEqual(displayWhenHidden(el), "none",
      `${el.id ? "#" + el.id : el.classes.join(".")} is marked hidden but computes to ` +
      `display:${displayWhenHidden(el)} — an author \`display\` beats the UA \`[hidden]\` rule`);
  }
});

/* ==================================================================== */
/* TODAY (Redesign 2026, Tactile Home): A SCROLLING COLUMN WITH NO FLOOR  */
/* ==================================================================== */

/* HISTORY, KEPT BECAUSE IT IS WHY THE COLUMN HAS NO FLOOR. The retired `.home`
   was a fixed one-screen column whose only `flex: 1` child was the four-card
   grid, so every optional sibling (the continue banner, the "Jump back in"
   rows) came straight out of the cards: measured at 440x956, the grid crushed
   to 63.8px and each card to 26px. #458 moved one sibling below the fold; the
   container was the bug. Home v2 then inherited `.home`'s floor through its
   second class and always scrolled by a tab bar's height into bare background.
   Today is `.today`, a plain flex column with neither a height nor a floor, and
   carries no second class. */

test("`.today` declares no fixed height and no min-height floor: it is a scrolling page, not a one-screen column", () => {
  /* MUTATION: add `min-height: calc(100svh - var(--topbar-h))` to `.today`
     (porting the retired `.home`'s fix onto a column that does not need it) ->
     this fails, naming the declared floor. MUTATION 2: add `class="home today"`
     back to the template -> the markup assertion fails. */
  assert.strictEqual(valueOf(".today", "height"), null, ".today must not declare a fixed height");
  assert.strictEqual(valueOf(".today", "min-height"), null, ".today must not declare a min-height floor either");
  assert.strictEqual(valueOf(".home", "min-height"), null, "the retired `.home` floor stays deleted");
  const APP = readAppSource();
  assert.ok(APP.includes('<div class="today">'), "fixture assumption: Today's column is `.today` and nothing else");
  assert.ok(!/class="home\b/.test(APP), "no element still carries the retired `.home` class");
});

test("`.today` reserves the safe-area inset at the top (its own bar is gone) and hides the legacy topbar with the offset it reserved", () => {
  /* With the topbar hidden on Home, nothing reserves the notch: the title row
     does, through `--safe-t`. And the legacy `#view` offset (the bar's height)
     must go in the same breath or Home would start 44px down an empty page.
     MUTATION: drop `var(--safe-t)` from `.today`'s padding -> the title draws
     under the status bar at inset 59 (this fails by 59px; at inset 0 it passes,
     which is why both insets are asserted). MUTATION 2: delete
     `body.view-home #view { padding-top: 0; }` -> the dead gap returns.
     MUTATION 3: delete `body.view-home .topbar { display: none; }` -> two
     headers. */
  for (const [label, env] of [["desktop (inset 0)", DESKTOP], ["notched iPhone (inset 59px)", NOTCHED]]) {
    const raw = valuesOf(".today", "padding");
    assert.ok(raw.length > 0, ".today must declare padding");
    assert.match(raw[raw.length - 1], /var\(--safe-t\)/, `${label}: .today's top padding must reserve the safe-area inset (--safe-t)`);
  }
  assert.match(CSS, /--safe-t:\s*env\(safe-area-inset-top,\s*0px\)/, "`--safe-t` is the safe-area inset");
  assert.strictEqual(valueOf("body.view-home #view", "padding-top"), "0", "the legacy bar's offset is zeroed on Home");
  assert.strictEqual(valueOf("body.view-home .topbar", "display"), "none", "and the bar itself is hidden there");
});
