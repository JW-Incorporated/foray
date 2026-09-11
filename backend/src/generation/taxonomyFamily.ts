import * as fs from "fs";
import * as path from "path";
import { loadTaxonomyNodes, type TaxonomyNode } from "./resolveTopic";
import { deriveItemId, type TranscriptDigestEntry } from "./transcriptArchiveLookup";

/**
 * The §4.5 TOPIC GATE's one job: say whether two things belong to the same
 * taxonomy FAMILY, so sourcing can refuse tape from a different one.
 *
 * WHY THIS EXISTS (generation run 1, findings F-23/F-24/F-29/F-38). Every §4.5
 * scorer matched words and nothing else, so an engineering-disasters Foray was
 * handed a British food-history segment (`food/food-history`), a barbecue
 * episode (`food/grilling-bbq`) and four geology episodes
 * (`nature/earth-science`) — 5 of 22 anchors on topic. Both sides of that
 * comparison were already available and simply never compared:
 * `data/segments.json` carries a `topic` node per segment, `data/catalog.json`
 * carries `taxonomy_node_ids` per show, `data/segment-sources.json` joins an
 * item id to its show, and `resolveTopic.ts` gives the Foray its own node. This
 * module is the missing join.
 *
 * FAMILY MEANS LINEAGE, NOT THE FIRST PATH SEGMENT. The obvious rule —
 * "`engineering/disasters` and `engineering/energy-grid` both start with
 * `engineering`, so they match" — is too coarse, and WS-F's F-11 correction is
 * the same argument from the other end of the pipeline: a root-segment rule
 * puts every one of a root's children in scope, which is exactly how "strong
 * tape for AI" ended up on a bridge-collapse research map. A family here is a
 * node's LINEAGE in `data/taxonomy.json` — the node itself, its ancestors and
 * its descendants. For `engineering/disasters` that is
 * {`engineering/disasters`, `engineering`}: tape classified under the node, and
 * tape classified only under its parent (a show the catalogue never got more
 * specific about), both count; a sibling trade like `engineering/precision-mfg`
 * does not. The relation is symmetric — `x` is in `y`'s family exactly when `y`
 * is in `x`'s — so a broadly-classified show reaches a narrow Foray and a
 * narrowly-classified episode reaches a broad one, which is the behaviour a
 * two-level taxonomy needs in both directions.
 *
 * WHAT A CANDIDATE'S NODES ARE. Deliberately the SAME union WS-B's
 * `veracityMetrics.computeTapeRelevance` computes, so the gate and the metric
 * that scores the gate cannot report different things about one anchor: a
 * segment's own `topic`, unioned with the `taxonomy_node_ids` of the show its
 * item belongs to (`data/segment-sources.json` `sources[].show` →
 * `data/catalog.json` `shows[].title`). Tier 2 has a `show_id` directly, so it
 * also joins `shows[].show_id`.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/**
 * The first path segment of a node id — `engineering/disasters` →
 * `engineering`.
 *
 * NOT the gate (see the header: the gate is lineage). This exists because it is
 * the value WS-B's `TapeAnchorNote.families` carries, and the `tapeRelevance`
 * rows §4.5 emits use that field name and those values so WS-B can aggregate
 * them without re-deriving anything.
 */
export function taxonomyRoot(node: string | null | undefined): string | null {
  const text = String(node ?? "").trim().toLowerCase();
  if (!text) return null;
  const head = text.split("/")[0]!.trim();
  return head.length > 0 ? head : null;
}

/** WS-B's `families` for a set of node ids: their distinct roots, in order. */
export function familiesOfNodes(nodes: string[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    const root = taxonomyRoot(node);
    if (root && !out.includes(root)) out.push(root);
  }
  return out;
}

let cachedShowNodesById: Map<string, string[]> | null = null;
let cachedShowNodesByTitle: Map<string, string[]> | null = null;
let cachedShowByItemId: Map<string, string> | null = null;
let cachedBreadthNodes: Map<string, string[]> | null = null;
let cachedLineages: Map<string, string[]> | null = null;

