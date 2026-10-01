/* verify-narration-audio.mjs: the publish-time network verifier (SPK-09).
 *
 * No network, no ffprobe, no clock: `run()` takes `fetch`, `exec`, `fs`,
 * `sleep`, `random` and `env`, and every test here hands it fakes. The fake
 * host answers like the bucket is supposed to (render-profile.json's headers),
 * and each check's test breaks exactly one thing about that answer and asserts
 * the check is named in the report — the mutation that turns the test red is
 * dropping that check from the tool.
 *
 * Every test names the mutation that turns it red.
 */

import test from "node:test";
import assert from "node:assert/strict";
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  run, parseArgs, linesFromData, sampleCanary, CHECKS, USAGE, VerifyError, DEFAULT_POLITENESS_MS, DEFAULT_ORIGIN,
} from "./verify-narration-audio.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const CLI = path.join(HERE, "verify-narration-audio.mjs");
const PROFILE = JSON.parse(nodeFs.readFileSync(path.join(ROOT, "tools", "narration", "render-profile.json"), "utf8"));
const RENDERED = path.join(HERE, "fixtures", "rendered", "data", "forays.json");
const BASE = "https://audio.jwlabs.ai";
const BYTES = Buffer.from("not really an m4a, but the verifier only hashes and hands it to ffprobe");
const SHA = crypto.createHash("sha256").update(BYTES).digest("hex");
const DURATION = 6.869;
const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const key = (voice, seed) => `${PROFILE.key_prefix}/${PROFILE.id}/${voice}/${sha(seed)}.m4a`;

/** A render manifest shaped like render-foray.py's, in a tmp dir. */
function manifestDir(items) {
  const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "vna-"));
  nodeFs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ kind: "foray-narration-render", version: 1, profile: PROFILE.id, items, failed: [] }));
  return dir;
}
const entry = (voice, seed, extra = {}) => ({
  foray_id: "f", item_id: `i-${seed}`, voice, status: "rendered", key: key(voice, seed),
  bytes: BYTES.length, sha256: SHA, duration_sec: DURATION, profile: PROFILE.id, text_sha256: sha("s"), ...extra,
});
const twoLines = () => manifestDir([entry("af_heart", "a"), entry("am_echo", "a")]);

/** The host as it should answer. Each option breaks one thing. */
function fakeHost({
  bytes = BYTES, headStatus = 200, getStatus = 200, contentType = PROFILE.content_type, contentLength = bytes.length,
  cacheControl = PROFILE.cache_control, acao = "*", throws = null, delay = null,
} = {}) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers ?? {} });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (delay) await delay();
      const boom = throws ? throws() : null;
      if (boom) throw boom;
      const headers = {};
      if (contentType != null) headers["content-type"] = contentType;
      if (contentLength != null) headers["content-length"] = String(contentLength);
      if (cacheControl != null) headers["cache-control"] = cacheControl;
      if (init.method === "HEAD") return new Response(null, { status: headStatus, headers });
      if (acao != null) headers["access-control-allow-origin"] = acao;
      return new Response(bytes, { status: getStatus, headers });
    } finally {
      inFlight -= 1;
    }
  };
  return { fetch, calls, max: () => maxInFlight };
}

/** ffprobe as exec sees it: reads the file the tool wrote and reports `duration`. */
function fakeFfprobe(duration = DURATION) {
  const seen = [];
  const exec = (file, args) => {
    seen.push({ file, args });
    assert.equal(file, "ffprobe");
    const target = args[args.length - 1];
    assert.ok(nodeFs.existsSync(target), "ffprobe is handed a file that exists");
    assert.ok(path.resolve(target).startsWith(path.resolve(os.tmpdir())), `the file is under tmp: ${target}`);
    assert.deepEqual(nodeFs.readFileSync(target), BYTES, "ffprobe reads the downloaded bytes");
    return { status: 0, stdout: `${duration.toFixed(6)}\n`, stderr: "" };
  };
  return { exec, seen };
}
const absentFfprobe = () => {
  const seen = [];
  return { seen, exec: (file, args) => { seen.push({ file, args }); return { error: Object.assign(new Error("spawn ffprobe ENOENT"), { code: "ENOENT" }) }; } };
};

