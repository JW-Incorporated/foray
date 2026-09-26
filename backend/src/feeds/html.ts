/**
 * Minimal, dependency-free HTML -> plain text sanitizer for show-note soup
 * (corner case 5): CDATA-wrapped HTML, tracking pixels, stray entities.
 * Not a rendering engine — good enough to hand clean text to an LLM or to
 * display safely. Strips script/style bodies entirely, drops all tags,
 * decodes common entities, and collapses whitespace.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“"
};

/**
 * Decodes named + numeric (decimal and hex) HTML/XML entities. Exported
 * separately from sanitizeHtmlToText because titles need entity decoding
 * too but must NOT go through tag-stripping/whitespace-collapsing — see
 * corner case finding in fixtures/feeds/README.md: fast-xml-parser does
 * not decode numeric character references (e.g. WordPress/PowerPress
 * feeds emitting "&#038;" for a literal "&" in episode titles) even with
 * its default entity-processing options, since those only cover the five
 * predefined named XML entities.
 */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return decodeCodePoint(parseInt(entity.slice(2), 16), match);
    }
    if (entity.startsWith("#")) {
      // "#1f" is not a decimal reference; leave it as written.
      if (!/^#\d+$/.test(entity)) return match;
      return decodeCodePoint(parseInt(entity.slice(1), 10), match);
    }
    // Own-property lookup only: a plain object literal would otherwise hand
    // back Object.prototype members for "&constructor;" / "&toString;".
    return Object.hasOwn(NAMED_ENTITIES, entity) ? (NAMED_ENTITIES[entity] as string) : match;
  });
}

/** U+FFFD, the Unicode replacement character. */
const REPLACEMENT_CHARACTER = "\uFFFD";

/**
 * One never-throwing, range-checked decoder for a numeric character
 * reference. String.fromCodePoint throws RangeError above U+10FFFF, which
 * used to take the whole of parseFeed (and a show's episode page) down on a
 * single malformed `&#99999999;`. Rules:
 *   - NUL and the C0 controls other than tab/LF/CR decode to nothing
 *     (Postgres text rejects 0x00, and XML 1.0 forbids the rest);
 *   - surrogates, anything above U+10FFFF, and non-numbers become U+FFFD;
 *   - everything else decodes normally.
 */
function decodeCodePoint(code: number, match: string): string {
  if (!Number.isFinite(code)) return match;
  if (code >= 0 && code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return "";
  if (code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return REPLACEMENT_CHARACTER;
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
