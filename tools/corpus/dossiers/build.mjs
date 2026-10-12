#!/usr/bin/env node
/* Offline topic dossiers, code-built (GV-30, W3-19, docs/roadmap/generation-v2.md).
 *
 * For each taxonomy node (or --subjects entry): fetch its seed pages through
 * the corpus's polite fetcher (createFetcher: robots.txt enforced, honest
 * CORPUS_UA, >= 2 s per host, retries, plus the cross-process host gate),
 * extract with extract.mjs, cut verbatim passages (passages.mjs), and write
 *
 *   data-local/dossiers/<safe-node-id>.json   one dossier (schema.mjs)
 *   data-local/dossiers/manifest.json         node -> file, sha256, counts
 *
 * There is NO model anywhere in this path: the text is what the page says,
 * cut by code. Relevance ranking is left to the backend's tokenizer at request
 * time (GV-69), so passages are kept in document order, at most
 * MAX_PASSAGES_PER_NODE per node. A 404, a robots.txt refusal or a page that
 * yields no passage is recorded on the node as `missing`. Nothing fetched is
 * committed: data-local/ is gitignored.
 *
 *   node tools/corpus/dossiers/build.mjs --all
 *   node tools/corpus/dossiers/build.mjs --node engineering/energy-fusion
 *   node tools/corpus/dossiers/build.mjs --subjects subjects.json
 *     [--out <dir>] [--seeds <file>] [--taxonomy <file>]
 *
 * Nothing reads dossiers until FORAY_STAGE_RESEARCH=dossier (GV-69).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createFetcher } from "../fetcher.mjs";
import { createHostGate } from "../hostgate.mjs";
import { htmlToMarkdown, looksLikePdf, pdfToMarkdown } from "../extract.mjs";
import { isEntryScript } from "../../ci/entry.mjs";
import { assertVerbatim, cutPassages, extractText } from "./passages.mjs";
import { DOSSIER_VERSION, validateDossier, validateManifest } from "./schema.mjs";
import {
  REPO_ROOT,
  SEEDS_PATH,
  TAXONOMY_PATH,
  assertSeedUrl,
  loadSeeds,
  loadTaxonomyNodes,
  subjectTargets,
  titlesForNode,
} from "./seeds.mjs";

export const MAX_PASSAGES_PER_NODE = 120;
export const DOSSIERS_DIR = path.join(REPO_ROOT, "data-local", "dossiers");
export const MANIFEST_FILE = "manifest.json";

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** Node id -> file stem: "a/b-c" -> "a__b-c". Throws on anything that could
    leave the output directory. */
