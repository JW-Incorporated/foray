/* RV-12 (docs/roadmap/recommender-v1.md, D4 (d), D10): evidence-pack embeddings.

   Fixtures only (tools/recommender/fixtures/) and the `stub` embedder or a fake
   one: no test downloads a model, loads the transformers runtime or touches the
   network. Output goes to a fresh temp directory, never data-local/.

   Every test names the one-line mutation that turns it red; each was run. */

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STUB_DIM, createPassageEmbedder } from "../passage-index/embedder.mjs";
import { DATAMARK, STRIPPED_KEYS, buildEvidence, loadSources, publisherPattern, undatamark } from "./evidence.mjs";
import { MAX_EMBED_CHARS, checkEmbeddings, keysFor, main, runEmbed, textForEmbedding } from "./embed.mjs";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const FIXTURE_ENV = {
  RECOMMENDER_CATALOG_PATH: path.join(FIX, "catalog.json"),
  RECOMMENDER_BREADTH_PATH: path.join(FIX, "catalog-breadth.json"),
  RECOMMENDER_CLASSIFICATION_PATH: path.join(FIX, "breadth-classification.json"),
  RECOMMENDER_EPISODE_ARCHIVE_PATH: path.join(FIX, "episode-archive.json.gz"),
  RECOMMENDER_AVAILABILITY_PATH: path.join(FIX, "no-such-transcript-availability.json"),
  RECOMMENDER_RSS_DIR: path.join(FIX, "rss"),
  RECOMMENDER_TRANSCRIPTS_DIR: path.join(FIX, "transcripts", "normalized"),
};

function tmpEnv(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rv12-embed-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, env: { ...FIXTURE_ENV, RECOMMENDER_EMBEDDINGS_DIR: path.join(dir, "embeddings"), ...extra } };
}

const sink = () => {
  const s = { text: "", write: (x) => (s.text += x) };
  return s;
};

/** The stub, with every text it is asked to embed recorded. */
function countingStub(seen) {
  return async (opts) => {
    const inner = await createPassageEmbedder(opts);
    return { model: inner.model, embed: (texts) => (seen.push(...texts), inner.embed(texts)) };
  };
}

const readOut = (dir) => {
  const file = path.join(dir, "embeddings", "stub-stub-hash.json");
  return { file, doc: JSON.parse(fs.readFileSync(file, "utf8")) };
};

/* Mutation (run): store one component short (`Array.from(vectors[j], round)`
   -> `Array.from(vectors[j], round).slice(0, model.dim - 1)`), i.e. 63 dims --
   every stored vector has 63 entries. */
test("stub embeds the fixture packs at STUB_DIM", async (t) => {
  const { dir, env } = tmpEnv(t);
  const out = sink();
  const code = await main(["--keys", "curated", "--embedder", "stub", "--limit", "2"], { env, stdout: out, stderr: sink() });
  assert.equal(code, 0);
  const { doc } = readOut(dir);
  assert.deepEqual(doc.keys, ["tx-show", "note-only"]);
  assert.deepEqual(doc.model, { name: "stub-hash", revision: "1", dim: STUB_DIM });
  assert.equal(doc.vectors.length, 2);
  for (const v of doc.vectors) {
    assert.equal(v.length, STUB_DIM);
    assert.ok(v.some((x) => x > 0), "a stub vector is never zero");
  }
  assert.deepEqual(checkEmbeddings(doc), []);
  assert.equal(JSON.parse(out.text).embedded, 2);
});

/* Mutation (run): feed the datamarked text (`MARK_RUN` -> /\s+/g, so U+02C6
   survives into the text). Also red (run): serialise the whole pack
   (`textForEmbedding` returns `JSON.stringify(pack)`), which carries the
   audit `stripped` key names. */
