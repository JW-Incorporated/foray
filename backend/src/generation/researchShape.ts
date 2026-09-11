import type { IntentUnderstanding } from "../types/generation";
import type { ResearchShape, ResearchTapeWindow, SubtopicCandidate, TapeAvailability, TapeSignal } from "../types/research";
import {
  conceptLabel,
  loadCatalogueData,
  matchConceptsInText,
  queryTapeAvailability,
  tokenizeForCatalogueQuery,
  type CatalogueData
} from "./catalogueLookup";
import { resolveTopic } from "./resolveTopic";
import { familyGateAllows, taxonomyNodesForItemId, taxonomyNodesForShowId, unionNodes } from "./taxonomyFamily";
import {
  cueWindowText,
  deriveItemId,
  NullTranscriptCueProvider,
  selectTapeWindow,
  type TranscriptCueProvider,
  type TranscriptDigestEntry
} from "./transcriptArchiveLookup";
import { NullTranscriptTextIndex, type TranscriptTextIndex } from "./transcriptTextIndex";
import type { ExternalResearcher, ExternalResearchContext } from "./ExternalResearcher";

/**
 * §4.2 — research to establish shape (docs/curation/generation-architecture.md
 * §4.2), taking §4.1's `IntentUnderstanding` as input.
 *
 * "Enough research to know what the acts are, not enough to write them."
 * Produces a `ResearchShape`: candidate sub-topics/angles, a tape-
 * availability signal for each, known controversies, and anything external
 * research surfaced. Feeds §4.3 (spine building) as its input.
 *
 * TWO SOURCES, DELIBERATE ORDER (§4.2 verbatim):
 *   1. The local catalogue (`catalogueLookup.ts`) — free, instant, checked
 *      for every candidate subtopic first.
 *   2. External research (`ExternalResearcher`) — invoked ONLY for a
 *      subtopic the catalogue has NO tape for (`signal === "none"`). This
 *      is the "cheap first" ordering the task's own tests hold to: a
 *      subtopic the catalogue already answers must never trigger a paid
 *      call.
 *
 * GUARDRAIL, ENFORCED STRUCTURALLY (§4.2): tape availability is a SIGNAL
 * attached to every candidate, never a filter. A subtopic the catalogue
 * has zero tape for still gets a full entry in `subtopics` — it is
 * eligible for external research and for §4.3's spine exactly like a
 * tape-rich one. Nothing in this module removes a candidate for having a
 * "none" signal.
 *
 * SCOPE (per §5's topology table: "1, may fan out for lookups"): this
 * function is the one synthesis head; `fanOutExternalResearch` below is
 * the only parallelism, and it is bounded, independent per-subtopic
 * lookups — not a multi-agent orchestration.
 *
 * A THIRD SOURCE, ADDED BY WS-L (finding F-63): THE TAPE ITSELF. The two
 * sources above answer "what could this Foray be about" and "how much
 * material is there"; neither answers "what does the material SAY", and
 * generation run 2 is what that omission costs — a spine written from
 * "Ai: 761 items, tape: strong" and nothing else, 35 beats, 0 of them
 * sourceable from the 63 *Practical AI* transcripts the machine holds,
 * three attempts running. So for every candidate the catalogue reports
 * real tape for, this stage now runs the WS-H text index over the
 * subtopic's own terms and attaches the best few transcript WINDOWS —
 * episode, times, and the sentences spoken in them — for §4.3 to write
 * `account` beats from (`tapeWindowsFor` below). Keyless, deterministic,
 * and inert without an index: a checkout with no transcript bodies gets
 * an empty list and a reason, never a guess.
 */

/**
 * WS-L (F-63): the tape-reading half of this stage, in five numbers.
 *
 * The research map's job stops being "how much is there" and becomes "what does
 * it say". For every candidate subtopic the catalogue reports real tape for,
 * the WS-H text index is asked which episodes SAY the subtopic's terms, the best
 * stretch of each is chosen with F-61's own window search, and the window's
 * sentences are attached verbatim for §4.3 to write beats from.
 */

