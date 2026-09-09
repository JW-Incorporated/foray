import * as fs from "fs";
import * as path from "path";
import { tokenizeForSourcing } from "./catalogueLookup";

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
 *      before comparing (`canonicalizeForAnchorMatch` below is a small,
 *      independently-implemented mirror of that module's `canonical()` —
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
}

let cachedDigests: TranscriptDigestEntry[] | null = null;

/** Reads both committed digest files (curated + breadth), keeping only
 * episodes whose transcript is usable at all (has cues, timeline not
 * flagged implausible — the same `span_implausible` field
 * `prepare-segment-batch.mjs`'s timeline gate already computes upstream
 * of these files). */
export function loadTranscriptArchive(): TranscriptDigestEntry[] {
  if (cachedDigests && process.env.FORAY_SKIP_CATALOGUE_CACHE !== "1") return cachedDigests;

  const entries: TranscriptDigestEntry[] = [];
  for (const file of ["data/transcript-digests.json", "data/breadth-transcript-digests.json"]) {
    const full = path.join(REPO_ROOT, file);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- hardcoded repo-relative path list, not external input.
    if (!fs.existsSync(full)) continue;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above.
    const raw = fs.readFileSync(full, "utf8");
    const parsed = JSON.parse(raw) as { transcripts?: TranscriptDigestEntry[] };
    for (const t of parsed.transcripts ?? []) {
      if ((t.cues ?? 0) > 0 && t.span_implausible !== true) entries.push(t);
    }
  }
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
}

/** Supplies real transcript cue text for an episode, if it is available.
 * Injected so tests can exercise the real-anchor path deterministically
 * without a transcript body ever having to be committed to git. */
export interface TranscriptCueProvider {
  getCues(entry: TranscriptDigestEntry): TranscriptCue[] | null;
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
export class FileTranscriptCueProvider implements TranscriptCueProvider {
  private readonly root: string;
  private readonly dirByShow = new Map<string, string | null>();
  private readonly cuesByKey = new Map<string, TranscriptCue[] | null>();
  private readonly guidIndexByDir = new Map<string, Map<string, string>>();

  constructor(root: string = path.join(REPO_ROOT, "data-local", "transcripts", "normalized")) {
    this.root = root;
  }

  getCues(entry: TranscriptDigestEntry): TranscriptCue[] | null {
    const key = `${entry.show_id}\u0000${entry.guid}`;
    if (this.cuesByKey.has(key)) return this.cuesByKey.get(key) ?? null;
    let result: TranscriptCue[] | null = null;
    try {
      const file = this.locate(String(entry.show_id), String(entry.guid));
      if (file) result = readCues(file);
    } catch {
      result = null;
    }
    this.cuesByKey.set(key, result);
    return result;
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
    const dir = this.showDir(showId);
    if (!dir) return null;
    const slug = guidSlug(guid);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    if (slug) {
      const byName = files.find((f) => f.toLowerCase().startsWith(`${slug}-`) || f.toLowerCase() === `${slug}.json`);
      if (byName) return path.join(dir, byName);
    }
    // Fallback: index the directory's real guids once, then look the guid up.
    let index = this.guidIndexByDir.get(dir);
    if (!index) {
      index = new Map();
      for (const f of files) {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { guid?: unknown };
          if (typeof j.guid === "string") index.set(j.guid, path.join(dir, f));
        } catch {
          /* an unreadable body is simply not indexed */
        }
      }
      this.guidIndexByDir.set(dir, index);
    }
    return index.get(guid) ?? null;
  }
}

