/* Foray supply per rating persona (RV-22, docs/roadmap/recommender-v1.md, #1380).

   A REPORT, NOT A RANKING CHANGE. For each rating persona it lists the
   taxonomy nodes its well-fitting shows cover that also have timed-transcript
   supply and no published Foray -- candidate prompts for the founder-authored
   catalogue lane (`tools/generation/start-run.mjs --prompts`, GV-81). Nothing
   here starts a run, publishes a Foray or edits data/forays.json; it prints.

     node tools/recommender/foray-supply.mjs [--top 10] [--json] [--root <dir>]
       [--ratings <path>] [--catalog <path>] [--breadth <path>]
       [--availability <path>] [--yield <path>] [--forays <path>]

   THE THREE NUMBERS PER NODE
   - weight: per persona, sum(fit - 3) over the rated shows in
     data/recommender/ratings.json (slot 0 of RATING_SLOTS) that carry the node.
     3 is the rubric's "would listen when nothing better is on", so a node only
     earns weight from shows the persona rates above indifference, and a node
     its shows are rated below 3 on goes negative. Only weight > 0 is a
     candidate.
   - supply: `episodes_with_timed_transcript` per show, from
     data/transcript-availability.json (curated, keyed show_id) and
     data/breadth-transcript-yield.json (breadth, keyed by Apple id), summed
     over every show carrying the node -- rated or not, since a Foray cuts from
     any show with timed transcripts. A curated show that also appears in the
     breadth sweep counts once (the larger of its two counts).
   - published: the `topic` of every data/forays.json row whose status is
     PUBLISHED -- the constant and the row reader are imported from
     player/foray-resolve.js, the module that decides what a visitor sees, so
     this report and the app cannot disagree about what "published" means.
     A draft does not remove a node: it is not supply a listener can reach.

   Node ids are matched exactly (a published Foray on `engineering/ai-robotics`
   does not cover the root `engineering`). A show's nodes are its curated
   `taxonomy_node_ids` when non-empty, else its breadth row's -- the order
   evidence.mjs uses.

   Offline only: reads committed JSON, writes nothing (no file under data/ is
   written; stdout only), calls no model and no network. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";
import { allForays, PUBLISHED } from "../../player/foray-resolve.js";
import { RATING_SLOTS } from "./schema.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The rubric's indifference point: fit above it adds weight, below it subtracts. */
export const NEUTRAL_FIT = 3;
const FIT_SLOT = RATING_SLOTS.indexOf("fit");

export const DEFAULT_TOP = 10;

export const PATHS = Object.freeze({
  ratings: "data/recommender/ratings.json",
  catalog: "data/catalog.json",
  breadth: "data/catalog-breadth.json",
  availability: "data/transcript-availability.json",
  yield: "data/breadth-transcript-yield.json",
  forays: "data/forays.json",
});

const nodeList = (v) => (Array.isArray(v) ? v.filter((n) => typeof n === "string" && n.trim() !== "") : []);
const acidOf = (v) => (v == null || v === "" ? null : String(v));

/* ------------------------------------------------------------ node index */

/**
 * show key -> taxonomy node ids, plus the Apple-id -> curated show_id alias
 * map, from the curated catalogue and the breadth catalogue.
 * @returns {{ nodesOf: (key: string) => string[], canonicalKey: (key: string) => string }}
 */
export function buildNodeIndex({ catalog = { shows: [] }, breadth = { shows: [] } } = {}) {
  const curated = new Map();
  const curatedByAcid = new Map();
  for (const row of catalog?.shows ?? []) {
    if (!row || row.show_id == null) continue;
    curated.set(String(row.show_id), row);
    const acid = acidOf(row.apple_collection_id);
    if (acid) curatedByAcid.set(acid, String(row.show_id));
  }
  const breadthByAcid = new Map();
  for (const row of breadth?.shows ?? []) {
    const acid = acidOf(row?.apple_collection_id);
    if (acid) breadthByAcid.set(acid, row);
  }
  const canonicalKey = (key) => {
    const k = String(key);
    if (curated.has(k)) return k;
    return curatedByAcid.get(k) ?? k;
  };
  const nodesOf = (key) => {
    const k = canonicalKey(key);
    const cur = curated.get(k);
    const own = nodeList(cur?.taxonomy_node_ids);
    if (own.length) return [...new Set(own)];
    const acid = cur ? acidOf(cur.apple_collection_id) : k;
    return [...new Set(nodeList(acid ? breadthByAcid.get(acid)?.taxonomy_node_ids : null))];
  };
  return { nodesOf, canonicalKey };
}

