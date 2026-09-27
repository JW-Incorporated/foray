/* K-03's audition kit, driven through the real interpreter.
 *
 * `docs/bundled-voice-plan.md` K-03 and §6. Wyatt's rule: twelve voices in,
 * three out, chosen by the founders.
 *
 * WHAT CAN BE SETTLED HERE. The slate, the blind labelling, the determinism of
 * the output paths, and the refusal. What cannot: the audio. Neither the
 * runtime nor the 86 MB of weights is present on this machine, and the
 * repository must never carry them (deck §9).
 *
 * THE REFUSAL IS THE MOST IMPORTANT THING IN THIS FILE, and it is not
 * defensive coding. A founder ranking twelve blind clips has no way to tell a
 * real one from silence, a sine tone, or a system-voice clip labelled as
 * Kokoro. A kit that could produce one would corrupt the exact decision it
 * exists to support, invisibly, and the corruption would be discovered only
 * after three voices had shipped.
 *
 * Every test names the mutation that turns it red.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { exemptClickTrackPaths } from "../audio/click-tracks.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const SCRIPT = path.join(HERE, "render-audition.py");

const PYTHON = (() => {
  for (const exe of ["python3", "python", "py"]) {
    if (spawnSync(exe, ["--version"], { encoding: "utf8" }).status === 0) return exe;
  }
  return null;
})();

/* The module's filename has a hyphen, so it cannot be `import`ed by name.
   Loaded by path instead — which is also what running the script does, minus
   `main`. Every snippet below gets the module as `R`. */
