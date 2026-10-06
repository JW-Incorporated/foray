/* PKG-32 (docs/roadmap/corpus.md): corpus catalogue artifacts published as
   a GitHub Release plus a pointer. Every `gh` call goes to a fake `exec`
   that records its argv; `gh release view` answers either a release JSON or
   the `release not found` stderr releaseState reads as absent. Each test
   builds its own version directory, catalogue and pointer path under a tmp
   root, so the suite never reads or writes data/, never touches the network
   and never runs the real `gh`. No credential is read. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { gunzipSync } from "node:zlib";

import { assetBaseUrlFor } from "../shows/publish-release.mjs";
import { ASSET_NAMES, assetsFor, corpusTagFor, publishCorpus } from "./publish-release.mjs";

const EXPORT_VERSION = "2026-10-06T12:00:00.000Z";
const VERSION_DIR_NAME = "2026-10-06T12-00-00.000Z";
const COUNTS = { shows: 2, episodes: 5, timed_transcript_episodes: 3, audio_episodes: 4, feeds_known: 2, feeds_crawled: 1, inserts_30d: 5 };
const SHOWS_JSONL = '{"corpus_podcast_id":"p-0001","title":"Synthetic A"}\n{"corpus_podcast_id":"p-0002","title":"Synthetic B"}\n';
const CATALOGUE = '{"version":1,"built_at":"2026-10-06T12:00:00.000Z","shows":[{"apple_collection_id":111,"title":"Synthetic A"}]}\n';
const FAKE_REPO = "example-org/example-repo";

/** A tmp root holding an export version directory, a catalogue file and a
    (not yet written) pointer path, shaped like export.mjs's layout. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pkg32-test-"));
  const versionDir = join(root, "corpus-export", VERSION_DIR_NAME);
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(join(versionDir, "shows.jsonl"), SHOWS_JSONL);
  writeFileSync(
    join(versionDir, "manifest.json"),
    JSON.stringify({ version: 1, export_version: EXPORT_VERSION, built_at: EXPORT_VERSION, counts: COUNTS, files: [{ path: "shows.jsonl", rows: 2 }] }, null, 2) + "\n",
  );
  const catalogPath = join(root, "corpus-export", "catalog-breadth-corpus.json");
  writeFileSync(catalogPath, CATALOGUE);
  const pointerPath = join(root, "data", "corpus-catalogue-pointer.json");
  return { root, versionDir, catalogPath, pointerPath };
}

/** A fake `gh`: records every argv; `release view` answers `view`
    (an object -> JSON stdout, null -> the 404 stderr). */
