/* tools/podcast/update-episode.mjs, offline (no audio: the "encodes" are a few bytes).
 * Every test names the mutation it kills and RUNS it: the module's source is
 * rewritten in memory, imported from a temp file, and the check must fail on the
 * mutant while passing on the real module ("SURVIVED" otherwise). */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as real from "./update-episode.mjs";
import { validate } from "./build-feed.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const SRC = fs.readFileSync(path.join(HERE, "update-episode.mjs"), "utf8");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "upd-mut-"));
let n = 0;

async function mutant(from, to) {
  assert.ok(SRC.includes(from), `mutation anchor not found: ${from}`);
  const file = path.join(TMP, `m${n++}.mjs`);
  /* The copy lives in a temp dir, so its one relative import is pinned to the real file. */
  const entry = JSON.stringify(pathToFileURL(path.join(HERE, "..", "ci", "entry.mjs")).href);
  fs.writeFileSync(file, SRC.replace(from, to).replace('"../ci/entry.mjs"', entry));
  return import(pathToFileURL(file).href);
}

async function kills(from, to, check) {
  check(real);
  const m = await mutant(from, to);
  assert.throws(() => check(m), undefined, `SURVIVED: ${from} -> ${to}`);
}

const GUID = "92b1a9a9-69ef-4f8c-a554-fef5b6948b17";
const SHA_A = "d2c89d52b10470f7ec1eb853e97e5c34e5791fcf6de7fc4e4af9585144028ec2";
const SHA_B = "1624ce7ed7090d3706c5ce0d54e35bebf4a96904ce6db0ec1d87b2eb2b7668e0";
const manifest = () => ({ _readme: "r", episodes: [{ guid: GUID, foray_id: "f1", status: "draft", pub_date: null, title: "T", duration_sec: 1, audio: [], chapters: [], sources: [{ show: "S" }] }] });
const report = (o = {}) => ({ duration_sec: 1965.36, chapters: [{ start: 0, title: "Intro" }, { start: 32.99, title: "Next" }], final: { "x.mp3": {}, "x.m4a": {} }, true_peak_ok: true, ...o });
const files = () => ({ mp3: { bytes: 31448367, sha256: SHA_A }, m4a: { bytes: 31382918, sha256: SHA_B } });

test("the committed flagship manifest is a fixed point: its own audio + chapters in, the same entry out; mutation: key cut to 11 hex chars", async () => {
  const committed = JSON.parse(fs.readFileSync(path.join(ROOT, "data/podcast/episodes.json"), "utf8"));
  const ep = committed.episodes.find((e) => e.foray_id === "asteroids-flagship-1");
  const f = Object.fromEntries(ep.audio.map((a) => [a.format, { bytes: a.bytes, sha256: a.sha256 }]));
  const rep = { duration_sec: ep.duration_sec, chapters: ep.chapters.map((c) => ({ start: c.start_sec, title: c.title })) };
  const check = (m) => assert.deepEqual(m.updateManifest(committed, "asteroids-flagship-1", rep, f), committed);
  await kills("sha256.slice(0, 12)", "sha256.slice(0, 11)", check);
});

test("chapter starts are floored to whole seconds, never rounded up past the audio; mutation: Math.round", async () => {
  const check = (m) => assert.deepEqual(m.chaptersFromReport(report()), [{ start_sec: 0, title: "Intro" }, { start_sec: 32, title: "Next" }]);
  await kills("Math.floor(c.start)", "Math.round(c.start)", check);
});

