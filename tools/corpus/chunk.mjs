/* Markdown → chunks at semantic boundaries.
 *
 * Targets ~500–1000 estimated tokens per chunk (PLAN.md Workstream B).
 * "Token" here is the chars/4 heuristic by default — documented, cheap, and
 * consistent across the corpus.
 *
 * THE HEURISTIC IS NOW INJECTABLE, and that matters. Measured against
 * `Xenova/bge-small-en-v1.5`'s own tokenizer, chars/4 UNDERCOUNTS this corpus
 * by 7%, and the 1000-token ceiling it enforces lands around 1070 real
 * tokens — past a 512-token model's limit, which truncates SILENTLY. 62% of
 * the corpus was over the line. So the embedding pass passes its model's real
 * tokenizer in as `countTokens` and a much lower ceiling, while every other
 * caller (ingest, FTS5, `stats`) keeps the cheap heuristic, which is entirely
 * adequate for an index with no length limit. `token_count` on each chunk is
 * reported in whatever unit `countTokens` measures.
 *
 * Boundary rules, in priority order:
 * 1. ATX headings always start a new chunk when the current one is at least
 *    MIN_TOKENS (a heading after two sentences shouldn't orphan them).
 * 2. Paragraph/block boundaries flush once the chunk would exceed MAX_TOKENS.
 * 3. A single oversized block (giant paragraph, long table) is split at
 *    sentence boundaries; a sentence longer than MAX just gets hard-split.
 * Each chunk carries its heading_path ("H1 > H2 > H3") for search display
 * and for reconstructing context at retrieval time.
 */

const MIN_TOKENS = 250;
const TARGET_MAX = 1000;
/* A retrieval unit with fewer real words than this cannot answer anything;
 * it only adds noise to the index (and, later, a meaningless vector). */
const MIN_WORDS = 5;

export const estTokens = (s) => Math.ceil(s.length / 4);

/* Tokens that carry meaning. `\p{L}` rather than [A-Za-z] because an
 * ASCII-only test silently deletes non-Latin text, and NUMBERS count because
 * a results table ("0.750", "-16 LUFS", a pricing grid) is exactly the
 * content this corpus is mined for — an ASCII-letters-only gate would drop a
 * whole benchmark table as "junk" while claiming to preserve data points. */
const realWordCount = (s) => (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) || []).length;

/* A thematic break ("---", "***", "___"), a rule of "=", or a line of nothing
 * but bullets/dashes. These are typography, not content: they were never worth
 * a block of their own, and as their OWN chunk they are pure index noise.
 * Deliberately narrow — "0.750" is a data point in a benchmark table and must
 * survive, so this tests for the ABSENCE of alphanumerics, not for shortness. */
export const isSeparatorBlock = (s) => /^[\s\-*_=~•·—–+|]+$/.test(s);

/* Characters per token, measured on the string at hand rather than assumed.
 * Under the default chars/4 heuristic this is always 4, so the hard-split
 * below cuts exactly where it always did; under a real tokenizer it adapts
 * (English BPE runs ~4.3 chars/token, and code or tables run far lower).
 * FLOOR, not round: underestimating chars-per-token makes the cut shorter
 * than the ceiling, which is the safe direction — the loop simply iterates
 * again, whereas overestimating would push a piece past the limit. */
const charsPerToken = (s, countTokens) => Math.max(1, Math.floor(s.length / Math.max(1, countTokens(s))));

