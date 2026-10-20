import { describe, it, expect, afterEach } from "vitest";
import {
  buildResearchShape,
  selectWithShowQuota,
  SUBJECT_TAPE_FLOOR,
  tapeSignalFor,
  RESEARCH_TAPE_WINDOWS_PER_SUBTOPIC,
  RESEARCH_TAPE_WINDOW_MAX_CHARS,
  RESEARCH_TAPE_WINDOW_MAX_SEC,
  RESEARCH_TAPE_WINDOW_MIN_SEC,
  SUBJECT_PROBE_LIMIT,
  subjectProbeQuery,
  subtopicQueryText,
  type ResearchSearchRequest
} from "../src/generation/researchShape";
import { HydratingCueProvider, PrecomputedTextIndex, RemoteRetrieval } from "../src/generation/retrievalClient";
import {
  TAPE_CLAIM_SEARCH_MAX_SEC,
  TAPE_CLAIM_SEARCH_MIN_SEC,
  TAPE_WINDOW_MAX_SEC,
  TAPE_WINDOW_MIN_SEC,
  cueWindowText,
  selectTapeWindow
} from "../src/generation/transcriptArchiveLookup";
import { tokenizeForSourcing } from "../src/generation/catalogueLookup";
import { ResearchShapeSchema, type ResearchTapeWindow } from "../src/types/research";
import { FlagValueError, RESEARCH_SHOW_QUOTA_ENV, researchShowQuota } from "../src/generation/generationFlags";
import { FileTranscriptTextIndex } from "../src/generation/transcriptTextIndex";
import type { TranscriptBodySource, TranscriptTextIndex } from "../src/generation/transcriptTextIndex";
import type { TranscriptCue, TranscriptCueProvider, TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";
import { loadCatalogueData, type CatalogueData } from "../src/generation/catalogueLookup";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { TruncatedReplyError } from "../src/generation/anthropicCall";
import type { ExternalResearcher, ExternalResearchContext, ExternalResearchResult } from "../src/generation/ExternalResearcher";
import type { IntentUnderstanding } from "../src/types/generation";
import { InMemoryCostEventSink } from "../src/cost/costEvents";
import { BudgetGuard } from "../src/cost/budgetGuard";

function makeIntent(overrides: Partial<IntentUnderstanding> = {}): IntentUnderstanding {
  return {
    subject: "nuclear fusion reactors",
    angle: "how tokamak confinement actually works",
    priorKnowledge: "knows the name, not the mechanism",
    disappointment: "stays surface-level",
    ...overrides
  };
}

/**
 * A catalogue fixture that guarantees a genuine no-tape concept, unlike the
 * real on-disk catalogue where "onomatopoeia"-style subjects can drift onto
 * a well-covered concept (e.g. "language") as the catalogue grows over
 * time. Used only by the "no tape" test group below — the "against the
 * REAL catalogue" tests still exercise `loadCatalogueData()` directly.
 */
function noTapeFixtureCatalogue(): CatalogueData {
  return {
    items: [
      { id: "show-a--fusion-ep", show: "Show A", title: "Inside a Tokamak", topics: ["engineering/energy-fusion"], hook: "A deep look at fusion reactors." }
    ],
    itemTags: { "show-a--fusion-ep": ["fusion", "tokamak"] },
    concepts: {
      fusion: { terms: ["fusion", "tokamak"], topics: ["engineering/energy-fusion"], related: [] },
      // A real semantic-index concept with zero matching tape — this is the
      // genuine catalogue gap the "no tape" tests need, independent of
      // whatever the live on-disk catalogue happens to contain today.
      "sound-symbolism": {
        terms: ["onomatopoeia", "phonaesthetics", "sound-symbolism"],
        topics: ["language/linguistics"],
        related: []
      }
    },
    shows: [{ show_id: "show-a", title: "Show A", taxonomy_node_ids: ["engineering/energy-fusion"] }]
  };
}

/**
 * The mirror image of `noTapeFixtureCatalogue`, for WS-L: one concept with
 * enough catalogue items behind it to band as `strong`
 * (`tapeSignalFor` — 20 or more), which is the condition the tape-window search
 * runs under. Fixed rather than read from the live catalogue so the cases below
 * cannot start or stop searching as `data/discover.json` grows.
 */
function tapeFixtureCatalogue(): CatalogueData {
  const items = Array.from({ length: 25 }, (_, i) => ({
    id: `show-a--fusion-${i}`,
    show: "Show A",
    title: `Inside a tokamak, part ${i}`,
    topics: ["engineering/energy-fusion"],
    hook: "A deep look at fusion reactors."
  }));
  return {
    items,
    itemTags: Object.fromEntries(items.map((it) => [it.id, ["fusion", "tokamak"]])),
    concepts: { fusion: { terms: ["fusion", "tokamak"], topics: ["engineering/energy-fusion"], related: [] } },
    shows: [{ show_id: "show-a", title: "Show A", taxonomy_node_ids: ["engineering/energy-fusion"] }]
  };
}

function noTapeIntent(overrides: Partial<IntentUnderstanding> = {}): IntentUnderstanding {
  return makeIntent({
    subject: "onomatopoeia",
    angle: "sound symbolism and phonaesthetics, a linguistics curiosity with thin real-world tape",
    ...overrides
  });
}

/** Spy researcher: records every topic it was asked about, so tests can
 * assert the "cheap first" ordering — it must NOT fire for a topic the
 * catalogue already answered. */
class SpyExternalResearcher implements ExternalResearcher {
  readonly providerName = "spy";
  calls: string[] = [];
  constructor(private readonly guard: BudgetGuard) {}

  async research(topic: string, ctx: ExternalResearchContext): Promise<ExternalResearchResult> {
    this.calls.push(topic);
    await this.guard.checkAndRecord({
      userId: ctx.userId,
      operation: "external_research",
      provider: this.providerName,
      estimatedUsd: 0,
      dryRun: true,
      sessionId: ctx.sessionId
    });
    return { notes: `spy notes for ${topic}`, controversies: [`spy controversy for ${topic}`] };
  }
}

function guardAndSink() {
  const sink = new InMemoryCostEventSink();
  const guard = new BudgetGuard(sink, 5.0);
  return { sink, guard };
}

describe("tapeSignalFor", () => {
  it("maps item counts to the documented signal buckets", () => {
    expect(tapeSignalFor(0)).toBe("none");
    expect(tapeSignalFor(1)).toBe("thin");
    expect(tapeSignalFor(4)).toBe("thin");
    expect(tapeSignalFor(5)).toBe("moderate");
    expect(tapeSignalFor(19)).toBe("moderate");
    expect(tapeSignalFor(20)).toBe("strong");
    expect(tapeSignalFor(500)).toBe("strong");
  });
});

describe("buildResearchShape — §4.2 against the REAL catalogue (data/discover.json, data/catalog.json, data/semantic-index.json, data/item-tags.json)", () => {
  it("finds real tape for a subject the catalogue is known to be deep on (fusion)", async () => {
    const { guard } = guardAndSink();
    const researcher = new StubExternalResearcher(guard);
    const shape = await buildResearchShape(makeIntent(), { researcher, ctx: { userId: "founder-1" } });

    expect(shape.subtopics.length).toBeGreaterThan(0);
    const fusionSubtopic = shape.subtopics.find((s) => s.label.toLowerCase() === "fusion");
    expect(fusionSubtopic).toBeDefined();
    expect(fusionSubtopic!.tape.signal).not.toBe("none");
    expect(fusionSubtopic!.tape.itemCount).toBeGreaterThan(0);
    // Accuracy check against real data: every example id returned must
    // actually exist in the real discover.json, so a wrong answer here
    // (a hallucinated id) is caught rather than silently accepted.
    const catalogue = loadCatalogueData();
    const realIds = new Set(catalogue.items.map((i) => i.id));
    for (const id of fusionSubtopic!.tape.exampleItemIds) {
      expect(realIds.has(id)).toBe(true);
    }
  });

  it("still produces a real, non-empty subtopic entry for a subject the catalogue has NO tape for — the guardrail against silent exclusion", async () => {
    const { guard } = guardAndSink();
    const researcher = new StubExternalResearcher(guard);
    const shape = await buildResearchShape(noTapeIntent(), {
      researcher,
      ctx: { userId: "founder-1" },
      catalogue: noTapeFixtureCatalogue()
    });

    expect(shape.subtopics.length).toBeGreaterThan(0);
    // A "no tape" subtopic must still be a first-class entry: present,
    // labeled, and carrying an honest "none" signal — never dropped.
    const noTapeEntries = shape.subtopics.filter((s) => s.tape.signal === "none");
    expect(noTapeEntries.length).toBeGreaterThan(0);
    for (const entry of noTapeEntries) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.tape.itemCount).toBe(0);
    }
  });

  it("carries the intent's subject and angle through unchanged", async () => {
    const { guard } = guardAndSink();
    const researcher = new StubExternalResearcher(guard);
    const intent = makeIntent();
    const shape = await buildResearchShape(intent, { researcher, ctx: { userId: "founder-1" } });
    expect(shape.subject).toBe(intent.subject);
    expect(shape.angle).toBe(intent.angle);
    expect(shape.nonObviousAngle).toBe(intent.angle);
  });
});

