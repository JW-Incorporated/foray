/* The page's build of every Foray a SCENARIO plays (NE-30s), as the Swift
   scenario drivers' input.

   WHY THIS FILE EXISTS. A manager-foray scenario hands `playForay` a raw
   authored Foray and a resolver (the case's `catalogue`, or a real frozen
   Foray through `setup.forayBuild`); a prepare scenario hands the engine's
   `playForay` command authored items. Either way the queue that actually
   plays is `buildForayQueue`'s — and that is the PAGE's code: the engine never
   builds a Foray (plan §3 A-1), its `playForay` receives built items. So the
   Swift drivers need the page's build as INPUT, not a Swift port of the
   builder. This is the NE-29s choice for `$foray` (forays.js,
   foray-builds.json) made for scenarios.

   THE TABLE. `player/parity/scenario-builds.json`, keyed `<case id>@<step
   index>` for every playForay / setQueueFromForay step of the manager-foray
   and prepare families: the built items, the report's projection (skipped
   entries as runner.js `project("forayReport")` shows them, and the warning
   count) and the two options the load-time ladder reads. Written by
   `node tools/parity/scenario-builds.mjs --write`.

   IT IS HELD FRESH BY npm test (run.test.js), unlike foray-builds.json: it is
   a function of the fixtures and the FROZEN fixture data only (a case that
   builds from data/ is refused here), so a data publish can never turn it
   stale, and a re-recorded scenario must refresh it in the same PR.

   The page never imports this file. It is harness code, like runner.js. */

import fs from "node:fs";
import path from "node:path";
import { expandInputs } from "./codec.js";
import { REPO_ROOT, forayBuildFor } from "./runner.js";
import { buildForayQueue } from "../foray-queue.js";

/** Where the table lives, repo-relative. */
export const SCENARIO_BUILDS_FILE = "player/parity/scenario-builds.json";

/** The families whose scenarios play a Foray the page built. */
export const SCENARIO_BUILD_FAMILIES = Object.freeze(["manager-foray", "prepare"]);

/** The calls that hand a Foray to be built. */
const BUILD_CALLS = new Set(["playForay", "setQueueFromForay"]);

/** The key of one build: the case and the step that plays it. */
export const buildKey = (caseId, stepIndex) => `${caseId}@${stepIndex}`;

/**
 * One case's builds, exactly as runner.js builds them for the same steps:
 * the manager target's `playForay(doc, {...opts, resolveItem})` (the case's
 * catalogue, or the frozen build's source index), and the engine target's
 * `playForay` command as reference-engine.js builds it
 * (`setQueueFromForay({id: forayId, title, items}, {isLocalFile, allowAdPad,
 * resolveItem})` over the case's catalogue).
 */
async function caseBuilds(c, ctx) {
  const setup = expandInputs(c.setup ?? {}, ctx);
  if (setup.forayBuild && setup.forayBuild.data !== "frozen") {
    throw new TypeError(`${c.id}: a scenario build must come from the frozen fixture, not ${JSON.stringify(setup.forayBuild.data)} (a data publish must not stale ${SCENARIO_BUILDS_FILE})`);
  }
  const built = setup.forayBuild ? await forayBuildFor(setup.forayBuild, ctx) : null;
  const catalogue = built ? Object.fromEntries(built.sources) : (setup.catalogue ?? {});
  const resolveItem = (id) => catalogue[id] ?? null;
  const out = {};
  for (const [i, step] of (c.steps ?? []).entries()) {
    if (!BUILD_CALLS.has(step.call)) continue;
    let report;
    let isLocalFile;
    let allowAdPad;
    if (setup.target === "engine") {
      const a = expandInputs(step.args ?? {}, ctx);
      isLocalFile = Boolean(a.isLocalFile);
      allowAdPad = Boolean(a.allowAdPad);
      report = buildForayQueue({ id: a.forayId, title: a.title, items: a.items }, { isLocalFile, allowAdPad, resolveItem });
    } else {
      const args = expandInputs(step.args ?? [], ctx);
      const doc = args.length === 0 && built ? built.hydrated : args[0];
      const opts = args[1] ?? {};
      isLocalFile = Boolean(opts.isLocalFile);
      allowAdPad = Boolean(opts.allowAdPad);
      report = buildForayQueue(doc, { ...opts, resolveItem });
    }
    out[buildKey(c.id, i)] = {
      isLocalFile,
      allowAdPad,
      warnings: (report.warnings ?? []).length,
      skipped: (report.skipped ?? []).map((s) => ({ index: s.index, id: s.id ?? null, item_id: s.item_id ?? null })),
      items: report.items ?? [],
    };
  }
  return out;
}

/** The whole table, over the loaded fixtures (runner.js `loadFixtures`). */
export async function scenarioBuildTable(fixtures, root = REPO_ROOT) {
  const ctx = { root };
  const table = {};
  for (const { family, doc } of fixtures) {
    if (!SCENARIO_BUILD_FAMILIES.includes(family)) continue;
    for (const c of doc.cases) Object.assign(table, await caseBuilds(c, ctx));
  }
  return table;
}

/** The table as the file holds it: keys sorted, one queue item per line, so
    a refresh diffs by item. */
export function serializeScenarioBuilds(table) {
  const note = "NE-30s: the page's build (buildForayQueue) of every Foray a manager-foray or prepare scenario plays, keyed <case id>@<step index>. The Swift scenario drivers read it (the engine never builds a Foray, plan §3 A-1). Refresh: node tools/parity/scenario-builds.mjs --write; run.test.js holds it current.";
  const NL = "\n";
  const entries = Object.keys(table).sort().map((key) => {
    const b = table[key];
    const items = b.items.map((it) => `        ${JSON.stringify(it)}`).join("," + NL);
    return [
      `    ${JSON.stringify(key)}: {`,
      `      "isLocalFile": ${JSON.stringify(b.isLocalFile)}, "allowAdPad": ${JSON.stringify(b.allowAdPad)}, "warnings": ${JSON.stringify(b.warnings)},`,
      `      "skipped": ${JSON.stringify(b.skipped)},`,
      b.items.length ? `      "items": [${NL}${items}${NL}      ]` : `      "items": []`,
      "    }",
    ].join(NL);
  }).join("," + NL);
  return ["{", `  "//": ${JSON.stringify(note)},`, `  "builds": {`, entries, "  }", "}", ""].join(NL);
}

/** What the file should say, from the tree. */
export async function expectedScenarioBuilds(fixtures, root = REPO_ROOT) {
  return serializeScenarioBuilds(await scenarioBuildTable(fixtures, root));
}

/** What the file says now ("" when it is missing). */
export function currentScenarioBuilds(root = REPO_ROOT) {
  const file = path.join(root, SCENARIO_BUILDS_FILE);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}
