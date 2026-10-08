/* Pure-logic tests for the Dock's acceptance rules (lib/dock-rules.mjs). Synthetic measurements in, violations
 * out: no browser, no network, so CI can run it. The browser half (lib/dock-measure.mjs, dock-check.mjs) is
 * proven by running `node tools/ui-lab/dock-check.mjs` against the app; each rule below was also broken in
 * the app itself and seen to fire (the mutations are named in the build notes).
 *
 * Each test names, in its comment, the one-line mutation that makes it fail. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateRows, evaluateMiniRow, evaluateTabs, evaluateDecorations, evaluateBand, evaluateFocused,
  evaluateRedirects, evaluateCar, evaluateRecede, fadeAlphaAt, gutterFor, renderReport,
} from "./lib/dock-rules.mjs";

const rect = (top, height, left = 16, width = 343) => ({ top, bottom: top + height, left, right: left + width, width, height });
const rules = (list) => list.map((x) => x.rule);

/** A 375x667 Dock on a page with something playing, tall tab row: field hidden, mini 64, tabs 64. */
function dockMeasure(over = {}) {
  const m = {
    expect: { field: false, mini: true }, viewport: { w: 375, h: 667 }, safeBottom: 0, scheme: "dark", receded: false,
    dock: rect(527, 128),
    dockStyle: { radius: 24, backdrop: "blur(20px) saturate(1.4)" },
    rows: [
      { id: "dock-field", rect: null, visible: false, rim: false },
      { id: "dock-mini", rect: rect(527, 64), visible: true, rim: false },
      { id: "tab-bar", rect: rect(591, 64), visible: true, rim: true },
    ],
    colours: { text: "rgb(245, 238, 228)", text2: "rgb(185, 175, 163)", ember: "rgb(240, 166, 75)", glow: "rgb(138, 106, 78)" },
    ...over,
  };
  return m;
}

/* MUTATION: in evaluateRows drop the `!near(gap, 0)` check (or loosen EPS to 10) -> the 3px seam passes. */
test("rows: consecutive rows must share an edge, and the first and last must fill the Dock", () => {
  assert.deepEqual(evaluateRows("s", dockMeasure()), []);
  const seam = dockMeasure({ rows: [
    { id: "dock-field", rect: null, visible: false, rim: false },
    { id: "dock-mini", rect: rect(527, 64), visible: true, rim: false },
    { id: "tab-bar", rect: rect(594, 61), visible: true, rim: true },
  ] });
  assert.ok(rules(evaluateRows("s", seam)).includes("rows-share-an-edge"));
  const short = dockMeasure({ dock: rect(520, 135) });
  assert.ok(rules(evaluateRows("s", short)).includes("rows-fill-the-dock"), "a Dock taller than its rows leaves a band of bare veil");
});

/* MUTATION: drop the `i === 0 && r.rim` branch -> a stray line at the Dock's top edge goes unseen; drop the
   `i > 0 && !r.rim` one -> an undivided pair of rows does. */
test("rows: the rim divides every row but the first, and a first row that draws one is a stray line", () => {
  const stray = dockMeasure({ rows: [
    { id: "dock-field", rect: null, visible: false, rim: false },
    { id: "dock-mini", rect: rect(527, 64), visible: true, rim: true },
    { id: "tab-bar", rect: rect(591, 64), visible: true, rim: true },
  ] });
  assert.ok(evaluateRows("s", stray).some((x) => x.rule === "rim-between-rows" && /first row/.test(x.detail)));
  const undivided = dockMeasure({ rows: [
    { id: "dock-field", rect: null, visible: false, rim: false },
    { id: "dock-mini", rect: rect(527, 64), visible: true, rim: false },
    { id: "tab-bar", rect: rect(591, 64), visible: true, rim: false },
  ] });
  assert.ok(evaluateRows("s", undivided).some((x) => x.rule === "rim-between-rows" && /not divided/.test(x.detail)));
});

/* MUTATION: change the gutter expectation (`vw >= 393 ? 20 : 16` -> always 16) -> the 393 case fails; drop the
   bottom-gap check -> the Dock floating 4px off passes. */
