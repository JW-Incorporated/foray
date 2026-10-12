/* GV-30 (W3-19): dossier passages are verbatim slices of extracted text.
 * Pure-function tests; no network, no files except reading the fixture and
 * the backend constant this module mirrors. */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { htmlToMarkdown } from "../extract.mjs";
import {
  MAX_PASSAGE_CHARS,
  VerbatimError,
  assertVerbatim,
  cutParagraph,
  cutPassages,
  extractText,
  plainText,
  splitParagraphs,
  stripBackMatter,
} from "./passages.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const FIXTURE = path.join(HERE, "..", "fixtures", "dossiers", "article.html");

const sentence = (i) => `Sentence number ${i} says something plain about the device and its long history here. `;

test("the passage cap is the backend's EVIDENCE_MAX_PASSAGE_CHARS", () => {
  const src = fs.readFileSync(path.join(REPO, "backend", "src", "generation", "gatherEvidence.ts"), "utf8");
  const m = /export const EVIDENCE_MAX_PASSAGE_CHARS = (\d+);/.exec(src);
  assert.ok(m, "gatherEvidence.ts still exports EVIDENCE_MAX_PASSAGE_CHARS");
  assert.equal(MAX_PASSAGE_CHARS, Number(m[1]));
  assert.equal(MAX_PASSAGE_CHARS, 1500);
});

test("plainText removes link targets, cite markers, [edit] and emphasis, and keeps the words", () => {
  const md = [
    "## History\\[[edit](/w/index.php?title=X&action=edit \"Edit section\")\\]",
    "",
    "The **Larkspur** device used [magnetic confinement](/wiki/Magnetic_confinement \"Magnetic confinement\") in 1987.[\\[1\\]](#cite_note-1) Its vessel was _a stubborn doughnut_, see [Mercury](/wiki/Mercury_(planet)).[\\[citation needed\\]](/wiki/Wikipedia:Citation_needed)",
    "",
    "![A photo](/upload/a.jpg) -   a bullet with snake_case_name kept",
  ].join("\n");
  const out = plainText(md);
  assert.equal(
    out,
    "History\n\nThe Larkspur device used magnetic confinement in 1987. Its vessel was a stubborn doughnut, see Mercury.\n\na bullet with snake_case_name kept"
  );
});

test("stripBackMatter cuts at the first References / See also heading", () => {
  const md = "Intro text.\n\n## History\n\nBody.\n\n## See also\n\n- x\n\n## References\n\n1. y";
  assert.equal(stripBackMatter(md), "Intro text.\n\n## History\n\nBody.");
  assert.equal(stripBackMatter("No back matter."), "No back matter.");
  // Wikipedia's section-edit link after the heading text still cuts.
  const edit = "Intro text.\n\n## References\\[[edit](/w/index.php?title=Mercury_(planet)&action=edit \"Edit section\")\\]\n\n1. y";
  assert.equal(stripBackMatter(edit), "Intro text.");
  assert.equal(stripBackMatter("Intro text.\n\n### Notes [edit]\n\n1. y"), "Intro text.");
});

test("stripBackMatter keeps body headings that only start with a back-matter word", () => {
  const md = [
    "Lead para.",
    "",
    "## Sources of fusion fuel",
    "",
    "Deuterium comes from seawater and tritium is bred from lithium in the blanket.",
    "",
    "## Notes on terminology",
    "",
    "More body.",
    "",
    "### Bibliography of early tokamak papers",
    "",
    "Still body.",
    "",
    "## References",
    "",
    "1. y",
  ].join("\n");
  const kept = stripBackMatter(md);
  assert.match(kept, /Deuterium comes from seawater/);
  assert.match(kept, /More body\./);
  assert.match(kept, /Still body\.$/);
  assert.ok(!/1\. y/.test(kept), "the real References heading still cuts");
});

test("splitParagraphs returns exact offsets", () => {
  const text = "First para line one\nline two.\n\n\n  Second para.\n\nThird.";
  const paras = splitParagraphs(text);
  assert.deepEqual(paras.map((p) => p.text), ["First para line one\nline two.", "Second para.", "Third."]);
  for (const p of paras) assert.equal(text.slice(p.offset, p.offset + p.text.length), p.text);
});

