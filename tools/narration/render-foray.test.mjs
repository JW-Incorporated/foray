/* The central narration renderer's pure half, driven through the real interpreter.
 *
 * `docs/plans/spark-central-narration-assessment.md` §3.2 / §5 Phase 1. What
 * can be settled without the 325 MB model, misaki or ffmpeg (none of which CI's
 * test job installs): the content-hash key, the manifest's shape, the profile's
 * pins and settings, the Foray selection and its refusals, and the render
 * workflow's no-credentials contract, and GV-11's plan (a candidate document
 * instead of data/forays.json, --items, the default voice first). The audio itself is exercised by
 * `.github/workflows/render-narration.yml` (`--smoke`, and the Phase 1 drafts).
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const SCRIPT = path.join(HERE, "render-foray.py");
const PROFILE = JSON.parse(fs.readFileSync(path.join(HERE, "render-profile.json"), "utf8"));
const WORKFLOW = path.join(ROOT, ".github", "workflows", "render-narration.yml");

const PYTHON = (() => {
  for (const exe of ["python3", "python", "py"]) {
    if (spawnSync(exe, ["--version"], { encoding: "utf8" }).status === 0) return exe;
  }
  return null;
})();

function pyJson(snippet) {
  const loader =
    `import json,sys,importlib.util\n` +
    `spec=importlib.util.spec_from_file_location("rf", ${JSON.stringify(SCRIPT)})\n` +
    `R=importlib.util.module_from_spec(spec); spec.loader.exec_module(R)\n` +
    `P=R.load_profile()\n`;
  const r = spawnSync(PYTHON, ["-c", loader + snippet], { encoding: "utf8", cwd: ROOT });
  assert.equal(r.status, 0, `python failed:\n${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
}

function runCli(args) {
  return spawnSync(PYTHON, [SCRIPT, ...args], { encoding: "utf8", cwd: ROOT });
}

const HEART = "d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b";
const FP32 = "8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb";
const CHUNKS = JSON.stringify(["ðə sˈeɪk wʌz pˈɔːɹd.", "ɪt wʌz wˈɔːɹm."]);

test("a Python interpreter is available — this suite does not silently skip", () => {
  assert.ok(PYTHON, "no python3/python/py on PATH");
});

/* ---------- the key ---------- */

test("the key is n/<profile>/<voice>/<sha256>.m4a and deterministic", () => {
  /* MUTATION: add time.time() or the item id to key_material -> two calls differ. */
  const out = pyJson(
    `a=R.render_key(P,"af_heart","${HEART}","${FP32}",${CHUNKS})\n` +
      `b=R.render_key(P,"af_heart","${HEART}","${FP32}",${CHUNKS})\n` +
      `print(json.dumps([a,b]))`
  );
  assert.equal(out[0], out[1]);
  assert.match(out[0], new RegExp(`^n/${PROFILE.id}/af_heart/[0-9a-f]{64}\\.m4a$`));
});

test("the key changes with the voice, its weights, the model, the phonemes and every render setting", () => {
  /* Each is something that changes the audio bytes; a key blind to one would let
     a new render collide with an immutable old object (or be refused by it).
     MUTATION: drop any one field from key_material -> its pair compares equal. */
  const out = pyJson(
    `import copy\n` +
      `base=R.render_key(P,"af_heart","${HEART}","${FP32}",${CHUNKS})\n` +
      `Q=copy.deepcopy(P); Q["render"]["loudness"]["integrated_lufs"]=-18\n` +
      `S=copy.deepcopy(P); S["render"]["chunk_gap_sec"]=0.1\n` +
      `ch=${CHUNKS}; ch2=list(ch); ch2[1]=ch2[1]+" "\n` +
      `print(json.dumps({"base":base,` +
      `"voice":R.render_key(P,"am_echo","${HEART}","${FP32}",ch),` +
      `"voice_sha":R.render_key(P,"af_heart","0"*64,"${FP32}",ch),` +
      `"model":R.render_key(P,"af_heart","${HEART}","1"*64,ch),` +
      `"phonemes":R.render_key(P,"af_heart","${HEART}","${FP32}",ch2),` +
      `"chunking":R.render_key(P,"af_heart","${HEART}","${FP32}",[" ".join(ch)]),` +
      `"loudness":R.render_key(Q,"af_heart","${HEART}","${FP32}",ch),` +
      `"gap":R.render_key(S,"af_heart","${HEART}","${FP32}",ch)}))`
  );
  for (const [k, v] of Object.entries(out)) {
    if (k !== "base") assert.notEqual(v.split("/").at(-1), out.base.split("/").at(-1), `${k} did not change the hash`);
  }
});

test("the key does NOT change with what does not change the audio", () => {
  /* Content-addressed: the same phonemes in another Foray, under another item
     id, or with a reject threshold retuned, are the same object. An edit
     re-renders only the lines whose phonemes changed.
     MUTATION: hash the whole profile (not just `render`) -> the reject tweak moves it. */
  const out = pyJson(
    `import copy\n` +
      `Q=copy.deepcopy(P); Q["reject"]["min_chunk_peak"]=0.5; Q["public_base"]="https://example.invalid"\n` +
      `print(json.dumps([R.render_key(P,"af_heart","${HEART}","${FP32}",${CHUNKS}),` +
      `R.render_key(Q,"af_heart","${HEART}","${FP32}",${CHUNKS})]))`
  );
  assert.equal(out[0], out[1]);
});

test("a stamped line whose URL ends in the same key is unchanged, per voice", () => {
  /* MUTATION: compare Heart's audio_url for every voice -> Echo reports unchanged wrongly. */
  const out = pyJson(
    `k="n/x/af_heart/"+"a"*64+".m4a"; e="n/x/am_echo/"+"b"*64+".m4a"\n` +
      `item={"audio_url":"https://audio.jwlabs.ai/"+k,"voices":{"am_echo":{"audio_url":"https://audio.jwlabs.ai/"+e}}}\n` +
      `print(json.dumps([R.is_unchanged(item,"af_heart","af_heart",k),R.is_unchanged(item,"am_echo","af_heart",e),` +
      `R.is_unchanged(item,"am_echo","af_heart",k),R.is_unchanged({},"af_heart","af_heart",k)]))`
  );
  assert.deepEqual(out, [true, true, false, false]);
});