/** Test seam — the module-level caches would otherwise leak a fixture between tests. */
export function resetTaxonomyFamilyCache(): void {
  cachedShowNodesById = null;
  cachedShowNodesByTitle = null;
  cachedShowByItemId = null;
  cachedBreadthNodes = null;
  cachedLineages = null;
}

function cachingDisabled(): boolean {
  return process.env.FORAY_SKIP_CATALOGUE_CACHE === "1";
}

/* ------------------------------------------------------------------ */
/* Lineage                                                              */
/* ------------------------------------------------------------------ */

function buildLineages(nodes: TaxonomyNode[]): Map<string, string[]> {
  const byId = new Map<string, TaxonomyNode>(nodes.map((n) => [n.id, n]));
  const ancestorsOf = new Map<string, string[]>();
  for (const node of nodes) {
    const chain: string[] = [];
    let cursor: TaxonomyNode | undefined = node;
    /* `seen` is not paranoia about the committed file — it is the only thing
       standing between a hand-edited cycle in data/taxonomy.json and an
       infinite loop inside a sourcing run. */
    const seen = new Set<string>([node.id]);
    while (cursor?.parent && !seen.has(cursor.parent)) {
      chain.push(cursor.parent);
      seen.add(cursor.parent);
      cursor = byId.get(cursor.parent);
    }
    ancestorsOf.set(node.id, chain);
  }

  const lineages = new Map<string, Set<string>>();
  for (const node of nodes) lineages.set(node.id, new Set<string>([node.id, ...(ancestorsOf.get(node.id) ?? [])]));
  // Descendants are the mirror of ancestors, so one pass over the ancestor
  // chains fills them in without a second tree walk.
  for (const node of nodes) {
    for (const ancestor of ancestorsOf.get(node.id) ?? []) lineages.get(ancestor)?.add(node.id);
  }

  return new Map([...lineages].map(([id, set]) => [id, [...set]]));
}

/**
 * A node's family: itself, its ancestors and its descendants, from
 * `data/taxonomy.json`. Empty when the id is not a taxonomy node at all —
 * callers treat that as "compare coarsely instead", never as "matches
 * nothing".
 */
export function taxonomyLineage(nodeId: string, root: string = REPO_ROOT): string[] {
  if (!cachedLineages || cachingDisabled()) cachedLineages = buildLineages(loadTaxonomyNodes(root));
  return cachedLineages.get(String(nodeId ?? "").trim()) ?? [];
}

/* ------------------------------------------------------------------ */
/* Catalogue joins                                                      */
/* ------------------------------------------------------------------ */

interface CatalogueShowRow {
  show_id?: string;
  title?: string;
  taxonomy_node_ids?: string[];
}

function loadShowNodes(root: string): { byId: Map<string, string[]>; byTitle: Map<string, string[]> } {
  if (cachedShowNodesById && cachedShowNodesByTitle && !cachingDisabled()) {
    return { byId: cachedShowNodesById, byTitle: cachedShowNodesByTitle };
  }
  const byId = new Map<string, string[]>();
  const byTitle = new Map<string, string[]>();
  const file = path.join(root, "data", "catalog.json");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- hardcoded repo-relative path, not external input.
  if (fs.existsSync(file)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above.
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { shows?: CatalogueShowRow[] };
    for (const show of parsed.shows ?? []) {
      const nodes = (show.taxonomy_node_ids ?? []).filter((n): n is string => typeof n === "string");
      if (nodes.length === 0) continue;
      if (typeof show.show_id === "string") byId.set(show.show_id, nodes);
      if (typeof show.title === "string") byTitle.set(show.title, nodes);
    }
  }
  cachedShowNodesById = byId;
  cachedShowNodesByTitle = byTitle;
  return { byId, byTitle };
}

/**
 * `data/segment-sources.json`: the item-id → show-title registry. The same
 * join WS-B uses, for the same reason — a pool segment's `item_id` resolves
 * here and nowhere else (`data/discover.json`'s item ids do not join against
 * it at all; see `veracityMetrics.ts`'s note).
 */
