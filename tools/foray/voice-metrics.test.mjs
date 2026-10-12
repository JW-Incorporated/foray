/* voice-metrics.test.mjs — the narration voice scorecard (GV-10, MQ-15..MQ-18).
 *
 * voice-metrics.mjs is a thin wrapper over backend/src/copy/spokenLine.js
 * (decision 16 of docs/roadmap/generation-v2.md): these tests pin that it IS
 * a wrapper (the same functions, not a second copy), the scorecard's own field
 * names and word-weighted aggregates, and the numbers it reports on the frozen
 * what-engineers Foray (tools/foray/fixtures/frozen/data/forays.json, 40
 * narration scripts), with over25 cross-checked by a count made here.
 *
 * Every test names the one-line mutation to voice-metrics.mjs (or
 * spokenLine.js) that turns it red. Run alone: node --test tools/foray/voice-metrics.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import spokenLine from "../../backend/src/copy/spokenLine.js";
import {
  READING_GRADE_BAND,
  splitSentences,
  syllables,
  fleschKincaidGrade,
  sentenceShape,
  speakability,
  filler,
  scoreVoice,
} from "./voice-metrics.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FROZEN = path.join(HERE, "fixtures", "frozen", "data", "forays.json");
const FORAY_ID = "what-engineers-actually-do-all-day-e08236";

function frozenScripts() {
  const doc = JSON.parse(fs.readFileSync(FROZEN, "utf8"));
  const foray = doc.forays.find((f) => f.id === FORAY_ID);
  return foray.items.filter((i) => typeof i.script === "string");
}

const round = (x) => Math.round(x * 1e4) / 1e4;

test("the wrapper re-exports spokenLine.js's own functions, not copies", () => {
  /* MUTATION: paste a local `function syllables(word) {...}` into
     voice-metrics.mjs in place of the re-export -> red. */
  assert.equal(syllables, spokenLine.syllables);
  assert.equal(fleschKincaidGrade, spokenLine.fleschKincaidGrade);
  assert.equal(speakability, spokenLine.speakability);
  assert.equal(filler, spokenLine.filler);
  assert.equal(READING_GRADE_BAND, spokenLine.READING_GRADE_BAND);
  assert.deepEqual(READING_GRADE_BAND, [6, 9]);
  assert.deepEqual(splitSentences("Dr. Smith left. Then he came back!"), ["Dr. Smith left.", "Then he came back!"]);
});

test("the wrapper imports nothing but spokenLine.js", () => {
  /* MUTATION: add `import ... from "./check-narration.mjs"` (or any second
     source of a sentence rule) to voice-metrics.mjs -> red. */
  const src = fs.readFileSync(path.join(HERE, "voice-metrics.mjs"), "utf8");
  const imports = [...src.matchAll(/^import\s.*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["../../backend/src/copy/spokenLine.js"]);
});

test("sentenceShape(text) reports the scorecard's field names over the spoken sentences", () => {
  /* MUTATION: map `maxWords: s.mean` (or drop over25) in sentenceShape -> red. */
  const w = (k) => Array.from({ length: k }, () => "word").join(" ") + ".";
  const shape = sentenceShape([w(26), w(4), w(12)].join(" "));
  assert.deepEqual(shape, { meanWords: 14, maxWords: 26, minWords: 4, sentences: 3, over25: 1, shortShare: 1 / 3 });
});

test("scoreVoice aggregates are word-weighted, and rows carry ids", () => {
  /* MUTATION: average the per-script grades unweighted
     (`sum((r) => r.fkGrade) / rows.length`) -> red. */
  const a = "The cat sat on the mat. The dog ran to the park.";
  const b = "My brother and I walked to the old river each morning before school.";
  const out = scoreVoice([a, { id: "n2", script: b }]);
  assert.equal(out.scripts, 2);
  assert.deepEqual(out.rows.map((r) => r.id), ["#0", "n2"]);
  assert.equal(out.words, 12 + 13);
  const expected = (fleschKincaidGrade(a) * 12 + fleschKincaidGrade(b) * 13) / 25;
  assert.ok(Math.abs(out.fkGrade - expected) < 1e-9, `${out.fkGrade} vs ${expected}`);
  assert.equal(out.sentences, 3);
  assert.equal(out.meanWords, 25 / 3);
  assert.equal(out.maxWords, 13);
  assert.equal(out.scriptsInBand, 0);
  assert.equal(scoreVoice([]).fkGrade, 0);
});

test("scoreVoice on the frozen what-engineers Foray returns its pinned numbers", () => {
  /* MUTATION: change SHORT_SENTENCE_WORDS, the splitter's abbreviation guard,
     the syllable rules or any per-100 count in spokenLine.js -> red. A real
     re-pin is a reviewed change to these numbers, said in the PR. */
  const scripts = frozenScripts();
  assert.equal(scripts.length, 40);
  const out = scoreVoice(scripts);
  assert.deepEqual(
    {
      scripts: out.scripts,
      words: out.words,
      sentences: out.sentences,
      fkGrade: round(out.fkGrade),
      inBand: out.inBand,
      scriptsInBand: out.scriptsInBand,
      meanWords: round(out.meanWords),
      maxWords: out.maxWords,
      over25: out.over25,
      shortShare: round(out.shortShare),
      speakabilityPer100: round(out.speakabilityPer100),
      fillerPer100: round(out.fillerPer100),
    },
    {
      scripts: 40,
      words: 1647,
      sentences: 94,
      fkGrade: 9.4051,
      inBand: false,
      scriptsInBand: 12,
      meanWords: 17.7872,
      maxWords: 68,
      over25: 20,
      shortShare: 0.1489,
      speakabilityPer100: 0.9715,
      fillerPer100: 1.2143,
    }
  );
  assert.equal(out.rows[0].id, "disclosure");
});

test("over25 on the frozen Foray equals a count made here by whitespace word split", () => {
  /* MUTATION: make spokenLine's wordCount skip punctuation-only tokens
     (`.filter((t) => /[A-Za-z0-9]/.test(t))`, so "--" stops counting) -> red:
     the scorecard's over25 drifts from the whitespace count N21 uses. */
  const scripts = frozenScripts();
  let independent = 0;
  for (const item of scripts)
    for (const sentence of splitSentences(item.script))
      if (sentence.split(/\s+/).filter(Boolean).length > 25) independent++;
  assert.equal(scoreVoice(scripts).over25, independent);
  assert.ok(independent > 0, "the fixture should exercise the rule");
});
