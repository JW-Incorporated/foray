#!/usr/bin/env node
/* corpus — the research-corpus CLI (humans and agents).
 *
 *   node tools/corpus/corpus.mjs init
 *   node tools/corpus/corpus.mjs load-manifest [--dossier <path>]
 *   node tools/corpus/corpus.mjs ingest (--all | --area N | --source ID) [--force]
 *   node tools/corpus/corpus.mjs search "query" [--limit N]
 *   node tools/corpus/corpus.mjs stats
 *   node tools/corpus/corpus.mjs refetch <source_id>
 *   node tools/corpus/corpus.mjs report [--write]
 *
 * DB + archives: data-local/corpus/ (gitignored). See README.md.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openMigrated } from "./db.mjs";
import { parseDossierFile, loadManifest } from "./manifest.mjs";
import { createFetcher } from "./fetcher.mjs";
import { createHostGate } from "./hostgate.mjs";
import { ingestMany } from "./ingest.mjs";
import { coverageMarkdown, deadLinksMarkdown, coverageData } from "./report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const DEFAULT_DOSSIER = path.join(REPO_ROOT, "docs", "research", "foray-research-dossier.md");
const REPORT_DIR = path.join(REPO_ROOT, "docs", "research", "corpus");

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { args[key] = next; i++; }
      else args[key] = true;
    } else args._.push(a);
  }
  return args;
}

function selectSources(db, args) {
  if (args.source !== undefined) {
    const id = Number(args.source);
    if (!Number.isInteger(id) || id <= 0) throw new Error(`--source must be a positive id, got ${args.source}`);
    const row = db.prepare("SELECT * FROM sources WHERE id = ?").get(id);
    if (!row) throw new Error(`no source with id ${id} — run load-manifest first?`);
    return [row];
  }
  if (args.area) {
    const area = Number(args.area);
    if (!Number.isInteger(area) || area < 1 || area > 9) throw new Error(`--area must be 1–9, got ${args.area}`);
    return db.prepare("SELECT * FROM sources WHERE area = ? ORDER BY id").all(area);
  }
  if (args.all) return db.prepare("SELECT * FROM sources ORDER BY area, id").all();
  throw new Error("ingest needs --all, --area N, or --source ID");
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (cmd) {
    case "init": {
      const db = openMigrated();
      const v = db.prepare("PRAGMA user_version").get().user_version;
      console.log(`corpus db ready (schema v${v})`);
      break;
    }

    case "load-manifest": {
      const db = openMigrated();
      const dossier = args.dossier ?? DEFAULT_DOSSIER;
      const entries = parseDossierFile(dossier);
      const n = loadManifest(db, entries);
      const readFirst = entries.filter((e) => e.read_first).length;
      console.log(`loaded ${n} sources (${readFirst} read-first) from ${path.relative(REPO_ROOT, dossier)}`);
      break;
    }

    case "ingest":
    case "refetch": {
      const db = openMigrated();
      const force = cmd === "refetch" || Boolean(args.force);
      const sources = cmd === "refetch"
        ? selectSources(db, { source: args.source ?? args._[0] })
        : selectSources(db, args);
      const fetcher = createFetcher({ hostGate: createHostGate() });
      console.log(`ingesting ${sources.length} source(s)${force ? " (force)" : ""}…`);
      const results = await ingestMany(db, fetcher, sources, {
        force,
        onResult: (s, r) => {
          const tail = r.outcome === "ok" ? `${r.chunks} chunks` : r.notes.slice(-1)[0] ?? "";
          console.log(`  [${String(s.id).padStart(3)}] ${r.outcome.padEnd(17)} ${s.title.slice(0, 60)} ${tail ? `— ${tail}` : ""}`);
        },
      });
      const by = (o) => results.filter((r) => r.outcome === o).length;
      console.log(`done: ${by("ok")} ok, ${by("unchanged")} unchanged, ${by("failed") + by("extraction-failed")} failed`);
      break;
    }

    case "search": {
      const db = openMigrated();
      const query = args._[0];
      if (!query) throw new Error(`usage: corpus search "query" [--limit N]`);
      const limit = Number(args.limit ?? 8);
      const rows = db.prepare(`
        SELECT s.id AS source_id, s.title, s.area, c.heading_path,
               snippet(chunks_fts, 0, '»', '«', ' … ', 18) AS snip,
               bm25(chunks_fts) AS score
        FROM chunks_fts
        JOIN chunks c ON c.id = chunks_fts.rowid
        JOIN documents d ON d.id = c.document_id
        JOIN sources s ON s.id = d.source_id
        WHERE chunks_fts MATCH ?
        ORDER BY score LIMIT ?
      `).all(query, limit);
      if (!rows.length) { console.log("no matches"); break; }
      for (const r of rows) {
        console.log(`\n[${r.source_id}] ${r.title} (area ${r.area})${r.heading_path ? ` — ${r.heading_path}` : ""}`);
        console.log(`  ${r.snip.replace(/\s+/g, " ")}`);
      }
      break;
    }

    case "stats": {
      const db = openMigrated();
      const { rows, areas } = coverageData(db);
      if (!rows.length) { console.log("no sources — run load-manifest"); break; }
      console.log("area  name                          src   ok  fail  unfet  chunks   ~tokens");
      for (const a of areas) {
        console.log(
          `${String(a.area).padStart(4)}  ${a.name.padEnd(28).slice(0, 28)} ${String(a.total).padStart(4)} ${String(a.ok).padStart(4)} ${String(a.failed).padStart(5)} ${String(a.unfetched).padStart(6)} ${String(a.chunks).padStart(7)} ${String(Math.round(a.tokens / 1000) + "k").padStart(9)}`
        );
      }
      const ok = rows.filter((r) => r.http_status >= 200 && r.http_status < 300 && r.chunk_count > 0).length;
      console.log(`\ntotal: ${ok}/${rows.length} ingested`);
      break;
    }

    case "report": {
      const db = openMigrated();
      const coverage = coverageMarkdown(db);
      const dead = deadLinksMarkdown(db);
      if (args.write) {
        fs.mkdirSync(REPORT_DIR, { recursive: true });
        fs.writeFileSync(path.join(REPORT_DIR, "coverage.md"), coverage + "\n", "utf8");
        fs.writeFileSync(path.join(REPORT_DIR, "dead-links.md"), dead + "\n", "utf8");
        console.log(`wrote docs/research/corpus/coverage.md and dead-links.md`);
      } else {
        console.log(coverage + "\n\n" + dead);
      }
      break;
    }

    default:
      console.error(
        `usage: corpus <init|load-manifest|ingest|search|stats|refetch|report>\n` +
        `  init                                create/migrate the db\n` +
        `  load-manifest [--dossier p]         parse the dossier into sources\n` +
        `  ingest --all|--area N|--source ID   fetch + extract + chunk\n` +
        `  search "query" [--limit N]          FTS5 keyword search\n` +
        `  stats                               per-area coverage\n` +
        `  refetch <source_id>                 force re-ingest one source\n` +
        `  report [--write]                    coverage + dead-links markdown`
      );
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((err) => {
  console.error(`corpus: ${err.message}`);
  process.exitCode = 1;
});
