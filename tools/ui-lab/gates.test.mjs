/* Pure-logic tests for the gate rules (lib/gates/rules.mjs). Synthetic
 * measurements in, violations out: no browser, no network, so CI can run it.
 * The browser half (measure.mjs, gates.mjs) is proven end to end against
 * fixtures/gates-fixture.html by hand; see README "Hard-limit gates".
 *
 * Each test names, in its comment, the one-line mutation that makes it fail. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateErrors, evaluateRequests, evaluateCsp, evaluateTapTargets, evaluateReducedMotion,
  evaluateOverflow, evaluateSheetFocus, evaluateContrast, splitByAllow, toAllowList, countsByGate, dedupe, GATES,
} from "./lib/gates/rules.mjs";
import { MIN_TAP_PX, TAP_EXEMPTIONS } from "./lib/gates/config.mjs";

const el = (o) => ({ selector: "button.x", tag: "button", text: "t", w: 44, h: 44, inlineInText: false, ...o });

/* MUTATION: in evaluateTapTargets change `e.w + tol >= min && e.h + tol >= min` to `||`
   (or drop the `h` clause) -> the 44x30 and 30x44 cases stop failing. */
test("tap target: both axes must reach 44, either short side fails", () => {
  const out = evaluateTapTargets("s/a", [el({ selector: "a1", w: 44, h: 30 }), el({ selector: "a2", w: 30, h: 44 }), el({ selector: "ok", w: 44, h: 44 }), el({ selector: "big", w: 80, h: 48 })]);
  assert.deepEqual(out.map((x) => x.id).sort(), ["a1", "a2"]);
});

/* MUTATION: set TAP_TOLERANCE_PX to 5 in config.mjs -> 40x40 passes and this fails;
   set it to 0 -> the 43.6 case fails. */
test("tap target: sub-pixel rounding passes, a real 40px miss does not", () => {
  const out = evaluateTapTargets("s/a", [el({ selector: "round", w: 43.6, h: 43.6 }), el({ selector: "miss", w: 40, h: 40 })]);
  assert.deepEqual(out.map((x) => x.id), ["miss"]);
});

/* MUTATION: drop the `e.tag === "a"` test (or the `inlineInText` test) in evaluateTapTargets
   -> a small button, or a lone inline link, is exempted and one of the asserts fails. */
test("tap target: only an <a> inside running text is exempt (WCAG 2.5.8 inline)", () => {
  const els = [
    el({ selector: "link-in-text", tag: "a", w: 60, h: 18, inlineInText: true }),
    el({ selector: "lone-link", tag: "a", w: 60, h: 18, inlineInText: false }),
    el({ selector: "inline-button", tag: "button", w: 60, h: 18, inlineInText: true }),
  ];
  assert.deepEqual(evaluateTapTargets("s/a", els).map((x) => x.id).sort(), ["inline-button", "lone-link"]);
  /* and the exemption is switchable, so it is a decision, not an accident */
  assert.equal(evaluateTapTargets("s/a", els, { exemptions: { ...TAP_EXEMPTIONS, inlineTextLinks: false } }).length, 3);
});

/* MUTATION: change MIN_TAP_PX in config.mjs from 44 to 24 -> the default-threshold tests above fail;
   here: the constant itself is pinned to the PLAN.md number. */
test("tap target: the threshold is the PLAN's 44", () => assert.equal(MIN_TAP_PX, 44));

/* MUTATION: in evaluateTapTargets, drop dedupe() -> 3 identical rows stay 3 and count is 1. */
test("tap target: identical selectors on one screen collapse into one violation with a count", () => {
  const out = evaluateTapTargets("s/a", [el({ selector: "row", w: 20 }), el({ selector: "row", w: 20 }), el({ selector: "row", w: 20 })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].count, 3);
});

/* MUTATION: in evaluateOverflow change `>` to `>=` -> the equal case is flagged; change to `<`-sense -> the wide one passes. */
test("overflow: scrollWidth strictly greater than clientWidth fails, equal passes", () => {
  assert.equal(evaluateOverflow("s/a", { scrollWidth: 393, clientWidth: 393, viewport: "393x852" }).length, 0);
  const o = evaluateOverflow("s/a", { scrollWidth: 656, clientWidth: 393, viewport: "393x852", offenders: ["div.wide"] });
  assert.equal(o.length, 1);
  assert.equal(o[0].id, "overflow@393x852");
  assert.match(o[0].detail, /div\.wide/);
});

/* MUTATION: in evaluateReducedMotion change `!(r.duration > minMs)` to `!(r.duration > 0)` -> the 0.01ms reset
   is flagged and the "instant" assert fails; change it to `r.duration < 0` -> nothing is flagged at all. */