/** Windows attached per subtopic, at most one per episode so the spine sees
 * six different conversations rather than six minutes of one.
 *
 * RAISED FROM 4 BY G-25 (tape-yield brief §5 R4). The seed is the only path
 * that yields: on the run-2 checkpoint the unseeded search admitted 0 of 14
 * beats at every floor value, and the seeded path admitted 10 of 14 — so the
 * number of tape beats a Foray can carry is bounded above by the number of
 * windows the spine had to seed from. Four per subtopic gave the run-2 map 32
 * windows over 23 episodes for a 32-beat spine, and §4.3 is now asked to seed
 * EVERY account beat a window can carry (`AnthropicSpineBuilder.ts`), one
 * episode at a time until M4 admits a repeat (`spineSeeding.ts`). Six keeps
 * the supply ahead of the ask. The cost is prompt size — two more 600-char
 * quotes per subtopic, ~10 k characters on an eight-subtopic map — which the
 * card accepts and the PR records.
 *
 * AND AT MOST ONE PER EPISODE ACROSS THE WHOLE MAP (G-24 R3). The one-per-
 * episode rule used to be per subtopic, so an episode that ranked well for two
 * related subtopics was quoted twice under two labels: attempt 6's map listed
 * 32 windows over 23 episodes with 8 episodes duplicated, the spine seeded two
 * of those episodes twice, and §4.5's M4 ledger — one segment per episode until
 * the Foray holds eight (`m4SegmentCapFor`) — refused the second seed of each
 * before its body was opened, one of them at a weighted share of 0.746. The
 * ledger is right and does not move ("never looser"); what was wrong was
 * offering the spine a seed the Foray could not take. So the map now lists each
 * episode once, under the subtopic that ranked it first, and the next subtopic
 * takes its next-best episode instead — which is more different conversations
 * for the spine, not fewer windows: each subtopic still asks the index for
 * `RESEARCH_TAPE_EPISODE_CANDIDATES` episodes and keeps the best six it may.
 *
 * WHY HERE AND NOT IN THE LEDGER. The brief's alternative was to let §4.5 admit
 * a seeded window as an episode's second segment once four are placed. That
 * makes an episode 2 of 5 (40 %) at the moment of placement and bets the rest
 * of the Foray will dilute it; `check-forays.mjs` is the authority on M4 and
 * would refuse the Foray that stops there. Removing the duplicate at the source
 * costs no rule anything and needs no bet.
 *
 * G-25 AND G-24 TOGETHER: six windows per subtopic, each episode quoted once
 * across the map, and a spine-time M4 ledger (`spineSeeding.ts`) that admits
 * an episode's second seed only once the spine carries eight. The dedupe is
 * the stricter of the two where they overlap — it removes the second listing
 * outright rather than admitting it after eight — and it is what makes the
 * ledger's repeat mean "the same window again" rather than a second stretch
 * of the same hour. */
export const RESEARCH_TAPE_WINDOWS_PER_SUBTOPIC = 6;
/** Episodes the text index is asked for per subtopic. Twice the window count,
 * as it was at 4/8, because an episode with no body on this machine yields
 * nothing and because one window per episode is the rule above. */
export const RESEARCH_TAPE_EPISODE_CANDIDATES = 12;
/**
 * A research window is something a person READS in a prompt, not a segment a
 * listener hears, so it sits inside §4.5's own 30-180 s band: long enough to
 * carry an idea, short enough that eight subtopics of them stay a prompt.
 *
 * F-73 RAISED THE FLOOR FROM 60 s AND THE CEILING FROM 120 s, because a window
 * quoted here is NOT only read — §4.3 seeds a beat with its episode AND its
 * seconds, and F-68 then confines tier 2's window search to exactly that
 * stretch. So this band is, in practice, the band every generated tape segment
 * is cut from, and 60-120 s put every one of them under
 * `narration-craft.md` §0's D3 mean floor (90 s) by construction: run 2 attempt
 * 5's act-1 candidate came out at a 76.1 s mean with a 15.6 s interquartile
 * range, and D3 and D5 both refused it. A window can no longer be shorter than
 * the mean the rules require, and the ceiling is §4.5's own
 * `TAPE_WINDOW_MAX_SEC` rather than a tighter number of this stage's own — the
 * two now name the same span because they are describing the same tape.
 *
 * WHAT DID NOT CHANGE. The floor is still a preference, not a requirement:
 * `selectTapeWindow` falls back to the widest run it could reach when a
 * transcript (or the stretch of it before a gap) is shorter than the minimum, so
 * a short body still yields its window and no subtopic loses its evidence for
 * this. And `RESEARCH_TAPE_WINDOW_MAX_CHARS` below is deliberately left where it
 * is: the quote was already being trimmed well inside a 120 s window, the prompt
 * budget is what that number is about, and widening it is a prompt-size decision
 * with nothing to do with the D-tier rules.
 */
