/* RV-05 (docs/roadmap/recommender-v1.md, D3; #1163 item 17.3): the R2
   transcript sampler, dormant until the read key exists. Offline only: no
   credential, no network, no node_modules. R2 is a fake S3 client whose
   `send` switches on `cmd.constructor.name` over injected fake command
   classes (the r2-client.test.mjs / sync-r2.test.mjs pattern), so the real
   listPrefix and getObject of r2-client.mjs run against it. Every test gets a
   fresh tmp directory as the local transcripts root.

   Mutations each test kills (run red on the branch before commit):
   - "exits 2 with no credentials and writes nothing": `return DORMANT_EXIT` -> `return 0`.
   - "fetched bodies are listable by sources.listLocal": write to
     `resolvePath(base, file)` (a flat dir) instead of `resolvePath(base, dir, file)`.
   - "a show with enough local bodies is skipped": delete the
     `have.length >= perShow` skip.
   - "the pick is seeded by show_key": `rng(String(seed))` -> `Math.random`.
   - "--dry-run writes nothing": `if (dryRun)` -> `if (false)`.
   - "a show absent from R2 is reported in missing_in_r2": drop the
     `missing_in_r2.push(key)` branch (the show then counts as nothing).
   - "a body failing its sha256 or shape check is rejected and not written":
     `const reason = rejectReason(got)` -> `const reason = null`. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { safeKey } from "../foraycorpus-export/config.mjs";
import { sha256 } from "../foraycorpus-export/r2-client.mjs";
import { listLocal } from "../passage-index/sources.mjs";
import { DORMANT_EXIT, main, pickObjects, r2PrefixFor, sampleShows } from "./sample-r2.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "sample-r2.mjs");

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

/** A normalized body in the farm's shape (bodyShapeError accepts it). */
function body(showId, guid) {
  return JSON.stringify({ show_id: showId, guid, transcript_source: "publisher", cues: [{ start_sec: 0, end_sec: 4.5, text: `opening of ${guid}` }] });
}

/** objects: [{key, body, meta?}]; meta defaults to the body's real sha256. */
function fakeClient(objects) {
  const store = new Map(objects.map(({ key, body: b, meta }) => [key, { bytes: Buffer.from(b), meta: meta === undefined ? sha256(Buffer.from(b)) : meta }]));
  const calls = [];
  return {
    calls,
    async send(cmd) {
      const name = cmd.constructor.name;
      calls.push([name, cmd.input.Key ?? cmd.input.Prefix]);
      if (name === "ListObjectsV2Command") {
        const keys = [...store.keys()].filter((k) => k.startsWith(cmd.input.Prefix));
        return { IsTruncated: false, Contents: keys.map((Key) => ({ Key, Size: store.get(Key).bytes.length, ETag: '"x"', LastModified: new Date("2026-10-01T00:00:00Z") })) };
      }
      if (name === "GetObjectCommand") {
        const o = store.get(cmd.input.Key);
        if (!o) throw new Error(`fake: no such key ${cmd.input.Key}`);
        return { Metadata: o.meta === null ? {} : { sha256: o.meta }, ContentLength: o.bytes.length, ETag: '"x"', Body: { transformToByteArray: async () => new Uint8Array(o.bytes) } };
      }
      throw new Error(`fake: unexpected command ${name}`);
    },
  };
}

/** `n` bodies for a show in the farm's identity directory. */
function showObjects(showKey, n) {
  return Array.from({ length: n }, (_, i) => {
    const guid = `ep-${showKey}-${i}`;
    return { key: `${r2PrefixFor(showKey)}${safeKey(guid)}.json`, body: body(showKey, guid) };
  });
}

function tmp() {
  return mkdtempSync(join(tmpdir(), "rv05-"));
}

const fakeCreds = async () => ({ accessKeyId: "fake", endpoint: "https://fake.invalid", bucket: "fake-bucket" });

