/* Pure pixel-diff + report logic for baseline record/compare. No browser, no
 * network: PNG buffers in, numbers and PNG buffers out, so it is unit-tested
 * with synthetic images (baseline.test.mjs). The CLI is ../baseline.mjs.
 *
 * THRESHOLDS (two, deliberately separate):
 *   pixelThreshold  pixelmatch colour-distance tolerance per pixel, 0..1 (YIQ delta).
 *                   Default 0: any channel change counts. 0.1 (pixelmatch's default)
 *                   was measured to pass #666->#808080, #1a1a1a->#2a2a2a, #fff->#f3f4f6.
 *   maxPct          a shot FAILS when more than this % of its pixels differ.
 *                   Default 0: the harness is deterministic (see README), so
 *                   any differing pixel is a real change. Raise it per run only
 *                   to tolerate known drift, e.g. --max-pct 0.05.
 * Anti-aliased pixels are ignored (pixelmatch includeAA:false) so sub-pixel text
 * edge shifts alone do not fail a shot. A size change always counts as changed.
 */
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { parseArgs } from "./args.mjs";

export const DEFAULTS = { pixelThreshold: 0, maxPct: 0 };

/** Diff two PNG buffers. -> { status, width, height, changed, pct, diff } */
export function diffPng(bufA, bufB, opts = {}) {
  const pixelThreshold = opts.pixelThreshold ?? DEFAULTS.pixelThreshold;
  const a = PNG.sync.read(bufA);
  const b = PNG.sync.read(bufB);
  if (a.width !== b.width || a.height !== b.height) {
    return { status: "size-mismatch", width: b.width, height: b.height, baselineSize: `${a.width}x${a.height}`, currentSize: `${b.width}x${b.height}`, changed: a.width * a.height, pct: 100, diff: null };
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const changed = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: pixelThreshold, includeAA: false });
  const total = a.width * a.height;
  return { status: changed ? "differs" : "same", width: a.width, height: a.height, changed, pct: total ? (changed / total) * 100 : 0, diff: changed ? PNG.sync.write(diff) : null };
}

/** Compare two {name -> Buffer} maps. Pure; returns the report object plus diff PNGs to write. */
export function compareSets(baseline, current, opts = {}) {
  const maxPct = opts.maxPct ?? DEFAULTS.maxPct;
  const pixelThreshold = opts.pixelThreshold ?? DEFAULTS.pixelThreshold;
  const names = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort();
  const shots = [];
  const diffs = {};
  for (const name of names) {
    if (!(name in current)) { shots.push({ name, status: "missing", pct: null, changed: null, fails: true }); continue; }
    if (!(name in baseline)) { shots.push({ name, status: "added", pct: null, changed: null, fails: true }); continue; }
    const r = diffPng(baseline[name], current[name], { pixelThreshold });
    if (r.diff) diffs[name] = r.diff;
    const entry = { name, status: r.status, changed: r.changed, pct: Number(r.pct.toFixed(4)), fails: r.status !== "same" && r.pct > maxPct };
    if (r.status === "size-mismatch") { entry.baselineSize = r.baselineSize; entry.currentSize = r.currentSize; entry.fails = true; }
    shots.push(entry);
  }
  const count = (s) => shots.filter((x) => x.status === s).length;
  const summary = {
    total: shots.length, same: count("same"), differs: count("differs"), sizeMismatch: count("size-mismatch"),
    added: count("added"), missing: count("missing"), failing: shots.filter((x) => x.fails).length,
  };
  return { report: { pixelThreshold, maxPct, summary, shots, passed: summary.failing === 0 }, diffs };
}

/** Short markdown report: worst first. */
export function renderMarkdown(report, title = "Baseline compare") {
  const { summary: s, shots } = report;
  const lines = [
    `# ${title}`, "",
    `**${report.passed ? "PASS" : "FAIL"}** - ${s.total} shots: ${s.same} same, ${s.differs} differ, ${s.sizeMismatch} resized, ${s.added} added, ${s.missing} missing. ` +
      `Fails above ${report.maxPct}% changed pixels (pixel tolerance ${report.pixelThreshold}).`, "",
  ];
  const bad = shots.filter((x) => x.status !== "same").sort((x, y) => (y.pct ?? 101) - (x.pct ?? 101) || x.name.localeCompare(y.name));
  if (bad.length) {
    lines.push("| shot | status | changed px | % changed | fails |", "|---|---|---|---|---|");
    for (const x of bad) lines.push(`| ${x.name} | ${x.status}${x.baselineSize ? ` (${x.baselineSize} -> ${x.currentSize})` : ""} | ${x.changed ?? "-"} | ${x.pct ?? "-"} | ${x.fails ? "yes" : "no"} |`);
  } else lines.push("No differences.");
  return lines.join("\n") + "\n";
}

/** Merge shoot args: explicit (given) win over stored. Both are argv arrays. A stored boolean flag cannot be switched off. */
export function mergeArgs(stored, given) {
  const m = { ...parseArgs(stored || []), ...parseArgs(given || []) };
  delete m._;
  return Object.entries(m).flatMap(([k, v]) => (v === true ? ["--" + k] : ["--" + k, String(v)]));
}
