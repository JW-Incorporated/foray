#!/usr/bin/env node
/* Write or check player/parity/foray-builds.json (NE-29s): the page's build of
   every committed Foray a player/parity/forays.js case names, which the Swift
   parity runner reads because the engine never builds a Foray (plan §3 A-1).

     node tools/parity/foray-builds.mjs --write   regenerate it from data/
     node tools/parity/foray-builds.mjs --check   exit 1 when it is stale

   `--check` is NOT in npm test, on purpose: a publish that repairs a committed
   Foray's data changes its build, and a data publish must never turn npm test
   red for a parity file (the argument player/parity/forays.js makes for its
   authored cases). What npm test holds instead (player/parity/run.test.js) is
   that every named Foray HAS a build here and that every build here passes the
   same authored rules in JS. Refresh with --write in the next parity change. */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT, loadFixtures } from "../../player/parity/runner.js";
import { BUILDS_FILE, buildTable, serializeTable } from "../../player/parity/forays.js";

export function expectedText(root = REPO_ROOT) {
  return serializeTable(buildTable(loadFixtures(root)));
}

function main(argv) {
  const file = path.join(REPO_ROOT, BUILDS_FILE);
  const want = expectedText();
  if (argv.includes("--write")) {
    fs.writeFileSync(file, want);
    console.log(`wrote ${BUILDS_FILE}`);
    return 0;
  }
  if (argv.includes("--check")) {
    const have = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (have === want) {
      console.log(`${BUILDS_FILE} is current`);
      return 0;
    }
    console.error(`${BUILDS_FILE} is stale: run node tools/parity/foray-builds.mjs --write`);
    return 1;
  }
  console.error("usage: node tools/parity/foray-builds.mjs --write | --check");
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2));
