/* select.mjs — proposes the golden set's strata from committed data (GV-45, W1-14).
 *
 * WHAT IT IS FOR (docs/roadmap/generation-v2.md, card GV-45; #1286, R2-02)
 * The golden set is the fixed benchmark every later generation change is
 * judged on. Its prompts are stratified by how much tape the archive holds for
 * them, because a pipeline change can help a well-stocked subject and hurt a
 * thin one, and an unstratified average hides exactly that. This script does
 * the counting; the implementing agent wrote the prompt text (golden-v1.json)
 * from the node labels it proposes and the historical prompts. No model is
 * called, nothing is fetched, and nothing here reads or prints transcript
 * text: the output is node ids, node labels, show ids and counts.
 *
 * WHAT IT COUNTS
 * For every node in data/taxonomy.json, the shows and the usable digest rows
 * in the node's FAMILY — the node, its ancestors and its descendants — the
 * same lineage backend/src/generation/taxonomyFamily.ts gates tape on
 * (`familyGateAllows`), so a count here is a count of what sourcing may use:
 *   - rows come from data/transcript-digests.json and
 *     data/breadth-transcript-digests.json; a row counts when it has cues
 *     (a failed fetch or a body that normalised to nothing is not tape);
 *   - a show's nodes come from data/catalog.json `taxonomy_node_ids` by
 *     show_id, and, for a numeric (Apple collection) show id the curated
 *     catalogue does not carry, from data/breadth-classification.json
 *     `entries[id].topics` — taxonomyNodesForShowId's two joins, in its order;
 *   - catalogShows is how many curated-catalogue shows sit in the family,
 *     transcribed or not: a node with catalogue shows but no transcripts is
 *     the "near" in near-no-supply (tape exists, nothing has transcribed it).
 *
 * THE STRATA (counts on the committed data, not on any one machine's disk)
 *   multi-show      >= 2 shows in the family
 *   single-show     exactly 1 show, with >= MIN_TOPIC_SUPPLY usable rows
 *   near-no-supply  fewer than MIN_TOPIC_SUPPLY usable rows (the pipeline's own
 *                   bar: backend/src/generation/topicSupply.ts MIN_TOPIC_SUPPLY)
 *   ambiguous       not a count: a prompt with two readings. Proposed here as
 *                   label words shared by nodes under different roots, ranked
 *                   by how many of those readings have supply.
 * Target split 30 / 10 / 5 / 5 (decision 25, the orchestrator's default).
 *
 * DETERMINISM
 * Every list is sorted by a total order, and the input files' sha256 values
 * are part of the output, so the same committed data always gives the same
 * bytes and a reader can tell which data a proposal was made from.
 *
 * USAGE
 *   node tools/generation-bench/golden/select.mjs            # JSON to stdout
 *   node tools/generation-bench/golden/select.mjs --out <file>
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../../ci/entry.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

export const STRATA = ["multi-show", "single-show", "ambiguous", "near-no-supply"];
/** Decision 25: 30 / 10 / 5 / 5 (R2's 25/10/5/5 sums to 45, not 50). */
export const STRATA_TARGETS = { "multi-show": 30, "single-show": 10, ambiguous: 5, "near-no-supply": 5 };
/** Mirrors backend/src/generation/topicSupply.ts MIN_TOPIC_SUPPLY: below this
 * many usable transcripts the pipeline treats a topic as having no supply. */
export const MIN_TOPIC_SUPPLY = 3;

/** The committed files a proposal is made from, repo-relative. */
export const INPUT_FILES = {
  taxonomy: "data/taxonomy.json",
  catalog: "data/catalog.json",
  digests: "data/transcript-digests.json",
  breadthDigests: "data/breadth-transcript-digests.json",
  breadthClassification: "data/breadth-classification.json"
};

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Reads the committed inputs. Returns plain data plus each file's sha256. */
export function loadInputs(root = REPO_ROOT) {
  const raw = {};
  const shas = {};
  for (const [key, rel] of Object.entries(INPUT_FILES)) {
    const bytes = fs.readFileSync(path.join(root, rel));
    shas[rel] = sha256(bytes);
    raw[key] = JSON.parse(bytes.toString("utf8"));
  }
  const breadthNodes = {};
  for (const [id, entry] of Object.entries(raw.breadthClassification.entries ?? {})) {
    if (Array.isArray(entry?.topics)) breadthNodes[id] = entry.topics.filter((n) => typeof n === "string");
  }
  return {
    nodes: raw.taxonomy.nodes.map((n) => ({ id: n.id, parent: n.parent ?? null, label: n.label })),
    catalogShows: raw.catalog.shows.map((s) => ({ show_id: s.show_id, taxonomy_node_ids: s.taxonomy_node_ids ?? [] })),
    digestRows: [...(raw.digests.transcripts ?? []), ...(raw.breadthDigests.transcripts ?? [])].map((r) => ({
      show_id: String(r.show_id),
      cues: typeof r.cues === "number" ? r.cues : 0
    })),
    breadthNodes,
    shas
  };
}

/** node id -> the node's family (itself, ancestors, descendants), as taxonomyFamily.ts buildLineages. */
export function buildFamilies(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ancestorsOf = new Map();
  for (const node of nodes) {
    const chain = [];
    const seen = new Set([node.id]);
    let cursor = node;
    while (cursor?.parent && !seen.has(cursor.parent)) {
      chain.push(cursor.parent);
      seen.add(cursor.parent);
      cursor = byId.get(cursor.parent);
    }
    ancestorsOf.set(node.id, chain);
  }
  const families = new Map();
  for (const node of nodes) families.set(node.id, new Set([node.id, ...ancestorsOf.get(node.id)]));
  for (const node of nodes) for (const a of ancestorsOf.get(node.id)) families.get(a)?.add(node.id);
  return families;
}

