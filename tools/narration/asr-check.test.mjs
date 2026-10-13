/* GV-72: the Whisper round trip (asr-check.mjs + asr-transcribe.py), offline.
 *
 * docs/roadmap/generation-v2.md GV-72. No model, no audio and no network:
 * the ASR side is RECORDED text (the short synthetic rows below, shaped like
 * asr-transcribe.py's asr.jsonl), the .m4a files are a few fake bytes written
 * to a temp dir, and asr-transcribe.py runs with an injected transcriber.
 * Nothing here is committed besides this file: no transcript, no audio.
 *
 * Every test names the mutation that turns it red.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  normalizeForWer,
  spokenNumbers,
  scoreItem,
  isFlagged,
  alignWords,
  checkManifest,
  holdFlagged,
  scriptsFrom,
  properNouns,
  readAsr,
} from "./asr-check.mjs";
import { wordEditDistance } from "../transcribe/anchor-match.mjs";
import { stampForays, loadProfile } from "./stamp-narration.mjs";
import { collectUploads } from "./upload-narration.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const CLI = path.join(HERE, "asr-check.mjs");
const PY_SCRIPT = path.join(HERE, "asr-transcribe.py");
const PROFILE = loadProfile();
const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

const PYTHON = (() => {
  for (const exe of ["python3", "python", "py"]) {
    if (spawnSync(exe, ["--version"], { encoding: "utf8" }).status === 0) return exe;
  }
  return null;
})();

/* ---------- recorded fixtures: short synthetic scripts and what "Whisper" heard ---------- */

const NATO = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango".split(" ");
const line = (n) => NATO.slice(0, n).join(" ");
const swap = (n, k) => NATO.slice(0, n).map((w, i) => (i < k ? `x${w}` : w)).join(" ");

const FIX = {
  exact: {
    script: "The cantilever bridge carried trains across the firth for a century, and nobody who crossed it thought about the steel.",
    heard: "The cantilever bridge carried trains across the Firth for a century, and nobody who crossed it thought about the steel.",
  },
  digits: {
    script: "In 1969, 3 of the 12 engineers had worked there since the 1950s, and 40% of the 1,200 rivets were original by the 21st inspection.",
    heard: "In nineteen sixty-nine, three of the twelve engineers had worked there since the nineteen fifties, and forty percent of the one thousand two hundred rivets were original by the twenty-first inspection.",
  },
  noun: {
    script: "When Siobhan walked onto the site that morning, the crew had already lifted the third girder, and the crane operator waved her over to look.",
    heard: "When Shiv on walked onto the site that morning, the crew had already lifted the third girder, and the crane operator waved her over to look.",
  },
};

test("an exact line scores 0, case and punctuation forgiven", () => {
  /* MUTATION: drop canonical() from normalizeForWer -> "Firth" vs "firth" and the commas count as errors. */
  const s = scoreItem(FIX.exact.script, FIX.exact.heard);
  assert.equal(s.wer, 0);
  assert.equal(s.errors, 0);
  assert.deepEqual(s.suspects, []);
  assert.ok(s.refWords >= 20, `fixture has ${s.refWords} words`);
});

test("a line with numbers as digits scores 0 against Whisper's words after normalisation", () => {
  /* MUTATION: normalizeForWer without spokenNumbers -> 1969, 3, 12, 1950s, 40%, 1,200 and 21st all count. */
  const s = scoreItem(FIX.digits.script, FIX.digits.heard);
  assert.equal(s.errors, 0, JSON.stringify(s.suspects));
  assert.equal(s.wer, 0);
  /* and digits on both sides agree too */
  assert.equal(scoreItem(FIX.digits.script, FIX.digits.script).wer, 0);
});

