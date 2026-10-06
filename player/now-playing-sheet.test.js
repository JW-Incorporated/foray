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
import vm from "node:vm";
import { seekPrecision, EXACT, OWN, FOREIGN } from "./seek-policy.js";

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
    /scroll\.append\(sArt, sTitle, sShow, chapterBox, sWhy,/,
    "the scroller's first child must be the artwork element"
  );
  assert.match(CODE, /const sArt = el\(/, "the sheet must build its own artwork element");
  assert.match(CODE, /ui\.sArt\.src = item\.artwork_url;/, "and fill it from the item's artwork");
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
/* CH-4 (#690 / #1071): THE CHAPTER YOU ARE IN                          */
/* ==================================================================== */

/* These run the code, not just read it. The chapter block of client.js (from
   its own section header to the next one) and `paintSeekNote` are lifted out
   and evaluated in a vm context that supplies exactly what they read from the
   rest of the module — `current`, `foray`, `ui`, `el`, `episodePositionSec`,
   `seekEpisodeTo` and seek-policy's real `seekPrecision` — over a stub DOM
   that counts every write. */
const CHAPTER_BLOCK = (() => {
  const start = CLIENT.indexOf("/* ---------- the chapter you are in (CH-4");
  const end = CLIENT.indexOf("\n/* ---------- ", start + 1);
  assert.ok(start > 0 && end > start, "client.js carries the CH-4 chapter block");
  return CLIENT.slice(start, end);
})();
const SEEK_NOTE_FN = /function paintSeekNote\(\) \{[\s\S]*?\n\}/.exec(CLIENT)[0];

const ch = (secs, title) => ({ secs, title, img: null, url: null, source: "feed" });
const THREE = [ch(0, "Cold open"), ch(60, "Tokamaks"), ch(120, "Stellarators")];
/* app.js chapterPrecision's rule: FOREIGN, an unclassified show read as stitched. */
const FOREIGN_RULE = (item) => seekPrecision(
  { dai_suspected: item?.dai_suspected === true || item?.dai_known === false }, { source: FOREIGN }).precision;

function chapterSheet({ chapters = THREE, precision = FOREIGN_RULE, item = { id: "ep1" }, onForay = false, bridge } = {}) {
  const log = { writes: 0, seeks: [] };
  class Stub {
    constructor(tag, cls, text) {
      this.tagName = String(tag).toUpperCase();
      this.className = cls ?? "";
      this._text = text == null ? "" : String(text);
      this._hidden = false;
      this._disabled = false;
      this.attrs = new Map();
      this.children = [];
      this.listeners = new Map();
      this.classes = new Set();
      this.classList = {
        add: (c) => { log.writes++; this.classes.add(c); },
        remove: (c) => { log.writes++; this.classes.delete(c); },
        contains: (c) => this.classes.has(c),
      };
    }
    get textContent() { return this._text; }
    set textContent(v) { log.writes++; this._text = String(v); }
    get hidden() { return this._hidden; }
    set hidden(v) { log.writes++; this._hidden = Boolean(v); }
    get disabled() { return this._disabled; }
    set disabled(v) { log.writes++; this._disabled = Boolean(v); }
    setAttribute(k, v) { log.writes++; this.attrs.set(k, String(v)); }
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
    removeAttribute(k) { log.writes++; this.attrs.delete(k); }
    append(...kids) { this.children.push(...kids); }
    addEventListener(t, fn) { if (!this.listeners.has(t)) this.listeners.set(t, []); this.listeners.get(t).push(fn); }
    click() { for (const fn of this.listeners.get("click") ?? []) fn({ preventDefault() {}, stopPropagation() {} }); }
  }
  const forayChapters = bridge !== undefined ? bridge : {
    forItem: () => chapters,
    precision: typeof precision === "function" ? precision : () => precision,
  };
  const ctx = {
    window: forayChapters === null ? {} : { ForayChapters: forayChapters },
    el: (tag, cls, text) => new Stub(tag, cls, text),
    seekPrecision, EXACT, OWN, FOREIGN,
    current: item,
    foray: onForay ? { resolved: { id: "fy1" } } : null,
    clock: 0,
    episodePositionSec: () => ctx.clock,
    seekEpisodeTo: (s) => { log.seeks.push(s); return Promise.resolve(true); },
  };
  vm.createContext(ctx);
  vm.runInContext(`${CHAPTER_BLOCK}\n${SEEK_NOTE_FN}`, ctx);
  ctx.ui = { ...vm.runInContext("buildSheetChapter()", ctx), note: new Stub("p", "fp-note") };
  ctx.ui.note.hidden = true;
  const rows = [];
  const api = {
    ui: ctx.ui,
    log,
    rows,
    /* paintNotes' half: the notes' chapter rows, as it registers them. */
    noteRows(secsList) {
      for (const secs of secsList) rows.push({ secs, row: new Stub("button", "ep-chapter-row") });
      ctx.__rows = rows;
      vm.runInContext("sheetNoteRows = __rows;", ctx);
    },
    /* setNowPlaying's call, and play()'s again once the source is known. */
    open() { vm.runInContext("paintSeekNote();", ctx); },
    at(sec) { ctx.clock = sec; vm.runInContext("trackSheetChapter();", ctx); return api; },
    run(src) { return vm.runInContext(src, ctx); },
  };
  return api;
}

test("CH-4 (a): a clock exactly on a chapter's start is IN that chapter", () => {
  /* MUTATION: `list[mid].secs <= t` -> `list[mid].secs < t` in chapterIndexAt
     -> at 60.0 the line still says chapter 1; red. */
  const s = chapterSheet();
  s.open();
  s.at(60);
  assert.strictEqual(s.ui.chapterLine.textContent, "Chapter 2 of 3 · Tokamaks");
  assert.strictEqual(s.run("chapterIndexAt")(THREE, 120), 2);
  assert.strictEqual(s.run("chapterIndexAt")(THREE, 119.9), 1);
  assert.strictEqual(s.ui.chapterBox.hidden, false, "the box shows with two or more chapters");
  assert.strictEqual(s.ui.chapterLine.hidden, false);
});

test("CH-4 (b): Previous within 3 s of a chapter's start goes to the chapter before; past 3 s, to this one's start", () => {
  /* MUTATION: `CHAPTER_RESTART_SEC = 3` -> `1` -> at +2 s Previous restarts
     Tokamaks instead of going back; red. MUTATION: -> `10` -> at +5 s it goes
     back a chapter; red. */
  const s = chapterSheet();
  s.open();
  s.at(62);
  s.ui.chapterPrev.click();
  s.at(65);
  s.ui.chapterPrev.click();
  assert.deepStrictEqual(s.log.seeks, [0, 60]);
  /* The first chapter has nothing behind it: its own start. */
  s.at(1);
  s.ui.chapterPrev.click();
  assert.strictEqual(s.log.seeks.at(-1), 0);
  assert.strictEqual(s.ui.chapterPrev.getAttribute("aria-label"), "Previous chapter");
  assert.strictEqual(s.ui.chapterNext.getAttribute("aria-label"), "Next chapter");
});

test("CH-4 (c): Next goes to the next start, and is disabled — and seeks nowhere — on the last chapter", () => {
  /* MUTATION: `ui.chapterNext.disabled = i >= list.length - 1` -> `= false`
     -> red. MUTATION: `i < list.length ? list[i].secs : null` -> `i <= list.length
     ? …` in nextChapterStart -> a seek past the end (a throw on the missing
     chapter); red. */
  const s = chapterSheet();
  s.open();
  s.at(70);
  assert.strictEqual(s.ui.chapterNext.disabled, false);
  s.ui.chapterNext.click();
  assert.deepStrictEqual(s.log.seeks, [120]);
  s.at(130);
  assert.strictEqual(s.ui.chapterNext.disabled, true, "the last chapter has no next");
  s.ui.chapterNext.click();
  assert.deepStrictEqual(s.log.seeks, [120], "and a press there seeks nowhere");
});

test("CH-4 (d): forty render ticks inside one chapter are ONE paint", () => {
  /* MUTATION: drop the `if (i !== shownChapter)` test in trackSheetChapter (paint
     every tick) -> 40 painting ticks; red. */
  const s = chapterSheet();
  s.noteRows([0, 60, 120]);
  s.open();
  s.log.writes = 0;
  let painting = 0;
  for (let k = 0; k < 40; k++) {
    const before = s.log.writes;
    s.at(61 + k * 0.25);
    if (s.log.writes !== before) painting++;
  }
  assert.strictEqual(painting, 1, "the line, the buttons and the lit row are written once");
  const before = s.log.writes;
  s.at(121);
  assert.ok(s.log.writes > before, "and written again when the chapter changes");
  /* The live wiring: render()'s page paint is what ticks it. MUTATION: delete
     `trackSheetChapter();` from paintPage -> red. */
  const page = /function paintPage\(running\) \{[\s\S]*?\n\}/.exec(CODE);
  assert.ok(page, "paintPage exists");
  assert.match(page[0], /paintEpisodeSurface\(\);\s*trackSheetChapter\(\);\s*\}$/);
});

