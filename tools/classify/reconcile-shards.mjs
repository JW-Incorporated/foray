/* Shard reconciliation — STATIC machinery (committed, never regenerated),
   keyless, no LLM, no network.

   WHY THIS EXISTS
   ---------------
   The six `foray-classify-shard0-5` cloud routines run
   `prepare-batch.mjs --shard N/6` + `merge-results.mjs` and then commit to
   `origin/reclassify-N`. They open NO pull request and never touch `main`
   (the committed prompt in docs/agents/runner-prompts/classify-batch.md §8
   says to open one; the live routines do not — see docs/agents/runners.md).
   So a fleet that was working perfectly looked dead for two weeks: `main`
   sat at 1,851 agent-classified shows while ~17.4k real classifications
   accumulated on six branches nobody was merging.

   This script lands them, by MERGING DATA rather than checking out one
   branch's file over another — which matters, because shards 1..5 descend
   from `origin/reclassify` (last moved 2026-07-25) and therefore carry
   STALE base layers: taking any single shard's file wholesale would drop
   1,707 of main's agent rows and revert `genre-map`/`llm-title-genre` to a
   three-week-old state.

   THE MERGE RULES (all enforced, none assumed)
   --------------------------------------------
   1. NOTHING IS EVER REMOVED. Every id in the base file is in the output,
      with a non-empty `topics` and a `source`. The founders' rule is
      "label, never exclude": a show may be useless for a Foray and still
      belong in the catalogue.
   2. A SHARD AGENT ROW REPLACES A NON-AGENT BASE ROW, ALWAYS. That is the
      whole point: a judged classification beats a genre guess.
   3. AGENT vs AGENT IS DECIDED BY `classified_at`, NEWEST WINS. Only 80
      shows are contested at all, and the direction is not close: in
      80 of 80 the shard's pass is the newer one and in 0 is main's
      (reclassify-0 holds 44, reclassify-2 the 36 it had to redo after the
      rewrite below; shards 1, 3, 4 and 5 hold 144 inherited rows each and
      changed none of them). A blanket "the incumbent wins" would throw
      away 44 updates from `reclassify-0`, which is not a rival branch —
      it is `main`'s own lineage, simply further ahead. Same pipeline, same
      prompt, and the taxonomy only ever grew (PR #175 renamed and removed
      nothing), so the later pass is at least as well-informed. Ties and a
      missing timestamp keep the incumbent, so the rule can never churn.
   4. DISJOINTNESS IS VERIFIED, NOT TRUSTED. `--shard i/N` used to FAIL
      OPEN: an empty `--shard ""` (an unset variable in a routine), an
      out-of-range `6/6` or a non-numeric value were all silently ignored
      and the run then selected from the WHOLE catalogue. PR #203 fixed
      that — `parseShard` now throws — but every row already on the six
      branches predates the fix, so it cannot be assumed of this data.
      #203 also changed the KEY, from `Number(id) % N` to
      `fnv1a32(String(id)) % N`, so different branches (and eventually
      different rows on one branch) are partitioned by different keys.
      `keyForRow()` picks the right one from the row's own `classified_at`
      against the #203 merge instant, so every row is checked under exactly
      ONE key — full guard strength, and correct for the mixed-era branches
      every branch becomes from the next shard run onward.
      A shard that ran unsharded would have classified other shards' shows,
      so this script hard-fails on (a) two shards adopting the same id and
      (b) any id whose residue is not that shard's lane. Both are fatal,
      never warnings — a silent overlap is duplicated LLM work resolved by
      coin flip.
      The ONLY exemption is a row BYTE-IDENTICAL to the incumbent, which is
      an inherited row the shard never ran (see rule 3). Identity, not
      "older timestamp": an off-lane row that differs from the incumbent is
      evidence of off-lane work whichever way its clock points, and must not
      slip through disguised as inheritance.
      Measured 2026-08-17 across all six branches: 0 off-lane rows among
      each shard's OWN work. Note that the branch FILES do contain off-lane
      agent rows — 115-127 each on shards 0, 1, 3, 4, 5 — and every one is
      byte-identical to an inherited row, which is exactly why the exemption
      is identity-shaped. Counting all agent rows per file rather than each
      shard's own work makes it look as if five of six ran unsharded.
   5. A DISPLACED TOPIC IS KEPT, NOT DISCARDED. When an adopted row does
      not carry a topic the row it replaced had, the displaced ids are
      recorded on it as `superseded_topics` (+ `superseded_source`).
      `topics` therefore reflects the better judgement while nothing is
      destroyed. This is deliberate and it is NOT a union of the two lists:
      PR #198 measured that bolting the genre map's coarse secondary
      branches onto a judged row makes classification WORSE, not better
      (root-only pairs 9,741 -> 10,502 under the superset rule). So the
      demoted ids stay auditable and recoverable, and out of `topics`.
   6. LOUD FAILURE, WRITING NOTHING. An unknown taxonomy node, an empty
      `topics` on an incoming row, or a shard id absent from the base
      catalogue aborts before anything is written.

   Re-running is idempotent, and that is what makes the ordering against
   PR #198 safe: whichever of the two lands first, the other regenerates by
   re-running its own generator against the new `main`. Rules 1 and 2 mean
   #198's enrichment of a genre-map row survives untouched for every show
   without an agent row, and is superseded by the agent judgement for every
   show with one — which is #198's own stated precedence.

   Usage:
     node tools/classify/reconcile-shards.mjs --dry-run
     node tools/classify/reconcile-shards.mjs

   Options:
     --dry-run          report the numbers, write nothing
     --shards a,b,c     branch names (default reclassify-0..5)
     --shard-count N    modulus for the lane check (default 6)
     --from-dir DIR     read <branch>.json from DIR instead of `git show`
                        (offline/testing; the default reads
                        `origin/<branch>:data/breadth-classification.json`)

   Env overrides:
     BREADTH_CLASSIFICATION_PATH  (default data/breadth-classification.json)
     TAXONOMY_PATH                (default data/taxonomy.json)                */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
