/* Pure-logic tests for lib/fidelity.mjs (region matching, delta math, screens.json
 * parsing, run planning, side-by-side image, report). No browser, no network:
 * boxes and PNGs are synthetic. The render path (fidelity.mjs driving walk.mjs) is
 * covered by the sanity runs in README.md ("Fidelity"), not by CI.
 *
 * Each test names the one-line mutation (in lib/fidelity.mjs) that makes it fail;
 * every one was applied, run and reverted when this file was written. Which suite
 * covers which mechanism: delta sign and union -> tests 1-2; one-sided regions and
 * the gate -> 3-5; screens.json shape and the shared-app-step bug -> 6-8; image
 * composition -> 9; report content -> 10. */
import test from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import {
  boxDelta, summarizeMeasure, compareRegion, summarizeRegions, failingRegions,
  parseScreens, planRun, selectorsFor, compareScreen, sideBySide, buildReport, renderMarkdown,
} from "./lib/fidelity.mjs";

const B = (x, y, w, h) => ({ x, y, w, h });

test("1. delta is app minus prototype, per component, and max is the largest absolute one", () => {
  // MUTATION: in boxDelta, swap to `proto.x - app.x` (sign flips) or drop Math.abs from the max.
  const d = boxDelta(B(10, 20, 100, 50), B(16, 12, 90, 54));
  assert.deepEqual({ dx: d.dx, dy: d.dy, dw: d.dw, dh: d.dh }, { dx: 6, dy: -8, dw: -10, dh: 4 });
  assert.equal(d.max, 10);
  assert.equal(boxDelta(B(0, 0, 10, 10), B(0, 0, 10, 10)).max, 0);
});

test("2. 'all' mode is the union of every visible match plus a count; 'first' is the first match only", () => {
  // MUTATION: in summarizeMeasure, replace `Math.max(...x1)`'s partner so the union uses Math.min for y1 (or return `first` for mode "all").
  const boxes = [B(0, 100, 50, 20), B(0, 130, 60, 20), B(10, 160, 40, 20), B(0, 0, 0, 0)];
  const all = summarizeMeasure(boxes, "all");
  assert.deepEqual(all.box, B(0, 100, 60, 80));
  assert.equal(all.count, 3, "the zero-size box is not a match");
  assert.deepEqual(all.item, { w: 50, h: 20 });
  const first = summarizeMeasure(boxes, "first");
  assert.deepEqual(first.box, B(0, 100, 50, 20));
  assert.equal(summarizeMeasure([], "all").box, null);
});

test("3. a region on one side only is reported as such, never dropped or compared against nothing", () => {
  // MUTATION: in compareRegion, return status "both" (with a NaN delta) when `a` is null, or swap the prototype-only / app-only branches.
  const m = summarizeMeasure([B(0, 0, 10, 10)]);
  const none = summarizeMeasure([]);
  assert.equal(compareRegion("r", m, none).status, "prototype-only");
  assert.equal(compareRegion("r", none, m).status, "app-only");
  assert.equal(compareRegion("r", none, none).status, "neither");
  assert.equal(compareRegion("r", undefined, m).status, "app-only", "a region with no selector on a side is undefined there");
  assert.equal(compareRegion("r", m, m).status, "both");
});

test("4. 'all' regions also compare count and first-item size, and the worst of those counts toward max", () => {
  // MUTATION: in compareRegion, delete the `out.delta.max = Math.max(...)` line or compute countDelta as p.count - a.count.
  const p = summarizeMeasure([B(0, 0, 100, 40), B(0, 40, 100, 40)], "all");
  const a = summarizeMeasure([B(0, 0, 100, 90), B(0, 90, 100, 90), B(0, 180, 100, 90)], "all");
  const r = compareRegion("rows", p, a, "all");
  assert.equal(r.countDelta, 1);
  assert.deepEqual(r.itemDelta, { dw: 0, dh: 50 });
  assert.equal(r.delta.dh, 190, "union height 80 -> 270");
  const same = compareRegion("rows", p, summarizeMeasure([B(0, 0, 100, 40), B(0, 40, 100, 80)], "all"), "all");
  assert.equal(same.delta.max, 40, "first items equal, union differs by the second item's height");
  const rows = (...hs) => { let y = 0; return summarizeMeasure(hs.map((h) => { const b = B(0, y, 100, h); y += h; return b; }), "all"); };
  const itemOnly = compareRegion("rows", rows(40, 40), rows(20, 20, 40), "all");
  assert.equal(itemOnly.delta.dh, 0, "same union height (80)");
  assert.equal(itemOnly.delta.max, 20, "a smaller first row alone still counts toward max");
});

