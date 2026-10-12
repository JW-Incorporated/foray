/* GV-23 (W3-02, docs/roadmap/generation-v2.md): legacy whisper JSONs at the
   R2 bucket root. Offline only: the fixtures under
   fixtures/synthetic/legacy-whisper/ are invented sentences, never real
   transcript text, and the sampler runs against a fake S3 client (the
   command classes are injected fakes named like the SDK's, as in
   sync-r2.test.mjs), so no network, no credential and no node_modules. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyKey } from "./inventory.mjs";
import {
  LegacyShapeError,
  MAX_SAMPLE_N,
  SAMPLE_REPORT_NAME,
  convertWhisperDoc,
  guidHashes,
  parseLegacyKey,
  parseSampleArgs,
  resolveLegacyEpisode,
  sampleLegacy,
  toNormalizedBody,
} from "./legacy-whisper.mjs";
import { bodyShapeError } from "./sync-r2.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "synthetic", "legacy-whisper");
const fixtureText = (name) => readFileSync(join(FIXTURES, name), "utf8");
const fixture = (name) => JSON.parse(fixtureText(name));

/* sha1(guid)[:10], pinned (computed once with node:crypto). */
const H_0001 = "36948ec44f"; // "synthetic-guid-0001"
const H_0001_PADDED = "7153e4f652"; // " synthetic-guid-0001 " (untrimmed)
const H_0002 = "8f50d8159b"; // "synthetic-guid-0002"
/* A real 10-hex sha1 prefix collision between two distinct guids, found by a
   birthday search over "synthetic-ep-<n>" (full digests c0235ead3b041dc0...
   and c0235ead3bf0acae...). */
const TWIN_A = "synthetic-ep-96055";
const TWIN_B = "synthetic-ep-934986";
const H_TWIN = "c0235ead3b";

test("parseLegacyKey: the key table (accepts the documented shape, rejects farm, probe and hash-less keys) and agrees with inventory.mjs", () => {
  const accepted = [
    [`tide-tables/the-copper-kettle-${H_0001}.json`, { showSlug: "tide-tables", titleSlug: "the-copper-kettle", guidSha1_10: H_0001 }],
    [`tide-tables/${H_0002}.json`, { showSlug: "tide-tables", titleSlug: "", guidSha1_10: H_0002 }],
    [`9-lives/episode-12-part-2-${H_0002}.json`, { showSlug: "9-lives", titleSlug: "episode-12-part-2", guidSha1_10: H_0002 }],
  ];
  for (const [key, want] of accepted) {
    assert.deepEqual(parseLegacyKey(key), { key, ...want }, key);
  }
  const rejected = [
    `transcripts/normalized/470582/the-copper-kettle-${H_0001}.json`, // farm normalized body
    `transcripts/raw/470582/ep-${H_0001}.json`, // farm raw
    `transcript-originals/tide-tables/ep-${H_0001}.json`, // farm originals
    `_probe/write-test-${H_0001}.json`, // probe key
    `fingerprints/tide-tables/ep-${H_0001}.json.gz`, // fingerprints, not .json
    "tide-tables/the-copper-kettle.json", // no hash suffix
    "tide-tables/the-copper-kettle-36948ec4.json", // 8 hex
    "tide-tables/the-copper-kettle-36948EC44F.json", // upper-case hex
    "tide-tables/the-copper-kettle-36948ec44g.json", // not hex
    `tide-tables/the-copper-kettle-${H_0001}.vtt`, // not .json
    `the-copper-kettle-${H_0001}.json`, // no show directory
    `Tide-Tables/the-copper-kettle-${H_0001}.json`, // show slug is lower-case
    `-tide/the-copper-kettle-${H_0001}.json`, // show slug starts alphanumeric
    null,
    42,
  ];
  for (const key of rejected) assert.equal(parseLegacyKey(key), null, String(key));
  // inventory.mjs (GV-06) inlined foray-db's _KEY_RE before this card; the
  // two must agree on every key, or the size report and the indexer differ.
  for (const key of [...accepted.map(([k]) => k), ...rejected.filter((k) => typeof k === "string")]) {
    assert.equal(classifyKey(key) === "legacy-root", parseLegacyKey(key) !== null, `inventory/legacy disagree on ${key}`);
  }
});

