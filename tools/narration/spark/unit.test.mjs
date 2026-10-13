/* GV-58: the Spark render worker deployment kit, read statically.
 *
 * docs/roadmap/generation-v2.md GV-58 (#862). The three systemd unit files in
 * this directory are installed on the DGX Spark by hand under D8 (merged PR
 * plus the founder-moved spark-live tag), so nothing exercises them before
 * they run with the R2 token next to them. This suite parses them and pins
 * the invariants the card names: no credential in any unit, the worker runs
 * `--worker` on a spool path, its threads are bounded, and the argv it runs
 * is one the real render-foray.py accepts. No systemd, no model, no network.
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
const ROOT = path.resolve(HERE, "..", "..", "..");
const RENDER_SCRIPT = path.join(ROOT, "tools", "narration", "render-foray.py");

const WORKER_UNIT = "foray-render-worker.service";
const UPLOAD_UNIT = "foray-render-upload.service";
const UPLOAD_TIMER = "foray-render-upload.timer";
const UNIT_FILES = [WORKER_UNIT, UPLOAD_UNIT, UPLOAD_TIMER];

/* The Spark's CPU is shared with SGLang's host processes: the card bounds the
   worker at 4 threads. Raising this is a decision for #862's numbers, not a
   drive-by edit. */
const MAX_THREADS = 4;

const PYTHON = (() => {
  for (const exe of ["python3", "python", "py"]) {
    if (spawnSync(exe, ["--version"], { encoding: "utf8" }).status === 0) return exe;
  }
  return null;
})();

/** A systemd unit file as {section: [[key, value], ...]}: comments and blank
 *  lines dropped, trailing-backslash continuations joined, keys in order. */
function parseUnit(text) {
  const sections = {};
  let current = null;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    while (line.endsWith("\\") && i + 1 < lines.length) line = `${line.slice(0, -1)} ${lines[++i].trim()}`;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      current = header[1];
      sections[current] ??= [];
      continue;
    }
    const eq = line.indexOf("=");
    assert.ok(current && eq > 0, `not a unit-file line: ${line}`);
    sections[current].push([line.slice(0, eq).trim(), line.slice(eq + 1).trim()]);
  }
  return sections;
}

const unit = (name) => parseUnit(fs.readFileSync(path.join(HERE, name), "utf8"));
const values = (u, section, key) => (u[section] ?? []).filter(([k]) => k === key).map(([, v]) => v);
const one = (u, section, key) => {
  const v = values(u, section, key);
  assert.equal(v.length, 1, `[${section}] ${key}= must appear exactly once, found ${v.length}`);
  return v[0];
};

/** ExecStart's argv: the systemd prefixes (- @ + ! :) dropped, split on
 *  whitespace with simple quoting. */
function execArgv(value) {
  const argv = [];
  for (const m of value.replace(/^[-@+!:]+/, "").matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) argv.push(m[1] ?? m[2] ?? m[3]);
  return argv;
}

const flagValue = (argv, flag) => {
  const i = argv.indexOf(flag);
  return i < 0 ? undefined : argv[i + 1];
};

/** Environment= assignments as [name, value] pairs (one line may hold several). */
const envPairs = (u) =>
  values(u, "Service", "Environment").flatMap((v) =>
    execArgv(v).map((a) => {
      const eq = a.indexOf("=");
      return [a.slice(0, eq), a.slice(eq + 1)];
    })
  );

const SECRET_NAME = /KEY|TOKEN|SECRET|PASS(WORD)?|CREDENTIAL|AUTH|BEARER|SESSION|COOKIE/i;
const CREDENTIAL_DIRECTIVES = [
  "EnvironmentFile", "PassEnvironment", "LoadCredential", "LoadCredentialEncrypted",
  "SetCredential", "SetCredentialEncrypted", "ImportCredential",
];

test("no unit file carries or names a credential", () => {
  /* The founder alone places secrets on the Spark (D8); the token lives in the
     upload user's ~/.foray/r2-narration.env, read by upload-narration.mjs at
     run time, never in a unit.
     MUTATION: add `EnvironmentFile=/home/foray-upload/.foray/r2-narration.env`
     to the worker -> red; add `Environment=R2_SECRET_ACCESS_KEY=abc` -> red;
     add `--credentials-file /root/r2.env` to the upload ExecStart -> red;
     paste a 40-character token into any value -> red. */
  for (const name of UNIT_FILES) {
    const u = unit(name);
    for (const [section, pairs] of Object.entries(u)) {
      for (const [key, value] of pairs) {
        assert.ok(!CREDENTIAL_DIRECTIVES.includes(key), `${name} [${section}] ${key}= brings a credential into the unit`);
        assert.ok(!/r2-narration\.env|credentials?-file/i.test(value), `${name} ${key}= names the credential file: ${value}`);
        for (const word of value.split(/[\s=,]+/)) {
          assert.ok(!/^[A-Za-z0-9+/_-]{32,}$/.test(word) || word.startsWith("/"), `${name} ${key}= holds a secret-looking string`);
        }
      }
    }
    for (const [envName] of envPairs(u)) {
      assert.ok(!SECRET_NAME.test(envName), `${name} sets ${envName}, which looks like a secret`);
    }
  }
});