/** fs that records every path it writes, so a test can prove they are all under tmp. */
function recordingFs() {
  const writes = [];
  const reads = [];
  const fs = new Proxy(nodeFs, {
    get(t, k) {
      if (k === "writeFileSync" || k === "mkdtempSync" || k === "rmSync" || k === "mkdirSync") {
        return (p, ...rest) => { writes.push(String(p)); return t[k](p, ...rest); };
      }
      if (k === "readFileSync") return (p, ...rest) => { reads.push(String(p)); return t[k](p, ...rest); };
      return t[k];
    },
  });
  return { fs, writes, reads };
}

/** Run the tool with fakes; returns { code, out, err, calls, sleeps, writes, reads, json }. */
async function drive(argv, { host = fakeHost(), ffprobe = fakeFfprobe(), env = {}, random = Math.random } = {}) {
  const out = [];
  const err = [];
  const sleeps = [];
  const { fs, writes, reads } = recordingFs();
  const code = await run(argv, {
    fetch: host.fetch, exec: ffprobe.exec, fs, env, random,
    sleep: async (ms) => { sleeps.push(ms); },
    stdout: (s) => out.push(s), stderr: (s) => err.push(s), now: () => 0,
  });
  let json = null;
  if (argv.includes("--json") && out.length) json = JSON.parse(out.join("\n"));
  return { code, out, err, calls: host.calls, sleeps, writes, reads, json };
}
const lineFor = (json, voice) => json.lines.find((l) => l.voice === voice);

test("a line the bucket serves as specified passes every check, and the summary says so", async () => {
  /* MUTATION: drop any check from CHECKS, or make `status` read the GET
     instead of the HEAD. */
  const r = await drive(["--manifest", twoLines(), "--base", BASE, "--json"]);
  assert.equal(r.code, 0, r.err.join("\n"));
  assert.equal(r.json.summary.ok, 2);
  assert.equal(r.json.summary.failed, 0);
  for (const l of r.json.lines) {
    assert.equal(l.status, "ok");
    assert.deepEqual(l.failures, []);
    for (const c of CHECKS) assert.match(l.checks[c], /^ok/, `${c} on ${l.key}`);
    assert.equal(l.url, `${BASE}/${l.key}`);
  }
  /* Exactly one HEAD and one GET per object: the CORS probe and the sha share
     the download. MUTATION: a second GET for CORS. */
  assert.equal(r.calls.filter((c) => c.method === "HEAD").length, 2);
  assert.equal(r.calls.filter((c) => c.method === "GET").length, 2);
  for (const c of r.calls) {
    assert.match(c.headers["user-agent"], /ForayBot/, "the honest audio User-Agent from politeness.mjs");
    assert.equal(c.headers["accept-language"], "en");
  }
  /* The one-line-per-object text form. */
  const t = await drive(["--manifest", twoLines(), "--base", BASE]);
  assert.equal(t.out.filter((l) => l.startsWith("ok  ")).length, 2);
  assert.equal(t.out.at(-1), "VERIFIED 2 ok, 0 failed, 0 skipped");
  /* Everything it wrote is under tmp, and the tmp dir is gone afterwards. */
  for (const w of t.writes) assert.ok(path.resolve(w).startsWith(path.resolve(os.tmpdir())), `wrote outside tmp: ${w}`);
  const tmp = t.writes.find((w) => path.basename(w).startsWith("verify-narration-"));
  assert.ok(tmp && !nodeFs.existsSync(tmp), "the scratch directory is removed");
});

test("HEAD that is not 200 fails `status`, and the line stops there (no download)", async () => {
  /* MUTATION: accept any 2xx/3xx, or GET the object anyway. */
  const host = fakeHost({ headStatus: 404 });
  const r = await drive(["--manifest", twoLines(), "--base", BASE, "--json"], { host });
  assert.equal(r.code, 1);
  for (const l of r.json.lines) {
    assert.equal(l.status, "failed");
    assert.ok(l.failures.includes("status"), l.failures.join());
    assert.match(l.checks.status, /^fail: HEAD 404/);
    assert.equal(l.checks.cors, "skipped");
    assert.equal(l.checks.sha256, "skipped");
  }
  assert.equal(r.calls.filter((c) => c.method === "GET").length, 0, "no byte is downloaded from a 404");
  assert.equal(r.json.summary.failed, 2);
});

