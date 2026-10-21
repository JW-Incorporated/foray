import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { tokenizeForSourcing } from "./catalogueLookup";
import { canonicalizeForAnchorMatch } from "../types/anchorText";
import { codeHit, codeSpanSync } from "./codeSpans";
import { corpusSafeKey, isLetterSpacedCue } from "./transcriptCorpus";
import { snapEdge, type SnappedEdge } from "./pauseSnap";
import { TranscriptSourceSchema, type TapeBoundary, type TranscriptSource } from "../types/tapeSourcing";

/**
 * §4.5 tier-2 lookup: the transcript archive — "episodes we hold
 * transcripts for but have not yet cut into segments" (§4.5). Reads
 * ONLY the committed digest files (`data/transcript-digests.json`,
 * `data/breadth-transcript-digests.json`) for episode metadata; never
 * the transcript bodies themselves, which live in `data-local/`
 * (gitignored, machine-local per docs/curation/segment-extraction-pipeline.md
 * §3 Lane C) and are therefore not something this module can assume is
 * present on disk.
 *
 * SCOPE, DELIBERATELY NARROW (per this stage's task brief — "you do NOT
 * need to reimplement segment extraction from scratch... model your
 * module's tier-2 output as 'logs a request into the existing
 * extraction pipeline's input format' rather than performing extraction
 * synchronously in-process"):
 *
 *   1. Find a candidate episode whose digest metadata (show/episode
 *      title) overlaps the beat's claim — same deterministic
 *      tokenize-and-score approach as tier 1
 *      (`segmentPoolLookup.ts`) and `catalogueLookup.ts`.
 *   2. If a `TranscriptCueProvider` can supply the episode's actual cue
 *      text (it MAY — see `FileTranscriptCueProvider` below, which
 *      looks for the transcript on the local machine and returns `null`
 *      when it is not there, which is the common case in CI and in this
 *      checkout), choose the WINDOW of that transcript that carries the
 *      claim (`selectTapeWindow`, `tapeWindowIsRelevant`) and cut it to
 *      a segment whose boundaries are anchored by phrases THE TAPE
 *      speaks (`cutWindowToSegment`) — never by the claim's own words,
 *      which are written prose and are not spoken anywhere (F-61). The
 *      minted anchors are canonicalised the way
 *      `tools/segments/merge-segments.mjs` canonicalises both sides
 *      before comparing (`canonicalizeForAnchorMatch`, from
 *      `types/anchorText.ts`, is a small, independently-implemented
 *      mirror of that module's `canonical()`, pinned to it by
 *      `backend/test/anchorTextParity.test.ts` —
 *      not a re-import, since that module is an ESM `.mjs` build script
 *      and this is a CommonJS backend module; the ALGORITHM is what
 *      needs to match, and it does: case/whitespace/punctuation
 *      forgiven, apostrophes elided, everything else exact), so an
 *      anchor minted here is verbatim to that validator by construction.
 *      This is genuine anchor *location* against already-available text,
 *      not segment *extraction* — no episode-selection heuristics, no
 *      agent call, no lint pass, no write to `data/segments.json`.
 *   3. If no cue text is available, the match is still real (the
 *      episode exists and has a transcript) but cannot be resolved to
 *      an anchor synchronously — that becomes a queued extraction
 *      REQUEST in the existing prepare-segment-batch.mjs input shape
 *      (episode metadata + `reference_duration_sec`), for the existing
 *      Lane C pipeline to pick up later. The beat itself falls back to
 *      narration for THIS run (§4.5's own guardrail: a beat's existence
 *      never depends on tape, and tape not yet being resolvable is not
 *      different from tape not existing, sourcing-wise, in this pass).
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

export interface TranscriptDigestEntry {
  show_id: string;
  show_title: string;
  guid: string;
  title: string;
  cues: number;
  feed_duration_sec?: number;
  span_implausible?: boolean;
  /** The episode's own audio, straight from the feed. Already in both committed
   * digest files; modelled here because a tier-2 minted segment cannot be
   * played — or pass `check-forays.mjs`'s source registry — without it (see
   * `audioSourceLookup.ts`). Optional: a digest row that lacks it is a row this
   * pipeline may not mint tape from, not a parse error. */
  enclosure_url?: string;
  /** gen-6 (round-3 audit), runtime only, never read from a file: set by
   * `disambiguateItemIds` when another entry of the loaded archive (a
   * different guid) derives the same `<show_id>--<slug60>` id. A short hash
   * of this entry's guid, appended by `deriveItemId`. */
  item_id_suffix?: string;
}

let cachedDigests: TranscriptDigestEntry[] | null = null;

/**
 * The machine-local corpus digest — the rows for episodes whose bodies are on
 * THIS machine and which the committed digests do not carry.
 *
 * WHY A THIRD FILE (#703). The committed digests are RUN ARTIFACTS:
 * `tools/segments/fetch-transcripts.mjs` writes its `--digests` path whole, with
 * only the targets of that invocation, so a later fetch erases the shows an
 * earlier one recorded while their bodies stay in `data-local/`. On the
 * 2026-09-14 generation machine that had cost seven shows and 3,328 episodes —
 * `stuff-you-should-know` (2,857) and `this-podcast-will-kill-you` (132) among
 * them, both in `data/catalog.json` with taxonomy nodes, neither with a digest
 * row — and it is why a germ-theory Foray was sourced from geology and
 * engineering tape.
 *
 * It is written by `tools/generation/warm-transcript-index.mjs`, it lives under
 * `data-local/` because it describes one machine's disk and nothing else, and
 * it is absent in CI and in a fresh checkout, where this reads exactly as it
 * did before.
 */
export const CORPUS_DIGEST_FILE = path.join("data-local", "transcripts", "corpus-digest.json");

/** Reads the committed digest files (curated + breadth) and the machine-local
 * corpus digest, keeping only episodes whose transcript is usable at all (has
 * cues, timeline not flagged implausible — the same `span_implausible` field
 * `prepare-segment-batch.mjs`'s timeline gate already computes upstream
 * of these files). */