test("the worker runs render-foray.py --worker on an absolute spool path, long-lived", () => {
  /* MUTATION: drop `--worker <spool>` (a batch render that exits) -> red;
     give a relative spool or one under /tmp (PrivateTmp loses it) or inside
     the read-only /opt/foray checkout -> red; add `--once` or `--idle-exit`
     -> red; Type=oneshot or no Restart= -> red; a spool outside
     ReadWritePaths= (ProtectSystem=strict makes it read-only) -> red. */
  const u = unit(WORKER_UNIT);
  const argv = execArgv(one(u, "Service", "ExecStart"));
  assert.match(argv[0], /^\/.*\/python3?$/, "ExecStart runs an absolute python");
  assert.equal(argv[1], "tools/narration/render-foray.py");
  assert.ok(fs.existsSync(path.join(ROOT, argv[1])), `${argv[1]} is not in the repo`);
  const spool = flagValue(argv, "--worker");
  assert.ok(spool, "ExecStart has no --worker SPOOL");
  assert.match(spool, /^\/var\/lib\/[A-Za-z0-9._/-]+$/, `spool ${spool} must be an absolute path under /var/lib/`);
  assert.ok(!argv.includes("--once") && !argv.includes("--idle-exit"), "the service worker stays resident");
  assert.equal(one(u, "Service", "Type"), "simple");
  assert.match(one(u, "Service", "Restart"), /^(on-failure|always)$/);
  assert.equal(one(u, "Service", "ProtectSystem"), "strict");
  const writable = values(u, "Service", "ReadWritePaths").flatMap((v) => v.split(/\s+/));
  assert.ok(writable.some((w) => spool === w || spool.startsWith(`${w.replace(/\/$/, "")}/`)), `spool ${spool} is not under ReadWritePaths=`);
  assert.equal(one(u, "Service", "WorkingDirectory"), "/opt/foray");
});

test("the worker's threads are bounded: --threads, OpenMP, CPU quota and nice", () => {
  /* The Spark CPU is shared with SGLang's host processes.
     MUTATION: drop `--threads 4` (the default is min(4, cpu_count) today but
     not pinned) -> red; `--threads 20` -> red; drop OMP_NUM_THREADS or set it
     above --threads -> red; drop CPUQuota= or raise it past threads x 100% ->
     red; Nice=0 -> red; install target default.target (a user unit, where
     CPUQuota= needs delegation) -> red. */
  const u = unit(WORKER_UNIT);
  const argv = execArgv(one(u, "Service", "ExecStart"));
  const threads = Number(flagValue(argv, "--threads"));
  assert.ok(Number.isInteger(threads) && threads >= 1 && threads <= MAX_THREADS, `--threads must be 1..${MAX_THREADS}, got ${flagValue(argv, "--threads")}`);
  const omp = envPairs(u).find(([k]) => k === "OMP_NUM_THREADS");
  assert.ok(omp, "Environment=OMP_NUM_THREADS is not set");
  assert.ok(Number(omp[1]) >= 1 && Number(omp[1]) <= threads, `OMP_NUM_THREADS=${omp[1]} exceeds --threads ${threads}`);
  const quota = /^(\d+)%$/.exec(one(u, "Service", "CPUQuota"));
  assert.ok(quota && Number(quota[1]) > 0 && Number(quota[1]) <= threads * 100, "CPUQuota= must be at most threads x 100%");
  assert.ok(Number(one(u, "Service", "Nice")) >= 10, "Nice= must be 10 or more");
  assert.match(one(u, "Service", "MemoryMax"), /^\d+[KMG]$/);
  assert.equal(one(u, "Install", "WantedBy"), "multi-user.target", "a system unit, so CPUQuota= and MemoryMax= are enforced");
});