test("the updated entry passes build-feed's published-episode validation (content-addressed keys, mp3 present); mutation: sha256 upper-cased", async () => {
  const check = (m) => {
    const next = m.updateManifest(manifest(), "f1", report(), files());
    const ep = { ...next.episodes[0], status: "published", pub_date: "2026-10-20T12:00:00Z", summary: "s", description: "<p>S</p>" };
    const channel = { title: "t", author: "a", description: "d", language: "en", podcast_guid: GUID, categories: [{ name: "Science" }], explicit: false };
    const problems = validate(channel, [ep], { publishReady: false }).filter((p) => /audio|sha256|key|mp3|content-addressed/.test(p));
    assert.deepEqual(problems, []);
    assert.deepEqual(ep.audio.map((a) => a.format), ["mp3", "m4a"]);
  };
  await kills("return { format, type, bytes: f.bytes, sha256: f.sha256,", "return { format, type, bytes: f.bytes, sha256: f.sha256.toUpperCase(),", check);
});

test("a render whose true-peak check failed is not recorded; mutation: the guard removed", async () => {
  const check = (m) => assert.throws(() => m.updateManifest(manifest(), "f1", report({ true_peak_ok: false }), files()), /true-peak/);
  await kills("if (report.true_peak_ok === false) throw", "if (false) throw", check);
});

test("an unknown Foray, a missing encode and an empty encode are refused; mutation: the empty-file guard removed", async () => {
  const check = (m) => {
    assert.throws(() => m.updateManifest(manifest(), "nope", report(), files()), /no episode for Foray nope/);
    assert.throws(() => m.updateManifest(manifest(), "f1", report(), { mp3: files().mp3 }), /no m4a file/);
    assert.throws(() => m.updateManifest(manifest(), "f1", report(), { ...files(), m4a: { bytes: 0, sha256: SHA_B } }), /m4a is empty/);
  };
  await kills("if (!(f.bytes > 0)) throw", "if (false) throw", check);
});

test("only audio, duration and chapters change; guid, status, show notes survive and the input is not mutated; mutation: the spread of the old entry dropped", async () => {
  const check = (m) => {
    const before = manifest();
    const snapshot = JSON.stringify(before);
    const next = m.updateManifest(before, "f1", report(), files());
    assert.equal(JSON.stringify(before), snapshot);
    assert.equal(next.episodes[0].guid, GUID);
    assert.equal(next.episodes[0].status, "draft");
    assert.deepEqual(next.episodes[0].sources, [{ show: "S" }]);
    assert.equal(next.episodes[0].duration_sec, 1965.36);
  };
  await kills("{ ...ep, duration_sec: report.duration_sec", "{ duration_sec: report.duration_sec", check);
});

test("the CLI hashes the real files on disk and writes the manifest (and --dry-run does not); mutation: --dry-run ignored", async () => {
  const check = (m) => {
    const dir = fs.mkdtempSync(path.join(TMP, "cli-"));
    fs.writeFileSync(path.join(dir, "x.mp3"), "mp3-bytes");
    fs.writeFileSync(path.join(dir, "x.m4a"), "m4a-bytes!");
    fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(report()));
    const mf = path.join(dir, "episodes.json");
    fs.writeFileSync(mf, JSON.stringify(manifest(), null, 2) + "\n");
    const log = console.log;
    console.log = () => {};
    try {
      assert.equal(m.main(["f1", "--dir", dir, "--manifest", mf, "--dry-run"]), 0);
      assert.deepEqual(JSON.parse(fs.readFileSync(mf, "utf8")).episodes[0].audio, []);
      assert.equal(m.main(["f1", "--dir", dir, "--manifest", mf]), 0);
    } finally { console.log = log; }
    const ep = JSON.parse(fs.readFileSync(mf, "utf8")).episodes[0];
    assert.equal(ep.audio[0].bytes, 9);
    assert.equal(ep.audio[1].bytes, 10);
    assert.equal(ep.audio[0].sha256, crypto.createHash("sha256").update("mp3-bytes").digest("hex"));
    assert.match(ep.audio[0].key, new RegExp(`^episodes/${GUID}/${ep.audio[0].sha256.slice(0, 12)}\\.mp3$`));
  };
  await kills("if (a.dryRun) console.log(", "if (true) console.log(", check);
});
