/* Tactile Phase 4 group A `now-playing-paused` (BUILD-PLAN 2.2): the sheet
 * when the listener has pressed pause, and the buffering stall.
 *
 * ui/now-playing.js is run for real in a vm with a small element model that
 * logs every write; the helpers that need a browser (tint sampling, computed
 * style) are the file's own guards, which answer "nothing" without one.
 *
 * Every test names the one-line mutation that turns it red; each was run.
 *   Suite map: this file pins the paint half (glyph, label, needle, stall
 *   class), the elapsed "…" and the harness step. The gradient, geometry and
 *   reduced-motion enumeration are test/ui-tokens-dial.test.js's.
 */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { load, rule, ROOT, CSS } = require("./helpers/tactile-primitives.js");

const NP_SRC = fs.readFileSync(path.join(ROOT, "ui", "now-playing.js"), "utf8").replace(/\r\n/g, "\n");
const CLIENT = fs.readFileSync(path.join(ROOT, "player", "client.js"), "utf8").replace(/\r\n/g, "\n");
const STATES = fs.readFileSync(path.join(ROOT, "tools", "ui-lab", "lib", "states.mjs"), "utf8").replace(/\r\n/g, "\n");

/* An element that records every write made to it, so "identical outside the
   Play keycap" is a comparison of two logs and not a list of the writes the
   test author thought of. */
