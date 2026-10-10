#!/usr/bin/env node
/* The Similar-shows eval runner (#560 item 8).

   Scores app.js's `similarShows` (through the pinned mirror in
   ./similar-shows.mjs) against the hand-reviewed ./eval-set.json over the
   catalogue the client actually loads, data/catalog-client.json, and writes
   the numbers and every failing pair into the GENERATED block of
   docs/research/similar-shows-eval-2026-10.md. Prose outside the block is
   hand-written and left alone.

     node tools/similar-eval/run.mjs          rewrite the generated block
     node tools/similar-eval/run.mjs --check  exit 1 if the committed block is stale
     node tools/similar-eval/run.mjs --json   print the aggregates

   No network, no app boot. test/similar-shows-eval.test.js asserts the floors
   and runs the --check comparison in-process. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";
import { similarShowsFor } from "./similar-shows.mjs";
import { evaluate } from "./score.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const EVAL_SET_PATH = "tools/similar-eval/eval-set.json";
export const CATALOG_PATH = "data/catalog-client.json";
export const REPORT_PATH = "docs/research/similar-shows-eval-2026-10.md";
export const BEGIN = "<!-- BEGIN GENERATED: node tools/similar-eval/run.mjs -->";
export const END = "<!-- END GENERATED -->";

function readJson(rel, root) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
}

/** Load the committed inputs and score the shipped ranking. */
export function runEval(root = ROOT) {
  const catalog = readJson(CATALOG_PATH, root);
  const evalSet = readJson(EVAL_SET_PATH, root);
  return evaluate(catalog, evalSet, (show) => similarShowsFor(catalog, show));
}

const f3 = (x) => (x === null ? "n/a" : x.toFixed(3));
const list = (ids) => (ids.length ? ids.map((id) => `\`${id}\``).join(", ") : "none");

/** The generated block's body (without the markers), deterministic. */
export function renderSection(result) {
  const out = [];
  const groups = [
    ["All seeds", result.all],
    ["Curated seeds", result.curated],
    ['`label_scope: "general"` seeds', result.general],
  ];
  out.push(`k = ${result.k} (the slots the show page renders). Precision is over what was shown; recall is over min(|expected|, k).`);
  out.push("");
  out.push("| Group | Seeds | Precision (shown) | Recall@6 | Hit rate | Coverage | Must-not violations |");
  out.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const [name, a] of groups) {
    out.push(
      `| ${name} | ${a.seeds} | ${f3(a.precision)} (${a.precisionSeeds} seeds) | ${f3(a.recall)} | ${f3(a.hitRate)} | ${f3(a.coverage)} | ${a.violations} in ${a.seedsWithViolations} seeds |`
    );
  }
  out.push("");
  out.push("### Per seed");
  out.push("");
  out.push("| Seed | General | Shown | Hits | Precision | Recall | Violations |");
  out.push("|---|:-:|---:|---:|---:|---:|---|");
  for (const r of result.rows) {
    out.push(
      `| \`${r.seed}\` | ${r.general ? "yes" : ""} | ${r.returned.length} | ${r.hits.length} | ${f3(r.precision)} | ${f3(r.recall)} | ${r.violations.length ? list(r.violations) : ""} |`
    );
  }
  out.push("");
  out.push("### Failing pairs");
  out.push("");
  out.push("**Must-not shows that appeared** (seed → shown show):");
  out.push("");
  const viol = result.rows.filter((r) => r.violations.length);
  if (!viol.length) out.push("- none");
  for (const r of viol) out.push(`- \`${r.seed}\` → ${list(r.violations)}`);
  out.push("");
  out.push("**Empty rows** (the seed renders no Similar shows section):");
  out.push("");
  const empty = result.rows.filter((r) => !r.covered);
  out.push(empty.length ? `- ${list(empty.map((r) => r.seed))}` : "- none");
  out.push("");
  out.push("**Expected shows missed** (seed → expected shows not in its row):");
  out.push("");
  const missed = result.rows.filter((r) => r.missed.length);
  if (!missed.length) out.push("- none");
  for (const r of missed) out.push(`- \`${r.seed}\` → ${list(r.missed)}`);
  const general = new Set(result.generalIds);
  const pairs = missed.flatMap((r) => r.missed);
  out.push("");
  out.push(
    `${pairs.length} expected pairs missed in all; ${pairs.filter((id) => general.has(id)).length} of them name a \`label_scope: "general"\` show, which similarShows never offers as a candidate.`
  );
  out.push("");
  out.push("**Shown but unjudged** (in the row, in neither list; counted as misses in precision):");
  out.push("");
  const unj = result.rows.filter((r) => r.unjudged.length);
  if (!unj.length) out.push("- none");
  for (const r of unj) out.push(`- \`${r.seed}\` → ${list(r.unjudged)}`);
  return out.join("\n");
}

/** `text` with its generated block replaced by `section`. Throws if the markers are missing. */
export function spliceReport(text, section) {
  const norm = text.replace(/\r\n/g, "\n");
  const a = norm.indexOf(BEGIN);
  const b = norm.indexOf(END);
  if (a < 0 || b < a) throw new Error(`${REPORT_PATH} has lost its GENERATED markers`);
  return norm.slice(0, a + BEGIN.length) + "\n" + section + "\n" + norm.slice(b);
}

/** True when the committed report's generated block matches a fresh run. */
export function reportIsCurrent(root = ROOT) {
  const text = fs.readFileSync(path.join(root, REPORT_PATH), "utf8").replace(/\r\n/g, "\n");
  return spliceReport(text, renderSection(runEval(root))) === text;
}

function main(argv) {
  if (argv.includes("--json")) {
    const r = runEval();
    console.log(JSON.stringify({ k: r.k, all: r.all, curated: r.curated, general: r.general }, null, 2));
    return 0;
  }
  if (argv.includes("--check")) {
    if (reportIsCurrent()) {
      console.log(`${REPORT_PATH}: generated block is current`);
      return 0;
    }
    console.error(`${REPORT_PATH}: generated block is STALE -- run node tools/similar-eval/run.mjs`);
    return 1;
  }
  const full = path.join(ROOT, REPORT_PATH);
  const text = fs.readFileSync(full, "utf8");
  fs.writeFileSync(full, spliceReport(text, renderSection(runEval())));
  console.log(`wrote ${REPORT_PATH}`);
  return 0;
}

/* tools/ci/entry.mjs's guard, never a `file://${argv[1]}` template -- see
   tools/entrypoint-guards.test.mjs for the Windows failure that idiom causes. */
if (isEntryScript(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
