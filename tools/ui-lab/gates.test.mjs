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

/* A hit-tested element as measure.mjs hands it over: 25 grid samples over the 44px square. */
const grid = (misses) => Array.from({ length: 25 }, (_, i) => i >= misses);
const el = (o) => ({ selector: "button.x", tag: "button", text: "t", w: 44, h: 44, inlineInText: false, hits: grid(0), centerHit: true, ...o });

/* MUTATION: in evaluateTapTargets drop the `hits.length > 0 && misses === 0` pass (or make it `misses < 5`)
   -> the 40px button whose ::after reaches 44px is reported (the 194 false positives), or the 40px/40px one passes. */
test("tap target: a 40px box passes when its ::after hit area covers the whole 44px square, fails when it does not", () => {
  const out = evaluateTapTargets("s/a", [
    el({ selector: "ext44", w: 40, h: 40, hits: grid(0) }),   // ::after is 44px: every sample hits
    el({ selector: "ext40", w: 40, h: 40, hits: grid(16) }),  // ::after is 40px: the 16 edge samples miss
    el({ selector: "neighbour", w: 40, h: 40, hits: grid(4) }), // a sibling overlaps a strip: its hits are misses
  ]);
  assert.deepEqual(out.map((x) => x.id.split(" ")[0]).sort(), ["ext40", "neighbour"]);
  assert.match(out.find((x) => x.id.startsWith("ext40")).detail, /16\/25/);
});

/* MUTATION: in evaluateTapTargets change `e.w + tol >= min && e.h + tol >= min` to `||` -> the 44x30
   (no extension) passes; to `&& true`-less variants the 80x48 case still passes, so only `||` is caught here. */
test("tap target: with no hit-area extension both axes must reach 44", () => {
  const out = evaluateTapTargets("s/a", [
    el({ selector: "wide-short", w: 44, h: 30, hits: grid(8) }),
    el({ selector: "tall-narrow", w: 30, h: 44, hits: grid(8) }),
    el({ selector: "big", w: 80, h: 48 }),
  ]);
  assert.deepEqual(out.map((x) => x.id.split(" ")[0]).sort(), ["tall-narrow", "wide-short"]);
});

/* MUTATION: set TAP_TOLERANCE_PX to 0 in config.mjs -> the 43.6 box (a rounded 44) is reported; to 5 -> 40x40 with misses passes. */
test("tap target: a 44px round button passes on size even though its corner samples miss", () => {
  const out = evaluateTapTargets("s/a", [el({ selector: "round", w: 43.6, h: 43.6, hits: grid(8), centerHit: true })]);
  assert.equal(out.length, 0);
});

/* MUTATION: in evaluateTapTargets delete the `centerHit !== false` branch -> a 44px button buried under a
   sibling/overlay at its centre passes. */
test("tap target: a big box that something else covers at its centre is a miss", () => {
  const out = evaluateTapTargets("s/a", [el({ selector: "covered", w: 48, h: 48, hits: grid(10), centerHit: false })]);
  assert.equal(out.length, 1);
  assert.match(out[0].id, /covered$/);
});

/* MUTATION: in evaluateTapTargets drop the `hits.length > 0 &&` guard -> an element with no samples
   (fully off-screen after clipping) passes by default instead of being reported as unmeasurable. */
test("tap target: no samples and a small box is reported, not waved through", () => {
  const out = evaluateTapTargets("s/a", [el({ selector: "nowhere", w: 20, h: 20, hits: [] })]);
  assert.equal(out.length, 1);
  assert.match(out[0].detail, /not measurable/);
});

/* MUTATION: drop the `e.tag === "a"` test (or the `inlineInText` test) in evaluateTapTargets
   -> a small button, or a lone inline link, is exempted and one of the asserts fails. */
