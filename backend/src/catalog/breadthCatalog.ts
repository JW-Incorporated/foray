import * as fs from "fs";
import * as path from "path";

/**
 * Full-breadth show catalogue loader (A3.1/Q3, kanban t_8d1a6a58,
 * docs/curation/CATALOG-PIPELINE.md's two-tier architecture).
 *
 * `data/catalog.json` (curated, ~220 shows, editorial notes + taxonomy) and
 * `data/catalog-breadth.json` (~10k shows, genre/chart-rank only, per
 * CATALOG-PIPELINE.md "deliberately never shipped to the client") are both
 * read here, server-side only, and merged into one flat, searchable index —
 * the client never fetches catalog-breadth.json directly (CATALOG-PIPELINE.md
 * §5's "client isolation" rule still holds; only this backend module reads
 * it, and only a thin per-query result crosses to the client).
 *
 * Identity: curated shows keep their existing `show_id`. Breadth shows have
 * no `show_id` field (`apple_collection_id` is their primary key per
 * CATALOG-PIPELINE.md §"Forward-compatibility requirements") — this mints
 * `String(apple_collection_id)` as the id. Every api/ reader resolves a show
 * id through this one index (api/_lib/showCatalog.ts), so an id found here is
 * an id the episode endpoints answer.
 *
 * Dedupe: a breadth entry marked `in_curated: true` is dropped from the
 * merged index — the curated record for the same show already carries a
 * richer editorial note/taxonomy and is present under its own show_id, so
 * keeping both would surface the same show twice in one search result list.
 * Its numeric id still resolves: `Catalogue.showIdByAppleId` aliases it to
 * the curated twin.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

// THE ONE REPO-ROOT RULE for the catalogue pair: this file sits three
// directories under the root (backend/src/catalog), in the repo and in a
// deployed Vercel function alike - the function keeps the repo's directory
// layout. Every api/ reader reaches the pair through here, via
// api/_lib/showCatalog.ts; `_setCatalogRootForTests` is the one seam that
// points it elsewhere.
//
// BUNDLING NOTE (kanban t_7d1a82d2): readJson() below reads
// data/catalog.json and data/catalog-breadth.json through a runtime
// path.join(), which Vercel's file tracing does not follow. They ship in
// every deployed function because vercel.json's
// `functions["api/**/*.ts"].includeFiles` names them; a handler anywhere
// under api/ is covered by that one glob, so moving a handler needs no
// vercel.json edit. Renaming either file does: api/_test/vercel-bundle.test.mjs
// finds every `data/` literal in each handler's import closure and fails
// when the glob stops covering one.
let catalogRoot = REPO_ROOT;

export type CatalogueTier = "curated" | "breadth";

export interface CatalogueShowEntry {
  show_id: string;
  title: string;
  artwork_url: string | null;
  feed_url: string | null;
  tier: CatalogueTier;
  taxonomy_node_ids: string[];
  editorial_note: string | null;
  /* Apple's PER-GENRE top-chart position, 1-200, paired with `chart_genre_id`
     in the harvest (docs/search-plan.md §1.1 - present on all 19,787 breadth
     rows). A CURATED row carries its breadth twin's rank, joined on
     `apple_collection_id` (P-09 rule half, PKG-13 - the same join
     `tools/build-show-index.mjs` and `tools/build-catalog-client.mjs` make
     for the client files), and `null` when it has no ranked twin. The tier
     term still splits curated from breadth first; the rank only orders
     curated against curated.

     IT IS CARRIED BECAUSE THE RANKING RULE READS IT, on both sides of the
     wire. `searchBreadthShows`'s comparator bands it, and therefore decides
     which rows survive that endpoint's `limit` cut; `search-engine.js`'s
     `popularityBand` bands it again client-side after `mergeBreadth`. Before
     this field existed, a row from `api/shows/search` reached that function
     with `chart_rank` undefined and was banded UNRANKED - the WORST band - so
     it lost every tie to a row from `data/show-index.tsv`, which does carry
     it. That hurt precisely the rows only the endpoint can supply:
     `tools/build-show-index.mjs` cuts the client index at `chart_rank <= 100`,
     so a 101-200 show exists nowhere else. */
  chart_rank: number | null;
}

