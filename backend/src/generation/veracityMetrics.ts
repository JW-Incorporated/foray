import * as fs from "fs";
import * as path from "path";
import type { StageTiming } from "./stageTiming";
import type { EvidencePrefetchMetrics } from "./evidencePrefetch";
import type { SourcedAct, SourcedSlot, TapeRelevanceInput } from "../types/tapeSourcing";
import type { WrittenAct } from "./writeNarration";
import { decideConnectiveNarration } from "./writeNarration";
import { isTapeSource, purposeWasRevised, tapeDocIdFor, type NarratedBeat, type NarrationAttemptRecord } from "../types/narration";
import { phraseIsInWindow } from "../types/anchorText";
import { loadCatalogueData, type CatalogueShow } from "./catalogueLookup";
import { loadSegmentPool, type SegmentRecord } from "./segmentPoolLookup";

/**
 * WS-B (docs/curation/generation-fix-plan-2026-09-09.md §WS-B): "the AI
 * slop ask" made measurable. Every metric here reads ONLY what the
 * pipeline already produced by the time it is called — no new model
 * call, nothing re-judged. Some of what §WS-B asks for (`groundedQuoteRate`,
 * `purposeFidelity`) genuinely cannot be computed from what exists in this
 * checkout today; those return `null`, on purpose, rather than a
 * misleadingly perfect number — see each function's own comment for why.
 * Run 1's whole postmortem (F-27, F-32, F-41, F-45, F-46) is a catalogue of
 * exactly this failure mode ("nothing checks X, so X reads as fine"); a
 * veracity metric that quietly reports 1.0 for an unmeasured claim would
 * be the same bug wearing a metrics hat.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/* ------------------------------------------------------------------ */
/* Shared flattening                                                    */
/* ------------------------------------------------------------------ */

export interface FlatWrittenPage {
  claim: string;
  page: NarratedBeat;
}

/** Every written page in the candidate, narration-sourced or connective,
 * with the beat claim it belongs to (lost once flattened through
 * `allWrittenNarration` in `writeNarration.ts`, which this module needs
 * back for readable failing-page reports). */
