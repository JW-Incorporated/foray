/* The pure half of the car posture check: lib/car-rules.mjs reads measurements and returns violations. No browser, so this
 * runs in CI; car-check.mjs feeds the same functions with a real Chromium's numbers.
 *
 * AUDIT OF THE FIXTURE (CLAUDE.md, "a green test is not evidence until you have broken it"): `good()` is built from the
 * numbers the plan states, NOT from what the app happens to measure, so the fixture is not more forgiving than the spec.
 * Every test below starts from it, changes ONE thing, and asserts that exactly the named rule fires - and, where a rule
 * has two edges (24px clearance, the clamp at 800), both edges are tried. The mutation that breaks each is in its comment;
 * each was applied to lib/car-rules.mjs, seen red, and reverted. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateCar, evaluateEntered, evaluateSizes, evaluatePlayClearance, evaluateType, evaluateHidden, evaluateTitle,
  evaluateShortTitle, evaluateChip, evaluateInteractions, artFor, clampFor, NOT_RENDERED, renderReport,
} from "./lib/car-rules.mjs";

const rect = (w, h, bottom = 0) => ({ width: w, height: h, top: bottom - h, bottom, left: 0, right: w });

/** A clean measurement at a viewport, from the plan's numbers. */
function good(w = 393, h = 852) {
  const lines = 3;                                  // a long title runs its three lines at every height
  const art = h < 700 ? 180 : 240;                  // ... and under 700px tall a third line costs the artwork 20px
  return {
    viewport: { w, h },
    posture: "car",
    sheetOpen: true,
    dock: { "#dock": false, ".dock-fade": false, ".dock-cast": false, "#tab-bar": false },
    art: rect(art, art, 300),
    play: rect(112, 112, h - 32),
    playIcon: { width: 52 },
    skips: [rect(72, 72, h - 52), rect(72, 72, h - 52)],
    skipIcon: { width: 48 },
    title: { text: "A long enough title to need its lines", fontSize: 40, lineHeight: 45, clamp: lines, lines, truncated: false, scrollHeight: 45 * lines, clientHeight: 45 * lines, box: rect(300, 45 * lines, 500) },
    chip: { rendered: true, box: rect(88, 44, 60), fontSize: 17.5, lineHeight: 22.75, pressed: "true", label: "Car mode on. Leave car mode" },
    notRendered: Object.fromEntries(NOT_RENDERED.map((s) => [s, true])),
    scroller: { scrollHeight: h, clientHeight: h },
    slack: 40,
    headBottom: 56,
  };
}
const VIEWPORTS = [[393, 852], [375, 667]];
const rules = (list) => [...new Set(list.map((x) => x.rule))].sort();

test("both plan viewports are clean from the plan's own numbers", () => {
  /* MUTATION: change ART_SHORT_LONG_TITLE_PX from 180 to 190 in lib/car-rules.mjs -> red at 375x667.
     MUTATION: change SKIP_PX from 72 to 56 -> red at both. */
  for (const [w, h] of VIEWPORTS) assert.deepEqual(evaluateCar(`${w}x${h}`, good(w, h)), [], `${w}x${h}`);
  assert.equal(artFor(852), 240); assert.equal(artFor(700), 240); assert.equal(artFor(699), 200); assert.equal(artFor(667), 200);
  assert.equal(artFor(667, 3), 180, "a three-line title on a short screen"); assert.equal(artFor(852, 3), 240, "a tall screen keeps 240 under three lines");
  assert.equal(artFor(667, 2), 200, "two lines leave the short screen's 200");
  assert.equal(clampFor(852), 3); assert.equal(clampFor(800), 3); assert.equal(clampFor(799), 3); assert.equal(clampFor(667), 3);
});