function loadShowByItemId(root: string): Map<string, string> {
  if (cachedShowByItemId && !cachingDisabled()) return cachedShowByItemId;
  const map = new Map<string, string>();
  const file = path.join(root, "data", "segment-sources.json");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- hardcoded repo-relative path, not external input.
  if (fs.existsSync(file)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above.
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { sources?: Array<{ id?: string; show?: string }> };
    for (const source of parsed.sources ?? []) {
      if (typeof source.id === "string" && typeof source.show === "string") map.set(source.id, source.show);
    }
  }
  cachedShowByItemId = map;
  return map;
}

/**
 * The breadth tier's classifications, read ONLY for a numeric show id.
 *
 * `data/breadth-transcript-digests.json` keys its entries by Apple collection
 * id (`"1202593158"`), which `data/catalog.json` does not carry, so without
 * this every breadth episode would have an unknown family and the gate would
 * refuse it. The file is 17 MB, which is why the load is lazy AND why it is
 * attempted only for a show id shaped like a collection id: a curated show
 * (`geology-bites`) is never in it, so parsing 17 MB to discover that would be
 * pure waste, in a test run most of all.
 */
function loadBreadthNodes(root: string): Map<string, string[]> {
  if (cachedBreadthNodes && !cachingDisabled()) return cachedBreadthNodes;
  const map = new Map<string, string[]>();
  const file = path.join(root, "data", "breadth-classification.json");
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- hardcoded repo-relative path, not external input.
    if (fs.existsSync(file)) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above.
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { entries?: Record<string, { topics?: string[] }> };
      for (const [id, entry] of Object.entries(parsed.entries ?? {})) {
        if (Array.isArray(entry?.topics)) map.set(id, entry.topics.filter((n): n is string => typeof n === "string"));
      }
    }
  } catch {
    /* An unreadable classification file means "unknown family", not a crash. */
  }
  cachedBreadthNodes = map;
  return map;
}

/** Every taxonomy node a SHOW is classified under, by its catalogue `show_id`. */
export function taxonomyNodesForShowId(showId: string, root: string = REPO_ROOT): string[] {
  const id = String(showId ?? "").trim();
  if (!id) return [];
  const curated = loadShowNodes(root).byId.get(id);
  if (curated && curated.length > 0) return curated;
  if (/^\d+$/.test(id)) return loadBreadthNodes(root).get(id) ?? [];
  return [];
}

/** Every taxonomy node the SHOW BEHIND AN ITEM is classified under. */
export function taxonomyNodesForItemId(itemId: string, root: string = REPO_ROOT): string[] {
  const id = String(itemId ?? "").trim();
  if (!id) return [];
  const showTitle = loadShowByItemId(root).get(id);
  if (!showTitle) return [];
  return loadShowNodes(root).byTitle.get(showTitle) ?? [];
}

/**
 * The taxonomy nodes a tier-2 ARCHIVE EPISODE resolves to: its show's nodes by
 * `show_id`, plus the item-id join so a minted segment resolves the way a
 * pooled one does.
 *
 * STATED ONCE, HERE, because three stages ask the same question of the same
 * entry and must get the same answer: §4.2's research map (`researchShape.ts`)
 * decides which episodes may be quoted into the spine prompt, §4.5's tier 2
 * (`sourceBeats.ts`) decides which may be opened for a beat, and F-91's supply
 * measure (`topicSupply.ts`) decides whether the archive can carry the topic
 * at all. Until F-91 the first two carried private copies of this union; a
 * third copy is where they would have started to drift.
 */
export function nodesForArchiveEntry(entry: TranscriptDigestEntry, root: string = REPO_ROOT): string[] {
  return unionNodes(taxonomyNodesForShowId(entry.show_id, root), taxonomyNodesForItemId(deriveItemId(entry), root));
}

/** The two fields of a `data/segments.json` row the pool-side gate reads. */
export interface PoolSegmentLike {
  item_id: string;
  topic?: string | null;
}

