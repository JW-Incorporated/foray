#!/usr/bin/env node
/* tools/narration/upload-narration.mjs — put rendered narration into the public bucket.
 *
 * `docs/plans/spark-central-narration-assessment.md` §3.2, §5 Phase 1 and §6
 * items 3-5 (rulings D6 and D8, accepted 2026-09-28). Takes a render output
 * directory (`render-foray.py --out`, or the `narration-render` artifact of
 * `.github/workflows/render-narration.yml`, unzipped) and copies every
 * `rendered` line's `.m4a` to R2 bucket `foray-narration` with
 * `rclone copy --immutable`: write-once, so an object that already exists with
 * different bytes is an ERROR, never an overwrite (phones keep old data sets,
 * so a key must always mean the same audio).
 *
 * ── Where this may run ─────────────────────────────────────────────────────
 * ONLY on a machine where the founder placed a write token (the PC in Phase 1,
 * the Spark later). It REFUSES under CI (`CI` or `GITHUB_ACTIONS` set) before
 * reading anything: no R2 write ever happens from GitHub Actions, and nothing
 * in this repository or its workflows holds a credential.
 *
 * ── Where the credentials come from ────────────────────────────────────────
 * ONLY the founder's local env file, never the process environment and never
 * an argument (so a token cannot land in shell history or a process list):
 *
 *     %USERPROFILE%\.foray\r2-narration.env      (Windows)
 *     ~/.foray/r2-narration.env                  (Linux / the Spark; chmod 600)
 *
 * `KEY=value` lines, `#` comments allowed, exactly as HUMAN-ACTIONS #120
 * tells the founder to write them:
 *
 *     R2_NARRATION_ACCOUNT_ID=<32 hex>          -> https://<id>.r2.cloudflarestorage.com
 *     R2_NARRATION_ACCESS_KEY_ID=...            Object Read & Write on foray-narration ONLY
 *     R2_NARRATION_SECRET_ACCESS_KEY=...
 *     R2_NARRATION_BUCKET=foray-narration       (optional; any other bucket is refused)
 *     NARRATION_PUBLIC_BASE=https://audio.jwlabs.ai   (optional; for --verify-public)
 *
 * Fallback spellings are accepted case-insensitively: the corpus `R2_ENV`
 * names (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_S3_ENDPOINT`,
 * `R2_BUCKET`) and the Cloudflare dashboard's (`Access_Key_ID`,
 * `Secret_Access_Key`, `S3_API_Endpoint`). The values are handed to rclone
 * through its `RCLONE_CONFIG_*` environment, never argv.
 *
 * ── Headers ────────────────────────────────────────────────────────────────
 *   Content-Type:  audio/mp4
 *   Cache-Control: public, max-age=31536000, immutable
 * both read from render-profile.json, the same file that names the keys.
 *
 *     node tools/narration/upload-narration.mjs <render-out-dir> --dry-run
 *     node tools/narration/upload-narration.mjs <render-out-dir>
 *     node tools/narration/upload-narration.mjs <render-out-dir> --verify-public
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROFILE_PATH = path.join(HERE, "render-profile.json");
export const MANIFEST_KIND = "foray-narration-render";
/** The rclone remote name the environment defines. Not a secret. */
export const REMOTE = "foraynarration";
/** The only bucket this tool writes. foray-transcriptions stays private forever (D6). */
export const ALLOWED_BUCKET = "foray-narration";

export class UploadError extends Error {}

export function defaultEnvFile(home = os.homedir()) {
  return path.join(home, ".foray", "r2-narration.env");
}

/** True when this process is running under CI. Checked first, always. */
export function inCI(env = process.env) {
  return ["CI", "GITHUB_ACTIONS"].some((k) => {
    const v = env[k];
    return typeof v === "string" && v !== "" && v.toLowerCase() !== "false" && v !== "0";
  });
}

/* The first name of each list is the one HUMAN-ACTIONS #120 writes. */
const ALIASES = {
  accountId: ["r2_narration_account_id", "r2_account_id", "account_id"],
  accessKeyId: ["r2_narration_access_key_id", "r2_access_key_id", "access_key_id", "aws_access_key_id"],
  secretAccessKey: ["r2_narration_secret_access_key", "r2_secret_access_key", "secret_access_key", "aws_secret_access_key"],
  endpoint: ["r2_narration_s3_endpoint", "r2_s3_endpoint", "s3_api_endpoint", "endpoint", "endpoint_url"],
  bucket: ["r2_narration_bucket", "r2_bucket", "bucket"],
  publicBase: ["narration_public_base"],
};