/* The shard key comes from labels.mjs rather than a local copy ON PURPOSE: two
   implementations of the key that decides who owns which show is exactly the
   drift that would silently re-partition the fleet and re-do merged work.
   The cost is a real import chain — labels.mjs -> segments/sweep-transcripts.mjs
   -> refresh/{enclosure,dai}.mjs, and dai.mjs reads dai-hosts.json at module
   scope — so this script now fails at import if that JSON is missing. Verified
   to matter not at all for CI: the whole classify suite passes with
   backend/node_modules absent, which is the `data-and-site` condition #203's
   lazy `fast-xml-parser` exists for. */
import { shardOf } from "./labels.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const DEFAULT_SHARDS = ["reclassify-0", "reclassify-1", "reclassify-2", "reclassify-3", "reclassify-4", "reclassify-5"];
export const DEFAULT_SHARD_COUNT = 6;

/** True for a real per-show agent judgement, whatever its tier. */
export function isAgentRow(entry) {
  return typeof entry?.source === "string" && entry.source.startsWith("classify-agent");
}

/* The LEGACY lane: `Number(id) % N`, the key `--shard i/N` used until PR #203.
   Every one of the 17,427 rows already sitting on the six branches was selected
   with it, so it is not history — it is what the data on disk is partitioned by.
   (This normalises negatives where the original used a raw `%`; Apple
   collection ids are positive, so the difference is unreachable.) */
export function laneOf(id, shardCount) {
  const n = Number(id);
  if (!Number.isFinite(n) || !Number.isInteger(shardCount) || shardCount <= 0) return null;
  return ((n % shardCount) + shardCount) % shardCount;
}

/* The two shard keys this repo has used, newest first.
 *
 * PR #203 replaced `Number(id) % N` with `fnv1a32(String(id)) % N`, because the
 * modulo key was 2.20x unbalanced over the shows that remained and would have
 * idled a sixth of the fleet. So a branch's rows are partitioned by whichever
 * key was in force when they were selected, and BOTH eras are legitimate. */
