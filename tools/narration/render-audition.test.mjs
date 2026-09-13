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
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
  const py = fs.readFileSync(SCRIPT, "utf8");
  assert.ok(!py.includes('f"{voice}.wav"'), "a clip must never be named after its voice");
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
     MUTATION: commit one — this goes red. */
  const offenders = [];
  const walk = (rel) => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const next = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(next);
      else if (/\.(wav|mp3|m4a|flac|ogg)$/i.test(e.name)) offenders.push(next);
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
