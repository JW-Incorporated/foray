import { describe, it, expect } from "vitest";
import { toForayItem, toForayItems, assertNoInternalFieldsLeaked, citesFor, slugifySlotTitle, estimateScriptSeconds, ForayItemSchema } from "../src/generation/forayItems";
import type { PrintSource, Source, TapeSource } from "../src/types/narration";
import type { StitchedItem, StitchedNarrationItem, StitchedTapeItem, StitchedJingleItem } from "../src/types/stitching";

describe("forayItems — internal-only fields never leak into the mapped output", () => {
  it("maps a tape item without beatIndex/itemId/startSec/endSec", () => {
    const item: StitchedTapeItem = {
      kind: "tape",
      beatIndex: 7,
      slotTitle: "Fire and the origins of cooking",
      segmentId: "origin-stories-cooking-human#147",
      itemId: "origin-stories-cooking-human",
      startSec: 100,
      endSec: 130
    };
    const mapped = toForayItem(item);
    expect(mapped).toEqual({ type: "segment", segment_id: "origin-stories-cooking-human#147", slot: "fire-and-the-origins-of-cooking" });
    expect(mapped).not.toHaveProperty("beatIndex");
    expect(mapped).not.toHaveProperty("itemId");
    expect(mapped).not.toHaveProperty("startSec");
    expect(mapped).not.toHaveProperty("endSec");
  });

  it("maps a narration item without sources/verified/pronunciationHints/beatIndex/narrationKind", () => {
    const item: StitchedNarrationItem = {
      kind: "narration",
      narrationKind: "beat",
      beatIndex: 3,
      slotTitle: "Fire and the origins of cooking",
      mode: "Patch",
      script: "This is a real narration script long enough to pass the mode's character band easily.",
      id: "narration-act-1-3-beat"
    };
    const mapped = toForayItem(item);
    expect(mapped).toEqual({
      type: "narration",
      id: "narration-act-1-3-beat",
      script: item.script,
      mode: "patch",
      slot: "fire-and-the-origins-of-cooking"
    });
    expect(mapped).not.toHaveProperty("sources");
    expect(mapped).not.toHaveProperty("verified");
    expect(mapped).not.toHaveProperty("pronunciationHints");
    expect(mapped).not.toHaveProperty("beatIndex");
    expect(mapped).not.toHaveProperty("narrationKind");
  });

  it("maps a jingle item to exactly {type, id?}", () => {
    const item: StitchedJingleItem = { kind: "jingle", reason: "cadence", id: "jingle-cadence-act-1-4" };
    const mapped = toForayItem(item);
    expect(mapped).toEqual({ type: "jingle", id: "jingle-cadence-act-1-4" });
    expect(mapped).not.toHaveProperty("reason");
  });

  it("assertNoInternalFieldsLeaked passes for a real mapped sequence and throws on a synthetic leak", () => {
    const items: StitchedItem[] = [
      { kind: "tape", beatIndex: 0, slotTitle: "Slot", segmentId: "seg#1", itemId: "ep-1", startSec: 0, endSec: 30 },
      { kind: "jingle", reason: "cut", id: "j1" },
      { kind: "tape", beatIndex: 1, slotTitle: "Slot", segmentId: "seg#2", itemId: "ep-2", startSec: 0, endSec: 30 }
    ];
    const mapped = toForayItems(items);
    expect(() => assertNoInternalFieldsLeaked(mapped)).not.toThrow();

    const leaked = [...mapped, { type: "segment", segment_id: "x", sources: [] } as any];
    expect(() => assertNoInternalFieldsLeaked(leaked)).toThrow(/leaked internal-only field/);
  });

  it("every mapped item parses against ForayItemSchema (matches check-forays.mjs's expected shape)", () => {
    const items: StitchedItem[] = [
      { kind: "tape", beatIndex: 0, slotTitle: "Slot A", segmentId: "seg#1", itemId: "ep-1", startSec: 0, endSec: 30, label: "ORI-1" },
      { kind: "narration", narrationKind: "seam", slotTitle: "Slot A", mode: "Frame", script: "A seam narration script long enough for its band.", id: "seam-1" },
      { kind: "jingle", reason: "cut" }
    ];
    const mapped = toForayItems(items);
    for (const item of mapped) {
      expect(() => ForayItemSchema.parse(item)).not.toThrow();
    }
  });
});

describe("slugifySlotTitle", () => {
  it("produces a stable, lowercase, hyphenated slug", () => {
    expect(slugifySlotTitle("Fire and the origins of cooking")).toBe("fire-and-the-origins-of-cooking");
    expect(slugifySlotTitle("  US regional divergence!! ")).toBe("us-regional-divergence");
  });
});

