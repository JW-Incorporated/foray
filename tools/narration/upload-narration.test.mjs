/* upload-narration.mjs: the one door from a render to the public bucket.
 *
 * Hard rules (founder, 2026-09-28, with rulings D6/D8): no credentials in the
 * repo or CI; R2 WRITE happens only from a machine where the founder placed a
 * token, never from GitHub Actions; foray-transcriptions stays private forever.
 * These tests pin each rule to a refusal, and run the real CLI (no network, no
 * rclone: the dry run and the refusals return before either is touched).
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
  inCI, parseEnvFile, rcloneEnv, copyArgs, collectUploads, defaultEnvFile, main, UploadError, ALLOWED_BUCKET,
} from "./upload-narration.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "upload-narration.mjs");
const PROFILE = JSON.parse(fs.readFileSync(path.join(HERE, "render-profile.json"), "utf8"));
const SECRET = "s3cr3t-value-that-must-never-print";
/* Exactly the five lines HUMAN-ACTIONS #120 tells the founder to type (Notepad, so CRLF). */
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const GOOD_ENV = [
  `R2_NARRATION_ACCOUNT_ID=${ACCOUNT}`,
  "R2_NARRATION_ACCESS_KEY_ID=AKIDEXAMPLE",
  `R2_NARRATION_SECRET_ACCESS_KEY=${SECRET}`,
  "R2_NARRATION_BUCKET=foray-narration",
  "NARRATION_PUBLIC_BASE=https://audio.jwlabs.ai",
].join("\r\n");

/** An env with every CI marker removed, as on the founder's PC. */
function localEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.CI;
  delete env.GITHUB_ACTIONS;
  return env;
}

/** A render output dir: one real file per voice, and manifests that match it. */
function renderDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upl-"));
  for (const voice of PROFILE.voices) {
    const bytes = Buffer.from(`fake m4a for ${voice}`);
    const hash = crypto.createHash("sha256").update(voice).digest("hex");
    const key = `${PROFILE.key_prefix}/${PROFILE.id}/${voice}/${hash}.m4a`;
    fs.mkdirSync(path.join(dir, path.dirname(key)), { recursive: true });
    fs.writeFileSync(path.join(dir, key), bytes);
    const entry = {
      foray_id: "f", item_id: "i", voice, status: "rendered", key, bytes: bytes.length,
      duration_sec: 1, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), profile: PROFILE.id,
    };
    const unchanged = { ...entry, status: "unchanged", key: key.replace(hash, "f".repeat(64)), bytes: null, sha256: null };
    fs.writeFileSync(
      path.join(dir, `manifest-${voice}.json`),
      JSON.stringify({ kind: "foray-narration-render", version: 1, profile: PROFILE.id, items: [entry, unchanged], failed: [] })
    );
  }
  return dir;
}

test("it refuses under CI before reading anything, even for a dry run", async () => {
  /* The rule that keeps R2 writes off GitHub Actions. Checked with the real
     entry point, in a child process with CI=true, AND in-process for
     GITHUB_ACTIONS alone. MUTATION: check CI only after parsing args, or only
     outside --dry-run, or read only `CI`. */
  const r = spawnSync(process.execPath, [CLI, "/does/not/exist", "--dry-run"], {
    encoding: "utf8", env: { ...localEnv(), CI: "true" },
  });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /refusing to run under CI/);
  await assert.rejects(main(["x", "--dry-run"], { GITHUB_ACTIONS: "true" }), /refusing to run under CI/);
  assert.equal(inCI({ CI: "false" }), false);
  assert.equal(inCI({}), false);
});

