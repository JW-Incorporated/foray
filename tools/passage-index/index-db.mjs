#!/usr/bin/env node
/* The passage store's CLI (GV-28, from W3-07; docs/roadmap/generation-v2.md).

     node --experimental-sqlite tools/passage-index/index-db.mjs ingest --passages f [--db path]
     node --experimental-sqlite tools/passage-index/index-db.mjs embed --embedder stub|transformers|openai [--db path] [--batch n]

   ingest  reads a cutter JSONL (indexBodies --passages-out) line by line and
           replaces each episode's passages in one transaction; it creates the
           store when it is absent.
   embed   embeds every passage with no vector under the embedder's model, in
           sub-chunks of at most 400 tokens (never truncated), and prints
           chunks per passage.

   --db defaults to data-local/passage-index/passages.db. The openai embedder
   reads FORAY_EMBED_URL, FORAY_EMBED_MODEL, FORAY_EMBED_KEY and
   FORAY_EMBED_DIM from the environment, never from argv. Each command prints
   one JSON summary line on stdout. Exit: 0 done, 1 failed or bad arguments.
   --experimental-sqlite is needed on Node 22.x (node:sqlite is flagged
   there) and accepted on later versions. */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { isEntryScript } from "../ci/entry.mjs";
import { createPassageEmbedder, EMBEDDER_KINDS } from "./embedder.mjs";
import { backfillEmbeddings, DEFAULT_DB_PATH, DEFAULT_EMBED_BATCH, ingestPassages, openStore } from "./store.mjs";

const USAGE =
  "usage: index-db.mjs ingest --passages <file.jsonl> [--db path]\n" +
  `       index-db.mjs embed --embedder ${EMBEDDER_KINDS.join("|")} [--db path] [--batch n]`;

/** Parse argv (without node and the script). Throws on a bad command or flag. */
export function parseIndexDbArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "ingest" && command !== "embed") throw new Error(`unknown command ${JSON.stringify(command ?? null)}\n${USAGE}`);
  const allowed = command === "ingest" ? ["--passages", "--db"] : ["--embedder", "--db", "--batch"];
  const out = { command, db: DEFAULT_DB_PATH, passages: null, embedder: null, batch: DEFAULT_EMBED_BATCH };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!allowed.includes(flag)) throw new Error(`unknown flag ${flag} for ${command}\n${USAGE}`);
    const value = rest[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    if (flag === "--db") out.db = path.resolve(value);
    else if (flag === "--passages") out.passages = path.resolve(value);
    else if (flag === "--embedder") out.embedder = value;
    else if (flag === "--batch") {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--batch must be a positive integer, got ${value}`);
      out.batch = n;
    }
  }
  if (command === "ingest" && !out.passages) throw new Error(`ingest needs --passages\n${USAGE}`);
  if (command === "embed" && !EMBEDDER_KINDS.includes(out.embedder)) {
    throw new Error(`embed needs --embedder ${EMBEDDER_KINDS.join("|")}\n${USAGE}`);
  }
  return out;
}

/** Run one command; returns the summary it printed. `embedderOptions` is a
 * test seam (an injected fetch or createEmbedder). */
export async function runIndexDb(args, { stdout = process.stdout, embedderOptions = {} } = {}) {
  if (args.command === "ingest") {
    if (!fs.existsSync(args.passages)) throw new Error(`no passages file at ${args.passages}`);
    const db = openStore(args.db, { create: true });
    try {
      const lines = readline.createInterface({ input: fs.createReadStream(args.passages, "utf8"), crlfDelay: Infinity });
      const summary = { command: "ingest", db: args.db, ...(await ingestPassages(db, lines)) };
      stdout.write(`${JSON.stringify(summary)}\n`);
      return summary;
    } finally {
      db.close();
    }
  }
  const embedder = await createPassageEmbedder({ kind: args.embedder, ...embedderOptions });
  const db = openStore(args.db);
  try {
    const report = await backfillEmbeddings(db, embedder, { batch: args.batch });
    const summary = {
      command: "embed",
      db: args.db,
      model: { id: report.model.id, name: report.model.name, revision: report.model.revision, dim: report.model.dim },
      tokenizer: report.tokenizer,
      passages: report.passages,
      chunks: report.chunks,
      emptyPassages: report.emptyPassages,
      chunksPerPassage: report.chunksPerPassage,
    };
    stdout.write(`${JSON.stringify(summary)}\n`);
    return summary;
  } finally {
    db.close();
  }
}

async function main() {
  try {
    await runIndexDb(parseIndexDbArgs(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`index-db: ${err?.message ?? err}\n`);
    process.exitCode = 1;
  }
}

if (isEntryScript(import.meta.url)) await main();