test("Play's bottom edge must be at least 24px above the viewport bottom, at 393x852 and 375x667", () => {
  /* MUTATION: change PLAY_CLEARANCE_PX from 24 to 0 -> the 23px cases go green and this test goes red.
     MUTATION: drop the `m.viewport.h -` (measure from the top) -> red. This is round 1's clip: Play ended at the edge. */
  for (const [w, h] of VIEWPORTS) {
    const m = good(w, h);
    m.play = rect(112, 112, h - 24);
    assert.deepEqual(evaluatePlayClearance("x", m), [], `exactly 24px clears at ${h}`);
    m.play = rect(112, 112, h - 23);
    assert.deepEqual(rules(evaluatePlayClearance("x", m)), ["play-bottom-clearance"], `23px does not clear at ${h}`);
    m.play = rect(112, 112, h);
    assert.deepEqual(rules(evaluatePlayClearance("x", m)), ["play-bottom-clearance"], `a clipped Play at ${h}`);
    m.play = rect(112, 112, h + 40);
    assert.deepEqual(rules(evaluatePlayClearance("x", m)), ["play-bottom-clearance"], `a Play below the fold at ${h}`);
  }
  const m = good();
  m.play = null;
  assert.deepEqual(rules(evaluatePlayClearance("x", m)), ["play-bottom-clearance"], "no Play is a failure, not a pass");
});

test("the posture must fit without scrolling, so Play is never only reachable by scrolling the sheet", () => {
  /* MUTATION: delete the `fits-without-scrolling` line -> red. */
  const m = good();
  m.scroller = { scrollHeight: 900, clientHeight: 852 };
  assert.deepEqual(rules(evaluatePlayClearance("x", m)), ["fits-without-scrolling"]);
  m.scroller = { scrollHeight: 853, clientHeight: 852 };
  assert.deepEqual(evaluatePlayClearance("x", m), [], "one pixel of rounding is not a scroll");
});

test("artwork is 240, 200 under 700px tall, and 180 only where a short screen's title runs three lines", () => {
  /* MUTATION: change SHORT_BELOW_PX from 700 to 600 -> red (a 667 viewport expects 240 and the good fixture's 200 fails).
     MUTATION: make artFor ignore the viewport (return 240) -> red at 375x667.
     MUTATION: make artFor ignore titleLines (drop the ART_SHORT_LONG_TITLE_PX branch) -> red: the iteration-2 fix (a 667
     screen trades 20px of artwork for the title's third line) would then be asserted as a 200 artwork under a 3-line title. */
  const tall = good(393, 852);
  tall.art = rect(180, 180, 300);
  assert.deepEqual(rules(evaluateSizes("x", tall)), ["artwork-size"], "180 under a 3-line title is a short-screen trade, not a tall one");
  const short = good(375, 667);
  short.art = rect(240, 240, 300);
  assert.deepEqual(rules(evaluateSizes("x", short)), ["artwork-size"], "240 on a 667 screen is the old overflow");
  short.art = rect(200, 200, 300);
  assert.deepEqual(rules(evaluateSizes("x", short)), ["artwork-size"], "200 under a 3-line title is the iteration-1 build, which clipped the title to two lines");
  short.title.lines = 2; short.title.clamp = 3;
  assert.deepEqual(evaluateSizes("x", short), [], "a two-line title on a short screen keeps 200");
  tall.art = null;
  assert.deepEqual(rules(evaluateSizes("x", tall)), ["artwork-size"], "no artwork is a failure");
});

test("Play is 112, the skips 72, and their glyphs 52 and 48", () => {
  /* MUTATION: change PLAY_PX to 88 -> red.   MUTATION: change PLAY_GLYPH_PX to 36 -> red. */
  const m = good();
  m.play = rect(88, 88, 800);
  assert.deepEqual(rules(evaluateSizes("x", m)), ["play-size"], "88 is the normal Play");
  const s = good();
  s.skips = [rect(72, 72, 1), rect(56, 56, 1)];
  assert.deepEqual(rules(evaluateSizes("x", s)), ["skip-size"], "one skip left at 56");
  const none = good();
  none.skips = [];
  assert.deepEqual(rules(evaluateSizes("x", none)), ["skip-size"], "no skips found is a failure");
  const g = good();
  g.playIcon = { width: 36 };
  g.skipIcon = { width: 36 };
  assert.deepEqual(rules(evaluateSizes("x", g)), ["play-glyph-size", "skip-glyph-size"]);
});

