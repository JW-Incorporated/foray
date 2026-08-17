/* Measures ROOT DUMPING: how much of the catalogue sits on a bare top-level
   branch when that branch has children it could have reached.
 *
 * This is the number the 2026-08 taxonomy review
 * (docs/research/taxonomy-review-2026-08.md §3.2) diagnosed and the number any
 * re-classification has to move. It is committed as a tool rather than done in
 * a scratch script because "did the reclassification actually work?" is a
 * question that will be asked again after every fleet sweep, and an answer
 * nobody can reproduce is not an answer.
 *
 * Definitions (deliberately narrow, so the number cannot be flattered):
 *   - A (item, branch) PAIR exists when an item carries any topic in that
 *     branch. `["food", "food/baking", "history"]` is two pairs: food, history.
 *   - A pair is ROOT-ONLY when the item names the branch root and no child of
 *     it: `food` alone is root-only, `food` + `food/baking` is not.
 *   - Branches with no children are EXCLUDED from the totals: an item on such
 *     a branch had nowhere more specific to go, so counting it as a failure
 *     would inflate the problem and then flatter the fix when a child lands.
 *     They are reported separately.
 *   - FULLY root-only items carry no child node at all, anywhere. This is the
 *     harsher per-item view: no interest slider in the product fires for them,
 *     because app.js builds sliders from non-root nodes only.
 *
 * Usage:
 *   node tools/classify/root-dumping-report.mjs                # markdown tables
 *   node tools/classify/root-dumping-report.mjs --json         # machine-readable
 *   node tools/classify/root-dumping-report.mjs --baseline b.json   # before/after
 *
 * Env overrides (tests only): TAXONOMY_PATH, BREADTH_CLASSIFICATION_PATH,
 * DISCOVER_PATH */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function envPath(name, def) {
  const v = process.env[name];
  return v ? resolvePath(process.cwd(), v) : join(ROOT, ...def);
}

/* Strip a BOM. The documented workflow is `--json > before.json`, and on
   Windows — this repo's dev platform — PowerShell redirection writes one, which
   would otherwise come back as a raw SyntaxError from `--baseline`. */
const readJson = (p) => JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, ""));

/** Branch id -> whether the taxonomy gives it any child. */
export function branchesWithChildren(taxonomy) {
  const withChildren = new Set();
  for (const n of taxonomy.nodes) if (n.parent) withChildren.add(n.parent);
  return withChildren;
}

/**
 * Core measurement. `topicLists` is one array of topic ids per item.
 * `knownNodes`, when given, is the taxonomy's id set — anything outside it is
 * reported and ignored rather than counted.
 * Returns per-branch counts plus totals.
 */
export function measure(topicLists, withChildren, knownNodes = null) {
  const branches = {};
  const unknownTopics = new Set();
  let items = 0, fullyRootOnly = 0, itemsWithNoTopics = 0;

  for (const rawTopics of topicLists) {
    items++;
    if (!rawTopics || rawTopics.length === 0) { itemsWithNoTopics++; continue; }

    /* Validate against the taxonomy. Without this the metric is gameable in
       the one direction that matters: any string containing a slash would count
       as "has a child" and erase a root-only pair, so `food/bakin` would look
       like progress. Nothing else validates this file — merge-results.mjs
       validates agent output only, and CI does not check it at all. */
    const topics = knownNodes ? rawTopics.filter((t) => knownNodes.has(t) || (unknownTopics.add(t), false)) : rawTopics;
    if (topics.length === 0) { itemsWithNoTopics++; continue; }

    const seen = new Map(); // branch -> hasChild
    for (const t of topics) {
      const branch = t.split("/")[0];
      const isChild = t.includes("/");
      seen.set(branch, (seen.get(branch) || false) || isChild);
    }
    if (![...seen.values()].some(Boolean)) fullyRootOnly++;

    for (const [branch, hasChild] of seen) {
      if (!withChildren.has(branch)) continue; // nowhere more specific to go
      const b = (branches[branch] ||= { branch, pairs: 0, root_only: 0, with_child: 0 });
      b.pairs++;
      if (hasChild) b.with_child++;
      else b.root_only++;
    }
  }

  const rows = Object.values(branches).sort((a, b) => b.root_only - a.root_only || a.branch.localeCompare(b.branch));
  const pairs = rows.reduce((n, r) => n + r.pairs, 0);
  const rootOnly = rows.reduce((n, r) => n + r.root_only, 0);
  return {
    items,
    items_with_no_topics: itemsWithNoTopics,
    fully_root_only: fullyRootOnly,
    pairs,
    root_only: rootOnly,
    pct_root_only: pairs ? Number(((100 * rootOnly) / pairs).toFixed(1)) : 0,
    unknown_topics: [...unknownTopics].sort(),
    branches: rows,
  };
}

export function buildReport({ taxonomy, breadth, discover }) {
  const withChildren = branchesWithChildren(taxonomy);
  const knownNodes = new Set(taxonomy.nodes.map((n) => n.id));
  const childless = taxonomy.nodes.filter((n) => !n.parent && !withChildren.has(n.id)).map((n) => n.id);
  const out = { generated_at: new Date().toISOString(), childless_branches: childless, sources: {} };
  if (breadth) {
    out.sources.breadth = measure(Object.values(breadth.entries || {}).map((e) => e.topics || []), withChildren, knownNodes);
  }
  if (discover) out.sources.discover = measure((discover.items || []).map((i) => i.topics || []), withChildren, knownNodes);
  return out;
}

