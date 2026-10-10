/**
 * THE ONE CATALOGUE READER FOR api/ (code-health-2 CH2-24: B1-02, A1-02).
 *
 * Three endpoints resolve a show id against `data/catalog.json` +
 * `data/catalog-breadth.json`: the show page's episode list
 * (`api/shows/[show_id]/episodes.ts`), its search box
 * (`api/episodes/search.ts?show=`) and the show record / show search
 * (`api/shows/search.ts`); the Apple episode fallback maps Apple ids through
 * the same pair (`showIdMap.ts`). Each used to parse the pair itself, with
 * two different admission rules and three different answers for a missing
 * file. They all read it here now, and this reads it through
 * `backend/src/catalog/breadthCatalog.ts`'s `loadCatalogue()`: one parse per
 * warm instance, one repo-root rule, one admission rule.
 *
 * ADMISSION is breadthCatalog's: a curated row with a show_id and a title;
 * a breadth row with an Apple id and a title that is not `in_curated`.
 *
 * AN ALIAS, NOT A SECOND SHOW. An `in_curated` breadth row is not admitted
 * (its curated twin is), but its numeric id is the twin's Apple id, and
 * `showById` answers it with the TWIN: the show_id in the answer is the
 * twin's slug and the feed is the twin's. Before this, the two episode
 * endpoints served those 175 ids from the dropped row's own feed while
 * `/api/shows/search?id=` said `show: null`. Every id that resolved before
 * still resolves.
 *
 * A SHOW WITH NO FEED is a show (`showById` answers it: its page can say
 * what it is) but has no `ShowMeta`: nothing can list or search its
 * episodes. `searchableShows()` leaves it out, and api/shows/search.ts's
 * directory pass drops Apple's row for it, so the SERVER's show search no
 * longer offers a result whose episode list is a 404 (B1-02, 89 rows on
 * 2026-10-07). The listener can still meet 37 of them: the client paints
 * its local index (data/show-index.tsv) first, and its builder,
 * tools/build-show-index.mjs, does not apply this feed_url rule yet (a
 * follow-up outside this card). The alternative, keeping them with an
 * honest "no feed" state, is founder question 5 of
 * docs/roadmap/code-health-2.md; filtering is its default.
 *
 * BUNDLING: the two files reach a deployed function only because
 * vercel.json's `includeFiles` for the api functions glob names them; the
 * BUNDLING NOTE in backend/src/catalog/breadthCatalog.ts says which glob and
 * which test pins it.
 *
 * FILES UNAVAILABLE. Either file missing, unreadable or not JSON is one
 * signal, `CatalogFilesUnavailableError`, thrown by every lookup here: the
 * pair is one artifact, and a deploy that lost half of it is broken, not
 * smaller. Each endpoint answers it once, the same way every time:
 *   - the episode list: 503 `{ error }`, no-store (a deploy gap, not an
 *     unknown show; the client's Try again is the right offer);
 *   - the show-scoped episode search and show search: 200 degraded with the
 *     error, no-store (their one shape on every path);
 *   - the Apple episode fallback: an empty id map, so every hit is dropped
 *     and the answer is honest about nothing it cannot link.
 * A failure is not remembered: the next request reads again.
 *
 * THE CORPUS CATALOGUE (docs/roadmap/corpus.md PKG-33). When
 * data/corpus-catalogue-pointer.json exists (PKG-32's publish-release.mjs
 * writes it; weekly.mjs proposes it in a PR), `ensureCorpusCatalogue()`
 * fetches the `catalogue_url` it names (catalog-breadth-corpus.json.gz:
 * data/catalog-breadth.json's row shape, catalog-adapter.mjs BREADTH_KEYS, a
 * superset of its rows) ONCE per warm instance, and its rows are served in
 * place of the committed breadth rows (breadthCatalog.ts
 * `setCorpusBreadthRows`; data/catalog.json is still read and its curated
 * rows still win). Every reader awaits it before its first lookup, so the
 * lookups below stay synchronous and all of them agree: api/shows/search.ts
 * (q and id), api/_lib/resolveShow.ts (the episode list and the show-scoped
 * search) and api/_lib/showIdMap.ts (the Apple fallback).
 *   - No pointer (ENOENT) is the path every deploy takes until the first
 *     pointer lands: the committed catalogue exactly, no fetch, no log line.
 *   - Any other failure (an unreadable or malformed pointer, a fetch that
 *     rejects, a non-2xx, CORPUS_FETCH_TIMEOUT_MS passing, a body over the
 *     cap, not gzip, not JSON, rows that fail the shape check) is ONE
 *     console.warn line and the committed catalogue for the life of the
 *     instance. It never throws, and it is never
 *     CatalogFilesUnavailableError: the committed pair is still there.
 * The pointer ships in the same vercel.json includeFiles brace list as the
 * pair.
 */

import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { promisify } from "util";
import {
  loadCatalogue,
  setCorpusBreadthRows,
  type BreadthShowRaw,
  type Catalogue,
  type CatalogueShowEntry,
} from "../../backend/src/catalog/breadthCatalog";

