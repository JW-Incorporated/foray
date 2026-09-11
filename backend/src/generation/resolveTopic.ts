import * as fs from "fs";
import * as path from "path";
import { tokenizeForCatalogueQuery } from "./catalogueLookup";

/**
 * Resolves a `data/taxonomy.json` node id for a generated Foray.
 *
 * WHY THIS EXISTS AS ITS OWN STAGE-ADJACENT MODULE. `finalizeForay.ts`'s own
 * header states the problem plainly: nothing upstream of §4.9 owns a Foray's
 * `id`, `topic` or public `summary` — §4.0-4.1's `GenerationRequest` carries a
 * free-text prompt and nothing else. But `tools/foray/check-forays.mjs` rejects
 * any Foray whose `topic` is not a real taxonomy node, so SOMETHING has to turn
 * "the history of grilling" into `food/grilling-bbq` before a Foray can be
 * published. Until now that something was a human typing it into a JSON file,
 * which is fine for four hand-made Forays and is exactly the step that stops a
 * batch of two hundred.
 *
 * IT FAILS RATHER THAN GUESSES, and that is the whole design. An unresolvable
 * topic returns `{ resolved: null, candidates }` and the caller stops. The
 * alternative — falling back to a plausible-looking root node — would attach a
 * Foray about Roman concrete to `history` because both words are common, and
 * nothing downstream would ever catch it: `check-forays.mjs` only asks whether
 * the node EXISTS, not whether it is the right one. A wrong-but-valid topic is
 * the failure mode this module is shaped to avoid, so the bar is deliberately
 * set where a miss is loud.
 *
 * DETERMINISTIC AND KEYLESS. No LLM call: the spine already carries a subject
 * and an angle written by one, and scoring those against 194 node ids and
 * labels is a token-overlap problem, not a judgement problem. Same tokenizer as
 * every other matcher in this pipeline (`tokenizeForCatalogueQuery`) so a word
 * is split the same way here as in `segmentPoolLookup` and `catalogueLookup`
 * rather than by a second, subtly different rule.
 *
 * WHAT F-59 BROKE, AND WHY COUNTING SHARED TOKENS WAS NOT ENOUGH.
 * Generation run 2's topic text — "the end-to-end engineering pipeline of
 * building and operating machine learning systems in production…" — resolved to
 * `engineering/energy-fusion`, and §4.5's lineage gate then refused every
 * AI-adjacent show in the archive as off-topic. Nothing about fusion appeared
 * anywhere in that prompt. The node won on exactly two words:
 *
 *   - `engineering`, which every one of that root's six children gets free from
 *     its own id, and
 *   - `systems`, from the label "Fusion & energy systems".
 *
 * Two shared tokens cleared `MIN_TOKEN_OVERLAP`, so the node resolved — while
 * `engineering/ai-robotics`, the right answer, could match nothing at all: the
 * tokenizer drops words of two letters, so "ai" is not even a token, and its
 * label ("Ai Robotics") advertises no vocabulary a production-ML prompt uses.
 * The same magnet shows up in show classification (#547: CBC Ideas, Lex Fridman
 * and Catalyst all carry `energy-fusion` as their only node), because it is a
 * property of the node's ADVERTISED WORDS, not of either matcher.
 *
 * So the scorer now separates two kinds of evidence, and only the second kind
 * can resolve a topic:
 *
 *   1. GENERIC tokens — a word carried by more than `GENERIC_TOKEN_MAX_NODES`
 *      nodes (`engineering`, `history`, `music`), or one of the
 *      `GENERIC_LABEL_WORDS` that describe a FORM rather than a subject
 *      (`systems`). Worth `GENERIC_TOKEN_WEIGHT`, and never enough on their
 *      own: a node whose entire case is generic words is refused, however many
 *      it has.
 *   2. DISTINCTIVE evidence — a rare id/label token (`disasters`, `grilling`),
 *      or a TERM the node advertises: `terms` on the node itself, plus the
 *      multi-word phrases the semantic index already maps to it. "machine
 *      learning" points at `engineering/ai-robotics` in
 *      `data/semantic-index.json` and always did; the resolver was the one
 *      matcher in the pipeline not reading it.
 *
 * WHY ONLY MULTI-WORD CONCEPT TERMS. A concept's single-word vocabulary is
 * corpus vocabulary, not node-distinguishing vocabulary: the concepts pointing
 * at `engineering/precision-mfg` list "production", "systems" and
 * "engineering", which would have replaced one magnet with a worse one (it
 * outscored everything on run 2's text in a prototype, and pulled run 1's
 * disasters prompt to `architecture/infrastructure`). A PHRASE is different —
 * "machine learning", "cold war", "clean energy" are said by people talking
 * about one subject — so a concept term earns weight here only when it is more
 * than one word. A node's OWN `terms` are curated against the node and carry no
 * such restriction.
 *
 * WHY A PHRASE HIT IS DIVIDED BY THE CONCEPT'S TOPIC COUNT. "machine learning"
 * is listed by two concepts: `ai` (topics: `engineering/ai-robotics`) and
 * `machine-learning` (topics: `computing/history`, `economics/markets`). A term
 * that names ONE node is decisive; the same term spread over three is a hint.
 * Dividing keeps the decisive one ahead without hand-ranking concepts.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

export interface TaxonomyNode {
  id: string;
  parent: string | null;
  label: string;
  /**
   * Distinctive vocabulary the node advertises, when its label alone cannot
   * carry it. Optional and rare by design — only `engineering/energy-fusion`
   * has one today, added with F-59 so that the node which was winning on
   * "systems" now has to be given an actual fusion word ("tokamak", "plasma",
   * "ITER") before it can win anything.
   */
  terms?: string[];
}

