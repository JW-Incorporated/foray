import * as crypto from "crypto";
import * as path from "path";
import { loadCatalogueData, type CatalogueData } from "./catalogueLookup";
import { createExternalResearcher } from "./createExternalResearcher";
import { readEvidenceCache, writeEvidenceCache } from "./evidenceCache";
import { deriveItemId } from "./sourceBeats";
import {
  loadTranscriptArchive,
  NullTranscriptCueProvider,
  type TranscriptCue,
  type TranscriptCueProvider,
  type TranscriptDigestEntry
} from "./transcriptArchiveLookup";
import type { ExternalResearcher, ExternalResearchContext } from "./ExternalResearcher";
import { leadingNounPhrase } from "../types/spine";
import type { EvidenceDoc as HeldEvidenceDoc } from "../types/narration";
import type { TapePointer } from "../types/tapeSourcing";

/**
 * WS-A's first move: build the EVIDENCE PACK a narration page is written
 * from, BEFORE any writer call.
 *
 * THE PROBLEM THIS EXISTS TO CLOSE (generation-fix-plan-2026-09-09 §0):
 * run 1's writer was asked for a verbatim quote, a publication and a
 * contested flag for every claim while being handed no text to quote
 * from, and the verifier checked those declarations only against
 * themselves. The cheapest way to pass was to invent (F-27: a Chernobyl
 * "publication" for a Kansas City claim), to mis-attribute (F-30: the
 * tape slug `bfh-griddle-bakestone` as a publication; F-32: the same
 * span moving between Wikipedia and Britannica across attempts), to
 * shrink the span until it could not be contradicted (F-42: `"debris"`),
 * or — on the last attempt, with nothing else to hand — to quote the
 * beat purpose itself back as a source (F-46).
 *
 * Every one of those is a symptom of the same missing thing: TEXT. A
 * quote has to be a LOOKUP, not a claim. This module produces the
 * documents a page's quotes must be looked up in; `writeNarration.ts`
 * then refuses, in code, any quote that is not a substring of one of
 * them and any publication that is not one of their titles.
 *
 * WHAT GOES IN A PACK:
 *   - For a tape beat: the anchored segment's transcript cue window
 *     (±`EVIDENCE_TAPE_WINDOW_SEC`) via the `TranscriptCueProvider` that
 *     §4.5 already uses, plus the show and episode title from the
 *     catalogue — so a Frame can say WHO is on tape (F-30/F-34) instead
 *     of citing a slug.
 *   - For every beat: up to `EVIDENCE_MAX_PRINT_PASSAGES` retrieved
 *     print passages, each capped at `EVIDENCE_MAX_PASSAGE_CHARS`, via
 *     `ExternalResearcher.retrievePassages` (the §4.2 web-search path,
 *     generalised from "research this sub-topic" to "retrieve passages
 *     for this claim"). Cached by claim hash under `data-local/evidence/`
 *     so a re-run costs nothing.
 *   - A beat the deepen stage tags `kind: "argument"` (WS-C) gets print
 *     evidence ONLY, never tape: an argument beat is not an account of
 *     an event and has no moment on tape to anchor to. The field does
 *     not exist yet on `SourcedBeat`; when it is absent a beat is
 *     treated as `"account"`, which is what every beat is today.
 *
 * WHAT IT NEVER DOES: fetch or persist an audio byte (§1.1), or write
 * anything outside its own evidence cache directory.
 */

/** Seconds of transcript either side of the anchored segment. Wide
 * enough that the writer can hear the run-up to the moment and the
 * sentence after it, narrow enough that the pack stays a page of text
 * rather than an episode. */
export const EVIDENCE_TAPE_WINDOW_SEC = 90;
/** Per the fix plan: three passages is enough to write a page from and
 * few enough that the claim-selection prompt stays short. */
export const EVIDENCE_MAX_PRINT_PASSAGES = 3;
export const EVIDENCE_MAX_PASSAGE_CHARS = 1500;
/** The tape window's own cap. A 180-second window of speech is ~450
 * words; this bounds the pathological case (a densely-cued episode)
 * without truncating a normal window at all. */
export const EVIDENCE_MAX_TAPE_CHARS = 3000;

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/** WS-C tags beats `account` (something happened; tape can carry it) or
 * `argument` (a claim about what it means; only text can). Absent today
 * — `beatKindOf` reads it defensively and defaults to `account`. */
