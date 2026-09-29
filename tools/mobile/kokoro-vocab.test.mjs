/* The phoneme-to-id table, and the passage that was mapped through it.
 *
 * `docs/bundled-voice-plan.md` K-01/K-02. The ids in
 * `tools/mobile/kokoro-probe-passage.json` are the ONLY thing the phone ever
 * sees of our text — the whole deck's §4 design is that no grapheme-to-phoneme
 * code ships — so they are the one artefact in this repo whose wrongness would
 * be completely invisible at run time. A wrong id is not a crash and not
 * silence: it is a different phoneme, sung fluently, in a measurement a founder
 * then quotes.
 *
 * WHY THIS SUITE IS IN NODE AND NOT IN PYTHON. `tools/narration/phonemize.py`
 * produced these ids, and its own suite (`phonemize.test.mjs`) can only reach
 * the parts of it that run without misaki — which is not installed here and not
 * on CI. This suite needs neither misaki nor Python: it re-derives everything
 * checkable from two committed files. So the ids are checked on every CI run,
 * on a machine that could not have produced them.
 *
 * WHAT IT CANNOT CHECK, said plainly: whether misaki's IPA for a given English
 * word is the RIGHT IPA. Nothing in this repo can answer that — it is misaki's
 * dictionary, or espeak's guess, and the passage records which of the two
 * every word came from (`espeak_fallback`). What this suite checks is that the
 * ids are a faithful, lossless encoding of the phoneme string that was
 * recorded next to them, against the model's own table.
 *
 * Every test names the mutation that turns it red.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

const VOCAB = readJson("tools/narration/kokoro-vocab.json");
const PASSAGE = readJson("tools/mobile/kokoro-probe-passage.json");

/** The canonical form `phonemize.py`'s `vocab_sha()` hashes, rebuilt in Node.
    `sort_keys=True, separators=(",",":"), ensure_ascii=False` in Python is a
    key-sorted object through `JSON.stringify` here; both languages sort BMP
    keys by code point and neither escapes non-ASCII, so the bytes are the
    same — which is the point, and is why this is recomputed rather than
    copied. */
function canonicalVocabSha(table) {
  const ordered = {};
  for (const k of Object.keys(table).sort()) ordered[k] = table[k];
  const blob = Buffer.from(JSON.stringify(ordered), "utf8");
  return "sha256:" + crypto.createHash("sha256").update(blob).digest("hex").slice(0, 16);
}

/* ---------- the table ---------- */

