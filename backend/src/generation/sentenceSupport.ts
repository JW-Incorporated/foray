import { splitSpokenSentences } from "../copy/spokenLine";
import { isStatementSentence } from "../types/narration";
import { tokenizeForSourcing } from "./catalogueLookup";
import { DEFAULT_JEV_POOL_SIZE, createJevPool } from "./jevClient";
import type { JevAnswer, JevChoiceQuestion, JevClient, JevNoulQuestion } from "./jevTypes";

/**
 * GV-27 (docs/roadmap/generation-v2.md, from W5-08; covers R1-07, MQ-02):
 * the per-sentence support primitive. ONE sentence is judged against ONLY
 * its own candidate sources (at most ~2k tokens: 8,000 characters), never
 * the whole act: Jev is weak on long irrelevant context (R2 guard, LM-23).
 *
 *   candidateSourcesFor  ranks the act's sources by distinct
 *                        tokenizeForSourcing overlap with the sentence,
 *                        ALWAYS keeps the writer-declared claims
 *                        (mustInclude) whatever their overlap, and trims each
 *                        long text to the passage around the sentence's terms
 *                        (passageAround) so the whole set fits the budget.
 *   SentenceSupportJudge one verdict per sentence: {p, restsOn?} or
 *                        {unavailable}.
 *   JevSentenceSupportJudge  one Jev ask per sentence (a noul 'supported'
 *                        plus a choice 'restsOn' over the source ids and
 *                        'none'), at most 8 asks in flight.
 *   CodeOverlapSupportJudge  p = the share of the sentence's content words
 *                        found in its best source, so stub and dry-run
 *                        pipelines exercise downstream code without Jev.
 *
 * A LIBRARY ONLY. Nothing in the pipeline imports this file yet; the gates
 * that use it (W5-09, W5-11, W5-16 in the id map) ship behind their own
 * flags. Sentences come from spokenLine.js's splitSpokenSentences (GV-10),
 * and the statement rule is narration.ts's isStatementSentence, the same
 * rule hasDeclarativeSentence applies.
 */

/** A source one sentence may rest on: a gated claim, a clip's transcript
 * window, a ground page or an evidence document. */
export interface SupportSource {
  id: string;
  kind: "claim" | "clip" | "page" | "doc";
  text: string;
  publication: string;
}

export interface CandidateSourcesOptions {
  /** Total characters of source text returned (~2k tokens). Default 8000. */
  maxChars?: number;
  /** Ranked sources kept beside mustInclude. Default 3. */
  maxSources?: number;
  /** Source ids the writer declared for this sentence (its selected claims):
   * always returned, whatever their term overlap, and never displaced. */
  mustInclude?: readonly string[];
}

export const DEFAULT_SUPPORT_MAX_CHARS = 8000;
export const DEFAULT_SUPPORT_MAX_SOURCES = 3;

/** The sentences of `text` the support judge asks about: the spoken
 * sentences (splitSpokenSentences) that state something (isStatementSentence). */
export function statementSentences(text: string): string[] {
  return splitSpokenSentences(String(text ?? "")).filter(isStatementSentence);
}

/** The distinct content terms of `text` (tokenizeForSourcing). */
export function contentTerms(text: string): Set<string> {
  return new Set(tokenizeForSourcing(String(text ?? "")));
}

/** How many of `terms` occur in `text`. */
function distinctOverlap(terms: ReadonlySet<string>, text: string): number {
  if (terms.size === 0) return 0;
  const seen = contentTerms(text);
  let n = 0;
  for (const t of terms) if (seen.has(t)) n += 1;
  return n;
}

/* ---------------------------------------------------------------------------
   passageAround: the window of a long text densest in the sentence's terms.
   --------------------------------------------------------------------------- */

interface TermHit {
  at: number;
  term: string;
}

/** Every word of `text` (the tokenizer's own split: runs of [a-z0-9]) that is
 * one of `terms`, with its offset. */
function termHits(text: string, terms: ReadonlySet<string>): TermHit[] {
  const hits: TermHit[] = [];
  const lower = text.toLowerCase();
  const re = /[a-z0-9]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower)) !== null) {
    if (terms.has(m[0])) hits.push({ at: m.index, term: m[0] });
  }
  return hits;
}

/** Offsets where a sentence of `text` starts (0 included), and where one
 * ends (text.length included): a run of . ! ? … plus closing quotes or
 * brackets, followed by whitespace. */
