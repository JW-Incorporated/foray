/* merge.mjs CHARACTERIZATION, ahead of CH2-14 (issues T1-14 and T1-22 of
 * docs/roadmap/code-health-2.md).
 *   Run: node --test tools/refresh/merge.test.mjs
 *
 * merge.mjs is the nightly's write path. `nightly-runner.mjs finish` reads its
 * stdout to decide "nothing to do" (exit 4) vs "merged N, open a PR" vs
 * MERGE_UNPARSED (exit 5), and its copy-rule limits (hook word cap, 5-12 tags,
 * the tag pattern) are retyped literals today. CH2-14 is about to move both.
 *
 * This file pins what the UNMODIFIED script does, spawned for real: exit codes
 * and stdout/stderr bytes for nothing-to-merge, N-added, each copy-rule refusal
 * and the legal edges. It is committed green against today's merge.mjs so the
 * refactor that follows has to keep all of it byte-identical. (It spawns
 * merge.mjs rather than importing it: today the module body IS the merge.)
 *
 * Every test names the one-line mutation that kills it. All were run.
 * The floor for this suite lives in test/suite-integrity.test.js.            */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const MERGE = join(HERE, "merge.mjs");

/** A throwaway data dir and one REAL merge run against it (the same env
    overrides merge-topics.test.mjs and the nightly use). `present` seeds
    discover.json with items that are already merged. */
function runMerge({ resolved, edits, present = [] }) {
  const dir = mkdtempSync(join(tmpdir(), "foray-merge-contract-"));
  const path = (f) => join(dir, f);
  writeFileSync(path("resolved.json"), JSON.stringify({ resolved }));
  writeFileSync(path("edits.json"), JSON.stringify(edits));
  const discoverIn = JSON.stringify({ built_at: "x", items: present }, null, 2) + "\n";
  writeFileSync(path("discover.json"), discoverIn);
  writeFileSync(path("item-tags.json"), JSON.stringify({ built_at: "x", tags: {} }));
  writeFileSync(path("catalog.json"), JSON.stringify({ shows: [] }));
  let status = 0, stderr = "", stdout = "";
  try {
    stdout = execFileSync(process.execPath, [MERGE], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        RESOLVED_PATH: path("resolved.json"),
        EDITS_PATH: path("edits.json"),
        MERGE_DISCOVER_PATH: path("discover.json"),
        MERGE_TAGS_PATH: path("item-tags.json"),
        MERGE_CATALOG_PATH: path("catalog.json"),
      },
    });
  } catch (e) {
    status = e.status ?? 1;
    stdout = e.stdout || "";
    stderr = e.stderr || "";
  }
  const discoverOut = readFileSync(path("discover.json"), "utf8");
  const tags = JSON.parse(readFileSync(path("item-tags.json"), "utf8"));
  rmSync(dir, { recursive: true, force: true });
  return { status, stdout, stderr, discover: JSON.parse(discoverOut), discoverUnchanged: discoverOut === discoverIn, tags };
}

const ep = (id, show = "Show A") => ({
  id, show, title: `Title ${id}`, apple_collection_id: 1, apple_track_id: 2,
  apple_episode_url: null, release_date: "2026-10-01", duration_min: 40,
  artwork_url: "https://example.test/a.jpg", topics: ["history/technology"], explicit: false,
});

const words = (n) => Array.from({ length: n }, (_, i) => `word${i + 1}`).join(" ");
const tagList = (n) => Array.from({ length: n }, (_, i) => `tag-${i + 1}`);
const edit = (over = {}) => ({ hook: words(10), tags: tagList(5), ...over });

/* ------------------------------------------------- characterization: stdout */

