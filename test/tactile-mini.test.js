/* Tactile Phase 4 group A `mini`: the LIVE deck (ui/tabbar.js), the mini
 * player's arrangement, line and swipe-dismiss (ui/mini.js), and the CSS that
 * places both (styles.css "DIAL DECK, LIVE"). BUILD-PLAN 2.4.
 *
 * test/tactile-deck.test.js pins the gallery primitives; this suite pins what
 * the listener's screens actually run. Every test names the one-line mutation
 * that turns it red; each was run.
 */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { load, rule, ROOT, CSS } = require("./helpers/tactile-primitives.js");

const MINI_SRC = fs.readFileSync(path.join(ROOT, "ui", "mini.js"), "utf8").replace(/\r\n/g, "\n");
const TABBAR_SRC = fs.readFileSync(path.join(ROOT, "ui", "tabbar.js"), "utf8").replace(/\r\n/g, "\n");

/* ---------- a small element model: exactly the operations ui/mini.js performs ---------- */
class El {
  constructor(tag, cls) {
    this.tagName = String(tag).toUpperCase();
    this.className = cls || "";
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.dataset = {};
    this.listeners = {};
    this.props = {};
    this.textContent = "";
    this.html = "";
    this.clientWidth = 361;
    const self = this;
    this.style = {
      setProperty(k, v) { self.props[k] = v; },
      removeProperty(k) { delete self.props[k]; },
    };
    this.classList = {
      add: (...cs) => { for (const c of cs) if (!self.classes().includes(c)) self.className = (self.className + " " + c).trim(); },
      remove: (...cs) => { self.className = self.classes().filter((c) => !cs.includes(c)).join(" "); },
      contains: (c) => self.classes().includes(c),
      toggle: (c, on) => { if (on === undefined ? !self.classList.contains(c) : on) self.classList.add(c); else self.classList.remove(c); },
    };
  }
  classes() { return this.className.split(/\s+/).filter(Boolean); }
  get innerHTML() { return this.html; }
  set innerHTML(v) { this.html = String(v); }
  get firstChild() { return this.children[0] || null; }
  get firstElementChild() { return this.children[0] || null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(k) { if (k.parentNode) k.parentNode.removeChild(k); k.parentNode = this; this.children.push(k); return k; }
  append(...ks) { for (const k of ks) this.appendChild(k); }
  insertBefore(k, ref) {
    if (k.parentNode) k.parentNode.removeChild(k);
    const i = ref ? this.children.indexOf(ref) : -1;
    k.parentNode = this;
    if (i < 0) this.children.push(k); else this.children.splice(i, 0, k);
    return k;
  }
  removeChild(k) { this.children = this.children.filter((c) => c !== k); k.parentNode = null; return k; }
  contains(k) { for (let n = k; n; n = n.parentNode) if (n === this) return true; return false; }
  addEventListener(type, fn, capture) { (this.listeners[type] = this.listeners[type] || []).push({ fn, capture: Boolean(capture) }); }
  fire(type, event) { for (const l of this.listeners[type] || []) l.fn(event); }
  focus() { this.focused = true; }
  /* The SVG the band primitive returns, kept as its markup; the one node the
     painter touches afterwards is the progress clip's <rect>. */
  insertAdjacentHTML(where, html) {
    assert.strictEqual(where, "afterbegin");
    const svg = new El("svg", /class="([^"]+)"/.exec(html)[1]);
    svg.html = html;
    const width = /class="band__progress"[^>]*width="([\d.]+)"/.exec(html);
    svg.clip = new El("rect", "band__progress");
    if (width) svg.clip.attrs.width = width[1];
    this.insertBefore(svg, this.children[0] || null);
  }
  querySelector(sel) {
    if (sel === ".band__progress") return this.clip || null;
    return this.stubs && this.stubs[sel] || null;
  }
}