export type { CatalogueShowEntry };

/** What an endpoint needs to read a show's episodes. `showId` is the id the
 *  show is served under: the twin's slug when the caller asked by alias. */
export interface ShowMeta {
  showId: string;
  feedUrl: string;
  title: string | null;
  image: string | null;
}

export const CATALOG_FILES_UNAVAILABLE = "show metadata catalog files are unavailable";

export class CatalogFilesUnavailableError extends Error {
  constructor() {
    super(CATALOG_FILES_UNAVAILABLE);
    this.name = "CatalogFilesUnavailableError";
  }
}

interface Indexes {
  source: Catalogue;
  byId: Map<string, CatalogueShowEntry>;
  appleIds: Map<number, string>;
  searchable: CatalogueShowEntry[];
}

/* Built once beside loadCatalogue()'s own cache and rebuilt only when that
   cache hands back a different catalogue (a test root, or
   FORAY_SKIP_CATALOGUE_CACHE=1): keyed on identity, it cannot go stale. */
let indexes: Indexes | null = null;

function catalogue(): Indexes {
  let source: Catalogue;
  try {
    source = loadCatalogue();
  } catch {
    throw new CatalogFilesUnavailableError();
  }
  if (indexes?.source === source) return indexes;
  const appleIds = new Map<number, string>();
  for (const [appleId, showId] of source.showIdByAppleId) appleIds.set(Number(appleId), showId);
  indexes = {
    source,
    byId: new Map(source.entries.map((s) => [s.show_id, s])),
    appleIds,
    searchable: source.entries.filter((s) => s.feed_url !== null),
  };
  return indexes;
}

/** The merged-catalogue row for `id`, by its own id or by alias; null when
 *  the catalogue does not know it. */
export function showById(id: string): CatalogueShowEntry | null {
  const { byId, source } = catalogue();
  const own = byId.get(id);
  if (own) return own;
  const twin = source.showIdByAppleId.get(id);
  return twin === undefined ? null : byId.get(twin) ?? null;
}

/** What reading `id`'s episodes needs; null for an unknown id and for a show
 *  with no feed. */
export function showMetaById(id: string): ShowMeta | null {
  const show = showById(id);
  if (!show || !show.feed_url) return null;
  return { showId: show.show_id, feedUrl: show.feed_url, title: show.title, image: show.artwork_url };
}

/** Apple collection id -> the show_id its show page resolves (a curated
 *  show's slug, a breadth show's own number). */
export function appleIdToShowId(): ReadonlyMap<number, string> {
  return catalogue().appleIds;
}

/** Every row show search may offer: the catalogue minus the shows with no
 *  feed. Same array per catalogue. */
export function searchableShows(): CatalogueShowEntry[] {
  return catalogue().searchable;
}

/* ====================================================================== */
/* The corpus catalogue (PKG-33): see this file's header.                  */
/* ====================================================================== */

/** The brief's deadline, for the fetch AND the body read together. */
export const CORPUS_FETCH_TIMEOUT_MS = 2_000;
/* Caps, so a wrong upstream cannot exhaust the function. The committed
   breadth file is 12.5 MB for 26k rows; these leave room for a corpus
   several times larger. */
export const CORPUS_MAX_GZ_BYTES = 48 * 1024 * 1024;
export const CORPUS_MAX_JSON_BYTES = 192 * 1024 * 1024;

/* api/_lib sits two directories under the repo root, in the repo and in a
   deployed function alike. The path is a literal "data/..." string so
   api/_test/vercel-bundle.test.mjs sees this read and checks that
   vercel.json's includeFiles covers it. */
const DEFAULT_POINTER_PATH = path.join(path.resolve(__dirname, "..", ".."), "data/corpus-catalogue-pointer.json");

let pointerPath = DEFAULT_POINTER_PATH;
let fetchTimeoutMs = CORPUS_FETCH_TIMEOUT_MS;
/* "pending": not tried yet in this instance. A Promise: the one fetch in
   flight, which every caller shares. "settled": nothing left to wait for (no
   pointer, a failure already logged, or the corpus rows already served). */
let corpusLoad: "pending" | Promise<void> | "settled" = "pending";

const gunzip = promisify(zlib.gunzip);

class CorpusUnavailable extends Error {}

/**
 * Starts loading the corpus catalogue the pointer names, once per warm
 * instance; its rows are served from then on, and with no pointer or on any
 * failure the committed catalogue stays. Returns the load to await while one
 * is in flight, and null when there is nothing to wait for, so a caller
 * writes `const corpus = ensureCorpusCatalogue(); if (corpus) await corpus;`
 * and the no-pointer path stays synchronous, exactly as before PKG-33 (an
 * `await null` would still yield). The promise never rejects. A failure is
 * logged once and not retried until the instance is replaced.
 */
export function ensureCorpusCatalogue(): Promise<void> | null {
  if (corpusLoad === "pending") corpusLoad = startCorpusLoad();
  return corpusLoad === "settled" ? null : corpusLoad;
}

