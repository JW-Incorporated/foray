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

/** Function words that carry no topical signal. `tokenize`'s 27-word list is
 * tuned for short catalogue queries; a beat CLAIM is a full sentence, and on
 * 2026-09-09 (generation run 1) the tier-1 scorer matched a Kansas City
 * walkway claim to a British hearth-cooking segment on `have, one, people,
 * would` — four "shared tokens", zero shared meaning. Anything a claim about
 * any subject would contain belongs here. */
const SOURCING_STOPWORDS = new Set([
  "about", "above", "after", "again", "all", "also", "although", "always", "among", "any", "because", "been",
  "before", "being", "below", "between", "both", "but", "can", "cannot", "could", "did", "does", "doing",
  "done", "down", "during", "each", "either", "else", "even", "ever", "every", "few", "first", "found",
  "from", "further", "get", "got", "had", "has", "have", "having", "her", "here", "hers", "him", "his",
  "however", "into", "just", "last", "later", "least", "less", "like", "likely", "made", "make", "many",
  "may", "might", "more", "most", "much", "must", "near", "never", "new", "next", "nor", "now", "off",
  "often", "once", "one", "ones", "only", "other", "others", "our", "out", "over", "own", "part", "people",
  "per", "rather", "roughly", "same", "she", "should", "since", "some", "still", "such", "take", "taken",
  "than", "their", "them", "then", "there", "these", "they", "thing", "things", "those", "though", "three",
  "through", "thus", "time", "times", "too", "toward", "towards", "two", "under", "until", "upon", "use",
  "used", "very", "way", "well", "when", "where", "whether", "which", "while", "will", "within",
  "without", "would", "year", "years", "yet", "you", "your"
]);

/** The tokenizer the §4.5 SOURCING scorers use: `tokenize` minus function
 * words. Kept separate from `tokenizeForCatalogueQuery` so a catalogue query
 * typed by a person ("how to...") keeps its current behaviour. */
export function tokenizeForSourcing(text: string): string[] {
  return tokenize(text).filter((w) => !SOURCING_STOPWORDS.has(w));
}

/** The shortest a term may be to match as a STEM (a prefix of a query word, or
 * a query word that is a prefix of it). Below this, only an exact token match
 * counts. See `matchConceptsInText` for the two-letter term that made this
 * necessary. */
const MIN_STEM_TERM_LENGTH = 4;

/** Whether two taxonomy node ids are in the same family — the same node, or one
 * an ancestor of the other (`engineering` and `engineering/disasters`).
 *
 * NOT "same root segment", and the difference is the whole of F-11. Run 1's
 * Foray resolved to `engineering/disasters`; the `ai` concept's only topic is
 * `engineering/ai-robotics`. Those share a root, so a root-segment rule would
 * have KEPT the leak this function exists to stop — while dropping `bridges`
 * (architecture/infrastructure), `disasters` (aviation/accidents) and
 * `decision-making` (psychology/decision-making), which are the three most
 * on-topic concepts the run matched. A lineage rule gets that case right in
 * both directions. */
