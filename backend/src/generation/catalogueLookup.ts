import * as fs from "fs";
import * as path from "path";

/**
 * Loader + matcher over the four catalogue files §4.2 names as the
 * first (free, instant) research source: `data/discover.json` (1,855
 * items), `data/catalog.json` (220 shows), `data/semantic-index.json`
 * (concept -> terms/topics/related), `data/item-tags.json` (item id ->
 * tags). Everything here is read-only and pure; there is no write path.
 *
 * Path convention matches `backend/src/config/env.ts`'s REPO_ROOT_ENV:
 * three `..` from `backend/src/generation` reaches the repo root.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

export interface DiscoverItem {
  id: string;
  show: string;
  title: string;
  topics: string[];
  hook: string;
}

export interface CatalogueShow {
  show_id: string;
  title: string;
  taxonomy_node_ids: string[];
}

export interface SemanticConcept {
  terms: string[];
  topics: string[];
  related: string[];
}

export interface CatalogueData {
  items: DiscoverItem[];
  itemTags: Record<string, string[]>;
  concepts: Record<string, SemanticConcept>;
  shows: CatalogueShow[];
}

let cached: CatalogueData | null = null;

/**
 * Reads all four catalogue files fresh from disk. Cached per-process
 * (process.env.FORAY_SKIP_CATALOGUE_CACHE=1 disables the cache, for tests
 * that want to assert against a mutated fixture directory).
 */
export function loadCatalogueData(): CatalogueData {
  if (cached && process.env.FORAY_SKIP_CATALOGUE_CACHE !== "1") return cached;

  const discover = readJson<{ items: DiscoverItem[] }>("data/discover.json");
  const catalog = readJson<{ shows: CatalogueShow[] }>("data/catalog.json");
  const semanticIndex = readJson<{ concepts: Record<string, SemanticConcept> }>("data/semantic-index.json");
  const itemTags = readJson<{ tags: Record<string, string[]> }>("data/item-tags.json");

  const data: CatalogueData = {
    items: discover.items ?? [],
    itemTags: itemTags.tags ?? {},
    concepts: semanticIndex.concepts ?? {},
    shows: catalog.shows ?? []
  };
  cached = data;
  return data;
}

function readJson<T>(relPath: string): T {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- relPath is one of four hardcoded catalogue filenames, not external input.
  const raw = fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
  return JSON.parse(raw) as T;
}

/** Splits text into lowercase word tokens, dropping short/stopword-ish noise. */
function tokenize(text: string): string[] {
  const STOPWORDS = new Set([
    "the", "a", "an", "of", "and", "or", "to", "in", "on", "for", "with",
    "is", "are", "was", "were", "how", "what", "why", "who", "it", "its",
    "that", "this", "as", "at", "by", "be", "not"
  ]);
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/** Public wrapper for `tokenize`, used when a caller has no semantic-index
 * concept to fall back on (e.g. a subject with zero matched concepts) and
 * needs the same word-splitting rule `queryTapeAvailability` matches
 * against, so a literal-term candidate's tape query stays consistent with
 * a semantic-concept candidate's. */
export function tokenizeForCatalogueQuery(text: string): string[] {
  return tokenize(text);
}

/**
 * Finds semantic-index concepts whose terms overlap with the given text
 * (whole-token match, hyphens normalized to spaces on both sides so
 * "clean energy" matches the concept term "clean-energy"). Returns concept
 * keys, most-overlapping first.
 */
export function matchConceptsInText(text: string, concepts: Record<string, SemanticConcept>): string[] {
  const tokens = new Set(tokenize(text));
  const hyphenJoined = text.toLowerCase().replace(/\s+/g, "-");

  const scored: Array<{ key: string; score: number }> = [];
  for (const [key, concept] of Object.entries(concepts)) {
    let score = 0;
    for (const term of concept.terms) {
      const termNorm = term.toLowerCase();
      if (tokens.has(termNorm) || hyphenJoined.includes(termNorm)) score += 1;
    }
    if (score > 0) scored.push({ key, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.key);
}

/** A human-readable label from a semantic-index concept key, e.g. "clean-energy" -> "Clean Energy". */
export function conceptLabel(conceptKey: string): string {
  return conceptKey
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export interface TapeQueryResult {
  itemCount: number;
  showCount: number;
  exampleItemIds: string[];
}

/**
 * Counts how much of the local catalogue matches a set of query terms.
 * A term matches an item when it appears (substring, case-insensitive) in
 * the item's title, hook, topics, or its data/item-tags.json tag list —
 * substring rather than whole-word because catalogue terms are frequently
 * compound ("tokamak", "clean-energy") and a stricter match would miss the
 * exact concept-term hits this function exists to find.
 */
export function queryTapeAvailability(terms: string[], catalogue: CatalogueData): TapeQueryResult {
  const needles = terms.map((t) => t.toLowerCase()).filter((t) => t.length > 0);
  if (needles.length === 0) return { itemCount: 0, showCount: 0, exampleItemIds: [] };

  const matchedIds: string[] = [];
  const shows = new Set<string>();

  for (const item of catalogue.items) {
    const tags = catalogue.itemTags[item.id] ?? [];
    const haystack = [item.title, item.hook, ...(item.topics ?? []), ...tags].join(" ").toLowerCase();
    if (needles.some((n) => haystack.includes(n))) {
      matchedIds.push(item.id);
      shows.add(item.show);
    }
  }

  return {
    itemCount: matchedIds.length,
    showCount: shows.size,
    exampleItemIds: matchedIds.slice(0, 5)
  };
}