test("reduced motion: > 1ms fails, the 0.01ms reset idiom and 0 pass", () => {
  const recs = [
    { kind: "transition", name: "transform", selector: "div.sheet", duration: 300 },
    { kind: "animation", name: "spin", selector: "div.spin", duration: 2000 },
    { kind: "transition", name: "opacity", selector: "div.reset", duration: 0.01 },
    { kind: "transition", name: "color", selector: "div.zero", duration: 0 },
  ];
  assert.deepEqual(evaluateReducedMotion("s/a", recs).map((x) => x.id), ["transition:transform:div.sheet", "animation:spin:div.spin"]);
});

/* MUTATION: in evaluateSheetFocus delete the `tabs.filter(...)` branch -> tab-escapes never reported. */
test("sheet focus: one stray Tab out of ten is a violation, with the count", () => {
  const tabs = Array.from({ length: 10 }, (_, i) => ({ inside: i !== 6, at: i === 6 ? "button#topbar" : "button" }));
  const out = evaluateSheetFocus("s/a", { dialog: ".fp-sheet", focusedIn: true, tabs, closed: true, closedBy: "escape", returnChecked: true, returnedToOpener: true, activeAfter: "x" });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "tab-escapes .fp-sheet");
  assert.match(out[0].detail, /1\/10/);
  assert.match(out[0].detail, /button#topbar/);
});

/* MUTATION: in evaluateSheetFocus drop the `!t.focusedIn` line -> focus-not-moved-in vanishes. */
test("sheet focus: focus that never moved in fails", () => {
  const tabs = Array.from({ length: 10 }, () => ({ inside: true, at: "button" }));
  const out = evaluateSheetFocus("s/a", { dialog: "#d", focusedIn: false, tabs, closed: true, closedBy: "escape", returnChecked: false, returnedToOpener: false, activeAfter: "body" });
  assert.deepEqual(out.map((x) => x.id), ["focus-not-moved-in #d"]);
});

/* MUTATION: change `else if (t.returnChecked && !t.returnedToOpener)` to drop `t.returnChecked` -> the
   unchecked (no opener) case is reported as a failure; drop `!t.returnedToOpener` -> a real miss passes. */
test("sheet focus: focus not returned fails only when there was an opener to return to", () => {
  const base = { dialog: "#d", focusedIn: true, tabs: [{ inside: true, at: "b" }], closed: true, closedBy: "control", activeAfter: "body" };
  assert.deepEqual(evaluateSheetFocus("s/a", { ...base, returnChecked: true, returnedToOpener: false }).map((x) => x.id), ["focus-not-returned #d"]);
  assert.equal(evaluateSheetFocus("s/a", { ...base, returnChecked: false, returnedToOpener: false }).length, 0, "no opener: unchecked, not failed");
  assert.equal(evaluateSheetFocus("s/a", { ...base, returnChecked: true, returnedToOpener: true }).length, 0);
});

/* MUTATION: in evaluateSheetFocus replace `!t.closed` with `false` -> cannot-close vanishes. */
test("sheet focus: a sheet neither Escape nor its close control can close fails", () => {
  const out = evaluateSheetFocus("s/a", { dialog: "#d", focusedIn: true, tabs: [{ inside: true, at: "b" }], closed: false, closedBy: null, returnChecked: false, returnedToOpener: false, activeAfter: "b" });
  assert.deepEqual(out.map((x) => x.id), ["cannot-close #d"]);
  assert.deepEqual(evaluateSheetFocus("s/a", null), [], "no dialog open: nothing to judge");
});

/* MUTATION: delete the `CONSOLE_COVERED_ELSEWHERE.some` skip in evaluateErrors -> the CSP/404 console echoes
   double-report and the length assert fails; delete the walk-failure skip -> it becomes a fake screen error. */
test("errors: console + pageerror reported once; messages other gates own are not double-counted", () => {
  const errs = [
    { state: "s", label: "a", kind: "console", message: "boom http://127.0.0.1:5555/x.js" },
    { state: "s", label: "a", kind: "pageerror", message: "TypeError: x is undefined" },
    { state: "s", label: "a", kind: "console", message: "Failed to load resource: the server responded with a status of 404 (Not Found) http://h/y" },
    { state: "s", label: "a", kind: "console", message: "Refused to apply inline style because it violates the following Content Security Policy directive" },
    { state: "s", label: "a", kind: "walk-failure", message: "timeout" },
  ];
  const out = evaluateErrors(errs);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((x) => x.gate), ["errors", "errors"]);
});

/* MUTATION: normalizeMessage stops stripping the origin -> the same error on two ports gets two ids and
   the known-debt list would never match across runs. */
test("errors: the id is stable across origins (ephemeral port, host)", () => {
  const a = evaluateErrors([{ state: "s", label: "a", kind: "console", message: "boom http://127.0.0.1:5555/x.js" }]);
  const b = evaluateErrors([{ state: "s", label: "a", kind: "console", message: "boom http://localhost:6/x.js" }]);
  assert.equal(a[0].id, b[0].id);
});

