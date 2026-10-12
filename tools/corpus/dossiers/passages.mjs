/* Dossier passages: extracted markdown -> plain text -> verbatim passages.
 *
 * GV-30 (W3-19, docs/roadmap/generation-v2.md). A dossier holds FETCHED text,
 * never a model's retyping of it (F-48), so every passage this module returns
 * is a slice of one string, the source's extracted text, and carries the
 * offset it was sliced at. `assertVerbatim` proves that before anything is
 * written, and the builder calls it on every source.
 *
 * "Extracted text" is the markdown from extract.mjs's htmlToMarkdown (or
 * pdfToMarkdown) with two deterministic code passes applied, nothing else:
 *
 * 1. `stripBackMatter` cuts the document at the first References / Notes /
 *    See also / External links / Further reading heading. What follows those
 *    headings on an encyclopedia page is citation lists and link farms, which
 *    are not facts a narrator can quote.
 * 2. `plainText` removes markdown SYNTAX that turndown added (link targets,
 *    images, emphasis markers, backslash escapes, list bullets, heading
 *    hashes) and Wikipedia's inline citation and [edit] markers. The words
 *    themselves are untouched. Downstream (GV-69) the narration quote gate
 *    compares quotes against passage text by substring, so a passage that
 *    still read "[fusion](https://...)" would refuse every honest quote.
 *
 * Then: paragraphs are the blank-line-separated blocks of the plain text;
 * a paragraph of at most MAX_PASSAGE_CHARS is one passage, and a longer one is
 * cut on sentence ends into passages of at most MAX_PASSAGE_CHARS (a single
 * sentence longer than the cap is hard-cut at the last space before it).
 * Blocks with fewer than MIN_PASSAGE_WORDS words (headings, captions, stray
 * table cells) and table, raw-HTML and code blocks are not passages.
 */

/* The backend's print-passage cap (backend/src/generation/gatherEvidence.ts,
   EVIDENCE_MAX_PASSAGE_CHARS). A dossier passage longer than it would be
   truncated mid-sentence at request time; passages.test.mjs pins the two
   equal by reading the backend source. */
export const MAX_PASSAGE_CHARS = 1500;

/* A block with fewer real words than this is a heading, caption or stray
   cell, not a passage anyone can quote a fact from. */
export const MIN_PASSAGE_WORDS = 8;

/* The heading must be ONLY one of these names, optionally followed by
   Wikipedia's section-edit link as turndown writes it
   ("\[[edit](/w/index.php?...)\]") or a bare "[edit]", so a body heading
   that merely STARTS with one ("Sources of fusion fuel", "Notes on
   terminology") keeps its text. */
const BACK_MATTER = /^#{1,6}[ \t]*(?:References|Notes|Notes and references|See also|External links|Further reading|Bibliography|Sources|Citations|Footnotes)[ \t]*(?:\\?\[(?:\[edit\]\((?:[^()\n]|\([^()\n]*\))*\)|edit)\\?\])?[ \t]*$/im;

/** Drops everything from the first back-matter heading on. */
export function stripBackMatter(markdown) {
  const m = BACK_MATTER.exec(markdown);
  return m ? markdown.slice(0, m.index).trimEnd() : markdown;
}

/* `[text](target "title")` where text may hold escaped brackets
   (turndown writes a cite link's "[1]" as "\[1\]"), and target may hold one
   level of parentheses (Wikipedia titles like Mercury_(planet)). */