export const RESEARCH_TAPE_WINDOW_MIN_SEC = 90;
export const RESEARCH_TAPE_WINDOW_MAX_SEC = 180;
/** And the same window as characters. Cut at a sentence end below this, never
 * mid-word — a truncated quote is still the tape's own words. */
export const RESEARCH_TAPE_WINDOW_MAX_CHARS = 600;

const MAX_SUBTOPICS = 8;
/** How many of the top-matched concept's `related` concepts to pull in for
 * breadth, beyond the literal terms already in subject/angle — this is what
 * keeps the map from being just a restatement of the prompt. */
const MAX_RELATED_CONCEPTS = 3;

export function tapeSignalFor(itemCount: number): TapeSignal {
  if (itemCount === 0) return "none";
  if (itemCount < 5) return "thin";
  if (itemCount < 20) return "moderate";
  return "strong";
}

function buildTapeAvailability(terms: string[], catalogue: CatalogueData): TapeAvailability {
  const result = queryTapeAvailability(terms, catalogue);
  return {
    signal: tapeSignalFor(result.itemCount),
    itemCount: result.itemCount,
    showCount: result.showCount,
    exampleItemIds: result.exampleItemIds
  };
}

interface CandidateSeed {
  label: string;
  source: "semantic-concept" | "literal-term";
  terms: string[];
}

/**
 * Builds the candidate list from the intent's subject+angle text: every
 * matched semantic-index concept (subject/angle terms overlapping a
 * concept's `terms`), plus up to `MAX_RELATED_CONCEPTS` concepts related to
 * the top match for breadth beyond the literal ask. Falls back to the raw
 * subject phrase as a single literal-term candidate when nothing in the
 * catalogue's concept vocabulary matches at all — this is the case §4.2's
 * guardrail cares most about: a genuinely untaped subject must still
 * produce a real candidate, not an empty map.
 */
function buildCandidateSeeds(intent: IntentUnderstanding, catalogue: CatalogueData, topic: string | null): CandidateSeed[] {
  const queryText = `${intent.subject} ${intent.angle}`;
  const matched = matchConceptsInText(queryText, catalogue.concepts, { topic });

  if (matched.length === 0) {
    return [{ label: intent.subject, source: "literal-term", terms: tokenizeSubject(intent.subject) }];
  }

  const seeds: CandidateSeed[] = [];
  const seen = new Set<string>();

  for (const key of matched.slice(0, MAX_SUBTOPICS)) {
    seeds.push({ label: conceptLabel(key), source: "semantic-concept", terms: catalogue.concepts[key]!.terms });
    seen.add(key);
  }

  // Breadth: related concepts of the top (best-matched) concept, so the map
  // surfaces adjacent angles the prompt didn't literally name — exactly the
  // "non-obvious angle" §4.2 asks the research stage to help locate.
  const topKey = matched[0]!;
  const related = catalogue.concepts[topKey]?.related ?? [];
  let relatedAdded = 0;
  for (const relKey of related) {
    if (relatedAdded >= MAX_RELATED_CONCEPTS || seeds.length >= MAX_SUBTOPICS) break;
    if (seen.has(relKey) || !catalogue.concepts[relKey]) continue;
    seeds.push({ label: conceptLabel(relKey), source: "semantic-concept", terms: catalogue.concepts[relKey]!.terms });
    seen.add(relKey);
    relatedAdded += 1;
  }

  return seeds;
}

function tokenizeSubject(subject: string): string[] {
  return tokenizeForCatalogueQuery(subject);
}

/** Everything the window search needs from outside this module. All four are
 * injectable and all four have an honest do-nothing default, exactly like
 * §4.5's `cueProvider`/`textIndex` pair. */
interface TapeWindowDeps {
  textIndex: TranscriptTextIndex;
  cueProvider: TranscriptCueProvider;
  /** The Foray's resolved node — the lineage gate's left-hand side, the SAME
   * topic the F-11 concept filter above is keyed on. Null makes the gate inert. */
  topic: string | null;
  root: string | undefined;
}

interface TapeWindowResult {
  windows: ResearchTapeWindow[];
  unavailable: string | null;
}

