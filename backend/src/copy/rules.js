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
 * `act` is matched in lower case only, deliberately: a lower-case "act" in
 * sentence-case copy is the structural word ("this act", "the last act"),
 * while "Act" capitalised is almost always a proper noun (the Clean Air Act)
 * that a Foray about legislation must be able to name. "Act one" is caught by
 * its own pattern because it opens a sentence.
 */
const INTERNAL_VOCABULARY = [
  /\bbeats?\b/i,
  /\bsegments?\b/i,
  /\bacts?\b/,
  /\bAct (?:one|two|three|four|five|six|[0-9]+)\b/,
  /\brunning order\b/i
];

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
  wordCount,
  MAX_WHY_LINE_WORDS,
  MAX_HOOK_WORDS,
  MAX_DISPLAY_TITLE_WORDS,
  MAX_BLURB_WORDS
};
