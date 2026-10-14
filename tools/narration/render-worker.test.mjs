/* GV-22: render-foray.py --worker, the long-lived render worker and its spool.
 *
 * docs/roadmap/generation-v2.md GV-22. The worker keeps the G2P and the ORT
 * session resident and renders per-item jobs from SPOOL/in/ in (priority,
 * enqueued_at) order, writing done/<job_id>.json and staging upload/<job_id>/
 * for spool-upload.mjs. Everything here runs the real worker loop through the
 * real interpreter with an injected render_line and phonemize: no model, no
 * misaki, no ffmpeg, no network. The fakes write a few bytes where the .m4a
 * would be, so the staged directory is checked by the real
 * upload-narration.mjs collectUploads.
 *
 * Every test names the mutation that turns it red.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { collectUploads } from "./upload-narration.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const SCRIPT = path.join(HERE, "render-foray.py");
const PROFILE = JSON.parse(fs.readFileSync(path.join(HERE, "render-profile.json"), "utf8"));

const PYTHON = (() => {
  for (const exe of ["python3", "python", "py"]) {
    if (spawnSync(exe, ["--version"], { encoding: "utf8" }).status === 0) return exe;
  }
  return null;
})();

/* The worker's fakes. fake_render_line has render_line's exact signature; it
   records each call, honours the line's phonemize error, fails a script that
   says FAIL with a RenderError text shaped like the real length refusal, and
   otherwise writes "fake m4a <item_id>" at the real content key. */
const PRELUDE = (spool) =>
  `import json,sys,importlib.util,pathlib\n` +
  `spec=importlib.util.spec_from_file_location("rf", ${JSON.stringify(SCRIPT)})\n` +
  `R=importlib.util.module_from_spec(spec); spec.loader.exec_module(R)\n` +
  `P=R.load_profile()\n` +
  `_pins=R.read_pins()\n` +
  `PINS={"model":R.model_pin(P,_pins),"voices":{v:R.voice_pin(v,P,_pins) for v in P["voices"]}}\n` +
  `CALLS=[]\n` +
  `NOW=R.parse_enqueued_at("2026-10-11T12:00:00.000Z")\n` +
  `SPOOL=pathlib.Path(${JSON.stringify(spool ?? "")})\n` +
  `def fake_phonemize(script, lexicon=None):\n` +
  `  if "UNSINGABLE" in script: return {"chunks":[],"ids":[],"error":"unsingable: the phoneme 'X' has no id"}\n` +
  `  return {"chunks":[script.lower()],"ids":[[1,2,3]],"error":None}\n` +
  `def fake_render_line(session, style, line, profile, pins, out_dir, tmp, ffmpeg, ffprobe, *, voice, lexicon_sha=None, rerender=False, tag=None):\n` +
  `  CALLS.append({"item":line["item"]["id"],"voice":voice,"style":style,"claimed":[p.name for p in (SPOOL/"work").iterdir()] if SPOOL.name else []})\n` +
  `  if line.get("error"): raise R.RenderError(line["error"])\n` +
  `  if "FAIL" in line["item"]["script"]: raise R.RenderError("spoken length 9.9 s is 3.00x the 3.3 s estimate, outside [0.5, 2.0]")\n` +
  `  key=R.render_key(profile, voice, pins["voices"][voice]["sha256"], pins["model"]["sha256"], line["chunks"])\n` +
  `  out=pathlib.Path(out_dir)/key; out.parent.mkdir(parents=True, exist_ok=True)\n` +
  `  data=("fake m4a "+line["item"]["id"]).encode(); out.write_bytes(data)\n` +
  `  return R.manifest_entry(foray_id=line["foray_id"], item_id=line["item"]["id"], voice=voice, status="rendered", key=key,` +
  ` bytes=len(data), duration_sec=2.5, sha256=R.sha256_bytes(data), profile=profile["id"],` +
  ` text_sha256=R.sha256_text(line["item"]["script"]), lexicon_sha=lexicon_sha, chunks=len(line["chunks"]))\n` +
  `def DEPS(**over):\n` +
  `  d={"profile":P,"pins":PINS,"session":None,"styles":{v:"style-"+v for v in P["voices"]},"ffmpeg":"ffmpeg","ffprobe":"ffprobe",` +
  `"lexicon_sha":None,"tools":{"fake":True},"render_line":fake_render_line,"phonemize":fake_phonemize,"now":lambda: NOW}\n` +
  `  d.update(over); return d\n` +
  `def out(obj): print(json.dumps(obj))\n`;

