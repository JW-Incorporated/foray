/* Tests for the golden set v1 (GV-45, W1-14).
 * Run: node --test tools/generation-bench/golden/golden.test.mjs
 *
 * WHAT IS AT RISK
 * The golden set is what every later generation change is judged on, and
 * every way it can go wrong is quiet. A stratum can be over-filled, so the
 * average leans towards well-stocked subjects. A listened prompt can be lost,
 * so a stage swap is judged on nine pairs. A reference can name a Foray that
 * no longer exists. A strata proposal can change with the order a file
 * happened to list its rows in. Worst, a locked set can be edited in place,
 * and then two runs a month apart compare different benchmarks. Each test
 * below pins one of those. Everything is the committed data or synthetic: no
 * model, no network, no transcript body.
 *
 * Each test names the one-line mutation that makes it fail (CLAUDE.md rule 1).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  countSupply,
  loadInputs,
  MIN_TOPIC_SUPPLY,
  propose,
  STRATA,
  STRATA_TARGETS,
  stratumForCounts
} from "./select.mjs";
import {
  buildLock,
  checkLock,
  DEFAULT_LOCK,
  DEFAULT_MANIFEST,
  expectedIds,
  loadContext,
  main,
  manifestSha,
  MAX_PROMPT_CHARS,
  strataDrift,
  validateManifest
} from "./validate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

const MANIFEST_BYTES = fs.readFileSync(DEFAULT_MANIFEST);
const MANIFEST = JSON.parse(MANIFEST_BYTES.toString("utf8"));
const CTX = loadContext(REPO_ROOT);
/* Read once: data/breadth-classification.json is 18 MB. */
const INPUTS = loadInputs(REPO_ROOT);

const clone = (v) => structuredClone(v);
const errorsOf = (entries) => validateManifest(entries, CTX).errors.join("\n");
const byId = (entries, id) => entries.find((e) => e.id === id);

function sink() {
  let text = "";
  return { write: (s) => void (text += s), get text() { return text; } };
}

function syntheticReport(bytes, entries, over = {}) {
  return {
    dry_run: false,
    prompts: { file: "golden-v1.json", sha256: rawSha(bytes), count: entries.length },
    corpus: {
      showsOnDisk: 22,
      fingerprint: { sha256: "c0ffee".padEnd(64, "0"), rows: 1200, rowsHashedBySize: 0, shows: 22, indexVersion: 2, extra: null }
    },
    entries: entries.map((e) => ({ promptId: e.id, outcome: "generated" })),
    ...over
  };
}

function rawSha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
/* ------------------------------------------------------------------ */
/* The committed manifest                                               */
/* ------------------------------------------------------------------ */

/* Mutation: STRATA_TARGETS "multi-show": 30 -> 29 in select.mjs (the
   validator then refuses the committed 30), or flip one listened: false ->
   true in golden-v1.json (11 listened). */
test("the committed manifest is valid: 50 prompts g01..g50, 10 listened, strata 30/10/5/5", () => {
  const result = validateManifest(MANIFEST, CTX);
  assert.deepEqual(result.errors, []);
  assert.equal(MANIFEST.length, 50);
  assert.deepEqual(MANIFEST.map((e) => e.id), expectedIds());
  assert.equal(result.counts.listened, 10);
  assert.deepEqual(result.counts.strata, { "multi-show": 30, "single-show": 10, ambiguous: 5, "near-no-supply": 5 });
  assert.deepEqual(STRATA_TARGETS, { "multi-show": 30, "single-show": 10, ambiguous: 5, "near-no-supply": 5 });
  for (const e of MANIFEST) {
    /* The PromptSpec shape generate-forays' normalizePrompts accepts. */
    assert.equal(typeof e.prompt, "string");
    assert.equal(e.bench, true, `${e.id} carries bench: true (GV-62)`);
  }
});

/* Mutation: change g03's forayId to "the-chain-reaction-x" in
   golden-v1.json, or drop the `!ctx.forayIds.has(ref.forayId)` clause in
   validateReference. */