describe("buildResearchShape — cheap-first ordering: external research fires ONLY for genuine catalogue gaps", () => {
  it("does NOT call the external researcher for a subtopic the catalogue already answers", async () => {
    const { guard } = guardAndSink();
    const spy = new SpyExternalResearcher(guard);
    // "fusion" is deep in the real catalogue — every matched subtopic here
    // should have real tape, so the spy must never fire.
    await buildResearchShape(makeIntent(), { researcher: spy, ctx: { userId: "founder-1" } });

    const catalogue = loadCatalogueData();
    // Sanity precondition: prove the fixture assumption is true against
    // real data before trusting the zero-calls assertion below.
    const fusionTerms = catalogue.concepts["fusion"]?.terms ?? [];
    expect(fusionTerms.length).toBeGreaterThan(0);

    expect(spy.calls).not.toContain("Fusion");
  });

  it("DOES call the external researcher for a subtopic with zero catalogue tape", async () => {
    const { guard } = guardAndSink();
    const spy = new SpyExternalResearcher(guard);
    const shape = await buildResearchShape(noTapeIntent(), {
      researcher: spy,
      ctx: { userId: "founder-1" },
      catalogue: noTapeFixtureCatalogue()
    });

    const noTapeLabels = shape.subtopics.filter((s) => s.tape.signal === "none").map((s) => s.label);
    expect(noTapeLabels.length).toBeGreaterThan(0);
    for (const label of noTapeLabels) {
      expect(spy.calls).toContain(label);
    }
  });

  /* Round-3 review (L5): research() refuses a reply cut off at max_tokens
     (gen-10), and the fan-out ran Promise.all with no catch, so one truncated
     subtopic failed the whole research-shape stage.
     MUTATION: drop the TruncatedReplyError catch in fanOutExternalResearch --
     buildResearchShape rejects. */
  it("a subtopic whose external research is truncated gets no notes; the stage still completes", async () => {
    const { guard } = guardAndSink();
    const spy = new SpyExternalResearcher(guard);
    let first = true;
    const truncating: ExternalResearcher = {
      providerName: "truncating",
      research: async (topic, ctx) => {
        if (first) {
          first = false;
          throw new TruncatedReplyError("Anthropic external-research reply was truncated");
        }
        return spy.research(topic, ctx);
      }
    };
    const shape = await buildResearchShape(noTapeIntent(), { researcher: truncating, ctx: { userId: "founder-1" }, catalogue: noTapeFixtureCatalogue() });
    const gaps = shape.subtopics.filter((s) => s.tape.signal === "none");
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.filter((s) => s.externalNotes === null)).toHaveLength(1);

    const failing: ExternalResearcher = { providerName: "failing", research: async () => { throw new Error("budget exceeded"); } };
    await expect(
      buildResearchShape(noTapeIntent(), { researcher: failing, ctx: { userId: "founder-1" }, catalogue: noTapeFixtureCatalogue() })
    ).rejects.toThrow(/budget exceeded/);
  });

  it("records externallyResearched=true only for subtopics that were actually gaps", async () => {
    const { guard } = guardAndSink();
    const spy = new SpyExternalResearcher(guard);
    const shape = await buildResearchShape(noTapeIntent(), {
      researcher: spy,
      ctx: { userId: "founder-1" },
      catalogue: noTapeFixtureCatalogue()
    });

    for (const subtopic of shape.subtopics) {
      expect(subtopic.externallyResearched).toBe(subtopic.tape.signal === "none");
    }
  });

  it("externalGapsResearched lists exactly the labels that triggered external research", async () => {
    const { guard } = guardAndSink();
    const spy = new SpyExternalResearcher(guard);
    const shape = await buildResearchShape(noTapeIntent(), {
      researcher: spy,
      ctx: { userId: "founder-1" },
      catalogue: noTapeFixtureCatalogue()
    });

    expect(shape.externalGapsResearched.sort()).toEqual([...spy.calls].sort());
  });

  it("populates controversies/externalNotes from a real (dry-run) research call for a gap subtopic", async () => {
    const { guard } = guardAndSink();
    const researcher = new StubExternalResearcher(guard);
    const shape = await buildResearchShape(noTapeIntent(), {
      researcher,
      ctx: { userId: "founder-1" },
      catalogue: noTapeFixtureCatalogue()
    });
    const gap = shape.subtopics.find((s) => s.tape.signal === "none");
    expect(gap).toBeDefined();
    expect(gap!.externalNotes).not.toBeNull();
  });
});

describe("buildResearchShape — budget guard wiring", () => {
  it("routes every external-research call through the budget guard (recorded as a cost event)", async () => {
    const { sink, guard } = guardAndSink();
    const researcher = new StubExternalResearcher(guard);
    await buildResearchShape(noTapeIntent(), {
      researcher,
      ctx: { userId: "founder-1" },
      catalogue: noTapeFixtureCatalogue()
    });
    const events = await sink.all();
    expect(events.some((e) => e.operation === "external_research")).toBe(true);
  });

  it("records zero external_research cost events when every subtopic has real tape", async () => {
    const { sink, guard } = guardAndSink();
    const researcher = new StubExternalResearcher(guard);
    await buildResearchShape(makeIntent(), { researcher, ctx: { userId: "founder-1" } });
    const events = await sink.all();
    expect(events.filter((e) => e.operation === "external_research")).toHaveLength(0);
  });
});

/* WS-L (F-63): the research map stops being a list of counts and starts being a
   list of what the archive SAYS.

   The index and the cue provider are fakes here — in-memory cues behind the same
   two seams production uses (`TranscriptBodySource`, `TranscriptCueProvider`) —
   so the REAL BM25 index and the REAL window search do the work in every case
   below, rather than a stub that could agree with the code by accident. The
   offline half of this workstream, against the 63 *Practical AI* bodies on the
   generation machine, lives in `sourceBeats.test.ts` beside the F-61 cases. */
