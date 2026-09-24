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
    /* One pass over the three quote kinds, whichever opens first: three passes
       read an apostrophe INSIDE a double-quoted literal ("couldn't") as opening
       a single-quoted string and blinded every assertion after it (audit round
       2, copy-6). */
    .replace(/`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '""')
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
  assert.match(sheet[0], /left:\s*0/);
  assert.match(sheet[0], /right:\s*0/);
  assert.match(sheet[0], /bottom:\s*0/);
  assert.match(sheet[0], /display:\s*flex/);
  assert.match(CSS_RULES, /\.fp-sheet\[hidden\]\s*\{\s*display:\s*none;?\s*\}/);
});

test("the sheet stops under the topbar, so the ☰ is still reachable while it is open", () => {
  /* U-12 / F17 is a standing invariant: the menu button lives in the topbar
     and must be reachable at EVERY moment, including while this sheet is
     expanded — the z-index ledger in styles.css says so in as many words. The
     sheet paints inside #foray-player's stacking context (60), far above the
     topbar (20), so `inset: 0` swallows the ☰ completely.
     THIS IS NOT HYPOTHETICAL: the first draft of this change shipped
     `inset: 0` and test/playwright/drawer-and-close.spec.js failed on it in
     CI, naming `.fp-grab-zone` as the element intercepting the click on
     `#menu-btn`. It is also the wrong look — an iOS sheet stops short of the
     top, and that sliver is the affordance that says "drag me down".
     MUTATION: change the `top` declaration back to `inset: 0`. This fails,
     and so does the Playwright suite. */
  const sheet = /\.fp-sheet \{[^}]*\}/.exec(CSS_RULES);
  assert.ok(sheet, ".fp-sheet must have a rule of its own");
  assert.doesNotMatch(sheet[0], /inset:\s*0/, "the sheet must not be full-bleed");
  assert.match(
    sheet[0],
    /top:\s*calc\(var\(--topbar-h\) \+ env\(safe-area-inset-top\)\)/,
    "the sheet's top edge must be the bottom of the topbar, inset included"
  );
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
  assert.match(FLAT_TEXT, /bar\.append\(art, info, skipBtn, playBtn, announce\);/);
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
  /* NOT aria-modal (review 2026-09-23): the ☰ and the drawer stay reachable, and
     aria-modal="true" hides them from VoiceOver/TalkBack swipe navigation.
     `inert` on the rest is what makes it modal. MUTATION: put
     `sheet.setAttribute("aria-modal", "true")` back -> red. */
  assert.doesNotMatch(TEXT, /sheet\.setAttribute\("aria-modal"/);
  assert.match(TEXT, /sheet\.setAttribute\("aria-labelledby", "fp-s-title"\)/);
  assert.match(TEXT, /sTitle\.id = "fp-s-title"/, "the name must point at an element that exists");
});

test("opening and closing go through app.js's sheet owner, with the topbar left reachable", () => {
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
  assert.match(body, /keepReachable: \[[^\]]*"\.topbar"[^\]]*"#drawer"/);
  assert.match(body, /onRequestClose: \(\) => setExpanded\(false\)/, "Escape and navigation collapse through the same path");
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
  /* The 40px artwork was an inert <img>. MUTATION: delete the `ui.art`
     click listener -> red. */
  assert.match(FLAT_TEXT, /ui\.art\.addEventListener\("click", \(\) => setExpanded\(ui\.sheet\.hidden\)\)/);
});

test("Stop leads the sheet's second row, alone at the danger end; the ✕ is the one Close", () => {
  /* Stop used to sit in the middle of the row beside an identical grey Close.
     The row is space-between, so first is as far from the rest as the row
     allows; and there is no second Close any more (visual pass 1, 2026-09-23:
     the grab zone's ✕ and the handle are the sheet's ways out).
     MUTATION: restore `row2.append(rateBtn, openLink, forayLink, stopBtn)`,
     or `el("button", "fp-collapse", "Close")` -> red. */
  const m = /row2\.append\(([^)]*)\)/.exec(CODE);
  assert.ok(m);
  const order = m[1].split(",").map((x) => x.trim());
  assert.strictEqual(order[0], "stopBtn", "Stop first");
  assert.ok(!order.includes("collapse"), "no Close button in the row");
  assert.doesNotMatch(FLAT, /ui\.collapse/, "nothing is wired to one");
  assert.match(FLAT_TEXT, /ui\.closeBtn\.addEventListener\("click", \(\) => setExpanded\(false\)\)/, "the ✕ collapses the sheet");
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