/* ---------- the manifest ---------- */

test("a manifest entry carries the card's fields, always all of them, in order", () => {
  /* {foray_id, item_id, voice, key, bytes, duration_sec, sha256, profile} is the
     card's contract with upload/stamp; the rest proves which script and lexicon
     were rendered. MUTATION: drop `sha256` from ENTRY_KEYS, or accept an unknown field. */
  const out = pyJson(
    `e=R.manifest_entry(foray_id="f",item_id="i",voice="af_heart",status="unchanged",key="k",profile="p")\n` +
      `try:\n  R.manifest_entry(bogus=1); bad=False\nexcept ValueError:\n  bad=True\n` +
      `print(json.dumps({"keys":list(e),"bytes":e["bytes"],"refused":bad}))`
  );
  for (const k of ["foray_id", "item_id", "voice", "key", "bytes", "duration_sec", "sha256", "profile", "text_sha256", "lexicon_sha", "status"]) {
    assert.ok(out.keys.includes(k), `manifest entry lacks ${k}`);
  }
  assert.equal(out.keys[0], "foray_id");
  assert.equal(out.bytes, null);
  assert.equal(out.refused, true);
});

test("the manifest document totals what it lists and names the profile", () => {
  /* MUTATION: count `unchanged` lines' bytes, or drop `profile` -> red. */
  const out = pyJson(
    `a=R.manifest_entry(foray_id="f",item_id="1",voice="af_heart",status="rendered",key="k1",bytes=1000,duration_sec=2.5,sha256="x",profile=P["id"])\n` +
      `b=R.manifest_entry(foray_id="f",item_id="2",voice="af_heart",status="unchanged",key="k2",duration_sec=1.5,profile=P["id"])\n` +
      `print(json.dumps(R.manifest_doc(P,{"name":"m"},{},{},[a,b],[{"error":"x"}])))`
  );
  assert.equal(out.kind, "foray-narration-render");
  assert.equal(out.profile, PROFILE.id);
  assert.deepEqual(out.totals, { items: 2, rendered: 1, unchanged: 1, failed: 1, bytes: 1000, duration_sec: 4 });
});

/* ---------- the profile ---------- */

test("the profile is D2/D5: 1.0x, AAC .m4a 64 kbps mono 24 kHz, -19 LUFS / -1 dBTP, fp32", () => {
  /* MUTATION: speed 1.5, 128 kbps, stereo, q8f16 -> red. */
  const r = PROFILE.render;
  assert.equal(r.speed, 1.0);
  assert.equal(r.encode.codec, "aac");
  assert.equal(r.encode.container, "m4a");
  assert.equal(r.encode.bitrate_kbps, 64);
  assert.equal(r.encode.channels, 1);
  assert.equal(r.encode.sample_rate, 24000);
  assert.equal(r.loudness.integrated_lufs, -19);
  assert.equal(r.loudness.true_peak_dbtp, -1);
  assert.equal(PROFILE.model, "kokoro-v1_0-fp32.onnx");
  assert.deepEqual(PROFILE.voices, ["af_heart", "am_echo"]);
  assert.equal(PROFILE.default_voice, "af_heart");
  assert.equal(PROFILE.bucket, "foray-narration");
  assert.equal(PROFILE.content_type, "audio/mp4");
  assert.match(PROFILE.cache_control, /immutable/);
});

test("the pins come from fetch-models.mjs, and Echo's recorded pin equals the bench's", () => {
  /* One hash table: the model and Heart are read from fetch-models.mjs, and
     Echo's recorded sha256 must match bench-narration.py's RECORDED_VOICE_PINS.
     MUTATION: edit one hex digit of Echo's pin in render-profile.json. */
  const out = pyJson(
    `pins=R.read_pins()\n` +
      `print(json.dumps({"model":R.model_pin(P,pins)["sha256"],"heart":R.voice_pin("af_heart",P,pins),"echo":R.voice_pin("am_echo",P,pins)}))`
  );
  assert.equal(out.model, FP32);
  assert.equal(out.heart.sha256, HEART);
  assert.equal(out.heart.pinned_by, "tools/mobile/fetch-models.mjs");
  const bench = fs.readFileSync(path.join(HERE, "bench-narration.py"), "utf8");
  assert.ok(bench.includes(out.echo.sha256), "Echo's recorded pin differs from bench-narration.py's");
  assert.equal(out.echo.bytes, 522240);
});

test("loudness is ONE gain to -19 LUFS with a capped peak limiter, and a line is whole AAC frames", () => {
  /* The drafts render left 91/118 Heart lines 1-6 dB under target with a plain
     peak-capped gain; now the gain always aims at -19 and a limiter takes up to
     6 dB of peaks, beyond which the gain gives way. A line of whole 1024-sample
     frames decodes to exactly its PCM length, which is what duration_sec claims.
     MUTATION: drop the cap, cap the gain at the ceiling again, or drop the frame alignment. */
  const out = pyJson(
    `r=P["render"]\n` +
      `f=r["frame_samples"]; pad=int(round(r["edge_pad_sec"]*r["sample_rate"])); ns=(1,1023,1024,8001,123457)\n` +
      `tails=[R.tail_pad_samples(pad,n,f) for n in ns]\n` +
      `print(json.dumps({"quiet":R.gain_plan(r,-25.0,-10.0),"hot":R.gain_plan(r,-25.0,-4.0),"wild":R.gain_plan(r,-30.0,-2.0),` +
      `"lim":R.limiter_filter(r),"f":f,` +
      `"whole":[(pad+n+t)%f for n,t in zip(ns,tails)],"extra":[t-pad for t in tails]}))`
  );
  assert.deepEqual(out.quiet, [6.0, 0.0, "linear"]); // -10 + 6 = -4 dBTP, under the -1.5 ceiling
  assert.deepEqual(out.hot, [6.0, 3.5, "limited"]); // -4 + 6 = +2, 3.5 dB over -1.5
  assert.deepEqual(out.wild, [6.5, 6.0, "limited-capped"]); // +11 dB would put -2 at +9, 10.5 over; 4.5 dB of gain gives way
  assert.match(out.lim, /^alimiter=limit=0\.84\d+:attack=5:release=50:level=0:latency=1$/);
  assert.equal(out.f, 1024);
  assert.deepEqual(out.whole, [0, 0, 0, 0, 0]);
  assert.ok(out.extra.every((x) => x >= 0 && x < 1024), "the stretch is under one frame of silence");
});