test("a content-type other than audio/mp4 fails `content_type` (iOS refuses an m4a served as octet-stream)", async () => {
  /* MUTATION: compare loosely (`includes("audio")`) or not at all. */
  const r = await drive(["--manifest", twoLines(), "--base", BASE, "--json"], { host: fakeHost({ contentType: "application/octet-stream" }) });
  assert.equal(r.code, 1);
  assert.deepEqual(lineFor(r.json, "af_heart").failures, ["content_type"]);
  assert.match(lineFor(r.json, "af_heart").checks.content_type, /octet-stream is not audio\/mp4/);
  /* A charset parameter on the right media type is not a failure. */
  const ok = await drive(["--manifest", twoLines(), "--base", BASE, "--json"], { host: fakeHost({ contentType: "audio/mp4; charset=binary" }) });
  assert.equal(ok.code, 0);
});

test("a content-length that is not the manifest's bytes fails `content_length`", async () => {
  /* MUTATION: compare the GET body only, or skip when the HEAD has a length. */
  const r = await drive(["--manifest", twoLines(), "--base", BASE, "--json"], { host: fakeHost({ contentLength: BYTES.length + 7 }) });
  assert.equal(r.code, 1);
  assert.deepEqual(lineFor(r.json, "am_echo").failures, ["content_length"]);
  assert.match(lineFor(r.json, "am_echo").checks.content_length, new RegExp(`${BYTES.length + 7} != manifest ${BYTES.length}`));
  const none = await drive(["--manifest", twoLines(), "--base", BASE, "--json"], { host: fakeHost({ contentLength: null }) });
  assert.deepEqual(lineFor(none.json, "am_echo").failures, ["content_length"]);
  assert.match(lineFor(none.json, "am_echo").checks.content_length, /\(none\)/);
});

test("a cache-control without `immutable` fails `cache_control`", async () => {
  /* MUTATION: test for `max-age` instead, or accept a missing header. */
  const r = await drive(["--manifest", twoLines(), "--base", BASE, "--json"], { host: fakeHost({ cacheControl: "public, max-age=31536000" }) });
  assert.equal(r.code, 1);
  assert.deepEqual(lineFor(r.json, "af_heart").failures, ["cache_control"]);
  assert.match(lineFor(r.json, "af_heart").checks.cache_control, /lacks immutable/);
  const none = await drive(["--manifest", twoLines(), "--base", BASE, "--json"], { host: fakeHost({ cacheControl: null }) });
  assert.match(lineFor(none.json, "af_heart").checks.cache_control, /no cache-control/);
});

test("the GET carries Origin capacitor://localhost, and a missing access-control-allow-origin fails `cors`", async () => {
  /* MUTATION: send no Origin (a CDN answers no ACAO to an origin-less request,
     and the check would pass on nothing), or accept an ACAO for another origin. */
  const host = fakeHost({ acao: null });
  const r = await drive(["--manifest", twoLines(), "--base", BASE, "--json"], { host });
  assert.equal(r.code, 1);
  for (const c of host.calls.filter((c) => c.method === "GET")) assert.equal(c.headers.origin, DEFAULT_ORIGIN);
  assert.deepEqual(lineFor(r.json, "af_heart").failures, ["cors"]);
  assert.match(lineFor(r.json, "af_heart").checks.cors, /no access-control-allow-origin for Origin capacitor:\/\/localhost/);
  /* An ACAO that names a different origin does not admit this one. */
  const other = await drive(["--manifest", twoLines(), "--base", BASE, "--json"], { host: fakeHost({ acao: "https://elsewhere.example" }) });
  assert.deepEqual(lineFor(other.json, "af_heart").failures, ["cors"]);
  /* `--origin` picks a web origin from the CSP; an echo of it passes. */
  const web = fakeHost({ acao: "https://foray-web-seven.vercel.app" });
  const w = await drive(["--manifest", twoLines(), "--base", BASE, "--origin", "https://foray-web-seven.vercel.app", "--json"], { host: web });
  assert.equal(w.code, 0, w.err.join("\n"));
  assert.equal(web.calls.find((c) => c.method === "GET").headers.origin, "https://foray-web-seven.vercel.app");
});