function startCorpusLoad(): Promise<void> | "settled" {
  let raw: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the one pointer path (a test seam may move it), not external input.
    raw = fs.readFileSync(pointerPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "settled"; // no pointer yet: the committed catalogue, silently
    warn(`pointer unreadable: ${(err as Error).message}`);
    return "settled";
  }
  let url: string;
  try {
    url = catalogueUrl(raw);
  } catch (err) {
    warn((err as Error).message);
    return "settled";
  }
  /* `corpusLoad === load`: a test reset while this was in flight makes it a
     stale attempt, which must not serve its rows or settle the new one. */
  const load: Promise<void> = fetchCorpusRows(url)
    .then(
      (rows) => {
        if (corpusLoad === load) setCorpusBreadthRows(rows);
      },
      (err: Error) => warn(err.message)
    )
    .finally(() => {
      if (corpusLoad === load) corpusLoad = "settled";
    });
  return load;
}

function warn(reason: string): void {
  console.warn(`[showCatalog] corpus catalogue not used, serving the committed catalogue: ${reason}`);
}

const HTTPS_RE = /^https:\/\//i;

/** The pointer's `catalogue_url` (PKG-32's shape: version 1, an https URL). */
function catalogueUrl(raw: string): string {
  let pointer: unknown;
  try {
    pointer = JSON.parse(raw);
  } catch {
    throw new CorpusUnavailable("pointer is not JSON");
  }
  const p = pointer as { version?: unknown; catalogue_url?: unknown } | null;
  if (!p || typeof p !== "object") throw new CorpusUnavailable("pointer is not an object");
  if (p.version !== 1) throw new CorpusUnavailable(`pointer version ${String(p.version)} is not 1`);
  if (typeof p.catalogue_url !== "string" || !HTTPS_RE.test(p.catalogue_url)) {
    throw new CorpusUnavailable("pointer has no https catalogue_url");
  }
  return p.catalogue_url;
}

/** Fetches, gunzips, parses and shape-checks the catalogue asset. The fetch
 *  and the body read share one deadline. */
async function fetchCorpusRows(url: string): Promise<BreadthShowRaw[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
  let body: Buffer;
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new CorpusUnavailable(`${url} answered ${res.status}`);
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > CORPUS_MAX_GZ_BYTES) {
      throw new CorpusUnavailable(`${url} is ${declared} bytes, over the ${CORPUS_MAX_GZ_BYTES}-byte cap`);
    }
    body = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (err instanceof CorpusUnavailable) throw err;
    throw new CorpusUnavailable(
      controller.signal.aborted
        ? `${url} timed out after ${fetchTimeoutMs} ms`
        : `${url} fetch failed: ${(err as Error).message}`
    );
  } finally {
    clearTimeout(timer);
  }
  if (body.length > CORPUS_MAX_GZ_BYTES) throw new CorpusUnavailable(`${url} exceeds the ${CORPUS_MAX_GZ_BYTES}-byte cap`);

  let parsed: unknown;
  try {
    parsed = JSON.parse((await gunzip(body, { maxOutputLength: CORPUS_MAX_JSON_BYTES })).toString("utf8"));
  } catch (err) {
    throw new CorpusUnavailable(`${url} is not gzipped JSON: ${(err as Error).message}`);
  }
  return corpusRowsOf(parsed);
}

/** The light shape check: a non-empty array of rows (bare, or the `shows`
 *  of the data/catalog-breadth.json envelope catalog-adapter.mjs writes),
 *  each with a numeric apple_collection_id and a non-empty title. One bad
 *  row refuses the whole asset: a half-right corpus is not a catalogue. */
function corpusRowsOf(parsed: unknown): BreadthShowRaw[] {
  const rows = Array.isArray(parsed) ? parsed : (parsed as { shows?: unknown } | null)?.shows;
  if (!Array.isArray(rows)) throw new CorpusUnavailable("catalogue has no array of rows");
  if (rows.length === 0) throw new CorpusUnavailable("catalogue has no rows");
  rows.forEach((row: unknown, i: number) => {
    const r = row as { apple_collection_id?: unknown; title?: unknown } | null;
    if (!r || typeof r !== "object") throw new CorpusUnavailable(`catalogue row ${i} is not an object`);
    if (typeof r.apple_collection_id !== "number" || !Number.isFinite(r.apple_collection_id)) {
      throw new CorpusUnavailable(`catalogue row ${i} has no numeric apple_collection_id`);
    }
    if (typeof r.title !== "string" || r.title === "") throw new CorpusUnavailable(`catalogue row ${i} has no title`);
  });
  return rows as BreadthShowRaw[];
}

/** Test-only: forget the corpus attempt and serve the committed catalogue
 *  again; `pointerPath` / `timeoutMs` move the pointer and the deadline (no
 *  argument restores both). */
export function _resetCorpusCatalogueForTests(opts: { pointerPath?: string; timeoutMs?: number } = {}): void {
  corpusLoad = "pending";
  pointerPath = opts.pointerPath ?? DEFAULT_POINTER_PATH;
  fetchTimeoutMs = opts.timeoutMs ?? CORPUS_FETCH_TIMEOUT_MS;
  setCorpusBreadthRows(null);
}
