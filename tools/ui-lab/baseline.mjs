#!/usr/bin/env node
/* Visual-regression baselines for the screenshot harness. See README.md.
 *
 *   node tools/ui-lab/baseline.mjs record  --name <n> [--from <renderDir> | <shoot.mjs args...>] [--force]
 *   node tools/ui-lab/baseline.mjs compare --name <n> [--from <renderDir> | <shoot.mjs args...>]
 *                                          [--max-pct 0] [--pixel-threshold 0] [--out <dir>]
 *   node tools/ui-lab/baseline.mjs list
 *
 * Baselines live in data-local/redesign/baselines/<name>/ (gitignored; never commit
 * renders). Without --from, the render is made by shoot.mjs with the remaining
 * args (record stores them in baseline.json, so compare re-renders identically).
 * Compare with shoot args MERGES them over the stored ones (explicit wins; a stored
 * boolean flag cannot be switched off). --root <dir> moves baselines/ and compare/
 * (default data-local/redesign; used by the tests).
 * Exit: 0 pass, 1 a shot exceeds the threshold (or added/missing), 2 usage error.
 */
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseArgs } from "./lib/args.mjs";
import { compareSets, renderMarkdown, mergeArgs, DEFAULTS } from "./lib/diff.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const [cmd, ...rest] = process.argv.slice(2);
const die = (m, code = 2) => { console.error(m); process.exit(code); };

const pngsIn = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".png")).sort() : []);
const readSet = (dir) => Object.fromEntries(pngsIn(dir).map((f) => [f, readFileSync(path.join(dir, f))]));
const OWN = new Set(["name", "from", "force", "max-pct", "pixel-threshold", "out", "keep", "root"]);
const BOOL = new Set(["force", "keep"]);

/* The args to hand shoot.mjs: everything that is not ours, in original order. */
function shootArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const key = a.startsWith("--") ? a.slice(2).split("=")[0] : null;
    if (key && OWN.has(key)) {
      if (!a.includes("=") && !BOOL.has(key) && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function render(passthrough, dest) {
  const r = spawnSync(process.execPath, [path.join(here, "shoot.mjs"), ...passthrough, "--out", dest], { stdio: "inherit" });
  if (r.status !== 0) die(`shoot.mjs failed (exit ${r.status})`, 1);
}

const MARKER = ".ui-lab-compare";
const inside = (parent, child) => { const r = path.relative(parent, child); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
const pre = parseArgs(rest);
const dataRoot = path.resolve(typeof pre.root === "string" ? pre.root : path.join(repoRoot, "data-local", "redesign"));
const baseRoot = path.join(dataRoot, "baselines");

if (cmd === "list") {
  for (const d of existsSync(baseRoot) ? readdirSync(baseRoot) : []) {
    console.log(`${d}  ${pngsIn(path.join(baseRoot, d, "shots")).length} shots`);
  }
  process.exit(0);
}
if (!["record", "compare"].includes(cmd)) die("usage: baseline.mjs record|compare --name <n> [--from <renderDir> | shoot args] | list");
const args = parseArgs(rest);
if (typeof args.name !== "string" || !/^[A-Za-z0-9._-]+$/.test(args.name) || /^\.+$/.test(args.name)) die("--name <baseline name> is required (letters, digits, . _ -; not . or ..)");
const dir = path.resolve(baseRoot, args.name);
if (path.dirname(dir) !== baseRoot) die("baseline dir " + dir + " is not directly inside " + baseRoot);
const meta = path.join(dir, "baseline.json");

if (cmd === "record") {
  if (existsSync(dir) && !args.force) die(`baseline "${args.name}" exists; pass --force to replace it`);
  let src, tmp = null, shoot = null;
  if (typeof args.from === "string") {
    src = path.resolve(args.from);
    if (inside(dir, src)) die("--from " + src + " is the baseline being replaced (or inside it); refusing");
  } else { shoot = shootArgs(rest); src = tmp = mkdtempSync(path.join(tmpdir(), "uilab-rec-")); render(shoot, src); }
  const shotsDir = path.join(src, "shots");
  const files = pngsIn(shotsDir);
  if (!files.length) die(`no shots/*.png under ${src}`);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, "shots"), { recursive: true });
  for (const f of files) copyFileSync(path.join(shotsDir, f), path.join(dir, "shots", f));
  if (existsSync(path.join(src, "index.json"))) copyFileSync(path.join(src, "index.json"), path.join(dir, "index.json"));
  writeFileSync(meta, JSON.stringify({ name: args.name, shots: files.length, shootArgs: shoot, from: shoot ? null : src }, null, 2));
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  console.log(`recorded ${files.length} shots -> ${dir}`);
  process.exit(0);
}

/* compare */
if (!existsSync(meta)) die(`no baseline "${args.name}" at ${dir} (record it first)`);
const maxPct = args["max-pct"] === undefined ? DEFAULTS.maxPct : Number(args["max-pct"]);
const pixelThreshold = args["pixel-threshold"] === undefined ? DEFAULTS.pixelThreshold : Number(args["pixel-threshold"]);
if (!Number.isFinite(maxPct) || !Number.isFinite(pixelThreshold)) die("--max-pct and --pixel-threshold must be numbers");
const outDir = path.resolve(typeof args.out === "string" ? args.out : path.join(dataRoot, "compare", args.name));
if (existsSync(outDir) && readdirSync(outDir).length && !existsSync(path.join(outDir, MARKER)))
  die("--out " + outDir + " exists, is not empty and is not a previous compare output (no " + MARKER + "); refusing to delete it");
let cur, tmp = null;
if (typeof args.from === "string") cur = path.resolve(args.from);
else {
  const given = shootArgs(rest);
  const stored = JSON.parse(readFileSync(meta, "utf8")).shootArgs;
  if (!stored && !given.length) die("this baseline was recorded --from a dir; pass --from <renderDir> or the shoot args to compare");
  const use = mergeArgs(stored, given);
  cur = tmp = mkdtempSync(path.join(tmpdir(), "uilab-cmp-"));
  render(use, cur);
}
rmSync(outDir, { recursive: true, force: true });
mkdirSync(path.join(outDir, "diffs"), { recursive: true });
writeFileSync(path.join(outDir, MARKER), "written by tools/ui-lab/baseline.mjs compare; safe to clear\n");
const { report, diffs } = compareSets(readSet(path.join(dir, "shots")), readSet(path.join(cur, "shots")), { maxPct, pixelThreshold });
for (const [n, buf] of Object.entries(diffs)) writeFileSync(path.join(outDir, "diffs", n), buf);
writeFileSync(path.join(outDir, "report.json"), JSON.stringify({ baseline: args.name, ...report }, null, 2));
const md = renderMarkdown(report, `Baseline compare: ${args.name}`);
writeFileSync(path.join(outDir, "report.md"), md);
if (tmp && !args.keep) rmSync(tmp, { recursive: true, force: true });
console.log(md.split("\n")[2] + `\nreport: ${path.join(outDir, "report.md")}`);
process.exit(report.passed ? 0 : 1);
