/* The Now Playing sheet is WIRED, not merely designed (founder report,
 * 2026-09-13).
 *
 * Wyatt, live bug report: "I started playing a Lex Friedman podcast, clicked
 * on the now playing episode at the bottom, and the episode page that popped
 * up consumes the whole screen with just the bottom part of the transcript of
 * the episode. Few things to fix here: when I click on the now playing
 * episode, it should pop up with the page for the episode, same as Apple
 * Podcasts, starting at the top with the 'album artwork' or whatever that is.
 * That window should then be scrollable, I should be able to navigate up and
 * down there. Also, I should be able to drag that page down from the top to
 * return to what I was looking at previously."
 *
 * `player/sheet-drag-dismiss.test.js` owns the gesture's arithmetic. This file
 * owns the other half, and it is the half that is worthless to leave untested:
 * a perfect gesture module wired to nothing, or wired in the wrong ORDER, is a
 * sheet that still opens on the middle of a description.
 *
 * WHY THIS IS A SOURCE-TEXT SUITE. `player/client.js` builds real DOM at
 * import and cannot be loaded under node — the reason `episode-link.test.js`
 * and `media-session.test.js`'s part 6 already read it as text, and this file
 * reuses that file's `codeOnly()` stripper verbatim so a scan for a code path
 * cannot be satisfied by a comment ABOUT that code path. It is a weaker
 * instrument than executing the module and it is named as one; what it
 * genuinely catches is the wiring being deleted, reordered or renamed, which
 * is what regressions here actually look like.
 *
 * WHAT ONLY A DEVICE CAN CONFIRM, stated rather than faked: that a thumb-drag
 * on real iOS Safari reaches the pointermove listener instead of being taken
 * for a page swipe; that the sheet tracks the finger without lag; and that the
 * momentum scroll inside `.fp-sheet-scroll` feels native. Driven in desktop
 * Chrome against a live build during the change (open at scrollTop 0 across a
 * close/reopen cycle, a 120px drag dismissing, a mid-scroll drag correctly
 * ignored) — none of which is iOS.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const CLIENT = read("player/client.js");
const CSS = read("styles.css");

/** Comments and string literals stripped. Ported from episode-link.test.js,
    which documents why the order matters and why a `//` must be preceded by
    start-of-line/whitespace/an opener. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/(^|[\s(,;{}=])\/\/[^\n]*/gm, "$1");
}
const CODE = codeOnly(CLIENT);
const FLAT = CODE.replace(/\s+/g, " ");

/** Comments stripped, STRING LITERALS KEPT. Half of the wiring this file has
    to assert on IS a string — an event name, a module specifier, a class
    selector — which `codeOnly` deliberately erases. The `//` rule is the same
    one codeOnly uses (a slash-slash must follow start-of-line, whitespace or
    an opener), which is what keeps a `https://` inside a string from being
    read as the start of a comment. */
function commentsStripped(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[\s(,;{}=])\/\/[^\n]*/gm, "$1");
}
const TEXT = commentsStripped(CLIENT);
const FLAT_TEXT = TEXT.replace(/\s+/g, " ");

/** styles.css with its comments removed, so a rule cannot be "found" in prose
    about it — the same trap codeOnly closes on the JS side. */
const CSS_RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, " ");

