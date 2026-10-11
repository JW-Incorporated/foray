/* GV-06 (W3-01, docs/roadmap/generation-v2.md): the list-only inventory of
   the R2 bucket and the disk-space guard, as pure functions over a fixture
   listing, a tmp mirror and an injected statfs. No network, no credential,
   no node_modules. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { safeKey } from "./config.mjs";
import {
  TOP_DIRS_PER_AREA,
  classifyKey,
  diskVerdict,
  ensureDiskSpace,
  fetchNeedBytes,
  inventoryFromListing,
  inventoryMarkdown,
} from "./inventory.mjs";
import { MAX_OBJECT_BYTES } from "./r2-client.mjs";
import { buildShowMap } from "./show-map.mjs";

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), "inventory-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/* One object of every area, with distinct sizes so a misfiled key shows up
   in the byte counts. */
const FIXTURE = [
  { key: "transcripts/normalized/470582/ep-1.json", size: 1000 },
  { key: "transcripts/normalized/470582/ep-2.json", size: 2000 },
  { key: "transcripts/normalized/other-show/ep-1.json", size: 300 },
  { key: "transcripts/raw/470582/ep-1.vtt", size: 40000 },
  { key: "fingerprints/470582/ep-1.bin", size: 5 },
  { key: "fingerprints/470582/ep-2.bin", size: 6 },
  { key: "some-show/title-slug-abcdef1234.json", size: 70000 },
  { key: "another-show/0123456789.json", size: 80000 },
  { key: "transcript-originals/x/y-abcdef1234.json", size: 9 },
  { key: "_staging/y-abcdef1234.json", size: 11 },
  { key: "README.txt", size: 13 },
];

/* (1) classifyKey: the four layouts, the legacy-root regex (foray-db
   _KEY_RE), and its excluded prefixes. A transcripts/ key whose file ends in
   10 hex would match the regex, so the exclusion is what keeps it out.
   Mutation that turns this red: drop the LEGACY_EXCLUDED_PREFIXES check
   (transcript-originals/ and _staging/ become legacy-root). */
test("(1) classifyKey sorts every key into one area", () => {
  assert.equal(classifyKey("transcripts/normalized/d/f-abcdef1234.json"), "normalized");
  assert.equal(classifyKey("transcripts/raw/d/f.vtt"), "raw");
  assert.equal(classifyKey("fingerprints/d/f-abcdef1234.json"), "fingerprints");
  assert.equal(classifyKey("some-show/title-slug-abcdef1234.json"), "legacy-root");
  assert.equal(classifyKey("another-show/0123456789.json"), "legacy-root");
  assert.equal(classifyKey("transcript-originals/x/y-abcdef1234.json"), "other");
  assert.equal(classifyKey("_staging/y-abcdef1234.json"), "other");
  assert.equal(classifyKey("Some-Show/title-abcdef1234.json"), "other", "upper case is not foray-db's slug");
  assert.equal(classifyKey("some-show/title-abcdef123.json"), "other", "nine hex is not a legacy key");
  assert.equal(classifyKey("transcripts/other/d/f.json"), "other");
  assert.equal(classifyKey(undefined), "other");
});

/* (2) Per-area object, byte and directory counts equal the fixture listing,
   and an object listed without a size counts as MAX_OBJECT_BYTES.
   Mutation that turns this red: make sizeOrMax return 0 for an unknown size
   (the bytes total drops by MAX_OBJECT_BYTES). */
test("(2) area aggregation equals the fixture listing", () => {
  const inv = inventoryFromListing([...FIXTURE, { key: "transcripts/normalized/470582/ep-3.json", size: null }]);
  assert.deepEqual(inv.by_area, {
    normalized: { objects: 4, bytes: 3300 + MAX_OBJECT_BYTES, dirs: 2 },
    raw: { objects: 1, bytes: 40000, dirs: 1 },
    fingerprints: { objects: 2, bytes: 11, dirs: 1 },
    "legacy-root": { objects: 2, bytes: 150000, dirs: 2 },
    other: { objects: 3, bytes: 33, dirs: 3 },
  });
  assert.equal(inv.objects, 12);
  assert.equal(inv.bytes, 3300 + 40000 + 11 + 150000 + 33 + MAX_OBJECT_BYTES);
  assert.equal(inv.unknownSizeObjects, 1);
  assert.equal(inv.local, null, "no out, no local block");
});

/* (3) top_dirs is per area, largest bytes first, ties by name, capped at
   TOP_DIRS_PER_AREA; largest_objects is the 20 largest keys, largest first.
   Mutation that turns this red: sort top_dirs ascending by bytes
   (`a.bytes - b.bytes`). */
