import { describe, it, expect } from "vitest";
import { computeActVeracity } from "../src/generation/veracityMetrics";
import { HANDOFF_MODE, HANDOFF_SCRIPT, type WrittenAct, type WrittenBeat } from "../src/generation/writeNarration";
import { assessAct, provenanceFor } from "../src/generation/itemReadiness";
import { stitchAct } from "../src/generation/stitchAct";
import type { NarratedBeat, Source } from "../src/types/narration";

/**
 * GV-21 (docs/roadmap/generation-v2.md; W5-12a): the per-act veracity gate.
 * `computeActVeracity` judges ONE act on the publish gate's two page-level
 * conditions — no unverified page, a grounded-quote rate of 1 where one is
 * measurable — and counts the HANDOFF fallback as both unverified and a
 * hand-off. The partial path withholds an act that fails it; the run is
 * never stopped by it. Fixtures are hand-built `WrittenAct`s, offline.
 */

function source(overrides: Partial<Source> = {}): Source {
  return { claimText: "claim", quote: "quote text", publication: "Pub", contested: false, ...overrides };
}

function page(overrides: Partial<NarratedBeat> = {}): NarratedBeat {
  return { mode: "Patch", script: "x".repeat(400), sources: [source()], pronunciationHints: [], verified: true, ...overrides };
}

const handoff = (): NarratedBeat => ({
  mode: HANDOFF_MODE,
  script: HANDOFF_SCRIPT,
  sources: [],
  pronunciationHints: [],
  verified: false,
  unverifiedReason: "no-page",
  verifierNotes: "no page was produced"
});

function beat(claim: string, narration: NarratedBeat): WrittenBeat {
  return { sourcing: "narration", claim, exploration: false, narration };
}

function act(beats: WrittenBeat[]): WrittenAct {
  return { title: "Act", slots: [{ title: "Slot", beats }] };
}

describe("computeActVeracity", () => {
  it("counts a HANDOFF page as both unverified and a hand-off, and the act is not ok", () => {
    /* MUTATION THAT KILLS THIS: drop the hand-off count (handoffPages
       never incremented). handoffPages reads 0. Ran it — red. */
    const v = computeActVeracity(act([beat("b1", page()), beat("b2", handoff())]), 0);
    expect(v.unverifiedPages).toHaveLength(1);
    expect(v.handoffPages).toBe(1);
    expect(v.ok).toBe(false);
    expect(v.failures.join("\n")).toMatch(/hand-off/);
  });

  it("counts a no-page page as a hand-off even when its script is not the template", () => {
    /* MUTATION THAT KILLS THIS: drop the `unverifiedReason === "no-page"`
       half of the hand-off test. handoffPages reads 0. Ran it — red. */
    const v = computeActVeracity(act([beat("b1", { ...handoff(), script: "Keep listening — the next part picks it up." })]), 2);
    expect(v.handoffPages).toBe(1);
    expect(v.actIndex).toBe(2);
    expect(v.ok).toBe(false);
  });

  it("an unverified page that is not a hand-off fails the act without counting as one", () => {
    const v = computeActVeracity(act([beat("b1", page({ verified: false, verifierNotes: "unsupported" }))]), 0);
    expect(v.unverifiedPages).toHaveLength(1);
    expect(v.handoffPages).toBe(0);
    expect(v.ok).toBe(false);
  });

  it("fails an act whose grounded-quote rate is below 1, and passes an unmeasured (null) one", () => {
    /* MUTATION THAT KILLS THIS: drop the groundedQuoteRate condition from
       computeActVeracity. The fabricated-quote act reads ok. Ran it — red. */
    const fabricated = page({
      sources: [source({ quote: "welding crews reinforced the joints at night" })],
      evidence: [{ docId: "d1", title: "T", text: "Nothing in this document mentions welding at all." }]
    });
    const bad = computeActVeracity(act([beat("b1", fabricated)]), 0);
    expect(bad.groundedQuoteRate).toBe(0);
    expect(bad.ok).toBe(false);
    expect(bad.failures.join("\n")).toMatch(/groundedQuoteRate/);

    const unmeasured = computeActVeracity(act([beat("b1", page())]), 0);
    expect(unmeasured.groundedQuoteRate).toBe(null);
    expect(unmeasured).toMatchObject({ unverifiedPages: [], handoffPages: 0, ok: true, failures: [] });
  });

  it("judges only the act it is handed", () => {
    const clean = computeActVeracity(act([beat("b1", page())]), 1);
    const dirty = computeActVeracity(act([beat("b1", handoff())]), 0);
    expect(clean.ok).toBe(true);
    expect(dirty.ok).toBe(false);
  });

  it("feeds assessAct: the hand-off act is unservable, and so is an ungrounded one whose pages all passed", () => {
    /* MUTATION THAT KILLS THIS: stop passing veracity into assessAct's
       verdict (ignore its third argument). The ungrounded-but-verified act
       comes back servable. Ran it — red. */
    const handoffAct = act([beat("b1", page()), beat("b2", handoff())]);
    const handoffVerdict = assessAct(provenanceFor(stitchAct(handoffAct, "act-1").items, 0, 1), undefined, computeActVeracity(handoffAct, 0));
    expect(handoffVerdict.servable).toBe(false);
    expect(handoffVerdict.blockers.map((b) => b.reason)).toContain("unverified");

    const ungrounded = act([
      beat(
        "b1",
        page({
          sources: [source({ quote: "a sentence nobody wrote" })],
          evidence: [{ docId: "d1", title: "T", text: "An unrelated document." }]
        })
      )
    ]);
    const verdict = assessAct(provenanceFor(stitchAct(ungrounded, "act-1").items, 0, 1), undefined, computeActVeracity(ungrounded, 0));
    expect(verdict).toEqual({ servable: false, blockers: [{ itemId: "act-1", reason: "ungrounded-quote" }] });
  });
});
