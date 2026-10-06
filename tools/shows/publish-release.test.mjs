/* Unit tests for publish-release.mjs — every `gh` call is faked via the
   injectable `exec`, so this suite never touches the network or a real
   repo. See run-and-publish.test.mjs for the orchestration-level
   (still-fixture) end-to-end idempotency test the card's acceptance
   criterion asks for. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import {
  assetBaseUrlFor, buildPointer, listReleaseAssets, partitionShardBatches, PublishError, publishRelease,
  publishShardReleases, RATE_LIMIT_WAITS_MS, releaseExists, releaseState, releaseTagFor, shardReleaseTagFor,
} from "./publish-release.mjs";

test("releaseTagFor: sanitizes an HTTP-date export_version into a legal tag", () => {
  assert.equal(releaseTagFor("Wed, 03 Sep 2026 06:00:00 GMT"), "shows-index-wed-03-sep-2026-06-00-00-gmt");
});

test("releaseTagFor: passes a local: fixture version through unchanged aside from sanitization", () => {
  assert.equal(releaseTagFor("local:abc123def456"), "shows-index-local-abc123def456");
});

test("releaseTagFor: throws on an export_version that sanitizes to nothing", () => {
  assert.throws(() => releaseTagFor("!!!"), (err) => err instanceof PublishError && err.code === "BAD_EXPORT_VERSION");
});

/* MUTATION: `releaseExists` returning `state === "draft"` -> red (a published release reads false). */
test("releaseExists: true when gh release view succeeds", async () => {
  const exec = async (cmd, args) => {
    assert.equal(cmd, "gh");
    assert.deepEqual(args.slice(0, 3), ["release", "view", "shows-index-v1"]);
    assert.ok(args.includes("--repo") && args.includes("org/repo") && args.includes("--json"));
    return { stdout: JSON.stringify({ isDraft: false, assets: [{ name: "manifest.json", state: "uploaded" }] }) };
  };
  assert.equal(await releaseExists("shows-index-v1", { exec, repo: "org/repo" }), true);
});

/* OPS-03: a draft is an interrupted upload, not a finished release — reading
   it as "exists" would make publishShardReleases SKIP a half-full batch for
   ever. MUTATION: `releaseExists` returning `state !== "absent"` -> red. */
test("releaseExists: a draft is not an existing release", async () => {
  const exec = async () => ({ stdout: JSON.stringify({ isDraft: true, assets: ["aa.json.gz"] }) });
  assert.equal(await releaseExists("shows-index-v1", { exec }), false);
});

/* MUTATION: `parsed.isDraft === true ? "draft"` -> `"published"` always -> red. */
test("releaseState: absent on a real 'release not found'; draft/published carry the asset names", async () => {
  const notFound = async () => { const e = new Error("failed"); e.stderr = "release not found"; throw e; };
  assert.deepEqual(await releaseState("t", { exec: notFound }), { state: "absent", assetNames: [] });
  const draft = async () => ({ stdout: '{"isDraft":true,"assets":[{"name":"a.json.gz","state":"uploaded"},{"name":"b.json.gz","state":"uploaded"}]}\n' });
  assert.deepEqual(await releaseState("t", { exec: draft }), { state: "draft", assetNames: ["a.json.gz", "b.json.gz"] });
  const published = async () => ({ stdout: '{"isDraft":false,"assets":[]}' });
  assert.deepEqual(await releaseState("t", { exec: published }), { state: "published", assetNames: [] });
});

/* MUTATION: drop `release not found|` from the absence regex -> this throws RELEASE_CHECK_FAILED (red). */
test("releaseExists: false ONLY on a real 'release not found'", async () => {
  const exec = async () => { const e = new Error("failed"); e.stderr = "release not found"; throw e; };
  assert.equal(await releaseExists("shows-index-v1", { exec }), false);
});

/* MUTATION: return `{ state: "absent" }` for every error (fail open) -> red. */
test("releaseExists: fails closed (throws) on any other error — auth, network, rate limit", async () => {
  const exec = async () => { const e = new Error("failed"); e.stderr = "HTTP 403: rate limit exceeded"; throw e; };
  await assert.rejects(
    () => releaseExists("shows-index-v1", { exec }),
    (err) => err instanceof PublishError && err.code === "RELEASE_CHECK_FAILED",
  );
});

