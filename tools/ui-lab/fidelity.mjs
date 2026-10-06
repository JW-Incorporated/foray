#!/usr/bin/env node
/* Prototype-vs-implementation fidelity. See README.md ("Fidelity") and lib/fidelity.mjs.
 *
 *   node tools/ui-lab/fidelity.mjs --direction tactile [--screens home,now-playing]
 *        [--viewports 393x852] [--against app|self] [--max-region-delta 8] [--run name]
 *        [--out dir] [--scheme dark|light] [--remote-images] [--pixel-threshold 0]
 *
 * For every screen in docs/redesign-2026/directions/<direction>/screens.json it shoots the
 * prototype route and the app state it maps to (same viewport, same frozen clock and seeded
 * random from lib/walk.mjs), then writes per screen: side-by-side PNG (prototype | app), a
 * pixel-diff %, and region boxes (position and size deltas in px). Screens whose "app" is null
 * have no equivalent in today's app yet; they are listed as skipped.
 *
 * --against self re-renders the PROTOTYPE as the "app" side (its own selectors): the sanity
 * check that identical input reads ~0. Nothing gates unless --max-region-delta is given.
 * Output (gitignored, never commit renders): data-local/redesign/fidelity/<run>/
 *   report.json  report.md  shots/{prototype,app}/  side/  diff/
 * Exit: 0 ok, 1 gate failed or a walk failed, 2 usage.
 */
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs, parseViewports } from "./lib/args.mjs";
import { walk, repoRootFrom } from "./lib/walk.mjs";
import { diffPng } from "./lib/diff.mjs";
import {
  parseScreens, planRun, selectorsFor, summarizeMeasure, compareScreen, summarizeRegions,
  sideBySide, buildReport, renderMarkdown,
} from "./lib/fidelity.mjs";

const args = parseArgs(process.argv.slice(2));
const usage = () => {
  console.error("usage: fidelity.mjs --direction <slug> [--screens a,b] [--viewports WxH,...] [--against app|self]\n" +
    "       [--max-region-delta px] [--run name] [--out dir] [--scheme dark|light] [--remote-images] [--pixel-threshold 0..1]");
  process.exit(2);
};
if (typeof args.direction !== "string" || !/^[A-Za-z0-9._-]+$/.test(args.direction)) usage();
const against = args.against === undefined ? "app" : args.against;
if (!["app", "self"].includes(against)) usage();
const maxRegionDelta = args["max-region-delta"] === undefined ? null : Number(args["max-region-delta"]);
if (maxRegionDelta !== null && !(maxRegionDelta >= 0)) usage();

const repoRoot = repoRootFrom(import.meta.url);
const dirRoot = path.join(repoRoot, "docs", "redesign-2026", "directions", args.direction);
const screensPath = path.join(dirRoot, "screens.json");
if (!existsSync(screensPath)) { console.error(`no ${path.relative(repoRoot, screensPath)}`); process.exit(2); }
const protoDir = typeof args["prototype-url"] === "string" ? args["prototype-url"] : path.join(dirRoot, "prototype");

let plan, parsed;
try {
  parsed = parseScreens(JSON.parse(readFileSync(screensPath, "utf8")), path.relative(repoRoot, screensPath));
  plan = planRun(parsed, typeof args.screens === "string" ? args.screens.split(",").map((s) => s.trim()).filter(Boolean) : null);
} catch (e) { console.error(String(e.message || e)); process.exit(2); }

const viewports = parseViewports(args.viewports, "393x852");
const run = typeof args.run === "string" ? args.run : `${args.direction}-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "")}`;
if (!/^[A-Za-z0-9._-]+$/.test(run) || run === "." || run === "..") usage();
const out = path.resolve(typeof args.out === "string" ? args.out : path.join(repoRoot, "data-local", "redesign", "fidelity", run));
for (const d of ["shots/prototype", "shots/app", "side", "diff"]) mkdirSync(path.join(out, d), { recursive: true });
const remoteImages = !!args["remote-images"];
const scheme = typeof args.scheme === "string" ? args.scheme : "dark";
const pixelThreshold = args["pixel-threshold"] === undefined ? 0 : Number(args["pixel-threshold"]);

/** Visible boxes (viewport CSS px) for each selector. Visible = rendered, not hidden, and inside the viewport. */
async function measure(page, selectors) {
  const raw = await page.evaluate((sels) => {
    const res = {};
    for (const [name, sel] of Object.entries(sels)) {
      let els = [];
      try { els = Array.from(document.querySelectorAll(sel)); } catch (_) { /* bad selector: zero matches */ }
      res[name] = els.filter((e) => !e.checkVisibility || e.checkVisibility({ visibilityProperty: true })).map((e) => {
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }).filter((b) => b.w > 0 && b.h > 0 && b.x + b.w > 0 && b.y + b.h > 0 && b.x < innerWidth && b.y < innerHeight).slice(0, 80);
    }
    return res;
  }, selectors);
  return raw;
}

const measuresOf = (screen, side, raw) => {
  const m = {};
  for (const r of screen.regions) if (r[side]) m[r.name] = summarizeMeasure(raw[r.name], r.mode);
  return m;
};

