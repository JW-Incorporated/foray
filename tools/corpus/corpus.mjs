#!/usr/bin/env node
/* corpus — the research-corpus CLI (humans and agents).
 *
 *   node tools/corpus/corpus.mjs init
 *   node tools/corpus/corpus.mjs load-manifest [--dossier <path>]
 *   node tools/corpus/corpus.mjs repoint-url <source_id> <new_url>
 *   node tools/corpus/corpus.mjs ingest (--all | --area N | --source ID) [--force]
 *   node tools/corpus/corpus.mjs ingest-captured --source ID --file <path> [--tool "..."]
 *   node tools/corpus/corpus.mjs search "query" [--mode keyword|vector|hybrid] [--limit N] [--raw] [--explain]
 *   node tools/corpus/corpus.mjs rechunk [--tokenizer] [--drop-embeddings]
 *   node tools/corpus/corpus.mjs token-histogram
 *   node tools/corpus/corpus.mjs embed [--force] [--batch N] [--offline]
 *   node tools/corpus/corpus.mjs eval [--mode M | --all-modes] [--gold <path>] [--json]
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
import { parseDossierFile, loadManifest, repointSourceUrl } from "./manifest.mjs";
import { createFetcher } from "./fetcher.mjs";
import { createHostGate } from "./hostgate.mjs";
import { ingestMany, rechunkAll, ingestCapturedText } from "./ingest.mjs";
import { coverageMarkdown, deadLinksMarkdown, coverageData } from "./report.mjs";
import { parseDigests, buildIndex, serializeIndex, diffIndexAgainstDigests, checkVerbatimOverlap } from "./export-index.mjs";
import { CORPUS_ROOT } from "./paths.mjs";
import { search, MODES, DEFAULT_SEARCH_MODE } from "./search.mjs";
import { runEval, runModes, formatEval, formatComparison } from "./eval.mjs";
import { createEmbedder, EmbeddingRuntimeUnavailable, EMBED_CHUNK_MAX, EMBED_CHUNK_MIN } from "./embedder.mjs";
import { backfill, DEFAULT_BATCH } from "./backfill.mjs";
import { currentChunks, embeddingInput } from "./embeddings.mjs";
import { tokenHistogram, heuristicDrift, formatHistogram } from "./tokenstats.mjs";
import { estTokens } from "./chunk.mjs";

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

/* Build an embedder, or return null when the runtime simply is not installed.
 * NULL IS A NORMAL ANSWER HERE. `tools/corpus/embed/` is a deliberate ~250MB
 * opt-in, so "no runtime" is the expected state on most checkouts and must
 * never become a stack trace in front of someone who only wanted keyword
 * search. Anything OTHER than a missing runtime — a corrupt model file, a
 * disk error — still throws, because those are real failures. */
async function maybeEmbedder({ offline = false } = {}) {
  try {
    return await createEmbedder(offline ? { allowRemote: false } : {});
  } catch (err) {
    if (err instanceof EmbeddingRuntimeUnavailable) return null;
    throw err;
  }
}

/* The same builder, but for commands whose entire job IS embedding — there,
 * a missing runtime is a hard error with install instructions, not a
 * downgrade to something that silently does nothing. */