/**
 * WHAT THE TAPE SAYS ABOUT ONE SUBTOPIC (WS-L; F-63).
 *
 * Deterministic and keyless end to end: a BM25 ranking over the archive's own
 * cue text (WS-H's index), F-61's window search inside each ranked episode, and
 * the cues themselves. No model call, no network, and nothing written to disk
 * beyond the index cache the index already keeps.
 *
 * THE LINEAGE GATE RUNS HERE TOO, AND BEFORE ANY EPISODE IS OPENED — the same
 * `familyGateAllows` §4.5 uses, on the same resolved topic. A window quoted into
 * the spine prompt is a suggestion about what to write about, so an off-branch
 * show reaching it would be F-11 all over again, one stage later and with
 * sentences instead of a count.
 *
 * NO RELEVANCE FLOOR IS APPLIED, DELIBERATELY. `tapeWindowIsRelevant` asks
 * whether a window is about a CLAIM; there is no claim yet — that is what §4.3
 * is about to write from these very windows. What is required is only that the
 * window says something of the subtopic at all (one matched term), and the
 * ranking then puts the best first. The floor still decides in §4.5, unchanged,
 * against the claim as finally worded.
 *
 * `usedEpisodes` is the map-wide ledger of episodes an earlier subtopic already
 * quoted (G-24 R3, see `RESEARCH_TAPE_WINDOWS_PER_SUBTOPIC`): those are skipped
 * here and the ones this subtopic keeps are added to it.
 */
function tapeWindowsFor(seed: CandidateSeed, tape: TapeAvailability, deps: TapeWindowDeps, usedEpisodes: Set<string>): TapeWindowResult {
  if (!deps.textIndex.enabled) {
    return { windows: [], unavailable: "no transcript text index on this machine, so nothing could be quoted" };
  }
  if (tape.signal !== "strong" && tape.signal !== "moderate") {
    return { windows: [], unavailable: `catalogue tape for this subtopic is "${tape.signal}" — too thin to be worth quoting` };
  }

  /* The subtopic's own vocabulary: its label plus the semantic index's phrases
     for it, which is what makes the query broader than the prompt's wording
     ("feature store" finds the episodes that discuss one without using the
     label). Hyphenated concept terms split on the tokenizer's own rule. */
  const queryText = [seed.label, ...seed.terms].join(" ");
  const isUsable = (entry: TranscriptDigestEntry): boolean =>
    familyGateAllows(deps.topic, archiveEntryNodes(entry, deps.root), deps.root);

  const candidates = deps.textIndex.search(queryText, { limit: RESEARCH_TAPE_EPISODE_CANDIDATES, isUsable });
  if (candidates.length === 0) {
    return { windows: [], unavailable: "no episode in this Foray's taxonomy lineage says enough of this subtopic to open" };
  }

  const windows: ResearchTapeWindow[] = [];
  for (const candidate of candidates) {
    /* Already quoted under an earlier subtopic — the spine may seed one beat
       from it and no more, so a second listing is a seed §4.5 would refuse. */
    if (usedEpisodes.has(deriveItemId(candidate.entry))) continue;
    const cues = deps.cueProvider.getCues(candidate.entry);
    if (!cues) continue;
    const window = selectTapeWindow(queryText, cues, {
      idf: candidate.idf,
      minSec: RESEARCH_TAPE_WINDOW_MIN_SEC,
      maxSec: RESEARCH_TAPE_WINDOW_MAX_SEC
    });
    /* A window that shares not one word with the subtopic is not evidence about
       it; the episode ranked for words spoken somewhere else in the hour. */
    if (!window || window.matchedTerms.length === 0) continue;
    const text = trimToSentence(cueWindowText(cues, window.startSec, window.endSec));
    if (text.length === 0) continue;
    windows.push({
      episodeId: deriveItemId(candidate.entry),
      showTitle: candidate.entry.show_title,
      episodeTitle: candidate.entry.title,
      startSec: Number(window.startSec.toFixed(1)),
      endSec: Number(window.endSec.toFixed(1)),
      text,
      score: Number(window.score.toFixed(3))
    });
  }

  if (windows.length === 0) {
    return {
      windows: [],
      unavailable: candidates.every((c) => usedEpisodes.has(deriveItemId(c.entry)))
        ? "every episode the archive ranked for this subtopic is already quoted under an earlier subtopic"
        : "the archive ranked episodes for this subtopic but no transcript body for them is on this machine"
    };
  }

  /* Best window first; ties by episode id so a replay of the same archive
     produces the same prompt, byte for byte. */
  windows.sort((a, b) => b.score - a.score || (a.episodeId < b.episodeId ? -1 : a.episodeId > b.episodeId ? 1 : 0));
  const kept = windows.slice(0, RESEARCH_TAPE_WINDOWS_PER_SUBTOPIC);
  for (const w of kept) usedEpisodes.add(w.episodeId);
  return { windows: kept, unavailable: null };
}