test("a paragraph over the cap is cut on sentence ends at <= 1,500 chars", () => {
  const para = Array.from({ length: 40 }, (_, i) => sentence(i)).join("").trim();
  assert.ok(para.length > 2 * MAX_PASSAGE_CHARS);
  const passages = cutPassages(para);
  assert.ok(passages.length >= 3);
  for (const p of passages) {
    assert.ok(p.text.length <= MAX_PASSAGE_CHARS, `passage of ${p.text.length}`);
    assert.match(p.text, /\.$/, "every piece ends on a sentence end");
    assert.match(p.text, /^Sentence number \d+/, "every piece starts on a sentence start");
    assert.equal(para.slice(p.offset, p.offset + p.text.length), p.text);
  }
  // Greedy: each piece is as long as the cap allows (the next sentence would overflow).
  const first = passages[0].text;
  const nextSentence = /^.*?\.(?= |$)/.exec(passages[1].text)[0];
  assert.ok(first.length + 1 + nextSentence.length > MAX_PASSAGE_CHARS);
  assert.ok(first.length > MAX_PASSAGE_CHARS - 100, `greedy, got ${first.length}`);
  // Nothing lost: the pieces cover every sentence, in order.
  assert.equal(passages.map((p) => p.text).join(" "), para);
});

test("a paragraph at exactly the cap is one passage", () => {
  const para = "Ab. ".repeat(MAX_PASSAGE_CHARS / 4).trimEnd() + "x";
  assert.equal(para.length, MAX_PASSAGE_CHARS);
  assert.deepEqual(cutParagraph(para), [{ start: 0, end: MAX_PASSAGE_CHARS }]);
  assert.equal(cutParagraph(`${para}y`).length, 2, "one char over splits");
});

test("one sentence longer than the cap is hard-cut at a space, still verbatim", () => {
  const words = Array.from({ length: 500 }, (_, i) => `word${i}`).join(" ");
  const passages = cutPassages(words);
  assert.ok(passages.length >= 2);
  for (const p of passages) {
    assert.ok(p.text.length <= MAX_PASSAGE_CHARS);
    assert.match(p.text, /^word\d+/);
    assert.match(p.text, /word\d+$/);
  }
  assertVerbatim(passages, words);
});

test("headings, short lines, tables and raw HTML blocks are not passages", () => {
  const text = [
    "History",
    "",
    "| a | b |\n| --- | --- |\n| one two three four five six seven eight | x |",
    "",
    "<table><tr><td>one two three four five six seven eight nine</td></tr></table>",
    "",
    "This paragraph has more than enough words to count as a passage on its own.",
  ].join("\n");
  assert.deepEqual(cutPassages(text).map((p) => p.text), [
    "This paragraph has more than enough words to count as a passage on its own.",
  ]);
});

test("assertVerbatim refuses a retyped passage, a wrong offset and an over-cap passage", () => {
  const text = "The device held plasma for 4.2 seconds. Engineers cheered loudly that night.";
  const good = [{ text: "The device held plasma for 4.2 seconds.", offset: 0 }];
  assert.equal(assertVerbatim(good, text), true);
  assert.throws(() => assertVerbatim([{ text: "The device held plasma for 4.3 seconds.", offset: 0 }], text), VerbatimError);
  assert.throws(() => assertVerbatim([{ text: "Engineers cheered loudly that night.", offset: 0 }], text), VerbatimError);
  assert.throws(() => assertVerbatim([{ text: "x".repeat(MAX_PASSAGE_CHARS + 1), offset: 0 }], "x".repeat(MAX_PASSAGE_CHARS + 1)), VerbatimError);
  assert.throws(() => assertVerbatim([{ text: "The device", offset: -1 }], text), VerbatimError);
});

test("the fixture article: lead, body and a cap-cut paragraph, no infobox, no back matter", () => {
  const { markdown } = htmlToMarkdown(fs.readFileSync(FIXTURE, "utf8"), "https://en.wikipedia.org/wiki/Larkspur_Tokamak");
  const text = extractText(markdown);
  const passages = cutPassages(text);
  assertVerbatim(passages, text);
  assert.equal(passages.length, 5);
  assert.match(passages[0].text, /^The Larkspur Tokamak was an experimental magnetic confinement device/);
  assert.ok(!/\[\d+\]|cite_note|\]\(|<td>|Wikipedia:/.test(passages.map((p) => p.text).join("\n")), "no markup survives");
  assert.ok(!/invented citation|long list entry/.test(text), "References and See also are cut");
  // The History paragraph is over the cap, so it is cut at a sentence end.
  const history = passages.filter((p) => /Construction began|A retired technician/.test(p.text));
  assert.equal(history.length, 2);
  assert.ok(history.every((p) => p.text.length <= MAX_PASSAGE_CHARS && /\.$/.test(p.text)));
  assert.ok(history[0].text.length + history[1].text.length > MAX_PASSAGE_CHARS);
});