interface CuratedShowRaw {
  show_id: string;
  title: string;
  apple_collection_id?: number | string | null;
  artwork_url?: string | null;
  feed_url?: string | null;
  taxonomy_node_ids?: string[];
  editorial_note?: string | null;
}

export interface BreadthShowRaw {
  apple_collection_id: number;
  title: string;
  feed_url: string | null;
  artwork_url?: string | null;
  in_curated?: boolean;
  chart_rank?: number | null;
  /* Folded from data/breadth-classification.json by
     tools/refresh/fold-breadth-topics.mjs (catalogue-personalization PKG-08):
     `[]` for a low-confidence or needs_review show, absent on a row the fold
     never touched. */
  taxonomy_node_ids?: string[];
}

/** The merged catalogue plus the one join a reader needs beside it. */
export interface Catalogue {
  entries: CatalogueShowEntry[];
  /* Apple collection id (as a string) -> show_id, for every admitted show: a
     curated show's Apple id gives its SLUG, a breadth show's gives itself.
     That makes it two things at once, on purpose (code-health-2 CH2-24,
     A1-02):
       - the Apple fallback's map (api/_lib/showIdMap.ts): an Apple hit links
         to the id the show page resolves;
       - the ALIAS of an `in_curated` breadth row. That row is dropped below,
         but its numeric id is also the curated twin's Apple id, so a reader
         that asks for the numeric id is answered the twin. Before this, two
         endpoints resolved those ids to the dropped row's own feed and
         `/api/shows/search?id=` said `show: null`. */
  showIdByAppleId: Map<string, string>;
}

let cached: Catalogue | null = null;

/* THE CORPUS CATALOGUE (docs/roadmap/corpus.md PKG-33). Rows of the corpus
   export's catalog-breadth-corpus.json (tools/foraycorpus-export/
   catalog-adapter.mjs: data/catalog-breadth.json's row shape, BREADTH_KEYS,
   and a superset of its rows), or null for the committed file. Set only by
   `setCorpusBreadthRows`, which api/_lib/showCatalog.ts calls once per
   process after fetching the asset its pointer names; null (never set) is
   the path every deploy without data/corpus-catalogue-pointer.json takes,
   and it is exactly the committed catalogue. */
let corpusRows: readonly BreadthShowRaw[] | null = null;

/**
 * Serve `rows` IN PLACE OF data/catalog-breadth.json's rows (which is then
 * not read at all), or, with null, the committed file again. data/catalog.json
 * is read either way and its curated rows win: the breadth loop's
 * `in_curated` skip and its "a curated show already claims this Apple id"
 * skip apply to corpus rows as to committed ones. Forgets the cached
 * catalogue, so the next loadCatalogue() builds a new object and
 * showCatalog.ts's identity-keyed index rebuilds beside it.
 */
export function setCorpusBreadthRows(rows: readonly BreadthShowRaw[] | null): void {
  corpusRows = rows;
  cached = null;
}

/**
 * Reads catalog.json + catalog-breadth.json fresh from disk and returns the
 * merged, deduped index. Cached per-process (module scope) — both files are
 * static build artifacts, not something that changes within a running
 * server — mirrors `backend/src/generation/catalogueLookup.ts`'s cache
 * pattern. `FORAY_SKIP_CATALOGUE_CACHE=1` disables the cache for tests that
 * mutate fixture files on disk between reads.
 */
export function loadBreadthCatalog(): CatalogueShowEntry[] {
  return loadCatalogue().entries;
}

/**
 * loadBreadthCatalog() with its Apple-id join, from the same one read. Throws
 * when either file is missing, unreadable or not JSON: the pair is one
 * artifact, and half of it is not a smaller catalogue but a broken deploy.
 * A failure is not cached, so a read that failed once is tried again.
 */