test("CH-4 (e): a Foray — loaded, or restored with only its forayId — shows no chapter UI", () => {
  /* MUTATION: drop `!foray && !current.forayId &&` from loadSheetChapters ->
     a clip's source chapters are offered inside a Foray; red. */
  for (const s of [chapterSheet({ onForay: true }), chapterSheet({ item: { id: "seg1", forayId: "fy1" } })]) {
    s.noteRows([0, 60, 120]);
    s.open();
    s.log.writes = 0;
    for (let k = 0; k < 8; k++) s.at(30 * k);
    assert.strictEqual(s.ui.chapterBox.hidden, true);
    assert.strictEqual(s.log.writes, 0, "nothing written, no row lit");
    s.ui.chapterNext.click();
    assert.deepStrictEqual(s.log.seeks, []);
  }
});

test("CH-4 (f): on a stitched show with chapters the approximate note shows and the line reads ~; without chapters the note is unchanged", () => {
  /* MUTATION: `sheetChapters ?? seekPrecision(…, source: OWN)` -> the OWN call
     alone -> the note is empty under approximate chapters, dead code again;
     red. MUTATION: `list.length >= 2` -> `list.length >= 0` -> the note shows
     on a show with no chapters; red. */
  const dai = { id: "ep1", dai_suspected: true };
  const s = chapterSheet({ item: dai });
  s.open();
  assert.strictEqual(s.ui.note.textContent, "Chapter times on this show are approximate.");
  assert.strictEqual(s.ui.note.hidden, false);
  s.at(65);
  assert.strictEqual(s.ui.chapterLine.textContent, "~Chapter 2 of 3 · Tokamaks");

  for (const chapters of [[], [ch(0, "Only")]]) {
    const none = chapterSheet({ item: dai, chapters });
    none.open();
    assert.strictEqual(none.ui.note.textContent, "", "OWN on the listener's own copy: exact, no note");
    assert.strictEqual(none.ui.note.hidden, true);
    assert.strictEqual(none.ui.chapterBox.hidden, true, "fewer than two chapters change nothing");
  }

  /* A static show, and the downloaded file of a stitched one: exact, no note,
     no tilde. */
  for (const item of [{ id: "ep1" }, { id: "ep1", dai_suspected: true, isLocalFile: true }]) {
    const exact = chapterSheet({ item });
    exact.open();
    exact.at(0);
    assert.strictEqual(exact.ui.note.textContent, "");
    assert.strictEqual(exact.ui.chapterLine.textContent, "Chapter 1 of 3 · Cold open");
  }
});

