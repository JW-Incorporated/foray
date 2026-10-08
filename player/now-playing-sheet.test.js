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
  assert.match(NP_FLAT, /artWrap\.append\(parts\.sArt, collage, downloadedBadge\); hero\.append\(artWrap\);/);
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
  assert.match(CSS_RULES, /\.np \.transport \.keycap--lg \{[^}]*width:\s*var\(--key-lg\)[^}]*height:\s*var\(--key-lg\)/);
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
  assert.match(CSS_RULES, /\.np__top \{[^}]*min-height:\s*calc\(100% - 176px - var\(--safe-b\)\)/);
  assert.match(CSS_RULES, /\.np__dock \{[^}]*position:\s*absolute[^}]*bottom:\s*calc\(var\(--safe-b\) \+ var\(--s-4\)\)/);
  assert.match(CSS_RULES, /\.np__dock::before \{[^}]*linear-gradient\(to bottom, transparent, var\(--paper\) 28px\)/);
  assert.match(CSS_RULES, /\.np \.segrow \{[^}]*min-height:\s*56px/);
  assert.match(CSS_RULES, /\.np__chapter \{[^}]*min-height:\s*48px/);
});

test("Tactile transport uses circular 56/80/56 keys with an attached darker lip and custom skip marks", () => {
  /* MUTATION: remove the explicit `width: var(--key-lg)` override -> red and legacy padding squashes the skip keys. */
  assert.match(CSS_RULES, /\.np \.transport \.keycap--lg \{\s*box-sizing:\s*border-box;\s*width:\s*var\(--key-lg\)[^}]*height:\s*var\(--key-lg\)[^}]*padding:\s*0/);
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
  /* MUTATION: delete `target.animate` from the fallback -> red. */
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

function loadDial({ ink = "#201a17", paper = "#f7f0e4", dark = false, haptics = null } = {}) {
  const calls = [];
  const window = { Capacitor: haptics ? { Plugins: { Haptics: haptics(calls) } } : undefined };
  const root = { dataset: {} };
  const context = {
    window,
    document: { documentElement: root, createElement() { throw new Error("no DOM in this harness"); } },
    getComputedStyle: () => ({ getPropertyValue: (name) => (name === "--ink" ? ink : name === "--paper" ? paper : "") }),
    matchMedia: () => ({ matches: dark }),
    Date,
    Math,
  };
  vm.createContext(context);
  vm.runInContext(NOW_PLAYING, context, { filename: "ui/now-playing.js" });
  return { dial: window.DialNowPlaying, calls };
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

test("the sleep chip steps Off, 15, 30, 45, 60 and back to Off", () => {
  /* MUTATION: drop 60 from DIAL_SLEEP_STOPS -> the walk ends early and fails. */
  const { dial } = loadDial();
  const walk = [0];
  for (let i = 0; i < 5; i += 1) walk.push(dial.nextSleepStop(walk[walk.length - 1]));
  assert.deepEqual(walk, [0, 15, 30, 45, 60, 0]);
  assert.equal(dial.nextSleepStop(7), 0, "an unknown value falls back to Off rather than sticking");
});

test("the band's station codes are HTML spans under the bars, and the SVG's own squeezed codes are hidden", () => {
  /* MUTATION: delete `.np__band-svg .t-band__code` from the display:none rule ->
     the squeezed SVG codes and the spans both show ("BR BR" doubled). */
  assert.match(NP_FLAT_TEXT, /dialNpEl\("div", "np__codes"\)/);
  assert.match(NP_FLAT_TEXT, /span\.style\.setProperty\("--x"/);
  assert.match(CSS_RULES, /\.np__band-svg \.t-band__code, \.np__band-svg \.needle \{ display: none; \}/);
  assert.match(CSS_RULES, /\.np:not\(\.np--foray\) \.np__codes \{ display: none; \}/, "an episode has one bar and no codes");
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

test("the sampled artwork tint is cached in memory for the session and never written to storage", async () => {
  /* Review fix (Redesign 2026, search review 0f70a7fc): a `cp_art_tint:<show>`
     row per show played would need a privacy-policy row and a data-deletion
     count for a colour the page can recompute. The harness answers like the
     real thing: the Image loads asynchronously, the canvas returns real
     pixels, and storage is a spy on every route (lsSet/lsGet and the
     localStorage object itself).
     MUTATION: add `lsSet("cp_art_tint:" + key, JSON.stringify({ hash: hash, tint: tint }));`
     after `DIAL_ART_TINT_CACHE[key] = ...` in dialExtractArtworkTint -> the
     storage assertion goes red; delete the `DIAL_ART_TINT_CACHE[key] = ...`
     line -> the second call builds a second Image and the count goes red. */
  const writes = [];
  let images = 0;
  class FakeImage {
    set src(value) { images += 1; this._src = value; Promise.resolve().then(() => this.onload && this.onload()); }
  }
  const pixels = new Uint8ClampedArray(32 * 32 * 4);
  for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 200; pixels[i + 1] = 40; pixels[i + 2] = 30; pixels[i + 3] = 255; }
  const canvas = { getContext: () => ({ drawImage() {}, getImageData: () => ({ data: pixels }) }) };
  const window = {};
  const context = {
    window,
    Image: FakeImage,
    safeUrl: (url) => url,
    lsSet: (...args) => { writes.push(["lsSet", ...args]); return true; },
    lsGet: (...args) => { writes.push(["lsGet", ...args]); return null; },
    localStorage: { setItem: (...args) => writes.push(["setItem", ...args]), getItem: (...args) => { writes.push(["getItem", ...args]); return null; } },
    document: { documentElement: { dataset: {} }, createElement: (tag) => (tag === "canvas" ? canvas : {}) },
    Math,
    Date,
  };
  vm.createContext(context);
  vm.runInContext(NOW_PLAYING, context, { filename: "ui/now-playing.js" });
  const first = await window.DialNowPlaying.extractArtworkTint("https://example.test/a.jpg", "show-1", "ENAMEL");
  assert.match(first, /^oklch\(/, "a saturated sample produces a tint, not the fallback");
  const second = await window.DialNowPlaying.extractArtworkTint("https://example.test/a.jpg", "show-1", "ENAMEL");
  assert.equal(second, first, "the same show and artwork is served from memory");
  assert.equal(images, 1, "the image was sampled once, not once per call");
  assert.deepEqual(writes, [], "no storage route was touched: no cp_art_tint key exists");
  assert.doesNotMatch(NOW_PLAYING, /cp_art_tint/, "and the key is not named in the view at all");
});

test("sleep expiry pauses through the transport authority, so a stale reducer cannot leave audio playing", () => {
  /* MUTATION: change `transportIsRunning()` back to `isRunning()` in setSleepTimer's callback (client.js) ->
     the belief says "paused" while the element is audible, setRunning(false) is never called and the
     pause assertion fails (the timer reset to Off and the audio kept going). */
  const m = /^let sleepMinutes = 0;\nlet sleepTimer = null;\nfunction setSleepTimer\(minutes\) \{[\s\S]*?\n\}/m.exec(CLIENT);
  assert.ok(m, "client.js still declares the sleep timer at top level");
  const run = ({ believed, audible }) => {
    const timers = [];
    const calls = [];
    const painted = [];
    const context = {
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      clearTimeout: () => {},
      Math, Number,
      isRunning: () => believed,
      transportIsRunning: () => believed || audible,
      setRunning: (want, source) => { calls.push([want, source]); },
      ui: { sleepBtn: {} },
      window: { DialNowPlaying: { paintSleep: (_btn, minutes) => painted.push(minutes) } },
    };
    vm.createContext(context);
    vm.runInContext(m[0] + "\nvar __set = setSleepTimer;", context, { filename: "player/client.js (setSleepTimer)" });
    context.__set(15);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 15 * 60 * 1000);
    timers[0].fn();
    return { calls, painted };
  };
  const stale = run({ believed: false, audible: true });
  assert.deepEqual(stale.calls, [[false, "sleep"]], "audible while the reducer says paused: expiry still pauses");
  assert.deepEqual(stale.painted, [15, 0], "and the chip returns to Off");
  const quiet = run({ believed: false, audible: false });
  assert.deepEqual(quiet.calls, [], "nothing audible: expiry has nothing to pause");
  assert.deepEqual(quiet.painted, [15, 0]);
  const live = run({ believed: true, audible: true });
  assert.deepEqual(live.calls, [[false, "sleep"]]);
});

/* ==================================================================== */
/* NOW PLAYING, EPISODE (Tactile group A): tint, chips, detail, session  */
/* ==================================================================== */

/** ui/now-playing.js in a context that also holds the REAL primitives (tactileTag,
    esc, safeUrl, all lifted from the shipping files by the helper), so a tag
    is the one the app draws and not a stand-in. */
function loadDialWithPrimitives(extra = {}) {
  const { load } = __cr(import.meta.url)("../test/helpers/tactile-primitives.js");
  const window = {};
  const context = load({ window, document: { documentElement: { dataset: {} } }, Date, ...extra });
  vm.runInContext(NOW_PLAYING, context, { filename: "ui/now-playing.js" });
  return { dial: window.DialNowPlaying, context };
}

const px = (...rgba) => {
  const out = new Uint8ClampedArray(rgba.length * 4);
  rgba.forEach((p, i) => out.set(p.length === 3 ? [...p, 255] : p, i * 4));
  return out;
};
const oklchParts = (text) => {
  const m = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(text);
  return m ? { l: Number(m[1]), c: Number(m[2]), h: Number(m[3]) } : null;
};
/** An independent OKLCH -> linear sRGB, so the gamut check is not the code under test's own. */
const oklchToLinear = ({ l, c, h }) => {
  const a = c * Math.cos(h * Math.PI / 180), b = c * Math.sin(h * Math.PI / 180);
  const L = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const M = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const S = (l - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S, -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S, -0.0041960863 * L - 0.7034186147 * M + 1.7076147010 * S];
};

test("the artwork tint averages in LINEAR light: a half-red, half-black cover reads L 0.498, not the muddy 0.45 floor", () => {
  /* BUILD-NOTES 7: "average in linear light". Averaging the encoded bytes (127.5
     red) and converting after reads L .376, which the clamp lifts to .450.
     The samples go through the real extraction function, not a pre-built colour.
     The two colours are the extremes of each channel (0 and 255), so only the ORDER of
     averaging and linearising can move the answer: summing raw bytes (`sum[i] += pixels[i]`) and
     linearising once after the divide (`dialSrgbToLinear(v / count)`), the first build's defect, reads
     0.450 here and this fails (run). Substituting a different transfer curve is NOT caught by this
     test, and is not claimed to be. */
  const { dial } = loadDial();
  const half = new Uint8ClampedArray(32 * 32 * 4);
  for (let i = 0; i < 32 * 32; i += 1) half.set(i % 2 ? [255, 0, 0, 255] : [0, 0, 0, 255], i * 4);
  const tint = oklchParts(dial.tintFromPixels(half, "ENAMEL"));
  assert.ok(tint, "a saturated cover produces a tint, not the enamel");
  assert.equal(tint.l, 0.498, "linear-light average of red and black");
});

test("a grey cover (chroma under 0.07) and a cover with no opaque pixel both fall back to the show's enamel", () => {
  /* MUTATION: change the `.07` threshold in dialNormalizeArtworkTint to `.0` -> the grey cover is tinted
     grey and the first assertion fails; remove the `linear ?` guard in dialTintFromPixels -> an all-transparent
     cover throws instead of returning the enamel. */
  const { dial } = loadDial();
  assert.equal(dial.tintFromPixels(px([128, 128, 128], [130, 128, 126]), "ENAMEL"), "ENAMEL", "grey average");
  assert.equal(dial.tintFromPixels(px([200, 30, 30, 0], [30, 30, 200, 100]), "ENAMEL"), "ENAMEL", "every pixel under half alpha");
  assert.equal(dial.tintFromPixels(new Uint8ClampedArray(0), "ENAMEL"), "ENAMEL", "no pixels at all");
});

test("chroma 0.05 at hue 320 is the enamel and chroma 0.08 is exactly 0.10; lightness stays inside 0.45-0.6", () => {
  /* The acceptance pair, through the same normaliser the extractor uses.
     MUTATION: change `.07` to `.04` (the prototype's old floor) -> the 0.05 case is tinted and fails; change
     `Math.max(.1, oklch.c)` to `Math.max(.07, oklch.c)` -> 0.08 stays 0.080 and fails. */
  const { dial } = loadDial();
  assert.equal(dial.normalizeArtworkTint({ l: 0.5, c: 0.05, h: 320 }, "ENAMEL"), "ENAMEL");
  assert.equal(dial.normalizeArtworkTint({ l: 0.5, c: 0.08, h: 320 }, "ENAMEL"), "oklch(0.500 0.100 320.0)");
  assert.equal(dial.normalizeArtworkTint({ l: 0.95, c: 0.12, h: 320 }, "ENAMEL"), "oklch(0.600 0.120 320.0)", "light is clamped down");
  assert.equal(dial.normalizeArtworkTint({ l: 0.1, c: 0.12, h: 320 }, "ENAMEL"), "oklch(0.450 0.120 320.0)", "dark is clamped up");
});

test("a saturated cover's chroma is walked down only as far as sRGB needs, and the WRITTEN colour is inside the gamut", () => {
  /* BUILD-NOTES 7. rgb(63,111,255) wants chroma .221 at L .594, which is 1.004 in the blue channel: out of
     gamut once serialised. The check reads the string that is written (three decimals), with an
     independent conversion.
     MUTATIONS: make dialFitChroma return `C` unchanged -> the written blue channel is 1.0039 and the
     gamut assertion fails; floor to 2 decimals instead of 3 -> the "only as far as needed" assertion
     (the tint must use at least 99% of the in-gamut chroma) fails; return `Math.round` instead of floor -> the rounded
     chroma crosses the edge on a case here and the gamut assertion fails. */
  const { dial } = loadDial();
  for (const rgb of [[63, 111, 255], [0, 255, 0], [255, 0, 0], [255, 0, 255], [0, 200, 255], [255, 140, 0]]) {
    const cover = new Uint8ClampedArray(32 * 32 * 4);
    for (let i = 0; i < 32 * 32; i += 1) cover.set([...rgb, 255], i * 4);
    const text = dial.tintFromPixels(cover, "ENAMEL");
    const tint = oklchParts(text);
    assert.ok(tint, `${rgb}: a saturated cover is a tint (${text})`);
    assert.ok(tint.l >= 0.45 && tint.l <= 0.6, `${rgb}: lightness ${tint.l} is clamped`);
    for (const channel of oklchToLinear(tint)) {
      assert.ok(channel >= -2e-4 && channel <= 1 + 2e-4, `${rgb}: ${text} has a channel at ${channel}, outside sRGB`);
    }
    /* "Only as far as needed": a hair more chroma (0.003) would be outside the gamut. */
    const more = oklchToLinear({ ...tint, c: tint.c + 0.003 });
    assert.ok(more.some((channel) => channel < -2e-4 || channel > 1 + 2e-4) || tint.c >= 0.1 && tint.c <= 0.1001, `${rgb}: ${text} left chroma on the table`);
  }
});

test("a cover that cannot be read (CORS or a broken image) uses the enamel, asks anonymously, and a cached colour is not re-fetched", async () => {
  /* The harness answers like the browser: the image loads or errors asynchronously, a tainted canvas
     THROWS from getImageData, and crossOrigin is read off the instance.
     MUTATIONS: remove `image.crossOrigin = "anonymous"` -> the first assertion fails; change the catch's
     `resolve(fallback)` to `resolve("oklch(0.5 0.2 30)")` -> the tainted case fails; remove the `onerror` line
     -> the broken-image promise never settles (the test times out); cache the fallback by deleting the
     `if (cached` guard's hash check -> the changed-artwork assertion fails. */
  const make = ({ taint = false, fail = false, pixels = null } = {}) => {
    const created = [];
    class FakeImage {
      set src(value) { created.push(this); this._src = value; Promise.resolve().then(() => (fail ? this.onerror() : this.onload())); }
    }
    const data = pixels || (() => { const p = new Uint8ClampedArray(32 * 32 * 4); for (let i = 0; i < p.length; i += 4) p.set([40, 90, 200, 255], i); return p; })();
    const canvas = { getContext: () => ({ drawImage() {}, getImageData() { if (taint) throw new DOMException("tainted", "SecurityError"); return { data }; } }) };
    const window = {};
    const context = {
      window, Image: FakeImage, safeUrl: (url) => (/^https:/.test(url) ? url : "#"), DOMException,
      document: { documentElement: { dataset: {} }, createElement: (tag) => (tag === "canvas" ? canvas : {}) }, Math, Date,
    };
    vm.createContext(context);
    vm.runInContext(NOW_PLAYING, context, { filename: "ui/now-playing.js" });
    return { dial: window.DialNowPlaying, created };
  };
  const ok = make();
  const tint = await ok.dial.extractArtworkTint("https://example.test/a.jpg", "show-a", "ENAMEL");
  assert.match(tint, /^oklch\(/);
  assert.equal(ok.created[0].crossOrigin, "anonymous", "the image is requested with CORS, or the canvas could never be read");
  assert.equal(await ok.dial.extractArtworkTint("https://example.test/a.jpg", "show-a", "ENAMEL"), tint, "cached by show and artwork");
  assert.equal(ok.created.length, 1);
  await ok.dial.extractArtworkTint("https://example.test/b.jpg", "show-a", "ENAMEL");
  assert.equal(ok.created.length, 2, "new artwork for the same show is sampled again (the URL hash differs)");
  assert.equal(await make({ taint: true }).dial.extractArtworkTint("https://example.test/a.jpg", "s", "ENAMEL"), "ENAMEL", "tainted canvas");
  assert.equal(await make({ fail: true }).dial.extractArtworkTint("https://example.test/a.jpg", "s", "ENAMEL"), "ENAMEL", "image error");
  assert.equal(await make().dial.extractArtworkTint("http://example.test/a.jpg", "s", "ENAMEL"), "ENAMEL", "an unsafe URL never reaches the image");
});

test("a plain episode's chip row carries the Downloaded and Played tags only, written when they change", () => {
  /* BUILD-NOTES 4.2: "for an episode, the downloaded/played tags only". The tags are the real tactileTag markup.
     MUTATIONS: drop the `!model.foray` branch at the top of dialPaintChip -> an episode gets no tags (and a
     station chip path that throws on it); write the chip row on every call (remove the `chipsKey` early
     return) -> the write count is 4, not 2; swap the Played tag's text for "Done" -> the markup assertion fails. */
  const { dial } = loadDialWithPrimitives();
  const writes = [];
  const parts = { chips: { set innerHTML(v) { writes.push(v); }, replaceChildren() { writes.push("foray-reset"); } } };
  const episode = { foray: false, downloaded: true, played: false };
  dial.paintChip(parts, episode);
  dial.paintChip(parts, episode);
  dial.paintChip(parts, { ...episode, played: true });
  dial.paintChip(parts, { ...episode, played: true });
  assert.equal(writes.length, 2, "an unchanged pair is not rewritten");
  assert.match(writes[0], /^<span class="tag tag--downloaded">.*<span>Downloaded<\/span><\/span>$/);
  assert.doesNotMatch(writes[0], /Played|station|narration/);
  assert.match(writes[1], /tag--downloaded[\s\S]*<span class="tag tag--played">.*<span>Played<\/span><\/span>$/);
  const none = { chips: { set innerHTML(v) { writes.push("none:" + v); } } };
  dial.paintChip(none, { foray: false });
  assert.equal(writes[2], "none:", "neither tag: an empty row, no station chip");
});

test("a plain episode's detail posture is Up next, Chapters and Show notes, with no Clips and no Where this came from", () => {
  /* Source-text pins, the way this file pins view wiring it cannot mount.
     MUTATIONS: change `parts.segments.hidden = !model.foray` to `= false` -> the Clips list shows on an episode;
     change `parts.origin.hidden = !model.foray` likewise -> "Where this came from" shows; change
     `parts.chapters.hidden = model.foray` to `= false` -> a foray gets a Chapters list; delete the `.np--episode
     .np__why` rule -> the sentence sits under the title again and pushes the band 14px down. */
  assert.match(NP_FLAT_TEXT, /parts\.segments\.hidden = !model\.foray;/);
  assert.match(NP_FLAT_TEXT, /parts\.origin\.hidden = !model\.foray;/);
  assert.match(NP_FLAT_TEXT, /parts\.chapters\.hidden = model\.foray;/);
  assert.match(NP_FLAT_TEXT, /parts\.notes\.hidden = model\.foray \|\| \(!hasDetails && !hookText\);/);
  assert.match(NP_FLAT_TEXT, /\["Up next"|dialNpEl\("h2", "heading", "Up next"\)/);
  assert.match(NP_FLAT_TEXT, /dialNpEl\("h2", "heading", "Chapters"\)/);
  assert.match(NP_FLAT_TEXT, /dialNpEl\("h2", "heading", "Show notes"\)/);
  assert.match(CSS_RULES, /\.np--episode \.np__why \{ display: none; \}/);
  assert.match(NP_FLAT_TEXT, /parts\.sheet\.classList\.toggle\("np--episode", !d\.foray\)/);
});

test("the episode band is handed its chapters as fractions of the runtime, ascending and strictly inside it", () => {
  /* MUTATION: drop the `f > 0 && f < 1` filter -> the 0 and past-the-end marks come back; drop the `.sort`
     -> a feed that lists chapters out of order draws ticks out of order; drop the `seen` filter -> two chapters
     a hair apart draw two ticks. */
  const { dial } = loadDial();
  const chapter = (start) => ({ start });
  const marks = (model) => [...dial.chapterFractions(model)];   // out of the vm's realm, so deepEqual compares plain arrays
  assert.deepEqual(marks({ duration: 1000, chapters: [chapter(500), chapter(0), chapter(250), chapter(1000), chapter(1500), chapter(250.001)] }), [0.25, 0.5]);
  assert.deepEqual(marks({ duration: 0, chapters: [chapter(10)] }), [], "no runtime yet, no ticks");
  assert.deepEqual(marks({ duration: 100, chapters: null }), []);
});

test("chapterStartSec reads the catalogue's start_time_seconds and drops a chapter with no known start", () => {
  /* The catalogue stores `start_time_seconds` (ui/episode.js reads it). The model read only start_sec / startTime /
     start, so a real episode's chapters never reached the sheet.
     MUTATIONS: remove "start_time_seconds" from the key list -> the first assertion is null; change
     `value == null || value === ""` to `value == null` -> an empty string reads as 0 and the third fails; drop
     `seconds >= 0` -> a negative start is kept. */
  const m = /^function chapterStartSec\(chapter\) \{[\s\S]*?\n\}/m.exec(CLIENT);
  assert.ok(m, "client.js declares chapterStartSec at top level");
  const context = { Number };
  vm.createContext(context);
  vm.runInContext(m[0] + "\nvar __start = chapterStartSec;", context, { filename: "player/client.js (chapterStartSec)" });
  assert.equal(context.__start({ title: "A", start_time_seconds: 324 }), 324);
  assert.equal(context.__start({ startTime: "12.5" }), 12.5);
  assert.equal(context.__start({ start_time_seconds: "" }), null, "an empty start is unknown, not 0");
  assert.equal(context.__start({ start_time_seconds: null, start_sec: 9 }), 9, "the next spelling is tried");
  assert.equal(context.__start({ start_time_seconds: -4 }), null);
  assert.equal(context.__start({ title: "no start" }), null);
  assert.equal(context.__start(null), null);
  assert.match(FLAT, /\.map\(chapterStartSec\)/, "the arrow-key chapter jump reads starts through the same function");
  assert.match(FLAT, /const start = chapterStartSec\(chapter\); if \(start == null\) continue;/, "and so does the sheet's model");
});

test("the page answers the sheet's Up next card and its two tags from its own records (sheetFacts)", () => {
  /* app.js EPISODE_NAVIGATION.sheetFacts: next = the pick the skip makes (planAfterEnded), downloaded = a `done`
     row in cp_downloads, played = the player's own progress state. It runs here against fakes that answer like
     the page's functions, including a missing downloads store.
     MUTATIONS: compare the status to "queued" instead of "done" -> downloaded is false for a finished download;
     read `planAfterEnded(id)` as `planAfterEnded(nextId)` -> the next card is wrong; change the played test to
     `!== "unplayed"` -> a part-played episode is tagged Played. */
  const APP_TEXT = read("app.js");
  const m = /  sheetFacts\(id\) \{[\s\S]*?\n  \},/.exec(APP_TEXT);
  assert.ok(m, "app.js declares sheetFacts on EPISODE_NAVIGATION");
  const build = ({ nextId = null, items = {}, progress = { state: "unplayed" }, downloads = { items: {} }, throwDownloads = false } = {}) => {
    const context = {
      planAfterEnded: (id) => { context.asked = id; return { nextId }; },
      liveEpisode: (id) => items[id] || null,
      downloadsValue: () => { if (throwDownloads) throw new ReferenceError("no downloads module"); return downloads; },
      rowProgress: () => progress,
      itemDurationSec: (item) => (item.duration_min ? item.duration_min * 60 : null),
    };
    vm.createContext(context);
    vm.runInContext("var nav = {" + m[0].replace(/,\s*$/, "") + "};", context, { filename: "app.js (sheetFacts)" });
    return context;
  };
  const next = { id: "n1", title: "Next one", show: "Show N", show_id: "sn", artwork_url: "https://a/n.jpg", duration_min: 45, hook: "Why." };
  const full = build({ nextId: "n1", items: { n1: next }, progress: { state: "played" }, downloads: { items: { cur: { status: "done" } } } });
  const facts = full.nav.sheetFacts("cur");
  assert.equal(full.asked, "cur", "the plan is asked about the CURRENT episode");
  assert.deepEqual(JSON.parse(JSON.stringify(facts)), {
    next: { id: "n1", title: "Next one", show: "Show N", show_id: "sn", artwork_url: "https://a/n.jpg", duration_sec: 2700, why: "Why." },
    downloaded: true, played: true,
  });
  const idle = build({ downloads: { items: { cur: { status: "downloading" } } }, progress: { state: "partial" } }).nav.sheetFacts("cur");
  assert.deepEqual(JSON.parse(JSON.stringify(idle)), { next: null, downloaded: false, played: false }, "nothing queued, only a download under way, only part played");
  const noModule = build({ throwDownloads: true }).nav.sheetFacts("cur");
  assert.equal(noModule.downloaded, false, "no downloads module is an honest absence, not an error");
  assert.equal(build({ nextId: "gone", items: {} }).nav.sheetFacts("cur").next, null, "a next id that no longer resolves is no card");
});

test("the model hands the sheet the page's facts for a plain episode only, held two seconds per episode", () => {
  /* MUTATIONS: remove the `episodeFactsId === id &&` cache test -> sheetFacts is read on every tick (the call
     count below is 4, not 2); ask for a foray's id (drop `!current?.forayId`) -> source assertion fails; drop the
     `try` -> a throwing page answer breaks the paint instead of reading as no facts. */
  const m = /\/\*\* What the page knows about the episode on the sheet[\s\S]*?\n  return episodeFactsValue;\n\}/m.exec(CLIENT);
  assert.ok(m, "client.js declares dialEpisodeFacts");
  let calls = 0;
  let now = 1000;
  const context = {
    Date: { now: () => now }, Object, Number,
    episodeNavigation: { sheetFacts: (id) => { calls += 1; if (id === "boom") throw new Error("page broke"); return { next: { id: "n", title: "T" }, downloaded: true, played: 1 }; } },
  };
  vm.createContext(context);
  vm.runInContext(m[0] + "\nvar __facts = dialEpisodeFacts;", context, { filename: "player/client.js (dialEpisodeFacts)" });
  const first = context.__facts("ep-1");
  assert.equal(first.downloaded, true);
  assert.equal(first.played, false, "only a literal true reads as played");
  assert.equal(first.next.id, "n");
  context.__facts("ep-1");
  assert.equal(calls, 1, "a second read inside two seconds is the held answer");
  now += 2500;
  context.__facts("ep-1");
  assert.equal(calls, 2, "after two seconds it asks again");
  context.__facts("ep-2");
  assert.equal(calls, 3, "another episode is never served the first one's answer");
  assert.deepEqual(JSON.parse(JSON.stringify(context.__facts("boom"))), { next: null, downloaded: false, played: false }, "a page that throws is no facts");
  assert.deepEqual(JSON.parse(JSON.stringify(context.__facts(null))), { next: null, downloaded: false, played: false }, "no episode id (a foray) is no facts");
  assert.match(FLAT, /const facts = dialEpisodeFacts\(!current\?\.forayId \? current\?\.id : null\);/);
});

test("the lock-screen artwork of a plain episode goes through the page's safeUrl first, and a refusal is no artwork", () => {
  /* The real safeUrl is lifted from app.js (tactile-primitives helper's GUARDS) and answers "#" for what it
     refuses; "#" is not a picture, so it must come out as null (the app icon then stands in).
     MUTATIONS: return `safe` unconditionally (drop `safe !== "#"`) -> "javascript:" comes out as "#" and the
     third assertion fails; read `url` instead of `safeUrl(url)` -> the javascript: URL is passed through and
     the same assertion fails; replace `current.artwork_url` in mediaViewFields by the raw field -> the source
     assertion fails. */
  const m = /^function safeArtworkUrl\(url\) \{[\s\S]*?\n\}/m.exec(CLIENT);
  assert.ok(m, "client.js declares safeArtworkUrl at top level");
  const { context } = loadDialWithPrimitives();   // carries the real esc / safeUrl lifted from app.js
  vm.runInContext(m[0] + "\nvar __art = safeArtworkUrl;", context, { filename: "player/client.js (safeArtworkUrl)" });
  assert.equal(context.__art("https://is1-ssl.mzstatic.com/image/thumb/a/600x600bb.jpg"), "https://is1-ssl.mzstatic.com/image/thumb/a/600x600bb.jpg");
  assert.equal(context.__art(""), null);
  assert.equal(context.__art("javascript:alert(1)"), null, "a refusal is null, never the '#' safeUrl answers with");
  assert.equal(context.__art(null), null);
  assert.match(FLAT, /showArtworkUrl: safeArtworkUrl\(current\.artwork_url\)/);
});

test("the web lock screen names a plain episode's why-line as its album, and the show as its artist", () => {
  /* client.js hands `why: currentWhy` on the episode branch of mediaViewFields only; mediaMetadata does the rest
     (player/media-session.test.js). MUTATIONS: delete `why: currentWhy` -> the album falls back to "4a"; set
     `currentWhy` from the Foray's segment line too (move the assignment out of setNowPlaying's why/hook line) ->
     the next assertion on the single write fails. */
  assert.match(FLAT, /showArtworkUrl: safeArtworkUrl\(current\.artwork_url\), [^}]*why: currentWhy,/);
  assert.match(FLAT, /ui\.sWhy\.textContent = why \|\| item\.hook \|\| ""; ui\.sWhy\.hidden = !ui\.sWhy\.textContent; currentWhy = ui\.sWhy\.textContent;/);
  assert.equal((FLAT.match(/why: currentWhy/g) || []).length, 1, "only the episode branch carries it; a foray's album stays its title and counter");
});

test("the plain-episode sheet matches the prototype's geometry: a 44px well, 68px skip keys, a peeking Up next, 17px show name", () => {
  /* Each assertion names the one-line mutation that turns it red (all run):
     - `.np--episode .np__band { --np-band-h: 44px; }` -> 64px: the well is a third taller than the prototype's
       and the band sits against its top edge; also change NP_EPISODE_STAGE_PX away from 44 -> the stage
       assertion fails (the CSS and the drawing move together);
     - the `.np--episode .transport .keycap--lg` width calc(var(--key-lg) + var(--s-3)) -> var(--key-lg): the
       side keys are circles of 56 and the row loses its 68/80/68 rhythm;
     - the episode `.np__top` min-height 189px -> 176px: "Up next" lands 13px low and the first row card
       slides under the dock's paper (nothing peeks), and the 147px short-screen twin -> 142px likewise;
     - the episode `.np__dock::before { top: -22px }` -> delete it: the paper starts 14px higher than the
       prototype's and is opaque over the whole first card;
     - `.np__show` font body-lg -> body: the show name is a step below the title-to-show step the prototype draws. */
  assert.match(CSS_RULES, /\.np--episode \.np__band \{ --np-band-h: 44px; \}/);
  assert.match(NP_FLAT_TEXT, /var NP_EPISODE_STAGE_PX = 44;/);
  assert.match(NP_FLAT_TEXT, /stagePx: d\.foray \? 0 : NP_EPISODE_STAGE_PX/);
  assert.match(CSS_RULES, /\.np--episode \.np__needle \{ height: 42px; \}/);
  assert.match(CSS_RULES, /\.np--episode \.transport \.keycap--lg \{[^}]*width:\s*calc\(var\(--key-lg\) \+ var\(--s-3\)\)[^}]*min-width:\s*calc\(var\(--key-lg\) \+ var\(--s-3\)\)[^}]*padding:\s*0/);
  assert.match(CSS_RULES, /\.np--episode \.np__top \{ min-height: calc\(100% - 189px - var\(--safe-b\)\); \}/);
  assert.match(CSS_RULES, /@media \(max-height: 740px\)[\s\S]*?\.np--episode \.np__top \{ min-height: calc\(100% - 147px - var\(--safe-b\)\); \}/);
  assert.match(CSS_RULES, /\.np--episode \.np__dock::before \{ top: -22px; \}/);
  assert.match(CSS_RULES, /\.np \.np__text \.np__show \{[^}]*font:\s*500 var\(--t-body-lg\)\/var\(--lh-body-lg\)/);
  /* The foray's own rules are untouched: its keys stay the ruled 56px circles. */
  assert.match(CSS_RULES, /\.np \.transport \.keycap--lg \{\s*box-sizing:\s*border-box;\s*width:\s*var\(--key-lg\)/);
});
