/* Pure-logic tests for lib/diff.mjs: synthetic PNGs generated here, no browser.
 * Each test names the one-line mutation (in lib/diff.mjs) that makes it fail;
 * all were run and confirmed on 2026-10-05.
 * Suites covering other mechanisms: none - the CLI (baseline.mjs) is exercised by
 * the determinism run documented in README.md, not by CI (it needs a browser). */
import test from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { diffPng, compareSets, renderMarkdown, DEFAULTS } from "./lib/diff.mjs";

function png(w, h, fill = [20, 20, 20], paint = []) {
  const p = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) p.data.set([...fill, 255], i * 4);
  for (const { x, y, w: pw = 1, h: ph = 1, rgb } of paint)
    for (let j = y; j < y + ph; j++) for (let i = x; i < x + pw; i++) p.data.set([...rgb, 255], (j * w + i) * 4);
  return PNG.sync.write(p);
}

test("identical images are 'same' with zero changed pixels and no diff image", () => {
  // MUTATION: in diffPng, change `changed ? "differs" : "same"` to always "differs".
  const r = diffPng(png(10, 10), png(10, 10));
  assert.equal(r.status, "same");
  assert.equal(r.changed, 0);
  assert.equal(r.diff, null);
});

test("a changed block is counted exactly and reported as a percentage of all pixels", () => {
  // MUTATION: in diffPng, compute pct as changed / (total * 2) (or drop the * 100).
  const r = diffPng(png(10, 10), png(10, 10, [20, 20, 20], [{ x: 2, y: 2, w: 2, h: 5, rgb: [250, 250, 250] }]));
  assert.equal(r.status, "differs");
  assert.equal(r.changed, 10);
  assert.equal(r.pct, 10);
  assert.ok(PNG.sync.read(r.diff).width === 10, "a diff PNG of the same size is produced");
});

test("pixelThreshold absorbs a tiny colour delta but not a real one", () => {
  // MUTATION: in diffPng, hard-code `threshold: 0` (the tiny delta then counts) or ignore pixelThreshold (the strict run below never fails).
  const a = png(8, 8, [100, 100, 100]);
  const tiny = png(8, 8, [102, 100, 100]);
  assert.equal(diffPng(a, tiny).changed, 0);
  assert.ok(diffPng(a, tiny, { pixelThreshold: 0 }).changed > 0);
});

test("a size change is always a failure, even with a huge maxPct", () => {
  // MUTATION: in diffPng, delete the whole `if (a.width !== b.width ...) { return ... }` block (pixelmatch then throws on the size mismatch).
  const { report } = compareSets({ "a.png": png(10, 10) }, { "a.png": png(10, 12) }, { maxPct: 100 });
  assert.equal(report.shots[0].status, "size-mismatch");
  assert.equal(report.shots[0].fails, true);
  assert.equal(report.passed, false);
});

test("added and missing shots are listed and fail the run", () => {
  // MUTATION: in compareSets, swap the `missing` and `added` branches' status strings, or skip names not in both sets.
  const { report } = compareSets({ "old.png": png(4, 4), "both.png": png(4, 4) }, { "new.png": png(4, 4), "both.png": png(4, 4) });
  const by = Object.fromEntries(report.shots.map((s) => [s.name, s.status]));
  assert.deepEqual(by, { "both.png": "same", "new.png": "added", "old.png": "missing" });
  assert.equal(report.summary.added, 1);
  assert.equal(report.summary.missing, 1);
  assert.equal(report.passed, false);
});

test("maxPct is the pass/fail line: at-or-below passes, above fails (default 0 fails any pixel)", () => {
  // MUTATION: in compareSets, change `r.pct > maxPct` to `r.pct >= maxPct` (the at-limit case flips) or to `r.pct > maxPct + 1`.
  const base = { "s.png": png(10, 10) };
  const cur = { "s.png": png(10, 10, [20, 20, 20], [{ x: 0, y: 0, w: 1, h: 1, rgb: [250, 250, 250] }]) }; // exactly 1%
  assert.equal(DEFAULTS.maxPct, 0);
  assert.equal(compareSets(base, cur).report.passed, false);
  assert.equal(compareSets(base, cur, { maxPct: 1 }).report.passed, true);
  assert.equal(compareSets(base, cur, { maxPct: 0.99 }).report.passed, false);
});

test("diff PNGs are returned only for shots that differ, keyed by shot name", () => {
  // MUTATION: in compareSets, assign `diffs[name]` unconditionally (a null is then stored for 'same' shots).
  const base = { "a.png": png(6, 6), "b.png": png(6, 6) };
  const cur = { "a.png": png(6, 6), "b.png": png(6, 6, [20, 20, 20], [{ x: 1, y: 1, w: 3, h: 3, rgb: [255, 0, 0] }]) };
  const { diffs } = compareSets(base, cur);
  assert.deepEqual(Object.keys(diffs), ["b.png"]);
});

test("markdown report leads with the verdict and lists the worst shot first", () => {
  // MUTATION: in renderMarkdown, remove the `.sort(...)` (insertion order then puts 'a' first) or flip PASS/FAIL.
  const base = { "a.png": png(10, 10), "z.png": png(10, 10) };
  const cur = {
    "a.png": png(10, 10, [20, 20, 20], [{ x: 0, y: 0, rgb: [255, 255, 255] }]),
    "z.png": png(10, 10, [20, 20, 20], [{ x: 0, y: 0, w: 5, h: 5, rgb: [255, 255, 255] }]),
  };
  const md = renderMarkdown(compareSets(base, cur).report);
  assert.match(md, /\*\*FAIL\*\*/);
  assert.ok(md.indexOf("z.png") < md.indexOf("a.png"), "25% change listed before 1% change");
  assert.match(renderMarkdown(compareSets(base, base).report), /\*\*PASS\*\*[\s\S]*No differences/);
});