test("CH-4 (g): no window.ForayChapters (or one without forItem) is no throw and no UI", () => {
  /* MUTATION: drop `!sheetChapters ||` from trackSheetChapter's guard -> every
     tick reads `.list` of null and throws; red. */
  for (const bridge of [null, {}, { forItem() { throw new Error("boom"); }, precision: () => "exact" }]) {
    const s = chapterSheet({ bridge });
    s.noteRows([0, 60]);
    assert.doesNotThrow(() => { s.open(); s.at(10); s.at(70); });
    assert.strictEqual(s.ui.chapterBox.hidden, true);
    assert.strictEqual(s.ui.note.textContent, "", "the note keeps its OWN reading");
    assert.ok(s.rows.every((r) => !r.row.classes.has("is-current")), "no row lit");
  }
});

test("CH-4: the notes' chapter row the clock is in is is-current with aria-current, and only that one", () => {
  /* MUTATION: drop `if (markedNoteRow) unmarkNoteRow(markedNoteRow);` from the
     tick -> two rows lit after a chapter change; red. MUTATION: drop the
     `setAttribute("aria-current", "true")` -> red. */
  const s = chapterSheet();
  s.noteRows([0, 60, 120]);
  s.open();
  s.at(60);
  const lit = () => s.rows.map((r) => r.row.classes.has("is-current"));
  assert.deepStrictEqual(lit(), [false, true, false]);
  assert.strictEqual(s.rows[1].row.getAttribute("aria-current"), "true");
  s.at(125);
  assert.deepStrictEqual(lit(), [false, false, true]);
  assert.strictEqual(s.rows[1].row.getAttribute("aria-current"), null);
  assert.strictEqual(s.rows[2].row.getAttribute("aria-current"), "true");
  /* paintNotes registers its rows. MUTATION: delete the push -> red. */
  const fn = /function paintNotes\(item\) \{[\s\S]*?\n\}/.exec(TEXT);
  assert.match(fn[0], /ui\.sDescText\.append\(row\);\s*sheetNoteRows\.push\(\{ secs: t\.secs, row \}\);/);
  assert.match(fn[0], /sheetNoteRows = \[\];\s*markedNoteRow = null;/, "a new item's notes start unlit");
});

