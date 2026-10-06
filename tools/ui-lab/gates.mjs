#!/usr/bin/env node
/* Hard-limit gates: PLAN.md "Hard limits" (security/CSP, 44px taps, reduced
 * motion, focus in sheets, AA contrast) checked mechanically on every screen
 * the harness can reach, before a judge looks at it.
 *
 *   node tools/ui-lab/gates.mjs --target app [--allow tools/ui-lab/gates-known-debt.json]
 *   node tools/ui-lab/gates.mjs --target url --url <file|URL> --routes "#/,#/x"
 *   options: --out <dir> (default data-local/redesign/gates/<run>)  --run <name>
 *            --states a,b  --viewports 393x852,375x667,412x915  --css <file>
 *            --write-allow <file>   record today's violations as the known-debt list
 *            --no-remote-images
 *            --no-reduce   calibration: run the motion pass WITHOUT reduced motion (must find motion)
 *
 * Gates: errors, requests, csp, tap-targets, reduced-motion, overflow,
 * sheet-focus, contrast. Everything except overflow runs at the FIRST viewport;
 * overflow runs at every viewport. Writes gates.json + report.md. Exit 1 on any
 * violation not in the --allow list, 2 on usage.
 */
import path from "node:path";
import { createRequire } from "node:module";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { parseArgs, parseViewports } from "./lib/args.mjs";
import { walk, repoRootFrom, readCss } from "./lib/walk.mjs";
import { MIN_TAP_PX } from "./lib/gates/config.mjs";
import { INIT_SCRIPT, collectTapTargets, measureOverflow, traceSheet } from "./lib/gates/measure.mjs";
import {
  GATES, evaluateErrors, evaluateRequests, evaluateCsp, evaluateTapTargets, evaluateReducedMotion,
  evaluateOverflow, evaluateSheetFocus, evaluateContrast, splitByAllow, toAllowList, countsByGate, renderMarkdown, dedupe,
} from "./lib/gates/rules.mjs";

const require = createRequire(import.meta.url);
const AXE_SRC = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const args = parseArgs(process.argv.slice(2));
const target = args.target || "app";
if (!["app", "url"].includes(target) || (target === "url" && !args.url)) {
  console.error("usage: gates.mjs --target app | --target url --url <file|URL> [--routes r1,r2] [--allow file] [--write-allow file] [--out dir]");
  process.exit(2);
}
const repoRoot = repoRootFrom(import.meta.url);
const runName = typeof args.run === "string" ? args.run : new Date().toISOString().replace(/[:.]/g, "-");
const out = path.resolve(typeof args.out === "string" ? args.out : path.join(repoRoot, "data-local", "redesign", "gates", runName));
mkdirSync(out, { recursive: true });
const viewports = parseViewports(args.viewports, "393x852,375x667,412x915");
const first = viewports[0].name;
const routes = typeof args.routes === "string" ? args.routes.split(",").map((s) => s.trim()) : [];
const base = {
  target, repoRoot, url: args.url, routes, css: readCss(typeof args.css === "string" ? args.css : ""),
  states: typeof args.states === "string" ? args.states.split(",") : null,
  remoteImages: !args["no-remote-images"],
};

const screenOf = (c) => `${c.state}/${c.label}`;
const violations = [];
const screens = new Set();
const traced = []; // screens where a dialog was open and the focus script ran (proves the sheet gate saw something)

/* ---- pass 1: default motion preference; every gate except reduced-motion ---- */
const csp = [], reqs = [];
const pass1 = await walk(
  {
    ...base, viewports,
    async onPage(page, cur) {
      await page.exposeFunction("__gatesCsp", (e) => { if (page.viewportSize().width === viewports[0].w) csp.push({ ...e, screen: screenOf(cur()) }); });
      await page.exposeFunction("__gatesMotion", () => {});
      await page.addInitScript(INIT_SCRIPT);
      const origin = () => { try { return new URL(page.url()).origin; } catch (_) { return null; } };
      const isFirstVp = () => page.viewportSize().width === viewports[0].w;
      const record = (r) => isFirstVp() && reqs.push({ screen: screenOf(cur()), ...r });
      page.on("requestfailed", (rq) => record({ url: rq.url(), failure: rq.failure() && rq.failure().errorText, status: null, sameOrigin: new URL(rq.url()).origin === origin() }));
      page.on("response", (rs) => { if (rs.status() >= 400) record({ url: rs.url(), failure: null, status: rs.status(), sameOrigin: new URL(rs.url()).origin === origin() }); });
    },
  },
  async (page, meta) => {
    const screen = `${meta.state}/${meta.label}`;
    screens.add(screen);
    const ov = await page.evaluate(measureOverflow);
    violations.push(...evaluateOverflow(screen, { ...ov, viewport: meta.viewport }));
    if (meta.viewport !== first) return null;
    violations.push(...evaluateTapTargets(screen, await page.evaluate(collectTapTargets, MIN_TAP_PX)));
    await page.evaluate(AXE_SRC); // page.evaluate is not subject to the page's CSP
    const nodes = await page.evaluate(async () => {
      // eslint-disable-next-line no-undef
      const r = await axe.run(document, { runOnly: { type: "rule", values: ["color-contrast"] }, resultTypes: ["violations"] });
      return r.violations.flatMap((x) => x.nodes.map((n) => ({ target: n.target.join(" "), summary: (n.failureSummary || "").split("\n").slice(0, 2).join(" | ").slice(0, 200) })));
    });
    violations.push(...evaluateContrast(screen, nodes));
    /* last: it presses keys and closes the sheet */
    const trace = await traceSheet(page);
    if (trace) traced.push(`${screen} [${trace.dialog}] closedBy=${trace.closedBy} returnChecked=${trace.returnChecked}`);
    violations.push(...evaluateSheetFocus(screen, trace));
    return null;
  }
);
violations.push(...evaluateErrors(pass1.errors.filter((e) => e.viewport === first)));
violations.push(...evaluateRequests(reqs));
violations.push(...evaluateCsp(csp));