test("bytes that do not hash to the manifest's sha256 fail `sha256`", async () => {
  /* MUTATION: hash nothing, or compare the HEAD's etag instead of the bytes. */
  const wrong = Buffer.concat([BYTES, Buffer.from("!")]);
  const r = await drive(["--manifest", twoLines(), "--base", BASE, "--json"], {
    host: fakeHost({ bytes: wrong, contentLength: BYTES.length }), ffprobe: { exec: () => ({ status: 0, stdout: `${DURATION}\n` }) },
  });
  assert.equal(r.code, 1);
  assert.ok(lineFor(r.json, "af_heart").failures.includes("sha256"));
  assert.match(lineFor(r.json, "af_heart").checks.sha256, /!= manifest/);
  /* The downloaded size differing from the manifest is also named. */
  assert.ok(lineFor(r.json, "af_heart").failures.includes("content_length"));
});

test("a decoded duration more than 50 ms from duration_sec fails `duration`; within the band passes", async () => {
  /* MUTATION: widen the band, or compare to the HEAD's length instead of ffprobe. */
  const far = await drive(["--manifest", twoLines(), "--base", BASE, "--json"], { ffprobe: fakeFfprobe(DURATION + 0.06) });
  assert.equal(far.code, 1);
  assert.deepEqual(lineFor(far.json, "af_heart").failures, ["duration"]);
  assert.match(lineFor(far.json, "af_heart").checks.duration, /\+60ms, allowed ±50 ms/);
  const near = await drive(["--manifest", twoLines(), "--base", BASE, "--json"], { ffprobe: fakeFfprobe(DURATION - 0.04) });
  assert.equal(near.code, 0, near.err.join("\n"));
  assert.match(lineFor(near.json, "af_heart").checks.duration, /^ok \(-40ms\)/);
  /* The band is the profile's own number, not a second copy of it. */
  assert.equal(PROFILE.reject.max_container_drift_sec, 0.05);
  /* ffprobe that cannot read the file is a broken file, so a failure. */
  const broken = await drive(["--manifest", twoLines(), "--base", BASE, "--json"], { ffprobe: { exec: () => ({ status: 1, stdout: "", stderr: "moov atom not found" }) } });
  assert.equal(broken.code, 1);
  assert.match(lineFor(broken.json, "af_heart").checks.duration, /ffprobe exited 1: moov atom not found/);
});

test("ffprobe absent: `duration` is skipped, never a failure, and its absence is discovered once", async () => {
  /* MUTATION: treat ENOENT as a failure, or retry ffprobe on every line. */
  const ffprobe = absentFfprobe();
  const r = await drive(["--manifest", twoLines(), "--base", BASE, "--json"], { ffprobe });
  assert.equal(r.code, 0, r.err.join("\n"));
  assert.equal(r.json.ffprobe, "absent");
  for (const l of r.json.lines) {
    assert.equal(l.status, "ok");
    assert.equal(l.checks.duration, "skipped (ffprobe absent)");
  }
  assert.equal(ffprobe.seen.length, 1, "one probe tells the whole run");
  const t = await drive(["--manifest", twoLines(), "--base", BASE], { ffprobe: absentFfprobe() });
  assert.equal(t.out.at(-1), "VERIFIED 2 ok, 0 failed, 0 skipped (ffprobe absent: duration skipped)");
  assert.match(t.out[0], /duration skipped/);
});

