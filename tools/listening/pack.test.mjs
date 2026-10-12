/* Tests for the blind listening pack (GV-36: W1-17, R2-01 / QK-30 / MQ-20).
 * Run: node --test tools/listening/pack.test.mjs
 *
 * WHAT IS AT RISK
 * The pack is the only thing between the founder's ear and a candidate's
 * name. Its quiet failures: a candidate id, provider or file name leaking into
 * what he sees (the listen is no longer blind); the key travelling with the
 * pack; an A/B order that is not reproducible (or not random); an act that
 * runs into the next one; a clip resolved from the wrong row; a page that
 * pulls in an outside script; a card the page builds that card.mjs refuses.
 *
 * Every candidate here is synthetic (tools/listening/fixtures/pair, short
 * made-up scripts, no transcript text) or the redacted out-9 bench candidate;
 * the pools are written to a temp directory, and nothing reads data/ or
 * data-local/. Each test names the mutation it kills; every one was run.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { validateCard } from "./card.mjs";
import { unseal, validateKey } from "./unseal.mjs";
import {
  CARD_SHAPE,
  NO_SCRIPT,
  NO_VOICE,
  PACK_SCHEMA,
  SYNTH_VOICE,
  buildCard,
  buildPack,
  extractAct,
  loadPools,
  main,
  mulberry32,
  resolveClip,
  writePack
} from "./pack.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "fixtures", "pair");
const OUT9 = path.join(HERE, "..", "generation-bench", "fixtures", "out-9", "what-engineers-actually-do-all-day-how-e-4e64fd43.json");
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "gv36-pack-"));

/* The committed-pool stand-in: ep2 and ep3 are not minted by either fixture,
   so they resolve here; ep2's source is DAI-suspected. One out-9 clip (#30)
   and its source, and the source of out-9's minted #283, are here too;
   out-9's #45 has a minted segment and no source anywhere, so it stays
   unresolved. */
const POOL_SEGMENTS = {
  segments: [
    { id: "fixture-show-ep2#40", item_id: "fixture-show-ep2", start_sec: 40, end_sec: 95, dai_suspected: false },
    { id: "fixture-show-ep3#5", item_id: "fixture-show-ep3", start_sec: 5, end_sec: 50 },
    { id: "fixture-show-ep1#100", item_id: "fixture-show-ep1", start_sec: 900, end_sec: 960 },
    {
      id: "being-an-engineer--s2e28-test-stands-x-ray-other-instrumentation-william-gabler#30",
      item_id: "being-an-engineer--s2e28-test-stands-x-ray-other-instrumentation-william-gabler",
      start_sec: 29.7,
      end_sec: 107.7
    }
  ]
};
const POOL_SOURCES = {
  sources: [
    { id: "fixture-show-ep2", audio_url: "https://media.example.test/fixture-show/ep2.mp3", dai_suspected: true },
    { id: "fixture-show-ep3", audio_url: "https://media.example.test/fixture-show/ep3.mp3", dai_suspected: false },
    { id: "fixture-show-ep1", audio_url: "https://pool.example.test/WRONG-ep1.mp3", dai_suspected: true },
    {
      id: "being-an-engineer--s2e28-test-stands-x-ray-other-instrumentation-william-gabler",
      audio_url: "https://media.example.test/engineer/s2e28.mp3",
      dai_suspected: false
    },
    {
      id: "being-an-engineer--david-oh-nasa-systems-engineering-and-sending-robots-to-spac",
      audio_url: "https://media.example.test/engineer/david-oh.mp3",
      dai_suspected: true
    }
  ]
};

function poolFiles(dir) {
  const segmentsFile = path.join(dir, "segments.json");
  const sourcesFile = path.join(dir, "sources.json");
  fs.writeFileSync(segmentsFile, JSON.stringify(POOL_SEGMENTS));
  fs.writeFileSync(sourcesFile, JSON.stringify(POOL_SOURCES));
  return { segmentsFile, sourcesFile };
}

const pools = () => loadPools(poolFiles(tmpdir()));

/** The two fixture candidates copied under distinctive file names, so a
 * leaked file name is a string the test can look for. */
function pairInputs(dir) {
  const a = path.join(dir, "cand-alpha-run7-filename.json");
  const b = path.join(dir, "cand-beta-run8-filename.json");
  fs.copyFileSync(path.join(FIX, "a.json"), a);
  fs.copyFileSync(path.join(FIX, "b.json"), b);
  return { a, b };
}