function pct(n, d) {
  return d ? `${((100 * n) / d).toFixed(1)}%` : "—";
}

export function formatMarkdown(report, baseline) {
  const lines = [];
  /* Union with the baseline's sources: a source that has DISAPPEARED since the
     snapshot is the interesting case, and iterating only the current report
     would drop it silently. */
  const names = [...new Set([...Object.keys(report.sources), ...Object.keys(baseline?.sources || {})])];
  for (const name of names) {
    const s = report.sources[name];
    const b = baseline?.sources?.[name];
    if (!s) {
      lines.push(`### ${name}`, "", `**MISSING from this run** — the baseline had ${b.items} items and ${b.root_only} root-only pairs.`, "");
      continue;
    }
    lines.push(`### ${name}`);
    lines.push("");
    lines.push(
      `${s.items} items, ${s.pairs} (item, branch) pairs, **${s.root_only} root-only (${s.pct_root_only}%)**` +
        (b ? ` — was ${b.root_only} (${b.pct_root_only}%)` : "")
    );
    lines.push(
      `Items with no child node at all: **${s.fully_root_only}**` + (b ? ` — was ${b.fully_root_only}` : "")
    );
    if (s.items_with_no_topics) lines.push(`Items with no topics at all: **${s.items_with_no_topics}**`);
    lines.push("");
    lines.push(b ? "| branch | pairs | root-only before | root-only after | change |" : "| branch | pairs | root-only | % |");
    lines.push(b ? "|---|---:|---:|---:|---:|" : "|---|---:|---:|---:|");
    const branchNames = new Set([...s.branches.map((r) => r.branch), ...(b?.branches || []).map((r) => r.branch)]);
    const rows = [...branchNames]
      .map((n) => ({ n, now: s.branches.find((r) => r.branch === n), was: b?.branches.find((r) => r.branch === n) }))
      .sort((x, y) => (y.was?.root_only ?? y.now?.root_only ?? 0) - (x.was?.root_only ?? x.now?.root_only ?? 0));
    for (const { n, now, was } of rows) {
      if (b) {
        const delta = (now?.root_only ?? 0) - (was?.root_only ?? 0);
        lines.push(`| ${n} | ${now?.pairs ?? 0} | ${was?.root_only ?? 0} | ${now?.root_only ?? 0} | ${delta > 0 ? "+" : ""}${delta} |`);
      } else {
        lines.push(`| ${n} | ${now.pairs} | ${now.root_only} | ${pct(now.root_only, now.pairs)} |`);
      }
    }
    lines.push("");
  }
  if (report.childless_branches.length) {
    lines.push(`Branches with no children (excluded — nowhere more specific to go): ${report.childless_branches.join(", ") || "none"}`);
  }
  return lines.join("\n");
}

const USAGE = "usage: node tools/classify/root-dumping-report.mjs [--json] [--baseline <snapshot.json>]";

/** Parses argv, or returns { error } — never guesses. */
export function parseArgs(argv) {
  let json = false;
  let baseline = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") { json = true; continue; }
    if (a === "--baseline") {
      baseline = argv[++i];
      if (!baseline || baseline.startsWith("--")) return { error: "--baseline needs a snapshot path" };
      continue;
    }
    return { error: `unknown argument "${a}"` };
  }
  /* A typo'd flag used to print the markdown table and exit 0, so
     `--jsn > before.json` produced a "snapshot" that only failed later, as a
     baseline, with a JSON parse error. Same reasoning as run-suites.mjs:
     refuse rather than ignore. */
  if (json && baseline) return { error: "--json and --baseline are mutually exclusive: --json emits a snapshot, --baseline reads one" };
  return { json, baseline };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`ERROR: ${args.error}\n${USAGE}`);
    process.exit(2);
  }
  const baselineArg = args.baseline;
  if (baselineArg && !existsSync(resolvePath(process.cwd(), baselineArg))) {
    console.error(`ERROR: baseline snapshot not found: ${baselineArg}\nTake one first: node tools/classify/root-dumping-report.mjs --json > before.json`);
    process.exit(2);
  }

  const taxonomy = readJson(envPath("TAXONOMY_PATH", ["data", "taxonomy.json"]));
  const breadthPath = envPath("BREADTH_CLASSIFICATION_PATH", ["data", "breadth-classification.json"]);
  const discoverPath = envPath("DISCOVER_PATH", ["data", "discover.json"]);

  const report = buildReport({
    taxonomy,
    breadth: existsSync(breadthPath) ? readJson(breadthPath) : null,
    discover: existsSync(discoverPath) ? readJson(discoverPath) : null,
  });

  /* Unknown topic ids are a data defect, not a rounding error: they mean
     something wrote an id the taxonomy does not have. Say so on stderr in both
     output modes, so a piped `--json > snapshot` still reports them. */
  for (const [name, s] of Object.entries(report.sources)) {
    if (s.unknown_topics?.length) {
      console.error(`UNKNOWN TOPIC IDS in ${name} (not taxonomy nodes, excluded from the counts):`, s.unknown_topics);
    }
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const baseline = baselineArg ? readJson(resolvePath(process.cwd(), baselineArg)) : null;
  console.log(formatMarkdown(report, baseline));
}

/* Repo convention (tools/ci/run-suites.mjs): compare as file URLs, not as raw
   strings — string path comparison is case- and symlink-sensitive on Windows,
   and a mismatch would make this tool print nothing and exit 0. */
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
