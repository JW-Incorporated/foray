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
   4. DISJOINTNESS IS VERIFIED, NOT TRUSTED. `--shard i/N` selects on
      `Number(id) % N === i`, but on `main` that flag FAILS OPEN — an empty
      `--shard ""` (an unset variable in a routine), an out-of-range `6/6`
      or a non-numeric value are all silently ignored and the run then
      selects from the WHOLE catalogue (issue #203 makes them refuse).
      A shard that ran unsharded would have classified other shards' shows,
      so this script hard-fails on (a) two shards adopting the same id and
      (b) any adopted id whose residue is not that shard's lane. Both are
      fatal, never warnings — a silent overlap is duplicated LLM work
      resolved by coin flip.
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const DEFAULT_SHARDS = ["reclassify-0", "reclassify-1", "reclassify-2", "reclassify-3", "reclassify-4", "reclassify-5"];
export const DEFAULT_SHARD_COUNT = 6;

/** True for a real per-show agent judgement, whatever its tier. */
export function isAgentRow(entry) {
  return typeof entry?.source === "string" && entry.source.startsWith("classify-agent");
}

/** The lane `--shard i/N` would have selected this id into, or null. */
export function laneOf(id, shardCount) {
  const n = Number(id);
  if (!Number.isFinite(n) || !Number.isInteger(shardCount) || shardCount <= 0) return null;
  return ((n % shardCount) + shardCount) % shardCount;
}

/** The shard index a branch name claims (`reclassify-3` -> 3), or null. */
export function shardIndexOf(branch) {
  const m = /-(\d+)$/.exec(String(branch));
  return m ? Number(m[1]) : null;
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

  /* Pass 1 — collect every candidate adoption and enforce disjointness
     BEFORE mutating anything, so a collision cannot be half-applied. */
  const claimedBy = new Map(); // id -> branch
  const candidates = []; // { id, branch, index, row }
  const perShard = new Map();
  for (const shard of shards) {
    const { branch, file } = shard;
    const index = shard.index ?? shardIndexOf(branch);
    const stat = { branch, index, head: shard.head ?? null, entries: 0, agent_rows: 0, adopted: 0, refreshed: 0, incumbent_kept: 0, off_lane: 0, carries_base_layers: false };
    perShard.set(branch, stat);

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
      /* Rule 3: agent vs agent is decided by `classified_at`, newest wins.
         An inherited row a shard never re-ran is byte-identical to the
         incumbent and lands here with an equal timestamp, so it is kept and
         never treated as this shard's own work — which matters for the lane
         check below: shards 1..5 each carry 144 rows inherited from
         `origin/reclassify` that span every lane, and flagging those as
         off-lane would be a false positive. */
      if (baseAgentIds.has(id)) {
        const incumbentAt = base.entries[id]?.classified_at;
        const shardAt = row.classified_at;
        const newer = typeof shardAt === "string" && typeof incumbentAt === "string" && shardAt > incumbentAt;
        if (!newer) { stat.incumbent_kept++; continue; }
        stat.refreshed++;
      }
      /* Rule 4b: the lane check. A shard whose `--shard` failed open would
         land here with ids from every residue. */
      if (index !== null && laneOf(id, shardCount) !== index) {
        stat.off_lane++;
        errors.push(`${branch}: show ${id} is in lane ${laneOf(id, shardCount)}, not ${index} — this shard did not stay in its slice (see issue #203: --shard used to fail open)`);
        continue;
      }
      /* Rule 4a: two shards must never claim the same show. With the lane
         check above this is unreachable for correctly-named `reclassify-N`
         branches — two lanes cannot contain one id — so it is
         defence-in-depth for a shard list whose branch names carry no lane
         (`shardIndexOf` returns null and the lane check is skipped). It is
         still fatal: a genuine overlap is duplicated LLM work, and picking
         a winner by iteration order is picking one at random. */
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
      candidates.push({ id, branch, index, row });
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
    replaced_total: candidates.length,
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
  return {
    dryRun: argv.includes("--dry-run"),
    shards: String(get("--shards", DEFAULT_SHARDS.join(","))).split(",").map((s) => s.trim()).filter(Boolean),
    shardCount: Number(get("--shard-count", String(DEFAULT_SHARD_COUNT))),
    fromDir: get("--from-dir", null)
  };
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
    console.log(`  ${s.branch.padEnd(14)} head ${String(s.head ?? "-").padEnd(9)} agent ${String(s.agent_rows).padStart(5)}  new ${String(s.adopted).padStart(5)}  refreshed ${String(s.refreshed).padStart(3)}  incumbent-kept ${String(s.incumbent_kept).padStart(4)}  off-lane ${s.off_lane}  base-layers ${s.carries_base_layers}`);
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
        shards: stats.shards.map((s) => ({ branch: s.branch, head: s.head, lane: s.index, adopted: s.adopted, refreshed: s.refreshed, incumbent_kept: s.incumbent_kept })),
        adopted_total: stats.adopted_total,
        refreshed_total: stats.refreshed_total,
        agent_rows_after: stats.agent_rows_after,
        no_agent_pass: stats.no_agent_pass,
        superseded_rows: stats.superseded_rows,
        shard_count: args.shardCount
      }
    }
  };
  /* Key order: keep `entries` last, as every other writer of this file does. */
  const ordered = { version: out.version, built_at: out.built_at, provenance: out.provenance, entries: out.entries };
  writeFileSync(CLASSIFICATION_PATH, JSON.stringify(ordered, null, 2) + "\n");
  console.log(`wrote ${CLASSIFICATION_PATH}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) main();