/* ---- pass 2: prefers-reduced-motion: reduce, first viewport only ---- */
const motion = new Map();
const pass2 = await walk(
  {
    ...base, viewports: [viewports[0]], reducedMotion: args["no-reduce"] ? "no-preference" : "reduce", /* --no-reduce is calibration only: proves the recorder sees the app's real motion */
    async onPage(page, cur) {
      await page.exposeFunction("__gatesCsp", () => {});
      await page.exposeFunction("__gatesMotion", (r) => { const k = screenOf(cur()); (motion.get(k) || motion.set(k, []).get(k)).push(r); });
      await page.addInitScript(INIT_SCRIPT);
    },
  },
  async (page, meta) => {
    const screen = `${meta.state}/${meta.label}`;
    /* Still-running animations at the shot, in addition to the events that fired while the step ran. */
    const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").map((a) => {
      const t = a.effect && a.effect.target; let d = 0; try { d = a.effect.getComputedTiming().duration; } catch (_) { /* ignore */ }
      const sel = t && t.tagName ? t.tagName.toLowerCase() + (t.id ? "#" + t.id : "") + ([...t.classList][0] ? "." + [...t.classList][0] : "") : "?";
      return { kind: "running", name: a.animationName || a.transitionProperty || a.constructor.name, selector: sel + ((a.effect && a.effect.pseudoElement) || ""), duration: typeof d === "number" ? d : 0 };
    }));
    (motion.get(screen) || motion.set(screen, []).get(screen)).push(...running);
    return null;
  }
);
const motionSeen = [...motion.values()].reduce((a, r) => a + r.length, 0); // every record, including instant ones
for (const [screen, recs] of motion) violations.push(...evaluateReducedMotion(screen, recs));

const all = dedupe(violations);
const walkFailures = [...pass1.errors, ...pass2.errors].filter((e) => e.kind === "walk-failure");

/* ---- known debt ---- */
let allow = null;
if (typeof args.allow === "string") {
  if (!existsSync(args.allow)) { console.error(`--allow file not found: ${args.allow}`); process.exit(2); }
  allow = JSON.parse(readFileSync(args.allow, "utf8"));
}
const { fresh, known, stale } = splitByAllow(all, allow);
if (typeof args["write-allow"] === "string") {
  const note = `Known debt as of ${new Date().toISOString().slice(0, 10)} (gates.mjs on ${target === "app" ? "the app" : args.url}). Each entry is a hard-limit violation the redesign must burn down; an entry no longer reproduced shows up as stale. Our own data, no screenshots.`;
  writeFileSync(args["write-allow"], JSON.stringify(toAllowList(all, note), null, 2) + "\n");
}

const meta = `Target: ${target}${args.url ? ` (${args.url})` : ""}. Viewports: ${viewports.map((v) => v.name).join(", ")} (all gates at ${first}; overflow at every viewport). Run: ${runName}.`;
writeFileSync(path.join(out, "gates.json"), JSON.stringify({ meta, counts: countsByGate(all), sheetsTraced: traced, motionRecordsSeen: motionSeen, fresh, known, stale, walkFailures, screens: [...screens] }, null, 2));
let md = renderMarkdown({ fresh, known, stale, screens: screens.size, meta });
if (walkFailures.length) md += `\n## Walk failures\n\n${walkFailures.map((e) => `- ${e.state}@${e.viewport}: ${e.message}`).join("\n")}\n`;
writeFileSync(path.join(out, "report.md"), md);

const c = countsByGate(all);
console.log(`screens: ${screens.size}  ` + GATES.map((g) => `${g}: ${c[g]}`).join("  "));
console.log(`sheets traced: ${traced.length}  motion records seen under reduce (incl. instant): ${motionSeen}`);
console.log(`new: ${fresh.length}  known: ${known.length}  stale: ${stale.length}  -> ${out}`);
if (fresh.length || walkFailures.length) process.exitCode = 1;