function pyJson(snippet) {
  const loader =
    `import json,sys,importlib.util\n` +
    `spec=importlib.util.spec_from_file_location("ra", ${JSON.stringify(SCRIPT)})\n` +
    `R=importlib.util.module_from_spec(spec); spec.loader.exec_module(R)\n`;
  const r = spawnSync(PYTHON, ["-c", loader + snippet], { encoding: "utf8", cwd: ROOT });
  assert.equal(r.status, 0, `python failed:\n${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
}

test("a Python interpreter is available — this suite does not silently skip", () => {
  assert.ok(PYTHON, "no python3/python/py on PATH; K-03's kit cannot be exercised at all");
});

/* ---------- the slate ---------- */

test("the slate is §6's twelve voices, in the deck's own order", () => {
  /* Wyatt's "try out a dozen". A slate that drifted to eleven would drop a
     voice the founders were asked to rank and nobody would see it — the
     ranking form just comes back one short.
     MUTATION: remove `bm_fable` from SLATE. */
  const out = pyJson("print(json.dumps({'slate': R.SLATE, 'labels': R.LABELS}))");
  assert.deepEqual(out.slate, [
    "af_heart", "af_bella", "af_nicole", "bf_emma", "af_sarah", "af_kore",
    "af_aoede", "am_michael", "am_fenrir", "am_puck", "bm_george", "bm_fable",
  ]);
  assert.equal(out.labels.length, 12);
  assert.deepEqual([out.labels[0], out.labels.at(-1)], ["A", "L"]);
});

test("the slate is exactly the set of voices the model pins fetch", () => {
  /* THE CROSS-TREE PIN. A voice the founders rank but the build never fetched
     cannot ship; a voice the build fetches but nobody ranked is dead weight in
     the bundle. Nothing else connects a Python list to a JS pin table.
     MUTATION: add a thirteenth voice to either side. */
  const out = pyJson("print(json.dumps(R.SLATE))");
  const pins = fs.readFileSync(path.join(ROOT, "tools/mobile/fetch-models.mjs"), "utf8");
  const listed = pins.slice(pins.indexOf("...["), pins.indexOf("].map("));
  for (const voice of out) {
    assert.ok(listed.includes(`"${voice}"`), `${voice} is ranked but never fetched`);
  }
  assert.equal((listed.match(/"[a-z]{2}_[a-z]+"/g) || []).length, out.length, "the two lists are the same length");
});

test("the labels are blind: twelve labels, and the key is a separate artefact", () => {
  /* A founder who can see that `af_heart` is graded A on the model card is
     ranking the grade, not the voice.
     MUTATION: name the clips after the voices — the key then travels with the
     audio and the blind round stops being blind. */
  const key = pyJson("print(json.dumps(R.label_key()))");
  assert.equal(Object.keys(key).length, 12);
  assert.equal(key.A, "af_heart");
  /* SCOPED to the sealed round's `clip_path` from 2026-09-26. The local
     audition (`--local`) names its files after their voices ON PURPOSE — it is
     one founder's wide first listen, with a Blind toggle on screen, not the
     sealed ranking — so a whole-file scan would now forbid the right thing.
     What must stay true is that the SEALED round's clips carry only a label. */
  const py = fs.readFileSync(SCRIPT, "utf8");
  const sealed = py.slice(py.indexOf("def clip_path("), py.indexOf("def label_key("));
  assert.ok(sealed.length > 0, "clip_path is still where the sealed round names its clips");
  assert.ok(!/\{voice\}/.test(sealed), "a sealed-round clip must never be named after its voice");
  const out = pyJson("print(json.dumps(str(R.clip_path('C', 1.0, 'abc123'))))");
  assert.ok(!/[ab][fm]_[a-z]+/.test(out), "the sealed path carries a label, not a voice id");
});

test("a slate and a label list of different lengths is a hard error, not a silent truncation", () => {
  /* `zip` stops at the shorter list, so a thirteenth voice with twelve labels
     would silently drop one — the exact failure this raise exists to prevent.
     MUTATION: remove the length check from `label_key`. */
  const r = spawnSync(PYTHON, ["-c",
    `import importlib.util,sys\n` +
    `spec=importlib.util.spec_from_file_location("ra", ${JSON.stringify(SCRIPT)})\n` +
    `R=importlib.util.module_from_spec(spec); spec.loader.exec_module(R)\n` +
    `R.label_key(R.SLATE + ["af_extra"])\n`,
  ], { encoding: "utf8", cwd: ROOT });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /13 voices but 12 labels/);
});

/* ---------- determinism ---------- */

test("clip paths are deterministic, and separate the ranking round from the confirm round", () => {
  /* The card's acceptance: "twelve clips exist and are bit-identical on
     re-render". A path that carried a timestamp would make every re-render a
     new set and a stale clip indistinguishable from a fresh one.
     MUTATION: drop `speed` from the filename — the 1.5x confirm round
     overwrites the 1.0x ranking clips and the founders re-rank at the wrong
     speed. */
  const out = pyJson(
    "print(json.dumps({" +
    "'a': str(R.clip_path('A', 1.0, 'abc123')), 'a2': str(R.clip_path('A', 1.0, 'abc123')), " +
    "'fast': str(R.clip_path('A', 1.5, 'abc123')), 'other': str(R.clip_path('A', 1.0, 'def456'))}))"
  );
  assert.equal(out.a, out.a2, "the same inputs give the same path");
  assert.notEqual(out.a, out.fast, "speed is part of the path");
  assert.notEqual(out.a, out.other, "a different passage is a different directory");
  assert.match(out.a.replace(/\\/g, "/"), /audition\/abc123\/A-1p00\.wav$/);
});

test("the passage fingerprint tracks the PHONEMES, not the prose", () => {
  /* A typo fix that does not change what anyone hears must not invalidate a
     completed ranking round; a change to the phonemes must.
     MUTATION: fingerprint `text` instead of `phonemes`. */
  const base = { lines: [{ id: "l1", text: "One.", phonemes: "wʌn" }] };
  const retyped = { lines: [{ id: "l1", text: "One!", phonemes: "wʌn" }] };
  const rephonemized = { lines: [{ id: "l1", text: "One.", phonemes: "wɒn" }] };
  const f = (doc) => pyJson(`print(json.dumps(R.passage_fingerprint(json.loads(${JSON.stringify(JSON.stringify(doc))}))))`);
  assert.equal(f(retyped), f(base), "prose-only edits keep the ranking valid");
  assert.notEqual(f(rephonemized), f(base), "a phoneme change is a new render");
});

test("the kit renders from the passage K-01 probes, not a second one", () => {
  /* Deck §6: ONE passage, so the thing the founders rank is the thing the
     probe timed. Two passages would let a voice be ranked on prose it never
     has to say.
     MUTATION: point PASSAGE_PATH at a copy. */
  const out = pyJson("print(json.dumps(str(R.PASSAGE_PATH)))");
  assert.match(out.replace(/\\/g, "/"), /tools\/mobile\/kokoro-probe-passage\.json$/);
});

/* ---------- the refusal ---------- */

test("--check names every missing dependency and exits non-zero", () => {
  /* The state of this machine, and of CI: no runtime, no weights. Each is
     reported, because a founder or an agent picking this up needs to know
     which of them they have to solve.
     MUTATION: return 0 when dependencies are missing — the kit then reads as
     ready and the next step is a confusing crash.

     THE PASSAGE IS NO LONGER ON THAT LIST, from 2026-09-12, and the assertion
     that it is has been INVERTED rather than deleted. `--check` used to report
     "phonemized passage" as a fourth missing item; the passage now carries real
     ids, so a `--check` that still named it would be lying about the one
     dependency the audition shares with K-01's probe. Asserting its ABSENCE is
     what keeps that true: null an `ids` array and this goes red.
     MUTATION: restore `ids: null` in the passage. */
  const r = spawnSync(PYTHON, [SCRIPT, "--check"], { encoding: "utf8", cwd: ROOT });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /slate: 12 voices, labels A\.\.L/);
  assert.match(r.stdout, /NOT READY/);
  assert.match(r.stdout, /onnxruntime \(pip\)/);
  assert.match(r.stdout, /kokoro-v1_0-q8f16\.onnx/);
  assert.ok(!/phonemized passage/.test(r.stdout),
    "the passage is phonemized — reporting it as missing would send the reader to a solved problem");
  assert.match(r.stdout, /node tools\/mobile\/fetch-models\.mjs/,
    "the failure must carry the commands that fix it");
});

test("--render refuses rather than writing a clip nobody could tell from real", () => {
  /* THE TEST THIS SUITE IS FOR. A stub clip in a blind ranking is undetectable
     by the people doing the ranking.
     MUTATION: catch MissingDependency and write silence, or fall back to any
     other synthesizer — twelve files appear, the founders rank them, and three
     voices ship on the strength of audio nobody generated. */
  const r = spawnSync(PYTHON, [SCRIPT, "--render"], { encoding: "utf8", cwd: ROOT });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot render the audition/);
  assert.equal(r.stdout.trim(), "", "no path is printed, because no clip was written");
  assert.ok(!fs.existsSync(path.join(ROOT, "mobile/models/audition")),
    "the refusal must not even create the output directory");
});

test("no audition audio is committed to the repository", () => {
  /* Clips are a build artefact and a release asset (K-03), never a tracked
     file. Twelve ~90-second 24 kHz WAVs are ~130 MB.
     MUTATION: commit one — this goes red.
     The one exemption is NE-25a's click tracks: named by their descriptor,
     matching its hashes, under 1 MB (tools/audio/click-tracks.mjs). */
  const clickTracks = exemptClickTrackPaths(ROOT);
  const offenders = [];
  const walk = (rel) => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const next = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(next);
      else if (/\.(wav|mp3|m4a|flac|ogg)$/i.test(e.name) && !clickTracks.has(next)) offenders.push(next);
    }
  };
  walk("mobile");
  walk("tools/narration");
  assert.deepEqual(offenders, []);
});

test("the audition doc seals the key and states the decision rule", () => {
  /* A ranking with no written rule for turning five rankings into three voices
     is a conversation, not a decision.
     MUTATION: drop the combined-rank rule from the doc. */
  const doc = fs.readFileSync(path.join(ROOT, "docs/research/voice-audition-2026-09.md"), "utf8");
  assert.match(doc, /combined rank/i, "the doc must say how twelve become three");
  assert.match(doc, /1\.5|2\.0/, "the confirm round at speed is part of the rule");
  assert.ok(!doc.includes("af_heart is A"), "the doc must not reveal the key before ranking");
});

/* ================================================================
 * The local audition (2026-09-26): every English voice, one published
 * Foray passage, rendered on the founder's own machine, and a page to star
 * and annotate. `--local` in render-audition.py; docs/bundled-voice-plan.md
 * K-03. The audio cannot be tested here (no runtime, no weights, and the
 * weights must never be committed); what can be is everything that decides
 * WHICH voices, WHICH weights, WHICH words, and what the page hands back.
 * ================================================================ */

test("the local audition covers every English Kokoro v1.0 voice, grouped and labelled from the id", () => {
  /* Wyatt: "test out many of the kokoro voices". A voice missing from this list
     is a voice nobody hears, and nothing else would notice it was absent.
     MUTATION: drop `bm_lewis`, or map `bf` to "American". */
  const out = pyJson(
    "print(json.dumps({'voices': R.ENGLISH_VOICES, 'slate': R.SLATE, " +
    "'meta': [R.voice_meta(v) for v in ['af_heart','am_puck','bf_emma','bm_george']]}))"
  );
  assert.equal(out.voices.length, 28);
  assert.equal(new Set(out.voices).size, 28, "no voice listed twice");
  const count = (p) => out.voices.filter((v) => v.startsWith(p + "_")).length;
  assert.deepEqual([count("af"), count("am"), count("bf"), count("bm")], [11, 9, 4, 4]);
  for (const v of out.slate) assert.ok(out.voices.includes(v), `${v} is on the sealed slate but not in the wide listen`);
  assert.deepEqual(out.meta, [
    { id: "af_heart", name: "Heart", accent: "American", gender: "female" },
    { id: "am_puck", name: "Puck", accent: "American", gender: "male" },
    { id: "bf_emma", name: "Emma", accent: "British", gender: "female" },
    { id: "bm_george", name: "George", accent: "British", gender: "male" },
  ]);
});

test("the local audition verifies against fetch-models.mjs's pins, read from that file, not a copy", async () => {
  /* The whole point: the founder judges the q8f16 graph the app bundles. The
     pins are parsed out of fetch-models.mjs so there is one hash table in the
     repo; this checks the parse against the module's own exported PINS.
     MUTATION: hard-code a model sha in the .py, or loosen the voice regex so
     it misses one. */
  const { PINS } = await import("../mobile/fetch-models.mjs");
  const out = pyJson("print(json.dumps(R.read_pins()))");
  const model = PINS.find((p) => p.kind === "model");
  assert.equal(out.model.sha256, model.sha256);
  assert.equal(out.model.url, model.url);
  assert.equal(out.model.bytes, model.bytes);
  const voices = PINS.filter((p) => p.kind === "voice");
  assert.equal(Object.keys(out.voices).length, voices.length);
  for (const p of voices) {
    assert.equal(out.voices[p.name.replace(/\.bin$/, "")].sha256, p.sha256, `${p.name} parsed with the wrong hash`);
  }
});

test("a local clip is out/<voice>.wav, and a voice id that is not one cannot become a path", () => {
  /* The id is interpolated into a filename, so `..` or a separator must refuse.
     MUTATION: drop the voice_meta() validation from local_clip_path. */
  const out = pyJson("from pathlib import Path\nprint(json.dumps(str(R.local_clip_path('af_heart', Path('out')))))");
  assert.match(out.replace(/\\/g, "/"), /^out\/af_heart\.wav$/);
  for (const bad of ["../af_heart", "af_heart/../x", "xx_heart", "af_Heart"]) {
    const r = spawnSync(PYTHON, ["-c",
      `import importlib.util\nfrom pathlib import Path\n` +
      `spec=importlib.util.spec_from_file_location("ra", ${JSON.stringify(SCRIPT)})\n` +
      `R=importlib.util.module_from_spec(spec); spec.loader.exec_module(R)\n` +
      `R.local_clip_path(${JSON.stringify(bad)}, Path('out'))\n`,
    ], { encoding: "utf8", cwd: ROOT });
    assert.notEqual(r.status, 0, `${bad} was accepted as a voice id`);
  }
});

test("the passage is four real lines of a published Foray: prelude, clip intro, bridge, closing", () => {
  /* The founder picks a voice for what it will actually say. The lines are read
     from data/forays.json at render time, so a hand-written "nice" passage
     cannot creep in, and their length is the 60-90 s the audition asked for
     at narration-craft.md's 17 characters/second.
     MUTATION: point AUDITION_FORAY_ID at a Foray without these items, or add a
     fifth long line. */
  const lines = pyJson("print(json.dumps(R.load_audition_lines()))");
  assert.deepEqual(lines.map((l) => l.role), ["prelude", "clip-intro", "bridge", "closing"]);
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data/forays.json"), "utf8"));
  const foray = data.forays.find((f) => f.id === "how-ai-actually-gets-built-3b83e1");
  assert.equal(foray.status, "published");
  for (const l of lines) {
    const item = foray.items.find((i) => i.id === l.id);
    assert.equal(item.type, "narration");
    assert.equal(l.text, item.script.trim(), `${l.id} is the Foray's own words`);
  }
  const chars = lines.reduce((n, l) => n + l.text.length, 0);
  assert.ok(chars >= 60 * 17 && chars <= 90 * 17, `${chars} chars is outside 60-90 s`);
  assert.match(lines[2].text, /TSMC/, "the bridge carries a proper noun / initialism");
});