function setup({ running = true } = {}) {
  const calls = { haptic: [], toggle: 0, stop: 0 };
  const timers = [];
  let clock = 1000;
  const body = new El("body");
  const ctx = load({
    Date: { now: () => clock },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].live = false; },
    deckHaptic: (kind) => calls.haptic.push(kind),
    ForayPlayer: { togglePlayback() { calls.toggle += 1; }, stop() { calls.stop += 1; } },
  });
  ctx.window = ctx;
  ctx.document = {
    body,
    getElementById: (id) => body.children.find((c) => c.id === id) || null,
    createElement: (tag) => {
      const el = new El(tag);
      /* The toast host's two inner nodes; tactileToast's markup itself is
         pinned by test/tactile-sheet.test.js. */
      el.stubs = { ".toast": new El("div", "toast"), ".textbtn": new El("button", "textbtn") };
      el.stubs[".toast"].attrs.inert = "";
      return el;
    },
  };
  vm.runInContext(MINI_SRC, ctx, { filename: "ui/mini.js" });
  const root = new El("div", "fp");
  const bar = new El("div", "fp-bar");
  const art = new El("img", "fp-art");
  const info = new El("button", "fp-info");
  const title = new El("span", "fp-title");
  const show = new El("span", "fp-show");
  const playBtn = new El("button", "fp-play");
  const skipBtn = new El("button", "fp-skip");
  title.textContent = "Adam Posen Thinks";
  show.textContent = "Odd Lots";
  info.append(title, show);
  bar.append(art, info, skipBtn, playBtn);
  root.append(bar);
  playBtn.setAttribute("aria-label", running ? "Pause" : "Play");
  const parts = { root, bar, art, info, title, show, playBtn, skipBtn };
  ctx.DialMiniPlayer.decorate(parts);
  return { ctx, parts, calls, timers, body, tick: (ms) => { clock += ms; }, runTimers: () => timers.filter((t) => t.live).forEach((t) => { t.live = false; t.fn(); }) };
}

test("the mini is one region whose body button holds art and copy, with Play then +30 as sibling keycaps", () => {
  /* BUILD-NOTES 3.12 / BUILD-PLAN 2.4 item 3: role=region, one >= 44px body
     button (art + text) that opens the sheet, keycaps are siblings never
     nested, Play 48 persimmon round before the 44 paper +30.
     MUTATION: in dialDecorateMiniPlayer replace the reorder with
     `parts.info.appendChild(parts.playBtn)` -> the Play keycap nests in the
     body button and this fails.
     MUTATION 2: delete the `insertBefore(parts.playBtn, parts.skipBtn)` line
     -> the order reads +30, Play and this fails. */
  const { parts } = setup();
  assert.strictEqual(parts.root.getAttribute("role"), "region");
  assert.deepStrictEqual(parts.bar.children.map((c) => c.className.split(" ")[0]), ["fp-info", "fp-play", "fp-skip"]);
  assert.deepStrictEqual(parts.info.children.map((c) => c.className.split(" ")[0]), ["fp-art", "fp-title", "fp-show"]);
  for (const key of [parts.playBtn, parts.skipBtn]) assert.ok(!parts.info.contains(key), "a keycap is never inside the body button");
  assert.match(parts.playBtn.className, /\bkeycap--md\b.*\bkeycap--persimmon\b.*\bkeycap--round\b/);
  assert.match(parts.skipBtn.className, /\bkeycap--sm\b.*\bkeycap--paper\b/);
  assert.strictEqual(parts.skipBtn.getAttribute("aria-label"), "Forward 30 seconds");
  assert.match(rule(".mini__body"), /min-height:\s*var\(--tap\)/, "the body button is at least 44px tall");
});

test("the region is named 'Now playing: {title}, {show}' and the Play keycap follows the transport", () => {
  /* MUTATION: drop `+ (d.show ? ", " + d.show : "")` from the label -> red. */
  const { ctx, parts } = setup();
  ctx.DialMiniPlayer.paint(parts, { title: "Adam Posen Thinks", show: "Odd Lots", running: true, model: null });
  assert.strictEqual(parts.root.getAttribute("aria-label"), "Now playing: Adam Posen Thinks, Odd Lots");
  assert.strictEqual(parts.playBtn.getAttribute("aria-label"), "Pause");
  ctx.DialMiniPlayer.paint(parts, { title: "Adam Posen Thinks", show: "Odd Lots", running: false, model: null });
  assert.strictEqual(parts.playBtn.getAttribute("aria-label"), "Play");
});