test("tap target: only an <a> inside running text is exempt (WCAG 2.5.8 inline)", () => {
  const small = { w: 60, h: 18, hits: grid(20) };
  const els = [
    el({ selector: "link-in-text", tag: "a", inlineInText: true, ...small }),
    el({ selector: "lone-link", tag: "a", inlineInText: false, ...small }),
    el({ selector: "inline-button", tag: "button", inlineInText: true, ...small }),
  ];
  assert.deepEqual(evaluateTapTargets("s/a", els).map((x) => x.id.split(" ")[0]).sort(), ["inline-button", "lone-link"]);
  const dense = el({ selector: "div.ag-np-progress > div.ag-np-strip > button.ag-np-strip-button", tag: "button", w: 12, h: 44, hits: grid(20) });
  assert.equal(evaluateTapTargets("s/a", [dense]).length, 0, "the direction's explicitly 44px-tall proportional timeline is exempt by selector");
  /* MUTATION: in evaluateTapTargets drop `(!s.heightFloor || e.h + tol >= min)` -> the 30px-tall bar below is exempt and this fails.
     The timeline exemption is for WIDTH only; a bar that is also short is a real miss. */
  const shortBar = el({ selector: "div.ag-np-progress > div.ag-np-strip > button.ag-np-strip-button", tag: "button", w: 12, h: 30, hits: grid(20) });
  assert.equal(evaluateTapTargets("s/a", [shortBar]).length, 1, "a timeline bar shorter than 44px is not exempt");
  /* and the exemption is switchable, so it is a decision, not an accident */
  assert.equal(evaluateTapTargets("s/a", els, { exemptions: { ...TAP_EXEMPTIONS, inlineTextLinks: false } }).length, 3);
});

/* MUTATION: change MIN_TAP_PX in config.mjs from 44 to 24 -> the PLAN number is pinned here. */
test("tap target: the threshold is the PLAN's 44", () => assert.equal(MIN_TAP_PX, 44));

/* MUTATION: in evaluateTapTargets, drop dedupe() -> 3 identical rows stay 3 and count is 1. */
test("tap target: identical selectors and sizes on one screen collapse into one violation with a count", () => {
  const out = evaluateTapTargets("s/a", [1, 2, 3].map(() => el({ selector: "row", w: 20, h: 20, hits: grid(21) })));
  assert.equal(out.length, 1);
  assert.equal(out[0].count, 3);
});

/* MUTATION: in evaluateTapTargets remove the `bucket` from the id -> the 40px and 28px versions of the same
   selector share a key, so a known-debt entry for 40px silences a regression to 28px. */
test("tap target: the id carries a size bucket, so a shrink is a new violation, not the old debt", () => {
  const at40 = evaluateTapTargets("s/a", [el({ selector: "star", w: 40, h: 40, hits: grid(16) })]);
  const at28 = evaluateTapTargets("s/a", [el({ selector: "star", w: 28, h: 28, hits: grid(21) })]);
  assert.notEqual(at40[0].id, at28[0].id);
  assert.equal(splitByAllow(at28, toAllowList(at40, "n")).fresh.length, 1);
});

/* MUTATION: revert evaluateOverflow to compare only scrollWidth > clientWidth -> the first case (the real app's
   situation: html/body are `overflow-x: clip`, scrollWidth == clientWidth) reports nothing and fails. */
test("overflow: a geometry offender fires even though scrollWidth equals clientWidth (the app's clip backstop)", () => {
  const out = evaluateOverflow("s/a", { viewport: "393x852", innerWidth: 393, scrollWidth: 393, clientWidth: 393, offenders: [{ selector: "div.wide", left: 16, right: 656 }] });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "overflow@393x852 div.wide", "the key names the offender, so a different offender is a new violation");
  assert.deepEqual(evaluateOverflow("s/a", { viewport: "393x852", innerWidth: 393, scrollWidth: 393, clientWidth: 393, offenders: [] }), []);
});

/* MUTATION: delete the `!out.length && m.scrollWidth > m.clientWidth` backstop line -> a page without the clip
   that overflows with no measurable offender (e.g. a pseudo-element) goes unreported. */
test("overflow: scrollWidth stays as a backstop when no element is to blame", () => {
  const out = evaluateOverflow("s/a", { viewport: "393x852", innerWidth: 393, scrollWidth: 500, clientWidth: 393, offenders: [] });
  assert.deepEqual(out.map((x) => x.id), ["overflow@393x852 scrollWidth"]);
});


/* MUTATION: remove the crossfade property allow-list -> the 200ms transform passes; widen it with transform ->
   the transform assertion fails. The 0.01ms reset idiom and 0 remain instant. */