test("5. the gate fails on delta over the limit (strictly) and on one-sided regions; no limit means no gate", () => {
  // MUTATION: in failingRegions, change `>` to `>=` (the boundary case below), or drop the prototype-only/app-only branch, or default maxRegionDelta null to 0.
  const m = (b) => summarizeMeasure([b]);
  const regions = [
    compareRegion("ok", m(B(0, 0, 10, 10)), m(B(8, 0, 10, 10))),
    compareRegion("far", m(B(0, 0, 10, 10)), m(B(30, 0, 10, 10))),
    compareRegion("gone", m(B(0, 0, 10, 10)), summarizeMeasure([])),
  ];
  const screens = [{ id: "home", viewport: "393x852", regions }];
  assert.deepEqual(failingRegions(screens, null), []);
  const f = failingRegions(screens, 8);
  assert.deepEqual(f.map((x) => x.region), ["far", "gone"], "exactly 8px is within a limit of 8");
  assert.match(f[0].reason, /30px > 8px/);
  assert.equal(failingRegions(screens, 30).length, 1, "only the one-sided region remains");
});

test("6. summarizeRegions counts compared and missing, with the mean and worst delta of the compared ones", () => {
  // MUTATION: in summarizeRegions, compute meanDelta over all regions (not just `both`) or pick the smallest as worst.
  const m = (b) => summarizeMeasure([b]);
  const rs = [
    compareRegion("a", m(B(0, 0, 10, 10)), m(B(2, 0, 10, 10))),
    compareRegion("b", m(B(0, 0, 10, 10)), m(B(0, 10, 10, 10))),
    compareRegion("c", m(B(0, 0, 10, 10)), summarizeMeasure([])),
  ];
  const s = summarizeRegions(rs);
  assert.deepEqual({ c: s.compared, p: s.prototypeOnly, w: s.worst, max: s.maxDelta, mean: s.meanDelta }, { c: 2, p: 1, w: "b", max: 10, mean: 6 });
});

const good = () => ({
  direction: "x",
  screens: {
    home: { title: "Today", prototype: { route: "#/home" }, app: { state: "returning", step: "home" }, regions: { header: { prototype: ".top", app: ".topbar" }, rows: { prototype: ".row", app: ".ep-row", mode: "all" }, hero: { prototype: ".hero", app: null } } },
    "now-playing": { prototype: { route: "#/now-playing" }, app: { state: "player", step: "now-playing" }, regions: {} },
    "now-playing-paused": { prototype: { route: "#/now-playing/paused" }, app: { state: "player", step: "now-playing" }, regions: {} },
    settings: { prototype: { route: "#/settings" }, app: null, regions: {} },
  },
});

test("7. screens.json is validated: bad ids, routes, duplicate routes, modes and half-specified app refs are refused by name", () => {
  // MUTATION: in parseScreens, delete the `routes.has(route)` check, or loosen the route regex to accept any string, or drop the mode check.
  assert.equal(parseScreens(good()).screens.length, 4);
  const bad = (mut, re) => { const j = good(); mut(j); assert.throws(() => parseScreens(j), re); };
  bad((j) => { j.screens.home.prototype.route = "home"; }, /screen "home".*route/);
  bad((j) => { j.screens["now-playing-paused"].prototype.route = "#/now-playing"; }, /reuses the route of "now-playing"/);
  bad((j) => { j.screens.home.regions.rows.mode = "some"; }, /mode must be/);
  bad((j) => { j.screens.home.app = { state: "returning" }; }, /app must be null or/);
  bad((j) => { j.screens["a b"] = j.screens.home; }, /screen id "a b"/);
  bad((j) => { delete j.screens; }, /missing "screens"/);
  const n = parseScreens(good()).screens.find((s) => s.id === "home");
  assert.equal(n.regions.find((r) => r.name === "hero").app, null);
  assert.equal(n.regions.find((r) => r.name === "rows").mode, "all");
});