test("rows: the Dock is inset by the gutter (16 at 375, 20 from 393), 12px above the safe area, with the Veil's radius and blur", () => {
  assert.equal(gutterFor(375), 16);
  assert.equal(gutterFor(393), 20);
  assert.equal(gutterFor(412), 20);
  const wide = dockMeasure({ viewport: { w: 393, h: 852 }, dock: rect(712, 128, 20, 353),
    rows: [
      { id: "dock-field", rect: null, visible: false, rim: false },
      { id: "dock-mini", rect: rect(712, 64, 20, 353), visible: true, rim: false },
      { id: "tab-bar", rect: rect(776, 64, 20, 353), visible: true, rim: true },
    ] });
  assert.deepEqual(evaluateRows("s", wide), []);
  const off = dockMeasure({ dock: rect(523, 128) });
  assert.ok(rules(evaluateRows("s", off)).includes("dock-floats-12px"));
  assert.ok(rules(evaluateRows("s", dockMeasure({ dock: rect(527, 128, 20, 335) }))).includes("dock-gutter-inset"));
  assert.ok(rules(evaluateRows("s", dockMeasure({ dockStyle: { radius: 16, backdrop: "none" } }))).includes("dock-radius"));
  assert.ok(rules(evaluateRows("s", dockMeasure({ dockStyle: { radius: 24, backdrop: "none" } }))).includes("dock-is-a-veil"));
});

/* MUTATION: take the `m.receded ? 36 : 64` branch out of the height table -> a receded row measured at 36
   fails as "expected 64", and a tall one at 64 as "expected 36". The field row is 48 and the mini 64. */
test("rows: heights are field 48, mini 64, tabs 64 - or 36 receded", () => {
  const discover = dockMeasure({ expect: { field: true, mini: true }, receded: true, dock: rect(507, 148),
    rows: [
      { id: "dock-field", rect: rect(507, 48), visible: true, rim: false },
      { id: "dock-mini", rect: rect(555, 64), visible: true, rim: true },
      { id: "tab-bar", rect: rect(619, 36), visible: true, rim: true },
    ] });
  assert.deepEqual(evaluateRows("s", discover), [], "Discover: 48 + 64 + 36 = 148");
  const tallOnDiscover = dockMeasure({ expect: { field: true, mini: true }, receded: true, dock: rect(499, 156),
    rows: [
      { id: "dock-field", rect: rect(499, 48), visible: true, rim: false },
      { id: "dock-mini", rect: rect(547, 64), visible: true, rim: true },
      { id: "tab-bar", rect: rect(611, 44), visible: true, rim: true },
    ] });
  assert.ok(rules(evaluateRows("s", tallOnDiscover)).includes("row-height"));
  assert.ok(rules(evaluateRows("s", dockMeasure({ expect: { field: true, mini: true } }))).includes("rows-present"), "a screen that must show the field row without one");
});

const miniMeasure = (over = {}) => ({
  rect: rect(527, 64), art: rect(537, 44, 26, 44), play: rect(535, 48, 256, 48), skip: rect(536, 44, 304, 44), info: rect(527, 64, 82, 160),
  titleLines: 1, titleFont: "600 14px DM Sans", titleFontIsLabel: true, showText: "Lex Fridman Podcast",
  playBg: "rgb(240, 166, 75)", skipBg: "rgba(0, 0, 0, 0)",
  progress: { rect: { top: 527, height: 2, bottom: 529 }, ariaHidden: "true", fillBg: "rgb(138, 106, 78)" },
  region: { role: "region", label: "Now playing: A title, A show" },
  ...over,
});

/* MUTATION: change the size table (Play 48 -> 44) or drop the order check -> the matching case below fails. */
test("mini row: 44 art, Ember Play 48 before a bare Fwd30 44, one-line label title, a show caption", () => {
  assert.deepEqual(evaluateMiniRow("s", { mini: miniMeasure(), colours: dockMeasure().colours }), []);
  const bad = evaluateMiniRow("s", { mini: miniMeasure({ play: rect(535, 44, 256, 44), skip: rect(536, 44, 250, 44), titleLines: 2, showText: "", playBg: "rgb(1, 2, 3)", skipBg: "rgb(240, 166, 75)" }), colours: dockMeasure().colours });
  assert.deepEqual(new Set(rules(bad)), new Set(["mini-sizes", "mini-order", "mini-title-one-line", "mini-show-caption", "mini-play-ember", "mini-skip-bare"]));
});

