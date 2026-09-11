/**
 * The comparison form for "is this phrase spoken in that stretch of tape".
 *
 * Mirrors `tools/segments/merge-segments.mjs`'s `canonical()` exactly:
 * lowercase, NFKC, apostrophes elided, everything else non-alphanumeric
 * collapsed to a single space. Kept in sync deliberately — a divergence
 * here would let the backend accept an anchor the real merge validator
 * would reject. It is a mirror, not a re-import, because that module is
 * an ESM `.mjs` build script and this backend compiles to CommonJS
 * (`backend/tsconfig.build.json`); the ALGORITHM is what has to match.
 *
 * Lives under `types/` rather than beside `transcriptArchiveLookup.ts`
 * (its original home, which re-exports it) because `types/narration.ts`
 * needs it too and that module stays free of any dependency on the
 * generation stages that use it. Two callers, one canonicalisation:
 * §4.5 minting a segment's anchors, and §4.7 checking that a Frame's
 * quoted phrase is in the transcript window of the segment it introduces
 * (F-81). A phrase that would resolve for one and not the other is the
 * kind of silent divergence this file exists to rule out.
 */
export function canonicalizeForAnchorMatch(text: string): string {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['‘’ʼʹ′`´]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** True when `phrase` is spoken, word for word, somewhere in `windowText`
 * — both sides canonicalised as above, so case, punctuation and
 * apostrophes are forgiven and every word must match. An empty phrase is
 * in nothing. */
export function phraseIsInWindow(phrase: string, windowText: string): boolean {
  const needle = canonicalizeForAnchorMatch(phrase);
  if (!needle) return false;
  return ` ${canonicalizeForAnchorMatch(windowText)} `.includes(` ${needle} `);
}