test("every reference names a Foray in data/forays.json, and every Claude-written candidate is a listened reference", () => {
  const forays = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "data", "forays.json"), "utf8")).forays;
  const referenced = MANIFEST.filter((e) => e.reference?.kind === "forays-json").map((e) => e.reference.forayId);
  for (const id of referenced) assert.ok(forays.some((f) => f.id === id), `${id} is in data/forays.json`);
  const generated = forays.filter((f) => f.generated === true).map((f) => f.id).sort();
  assert.deepEqual([...referenced].sort(), generated, "the 4 generated Forays are each a reference");
  const founder = MANIFEST.filter((e) => e.reference?.kind === "founder-candidate");
  assert.equal(founder.length, 1, "the 14 Sep germ-theory candidate");
  assert.match(founder[0].prompt, /germ theory/);
  for (const e of MANIFEST.filter((x) => x.reference)) assert.equal(e.listened, true, `${e.id} is listened`);

  const broken = clone(MANIFEST);
  byId(broken, "g03").reference.forayId = "the-chain-reaction-x";
  assert.match(errorsOf(broken), /g03.*not a Foray in data\/forays\.json/);
});

/* ------------------------------------------------------------------ */
/* The validator's refusals                                             */
/* ------------------------------------------------------------------ */

/* Mutation: `else if (ids.has(e.id))` -> `else if (false)`, or drop
   `.toLowerCase()` from normalisedPrompt (the case-only duplicate passes), or
   `!allowedIds.has(e.id)` -> `!/^g\d{2}$/.test(e.id)` (g51 and g00 pass). */
test("the validator refuses a duplicate id, an id outside g01..g50, and a duplicate prompt, ignoring case and spacing", () => {
  const dupId = clone(MANIFEST);
  byId(dupId, "g12").id = "g11";
  assert.match(errorsOf(dupId), /duplicate id g11/);

  for (const stray of ["g51", "g00"]) {
    const outside = clone(MANIFEST);
    byId(outside, "g50").id = stray;
    const errors = errorsOf(outside);
    assert.ok(errors.includes(`(${stray}): id must be g01..g50`), errors);
  }

  const dupPrompt = clone(MANIFEST);
  byId(dupPrompt, "g12").prompt = `${byId(dupPrompt, "g11").prompt.toUpperCase().replace(/ /g, "  ")}`;
  assert.match(errorsOf(dupPrompt), /\(g12\): duplicate prompt \(same as g11\)/);
});

/* Mutation: the `strata[s] !== STRATA_TARGETS[s]` check -> `false`, or
   `listened !== LISTENED` -> `listened > LISTENED` (9 listened passes). */
test("the validator refuses strata counts other than 30/10/5/5 and a listened count other than 10", () => {
  const moved = clone(MANIFEST);
  byId(moved, "g11").stratum = "single-show";
  const errors = errorsOf(moved);
  assert.match(errors, /stratum multi-show has 29 prompts; golden-v1 has 30/);
  assert.match(errors, /stratum single-show has 11 prompts; golden-v1 has 10/);

  const nine = clone(MANIFEST);
  byId(nine, "g10").listened = false;
  assert.match(errorsOf(nine), /9 prompts are listened; golden-v1 has exactly 10/);
  const eleven = clone(MANIFEST);
  byId(eleven, "g11").listened = true;
  assert.match(errorsOf(eleven), /11 prompts are listened/);

  assert.match(errorsOf(MANIFEST.slice(0, 49)), /the set has 49 entries/);
});

/* Mutation: drop the ENTRY_KEYS loop (a `script` key rides along), or
   `e.bench !== true` -> `e.bench === false` (a missing flag passes). */