/* MUTATION: drop `if (!r.sameOrigin) continue` -> the stubbed cross-origin 404 is reported;
   drop the IGNORED_FAILED_REQUESTS check -> deploy-manifest.json is reported. */
test("requests: only failed same-origin requests, minus the documented ignore list", () => {
  const o = "http://127.0.0.1:1";
  const out = evaluateRequests([
    { screen: "s/a", url: `${o}/missing.json`, status: 404, sameOrigin: true },
    { screen: "s/a", url: `${o}/boom`, status: null, failure: "net::ERR_FAILED", sameOrigin: true },
    { screen: "s/a", url: `${o}/ok.json`, status: 200, sameOrigin: true },
    { screen: "s/a", url: "https://other.example/x", status: 404, sameOrigin: false },
    { screen: "s/a", url: `${o}/deploy-manifest.json`, status: 404, sameOrigin: true },
  ]);
  assert.deepEqual(out.map((x) => x.id).sort(), ["404 /missing.json", "failed /boom"]);
});

/* MUTATION: make evaluateCsp return [] -> fails. */
test("csp: every violation event is a violation, keyed by directive + blocked target", () => {
  const out = evaluateCsp([
    { screen: "s/a", directive: "style-src-attr", blocked: "inline", source: "x:20" },
    { screen: "s/a", directive: "script-src-elem", blocked: "inline", source: "x:30" },
    { screen: "s/a", directive: "style-src-attr", blocked: "inline", source: "x:21" },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out.find((x) => x.id === "style-src-attr inline").count, 2);
});

/* MUTATION: make evaluateContrast drop `dedupe` -> two identical nodes stay two. */
test("contrast: axe nodes become violations keyed by selector", () => {
  const out = evaluateContrast("s/a", [{ target: ".t", summary: "1.7" }, { target: ".t", summary: "1.7" }, { target: ".u", summary: "2.1" }]);
  assert.deepEqual(out.map((x) => [x.id, x.count]), [[".t", 2], [".u", 1]]);
});

/* MUTATION: in splitByAllow drop the `a.screen === "*" ||` clause -> wildcard entries match nothing;
   drop the `a.screen === x.screen` leg -> an allowance for one screen silences every screen. */
test("known debt: matches gate+screen+id exactly, '*' is a wildcard screen, extras are stale", () => {
  const vs = [
    { gate: "tap-targets", screen: "s/a", id: "b", detail: "", count: 1 },
    { gate: "tap-targets", screen: "s/z", id: "b", detail: "", count: 1 },
    { gate: "csp", screen: "s/a", id: "c", detail: "", count: 1 },
  ];
  const allow = { allow: [
    { gate: "tap-targets", screen: "s/a", id: "b" },
    { gate: "csp", screen: "*", id: "c" },
    { gate: "overflow", screen: "s/a", id: "gone" },
  ] };
  const { fresh, known, stale } = splitByAllow(vs, allow);
  assert.deepEqual(fresh.map((x) => `${x.gate}:${x.screen}`), ["tap-targets:s/z"], "same id on another screen is NOT silenced");
  assert.equal(known.length, 2);
  assert.deepEqual(stale.map((x) => x.id), ["gone"]);
  assert.equal(splitByAllow(vs, null).fresh.length, 3, "no allow file: everything is new");
});

/* MUTATION: toAllowList stops sorting -> the committed file churns between runs. */
test("known debt: the written list is sorted and round-trips through splitByAllow", () => {
  const vs = [
    { gate: "tap-targets", screen: "s/b", id: "z", detail: "d", count: 1 },
    { gate: "csp", screen: "s/a", id: "y", detail: "d", count: 1 },
    { gate: "tap-targets", screen: "s/a", id: "x", detail: "d", count: 1 },
  ];
  const list = toAllowList(vs, "n");
  assert.deepEqual(list.allow.map((a) => `${a.gate}:${a.screen}:${a.id}`), ["csp:s/a:y", "tap-targets:s/a:x", "tap-targets:s/b:z"]);
  assert.equal(splitByAllow(vs, list).fresh.length, 0);
});

/* MUTATION: drop one name from GATES in rules.mjs -> its row disappears from the report and this fails. */
test("the gate list is the PLAN's six gates plus requests and contrast", () => {
  assert.deepEqual([...GATES].sort(), ["contrast", "csp", "errors", "overflow", "reduced-motion", "requests", "sheet-focus", "tap-targets"]);
  const c = countsByGate([{ gate: "csp", screen: "a", id: "i", detail: "", count: 1 }]);
  assert.equal(c.csp, 1);
  assert.equal(c.errors, 0);
  assert.equal(dedupe([]).length, 0);
});
