/* merge.mjs's CONTRACTS (CH2-14, issues T1-14 and T1-22 of
 * docs/roadmap/code-health-2.md).
 *   Run: node --test tools/refresh/merge.test.mjs
 *
 * merge.mjs is the nightly's write path, and two other files depend on things
 * it says rather than things it exports:
 *
 *   1. ITS STDOUT. `nightly-runner.mjs finish` decides "nothing to do" (exit 4)
 *      vs "merged N, open a PR" vs MERGE_UNPARSED (exit 5) by reading merge's
 *      summary line. A reworded line used to make every nightly exit 5 after a
 *      successful merge: catalogue written, no PR opened, the silent-night shape
 *      of #290. The lines are now MERGE_SUMMARY, exported from merge.mjs and
 *      parsed by the runner through the same object.
 *   2. ITS COPY-RULE LIMITS. The hook word cap and the 5-12 tag bounds were
 *      literals in merge.mjs while backend/test/copyRules.test.ts (the CI gate)
 *      read MAX_HOOK_WORDS from backend/src/copy/rules.js. Raising the cap there
 *      left merge refusing hooks the gate passed. All four limits now come from
 *      rules.js.
 *
 * The first block is CHARACTERIZATION, written and run green against the
 * unmodified script before CH2-14 touched it: exit codes and stdout bytes of
 * the real merge.mjs, spawned, for nothing-to-merge, N-added and each copy-rule
 * refusal. The refactor had to keep all of it byte-identical.
 *
 * The spawned runs are also the Windows witness for merge's new entry guard: a
 * guard that is false on Windows makes the CLI print nothing and exit 0, which
 * every stdout assertion below catches (tools/entrypoint-guards.test.mjs only
 * checks the guard's text).
 *
 * Every test names the one-line mutation that kills it. All were run.
 * The floor for this suite lives in test/suite-integrity.test.js.            */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import { MERGE_SUMMARY } from "./merge.mjs";
import copyRules from "../../backend/src/copy/rules.js";

const { MAX_HOOK_WORDS, MIN_TAGS, MAX_TAGS, TAG_RE } = copyRules;

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
     The exact stderr bytes are the characterization: the messages kept their
     text when the numbers became rules.js's. */
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

/* ------------------------------------------------------ CH2-14's contracts */

test("MERGE_SUMMARY round-trips: the runner's parser reads back what merge's formatter writes", () => {
  /* The two halves of the T1-22 contract, now one object. KILLED BY: rewording
     `added` (e.g. `Added ${n} items.`) without touching parseAdded, or dropping
     the nothing-line check from parseAdded (it would return null, which the
     runner reports as MERGE_UNPARSED, exit 5). */
  for (const n of [1, 17, 240]) {
    assert.equal(MERGE_SUMMARY.parseAdded(MERGE_SUMMARY.added(n, "2026-10-07T07:00:00.000Z") + "\n"), n);
  }
  assert.equal(MERGE_SUMMARY.parseAdded(MERGE_SUMMARY.nothing + "\n  2 resolved item(s) had no edit and were skipped.\n"), 0);
  assert.equal(MERGE_SUMMARY.parseAdded("COPY RULE FAILURES:\nx: hook 17w > 16\n"), null);
  assert.equal(MERGE_SUMMARY.parseAdded(""), null);
  // A CRLF stream (a Windows pipe) still parses.
  assert.equal(MERGE_SUMMARY.parseAdded(MERGE_SUMMARY.nothing + "\r\n"), 0);
});

test("the REAL merge's stdout parses to the count it merged, through the exported parser", () => {
  /* The round-trip above proves the object agrees with itself; this proves the
     script prints through it. KILLED BY: merge.mjs printing its ADDED line by
     hand in any wording but MERGE_SUMMARY.added's, or
     `console.log("MERGE: nothing merged")` on the nothing branch. */
  const two = runMerge({ resolved: [ep("a"), ep("b")], edits: { a: edit(), b: edit() } });
  assert.equal(two.status, 0, two.stderr);
  assert.equal(MERGE_SUMMARY.parseAdded(two.stdout), 2);
  const none = runMerge({ resolved: [ep("a")], edits: {} });
  assert.equal(none.status, 0, none.stderr);
  assert.equal(MERGE_SUMMARY.parseAdded(none.stdout), 0);
});

test("merge's copy limits ARE rules.js's: the shared cap and bounds, at their edges", () => {
  /* T1-14. Built from the constants the CI gate (backend/test/copyRules.test.ts)
     reads, so a limit changed in rules.js moves this test with it, and a limit
     retyped as a literal in merge.mjs does not. KILLED BY (run with rules.js's
     MAX_HOOK_WORDS raised to 17): typing `> 16` back into merge.mjs — a
     17-word hook the gate now passes is refused here. Likewise `< 5` / `> 12`
     against a moved MIN_TAGS / MAX_TAGS, and a private tag pattern against
     TAG_RE. An `i` flag on TAG_RE itself is killed by "BadTag". */
  const ok = runMerge({
    resolved: [ep("h"), ep("lo"), ep("hi")],
    edits: {
      h: edit({ hook: words(MAX_HOOK_WORDS) }),
      lo: edit({ tags: tagList(MIN_TAGS) }),
      hi: edit({ tags: tagList(MAX_TAGS) }),
    },
  });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(MERGE_SUMMARY.parseAdded(ok.stdout), 3);

  const err = refused({
    h: edit({ hook: words(MAX_HOOK_WORDS + 1) }),
    lo: edit({ tags: tagList(MIN_TAGS - 1) }),
    hi: edit({ tags: tagList(MAX_TAGS + 1) }),
    bad: edit({ tags: [...tagList(MIN_TAGS - 2), "Bad_Tag", "BadTag"] }),
  });
  assert.equal(
    err,
    "COPY RULE FAILURES:\n" +
      `h: hook ${MAX_HOOK_WORDS + 1}w > ${MAX_HOOK_WORDS}\n` +
      `lo: ${MIN_TAGS - 1} tags (need ${MIN_TAGS}-${MAX_TAGS})\n` +
      `hi: ${MAX_TAGS + 1} tags (need ${MIN_TAGS}-${MAX_TAGS})\n` +
      'bad: bad tag "Bad_Tag"\n' +
      'bad: bad tag "BadTag"\n'
  );
  assert.equal(TAG_RE.test("Bad_Tag"), false);
  assert.equal(TAG_RE.test("BadTag"), false, "TAG_RE is case-sensitive: an `i` flag lets BadTag through");
});

test("importing merge.mjs merges nothing: the body runs only under the entry guard", () => {
  /* nightly-runner.mjs imports MERGE_SUMMARY from here; before CH2-14 merge.mjs
     was top-level code, so that import would have run a merge. Pointed at a
     resolved file that does not exist, an unguarded body throws ENOENT.
     KILLED BY: replacing the guard line with a bare `process.exitCode = run();`
     (run: the whole file goes red, because this suite's own static import of
     MERGE_SUMMARY then runs a merge and dies on ENOENT — this test says why). */
  const dir = mkdtempSync(join(tmpdir(), "foray-merge-import-"));
  try {
    const out = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", `const m = await import(${JSON.stringify(pathToFileURL(MERGE).href)}); console.log(typeof m.run, typeof m.MERGE_SUMMARY.parseAdded);`],
      {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, RESOLVED_PATH: join(dir, "missing.json"), EDITS_PATH: join(dir, "missing.json") },
      }
    );
    assert.equal(out, "function function\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