/* A job killed mid-upload can leave an asset in GitHub's `starter` state:
   the name is taken, the bytes never arrived. It must read as MISSING so the
   resume path re-uploads it with --clobber, or the release publishes with a
   broken shard. The view asks gh for `{name, state}` per asset.
   MUTATION: drop the `a.state === "uploaded"` filter in releaseState -> red. */
test("releaseState: only fully uploaded assets count; a 'starter' (half-uploaded) asset reads as missing", async () => {
  let viewArgs;
  const exec = async (cmd, args) => {
    viewArgs = args;
    return { stdout: JSON.stringify({ isDraft: true, assets: [{ name: "a.json.gz", state: "uploaded" }, { name: "b.json.gz", state: "starter" }, { name: "c.json.gz" }] }) };
  };
  assert.deepEqual(await releaseState("t", { exec }), { state: "draft", assetNames: ["a.json.gz"] });
  assert.match(viewArgs[viewArgs.indexOf("--jq") + 1], /state: \.state/, "the jq projection carries each asset's state");
  // And the resume path re-uploads b and c, not only the never-seen ones.
  const gh = fakeGh({ viewState: { isDraft: true, assets: [{ name: "a.json.gz", state: "uploaded" }, { name: "b.json.gz", state: "starter" }] } });
  const result = await publishRelease({
    tag: "t", title: "T", notes: "N", assets: ["/x/a.json.gz", "/x/b.json.gz", "/x/c.json.gz"], exec: gh.exec, repo: "org/repo", pauseMs: 0,
  });
  assert.deepEqual(gh.gz(gh.calls[1]), ["/x/b.json.gz", "/x/c.json.gz"]);
  assert.ok(gh.calls[1].includes("--clobber"), "--clobber replaces the starter record");
  assert.equal(result.uploaded, 2);
});

