import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { SourceBeatsOptions, ShowShareOptions } from "../src/generation/sourceBeats";
import { runForayPipeline } from "../src/generation/runPipeline";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import { resetTaxonomyCache } from "../src/generation/resolveTopic";
import { resetTaxonomyFamilyCache } from "../src/generation/taxonomyFamily";

/**
 * GV-115 (orchestrator, #1483 governed review): the `supplyShows` that
 * actually REACHES sourcing, not the line runPipeline prints. The rule is
 * inert under two supplying shows (`activeShowShare`), so a one-show topic
 * must hand sourcing `supplyShows: 1`; runPipeline.test.ts reads only the
 * console line, which is printed before the value is returned. Here
 * sourceBeats and SourcingSession are wrapped (pass-through) to capture the
 * options runPipeline builds, on the classic `source` and the per-act
 * `source:<i>`.
 *
 * MUTATION THAT KILLS THIS: in runPipeline.ts `showShareOptionsFor`, return
 * `{ ...rule, supplyShows: 2 }` instead of the counted shows — the one-show
 * run hands sourcing 2 and the rule would gate a topic only one show can
 * supply.
 */
const { captured } = vi.hoisted(() => ({ captured: [] as Array<ShowShareOptions | undefined> }));

vi.mock("../src/generation/sourceBeats", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/generation/sourceBeats")>();
  class CapturingSession extends actual.SourcingSession {
    constructor(options: SourceBeatsOptions = {}) {
      captured.push(options.showShare);
      super(options);
    }
  }
  return {
    ...actual,
    SourcingSession: CapturingSession,
    sourceBeats: (acts: Parameters<typeof actual.sourceBeats>[0], options: SourceBeatsOptions = {}) => {
      captured.push(options.showShare);
      return actual.sourceBeats(acts, options);
    }
  };
});

const REAL_DATA = join(__dirname, "..", "..", "data");
const ENV = "FORAY_SHOW_SHARE";
const roots: string[] = [];

function fixtureRoot(showIds: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "gv115-plumbing-"));
  mkdirSync(join(root, "data"));
  copyFileSync(join(REAL_DATA, "taxonomy.json"), join(root, "data", "taxonomy.json"));
  copyFileSync(join(REAL_DATA, "semantic-index.json"), join(root, "data", "semantic-index.json"));
  writeFileSync(
    join(root, "data", "catalog.json"),
    JSON.stringify({ shows: showIds.map((show_id) => ({ show_id, title: show_id, taxonomy_node_ids: ["food/grilling-bbq"] })) })
  );
  roots.push(root);
  return root;
}

const episodes = (showId: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ show_id: showId, show_title: showId, guid: `${showId}-${i + 1}`, title: `${showId} episode ${i + 1}`, cues: 100 }));

const finalize = async () =>
  ({
    validation: { ok: true, checkForaysErrors: [], checkForaysWarnings: [], checkNarrationErrors: [], checkNarrationWarnings: [] },
    forayRecord: { generated: true },
    timings: []
  }) as never;

async function showShareReaching(value: string, shows: string[], flags: { perActPipeline?: boolean }): Promise<Array<ShowShareOptions | undefined>> {
  captured.length = 0;
  /* taxonomyFamily caches the catalogue's show nodes per process, not per
     root; each run here has its own fixture root. */
  resetTaxonomyCache();
  resetTaxonomyFamilyCache();
  const prior = process.env[ENV];
  process.env[ENV] = value;
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await runForayPipeline(
      { prompt: "the history of grilling and barbecue", duration: "short", author_id: "founder-1", visibility: "catalogue" },
      { userId: "founder-1", now: () => new Date("2026-09-05T12:00:00.000Z"), root: fixtureRoot(shows), topic: "food/grilling-bbq", flags },
      {
        understander: new StubPromptUnderstander(),
        researcher: new StubExternalResearcher(),
        spineBuilder: new StubSpineBuilder(),
        deepenBuilder: new StubDeepenActBuilder(),
        narrationWriter: new StubNarrationWriterBuilder(),
        narrationVerifier: new StubNarrationVerifierBuilder(),
        continuityBuilder: new StubContinuityBuilder(),
        finalize,
        transcriptArchive: shows.flatMap((s) => episodes(s, 4)),
        segmentPool: []
      }
    );
    return [...captured];
  } finally {
    log.mockRestore();
    if (prior === undefined) delete process.env[ENV];
    else process.env[ENV] = prior;
  }
}

beforeEach(() => {
  resetTaxonomyCache();
  resetTaxonomyFamilyCache();
});

afterEach(() => {
  resetTaxonomyCache();
  resetTaxonomyFamilyCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runForayPipeline — the show-share rule sourcing receives (GV-115)", () => {
  it("a one-show topic hands sourcing supplyShows 1 (inert) and a two-show topic 2, on the classic and per-act paths", async () => {
    for (const flags of [{}, { perActPipeline: true }]) {
      const one = await showShareReaching("gate", ["grill-a"], flags);
      expect(one.length).toBeGreaterThan(0);
      for (const rule of one) expect(rule).toEqual({ mode: "gate", max: 0.6, supplyShows: 1 });
      const two = await showShareReaching("gate", ["grill-a", "grill-b"], flags);
      expect(two.length).toBeGreaterThan(0);
      for (const rule of two) expect(rule).toEqual({ mode: "gate", max: 0.6, supplyShows: 2 });
    }
  }, 120_000);
});
