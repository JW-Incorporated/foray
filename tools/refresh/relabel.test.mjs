/* `tools/refresh/relabel.mjs` (PKG-06; #547, #560 §6.3) — the validated
 * per-episode relabel of committed discover items.
 *
 * Every test runs the REAL script as a subprocess against a 3-item fixture in a
 * temp dir via `RELABEL_DISCOVER_PATH`, the override an operator would use —
 * so the argument parsing, the exit code, the all-or-nothing write and the
 * write-back format are what is tested. The taxonomy is the committed
 * data/taxonomy.json (the ids below are real nodes), because validating against
 * the real topic space is the point of the tool.
 *
 * EVERY TEST NAMES THE MUTATION THAT KILLS IT, per CLAUDE.md, and each was
 * applied and observed red before this file was committed.
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
const SCRIPT = join(HERE, "relabel.mjs");

function fixtureItems() {
  return [
    { id: "sysk--a", show: "Stuff You Should Know", topics: ["history/technology", "science/materials"], topics_source: "show", explicit: false },
    { id: "sysk--b", show: "Stuff You Should Know", topics: ["history/technology", "science/materials"], topics_source: "show", explicit: null },
    { id: "eng--c", show: "Engines of Our Ingenuity", topics: ["history/technology"], topics_source: "show", explicit: false },
  ];
}

function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "foray-relabel-"));
  const discoverPath = join(dir, "discover.json");
  writeFileSync(discoverPath, JSON.stringify({ built_at: "x", items: fixtureItems() }, null, 2) + "\n");
  const run = (...args) => {
    try {
      const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, RELABEL_DISCOVER_PATH: discoverPath },
      });
      return { status: 0, stdout, stderr: "" };
    } catch (e) {
      return { status: e.status ?? 1, stdout: e.stdout || "", stderr: e.stderr || "" };
    }
  };
  const raw = () => readFileSync(discoverPath, "utf8");
  const batch = (entries) => {
    const f = join(dir, "batch.json");
    writeFileSync(f, JSON.stringify(entries));
    return f;
  };
  try {
    return fn({ run, raw, batch, items: () => JSON.parse(raw()).items });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("relabels one item and stamps topics_source 'episode'", () => {
  /* The single-item path end to end: the new topics land on that item only, it
     is restamped as judged per episode, the other items are untouched, and the
     file keeps the committed 2-space + trailing-newline format.
     KILLED BY: deleting `item.topics_source = "episode";` in applyRelabel — the
     relabelled item then still claims its show's inherited label. */
  withFixture(({ run, raw, items }) => {
    const r = run("--id", "sysk--b", "--topics", "nature/earth-science");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "sysk--b: [history/technology, science/materials] -> [nature/earth-science]");
    const out = items();
    assert.deepEqual(
      out.map((i) => [i.id, i.topics, i.topics_source]),
      [
        ["sysk--a", ["history/technology", "science/materials"], "show"],
        ["sysk--b", ["nature/earth-science"], "episode"],
        ["eng--c", ["history/technology"], "show"],
      ]
    );
    assert.ok(raw().endsWith("}\n") && raw().includes('\n  "items": ['), "2-space JSON with a trailing newline");
  });
});

test("refuses an unknown taxonomy id and writes nothing", () => {
  /* The validation is episodeTopics', so a relabel can never accept a label
     the nightly would refuse. A batch whose SECOND entry is bad must leave the
     first entry unwritten too.
     KILLED BY: `const next = e.topics;` in place of the episodeTopics call in
     planRelabel — the bogus id is then written into the pool. */
  withFixture(({ run, raw, batch }) => {
    const before = raw();
    const r = run("--from", batch([
      { id: "sysk--a", topics: ["nature/earth-science"] },
      { id: "sysk--b", topics: ["science/not-a-node"] },
    ]));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not taxonomy node ids: "science\/not-a-node"/);
    assert.equal(raw(), before, "a refused batch must not write");
  });
});

test("refuses when any id in a batch is missing, before writing", () => {
  /* All or nothing: every id is looked up before any item is touched, and
     every missing id is named in one message so the operator fixes the batch
     once. The first entry is valid, so a writer that went item by item would
     have written it before reaching the missing ones.
     KILLED BY: writing per item — replacing the single planRelabel/applyRelabel/
     writeFileSync sequence in main with a loop that plans, applies and writes
     one entry at a time; sysk--a is then on disk when the run fails. */
  withFixture(({ run, raw, batch }) => {
    const before = raw();
    const r = run("--from", batch([
      { id: "sysk--a", topics: ["nature/earth-science"] },
      { id: "gone--x", topics: ["history/technology"] },
      { id: "gone--y", topics: ["history/technology"] },
    ]));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /"gone--x", "gone--y"/, "every missing id is named");
    assert.equal(raw(), before, "a batch with a missing id must not write");
  });
});

test("--dry-run changes nothing on disk", () => {
  /* The rehearsal PKG-07 runs first: it prints exactly what a real run would,
     and leaves the file byte-identical.
     KILLED BY: deleting `if (args.dryRun) return;` in main — the dry run then
     writes the relabel. */
  withFixture(({ run, raw, batch }) => {
    const before = raw();
    const r = run("--from", batch([
      { id: "sysk--a", topics: ["nature/earth-science"] },
      { id: "eng--c", topics: ["history/technology", "engineering/energy-fusion"] },
    ]), "--dry-run");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split(/\r?\n/), [
      "sysk--a: [history/technology, science/materials] -> [nature/earth-science]",
      "eng--c: [history/technology] -> [history/technology, engineering/energy-fusion]",
    ]);
    assert.equal(raw(), before, "--dry-run must not write");
  });
});
