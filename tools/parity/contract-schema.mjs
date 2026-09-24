#!/usr/bin/env node
/* Render player/parity/schema/engine-contract.schema.json from
   player/engine-contract.js (docs/native-engine-plan.md §5.1, card NE-11j).

   USAGE
     node tools/parity/contract-schema.mjs --write   regenerate the file
     node tools/parity/contract-schema.mjs --check   exit 1 if it is stale

   WHY GENERATED. The page validates every payload against the schema at run
   time, and it cannot read a JSON file synchronously at boot, so the schema is
   built in engine-contract.js and interpreted there. The .json file is the
   same document for everyone else — the Swift side (NE-11s, NE-20) and a
   human reader — and a hand-kept copy would be the drift this deck exists to
   prevent. engine-contract.test.js (in npm test) is red while the file on disk
   differs from what this renders. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stableJson } from "./record.mjs";
import { contractSchemaDocument } from "../../player/engine-contract.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const SCHEMA_FILE = "player/parity/schema/engine-contract.schema.json";

/** The file's exact bytes: the record.mjs formatter, so it reads like every
    other parity file and a regenerate of an unchanged module is a no-op. */
export function renderContractSchema() {
  return stableJson(contractSchemaDocument());
}

export function isStale(root = REPO_ROOT) {
  const file = path.join(root, SCHEMA_FILE);
  return !fs.existsSync(file) || fs.readFileSync(file, "utf8") !== renderContractSchema();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const mode = process.argv[2];
  if (mode === "--write") {
    fs.writeFileSync(path.join(REPO_ROOT, SCHEMA_FILE), renderContractSchema());
    console.log(`wrote ${SCHEMA_FILE}`);
  } else if (mode === "--check") {
    if (isStale()) {
      console.error(`${SCHEMA_FILE} is stale: run node tools/parity/contract-schema.mjs --write`);
      process.exitCode = 1;
    } else console.log(`${SCHEMA_FILE} is current`);
  } else {
    console.error("usage: node tools/parity/contract-schema.mjs --write | --check");
    process.exitCode = 2;
  }
}
