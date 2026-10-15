/* tools/recommender/build-ratings-client.mjs: the client projection of the
   persona ratings (RV-15, docs/roadmap/recommender-v1.md D8; #1380).

   Two REAL DATA tests read the committed files (ratings.json from the RV-13
   pilot, data/catalog.json, persona-profiles.json and the committed
   ratings-client.json); the rest run on synthetic fixtures built here and
   write only to a temp directory. Offline: no model, no network.

   Every test names the one-line mutation of build-ratings-client.mjs that
   turns it red; each was run red before this suite was committed. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateClientFile } from "./schema.mjs";
import {
  CLIENT_BUDGET_BYTES,
  DEFAULT_PATHS,
  buildRatingsClient,
  fitDigit,
  keptPersonaIds,
  runBuild,
  serializeClient,
} from "./build-ratings-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "build-ratings-client.mjs");

/* ---------- synthetic fixtures ---------- */

const PROFILES = {
  version: 1,
  personas: [
    { id: "alpha" },
    { id: "beta", pruned: true, merged_into: "alpha" },
    { id: "gamma" },
  ],
};

/** One ratings.json persona array (RV-02's ten slots) with the given fit. */
const arr = (fit) => [fit, 0.4, 3, 3, 3, 3, null, null, null, 0.5];

function ratedShow({ personas, tier = "show-metadata", explicit = false }) {
  const top = Object.keys(personas)[0];
  return {
    evidence_tier: tier,
    summary: "A weekly show about how ordinary machines are built and repaired.",
    format: "interview",
    flags: { explicit, harassment: false, medical_financial_advice: false, injection_suspected: false },
    top_reason: "Patient explanations of how things work, one machine at a time.",
    top_persona: top,
    passes: 1,
    personas: Object.fromEntries(Object.entries(personas).map(([pid, fit]) => [pid, arr(fit)])),
  };
}

function ratingsDoc(shows) {
  return { version: 1, rubric_version: 1, built_at: "2026-10-14T00:00:00.000Z", merged_batches: ["b1"], shows };
}

function catalogDoc(shows) {
  return { version: 1, shows };
}

function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "rv15-"));
}

/* ---------- REAL DATA ---------- */