export const SHARD_KEYS = [
  { name: "hashed", of: (id, n) => shardOf(id, n) },          // post-#203
  { name: "legacy", of: (id, n) => laneOf(id, n) }            // pre-#203
];

/* WHEN THE KEY CHANGED. PR #203 (commit b9c07a4) merged at this instant, so a
   row selected before it was sharded by `legacy`, and a row selected at or after
   it by `hashed`. Verified against the six branches: all 19,890 agent rows carry
   `classified_at`, spanning 2026-07-25T04:15Z .. 2026-08-17T00:52Z — every one
   of them pre-cutover, which is why the whole existing corpus reads `legacy`. */
export const SHARD_KEY_CUTOVER = "2026-08-17T03:29:56Z";

/* THE KEY A SINGLE ROW WAS SELECTED WITH, from its own timestamp.
 *
 * Two designs were tried first and both are worse:
 *
 *   - Accept a row if EITHER key places it in-lane. 1.83x weaker than one key
 *     forever, for every row (an unsharded run's rows pass 11/36 of the time
 *     instead of 6/36), to buy something no row in the corpus needs.
 *   - Require each BRANCH pure under one key, detecting which. Full strength,
 *     and it self-destructs on the next run: the first post-#203 batch makes
 *     every branch a legacy/hashed mixture, pure under neither, and a correct
 *     merge would be refused.
 *
 * A row's own `classified_at` settles it exactly, so each row is checked under
 * exactly ONE key: full strength, no clock beyond a committed constant, and
 * mixed-era branches — which is what every branch becomes from the next run
 * onward — are handled row by row.
 *
 * A row with no timestamp reads `legacy`, which is the safe default rather than
 * a guess: every row that predates the `classified_at` field also predates the
 * key change, and defaulting to `hashed` would reject the entire existing
 * corpus. */
export function keyForRow(row) {
  const at = row?.classified_at;
  const isPost = typeof at === "string" && at >= SHARD_KEY_CUTOVER;
  return isPost ? SHARD_KEYS[0] : SHARD_KEYS[1];
}

/** The shard index a branch name claims (`reclassify-3` -> 3), or null. */
export function shardIndexOf(branch) {
  const m = /-(\d+)$/.exec(String(branch));
  return m ? Number(m[1]) : null;
}

/** The lane a row's own key puts it in, or null if that key cannot place it. */
export function laneForRow(id, row, shardCount) {
  try {
    const lane = keyForRow(row).of(id, shardCount);
    return typeof lane === "number" && Number.isFinite(lane) ? lane : null;
  } catch {
    return null;
  }
}

/* A copy-gated display field that is absent cannot also be "ok" — the one
   incoming row that claimed both would tell a future tile UI that a null
   header passed the copy rules. Normalising the flag loses no
   classification: topics, confidence and rationale are untouched. */
function normaliseDisplayFlags(row) {
  const missing = (v) => typeof v !== "string" || v.trim().length === 0;
  if (row.display_copy_ok !== false && (missing(row.display_title) || missing(row.blurb))) {
    const notes = Array.isArray(row.display_copy_notes) ? [...row.display_copy_notes] : [];
    if (missing(row.display_title)) notes.push("display_title: missing");
    if (missing(row.blurb)) notes.push("blurb: missing");
    return { ...row, display_copy_ok: false, display_copy_notes: notes, needs_review: true, _normalised: true };
  }
  return row;
}

/**
 * The whole merge, pure: no fs, no git, no clock.
 *
 * @param {object}   o.base         parsed base classification file (main's)
 * @param {Array}    o.shards       [{ branch, index, head?, file }]
 * @param {number}   o.shardCount   modulus for the lane check
 * @param {Set}      o.taxonomyIds  valid node ids ({} skips the check)
 * @returns {{ entries, stats, errors }} errors non-empty => caller writes nothing
 */
