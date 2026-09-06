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
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

export interface TaxonomyNode {
  id: string;
  parent: string | null;
  label: string;
}

export interface TopicCandidate {
  id: string;
  label: string;
  score: number;
}

export interface ResolveTopicResult {
  /** The chosen node id, or null when nothing cleared the bar. */
  resolved: string | null;
  /** Always populated — the ranked shortlist, so a failure names what it nearly picked. */
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

let cachedNodes: TaxonomyNode[] | null = null;

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
}

/** A node's searchable tokens: its id path segments plus its human label. */
function nodeTokens(node: TaxonomyNode): Set<string> {
  const fromId = node.id.split("/").join(" ").split("-").join(" ");
  return new Set([...tokenizeForCatalogueQuery(fromId), ...tokenizeForCatalogueQuery(node.label)]);
}

/**
 * Scores every taxonomy node against free text and returns the ranked list.
 *
 * Scoring, in order of weight:
 *   - one point per distinct shared token;
 *   - +0.5 for a child node over a root, because a Foray is about a subject and
 *     `history/technology` says more than `history`. Without it every match on
 *     a root's own name beats its more specific children, which is the wrong
 *     way round for a curation product;
 *   - ties broken by id, so the order is stable and pinnable in a test rather
 *     than dependent on the file's row order.
 */
export function scoreTopics(text: string, nodes: TaxonomyNode[]): TopicCandidate[] {
  const queryTokens = new Set(tokenizeForCatalogueQuery(text));
  if (queryTokens.size === 0) return [];

  const scored: TopicCandidate[] = [];
  for (const node of nodes) {
    const tokens = nodeTokens(node);
    let overlap = 0;
    for (const t of tokens) if (queryTokens.has(t)) overlap++;
    if (overlap === 0) continue;
    const depthBonus = node.parent ? 0.5 : 0;
    scored.push({ id: node.id, label: node.label, score: overlap + depthBonus });
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored;
}

/** How many nodes carry a given token — the rarity signal the one-token rule needs. */
function tokenRarity(nodes: TaxonomyNode[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    for (const t of nodeTokens(node)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return counts;
}

/**
 * Resolves a topic from a Foray's subject and angle.
 *
 * Returns `resolved: null` rather than throwing so the caller decides what a
 * miss means — the batch driver skips that prompt and reports it, while an
 * interactive run can print the shortlist and ask a human to pick.
 */
export function resolveTopic(
  text: string,
  options: { nodes?: TaxonomyNode[]; root?: string } = {}
): ResolveTopicResult {
  const nodes = options.nodes ?? loadTaxonomyNodes(options.root);
  const candidates = scoreTopics(text, nodes);
  if (candidates.length === 0) return { resolved: null, candidates: [] };

  const best = candidates[0]!;
  const wholeTokenScore = Math.floor(best.score);

  if (wholeTokenScore >= MIN_TOKEN_OVERLAP) {
    return { resolved: best.id, candidates: candidates.slice(0, 5) };
  }

  /* The rare-token escape hatch. A single shared token is normally too thin,
     but "fusion" or "bbq" appearing in one node out of 194 is a stronger
     signal than two shared instances of "and". */
  const rarity = tokenRarity(nodes);
  const queryTokens = new Set(tokenizeForCatalogueQuery(text));
  const bestNode = nodes.find((n) => n.id === best.id)!;
  for (const t of nodeTokens(bestNode)) {
    if (queryTokens.has(t) && (rarity.get(t) ?? Infinity) <= RARE_TOKEN_MAX_NODES) {
      return { resolved: best.id, candidates: candidates.slice(0, 5) };
    }
  }

  return { resolved: null, candidates: candidates.slice(0, 5) };
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
