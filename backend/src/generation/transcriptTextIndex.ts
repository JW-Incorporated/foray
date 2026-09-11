import * as fs from "fs";
import * as path from "path";
import { tokenizeForSourcing } from "./catalogueLookup";
import {
  FileTranscriptCueProvider,
  loadTranscriptArchive,
  titleTokenScore,
  type TranscriptCue,
  type TranscriptCueProvider,
  type TranscriptDigestEntry
} from "./transcriptArchiveLookup";

/**
 * §4.5 tier-2 CANDIDATE SEARCH over the transcript archive's own words
 * (fix plan WS-H; findings F-06, F-49).
 *
 * WHAT THIS EXISTS TO FIX. Until now tier 2 chose its candidate episode by
 * scoring the claim against `show_title + title` and nothing else, so an
 * episode could only be found if its TITLE happened to share three content
 * words with the claim (F-06). Generation run 2's offline replay (#552) is what
 * that costs: *Practical AI* has 63 of 63 transcript bodies on the generation
 * machine, the Foray was about production machine learning, and the best title
 * scored ONE against the ImageNet-label-errors claim — so the anchored-window
 * test, the lineage gate and the cue-boundary cut, all of which work, were
 * never reached for any of the 23 searching beats. Lowering the title bar
 * instead re-admits run 1's Chernobyl-for-Hyatt class of mis-anchor (pinned by
 * `sourceBeats.test.ts`), because a title is not evidence about a claim in the
 * first place. The fix is to search the TEXT.
 *
 * WHAT IT IS. A read-only inverted index over the normalised cue text of the
 * episodes the archive already holds — one index per show, built lazily, cached
 * on disk under `data-local/transcripts/index/<show>.json` and keyed by every
 * body file's own mtime+size so a re-transcribed or added episode rebuilds it.
 * Scoring is BM25 with document-length normalisation, over the SAME
 * `tokenizeForSourcing` tokenizer and stopword list the two §4.5 scorers use,
 * so "content word" means one thing in this pipeline.
 *
 * WHAT IT IS NOT. It is not a relevance verdict. It returns the top N episodes
 * most worth OPENING for a claim; every gate that decides whether tape is
 * actually about the claim — the window search and its relevance floor
 * (`selectTapeWindow`/`tapeWindowIsRelevant`), the taxonomy lineage gate, the
 * cut to cue boundaries — still runs afterwards in `sourceBeats.ts`. The title
 * bar survives as a TIE-BREAKER between episodes the text ranks equally, never
 * as a gate.
 *
 * PROVIDER-SHAPED, LIKE `TranscriptCueProvider`, AND FOR THE SAME REASON. The
 * transcript bodies live in `data-local/` (gitignored, machine-local), so CI
 * and a fresh checkout have none. `NullTranscriptTextIndex` returns no
 * candidates and reports `enabled: false`, which puts tier 2 back on exactly
 * the title path it walks today — that is the default, and it is why every
 * pre-existing test passes unchanged.
 *
 * IT READS `data-local/` ONLY THROUGH A PROVIDER. The cue text this index is
 * built from comes from a `TranscriptBodySource` — `FileTranscriptCueProvider`
 * in production — never from a path this module opens itself. The one thing it
 * writes is its own cache under `data-local/transcripts/index/`, and a failed
 * write is not an error: the index is simply rebuilt next time.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/** Bumped whenever the on-disk shape, the tokenizer, or the scoring changes —
 * a cache built by an older rule is discarded rather than trusted. */
export const TRANSCRIPT_TEXT_INDEX_VERSION = 1;

/** BM25's term-frequency saturation. The standard value; nothing here is tuned
 * against a labelled set, and pretending otherwise would be worse than saying
 * so. */
const BM25_K1 = 1.2;
/** BM25's length normalisation. Also standard, and it is the half that matters
 * here: episodes in this archive run from 12 minutes to three hours, and
 * without it the longest episode wins every query by having more words. */
const BM25_B = 0.75;

/** How many episodes tier 2 opens per beat by default (fix plan WS-H: "take the
 * top N (say 8)"). Every one of them still has to pass the anchored-window
 * test, so N trades a little work for recall, not for laxity. */
export const TRANSCRIPT_TEXT_CANDIDATES = 8;

export interface TranscriptTextCandidate {
  entry: TranscriptDigestEntry;
  /** BM25 over this episode's own cue text, against the claim's content words. */
  score: number;
  /** How many DISTINCT claim content words are spoken in the episode at all —
   * the plain-language half of the score, and what a trace row reads best. */
  matchedTerms: number;
  /** 0-based position in the returned ranking. */
  rank: number;
  /**
   * The idf this search computed for each query term, shared by every candidate
   * of one search (one map, not one per row).
   *
   * Carried out of the index because tier 2's WINDOW search needs it (F-61):
   * choosing which stretch of an episode carries a claim means preferring the
   * stretch that says "imagenet" over the one that says "system", and the
   * corpus is the only thing that knows which of those two is rare. Optional on
   * the type so the title-path candidate and a four-line test stub stay valid;
   * a window search without it weighs every term one.
   */
  idf?: ReadonlyMap<string, number>;
}

