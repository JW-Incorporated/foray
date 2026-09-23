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

const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™",
  deg: "°", middot: "·", bull: "•", euro: "€", pound: "£",
  agrave: "à", aacute: "á", acirc: "â", auml: "ä", atilde: "ã", aring: "å",
  egrave: "è", eacute: "é", ecirc: "ê", euml: "ë",
  igrave: "ì", iacute: "í", icirc: "î", iuml: "ï",
  ograve: "ò", oacute: "ó", ocirc: "ô", ouml: "ö", otilde: "õ", oslash: "ø",
  ugrave: "ù", uacute: "ú", ucirc: "û", uuml: "ü",
  yacute: "ý", yuml: "ÿ", ntilde: "ñ", ccedil: "ç", szlig: "ß",
  Agrave: "À", Aacute: "Á", Acirc: "Â", Auml: "Ä", Atilde: "Ã", Aring: "Å",
  Egrave: "È", Eacute: "É", Ecirc: "Ê", Euml: "Ë",
  Igrave: "Ì", Iacute: "Í", Icirc: "Î", Iuml: "Ï",
  Ograve: "Ò", Oacute: "Ó", Ocirc: "Ô", Ouml: "Ö", Otilde: "Õ", Oslash: "Ø",
  Ugrave: "Ù", Uacute: "Ú", Ucirc: "Û", Uuml: "Ü",
  Yacute: "Ý", Ntilde: "Ñ", Ccedil: "Ç",
};

/** Matches every entity this module knows: numeric (decimal or hex) and the
    named set above. Exported so the data test and the decoder read ONE
    definition of "an entity" — a name added to NAMED is caught by both. */
export const ENTITY_RE = new RegExp(`&(?:#(\\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(${Object.keys(NAMED).join("|")}));`, "g");

/** One code point, or null when the number is not a scalar value. Control
    characters (the `&#13;` a feed leaves inside a blurb) become a space rather
    than a raw CR/LF: nothing in data/ is prose that wants a line break. */
function fromCodePoint(n) {
  if (!Number.isInteger(n) || n < 0 || n > 0x10ffff) return null;
  if (n >= 0xd800 && n <= 0xdfff) return null;
  if (n < 0x20 || (n >= 0x7f && n < 0xa0)) return " ";
  return String.fromCodePoint(n);
}

/** Decode the entities in `s`. Runs until the text is fixed, so a
    double-encoded "&amp;#038;" also comes out as "&". Anything that is not an
    entity this module knows is left exactly as it was. */
export function decodeEntities(s) {
  if (s == null) return s;
  let text = String(s);
  for (let pass = 0; pass < 4; pass++) {
    const next = text.replace(ENTITY_RE, (m, dec, hex, name) => {
      if (name) return NAMED[name];
      const ch = fromCodePoint(parseInt(dec ?? hex, dec ? 10 : 16));
      return ch == null ? m : ch;
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
