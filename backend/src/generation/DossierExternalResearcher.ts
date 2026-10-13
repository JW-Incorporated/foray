import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { tokenizeForSourcing } from "./catalogueLookup";
import type {
  ExternalResearchContext,
  ExternalResearcher,
  ExternalResearchResult,
  PassageRetrievalRequest,
  RetrievedPassage
} from "./ExternalResearcher";
import { dossierDir, type FlagSource } from "./generationFlags";

/**
 * GV-69 (docs/roadmap/generation-v2.md, W3-21; covers R2-20, QK-23, R1-05):
 * the 'dossier' research route. Outside facts are served at request time from
 * the fetched-text dossiers GV-30 builds (tools/corpus/dossiers/build.mjs) and
 * GV-65 may narrow (qwen-select.mjs), so neither the evidence wave nor §4.2's
 * shape research needs a web call, and every print quote the writer takes is
 * checked (writeNarration.ts gateSelectedClaims) against bytes a fetcher
 * really fetched and recorded with their sha256.
 *
 * Selected with FORAY_STAGE_RESEARCH=dossier through the routing table
 * (GV-03, GV-61); the directory is generationFlags' dossierDir()
 * (FORAY_DOSSIER_DIR, default data-local/dossiers). Nothing routes here by
 * default.
 *
 * READ-ONLY, NO NETWORK. This module reads manifest.json and the dossier files
 * it names, once per process per directory, and never fetches, opens a socket
 * or writes a file (a structural test holds it to that). A missing directory
 * gives an empty set and ONE warning, so the route answers like 'none'; a file
 * that fails the schema is skipped and logged, never fatal.
 *
 * LEXICAL RETRIEVAL. BM25 over passage text with tokenizeForSourcing, the
 * same k1/b as transcriptTextIndex.ts, idf over the passages in scope. A
 * paraphrased claim with too few shared words is missed; the floors below
 * exist so a claim that shares one common word with a passage gets nothing
 * rather than an off-subject document the writer would then quote.
 */

/** BM25's term-frequency saturation: transcriptTextIndex.ts's BM25_K1. */
const BM25_K1 = 1.2;
/** BM25's length normalisation: transcriptTextIndex.ts's BM25_B. */
const BM25_B = 0.75;

/** A passage must share at least this many DISTINCT content words with the
 * claim. UNCALIBRATED (W3-21's starting value): to be calibrated on the
 * golden set. */
export const DOSSIER_MIN_TERMS = 2;
/** ...and the words it shares must carry at least this share of the claim's
 * total idf, so two common words in a long claim about something else do not
 * qualify. UNCALIBRATED: to be calibrated on the golden set. */
export const DOSSIER_MIN_SHARE = 0.2;

/** research(): how many passages the notes quote, and the notes' cap. */
export const DOSSIER_NOTE_PASSAGES = 3;
export const DOSSIER_NOTES_MAX_CHARS = 800;
/** research(): how many contested passages, and how much of each. */
export const DOSSIER_MAX_CONTROVERSIES = 3;
export const DOSSIER_CONTROVERSY_CHARS = 200;

/* ------------------------------------------------------------------------ */
/* The schema: a zod mirror of tools/corpus/dossiers/schema.mjs (GV-30)       */
/* ------------------------------------------------------------------------ */

/** schema.mjs's MAX_PASSAGE_CHARS (passages.mjs), the backend's
 * EVIDENCE_MAX_PASSAGE_CHARS. */
const MAX_PASSAGE_CHARS = 1500;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const dateTime = z.string().refine((v) => ISO.test(v) && !Number.isNaN(Date.parse(v)), "not a date-time");
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const nodeId = z.string().min(1).regex(/^[a-z0-9][a-z0-9/-]*$/);
const sourceId = z.string().regex(/^[0-9a-f]{12}$/);
const missing = z.object({ url: z.string().min(1), status: z.number().int(), reason: z.string().min(1) }).strict();