export interface TranscriptTextSearchOptions {
  /** Top N episodes to return. Defaults to `TRANSCRIPT_TEXT_CANDIDATES`. */
  limit?: number;
  /** The caller's veto, applied BEFORE any index is built or read — §4.5's
   * taxonomy lineage gate, passed straight down. An off-family show is never
   * indexed, never scored and never returned, which is also what keeps this
   * cheap: run 2's topic admits one show of fifteen. */
  isUsable?: (entry: TranscriptDigestEntry) => boolean;
}

/**
 * The seam tier 2's candidate search hangs on — same shape and same contract as
 * `TranscriptCueProvider`: an implementation that has nothing to offer says so
 * honestly instead of guessing.
 */
export interface TranscriptTextIndex {
  /**
   * Whether a text search actually ran. `false` for the Null index, and the
   * distinction is load-bearing for the sourcing trace: a beat that failed a
   * search that never happened must not be reported as one the text index had
   * no candidate for (F-49's whole point is that the trace names the gate that
   * really decided).
   */
  readonly enabled: boolean;
  search(queryText: string, options?: TranscriptTextSearchOptions): TranscriptTextCandidate[];
}

/**
 * The default, and the only implementation CI ever sees. No candidates, ever —
 * tier 2 then walks the title path exactly as it did before WS-H.
 */
export class NullTranscriptTextIndex implements TranscriptTextIndex {
  readonly enabled = false;
  /* Declared with no parameters, like `NullTranscriptCueProvider.getCues` — it
     is still assignable to `TranscriptTextIndex`, and naming arguments it
     cannot use would only invite someone to think it might. */
  search(): TranscriptTextCandidate[] {
    return [];
  }
}

/** A body file's identity on disk, for cache invalidation. Supplied by the
 * provider, because this module does not open `data-local/` itself. */
export interface TranscriptBodyStat {
  mtimeMs: number;
  size: number;
}

/**
 * A cue provider that can also say WHICH file an episode's cues came from and
 * when it last changed — everything the index needs from `data-local/`.
 * `FileTranscriptCueProvider` implements it; a test can implement it in four
 * lines.
 */
export interface TranscriptBodySource extends TranscriptCueProvider {
  bodyStat(entry: TranscriptDigestEntry): TranscriptBodyStat | null;
}

interface IndexedDoc {
  guid: string;
  /** Content-word count after tokenizing — BM25's `|D|`. */
  length: number;
  mtimeMs: number;
  size: number;
}

interface ShowIndex {
  version: number;
  showId: string;
  builtAt: string;
  docs: IndexedDoc[];
  /** term -> [docIndex, termFrequency][], the inverted index itself. */
  postings: Record<string, Array<[number, number]>>;
}

export interface FileTranscriptTextIndexOptions {
  /** The digest rows that define the searchable universe. Defaults to the same
   * committed digests `transcriptArchiveLookup` reads. */
  archive?: TranscriptDigestEntry[];
  /** Where the cue text comes from. Defaults to the real file provider. */
  bodies?: TranscriptBodySource;
  /** Where the caches live. Defaults to `data-local/transcripts/index/`. */
  indexRoot?: string;
  /** Set false to search without ever touching (or writing) the disk cache. */
  cache?: boolean;
}

/**
 * The index a generation MACHINE runs with, alongside
 * `FileTranscriptCueProvider`.
 *
 * COST. Building a show's index costs one pass over its bodies — the provider's
 * own read, which a batch run has usually already paid for tier 1's window
 * text. That happens once per show per machine and is then a cache read keyed
 * on 63 (or 995) `stat` calls, which is cheap enough to do on every process
 * start and is the only way a stale index gets noticed. A show whose episodes
 * the lineage gate refuses is never opened at all, which in a real run is
 * fourteen shows of fifteen.
 */
export class FileTranscriptTextIndex implements TranscriptTextIndex {
  readonly enabled = true;
  private readonly archive: TranscriptDigestEntry[];
  private readonly bodies: TranscriptBodySource;
  private readonly indexRoot: string;
  private readonly useCache: boolean;
  private readonly loaded = new Map<string, ShowIndex | null>();
  private byShow: Map<string, TranscriptDigestEntry[]> | null = null;