/** Every external URL a page or pack mentions. */
const urlsIn = (text) => text.match(/https?:\/\/[^\s"'<>\\)]+/g) || [];

/** The page's own card builder, evaluated from listen.html as the browser
 * would see it: the test calls the code the founder's page runs. */
function pageCardBuilder(html) {
  const m = html.match(/<script id="card-builder">([\s\S]*?)<\/script>/);
  assert.ok(m, "listen.html has a card-builder script block");
  const ctx = {};
  vm.runInNewContext(`${m[1]}\nthis.buildCard = buildCard; this.CARD_SHAPE = CARD_SHAPE;`, ctx);
  return ctx;
}

/** The page's item label, evaluated from listen.html the same way: what the
 * founder reads beside each item, not the module's copy of it. */
function pageDescribe(html) {
  const m = html.match(/<script id="item-describer">([\s\S]*?)<\/script>/);
  assert.ok(m, "listen.html has an item-describer script block");
  assert.match(html, /function describe\(item\) \{ return describeItem\(item, NO_SCRIPT\); \}/, "the page's describe() is that block's describeItem");
  const ctx = {};
  vm.runInNewContext(`${m[1]}\nthis.describe = function (item) { return describeItem(item, NO_SCRIPT); };`, ctx);
  return ctx.describe;
}

const form = (packId, label, over = {}) => ({
  packId,
  label,
  act: 1,
  listener: "founder",
  listenedAt: "2026-10-12T09:30:15.123Z",
  scores: { onSubject: "4", flowsAtSeams: "3", oneNarrator: "5", nothingFalseOrOdd: "2" },
  overall: "4",
  q06: { oneVoice: "yes", everyClipIntroduced: "no", anyClipCutShort: "no" },
  winces: [{ atSec: "73.46", note: "the hand-off line repeats the clip" }],
  preference: label === "solo" ? undefined : "B",
  ...over
});

/* MUTATION: in extractAct, replace `next > start ? next : items.length` with
   `items.length` (act 1 runs into act 2), or slice act 1 from `start` (the
   disclosure is dropped) -> red. */
test("the act is the disclosure and the act's items up to the next act introduction", () => {
  const a = readJson(path.join(FIX, "a.json"));
  const act1 = extractAct(a.items, 1);
  assert.deepEqual(
    act1.map((i) => i.id ?? i.segment_id),
    ["disclosure", "act-1-introduction", "fixture-show-ep1#100", "narration-act-1-0-beat", "jingle-cut-act-1-1", "fixture-show-ep2#40", "act-1-exit"]
  );
  const act2 = extractAct(a.items, 2);
  assert.deepEqual(
    act2.map((i) => i.id ?? i.segment_id),
    ["act-2-introduction", "fixture-show-ep3#5", "act-2-exit"],
    "a later act starts at its own introduction and runs to the end"
  );
  assert.throws(() => extractAct(a.items, 3), /no act-3-introduction/);
  assert.throws(() => extractAct(a.items, 0), /--act/);
});

/* MUTATION: in resolveClip, look the pool up before the candidate's minted
   rows (`segmentView(pools.segments.get(id)) || segmentView(minted)`), or the
   pool source before the candidate's segmentSources -> red (ep1 would play
   pool.example.test at 900 s). MUTATION: drop `|| seg.daiSuspected` -> red. */
test("a clip resolves from the candidate's own rows first, then the committed pool, and flags DAI", () => {
  const p = pools();
  const a = readJson(path.join(FIX, "a.json"));
  assert.deepEqual(resolveClip("fixture-show-ep1#100", a, p), {
    kind: "clip",
    enclosureUrl: "https://media.example.test/fixture-show/ep1.mp3",
    startSec: 100,
    endSec: 160,
    daiVariable: false
  });
  assert.deepEqual(resolveClip("fixture-show-ep2#40", a, p), {
    kind: "clip",
    enclosureUrl: "https://media.example.test/fixture-show/ep2.mp3",
    startSec: 40,
    endSec: 95,
    daiVariable: true
  });
  assert.deepEqual(resolveClip("nowhere#1", a, p), { kind: "clip", unresolved: "segment not found" });
  const daiRow = { ...a, segments: [{ id: "x#1", itemId: "fixture-show-ep3", startSec: 1, endSec: 2, dai_suspected: true }] };
  assert.equal(resolveClip("x#1", daiRow, p).daiVariable, true, "a DAI flag on the segment row counts too");
  const noSource = { ...a, segments: [{ id: "y#1", itemId: "no-such-episode", startSec: 1, endSec: 2 }] };
  assert.deepEqual(resolveClip("y#1", noSource, p), { kind: "clip", unresolved: "no audio source" });
});

/* MUTATION: put `title: <candidate title>` on each version, or copy the
   item's `slot` onto a clip -> red. */
test("pack.json and listen.html carry no candidate id, provider, model, title, slot or file name", () => {
  const dir = tmpdir();
  const { a, b } = pairInputs(dir);
  const out = path.join(dir, "out");
  const keys = path.join(dir, "keys");
  const { segmentsFile, sourcesFile } = poolFiles(dir);
  main(["--a", a, "--b", b, "--act", "1", "--out", out, "--seed", "11", "--segments", segmentsFile, "--sources", sourcesFile, "--key-dir", keys], () => {});
  const packText = fs.readFileSync(path.join(out, "pack.json"), "utf8");
  const html = fs.readFileSync(path.join(out, "listen.html"), "utf8");
  const forbidden = [
    "fixture-bridges-hold",
    "7f3a91",
    "2c90d4",
    "fixture-provider-alpha",
    "fixture-provider-beta",
    "fixture-model-alpha",
    "fixture-model-beta",
    "cand-alpha-run7-filename",
    "cand-beta-run8-filename",
    "Fixture Alpha",
    "Fixture Beta",
    "alpha-slot",
    "beta-slot",
    "fixture-show-ep",
    "narration-act-1-0-beat",
    "candidateId",
    "provider",
    "stageSwap"
  ];
  for (const s of forbidden) {
    assert.ok(!packText.includes(s), `pack.json leaks ${JSON.stringify(s)}`);
    assert.ok(!html.includes(s), `listen.html leaks ${JSON.stringify(s)}`);
  }
  const pack = JSON.parse(packText);
  assert.equal(pack.schema, PACK_SCHEMA);
  assert.deepEqual(Object.keys(pack), ["schema", "packId", "act", "mode", "voice", "versions"]);
  assert.deepEqual(pack.versions.map((v) => v.label), ["A", "B"]);
  assert.match(pack.voice.narration, /speechSynthesis/, "pack.json records the voice the page will use");
});

/* MUTATION: in writePack, write the key file into outDir; or delete the
   `inside(outDir, keyDir)` refusal; or drop the existing-key comparison
   -> red. */
test("the key is written only under --key-dir, unseals, and a key dir inside --out is refused", () => {
  const dir = tmpdir();
  const { a, b } = pairInputs(dir);
  const out = path.join(dir, "out");
  const keys = path.join(dir, "keys");
  const { segmentsFile, sourcesFile } = poolFiles(dir);
  const common = ["--a", a, "--b", b, "--act", "1", "--seed", "11", "--segments", segmentsFile, "--sources", sourcesFile];
  const { built } = main([...common, "--out", out, "--key-dir", keys, "--swap-b", "spine:local:second"], () => {});

  assert.deepEqual(fs.readdirSync(out).sort(), ["listen.html", "pack.json"], "nothing but the pack in --out");
  assert.deepEqual(fs.readdirSync(keys), [`${built.packId}.key.json`]);
  const key = readJson(path.join(keys, `${built.packId}.key.json`));
  assert.deepEqual(validateKey(key), { ok: true, errors: [] });
  assert.equal(key.promptId, "fixture-bridges-hold");
  const byCandidate = Object.fromEntries(["A", "B"].map((l) => [key[l].candidateId, key[l]]));
  assert.deepEqual(byCandidate["cand-alpha-run7-filename"], { candidateId: "cand-alpha-run7-filename", provider: "fixture-provider-alpha", stageSwap: "baseline" });
  assert.deepEqual(byCandidate["cand-beta-run8-filename"], { candidateId: "cand-beta-run8-filename", provider: "fixture-provider-beta", stageSwap: "spine:local:second" });

  /* The page's card for "B" unseals to whichever candidate the key says B was. */
  const { card } = buildCard(form(built.packId, "B"), CARD_SHAPE);
  const [result] = unseal([card], { keyDir: keys });
  assert.equal(result.preferredCandidateId, key.B.candidateId);

  const tampered = { ...built, key: { ...built.key, B: { ...built.key.B, stageSwap: "something-else" } } };
  assert.throws(() => writePack(tampered, { outDir: out, keyDir: keys }), /refusing to overwrite/, "an existing key is never silently replaced");
  assert.equal(readJson(path.join(keys, `${built.packId}.key.json`)).B.stageSwap, key.B.stageSwap);

  const nested = path.join(dir, "out2");
  assert.throws(
    () => main([...common, "--out", nested, "--key-dir", path.join(nested, "keys")], () => {}),
    /inside --out/
  );
  assert.equal(fs.existsSync(path.join(nested, "keys")), false, "nothing is written when the key dir is refused");
});

/* MUTATION: build packId from `Date.now()`, or emit a build time into
   pack.json/listen.html -> red (not byte-identical). MUTATION: replace
   `mulberry32(seed)() >= 0.5` with `false` -> red (the seed no longer
   decides A/B). */
test("the same seed gives a byte-identical pack, and the seed decides which candidate is A", () => {
  const p = pools();
  const arm = (f) => ({ candidate: readJson(path.join(FIX, f)), candidateId: f.replace(".json", "") });
  const build = (seed) => buildPack({ a: arm("a.json"), b: arm("b.json"), act: 1, seed, pools: p });

  const dir = tmpdir();
  const written = (n) => {
    const built = build(42);
    const files = writePack(built, { outDir: path.join(dir, `out-${n}`), keyDir: path.join(dir, `keys-${n}`) });
    return Object.values(files).map((f) => fs.readFileSync(f));
  };
  const one = written(1);
  const two = written(2);
  assert.equal(one.length, 3, "pack.json, listen.html and the key");
  one.forEach((bytes, i) => assert.ok(bytes.equals(two[i]), `file ${i} differs between two builds with seed 42`));

  const firstA = (seed) => build(seed).key.A.candidateId;
  const seen = new Set();
  for (let seed = 0; seed < 16; seed++) seen.add(firstA(seed));
  assert.deepEqual([...seen].sort(), ["a", "b"], "over 16 seeds each candidate is A at least once");
  assert.notEqual(build(1).packId, build(2).packId, "a different seed is a different pack");
  assert.deepEqual(
    Array.from({ length: 4 }, mulberry32(42)),
    Array.from({ length: 4 }, mulberry32(42)),
    "the RNG is a pure function of the seed"
  );
});

/* MUTATION: in describeItem (the page's describe()), show "Narration" instead
   of "Narration: " + noScript for an item with neither script nor audio; or
   flip the test to `item.audioUrl ? "Narration (rendered)" : !item.script ?
   "Narration (spoken by this device)" : "Narration: " + noScript` -> red. */
test("solo mode works on the out-9 candidate; a narration item without a script says 'script not in fixture'", () => {
  const dir = tmpdir();
  const { segmentsFile, sourcesFile } = poolFiles(dir);
  const out = path.join(dir, "out");
  const keys = path.join(dir, "keys");
  const lines = [];
  const { built } = main(["--a", OUT9, "--act", "1", "--out", out, "--seed", "5", "--segments", segmentsFile, "--sources", sourcesFile, "--key-dir", keys], (s) => lines.push(s));

  const pack = readJson(path.join(out, "pack.json"));
  assert.equal(pack.mode, "solo");
  assert.deepEqual(pack.versions.map((v) => v.label), ["solo"]);
  const items = pack.versions[0].items;
  assert.deepEqual(
    items.map((i) => i.kind),
    ["narration", "narration", "narration", "clip", "jingle", "clip", "narration", "clip", "narration", "narration"],
    "act 1 of out-9: disclosure through act-1-exit"
  );
  assert.ok(items.filter((i) => i.kind === "narration").every((i) => i.script === null && i.audioUrl === null));
  assert.deepEqual(items[3], { kind: "clip", enclosureUrl: "https://media.example.test/engineer/s2e28.mp3", startSec: 29.7, endSec: 107.7, daiVariable: false });
  assert.deepEqual(items[5], { kind: "clip", unresolved: "no audio source" }, "a minted clip with no source anywhere stays, unresolved");
  assert.deepEqual(items[7], { kind: "clip", enclosureUrl: "https://media.example.test/engineer/david-oh.mp3", startSec: 282.75, endSec: 348, daiVariable: true });
  assert.equal(pack.voice.narration, NO_VOICE);

  const html = fs.readFileSync(path.join(out, "listen.html"), "utf8");
  assert.equal(NO_SCRIPT, "script not in fixture", "the card's wording");
  const describe = pageDescribe(html);
  const narration = items.filter((i) => i.kind === "narration");
  assert.equal(narration.length, 6);
  for (const item of narration) assert.equal(describe(item), "Narration: script not in fixture", "the page shows it for each scriptless narration item");
  assert.equal(describe({ kind: "narration", script: "A spoken line.", audioUrl: null }), "Narration (spoken by this device)");
  assert.equal(describe({ kind: "narration", script: "A spoken line.", audioUrl: "https://narration.example.test/x.m4a" }), "Narration (rendered)");
  assert.equal(describe(items[3]), "Clip, 1:18");
  assert.equal(describe(items[5]), "Clip: cannot be played (no audio source)");
  assert.equal(describe(items[4]), "Jingle (not played here)");

  const key = readJson(path.join(keys, `${built.packId}.key.json`));
  assert.deepEqual(validateKey(key), { ok: true, errors: [] });
  assert.deepEqual(key.solo, { candidateId: "what-engineers-actually-do-all-day-how-e-4e64fd43", provider: "unrecorded", stageSwap: "baseline" });
  assert.equal(key.promptId, "what-engineers-actually-do-all-day");
  assert.ok(lines.some((l) => /3 clip\(s\), 1 unresolved; 6 narration, 0 rendered, 6 with no script/.test(l)), "the CLI says what will not play");
  assert.ok(!lines.join("\n").includes("what-engineers-actually-do-all-day-how-e-4e64fd43"), "the CLI does not print the candidate either");
});

/* MUTATION: add `<link rel="stylesheet" href="https://fonts.googleapis.com/...">`
   or `<script src="https://cdn...">` to renderHtml -> red. */
test("listen.html names no external URL but the clip enclosures and rendered narration", () => {
  const dir = tmpdir();
  const { a, b } = pairInputs(dir);
  const { segmentsFile, sourcesFile } = poolFiles(dir);
  const out = path.join(dir, "out");
  main(["--a", a, "--b", b, "--act", "1", "--out", out, "--seed", "3", "--segments", segmentsFile, "--sources", sourcesFile, "--key-dir", path.join(dir, "k")], () => {});
  const html = fs.readFileSync(path.join(out, "listen.html"), "utf8");
  const pack = readJson(path.join(out, "pack.json"));
  const allowed = new Set(pack.versions.flatMap((v) => v.items.flatMap((i) => [i.enclosureUrl, i.audioUrl].filter(Boolean))));
  assert.ok(allowed.has("https://narration.example.test/alpha/beat-0.m4a"), "rendered narration is in the pack");
  assert.ok(allowed.has("https://media.example.test/fixture-show/ep4.mp3"));
  assert.deepEqual(urlsIn(html).filter((u) => !allowed.has(u)), []);
  assert.doesNotMatch(html, /<script[^>]*\bsrc=/i, "no external script");
  assert.doesNotMatch(html, /<link\b/i, "no external stylesheet or font");
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.doesNotMatch(css, /@import|url\(/i, "no CSS fetch");
  assert.match(html, /times may drift/, "the DAI badge wording is on the page");
  assert.ok(pack.versions.some((v) => v.items.some((i) => i.daiVariable === true)), "and a DAI clip is in this pack");
  /* The page's main script parses. */
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0]));
});