/* MUTATION: drop the `near(p.rect.height, 2, 0.1)` check -> a 4px line passes; drop the aria-hidden one -> a
   screen reader meets an unlabelled bar of colour; drop the glow one -> the line can be any colour. */
test("mini row: a 2px Glow progress line on the row's top edge, aria-hidden; the region is named for what plays", () => {
  const c = dockMeasure().colours;
  const fat = evaluateMiniRow("s", { mini: miniMeasure({ progress: { rect: { top: 527, height: 4, bottom: 531 }, ariaHidden: "true", fillBg: c.glow } }), colours: c });
  assert.deepEqual(rules(fat), ["mini-progress-2px"]);
  const low = evaluateMiniRow("s", { mini: miniMeasure({ progress: { rect: { top: 540, height: 2, bottom: 542 }, ariaHidden: null, fillBg: "rgb(9, 9, 9)" } }), colours: c });
  assert.deepEqual(new Set(rules(low)), new Set(["mini-progress-on-the-top-edge", "mini-progress-aria-hidden", "mini-progress-glow"]));
  const unnamed = evaluateMiniRow("s", { mini: miniMeasure({ region: { role: "group", label: "Now playing" } }), colours: c });
  assert.deepEqual(rules(unnamed), ["mini-region-label"]);
  const dead = evaluateMiniRow("s", { mini: miniMeasure({ info: rect(560, 30, 82, 160) }), colours: c });
  assert.deepEqual(rules(dead), ["mini-tap-opens"], "a title button that does not fill the row leaves dead bands");
});

const tabItems = (current = "today", over = {}) => ["today", "discover", "library"].map((key) => ({
  key, current: key === current, color: key === current ? "rgb(245, 238, 228)" : "rgb(185, 175, 163)",
  onOpacity: key === current ? 1 : 0, offOpacity: key === current ? 0 : 1, fillHref: `ui/icons.svg#i-${key}-fill`, regularHref: `ui/icons.svg#i-${key}`, ...over,
}));
const tabMeasure = (over = {}) => dockMeasure({ tabs: { items: tabItems(), iconBox: { width: 28, height: 28 }, labelOpacity: 1, afterTop: null, afterBottom: null }, ...over });

/* MUTATION: drop the fill-vs-regular check, or let the inert colour be --text -> the matching case fails. A
   tab change that is only a colour change does not survive greyscale; the glyph pair is the guarantee. */
test("tabs: three, one current; Fill glyph + --text for it, Regular + --text-2 for the rest, and the pair must differ", () => {
  assert.deepEqual(evaluateTabs("s", tabMeasure()), []);
  const m = tabMeasure();
  m.tabs.items = tabItems("today", {}).map((t) => ({ ...t, fillHref: t.regularHref }));
  assert.ok(rules(evaluateTabs("s", m)).includes("glyph-pair-differs"));
  const colourOnly = tabMeasure(); colourOnly.tabs.items = tabItems("discover").map((t) => ({ ...t, color: "rgb(245, 238, 228)" }));
  assert.ok(rules(evaluateTabs("s", colourOnly)).includes("inert-tab-text-2"));
  const two = tabMeasure(); two.tabs.items = tabItems("today").slice(0, 2);
  assert.ok(rules(evaluateTabs("s", two)).includes("three-tabs"));
  const both = tabMeasure(); both.tabs.items = tabItems("today").map((t) => ({ ...t, current: true }));
  assert.ok(rules(evaluateTabs("s", both)).includes("one-tab-current"));
});

/* MUTATION: take the `m.receded ? 24 : 28` branch out -> a receded row with 28px icons passes; drop the hit-area
   rule -> a 36px row with no ::after passes the 44px floor. */
test("tabs: icons 28 (24 receded), labels shown (faded receded), and a receded tab keeps a 44px target", () => {
  const receded = tabMeasure({ receded: true });
  receded.tabs.iconBox = { width: 24, height: 24 }; receded.tabs.labelOpacity = 0; receded.tabs.afterTop = -4; receded.tabs.afterBottom = -4;
  assert.deepEqual(evaluateTabs("s", receded), []);
  const big = tabMeasure({ receded: true }); big.tabs.iconBox = { width: 28, height: 28 }; big.tabs.labelOpacity = 1; big.tabs.afterTop = null; big.tabs.afterBottom = null;
  assert.deepEqual(new Set(rules(evaluateTabs("s", big))), new Set(["tab-icon-size", "tab-label", "receded-tab-44"]));
  const short = tabMeasure({ receded: true }); short.tabs.iconBox = { width: 24, height: 24 }; short.tabs.labelOpacity = 0; short.tabs.afterTop = -2; short.tabs.afterBottom = -2;
  assert.deepEqual(rules(evaluateTabs("s", short)), ["receded-tab-44"], "2px each way is a 40px target");
});

