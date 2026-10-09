/* Redesign 2026, ambient: car posture (BUILD-NOTES 4.2, BUILD-PLAN 2.2 screen 8).
 *
 * WHICH SUITE COVERS WHICH MECHANISM
 *   this file ......... what a DOM-less run can see: the stylesheet's numbers, the shipping and wiring facts, and the
 *                       gesture/posture logic of ui/car.js executed against a fake DOM with an injected clock.
 *   tools/ui-lab/car-check.test.mjs  the pure rules that read laid-out measurements (Play clearance, clamp, sizes), each
 *                       with the mutation that breaks it.
 *   tools/ui-lab/car-check.mjs  the same rules against the real app in Chromium (393x852 and 375x667), plus real pointer
 *                       input: not run by CI (no browser in `data-and-site`), run by the engineer before pushing.
 * Every test below names its one-line mutation; each was applied, seen red, and reverted. */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const css = read("ui/car.css");
const src = read("ui/car.js");
const client = read("player/client.js");
const html = read("index.html");

/* ---------------------------------------------------------------- a fake DOM small enough to be honest about */
class FakeEl {
  constructor(tag, ns) {
    this.tag = tag; this.ns = ns || null; this.attrs = new Map(); this.children = []; this.listeners = []; this.parent = null; this.className = ""; this.type = "";
    this.classList = { add: (c) => { if (!this.className.split(" ").includes(c)) this.className = `${this.className} ${c}`.trim(); } };
  }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  append(...nodes) { for (const n of nodes) { if (n && typeof n === "object") n.parent = this; this.children.push(n); } }
  insertBefore(node, ref) { node.parent = this; const i = this.children.indexOf(ref); if (i < 0) this.children.push(node); else this.children.splice(i, 0, node); return node; }
  addEventListener(type, fn, capture) { this.listeners.push({ type, fn, capture: Boolean(capture) }); }
  dispatch(type, init = {}) {
    const ev = { type, button: 0, clientX: 0, clientY: 0, target: this, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...init };
    for (const l of this.listeners.filter((x) => x.type === type && x.capture)) l.fn(ev);
    if (!ev.stopped) for (const l of this.listeners.filter((x) => x.type === type && !x.capture)) l.fn(ev);
    return ev;
  }
}

function load({ search = "", capacitor } = {}) {
  const documentElement = new FakeEl("html");
  const document = {
    documentElement,
    createElement: (t) => new FakeEl(t),
    createElementNS: (ns, t) => new FakeEl(t, ns),
    createTextNode: (text) => ({ text }),
  };
  const safeUrlCalls = [];
  const ctx = {
    document, location: { search }, URLSearchParams, setTimeout, clearTimeout,
    safeUrl: (u) => { safeUrlCalls.push(u); return u; },
  };
  ctx.window = ctx;
  if (capacitor) ctx.Capacitor = capacitor;
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: "ui/car.js" });
  return { car: ctx.window.AfterglowCar, documentElement, document, ctx, safeUrlCalls };
}

/** An injectable clock: timers are recorded, never run, until the test says so. */
function clock() {
  const timers = [];
  return {
    timers,
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer: (t) => { t.live = false; },
    fire: () => { for (const t of timers.filter((x) => x.live)) { t.live = false; t.fn(); } },
    live: () => timers.filter((x) => x.live).length,
  };
}