test("a line whose ENCODED true peak is over -1 dBTP is re-encoded with a lower ceiling, never accepted", () => {
  /* The drafts render (run 36441570533) left 12 of 236 lines at -1.0 to -0.2
     dBTP: the limiter holds sample peaks, and AAC re-synthesis overshoots them.
     The card's target is -1 dBTP, so the encoded file's true peak is the test.
     MUTATION: accept an overshoot (next_headroom returns None when over), stop
     adding the step, drop extra headroom from the limiter or the gain plan, or
     retry forever (no attempts cap). */
  const out = pyJson(
    `r=P["render"]\n` +
      `print(json.dumps({"ok":R.next_headroom(r,0.0,-1.0),"under":R.next_headroom(r,0.0,-3.2),` +
      `"over":R.next_headroom(r,0.0,-0.37),"again":R.next_headroom(r,0.83,-0.9),` +
      `"c0":R.limiter_ceiling_db(r),"c1":R.limiter_ceiling_db(r,0.83),` +
      `"lim1":R.limiter_filter(r,0.83),"gain1":R.gain_plan(r,-25.0,-4.0,0.83),` +
      `"retry":r["loudness"]["true_peak_retry"]}))`
  );
  assert.equal(out.ok, null, "exactly at the target is accepted");
  assert.equal(out.under, null);
  assert.equal(out.over, 0.83); // 0.63 over, plus the 0.2 step
  assert.equal(out.again, 1.13); // cumulative: the second retry lowers the ceiling further
  assert.equal(out.c0, -1.5);
  assert.equal(out.c1, -2.33);
  assert.match(out.lim1, /^alimiter=limit=0\.76\d+:/); // 10^(-2.33/20)
  assert.deepEqual(out.gain1, [6.0, 4.33, "limited"]); // same gain (loudness kept), the limiter takes the extra
  assert.ok(out.retry.attempts >= 2 && out.retry.attempts <= 5, "a bounded number of encodes");
  assert.ok(out.retry.step_db > 0);
});

test("a render speed other than 1.0 is refused at load (ruling D2)", () => {
  /* MUTATION: delete the speed guard in load_profile. */
  const out = pyJson(
    `import tempfile,pathlib\n` +
      `d=json.loads(R.PROFILE_PATH.read_text(encoding="utf-8")); d["render"]["speed"]=1.5\n` +
      `p=pathlib.Path(tempfile.mkdtemp())/"p.json"; p.write_text(json.dumps(d),encoding="utf-8")\n` +
      `try:\n  R.load_profile(p); print(json.dumps("accepted"))\nexcept R.RenderError as e:\n  print(json.dumps(str(e)))`
  );
  assert.match(out, /D2/);
});

/* ---------- selection ---------- */

/* A synthetic catalogue, so these tests do not read live data (a publish
   must never be able to break them; backend/test/publishSuites.test.ts). */
const DOC =
  `N=lambda i,s: {"type":"narration","id":i,"script":s}\n` +
  `doc={"forays":[` +
  `{"id":"pub","status":"published","items":[N("a","Published narration line here.")]},` +
  `{"id":"d1","status":"draft","items":[{"type":"segment"},N("x","A fairly long line of narration, the longest of all."),N("y","Short one."),N("z","Middle-sized narration line."),N("w","Tiny.")]},` +
  `{"id":"d2","status":"draft","items":[{"type":"segment"}]},` +
  `{"id":"d3","status":"draft","items":[N("q","Another draft line.")]}]}\n`;

test("@drafts selects exactly the narrated drafts, never a published Foray", () => {
  /* §5 Phase 1 renders the narrated DRAFTS; a published Foray waits for the
     player's fallback. MUTATION: select on `narration_items` alone -> "pub" joins. */
  const out = pyJson(DOC + `print(json.dumps([f["id"] for f in R.select_forays(doc,["@drafts"])]))`);
  assert.deepEqual(out, ["d1", "d3"]);
});

test("naming a Foray with no narration, or an unknown id, is refused", () => {
  /* MUTATION: skip it silently -> a render run that renders nothing looks green. */
  const out = pyJson(
    DOC +
      `res=[]\n` +
      `for want in (["d2"],["nope"],["d1","d1"]):\n` +
      `  try: res.append([f["id"] for f in R.select_forays(doc,want)])\n` +
      `  except R.RenderError as e: res.append(str(e))\n` +
      `print(json.dumps(res))`
  );
  assert.match(out[0], /d2 has no narration/);
  assert.match(out[1], /nope is not a Foray id/);
  assert.deepEqual(out[2], ["d1"]);
});

test("--smoke picks the two shortest lines of the first Foray, in running order", () => {
  /* MUTATION: take items[:2] -> not the shortest; sort by length -> out of order. */
  const out = pyJson(
    DOC + `(foray,items),=R.smoke_selection(R.select_forays(doc,["d1","d3"]))\n` +
      `print(json.dumps([foray["id"],[i["id"] for i in items]]))`
  );
  assert.deepEqual(out, ["d1", ["y", "w"]]);
});

test("the CLI refuses an unknown Foray id before loading anything heavy", () => {
  /* Executes the real entry point (a module-level error would show here).
     MUTATION: validate the selection after the model loads -> this needs ffmpeg/onnx and fails differently. */
  const r = runCli(["--forays", "no-such-foray"]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /no-such-foray is not a Foray id/);
});

test("--check runs on a machine without the backend and says what is missing", () => {
  /* MUTATION: import onnxruntime at module level -> --check crashes instead of reporting. */
  const r = runCli(["--check"]);
  assert.ok(r.status === 0 || r.status === 1, r.stderr);
  assert.match(r.stdout, /profile: kokoro-fp32-aac64-v1/);
  assert.match(r.stdout, /model pin: kokoro-v1_0-fp32\.onnx/);
  assert.match(r.stdout, /(ready to render\.|NOT READY)/);
});

