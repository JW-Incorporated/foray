#!/usr/bin/env node
/* The Dock's acceptance facts (docs/redesign-2026/directions/ambient/BUILD-PLAN.md 2.1, screen 2), measured in a
 * real browser against the real app. The browser-only half of the Dock's tests: test/dock.test.js and
 * test/tab-bar.test.js hold what a DOM-less suite can see; this holds what only layout can say - that the rows
 * share an edge, that no text sits in the band below the Dock, that the tab row recedes at 80px and restores on
 * any upward scroll, that a mini-row hold enters car posture.
 *
 *   node tools/ui-lab/dock-check.mjs [--viewports 375x667,393x852] [--schemes dark,light] [--out dir]
 *                                    [--no-remote-images]
 *
 * It walks the `dock`, `player` and `returning` states (tools/ui-lab/lib/states.mjs) in each scheme and viewport,
 * and at each Dock screen: measures the Dock (lib/dock-measure.mjs) at three scroll offsets, evaluates every row of
 * the acceptance (lib/dock-rules.mjs, unit-tested in dock-check.test.mjs), and on the last step of `dock` also
 * drives the interactions: the recede sequence, the folded routes, the field's focus, and the 600ms hold.
 * Writes dock-check.json and report.md. Exit 1 on any violation, 2 on usage.
 *
 * Run it on the branch before pushing; a baseline machine's Chromium is not required (nothing here compares
 * pixels), only a Chromium (README: one-time `npx playwright install chromium`). */
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs, parseViewports } from "./lib/args.mjs";
import { walk, repoRootFrom } from "./lib/walk.mjs";
import { measureDock, runRecedeSequence } from "./lib/dock-measure.mjs";
import {
  evaluateRows, evaluateMiniRow, evaluateTabs, evaluateDecorations, evaluateBand, evaluateFocused,
  evaluateRedirects, evaluateCar, evaluateRecede, renderReport,
} from "./lib/dock-rules.mjs";

const args = parseArgs(process.argv.slice(2));
const repoRoot = repoRootFrom(import.meta.url);
const viewports = parseViewports(args.viewports, "375x667,393x852");
const schemes = String(typeof args.schemes === "string" ? args.schemes : "dark,light").split(",").map((s) => s.trim());
if (schemes.some((s) => !["dark", "light"].includes(s))) { console.error("usage: dock-check.mjs [--schemes dark,light] [--viewports 375x667,393x852] [--out dir]"); process.exit(2); }
const runName = typeof args.run === "string" ? args.run : new Date().toISOString().replace(/[:.]/g, "-");
const out = path.resolve(typeof args.out === "string" ? args.out : path.join(repoRoot, "data-local", "redesign", "dock-check", runName));
mkdirSync(out, { recursive: true });

/** What each walked step must show. Anything not listed is not a Dock screen. */
const SCREENS = {
  "dock/dock-discover": { field: true, mini: true },
  "dock/dock-receded": { field: false, mini: true },
  "player/mini-player-home": { field: false, mini: true },
  "player/mini-player-library": { field: false, mini: true },
  "player/mini-player-up-next": { field: false, mini: true },
  "returning/home": { field: false, mini: false },
  "returning/library": { field: false, mini: false },
  "returning/search": { field: true, mini: false },
};
const OFFSETS = [0, 120, 300];
const violations = [];
let evaluations = 0;
const screensSeen = new Set();
const wait = (page, ms) => page.waitForTimeout(ms);

const note = (list) => { evaluations++; violations.push(...list); };

async function sampleScreen(page, meta, scheme, expect) {
  const label = `${meta.state}/${meta.label}@${meta.viewport}/${scheme}`;
  screensSeen.add(label);
  let samples = 0;
  for (const y of OFFSETS) {
    await page.evaluate((to) => window.scrollTo(0, to), y);
    await wait(page, 450);
    const m = await page.evaluate(measureDock, expect);
    const screen = `${label}#${y}`;
    note(evaluateRows(screen, m));
    note(evaluateTabs(screen, m));
    note(evaluateDecorations(screen, m));
    if (expect.mini) note(evaluateMiniRow(screen, m));
    const band = evaluateBand(screen, m);
    samples += band.samples;
    note(band.violations);
  }
  /* A band with nothing in it proves nothing: some scroll position must have put text through it. */
  note(evaluateBand(label, { dock: { bottom: 0 }, viewport: { h: 0 }, fade: { present: false }, text: [] }, { requireSamples: samples === 0 }).violations);
  await page.evaluate(() => window.scrollTo(0, 0));
  await wait(page, 450);
}