/** The slug `tools/segments/` uses for the file name: lowercase, non-alphanumerics to `-`. */
function guidSlug(guid: string): string {
  return String(guid ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function readCues(file: string): TranscriptCue[] | null {
  const j = JSON.parse(fs.readFileSync(file, "utf8")) as { cues?: unknown };
  if (!Array.isArray(j.cues)) return null;
  const cues: TranscriptCue[] = [];
  for (const c of j.cues as Array<Record<string, unknown>>) {
    const text = typeof c?.text === "string" ? c.text : null;
    const start = typeof c?.start_sec === "number" ? c.start_sec : null;
    const end = typeof c?.end_sec === "number" ? c.end_sec : null;
    if (text === null || start === null || end === null || !Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    cues.push({ text, start_sec: start, end_sec: end });
  }
  return cues.length ? cues : null;
}

/** Mirrors `tools/segments/merge-segments.mjs`'s `canonical()` exactly:
 * lowercase, NFKC, apostrophes elided, everything else non-alphanumeric
 * collapsed to a single space. Kept in sync deliberately — a divergence
 * here would let this module accept an anchor the real merge validator
 * would reject. See the module doc comment for why this is a mirror,
 * not a re-import (ESM `.mjs` build script vs. CJS backend module). */
export function canonicalizeForAnchorMatch(text: string): string {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['\u2018\u2019\u02bc\u02b9\u2032`\u00b4]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

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

/** Shortest cue run tier 2 will treat as a window. Below half a minute a
 * "window" is one or two sentences, and one or two sentences can share three
 * words with almost anything — the same arithmetic that made the old four-word
 * run meaningless. A run shorter than this is considered only when the
 * transcript (or the stretch of it before a gap larger than
 * `TAPE_WINDOW_MAX_SEC`) is itself shorter. */
export const TAPE_WINDOW_MIN_SEC = 30;

/** And the longest. A window is a candidate SEGMENT, and the real pool's
 * longest segment is 260 s; a window allowed to grow to an episode would
 * always win on term coverage while being about everything. */
export const TAPE_WINDOW_MAX_SEC = 180;

/**
 * A minted tier-2 segment is a SEGMENT, not a soundbite (F-24(c): run 1's
 * minted spans were "`startSec` of the anchor's first word to `endSec` of its
 * last — a few seconds of audio, not a segment"). The real pool's shortest
 * segment is 50 s and its median is 124 s; 45 s is under the shortest thing a
 * curator has ever cut, so a span that reaches it is at least in the same
 * category of object.
 */
export const MIN_TAPE_SEGMENT_SEC = 45;
/** And not the whole episode either — the pool's longest segment is 260 s. */
export const MAX_TAPE_SEGMENT_SEC = 240;

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
 * search and the cut agree about which cue is cue `n`. Cues with no words at
 * all are dropped (a music/silence marker is not a boundary). */
interface CueIndex {
  cues: TranscriptCue[];
  words: string[][];
  terms: Array<Set<string>>;
}

function indexCues(cues: TranscriptCue[]): CueIndex {
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
}

export interface SelectTapeWindowOptions {
  /** Inverse document frequency per term, from the text index that produced the
   * candidate (`TranscriptTextCandidate.idf`). Absent — a title-path candidate,
   * or a caller with no index — every term weighs one. */
  idf?: ReadonlyMap<string, number>;
  /**
   * The duration band a window may occupy, defaulting to
   * `TAPE_WINDOW_MIN_SEC`/`TAPE_WINDOW_MAX_SEC` — the §4.5 values, which is
   * what every tier-2 caller uses and what every existing test measures.
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
   * score higher. Nothing about the scoring, the weighting or the relevance
   * floor changes with it: the confined window faces `tapeWindowIsRelevant`
   * exactly as an unconfined one does, and §4.5 falls back to the whole-episode
   * search when it does not clear.
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
 * The stretch of `cues` that carries `claimText` best, or `null` when the
 * episode has no usable cues or the claim no content words.
 *
 * WHAT IS BEING RANKED. Every cue run between `TAPE_WINDOW_MIN_SEC` and
 * `TAPE_WINDOW_MAX_SEC` is scored by the claim's DISTINCT content words spoken
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
  const minSec = options.minSec ?? TAPE_WINDOW_MIN_SEC;
  const maxSec = options.maxSec ?? TAPE_WINDOW_MAX_SEC;
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

  /* WEIGHTS, NORMALISED SO ONE FLOOR CAN SERVE EVERY CORPUS. A term's idf
     depends on how many episodes the search touched, so a raw idf would make
     `TIER2_WINDOW_MIN_SHARE` mean something different for a fifteen-episode
     show than for a nine-hundred-episode one. Dividing by the rarest term the
     query has puts every weight on 0..1: the claim's rarest word counts one,
     the trade's everyday words count a twentieth of that.

     A term the corpus never says weighs ONE — as rare as it gets. It can never
     be matched, so it only ever counts against the window, which is right: a
     claim built on names nobody in this archive utters is a claim this archive
     is not about. */
  const rarest = Math.max(...claimTerms.map((t) => options.idf?.get(t) ?? 0), 0);
  const weightOf = (term: string): number => {
    const w = options.idf?.get(term);
    if (typeof w !== "number" || !Number.isFinite(w) || w <= 0) return 1;
    return rarest > 0 ? Math.min(1, w / rarest) : 1;
  };
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

/** Tier 2's relevance verdict on a window: enough of the claim, and enough of
 * it as a SHARE, to call the tape there about the claim. */
export function tapeWindowIsRelevant(window: TapeWindow | null): boolean {
  if (!window) return false;
  return window.distinctiveTerms.length >= TIER2_WINDOW_MIN_TERMS && window.weightedShare >= TIER2_WINDOW_MIN_SHARE;
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
 */
export function cutWindowToSegment(claimText: string, cues: TranscriptCue[], window: TapeWindow): TapeSpan | null {
  const index = indexCues(cues);
  const n = index.cues.length;
  if (n === 0) return null;
  if (window.firstCue < 0 || window.lastCue >= n || window.firstCue > window.lastCue) return null;

  const claimTerms = new Set(tokenizeForSourcing(claimText));
  const { first, last } = growByClaimOverlap(index, claimTerms, window.firstCue, window.lastCue);

  const startSec = index.cues[first]!.start_sec;
  const endSec = index.cues[last]!.end_sec;
  if (!(endSec > startSec)) return null;

  const startAnchor = startAnchorFor(index, first, last);
  const endAnchor = endAnchorFor(index, first, last);
  if (!startAnchor || !endAnchor) return null;

  return { startSec, endSec, startAnchor, endAnchor, firstCue: first, lastCue: last };
}

/** F-62's rule, stated once: grow toward the claim, never symmetrically. */
function growByClaimOverlap(
  index: CueIndex,
  claimTerms: Set<string>,
  firstCue: number,
  lastCue: number
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
    const canPrev = prev >= 0 && endOf(last) - startOf(prev) <= MAX_TAPE_SEGMENT_SEC;
    const canNext = next < n && endOf(next) - startOf(first) <= MAX_TAPE_SEGMENT_SEC;
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
  return { first, last };
}

/** The first quotable phrase spoken at the span's opening cue. Falls forward
 * into the following cues only when that cue is too short or too generic to
 * yield one — the case a word-level transcript (one or two words per cue)
 * puts every segment in. */
function startAnchorFor(index: CueIndex, first: number, last: number): string | null {
  const own = mintStartAnchor(index.words[first]!);
  if (own) return own;
  const spill: string[] = [];
  for (let cue = first; cue <= last && spill.length < MAX_ANCHOR_WORDS * 4; cue++) spill.push(...index.words[cue]!);
  return mintStartAnchor(spill);
}

/** And the last quotable phrase at the closing cue. */
function endAnchorFor(index: CueIndex, first: number, last: number): string | null {
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
 * (same rationale as `canonicalizeForAnchorMatch` above).
 *
 * HERE RATHER THAN IN `sourceBeats.ts`, WHERE IT LIVED (WS-L). It derives an id
 * from a digest ROW and knows nothing about beats or sourcing, and it now has a
 * second caller two stages earlier: §4.2's research map names the episode each
 * quoted window came from, and §4.3's beat seed carries that name back, so both
 * sides of the seed have to spell an episode id the same way. `sourceBeats.ts`
 * re-exports it, so every existing import is unchanged.
 */
export function deriveItemId(entry: TranscriptDigestEntry): string {
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

/** The text spoken between two timestamps, cues joined in order. */
export function cueWindowText(cues: TranscriptCue[], startSec: number, endSec: number): string {
  const parts: string[] = [];
  for (const cue of cues) {
    if (cue.end_sec < startSec) continue;
    if (cue.start_sec > endSec) continue;
    parts.push(cue.text);
  }
  return parts.join(" ");
}