test("the dry run lists every rendered object, reads no credentials and exits 0", () => {
  /* Executes the real CLI outside CI. `unchanged` lines have no file and are
     not uploaded. MUTATION: include unchanged lines, or load credentials first. */
  const dir = renderDir();
  try {
    const r = spawnSync(process.execPath, [CLI, dir, "--dry-run", "--credentials-file", path.join(dir, "absent.env")], {
      encoding: "utf8", env: localEnv(),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /2 object\(s\)/);
    assert.equal((r.stdout.match(/would upload /g) || []).length, 2);
    assert.match(r.stdout, /--immutable/);
    assert.match(r.stdout, /nothing was read or sent/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a file whose bytes differ from its manifest is refused before any upload", () => {
  /* MUTATION: trust the manifest without hashing the file. */
  const dir = renderDir();
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest-af_heart.json"), "utf8"));
    const key = m.items[0].key;
    fs.writeFileSync(path.join(dir, key), Buffer.from("tampered same len!!".slice(0, m.items[0].bytes)));
    assert.throws(() => collectUploads(dir, PROFILE), /sha256|bytes/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("credentials come from the env file, #120's names and the fallback spellings, and never print", () => {
  /* The founder's file must parse to the account's endpoint. MUTATION: rename
     R2_NARRATION_* in the alias table, include the secret in toJSON, or read
     process.env instead. */
  const creds = parseEnvFile(GOOD_ENV);
  assert.equal(creds.bucket, ALLOWED_BUCKET);
  assert.equal(creds.accessKeyId, "AKIDEXAMPLE");
  assert.equal(creds.secretAccessKey, SECRET);
  assert.equal(creds.endpoint, `https://${ACCOUNT}.r2.cloudflarestorage.com`);
  assert.equal(creds.publicBase, "https://audio.jwlabs.ai");
  assert.throws(() => parseEnvFile(GOOD_ENV.replace(ACCOUNT, "not-an-id")), /32-character hex/);
  assert.ok(!JSON.stringify(creds).includes(SECRET));
  const dash = parseEnvFile(
    `Access_Key_ID = AKID\nSecret_Access_Key = "${SECRET}"\nS3_API_Endpoint = https://abc.r2.cloudflarestorage.com\n`
  );
  assert.equal(dash.secretAccessKey, SECRET);
  assert.throws(
    () => parseEnvFile(`R2_NARRATION_SECRET_ACCESS_KEY=${SECRET}`),
    (e) => e instanceof UploadError && /R2_NARRATION_ACCESS_KEY_ID/.test(e.message) && !e.message.includes(SECRET)
  );
  assert.match(defaultEnvFile("/home/f"), /[\\/]\.foray[\\/]r2-narration\.env$/);
});

test("only foray-narration is writable: the transcripts bucket and odd endpoints are refused", () => {
  /* D6: foray-transcriptions stays private forever and never holds narration.
     MUTATION: honour any R2_BUCKET value. */
  const bucket = (b) => GOOD_ENV.replace("R2_NARRATION_BUCKET=foray-narration", `R2_NARRATION_BUCKET=${b}`);
  assert.throws(() => parseEnvFile(bucket("foray-transcriptions")), /refusing bucket foray-transcriptions/);
  assert.throws(() => parseEnvFile(bucket("foray-transcripts")), /refusing bucket/);
  assert.throws(() => parseEnvFile(`${GOOD_ENV}\nR2_S3_ENDPOINT=http://evil.example.com`), /endpoint must be/);
});

test("rclone gets --immutable, the profile's headers, and the secret only through its environment", () => {
  /* Write-once, the right Content-Type/Cache-Control, and no token in argv
     (which a process list or a log would show). MUTATION: drop --immutable, or
     pass the key as --s3-secret-access-key. */
  const args = copyArgs({ dir: "/out", listFile: "/tmp/l", profile: PROFILE });
  assert.ok(args.includes("--immutable"));
  assert.ok(args.includes(`Content-Type: ${PROFILE.content_type}`));
  assert.ok(args.includes(`Cache-Control: ${PROFILE.cache_control}`));
  assert.ok(args.includes(`foraynarration:${ALLOWED_BUCKET}`));
  const creds = parseEnvFile(GOOD_ENV);
  assert.ok(!args.join(" ").includes(SECRET));
  const env = rcloneEnv(creds);
  assert.equal(env.RCLONE_CONFIG_FORAYNARRATION_SECRET_ACCESS_KEY, SECRET);
  assert.equal(env.RCLONE_CONFIG_FORAYNARRATION_PROVIDER, "Cloudflare");
});
