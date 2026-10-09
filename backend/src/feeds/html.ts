/**
 * Minimal, dependency-free HTML -> plain text sanitizer for show-note soup
 * (corner case 5): CDATA-wrapped HTML, tracking pixels, stray entities.
 * Not a rendering engine — good enough to hand clean text to an LLM or to
 * display safely. Strips script/style bodies entirely, drops all tags,
 * decodes entities, and collapses whitespace.
 */

/* The named entities, ONE table shared with tools/refresh/entities.mjs (the
   catalogue's decoder), so the live API and data/ decode the same names
   (CH2-09, docs/roadmap/code-health-2.md B1-05: the live episode list used to
   show "Caf&eacute;" for a title data/discover.json carried as "Café").
   A static import, never a runtime read: this module is in every api/
   handler's import closure, nft bundles a static import, and a readFileSync
   of a path outside data/ would be missing from the deployed function
   (api/_test/vercel-bundle.test.mjs holds that line).
   A namespace import, not a default one: compiled to CommonJS without
   esModuleInterop, `import x from "./t.json"` reads `require(...).default`,
   which is undefined, and every function would crash at module load. The
   namespace form works with or without interop (and under vitest's ESM),
   and the string filter drops the `default` key interop adds. */
import * as ENTITY_TABLE from "./entitiesTable.json";

const NAMED: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(ENTITY_TABLE).filter((entry): entry is [string, string] => typeof entry[1] === "string")
);

/** Numeric (decimal, or hex with x/X) references and the table's names. Anything else — an unknown
    name, "&#1f;", "AT&T" — never matches, so it is left exactly as written. */
// eslint-disable-next-line security/detect-non-literal-regexp -- built once from the static table's names, all [A-Za-z]+
const ENTITY_RE = new RegExp(`&(?:#(\\d+)|#[xX]([0-9a-fA-F]+)|(${Object.keys(NAMED).join("|")}));`, "g");

/** A double-encoded "&amp;#038;" takes two passes; the cap only bounds pathological input. */
const MAX_PASSES = 4;

/**
 * Decodes named + numeric (decimal and hex) HTML/XML entities, to a fixed
 * point (at most MAX_PASSES), by the same rule as tools/refresh/entities.mjs
 * (backend/test/entitiesParity.test.ts holds the two to one fixture).
 * Exported separately from sanitizeHtmlToText because titles need entity
 * decoding too but must NOT go through tag-stripping/whitespace-collapsing —
 * see corner case finding in fixtures/feeds/README.md: fast-xml-parser does
 * not decode numeric character references (e.g. WordPress/PowerPress
 * feeds emitting "&#038;" for a literal "&" in episode titles) even with
 * its default entity-processing options, since those only cover the five
 * predefined named XML entities.
 */
export function decodeEntities(input: string): string {
  let text = input;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const next = text.replace(ENTITY_RE, (_match, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (name !== undefined) return NAMED[name] as string;
      return decodeCodePoint(dec !== undefined ? parseInt(dec, 10) : parseInt(hex as string, 16));
    });
    if (next === text) break;
    text = next;
  }
  return text;
}

/** U+FFFD, the Unicode replacement character. */
const REPLACEMENT_CHARACTER = "�";

/**
 * One never-throwing, range-checked decoder for a numeric character
 * reference — the one code-point rule tools/refresh/entities.mjs shares.
 * String.fromCodePoint throws RangeError above U+10FFFF, which used to take
 * the whole of parseFeed (and a show's episode page) down on a single
 * malformed `&#99999999;`. Rules:
 *   - a surrogate, anything above U+10FFFF, or a number too long to be one
 *     becomes U+FFFD;
 *   - a C0 or C1 control (U+0000-U+001F, U+007F-U+009F), tab/LF/CR and NUL
 *     included, becomes a space: nothing a feed entity-encodes is prose that
 *     wants a raw line break, Postgres text rejects 0x00, and XML 1.0 forbids
 *     the rest;
 *   - everything else decodes normally.
 */
function decodeCodePoint(code: number): string {
  if (!Number.isInteger(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return REPLACEMENT_CHARACTER;
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return " ";
  return String.fromCodePoint(code);
}

/** Raw C0 control characters other than tab, LF and CR. */
// eslint-disable-next-line no-control-regex
const DISALLOWED_CONTROLS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

export function sanitizeHtmlToText(input: string | null | undefined): string {
  if (!input) return "";

  let text = input;

  // Drop tracking pixels and other zero-content tags outright, and script/style bodies.
  text = text.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  text = text.replace(/<img[^>]*>/gi, " ");

  // Convert common block-ish tags to line breaks before stripping, so
  // paragraphs don't run together into one word-soup line.
  text = text.replace(/<\/(p|div|br|li|h[1-6])\s*>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");

  // Strip all remaining tags.
  text = text.replace(/<[^>]*>/g, " ");

  // Decode entities, then re-strip any tags the decoding revealed. Feeds can
  // entity-encode markup (e.g. "&lt;script&gt;") — decoding that naively
  // would hand back live "<...>" text, defeating the whole point of this
  // sanitizer (see docs/research/ai-workflow-recommendations.md 1.2.5 on
  // feed-controlled markup becoming stored XSS downstream). Some feeds even
  // double-encode ("&amp;lt;"), so loop decode+strip to a fixed point with a
  // small iteration cap — real feeds never nest this deep, the cap just
  // bounds worst-case pathological input.
  for (let i = 0; i < 5; i++) {
    const prev = text;
    const decoded = decodeEntities(prev);
    const stripped = decoded.replace(/<[^>]*>/g, " ");
    text = stripped;
    if (stripped === prev) break;
  }
  // Drop raw C0 controls (NUL above all: Postgres text rejects 0x00).
  text = text.replace(DISALLOWED_CONTROLS, "");

  // Safety net: never let a bare angle bracket (one that didn't form a full
  // <tag> above, e.g. a lone "&lt;" with no matching "&gt;") reach output.
  text = text.replace(/[<>]/g, "");

  // Collapse whitespace: multiple spaces -> one, multiple blank lines -> one.
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line, idx, arr) => line.length > 0 || (idx > 0 && arr[idx - 1] !== ""))
    .join("\n")
    .trim();

  return text;
}