function writeKeys(dir, keys) {
  const path = join(dir, "keys.json");
  writeFileSync(path, JSON.stringify(keys));
  return path;
}

test("exits 2 with no credentials and writes nothing", () => {
  const dir = tmp();
  try {
    const keysFile = writeKeys(dir, ["the-show"]);
    const missing = join(dir, "no-such-r2-credentials");
    const normalized = join(dir, "normalized");
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("R2_") && !k.startsWith("RECOMMENDER_")));
    const res = spawnSync(process.execPath, [SCRIPT, "--keys", keysFile], {
      env: { ...env, R2_CREDENTIALS_FILE: missing, RECOMMENDER_TRANSCRIPTS_DIR: normalized },
      encoding: "utf8",
    });
    assert.equal(res.status, DORMANT_EXIT, res.stderr);
    assert.equal(DORMANT_EXIT, 2);
    assert.match(res.stderr, /dormant/);
    assert.ok(res.stderr.includes(missing), `the message names the credentials file: ${res.stderr}`);
    assert.equal(res.stdout, "");
    assert.equal(existsSync(normalized), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetched bodies are listable by sources.listLocal", async () => {
  const dir = tmp();
  try {
    const normalized = join(dir, "normalized");
    const objects = [...showObjects("the-show", 5), ...showObjects("1234567", 2)];
    const client = fakeClient(objects);
    const out = [];
    const code = await main(["--keys", writeKeys(dir, { shows: [{ show_key: "the-show" }, { show_key: "1234567" }] })], {
      env: { RECOMMENDER_TRANSCRIPTS_DIR: normalized },
      loadCredentials: fakeCreds,
      makeClient: async () => client,
      commands,
      stdout: (s) => out.push(s),
      stderr: () => {},
    });
    assert.equal(code, 0);
    const summary = JSON.parse(out.join(""));
    assert.equal(summary.fetched, 5);
    assert.equal(summary.shows, 2);
    const { shows } = listLocal(normalized);
    assert.equal(shows.get("the-show").length, 3);
    assert.equal(shows.get("1234567").length, 2);
    assert.equal(shows.get("the-show")[0].dir, safeKey("the-show"));
    const entry = shows.get("the-show")[0];
    const source = objects.find((o) => o.key.endsWith(`/${entry.fileName}`));
    assert.equal(readFileSync(entry.path, "utf8"), source.body, "bytes are written unchanged");
    assert.equal(summary.bytes, [...shows.values()].flat().reduce((n, e) => n + e.size, 0));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a show with enough local bodies is skipped", async () => {
  const dir = tmp();
  try {
    const normalized = join(dir, "normalized");
    const showDir = join(normalized, safeKey("full-show"));
    mkdirSync(showDir, { recursive: true });
    for (let i = 0; i < 3; i += 1) writeFileSync(join(showDir, `local-${i}.json`), body("full-show", `local-${i}`));
    /* A show holding one body fetches only the shortfall, into the directory it already has. */
    const partialDir = join(normalized, "half-show");
    mkdirSync(partialDir, { recursive: true });
    const held = showObjects("half-show", 4);
    writeFileSync(join(partialDir, held[0].key.split("/").pop()), held[0].body);
    const client = fakeClient([...showObjects("full-show", 4), ...held]);
    const summary = await sampleShows({ keys: ["full-show", "half-show"], perShow: 3, client, bucket: "b", commands, normalizedRoot: normalized });
    assert.equal(summary.skipped, 1);
    assert.ok(!client.calls.some(([, k]) => k.startsWith(r2PrefixFor("full-show"))), "a skipped show is never listed");
    assert.equal(summary.fetched, 2);
    assert.equal(listLocal(normalized).shows.get("full-show").length, 3);
    assert.equal(listLocal(normalized).shows.get("half-show").length, 3);
    assert.ok(!client.calls.some(([n, k]) => n === "GetObjectCommand" && k === held[0].key), "a body already held is not fetched again");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the pick is seeded by show_key", async () => {
  const names = Array.from({ length: 12 }, (_, i) => `ep-${String(i).padStart(2, "0")}.json`);
  assert.deepEqual(pickObjects(names, 3, "the-show"), pickObjects([...names].reverse(), 3, "the-show"));
  const picks = new Set(["a", "b", "c", "d", "e", "f"].map((seed) => pickObjects(names, 3, seed).join(",")));
  assert.ok(picks.size > 1, "different show keys can pick different episodes");
  assert.equal(pickObjects(names, 3, "x").length, 3);
  assert.equal(pickObjects(names.slice(0, 2), 3, "x").length, 2);

  /* The run itself picks what pickObjects(…, show_key) picks, run after run. */
  const dir = tmp();
  try {
    const objects = showObjects("seeded-show", 9);
    const run = async (root) => {
      const client = fakeClient(objects);
      await sampleShows({ keys: ["seeded-show"], perShow: 3, client, bucket: "b", commands, normalizedRoot: root });
      return client.calls.filter(([n]) => n === "GetObjectCommand").map(([, k]) => k.split("/").pop()).sort();
    };
    const first = await run(join(dir, "one"));
    const second = await run(join(dir, "two"));
    assert.deepEqual(first, second);
    assert.deepEqual(first, pickObjects(objects.map((o) => o.key.split("/").pop()), 3, "seeded-show"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--dry-run writes nothing", async () => {
  const dir = tmp();
  try {
    const normalized = join(dir, "normalized");
    const client = fakeClient(showObjects("the-show", 5));
    const out = [];
    const code = await main(["--keys", writeKeys(dir, ["the-show"]), "--dry-run"], {
      env: { RECOMMENDER_TRANSCRIPTS_DIR: normalized },
      loadCredentials: fakeCreds,
      makeClient: async () => client,
      commands,
      stdout: (s) => out.push(s),
      stderr: () => {},
    });
    assert.equal(code, 0);
    const summary = JSON.parse(out.join(""));
    assert.equal(summary.planned.length, 3);
    assert.equal(summary.fetched, 0);
    assert.equal(existsSync(normalized), false);
    assert.deepEqual(client.calls.map(([n]) => n), ["ListObjectsV2Command"], "a dry run lists and never GETs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a show absent from R2 is reported in missing_in_r2", async () => {
  const dir = tmp();
  try {
    const client = fakeClient(showObjects("present", 3));
    const summary = await sampleShows({ keys: ["absent", "present"], limit: 2, client, bucket: "b", commands, normalizedRoot: join(dir, "n") });
    assert.deepEqual(summary.missing_in_r2, ["absent"]);
    assert.equal(summary.fetched, 3);
    const limited = await sampleShows({ keys: ["absent", "present"], limit: 1, client: fakeClient([]), bucket: "b", commands, normalizedRoot: join(dir, "m") });
    assert.equal(limited.shows, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a body failing its sha256 or shape check is rejected and not written", async () => {
  const dir = tmp();
  try {
    const normalized = join(dir, "normalized");
    const prefix = r2PrefixFor("bad-show");
    const client = fakeClient([
      { key: `${prefix}a.json`, body: body("bad-show", "a"), meta: "0".repeat(64) },
      { key: `${prefix}b.json`, body: "{not json" },
      { key: `${prefix}c.json`, body: JSON.stringify({ show_id: "bad-show", guid: "c" }) },
    ]);
    const summary = await sampleShows({ keys: ["bad-show"], perShow: 3, client, bucket: "b", commands, normalizedRoot: normalized });
    assert.deepEqual(summary.rejected.map((r) => r.reason).sort(), ["BAD_JSON", "BAD_SHAPE:cues", "SHA_MISMATCH"]);
    assert.equal(summary.fetched, 0);
    assert.equal(listLocal(normalized).shows.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