function sentenceEdges(text: string): { starts: number[]; ends: number[] } {
  const starts = [0];
  const ends: number[] = [];
  const re = /[.!?…]+["'”’)\]]*(\s+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const end = m.index + m[0].length - m[1]!.length;
    const next = m.index + m[0].length;
    ends.push(end);
    if (next < text.length) starts.push(next);
  }
  ends.push(text.length);
  return { starts, ends };
}

/** The last offset <= limit, of `sorted`, greater than `after`; -1 if none. */
function lastAtMost(sorted: readonly number[], limit: number, after: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= limit) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best >= 0 && sorted[best]! > after ? sorted[best]! : -1;
}

/** The first index of `hits` at or after `from`. */
function firstHitAt(hits: readonly TermHit[], from: number): number {
  let lo = 0;
  let hi = hits.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (hits[mid]!.at < from) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The part of `text`, at most `budget` characters, densest in the terms of
 * `sentence`: the window covering the most distinct terms, then the most
 * term occurrences, then the earliest. Windows are snapped to sentence ends
 * (they start at a sentence start and end at a sentence end); only where no
 * whole sentence fits (an unpunctuated transcript, a run-on sentence) does a
 * window fall back to word edges. A text within budget comes back whole; the
 * result is always a substring of `text`, so a quote taken from it still
 * matches its source.
 */
export function passageAround(text: string, sentence: string, budget: number): string {
  const src = String(text ?? "");
  const limit = Math.max(0, Math.floor(budget));
  if (src.length <= limit) return src;
  if (limit === 0) return "";
  const hits = termHits(src, contentTerms(sentence));
  const { starts, ends } = sentenceEdges(src);

  let best: { start: number; end: number; distinct: number; count: number; snapped: boolean } | null = null;
  const consider = (start: number, end: number, snapped: boolean): void => {
    if (end <= start) return;
    const first = firstHitAt(hits, start);
    const terms = new Set<string>();
    let count = 0;
    for (let i = first; i < hits.length && hits[i]!.at < end; i += 1) {
      /* A hit counts only when the whole word sits inside the window. */
      if (hits[i]!.at + hits[i]!.term.length > end) break;
      terms.add(hits[i]!.term);
      count += 1;
    }
    const cand = { start, end, distinct: terms.size, count, snapped };
    if (
      best === null ||
      cand.distinct > best.distinct ||
      (cand.distinct === best.distinct && cand.count > best.count) ||
      (cand.distinct === best.distinct && cand.count === best.count && cand.snapped && !best.snapped)
    ) {
      best = cand;
    }
  };

  /* Sentence-snapped windows: from each sentence start to the furthest
     sentence end within budget. */
  for (const start of starts) {
    const end = lastAtMost(ends, start + limit, start);
    if (end > 0) consider(start, end, true);
  }
  /* Word-edged fallbacks centred on each hit, for text whose sentences are
     longer than the budget. */
  const wordStartAtOrAfter = (i: number): number => {
    let k = Math.max(0, i);
    if (k > 0 && /\S/.test(src[k - 1]!)) {
      while (k < src.length && /\S/.test(src[k]!)) k += 1;
    }
    while (k < src.length && /\s/.test(src[k]!)) k += 1;
    return k;
  };
  const wordEndAtOrBefore = (i: number, floor: number): number => {
    let k = Math.min(src.length, i);
    if (k < src.length && /\S/.test(src[k]!)) {
      while (k > floor && /\S/.test(src[k - 1]!)) k -= 1;
    }
    while (k > floor && /\s/.test(src[k - 1]!)) k -= 1;
    return k;
  };
  const centres = hits.length > 0 ? hits.map((h) => h.at) : [0];
  for (const at of centres) {
    const start = wordStartAtOrAfter(Math.min(at, Math.max(0, at - Math.floor(limit / 2))));
    const end = wordEndAtOrBefore(start + limit, start);
    consider(start, end, false);
  }

  const chosen = best as { start: number; end: number } | null;
  if (chosen === null) return src.slice(0, limit);
  return src.slice(chosen.start, chosen.end).trim();
}

/* ---------------------------------------------------------------------------
   candidateSourcesFor
   --------------------------------------------------------------------------- */

/** Splits `total` characters over texts of the given lengths: a text shorter
 * than its fair share keeps its whole length and the rest is shared by the
 * longer ones. Integer budgets, summing to at most `total`. */
function shareBudget(lengths: readonly number[], total: number): number[] {
  const out = new Array<number>(lengths.length).fill(0);
  const order = lengths.map((len, i) => ({ len, i })).sort((a, b) => a.len - b.len || a.i - b.i);
  let left = Math.max(0, Math.floor(total));
  let remaining = order.length;
  for (const { len, i } of order) {
    const share = Math.floor(left / remaining);
    const given = Math.min(len, share);
    out[i] = given;
    left -= given;
    remaining -= 1;
  }
  return out;
}

/**
 * The sources `sentence` is judged against: every mustInclude source (in the
 * order given), then up to maxSources more ranked by the number of distinct
 * sentence terms they contain (ties keep input order; a source sharing no
 * term is never added on rank alone). Each returned text is trimmed with
 * passageAround so the texts together are at most maxChars characters.
 * Unknown mustInclude ids are ignored.
 */
export function candidateSourcesFor(
  sentence: string,
  sources: readonly SupportSource[],
  opts: CandidateSourcesOptions = {}
): SupportSource[] {
  const maxChars = opts.maxChars ?? DEFAULT_SUPPORT_MAX_CHARS;
  const maxSources = opts.maxSources ?? DEFAULT_SUPPORT_MAX_SOURCES;
  const must = new Set(opts.mustInclude ?? []);
  const terms = contentTerms(sentence);

  const pinned: SupportSource[] = [];
  for (const id of must) {
    const s = sources.find((x) => x.id === id);
    if (s && !pinned.includes(s)) pinned.push(s);
  }
  const ranked = sources
    .map((s, i) => ({ s, i, overlap: distinctOverlap(terms, s.text) }))
    .filter((r) => !must.has(r.s.id) && r.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || a.i - b.i)
    .slice(0, Math.max(0, maxSources))
    .map((r) => r.s);

  const chosen = [...pinned, ...ranked];
  const budgets = shareBudget(
    chosen.map((s) => String(s.text ?? "").length),
    maxChars
  );
  return chosen.map((s, i) => ({ ...s, text: passageAround(String(s.text ?? ""), sentence, budgets[i]!) }));
}

/* ---------------------------------------------------------------------------
   Judges
   --------------------------------------------------------------------------- */

export interface SentenceSupportItem {
  id: string;
  sentence: string;
  sources: readonly SupportSource[];
}

/** p is the probability (or, for the code judge, the share) that the
 * sentence is backed by its sources; restsOn is the source id it rests on,
 * absent when none does. */
export type SentenceSupportVerdict = { p: number; restsOn?: string } | { unavailable: true; reason: string };

export interface SentenceSupportJudge {
  readonly name: string;
  judge(items: readonly SentenceSupportItem[]): Promise<Map<string, SentenceSupportVerdict>>;
}

export function isSupportUnavailable(v: SentenceSupportVerdict): v is { unavailable: true; reason: string } {
  return "unavailable" in v;
}

function assertDistinctIds(items: readonly SentenceSupportItem[]): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`sentence support: duplicate item id '${item.id}'`);
    ids.add(item.id);
  }
}

