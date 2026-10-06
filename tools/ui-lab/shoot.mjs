#!/usr/bin/env node
/* Screenshot harness. See README.md.
 *
 *   node tools/ui-lab/shoot.mjs --target app --out <dir> [--states a,b] [--viewports 393x852,...]
 *   node tools/ui-lab/shoot.mjs --target url --url <file|http URL> --routes "#/,#/x" --out <dir>
 *   options: --css <file>  --full  --no-remote-images  --scheme dark|light  --title <text>
 */
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { parseArgs, parseViewports, slug } from "./lib/args.mjs";
import { walk, repoRootFrom, readCss } from "./lib/walk.mjs";
import { writeContactSheet } from "./lib/contact.mjs";
import { FIXED_NOW_ISO } from "./lib/seed.mjs";

const args = parseArgs(process.argv.slice(2));
const target = args.target || "app";
if (!["app", "url"].includes(target) || !args.out || (target === "url" && !args.url)) {
  console.error("usage: shoot.mjs --target app --out <dir> | --target url --url <file|URL> [--routes r1,r2] --out <dir>\n" +
    "       [--states a,b] [--viewports WxH,...] [--css file] [--full] [--no-remote-images] [--scheme dark|light]");
  process.exit(2);
}
const out = path.resolve(args.out);
mkdirSync(out, { recursive: true });
const viewports = parseViewports(args.viewports, "393x852,375x667,412x915");
const routes = typeof args.routes === "string" ? args.routes.split(",").map((s) => s.trim()).filter((s, i, a) => s !== "" || a.length === 1) : [];
const css = readCss(typeof args.css === "string" ? args.css : "");

let n = 0;
const used = new Set();
const t0 = Date.now();
const run = await walk(
  {
    target, repoRoot: repoRootFrom(import.meta.url), url: args.url, routes, css, viewports,
    states: typeof args.states === "string" ? args.states.split(",") : null,
    remoteImages: !args["no-remote-images"], scheme: typeof args.scheme === "string" ? args.scheme : "dark",
  },
  async (page, meta) => {
    let name = `${meta.state}__${slug(meta.label)}__${meta.viewport}.png`;
    while (used.has(name)) name = name.replace(/\.png$/, `-${++n}.png`);
    used.add(name);
    const rel = path.join("shots", name).replace(/\\/g, "/");
    mkdirSync(path.join(out, "shots"), { recursive: true });
    await page.screenshot({ path: path.join(out, rel), animations: "disabled", caret: "hide", fullPage: !!args.full });
    return { path: rel };
  }
);

/* order: state in plan order, step order as walked (results arrive interleaved across viewports) */
const stateOrder = run.states.map((s) => s.id);
const byVp = new Map();
for (const r of run.results) {
  if (!byVp.has(r.viewport)) byVp.set(r.viewport, []);
  byVp.get(r.viewport).push(r);
}
const browser = await chromium.launch();
const contact = [];
try {
  for (const vp of viewports) {
    const shots = (byVp.get(vp.name) || []).sort((a, b) => stateOrder.indexOf(a.state) - stateOrder.indexOf(b.state));
    if (!shots.length) continue;
    contact.push(await writeContactSheet(browser, out, vp, shots, { title: typeof args.title === "string" ? args.title : `${target} ${target === "url" ? args.url : "(current app)"}` }));
  }
} finally { await browser.close(); }

const summarize = (log) => log.reduce((a, x) => ((a[x.kind] = (a[x.kind] || 0) + 1), a), {});
const index = {
  generated_by: "tools/ui-lab/shoot.mjs",
  target, url: args.url || null,
  clock_start: FIXED_NOW_ISO, device_scale_factor: 2,
  viewports: viewports.map((v) => v.name),
  css: typeof args.css === "string" ? args.css : null,
  remote_images: !args["no-remote-images"],
  states: run.states,
  contact_sheets: contact,
  shots: run.results.map(({ route, state, label, viewport, path: p }) => ({ route, state, label, viewport, path: p })),
  network: { answered_or_refused: summarize(run.stubLog), refused: run.stubLog.filter((x) => x.kind === "refused").slice(0, 40) },
  errors: run.errors,
  seconds: Math.round((Date.now() - t0) / 1000),
};
writeFileSync(path.join(out, "index.json"), JSON.stringify(index, null, 2));
console.log(`shots: ${index.shots.length}  contact sheets: ${contact.join(", ")}  errors: ${run.errors.length}  ${index.seconds}s`);
console.log(`network: ${JSON.stringify(index.network.answered_or_refused)}`);
console.log(`out: ${out}`);
const failed = run.errors.filter((e) => e.kind === "walk-failure");
if (failed.length) { console.error("walk failures:\n" + failed.map((f) => ` ${f.state}@${f.viewport}: ${f.message}`).join("\n")); process.exitCode = 1; }