export function reconcile({ base, shards, shardCount = DEFAULT_SHARD_COUNT, taxonomyIds = null }) {
  const errors = [];
  const entries = {};
  for (const [id, entry] of Object.entries(base.entries)) entries[id] = entry;

  const baseAgentIds = new Set(Object.keys(base.entries).filter((id) => isAgentRow(base.entries[id])));

  /* PASS 1a — separate each branch's OWN WORK from what it merely inherited.
     Every shard file carries rows inherited from its branch point that the shard
     never re-ran (shards 1..5 hold 144 each, reclassify-0 holds 1,807), and
     those span every lane. They are not that shard's work, so they must not be
     lane-checked — the exemption is BYTE-IDENTITY, not "older timestamp": an
     off-lane row that differs from the incumbent is evidence of off-lane work
     whichever way its clock points. */
  const perShard = new Map();
  const ownWork = new Map(); // branch -> [{ id, row }]
  for (const shard of shards) {
    const { branch, file } = shard;
    const index = shard.index ?? shardIndexOf(branch);
    const stat = { branch, index, head: shard.head ?? null, entries: 0, agent_rows: 0, adopted: 0, refreshed: 0, incumbent_kept: 0, off_lane: 0, carries_base_layers: false, shard_key: null, keys_seen: {} };
    perShard.set(branch, stat);
    ownWork.set(branch, []);

    if (!file || typeof file !== "object" || !file.entries) {
      errors.push(`${branch}: unreadable classification file`);
      continue;
    }
    stat.entries = Object.keys(file.entries).length;
    stat.carries_base_layers = Object.values(file.entries).some((e) => !isAgentRow(e));

    for (const [id, row] of Object.entries(file.entries)) {
      if (!isAgentRow(row)) continue;
      stat.agent_rows++;
      if (!(id in base.entries)) {
        errors.push(`${branch}: show ${id} is not in the base catalogue — refusing to invent a row`);
        continue;
      }
      if (baseAgentIds.has(id) && JSON.stringify(row) === JSON.stringify(base.entries[id])) {
        stat.incumbent_kept++; // inherited, untouched by this shard
        continue;
      }
      ownWork.get(branch).push({ id, row });
    }
  }

  /* PASS 1b — THE LANE CHECK, per row, under the one key that row was selected
     with. A shard whose `--shard` failed open would land here with rows from
     every lane; a shard mid-way through the #203 key change lands here with a
     mixture of eras, and both are handled row by row. */
  for (const shard of shards) {
    const stat = perShard.get(shard.branch);
    if (stat.index === null) continue; // lane-less branch name: the collision guard carries it
    const offLane = [];
    for (const { id, row } of ownWork.get(shard.branch)) {
      const key = keyForRow(row);
      const lane = laneForRow(id, row, shardCount);
      if (lane !== stat.index) offLane.push(`${id} (${key.name} lane ${lane === null ? "unplaceable" : lane})`);
      stat.keys_seen[key.name] = (stat.keys_seen[key.name] || 0) + 1;
    }
    stat.shard_key = Object.keys(stat.keys_seen).sort().join("+") || null;
    if (offLane.length) {
      stat.off_lane = offLane.length;
      errors.push(
        `${shard.branch}: ${offLane.length} of ${ownWork.get(shard.branch).length} of its own rows fall outside lane ${stat.index} under the key they were selected with ` +
        `(e.g. ${offLane.slice(0, 5).join("; ")}). That is what an unsharded run looks like: --shard used to FAIL OPEN on an empty, out-of-range or non-numeric ` +
        `value and select the whole catalogue instead (fixed in #203). Refusing to merge work whose ownership is unknown.`
      );
    }
  }

  /* PASS 1c — validate, and enforce disjointness BEFORE mutating anything so a
     collision can never be half-applied. */
  const claimedBy = new Map(); // id -> branch
  const candidates = []; // { id, branch, index, row }
  for (const shard of shards) {
    const { branch } = shard;
    const stat = perShard.get(branch);
    for (const { id, row } of ownWork.get(branch)) {
      /* Rule 3: agent vs agent is decided by `classified_at`, newest wins. The
         row is already known to be this shard's own work and in its lane, so a
         loss here is simply discarded in the incumbent's favour. */
      if (baseAgentIds.has(id)) {
        const incumbentAt = base.entries[id]?.classified_at;
        const shardAt = row.classified_at;
        const newer = typeof shardAt === "string" && typeof incumbentAt === "string" && shardAt > incumbentAt;
        if (!newer) { stat.incumbent_kept++; continue; }
        stat.refreshed++;
      }
      /* Rule 4a: two shards must never claim the same show. Unreachable while
         both branches shard by the same key (two lanes cannot hold one id), but
         reachable across an era boundary and for lane-less branch names — and it
         must stay fatal either way: a genuine overlap is duplicated LLM work,
         and picking a winner by iteration order is picking one at random. */
      if (claimedBy.has(id)) {
        errors.push(`show ${id} is claimed by both ${claimedBy.get(id)} and ${branch} — shards are not disjoint, so which classification wins is a real decision and not this script's to guess`);
        continue;
      }
      if (!Array.isArray(row.topics) || row.topics.length === 0) {
        errors.push(`${branch}: show ${id} has empty topics — refusing to replace a classified row with nothing`);
        continue;
      }
      if (taxonomyIds) {
        for (const t of row.topics) {
          if (!taxonomyIds.has(t)) errors.push(`${branch}: show ${id} names unknown taxonomy node "${t}"`);
        }
      }
      claimedBy.set(id, branch);
      candidates.push({ id, branch, index: stat.index, row });
    }
  }

  if (errors.length) return { entries: null, stats: null, errors };

  /* Pass 2 — adopt. */
  let superseded_rows = 0;
  let display_flags_normalised = 0;
  let fewer_topics = 0;
  let more_topics = 0;
  let same_topics = 0;
  for (const { id, branch, row } of candidates) {
    const baseRow = base.entries[id];
    const baseTopics = Array.isArray(baseRow?.topics) ? baseRow.topics : [];
    let adopted = normaliseDisplayFlags(row);
    if (adopted._normalised) {
      display_flags_normalised++;
      delete adopted._normalised;
    }
    /* Rule 5: keep what the judgement displaced. */
    const displaced = baseTopics.filter((t) => !adopted.topics.includes(t));
    if (displaced.length) {
      superseded_rows++;
      adopted = { ...adopted, superseded_topics: displaced, superseded_source: baseRow.source ?? null };
    }
    if (adopted.topics.length < baseTopics.length) fewer_topics++;
    else if (adopted.topics.length > baseTopics.length) more_topics++;
    else same_topics++;

    entries[id] = adopted;
    if (!baseAgentIds.has(id)) perShard.get(branch).adopted++;
  }

  const agentAfter = Object.keys(entries).filter((id) => isAgentRow(entries[id])).length;
  const sourceCensus = {};
  for (const e of Object.values(entries)) {
    const s = e?.source ?? "(missing)";
    sourceCensus[s] = (sourceCensus[s] || 0) + 1;
  }

  const stats = {
    entries: Object.keys(entries).length,
    baseline: { entries: Object.keys(base.entries).length, agent_rows: baseAgentIds.size },
    shards: [...perShard.values()],
    adopted_total: [...perShard.values()].reduce((n, s) => n + s.adopted, 0),
    refreshed_total: [...perShard.values()].reduce((n, s) => n + s.refreshed, 0),
    rows_replaced: candidates.length,
    agent_rows_after: agentAfter,
    no_agent_pass: Object.keys(entries).length - agentAfter,
    superseded_rows,
    display_flags_normalised,
    topic_count_vs_base: { fewer: fewer_topics, same: same_topics, more: more_topics },
    source_census: sourceCensus
  };

  return { entries, stats, errors: [] };
}

