/* The home screen MOVES when dragged, and the cards do NOT change size.
 *
 * Founder, TestFlight, 2026-09-03: "On the home page when I scroll up or
 * down there should be a bit of movement so I know the page is responsive.
 * The cards should move up/down like I'm scrolling, but they shouldn't
 * change in size." Two halves. The history of this screen is that each fix
 * for one half undid the other (the `body.view-home #view` comment in
 * styles.css has the sequence), which is why BOTH are pinned here, in one
 * file, so that a future change to either has to answer for the other.
 *
 *  1. MOVEMENT: the home document is taller than the viewport by exactly
 *     `--home-scroll-room`, at inset 0 and at a notched iPhone's 59px — so
 *     there is something to scroll into, and on iOS something to bounce
 *     from. A document exactly one screen tall has no overflow, and a
 *     WKWebView with nothing to scroll does not bounce (#359's diagnosis,
 *     and the founder's observation after #467 made Home one screen).
 *  2. NO RESIZING: nothing the cards are sized from reads a DYNAMIC
 *     viewport unit. `dvh` tracks the browser chrome and jitters through a
 *     rubber-band bounce, and `.cards4`/`.mini-card` take their height from
 *     `.home` via flex — that was the stretch-and-shrink report of
 *     2026-08-31. `svh` is fixed for the life of the page.
 *  3. The room is OUTSIDE the column the cards are sized from: it must not
 *     be in `.home`'s own box (border-box `min-height` would hand it to the
 *     cards) — it lives on `#view`, under `.home`.
 *  4. The BODY is the scroller: `.home` declares no overflow or overscroll
 *     of its own, and `body.view-home` is not `overflow: hidden` (#359's
 *     fix, which shipped with no test — this is it).
 *
 * Like test/home-layout.test.js this reads the real stylesheet and evaluates
 * the box model itself, because no desktop browser and no DOM-at-inset-0 test
 * can see a safe-area inset. The evaluator is the smallest one that handles
 * what these rules use: calc(), var(), env(), px, vh/svh.
 *
 * Every test names the mutation that kills it. All four were run.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const CSS = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/* selector -> [{prop, value}] in source order, media wrappers dropped (the
   light-theme :root redefines colours only, nothing measured here). */
function parseRules(css) {
  const out = new Map();
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const sels = m[1].trim().split(",").map((s) => s.trim());
    const decls = m[2].split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
      const i = d.indexOf(":");
      return { prop: d.slice(0, i).trim(), value: d.slice(i + 1).trim() };
    });
    for (const s of sels) out.set(s, (out.get(s) || []).concat(decls));
  }
  return out;
}
const RULES = parseRules(CSS);
const decls = (sel) => RULES.get(sel) || [];
/* The cascade within one selector: last declaration of a property wins,
   which is how `.home`'s vh fallback + svh pair resolves in a browser that
   knows svh. `values` keeps every one, for the "no dvh anywhere" checks. */
const valueOf = (sel, prop) => decls(sel).filter((d) => d.prop === prop).map((d) => d.value).pop() ?? null;
const values = (sel, prop) => decls(sel).filter((d) => d.prop === prop).map((d) => d.value);

const VARS = Object.fromEntries(decls(":root").filter((d) => d.prop.startsWith("--")).map((d) => [d.prop, d.value]));

/* Evaluate a length expression to px under {inset, viewportH}. Unknown
   syntax throws — a rule this file does not understand should fail loudly. */
