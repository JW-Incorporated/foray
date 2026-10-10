/* Taxonomy node terms and per-episode topics from the corpus (PKG-29, G-13;
   docs/roadmap/corpus.md §3 "PKG-29 · topics.mjs").

   WHAT IT DOES. PKG-26 (backend/src/cli/buildCorpusTerms.ts) writes, per
   transcribed episode, its top tf-idf terms (`episode-terms.jsonl`) and one
   corpus-wide df table (`corpus-df.json`). This module turns those into:

     1. a `terms[]` list on every node of data/taxonomy.json — the vocabulary
        that episodes labelled with the node actually use, plus the node's own
        label and apple_anchor words so that no node is empty; and
     2. data/episode-topics.json — for every episode, the nodes whose term
        vector its own terms match at cosine >= τ, and the SHOWS whose episodes
        spread too widely for a show label to mean anything (`general_shows`).

   NEVER THE SHOW'S LABEL. An episode below τ gets `[]`. It does not fall back
   to its show's taxonomy_node_ids or to its discover item's topics: inheriting
   the show label is the #547 defect this whole step exists to replace.

   THE RULE IS PKG-28'S, AND ITS NUMBERS ARE PROVISIONAL. K, the node-share
   cut, τ, the per-episode cap and the general-show thresholds all come from
   ./topic-constants.mjs. Until PKG-28 writes docs/curation/episode-topics-rule.md
   and sets PROVISIONAL to false, `--write` is refused and τ has no default —
   pass `--tau` for a dry run. Choices this module had to make that the rule
   doc may overturn (each is one line to change):
     - "present in > 30 % of nodes" counts a term once per node whose evidence
       (summed over its labelled episodes) contains it, over ALL taxonomy nodes;
     - a node's vector weights its evidence terms by summed tf-idf / its top
       score, and its seed words (label + apple_anchor tokens) by idf / the
       rarest possible idf, so a seed like "science" weighs less than "tokamak";
     - a node's existing `terms` are kept, first and in order: this tool only
       ADDS terms, so the hand-written phrases on engineering/ai-robotics and
       engineering/energy-fusion survive and a rerun on the same inputs is a
       no-op. Removing a term is a hand edit;
     - at most MAX_NODES_PER_EPISODE nodes are assigned by cosine; each one's
       ancestors are then added and do not count towards the cap;
     - a show is general when its episodes with any topic span
       >= GENERAL_MIN_ROOTS root nodes and no root holds > GENERAL_MAX_SHARE
       of them.

   THE JOIN. An episode-terms line is keyed `<show_id>|<guid>`, show_id being
   foray's (a data/catalog.json slug, or String(apple_collection_id) for a
   breadth show — PKG-12's rule). A discover item is joined to it through its
   apple_collection_id (catalog.json maps that to the slug) and its guid:
   `episode_guid` when the item carries one, else the data/episode-archive.json.gz
   episode of the same show whose enclosure URL is the item's audio_url, else
   the one with the same title. Items that join are the evidence for their
   nodes; the rest contribute nothing.

   THE SEED WORDS USE THE INDEX'S TOKENIZER RULES. A seed only ever matches a
   corpus term, and corpus terms come from catalogueLookup.ts's
   tokenizeForSourcing. Its two stopword lists and resolveTopic.ts's
   GENERIC_LABEL_WORDS are READ from the backend source (never copied), and
   the split rule (lowercase, /[^a-z0-9]+/, length > 2) is checked against
   that source before it is used, so a change there fails loudly here.

   Writes: data/taxonomy.json (only `terms` changes — every other byte is kept;
   the result is re-parsed and compared before it is written) and
   data/episode-topics.json (sorted keys). Both only with --write, and the data
   write is its own PR (PKG-29's data PR, after PKG-30). No model call, no
   network.

   CLI: node tools/foraycorpus-export/topics.mjs --terms <episode-terms.jsonl>
        --df <corpus-df.json> [--tau <n>] [--sample <n>] [--write]
        [--taxonomy <file>] [--discover <file>] [--catalog <file>]
        [--archive <file.json.gz>] [--out <file>] */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { isEntryScript } from "../ci/entry.mjs";

import { writeJsonAtomic } from "../segments/sweep-transcripts.mjs";
import { ROOT } from "./config.mjs";
import * as C from "./topic-constants.mjs";