export function safeNodeId(id) {
  const s = String(id).replace(/\//g, "__").replace(/[^A-Za-z0-9_-]/g, "-");
  if (!s || /^[-_]+$/.test(s)) throw new Error(`unusable node id: ${JSON.stringify(id)}`);
  return s;
}

export function dossierPath(dir, id) {
  const full = path.resolve(dir, `${safeNodeId(id)}.json`);
  if (!full.startsWith(path.resolve(dir) + path.sep)) throw new Error(`dossier path escaped ${dir}: ${full}`);
  return full;
}

export const sourceIdFor = (url) => sha256(url).slice(0, 12);

const isWikipediaHost = (host) => host === "wikipedia.org" || host.endsWith(".wikipedia.org");

/** Publication name a print document is credited to. */
export function publicationFor(url) {
  const host = new URL(url).hostname.toLowerCase();
  if (isWikipediaHost(host)) return "Wikipedia";
  return host.replace(/^www\./, "");
}

/** What the stored text may be used under. Wikipedia text is CC BY-SA 4.0
    (kept local, credited by publication); anything else is unknown, which
    means all rights reserved: local research use only. */
export function licenseFor(url) {
  return isWikipediaHost(new URL(url).hostname.toLowerCase()) ? "CC BY-SA 4.0" : "unknown";
}

function missingFor(url, res) {
  if (res.status === -1) return { url, status: -1, reason: "blocked by robots.txt" };
  if (res.status > 0) return { url, status: res.status, reason: `http ${res.status}` };
  return { url, status: 0, reason: res.notes?.join("; ") || "fetch failed" };
}

async function extract(res) {
  if (looksLikePdf(res.contentType, res.body)) return pdfToMarkdown(res.body);
  return htmlToMarkdown(res.body.toString("utf8"), res.finalUrl);
}

/**
 * Builds one node's dossier. `target` is {id, label, urls}. Returns the
 * dossier object (passages may be empty; `missing` lists what failed).
 * Throws VerbatimError if a passage is not a verbatim slice of its source.
 */
export async function buildNode(target, { fetcher, now = () => Date.now(), passagesFor = cutPassages, maxPassages = MAX_PASSAGES_PER_NODE, log = () => {} }) {
  const sources = [];
  const passages = [];
  const missing = [];
  for (const seedUrl of target.urls) {
    if (passages.length >= maxPassages) break;
    const url = assertSeedUrl(seedUrl);
    const res = await fetcher.fetchUrl(url);
    if (!res.ok) {
      missing.push(missingFor(url, res));
      continue;
    }
    const retrievedAt = new Date(now()).toISOString();
    let doc;
    try {
      doc = await extract(res);
    } catch (err) {
      missing.push({ url, status: 0, reason: `extraction failed: ${err?.message ?? err}` });
      continue;
    }
    const text = extractText(doc.markdown);
    const cut = passagesFor(text);
    // The fetched-text guarantee: refuse rather than write a retyped passage.
    assertVerbatim(cut, text);
    if (cut.length === 0) {
      missing.push({ url, status: 0, reason: `no passages extracted${doc.notes?.length ? ` (${doc.notes.join("; ")})` : ""}` });
      continue;
    }
    const publication = publicationFor(url);
    const sourceId = sourceIdFor(url);
    sources.push({
      sourceId,
      url,
      publication,
      title: publication === "Wikipedia" ? doc.title.replace(/\s+[-–—]\s+Wikipedia$/, "") : doc.title,
      retrievedAt,
      sha256: sha256(res.body),
      license: licenseFor(url),
    });
    const room = maxPassages - passages.length;
    cut.slice(0, room).forEach((p, n) => {
      passages.push({ docId: `dossier:${target.id}:${sourceId}:${n}`, sourceId, text: p.text, offset: p.offset });
    });
    log(`  ${url}: ${Math.min(cut.length, room)} passages`);
  }
  return {
    version: DOSSIER_VERSION,
    node_id: target.id,
    label: target.label,
    built_at: new Date(now()).toISOString(),
    builder: "code",
    sources,
    passages,
    missing,
  };
}

function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function readManifest(dir) {
  const file = path.join(dir, MANIFEST_FILE);
  if (!fs.existsSync(file)) return null;
  const m = JSON.parse(fs.readFileSync(file, "utf8"));
  const errs = validateManifest(m);
  if (errs.length) throw new Error(`${file} is not a valid manifest: ${errs.slice(0, 3).join("; ")}`);
  return m;
}

/**
 * Builds every target and updates the manifest (entries for nodes not in
 * this run are kept). Every request goes through ONE createFetcher, built
 * here, so no target can bypass robots.txt or the per-host spacing.
 */
export async function buildDossiers({
  targets,
  outDir = DOSSIERS_DIR,
  fetchImpl = globalThis.fetch,
  sleep,
  now = () => Date.now(),
  hostGate = null,
  passagesFor,
  maxPassages,
  log = () => {},
}) {
  const stems = new Map();
  for (const t of targets) {
    const stem = safeNodeId(t.id);
    if (stems.has(stem) && stems.get(stem) !== t.id) throw new Error(`node ids ${stems.get(stem)} and ${t.id} share the file ${stem}.json`);
    stems.set(stem, t.id);
  }
  const fetcher = createFetcher({ fetchImpl, now, hostGate, ...(sleep ? { sleep } : {}) });
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = readManifest(outDir) ?? { version: DOSSIER_VERSION, updated_at: new Date(now()).toISOString(), nodes: {} };
  const results = [];
  for (const target of targets) {
    log(`${target.id} (${target.urls.length} seed${target.urls.length === 1 ? "" : "s"})`);
    const dossier = await buildNode(target, { fetcher, now, passagesFor, maxPassages, log });
    const errs = validateDossier(dossier);
    if (errs.length) throw new Error(`dossier ${target.id} fails schema.mjs: ${errs.slice(0, 3).join("; ")}`);
    const file = dossierPath(outDir, target.id);
    let entry;
    if (dossier.passages.length > 0) {
      const text = `${JSON.stringify(dossier, null, 2)}\n`;
      writeAtomic(file, text);
      entry = { file: path.basename(file), sha256: sha256(Buffer.from(text, "utf8")) };
    } else {
      // No passage: no file, and no stale file from an earlier build either.
      fs.rmSync(file, { force: true });
      entry = { file: null, sha256: null };
    }
    manifest.nodes[target.id] = {
      label: target.label,
      ...entry,
      passages: dossier.passages.length,
      sources: dossier.sources.length,
      built_at: dossier.built_at,
      missing: dossier.missing,
    };
    log(`  -> ${dossier.passages.length} passages, ${dossier.sources.length} sources, ${dossier.missing.length} missing`);
    results.push(dossier);
  }
  manifest.updated_at = new Date(now()).toISOString();
  const merrs = validateManifest(manifest);
  if (merrs.length) throw new Error(`manifest fails schema.mjs: ${merrs.slice(0, 3).join("; ")}`);
  writeAtomic(path.join(outDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, dossiers: results };
}

const USAGE =
  "usage: node tools/corpus/dossiers/build.mjs (--all | --node <id> [--node <id> ...] | --subjects <file>) [--out <dir>] [--seeds <file>] [--taxonomy <file>]";

export function parseArgs(argv) {
  const opts = { all: false, nodes: [], subjects: null, out: DOSSIERS_DIR, seeds: SEEDS_PATH, taxonomy: TAXONOMY_PATH };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value\n${USAGE}`);
      return v;
    };
    if (a === "--all") opts.all = true;
    else if (a === "--node") opts.nodes.push(value());
    else if (a === "--subjects") opts.subjects = value();
    else if (a === "--out") opts.out = path.resolve(value());
    else if (a === "--seeds") opts.seeds = value();
    else if (a === "--taxonomy") opts.taxonomy = value();
    else throw new Error(`unknown argument ${a}\n${USAGE}`);
  }
  if (!opts.all && opts.nodes.length === 0 && !opts.subjects) throw new Error(USAGE);
  if (opts.all && opts.nodes.length) throw new Error(`--all and --node are exclusive\n${USAGE}`);
  return opts;
}

/** argv -> the build targets {id, label, urls}, validated, no I/O but reads. */
export function targetsFor(opts) {
  const nodes = loadTaxonomyNodes(opts.taxonomy);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seeds = loadSeeds(opts.seeds, { nodeIds: new Set(byId.keys()) });
  const chosen = opts.all
    ? nodes
    : opts.nodes.map((id) => {
        const n = byId.get(id);
        if (!n) throw new Error(`--node ${id}: not a node in ${opts.taxonomy}`);
        return n;
      });
  const targets = chosen.map((n) => ({ id: n.id, label: n.label, urls: titlesForNode(n, seeds) }));
  if (opts.subjects) targets.push(...subjectTargets(JSON.parse(fs.readFileSync(opts.subjects, "utf8")), { what: opts.subjects }));
  return targets;
}

export async function main(argv = process.argv.slice(2), { fetchImpl, sleep, now, hostGate, log = (s) => console.log(s) } = {}) {
  const opts = parseArgs(argv);
  const targets = targetsFor(opts);
  const { manifest, dossiers } = await buildDossiers({
    targets,
    outDir: opts.out,
    fetchImpl,
    sleep,
    ...(now ? { now } : {}),
    hostGate: hostGate === undefined ? createHostGate() : hostGate,
    log,
  });
  const empty = dossiers.filter((d) => d.passages.length === 0).map((d) => d.node_id);
  log(`built ${dossiers.length} node(s) into ${opts.out}; ${empty.length} with no passage${empty.length ? `: ${empty.join(", ")}` : ""}`);
  return { manifest, dossiers };
}

if (isEntryScript(import.meta.url)) {
  main().catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  });
}