test("textForEmbedding is undatamarked and carries no stripped field", () => {
  const sources = loadSources({ env: FIXTURE_ENV });
  const publishers = [...sources.breadth.values(), ...sources.curated.values()].map((r) => r.artist_name).filter((n) => typeof n === "string" && n.length >= 2);
  let checked = 0;
  for (const key of keysFor("all", sources)) {
    const pack = buildEvidence(key, sources);
    if (pack.tier === "none") continue;
    checked++;
    const text = textForEmbedding(pack);
    assert.ok(!text.includes(DATAMARK), `${key}: no datamark`);
    // The snake_case names only: a bare "dai" would match "daily".
    for (const k of STRIPPED_KEYS.filter((s) => s.includes("_"))) assert.ok(!text.includes(k), `${key}: no ${k}`);
    // Whole tokens, as evidence.mjs redacts them (777 keeps "Islamic" while its publisher is "Islami").
    for (const p of publishers) assert.ok(!publisherPattern(p).test(text), `${key}: no publisher ${p}`);
    assert.ok(text.startsWith(pack.title), `${key}: the title leads`);
    if (pack.blurb) assert.ok(text.includes(undatamark(pack.blurb).replace(/\s+/g, " ")), `${key}: the blurb's words, plainly spaced`);
    if (pack.transcript_windows.length) {
      const first = undatamark(pack.transcript_windows[0].text).slice(0, 40);
      assert.ok(text.includes(first) || text.length === MAX_EMBED_CHARS, `${key}: the first transcript window`);
    }
  }
  assert.ok(checked >= 6, `checked ${checked} fixture packs`);
});

/* Mutation (run): re-embed all (drop `if (have.has(key)) { ...; continue; }`
   in runEmbed) -- the second run embeds the two first keys again (and the
   file then repeats them). */
test("a rerun skips keys already embedded", async (t) => {
  const { dir, env } = tmpEnv(t);
  const first = [];
  assert.equal(await main(["--keys", "curated", "--embedder", "stub", "--limit", "2"], { env, createEmbedder: countingStub(first), stdout: sink(), stderr: sink() }), 0);
  assert.equal(first.length, 2);
  const before = readOut(dir).doc;

  const second = [];
  const out = sink();
  assert.equal(await main(["--keys", "curated", "--embedder", "stub"], { env, createEmbedder: countingStub(second), stdout: out, stderr: sink() }), 0);
  assert.equal(second.length, 1, "only quiz-desk is new");
  const after = readOut(dir).doc;
  assert.deepEqual(after.keys, ["tx-show", "note-only", "quiz-desk"]);
  assert.deepEqual(after.vectors.slice(0, 2), before.vectors, "earlier vectors are kept as they were");
  assert.deepEqual(checkEmbeddings(after), []);
  const res = JSON.parse(out.text);
  assert.equal(res.already, 2);
  assert.equal(res.embedded, 1);

  const third = [];
  assert.equal(await main(["--keys", "curated", "--embedder", "stub"], { env, createEmbedder: countingStub(third), stdout: sink(), stderr: sink() }), 0);
  assert.equal(third.length, 0, "a complete file embeds nothing");
});

/* Mutation (run): skip the check in runEmbed (drop the `v.length !==
   model.dim` throw) -- the 63-entry vector is stored and the file written.
   Also red (run): skip it in checkEmbeddings (drop `v.length !== dim`) --
   --check passes the hand-broken file. */
test("a wrong-length vector is refused", async (t) => {
  const { dir, env } = tmpEnv(t);
  const sources = loadSources({ env: FIXTURE_ENV });
  const outPath = path.join(dir, "embeddings", "fake-short.json");
  const short = {
    model: { name: "fake-short", revision: "1", dim: STUB_DIM },
    embed: async (texts) => texts.map(() => new Float32Array(STUB_DIM - 1).fill(0.5)),
  };
  await assert.rejects(runEmbed({ keys: ["tx-show"], sources, embedder: short, outPath }), /refused: tx-show got a 63-entry vector/);
  assert.ok(!fs.existsSync(outPath), "nothing is written");

  // A file on disk with one bad vector fails --check (exit 1).
  assert.equal(await main(["--keys", "curated", "--embedder", "stub", "--limit", "2"], { env, stdout: sink(), stderr: sink() }), 0);
  const { file, doc } = readOut(dir);
  assert.equal(await main(["--check"], { env, stdout: sink(), stderr: sink() }), 0);
  doc.vectors[1] = doc.vectors[1].slice(1);
  fs.writeFileSync(file, JSON.stringify(doc));
  const problems = checkEmbeddings(doc);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /note-only\) has 63 entries, model.dim is 64/);
  const out = sink();
  assert.equal(await main(["--check"], { env, stdout: out, stderr: sink() }), 1);
  assert.match(out.text, /FAIL/);
});

