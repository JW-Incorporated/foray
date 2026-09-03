import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { finalizeForay, type FinalizeForayInput } from "../src/generation/finalizeForay";
import { disclosureNarratedBeat } from "../src/types/narration";
import type { ForayItem } from "../src/generation/forayItems";

/**
 * §4.9 end to end (kanban card t_0b1729d6): finalizeForay() validates a
 * candidate against the REAL `check-forays.mjs`/`check-narration.mjs`
 * (never a reimplementation — see that module's own doc comment) and
 * only returns a writable record on a clean pass.
 *
 * FIXTURE: `tools/foray/fixtures/boundary/data` — the #236 boundary
 * fixture already committed for `check-forays.test.mjs`'s own D1/D5
 * proofs. Reused here READ-ONLY (finalizeForay never writes) rather than
 * duplicating segment/source/taxonomy data a third time. The full
 * 30-item `boundary-1` running order (that fixture's own `forays.json`)
 * is reused verbatim for the passing-candidate tests, since it is
 * already tuned to sit inside every tier-A budget (D1/D3/D4/D5/M3/M4) —
 * hand-picking a subset was tried and kept tripping M4 (episode-share
 * cap), which is exactly the kind of boundary this fixture exists to
 * get right once rather than everywhere it's reused.
 */

const FIXTURE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "foray", "fixtures", "boundary");

const disclosure = disclosureNarratedBeat("a finalize-stage test topic");

const tapeItems: ForayItem[] = [
  { type: "segment", slot: "one", label: "A-1", segment_id: "boundary-ep-a#200", role: "explanation" },
  { type: "segment", slot: "one", label: "B-1", segment_id: "boundary-ep-b#200", role: "exchange" },
  { type: "segment", slot: "one", label: "C-1", segment_id: "boundary-ep-c#200", role: "explanation" },
  { type: "segment", slot: "one", label: "D-1", segment_id: "boundary-ep-d#200", role: "narrative" },
  { type: "segment", slot: "one", label: "E-1", segment_id: "boundary-ep-e#200", role: "explanation" },
  { type: "segment", slot: "one", label: "F-1", segment_id: "boundary-ep-f#200", role: "explanation" },
  { type: "segment", slot: "one", label: "B-2", segment_id: "boundary-ep-b#700", role: "explanation" },
  { type: "segment", slot: "one", label: "C-2", segment_id: "boundary-ep-c#700", role: "exchange" },
  { type: "segment", slot: "one", label: "D-2", segment_id: "boundary-ep-d#700", role: "explanation" },
  { type: "segment", slot: "one", label: "E-2", segment_id: "boundary-ep-e#700", role: "narrative" },
  { type: "segment", slot: "two", label: "F-2", segment_id: "boundary-ep-f#700", role: "explanation" },
  { type: "segment", slot: "two", label: "A-2", segment_id: "boundary-ep-a#700", role: "explanation" },
  { type: "segment", slot: "two", label: "C-3", segment_id: "boundary-ep-c#1200", role: "explanation" },
  { type: "segment", slot: "two", label: "D-3", segment_id: "boundary-ep-d#1200", role: "exchange" },
  { type: "segment", slot: "two", label: "E-3", segment_id: "boundary-ep-e#1200", role: "explanation" },
  { type: "segment", slot: "two", label: "F-3", segment_id: "boundary-ep-f#1200", role: "narrative" },
  { type: "segment", slot: "two", label: "A-3", segment_id: "boundary-ep-a#1200", role: "explanation" },
  { type: "segment", slot: "two", label: "B-3", segment_id: "boundary-ep-b#1200", role: "explanation" },
  { type: "segment", slot: "two", label: "D-4", segment_id: "boundary-ep-d#1700", role: "explanation" },
  { type: "segment", slot: "two", label: "E-4", segment_id: "boundary-ep-e#1700", role: "exchange" },
  { type: "segment", slot: "three", label: "F-4", segment_id: "boundary-ep-f#1700", role: "explanation" },
  { type: "segment", slot: "three", label: "A-4", segment_id: "boundary-ep-a#1700", role: "narrative" },
  { type: "segment", slot: "three", label: "B-4", segment_id: "boundary-ep-b#1700", role: "explanation" },
  { type: "segment", slot: "three", label: "C-4", segment_id: "boundary-ep-c#1700", role: "explanation" },
  { type: "segment", slot: "three", label: "E-5", segment_id: "boundary-ep-e#2200", role: "explanation" },
  { type: "segment", slot: "three", label: "F-5", segment_id: "boundary-ep-f#2200", role: "exchange" },
  { type: "segment", slot: "three", label: "A-5", segment_id: "boundary-ep-a#2200", role: "explanation" },
  { type: "segment", slot: "three", label: "B-5", segment_id: "boundary-ep-b#2200", role: "narrative" },
  { type: "segment", slot: "three", label: "C-5", segment_id: "boundary-ep-c#2200", role: "quote" },
  { type: "segment", slot: "three", label: "D-5", segment_id: "boundary-ep-d#2200", role: "explanation" }
];
const TAPE_RUNTIME_SEC = 3121; // boundary-1's own committed runtime_sec