export type BeatKind = "account" | "argument";

/** One document the pipeline HOLDS the text of. A page's quote must be a
 * substring of exactly one of these, and its publication is this
 * document's own `title` — never free text the writer supplies.
 *
 * Extends `types/narration.ts`'s `EvidenceDoc` (the shape that rides on a
 * `NarratedBeat` and that WS-B's `groundedQuoteRate` reads) with the two
 * fields only the retrieval side has an opinion about, so there is ONE
 * declaration of `{docId, title, url, text}` in the codebase rather than
 * two that can drift apart. */
export interface EvidenceDoc extends HeldEvidenceDoc {
  kind: "tape" | "print";
  retrievedAt?: string;
}

/** Who is on the tape this beat is anchored to — the thing run 1's
 * writer was never told, so it cited the item id instead (F-30). */
export interface TapeContext {
  itemId: string;
  showTitle: string;
  episodeTitle: string;
  startSec: number;
  endSec: number;
}

export interface EvidencePack {
  /** The beat's purpose, carried so the writer prompt, the mechanical
   * quote check (F-46) and the verifier's purpose question (F-41) all
   * read the same string. */
  purpose: string;
  beatKind: BeatKind;
  docs: EvidenceDoc[];
  tape?: TapeContext;
}

export interface EvidenceBeat {
  claim: string;
  kind?: BeatKind;
  tape?: TapePointer;
  /** This beat's page CARRIES content (a Patch or a Carry), so a pack with
   * no print documents in it is not a page that says less — it is no page
   * at all, and `writeNarration.ts` will not call the writer for it. Only
   * for such a beat is an empty retrieval retried once with a rephrased
   * query (F-60); a connective page can legitimately be written from no
   * documents, and paying for a second search on its behalf buys nothing.
   * Absent means false. */
  requiresEvidence?: boolean;
}

export interface EvidenceGatherer {
  gather(beat: EvidenceBeat, ctx: ExternalResearchContext): Promise<EvidencePack>;
}

/** An empty pack for the beat — used as the honest fallback when nothing
 * could be retrieved, and by tests that drive the writer directly. */
export function emptyEvidencePack(claim: string, kind: BeatKind = "account"): EvidencePack {
  return { purpose: claim, beatKind: kind, docs: [] };
}

/** WS-C's field, read defensively: absent means "account" (what every
 * beat is until the deepen stage starts tagging them). */
export function beatKindOf(beat: { kind?: unknown }): BeatKind {
  return beat.kind === "argument" ? "argument" : "account";
}

/** Stable per-claim identity for the retrieval cache and for doc ids.
 * Whitespace- and case-normalised so a purpose that differs only in
 * spacing does not pay for the same retrieval twice. */
