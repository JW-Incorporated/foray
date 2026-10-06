/* Pure-logic tests for lib/diff.mjs: synthetic PNGs generated here, no browser.
 * Each test names the one-line mutation (in lib/diff.mjs) that makes it fail;
 * all were run and confirmed on 2026-10-05.
 * The CLI tests (record/compare --from, name/out guards) need no browser; the
 * render path (shoot.mjs) is covered by the determinism run in README.md, not CI. */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { PNG } from "pngjs";
import { diffPng, compareSets, renderMarkdown, mergeArgs, DEFAULTS } from "./lib/diff.mjs";

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

test("pixelThreshold is a tolerance: default 0 counts a tiny delta, an explicit 0.1 absorbs it", () => {
  // MUTATION: in diffPng, hard-code `threshold: 0` (the 0.1 half fails) or `threshold: 0.1` (the default half fails).
  const a = png(8, 8, [100, 100, 100]);
  const tiny = png(8, 8, [102, 100, 100]);
  assert.ok(diffPng(a, tiny).changed > 0);
  assert.equal(diffPng(a, tiny, { pixelThreshold: 0.1 }).changed, 0);
});

test("real colour-token changes are caught at the DEFAULT options (the 0.1 default passed these)", () => {
  // MUTATION: in diff.mjs set DEFAULTS.pixelThreshold to 0.1 (these pairs read 'same' and the run passes).
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  for (const [from, to] of [["#ffffff", "#f3f4f6"], ["#1a1a1a", "#2a2a2a"], ["#666666", "#808080"], ["#ffffff", "#fafafa"]]) {
    const { report } = compareSets({ "t.png": png(8, 8, hex(from)) }, { "t.png": png(8, 8, hex(to)) });
    assert.equal(report.passed, false, `${from} -> ${to} must fail at default options`);
    assert.equal(report.shots[0].pct, 100);
  }
});

test("compareSets passes pixelThreshold through to the diff and reports the thresholds it used", () => {
  // MUTATION: in compareSets, drop the option from the diffPng call: `diffPng(baseline[name], current[name], { pixelThreshold })` -> `diffPng(baseline[name], current[name])`.
  const base = { "t.png": png(8, 8, [102, 102, 102]) };
  const cur = { "t.png": png(8, 8, [128, 128, 128]) };
  assert.equal(compareSets(base, cur).report.passed, false);
  const loose = compareSets(base, cur, { pixelThreshold: 0.5, maxPct: 0.25 });
  assert.equal(loose.report.passed, true);
  assert.equal(loose.report.pixelThreshold, 0.5);
  assert.equal(loose.report.maxPct, 0.25);
});

test("pct is reported to 4 decimals, not rounded away", () => {
  // MUTATION: in compareSets, change `toFixed(4)` to `toFixed(0)`.
  const base = { "t.png": png(100, 30) };
  const cur = { "t.png": png(100, 30, [20, 20, 20], [{ x: 0, y: 0, rgb: [255, 255, 255] }]) }; // 1 / 3000 px
  assert.equal(compareSets(base, cur).report.shots[0].pct, 0.0333);
});

test("mergeArgs: explicit args override stored ones, the rest are kept", () => {
  // MUTATION: in mergeArgs, swap the spread order (stored then wins) or drop the stored spread.
  const out = mergeArgs(["--target", "app", "--states", "a", "--no-remote-images"], ["--states", "b", "--full"]);
  assert.deepEqual(out, ["--target", "app", "--states", "b", "--no-remote-images", "--full"]);
});

/* ---- CLI paths that delete things (no browser: everything runs with --from) ---- */
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "baseline.mjs");
const cli = (root, cmd, ...a) => spawnSync(process.execPath, [CLI, cmd, "--root", root, ...a], { encoding: "utf8" });
function scratch() {
  const root = mkdtempSync(path.join(tmpdir(), "uilab-test-"));
  const render = path.join(mkdtempSync(path.join(tmpdir(), "uilab-render-")), "render"); // outside root, or the --from guard masks the name guards
  mkdirSync(path.join(render, "shots"), { recursive: true });
  writeFileSync(path.join(render, "shots", "a.png"), png(6, 6));
  writeFileSync(path.join(root, "precious.txt"), "keep me");
  return { root, render };
}