test("the id table is the model's own, with the provenance to prove it", () => {
  /* The table is NOT a transcription of a table seen in a blog post: it was
     extracted from `tokenizer.json` in the same Hugging Face repository
     `fetch-models.mjs` pins the weights from, and that file's sha256 and byte
     length are recorded here so the extraction can be repeated and checked.
     MUTATION: blank `source_sha256` — the table becomes a claim with no
     receipt, which is the state the whole pin table exists to forbid. */
  assert.match(VOCAB.source_url, /^https:\/\/huggingface\.co\/onnx-community\/Kokoro-82M-v1\.0-ONNX\//);
  assert.match(VOCAB.source_sha256, /^[0-9a-f]{64}$/);
  assert.ok(Number.isInteger(VOCAB.source_bytes) && VOCAB.source_bytes > 0);
  assert.equal(Object.keys(VOCAB.table).length, 115, "the v1.0 export's vocabulary is 115 symbols");
});

test("the id table and the model pin name the same upstream file", () => {
  /* THE LOOP THAT CLOSES WITHOUT A NETWORK. `fetch-models.mjs` carries a
     `tokenizer` pin whose sha256 was measured from the same download this
     table was extracted from. If somebody re-pins the tokenizer at a new
     revision and does not re-extract the table, the two hashes part company
     and this goes red — which is exactly the "version coupling" failure deck
     §5 item 8 describes, caught in CI instead of on a phone.
     MUTATION: change either sha256. */
  return import("./fetch-models.mjs").then(({ PINS }) => {
    const tok = PINS.find((p) => p.kind === "tokenizer");
    assert.ok(tok, "there must be a pin for the file the id table came from");
    assert.equal(tok.sha256, VOCAB.source_sha256);
    assert.equal(tok.bytes, VOCAB.source_bytes);
    assert.equal(tok.url, VOCAB.source_url);
  });
});

test("ids are contiguous-free but unique, and the pad is 0", () => {
  /* The upstream table is deliberately sparse — it has gaps where symbols were
     removed between Kokoro revisions — so "no gaps" is the WRONG assertion and
     is not made. What must hold is that no two phonemes share an id.
     MUTATION: point two phonemes at the same id. */
  const ids = Object.values(VOCAB.table);
  assert.equal(new Set(ids).size, ids.length, "two phonemes with one id is a silent mispronunciation");
  assert.equal(VOCAB.pad_id, 0);
  assert.equal(VOCAB.table["$"], 0, "the pad symbol is the table's own zero");
});

/* ---------- the passage ---------- */

test("the passage's vocab stamp is the sha of the committed table", () => {
  /* `tts.vocab` is what the player version-checks before it speaks (deck §5
     item 8). If the stamp were computed from anything but this table, the
     check would pass on items the app cannot sing.
     MUTATION: change one id in kokoro-vocab.json — the sha moves and the
     passage's stamp no longer matches it. */
  assert.equal(PASSAGE.vocab, canonicalVocabSha(VOCAB.table));
});

/** Every sentence chunk in the passage, with the line it belongs to (KV-R2:
    one inference per chunk, and the ids live on the chunk). */
const CHUNKS = PASSAGE.lines.flatMap((line) => (line.chunks ?? []).map((chunk, i) => ({ line, chunk, at: `${line.id}#${i}` })));

test("every chunk's ids decode back to exactly that chunk's phonemes", () => {
  /* THE TEST THIS FILE EXISTS FOR. Decoding id -> phoneme through the reversed
     table and re-joining must reproduce the recorded string character for
     character, with one pad at each end and nothing dropped.
     MUTATION: delete one id from any chunk in the passage — the decode comes up
     one phoneme short. This is the mutation that matters, because a
     silent-skip mapper (kokoro-onnx's own `VOCAB.get` filter) produces exactly
     that file and nothing else in the repo would notice. */
  const byId = new Map(Object.entries(VOCAB.table).map(([ph, id]) => [id, ph]));
  assert.ok(PASSAGE.lines.length > 0);
  assert.ok(CHUNKS.length >= PASSAGE.lines.length, "every line has at least one chunk");
  for (const { chunk, at } of CHUNKS) {
    assert.ok(Array.isArray(chunk.ids) && chunk.ids.length > 2, `${at}: no ids`);
    assert.equal(chunk.ids[0], VOCAB.pad_id, `${at}: missing the leading pad`);
    assert.equal(chunk.ids.at(-1), VOCAB.pad_id, `${at}: missing the trailing pad`);
    const decoded = chunk.ids.slice(1, -1).map((id) => {
      assert.ok(byId.has(id), `${at}: id ${id} is not in the table`);
      return byId.get(id);
    }).join("");
    assert.equal(decoded, chunk.phonemes, `${at}: ids and phonemes disagree`);
  }
});

test("every chunk is ≤ 460 code points and maps to the committed ids", () => {
  /* KV-R2 / D3: one inference per SENTENCE CHUNK, cut by `phonemize.py`'s
     `sentence_chunks`, so no inference is handed more than 460 code points and
     each has its own style row. The line's `phonemes` is its chunks joined by
     "\n" (D3's wire shape), and each chunk's ids are one per CODE POINT plus
     the two pads — a combining mark such as U+0303 is one id, not zero.
     MUTATION: put a whole line back as ONE chunk — the passage no longer has
     its fifteen sentence chunks, and a 415-phoneme inference is back.
     MUTATION: count UTF-16 units — a line with a combining mark disagrees. */
  assert.equal(CHUNKS.length, 15, "the passage's four lines are fifteen sentence chunks");
  for (const line of PASSAGE.lines) {
    assert.ok(!("ids" in line), `${line.id}: a whole-line ids array is the inference nothing should run`);
    assert.equal(line.phonemes, line.chunks.map((c) => c.phonemes).join("\n"),
      `${line.id}: the line's phonemes are its chunks joined by a newline`);
  }
  for (const { chunk, at } of CHUNKS) {
    const points = [...chunk.phonemes].length;
    assert.ok(points <= 460, `${at}: ${points} code points is over the 460 chunk limit`);
    assert.ok(points >= 24 || CHUNKS.find((x) => x.chunk === chunk).line.chunks.length === 1,
      `${at}: a chunk under 24 code points should have merged into its neighbour`);
    assert.equal(chunk.ids.length, points + 2, `${at}: one id per code point, plus the pads`);
    assert.equal(chunk.style_row, Math.min(chunk.ids.length - 2, 509), `${at}: the style row is min(padded - 2, 509)`);
    assert.ok(chunk.ids.length <= VOCAB.max_input_ids, `${at}: over the graph's input_ids limit`);
    assert.ok(Number.isFinite(chunk.est_sec) && chunk.est_sec > 0, `${at}: no expected seconds`);
  }
  /* The chunks share out their line's estimate, so the passage's total is the
     planning total it always was. */
  for (const line of PASSAGE.lines) {
    const sum = line.chunks.reduce((n, c) => n + c.est_sec, 0);
    assert.ok(Math.abs(sum - line.est_sec) < 0.01, `${line.id}: chunk estimates sum to ${sum}, the line says ${line.est_sec}`);
  }
});

test("the passage records which words espeak guessed at, and says the fixture is not yet evidence", () => {
  /* THE HONESTY FIELD. 82 of the lexicon's 83 `ipa` entries are null, so five
     of the six terms the fixture line exists to test were phonemized by
     espeak-ng rather than by an authored override. That is fine for K-01 (a
     guessed pronunciation takes the same time to sing) and NOT fine for K-03's
     audition. A passage that hid this would let a founder rank twelve voices
     on a line none of them can pronounce correctly.
     MUTATION: drop `espeak_fallback_terms` — the caveat disappears and the
     fixture reads as a pronunciation test it is not. */
  assert.ok(Array.isArray(PASSAGE.espeak_fallback_terms));
  const guessed = new Set(PASSAGE.espeak_fallback_terms);
  const fixtureTerms = PASSAGE.lexicon_terms.filter((t) => guessed.has(t));
  assert.ok(fixtureTerms.length > 0,
    "if no lexicon term needed espeak any more, someone authored the IPA — update this test and the note");
  assert.match(PASSAGE["//espeak"], /cannot be evidence about pronunciation control/);
  for (const line of PASSAGE.lines) {
    assert.ok(Array.isArray(line.espeak_fallback), `${line.id}: no per-line espeak record`);
  }
});
