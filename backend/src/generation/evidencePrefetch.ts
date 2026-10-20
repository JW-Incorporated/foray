import { beatKindOf, claimHash, type EvidenceBeat, type EvidenceGatherer, type EvidencePack, type TapeEvidenceMetrics } from "./gatherEvidence";
import { decideConnectiveNarration, evidenceBeatFor, slotNeighbours, type SlotNeighbours } from "./writeNarration";
import { findBudgetError } from "../cost/budgetGuard";
import type { ExternalResearchContext } from "./ExternalResearcher";
import type { SourcedAct, SourcedSlot, TapePointer } from "../types/tapeSourcing";

/**
 * G-35 / latency model M6: gather every narration page's evidence in ONE
 * bounded fan-out right after `source`, so that by the time `writeNarration`
 * asks for a beat's pack the answer is already in hand.
 *
 * WHAT WAS ON THE CRITICAL PATH BEFORE. The narration stage gathers its
 * pages' evidence before it writes, and acts were narrated
 * one after another — so act 2's retrieval could not start until act 1 had
 * been written, verified and stitched, and act 1's own retrieval sat between
 * `source` finishing and the first writer call. Retrieval is a Haiku web
 * search per query, two queries per content page (F-60), and about half of
 * first queries come back empty [measured, attempt 4b]; the latency model puts
 * it at 12–60 s per later act and 12–30 s of ttlA1.
 *
 * WHAT THIS DOES INSTEAD. One pass over every act, every slot, every page
 * the narration stage would gather for, through the SAME gatherer with the SAME
 * `EvidenceBeat` — so the on-disk cache `gatherEvidence.ts` keeps by claim
 * hash is warm for `writeNarration`, and (because a dry-run's stub researcher
 * keeps no disk cache, and because a disk read is still a read) the pack is
 * ALSO held in memory here, keyed by the same claim hash plus the fields
 * that change a pack's shape. `writeNarration` is handed THIS object as its
 * gatherer and finds every page answered without a retrieval call.
 *
 * WHY NOT DURING DEEPEN. The card allows the seeded claims' retrieval to
 * start during `deepen` (their claims are frozen at the spine, F-68, so
 * their cache keys are known early). It does not fit cleanly: a seeded beat
 * is exactly the beat most likely to SOURCE TO TAPE, and a tape beat whose
 * transcript window is held is never sent to the web at all (F-69) — so a
 * deepen-time retrieval for it would be spend on a question narration will
 * never ask, and whether it sources to tape is only known after `source`.
 * Whether the page even carries content (which decides the second query)
 * is decided at the same point. So the fan-out waits for `source`; what it
 * costs is the few seconds `source` takes, which is keyless and fast.
 *
 * WHAT IT NEVER DOES: write to disk (the gatherer it wraps owns the cache),
 * call a writer, or decide anything about a page — the page list is derived
 * by the same two functions the narration stage uses, and a test proves the two
 * agree by asking `writeNarration` to run over a prefetched act and counting
 * zero gathers reaching the wrapped gatherer.
 */

/** How many pages are gathered at once. Each content page is up to two
 * concurrent Haiku searches (`gatherEvidence.ts`), so the in-flight request
 * count is up to twice this. 6 is the card's default; the 429 behaviour of
 * a keyed run is what G-20's first live run measures. */
export const DEFAULT_EVIDENCE_PREFETCH_CONCURRENCY = 6;

/** `EVIDENCE_PREFETCH_CONCURRENCY`, read on every call rather than at
 * startup so a test can pin it and an operator can lower it for one run.
 * Anything that is not a whole number ≥ 1 falls back to the default. */
export function evidencePrefetchConcurrency(): number {
  const raw = process.env.EVIDENCE_PREFETCH_CONCURRENCY;
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_EVIDENCE_PREFETCH_CONCURRENCY;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_EVIDENCE_PREFETCH_CONCURRENCY;
}

/** What `report.json` carries about retrieval for the run (`meta.veracity.
 * retrieval`). Wall times are real `Date.now()` differences, like every
 * other timing in `stageTiming.ts`. */