test("guidHashes: sha1(guid)[:10] of the raw and the trimmed guid, deduped", () => {
  assert.deepEqual(guidHashes("synthetic-guid-0001"), [H_0001]);
  assert.deepEqual(guidHashes(" synthetic-guid-0001 "), [H_0001_PADDED, H_0001]);
  assert.deepEqual(guidHashes(TWIN_A), [H_TWIN]);
  assert.deepEqual(guidHashes(TWIN_B), [H_TWIN]);
  assert.deepEqual(guidHashes(null), []);
  assert.deepEqual(guidHashes(undefined), []);
});

test("resolveLegacyEpisode: matched by the raw or the trimmed hash, the title slug only reported", () => {
  const key = `tide-tables/the-copper-kettle-${H_0001}.json`;
  const r = resolveLegacyEpisode(key, [
    { guid: "synthetic-guid-0002", title: "The Copper Kettle" }, // title matches, hash does not
    { guid: " synthetic-guid-0001 ", title: "A Different Title" }, // padded in the feed: the trimmed hash hits
  ]);
  assert.deepEqual(r, { status: "matched", guid: " synthetic-guid-0001 ", reason: null, hits: [{ guid: " synthetic-guid-0001 ", titleSlugMatch: false }] });

  // The untrimmed hash hits too (the lane hashed the guid as it read it).
  const raw = resolveLegacyEpisode(`tide-tables/the-copper-kettle-${H_0001_PADDED}.json`, [{ guid: " synthetic-guid-0001 ", title: "The Copper Kettle!" }]);
  assert.equal(raw.status, "matched");
  assert.equal(raw.hits[0].titleSlugMatch, true);

  // An accent-folded title counts for the report; a key without a title slug reports null.
  assert.equal(resolveLegacyEpisode(`tide-tables/cafe-societe-${H_0002}.json`, [{ guid: "synthetic-guid-0002", title: "Café Société" }]).hits[0].titleSlugMatch, true);
  assert.equal(resolveLegacyEpisode(`tide-tables/${H_0002}.json`, [{ guid: "synthetic-guid-0002", title: "x" }]).hits[0].titleSlugMatch, null);

  // A parsed key works as well as a string, and whitespace spellings of one
  // guid are one episode, not a double hit.
  const one = resolveLegacyEpisode(parseLegacyKey(key), [
    { guid: "synthetic-guid-0001", title: "The Copper Kettle" },
    { guid: "synthetic-guid-0001 ", title: "The Copper Kettle" },
  ]);
  assert.equal(one.status, "matched");
  assert.equal(one.guid, "synthetic-guid-0001", "the first spelling is kept");
});

test("resolveLegacyEpisode: unmatched with a reason on no hit (a title match is never a match)", () => {
  const key = `tide-tables/the-copper-kettle-${H_0001}.json`;
  assert.deepEqual(resolveLegacyEpisode(key, [{ guid: "synthetic-guid-0002", title: "The Copper Kettle" }]), {
    status: "unmatched",
    guid: null,
    reason: "no_episode_for_guid_hash",
    hits: [],
  });
  assert.equal(resolveLegacyEpisode(key, []).reason, "no_candidates");
  assert.equal(resolveLegacyEpisode(key, [{ title: "no guid" }]).reason, "no_candidates");
  assert.equal(resolveLegacyEpisode(key, undefined).status, "unmatched");
  const notKey = resolveLegacyEpisode(`transcripts/normalized/x/${H_0001}.json`, [{ guid: "synthetic-guid-0001" }]);
  assert.deepEqual([notKey.status, notKey.reason], ["unmatched", "not_a_legacy_key"]);
});

