#!/usr/bin/env node
/* axe-core on every route and state the shoot harness visits.
 *
 *   node tools/ui-lab/a11y.mjs --target app --out <dir> [--states a,b] [--viewports 393x852]
 *   node tools/ui-lab/a11y.mjs --target url --url <file|URL> --routes "#/,#/x" --out <dir>
 *   options: --css <file>  --scheme dark|light
 *
 * Writes <out>/a11y.json and <out>/summary.md. Default viewport is the first
 * phone size only (axe results do not depend on pixel density).
 */
import path from "node:path";
import { createRequire } from "node:module";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { parseArgs, parseViewports } from "./lib/args.mjs";
import { walk, repoRootFrom, readCss } from "./lib/walk.mjs";

const require = createRequire(import.meta.url);
const AXE_SRC = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const AXE_VERSION = require("axe-core/package.json").version;

const args = parseArgs(process.argv.slice(2));
const target = args.target || "app";
if (!["app", "url"].includes(target) || !args.out || (target === "url" && !args.url)) {
  console.error("usage: a11y.mjs --target app --out <dir> | --target url --url <file|URL> [--routes r1,r2] --out <dir>");
  process.exit(2);
}
const out = path.resolve(args.out);
mkdirSync(out, { recursive: true });
const viewports = parseViewports(args.viewports, "393x852");
const routes = typeof args.routes === "string" ? args.routes.split(",").map((s) => s.trim()) : [];

const run = await walk(
  {
    target, repoRoot: repoRootFrom(import.meta.url), url: args.url, routes, css: readCss(typeof args.css === "string" ? args.css : ""), viewports,
    states: typeof args.states === "string" ? args.states.split(",") : null,
    scheme: typeof args.scheme === "string" ? args.scheme : "dark",
  },
  async (page) => {
    /* page.evaluate is not subject to the page's CSP, which is why axe is injected this way and the app's policy stays on */
    await page.evaluate(AXE_SRC);
    const res = await page.evaluate(async () => {
      // eslint-disable-next-line no-undef
      const r = await axe.run(document, { resultTypes: ["violations", "incomplete"], runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } });
      const shape = (v) => ({
        id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, tags: v.tags.filter((t) => /^wcag\d|best-practice/.test(t)),
        nodes: v.nodes.slice(0, 12).map((n) => ({ target: n.target.join(" "), html: n.html.slice(0, 220), summary: (n.failureSummary || "").split("\n").slice(0, 4).join(" | ").slice(0, 400) })),
        nodeCount: v.nodes.length,
      });
      return { violations: r.violations.map(shape), incomplete: r.incomplete.map(shape), passes: r.passes.length };
    });
    return res;
  }
);

const screens = run.results.map((r) => ({ state: r.state, label: r.label, route: r.route, viewport: r.viewport, passes: r.passes, violations: r.violations, incomplete: r.incomplete }));
writeFileSync(path.join(out, "a11y.json"), JSON.stringify({ axe: AXE_VERSION, target, url: args.url || null, screens, errors: run.errors }, null, 2));

const ORDER = ["critical", "serious", "moderate", "minor", null];
const rule = new Map();
for (const s of screens) for (const v of s.violations) {
  const r = rule.get(v.id) || { id: v.id, impact: v.impact, help: v.help, nodes: 0, screens: new Set(), sample: v.nodes[0] };
  r.nodes += v.nodeCount; r.screens.add(`${s.state}/${s.label}`); rule.set(v.id, r);
}
const rules = [...rule.values()].sort((a, b) => ORDER.indexOf(a.impact) - ORDER.indexOf(b.impact) || b.nodes - a.nodes);
const total = screens.reduce((a, s) => a + s.violations.reduce((b, v) => b + v.nodeCount, 0), 0);
let md = `# Accessibility summary (axe-core ${AXE_VERSION})\n\n`;
md += `${screens.length} screens at ${viewports.map((v) => v.name).join(", ")}; ${total} failing nodes across ${rules.length} rules; ${screens.filter((s) => !s.violations.length).length} screens clean.\n\n`;
md += `## Rules failing\n\n| Impact | Rule | Nodes | Screens | What |\n|---|---|---|---|---|\n`;
for (const r of rules) md += `| ${r.impact || "-"} | ${r.id} | ${r.nodes} | ${r.screens.size} | ${r.help} |\n`;
md += `\n## By screen\n\n| State | Screen | Violations (rules) | Failing nodes |\n|---|---|---|---|\n`;
for (const s of screens) md += `| ${s.state} | ${s.label} | ${s.violations.length ? s.violations.map((v) => v.id).join(", ") : "none"} | ${s.violations.reduce((b, v) => b + v.nodeCount, 0)} |\n`;
md += `\n## Sample node per rule\n\n`;
for (const r of rules) md += `- **${r.id}**: \`${(r.sample?.target || "").slice(0, 100)}\` - ${(r.sample?.summary || "").slice(0, 200)}\n`;
const runErrs = run.errors.filter((e) => e.kind === "walk-failure");
if (runErrs.length) md += `\n## Walk failures\n\n${runErrs.map((e) => `- ${e.state}@${e.viewport}: ${e.message}`).join("\n")}\n`;
writeFileSync(path.join(out, "summary.md"), md);
console.log(`screens: ${screens.length}  rules failing: ${rules.length}  failing nodes: ${total}  -> ${out}`);
if (runErrs.length) process.exitCode = 1;