test("--canary N samples narration lines from data/forays.json, PUBLISHED first, and skips the manifest-only checks", async () => {
  /* MUTATION: sample uniformly, or read only `audio_url` and miss `voices`. */
  const doc = JSON.parse(nodeFs.readFileSync(RENDERED, "utf8"));
  const draft = doc.forays.find((f) => f.items.some((i) => i.type === "narration" && i.audio_url));
  assert.equal(draft.status, "draft", "the rendered fixture is a draft");
  doc.forays.push({ ...structuredClone(draft), id: `${draft.id}-published`, status: "published" });
  /* The fake ffprobe reports one duration, so every line's measurement is set to it. */
  for (const f of doc.forays) for (const it of f.items ?? []) if (it.type === "narration" && it.audio_url) {
    it.duration_sec = DURATION;
    for (const v of Object.values(it.voices ?? {})) v.duration_sec = DURATION;
  }
  const all = linesFromData(doc, { base: BASE, profile: PROFILE });
  const published = all.filter((l) => l.published);
  assert.ok(published.length >= 4, "Heart and Echo for at least two lines");
  assert.equal(all.length, published.length * 2);
  assert.ok(all.some((l) => l.voice === "am_echo"), "the voices map is walked too");
  const dataFile = path.join(nodeFs.mkdtempSync(path.join(os.tmpdir(), "vna-")), "forays.json");
  nodeFs.writeFileSync(dataFile, JSON.stringify(doc));
  /* Every N up to the published count picks ONLY published lines, whatever
     the shuffle did. */
  for (const seed of [0.01, 0.5, 0.99]) {
    const r = await drive(["--canary", String(published.length), "--data", dataFile, "--base", BASE, "--json"], { random: () => seed });
    assert.equal(r.code, 0, r.err.join("\n"));
    assert.equal(r.json.mode, "canary");
    assert.equal(r.json.lines.length, published.length);
    for (const l of r.json.lines) {
      assert.match(l.foray_id, /-published$/, `published first (seed ${seed})`);
      assert.equal(l.status, "ok");
      assert.equal(l.checks.content_length, "skipped (no manifest bytes)");
      assert.equal(l.checks.sha256, "skipped (no manifest sha256)");
      assert.match(l.checks.duration, /^ok/, "duration_sec from the data is still checked");
      assert.equal(l.checks.cors, "ok");
    }
  }
  /* N past the published count spills into drafts; N of 1 fetches 1 object. */
  const spill = await drive(["--canary", String(published.length + 1), "--data", dataFile, "--base", BASE, "--json"]);
  assert.equal(spill.json.lines.filter((l) => !l.foray_id.endsWith("-published")).length, 1);
  const one = await drive(["--canary", "1", "--data", dataFile, "--base", BASE]);
  assert.equal(one.calls.length, 2, "one HEAD and one GET");
  assert.equal(one.out.at(-1), "VERIFIED 1 ok, 0 failed, 0 skipped");
  /* The shuffle is a permutation: the same set under two seeds. */
  const a = sampleCanary(all, 3, () => 0.1).map((l) => l.url).sort();
  const b = sampleCanary(all, 3, () => 0.9).map((l) => l.url).sort();
  assert.notDeepEqual(a, b);
  assert.ok(a.every((u) => published.some((l) => l.url === u)));
});

test("canary: an audio_url on another host is reported skipped and never fetched; an empty catalogue is a clean zero", async () => {
  /* MUTATION: fetch whatever URL the data holds. */
  const doc = { forays: [{ id: "x", status: "published", items: [
    { type: "narration", id: "n1", audio_url: "https://cdn.elsewhere.example/n/a.m4a", duration_sec: 3 },
    { type: "narration", id: "n2", audio_url: `${BASE}/${key("af_heart", "z")}`, duration_sec: DURATION },
  ] }] };
  const dataFile = path.join(nodeFs.mkdtempSync(path.join(os.tmpdir(), "vna-")), "forays.json");
  nodeFs.writeFileSync(dataFile, JSON.stringify(doc));
  const r = await drive(["--canary", "5", "--data", dataFile, "--base", BASE]);
  assert.equal(r.code, 0, r.err.join("\n"));
  assert.ok(r.calls.every((c) => c.url.startsWith(BASE)), "no request leaves the narration host");
  assert.equal(r.out.at(-1), "VERIFIED 1 ok, 0 failed, 1 skipped");
  assert.match(r.out.find((l) => l.startsWith("skip")), /not under https:\/\/audio\.jwlabs\.ai/);
  nodeFs.writeFileSync(dataFile, JSON.stringify({ forays: [] }));
  const empty = await drive(["--canary", "5", "--data", dataFile, "--base", BASE]);
  assert.equal(empty.code, 0);
  assert.equal(empty.calls.length, 0);
  assert.match(empty.out.join("\n"), /nothing to verify/);
  assert.equal(empty.out.at(-1), "VERIFIED 0 ok, 0 failed, 0 skipped");
});

test("politeness: the injected sleep runs for --politeness-ms before EVERY request, 200 ms by default", async () => {
  /* MUTATION: sleep once per line, or only before the GET, or not at all. */
  const r = await drive(["--manifest", twoLines(), "--base", BASE, "--politeness-ms", "50"]);
  assert.equal(r.sleeps.length, r.calls.length, "one quiet period per request");
  assert.ok(r.calls.length >= 4);
  assert.ok(r.sleeps.every((ms) => ms === 50), r.sleeps.join());
  const d = await drive(["--manifest", twoLines(), "--base", BASE]);
  assert.equal(DEFAULT_POLITENESS_MS, 200);
  assert.ok(d.sleeps.every((ms) => ms === 200));
  const zero = await drive(["--manifest", twoLines(), "--base", BASE, "--politeness-ms", "0"]);
  assert.equal(zero.sleeps.length, 0);
});

