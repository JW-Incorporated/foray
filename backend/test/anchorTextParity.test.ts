import { describe, it, expect } from "vitest";
import { canonicalizeForAnchorMatch } from "../src/types/anchorText";

/* CH2-07 (B1-13). `types/anchorText.ts`'s `canonicalizeForAnchorMatch` is a
   MIRROR of `tools/segments/merge-segments.mjs`'s `canonical()`, not a
   re-import (that module is an ESM build script; the backend compiles to
   CommonJS). A mirror with no pin drifts: an apostrophe variant added on one
   side lets the backend mint an anchor the real merge validator rejects —
   or refuse one it would accept. vitest can `import()` the .mjs (precedent:
   actNarration.test.ts's check-narration.mjs pin), so the two are compared
   here on every input class the canonical form has an opinion about. */

/* Apostrophe-like code points: the eight merge-segments.mjs's APOSTROPHES
   class lists today, then look-alikes that neither side lists. */
const APOSTROPHE_CANDIDATES: readonly string[] = [
  "'", "’", "‘", "´", "`", "′", "ʼ", "ʹ",
  "ʻ", "ʽ", "″", "＇", "｀", "ˈ", "՚", "ꞌ"
];

const FIXTURE: readonly string[] = [
  /* apostrophe variants — every one merge-segments.mjs's APOSTROPHES lists,
     plus the left/right quotes a transcript ships */
  "Drivers' dashcams",
  "Drivers’ dashcams",
  "Drivers‘ dashcams",
  "Drivers´ dashcams",
  "Drivers` dashcams",
  "Drivers′ dashcams",
  "Driversʼ dashcams",
  "Driversʹ dashcams",
  "we're going, aren’t we?",
  /* punctuation that is NOT an apostrophe becomes a space */
  "hand-waving — the em-dash, the en–dash; and \"quotes\" (parens) [brackets]!",
  "Drivers’ DASH-cams, okay?",
  "“Smart” double quotes and ″double primes″",
  "a.b.c / d\\e | f_g",
  /* NFKC: ligatures, full-width forms, superscripts, compatibility letters */
  "ﬁnancial ﬂows",
  "ＦＵＬＬ－ＷＩＤＴＨ ｗｏｒｄｓ １２３",
  "x² and H₂O",
  "Ⅻ chapters, ½ the cost, ℃",
  "Ｄｒｉｖｅｒｓ＇ dashcams",
  "café vs cafe\u0301",
  /* whitespace runs and edges */
  "  so   the\tthing\n\nis\r\nthat  ",
  "\u00a0non-breaking\u2003em space\u200bzero width",
  "",
  "   ",
  "!!!",
  /* case, including non-ASCII case folding */
  "ÉCOLE Straße İstanbul ΣΟΦΊΑ",
  /* digits and letters from other scripts survive */
  "thirty years / 30 years / ٣٠ years",
  "日本語のテキスト、そして English"
];

describe("CH2-07 — the backend's anchor canonicalisation IS merge-segments.mjs's canonical()", () => {
  it("canonicalizeForAnchorMatch and canonical() agree on apostrophe variants, punctuation, NFKC and whitespace", async () => {
    /* MUTATION THAT KILLS THIS: add one apostrophe variant to EITHER
       canonicaliser's apostrophe class (say U+02BB `ʻ`), or drop one (say
       U+2032 `′`) — the `aren?t` row for that character is elided on one side
       ("arent") and spaced on the other ("aren t"). Each variant sits INSIDE
       a word for that reason: at a word's edge, eliding and spacing collapse
       to the same string. Dropping NFKC on one side reds the ligature and
       full-width rows; trimming on one side only reds the edge-whitespace
       rows. */
    const merge = (await import("../../tools/segments/merge-segments.mjs")) as { canonical: (text: unknown) => string };
    for (const input of FIXTURE) {
      expect({ input, backend: canonicalizeForAnchorMatch(input) }).toEqual({ input, backend: merge.canonical(input) });
    }
    /* Every apostrophe-like character, inside a word: the eight both
       classes list today are elided, and the look-alikes neither lists must
       still canonicalise the same way on both sides. */
    for (const ch of APOSTROPHE_CANDIDATES) {
      const word = `aren${ch}t`;
      expect({ ch, backend: canonicalizeForAnchorMatch(word) }).toEqual({ ch, backend: merge.canonical(word) });
    }
    for (const ch of ["'", "’", "‘", "`", "′", "ʼ", "ʹ"]) {
      expect(canonicalizeForAnchorMatch(`aren${ch}t`)).toBe("arent");
    }
    /* Today's behaviour, pinned rather than fixed: the acute accent U+00B4
       is listed in BOTH apostrophe classes, but NFKC runs first and folds it
       to U+0020 + U+0301, so it is never elided — "aren´t" canonicalises to
       "aren t" on both sides. Changing that changes which anchors validate,
       so it is a separate decision, not part of this pin. */
    expect(canonicalizeForAnchorMatch("aren´t")).toBe("aren t");
    expect(merge.canonical("aren´t")).toBe("aren t");
    /* null / undefined: both read as the empty string. */
    expect(canonicalizeForAnchorMatch(undefined as unknown as string)).toBe("");
    expect(merge.canonical(undefined)).toBe("");
    expect(merge.canonical(null)).toBe("");
  });

  it("pins today's canonical form on the anchor shapes a transcript actually ships", async () => {
    /* MUTATION THAT KILLS THIS: change BOTH canonicalisers the same way (they
       would still agree, so the parity test above stays green) — e.g. space
       apostrophes instead of eliding them, or keep hyphens. */
    const merge = (await import("../../tools/segments/merge-segments.mjs")) as { canonical: (text: unknown) => string };
    const pinned: Array<[string, string]> = [
      ["Drivers’ DASH-cams, okay?", "drivers dash cams okay"],
      ["we're going, aren’t we?", "were going arent we"],
      ["ﬁnancial ﬂows", "financial flows"],
      ["ＦＵＬＬ－ＷＩＤＴＨ ｗｏｒｄｓ １２３", "full width words 123"],
      ["  so   the\tthing\n\nis\r\nthat  ", "so the thing is that"],
      ["café vs cafe\u0301", "café vs café"],
      ["!!!", ""]
    ];
    for (const [input, expected] of pinned) {
      expect(canonicalizeForAnchorMatch(input)).toBe(expected);
      expect(merge.canonical(input)).toBe(expected);
    }
  });
});