test("type is x1.25 with unitless leading: title 40 on 45, label 17.5 on 22.75", () => {
  /* MUTATION: change TITLE_LEADING from 1.125 to 1.25 -> red.   MUTATION: change LABEL_PX to 14 -> red.
     The frozen-leading failure round 1 shipped (45px size, 36px leading) is the first case. */
  const m = good();
  m.title.lineHeight = 36;
  assert.deepEqual(rules(evaluateType("x", m)), ["title-leading"], "a leading frozen at the old 36px");
  const s = good();
  s.title.fontSize = 32; s.title.lineHeight = 36;
  assert.deepEqual(rules(evaluateType("x", s)), ["title-leading", "title-size"], "an unscaled title");
  const c = good();
  c.chip.fontSize = 14; c.chip.lineHeight = 18.2;
  assert.deepEqual(rules(evaluateType("x", c)), ["label-leading", "label-size"]);
  const none = good();
  none.chip = null;
  assert.deepEqual(rules(evaluateType("x", none)), ["label-size"], "no label to measure fails rather than passing");
});

test("the Dock, its fade, its cast and the tab bar are out, posture is on and the sheet is open", () => {
  /* MUTATION: drop the Object.entries(m.dock) loop -> red for the four cases.   MUTATION: change "car" to "on" -> red. */
  for (const sel of ["#dock", ".dock-fade", ".dock-cast", "#tab-bar"]) {
    const m = good();
    m.dock[sel] = true;
    assert.deepEqual(rules(evaluateEntered("x", m)), ["dock-hidden"], sel);
  }
  const off = good();
  off.posture = null;
  assert.deepEqual(rules(evaluateEntered("x", off)), ["posture-attribute"]);
  const shut = good();
  shut.sheetOpen = false;
  assert.deepEqual(rules(evaluateEntered("x", shut)), ["now-playing-opens-by-itself"]);
});

test("the why-line, secondary row, More handle, show notes and chapters are each not rendered", () => {
  /* MUTATION: remove ".ag-np-detail-handle" from NOT_RENDERED -> red (the handle case goes unchecked).
     MUTATION: treat a missing measurement as a pass (change `!(sel in m.notRendered)` to false) -> red. */
  for (const sel of NOT_RENDERED) {
    const m = good();
    m.notRendered[sel] = false;
    assert.deepEqual(rules(evaluateHidden("x", m)), ["not-rendered"], sel);
  }
  const m = good();
  delete m.notRendered[".fp-s-why"];
  assert.deepEqual(rules(evaluateHidden("x", m)), ["not-rendered"], "an unmeasured selector fails");
  assert.match(evaluateHidden("x", m)[0].detail, /was not measured/, "and says it was never measured, not that it rendered");
  for (const must of [".fp-s-why", ".ag-np-actions", ".ag-np-detail-handle", ".fp-s-desc", ".ag-np-clips"]) {
    assert.ok(NOT_RENDERED.includes(must), `${must} is part of the acceptance`);
  }
});

test("the title clamps to 3 lines at every height, and an ellipsis only appears where the clamp is reached", () => {
  /* MUTATION: make clampFor return 2 below 800px again -> red at 375x667 (the iteration-2 defect: the title ended in an
     ellipsis on line two while the artwork kept its 200).
     MUTATION: delete the no-ellipsis-beside-empty-room line -> red: this is the 393x852 failure of critique round 3,
     where a two-line clamp ended in an ellipsis with ~110px of empty Room below it. */
  const at852 = good(393, 852);
  at852.title.clamp = 2; at852.title.lines = 2; at852.title.truncated = true;
  assert.deepEqual(rules(evaluateTitle("x", at852)), ["no-ellipsis-beside-empty-room", "title-clamp"], "2 lines at 852 is the round-3 defect");
  at852.title.clamp = 3; at852.title.lines = 3; at852.title.truncated = true;
  assert.deepEqual(evaluateTitle("x", at852), [], "an ellipsis on the third line is the clamp doing its job");
  const at667 = good(375, 667);
  assert.deepEqual(evaluateTitle("x", at667), [], "three lines at 667 is the clamp");
  at667.title.clamp = 2; at667.title.lines = 2; at667.title.truncated = true;
  assert.deepEqual(rules(evaluateTitle("x", at667)), ["no-ellipsis-beside-empty-room", "title-clamp"], "2 lines at 667 is the iteration-1 build");
  at667.title.clamp = 3; at667.title.lines = 4;
  assert.deepEqual(rules(evaluateTitle("x", at667)), ["title-clamp"], "a count past the clamp is not a clamp");
  const justUnder = good(393, 799);
  justUnder.title.clamp = 2; justUnder.title.lines = 2;
  assert.deepEqual(rules(evaluateTitle("x", justUnder)), ["title-clamp"], "799 clamps to three as well");
});