test("a long line is split at sentence ends, every chunk fits the graph, and nothing is dropped", () => {
  /* The style matrix has 510 rows; a line longer than that cannot be sung in
     one call. A splitter that dropped a fragment would drop a word.
     MUTATION: return pieces[:1], or split mid-word. */
  const sentence = "ðə mˈɑdəl ʃˈɪps wˈʌns ænd ɹˈɛsts.";
  const long = Array.from({ length: 30 }, () => sentence).join(" ");
  const out = pyJson(
    `s=${JSON.stringify(long)}\nprint(json.dumps({'chunks': R.split_phonemes(s), 'limit': R.MAX_CHUNK_PHONEMES, ` +
    `'short': R.split_phonemes('hˈɛlO.'), 'huge': R.split_phonemes('a'*50 + ' ' + 'b'*50, 30)}))`
  );
  assert.ok(out.chunks.length > 1);
  for (const c of out.chunks) {
    assert.ok(c.length <= out.limit, `chunk of ${c.length} over ${out.limit}`);
    assert.ok(c.endsWith("."), "split at a sentence end");
  }
  assert.equal(out.chunks.join(" "), long);
  assert.deepEqual(out.short, ["hˈɛlO."]);
  assert.ok(out.huge.every((c) => c.length <= 30), "an over-long sentence is still split to the limit");
  assert.equal(out.huge.join("").length, 100, "and loses nothing but the space it was cut at");
});