test("the validator refuses an unknown key, a missing bench flag, an unknown node, an over-long prompt and a stray reference", () => {
  const extra = clone(MANIFEST);
  byId(extra, "g20").script = "narration text";
  assert.match(errorsOf(extra), /\(g20\): unknown key "script"/);

  const noBench = clone(MANIFEST);
  delete byId(noBench, "g21").bench;
  assert.match(errorsOf(noBench), /\(g21\): bench must be true/);

  const badNode = clone(MANIFEST);
  byId(badNode, "g22").nodes = ["food/not-a-node"];
  assert.match(errorsOf(badNode), /\(g22\): node "food\/not-a-node" is not in data\/taxonomy\.json/);

  const twoNodes = clone(MANIFEST);
  byId(twoNodes, "g23").nodes = ["food", "nature"];
  assert.match(errorsOf(twoNodes), /\(g23\): a multi-show prompt names exactly 1 node/);

  const long = clone(MANIFEST);
  byId(long, "g24").prompt = "x".repeat(MAX_PROMPT_CHARS + 1);
  assert.match(errorsOf(long), /\(g24\): prompt is 301 chars/);

  const stray = clone(MANIFEST);
  byId(stray, "g25").reference = { kind: "forays-json", forayId: "capital-types-1" };
  assert.match(errorsOf(stray), /\(g25\): a prompt with a reference is a listened prompt/);

  const committedCandidate = clone(MANIFEST);
  byId(committedCandidate, "g05").reference.file = "data/forays.json";
  assert.match(errorsOf(committedCandidate), /\(g05\): a founder-candidate file is a \.json path under backend\/data-local/);

  const badDuration = clone(MANIFEST);
  byId(badDuration, "g26").duration = "hour";
  assert.match(errorsOf(badDuration), /\(g26\): duration must be one of short, medium, long/);
});

/* Mutation: `if (ctx.families.get(nodes[a])?.has(nodes[b]))` -> `if (false)`
   (a parent and its child pass as two readings), or `nodes.length < 2` ->
   `nodes.length < 1`. */
test("an ambiguous prompt names at least two readings, and no two of them are one family", () => {
  const ambiguous = MANIFEST.filter((e) => e.stratum === "ambiguous");
  assert.equal(ambiguous.length, 5);
  for (const e of ambiguous) assert.ok(e.nodes.length >= 2, `${e.id} has two readings`);

  const one = clone(MANIFEST);
  byId(one, "g44").nodes = ["food/cooking-science"];
  assert.match(errorsOf(one), /\(g44\): an ambiguous prompt names at least 2 readings/);

  const family = clone(MANIFEST);
  byId(family, "g44").nodes = ["food", "food/cooking-science"];
  assert.match(errorsOf(family), /\(g44\): readings food and food\/cooking-science are one family/);
});

/* ------------------------------------------------------------------ */
/* select.mjs                                                           */
/* ------------------------------------------------------------------ */

function syntheticInputs() {
  return {
    nodes: [
      { id: "a", parent: null, label: "Alpha" },
      { id: "a/x", parent: "a", label: "Alpha science" },
      { id: "a/y", parent: "a", label: "Alpha history" },
      { id: "b", parent: null, label: "Beta" },
      { id: "b/z", parent: "b", label: "Beta science" }
    ],
    catalogShows: [
      { show_id: "s1", taxonomy_node_ids: ["a/x"] },
      { show_id: "s2", taxonomy_node_ids: ["a"] },
      { show_id: "s3", taxonomy_node_ids: ["b/z"] },
      { show_id: "s4", taxonomy_node_ids: ["b/z"] }
    ],
    digestRows: [
      ...Array.from({ length: 3 }, () => ({ show_id: "s1", cues: 10 })),
      { show_id: "s1", cues: 0 },
      ...Array.from({ length: 2 }, () => ({ show_id: "s2", cues: 5 })),
      { show_id: "s3", cues: 7 },
      ...Array.from({ length: 4 }, () => ({ show_id: "123", cues: 9 })),
      ...Array.from({ length: 2 }, () => ({ show_id: "456", cues: 9 }))
    ],
    breadthNodes: { 123: ["a/y"] },
    shas: { "data/x.json": "0".repeat(64) }
  };
}

/* Mutation: build the family from the node alone (`new Set([node.id])`, no
   ancestors or descendants) -> a/x loses s2; or drop `if (!(row.cues > 0))
   continue;` -> s1 counts 4 rows. */