export interface EvidencePrefetchMetrics extends Partial<TapeEvidenceMetrics> {
  /** Wall time of the whole fan-out — the retrieval that moved OFF the
   * narration path. When the fan-out ran as a timed pipeline stage this IS
   * that stage's number (`recordStageMs`), not a second reading of the
   * clock beside it: two `Date.now()` pairs bracketing the same work
   * disagree by a millisecond whenever a tick lands between their starts,
   * and PR #623's CI run caught exactly that — `evidence` at 1 ms,
   * `prefetchMs` at 0. */
  prefetchMs: number;
  concurrency: number;
  /** Pages the fan-out was asked for, split by what happened to them. A
   * `skipped` page belongs to a slot a resumed run will not narrate again. */
  pages: number;
  prefetched: number;
  failed: number;
  skipped: number;
  /** After the fan-out: every pack narration asked for, and how many of
   * those were already held. `hitRate` is `narrationHits / narrationGathers`,
   * `null` when narration asked for nothing. */
  narrationGathers: number;
  narrationHits: number;
  hitRate: number | null;
  /** Wall time narration still spent waiting inside `gather` — summed over
   * calls, so with a full prefetch it is a few milliseconds of memo lookups,
   * and every retrieval that stayed on the critical path shows up here. */
  narrationRetrievalMs: number;
  /** GV-98 (FORAY_EVIDENCE_PREFETCH=first-act): present only when a
   * background fan-out ran (`startBackground`), so the default run's row is
   * unchanged. `pages`, `prefetched`, `failed` and `skipped` above are then
   * the two phases together; these split `pages` into the phase the timed
   * `evidence` stage waited for and the phase gathered behind it, and
   * `backgroundMs` is the background fan-out's wall time (so far, when it is
   * read before `settleBackground`). */
  timedPages?: number;
  backgroundPages?: number;
  backgroundMs?: number;
  /* GV-76 (QK-27): `tapeDocsBuilt` and `tapeDocsCut`, inherited from
     `TapeEvidenceMetrics`, are the wrapped gatherer's counts, present when it
     keeps them (`DefaultEvidenceGatherer` does). QK-27 is
     tapeDocsCut / tapeDocsBuilt. */
}

/**
 * The evidence beats the narration stage will gather for this slot, built
 * by the same rules: every narration beat is a page in its assigned mode; a
 * tape beat is a page only where `decideConnectiveNarration` gives it one;
 * a page carries content (and so earns F-60's second query) exactly when
 * `pageCarriesContent` says so. Kept as a pure function so the parity with
 * `writeAct.ts` is a thing a test can hold still.
 */
export function evidenceBeatsFor(slot: SourcedSlot, neighbours: SlotNeighbours = {}): EvidenceBeat[] {
  const beats: EvidenceBeat[] = [];
  for (let i = 0; i < slot.beats.length; i++) {
    const beat = slot.beats[i]!;
    /* Q-02: EVERY tape beat is gathered, not only the ones
       `decideConnectiveNarration` gives a page. The per-act writer needs
       each clip's window for the Intro decision (is the host's own
       introduction in its opening?) and the restate check, and a
       same-episode continuation still needs both. The mode is only the key's
       `requiresEvidence` (false for any connective mode), so "Intro" here
       and the act path's `decideConnectiveNarration(...) ?? "Intro"` build
       the same key. */
    const mode = beat.sourcing === "narration" ? beat.narration.mode : (decideConnectiveNarration(slot, i) ?? "Intro");
    /* F-82: the SAME builder `writeAct.ts` uses, neighbours included — the
       adjacent windows are part of the pack, so they are part of the key. */
    beats.push(evidenceBeatFor(slot, i, mode, neighbours));
  }
  return beats;
}

/** The in-memory key: the claim hash the disk cache uses, plus every field
 * of an `EvidenceBeat` that changes what `gather` returns for it — the beat
 * kind (an argument beat gets no tape), whether the page carries content
 * (which decides the second query), the tape pointer (which decides the
 * cue window), and (F-82) the adjacent segments whose windows join the
 * pack. Two beats with the same key get the same pack. */
export function evidenceMemoKey(beat: EvidenceBeat): string {
  const pointerKey = (p: TapePointer | undefined): string => (p ? `${p.itemId}@${p.startSec}-${p.endSec}` : "");
  const adjacent = beat.adjacentTape ? `prev:${pointerKey(beat.adjacentTape.previous)}|next:${pointerKey(beat.adjacentTape.next)}` : "";
  return `${claimHash(beat.claim)}|${beatKindOf(beat)}|${beat.requiresEvidence === true ? "content" : "connective"}|${pointerKey(beat.tape)}|${adjacent}`;
}