test("the 3px line draws the foray's enamels or one persimmon bar, and a tick moves only the progress clip", () => {
  /* BUILD-NOTES 3.12: `.band--line` along the top edge, foray colours or
     persimmon for an episode. Rebuilt only when what is playing changes.
     MUTATION: in dialPaintMiniLine change `state.key !== key` to `true` (rebuild
     every paint) -> the same-SVG identity assertion fails.
     MUTATION 2: pass `segments: []` to tactileBand for a foray -> the enamel
     assertion fails (the foray draws as one persimmon bar). */
  const { ctx, parts } = setup();
  const foray = (position) => ({
    foray: true, position, duration: 1000,
    segments: [
      { showId: "origin", show: "Origin Stories", duration: 400 },
      { showId: "narration-1", show: "4a narration", duration: 30, narration: true },
      { showId: "bbq", show: "BBQ Radio Network", duration: 570 },
    ],
  });
  ctx.DialMiniPlayer.paint(parts, { title: "T", show: "S", running: true, model: foray(100) });
  const svg = parts.bar.children[0];
  assert.match(svg.className, /\bband--line\b/);
  assert.match(svg.html, /aria-hidden="true"/, "decorative: the region label already says what is playing");
  assert.match(svg.html, /t-band__bar--c\d/, "a foray draws in its stations' enamels");
  assert.match(svg.html, /t-band__bar--tick/, "narration is a solid tick in the line");
  assert.doesNotMatch(svg.html, /t-band__bar--episode/);
  const before = Number(svg.clip.getAttribute("width"));
  ctx.DialMiniPlayer.paint(parts, { title: "T", show: "S", running: true, model: foray(700) });
  assert.strictEqual(parts.bar.children[0], svg, "a clock tick does not re-render the line");
  assert.ok(Number(svg.clip.getAttribute("width")) > before + 300, "the played part grows with the clock");
  ctx.DialMiniPlayer.paint(parts, { title: "E", show: "S", running: true, model: { foray: false, position: 10, duration: 100, segments: [{ showId: "x", show: "X", duration: 100 }] } });
  const episode = parts.bar.children[0];
  assert.notStrictEqual(episode, svg, "a new item draws a new line");
  assert.strictEqual(parts.bar.children.filter((c) => c.tagName === "SVG").length, 1, "the old line is removed, never stacked");
  assert.match(episode.html, /t-band__bar--episode/, "an episode is one persimmon bar");
  assert.doesNotMatch(episode.html, /t-band__bar--c\d/);
});

test("only a mostly-vertical downward drag past 60px dismisses; sideways swipes do nothing", () => {
  /* BUILD-NOTES 3.12: swipe-down > 60px dismisses; horizontal swipes do nothing.
     MUTATION: drop `&& y > x` from dialMiniSwipeVerdict -> the diagonal
     (dx 90, dy 70) reads as a dismiss and this fails.
     MUTATION 2: change `y > DIAL_MINI_DISMISS_PX` to `y >= 40` -> the 59px row fails. */
  const { ctx } = setup();
  const v = ctx.dialMiniSwipeVerdict;
  assert.strictEqual(v(0, 61), "dismiss");
  assert.strictEqual(v(10, 120), "dismiss");
  assert.strictEqual(v(0, 60), "none", "60px exactly is not past the threshold");
  assert.strictEqual(v(0, 59), "none");
  assert.strictEqual(v(90, 70), "none", "more sideways than down is a sideways swipe");
  assert.strictEqual(v(200, 0), "none");
  assert.strictEqual(v(-200, 5), "none");
  assert.strictEqual(v(0, -120), "none", "an upward drag never dismisses");
  assert.strictEqual(v(2, 3), "tap");
});