test("reduced motion: only opacity and colour may crossfade for 200ms", () => {
  const recs = [
    { kind: "transition", name: "transform", selector: "div.sheet", duration: 300 },
    { kind: "animation", name: "spin", selector: "div.spin", duration: 2000 },
    { kind: "transition", name: "transform", selector: "div.short-move", duration: 200 },
    { kind: "transition", name: "opacity", selector: "div.crossfade", duration: 200 },
    { kind: "transition", name: "background-color", selector: "div.tint", duration: 200 },
    { kind: "transition", name: "opacity", selector: "div.slow-crossfade", duration: 201 },
    { kind: "transition", name: "opacity", selector: "div.reset", duration: 0.01 },
    { kind: "transition", name: "color", selector: "div.zero", duration: 0 },
  ];
  assert.deepEqual(evaluateReducedMotion("s/a", recs).map((x) => x.id), [
    "transition:transform:div.sheet",
    "animation:spin:div.spin",
    "transition:transform:div.short-move",
    "transition:opacity:div.slow-crossfade",
  ]);
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

/* MUTATION: in splitByAllow change the match to ignore `a.id` (gate + screen only) -> the new, different violation
   on an already-indebted screen is silenced and `fresh` is empty. This is the gate's whole point: a screen with
   debt must still fail when it picks up a NEW problem. */
test("known debt: a NEW violation (different id) on an already-indebted screen still fails the run", () => {
  const debt = [{ gate: "tap-targets", screen: "returning/home", id: "button#menu-btn 40x40", detail: "d", count: 1 }];
  const today = [
    ...debt,
    { gate: "tap-targets", screen: "returning/home", id: "button.new-thing 20x20", detail: "d", count: 1 },
    { gate: "csp", screen: "returning/home", id: "style-src-attr inline", detail: "d", count: 1 },
  ];
  const { fresh, known } = splitByAllow(today, toAllowList(debt, "n"));
  assert.deepEqual(fresh.map((x) => x.id).sort(), ["button.new-thing 20x20", "style-src-attr inline"]);
  assert.equal(known.length, 1);
  /* and a same-gate, same-screen entry never matches on id alone either */
  assert.equal(splitByAllow([{ ...debt[0], gate: "contrast" }], toAllowList(debt, "n")).fresh.length, 1);
});

/* MUTATION: widen the CSP pattern in config.mjs back to `/Content Security Policy|^Refused to /i` -> the MIME
   "Refused to execute script" error (not a CSP message) is swallowed and the length assert fails. */
test("errors: a non-CSP 'Refused to ...' console error (MIME type) is still an error; a CSP one is left to the csp gate", () => {
  const out = evaluateErrors([
    { state: "s", label: "a", kind: "console", message: "Refused to execute script from 'http://h/x.js' because its MIME type ('text/html') is not executable, and strict MIME type checking is enabled." },
    { state: "s", label: "a", kind: "console", message: "Refused to load the script 'http://h/x.js' because it violates the following Content Security Policy directive: \"script-src 'self'\"." },
  ]);
  assert.equal(out.length, 1);
  assert.match(out[0].detail, /MIME/);
});

/* Speech silencing (narration was audible on the owner's PC: Windows SAPI ignores --mute-audio).
   Evaluates each real init script in a fake window whose speechSynthesis.speak records the utterance.
   Mutation that fails these: in lib/silence.mjs change `u.volume = 0` to `u.volume = 1` (volume check),
   or `return real(u)` to `return undefined` (real-speak check). */
import vm from "node:vm";
import { initScript } from "./lib/walk.mjs";
import { INIT_SCRIPT } from "./lib/gates/measure.mjs";
for (const [name, src] of [["walk initScript", initScript({ seed: {}, css: "" })], ["gates INIT_SCRIPT", INIT_SCRIPT]]) {
  test(`${name}: speechSynthesis.speak runs at volume 0 and still reaches the real speak`, () => {
    const spoken = [];
    const win = { speechSynthesis: { speak(u) { spoken.push({ vol: u.volume }); return "real"; } },
      Audio: function () {}, performance, document: { addEventListener() {} }, Element: { prototype: {} } };
    win.window = win;
    vm.runInNewContext(src, win);
    const u = { volume: 1 };
    assert.equal(win.speechSynthesis.speak(u), "real");
    assert.equal(spoken.length, 1, "the real speak was called exactly once");
    assert.equal(spoken[0].vol, 0, "volume was zeroed BEFORE the real speak ran");
  });
  test(`${name}: no speechSynthesis is not fatal`, () => {
    const win = { Audio: function () {}, performance, document: { addEventListener() {} }, Element: { prototype: {} } };
    win.window = win;
    assert.doesNotThrow(() => vm.runInNewContext(src, win));
  });
}