/**
 * Every entry-by-entry regression the founders' rule actually cares about,
 * checked against the base rather than asserted in a PR body. Returns a
 * list of violations; empty is the only acceptable result.
 */
export function auditNoRegression(base, entries) {
  const violations = [];
  for (const [id, before] of Object.entries(base.entries)) {
    const after = entries[id];
    if (!after) { violations.push(`${id}: entry dropped`); continue; }
    if (!Array.isArray(after.topics) || after.topics.length === 0) { violations.push(`${id}: ends with no topics`); continue; }
    if (typeof after.source !== "string" || !after.source) { violations.push(`${id}: ends with no source`); continue; }
    if (isAgentRow(before) && !isAgentRow(after)) { violations.push(`${id}: lost its agent classification`); continue; }
    /* Nothing a show was ever labelled with may vanish: a topic the base
       carried must still be reachable, either in `topics` or demoted into
       `superseded_topics`. */
    const kept = new Set([...after.topics, ...(after.superseded_topics ?? [])]);
    const beforeTopics = Array.isArray(before.topics) ? before.topics : [];
    const lost = beforeTopics.filter((t) => !kept.has(t));
    if (lost.length) violations.push(`${id}: topics vanished entirely: ${lost.join(", ")}`);
  }
  return violations;
}

/* ------------------------------------------------------------------ CLI */