test("a swipe-down dismisses with a HEAVY haptic and a 5s undo toast; Undo restores what was playing", () => {
  /* MUTATION: in dialUndoMiniDismiss drop the `pending.wasRunning &&`
     togglePlayback line -> undo leaves the listener paused and this fails.
     MUTATION 2: change DIAL_MINI_UNDO_MS to 3000 -> the 5000 assertion fails. */
  const { parts, calls, timers, body } = setup({ running: true });
  parts.info.fire("pointerdown", { button: 0, clientX: 100, clientY: 700, pointerId: 1 });
  parts.info.fire("pointermove", { clientX: 104, clientY: 760, pointerId: 1 });
  assert.ok(parts.root.classList.contains("is-dragging"), "the mini follows the finger down");
  parts.info.fire("pointerup", { clientX: 104, clientY: 775, pointerId: 1 });
  assert.deepStrictEqual(calls.haptic, ["heavy"]);
  assert.strictEqual(calls.toggle, 1, "playback pauses for the undo window");
  assert.ok(parts.root.classList.contains("is-dismissed"));
  assert.ok(body.classList.contains("mini-dismissed"), "the tab row takes the deck's whole shape back");
  const host = body.children.find((c) => c.id === "mini-toast");
  assert.ok(host, "the toast is on the page");
  assert.match(host.innerHTML, /Player closed/);
  assert.match(host.innerHTML, />Undo</);
  assert.ok(host.stubs[".toast"].classList.contains("is-visible"));
  assert.strictEqual(host.stubs[".toast"].getAttribute("inert"), null, "a visible toast's Undo is reachable");
  assert.deepStrictEqual(timers.filter((t) => t.live).map((t) => t.ms), [5000]);
  host.stubs[".textbtn"].fire("click", {});
  assert.strictEqual(calls.toggle, 2, "Undo resumes what was playing");
  assert.strictEqual(calls.stop, 0, "Undo never stops");
  assert.ok(!parts.root.classList.contains("is-dismissed"));
  assert.ok(!body.classList.contains("mini-dismissed"));
  assert.ok(!host.stubs[".toast"].classList.contains("is-visible"));
  assert.strictEqual(host.stubs[".toast"].getAttribute("inert"), "", "a hidden toast is inert again");
  assert.deepStrictEqual(timers.filter((t) => t.live), [], "the pending close is cancelled");
  assert.ok(parts.info.focused, "focus returns to the mini's body");
});

test("left alone, the dismiss commits through the player's own stop after 5s; a paused mini is not resumed", () => {
  /* MUTATION: in dialCommitMiniDismiss drop `player.stop()` -> stop stays 0
     and this fails. */
  const { ctx, parts, calls, runTimers } = setup({ running: false });
  assert.strictEqual(ctx.DialMiniPlayer.dismiss(parts), true);
  assert.strictEqual(calls.toggle, 0, "a paused mini is not toggled (that would start it)");
  runTimers();
  assert.strictEqual(calls.stop, 1);
  assert.ok(!parts.root.classList.contains("is-dismissed"), "the classes go; the player hides itself on stop");
});

test("a sideways swipe or a short drag neither dismisses nor opens the sheet", () => {
  /* The click that ends a drag must not reach the body button's own handler
     (which opens Now Playing).
     MUTATION: delete `event.stopPropagation();` in the root's capture listener
     -> the click reaches the opener and this fails. */
  const { parts, calls } = setup();
  let opened = 0;
  parts.info.addEventListener("click", () => { opened += 1; });
  const click = () => {
    let stopped = false;
    const event = { target: parts.info, stopPropagation() { stopped = true; }, preventDefault() {} };
    for (const l of parts.root.listeners.click || []) l.fn(event);
    if (!stopped) parts.info.listeners.click.filter((l) => !l.capture).forEach((l) => l.fn(event));
  };
  parts.info.fire("pointerdown", { button: 0, clientX: 100, clientY: 700, pointerId: 2 });
  parts.info.fire("pointermove", { clientX: 220, clientY: 712, pointerId: 2 });
  parts.info.fire("pointerup", { clientX: 240, clientY: 714, pointerId: 2 });
  click();
  assert.strictEqual(opened, 0, "the drag's click is swallowed");
  assert.strictEqual(calls.haptic.length, 0);
  assert.ok(!parts.root.classList.contains("is-dismissed"));
  parts.info.fire("pointerdown", { button: 0, clientX: 100, clientY: 700, pointerId: 3 });
  parts.info.fire("pointerup", { clientX: 101, clientY: 701, pointerId: 3 });
  click();
  assert.strictEqual(opened, 1, "a tap still opens the sheet");
});