/* ---------- the page ---------- */

const FAKE_MANIFEST = {
  kind: "foray-voice-audition", version: 1, foray_id: "how-ai-actually-gets-built-3b83e1",
  passage_fingerprint: "abc123abc123", speed: 1.0,
  model: { name: "kokoro-v1_0-q8f16.onnx", sha256: "0".repeat(64) },
  phonemizer: { g2p: "misaki en-US 0.9.4", fallback: "espeak-ng 1.52.0", vocab: "sha256:x" },
  passage: [{ id: "l1", role: "prelude", text: "A line with </script><script>alert(1)</script> in it." }],
  voices: [
    { id: "af_heart", name: "Heart", accent: "American", gender: "female", file: "af_heart.wav", render_sec: 280.5, audio_sec: 95.5 },
    { id: "bm_george", name: "George", accent: "British", gender: "male", file: "bm_george.wav", render_sec: 290.1, audio_sec: 97.0 },
    { id: "am_puck", name: "Puck", accent: "American", gender: "male", file: "am_puck.wav", render_sec: 281.0, audio_sec: 93.2 },
  ],
  failed: [],
};

function pageFor(manifest) {
  return pyJson(`print(json.dumps(R.audition_page_html(json.loads(${JSON.stringify(JSON.stringify(manifest))}))))`);
}