function validCandidate(id = "finalize-test-1"): FinalizeForayInput {
  return {
    id,
    title: "A finalize-stage test Foray",
    topic: "fixture/boundary",
    summary: "A short test summary under the copy word limit.",
    slots: [
      { id: "one", title: "The first block" },
      { id: "two", title: "The second block" },
      { id: "three", title: "The third block" }
    ],
    items: [
      { type: "narration", id: "disclosure", script: disclosure.script, mode: "marker", slot: "one" },
      ...tapeItems
    ],
    runtimeSec: TAPE_RUNTIME_SEC + disclosure.script.length / 17
  };
}

describe("finalizeForay — §4.9 validate-then-write", () => {
  it("passes a well-formed candidate and returns a writable, generated:true record", async () => {
    const result = await finalizeForay(validCandidate(), FIXTURE_ROOT);

    expect(result.validation.ok).toBe(true);
    expect(result.validation.checkForaysErrors).toEqual([]);
    expect(result.forayRecord).toBeDefined();
    expect(result.forayRecord?.generated).toBe(true);
    expect(result.forayRecord?.id).toBe("finalize-test-1");
    expect(result.forayRecord?.status).toBe("draft");
    // Real per-stage timings recorded, not placeholders (§6.3's minimal
    // scope — see stageTiming.test.ts for the primitive's own proof).
    expect(result.timings.map((t) => t.name)).toEqual(["build-record", "check-forays", "check-narration"]);
    for (const t of result.timings) expect(t.ms).toBeGreaterThanOrEqual(0);
  });

  it("fails a candidate missing the disclosure as items[0], and writes nothing", async () => {
    const candidate = validCandidate("finalize-test-2");
    candidate.items = tapeItems; // disclosure dropped
    const result = await finalizeForay(candidate, FIXTURE_ROOT);

    expect(result.validation.ok).toBe(false);
    expect(result.forayRecord).toBeUndefined();
    expect(result.validation.checkForaysErrors.some((e) => e.toLowerCase().includes("disclosure"))).toBe(true);
  });

  it("fails a candidate whose runtime_sec disagrees with its items' actual sum", async () => {
    const candidate = validCandidate("finalize-test-3");
    candidate.runtimeSec = 1; // wildly wrong
    const result = await finalizeForay(candidate, FIXTURE_ROOT);

    expect(result.validation.ok).toBe(false);
    expect(result.validation.checkForaysErrors.some((e) => e.includes("runtime_sec"))).toBe(true);
  });

  it("refuses an id that already exists in the live forays.json, before running any check", async () => {
    const candidate = validCandidate("boundary-1"); // already in the fixture
    await expect(finalizeForay(candidate, FIXTURE_ROOT)).rejects.toThrow(/already exists/);
  });

  it("reports check-narration's findings too (curation-artifact scope, see module doc comment)", async () => {
    const result = await finalizeForay(validCandidate("finalize-test-4"), FIXTURE_ROOT);
    // The boundary fixture has no docs/curation/narration/ directory, so
    // check-narration.mjs can only warn "no narration artifacts", never
    // error — proving the call genuinely happens and its result reaches
    // the caller, without this test overclaiming what it audits.
    expect(result.validation.checkNarrationErrors).toEqual([]);
  });
});