const LINK = /\[((?:\\.|[^\]\\])*)\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"]*")?\)/g;
const IMAGE = /!\[(?:\\.|[^\]\\])*\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"]*")?\)/g;
const ESCAPE = /\\([\\`*_{}[\]()#+\-.!>|~=])/g;
/* Wikipedia's inline markers, AFTER link text is unwrapped and escapes are
   undone: [1], [12], [a], [note 3], [citation needed], [edit], ... */
const CITE = /\[(?:\d{1,4}|[a-z]|note \d{1,4}|nb \d{1,4}|citation needed|clarification needed|when\?|who\?|according to whom\?|edit|update)\]/gi;

/** Markdown -> plain text, removing syntax and inline markers only. */
export function plainText(markdown) {
  let s = String(markdown ?? "").replace(/\r\n?/g, "\n");
  s = s.replace(IMAGE, "");
  // Repeat: a link's text can itself be a link-shaped cite marker.
  for (let i = 0; i < 3; i++) {
    const next = s.replace(LINK, "$1");
    if (next === s) break;
    s = next;
  }
  s = s.replace(ESCAPE, "$1");
  s = s.replace(CITE, "");
  s = s
    .split("\n")
    .map((line) =>
      line
        .replace(/^#{1,6}[ \t]+/, "")
        .replace(/^[ \t]*(?:[-*+]|\d{1,3}[.)])[ \t]+/, "")
        .replace(/^>[ \t]?/, "")
        .replace(/\*\*|__/g, "")
        .replace(/(^|[\s(])[*_](?=\S)([^*_\n]*?\S)[*_](?=$|[\s).,;:!?])/g, "$1$2")
        .replace(/[ \t]+/g, " ")
        .replace(/ +([.,;:!?])/g, "$1")
        .trim()
    )
    .join("\n");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

/** extract.mjs markdown -> the one string every passage is sliced from. */
export function extractText(markdown) {
  return plainText(stripBackMatter(markdown));
}

const wordCount = (s) => (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) || []).length;

/** Blank-line-separated blocks of `text`, each {text, offset} with
    text === source.slice(offset, offset + text.length). */
export function splitParagraphs(text) {
  const out = [];
  const re = /[^\n](?:[^\n]|\n(?![ \t]*\n))*/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const body = raw.trim();
    if (body) out.push({ text: body, offset: m.index + lead });
  }
  return out;
}

/* Tables (gfm pipes, or raw HTML turndown kept, e.g. an infobox with no
   header row) and code fences are not prose a narrator quotes. */
const isTableOrCode = (block) =>
  block.startsWith("```") ||
  /^<[a-z!/]/i.test(block) ||
  block.split("\n").every((l) => /^\|.*\|$/.test(l.trim()));

/* Sentence ends: terminal punctuation, optional closing quotes/brackets, then
   whitespace. Each cut is {end, next}: `end` is just past the punctuation
   (where a piece stops) and `next` just past the whitespace (where the next
   piece starts). */
function sentenceCuts(s) {
  const cuts = [];
  const re = /[.!?]["'”’)\]]*(\s+)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const next = m.index + m[0].length;
    cuts.push({ end: next - m[1].length, next });
  }
  return cuts;
}

/** One paragraph -> pieces of at most maxChars, cut on sentence ends.
    Pieces are {start, end} into the paragraph text, with no leading or
    trailing whitespace. */
export function cutParagraph(text, maxChars = MAX_PASSAGE_CHARS) {
  if (text.length <= maxChars) return [{ start: 0, end: text.length }];
  const cuts = sentenceCuts(text);
  const pieces = [];
  let start = 0;
  while (text.length - start > maxChars) {
    // The furthest sentence end that keeps this piece within the cap.
    let cut = null;
    for (const c of cuts) {
      if (c.end <= start) continue;
      if (c.end - start > maxChars) break;
      cut = c;
    }
    if (!cut) {
      // One sentence longer than the cap: hard-cut at the last space.
      const sp = text.lastIndexOf(" ", start + maxChars);
      cut = sp > start ? { end: sp, next: sp + 1 } : { end: start + maxChars, next: start + maxChars };
    }
    pieces.push({ start, end: cut.end });
    start = cut.next;
  }
  pieces.push({ start, end: text.length });
  // Trim each piece's whitespace without leaving the paragraph.
  return pieces
    .map(({ start: s, end: e }) => {
      let ee = e;
      while (ee > s && /\s/.test(text[ee - 1])) ee--;
      let ss = s;
      while (ss < ee && /\s/.test(text[ss])) ss++;
      return { start: ss, end: ee };
    })
    .filter((p) => p.end > p.start);
}

/** Extracted text -> passages {text, offset} in document order. */
export function cutPassages(extracted, { maxChars = MAX_PASSAGE_CHARS, minWords = MIN_PASSAGE_WORDS } = {}) {
  const out = [];
  for (const para of splitParagraphs(extracted)) {
    if (isTableOrCode(para.text)) continue;
    for (const piece of cutParagraph(para.text, maxChars)) {
      const text = para.text.slice(piece.start, piece.end);
      if (wordCount(text) < minWords) continue;
      out.push({ text, offset: para.offset + piece.start });
    }
  }
  return out;
}

export class VerbatimError extends Error {
  constructor(message) {
    super(message);
    this.name = "VerbatimError";
  }
}

/** Throws unless every passage is the exact slice of `extracted` at its
    offset, and within the cap. The builder refuses to write otherwise. */
export function assertVerbatim(passages, extracted, { maxChars = MAX_PASSAGE_CHARS } = {}) {
  for (const [i, p] of passages.entries()) {
    if (typeof p?.text !== "string" || !Number.isInteger(p.offset) || p.offset < 0) {
      throw new VerbatimError(`passage ${i}: missing text or offset`);
    }
    if (p.text.length === 0 || p.text.length > maxChars) {
      throw new VerbatimError(`passage ${i}: length ${p.text.length} outside 1..${maxChars}`);
    }
    if (extracted.slice(p.offset, p.offset + p.text.length) !== p.text) {
      throw new VerbatimError(`passage ${i}: not a verbatim substring of the extracted text at offset ${p.offset}`);
    }
  }
  return true;
}
