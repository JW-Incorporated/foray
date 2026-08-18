/* Tests for playback-rate.js — the ladder, the labels and the stored value.

   Pure module, so every test here is arithmetic and string work with no clock, no
   DOM and no player. What it guards is mostly a set of PRODUCT decisions that are
   each one edit from their opposite: which speeds exist, where the top is, what
   the button says, and what happens to a stored value the app no longer
   recognises. The module header carries the reasoning; this pins it. */

import test from "node:test";
import assert from "node:assert/strict";
import {
  RATES, RATE_KEY, DEFAULT_RATE, MIN_RATE, MAX_RATE,
  isRate, normalizeRate, nextRate, rateLabel, rateAriaLabel, readRate, writeRate,
} from "./playback-rate.js";

/** The three Storage methods this module touches, and nothing else, so a change
    to what it needs fails loudly rather than silently using a browser global. */
class FakeStorage {
  constructor(seed = {}) { this.map = new Map(Object.entries(seed)); this.writes = []; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.writes.push([k, v]); this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

/* ---------- the ladder ---------- */

test("the stops are the 0.25 ladder the major podcast apps converge on", () => {
  /* Copied, not invented (the founder's instruction). Apple Podcasts' only four
     presets for a decade were 1.25 / 1.5 / 1.75 / 2; YouTube's ladder is the same
     0.25 spacing; Spotify, Pocket Casts, Overcast and Audible all offer slowing
     down as well. What is asserted is the exact set, because "we changed the
     speeds" is a product decision that should require editing a test. */
  assert.deepStrictEqual([...RATES], [0.75, 1, 1.25, 1.5, 1.75, 2]);
});

test("the ladder is ascending, unique, and every stop is exact in binary", () => {
  /* Ascending because `nextRate` cycles by index and a listener expects each tap
     to be faster. Exact in binary because the label is `String(r)` and a
     1.7500000000000002 on a button is the kind of defect nobody thinks to test
     for — every quarter is a dyadic fraction, so this holds by construction and
     will keep holding for any 0.25 stop added later. */
  for (let i = 1; i < RATES.length; i++) {
    assert.ok(RATES[i] > RATES[i - 1], `${RATES[i]} does not follow ${RATES[i - 1]}`);
  }
  assert.equal(new Set(RATES).size, RATES.length);
  for (const r of RATES) {
    assert.equal(String(r), String(Number(r.toFixed(2))), `${r} does not print cleanly`);
  }
});

test("normal speed is on the ladder — the identity has to be reachable", () => {
  // A control a listener cannot get back to 1x with is a trap, and 1x is also the
  // value every fallback in this module returns.
  assert.ok(RATES.includes(DEFAULT_RATE));
  assert.equal(DEFAULT_RATE, 1);
});

test("the top stop is 2x, and nothing above it — a Foray pays per seam", () => {
  /* THE #224 DECISION. Half the apps checked go to 3x or 3.5x. Rate does not make
     any one seam load slower, but it multiplies how many a listener meets per wall
     minute, and a hidden-page load has been measured at 5.1-11.1 s against a 20 s
     deadline — crossing which drops the segment rather than merely delaying it. 2x
     doubles the exposure for a speed people genuinely use; 3x trebles it for a
     speed few do.

     This is the assertion that has to be edited, deliberately, by whoever decides
     to ship 3x — which is the point of having it. */
  assert.equal(MAX_RATE, 2);
  assert.equal(MIN_RATE, 0.75);
  assert.ok(RATES.every((r) => r <= 2 && r >= 0.75));
});

test("there is exactly one stop below normal speed", () => {
  /* Slowing down is offered by every app checked, so leaving it out would be
     inventing rather than copying. But 0.5x and 0.25x are language-learning and
     transcription speeds, not listening speeds, and each extra stop is another tap
     between a listener and the speed they want on a one-button control. */
  assert.deepStrictEqual(RATES.filter((r) => r < 1), [0.75]);
});

test("isRate is strict — a numeric STRING is a different bug and must not be hidden", () => {
  // `element.playbackRate = "1.5"` is a coercion this module must never launder:
  // if a string reaches here, something upstream forgot a `Number()` and the right
  // outcome is a visible fallback, not a silent success.
  assert.equal(isRate(1.5), true);
  assert.equal(isRate(0.75), true);
  for (const bad of ["1.5", 1.6, 0, -1, NaN, Infinity, null, undefined, {}, [1.5]]) {
    assert.equal(isRate(bad), false, `isRate(${JSON.stringify(bad)}) must be false`);
  }
});

/* ---------- normalizeRate ---------- */

test("an unusable value falls back to normal speed rather than reaching the element", () => {
  /* `playbackRate = 0` pauses an element with no `pause` event — a player that
     looks broken with nothing in the log — a negative rate throws in some engines
     and NaN throws in all of them. This function is the allowlist between a
     hand-edited `cp_rate` and the media element. */
  for (const bad of [0, -1, -0.5, NaN, Infinity, -Infinity, null, undefined, "", "fast", "1.5", {}, []]) {
    assert.equal(normalizeRate(bad), DEFAULT_RATE, `${JSON.stringify(bad)} must normalise to 1`);
  }
});

test("an off-ladder number snaps to the NEAREST stop, not to normal speed", () => {
  // A stored 1.6 is somebody who was listening fast, and dropping them to 1x is
  // the "the app forgot" defect this whole change is about.
  assert.equal(normalizeRate(1.6), 1.5);
  assert.equal(normalizeRate(1.4), 1.5);
  assert.equal(normalizeRate(1.1), 1);
  assert.equal(normalizeRate(0.9), 1);
  assert.equal(normalizeRate(1.2), 1.25);
  assert.equal(normalizeRate(1.9), 2);
});

test("a value past either end CLAMPS, so shortening the ladder cannot silently reset anyone", () => {
  /* The direction that matters. If 2.5x ever ships and is later withdrawn,
     clamping keeps everyone stored above the top as fast as the app still goes;
     defaulting would drop them all to 1x on their next launch, which is
     indistinguishable from a bug and arrives without anyone having touched a
     control.

     MUTATION THAT KILLS THIS: replace the two clamp lines in `normalizeRate` with
     `return DEFAULT_RATE`. Every assertion here flips to 1. */
  assert.equal(normalizeRate(3), MAX_RATE);
  assert.equal(normalizeRate(3.5), MAX_RATE);
  assert.equal(normalizeRate(1000), MAX_RATE);
  assert.equal(normalizeRate(0.5), MIN_RATE);
  assert.equal(normalizeRate(0.25), MIN_RATE);
  assert.equal(normalizeRate(0.01), MIN_RATE);
});

test("every stop normalises to itself — the function is idempotent on the ladder", () => {
  for (const r of RATES) {
    assert.equal(normalizeRate(r), r);
    assert.equal(normalizeRate(normalizeRate(r)), r);
  }
});

/* ---------- nextRate ---------- */

test("tapping cycles upward and wraps to the slowest stop", () => {
  // Upward because the reason to touch the control is almost always "this is
  // slower than I can listen"; wrapping to 0.75x rather than to 1x is what keeps
  // the slow stop reachable at all from a single button.
  assert.deepStrictEqual(RATES.map(nextRate), [1, 1.25, 1.5, 1.75, 2, 0.75]);
});

test("the cycle visits every stop and returns, so no speed is unreachable", () => {
  let at = DEFAULT_RATE;
  const seen = [at];
  for (let i = 0; i < RATES.length; i++) { at = nextRate(at); seen.push(at); }
  assert.equal(at, DEFAULT_RATE, "and lands back where it started");
  assert.deepStrictEqual([...new Set(seen)].sort((a, b) => a - b), [...RATES]);
});

test("an off-ladder stored value advances instead of dead-ending on the first stop", () => {
  /* THE BUG THE FIRST DRAFT OF THIS CONTROL SHIPPED WITH. It was
     `RATES[(RATES.indexOf(cur) + 1) % RATES.length]`, and `indexOf` returns -1 for
     anything off the ladder — so `-1 + 1 = 0` and a listener whose stored value was
     from an older ladder, or hand-edited, got RATES[0] on every single tap. The
     control was permanently stuck on one value with no way to discover why.

     MUTATION THAT KILLS THIS: drop the `normalizeRate` call from `nextRate`. 1.6
     and 1.1 both return 0.75 and stay there. */
  assert.equal(nextRate(1.6), 1.75, "1.6 is a 1.5x listener, so the next tap is 1.75x");
  assert.equal(nextRate(1.1), 1.25);
  assert.equal(nextRate(3), MIN_RATE, "clamped to the top, so the next tap wraps");
  assert.equal(nextRate(0.5), 1, "clamped to the bottom, so the next tap is normal speed");
  // And junk still moves. A control that does nothing is worse than one that
  // starts from normal speed.
  for (const bad of [null, NaN, "fast", 0]) {
    assert.equal(nextRate(bad), 1.25, `${JSON.stringify(bad)} normalises to 1, whose next stop is 1.25`);
  }
});

/* ---------- labels ---------- */

test("the label is written the way podcast apps write it", () => {
  // The multiplication sign, no space, no trailing zero — and the same glyph the
  // player's own button already shipped with, rather than a second convention.
  assert.equal(rateLabel(1), "1×");
  assert.equal(rateLabel(1.25), "1.25×");
  assert.equal(rateLabel(1.5), "1.5×");
  assert.equal(rateLabel(1.75), "1.75×");
  assert.equal(rateLabel(2), "2×");
  assert.equal(rateLabel(0.75), "0.75×");
});

test("no label ever reads 1.5000000000000002×, or 'undefined×'", () => {
  // The label is `String(r)`, so a float artefact would be printed verbatim onto a
  // button. It cannot happen for a 0.25 ladder, and this is the assertion that
  // says so for any stop added later.
  for (const r of RATES) {
    assert.match(rateLabel(r), /^(0\.75|1|1\.25|1\.5|1\.75|2)×$/, `${r} labels as ${rateLabel(r)}`);
  }
  // Junk is labelled as the speed it will actually play at, never as itself.
  for (const bad of [null, undefined, NaN, "fast", 0, -1]) {
    assert.equal(rateLabel(bad), "1×", `${JSON.stringify(bad)} must label as normal speed`);
  }
  assert.equal(rateLabel(1.6), "1.5×", "and an off-ladder value labels as the stop it snapped to");
});

test("the accessible name says the value, because aria-label REPLACES the button text", () => {
  /* The visible label is a bare number that a screen reader reads as "one point
     five multiplication sign" — true and useless — so the control needs an
     `aria-label`. But `aria-label` on a button replaces its content, so the value
     has to be said again inside it or it is lost entirely. Sentence case, no
     exclamation, em-dash as in the surrounding copy (CLAUDE.md § Conventions). */
  assert.equal(rateAriaLabel(1.5), "Playback speed 1.5× — tap for the next speed");
  assert.match(rateAriaLabel(1), /^Playback speed 1× — /);
  for (const r of RATES) {
    assert.ok(rateAriaLabel(r).includes(rateLabel(r)), `${r}'s accessible name must carry its value`);
    assert.ok(!/!/.test(rateAriaLabel(r)), "no exclamation marks (repo copy rules)");
    assert.equal(rateAriaLabel(r), rateAriaLabel(r).trim());
  }
});

/* ---------- storage ---------- */

test("the key is exactly cp_rate — renaming it wipes user state", () => {
  /* CLAUDE.md § Conventions: the `cp_` prefix is legacy and load-bearing. This is
     also the key the shipped control already writes, so a rename here would not
     just lose the prefix, it would forget every listener's current speed.

     MUTATION THAT KILLS THIS: change `RATE_KEY`. Both assertions fail, and so does
     the round-trip below. */
  assert.equal(RATE_KEY, "cp_rate");
  const s = new FakeStorage();
  writeRate(s, 1.5);
  assert.deepStrictEqual(s.writes, [["cp_rate", "1.5"]]);
});

test("a stored speed round-trips", () => {
  const s = new FakeStorage();
  for (const r of RATES) {
    assert.equal(writeRate(s, r), true);
    assert.equal(readRate(s), r);
  }
});

test("nothing stored is normal speed, not zero", () => {
  assert.equal(readRate(new FakeStorage()), DEFAULT_RATE);
  assert.equal(readRate(null), DEFAULT_RATE);
  assert.equal(readRate({}), DEFAULT_RATE, "an object with no getItem is not a store");
});

test("a junk or stale stored row is snapped on the way OUT, not trusted", () => {
  /* `cp_rate` outlives app versions and can be hand-edited, so the read is the
     boundary that matters — a value that got in before this ladder existed must
     still produce a usable speed. */
  assert.equal(readRate(new FakeStorage({ cp_rate: "1.6" })), 1.5);
  assert.equal(readRate(new FakeStorage({ cp_rate: "3" })), MAX_RATE);
  assert.equal(readRate(new FakeStorage({ cp_rate: "0" })), DEFAULT_RATE);
  assert.equal(readRate(new FakeStorage({ cp_rate: "fast" })), DEFAULT_RATE);
  assert.equal(readRate(new FakeStorage({ cp_rate: "" })), DEFAULT_RATE);
});

test("an off-ladder value is snapped on the way IN too, so no junk is ever stored", () => {
  const s = new FakeStorage();
  writeRate(s, 1.6);
  assert.deepStrictEqual(s.writes, [["cp_rate", "1.5"]]);
  writeRate(s, 99);
  assert.equal(s.map.get("cp_rate"), "2");
});

test("a store that throws is reported, never thrown out of — a refused write is not a refused speed", () => {
  /* Private mode, quota, storage blocked outright. A speed that cannot be stored
     is still a speed that should govern this session, so the caller applies it
     either way and this only reports. Same posture as `foray-progress.js`'s
     `writeProgress`, and the reason `client.js` can call it without a try/catch. */
  const throwing = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("quota"); },
  };
  assert.equal(writeRate(throwing, 1.5), false);
  assert.equal(readRate(throwing), DEFAULT_RATE);
  assert.equal(writeRate(null, 1.5), false);
  assert.equal(writeRate({}, 1.5), false, "an object with no setItem is not a store");
});