test("select counts a show for its node's ancestors and descendants, never a sibling; cue-less rows and unmapped shows count nowhere", () => {
  const { nodes, unmappedShows } = countSupply(syntheticInputs());
  const n = Object.fromEntries(nodes.map((x) => [x.id, x]));
  assert.deepEqual(n["a/x"].shows, ["s1", "s2"], "s2 sits on the parent a; 123 (a/y) is a sibling");
  assert.equal(n["a/x"].rows, 5, "s1's cue-less row does not count");
  assert.equal(n["a/x"].stratum, "multi-show");
  assert.deepEqual(n["a/y"].shows, ["123", "s2"], "a numeric show id joins through the breadth classification");
  assert.deepEqual(n.a.shows, ["123", "s1", "s2"], "a parent counts its children's shows");
  assert.equal(n.a.rows, 9);
  assert.deepEqual(n["b/z"].shows, ["s3"]);
  assert.equal(n["b/z"].rows, 1);
  assert.equal(n["b/z"].stratum, "near-no-supply");
  assert.equal(n["b/z"].catalogShows, 2, "catalogue shows count whether transcribed or not");
  assert.deepEqual(unmappedShows, ["456"]);
});

/* Mutation: `rows < MIN_TOPIC_SUPPLY` -> `rows <= MIN_TOPIC_SUPPLY`, or
   `shows >= 2` -> `shows > 2`. */
test("stratumForCounts: near-no-supply below MIN_TOPIC_SUPPLY rows, multi-show from two shows", () => {
  assert.equal(MIN_TOPIC_SUPPLY, 3, "mirrors backend/src/generation/topicSupply.ts");
  assert.equal(stratumForCounts({ shows: 0, rows: 0 }), "near-no-supply");
  assert.equal(stratumForCounts({ shows: 1, rows: 2 }), "near-no-supply");
  assert.equal(stratumForCounts({ shows: 1, rows: 3 }), "single-show");
  assert.equal(stratumForCounts({ shows: 2, rows: 2 }), "near-no-supply");
  assert.equal(stratumForCounts({ shows: 2, rows: 3 }), "multi-show");
  assert.deepEqual(STRATA, ["multi-show", "single-show", "ambiguous", "near-no-supply"]);
});

/* Mutation: in strataDrift, `if (counted !== e.stratum)` -> `if (false)`, or
   `supplied.length < 2` -> `supplied.length < 1`. */
test("strataDrift names a prompt whose node changed stratum and an ambiguous prompt with one supplied reading", () => {
  const supply = countSupply(syntheticInputs());
  const entries = [
    { id: "g01", stratum: "multi-show", nodes: ["a/x"] },
    { id: "g02", stratum: "single-show", nodes: ["a"] },
    { id: "g03", stratum: "ambiguous", nodes: ["a/x", "b/z"] },
    { id: "g04", stratum: "ambiguous", nodes: ["a/x", "a/y"] }
  ];
  assert.deepEqual(strataDrift(entries, supply), [
    "g02: listed single-show, the data now counts a as multi-show",
    "g03: ambiguous, but only 1 of its readings has supply"
  ]);
});

/* Mutation: drop `.sort()` after the shows filter in countSupply, or the
   id sort of countSupply's node rows (`rows.sort(...)`): shuffled inputs then
   give other bytes. */
test("select is deterministic on the committed data, whatever order the inputs arrive in", () => {
  const first = JSON.stringify(propose(INPUTS));
  assert.equal(JSON.stringify(propose(INPUTS)), first);

  const shuffled = clone(INPUTS);
  const reverse = (xs) => xs.reverse();
  reverse(shuffled.digestRows);
  reverse(shuffled.nodes);
  reverse(shuffled.catalogShows);
  /* Rotate rather than only reverse, so a sort that happens to undo a reversal still fails. */
  shuffled.digestRows.push(...shuffled.digestRows.splice(0, 101));
  assert.equal(JSON.stringify(propose(shuffled)), first);

  const proposal = JSON.parse(first);
  assert.deepEqual(Object.keys(proposal.inputs), [
    "data/breadth-classification.json",
    "data/breadth-transcript-digests.json",
    "data/catalog.json",
    "data/taxonomy.json",
    "data/transcript-digests.json"
  ]);
  for (const s of ["multi-show", "single-show", "near-no-supply"]) assert.ok(proposal.proposals[s].length > 0, `${s} has candidates`);
  assert.ok(proposal.proposals.ambiguous.length > 0);
});