test("the real render-foray.py accepts the worker's argv and refuses nothing in it", () => {
  /* The argv goes through render-foray.py's own build_parser and plan_worker
     (stdlib only: nothing heavy loads), so a flag the worker refuses fails
     here and not on the Spark.
     MUTATION: add `--out /var/lib/foray/narration-render` (the card's first
     draft; --worker takes its jobs from the spool and refuses --out) -> red;
     add `--smoke` -> red; misspell `--threads` -> red (argparse exits 2). */
  assert.ok(PYTHON, "no python3/python/py on PATH: this suite does not silently skip");
  const argv = execArgv(one(unit(WORKER_UNIT), "Service", "ExecStart")).slice(2);
  const snippet =
    `import json,sys,importlib.util\n` +
    `spec=importlib.util.spec_from_file_location("rf", ${JSON.stringify(RENDER_SCRIPT)})\n` +
    `R=importlib.util.module_from_spec(spec); spec.loader.exec_module(R)\n` +
    `a=R.build_parser().parse_args(json.loads(sys.argv[1]))\n` +
    `v=R.plan_worker(a, R.load_profile())\n` +
    `print(json.dumps({"worker":a.worker,"threads":a.threads,"no_download":a.no_download,"voices":v}))\n`;
  const r = spawnSync(PYTHON, ["-c", snippet, JSON.stringify(argv)], { encoding: "utf8", cwd: ROOT });
  assert.equal(r.status, 0, `render-foray.py refused the unit's argv:\n${r.stderr}`);
  const got = JSON.parse(r.stdout.trim().split("\n").at(-1));
  assert.equal(got.worker, flagValue(argv, "--worker"));
  assert.equal(got.threads, Number(flagValue(argv, "--threads")));
  assert.ok(got.voices.length >= 1);
});

test("the upload timer drives spool-upload.mjs over the worker's spool, as a different user", () => {
  /* MUTATION: point the timer at a unit name that is not in this directory ->
     red; give spool-upload a different spool -> red; run the upload as
     foray-render (the worker could then read the token) -> red; a different
     Group= or a UMask that drops group write (the upload user must rewrite
     done/ and remove upload/<job>/) -> red; drop the timer's repeat -> red. */
  const timer = unit(UPLOAD_TIMER);
  const target = one(timer, "Timer", "Unit");
  assert.equal(target, UPLOAD_UNIT);
  assert.ok(fs.existsSync(path.join(HERE, target)), `${target} is not in tools/narration/spark/`);
  assert.ok(values(timer, "Timer", "OnUnitInactiveSec").length + values(timer, "Timer", "OnUnitActiveSec").length >= 1, "the timer never repeats");
  assert.equal(one(timer, "Install", "WantedBy"), "timers.target");

  const worker = unit(WORKER_UNIT);
  const upload = unit(UPLOAD_UNIT);
  const argv = execArgv(one(upload, "Service", "ExecStart"));
  assert.match(argv[0], /^\/.*\/node$/);
  assert.equal(argv[1], "tools/narration/spool-upload.mjs");
  assert.ok(fs.existsSync(path.join(ROOT, argv[1])), `${argv[1]} is not in the repo`);
  const workerSpool = flagValue(execArgv(one(worker, "Service", "ExecStart")), "--worker");
  assert.equal(argv[2], workerSpool, "the upload reads a different spool from the one the worker stages into");
  assert.equal(one(upload, "Service", "Type"), "oneshot");
  assert.equal(one(upload, "Service", "WorkingDirectory"), one(worker, "Service", "WorkingDirectory"));
  assert.notEqual(one(upload, "Service", "User"), one(worker, "Service", "User"), "the render worker must not run as the token's user");
  assert.equal(one(upload, "Service", "Group"), one(worker, "Service", "Group"));
  for (const u of [worker, upload]) assert.equal(one(u, "Service", "UMask"), "0007");
});

test("the runbook lists --check, --smoke, the GB10 bench, the spark-live tag and every unit it installs", () => {
  /* MUTATION: delete the bench-narration.py torch-cuda/ort-cpu line, the
     --check or --smoke step, or the spark-live tag -> red; rename a unit file
     without the runbook -> red. */
  const readme = fs.readFileSync(path.join(HERE, "README.md"), "utf8");
  /* misaki's G2P pip-installs spaCy's en_core_web_sm at first load when it is
     missing; the venv is root-owned and the worker runs ProtectSystem=strict,
     so the model must go into /opt/foray-venv at install time, pinned.
     MUTATION: drop the en_core_web_sm install line, unpin it, or install it
     into a venv other than /opt/foray-venv -> red. */
  assert.match(readme, /sudo \/opt\/foray-venv\/bin\/pip install \\\s*\n\s*"en_core_web_sm @ https:\/\/github\.com\/explosion\/spacy-models\/releases\/download\/en_core_web_sm-3\.8\.0\/en_core_web_sm-3\.8\.0-py3-none-any\.whl"/);
  assert.match(readme, /render-foray\.py --check/);
  assert.match(readme, /render-foray\.py --smoke/);
  assert.match(readme, /bench-narration\.py --only torch-cuda,ort-cpu/);
  assert.match(readme, /spark-live/);
  assert.match(readme, /#862/);
  for (const name of UNIT_FILES) assert.ok(readme.includes(`spark/${name}`), `the runbook does not install ${name}`);
});
