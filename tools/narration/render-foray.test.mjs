/* The central narration renderer's pure half, driven through the real interpreter.
 *
 * `docs/plans/spark-central-narration-assessment.md` §3.2 / §5 Phase 1. What
 * can be settled without the 325 MB model, misaki or ffmpeg (none of which CI's
 * test job installs): the content-hash key, the manifest's shape, the profile's
 * pins and settings, the Foray selection and its refusals, and the render
 * workflow's no-credentials contract. The audio itself is exercised by
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

test("loudness is ONE gain to -19 LUFS, capped at -1 dBTP, and a line is whole AAC frames", () => {
  /* A hot-peaked line comes out quieter, never compressed (loudnorm's dynamic
     fallback squashed a smoke-run line); and a line of whole 1024-sample frames
     decodes to exactly its PCM length, which is what duration_sec claims.
     MUTATION: return to_target unconditionally, or drop the frame alignment. */
  const out = pyJson(
    `r=P["render"]\n` +
      `f=r["frame_samples"]; pad=int(round(r["edge_pad_sec"]*r["sample_rate"])); ns=(1,1023,1024,8001,123457)\n` +
      `tails=[R.tail_pad_samples(pad,n,f) for n in ns]\n` +
      `print(json.dumps({"quiet":R.linear_gain_db(r,-25.0,-10.0),"hot":R.linear_gain_db(r,-25.0,-4.0),"f":f,` +
      `"whole":[(pad+n+t)%f for n,t in zip(ns,tails)],"extra":[t-pad for t in tails]}))`
  );
  assert.deepEqual(out.quiet, [6.0, "linear"]);
  assert.deepEqual(out.hot, [3.0, "linear-peak-limited"]);
  assert.equal(out.f, 1024);
  assert.deepEqual(out.whole, [0, 0, 0, 0, 0]);
  assert.ok(out.extra.every((x) => x >= 0 && x < 1024), "the stretch is under one frame of silence");
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

test("@drafts selects exactly the narrated drafts: the three Phase 1 Forays", () => {
  /* §5 Phase 1 renders the three narrated DRAFTS; the published one waits.
     MUTATION: select on `narration_items` alone -> how-ai-actually-gets-built joins. */
  const out = pyJson(
    `doc=json.loads(R.FORAYS_PATH.read_text(encoding="utf-8"))\n` +
      `print(json.dumps([f["id"] for f in R.select_forays(doc,["@drafts"])]))`
  );
  assert.deepEqual(out.sort(), [
    "beyond-the-algorithm-engineering-production-ai-s-e6533b",
    "the-chain-reaction-how-engineering-disasters-rea-25f1b7",
    "what-engineers-actually-do-all-day-e08236",
  ]);
});

test("--smoke picks the two shortest lines of the first Foray, in running order", () => {
  /* MUTATION: take items[:2] -> not the shortest. */
  const out = pyJson(
    `doc=json.loads(R.FORAYS_PATH.read_text(encoding="utf-8"))\n` +
      `f=R.select_forays(doc,["the-chain-reaction-how-engineering-disasters-rea-25f1b7"])\n` +
      `(foray,items),=R.smoke_selection(f)\n` +
      `allx=R.narration_items(foray)\n` +
      `lens=sorted(len(i["script"]) for i in allx)[:2]\n` +
      `order=[allx.index(i) for i in items]\n` +
      `print(json.dumps({"n":len(items),"lens":sorted(len(i["script"]) for i in items),"want":lens,"ordered":order==sorted(order)}))`
  );
  assert.equal(out.n, 2);
  assert.deepEqual(out.lens, out.want);
  assert.equal(out.ordered, true);
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