describe("buildResearchShape — WS-L: the map carries what the tape says (F-63)", () => {
  const mlEpisode: TranscriptDigestEntry = {
    show_id: "practical-ai",
    show_title: "Practical AI",
    guid: "pa-900",
    title: "Episode 900",
    cues: 6,
    feed_duration_sec: 3600
  };

  const mlCues: TranscriptCue[] = [
    { text: "welcome back everyone today we are talking about what happens after the model ships", start_sec: 0, end_sec: 30 },
    { text: "the fusion of two plasma streams is not what most machine learning teams worry about", start_sec: 30, end_sec: 62 },
    { text: "a tokamak is a beautiful machine and fusion research is genuinely hard engineering work", start_sec: 62, end_sec: 95 },
    { text: "we spent a year on fusion reactors and the tokamak confinement problem before this", start_sec: 95, end_sec: 130 },
    { text: "and then we went back to shipping models which is a different kind of hard", start_sec: 130, end_sec: 165 },
    { text: "that is all we have time for today thanks for listening", start_sec: 165, end_sec: 200 }
  ];

  /** The same two seams production uses, over cues held in memory. */
  function fakeIndex(archive: TranscriptDigestEntry[], cuesByGuid: Record<string, TranscriptCue[]>): TranscriptTextIndex {
    const bodies: TranscriptBodySource = {
      getCues: (entry) => cuesByGuid[entry.guid] ?? null,
      bodyStat: (entry) => (cuesByGuid[entry.guid] ? { mtimeMs: 1, size: 1 } : null)
    };
    /* `cache: false` — nothing in a test may touch the disk cache the
       generation machine's production path reads. */
    return new FileTranscriptTextIndex({ archive, bodies, cache: false });
  }

  function fakeCues(cuesByGuid: Record<string, TranscriptCue[]>): TranscriptCueProvider {
    return { getCues: (entry) => cuesByGuid[entry.guid] ?? null };
  }

  it("attaches the tape's own sentences to a subtopic the catalogue has real tape for", async () => {
    const { guard } = guardAndSink();
    const shape = await buildResearchShape(makeIntent(), {
      researcher: new StubExternalResearcher(guard),
      ctx: { userId: "founder-1" },
      catalogue: tapeFixtureCatalogue(),
      /* No topic, so the lineage gate is inert and this fixture's own show does
         not need a row in `data/catalog.json` to be searchable. */
      topic: null,
      textIndex: fakeIndex([mlEpisode], { "pa-900": mlCues }),
      cueProvider: fakeCues({ "pa-900": mlCues })
    });

    const fusion = shape.subtopics.find((s) => s.label === "Fusion")!;
    expect(fusion.tape.signal).toBe("strong");
    expect(fusion.windowsUnavailable).toBeNull();
    expect(fusion.tapeWindows.length).toBeGreaterThanOrEqual(1);

    const window = fusion.tapeWindows[0]!;
    expect(window.episodeId).toBe("practical-ai--episode-900");
    expect(window.showTitle).toBe("Practical AI");
    expect(window.episodeTitle).toBe("Episode 900");
    /* The window is the stretch that SAYS the subtopic's terms, not the
       episode's opening — and its text is the tape's own words, verbatim. */
    expect(window.text).toContain("tokamak");
    expect(window.text.length).toBeLessThanOrEqual(RESEARCH_TAPE_WINDOW_MAX_CHARS);
    expect(mlCues.some((c) => window.text.includes(c.text))).toBe(true);
    expect(window.endSec - window.startSec).toBeGreaterThanOrEqual(RESEARCH_TAPE_WINDOW_MIN_SEC);
    expect(window.endSec - window.startSec).toBeLessThanOrEqual(RESEARCH_TAPE_WINDOW_MAX_SEC);
    expect(window.score).toBeGreaterThan(0);
  });

  it("sizes its window band inside the claim search's band and over the tape window's floor (F-73, Q-01)", () => {
    /* A window quoted here is not only read. §4.3 seeds a beat with this
       episode AND these seconds, and F-68 then confines §4.5's search to exactly
       this stretch — so this band is, in practice, the CLAIM window every
       generated tape segment starts from. Since Q-01 the segment is that window
       extended to its thought (`tapeExtent.ts`), so what this band has to
       promise is narrower than it was under F-73: a research window must be a
       stretch the claim search could itself have found (inside
       `TAPE_CLAIM_SEARCH_MIN/MAX_SEC`) and never shorter than the floor a tape
       window is clamped to (`TAPE_WINDOW_MIN_SEC`), so a seed never asks the
       extension to grow a window the search would have refused.

       MUTATION THAT KILLS THIS: put `RESEARCH_TAPE_WINDOW_MIN_SEC` to 30 — under
       the tape window's floor. Ran it — red. */
    expect(RESEARCH_TAPE_WINDOW_MIN_SEC).toBeGreaterThanOrEqual(TAPE_WINDOW_MIN_SEC);
    expect(RESEARCH_TAPE_WINDOW_MIN_SEC).toBeGreaterThanOrEqual(TAPE_CLAIM_SEARCH_MIN_SEC);
    expect(RESEARCH_TAPE_WINDOW_MAX_SEC).toBeLessThanOrEqual(TAPE_CLAIM_SEARCH_MAX_SEC);
    expect(RESEARCH_TAPE_WINDOW_MAX_SEC).toBeLessThanOrEqual(TAPE_WINDOW_MAX_SEC);
    expect(RESEARCH_TAPE_WINDOW_MAX_SEC).toBeGreaterThan(RESEARCH_TAPE_WINDOW_MIN_SEC);
  });

  it("quotes a stretch long enough to be cut into a segment the D-tier rules accept (F-73)", async () => {
    /* The band above, measured on a real window rather than asserted about the
       constants: the fixture's tape yields a window at least the band's floor. */
    const { guard } = guardAndSink();
    const shape = await buildResearchShape(makeIntent(), {
      researcher: new StubExternalResearcher(guard),
      ctx: { userId: "founder-1" },
      catalogue: tapeFixtureCatalogue(),
      topic: null,
      textIndex: fakeIndex([mlEpisode], { "pa-900": mlCues }),
      cueProvider: fakeCues({ "pa-900": mlCues })
    });
    const window = shape.subtopics.find((s) => s.label === "Fusion")!.tapeWindows[0]!;
    expect(window.endSec - window.startSec).toBeGreaterThanOrEqual(RESEARCH_TAPE_WINDOW_MIN_SEC);
  });

  it("says WHY it has no windows rather than leaving an empty list to be read as an empty archive", async () => {
    const { guard } = guardAndSink();
    /* The default: no index at all. This is CI, a fresh checkout, and every
       caller written before WS-L — and it has to be distinguishable from "the
       archive was searched and says nothing". */
    const shape = await buildResearchShape(makeIntent(), {
      researcher: new StubExternalResearcher(guard),
      ctx: { userId: "founder-1" },
      catalogue: tapeFixtureCatalogue(),
      topic: null
    });
    for (const subtopic of shape.subtopics) {
      expect(subtopic.tapeWindows).toEqual([]);
      expect(subtopic.windowsUnavailable).toMatch(/no transcript text index/);
    }
  });

  it("does not search the tape for a subtopic the catalogue has no tape for", async () => {
    const { guard } = guardAndSink();
    const shape = await buildResearchShape(noTapeIntent(), {
      researcher: new StubExternalResearcher(guard),
      ctx: { userId: "founder-1" },
      catalogue: noTapeFixtureCatalogue(),
      topic: null,
      textIndex: fakeIndex([mlEpisode], { "pa-900": mlCues }),
      cueProvider: fakeCues({ "pa-900": mlCues })
    });
    const gap = shape.subtopics.find((s) => s.tape.signal === "none")!;
    expect(gap.tapeWindows).toEqual([]);
    expect(gap.windowsUnavailable).toMatch(/too thin to be worth quoting/);
  });

  it("refuses an off-lineage show before it opens it — F-11's own rule, one stage later", async () => {
    const { guard } = guardAndSink();
    /* `practical-ai` is a real show in `data/catalog.json`, under the AI branch;
       a grilling Foray must not be handed its transcripts to write beats from,
       for exactly the reason a bridge-collapse Foray must not be told it has
       761 items of strong AI tape. */
    const shape = await buildResearchShape(makeIntent(), {
      researcher: new StubExternalResearcher(guard),
      ctx: { userId: "founder-1" },
      catalogue: tapeFixtureCatalogue(),
      topic: "food/grilling-bbq",
      textIndex: fakeIndex([mlEpisode], { "pa-900": mlCues }),
      cueProvider: fakeCues({ "pa-900": mlCues })
    });
    for (const subtopic of shape.subtopics) {
      expect(subtopic.tapeWindows).toEqual([]);
      expect(subtopic.windowsUnavailable).toMatch(/taxonomy lineage/);
    }
  });

  it("attaches at most one window per episode, best first, so the spine sees different conversations", async () => {
    const { guard } = guardAndSink();
    const second: TranscriptDigestEntry = { ...mlEpisode, guid: "pa-901", title: "Episode 901" };
    const thinnerCues: TranscriptCue[] = [
      { text: "somebody asked us about fusion once and we did not have much to say", start_sec: 0, end_sec: 40 },
      { text: "so we talked about deployment instead for the rest of the hour", start_sec: 40, end_sec: 95 },
      { text: "which is what this show is mostly about anyway", start_sec: 95, end_sec: 140 }
    ];
    const shape = await buildResearchShape(makeIntent(), {
      researcher: new StubExternalResearcher(guard),
      ctx: { userId: "founder-1" },
      catalogue: tapeFixtureCatalogue(),
      topic: null,
      textIndex: fakeIndex([mlEpisode, second], { "pa-900": mlCues, "pa-901": thinnerCues }),
      cueProvider: fakeCues({ "pa-900": mlCues, "pa-901": thinnerCues })
    });
    const fusion = shape.subtopics.find((s) => s.label === "Fusion")!;
    const episodeIds = fusion.tapeWindows.map((w) => w.episodeId);
    expect(new Set(episodeIds).size).toBe(episodeIds.length);
    expect(fusion.tapeWindows.length).toBeLessThanOrEqual(RESEARCH_TAPE_WINDOWS_PER_SUBTOPIC);
    /* Ranked: the episode that spends a minute on the subtopic outranks the one
       that mentions it and moves on. */
    expect(fusion.tapeWindows[0]!.episodeId).toBe("practical-ai--episode-900");
    for (let i = 1; i < fusion.tapeWindows.length; i++) {
      expect(fusion.tapeWindows[i - 1]!.score).toBeGreaterThanOrEqual(fusion.tapeWindows[i]!.score);
    }
  });

  it("attaches six windows per subtopic when six episodes say it — the supply G-25's seed-every-beat ask draws on (R4)", async () => {
    /* The seed is the only path that yields (brief §3: unseeded 0/14 at every
       floor, seeded 10/14), so tape beats are bounded by windows. Four per
       subtopic gave the run-2 map 32 windows for a 32-beat spine that is now
       asked to seed every account beat; six keeps the supply ahead of the ask.
       MUTATION THAT KILLS THIS: put `RESEARCH_TAPE_WINDOWS_PER_SUBTOPIC` back
       to 4. Ran it — red (4 windows, and the pin). */
    expect(RESEARCH_TAPE_WINDOWS_PER_SUBTOPIC).toBe(6);
    const { guard } = guardAndSink();
    const episodes: TranscriptDigestEntry[] = [];
    const cuesByGuid: Record<string, TranscriptCue[]> = {};
    for (let i = 0; i < 9; i++) {
      const guid = `pa-${900 + i}`;
      episodes.push({ ...mlEpisode, guid, title: `Episode ${900 + i}` });
      cuesByGuid[guid] = mlCues;
    }
    const shape = await buildResearchShape(makeIntent(), {
      researcher: new StubExternalResearcher(guard),
      ctx: { userId: "founder-1" },
      catalogue: tapeFixtureCatalogue(),
      topic: null,
      textIndex: fakeIndex(episodes, cuesByGuid),
      cueProvider: fakeCues(cuesByGuid)
    });
    const fusion = shape.subtopics.find((s) => s.label === "Fusion")!;
    expect(fusion.tapeWindows.length).toBe(RESEARCH_TAPE_WINDOWS_PER_SUBTOPIC);
    /* Still one window per episode, so those are six different conversations. */
    expect(new Set(fusion.tapeWindows.map((w) => w.episodeId)).size).toBe(6);
  });

  it("does not offer a window that runs past its episode's declared duration, nor one from a span_implausible digest (F-87, #315)", async () => {
    /* Run 7 attempt 3: the spine seeded a claim from a Causality window whose
       cut ended at 2375.72 s on a 2071 s episode, and §4.5 — which now refuses
       such a cut (`past-duration`) — could only narrate the claim it had been
       told the tape carried. Research-shape must not quote tape §4.5 cannot
       cut. MUTATION THAT KILLS THIS: drop either `continue` in
       `tapeWindowsFor` (the duration comparison, or the `span_implausible`
       skip). Ran both — red on the episode the window came from. */
    const { guard } = guardAndSink();
    /* Research windows are at least 90 s (`RESEARCH_TAPE_WINDOW_MIN_SEC`); a
       feed that declares 60 s puts every window of `mlCues` past the declared
       audio, however early it starts. */
    const overrunning: TranscriptDigestEntry = { ...mlEpisode, guid: "pa-910", title: "Episode 910", feed_duration_sec: 60 };
    const implausible: TranscriptDigestEntry = { ...mlEpisode, guid: "pa-911", title: "Episode 911", span_implausible: true };
    const honest: TranscriptDigestEntry = { ...mlEpisode, guid: "pa-912", title: "Episode 912" };
    const cuesByGuid = { "pa-910": mlCues, "pa-911": mlCues, "pa-912": mlCues };
    const shape = await buildResearchShape(makeIntent(), {
      researcher: new StubExternalResearcher(guard),
      ctx: { userId: "founder-1" },
      catalogue: tapeFixtureCatalogue(),
      topic: null,
      textIndex: fakeIndex([overrunning, implausible, honest], cuesByGuid),
      cueProvider: fakeCues(cuesByGuid)
    });
    const fusion = shape.subtopics.find((s) => s.label === "Fusion")!;
    expect(fusion.tapeWindows.map((w) => w.episodeId)).toEqual(["practical-ai--episode-912"]);
    for (const w of fusion.tapeWindows) expect(w.endSec).toBeLessThanOrEqual(3600);

    /* And when the overrunning episode is the only one, the map says why the
       list is empty rather than reading as an archive with no bodies. */
    const only = await buildResearchShape(makeIntent(), {
      researcher: new StubExternalResearcher(guard),
      ctx: { userId: "founder-1" },
      catalogue: tapeFixtureCatalogue(),
      topic: null,
      textIndex: fakeIndex([overrunning], { "pa-910": mlCues }),
      cueProvider: fakeCues({ "pa-910": mlCues })
    });
    const onlyFusion = only.subtopics.find((s) => s.label === "Fusion")!;
    expect(onlyFusion.tapeWindows).toEqual([]);
    expect(onlyFusion.windowsUnavailable).toMatch(/runs past its episode's declared duration/);
    expect(onlyFusion.windowsUnavailable).toContain("#315");
  });
});

describe("cueWindowText — G-24 R1: the text spoken BETWEEN two timestamps, strict at both edges", () => {
  /* Cues are contiguous, so the cue that ends at the window's start is the
     sentence spoken just before it and the cue that starts at its end is the
     one spoken just after. Neither is inside the window; both used to be
     quoted (tape-yield brief §4 cause 2). */
  const cues: TranscriptCue[] = [
    { text: "before", start_sec: 60, end_sec: 100 },
    { text: "inside one", start_sec: 100, end_sec: 130 },
    { text: "inside two", start_sec: 130, end_sec: 160 },
    { text: "after", start_sec: 160, end_sec: 200 }
  ];

  it("leaves out the cue that ends exactly at the window's start and the one that starts exactly at its end", () => {
    /* MUTATION THAT KILLS THIS: put `cueWindowText` back to `end_sec < startSec`
       / `start_sec > endSec`. Ran it — red on both edges. */
    expect(cueWindowText(cues, 100, 160)).toBe("inside one inside two");
  });

  it("keeps a cue that overlaps the window by any positive amount", () => {
    /* Tier 1 reads a pool segment's cues through this function too, and a
       segment's bounds are anchor times that can sit mid-cue. */
    expect(cueWindowText(cues, 99.5, 160.5)).toBe("before inside one inside two after");
  });
});

describe("buildResearchShape — G-24 R1: the map quotes exactly the window's own cues, so a claim written from the quote sits inside the seed", () => {
  /* THE BUG, IN ONE FIXTURE. The window the search picks for "fusion tokamak"
     is 40-140 s (the two cues that say those words; 0-140 says the same two and
     loses on length). Before G-24 the quote opened with the 0-40 s lead-in —
     the cue that ENDS at the window's start — under the window's own seconds,
     the spine wrote its claim from that first sentence, and §4.5's seed window
     (F-68, confined to 40-140 s) then held none of the claim's words. On
     attempt 6 that was 7 of 8 quotes, 6 of 14 seeded claims, 2 beats lost. */
  const episode: TranscriptDigestEntry = {
    show_id: "practical-ai",
    show_title: "Practical AI",
    guid: "pa-910",
    title: "Episode 910",
    cues: 5,
    feed_duration_sec: 3600
  };
  const cues: TranscriptCue[] = [
    { text: "The grid operators in Denmark rationed electricity through the winter.", start_sec: 0, end_sec: 40 },
    { text: "Fusion is the reaction the sun runs on and nobody has bottled it yet.", start_sec: 40, end_sec: 100 },
    { text: "A tokamak is the doughnut shaped machine most laboratories bet on.", start_sec: 100, end_sec: 140 },
    { text: "The magnets cost more than the building that holds them.", start_sec: 140, end_sec: 200 },
    { text: "That is all we have time for today thanks for listening.", start_sec: 200, end_sec: 260 }
  ];

  function fakeIndex(): TranscriptTextIndex {
    const bodies: TranscriptBodySource = {
      getCues: (entry) => (entry.guid === episode.guid ? cues : null),
      bodyStat: (entry) => (entry.guid === episode.guid ? { mtimeMs: 1, size: 1 } : null)
    };
    return new FileTranscriptTextIndex({ archive: [episode], bodies, cache: false });
  }

  async function windowFor(): Promise<ResearchTapeWindow> {
    const { guard } = guardAndSink();
    const shape = await buildResearchShape(makeIntent(), {
      researcher: new StubExternalResearcher(guard),
      ctx: { userId: "founder-1" },
      catalogue: tapeFixtureCatalogue(),
      topic: null,
      textIndex: fakeIndex(),
      cueProvider: { getCues: (entry) => (entry.guid === episode.guid ? cues : null) }
    });
    const fusion = shape.subtopics.find((s) => s.label === "Fusion")!;
    expect(fusion.tapeWindows).toHaveLength(1);
    return fusion.tapeWindows[0]!;
  }

  it("quotes the window's cues and nothing spoken before or after them", async () => {
    /* MUTATION THAT KILLS THIS: `cueWindowText` back to its inclusive edges.
       Ran it — red: the quote opens with the Denmark sentence and closes with
       the magnets. */
    const window = await windowFor();
    expect(window.startSec).toBe(40);
    expect(window.endSec).toBe(140);
    expect(window.text.startsWith("Fusion is the reaction")).toBe(true);
    expect(window.text).not.toContain("Denmark");
    expect(window.text).not.toContain("magnets");
  });

  it("a claim written from the quote's first sentence scores at least the quote's own share inside the seed window", async () => {
    /* The card's test (G-24 done-when): what the spine reads and what §4.5
       searches are the same stretch of tape, so a claim taken verbatim from the
       quote carries into its seed window in full. Before G-24 this claim would
       have been the Denmark sentence, and its seed window's share 0. */
    const window = await windowFor();
    const claim = window.text.match(/[^.!?]+[.!?]/)![0]!.trim();
    const claimTerms = new Set(tokenizeForSourcing(claim));
    const quoteTerms = new Set(tokenizeForSourcing(window.text));
    const quoteShare = [...claimTerms].filter((t) => quoteTerms.has(t)).length / claimTerms.size;
    const seedWindow = selectTapeWindow(claim, cues, { within: { startSec: window.startSec, endSec: window.endSec } });
    expect(seedWindow).not.toBeNull();
    expect(seedWindow!.share).toBeGreaterThanOrEqual(quoteShare);
    expect(seedWindow!.share).toBe(1);
  });
});

describe("buildResearchShape — G-24 R3: one window per episode across the WHOLE map, not per subtopic", () => {
  /* Attempt 6's map listed 32 windows over 23 episodes with 8 episodes quoted
     twice under two subtopics; the spine seeded two of them twice, and §4.5's
     M4 ledger — one segment per episode until the Foray holds eight — refused
     the second seed of each before opening it (one at a weighted share of
     0.746). The ledger is right; the map must not offer a seed the Foray
     cannot take. Here two subtopics both rank the same episode first: the
     first quotes it, the second takes its next-best episode instead. */
  const both: TranscriptDigestEntry = { show_id: "practical-ai", show_title: "Practical AI", guid: "pa-920", title: "Episode 920", cues: 3, feed_duration_sec: 3600 };
  const plasmaOnly: TranscriptDigestEntry = { ...both, guid: "pa-921", title: "Episode 921" };
  const bothCues: TranscriptCue[] = [
    { text: "fusion in a tokamak is a plasma confinement problem first and a physics problem second", start_sec: 0, end_sec: 50 },
    { text: "the tokamak holds the plasma with magnets and the confinement is never perfect", start_sec: 50, end_sec: 100 },
    { text: "and fusion only pays when the confinement lasts long enough", start_sec: 100, end_sec: 150 }
  ];
  const plasmaCues: TranscriptCue[] = [
    { text: "plasma confinement is the part of the problem nobody outside the field hears about", start_sec: 0, end_sec: 50 },
    { text: "and the confinement time is the number every plasma group reports first", start_sec: 50, end_sec: 100 },
    { text: "so the plasma is where the money goes", start_sec: 100, end_sec: 150 }
  ];
  const cuesByGuid: Record<string, TranscriptCue[]> = { "pa-920": bothCues, "pa-921": plasmaCues };

  /** Two strong concepts that the intent matches, over the same 25 items. */
  function twoConceptCatalogue(): CatalogueData {
    const base = tapeFixtureCatalogue();
    return {
      ...base,
      itemTags: Object.fromEntries(base.items.map((it) => [it.id, ["fusion", "tokamak", "plasma", "confinement"]])),
      concepts: {
        ...base.concepts,
        plasma: { terms: ["plasma", "confinement"], topics: ["engineering/energy-fusion"], related: [] }
      }
    };
  }

  it("quotes an episode under the first subtopic that ranks it and gives the next subtopic its next-best episode", async () => {
    /* MUTATION THAT KILLS THIS: drop the `usedEpisodes` set from
       `tapeWindowsFor`. Ran it — red: Episode 920 is quoted under both. */
    const { guard } = guardAndSink();
    const bodies: TranscriptBodySource = {
      getCues: (entry) => cuesByGuid[entry.guid] ?? null,
      bodyStat: (entry) => (cuesByGuid[entry.guid] ? { mtimeMs: 1, size: 1 } : null)
    };
    const shape = await buildResearchShape(makeIntent(), {
      researcher: new StubExternalResearcher(guard),
      ctx: { userId: "founder-1" },
      catalogue: twoConceptCatalogue(),
      topic: null,
      textIndex: new FileTranscriptTextIndex({ archive: [both, plasmaOnly], bodies, cache: false }),
      cueProvider: { getCues: (entry) => cuesByGuid[entry.guid] ?? null }
    });
    const withWindows = shape.subtopics.filter((s) => s.tapeWindows.length > 0);
    expect(withWindows.length).toBe(2);
    const quoted = withWindows.flatMap((s) => s.tapeWindows.map((w) => w.episodeId));
    expect(new Set(quoted).size).toBe(quoted.length);
    expect(quoted.sort()).toEqual(["practical-ai--episode-920", "practical-ai--episode-921"]);
    /* And the map says WHY a subtopic's list is empty when every episode it
       ranked is already quoted, rather than reading as an empty archive. */
    const plasma = shape.subtopics.find((s) => s.label === "Plasma")!;
    const fusion = shape.subtopics.find((s) => s.label === "Fusion")!;
    expect(plasma.windowsUnavailable ?? fusion.windowsUnavailable).toBeNull();
  });
});

describe("buildResearchShape — #703: the map is checked against its own subject before the spine call", () => {
  const germEpisode: TranscriptDigestEntry = {
    show_id: "this-podcast-will-kill-you",
    show_title: "This Podcast Will Kill You",
    guid: "tpwky-1",
    title: "Ep 1: Childbed fever",
    cues: 4,
    feed_duration_sec: 3600
  };
  const germCues: TranscriptCue[] = [
    { text: "semmelweis asked the doctors on his ward to wash their hands in chlorinated lime", start_sec: 0, end_sec: 40 },
    { text: "the miasma theory said disease rose from bad air and germ theory had not yet won", start_sec: 40, end_sec: 85 },
    { text: "pasteur and lister were still decades from making any of this obvious to anyone", start_sec: 85, end_sec: 130 },
    { text: "and that is why nineteenth century medicine took so long to accept germ theory", start_sec: 130, end_sec: 175 }
  ];
  const engineeringEpisode: TranscriptDigestEntry = {
    show_id: "being-an-engineer",
    show_title: "Being an Engineer",
    guid: "bae-1",
    title: "S1E31 Toothpaste Boxes",
    cues: 3,
    feed_duration_sec: 3600
  };
  const engineeringCues: TranscriptCue[] = [
    { text: "injection moulding a toothpaste box is a surprisingly difficult manufacturing problem", start_sec: 0, end_sec: 45 },
    { text: "the tooling costs dominate and the cycle time is what decides your unit economics", start_sec: 45, end_sec: 95 },
    { text: "we ran the whole line for a year before anybody looked at the packaging again", start_sec: 95, end_sec: 150 }
  ];

  /**
   * A catalogue that reports STRONG tape for medicine, over a corpus that holds
   * none of it. That pairing is the whole of #703: the map's confidence came
   * from `data/discover.json` item counts, which had never looked at a
   * transcript, and the corpus behind them held engineering tape.
   */
  function medicineClaimingCatalogue(): CatalogueData {
    const items = Array.from({ length: 25 }, (_, i) => ({
      id: `tpwky--medicine-${i}`,
      show: "This Podcast Will Kill You",
      title: `Medicine and disease, part ${i}`,
      topics: ["medicine/biology"],
      hook: "Doctors, disease and the history of medicine."
    }));
    return {
      items,
      itemTags: Object.fromEntries(items.map((it) => [it.id, ["medicine", "disease"]])),
      concepts: { medicine: { terms: ["medicine", "disease", "germ", "doctors"], topics: ["medicine/biology"], related: [] } },
      shows: [{ show_id: "this-podcast-will-kill-you", title: "This Podcast Will Kill You", taxonomy_node_ids: ["medicine/biology"] }]
    };
  }

  function indexOver(archive: TranscriptDigestEntry[], cuesByGuid: Record<string, TranscriptCue[]>): TranscriptTextIndex {
    return new FileTranscriptTextIndex({
      archive,
      bodies: {
        getCues: (entry) => cuesByGuid[entry.guid] ?? null,
        bodyStat: (entry) => (cuesByGuid[entry.guid] ? { mtimeMs: 1, size: 1 } : null)
      },
      cache: false
    });
  }

  const germIntent = makeIntent({
    subject: "Germ theory's acceptance in nineteenth-century medicine",
    angle: "the decades between doctors refusing to wash their hands and germ theory becoming obvious"
  });

  it("refuses a map whose subject the searchable corpus says nothing about, and names what it searched", async () => {
    /* MUTATION THAT KILLS THIS: delete the `throw new ResearchMapRefusedError`
       and keep only the console warning. Then this is the 2026-09-14 run
       exactly: an engineering-only corpus, a germ-theory subject, a map that
       reads as healthy, and an Opus spine call spent on it. */
    const { guard } = guardAndSink();
    await expect(
      buildResearchShape(germIntent, {
        researcher: new StubExternalResearcher(guard),
        ctx: { userId: "founder-1" },
        catalogue: medicineClaimingCatalogue(),
        topic: null,
        textIndex: indexOver([engineeringEpisode], { "bae-1": engineeringCues }),
        cueProvider: { getCues: (entry) => ({ "bae-1": engineeringCues })[entry.guid] ?? null }
      })
    ).rejects.toThrow(/research map refused/i);
  });

  it("builds the map when one episode of the corpus does say the subject", async () => {
    /* MUTATION THAT KILLS THIS: raise SUBJECT_TAPE_FLOOR above 1, or run the
       probe through the lineage gate. Either turns the floor from "this corpus
       does not hold this Foray" into "this corpus does not hold ENOUGH of this
       Foray", which is a judgement §4.2's guardrail forbids — a thin subject
       must still get a real map. */
    const { guard } = guardAndSink();
    const cues = { "tpwky-1": germCues, "bae-1": engineeringCues };
    const shape = await buildResearchShape(germIntent, {
      researcher: new StubExternalResearcher(guard),
      ctx: { userId: "founder-1" },
      catalogue: medicineClaimingCatalogue(),
      topic: null,
      textIndex: indexOver([germEpisode, engineeringEpisode], cues),
      cueProvider: { getCues: (entry) => cues[entry.guid as keyof typeof cues] ?? null }
    });
    expect(shape.subjectTape?.searched).toBe(true);
    expect(shape.subjectTape?.episodesMatched).toBeGreaterThanOrEqual(SUBJECT_TAPE_FLOOR);
    expect(shape.subjectTape?.shows).toContain("This Podcast Will Kill You");
  });

  it("never refuses on a machine with no text index, because nothing was searched", async () => {
    /* MUTATION THAT KILLS THIS: drop the `subjectTape.searched` guard and
       refuse on `episodesMatched === 0`. CI and every fresh checkout run the
       Null index, which returns nothing by design — that would fail every
       keyless run on a machine with no data-local/, which is all of CI. */
    const { guard } = guardAndSink();
    const shape = await buildResearchShape(germIntent, {
      researcher: new StubExternalResearcher(guard),
      ctx: { userId: "founder-1" },
      catalogue: medicineClaimingCatalogue(),
      topic: null
    });
    expect(shape.subjectTape).toEqual({ query: expect.any(String), episodesMatched: 0, shows: [], searched: false });
    expect(shape.subtopics.length).toBeGreaterThan(0);
  });

  it("can be told to proceed anyway, so being stopped is never the end of the road", async () => {
    /* MUTATION THAT KILLS THIS: hardcode the refusal with no override. A
       genuinely untaped subject the founder wants narrated regardless is a
       legitimate Foray (§4.2's guardrail says so in as many words), and a floor
       with no door is a floor that gets deleted. */
    const { guard } = guardAndSink();
    const shape = await buildResearchShape(germIntent, {
      researcher: new StubExternalResearcher(guard),
      ctx: { userId: "founder-1" },
      catalogue: medicineClaimingCatalogue(),
      topic: null,
      refuseIrrelevantMap: false,
      textIndex: indexOver([engineeringEpisode], { "bae-1": engineeringCues }),
      cueProvider: { getCues: (entry) => ({ "bae-1": engineeringCues })[entry.guid] ?? null }
    });
    expect(shape.subjectTape?.episodesMatched).toBe(0);
    expect(shape.subtopics.length).toBeGreaterThan(0);
  });

  it("never refuses a map that honestly reports no tape, which §4.2's guardrail requires", async () => {
    /* MUTATION THAT KILLS THIS: drop the `claimsTape` condition and refuse on
       `episodesMatched === 0` alone. §4.2 says in as many words that "a
       genuinely untaped subject must still produce a real candidate, not an
       empty map" — narration carries those Forays. What #703 records is not an
       absence, it is a CONTRADICTION: strong catalogue signals over a corpus
       holding nothing about the subject. Refuse the contradiction only. */
    const { guard } = guardAndSink();
    const shape = await buildResearchShape(makeIntent({ subject: "onomatopoeia", angle: "sound symbolism" }), {
      researcher: new StubExternalResearcher(guard),
      ctx: { userId: "founder-1" },
      catalogue: noTapeFixtureCatalogue(),
      topic: null,
      textIndex: indexOver([engineeringEpisode], { "bae-1": engineeringCues }),
      cueProvider: { getCues: (entry) => ({ "bae-1": engineeringCues })[entry.guid] ?? null }
    });
    expect(shape.subjectTape?.episodesMatched).toBe(0);
    expect(shape.subtopics.length).toBeGreaterThan(0);
  });

  it("records how many episodes actually said each subtopic, separately from the catalogue's item count", async () => {
    /* MUTATION THAT KILLS THIS: leave `tapeEpisodesMatched` off the subtopic
       and let the prompt keep saying "tape: strong, 304 items". That number is
       catalogue BREADTH; #703's map printed it over five clips about toothpaste
       packaging and nothing said the fit was zero. */
    const { guard } = guardAndSink();
    const cues = { "tpwky-1": germCues };
    const shape = await buildResearchShape(germIntent, {
      researcher: new StubExternalResearcher(guard),
      ctx: { userId: "founder-1" },
      catalogue: medicineClaimingCatalogue(),
      topic: null,
      textIndex: indexOver([germEpisode], cues),
      cueProvider: { getCues: (entry) => cues[entry.guid as keyof typeof cues] ?? null }
    });
    /* EVERY subtopic carries the number, including the ones that found
       nothing — "0 episodes said this" is the sentence the germ-theory map
       should have printed under "tape: strong, 304 items". */
    expect(shape.subtopics.length).toBeGreaterThan(0);
    for (const subtopic of shape.subtopics) {
      expect(typeof subtopic.tapeEpisodesMatched).toBe("number");
      expect(subtopic.tapeEpisodesMatched).toBeGreaterThanOrEqual(subtopic.tapeWindows.length);
    }
  });
});


describe("GV-87: the per-show quota on a subtopic's tape windows (FORAY_RESEARCH_SHOW_QUOTA)", () => {
  /* A synthetic two-show archive. "Fusion Weekly" says the subtopic's terms the
     most, so with no quota it takes all six windows; "Energy Talk" says them
     less, and only a quota offers it to the spine. */
  const weekly = (n: number): TranscriptDigestEntry => ({
    show_id: "fusion-weekly",
    show_title: "Fusion Weekly",
    guid: `fw-${n}`,
    title: `Weekly ${n}`,
    cues: 3,
    feed_duration_sec: 3600
  });
  const talk = (n: number): TranscriptDigestEntry => ({
    show_id: "energy-talk",
    show_title: "Energy Talk",
    guid: `et-${n}`,
    title: `Talk ${n}`,
    cues: 3,
    feed_duration_sec: 3600
  });
  const weeklyCues: TranscriptCue[] = [
    { text: "fusion in a tokamak is the whole show today and the tokamak is the hard part", start_sec: 0, end_sec: 50 },
    { text: "fusion reactors need the tokamak to hold the plasma long enough for fusion to pay", start_sec: 50, end_sec: 100 },
    { text: "so every tokamak group measures fusion gain before anything else", start_sec: 100, end_sec: 150 }
  ];
  const talkCues: TranscriptCue[] = [
    { text: "the grid is changing fast and storage is the story most people miss", start_sec: 0, end_sec: 50 },
    { text: "fusion comes up now and then but solar and wind are what is being built", start_sec: 50, end_sec: 100 },
    { text: "and the batteries are what make the rest of it work at night", start_sec: 100, end_sec: 150 }
  ];

  function archiveOf(weeklies: number, talks: number) {
    const archive = [
      ...Array.from({ length: weeklies }, (_, i) => weekly(i)),
      ...Array.from({ length: talks }, (_, i) => talk(i))
    ];
    const cuesByGuid: Record<string, TranscriptCue[]> = Object.fromEntries(
      archive.map((e) => [e.guid, e.show_id === "fusion-weekly" ? weeklyCues : talkCues])
    );
    const bodies: TranscriptBodySource = {
      getCues: (entry) => cuesByGuid[entry.guid] ?? null,
      bodyStat: (entry) => (cuesByGuid[entry.guid] ? { mtimeMs: 1, size: 1 } : null)
    };
    const cueProvider: TranscriptCueProvider = { getCues: (entry) => cuesByGuid[entry.guid] ?? null };
    /* `cache: false`: nothing in a test may touch the disk cache. */
    return { textIndex: new FileTranscriptTextIndex({ archive, bodies, cache: false }), cueProvider };
  }

  async function fusionMap(quota: string | undefined, weeklies: number, talks: number) {
    if (quota === undefined) delete process.env[RESEARCH_SHOW_QUOTA_ENV];
    else process.env[RESEARCH_SHOW_QUOTA_ENV] = quota;
    const { guard } = guardAndSink();
    const shape = await buildResearchShape(makeIntent(), {
      researcher: new StubExternalResearcher(guard),
      ctx: { userId: "founder-1" },
      catalogue: tapeFixtureCatalogue(),
      topic: null,
      ...archiveOf(weeklies, talks)
    });
    return { shape, fusion: shape.subtopics.find((s) => s.label === "Fusion")! };
  }

  const showsOf = (windows: ResearchTapeWindow[]) => windows.map((w) => w.showTitle);
  const count = (xs: string[], x: string) => xs.filter((y) => y === x).length;

  afterEach(() => {
    delete process.env[RESEARCH_SHOW_QUOTA_ENV];
  });

  it("with the flag unset, the map is today's: the top six by score, no showId and no offeredShows key", async () => {
    /* MUTATION THAT KILLS THIS: set `showId` on every window regardless of the
       flag (drop the `deps.showQuota !== undefined` condition in
       `tapeWindowsForUntimed`). Ran it — red. */
    const { shape, fusion } = await fusionMap(undefined, 8, 4);
    expect(fusion.tapeWindows.length).toBe(RESEARCH_TAPE_WINDOWS_PER_SUBTOPIC);
    expect(showsOf(fusion.tapeWindows).every((s) => s === "Fusion Weekly")).toBe(true);
    const json = JSON.stringify(shape.subtopics);
    expect(json).not.toContain("showId");
    expect(json).not.toContain("offeredShows");
  });

  it("with quota 0.6 and two shows, no show contributes more than 4 of 6 windows when the other show has enough", async () => {
    /* MUTATION THAT KILLS THIS: keep `windows.slice(0, RESEARCH_TAPE_WINDOWS_PER_SUBTOPIC)`
       whatever the quota (ignore `deps.showQuota` at the cut). Ran it — red:
       six Fusion Weekly windows. */
    const { fusion } = await fusionMap("0.6", 8, 4);
    const shows = showsOf(fusion.tapeWindows);
    expect(shows.length).toBe(6);
    expect(count(shows, "Fusion Weekly")).toBe(4);
    expect(count(shows, "Energy Talk")).toBe(2);
    /* Rank order kept: the stronger show's windows still lead. */
    expect(fusion.tapeWindows.map((w) => w.showId)).toEqual([
      "fusion-weekly",
      "fusion-weekly",
      "fusion-weekly",
      "fusion-weekly",
      "energy-talk",
      "energy-talk"
    ]);
    expect(fusion.offeredShows).toEqual(["fusion-weekly", "energy-talk"]);
    expect(new Set(fusion.tapeWindows.map((w) => w.episodeId)).size).toBe(6);
  });

  it("backfills from the skipped windows when the other show runs out, so the quota never costs a window", async () => {
    /* MUTATION THAT KILLS THIS: drop the backfill loop in `selectWithShowQuota`.
       Ran it — red: 4 windows, not 6. */
    const { fusion } = await fusionMap("0.5", 8, 1);
    const shows = showsOf(fusion.tapeWindows);
    expect(shows.length).toBe(6);
    expect(count(shows, "Energy Talk")).toBe(1);
    expect(count(shows, "Fusion Weekly")).toBe(5);
  });

  it("spends only the kept windows: an episode the quota skipped under one subtopic is quoted under the next", async () => {
    /* MUTATION THAT KILLS THIS: spend every candidate window, not the kept ones
       (`for (const w of windows) usedEpisodes.add(w.episodeId)` in
       `tapeWindowsForUntimed`). Ran it — red: "Plasma" is left with no window,
       the Fusion Weekly episodes the quota skipped spent under "Fusion". */
    process.env[RESEARCH_SHOW_QUOTA_ENV] = "0.6";
    const base = tapeFixtureCatalogue();
    /* A second subtopic whose terms only Fusion Weekly speaks ("tokamak",
       "plasma"), walked after "Fusion". */
    const catalogue: CatalogueData = {
      ...base,
      itemTags: Object.fromEntries(base.items.map((it) => [it.id, ["fusion", "tokamak", "plasma"]])),
      concepts: { ...base.concepts, plasma: { terms: ["plasma", "tokamak"], topics: ["engineering/energy-fusion"], related: [] } }
    };
    const run = async () => {
      const { guard } = guardAndSink();
      return buildResearchShape(makeIntent(), {
        researcher: new StubExternalResearcher(guard),
        ctx: { userId: "founder-1" },
        catalogue,
        topic: null,
        ...archiveOf(8, 4)
      });
    };
    const shape = await run();
    const fusion = shape.subtopics.find((s) => s.label === "Fusion")!;
    const plasma = shape.subtopics.find((s) => s.label === "Plasma")!;
    expect(count(showsOf(fusion.tapeWindows), "Fusion Weekly")).toBe(4);
    /* The Fusion Weekly episodes "Fusion" ranked in its top six with no quota
       but dropped with it. */
    delete process.env[RESEARCH_SHOW_QUOTA_ENV];
    const unquotedTop = (await run()).subtopics.find((s) => s.label === "Fusion")!.tapeWindows.map((w) => w.episodeId);
    const kept = new Set(fusion.tapeWindows.map((w) => w.episodeId));
    const skipped = unquotedTop.filter((id) => !kept.has(id));
    expect(skipped.length).toBe(2);
    const plasmaIds = plasma.tapeWindows.map((w) => w.episodeId);
    for (const id of skipped) expect(plasmaIds).toContain(id);
    /* And still one window per episode across the map (G-24 R3). */
    const all = shape.subtopics.flatMap((s) => s.tapeWindows.map((w) => w.episodeId));
    expect(new Set(all).size).toBe(all.length);
  });

  it("with one show, the quota changes nothing", async () => {
    const off = await fusionMap(undefined, 8, 0);
    const on = await fusionMap("0.6", 8, 0);
    expect(on.fusion.tapeWindows.map((w) => ({ ...w, showId: undefined }))).toEqual(off.fusion.tapeWindows);
    expect(on.fusion.tapeWindows.every((w) => w.showId === "fusion-weekly")).toBe(true);
    expect(on.fusion.offeredShows).toEqual(["fusion-weekly"]);
  });

  it("a checkpointed research shape round-trips showId and offeredShows", async () => {
    /* MUTATIONS THAT KILL THIS: remove `showId` from `ResearchTapeWindowSchema`,
       or `offeredShows` from `SubtopicCandidateSchema` (zod strips unknown keys
       on the reload). Ran both — red. */
    const { shape } = await fusionMap("0.6", 8, 4);
    const reloaded = ResearchShapeSchema.parse(JSON.parse(JSON.stringify(shape)));
    expect(reloaded).toEqual(shape);
    const fusion = reloaded.subtopics.find((s) => s.label === "Fusion")!;
    expect(fusion.tapeWindows.some((w) => w.showId === "energy-talk")).toBe(true);
    expect(fusion.offeredShows).toEqual(["fusion-weekly", "energy-talk"]);
    /* And a checkpoint written before GV-87 still parses, with neither field. */
    const before = ResearchShapeSchema.parse(JSON.parse(JSON.stringify((await fusionMap(undefined, 8, 4)).shape)));
    expect(before.subtopics.every((s) => s.offeredShows === undefined)).toBe(true);
  });

  it("selectWithShowQuota: greedy in rank order, then backfill, keeping rank order", () => {
    const w = (episodeId: string, showId: string) => ({ episodeId, showId });
    const ranked = [w("a1", "A"), w("a2", "A"), w("a3", "A"), w("b1", "B"), w("a4", "A"), w("c1", "C")];
    expect(selectWithShowQuota(ranked, { max: 4, perShowMax: 2 }).map((x) => x.episodeId)).toEqual(["a1", "a2", "b1", "c1"]);
    expect(selectWithShowQuota(ranked, { max: 5, perShowMax: 1 }).map((x) => x.episodeId)).toEqual(["a1", "a2", "a3", "b1", "c1"]);
    const oneShow = [w("a1", "A"), w("a2", "A"), w("a3", "A")];
    expect(selectWithShowQuota(oneShow, { max: 2, perShowMax: 1 })).toEqual(oneShow.slice(0, 2));
  });

  it("reads FORAY_RESEARCH_SHOW_QUOTA at call time: unset is off, (0, 1] is a share, anything else throws naming the variable", () => {
    /* MUTATION THAT KILLS THIS: accept 0 (`value >= 0`) in the parser. Ran it — red. */
    expect(researchShowQuota({})).toBeUndefined();
    expect(researchShowQuota({ [RESEARCH_SHOW_QUOTA_ENV]: "0.6" })).toBe(0.6);
    expect(researchShowQuota({ [RESEARCH_SHOW_QUOTA_ENV]: " 1 " })).toBe(1);
    for (const bad of ["0", "-0.5", "1.5", "lots", "", "Infinity"]) {
      expect(() => researchShowQuota({ [RESEARCH_SHOW_QUOTA_ENV]: bad })).toThrow(FlagValueError);
      expect(() => researchShowQuota({ [RESEARCH_SHOW_QUOTA_ENV]: bad })).toThrow(RESEARCH_SHOW_QUOTA_ENV);
    }
    /* The offending value is never part of the message. */
    expect(() => researchShowQuota({ [RESEARCH_SHOW_QUOTA_ENV]: "lots" })).not.toThrow(/lots/);
  });
});

describe("GV-95: research-shape asks every search ahead of the first (prepareQueries), and a search the retrieval server never answered says so", () => {
  const show = (n: number): TranscriptDigestEntry => ({
    show_id: "show-a",
    show_title: "Show A",
    guid: `sa-${n}`,
    title: `Episode ${n}`,
    cues: 3,
    feed_duration_sec: 3600
  });
  const cues: TranscriptCue[] = [
    { text: "fusion in a tokamak is the whole show today and the tokamak is the hard part", start_sec: 0, end_sec: 50 },
    { text: "fusion reactors need the tokamak to hold the plasma long enough for fusion to pay", start_sec: 50, end_sec: 100 },
    { text: "so every tokamak group measures fusion gain before anything else", start_sec: 100, end_sec: 150 }
  ];
  const archive = [show(1), show(2), show(3)];
  const bodies: TranscriptBodySource = { getCues: () => cues, bodyStat: () => ({ mtimeMs: 1, size: 1 }) };

  /** Every search, as the retrieval client would key it. */
  function recordingIndex(events: string[]) {
    const inner = new FileTranscriptTextIndex({ archive, bodies, cache: false });
    const searched: Array<{ scope: "lineage" | "all"; text: string; limit: number }> = [];
    const index: TranscriptTextIndex = {
      enabled: true,
      search: (q, o = {}) => {
        events.push("search");
        searched.push({ scope: o.isUsable ? "lineage" : "all", text: q, limit: o.limit ?? 8 });
        return inner.search(q, o);
      }
    };
    return { index, searched };
  }

  it("prepares exactly the (scope, text, limit) the subject probe and the subtopic searches then ask, once, before the first of them, with the strings of the exported helpers", async () => {
    /* MUTATION THAT KILLS THIS: prepare a subtopic by `seed.label` alone
       instead of subtopicQueryText(seed) (the prepared list no longer equals
       the searched one). Ran it: red. */
    const events: string[] = [];
    const { index, searched } = recordingIndex(events);
    const prepared: ResearchSearchRequest[] = [];
    const { guard } = guardAndSink();
    const shape = await buildResearchShape(makeIntent(), {
      researcher: new StubExternalResearcher(guard),
      ctx: { userId: "founder-1" },
      catalogue: tapeFixtureCatalogue(),
      topic: null,
      prompt: "tell me how fusion works",
      textIndex: index,
      cueProvider: { getCues: () => cues },
      prepareQueries: async (requests) => {
        events.push("prepare");
        prepared.push(...requests);
      }
    });
    expect(events[0]).toBe("prepare");
    expect(events.filter((e) => e === "prepare")).toHaveLength(1);
    expect(prepared).toEqual(searched);
    expect(prepared[0]).toEqual({ scope: "all", text: subjectProbeQuery("tell me how fusion works", makeIntent()), limit: SUBJECT_PROBE_LIMIT });
    expect(prepared).toContainEqual({ scope: "lineage", text: subtopicQueryText({ label: "Fusion", terms: ["fusion", "tokamak"] }), limit: 12 });
    /* The helpers are the strings the stage always used. */
    expect(subjectProbeQuery(undefined, { subject: "s", angle: "a" })).toBe(" s a");
    expect(subtopicQueryText({ label: "Fusion", terms: ["fusion", "tokamak"] })).toBe("Fusion fusion tokamak");
    /* Not vacuous: the prepared searches found tape. */
    expect(shape.subtopics.find((s) => s.label === "Fusion")!.tapeWindows.length).toBeGreaterThan(0);
  });

  it("without prepareQueries the map is the same, and with a disabled index the callback is never called", async () => {
    /* MUTATION THAT KILLS THIS: call prepareQueries even when the index is
       disabled. Ran it: red. */
    const { guard } = guardAndSink();
    const base = { researcher: new StubExternalResearcher(guard), ctx: { userId: "founder-1" }, catalogue: tapeFixtureCatalogue(), topic: null, cueProvider: { getCues: () => cues } };
    const plain = await buildResearchShape(makeIntent(), { ...base, textIndex: new FileTranscriptTextIndex({ archive, bodies, cache: false }) });
    const prepared = await buildResearchShape(makeIntent(), {
      ...base,
      textIndex: new FileTranscriptTextIndex({ archive, bodies, cache: false }),
      prepareQueries: async () => undefined
    });
    expect({ ...prepared, generatedAt: "" }).toEqual({ ...plain, generatedAt: "" });
    let called = 0;
    await buildResearchShape(makeIntent(), {
      ...base,
      prepareQueries: async () => {
        called += 1;
      }
    });
    expect(called).toBe(0);
  });

  it("a probe the retrieval server never answered is not searched and refuses nothing; a subtopic it never answered gives that reason", async () => {
    /* GV-29 review (#1286 wave 5): `enabled` is true on every search, so a
       miss used to read as a corpus that says nothing, and refused the map.
       The index here is the real PrecomputedTextIndex over a server that
       refuses every request (an injected fetch; no network).
       MUTATION THAT KILLS THIS: drop the indexAnswers check in
       probeSubjectTape (the map is refused). Ran it: red. */
    const retrieval = new RemoteRetrieval({
      baseUrl: "http://127.0.0.1:1",
      archive,
      fetchFn: async () => {
        throw new TypeError("fetch failed");
      }
    });
    expect(await retrieval.prepareScope(null)).toBe(false);
    const { guard } = guardAndSink();
    const shape = await buildResearchShape(makeIntent(), {
      researcher: new StubExternalResearcher(guard),
      ctx: { userId: "founder-1" },
      catalogue: tapeFixtureCatalogue(),
      topic: null,
      textIndex: new PrecomputedTextIndex(retrieval),
      cueProvider: new HydratingCueProvider(retrieval)
    });
    expect(shape.subjectTape).toEqual({ query: subjectProbeQuery(undefined, makeIntent()), episodesMatched: 0, shows: [], searched: false });
    expect(shape.subtopics.find((s) => s.label === "Fusion")!.windowsUnavailable).toMatch(/did not answer this subtopic's search/);
    /* No search was made on a miss: nothing counted as one. */
    expect(retrieval.stats()).toMatchObject({ hits: 0, misses: 0 });
  });
});