export const DossierFileSchema = z
  .object({
    version: z.literal(1),
    node_id: nodeId,
    label: z.string().min(1),
    built_at: dateTime,
    builder: z.enum(["code", "qwen-select"]),
    model: z.string().min(1).optional(),
    selected_at: dateTime.optional(),
    sources: z.array(
      z
        .object({
          sourceId,
          url: z.string().regex(/^https:\/\//),
          publication: z.string().min(1),
          title: z.string(),
          retrievedAt: dateTime,
          sha256,
          license: z.string().min(1)
        })
        .strict()
    ),
    passages: z.array(
      z
        .object({
          docId: z.string().regex(/^dossier:[a-z0-9/-]+:[0-9a-f]{12}:[0-9]+$/),
          sourceId,
          text: z.string().min(1).max(MAX_PASSAGE_CHARS),
          offset: z.number().int().min(0),
          contested: z.boolean().optional()
        })
        .strict()
    ),
    missing: z.array(missing)
  })
  .strict();

export const DossierManifestSchema = z
  .object({
    version: z.literal(1),
    updated_at: dateTime,
    nodes: z.record(
      z
        .object({
          label: z.string(),
          file: z.string().nullable(),
          sha256: sha256.nullable(),
          passages: z.number().int().min(0),
          sources: z.number().int().min(0),
          built_at: dateTime,
          missing: z.array(missing)
        })
        .strict()
    )
  })
  .strict();

export type DossierFile = z.infer<typeof DossierFileSchema>;

/* ------------------------------------------------------------------------ */
/* The loaded set                                                             */
/* ------------------------------------------------------------------------ */

interface LoadedPassage {
  docId: string;
  nodeId: string;
  title: string;
  url: string;
  retrievedAt: string;
  text: string;
  contested: boolean;
  /** Content-word count: BM25's |D|. */
  length: number;
  tf: Map<string, number>;
}

interface DossierSet {
  passages: LoadedPassage[];
}

const loaded = new Map<string, DossierSet>();

/** Test seam: forget every loaded directory, so the next call reads again. */
export function __clearDossierCacheForTests(): void {
  loaded.clear();
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join(".") || "$"}: ${issue.message}` : "invalid";
}

/** The work a passage is quoted from, as gatherEvidence's print document
 * title: the publication, then the source's own title. */
function titleOf(publication: string, sourceTitle: string): string {
  return sourceTitle.trim().length > 0 ? `${publication} — ${sourceTitle}` : publication;
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

function loadDossierSet(dir: string): DossierSet {
  const empty: DossierSet = { passages: [] };
  if (!fs.existsSync(dir)) {
    console.warn(`DossierExternalResearcher: no dossier directory at ${dir}; the 'dossier' route has no outside facts and answers like 'none'`);
    return empty;
  }
  const manifestPath = path.join(dir, "manifest.json");
  let manifest: z.infer<typeof DossierManifestSchema>;
  try {
    const parsed = DossierManifestSchema.safeParse(readJson(manifestPath));
    if (!parsed.success) {
      console.warn(`DossierExternalResearcher: ${manifestPath} fails the manifest schema (${firstIssue(parsed.error)}); no dossiers loaded`);
      return empty;
    }
    manifest = parsed.data;
  } catch (err) {
    console.warn(`DossierExternalResearcher: cannot read ${manifestPath} (${err instanceof Error ? err.message : String(err)}); no dossiers loaded`);
    return empty;
  }

  const root = path.resolve(dir);
  const passages: LoadedPassage[] = [];
  for (const [node, entry] of Object.entries(manifest.nodes)) {
    if (entry.file === null) continue;
    const file = path.resolve(root, entry.file);
    if (path.dirname(file) !== root) {
      console.warn(`DossierExternalResearcher: skipped node ${node}: its file is not directly inside the dossier directory`);
      continue;
    }
    let dossier: DossierFile;
    try {
      const parsed = DossierFileSchema.safeParse(readJson(file));
      if (!parsed.success) {
        console.warn(`DossierExternalResearcher: skipped ${entry.file}: fails the dossier schema (${firstIssue(parsed.error)})`);
        continue;
      }
      dossier = parsed.data;
    } catch (err) {
      console.warn(`DossierExternalResearcher: skipped ${entry.file}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (dossier.node_id !== node) {
      console.warn(`DossierExternalResearcher: skipped ${entry.file}: its node_id is not the manifest's node ${node}`);
      continue;
    }
    const sources = new Map(dossier.sources.map((s) => [s.sourceId, s]));
    for (const passage of dossier.passages) {
      const source = sources.get(passage.sourceId);
      if (!source) {
        console.warn(`DossierExternalResearcher: skipped passage ${passage.docId}: no source ${passage.sourceId} in ${entry.file}`);
        continue;
      }
      const tokens = tokenizeForSourcing(passage.text);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      passages.push({
        docId: passage.docId,
        nodeId: dossier.node_id,
        title: titleOf(source.publication, source.title),
        url: source.url,
        retrievedAt: source.retrievedAt,
        text: passage.text,
        contested: passage.contested === true,
        length: tokens.length,
        tf
      });
    }
  }
  return { passages };
}

/* ------------------------------------------------------------------------ */
/* Ranking                                                                    */
/* ------------------------------------------------------------------------ */

interface Ranked {
  passage: LoadedPassage;
  score: number;
  /** Distinct query terms the passage holds. */
  matched: number;
  /** Their idf over the claim's total idf. */
  share: number;
}

/** Every in-scope passage scored against `query`, best first (docId breaks
 * ties, so a replay is reproducible). Nothing is filtered here. */
