import { afterAll, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CUE_CACHE_MAX_ENTRIES, FileTranscriptCueProvider, type TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";
import { FileTranscriptTextIndex } from "../src/generation/transcriptTextIndex";
import { loadTaxonomyNodes, resetTaxonomyCache } from "../src/generation/resolveTopic";
import { runForayPipeline } from "../src/generation/runPipeline";
import { loadSegmentPool } from "../src/generation/segmentPoolLookup";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import type { FinalizeForayInput, FinalizeForayResult } from "../src/generation/finalizeForay";

/**
 * Round-3 audit gen-15: caches that grew for the life of a batch process, or
 * answered for a root other than the one asked about.
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gen15-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("gen-15: the transcript cue cache is bounded, and an index rebuild does not fill it", () => {
  const root = path.join(tmp, "normalized");
  const dir = path.join(root, "big-show");
  fs.mkdirSync(dir, { recursive: true });
  const entries: TranscriptDigestEntry[] = [];
  const COUNT = CUE_CACHE_MAX_ENTRIES + 44;
  for (let i = 0; i < COUNT; i++) {
    const guid = `ep${i}`;
    fs.writeFileSync(path.join(dir, `${guid}.json`), JSON.stringify({ guid, cues: [{ text: `episode ${i} talks about kilns and charcoal`, start_sec: 0, end_sec: 5 }] }));
    entries.push({ show_id: "big-show", show_title: "Big Show", guid, title: `Episode ${i}`, cues: 1 });
  }

  it("holds at most CUE_CACHE_MAX_ENTRIES parsed cue arrays, evicting the least recently used", () => {
    /* MUTATION THAT KILLS THIS: drop the eviction loop — the map holds all 300. */
    const provider = new FileTranscriptCueProvider(root);
    for (const entry of entries) provider.getCues(entry);
    expect(provider.cachedCueCount()).toBe(CUE_CACHE_MAX_ENTRIES);
    // the most recent is still served
    expect(provider.getCues(entries[COUNT - 1]!)?.[0]?.text).toContain(`episode ${COUNT - 1}`);
  });

  it("a text-index build reads every body without pinning them in the provider's cache", () => {
    /* MUTATION THAT KILLS THIS: build through `getCues` again — the cache
       fills to its bound during the rebuild. */
    const provider = new FileTranscriptCueProvider(root);
    const index = new FileTranscriptTextIndex({ archive: entries, bodies: provider, cache: false });
    const hits = index.search("kilns charcoal");
    expect(hits.length).toBeGreaterThan(0);
    expect(provider.cachedCueCount()).toBe(0);
  });
});

describe("gen-15: taxonomy caches are keyed by root and honour FORAY_SKIP_CATALOGUE_CACHE", () => {
  const rootWith = (label: string): string => {
    const r = path.join(tmp, `root-${label}`);
    fs.mkdirSync(path.join(r, "data"), { recursive: true });
    fs.writeFileSync(path.join(r, "data", "taxonomy.json"), JSON.stringify({ nodes: [{ id: `node/${label}`, label, parent: null }] }));
    return r;
  };
  afterEach(() => {
    resetTaxonomyCache();
    delete process.env.FORAY_SKIP_CATALOGUE_CACHE;
  });

  it("a second root gets its own nodes, not the first root's", () => {
    /* MUTATION THAT KILLS THIS: return `cachedNodes` whatever the root. */
    const a = rootWith("a");
    const b = rootWith("b");
    expect(loadTaxonomyNodes(a).map((n) => n.id)).toEqual(["node/a"]);
    expect(loadTaxonomyNodes(b).map((n) => n.id)).toEqual(["node/b"]);
  });

  it("FORAY_SKIP_CATALOGUE_CACHE=1 re-reads the file", () => {
    const c = rootWith("c");
    expect(loadTaxonomyNodes(c).map((n) => n.id)).toEqual(["node/c"]);
    fs.writeFileSync(path.join(c, "data", "taxonomy.json"), JSON.stringify({ nodes: [{ id: "node/c2", label: "c2", parent: null }] }));
    expect(loadTaxonomyNodes(c).map((n) => n.id)).toEqual(["node/c"]);
    process.env.FORAY_SKIP_CATALOGUE_CACHE = "1";
    expect(loadTaxonomyNodes(c).map((n) => n.id)).toEqual(["node/c2"]);
  });
});

describe("gen-15: runtime is measured on the pool the run sourced against", () => {
  it("an injected segment pool, not a fresh read of the repo root's, times the Foray's segments", async () => {
    /* MUTATION THAT KILLS THIS: build runtimePool from loadSegmentPool()
       again — the stretched rows are ignored and both runs time the same. */
    const finalize = async (input: FinalizeForayInput): Promise<FinalizeForayResult> =>
      ({
        validation: { ok: true, checkForaysErrors: [], checkForaysWarnings: [], checkNarrationErrors: [], checkNarrationWarnings: [] },
        forayRecord: { id: input.id, generated: true },
        timings: []
      }) as unknown as FinalizeForayResult;
    const deps = () => ({
      understander: new StubPromptUnderstander(),
      researcher: new StubExternalResearcher(),
      spineBuilder: new StubSpineBuilder(),
      deepenBuilder: new StubDeepenActBuilder(),
      narrationWriter: new StubNarrationWriterBuilder(),
      narrationVerifier: new StubNarrationVerifierBuilder(),
      continuityBuilder: new StubContinuityBuilder(),
      finalize
    });
    const request = { prompt: "the history of grilling and barbecue", duration: "short" as const, author_id: "founder-1", visibility: "catalogue" as const };
    const options = { userId: "founder-1", now: () => new Date("2026-09-05T12:00:00.000Z"), topic: "food/grilling-bbq" };
    const pool = loadSegmentPool();
    const stretched = pool.map((row) => ({ ...row, end_sec: row.end_sec + 100 }));
    const plain = await runForayPipeline(request, options, { ...deps(), segmentPool: pool });
    const long = await runForayPipeline(request, options, { ...deps(), segmentPool: stretched });
    if (plain.outcome !== "generated" || long.outcome !== "generated") throw new Error("fixture: expected generated Forays");
    const segments = plain.input.items.filter((i) => i.type === "segment").length;
    expect(segments).toBeGreaterThan(0);
    expect(long.input.runtimeSec - plain.input.runtimeSec).toBeCloseTo(100 * segments, 3);
  });
});
