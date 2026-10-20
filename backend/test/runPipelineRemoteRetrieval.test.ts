import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runForayPipeline, type RunPipelineDeps, type RunPipelineOutcome } from "../src/generation/runPipeline";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import type { DeepenActBuilder, DeepenActContext } from "../src/generation/DeepenActBuilder";
import type { FinalizeForayInput, FinalizeForayResult } from "../src/generation/finalizeForay";
import { createEvidenceGatherer, type EvidenceBeat, type EvidenceDoc, type EvidenceGatherer } from "../src/generation/gatherEvidence";
import type { ExternalResearchContext } from "../src/generation/ExternalResearcher";
import { loadCatalogueData } from "../src/generation/catalogueLookup";
import { mintSegmentSource } from "../src/generation/audioSourceLookup";
import { checkpointFingerprint, checkpointRunVariant } from "../src/generation/checkpoint";
import { resolvePipelineFlags } from "../src/generation/pipelineFlags";
import { resolveRouting } from "../src/config/stageRouting";
import { RetrievalService } from "../src/cli/retrievalServer";
import type { CueStore } from "../src/generation/manifestBodySource";
import {
  HydratingCueProvider,
  PrecomputedTextIndex,
  RemoteRetrieval,
  type RetrievalFetch,
  type RetrievalFetchInit,
  type RetrievalMode
} from "../src/generation/retrievalClient";
import { deriveItemId, type TranscriptCue, type TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";
import { FileTranscriptTextIndex, type TranscriptTextIndex, type TranscriptTextSearchOptions } from "../src/generation/transcriptTextIndex";
import type { SegmentRecord } from "../src/generation/segmentPoolLookup";
import { SUBJECT_PROBE_LIMIT } from "../src/generation/researchShape";
import { sourcingBodies } from "../src/generation/sourceBeats";
import { openRemoteRetrieval } from "../src/cli/generateForays";
import { FlagValueError, retrievalConfig, tokenWouldTravelInClear } from "../src/generation/generationFlags";
import { corpusCoverage } from "../src/generation/transcriptCorpus";
import type { Act, Beat, DeepenedAct, Spine } from "../src/types/spine";
import type { GenerationRequest } from "../src/types/generation";
import { FakeCheckpointStore } from "./helpers/fakeCheckpointStore";

/**
 * GV-95 (docs/roadmap/generation-v2.md, from W3-11; R1-09, GP-09): the
 * pipeline run against a retrieval server. The run is the REAL
 * `runForayPipeline` with stub builders, an injected finalize (as in
 * runPipeline.test.ts) and a test-local deepen builder that writes beats the
 * synthetic corpus below speaks (one seeded, one under a pool segment, one
 * spoken nowhere), over a multi-act ("medium") spine.
 *
 * THE SERVER is the real `RemoteRetrieval` with an INJECTED fetch that routes
 * each request into an in-process `RetrievalService` (the GV-16 server's own
 * logic, no HTTP) over the same synthetic corpus held in memory. Nothing
 * reaches a network and no model is called; the only files written are the
 * server's index caches under a tmp dir.
 *
 * PARITY is the acceptance: the same run with the File pair (a local
 * `FileTranscriptTextIndex` over the same corpus) and with the server must
 * produce the same research map, sourcing (newSegments, sourcingTrace,
 * tapeRelevance) and evidence tape documents, with no search missed and no
 * body read unhydrated.
 *
 * The synthetic episodes sit under REAL catalogue show ids so the lineage gate
 * runs over committed data/catalog.json: the two history shows are in the
 * lineage of history/military-ancient, the engineering one is not.
 */

const TOPIC = "history/military-ancient";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gv95-remote-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const request: GenerationRequest = {
  prompt: "how the armies of the ancient world marched and fought",
  duration: "medium",
  author_id: "founder-1",
  visibility: "catalogue"
};
const options = { userId: "founder-1", now: () => new Date("2026-10-19T12:00:00.000Z"), topic: TOPIC };

/* ---------------------------------------------------------------------------
   The beats and the corpus
   --------------------------------------------------------------------------- */

/** Four distinctive words per (act, slot): the claim a beat makes, and what the
 * corpus speaks. Enough for four acts of six slots. */
const VOCAB = [
  "hannibal", "elephants", "carthage", "alpine", "phalanx", "hoplites", "sarissa", "macedon",
  "triremes", "salamis", "rowers", "bronze", "legions", "centurions", "gladius", "pilum",
  "testudo", "shields", "siege", "ramparts", "ballista", "torsion", "catapults", "sinew",
  "chariots", "kadesh", "hittites", "archers", "cavalry", "stirrups", "horsemen", "parthian",
  "aqueducts", "masonry", "arches", "concrete", "garrisons", "frontier", "hadrian", "limes",
  "javelins", "skirmishers", "slingers", "balearic", "spartans", "thermopylae", "pass", "persians",
  "longships", "oars", "raiders", "lindisfarne", "crossbows", "bolts", "qin", "terracotta",
  "trebuchets", "counterweight", "fortresses", "walls", "fire", "greek", "naphtha", "siphons",
  "camels", "caravans", "nabataeans", "petra", "forts", "palisades", "ditches", "earthworks",
  "standards", "eagles", "aquilifer", "cohorts", "marches", "roads", "milestones", "paving",
  "scouts", "signals", "beacons", "torches", "rations", "grain", "mules", "baggage",
  "surgeons", "wounds", "bandages", "vinegar"
];
const ACTS = 4;
const SLOTS = 6;
function wordsFor(a: number, s: number): string[] {
  const i = ((a * SLOTS + s) * 4) % VOCAB.length;
  return VOCAB.slice(i, i + 4);
}
/** The beat that the corpus speaks, for (act, slot). */
function spokenClaim(a: number, s: number): string {
  const [w1, w2, w3, w4] = wordsFor(a, s);
  return `The ${w1} and ${w2} were recorded with ${w3} beside the ${w4} in the old accounts.`;
}
/** A beat no episode speaks: it ends as narration with a trace row. */
function unspokenClaim(a: number, s: number): string {
  return `A quartermaster number ${a}${s} was paid in salt for a long winter on the northern road.`;
}

const SHOWS = [
  { show_id: "hardcore-history", show_title: "Hardcore History" },
  { show_id: "fall-of-civilizations", show_title: "Fall of Civilizations" },
  { show_id: "titans-of-nuclear", show_title: "Titans of Nuclear" }
];
const FILLER = [
  "anyway let us take a short break for a word from the people who pay for this show",
  "and we are back so thanks again to everybody who wrote in last week with questions",
  "my cousin keeps bees on a rooftop in the city which is a whole other conversation",
  "the weather here has been strange all month with rain every single afternoon"
];

interface Spoken {
  a: number;
  s: number;
  guid: string;
  startSec: number;
  endSec: number;
}

function claimCues(claim: string, startSec: number): TranscriptCue[] {
  const words = claim.replace(/[^A-Za-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
  const per = Math.ceil(words.length / 4);
  return Array.from({ length: 4 }, (_, i) => ({
    text: words.slice(i * per, (i + 1) * per).join(" ").toLowerCase() || "right",
    start_sec: startSec + i * 20,
    end_sec: startSec + (i + 1) * 20,
    speaker: null
  }));
}

/** Eight episodes over the three shows; every (act, slot)'s spoken claim is
 * dealt round-robin onto them between filler, and each episode is titled with
 * the words of its first claim (so the title path can find it too). */
function buildCorpus(): { archive: TranscriptDigestEntry[]; cuesByGuid: Map<string, TranscriptCue[]>; spoken: Spoken[] } {
  const EPISODES = 8;
  const cuesByGuid = new Map<string, TranscriptCue[]>();
  const archive: TranscriptDigestEntry[] = [];
  const spoken: Spoken[] = [];
  const perEpisode: Array<Array<{ a: number; s: number }>> = Array.from({ length: EPISODES }, () => []);
  let k = 0;
  for (let a = 0; a < ACTS; a++) for (let s = 0; s < SLOTS; s++) perEpisode[k++ % EPISODES]!.push({ a, s });
  for (let e = 0; e < EPISODES; e++) {
    const show = SHOWS[e % SHOWS.length]!;
    const guid = `gv95-ep-${e}`;
    const cues: TranscriptCue[] = [];
    let t = 0;
    const filler = (n: number) => {
      for (let i = 0; i < n; i++) {
        cues.push({ text: FILLER[(t / 20) % FILLER.length]!, start_sec: t, end_sec: t + 20, speaker: null });
        t += 20;
      }
    };
    /* The listener's subject, said once in the first episode, so the subject
       probe (#703) finds the corpus is about this Foray. */
    if (e === 0) {
      cues.push({ text: "today the armies of the ancient world and how they marched and fought", start_sec: t, end_sec: t + 20, speaker: null });
      t += 20;
    }
    filler(3);
    for (const { a, s } of perEpisode[e]!) {
      for (const c of claimCues(spokenClaim(a, s), t)) cues.push(c);
      spoken.push({ a, s, guid, startSec: t, endSec: t + 80 });
      t += 80;
      filler(8);
    }
    cuesByGuid.set(guid, cues);
    const first = perEpisode[e]![0]!;
    archive.push({
      show_id: show.show_id,
      show_title: show.show_title,
      guid,
      title: wordsFor(first.a, first.s).join(" "),
      cues: cues.length,
      feed_duration_sec: Math.max(3600, t + 60),
      enclosure_url: `https://cdn.example/${guid}.mp3`
    });
  }
  /* One more episode, under a pool row only: no claim says a word of it, so
     no search returns it and only the pool's own entry in sourcingBodies
     fetches its body (tier 1 reads every pool segment's window). */
  const poolOnly = "gv95-pool-only";
  const poolCues: TranscriptCue[] = Array.from({ length: 12 }, (_, i) => ({
    text: "amphorae of olive oil and wine filled the ostia harbour warehouses",
    start_sec: i * 20,
    end_sec: i * 20 + 20,
    speaker: null
  }));
  cuesByGuid.set(poolOnly, poolCues);
  archive.push({
    show_id: "fall-of-civilizations",
    show_title: "Fall of Civilizations",
    guid: poolOnly,
    title: "Ostia harbour warehouses",
    cues: poolCues.length,
    feed_duration_sec: 3600,
    enclosure_url: `https://cdn.example/${poolOnly}.mp3`
  });
  /* And one reached only by the seed: act 0 slot 0's claim spoken again, in
     an episode whose title shares no word with any claim, so the title path
     never opens it; in the degraded run (no search answered) only the seed's
     entry in sourcingBodies fetches its body. */
  const seedOnly = "gv95-seed-only";
  const seedCues: TranscriptCue[] = [];
  let st = 0;
  for (let i = 0; i < 3; i++, st += 20) seedCues.push({ text: FILLER[i % FILLER.length]!, start_sec: st, end_sec: st + 20, speaker: null });
  for (const c of claimCues(spokenClaim(0, 0), st)) seedCues.push(c);
  spoken.push({ a: 0, s: 0, guid: seedOnly, startSec: st, endSec: st + 80 });
  st += 80;
  for (let i = 0; i < 4; i++, st += 20) seedCues.push({ text: FILLER[i % FILLER.length]!, start_sec: st, end_sec: st + 20, speaker: null });
  cuesByGuid.set(seedOnly, seedCues);
  archive.push({
    show_id: "hardcore-history",
    show_title: "Hardcore History",
    guid: seedOnly,
    title: "Dispatches about camp kitchens",
    cues: seedCues.length,
    feed_duration_sec: 3600,
    enclosure_url: `https://cdn.example/${seedOnly}.mp3`
  });
  return { archive, cuesByGuid, spoken };
}

const CORPUS = buildCorpus();
const ARCHIVE = CORPUS.archive;
const entryOf = (guid: string): TranscriptDigestEntry => ARCHIVE.find((e) => e.guid === guid)!;
const spokenAt = (a: number, s: number): Spoken => CORPUS.spoken.find((x) => x.a === a && x.s === s)!;
/** Where act 0 slot 0's seed points: its second telling, in the seed-only episode. */
const SEED_AT = CORPUS.spoken.find((x) => x.guid === "gv95-seed-only")!;

/** One committed pool row over act 1 slot 0's spoken stretch, in the lineage,
 * so tier 1 reads its window text from a hydrated body. */
const POOL_AT = spokenAt(1, 0);
const POOL: SegmentRecord[] = [
  {
    id: `${deriveItemId(entryOf(POOL_AT.guid))}#${POOL_AT.startSec}`,
    item_id: deriveItemId(entryOf(POOL_AT.guid)),
    topic: TOPIC,
    start_sec: POOL_AT.startSec,
    end_sec: POOL_AT.endSec,
    reference_duration_sec: 3600,
    start_anchor: wordsFor(1, 0).slice(0, 2).join(" "),
    end_anchor: "in the old accounts",
    why: spokenClaim(1, 0),
    confidence: "high",
    transcript_source: "publisher",
    dai_suspected: false,
    source: "agent-v1",
    batch_id: "seg-test",
    needs_review: false
  } as SegmentRecord,
  {
    id: `${deriveItemId(entryOf("gv95-pool-only"))}#60`,
    item_id: deriveItemId(entryOf("gv95-pool-only")),
    topic: TOPIC,
    start_sec: 60,
    end_sec: 160,
    reference_duration_sec: 3600,
    start_anchor: "amphorae of olive oil",
    end_anchor: "ostia harbour warehouses",
    why: "Amphorae of olive oil and wine filled the Ostia harbour warehouses",
    confidence: "high",
    transcript_source: "publisher",
    dai_suspected: false,
    source: "agent-v1",
    batch_id: "seg-test",
    needs_review: false
  } as SegmentRecord
];

const SHOW_META = new Map(SHOWS.map((s) => [s.show_id, { dai: false, feedUrl: `https://feeds.example/${s.show_id}.xml`, appleCollectionId: null }]));

/**
 * The deepen builder: the stub's act (introduction, exit, thesis) with each
 * slot's beats replaced by two the corpus is built around: the spoken claim of
 * (act, slot), seeded for act 0 slot 0 at its second telling in the
 * seed-only episode, and a claim spoken nowhere.
 */
class ScriptedDeepen implements DeepenActBuilder {
  readonly providerName = "scripted";
  private readonly inner = new StubDeepenActBuilder();
  async deepenAct(spine: Spine, act: Act, index: number, ctx: DeepenActContext): Promise<DeepenedAct> {
    const base = await this.inner.deepenAct(spine, act, index, ctx);
    return {
      ...base,
      slots: base.slots.map((slot, s) => {
        const spokenBeat: Beat = { claim: spokenClaim(index, s), exploration: false, kind: "account" };
        if (index === 0 && s === 0) {
          spokenBeat.seed = { episodeId: deriveItemId(entryOf(SEED_AT.guid)), startSec: SEED_AT.startSec, endSec: SEED_AT.endSec };
        }
        return { title: slot.title, beats: [spokenBeat, { claim: unspokenClaim(index, s), exploration: false, kind: "account" }] };
      })
    };
  }
}

/* ---------------------------------------------------------------------------
   The local pair and the fake server
   --------------------------------------------------------------------------- */

const keyOf = (e: TranscriptDigestEntry): string => `${e.show_id}\u0000${e.guid}`;
function memoryStore(): CueStore & { bodyStat(entry: TranscriptDigestEntry): { mtimeMs: number; size: number } | null } {
  const byKey = new Map(ARCHIVE.map((e) => [keyOf(e), CORPUS.cuesByGuid.get(e.guid)!]));
  return {
    getCues: (entry) => byKey.get(keyOf(entry)) ?? null,
    readCuesUncached: (entry) => byKey.get(keyOf(entry)) ?? null,
    transcriptSource: (entry) => (byKey.has(keyOf(entry)) ? "asr-local" : null),
    bodyStat: (entry) => (byKey.has(keyOf(entry)) ? { mtimeMs: 1_760_000_000_000, size: 4096 } : null)
  };
}

let serviceCount = 0;
function service(): RetrievalService {
  serviceCount += 1;
  return new RetrievalService({
    loadArchive: () => ({ rows: ARCHIVE, generatedAt: "2026-10-18T00:00:00.000Z" }),
    loadManifest: () => null,
    createCueStore: memoryStore,
    indexRoot: path.join(tmp, `index-${serviceCount}`),
    logger: { info: () => undefined, error: () => undefined }
  });
}

interface Call {
  route: string;
  url: URL;
}
/** The injected fetch: into the in-process server, unless `route` answers
 * (a canned status) first. */
function fakeFetch(svc: RetrievalService, route?: (call: Call) => { status: number } | undefined) {
  const calls: Call[] = [];
  const fetchFn: RetrievalFetch = async (url: string, init: RetrievalFetchInit) => {
    const u = new URL(url);
    const call = { route: u.pathname, url: u };
    calls.push(call);
    const canned = route?.(call);
    const reply = (status: number, json: unknown) => {
      const text = JSON.stringify(json);
      return { ok: status >= 200 && status < 300, status, text: async () => text };
    };
    if (canned) return reply(canned.status, { error: "canned" });
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    try {
      if (u.pathname === "/healthz") return reply(200, svc.health());
      if (u.pathname === "/v1/episodes") return reply(200, svc.episodes());
      if (u.pathname === "/v1/scopes") return reply(200, svc.createScope(body.episodes));
      if (u.pathname === "/v1/search") return reply(200, { results: svc.search(body.scopeId, body.queries) });
      if (u.pathname === "/v1/cues") return reply(200, svc.cues(u.searchParams.get("show_id"), u.searchParams.get("guid")));
    } catch (error) {
      return reply((error as { status?: number }).status ?? 500, { error: String(error) });
    }
    return reply(404, { error: "not found" });
  };
  return { fetchFn, calls };
}

/** Every search a run makes, by the scope its predicate selects. */
class RecordingTextIndex implements TranscriptTextIndex {
  readonly searches: Array<{ scope: "lineage" | "all"; text: string; limit: number | undefined }> = [];
  constructor(private readonly inner: TranscriptTextIndex) {}
  get enabled(): boolean {
    return this.inner.enabled;
  }
  search(queryText: string, opts: TranscriptTextSearchOptions = {}) {
    this.searches.push({ scope: opts.isUsable ? "lineage" : "all", text: queryText, limit: opts.limit });
    return this.inner.search(queryText, opts);
  }
  answers(queryText: string, opts: TranscriptTextSearchOptions = {}): boolean {
    const inner = this.inner as { answers?: (q: string, o: TranscriptTextSearchOptions) => boolean };
    return typeof inner.answers === "function" ? inner.answers.call(this.inner, queryText, opts) : true;
  }
}

/** Every tape document the evidence gatherer built. */
function recordingEvidence(cueProvider: CueStore | HydratingCueProvider): { gatherer: EvidenceGatherer; tapeDocs: EvidenceDoc[] } {
  const inner = createEvidenceGatherer({
    researcher: new StubExternalResearcher(),
    cueProvider,
    transcriptArchive: ARCHIVE,
    catalogue: loadCatalogueData(),
    cacheDir: null
  });
  const tapeDocs: EvidenceDoc[] = [];
  return {
    tapeDocs,
    gatherer: {
      gather: async (beat: EvidenceBeat, ctx: ExternalResearchContext) => {
        const pack = await inner.gather(beat, ctx);
        for (const doc of pack.docs) if (doc.kind === "tape") tapeDocs.push(doc);
        return pack;
      },
      tapeEvidenceMetrics: () => inner.tapeEvidenceMetrics!()
    }
  };
}

function recordingFinalize() {
  return async (input: FinalizeForayInput): Promise<FinalizeForayResult> =>
    ({
      validation: { ok: true, checkForaysErrors: [], checkForaysWarnings: [], checkNarrationErrors: [], checkNarrationWarnings: [] },
      forayRecord: { id: input.id, generated: true } as never,
      timings: []
    }) as unknown as FinalizeForayResult;
}

function baseDeps(): RunPipelineDeps {
  return {
    understander: new StubPromptUnderstander(),
    researcher: new StubExternalResearcher(),
    spineBuilder: new StubSpineBuilder(),
    deepenBuilder: new ScriptedDeepen(),
    narrationWriter: new StubNarrationWriterBuilder(),
    narrationVerifier: new StubNarrationVerifierBuilder(),
    continuityBuilder: new StubContinuityBuilder(),
    finalize: recordingFinalize(),
    transcriptArchive: ARCHIVE,
    segmentPool: POOL,
    audioSourceFor: (entry, itemId) => mintSegmentSource(entry, itemId, SHOW_META)
  };
}

const CHECKPOINT_KEY = "gv95-run";
const newStore = () => new FakeCheckpointStore(checkpointFingerprint({ prompt: request.prompt, duration: request.duration, topic: TOPIC }));

interface RunRecord {
  outcome: RunPipelineOutcome;
  store: FakeCheckpointStore;
  searches: RecordingTextIndex["searches"];
  tapeDocs: EvidenceDoc[];
}

async function localRun(): Promise<RunRecord> {
  const bodies = memoryStore();
  const index = new RecordingTextIndex(new FileTranscriptTextIndex({ archive: ARCHIVE, bodies, cache: false }));
  const evidence = recordingEvidence(bodies);
  const store = newStore();
  const outcome = await runForayPipeline(request, { ...options, checkpointKey: CHECKPOINT_KEY }, {
    ...baseDeps(),
    cueProvider: bodies,
    textIndex: index,
    evidence: evidence.gatherer,
    checkpoint: store
  });
  return { outcome, store, searches: index.searches, tapeDocs: evidence.tapeDocs };
}

async function remoteRun(
  options_: {
    svc?: RetrievalService;
    route?: (call: Call) => { status: number } | undefined;
    store?: FakeCheckpointStore;
    /** GV-125: the server's FORAY_RETRIEVAL_MODE (default bm25). */
    mode?: RetrievalMode;
    /** GV-125: reuse one instance across runs, as the batch driver does. */
    retrieval?: RemoteRetrieval;
  } = {}
): Promise<RunRecord & { retrieval: RemoteRetrieval; calls: Call[] }> {
  const { fetchFn, calls } = fakeFetch(options_.svc ?? service(), options_.route);
  const retrieval =
    options_.retrieval ??
    new RemoteRetrieval({ baseUrl: "http://127.0.0.1:7311", token: "t0ken", fetchFn, archive: ARCHIVE, ...(options_.mode ? { mode: options_.mode } : {}) });
  if (!options_.retrieval) await retrieval.loadManifest();
  const cueProvider = new HydratingCueProvider(retrieval);
  const index = new RecordingTextIndex(new PrecomputedTextIndex(retrieval));
  const evidence = recordingEvidence(cueProvider);
  const store = options_.store ?? newStore();
  const outcome = await runForayPipeline(request, { ...options, checkpointKey: CHECKPOINT_KEY }, {
    ...baseDeps(),
    cueProvider,
    textIndex: index,
    evidence: evidence.gatherer,
    checkpoint: store,
    retrieval
  });
  return { outcome, store, searches: index.searches, tapeDocs: evidence.tapeDocs, retrieval, calls };
}

const stageOf = (record: RunRecord, name: string): unknown => record.store.files.get(CHECKPOINT_KEY)?.stages[name];
const withoutClock = (shape: unknown) => ({ ...(shape as Record<string, unknown>), generatedAt: "<clock>" });
const docKey = (d: EvidenceDoc) => `${d.docId}\u0000${d.text}`;
const sortedDocs = (docs: EvidenceDoc[]) => [...new Map(docs.map((d) => [docKey(d), d])).values()].sort((a, b) => (docKey(a) < docKey(b) ? -1 : 1));
const timingNames = (outcome: RunPipelineOutcome) => outcome.timings.map((t) => t.name);

/* ---------------------------------------------------------------------------
   The tests
   --------------------------------------------------------------------------- */

describe("GV-95: a run against the retrieval server equals the same run on the File pair", () => {
  it("parity: the research map, newSegments, sourcingTrace, tapeRelevance and evidence tape documents deep-equal; no search missed and no body read unhydrated", async () => {
    /* MUTATIONS THAT KILL THIS: drop the pool rows' episodes from
       sourcingBodies (tier 1 reads metadata where the File run read the
       window, and hydrationMisses > 0); prepare the thesis query at limit 8
       (thesisQueryFor's limit at the prepare site only: a miss); skip the
       prepareQueries callback in research-shape (the probe and subtopic
       searches miss). Ran all three: red. */
    const local = await localRun();
    const remote = await remoteRun();
    expect(local.outcome.outcome).toBe("generated");
    expect(remote.outcome.outcome).toBe("generated");
    if (local.outcome.outcome !== "generated" || remote.outcome.outcome !== "generated") return;

    /* Not vacuous: tape from both tiers and a seed, a narrated beat, evidence. */
    const relevance = local.outcome.tapeRelevance;
    expect(relevance.some((r) => r.tier === 1)).toBe(true);
    expect(relevance.some((r) => r.tier === 2)).toBe(true);
    expect(relevance.some((r) => r.seedWindowWon)).toBe(true);
    const sourced = stageOf(local, "source") as { newSegments: unknown[]; sourcingTrace: unknown[]; acts: unknown[] };
    expect(sourced.newSegments.length).toBeGreaterThan(0);
    expect(sourced.sourcingTrace.length).toBeGreaterThan(0);
    expect(sourced.acts.length).toBeGreaterThan(1);
    expect(local.tapeDocs.length).toBeGreaterThan(0);

    expect(withoutClock(stageOf(remote, "research-shape"))).toEqual(withoutClock(stageOf(local, "research-shape")));
    const remoteSourced = stageOf(remote, "source") as typeof sourced & { tapeRelevance: unknown; newSegmentSources: unknown };
    expect(remoteSourced.newSegments).toEqual(sourced.newSegments);
    expect(remoteSourced.sourcingTrace).toEqual(sourced.sourcingTrace);
    expect(remoteSourced.tapeRelevance).toEqual((stageOf(local, "source") as typeof remoteSourced).tapeRelevance);
    expect(remoteSourced.acts).toEqual(sourced.acts);
    expect(remote.outcome.tapeRelevance).toEqual(local.outcome.tapeRelevance);
    expect(sortedDocs(remote.tapeDocs)).toEqual(sortedDocs(local.tapeDocs));

    /* Every search the run made was answered, the probe and the thesis
       queries included, and no body was read that had not been fetched. */
    const stats = remote.retrieval.stats();
    expect(stats.misses).toBe(0);
    expect(stats.hydrationMisses).toBe(0);
    expect(stats.degraded).toBe(0);
    expect(stats.hits).toBe(remote.searches.length);
    expect(remote.searches).toEqual(local.searches);
    expect(remote.searches.some((s) => s.scope === "all" && s.limit === SUBJECT_PROBE_LIMIT)).toBe(true);
    expect(remote.searches.some((s) => s.scope === "lineage" && s.limit === 1)).toBe(true);

    /* The three retrieval stages ran and are timed; the File run has none. */
    for (const name of ["retrieval:research", "retrieval:source", "retrieval:evidence"]) {
      expect(timingNames(remote.outcome)).toContain(name);
      expect(timingNames(local.outcome)).not.toContain(name);
    }
    /* The server's counts ride beside the prefetch's, only on the remote run. */
    const remoteMetrics = remote.outcome.input.meta?.veracity?.retrieval as { remote?: { hits: number; misses: number } } | undefined;
    expect(remoteMetrics?.remote).toMatchObject({ misses: 0, hits: stats.hits });
    expect(local.outcome.input.meta?.veracity?.retrieval).not.toHaveProperty("remote");
    /* The token went to a loopback host and to no other. */
    expect(remote.calls.every((c) => c.url.hostname === "127.0.0.1")).toBe(true);
  }, 120_000);

  it("a resumed run whose sourcing is banked hydrates every clip's episode before evidence: same tape documents, no hydration miss", async () => {
    /* MUTATION THAT KILLS THIS: delete the 'retrieval:evidence' hydration (a
       resumed sourcing then reaches the evidence stage with nothing held:
       hydrationMisses > 0 and no tape document). Ran it: red. */
    const first = await remoteRun();
    expect(first.outcome.outcome).toBe("generated");
    /* Narration and stitching are dropped, so the resumed run writes again and
       gathers evidence; topic, research, spine, deepen and source stay banked. */
    const banked = first.store.stageKeys(CHECKPOINT_KEY);
    first.store.drop(CHECKPOINT_KEY, banked.filter((k) => k.startsWith("narrate:") || k.startsWith("stitch:")));
    expect(first.store.stageKeys(CHECKPOINT_KEY)).toContain("source");

    const resumed = await remoteRun({ store: first.store });
    expect(resumed.outcome.outcome).toBe("generated");
    expect(timingNames(resumed.outcome)).not.toContain("retrieval:source");
    expect(timingNames(resumed.outcome)).toContain("retrieval:evidence");
    expect(resumed.retrieval.stats().hydrationMisses).toBe(0);
    expect(resumed.tapeDocs.length).toBeGreaterThan(0);
    expect(sortedDocs(resumed.tapeDocs)).toEqual(sortedDocs(first.tapeDocs));
  }, 120_000);

  it("a degraded server (every search refused) still completes on the title path and the seed, and records why in meta.veracity.retrieval.remote", async () => {
    /* The probe and the subtopic searches MISS, which researchShape now
       reports as not searched rather than refusing the map; sourcing falls back
       to the title path and the seed, whose bodies are still fetched.
       MUTATIONS THAT KILL THIS: hydrate only the text candidates in
       sourcingBodies (no title-path or seeded body is held: the title-path and
       seed tape is lost); drop only the seeded episode from sourcingBodies
       (`void seed`: the seed-only episode is read unhydrated, so
       hydrationMisses > 0 and act 0 slot 0 loses its seed window). Ran both:
       red. */
    const degraded = await remoteRun({ route: (call) => (call.route === "/v1/search" ? { status: 503 } : undefined) });
    expect(degraded.outcome.outcome).toBe("generated");
    if (degraded.outcome.outcome !== "generated") return;
    const stats = degraded.retrieval.stats();
    expect(stats.misses).toBeGreaterThan(0);
    expect(stats.hits).toBe(0);
    expect(stats.hydrationMisses).toBe(0);
    expect(stats.reasons).toContain("search: HTTP 503");
    const tier2 = degraded.outcome.tapeRelevance.filter((r) => r.tier === 2);
    expect(tier2.length).toBeGreaterThan(0);
    /* The seed won act 0 slot 0, from the episode only the seed reaches. */
    const seeded = degraded.outcome.tapeRelevance.find((r) => r.actIndex === 0 && r.slotIndex === 0 && r.beatIndex === 0);
    expect(seeded).toMatchObject({ tier: 2, seedWindowWon: true, itemId: deriveItemId(entryOf(SEED_AT.guid)) });
    const shape = stageOf(degraded, "research-shape") as { subjectTape: { searched: boolean } };
    expect(shape.subjectTape.searched).toBe(false);
    /* What report.json's row carries (`veracity`, generateForays.ts). */
    const remote = (degraded.outcome.input.meta?.veracity?.retrieval as { remote?: { reasons: string[] } } | undefined)?.remote;
    expect(remote?.reasons).toContain("search: HTTP 503");
  }, 120_000);
});

describe("GV-125: the #1413 wave-21 follow-ups on the retrieval server", () => {
  it("meta.veracity.retrieval.remote is this prompt's share: a second prompt on the same instance reports its own counts, not the batch's (#1413 item 16)", async () => {
    /* MUTATION THAT KILLS THIS: report `retrieval.stats()` again in
       runPipeline (the batch-wide counters). Ran it: red (the second row's
       misses and reasons are the two prompts' sum). */
    const route = (call: Call) => (call.route === "/v1/search" ? { status: 503 } : undefined);
    const first = await remoteRun({ route });
    const afterFirst = first.retrieval.stats();
    const second = await remoteRun({ route, retrieval: first.retrieval });
    const afterSecond = first.retrieval.stats();
    expect(first.outcome.outcome).toBe("generated");
    expect(second.outcome.outcome).toBe("generated");
    const rowOf = (record: RunRecord) =>
      record.outcome.outcome === "generated"
        ? (record.outcome.input.meta?.veracity?.retrieval as { remote?: { misses: number; degraded: number; reasons: string[]; hits: number } } | undefined)?.remote
        : undefined;
    const row1 = rowOf(first)!;
    const row2 = rowOf(second)!;
    /* Not vacuous: both prompts missed and degraded. */
    expect(row1.misses).toBeGreaterThan(0);
    expect(row1.degraded).toBeGreaterThan(0);
    expect(row2.misses).toBe(afterSecond.misses - afterFirst.misses);
    expect(row2.degraded).toBe(afterSecond.degraded - afterFirst.degraded);
    expect(row2.misses).toBeLessThan(afterSecond.misses);
    /* The same prompt twice: the same share each time. */
    expect(row2.misses).toBe(row1.misses);
    expect(row2.reasons).toEqual(afterSecond.reasons.slice(afterFirst.reasons.length));
    expect(row2.reasons).toContain("search: HTTP 503");
  }, 120_000);

  it("FORAY_RETRIEVAL_MODE=hybrid joins the pipeline's checkpoint fingerprint, as the driver computes it: no resume of a bm25 bank, a resume of a hybrid one (#1413 item 17)", async () => {
    /* MUTATION THAT KILLS THIS: drop `retrievalMode: deps.retrieval?.mode`
       from runPipeline's checkpointRunVariant call. Ran it: red (the hybrid
       run resumes the bm25 bank, so 'retrieval:source' never runs; and it
       cannot resume its own hybrid bank). */
    const bm25 = await remoteRun();
    expect(stageOf(bm25, "source")).toBeDefined();
    const overBm25 = await remoteRun({ mode: "hybrid", store: bm25.store });
    expect(overBm25.outcome.outcome).toBe("generated");
    expect(timingNames(overBm25.outcome)).toContain("retrieval:source");

    /* The store keyed by the driver's formula (generateForays.ts: the merged
       flags plus the instance's mode): the second hybrid run resumes it. */
    const hybridVariant = checkpointRunVariant({ ...resolvePipelineFlags(), retrievalMode: "hybrid" }, resolveRouting());
    expect(hybridVariant).toContain("retrieval=hybrid");
    const store = new FakeCheckpointStore(checkpointFingerprint({ prompt: request.prompt, duration: request.duration, topic: TOPIC, variant: hybridVariant }));
    const hybrid = await remoteRun({ mode: "hybrid", store });
    expect(timingNames(hybrid.outcome)).toContain("retrieval:source");
    const resumed = await remoteRun({ mode: "hybrid", store });
    expect(resumed.outcome.outcome).toBe("generated");
    expect(timingNames(resumed.outcome)).not.toContain("retrieval:source");
  }, 120_000);
});

describe("GV-95: sourcingBodies holds a seeded episode no search and no title reaches", () => {
  /** One act of one slot whose single beat makes `claim`, seeded at `guid`. */
  const seededActs = (claim: string, seedEpisode: string | null): DeepenedAct[] => {
    const beat: Beat = { claim, exploration: false, kind: "account" };
    if (seedEpisode) beat.seed = { episodeId: seedEpisode, startSec: 60, endSec: 140 };
    return [{ slots: [{ title: "s", beats: [beat] }] } as unknown as DeepenedAct];
  };
  const bodiesFor = (acts: DeepenedAct[]) =>
    sourcingBodies(acts, { transcriptArchive: ARCHIVE, segmentPool: [], topic: TOPIC, candidatesFor: () => [] }).map((e) => e.guid);

  it("adds the seeded episode (by item id or by guid) when the lineage gate admits it, and never when the gate refuses it", () => {
    /* MUTATIONS THAT KILL THIS: `void seed` in place of the seed's line in
       sourcingBodies (the seeded episode is never fetched); drop
       `&& isUsable(entry)` from that line (a seed outside the lineage is
       fetched). Ran both: red. */
    const claim = unspokenClaim(0, 0);
    /* Not vacuous: unseeded, nothing reaches any episode (no candidates, no
       title shares a word with the claim, no pool). */
    expect(bodiesFor(seededActs(claim, null))).toEqual([]);
    const admitted = entryOf("gv95-ep-3");
    expect(admitted.show_id).toBe("hardcore-history");
    expect(bodiesFor(seededActs(claim, deriveItemId(admitted)))).toEqual(["gv95-ep-3"]);
    expect(bodiesFor(seededActs(claim, admitted.guid))).toEqual(["gv95-ep-3"]);
    /* Titans of Nuclear is outside history/military-ancient's lineage. */
    const refused = entryOf("gv95-ep-2");
    expect(refused.show_id).toBe("titans-of-nuclear");
    expect(bodiesFor(seededActs(claim, deriveItemId(refused)))).toEqual([]);
  });
});

describe("GV-95: the batch driver's remote sources (generateForays.ts openRemoteRetrieval)", () => {
  it("loads the manifest, counts coverage from it, and warns when this machine's corpus digest is not the server's", async () => {
    /* MUTATION THAT KILLS THIS: skip loadManifest in openRemoteRetrieval
       (bodyStat answers null for every row and coverage counts no show).
       Ran it: red. */
    const lines: string[] = [];
    const { fetchFn } = fakeFetch(service());
    const sources = await openRemoteRetrieval({ baseUrl: "http://127.0.0.1:7311", token: "t0ken", mode: "bm25" }, ARCHIVE, {
      fetchFn,
      localGeneratedAt: () => "2026-10-01T00:00:00.000Z",
      log: (line) => lines.push(line)
    });
    expect(lines[0]).toBe("RETRIEVAL: http://127.0.0.1:7311 (mode bm25, token set)");
    expect(lines.join("\n")).not.toMatch(/t0ken/);
    expect(lines.some((l) => /corpus digest \(generated_at 2026-10-01T00:00:00.000Z\) is not the server's \(2026-10-18T00:00:00.000Z\)/.test(l))).toBe(true);
    for (const entry of ARCHIVE) expect(sources.cueProvider.bodyStat(entry)).not.toBeNull();
    const coverage = corpusCoverage({ archive: ARCHIVE, hasBody: (e) => sources.cueProvider.bodyStat(e as TranscriptDigestEntry) !== null, disk: sources.retrieval.manifestShows() });
    expect(coverage).toMatchObject({ showsOnDisk: 3, showsSearchable: 3, episodesSearchable: ARCHIVE.length, blindSpots: [] });

    const quiet: string[] = [];
    await openRemoteRetrieval({ baseUrl: "http://127.0.0.1:7311", token: undefined, mode: "bm25" }, ARCHIVE, {
      fetchFn: fakeFetch(service()).fetchFn,
      localGeneratedAt: () => "2026-10-18T00:00:00.000Z",
      log: (line) => quiet.push(line)
    });
    expect(quiet).toEqual(["RETRIEVAL: http://127.0.0.1:7311 (mode bm25, no token)"]);
  });

  it("retrievalConfig: unset is null (the local path), a token never goes over plain http to another host, hybrid needs a URL, malformed values name the variable", () => {
    /* MUTATION THAT KILLS THIS: drop the tokenWouldTravelInClear check in
       retrievalConfig. Ran it: red. */
    expect(retrievalConfig({})).toBeNull();
    expect(retrievalConfig({ FORAY_RETRIEVAL_URL: "http://127.0.0.1:7311/" })).toEqual({ baseUrl: "http://127.0.0.1:7311", token: undefined, mode: "bm25" });
    expect(retrievalConfig({ FORAY_RETRIEVAL_URL: "https://retrieval.example", FORAY_RETRIEVAL_TOKEN: "t", FORAY_RETRIEVAL_MODE: "hybrid" })).toEqual({
      baseUrl: "https://retrieval.example",
      token: "t",
      mode: "hybrid"
    });
    expect(retrievalConfig({ FORAY_RETRIEVAL_URL: "http://retrieval.lan:7311" })).toMatchObject({ token: undefined });
    const refused = () => retrievalConfig({ FORAY_RETRIEVAL_URL: "http://retrieval.lan:7311", FORAY_RETRIEVAL_TOKEN: "s3cret" });
    expect(refused).toThrow(FlagValueError);
    expect(refused).toThrow(/FORAY_RETRIEVAL_URL/);
    expect(refused).not.toThrow(/s3cret/);
    expect(() => retrievalConfig({ FORAY_RETRIEVAL_MODE: "hybrid" })).toThrow(/FORAY_RETRIEVAL_MODE/);
    expect(() => retrievalConfig({ FORAY_RETRIEVAL_MODE: "dense" })).toThrow(/FORAY_RETRIEVAL_MODE/);
    expect(() => retrievalConfig({ FORAY_RETRIEVAL_URL: "ftp://x" })).toThrow(/FORAY_RETRIEVAL_URL/);
    expect(() => retrievalConfig({ FORAY_RETRIEVAL_URL: "  " })).toThrow(/FORAY_RETRIEVAL_URL/);
    expect(() => retrievalConfig({ FORAY_RETRIEVAL_URL: "https://x", FORAY_RETRIEVAL_TOKEN: "" })).toThrow(/FORAY_RETRIEVAL_TOKEN/);
    /* The token file, read through an injected reader. */
    expect(retrievalConfig({ FORAY_RETRIEVAL_URL: "https://x", FORAY_RETRIEVAL_TOKEN_FILE: "token.txt" }, () => " from-file \n")).toMatchObject({ token: "from-file" });
    expect(() =>
      retrievalConfig({ FORAY_RETRIEVAL_URL: "https://x", FORAY_RETRIEVAL_TOKEN_FILE: "missing.txt" }, () => {
        throw new Error("ENOENT");
      })
    ).toThrow(/FORAY_RETRIEVAL_TOKEN_FILE/);
    expect(tokenWouldTravelInClear("http://127.0.0.2:1")).toBe(false);
    expect(tokenWouldTravelInClear("http://[::1]:1")).toBe(false);
    expect(tokenWouldTravelInClear("http://10.0.0.1:1")).toBe(true);
    expect(tokenWouldTravelInClear("not a url")).toBe(true);
  });
});