export interface TopicCandidate {
  id: string;
  label: string;
  score: number;
  /** Every id/label token this node shares with the query. */
  matchedTokens: string[];
  /** The subset of `matchedTokens` that is not generic — the ones that can resolve. */
  distinctiveTokens: string[];
  /** Advertised terms the query contains, node `terms` and concept phrases alike. */
  matchedTerms: string[];
}

export interface ResolveTopicResult {
  /** The chosen node id, or null when nothing cleared the bar. */
  resolved: string | null;
  /**
   * Always populated — the ranked shortlist (top 5), on the resolved path as
   * well as the unresolved one, so a run can always answer "what did it nearly
   * pick, and on what words". F-59 took a replay to diagnose precisely because
   * a resolved topic reported nothing about why.
   */
  candidates: TopicCandidate[];
}

/**
 * A node must share at least this many distinct tokens with the query to be
 * considered at all. One shared token is how "the history of grilling" reaches
 * `history/military-ancient`: the bar exists to make a single common word
 * insufficient on its own.
 */
export const MIN_TOKEN_OVERLAP = 2;

/**
 * A one-token match is allowed only when the token is a rare one — it appears
 * in at most this many nodes. "fusion" appears in one node and is decisive;
 * "history" appears in a dozen and is not.
 */
export const RARE_TOKEN_MAX_NODES = 2;

/**
 * Above this many nodes, a token is GENERIC: it says which corner of the
 * taxonomy is being talked about and nothing more. `engineering` is carried by
 * seven nodes, so an engineering prompt says "engineering" and picks none of
 * them.
 */
export const GENERIC_TOKEN_MAX_NODES = 3;

/** What a generic token is worth: enough to break a tie, never enough to resolve. */
export const GENERIC_TOKEN_WEIGHT = 0.25;

/** What one advertised term is worth — deliberately above any single token. */
export const TERM_MATCH_WEIGHT = 2;

/**
 * Label words that describe a FORM rather than a subject.
 *
 * These are generic in prose while being rare in the taxonomy, so the
 * node-count rule above cannot catch them: "systems" appears in exactly one
 * label ("Fusion & energy systems") and would score as the most distinctive
 * word in the tree, which is the whole of F-59. Kept short and evidence-led on
 * purpose — a word that names a real subject for some node (`technology`,
 * `management`, `design`, `history`) does NOT belong here, because listing it
 * would stop that node ever resolving.
 */
export const GENERIC_LABEL_WORDS = new Set([
  "system",
  "systems",
  "general",
  "misc",
  "other",
  "topics",
  "studies",
  "modern",
  "world"
]);

let cachedNodes: TaxonomyNode[] | null = null;
let cachedConceptTerms: Map<string, Map<string, number>> | null = null;

export function loadTaxonomyNodes(root: string = REPO_ROOT): TaxonomyNode[] {
  if (cachedNodes) return cachedNodes;
  const raw = fs.readFileSync(path.join(root, "data", "taxonomy.json"), "utf8");
  const parsed = JSON.parse(raw) as { nodes: TaxonomyNode[] };
  cachedNodes = parsed.nodes;
  return cachedNodes;
}

/** Test seam — the module-level cache would otherwise leak one test's fixture into the next. */
export function resetTaxonomyCache(): void {
  cachedNodes = null;
  cachedConceptTerms = null;
}

/** A node's searchable tokens: its id path segments plus its human label. */
function nodeTokens(node: TaxonomyNode): Set<string> {
  const fromId = node.id.split("/").join(" ").split("-").join(" ");
  return new Set([...tokenizeForCatalogueQuery(fromId), ...tokenizeForCatalogueQuery(node.label)]);
}