  constructor(options: FileTranscriptTextIndexOptions = {}) {
    this.archive = options.archive ?? loadTranscriptArchive();
    this.bodies = options.bodies ?? new FileTranscriptCueProvider();
    this.indexRoot = options.indexRoot ?? path.join(REPO_ROOT, "data-local", "transcripts", "index");
    this.useCache = options.cache !== false;
  }

  search(queryText: string, options: TranscriptTextSearchOptions = {}): TranscriptTextCandidate[] {
    const limit = options.limit ?? TRANSCRIPT_TEXT_CANDIDATES;
    const isUsable = options.isUsable ?? (() => true);
    const terms = [...new Set(tokenizeForSourcing(queryText))];
    if (terms.length === 0 || limit <= 0) return [];

    /* Shows first, because the lineage gate is effectively a per-show verdict
       and a show nothing admits must not be indexed at all. */
    const shows: Array<{ showId: string; usable: TranscriptDigestEntry[] }> = [];
    for (const [showId, entries] of this.groupedByShow()) {
      const usable = entries.filter((e) => isUsable(e));
      if (usable.length > 0) shows.push({ showId, usable });
    }
    if (shows.length === 0) return [];

    /* ONE CORPUS, NOT ONE PER SHOW. The indexes are stored per show (that is
       what can be built and invalidated independently), but the idf a candidate
       is scored with is computed across every show this query touches — two
       BM25 scores from two corpora are not comparable, and tier 2 has to rank
       them against each other. */
    type Hit = { entry: TranscriptDigestEntry; length: number; tf: Map<string, number> };
    const hits = new Map<string, Hit>();
    const df = new Map<string, number>();
    let docCount = 0;
    let totalLength = 0;

    for (const { showId, usable } of shows) {
      const index = this.showIndex(showId);
      if (!index) continue;
      const usableByGuid = new Map(usable.map((e) => [e.guid, e]));
      const docUsable: boolean[] = index.docs.map((d) => usableByGuid.has(d.guid));
      index.docs.forEach((doc, i) => {
        if (!docUsable[i]) return;
        docCount += 1;
        totalLength += doc.length;
      });
      for (const term of terms) {
        /* F-85: postings is keyed by transcript tokens, and a token can be a prototype
           name ("constructor" is common speech in engineering episodes); `Object.hasOwn`
           keeps an inherited function from masquerading as a posting list. */
        if (!Object.hasOwn(index.postings, term)) continue;
        const postings = index.postings[term];
        if (!postings) continue;
        for (const [docIndex, tf] of postings) {
          if (!docUsable[docIndex]) continue;
          const doc = index.docs[docIndex];
          if (!doc) continue;
          const entry = usableByGuid.get(doc.guid);
          if (!entry) continue;
          const key = `${showId}\u0000${doc.guid}`;
          let hit = hits.get(key);
          if (!hit) {
            hit = { entry, length: doc.length, tf: new Map() };
            hits.set(key, hit);
          }
          hit.tf.set(term, tf);
          df.set(term, (df.get(term) ?? 0) + 1);
        }
      }
    }
    if (hits.size === 0 || docCount === 0) return [];

    const avgLength = totalLength / docCount;
    const queryTokens = new Set(terms);
    /* One idf map for the whole search: BM25's own term weights, and the same
       numbers tier 2's window search reuses to prefer the rare word (F-61). */
    const idfByTerm = new Map<string, number>();
    for (const term of terms) {
      const n = df.get(term);
      if (n === undefined) continue;
      idfByTerm.set(term, Math.log(1 + (docCount - n + 0.5) / (n + 0.5)));
    }
    const scored: TranscriptTextCandidate[] = [];
    for (const hit of hits.values()) {
      let score = 0;
      for (const [term, tf] of hit.tf) {
        const idf = idfByTerm.get(term) ?? 0;
        const denominator = tf + BM25_K1 * (1 - BM25_B + (BM25_B * hit.length) / (avgLength || 1));
        score += idf * ((tf * (BM25_K1 + 1)) / (denominator || 1));
      }
      scored.push({ entry: hit.entry, score, matchedTerms: hit.tf.size, rank: 0, idf: idfByTerm });
    }

    /* THE TITLE BAR, DEMOTED TO WHAT IT IS GOOD FOR. It cannot decide whether
       an episode is worth opening (F-06), but between two episodes the text
       ranks the same it is a real signal, and it is free. Guid last so the
       order is total and a replay is reproducible. */
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const t = titleTokenScore(queryTokens, b.entry) - titleTokenScore(queryTokens, a.entry);
      if (t !== 0) return t;
      return a.entry.guid < b.entry.guid ? -1 : a.entry.guid > b.entry.guid ? 1 : 0;
    });
    return scored.slice(0, limit).map((c, rank) => ({ ...c, rank }));
  }

  private groupedByShow(): Map<string, TranscriptDigestEntry[]> {
    if (!this.byShow) {
      this.byShow = new Map();
      for (const entry of this.archive) {
        const list = this.byShow.get(entry.show_id);
        if (list) list.push(entry);
        else this.byShow.set(entry.show_id, [entry]);
      }
    }
    return this.byShow;
  }

  /** The show's index: from memory, else from a cache whose every body still
   * has the mtime+size it was built from, else built now. Null when the show
   * has no bodies on this machine — the ordinary case in a checkout. */
  private showIndex(showId: string): ShowIndex | null {
    if (this.loaded.has(showId)) return this.loaded.get(showId) ?? null;
    const entries = this.groupedByShow().get(showId) ?? [];
    const cached = this.useCache ? this.readCache(showId) : null;
    const index = cached && this.cacheIsFresh(cached, entries) ? cached : this.build(showId, entries);
    if (index && index !== cached && this.useCache) this.writeCache(showId, index);
    this.loaded.set(showId, index);
    return index;
  }

  /**
   * A cache is fresh when it describes EXACTLY the bodies on disk now: same
   * guids, same mtime, same size. Not "same count", and not a build timestamp —
   * a re-transcribed episode keeps its guid and its neighbours, and that is the
   * change most likely to make an index quietly wrong.
   */
  private cacheIsFresh(index: ShowIndex, entries: TranscriptDigestEntry[]): boolean {
    if (index.version !== TRANSCRIPT_TEXT_INDEX_VERSION) return false;
    const onDisk = new Map<string, TranscriptBodyStat>();
    for (const entry of entries) {
      const stat = this.bodies.bodyStat(entry);
      if (stat) onDisk.set(entry.guid, stat);
    }
    if (onDisk.size !== index.docs.length) return false;
    for (const doc of index.docs) {
      const stat = onDisk.get(doc.guid);
      if (!stat) return false;
      if (stat.mtimeMs !== doc.mtimeMs || stat.size !== doc.size) return false;
    }
    return true;
  }

  private build(showId: string, entries: TranscriptDigestEntry[]): ShowIndex | null {
    const docs: IndexedDoc[] = [];
    /* F-85: a null-prototype map, so a token such as "constructor" or "__proto__" is a key like any other. */
    const postings: Record<string, Array<[number, number]>> = Object.create(null);
    for (const entry of entries) {
      const stat = this.bodies.bodyStat(entry);
      if (!stat) continue;
      const cues = this.bodies.getCues(entry);
      if (!cues || cues.length === 0) continue;
      const counts = countTerms(cues);
      const docIndex = docs.length;
      let length = 0;
      for (const [term, tf] of counts) {
        length += tf;
        const list = postings[term];
        if (list) list.push([docIndex, tf]);
        else postings[term] = [[docIndex, tf]];
      }
      docs.push({ guid: entry.guid, length, mtimeMs: stat.mtimeMs, size: stat.size });
    }
    if (docs.length === 0) return null;
    return { version: TRANSCRIPT_TEXT_INDEX_VERSION, showId, builtAt: new Date().toISOString(), docs, postings };
  }

  private cacheFile(showId: string): string {
    const safe = String(showId).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 100) || "show";
    return path.join(this.indexRoot, `${safe}.json`);
  }

  private readCache(showId: string): ShowIndex | null {
    try {
      const file = this.cacheFile(showId);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path derived from a digest show id, slugged above.
      if (!fs.existsSync(file)) return null;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above.
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as ShowIndex;
      if (!parsed || !Array.isArray(parsed.docs) || typeof parsed.postings !== "object" || parsed.postings === null) return null;
      /* F-85: a cached index parsed from JSON has Object.prototype; re-key it so prototype-named tokens read as their own postings. */
      parsed.postings = Object.assign(Object.create(null), parsed.postings);
      return parsed;
    } catch {
      /* An unreadable or half-written cache is a cache miss, never a failure:
         the index rebuilds and overwrites it. */
      return null;
    }
  }

  private writeCache(showId: string, index: ShowIndex): void {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- see readCache.
      fs.mkdirSync(this.indexRoot, { recursive: true });
      const file = this.cacheFile(showId);
      const tmp = `${file}.tmp`;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- see readCache.
      fs.writeFileSync(tmp, JSON.stringify(index), "utf8");
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- see readCache.
      fs.renameSync(tmp, file);
    } catch {
      /* A read-only or absent `data-local/` costs a rebuild next run, nothing
         more. Sourcing must never fail because a cache could not be written. */
    }
  }
}

/** Content-word counts over an episode's cues, with the SAME tokenizer the
 * §4.5 scorers use — an index that tokenized differently would rank episodes by
 * one rule and score claims by another. */
function countTerms(cues: TranscriptCue[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const cue of cues) {
    for (const term of tokenizeForSourcing(cue.text)) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }
  return counts;
}