test("nothing to merge: exit 0 and exactly the one summary line, nothing written", () => {
  /* KILLED BY: rewording `MERGE: 0 items added (nothing to merge).` in merge.mjs,
     or `process.exit(0)` -> `process.exit(4)` on that branch. */
  const r = runMerge({ resolved: [ep("a")], edits: { a: edit() }, present: [{ id: "a" }] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "MERGE: 0 items added (nothing to merge).\n");
  assert.equal(r.discoverUnchanged, true);
});

test("nothing to merge with unedited items: the summary line plus the skipped count", () => {
  /* KILLED BY: dropping the `if (skippedNoEdit.length) console.log(...)` line on
     the nothing branch. */
  const r = runMerge({ resolved: [ep("a"), ep("b")], edits: {} });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    "MERGE: 0 items added (nothing to merge).\n  2 resolved item(s) had no edit and were skipped.\n"
  );
  assert.equal(r.discoverUnchanged, true);
});

test("N added: exit 0 and the ADDED / SHOWS / SKIPPED lines, byte for byte", () => {
  /* KILLED BY: rewording `ADDED ${added} items. built_at=${now}`, or stamping a
     different time on the line than on discover.json's built_at. */
  const r = runMerge({
    resolved: [ep("a"), ep("b", "Show B"), ep("c", "Show B"), ep("d", "Show C"), ep("e", "Show C")],
    edits: { a: edit(), b: edit(), c: edit(), e: edit() },
    present: [{ id: "e" }],
  });
  assert.equal(r.status, 0, r.stderr);
  const builtAt = r.discover.built_at;
  assert.match(builtAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(r.tags.built_at, builtAt);
  assert.equal(
    r.stdout,
    `ADDED 3 items. built_at=${builtAt}\n` +
      "SHOWS: Show A, Show B\n" +
      "SKIPPED (no edit authored): 1\n  Show C :: Title d (d)\n" +
      "SKIPPED (already present): 1\n"
  );
  assert.deepEqual(r.discover.items.map((i) => i.id), ["e", "a", "b", "c"]);
});

/* ------------------------------------------ characterization: copy refusals */

/** One refused run: exit 1, the failure block on stderr, nothing on stdout,
    and the catalogue untouched. */
function refused(edits, resolved = Object.keys(edits).map((id) => ep(id))) {
  const r = runMerge({ resolved, edits });
  assert.equal(r.status, 1, `expected a refusal, got exit ${r.status}: ${r.stdout}`);
  assert.equal(r.stdout, "");
  assert.equal(r.discoverUnchanged, true, "a refused run wrote discover.json");
  return r.stderr;
}

test("a 17-word hook, a 4-tag item, a 13-tag item and a Bad_Tag / BadTag are each refused with exit 1", () => {
  /* KILLED BY: `> 16` -> `> 17` on the hook check, `< 5` -> `< 4` or
     `> 12` -> `> 13` on the tag check, or loosening the tag pattern to `/i`
     ("BadTag" then passes; "Bad_Tag" fails on the underscore either way).
     The exact stderr bytes are the characterization: the messages must keep
     their text when the numbers move. */
  assert.equal(
    refused({ h: edit({ hook: words(17) }) }),
    "COPY RULE FAILURES:\nh: hook 17w > 16\n"
  );
  assert.equal(
    refused({ few: edit({ tags: tagList(4) }) }),
    "COPY RULE FAILURES:\nfew: 4 tags (need 5-12)\n"
  );
  assert.equal(
    refused({ many: edit({ tags: tagList(13) }) }),
    "COPY RULE FAILURES:\nmany: 13 tags (need 5-12)\n"
  );
  assert.equal(
    refused({ bad: edit({ tags: [...tagList(4), "Bad_Tag", "BadTag"] }) }),
    'COPY RULE FAILURES:\nbad: bad tag "Bad_Tag"\nbad: bad tag "BadTag"\n'
  );
});

test("the legal edges merge: a 16-word hook, 5 tags and 12 tags", () => {
  /* The bound that refuses the legal maximum is the one that gets deleted
     rather than fixed. KILLED BY: `> 16` -> `> 15`, `< 5` -> `< 6`,
     `> 12` -> `> 11`. */
  const r = runMerge({
    resolved: [ep("h"), ep("five"), ep("twelve")],
    edits: { h: edit({ hook: words(16) }), five: edit({ tags: tagList(5) }), twelve: edit({ tags: tagList(12) }) },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ADDED 3 items\. /);
});