test("resolveLegacyEpisode: a hash hit on two distinct episodes is ambiguous and never picked, even when one title slug matches", () => {
  const amb = resolveLegacyEpisode(`tide-tables/the-copper-kettle-${H_TWIN}.json`, [
    { guid: TWIN_A, title: "The Copper Kettle" },
    { guid: "synthetic-guid-0002", title: "Unrelated" },
    { guid: TWIN_B, title: "A Biscuit Tin" },
  ]);
  assert.equal(amb.status, "ambiguous");
  assert.equal(amb.guid, null, "nothing is picked");
  assert.equal(amb.reason, "guid_hash_multi_episode");
  assert.deepEqual(amb.hits, [
    { guid: TWIN_A, titleSlugMatch: true },
    { guid: TWIN_B, titleSlugMatch: false },
  ]);
});

test("convertWhisperDoc + toNormalizedBody: the fixture passes sync-r2 bodyShapeError as asr-local with no source_url", () => {
  const converted = convertWhisperDoc(fixture("doc-ok.json"));
  assert.deepEqual(converted.asr, { engine: "faster-whisper", model: "large-v3", detected_language: "en" });
  assert.equal(converted.cues.length, 3);
  assert.deepEqual(converted.cues[0], { start_sec: 0, end_sec: 4.5, text: "The copper kettle sang twice before the lighthouse keeper woke." });
  assert.equal(converted.cues[2].end_sec, 14.2);
  assert.deepEqual(converted.stats, { segments: 3, cues: 3, dropped_not_object: 0, dropped_non_finite_time: 0, dropped_words: 0 });

  const body = toNormalizedBody(converted, { show_id: "tide-tables", guid: "synthetic-guid-0001" });
  assert.equal(bodyShapeError(body), null);
  assert.equal(body.transcript_source, "asr-local");
  assert.equal("source_url" in body, false);
  assert.deepEqual(Object.keys(body), ["show_id", "guid", "transcript_source", "asr", "cues"]);
  assert.equal(body.cues.some((c) => "words" in c), false);

  // A converted object carrying a stray source_url never leaks it into the body.
  assert.equal("source_url" in toNormalizedBody({ ...converted, source_url: "https://example.invalid/a.mp3" }, { show_id: "s", guid: "g" }), false);
  // An explicit engine wins; neither engine nor faster_whisper -> "whisper"; missing fields are null.
  assert.equal(convertWhisperDoc({ meta: { engine: "whisperx" }, segments: [] }).asr.engine, "whisperx");
  assert.deepEqual(convertWhisperDoc({ meta: {}, segments: [] }).asr, { engine: "whisper", model: null, detected_language: null });
  // Identity is required.
  for (const id of [{ guid: "g" }, { show_id: "s" }, { show_id: " ", guid: "g" }]) {
    assert.throws(() => toNormalizedBody(converted, id), (e) => e instanceof LegacyShapeError && e.code === "bad_identity");
  }
});

test("convertWhisperDoc: words are dropped unless keepWords is set, then kept as {text,start,end}", () => {
  const doc = fixture("doc-ok.json");
  assert.equal(convertWhisperDoc(doc).cues.some((c) => "words" in c), false);
  assert.equal(convertWhisperDoc(doc, { keepWords: false }).cues.some((c) => "words" in c), false);

  const kept = convertWhisperDoc(doc, { keepWords: true });
  assert.equal(kept.cues[0].words.length, 10);
  assert.deepEqual(kept.cues[0].words[1], { text: "copper", start: 0.3, end: 0.8 });
  assert.deepEqual(kept.cues[2].words.at(-1), { text: "spring.", start: 12.8, end: 14.2 });
  const body = toNormalizedBody(kept, { show_id: "tide-tables", guid: "synthetic-guid-0001" });
  assert.equal(bodyShapeError(body), null, "extra per-cue words stay backward compatible");
  assert.equal(body.cues[1].words.length, 12);

  // A segment with no words gets [] under keepWords; a word with a bad time is dropped and counted.
  const sparse = convertWhisperDoc({ meta: {}, segments: [{ start: 0, end: 1, text: "a" }, { start: 1, end: 2, text: "b", words: [{ word: " b", start: null, end: 2 }] }] }, { keepWords: true });
  assert.deepEqual(sparse.cues.map((c) => c.words), [[], []]);
  assert.equal(sparse.stats.dropped_words, 1);
});

