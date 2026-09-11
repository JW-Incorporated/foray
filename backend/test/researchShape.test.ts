import { describe, it, expect } from "vitest";
import {
  buildResearchShape,
  tapeSignalFor,
  RESEARCH_TAPE_WINDOWS_PER_SUBTOPIC,
  RESEARCH_TAPE_WINDOW_MAX_CHARS,
  RESEARCH_TAPE_WINDOW_MAX_SEC,
  RESEARCH_TAPE_WINDOW_MIN_SEC
} from "../src/generation/researchShape";
import { D3_MEAN_FLOOR_SEC } from "../src/generation/sourceBeats";
import { TAPE_WINDOW_MAX_SEC, TAPE_WINDOW_MIN_SEC, cueWindowText, selectTapeWindow } from "../src/generation/transcriptArchiveLookup";
import { tokenizeForSourcing } from "../src/generation/catalogueLookup";
import type { ResearchTapeWindow } from "../src/types/research";
import { FileTranscriptTextIndex } from "../src/generation/transcriptTextIndex";
import type { TranscriptBodySource, TranscriptTextIndex } from "../src/generation/transcriptTextIndex";
import type { TranscriptCue, TranscriptCueProvider, TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";
import { loadCatalogueData, type CatalogueData } from "../src/generation/catalogueLookup";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
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

  it("sizes its window band for the duration rules the finished Foray is judged by (F-73)", () => {
    /* A window quoted here is not only read. §4.3 seeds a beat with this
       episode AND these seconds, and F-68 then confines §4.5's search to exactly
       this stretch — so this band is, in practice, the band every generated tape
       segment is cut from. At 60-120 s it put every one of them under
       `narration-craft.md` §0's 90 s mean floor by construction, which is what
       refused run 2 attempt 5's act-1 candidate at a 76.1 s mean.

       MUTATION THAT KILLS THIS: put `RESEARCH_TAPE_WINDOW_MIN_SEC` back to 60.
       Ran it — red. */
    expect(RESEARCH_TAPE_WINDOW_MIN_SEC).toBeGreaterThanOrEqual(D3_MEAN_FLOOR_SEC);
    /* And still inside §4.5's own band, both ends: a research window that could
       not be a segment would be quoting the spine tape it cannot have. */
    expect(RESEARCH_TAPE_WINDOW_MIN_SEC).toBeGreaterThanOrEqual(TAPE_WINDOW_MIN_SEC);
    expect(RESEARCH_TAPE_WINDOW_MAX_SEC).toBeLessThanOrEqual(TAPE_WINDOW_MAX_SEC);
    expect(RESEARCH_TAPE_WINDOW_MAX_SEC).toBeGreaterThan(RESEARCH_TAPE_WINDOW_MIN_SEC);
  });

  it("quotes a stretch long enough to be cut into a segment the D-tier rules accept (F-73)", async () => {
    /* The band above, measured on a real window rather than asserted about the
       constants: the fixture's tape yields a window over the mean floor. */
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
    expect(window.endSec - window.startSec).toBeGreaterThanOrEqual(D3_MEAN_FLOOR_SEC);
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