describe("estimateScriptSeconds", () => {
  it("matches the published 17 chars/sec planning rate", () => {
    expect(estimateScriptSeconds(170)).toBe(10);
    expect(estimateScriptSeconds(17)).toBe(1);
  });
});

/* F-103 — the provenance the writer produced now reaches `data/forays.json`.
 *
 * Where it used to be lost: `stitchAct.ts` read `mode` and `script` off the
 * `NarratedBeat` and nothing else, so `sources`/`verified` never reached a
 * `StitchedNarrationItem` at all and this mapper's leak guard was protecting a
 * mistake that could not be made. The tests below are about the two halves of
 * the fix — what the derived shape carries, and what it refuses to carry. */
describe("forayItems — F-103: a narrated beat ships the sources it rests on", () => {
  const verifiedPage = (sources: Source[]): StitchedNarrationItem => ({
    kind: "narration",
    narrationKind: "beat",
    beatIndex: 3,
    slotTitle: "Fire and the origins of cooking",
    mode: "Patch",
    script: "This is a real narration script long enough to pass the mode's character band easily.",
    id: "narration-act-1-3-beat",
    verified: true,
    sources
  });

  const print = (over: Partial<PrintSource> = {}): PrintSource => ({
    claimText: "Cooking predates anatomically modern humans.",
    publication: "Journal of Human Evolution",
    url: "https://example.org/paper",
    quote: "the earliest secure evidence of controlled fire",
    contested: false,
    ...over
  });

  const tape = (over: Partial<TapeSource> = {}): TapeSource => ({
    kind: "tape",
    claimText: "Wrangham argues cooking drove gut reduction.",
    publication: "Origin Stories — Episode 09",
    contested: false,
    segmentId: "origin-stories-cooking-human#147",
    ...over
  });

  it("publishes a print source as {kind, publication, url} and NOTHING else", () => {
    /* `claimText` is the writer's own restatement of an assertion and `quote` is
       a verbatim span of a held document — Ruling 3 keeps quoted spans out of
       anything a listener reads, and neither identifies the source to a reader
       better than its publication does.
       MUTATION: build the cite with `...source` instead of field-by-field —
       claimText/quote/contested/retrieved all ship into data/forays.json. */
    const mapped = toForayItem(verifiedPage([print({ retrieved: "2026-09-09" })]));
    expect(mapped).toMatchObject({
      cites: [{ kind: "print", publication: "Journal of Human Evolution", url: "https://example.org/paper" }]
    });
    expect(Object.keys((mapped as { cites: object[] }).cites[0]!).sort()).toEqual(["kind", "publication", "url"]);
  });

  it("publishes a tape source as {kind, segment_id} — the show and episode are a lookup, not bytes", () => {
    /* `player/foray-resolve.js` already holds the segment and source pools when
       it hydrates an item (it needs them to play the clip), so denormalising
       `show`/`title` here would cost bytes in a budgeted file and could go
       stale against a re-curated pool. Agreed with the renderer, 2026-09-12.
       MUTATION: copy `source.publication` onto the tape cite — check-forays.mjs
       rejects the extra field, and the credit starts drifting from the pool. */
    const mapped = toForayItem(verifiedPage([tape()]));
    expect(mapped).toMatchObject({ cites: [{ kind: "tape", segment_id: "origin-stories-cooking-human#147" }] });
    expect(Object.keys((mapped as { cites: object[] }).cites[0]!).sort()).toEqual(["kind", "segment_id"]);
  });

  it("publishes NO citations for a page the verifier did not confirm", () => {
    /* THE HONESTY RULE. F-51 keeps a refused page with `verified: false` rather
       than ending the run, and F-60/F-99 keep pages never written against
       evidence at all. Publishing their `sources` would present as support
       exactly the material the verifier declined to accept as support.
       MUTATION: drop the `verified !== true` gate — an unverified page ships a
       Sources list a reader would read as confirmation. */
    const refused = { ...verifiedPage([print(), tape()]), verified: false };
    expect(toForayItem(refused)).not.toHaveProperty("cites");
  });

  it("publishes no citations when the item never learned a verification state", () => {
    /* Absent is not "assume fine". The act introduction/exit seams
       `stitchForay.ts` assembles are prose the deepen stage wrote that no
       per-page verifier ever read, and they carry neither field.
       MUTATION: make the gate `verified === false` — every seam, and every
       hand-built item, starts publishing whatever sources it happens to hold. */
    const seam: StitchedNarrationItem = {
      kind: "narration",
      narrationKind: "seam",
      slotTitle: "Fire and the origins of cooking",
      mode: "Frame",
      script: "A short act introduction, written at the deepen stage and never verified per page.",
      id: "act-1-introduction",
      sources: [print()]
    };
    expect(toForayItem(seam)).not.toHaveProperty("cites");
    expect(citesFor(seam)).toEqual([]);
  });

  it("omits `cites` entirely rather than publishing an empty array", () => {
    /* A page verified by SYNTHESIS (F-88) rests on the Foray's own earlier
       pages, so its `restsOn` resolves to page ids and its `sources` to
       nothing; a pure handoff asserts nothing either. Both are this case.
       MUTATION: assign `narration.cites = cites` unconditionally — every
       narration item in every generated Foray grows `"cites": []`, ~12 bytes
       apiece, and the renderer has a second emptiness spelling to handle. */
    const mapped = toForayItem(verifiedPage([]));
    expect(mapped).not.toHaveProperty("cites");
    expect(ForayItemSchema.parse(mapped)).toEqual(mapped);
  });

  it("lists one document once, however many claims rest on it", () => {
    /* Upstream a page carries one `Source` per CLAIM (that is what makes "every
       factual claim carries a source" checkable), so three claims from one
       article are three records. The claim-level detail that distinguishes them
       is exactly what is not published, so undeduplicated they would render as
       the same line three times.
       MUTATION: drop the `seen` set in `citesFor`. */
    const cites = citesFor(
      verifiedPage([
        print({ claimText: "One." }),
        print({ claimText: "Two.", quote: "a different span of the same article" }),
        tape({ claimText: "Three." }),
        tape({ claimText: "Four.", quote: "a phrase of the same clip" })
      ])
    );
    expect(cites).toEqual([
      { kind: "print", publication: "Journal of Human Evolution", url: "https://example.org/paper" },
      { kind: "tape", segment_id: "origin-stories-cooking-human#147" }
    ]);
  });

  it("keeps two documents from one publication apart, and preserves first-cited order", () => {
    const cites = citesFor(verifiedPage([print({ url: "https://example.org/b" }), print({ url: "https://example.org/a" })]));
    expect(cites.map((c) => (c.kind === "print" ? c.url : c.segment_id))).toEqual(["https://example.org/b", "https://example.org/a"]);
  });

  it("drops a url that is not an http(s) address, and keeps the publication", () => {
    /* `PrintSource.url` upstream is any non-empty string — the evidence pack
       records what the retriever recorded. A published citation is a link a
       reader clicks, and the publication name alone is already a complete
       citation, so a non-navigable href is worse than none. Dropping it here
       (rather than shipping it for `check-forays.mjs` to reject) is what stops
       one scruffy retrieval record from failing a whole candidate.
       MUTATION: pass `source.url` through unchanged — finalizeForay's
       check-forays pass turns red on a run that was otherwise clean. */
    for (const url of ["example.org/paper", "javascript:alert(1)", "   ", "https://"]) {
      const [cite] = citesFor(verifiedPage([print({ url })]));
      expect(cite).toEqual({ kind: "print", publication: "Journal of Human Evolution" });
    }
    expect(citesFor(verifiedPage([print({ url: "http://example.org/x" })]))[0]).toEqual({
      kind: "print",
      publication: "Journal of Human Evolution",
      url: "http://example.org/x"
    });
  });

  it("a source with no url at all publishes a citation with no url", () => {
    const [cite] = citesFor(verifiedPage([print({ url: undefined })]));
    expect(cite).toEqual({ kind: "print", publication: "Journal of Human Evolution" });
  });

  it("still leaks nothing: `sources` and `verified` are read and never written", () => {
    /* The guard that was previously unreachable. `stitchAct.ts` now puts both
       fields on the stitched item, so a `...spread` in `toForayItem` would put
       both into `data/forays.json` — which is the mistake this assertion has
       existed to catch since §4.8 landed and could not, until now, actually
       catch.
       MUTATION: `return { ...item, type: "narration", ... }`. */
    const items = toForayItems([verifiedPage([print(), tape()])]);
    expect(items[0]).not.toHaveProperty("sources");
    expect(items[0]).not.toHaveProperty("verified");
    expect(() => assertNoInternalFieldsLeaked(items)).not.toThrow();
    expect(ForayItemSchema.parse(items[0])).toEqual(items[0]);
  });
});