test("playing something during the undo window drops the pending close instead of stopping it", () => {
  /* MUTATION: delete the `dialSettleMiniDismiss()` call in dialPaintMiniPlayer
     -> the timer stays armed and stop() fires on what the listener started. */
  const { ctx, parts, calls, tick, runTimers } = setup({ running: true });
  ctx.DialMiniPlayer.dismiss(parts);
  ctx.DialMiniPlayer.paint(parts, { title: "Adam Posen Thinks", show: "Odd Lots", running: true });
  assert.ok(parts.root.classList.contains("is-dismissed"), "the dismiss's own pause, landing late, is not a change of mind");
  tick(1200);
  ctx.DialMiniPlayer.paint(parts, { title: "Something else", show: "Another show", running: true });
  assert.ok(!parts.root.classList.contains("is-dismissed"));
  runTimers();
  assert.strictEqual(calls.stop, 0);
});

test("the deck collapses after 24px of downward scroll and returns on any scroll-up", () => {
  /* BUILD-NOTES 3.11: scroll-down > 24px collapses; any scroll-up restores.
     MUTATION: change `at < s.y` to `at < s.y - 40` in deckCollapseStep -> a
     small upward flick no longer restores and this fails.
     MUTATION 2: change `> DECK_COLLAPSE_PX` to `> 0` -> the 20px row collapses. */
  const ctx = vm.createContext({ Math, Number });
  vm.runInContext(TABBAR_SRC, ctx, { filename: "ui/tabbar.js" });
  const run = (ys) => ys.reduce((s, y) => ctx.deckCollapseStep(s, y), { y: 0, anchor: 0, collapsed: false });
  assert.strictEqual(run([10, 20]).collapsed, false, "20px down is not past 24");
  assert.strictEqual(run([10, 20, 30]).collapsed, true);
  assert.strictEqual(run([400, 1200]).collapsed, true);
  assert.strictEqual(run([400, 1200, 1195]).collapsed, false, "any scroll-up brings it back");
  assert.strictEqual(run([400, 1200, 1100, 1120]).collapsed, false, "20px down after turning around is not 24");
  assert.strictEqual(run([400, 1200, 1100, 1130]).collapsed, true, "a fresh 24px+ run collapses again");
  assert.strictEqual(run([400, 0]).collapsed, false, "the top of the page is never collapsed");
});

test("the Yours badge is shown with the count only while Up Next is non-empty", () => {
  /* BUILD-NOTES 3.11 / BUILD-PLAN 2.4 item 4: the badge exists only when Up
     Next is non-empty. The bar is a real tab row's shape: three anchors, the
     badge inside the Yours tab.
     MUTATION: change `badge.hidden = n === 0;` to `badge.hidden = false;` ->
     the empty row shows a "0" badge and this fails.
     MUTATION 2: delete the `setStatusText(badge, ...)` call -> the count never
     reaches the badge and the "5" assertion fails. */
  let queue = [];
  const ctx = vm.createContext({ Math, Number, String, Array, queueIds: () => queue });
  /* app.js's own setStatusText, lifted verbatim, never re-typed here. */
  const appSrc = fs.readFileSync(path.join(ROOT, "app.js"), "utf8").replace(/\r\n/g, "\n");
  const lifted = /^function setStatusText\([^)]*\) \{[\s\S]*?\n\}/m.exec(appSrc);
  assert.ok(lifted, "app.js still declares setStatusText() at top level");
  vm.runInContext(lifted[0], ctx, { filename: "app.js (setStatusText)" });
  vm.runInContext(TABBAR_SRC, ctx, { filename: "ui/tabbar.js" });
  const badge = new El("span", "tab__badge");
  badge.hidden = true;
  const tabs = ["home", "search", "library"].map((key) => {
    const a = new El("a", "tab-btn");
    a.dataset.tabKey = key;
    if (key === "library") a.stubs = { ".tab__badge": badge };
    return a;
  });
  const bar = { querySelectorAll: (sel) => (sel === ".tab-btn" ? tabs : []) };
  ctx.paintTabBadge(bar);
  assert.strictEqual(badge.hidden, true, "an empty Up Next shows no badge");
  queue = ["a", "b", "c", "d", "e"];
  ctx.paintTabBadge(bar);
  assert.strictEqual(badge.hidden, false);
  assert.strictEqual(badge.textContent, "5");
  assert.strictEqual(tabs[2].getAttribute("aria-label"), "Yours, 5 queued");
  queue = [];
  ctx.paintTabBadge(bar);
  assert.strictEqual(badge.hidden, true, "and it goes again when Up Next empties");
});