async function interactions(page, meta, scheme) {
  const label = `${meta.state}/${meta.label}@${meta.viewport}/${scheme}`;
  /* 1. the recede sequence, from a tall-tab page with room to scroll */
  await page.evaluate(() => { location.hash = "#/"; });
  await wait(page, 900);
  note(evaluateRecede(label, await page.evaluate(runRecedeSequence)));

  /* 2. the folded routes: #/create lands on Discover with the field focused, in the Dock */
  const landed = async (hash) => {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await wait(page, 1000);
    return page.evaluate(() => ({
      hash: location.hash,
      activeId: document.activeElement ? document.activeElement.id : "",
      fieldInDock: Boolean(document.activeElement && document.activeElement.closest && document.activeElement.closest("#dock-field")),
      heading: (document.querySelector("#view .page-head h2") || {}).textContent || "",
    }));
  };
  const create = await landed("#/create");
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  const starred = await landed("#/starred-shows");
  const interests = await landed("#/interests");
  note(evaluateRedirects(label, { create, starred, interests }));

  /* 3. while the field has focus the Dock is the field row alone, and it comes back on blur */
  await page.evaluate(() => { location.hash = "#/shows"; });
  await wait(page, 900);
  await page.focus("#sh-input");
  await wait(page, 450);
  const state = () => page.evaluate(() => {
    const vis = (id) => { const el = document.getElementById(id); return Boolean(el && !el.hidden && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().height > 0); };
    return { searching: document.body.classList.contains("sh-searching"), field: { visible: vis("dock-field") }, mini: { visible: vis("dock-mini") }, tabs: { visible: vis("tab-bar") } };
  });
  note(evaluateFocused(label, await state()));
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await wait(page, 450);
  const after = await state();
  note(after.mini.visible && after.tabs.visible && !after.searching ? [] : [{ rule: "focus-release-restores-the-dock", screen: label, detail: `after blur: ${JSON.stringify(after)}` }]);

  /* 4. a quick tap on the mini row does not enter car posture; a 650ms hold does, and collapsing ends it */
  await page.evaluate(() => { location.hash = "#/"; });
  await wait(page, 900);
  const box = await page.evaluate(() => { const r = document.querySelector("#dock-mini .fp-info").getBoundingClientRect(); return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.5 }; });
  const posture = () => page.evaluate(() => document.documentElement.getAttribute("data-posture"));
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await wait(page, 150);
  await page.mouse.up();
  await wait(page, 500);
  const earlyReleasePosture = await posture();
  if (await page.evaluate(() => !document.querySelector(".fp-sheet").hidden)) await page.locator(".fp-close").first().click();
  await wait(page, 500);
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await wait(page, 750);
  const postureAfterHold = await posture();
  await page.mouse.up();
  await wait(page, 700);
  const inCar = await page.evaluate(() => {
    const shown = (sel) => { const el = document.querySelector(sel); return Boolean(el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().height > 0); };
    return { sheetOpen: !document.querySelector(".fp-sheet").hidden, dockVisibleInCar: shown("#dock"), fadeVisibleInCar: shown(".dock-fade"), castVisibleInCar: shown("#dock-cast") };
  });
  await page.locator(".fp-close").first().click();
  await wait(page, 700);
  note(evaluateCar(label, { ...inCar, postureAfterHold, earlyReleasePosture, postureAfterClose: await posture() }));
}

const quiet = Boolean(args["no-remote-images"]);
for (const scheme of schemes) {
  const { errors } = await walk(
    { target: "app", repoRoot, viewports, states: ["dock", "player", "returning"], remoteImages: !quiet, scheme },
    async (page, meta) => {
      const expect = SCREENS[`${meta.state}/${meta.label}`];
      if (!expect) return null;
      await sampleScreen(page, meta, scheme, expect);
      if (meta.state === "dock" && meta.label === "dock-receded") await interactions(page, meta, scheme);
      return null;
    },
  );
  for (const e of errors.filter((x) => x.kind === "walk-failure")) violations.push({ rule: "walk", screen: `${e.state}@${e.viewport}/${scheme}`, detail: e.message });
}

const report = renderReport(violations, { screens: screensSeen.size, checks: evaluations });
writeFileSync(path.join(out, "report.md"), report);
writeFileSync(path.join(out, "dock-check.json"), JSON.stringify({ screens: [...screensSeen], evaluations, violations }, null, 2));
console.log(report);
console.log(`out: ${out}`);
process.exit(violations.length ? 1 : 0);