function parseArgs(argv) {
  const get = (flag, def) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : def;
  };
  const known = new Set(["--dry-run", "--shards", "--shard-count", "--from-dir"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      if (!known.has(a)) { console.error(`FATAL: unknown option "${a}" — refusing to run rather than ignore it.`); process.exit(1); }
      if (a !== "--dry-run") i++;
    }
  }
  const shards = String(get("--shards", DEFAULT_SHARDS.join(","))).split(",").map((s) => s.trim()).filter(Boolean);
  /* Refuse rather than no-op. An empty list used to produce a successful run
     that reconciled nothing and recorded `shards: []` in the provenance — the
     same fail-open shape as `--shard ""` in prepare-batch.mjs (issue #203),
     which is the bug this whole script exists to police. */
  if (shards.length === 0) {
    console.error("FATAL: no shard branches to read (--shards was empty). Refusing to write a file that reconciles nothing.");
    process.exit(1);
  }
  const shardCount = Number(get("--shard-count", String(DEFAULT_SHARD_COUNT)));
  if (!Number.isInteger(shardCount) || shardCount <= 0) {
    console.error(`FATAL: --shard-count must be a positive integer, got "${get("--shard-count", "")}". Refusing to run with a lane check that cannot fire.`);
    process.exit(1);
  }
  return { dryRun: argv.includes("--dry-run"), shards, shardCount, fromDir: get("--from-dir", null) };
}

function envPath(name, def) {
  const v = process.env[name];
  return v ? resolvePath(process.cwd(), v) : join(ROOT, ...def);
}

