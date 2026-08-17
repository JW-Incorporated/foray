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
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function envPath(name, def) {
  const v = process.env[name];
  return v ? resolvePath(process.cwd(), v) : join(ROOT, ...def);
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/** Branch id -> whether the taxonomy gives it any child. */
export function branchesWithChildren(taxonomy) {
  const withChildren = new Set();
  for (const n of taxonomy.nodes) if (n.parent) withChildren.add(n.parent);
  return withChildren;
}

/**
 * Core measurement. `topicLists` is one array of topic ids per item.
 * Returns per-branch counts plus totals.
 */
export function measure(topicLists, withChildren) {
  const branches = {};
  let items = 0, fullyRootOnly = 0, itemsWithNoTopics = 0;

  for (const topics of topicLists) {
    items++;
    if (!topics || topics.length === 0) { itemsWithNoTopics++; continue; }

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
    branches: rows,
  };
}

export function buildReport({ taxonomy, breadth, discover }) {
  const withChildren = branchesWithChildren(taxonomy);
  const childless = taxonomy.nodes.filter((n) => !n.parent && !withChildren.has(n.id)).map((n) => n.id);
  const out = { generated_at: new Date().toISOString(), childless_branches: childless, sources: {} };
  if (breadth) out.sources.breadth = measure(Object.values(breadth.entries || {}).map((e) => e.topics || []), withChildren);
  if (discover) out.sources.discover = measure((discover.items || []).map((i) => i.topics || []), withChildren);
  return out;
}

function pct(n, d) {
  return d ? `${((100 * n) / d).toFixed(1)}%` : "—";
}

export function formatMarkdown(report, baseline) {
  const lines = [];
  for (const [name, s] of Object.entries(report.sources)) {
    const b = baseline?.sources?.[name];
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
    const names = new Set([...s.branches.map((r) => r.branch), ...(b?.branches || []).map((r) => r.branch)]);
    const rows = [...names]
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

function main() {
  const args = process.argv.slice(2);
  const baselineArg = args.includes("--baseline") ? args[args.indexOf("--baseline") + 1] : null;

  const taxonomy = readJson(envPath("TAXONOMY_PATH", ["data", "taxonomy.json"]));
  const breadthPath = envPath("BREADTH_CLASSIFICATION_PATH", ["data", "breadth-classification.json"]);
  const discoverPath = envPath("DISCOVER_PATH", ["data", "discover.json"]);

  const report = buildReport({
    taxonomy,
    breadth: existsSync(breadthPath) ? readJson(breadthPath) : null,
    discover: existsSync(discoverPath) ? readJson(discoverPath) : null,
  });

  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const baseline = baselineArg ? readJson(resolvePath(process.cwd(), baselineArg)) : null;
  console.log(formatMarkdown(report, baseline));
}

if (process.argv[1] && resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url))) main();