test("the live deck is the Tactile deck: fixed, inset 16, 12 above the safe area, --r-lg, tinted, blurred, shadowed", () => {
  /* BUILD-PLAN 2.4 item 1.
     MUTATION: delete `backdrop-filter: var(--deck-blur);` from
     `body.ui-v2 .tab-bar` -> red.
     MUTATION 2: change its bottom to `var(--s-3)` -> red. */
  const bar = rule("body.ui-v2 .tab-bar");
  assert.match(rule(".tab-bar"), /position:\s*fixed/);
  assert.match(bar, /left:\s*calc\(env\(safe-area-inset-left,\s*0px\)\s*\+\s*var\(--gutter\)\)/);
  assert.match(bar, /right:\s*calc\(env\(safe-area-inset-right,\s*0px\)\s*\+\s*var\(--gutter\)\)/);
  assert.match(bar, /bottom:\s*calc\(var\(--safe-b\)\s*\+\s*var\(--s-3\)\)/);
  assert.match(bar, /border-radius:\s*var\(--r-lg\)/);
  assert.match(bar, /background:\s*var\(--dock-tint\)/);
  assert.match(bar, /(?:^|;)\s*backdrop-filter:\s*var\(--deck-blur\)/);
  assert.match(bar, /box-shadow:\s*var\(--shadow-deck\)/);
  assert.match(rule(":root"), /--gutter:\s*16px/);
  /* Opaque where translucency is off or unsupported: the tint token falls back. */
  assert.match(CSS, /@media \(prefers-reduced-transparency: reduce\) \{ :root \{ --deck-tint: var\(--card\); --deck-blur: none; \} \}/);
  assert.match(CSS, /@supports not \(backdrop-filter: blur\(1px\)\) \{ :root \{ --deck-tint: var\(--card\); \} \}/);
  /* The mini's half carries the same material. */
  const mini = rule("body.ui-v2 #foray-player.dial-mini > .fp-bar");
  assert.match(mini, /background:\s*var\(--dock-tint\)/);
  assert.match(mini, /(?:^|;)\s*backdrop-filter:\s*var\(--deck-blur\)/);
  assert.match(mini, /height:\s*var\(--mini-h\)/);
  assert.match(rule("body.ui-v2.fp-open:not(.mini-dismissed) .tab-bar::before"), /var\(--dial-line\)/, "a 1px --line separates the mini from the tab row");
});

test("the live dock is nearly solid and falls back to solid card; the mini's keys wear a crescent lip and a bounded +30 face", () => {
  /* Judges, iteration 2: the row under the dock read clearly through it, the
     Play lip was a flat bar detached below the disc, and the +30 key had no
     visible face. What stays guaranteed: (1) the dock tint is at least 94% card
     (the deck token's 84% is for a deck over plain paper), (2) both fall back to
     solid card under reduced transparency / no backdrop-filter, (3) the lip is
     the key's own silhouette as a zero-blur shadow with the flat `::after` bar
     switched off, (4) the +30 key is bounded by a 1px line and its own face.
     MUTATION 1: set `--dock-tint` to `... 84%, transparent` -> (1) red.
     MUTATION 2: delete the `@supports not` dock fallback line -> (2) red.
     MUTATION 3: delete `.fp-play::after { content: none }` (the flat bar returns) -> (3) red.
     MUTATION 4: delete `inset 0 0 0 1px var(--dial-line)` from the +30 rule -> (4) red. */
  const tint = /--dock-tint:\s*color-mix\(in srgb, var\(--card\) (\d+)%, transparent\)/.exec(rule("body.ui-v2"));
  assert.ok(tint, "the dock tint is declared on body.ui-v2");
  assert.ok(Number(tint[1]) >= 94, `the dock must not let the page read through it (${tint[1]}% card)`);
  assert.match(CSS, /@media \(prefers-reduced-transparency: reduce\) \{ body\.ui-v2 \{ --dock-tint: var\(--card\); \} \}/);
  assert.match(CSS, /@supports not \(backdrop-filter: blur\(1px\)\) \{ body\.ui-v2 \{ --dock-tint: var\(--card\); \} \}/);
  const keys = rule("body.ui-v2 #foray-player.dial-mini .fp-play");
  assert.match(keys, /box-shadow:\s*0 var\(--lip\) 0 var\(--k-lip\)/, "the lip is a zero-blur shadow of the key's own shape");
  const noBar = rule("body.ui-v2 #foray-player.dial-mini .fp-play::after") + rule("body.ui-v2 #foray-player.dial-mini .fp-skip::after");
  assert.match(noBar, /content:\s*none/, "no flat bar under a round key");
  const skip = rule("body.ui-v2 #foray-player.dial-mini .fp-skip");
  assert.match(skip, /--k-fill:\s*color-mix\(in srgb, var\(--ink\) \d+%, var\(--card\)\)/, "the +30 face is a step off the deck");
  assert.match(skip, /box-shadow:\s*inset 0 0 0 1px var\(--dial-line\), 0 var\(--lip\) 0 var\(--k-lip\)/, "and a 1px line bounds it");
});