/** Parse the env file's text. Never echoes a value in an error. */
export function parseEnvFile(text) {
  const raw = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(t);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    raw[m[1].toLowerCase()] = v;
  }
  const pick = (names) => names.map((n) => raw[n]).find((v) => typeof v === "string" && v !== "");
  const accountId = pick(ALIASES.accountId);
  if (accountId !== undefined && !/^[0-9a-f]{32}$/i.test(accountId)) {
    throw new UploadError("R2_NARRATION_ACCOUNT_ID must be the 32-character hex Account ID from the R2 overview page");
  }
  const creds = {
    accessKeyId: pick(ALIASES.accessKeyId),
    secretAccessKey: pick(ALIASES.secretAccessKey),
    endpoint: pick(ALIASES.endpoint) ?? (accountId ? `https://${accountId.toLowerCase()}.r2.cloudflarestorage.com` : undefined),
    bucket: pick(ALIASES.bucket) ?? ALLOWED_BUCKET,
    publicBase: pick(ALIASES.publicBase),
  };
  const missing = ["accessKeyId", "secretAccessKey", "endpoint"].filter((k) => !creds[k]);
  if (missing.length) {
    const name = { accessKeyId: "R2_NARRATION_ACCESS_KEY_ID", secretAccessKey: "R2_NARRATION_SECRET_ACCESS_KEY", endpoint: "R2_NARRATION_ACCOUNT_ID" };
    throw new UploadError(`the env file is missing ${missing.map((k) => name[k]).join(", ")}`);
  }
  if (!/^https:\/\/[a-z0-9-]+\.r2\.cloudflarestorage\.com\/?$/i.test(creds.endpoint)) {
    throw new UploadError("the R2 endpoint must be https://<account-id>.r2.cloudflarestorage.com");
  }
  if (creds.bucket !== ALLOWED_BUCKET) {
    throw new UploadError(`refusing bucket ${creds.bucket}: this tool writes only ${ALLOWED_BUCKET} (ruling D6)`);
  }
  Object.defineProperty(creds, "toJSON", {
    value: () => ({ accessKeyId: "<redacted>", endpoint: creds.endpoint, bucket: creds.bucket, publicBase: creds.publicBase }),
  });
  return creds;
}

export function loadCredentials(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new UploadError(`no credentials file at ${file} (the founder places it; see this file's header)`);
  }
  return parseEnvFile(text);
}

/** The rclone remote, defined entirely in the child's environment. */
export function rcloneEnv(creds, base = {}) {
  const p = `RCLONE_CONFIG_${REMOTE.toUpperCase()}_`;
  return {
    ...base,
    [`${p}TYPE`]: "s3",
    [`${p}PROVIDER`]: "Cloudflare",
    [`${p}ACCESS_KEY_ID`]: creds.accessKeyId,
    [`${p}SECRET_ACCESS_KEY`]: creds.secretAccessKey,
    [`${p}ENDPOINT`]: creds.endpoint.replace(/\/+$/, ""),
    [`${p}REGION`]: "auto",
    [`${p}NO_CHECK_BUCKET`]: "true",
  };
}

/** argv for the copy. No secret appears here, by construction. */
export function copyArgs({ dir, listFile, profile, bucket = ALLOWED_BUCKET }) {
  return [
    "copy", dir, `${REMOTE}:${bucket}`,
    "--files-from-raw", listFile,
    "--immutable",
    "--no-traverse",
    "--s3-no-check-bucket",
    "--header-upload", `Content-Type: ${profile.content_type}`,
    "--header-upload", `Cache-Control: ${profile.cache_control}`,
    "--stats-one-line", "-v",
  ];
}

export function checkArgs({ dir, listFile, bucket = ALLOWED_BUCKET }) {
  return ["check", dir, `${REMOTE}:${bucket}`, "--files-from-raw", listFile, "--one-way"];
}

const sha256File = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