test("convertWhisperDoc: a bad document throws not_a_whisper_doc; segments with non-finite times are dropped and counted", () => {
  const isShape = (e) => e instanceof LegacyShapeError && e.code === "not_a_whisper_doc";
  assert.throws(() => convertWhisperDoc(fixture("doc-bad.json")), isShape, "a normalized body is not a whisper doc");
  for (const bad of [null, [], "x", { segments: [] }, { meta: {} }, { meta: null, segments: [] }, { meta: [], segments: [] }, { meta: {}, segments: {} }]) {
    assert.throws(() => convertWhisperDoc(bad), isShape, JSON.stringify(bad));
  }

  const doc = {
    meta: { faster_whisper: "1.0.3" },
    segments: [
      { start: 0, end: 2, text: " A lantern hummed. " },
      { start: null, end: 3, text: "no start" },
      { start: 3, end: "4", text: "string end" },
      { start: 4, text: "missing end" },
      "not an object",
      null,
      { start: 5, end: 6.5, text: "  The tide kept its own calendar." },
    ],
  };
  const converted = convertWhisperDoc(doc);
  assert.deepEqual(converted.cues, [
    { start_sec: 0, end_sec: 2, text: "A lantern hummed." },
    { start_sec: 5, end_sec: 6.5, text: "The tide kept its own calendar." },
  ]);
  assert.deepEqual(converted.stats, { segments: 7, cues: 2, dropped_not_object: 2, dropped_non_finite_time: 3, dropped_words: 0 });
  assert.equal(bodyShapeError(toNormalizedBody(converted, { show_id: "s", guid: "g" })), null);
});

/* ---- the bounded sampler, on a fake S3 client ---- */

class ListObjectsV2Command {
  constructor(input) {
    this.input = input;
  }
}
class GetObjectCommand {
  constructor(input) {
    this.input = input;
  }
}
const commands = { ListObjectsV2Command, GetObjectCommand };

/* One listing page of every key under the prefix; GET returns the bytes. */
function fakeClient(objects) {
  const store = new Map(Object.entries(objects).map(([k, v]) => [k, Buffer.from(v)]));
  const calls = [];
  return {
    calls,
    async send(cmd) {
      const name = cmd.constructor.name;
      calls.push([name, cmd.input.Key ?? cmd.input.Prefix]);
      if (name === "ListObjectsV2Command") {
        const keys = [...store.keys()].filter((k) => k.startsWith(cmd.input.Prefix ?? ""));
        return { IsTruncated: false, Contents: keys.map((Key) => ({ Key, Size: store.get(Key).length, ETag: '"e"' })) };
      }
      if (name === "GetObjectCommand") {
        const bytes = store.get(cmd.input.Key);
        if (!bytes) throw new Error(`fake: no such key ${cmd.input.Key}`);
        return { ContentLength: bytes.length, ETag: '"e"', Metadata: {}, Body: { transformToByteArray: async () => new Uint8Array(bytes) } };
      }
      throw new Error(`fake: unexpected command ${name}`);
    },
  };
}

const OK = fixtureText("doc-ok.json");
const BUCKET = {
  [`tide-tables/the-copper-kettle-${H_0001}.json`]: OK,
  [`tide-tables/${H_0002}.json`]: OK,
  [`tide-tables/the-gulls-${H_TWIN}.json`]: OK,
  [`biscuit-hour/first-${H_0001}.json`]: "{not json",
  [`biscuit-hour/second-${H_0002}.json`]: fixtureText("doc-bad.json"),
  [`lantern-talk/only-${H_TWIN}.json`]: OK,
  // never legacy: farm bodies, originals, fingerprints and probe keys
  [`transcripts/normalized/470582/ep-${H_0001}.json`]: '{"show_id":"470582","guid":"g","cues":[]}',
  [`transcript-originals/tide-tables/ep-${H_0001}.json`]: OK,
  [`fingerprints/tide-tables/ep-${H_0001}.json.gz`]: "x",
  [`_probe/write-test-${H_0001}.json`]: OK,
};

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), "legacy-whisper-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const gets = (client) => client.calls.filter(([n]) => n === "GetObjectCommand").map(([, k]) => k);