function fakeGh(view) {
  const calls = [];
  const exec = async (cmd, args) => {
    assert.equal(cmd, "gh");
    calls.push(args);
    if (args[0] === "release" && args[1] === "view") {
      if (view === null) {
        const err = new Error("gh failed");
        err.stderr = "release not found";
        throw err;
      }
      return { stdout: JSON.stringify(view), stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  return { exec, calls };
}

const quiet = () => {};
const opts = (fx, gh) => ({
  versionDir: fx.versionDir,
  catalogPath: fx.catalogPath,
  pointerPath: fx.pointerPath,
  repo: FAKE_REPO,
  exec: gh.exec,
  sleep: async () => {},
  pauseMs: 0,
  now: () => new Date("2026-10-06T13:00:00.000Z"),
  log: quiet,
});

/** Every file under `dir`, relative, with its size. */
function tree(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(`${relative(dir, full)}:${statSync(full).size}`);
    }
  };
  walk(dir);
  return out.sort();
}

// Mutation: in publishCorpus pass `state: { state: "absent", assetNames: [] }`
// to publishRelease instead of releaseState's answer (ignore the published
// release) -> a `gh release create` call appears and this goes red.
test("a release that is already published gets no release create, upload or edit; one gh release view only", async () => {
  const fx = fixture();
  try {
    const gh = fakeGh({ isDraft: false, assets: ASSET_NAMES.map((name) => ({ name, state: "uploaded" })) });
    const r = await publishCorpus(opts(fx, gh));
    assert.equal(r.published, false);
    assert.deepEqual(gh.calls.map((a) => a.slice(0, 2).join(" ")), ["release view"]);
    assert.ok(!gh.calls.some((a) => a[1] === "create"), "no gh release create");
    assert.equal(r.tag, corpusTagFor(EXPORT_VERSION));
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

// Mutation: drop catalog-breadth-corpus.json.gz from assetsFor's return (or
// upload the uncompressed shows.jsonl instead of shows.jsonl.gz) -> the
// uploaded basename set differs and this goes red.
test("an absent release is created as a draft, gets exactly the three assets, then is published", async () => {
  const fx = fixture();
  try {
    const gh = fakeGh(null);
    const r = await publishCorpus(opts(fx, gh));
    assert.equal(r.published, true);
    const tag = corpusTagFor(EXPORT_VERSION);
    assert.deepEqual(gh.calls.map((a) => a.slice(0, 2).join(" ")), ["release view", "release create", "release upload", "release edit"]);
    const upload = gh.calls.find((a) => a[1] === "upload");
    assert.equal(upload[2], tag);
    const paths = upload.slice(3, upload.indexOf("--repo"));
    assert.deepEqual(paths.map((p) => basename(p)).sort(), ["catalog-breadth-corpus.json.gz", "manifest.json", "shows.jsonl.gz"]);
    assert.equal(paths.length, 3);
    assert.ok(gh.calls.find((a) => a[1] === "create").includes("--draft"));
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

// Mutation: build the pointer's URLs from a hard-coded
// `https://github.com/JW-Incorporated/foray/releases/download/` instead of
// assetBaseUrlFor(tag, repo) (or swap catalogue_url and shows_url) -> red.
test("the pointer names the tag and every URL derives from it via assetBaseUrlFor", async () => {
  const fx = fixture();
  try {
    const gh = fakeGh(null);
    await publishCorpus(opts(fx, gh));
    const pointer = JSON.parse(readFileSync(fx.pointerPath, "utf8"));
    const tag = "corpus-export-2026-10-06t12-00-00-000z";
    assert.equal(corpusTagFor(EXPORT_VERSION), tag);
    const base = assetBaseUrlFor(tag, FAKE_REPO);
    assert.deepEqual(pointer, {
      version: 1,
      export_version: EXPORT_VERSION,
      release_tag: tag,
      asset_base_url: base,
      manifest_url: `${base}/manifest.json`,
      catalogue_url: `${base}/catalog-breadth-corpus.json.gz`,
      shows_url: `${base}/shows.jsonl.gz`,
      published_at: "2026-10-06T13:00:00.000Z",
      counts: COUNTS,
    });
    assert.ok(!existsSync(`${fx.pointerPath}.tmp`), "tmp file renamed away");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

// Mutation: in publishCorpus drop the `if (dryRun)` early return (or write
// the pointer before it) -> the pointer file appears, gh is called, and this
// goes red.
test("--dry-run makes no gh call and writes nothing outside tmp (no pointer, version dir untouched)", async () => {
  const fx = fixture();
  try {
    const before = tree(fx.root);
    const gh = fakeGh(null);
    const r = await publishCorpus({ ...opts(fx, gh), dryRun: true });
    assert.equal(r.dryRun, true);
    assert.deepEqual(gh.calls, []);
    assert.ok(!existsSync(fx.pointerPath));
    assert.deepEqual(tree(fx.root), before);
    assert.deepEqual(r.assets, [...ASSET_NAMES]);
    assert.match(r.prCommand, /^gh pr create --draft /);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

// Mutation: write the "gz" files with a plain copy instead of
// pipeline(createGzip) (or gzip the wrong source) -> gunzipSync throws or
// the bytes differ, and this goes red.
test("shows.jsonl.gz and catalog-breadth-corpus.json.gz gunzip back to the exact source bytes, staged outside the version dir", async () => {
  const fx = fixture();
  const staging = mkdtempSync(join(tmpdir(), "pkg32-stage-"));
  try {
    const assets = await assetsFor(fx.versionDir, { catalogPath: fx.catalogPath, stagingDir: staging });
    assert.deepEqual(assets.map((p) => basename(p)), [...ASSET_NAMES]);
    assert.equal(assets[0], join(fx.versionDir, "manifest.json"));
    assert.equal(gunzipSync(readFileSync(assets[1])).toString("utf8"), SHOWS_JSONL);
    assert.equal(gunzipSync(readFileSync(assets[2])).toString("utf8"), CATALOGUE);
    assert.deepEqual(readdirSync(fx.versionDir).sort(), ["manifest.json", "shows.jsonl"]);
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(fx.root, { recursive: true, force: true });
  }
});