test("spokenNumbers says years, ordinals, decades, decimals, counts, percent and dollars as a narrator does", () => {
  /* MUTATION: read every 4-digit number as a cardinal -> 1969 becomes "one thousand nine hundred sixty nine". */
  const cases = [
    ["1969", "nineteen sixty nine"],
    ["1905", "nineteen oh five"],
    ["1900", "nineteen hundred"],
    ["2005", "two thousand five"],
    ["2024", "twenty twenty four"],
    ["1000", "one thousand"],
    ["1,200", "one thousand two hundred"],
    ["21st", "twenty first"],
    ["12th", "twelfth"],
    ["the 1960s", "the nineteen sixties"],
    ["the '90s", "the nineties"],
    ["3.5%", "three point five percent"],
    ["$5 million", "five million dollars"],
    ["$1,000", "one thousand dollars"],
    ["007", "zero zero seven"],
    ["COVID-19", "covid nineteen"],
  ];
  for (const [input, want] of cases) assert.equal(normalizeForWer(input), want, input);
  assert.equal(spokenNumbers("no numbers here"), "no numbers here");
});

test("a mangled proper noun on a 20+ word line exceeds 5% and is listed as the suspect", () => {
  /* MUTATION: build suspects from hyp words only -> "siobhan" is never named. */
  const s = scoreItem(FIX.noun.script, FIX.noun.heard);
  assert.ok(s.refWords >= 20, `fixture has ${s.refWords} words`);
  assert.equal(s.errors, 2);
  assert.ok(s.wer > 0.05, `wer ${s.wer}`);
  assert.deepEqual(s.suspects, [{ ref: "siobhan", heard: "shiv on" }]);
  assert.equal(isFlagged(s), true);
});

test("the 5% edge: 1 error in 20 words passes, 2 in 20 is flagged, 2 in 40 passes", () => {
  /* MUTATION: wer >= maxWer instead of > -> 1/20 = exactly 5% is flagged. */
  const one = scoreItem(line(20), swap(20, 1));
  assert.equal(one.wer, 0.05);
  assert.equal(isFlagged(one), false);
  const two = scoreItem(line(20), swap(20, 2));
  assert.equal(isFlagged(two), true);
  const forty = scoreItem(`${line(20)} ${line(20)}`, `${swap(20, 2)} ${line(20)}`);
  assert.equal(forty.wer, 0.05);
  assert.equal(isFlagged(forty), false);
  assert.equal(isFlagged(scoreItem(`${line(20)} ${line(20)}`, `${swap(20, 3)} ${line(20)}`)), true);
});

test("the short-line rule: under 20 words a line is flagged only on 2 or more errors", () => {
  /* MUTATION: SHORT_LINE_MIN_ERRORS = 1 (or WER on short lines) -> one slip on a 10-word line (10%) is flagged. */
  const ten1 = scoreItem(line(10), swap(10, 1));
  assert.equal(ten1.wer, 0.1);
  assert.equal(isFlagged(ten1), false);
  assert.equal(isFlagged(scoreItem(line(10), swap(10, 2))), true);
  /* 19 words, 1 error: 5.3% WER, still the short-line rule */
  assert.equal(isFlagged(scoreItem(line(19), swap(19, 1))), false);
  /* the threshold and the line length are options */
  assert.equal(isFlagged(ten1, { minRefWords: 10, maxWer: 0.05 }), true);
});

test("errors are wordEditDistance, and the alignment's non-ok ops number exactly that", () => {
  /* MUTATION: count errors from the alignment with a different cost model -> the two disagree. */
  const pairs = [
    [FIX.noun.script, FIX.noun.heard],
    [line(10), "alpha charlie delta echo extra foxtrot golf hotel india juliet kilo"],
    ["", "something heard over silence"],
    [line(5), ""],
  ];
  for (const [ref, hyp] of pairs) {
    const r = normalizeForWer(ref).split(" ").filter(Boolean);
    const h = normalizeForWer(hyp).split(" ").filter(Boolean);
    const d = wordEditDistance(r, h);
    assert.equal(scoreItem(ref, hyp).errors, d);
    assert.equal(alignWords(r, h).filter((o) => o.op !== "ok").length, d);
  }
  assert.equal(scoreItem("", "something heard").wer, 1);
  assert.equal(scoreItem(line(5), "").wer, 1);
});