test("REAL DATA: the committed client file is the builder's output", () => {
  // mutation: in runBuild's check branch, `if (onDisk !== text)` -> `if (false)`
  const res = runBuild({ check: true });
  assert.equal(res.code, 0, res.message);

  const dir = tempDir();
  try {
    const committed = readFileSync(DEFAULT_PATHS.out, "utf8");
    const m = /"f":"(\d)/.exec(committed);
    assert.ok(m, "the committed file has at least one f string");
    const flipped = m[1] === "1" ? "2" : "1";
    const edited = committed.slice(0, m.index + 5) + flipped + committed.slice(m.index + 6);
    assert.notEqual(edited, committed);
    const out = path.join(dir, "ratings-client.json");
    writeFileSync(out, edited);
    const stale = runBuild({ check: true, outPath: out });
    assert.equal(stale.code, 1, "one edited digit is drift");
    assert.match(stale.message, /stale/);
    assert.equal(readFileSync(out, "utf8"), edited, "--check never rewrites the file");

    /* The CLI itself: exit 0 on the committed file, exit 1 on the edited copy
       (the Windows entrypoint-guard class, tools/entrypoint-guards.test.mjs). */
    const ok = spawnSync(process.execPath, [SCRIPT, "--check"], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /up to date/);
    const bad = spawnSync(process.execPath, [SCRIPT, "--check", "--out", out], { encoding: "utf8" });
    assert.equal(bad.status, 1, bad.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("REAL DATA: the client file is under CLIENT_BUDGET_BYTES", () => {
  // mutation: CLIENT_BUDGET_BYTES = 1 * 1024
  const size = statSync(DEFAULT_PATHS.out).size;
  assert.ok(size <= CLIENT_BUDGET_BYTES, `${size} B is over ${CLIENT_BUDGET_BYTES} B`);
  assert.equal(CLIENT_BUDGET_BYTES, 40 * 1024, "D8 pins the budget at 40 KB");
  const doc = JSON.parse(readFileSync(DEFAULT_PATHS.out, "utf8"));
  assert.deepEqual(validateClientFile(doc), []);
  assert.ok(Object.keys(doc.shows).length > 0, "the pilot rated curated shows, so the file is not empty");
});

/* ---------- synthetic ---------- */

test("f has one digit per kept persona", () => {
  // mutation: `const f = personas.map(` -> `const f = profiles.personas.map((p) => p.id).map(`
  // (pruned personas in f, but not in `personas`)
  const ratings = ratingsDoc({ "show-a": ratedShow({ personas: { alpha: 4, beta: 5, gamma: 2 } }) });
  const doc = buildRatingsClient(ratings, catalogDoc([{ show_id: "show-a", explicit: false }]), PROFILES);
  assert.deepEqual(doc.personas, ["alpha", "gamma"]);
  assert.equal(doc.shows["show-a"].f, "42");
  assert.equal(doc.shows["show-a"].f.length, doc.personas.length);
});

test("a pruned persona is absent from personas", () => {
  // mutation: drop `&& p.pruned !== true` from keptPersonaIds
  assert.deepEqual(keptPersonaIds(PROFILES), ["alpha", "gamma"]);
  assert.deepEqual(keptPersonaIds({ personas: [{ id: "a", pruned: false }, { id: "b" }] }), ["a", "b"]);
});

test("explicit is catalog OR rating flag", () => {
  // mutation: `show.explicit === true || rated.flags?.explicit === true` -> `rated.flags?.explicit === true`
  const ratings = ratingsDoc({
    cat: ratedShow({ personas: { alpha: 3 }, explicit: false }),
    rat: ratedShow({ personas: { alpha: 3 }, explicit: true }),
    neither: ratedShow({ personas: { alpha: 3 }, explicit: false }),
    "null-cat": ratedShow({ personas: { alpha: 3 }, explicit: false }),
  });
  const catalog = catalogDoc([
    { show_id: "cat", explicit: true },
    { show_id: "rat", explicit: false },
    { show_id: "neither", explicit: false },
    { show_id: "null-cat", explicit: null },
  ]);
  const doc = buildRatingsClient(ratings, catalog, PROFILES);
  assert.equal(doc.shows.cat.x, 1, "the catalogue's explicit rating alone is enough");
  assert.equal(doc.shows.rat.x, 1, "the raters' flag alone is enough");
  assert.equal(doc.shows.neither.x, 0);
  assert.equal(doc.shows["null-cat"].x, 0, "an unrated (null) catalogue field is not explicit");
});

test("a show with no rating is absent, not zero-filled", () => {
  // mutation: replace the no-rating `continue` with a zero row:
  //   `if (!hasOwnProperty(ratings.shows, id)) { entries.push([id, { f: "0".repeat(personas.length), x: 0, t: "s" }]); continue; }`
  const ratings = ratingsDoc({ rated: ratedShow({ personas: { alpha: 5, gamma: 1 } }) });
  const catalog = catalogDoc([{ show_id: "rated", explicit: false }, { show_id: "unrated", explicit: false }]);
  const doc = buildRatingsClient(ratings, catalog, PROFILES);
  assert.deepEqual(Object.keys(doc.shows), ["rated"]);
  assert.equal(doc.shows.rated.f, "51");
});

test("a show rated only by pruned personas is absent, and a kept persona with no rating is 0", () => {
  // mutation: delete `if (/^0*$/.test(f)) continue;`
  const ratings = ratingsDoc({
    "only-pruned": ratedShow({ personas: { beta: 4 } }),
    partial: ratedShow({ personas: { gamma: 3 } }),
  });
  const catalog = catalogDoc([{ show_id: "only-pruned" }, { show_id: "partial" }]);
  const doc = buildRatingsClient(ratings, catalog, PROFILES);
  assert.deepEqual(Object.keys(doc.shows), ["partial"]);
  assert.equal(doc.shows.partial.f, "03");
});

test("fit digits round half-up a multi-pass mean and clamp to 1-5; no fit is 0", () => {
  // mutation: `Math.floor(fit + 0.5)` -> `Math.floor(fit)`
  assert.equal(fitDigit(arr(3.5)), 4);
  assert.equal(fitDigit(arr(2.4)), 2);
  assert.equal(fitDigit(arr(4.7)), 5);
  assert.equal(fitDigit(arr(1)), 1);
  assert.equal(fitDigit(undefined), 0);
  assert.equal(fitDigit([null]), 0);
  assert.equal(fitDigit([9]), 5);
});

test("only curated shows are projected, keyed by show_id with the tier letter", () => {
  // mutation: `t: CLIENT_TIER_CODES[rated.evidence_tier]` -> `t: "e"`
  // (the breadth key "1234567" also kills a builder that walks ratings.shows instead of catalog.shows)
  const ratings = ratingsDoc({
    "curated-t": ratedShow({ personas: { alpha: 4 }, tier: "transcript" }),
    "curated-e": ratedShow({ personas: { alpha: 4 }, tier: "episode-metadata" }),
    "1234567": ratedShow({ personas: { alpha: 5 } }),
  });
  const catalog = catalogDoc([
    { show_id: "curated-t", apple_collection_id: 1 },
    { show_id: "curated-e", apple_collection_id: 2 },
  ]);
  const doc = buildRatingsClient(ratings, catalog, { personas: [{ id: "alpha" }] });
  assert.deepEqual(Object.keys(doc.shows).sort(), ["curated-e", "curated-t"]);
  assert.equal(doc.shows["curated-t"].t, "t");
  assert.equal(doc.shows["curated-e"].t, "e");
});

test("over budget the builder exits 1 and writes nothing", () => {
  // mutation: delete the `if (bytes > budgetBytes) return { code: 1, ... }` block
  const dir = tempDir();
  try {
    const files = {
      ratingsPath: path.join(dir, "ratings.json"),
      catalogPath: path.join(dir, "catalog.json"),
      profilesPath: path.join(dir, "profiles.json"),
      outPath: path.join(dir, "ratings-client.json"),
    };
    writeFileSync(files.ratingsPath, JSON.stringify(ratingsDoc({ s1: ratedShow({ personas: { alpha: 4 } }) })));
    writeFileSync(files.catalogPath, JSON.stringify(catalogDoc([{ show_id: "s1" }])));
    writeFileSync(files.profilesPath, JSON.stringify(PROFILES));
    const over = runBuild({ ...files, budgetBytes: 20 });
    assert.equal(over.code, 1);
    assert.match(over.message, /over the 20 B budget/);
    assert.equal(existsSync(files.outPath), false, "nothing written over budget");

    const ok = runBuild(files);
    assert.equal(ok.code, 0, ok.message);
    const text = readFileSync(files.outPath, "utf8");
    assert.equal(text, serializeClient(JSON.parse(text)), "single-line JSON plus a newline");
    assert.ok(text.endsWith("}\n") && !text.slice(0, -1).includes("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an invalid ratings.json is refused, nothing written", () => {
  // mutation: delete the `if (ratingProblems.length > 0) throw` block in buildRatingsClient
  const bad = ratingsDoc({ s1: ratedShow({ personas: { alpha: 4 } }) });
  bad.shows.s1.personas.alpha = [4, 0.4]; // two slots, not ten
  assert.throws(() => buildRatingsClient(bad, catalogDoc([{ show_id: "s1" }]), PROFILES), /ratings\.json is invalid/);
});