/* Mutation (run): no cap (`capChars` returns `text` unchanged) -- the long
   pack's text runs past 2,000 chars. */
test("text is capped at 2,000 chars", () => {
  const long = "word ".repeat(70).trim();
  const pack = {
    title: "Long Show",
    editorial_note: null,
    blurb: `a${DATAMARK}blurb`,
    feed_description: null,
    episodes: Array.from({ length: 10 }, (_, i) => ({ title: `Episode${DATAMARK}${i}`, description: long.replace(/ /g, DATAMARK) })),
    transcript_windows: [{ text: long.replace(/ /g, DATAMARK) }],
  };
  const text = textForEmbedding(pack);
  assert.equal(MAX_EMBED_CHARS, 2000);
  assert.ok(text.length <= MAX_EMBED_CHARS, `got ${text.length}`);
  assert.ok(text.length >= MAX_EMBED_CHARS - 5, "cut at the cap, not well short of it");
  assert.ok(text.startsWith("Long Show\na blurb\nEpisode 0: word word"));
  // A surrogate pair straddling the cap is dropped whole, never split.
  const astral = textForEmbedding({ title: `${"x".repeat(MAX_EMBED_CHARS - 1)}\u{1F3A7}` });
  assert.equal(astral.length, MAX_EMBED_CHARS - 1);
});

/* Mutation (run): `all` takes every breadth row (drop
   `if (!sources.curatedByAcid.has(acid))`) -- 999 and 666, the breadth rows of
   curated tx-show and quiz-desk, come back as second keys for the same shows. */
test("keys: curated, all without curated overlap, gold from the gold set", (t) => {
  const { dir } = tmpEnv(t);
  const sources = loadSources({ env: FIXTURE_ENV });
  assert.deepEqual(keysFor("curated", sources), ["tx-show", "note-only", "quiz-desk"]);
  assert.deepEqual(keysFor("all", sources), ["tx-show", "note-only", "quiz-desk", "111", "222", "333", "444", "555", "777"]);
  const gold = path.join(dir, "gold-set.json");
  assert.throws(() => keysFor("gold", sources, { goldSetPath: gold }), /sample\.mjs \(RV-07\)/);
  fs.writeFileSync(gold, JSON.stringify({ version: 1, shows: [{ show_key: "222", roles: ["gold"] }, { show_key: "tx-show", roles: ["gold", "holdout"] }] }));
  assert.deepEqual(keysFor("gold", sources, { goldSetPath: gold }), ["222", "tx-show"]);
});

/* Mutation (run): drop the `pack.tier === "none"` skip in runEmbed -- 444
   (title only) gets a vector. */
test("a none-tier show gets no vector", async (t) => {
  const { dir, env } = tmpEnv(t);
  const out = sink();
  assert.equal(await main(["--keys", "all", "--embedder", "stub"], { env, stdout: out, stderr: sink() }), 0);
  const { doc } = readOut(dir);
  assert.ok(!doc.keys.includes("444"));
  assert.equal(doc.keys.length, 8);
  assert.equal(JSON.parse(out.text).skipped_none, 1);
});

/* Mutation (run): drop the model comparison in loadEmbeddings (the `doc.model.name
   !== want.name || ...` throw) -- a 32-dim run appends to the 64-dim file. */
test("a file from another model, revision or dimension is refused, not mixed", async (t) => {
  const { dir, env } = tmpEnv(t);
  assert.equal(await main(["--keys", "curated", "--embedder", "stub", "--limit", "1"], { env, stdout: sink(), stderr: sink() }), 0);
  const { file } = readOut(dir);
  const bytes = fs.readFileSync(file, "utf8");
  const err = sink();
  const other = (opts) => createPassageEmbedder({ ...opts, dim: 32 });
  assert.equal(await main(["--keys", "curated", "--embedder", "stub"], { env, createEmbedder: other, stdout: sink(), stderr: err }), 1);
  assert.match(err.text, /not \{"name":"stub-hash","revision":"1","dim":32\}/);
  assert.equal(fs.readFileSync(file, "utf8"), bytes, "the file is untouched");
});