test("record/compare round trip: a clean compare exits 0, a changed shot exits 1 and writes the report", () => {
  // MUTATION: in baseline.mjs change `process.exit(report.passed ? 0 : 1)` to `process.exit(0)`.
  const { root, render } = scratch();
  assert.equal(cli(root, "record", "--name", "b", "--from", render).status, 0);
  assert.equal(cli(root, "compare", "--name", "b", "--from", render).status, 0);
  writeFileSync(path.join(render, "shots", "a.png"), png(6, 6, [20, 20, 20], [{ x: 0, y: 0, w: 2, h: 2, rgb: [255, 0, 0] }]));
  assert.equal(cli(root, "compare", "--name", "b", "--from", render).status, 1);
  assert.ok(existsSync(path.join(root, "compare", "b", "report.json")));
  assert.ok(existsSync(path.join(root, "compare", "b", "diffs", "a.png")));
});

test("--name '..' and path-like names are refused and nothing is deleted", () => {
  // MUTATION 1: in baseline.mjs delete BOTH the `/^\.+$/.test(args.name)` clause and the `path.dirname(dir) !== baseRoot` guard ('..' --force then wipes the data root).
  // MUTATION 2: add "/" to the allowed name charset (a/b is then accepted).
  const { root, render } = scratch();
  assert.equal(cli(root, "record", "--name", "ok", "--from", render).status, 0);
  for (const name of ["..", ".", "a/b", "a\\b"]) {
    assert.equal(cli(root, "record", "--name", name, "--force", "--from", render).status, 2, `name ${JSON.stringify(name)}`);
  }
  assert.ok(existsSync(path.join(root, "precious.txt")));
  assert.ok(existsSync(path.join(root, "baselines", "ok", "shots", "a.png")));
});

test("record --force --from the baseline's own dir (or inside it) is refused and the baseline survives", () => {
  // MUTATION: in baseline.mjs delete the `if (inside(dir, src)) die(...)` line (the baseline is deleted, then ENOENT).
  const { root, render } = scratch();
  assert.equal(cli(root, "record", "--name", "b", "--from", render).status, 0);
  const own = path.join(root, "baselines", "b");
  for (const from of [own, path.join(own, "shots")]) {
    assert.equal(cli(root, "record", "--name", "b", "--force", "--from", from).status, 2);
    assert.ok(existsSync(path.join(own, "shots", "a.png")), "baseline still there");
  }
});

test("compare --out only clears an empty dir or a previous compare output", () => {
  // MUTATION 1: in baseline.mjs delete the `die("--out ... refusing to delete it")` guard (the foreign file is deleted).
  // MUTATION 2: stop writing the MARKER file (the 'own previous output is reusable' half fails).
  const { root, render } = scratch();
  assert.equal(cli(root, "record", "--name", "b", "--from", render).status, 0);
  const foreign = path.join(root, "mine");
  mkdirSync(foreign);
  writeFileSync(path.join(foreign, "notes.txt"), "not a report");
  assert.equal(cli(root, "compare", "--name", "b", "--from", render, "--out", foreign).status, 2);
  assert.ok(existsSync(path.join(foreign, "notes.txt")));
  const fresh = path.join(root, "fresh");
  assert.equal(cli(root, "compare", "--name", "b", "--from", render, "--out", fresh).status, 0);
  assert.equal(cli(root, "compare", "--name", "b", "--from", render, "--out", fresh).status, 0, "own previous output is reusable");
  const empty = path.join(root, "empty");
  mkdirSync(empty);
  assert.equal(cli(root, "compare", "--name", "b", "--from", render, "--out", empty).status, 0);
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
