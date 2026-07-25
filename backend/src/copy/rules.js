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
  wordCount,
  MAX_WHY_LINE_WORDS,
  MAX_HOOK_WORDS,
  MAX_DISPLAY_TITLE_WORDS,
  MAX_BLURB_WORDS
};