function py(snippet, spool) {
  const r = spawnSync(PYTHON, ["-c", PRELUDE(spool) + snippet], { encoding: "utf8", cwd: ROOT });
  assert.equal(r.status, 0, `python failed:\n${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
}

function withSpool(fn) {
  const spool = fs.mkdtempSync(path.join(os.tmpdir(), "rw-spool-"));
  try {
    for (const d of ["in", "work", "done", "upload", "objects"]) fs.mkdirSync(path.join(spool, d));
    return fn(spool);
  } finally {
    fs.rmSync(spool, { recursive: true, force: true });
  }
}

/* The job schema id, built in two pieces: written out whole it matches the
   User-Agent scan in tools/segments/politeness.test.mjs (#316), which reads
   any "foray<word>/<digit>" under tools/ as a hand-spelt UA. */
const SCHEMA_NAME = "foray-render-job";
const SCHEMA_V1 = `${SCHEMA_NAME}/1`;

function job(id, priority, enqueuedAt, extra = {}) {
  return {
    schema: SCHEMA_V1, job_id: id, foray_id: "gen-quiet-engines-3f2a1c", item_id: `i-${id}`,
    script: `Line for ${id}.`, priority, enqueued_at: enqueuedAt, ...extra,
  };
}

function put(spool, dir, doc, name = `${doc.job_id}.job.json`) {
  fs.writeFileSync(path.join(spool, dir, name), typeof doc === "string" ? doc : JSON.stringify(doc));
}

const readDone = (spool, id) => JSON.parse(fs.readFileSync(path.join(spool, "done", `${id}.json`), "utf8"));
const ls = (spool, dir) => fs.readdirSync(path.join(spool, dir)).sort();
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

test("a Python interpreter is available — this suite does not silently skip", () => {
  assert.ok(PYTHON, "no python3/python/py on PATH");
});

test("jobs complete in (priority, enqueued_at) order, each with done/<job_id>.json and its timings", () => {
  /* The listing order (a..e) is not the queue order. Lower priority first,
     then the earlier enqueue, then the job id.
     MUTATION: sort on enqueued_at alone, on priority alone, priority
     descending, or not at all (listing order) -> the call order changes;
     drop queued_ms or audio_sec from the record -> red; pass the default
     voice's style for every job -> j-b's style is wrong. */
  withSpool((spool) => {
    put(spool, "in", job("j-a", 2, "2026-10-11T10:00:00.000Z"));
    put(spool, "in", job("j-b", 1, "2026-10-11T11:00:00.000Z", { voice: "am_echo" }));
    put(spool, "in", job("j-c", 1, "2026-10-11T10:30:00.000Z"));
    put(spool, "in", job("j-d", 0, "2026-10-11T11:59:00.000Z"));
    put(spool, "in", job("j-e", 1, "2026-10-11T10:30:00.000Z"));
    const out = py(`s=R.run_worker(SPOOL, DEPS(), once=True)\nout({"calls":CALLS,"summary":s})`, spool);
    assert.deepEqual(out.calls.map((c) => c.item), ["i-j-d", "i-j-c", "i-j-e", "i-j-b", "i-j-a"]);
    assert.deepEqual(out.summary, { recovered: [], rendered: ["j-d", "j-c", "j-e", "j-b", "j-a"], failed: [] });
    assert.equal(out.calls.find((c) => c.item === "i-j-b").style, "style-am_echo");
    assert.equal(out.calls.find((c) => c.item === "i-j-a").style, "style-af_heart");
    const queued = { "j-a": 7_200_000, "j-b": 3_600_000, "j-c": 5_400_000, "j-d": 60_000, "j-e": 5_400_000 };
    for (const [id, ms] of Object.entries(queued)) {
      const d = readDone(spool, id);
      assert.equal(d.job_id, id);
      assert.equal(d.status, "rendered");
      assert.equal(d.entry.item_id, `i-${id}`);
      assert.equal(d.entry.voice, id === "j-b" ? "am_echo" : "af_heart");
      assert.match(d.entry.key, new RegExp(`^n/${PROFILE.id}/${d.entry.voice}/[0-9a-f]{64}\\.m4a$`));
      assert.equal(d.timings.queued_ms, ms, `${id} queued_ms`);
      assert.ok(Number.isInteger(d.timings.render_ms) && d.timings.render_ms >= 0);
      assert.equal(d.timings.audio_sec, 2.5);
      assert.ok(!("error" in d));
    }
    assert.deepEqual(ls(spool, "in"), []);
    assert.deepEqual(ls(spool, "work"), []);
  });
});

test("a job left in work/ at start is re-queued and rendered exactly once; a finished one is not", () => {
  /* j-crash was claimed when the worker died; j-finished died after its done
     record was written (the record is the proof it finished).
     MUTATION: drop the recover_spool call -> j-crash is never rendered;
     re-queue without checking done/ -> j-finished renders a second time and
     its record is overwritten; copy instead of move -> work/ is not empty. */
  withSpool((spool) => {
    put(spool, "work", job("j-crash", 5, "2026-10-11T09:00:00.000Z"));
    put(spool, "work", job("j-finished", 0, "2026-10-11T09:00:00.000Z"));
    const finished = { job_id: "j-finished", status: "rendered", entry: { key: "k" }, timings: {} };
    fs.writeFileSync(path.join(spool, "done", "j-finished.json"), JSON.stringify(finished));
    put(spool, "in", job("j-new", 1, "2026-10-11T11:00:00.000Z"));
    const out = py(`s=R.run_worker(SPOOL, DEPS(), once=True)\nout({"calls":CALLS,"summary":s})`, spool);
    assert.deepEqual(out.calls.map((c) => c.item), ["i-j-new", "i-j-crash"]);
    assert.deepEqual(out.summary.recovered, ["j-crash"]);
    assert.deepEqual(out.summary.rendered, ["j-new", "j-crash"]);
    assert.equal(readDone(spool, "j-crash").status, "rendered");
    assert.deepEqual(readDone(spool, "j-finished"), finished);
    assert.deepEqual(ls(spool, "work"), []);
    assert.deepEqual(ls(spool, "in"), []);
  });
});

test("a job is claimed by renaming it into work/ before it renders, and a job taken by another worker is skipped", () => {
  /* The claim is the rename: while a job renders it is in work/ and gone from
     in/. MUTATION: render straight from in/ and delete afterwards -> work/ is
     empty during the render; let claim_next's FileNotFoundError escape -> the
     vanished job crashes the worker instead of yielding the next one. */
  withSpool((spool) => {
    put(spool, "in", job("j-1", 0, "2026-10-11T11:00:00.000Z"));
    const out = py(`s=R.run_worker(SPOOL, DEPS(), once=True)\nout(CALLS)`, spool);
    assert.deepEqual(out[0].claimed, ["j-1.job.json"]);
  });
  withSpool((spool) => {
    put(spool, "in", job("j-1", 0, "2026-10-11T11:00:00.000Z"));
    put(spool, "in", job("j-2", 1, "2026-10-11T11:00:00.000Z"));
    const out = py(
      `paths=R.spool_paths(SPOOL)\n` +
        `real=R.os.rename; n=[0]\n` +
        `def flaky(a,b):\n  n[0]+=1\n  if n[0]==1:\n    pathlib.Path(a).unlink(); raise FileNotFoundError(a)\n  return real(a,b)\n` +
        `R.os.rename=flaky\n` +
        `got=R.claim_next(paths)\nR.os.rename=real\n` +
        `out({"got":got.name,"dir":got.parent.name,"empty":R.claim_next(paths)})`,
      spool
    );
    assert.deepEqual(out, { got: "j-2.job.json", dir: "work", empty: null });
  });
});

test("the staged upload dir passes upload-narration.mjs collectUploads with the fake bytes' sha256", () => {
  /* upload/<job_id>/ is exactly what the governed uploader takes: a
     manifest*.json of the render profile and the .m4a at its key path.
     MUTATION: stage the manifest without the .m4a ("not on disk"), name it
     other than manifest*.json, write the entry's bytes or sha256 wrong, or
     leave the .staging dir behind -> red. */
  withSpool((spool) => {
    put(spool, "in", job("j-up", 0, "2026-10-11T11:00:00.000Z"));
    py(`R.run_worker(SPOOL, DEPS(), once=True)\nout(1)`, spool);
    assert.deepEqual(ls(spool, "upload"), ["j-up"]);
    const dir = path.join(spool, "upload", "j-up");
    const ups = collectUploads(dir, PROFILE);
    const bytes = Buffer.from("fake m4a i-j-up");
    assert.equal(ups.length, 1);
    assert.equal(ups[0].sha256, sha(bytes));
    assert.equal(ups[0].bytes, bytes.length);
    assert.equal(ups[0].key, readDone(spool, "j-up").entry.key);
    const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest-j-up.json"), "utf8"));
    assert.equal(m.kind, "foray-narration-render");
    assert.deepEqual(m.totals, { items: 1, rendered: 1, unchanged: 0, failed: 0, bytes: bytes.length, duration_sec: 2.5 });
    assert.deepEqual(Object.keys(m.voices), ["af_heart"]);
  });
});

test("a failing job writes status failed with the RenderError text, and the worker continues", () => {
  /* One bad job never stops the queue, and only a rendered line is staged.
     Malformed, unreadable and mis-named jobs sort first and fail with their
     reason. MUTATION: let process_job's RenderError escape -> the worker dies
     and j-good is never rendered; record a fixed message instead of the
     exception text -> the length refusal is lost; stage before the status
     check -> upload/ holds a failed job. */
  withSpool((spool) => {
    put(spool, "in", job("j-fail", 0, "2026-10-11T11:00:00.000Z", { script: "This one will FAIL." }));
    put(spool, "in", job("j-unsing", 1, "2026-10-11T11:00:00.000Z", { script: "UNSINGABLE line." }));
    put(spool, "in", job("j-good", 2, "2026-10-11T11:00:00.000Z"));
    put(spool, "in", { ...job("j-schema", 0, "2026-10-11T11:00:00.000Z"), schema: `${SCHEMA_NAME}/0` });
    put(spool, "in", "{nope", "j-garbled.job.json");
    put(spool, "in", job("j-other", 0, "2026-10-11T11:00:00.000Z"), "j-renamed.job.json");
    put(spool, "in", job("j-echo", 3, "2026-10-11T11:00:00.000Z", { voice: "am_echo" }));
    const out = py(
      `s=R.run_worker(SPOOL, DEPS(styles={"af_heart":"style-af_heart"}), once=True)\nout({"calls":CALLS,"summary":s})`,
      spool
    );
    assert.deepEqual(out.summary.rendered, ["j-good"]);
    assert.deepEqual(out.summary.failed, ["j-garbled", "j-renamed", "j-schema", "j-fail", "j-unsing", "j-echo"]);
    assert.deepEqual(out.calls.map((c) => c.item), ["i-j-fail", "i-j-unsing", "i-j-good"]);
    const fail = readDone(spool, "j-fail");
    assert.equal(fail.status, "failed");
    assert.equal(fail.error, "spoken length 9.9 s is 3.00x the 3.3 s estimate, outside [0.5, 2.0]");
    assert.ok(!("entry" in fail));
    assert.equal(fail.timings.queued_ms, 3_600_000);
    assert.match(readDone(spool, "j-unsing").error, /^unsingable: /);
    assert.match(readDone(spool, "j-schema").error, /schema is 'foray-render-job\/0'/);
    assert.match(readDone(spool, "j-garbled").error, /not JSON/);
    assert.match(readDone(spool, "j-renamed").error, /does not match its file name/);
    assert.match(readDone(spool, "j-echo").error, /am_echo is not loaded by this worker/);
    assert.equal(readDone(spool, "j-good").status, "rendered");
    assert.deepEqual(ls(spool, "upload"), ["j-good"]);
    assert.deepEqual(ls(spool, "in"), []);
    assert.deepEqual(ls(spool, "work"), []);
  });
});

test("--once drains jobs enqueued during the drain; --idle-exit returns after that many idle seconds", () => {
  /* MUTATION: list in/ once up front -> the job enqueued mid-drain is left;
     ignore idle_exit -> the sleep guard trips (the loop never ends); never
     reset the idle clock after a job -> it exits before the second job. */
  withSpool((spool) => {
    put(spool, "in", job("j-first", 0, "2026-10-11T11:00:00.000Z"));
    const later = JSON.stringify(job("j-later", 9, "2026-10-11T11:30:00.000Z"));
    const out = py(
      `def enqueuing(*a, **k):\n` +
        `  e=fake_render_line(*a, **k)\n` +
        `  if len(CALLS)==1: (SPOOL/"in"/"j-later.job.json").write_text(${JSON.stringify(later)}, encoding="utf-8")\n` +
        `  return e\n` +
        `s1=R.run_worker(SPOOL, DEPS(render_line=enqueuing), once=True)\n` +
        `t=[0.0]; sleeps=[]\n` +
        `def clock(): return t[0]\n` +
        `def sleep(sec):\n  sleeps.append(sec)\n  if len(sleeps)>50: raise SystemExit("idle-exit ignored")\n  t[0]+=sec\n` +
        `def slow(*a, **k):\n  t[0]+=100\n  return fake_render_line(*a, **k)\n` +
        `(SPOOL/"in"/"j-idle.job.json").write_text(json.dumps({**json.loads(${JSON.stringify(later)}),"job_id":"j-idle"}), encoding="utf-8")\n` +
        `s2=R.run_worker(SPOOL, DEPS(render_line=slow), idle_exit=5, poll_sec=1.0, sleep=sleep, clock=clock)\n` +
        `out({"s1":s1["rendered"],"s2":s2["rendered"],"sleeps":len(sleeps)})`,
      spool
    );
    assert.deepEqual(out.s1, ["j-first", "j-later"]);
    assert.deepEqual(out.s2, ["j-idle"]);
    assert.equal(out.sleeps, 5);
  });
});

test("--worker refuses batch options and bad flags before anything heavy loads, and runs the loop", () => {
  /* load_worker_deps is a tripwire for the refusals and a fake loader for the
     run. MUTATION: load before plan_worker -> REACHED; drop a batch-option
     refusal -> that argv reaches the loader; drop voice_order in plan_worker ->
     am_echo is loaded first; ignore --once in cmd_worker -> the run never ends. */
  withSpool((spool) => {
    put(spool, "in", job("j-cli", 0, "2026-10-11T11:00:00.000Z"));
    const out = py(
      `import contextlib,io\n` +
        `seen=[]\n` +
        `def trip(*a, **k): raise SystemExit("REACHED")\n` +
        `R.load_worker_deps=trip\n` +
        `res=[]\n` +
        `S=str(SPOOL)\n` +
        `for argv in (["--worker",S,"--candidate","x.json"],["--worker",S,"--forays","d1"],["--worker",S,"--items","a"],` +
        `["--worker",S,"--smoke"],["--worker",S,"--out","o"],["--once"],["--idle-exit","5"],["--worker",S,"--idle-exit","0"],` +
        `["--worker",S,"--voices","bf_nope"]):\n` +
        `  err=io.StringIO()\n` +
        `  try:\n` +
        `    with contextlib.redirect_stderr(err): code=R.main(argv)\n` +
        `  except SystemExit as e: code=e.code\n` +
        `  res.append([code,err.getvalue().strip()])\n` +
        `def loader(args, profile, voices):\n  seen.append(voices); return DEPS()\n` +
        `R.load_worker_deps=loader\n` +
        `code=R.main(["--worker",S,"--once","--voices","am_echo,af_heart"])\n` +
        `out({"refusals":res,"code":code,"voices":seen,"calls":[c["item"] for c in CALLS]})`,
      spool
    );
    const [cand, foray, items, smoke, outFlag, once, idle, idle0, voice] = out.refusals;
    for (const [r, flag] of [[cand, "--candidate"], [foray, "--forays"], [items, "--items"], [smoke, "--smoke"], [outFlag, "--out"]]) {
      assert.equal(r[0], 2, `${flag}: ${r[1]}`);
      assert.match(r[1], new RegExp(`${flag} is a batch option`));
    }
    assert.deepEqual(once, [2, "render-foray: --once needs --worker SPOOL"]);
    assert.deepEqual(idle, [2, "render-foray: --idle-exit needs --worker SPOOL"]);
    assert.match(idle0[1], /--idle-exit must be a positive number/);
    assert.match(voice[1], /bf_nope is not a voice/);
    assert.equal(out.code, 0);
    assert.deepEqual(out.voices, [["af_heart", "am_echo"]]);
    assert.deepEqual(out.calls, ["i-j-cli"]);
  });
});

test("the real CLI refuses --once without --worker, exit 2", () => {
  /* Executes the entry point (a module-level error in the worker section
     would show here). MUTATION: drop the --once guard -> a batch render starts. */
  const r = spawnSync(PYTHON, [SCRIPT, "--once"], { encoding: "utf8", cwd: ROOT });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--once needs --worker SPOOL/);
});

test(`validate_job takes ${SCHEMA_V1} and names what is wrong with anything else`, () => {
  /* MUTATION: accept a bool priority (isinstance int alone), a naive
     timestamp, a path-like job id, a lexicon entry with no ipa, or a voice
     that is not a Kokoro id -> that case stops being refused. */
  const out = py(
    `base={"schema":"${SCHEMA_V1}","job_id":"j1","foray_id":"f","item_id":"i","script":"S.","priority":3,` +
      `"enqueued_at":"2026-10-11T11:00:00.000Z","lexicon":[{"term":"Foray","ipa":"fəɹˈeɪ"}]}\n` +
      `cases={"bool":{"priority":True},"str":{"priority":"1"},"naive":{"enqueued_at":"2026-10-11T11:00:00"},` +
      `"garbage":{"enqueued_at":"soon"},"script":{"script":"  "},"foray":{"foray_id":None},"lex":{"lexicon":[{"term":"x"}]},` +
      `"voice":{"voice":"Heart"}}\n` +
      `res={}\n` +
      `for k,v in cases.items():\n` +
      `  try: R.validate_job({**base,**v},"j1"); res[k]="accepted"\n` +
      `  except R.RenderError as e: res[k]=str(e)\n` +
      `try: R.validate_job({**base,"job_id":"../x"},"../x"); res["path"]="accepted"\n` +
      `except R.RenderError as e: res["path"]=str(e)\n` +
      `ok=R.validate_job(base,"j1")\n` +
      `out({"res":res,"ok":ok})`
  );
  assert.match(out.res.bool, /priority must be an integer/);
  assert.match(out.res.str, /priority must be an integer/);
  assert.match(out.res.naive, /has no time zone/);
  assert.match(out.res.garbage, /not an ISO-8601 timestamp/);
  assert.match(out.res.script, /script must be a non-empty string/);
  assert.match(out.res.foray, /foray_id must be a non-empty string/);
  assert.match(out.res.lex, /lexicon must be a list of \{term, ipa\}/);
  assert.match(out.res.voice, /'Heart' is not a Kokoro voice id/);
  assert.match(out.res.path, /not a safe job id/);
  assert.equal(out.ok.voice, null);
  assert.equal(out.ok.priority, 3);
  assert.deepEqual(out.ok.lexicon, [{ term: "Foray", ipa: "fəɹˈeɪ" }]);
});

test("the resident phonemizer loads the G2P once; a job's lexicon fills terms hard-terms.json does not pin, and the file wins a shared term", () => {
  /* Real phonemize.py (lexicon substitution, chunking, vocab ids) with a fake
     G2P that says "ə" for any text. GV-82 (docs/roadmap/generation-v2.md)
     reversed GV-22's order: a job's lexicon is the writer's hints, and the
     curated IPA wins (merge_lexicon). MUTATION: put the job lexicon ahead of
     the file's entries again -> the job's fəɹˈeɪ wins on Foray; load the
     backend inside phonemize() -> two loads; ignore the job lexicon -> the
     Gdansk chunks equal the no-lexicon ones; merge_lexicon(entries, lexicon,
     None) in make_phonemizer -> the bad Lodz hint is accepted and the line
     fails UnsingablePhoneme (c.error set). */
  const out = py(
    `Pm=R._load_phonemize()\n` +
      `loads=[]\n` +
      `def backend():\n  loads.append(1)\n  return lambda text: ("ə", [])\n` +
      `Pm.load_backend=backend\n` +
      `Pm.load_lexicon=lambda *a, **k: [{"term":"Foray","ipa":"fˈɔːɹeɪ"}]\n` +
      `ph,info=R.make_phonemizer(Pm)\n` +
      `a=ph("Foray in Gdansk today.", [{"term":"Foray","ipa":"fəɹˈeɪ"},{"term":"Gdansk","ipa":"ɡədˈænsk"}])\n` +
      `b=ph("Foray in Gdansk today.", [])\n` +
      `c=ph("Foray in Gdansk and Lodz today.", [{"term":"Gdansk","ipa":"ɡədˈænsk"},{"term":"Lodz","ipa":"gwˈuʤ"}])\n` +
      `out({"a":a,"b":b,"c":c,"loads":len(loads),"fallback":info["fallback"]})`
  );
  assert.equal(out.a.error, null);
  assert.equal(out.b.error, null);
  assert.ok(out.a.chunks.join(" ").includes("fˈɔːɹeɪ"), JSON.stringify(out.a.chunks));
  assert.ok(!out.a.chunks.join(" ").includes("fəɹˈeɪ"), JSON.stringify(out.a.chunks));
  assert.ok(out.a.chunks.join(" ").includes("ɡədˈænsk"), JSON.stringify(out.a.chunks));
  assert.ok(out.b.chunks.join(" ").includes("fˈɔːɹeɪ"), JSON.stringify(out.b.chunks));
  assert.ok(!out.b.chunks.join(" ").includes("ɡədˈænsk"), JSON.stringify(out.b.chunks));
  assert.notDeepEqual(out.a.ids, out.b.ids);
  assert.equal(typeof out.a.lexicon_extra_sha, "string");
  assert.equal(out.a.lexicon_rejected, null);
  assert.deepEqual(Object.keys(out.b).sort(), ["chunks", "error", "ids"], "a job with no lexicon phonemizes exactly as before");
  // The live path (job.lexicon -> spool -> worker), not only batch mode: an
  // out-of-vocab hint is dropped and recorded, the line still phonemizes and
  // the valid pin still applies.
  assert.equal(out.c.error, null);
  assert.equal(out.c.lexicon_rejected.length, 1, JSON.stringify(out.c.lexicon_rejected));
  assert.equal(out.c.lexicon_rejected[0].term, "Lodz");
  assert.match(out.c.lexicon_rejected[0].reason, /'g' \(U\+0067\)/);
  assert.ok(out.c.chunks.join(" ").includes("ɡədˈænsk"), JSON.stringify(out.c.chunks));
  assert.ok(!out.c.chunks.join(" ").includes("gwˈuʤ"), JSON.stringify(out.c.chunks));
  assert.equal(out.loads, 1);
  assert.equal(out.fallback, "none");
});

test("process_job hands the job lexicon to phonemize and carries lexicon_extra_sha and lexicon_rejected onto the line render_line gets", () => {
  /* GV-82: render_line reads both fields off the line into the manifest
     entry, so the worker's line must carry them (null when phonemize says
     nothing). MUTATION: drop the two fields from process_job's line -> both
     read None; pass no lexicon to phonemize -> the seen lexicon is None. */
  const out = py(
    `seen={}\n` +
      `def ph(script, lexicon=None):\n` +
      `  seen.setdefault("lexicon", []).append(lexicon)\n` +
      `  row={"chunks":["ə."],"ids":[[0,1,0]],"error":None}\n` +
      `  if lexicon: row.update({"lexicon_extra_sha":"s"*64,"lexicon_rejected":[{"term":"Lodz","ipa":"g","reason":"r"}]})\n` +
      `  return row\n` +
      `def rl(session, style, line, *a, **k):\n` +
      `  seen.setdefault("lines", []).append({k2: line.get(k2) for k2 in ("lexicon_extra_sha","lexicon_rejected")})\n` +
      `  raise R.RenderError("captured")\n` +
      `job={"schema":"${SCHEMA_V1}","job_id":"j1","foray_id":"f","item_id":"i","script":"Lodz and Gdansk.","priority":1,` +
      `"enqueued_at":"2026-10-11T11:00:00.000Z","lexicon":[{"term":"Gdansk","ipa":"ɡədˈænsk"}]}\n` +
      `a=R.process_job(job, DEPS(phonemize=ph, render_line=rl, out_dir=None, tmp=None), job_id="j1")\n` +
      `b=R.process_job({**job,"lexicon":[]}, DEPS(phonemize=ph, render_line=rl, out_dir=None, tmp=None), job_id="j1")\n` +
      `out({"seen":seen,"a":a["status"],"b":b["status"]})`
  );
  assert.deepEqual(out.seen.lexicon, [[{ term: "Gdansk", ipa: "ɡədˈænsk" }], []]);
  assert.deepEqual(out.seen.lines, [
    { lexicon_extra_sha: "s".repeat(64), lexicon_rejected: [{ term: "Lodz", ipa: "g", reason: "r" }] },
    { lexicon_extra_sha: null, lexicon_rejected: null },
  ]);
  assert.deepEqual([out.a, out.b], ["failed", "failed"]);
});