export interface PrefetchOptions {
  /** Defaults to `evidencePrefetchConcurrency()`. */
  concurrency?: number;
  /** A slot a resumed run will not narrate again (`runPipeline.ts` answers
   * from the checkpoint's `narrate:<act>` / `narrate:<act>:<slot>` keys).
   * Its pages are counted as `skipped` and never gathered. */
  skipSlot?: (actIndex: number, slotIndex: number) => boolean;
  /** GV-98: only the acts this answers true for are queued; the others are
   * neither gathered nor counted by THIS call (they belong to the other
   * phase). Unset: every act, as before. */
  acts?: (actIndex: number) => boolean;
}

/** What one phase of the fan-out did with its pages. */
interface PhaseTally {
  prefetched: number;
  failed: number;
}

/** GV-98: the background phase, from `startBackground` to its last page. */
interface BackgroundPhase extends PhaseTally {
  pages: number;
  skipped: number;
  startedAt: number;
  /** Set when the last worker has finished; `null` while it runs. */
  ms: number | null;
  /** Set by `settleBackground({ stop: true })`: no worker takes a new page. */
  stopped: boolean;
  promise: Promise<void>;
}

/**
 * An `EvidenceGatherer` that answers from what it prefetched, and otherwise
 * from the gatherer it wraps — never from nothing. Handed to
 * `writeNarration` in place of its default so a narration-time `gather` is a
 * memo lookup. A miss is not an error: the wrapped gatherer is asked, the
 * answer is memoised for the rest of the run, and the miss is counted so
 * `report.json` says how much retrieval stayed on the critical path.
 */
export class PrefetchingEvidenceGatherer implements EvidenceGatherer {
  private readonly memo = new Map<string, Promise<EvidencePack>>();
  private prefetchFinished = false;
  private stats = { prefetchMs: 0, concurrency: 0, pages: 0, prefetched: 0, failed: 0, skipped: 0 };
  private narration = { gathers: 0, hits: 0, ms: 0 };
  /** GV-98: every key either phase has queued, so a page shared by act 1
   * and a later act is gathered (and counted) once, by the phase that saw
   * it first. */
  private readonly queued = new Set<string>();
  private background: BackgroundPhase | null = null;
  /** GV-98: a budget stop the background fan-out hit, thrown by the next
   * `gather` (the shape of `DefaultEvidenceGatherer.deferredBudgetError`),
   * so the run stops in the narrate stage that asked, named by it. */
  private deferredBudgetError: unknown = undefined;

  constructor(private readonly inner: EvidenceGatherer) {}

  /**
   * The fan-out. Every page of every act not skipped, through at most
   * `concurrency` gathers at a time. A page whose gather throws is counted
   * and NOT memoised, so narration asks again for it through the normal
   * path — the prefetch can only ever make a run faster, never change what
   * it produces. Resolves when the last page has landed.
   */
  async prefetch(acts: SourcedAct[], ctx: ExternalResearchContext, options: PrefetchOptions = {}): Promise<EvidencePrefetchMetrics> {
    const concurrency = Math.max(1, Math.floor(options.concurrency ?? evidencePrefetchConcurrency()));
    const start = Date.now();
    const { queue, skipped } = this.buildQueue(acts, options);
    const tally: PhaseTally = { prefetched: 0, failed: 0 };
    /* A budget stop ends the run at this stage, as it would anywhere. */
    await this.runQueue(queue, ctx, concurrency, tally, () => false);

    this.stats = { prefetchMs: Date.now() - start, concurrency, pages: queue.length + skipped, prefetched: tally.prefetched, failed: tally.failed, skipped };
    this.prefetchFinished = true;
    return this.metrics();
  }