test("listReleaseAssets: only the top-level files (incl. the #1033 baseline snapshot) — shards/ is never a release asset", async () => {
  // Per Fable ruling FR-t_30a53ba2-1: GitHub Releases hard-caps a single
  // release at 1,000 assets (confirmed via GitHub's own docs and a real
  // HTTP 422 against this repo), and the real build's ~1,298 shard files
  // put a release well over that ceiling with no batching workaround
  // (the limit is per-release, not per-API-call). No client reads a
  // shard file from a release yet (S-05's cache is unwired), so shard
  // publishing is deferred to a follow-up card instead of shipping here.
  const outDir = await mkdtemp(join(tmpdir(), "shows-publish-"));
  try {
    await mkdir(join(outDir, "shards"));
    for (const f of ["manifest.json", "top.json", "id-map.json", "changed.json", "newest-snapshot.json.gz"]) {
      await writeFile(join(outDir, f), "{}");
    }
    for (const f of ["zz.json.gz", "aa.json.gz", "__.json.gz"]) {
      await writeFile(join(outDir, "shards", f), "");
    }

    const assets = await listReleaseAssets(outDir);
    const names = assets.map((p) => basename(p));
    assert.deepEqual(names, ["manifest.json", "top.json", "id-map.json", "changed.json", "newest-snapshot.json.gz"]);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("publishRelease: refuses to publish with zero assets", async () => {
  await assert.rejects(
    () => publishRelease({ tag: "t", title: "t", notes: "n", assets: [], exec: async () => {} }),
    (err) => err instanceof PublishError && err.code === "NO_ASSETS",
  );
});

/* OPS-03 (issue #969): publishRelease is draft -> chunked uploads -> publish.
   `fakeGh` answers `view` from `viewState` (a thrown "release not found" when
   null), records every call, and makes the first `uploadFails` upload calls
   throw `uploadError`. `pauseMs: 0` in most tests keeps the between-chunk
   pacing out of the sleep log; the pacing test asserts it on its own.
   `view` answers in the shape the real call's --jq projection prints:
   `assets: [{ name, state }]`; a bare name in a test's viewState is
   shorthand for a fully uploaded asset. */
const asView = (v) => ({ ...v, assets: (v.assets ?? []).map((a) => (typeof a === "string" ? { name: a, state: "uploaded" } : a)) });
function fakeGh({ viewState = null, uploadFails = 0, uploadError } = {}) {
  const calls = [];
  let failed = 0;
  const exec = async (cmd, args) => {
    assert.equal(cmd, "gh");
    assert.equal(args[0], "release");
    calls.push(args);
    // A retry loop with no cap spins on microtasks (the fake and the
    // recording sleep never yield to a timer), so --test-timeout cannot stop
    // it and it eats memory until the machine kills it. This throw is caught
    // by the retry loop itself, so recordingSleep below carries the guard
    // that escapes it (a sleep runs inside the catch block).
    if (calls.length > 200) throw new Error("fakeGh: runaway — more than 200 gh calls");
    if (args[1] === "view") {
      if (viewState === null) { const e = new Error("not found"); e.stderr = "release not found"; throw e; }
      return { stdout: JSON.stringify(asView(viewState)) };
    }
    if (args[1] === "upload" && failed < uploadFails) {
      failed++;
      throw uploadError ?? Object.assign(new Error("Command failed: gh release upload"), { code: 1, stderr: "EOF" });
    }
    return { stdout: "" };
  };
  const verbs = () => calls.map((a) => a[1]);
  const gz = (args) => args.filter((x) => x.endsWith(".json.gz"));
  return { exec, calls, verbs, gz };
}
const recordingSleep = (log) => async (ms) => {
  log.push(ms);
  if (log.length > 100) throw new Error("recordingSleep: runaway retry loop — more than 100 sleeps");
};

/* MUTATIONS: drop `--draft` from the create call -> red (slice(0,4)); upload
   everything in one call -> red (verbs + the [10,10,5] chunk sizes). */
test("publishRelease: creates a draft with no assets, uploads in chunks of chunkSize, then publishes", async () => {
  const gh = fakeGh();
  const sleeps = [];
  const assets = Array.from({ length: 25 }, (_, i) => `/tmp/out/shards/${String(i).padStart(2, "0")}.json.gz`);
  const result = await publishRelease({
    tag: "shows-index-v1", title: "Shows index v1", notes: "notes", assets, exec: gh.exec, repo: "org/repo",
    chunkSize: 10, sleep: recordingSleep(sleeps), pauseMs: 0,
  });
  assert.deepEqual(gh.verbs(), ["view", "create", "upload", "upload", "upload", "edit"]);

  const create = gh.calls[1];
  assert.deepEqual(create.slice(0, 4), ["release", "create", "shows-index-v1", "--draft"]);
  for (const flag of ["--repo", "org/repo", "--title", "Shows index v1", "--notes", "notes"]) assert.ok(create.includes(flag), flag);
  assert.equal(gh.gz(create).length, 0, "the draft is created with NO asset paths");

  const uploads = gh.calls.filter((a) => a[1] === "upload");
  assert.deepEqual(uploads.map((a) => gh.gz(a).length), [10, 10, 5]);
  assert.deepEqual(uploads.flatMap((a) => gh.gz(a)), assets, "every asset exactly once, in order");
  for (const u of uploads) {
    assert.deepEqual(u.slice(0, 3), ["release", "upload", "shows-index-v1"]);
    assert.ok(u.includes("--clobber") && u.includes("--repo") && u.includes("org/repo"));
  }

  assert.deepEqual(gh.calls[5], ["release", "edit", "shows-index-v1", "--draft=false", "--repo", "org/repo"]);
  assert.deepEqual(sleeps, [], "no failures and pauseMs 0 -> nothing slept");
  assert.deepEqual(result, {
    tag: "shows-index-v1",
    asset_base_url: "https://github.com/org/repo/releases/download/shows-index-v1",
    uploaded: 25,
    resumed: false,
  });
});

/* The sustained-rate guard from OPS-02's verdict: gh bursts at ~500
   uploads/min and GitHub cuts it off; 10 files per 7.5 s keeps the run at
   or under GitHub's documented 80 content-creating requests/min even if an
   upload took no time. MUTATION: pause after every chunk including the
   last -> red ([7500,7500,7500]); never pause -> red; `pauseMs = 5000`
   (the old 120/min default) -> red. */
test("publishRelease: pauses pauseMs between chunks and never after the last one", async () => {
  const gh = fakeGh();
  const sleeps = [];
  const assets = Array.from({ length: 25 }, (_, i) => `/x/${i}.json.gz`);
  await publishRelease({ tag: "t", title: "T", notes: "N", assets, exec: gh.exec, repo: "org/repo", chunkSize: 10, sleep: recordingSleep(sleeps) });
  assert.deepEqual(sleeps, [7500, 7500], "the default pauseMs between 3 chunks");

  const one = fakeGh();
  const sleepsOne = [];
  await publishRelease({ tag: "t", title: "T", notes: "N", assets: assets.slice(0, 10), exec: one.exec, repo: "org/repo", sleep: recordingSleep(sleepsOne) });
  assert.deepEqual(sleepsOne, [], "a single chunk never pauses");
});

/* MUTATION: ignore `assetNames` (upload everything) -> red. */
test("publishRelease: a stranded draft is resumed — only the missing assets are uploaded, then it is published", async () => {
  const gh = fakeGh({ viewState: { isDraft: true, assets: ["a.json.gz", "b.json.gz"] } });
  const result = await publishRelease({
    tag: "t", title: "T", notes: "N", assets: ["/x/a.json.gz", "/x/b.json.gz", "/x/c.json.gz"],
    exec: gh.exec, repo: "org/repo", sleep: recordingSleep([]), pauseMs: 0,
  });
  assert.deepEqual(gh.verbs(), ["view", "upload", "edit"], "no create for an existing draft");
  assert.deepEqual(gh.gz(gh.calls[1]), ["/x/c.json.gz"]);
  assert.ok(gh.calls[2].includes("--draft=false"));
  assert.equal(result.resumed, true);
  assert.equal(result.uploaded, 1);

  // A draft that already carries every asset is just published.
  const full = fakeGh({ viewState: { isDraft: true, assets: ["a.json.gz"] } });
  const r2 = await publishRelease({ tag: "t", title: "T", notes: "N", assets: ["/x/a.json.gz"], exec: full.exec, repo: "org/repo" });
  assert.deepEqual(full.verbs(), ["view", "edit"]);
  assert.deepEqual([r2.uploaded, r2.resumed], [0, true]);
});

/* MUTATION: delete the `if (st.state === "published") return ...` early return -> upload + edit are called (red). */
test("publishRelease: a published release is left alone", async () => {
  const gh = fakeGh({ viewState: { isDraft: false, assets: ["a.json.gz"] } });
  const result = await publishRelease({
    tag: "t", title: "T", notes: "N", assets: ["/x/a.json.gz", "/x/z.json.gz"], exec: gh.exec, repo: "org/repo",
  });
  assert.deepEqual(gh.verbs(), ["view"], "no create, upload or edit against a published release");
  assert.deepEqual(result, { tag: "t", asset_base_url: assetBaseUrlFor("t", "org/repo"), uploaded: 0, resumed: false });
});

/* MUTATION: no retry loop -> the first scenario rejects (red); retry for ever
   -> the second never rejects (red). */
test("publishRelease: an upload that fails twice and succeeds on the third try still publishes; with attempts 2 a third failure throws", async () => {
  const sleeps = [];
  const gh = fakeGh({ uploadFails: 2 });
  const result = await publishRelease({
    tag: "t", title: "T", notes: "N", assets: ["/x/a.json.gz"], exec: gh.exec, repo: "org/repo", sleep: recordingSleep(sleeps),
  });
  assert.deepEqual(gh.verbs(), ["view", "create", "upload", "upload", "upload", "edit"]);
  assert.deepEqual(sleeps, [5000, 10000]);
  assert.equal(result.uploaded, 1);

  const boom = Object.assign(new Error("Command failed: gh release upload t /x/a.json.gz"), { code: 1, stderr: "EOF" });
  const sleeps2 = [];
  const gh2 = fakeGh({ uploadFails: Infinity, uploadError: boom });
  await assert.rejects(
    () => publishRelease({
      tag: "t", title: "T", notes: "N", assets: ["/x/a.json.gz"], exec: gh2.exec, repo: "org/repo",
      attempts: 2, sleep: recordingSleep(sleeps2),
    }),
    (err) => err === boom, // rethrown UNCHANGED, so run-and-publish's FATAL lines print its real stderr
  );
  assert.deepEqual(gh2.verbs(), ["view", "create", "upload", "upload"], "no edit: the draft stays for the next run to resume");
  assert.deepEqual(sleeps2, [5000]);
});

/* The exact error OPS-02 read off runs 36852145618 / 36853224459. The
   message itself says "wait a few minutes"; GitHub's guidance for a
   secondary limit is at least a minute, then exponential backoff. So a
   rate-limited chunk waits 1, 2, 4, 8 minutes, on its OWN budget of 5 tries
   (the generic `attempts: 3` would give up after 3 minutes).
   MUTATIONS: treat it like any other failure -> [5000, 10000] and a throw on
   the 3rd (red); a constant wait (`RATE_LIMIT_WAITS_MS[0]` every time) ->
   red; count rate-limited tries against `attempts` -> the 4-failure scenario
   rejects (red). */
test("publishRelease: a rate-limited chunk backs off 1, 2, 4, 8 minutes on its own budget, then gives up with the original error", async () => {
  const limited = Object.assign(new Error("Command failed: gh release upload t"), {
    code: 1,
    stderr: "HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. "
      + "(https://uploads.github.com/repos/org/repo/releases/400881909/assets?label=&name=eh.json.gz)",
  });
  assert.deepEqual(RATE_LIMIT_WAITS_MS, [60_000, 120_000, 240_000, 480_000]);
  const sleeps = [];
  const lines = [];
  const gh = fakeGh({ uploadFails: 4, uploadError: limited });
  const result = await publishRelease({
    tag: "t", title: "T", notes: "N", assets: ["/x/eh.json.gz"], exec: gh.exec, repo: "org/repo",
    sleep: recordingSleep(sleeps), log: (l) => lines.push(l),
  });
  assert.deepEqual(sleeps, RATE_LIMIT_WAITS_MS);
  assert.deepEqual(gh.verbs(), ["view", "create", "upload", "upload", "upload", "upload", "upload", "edit"]);
  assert.equal(result.uploaded, 1);
  assert.equal(lines.filter((l) => l.startsWith("RETRY: t chunk 1/1 in ")).length, 4);
  assert.match(lines[0], /RETRY: t chunk 1\/1 in 60 s — HTTP 403: You have exceeded a secondary rate limit/);

  // Five rate-limited tries in a row: the original error, unchanged, and the draft is left for a resume.
  const sleeps2 = [];
  const gh2 = fakeGh({ uploadFails: Infinity, uploadError: limited });
  await assert.rejects(
    () => publishRelease({ tag: "t", title: "T", notes: "N", assets: ["/x/eh.json.gz"], exec: gh2.exec, repo: "org/repo", sleep: recordingSleep(sleeps2) }),
    (err) => err === limited,
  );
  assert.deepEqual(sleeps2, RATE_LIMIT_WAITS_MS);
  assert.equal(gh2.verbs().filter((v) => v === "upload").length, 5);
  assert.ok(!gh2.verbs().includes("edit"));

  // The primary limit's wording waits the long way too.
  const primary = Object.assign(new Error("Command failed"), { code: 1, stderr: "HTTP 403: API rate limit exceeded for installation ID 1." });
  const sleeps3 = [];
  await publishRelease({
    tag: "t", title: "T", notes: "N", assets: ["/x/a.json.gz"], exec: fakeGh({ uploadFails: 1, uploadError: primary }).exec, repo: "org/repo",
    sleep: recordingSleep(sleeps3),
  });
  assert.deepEqual(sleeps3, [60_000]);
});

test("assetBaseUrlFor: derives the same URL shape publishRelease returns, with no gh call needed", () => {
  // This is what run-and-publish.mjs's reconciliation path relies on: a
  // release that already exists (published on a PRIOR run) still needs its
  // asset base URL to build the pointer, with no `gh` call at all.
  assert.equal(
    assetBaseUrlFor("shows-index-v1", "org/repo"),
    "https://github.com/org/repo/releases/download/shows-index-v1",
  );
});

test("buildPointer: shapes the config-value payload the client reads", () => {
  const pointer = buildPointer({
    tag: "shows-index-v1",
    assetBaseUrl: "https://github.com/org/repo/releases/download/shows-index-v1",
    exportVersion: "local:abc123",
    manifest: { counts: { read: 10, in_4a: 8, canonical: 7 } },
    publishedAt: "2026-09-05T00:00:00.000Z",
  });
  assert.deepEqual(pointer, {
    version: 2,
    export_version: "local:abc123",
    release_tag: "shows-index-v1",
    asset_base_url: "https://github.com/org/repo/releases/download/shows-index-v1",
    manifest_url: "https://github.com/org/repo/releases/download/shows-index-v1/manifest.json",
    published_at: "2026-09-05T00:00:00.000Z",
    counts: { read: 10, in_4a: 8, canonical: 7 },
    shards_published: false,
    shard_releases: [],
  });
});

/* Audit round 3, arch-drift-7: POINTER_SCHEMA_VERSION was exported and never
   read while buildPointer wrote a literal 1, so the S-04c shard shape carried
   the same version as the pointer before it. MUTATION: put `version: 1` back
   in buildPointer -- both assertions fail. */
test("buildPointer: writes POINTER_SCHEMA_VERSION, which is 2 for the shard-range shape", async () => {
  const { POINTER_SCHEMA_VERSION } = await import("./config.mjs");
  assert.equal(POINTER_SCHEMA_VERSION, 2);
  const pointer = buildPointer({ tag: "t", assetBaseUrl: "https://x", exportVersion: "v", manifest: {}, shardReleases: [{ tag: "t-1" }], shardsPublished: true });
  assert.equal(pointer.version, POINTER_SCHEMA_VERSION);
  assert.ok("shard_releases" in pointer && "shards_published" in pointer);
});

/* ==================================================================== */
/* S-04c: shard batch release publishing                                 */
/* ==================================================================== */

test("partitionShardBatches: splits a sorted inventory into batches of at most maxPerBatch, in key order", () => {
  const inventory = [
    { key: "cc", row_count: 1, gz_bytes: 1 },
    { key: "aa", row_count: 1, gz_bytes: 1 },
    { key: "bb", row_count: 1, gz_bytes: 1 },
    { key: "dd", row_count: 1, gz_bytes: 1 },
  ];
  const batches = partitionShardBatches(inventory, 2);
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[0].map((e) => e.key), ["aa", "bb"]);
  assert.deepEqual(batches[1].map((e) => e.key), ["cc", "dd"]);
});

test("partitionShardBatches: an inventory under one batch's size produces exactly one batch", () => {
  const inventory = [{ key: "aa", row_count: 1, gz_bytes: 1 }];
  const batches = partitionShardBatches(inventory, 900);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 1);
});

test("partitionShardBatches: an empty inventory produces zero batches", () => {
  assert.deepEqual(partitionShardBatches([], 900), []);
});

test("shardReleaseTagFor: deterministic, 1-based in the tag, 0-based as the argument", () => {
  assert.equal(shardReleaseTagFor("shows-index-v1", 0), "shows-index-v1-shards-1");
  assert.equal(shardReleaseTagFor("shows-index-v1", 1), "shows-index-v1-shards-2");
});

/* MUTATION: in publishRelease, `if (st.state === "absent")` -> `if (false)`
   (never create the draft) -> the verb list lacks "create" (red). */
test("publishShardReleases: creates one release per batch and reports first/last key ranges", async () => {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push(args);
    if (args[0] === "release" && args[1] === "view") {
      const e = new Error("not found"); e.stderr = "release not found"; throw e;
    }
    return { stdout: "created" };
  };
  const inventory = [
    { key: "aa", row_count: 1, gz_bytes: 1 },
    { key: "bb", row_count: 1, gz_bytes: 1 },
    { key: "cc", row_count: 1, gz_bytes: 1 },
  ];
  const releases = await publishShardReleases({
    baseTag: "shows-index-v1", outDir: "/tmp/out", shardInventory: inventory, exec, repo: "org/repo", maxPerBatch: 2,
  });
  // maxPerBatch isn't an accepted publishShardReleases param — this call
  // exercises the DEFAULT (config.mjs's MAX_SHARD_ASSETS_PER_RELEASE, 900),
  // so 3 keys land in exactly one batch/one release.
  assert.equal(releases.length, 1);
  assert.equal(releases[0].tag, "shows-index-v1-shards-1");
  assert.equal(releases[0].first_key, "aa");
  assert.equal(releases[0].last_key, "cc");
  assert.equal(releases[0].count, 3);
  assert.equal(releases[0].asset_base_url, "https://github.com/org/repo/releases/download/shows-index-v1-shards-1");
  // OPS-03: draft -> one upload (3 assets < chunkSize 10) -> publish.
  const batchCalls = calls.filter((a) => a[2] === "shows-index-v1-shards-1");
  assert.deepEqual(
    batchCalls.map((a) => [a[0], a[1]]),
    [["release", "view"], ["release", "create"], ["release", "upload"], ["release", "edit"]],
  );
  const [, createCall, uploadCall, editCall] = batchCalls;
  assert.ok(createCall.includes("--draft"));
  assert.ok(!createCall.some((a) => a.endsWith(".json.gz")), "the draft is created with no shard paths");
  assert.ok(uploadCall.includes(join("/tmp/out", "shards", "aa.json.gz")));
  assert.ok(uploadCall.includes(join("/tmp/out", "shards", "bb.json.gz")));
  assert.ok(uploadCall.includes(join("/tmp/out", "shards", "cc.json.gz")));
  assert.ok(editCall.includes("--draft=false"));
});