const decoMeasure = (over = {}) => dockMeasure({
  fade: { present: true, rect: rect(611, 56, 0, 375), display: "block", backgroundImage: "linear-gradient(rgba(0, 0, 0, 0) 0px, rgb(21, 17, 25) 32px)", stopPx: 32, pointerEvents: "none", ariaHidden: "true" },
  cast: { state: "playing", display: "block", backgroundImage: "radial-gradient(90% 260px at 50% 100px, oklab(0.66 0.06 0.1 / 0.14) 0%, rgba(0, 0, 0, 0) 100%)", rect: rect(291, 376, 0, 375), ariaHidden: "true" },
  ...over,
});

/* MUTATION: change the expected fade height (+44 -> +28) or its stop (32 -> 40) -> the fade cases fail; drop the
   `cast-hidden-with-no-mini` branch -> a cast lighting an idle Dock passes. */
test("decorations: the fade is safe + 12 + 44 tall and reaches the page colour at 32px; the cast is 260px at 14% (9% in Dawn), only with a mini row", () => {
  assert.deepEqual(evaluateDecorations("s", decoMeasure()), []);
  const f = decoMeasure(); f.fade.rect = rect(627, 40, 0, 375); f.fade.backgroundImage = "linear-gradient(rgba(0, 0, 0, 0) 0px, rgb(1, 1, 1) 60px)";
  assert.deepEqual(new Set(rules(evaluateDecorations("s", f))), new Set(["fade-height", "fade-reaches-bg-at-32px"]));
  const dawn = decoMeasure({ scheme: "light" });
  assert.ok(rules(evaluateDecorations("s", dawn)).includes("cast-alpha"), "Dawn's cast is 9%, not 14%");
  dawn.cast.backgroundImage = dawn.cast.backgroundImage.replace("0.14", "0.09");
  assert.deepEqual(evaluateDecorations("s", dawn), []);
  const idle = decoMeasure({ expect: { field: false, mini: false } });
  assert.ok(rules(evaluateDecorations("s", idle)).includes("cast-hidden-with-no-mini"));
  idle.cast = { state: "idle", display: "none", backgroundImage: "", rect: { bottom: 0 }, ariaHidden: "true" };
  assert.deepEqual(evaluateDecorations("s", idle), []);
  const stepping = decoMeasure(); stepping.cast.rect = rect(291, 260, 0, 375);
  assert.ok(rules(evaluateDecorations("s", stepping)).includes("cast-reaches-the-bottom"), "a 260px box ends 24px under the Dock and steps in the gutters");
});

/* MUTATION: in evaluateBand drop the fade from the opacity product (`rendered = t.opacity`) -> any text in the
   band fails; use the spec's 32 instead of the gradient's own stop -> a fade that stops at 80 is not seen. */
