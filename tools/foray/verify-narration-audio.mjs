#!/usr/bin/env node
/* tools/foray/verify-narration-audio.mjs — the publish-time network verifier for
 * rendered narration (assessment §3.4, card SPK-09).
 *
 * MANUAL / SPARK, NEVER REQUIRED CI. Like `verify-source-audio.mjs` next to it,
 * this is the thing in `tools/foray/` that touches the network, and it is
 * deliberately not a test: CI must not go red because the audio host had a bad
 * afternoon. The Spark wrapper runs it after `upload-narration.mjs` and before
 * `publish-foray --hold`, and again every night as a canary over what phones
 * already play. It REFUSES under CI (`inCI()` from upload-narration) before
 * reading anything.
 *
 * WHAT IT PROVES, per rendered line, each check reported BY NAME:
 *   status          HEAD answers 200 (a 403/404 here is a stopped player)
 *   content_type    audio/mp4 (render-profile.json `content_type`); iOS refuses
 *                   an m4a served as octet-stream
 *   content_length  equals the manifest's bytes (the write-once bucket holds
 *                   the file the manifest describes, whole)
 *   cache_control   contains `immutable` (the key is a content hash; a
 *                   non-immutable answer means the headers were not applied)
 *   cors            a GET carrying `Origin: capacitor://localhost` (the
 *                   installed app's origin; `--origin` for the web origins in
 *                   index.html's CSP) answers with access-control-allow-origin,
 *                   so a web `fetch()` of the file (downloads) is not refused
 *   sha256          the downloaded bytes hash to the manifest's sha256
 *   duration        `ffprobe` on the downloaded bytes is within
 *                   `reject.max_container_drift_sec` (50 ms) of the manifest's
 *                   `duration_sec`; when ffprobe is absent this is `skipped`,
 *                   never a failure
 *
 * Two modes:
 *   --manifest <dir|file>   every `rendered` line of render-foray.py's
 *                           manifest(s), with its bytes and sha256
 *   --canary N              N lines that carry an audio_url in data/forays.json
 *                           (published Forays first): no manifest bytes or sha,
 *                           so those two checks are skipped and the rest run
 *
 * Politeness: at most `--max-concurrency` (2) requests in flight, and
 * `--politeness-ms` (200) of quiet before each one. One full download per line,
 * no more: the CORS probe and the sha256 read the same GET.
 *
 * It writes nothing outside a temporary directory (the bytes ffprobe reads),
 * holds no credential and accepts none: the bucket is public and the verifier
 * needs only what a phone has.
 *
 *     node tools/foray/verify-narration-audio.mjs --manifest out/
 *     node tools/foray/verify-narration-audio.mjs --canary 12 --json
 *     node tools/foray/verify-narration-audio.mjs --manifest out/ --base https://audio.jwlabs.ai
 */

import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { AUDIO_UA, ACCEPT_LANGUAGE } from "../segments/politeness.mjs";
import { inCI } from "../narration/upload-narration.mjs";
import { normalizeBase, StampError } from "../narration/stamp-narration.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const PROFILE_PATH = path.join(REPO_ROOT, "tools", "narration", "render-profile.json");
export const MANIFEST_KIND = "foray-narration-render";
/** The installed app's origin (index.html's CSP lists it first). */
export const DEFAULT_ORIGIN = "capacitor://localhost";
export const DEFAULT_CONCURRENCY = 2;
export const DEFAULT_POLITENESS_MS = 200;
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Every check, in report order. A line passes when none of these failed. */
export const CHECKS = Object.freeze(["status", "content_type", "content_length", "cache_control", "cors", "sha256", "duration"]);
export const SKIPPED = "skipped";

export class VerifyError extends Error {}

/** The headers every request carries: the honest audio User-Agent and the
    Accept-Language that keeps CDN edges from 404ing Node's default `*`. */
export const PROBE_HEADERS = Object.freeze({ "user-agent": AUDIO_UA, "accept-language": ACCEPT_LANGUAGE });

export const USAGE =
  "usage: node tools/foray/verify-narration-audio.mjs (--manifest <dir|file> [--manifest ...] | --canary N) " +
  "[--base https://audio.jwlabs.ai] [--data data/forays.json] [--origin capacitor://localhost] [--json] " +
  `[--max-concurrency ${DEFAULT_CONCURRENCY}] [--politeness-ms ${DEFAULT_POLITENESS_MS}] [--timeout-ms ${DEFAULT_TIMEOUT_MS}]`;

