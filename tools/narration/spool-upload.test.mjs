/* spool-upload.mjs: the render worker's staged lines go up, then (and only
 * then) their public URL is recorded.
 *
 * GV-22 (docs/roadmap/generation-v2.md). The uploader runner is injected, so
 * no rclone, no credentials and no network are touched; the staged directory
 * is checked by the real upload-narration.mjs collectUploads, and the default
 * runner's argv is pinned to the unchanged governed uploader.
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

import { uploadSpool, uploaderArgv, publicUrl, stagedJobs, main, SpoolUploadError, UPLOADER } from "./spool-upload.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "spool-upload.mjs");
const PROFILE = JSON.parse(fs.readFileSync(path.join(HERE, "render-profile.json"), "utf8"));

/** An env with every CI marker removed, as on the render host. */
function localEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.CI;
  delete env.GITHUB_ACTIONS;
  return env;
}

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

/** Stage one job exactly as render-foray.py --worker does. */
function stage(spool, jobId, { voice = "af_heart", bytes = Buffer.from(`fake m4a ${jobId}`), done = {}, tamper = false } = {}) {
  const key = `${PROFILE.key_prefix}/${PROFILE.id}/${voice}/${sha(jobId)}.m4a`;
  const dir = path.join(spool, "upload", jobId);
  fs.mkdirSync(path.join(dir, path.dirname(key)), { recursive: true });
  fs.writeFileSync(path.join(dir, key), tamper ? Buffer.from("other bytes") : bytes);
  const entry = {
    foray_id: "f", item_id: `i-${jobId}`, voice, status: "rendered", key, bytes: bytes.length,
    duration_sec: 2.5, sha256: sha(bytes), profile: PROFILE.id,
  };
  const manifest = {
    kind: "foray-narration-render", version: 1, profile: PROFILE.id, items: [entry], failed: [],
    totals: { items: 1, rendered: 1, unchanged: 0, failed: 0, bytes: bytes.length, duration_sec: 2.5 },
  };
  fs.writeFileSync(path.join(dir, `manifest-${jobId}.json`), JSON.stringify(manifest));
  fs.mkdirSync(path.join(spool, "done"), { recursive: true });
  const record = { job_id: jobId, status: "rendered", entry, timings: { queued_ms: 1, render_ms: 2, audio_sec: 2.5 }, ...done };
  fs.writeFileSync(path.join(spool, "done", `${jobId}.json`), JSON.stringify(record));
  return { key, dir, record };
}

function withSpool(fn) {
  const spool = fs.mkdtempSync(path.join(os.tmpdir(), "su-"));
  try {
    fs.mkdirSync(path.join(spool, "upload"));
    fs.mkdirSync(path.join(spool, "done"));
    return fn(spool);
  } finally {
    fs.rmSync(spool, { recursive: true, force: true });
  }
}

const readDone = (spool, id) => JSON.parse(fs.readFileSync(path.join(spool, "done", `${id}.json`), "utf8"));
const quiet = () => {};

test("public_url is written only after the injected uploader reports success, then the staged dir goes", () => {
  /* MUTATION: write public_url before calling the uploader, or regardless of
     its exit code; build the URL from anything but public_base + key; keep the
     staged dir after success -> red. */
  withSpool((spool) => {
    const { key, dir, record } = stage(spool, "j-ok");
    const calls = [];
    const r = uploadSpool({
      spool, profile: PROFILE, env: localEnv(), log: quiet,
      runUploader: (d) => {
        calls.push(d);
        assert.equal(readDone(spool, "j-ok").public_url, undefined, "public_url was written before the upload finished");
        assert.ok(fs.existsSync(d), "the staged dir must exist while it uploads");
        return 0;
      },
    });
    assert.deepEqual(calls, [dir]);
    assert.deepEqual(r.uploaded, [{ job_id: "j-ok", key, public_url: `https://audio.jwlabs.ai/${key}` }]);
    assert.deepEqual(readDone(spool, "j-ok"), { ...record, public_url: `https://audio.jwlabs.ai/${key}` });
    assert.equal(fs.existsSync(dir), false);
    assert.deepEqual(fs.readdirSync(path.join(spool, "done")), ["j-ok.json"], "no .part file left behind");
  });
});

test("a failed upload records no public_url and leaves the staged dir for the next run", () => {
  /* MUTATION: treat any exit code as success, or delete the staged dir on
     failure -> red. The next job still uploads. */
  withSpool((spool) => {
    const bad = stage(spool, "j-a");
    const good = stage(spool, "j-b");
    const r = uploadSpool({
      spool, profile: PROFILE, env: localEnv(), log: quiet,
      runUploader: (d) => (d === bad.dir ? 3 : 0),
    });
    assert.deepEqual(r.failed, [{ job_id: "j-a", error: "upload-narration.mjs exited 3" }]);
    assert.deepEqual(r.uploaded.map((u) => u.job_id), ["j-b"]);
    assert.deepEqual(readDone(spool, "j-a"), bad.record);
    assert.ok(fs.existsSync(bad.dir));
    assert.equal(readDone(spool, "j-b").public_url, `https://audio.jwlabs.ai/${good.key}`);
  });
});

