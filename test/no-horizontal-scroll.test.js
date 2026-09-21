/* The page never pans sideways, and a tap never zooms. Two founder reports
 * from 2026-09-17, kept in one file because they are the same class of bug —
 * a gesture the app never meant to offer — and because both fixes are one
 * declaration each, which is exactly the kind of thing a later "tidy up the
 * CSS" pass deletes without noticing.
 *
 *   1. "It should not be possible to scroll left/ right on episode pages."
 *   2. "It should also not be possible to zoom on the episode slide, when I was
 *       trying to skip forward several times it zoomed in instead."
 *
 * WHAT A UNIT TEST CAN AND CANNOT DO HERE, stated plainly. Neither report can
 * be reproduced in this process: both are touch behaviours of a real WKWebView,
 * and (1) could not even be reproduced in desktop Chrome — measured on
 * 2026-09-17 in a 390px harness, the episode page's document width was exactly
 * the viewport's, because `body.fy-sheet-open { overflow: hidden }` happened to
 * be masking it in that state. The same honest limit
 * test/now-playing-keyboard.test.js records for its own subject.
 *
 * So this file pins the DECLARATIONS, and names the mutation for each. What it
 * cannot pin is the gesture; what it can pin is that the app still says what it
 * means, on the elements where it matters.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const CSS = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
const INDEX = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

/** The body of the first rule with exactly this selector text. Same approach as
    test/ui-tokens.test.js: anchor on the brace-delimited block so a mention in
    a comment cannot satisfy an assertion. */
function cssRule(selector) {
  const re = new RegExp(`(^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m");
  const m = re.exec(CSS);
  return m ? m[2] : null;
}

/* ---------- 1. the document cannot scroll sideways ---------------------- */

test("html and body refuse horizontal overflow", () => {
  /* MUTATION: delete the `html, body` rule. This goes red, and in a browser a
     single over-wide descendant makes the whole page draggable again.
     RUN: failed as named. */
  const rule = cssRule("html, body");
  assert.ok(rule, "there must be a rule constraining both the root and the body");
  assert.match(rule, /overflow-x:\s*clip/, "the page must clip horizontal overflow");
  assert.match(rule, /max-width:\s*100%/, "and never be wider than the viewport in the first place");
});

test("the fallback declaration comes BEFORE the clip, or engines without `clip` get nothing", () => {
  /* Order is the whole mechanism of a CSS fallback: an engine that does not
     understand `clip` drops that declaration and keeps the last one it did
     understand. Written the other way round, `hidden` would win everywhere and
     we would have shipped the scroll-container bug the comment argues against.
     MUTATION: swap the two lines. This goes red. */
  const rule = cssRule("html, body");
  const hidden = rule.indexOf("overflow-x: hidden");
  const clip = rule.indexOf("overflow-x: clip");
  assert.ok(hidden >= 0, "the pre-Safari-16 fallback must exist");
  assert.ok(hidden < clip, "…and must be declared before `clip`, not after it");
});

test("`clip` rather than `hidden` as the winning value, because body is not a scroll container", () => {
  /* `overflow: hidden` on body makes body the scrollport, which breaks
     `position: sticky` children — `.fy-transport` is sticky at z-index 5 — and
     gives iOS a second box to rubber-band. This assertion is what stops a
     future "simplify" from collapsing the pair down to the familiar `hidden`. */
  assert.match(CSS, /\.fy-transport\s*\{[^}]*position:\s*sticky/,
    "if this stops being sticky the reasoning above needs re-checking, not the test deleting");
  const rule = cssRule("html, body");
  assert.ok(rule.lastIndexOf("clip") > rule.lastIndexOf("hidden"), "`clip` must be the value that wins");
});

test("description text wraps instead of widening the page", () => {
  /* The backstop above hides an over-wide box; this is what stops one existing.
     A sponsor URL with no space in it is the common case and `overflow-wrap:
     normal` will not break inside it.
     MUTATION: delete `overflow-wrap: anywhere` from `.ep-description-text`. */
  const rule = cssRule(".ep-description-text");
  assert.ok(rule, ".ep-description-text must still be styled");
  assert.match(rule, /overflow-wrap:\s*anywhere/);
});

test("a chapter title can shrink — a flex item's default min-width is the classic overflow source", () => {
  /* `min-width: auto` on a flex item means "never smaller than my content", so
     one long unbroken token in a chapter title pushes the row, and therefore
     the page, past the viewport.
     MUTATION: delete `min-width: 0` from `.ep-chapter-title`. */
  const rule = cssRule(".ep-chapter-title");
  assert.ok(rule, ".ep-chapter-title must still be styled");
  assert.match(rule, /min-width:\s*0/);
  assert.match(rule, /overflow-wrap:\s*anywhere/);
});

/* ---------- 2. a double tap on a control does not zoom ------------------ */

test("the controls a listener taps repeatedly opt out of double-tap zoom", () => {
  /* The reported gesture: two taps on skip inside ~300ms are a zoom gesture
     unless the element says otherwise. `.fy-btn` covers the transport buttons.
     MUTATION: delete the `touch-action: manipulation` rule. RUN: failed as
     named. */
  const rule = cssRule(".fy-btn, .fy-rate, .ep-chapter-row, .ep-ts");
  assert.ok(rule, "the tap-target rule must exist");
  assert.match(rule, /touch-action:\s*manipulation/);
});

test("it is `manipulation`, not `none` — pinch-to-zoom stays", () => {
  /* `none` would also kill panning and pinch, which is an accessibility
     regression dressed as a fix. The founder asked for the accidental zoom to
     stop, not for zoom to be taken away. */
  const rule = cssRule(".fy-btn, .fy-rate, .ep-chapter-row, .ep-ts");
  assert.ok(!/touch-action:\s*none/.test(rule), "must not disable panning and pinch on a control");
});

test("the viewport meta still permits zooming at all", () => {
  /* The other way this complaint could have been 'fixed' — `user-scalable=no`
     or `maximum-scale=1` — disables pinch-to-zoom for the whole app. It is the
     single most common accessibility defect in a mobile web view, and it is
     also not what was asked for.
     MUTATION: add `user-scalable=no` to the viewport meta. This goes red. */
  const meta = /<meta name="viewport" content="([^"]*)"/.exec(INDEX);
  assert.ok(meta, "index.html must still declare a viewport");
  assert.ok(!/user-scalable\s*=\s*no/.test(meta[1]), "the page must remain zoomable by pinch");
  assert.ok(!/maximum-scale\s*=\s*1/.test(meta[1]), "…and must not cap the scale to defeat it another way");
});