/* MUTATION: in buildCard, emit `preference` on a solo card, or default a
   missing preference to "tie" instead of reporting it, or write scores as
   the form's strings -> red. */
test("the card the page builds passes validateCard, and an unanswered form is not copied", () => {
  const p = pools();
  const arm = (f) => ({ candidate: readJson(path.join(FIX, f)), candidateId: f.replace(".json", "") });
  const pair = buildPack({ a: arm("a.json"), b: arm("b.json"), act: 1, seed: 9, pools: p });
  const solo = buildPack({ a: arm("a.json"), act: 1, seed: 9, pools: p });

  for (const built of [pair, solo]) {
    const page = pageCardBuilder(built.html);
    assert.deepEqual({ ...page.CARD_SHAPE, axes: [...page.CARD_SHAPE.axes], q06: [...page.CARD_SHAPE.q06] }, { ...CARD_SHAPE });
    for (const label of built.pack.versions.map((v) => v.label)) {
      const { card, missing } = page.buildCard(form(built.packId, label), page.CARD_SHAPE);
      assert.deepEqual([...missing], []);
      const plain = JSON.parse(JSON.stringify(card));
      assert.deepEqual(validateCard(plain), { ok: true, errors: [] }, `${label} card: ${validateCard(plain).errors.join("; ")}`);
      assert.equal(plain.packId, built.packId);
      assert.equal(plain.cardId, `${built.packId}-${label}-20261012093015`);
      assert.deepEqual(plain.winces, [{ atSec: 73.5, note: "the hand-off line repeats the clip" }]);
      if (label === "solo") assert.equal("preference" in plain, false);
      else assert.equal(plain.preference, "B");
    }
  }

  const page = pageCardBuilder(pair.html);
  const half = page.buildCard(
    form(pair.packId, "A", { overall: "", preference: "", q06: { oneVoice: "yes" }, listener: " ", scores: { onSubject: "6" } }),
    page.CARD_SHAPE
  );
  assert.deepEqual([...half.missing].sort(), [
    "anyClipCutShort",
    "everyClipIntroduced",
    "flowsAtSeams",
    "listener",
    "nothingFalseOrOdd",
    "onSubject",
    "oneNarrator",
    "overall",
    "preference"
  ]);
  const long = page.buildCard(form(pair.packId, "A", { winces: [{ atSec: "-3", note: "x".repeat(400) }] }), page.CARD_SHAPE).card;
  assert.deepEqual(validateCard(JSON.parse(JSON.stringify(long))), { ok: true, errors: [] }, "an over-long note is cut, a negative time is 0");
});