export function flattenWrittenPages(acts: WrittenAct[]): FlatWrittenPage[] {
  const out: FlatWrittenPage[] = [];
  for (const act of acts) {
    for (const slot of act.slots) {
      for (const beat of slot.beats) {
        if (beat.sourcing === "narration") out.push({ claim: beat.claim, page: beat.narration });
        else if (beat.connectiveNarration) out.push({ claim: beat.claim, page: beat.connectiveNarration });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* groundedQuoteRate                                                    */
/* ------------------------------------------------------------------ */

export interface FailingPage {
  claim: string;
  mode: string;
  reason: "ungrounded-quote" | "off-topic-tape" | "unverified-page";
  detail: string;
}

function normalizeQuote(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export interface GroundedQuoteResult {
  rate: number | null;
  checkableQuotes: number;
  groundedQuotes: number;
  ungroundedPages: FailingPage[];
}

/**
 * "Quotes that are substrings of held docs / all quotes" (WS-B spec),
 * computed only over quotes whose page carries an `evidence` array
 * (WS-A's addition — see `types/narration.ts`). A quote on a page with NO
 * `evidence` is not "ungrounded", it is UNCHECKABLE — this checkout has no
 * held text to check it against yet, so it is excluded from both the
 * numerator and the denominator rather than counted either way. When no
 * page anywhere in the candidate carries evidence, `rate` is `null`: this
 * is the exact case the fix plan calls out by name ("must be 1.0 after
 * WS-A; the metric exists so a regression is visible") — reporting `1.0`
 * (or `0`) here before WS-A lands would assert something nothing checked.
 */
export function computeGroundedQuoteRate(writtenActs: WrittenAct[]): GroundedQuoteResult {
  let checkableQuotes = 0;
  let groundedQuotes = 0;
  const ungroundedPages: FailingPage[] = [];

  for (const { claim, page } of flattenWrittenPages(writtenActs)) {
    const evidence = page.evidence;
    if (!evidence || evidence.length === 0) continue;
    const haystacks = evidence.map((e: { text: string }) => normalizeQuote(e.text));
    const bad: string[] = [];
    for (const source of page.sources) {
      if (isTapeSource(source)) {
        /* F-81: a tape source rests on the whole transcript window, not on
           a quote. One with no quote has nothing to check and counts
           nowhere. One with a quote is checked exactly as the narration
           gate checked it — a whole-word span of the segment's own window
           under the anchor canonicalisation — so a phrase narration
           accepted cannot be refused at publish for a punctuation
           difference the gate forgave. */
        if (source.quote === undefined) continue;
        checkableQuotes++;
        const window = evidence.find((e) => e.docId === tapeDocIdFor(source.segmentId));
        if (window && phraseIsInWindow(source.quote, window.text)) groundedQuotes++;
        else bad.push(source.quote);
        continue;
      }
      checkableQuotes++;
      const needle = normalizeQuote(source.quote);
      const grounded = needle.length > 0 && haystacks.some((h) => h.includes(needle));
      if (grounded) groundedQuotes++;
      else bad.push(source.quote);
    }
    if (bad.length > 0) {
      ungroundedPages.push({
        claim,
        mode: page.mode,
        reason: "ungrounded-quote",
        detail: `${bad.length} quote(s) not found verbatim in the ${evidence.length} held evidence doc(s): ${bad
          .slice(0, 2)
          .map((q) => `"${q.slice(0, 80)}"`)
          .join("; ")}`
      });
    }
  }

  return {
    rate: checkableQuotes > 0 ? groundedQuotes / checkableQuotes : null,
    checkableQuotes,
    groundedQuotes,
    ungroundedPages
  };
}

/* ------------------------------------------------------------------ */
/* attributionStability                                                 */
/* ------------------------------------------------------------------ */

/**
 * "For pages that were retried, share of quotes whose publication did not
 * change across attempts" (WS-B spec; the failure named is F-32 — the same
 * quote span attributed to Wikipedia on one attempt and Encyclopaedia
 * Britannica on the next, verbatim). Computed from `NarratedBeat.attempts`
 * (`writeNarration.ts`'s `writePageAndVerify` populates it for every page
 * it writes in THIS checkout). Only a claim that recurs across two or more
 * attempts of the SAME page is counted — a claim that appears once
 * (dropped or introduced on a later attempt) has nothing to compare it
 * against. `null` when nothing in the candidate has more than one
 * attempt-with-a-matching-claim to compare (e.g. every page passed first
 * try, or nothing recorded `attempts` at all) — a candidate with zero
 * retries is not evidence of stability, it is an absence of the test.
 */
export function computeAttributionStability(writtenActs: WrittenAct[]): number | null {
  let stableClaims = 0;
  let comparedClaims = 0;

  for (const { page } of flattenWrittenPages(writtenActs)) {
    const attempts: NarrationAttemptRecord[] | undefined = page.attempts;
    if (!attempts || attempts.length < 2) continue;

    const publicationsByClaim = new Map<string, string[]>();
    for (const a of attempts) {
      for (const s of a.sources) {
        const list = publicationsByClaim.get(s.claimText) ?? [];
        list.push(s.publication);
        publicationsByClaim.set(s.claimText, list);
      }
    }

    for (const publications of publicationsByClaim.values()) {
      if (publications.length < 2) continue;
      comparedClaims++;
      if (publications.every((p) => p === publications[0])) stableClaims++;
    }
  }

  return comparedClaims > 0 ? stableClaims / comparedClaims : null;
}

/* ------------------------------------------------------------------ */
/* firstAttemptPassRate                                                 */
/* ------------------------------------------------------------------ */

/**
 * Share of KEPT pages whose `attempts.length === 1` — the page the
 * candidate carries today was accepted on the writer's first try. Honest
 * scope, stated because it undercounts the failure mode the KPI table
 * names: a connective page that fails all `NARRATION_PAGE_ATTEMPTS` tries
 * is DROPPED (`writeNarration.ts`'s `writeOneBeat` catch branch — tape
 * kept, page silently discarded) and never reaches the final `WrittenAct[]`
 * this function reads, so its 0-for-3 record is invisible here. Those
 * drops are counted separately by `computePagesDropped`; this metric only
 * ever speaks for pages that survived. `null` when nothing in the
 * candidate carries `attempts` data.
 */
export function computeFirstAttemptPassRate(writtenActs: WrittenAct[]): number | null {
  let firstAttempt = 0;
  let total = 0;
  for (const { page } of flattenWrittenPages(writtenActs)) {
    const attempts = page.attempts;
    if (!attempts || attempts.length === 0) continue;
    total++;
    if (attempts.length === 1) firstAttempt++;
  }
  return total > 0 ? firstAttempt / total : null;
}

/* ------------------------------------------------------------------ */
/* purposeFidelity                                                      */
/* ------------------------------------------------------------------ */

/**
 * "Verifier's yes/no per page, averaged" (WS-B spec). This function was
 * written to return `null`, always, and said so: pre-WS-A the verifier
 * exposed one boolean, `verified`, which conflated "every claim is backed
 * by its quote" with "the page accomplishes the beat's purpose" — F-41's
 * whole complaint being that nothing asked the second question at all.
 *
 * WS-A now asks it, and `NarratedBeat.purposeAccomplished` carries the
 * answer as its own field, so this averages that instead. The reason it is
 * NOT `verified` still stands and is worth keeping in view: `verified` is
 * trivially `true` on every page this module can ever see, because
 * `writeNarration.ts` only returns a page once verification passes.
 *
 * `purposeAccomplished` is close to that by construction too — a page that
 * never gets a yes is retried, then dropped or fatal — so read this as a
 * REGRESSION ALARM rather than a score: below 1.0 means the question
 * stopped being asked or stopped being enforced. Pages that carry no such
 * field are skipped rather than counted as failures (a hand-built fixture,
 * or the disclosure beat, is not evidence about the verifier), and `null`
 * still means "nothing in this candidate could be checked" — which the
 * publish gate below treats as failing, not as passing.
 */
export function computePurposeFidelity(writtenActs: WrittenAct[]): number | null {
  let accomplished = 0;
  let total = 0;
  for (const { page } of flattenWrittenPages(writtenActs)) {
    if (typeof page.purposeAccomplished !== "boolean") continue;
    total++;
    if (page.purposeAccomplished) accomplished++;
  }
  return total > 0 ? accomplished / total : null;
}

/* ------------------------------------------------------------------ */
/* tapeRelevance                                                        */
/* ------------------------------------------------------------------ */

export interface TapeAnchorNote {
  itemId: string;
  claim: string;
  /** `null` when neither signal below resolved — nothing to judge the
   * anchor against, not a pass. */
  onTopic: boolean | null;
  /** Taxonomy families found for this anchor's episode/segment (e.g.
   * `["engineering"]`), from whichever of the two signals resolved. Listed
   * (not just a boolean) so a human spot-checking the list can see WHY. */
  families: string[];
}

export interface TapeRelevanceResult {
  rate: number | null;
  anchors: TapeAnchorNote[];
}

interface SegmentSourceRecord {
  id: string;
  show: string;
}

let cachedSegmentSources: SegmentSourceRecord[] | null = null;

/** `data/segment-sources.json` — the item-id -> show-title registry
 * `finalizeForay.ts` also reads (raw, for `check-forays.mjs`). No existing
 * TS module exposes a typed loader for it, so this is a small,
 * purpose-built one; cached per-process like every other catalogue reader
 * in this stage (`FORAY_SKIP_CATALOGUE_CACHE=1` disables it, same
 * convention as `catalogueLookup.ts`/`segmentPoolLookup.ts`). */
function loadSegmentSources(root: string = REPO_ROOT): SegmentSourceRecord[] {
  if (cachedSegmentSources && process.env.FORAY_SKIP_CATALOGUE_CACHE !== "1") return cachedSegmentSources;
  const raw = fs.readFileSync(path.join(root, "data", "segment-sources.json"), "utf8");
  const parsed = JSON.parse(raw) as { sources?: SegmentSourceRecord[] };
  cachedSegmentSources = parsed.sources ?? [];
  return cachedSegmentSources;
}

/** Test seam, mirrors `resolveTopic.ts`'s `resetTaxonomyCache`. */
export function resetVeracityCatalogueCache(): void {
  cachedSegmentSources = null;
}

function taxonomyFamily(nodeId: string): string {
  return nodeId.split("/")[0]!;
}

/**
 * "Share of tape anchors whose episode shares a taxonomy family with the
 * Foray's resolved topic ... use the catalogue's shows[].taxonomy_node_ids
 * and item topics" (WS-B spec). Two signals, combined, because neither
 * alone covers the pool:
 *
 *   1. The SEGMENT's own `topic` field (`data/segments.json`, e.g.
 *      "economics/markets") — already taxonomy-shaped, present on every
 *      one of the 212 pooled segments, and the more specific of the two.
 *      Resolved by `TapePointer.segmentId`.
 *   2. The SEGMENT'S SOURCE SHOW's `taxonomy_node_ids`
 *      (`data/catalog.json` `shows[]`), resolved
 *      `TapePointer.itemId` -> `data/segment-sources.json` `sources[].show`
 *      (a title) -> `catalog.json` `shows[].title` -> `taxonomy_node_ids`.
 *
 * (`data/discover.json`'s own `items[].topics` — the OTHER catalogue this
 * repo calls "item topics" — turned out NOT to join against
 * `TapePointer.itemId`/`SegmentRecord.item_id` at all: checked against a
 * live checkout, 0 of 212 pooled segments' `item_id`s resolve against
 * `discover.json`'s item ids, while all 212 resolve against
 * `segment-sources.json`. That registry, and the segment's own `topic`
 * field, are this run's real "item topics" signal.)
 *
 * The show-title join is lossy on its own (again checked live: 44 of 64
 * `segment-sources.json` shows have a matching `catalog.json` title — the
 * rest, tellingly, are exactly the smaller/mis-anchored shows run 1's
 * findings named: *Origin Stories*, *The Grill Coach*, *Rewilding Earth
 * Podcast*), which is why the segment-topic signal is checked first and
 * both are unioned rather than either alone being load-bearing.
 *
 * `onTopic` is `null` for an anchor where NEITHER signal resolves — that
 * anchor is excluded from `rate`'s numerator and denominator, not counted
 * as on-topic. `rate` itself is `null` when the candidate has tape anchors
 * but NONE resolve (a real gap, not a "no tape used" no-op) — see
 * `evaluateVeracityGate`'s own comment on why that case still blocks
 * publish. When the candidate has NO tape anchors at all, `rate` is also
 * `null` but `anchors` is empty — the gate treats that differently (N/A,
 * not a failure).
 */
export function computeTapeRelevance(sourcedActs: SourcedAct[], topic: string, root: string = REPO_ROOT): TapeRelevanceResult {
  const topicFamily = taxonomyFamily(topic);
  const segmentPool = loadSegmentPool();
  const segmentsById = new Map<string, SegmentRecord>(segmentPool.map((s) => [s.id, s]));

  const sources = loadSegmentSources(root);
  const showByItemId = new Map<string, string>(sources.map((s) => [s.id, s.show]));

  const catalogue = loadCatalogueData();
  const showsByTitle = new Map<string, CatalogueShow>(catalogue.shows.map((s) => [s.title, s]));

  const anchors: TapeAnchorNote[] = [];

  for (const act of sourcedActs) {
    for (const slot of act.slots) {
      for (const beat of slot.beats) {
        if (beat.sourcing !== "tape") continue;

        const families = new Set<string>();

        const segment = segmentsById.get(beat.tape.segmentId);
        if (segment?.topic) families.add(taxonomyFamily(segment.topic));

        const showTitle = showByItemId.get(beat.tape.itemId);
        const show = showTitle ? showsByTitle.get(showTitle) : undefined;
        for (const nodeId of show?.taxonomy_node_ids ?? []) families.add(taxonomyFamily(nodeId));

        const familyList = [...families];
        const onTopic = familyList.length > 0 ? familyList.includes(topicFamily) : null;
        anchors.push({ itemId: beat.tape.itemId, claim: beat.claim, onTopic, families: familyList });
      }
    }
  }

  const measurable = anchors.filter((a) => a.onTopic !== null);
  const rate = measurable.length > 0 ? measurable.filter((a) => a.onTopic).length / measurable.length : null;
  return { rate, anchors };
}

/** Aggregates §4.5's own rows (WS-C) into the same result shape. `onTopic`
 * null rows are excluded from numerator and denominator, as above. */
export function tapeRelevanceFromRows(rows: TapeRelevanceInput[]): TapeRelevanceResult {
  const anchors: TapeAnchorNote[] = rows.map((r) => ({ itemId: r.itemId, claim: r.claim, onTopic: r.onTopic, families: r.families }));
  const measurable = anchors.filter((a) => a.onTopic !== null);
  const rate = measurable.length > 0 ? measurable.filter((a) => a.onTopic).length / measurable.length : null;
  return { rate, anchors };
}

/* ------------------------------------------------------------------ */
/* pagesDropped                                                         */
/* ------------------------------------------------------------------ */

/**
 * A connective (Hinge/Frame/Marker/Correction) page that `decideConnectiveNarration`
 * decided a tape beat needed, but that isn't present in the final
 * candidate — `writeNarration.ts`'s `writeOneBeat` drops it (tape kept,
 * silence bridges) after `NARRATION_PAGE_ATTEMPTS` rejected attempts. Since
 * a dropped page and a beat `decideConnectiveNarration` never wanted a page
 * for look IDENTICAL in the final `WrittenAct[]` (both lack
 * `connectiveNarration`), this recomputes the decision from `sourcedActs`
 * (the same pure, deterministic function the pipeline itself used) rather
 * than guessing from the written output alone.
 */
export function computePagesDropped(sourcedActs: SourcedAct[], writtenActs: WrittenAct[]): number {
  let dropped = 0;
  for (let a = 0; a < sourcedActs.length; a++) {
    const sourcedAct = sourcedActs[a]!;
    const writtenAct = writtenActs[a];
    if (!writtenAct) continue;
    for (let s = 0; s < sourcedAct.slots.length; s++) {
      const sourcedSlot: SourcedSlot = sourcedAct.slots[s]!;
      const writtenSlot = writtenAct.slots[s];
      if (!writtenSlot) continue;
      for (let i = 0; i < sourcedSlot.beats.length; i++) {
        const beat = sourcedSlot.beats[i]!;
        if (beat.sourcing !== "tape") continue;
        if (!decideConnectiveNarration(sourcedSlot, i)) continue;
        const writtenBeat = writtenSlot.beats[i];
        const kept = writtenBeat && writtenBeat.sourcing === "tape" && !!writtenBeat.connectiveNarration;
        if (!kept) dropped++;
      }
    }
  }
  return dropped;
}

/* ------------------------------------------------------------------ */
/* callsPerBeat                                                         */
/* ------------------------------------------------------------------ */

/** Every beat §4.7 attempted to write a page for: every narration-sourced
 * beat, plus every tape beat `decideConnectiveNarration` assigned a
 * connective mode to (whether or not the page survived) — a pure count
 * from `sourcedActs`, independent of how many of those pages were kept. */
export function countAttemptedPages(sourcedActs: SourcedAct[]): number {
  let n = 0;
  for (const act of sourcedActs) {
    for (const slot of act.slots) {
      slot.beats.forEach((beat, i) => {
        if (beat.sourcing === "narration") n++;
        else if (decideConnectiveNarration(slot, i)) n++;
      });
    }
  }
  return n;
}

export function computeCallsPerBeat(sourcedActs: SourcedAct[], writerCalls: number, verifierCalls: number): number | null {
  const beats = countAttemptedPages(sourcedActs);
  return beats > 0 ? (writerCalls + verifierCalls) / beats : null;
}

/* ------------------------------------------------------------------ */
/* unverifiedPages (F-51)                                               */
/* ------------------------------------------------------------------ */

export interface UnverifiedPagesResult {
  count: number;
  pages: FailingPage[];
}

/**
 * Pages the candidate carries that never passed verification — F-51's
 * whole point made visible. Before it, a narration page rejected three
 * times threw `NarrationWriteError` and took the Foray with it (run 2 died
 * at act 1 p2 with ten of twelve pages verified); now `writeNarration.ts`
 * keeps the last attempt with `verified: false` and the verifier's final
 * objection, and THIS is what stops it reaching listeners:
 * `evaluateVeracityGate` refuses to publish while the count is above zero.
 *
 * Read the count, not the rate. One unverified page is a stop, so there is
 * nothing for an average to say — and unlike `pagesDropped` (a connective
 * page nobody hears the absence of), each of these is a page a listener
 * WOULD hear, carrying an objection somebody has to answer.
 */
export function computeUnverifiedPages(writtenActs: WrittenAct[]): UnverifiedPagesResult {
  const pages: FailingPage[] = [];
  for (const { claim, page } of flattenWrittenPages(writtenActs)) {
    if (page.verified) continue;
    pages.push({
      claim,
      mode: page.mode,
      reason: "unverified-page",
      detail: page.verifierNotes
        ? `kept unverified after every attempt — ${page.verifierNotes.slice(0, 200)}`
        : `kept unverified after every attempt (${page.attempts?.length ?? 0} recorded)`
    });
  }
  return { count: pages.length, pages };
}

/* ------------------------------------------------------------------ */
/* purposeRevisedPages (F-50)                                           */
/* ------------------------------------------------------------------ */

/**
 * How many pages corrected their purpose from the evidence — the writer
 * said so, the verifier said so, or both (`purposeWasRevised` in
 * `types/narration.ts` is the one definition of the disjunction).
 *
 * NOT a failure count, and deliberately not gated on. A page that reports
 * a contradiction between its brief and its documents is the single most
 * valuable thing evidence-first narration can produce (F-50), and the
 * pipeline now permits it; this number exists so an editor can FIND those
 * pages, and so a deepen stage that keeps writing purposes the evidence
 * contradicts shows up as a rising count rather than as a dead run.
 */
export function computePurposeRevisedPages(writtenActs: WrittenAct[]): number {
  return flattenWrittenPages(writtenActs).filter(({ page }) => purposeWasRevised(page)).length;
}

/* ------------------------------------------------------------------ */
/* Assembly                                                             */
/* ------------------------------------------------------------------ */

export interface VeracityMetrics {
  groundedQuoteRate: number | null;
  groundedQuoteCounts: { checkable: number; grounded: number };
  ungroundedPages: FailingPage[];
  attributionStability: number | null;
  purposeFidelity: number | null;
  tapeRelevance: number | null;
  tapeRelevanceAnchors: TapeAnchorNote[];
  firstAttemptPassRate: number | null;
  callsPerBeat: number | null;
  pagesDropped: number;
  /** F-51: pages kept with `verified: false`. Any is a publish stop. */
  unverifiedPages: number;
  /** The same pages, named, so the gate can print which ones. */
  unverifiedPageDetails: FailingPage[];
  /** F-50: pages that corrected their purpose from the evidence. Reported,
   * never gated — see `computePurposeRevisedPages`. */
  purposeRevisedPages: number;
  pipelineTokens: number;
  /** Pipeline-stage wall times (`stageTiming.ts`'s `StageTiming[]`),
   * `finalizeForay`'s own internal breakdown appended with a `finalize.`
   * name prefix so both are visible in one flat, orderable list. */
  stageTimings: StageTiming[];
  /** G-35: what the evidence prefetch did and how much of narration's
   * retrieval it absorbed (`evidencePrefetch.ts`). Absent from a candidate
   * built by a caller that ran no prefetch. */
  retrieval?: EvidencePrefetchMetrics;
}

export interface BuildVeracityMetricsInput {
  sourcedActs: SourcedAct[];
  /** WS-C's per-beat rows from §4.5 (`SourceBeatsResult.tapeRelevance`). When
   * present they are the metric's input: sourcing judged each anchor against
   * the Foray's taxonomy LINEAGE with the segment/show node union in hand, and
   * the gate must score what the gate saw. Absent (older callers, tests), the
   * metric re-derives a coarser root-segment verdict from disk. */
  tapeRelevanceRows?: TapeRelevanceInput[];
  writtenActs: WrittenAct[];
  topic: string;
  writerCalls: number;
  verifierCalls: number;
  pipelineTokens: number;
  stageTimings: StageTiming[];
  /** G-35: carried through verbatim when the caller ran a prefetch. */
  retrieval?: EvidencePrefetchMetrics;
  root?: string;
}

export function buildVeracityMetrics(input: BuildVeracityMetricsInput): VeracityMetrics {
  const grounded = computeGroundedQuoteRate(input.writtenActs);
  const unverified = computeUnverifiedPages(input.writtenActs);
  const tape = input.tapeRelevanceRows
    ? tapeRelevanceFromRows(input.tapeRelevanceRows)
    : computeTapeRelevance(input.sourcedActs, input.topic, input.root);

  return {
    groundedQuoteRate: grounded.rate,
    groundedQuoteCounts: { checkable: grounded.checkableQuotes, grounded: grounded.groundedQuotes },
    ungroundedPages: grounded.ungroundedPages,
    attributionStability: computeAttributionStability(input.writtenActs),
    purposeFidelity: computePurposeFidelity(input.writtenActs),
    tapeRelevance: tape.rate,
    tapeRelevanceAnchors: tape.anchors,
    firstAttemptPassRate: computeFirstAttemptPassRate(input.writtenActs),
    callsPerBeat: computeCallsPerBeat(input.sourcedActs, input.writerCalls, input.verifierCalls),
    pagesDropped: computePagesDropped(input.sourcedActs, input.writtenActs),
    unverifiedPages: unverified.count,
    unverifiedPageDetails: unverified.pages,
    purposeRevisedPages: computePurposeRevisedPages(input.writtenActs),
    pipelineTokens: input.pipelineTokens,
    stageTimings: input.stageTimings,
    ...(input.retrieval ? { retrieval: input.retrieval } : {})
  };
}

/* ------------------------------------------------------------------ */
/* Publish gate (WS-B: publishForay.ts)                                 */
/* ------------------------------------------------------------------ */

export const GATE_MIN_GROUNDED_QUOTE_RATE = 1;
export const GATE_MIN_PURPOSE_FIDELITY = 0.8;
export const GATE_MIN_TAPE_RELEVANCE = 0.9;

export interface VeracityGateResult {
  ok: boolean;
  /** Human-readable lines, ready to print one per line — the top-level
   * failure plus, where useful, the specific failing pages/anchors under
   * it (indented two spaces). */
  failures: string[];
}

/**
 * "Refuse to open the PR when `groundedQuoteRate < 1`, `purposeFidelity <
 * 0.8`, or `tapeRelevance < 0.9`, printing which pages failed" (WS-B
 * spec). `null` is treated as a FAILING value for `groundedQuoteRate` and
 * `purposeFidelity` — "unmeasured" is not "passing", and both are
 * structurally `null` in this checkout until WS-A lands, which is the
 * correct outcome: today's pipeline is exactly the one run 1's postmortem
 * shows shipping fabricated citations (F-27, F-32, F-46), so a REAL
 * publish attempt should require an explicit `--force` until the metrics
 * that would catch that can actually be computed.
 *
 * F-51 added a fourth, absolute condition: any page kept with
 * `verified: false`. It is not a floor — one such page refuses the whole
 * candidate — because the pipeline now finishes a Foray that contains one
 * rather than throwing the Foray away, and this is the only thing standing
 * between that page and a listener.
 *
 * `tapeRelevance` gets one exception: a candidate with NO tape anchors at
 * all (`tapeRelevanceAnchors.length === 0`) has nothing for this metric to
 * judge — that is not the F-23/F-24/F-29 mis-anchoring failure mode, so it
 * does not block. A candidate WITH tape anchors where NONE resolved
 * against the catalogue (`tapeRelevance === null` but anchors exist) DOES
 * block — that is a real "cannot confirm" gap, not an absence of tape.
 */
export function evaluateVeracityGate(veracity: VeracityMetrics | null | undefined): VeracityGateResult {
  const failures: string[] = [];

  if (!veracity) {
    return {
      ok: false,
      failures: ["no meta.veracity on this candidate — groundedQuoteRate/purposeFidelity/tapeRelevance were never computed"]
    };
  }

  if (veracity.groundedQuoteRate === null) {
    failures.push(
      `groundedQuoteRate is null — no page in this candidate carries evidence to check its quotes against (WS-A not yet in this build), so no quote could be confirmed grounded`
    );
  } else if (veracity.groundedQuoteRate < GATE_MIN_GROUNDED_QUOTE_RATE) {
    failures.push(`groundedQuoteRate ${veracity.groundedQuoteRate.toFixed(3)} < ${GATE_MIN_GROUNDED_QUOTE_RATE}`);
    for (const p of veracity.ungroundedPages) failures.push(`  [${p.mode}] ${p.claim.slice(0, 80)} — ${p.detail}`);
  }

  if (veracity.purposeFidelity === null) {
    failures.push(
      `purposeFidelity is null — the verifier does not yet answer "does this page accomplish its purpose" as its own question (F-41; WS-A), so it cannot be confirmed`
    );
  } else if (veracity.purposeFidelity < GATE_MIN_PURPOSE_FIDELITY) {
    failures.push(`purposeFidelity ${veracity.purposeFidelity.toFixed(3)} < ${GATE_MIN_PURPOSE_FIDELITY}`);
  }

  /* F-51. `writeNarration.ts` no longer throws when a narration page is
     rejected for the third time — it keeps the page unverified and lets
     the run finish, on the explicit understanding that THIS refuses it.
     Listed before the tape check because it is the most concrete failure
     in the set: not a rate below a floor, but a specific page with a
     specific unanswered objection. */
  if (veracity.unverifiedPages > 0) {
    failures.push(
      `${veracity.unverifiedPages} page(s) were kept without passing verification — a page that never satisfied the verifier is not publishable (F-51)`
    );
    for (const p of veracity.unverifiedPageDetails) failures.push(`  [${p.mode}] ${p.claim.slice(0, 80)} — ${p.detail}`);
  }

  if (veracity.tapeRelevanceAnchors.length === 0) {
    // No tape in this Foray at all — nothing for tapeRelevance to judge.
  } else if (veracity.tapeRelevance === null) {
    failures.push(
      `tapeRelevance is null despite ${veracity.tapeRelevanceAnchors.length} tape anchor(s) present — none resolved against the catalogue, so on-topic could not be confirmed`
    );
  } else if (veracity.tapeRelevance < GATE_MIN_TAPE_RELEVANCE) {
    failures.push(`tapeRelevance ${veracity.tapeRelevance.toFixed(3)} < ${GATE_MIN_TAPE_RELEVANCE}`);
    for (const a of veracity.tapeRelevanceAnchors.filter((a) => a.onTopic === false)) {
      failures.push(`  off-topic: ${a.itemId} (families: ${a.families.join(", ") || "none"}) — ${a.claim.slice(0, 80)}`);
    }
  }

  return { ok: failures.length === 0, failures };
}