const shots = { prototype: new Map(), app: new Map() }; // `${id}|${vp}` -> { buf, measures, path }
const allErrors = [];
const byId = new Map(plan.screens.map((s) => [s.id, s]));
const byRoute = new Map(plan.screens.map((s) => [s.route, s]));
const nameOf = (id, vp) => `${id}__${vp}.png`;

async function shootPrototype(side, screens) {
  const sideKey = side === "prototype" ? "prototype" : "app"; // self mode stores the second render under "app"
  const sel = (s) => selectorsFor(s, "prototype");
  const r = await walk(
    { target: "url", repoRoot, url: protoDir, routes: screens.map((s) => s.route), viewports, remoteImages, scheme },
    async (page, meta) => {
      const s = byRoute.get(meta.route);
      if (!s) return;
      const buf = await page.screenshot({ animations: "disabled", caret: "hide" });
      const measures = measuresOf(s, "prototype", await measure(page, sel(s)));
      const rel = path.join("shots", sideKey, nameOf(s.id, meta.viewport)).replace(/\\/g, "/");
      writeFileSync(path.join(out, rel), buf);
      shots[sideKey].set(`${s.id}|${meta.viewport}`, { buf, measures, path: rel });
    }
  );
  allErrors.push(...r.errors.map((e) => ({ ...e, side })));
}

async function shootApp() {
  if (!plan.appStates.length) return;
  const r = await walk(
    { target: "app", repoRoot, viewports, states: plan.appStates, remoteImages, scheme },
    async (page, meta) => {
      const ids = plan.appByKey.get(plan.appKey(meta.state, meta.label));
      if (!ids) return;
      const buf = await page.screenshot({ animations: "disabled", caret: "hide" });
      for (const id of ids) {
        const s = byId.get(id);
        const measures = measuresOf(s, "app", await measure(page, selectorsFor(s, "app")));
        const rel = path.join("shots", "app", nameOf(id, meta.viewport)).replace(/\\/g, "/");
        writeFileSync(path.join(out, rel), buf);
        shots.app.set(`${id}|${meta.viewport}`, { buf, measures, path: rel });
      }
    }
  );
  allErrors.push(...r.errors.map((e) => ({ ...e, side: "app" })));
}

const comparable = against === "self" ? plan.screens : plan.screens.filter((s) => s.app);
const t0 = Date.now();
await Promise.all([
  shootPrototype("prototype", plan.screens),
  against === "self" ? shootPrototype("self", plan.screens) : shootApp(),
]);

const screensOut = [];
const skipped = against === "self" ? [] : plan.noApp.map((id) => ({ id, reason: "no equivalent in today's app yet (screens.json app is null)" }));
for (const s of comparable) {
  for (const vp of viewports) {
    const key = `${s.id}|${vp.name}`;
    const p = shots.prototype.get(key);
    const a = shots.app.get(key);
    if (!p || !a) { skipped.push({ id: s.id, reason: `${vp.name}: ${!p ? "prototype" : "app"} shot missing (see harness errors)` }); continue; }
    const d = diffPng(p.buf, a.buf, { pixelThreshold });
    const base = nameOf(s.id, vp.name);
    writeFileSync(path.join(out, "side", base), sideBySide(p.buf, a.buf));
    if (d.diff) writeFileSync(path.join(out, "diff", base), d.diff);
    const regions = compareScreen(s, p.measures, a.measures);
    screensOut.push({
      id: s.id, title: s.title, viewport: vp.name, prototypeRoute: s.route,
      appRef: against === "self" ? `self ${s.route}` : `${s.app.state}/${s.app.step}`,
      pixel: { status: d.status, pct: Number(d.pct.toFixed(4)), changed: d.changed },
      side: `side/${base}`, diff: d.diff ? `diff/${base}` : null,
      regions, summary: summarizeRegions(regions),
    });
  }
}

const report = buildReport({ direction: args.direction, run, against, viewports: viewports.map((v) => v.name), screens: screensOut, skipped, maxRegionDelta, errors: allErrors });
writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
writeFileSync(path.join(out, "report.md"), renderMarkdown(report));

const sm = report.summary;
console.log(`fidelity ${args.direction} (${against}): ${sm.screens} screens, ${sm.skipped} skipped, mean pixel diff ${sm.meanPixelPct ?? "-"}%  ${Math.round((Date.now() - t0) / 1000)}s`);
for (const x of screensOut) console.log(`  ${x.id.padEnd(22)} ${x.viewport}  pixel ${String(x.pixel.pct).padStart(8)}%  regions ${x.summary.compared}/${x.summary.regions}  worst ${x.summary.worst || "-"} ${x.summary.maxDelta ?? ""}`);
console.log(`out: ${out}`);
if (sm.gated) console.log(`gate: ${sm.failingRegions} failing region(s) over ${sm.maxRegionDelta}px`);
const walkFailed = allErrors.some((e) => e.kind === "walk-failure");
if (walkFailed) console.error("walk failures:\n" + allErrors.filter((e) => e.kind === "walk-failure").map((e) => ` ${e.side} ${e.state}@${e.viewport}: ${e.message}`).join("\n"));
process.exitCode = walkFailed || (sm.gated && sm.failingRegions) ? 1 : 0;
