#!/usr/bin/env node
/* Car posture's acceptance facts (docs/redesign-2026/directions/ambient/BUILD-PLAN.md 2.2, screen 8), measured in a real
 * browser against the real app. The browser-only half of the car posture's tests: test/ambient-now-playing-car.test.js
 * holds what a DOM-less suite can see (the stylesheet's numbers, the wiring, the gesture logic); this holds what only
 * layout and real pointer input can say - that Play clears the viewport bottom by 24px, that the title takes three
 * lines at 852 and two at 667, that a 600ms hold enters and a 150ms press does not.
 *
 *   node tools/ui-lab/car-check.mjs [--viewports 393x852,375x667] [--schemes dark] [--out dir] [--no-remote-images]
 *
 * It walks the `player` state (its `now-playing-car` step holds the mini row for 800ms, as a thumb would) in each viewport
 * and scheme, measures the sheet (lib/car-measure.mjs), evaluates every acceptance line (lib/car-rules.mjs, unit-tested
 * in car-check.test.mjs), and then drives the rest with real pointer input: the chip leaves, collapsing ends it, a short
 * press does not enter, a hold does and calls the haptic hook, and `?posture=car` opens Now Playing by itself.
 * Writes car-check.json and report.md. Exit 1 on any violation, 2 on usage.
 *
 * Ambient is a dark-first direction, so the default scheme is dark; pass --schemes dark,light for the secondary pass. */
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs, parseViewports } from "./lib/args.mjs";
import { walk, repoRootFrom } from "./lib/walk.mjs";
import { measureCar } from "./lib/car-measure.mjs";
import { evaluateCar, evaluateInteractions, evaluateShortTitle, evaluateEntered, evaluateTitle, renderReport } from "./lib/car-rules.mjs";

const args = parseArgs(process.argv.slice(2));
const repoRoot = repoRootFrom(import.meta.url);
const viewports = parseViewports(args.viewports, "393x852,375x667");
const schemes = String(typeof args.schemes === "string" ? args.schemes : "dark").split(",").map((s) => s.trim());
if (schemes.some((s) => !["dark", "light"].includes(s))) { console.error("usage: car-check.mjs [--schemes dark,light] [--viewports 393x852,375x667] [--out dir]"); process.exit(2); }
const runName = typeof args.run === "string" ? args.run : new Date().toISOString().replace(/[:.]/g, "-");
const out = path.resolve(typeof args.out === "string" ? args.out : path.join(repoRoot, "data-local", "redesign", "car-check", runName));
mkdirSync(out, { recursive: true });

const violations = [];
let evaluations = 0;
const screensSeen = new Set();
const wait = (page, ms) => page.waitForTimeout(ms);
const note = (list) => { evaluations++; violations.push(...list); };

async function measure(page) { return page.evaluate(measureCar); }

async function run(page, meta, scheme) {
  const label = `${meta.state}/${meta.label}@${meta.viewport}/${scheme}`;
  screensSeen.add(label);
  const posture = () => page.evaluate(() => document.documentElement.getAttribute("data-posture"));
  const sheetOpen = () => page.evaluate(() => { const s = document.querySelector(".fp-sheet"); return Boolean(s && !s.hidden && s.getClientRects().length > 0); });
  const close = async () => { if (await sheetOpen()) { await page.locator(".fp-close").first().click(); await wait(page, 900); } };

  /* 1. the screen as the step left it: posture on, Now Playing open by itself. */
  const m = await measure(page);
  note(evaluateCar(label, m));

  /* 2. a short title takes the lines it needs and shows no ellipsis, whatever the clamp. */
  const original = await page.evaluate(() => document.querySelector(".fp-s-title").textContent);
  await page.evaluate(() => { document.querySelector(".fp-s-title").textContent = "A short title"; });
  await wait(page, 200);
  note(evaluateShortTitle(label, await measure(page)));
  await page.evaluate((t) => { document.querySelector(".fp-s-title").textContent = t; }, original);
  await wait(page, 200);

  /* 3. the chip leaves posture and keeps the sheet; collapsing the sheet ends a posture the chip did not. */
  await page.locator(".ag-np-car-chip").click();
  await wait(page, 300);
  const afterChip = await measure(page);
  const postureAfterChip = await posture();
  const sheetOpenAfterChip = await sheetOpen();
  const chipRenderedAfterChip = Boolean(afterChip.chip && afterChip.chip.rendered);
  await close();

  /* 4. a 150ms press is a tap, not a hold; a 750ms hold enters, opens Now Playing and fires the haptic hook. */
  const box = await page.evaluate(() => { const r = document.querySelector(".fp-info").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await wait(page, 150);
  await page.mouse.up();
  await wait(page, 600);
  const earlyReleasePosture = await posture();
  await close();
  await page.evaluate(() => {
    window.__hapticCalls = 0;
    window.Capacitor = { Plugins: { Haptics: { impact: () => { window.__hapticCalls += 1; } } } };
  });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await wait(page, 750);
  const postureAfterHold = await posture();
  await page.mouse.up();
  await wait(page, 900);
  const sheetOpenAfterHold = await sheetOpen();
  const hapticCalls = await page.evaluate(() => window.__hapticCalls);
  note(evaluateEntered(`${label} (after a hold)`, await measure(page)));
  await page.locator(".fp-close").first().click();
  await wait(page, 900);
  const postureAfterCollapse = await posture();
  note(evaluateInteractions(label, { earlyReleasePosture, postureAfterHold, sheetOpenAfterHold, hapticCalls, postureAfterChip, sheetOpenAfterChip, chipRenderedAfterChip, postureAfterCollapse }));

  /* 5. ?posture=car: with something to show, Now Playing opens by itself and the Dock is out. Reloaded on the same origin
        so the seeded profile (and the restored episode) carry over. */
  const url = new URL(page.url());
  await page.goto(`${url.origin}${url.pathname}?posture=car#/library`);
  await page.waitForSelector(".fp-sheet", { state: "visible", timeout: 15000 }).catch(() => {});
  await wait(page, 1200);
  const viaUrl = await measure(page);
  note(evaluateEntered(`${label} (?posture=car)`, viaUrl));
  note(evaluateTitle(`${label} (?posture=car)`, viaUrl));
}

for (const scheme of schemes) {
  const { errors } = await walk(
    { target: "app", repoRoot, viewports, states: ["player"], remoteImages: !args["no-remote-images"], scheme },
    async (page, meta) => {
      if (meta.label !== "now-playing-car") return null;
      await run(page, meta, scheme);
      return null;
    },
  );
  for (const e of errors.filter((x) => x.kind === "walk-failure")) violations.push({ rule: "walk", screen: `${e.state}@${e.viewport}/${scheme}`, detail: e.message });
}

if (!screensSeen.size) violations.push({ rule: "walk", screen: "-", detail: "no now-playing-car step was reached: nothing was measured" });
const report = renderReport(violations, { screens: screensSeen.size, checks: evaluations });
writeFileSync(path.join(out, "report.md"), report);
writeFileSync(path.join(out, "car-check.json"), JSON.stringify({ screens: [...screensSeen], evaluations, violations }, null, 2));
console.log(report);
console.log(`out: ${out}`);
process.exit(violations.length ? 1 : 0);