test("--max-concurrency bounds the lines in flight (2 by default)", async () => {
  /* MUTATION: Promise.all over every line. */
  const six = manifestDir(["a", "b", "c", "d", "e", "f"].map((s) => entry("af_heart", s)));
  const delay = () => new Promise((res) => setTimeout(res, 2));
  const host2 = fakeHost({ delay });
  const r = await drive(["--manifest", six, "--base", BASE], { host: host2 });
  assert.equal(r.code, 0, r.err.join("\n"));
  assert.ok(host2.max() <= 2 && host2.max() >= 2, `max in flight ${host2.max()}`);
  const host1 = fakeHost({ delay });
  await drive(["--manifest", six, "--base", BASE, "--max-concurrency", "1"], { host: host1 });
  assert.equal(host1.max(), 1);
  assert.deepEqual(r.out.slice(0, 6).map((l) => l.slice(0, 4)), Array(6).fill("ok  "), "results keep the manifest's order");
});

test("exit codes: 0 verified, 1 any failure, 2 usage; and under CI it refuses with 2 before reading anything", async () => {
  /* MUTATION: return 0 on a failure, or run the CI check after the manifest read. */
  assert.equal((await drive(["--manifest", twoLines(), "--base", BASE])).code, 0);
  assert.equal((await drive(["--manifest", twoLines(), "--base", BASE], { host: fakeHost({ acao: null }) })).code, 1);
  const usage = await drive([]);
  assert.equal(usage.code, 2);
  assert.match(usage.err[0], /usage:/);
  assert.equal((await drive(["--manifest", twoLines(), "--canary", "3"])).code, 2, "two modes at once");
  assert.equal((await drive(["--manifest", twoLines(), "--frobnicate"])).code, 2);
  assert.equal((await drive(["--manifest", path.join(os.tmpdir(), "does-not-exist-vna")])).code, 2);
  for (const env of [{ CI: "true" }, { GITHUB_ACTIONS: "true" }, { CI: "1" }]) {
    const ci = await drive(["--manifest", twoLines(), "--base", BASE], { env });
    assert.equal(ci.code, 2, JSON.stringify(env));
    assert.match(ci.err[0], /refusing to run under CI/);
    assert.equal(ci.calls.length, 0, "no request");
    assert.deepEqual(ci.reads, [], "no file read");
    assert.deepEqual(ci.writes, [], "no tmp dir");
  }
  assert.equal((await drive(["--manifest", twoLines(), "--base", BASE], { env: { CI: "false" } })).code, 0, "CI=false is not CI");
});

test("argv never carries a token: credential-looking options are refused, and so is a base with userinfo or a query", async () => {
  /* MUTATION: accept `--token`, or read a secret from the environment. */
  for (const bad of [["--token", "x"], ["--credentials-file", "p"], ["--secret", "x"], ["--header", "Authorization: Bearer x"]]) {
    assert.throws(() => parseArgs(["--canary", "1", ...bad]), VerifyError, bad.join(" "));
  }
  for (const base of ["https://user:pw@audio.jwlabs.ai", "https://audio.jwlabs.ai/?token=abc", "http://audio.jwlabs.ai"]) {
    const r = await drive(["--manifest", twoLines(), "--base", base]);
    assert.equal(r.code, 2, base);
    assert.equal(r.calls.length, 0);
  }
  /* The tool's own source names no credential: it reads a public bucket. */
  const src = nodeFs.readFileSync(CLI, "utf8");
  assert.doesNotMatch(src, /SECRET|ACCESS_KEY|TOKEN|Authorization|loadCredentials|r2-narration\.env/i);
  assert.doesNotMatch(src, /process\.env\.[A-Z_]*(KEY|SECRET|TOKEN)/);
  assert.match(USAGE, /--manifest/);
  assert.doesNotMatch(USAGE, /token|credential/i);
});