/* MUTATION: delete publishRelease's `if (st.state === "published") return ...`
   -> the published batch is topped up with the missing bb shard (red).
   (Deleting publishShardReleases' own SKIP branch survives this test on its
   own: the published state flows into publishRelease, which returns early —
   the second guard, which is the one pinned here.) */
test("publishShardReleases: an already-existing batch release is skipped, not re-uploaded", async () => {
  const created = [];
  const uploads = [];
  const exec = async (cmd, args) => {
    if (args[0] === "release" && args[1] === "view") {
      return { stdout: JSON.stringify({ isDraft: false, assets: [{ name: "aa.json.gz", state: "uploaded" }] }) }; // every batch already published
    }
    if (args[0] === "release" && args[1] === "create") {
      created.push(args[2]);
      return { stdout: "created" };
    }
    if (args[0] === "release" && args[1] === "upload") uploads.push(args);
    return { stdout: "" };
  };
  const inventory = [{ key: "aa", row_count: 1, gz_bytes: 1 }, { key: "bb", row_count: 1, gz_bytes: 1 }];
  const releases = await publishShardReleases({
    baseTag: "shows-index-v1", outDir: "/tmp/out", shardInventory: inventory, exec, repo: "org/repo",
  });
  assert.equal(releases.length, 1);
  assert.equal(created.length, 0, "no gh release create call for an already-existing batch");
  assert.equal(uploads.length, 0, "a published batch is never topped up, even when it lacks a shard");
});

