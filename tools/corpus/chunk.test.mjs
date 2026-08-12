/* The chunker had no suite of its own until now — which is how the PR #148
 * heading-stack bug got in and out. The regression it caused is pinned first.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { chunkMarkdown, estTokens, isSeparatorBlock } from "./chunk.mjs";

const para = (n, word = "alpha") => `${word} `.repeat(n).trim();

/* --- heading paths (the #148 regression lives here) ---------------------- */

test("heading_path nests h1 > h2 > h3", () => {
  const c = chunkMarkdown(`# One\n\n${para(400)}\n\n## Two\n\n${para(400)}\n\n### Three\n\n${para(400)}`);
  assert.equal(c.at(-1).heading_path, "One > Two > Three");
});

test("a skipped heading level does not turn a sibling into an ancestor", () => {
  // h1 -> h3 leaves index 1 empty; compacting the hole used to make the NEXT
  // h2 a child of the h3. The stack must stay sparse at its true levels.
  const md = `# Top\n\n${para(400)}\n\n### Deep\n\n${para(400)}\n\n## Sibling\n\n${para(400)}`;
  const c = chunkMarkdown(md);
  assert.equal(c.at(-1).heading_path, "Top > Sibling");
});

test("dropping back to a shallower heading truncates the path", () => {
  const md = `# A\n\n## B\n\n${para(400)}\n\n# C\n\n${para(400)}`;
  assert.equal(chunkMarkdown(md).at(-1).heading_path, "C");
});

/* --- separator / junk removal ------------------------------------------- */

test("isSeparatorBlock catches rules but never data", () => {
  for (const s of ["---", "***", "___", "===", "- - -", "|---|---|"]) {
    assert.ok(isSeparatorBlock(s), `${s} should be a separator`);
  }
  for (const s of ["0.750", "k = 60", "-16 LUFS", "a"]) {
    assert.ok(!isSeparatorBlock(s), `${s} must NOT be treated as a separator`);
  }
});

test("a bare rule never becomes a chunk", () => {
  // 29 of the corpus's 480 chunks were exactly this: pdfToMarkdown joined
  // pages with "\n\n---\n\n", so every page break became its own block.
  const c = chunkMarkdown(`${para(400)}\n\n---\n\n${para(400)}`);
  assert.ok(c.every((x) => x.text.trim() !== "---"));
});

test("content on either side of a rule packs together instead of splitting", () => {
  const c = chunkMarkdown(`${para(60)}\n\n---\n\n${para(60)}`);
  assert.equal(c.length, 1);
});

test("chunks with fewer than five real words are dropped", () => {
  const c = chunkMarkdown(`# H\n\nok\n\n${para(400)}`);
  assert.ok(c.every((x) => (x.text.match(/[A-Za-z][A-Za-z'’-]*/g) || []).length >= 5));
});

test("ordinals stay dense after filtering", () => {
  const c = chunkMarkdown(`${para(400)}\n\n---\n\n***\n\n${para(400)}\n\n---\n\n${para(400)}`);
  assert.deepEqual(c.map((x) => x.ordinal), c.map((_, i) => i));
});

test("a document of nothing but rules yields no chunks", () => {
  assert.deepEqual(chunkMarkdown("---\n\n***\n\n---"), []);
});

test("the junk gate never empties a document that had content", () => {
  // Several real sources (the Apple Developer Forum threads) are one short
  // chunk. Dropping it would delete the source from search while `stats`
  // still reported it ingested — a silent lie, worse than a noisy chunk.
  const c = chunkMarkdown("# Title\n\nOne short paragraph.");
  assert.equal(c.length, 1);
  assert.equal(c[0].ordinal, 0);
});

/* --- sizing -------------------------------------------------------------- */

test("chunks respect the max token budget", () => {
  const c = chunkMarkdown(para(4000), { maxTokens: 300 });
  assert.ok(c.length > 1);
  for (const x of c) assert.ok(x.token_count <= 300 + 60, `oversized chunk: ${x.token_count}`);
});

test("an oversized single block is split at sentence boundaries", () => {
  const sentences = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} carries some words.`).join(" ");
  const c = chunkMarkdown(sentences, { maxTokens: 60 });
  assert.ok(c.length > 1);
  assert.ok(c.some((x) => /\.$/.test(x.text.trim())));
});

test("token_count matches the estimator on the stored text", () => {
  for (const x of chunkMarkdown(`# T\n\n${para(500)}\n\n## U\n\n${para(500)}`)) {
    assert.equal(x.token_count, estTokens(x.text));
  }
});

test("a heading after only a sliver does not orphan it into its own chunk", () => {
  const c = chunkMarkdown(`# A\n\n${para(20)}\n\n## B\n\n${para(400)}`);
  assert.ok(c[0].text.includes("# B") || c.length === 1, "sliver should merge forward");
});

test("fenced code blocks are atomic and are not split by blank lines", () => {
  const md = "# H\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\n" + para(400);
  const c = chunkMarkdown(md);
  const fenced = c.find((x) => x.text.includes("const a"));
  assert.ok(fenced.text.includes("const b"), "fence was split");
});

test("empty and whitespace input yield no chunks", () => {
  assert.deepEqual(chunkMarkdown(""), []);
  assert.deepEqual(chunkMarkdown("   \n\n  \n"), []);
});