/* MUTATION: in voiceOf, report RENDERED_VOICE whenever any item is rendered
   -> red (a pack whose other lines are spoken would claim rendered audio). */
test("pack.json records the narration voice the page will use", () => {
  const p = pools();
  const arm = (f) => ({ candidate: readJson(path.join(FIX, f)), candidateId: f.replace(".json", "") });
  const solo = buildPack({ a: arm("b.json"), act: 1, seed: 1, pools: p });
  assert.deepEqual(solo.pack.voice, { narration: SYNTH_VOICE, renderedItems: 0, synthesizedItems: 4 });
  const pair = buildPack({ a: arm("a.json"), b: arm("b.json"), act: 1, seed: 1, pools: p });
  assert.match(pair.pack.voice.narration, /where rendered, else speechSynthesis/);
  assert.equal(pair.pack.voice.renderedItems, 1);
});

/* MUTATION: drop the different-prompts refusal in buildPack, or let an
   unknown flag through parseArgs -> red. */
test("the CLI refuses what it cannot seal: unknown flags, a bad seed, two different prompts", () => {
  const dir = tmpdir();
  const { a } = pairInputs(dir);
  const { segmentsFile, sourcesFile } = poolFiles(dir);
  const base = ["--a", a, "--act", "1", "--out", path.join(dir, "o"), "--segments", segmentsFile, "--sources", sourcesFile, "--key-dir", path.join(dir, "k")];
  assert.throws(() => main([...base, "--model", "x"], () => {}), /unknown argument --model/);
  assert.throws(() => main([...base, "--seed", "-1"], () => {}), /--seed/);
  assert.throws(() => main(["--a", a, "--out", path.join(dir, "o")], () => {}), /usage/);
  assert.throws(() => main([...base, "--swap-b", "x"], () => {}), /need --b/);
  const other = path.join(dir, "other.json");
  fs.writeFileSync(other, JSON.stringify({ ...readJson(path.join(FIX, "b.json")), id: "a-different-prompt-123abc" }));
  assert.throws(() => main([...base, "--b", other, "--seed", "1"], () => {}), /different prompts/);
  const { built } = main([...base, "--b", other, "--seed", "1", "--prompt-id", "forced"], () => {});
  assert.equal(built.key.promptId, "forced");
});