const positiveInt = (flag, raw) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new VerifyError(`${flag} wants a positive integer, got ${JSON.stringify(raw)}`);
  return n;
};
const nonNegativeInt = (flag, raw) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new VerifyError(`${flag} wants a non-negative integer, got ${JSON.stringify(raw)}`);
  return n;
};

/** argv -> options. Unknown options are refused, so nothing resembling a
    credential can be passed on the command line: the verifier has no use for
    one and must never appear in a process list holding one. */
export function parseArgs(argv) {
  const a = {
    manifests: [], canary: null, base: null, data: null, origin: DEFAULT_ORIGIN, json: false, help: false,
    maxConcurrency: DEFAULT_CONCURRENCY, politenessMs: DEFAULT_POLITENESS_MS, timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  const next = (i, k) => {
    if (i + 1 >= argv.length) throw new VerifyError(`${k} wants a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--manifest") a.manifests.push(next(i, k)), i++;
    else if (k === "--canary") a.canary = positiveInt(k, next(i, k)), i++;
    else if (k === "--base") a.base = next(i, k), i++;
    else if (k === "--data") a.data = next(i, k), i++;
    else if (k === "--origin") a.origin = next(i, k), i++;
    else if (k === "--json") a.json = true;
    else if (k === "--max-concurrency") a.maxConcurrency = positiveInt(k, next(i, k)), i++;
    else if (k === "--politeness-ms") a.politenessMs = nonNegativeInt(k, next(i, k)), i++;
    else if (k === "--timeout-ms") a.timeoutMs = positiveInt(k, next(i, k)), i++;
    else if (k === "--help" || k === "-h") a.help = true;
    else throw new VerifyError(`unknown argument ${k}\n${USAGE}`);
  }
  if (a.help) return a;
  if (a.manifests.length && a.canary !== null) throw new VerifyError("--manifest and --canary are two modes; pass one");
  if (!a.manifests.length && a.canary === null) throw new VerifyError(USAGE);
  return a;
}

export function loadProfile(fs = nodeFs, p = PROFILE_PATH) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** Every `rendered` line of the manifest(s): a file, or a directory's
    `manifest*.json`. `unchanged` lines are listed as skipped (the render did
    not touch them; the nightly canary is what re-checks old objects). */
export function linesFromManifests(paths, { profile, fs = nodeFs }) {
  const files = [];
  for (const p of paths) {
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      throw new VerifyError(`no manifest at ${p}`);
    }
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(p).sort()) if (/^manifest.*\.json$/.test(f)) files.push(path.join(p, f));
    } else files.push(p);
  }
  if (!files.length) throw new VerifyError(`no manifest*.json found in ${paths.join(", ")}`);
  const keyRe = new RegExp(`^${profile.key_prefix}/${profile.id}/[a-z]{2}_[a-z]+/[0-9a-f]{64}\\.m4a$`);
  const byKey = new Map();
  for (const f of files) {
    const m = JSON.parse(fs.readFileSync(f, "utf8"));
    if (m.kind !== MANIFEST_KIND) throw new VerifyError(`${f} is not a ${MANIFEST_KIND} manifest`);
    if (m.profile !== profile.id) throw new VerifyError(`${f} was rendered with profile ${m.profile}, not the committed ${profile.id}`);
    for (const e of m.items ?? []) {
      if (e.status !== "rendered" && e.status !== "unchanged") continue;
      if (typeof e.key !== "string" || !keyRe.test(e.key)) throw new VerifyError(`${f}: ${e.key} is not a narration key`);
      if (byKey.has(e.key)) continue;
      const rendered = e.status === "rendered";
      byKey.set(e.key, {
        key: e.key, foray_id: e.foray_id ?? null, item_id: e.item_id ?? null, voice: e.voice ?? null, published: null,
        bytes: rendered && Number.isInteger(e.bytes) ? e.bytes : null,
        sha256: rendered && typeof e.sha256 === "string" && /^[0-9a-f]{64}$/.test(e.sha256) ? e.sha256 : null,
        duration_sec: Number.isFinite(e.duration_sec) ? e.duration_sec : null,
        skip: rendered ? null : "unchanged in this render (the canary re-checks old objects)",
      });
    }
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Every narration file data/forays.json points at under `base`: the Heart
    `audio_url` and every `voices.<voice>.audio_url`. A URL on another host is
    listed as skipped, never silently dropped. */
export function linesFromData(doc, { base, profile }) {
  const prefix = `${base}/`;
  const out = [];
  for (const f of doc.forays ?? []) {
    for (const it of f.items ?? []) {
      if (it.type !== "narration") continue;
      const urls = [];
      if (typeof it.audio_url === "string" && it.audio_url) urls.push({ voice: profile.default_voice, url: it.audio_url, duration_sec: it.duration_sec });
      for (const [voice, v] of Object.entries(it.voices && typeof it.voices === "object" ? it.voices : {})) {
        if (typeof v?.audio_url === "string" && v.audio_url) urls.push({ voice, url: v.audio_url, duration_sec: v.duration_sec });
      }
      for (const u of urls) {
        out.push({
          key: u.url.startsWith(prefix) ? u.url.slice(prefix.length) : u.url,
          url: u.url, foray_id: f.id, item_id: it.id, voice: u.voice, published: f.status === "published",
          bytes: null, sha256: null, duration_sec: Number.isFinite(u.duration_sec) ? u.duration_sec : null,
          skip: u.url.startsWith(prefix) ? null : `not under ${base}`,
        });
      }
    }
  }
  return out;
}

/** N of the verifiable lines, PUBLISHED FIRST (those are the ones phones play
    tonight), shuffled within each group so the canary walks the whole set over
    a week rather than the same N objects. */
export function sampleCanary(lines, n, random = Math.random) {
  const shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const ok = lines.filter((l) => !l.skip);
  const picked = [...shuffle(ok.filter((l) => l.published)), ...shuffle(ok.filter((l) => !l.published))].slice(0, n);
  return [...picked, ...lines.filter((l) => l.skip)];
}

/** undici says "fetch failed" and hides ENOTFOUND/ECONNREFUSED in `cause`; the report wants the code. */
const reason = (e) => `${e?.message ?? e}${e?.cause?.code ? ` (${e.cause.code})` : ""}`;
const mediaType = (ct) => String(ct ?? "").split(";")[0].trim().toLowerCase();
const short = (n) => (Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${Math.round(n * 1000)}ms` : "?");

/** ffprobe on a file, through the injected exec. Returns
    { available:false } when the binary is missing, else { available:true, duration, error }. */
export function probeDuration(file, exec) {
  const r = exec("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  if (r?.error?.code === "ENOENT") return { available: false };
  if (r?.error) return { available: true, error: `ffprobe could not start: ${r.error.message}` };
  if (r.status !== 0) return { available: true, error: `ffprobe exited ${r.status}${r.stderr ? `: ${String(r.stderr).trim().split("\n")[0]}` : ""}` };
  const d = Number(String(r.stdout ?? "").trim().split(/\r?\n/)[0]);
  if (!Number.isFinite(d)) return { available: true, error: `ffprobe printed no duration (${JSON.stringify(String(r.stdout ?? "").trim())})` };
  return { available: true, duration: d };
}

/**
 * Verify one line. `ctx`: { fetch, exec, fs, sleep, tmpDir, profile, origin,
 * politenessMs, timeoutMs, tolerance, state } where `state.ffprobe` remembers
 * whether the binary exists so a missing ffprobe is discovered once.
 * Returns { ...line, status: "ok"|"failed"|"skipped", checks, failures }.
 */
export async function verifyLine(line, ctx) {
  const checks = Object.fromEntries(CHECKS.map((c) => [c, SKIPPED]));
  const out = { ...line, status: "ok", checks, failures: [] };
  if (line.skip) {
    out.status = "skipped";
    out.reason = line.skip;
    return out;
  }
  const fail = (name, why) => {
    checks[name] = `fail: ${why}`;
    out.failures.push(name);
  };
  const request = async (init) => {
    if (ctx.politenessMs > 0) await ctx.sleep(ctx.politenessMs);
    const signal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(ctx.timeoutMs) : undefined;
    return ctx.fetch(line.url, { redirect: "follow", ...init, signal });
  };

  /* 1. HEAD: the headers a player sees before it asks for a byte. */
  let head;
  try {
    head = await request({ method: "HEAD", headers: { ...PROBE_HEADERS } });
  } catch (e) {
    fail("status", `HEAD failed: ${reason(e)}`);
    out.status = "failed";
    return out;
  }
  if (head.status === 200) checks.status = "ok";
  else fail("status", `HEAD ${head.status}`);
  const ct = head.headers.get("content-type");
  if (mediaType(ct) === ctx.profile.content_type) checks.content_type = "ok";
  else fail("content_type", `${ct ?? "(none)"} is not ${ctx.profile.content_type}`);
  const lenRaw = head.headers.get("content-length");
  const len = lenRaw == null || lenRaw === "" ? NaN : Number(lenRaw);
  if (line.bytes == null) checks.content_length = `${SKIPPED} (no manifest bytes)`;
  else if (len === line.bytes) checks.content_length = "ok";
  else fail("content_length", `${Number.isFinite(len) ? len : "(none)"} != manifest ${line.bytes}`);
  const cc = head.headers.get("cache-control") ?? "";
  if (/\bimmutable\b/i.test(cc)) checks.cache_control = "ok";
  else fail("cache_control", cc ? `"${cc}" lacks immutable` : "no cache-control");
  if (head.status !== 200) {
    out.status = "failed";
    return out;
  }

  /* 2. ONE GET with the app's Origin: CORS, the bytes, the hash, the duration. */
  let body;
  try {
    const res = await request({ method: "GET", headers: { ...PROBE_HEADERS, origin: ctx.origin } });
    if (res.status !== 200) {
      fail("status", `GET ${res.status} after HEAD 200`);
      checks.cors = SKIPPED;
      out.status = "failed";
      return out;
    }
    const acao = res.headers.get("access-control-allow-origin");
    if (acao === "*" || acao === ctx.origin) checks.cors = "ok";
    else if (acao) fail("cors", `access-control-allow-origin ${acao} does not admit ${ctx.origin}`);
    else fail("cors", `no access-control-allow-origin for Origin ${ctx.origin}`);
    body = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    fail("status", `GET failed: ${reason(e)}`);
    out.status = "failed";
    return out;
  }
  if (line.bytes != null && body.length !== line.bytes && checks.content_length === "ok") {
    fail("content_length", `downloaded ${body.length} B, manifest ${line.bytes}`);
  } else if (line.bytes == null && Number.isFinite(len) && body.length !== len) {
    fail("content_length", `downloaded ${body.length} B, HEAD said ${len}`);
  }
  if (line.sha256 == null) checks.sha256 = `${SKIPPED} (no manifest sha256)`;
  else {
    const got = crypto.createHash("sha256").update(body).digest("hex");
    if (got === line.sha256) checks.sha256 = "ok";
    else fail("sha256", `${got.slice(0, 12)}… != manifest ${line.sha256.slice(0, 12)}…`);
  }

  /* 3. The decoded duration, when ffprobe exists. */
  if (line.duration_sec == null) checks.duration = `${SKIPPED} (no duration_sec)`;
  else if (ctx.state.ffprobe === false) checks.duration = `${SKIPPED} (ffprobe absent)`;
  else {
    const file = path.join(ctx.tmpDir, `${crypto.createHash("sha256").update(line.key).digest("hex").slice(0, 16)}.m4a`);
    try {
      ctx.fs.writeFileSync(file, body);
      const p = probeDuration(file, ctx.exec);
      if (!p.available) {
        ctx.state.ffprobe = false;
        checks.duration = `${SKIPPED} (ffprobe absent)`;
      } else {
        ctx.state.ffprobe = true;
        if (p.error) fail("duration", p.error);
        else {
          const delta = p.duration - line.duration_sec;
          if (Math.abs(delta) <= ctx.tolerance + 1e-9) checks.duration = `ok (${short(delta)})`;
          else fail("duration", `ffprobe ${p.duration.toFixed(3)} s vs ${line.duration_sec} s (${short(delta)}, allowed ±${Math.round(ctx.tolerance * 1000)} ms)`);
        }
      }
    } finally {
      try { ctx.fs.rmSync(file, { force: true }); } catch { /* tmp */ }
    }
  }
  if (out.failures.length) out.status = "failed";
  return out;
}

/** A bounded pool: at most `n` lines in flight. Order of results = order of input. */
async function pool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return results;
}

export function formatLine(r) {
  const tag = r.status === "ok" ? "ok  " : r.status === "failed" ? "FAIL" : "skip";
  if (r.status === "skipped") return `${tag}  ${r.key}  ${r.reason}`;
  if (r.status === "failed") return `${tag}  ${r.key}  <-- ${r.failures.map((f) => `${f}: ${r.checks[f].replace(/^fail: /, "")}`).join("; ")}`;
  const notes = CHECKS.map((c) => (r.checks[c] === "ok" ? c : r.checks[c].startsWith("ok") ? `${c} ${r.checks[c].slice(3)}` : `${c} ${SKIPPED}`));
  return `${tag}  ${r.key}  ${notes.join(" ")}`;
}

export function summarize(results) {
  const s = { ok: 0, failed: 0, skipped: 0, total: results.length };
  for (const r of results) s[r.status] += 1;
  return s;
}
export const summaryLine = (s) => `VERIFIED ${s.ok} ok, ${s.failed} failed, ${s.skipped} skipped`;

const defaultExec = (file, args) => spawnSync(file, args, { encoding: "utf8", windowsHide: true });
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The whole run. Returns the exit code: 0 all verified, 1 any failure, 2 usage
 * or refusal. Everything with a side effect is injectable: `fetch`, `exec`
 * (ffprobe), `fs`, `sleep`, `random` (canary sampling), `env` (the CI check),
 * `stdout`/`stderr`, `tmpdir`.
 */
export async function run(argv = process.argv.slice(2), deps = {}) {
  const {
    fetch: fetchImpl = globalThis.fetch, exec = defaultExec, fs = nodeFs, sleep = defaultSleep, random = Math.random,
    env = process.env, stdout = (s) => process.stdout.write(s + "\n"), stderr = (s) => process.stderr.write(s + "\n"),
    tmpdir = os.tmpdir(), now = Date.now,
  } = deps;
  try {
    /* FIRST, before reading a single file: never from the required CI job. */
    if (inCI(env)) {
      throw new VerifyError(
        "refusing to run under CI (CI/GITHUB_ACTIONS is set). The verifier runs from the Spark wrapper or by hand " +
          "(assessment §3.4: never required CI), so a bad afternoon at the audio host never turns a PR red."
      );
    }
    const args = parseArgs(argv);
    if (args.help) {
      stdout(USAGE);
      return 0;
    }
    const profile = loadProfile(fs);
    const base = normalizeBase(args.base ?? env.NARRATION_PUBLIC_BASE ?? profile.public_base);
    const mode = args.manifests.length ? "manifest" : "canary";
    let lines;
    if (mode === "manifest") {
      lines = linesFromManifests(args.manifests.map((p) => path.resolve(p)), { profile, fs }).map((l) => ({ ...l, url: `${base}/${l.key}` }));
    } else {
      const dataPath = path.resolve(args.data ?? path.join(REPO_ROOT, "data", "forays.json"));
      const doc = JSON.parse(fs.readFileSync(dataPath, "utf8"));
      lines = sampleCanary(linesFromData(doc, { base, profile }), args.canary, random);
    }
    const started = now();
    const tmpDir = fs.mkdtempSync(path.join(tmpdir, "verify-narration-"));
    const state = { ffprobe: null };
    let results;
    try {
      const ctx = {
        fetch: fetchImpl, exec, fs, sleep, tmpDir, profile, origin: args.origin, politenessMs: args.politenessMs,
        timeoutMs: args.timeoutMs, tolerance: profile.reject?.max_container_drift_sec ?? 0.05, state,
      };
      results = await pool(lines, args.maxConcurrency, (l) => verifyLine(l, ctx));
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* tmp */ }
    }
    const summary = summarize(results);
    const ffprobe = state.ffprobe === false ? "absent" : state.ffprobe === true ? "available" : "unused";
    if (args.json) {
      stdout(JSON.stringify({
        kind: "foray-narration-verify", mode, base, origin: args.origin, ffprobe, elapsed_ms: now() - started,
        lines: results.map(({ skip, ...r }) => r), summary,
      }, null, 2));
    } else {
      for (const r of results) stdout(formatLine(r));
      if (!results.length) stdout(mode === "canary" ? "canary: no narration line carries an audio_url under the base; nothing to verify" : "no rendered lines in the manifest(s)");
      stdout(`${summaryLine(summary)}${ffprobe === "absent" ? " (ffprobe absent: duration skipped)" : ""}`);
    }
    return summary.failed ? 1 : 0;
  } catch (err) {
    if (err instanceof VerifyError || err instanceof StampError) {
      stderr(`verify-narration-audio: ${err.message}`);
      return 2;
    }
    throw err;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`verify-narration-audio: ${err.stack ?? err}`);
      process.exit(1);
    }
  );
}
