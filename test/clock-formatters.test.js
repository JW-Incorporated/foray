/* Audit round 3, arch-drift-10: THREE CLOCKS, ONE RULE.
 *
 * An episode's position (seek-policy.js `formatTimestamp`), a Foray's
 * (foray-resolve.js `fmtClock`) and a description's chapter stamp (app.js
 * `fmtChapterTime`) used to round three different ways: at 59.6 s a Foray read
 * 0:59 and an episode 1:00, and 3599.6 s of a 3600 s episode read "1:00:00"
 * while it was still playing. The two modules now share `hms`, floored; app.js
 * is a classic script and cannot import it, so its function is lifted out of
 * the source and pinned here, the way format-helpers.test.js pins fmtDur.
 *
 * MUTATIONS: `Math.round` back in `hms` (seek-policy.js) or in `fmtChapterTime`
 * (app.js) and a fractional row fails.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const url = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

function appFmtChapterTime() {
  const src = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  const m = /function fmtChapterTime\(seconds\) \{[\s\S]*?\n\}/.exec(src);
  assert.ok(m, "app.js still defines fmtChapterTime");
  const ctx = { Math, Number, String };
  vm.createContext(ctx);
  vm.runInContext(`${m[0]}\nthis.fmtChapterTime = fmtChapterTime;`, ctx);
  return ctx.fmtChapterTime;
}

const CASES = [
  [0, "0:00"], [59.6, "0:59"], [60, "1:00"], [61.9, "1:01"],
  [3599.6, "59:59"], [3600, "1:00:00"], [3725.5, "1:02:05"],
];

test("the episode, Foray and chapter clocks print the same second the same way, floored", async () => {
  const { formatTimestamp, EXACT, hms } = await import(url("player/seek-policy.js"));
  const { fmtClock } = await import(url("player/foray-resolve.js"));
  const fmtChapterTime = appFmtChapterTime();
  for (const [sec, want] of CASES) {
    assert.equal(hms(sec), want, `hms(${sec})`);
    assert.equal(formatTimestamp(sec, EXACT), want, `formatTimestamp(${sec})`);
    assert.equal(fmtClock(sec), want, `fmtClock(${sec})`);
    assert.equal(fmtChapterTime(sec), want, `fmtChapterTime(${sec})`);
  }
});

test("a playing episode never reads as its own end", async () => {
  const { formatTimestamp, EXACT } = await import(url("player/seek-policy.js"));
  assert.notEqual(formatTimestamp(3599.6, EXACT), formatTimestamp(3600, EXACT));
});