/* ---------------------------------------------------------------- shipping and wiring */
test("car posture ships after Now Playing in every lane and the client wires it at the four places it matters", () => {
  /* MUTATION: swap the two <link> lines in index.html (car.css before now-playing.css) -> red: the posture's 240 artwork
     would then lose to now-playing.css's is-long-title 180 on source order alone.
     MUTATION: remove "ui/car.css" from SHELL in tools/web/prepare-dist.mjs (or generate-manifest.mjs, or SHELL_FILES in
     prepare-webdir.mjs) -> red naming the file: a stylesheet that is not shipped is a posture with no layout.
     MUTATION: delete the `window.AfterglowCar?.leave(document)` in setExpanded's closed branch -> red (posture would
     outlive the sheet it opened, with the Dock gone and no chip to bring it back). */
  assert.match(html, /ui\/now-playing\.css">\s*<link rel="stylesheet" href="ui\/car\.css"/, "car.css loads directly after now-playing.css");
  assert.match(html, /ui\/now-playing\.js"><\/script>\s*<script src="ui\/car\.js"><\/script>/, "car.js loads directly after now-playing.js");
  for (const rel of ["tools/ci/generate-manifest.mjs", "tools/mobile/prepare-webdir.mjs", "tools/web/prepare-dist.mjs"]) {
    assert.match(read(rel), /"ui\/car\.css"/, `${rel} ships the stylesheet`);
  }
  assert.equal((client.match(/AfterglowCar\?\.adopt\(ui\)/g) || []).length, 2, "native and JS boot both adopt the chip");
  assert.match(client, /window\.AfterglowCar\?\.bindPress\(ui\.bar,/, "the mini row is the hold's surface");
  assert.match(client, /if \(!open\) \{\s*\/\*[^*]*\*\/\s*window\.AfterglowCar\?\.leave\(document\);\s*releaseBarAndTopbar\(\);/, "collapsing the sheet ends posture before focus returns to the bar");
  assert.match(client, /ui\.root\.hidden = true;\s*ui\.sheet\.hidden = true;\s*\/\*[^*]*\*\/\s*window\.AfterglowCar\?\.leave\(document\);/, "Stop ends posture too");
  assert.match(client, /if \(window\.AfterglowCar\?\.active\(document\)\) ui\.openSheet\?\.\(\);/, "?posture=car opens Now Playing once something is loaded");
  assert.match(client, /onHold: \(\) => \{\s*window\.AfterglowCar\.haptic\(\);\s*window\.AfterglowCar\.enter\(document\);\s*ui\.openSheet\(\);/, "a hold fires the haptic, enters, and opens the sheet");
  /* The Dock's tap-on-the-rest-of-the-row handler shares the predicate (`inBarControl`), so the transport buttons are
     named once. MUTATION: change ".fp-play, .fp-skip" to ".fp-play" in that const -> red. */
  assert.match(client, /const inBarControl = \(t\) => [^\n]*closest\("\.fp-play, \.fp-skip"\)/, "the two transport buttons are named once");
  assert.match(client, /bindPress\(ui\.bar, \{\s*isControl: inBarControl,/, "the two transport buttons never start the press");
});

/* ---------------------------------------------------------------- the stylesheet's numbers */
test("car.css carries the plan's numbers: artwork 240 / 200 / 180, Play 112, skips 72, glyphs 52 / 48, title clamp 3 at every height", () => {
  /* MUTATION: change Play's 112px to 111px -> red.   MUTATION: change the 699.98px breakpoint to 600px -> red (the
     200 artwork must start under 700, the number the plan states).   MUTATION: change the short screen's is-long-title 180px to 200px -> red (the title's third line is paid for with 20px of artwork).
     MUTATION: change the title's `-webkit-line-clamp: 3` to 2 -> red (an ellipsis on line two at 375x667). */
  /* MUTATION (iteration 4): restore the combined `[data-posture="car"] .ag-np, [data-posture="car"] .ag-np.is-long-title { --np-art: 240px; }` -> red (the sleeve would stay 240 under a three-line title and the gaps would squeeze instead). */
  assert.match(css, /\[data-posture="car"\] \.ag-np \{ --np-art: 240px; \}\s*\[data-posture="car"\] \.ag-np\.is-long-title \{ --np-art: 180px; \}\s*@media/, "240, and 180 under a three-line title on a tall screen too");
  assert.match(css, /@media \(max-height: 699\.98px\) \{\s*\[data-posture="car"\] \.ag-np \{ --np-art: 200px; \}\s*\[data-posture="car"\] \.ag-np\.is-long-title \{ --np-art: 180px; \}/, "200 under 700px tall, 180 when a short screen's title runs three lines");
  assert.match(css, /\.ag-np-play\.fp-big \{ width: 112px; height: 112px; min-width: 112px; min-height: 112px; \}/, "Play 112, its minimum too");
  assert.match(css, /\.ag-np-skip \{ width: 72px; height: 72px; min-width: 72px; min-height: 72px; \}/, "skips 72, their minimum too");
  assert.match(css, /\.ag-np-play \.icon \{ --icon-size: 52px; \}/);
  assert.match(css, /\.ag-np-skip \.icon \{ --icon-size: 48px; \}/);
  assert.match(css, /\[data-posture="car"\] \.ag-np\.fp-sheet \.fp-s-title \{ -webkit-line-clamp: 3; line-clamp: 3; \}/, "three lines at every height");
  assert.doesNotMatch(css, /-webkit-line-clamp: 2/, "no two-line clamp survives in car.css");
});

test("car.css does not render the why-line, the secondary row, the More handle, the show notes or the chapters", () => {
  /* MUTATION: delete `.ag-np-detail-handle` from the hidden list -> red.   MUTATION: delete `.fp-s-why` from it -> red.
     (The detail posture is one container: actions row, chapters, sources, show notes, Up next and the legacy action
     row all live inside `.ag-np-detail`, so hiding it is hiding all of them.) */
  const m = css.match(/((?:\[data-posture="car"\] \.ag-np\.fp-sheet [^,{]+,\s*)+)\[data-posture="car"\] \.ag-np\.fp-sheet \.fp-s-why \{ display: none; \}/);
  assert.ok(m, "one display:none rule names the posture's hidden set");
  const names = [...(m[0].matchAll(/\.ag-np\.fp-sheet (\.[\w-]+)/g))].map((x) => x[1]).sort();
  assert.deepStrictEqual(names, [".ag-np-detail", ".ag-np-detail-handle", ".fp-s-why"]);
  const ui = read("ui/now-playing.js");
  assert.match(ui, /detail\.append\(actionRow, segmentsSection, sourcesSection, notesSection, upNextSection, ui\.clips, ui\.row2/, "the container really does hold the actions, chapters, notes and the legacy row");
});

test("the dots stay in the car head and lead out of the car to the detail actions (iteration 2, fidelity: trailing overflow control)", () => {
  /* The prototype keeps its "..." in car posture (its hide list is sec-row, np-detail, handle, why). Without it the head
     is left-heavy, the Car chip is not centred between two controls, and speed / sleep / bookmark / share lose their
     entry point. The build's detail is not drawn in the car, so the dots end posture first.
     MUTATION: add `.ag-np-more-btn` back to car.css or car.js -> red (no car rule may name the dots).
     MUTATION: delete the `window.AfterglowCar?.leave(document);` line in openDetail (ui/now-playing.js) -> red: the dots
     would scroll to a container that is display:none and look dead.
     Harness audit: the check reads the source of both files because the fake DOM here has no layout; the browser half,
     tools/ui-lab/car-check.mjs, measures the head. */
  assert.ok(!/ag-np-more-btn/.test(css), "no car rule hides or restyles the dots");
  assert.ok(!/ag-np-more-btn/.test(src), "car.js adds no hiding class to the dots");
  const ui = read("ui/now-playing.js");
  assert.match(ui, /const openDetail = \(\) => \{\s*\/\*[^*]*\*\/\s*window\.AfterglowCar\?\.leave\(document\);\s*detail\.scrollIntoView/, "openDetail ends posture before it scrolls");
  assert.match(ui, /moreMenuBtn\.addEventListener\("click", openDetail\)/, "the dots run openDetail");
  assert.match(css, /\.ag-np-head \{ display: grid; grid-template-columns: 1fr auto 1fr; \}/, "1fr / auto / 1fr: the chip is centred whatever the outer controls weigh");
  /* MUTATION: delete the `justify-self: end` rule -> red (the dots sit against the chip, not at the trailing edge, and the head reads lopsided again). */
  assert.match(css, /\.ag-np-head \.ag-np-car-chip \+ \.ag-np-icon-btn \{ justify-self: end; \}/, "the dots take the trailing edge, mirroring the chevron");
});

test("the car's artwork holds its step when paused and its lit-art cast is one soft ring (iteration 2, fidelity: artwork size and halo)", () => {
  /* MUTATION: delete the `transform: none` paused rule in car.css -> red (the 240 step renders ~226 whenever paused,
     which is what the judged render showed: 224).
     MUTATION: change the cast's `var(--lit-mix)` to `calc(var(--lit-mix) + 25%)` -> red (the bright rim comes back).
     MUTATION: delete the forced-colors restatement -> red (the car selector outranks now-playing.css's drop).
     Harness audit: now-playing.css declares the paused 0.94 at specificity (0,5,0)+; the test pins the car selector's
     whole chain, not only the declaration, and the browser half measures the sleeve while paused. */
  assert.match(css, /\[data-posture="car"\] \.ag-np\.is-paused\.fp-sheet \.ag-np-art-swap > img:not\(\.ag-np-art-out\):not\(\.ag-np-art-in\),\s*\[data-posture="car"\] \.ag-np\.is-paused\.fp-sheet \.ag-np-collage,\s*\[data-posture="car"\] \.ag-np\.is-paused\.fp-sheet \.ag-np-halo \{ transform: none; \}/);
  const cast = css.match(/\.ag-np-art-swap > \.lit-art \{ box-shadow: ([^;]*); \}/);
  assert.ok(cast, "car.css restates the lit-art cast");
  assert.strictEqual(cast[1], "0 0 var(--lit-r) calc(var(--lit-r) / -4) color-mix(in oklab, var(--art-glow, var(--glow)) var(--lit-mix), transparent)", "one ring, the art's colour at the token's mix, no second ring, no mix boost and no black drop (iteration 3)");
  /* MUTATION (iteration 3): put `var(--shadow-1), ` back at the front of the cast -> red (the thin dark rim under the sleeve returns).
     MUTATION: change the grabber rule to `var(--text-3)` / `opacity: .7` -> red (the dismiss handle sinks into the Glow-tinted Room). */
  assert.doesNotMatch(cast[1], /shadow/, "no black shadow token in the car's lit-art cast");
  assert.match(css, /\[data-posture="car"\] \.ag-np\.fp-sheet \.ag-np-head \.fy-grab \{ top: -6px; background: var\(--text-2\); opacity: 1; \}/, "the grabber is lifted above the Room and sits at the prototype's -6px");
  /* MUTATION: delete the `border: 0` rule -> red (styles.css's 1px --line border on .fp-s-art draws a dark edge round the lit sleeve). */
  assert.match(css, /\.ag-np-art-swap > \.lit-art \{ border: 0; \}/, "the lit sleeve has no border: its edge is its own colour");
  assert.match(css, /@media \(prefers-reduced-transparency: reduce\) \{ \[data-posture="car"\][^}]*box-shadow: none; \} \}/, "dropped under reduced transparency, to nothing rather than a black rim");
  assert.match(css, /@media \(forced-colors: active\) \{ \[data-posture="car"\][^}]*box-shadow: none; \} \}/, "dropped under forced colours");
});

test("car.css keeps Play above the foot of the screen and draws the chip as a 44px target", () => {
  /* MUTATION: delete the `.ag-np-first` padding-bottom rule -> red here, and play-bottom-clearance goes red in
     tools/ui-lab/car-check.mjs at both viewports (verified: Play ends 0px above the bottom).
     MUTATION: change the chip's `min-height: var(--tap)` to 36px -> red. */
  assert.match(css, /\.ag-np-first \{ padding-bottom: calc\(var\(--safe-bottom\) \+ var\(--s-8\)\); \}/, "32px plus the safe area under the transport, now the More handle is gone");
  assert.match(css, /\.ag-np-car-chip \{ display: none; \}/, "the chip is hidden outside the car");
  assert.match(css, /\.ag-np-car-chip \{[^}]*min-height: var\(--tap\);[^}]*color: var\(--text\);/s);
  assert.match(css, /\.ag-np-car-chip::before \{[^}]*inset: 4px 0;[^}]*background: var\(--bg2\);/s, "a 36px pill inside the 44px box");
  assert.match(css, /\.ag-np-head \{ display: grid; grid-template-columns: 1fr auto 1fr; \}/, "the chip sits in the middle of the head, as in the prototype");
  assert.match(css, /\[data-posture="car"\] #tab-bar \{ display: none; \}/, "today's tab bar leaves with the Dock");
});

test("car.css adds no motion, no colour literal and no inline-style route", () => {
  /* MUTATION: add `transition: opacity 1s` anywhere in ui/car.css -> red (a motion not named in the one reduced-motion
     block).   MUTATION: add `color: #fff` -> red. */
  assert.doesNotMatch(css, /\b(transition|animation)\b\s*:/, "no motion: the one reduced-motion block in tokens.css has nothing to name");
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/, "colours come from tokens");
  assert.doesNotMatch(css, /@media\s*\(prefers-reduced-motion/, "one reduced-motion block, and it lives in tokens.css");
  assert.doesNotMatch(src, /\.style\b|innerHTML|insertAdjacentHTML|setAttribute\("style"/, "no inline style, no markup strings");
  assert.doesNotMatch(src, /localStorage|sessionStorage|fetch\(|XMLHttpRequest/, "no storage and no network: posture is one attribute");
  assert.equal(read("ui/tokens.css").match(/@media\s*\(prefers-reduced-motion:\s*reduce\)/g).length, 1);
});

/* ---------------------------------------------------------------- ui/car.js, executed */
test("?posture=car turns posture on at load, and nothing else does", () => {
  /* MUTATION: change `=== "car"` in agCarFromSearch to `.includes("car")` -> red ("cars" would qualify).
     MUTATION: delete the load-time `agCarEnter()` line -> red. */
  const on = load({ search: "?posture=car" });
  assert.strictEqual(on.documentElement.getAttribute("data-posture"), "car", "the very first paint already has it");
  for (const search of ["", "?posture=cars", "?posture=", "?mode=car", "?posture=CAR"]) {
    assert.strictEqual(load({ search }).documentElement.getAttribute("data-posture"), null, search || "(no query)");
  }
  assert.strictEqual(on.car.fromSearch("?a=1&posture=car"), true);
  assert.strictEqual(on.car.fromSearch("?posture=car2"), false);
});

test("enter and leave are one attribute, idempotent, and say whether they changed anything", () => {
  /* MUTATION: make agCarLeave remove the attribute without checking agCarActive -> red (it would report a change that
     did not happen, and the chip sync would run for nothing).   MUTATION: set "car-mode" instead of "car" -> red. */
  const { car, documentElement } = load();
  assert.strictEqual(car.active(), false);
  assert.strictEqual(car.enter(), true);
  assert.strictEqual(documentElement.getAttribute("data-posture"), "car");
  assert.strictEqual(car.enter(), false, "entering twice changes nothing");
  assert.strictEqual(car.active(), true);
  assert.strictEqual(car.leave(), true);
  assert.strictEqual(documentElement.getAttribute("data-posture"), null);
  assert.strictEqual(car.leave(), false, "leaving twice changes nothing");
});

test("a 600ms hold fires once; a release, a drift past 10px, a transport button or a secondary button never does", () => {
  /* MUTATION: change AG_CAR_HOLD_MS from 600 to 599 -> red.   MUTATION: delete the slop check in pointermove -> red
     (drift).   MUTATION: delete `|| isControl(e.target)` -> red (a press on Play would enter).   MUTATION: delete the
     `pointerup` cancel (drop "pointerup" from the cancel loop) -> red (a tap would fire the hold later).
     MUTATION: change `(e.button ?? 0) !== 0` to `false` -> red (a right-click would start a press). */
  const press = (bar, clk, over = {}) => bar.dispatch("pointerdown", { clientX: 100, clientY: 100, ...over });
  const mk = (opts = {}) => {
    const { car } = load();
    const bar = new FakeEl("div");
    const clk = clock();
    let holds = 0;
    car.bindPress(bar, { isControl: (t) => t.isControl === true, onHold: () => { holds++; }, setTimer: clk.setTimer, clearTimer: clk.clearTimer, ...opts });
    return { car, bar, clk, holds: () => holds };
  };

  let t = mk();
  assert.strictEqual(t.car.HOLD_MS, 600);
  press(t.bar, t.clk);
  assert.strictEqual(t.clk.live(), 1, "the press armed one timer");
  assert.strictEqual(t.clk.timers[0].ms, 600, "armed for 600ms exactly");
  assert.strictEqual(t.holds(), 0, "nothing happens before it fires");
  t.clk.fire();
  assert.strictEqual(t.holds(), 1, "the hold fires once");
  t.clk.fire();
  assert.strictEqual(t.holds(), 1, "and only once");

  t = mk(); press(t.bar, t.clk); t.bar.dispatch("pointerup"); t.clk.fire();
  assert.strictEqual(t.holds(), 0, "released early: a tap");

  for (const type of ["pointercancel", "pointerleave"]) {
    t = mk(); press(t.bar, t.clk); t.bar.dispatch(type); t.clk.fire();
    assert.strictEqual(t.holds(), 0, `${type} cancels`);
  }

  t = mk(); press(t.bar, t.clk); t.bar.dispatch("pointermove", { clientX: 110, clientY: 90 }); t.clk.fire();
  assert.strictEqual(t.holds(), 1, "10px of drift in each axis is still a hold (the slop is a limit, not a point)");
  t = mk(); press(t.bar, t.clk); t.bar.dispatch("pointermove", { clientX: 111, clientY: 100 }); t.clk.fire();
  assert.strictEqual(t.holds(), 0, "11px is a swipe");
  t = mk(); press(t.bar, t.clk); t.bar.dispatch("pointermove", { clientX: 100, clientY: 89 }); t.clk.fire();
  assert.strictEqual(t.holds(), 0, "11px vertically too");

  t = mk(); press(t.bar, t.clk, { target: { isControl: true } }); t.clk.fire();
  assert.strictEqual(t.holds(), 0, "a press that starts on Play or a skip is theirs");
  t = mk(); press(t.bar, t.clk, { button: 2 }); t.clk.fire();
  assert.strictEqual(t.holds(), 0, "only the primary button");
});

test("the click that ends a hold is swallowed in the capture phase, once; a later tap still opens", () => {
  /* MUTATION: register the swallowing listener without the capture flag (drop the trailing `true`) -> red: the title
     button would see the click first and toggle the sheet the hold just opened shut.
     MUTATION: delete `fired = false` inside the swallowing listener -> red (the next tap would be eaten too).
     MUTATION: delete `fired = false` in pointerdown -> covered below (a new press must reset a stale flag). */
  const { car } = load();
  const bar = new FakeEl("div");
  const clk = clock();
  car.bindPress(bar, { onHold: () => {}, setTimer: clk.setTimer, clearTimer: clk.clearTimer });
  const swallowers = bar.listeners.filter((l) => l.type === "click");
  assert.strictEqual(swallowers.length, 1);
  assert.strictEqual(swallowers[0].capture, true, "capture phase, before the target's own handlers");

  bar.dispatch("pointerdown", { clientX: 5, clientY: 5 });
  clk.fire();
  const swallowed = bar.dispatch("click");
  assert.ok(swallowed.defaultPrevented && swallowed.stopped, "the click after a hold is stopped");
  const next = bar.dispatch("click");
  assert.ok(!next.defaultPrevented && !next.stopped, "the next click is an ordinary tap");

  /* A hold whose click never reached the bar (the sheet covered it) leaves the flag set; the next press resets it. */
  bar.dispatch("pointerdown", { clientX: 5, clientY: 5 });
  clk.fire();
  bar.dispatch("pointerdown", { clientX: 5, clientY: 5 });
  bar.dispatch("pointerup");
  const tap = bar.dispatch("click");
  assert.ok(!tap.defaultPrevented && !tap.stopped, "a fresh press clears a stale swallow flag");

  const menu = bar.dispatch("contextmenu");
  assert.ok(menu.defaultPrevented, "a held artwork raises no image menu");
});

test("the haptic hook is the Capacitor medium impact when the shell has it, and a quiet no-op when it does not", () => {
  /* MUTATION: change style "MEDIUM" to "LIGHT" -> red.   MUTATION: remove the try/catch in agCarHaptic -> red (a throwing
     plugin would block the posture change). */
  const calls = [];
  const withPlugin = load({ capacitor: { Plugins: { Haptics: { impact: (o) => calls.push(o) } } } });
  withPlugin.car.haptic();
  assert.deepStrictEqual(calls.map((o) => o.style), ["MEDIUM"]);
  assert.doesNotThrow(() => load().car.haptic(), "web and lab: no plugin, no error");
  assert.doesNotThrow(() => load({ capacitor: { Plugins: { Haptics: { impact: () => { throw new Error("boom"); } } } } }).car.haptic(), "a throwing plugin is swallowed");
});

test("adopt puts one named chip before the dots; it reads the posture and its click leaves", () => {
  /* MUTATION: drop the `ui.carChip` guard at the top of agCarAdopt -> red (a second adopt would add a second chip).
     MUTATION: change the sprite reference from #i-car to #i-car-profile -> red.   MUTATION: remove the aria-pressed
     sync from agCarSyncChip -> red. */
  const { car, documentElement, safeUrlCalls } = load();
  const grabZone = new FakeEl("div");
  const close = new FakeEl("button");
  const more = new FakeEl("button");
  grabZone.append(close, more);
  let focused = null;
  close.focus = () => { focused = close; };
  const ui = { grabZone, moreMenuBtn: more, closeBtn: close };
  car.adopt(ui);
  car.adopt(ui);
  const chips = grabZone.children.filter((c) => c.className && c.className.includes("ag-np-car-chip"));
  assert.strictEqual(chips.length, 1, "adopting twice adds one chip");
  assert.strictEqual(grabZone.children.indexOf(chips[0]), grabZone.children.indexOf(more) - 1, "directly before the dots");
  assert.strictEqual(more.className, "", "the dots are left alone: they stay visible in the car");
  assert.match(chips[0].getAttribute("aria-label"), /leave car mode/i, "named for what it does");
  assert.strictEqual(chips[0].getAttribute("aria-pressed"), "false");
  assert.deepStrictEqual([...safeUrlCalls], ["ui/icons.svg#i-car"], "the sprite reference crosses safeUrl()");
  car.enter();
  assert.strictEqual(chips[0].getAttribute("aria-pressed"), "true", "pressed because posture is on");
  chips[0].dispatch("click");
  assert.strictEqual(documentElement.getAttribute("data-posture"), null, "the chip leaves");
  assert.strictEqual(chips[0].getAttribute("aria-pressed"), "false");
  /* MUTATION (focus): delete the `stable.focus()` line in the chip's click handler (ui/car.js) -> red: the chip is
     display:none the instant posture ends, focus falls to <body> inside the still-open modal sheet. */
  assert.strictEqual(focused, close, "focus moves to the close chevron before the chip stops rendering");
  const bare = new FakeEl("div");
  const play = new FakeEl("button");
  let playFocused = false;
  play.focus = () => { playFocused = true; };
  car.adopt({ grabZone: bare, playBtn: play });
  car.enter();
  bare.children[0].dispatch("click");
  assert.ok(playFocused, "Play is the fallback when there is no close chevron");
});
