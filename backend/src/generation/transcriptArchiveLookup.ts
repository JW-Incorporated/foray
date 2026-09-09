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
 *      checkout), locate a REAL, VERBATIM anchor span for the claim
 *      inside that transcript, using the exact whole-word-subsequence
 *      matching rule `tools/segments/merge-segments.mjs` enforces at
 *      merge time (`canonicalizeForAnchorMatch` below is a small,
 *      independently-implemented mirror of that module's `canonical()` —
 *      not a re-import, since that module is an ESM `.mjs` build script
 *      and this is a CommonJS backend module; the ALGORITHM is what
 *      needs to match, and it does: case/whitespace/punctuation
 *      forgiven, apostrophes elided, everything else exact). This is
 *      genuine anchor *location* against already-available text, not
 *      segment *extraction* — no episode-selection heuristics, no
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
export const TIER2_MATCH_THRESHOLD = 2;

export function findTranscriptArchiveMatch(claimText: string, archive: TranscriptDigestEntry[] = loadTranscriptArchive()): TranscriptArchiveMatch | null {
  const claimTokens = new Set(tokenizeForSourcing(claimText));
  if (claimTokens.size === 0) return null;

  /* WHY THE SHOW TITLE COUNTS FOR AT MOST ONE. Every episode of a show
     shares its show-title tokens, so a show whose name overlaps the subject
     ("Causality — Engineered Network" vs. an engineering claim) used to clear
     the threshold for EVERY one of its episodes on show tokens alone, and the
     first such episode in file order won: generation run 1 anchored a Kansas
     City hanger-rod beat to the Chernobyl episode and a box-beam beat to
     Three Mile Island (findings F-23/F-24). The episode title is the only
     per-episode signal in a digest, so a match must include at least one
     episode-title token; the show title can then add one point of
     confidence, never carry the match by itself. */
  let best: TranscriptArchiveMatch | null = null;
  for (const entry of archive) {
    const titleTokens = new Set(tokenizeForSourcing(entry.title));
    const showTokens = new Set(tokenizeForSourcing(entry.show_title));
    let score = 0;
    let showHit = 0;
    for (const t of claimTokens) {
      if (titleTokens.has(t)) score += 1;
      else if (showTokens.has(t)) showHit = 1;
    }
    if (score === 0) continue; // show-title-only overlap is not a match
    score += showHit;
    if (!best || score > best.score) best = { entry, score };
  }
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
    const key = `${entry.show_id} ${entry.guid}`;
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

export interface ResolvedAnchorSpan {
  startAnchor: string;
  endAnchor: string;
  startSec: number;
  endSec: number;
}

/** Same floor as `merge-segments.mjs`'s `MIN_ANCHOR_WORDS`. */
export const MIN_ANCHOR_WORDS = 4;
/** Longest contiguous window of claim tokens tried as an anchor phrase. */
const MAX_ANCHOR_WORDS = 12;

/**
 * Finds a REAL, verbatim anchor span for `claimText` inside `cues`,
 * using whole-word subsequence matching identical in spirit to
 * `merge-segments.mjs`'s `findAnchorOccurrences` — a claim's own
 * significant words, searched for as a contiguous run inside the actual
 * transcript text. Returns `null` if no run of at least
 * `MIN_ANCHOR_WORDS` claim words appears verbatim anywhere in the
 * transcript (the honest "cannot resolve" answer — never a fabricated
 * anchor).
 */
export function resolveAnchorFromCues(claimText: string, cues: TranscriptCue[]): ResolvedAnchorSpan | null {
  const tokens: string[] = [];
  const startTimes: number[] = [];
  const endTimes: number[] = [];
  for (const cue of cues) {
    for (const w of canonicalWords(cue.text)) {
      tokens.push(w);
      startTimes.push(cue.start_sec);
      endTimes.push(cue.end_sec);
    }
  }
  if (tokens.length === 0) return null;

  const claimWords = canonicalWords(claimText).filter((w) => w.length > 2);
  if (claimWords.length < MIN_ANCHOR_WORDS) return null;

  // Try the longest possible contiguous window of claim words first, then
  // shrink — a longer verbatim match is a stronger, more specific anchor.
  const windowMax = Math.min(MAX_ANCHOR_WORDS, claimWords.length);
  for (let windowLen = windowMax; windowLen >= MIN_ANCHOR_WORDS; windowLen--) {
    for (let start = 0; start + windowLen <= claimWords.length; start++) {
      const phrase = claimWords.slice(start, start + windowLen);
      const at = findFirstOccurrence(tokens, phrase);
      if (at !== -1) {
        const anchorText = phrase.join(" ");
        return {
          startAnchor: anchorText,
          endAnchor: anchorText,
          startSec: startTimes[at]!,
          endSec: endTimes[at + windowLen - 1]!
        };
      }
    }
  }
  return null;
}

function findFirstOccurrence(tokens: string[], phrase: string[]): number {
  for (let i = 0; i + phrase.length <= tokens.length; i++) {
    let ok = true;
    for (let j = 0; j < phrase.length; j++) {
      if (tokens[i + j] !== phrase[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}
