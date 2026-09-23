"use strict";
/**
 * Golden copy rules — single source of truth for the banned-phrase list and
 * word-count helper enforced across ALL user-facing copy in data/*.json
 * (session card why-lines, discover.json hooks, and now ladder titles/rung
 * goals — see docs/curation/personalization-and-depth-plan.md §6).
 *
 * Previously this list was defined independently in
 * backend/test/copyRules.test.ts AND tools/refresh/merge.mjs — two copies
 * that could silently drift. Consolidated here 2026-07-24.
 *
 * Deliberately plain CommonJS, not TypeScript: tools/refresh/merge.mjs is a
 * dependency-free Node ESM script with no build step and no TypeScript
 * toolchain (it's the keyless nightly-refresh machinery — see
 * tools/refresh/README.md), and needs to import this directly with zero
 * compilation. A plain .js file here requires no build step for either
 * consumer:
 *   - tools/refresh/merge.mjs (ESM) imports it via the default-export /
 *     module.exports interop Node provides for CJS-from-ESM.
 *   - backend TypeScript files import it as a normal local module; see the
 *     hand-authored rules.d.ts alongside this file for types (no `allowJs`
 *     needed — TS resolves the .d.ts for type info and Node resolves the
 *     .js for runtime, exactly like any other typed-JS package).
 *
 * Keep this file's behavior byte-identical to what copyRules.test.ts and
 * merge.mjs each independently implemented before this refactor — that's
 * the whole point of consolidating it.
 */

const BANNED = [
  /fascinat/i,
  /deep[\s-]dive/i,
  /delve/i,
  /\bexplores?\b/i,
  /you won'?t believe/i,
  /fits? your drive/i,
  /your commute\b/i,
  /-min(ute)? drive/i
];

/**
 * The curation pipeline's own units, which must not reach a listener in copy
 * WE write about a Foray (its title, summary and slot titles).
 *
 * WHY A SECOND LIST AND NOT FOUR MORE ENTRIES IN `BANNED`. `BANNED` also gates
 * session why-lines and discover.json hooks, which describe publishers'
 * episodes in ordinary English — "a market segment", "the Clean Air Act", "a
 * drum beat" are all fair there. These four words are only jargon when they
 * name OUR structure: a `beat` of the spine, a `segment` of the pool, an `act`
 * of a generated Foray, the `running order` of its items. So the list is
 * applied where our structure is being described, and nowhere else.
 *
 * WHY IT EXISTS (2026-09-22 design audit, persona Tier 4). `grilling-history-2`
 * shipped titled "Barbecue: eight beats of a forty-beat history" — its own
 * `beats_total` and `beats_represented` fields recited as a title — and every
 * gate that reads Foray copy passed it, because the only list those gates had
 * was about filler and clickbait. The listener-facing word for a Foray's parts
 * is settled in docs/audit/persona-synthesis.md §2.
 *
 * WHICH USES ARE JARGON (review of PR #741). The first cut matched every
 * "beat", "segment" and "act", and so refused "the Beat Generation poets",
 * "how underdogs beat incumbents" and "when regulators failed to act" — titles
 * a generated Foray can legitimately carry, refused at the publish gate AFTER
 * the model spend. The words are only jargon when they COUNT or POINT AT our
 * parts, so the patterns match exactly those shapes:
 *   - a count of them: "eight beats", "a forty-beat history", "22 segments",
 *     "three acts" (but not "three acts of kindness");
 *   - a pointer to one act: "this act", "the last act", "the next act" (but
 *     not "the last act of defiance" or "his final act as president");
 *   - a numbered act: "Act one", "act 2" (but not "the Clean Air Act 1956");
 *   - "running order", which has no plain-English sense in our copy.
 * `act` itself stays lower-case in the first two shapes: "two Acts passed in
 * 1970" and "this Act" are legislation, which a Foray must be able to name.
 *
 * THE GENERATOR IS TOLD, AND ITS COPY IS SCRUBBED. check-forays.mjs refuses a
 * match; the understander and spine prompts forbid the words by name; and
 * `toListenerWords` below rewrites a match the model wrote anyway into the
 * listener's word (persona-synthesis §2: a clip, a part, a story), so the
 * generator never produces copy this list refuses (runPipeline.ts `forayCopy`,
 * `slotsFromSpine`).
 */