test("(3) top_dirs and largest_objects are ordered by bytes", () => {
  const listing = [];
  for (let i = 0; i < TOP_DIRS_PER_AREA + 5; i += 1) {
    listing.push({ key: `transcripts/normalized/dir-${String(i).padStart(3, "0")}/a.json`, size: 10 + (i % 7) });
  }
  listing.push({ key: "transcripts/normalized/zz-big/a.json", size: 900 }, { key: "transcripts/normalized/zz-big/b.json", size: 900 });
  const inv = inventoryFromListing(listing);
  const top = inv.top_dirs.normalized;
  assert.equal(top.length, TOP_DIRS_PER_AREA);
  assert.deepEqual(top[0], { dir: "zz-big", objects: 2, bytes: 1800 });
  for (let i = 1; i < top.length; i += 1) {
    const [a, b] = [top[i - 1], top[i]];
    assert.ok(a.bytes > b.bytes || (a.bytes === b.bytes && a.dir < b.dir), `${a.dir} before ${b.dir}`);
  }
  assert.deepEqual(top.slice(1, 3).map((d) => d.dir), ["dir-006", "dir-013"], "16-byte dirs, by name");
  assert.equal(inv.largest_objects.length, 20);
  assert.deepEqual(inv.largest_objects.slice(0, 2), [
    { key: "transcripts/normalized/zz-big/a.json", size: 900, area: "normalized" },
    { key: "transcripts/normalized/zz-big/b.json", size: 900, area: "normalized" },
  ]);
  assert.deepEqual(inv.top_dirs.raw, []);
});

/* (4) would_fetch against a tmp mirror: a body already on disk at the
   listed size is on disk; a different size, an absent file and an unknown
   size are fetched (the unknown at MAX_OBJECT_BYTES). The mapped R2
   directory is looked up under safeKey(foray show_id), sync-r2's own path.
   Mutation that turns this red: make fetchNeedBytes ignore the local size
   (every body is counted as a fetch). */
test("(4) would_fetch compares the listing against the local mirror", (t) => {
  const out = tmp(t);
  const { map: showMap } = buildShowMap({
    queue: { shows: [{ title: "Being an Engineer", feed_url: "https://feeds.example.com/bae", podcastindex_feed_id: 470582, apple_collection_id: 1 }] },
    catalog: { shows: [{ show_id: "being-an-engineer", feed_url: "https://feeds.example.com/bae" }] },
  });
  const r2Dir = safeKey("470582");
  const local = join(out, "normalized", safeKey("being-an-engineer"));
  mkdirSync(local, { recursive: true });
  writeFileSync(join(local, "same.json"), "x".repeat(100));
  writeFileSync(join(local, "changed.json"), "x".repeat(50));
  const k = (f) => `transcripts/normalized/${r2Dir}/${f}`;
  const inv = inventoryFromListing(
    [
      { key: k("same.json"), size: 100 },
      { key: k("changed.json"), size: 60 },
      { key: k("absent.json"), size: 70 },
      { key: k("unknown.json"), size: null },
      { key: k("not-a-body.txt"), size: 5 },
      { key: "transcripts/raw/x/y.vtt", size: 999 },
    ],
    { out, showMap },
  );
  assert.deepEqual(inv.local, { normalized_on_disk: 1, would_fetch_objects: 3, would_fetch_bytes: 60 + 70 + MAX_OBJECT_BYTES });
  assert.equal(fetchNeedBytes(100, 100), 0);
  assert.equal(fetchNeedBytes(100, null), 100);
  assert.equal(fetchNeedBytes(null, 100), MAX_OBJECT_BYTES);
});

/* (5) ensureDiskSpace: free is bavail * bsize (the blocks this user may
   take, not bfree), measured on the nearest existing ancestor of the path;
   it refuses with DISK_SPACE when free - need < margin and passes at the
   boundary.
   Mutation that turns this red: compute free from `st.bfree` (the fake's
   bfree is 10x bavail, so the refusal passes). */
test("(5) the guard refuses and passes on bavail * bsize", (t) => {
  const base = tmp(t);
  const seen = [];
  const statfs = (p) => {
    seen.push(p);
    return { bsize: 4096, bavail: 1000, bfree: 10000 }; // free = 4,096,000
  };
  const path = join(base, "not", "yet", "made");
  assert.throws(
    () => ensureDiskSpace({ path, needBytes: 96_001, minFreeBytes: 4_000_000, statfs }),
    (e) => e.name === "SyncError" && e.code === "DISK_SPACE" && /need 0\.00 GB, free 0\.00 GB, keep 0\.00 GB/.test(e.message),
  );
  assert.equal(seen[0], base, "statfs is asked about the nearest existing ancestor");
  const ok = ensureDiskSpace({ path, needBytes: 96_000, minFreeBytes: 4_000_000, statfs });
  assert.deepEqual({ ok: ok.ok, freeBytes: ok.freeBytes }, { ok: true, freeBytes: 4_096_000 });
  assert.equal(diskVerdict({ path, needBytes: 0, minFreeBytes: 5_000_000, statfs }).ok, false);
});

/* (6) The markdown table has one row per area plus a total, and the local
   line when the inventory has one.
   Mutation that turns this red: drop the `**total**` row from
   inventoryMarkdown. */
test("(6) inventoryMarkdown renders the area table for #1163", () => {
  const md = inventoryMarkdown(inventoryFromListing(FIXTURE), { bucket: "foray-transcriptions", prefix: "" });
  assert.match(md, /bucket `foray-transcriptions`, prefix `\(all\)`/);
  assert.match(md, /\| legacy-root \| 2 \| 150,000 \| 0\.00 \| 2 \|/);
  assert.match(md, /\| \*\*total\*\* \| 11 \| 193,344 \|/);
  assert.doesNotMatch(md, /Local mirror/);
});
