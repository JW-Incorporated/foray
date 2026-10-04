/* `tools/refresh/backfill-provenance.mjs` (PKG-01; #547, #560 §6.3) — the
 * one-shot that stamped `topics_source` and an always-present `explicit` key
 * onto every discover item merged before `merge.mjs` wrote them.
 *
 * Every test runs the REAL script as a subprocess against a 3-item fixture in a
 * temp dir, via the same env overrides (`BACKFILL_DISCOVER_PATH`,
 * `BACKFILL_CATALOG_PATH`) an operator would use — so the file I/O, the
 * `--check` exit code and the write-back format are what is tested, not a
 * stand-in for them.
 *
 * EVERY TEST NAMES THE ONE-LINE MUTATION THAT KILLS IT, per CLAUDE.md, and each
 * was applied and observed red before this file was committed.
 *
 * The floor for this suite lives in test/suite-integrity.test.js.            */

import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "backfill-provenance.mjs");

const CATALOG = {
  shows: [
    { title: "Engines of Our Ingenuity", taxonomy_node_ids: ["history/technology"], explicit: false },
    { title: "Stuff You Should Know", taxonomy_node_ids: ["history/technology", "science/materials"], explicit: false },
  ],
};

/** Three items: one carrying its show's label (re-ordered, to prove the
    comparison is order-insensitive), one relabelled per episode with no
    explicit key, and one whose show is not in the catalogue. */
function fixtureItems() {
  return [
    { id: "sysk--a", show: "Stuff You Should Know", topics: ["science/materials", "history/technology"], explicit: false },
    { id: "sysk--b", show: "Stuff You Should Know", topics: ["nature/earth-science"] },
    { id: "gone--c", show: "A Show Not In The Catalogue", topics: ["history/technology"], explicit: true },
  ];
}

function withFixture(fn, items = fixtureItems()) {
  const dir = mkdtempSync(join(tmpdir(), "foray-backfill-prov-"));
  const discoverPath = join(dir, "discover.json");
  writeFileSync(discoverPath, JSON.stringify({ built_at: "x", items }, null, 2) + "\n");
  writeFileSync(join(dir, "catalog.json"), JSON.stringify(CATALOG));
  const run = (...args) => {
    try {
      const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, BACKFILL_DISCOVER_PATH: discoverPath, BACKFILL_CATALOG_PATH: join(dir, "catalog.json") },
      });
      return { status: 0, stdout };
    } catch (e) {
      return { status: e.status ?? 1, stdout: e.stdout || "", stderr: e.stderr || "" };
    }
  };
  const raw = () => readFileSync(discoverPath, "utf8");
  try {
    return fn({ run, raw, items: () => JSON.parse(raw()).items });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("--check exits 1 when an item lacks topics_source", () => {
  /* The gate the data-topic-integrity header points at. Every item here
     already has an explicit key, so only the missing topics_source can fail it.
     KILLED BY: `if (false) {` on the `if (wouldChange)` branch inside `if (check)`
     — --check then exits 0 on unstamped data. Also asserts --check writes
     nothing (KILLED BY: moving the writeFileSync above the `if (check)` block). */
  const items = fixtureItems().map((i) => ({ explicit: null, ...i }));
  withFixture(({ run, raw }) => {
    const before = raw();
    const r = run("--check");
    assert.equal(r.status, 1, "an item without topics_source must fail --check");
    assert.match(r.stderr, /lack topics_source/);
    assert.equal(raw(), before, "--check must not write");
  }, items);
});

test("stamps 'show' when topics equal the show's nodes and 'episode' otherwise", () => {
  /* The inference rule for items merged before provenance existed: the
     inherited label, order-insensitively, is "show"; anything else — including
     an item whose show is not in the catalogue — is "episode". A missing
     explicit key becomes null; a present one is untouched.
     KILLED BY: `item.topics_source = "show";` (drop the topicKey comparison) —
     sysk--b and gone--c then read as inherited. */
  withFixture(({ run, items }) => {
    const r = run();
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), { stamped_source: 3, stamped_explicit: 1, unchanged: 0 });
    assert.deepEqual(
      items().map((i) => [i.id, i.topics_source, i.explicit]),
      [["sysk--a", "show", false], ["sysk--b", "episode", null], ["gone--c", "episode", true]]
    );
  });
});

test("is idempotent: a second run changes nothing", () => {
  /* A re-run must never overwrite provenance already on an item — including
     what merge.mjs writes for new nightly items — and must leave the file
     byte-identical, so --check is 0 after a run.
     KILLED BY: `if (true) {` in place of `if (!("topics_source" in item)) {` —
     the second run then restamps every item and reports stamped_source 3. */
  withFixture(({ run, raw }) => {
    assert.equal(run().status, 0);
    const after = raw();
    const second = run();
    assert.equal(second.status, 0);
    assert.deepEqual(JSON.parse(second.stdout), { stamped_source: 0, stamped_explicit: 0, unchanged: 3 });
    assert.equal(raw(), after, "a second run must not rewrite the file");
    assert.equal(run("--check").status, 0, "--check is 0 after a run");
  });
});
