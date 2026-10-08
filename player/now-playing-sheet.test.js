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
import { createRequire as __cr } from "node:module";
const { readAppSource } = __cr(import.meta.url)("../test/helpers/app-source.js");

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) =>
  rel === "app.js" ? readAppSource().replace(/\r\n/g, "\n") : fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const CLIENT = read("player/client.js");
const NOW_PLAYING = read("ui/now-playing.js");
const MINI = read("ui/mini.js");
const CSS = read("styles.css");

/** Comments and string literals stripped. Ported from episode-link.test.js,
    which documents why the order matters and why a `//` must be preceded by
    start-of-line/whitespace/an opener. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    /* One pass over the three quote kinds, whichever opens first: three passes
       read an apostrophe INSIDE a double-quoted literal ("couldn't") as opening
       a single-quoted string and blinded every assertion after it (audit round
       2, copy-6). */
    .replace(/`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '""')
    .replace(/(^|[\s(,;{}=])\/\/[^\n]*/gm, "$1");
}
const CODE = codeOnly(CLIENT);
const FLAT = CODE.replace(/\s+/g, " ");
const NP_CODE = codeOnly(NOW_PLAYING);
const NP_FLAT = NP_CODE.replace(/\s+/g, " ");

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
const NP_TEXT = commentsStripped(NOW_PLAYING);
const NP_FLAT_TEXT = NP_TEXT.replace(/\s+/g, " ");
const MINI_TEXT = commentsStripped(MINI).replace(/\s+/g, " ");

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

test("the redesigned sheet starts with the artwork hero, then the title block", () => {
  /* REWRITE-ON-PURPOSE, Tactile Now Playing: the hero wrapper is the shared
     element. MUTATION: append `copy` before `hero` -> red. */
  assert.match(NP_FLAT, /artWrap\.append\(parts\.sArt, collage\); hero\.append\(artWrap\);/);
  assert.match(NP_FLAT, /copy\.append\(parts\.sTitle, parts\.sShow, chips, parts\.sWhy\);/);
  assert.match(NP_FLAT, /top\.append\(hero, copy, bandSection\);/);
  assert.match(NP_FLAT, /parts\.scroll\.replaceChildren\(top, more\);/);
  assert.match(CODE, /const sArt = el\(/, "the sheet must build its own artwork element");
  assert.match(CODE, /ui\.sArt\.src = artworkUrl;/, "and fill it only from the safe artwork URL");
});

test("the sheet's notes are the episode page's notes, built as nodes from the one tokeniser — never from an HTML string", () => {
  /* The long body that makes the sheet worth scrolling. It is third-party RSS,
     so nothing here may be `innerHTML` — the rule the whole client file is
     built on. ROUND 2 (p-switcher-2): it used to be one `textContent` write,
     dead text with no links, no timestamps and no collapse, while the episode
     page had all three from the founder's 2026-09-17 ruling. The sheet now
     renders app.js's tokens (`window.ForayNotes`) node by node inside the same
     `<details>` the page uses.
     MUTATION 1: `ui.sDescText.innerHTML = …` -> red, and third-party markup
     would be parsed into our DOM. MUTATION 2: drop the `seekEpisodeTo(t.secs)`
     from the stamp's click -> the timestamps are dead again; red. */
  assert.doesNotMatch(CODE, /sDesc\.innerHTML|sDescText\.innerHTML/);
  assert.match(FLAT_TEXT, /const sDesc = el\("details", "fp-s-desc ep-description"\);/);
  assert.match(FLAT_TEXT, /el\("summary", "ep-description-toggle", "Episode notes"\)/, "collapsed under the page's own toggle");
  assert.match(FLAT_TEXT, /el\("p", "ep-description-text"\)/);
  const fn = /function paintNotes\(item\) \{[\s\S]*?\n\}/.exec(TEXT);
  assert.ok(fn, "paintNotes must exist");
  assert.match(fn[0], /window\.ForayNotes/);
  assert.match(fn[0], /notes\.lines/, "the line-aware pass (chapter rows) when the page offers it (round-2 review)");
  assert.match(fn[0], /read\(text, episodeDurationSec\(\)\)/, "the one tokeniser, with the honesty guard's duration");
  assert.match(fn[0], /el\("button", "ep-chapter-row"\)/, "a stamp-led line is the page's 44px chapter row");
  assert.match(fn[0], /ui\.sDescText\.textContent = text; return;/, "no tokeniser, or a Foray: plain text, as before");
  assert.match(fn[0], /ui\.sDescText\.append\(String\(t\.text \?\? ""\)\);/, "prose tokens go in as strings, never as markup");
  assert.doesNotMatch(fn[0], /replaceChildren|createTextNode/, "nothing the real-client harnesses' DOM stubs lack");
  assert.match(fn[0], /b\.dataset\.ts = String\(t\.secs\)/);
  assert.match(fn[0], /seekEpisodeTo\(t\.secs\)/, "a stamp seeks through the one seek path");
  assert.match(fn[0], /a\.rel = "noopener noreferrer"/);
  assert.match(fn[0], /\^https\?:/, "the scheme is re-checked here, behind app.js's safeUrl");
  assert.match(CODE, /paintNotes\(item\);/, "setNowPlaying paints through it");
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
  assert.match(sheet[0], /left:\s*0/);
  assert.match(sheet[0], /right:\s*0/);
  assert.match(sheet[0], /bottom:\s*0/);
  assert.match(sheet[0], /display:\s*flex/);
  assert.match(CSS_RULES, /\.fp-sheet\[hidden\]\s*\{\s*display:\s*none;?\s*\}/);
});

test("the Tactile Now Playing sheet is full-bleed and owns the background", () => {
  /* REWRITE-ON-PURPOSE: owner ruling requires aria-modal full-screen Now
     Playing. MUTATION: remove `inset: 0` from `.fp-sheet.np` -> red. */
  const sheet = /\.fp-sheet\.np \{[^}]*\}/.exec(CSS_RULES);
  assert.ok(sheet, ".fp-sheet.np must have a rule of its own");
  assert.match(sheet[0], /inset:\s*0/);
  assert.match(sheet[0], /height:\s*100dvh/);
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
    /import \{ startDrag, moveDrag, endDrag, dragOffset, claimsTouch \} from "\.\/sheet-drag-dismiss\.js";/,
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
  assert.match(FLAT_TEXT, /const endSheetDrag = \((?:e)?\) => \{[\s\S]{0,200}?endDrag\(drag\)/);
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
     assertion fails. (The bar's back-15 `skipBtn` sits between the title and
     ▶ since visual pass 1, persona 10 — test/transport-controls.test.js.) */
  assert.match(FLAT_TEXT, /grabZone\.append\(el\("div", "fy-grab"\), closeBtn\);/);
  assert.match(FLAT_TEXT, /bar\.append\(art, info, skipBtn, playBtn\);/);
  assert.doesNotMatch(FLAT_TEXT, /bar\.append\([^)]*closeBtn/);
  /* Unchanged from U-13, and asserted here because this is the change that
     could have quietly dropped it: the control still only COLLAPSES. */
  assert.match(TEXT, /ui\.closeBtn\.addEventListener\("click", \(\) => requestExpanded\(false\)\)/);
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

/* ==================================================================== */
/* AUDIT 2026-09-22: empty paragraphs are hidden, and a failed play says so */
/* ==================================================================== */

test("the hook and the timing note are hidden when empty, like the description", () => {
  /* Both carry margins, so an emptied-but-visible paragraph was a dead band in
     the sheet — on every Foray, which never has a hook.
     MUTATION: delete `ui.sWhy.hidden = !ui.sWhy.textContent;`. Red. MUTATION 2:
     delete `ui.note.hidden = !ui.note.textContent;`. Red. */
  assert.match(CODE, /ui\.sWhy\.textContent = why \|\| item\.hook \|\| "";\s*ui\.sWhy\.hidden = !ui\.sWhy\.textContent;/);
  assert.match(CODE, /ui\.note\.hidden = !ui\.note\.textContent;/);
  assert.match(CODE, /note\.hidden = true;/, "and the note starts hidden, before any item sets it");
});

test("an ordinary episode that fails to play says so on the bar and in the sheet", () => {
  /* Persona audit #4: a refused or failed play said nothing anywhere; the Foray
     page alone had a line for it. The telemetry sink now routes a media error or
     a refused play() on a single episode to `setPlayFailure`, which fills a live
     region on the bar and a line in the sheet.
     MUTATION: delete the `if (!foray && current && …) setPlayFailure(…)` branch
     in onTelemetry. Red. MUTATION 2: drop `setPlayFailure(null)` from
     setNowPlaying — a new episode would inherit the last one's failure. Red. */
  assert.match(CODE, /if \(!foray && current && \/player\\\.error\|play\\\.rejected\/i\.test\(m\)\) \{\s*setPlayFailure\(playFailureCopy\(m\)\);/);
  const setNow = CODE.slice(CODE.indexOf("function setNowPlaying("), CODE.indexOf("function currentRate("));
  assert.match(setNow, /setPlayFailure\(null\);/, "a new current item clears the previous one's failure");
  assert.match(CODE, /if \(playFailure && running\) setPlayFailure\(null\);/, "sound coming out clears it too");
  // CLIENT, not CODE: the attribute values are string literals, which CODE blanks.
  /* The live region is a SIBLING of the bar's <button> (review 2026-09-23): a
     button's children are presentational, so a status role inside it was never
     announced. MUTATION: put the role back on `err`. */
  assert.match(CLIENT, /announce\.setAttribute\("role", "status"\);/, "the bar's failure is announced");
  assert.doesNotMatch(CLIENT, /err\.setAttribute\("role"/, "and not from inside the named button");
  assert.match(CLIENT, /reportPlayFailure\(err\) \{/, "app.js has a bridge to report a throw from its side");
});

/* ==================================================================== */
/* AUDIT 2026-09-22: the sheet is a dialog, the bar is one target, one  */
/* finger drives the drag, and Stop is not Close                         */
/* ==================================================================== */

test("the Now Playing sheet is a named, modal dialog", () => {
  /* It covers the page from the topbar down and had no role, no name and no
     focus move, so a screen reader kept exploring the hidden page behind it.
     MUTATION: delete `sheet.setAttribute("role", "dialog")` -> red. */
  assert.match(TEXT, /sheet\.setAttribute\("role", "dialog"\)/);
  /* REWRITE-ON-PURPOSE: full-screen Tactile Now Playing is a modal. MUTATION:
     remove aria-modal from ui/now-playing.js -> red. */
  assert.match(NP_TEXT, /sheet\.setAttribute\("aria-modal", "true"\)/);
  assert.match(TEXT, /sheet\.setAttribute\("aria-labelledby", "fp-s-title"\)/);
  assert.match(TEXT, /sTitle\.id = "fp-s-title"/, "the name must point at an element that exists");
});

test("opening and closing go through the sheet owner, with the background inert", () => {
  /* The owner is what moves focus in and back, makes the page inert, binds
     Escape and derives the body lock (test/modal-and-focus.test.js exercises
     it for real). This pins that the Now Playing sheet USES it, and that the
     U-12/F17 invariant — the ☰ works at every moment — survives the inert.
     MUTATION: drop `".topbar"` from keepReachable -> red (the ☰ would go
     inert while the sheet is open). MUTATION: move `owner.closeSheet` below
     `ui.sheet.hidden = !open` -> focus is handed back AFTER the sheet (and its
     inert page) changed; the order assertion fails. */
  const fn = /const setExpanded = \(open\) => \{[\s\S]*?\n  \};/.exec(TEXT);
  assert.ok(fn, "setExpanded must exist");
  const body = fn[0];
  assert.match(body, /owner\.openSheet\(ui\.sheet, \{/);
  assert.match(body, /keepReachable: \["\.fp-announce"\]/);
  assert.match(body, /onRequestClose: \(\) => requestExpanded\(false\)/, "Escape and navigation use the interruptible transition path");
  assert.match(body, /ui\.bigPlay\.focus\(\{ preventScroll: true \}\)/, "focus lands on Play");
  assert.ok(body.indexOf("owner.closeSheet(ui.sheet)") < body.indexOf("ui.sheet.hidden = !open;"),
    "closing must release the owner before the sheet hides");
  assert.match(TEXT, /window\.ForaySheets/, "the owner is read from app.js's published bridge");
});

test("Stop, pressed from inside the sheet, releases the owner too", () => {
  /* MUTATION: delete the `owner.closeSheet(ui.sheet)` from stopAndClose -> the
     page stays inert with no sheet on screen; red. */
  const fn = /async function stopAndClose\([^)]*\) \{[\s\S]*?\n\}/.exec(TEXT);
  assert.ok(fn);
  assert.match(fn[0], /owner\.closeSheet\(ui\.sheet\)/);
});

test("tapping the mini bar's artwork opens the player, like the title beside it", () => {
  /* REWRITE-ON-PURPOSE: the art is inside the one mini body button. MUTATION:
     move it back beside `info` -> red. */
  assert.match(MINI_TEXT, /parts\.info\.insertBefore\(parts\.art, parts\.info\.firstChild\)/);
  assert.match(FLAT_TEXT, /ui\.info\.addEventListener\("click", \(\) => requestExpanded\(ui\.sheet\.hidden\)\)/);
});

test("the secondary row is speed, sleep, bookmark and Up Next; Collapse is the one close", () => {
  /* REWRITE-ON-PURPOSE: Tactile secondary transport. MUTATION: move Bookmark
     out of replaceChildren -> red. */
  assert.match(NP_FLAT, /parts\.row2\.replaceChildren\(parts\.rateBtn, sleepBtn, parts\.bookmarkBtn, parts\.queueLink\)/);
  assert.doesNotMatch(FLAT, /ui\.collapse/, "nothing is wired to one");
  assert.match(FLAT_TEXT, /ui\.closeBtn\.addEventListener\("click", \(\) => requestExpanded\(false\)\)/, "Collapse closes the sheet");
});

test("PQ-13 (#30): Bookmark sits in the Tactile secondary row", () => {
  /* Both are "keep this"; Stop still leads (the test above).
     MUTATION: remove `bookmarkBtn` from the `row2.append(...)` list -> the
     button is built and wired but never on screen; red. */
  assert.match(NP_FLAT, /parts\.row2\.replaceChildren\(parts\.rateBtn, sleepBtn, parts\.bookmarkBtn, parts\.queueLink\)/);
  assert.match(FLAT_TEXT, /const bookmarkBtn = el\("button", "fp-btn fp-bookmark", "Bookmark"\)/);
  assert.match(FLAT_TEXT, /ui\.bookmarkBtn\.hidden = !\(showEpisode && typeof nav\?\.addBookmark === "function"\)/,
    "hidden on a Foray and on a page with no addBookmark, as Save is");
});

test("PQ-13 (#30): the Bookmark click hands the page episodePositionSec(), not the element's raw clock", () => {
  /* `backend.currentTime` reads 0 through a cold load and on a restored bar;
     `episodePositionSec()` is the position the bar paints.
     MUTATION: swap `episodePositionSec()` for `backend.currentTime` in the
     click handler -> red. */
  const fn = /ui\.bookmarkBtn\.addEventListener\("click", \(\) => \{[\s\S]*?\n  \}\);/.exec(TEXT);
  assert.ok(fn, "the Bookmark click handler exists");
  const body = fn[0].replace(/\s+/g, " ");
  assert.match(body, /nav\.addBookmark\(id, episodePositionSec\(\), episodeDurationSec\(\)\)/);
  assert.doesNotMatch(body, /currentTime/, "never the element's clock");
  assert.match(body, /const id = ForayPlayer\.currentEpisodeId\(\);/, "the ordinary episode only — null on a Foray");
});

test("one finger drives the drag-to-dismiss; a second finger cannot restart or end it", () => {
  /* A second pointerdown used to reset the origin to that finger, and a lift
     of EITHER finger committed a dismiss nobody made. The Foray strip's own
     gesture already filtered on pointerId; the sheet now does the same.
     MUTATION: delete `if (dragPointer != null) return;` -> red. MUTATION: drop
     the pointerId check from pointermove -> red. */
  assert.match(FLAT_TEXT, /addEventListener\("pointerdown", \(e\) => \{ if \(ui\.sheet\.hidden\) return; if \(dragPointer != null\) return;/);
  assert.match(FLAT_TEXT, /addEventListener\("pointermove", \(e\) => \{ if \(!drag \|\| e\.pointerId !== dragPointer\) return;/);
  assert.match(FLAT_TEXT, /const endSheetDrag = \(e\) => \{ if \(!drag \|\| e\.pointerId !== dragPointer\) return;/);
  const cancel = /addEventListener\("pointercancel", \(e\) => \{[\s\S]{0,120}?\}\);/.exec(FLAT_TEXT);
  assert.ok(cancel && /e\.pointerId !== dragPointer/.test(cancel[0]), "pointercancel filters on the same finger");
});

/* ==================================================================== */
/* AUDIT ROUND 2 (2026-09-23): the pull-down from the body, the live     */
/* region, Stop's order, the sheet's motion, and every panel's drag      */
/* ==================================================================== */

const setExpandedBody = () => {
  const fn = /const setExpanded = \(open\) => \{[\s\S]*?\n  \};/.exec(TEXT);
  assert.ok(fn, "setExpanded must exist");
  return fn[0];
};

test("ROUND 2 touch-2: the sheet cancels the touchmove it claims, non-passively — and no longer pretends pointermove can", () => {
  /* `preventDefault` on pointermove stops no pan; only a cancelled non-passive
     touchmove does, and the decision is the module's `claimsTouch`.
     MUTATION 1: drop the touchmove listener -> red. MUTATION 2: make it
     `{ passive: true }` -> the browser ignores the cancel; red. MUTATION 3: put
     the `e.preventDefault()` back in pointermove -> the superseded path is
     back; red. */
  assert.match(
    FLAT_TEXT,
    /ui\.sheet\.addEventListener\("touchmove", \(e\) => \{ if \(drag && claimsTouch\(drag\)[^}]*e\.preventDefault\(\); \}, \{ passive: false \}\);/,
  );
  const move = /ui\.sheet\.addEventListener\("pointermove", \(e\) => \{[\s\S]*?\}\);/.exec(FLAT_TEXT);
  assert.ok(move, "the pointermove listener exists");
  assert.doesNotMatch(move[0], /preventDefault/, "pointermove no longer carries the cancel that did nothing");
});

test("ROUND 2 a11y-2: the live region is a sibling of the bar AND the sheet, and stays reachable when the sheet expands", () => {
  /* Inside the bar it went inert with the bar the moment Now Playing opened,
     so "Buffering…" and a failed load were silent on the one screen the
     listener was looking at. MUTATION 1: `bar.append(…, announce)` -> red.
     MUTATION 2: drop `".fp-announce"` from keepReachable -> red. */
  assert.match(FLAT_TEXT, /root\.append\(sheet, announce\);/);
  assert.doesNotMatch(FLAT_TEXT, /bar\.append\([^)]*announce/);
  assert.match(setExpandedBody(), /keepReachable: \[[^\]]*"\.fp-announce"/);
});

test("ROUND 2 a11y-6: Stop hides the player BEFORE the owner lets go, lands focus on the page and says so from outside the root", () => {
  /* closeSheet handed focus to the bar's title button and the next line hid
     the root under it. MUTATION 1: move `ui.root.hidden = true` back below
     `owner.closeSheet(ui.sheet)` -> the order assertion is red. MUTATION 2:
     drop the `nav.landOnPage` call -> red. MUTATION 3: drop `nav.announce` ->
     the stop is silent again; red. */
  const fn = /async function stopAndClose\([^)]*\) \{[\s\S]*?\n\}/.exec(TEXT);
  assert.ok(fn);
  const body = fn[0];
  const hide = body.indexOf("ui.root.hidden = true;");
  const release = body.indexOf("owner.closeSheet(ui.sheet)");
  assert.ok(hide > 0 && release > 0 && hide < release, "the root hides first, so the owner skips the button about to vanish");
  assert.match(body, /active\.blur\(\)/, "focus on Stop itself is let go, not left on a hidden control");
  assert.match(body, /nav\.landOnPage\(\{ navigated: false \}\)/, "the page's one landing rule takes over");
  assert.match(body, /nav\.announce\(STOPPED_LINE\)/, "and the stop is announced from app.js's region");
  assert.match(CLIENT, /const STOPPED_LINE = "Stopped";/);
});

test("ROUND 2 touch-8: the sheet slides in on open and finishes its slide on close; reduced motion switches both off", () => {
  /* `hidden` went to display:none in the frame the offset was reset, so a
     dismiss cut from mid-screen and an open was a hard cut. MUTATION 1: drop
     the `slideSheetOut(` guard at the top of setExpanded -> red. MUTATION 2:
     drop `if (open) slideSheetIn();` -> red. MUTATION 3: delete the
     reduced-motion rule for `.fp-sheet` in styles.css -> red. */
  const body = setExpandedBody();
  assert.match(body, /if \(!open && !sheetSettled && slideSheetOut\(/);
  assert.ok(body.indexOf("slideSheetOut(") < body.indexOf("owner.closeSheet(ui.sheet)"),
    "the slide runs before the owner lets go, so the page under it stays inert until the sheet has left");
  assert.match(body, /if \(open\) slideSheetIn\(\);/);
  assert.ok(body.indexOf("ui.scroll.scrollTop = 0;") < body.indexOf("slideSheetIn()"), "after the scroller reset");
  assert.match(FLAT_TEXT, /owner\.slideOut\(ui\.sheet, "--fp-sheet-dy", h, /, "the owner's one slide, on the sheet's own property");
  assert.match(FLAT_TEXT, /owner\.slideIn\(ui\.sheet, "--fp-sheet-dy", h, "fp-sheet-dragging"\)/);
  assert.match(FLAT_TEXT, /ui\.sheet\.classList\.remove\("fp-sheet-dragging"\); const started = owner\.slideOut/,
    "the release transition applies from wherever the drag left it");
  assert.match(CSS_RULES, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?--d-sheet:\s*1ms/);
});

test("ROUND 2 touch-4: every .fy-panel can move — the transform, the release transition, the entrance — and the gesture is bridged for the owner", () => {
  /* MUTATION 1: drop the `.fy-panel { transform: translateY(var(--fy-panel-dy…`
     rule -> app.js's drag writes a property nothing reads; red. MUTATION 2:
     drop `sheetDrag` from the bridge -> the owner finds no gesture and every
     handle is decoration again; red. */
  assert.match(CSS_RULES, /\.fy-panel \{[^}]*transform:\s*translateY\(var\(--fy-panel-dy, 0px\)\)/);
  assert.match(CSS_RULES, /\.fy-panel:not\(\.fy-panel-dragging\) \{\s*transition: transform \.22s ease;?\s*\}/);
  assert.match(CSS_RULES, /@keyframes fy-panel-in/);
  assert.match(CSS_RULES, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.fy-panel:not\(\.fy-panel-dragging\)[\s\S]*?transition:\s*none/);
  assert.match(FLAT_TEXT, /sheetDrag: \{ start: startDrag, move: moveDrag, end: endDrag, offset: dragOffset, claimsTouch, \}/);
});

test("ROUND 2 nav-5: the drawer's lock and its scrim's touch-action live beside the sheet's in styles.css", () => {
  /* MUTATION: delete `body.drawer-open { overflow: hidden; }` -> red. */
  assert.match(CSS_RULES, /body\.drawer-open \{\s*overflow:\s*hidden;?\s*\}/);
  assert.match(CSS_RULES, /#drawer \{[^}]*overscroll-behavior:\s*contain/);
  assert.match(CSS_RULES, /#drawer-overlay \{[^}]*touch-action:\s*none/);
});

test("Tactile tint follows the current enamel and raises its scrim when contrast falls below AA", () => {
  /* MUTATION: change `< 4.5` to `< 3` in dialApplyNowPlayingTint -> red. */
  assert.match(NP_TEXT, /dialContrast\(ink, mixed\(defaultAlpha\)\) < 4\.5 \? \.9 : defaultAlpha/);
  assert.match(NP_TEXT, /sheet\.style\.setProperty\("--np-tint", tint\)/);
  assert.match(NP_TEXT, /canvas\.width = canvas\.height = 32/);
  assert.match(NP_TEXT, /oklch\.c < \.07/);
  assert.match(NP_TEXT, /Math\.max\(\.1, oklch\.c\)/);
});

test("an earlier artwork sample cannot overwrite the active Foray station tint", () => {
  /* MUTATION: remove `parts.tintRequest === tintRequest` -> red because a late episode promise can repaint the Foray mauve. */
  assert.match(NP_FLAT_TEXT, /var tintRequest = \(parts\.tintRequest \|\| 0\) \+ 1/);
  assert.match(NP_FLAT_TEXT, /if \(parts\.tintRequest === tintRequest && !parts\.sheet\.classList\.contains\("np--foray"\)\) dialApplyNowPlayingTint/);
});

test("Tactile hero and transport preserve the ruled phone geometry", () => {
  /* MUTATIONS: change the 280px hero width or the 80px Play override -> red. */
  assert.match(CSS_RULES, /\.np__art \{[^}]*width:\s*280px;[^}]*height:\s*280px/);
  assert.match(CSS_RULES, /@media \(max-height: 740px\)[\s\S]*?\.np__art \{ width: 200px; height: 200px; \}/);
  assert.match(CSS_RULES, /\.np\.np--three-title \.np__art \{ width: 160px; height: 160px; \}/);
  assert.match(CSS_RULES, /\.np \.transport \{[^}]*gap:\s*var\(--s-6\)/);
  assert.match(CSS_RULES, /\.np \.transport \.fp-big \{[^}]*width:\s*var\(--key-xl\)[^}]*height:\s*var\(--key-xl\)/);
  /* Iteration 2 (fidelity): the 15/30 keys are the prototype's rendered 68 x 56 pill, not a 56 circle.
     MUTATION: change `--np-skip-w: 68px` to `var(--key-lg)` -> red (the step from Play to the skips steepens again). */
  assert.match(CSS_RULES, /\.np \{ --np-skip-w: 68px; \}/);
  assert.match(CSS_RULES, /\.np \.transport \.keycap--lg \{[^}]*width:\s*var\(--np-skip-w\)[^}]*height:\s*var\(--key-lg\)/);
  assert.match(NP_FLAT_TEXT, /parts\.row\.classList\.add\("transport"\)/);
});

test("Tactile scrubber keeps its 56px band, snapping and spoken show-aware clock", () => {
  /* MUTATION: change the 12px snap threshold -> red; change `.np__band-visual`'s
     height from var(--np-band-h) -> red; set the short-screen --np-band-h below
     var(--key-lg) -> red (the hit band is never under 56; the range fills it). */
  assert.match(CSS_RULES, /\.np__band-visual \{[^}]*height:\s*var\(--np-band-h\)/);
  assert.match(CSS_RULES, /\.np__band \{ --np-band-h: 64px;/);
  assert.match(CSS_RULES, /\.np__band \{ --np-band-h: var\(--key-lg\);/);
  assert.match(CSS_RULES, /\.np__range \{[^}]*inset:\s*0[^}]*height:\s*100%/);
  assert.match(FLAT_TEXT, /const threshold = dur \* 12 \/ width/);
  assert.match(TEXT, /dialSpokenClock\(pos\).*dialSpokenClock\(dur\)/s);
  assert.match(FLAT_TEXT, /"ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"/);
});

test("Tactile Foray provenance shows the station or narration under the needle, never both", () => {
  /* MUTATION: delete the `return` after appending the narration chip -> red because both chips can render. */
  assert.match(NP_TEXT, /parts\.chips\.append\(narration\);\s*return;\s*}/);
  assert.doesNotMatch(NP_FLAT_TEXT, /parts\.chips\.append\(chip, narration\)/);
  assert.match(NP_FLAT_TEXT, /var station = dialCurrentStation\(d\); var fallback = dialStationToken/);
});

test("Tactile detail scrolls beneath a bottom-pinned dock and keeps seekable 56 and 48px rows", () => {
  /* MUTATION: change `.np__dock` from `position: absolute` to `position: sticky` -> red and Play returns to the scroll flow.
     The dock sits at safe-b + 16 (--s-4) per the acceptance criterion. */
  assert.match(NP_FLAT, /sheet\.replaceChildren\(bg, parts\.grabZone, parts\.scroll, dock\)/);
  /* 190px puts the "Up next" heading 54px under the counter, as drawn, so its first card peeks out
     above the dock's fade (176 left a 67px gap and no card). MUTATION: put 176px back -> red. */
  assert.match(CSS_RULES, /\.np__top \{[^}]*min-height:\s*calc\(100% - 190px - var\(--safe-b\)\)/);
  assert.match(CSS_RULES, /\.np__up-next-card \{[^}]*align-items:\s*start/, "the card's art and title start at its top, so they are what peeks under the heading");
  assert.match(CSS_RULES, /\.np__dock::before \{[^}]*inset:\s*-22px 0/, "the fade starts 36px above the keys (the dock box is 14px above the transport row)");
  assert.match(CSS_RULES, /\.np__dock \{[^}]*position:\s*absolute[^}]*bottom:\s*calc\(var\(--safe-b\) \+ var\(--s-4\)\)/);
  assert.match(CSS_RULES, /\.np__dock::before \{[^}]*linear-gradient\(to bottom, transparent, var\(--paper\) 28px\)/);
  assert.match(CSS_RULES, /\.np \.segrow \{[^}]*min-height:\s*56px/);
  assert.match(CSS_RULES, /\.np__chapter \{[^}]*min-height:\s*48px/);
});

test("Tactile transport uses circular 56/80/56 keys with an attached darker lip and custom skip marks", () => {
  /* MUTATION: remove the explicit `width: var(--key-lg)` override -> red and legacy padding squashes the skip keys. */
  assert.match(CSS_RULES, /\.np \.transport \.keycap--lg \{\s*box-sizing:\s*border-box;\s*width:\s*var\(--np-skip-w\)[^}]*height:\s*var\(--key-lg\)[^}]*padding:\s*0/);
  /* The lip is a hard shadow in the key's own shape (the primitive's flat ::after bar is switched off).
     MUTATION: delete the `box-shadow: 0 var(--lip) 0 var(--k-lip)` rule -> red and the keys lose their lip. */
  assert.match(CSS_RULES, /\.np \.transport \.keycap::after,\s*\.np \.second \.keycap::after \{ content: none; \}/);
  assert.match(CSS_RULES, /\.np \.transport \.keycap,\s*\.np \.second \.keycap \{ box-shadow: 0 var\(--lip\) 0 var\(--k-lip\); \}/);
  assert.match(NP_FLAT_TEXT, /parts\.backBtn\.innerHTML = dialNpIcon\("skip-15", "lg"\)/);
  assert.match(NP_FLAT_TEXT, /parts\.fwdBtn\.innerHTML = dialNpIcon\("skip-30", "lg"\)/);
});

test("Tactile readout, band labels, chips and grabber use the ruled high-contrast materials", () => {
  /* MUTATION: change `.np__read .readout-lg` from `var(--ink)` to `var(--ink-2)` -> red. */
  assert.match(CSS_RULES, /\.np__read \.readout-lg \{[^}]*color:\s*var\(--ink\)/);
  /* Codes are HTML spans under the bars (the SVG <text> is squeezed by the band's non-uniform scale).
     MUTATION: put `.np__band-svg .t-band__code` back to visible -> the doubled, squeezed codes return. */
  assert.match(CSS_RULES, /\.np__band-svg \.t-band__code, \.np__band-svg \.needle \{ display: none; \}/);
  assert.match(CSS_RULES, /\.np__code \{[^}]*font:\s*700 0\.6875rem\/16px var\(--font-mono\)/);
  assert.match(CSS_RULES, /\.np__code\.is-current \{[^}]*color:\s*var\(--ink\)[^}]*font-weight:\s*800/);
  assert.match(CSS_RULES, /\.fp-sheet\.np \.rotary-chip \{[^}]*background:\s*var\(--card\)[^}]*box-shadow:\s*none/);
  assert.match(CSS_RULES, /\.fp-sheet\.np \.np__head \.fy-grab \{[^}]*background:\s*var\(--ink-3\)/);
});

test("Tactile Up Next is an artwork-led card whose URL passes through safeUrl", () => {
  /* MUTATION: remove `artwork: next.artwork` from the model -> red before the card can paint published artwork. */
  assert.match(FLAT_TEXT, /next: next \? \{[^}]*artwork: next\.artwork/);
  assert.match(NP_FLAT_TEXT, /var artworkUrl = dialSafeImageUrl\(model\.next\.artwork\)/);
  assert.match(NP_FLAT_TEXT, /nextHost\.append\(nextArt, nextBody, nextTime\)/);
  assert.match(CSS_RULES, /\.np__up-next-card \{[^}]*grid-template-columns:\s*var\(--art-row\) minmax\(0, 1fr\) auto/);
});

test("Tactile open uses a shared artwork transition with reduced-motion and WAAPI fallback", () => {
  /* The source-text half. It cannot see whether the fallback RUNS: deleting the `target.animate(...)`
     call left this test green (review, 2026-10-07). "the WAAPI fallback animates the hero from the
     mini's rect" below executes the function and watches `animate()` being called. */
  assert.match(CSS_RULES, /view-transition-name:\s*np-art/);
  assert.match(NP_TEXT, /document\.startViewTransition/);
  assert.match(NP_TEXT, /typeof target\.animate !== "function"/);
  assert.match(NP_TEXT, /duration: 480/);
  assert.match(NP_TEXT, /prefers-reduced-motion: reduce/);
});

/* ==================================================================== */
/* BEHAVIOUR OF THE VIEW'S OWN LOGIC — ui/now-playing.js run in a vm     */
/* ==================================================================== */

import vm from "node:vm";

/** A DOM element with only what ui/now-playing.js touches, and honest about it:
    attributes, classes, children, listeners and focus are real state here, not
    stubs that answer "yes". Layout is the one thing it cannot do, so a test that
    needs it sets `offsetLeft` / `offsetWidth` / `clientWidth` itself. */
class FakeEl {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.doc = doc;
    this.children = [];
    this.attrs = {};
    this.dataset = {};
    this.listeners = {};
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.tabIndex = 0;
    this.scrollLeft = 0;
    this.clientWidth = 0;
    this.offsetLeft = 0;
    this.offsetWidth = 0;
    this.innerHTML = "";
    this.classList = {
      add: (...names) => { names.forEach((n) => { if (!this.classList.contains(n)) this.className = (this.className + " " + n).trim(); }); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter((n) => n && !names.includes(n)).join(" "); },
      contains: (n) => this.className.split(/\s+/).includes(n),
      toggle: (n, force) => { if (force === undefined ? !this.classList.contains(n) : force) this.classList.add(n); else this.classList.remove(n); },
    };
  }
  append(...nodes) { nodes.forEach((n) => { if (typeof n !== "string") n.parent = this; this.children.push(n); }); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  /** Deliver an event to this element's listeners and return it. */
  fire(type, init = {}) {
    const event = { type, target: this, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...init };
    (this.listeners[type] || []).forEach((fn) => fn(event));
    return event;
  }
  /** A click on a disabled button does nothing, as in a browser. */
  click() { if (!this.disabled) this.fire("click"); }
  focus() { this.doc.activeElement = this; }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: 0 }; }
  setPointerCapture() { this.captured = true; }
  releasePointerCapture() { this.captured = false; }
}

function loadDial({ ink = "#201a17", paper = "#f7f0e4", dark = false, haptics = null, extra = {} } = {}) {
  const calls = [];
  const window = { Capacitor: haptics ? { Plugins: { Haptics: haptics(calls) } } : undefined };
  const root = { dataset: {} };
  const doc = { documentElement: root, activeElement: null, createElement: (tag) => new FakeEl(tag, doc) };
  const context = {
    window,
    document: doc,
    getComputedStyle: () => ({ getPropertyValue: (name) => (name === "--ink" ? ink : name === "--paper" ? paper : "") }),
    matchMedia: () => ({ matches: dark }),
    Date,
    Math,
    setTimeout,
    ...extra,
  };
  vm.createContext(context);
  vm.runInContext(NOW_PLAYING, context, { filename: "ui/now-playing.js" });
  return { dial: window.DialNowPlaying, calls, doc };
}

function fakeSheet() {
  const props = {};
  return { props, dataset: {}, style: { setProperty(name, value) { props[name] = value; } } };
}

test("haptics are throttled to one call per 100ms and are a no-op without the plugin", () => {
  /* MUTATION: change `< 100` to `< 0` in dialHaptic -> the 50ms call goes
     through, the plugin sees three impacts instead of two, and this fails. */
  const { dial, calls } = loadDial({ haptics: (log) => ({ impact: (o) => log.push(o), selectionChanged: () => log.push("sel") }) });
  assert.equal(dial.haptic("light", 1000), true);
  assert.equal(dial.haptic("light", 1050), false, "inside 100ms: dropped");
  assert.equal(dial.haptic("light", 1100), true, "at 100ms: allowed again");
  assert.equal(calls.length, 2, "the plugin was called only for the two allowed calls");
  const bare = loadDial();
  assert.doesNotThrow(() => bare.dial.haptic("heavy", 5000), "the web build has no plugin and must not throw");
});

test("the scrim rises to 0.9 only when ink over the mixed tint falls below 4.5:1", () => {
  /* MUTATION: change `< 4.5` to `< 0` in dialApplyNowPlayingTint -> the weak
     pair stays at .78 and the second assertion fails; change it to `< 99` ->
     the strong pair is raised too and the first fails. */
  const strong = loadDial({ ink: "#201a17", paper: "#f7f0e4" });
  const a = fakeSheet();
  assert.equal(strong.dial.applyTint(a, "#c99a00"), 0.78, "Cream ink over a mustard tint passes at the default");
  assert.equal(a.dataset.scrimAlpha, "0.78");
  assert.match(a.props["--np-scrim"], /,0\.78\)$/);
  assert.match(a.props["--np-surface"], /^rgb\(/, "a solid twin of the composited surface is published for contrast tools");
  const weak = loadDial({ ink: "#808080", paper: "#ffffff" });
  const b = fakeSheet();
  assert.equal(weak.dial.applyTint(b, "#ffd400"), 0.9, "a forced bright tint under mid-grey ink raises the scrim");
  assert.equal(b.dataset.scrimAlpha, "0.9");
});

test("an artwork tint under chroma 0.07 is the show's enamel, and anything else is clamped to 0.45-0.6 lightness with chroma floored at 0.10", () => {
  /* MUTATION: change `.07` to `.0` -> the grey sample is no longer replaced and
     the first assertion fails; remove `Math.max(.1, ...)` -> the third fails. */
  const { dial } = loadDial();
  assert.equal(dial.normalizeArtworkTint({ l: 0.5, c: 0.03, h: 40 }, "ENAMEL"), "ENAMEL");
  assert.equal(dial.normalizeArtworkTint(null, "ENAMEL"), "ENAMEL");
  assert.equal(dial.normalizeArtworkTint({ l: 0.9, c: 0.08, h: 40 }, "ENAMEL"), "oklch(0.600 0.100 40.0)", "light is clamped down, chroma floored");
  assert.equal(dial.normalizeArtworkTint({ l: 0.2, c: 0.2, h: 300 }, "ENAMEL"), "oklch(0.450 0.200 300.0)", "dark is clamped up, chroma kept");
});

test("narration keeps the previous show's enamel; an opening narration borrows the first show's", () => {
  /* MUTATION: make dialCurrentStation return `current` unconditionally -> the
     narration tick has no station and the tint flashes. */
  const { dial } = loadDial();
  const show = (code, colorIndex) => ({ narration: false, code, colorIndex, show: code });
  const tick = { narration: true, code: "", colorIndex: 0, show: "4a" };
  assert.equal(dial.currentStation({ segments: [show("AA", 1), show("BB", 2), tick], currentIndex: 2 }).code, "BB");
  assert.equal(dial.currentStation({ segments: [tick, show("AA", 1)], currentIndex: 0 }).code, "AA");
  assert.equal(dial.currentStation({ segments: [show("AA", 1), show("BB", 2)], currentIndex: 1 }).code, "BB");
});

test("the sleep dial's ticks are Off then 5 to 60 minutes, each named in words", () => {
  /* MUTATION: drop 60 from DIAL_SLEEP_TICKS -> the last assertion fails; change
     the tick label from `m ? String(m) : "Off"` to `String(m)` -> "0" for Off, red. */
  const { dial } = loadDial();
  const stops = dial.sleepStops();
  assert.deepEqual(Array.from(stops, (s) => s.value), [0, 5, 10, 15, 20, 30, 45, 60]);
  assert.deepEqual(Array.from(stops, (s) => s.text), ["Off", "5", "10", "15", "20", "30", "45", "60"], "a tick shows bare minutes");
  assert.equal(stops[3].label, "15 minutes", "its accessible name says what the number is");
  assert.equal(stops[0].label, "Off");
  assert.equal(dial.sleepText(60), "60 min");
  assert.equal(dial.sleepText(0), "Off");
});

/* ==================================================================== */
/* THE ROTARY: a detent strip in the dock, not a cycling chip            */
/* (BUILD-NOTES 3.14). Run on a fake DOM that keeps real state.         */
/* ==================================================================== */

/** The sleep dial as the dock builds it: 8 ticks of 44px in a 176px strip (so it scrolls), selected 0. */
function sleepRotary(overrides = {}) {
  const loaded = loadDial({
    haptics: (log) => ({ selectionChanged: () => log.push("sel") }),
    ...overrides.load,
    /* The real tactileIcon lives in ui/primitives.js; this one just names the symbol it was asked for. */
    extra: { tactileIcon: (id) => `<icon ${id}>`, ...overrides.load?.extra },
  });
  const changes = [];
  let done = 0;
  const rotary = loaded.dial.rotary({
    kind: "sleep", label: "Sleep timer", lessLabel: "Shorter", moreLabel: "Longer",
    stops: loaded.dial.sleepStops(), value: 0,
    onChange: (value) => changes.push(value),
    onDone: () => { done += 1; },
    ...overrides.opts,
  });
  rotary.track.clientWidth = 176;
  rotary.ticks.forEach((tick, i) => { tick.offsetLeft = i * 44; tick.offsetWidth = 44; });
  return { ...loaded, rotary, changes, done: () => done };
}

const checkedOf = (rotary) => Array.from(rotary.ticks, (t) => t.getAttribute("aria-checked"));

test("the rotary is a radiogroup of 44px ticks between a - key and a + key, one tab stop", () => {
  /* MUTATIONS: drop the `role="radio"` line -> red; make the selected tick's tabIndex
     `-1` as well -> the roving-tab-stop assertion goes red; give the - key the
     "ph-plus" icon -> the icon assertions go red. */
  const { rotary } = sleepRotary();
  assert.equal(rotary.root.getAttribute("role"), "group");
  assert.equal(rotary.track.getAttribute("role"), "radiogroup");
  assert.equal(rotary.ticks.length, 8);
  assert.ok(rotary.ticks.every((t) => t.getAttribute("role") === "radio" && t.tagName === "BUTTON"));
  assert.deepEqual(checkedOf(rotary), ["true", "false", "false", "false", "false", "false", "false", "false"]);
  assert.deepEqual(Array.from(rotary.ticks, (t) => t.tabIndex), [0, -1, -1, -1, -1, -1, -1, -1], "only the selected tick is a tab stop");
  assert.equal(rotary.less.innerHTML, "<icon ph-minus>", "the - key draws the sprite's minus, not a text glyph");
  assert.equal(rotary.more.innerHTML, "<icon ph-plus>");
  assert.equal(rotary.done.innerHTML, "<icon ph-check>");
  assert.equal(rotary.less.getAttribute("aria-label"), "Shorter");
  assert.equal(rotary.more.getAttribute("aria-label"), "Longer");
  assert.equal(rotary.less.disabled, true, "nothing below Off");
  assert.equal(rotary.more.disabled, false);
  assert.deepEqual(Array.from(rotary.root.children, (c) => c.className.split(" ")[0]), ["keycap", "well", "keycap", "keycap"], "- key, strip, + key, Done");
});

test("a tap on a tick selects it, reports it once, and a tap on the selected tick reports nothing", () => {
  /* MUTATION: delete the tick's click listener -> the first assertion is red; drop
     the `changed &&` guard in select() -> the repeat tap reports a second change. */
  const { rotary, changes } = sleepRotary();
  rotary.ticks[3].click();
  assert.deepEqual(changes, [15]);
  assert.equal(rotary.value(), 15);
  assert.deepEqual(checkedOf(rotary), ["false", "false", "false", "true", "false", "false", "false", "false"]);
  rotary.ticks[3].click();
  assert.deepEqual(changes, [15], "no change, no report");
  assert.equal(rotary.less.disabled, false, "the - key wakes once there is room below");
});

test("the - and + keys step one tick, stop at the ends, and do not drop focus when they disable", () => {
  /* MUTATIONS: remove the `Math.max(0, Math.min(...))` clamp in select() -> the end
     assertions go red; delete the `pair[0].disabled && ticks[index]` focus line ->
     the focus assertion is red (a disabled button cannot hold it). */
  const { rotary, changes, doc } = sleepRotary();
  rotary.more.click();
  rotary.more.click();
  assert.deepEqual(changes, [5, 10]);
  rotary.less.click();
  assert.deepEqual(changes, [5, 10, 5]);
  rotary.less.click();
  assert.equal(rotary.value(), 0);
  assert.equal(rotary.less.disabled, true, "at the bottom the - key is disabled");
  assert.equal(doc.activeElement, rotary.ticks[0], "and focus moved to the selected tick instead of vanishing with it");
  rotary.less.click();
  assert.equal(rotary.value(), 0, "a disabled key does nothing");
  for (let i = 0; i < 12; i += 1) rotary.more.click();
  assert.equal(rotary.value(), 60);
  assert.equal(rotary.more.disabled, true);
  assert.equal(doc.activeElement, rotary.ticks[7]);
});

test("a drag across the strip selects the tick under the finger, with a selection haptic per detent", () => {
  /* MUTATIONS: change `dialRotaryIndexAt`'s `Math.floor` to `Math.ceil` -> the index
     assertions are off by one; delete the `select(...)` call in the pointermove
     listener -> nothing moves (red); delete the `dialHaptic("selection")` in select()
     -> the haptic count is 0 (red). Each pointermove is 150ms apart so the 100ms
     throttle (its own test) lets every detent through. */
  let clock = 1_000_000;
  const { rotary, changes, calls } = sleepRotary({ load: { extra: { Date: { now: () => clock } } } });
  rotary.track.fire("pointerdown", { clientX: 10, pointerId: 7, pointerType: "touch" });
  const move = (x) => { clock += 150; rotary.track.fire("pointermove", { clientX: x, pointerId: 7 }); };
  move(14);
  assert.deepEqual(changes, [], "x=14 is still inside tick 0 (0-44): nothing changed");
  assert.equal(rotary.track.captured, true, "past the 4px threshold the strip owns the pointer");
  move(100);
  assert.equal(rotary.value(), 10, "x=100 is inside tick 2 (88-132)");
  move(175);
  assert.equal(rotary.value(), 15, "x=175 is inside tick 3 (132-176)");
  move(-30);
  assert.equal(rotary.value(), 0, "dragging past the left end holds the first tick");
  assert.deepEqual(changes, [10, 15, 0]);
  assert.equal(calls.filter((c) => c === "sel").length, 3, "one selection haptic per detent that changed");
  rotary.track.fire("pointerup", { clientX: -30, pointerId: 7 });
  assert.equal(rotary.track.captured, false);
});

test("a press that barely moves is a tap, not a drag; and the click that ends a real drag is swallowed", () => {
  /* MUTATIONS: change `< DIAL_ROTARY_DRAG_PX` to `< 0` -> the 3px wobble drags (red);
     delete `api.suppressClick = true` -> the click after the drag re-selects the tick
     it ended on (red). */
  const { rotary, changes } = sleepRotary();
  rotary.track.fire("pointerdown", { clientX: 50, pointerId: 1, pointerType: "touch" });
  rotary.track.fire("pointermove", { clientX: 53, pointerId: 1 });
  rotary.track.fire("pointerup", { clientX: 53, pointerId: 1 });
  assert.deepEqual(changes, [], "3px is a wobble");
  assert.notEqual(rotary.track.captured, true);
  rotary.ticks[1].click();
  assert.deepEqual(changes, [5], "and the tap that follows still lands");
  rotary.track.fire("pointerdown", { clientX: 10, pointerId: 2, pointerType: "touch" });
  rotary.track.fire("pointermove", { clientX: 140, pointerId: 2 });
  rotary.track.fire("pointerup", { clientX: 140, pointerId: 2 });
  assert.equal(rotary.value(), 15, "x=140 is inside tick 3");
  rotary.ticks[0].click();
  assert.equal(rotary.value(), 15, "the click that ends the drag does not undo it");
});

test("the speed chip reads every rung of the ladder truthfully: 0.75x is 0.75x, not 0.8x", () => {
  /* Found driving the dial in a real browser: the chip said "1.8x" for 1.75 and "0.8x" for 0.75.
     MUTATION: put `value.toFixed(1)` back in dialRateText -> "1.8×" and "0.8×" (red). */
  const { dial } = loadDial();
  assert.deepEqual(Array.from([0.75, 1, 1.25, 1.5, 1.75, 2], dial.rateText), ["0.75×", "1.0×", "1.25×", "1.5×", "1.75×", "2.0×"]);
  assert.equal(dial.rateText(undefined), "1.0×", "an unusable rate reads as normal speed");
  assert.equal(dial.rateText(-3), "1.0×");
  const button = { innerHTML: "" };
  const painted = loadDial({ extra: { esc: (s) => String(s) } });
  painted.dial.paintRate(button, 1.75);
  assert.match(button.innerHTML, /1\.75×/, "and the chip is painted with it");
});

test("after a drag ends, focus is on the tick it ended on", () => {
  /* MUTATION: delete the `ticks[index].focus(...)` line in release() -> focus stays where the
     press began (red); the next arrow key would then move from the wrong tick. */
  const { rotary, doc } = sleepRotary();
  rotary.ticks[1].focus();
  rotary.track.fire("pointerdown", { clientX: 60, pointerId: 3, pointerType: "touch" });
  rotary.track.fire("pointermove", { clientX: 160, pointerId: 3 });
  rotary.track.fire("pointerup", { clientX: 160, pointerId: 3 });
  assert.equal(rotary.value(), 15);
  assert.equal(doc.activeElement, rotary.ticks[3]);
});

test("the built view hands the dock everything the rotary needs, so the client can open it", () => {
  /* Found driving it in a real browser: the dial did nothing because the view's returned parts had no
     `row2` (the client's own parts object does not carry it either). `openRotary` is given the
     build's return value alone here, as the client's `ui` is.
     MUTATION: drop `row2: parts.row2` from dialBuildNowPlaying's return -> openRotary returns null (red). */
  const { dial, doc } = loadDial({ extra: { esc: (s) => String(s), tactileIcon: (id) => `<icon ${id}>`, safeUrl: (u) => u } });
  const el = (tag) => doc.createElement(tag);
  const names = ["sheet", "grabZone", "closeBtn", "scroll", "sArt", "sTitle", "sShow", "sWhy", "scrub", "times", "tNow", "tLeft", "row", "backBtn", "bigPlay", "fwdBtn", "clips", "row2", "rateBtn", "openLink", "forayLink", "stopBtn", "nextBtn", "saveBtn", "bookmarkBtn", "queueLink", "note", "sErr", "sDesc"];
  const parts = Object.fromEntries(names.map((n) => [n, el("div")]));
  const built = dial.build(parts);
  assert.ok(built.rotaryHost && built.row2 && built.dock, "the build returns the host, the row it replaces and the dock");
  assert.equal(built.rotaryHost.hidden, true, "closed until opened");
  assert.equal(built.dock.children[2], built.rotaryHost, "the host sits in the dock after the two rows");
  const rotary = dial.openRotary(built, { kind: "rate", label: "Playback speed", stops: [{ value: 1, text: "1×" }, { value: 2, text: "2×" }], value: 1, opener: built.sleepBtn });
  assert.ok(rotary, "opens from the build's return alone");
  assert.equal(built.row2.hidden, true);
  assert.equal(built.rotaryHost.hidden, false);
});

test("arrow keys, Home and End move the selection and keep focus on the selected tick", () => {
  /* MUTATION: delete `event.preventDefault()` in the strip's keydown -> the arrow
     scrolls the page as well (red); swap the ArrowLeft/ArrowRight deltas -> red. */
  const { rotary, changes, doc } = sleepRotary();
  const key = (k) => rotary.track.fire("keydown", { key: k });
  const right = key("ArrowRight");
  assert.equal(right.defaultPrevented, true);
  assert.deepEqual(changes, [5]);
  assert.equal(doc.activeElement, rotary.ticks[1]);
  key("ArrowLeft");
  assert.equal(rotary.value(), 0);
  key("End");
  assert.equal(rotary.value(), 60);
  key("Home");
  assert.equal(rotary.value(), 0);
  key("ArrowLeft");
  assert.equal(rotary.value(), 0, "ArrowLeft on the first tick holds it (MUTATION: drop select()'s clamp -> index -1, red)");
  assert.equal(rotary.ticks[0].getAttribute("aria-checked"), "true");
  key("End");
  key("ArrowRight");
  assert.equal(rotary.value(), 60, "and ArrowRight on the last tick holds it");
  key("Home");
  const other = key("a");
  assert.equal(other.defaultPrevented, false, "other keys are left alone");
});

test("selecting a tick off the visible strip scrolls it into view, and reveal() centres the selection", () => {
  /* MUTATION: delete the `track.scrollLeft = right - track.clientWidth` branch in paint()
     -> the last tick is selected and invisible (red). */
  const { rotary } = sleepRotary();
  rotary.ticks[7].click();
  assert.equal(rotary.track.scrollLeft, 8 * 44 - 176, "the strip scrolls just far enough to show the last tick");
  rotary.ticks[0].click();
  assert.equal(rotary.track.scrollLeft, 0);
  rotary.ticks[5].click();
  rotary.track.scrollLeft = 0;
  rotary.reveal();
  assert.equal(rotary.track.scrollLeft, 5 * 44 - (176 - 44) / 2, "reveal centres the selected tick");
});

test("Escape closes the dial and is stopped before it can collapse the sheet; Done closes it too", () => {
  /* MUTATION: delete `event.stopPropagation()` in the root's keydown -> the sheet owner's
     document listener would also see Escape (red); drop the `done` click listener -> red. */
  const { rotary, done } = sleepRotary();
  const esc = rotary.root.fire("keydown", { key: "Escape" });
  assert.equal(done(), 1);
  assert.equal(esc.stopped, true);
  assert.equal(esc.defaultPrevented, true);
  rotary.done.click();
  assert.equal(done(), 2);
  assert.equal(rotary.done.getAttribute("aria-label"), "Done");
});

test("openRotary swaps the secondary row for the strip, focuses the selected tick, and Done puts the row back and focuses the chip", () => {
  /* MUTATIONS: delete `parts.row2.hidden = true` -> two rows of controls stack (red);
     delete the `rotary.opener.focus` line -> focus is lost to <body> (red);
     remove BOTH the leading `dialCloseRotary(parts, false)` and swap `replaceChildren(rotary.root)`
     for `append(rotary.root)` -> a second open stacks a second strip (the double-open assertion
     goes red; either change alone is covered by the other, so one alone survives). */
  const { dial, doc } = loadDial();
  const el = (tag) => doc.createElement(tag);
  const parts = { rotaryHost: el("div"), row2: el("div"), dock: el("div") };
  parts.rotaryHost.hidden = true;
  const chip = el("button");
  const changes = [];
  const open = () => dial.openRotary(parts, { kind: "sleep", label: "Sleep timer", stops: dial.sleepStops(), value: 15, opener: chip, onChange: (v) => changes.push(v) });
  const rotary = open();
  assert.equal(parts.row2.hidden, true);
  assert.equal(parts.rotaryHost.hidden, false);
  assert.ok(parts.dock.classList.contains("np__dock--dial"));
  assert.equal(parts.rotaryHost.children[0], rotary.root);
  assert.equal(doc.activeElement, rotary.ticks[3], "focus lands on the selected tick (15 min)");
  const again = open();
  assert.notEqual(again, rotary, "opening again builds a fresh strip");
  assert.equal(parts.rotaryHost.children.length, 1, "and replaces the old one rather than stacking");
  /* sync from outside (the timer ran out) moves the strip without reporting a change */
  dial.syncRotary(parts, "sleep", 0);
  assert.equal(again.value(), 0);
  assert.deepEqual(changes, [], "a sync is not a user change");
  dial.syncRotary(parts, "rate", 1.5);
  assert.equal(again.value(), 0, "a sync for the other kind is ignored");
  again.done.click();
  assert.equal(parts.row2.hidden, false);
  assert.equal(parts.rotaryHost.hidden, true);
  assert.equal(parts.rotaryHost.children.length, 0);
  assert.ok(!parts.dock.classList.contains("np__dock--dial"));
  assert.equal(doc.activeElement, chip, "focus returns to the chip that opened the dial");
  assert.equal(parts.rotary, null);
  assert.equal(dial.closeRotary(parts, true), false, "closing nothing says so");
});

test("rotaryIndexAt clamps to the strip and survives a strip with no width", () => {
  /* MUTATION: drop the `Math.min(count - 1, ...)` -> a drag past the right end indexes a tick that does not exist. */
  const { dial } = loadDial();
  assert.equal(dial.rotaryIndexAt(0, 44, 8), 0);
  assert.equal(dial.rotaryIndexAt(43.9, 44, 8), 0);
  assert.equal(dial.rotaryIndexAt(44, 44, 8), 1);
  assert.equal(dial.rotaryIndexAt(9999, 44, 8), 7);
  assert.equal(dial.rotaryIndexAt(-50, 44, 8), 0);
  assert.equal(dial.rotaryIndexAt(100, 0, 8), 0, "a strip that has not been laid out selects the first tick");
  assert.equal(dial.rotaryIndexAt(100, 44, 0), 0);
});

test("the speed and sleep chips open the rotary; the list picker is only the no-Dial fallback", () => {
  /* The client cannot load under node, so this pins the wiring as text (the
     suite's header names that limit). MUTATION: put `openRatePicker()` back in
     the rateBtn click listener -> red (the chip opens the modal list again);
     put the `setSleepTimer(window.DialNowPlaying?.nextSleepStop` cycle back -> red. */
  assert.match(FLAT_TEXT, /ui\.rateBtn\.addEventListener\("click", \(\) => openRotary\("rate"\)\)/);
  assert.match(FLAT_TEXT, /ui\.sleepBtn\.addEventListener\("click", \(\) => openRotary\("sleep"\)\)/);
  assert.doesNotMatch(FLAT_TEXT, /nextSleepStop/);
  assert.match(FLAT_TEXT, /if \(!dial\?\.openRotary \|\| !ui\?\.rotaryHost\) \{ openRatePicker\(\); return; \}/, "the list picker survives only when the Dial view is absent");
  assert.match(FLAT_TEXT, /stops: RATES\.map\(\(r\) => \(\{ value: r, text: rateLabel\(r\)/, "speed ticks are the app's own ladder");
  assert.match(FLAT_TEXT, /onChange: \(value\) => \{ applyRate\(value\); \}/);
  assert.match(FLAT_TEXT, /onChange: \(value\) => \{ setSleepTimer\(value\); \}/);
  assert.match(FLAT_TEXT, /if \(!open\) window\.DialNowPlaying\?\.closeRotary\?\.\(ui, false\)/, "collapsing the sheet closes the dial");
  assert.match(FLAT_TEXT, /syncRotary\?\.\(ui, "rate", normalizeRate\(rate\)\)/);
  assert.match(FLAT_TEXT, /syncRotary\?\.\(ui, "sleep", 0\)/);
});

test("the rotary keeps its measurements: 56px well, 44px ticks and keys, 2px tick marks, the row it replaces really hides", () => {
  /* MUTATIONS: change `.np-rotary .rotary__track`'s height from var(--key-lg) -> red; the
     tick's width from var(--tap) -> red; delete `.np .fp-row2.second[hidden]` -> red (the
     row's own display:flex would beat the hidden attribute and both rows would show). */
  assert.match(CSS_RULES, /\.np-rotary \.rotary__track \{[^}]*height:\s*var\(--key-lg\)/);
  assert.match(CSS_RULES, /\.np-rotary \.rotary__tick \{[^}]*flex:\s*0 0 var\(--tap\)[^}]*width:\s*var\(--tap\)[^}]*min-width:\s*var\(--tap\)/);
  assert.match(CSS_RULES, /\.np__dial \.keycap--sm \{[^}]*min-width:\s*var\(--tap\)[^}]*min-height:\s*var\(--tap\)/);
  assert.match(CSS_RULES, /\.np-rotary \.rotary__tick::before \{[^}]*width:\s*2px[^}]*height:\s*14px/);
  assert.match(CSS_RULES, /\.np \.fp-row2\.second\[hidden\], \.np__dial\[hidden\] \{ display: none; \}/);
  assert.match(CSS_RULES, /\.np-rotary \.rotary__track \{[^}]*touch-action:\s*pan-y/);
  assert.match(NP_FLAT_TEXT, /dock\.append\(parts\.row, parts\.row2, rotaryHost\)/);
});

test("the band's station codes are HTML spans under the bars, and the SVG's own squeezed codes are hidden", () => {
  /* MUTATION: delete `.np__band-svg .t-band__code` from the display:none rule ->
     the squeezed SVG codes and the spans both show ("BR BR" doubled). */
  assert.match(NP_FLAT_TEXT, /dialNpEl\("div", "np__codes"\)/);
  assert.match(NP_FLAT_TEXT, /span\.style\.setProperty\("--x"/);
  assert.match(CSS_RULES, /\.np__band-svg \.t-band__code, \.np__band-svg \.needle \{ display: none; \}/);
  assert.match(CSS_RULES, /\.np:not\(\.np--foray\) \.np__codes \{ display: none; \}/, "an episode has one bar and no codes");
});

test("every run on the band gets a code, narrow ones included, and no two codes overlap", () => {
  /* Iteration 2 (fidelity): the first purple run was 14px wide, under the primitive's 24px gate, so colour alone
     carried it ("one code per run, so colour is never alone").
     MUTATIONS: drop `codeEveryRun: true` from the tactileBand call -> the narrow runs lose their code (the
     source check fails); make dialSpreadCodes return its input -> the overlap assertion fails; drop the
     right-to-left pass -> the clamp case fails. */
  assert.match(NP_FLAT_TEXT, /valueText: d\.valueText, codeEveryRun: true/);
  assert.match(CSS_RULES, /\.np__code \{[^}]*left:\s*calc\(var\(--x, 0\) \* 100% \+ var\(--dx, 0px\)\)/);
  const { dial } = loadDial();
  const size = 14;
  const gap = dial.codeGap;
  /* The real case: bar centres 7px apart on a 345px band (adjacent 14px runs at the left edge). */
  const crowded = [7, 21, 35, 52, 140, 200];
  const placed = dial.spreadCodes(crowded, crowded.map(() => size), 345);
  for (let i = 1; i < placed.length; i += 1) assert.ok(placed[i] - placed[i - 1] >= size + gap - 1e-9, `codes ${i - 1} and ${i} are ${placed[i] - placed[i - 1]}px apart (a ${size}px code plus its ${gap}px of air)`);
  assert.ok(placed[0] >= size / 2, "the first code stays inside the band's left edge");
  assert.ok(placed[2] <= 7 + 2 * (size + gap) + 1e-9, "a code is moved only as far as its neighbours force: the third sits two pitches from the first");
  assert.strictEqual(placed[5], 200, "an uncrowded code does not move");
  /* Crowding at the right edge pushes back in, not out of the box. */
  const edge = dial.spreadCodes([330, 338, 344], [size, size, size], 345);
  assert.ok(edge[2] <= 345 - size / 2, `the last code stays inside the right edge (${edge[2]})`);
  for (let i = 1; i < edge.length; i += 1) assert.ok(edge[i] - edge[i - 1] >= size + gap - 1e-9, "and they still keep their air");
  /* More codes than fit (30 x 14px on 345px): they stay ordered and inside the box rather than running off it.
     MUTATION: drop the final clamp loop -> the last code lands past the right edge. */
  const many = Array.from({ length: 30 }, (_, i) => 7 + i * 11);
  const squeezed = dial.spreadCodes(many, many.map(() => size), 345);
  assert.ok(squeezed[0] >= size / 2 && squeezed[29] <= 345 - size / 2, `inside the box (${squeezed[0]}..${squeezed[29]})`);
  for (let i = 1; i < squeezed.length; i += 1) assert.ok(squeezed[i] >= squeezed[i - 1], "and still in order");
});

test("a crowded code row drops the narrowest run's code instead of cramming it, and never the current run's", () => {
  /* Iteration 3 (fidelity): nine codes on one 345px line, the first four about 20px apart, read as a caption, not
     as dial labels. Codes now sit a DIAL_CODE_GAP of air apart; a code that cannot get it within DIAL_CODE_SHIFT of its
     own bar loses its label, the narrowest run first. The fixture is the shipped foray's nine runs.
     MUTATIONS: make dialFitCodes return all-true -> the "some are dropped" assertion fails (the row is cramped again);
     drop the `!current[...]` filter from the pool -> the current-run assertion fails; take the widest run as the victim
     (`<` -> `>` in the reduce) -> the narrow-end assertion fails. */
  const { dial } = loadDial();
  const size = 14;
  const centres = [15, 34, 58, 86, 126, 171, 231, 301, 340];
  const runPx = [16, 18, 12, 16, 22, 24, 40, 30, 14];
  const none = centres.map(() => false);
  const kept = dial.fitCodes(centres, centres.map(() => size), runPx, none, 345);
  assert.ok(kept.some((k) => !k), "fixture premise: nine codes cannot all get their air, so some are dropped");
  const shown = centres.filter((c, i) => kept[i]);
  const placed = dial.spreadCodes(shown, shown.map(() => size), 345);
  for (let i = 1; i < placed.length; i += 1) assert.ok(placed[i] - placed[i - 1] >= size + dial.codeGap - 0.01, `kept codes ${i - 1} and ${i} have their air`);
  placed.forEach((x, i) => assert.ok(Math.abs(x - shown[i]) <= dial.codeShift + 0.01, `code ${i} stays within ${dial.codeShift}px of its bar`));
  const droppedWidths = runPx.filter((w, i) => !kept[i]);
  assert.ok(droppedWidths.every((w) => w <= 22), "what is dropped is a narrow run, never the 40px one");
  assert.strictEqual(kept[6], true, "the widest run keeps its code");
  /* Three codes jammed together, widths 30 / 10 / 20: the 10px run is the one that goes (the fixture above drops
     only from a pool that never holds the widest run, so it cannot tell narrowest-first from widest-first). */
  assert.deepStrictEqual(dial.fitCodes([100, 110, 120], [size, size, size], [30, 10, 20], [false, false, false], 345), [true, false, true]);
  /* The current run keeps its code even when it is the narrowest of the crowd. */
  const current = centres.map((c, i) => i === 2);
  const keptCurrent = dial.fitCodes(centres, centres.map(() => size), runPx, current, 345);
  assert.strictEqual(keptCurrent[2], true, "the current run's code is never the one dropped");
  /* An uncrowded row loses nothing (the prototype's five codes). */
  const sparse = [60, 140, 220, 300];
  assert.deepStrictEqual(dial.fitCodes(sparse, sparse.map(() => size), [50, 50, 50, 50], sparse.map(() => false), 345), [true, true, true, true]);
});

test("the needle has a 44px-wide hit area, a 2px stroke, and its buffering pulse runs on the buffer token", () => {
  /* MUTATION: change `.np__needle`'s width from 44px -> red; put a literal `1s` back
     in the pulse -> red here and in ui-tokens-dial. */
  assert.match(CSS_RULES, /\.np__needle \{[^}]*width:\s*44px/);
  assert.match(CSS_RULES, /\.np__needle::before \{[^}]*width:\s*2px/);
  assert.match(CSS_RULES, /\.np__needle\.is-buffering \{ animation: np-needle-pulse var\(--d-buffer\)/);
});

test("the foray detail list is headed Clips, not the pipeline word", () => {
  /* The listener-copy rules ban "segment" (build-loop.md section 2).
     MUTATION: put "Segments" back in the heading -> red. */
  assert.match(NP_FLAT_TEXT, /dialNpEl\("h2", "heading", "Clips"\)/);
  assert.doesNotMatch(NP_FLAT_TEXT, /dialNpEl\("h2", "heading", "Segments"\)/);
});

/* ==================================================================== */
/* The open transition's WAAPI fallback, run — and the tint, run         */
/* ==================================================================== */

/** Elements for the transition: the mini's artwork (a fixed rect) and the hero's (a rect that is only real once `commit` has put the sheet on screen). */
function transitionFixture({ reduce = false, heroRect = { left: 40, top: 120, width: 280, height: 280 } } = {}) {
  const state = { committed: false, animations: [], frames: 0 };
  const miniArt = { getBoundingClientRect: () => ({ left: 16, top: 700, width: 44, height: 44 }) };
  const heroArt = {
    getBoundingClientRect: () => (state.committed ? heroRect : { left: 0, top: 0, width: 0, height: 0 }),
    animate: (frames, options) => { state.animations.push({ frames, options, committedAtCall: state.committed }); },
  };
  const loaded = loadDial({
    extra: {
      matchMedia: (query) => ({ matches: reduce && /prefers-reduced-motion/.test(query) }),
      requestAnimationFrame: (fn) => { state.frames += 1; fn(); },
    },
  });
  const commit = () => { state.committed = true; };
  return { ...loaded, state, miniArt, heroArt, commit };
}

test("the WAAPI fallback animates the hero from the mini's rect, after the sheet is committed", () => {
  /* MUTATIONS (each run and seen red): replace `target.animate([...], {...})` with a no-op
     expression -> `animations.length` is 0; run the animate BEFORE `commit()` -> the hero's
     rect is still zero-sized and the guard bails (0 animations, and `committedAtCall` would
     be false); swap `first.left - last.left` for `last.left - first.left` -> the translate
     is +24px instead of -24px; change `duration: 480` -> red. The source-text half of this
     (`typeof target.animate !== "function"`) is in the test above and could not catch the first. */
  const { dial, state, miniArt, heroArt, commit } = transitionFixture();
  dial.transition(true, miniArt, heroArt, commit);
  assert.equal(state.committed, true, "the open is committed (never awaited on the animation)");
  assert.equal(state.animations.length, 1, "animate() was called once on the hero artwork");
  const [{ frames, options, committedAtCall }] = state.animations;
  assert.equal(committedAtCall, true, "measured and animated after the sheet is on screen");
  assert.equal(frames.length, 2);
  assert.match(frames[0].transform, /^translate\(-24px,580px\) scale\(0\.157\d*,0\.157\d*\)$/, "starts where the mini's art is: 16-40 = -24 across, 700-120 = 580 down, 44/280 of the size");
  assert.equal(frames[0].transformOrigin, "top left");
  assert.equal(frames[1].transform, "none", "and ends at rest");
  assert.equal(options.duration, 480);
  assert.equal(options.fill, "both");
  assert.equal(state.frames, 1, "one animation frame between commit and measure");
});

test("the WAAPI fallback does nothing under reduced motion, and nothing for an element that has no box", () => {
  /* MUTATIONS: delete the `if (reduce) { commit(); return; }` line -> the reduced-motion
     case animates (red); delete the zero-size guard (`!last.width || ...`) -> the
     no-box case calls animate with NaN scales (red). */
  const reduced = transitionFixture({ reduce: true });
  reduced.dial.transition(true, reduced.miniArt, reduced.heroArt, reduced.commit);
  assert.equal(reduced.state.committed, true, "reduced motion still commits");
  assert.equal(reduced.state.animations.length, 0, "and moves nothing");
  const boxless = transitionFixture({ heroRect: { left: 0, top: 0, width: 0, height: 0 } });
  boxless.dial.transition(true, boxless.miniArt, boxless.heroArt, boxless.commit);
  assert.equal(boxless.state.committed, true);
  assert.equal(boxless.state.animations.length, 0, "an unmeasurable hero is not animated into NaN");
});

test("artwork is averaged in linear light, not in encoded bytes", () => {
  /* BUILD-NOTES 7: "average in linear light". The first build summed the sRGB bytes and
     converted once at the end, which darkens every mixed colour.
     Half-white, half-black: linear light averages to 0.5; the bytes' average (127.5) is
     0.214 in linear light. MUTATION: sum `pixels[i]` instead of `dialSrgbToLinear(pixels[i])`
     in dialAverageLinear -> 0.2140 comes back and the first assertion is red. */
  const { dial } = loadDial();
  const px = (r, g, b, a = 255) => [r, g, b, a];
  const flat = (...pixels) => Uint8ClampedArray.from(pixels.flat());
  const grey = dial.averageLinear(flat(px(255, 255, 255), px(0, 0, 0)));
  grey.forEach((channel) => assert.ok(Math.abs(channel - 0.5) < 1e-9, `linear mean of white and black is 0.5, got ${channel}`));
  assert.ok(Math.abs(0.5 - 0.2140) > 0.28, "premise: the encoded mean would read 0.214, far from 0.5");
  const withClear = dial.averageLinear(flat(px(255, 255, 255), px(0, 0, 0, 0)));
  assert.deepEqual(Array.from(withClear), [1, 1, 1], "a transparent pixel does not dilute the mean");
  assert.equal(dial.averageLinear(flat(px(10, 20, 30, 0))), null, "nothing opaque to average");
  assert.equal(dial.tintFromPixels(flat(px(10, 20, 30, 0)), "ENAMEL"), "ENAMEL", "and the tint is then the show's enamel");
});

test("the extraction path turns a half-red, half-black cover into a mid-lightness red, not a muddy dark one", async () => {
  /* The whole path, run: Image load -> 32x32 canvas -> getImageData -> tint. Half pure red,
     half black: in linear light the red channel is 0.5, OKLCH lightness 0.498, inside the
     0.45-0.6 clamp, so it comes out at 0.498. Averaged in bytes it would be 0.375, which the
     clamp would pull up to a flat 0.450.
     MUTATION: in dialAverageLinear sum the raw bytes (no dialSrgbToLinear) -> the lightness
     below is 0.450 and the first assertion is red. */
  const data = new Uint8ClampedArray(32 * 32 * 4);
  for (let i = 0; i < 32 * 32; i += 1) {
    data[i * 4] = i < 512 ? 255 : 0;
    data[i * 4 + 3] = 255;
  }
  const reads = [];
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: (img, x, y, w, h) => reads.push(["draw", w, h]), getImageData: (x, y, w, h) => { reads.push(["read", w, h]); return { data }; } }) };
  class FakeImage {
    set src(value) { this.loaded = value; Promise.resolve().then(() => this.onload()); }
  }
  const { dial, doc } = loadDial({ extra: { Image: FakeImage, safeUrl: (url) => url } });
  const create = doc.createElement;
  doc.createElement = (tag) => (tag === "canvas" ? canvas : create(tag));
  const tint = await dial.extractArtworkTint("https://example.test/cover.jpg", "show-1", "ENAMEL");
  assert.deepEqual(reads, [["draw", 32, 32], ["read", 32, 32]], "sampled at 32 x 32");
  const lightness = Number(/^oklch\(([\d.]+) /.exec(tint)?.[1]);
  assert.ok(lightness > 0.49 && lightness < 0.51, `linear-light lightness (0.498), not the clamped byte average (0.450): ${tint}`);
  assert.match(tint, /^oklch\(0\.\d{3} 0\.\d{3} \d+\.\d\)$/);
  const fallback = await dial.extractArtworkTint("", "show-1", "ENAMEL");
  assert.equal(fallback, "ENAMEL", "no usable URL is the show's enamel");
});
