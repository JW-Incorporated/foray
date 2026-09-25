#!/usr/bin/env node
/* Write or check player/parity/scenario-builds.json (NE-30s): the page's build
   of every Foray a manager-foray or prepare scenario plays, which the Swift
   scenario drivers read because the engine never builds a Foray (plan §3 A-1).

     node tools/parity/scenario-builds.mjs --write   regenerate it
     node tools/parity/scenario-builds.mjs --check   exit 1 when it is stale

   Unlike foray-builds.json this one IS held current by npm test
   (player/parity/run.test.js): it depends on the fixtures and the frozen
   fixture data only, never on data/, so only a parity change can stale it. */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT, loadFixtures } from "../../player/parity/runner.js";
import { SCENARIO_BUILDS_FILE, expectedScenarioBuilds, currentScenarioBuilds } from "../../player/parity/scenario-builds.js";

async function main(argv) {
  const want = await expectedScenarioBuilds(loadFixtures(REPO_ROOT));
  if (argv.includes("--write")) {
    fs.writeFileSync(path.join(REPO_ROOT, SCENARIO_BUILDS_FILE), want);
    console.log(`wrote ${SCENARIO_BUILDS_FILE}`);
    return 0;
  }
  if (argv.includes("--check")) {
    if (currentScenarioBuilds(REPO_ROOT) === want) {
      console.log(`${SCENARIO_BUILDS_FILE} is current`);
      return 0;
    }
    console.error(`${SCENARIO_BUILDS_FILE} is stale: run node tools/parity/scenario-builds.mjs --write`);
    return 1;
  }
  console.error("usage: node tools/parity/scenario-builds.mjs --write | --check");
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await main(process.argv.slice(2));
