/* GV-48 (W3-09, docs/roadmap/generation-v2.md): the nightly chain. Every step
   is injected and recorded; the log and the passages file live in a tmp
   directory. The two HTTP steps are exercised against a loopback fake server.
   No test streams R2, spawns the backend, opens a store or calls a model. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DELTA_STEPS, NIGHTLY_STEPS, parseNightlyArgs, postServer, realSteps, runNightly } from "./nightly.mjs";

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "gv48-nightly-"));
  return { dir, passages: join(dir, "nightly-passages.jsonl"), logFile: join(dir, "logs", "nightly.log"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Steps that record their order; `delta` is what stream-index reports, and
 * stream-index writes the passages file when it has a delta, as the real one
 * appends to --passages-out. */
function recordingSteps({ delta = 0, fail = null, passages } = {}) {
  const calls = [];
  const steps = {};
  for (const name of NIGHTLY_STEPS) {
    steps[name] = async () => {
      calls.push(name);
      if (name === fail) throw new Error(`${name} broke`);
      if (name === "stream-index") {
        if (delta > 0) writeFileSync(passages, '{"id":"p1"}\n', { flag: "a" });
        return { ok: true, delta };
      }
      return { ok: true };
    };
  }
  return { steps, calls };
}

const logLines = (file) =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

let clock = 0;
const now = () => (clock += 5);

test("a changed corpus runs every step in order, logs each with timings, and clears the passages file after embed", async () => {
  /* MUTATION THAT KILLS THIS: remove the passages file after ingest instead
     of after embed (a failed embed would lose the delta's passages); swap
     warm and ingest in NIGHTLY_STEPS. Ran the first — red. */
  const box = sandbox();
  try {
    const { steps, calls } = recordingSteps({ delta: 2, passages: box.passages });
    let existedAtEmbed = null;
    const embed = steps.embed;
    steps.embed = async (ctx) => {
      existedAtEmbed = existsSync(ctx.passages);
      return embed(ctx);
    };
    const result = await runNightly({ steps, passages: box.passages, logFile: box.logFile, now, runId: "r1" });
    assert.deepEqual(calls, ["stream-index", "warm", "ingest", "embed", "reload", "shortlist"]);
    assert.deepEqual(NIGHTLY_STEPS, ["stream-index", "warm", "ingest", "embed", "reload", "shortlist"]);
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.changed, true);
    assert.equal(existedAtEmbed, true);
    assert.equal(existsSync(box.passages), false);
    const lines = logLines(box.logFile);
    assert.deepEqual(lines.map((l) => [l.step, l.status]), [...NIGHTLY_STEPS.map((s) => [s, "ok"]), ["nightly", "ok"]]);
    for (const l of lines) {
      assert.equal(l.run, "r1");
      assert.equal(typeof l.ms, "number");
      assert.match(l.at, /^\d{4}-\d\d-\d\dT/);
    }
    assert.equal(lines[0].delta, 2);
  } finally {
    box.done();
  }
});

test("an unchanged corpus skips warm, ingest, embed and reload and only rebuilds the shortlist", async () => {
  /* MUTATION THAT KILLS THIS: compute `changed` as true whenever
     stream-index succeeds (every step runs and the index is rewritten). Ran
     it — red. */
  const box = sandbox();
  try {
    const { steps, calls } = recordingSteps({ delta: 0, passages: box.passages });
    const result = await runNightly({ steps, passages: box.passages, logFile: box.logFile, now, runId: "r2" });
    assert.deepEqual(calls, ["stream-index", "shortlist"]);
    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    assert.deepEqual(DELTA_STEPS, ["warm", "ingest", "embed", "reload"]);
    const lines = logLines(box.logFile);
    assert.deepEqual(
      lines.map((l) => [l.step, l.status]),
      [["stream-index", "ok"], ["warm", "skipped"], ["ingest", "skipped"], ["embed", "skipped"], ["reload", "skipped"], ["shortlist", "ok"], ["nightly", "ok"]]
    );
    assert.equal(lines[1].reason, "no-delta");

    /* A passages file left by a run that failed after stream-index counts as
       a change: it is still ingested and embedded. */
    writeFileSync(box.passages, '{"id":"left-over"}\n');
    const again = recordingSteps({ delta: 0, passages: box.passages });
    const second = await runNightly({ steps: again.steps, passages: box.passages, logFile: box.logFile, now, runId: "r3" });
    assert.deepEqual(again.calls, NIGHTLY_STEPS);
    assert.equal(second.changed, true);
  } finally {
    box.done();
  }
});