/* ---------- the manifest ---------- */

const FID = "asr-fixture-draft";
const ITEMS = [
  { type: "narration", id: "n-exact", script: FIX.exact.script },
  { type: "narration", id: "n-noun", script: FIX.noun.script },
  { type: "narration", id: "n-digits", script: FIX.digits.script },
  { type: "segment", segment_id: "show#1" },
  { type: "narration", id: "n-short", script: "Benjamin Baker drew it on a napkin first." },
  { type: "narration", id: "n-old", script: "Stamped by an earlier render." },
];
const RENDERED = ["n-exact", "n-noun", "n-digits", "n-short"];
const DOC = () => ({ forays: [{ id: FID, status: "draft", runtime_sec: 600, items: structuredClone(ITEMS) }] });

function keyOf(itemId, voice) {
  return `${PROFILE.key_prefix}/${PROFILE.id}/${voice}/${sha(FID + itemId + voice)}.m4a`;
}
function fakeBytes(itemId, voice) {
  return Buffer.from(`fake m4a ${itemId} ${voice}`);
}
function manifest(voices = ["af_heart"]) {
  const items = [];
  for (const voice of voices) {
    for (const it of ITEMS.filter((i) => RENDERED.includes(i.id))) {
      const bytes = fakeBytes(it.id, voice);
      items.push({
        foray_id: FID, item_id: it.id, voice, status: "rendered", key: keyOf(it.id, voice),
        bytes: bytes.length, duration_sec: 8, sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        profile: PROFILE.id, text_sha256: sha(it.script), lexicon_sha: null, chunks: 1,
      });
    }
  }
  items.push({
    foray_id: FID, item_id: "n-old", voice: "af_heart", status: "unchanged", key: keyOf("n-old", "af_heart"), duration_sec: 3,
    profile: PROFILE.id, text_sha256: sha(ITEMS.find((i) => i.id === "n-old").script), lexicon_sha: null, chunks: 1,
  });
  return {
    kind: "foray-narration-render", version: 1, profile: PROFILE.id,
    totals: { items: items.length, rendered: items.length - 1, unchanged: 1, failed: 0, bytes: items.reduce((a, e) => a + (e.bytes || 0), 0), duration_sec: 0 },
    items, failed: [],
  };
}
/* What "Whisper" heard, per line: the noun line is mangled, the short line has one slip. */
const HEARD = {
  "n-exact": FIX.exact.heard,
  "n-noun": FIX.noun.heard,
  "n-digits": FIX.digits.heard,
  "n-short": "Benjamin Bakker drew it on a napkin first.",
};
const asrRows = (voices = ["af_heart"]) =>
  voices.flatMap((v) => Object.entries(HEARD).map(([id, text]) => ({ key: keyOf(id, v), text, model: "faster-whisper:base.en" })));
const asrMap = (rows) => new Map(rows.map((r) => [r.key, r]));

test("checkManifest flags the mangled line only, skips unchanged lines and gathers lexicon candidates", () => {
  /* MUTATION: gather candidates only from flagged lines -> the proper noun "baker" on the clean short line is lost;
     MUTATION: check "unchanged" entries -> n-old is reported missing. */
  const res = checkManifest(manifest(), asrMap(asrRows()), { scripts: scriptsFrom(DOC()) });
  assert.equal(res.results.length, 4);
  assert.deepEqual(res.flagged.map((r) => r.item_id), ["n-noun"]);
  assert.equal(res.skipped, 1);
  assert.deepEqual(res.missing, []);
  assert.deepEqual(res.stale, []);
  const short = res.results.find((r) => r.item_id === "n-short");
  assert.equal(short.errors, 1);
  assert.equal(short.flagged, false);
  assert.deepEqual(res.lexiconCandidates.map((c) => [c.word, c.proper, c.count]), [["baker", true, 1], ["siobhan", true, 1]]);
  assert.deepEqual(res.lexiconCandidates.find((c) => c.word === "siobhan").heard, ["shiv on"]);
});