  /**
   * GV-98 (FORAY_EVIDENCE_PREFETCH=first-act): the same fan-out, NOT awaited.
   * The pipeline awaits `prefetch` for act 1's pages only, starts this for
   * every later act's, and lets act 1's writer begin; a later act's
   * narration-time `gather` shares whatever is in flight through the memo
   * (`lookup`), so no page is gathered twice. Returns at once.
   *
   * A budget stop is not thrown from here (nobody is awaiting it): it is held
   * and thrown by the next `gather`, and no worker takes another page. Any
   * other failure is counted, as in `prefetch`. The promise never rejects;
   * `settleBackground` awaits it, and the pipeline does so on every exit path.
   */
  startBackground(acts: SourcedAct[], ctx: ExternalResearchContext, options: PrefetchOptions = {}): void {
    if (this.background) throw new Error("PrefetchingEvidenceGatherer.startBackground: the background fan-out has already been started");
    const concurrency = Math.max(1, Math.floor(options.concurrency ?? evidencePrefetchConcurrency()));
    const startedAt = Date.now();
    const { queue, skipped } = this.buildQueue(acts, options);
    const phase: BackgroundPhase = {
      pages: queue.length + skipped,
      skipped,
      prefetched: 0,
      failed: 0,
      startedAt,
      ms: null,
      stopped: false,
      promise: Promise.resolve()
    };
    this.background = phase;
    phase.promise = this.runQueue(
      queue,
      ctx,
      concurrency,
      phase,
      () => phase.stopped || this.deferredBudgetError !== undefined,
      (err) => {
        if (this.deferredBudgetError === undefined) this.deferredBudgetError = err;
      }
    )
      .catch((err: unknown) => {
        /* Unreachable while every worker catches its own page's error; kept so
           the promise can never become an unhandled rejection. */
        console.warn(`evidencePrefetch: the background fan-out stopped (${err instanceof Error ? err.message : String(err)})`);
      })
      .finally(() => {
        phase.ms = Date.now() - startedAt;
      });
  }

  /**
   * GV-98: waits for the background fan-out to finish (at once when none was
   * started). Never throws. `stop` lets the pages already in flight land but
   * starts no more: the failure path's call, so a run that is ending does
   * not keep paying for evidence nobody will read.
   */
  async settleBackground(options: { stop?: boolean } = {}): Promise<void> {
    const phase = this.background;
    if (!phase) return;
    if (options.stop) phase.stopped = true;
    await phase.promise;
  }

  /** The page list for one phase: every page of every act `options.acts`
   * admits, minus skipped slots and keys a phase has already queued. */
  private buildQueue(acts: SourcedAct[], options: PrefetchOptions): { queue: EvidenceBeat[]; skipped: number } {
    const queue: EvidenceBeat[] = [];
    let skipped = 0;
    acts.forEach((act, actIndex) => {
      if (options.acts && !options.acts(actIndex)) return;
      act.slots.forEach((slot, slotIndex) => {
        const beats = evidenceBeatsFor(slot, slotNeighbours(act, slotIndex));
        if (options.skipSlot?.(actIndex, slotIndex)) {
          skipped += beats.length;
          return;
        }
        for (const beat of beats) {
          /* Two pages with the same key share one gather; counting the
             second would report a page that was never fetched. */
          const key = evidenceMemoKey(beat);
          if (this.queued.has(key)) continue;
          this.queued.add(key);
          queue.push(beat);
        }
      });
    });
    return { queue, skipped };
  }