export function loadCatalogue(): Catalogue {
  if (cached && process.env.FORAY_SKIP_CATALOGUE_CACHE !== "1") return cached;

  const curated = readJson<{ shows: CuratedShowRaw[] }>("data/catalog.json");
  const breadth: { shows?: readonly BreadthShowRaw[] } =
    corpusRows !== null ? { shows: corpusRows } : readJson<{ shows: BreadthShowRaw[] }>("data/catalog-breadth.json");

  const entries: CatalogueShowEntry[] = [];
  const seenIds = new Set<string>();
  const showIdByAppleId = new Map<string, string>();

  /* P-09 rule half (PKG-13): the curated rows' chart positions, from EVERY
     breadth row, `in_curated` or not - the curated shows' twins are exactly
     the `in_curated` rows the breadth loop below skips, so filtering here
     would join nothing. This is tools/harvest-merge.mjs's `rankByAppleId`
     (the one join both client builders read, CH2-15) restated, because this
     CommonJS build cannot import an ES-module repo tool; it is PINNED equal
     to it instead, over null, 0, "12", "NaN", -1 and a ranked row, by
     backend/test/breadthCatalog.test.ts (code-health-2 CH2-24, B1-14). */
  const rankByAppleId = new Map<string, number>();
  for (const row of breadth.shows ?? []) {
    const rank = normalizeChartRank(row?.chart_rank);
    if (rank !== null) rankByAppleId.set(String(row?.apple_collection_id), rank);
  }

  for (const show of curated.shows ?? []) {
    if (!show.show_id || !show.title) continue;
    if (seenIds.has(show.show_id)) continue;
    seenIds.add(show.show_id);
    const appleId = appleIdKey(show.apple_collection_id);
    if (appleId !== null && !showIdByAppleId.has(appleId)) showIdByAppleId.set(appleId, show.show_id);
    entries.push({
      show_id: show.show_id,
      title: show.title,
      artwork_url: show.artwork_url ?? null,
      feed_url: show.feed_url ?? null,
      tier: "curated",
      taxonomy_node_ids: show.taxonomy_node_ids ?? [],
      editorial_note: show.editorial_note ?? null,
      chart_rank: rankByAppleId.get(String(show.apple_collection_id)) ?? null, // the breadth twin's rank - see the field's note
    });
  }

  for (const show of breadth.shows ?? []) {
    if (show.in_curated) continue; // already present via the curated entry above
    if (show.apple_collection_id === undefined || show.apple_collection_id === null || !show.title) continue;
    const id = String(show.apple_collection_id);
    if (seenIds.has(id)) continue; // guards a breadth/curated id collision, belt-and-suspenders
    /* A curated show already claims this Apple id: this row is its twin even
       without `in_curated` (catalog-adapter.mjs sets that flag only for a
       corpus row that names its curated show), so it is an alias, never a
       second, numeric copy. No committed row reaches this line today (every
       curated twin in data/catalog-breadth.json is `in_curated`); a corpus
       row can (PKG-33). */
    if (showIdByAppleId.has(id)) continue;
    seenIds.add(id);
    showIdByAppleId.set(id, id);
    entries.push({
      show_id: id,
      title: show.title,
      artwork_url: show.artwork_url ?? null,
      feed_url: show.feed_url ?? null,
      tier: "breadth",
      /* Passed through, not zeroed (PKG-09): `api/shows/search?id=` answers a
         breadth show page with this row unprojected, so a `[]` here is what
         left breadth pages without chips or Similar shows (#560 item 4). */
      taxonomy_node_ids: show.taxonomy_node_ids ?? [],
      editorial_note: null,
      /* Absent, non-numeric or <= 0 becomes `null` rather than reaching a
         consumer as NaN or 0: `popularityBand` reads null as UNRANKED (the
         worst band), while 0 would read as the best one. */
      chart_rank: normalizeChartRank(show.chart_rank),
    });
  }

  cached = { entries, showIdByAppleId };
  return cached;
}

/** A curated row's Apple id as a join key, or null when it has none. */
function appleIdKey(raw: number | string | null | undefined): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  return String(raw);
}

/** Test-only: read the pair from `root` instead of the repo (no argument
 *  restores the repo root) and forget the cached catalogue. */
export function _setCatalogRootForTests(root?: string): void {
  catalogRoot = root ?? REPO_ROOT;
  cached = null;
}

function normalizeChartRank(raw: number | null | undefined): number | null {
  const rank = Number(raw);
  return Number.isFinite(rank) && rank > 0 ? rank : null;
}

function readJson<T>(relPath: string): T {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- relPath is one of two hardcoded catalogue filenames, not external input.
  const raw = fs.readFileSync(path.join(catalogRoot, relPath), "utf8");
  return JSON.parse(raw) as T;
}