test("CH-4: the chapter box sits under the title and show, its buttons are 44px, the note reads the chapters", () => {
  /* MUTATION: drop `chapterBox` from scroll.append -> built and never shown;
     red. MUTATION: drop `loadSheetChapters();` from paintSeekNote -> a new
     episode keeps the last one's chapters; red. MUTATION: `min-height: 44px`
     off `.np-chapter-btn` -> red. */
  assert.match(FLAT, /scroll\.append\(sArt, sTitle, sShow, chapterBox, sWhy,/);
  assert.match(SEEK_NOTE_FN, /loadSheetChapters\(\);\s*const \{ precision \} = sheetChapters \?\? seekPrecision\(current, \{ isLocalFile: Boolean\(current\?\.isLocalFile\), source: OWN \}\);/);
  const btn = /\.np-chapter-btn \{[^}]*\}/.exec(CSS_RULES);
  assert.ok(btn, ".np-chapter-btn has a rule of its own");
  assert.match(btn[0], /min-height:\s*44px/);
  assert.match(btn[0], /min-width:\s*44px/);
  assert.match(CSS_RULES, /\.np-chapter-btn:disabled \{[^}]*opacity/);
  assert.match(CSS_RULES, /\.ep-chapter-row\.is-current \.ep-chapter-title \{[^}]*color:\s*var\(--accent\)/);
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

test("PQ-13 (#30): Bookmark sits in the sheet's second row directly after Save, built as a transport box", () => {
  /* Both are "keep this"; Stop still leads (the test above).
     MUTATION: remove `bookmarkBtn` from the `row2.append(...)` list -> the
     button is built and wired but never on screen; red. */
  const m = /row2\.append\(([^)]*)\)/.exec(CODE);
  assert.ok(m);
  const order = m[1].split(",").map((x) => x.trim());
  assert.strictEqual(order[0], "stopBtn", "Stop still leads");
  const save = order.indexOf("saveBtn");
  assert.ok(save > 0, "Save is in the row");
  assert.strictEqual(order[save + 1], "bookmarkBtn", "Bookmark directly after Save");
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
  assert.match(CSS_RULES, /@media \(prefers-reduced-motion: reduce\) \{[^}]*\.fp-sheet:not\(\.fp-sheet-dragging\)[^}]*transition:\s*none/);
});

test("ROUND 2 touch-4: every .fy-panel can move — the transform, the release transition, the entrance — and the gesture is bridged for the owner", () => {
  /* MUTATION 1: drop the `.fy-panel { transform: translateY(var(--fy-panel-dy…`
     rule -> app.js's drag writes a property nothing reads; red. MUTATION 2:
     drop `sheetDrag` from the bridge -> the owner finds no gesture and every
     handle is decoration again; red. */
  assert.match(CSS_RULES, /\.fy-panel \{[^}]*transform:\s*translateY\(var\(--fy-panel-dy, 0px\)\)/);
  assert.match(CSS_RULES, /\.fy-panel:not\(\.fy-panel-dragging\) \{\s*transition: transform \.22s ease;?\s*\}/);
  assert.match(CSS_RULES, /@keyframes fy-panel-in/);
  assert.match(CSS_RULES, /@media \(prefers-reduced-motion: reduce\) \{[^}]*\.fy-panel:not\(\.fy-panel-dragging\)[^}]*transition:\s*none/);
  assert.match(FLAT_TEXT, /sheetDrag: \{ start: startDrag, move: moveDrag, end: endDrag, offset: dragOffset, claimsTouch, \}/);
});