/** The taxonomy nodes an archive episode resolves to — its show's nodes plus
 * the item-id join, the same union §4.5's tier-2 gate judges (`sourceBeats.ts`'s
 * `nodesForArchiveEntry`). */
function archiveEntryNodes(entry: TranscriptDigestEntry, root: string | undefined): string[] {
  return unionNodes(taxonomyNodesForShowId(entry.show_id, root), taxonomyNodesForItemId(deriveItemId(entry), root));
}

/**
 * The window's text, whitespace-collapsed and cut to
 * `RESEARCH_TAPE_WINDOW_MAX_CHARS` at a sentence end where there is one and at a
 * word boundary otherwise. Never mid-word: what is quoted into the spine prompt
 * has to be readable as speech somebody actually produced.
 */
function trimToSentence(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= RESEARCH_TAPE_WINDOW_MAX_CHARS) return collapsed;
  const head = collapsed.slice(0, RESEARCH_TAPE_WINDOW_MAX_CHARS);
  const lastSentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
  if (lastSentence > RESEARCH_TAPE_WINDOW_MAX_CHARS / 2) return head.slice(0, lastSentence + 1);
  const lastSpace = head.lastIndexOf(" ");
  return (lastSpace > 0 ? head.slice(0, lastSpace) : head).trim();
}

/**
 * External-research fan-out (§5: "may fan out for lookups"). Runs the
 * bounded set of catalogue-gap subtopics in parallel — never more than
 * `MAX_SUBTOPICS` calls, each an independent per-subtopic lookup with no
 * shared context between them, which is exactly the shape §5 permits at
 * this stage (as opposed to §4.4's per-act agents, which share the full
 * spine).
 */
async function fanOutExternalResearch(
  gaps: Array<{ seed: CandidateSeed; tape: TapeAvailability }>,
  researcher: ExternalResearcher,
  ctx: ExternalResearchContext
): Promise<Map<string, { notes: string; controversies: string[] }>> {
  const results = await Promise.all(
    gaps.map(async ({ seed }) => {
      const r = await researcher.research(seed.label, ctx);
      return [seed.label, r] as const;
    })
  );
  return new Map(results.map(([label, r]) => [label, { notes: r.notes, controversies: r.controversies }]));
}

export interface BuildResearchShapeOptions {
  researcher: ExternalResearcher;
  ctx: ExternalResearchContext;
  /** The listener's own prompt, verbatim. Joins the intent's subject and angle
   * in the topic text the lineage filter resolves from (F-67) — see
   * `resolveFilterTopic`. Optional so every pre-F-67 caller and test is
   * unchanged. */
  prompt?: string;
  /** Injectable for tests; defaults to the real on-disk catalogue. */
  catalogue?: CatalogueData;
  /**
   * The Foray's taxonomy node, used to keep off-branch concepts out of the map
   * (F-11). Pass it when a human has already pinned the topic; leave it out
   * and this stage resolves one from the intent itself.
   *
   * Pass `null` EXPLICITLY to disable the filter — distinct from omitting it,
   * which means "resolve one". A test asserting the old unfiltered behaviour
   * and a caller who knows the taxonomy cannot place this subject are the two
   * cases that want it.
   */
  topic?: string | null;
  /** Repo root for the taxonomy read, when resolving the topic here. */
  root?: string;
  /**
   * WS-L: the WS-H text index this stage asks what the archive SAYS about each
   * candidate subtopic (F-63).
   *
   * Defaults to `NullTranscriptTextIndex`, which is disabled and returns
   * nothing — so CI, a fresh checkout and every test written before WS-L get a
   * research map with no windows and a `windowsUnavailable` reason saying why,
   * which is exactly the map this stage produced before. Same seam, same
   * default and same rationale as `SourceBeatsOptions.textIndex`.
   */
  textIndex?: TranscriptTextIndex;
  /** Where the quoted sentences come from. Defaults to
   * `NullTranscriptCueProvider` — no bodies, no windows. */
  cueProvider?: TranscriptCueProvider;
}