test("--json: one object with per-line checks by name and the summary; `unchanged` manifest lines are skipped, not fetched", async () => {
  /* MUTATION: print the text report under --json, or fetch an `unchanged` line. */
  const dir = manifestDir([entry("af_heart", "a"), { ...entry("am_echo", "b"), status: "unchanged", bytes: null, sha256: null }]);
  const r = await drive(["--manifest", dir, "--base", BASE, "--json"]);
  assert.equal(r.code, 0, r.err.join("\n"));
  assert.equal(r.out.length, 1, "one JSON document, nothing else on stdout");
  assert.equal(r.json.kind, "foray-narration-verify");
  assert.equal(r.json.mode, "manifest");
  assert.equal(r.json.base, BASE);
  assert.equal(r.json.origin, DEFAULT_ORIGIN);
  assert.deepEqual(Object.keys(r.json.lines[0].checks), [...CHECKS]);
  assert.deepEqual(r.json.summary, { ok: 1, failed: 0, skipped: 1, total: 2 });
  const skipped = lineFor(r.json, "am_echo");
  assert.equal(skipped.status, "skipped");
  assert.match(skipped.reason, /unchanged/);
  assert.ok(r.calls.every((c) => c.url.includes(key("af_heart", "a"))), "only the rendered line is fetched");
});

test("a manifest from another render profile, or with a key outside the narration layout, is refused before any request", async () => {
  /* MUTATION: verify whatever the manifest names. */
  const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "vna-"));
  nodeFs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ kind: "foray-narration-render", profile: "other-profile", items: [entry("af_heart", "a")] }));
  const other = await drive(["--manifest", dir, "--base", BASE]);
  assert.equal(other.code, 2);
  assert.match(other.err[0], /rendered with profile other-profile/);
  assert.equal(other.calls.length, 0);
  const bad = manifestDir([{ ...entry("af_heart", "a"), key: "n/elsewhere/../../etc/passwd" }]);
  const r = await drive(["--manifest", bad, "--base", BASE]);
  assert.equal(r.code, 2);
  assert.match(r.err[0], /not a narration key/);
  assert.equal(r.calls.length, 0);
});

test("an unreachable host is reported per line and in the summary, never a crash (the --base https://example.invalid dry run)", async () => {
  /* MUTATION: let the fetch rejection escape `verifyLine`. */
  const host = fakeHost({ throws: () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }) });
  const r = await drive(["--manifest", twoLines(), "--base", "https://example.invalid"], { host });
  assert.equal(r.code, 1);
  assert.deepEqual(r.err, []);
  assert.equal(r.out.filter((l) => /^FAIL .*<-- status: HEAD failed: fetch failed/.test(l)).length, 2);
  assert.equal(r.out.at(-1), "VERIFIED 0 ok, 2 failed, 0 skipped");
  assert.ok(r.calls.every((c) => c.url.startsWith("https://example.invalid/n/")));
  /* A GET that breaks after a clean HEAD is a `status` failure too, with the HEAD's checks kept. */
  let n = 0;
  const flaky = fakeHost({ throws: () => (++n % 2 === 0 ? new Error("socket hang up") : null) });
  const f = await drive(["--manifest", manifestDir([entry("af_heart", "a")]), "--base", BASE, "--json"], { host: flaky });
  assert.equal(f.code, 1);
  assert.match(f.json.lines[0].checks.status, /GET failed: socket hang up/);
  assert.equal(f.json.lines[0].checks.content_type, "ok");
});

test("the real CLI: --help exits 0 with the usage; under CI it refuses with exit 2 and prints no stack", () => {
  /* MUTATION: make the CI check follow the argument parse, or exit 1 on a refusal. */
  const local = { ...process.env };
  delete local.CI;
  delete local.GITHUB_ACTIONS;
  const help = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8", env: local });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^usage: node tools\/foray\/verify-narration-audio\.mjs/);
  const ci = spawnSync(process.execPath, [CLI, "--manifest", twoLines()], { encoding: "utf8", env: { ...local, CI: "true" } });
  assert.equal(ci.status, 2);
  assert.match(ci.stderr, /refusing to run under CI/);
  assert.doesNotMatch(ci.stderr, /\n\s+at /, "a refusal, not a stack trace");
  const usage = spawnSync(process.execPath, [CLI], { encoding: "utf8", env: local });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage:/);
});