class El {
  constructor(name) {
    this.name = name;
    this.log = [];
    this.attrs = {};
    this.dataset = {};
    this.clientWidth = 345;
    this.textContent = "";
    this._html = "";
    const self = this;
    this.classes = new Set();
    this.classList = {
      toggle: (c, on) => { const next = on === undefined ? !self.classes.has(c) : Boolean(on); if (next) self.classes.add(c); else self.classes.delete(c); self.log.push(["class", c, next]); return next; },
      add: (c) => { self.classes.add(c); self.log.push(["class", c, true]); },
      remove: (c) => { self.classes.delete(c); self.log.push(["class", c, false]); },
      contains: (c) => self.classes.has(c),
    };
    this.style = { setProperty: (k, v) => self.log.push(["css", k, String(v)]) };
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.log.push(["html", this._html]); }
  setAttribute(k, v) { this.attrs[k] = String(v); this.log.push(["attr", k, String(v)]); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; this.log.push(["rm", k]); }
  replaceChildren(...k) { this.log.push(["children", k.map(String).join("|")]); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

function build() {
  const ctx = load({
    window: null,
    document: { documentElement: { dataset: {} } },
    getComputedStyle: () => ({ lineHeight: "30px", getPropertyValue: () => "" }),
  });
  ctx.window = ctx;
  vm.runInContext(NP_SRC, ctx, { filename: "ui/now-playing.js" });
  const parts = {
    sheet: new El("sheet"), sShow: new El("sShow"), sTitle: new El("sTitle"), bigPlay: new El("bigPlay"),
    bandSvg: new El("bandSvg"), bandVisual: new El("bandVisual"), bandNeedle: new El("bandNeedle"),
    scrub: new El("scrub"), tNow: new El("tNow"), tLeft: new El("tLeft"),
    moreKey: "",
  };
  return { ctx, parts };
}

/* The model client.js builds, minus the part under test. */
function model(over) {
  return { foray: true, running: true, buffering: false, position: 760, duration: 3000, currentIndex: 0, segments: [], detailKey: "", ...over };
}

function paint(over) {
  const { ctx, parts } = build();
  ctx.DialNowPlaying.paint(parts, model(over));
  return parts;
}

const outsideKeycap = (parts) => Object.fromEntries(
  Object.entries(parts).filter(([k, v]) => v instanceof El && k !== "bigPlay").map(([k, v]) => [k, { log: v.log, attrs: v.attrs, classes: [...v.classes].sort(), html: v._html }]),
);

test("a paused sheet shows the play glyph, the label Play, and no needle animation or stall class", () => {
  /* MUTATION: in dialPaintNowPlaying write `d.running ? "ph-play-fill" : "ph-pause-fill"`
     (glyphs swapped) -> the glyph, the label pair and the inverse all fail. */
  const paused = paint({ running: false });
  assert.strictEqual(paused.bigPlay.dataset.icon, "ph-play-fill");
  assert.match(paused.bigPlay._html, /ph-play-fill/);
  assert.doesNotMatch(paused.bigPlay._html, /ph-pause-fill/);
  assert.strictEqual(paused.bigPlay.attrs["aria-label"], "Play");
  assert.ok(!paused.bandNeedle.classes.has("is-buffering"), "no animation hook on the needle");
  assert.ok(!paused.sheet.classes.has("np--buffering"));
  /* The inverse: the playing sheet is the pause glyph, so the test above is
     not satisfied by a painter that ignores `running`. */
  const playing = paint({ running: true });
  assert.strictEqual(playing.bigPlay.dataset.icon, "ph-pause-fill");
  assert.strictEqual(playing.bigPlay.attrs["aria-label"], "Pause");
});

test("paused and playing paint every other element identically, and neither touches the elapsed readout", () => {
  /* MUTATION: add `parts.sheet.classList.toggle("np--paused", !d.running);` to
     dialPaintNowPlaying -> the sheet's log differs between the two paints and
     this test names `sheet`. The harness reads the whole log of every part, not
     a hand-picked list, so a new write anywhere outside the keycap fails it. */
  const playing = paint({ running: true });
  const paused = paint({ running: false });
  assert.deepStrictEqual(outsideKeycap(paused), outsideKeycap(playing));
  assert.deepStrictEqual(paused.tNow.log, [], "the readout is not this painter's: a pause keeps the value client.js wrote");
  assert.notDeepStrictEqual(paused.bigPlay.log, playing.bigPlay.log, "fixture premise: the keycap IS where they differ");
});

test("buffering pulses the needle and marks the sheet; stopping clears both", () => {
  /* MUTATION: delete the `parts.bandNeedle.classList.toggle("is-buffering", ...)`
     line -> the needle half fails; delete the `np--buffering` toggle -> the sheet half fails. */
  const { ctx, parts } = build();
  ctx.DialNowPlaying.paint(parts, model({ buffering: true }));
  assert.ok(parts.bandNeedle.classes.has("is-buffering"));
  assert.ok(parts.sheet.classes.has("np--buffering"));
  ctx.DialNowPlaying.paint(parts, model({ buffering: false }));
  assert.ok(!parts.bandNeedle.classes.has("is-buffering"), "the same needle element is released, not left pulsing");
  assert.ok(!parts.sheet.classes.has("np--buffering"));
});

test("the needle pulse is opacity 1 to 0.4 over the 1s token, only while buffering, and Reduce Motion stills it", () => {
  /* MUTATION 1: change `to { opacity: .4; }` in @keyframes np-needle-pulse to .6 -> red.
     MUTATION 2: delete `.np__needle.is-buffering,` from the reduced-motion block -> red.
     MUTATION 3: add `animation: np-needle-pulse ...` to plain `.np__needle` -> the paused half is red. */
  assert.match(CSS, /--d-buffer:\s*1000ms/, "the pulse duration is the 1s motion token");
  assert.match(CSS, /@keyframes np-needle-pulse\s*\{\s*from\s*\{\s*opacity:\s*1;?\s*\}\s*to\s*\{\s*opacity:\s*\.4;?\s*\}\s*\}/, "the keyframes run opacity 1 to .4");
  const pulse = rule(".np__needle.is-buffering");
  assert.match(pulse, /animation:\s*np-needle-pulse var\(--d-buffer\)/);
  assert.match(pulse, /infinite alternate/);
  assert.doesNotMatch(rule(".np__needle"), /animation/, "a paused needle has no animation");
  const start = CSS.indexOf("@media (prefers-reduced-motion: reduce)");
  assert.ok(start > 0 && CSS.indexOf("@media (prefers-reduced-motion", start + 10) === -1, "exactly one reduced-motion block");
  const block = CSS.slice(start);
  const stilled = /([^{}]*)\{\s*animation:\s*none;?\s*\}/g;
  const selectors = [];
  for (const m of block.matchAll(stilled)) selectors.push(...m[1].split(",").map((s) => s.trim()));
  assert.ok(selectors.includes(".np__needle.is-buffering"), "the one block names the needle pulse");
});

/* paintClocks, lifted from the player's own source and run with the three
   formatters stubbed to fixed strings: the branch under test is `stalled`. */
function clocks() {
  const start = CLIENT.indexOf("function paintClocks(");
  const end = CLIENT.indexOf("\n}\n", start);
  assert.ok(start > 0 && end > start, "client.js still declares paintClocks()");
  const ui = { tNow: new El("tNow"), tLeft: new El("tLeft"), scrub: new El("scrub") };
  ui.tNow.textContent = "";
  Object.defineProperty(ui.tNow, "textContent", { get() { return this._t || ""; }, set(v) { this._t = v; this.log.push(["text", v]); } });
  Object.defineProperty(ui.tLeft, "textContent", { get() { return this._t || ""; }, set(v) { this._t = v; } });
  const ctx = vm.createContext({
    ui, foray: { index: 0, resolved: { estimated: false, playable: [{ show: "Odd Lots" }] } }, window: { DialNowPlaying: {} },
    fmtClock: () => "12:40", formatTimestamp: () => "12:40", remainingClock: () => "-38:42",
    dialSpokenClock: () => "12 minutes 40", EXACT: 1, Math,
  });
  vm.runInContext(CLIENT.slice(start, end + 2), ctx, { filename: "player/client.js (paintClocks)" });
  return { ctx, ui };
}

test("a stalled sheet reads an ellipsis for elapsed and keeps the real countdown; a paused one keeps its value", () => {
  /* MUTATION: change `stalled ? "…" : now` to `now` in paintClocks -> the stalled half is red.
     MUTATION 2: show the ellipsis whenever the transport is not running (use
     `!running`) -> the paused half is red, which is the point of pinning it. */
  const { ctx, ui } = clocks();
  ctx.paintClocks(760, 3000, true, null, true);
  assert.strictEqual(ui.tNow.textContent, "…");
  assert.strictEqual(ui.tLeft.textContent, "-38:42", "only the elapsed readout is replaced");
  ctx.paintClocks(760, 3000, true, null, false);
  assert.strictEqual(ui.tNow.textContent, "12:40", "stopping the stall restores the value");
  const paused = clocks();
  paused.ctx.paintClocks(760, 3000, true, null);
  assert.strictEqual(paused.ui.tNow.textContent, "12:40", "a paused sheet (no stall) keeps its elapsed value, no ellipsis");
});

test("the sheet's stall is the first load OR a mid-play stall, the same boolean drives needle and readout, and a drag preview never stalls", () => {
  /* MUTATION 1: change one `buffering: loading || buffering` back to `buffering: loading`
     -> the model pin is red (a `waiting` stall would leave the needle still, as it did).
     MUTATION 2: drop `Boolean(window.DialNowPlaying) && Boolean(dialModel?.buffering)` from the
     render() call -> the readout pin is red.
     MUTATION 3: pass a stall from the drag-preview paintClocks(at, dur) call -> the preview pin is red. */
  assert.strictEqual((CLIENT.match(/running, buffering: loading \|\| buffering,/g) || []).length, 2, "episode and foray models both carry the stall");
  assert.doesNotMatch(CLIENT, /running, buffering: loading,/);
  assert.match(CLIENT, /paintClocks\(pos, dur, !held, window\.DialNowPlaying \? dialModel\?\.valueText : null, Boolean\(window\.DialNowPlaying\) && Boolean\(dialModel\?\.buffering\)\);/);
  const preview = [...CLIENT.matchAll(/paintClocks\(at, dur\);/g)];
  assert.strictEqual(preview.length, 1, "the drag preview calls paintClocks with the real position");
});

test("the harness reaches the paused sheet by pressing Play once the sheet is open, and the screen map points at it", () => {
  /* MUTATION 1: point screens.json's now-playing-paused row back at "now-playing" -> red.
     MUTATION 2: rename the step label in states.mjs -> red (fidelity.mjs would exit 2 on it too).
     MUTATION 3: drop the second `.fp-big` click -> the step never reaches Play and the ready selector times out. */
  const step = /\{ label: "now-playing-paused", route: "#\/library", run: \(page\) => pausedForayNowPlaying\(page\), ready: '#foray-player \.fp-play\[aria-label="Play"\]' \}/;
  assert.match(STATES, step);
  const player = STATES.slice(STATES.indexOf('id: "player"'), STATES.indexOf('id: "search"'));
  assert.ok(player.indexOf('label: "now-playing-closed"') < player.indexOf('label: "now-playing-paused"'), "appended after the existing steps, none reordered");
  const fn = /async function pausedForayNowPlaying[\s\S]*?\n\}/.exec(STATES)[0];
  assert.strictEqual((fn.match(/await big\.click\(\)/g) || []).length, 2, "one press starts it, one press pauses it");
  assert.match(fn, /fp-big\[aria-label="Play"\]/);
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, "docs", "redesign-2026", "directions", "tactile", "screens.json"), "utf8"));
  assert.deepStrictEqual(map.screens["now-playing-paused"].app, { state: "player", step: "now-playing-paused" });
  assert.strictEqual(map.screens["now-playing"].app.step, "now-playing", "the playing row is untouched");
});