  /**
   * The bounded worker pool both phases use: at most `concurrency` gathers in
   * flight, each page counted into `tally`. A page whose gather throws is
   * counted and NOT memoised, so narration asks again for it through the
   * normal path. A budget stop is rethrown, or, given `onBudgetError`, handed
   * to it and this worker stops. `stop` is checked before each new page.
   */
  private async runQueue(
    queue: EvidenceBeat[],
    ctx: ExternalResearchContext,
    concurrency: number,
    tally: PhaseTally,
    stop: () => boolean,
    onBudgetError?: (err: unknown) => void
  ): Promise<void> {
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < queue.length && !stop()) {
        const beat = queue[next++]!;
        try {
          const pack = await this.lookup(beat, ctx);
          /* gen-5: a pack whose retrieval FAILED is counted as failed, and
             lookup() has already dropped it from the memo so narration asks
             again. */
          if (pack.retrievalFailed) {
            tally.failed += 1;
            console.warn(`evidencePrefetch: retrieval failed for "${beat.claim.slice(0, 60)}" — narration will ask again`);
          } else tally.prefetched += 1;
        } catch (err) {
          if (findBudgetError(err)) {
            if (!onBudgetError) throw err;
            onBudgetError(err);
            return;
          }
          tally.failed += 1;
          console.warn(
            `evidencePrefetch: could not gather for "${beat.claim.slice(0, 60)}" — narration will ask again (${err instanceof Error ? err.message : String(err)})`
          );
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));
  }

  /** `writeNarration`'s call. Counted against the prefetch only once the
   * fan-out has finished — before that, the fan-out and any early caller
   * simply share in-flight work. */
  async gather(beat: EvidenceBeat, ctx: ExternalResearchContext): Promise<EvidencePack> {
    /* GV-98: the background fan-out's budget stop, surfaced here. */
    if (this.deferredBudgetError !== undefined) throw this.deferredBudgetError;
    if (!this.prefetchFinished) return this.lookup(beat, ctx);
    const start = Date.now();
    this.narration.gathers += 1;
    if (this.memo.has(evidenceMemoKey(beat))) this.narration.hits += 1;
    try {
      return await this.lookup(beat, ctx);
    } finally {
      this.narration.ms += Date.now() - start;
    }
  }

  /** The memo: one in-flight or settled gather per key. A rejected gather is
   * dropped from the memo so the next asker retries rather than inheriting
   * the failure. */
  private lookup(beat: EvidenceBeat, ctx: ExternalResearchContext): Promise<EvidencePack> {
    const key = evidenceMemoKey(beat);
    const held = this.memo.get(key);
    if (held) return held;
    const pending = this.inner.gather(beat, ctx).then(
      (pack) => {
        /* gen-5: a pack whose retrieval failed (a 429, a network error) is
           handed to THIS asker but not kept: it is not a verdict, and a memo
           that kept it would give every later round the same empty pack. */
        if (pack.retrievalFailed && this.memo.get(key) === pending) this.memo.delete(key);
        return pack;
      },
      (err: unknown) => {
        if (this.memo.get(key) === pending) this.memo.delete(key);
        throw err;
      }
    );
    this.memo.set(key, pending);
    return pending;
  }

  /** The pipeline's `evidence` stage, once timed, hands its wall-clock
   * number here so `report.json` carries ONE measurement of the fan-out
   * (see `EvidencePrefetchMetrics.prefetchMs`). `prefetch()`'s own reading
   * stands only for a caller that runs it outside a stage log. */
  recordStageMs(ms: number): void {
    this.stats.prefetchMs = ms;
  }

  metrics(): EvidencePrefetchMetrics {
    const { gathers, hits, ms } = this.narration;
    const phase = this.background;
    return {
      ...this.stats,
      /* GV-98: only when a background fan-out ran, so the default row is
         unchanged. Spread over `stats`, so the totals keep their keys'
         places. */
      ...(phase
        ? {
            pages: this.stats.pages + phase.pages,
            prefetched: this.stats.prefetched + phase.prefetched,
            failed: this.stats.failed + phase.failed,
            skipped: this.stats.skipped + phase.skipped,
            timedPages: this.stats.pages,
            backgroundPages: phase.pages,
            backgroundMs: phase.ms ?? Date.now() - phase.startedAt
          }
        : {}),
      narrationGathers: gathers,
      narrationHits: hits,
      hitRate: gathers === 0 ? null : hits / gathers,
      narrationRetrievalMs: ms,
      /* GV-76: the wrapped gatherer's tape counts, so they reach
         `veracity.retrieval` with the rest of this row. */
      ...(this.inner.tapeEvidenceMetrics ? this.inner.tapeEvidenceMetrics() : {})
    };
  }

  /** One line for the run log, in the same voice as `summarizeSourcing`. */
  summaryLine(): string {
    const m = this.metrics();
    const rate = m.hitRate === null ? "n/a" : `${Math.round(m.hitRate * 100)}%`;
    return (
      `evidence: prefetched ${m.prefetched}/${m.pages} pages in ${m.prefetchMs} ms (${m.concurrency} at a time` +
      `${m.failed ? `, ${m.failed} failed` : ""}${m.skipped ? `, ${m.skipped} skipped as already narrated` : ""}` +
      `${m.backgroundPages !== undefined ? `, ${m.backgroundPages} of them behind act 1 in ${m.backgroundMs} ms` : ""}); ` +
      `narration hit the prefetch ${m.narrationHits}/${m.narrationGathers} (${rate}), ${m.narrationRetrievalMs} ms of retrieval left on its path (G-35)`
    );
  }
}
