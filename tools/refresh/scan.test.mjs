/* scan.mjs, run for real against an offline world (code-health-2 CH2-29).

   Run: node --test tools/refresh/scan.test.mjs

   WHY A SPAWN AND NOT AN IMPORT. scan.mjs is the nightly's input and is a
   script: it reads process.argv at top level and runs on import. Until CH2-29
   it also read data/ and fetched every curated feed live, so nothing could run
   it under test. `FEED_FIXTURE_DIR` is the seam: catalog.json, discover.json
   and one `<sha1(feed url)>.xml` per feed come from `fixtures/scan/`, there is
   no network and no throttle. Everything else (the seen-guid state, the retry
   carry, the 10-item slice, the window, the known-title skip, the withheld
   list) is the production path.

   THE SNAPSHOT IS THE CONTRACT. `fixtures/scan/expected-pending.json` was
   written by scan.mjs BEFORE the record literal moved into feed-xml.mjs, and
   the extraction had to leave it byte-identical (generated_at and the absolute
   state_path are the only normalised fields: one is the clock, the other the
   temp dir).

   CI NOTE, said plainly: scan.mjs parses with backend/'s fast-xml-parser and
   CI's data-and-site job never installs backend/node_modules, so the three
   spawn tests SKIP there and run wherever `npm ci` has been run in backend/.
   The pins that must hold in CI (scan.mjs builds its record through
   feed-xml.mjs's one function and carries no copy of the literal) live in
   feed-xml.test.mjs, which needs no parser. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const FIXTURES = join(HERE, "fixtures", "scan");
const SCAN = join(HERE, "scan.mjs");

const backendRequire = createRequire(join(ROOT, "backend", "package.json"));
let HAS_PARSER = true;
try { backendRequire.resolve("fast-xml-parser"); } catch (_) { HAS_PARSER = false; }
const needParser = { skip: HAS_PARSER ? false : "backend/node_modules not installed (CI data-and-site); run `npm ci` in backend/ to run it" };

/** One scan.mjs run against the fixture world; returns its outputs. */
function runScan() {
  const dir = mkdtempSync(join(tmpdir(), "scan-test-"));
  try {
    const statePath = join(dir, "state.json");
    const pendingPath = join(dir, "pending.json");
    copyFileSync(join(FIXTURES, "state.json"), statePath);
    /* 1,000,000 hours is ~114 years: every 2026 item is inside the window and the
       1901 item is outside it, for as long as this repository exists. */
    const r = spawnSync(process.execPath, [SCAN, "--window-hours", "1000000"], {
      encoding: "utf8",
      env: { ...process.env, FEED_FIXTURE_DIR: FIXTURES, STATE_PATH: statePath, PENDING_PATH: pendingPath },
    });
    assert.equal(r.status, 0, `scan.mjs exited ${r.status}\n${r.stdout}\n${r.stderr}`);
    return {
      stdout: r.stdout,
      pendingText: readFileSync(pendingPath, "utf8"),
      state: JSON.parse(readFileSync(statePath, "utf8")),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const normalise = (pendingText) => {
  const doc = JSON.parse(pendingText);
  assert.match(doc.generated_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.ok(doc.state_path.endsWith("state.json"), doc.state_path);
  return JSON.stringify({ ...doc, generated_at: "<generated_at>", state_path: "<state_path>" }, null, 2);
};

/* MUTATION: change any field of the pushed record (rename `explicit_hint`, drop
   `audio_bytes`, swap the `||` guid fallback to the title) in feed-xml.mjs's
   itemToPendingRecord -> red, the diff names the field. The "Seen Last Night"
   item's guid is `<guid isPermaLink="false">20261002</guid>`, which fast-xml-parser
   types as the NUMBER 20261002, and state.json holds the string: text() handing
   back the number unconverted -> red (the seen item misses `seen` and is pushed
   again, 8 new episodes; CH2-29 review). Run: deleting `audio_bytes:`
   from the record -> red ("audio_bytes" missing from seven episodes). */
test("fresh-pending.json is byte-identical to the pre-extraction snapshot", needParser, () => {
  const { pendingText, stdout } = runScan();
  const expected = readFileSync(join(FIXTURES, "expected-pending.json"), "utf8").replace(/\r\n/g, "\n").trimEnd();
  assert.equal(normalise(pendingText), expected);
  assert.match(stdout, /polled 2\/3 feeds \(1 failed\); 7 new episodes/);
  assert.match(stdout, /WITHHELD 1 enclosure\(s\):\n  Alpha Show :: Video Only :: non-audio type video\/mp4/);
  assert.match(stdout, /REFRESH_SCAN_COMPLETE/);
});

/* MUTATION: `seen.add(guid)` removed from scan.mjs -> red (the five new alpha
   guids never reach state.seen, so tomorrow's run would push them again). */
test("the seen-guid state records exactly the guids pushed, and keeps the retry list", needParser, () => {
  const { state } = runScan();
  assert.deepEqual(state.seen, {
    1001: [
      "20261002",
      "alpha-cdata-guid",
      "alpha-object-guid",
      "https://cdn.example.test/alpha/ep3.mp3",
      "alpha-video",
      "https://alpha.example.test/ep10",
    ],
    1002: ["beta-1"],
  });
  assert.deepEqual(Object.keys(state.retry), ["retry-guid-1", "retry-guid-2"]);
});

/* THE "FIELD-FOR-FIELD" COMMENT, MADE A CONTRACT. backfill-show.mjs promised its
   record was the shape scan.mjs pushes; nothing checked it. Green before the
   extraction (two literals that happened to agree) and after it (one function).
   MUTATION: re-inline the record literal in scan.mjs with one field changed
   (e.g. `explicit_hint: false`) -> red on alpha-cdata-guid. */
test("every record scan pushes deep-equals backfill-show's pendingRecord for the same <item>", needParser, async () => {
  const { pendingText } = runScan();
  const { pendingRecord } = await import("./backfill-show.mjs");
  const { feedParser } = await import("./feed-xml.mjs");
  const parser = feedParser();
  const catalog = JSON.parse(readFileSync(join(FIXTURES, "catalog.json"), "utf8"));
  const sha1 = (s) => createHash("sha1").update(s).digest("hex");

  const fromBackfill = new Map();
  for (const show of catalog.shows.filter((s) => s.feed_url)) {
    let xml;
    try { xml = readFileSync(join(FIXTURES, `${sha1(show.feed_url)}.xml`), "utf8"); } catch (_) { continue; }
    let items = parser.parse(xml)?.rss?.channel?.item || [];
    if (!Array.isArray(items)) items = [items];
    for (const it of items) {
      const { record } = pendingRecord(show, it);
      if (record) fromBackfill.set(record.guid, record);
    }
  }
  const pushed = JSON.parse(pendingText).episodes.filter((e) => !("_retry_attempts" in e));
  assert.equal(pushed.length, 6);
  for (const rec of pushed) assert.deepEqual(rec, fromBackfill.get(rec.guid), rec.guid);
});