test("a started foray's why-line stays out of the sheet's layout but not out of the accessibility tree", () => {
  /* The real paused and playing sheets carry a why-line (the player sets one on
     start); the prototype's head is title, show, chips. Without this the band
     sits 44px lower than the prototype and than the restored sheet.
     MUTATION 1: put `margin: 0; font-size: var(--t-body);` back (drop the clip) -> red.
     MUTATION 2: swap the rule for `display: none` -> red (a screen reader would lose the line). */
  const why = rule(".np .np__text .np__why");
  assert.match(why, /position:\s*absolute/);
  assert.match(why, /clip-path:\s*inset\(50%\)/);
  assert.match(why, /overflow:\s*hidden/);
  assert.doesNotMatch(why, /display:\s*none/);
});

test("the Play keycap's drawn glyph survives the player's repaint: it is a dial-owned control, so paintControl writes only its name", () => {
  /* Found in the browser, not by a test: the live key showed a text "▶" because
     paintControl rewrote its text at 4 Hz and dialPaintNowPlaying redraws only
     when the icon id changes.
     MUTATION 1: remove `parts.bigPlay,` from the dialOwnGlyph list in ui/now-playing.js -> the
     build pin is red.
     MUTATION 2: delete the `dialOwned === "1"` early return in paintControl -> the behaviour half is red. */
  assert.match(NP_SRC, /\[parts\.backBtn, parts\.bigPlay, parts\.fwdBtn, parts\.rateBtn, parts\.bookmarkBtn, parts\.queueLink\]\.forEach\(dialOwnGlyph\);/);
  const start = CLIENT.indexOf("function paintControl(");
  const end = CLIENT.indexOf("\n}\n", start);
  assert.ok(start > 0 && end > start, "client.js still declares paintControl()");
  const ctx = vm.createContext({});
  vm.runInContext(CLIENT.slice(start, end + 2), ctx, { filename: "player/client.js (paintControl)" });
  const key = new El("bigPlay");
  key.dataset.dialOwned = "1";
  key.innerHTML = '<svg class="i i--lg"><use href="#ph-play-fill"></use></svg>';
  let textWrites = 0;
  Object.defineProperty(key, "textContent", { get() { return ""; }, set() { textWrites += 1; } });
  ctx.paintControl(key, "▶", "Play");
  assert.strictEqual(textWrites, 0, "no text written over the drawn glyph");
  assert.match(key.innerHTML, /ph-play-fill/);
  assert.strictEqual(key.getAttribute("aria-label"), "Play");
  /* The control's inverse: an unowned control still gets its text, so the
     assertion above is not satisfied by a paintControl that writes nothing. */
  const plain = new El("playBtn");
  let plainText = null;
  Object.defineProperty(plain, "textContent", { get() { return ""; }, set(v) { plainText = v; } });
  ctx.paintControl(plain, "▶", "Play");
  assert.strictEqual(plainText, "▶");
});

test("the previous/next clip buttons a started foray shows read in --ink-2 on the tint, hover in --ink", () => {
  /* The contrast gate first met them in the paused step (a restored sheet hides
     the row): --muted on the mustard tint was 3.43:1 at 13px.
     MUTATION 1: delete the `body.ui-v2 .fp-sheet.np .fp-clip` rule -> red.
     MUTATION 2: set it back to `var(--muted)` -> red. */
  assert.match(rule("body.ui-v2 .fp-sheet.np .fp-clip"), /color:\s*var\(--ink-2\)/);
  assert.match(rule("body.ui-v2 .fp-sheet.np .fp-clip:hover:not(:disabled)"), /color:\s*var\(--ink\)/);
});