test("8. several screens sharing one app step are ALL planned (the Map must hold a list, not the last id)", () => {
  // MUTATION: in planRun, replace the appByKey accumulation loop with `new Map(appScreens.map((s) => [key, s.id]))` (last id wins; the first Now Playing screen silently never shoots).
  const plan = planRun(parseScreens(good()));
  assert.deepEqual(plan.appByKey.get("player/now-playing"), ["now-playing", "now-playing-paused"]);
  assert.deepEqual(plan.appByKey.get("returning/home"), ["home"]);
  assert.deepEqual(plan.appStates.sort(), ["player", "returning"]);
  assert.deepEqual(plan.noApp, ["settings"]);
  assert.deepEqual(plan.protoRoutes, ["#/home", "#/now-playing", "#/now-playing/paused", "#/settings"]);
  const only = planRun(parseScreens(good()), ["settings"]);
  assert.deepEqual(only.appStates, [], "a screen with no app mapping shoots no app state");
  assert.throws(() => planRun(parseScreens(good()), ["nope"]), /unknown --screens: nope/);
  const home = parseScreens(good()).screens[0];
  assert.deepEqual(selectorsFor(home, "app"), { header: ".topbar", rows: ".ep-row" }, "a null app selector is omitted, not measured as 'null'");
  assert.deepEqual(selectorsFor(home, "prototype"), { header: ".top", rows: ".row", hero: ".hero" });
  const cmp = compareScreen(home, { header: summarizeMeasure([B(0, 0, 1, 1)]) }, {});
  assert.deepEqual(cmp.map((r) => r.status), ["prototype-only", "neither", "neither"]);
});

test("9. side-by-side puts the prototype left, the app right, a grey gap between, and pads the shorter image", () => {
  // MUTATION: in sideBySide, blit(b, a.width + gap) -> blit(b, a.width) (no gap), or swap the two blit calls.
  const solid = (w, h, rgb) => { const p = new PNG({ width: w, height: h }); for (let i = 0; i < w * h; i++) p.data.set([...rgb, 255], i * 4); return PNG.sync.write(p); };
  const out = PNG.sync.read(sideBySide(solid(4, 3, [255, 0, 0]), solid(2, 5, [0, 0, 255]), 3));
  assert.deepEqual([out.width, out.height], [4 + 3 + 2, 5]);
  const px = (x, y) => [...out.data.subarray((y * out.width + x) * 4, (y * out.width + x) * 4 + 3)];
  assert.deepEqual(px(0, 0), [255, 0, 0]);
  assert.deepEqual(px(3, 0), [255, 0, 0]);
  assert.deepEqual(px(4, 0), [90, 90, 90], "gap");
  assert.deepEqual(px(6, 0), [90, 90, 90], "gap");
  assert.deepEqual(px(7, 4), [0, 0, 255]);
  assert.deepEqual(px(0, 4), [90, 90, 90], "below the shorter image is padding, not a copy of it");
});

test("10. the report carries gate failures and one-sided regions into the markdown, and is not gated by default", () => {
  // MUTATION: in buildReport, compute `failures` from failingRegions(screens, 0) always, or in renderMarkdown, drop the "Gate failures" block.
  const m = (b) => summarizeMeasure([b]);
  const regions = [compareRegion("header", m(B(0, 0, 10, 10)), m(B(0, 40, 10, 10))), compareRegion("hero", m(B(0, 0, 9, 9)), summarizeMeasure([]))];
  const screen = { id: "home", title: "Today", viewport: "393x852", prototypeRoute: "#/home", appRef: "returning/home", pixel: { status: "differs", pct: 91.5, changed: 1 }, regions, summary: summarizeRegions(regions) };
  const open = buildReport({ direction: "tactile", run: "r", against: "app", viewports: ["393x852"], screens: [screen], skipped: [{ id: "settings", reason: "no app" }], maxRegionDelta: null });
  assert.equal(open.summary.gated, false);
  assert.equal(open.failures.length, 0);
  assert.equal(open.summary.meanPixelPct, 91.5);
  const md = renderMarkdown(open);
  assert.match(md, /No gate/);
  assert.match(md, /\| header \| both \|.*\| \+0, \+40, w \+0, h \+0 \|/);
  assert.match(md, /\| hero \| prototype-only \|/);
  assert.match(md, /- settings: no app/);
  const gated = buildReport({ direction: "tactile", run: "r", against: "app", viewports: ["393x852"], screens: [screen], skipped: [], maxRegionDelta: 8 });
  assert.equal(gated.summary.failingRegions, 2);
  assert.match(renderMarkdown(gated), /## Gate failures[\s\S]*home @ 393x852, region header: delta 40px > 8px/);
});