test("the strippers are not blind to this file's own subject matter", () => {
  assert.doesNotMatch(codeOnly("/* ui.scroll.scrollTop = 0; */ const a = 1;"), /scrollTop/);
  assert.match(codeOnly("/* prose */ ui.scroll.scrollTop = 0;"), /scrollTop/);
  assert.doesNotMatch(CSS.replace(/\/\*[\s\S]*?\*\//g, " "), /founder report, 2026-09-13/);
});

/* ==================================================================== */
/* 1. IT OPENS AT THE TOP — AND THE ORDER IS THE WHOLE TEST              */
/* ==================================================================== */

test("opening the sheet resets its scroller, and does so AFTER the unhide", () => {
  /* The reported symptom is "starting at the bottom", and the scroller is a
     long-lived element reused for every episode, so it remembers where it was
     left. Resetting it is necessary; resetting it while the sheet is still
     `display: none` does NOTHING — the write is dropped and the browser
     restores the old offset on show. Measured in Chrome during this change:
     with the reset written first, scroll 400px into a description, close,
     reopen, and `scrollTop` read back 400.

     MUTATION 1: delete `ui.scroll.scrollTop = 0;` — the first assertion fails.
     MUTATION 2: move that line above `ui.sheet.hidden = !open;` — the second
     fails, and the shipped bug returns in full. */
  assert.match(CODE, /ui\.scroll\.scrollTop = 0;/, "setExpanded must reset the sheet's scroller");
  const hidePos = CODE.indexOf("ui.sheet.hidden = !open;");
  const resetPos = CODE.indexOf("ui.scroll.scrollTop = 0;");
  assert.ok(hidePos > 0 && resetPos > 0, "both lines must exist in setExpanded");
  assert.ok(
    resetPos > hidePos,
    "the scrollTop reset must come AFTER `ui.sheet.hidden = !open` — a display:none element silently drops it"
  );
});

/* ==================================================================== */
/* 2. THE ARTWORK IS FIRST                                              */
/* ==================================================================== */

test("the sheet's scroller starts with the artwork, then the title", () => {
  /* "starting at the top with the 'album artwork'". MUTATION: reorder the
     append to `scroll.append(sTitle, sArt, ...)`. This fails. */
  assert.match(
    FLAT,
    /scroll\.append\(sArt, sTitle, sShow, sWhy,/,
    "the scroller's first child must be the artwork element"
  );
  assert.match(CODE, /const sArt = el\(/, "the sheet must build its own artwork element");
  assert.match(CODE, /ui\.sArt\.src = item\.artwork_url;/, "and fill it from the item's artwork");
});

test("the sheet shows the publisher's description as text, never as markup", () => {
  /* The long body that makes the sheet worth scrolling. `textContent` because
     it is third-party RSS — the rule the whole client file is built on.
     MUTATION: change it to `ui.sDesc.innerHTML = item.description`. This
     fails, and third-party markup would be parsed into our DOM. */
  assert.match(CODE, /ui\.sDesc\.textContent = item\.description \|\| "";/);
  assert.doesNotMatch(CODE, /sDesc\.innerHTML/);
});

/* ==================================================================== */
/* 3. IT SCROLLS INSIDE ITSELF, AND IT IS A FULL-HEIGHT OVERLAY         */
/* ==================================================================== */

test("the sheet has exactly one scroller and it is inside the sheet", () => {
  /* "That window should then be scrollable, I should be able to navigate up
     and down there." Before this change the sheet had no scroller at all.
     MUTATION: drop `overflow-y: auto` from `.fp-sheet-scroll`. This fails. */
  const rule = /\.fp-sheet-scroll \{[^}]*\}/.exec(CSS_RULES);
  assert.ok(rule, ".fp-sheet-scroll must have a rule of its own");
  assert.match(rule[0], /overflow-y:\s*auto/);
  assert.match(rule[0], /min-height:\s*0/, "a flex child needs min-height:0 or it never scrolls");
});

test("the sheet itself is a full-height overlay, and the [hidden] attribute still hides it", () => {
  /* The `display` declaration this rule needs is the exact trap `.fp-close`'s
     own comment in styles.css documents: `[hidden]` is a UA-stylesheet rule and
     ANY author `display` beats it. Without the companion rule, a COLLAPSED
     sheet is an opaque full-screen overlay over the whole app.
     MUTATION: delete `.fp-sheet[hidden] { display: none; }` — this fails, and
     the app becomes unusable the moment anything plays. */
  const sheet = /\.fp-sheet \{[^}]*\}/.exec(CSS_RULES);
  assert.ok(sheet, ".fp-sheet must have a rule of its own");
  assert.match(sheet[0], /position:\s*fixed/);
  assert.match(sheet[0], /inset:\s*0/);
  assert.match(sheet[0], /display:\s*flex/);
  assert.match(CSS_RULES, /\.fp-sheet\[hidden\]\s*\{\s*display:\s*none;?\s*\}/);
});

test("no body padding is reserved for the expanded sheet any more", () => {
  /* An overlay occupies no page space. The `--fp-sheet-h` reservations were
     what made the old panel push the page up; left behind they would strand a
     240px gap under every list while the sheet is open.
     MUTATION: restore `body.fp-open.fp-expanded { padding-bottom: ... }`.
     This fails. */
  assert.doesNotMatch(CSS_RULES, /--fp-sheet-h/);
  assert.doesNotMatch(CSS_RULES, /\.fp-expanded \{[^}]*padding-bottom/);
});

test("the page behind the sheet is scroll-locked while it is open", () => {
  /* Otherwise a drag that the sheet declines scrolls the page underneath it,
     which is the founder's "the bottom part of the transcript" reappearing
     through a different door. Same lock `body.fy-sheet-open` already applies.
     MUTATION: delete this rule. This fails. */
  assert.match(CSS_RULES, /body\.fp-expanded \{\s*overflow:\s*hidden;?\s*\}/);
});

/* ==================================================================== */
/* 4. DRAG TO DISMISS IS BOUND, TO THE SHARED MODULE                    */
/* ==================================================================== */

test("the drag gesture is imported from the shared module, not re-implemented here", () => {
  /* A second copy of the thresholds is how the tested module and the shipped
     behaviour come apart. MUTATION: inline a `const DISMISS = 120` in
     client.js and compare against it. The second assertion fails. */
  assert.match(
    TEXT,
    /import \{ startDrag, moveDrag, endDrag, dragOffset \} from "\.\/sheet-drag-dismiss\.js";/,
  );
  assert.doesNotMatch(TEXT, /DISMISS_DISTANCE_PX\s*=/, "client.js must not declare its own threshold");
});

test("all four pointer phases are bound on the sheet, and cancel springs back rather than dismissing", () => {
  /* MUTATION 1: delete the pointerup listener — the sheet becomes undismissable
     by drag and the first assertion fails.
     MUTATION 2: point pointercancel at `endSheetDrag` — the last assertion
     fails, and a system gesture (a notch swipe, a call arriving) would throw
     away a sheet nobody decided to close. */
  for (const phase of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
    assert.match(
      TEXT,
      new RegExp(`ui\\.sheet\\.addEventListener\\("${phase}"`),
      `the sheet must listen for ${phase}`
    );
  }
  assert.match(FLAT_TEXT, /const endSheetDrag = \(\) => \{[\s\S]{0,200}?endDrag\(drag\)/);
  assert.match(FLAT_TEXT, /addEventListener\("pointerup", endSheetDrag\)/);
  const cancel = /addEventListener\("pointercancel",[\s\S]{0,200}?\}\);/.exec(FLAT_TEXT);
  assert.ok(cancel, "there must be a pointercancel handler to inspect");
  assert.match(cancel[0], /setSheetDragOffset\(0\)/, "pointercancel must spring the sheet back");
  assert.doesNotMatch(cancel[0], /endDrag\(/, "pointercancel must not run the dismiss decision");
});

test("a press that lands on a control is that control's, not the sheet's", () => {
  /* Without this, pressing the scrub thumb and pulling slightly down starts
     dismissing the sheet under the finger.
     MUTATION: delete the `closest("button, a, input, select, textarea")`
     early return. This fails. */
  assert.match(FLAT_TEXT, /closest\("button, a, input, select, textarea"\)\) return;/);
});

test("eligibility is read from the real scroller at pointerdown", () => {
  /* The module cannot see the DOM; this is the line that answers its `atTop`
     question. MUTATION: hardcode `atTop: true`. This fails, and a flick while
     reading a description would dismiss the sheet. */
  assert.match(FLAT_TEXT, /atTop: \(ui\.scroll\.scrollTop \|\| 0\) <= 0,/);
  assert.match(
    FLAT_TEXT,
    /const fromHandle = !!\(e\.target[\s\S]{0,120}?closest\("\.fp-grab-zone"\)\);/,
    "the handle case must be recognised from the real event target"
  );
});

test("the drag offset is written as a custom property, never as a style attribute", () => {
  /* `style-src 'self'` with no inline styles (index.html's CSP). A CSSOM
     `setProperty` call is fine and is what segment-strip.js already documents;
     `setAttribute("style", ...)` is not.
     MUTATION: replace the setProperty call with
     `ui.sheet.setAttribute("style", ...)`. The second assertion fails. */
  assert.match(CODE, /ui\.sheet\.style\.setProperty\(/);
  assert.doesNotMatch(CODE, /setAttribute\("style"/);
  assert.match(CSS_RULES, /transform:\s*translateY\(var\(--fp-sheet-dy, 0px\)\)/);
});

/* ==================================================================== */
/* 5. THE ✕ MOVED WITH THE SHEET                                        */
/* ==================================================================== */

test("the ✕ lives in the sheet's grab row, not on the mini bar it would now hide behind", () => {
  /* The full-height sheet covers the mini bar, so a ✕ left on the bar is a
     styled, labelled control that can never be touched — the "dead target"
     U-13 removed once already. It is also the non-gesture way out, which a
     drag can never be for a switch or screen-reader user.
     MUTATION: restore `bar.append(art, info, playBtn, closeBtn)`. The second
     assertion fails. */
  assert.match(FLAT_TEXT, /grabZone\.append\(el\("div", "fy-grab"\), closeBtn\);/);
  assert.match(FLAT_TEXT, /bar\.append\(art, info, playBtn\);/);
  assert.doesNotMatch(FLAT_TEXT, /bar\.append\([^)]*closeBtn/);
  /* Unchanged from U-13, and asserted here because this is the change that
     could have quietly dropped it: the control still only COLLAPSES. */
  assert.match(TEXT, /ui\.closeBtn\.addEventListener\("click", \(\) => setExpanded\(false\)\)/);
});

test("the grab zone can receive a vertical drag at all", () => {
  /* `touch-action: none` is what stops the browser claiming the gesture as a
     scroll before any listener sees it — the convention styles.css already
     documents for the Foray strip's scrub target.
     MUTATION: delete `touch-action: none` from `.fp-grab-zone`. This fails,
     and drag-to-dismiss silently stops working on touch devices only. */
  const zone = /\.fp-grab-zone \{[^}]*\}/.exec(CSS_RULES);
  assert.ok(zone, ".fp-grab-zone must have a rule of its own");
  assert.match(zone[0], /touch-action:\s*none/);
  /* And the ✕ inside it opts back OUT, or the tap never lands. */
  assert.match(CSS_RULES, /\.fp-grab-zone \.fp-close \{[^}]*touch-action:\s*auto/);
});