const COUNT_WORDS = [
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
  "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "sixty",
  "seventy", "eighty", "ninety", "hundred"
];
/** "Eight" or "eight", without making the unit word after it case-blind. */
const firstLetterEitherCase = (w) => `[${w[0].toUpperCase()}${w[0]}]${w.slice(1)}`;
const COUNT = `(?:\\d+|${COUNT_WORDS.map(firstLetterEitherCase).join("|")})`;
/* No "second": "her second act as a novelist" is an idiom, not our structure. */
const POINTERS = ["this", "that", "each", "every", "next", "last", "first", "final", "opening", "closing"];
const POINTER = `(?:${POINTERS.map(firstLetterEitherCase).join("|")})`;
/* At most two digits: "the Clean Air Act 1956" is a statute's year, not a part. */
const ACT_NUMBER = `(?:${COUNT_WORDS.slice(0, 10).join("|")}|\\d{1,2})`;
/** "three acts of kindness", "the last act of defiance", "his final act as
 * president": an act OF something or AS someone is the plain-English act. */
const NOT_PLAIN_ACT = "(?! (?:of|as)\\b)";

const INTERNAL_VOCABULARY = [
  new RegExp(`\\b${COUNT}[ -][Bb]eats?\\b`),
  new RegExp(`\\b${COUNT}[ -][Ss]egments?\\b`),
  new RegExp(`\\b${COUNT}[ -]acts?\\b${NOT_PLAIN_ACT}`),
  new RegExp(`\\b${POINTER} act\\b${NOT_PLAIN_ACT}`),
  new RegExp(`\\b[Aa]ct ${ACT_NUMBER}\\b`),
  /\brunning order\b/i
];

/**
 * Commute-length framing, in the shapes it was actually written. CLAUDE.md
 * principle 2 ("commute length is a learned parameter, never UI copy") and
 * copy rule 4 ban it, and `BANNED` has carried three shapes of it since
 * 2026-07-08 — but only shapes with a possessive or a hyphenated number:
 * "fits your drive", "your commute", "18-minute drive". The 2026-09-22 QA
 * audit (qa 152) found four session-card `fit_line`s that none of them match:
 * "a week of drives at your 1.5×", "fits today's drive almost exactly",
 * "a multi-commute saga", "two drives of easy hang".
 *
 * WHY A THIRD LIST AND NOT MORE ENTRIES IN `BANNED`. The same reason as
 * INTERNAL_VOCABULARY: `BANNED` also gates discover.json hooks, which describe
 * publishers' episodes, and 24 committed hooks say "drive" or "trip" in plain
 * English ("what drives the Court's rulings", "drives a fleet of radar trucks
 * into storms", "a road trip"). `/\bdrives?\b/` there would refuse all of them.
 * These patterns match only the framing: a COUNT of drives ("two drives", "a
 * week of drives", "several drives", "multi-drive"), a POINTER at the
 * listener's trip ("today's drive", "the morning commute", "the drive home"),
 * a "fits ... drive" claim, "drives' worth", and any form of "commute" at all —
 * in copy WE write about how an episode fits a listener, a commute is never
 * plain English. Applied to every string on a session card (archetype_label,
 * why_line, fit_line) and category, and to the session builder's own output
 * (sessionBuilder.test.ts), nowhere else.
 */