export function sharesTopicFamily(topicA: string, topicB: string): boolean {
  const a = topicA.trim().toLowerCase();
  const b = topicB.trim().toLowerCase();
  if (a.length === 0 || b.length === 0) return false;
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export interface ConceptMatchOptions {
  /**
   * The Foray's resolved taxonomy node (`engineering/disasters`). Optional: a
   * caller with no resolved topic — a catalogue query typed by a person, a
   * subject the taxonomy cannot place — gets the unfiltered behaviour, because
   * a filter keyed on a topic nobody resolved is a filter keyed on nothing.
   */
  topic?: string | null;
}

/**
 * Finds semantic-index concepts whose terms overlap with the given text.
 * Returns concept keys, most-overlapping first.
 *
 * THE BUG THIS FUNCTION HAD (generation run 2026-09-09, finding F-11). The
 * spine prompt for the engineering-disasters Foray listed "Ai (semantic-
 * concept, tape: strong, 761 items)" among eight candidate subtopics, and Opus
 * was told there was strong tape for AI on a bridge-collapse documentary. The
 * finding attributed it to shared tokens; the actual mechanism is narrower and
 * worse. The old matcher accepted a term as a match when it appeared ANYWHERE
 * as a substring of the hyphen-joined query. The `ai` concept's first term is
 * the two-letter string "ai". The prompt contained the word "chains". "ch-ai-
 * ns" matched, and the largest corpus in the archive (761 items of Practical
 * AI) was attached to a Foray about collapsing walkways.
 *
 * TWO CHANGES, IN THIS ORDER, because each catches something the other cannot:
 *
 *   1. A TERM MUST MATCH AT A WORD BOUNDARY. Exact token ("bridges" in the
 *      query) scores 2; a stem of at least four characters, in either
 *      direction ("collapse"/"collapsed", "grill"/"grilling"), scores 1; a
 *      multi-word term still matches as a run of adjacent query words, so
 *      "clean-energy" still finds "clean energy". An arbitrary interior
 *      substring scores nothing. This alone removes `ai` from run 1's map.
 *   2. AN OFF-BRANCH CONCEPT MUST EARN ITS PLACE. When the caller knows the
 *      Foray's resolved topic, a concept that matched only on a stem AND whose
 *      every topic sits outside the Foray's taxonomy lineage is dropped. A
 *      concept in the lineage is never dropped — that is what keeps
 *      `engineering-failures` (topic `engineering/disasters`, matched only via
 *      the stem "collapse") in the map, where it belongs.
 *
 * Checked against the real run-1 inputs in `test/researchTopicFilter.test.ts`.
 */
export function matchConceptsInText(
  text: string,
  concepts: Record<string, SemanticConcept>,
  options: ConceptMatchOptions = {}
): string[] {
  const tokens = new Set(tokenize(text));
  /* Word sequence, for multi-word terms. `tokenize` drops stopwords and short
     words, which a hyphenated term may legitimately contain, so this keeps the
     raw split. */
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const topic = options.topic?.trim() ?? "";

  const scored: Array<{ key: string; score: number }> = [];
  for (const [key, concept] of Object.entries(concepts)) {
    let score = 0;
    let exact = 0;
    for (const term of concept.terms) {
      const hit = scoreTerm(term.toLowerCase(), tokens, words);
      if (hit === 2) exact += 1;
      score += hit;
    }
    if (score === 0) continue;

    if (topic.length > 0 && exact === 0) {
      const onBranch = concept.topics.some((t) => sharesTopicFamily(t, topic));
      if (!onBranch) continue;
    }

    scored.push({ key, score });
  }
  scored.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  return scored.map((s) => s.key);
}

/** 2 for an exact whole-token (or whole-word-sequence) hit, 1 for a stem hit,
 * 0 for no hit. See `matchConceptsInText`'s doc comment for why an interior
 * substring is worth nothing. */
function scoreTerm(term: string, tokens: Set<string>, words: string[]): 0 | 1 | 2 {
  if (term.length === 0) return 0;

  const parts = term.split("-").filter(Boolean);
  if (parts.length > 1) {
    // Multi-word term: an adjacent run of query words, e.g. "clean energy".
    for (let i = 0; i + parts.length <= words.length; i++) {
      let all = true;
      for (let j = 0; j < parts.length; j++) {
        if (words[i + j] !== parts[j]) {
          all = false;
          break;
        }
      }
      if (all) return 2;
    }
    return 0;
  }

  if (tokens.has(term) || words.includes(term)) return 2;
  if (term.length < MIN_STEM_TERM_LENGTH) return 0;
  for (const w of words) {
    if (w.length < MIN_STEM_TERM_LENGTH) continue;
    if (w.startsWith(term) || term.startsWith(w)) return 1;
  }
  return 0;
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