test("under CI it refuses before reading anything, and the uploader is never called", () => {
  /* Same rule and same detector as upload-narration.mjs (inCI).
     MUTATION: drop the inCI check, or check it after the staged dirs are read
     -> the runner is called or the spool is read. */
  for (const env of [{ CI: "true" }, { GITHUB_ACTIONS: "true" }]) {
    let called = 0;
    assert.throws(
      () => uploadSpool({ spool: path.join(os.tmpdir(), "su-no-such-spool"), profile: PROFILE, env, runUploader: () => ++called, log: quiet }),
      (err) => err instanceof SpoolUploadError && /refusing to run under CI/.test(err.message)
    );
    assert.equal(called, 0);
    assert.throws(() => main([path.join(os.tmpdir(), "su-no-such-spool")], env), /refusing to run under CI/);
  }
  const r = spawnSync(process.execPath, [CLI, path.join(os.tmpdir(), "su-no-such-spool")], {
    encoding: "utf8", env: { ...localEnv(), CI: "true" },
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /refusing to run under CI/);
});

test("a staged dir that fails collectUploads, or names another key than its done record, is never uploaded", () => {
  /* MUTATION: skip the collectUploads verification, or the done-key check ->
     the runner is called for a tampered or mismatched dir. */
  withSpool((spool) => {
    stage(spool, "j-tampered", { tamper: true });
    stage(spool, "j-mismatch", { done: { entry: { status: "rendered", key: "n/x/af_heart/" + "0".repeat(64) + ".m4a" } } });
    const calls = [];
    const r = uploadSpool({ spool, profile: PROFILE, env: localEnv(), log: quiet, runUploader: (d) => (calls.push(d), 0) });
    assert.deepEqual(calls, []);
    assert.deepEqual(r.failed.map((f) => f.job_id), ["j-mismatch", "j-tampered"]);
    assert.match(r.failed[0].error, /the done record names/);
    assert.match(r.failed[1].error, /bytes on disk|sha256 on disk differs/);
    assert.equal(readDone(spool, "j-tampered").public_url, undefined);
  });
});

test("only staged dirs with a rendered done record are taken; half-staged and failed ones are skipped", () => {
  /* MUTATION: read dot-named staging dirs, or upload a job whose done record
     is missing or failed -> the runner is called for it. */
  withSpool((spool) => {
    stage(spool, "j-ok");
    const noDone = stage(spool, "j-nodone");
    fs.rmSync(path.join(spool, "done", "j-nodone.json"));
    stage(spool, "j-failed", { done: { status: "failed", entry: undefined, error: "x" } });
    fs.mkdirSync(path.join(spool, "upload", ".j-half.staging"));
    assert.deepEqual(stagedJobs(spool), ["j-failed", "j-nodone", "j-ok"]);
    const calls = [];
    const r = uploadSpool({ spool, profile: PROFILE, env: localEnv(), log: quiet, runUploader: (d) => (calls.push(path.basename(d)), 0) });
    assert.deepEqual(calls, ["j-ok"]);
    assert.deepEqual(r.skipped.map((s) => s.job_id), ["j-failed", "j-nodone"]);
    assert.ok(fs.existsSync(noDone.dir));
  });
});

test("the default runner is the unchanged governed uploader: node upload-narration.mjs <dir>", () => {
  /* MUTATION: add flags (--dry-run, --verify-public) or point at another
     script -> red; join public_base and key with two slashes -> red. */
  assert.equal(UPLOADER, path.join(HERE, "upload-narration.mjs"));
  assert.deepEqual(uploaderArgv("/s/upload/j1"), [UPLOADER, "/s/upload/j1"]);
  assert.deepEqual(uploaderArgv("/s/upload/j1", { credentialsFile: "/c.env" }), [UPLOADER, "/s/upload/j1", "--credentials-file", "/c.env"]);
  assert.equal(publicUrl({ public_base: "https://audio.jwlabs.ai/" }, "n/p/v/k.m4a"), "https://audio.jwlabs.ai/n/p/v/k.m4a");
  assert.throws(() => publicUrl({ public_base: "http://audio.jwlabs.ai" }, "k"), /https/);
});

test("--dry-run verifies and lists but calls no uploader and records nothing; the CLI exits 1 on a failure", () => {
  /* MUTATION: run the uploader in a dry run, or exit 0 when a job failed. */
  withSpool((spool) => {
    const { record } = stage(spool, "j-dry");
    const lines = [];
    const code = main([spool, "--dry-run"], localEnv(), { runUploader: () => assert.fail("uploader called in a dry run"), log: (l) => lines.push(l) });
    assert.equal(code, 0);
    assert.match(lines.join("\n"), /would upload j-dry: n\/kokoro-fp32-aac64-v1\/af_heart\/[0-9a-f]{64}\.m4a -> https:\/\/audio\.jwlabs\.ai\//);
    assert.deepEqual(readDone(spool, "j-dry"), record);
    const failed = main([spool], localEnv(), { runUploader: () => 1, log: quiet });
    assert.equal(failed, 1);
  });
});