/**
 * Every taxonomy node a POOL SEGMENT can be said to belong to: its own `topic`
 * plus its show's `taxonomy_node_ids`.
 *
 * The union — rather than the segment's `topic` alone — is deliberate, and it
 * is the same union WS-B's `computeTapeRelevance` builds from disk. Two reasons
 * it has to be a union. A segment's own node is the more specific signal but 67
 * of the 212 pooled segments have no resolvable show, and 16 of the 145 that do
 * disagree with it: the three Hyatt Regency segments carry
 * `architecture/infrastructure`, `engineering/disasters` and `engineering`
 * between them, all cut from one episode of one show the catalogue classifies
 * as `engineering/disasters`. Gating on the segment's own node alone would
 * refuse the first of those three for an engineering Foray — the right episode,
 * refused on a curator's per-segment nuance. And computing it differently from
 * WS-B would let the gate and the metric that scores the gate disagree about
 * the same anchor, which is exactly the kind of silent divergence run 1 was
 * made of. Shared with F-91's supply measure for the same reason as
 * `nodesForArchiveEntry` above.
 */
export function nodesForPoolSegment(segment: PoolSegmentLike, root: string = REPO_ROOT): string[] {
  return unionNodes(segment.topic ?? null, taxonomyNodesForItemId(segment.item_id, root));
}

/** De-duplicating union, order-preserving — the shape every candidate node list has. */
export function unionNodes(...lists: Array<string[] | string | null | undefined>): string[] {
  const out: string[] = [];
  for (const list of lists) {
    for (const node of Array.isArray(list) ? list : [list]) {
      const id = String(node ?? "").trim();
      if (id && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The gate                                                             */
/* ------------------------------------------------------------------ */

function inLineage(forayTopic: string, candidateNodes: string[], root: string): boolean {
  const lineage = taxonomyLineage(forayTopic, root);
  if (lineage.length === 0) {
    /* The Foray's own node is not in data/taxonomy.json — impossible for a real
       run (`resolveTopic` only ever returns a node that is), but a caller can
       pass anything. Fall back to the coarse comparison rather than refusing
       every candidate: an unknown topic is a reason to be less confident, not a
       reason to claim everything is off-topic. */
    return candidateNodes.some((n) => taxonomyRoot(n) === taxonomyRoot(forayTopic));
  }
  const set = new Set(lineage);
  return candidateNodes.some(
    (n) =>
      set.has(n) ||
      // A candidate the taxonomy has not caught up with is compared coarsely,
      // for the same reason as above and no further.
      (taxonomyLineage(n, root).length === 0 && taxonomyRoot(n) === taxonomyRoot(forayTopic))
  );
}

/**
 * The gate itself, stated once so tier 1 and tier 2 cannot drift apart.
 *
 * FAILS CLOSED when the candidate's nodes are unknown, and INERT when the
 * Foray's own topic is unknown. The asymmetry is deliberate: a caller with no
 * resolved topic (a direct `sourceBeats` call, a test) gets exactly the old
 * behaviour, while a real run — which always has a resolved topic, since
 * `runPipeline.ts` now resolves it before sourcing — never anchors to tape
 * whose subject it cannot establish. "I could not tell" is not evidence that
 * the tape is on topic.
 */
export function familyGateAllows(forayTopic: string | null, candidateNodes: string[], root: string = REPO_ROOT): boolean {
  if (!forayTopic) return true;
  if (candidateNodes.length === 0) return false;
  return inLineage(forayTopic, candidateNodes, root);
}

/**
 * The same judgement, REPORTED rather than enforced, in the three-valued shape
 * WS-B's `TapeAnchorNote.onTopic` uses: `null` means nothing could be
 * established (excluded from the metric's numerator AND denominator), never
 * "fine".
 */
export function isOnTopic(forayTopic: string | null, candidateNodes: string[], root: string = REPO_ROOT): boolean | null {
  if (!forayTopic || candidateNodes.length === 0) return null;
  return inLineage(forayTopic, candidateNodes, root);
}