async function requireEmbedder(opts) {
  const e = await maybeEmbedder(opts);
  if (!e) throw new EmbeddingRuntimeUnavailable();
  return e;
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
    /* Only the bootstrap commands (init, load-manifest) may CREATE the db;
     * every other command opens with the default create: false and gets a loud
     * "no corpus database here" error on a checkout that never built one —
     * instead of a silently created empty db answering "zero results". */
    case "init": {
      const db = openMigrated(undefined, { create: true });
      const v = db.prepare("PRAGMA user_version").get().user_version;
      console.log(`corpus db ready (schema v${v})`);
      break;
    }

    case "load-manifest": {
      const db = openMigrated(undefined, { create: true });
      const dossier = args.dossier ?? DEFAULT_DOSSIER;
      const entries = parseDossierFile(dossier);
      const n = loadManifest(db, entries);
      const readFirst = entries.filter((e) => e.read_first).length;
      console.log(`loaded ${n} sources (${readFirst} read-first) from ${path.relative(REPO_ROOT, dossier)}`);
      break;
    }

    /* A moved source: edit the dossier's URL, then repoint-url BEFORE
     * load-manifest — load-manifest's upsert keys off url, so on its own it
     * cannot see "this is source N under a new URL" and would fork a
     * duplicate row instead (see manifest.mjs's repointSourceUrl docblock).
     * Usual next steps after this: `load-manifest` (syncs title/notes),
     * then `refetch <id>` (actually fetches the new URL). */
    case "repoint-url": {
      const db = openMigrated();
      const id = numFlag(args._[0], "<source_id>");
      const newUrl = args._[1];
      if (!newUrl) throw new Error(`usage: corpus repoint-url <source_id> <new_url>`);
      const r = repointSourceUrl(db, id, newUrl);
      console.log(`[${r.id}] url repointed:\n  ${r.oldUrl}\n  -> ${r.newUrl}\nNow run: load-manifest, then refetch ${r.id}`);
      break;
    }

    case "ingest":
    case "refetch": {
      // Both need sources rows that only load-manifest writes, so neither may
      // create the db: a bare `ingest --all` on a fresh checkout should get
      // the "no corpus database" error, not a silently created empty db.
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

    /* For JS-rendered pages where fetcher.mjs only ever gets a content-free
     * shell (see ingest.mjs's ingestCapturedText docblock): ingest a text file
     * captured by rendering the page in a real browser and reading its
     * visible text — never a hand-authored stand-in. See
     * tools/corpus/README.md#rendered-html-route for the full procedure. */
    case "ingest-captured": {
      const db = openMigrated();
      const id = numFlag(args.source ?? args._[0], "--source");
      const filePath = args.file ?? args._[1];
      if (!filePath) {
        throw new Error(`usage: corpus ingest-captured --source ID --file <path> [--tool "..."]`);
      }
      const row = db.prepare("SELECT * FROM sources WHERE id = ?").get(id);
      if (!row) throw new Error(`no source with id ${id} — run load-manifest first?`);
      const text = fs.readFileSync(filePath, "utf8");
      const result = ingestCapturedText(db, row, text, args.tool ? { tool: args.tool } : {});
      console.log(
        `[${String(row.id).padStart(3)}] ${result.outcome.padEnd(17)} ${row.title.slice(0, 60)}` +
        (result.chunks ? ` — ${result.chunks} chunks` : "")
      );
      break;
    }

    case "search": {
      const db = openMigrated();
      const query = args._[0];
      if (!query) throw new Error(`usage: corpus search "query" [--mode ${MODES.join("|")}] [--limit N] [--raw] [--explain]`);
      const limit = args.limit === undefined ? 8 : numFlag(args.limit, "--limit", { min: 1, max: 100 });
      const mode = args.mode === undefined ? DEFAULT_SEARCH_MODE : String(args.mode);
      if (!MODES.includes(mode)) throw new Error(`--mode must be one of ${MODES.join(", ")} (got ${JSON.stringify(mode)})`);

      /* The runtime is only loaded when a mode actually needs it, so plain
       * keyword search stays instant and works with embed/ absent. */
      const embedder = mode === "keyword" ? null : await maybeEmbedder();
      const res = await search(db, query, {
        mode, limit,
        raw: Boolean(args.raw),
        bigrams: args.bigrams !== "off",
        /* search() has already applied the registry's query prefix, so this
         * encodes the string verbatim. Adding a prefix here too would double
         * it — silently, and only for queries. */
        embedQuery: embedder ? async (prefixed) => (await embedder.encode([prefixed]))[0] : null,
      });
      if (res.notice) console.log(`note: ${res.notice}`);
      if (args.explain) console.log(`mode: ${res.mode}   match: ${res.match ?? "(vector-only — no FTS expression)"}`);
      if (res.mode === "keyword" && res.match === null) { console.log("nothing to search for — the query has no indexable words"); break; }
      if (!res.rows.length) { console.log("no matches"); break; }
      for (const r of res.rows) {
        console.log(`\n[${r.source_id}] ${r.title} (area ${r.area})${r.heading_path ? ` — ${r.heading_path}` : ""}`);
        console.log(`  ${r.snip.replace(/\s+/g, " ")}`);
      }
      break;
    }

    /* Measure before deciding. bge truncates at 512 real tokens SILENTLY —
     * the tail of an over-long chunk is simply absent from its vector while
     * search keeps displaying the whole thing — so the chars/4 packing
     * heuristic has to be checked against the model's own tokenizer before
     * anything is embedded, not assumed to be close enough. */
    case "token-histogram": {
      const db = openMigrated();
      const embedder = await requireEmbedder({ offline: Boolean(args.offline) });
      const chunks = currentChunks(db);
      if (!chunks.length) { console.log("no chunks — run ingest first"); break; }
      const inputs = chunks.map((c) => embeddingInput(c, embedder.model.passage_prefix));
      const real = inputs.map((t) => embedder.countTokens(t));
      /* Both sides must measure THE SAME STRING. Comparing real tokens of the
       * encoder input (title + heading path + text) against chars/4 of the
       * text alone charged the heuristic for the header it never saw, and
       * overstated its error by roughly 75% (1.07x vs the true 1.04x). */
      const h = tokenHistogram(real, { maxTokens: embedder.model.maxTokens });
      console.log(formatHistogram(h, heuristicDrift(real, inputs.map(estTokens))));
      break;
    }

    case "embed": {
      const db = openMigrated();
      const embedder = await requireEmbedder({ offline: Boolean(args.offline) });
      const batch = args.batch === undefined ? DEFAULT_BATCH : numFlag(args.batch, "--batch", { min: 1, max: 256 });
      let last = 0;
      const r = await backfill(db, embedder, {
        force: Boolean(args.force),
        batch,
        onProgress: ({ done, total }) => {
          if (done - last < 50 && done !== total) return;
          last = done;
          console.log(`  ${done}/${total} chunks embedded`);
        },
      });
      console.log(
        `model ${r.model.name}@${r.model.revision} (${r.model.quantization}, ${r.model.dim}d, id ${r.model.id})\n` +
        `embedded ${r.embedded}, already had vectors ${r.skipped}\n` +
        `coverage: ${r.coverage.embedded}/${r.coverage.chunks} chunks`
      );
      if (r.truncated) {
        console.log(
          `WARNING: ${r.truncated} chunk(s) exceed the model's ${embedder.model.maxTokens}-token limit and were TRUNCATED —\n` +
          `         their tails are not in their vectors. Run \`corpus token-histogram\`, then\n` +
          `         \`corpus rechunk --tokenizer --drop-embeddings\` and embed again.`
        );
      }
      break;
    }

    case "rechunk": {
      const db = openMigrated();
      /* --tokenizer re-chunks for an EMBEDDING model rather than for FTS5:
       * the model's real tokenizer as the length unit, and a ceiling well
       * under its truncation limit once the title/heading header is added. */
      let chunkOptions;
      if (args.tokenizer) {
        const embedder = await requireEmbedder({ offline: Boolean(args.offline) });
        chunkOptions = {
          countTokens: (s) => embedder.countTokens(s),
          maxTokens: args["max-tokens"] === undefined ? EMBED_CHUNK_MAX : numFlag(args["max-tokens"], "--max-tokens", { min: 32, max: 4096 }),
          minTokens: args["min-tokens"] === undefined ? EMBED_CHUNK_MIN : numFlag(args["min-tokens"], "--min-tokens", { min: 8, max: 2048 }),
        };
        console.log(`re-chunking with ${embedder.model.name}'s tokenizer: ${chunkOptions.minTokens}–${chunkOptions.maxTokens} real tokens per chunk`);
      }
      const r = rechunkAll(db, { dropEmbeddings: Boolean(args["drop-embeddings"]), chunkOptions });
      console.log(`rechunked ${r.documents} documents from archived markdown: ${r.before} → ${r.after} chunks`);
      if (r.droppedEmbeddings) console.log(`  ${r.droppedEmbeddings} vector(s) cascade-deleted — re-run \`corpus embed\``);
      if (r.missing.length) console.log(`  ${r.missing.length} markdown file(s) missing: ${r.missing.join(", ")}`);
      if (r.emptied.length) {
        console.log(`  ${r.emptied.length} document(s) SKIPPED — archive yielded no chunks, existing rows kept:`);
        for (const e of r.emptied) console.log(`    ${e}`);
        console.log(`  (refetch these; an empty archive usually means a truncated write)`);
      }
      break;
    }

    case "eval": {
      const db = openMigrated();
      const goldPath = args.gold ?? DEFAULT_GOLD;
      const gold = JSON.parse(fs.readFileSync(goldPath, "utf8"));
      const modes = args["all-modes"] ? MODES : [args.mode ? String(args.mode) : DEFAULT_SEARCH_MODE];
      for (const m of modes) {
        if (!MODES.includes(m)) throw new Error(`--mode must be one of ${MODES.join(", ")} (got ${JSON.stringify(m)})`);
      }
      const embedder = modes.every((m) => m === "keyword") ? null : await maybeEmbedder();
      const opts = {
        limit: args.limit === undefined ? 8 : numFlag(args.limit, "--limit", { min: 1, max: 100 }),
        bigrams: args.bigrams !== "off",
        raw: Boolean(args.raw),
        embedQuery: embedder ? async (prefixed) => (await embedder.encode([prefixed]))[0] : null,
      };
      const results = await runModes(db, gold, { ...opts, modes });
      /* One mode: the detailed per-query report. Several: the side-by-side
       * comparison plus the gates, because the only reason to run more than
       * one mode is to decide between them. */
      console.log(results.length === 1 ? formatEval(results[0]) : formatComparison(results));
      if (args.json) console.log("\n" + JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
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
        `usage: corpus <init|load-manifest|ingest|search|rechunk|embed|eval|stats|refetch|report|export-index>\n` +
        `  init                                create/migrate the db\n` +
        `  load-manifest [--dossier p]         parse the dossier into sources\n` +
        `  repoint-url ID new-url               move a source's url in place (id-stable)\n` +
        `  ingest --all|--area N|--source ID   fetch + extract + chunk\n` +
        `  ingest-captured --source ID --file p  ingest a browser-rendered text capture\n` +
        `        [--tool "..."]                capture tool name, recorded in fetch_notes\n` +
        `  search "query" [--limit N]          search the corpus\n` +
        `        [--mode ${MODES.join("|")}]  keyword (default), vectors, or RRF fusion\n` +
        `        [--raw]                       pass literal FTS5 syntax through\n` +
        `        [--explain]                   print the mode + MATCH expression used\n` +
        `  rechunk [--tokenizer]               re-chunk from archived markdown (offline)\n` +
        `        [--drop-embeddings]           allow the cascade to delete existing vectors\n` +
        `  token-histogram                     real token lengths under the model's tokenizer\n` +
        `  embed [--force] [--batch N]         backfill chunk vectors (needs embed/ installed)\n` +
        `  eval [--mode M | --all-modes]       score the gold set (retrieval quality)\n` +
        `       [--gold f] [--json]            --all-modes prints the side-by-side + gates\n` +
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
