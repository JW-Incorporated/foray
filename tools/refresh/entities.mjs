/* HTML entities in feed text, decoded ONCE, at ingest.
 *
 * WHY THIS EXISTS (visual pass 1 review, 2026-09-23)
 * Podcast feeds and the classification agent's copy both carry entity-encoded
 * text: "Vibe Coding &#038; Linux", "Fedor &#038; Football", "Grant &#038; Lee",
 * "&rsquo;" and "&#8217;" for an apostrophe, "&#13;" for a stray carriage
 * return. `data/discover.json` stored them as-is, and the app's `esc()` — which
 * is correct — turned `&` into `&amp;`, so the page showed the literal
 * "&#038;" in every episode-row title. The backend feed parser already decodes
 * (backend/src/feeds/parser.ts, `decodeEntities`); the static data path did not.
 *
 * The rule: text is decoded where it ENTERS data/ (the feed scan, the show
 * backfill, the classification merge), never where it is rendered, and
 * test/data-entities.test.js fails on any entity left in a data file. A title
 * that genuinely contains an ampersand stores "&", and `esc()` renders it.
 */

import { readFileSync } from "node:fs";

/* The named entities: ONE table, shared with backend/src/feeds/html.ts (the
   live API's decoder), so a title decodes the same in data/ and on the live
   episode list (CH2-09, docs/roadmap/code-health-2.md B1-05). html.ts imports
   it statically so Vercel bundles it; tools run from the repo checkout, so
   this side reads it beside the module. backend/test/entitiesParity.test.ts
   holds the two decoders to backend/fixtures/entities.json. */
const NAMED = JSON.parse(readFileSync(new URL("../../backend/src/feeds/entitiesTable.json", import.meta.url), "utf8"));

/** Matches every entity this module knows: numeric (decimal or hex) and the
    shared named table. Exported so the data test and the decoder read ONE
    definition of "an entity" — a name added to the table is caught by both. */
export const ENTITY_RE = new RegExp(`&(?:#(\\d+)|#[xX]([0-9a-fA-F]+)|(${Object.keys(NAMED).join("|")}));`, "g");

/** U+FFFD, the Unicode replacement character. */
const REPLACEMENT_CHARACTER = "�";

/** One code point — the code-point rule html.ts's decodeCodePoint shares.
    A number that is not a Unicode scalar value (a surrogate, or above
    U+10FFFF) becomes U+FFFD, so no entity survives into data/. A control
    character (the `&#13;` a feed leaves inside a blurb; C0 and C1 alike)
    becomes a space rather than a raw CR/LF: nothing in data/ is prose that
    wants a line break. */
function fromCodePoint(n) {
  if (!Number.isInteger(n) || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return REPLACEMENT_CHARACTER;
  if (n < 0x20 || (n >= 0x7f && n < 0xa0)) return " ";
  return String.fromCodePoint(n);
}

/** Decode the entities in `s`. Runs until the text is fixed (at most 4
    passes), so a double-encoded "&amp;#038;" also comes out as "&". Anything
    that is not an entity this module knows is left exactly as it was. */
export function decodeEntities(s) {
  if (s == null) return s;
  let text = String(s);
  for (let pass = 0; pass < 4; pass++) {
    const next = text.replace(ENTITY_RE, (m, dec, hex, name) => {
      if (name) return NAMED[name];
      return fromCodePoint(dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16));
    });
    if (next === text) break;
    text = next;
  }
  return text;
}

/** True when `s` still carries an entity this module would decode. */
export function hasEntity(s) {
  ENTITY_RE.lastIndex = 0;
  return ENTITY_RE.test(String(s ?? ""));
}