function rank(query: string, scope: LoadedPassage[]): Ranked[] {
  const terms = [...new Set(tokenizeForSourcing(query))];
  if (terms.length === 0 || scope.length === 0) return [];
  const docCount = scope.length;
  const avgLength = scope.reduce((sum, p) => sum + p.length, 0) / docCount;
  const idf = new Map<string, number>();
  let totalIdf = 0;
  for (const term of terms) {
    const n = scope.reduce((count, p) => count + (p.tf.has(term) ? 1 : 0), 0);
    const value = Math.log(1 + (docCount - n + 0.5) / (n + 0.5));
    idf.set(term, value);
    totalIdf += value;
  }
  const ranked: Ranked[] = scope.map((passage) => {
    let score = 0;
    let matched = 0;
    let matchedIdf = 0;
    for (const term of terms) {
      const tf = passage.tf.get(term);
      if (tf === undefined) continue;
      const weight = idf.get(term) ?? 0;
      matched += 1;
      matchedIdf += weight;
      const denominator = tf + BM25_K1 * (1 - BM25_B + (BM25_B * passage.length) / (avgLength || 1));
      score += weight * ((tf * (BM25_K1 + 1)) / (denominator || 1));
    }
    return { passage, score, matched, share: totalIdf > 0 ? matchedIdf / totalIdf : 0 };
  });
  ranked.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.passage.docId < b.passage.docId ? -1 : a.passage.docId > b.passage.docId ? 1 : 0));
  return ranked;
}

function passesFloors(r: Ranked): boolean {
  return r.matched >= DOSSIER_MIN_TERMS && r.share >= DOSSIER_MIN_SHARE;
}

export interface DossierExternalResearcherOptions {
  /** The dossier directory; default generationFlags' dossierDir(source). */
  dir?: string;
  /** Where dossierDir() reads FORAY_DOSSIER_DIR; default process.env. */
  source?: FlagSource;
}

export class DossierExternalResearcher implements ExternalResearcher {
  readonly providerName = "dossier";
  /** The directory this researcher reads, resolved at construction (a
   * malformed FORAY_DOSSIER_DIR fails at pipeline start, naming only the
   * variable); nothing is read until the first lookup. */
  readonly dir: string;

  constructor(options: DossierExternalResearcherOptions = {}) {
    this.dir = path.resolve(options.dir ?? dossierDir(options.source ?? process.env));
  }

  /** The set for this directory, loaded on first use and kept for the
   * process. */
  private set(): DossierSet {
    let set = loaded.get(this.dir);
    if (!set) {
      set = loadDossierSet(this.dir);
      loaded.set(this.dir, set);
    }
    return set;
  }

  /** The passages a lookup may use: those of the dossiers whose node is in
   * the topic's lineage when the run has resolved one (W3-16), else all.
   * Absent topicNodeIds means unscoped, never "matches nothing". */
  private scope(ctx: ExternalResearchContext): LoadedPassage[] {
    const passages = this.set().passages;
    if (ctx.topicNodeIds === undefined) return passages;
    const lineage = new Set(ctx.topicNodeIds);
    return passages.filter((p) => lineage.has(p.nodeId));
  }

  async retrievePassages(request: PassageRetrievalRequest, ctx: ExternalResearchContext): Promise<RetrievedPassage[]> {
    const max = Math.max(0, Math.floor(request.maxPassages));
    if (max === 0) return [];
    return rank(request.claim, this.scope(ctx))
      .filter(passesFloors)
      .slice(0, max)
      .map(({ passage }) => ({
        docId: passage.docId,
        title: passage.title,
        url: passage.url,
        retrievedAt: passage.retrievedAt,
        text: passage.text.slice(0, Math.max(0, request.maxChars))
      }));
  }

  /**
   * §4.2's shape research from the dossiers: the notes are up to three of
   * the best passages for the topic, verbatim, each after its title, cut at
   * DOSSIER_NOTES_MAX_CHARS; the controversies are the opening of up to
   * three passages the selection pass (GV-65, W3-20) flagged contested,
   * most relevant first. A code-built dossier flags none.
   */
  async research(topic: string, ctx: ExternalResearchContext): Promise<ExternalResearchResult> {
    const scope = this.scope(ctx);
    const ranked = rank(topic, scope);
    const notes = ranked
      .filter(passesFloors)
      .slice(0, DOSSIER_NOTE_PASSAGES)
      .map(({ passage }) => `${passage.title}: ${passage.text}`)
      .join("\n\n")
      .slice(0, DOSSIER_NOTES_MAX_CHARS);
    /* Scoped to a lineage, every contested passage there is on the topic, so
       all qualify (relevance only orders them); unscoped, a contested passage
       must at least share a word with the topic. */
    const contested = ranked
      .filter((r) => r.passage.contested && (ctx.topicNodeIds !== undefined || r.matched > 0))
      .slice(0, DOSSIER_MAX_CONTROVERSIES)
      .map(({ passage }) => passage.text.slice(0, DOSSIER_CONTROVERSY_CHARS));
    return { notes, controversies: contested };
  }
}