test("band: no text shows below the Dock's edge - judged THROUGH the fade, by the gradient's own stop", () => {
  const m = decoMeasure({ text: [{ text: "under the fade", top: 650, bottom: 664, left: 20, right: 90, opacity: 1 }] });
  const ok = evaluateBand("s", m);
  assert.deepEqual(ok.violations, [], "the fade is solid by the band, so the text there is not seen");
  assert.equal(ok.samples, 1);
  const lazy = decoMeasure({ text: m.text });
  lazy.fade.stopPx = 80;
  const bad = evaluateBand("s", lazy);
  assert.equal(bad.violations.length, 1);
  assert.match(bad.violations[0].detail, /in the band below the Dock's edge/);
  const hard = decoMeasure({ text: m.text }); hard.fade = { present: false };
  assert.equal(evaluateBand("s", hard).violations.length, 1, "no fade, no cover");
  const above = decoMeasure({ text: [{ text: "above", top: 400, bottom: 414, left: 20, right: 90, opacity: 1 }] });
  assert.equal(evaluateBand("s", above).samples, 0, "text above the band is not the rule's business");
  assert.ok(fadeAlphaAt(611, 611, 32) === 0 && fadeAlphaAt(611, 643, 32) === 1 && fadeAlphaAt(611, 627, 32) === 0.5);
});

/* MUTATION: drop `requireSamples` handling -> a page with nothing under the Dock passes the band rule vacuously. */
test("band: a screen where no text ever entered the band at any scroll position is a failure, not a pass", () => {
  assert.deepEqual(rules(evaluateBand("s", decoMeasure({ text: [] }), { requireSamples: true }).violations), ["band-sampled"]);
  assert.deepEqual(evaluateBand("s", decoMeasure({ text: [] })).violations, []);
});

/* MUTATION: drop any one branch of evaluateFocused -> the matching case goes unreported. */
test("focus: while the field has focus the Dock is the field row alone", () => {
  const good = { searching: true, field: { visible: true }, mini: { visible: false }, tabs: { visible: false } };
  assert.deepEqual(evaluateFocused("s", good), []);
  assert.deepEqual(new Set(rules(evaluateFocused("s", { searching: false, field: { visible: false }, mini: { visible: true }, tabs: { visible: true } }))),
    new Set(["field-focus-class", "field-stays", "mini-yields-to-focus", "tabs-yield-to-focus"]));
});

/* MUTATION: drop any one branch of evaluateRedirects. */
test("redirects: #/create -> Discover with the field focused in the Dock, #/starred-shows -> Library, #/interests -> Tuning", () => {
  const good = { create: { hash: "#/shows", activeId: "sh-input", fieldInDock: true }, starred: { hash: "#/library" }, interests: { hash: "#/tuning", heading: "Tuning" } };
  assert.deepEqual(evaluateRedirects("s", good), []);
  const bad = { create: { hash: "#/create", activeId: "", fieldInDock: false }, starred: { hash: "#/starred-shows" }, interests: { hash: "#/interests", heading: "Interests" } };
  assert.deepEqual(new Set(rules(evaluateRedirects("s", bad))), new Set(["create-redirects", "create-focuses-the-field", "create-field-in-the-dock", "starred-redirects", "interests-redirects", "interests-is-tuning"]));
});

/* MUTATION: drop any one branch of evaluateCar. */
test("car posture: a hold enters it, opens Now Playing, hides the Dock, fade and cast; collapsing ends it; a quick tap does not", () => {
  const good = { postureAfterHold: "car", sheetOpen: true, dockVisibleInCar: false, fadeVisibleInCar: false, castVisibleInCar: false, postureAfterClose: null, earlyReleasePosture: null };
  assert.deepEqual(evaluateCar("s", good), []);
  assert.deepEqual(new Set(rules(evaluateCar("s", { postureAfterHold: null, sheetOpen: false, dockVisibleInCar: true, fadeVisibleInCar: true, castVisibleInCar: false, postureAfterClose: "car", earlyReleasePosture: "car" }))),
    new Set(["long-press-enters-car", "car-opens-now-playing", "car-hides-the-dock", "car-hides-fade-and-cast", "collapse-ends-car", "early-release-no-car"]));
});

/* MUTATION: change the 80/280 constants or the easing regex -> the matching case fails. */
test("recede: after 80px of downward scroll, restored by any upward scroll, in 280ms ease-out", () => {
  const good = { at60Receded: false, at120Receded: true, after1pxUpReceded: false, afterRescrollReceded: true, atTopReceded: false, durationMs: 280, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" };
  assert.deepEqual(evaluateRecede("s", good), []);
  assert.deepEqual(new Set(rules(evaluateRecede("s", { at60Receded: true, at120Receded: false, after1pxUpReceded: true, afterRescrollReceded: false, atTopReceded: true, durationMs: 160, easing: "ease" }))),
    new Set(["no-recede-before-80", "recede-after-80", "restore-on-any-upward-scroll", "recede-again", "restore-at-top", "recede-280ms", "recede-e-out"]));
});

test("report: names every violated rule once with its screens, and says all clear when there are none", () => {
  assert.match(renderReport([], { screens: 4, checks: 40 }), /All clear/);
  const text = renderReport([{ rule: "row-height", screen: "a", detail: "x" }, { rule: "row-height", screen: "b", detail: "y" }], { screens: 2, checks: 2 });
  assert.match(text, /## row-height \(2\)/);
  assert.match(text, /\*\*2 violation\(s\)\*\*/);
});