test("properNouns keeps mid-sentence capitals and drops sentence starts", () => {
  /* MUTATION: drop the sentence-start rule -> "when" and "the" become proper nouns. */
  assert.deepEqual([...properNouns(FIX.noun.script)], ["siobhan"]);
  assert.deepEqual([...properNouns("The bridge. Then Ada Lovelace came.")], ["ada", "lovelace"]);
});

test("a line with no ASR row is MISSING and a line whose script moved is STALE; neither is scored", () => {
  /* MUTATION: drop the text_sha256 check -> the edited script is scored against audio of the old one. */
  const doc = DOC();
  doc.forays[0].items.find((i) => i.id === "n-exact").script = "An edited script.";
  const rows = asrRows().filter((r) => r.key !== keyOf("n-digits", "af_heart"));
  const res = checkManifest(manifest(), asrMap(rows), { scripts: scriptsFrom(doc) });
  assert.deepEqual(res.missing.map((m) => m.item_id), ["n-digits"]);
  assert.deepEqual(res.stale.map((m) => [m.item_id, m.reason]), [["n-exact", "the script changed since it was rendered"]]);
  assert.deepEqual(res.results.map((r) => r.item_id).sort(), ["n-noun", "n-short"]);
  assert.throws(() => checkManifest(manifest(), new Map(), {}), /scripts/);
});

test("scriptsFrom reads data/forays.json's shape and a candidate's (top-level id + items)", () => {
  /* MUTATION: read only {forays} -> a generated candidate cannot be checked before it is published. */
  const cand = { id: FID, items: structuredClone(ITEMS) };
  assert.deepEqual([...scriptsFrom(cand).values()], [...scriptsFrom(DOC()).values()]);
  assert.equal(scriptsFrom(DOC()).size, 5);
  assert.throws(() => scriptsFrom({ nope: 1 }), /neither/);
});

test("holdFlagged holds exactly the flagged entries, restates the totals and leaves its input alone", () => {
  /* MUTATION: mutate the manifest in place -> the input's status changes too;
     MUTATION: leave totals.rendered -> it still counts the held line. */
  const m = manifest(["af_heart", "am_echo"]);
  const before = JSON.stringify(m);
  const res = checkManifest(m, asrMap(asrRows(["af_heart", "am_echo"])), { scripts: scriptsFrom(DOC()) });
  const { manifest: out, held } = holdFlagged(m, res.flagged);
  assert.equal(JSON.stringify(m), before);
  assert.equal(held, 2);
  const flagged = out.items.filter((e) => e.status === "flagged");
  assert.deepEqual(flagged.map((e) => [e.item_id, e.voice]), [["n-noun", "af_heart"], ["n-noun", "am_echo"]]);
  assert.equal(flagged[0].asr.errors, 2);
  assert.deepEqual(flagged[0].asr.suspects, [{ ref: "siobhan", heard: "shiv on" }]);
  assert.equal(out.totals.rendered, 6);
  assert.equal(out.totals.flagged, 2);
  assert.equal(out.totals.bytes, out.items.filter((e) => e.status === "rendered").reduce((a, e) => a + e.bytes, 0));
  /* every other entry is byte-for-byte the input's */
  for (const [i, e] of out.items.entries()) if (e.status !== "flagged") assert.deepEqual(e, m.items[i]);
});

/* ---------- the CLI, and what stamp and upload do with a held line ---------- */

function renderDir(voices = ["af_heart"]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asr-check-"));
  const m = manifest(voices);
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
  for (const e of m.items.filter((x) => x.status === "rendered")) {
    const p = path.join(dir, ...e.key.split("/"));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, fakeBytes(e.item_id, e.voice));
  }
  fs.writeFileSync(path.join(dir, "asr.jsonl"), asrRows(voices).map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "source.json"), JSON.stringify(DOC(), null, 2) + "\n");
  return dir;
}
const runCli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: ROOT });