export const SUPPORT_JEV_PURPOSE = "sentence-support";
export const SUPPORT_NONE = "none";

export const SUPPORTED_QUESTION_TEXT = {
  instructions:
    "Judge whether `sentence` is backed by `sources`. Read each source literally and use nothing beyond them: a fact, name, number or date in the sentence counts as backed only when a source states it.",
  criteria: {
    true: "Every statement of fact in `sentence` is backed by at least one of `sources`, read literally.",
    false: "Some statement in `sentence` is not in `sources`."
  }
} as const;

export const RESTS_ON_INSTRUCTIONS =
  "Choose the one source in `sources` that `sentence` rests on most: the source that states what the sentence says. Choose none when no source backs it.";

/** The two questions of one support ask, over the source keys s1..sN. */
export function supportQuestions(keys: readonly string[]): [JevNoulQuestion, JevChoiceQuestion] {
  const criteria: Record<string, { what: string }> = {};
  for (const k of keys) criteria[k] = { what: `The sentence rests on source ${k}.` };
  criteria[SUPPORT_NONE] = { what: "No source in `sources` backs the sentence." };
  return [
    {
      id: "supported",
      type: "noul",
      instructions: SUPPORTED_QUESTION_TEXT.instructions,
      criteria: { ...SUPPORTED_QUESTION_TEXT.criteria }
    },
    { id: "restsOn", type: "choice", instructions: RESTS_ON_INSTRUCTIONS, criteria }
  ];
}