/** How many nodes carry a given token — the rarity signal the generic rule needs. */
function tokenRarity(nodes: TaxonomyNode[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    for (const t of nodeTokens(node)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return counts;
}

function isGenericToken(token: string, rarity: Map<string, number>): boolean {
  return GENERIC_LABEL_WORDS.has(token) || (rarity.get(token) ?? 0) > GENERIC_TOKEN_MAX_NODES;
}

/* ------------------------------------------------------------------ */
/* Advertised terms                                                     */
/* ------------------------------------------------------------------ */

/** node id -> (term -> weight). A term listed twice keeps its highest weight. */
export type NodeTermWeights = Map<string, Map<string, number>>;

function addTerm(into: NodeTermWeights, nodeId: string, term: string, weight: number): void {
  const key = term.trim().toLowerCase();
  if (key.length === 0) return;
  let bucket = into.get(nodeId);
  if (!bucket) {
    bucket = new Map<string, number>();
    into.set(nodeId, bucket);
  }
  bucket.set(key, Math.max(bucket.get(key) ?? 0, weight));
}

/**
 * The multi-word vocabulary `data/semantic-index.json` already attaches to
 * taxonomy nodes. Read directly rather than through `loadCatalogueData`, which
 * also parses 2.3 MB of `data/discover.json` this module has no use for.
 *
 * A missing or unreadable index is not a failure: it means "no advertised
 * phrases", and the resolver falls back to tokens and node `terms`. A checkout
 * without `data/` is a real case (see `researchShape.resolveFilterTopic`).
 */
export function loadConceptTermWeights(root: string = REPO_ROOT): NodeTermWeights {
  if (cachedConceptTerms) return cachedConceptTerms;
  const weights: NodeTermWeights = new Map();
  try {
    const file = path.join(root, "data", "semantic-index.json");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- hardcoded repo-relative path, not external input.
    if (fs.existsSync(file)) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above.
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
        concepts?: Record<string, { terms?: string[]; topics?: string[] }>;
      };
      for (const concept of Object.values(parsed.concepts ?? {})) {
        const topics = (concept.topics ?? []).filter((t): t is string => typeof t === "string");
        if (topics.length === 0) continue;
        const weight = TERM_MATCH_WEIGHT / topics.length;
        for (const term of concept.terms ?? []) {
          /* Phrases only — see the header. A concept's single words are corpus
             vocabulary and put "production" on a precision-manufacturing node. */
          if (typeof term !== "string" || !term.includes("-")) continue;
          for (const topic of topics) addTerm(weights, topic, term, weight);
        }
      }
    }
  } catch {
    /* An unreadable semantic index means "no advertised phrases", not a crash. */
  }
  cachedConceptTerms = weights;
  return weights;
}

/** The terms a node advertises itself, from `data/taxonomy.json`. */
export function nodeTermWeights(nodes: TaxonomyNode[]): NodeTermWeights {
  const weights: NodeTermWeights = new Map();
  for (const node of nodes) {
    for (const term of node.terms ?? []) addTerm(weights, node.id, term, TERM_MATCH_WEIGHT);
  }
  return weights;
}

function mergeTermWeights(...sources: NodeTermWeights[]): NodeTermWeights {
  const out: NodeTermWeights = new Map();
  for (const source of sources) {
    for (const [nodeId, terms] of source) {
      for (const [term, weight] of terms) addTerm(out, nodeId, term, weight);
    }
  }
  return out;
}

/**
 * Whether a query contains a term, at word boundaries.
 *
 * Deliberately the STRICT subset of `catalogueLookup.matchConceptsInText`'s
 * rule: an exact token, or — for a hyphenated term — a run of adjacent query
 * words. No stem matching. The research map can afford a stem hit because a
 * wrong concept there is one line in a prompt; a wrong node HERE is every
 * sourcing decision in the run, so the bar is the higher one.
 */