/* A resolver for the handful of tokens the deck geometry is written in. */
function px(expr, vars) {
  let out = expr;
  for (let i = 0; i < 10 && /var\(/.test(out); i++) {
    out = out.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_m, name) => {
      assert.ok(name in vars, `unresolved ${name} in ${expr}`);
      return vars[name];
    });
  }
  return Function(`"use strict"; return (${out.replace(/calc\(/g, "(").replace(/px/g, "")});`)();
}
/* The LAST declaration of `prop` across every block with exactly this
   selector: the one the cascade applies (the legacy blocks come first). */
function decl(selector, prop) {
  const all = [...rule(selector).matchAll(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+);`, "gm"))];
  assert.ok(all.length, `${selector} declares ${prop}`);
  return all[all.length - 1][1].trim();
}
function tokens(inset, collapsed) {
  const root = rule(":root");
  const tok = (n) => new RegExp(`${n}:\\s*([^;]+);`).exec(root)[1].trim();
  return {
    "--safe-b": `${inset}px`, "--s-3": tok("--s-3"), "--s-6": tok("--s-6"),
    "--deck-h": tok("--deck-h"), "--mini-h": tok("--mini-h"), "--key": tok("--key"),
    "--tab-row-h": collapsed ? decl("body.ui-v2.deck-collapsed", "--tab-row-h") : decl("body.ui-v2", "--tab-row-h"),
  };
}

test("the mini sits flush on the tab row and the content clears both, collapsed or not, at both insets", () => {
  /* BUILD-PLAN 2.4 items 4-5: content padding-bottom = deck-h + mini-h + safe-b
     + 24px, so the last row clears the mini; the tab row drops to 48 collapsed
     and the mini rides down with it, never over it.
     MUTATION: change the mini's bottom to `calc(var(--safe-b) + var(--s-3) +
     var(--deck-h) + 1px)` (not following the tab row) -> the collapsed rows
     leave a 16px gap and this fails.
     MUTATION 2: change `body.ui-v2.fp-open`'s padding to drop `var(--mini-h)` -> red. */
  for (const inset of [0, 34]) {
    for (const collapsed of [false, true]) {
      const v = tokens(inset, collapsed);
      const rowBottom = px(decl("body.ui-v2 .tab-bar", "bottom"), v);
      const rowTop = rowBottom + px(decl("body.ui-v2 .tab-bar", "height"), v);
      assert.strictEqual(rowTop - rowBottom, collapsed ? 48 : 64, "the tab row is 64, 48 collapsed");
      const miniBottom = px(decl("body.ui-v2 #foray-player.dial-mini", "bottom"), v);
      assert.strictEqual(miniBottom, rowTop + 1, "the mini sits on the 1px separator, flush on the tab row");
      const miniTop = miniBottom + px(decl("body.ui-v2 #foray-player.dial-mini > .fp-bar", "height"), v);
      assert.strictEqual(miniTop - miniBottom, 64);
      const pad = decl("body.ui-v2.fp-open", "padding-bottom");
      assert.strictEqual(pad.replace(/\s+/g, " "), "calc(var(--deck-h) + var(--mini-h) + var(--safe-b) + var(--s-6))", "the formula, verbatim");
      assert.ok(px(pad, v) >= miniTop + 8, `inset ${inset}${collapsed ? " collapsed" : ""}: content (${px(pad, v)}) clears the mini's top (${miniTop})`);
      const padNoMini = px(decl("body.ui-v2", "padding-bottom"), v);
      assert.ok(padNoMini >= rowTop + 8, `inset ${inset}: content clears the tab row alone (${padNoMini} vs ${rowTop})`);
    }
  }
});