export function loadTranscriptArchive(): TranscriptDigestEntry[] {
  if (cachedDigests && process.env.FORAY_SKIP_CATALOGUE_CACHE !== "1") return cachedDigests;

  const entries: TranscriptDigestEntry[] = [];
  /* COMMITTED FIRST, LOCAL LAST, AND FIRST ROW WINS. A committed row carries
     the publisher metadata the local one reconstructs from a feed, so where
     both describe an episode the committed one is the better row; the local
     digest exists to ADD episodes, never to restate them. */
  const seen = new Set<string>();
  /* How many of `entries` came from the COMMITTED digests: disambiguateItemIds
     decides their ids from committed rows alone (round-3 review, L5). */
  let committed = 0;
  for (const file of ["data/transcript-digests.json", "data/breadth-transcript-digests.json", CORPUS_DIGEST_FILE]) {
    if (file === CORPUS_DIGEST_FILE) committed = entries.length;
    const full = path.join(REPO_ROOT, file);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- hardcoded repo-relative path list, not external input.
    if (!fs.existsSync(full)) continue;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above.
    const raw = fs.readFileSync(full, "utf8");
    const parsed = JSON.parse(raw) as { transcripts?: TranscriptDigestEntry[] };
    for (const t of parsed.transcripts ?? []) {
      if (!((t.cues ?? 0) > 0) || t.span_implausible === true) continue;
      const key = `${t.show_id}\u0000${t.guid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(t);
    }
  }
  disambiguateItemIds(entries, { committed });
  cachedDigests = entries;
  return cachedDigests;
}

export interface TranscriptArchiveMatch {
  entry: TranscriptDigestEntry;
  score: number;
}

/** Same integer-count threshold rationale as `TIER1_MATCH_THRESHOLD` in
 * `segmentPoolLookup.ts` — a title/show-metadata haystack is even
 * shorter than a segment's why-line, so the bar stays low but nonzero. */
export const TIER2_MATCH_THRESHOLD = 3;

/**
 * The best-scoring episode in `archive` for `claimText`, BEFORE the threshold
 * is applied — the same walk `findTranscriptArchiveMatch` makes, stopping one
 * step earlier.
 *
 * Split out for the sourcing trace (F-49): "no tape" was indistinguishable
 * from "the best episode was one title token short", and the two want opposite
 * fixes. A caller that wants the decision calls `findTranscriptArchiveMatch`;
 * a caller that wants to know what the search SAW calls this.
 *
 * WHY THE SHOW TITLE COUNTS FOR AT MOST ONE. Every episode of a show shares its
 * show-title tokens, so a show whose name overlaps the subject ("Causality —
 * Engineered Network" vs. an engineering claim) used to clear the threshold for
 * EVERY one of its episodes on show tokens alone, and the first such episode in
 * file order won: generation run 1 anchored a Kansas City hanger-rod beat to
 * the Chernobyl episode and a box-beam beat to Three Mile Island (findings
 * F-23/F-24). The episode title is the only per-episode signal in a digest, so
 * a match must include at least one episode-title token; the show title can
 * then add one point of confidence, never carry the match by itself.
 */
export function bestTranscriptArchiveCandidate(
  claimText: string,
  archive: TranscriptDigestEntry[] = loadTranscriptArchive(),
  isUsable: (entry: TranscriptDigestEntry) => boolean = () => true
): TranscriptArchiveMatch | null {
  const claimTokens = new Set(tokenizeForSourcing(claimText));
  if (claimTokens.size === 0) return null;

  let best: TranscriptArchiveMatch | null = null;
  for (const entry of archive) {
    if (!isUsable(entry)) continue;
    const score = titleTokenScore(claimTokens, entry);
    if (score === 0) continue; // show-title-only overlap is not a match
    if (!best || score > best.score) best = { entry, score };
  }
  return best;
}

/**
 * The title-metadata score for one episode: one point per claim content word in
 * the EPISODE title, plus at most one for the show title, and zero when the
 * episode title contributes nothing (see `bestTranscriptArchiveCandidate` for
 * why the show title may never carry a match by itself — it is F-23/F-24).
 *
 * Extracted so the one rule has one implementation now that it has two callers
 * with two different jobs. Here it is still the tier-2 threshold's input. In
 * `transcriptTextIndex.ts` it is only a TIE-BREAKER between episodes the
 * transcript text ranks equally — WS-H's demotion of the title bar (F-06),
 * which is a change in what the number is used for, not in how it is computed.
 */
export function titleTokenScore(claimTokens: Set<string>, entry: TranscriptDigestEntry): number {
  const titleTokens = new Set(tokenizeForSourcing(entry.title));
  const showTokens = new Set(tokenizeForSourcing(entry.show_title));
  let score = 0;
  let showHit = 0;
  for (const t of claimTokens) {
    if (titleTokens.has(t)) score += 1;
    else if (showTokens.has(t)) showHit = 1;
  }
  return score === 0 ? 0 : score + showHit;
}

export function findTranscriptArchiveMatch(
  claimText: string,
  archive: TranscriptDigestEntry[] = loadTranscriptArchive(),
  /** Caller's veto, applied INSIDE the search for the same reason
   * `findTier1Match`'s is — §4.5's topic gate lives here, so an episode from
   * another taxonomy family is never the "best" match, it is not a match at
   * all. */
  isUsable: (entry: TranscriptDigestEntry) => boolean = () => true
): TranscriptArchiveMatch | null {
  const best = bestTranscriptArchiveCandidate(claimText, archive, isUsable);
  if (!best || best.score < TIER2_MATCH_THRESHOLD) return null;
  return best;
}

export interface TranscriptCue {
  text: string;
  start_sec: number;
  end_sec: number;
  /**
   * Who is speaking, when the transcript says (Q-01). `tools/segments/`'s
   * normalized bodies carry a `speaker` per cue — a name for a diarised
   * publisher transcript (*Being an Engineer*: 334 of 337 bodies name
   * `Presenter` / the host / the guest), `null` for one that is not. Optional
   * on the type so every inline test provider and every caller that builds
   * cues by hand stays valid; `tapeExtent.ts` reads it to find turn
   * boundaries and falls back to sentence + pause boundaries when it is absent.
   */
  speaker?: string | null;
  /**
   * GV-111 (W5-14b): the cue's words with their own timings, when the body
   * carries them (whisper `word_timestamps`, from the transcript farm). Kept
   * by the reader only when they are trustworthy (`cueWordsOf`): monotonic,
   * inside the cue's span give or take `CUE_WORD_SPAN_TOLERANCE_SEC`, and
   * spelling the cue's own text once both are canonicalised. The cue's
   * `text` is never rewritten from them, so the text index
   * (`TRANSCRIPT_TEXT_INDEX_VERSION`) does not move. Read only by the pause
   * snap (`pauseSnap.ts`, under FORAY_PAUSE_SNAP=on); absent on every body
   * today.
   */
  words?: TranscriptWord[];
}

/** GV-111: one timed word of a cue. */
export interface TranscriptWord {
  text: string;
  start: number;
  end: number;
}

/** GV-111: how far outside its cue's span a word may be timed and still be
 * believed. Whisper's word timing and its segment timing disagree by a few
 * hundred milliseconds at the edges; further than this, the words are not
 * this cue's. */
export const CUE_WORD_SPAN_TOLERANCE_SEC = 0.5;

/**
 * GV-111: the body's `words` for one cue, or undefined when they cannot be
 * trusted — and then the cue is read exactly as it was before words existed.
 *
 * Kept only when every word has a non-empty `text` (whisper's own key,
 * `word`, is read too) and finite `start <= end`; starts and ends never go
 * backwards; every word lies within the cue's span ±
 * `CUE_WORD_SPAN_TOLERANCE_SEC`; and the words joined spell the cue's text
 * once both are canonicalised (`canonicalizeForAnchorMatch`). The last rule
 * is what lets an anchor minted from a run of words (`cutWindowToSegment`
 * under `snapToPauses`) be verbatim tape by construction: the words ARE the
 * cue's canonical words, split at the same places.
 */
export function cueWordsOf(raw: unknown, cue: { text: string; start_sec: number; end_sec: number }): TranscriptWord[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const words: TranscriptWord[] = [];
  for (const w of raw as Array<Record<string, unknown>>) {
    if (w === null || typeof w !== "object") return undefined;
    const rawText = typeof w.text === "string" ? w.text : typeof w.word === "string" ? w.word : null;
    const text = rawText === null ? "" : rawText.trim();
    const start = w.start;
    const end = w.end;
    if (!text || typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
    const prev = words[words.length - 1];
    if (prev && (start < prev.start || end < prev.end)) return undefined;
    if (start < cue.start_sec - CUE_WORD_SPAN_TOLERANCE_SEC || end > cue.end_sec + CUE_WORD_SPAN_TOLERANCE_SEC) return undefined;
    words.push({ text, start, end });
  }
  if (canonicalizeForAnchorMatch(words.map((w) => w.text).join(" ")) !== canonicalizeForAnchorMatch(cue.text)) return undefined;
  return words;
}

/** Supplies real transcript cue text for an episode, if it is available.
 * Injected so tests can exercise the real-anchor path deterministically
 * without a transcript body ever having to be committed to git. */
export interface TranscriptCueProvider {
  getCues(entry: TranscriptDigestEntry): TranscriptCue[] | null;
  /**
   * Which transcript the cues came from — the pool's `transcript_source`
   * (F-78). Optional because most providers (every test's inline
   * `{ getCues }`) hand back the archive's own body, which is by construction
   * the publisher's: `tools/segments/fetch-transcripts.mjs` only ever fetches
   * a digest row's `transcript_url`. A provider that reads a body this machine
   * transcribed itself answers `"asr-local"`, and one whose body states
   * `transcript_source: "apple-podcasts"` answers that; `null` means "no body",
   * the same answer as `getCues` returning `null`.
   */
  transcriptSource?(entry: TranscriptDigestEntry): TranscriptSource | null;
}

/**
 * Production default. Transcript bodies live in `data-local/transcripts/`
 * (gitignored, machine-local — docs/curation/segment-extraction-pipeline.md
 * §3), so this checkout will not have them; the provider returns `null`
 * for every episode, which is the honest, structural answer ("cannot
 * resolve an anchor synchronously right now") rather than a fabricated
 * one. Wiring this to actually read+normalize a local transcript file is
 * future work for whoever operates the Lane C fetch step alongside this
 * stage — deliberately NOT built here (this stage's task brief: "do not
 * build a new transcription pipeline").
 */
export class NullTranscriptCueProvider implements TranscriptCueProvider {
  getCues(): TranscriptCue[] | null {
    return null;
  }
}

/**
 * The provider a generation MACHINE runs with (2026-09-09, first agent-driven
 * production run). Reads the normalized transcript bodies that
 * `tools/segments/` writes to `data-local/transcripts/normalized/<show_id>-<hash>/
 * <guid-slug>-<hash>.json` — `{ show_id, guid, cues: [{ start_sec, end_sec,
 * text }] }` — and hands the cues to `resolveAnchorFromCues`. Until this
 * existed, §4.5 tier 2 could never fire: `NullTranscriptCueProvider` was the
 * only implementation, so every beat that matched an archived episode fell
 * through to "unresolved" and the only tape a Foray could use was the 212-row
 * pre-cut pool. On the machine that ran the first three agent-built Forays,
 * 1,346 of the archive's 1,718 digest entries had a body on disk.
 *
 * Returns `null` (never throws) when the body is absent, unreadable, or has no
 * usable cues — the same honest answer the Null provider gives, so a checkout
 * without `data-local/` behaves exactly as before. The show directory is found
 * by `show_id` prefix and the file by the guid's slug prefix, falling back to
 * opening each file in the show directory and matching `guid` exactly, which
 * covers guids the slug rule mangles (URLs, `Buzzsprout-…`). Reads are cached
 * per process; a batch run asks for the same episode from many beats.
 */
/** gen-15: the cue cache's bound. A batch asks for the same episode from many
 * beats within one Foray, which a few hundred entries cover; an unbounded map
 * held a whole corpus after one index rebuild. */
export const CUE_CACHE_MAX_ENTRIES = 256;

/** GV-111: the same cache's bound in bodies that carry word timings. A word
 * array multiplies a parsed body several times over, so such a body costs
 * `CUE_CACHE_MAX_ENTRIES / CUE_CACHE_WORDS_MAX_ENTRIES` (4) of the bound: a
 * cache of nothing but worded bodies holds 64, and one of bodies without
 * words holds 256, exactly as before. */
export const CUE_CACHE_WORDS_MAX_ENTRIES = 64;

/** GV-111: what one cached answer costs of `CUE_CACHE_MAX_ENTRIES`. */
function cueCacheWeight(cues: TranscriptCue[] | null): number {
  return cues !== null && cues.some((c) => c.words !== undefined) ? CUE_CACHE_MAX_ENTRIES / CUE_CACHE_WORDS_MAX_ENTRIES : 1;
}

export class FileTranscriptCueProvider implements TranscriptCueProvider {
  private readonly root: string;
  private readonly dirByShow = new Map<string, string | null>();
  private readonly cuesByKey = new Map<string, TranscriptCue[] | null>();
  /** GV-111: the summed `cueCacheWeight` of everything in `cuesByKey`. */
  private cueCacheLoad = 0;
  private readonly guidIndexByDir = new Map<string, Map<string, string>>();
  private readonly filesByDir = new Map<string, Map<string, string>>();
  /** gen-7: every locate() answer, the misses included (about a fifth of the
   * archive has no body on disk, and each miss used to re-walk the listing). */
  private readonly locatedByKey = new Map<string, string | null>();

  constructor(root: string = path.join(REPO_ROOT, "data-local", "transcripts", "normalized")) {
    this.root = root;
  }

  getCues(entry: TranscriptDigestEntry): TranscriptCue[] | null {
    const key = `${entry.show_id}\u0000${entry.guid}`;
    if (this.cuesByKey.has(key)) {
      /* gen-15: an LRU, so a hit moves the entry to the recent end. */
      const held = this.cuesByKey.get(key) ?? null;
      this.cuesByKey.delete(key);
      this.cuesByKey.set(key, held);
      /* GV-85: counted, not timed — a Map hit costs less than a clock read. */
      codeHit("transcript.cacheHit");
      return held;
    }
    const result = this.readCuesUncached(entry);
    this.cuesByKey.set(key, result);
    this.cueCacheLoad += cueCacheWeight(result);
    /* GV-111: bounded by weight, so a body carrying words counts four times;
       with no words anywhere this is gen-15's entry count, unchanged. */
    while (this.cueCacheLoad > CUE_CACHE_MAX_ENTRIES) {
      const oldest = this.cuesByKey.keys().next().value;
      if (oldest === undefined) break;
      this.dropCached(oldest);
    }
    return result;
  }

  /**
   * gen-15: the same read, without touching the cache. A text-index rebuild
   * reads EVERY body of a show once (thousands, for a big show), and used to
   * pin all of them in `cuesByKey` for the rest of the batch; it reads through
   * here instead.
   *
   * GV-85: timed as 'transcript.read' (locate plus parse); inert outside a
   * run log.
   */
  readCuesUncached(entry: TranscriptDigestEntry): TranscriptCue[] | null {
    return codeSpanSync("transcript.read", () => {
      try {
        const file = this.locate(String(entry.show_id), String(entry.guid));
        return file ? readCues(file) : null;
      } catch {
        return null;
      }
    });
  }

  /** GV-111: forget one cached answer, and its weight. */
  private dropCached(key: string): void {
    if (!this.cuesByKey.has(key)) return;
    this.cueCacheLoad -= cueCacheWeight(this.cuesByKey.get(key) ?? null);
    this.cuesByKey.delete(key);
  }

  /** How many parsed cue arrays the provider holds right now (tests). */
  cachedCueCount(): number {
    return this.cuesByKey.size;
  }

  /**
   * GV-54 (docs/roadmap/generation-v2.md, subsumes corpus roadmap PKG-24):
   * forget everything this provider memoised about one show, so a body
   * written into its directory after a miss is found on the very next read.
   *
   * Every map here remembers a miss: `dirByShow` a show with no directory yet,
   * `filesByDir` a listing taken before the file existed, `guidIndexByDir` an
   * index built over that listing, `locatedByKey` a null locate and
   * `cuesByKey` a null read. The remote cue store (cli/remoteCueStore.ts)
   * writes fetched bodies into a cache directory this provider reads, and
   * calls this after each write and each eviction. Nothing else changes: a
   * provider over a directory nobody writes to never needs it.
   */
  forgetShow(showId: string): void {
    const dir = this.dirByShow.get(showId) ?? null;
    this.dirByShow.delete(showId);
    if (dir !== null) {
      this.filesByDir.delete(dir);
      this.guidIndexByDir.delete(dir);
    }
    const prefix = `${showId}\u0000`;
    for (const key of [...this.locatedByKey.keys()]) if (key.startsWith(prefix)) this.locatedByKey.delete(key);
    for (const key of [...this.cuesByKey.keys()]) if (key.startsWith(prefix)) this.dropCached(key);
  }

  /**
   * The provenance the body file itself records (F-78's `transcript_source`).
   * `fetch-transcripts.mjs` writes `source_url: <the digest row's transcript_url>`
   * into every normalized body it produces, and its regenerate path records
   * `regenerated_from: "raw/<show>/<guid>.<ext>"` — the raw file that same
   * fetch saved. Either mark means the publisher's transcript. A body carrying
   * neither is one this machine produced itself (`tools/transcribe/`), which is
   * exactly what the pool calls `asr-local`. Never guesses from the digest row:
   * the row says a publisher transcript EXISTS, the body says which one was
   * actually read.
   *
   * AN EXPLICIT FIELD WINS OVER THE INFERENCE. A body that states its own
   * `transcript_source` (foray-db's engine writes `"apple-podcasts"` on an
   * Apple Podcasts transcript, and such a body can carry a `source_url` too,
   * which the inference alone would call `publisher`) is taken at its word when
   * the word is in the vocabulary. One that is NOT is a writer bug and THROWS
   * rather than falling back to the inference: a coerced provenance lands on a
   * minted segment and no later gate can tell it was wrong.
   */
  transcriptSource(entry: TranscriptDigestEntry): TranscriptSource | null {
    let j: { source_url?: unknown; regenerated_from?: unknown; transcript_source?: unknown };
    try {
      const file = this.locate(String(entry.show_id), String(entry.guid));
      if (!file) return null;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path came from this provider's own directory walk.
      j = JSON.parse(fs.readFileSync(file, "utf8")) as typeof j;
    } catch {
      return null;
    }
    if (j.transcript_source !== undefined && j.transcript_source !== null) {
      const stated = TranscriptSourceSchema.safeParse(j.transcript_source);
      if (stated.success) return stated.data;
      throw new Error(
        `transcript body for ${String(entry.show_id)}/${String(entry.guid)} states transcript_source ` +
          `${JSON.stringify(j.transcript_source)}, which is not one of ${TranscriptSourceSchema.options.join("/")}`
      );
    }
    const fetchedFromPublisher =
      (typeof j.source_url === "string" && j.source_url.trim().length > 0) ||
      (typeof j.regenerated_from === "string" && /^raw[\\/]/.test(j.regenerated_from));
    return fetchedFromPublisher ? "publisher" : "asr-local";
  }

  /**
   * The identity of the body file behind an episode — `null` when there is
   * none on this machine.
   *
   * Here rather than in the index that needs it (`transcriptTextIndex.ts`)
   * because of the rule this module already states: `data-local/` is reached
   * only through a provider. A cached index has to know whether the transcript
   * it was built from is still the transcript on disk, and mtime+size is that
   * question asked of the filesystem; letting the index open the path itself
   * would put a second reader of `data-local/` in the pipeline, which is
   * exactly what the provider seam exists to prevent.
   */
  bodyStat(entry: TranscriptDigestEntry): { mtimeMs: number; size: number } | null {
    try {
      const file = this.locate(String(entry.show_id), String(entry.guid));
      if (!file) return null;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path came from this provider's own directory walk.
      const stat = fs.statSync(file);
      return { mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      return null;
    }
  }

  /**
   * One directory listing per show directory, lowercased name -> real name.
   *
   * CACHED BECAUSE THE CORPUS IS BIG NOW (#703). `locate` used to `readdirSync`
   * on every call; `stuff-you-should-know` holds 2,857 bodies, and warming its
   * index asks `locate` 2,857 times, so the un-cached version is 8.2 million
   * directory entries for one show. The listing is read once per process, which
   * is the same freshness every other read here has.
   */
  private filesIn(dir: string): Map<string, string> {
    let files = this.filesByDir.get(dir);
    if (!files) {
      files = new Map();
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path came from this provider's own directory walk.
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith(".json")) files.set(f.toLowerCase(), f);
      }
      this.filesByDir.set(dir, files);
    }
    return files;
  }

  private showDir(showId: string): string | null {
    if (this.dirByShow.has(showId)) return this.dirByShow.get(showId) ?? null;
    let found: string | null = null;
    if (fs.existsSync(this.root)) {
      for (const d of fs.readdirSync(this.root)) {
        if (d === showId || d.startsWith(`${showId}-`)) {
          found = path.join(this.root, d);
          break;
        }
      }
    }
    this.dirByShow.set(showId, found);
    return found;
  }

  private locate(showId: string, guid: string): string | null {
    const key = `${showId}\u0000${guid}`;
    if (this.locatedByKey.has(key)) return this.locatedByKey.get(key) ?? null;
    const found = this.locateUncached(showId, guid);
    this.locatedByKey.set(key, found);
    return found;
  }

  private locateUncached(showId: string, guid: string): string | null {
    const dir = this.showDir(showId);
    if (!dir) return null;
    /* The listing is cached per directory (#703); the rule itself lives in
       `locateInListing` so a streamed index build (GV-05, `cli/indexBodies.ts`)
       maps archive rows onto bodies by exactly the same rule with no
       directory on disk. */
    const files = this.filesIn(dir);
    const real = locateInListing({
      files,
      guid,
      bodyGuidOf: (name) => bodyGuid(path.join(dir, name)),
      guidIndex: () => {
        let index = this.guidIndexByDir.get(dir);
        if (!index) {
          index = guidIndexOfListing(files, (name) => bodyGuid(path.join(dir, name)));
          this.guidIndexByDir.set(dir, index);
        }
        return index;
      }
    });
    return real === null ? null : path.join(dir, real);
  }
}

/** One show directory's listing, as `locateInListing` reads it. */
export interface ListingLocateInput {
  /** Lowercased file name -> real file name, `.json` files only, in listing order. */
  files: ReadonlyMap<string, string>;
  /** The archive row's guid. */
  guid: string;
  /** The guid a body records about itself (its `guid` field), or null when it
   * records none or cannot be read. Asked only of prefix candidates and, on the
   * last resort, of every file. */
  bodyGuidOf: (realName: string) => string | null;
  /** The listing's recorded-guid -> real-name index, for a caller that keeps it
   * across lookups. Built from `bodyGuidOf` on first need when absent. */
  guidIndex?: () => ReadonlyMap<string, string>;
}

/**
 * Which file in one show's listing holds the body of the episode `guid` — the
 * real file name, or null.
 *
 * THE RULE (#703, gen-7), in order:
 *   1. the writer's own key, `corpusSafeKey(guid).json` (an exact name);
 *   2. the legacy bare slug, `<slug>.json` (also an exact name);
 *   3. a `<slug>-` prefix candidate, but only when the guid the body records IS
 *      this guid (guid "ep-5" must not open "ep-5-bonus-<hash>.json");
 *   4. the guid every body records about itself, indexed once per listing.
 *
 * Pure over its input: `FileTranscriptCueProvider` passes a cached directory
 * listing, and GV-05's streamed index build passes the file names it was sent.
 * Committed rows and bodies can disagree on the guid (Becker's: a permalink in
 * the row, a slug in the body), which is why step 1 keys on the ROW's guid and
 * step 4 on the BODY's.
 */
export function locateInListing(input: ListingLocateInput): string | null {
  const { files, guid, bodyGuidOf } = input;
  /* THE WRITER'S OWN KEY FIRST (#703). `corpusSafeKey` is byte-identical to
     `fetch-transcripts.mjs`'s `safeKey`, the function that named this file,
     so this is an exact lookup rather than a prefix guess — and it costs one
     `Map.get` on a listing the provider caches, instead of a linear `find`
     over 2,857 names per episode. */
  const exact = files.get(`${corpusSafeKey(guid)}.json`);
  if (exact) return exact;
  const slug = guidSlug(guid);
  if (slug) {
    /* gen-7 (round-3 audit): the legacy bare-slug name is an exact name, and
       is trusted as one. A PREFIX match is not: guid "ep-5" is a prefix of
       "ep-5-bonus-<hash>.json", which is another episode's body. So a
       prefix candidate is opened and used only when the guid it records is
       this guid. */
    const legacy = files.get(`${slug}.json`);
    if (legacy) return legacy;
    for (const [lower, real] of files) {
      if (!lower.startsWith(`${slug}-`)) continue;
      if (bodyGuidOf(real) === guid) return real;
    }
  }
  // Fallback: index the listing's recorded guids once, then look the guid up.
  const index = input.guidIndex ? input.guidIndex() : guidIndexOfListing(files, bodyGuidOf);
  return index.get(guid) ?? null;
}

/** Recorded guid -> real file name over a listing. A later file recording the
 * same guid wins, as the provider's directory index always did. */
export function guidIndexOfListing(
  files: ReadonlyMap<string, string>,
  bodyGuidOf: (realName: string) => string | null
): Map<string, string> {
  const index = new Map<string, string>();
  for (const real of files.values()) {
    const recorded = bodyGuidOf(real);
    if (recorded !== null) index.set(recorded, real);
  }
  return index;
}

/**
 * The prefix `tools/segments/` MAY have used for the file name, when the guid's
 * slug is short enough that eighty characters and sixty are the same string.
 *
 * KEPT ONLY AS A SECOND CHANCE (#703). The writer's rule is `corpusSafeKey`,
 * and it truncates at SIXTY before appending its hash; this truncated at
 * eighty, so for every guid whose slug runs past sixty characters the prefix
 * asked for here is longer than the name on disk and `startsWith` can never
 * match. That is not hypothetical: Becker's Healthcare guids are permalink URLs,
 * and 0 of its 990 bodies resolved until `locate` asked for the writer's key
 * first. It stays because a body written before the hash suffix existed is
 * named by the bare slug, and that file is still readable.
 */
function guidSlug(guid: string): string {
  return String(guid ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** The guid a normalized body records about itself, or null. */
function bodyGuid(file: string): string | null {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path came from the provider's own directory walk.
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as { guid?: unknown };
    return typeof j.guid === "string" ? j.guid : null;
  } catch {
    return null;
  }
}

function readCues(file: string): TranscriptCue[] | null {
  return cuesFromBodyJson(JSON.parse(fs.readFileSync(file, "utf8")));
}

/**
 * The cues a parsed normalized body yields, through the ONE reading rule every
 * reader of a body shares: a cue with no text, a non-numeric or non-finite
 * timing, or an end before its start is skipped, and a letter-spaced cue is
 * dropped (#703). Null when the body has no cue array or nothing survives.
 *
 * Exported for GV-05's streamed index build, which receives bodies as JSON over
 * a stream and must count exactly the words `FileTranscriptCueProvider` would.
 */
export function cuesFromBodyJson(json: unknown): TranscriptCue[] | null {
  /* A JSON `null` body threw a TypeError here once, which every caller caught
     as "no cues"; null is that same answer, said directly. */
  if (json === null || typeof json !== "object") return null;
  const j = json as { cues?: unknown };
  if (!Array.isArray(j.cues)) return null;
  const cues: TranscriptCue[] = [];
  for (const c of j.cues as Array<Record<string, unknown>>) {
    const text = typeof c?.text === "string" ? c.text : null;
    const start = typeof c?.start_sec === "number" ? c.start_sec : null;
    const end = typeof c?.end_sec === "number" ? c.end_sec : null;
    if (text === null || start === null || end === null || !Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    /* #703: LETTER-SPACED JUNK NEVER LEAVES THE READER. `sigma-nutrition-radio`
       #595 opens with its PDF cover page spelled out one character at a time
       ("T r a n s c r i p t - E p i s o d e # 5 9 5"); that cue was indexed,
       ranked second under "Medicine" for a germ-theory Foray, and quoted into
       the spine prompt as tape. Dropped here rather than in the index so the
       one rule covers every reader of a body at once — the text index, §4.2's
       window quotes and §4.5's minted anchors — and so a clip can never be cut
       to a boundary phrase nobody spoke. The cost is measured and named in
       `isLetterSpacedCue`: 0.0219 % of this corpus's cues, all of them someone
       spelling a word out loud. */
    if (isLetterSpacedCue(text)) continue;
    const speaker = typeof c?.speaker === "string" && c.speaker.trim().length > 0 ? c.speaker.trim() : null;
    /* GV-111: word timings, only when they can be trusted (`cueWordsOf`);
       the key is absent otherwise, so a body without words reads exactly as
       it did. */
    const words = cueWordsOf(c?.words, { text, start_sec: start, end_sec: end });
    cues.push(words ? { text, start_sec: start, end_sec: end, speaker, words } : { text, start_sec: start, end_sec: end, speaker });
  }
  return cues.length ? cues : null;
}

/* `canonicalizeForAnchorMatch` (imported from `types/anchorText.ts`, F-81)
 * mirrors `tools/segments/merge-segments.mjs`'s `canonical()` exactly, and
 * `backend/test/anchorTextParity.test.ts` pins the two against each other.
 * Import it from `types/anchorText`; this module does not re-export it. */
function canonicalWords(text: string): string[] {
  const c = canonicalizeForAnchorMatch(text);
  return c ? c.split(" ") : [];
}

/* ------------------------------------------------------------------ tier 2
   PICKING THE WINDOW, THEN QUOTING THE TAPE (findings F-61, F-62).

   WHAT WAS WRONG. The rule this replaces asked the tape for a run of four or
   more of the CLAIM's own words, spoken verbatim and in order, and used that
   run for two unrelated jobs at once: deciding that the episode carries the
   beat, and marking where the segment starts and stops. Claims are written
   prose and tape is speech, so the run almost never exists — with WS-H's text
   search in front of it, all 23 searching beats of generation run 2 reached
   real *Practical AI* transcripts (BM25 13-21) and every one of them died at
   `tier2:no-anchor` (F-61). When the run DID exist it was usually a generic
   one ("the original design required") that occurs in any hour of talk, which
   is F-24.

   WHAT REPLACES IT, AND WHY IT IS TWO THINGS AND NOT ONE.

     RELEVANCE is a question about a WINDOW: does this stretch of tape carry
     what the claim is about? Answered by sliding a window over the cue
     sequence and scoring it by how much of the claim's own vocabulary is
     spoken inside it — `selectTapeWindow` — against a floor that a passing
     mention cannot clear (`tapeWindowIsRelevant`).

     ANCHORS are a question about the WINDOW'S EDGES: which spoken phrases
     will let a listener's differently-assembled copy be searched for this
     boundary? ADR-0007 is explicit that these are content, not time — "the
     ~8-12 words at each edge", a substring of the transcript. So they are
     minted from the tape's own words at the boundary cues (`cutWindowToSegment`),
     never from the claim. A claim-derived anchor could not be found in the
     listener's copy at all, which is the ADR's whole subject.

   The two gates keep their trace names: `window-overlap` is now the relevance
   floor (the window is not about the claim) and `no-anchor` means the window
   IS about the claim but its edges yield no quotable phrase — a rare,
   structural failure of a word-level transcript rather than a judgement. */

/**
 * THE CLAIM SEARCH'S BAND, AND THE TAPE WINDOW'S BAND, ARE TWO DIFFERENT THINGS
 * (Q-01, docs/curation/listening-quality-plan.md).
 *
 * `selectTapeWindow` answers one question — WHERE in the episode is the claim
 * spoken — by scoring every cue run in a band by the claim's distinct content
 * words. That question wants a short band: below half a minute a "window" is
 * one or two sentences, and one or two sentences can share three words with
 * almost anything (the arithmetic that made the old four-word run meaningless);
 * above three minutes a window always wins on term coverage while being about
 * everything, which is the wrong window for a search whose whole job is to
 * locate. So the SEARCH keeps its 30-180 s band, `TAPE_CLAIM_SEARCH_MIN_SEC` /
 * `TAPE_CLAIM_SEARCH_MAX_SEC` — the values the search was measured with.
 *
 * The TAPE WINDOW a listener hears is a different object: the claim's window
 * extended to the boundaries of the thought it sits in and then for as long as
 * the content stays relevant (`tapeExtent.ts`, `extendToThought`). Its band is
 * `TAPE_WINDOW_MIN_SEC` / `TAPE_WINDOW_MAX_SEC`: a floor of a minute — the
 * least a listener can be dropped into and hear a thought rather than a
 * soundbite — and a ceiling of thirty minutes, the founder's own number
 * (2026-09-12: "if there's a half hour of relevant content then let it ride").
 * The two are the only hand-set numbers in the extension; everything between
 * them is measured from the tape.
 */
export const TAPE_CLAIM_SEARCH_MIN_SEC = 30;
export const TAPE_CLAIM_SEARCH_MAX_SEC = 180;
/** The floor on a tape window a listener hears — see the note above. Was 30 s
 * (the search's floor) until Q-01 split the two bands. */
export const TAPE_WINDOW_MIN_SEC = 60;
/** And the ceiling — thirty minutes, the founder's "let it ride". Was 180 s. */
export const TAPE_WINDOW_MAX_SEC = 1800;

/**
 * A minted tier-2 segment is a SEGMENT, not a soundbite (F-24(c): run 1's
 * minted spans were "`startSec` of the anchor's first word to `endSec` of its
 * last — a few seconds of audio, not a segment"). The real pool's shortest
 * segment is 50 s and its median is 124 s.
 *
 * Q-01 moved this from 45 s to `TAPE_WINDOW_MIN_SEC` (60 s): the segment's
 * floor and the tape window's floor are the same floor, because the segment IS
 * the extended window cut to whole cues. A minute is the least a listener can
 * be dropped into and hear a thought rather than a soundbite; it is also
 * `check-forays.mjs`'s D2 "short" line, so a tier-2 segment can no longer start
 * a run of short ones by construction.
 */
export const MIN_TAPE_SEGMENT_SEC = TAPE_WINDOW_MIN_SEC;
/** And the ceiling is the tape window's (Q-01): thirty minutes, the founder's
 * "let it ride". Was 240 s — the pool's longest hand cut plus a margin — while
 * the window was sized to cover the claim's words rather than the thought. */
export const MAX_TAPE_SEGMENT_SEC = TAPE_WINDOW_MAX_SEC;

/**
 * The floor below which a span is not tape at all, and the only reason
 * `cutWindowToSegment` will ever attach a cue that shares nothing with the
 * claim (F-62).
 *
 * Half a minute of speech is around eighty words: a paragraph, and the least a
 * listener can be dropped into and get anything from. Between this and
 * `MIN_TAPE_SEGMENT_SEC` the code prefers a short segment over an off-claim
 * one; below it, a segment that is too short to play beats an accurate one
 * nobody can hear.
 */
export const ABSOLUTE_MIN_TAPE_SEGMENT_SEC = 30;

/**
 * The widest hole in a transcript that the optional second growth phase (F-73)
 * will step across.
 *
 * A transcript's cues are contiguous while somebody is speaking, so a gap between
 * one cue's end and the next one's start is not silence between sentences — it is
 * a break in the tape: an ad the transcriber skipped, a missing chunk, a long
 * musical bed. Growing across one buys SECONDS without buying any words, and the
 * segment then claims a span the transcript cannot account for; the F-68 fixture
 * has a 140 s hole between two stretches of the same interview and growth was
 * happily swallowing it.
 *
 * Five seconds is longer than the pause between two sentences and far shorter
 * than any real break, and it is applied to the SECOND phase only — the first
 * phase is reaching the floor below which a span is not playable tape at all, and
 * F-62 already decided what it may take to get there.
 */
export const TAPE_CUE_GAP_MAX_SEC = 5;

/** Same floor as `merge-segments.mjs`'s `MIN_ANCHOR_WORDS` — an anchor shorter
 * than four words cannot locate anything. */
export const MIN_ANCHOR_WORDS = 4;
/** Words quoted as a boundary anchor. ADR-0007 asks for 8-12; take the floor. */
export const MAX_ANCHOR_WORDS = 8;
/** An anchor of nothing but function words ("and so it was that we were") is
 * findable in every minute of every episode, which makes it useless as a
 * locator. Two content words is the least that distinguishes one moment of
 * speech from another. */
export const ANCHOR_MIN_CONTENT_WORDS = 2;
/** How far past the boundary cue's own edge the search for a quotable phrase
 * may look. Two anchors' worth: far enough to step over "and so I think that",
 * near enough that the phrase still marks the boundary. */
export const ANCHOR_SEARCH_SPAN = 16;

/** Distinct DISTINCTIVE claim content words that must be SPOKEN INSIDE the
 * window before it is allowed to be tape. Same integer as the two §4.5
 * scorers' thresholds and for the same reason: below three shared content
 * words, agreement is what any two people talking about one trade produce
 * (F-33). */
export const TIER2_WINDOW_MIN_TERMS = 3;

/**
 * How rare a claim word has to be, relative to the rarest word that claim has,
 * to count toward `TIER2_WINDOW_MIN_TERMS`.
 *
 * WHY THE COUNT NEEDS THIS AND THE SHARE DOES NOT. The share can be carried by
 * ONE very rare word: a claim about agents failing on an upstream schema change
 * matched a passage about de-duplicating test fixtures at 0.371 — over the
 * floor — on `upstream` alone, a word the corpus almost never uses and the
 * guest used in a different sense entirely. Requiring three words that are
 * rare *for this claim* is the independent axis that refuses it: two rules that
 * fail differently, rather than one number asked to do everything.
 *
 * Relative, not an absolute idf, so it means the same thing in a fifteen-episode
 * show and a nine-hundred-episode one — and so a caller with no index (every CI
 * run) sees every matched word count, which is exactly the pre-index behaviour.
 */
export const TIER2_DISTINCTIVE_WEIGHT = 0.5;

/**
 * And the same three words as a SHARE of what the claim actually says.
 *
 * The count alone cannot separate "this window is about the claim" from "this
 * episode mentioned the subject once": a twenty-word claim whose first three
 * words turn up in a listener-mail aside scores exactly the same three as one
 * whose whole argument is spoken. Tier 1 met this on its own transcript
 * windows and answered it with coverage (`TIER1_WINDOW_COVERAGE = 0.25`), and
 * this is the same rule for the same reason — set higher because tier 1's
 * window is a segment a curator already chose, while this one is chosen by
 * this search and has to earn it.
 *
 * THE VALUE IS MEASURED, NOT GUESSED — every number below is from the offline
 * replay in this fix's PR, over the 63 *Practical AI* bodies on the generation
 * machine and the run-2 deepen fixture:
 *
 *   0.756  the claim the show does make (AI incident reporting as aviation's
 *          regression test) against the passage where it makes it;
 *   0.349  the nearest miss: a claim about quantization and distillation
 *          against a passage where a guest describes distilling into a small
 *          model — adjacent, arguably usable, refused;
 *   0.257  the worst FALSE positive the plain share admitted: a claim about
 *          label defect rates matching on `training, rate, good, sets, model,
 *          accuracy`;
 *   0.089-0.225  every other one of the 23 searching beats.
 *
 * 0.35 sits above the false positive by a third and below the real one by a
 * factor of two. F-24's own passing-mention fixture scores 0.31 unweighted and
 * is refused. A refused beat is narrated, which is §4.5's own guardrail: no
 * tape beats wrong tape.
 */
export const TIER2_WINDOW_MIN_SHARE = 0.35;

/** Cues with their canonical words and content words, once, so the window
 * search, the cut and the thought extension (`tapeExtent.ts`) agree about
 * which cue is cue `n`. Cues with no words at all are dropped (a music/silence
 * marker is not a boundary). Exported for `tapeExtent.ts` only, which has to
 * count cues exactly as the search that handed it `firstCue`/`lastCue` did. */
export interface CueIndex {
  cues: TranscriptCue[];
  words: string[][];
  terms: Array<Set<string>>;
}

export function indexCues(cues: TranscriptCue[]): CueIndex {
  const kept: TranscriptCue[] = [];
  const words: string[][] = [];
  const terms: Array<Set<string>> = [];
  for (const cue of cues) {
    const w = canonicalWords(cue.text);
    if (w.length === 0) continue;
    kept.push(cue);
    words.push(w);
    terms.push(new Set(tokenizeForSourcing(cue.text)));
  }
  return { cues: kept, words, terms };
}

/** One stretch of an episode, and how much of the claim is spoken in it. */
export interface TapeWindow {
  /** Indices into the cue sequence AFTER empty cues are dropped. */
  firstCue: number;
  lastCue: number;
  startSec: number;
  endSec: number;
  /** The claim's own content words that are spoken inside the window, in the
   * claim's order — the trace prints these, because "which words matched" is
   * the only form of this judgement a person can argue with. */
  matchedTerms: string[];
  /** Those of them the corpus considers rare for this claim
   * (`TIER2_DISTINCTIVE_WEIGHT`) — the subset the term count is measured on,
   * and every matched term when no idf was supplied. */
  distinctiveTerms: string[];
  /** How many distinct content words the claim has at all. */
  claimTermCount: number;
  /** `matchedTerms.length / claimTermCount`, every word counting the same. */
  share: number;
  /**
   * The share again, with each claim word weighted by how rare it is in the
   * corpus the candidate came from (`TranscriptTextCandidate.idf`) — the
   * fraction of the claim's DISTINCTIVENESS the window speaks, not the fraction
   * of its word count.
   *
   * This is the number the relevance floor uses, and the difference between the
   * two is a false positive this search made before it existed: a claim about
   * label defect rates matched a *Practical AI* episode on `training, rate,
   * good, sets, model, accuracy` — six words, 0.38 of the claim, and not one of
   * them about the claim. Inside one subject every episode shares the trade's
   * vocabulary (F-33); what separates the episode that is ABOUT a claim is the
   * rare words, and idf is the corpus saying which those are. With no idf (the
   * title path, a caller with no index) this equals `share`.
   */
  weightedShare: number;
  /** The idf-weighted overlap itself, which is what windows are ranked by. */
  score: number;
  /**
   * WHERE THE WINDOW'S EDGES LANDED, once `extendToThought` (`tapeExtent.ts`,
   * Q-01) has moved them: `"turn"` — both edges are speaker-turn boundaries
   * (the host's question that prompted the answer, the end of the answer);
   * `"sentence"` — at least one edge is a sentence boundary marked by a pause
   * rather than a turn; `"claim-only"` — an edge could not be moved to any
   * boundary and stayed where the claim search left it. Absent on a window
   * straight out of `selectTapeWindow`, which knows nothing about thoughts.
   */
  boundary?: TapeBoundary;
  /** Each edge's own kind (MQ-06, GV-109); `boundary` is the weaker of the
   * two. Absent until extended, and absent on a window extended before these
   * fields existed — a reader then knows only `boundary`. */
  startBoundary?: TapeBoundary;
  endBoundary?: TapeBoundary;
  /** How many seconds the extension added over the claim window it started
   * from, both directions together. Absent until extended. */
  extendedBySec?: number;
  /** The claim window's own edges, kept so the trace can say what the search
   * found and what the extension did with it. Absent until extended. */
  claimStartSec?: number;
  claimEndSec?: number;
}

/** See `TapeWindow.boundary`. Declared in `types/tapeSourcing.ts` (the three
 * values are the vocabulary `check-forays.mjs` accepts on a minted row's
 * `boundary`, G-21c) and re-exported here for the modules that work in cues. */
export type { TapeBoundary };

export interface SelectTapeWindowOptions {
  /** Inverse document frequency per term, from the text index that produced the
   * candidate (`TranscriptTextCandidate.idf`). Absent — a title-path candidate,
   * or a caller with no index — every term weighs one. */
  idf?: ReadonlyMap<string, number>;
  /**
   * The duration band a window may occupy, defaulting to
   * `TAPE_CLAIM_SEARCH_MIN_SEC`/`TAPE_CLAIM_SEARCH_MAX_SEC` — the §4.5 search
   * band, which is what every tier-2 caller uses and what every existing test
   * measures. (Until Q-01 these were `TAPE_WINDOW_MIN/MAX_SEC`; the tape window
   * a listener hears now has its own band, and this search keeps the one it was
   * measured with — see the note on `TAPE_CLAIM_SEARCH_MAX_SEC`.)
   *
   * Overridable for ONE caller and one reason (WS-L): §4.2's research map
   * quotes windows into the spine prompt, where a window is something a person
   * reads rather than a candidate segment, so it wants a tighter band (a
   * minute or two of speech) than a segment a listener will hear. Nothing about
   * the scoring, the relevance floor or the anchoring changes with it, and no
   * §4.5 path passes it.
   */
  minSec?: number;
  maxSec?: number;
  /**
   * Confine the search to one stretch of the episode: only cue runs that lie
   * inside `[startSec, endSec]` (within `WINDOW_WITHIN_TOLERANCE_SEC`) are
   * scored, and `null` comes back when the range holds no usable cue at all.
   *
   * ONE CALLER, ONE REASON (F-68): §4.5 asks a seeded beat's OWN window first —
   * the stretch §4.3 quoted into the spine prompt and wrote the claim from — so
   * that when the tape there carries the claim, that is the tape the listener
   * gets, rather than whichever other minute of the same episode happens to
   * score higher. Nothing about the scoring or the weighting changes with it —
   * the window is found and scored exactly as an unconfined one is — and §4.5
   * falls back to the whole-episode search when it does not clear.
   *
   * The FLOOR it then faces is the one difference, and it is F-72's: a window
   * confined to the seed is judged by `tapeWindowIsRelevant(window,
   * "seed-window")`, on share alone. See `TapeWindowFloor` for why the
   * rare-word count is a guard on searching and not on a window the spine
   * quoted. Neither constant moves, and this option is still the only way to
   * reach that floor.
   */
  within?: { startSec: number; endSec: number };
}

/**
 * How far outside `SelectTapeWindowOptions.within` a cue boundary may sit and
 * still count as inside it. A seed's seconds are this module's own window
 * boundaries rounded to one decimal on the way into the spine prompt
 * (`researchShape.ts`), so exact comparison would drop the very cues the seed
 * names. One second is far below the archive's ~28 s mean cue, so it can
 * forgive that rounding without ever admitting a neighbouring cue.
 */
export const WINDOW_WITHIN_TOLERANCE_SEC = 1;

/**
 * HOW MUCH EACH OF A CLAIM'S WORDS COUNTS, given the corpus's idf for it.
 *
 * WEIGHTS, NORMALISED SO ONE FLOOR CAN SERVE EVERY CORPUS. A term's idf depends
 * on how many episodes the search touched, so a raw idf would make
 * `TIER2_WINDOW_MIN_SHARE` mean something different for a fifteen-episode show
 * than for a nine-hundred-episode one. Dividing by the rarest term the query
 * has puts every weight on 0..1: the claim's rarest word counts one, the
 * trade's everyday words count a twentieth of that.
 *
 * A term the corpus never says weighs ONE — as rare as it gets. It can never be
 * matched, so it only ever counts against the window, which is right: a claim
 * built on names nobody in this archive utters is a claim this archive is not
 * about. With no idf at all (a title-path candidate, a caller with no index)
 * every term weighs one and the weighted share is the plain share.
 *
 * ONE DEFINITION, TWO CALLERS (G-24 R2): `selectTapeWindow` below, which is
 * where it was written, and tier 1's transcript-window bar
 * (`segmentPoolLookup.ts`), which adopted the same weighted share and rare-word
 * floor after an unweighted count admitted a Hyatt Regency walkway segment
 * under an agent-engineering claim on `engineering, good, enough, step`. Two
 * copies of this arithmetic would be two floors that drift.
 */
export function claimTermWeigher(claimTerms: readonly string[], idf: ReadonlyMap<string, number> | undefined): (term: string) => number {
  const rarest = Math.max(...claimTerms.map((t) => idf?.get(t) ?? 0), 0);
  return (term: string): number => {
    const w = idf?.get(term);
    if (typeof w !== "number" || !Number.isFinite(w) || w <= 0) return 1;
    return rarest > 0 ? Math.min(1, w / rarest) : 1;
  };
}

/**
 * The stretch of `cues` that carries `claimText` best, or `null` when the
 * episode has no usable cues or the claim no content words.
 *
 * WHAT IS BEING RANKED. Every cue run between `TAPE_CLAIM_SEARCH_MIN_SEC` and
 * `TAPE_CLAIM_SEARCH_MAX_SEC` is scored by the claim's DISTINCT content words spoken
 * inside it (idf-weighted when the index supplied weights). Distinct, not
 * total, because a host repeating one word twenty times is one fact about the
 * tape, not twenty. The best-scoring window wins; ties go to the one with more
 * matched terms and then to the SHORTER window, because at equal coverage the
 * tighter stretch is the one actually about the claim — which is also what
 * keeps a window from growing itself into looking relevant.
 *
 * This returns the best window WHATEVER its score. The floor is
 * `tapeWindowIsRelevant`, kept separate so the trace can report the window a
 * refused beat actually had (F-49) instead of a bare "nothing".
 *
 * `options.within` confines the search to one stretch of the episode without
 * changing anything else about it (F-68) — see the option's own note.
 */
export function selectTapeWindow(claimText: string, cues: TranscriptCue[], options: SelectTapeWindowOptions = {}): TapeWindow | null {
  const index = indexCues(cues);
  const n = index.cues.length;
  if (n === 0) return null;
  const minSec = options.minSec ?? TAPE_CLAIM_SEARCH_MIN_SEC;
  const maxSec = options.maxSec ?? TAPE_CLAIM_SEARCH_MAX_SEC;
  /* The confined search (F-68). Both bounds are inclusive of a cue that starts
     or ends a hair outside them, per `WINDOW_WITHIN_TOLERANCE_SEC`. */
  const within = options.within;
  const withinStart = within ? within.startSec - WINDOW_WITHIN_TOLERANCE_SEC : 0;
  const withinEnd = within ? within.endSec + WINDOW_WITHIN_TOLERANCE_SEC : 0;

  /* The claim's terms in the claim's own order, deduplicated — the order is
     what makes `matchedTerms` readable in a trace row. */
  const claimTerms: string[] = [];
  const claimTermSet = new Set<string>();
  for (const t of tokenizeForSourcing(claimText)) {
    if (claimTermSet.has(t)) continue;
    claimTermSet.add(t);
    claimTerms.push(t);
  }
  if (claimTerms.length === 0) return null;

  const weightOf = claimTermWeigher(claimTerms, options.idf);
  let totalWeight = 0;
  for (const term of claimTerms) totalWeight += weightOf(term);
  if (totalWeight <= 0) return null;

  let best: TapeWindow | null = null;
  for (let i = 0; i < n; i++) {
    if (within && index.cues[i]!.start_sec < withinStart) continue;
    const matched = new Set<string>();
    let score = 0;
    /* The widest window from `i` that never reached the minimum duration —
       used only when nothing from `i` could: the end of a short transcript, or
       a stretch closed off by a gap wider than the maximum (an ad break, a
       missing chunk). Cleared as soon as a full-length window exists. */
    let short: TapeWindow | null = null;
    for (let j = i; j < n; j++) {
      for (const term of index.terms[j]!) {
        if (!claimTermSet.has(term) || matched.has(term)) continue;
        matched.add(term);
        score += weightOf(term);
      }
      const startSec = index.cues[i]!.start_sec;
      const endSec = index.cues[j]!.end_sec;
      const duration = endSec - startSec;
      if (within && endSec > withinEnd) break;
      if (j > i && duration > maxSec) break;
      const matchedTerms = claimTerms.filter((t) => matched.has(t));
      const window: TapeWindow = {
        firstCue: i,
        lastCue: j,
        startSec,
        endSec,
        matchedTerms,
        distinctiveTerms: matchedTerms.filter((t) => weightOf(t) >= TIER2_DISTINCTIVE_WEIGHT),
        claimTermCount: claimTerms.length,
        share: matched.size / claimTerms.length,
        weightedShare: score / totalWeight,
        score
      };
      if (duration >= minSec) {
        best = betterWindow(best, window);
        short = null;
      } else {
        short = window;
      }
    }
    if (short) best = betterWindow(best, short);
  }
  return best;
}

function betterWindow(current: TapeWindow | null, next: TapeWindow): TapeWindow {
  if (!current) return next;
  if (next.score !== current.score) return next.score > current.score ? next : current;
  if (next.matchedTerms.length !== current.matchedTerms.length) {
    return next.matchedTerms.length > current.matchedTerms.length ? next : current;
  }
  const nextDuration = next.endSec - next.startSec;
  const currentDuration = current.endSec - current.startSec;
  if (nextDuration !== currentDuration) return nextDuration < currentDuration ? next : current;
  return current;
}

/**
 * WHICH FLOOR A WINDOW FACES (F-72). The two values are not two strictnesses;
 * they are two different questions, and only one of them is open.
 *
 *   `"archive-search"` — the default, and every window this module finds by
 *   SEARCHING: the whole-episode fallback, the whole-archive text search, the
 *   title fallback, every window of every unseeded beat. Nothing about it has
 *   changed: a window is tape about the claim when it speaks
 *   `TIER2_WINDOW_MIN_TERMS` of the claim's RARE words AND
 *   `TIER2_WINDOW_MIN_SHARE` of the claim's distinctiveness. The rare-word
 *   count is the independent axis that refuses a window a search turned up
 *   because it happens to share the trade's everyday vocabulary with the claim
 *   — run 1's Chernobyl-for-Hyatt anchor, the griddle, San Bruno, F-24's
 *   passing mention. That guard stays exactly where it was.
 *
 *   `"seed-window"` — the ONE window that was not found by searching: the
 *   stretch §4.3 read and wrote this very claim out of (`SelectTapeWindowOptions.within`,
 *   F-68). THE SEED IS THE RELEVANCE JUDGEMENT. The rare-word test asks "did a
 *   search land on this window for a good reason?", and for the seed window
 *   that question is already answered — by the spine, which had the tape in
 *   front of it. Applying a search's guard to a window the spine quoted asks
 *   the wrong question of it, and run 2 attempt 5 is the bill: three seeded
 *   beats refused at weighted shares of 0.53, 0.72 and 0.85 for speaking one or
 *   two rare words rather than three ("internship" alone carried 0.846 of a
 *   claim written from that very passage). So the seed window is judged on
 *   share alone. The share floor does NOT move — a seed whose tape does not
 *   carry the claim (0.217 in the same run) is still refused, and it is still
 *   a preference rather than a permission: a seed window below the share floor
 *   falls back to the whole-episode search, which faces `"archive-search"`
 *   again like everything else.
 *
 * Neither constant changes, and no caller can lower either one — the only lever
 * is which of the two questions is being asked.
 */
export type TapeWindowFloor = "archive-search" | "seed-window";

/** Tier 2's relevance verdict on a window: enough of the claim, and enough of
 * it as a SHARE, to call the tape there about the claim. `floor` picks which
 * of the two questions above is being asked; it defaults to the searching one,
 * so every caller that does not name a floor is judged exactly as before. */
export function tapeWindowIsRelevant(window: TapeWindow | null, floor: TapeWindowFloor = "archive-search"): boolean {
  if (!window) return false;
  /* The share floor is common to both and is never waived. */
  if (window.weightedShare < TIER2_WINDOW_MIN_SHARE) return false;
  if (floor === "seed-window") return true;
  return window.distinctiveTerms.length >= TIER2_WINDOW_MIN_TERMS;
}

/**
 * Whether the seed floor is what DECIDED this window: it clears the share bar
 * but not the rare-word count, so a searching window with these numbers would
 * have been refused.
 *
 * Reported in the trace (`seedFloor`) rather than inferred by a reader, so a
 * run log can count how often F-72's rule changed an outcome — as opposed to
 * how often it merely applied, which is every seeded beat and tells nobody
 * anything.
 */
export function seedFloorDecided(window: TapeWindow | null): boolean {
  return tapeWindowIsRelevant(window, "seed-window") && !tapeWindowIsRelevant(window, "archive-search");
}

/** A cut window: real cue boundaries, and two phrases the tape itself speaks at
 * them (ADR-0007's content anchors). */
export interface TapeSpan {
  startSec: number;
  endSec: number;
  startAnchor: string;
  endAnchor: string;
  /** The cue run the span ended up covering — wider than the window when
   * `growByClaimOverlap` had to reach `MIN_TAPE_SEGMENT_SEC`. */
  firstCue: number;
  lastCue: number;
  /** Carried from the window when it was extended to a thought (Q-01) — see
   * `TapeWindow.boundary`. `extendedBySec` counts the growth this cut added on
   * top of the extension as well, so it is always "seconds past the claim
   * window". Absent for a cut of an unextended window. */
  boundary?: TapeBoundary;
  /** Each edge's own kind (MQ-06, GV-109), carried from the window's
   * `startBoundary` / `endBoundary` when it has them; an edge the floor growth
   * moved is `"claim-only"`, the edge it left keeps its kind. */
  startBoundary?: TapeBoundary;
  endBoundary?: TapeBoundary;
  extendedBySec?: number;
}

/**
 * Turns a chosen window into a segment: whole cues, at least
 * `MIN_TAPE_SEGMENT_SEC` where the tape allows it, with an anchor quoted from
 * the tape at each boundary.
 *
 * F-62 IS THE GROWTH RULE. The code this replaces padded a short span
 * symmetrically — one cue before, one cue after, alternating — until it reached
 * the minimum. This archive's cues average ~28 s, so "one cue before" is half a
 * minute of whatever preceded the passage, and the single successful mint of
 * WS-H's replay opened with ~28 s of an unrelated lead-in. Growth now asks the
 * two neighbouring cues which of them shares more of the claim's words and
 * takes that side; when neither shares any, a shorter segment is the better
 * answer and the growth stops (down to `ABSOLUTE_MIN_TAPE_SEGMENT_SEC`, below
 * which a span is not playable tape and the least-bad neighbour is taken
 * anyway). Nothing here pads symmetrically, ever.
 *
 * F-73 ADDED A SECOND, OPTIONAL LENGTH TO GROW TOWARDS (`options.targetSec`) —
 * see `growByClaimOverlap`. Omitted, this function behaves exactly as it did:
 * the target is `MIN_TAPE_SEGMENT_SEC` and the second phase is a no-op.
 */
export interface CutWindowOptions {
  /**
   * A length to keep growing towards ONCE `MIN_TAPE_SEGMENT_SEC` is reached —
   * §4.5's answer to the D-tier duration rules (F-73), which are about the
   * lengths a finished Foray's segments have, not about relevance.
   *
   * It is a TARGET, never a promise: the second phase only ever attaches a cue
   * that shares the claim's own words, so a passage that simply ends stops the
   * growth and the span comes out shorter. That is the point — the lengths are
   * supposed to vary (D5), and a target that padded to a fixed size would
   * reintroduce the uniformity the rule exists to prevent, with the off-claim
   * tape F-62 removed thrown in.
   *
   * Clamped into `[MIN_TAPE_SEGMENT_SEC, MAX_TAPE_SEGMENT_SEC]`, so no caller
   * can ask for a span this module considers too short to be a segment or
   * longer than the pool's longest.
   */
  targetSec?: number;
  /**
   * A ceiling under `MAX_TAPE_SEGMENT_SEC` that the growth may not pass
   * (Q-04). `sourceBeats.ts`'s chooser asks for one when it re-extends a
   * window to escape D5's pair band: the extension stopped under
   * `previous / 1.2`, and the floor growth here must not grow the cut back
   * into the band one cue at a time. Omitted, the ceiling is
   * `MAX_TAPE_SEGMENT_SEC`, exactly as before.
   */
  maxSec?: number;
  /**
   * GV-111 (W5-14b; R2-05, MQ-06): FORAY_PAUSE_SNAP=on, passed by
   * `sourceBeats.ts`. When an edge cue carries word timings
   * (`TranscriptCue.words`), that edge moves from the cue's edge to the word
   * boundary of a real pause (`pauseSnap.ts`'s `snapEdge`: a gap of 0.3 s or
   * more, at most 4 s away, a pause after terminal punctuation preferred),
   * and its anchor is re-minted with `mintStartAnchor` / `mintEndAnchor` from
   * the words that start (or end) at the snapped word — still the cue's own
   * canonical words, so `canonical()` parity holds. A snap after terminal
   * punctuation upgrades that edge's kind to `sentence`; an edge already on a
   * turn is never moved, and one on a sentence boundary moves only to another
   * sentence boundary. An edge whose cue has no words, whose pauses are all
   * too far, or whose snapped words yield no anchor stays exactly where the
   * cue put it. Omitted or false: today's cut.
   */
  snapToPauses?: boolean;
}

export function cutWindowToSegment(
  claimText: string,
  cues: TranscriptCue[],
  window: TapeWindow,
  options: CutWindowOptions = {}
): TapeSpan | null {
  const index = indexCues(cues);
  const n = index.cues.length;
  if (n === 0) return null;
  if (window.firstCue < 0 || window.lastCue >= n || window.firstCue > window.lastCue) return null;

  const claimTerms = new Set(tokenizeForSourcing(claimText));
  const { first, last } = growByClaimOverlap(index, claimTerms, window.firstCue, window.lastCue, options.targetSec, options.maxSec);

  let startSec = index.cues[first]!.start_sec;
  let endSec = index.cues[last]!.end_sec;
  if (!(endSec > startSec)) return null;

  let startAnchor = startAnchorFor(index, first, last);
  let endAnchor = endAnchorFor(index, first, last);
  if (!startAnchor || !endAnchor) return null;

  /* GV-111: the edges' kinds after the floor growth, which the snap reads
     (a turn is never moved, a sentence edge moves only to a sentence) and
     may upgrade. */
  let startKind: TapeBoundary | undefined =
    window.boundary !== undefined && window.startBoundary !== undefined ? (first === window.firstCue ? window.startBoundary : "claim-only") : undefined;
  let endKind: TapeBoundary | undefined =
    window.boundary !== undefined && window.endBoundary !== undefined ? (last === window.lastCue ? window.endBoundary : "claim-only") : undefined;
  let snapped = false;
  if (options.snapToPauses) {
    const snap = snapSpanToPauses(index, first, last, startKind, endKind, options.maxSec ?? MAX_TAPE_SEGMENT_SEC);
    if (snap.start) {
      startSec = snap.start.sec;
      startAnchor = snap.start.anchor;
      if (startKind !== undefined && snap.start.kind === "sentence") startKind = "sentence";
      snapped = true;
    }
    if (snap.end) {
      endSec = snap.end.sec;
      endAnchor = snap.end.anchor;
      if (endKind !== undefined && snap.end.kind === "sentence") endKind = "sentence";
      snapped = true;
    }
  }

  /* `firstCue`/`lastCue` stay the whole-cue run the cut was made from, even
     when a snap moved an edge into a neighbour cue or inside its own: a
     merge re-cuts from them (`sourceBeats.ts`'s `mergeIntoClip`) and must
     land on the same snapped start. */
  const span: TapeSpan = { startSec, endSec, startAnchor, endAnchor, firstCue: first, lastCue: last };
  if (window.boundary !== undefined) {
    /* Growth to the floor moves an edge off the boundary the extension chose;
       a clip that no longer sits on it says so rather than claim a boundary
       (Q-01). */
    span.boundary = first === window.firstCue && last === window.lastCue ? window.boundary : "claim-only";
    /* Per edge (MQ-06, GV-109): only the edge the growth moved loses its
       boundary. `span.boundary` above keeps today's both-edges rule, so the
       minted row's `boundary` is unchanged. */
    if (startKind !== undefined) span.startBoundary = startKind;
    if (endKind !== undefined) span.endBoundary = endKind;
    /* GV-111: a snap re-derives the clip's boundary from its two edges (the
       weaker of them), so an edge the snap put on a sentence counts. */
    if (snapped && startKind !== undefined && endKind !== undefined) span.boundary = weakerOfBoundaries(startKind, endKind);
    /* Everything past the claim window: the extension's own seconds plus
       whatever the growth above added to reach the floor. */
    const claimSec =
      typeof window.claimStartSec === "number" && typeof window.claimEndSec === "number"
        ? window.claimEndSec - window.claimStartSec
        : window.endSec - window.startSec - (window.extendedBySec ?? 0);
    span.extendedBySec = Math.max(0, Math.round((endSec - startSec - claimSec) * 1000) / 1000);
  }
  return span;
}

/** GV-111: the weaker of two boundary kinds (`tapeExtent.ts`'s rank). */
function weakerOfBoundaries(a: TapeBoundary, b: TapeBoundary): TapeBoundary {
  const rank: Record<TapeBoundary, number> = { "claim-only": 0, sentence: 1, turn: 2 };
  return rank[a] <= rank[b] ? a : b;
}

/** GV-111: one snapped edge, with the anchor minted at it. */
interface SnappedSpanEdge {
  sec: number;
  kind: SnappedEdge["kind"];
  anchor: string;
}

/**
 * GV-111: both edges of the whole-cue run `first..last` snapped to pauses,
 * each with its anchor re-minted from the words that start (or end) at the
 * snapped word. An edge that cannot be snapped, or whose words yield no
 * anchor, is absent.
 *
 * The clip may not come out shorter than the shorter of its whole-cue length
 * and `ABSOLUTE_MIN_TAPE_SEGMENT_SEC`, nor longer than the larger of its
 * whole-cue length and `ceilingSec` (the caller's `maxSec`, so an outward
 * snap cannot push a capped cut past its cap); when the two snaps together
 * break that, the end snap is dropped first, then the start.
 */
function snapSpanToPauses(
  index: CueIndex,
  first: number,
  last: number,
  startKind: TapeBoundary | undefined,
  endKind: TapeBoundary | undefined,
  ceilingSec: number
): { start?: SnappedSpanEdge; end?: SnappedSpanEdge } {
  const cueStart = index.cues[first]!.start_sec;
  const cueEnd = index.cues[last]!.end_sec;
  const cueLength = cueEnd - cueStart;
  const minLength = Math.min(cueLength, ABSOLUTE_MIN_TAPE_SEGMENT_SEC);
  const maxLength = Math.max(cueLength, ceilingSec);

  let start: SnappedSpanEdge | undefined;
  if (startKind !== "turn") {
    const edge = snapEdge(index.cues, first, "start", { requireSentence: startKind === "sentence", notBeforeSec: cueEnd - maxLength });
    const anchor = edge ? snappedStartAnchor(index, edge, last) : null;
    if (edge && anchor) start = { sec: edge.sec, kind: edge.kind, anchor };
  }
  let end: SnappedSpanEdge | undefined;
  if (endKind !== "turn") {
    const edge = snapEdge(index.cues, last, "end", { requireSentence: endKind === "sentence", notAfterSec: cueStart + maxLength });
    const anchor = edge ? snappedEndAnchor(index, edge, first) : null;
    if (edge && anchor) end = { sec: edge.sec, kind: edge.kind, anchor };
  }
  const fits = (s: SnappedSpanEdge | undefined, e: SnappedSpanEdge | undefined): boolean => {
    const length = (e?.sec ?? cueEnd) - (s?.sec ?? cueStart);
    return length >= minLength && length <= maxLength;
  };
  if (fits(start, end)) return { ...(start ? { start } : {}), ...(end ? { end } : {}) };
  if (fits(start, undefined)) return start ? { start } : {};
  if (fits(undefined, end)) return end ? { end } : {};
  return {};
}

/** How many of cue `cueIndex`'s canonical words come before its word
 * `wordIndex`. `cueWordsOf` guarantees the words spell the cue's canonical
 * text, and canonicalisation never joins across a space, so this is a clean
 * split of `index.words[cueIndex]`. */
function canonicalWordsBefore(index: CueIndex, cueIndex: number, wordIndex: number): number {
  const words = index.cues[cueIndex]!.words ?? [];
  return canonicalWords(words.slice(0, wordIndex).map((w) => w.text).join(" ")).length;
}

/** GV-111: the start anchor from the words that start at the snapped word —
 * its own cue's rest first, then (like `startAnchorFor`'s spill) on through
 * the clip's cues when that is too short or too generic. */
function snappedStartAnchor(index: CueIndex, edge: SnappedEdge, last: number): string | null {
  const own = index.words[edge.cueIndex]!.slice(canonicalWordsBefore(index, edge.cueIndex, edge.wordIndex));
  const minted = mintStartAnchor(own);
  if (minted) return minted;
  const spill = [...own];
  for (let cue = edge.cueIndex + 1; cue <= last && spill.length < MAX_ANCHOR_WORDS * 4; cue++) spill.push(...index.words[cue]!);
  return mintStartAnchor(spill);
}

/** GV-111: and the end anchor from the words that end at the snapped word. */
function snappedEndAnchor(index: CueIndex, edge: SnappedEdge, first: number): string | null {
  const own = index.words[edge.cueIndex]!.slice(0, canonicalWordsBefore(index, edge.cueIndex, edge.wordIndex + 1));
  const minted = mintEndAnchor(own);
  if (minted) return minted;
  const spill = [...own];
  for (let cue = edge.cueIndex - 1; cue >= first && spill.length < MAX_ANCHOR_WORDS * 4; cue--) spill.unshift(...index.words[cue]!);
  return mintEndAnchor(spill);
}

/** F-62's rule, stated once: grow toward the claim, never symmetrically. */
function growByClaimOverlap(
  index: CueIndex,
  claimTerms: Set<string>,
  firstCue: number,
  lastCue: number,
  targetSec?: number,
  maxSec: number = MAX_TAPE_SEGMENT_SEC
): { first: number; last: number } {
  const n = index.cues.length;
  let first = firstCue;
  let last = lastCue;
  const startOf = (cue: number) => index.cues[cue]!.start_sec;
  const endOf = (cue: number) => index.cues[cue]!.end_sec;
  const duration = () => endOf(last) - startOf(first);
  const sharedWith = (cue: number) => {
    let shared = 0;
    for (const term of index.terms[cue]!) if (claimTerms.has(term)) shared += 1;
    return shared;
  };

  while (duration() < MIN_TAPE_SEGMENT_SEC) {
    const prev = first - 1;
    const next = last + 1;
    const canPrev = prev >= 0 && endOf(last) - startOf(prev) <= maxSec;
    const canNext = next < n && endOf(next) - startOf(first) <= maxSec;
    if (!canPrev && !canNext) break;

    const prevShared = canPrev ? sharedWith(prev) : -1;
    const nextShared = canNext ? sharedWith(next) : -1;

    if (prevShared > 0 || nextShared > 0) {
      /* The side that shares more of the claim. Forward on a tie: a passage
         continues after its topic sentence more often than it is introduced by
         one, and F-62 is a lead-in. */
      if (nextShared >= prevShared) last = next;
      else first = prev;
      continue;
    }
    /* Neither neighbour says anything the claim says. A shorter segment is the
       honest answer — unless what we have is too short to be tape at all, in
       which case take the neighbour with more to say and stop as soon as the
       floor is reached. */
    if (duration() >= ABSOLUTE_MIN_TAPE_SEGMENT_SEC) break;
    const prevWords = canPrev ? index.terms[prev]!.size : -1;
    const nextWords = canNext ? index.terms[next]!.size : -1;
    if (canNext && (!canPrev || nextWords >= prevWords)) last = next;
    else first = prev;
    if (duration() >= ABSOLUTE_MIN_TAPE_SEGMENT_SEC) break;
  }

  /* PHASE 2 (F-73): KEEP GOING WHILE THE CLAIM DOES, UP TO `targetSec`.
   *
   * WHY A SECOND PHASE AT ALL. `MIN_TAPE_SEGMENT_SEC` is a floor on what counts
   * as a piece of tape; it is not the length a Foray's segments are supposed to
   * be. narration-craft.md §0's D-tier rules are about the latter — a 90 s mean
   * (D3), no run of sub-60 s segments (D2), a spread of lengths (D5) — and a cut
   * that stopped at 45 s left every one of them to luck. Run 2 attempt 5 is what
   * that cost: 5 tier-2 segments, all inside one 60-120 s band, refused on D3
   * and on D5.
   *
   * WHY IT IS SAFE, AND WHY IT IS NOT THE SAME AS PADDING. The condition is
   * strictly stronger than phase 1's: a cue is attached ONLY when it shares one
   * of the claim's own words. There is no `ABSOLUTE_MIN` escape hatch here and
   * no least-bad-neighbour fallback, because there is nothing to rescue — the
   * span is already playable tape, so the honest answer to "neither neighbour is
   * about the claim" is to stop, exactly as F-62 says. A longer span can
   * therefore never be less about the claim than the short one it grew from,
   * which is the property that lets this run without touching any relevance
   * floor.
   *
   * AND WHY THE LENGTHS STILL VARY. Growth stops where the passage does, so the
   * achieved length is "as much of this passage as there is, up to the target"
   * rather than the target itself. Two beats given the same target come out
   * different lengths whenever their passages differ, and `sourceBeats.ts` varies
   * the target as well (`D_TARGET_LADDER_SEC`) so that they are not even asked
   * for the same one. */
  const target = Math.min(Math.max(targetSec ?? MIN_TAPE_SEGMENT_SEC, MIN_TAPE_SEGMENT_SEC), maxSec);
  while (duration() < target) {
    const prev = first - 1;
    const next = last + 1;
    /* Contiguous, as well as in budget: `TAPE_CUE_GAP_MAX_SEC` is why. */
    const canPrev = prev >= 0 && endOf(last) - startOf(prev) <= maxSec && startOf(first) - endOf(prev) <= TAPE_CUE_GAP_MAX_SEC;
    const canNext = next < n && endOf(next) - startOf(first) <= maxSec && startOf(next) - endOf(last) <= TAPE_CUE_GAP_MAX_SEC;
    const prevShared = canPrev ? sharedWith(prev) : 0;
    const nextShared = canNext ? sharedWith(next) : 0;
    /* Neither side is still talking about the claim — or there is no side left,
       or taking one would run past `MAX_TAPE_SEGMENT_SEC`. Stop short of the
       target rather than buy the seconds with off-claim tape. */
    if (prevShared <= 0 && nextShared <= 0) break;
    /* Forward on a tie, for F-62's own reason: a passage continues after its
       topic sentence more often than it is introduced by one. */
    if (nextShared >= prevShared) last = next;
    else first = prev;
  }
  return { first, last };
}

/** The first quotable phrase spoken at the span's opening cue. Falls forward
 * into the following cues only when that cue is too short or too generic to
 * yield one — the case a word-level transcript (one or two words per cue)
 * puts every segment in. Exported, with `endAnchorFor`, for the passage cutter
 * (GV-12), so a stored passage's anchors follow the same spill rule as a
 * minted segment's. */
export function startAnchorFor(index: CueIndex, first: number, last: number): string | null {
  const own = mintStartAnchor(index.words[first]!);
  if (own) return own;
  const spill: string[] = [];
  for (let cue = first; cue <= last && spill.length < MAX_ANCHOR_WORDS * 4; cue++) spill.push(...index.words[cue]!);
  return mintStartAnchor(spill);
}

/** And the last quotable phrase at the closing cue. */
export function endAnchorFor(index: CueIndex, first: number, last: number): string | null {
  const own = mintEndAnchor(index.words[last]!);
  if (own) return own;
  const spill: string[] = [];
  for (let cue = last; cue >= first && spill.length < MAX_ANCHOR_WORDS * 4; cue--) spill.unshift(...index.words[cue]!);
  return mintEndAnchor(spill);
}

/**
 * The most distinctive run of 4-8 consecutive spoken words at the start of the
 * boundary cue: of the phrases beginning within `ANCHOR_SEARCH_SPAN` words of
 * the boundary, the one carrying the most content words, earliest on a tie, and
 * never fewer than `ANCHOR_MIN_CONTENT_WORDS`.
 *
 * WHY NOT SIMPLY THE FIRST ONE. Speech starts mid-thought. Taking the first
 * phrase that clears the content-word bar produced anchors like "and im just
 * thinking about this scenario where" — findable in half the episodes in the
 * archive, which is the opposite of what a locator is for. Looking a few words
 * further in costs the anchor nothing (ADR-0007 resolves an anchor by SEARCHING
 * the listener's transcript, so it need not begin exactly at the cut) and buys
 * a phrase somebody could actually find.
 *
 * Words, not sentences, because that is what `merge-segments.mjs` compares:
 * both sides are canonicalised (case, punctuation and apostrophes forgiven) and
 * the anchor must appear as a whole-word subsequence. A phrase built out of
 * consecutive canonical words of a cue is therefore verbatim to that validator
 * by construction — which is the property ADR-0007's locate step depends on and
 * `sourceBeats.test.ts` asserts against the raw cue text.
 */
export function mintStartAnchor(words: string[]): string | null {
  let best: { phrase: string[]; content: number } | null = null;
  for (let offset = 0; offset + MIN_ANCHOR_WORDS <= words.length && offset <= ANCHOR_SEARCH_SPAN; offset++) {
    const phrase = words.slice(offset, offset + Math.min(MAX_ANCHOR_WORDS, words.length - offset));
    const content = contentWordCount(phrase);
    if (content < ANCHOR_MIN_CONTENT_WORDS) continue;
    if (!best || content > best.content) best = { phrase, content };
  }
  return best ? best.phrase.join(" ") : null;
}

/** The LAST such run — the mirror image, so the closing anchor sits at the
 * moment the segment actually stops rather than eight words before it. */
export function mintEndAnchor(words: string[]): string | null {
  let best: { phrase: string[]; content: number } | null = null;
  for (let end = words.length; end >= MIN_ANCHOR_WORDS && end >= words.length - ANCHOR_SEARCH_SPAN; end--) {
    const phrase = words.slice(Math.max(0, end - MAX_ANCHOR_WORDS), end);
    const content = contentWordCount(phrase);
    if (content < ANCHOR_MIN_CONTENT_WORDS) continue;
    if (!best || content > best.content) best = { phrase, content };
  }
  return best ? best.phrase.join(" ") : null;
}

function contentWordCount(words: string[]): number {
  return new Set(tokenizeForSourcing(words.join(" "))).size;
}

/**
 * Mirrors `tools/segments/prepare-segment-batch.mjs`'s `slugify` + `mintItemIds`
 * shape (`<show_id>--<slug>`) closely enough to be recognizable as the same id
 * family, without importing that ESM build script into a CJS backend module
 * (same rationale as `canonicalizeForAnchorMatch` in `types/anchorText.ts`).
 *
 * HERE RATHER THAN IN `sourceBeats.ts`, WHERE IT LIVED (WS-L). It derives an id
 * from a digest ROW and knows nothing about beats or sourcing, and it now has a
 * second caller two stages earlier: §4.2's research map names the episode each
 * quoted window came from, and §4.3's beat seed carries that name back, so both
 * sides of the seed have to spell an episode id the same way. `sourceBeats.ts`
 * re-exports it, so every existing import is unchanged.
 */
export function deriveItemId(entry: TranscriptDigestEntry): string {
  const legacy = legacyItemId(entry);
  return entry.item_id_suffix ? `${legacy}-${entry.item_id_suffix}` : legacy;
}

/**
 * The id before gen-6: `<show_id>--<slug(title) cut to 60>`, which is NOT
 * unique per episode. Recurring round-ups ("Scott Becker: 6 healthcare news
 * stories we are following today", "the best moments of ...") share their first
 * 60 slug characters across episodes, so two episodes minted one id, and one
 * episode's audio row and transcript were attributed to the other.
 *
 * Kept as the id of every entry that does NOT collide, so the ids already
 * committed in data/segments.json and data/segment-sources.json keep resolving.
 * A committed entry's collisions are judged among committed entries only, so a
 * same-titled episode in one machine's local corpus cannot move it (see
 * disambiguateItemIds).
 */
export function legacyItemId(entry: TranscriptDigestEntry): string {
  const slug = entry.title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return `${entry.show_id}--${slug || "episode"}`;
}

/**
 * gen-6: gives every entry whose legacy id another entry (a different guid)
 * also derives a short guid-hash suffix, so each episode has its own item id.
 *
 * COMMITTED IDS DEPEND ON COMMITTED ROWS ONLY (round-3 review, L5). The first
 * `committed` entries come from the committed digests; the rest from this
 * machine's local corpus digest, which CI and a fresh checkout do not have.
 * A committed entry is suffixed only when ANOTHER COMMITTED entry shares its
 * legacy id, so its id is the same on every machine, and an id already in
 * data/segments.json or segment-sources.json does not change the day the local
 * corpus gains a same-titled episode. A local entry is suffixed when its
 * legacy id collides with anything, committed or local, so it never takes an
 * incumbent's id. Within each rule every member of a colliding group is
 * suffixed, none is privileged by load order. `committed` defaults to all of
 * them. Mutates and returns `entries`; `loadTranscriptArchive` calls it.
 */
export function disambiguateItemIds(entries: TranscriptDigestEntry[], options: { committed?: number } = {}): TranscriptDigestEntry[] {
  const committedCount = Math.min(options.committed ?? entries.length, entries.length);
  const groups = (list: TranscriptDigestEntry[]): Map<string, Set<string>> => {
    const guidsById = new Map<string, Set<string>>();
    for (const entry of list) {
      const id = legacyItemId(entry);
      let guids = guidsById.get(id);
      if (!guids) guidsById.set(id, (guids = new Set()));
      guids.add(String(entry.guid));
    }
    return guidsById;
  };
  const committedGroups = groups(entries.slice(0, committedCount));
  const allGroups = groups(entries);
  entries.forEach((entry, i) => {
    const within = i < committedCount ? committedGroups : allGroups;
    if ((within.get(legacyItemId(entry))?.size ?? 0) > 1) {
      entry.item_id_suffix = crypto.createHash("sha1").update(String(entry.guid)).digest("hex").slice(0, 6);
    }
  });
  return entries;
}

/**
 * The text spoken between two timestamps, cues joined in order.
 *
 * STRICT AT BOTH EDGES (G-24 R1; tape-yield brief §4 cause 2). Cues are
 * contiguous, so the cue that ENDS at `startSec` is the sentence spoken just
 * before the window and the cue that STARTS at `endSec` is the one spoken just
 * after it; neither is inside it. Until G-24 both were kept (`end_sec >=
 * startSec`, `start_sec <= endSec`), and the consequence ran three stages
 * downstream: §4.2 quoted the leading cue into the spine prompt under the
 * window's own seconds, the spine wrote the claim from that first sentence and
 * copied the seconds faithfully, and §4.5's seed window (`within`, F-68) then
 * excluded the very cue the claim came from — on attempt 6, 7 of 8 quotes
 * opened with the previous cue's text, 6 of 14 seeded claims were written from
 * it, and 2 beats were lost outright (seed windows at 0.000 and 0.016) while 4
 * more survived only because the whole-episode fallback re-found the cue.
 *
 * A cue that OVERLAPS the interval by any positive amount is still included —
 * a pool segment's bounds are anchor times that can sit mid-cue, and tier 1
 * reads those cues through this function too. Only the touching-but-outside
 * cues are excluded, which is what "spoken between" means.
 */
export function cueWindowText(cues: TranscriptCue[], startSec: number, endSec: number): string {
  const parts: string[] = [];
  for (const cue of cues) {
    if (cue.end_sec <= startSec) continue;
    if (cue.start_sec >= endSec) continue;
    parts.push(cue.text);
  }
  return parts.join(" ");
}