/* THE #969 FIX ITSELF at the batch level: a run that died part-way through
   batch 1 left it as a draft holding some shards. The next run must RESUME
   it — upload only the missing shards, then publish — not skip it as
   "existing" (a half-full batch for ever) and not create a second release.
   MUTATION: in publishShardReleases, `if (state.state === "published")` ->
   `if (state.state !== "absent")` -> the draft is skipped: no upload, no
   edit (red). */
test("publishShardReleases: a stranded draft batch is resumed — only its missing shards are uploaded, then it is published", async () => {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push(args);
    if (args[1] === "view") {
      return { stdout: JSON.stringify({ isDraft: true, assets: [{ name: "aa.json.gz", state: "uploaded" }] }) };
    }
    return { stdout: "" };
  };
  const lines = [];
  const inventory = ["aa", "bb", "cc"].map((key) => ({ key, row_count: 1, gz_bytes: 1 }));
  const releases = await publishShardReleases({
    baseTag: "shows-index-v1", outDir: "/tmp/out", shardInventory: inventory, exec, repo: "org/repo", log: (l) => lines.push(l),
  });
  assert.deepEqual(calls.map((a) => a[1]), ["view", "upload", "edit"], "no create for the existing draft, one view only");
  assert.deepEqual(calls[1].filter((a) => a.endsWith(".json.gz")), [join("/tmp/out", "shards", "bb.json.gz"), join("/tmp/out", "shards", "cc.json.gz")]);
  assert.ok(calls[2].includes("--draft=false"));
  assert.ok(lines.some((l) => l.startsWith("RESUME: shard release shows-index-v1-shards-1 is a stranded draft with 1/3")));
  assert.ok(lines.some((l) => l.startsWith("PUBLISHED: shows-index-v1-shards-1 (3 shard assets")));
  assert.equal(releases[0].count, 3);
});

test("publishShardReleases: an empty shard inventory publishes zero releases", async () => {
  const exec = async () => { throw new Error("must not be called"); };
  const releases = await publishShardReleases({
    baseTag: "shows-index-v1", outDir: "/tmp/out", shardInventory: [], exec, repo: "org/repo",
  });
  assert.deepEqual(releases, []);
});