test("a failure stops the chain: later steps never run, the log names the step, the exit code is 1, the passages file stays", async () => {
  /* MUTATION THAT KILLS THIS: `continue` instead of `break` after a failed
     step (reload and shortlist still run over a half-built index). Ran it —
     red. */
  const box = sandbox();
  try {
    const { steps, calls } = recordingSteps({ delta: 1, fail: "embed", passages: box.passages });
    const result = await runNightly({ steps, passages: box.passages, logFile: box.logFile, now, runId: "r4" });
    assert.deepEqual(calls, ["stream-index", "warm", "ingest", "embed"]);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.equal(existsSync(box.passages), true);
    const lines = logLines(box.logFile);
    const failed = lines.find((l) => l.step === "embed");
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "embed broke");
    assert.deepEqual(lines.at(-1), { ...lines.at(-1), step: "nightly", status: "failed", failedStep: "embed" });
    assert.equal(lines.some((l) => l.step === "reload" || l.step === "shortlist"), false);

    /* A step that returns {ok: false} (a child's nonzero exit) fails the same way. */
    const soft = recordingSteps({ delta: 0, passages: box.passages });
    rmSync(box.passages, { force: true });
    soft.steps["stream-index"] = async () => ({ ok: false, delta: 0, exit: 2 });
    const r = await runNightly({ steps: soft.steps, passages: box.passages, logFile: box.logFile, now, runId: "r5" });
    assert.equal(r.exitCode, 1);
    assert.deepEqual(soft.calls, []);
    assert.equal(logLines(box.logFile).find((l) => l.run === "r5" && l.step === "stream-index").exit, 2);
    await assert.rejects(runNightly({ steps: { warm: async () => ({}) }, passages: box.passages, logFile: box.logFile }), /no step stream-index/);
  } finally {
    box.done();
  }
});

test("the reload and shortlist steps POST to the server with the bearer token; an HTTP error fails the step; args parse", async () => {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const status = req.url === "/v1/shortlist/rebuild" && seen.filter((s) => s.url === req.url).length > 1 ? 503 : 200;
      const payload = req.url === "/v1/reload" ? { shows: 3, episodes: 8 } : status === 200 ? { nodes: 194, rows: 9000, empty: ["arts"] } : { error: "no store" };
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const args = parseNightlyArgs(["--url", url, "--source", "local", "--embedder", "stub"], {});
    const steps = realSteps(args, { env: { FORAY_RETRIEVAL_TOKEN: "t0ken" } });
    assert.deepEqual(await steps.reload(), { ok: true, status: 200, shows: 3, episodes: 8 });
    assert.deepEqual(await steps.shortlist(), { ok: true, status: 200, nodes: 194, rows: 9000, empty: 1 });
    assert.deepEqual(await steps.shortlist(), { ok: false, status: 503, error: "no store" });
    assert.deepEqual(
      seen.map((s) => [s.method, s.url, s.auth, s.body]),
      [
        ["POST", "/v1/reload", "Bearer t0ken", "{}"],
        ["POST", "/v1/shortlist/rebuild", "Bearer t0ken", "{}"],
        ["POST", "/v1/shortlist/rebuild", "Bearer t0ken", "{}"],
      ]
    );
    const refused = await postServer("http://127.0.0.1:1", "/v1/reload", {}, { timeoutMs: 2000 });
    assert.equal(refused.ok, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(parseNightlyArgs([], { FORAY_RETRIEVAL_URL: "http://spark:7311" }).url, "http://spark:7311");
  assert.equal(parseNightlyArgs([], {}).source, "r2");
  assert.throws(() => parseNightlyArgs(["--source", "s3"], {}), /--source must be r2 or local/);
  assert.throws(() => parseNightlyArgs(["--embedder", "anthropic"], {}), /--embedder must be one of/);
  assert.throws(() => parseNightlyArgs(["--full"], {}), /unknown flag --full/);
});