export interface JevSentenceSupportJudgeOptions {
  /** Asks in flight at once (default 8, the Jev pool size). */
  maxInFlight?: number;
  /** The CallRecord and cost-event label (default 'sentence-support'). */
  purpose?: string;
  signal?: AbortSignal;
}

/**
 * One Jev ask per sentence, through `client` (the metered client, so every
 * ask is charged to BudgetGuard) inside a pool of at most `maxInFlight`.
 * The state is {sentence, sources:{s1..sN}} with each source's text only;
 * real source ids never leave the network, s<k> maps back to them.
 *
 * A failed ask (no key, network, timeout, HTTP, malformed reply) or an answer
 * that does not fit the questions is {unavailable}. A sentence with no
 * sources is {p: 0} without an ask: nothing can back it. A budget stop
 * thrown by the metered client propagates, like every model call's.
 */
export class JevSentenceSupportJudge implements SentenceSupportJudge {
  readonly name = "jev";
  private readonly pool: JevClient;
  private readonly purpose: string;
  private readonly signal: AbortSignal | undefined;

  constructor(client: JevClient, opts: JevSentenceSupportJudgeOptions = {}) {
    this.pool = createJevPool(client, { maxInFlight: opts.maxInFlight ?? DEFAULT_JEV_POOL_SIZE });
    this.purpose = opts.purpose ?? SUPPORT_JEV_PURPOSE;
    this.signal = opts.signal;
  }

  async judge(items: readonly SentenceSupportItem[]): Promise<Map<string, SentenceSupportVerdict>> {
    assertDistinctIds(items);
    const verdicts = await Promise.all(items.map((item) => this.judgeOne(item)));
    return new Map(items.map((item, i) => [item.id, verdicts[i]!]));
  }

  private async judgeOne(item: SentenceSupportItem): Promise<SentenceSupportVerdict> {
    if (item.sources.length === 0) return { p: 0 };
    const keys = item.sources.map((_, i) => `s${i + 1}`);
    const state = {
      sentence: item.sentence,
      sources: Object.fromEntries(item.sources.map((s, i) => [keys[i]!, s.text]))
    };
    const questions = supportQuestions(keys);
    const result = await this.pool.ask(state, questions, {
      purpose: this.purpose,
      ...(this.signal ? { signal: this.signal } : {})
    });
    if (!result.ok) return { unavailable: true, reason: result.error.reason };
    return readSupportAnswers(result.answers, keys, item.sources);
  }
}

/** Maps a support ask's answers to a verdict: p = the noul value, restsOn =
 * the chosen source's id ('none' leaves it absent). Anything that does not
 * fit the questions is {unavailable, 'malformed_answer'}. */
export function readSupportAnswers(
  answers: readonly JevAnswer[],
  keys: readonly string[],
  sources: readonly SupportSource[]
): SentenceSupportVerdict {
  const malformed = { unavailable: true as const, reason: "malformed_answer" };
  const supported = answers.find((a) => a.id === "supported");
  const restsOn = answers.find((a) => a.id === "restsOn");
  if (!supported || supported.type !== "noul") return malformed;
  if (!restsOn || restsOn.type !== "choice") return malformed;
  const p = supported.noul;
  if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) return malformed;
  if (restsOn.choice === SUPPORT_NONE) return { p };
  const at = keys.indexOf(restsOn.choice);
  if (at < 0) return malformed;
  return { p, restsOn: sources[at]!.id };
}

/**
 * The code judge: p = the share of the sentence's distinct content words
 * (tokenizeForSourcing) found in its best source; restsOn = that source when
 * p > 0 (the first one on a tie). A sentence with no content words, or no
 * sources, is {p: 0}. Never unavailable: it needs no model.
 */
export class CodeOverlapSupportJudge implements SentenceSupportJudge {
  readonly name = "code-overlap";

  async judge(items: readonly SentenceSupportItem[]): Promise<Map<string, SentenceSupportVerdict>> {
    assertDistinctIds(items);
    const out = new Map<string, SentenceSupportVerdict>();
    for (const item of items) {
      const terms = contentTerms(item.sentence);
      let bestP = 0;
      let bestId: string | undefined;
      if (terms.size > 0) {
        for (const s of item.sources) {
          const p = distinctOverlap(terms, s.text) / terms.size;
          if (p > bestP) {
            bestP = p;
            bestId = s.id;
          }
        }
      }
      out.set(item.id, bestId !== undefined ? { p: bestP, restsOn: bestId } : { p: 0 });
    }
    return out;
  }
}