/* --------------------------------------------------------------- weights */

/**
 * Per persona, node -> { weight, shows } where weight = sum(fit - 3) over the
 * rated shows carrying the node and shows counts them. A persona slot whose
 * fit is not a number (unrated) contributes nothing.
 * @returns {Map<string, Map<string, { weight: number, shows: number }>>}
 */
export function personaNodeWeights(ratings, nodesOf) {
  const out = new Map();
  for (const [key, show] of Object.entries(ratings?.shows ?? {})) {
    const nodes = nodesOf(key);
    if (!nodes.length) continue;
    for (const [personaId, slots] of Object.entries(show?.personas ?? {})) {
      const fit = Array.isArray(slots) ? slots[FIT_SLOT] : null;
      if (typeof fit !== "number" || !Number.isFinite(fit)) continue;
      if (!out.has(personaId)) out.set(personaId, new Map());
      const byNode = out.get(personaId);
      for (const node of nodes) {
        const cell = byNode.get(node) ?? { weight: 0, shows: 0 };
        cell.weight += fit - NEUTRAL_FIT;
        cell.shows += 1;
        byNode.set(node, cell);
      }
    }
  }
  return out;
}

/* ---------------------------------------------------------------- supply */

const timedCount = (row) => {
  const n = row?.episodes_with_timed_transcript;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * node -> { episodes, shows }: timed-transcript episodes summed over the shows
 * carrying the node, each show counted once across the two supply files.
 * @returns {Map<string, { episodes: number, shows: number }>}
 */
export function supplyByNode({ availability = { shows: [] }, yieldDoc = { shows: [] } } = {}, { nodesOf, canonicalKey }) {
  const perShow = new Map();
  const add = (key, n) => {
    if (key == null || !n) return;
    const k = canonicalKey(String(key));
    perShow.set(k, Math.max(perShow.get(k) ?? 0, n));
  };
  for (const row of availability?.shows ?? []) add(row?.show_id ?? acidOf(row?.apple_collection_id), timedCount(row));
  for (const row of yieldDoc?.shows ?? []) add(acidOf(row?.apple_collection_id) ?? row?.show_id, timedCount(row));

  const out = new Map();
  for (const [key, episodes] of perShow) {
    for (const node of nodesOf(key)) {
      const cell = out.get(node) ?? { episodes: 0, shows: 0 };
      cell.episodes += episodes;
      cell.shows += 1;
      out.set(node, cell);
    }
  }
  return out;
}

/* ------------------------------------------------------------- published */

/** The taxonomy nodes that already have a published Foray (by `topic`). */
export function publishedNodes(foraysDoc) {
  const out = new Set();
  for (const foray of allForays(foraysDoc)) {
    if (foray.status === PUBLISHED && typeof foray.topic === "string" && foray.topic.trim() !== "") out.add(foray.topic);
  }
  return out;
}

/* ---------------------------------------------------------------- report */

const round1 = (x) => Math.round(x * 10) / 10;

/**
 * The report: per persona (sorted by id), candidate nodes with weight > 0,
 * supply > 0 and no published Foray, by weight then supply then node id,
 * at most `top` of them.
 */
export function supplyReport({ ratings, catalog, breadth, availability, yieldDoc, forays }, { top = DEFAULT_TOP } = {}) {
  const index = buildNodeIndex({ catalog, breadth });
  const weights = personaNodeWeights(ratings, index.nodesOf);
  const supply = supplyByNode({ availability, yieldDoc }, index);
  const published = publishedNodes(forays);

  const personas = [...weights.keys()].sort().map((personaId) => {
    const candidates = [];
    let excludedPublished = 0;
    for (const [node, { weight, shows }] of weights.get(personaId)) {
      if (!(weight > 0)) continue;
      const s = supply.get(node);
      if (!s || !(s.episodes > 0)) continue;
      if (published.has(node)) {
        excludedPublished += 1;
        continue;
      }
      candidates.push({ node, weight: round1(weight), rated_shows: shows, supply_episodes: s.episodes, supply_shows: s.shows });
    }
    candidates.sort((a, b) => b.weight - a.weight || b.supply_episodes - a.supply_episodes || (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
    return { persona_id: personaId, candidate_count: candidates.length, excluded_published: excludedPublished, candidates: candidates.slice(0, top) };
  });

  return {
    rated_shows: Object.keys(ratings?.shows ?? {}).length,
    published_nodes: [...published].sort(),
    top,
    personas,
  };
}

export function renderMarkdown(report) {
  const lines = [];
  lines.push("# Foray supply per persona");
  lines.push("");
  lines.push(
    `Candidate prompts for the catalogue lane (\`tools/generation/start-run.mjs --prompts\`): nodes with positive persona weight (sum of fit - ${NEUTRAL_FIT} over ${report.rated_shows} rated shows), timed-transcript supply, and no published Foray. Published nodes excluded: ${report.published_nodes.length ? report.published_nodes.map((n) => `\`${n}\``).join(", ") : "none"}.`,
  );
  for (const p of report.personas) {
    lines.push("");
    lines.push(`## ${p.persona_id}`);
    lines.push("");
    if (!p.candidates.length) {
      lines.push("No candidate node.");
      continue;
    }
    lines.push("| node | weight | rated shows | timed episodes | shows with supply |");
    lines.push("|---|---:|---:|---:|---:|");
    for (const c of p.candidates) {
      lines.push(`| \`${c.node}\` | ${c.weight} | ${c.rated_shows} | ${c.supply_episodes} | ${c.supply_shows} |`);
    }
    if (p.candidate_count > p.candidates.length) lines.push("", `${p.candidate_count - p.candidates.length} more not shown (--top ${report.top}).`);
  }
  return lines.join("\n") + "\n";
}

/* ------------------------------------------------------------------- CLI */

export class UsageError extends Error {}

const PATH_FLAGS = Object.freeze({ "--ratings": "ratings", "--catalog": "catalog", "--breadth": "breadth", "--availability": "availability", "--yield": "yield", "--forays": "forays" });

export function parseArgs(argv) {
  const args = { json: false, top: DEFAULT_TOP, root: null, paths: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v == null || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
      return v;
    };
    if (a === "--json") args.json = true;
    else if (a === "--top") {
      const n = Number(next());
      if (!Number.isInteger(n) || n < 1) throw new UsageError("--top must be a positive integer");
      args.top = n;
    } else if (a === "--root") args.root = next();
    else if (Object.hasOwn(PATH_FLAGS, a)) args.paths[PATH_FLAGS[a]] = next();
    else throw new UsageError(`unknown argument: ${a}`);
  }
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function main(argv = process.argv.slice(2), { root = ROOT, stdout = (s) => process.stdout.write(s), stderr = (s) => process.stderr.write(s) } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      stderr(`foray-supply: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
  const base = args.root ? path.resolve(args.root) : root;
  const fileOf = (name) => (args.paths[name] ? path.resolve(args.paths[name]) : path.join(base, PATHS[name]));
  let inputs;
  try {
    inputs = {
      ratings: readJson(fileOf("ratings")),
      catalog: readJson(fileOf("catalog")),
      breadth: readJson(fileOf("breadth")),
      availability: readJson(fileOf("availability")),
      yieldDoc: readJson(fileOf("yield")),
      forays: readJson(fileOf("forays")),
    };
  } catch (e) {
    stderr(`foray-supply: ${e.message}\n`);
    return 1;
  }
  const report = supplyReport(inputs, { top: args.top });
  stdout(args.json ? JSON.stringify(report, null, 2) + "\n" : renderMarkdown(report));
  return 0;
}

if (isEntryScript(import.meta.url)) {
  process.exitCode = main();
}