function px(expr, { inset = 0, viewportH = 956 } = {}) {
  let s = String(expr);
  for (let i = 0; i < 10 && /var\(/.test(s); i++) {
    s = s.replace(/var\((--[\w-]+)\)/g, (_, name) => {
      if (!(name in VARS)) throw new Error(`unknown custom property ${name}`);
      return `(${VARS[name]})`;
    });
  }
  s = s.replace(/env\(safe-area-inset-top\)/g, `${inset}px`)
       .replace(/env\(safe-area-inset-bottom\)/g, "0px")
       .replace(/(\d+(?:\.\d+)?)(svh|vh|lvh)/g, (_, n) => `(${(Number(n) / 100) * viewportH})`)
       .replace(/calc\(/g, "(")
       .replace(/(\d+(?:\.\d+)?)px/g, "$1");
  if (!/^[\d\s.+\-*/()]+$/.test(s)) throw new Error(`cannot evaluate: ${expr} -> ${s}`);
  return Function(`"use strict"; return (${s});`)();
}

/* 1 — MOVEMENT */
test("the home document overflows the viewport by exactly --home-scroll-room, at inset 0 and at 59px", () => {
  /* MUTATION: delete the `body.view-home #view { padding-bottom: ... }` rule
     from styles.css (or set --home-scroll-room to 0). The document is then
     exactly one screen tall, overflow is 0, and there is nothing to scroll. */
  const room = px(VARS["--home-scroll-room"]);
  assert.ok(room >= 24 && room <= 96,
    `the room is "a bit of movement": between 24px and 96px, not a second screen — got ${room}px`);
  for (const inset of [0, 59]) {
    const opts = { inset, viewportH: 956 };
    const padTop = px(valueOf("#view", "padding-top"), opts);
    const home = px(valueOf(".home", "min-height"), opts);
    const padBottom = px(valueOf("body.view-home #view", "padding-bottom"), opts);
    const document = padTop + home + padBottom;
    assert.strictEqual(document - 956, room,
      `at inset ${inset}px the document should be one screen plus the room; ` +
      `got ${padTop} + ${home} + ${padBottom} = ${document} against a 956px viewport`);
  }
});

/* 2 — NO RESIZING */
test("nothing that sizes the cards reads the dynamic viewport: .home is svh, and .cards4/.mini-card use no viewport unit at all", () => {
  /* MUTATION: change `.home`'s `100svh` to `100dvh`. That is the exact
     2026-08-31 stretch-and-shrink regression. */
  const homeHeights = values(".home", "min-height");
  assert.ok(homeHeights.some((v) => /\dsvh\b/.test(v)), `.home must be sized in svh; declared: ${homeHeights.join(" | ")}`);
  for (const sel of [".home", ".cards4", ".mini-card"]) {
    for (const d of decls(sel)) {
      assert.ok(!/\d(dvh|lvh)\b/.test(d.value), `${sel} { ${d.prop}: ${d.value} } tracks the dynamic viewport`);
    }
  }
  for (const sel of [".cards4", ".mini-card"]) {
    for (const d of decls(sel)) {
      assert.ok(!/\d(vh|vw|svh|svw)\b/.test(d.value), `${sel} { ${d.prop}: ${d.value} } — the cards are sized by .home, never by the viewport directly`);
    }
  }
  assert.strictEqual(valueOf(".home", "height"), null, ".home has min-height, never height (#464)");
});

/* 3 — THE ROOM IS OUTSIDE THE COLUMN */
test("the scroll room is not inside .home's own box, where border-box min-height would hand it to the cards", () => {
  /* MUTATION: move the room onto `.home` — e.g. append
     `+ var(--home-scroll-room)` to `.home`'s padding-bottom or min-height and
     delete the #view rule. The cards grow by the room and test 1 also sees
     zero overflow. */
  for (const d of decls(".home")) {
    assert.ok(!d.value.includes("--home-scroll-room"), `.home { ${d.prop}: ${d.value} } must not carry the scroll room`);
  }
  assert.ok(valueOf("body.view-home #view", "padding-bottom")?.includes("--home-scroll-room"),
    "the room lives on #view under the home column");
});

/* 4 — THE BODY IS THE SCROLLER */
test("the body scrolls: .home declares no overflow or overscroll of its own, and body.view-home is not overflow: hidden (#359)", () => {
  /* MUTATION: add `body.view-home { overflow: hidden; }` back — the rule
     #359 removed, which killed the rubber-band on the whole page. Or add
     `overflow-y: auto` to `.home`, which would make the column its own
     scroller inside an already-scrolling body. */
  for (const prop of ["overflow", "overflow-y", "overflow-x", "overscroll-behavior", "overscroll-behavior-y"]) {
    assert.strictEqual(valueOf(".home", prop), null, `.home must not declare ${prop}`);
  }
  for (const sel of ["body.view-home", "body", "html"]) {
    for (const prop of ["overflow", "overflow-y"]) {
      const v = valueOf(sel, prop);
      assert.ok(v === null || v !== "hidden", `${sel} { ${prop}: hidden } would stop the page moving at all`);
    }
  }
});