test("with --hold-flagged, stamp-narration stamps only the unflagged lines and collectUploads skips the flagged one", () => {
  /* MUTATION: --hold-flagged writes nothing (or a status stamp/upload still take) -> n-noun is stamped and uploaded. */
  const dir = renderDir();
  try {
    const r = runCli([dir, "--source", path.join(dir, "source.json"), "--hold-flagged"]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /held 1 line\(s\) in manifest\.json: status -> flagged/);
    const held = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    assert.equal(held.items.find((e) => e.item_id === "n-noun").status, "flagged");

    /* MUTATION: CHECKED_STATUSES = new Set(["rendered"]) -> on a later run the held line is skipped,
       the run exits 0 and n-noun drops out of the FLAGGED report. */
    const again = runCli([dir, "--source", path.join(dir, "source.json")]);
    assert.equal(again.status, 1, again.stderr);
    assert.match(again.stdout, /4 line\(s\) checked/);
    assert.match(again.stdout, /FLAGGED asr-fixture-draft \/ n-noun/);

    const doc = DOC();
    const res = stampForays(doc, [{ file: "manifest.json", manifest: held }], { base: "https://audio.jwlabs.ai", profile: PROFILE });
    const items = doc.forays[0].items;
    assert.equal(res.stamped, 4, "the three clean rendered lines and the unchanged one");
    assert.equal(items.find((i) => i.id === "n-noun").audio_url, undefined);
    for (const id of ["n-exact", "n-digits", "n-short", "n-old"]) assert.ok(items.find((i) => i.id === id).audio_url, id);

    const uploads = collectUploads(dir, PROFILE).map((u) => u.key);
    assert.equal(uploads.length, 3);
    assert.ok(!uploads.includes(keyOf("n-noun", "af_heart")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("without --hold-flagged the CLI only reports: manifest and source unchanged, flagged lines and candidates listed", () => {
  /* MUTATION: hold by default -> the manifest changes on a report-only run. */
  const dir = renderDir();
  try {
    const mBefore = fs.readFileSync(path.join(dir, "manifest.json"), "utf8");
    const sBefore = fs.readFileSync(path.join(dir, "source.json"), "utf8");
    const out = path.join(dir, "report.json");
    const r = runCli([dir, "--asr", path.join(dir, "asr.jsonl"), "--source", path.join(dir, "source.json"), "--json", out]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /4 line\(s\) checked \(faster-whisper:base\.en\); 1 flagged/);
    assert.match(r.stdout, /FLAGGED asr-fixture-draft \/ n-noun \/ af_heart {2}WER 8\.\d% \(2\/2\d\) {2}"siobhan" heard "shiv on"/);
    assert.match(r.stdout, /siobhan {2}x1 {2}proper noun {2}heard: "shiv on"/);
    assert.equal(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"), mBefore);
    assert.equal(fs.readFileSync(path.join(dir, "source.json"), "utf8"), sBefore);
    const rep = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(rep.kind, "foray-narration-asr-check");
    assert.equal(rep.max_wer, 0.05);
    assert.equal(rep.items.length, 4);
    assert.deepEqual(rep.manifests[0], { file: "manifest.json", checked: 4, flagged: 1, missing: [], stale: [], skipped: 1 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI exits 0 when every line passes and 2 on a refusal", () => {
  /* MUTATION: exit 0 whatever was flagged -> a batch cannot tell a clean render from a garbled one. */
  const dir = renderDir();
  try {
    const clean = asrRows().map((r) => (r.key === keyOf("n-noun", "af_heart") ? { ...r, text: FIX.noun.script } : r));
    fs.writeFileSync(path.join(dir, "asr.jsonl"), clean.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const ok = runCli([dir, "--source", path.join(dir, "source.json")]);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /0 flagged/);
    assert.equal(runCli([dir, "--bogus"]).status, 2);
    assert.equal(runCli([dir, "--max-wer", "5"]).status, 2);
    const noAsr = runCli([dir, "--asr", path.join(dir, "nope.jsonl"), "--source", path.join(dir, "source.json")]);
    assert.equal(noAsr.status, 2);
    assert.match(noAsr.stderr, /no ASR file/);
    fs.writeFileSync(path.join(dir, "bad.jsonl"), '{"key": 1}\n');
    assert.throws(() => readAsr(path.join(dir, "bad.jsonl")), /bad\.jsonl:1 needs a string key and text/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- asr-transcribe.py ---------- */

function py(snippet) {
  const loader =
    `import json,sys,importlib.util,pathlib\n` +
    `spec=importlib.util.spec_from_file_location("at", ${JSON.stringify(PY_SCRIPT)})\n` +
    `A=importlib.util.module_from_spec(spec); spec.loader.exec_module(A)\n`;
  const r = spawnSync(PYTHON, ["-c", loader + snippet], { encoding: "utf8", cwd: ROOT });
  assert.equal(r.status, 0, `python failed:\n${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
}

test("a Python interpreter is available for asr-transcribe.py -- this suite does not silently skip", () => {
  assert.ok(PYTHON, "no python3/python/py on PATH");
});

test("asr-transcribe writes one {key, text, model} row per rendered or held line, and --resume keeps what it heard", () => {
  /* MUTATION: transcribe "unchanged" entries too -> a line with no file in this render is asked for. */
  const dir = renderDir();
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    m.items[0].status = "flagged";
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(m));
    const out = path.join(dir, "heard.jsonl");
    const res = py(
      `d=pathlib.Path(${JSON.stringify(dir)})\n` +
        `plan=A.plan_files(d, A.read_manifests(d))\n` +
        `calls=[]\n` +
        `def fake(p):\n  calls.append(p.name)\n  if 'bad' in str(p): raise RuntimeError('x')\n  return '  heard   ' + p.stem[:6] + ' '\n` +
        `s1=A.transcribe_all(plan, fake, A.model_label('faster-whisper','base.en'), pathlib.Path(${JSON.stringify(out)}))\n` +
        `n1=len(calls)\n` +
        `s2=A.transcribe_all(plan, fake, 'm', pathlib.Path(${JSON.stringify(out)}), resume=True)\n` +
        `print(json.dumps({"keys":[p["key"] for p in plan],"s1":s1,"s2":s2,"n1":n1,"n2":len(calls)}))`
    );
    const rendered = m.items.filter((e) => e.status === "rendered" || e.status === "flagged").map((e) => e.key);
    assert.deepEqual(res.keys, rendered);
    assert.equal(res.s1.written, 4);
    assert.equal(res.n1, 4);
    assert.deepEqual(res.s2, { written: 0, skipped: 4, failed: [] });
    assert.equal(res.n2, 4, "--resume transcribed a key it already had");
    const rows = fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(Object.keys(rows[0]), ["key", "text", "model"]);
    assert.equal(rows[0].model, "faster-whisper:base.en");
    assert.match(rows[0].text, /^heard [0-9a-f]{6}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("asr-transcribe refuses a listed line whose file is not on disk, and a path-escaping key", () => {
  /* MUTATION: skip a missing file -> a line never heard would look clean (asr-check reports it MISSING only if it is absent from asr.jsonl, so the refusal must come first). */
  const dir = renderDir();
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    fs.rmSync(path.join(dir, ...m.items[1].key.split("/")));
    const res = py(
      `d=pathlib.Path(${JSON.stringify(dir)})\n` +
        `try:\n  A.plan_files(d, A.read_manifests(d)); r='planned'\nexcept A.AsrError as e:\n  r=str(e)\n` +
        `try:\n  A.plan_files(d, [(d/'m.json', {'items':[{'status':'rendered','key':'n/../../x.m4a'}]})]); r2='planned'\nexcept A.AsrError as e:\n  r2=str(e)\n` +
        `print(json.dumps([r, r2]))`
    );
    assert.match(res[0], /is in manifest\.json but not on disk/);
    assert.match(res[1], /is not a narration key/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("asr-transcribe makes no network call: local_files_only, HF_HUB_OFFLINE before the import, no network module", () => {
  /* MUTATION: local_files_only=False (or import urllib) -> a missing model would be downloaded. */
  const src = fs.readFileSync(PY_SCRIPT, "utf8");
  assert.match(src, /= WhisperModel\([^)]*local_files_only=True\)/, "the model is built with local_files_only=True");
  assert.doesNotMatch(src, /local_files_only=False/);
  assert.ok(src.indexOf('os.environ["HF_HUB_OFFLINE"] = "1"') < src.indexOf("from faster_whisper import"), "HF_HUB_OFFLINE must be set before the import");
  assert.doesNotMatch(src, /^\s*(import|from)\s+(urllib|requests|http|socket|httpx|aiohttp|boto3)\b/m);
  assert.doesNotMatch(src, /^(import|from)\s+faster_whisper/m, "faster_whisper must be imported only inside the engine");
  assert.doesNotMatch(src, /hf_hub_download|snapshot_download/);
});

test("the whisper.cpp engine converts to 16 kHz mono WAV, runs the named model, and refuses a model not on disk", () => {
  /* MUTATION: pass the .m4a straight to whisper-cli -> whisper.cpp reads only WAV. */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asr-cpp-"));
  try {
    const model = path.join(dir, "ggml-test.bin");
    fs.writeFileSync(model, "x");
    const res = py(
      `import types\n` +
        `calls=[]\n` +
        `def run(cmd, **kw):\n  calls.append(cmd)\n  return types.SimpleNamespace(returncode=0, stdout=' The bridge.\\n opened. \\n', stderr='')\n` +
        `t=A.whisper_cpp_transcriber('whisper-cli', ${JSON.stringify(model)}, ffmpeg='ffmpeg', threads=2, run=run)\n` +
        `text=t(pathlib.Path('x/abc.m4a'))\n` +
        `try:\n  A.whisper_cpp_transcriber('whisper-cli', 'no-such.bin', ffmpeg='ffmpeg', threads=2, run=run); r='ok'\nexcept A.AsrError as e:\n  r=str(e)\n` +
        `print(json.dumps({"text":text,"ff":calls[0],"w":calls[1],"refused":r,"label":A.model_label('whisper.cpp', ${JSON.stringify(model)})}))`
    );
    assert.equal(res.text, "The bridge. opened.");
    assert.deepEqual(res.ff.slice(-7, -1), ["-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"]);
    assert.match(res.ff.at(-1), /abc\.wav$/);
    assert.deepEqual(res.w.slice(0, 3), ["whisper-cli", "-m", model]);
    assert.match(res.w[4], /abc\.wav$/);
    assert.match(res.refused, /not one on disk/);
    assert.equal(res.label, "whisper.cpp:ggml-test.bin", "the row's model names the model, never a local path");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("asr-transcribe --check reports a verdict without loading a model, and no render output is a refusal", () => {
  /* MUTATION: import faster_whisper at module level -> --check crashes on a machine without it. */
  const r = spawnSync(PYTHON, [PY_SCRIPT, "--check"], { encoding: "utf8", cwd: ROOT });
  assert.ok(r.status === 0 || r.status === 1, r.stderr);
  assert.match(r.stdout, /faster-whisper: (installed|MISSING)/);
  assert.match(r.stdout, /(ready to transcribe\.|NOT READY)/);
  const cpp = spawnSync(PYTHON, [PY_SCRIPT, "--check", "--engine", "whisper.cpp", "--model", "no-such.bin"], { encoding: "utf8", cwd: ROOT });
  assert.equal(cpp.status, 1);
  assert.match(cpp.stdout, /MISSING \(a ggml model file\)/);
  const none = spawnSync(PYTHON, [PY_SCRIPT], { encoding: "utf8", cwd: ROOT });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /name a render output directory/);
});
