/* Markdown → chunks at semantic boundaries.
 *
 * Targets ~500–1000 estimated tokens per chunk (PLAN.md Workstream B).
 * "Token" here is the chars/4 heuristic — documented, cheap, and consistent
 * across the corpus; exact tokenization waits for the embedding backfill
 * pass, which can re-chunk if its model disagrees.
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

export const estTokens = (s) => Math.ceil(s.length / 4);

function splitOversized(block, maxTokens) {
  const sentences = block.split(/(?<=[.!?])\s+(?=[A-Z0-9"'([])/);
  const parts = [];
  let cur = "";
  for (let s of sentences) {
    while (estTokens(s) > maxTokens) {
      // Pathological sentence (minified text, giant table row): hard split.
      const cut = maxTokens * 4;
      if (cur) { parts.push(cur); cur = ""; }
      parts.push(s.slice(0, cut));
      s = s.slice(cut);
    }
    if (cur && estTokens(cur) + estTokens(s) > maxTokens) {
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
 * @returns {Array<{ordinal, heading_path, text, token_count}>}
 */
export function chunkMarkdown(markdown, { minTokens = MIN_TOKENS, maxTokens = TARGET_MAX } = {}) {
  const lines = markdown.split("\n");

  /* Pass 1: group lines into blocks (paragraphs, fenced code, headings),
   * tracking the heading stack. Fenced code blocks are atomic. */
  const blocks = [];
  let headingStack = [];
  let buf = [];
  let inFence = false;

  const flushBuf = () => {
    const text = buf.join("\n").trim();
    if (text) blocks.push({ text, headingPath: headingStack.filter(Boolean).join(" > ") });
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
        token_count: estTokens(cur.text.trim()),
      });
    }
    cur = null;
  };

  for (const block of blocks) {
    const blockTokens = estTokens(block.text);

    if (block.isHeading && cur && estTokens(cur.text) >= minTokens) flushChunk();

    if (blockTokens > maxTokens) {
      flushChunk();
      for (const part of splitOversized(block.text, maxTokens)) {
        chunks.push({
          ordinal: chunks.length,
          heading_path: block.headingPath,
          text: part.trim(),
          token_count: estTokens(part.trim()),
        });
      }
      continue;
    }

    if (cur && estTokens(cur.text) + blockTokens > maxTokens) flushChunk();

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

  /* A trailing sliver reads better merged into its predecessor. */
  if (chunks.length >= 2) {
    const last = chunks[chunks.length - 1];
    const prev = chunks[chunks.length - 2];
    if (last.token_count < 60 && prev.token_count + last.token_count <= maxTokens + 60) {
      prev.text += `\n\n${last.text}`;
      prev.token_count = estTokens(prev.text);
      chunks.pop();
    }
  }

  return chunks;
}