export const RULE_DOC = "docs/curation/episode-topics-rule.md";
export const DEFAULT_OUT = join(ROOT, "data", "episode-topics.json");

export class TopicsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/* ---------------------------------------------------------------- words */

/** The string members of `const <name> = new Set([...])` in a source file. */
export function wordSetFromSource(src, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(src);
  if (!m) throw new TopicsError("WORDS_NOT_FOUND", `${name} = new Set([...]) not found`);
  return new Set([...m[1].matchAll(/"([^"\\]*)"/g)].map((x) => x[1]));
}

/** The index tokenizer's stopwords and the resolver's generic label words,
    read from backend/src (never copied), after checking the split rule the
    seed tokenizer below ports is still the one catalogueLookup.ts uses. */
export function loadBackendWords(root = ROOT) {
  const lookup = readFileSync(join(root, "backend", "src", "generation", "catalogueLookup.ts"), "utf8");
  const resolve = readFileSync(join(root, "backend", "src", "generation", "resolveTopic.ts"), "utf8");
  const tokenizeBody = /function tokenize\(text: string\): string\[\] \{([\s\S]*?)\n\}/.exec(lookup)?.[1] ?? "";
  if (!tokenizeBody.includes(".toLowerCase()") || !tokenizeBody.includes(".split(/[^a-z0-9]+/)") || !tokenizeBody.includes("w.length > 2")) {
    throw new TopicsError("TOKENIZER_CHANGED", "catalogueLookup.ts tokenize() no longer lowercases, splits on /[^a-z0-9]+/ and keeps length > 2; re-port seedTokens()");
  }
  const stopwords = new Set([...wordSetFromSource(tokenizeBody, "STOPWORDS"), ...wordSetFromSource(lookup, "SOURCING_STOPWORDS")]);
  return { stopwords, generic: wordSetFromSource(resolve, "GENERIC_LABEL_WORDS") };
}

/** A node's own words, by the index tokenizer's rules, minus generic label words. */
export function seedTokens(text, { stopwords = new Set(), generic = new Set() } = {}) {
  const out = [];
  for (const w of String(text ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length > 2 && !stopwords.has(w) && !generic.has(w) && !out.includes(w)) out.push(w);
  }
  return out;
}

/** PKG-26's idf (BM25's), so seeds and episode terms rank rarity the same way. */
function idf(n, docs) {
  return Math.log(1 + (docs - n + 0.5) / (n + 0.5));
}

/* ---------------------------------------------------------------- join */

export const episodeKey = (showId, guid) => `${showId}|${guid}`;

/** String(apple_collection_id) -> foray show_id for every curated catalog show. */
export function showMapFromCatalog(catalog) {
  const map = new Map();
  for (const s of catalog?.shows ?? []) {
    if (s?.show_id && s.apple_collection_id != null) map.set(String(s.apple_collection_id), s.show_id);
  }
  return map;
}

/** Foray's show_id for a discover item: the catalog slug, else the breadth convention. */
export function showIdForItem(item, showMap) {
  if (item?.apple_collection_id == null) return null;
  const apple = String(item.apple_collection_id);
  return showMap.get(apple) ?? apple;
}

/** discover item id -> episode guid: `episode_guid`, else the archive episode
    of the same show with the item's audio URL, else the one with its title. */
export function discoverGuids({ discover, archive }) {
  const byShow = new Map();
  for (const s of archive?.shows ?? []) byShow.set(String(s.apple_collection_id), s.episodes ?? []);
  const out = new Map();
  for (const item of discover?.items ?? []) {
    if (item.episode_guid) {
      out.set(item.id, item.episode_guid);
      continue;
    }
    const eps = byShow.get(String(item.apple_collection_id)) ?? [];
    const byUrl = item.audio_url ? eps.filter((e) => e.guid && e.enclosure_url === item.audio_url) : [];
    const byTitle = eps.filter((e) => e.guid && e.title?.trim() === item.title?.trim());
    const hit = byUrl.length === 1 ? byUrl[0] : byTitle.length === 1 ? byTitle[0] : null;
    if (hit) out.set(item.id, hit.guid);
  }
  return out;
}

/* ---------------------------------------------------------------- node terms */

const byScoreThenTerm = (a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

/** Map nodeId -> { parent, terms: [[term, weight], …] } in taxonomy order. */
export function buildNodeTerms({
  taxonomy,
  discover,
  episodeTerms,
  showMap = new Map(),
  guids = new Map(),
  df = null,
  words = {},
  k = C.K,
  maxNodeShare = C.NODE_TERM_MAX_NODE_SHARE,
}) {
  const nodes = taxonomy.nodes;
  const known = new Set(nodes.map((n) => n.id));
  const lines = new Map(episodeTerms.map((l) => [episodeKey(l.show_id, l.guid), l]));

  const evidence = new Map();
  let joined = 0;
  for (const item of discover?.items ?? []) {
    const showId = showIdForItem(item, showMap);
    const guid = guids.get(item.id) ?? item.episode_guid;
    const line = showId && guid ? lines.get(episodeKey(showId, guid)) : undefined;
    if (!line) continue;
    joined++;
    for (const node of item.topics ?? []) {
      if (!known.has(node)) continue;
      const sums = evidence.get(node) ?? new Map();
      for (const [term, score] of line.terms ?? []) sums.set(term, (sums.get(term) ?? 0) + score);
      evidence.set(node, sums);
    }
  }

  const presence = new Map();
  for (const sums of evidence.values()) for (const term of sums.keys()) presence.set(term, (presence.get(term) ?? 0) + 1);
  const shared = new Set([...presence].filter(([, n]) => n / nodes.length > maxNodeShare).map(([t]) => t));

  const generic = words.generic ?? new Set();
  const docs = df?.docs ?? 0;
  const rarest = docs > 0 ? idf(1, docs) : 0;
  const seedWeight = (term) => (docs > 0 ? idf(df.df?.[term] ?? 1, docs) / rarest : 1);

  const nodeTerms = new Map();
  for (const node of nodes) {
    const terms = [];
    const have = new Set();
    const add = (term, weight) => {
      if (have.has(term)) return;
      have.add(term);
      terms.push([term, Math.round(weight * 10000) / 10000]);
    };
    for (const term of node.terms ?? []) add(term, 1);
    const sums = [...(evidence.get(node.id) ?? new Map())].filter(([t]) => !shared.has(t) && !generic.has(t)).sort(byScoreThenTerm).slice(0, k);
    const top = sums[0]?.[1] ?? 1;
    for (const [term, score] of sums) add(term, score / top);
    for (const term of seedTokens(`${node.label ?? ""} ${node.apple_anchor ?? ""}`, words)) add(term, seedWeight(term));
    nodeTerms.set(node.id, { parent: node.parent ?? null, terms });
  }
  return {
    nodeTerms,
    report: { items: discover?.items?.length ?? 0, joined_items: joined, nodes: nodes.length, nodes_with_evidence: evidence.size, shared_terms_dropped: [...shared].sort() },
  };
}

/* ---------------------------------------------------------------- assignment */

function norm(entries) {
  let s = 0;
  for (const [, w] of entries) s += w * w;
  return Math.sqrt(s);
}

/** Map "<show_id>|<guid>" -> { show_id, guid, topics, scores }. Below τ: `[]`. */
export function assignEpisodes({ nodeTerms, episodeTerms, tau = C.ASSIGN_COSINE_MIN, maxNodes = C.MAX_NODES_PER_EPISODE }) {
  if (typeof tau !== "number" || !Number.isFinite(tau)) {
    throw new TopicsError("NO_TAU", "τ (ASSIGN_COSINE_MIN) is not chosen yet (PKG-28); pass --tau <n> for a dry run");
  }
  const postings = new Map();
  const norms = new Map();
  for (const [id, { terms }] of nodeTerms) {
    norms.set(id, norm(terms));
    for (const [term, w] of terms) {
      const list = postings.get(term) ?? [];
      list.push([id, w]);
      postings.set(term, list);
    }
  }
  const out = new Map();
  for (const line of episodeTerms) {
    const eNorm = norm(line.terms ?? []);
    const dots = new Map();
    for (const [term, s] of line.terms ?? []) {
      for (const [id, w] of postings.get(term) ?? []) dots.set(id, (dots.get(id) ?? 0) + s * w);
    }
    const cos = new Map();
    for (const [id, dot] of dots) {
      const d = eNorm * norms.get(id);
      if (d > 0) cos.set(id, dot / d);
    }
    const picked = [...cos].filter(([, c]) => c >= tau).sort(byScoreThenTerm).slice(0, maxNodes).map(([id]) => id);
    const topics = new Set(picked);
    for (const id of picked) {
      for (let p = nodeTerms.get(id)?.parent; p && !topics.has(p); p = nodeTerms.get(p)?.parent) topics.add(p);
    }
    const sorted = [...topics].sort();
    const scores = {};
    for (const id of sorted) scores[id] = Math.round((cos.get(id) ?? 0) * 10000) / 10000;
    out.set(episodeKey(line.show_id, line.guid), { show_id: line.show_id, guid: line.guid, topics: sorted, scores });
  }
  return out;
}

/** Sorted show_ids whose assigned episodes span too many roots for a show label to mean anything. */
export function markGeneralShows({ assignments, minRoots = C.GENERAL_MIN_ROOTS, maxShare = C.GENERAL_MAX_SHARE }) {
  const perShow = new Map();
  for (const { show_id, topics } of assignments.values()) {
    if (!topics.length) continue;
    const s = perShow.get(show_id) ?? { n: 0, roots: new Map() };
    s.n++;
    for (const root of new Set(topics.map((t) => t.split("/")[0]))) s.roots.set(root, (s.roots.get(root) ?? 0) + 1);
    perShow.set(show_id, s);
  }
  const general = [];
  for (const [showId, { n, roots }] of perShow) {
    if (roots.size >= minRoots && Math.max(...roots.values()) / n <= maxShare) general.push(showId);
  }
  return general.sort();
}

/* ---------------------------------------------------------------- writers */

function writeTextAtomic(path, text) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function termsBlock(indent, terms) {
  if (!terms.length) return `${indent}"terms": [],`;
  const inner = terms.map((t) => `${indent}  ${JSON.stringify(t)}`).join(",\n");
  return `${indent}"terms": [\n${inner}\n${indent}],`;
}

/** The node with `terms` set where the file puts it: in place, else after `label`. */
function withTerms(node, terms) {
  if ("terms" in node) return { ...node, terms };
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = value;
    if (key === "label") out.terms = terms;
  }
  return out;
}

/** Sets each node's `terms` in the taxonomy FILE by editing only those lines;
    a node without `terms` gets it after `label`, where the two nodes that have
    it keep it. Every other byte is kept, and the edit is re-parsed and compared
    with the intended object before anything is written. */
export function writeTaxonomyTerms(taxonomyPath, nodeTerms) {
  const before = readFileSync(taxonomyPath, "utf8");
  const nl = before.includes("\r\n") ? "\r\n" : "\n";
  let text = before.replace(/\r\n/g, "\n");
  const intended = JSON.parse(text);
  let changed = 0;
  for (const [i, node] of intended.nodes.entries()) {
    const entry = nodeTerms.get(node.id);
    if (!entry) continue;
    const terms = entry.terms.map(([t]) => t);
    if (JSON.stringify(node.terms ?? null) === JSON.stringify(terms)) continue;
    const idLine = new RegExp(`\\n( *)"id": ${JSON.stringify(node.id).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")},\\n`).exec(text);
    if (!idLine) throw new TopicsError("TAXONOMY_LAYOUT", `node ${node.id}: no "id" line in the expected layout`);
    const indent = idLine[1];
    const start = idLine.index + 1;
    const end = text.indexOf(`\n${indent.slice(2)}}`, start);
    if (end < 0) throw new TopicsError("TAXONOMY_LAYOUT", `node ${node.id}: no closing brace at the expected indent`);
    let block = text.slice(start, end);
    const existing = new RegExp(`^${indent}"terms": (?:\\[\\],?|\\[[\\s\\S]*?^${indent}\\],?)$`, "m");
    if (existing.test(block)) {
      block = block.replace(existing, (m) => termsBlock(indent, terms).slice(0, m.endsWith(",") ? undefined : -1));
    } else {
      const label = new RegExp(`^${indent}"label": .*,$`, "m").exec(block);
      if (!label) throw new TopicsError("TAXONOMY_LAYOUT", `node ${node.id}: no "label" line to put terms after`);
      const at = label.index + label[0].length;
      block = `${block.slice(0, at)}\n${termsBlock(indent, terms)}${block.slice(at)}`;
    }
    text = text.slice(0, start) + block + text.slice(end);
    intended.nodes[i] = withTerms(node, terms);
    changed++;
  }
  if (JSON.stringify(JSON.parse(text)) !== JSON.stringify(intended)) {
    throw new TopicsError("TAXONOMY_LAYOUT", "the edited taxonomy does not parse to the intended object; not written");
  }
  if (changed) writeTextAtomic(taxonomyPath, nl === "\n" ? text : text.replace(/\n/g, nl));
  return { changed };
}

/** The episode-topics document, episodes and their scores in sorted key order. */
export function episodeTopicsDoc(assignments, { generalShows = [], builtAt = new Date().toISOString() } = {}) {
  const episodes = {};
  for (const key of [...assignments.keys()].sort()) {
    const { topics, scores } = assignments.get(key);
    const sortedScores = {};
    for (const id of Object.keys(scores).sort()) sortedScores[id] = scores[id];
    episodes[key] = { topics: [...topics].sort(), scores: sortedScores };
  }
  return { version: 1, built_at: builtAt, rule: RULE_DOC, episodes, general_shows: [...generalShows].sort() };
}

export function writeEpisodeTopics(path, assignments, opts = {}) {
  writeJsonAtomic(path, episodeTopicsDoc(assignments, opts));
}

/* ---------------------------------------------------------------- CLI */

export function readEpisodeTerms(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

export function main(argv, { provisional = C.PROVISIONAL, root = ROOT, log = console.log } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      terms: { type: "string" },
      df: { type: "string" },
      tau: { type: "string" },
      sample: { type: "string" },
      write: { type: "boolean", default: false },
      taxonomy: { type: "string" },
      discover: { type: "string" },
      catalog: { type: "string" },
      archive: { type: "string" },
      out: { type: "string" },
    },
    strict: true,
  });
  if (!values.terms || !values.df) {
    throw new TopicsError("USAGE", "node topics.mjs --terms <episode-terms.jsonl> --df <corpus-df.json> [--tau <n>] [--sample <n>] [--write]");
  }
  if (values.write && provisional) {
    throw new TopicsError("PROVISIONAL", "topic-constants.mjs is PROVISIONAL (PKG-28 has not set the rule's numbers); --write refused, nothing written");
  }
  const data = (f) => join(root, "data", f);
  const taxonomyPath = values.taxonomy ?? data("taxonomy.json");
  const archivePath = values.archive ?? data("episode-archive.json.gz");
  const taxonomy = readJson(taxonomyPath);
  const discover = readJson(values.discover ?? data("discover.json"));
  const archive = existsSync(archivePath) ? JSON.parse(gunzipSync(readFileSync(archivePath))) : null;
  const episodeTerms = readEpisodeTerms(values.terms);
  const df = readJson(values.df);
  const { nodeTerms, report } = buildNodeTerms({
    taxonomy,
    discover,
    episodeTerms,
    showMap: showMapFromCatalog(readJson(values.catalog ?? data("catalog.json"))),
    guids: discoverGuids({ discover, archive }),
    df,
    words: loadBackendWords(root),
  });
  const tau = values.tau !== undefined ? Number(values.tau) : C.ASSIGN_COSINE_MIN;
  const assignments = assignEpisodes({ nodeTerms, episodeTerms, tau });
  const generalShows = markGeneralShows({ assignments });
  const assigned = [...assignments.values()].filter((a) => a.topics.length).length;
  log(JSON.stringify({
    provisional, tau, ...report,
    shared_terms_dropped: report.shared_terms_dropped.length,
    episodes: assignments.size, episodes_assigned: assigned, episodes_unassigned: assignments.size - assigned,
    general_shows: generalShows,
  }, null, 2));
  const sample = Number(values.sample ?? 0);
  if (sample > 0) {
    const termsByKey = new Map(episodeTerms.map((l) => [episodeKey(l.show_id, l.guid), l.terms]));
    for (const key of [...assignments.keys()].sort().slice(0, sample)) {
      const a = assignments.get(key);
      log(JSON.stringify({ key, top_terms: (termsByKey.get(key) ?? []).slice(0, 10).map(([t]) => t), topics: a.topics, scores: a.scores }));
    }
  }
  if (!values.write) return { written: false };
  const { changed } = writeTaxonomyTerms(taxonomyPath, nodeTerms);
  writeEpisodeTopics(values.out ?? DEFAULT_OUT, assignments, { generalShows });
  return { written: true, taxonomy_nodes_changed: changed };
}

if (isEntryScript(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error("FATAL:", e?.message ?? e);
    process.exit(1);
  }
}