function readShard(branch, fromDir) {
  if (fromDir) {
    const p = join(resolvePath(process.cwd(), fromDir), `${branch}.json`);
    return { file: JSON.parse(readFileSync(p, "utf8")), head: null };
  }
  const ref = `origin/${branch}`;
  const head = execFileSync("git", ["rev-parse", "--short", ref], { cwd: ROOT, encoding: "utf8" }).trim();
  const raw = execFileSync("git", ["show", `${ref}:data/breadth-classification.json`], { cwd: ROOT, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  return { file: JSON.parse(raw), head };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const CLASSIFICATION_PATH = envPath("BREADTH_CLASSIFICATION_PATH", ["data", "breadth-classification.json"]);
  const TAXONOMY_PATH = envPath("TAXONOMY_PATH", ["data", "taxonomy.json"]);

  const base = JSON.parse(readFileSync(CLASSIFICATION_PATH, "utf8"));
  const taxonomyIds = existsSync(TAXONOMY_PATH)
    ? new Set(JSON.parse(readFileSync(TAXONOMY_PATH, "utf8")).nodes.map((n) => n.id))
    : null;

  const shards = args.shards.map((branch) => {
    const { file, head } = readShard(branch, args.fromDir);
    return { branch, index: shardIndexOf(branch), head, file };
  });

  const { entries, stats, errors } = reconcile({ base, shards, shardCount: args.shardCount, taxonomyIds });
  if (errors.length) {
    console.error(`FATAL: ${errors.length} problem(s) — nothing written.`);
    for (const e of errors.slice(0, 40)) console.error(`  ${e}`);
    if (errors.length > 40) console.error(`  ... and ${errors.length - 40} more`);
    process.exit(1);
  }

  const violations = auditNoRegression(base, entries);
  if (violations.length) {
    console.error(`FATAL: ${violations.length} show(s) would go backwards — nothing written.`);
    for (const v of violations.slice(0, 40)) console.error(`  ${v}`);
    process.exit(1);
  }

  console.log(`entries ${stats.entries} (baseline ${stats.baseline.entries})`);
  console.log(`agent-classified ${stats.baseline.agent_rows} -> ${stats.agent_rows_after}  (+${stats.adopted_total} new, ${stats.refreshed_total} refreshed by a newer pass)`);
  console.log(`still no agent pass: ${stats.no_agent_pass}`);
  for (const s of stats.shards) {
    console.log(`  ${s.branch.padEnd(14)} head ${String(s.head ?? "-").padEnd(9)} key ${String(s.shard_key ?? "-").padEnd(6)} agent ${String(s.agent_rows).padStart(5)}  new ${String(s.adopted).padStart(5)}  refreshed ${String(s.refreshed).padStart(3)}  incumbent-kept ${String(s.incumbent_kept).padStart(4)}  off-lane ${s.off_lane}  base-layers ${s.carries_base_layers}`);
  }
  console.log(`rows carrying superseded_topics: ${stats.superseded_rows}`);
  console.log(`display flags normalised: ${stats.display_flags_normalised}`);
  console.log(`topic count vs base row — fewer ${stats.topic_count_vs_base.fewer}, same ${stats.topic_count_vs_base.same}, more ${stats.topic_count_vs_base.more}`);
  console.log(`source census: ${JSON.stringify(stats.source_census)}`);
  console.log(`no-regression audit: ${violations.length} violations`);

  if (args.dryRun) { console.log("--dry-run: nothing written."); return; }

  const out = {
    ...base,
    built_at: new Date().toISOString(),
    entries,
    provenance: {
      ...base.provenance,
      reconciled_shards: {
        produced_by: "tools/classify/reconcile-shards.mjs",
        method: "union of the six foray-classify-shard0-5 cloud routines' agent classifications, merged into the base layers; newest classified_at wins agent-vs-agent, displaced topics demoted to superseded_topics",
        baseline: stats.baseline,
        shards: stats.shards.map((s) => ({ branch: s.branch, head: s.head, lane: s.index, shard_key: s.shard_key, adopted: s.adopted, refreshed: s.refreshed, incumbent_kept: s.incumbent_kept })),
        adopted_total: stats.adopted_total,
        refreshed_total: stats.refreshed_total,
        rows_replaced: stats.rows_replaced,
        display_flags_normalised: stats.display_flags_normalised,
        agent_rows_after: stats.agent_rows_after,
        no_agent_pass: stats.no_agent_pass,
        superseded_rows: stats.superseded_rows,
        shard_count: args.shardCount
      }
    }
  };
  /* Key order: keep `entries` last, as every other writer of this file does,
     but never DROP a key — spread whatever else the base carried. */
  const { entries: _e, version, built_at, provenance, ...rest } = out;
  const ordered = { version, built_at, provenance, ...rest, entries: out.entries };
  writeFileSync(CLASSIFICATION_PATH, JSON.stringify(ordered, null, 2) + "\n");
  console.log(`wrote ${CLASSIFICATION_PATH}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) main();