/**
 * The topic the F-11 filter is keyed on.
 *
 * RESOLVED HERE, FROM THE INTENT, rather than taken from later in the
 * pipeline: `runPipeline` resolves the topic after narration (it needs the
 * finished spine's act titles to do it well), and §4.2 runs six stages
 * earlier. The subject and angle are enough for the coarse question this
 * filter asks — which branch of the taxonomy is this Foray in — and run 1's
 * own intent text resolves to `engineering/disasters` from the subject alone.
 *
 * A MISS DISABLES THE FILTER RATHER THAN FAILING. `resolveTopic` deliberately
 * returns null instead of guessing, and a subject it cannot place is exactly
 * the case §4.2's guardrail protects: "a genuinely untaped subject must still
 * produce a real candidate, not an empty map". Filtering on a topic nobody
 * resolved would empty the map for precisely those subjects.
 */
function resolveFilterTopic(intent: IntentUnderstanding, root: string | undefined, prompt: string | undefined): string | null {
  try {
    /* F-67: the user's own words lead. `subject`/`angle` are the understander's
       paraphrase, and a paraphrase can drop the one token the taxonomy knows —
       run 2 attempt 4's 8-word subject said "ML" where the prompt said
       "machine learning", the resolver placed it under
       architecture/infrastructure, and the lineage gate then refused every AI
       episode the text index found. The prompt is what the listener typed;
       it is the most reliable statement of what the Foray is about. */
    return resolveTopic(`${prompt ?? ""} ${intent.subject} ${intent.angle}`, { root }).resolved;
  } catch {
    /* No taxonomy on disk (a checkout without `data/`, a fixture directory) —
       the research map is not the place to fail for that. */
    return null;
  }
}

/**
 * §4.2 end to end: reads §4.1's intent, queries the local catalogue for
 * every candidate subtopic FIRST, then fans out to external research only
 * for the subtopics the catalogue could not answer (`signal === "none"`),
 * and returns the structured `ResearchShape` that §4.3 (spine building)
 * consumes as its input.
 */
export async function buildResearchShape(
  intent: IntentUnderstanding,
  options: BuildResearchShapeOptions
): Promise<ResearchShape> {
  const catalogue = options.catalogue ?? loadCatalogueData();
  const topic = options.topic !== undefined ? options.topic : resolveFilterTopic(intent, options.root, options.prompt);
  const seeds = buildCandidateSeeds(intent, catalogue, topic);

  const withTape = seeds.map((seed) => ({ seed, tape: buildTapeAvailability(seed.terms, catalogue) }));
  const gaps = withTape.filter((s) => s.tape.signal === "none");

  const externalResults =
    gaps.length > 0 ? await fanOutExternalResearch(gaps, options.researcher, options.ctx) : new Map<string, { notes: string; controversies: string[] }>();

  /* WS-L: what the tape SAYS about each candidate, not just how much of it
     there is (F-63). Built after the external fan-out and before the map is
     assembled, so a subtopic carries both halves of its evidence at once. */
  const windowDeps: TapeWindowDeps = {
    textIndex: options.textIndex ?? new NullTranscriptTextIndex(),
    cueProvider: options.cueProvider ?? new NullTranscriptCueProvider(),
    topic,
    root: options.root
  };

  /* One window per episode across the whole map (G-24 R3): subtopics are
     walked in order, so the first subtopic an episode ranks for is the one that
     quotes it. Deterministic — the order is the candidate order, which is the
     concept order, which is stable for a given catalogue. */
  const usedEpisodes = new Set<string>();
  const subtopics: SubtopicCandidate[] = withTape.map(({ seed, tape }) => {
    const external = externalResults.get(seed.label);
    const windows = tapeWindowsFor(seed, tape, windowDeps, usedEpisodes);
    return {
      label: seed.label,
      source: seed.source,
      tape,
      controversies: external?.controversies ?? [],
      externalNotes: external?.notes ?? null,
      externallyResearched: external !== undefined,
      tapeWindows: windows.windows,
      windowsUnavailable: windows.unavailable
    };
  });

  return {
    subject: intent.subject,
    angle: intent.angle,
    generatedAt: new Date().toISOString(),
    subtopics,
    nonObviousAngle: intent.angle,
    externalGapsResearched: gaps.map((g) => g.seed.label)
  };
}