/** A show's nodes: the curated catalogue first, the breadth classification
 * for a numeric id only (taxonomyNodesForShowId's order). */
export function showNodes(showId, inputs) {
  const curated = inputs.catalogShows.find((s) => s.show_id === showId);
  if (curated && curated.taxonomy_node_ids.length > 0) return curated.taxonomy_node_ids;
  if (/^\d+$/.test(showId)) return inputs.breadthNodes[showId] ?? [];
  return [];
}

/** The stratum a family's counts put a node in (never 'ambiguous'). */
export function stratumForCounts({ shows, rows }) {
  if (rows < MIN_TOPIC_SUPPLY) return "near-no-supply";
  return shows >= 2 ? "multi-show" : "single-show";
}

/**
 * Per node: { id, label, shows: [show ids], rows, catalogShows, stratum }.
 * Sorted by node id. `unmappedShows` lists digest shows no join places on any
 * node (their rows count nowhere, as the gate refuses them).
 */
export function countSupply(inputs) {
  const families = buildFamilies(inputs.nodes);
  const rowsByShow = new Map();
  for (const row of inputs.digestRows) {
    if (!(row.cues > 0)) continue;
    rowsByShow.set(row.show_id, (rowsByShow.get(row.show_id) ?? 0) + 1);
  }
  const nodesByShow = new Map([...rowsByShow.keys()].map((id) => [id, showNodes(id, inputs)]));
  const unmappedShows = [...nodesByShow].filter(([, nodes]) => nodes.length === 0).map(([id]) => id).sort();
  const curatedNodes = inputs.catalogShows.map((s) => s.taxonomy_node_ids);

  const rows = inputs.nodes.map((node) => {
    const family = families.get(node.id);
    const shows = [...nodesByShow].filter(([, nodes]) => nodes.some((n) => family.has(n))).map(([id]) => id).sort();
    const rowCount = shows.reduce((sum, id) => sum + rowsByShow.get(id), 0);
    const catalogShows = curatedNodes.filter((nodes) => nodes.some((n) => family.has(n))).length;
    return {
      id: node.id,
      label: node.label,
      shows,
      rows: rowCount,
      catalogShows,
      stratum: stratumForCounts({ shows: shows.length, rows: rowCount })
    };
  });
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { nodes: rows, unmappedShows };
}

const STOP_WORDS = new Set(["and", "the", "of", "&"]);

/**
 * Ambiguous-prompt seeds: a word in two or more node labels under DIFFERENT
 * roots ("science" in food/cooking-science and nature/earth-science), so a
 * prompt built on it has two readings the clarity check should notice.
 * Ranked by readings with supply (desc), then word.
 */
export function ambiguousCandidates(nodes, supplyById) {
  const byWord = new Map();
  for (const node of nodes) {
    const words = new Set(
      node.label
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter((w) => w.length > 3 && !STOP_WORDS.has(w))
    );
    for (const w of words) {
      if (!byWord.has(w)) byWord.set(w, []);
      byWord.get(w).push(node.id);
    }
  }
  const out = [];
  for (const [word, ids] of byWord) {
    const roots = new Set(ids.map((id) => id.split("/")[0]));
    if (roots.size < 2) continue;
    const readings = [...ids].sort();
    const supplied = readings.filter((id) => (supplyById.get(id)?.rows ?? 0) >= MIN_TOPIC_SUPPLY);
    out.push({ word, readings, suppliedReadings: supplied });
  }
  out.sort((a, b) => b.suppliedReadings.length - a.suppliedReadings.length || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));
  return out;
}

/** The whole proposal: deterministic for the same inputs. */
export function propose(inputs) {
  const { nodes, unmappedShows } = countSupply(inputs);
  const supplyById = new Map(nodes.map((n) => [n.id, n]));
  const byStratum = (s) =>
    nodes
      .filter((n) => n.stratum === s)
      .sort((a, b) => b.rows - a.rows || b.catalogShows - a.catalogShows || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((n) => ({ id: n.id, label: n.label, shows: n.shows.length, rows: n.rows, catalogShows: n.catalogShows }));
  return {
    version: 1,
    inputs: Object.fromEntries(Object.entries(inputs.shas).sort()),
    minTopicSupply: MIN_TOPIC_SUPPLY,
    targets: STRATA_TARGETS,
    unmappedShows,
    proposals: {
      "multi-show": byStratum("multi-show"),
      "single-show": byStratum("single-show"),
      ambiguous: ambiguousCandidates(inputs.nodes, supplyById),
      /* Near-no-supply nodes WITH catalogue shows first: tape exists, nothing
         transcribed it — the case the stratum is for. */
      "near-no-supply": byStratum("near-no-supply").filter((n) => n.catalogShows > 0)
    },
    nodes
  };
}

export function main(argv = process.argv.slice(2), { root = REPO_ROOT, stdout = process.stdout } = {}) {
  const outIdx = argv.indexOf("--out");
  const text = `${JSON.stringify(propose(loadInputs(root)), null, 2)}\n`;
  if (outIdx >= 0) {
    const out = argv[outIdx + 1];
    if (!out) throw new Error("--out needs a file path");
    fs.writeFileSync(path.resolve(out), text);
  } else {
    stdout.write(text);
  }
  return 0;
}

if (isEntryScript(import.meta.url)) process.exitCode = main();