/** Every rendered line in the directory's manifests, each verified on disk. */
export function collectUploads(dir, profile) {
  const manifests = fs.readdirSync(dir).filter((f) => /^manifest.*\.json$/.test(f)).sort();
  if (!manifests.length) throw new UploadError(`no manifest*.json in ${dir}`);
  const byKey = new Map();
  for (const f of manifests) {
    const m = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    if (m.kind !== MANIFEST_KIND) throw new UploadError(`${f} is not a ${MANIFEST_KIND} manifest`);
    if (m.profile !== profile.id) throw new UploadError(`${f} was rendered with profile ${m.profile}, not ${profile.id}`);
    for (const e of m.items ?? []) {
      if (e.status !== "rendered") continue;
      if (!new RegExp(`^${profile.key_prefix}/${profile.id}/[a-z]{2}_[a-z]+/[0-9a-f]{64}\\.m4a$`).test(e.key)) {
        throw new UploadError(`${f}: ${e.key} is not a narration key`);
      }
      const p = path.join(dir, ...e.key.split("/"));
      if (!fs.existsSync(p)) throw new UploadError(`${e.key} is in ${f} but not on disk`);
      const size = fs.statSync(p).size;
      if (size !== e.bytes) throw new UploadError(`${e.key}: ${size} bytes on disk, manifest says ${e.bytes}`);
      if (sha256File(p) !== e.sha256) throw new UploadError(`${e.key}: sha256 on disk differs from the manifest`);
      byKey.set(e.key, { key: e.key, bytes: e.bytes, sha256: e.sha256 });
    }
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function run(cmd, args, env) {
  const r = spawnSync(cmd, args, { env, stdio: "inherit" });
  if (r.error) throw new UploadError(`${cmd} could not start: ${r.error.message}`);
  if (r.status !== 0) throw new UploadError(`${cmd} ${args[0]} exited ${r.status}`);
}

async function verifyPublic(uploads, profile, publicBase) {
  let bad = 0;
  for (const u of uploads) {
    const url = `${(publicBase ?? profile.public_base).replace(/\/+$/, "")}/${u.key}`;
    const res = await fetch(url, { method: "HEAD" });
    const ct = res.headers.get("content-type");
    const len = Number(res.headers.get("content-length"));
    const cc = res.headers.get("cache-control") ?? "";
    const ok = res.status === 200 && ct === profile.content_type && len === u.bytes && /immutable/.test(cc);
    if (!ok) bad += 1;
    console.log(`${ok ? "ok  " : "BAD "} ${res.status} ${ct} ${len} B ${cc ? `"${cc}"` : "(no cache-control)"} ${url}`);
  }
  if (bad) throw new UploadError(`${bad} of ${uploads.length} public URL(s) failed the HEAD check`);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  /* FIRST, before reading a single file: never from CI. */
  if (inCI(env)) {
    throw new UploadError(
      "refusing to run under CI (CI/GITHUB_ACTIONS is set). R2 writes happen only on a machine where the founder " +
        "placed a token (assessment §6 item 4); GitHub Actions renders, it never uploads."
    );
  }
  const args = { dir: null, dryRun: false, verifyPublic: false, envFile: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--dry-run") args.dryRun = true;
    else if (k === "--verify-public") args.verifyPublic = true;
    else if (k === "--credentials-file") args.envFile = argv[++i];
    else if (k.startsWith("--")) throw new UploadError(`unknown option ${k}`);
    else if (!args.dir) args.dir = k;
    else throw new UploadError(`unexpected argument ${k}`);
  }
  if (!args.dir) throw new UploadError("usage: upload-narration.mjs <render-out-dir> [--dry-run] [--verify-public] [--credentials-file PATH]");
  const dir = path.resolve(args.dir);
  const profile = JSON.parse(fs.readFileSync(PROFILE_PATH, "utf8"));
  const uploads = collectUploads(dir, profile);
  const bytes = uploads.reduce((a, u) => a + u.bytes, 0);
  console.log(`${uploads.length} object(s), ${(bytes / 1e6).toFixed(2)} MB, verified against their manifests`);
  const listFile = path.join(os.tmpdir(), `narration-upload-${process.pid}.txt`);
  const shown = copyArgs({ dir, listFile, profile });
  if (args.dryRun) {
    for (const u of uploads) console.log(`  would upload ${u.key} (${u.bytes} B)`);
    console.log(`dry run: rclone ${shown.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
    console.log(`dry run: credentials would be read from ${args.envFile ?? defaultEnvFile()}; nothing was read or sent.`);
    return 0;
  }
  if (!uploads.length) {
    console.log("nothing to upload");
    return 0;
  }
  const creds = loadCredentials(args.envFile ?? defaultEnvFile());
  const childEnv = rcloneEnv(creds, { ...env });
  fs.writeFileSync(listFile, uploads.map((u) => u.key).join("\n") + "\n");
  try {
    run("rclone", ["version"], childEnv);
    run("rclone", shown, childEnv);
    run("rclone", checkArgs({ dir, listFile }), childEnv);
  } finally {
    fs.rmSync(listFile, { force: true });
  }
  console.log(`uploaded and checked ${uploads.length} object(s) in ${ALLOWED_BUCKET}`);
  if (args.verifyPublic) await verifyPublic(uploads, profile, creds.publicBase);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`upload-narration: ${err instanceof UploadError ? err.message : err.stack}`);
      process.exit(err instanceof UploadError ? 2 : 1);
    }
  );
}