function splitOversized(block, maxTokens, countTokens) {
  const sentences = block.split(/(?<=[.!?])\s+(?=[A-Z0-9"'([])/);
  const parts = [];
  let cur = "";
  for (let s of sentences) {
    while (countTokens(s) > maxTokens) {
      // Pathological sentence (minified text, giant table row): hard split.
      const cut = charsPerToken(s, countTokens) * maxTokens;
      if (cur) { parts.push(cur); cur = ""; }
      parts.push(s.slice(0, cut));
      s = s.slice(cut);
    }
    if (cur && countTokens(cur) + countTokens(s) > maxTokens) {
      parts.push(cur);
      cur = s;
    } else {
      cur = cur ? `${cur} ${s}` : s;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

/**
 * @param {string} markdown
 * @param {object} [opts]
 * @param {number}   [opts.minTokens=250]
 * @param {number}   [opts.maxTokens=1000]
 * @param {(s:string)=>number} [opts.countTokens=estTokens]  the length unit;
 *   inject a real tokenizer to chunk for a model with a hard input limit.
 * @returns {Array<{ordinal, heading_path, text, token_count}>}
 */
export function chunkMarkdown(
  markdown,
  { minTokens = MIN_TOKENS, maxTokens = TARGET_MAX, countTokens = estTokens } = {}
) {
  const lines = markdown.split("\n");

  /* Pass 1: group lines into blocks (paragraphs, fenced code, headings),
   * tracking the heading stack. Fenced code blocks are atomic. */
  const blocks = [];
  let headingStack = [];
  let buf = [];
  let inFence = false;

  const flushBuf = () => {
    const text = buf.join("\n").trim();
    /* Separator blocks are dropped here, before packing, so that the content
     * on either side of a rule packs together instead of being split by it. */
    if (text && !isSeparatorBlock(text)) {
      blocks.push({ text, headingPath: headingStack.filter(Boolean).join(" > ") });
    }
    buf = [];
  };

  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      buf.push(line);
      continue;
    }
    if (inFence) { buf.push(line); continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushBuf();
      const level = h[1].length;
      // The stack stays SPARSE at its true levels: compacting holes (h1→h3
      // leaves index 1 empty) would break the level↔index correspondence and
      // turn siblings into ancestors. Holes are skipped only at join time.
      headingStack = headingStack.slice(0, level - 1);
      headingStack[level - 1] = h[2].trim();
      blocks.push({
        text: line.trim(),
        headingPath: headingStack.filter(Boolean).join(" > "),
        isHeading: true,
      });
      continue;
    }
    if (line.trim() === "") { flushBuf(); continue; }
    buf.push(line);
  }
  flushBuf();

  /* Pass 2: pack blocks into chunks. */
  const chunks = [];
  let cur = null;

  const flushChunk = () => {
    if (cur && cur.text.trim()) {
      chunks.push({
        ordinal: chunks.length,
        heading_path: cur.headingPath,
        text: cur.text.trim(),
        token_count: countTokens(cur.text.trim()),
      });
    }
    cur = null;
  };

  for (const block of blocks) {
    const blockTokens = countTokens(block.text);

    if (block.isHeading && cur && countTokens(cur.text) >= minTokens) flushChunk();

    if (blockTokens > maxTokens) {
      flushChunk();
      for (const part of splitOversized(block.text, maxTokens, countTokens)) {
        chunks.push({
          ordinal: chunks.length,
          heading_path: block.headingPath,
          text: part.trim(),
          token_count: countTokens(part.trim()),
        });
      }
      continue;
    }

    if (cur && countTokens(cur.text) + blockTokens > maxTokens) flushChunk();

    if (!cur) {
      cur = { text: block.text, headingPath: block.headingPath };
    } else {
      cur.text += `\n\n${block.text}`;
      // The most recent heading names the chunk: a chunk that opens with two
      // stray sentences and then "## Alpha" is about Alpha, not about "".
      if (block.isHeading) cur.headingPath = block.headingPath;
    }
  }
  flushChunk();

  /* A trailing sliver reads better merged into its predecessor. Expressed as
   * a fraction of the ceiling rather than a hard 60 so it scales with the
   * length unit — at the default 1000 it is exactly the 60 it always was. */
  const sliver = maxTokens * 0.06;
  if (chunks.length >= 2) {
    const last = chunks[chunks.length - 1];
    const prev = chunks[chunks.length - 2];
    if (last.token_count < sliver && prev.token_count + last.token_count <= maxTokens + sliver) {
      prev.text += `\n\n${last.text}`;
      prev.token_count = countTokens(prev.text);
      chunks.pop();
    }
  }

  /* Final gate: drop content-free chunks, then renumber so ordinals stay
   * dense (chunks has UNIQUE(document_id, ordinal); holes would be legal but
   * would make "chunk 7 of 12" a lie).
   *
   * The gate must never empty a document that had content. Several real
   * sources are a single short paragraph — the Apple Developer Forum threads
   * are one chunk each — and silently dropping the last chunk would delete a
   * whole source from search while `stats` still counted it as ingested. So
   * this filter removes NOISE FROM a document; it is not allowed to remove
   * the document. */
  const kept = chunks.filter((c) => realWordCount(c.text) >= MIN_WORDS);
  const final = kept.length || !chunks.length ? kept : chunks;
  return final.map((c, i) => ({ ...c, ordinal: i }));
}