test("sampleLegacy: GETs exactly n legacy objects (round-robin across shows), writes them and the shape report", async (t) => {
  const out = tmp(t);
  const client = fakeClient(BUCKET);
  const logs = [];
  const { report, reportPath } = await sampleLegacy({ client, bucket: "bkt", n: 4, out, commands, log: (s) => logs.push(s) });

  assert.deepEqual(gets(client), [
    `biscuit-hour/first-${H_0001}.json`,
    `lantern-talk/only-${H_TWIN}.json`,
    `tide-tables/${H_0002}.json`,
    `biscuit-hour/second-${H_0002}.json`,
  ]);
  assert.equal(client.calls.filter(([n]) => n === "ListObjectsV2Command").length, 1);
  assert.equal(report.listed, Object.keys(BUCKET).length);
  assert.equal(report.legacy_keys, 6, "farm, originals, fingerprints and probe keys are not legacy");
  assert.equal(report.sampled, 4);
  assert.equal(report.errors, 2);
  assert.equal(report.with_words, 2);
  const byKey = Object.fromEntries(report.rows.map((r) => [r.key, r]));
  assert.equal(byKey[`biscuit-hour/first-${H_0001}.json`].error, "bad_json");
  assert.equal(byKey[`biscuit-hour/second-${H_0002}.json`].error, "not_a_whisper_doc");
  const ok = byKey[`tide-tables/${H_0002}.json`];
  assert.deepEqual(
    [ok.segments, ok.cues, ok.segments_with_words, ok.last_end_sec, ok.language, ok.engine, ok.model, ok.error],
    [3, 3, 3, 14.2, "en", "faster-whisper", "large-v3", null],
  );
  // The sampled bytes land unchanged under <out>/<show>/<file>; nothing else is written.
  assert.equal(readFileSync(join(out, "tide-tables", `${H_0002}.json`), "utf8"), OK);
  assert.deepEqual(readdirSync(out).sort(), ["biscuit-hour", "lantern-talk", SAMPLE_REPORT_NAME, "tide-tables"]);
  assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), report);
  assert.match(logs.join("\n"), /\| tide-tables\/8f50d8159b\.json \| 3 \| 3\/3 \| 14\.2 \| en \|/);

  // n above the legacy count GETs every legacy object once and no other key.
  const all = fakeClient(BUCKET);
  const res = await sampleLegacy({ client: all, bucket: "bkt", n: 50, out: tmp(t), commands, log: () => {} });
  assert.equal(gets(all).length, 6);
  assert.ok(gets(all).every((k) => parseLegacyKey(k) !== null));
  assert.equal(res.report.sampled, 6);
});

test("parseSampleArgs: sample with a bounded --n, --out and --prefix; anything else is refused", () => {
  assert.deepEqual(parseSampleArgs(["sample", "--n", "20"]).n, 20);
  assert.equal(parseSampleArgs(["sample"]).n, 20);
  const a = parseSampleArgs(["sample", "--n", "3", "--out", "x", "--prefix", "tide-tables/"]);
  assert.deepEqual([a.n, a.out, a.prefix], [3, "x", "tide-tables/"]);
  assert.ok(existsSync(join(HERE, "..", "..", ".gitignore")) && /^data-local\/$/m.test(readFileSync(join(HERE, "..", "..", ".gitignore"), "utf8")), "the default out (data-local/legacy-sample/) is gitignored");
  assert.match(parseSampleArgs(["sample"]).out.replace(/\\/g, "/"), /\/data-local\/legacy-sample$/);
  for (const argv of [[], ["list"], ["sample", "--n"], ["sample", "--n", "0"], ["sample", "--n", String(MAX_SAMPLE_N + 1)], ["sample", "--n", "2.5"], ["sample", "--n", "2", "--n", "3"], ["sample", "--all"]]) {
    assert.throws(() => parseSampleArgs(argv), (e) => e instanceof LegacyShapeError && e.code === "USAGE", JSON.stringify(argv));
  }
});