/* ------------------------------------------------------------------ */
/* The lock                                                             */
/* ------------------------------------------------------------------ */

/* Mutation: in checkLock, `lock.manifestSha !== sha` -> `false` (an edited
   set passes), or drop `.replace(/\r\n/g, "\n")` from manifestSha (the CRLF
   checkout reads as an edit). */
test("the lock round-trips, ignores line endings, and an edited manifest is refused", () => {
  const now = new Date("2026-10-12T00:00:00.000Z");
  const lock = buildLock({ manifestBytes: MANIFEST_BYTES, entries: MANIFEST, report: syntheticReport(MANIFEST_BYTES, MANIFEST), now });
  assert.deepEqual(Object.keys(lock).sort(), ["corpusFingerprint", "frozenAt", "manifestSha"]);
  assert.equal(lock.manifestSha, manifestSha(MANIFEST_BYTES));
  assert.equal(lock.corpusFingerprint.sha256, "c0ffee".padEnd(64, "0"));
  assert.equal(lock.frozenAt, "2026-10-12T00:00:00.000Z");
  const roundTripped = JSON.parse(JSON.stringify(lock));
  assert.deepEqual(checkLock(MANIFEST_BYTES, roundTripped), []);

  /* Both forms are built from a normalised base: on a checkout with
     core.autocrlf=true the committed file is already CRLF on disk. */
  const lf = Buffer.from(MANIFEST_BYTES.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
  const crlf = Buffer.from(lf.toString("utf8").replace(/\n/g, "\r\n"), "utf8");
  assert.notEqual(rawSha(crlf), rawSha(lf));
  assert.deepEqual(checkLock(lf, roundTripped), [], "an LF checkout is the same set");
  assert.deepEqual(checkLock(crlf, roundTripped), [], "a CRLF checkout is the same set");
  /* ...and a report written from a CRLF checkout locks the same set. */
  assert.equal(buildLock({ manifestBytes: MANIFEST_BYTES, entries: MANIFEST, report: syntheticReport(crlf, MANIFEST), now }).manifestSha, lock.manifestSha);

  const edited = clone(MANIFEST);
  byId(edited, "g30").prompt = "What happens to the body over a long race";
  const editedBytes = Buffer.from(`${JSON.stringify(edited, null, 2)}\n`, "utf8");
  assert.match(checkLock(editedBytes, roundTripped).join("\n"), /changed after it was locked .* golden-v2\.json/);
});

/* Mutation: delete any one `reasons.push(...)` in buildLock; the matching
   assertion below then sees a lock instead of a refusal. */
test("buildLock refuses a dry-run report, another prompt file, no corpus fingerprint and unreached golden ids", () => {
  const refused = (report) => {
    try {
      buildLock({ manifestBytes: MANIFEST_BYTES, entries: MANIFEST, report });
    } catch (e) {
      return e.message;
    }
    return "LOCKED";
  };
  const good = syntheticReport(MANIFEST_BYTES, MANIFEST);
  assert.match(refused({ ...good, dry_run: true }), /not from a real run/);
  assert.match(refused({ ...good, prompts: { ...good.prompts, sha256: "f".repeat(64) } }), /ran a different prompt file/);
  assert.match(refused({ ...good, corpus: null }), /no corpus fingerprint/);
  assert.match(refused({ ...good, entries: good.entries.slice(0, 48) }), /never reached 2 golden prompt\(s\): g49, g50/);
});

/* Mutation: delete the `if (fs.existsSync(lockPath))` refusal in main's
   --lock branch (the second lock overwrites the first), or the check-mode
   checkLock call (the edited manifest exits 0). */
test("the CLI locks once, then refuses a second lock and an edited manifest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "golden-"));
  try {
    const manifest = path.join(dir, "golden-v1.json");
    const lockFile = path.join(dir, "golden-v1.lock.json");
    const report = path.join(dir, "report.json");
    fs.writeFileSync(manifest, MANIFEST_BYTES);
    fs.writeFileSync(report, JSON.stringify(syntheticReport(MANIFEST_BYTES, MANIFEST)));
    const io = () => ({ root: REPO_ROOT, inputs: INPUTS, stdout: sink(), stderr: sink(), now: new Date("2026-10-12T00:00:00.000Z") });
    const args = ["--manifest", manifest, "--lock-file", lockFile];

    const first = io();
    assert.equal(main([...args, "--lock", report], first), 0, first.stderr.text);
    assert.match(first.stdout.text, /50 prompts, 10 listened/);
    assert.deepEqual(JSON.parse(fs.readFileSync(lockFile, "utf8")).manifestSha, manifestSha(MANIFEST_BYTES));

    const second = io();
    assert.equal(main([...args, "--lock", report], second), 1);
    assert.match(second.stderr.text, /already exists: the set is locked/);

    const edited = clone(MANIFEST);
    byId(edited, "g31").prompt = "How coaches plan a season";
    fs.writeFileSync(manifest, `${JSON.stringify(edited, null, 2)}\n`);
    const check = io();
    assert.equal(main(args, check), 1);
    assert.match(check.stderr.text, /golden-v2\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* What is committed                                                    */
/* ------------------------------------------------------------------ */

/* Mutation: add `"text"` to ENTRY_KEYS and a `text` field to one entry, or
   add an episode `title` to countSupply's node rows. Both are what this
   test is for: no transcript text and no model output in a committed file. */
test("no committed golden file carries transcript text or model output", () => {
  const allowed = ["id", "prompt", "duration", "stratum", "listened", "nodes", "reference", "bench"];
  for (const e of MANIFEST) {
    for (const k of Object.keys(e)) assert.ok(allowed.includes(k), `${e.id}: ${k}`);
    assert.ok(e.prompt.length <= MAX_PROMPT_CHARS);
  }
  const proposal = propose(INPUTS);
  for (const node of proposal.nodes) {
    assert.deepEqual(Object.keys(node), ["id", "label", "shows", "rows", "catalogShows", "stratum"]);
  }
  for (const s of ["multi-show", "single-show", "near-no-supply"]) {
    for (const row of proposal.proposals[s]) assert.deepEqual(Object.keys(row), ["id", "label", "shows", "rows", "catalogShows"]);
  }
  /* The lock, once the live step writes it, is three keys and nothing else. */
  if (fs.existsSync(DEFAULT_LOCK)) {
    const lock = JSON.parse(fs.readFileSync(DEFAULT_LOCK, "utf8"));
    assert.deepEqual(Object.keys(lock).sort(), ["corpusFingerprint", "frozenAt", "manifestSha"]);
    assert.deepEqual(checkLock(MANIFEST_BYTES, lock), [], "the committed lock still matches golden-v1.json");
  }
});

/* Mutation: change the README's `--prompts ../tools/generation-bench/golden/golden-v1.json`
   to `--prompts tools/generation-bench/golden/golden-v1.json` (wrong from
   backend/), or add `--dry-run` to the command. */
test("the README's run command finds this manifest from backend/ and does not pass --dry-run", () => {
  const readme = fs.readFileSync(path.join(HERE, "README.md"), "utf8");
  const line = readme.split(/\r?\n/).find((l) => l.startsWith("npm run generate-forays"));
  assert.ok(line, "the README has the run command");
  const prompts = line.match(/--prompts (\S+)/)?.[1];
  assert.equal(path.resolve(REPO_ROOT, "backend", prompts), DEFAULT_MANIFEST);
  assert.ok(!line.includes("--dry-run"), "a --dry-run batch writes no report.json, so it could never be locked");
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "backend", "package.json"), "utf8"));
  assert.ok(pkg.scripts["generate-forays"], "backend/package.json has the generate-forays script");
});
