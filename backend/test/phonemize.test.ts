import { describe, expect, it } from "vitest";
import {
  estimateSeconds,
  phonemizeItem,
  phonemizeItems,
  phonemizedCount,
  runPhonemizer,
  PHONEMIZER_SCRIPT,
  type Phonemizer
} from "../src/generation/phonemize";
import { ForayItemSchema, ForayNarrationItemSchema, type ForayItem, type ForayNarrationItem } from "../src/generation/forayItems";

/**
 * K-02's pipeline stage (`docs/bundled-voice-plan.md` K-02).
 *
 * THE PROPERTY THIS SUITE PROTECTS, above all others: a Foray must publish
 * whether or not the phonemizer worked. The bundled voice is an upgrade to how
 * narration sounds, not a new way for generation to fail — and a stage that
 * could take a written Foray down because a system package was missing would
 * be exactly that.
 *
 * Every test names the mutation that turns it red.
 */

const page = (over: Partial<ForayNarrationItem> = {}): ForayNarrationItem => ({
  type: "narration",
  id: "p1",
  script: "The sake was poured, and the binchōtan glowed.",
  mode: "carry",
  ...over
});

const ok: Phonemizer = () => ({ phonemes: "ðə ˈsɑːkeɪ wɒz pɔːd", model: "1.0", vocab: "sha256:abcd1234" });
const refuses: Phonemizer = () => null;

describe("phonemizeItem", () => {
  it("adds phonemes, est_sec and a tts block to a page it could phonemize", () => {
    const out = phonemizeItem(page(), ok);
    expect(out.phonemes).toBe("ðə ˈsɑːkeɪ wɒz pɔːd");
    expect(out.tts).toEqual({ engine: "kokoro", model: "1.0", vocab: "sha256:abcd1234" });
    expect(out.est_sec).toBeGreaterThan(0);
    /* The result must satisfy the schema the mapper enforces. MUTATION: remove
       `phonemes`/`tts`/`est_sec` from ForayNarrationItemSchema — `.strict()`
       rejects the stage's own output and this goes red. */
    expect(() => ForayNarrationItemSchema.parse(out)).not.toThrow();
  });

  it("returns the SAME OBJECT when the phonemizer refuses", () => {
    /* THE FALLBACK THAT MATTERS. misaki absent, espeak absent, a vocabulary it
       cannot report — all one fact: no phonemes for this page, publish it on
       the platform-voice path exactly as today.
       MUTATION: throw, or return a partially-filled item — a missing system
       package then takes down a written Foray. */
    const item = page();
    expect(phonemizeItem(item, refuses)).toBe(item);
  });

  it("treats a throwing phonemizer as a refusal, never as an error to propagate", () => {
    /* MUTATION: drop the try/catch. A subprocess that dies mid-run then
       propagates out of the stage and the Foray is lost after the writer has
       already spent its tokens. */
    const item = page();
    const boom: Phonemizer = () => { throw new Error("espeak-ng: not found"); };
    expect(phonemizeItem(item, boom)).toBe(item);
  });

  it("refuses a half-answer: phonemes with no vocab, or no model", () => {
    /* `vocab` is what the player version-checks against (deck §5 item 8). An
       item with phonemes and no vocab is one the player cannot decide about,
       so it would fall back forever and the failure would be invisible.
       MUTATION: stamp a default vocab when the phonemizer omits one — the item
       ships claiming a vocabulary nobody computed. */
    const item = page();
    expect(phonemizeItem(item, () => ({ phonemes: "x", model: "1.0", vocab: "" }))).toBe(item);
    expect(phonemizeItem(item, () => ({ phonemes: "x", model: "", vocab: "v" }))).toBe(item);
    expect(phonemizeItem(item, () => ({ phonemes: "  ", model: "1.0", vocab: "v" }))).toBe(item);
  });

  it("leaves an empty script alone — check-forays has a better reason to reject it", () => {
    /* MUTATION: phonemize anyway. An empty phoneme string would then satisfy
       the checker's "non-empty phonemes" rule while the script stays empty,
       which turns a loud failure into a silent one. */
    const item = page({ script: "   " });
    expect(phonemizeItem(item, ok)).toBe(item);
  });
});

describe("phonemizeItems", () => {
  const items: ForayItem[] = [
    { type: "segment", segment_id: "s1" },
    page({ id: "p1" }),
    { type: "jingle" },
    page({ id: "p2" })
  ];

  it("touches narration only — segments and jingles pass through by reference", () => {
    /* A stage that rewrote a segment item could break tape, which is the one
       thing in a Foray that cannot be regenerated.
       MUTATION: map every item through `phonemizeItem`. */
    const out = phonemizeItems(items, ok);
    expect(out[0]).toBe(items[0]);
    expect(out[2]).toBe(items[2]);
    expect((out[1] as ForayNarrationItem).tts).toBeDefined();
    for (const item of out) expect(() => ForayItemSchema.parse(item)).not.toThrow();
  });

  it("is per item: one page that failed does not cost the others theirs", () => {
    /* `queue-manager.js` decides per item (K-05), so a Foray may be half
       bundled-voice and half system-voice and still play.
       MUTATION: abandon the whole Foray on the first refusal — a single
       out-of-vocabulary page then drops every page back to the system voice. */
    const flaky: Phonemizer = (s) => (s.includes("sake") ? null : { phonemes: "p", model: "1.0", vocab: "v" });
    const out = phonemizeItems([page({ id: "a" }), page({ id: "b", script: "Plain prose." })], flaky);
    expect((out[0] as ForayNarrationItem).tts).toBeUndefined();
    expect((out[1] as ForayNarrationItem).tts).toBeDefined();
    expect(phonemizedCount(out)).toBe(1);
  });

  it("a whole-Foray refusal leaves every item byte-identical", () => {
    /* The publish path with no phonemizer installed at all, which is the state
       of this repository today. */
    const out = phonemizeItems(items, refuses);
    expect(out).toEqual(items);
    expect(phonemizedCount(out)).toBe(0);
  });
});

describe("estimateSeconds", () => {
  it("is narration-craft's 17 characters per second and nothing else", () => {
    /* `est_sec` feeds the seam and generation-lead maths until K-04 records a
       real rendered length. A second rate here would put the pipeline and the
       player's own `narrationDuration` on different clocks.
       MUTATION: divide by 20. */
    expect(estimateSeconds("x".repeat(170))).toBe(10);
    expect(estimateSeconds("")).toBe(0);
  });
});

describe("runPhonemizer", () => {
  it("answers an empty map without spawning anything when there is nothing to do", () => {
    expect(runPhonemizer([]).size).toBe(0);
  });

  it("answers an empty map — never throws — when the interpreter is absent", () => {
    /* THE PRODUCTION FALLBACK, exercised for real: there is no
       `definitely-not-python` on any machine.
       MUTATION: let `spawnSync`'s failure propagate, or read `res.stdout`
       without checking `res.status` — the pipeline then dies on a machine that
       has not installed the stage, which is every machine today. */
    expect(() => runPhonemizer([{ id: "p1", script: "Hello." }], { python: "definitely-not-python" })).not.toThrow();
    expect(runPhonemizer([{ id: "p1", script: "Hello." }], { python: "definitely-not-python" }).size).toBe(0);
  });

  it("names the script the repository actually carries", () => {
    /* MUTATION: rename the .py without updating this constant — the stage then
       silently returns nothing on every run and every Foray publishes on the
       platform-voice path with no one told why. */
    expect(PHONEMIZER_SCRIPT.replace(/\\/g, "/")).toBe("tools/narration/phonemize.py");
  });
});
