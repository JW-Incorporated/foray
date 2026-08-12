#!/usr/bin/env node
/* corpus — the research-corpus CLI (humans and agents).
 *
 *   node tools/corpus/corpus.mjs init
 *   node tools/corpus/corpus.mjs load-manifest [--dossier <path>]
 *   node tools/corpus/corpus.mjs ingest (--all | --area N | --source ID) [--force]
 *   node tools/corpus/corpus.mjs search "query" [--limit N] [--raw] [--explain]
 *   node tools/corpus/corpus.mjs rechunk
 *   node tools/corpus/corpus.mjs eval [--gold <path>] [--json]
 *   node tools/corpus/corpus.mjs stats
 *   node tools/corpus/corpus.mjs refetch <source_id>
 *   node tools/corpus/corpus.mjs report [--write]
 *   node tools/corpus/corpus.mjs export-index [--write]
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
import { ingestMany, rechunkAll } from "./ingest.mjs";
import { coverageMarkdown, deadLinksMarkdown, coverageData } from "./report.mjs";
import { parseDigests, buildIndex, serializeIndex, diffIndexAgainstDigests, checkVerbatimOverlap } from "./export-index.mjs";
import { CORPUS_ROOT } from "./paths.mjs";
import { keywordSearch } from "./search.mjs";
import { runEval, formatEval } from "./eval.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const DEFAULT_DOSSIER = path.join(REPO_ROOT, "docs", "research", "foray-research-dossier.md");
const REPORT_DIR = path.join(REPO_ROOT, "docs", "research", "corpus");
const DIGESTS_PATH = path.join(REPORT_DIR, "digests.md");
const INDEX_PATH = path.join(REPORT_DIR, "corpus-index.json");
const DEFAULT_GOLD = path.join(HERE, "eval", "gold-queries.json");

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

/* A flag given without a value parses as boolean true, and Number(true)
 * is 1 — so "--area" with the value forgotten must throw, not ingest area 1. */
function numFlag(value, name, { min = 1, max = Infinity } = {}) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`${name} needs a numeric value (got ${JSON.stringify(value)})`);
  }
  const n = Number(value);
  if (n < min || n > max) throw new Error(`${name} must be ${min}–${max === Infinity ? "…" : max}, got ${n}`);
  return n;
}

function selectSources(db, args) {
  if (args.source !== undefined) {
    const id = numFlag(args.source, "--source");
    const row = db.prepare("SELECT * FROM sources WHERE id = ?").get(id);
    if (!row) throw new Error(`no source with id ${id} — run load-manifest first?`);
    return [row];
  }
  if (args.area !== undefined) {
    const area = numFlag(args.area, "--area", { min: 1, max: 9 });
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
      if (!query) throw new Error(`usage: corpus search "query" [--limit N] [--raw] [--explain]`);
      const limit = args.limit === undefined ? 8 : numFlag(args.limit, "--limit", { min: 1, max: 100 });
      const { rows, match } = keywordSearch(db, query, {
        limit,
        raw: Boolean(args.raw),
        bigrams: args.bigrams !== "off",
      });
      if (args.explain) console.log(`match: ${match ?? "(nothing indexable in that query)"}`);
      if (match === null) { console.log("nothing to search for — the query has no indexable words"); break; }
      if (!rows.length) { console.log("no matches"); break; }
      for (const r of rows) {
        console.log(`\n[${r.source_id}] ${r.title} (area ${r.area})${r.heading_path ? ` — ${r.heading_path}` : ""}`);
        console.log(`  ${r.snip.replace(/\s+/g, " ")}`);
      }
      break;
    }

    case "rechunk": {
      const db = openMigrated();
      const r = rechunkAll(db);
      console.log(`rechunked ${r.documents} documents from archived markdown: ${r.before} → ${r.after} chunks`);
      if (r.missing.length) console.log(`  ${r.missing.length} markdown file(s) missing: ${r.missing.join(", ")}`);
      break;
    }

    case "eval": {
      const db = openMigrated();
      const goldPath = args.gold ?? DEFAULT_GOLD;
      const gold = JSON.parse(fs.readFileSync(goldPath, "utf8"));
      const result = runEval(db, gold, {
        mode: args.mode ?? "keyword",
        bigrams: args.bigrams !== "off",
        raw: Boolean(args.raw),
      });
      console.log(formatEval(result));
      if (args.json) console.log("\n" + JSON.stringify(result, null, 2));
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

    /* The corpus itself is local-only (data-local/ is gitignored). This is the
     * part of it that can be committed to a PUBLIC repo: source facts, hashes,
     * counts, our own digests, and the per-source redistribution verdict. It
     * never emits scraped text — see export-index.mjs and DECISIONS.md. */
    case "export-index": {
      const db = openMigrated();
      const digestsPath = args.digests ?? DIGESTS_PATH;
      const outPath = args.out ?? INDEX_PATH;
      const entries = parseDigests(fs.readFileSync(digestsPath, "utf8"));
      const index = buildIndex(db, entries);
      const problems = diffIndexAgainstDigests(index, entries);
      if (problems.length) throw new Error(`index/digests mismatch:\n  ${problems.join("\n  ")}`);

      /* On the machine that holds the archives, prove the digests are ours. */
      const archiveOf = new Map(index.sources.map((s) => [s.id, s.local_archive?.markdown ?? null]));
      const overlap = checkVerbatimOverlap(entries, (e) => {
        const rel = archiveOf.get(e.id);
        if (!rel) return null;
        const full = path.join(CORPUS_ROOT, rel);
        return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
      });
      if (overlap.problems.length) {
        throw new Error(`digests must be our own words:\n  ${overlap.problems.join("\n  ")}`);
      }
      const t = index.totals;
      if (args.write) {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, serializeIndex(index), "utf8");
        console.log(`wrote ${path.relative(REPO_ROOT, outPath)}`);
      } else {
        console.log(`(dry run — pass --write to update ${path.relative(REPO_ROOT, outPath)})`);
      }
      console.log(
        `${t.sources} sources · ${t.ingested} ingested · ${t.chunks} chunks · ~${Math.round(t.estimated_tokens / 1000)}k tokens\n` +
        `verbatim guard: ${overlap.checked} digest(s) checked against local archives, 0 shared runs\n` +
        `redistribution: ${t.redistribution_allowed} allow, ${t.redistribution_denied} deny (no source text is committed either way)`
      );
      break;
    }

    default:
      console.error(
        `usage: corpus <init|load-manifest|ingest|search|rechunk|eval|stats|refetch|report|export-index>\n` +
        `  init                                create/migrate the db\n` +
        `  load-manifest [--dossier p]         parse the dossier into sources\n` +
        `  ingest --all|--area N|--source ID   fetch + extract + chunk\n` +
        `  search "query" [--limit N]          FTS5 keyword search\n` +
        `        [--raw]                       pass literal FTS5 syntax through\n` +
        `        [--explain]                   print the MATCH expression built\n` +
        `  rechunk                             re-chunk from archived markdown (offline)\n` +
        `  eval [--gold f] [--json]            score the gold set (retrieval quality)\n` +
        `  stats                               per-area coverage\n` +
        `  refetch <source_id>                 force re-ingest one source\n` +
        `  report [--write]                    coverage + dead-links markdown\n` +
        `  export-index [--write]              docs/research/corpus/corpus-index.json`
      );
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((err) => {
  console.error(`corpus: ${err.message}`);
  process.exitCode = 1;
});