test("--report renders a manifest as a markdown table", () => {
  /* MUTATION: drop the per-voice row -> red. */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rf-"));
  try {
    const m = {
      kind: "foray-narration-render", version: 1, profile: PROFILE.id,
      totals: { items: 1, rendered: 1, unchanged: 0, failed: 0, bytes: 64000, duration_sec: 8 },
      items: [{ foray_id: "f1", item_id: "i", voice: "am_echo", status: "rendered", bytes: 64000, duration_sec: 8 }],
      failed: [],
    };
    const p = path.join(tmp, "manifest.json");
    fs.writeFileSync(p, JSON.stringify(m));
    const r = runCli(["--report", p]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\| f1 \| am_echo \| 1 \| 0 \| 0\.1 \| 0\.06 \| 64 \|/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/* ---------- GV-72: the per-Foray loudness spread ---------- */

const loudEntry = (fid, id, voice, i, tp, status = "rendered") => ({
  foray_id: fid, item_id: id, voice, status, bytes: 64000, duration_sec: 8,
  loudness: { input_i: -24, input_tp: -6, gain_db: 5, limit_db: 0, output_i: i, output_tp: tp, type: "gain", extra_headroom_db: 0, attempts: 1 },
});

test("--report prints a loudness spread line per Foray and flags a spread over 1 LU", () => {
  /* MUTATION: drop the spread lines from report_markdown -> no "Loudness" line;
     MUTATION: take max output_tp as min -> f2's -1.2 dBTP reads -2.0. */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rf-"));
  try {
    const items = [
      loudEntry("f1", "a", "af_heart", -19.2, -1.8),
      loudEntry("f1", "b", "af_heart", -18.9, -1.6),
      loudEntry("f1", "b", "am_echo", -18.6, -1.7),
      { foray_id: "f1", item_id: "c", voice: "af_heart", status: "unchanged", duration_sec: 4, loudness: null },
      loudEntry("f2", "a", "af_heart", -19.0, -2.0),
      loudEntry("f2", "b", "af_heart", -20.4, -1.2),
      { foray_id: "f3", item_id: "a", voice: "af_heart", status: "unchanged", duration_sec: 4, loudness: null },
    ];
    const m = {
      kind: "foray-narration-render", version: 1, profile: PROFILE.id,
      totals: { items: items.length, rendered: 5, unchanged: 2, failed: 0, bytes: 320000, duration_sec: 48 },
      items, failed: [],
    };
    const p = path.join(tmp, "manifest.json");
    fs.writeFileSync(p, JSON.stringify(m));
    const r = runCli(["--report", p]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^- Loudness f1: 3 line\(s\), output_i -19\.2 to -18\.6 LUFS, spread 0\.60 LU, max output_tp -1\.6 dBTP$/m);
    assert.match(r.stdout, /^- Loudness f2: 2 line\(s\), output_i -20\.4 to -19\.0 LUFS, spread 1\.40 LU, max output_tp -1\.2 dBTP \*\*SPREAD OVER 1\.0 LU\*\*$/m);
    assert.doesNotMatch(r.stdout, /Loudness f3/, "a Foray with no measured line has no spread line");
    assert.equal((r.stdout.match(/SPREAD OVER/g) || []).length, 1);
    /* the table is unchanged */
    assert.match(r.stdout, /\| f1 \| af_heart \| 3 \| 1 \| 0\.3 \| 0\.13 \| 51 \|/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a spread of exactly 1 LU is not flagged, and a non-finite measurement is left out", () => {
  /* MUTATION: flag spread >= LOUDNESS_SPREAD_MAX_LU -> the exact 1.0 LU Foray is flagged. */
  const items = [
    loudEntry("f1", "a", "af_heart", -19.5, -1.5),
    loudEntry("f1", "b", "af_heart", -18.5, -1.5),
    loudEntry("f1", "c", "af_heart", "nan", -1.5),
    /* -15.6 - -16.6 is 1.0000000000000018 in floating point: still 1.00 LU, not over */
    loudEntry("f2", "a", "af_heart", -16.6, -1.5),
    loudEntry("f2", "b", "af_heart", -15.6, -1.5),
  ];
  const res = pyJson(`print(json.dumps({"max":R.LOUDNESS_SPREAD_MAX_LU,"lines":R.loudness_spread_lines({"items":${JSON.stringify(items)}})}))`);
  assert.equal(res.max, 1.0);
  assert.deepEqual(res.lines, [
    "- Loudness f1: 2 line(s), output_i -19.5 to -18.5 LUFS, spread 1.00 LU, max output_tp -1.5 dBTP",
    "- Loudness f2: 2 line(s), output_i -16.6 to -15.6 LUFS, spread 1.00 LU, max output_tp -1.5 dBTP",
  ]);
});

/* ---------- GV-11: a candidate, per item, default voice first ---------- */

/* A PartialCandidate as runPipeline writes it (backend/src/generation/
   partialCandidate.ts): camelCase runtimeSec, acts, private visibility, the
   prelude and disclosure narration items (runPipeline.ts preludeItem /
   disclosureItem) ahead of the acts' items, one act still pending. */
const PARTIAL = {
  id: "gen-quiet-engines-3f2a1c",
  title: "Quiet engines",
  topic: "quiet engines",
  summary: "s",
  status: "partial",
  visibility: "private",
  authorId: "u1",
  acts: [{ index: 0, title: "One", status: "ready" }, { index: 1, title: "Two", status: "pending" }],
  slots: [{ id: "s1" }],
  items: [
    { type: "narration", id: "prelude", script: "Welcome to Foray. This one is about quiet engines.", mode: "marker" },
    { type: "narration", id: "disclosure", script: "The narration you will hear is synthetic.", mode: "marker", slot: "s1" },
    { type: "segment", slot: "s1", segment_id: "show#1" },
    { type: "narration", id: "a1-n1", script: "The first engine ran almost without a sound.", mode: "bridge" },
    { type: "segment", segment_id: "show#2" },
    { type: "jingle", id: "j1" },
    { type: "narration", id: "a1-n2", script: "Nobody noticed until it stopped.", mode: "bridge" },
  ],
  runtimeSec: 412,
  ttlA1Ms: 41000,
  builtAt: "2026-10-11T00:00:00.000Z",
  updatedAt: "2026-10-11T00:01:00.000Z",
  validation: { ok: true },
};

function withCandidate(doc, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rf-cand-"));
  try {
    const p = path.join(tmp, "partial.json");
    fs.writeFileSync(p, typeof doc === "string" ? doc : JSON.stringify(doc));
    return fn(p);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* plan_work with data/forays.json pointed at a path that does not exist, so
   any read of it fails the call. */
const PLAN = (argv) =>
  `import pathlib\nR.FORAYS_PATH=pathlib.Path(${JSON.stringify(path.join(os.tmpdir(), "rf-no-such", "forays.json"))})\n` +
  `a=R.build_parser().parse_args(${JSON.stringify(argv)})\n` +
  `try:\n  work,voices=R.plan_work(a,P); res={"work":[[f["id"],f["status"],[i["id"] for i in its]] for f,its in work],"voices":voices}\n` +
  `except R.RenderError as e:\n  res={"refused":str(e)}\n` +
  `print(json.dumps(res))`;

test("--candidate renders a PartialCandidate's narration, disclosure included, without reading data/forays.json", () => {
  /* MUTATION: plan_work reads FORAYS_PATH before (or regardless of) --candidate
     -> FileNotFoundError; or narration_items narrowed to `mode != marker` -> the
     prelude and disclosure drop out; or the wrap keeps the doc's status
     "partial" -> the status assertion fails. */
  const out = withCandidate(PARTIAL, (p) => pyJson(PLAN(["--candidate", p])));
  assert.deepEqual(out.work, [["gen-quiet-engines-3f2a1c", "candidate", ["prelude", "disclosure", "a1-n1", "a1-n2"]]]);
  assert.deepEqual(out.voices, ["af_heart", "am_echo"]);
});

test("a candidate document with no top-level id or items is refused, naming what is missing", () => {
  /* Any doc with a top-level id and items is a candidate; anything else is not
     rendered as an empty Foray. MUTATION: drop either guard in load_candidate
     -> a KeyError/TypeError escapes or the doc renders nothing silently. */
  const noId = withCandidate({ items: PARTIAL.items }, (p) => pyJson(PLAN(["--candidate", p])));
  const noItems = withCandidate({ id: "x", acts: [] }, (p) => pyJson(PLAN(["--candidate", p])));
  const notJson = withCandidate("{nope", (p) => pyJson(PLAN(["--candidate", p])));
  const noNarration = withCandidate({ id: "x", items: [{ type: "segment" }] }, (p) => pyJson(PLAN(["--candidate", p])));
  assert.match(noId.refused, /no top-level string `id`/);
  assert.match(noItems.refused, /no top-level `items` list/);
  assert.match(notJson.refused, /not JSON/);
  assert.match(noNarration.refused, /x has no narration item/);
});

test("--items keeps only the named narration lines, in play order, not the order asked", () => {
  /* MUTATION: build the kept list from `ids` (asked order) -> a1-n2 renders
     before the disclosure; or ignore --items in plan_work -> all four lines. */
  const out = withCandidate(PARTIAL, (p) => pyJson(PLAN(["--candidate", p, "--items", "a1-n2,disclosure"])));
  assert.deepEqual(out.work, [["gen-quiet-engines-3f2a1c", "candidate", ["disclosure", "a1-n2"]]]);
});

test("--items with an unknown id, or a non-narration id, is refused, and --items with --smoke too", () => {
  /* MUTATION: drop the unknown-id check in select_items -> the unknown id is
     skipped silently and the plan renders a subset that looks green; build
     `known` from every item rather than the narration lines -> j1 passes. */
  const unknown = withCandidate(PARTIAL, (p) => pyJson(PLAN(["--candidate", p, "--items", "a1-n1,nope"])));
  assert.match(unknown.refused, /--items: nope is not a narration item id/);
  const jingle = withCandidate(PARTIAL, (p) => pyJson(PLAN(["--candidate", p, "--items", "j1"])));
  assert.match(jingle.refused, /--items: j1 is not a narration item id/);
  const smoke = withCandidate(PARTIAL, (p) => pyJson(PLAN(["--candidate", p, "--items", "a1-n1", "--smoke"])));
  assert.match(smoke.refused, /--items and --smoke/);
});

test("voice_order puts the default voice first whatever --voices says, each voice once", () => {
  /* GP-08: Heart renders every line before Echo starts, so the default voice
     is complete first. MUTATION: return `voices` unchanged from voice_order, or
     drop the voice_order call in plan_work -> am_echo first. */
  const out = pyJson(
    `print(json.dumps({"fn":[R.voice_order(["am_echo","af_heart"],"af_heart"),R.voice_order(["am_echo"],"af_heart"),` +
      `R.voice_order(["af_heart","am_echo","af_heart"],"af_heart")]}))\n`
  );
  assert.deepEqual(out.fn, [["af_heart", "am_echo"], ["am_echo"], ["af_heart", "am_echo"]]);
  const plan = withCandidate(PARTIAL, (p) => pyJson(PLAN(["--candidate", p, "--voices", "am_echo,af_heart"])));
  assert.deepEqual(plan.voices, ["af_heart", "am_echo"]);
});

test("the render loop runs voices outside lines, over the planned order", () => {
  /* Default-voice-first only holds while render_all loops the planned voices
     outermost and the lines inside. MUTATION: swap the two loops, or have
     render_all re-read args.voices -> red. */
  const src = fs.readFileSync(SCRIPT, "utf8");
  const body = src.slice(src.indexOf("def render_all("), src.indexOf("\ndef ", src.indexOf("def render_all(") + 1));
  assert.match(body, /^def render_all\(args, profile: dict, work: list\[tuple\[dict, list\[dict\]\]\], voices: list\[str\]\)/);
  assert.doesNotMatch(body, /args\.voices|args\.forays|args\.candidate|FORAYS_PATH/);
  const outer = body.indexOf("for voice in voices:");
  const inner = body.indexOf("for line in lines:");
  assert.ok(outer > 0 && inner > outer, "voices must be the outer loop");
});

test("--forays and @drafts plan as before: data/forays.json, every line, Heart then Echo", () => {
  /* The default path is unchanged by GV-11. MUTATION: default to the candidate
     path or drop the @drafts default in plan_work -> red. */
  const out = pyJson(
    DOC +
      `import pathlib,tempfile\n` +
      `d=pathlib.Path(tempfile.mkdtemp())/"forays.json"; d.write_text(json.dumps(doc),encoding="utf-8"); R.FORAYS_PATH=d\n` +
      `res=[]\n` +
      `for argv in ([],["--forays","d3,d1"],["--forays","d1","--items","z"]):\n` +
      `  w,v=R.plan_work(R.build_parser().parse_args(argv),P); res.append([[[f["id"],[i["id"] for i in its]] for f,its in w],v])\n` +
      `print(json.dumps(res))`
  );
  assert.deepEqual(out[0], [[["d1", ["x", "y", "z", "w"]], ["d3", ["q"]]], ["af_heart", "am_echo"]]);
  assert.deepEqual(out[1], [[["d3", ["q"]], ["d1", ["x", "y", "z", "w"]]], ["af_heart", "am_echo"]]);
  assert.deepEqual(out[2], [[["d1", ["z"]]], ["af_heart", "am_echo"]]);
});

test("the key is pinned: a candidate line keys exactly as the same line did before GV-11", () => {
  /* Keys carry no ids, so a candidate's line and a forays.json line with the
     same phonemes are one object, and every stamped audio_url stays valid.
     The hex below is origin/main's key for these chunks before GV-11.
     MUTATION: add the Foray or item id, or bump KEY_SCHEMA -> the hash moves. */
  const out = pyJson(`print(json.dumps(R.render_key(P,"af_heart","${HEART}","${FP32}",${CHUNKS})))`);
  assert.equal(out, `n/${PROFILE.id}/af_heart/62e7e8ed8a47360cc318b096e926013b42cac61a0863e1d557e32ac23d65469f.m4a`);
});

test("refusals come from main before render_all, with exit 2", () => {
  /* Validation runs before anything heavy loads. render_all is replaced by a
     tripwire, so a refusal that happened inside it (after the model load in
     real life) would show as "REACHED". MUTATION: move plan_work into
     render_all, or drop the mutually exclusive group -> red. */
  const out = withCandidate(PARTIAL, (p) => pyJson(
    `import contextlib,io\n` +
      `R.render_all=lambda *a,**k: (_ for _ in ()).throw(SystemExit("REACHED"))\n` +
      `res=[]\n` +
      `for argv in (["--candidate",${JSON.stringify(p)},"--forays","d1"],["--candidate",${JSON.stringify(p)},"--items","nope"],["--forays","no-such-foray"]):\n` +
      `  err=io.StringIO()\n` +
      `  try:\n` +
      `    with contextlib.redirect_stderr(err): code=R.main(argv)\n` +
      `  except SystemExit as e: code=e.code\n` +
      `  res.append([code,err.getvalue()])\n` +
      `print(json.dumps(res))`
  ));
  assert.equal(out[0][0], 2);
  assert.match(out[0][1], /not allowed with argument/);
  assert.equal(out[1][0], 2);
  assert.match(out[1][1], /--items: nope is not a narration item id/);
  assert.equal(out[2][0], 2);
  assert.match(out[2][1], /no-such-foray is not a Foray id/);
});

test("the CLI refuses --candidate with --forays, and an unknown --items id, through the real entry point", () => {
  /* MUTATION: drop the mutually exclusive group -> the pair is accepted and the
     run proceeds to load weights. */
  withCandidate(PARTIAL, (p) => {
    const both = runCli(["--candidate", p, "--forays", "d1"]);
    assert.equal(both.status, 2, both.stderr);
    assert.match(both.stderr, /not allowed with argument/);
    const bad = runCli(["--candidate", p, "--items", "nope"]);
    assert.equal(bad.status, 2, bad.stderr);
    assert.match(bad.stderr, /--items: nope is not a narration item id/);
  });
});

/* ---------- GV-22: render_all through render_line, unchanged ---------- */

/* render_all with everything heavy faked at the seams render_line uses: a fake
   onnxruntime module, synthesize_chunks returning one second of samples per
   chunk, assemble returning sizes, normalize_and_encode writing a few bytes,
   and a fixed phonemize_work. No numpy, model, misaki or ffmpeg. Four lines:
   n1 renders, n2 is stamped with its Heart key (unchanged; Echo refuses its
   length), n3's length is refused, n4 failed phonemizing. Then render_all runs
   again over the same --out, which reuses both rendered lines from their
   sidecars. */
const RENDER_ALL_HARNESS = String.raw`
import types, pathlib, tempfile, io, contextlib
ort = types.ModuleType("onnxruntime"); ort.__version__ = "fake-ort"
class SO: intra_op_num_threads = 0
class Sess:
    def __init__(self, *a, **k): pass
ort.SessionOptions = SO; ort.InferenceSession = Sess
sys.modules["onnxruntime"] = ort
tmp = pathlib.Path(tempfile.mkdtemp())
R.shutil.which = lambda n: "/fake/" + n
R._tool_version = lambda exe: "fake-tool"
R.LEXICON_PATH = tmp / "no-lexicon.json"
R.ensure_file = lambda name, pin, d, s, a: tmp / name
R.load_style = lambda p: "style"
R.synthesize_chunks = lambda session, style, ids_list, render, reject: [[0.5] * 24000 for _ in ids_list]
class Buf:
    def __init__(self, n): self.size = n
R.assemble = lambda chunks, render: (Buf(sum(len(c) for c in chunks)), Buf(sum(len(c) for c in chunks) + 24000))
def fake_encode(ffmpeg, ffprobe, pcm, out, render, tmpd):
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(("audio " + out.name).encode())
    sec = round(pcm.size / 24000, 3)
    return {"input_i": -25.0, "input_tp": -6.0, "gain_db": 6.0, "limit_db": 0.0, "output_i": -19.0, "output_tp": -1.5,
            "type": "linear", "extra_headroom_db": 0.0, "attempts": 1, "decoded_sec": sec, "container_sec": round(sec + 0.021, 3)}
R.normalize_and_encode = fake_encode
pins = R.read_pins()
H = R.voice_pin("af_heart", P, pins)["sha256"]; M = R.model_pin(P, pins)["sha256"]
c2 = ["ðə fˈɜːst ˈɛnʤən.", "ɪt ɹæn."]
stamped = "https://audio.jwlabs.ai/" + R.render_key(P, "af_heart", H, M, ["sˈeɪm."])
items = [
    {"id": "n1", "script": "The first engine ran almost without a sound."},
    {"id": "n2", "script": "Same.", "audio_url": stamped, "duration_sec": 1.5},
    {"id": "n3", "script": "A very long line that the fake renders in one second flat, far shorter than the estimate of it says it should be."},
    {"id": "n4", "script": "Broken."},
]
lines = [
    {"foray_id": "f1", "item": items[0], "chunks": c2, "ids": [[1, 2], [3]], "error": None},
    {"foray_id": "f1", "item": items[1], "chunks": ["sˈeɪm."], "ids": [[4]], "error": None},
    {"foray_id": "f1", "item": items[2], "chunks": ["lˈɔŋ."], "ids": [[5]], "error": None},
    {"foray_id": "f1", "item": items[3], "chunks": [], "ids": [], "error": "unsingable: x"},
]
R.phonemize_work = lambda work: (lines, {"g2p": "fake", "fallback": "none", "vocab": "v"})
out = tmp / "out"
def run(extra):
    buf = io.StringIO()
    args = R.build_parser().parse_args(["--out", str(out), "--threads", "4", *extra])
    with contextlib.redirect_stdout(buf):
        code = R.render_all(args, P, [({"id": "f1"}, items)], ["af_heart", "am_echo"])
    return code, [l.split(" in ")[0] for l in buf.getvalue().splitlines()][:-1]
code, log = run([])
m = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
sidecars = sorted(str(p.relative_to(out)).replace("\\", "/") for p in out.rglob("*.json") if p.name != "manifest.json")
code2, log2 = run(["--manifest", str(tmp / "m2.json")])
m2 = json.loads((tmp / "m2.json").read_text(encoding="utf-8"))
print(json.dumps({"code": code, "manifest": m, "sidecars": sidecars, "log": log, "code2": code2, "same": m2 == m, "log2": log2}))
`;

/* origin/main's render_all (before GV-22) run through the same fakes, with
   real numpy and a fake ORT session standing in for synthesize_chunks. */
const PRE_GV22 = {
  totals: {"items": 3, "rendered": 2, "unchanged": 1, "failed": 5, "bytes": 148, "duration_sec": 7.5},
  items: [
    {"foray_id": "f1", "item_id": "n1", "voice": "af_heart", "status": "rendered", "key": "n/kokoro-fp32-aac64-v1/af_heart/9ef7181c7110f97767b46c6fb4af58f5bb864f1c99fdae7e37aa31cebb664ef5.m4a", "bytes": 74, "duration_sec": 3.0, "sha256": "a3b879c2814ad78435a8102a2b455740670ee8051e4826ce11b11aa22ae19b06", "profile": "kokoro-fp32-aac64-v1", "text_sha256": "941fbcb2110e52f67020b4b7faebd2b3ae381f9aae52e44c7c2e46d4f77c06c9", "lexicon_sha": null, "chunks": 2, "speech_sec": 2.0, "estimate_sec": 2.588, "container_sec": 3.021, "loudness": {"input_i": -25.0, "input_tp": -6.0, "gain_db": 6.0, "limit_db": 0.0, "output_i": -19.0, "output_tp": -1.5, "type": "linear", "extra_headroom_db": 0.0, "attempts": 1}},
    {"foray_id": "f1", "item_id": "n2", "voice": "af_heart", "status": "unchanged", "key": "n/kokoro-fp32-aac64-v1/af_heart/5dd596370434f63d84904396939f3ef8b2dc0c0c72720414cfc449634f5a395a.m4a", "bytes": null, "duration_sec": 1.5, "sha256": null, "profile": "kokoro-fp32-aac64-v1", "text_sha256": "30b5061f9468a257a0773ac313cd742c8fda549db9ccb228c2ed2067f7dc8715", "lexicon_sha": null, "chunks": 1, "speech_sec": null, "estimate_sec": 0.294, "container_sec": null, "loudness": null},
    {"foray_id": "f1", "item_id": "n1", "voice": "am_echo", "status": "rendered", "key": "n/kokoro-fp32-aac64-v1/am_echo/38754d16f39e5dc269c8cec0070ef4d2ad68d284393e214cfb3fee9d074db6ef.m4a", "bytes": 74, "duration_sec": 3.0, "sha256": "9628888eb8f45b7743162958e229908c2f503f92273efaf355acadee2bb1a547", "profile": "kokoro-fp32-aac64-v1", "text_sha256": "941fbcb2110e52f67020b4b7faebd2b3ae381f9aae52e44c7c2e46d4f77c06c9", "lexicon_sha": null, "chunks": 2, "speech_sec": 2.0, "estimate_sec": 2.588, "container_sec": 3.021, "loudness": {"input_i": -25.0, "input_tp": -6.0, "gain_db": 6.0, "limit_db": 0.0, "output_i": -19.0, "output_tp": -1.5, "type": "linear", "extra_headroom_db": 0.0, "attempts": 1}},
  ],
  failed: [
    {"foray_id": "f1", "item_id": "n3", "voice": "af_heart", "error": "spoken length 1.0 s is 0.15x the 6.647 s estimate, outside [0.5, 2.0]"},
    {"foray_id": "f1", "item_id": "n4", "voice": "af_heart", "error": "unsingable: x"},
    {"foray_id": "f1", "item_id": "n2", "voice": "am_echo", "error": "spoken length 1.0 s is 3.40x the 0.294 s estimate, outside [0.5, 2.0]"},
    {"foray_id": "f1", "item_id": "n3", "voice": "am_echo", "error": "spoken length 1.0 s is 0.15x the 6.647 s estimate, outside [0.5, 2.0]"},
    {"foray_id": "f1", "item_id": "n4", "voice": "am_echo", "error": "unsingable: x"},
  ],
  sidecars: [
    "n/kokoro-fp32-aac64-v1/af_heart/9ef7181c7110f97767b46c6fb4af58f5bb864f1c99fdae7e37aa31cebb664ef5.json",
    "n/kokoro-fp32-aac64-v1/am_echo/38754d16f39e5dc269c8cec0070ef4d2ad68d284393e214cfb3fee9d074db6ef.json",
  ],
  log: [
    "phonemizing 4 narration line(s) from 1 Foray(s)",
    "[1/8] f1 / n1 / af_heart: 3.000 s (pcm 3.0, container 3.021), 0 kB, -19.0 LUFS / -1.5 dBTP (linear, +6.0 dB, limit 0.0 dB)",
    "[2/8] f1 / n2 / af_heart: unchanged (n/kokoro-fp32-aac64-v1/af_heart/5dd596370434f63d84904396939f3ef8b2dc0c0c72720414cfc449634f5a395a.m4a)",
    "[3/8] f1 / n3 / af_heart: FAILED spoken length 1.0 s is 0.15x the 6.647 s estimate, outside [0.5, 2.0]",
    "[4/8] f1 / n4 / af_heart: FAILED unsingable: x",
    "[5/8] f1 / n1 / am_echo: 3.000 s (pcm 3.0, container 3.021), 0 kB, -19.0 LUFS / -1.5 dBTP (linear, +6.0 dB, limit 0.0 dB)",
    "[6/8] f1 / n2 / am_echo: FAILED spoken length 1.0 s is 3.40x the 0.294 s estimate, outside [0.5, 2.0]",
    "[7/8] f1 / n3 / am_echo: FAILED spoken length 1.0 s is 0.15x the 6.647 s estimate, outside [0.5, 2.0]",
    "[8/8] f1 / n4 / am_echo: FAILED unsingable: x",
    "",
  ],
  reusedLog: [
    "phonemizing 4 narration line(s) from 1 Foray(s)",
    "[1/8] f1 / n1 / af_heart: reused n/kokoro-fp32-aac64-v1/af_heart/9ef7181c7110f97767b46c6fb4af58f5bb864f1c99fdae7e37aa31cebb664ef5.m4a",
    "[2/8] f1 / n2 / af_heart: unchanged (n/kokoro-fp32-aac64-v1/af_heart/5dd596370434f63d84904396939f3ef8b2dc0c0c72720414cfc449634f5a395a.m4a)",
    "[3/8] f1 / n3 / af_heart: FAILED spoken length 1.0 s is 0.15x the 6.647 s estimate, outside [0.5, 2.0]",
    "[4/8] f1 / n4 / af_heart: FAILED unsingable: x",
    "[5/8] f1 / n1 / am_echo: reused n/kokoro-fp32-aac64-v1/am_echo/38754d16f39e5dc269c8cec0070ef4d2ad68d284393e214cfb3fee9d074db6ef.m4a",
    "[6/8] f1 / n2 / am_echo: FAILED spoken length 1.0 s is 3.40x the 0.294 s estimate, outside [0.5, 2.0]",
    "[7/8] f1 / n3 / am_echo: FAILED spoken length 1.0 s is 0.15x the 6.647 s estimate, outside [0.5, 2.0]",
    "[8/8] f1 / n4 / am_echo: FAILED unsingable: x",
    "",
  ],
};

test("render_all through render_line writes the pre-GV-22 manifest, sidecars and log (refactor equivalence)", () => {
  /* The pinned values are origin/main's render_all output, before the per-line
     body moved into render_line. MUTATION: drop a field from the rendered
     entry, stop writing the sidecar, append a failed line to entries (or an
     unchanged one to failed), skip the is_unchanged check, or reorder the
     voice and line loops -> red. */
  const out = pyJson(RENDER_ALL_HARNESS);
  assert.equal(out.code, 1, "a failed line still exits 1");
  assert.equal(out.manifest.kind, "foray-narration-render");
  assert.deepEqual(out.manifest.tools, {
    onnxruntime: "fake-ort", phonemizer: { g2p: "fake", fallback: "none", vocab: "v" },
    ffmpeg: "fake-tool", threads: 4, provider: "CPUExecutionProvider",
  });
  assert.deepEqual(Object.keys(out.manifest.voices), ["af_heart", "am_echo"]);
  assert.deepEqual(out.manifest.totals, PRE_GV22.totals);
  assert.deepEqual(out.manifest.items, PRE_GV22.items);
  assert.deepEqual(out.manifest.failed, PRE_GV22.failed);
  assert.deepEqual(out.sidecars, PRE_GV22.sidecars);
  assert.deepEqual(out.log, PRE_GV22.log);
});

test("a second render_all over the same --out reuses each rendered line from its sidecar, manifest unchanged", () => {
  /* MUTATION: drop the sidecar reuse from render_line, or let the reuse path
     take the prior entry's status or ids instead of this line's -> the log
     says rendered (not reused) or the manifest differs. */
  const out = pyJson(RENDER_ALL_HARNESS);
  assert.equal(out.code2, 1);
  assert.equal(out.same, true, "the second manifest differs from the first");
  assert.deepEqual(out.log2, PRE_GV22.reusedLog);
});

test("render_line raises the line's own phonemize error and writes nothing", () => {
  /* The worker and the batch render share render_line, so a refused line must
     raise (not return a half entry) in both. MUTATION: return a failed entry
     instead of raising, or compute the key first (an empty-chunks line would
     raise a different message). */
  const out = pyJson(
    `import tempfile,pathlib\n` +
      `d=pathlib.Path(tempfile.mkdtemp())\n` +
      `line={"foray_id":"f","item":{"id":"i","script":"S."},"chunks":[],"ids":[],"error":"unsingable: q"}\n` +
      `try:\n  R.render_line(None,None,line,P,{"model":{"sha256":"0"*64},"voices":{"af_heart":{"sha256":"1"*64}}},d,d,"ff","fp",voice="af_heart"); res="returned"\n` +
      `except R.RenderError as e:\n  res=str(e)\n` +
      `print(json.dumps({"res":res,"files":[p.name for p in d.rglob("*")]}))`
  );
  assert.equal(out.res, "unsingable: q");
  assert.deepEqual(out.files, []);
});

/* ---------- the workflow ---------- */

test("the render workflow holds no credential and cannot write anywhere", () => {
  /* HARD RULE (2026-09-28): no credentials in the repo or CI; R2 writes never
     from GitHub Actions. MUTATION: add `secrets.` anywhere, widen permissions,
     or call the uploader/rclone from the workflow. */
  const yml = fs.readFileSync(WORKFLOW, "utf8");
  const code = yml.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.doesNotMatch(code, /secrets\./);
  assert.match(code, /^permissions:\n {2}contents: read\n/m);
  assert.doesNotMatch(code, /write-all|contents: write|id-token/);
  assert.doesNotMatch(code, /upload-narration|rclone|r2\.cloudflarestorage|AWS_|R2_/);
  assert.match(code, /workflow_dispatch:/);
  assert.match(code, /- "render\/\*\*"/);
  assert.match(code, /retention-days: 30/);
  assert.match(code, /render-foray\.py/);
});