test("the tab row: 32x4 persimmon indicator on --spring-settle, Fill when current, ultramarine 18px mono badge, labels fade collapsed, gone under the keyboard", () => {
  /* BUILD-PLAN 2.4 item 4.
     MUTATION: delete `.tab-bar[data-active="2"] .tab-bar__ind { ... }` -> the
     indicator never reaches Yours and this fails.
     MUTATION 2: delete `body.kb-open .tab-bar { display: none; }` -> red. */
  const ind = rule(".tab-bar__ind::before");
  assert.match(ind, /width:\s*var\(--s-8\)/);
  assert.match(ind, /height:\s*var\(--s-1\)/);
  assert.match(ind, /background:\s*var\(--persimmon\)/);
  assert.match(rule(".tab-bar__ind"), /transition:\s*transform var\(--d-settle\) var\(--spring-settle\)/);
  assert.match(rule('.tab-bar[data-active="1"] .tab-bar__ind'), /translateX\(100%\)/);
  assert.match(rule('.tab-bar[data-active="2"] .tab-bar__ind'), /translateX\(200%\)/);
  assert.match(rule('.tab-btn[aria-current="page"] .i--fill'), /opacity:\s*1/);
  assert.match(rule('.tab-btn[aria-current="page"] .i--bold'), /opacity:\s*0/);
  const badge = rule(".tab__badge");
  assert.match(badge, /background:\s*var\(--ultramarine\)/);
  assert.match(badge, /height:\s*18px/);
  assert.match(badge, /font:\s*500 11px\/1 var\(--font-mono\)/);
  assert.match(rule(".tab__badge[hidden]"), /display:\s*none/, "the badge's own display rule must not beat [hidden]");
  assert.match(rule("body.deck-collapsed .tab-btn .tab__label"), /opacity:\s*0/);
  assert.match(rule(".tab-btn .tab__label"), /transition:\s*opacity var\(--d-quick\)/);
  assert.match(decl("body.ui-v2.deck-collapsed", "--tab-row-h"), /var\(--key\)/);
  assert.match(rule(":root"), /--key:\s*48px/);
  assert.match(rule("body.kb-open .tab-bar"), /display:\s*none/);
  assert.match(rule("body.ui-v2 .tab-btn"), /min-height:\s*var\(--tap\)/, "each tab is a 44px target");
});

test("every transition the live deck declares is stilled by the one reduced-motion block", () => {
  /* PLAN.md / build-loop section 2: one reduced-motion block names every
     transition, and a new one is added to it in the same change. The legacy
     `ui-tokens` test cannot see the Dial section, so this suite walks the
     "DIAL DECK, LIVE" section itself.
     MUTATION: delete `.tab-bar__ind,` from the block's `transition: none` list
     -> the indicator's slide keeps moving under Reduce Motion and this fails.
     MUTATION 2: add `transition: opacity var(--d-quick)` to `.deck-toast` ->
     red, naming it. */
  const start = CSS.indexOf("DIAL DECK, LIVE");
  const end = CSS.indexOf("\n.sheet { position: fixed; z-index: 100", start);
  assert.ok(start > 0 && end > start, "fixture: the live-deck section is findable");
  const section = CSS.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "");
  const declared = [];
  for (const m of section.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/(?:^|;)\s*transition:/.test(m[2]) || /transition:\s*none/.test(m[2])) continue;
    for (const sel of m[1].split(",")) declared.push(sel.trim());
  }
  assert.ok(declared.length >= 6, `fixture: the section declares its transitions (${declared.length})`);
  const block = CSS.slice(CSS.indexOf("@media (prefers-reduced-motion: reduce)"));
  const stilled = new Set();
  for (const m of block.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/transition:\s*none/.test(m[2])) continue;
    for (const sel of m[1].split(",")) stilled.add(sel.trim());
  }
  assert.deepStrictEqual(declared.filter((sel) => !stilled.has(sel)), [], "a transition Reduce Motion does not stop");
});