test("a short title takes one line and shows no ellipsis", () => {
  /* MUTATION: delete the `m.title.lines > 1` line -> red for the wrapped case. */
  const m = good();
  m.title.text = "A short title"; m.title.lines = 1; m.title.truncated = false;
  assert.deepEqual(evaluateShortTitle("x", m), []);
  m.title.truncated = true;
  assert.deepEqual(rules(evaluateShortTitle("x", m)), ["short-title-untruncated"]);
  m.title.truncated = false; m.title.lines = 2;
  assert.deepEqual(rules(evaluateShortTitle("x", m)), ["short-title-untruncated"]);
});

test("the car chip is rendered, a 44px target, pressed and named for leaving", () => {
  /* MUTATION: change TAP_PX from 44 to 36 -> red.   MUTATION: drop the aria-pressed check -> red. */
  const m = good();
  assert.deepEqual(evaluateChip("x", m), []);
  m.chip.box = rect(88, 36, 60);
  assert.deepEqual(rules(evaluateChip("x", m)), ["chip-tap-target"], "a 36px chip is under the floor");
  const p = good();
  p.chip.pressed = "false";
  assert.deepEqual(rules(evaluateChip("x", p)), ["chip-pressed"]);
  const l = good();
  l.chip.label = "Car";
  assert.deepEqual(rules(evaluateChip("x", l)), ["chip-label"]);
  const gone = good();
  gone.chip.rendered = false;
  assert.deepEqual(rules(evaluateChip("x", gone)), ["chip-visible"]);
  assert.deepEqual(rules(evaluateChip("x", { ...good(), chip: null })), ["chip-visible"]);
});

test("the interactions: a short press does not enter, a hold does and fires the haptic, the chip and a collapse both leave", () => {
  /* MUTATION: delete the `hold-fires-the-haptic-hook` line -> red.   MUTATION: invert the early-release check
     (`!== null` to `=== null`) -> red. */
  const facts = () => ({ earlyReleasePosture: null, postureAfterHold: "car", sheetOpenAfterHold: true, hapticCalls: 1, postureAfterChip: null, sheetOpenAfterChip: true, chipRenderedAfterChip: false, postureAfterCollapse: null });
  assert.deepEqual(evaluateInteractions("x", facts()), []);
  const cases = [
    [{ earlyReleasePosture: "car" }, "early-release-does-not-enter"],
    [{ postureAfterHold: null }, "hold-enters-posture"],
    [{ sheetOpenAfterHold: false }, "hold-opens-now-playing"],
    [{ hapticCalls: 0 }, "hold-fires-the-haptic-hook"],
    [{ postureAfterChip: "car" }, "chip-leaves-posture"],
    [{ sheetOpenAfterChip: false }, "chip-keeps-the-sheet"],
    [{ chipRenderedAfterChip: true }, "chip-hides-outside-the-car"],
    [{ postureAfterCollapse: "car" }, "collapse-ends-posture"],
  ];
  for (const [change, rule] of cases) assert.deepEqual(rules(evaluateInteractions("x", { ...facts(), ...change })), [rule], rule);
});

test("a report names every violation, and says Clean only when there is none", () => {
  /* MUTATION: print "Clean." unconditionally -> red. */
  assert.match(renderReport([], { screens: 2, checks: 12 }), /Clean\./);
  const text = renderReport([{ rule: "play-size", screen: "a", detail: "Play is 88" }], { screens: 1, checks: 1 });
  assert.doesNotMatch(text, /Clean\./);
  assert.match(text, /\*\*play-size\*\* a: Play is 88/);
});