const DRIVE = "(?:drives?|commutes?)";
const COMMUTE_FRAMING = [
  /\bcommut/i,
  new RegExp(`\\b(?:${COUNT}|a few|several|a couple of|(?:a |an )?(?:week|month|fortnight|day)s? of|multi)[ -]${DRIVE}\\b`, "i"),
  new RegExp(`\\b(?:today'?s|tomorrow'?s|tonight'?s|this (?:morning|evening|afternoon)'?s|(?:a |the |your )?(?:morning|evening|afternoon) )${DRIVE}\\b`, "i"),
  new RegExp(`\\b${DRIVE} (?:home|to work|in|there and back)\\b`, "i"),
  new RegExp(`\\b${DRIVE}['’]? worth\\b`, "i"),
  /\bfits? (?:a |an |the |one |your |today'?s )?(?:drive|commute)\b/i
];

/** The listener's word for each of ours (docs/audit/persona-synthesis.md §2). */
const LISTENER_WORD = { beat: "story", beats: "stories", segment: "clip", segments: "clips", act: "part", acts: "parts" };

function keepCase(original, replacement) {
  const first = original.charAt(0);
  return first === first.toUpperCase() && first !== first.toLowerCase()
    ? replacement.charAt(0).toUpperCase() + replacement.slice(1)
    : replacement;
}

/**
 * `text` with every INTERNAL_VOCABULARY match rewritten into the listener's
 * word, touching nothing else: "eight beats" -> "eight stories", "a forty-beat
 * history" -> "a forty-part history", "22 segments" -> "22 clips", "The last
 * act" -> "The last part", "Act one" -> "Part one", "running order" ->
 * "lineup". Total, and a fixed point: its output matches no pattern above
 * (copyRules.test.ts pins both). `changed` says whether anything was rewritten,
 * so a caller can report that the model ignored the instruction.
 */
function toListenerWords(text) {
  const input = String(text ?? "");
  const unit = (word) => keepCase(word, LISTENER_WORD[word.toLowerCase()]);
  let out = input;
  out = out.replace(new RegExp(`(\\b${COUNT})-([Bb]eat|[Ss]egment|act)s?\\b${NOT_PLAIN_ACT}`, "g"), (m, n, u) =>
    `${n}-${keepCase(u, u.toLowerCase() === "segment" ? "clip" : "part")}`);
  out = out.replace(new RegExp(`(\\b${COUNT}) ([Bb]eats?|[Ss]egments?)\\b`, "g"), (m, n, u) => `${n} ${unit(u)}`);
  out = out.replace(new RegExp(`(\\b${COUNT}) (acts?)\\b${NOT_PLAIN_ACT}`, "g"), (m, n, u) => `${n} ${unit(u)}`);
  out = out.replace(new RegExp(`(\\b${POINTER}) act\\b${NOT_PLAIN_ACT}`, "g"), (m, p) => `${p} part`);
  out = out.replace(new RegExp(`\\b([Aa])ct (${ACT_NUMBER})\\b`, "g"), (m, a, n) => `${a === "A" ? "Part" : "part"} ${n}`);
  out = out.replace(/\brunning order\b/gi, (m) => keepCase(m, "lineup"));
  return { text: out, changed: out !== input };
}

function wordCount(text) {
  return text.trim().split(/\s+/).length;
}

// Word-limit constants already enforced elsewhere (session card why-lines,
// discover.json hooks — see CLAUDE.md "Copy rules"). New copy surfaces
// (ladder rung goals) reuse the why-line limit rather than inventing a
// third number.
const MAX_WHY_LINE_WORDS = 18;
const MAX_HOOK_WORDS = 16;

// Breadth-catalog classification's Foray-authored display fields (ADR-0006,
// docs/curation/breadth-classification-methodology-plan.md): a tile header
// and a 1-2 sentence tile blurb, captured at classification time for a
// future tile UI (not surfaced anywhere yet). No prior copy surface matches
// either shape, so these are new constants, not a reuse of an existing one.
const MAX_DISPLAY_TITLE_WORDS = 8;
const MAX_BLURB_WORDS = 30;

module.exports = {
  BANNED,
  INTERNAL_VOCABULARY,
  COMMUTE_FRAMING,
  toListenerWords,
  wordCount,
  MAX_WHY_LINE_WORDS,
  MAX_HOOK_WORDS,
  MAX_DISPLAY_TITLE_WORDS,
  MAX_BLURB_WORDS
};