test("ROUND 2 nav-5: the drawer's lock and its scrim's touch-action live beside the sheet's in styles.css", () => {
  /* MUTATION: delete `body.drawer-open { overflow: hidden; }` -> red. */
  assert.match(CSS_RULES, /body\.drawer-open \{\s*overflow:\s*hidden;?\s*\}/);
  assert.match(CSS_RULES, /#drawer \{[^}]*overscroll-behavior:\s*contain/);
  assert.match(CSS_RULES, /#drawer-overlay \{[^}]*touch-action:\s*none/);
});

/* ==================================================================== */
/* SH-2 (#690): SHARE ON THE NOW PLAYING SHEET                           */
/* ==================================================================== */

/* The sheet's Share asks app.js's one producer (`window.ForayShare`, SH-1)
   for everything: whether there is a link at all (`linkFor`), and the share
   itself (`shareEpisode` / `shareForay`). These tests EXECUTE the two pure
   helpers the sheet uses — lifted out of client.js by brace-matching, the way
   test/toggle-labels.test.js lifts `paintControl` — against a stub of that
   publication, so the decision is checked as behaviour, not as spelling. */
function sheetShareFn(name) {
  const start = CLIENT.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `player/client.js has no function ${name}`);
  let depth = 0;
  for (let i = CLIENT.indexOf("{", start); i < CLIENT.length; i++) {
    if (CLIENT[i] === "{") depth++;
    else if (CLIENT[i] === "}" && --depth === 0) return CLIENT.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}
/** The same, keeping an `async` in front: without it an `await` inside reads
    as a call to an identifier and the lifted function silently misbehaves. */
function sheetShareFnAsync(name) {
  const src = sheetShareFn(name);
  const at = CLIENT.indexOf(src);
  return CLIENT.slice(Math.max(0, at - 6), at) === "async " ? "async " + src : src;
}
/* Lifted per test, so a missing helper fails these tests and not the file. */
const sheetShareSrc = () => ["sheetShareTarget", "shareFromSheet"].map(sheetShareFnAsync).join("\n");
const sheetShare = () => new Function(`${sheetShareSrc()}\nreturn { sheetShareTarget, shareFromSheet };`)();

/** A stand-in for app.js's ForayShare whose `linkFor` keeps SH-1's rule: a
    Foray has a link only when published; an episode only when it can be
    opened (here: when it has a show or an Apple URL). Records every call. */
function stubShare(forays = {}) {
  const calls = [];
  return {
    calls,
    linkFor(t) {
      calls.push(["linkFor", t]);
      if (t.kind === "foray") return forays[t.id] === "published" ? { url: "u", text: "" } : null;
      if (t.kind === "episode") return t.item && (t.item.show || t.item.apple_episode_url) ? { url: "u", text: "" } : null;
      return null;
    },
    shareEpisode(item) { calls.push(["shareEpisode", item]); return Promise.resolve("shared"); },
    shareForay(id) { calls.push(["shareForay", id]); return Promise.resolve("shared"); },
  };
}

test("SH-2 (a): a tap on an episode hands ForayShare.shareEpisode the current item itself", async () => {
  /* MUTATION: pass `{ id: target.id }` (or any copy) instead of `target.item`
     to `shareEpisode` in `shareFromSheet` -> the identity check is red, and the
     recipient's link would lose the show and Apple URL the item carries. */
  const { shareFromSheet } = sheetShare();
  const share = stubShare();
  const current = { id: "ep-1", title: "T", show: "S" };
  assert.strictEqual(await shareFromSheet(share, current, null), "shared");
  const tap = share.calls.filter(([k]) => k.startsWith("share"));
  assert.strictEqual(tap.length, 1);
  assert.strictEqual(tap[0][0], "shareEpisode");
  assert.strictEqual(tap[0][1], current, "the very item on the bar, not a rebuilt one");
});

test("SH-2: a tap on a published Foray shares the Foray by its id, never the segment playing", async () => {
  /* MUTATION: drop the `forayId ?` branch in `sheetShareTarget` -> the segment
     item would be shared as an episode; red. */
  const { shareFromSheet } = sheetShare();
  const share = stubShare({ "f-1": "published" });
  await shareFromSheet(share, { id: "seg-3", title: "x", show: "S", forayId: "f-1" }, "f-1");
  const tap = share.calls.filter(([k]) => k.startsWith("share"));
  assert.deepStrictEqual(tap, [["shareForay", "f-1"]]);
});

test("SH-2 (b): a draft Foray gets no button, and a tap on it shares nothing", async () => {
  /* MUTATION: return the target without asking `share.linkFor` in
     `sheetShareTarget` (the missing guard) -> a draft, which nobody else can
     open, offers a Share; red. */
  const { sheetShareTarget, shareFromSheet } = sheetShare();
  const share = stubShare({ "f-draft": "draft", "f-pub": "published" });
  assert.strictEqual(sheetShareTarget(share, { id: "seg", forayId: "f-draft" }, "f-draft"), null);
  assert.deepStrictEqual(sheetShareTarget(share, { id: "seg", forayId: "f-pub" }, "f-pub"), { kind: "foray", id: "f-pub" });
  assert.strictEqual(await shareFromSheet(share, { id: "seg", forayId: "f-draft" }, "f-draft"), null);
  assert.ok(!share.calls.some(([k]) => k.startsWith("share")), "nothing shared for a draft");
  /* The same guard covers a breadth episode with no resolvable link. */
  assert.strictEqual(sheetShareTarget(share, { id: "pi:1", title: "x" }, null), null);
});

test("SH-2 (c): with no ForayShare on the page there is no button and nothing throws", async () => {
  /* MUTATION: unwrap the `try { return share.linkFor(target) … } catch` in
     `sheetShareTarget` to a bare `return share.linkFor(target) ? target : null;`
     -> `share.linkFor` on undefined throws; red. */
  const { sheetShareTarget, shareFromSheet } = sheetShare();
  const item = { id: "ep-1", title: "T", show: "S" };
  for (const share of [undefined, null, {}, { linkFor: 1 }]) {
    assert.strictEqual(sheetShareTarget(share, item, null), null);
    assert.strictEqual(await shareFromSheet(share, item, null), null);
  }
  /* A producer that throws costs the button, never the sheet. */
  const broken = { linkFor() { throw new Error("boom"); }, shareEpisode() { throw new Error("boom"); } };
  assert.strictEqual(sheetShareTarget(broken, item, null), null);
  /* Nothing current, nothing to share. */
  assert.strictEqual(sheetShareTarget(stubShare(), null, null), null);
});

test("SH-2: the Share button is built in the second row after Bookmark, painted from the producer, and wired to it", () => {
  /* MUTATION 1: remove `shareBtn` from `row2.append(...)` -> red. MUTATION 2:
     drop `paintSheetShare()` from `paintEpisodeSurface` -> the button never
     un-hides; red. MUTATION 3: the click calls `shareFromSheet` with anything
     but `current` -> red. */
  const m = /row2\.append\(([^)]*)\)/.exec(CODE);
  const order = m[1].split(",").map((x) => x.trim());
  assert.strictEqual(order[order.indexOf("bookmarkBtn") + 1], "shareBtn", "Share directly after Bookmark");
  assert.match(FLAT_TEXT, /const shareBtn = el\("button", "fp-btn fp-share", "Share"\)/);
  assert.match(FLAT_TEXT, /shareBtn\.hidden = true;/, "hidden until the producer says there is a link");
  const paint = sheetShareFn("paintEpisodeSurface").replace(/\s+/g, " ");
  assert.match(commentsStripped(paint), /paintSheetShare\(\);/);
  assert.match(commentsStripped(sheetShareFn("paintSheetShare")).replace(/\s+/g, " "),
    /sheetShareTarget\(forayShare\(\), current, nowPlayingForayId\(current\)\)/);
  assert.match(FLAT, /ui\.shareBtn\.addEventListener\(/);
  assert.match(FLAT_TEXT, /shareFromSheet\(forayShare\(\), current, nowPlayingForayId\(current\)\)/);
  assert.match(CSS_RULES, /\.fp-share \{[^}]*min-width:\s*52px/, "Share wears Bookmark's box (48px tall, the transport family)");
});

test("SH-2 (d): the sheet builds no link and logs no event — SH-1 is the one producer", () => {
  /* MUTATION: build the URL in `shareFromSheet` from `location.href`, or add a
     `logEvent(` to the click -> red. */
  const handler = /ui\.shareBtn\.addEventListener\("click",[\s\S]*?\n  \}\);/.exec(TEXT);
  assert.ok(handler, "the Share click handler exists");
  const fresh = [sheetShareSrc(), sheetShareFn("paintSheetShare"), sheetShareFn("forayShare"), handler[0]]
    .map(commentsStripped).join("\n");
  assert.doesNotMatch(fresh, /location\.href/);
  assert.doesNotMatch(fresh, /logEvent\(/);
  assert.doesNotMatch(fresh, /PUBLIC_WEB_ORIGIN|#\/episode\/|#\/foray\//, "no route or origin spelled here");
});