function queryHasTerm(term: string, tokens: Set<string>, words: string[]): boolean {
  const parts = term.split(/[^a-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.length === 1) return tokens.has(parts[0]!);
  for (let i = 0; i + parts.length <= words.length; i++) {
    let all = true;
    for (let j = 0; j < parts.length; j++) {
      if (words[i + j] !== parts[j]) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return false;
}

/**
 * Scores every taxonomy node against free text and returns the ranked list.
 *
 * Scoring, in order of weight:
 *   - `TERM_MATCH_WEIGHT` per advertised term the query contains (a concept
 *     phrase divides that by how many nodes the concept names);
 *   - one point per distinct shared DISTINCTIVE token, `GENERIC_TOKEN_WEIGHT`
 *     for a generic one (see `GENERIC_LABEL_WORDS` and the header);
 *   - +0.5 for a child node over a root, because a Foray is about a subject and
 *     `history/technology` says more than `history`. Without it every match on
 *     a root's own name beats its more specific children, which is the wrong
 *     way round for a curation product;
 *   - ties broken by id, so the order is stable and pinnable in a test rather
 *     than dependent on the file's row order.
 *
 * A node with no shared token AND no matched term is not a candidate at all —
 * the depth bonus is a tie-breaker between matches, never a score of its own.
 */
export function scoreTopics(
  text: string,
  nodes: TaxonomyNode[],
  terms: NodeTermWeights = nodeTermWeights(nodes)
): TopicCandidate[] {
  const queryTokens = new Set(tokenizeForCatalogueQuery(text));
  const queryWords = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (queryTokens.size === 0) return [];

  const rarity = tokenRarity(nodes);
  const scored: TopicCandidate[] = [];
  for (const node of nodes) {
    const matchedTokens: string[] = [];
    const distinctiveTokens: string[] = [];
    let score = 0;
    for (const t of nodeTokens(node)) {
      if (!queryTokens.has(t)) continue;
      matchedTokens.push(t);
      if (isGenericToken(t, rarity)) {
        score += GENERIC_TOKEN_WEIGHT;
      } else {
        distinctiveTokens.push(t);
        score += 1;
      }
    }

    const matchedTerms: string[] = [];
    for (const [term, weight] of terms.get(node.id) ?? []) {
      if (!queryHasTerm(term, queryTokens, queryWords)) continue;
      matchedTerms.push(term);
      score += weight;
    }

    if (matchedTokens.length === 0 && matchedTerms.length === 0) continue;
    if (node.parent) score += 0.5;
    matchedTokens.sort();
    distinctiveTokens.sort();
    matchedTerms.sort();
    scored.push({
      id: node.id,
      label: node.label,
      score: Math.round(score * 1000) / 1000,
      matchedTokens,
      distinctiveTokens,
      matchedTerms
    });
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored;
}

/**
 * Resolves a topic from a Foray's subject and angle.
 *
 * Returns `resolved: null` rather than throwing so the caller decides what a
 * miss means — the batch driver skips that prompt and reports it, while an
 * interactive run can print the shortlist and ask a human to pick.
 *
 * THE BAR, after F-59: the winner has to have said something distinctive.
 * Either it matched a term it advertises, or it shares a token that is not
 * generic — and, as before, a lone token has to be a rare one. Generic words
 * accumulate score for ranking and can no longer resolve anything, which is
 * exactly what stops "engineering … systems" reaching a fusion node.
 */
export function resolveTopic(
  text: string,
  options: { nodes?: TaxonomyNode[]; root?: string; terms?: NodeTermWeights } = {}
): ResolveTopicResult {
  const nodes = options.nodes ?? loadTaxonomyNodes(options.root);
  const terms =
    options.terms ?? mergeTermWeights(nodeTermWeights(nodes), loadConceptTermWeights(options.root));
  const candidates = scoreTopics(text, nodes, terms);
  if (candidates.length === 0) return { resolved: null, candidates: [] };

  const shortlist = candidates.slice(0, 5);
  const best = candidates[0]!;

  /* An advertised term is the strongest signal there is: it was written against
     this node and nothing else. "tokamak" resolves the fusion node; "systems"
     no longer does. */
  if (best.matchedTerms.length > 0) return { resolved: best.id, candidates: shortlist };

  if (best.distinctiveTokens.length === 0) return { resolved: null, candidates: shortlist };

  if (best.matchedTokens.length >= MIN_TOKEN_OVERLAP) {
    return { resolved: best.id, candidates: shortlist };
  }

  /* The rare-token escape hatch. A single shared token is normally too thin,
     but "fusion" or "bbq" appearing in one node out of 194 is a stronger
     signal than two shared instances of "and". */
  const rarity = tokenRarity(nodes);
  for (const t of best.distinctiveTokens) {
    if ((rarity.get(t) ?? Infinity) <= RARE_TOKEN_MAX_NODES) {
      return { resolved: best.id, candidates: shortlist };
    }
  }

  return { resolved: null, candidates: shortlist };
}

/**
 * A stable, collision-resistant Foray id from its title.
 *
 * `data/forays.json` ids are human-readable and unique (`grilling-history-1`,
 * `grilling-history-2`), and check-forays requires uniqueness. A slug alone
 * collides the second time anyone generates a Foray about the same subject, so
 * a short hash of the full title plus the generation timestamp is appended:
 * two runs on the same subject produce two different ids, which is correct —
 * they are two different Forays, not one Foray twice.
 */
export function forayIdFor(title: string, generatedAt: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- node builtin, sync by design
  const { createHash } = require("crypto") as typeof import("crypto");
  const hash = createHash("sha1").update(`${title}\n${generatedAt}`).digest("hex").slice(0, 6);
  return slug ? `${slug}-${hash}` : `foray-${hash}`;
}
