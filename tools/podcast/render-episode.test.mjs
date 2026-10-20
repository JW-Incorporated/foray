/* tools/podcast/render-episode.py, offline: no audio, no network, no ffmpeg, no numpy.
 *
 * CI runs no Python test runner (the only python in .github/workflows is the
 * narration render job), so these are node tests that drive the script the way
 * tools/narration/render-foray.test.mjs drives render-foray.py: `bake --dry-run`
 * prints the whole ffmpeg plan as JSON, and `python -c` imports the module for
 * the pure helpers. If no interpreter is on PATH the suite SKIPS with a message
 * (ubuntu-latest and the dev boxes both have one).
 *
 * Every test names the mutation it kills and RUNS it: the script is copied to a
 * temp dir with one string replaced, and the same check must fail on the copy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "render-episode.py");
const SRC = fs.readFileSync(SCRIPT, "utf8");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "render-ep-"));
const PYTHON = (() => {
  for (const exe of ["python3", "python", "py"]) {
    if (spawnSync(exe, ["--version"], { encoding: "utf8" }).status === 0) return exe;
  }
  return null;
})();
const SKIP = PYTHON ? false : "no python3/python/py on PATH: the render-episode.py dry-run tests are skipped (CI runs no python tests; install Python to run them)";
let n = 0;

function mutantScript(from, to) {
  assert.ok(SRC.includes(from), `mutation anchor not found: ${from}`);
  const file = path.join(TMP, `m${n++}.py`);
  fs.writeFileSync(file, SRC.replace(from, to));
  return file;
}

const py = (script, args) => spawnSync(PYTHON, ["-X", "utf8", script, ...args], { encoding: "utf8" });

/* Runs `snippet` (which sets `out`) with the module loaded as R; returns parsed JSON. */
function pyJson(script, snippet) {
  const loader = `import json,sys,importlib.util\nspec=importlib.util.spec_from_file_location("re_", ${JSON.stringify(script)})\n` +
    `R=importlib.util.module_from_spec(spec); sys.modules["re_"]=R; spec.loader.exec_module(R)\n`;
  const r = spawnSync(PYTHON, ["-X", "utf8", "-c", loader + snippet + "\nprint(json.dumps(out))"], { encoding: "utf8" });
  assert.equal(r.status, 0, `python failed:\n${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
}

/* check(script) holds on the real script and must throw on the mutant. */
function kills(from, to, check) {
  check(SCRIPT);
  const m = mutantScript(from, to);
  assert.throws(() => check(m), undefined, `SURVIVED: ${from} -> ${to}`);
}

const URL_A = "https://a.example/a.mp3";
const URL_B = "https://b.example/b.mp3";
const tinyPlan = (over = {}) => ({
  version: 1, foray_id: "f", channels: "stereo", title: "T", artist: "A", album: "Al", comment: "", basename: "t",
  items: [
    { i: 0, type: "narr", id: "n1", text: "Hi.", chapter: "One", seam_before: null },
    { i: 1, type: "clip", label: "AA-1", source_id: "src-a", url: URL_A, feed_duration_sec: 100, in: 1, out: 5, seam_before: "narr-tape" },
    { i: 2, type: "clip", label: "BB-1", source_id: "src-b", url: URL_B, feed_duration_sec: 200, in: 10.5, out: 20.25, seam_before: "tape-tape" },
  ],
  ...over,
});
function writePlan(over) {
  const dir = fs.mkdtempSync(path.join(TMP, "plan-"));
  const file = path.join(dir, "plan.json");
  fs.writeFileSync(file, JSON.stringify(tinyPlan(over)));
  return { dir, file };
}
function dry(script, extra = []) {
  const { dir, file } = writePlan();
  const r = py(script, ["bake", file, "--dry-run", "--cache", path.join(dir, "cache"), "--narr-dir", path.join(dir, "narr"), "--ffmpeg", "/nowhere/ffmpeg", ...extra]);
  assert.equal(r.status, 0, `dry-run failed:\n${r.stderr}`);
  return { out: JSON.parse(r.stdout), dir };
}

test("bake --dry-run: the tape clip decodes through the compressor at the committed cut points; mutation: compressor ratio 3 -> 2", { skip: SKIP }, () => {
  kills("ratio=3:attack=10", "ratio=2:attack=10", (script) => {
    const { out, dir } = dry(script);
    const clip = out.steps[1].decode;
    assert.match(path.basename(clip[0]), /^ffmpeg/);
    assert.deepEqual(clip.slice(1), ["-v", "error", "-i", path.join(dir, "cache", crypto.createHash("sha256").update(URL_A).digest("hex") + ".bin"),
      "-ss", "1.000", "-to", "5.000", "-af", "acompressor=threshold=0.1:ratio=3:attack=10:release=150:knee=4", "-ac", "1", "-ar", "44100", "-f", "f32le", "-"]);
    assert.equal(out.steps[2].decode.includes("10.500"), true);
    assert.equal(out.steps[0].decode.includes("-af"), false, "narration is not compressed");
    assert.equal(out.steps[0].trim_pad, true);
  });
});

test("bake --dry-run: a stereo build targets -16 LUFS and a mono build -19 (#1453); mutation: the mono target set to -16", { skip: SKIP }, () => {
  kills("TARGET_LUFS_MONO = -19.0", "TARGET_LUFS_MONO = -16.0", (script) => {
    const st = dry(script).out;
    assert.equal(st.channels, "stereo");
    assert.deepEqual([...new Set(st.steps.map((s) => s.target_lufs))], [-16]);
    assert.deepEqual([...new Set(st.steps.map((s) => s.channels))], [2]);
    const mono = dry(script, ["--channels", "mono"]).out;
    assert.deepEqual([...new Set(mono.steps.map((s) => s.target_lufs))], [-19]);
    assert.deepEqual([...new Set(mono.steps.map((s) => s.channels))], [1]);
  });
});

test("bake --dry-run: seam gaps by seam type, none before the first item (#1452); mutation: tape-tape gap 0.6 -> 0.45", { skip: SKIP }, () => {
  kills('"tape-tape": 0.6,', '"tape-tape": 0.45,', (script) => {
    const { out } = dry(script);
    assert.deepEqual(out.steps.map((s) => s.seam), [null, "narr-tape", "tape-tape"]);
    assert.deepEqual(out.steps.map((s) => s.gap_before_sec), [null, 0.45, 0.6]);
    assert.deepEqual(out.master.gaps, [null, 0.45, 0.6]);
  });
});

test("bake --dry-run: every item runs the 4x-oversampled limiter at -2 dBFS and the tuned fades (#1451, #1452); mutation: oversampling 176400 -> 88200", { skip: SKIP }, () => {
  kills("LIMIT_OVERSAMPLE_SR = 176400", "LIMIT_OVERSAMPLE_SR = 88200", (script) => {
    const { out } = dry(script);
    assert.equal(out.limiter, "aresample=176400,alimiter=limit=0.7943:attack=3:release=60:level=0,aresample=44100");
    for (const s of out.steps) assert.equal(s.limit[s.limit.indexOf("-af") + 1], out.limiter);
    assert.deepEqual(out.steps.map((s) => [s.fade_in_sec, s.fade_out_sec]), [[0.015, 0.015], [0.025, 0.08], [0.025, 0.08]]);
  });
});

test("bake --dry-run: both encodes carry the chapters and 128k, gain only via volume (#1451); mutation: -map_chapters dropped", { skip: SKIP }, () => {
  kills('"-map_metadata", "1", "-map_chapters", "1", *pre]', '"-map_metadata", "1", *pre]', (script) => {
    const { out } = dry(script);
    for (const codec of ["m4a", "mp3"]) {
      const a = out.encode[codec];
      assert.equal(a[a.indexOf("-map_chapters") + 1], "1");
      assert.equal(a[a.indexOf("-b:a") + 1], "128k");
      assert.equal(a.includes("-af"), false, "no filter at gain 0");
    }
    assert.equal(out.encode.m4a.includes("+faststart"), true);
    assert.equal(out.encode.mp3.includes("libmp3lame"), true);
  });
});

test("fetch --dry-run caches each enclosure under the sha256 of its URL, once per source; mutation: sha1", { skip: SKIP }, () => {
  kills("hashlib.sha256(url.encode", "hashlib.sha1(url.encode", (script) => {
    const { dir, file } = writePlan();
    const r = py(script, ["fetch", file, "--dry-run", "--cache", path.join(dir, "cache")]);
    assert.equal(r.status, 0, r.stderr);
    const rows = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((x) => x.source), ["src-a", "src-b"]);
    assert.equal(rows[0].path, path.join(dir, "cache", crypto.createHash("sha256").update(URL_A).digest("hex") + ".bin"));
  });
});

test("fetch refuses a delivered duration more than 1.5 s off the feed and points at the locate step; mutation: tolerance 1.5 -> 100", { skip: SKIP }, () => {
  kills("FETCH_DURATION_TOL_SEC = 1.5", "FETCH_DURATION_TOL_SEC = 100.0", (script) => {
    const { dir, file } = writePlan();
    const cache = path.join(dir, "cache");
    fs.mkdirSync(cache);
    for (const u of [URL_A, URL_B]) fs.writeFileSync(path.join(cache, crypto.createHash("sha256").update(u).digest("hex") + ".bin"), "x");
    const run = (a, b) => pyJson(script, `
import io, contextlib
R.ffprobe_duration = lambda fp, p: ${a} if "${crypto.createHash("sha256").update(URL_A).digest("hex")}" in p else ${b}
err = io.StringIO()
with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
    rc = R.main(["fetch", ${JSON.stringify(file)}, "--cache", ${JSON.stringify(cache)}])
out = {"rc": rc, "err": err.getvalue()}`);
    const ok = run(101.2, 199.0);
    assert.equal(ok.rc, 0, ok.err);
    const bad = run(105, 200);
    assert.equal(bad.rc, 1);
    assert.match(bad.err, /src-a: delivered 105\.0s, feed says 100s/);
    assert.match(bad.err, /#1428/);
  });
});

test("a missing source audio is refused before any ffmpeg runs, naming the fetch step; mutation: the existence check removed", { skip: SKIP }, () => {
  kills("if strict and not os.path.exists(src):\n                missing.append(f\"{it['label']}", "if False and not os.path.exists(src):\n                missing.append(f\"{it['label']}", (script) => {
    const { dir, file } = writePlan();
    const r = py(script, ["bake", file, "--out", path.join(dir, "o"), "--cache", path.join(dir, "cache"), "--narr-dir", path.join(dir, "narr")]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /AA-1: .*run `fetch` first/);
    assert.match(r.stderr, /n1: no rendered narration/);
  });
});

test("loudnorm that fell back to dynamic mode is refused (#1451); mutation: the linear check inverted", { skip: SKIP }, () => {
  kills('if t != "linear":', 'if t == "never":', (script) => {
    const r = pyJson(script, `
def tries(t):
    try:
        R.assert_linear_loudnorm({"normalization_type": t}); return "ok"
    except R.Refuse as e:
        return str(e)
out = {"linear": tries("linear"), "dynamic": tries("dynamic")}`);
    assert.equal(r.linear, "ok");
    assert.match(r.dynamic, /dynamic.*not linear/);
  });
});

test("a master measured +3 LU hot (the dual-mono trap) is refused before encoding (#1453); mutation: tolerance 0.5 -> 5", { skip: SKIP }, () => {
  kills("MASTER_TOL_LU = 0.5", "MASTER_TOL_LU = 5.0", (script) => {
    const r = pyJson(script, `
def tries(i):
    try:
        R.check_master_loudness(i, -16.0); return "ok"
    except R.Refuse as e:
        return str(e)
out = {"good": tries(-16.3), "hot": tries(-13.1)}`);
    assert.equal(r.good, "ok");
    assert.match(r.hot, /-13\.1 LUFS, target -16\.0/);
  });
});

test("the script's CLI: no subcommand exits 2, --check names every dependency; mutation: ffprobe left out of the check", { skip: SKIP }, () => {
  kills('for tool in ("ffmpeg", "ffprobe"):', 'for tool in ("ffmpeg",):', (script) => {
    assert.equal(py(script, []).status, 2);
    const r = py(script, ["--check"]);
    for (const dep of ["python>=3.12", "numpy", "soundfile", "ffmpeg", "ffprobe", "faster-whisper"]) assert.match(r.stdout, new RegExp(dep.replace(">=", ">=")));
  });
});

test("when no interpreter is installed this suite says so rather than passing silently", () => {
  if (!PYTHON) assert.ok(true, SKIP);
  else assert.ok(PYTHON);
});
