import { BANNED, MAX_WHY_LINE_WORDS, wordCount } from "../copy/rules";

/**
 * The `why` a minted tier-2 segment carries into `data/segments.json` (F-78).
 *
 * THE GATE THIS SERVES. `tools/segments/merge-segments.mjs --check` — the pool's
 * CI gate — runs `copyErrors` over every row's `why`: it must be present, at
 * most `MAX_WHY_LINE_WORDS` (18) words, and free of `backend/src/copy/rules.js`'s
 * banned phrases. The first generated Foray to reach `main` (PR #583) shipped
 * ten rows without one, and a person typed ten sentences by hand to get the
 * gate green. The pool's `why` is "why a human cut this piece of tape"; the
 * only text this pipeline has that answers that question is the BEAT'S CLAIM —
 * the sentence §4.5 went looking for tape to carry — so the note is derived
 * from it, and from nothing else.
 *
 * WHAT "DERIVED" MEANS HERE, EXACTLY, so nobody mistakes it for writing:
 *   1. punctuation is folded to ASCII (curly quotes, dashes, ellipsis, non-
 *      breaking spaces) and whitespace collapsed — the pool is a plain-ASCII
 *      file and a curly quote in a `why` is a diff a reviewer has to squint at;
 *   2. the text is clamped at a WORD boundary to 18 words, never mid-word, and
 *      a dangling separator (`,` `;` `:` `-` `(` an opening quote) left at the
 *      cut is dropped;
 *   3. the four banned phrases a factual claim could plausibly contain
 *      (`explores`, `delve`, `fascinating`, `deep dive`) are swapped for the
 *      plainest equivalent, one word for one word, so a claim that happens to
 *      say "researchers explore" does not cost the beat its tape. The four
 *      marketing phrases on the list ("you won't believe", "-minute drive", …)
 *      are not rewritten: a claim containing one is not a claim, and
 *      `mintedWhyErrors` refuses the row instead.
 *
 * `mintedWhyErrors` is the SAME check the gate makes, on the same rules module
 * (never a reimplementation of the list), so a row this module lets through is
 * a row `--check` lets through — and a row it refuses is refused HERE, before
 * a branch is cut, rather than by CI after the PR is open.
 */

const ASCII_FOLDS: Array<[RegExp, string]> = [
  [/[‘’‚‛′´`]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[–—―−]/g, "-"],
  [/…/g, "..."],
  [/[\u00a0\u2000-\u200b\u202f\u205f\u3000]/g, " "]
];

/** One plain word for one banned word — see the module doc comment, point 3. */
const PLAIN_SWAPS: Array<[RegExp, string]> = [
  [/\bexplores\b/gi, "covers"],
  [/\bexplore\b/gi, "cover"],
  [/\bexplored\b/gi, "covered"],
  [/\bexploring\b/gi, "covering"],
  [/\bdelves\b/gi, "goes"],
  [/\bdelve\b/gi, "go"],
  [/\bdelved\b/gi, "went"],
  [/\bdelving\b/gi, "going"],
  [/\bfascinating\b/gi, "striking"],
  [/\bfascinated\b/gi, "struck"],
  [/\bfascinates\b/gi, "strikes"],
  [/\bfascinate\b/gi, "strike"],
  [/\bfascination\b/gi, "interest"],
  [/\bdeep[\s-]dives\b/gi, "close looks"],
  [/\bdeep[\s-]dive\b/gi, "close look"]
];

/** Trailing characters that are a separator, not a word, once the clamp has cut
 * after them: `so the call blows past its timeout,` → no comma. */
const DANGLING_TAIL = /[\s,;:("'[{-]+$/;

export function foldToAscii(text: string): string {
  let out = String(text ?? "").normalize("NFKC");
  for (const [rx, to] of ASCII_FOLDS) out = out.replace(rx, to);
  return out.replace(/\s+/g, " ").trim();
}

/**
 * The pool `why` for a beat claim. Total: never throws, never returns an empty
 * string for a non-empty claim. Word-count and banned-phrase compliance is
 * checked separately by `mintedWhyErrors`, because the two answers are wanted
 * at different times (mint vs. row) and by different callers.
 */
export function whyFromClaim(claim: string): string {
  let text = foldToAscii(claim);
  for (const [rx, to] of PLAIN_SWAPS) text = text.replace(rx, (m) => matchCase(m, to));
  const words = text.split(" ").filter((w) => w.length > 0);
  if (words.length > MAX_WHY_LINE_WORDS) {
    text = words.slice(0, MAX_WHY_LINE_WORDS).join(" ").replace(DANGLING_TAIL, "");
  }
  return text;
}

/** Keep a sentence-initial capital when swapping the first word. */
function matchCase(original: string, replacement: string): string {
  const first = original.charAt(0);
  if (first === first.toUpperCase() && first !== first.toLowerCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/**
 * Exactly `merge-segments.mjs`'s `copyErrors`, on the same rules module: the
 * errors the pool gate would raise for this `why`. Empty when the gate would
 * pass it.
 */
export function mintedWhyErrors(label: string, why: unknown): string[] {
  const errors: string[] = [];
  if (typeof why !== "string" || why.trim().length === 0) {
    errors.push(`${label}: why: missing`);
    return errors;
  }
  const words = wordCount(why);
  if (words > MAX_WHY_LINE_WORDS) errors.push(`${label}: why: ${words} words > ${MAX_WHY_LINE_WORDS}`);
  for (const rx of BANNED) {
    if (rx.test(why)) errors.push(`${label}: why: banned phrase ${rx}`);
  }
  return errors;
}