export function claimHash(claim: string): string {
  const normalized = String(claim ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return crypto.createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

/** The longest the retry query may be, and the shortest it will cut itself
 * down to.
 *
 * The maximum is a query's length, not a sentence's: past a dozen or so words
 * a search engine is matching a paragraph's framing rather than its subject,
 * which is the thing the FIRST query already did and failed at. The minimum
 * exists so the clause rule below can never hand back a fragment ("Mature
 * pipelines") that names less than the subject it was cut from. */
export const RETRY_QUERY_MAX_WORDS = 14;
export const RETRY_QUERY_MIN_WORDS = 4;

/** Words that begin a clause hanging off the one before it. Cutting here is
 * what turns an editorial sentence into the question a librarian would have
 * been asked: everything from one of these onward is analogy, consequence or
 * qualification, and none of it is the subject.
 *
 * `and`, `but` and `or` are deliberately NOT in the list — they join a
 * subject's own complements at least as often as they hang a clause off it
 * ("training and inference"), and cutting there loses half of what the query
 * is about. */
const CLAUSE_BOUNDARY_WORDS = new Set([
  "after", "although", "as", "because", "before", "if", "instead", "rather", "since", "so", "that",
  "though", "unless", "until", "when", "whenever", "where", "whereas", "wherever", "whether",
  "which", "while", "who", "whom", "whose"
]);

/** Punctuation that ends a clause where it ends a word. */
const CLAUSE_BOUNDARY_PUNCTUATION = /[,;:(—–…]$/;

/**
 * F-60's second query, as a QUERY (F-69).
 *
 * The first retrieval is the beat's purpose verbatim — a full editorial
 * sentence, framing and all ("Mature pipelines treat a dataset the way a build
 * system treats source code: a schema check … fails the run outright"). When
 * that returns nothing, asking the same question the same way is not a retry,
 * so a second, shorter question is asked.
 *
 * WHAT THE SECOND QUESTION USED TO BE, AND WHY IT IS NOT THAT ANY MORE. It was
 * the sentence's rarest-looking words, longest first, re-sorted into their
 * original order: "Conway's bites pipeline boundaries wherever postmortem
 * exactly places", "rotation spanning training diagnose failures materially
 * separate rotations". That is a bag of tokens, not a query — it has no
 * subject, no predicate and no phrase a page could match — and run 2 attempt
 * 4b is what it cost: 12 of 43 first queries empty, 4 rescued by the retry, and
 * one retry for an on-call-rotation claim that came back with fault-diagnosis
 * papers about rotating machinery. Rarity is what makes a TERM distinctive; it
 * is not what makes a QUERY answerable.
 *
 * WHAT IT IS NOW: THE PURPOSE'S FIRST CLAUSE, LED BY THE CLAIM'S SUBJECT. The
 * query is a PREFIX of the purpose sentence, cut at the first clause boundary
 * that leaves at least the claim's leading noun phrase (`leadingNounPhrase`)
 * and `RETRY_QUERY_MIN_WORDS` standing, capped at `RETRY_QUERY_MAX_WORDS`. A
 * prefix is readable by construction — it is the sentence's own words in the
 * sentence's own order — and because it starts at the first word it always
 * contains the subject the claim is about.
 *
 * AND THE PURPOSE IS THE CLAIM (what F-69 asked to be checked). There is no
 * separate purpose sentence anywhere in this pipeline: §4.4's deepened beat
 * carries `claim` and nothing else (`types/spine.ts`'s `BeatSchema`), and this
 * module's own `EvidencePack.purpose` IS `beat.claim` — `writeNarration.ts`
 * passes the page's claim as both. So "build the retry from the purpose
 * sentence" and "fall back to the claim's first clause" are the same
 * instruction here, and this is it.
 *
 * Deterministic, and no model call: rewriting a query with a model is exactly
 * the kind of spend this finding is about.
 *
 * Returns "" when the cut would ask the same question again — a one-clause
 * purpose is already the query — so the caller makes no second call at all.
 */
export function retryQueryFor(claim: string): string {
  const text = String(claim ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const sentence = text.split(/(?<=[.!?…])\s+/)[0] ?? text;
  const words = sentence.split(" ").filter(Boolean);
  if (words.length === 0) return "";

  /* The floor: never cut inside the subject the claim is about. */
  const subjectWords = leadingNounPhrase(sentence).split(" ").filter(Boolean).length;
  const floor = Math.max(RETRY_QUERY_MIN_WORDS, subjectWords);

  let kept = words.length;
  for (let k = floor; k < words.length; k++) {
    const previous = words[k - 1]!;
    const next = words[k]!;
    const boundary =
      CLAUSE_BOUNDARY_PUNCTUATION.test(previous) ||
      CLAUSE_BOUNDARY_WORDS.has(bareWord(next)) ||
      /* "the way …", "the same way …": the analogy the P5 purpose was mostly
         made of, and the one clause opener that is two ordinary words. */
      (bareWord(next) === "the" && words.slice(k + 1, k + 3).some((w) => bareWord(w) === "way"));
    if (boundary) {
      kept = k;
      break;
    }
  }
  kept = Math.min(kept, RETRY_QUERY_MAX_WORDS);

  const query = words.slice(0, kept).join(" ").replace(/^[("'“‘]+/, "").replace(/[,;:.!?(—–…"'”’]+$/, "").trim();
  if (query.split(" ").filter(Boolean).length < 3) return "";
  /* Nothing new to ask: the "shorter" query is the whole claim over again. */
  if (searchKey(query) === searchKey(text)) return "";
  return query;
}

/** A word with its punctuation and quoting stripped, for the two lookups
 * above — `"way,"` and `way` are the same word to a clause boundary. */
function bareWord(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9']/g, "");
}

/** Two queries are the same question when their words are the same words. */
function searchKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export interface EvidenceGathererOptions {
  researcher?: ExternalResearcher;
  cueProvider?: TranscriptCueProvider;
  catalogue?: CatalogueData;
  transcriptArchive?: TranscriptDigestEntry[];
  /** Where retrieved passages are cached. `null` disables caching. */
  cacheDir?: string | null;
  now?: () => Date;
}

export class DefaultEvidenceGatherer implements EvidenceGatherer {
  private readonly researcher: ExternalResearcher;
  /** Public and readonly so a caller can PROVE it got the provider it
   * passed. Requirements §8.1: `writeNarration` built this gatherer with
   * no options at all, so every tape page was written against
   * `NullTranscriptCueProvider` — no cue window, only the episode title —
   * on the same machine where §4.5 was anchoring against real cues. A
   * silent default is exactly the kind of wrong that needs an assertion
   * rather than a comment. */
  readonly cueProvider: TranscriptCueProvider;
  private readonly cacheDir: string | null;
  private readonly now: () => Date;
  private catalogue: CatalogueData | null;
  private archive: TranscriptDigestEntry[] | null;

  constructor(options: EvidenceGathererOptions = {}) {
    this.researcher = options.researcher ?? createExternalResearcher();
    this.cueProvider = options.cueProvider ?? new NullTranscriptCueProvider();
    this.catalogue = options.catalogue ?? null;
    this.archive = options.transcriptArchive ?? null;
    this.now = options.now ?? (() => new Date());
    /* A stub researcher's "passages" are fixtures, not retrievals: there
       is nothing to save and nothing to save it FROM, so a dry-run never
       writes to the cache (and a test run never writes to data-local/). */
    const defaultDir = this.researcher.providerName === "stub" ? null : path.join(REPO_ROOT, "data-local", "evidence");
    this.cacheDir = options.cacheDir === undefined ? defaultDir : options.cacheDir;
  }

  async gather(beat: EvidenceBeat, ctx: ExternalResearchContext): Promise<EvidencePack> {
    const beatKind = beatKindOf(beat);
    const pack: EvidencePack = { purpose: beat.claim, beatKind, docs: [] };

    // An argument beat gets print only — there is no moment on tape that
    // is the argument, and anchoring one to tape is what produced run 1's
    // off-topic anchors (F-33/F-38, WS-C).
    if (beat.tape && beatKind === "account") {
      const tapeEvidence = this.tapeEvidenceFor(beat.tape);
      if (tapeEvidence) {
        pack.tape = tapeEvidence.context;
        if (tapeEvidence.doc) pack.docs.push(tapeEvidence.doc);
      }
    }

    /* AND A BEAT THAT SOURCED TO TAPE IS NOT SENT TO THE WEB AT ALL (F-69).
     *
     * WHAT ATTEMPT 4B DID, AND WHY IT WAS WRONG. Every tape beat's hand-off page
     * went through `printEvidenceFor` exactly like a Carry page: a retrieval
     * call, an empty result often enough, and then F-60's second call on top —
     * for a page whose whole job is to hand the listener into a stretch of tape
     * this pipeline is HOLDING THE TRANSCRIPT OF. The window above is that
     * page's evidence. It is the only text the page may quote (a Frame that
     * quotes a magazine instead of the tape it is introducing is citing the
     * wrong thing), it is what §4.7's mechanical quote rule resolves against,
     * and it arrives at zero cost from a file already on disk. A web passage
     * could only ever be a second subject for a page that is not allowed to
     * change subject.
     *
     * SO THE SKIP IS CONDITIONED ON HOLDING THE WINDOW, NOT ON THE SEED. A
     * seeded beat that sourced to tape is the case F-69 names, but the argument
     * is about the evidence and not about where the beat came from: whenever
     * this pack has the transcript window in it, the window is the evidence.
     * When it does not — no cue body on this machine, so `tapeEvidenceFor`
     * returned a context and no document — the beat still needs text from
     * somewhere, and the retrieval below runs exactly as it did. */
    if (pack.docs.some((doc) => doc.kind === "tape")) return pack;

    for (const doc of await this.printEvidenceFor(beat.claim, ctx, beat.requiresEvidence === true)) pack.docs.push(doc);
    return pack;
  }

  private loadedCatalogue(): CatalogueData {
    if (!this.catalogue) this.catalogue = loadCatalogueData();
    return this.catalogue;
  }

  private loadedArchive(): TranscriptDigestEntry[] {
    if (!this.archive) this.archive = loadTranscriptArchive();
    return this.archive;
  }

  private tapeEvidenceFor(tape: TapePointer): { context: TapeContext; doc: EvidenceDoc | null } | null {
    const entry = findDigestForItem(tape.itemId, this.loadedArchive(), this.loadedCatalogue());
    const titles = titlesForItem(tape.itemId, this.loadedCatalogue(), entry);
    if (!titles) return null;

    const context: TapeContext = {
      itemId: tape.itemId,
      showTitle: titles.showTitle,
      episodeTitle: titles.episodeTitle,
      startSec: tape.startSec,
      endSec: tape.endSec
    };

    const cues = entry ? this.cueProvider.getCues(entry) : null;
    if (!cues) return { context, doc: null };

    const text = cueWindowText(cues, tape.startSec, tape.endSec);
    if (!text) return { context, doc: null };

    return {
      context,
      doc: {
        docId: `tape:${tape.segmentId}`,
        kind: "tape",
        // A source citing this doc gets THIS as its publication — a real
        // work with a real name, which is exactly what F-30's slug was not.
        title: `${titles.showTitle} — ${titles.episodeTitle}`,
        text
      }
    };
  }

  /**
   * The print half of a pack, in at most TWO queries (F-60).
   *
   * Run 2's act 1 p5 asked once, got `{"passages": []}`, cached it, and
   * handed the writer a Carry page with no documents — which the
   * mechanical rule then refused three times over, once per selection
   * call, before ending the Foray. The first of those wasted calls is
   * replaced here by a second RETRIEVAL: same beat, the shorter question
   * `retryQueryFor` cuts out of the purpose (F-69), cached under its own
   * hash so the first query's emptiness is never served in its place.
   *
   * Only for a page that carries content, and only ever once — a beat that
   * genuinely has no published text behind it must reach
   * `writeNarration.ts` with an empty pack, so that stage can degrade the
   * page instead of paying a model to fail.
   */
  private async printEvidenceFor(claim: string, ctx: ExternalResearchContext, requiresEvidence: boolean): Promise<EvidenceDoc[]> {
    const first = await this.retrieveFor(claim, ctx);
    if (first.length > 0 || !requiresEvidence) return first;

    const retryQuery = retryQueryFor(claim);
    if (!retryQuery || claimHash(retryQuery) === claimHash(claim)) return first;

    /* The query itself is in the line, verbatim and in full, because it is the
       thing a run log is read for here: F-69 was found by reading these lines
       and seeing that what they quoted was not a question (F-60/F-69). */
    console.warn(
      `gatherEvidence: nothing was retrieved for "${claim.slice(0, 60)}" — asking once more for "${retryQuery}" (F-60/F-69)`
    );
    return this.retrieveFor(retryQuery, ctx);
  }

  /** One retrieval, cached by ITS OWN query's hash. */
  private async retrieveFor(claim: string, ctx: ExternalResearchContext): Promise<EvidenceDoc[]> {
    const hash = claimHash(claim);
    const cached = this.readCache(hash);
    if (cached) return cached;

    const retrieve = this.researcher.retrievePassages?.bind(this.researcher);
    if (!retrieve) return [];

    let docs: EvidenceDoc[];
    try {
      const passages = await retrieve(
        { claim, maxPassages: EVIDENCE_MAX_PRINT_PASSAGES, maxChars: EVIDENCE_MAX_PASSAGE_CHARS },
        ctx
      );
      docs = passages
        .filter((p) => typeof p.text === "string" && p.text.trim().length > 0 && typeof p.title === "string" && p.title.trim().length > 0)
        .slice(0, EVIDENCE_MAX_PRINT_PASSAGES)
        .map((p, i) => ({
          docId: p.docId || `print:${hash}-${i + 1}`,
          kind: "print" as const,
          title: p.title.trim(),
          ...(p.url ? { url: p.url } : {}),
          retrievedAt: p.retrievedAt ?? this.now().toISOString(),
          text: p.text.slice(0, EVIDENCE_MAX_PASSAGE_CHARS)
        }));
    } catch (err) {
      /* Retrieval failing is not the run failing. The page is written
         from whatever evidence DID arrive, and if that is nothing the
         mechanical rules downstream refuse to let it assert anything —
         which is the correct outcome, and a much better one than a page
         that invents a citation because retrieval was down. */
      console.warn(`gatherEvidence: print retrieval failed for "${claim.slice(0, 80)}" — continuing with the evidence already held (${err instanceof Error ? err.message : String(err)})`);
      return [];
    }

    this.writeCache(hash, docs);
    return docs;
  }

  private readCache(hash: string): EvidenceDoc[] | null {
    return this.cacheDir ? readEvidenceCache(this.cacheDir, hash, this.now) : null;
  }

  private writeCache(hash: string, docs: EvidenceDoc[]): void {
    if (this.cacheDir) writeEvidenceCache(this.cacheDir, hash, docs, this.now);
  }
}

/** Same stub/real split every other collaborator uses: the researcher
 * behind it is `createExternalResearcher()`, which is the Stub whenever
 * ANTHROPIC_API_KEY is absent — so a dry-run still produces a
 * structurally real pack (documents with text, quotes that resolve). */
export function createEvidenceGatherer(options: EvidenceGathererOptions = {}): EvidenceGatherer {
  return new DefaultEvidenceGatherer(options);
}

/** The cues overlapping [startSec - window, endSec + window], joined.
 * Returns "" when the window is empty — never a fabricated line. */
export function cueWindowText(
  cues: TranscriptCue[],
  startSec: number,
  endSec: number,
  windowSec: number = EVIDENCE_TAPE_WINDOW_SEC
): string {
  const from = startSec - windowSec;
  const to = endSec + windowSec;
  const parts: string[] = [];
  for (const cue of cues) {
    if (cue.end_sec < from || cue.start_sec > to) continue;
    const text = String(cue.text ?? "").trim();
    if (text) parts.push(text);
  }
  const joined = parts.join(" ").replace(/\s+/g, " ").trim();
  if (joined.length <= EVIDENCE_MAX_TAPE_CHARS) return joined;
  // Trim on a word boundary: a half-word would make a legitimate quote
  // at the end of the window unmatchable.
  const cut = joined.slice(0, EVIDENCE_MAX_TAPE_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
}

/**
 * Finds the transcript digest entry for a tape item id. Two id families
 * meet here and neither is derivable from the other in general:
 * `data/discover.json`'s hand-slugged ids (`titans-of-nuclear--brian-woods`)
 * and the tier-2 ids `sourceBeats.deriveItemId` mints from a digest
 * title. Exact match covers the second; for the first, the show prefix
 * plus episode-title word overlap covers what can honestly be matched,
 * and `null` is the answer for everything else.
 */
export function findDigestForItem(
  itemId: string,
  archive: TranscriptDigestEntry[],
  catalogue: CatalogueData
): TranscriptDigestEntry | null {
  for (const entry of archive) {
    if (deriveItemId(entry) === itemId) return entry;
  }

  const showId = itemId.includes("--") ? itemId.slice(0, itemId.indexOf("--")) : itemId;
  const item = catalogue.items.find((i) => i.id === itemId);
  const episodeTitle = item?.title;
  if (!episodeTitle) return null;

  const wanted = titleTokens(episodeTitle);
  if (wanted.size === 0) return null;

  let best: { entry: TranscriptDigestEntry; score: number } | null = null;
  for (const entry of archive) {
    if (entry.show_id !== showId) continue;
    const have = titleTokens(entry.title);
    let score = 0;
    for (const t of wanted) if (have.has(t)) score += 1;
    if (score >= 2 && (!best || score > best.score)) best = { entry, score };
  }
  return best?.entry ?? null;
}

/** Show + episode title for a tape item, from the catalogue first (it
 * covers the tier-1 pool) and the digest entry second (it covers a
 * tier-2 episode the catalogue has never listed). `null` when neither
 * knows — better no tape evidence at all than a source attributed to a
 * name the pipeline made up. */
export function titlesForItem(
  itemId: string,
  catalogue: CatalogueData,
  entry: TranscriptDigestEntry | null
): { showTitle: string; episodeTitle: string } | null {
  const item = catalogue.items.find((i) => i.id === itemId);
  if (item?.title) {
    const showTitle = item.show || catalogue.shows.find((s) => itemId.startsWith(`${s.show_id}--`))?.title || "";
    if (showTitle) return { showTitle, episodeTitle: item.title };
  }
  if (entry?.show_title && entry.title) return { showTitle: entry.show_title, episodeTitle: entry.title };
  return null;
}

function titleTokens(text: string): Set<string> {
  return new Set(
    String(text ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3)
  );
}