function pureBlock(html) {
  const m = html.match(/\/\*<pure>\*\/([\s\S]*?)\/\*<\/pure>\*\//);
  assert.ok(m, "the page keeps its pure functions between the /*<pure>*/ markers");
  return new Function(`${m[1]}; return { letterFor, shuffled, blindLetters, favouritesDoc };`)();
}

test("the page opens from disk: no network, relative audio, and the manifest cannot break out of its tag", () => {
  /* It is opened as file:// on the founder's PC. Any http(s) reference is a
     request that fails offline or leaks; a `</script>` in a narration line
     would otherwise end the JSON tag and run as code.
     MUTATION: link a web font, or drop the `<` escape in audition_page_html. */
  const html = pageFor(FAKE_MANIFEST);
  assert.ok(!/https?:\/\//.test(html), "no network URL anywhere in the page");
  assert.ok(!/<script[^>]+src=/i.test(html) && !/<link[^>]+href=/i.test(html), "no external script or stylesheet");
  assert.equal((html.match(/<\/script>/g) || []).length, 2, "only the two real closing tags");
  const json = html.match(/<script type="application\/json" id="manifest">([\s\S]*?)<\/script>/)[1];
  assert.deepEqual(JSON.parse(json), FAKE_MANIFEST, "the manifest round-trips exactly");
  assert.match(html, /audio\.src = v\.file/, "each card plays its own relative <voice>.wav");
  for (const needle of ['id="blind"', 'id="playfavs"', 'id="export"', "favourites.json", "foray-voice-audition:v1", "prefers-color-scheme: dark"]) {
    assert.ok(html.includes(needle), `the page carries ${needle}`);
  }
});

test("blind letters run A..Z then AA, and a shuffle is a permutation", () => {
  /* 28 voices is more than 26 letters. A letterFor that wrapped to "A" again
     would give two voices the same blind name.
     MUTATION: letterFor = i => String.fromCharCode(65 + i % 26). */
  const P = pureBlock(pageFor(FAKE_MANIFEST));
  assert.deepEqual([0, 1, 25, 26, 27, 51, 52].map(P.letterFor), ["A", "B", "Z", "AA", "AB", "AZ", "BA"]);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const ids = Array.from({ length: 28 }, (_, i) => `v${i}`);
  const s = P.shuffled(ids, rand);
  assert.deepEqual([...s].sort(), [...ids].sort());
  assert.notDeepEqual(s, ids);
  assert.equal(new Set(Object.values(P.blindLetters(s))).size, 28);
});

test("Export favourites produces the documented favourites.json shape", () => {
  /* The hand-off to the next step (finalists over a whole Foray, then the
     in-app A/B): voice ids, notes and the blind letter each was heard under.
     MUTATION: drop blind_letter, or export notes that were cleared to spaces. */
  const P = pureBlock(pageFor(FAKE_MANIFEST));
  const doc = P.favouritesDoc(FAKE_MANIFEST, {
    favs: { bm_george: true, af_heart: true },
    notes: { af_heart: "  warm, clear on TSMC ", am_puck: "too bright", bm_george: "   " },
    order: ["am_puck", "bm_george", "af_heart"],
  }, "2026-09-26T00:00:00.000Z");
  assert.deepEqual(doc, {
    kind: "foray-voice-audition-favourites", version: 1, exported_at: "2026-09-26T00:00:00.000Z",
    foray_id: "how-ai-actually-gets-built-3b83e1", passage_fingerprint: "abc123abc123",
    model: "kokoro-v1_0-q8f16.onnx", speed: 1, blind_round: true,
    favourites: [
      { voice: "af_heart", name: "Heart", accent: "American", gender: "female", notes: "warm, clear on TSMC", blind_letter: "C" },
      { voice: "bm_george", name: "George", accent: "British", gender: "male", notes: "", blind_letter: "B" },
    ],
    other_notes: [{ voice: "am_puck", notes: "too bright", blind_letter: "A" }],
  });
  const none = P.favouritesDoc(FAKE_MANIFEST, {}, "t");
  assert.equal(none.blind_round, false);
  assert.deepEqual([none.favourites, none.other_notes], [[], []]);
});

test("--local --page-only rebuilds the page from audition.json, and refuses with none", () => {
  /* The page can be regenerated without re-rendering 28 voices (hours on the
     audition PC). With no manifest there is nothing honest to show.
     MUTATION: write an empty page when audition.json is missing. */
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "audition-"));
  try {
    let r = spawnSync(PYTHON, [SCRIPT, "--local", "--page-only", "--work-dir", dir], { encoding: "utf8", cwd: ROOT });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no manifest/);
    assert.ok(!fs.existsSync(path.join(dir, "out", "index.html")));
    fs.mkdirSync(path.join(dir, "out"));
    fs.writeFileSync(path.join(dir, "out", "audition.json"), JSON.stringify(FAKE_MANIFEST));
    r = spawnSync(PYTHON, [SCRIPT, "--local", "--page-only", "--work-dir", dir], { encoding: "utf8", cwd: ROOT });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.readFileSync(path.join(dir, "out", "index.html"), "utf8").includes("af_heart.wav"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--local refuses a voice that is not an English Kokoro voice before fetching anything", () => {
  /* A typo must not become a download of whatever URL it spells.
     MUTATION: remove the ENGLISH_VOICES membership check in main_local. */
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "audition-"));
  try {
    const r = spawnSync(PYTHON, [SCRIPT, "--local", "--voices", "af_heart,zf_xiaobei", "--work-dir", dir], { encoding: "utf8", cwd: ROOT });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /zf_xiaobei/);
    assert.deepEqual(fs.readdirSync(dir), [], "nothing was fetched or written");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
