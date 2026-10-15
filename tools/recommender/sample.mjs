/* RV-07 (docs/roadmap/recommender-v1.md, D4 (b)/(c), D7, D12): the stratified
   gold-set sampler. Chooses WHICH shows the persona raters rate, and fixes the
   pilot, retest, isolated and holdout subsets before anyone rates anything.

     node tools/recommender/sample.mjs --mode pilot --size 300 --retest 60 --isolated 40 --seed rv-pilot-01 [--report]
     node tools/recommender/sample.mjs --mode gold --size 3000 --holdout 500 --retest 500 --seed rv-gold-01 \
       [--extend data/recommender/gold-set.json] [--report]
     ... --check      exit 1 when a rerun with the same arguments would change the output file

   Writes data/recommender/gold-set.json (env RECOMMENDER_GOLD_SET_PATH, the
   name sample-r2.mjs and enrich-rss.mjs read with `--keys gold`; or --out).
   Nothing on a live app path reads it; the rating batches (RV-08) are built
   from evidence packs, never from the strata recorded here.

   THE CATALOGUE. Every curated show (`data/catalog.json`, keyed show_id) and
   every breadth show (`data/catalog-breadth.json`, keyed apple_collection_id)
   that is not a curated show's breadth twin, the same universe and keys
   evidence.mjs resolves (RV-02 `show_key`). Shows whose evidence tier is
   `none` are never sampled: there is nothing to rate (D3, D4).

   STRATA, per show (`catalogueCandidates`):
   - root     the root of the first taxonomy node (`"science/physics"` ->
              `"science"`; every taxonomy.json node id starts with its root's
              id), or `unlabelled` for `[]`. The node list is the one the
              evidence pack carries (curated first, else breadth).
   - tier     `evidenceTierOf` via `buildEvidence` (RV-03).
   - dai      `data/dai-classification.json` `shows[<apple id>].dai`:
              "true" / "false", or "unknown" when the show is not classified.
   - chart    `chart_rank` 1-25 / 26-200 / "uncharted" (null; the catalogue's
              ranks stop at 200, so anything else is also uncharted).
   - length   the evidence pack's `typical_duration_min` (episode archive or
              RSS cache medians), else for a curated show the median
              `duration_min` of its `data/discover.json` items: <=30 / 31-60 /
              >60 / unknown.
   DAI and chart rank are stratified on because they predict ad insertion
   (D12); raters never see either (D7), and nor do they see this file.

   ALLOCATION (`sampleGoldSet`), deterministic under `--seed` (the mulberry32
   `rng` of tools/segments/rank-breadth.mjs; never Math.random):
   1. Each root's candidates are put in canonical (show_key) order and then
      shuffled with rng(`<seed>:root:<root>`).
   2. Coverage: per root, a greedy pass over that shuffled order picks the
      fewest shows that represent every DAI value and every chart band the
      root has in the catalogue.
   3. Rich evidence: at least ceil(size / 3) of the set is `transcript` or
      `episode-metadata` where the catalogue has that many (all of them when
      it has fewer); that target is spread over roots in proportion to their
      rich shows. The rich shows sit in a few roots, so this bends the root
      quotas: it is a floor, not a share.
   4. Root quotas: floor = max(FLOOR_BY_MODE[mode] (15 gold, 3 pilot), the
      coverage picks + the root's rich share), capped at the root's size; the
      rest of `--size` is split in proportion to each root's catalogue count
      (largest remainder, capped at availability). When the floors do not fit,
      the rich target shrinks first; a size below the mode and coverage floors
      is refused. Each root takes its coverage picks, then its rich share.
   5. The rest of each root's quota is the next shows of its shuffled order (a
      seeded simple random sample within the root).
   6. Roles: every row carries the mode (`pilot` or `gold`); `retest`,
      `isolated` and `holdout` go to disjoint subsets, each spread over roots
      in proportion to the eligible rows and drawn with its own seeded
      shuffle. A holdout row is never retest or isolated (RV-25 trains on gold
      minus holdout).
   7. The new rows are position-shuffled (rng(`<seed>:order`)), so the file is
      not in catalogue order (D7).

   --extend <file>. Every existing row is kept with its strata and roles (the
   mode role is added when it changes, e.g. pilot rows join the gold set).
   Quotas are computed for the full new size as above; a root gets new shows
   only up to its deficit (quota minus the rows it already has), so an
   over-filled root gets none. Role counts are topped up to the requested
   numbers from the rows that hold none of the three roles; existing roles are
   never moved.

   Deterministic output: the same arguments and inputs give byte-identical
   files. `built_at` is the one clock field: a run whose result equals the file
   on disk leaves the file untouched, and `--check` compares with the file's
   own `built_at`.

   BREADTH MODE (RV-33, orchestrator decision 2026-10-15 after the student
   failed its gate twice: RV-25 #1418, RV-32 #1419). Instead of predicting the
   catalogue, the teacher rates the shows most likely to be served:

     node tools/recommender/sample.mjs --mode breadth [--chart 1-25] \
       [--exclude data/recommender/gold-set.json] [--out data/recommender/breadth-set.json] [--report] [--check]

   Every catalogued show whose chart band (the `chart` stratum above) is one
   of `--chart` (a comma list of CHART_BANDS, default 1-25), minus every
   show_key of the `--exclude` gold set (default: the gold-set path above), so
   a breadth show is never a gold show. A show at evidence tier `none` is left
   out, as in the gold set: there is nothing to rate (D3) and prepare would
   skip it forever. No sampling and no seed: the rows are every match, sorted
   by show_key, each `{ show_key, title, strata, roles: ["breadth"] }`.
   Written to data/recommender/breadth-set.json (env
   RECOMMENDER_BREADTH_SET_PATH, or --out) in the gold set's file format,
   with the same `built_at` and `--check` rules.

   Calls no model and fetches nothing. */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";
import { rng } from "../segments/rank-breadth.mjs";
import { buildEvidence, loadSources, resolveShow } from "./evidence.mjs";

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");

export const GOLD_SET_VERSION = 1;
export const MODES = Object.freeze(["pilot", "gold"]);
/** At least this many shows per taxonomy root that has them (card RV-07). */
export const FLOOR_BY_MODE = Object.freeze({ pilot: 3, gold: 15 });
export const RICH_TIERS = Object.freeze(["transcript", "episode-metadata"]);
/** At least this share of the set comes from RICH_TIERS where available. */
export const RICH_SHARE = 1 / 3;
export const SUBSET_ROLES = Object.freeze(["retest", "isolated", "holdout"]);
/** The breadth set's mode and only role (RV-33). */
export const BREADTH = "breadth";
export const ROLE_ORDER = Object.freeze(["pilot", "gold", ...SUBSET_ROLES, BREADTH]);
/** The `chart` stratum's values (chartBand). */
export const CHART_BANDS = Object.freeze(["1-25", "26-200", "uncharted"]);
export const DIMENSIONS = Object.freeze(["root", "tier", "dai", "chart", "length"]);
/** The dimensions every root must represent in full where the catalogue has them (D12). */
export const COVER_DIMENSIONS = Object.freeze(["dai", "chart"]);
export const UNLABELLED = "unlabelled";

export const PATHS = Object.freeze({
  goldSet: ["RECOMMENDER_GOLD_SET_PATH", "data/recommender/gold-set.json"],
  breadthSet: ["RECOMMENDER_BREADTH_SET_PATH", "data/recommender/breadth-set.json"],
  dai: ["RECOMMENDER_DAI_PATH", "data/dai-classification.json"],
  discover: ["RECOMMENDER_DISCOVER_PATH", "data/discover.json"],
});

/** Env override (resolved against cwd, evidence.mjs's idiom), else repo-relative. */
export function pathOf(name, env = process.env) {
  const [envName, rel] = PATHS[name];
  const v = env[envName];
  return typeof v === "string" && v.trim() !== "" ? resolvePath(process.cwd(), v) : resolvePath(REPO_ROOT, rel);
}

/* ------------------------------------------------------------------ strata */

export function rootOf(nodeIds) {
  const first = Array.isArray(nodeIds) ? nodeIds.find((id) => typeof id === "string" && id.trim() !== "") : null;
  return first ? first.split("/")[0] : UNLABELLED;
}

export function chartBand(rank) {
  if (Number.isInteger(rank) && rank >= 1 && rank <= 25) return "1-25";
  if (Number.isInteger(rank) && rank > 25 && rank <= 200) return "26-200";
  return "uncharted";
}

export function lengthBand(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "unknown";
  if (minutes <= 30) return "<=30";
  if (minutes <= 60) return "31-60";
  return ">60";
}

export function daiValue(entry) {
  if (entry?.dai === true) return "true";
  if (entry?.dai === false) return "false";
  return "unknown";
}

function median(values) {
  const v = values.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Every catalogued show as `{ show_key, title, strata }`, in show_key order,
 * including `none`-tier shows (the sampler drops those). `dai` is the parsed
 * dai-classification.json, `discover` the parsed discover.json (optional).
 * `chartBands` (optional) keeps only the shows in those chart bands, checked
 * before any evidence is built (the breadth set needs a few thousand of 26k).
 */
export function catalogueCandidates(sources, { dai = { shows: {} }, discover = null, chartBands = null } = {}) {
  const discoverMinutes = new Map();
  for (const item of discover?.items ?? []) {
    if (item?.apple_collection_id == null || !Number.isFinite(item.duration_min)) continue;
    const k = String(item.apple_collection_id);
    if (!discoverMinutes.has(k)) discoverMinutes.set(k, []);
    discoverMinutes.get(k).push(item.duration_min);
  }
  const keys = [...sources.curated.keys(), ...[...sources.breadth.keys()].filter((acid) => !sources.curatedByAcid.has(acid))];
  const out = [];
  for (const key of keys) {
    const show = resolveShow(key, sources);
    const rank = show.breadth?.chart_rank ?? show.curated?.chart_rank ?? null;
    if (chartBands && !chartBands.includes(chartBand(rank))) continue;
    const pack = buildEvidence(key, sources, { windows: 0 });
    const minutes = pack.typical_duration_min ?? (show.curated && show.acid ? median(discoverMinutes.get(show.acid) ?? []) : null);
    out.push({
      show_key: show.show_key,
      title: pack.title,
      strata: {
        root: rootOf(pack.taxonomy_node_ids),
        tier: pack.tier,
        dai: daiValue(dai?.shows?.[show.acid ?? show.show_key]),
        chart: chartBand(rank),
        length: lengthBand(minutes),
      },
    });
  }
  return out.sort((a, b) => byKey(a.show_key, b.show_key));
}

/* -------------------------------------------------------------- allocation */

function shuffled(list, seed) {
  const next = rng(seed);
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Splits `total` over `entries` ({ id, weight, cap }) in proportion to
 * weight, never above cap: whole shares first, then one at a time by the
 * largest fractional share (ties by id), repeated while capacity remains.
 * Returns { <id>: n }.
 */
export function allocate(total, entries) {
  const list = entries.slice().sort((a, b) => byKey(a.id, b.id));
  const out = Object.fromEntries(list.map((e) => [e.id, 0]));
  let left = Math.max(0, total);
  while (left > 0) {
    const open = list.filter((e) => e.weight > 0 && out[e.id] < e.cap);
    if (!open.length) break;
    const W = open.reduce((s, e) => s + e.weight, 0);
    const shares = open.map((e) => ({ e, raw: (left * e.weight) / W }));
    let given = 0;
    for (const s of shares) {
      const g = Math.min(Math.floor(s.raw), s.e.cap - out[s.e.id]);
      out[s.e.id] += g;
      given += g;
    }
    if (given === 0) {
      shares.sort((a, b) => b.raw - Math.floor(b.raw) - (a.raw - Math.floor(a.raw)) || byKey(a.e.id, b.e.id));
      for (const s of shares) {
        if (given >= left) break;
        if (out[s.e.id] < s.e.cap) {
          out[s.e.id] += 1;
          given += 1;
        }
      }
    }
    left -= given;
  }
  return out;
}

const valuesOf = (rows, dim) => new Set(rows.map((r) => r.strata[dim]));

/** Greedy cover: from `order`, the fewest rows (first-best in order) that add
    every COVER_DIMENSIONS value of `order` not already in `have`. */
function coverPicks(order, have) {
  const missing = new Set();
  for (const dim of COVER_DIMENSIONS) {
    const held = valuesOf(have, dim);
    for (const v of valuesOf(order, dim)) if (!held.has(v)) missing.add(`${dim}=${v}`);
  }
  const picks = [];
  const taken = new Set();
  while (missing.size) {
    let best = null;
    let bestGain = 0;
    for (const row of order) {
      if (taken.has(row.show_key)) continue;
      const gain = COVER_DIMENSIONS.filter((dim) => missing.has(`${dim}=${row.strata[dim]}`)).length;
      if (gain > bestGain) {
        best = row;
        bestGain = gain;
      }
    }
    if (!best) break;
    picks.push(best);
    taken.add(best.show_key);
    for (const dim of COVER_DIMENSIONS) missing.delete(`${dim}=${best.strata[dim]}`);
  }
  return picks;
}

const isRich = (row) => RICH_TIERS.includes(row.strata.tier);

function groupByRoot(rows) {
  const out = new Map();
  for (const row of rows) {
    const r = row.strata.root;
    if (!out.has(r)) out.set(r, []);
    out.get(r).push(row);
  }
  return out;
}

/** Which rows may take `role`: the three subset roles are disjoint. */
function eligibleFor(role, row) {
  return !SUBSET_ROLES.some((r) => row.roles.includes(r));
}

const sortRoles = (roles) => ROLE_ORDER.filter((r) => roles.includes(r));

function strataCounts(pool, rows) {
  const out = {};
  for (const dim of DIMENSIONS) {
    const cell = {};
    for (const row of pool) (cell[row.strata[dim]] ??= { catalogue: 0, sampled: 0 }).catalogue += 1;
    for (const row of rows) (cell[row.strata[dim]] ??= { catalogue: 0, sampled: 0 }).sampled += 1;
    out[dim] = Object.fromEntries(Object.keys(cell).sort(byKey).map((k) => [k, cell[k]]));
  }
  return out;
}

/**
 * The gold set. `candidates` from catalogueCandidates; `existing` a parsed
 * gold-set.json to extend (or null). Throws on arguments it cannot honour.
 */
export function sampleGoldSet({ candidates, mode, size, retest = 0, isolated = 0, holdout = 0, seed, existing = null, builtAt }) {
  if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(", ")}`);
  if (typeof seed !== "string" || seed.trim() === "") throw new Error("seed is required");
  for (const [name, n] of Object.entries({ size, retest, isolated, holdout })) {
    if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  }

  // The catalogue with something to rate, one row per show_key, canonical order.
  const seen = new Set();
  const pool = [];
  for (const c of [...candidates].sort((a, b) => byKey(a.show_key, b.show_key))) {
    if (c.strata.tier === "none" || seen.has(c.show_key)) continue;
    seen.add(c.show_key);
    pool.push({ show_key: c.show_key, title: c.title ?? null, strata: { ...c.strata } });
  }

  const kept = (existing?.shows ?? []).map((row) => ({
    ...row,
    strata: { ...row.strata },
    roles: sortRoles([...new Set([...(row.roles ?? []), mode])]),
  }));
  const keptKeys = new Set(kept.map((r) => r.show_key));
  const target = Math.min(size, kept.length + pool.filter((c) => !keptKeys.has(c.show_key)).length);
  if (target < kept.length) throw new Error(`size ${size} is below the ${kept.length} rows of the set being extended`);
  if (retest + isolated + holdout > target) throw new Error(`retest + isolated + holdout (${retest + isolated + holdout}) exceed the set size ${target}`);

  // Quotas for the whole set as if built fresh. A root's floor is the mode
  // floor, or its coverage picks plus its share of the rich-evidence target if
  // that is more; the rich target shrinks (never the mode floor) when the
  // floors would not fit in the size.
  const poolByRoot = groupByRoot(pool);
  const roots = [...poolByRoot.keys()].sort(byKey);
  const orderOf = new Map(roots.map((r) => [r, shuffled(poolByRoot.get(r), `${seed}:root:${r}`)]));
  const coverNeed = Object.fromEntries(roots.map((r) => [r, coverPicks(orderOf.get(r), []).length]));
  const richIn = Object.fromEntries(roots.map((r) => [r, poolByRoot.get(r).filter(isRich).length]));
  const richWanted = Math.min(Math.ceil(target * RICH_SHARE), pool.filter(isRich).length);
  const floorsFor = (richTotal) => {
    const rich = allocate(richTotal, roots.map((r) => ({ id: r, weight: richIn[r], cap: richIn[r] })));
    const floors = Object.fromEntries(roots.map((r) => [r, Math.min(poolByRoot.get(r).length, Math.max(FLOOR_BY_MODE[mode], coverNeed[r] + rich[r]))]));
    return { rich, floors, sum: roots.reduce((s, r) => s + floors[r], 0) };
  };
  let richTotal = richWanted;
  let { rich: richAlloc, floors, sum: floorSum } = floorsFor(richTotal);
  while (floorSum > target && richTotal > 0) {
    richTotal = Math.max(0, richTotal - (floorSum - target));
    ({ rich: richAlloc, floors, sum: floorSum } = floorsFor(richTotal));
  }
  if (floorSum > target) throw new Error(`size ${target} is below the strata floors (${floorSum} across ${roots.length} roots)`);
  const extra = allocate(
    target - floorSum,
    roots.map((r) => ({ id: r, weight: poolByRoot.get(r).length, cap: poolByRoot.get(r).length - floors[r] })),
  );
  const quota = Object.fromEntries(roots.map((r) => [r, floors[r] + extra[r]]));

  // New shows per root: only up to each root's deficit.
  const keptByRoot = groupByRoot(kept);
  const avail = Object.fromEntries(roots.map((r) => [r, orderOf.get(r).filter((c) => !keptKeys.has(c.show_key))]));
  const toAdd = target - kept.length;
  let adds = allocate(
    toAdd,
    roots.map((r) => {
      const deficit = Math.max(0, quota[r] - (keptByRoot.get(r)?.length ?? 0));
      return { id: r, weight: deficit, cap: Math.min(deficit, avail[r].length) };
    }),
  );
  const short = toAdd - roots.reduce((s, r) => s + adds[r], 0);
  if (short > 0) {
    // Only when extended rows have left the catalogue: fill from what remains, proportionally.
    const more = allocate(short, roots.map((r) => ({ id: r, weight: avail[r].length, cap: avail[r].length - adds[r] })));
    adds = Object.fromEntries(roots.map((r) => [r, adds[r] + more[r]]));
  }

  // Rich-evidence picks per root: the fresh allocation, or on --extend the
  // shortfall against the rows kept, spread over the roots that take new shows.
  const richQuota = kept.length
    ? allocate(
        Math.max(0, richWanted - kept.filter(isRich).length),
        roots.map((r) => {
          const n = avail[r].filter(isRich).length;
          return { id: r, weight: n, cap: Math.min(n, adds[r]) };
        }),
      )
    : richAlloc;

  const added = [];
  for (const r of roots) {
    if (!adds[r]) continue;
    const picked = [];
    const taken = new Set();
    let rich = 0;
    const take = (row) => {
      if (picked.length < adds[r] && !taken.has(row.show_key)) {
        picked.push(row);
        taken.add(row.show_key);
        if (isRich(row)) rich += 1;
      }
    };
    for (const row of coverPicks(avail[r], keptByRoot.get(r) ?? [])) take(row);
    for (const row of avail[r]) if (isRich(row) && rich < richQuota[r]) take(row);
    for (const row of avail[r]) take(row);
    added.push(...picked);
  }

  // Canonical order first, so the file order is the seeded shuffle and nothing else.
  added.sort((a, b) => byKey(a.show_key, b.show_key));
  const rows = [...kept, ...shuffled(added, `${seed}:order`).map((row) => ({ ...row, roles: [mode] }))];

  // Subset roles, topped up to the requested counts and spread over roots.
  for (const [role, want] of [["retest", retest], ["isolated", isolated], ["holdout", holdout]]) {
    const need = want - rows.filter((row) => row.roles.includes(role)).length;
    if (need <= 0) continue;
    const eligible = groupByRoot(rows.filter((row) => eligibleFor(role, row)));
    const share = allocate(need, [...eligible].map(([r, list]) => ({ id: r, weight: list.length, cap: list.length })));
    for (const [r, list] of eligible) {
      const canon = list.slice().sort((a, b) => byKey(a.show_key, b.show_key));
      for (const row of shuffled(canon, `${seed}:${role}:${r}`).slice(0, share[r])) row.roles = sortRoles([...row.roles, role]);
    }
  }

  return {
    version: GOLD_SET_VERSION,
    mode,
    seed,
    built_at: builtAt ?? existing?.built_at ?? null,
    strata_counts: strataCounts(pool, rows),
    shows: rows.map((row) => ({ show_key: row.show_key, title: row.title ?? null, strata: Object.fromEntries(DIMENSIONS.map((d) => [d, row.strata[d]])), roles: row.roles })),
  };
}

/**
 * The breadth set (RV-33): every candidate whose chart band is in `chart` and
 * whose tier is not `none`, minus the `exclude` show keys (the gold set), in
 * show_key order, each with the one role `breadth`. Pure and deterministic.
 */
export function sampleBreadthSet({ candidates, chart = ["1-25"], exclude = [], builtAt = null }) {
  const bands = [...new Set(chart)];
  if (!bands.length || bands.some((b) => !CHART_BANDS.includes(b))) throw new Error(`chart bands must be among ${CHART_BANDS.join(", ")}`);
  const excluded = new Set([...exclude].map(String));
  const seen = new Set();
  const pool = [];
  for (const c of [...candidates].sort((a, b) => byKey(a.show_key, b.show_key))) {
    if (c.strata.tier === "none" || !bands.includes(c.strata.chart) || seen.has(c.show_key)) continue;
    seen.add(c.show_key);
    pool.push(c);
  }
  const rows = pool.filter((c) => !excluded.has(c.show_key));
  return {
    version: GOLD_SET_VERSION,
    mode: BREADTH,
    chart: CHART_BANDS.filter((b) => bands.includes(b)),
    excluded_gold: pool.length - rows.length,
    built_at: builtAt,
    strata_counts: strataCounts(pool, rows),
    shows: rows.map((row) => ({ show_key: row.show_key, title: row.title ?? null, strata: Object.fromEntries(DIMENSIONS.map((d) => [d, row.strata[d]])), roles: [BREADTH] })),
  };
}

/** The file bytes: the header pretty-printed, one show per line, trailing newline. */
export function serializeGoldSet(doc) {
  const { shows, ...head } = doc;
  const top = JSON.stringify(head, null, 2).replace(/\n}$/, "");
  const body = shows.map((row) => `    ${JSON.stringify(row)}`).join(",\n");
  return `${top},\n  "shows": [${shows.length ? `\n${body}\n  ` : ""}]\n}\n`;
}

/** The strata table `--report` prints. */
export function reportLines(doc) {
  const lines = [
    doc.mode === BREADTH
      ? `breadth set: chart ${doc.chart.join(",")}, ${doc.shows.length} shows (${doc.excluded_gold} gold shows excluded)`
      : `gold set: mode ${doc.mode}, seed ${doc.seed}, ${doc.shows.length} shows`,
  ];
  const roleCounts = Object.fromEntries(ROLE_ORDER.map((r) => [r, doc.shows.filter((s) => s.roles.includes(r)).length]));
  lines.push(`roles: ${ROLE_ORDER.filter((r) => roleCounts[r]).map((r) => `${r} ${roleCounts[r]}`).join(", ")}`);
  for (const dim of DIMENSIONS) {
    lines.push("", `${dim.padEnd(20)} ${"catalogue".padStart(9)} ${"sampled".padStart(8)} ${"share".padStart(6)}`);
    for (const [value, c] of Object.entries(doc.strata_counts[dim])) {
      const share = doc.shows.length ? `${((100 * c.sampled) / doc.shows.length).toFixed(1)}%` : "-";
      lines.push(`${value.padEnd(20)} ${String(c.catalogue).padStart(9)} ${String(c.sampled).padStart(8)} ${share.padStart(6)}`);
    }
  }
  return lines;
}

/* --------------------------------------------------------------------- CLI */

const USAGE =
  "usage: node tools/recommender/sample.mjs --mode pilot|gold --size N --seed S [--retest N] [--isolated N] [--holdout N] [--extend <gold-set.json>] [--out <path>] [--report] [--check]\n" +
  "       node tools/recommender/sample.mjs --mode breadth [--chart 1-25[,26-200,uncharted]] [--exclude <gold-set.json>] [--out <path>] [--report] [--check]";

export class UsageError extends Error {}

export function parseArgs(argv) {
  const args = { mode: null, size: null, retest: 0, isolated: 0, holdout: 0, seed: null, extend: null, out: null, report: false, check: false, chart: null, exclude: null };
  const given = new Set();
  const count = (flag, v) => {
    if (!/^\d+$/.test(String(v ?? ""))) throw new UsageError(`${flag} needs a non-negative integer, got ${v ?? "nothing"}`);
    return Number(v);
  };
  const value = (flag, v) => {
    if (typeof v !== "string" || v === "" || v.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    given.add(a);
    if (a === "--mode") args.mode = value(a, argv[++i]);
    else if (a === "--size") args.size = count(a, argv[++i]);
    else if (a === "--retest") args.retest = count(a, argv[++i]);
    else if (a === "--isolated") args.isolated = count(a, argv[++i]);
    else if (a === "--holdout") args.holdout = count(a, argv[++i]);
    else if (a === "--seed") args.seed = value(a, argv[++i]);
    else if (a === "--extend") args.extend = value(a, argv[++i]);
    else if (a === "--out") args.out = value(a, argv[++i]);
    else if (a === "--chart") args.chart = value(a, argv[++i]).split(",").map((b) => b.trim());
    else if (a === "--exclude") args.exclude = value(a, argv[++i]);
    else if (a === "--report") args.report = true;
    else if (a === "--check") args.check = true;
    else throw new UsageError(`unknown argument ${a}`);
  }
  if (args.mode === BREADTH) {
    const gold = ["--size", "--seed", "--retest", "--isolated", "--holdout", "--extend"].filter((f) => given.has(f));
    if (gold.length) throw new UsageError(`--mode breadth takes every matching show and no ${gold.join(", ")}`);
    args.chart ??= ["1-25"];
    const bad = args.chart.filter((b) => !CHART_BANDS.includes(b));
    if (bad.length || !args.chart.length) throw new UsageError(`--chart takes a comma list of ${CHART_BANDS.join(", ")}, got ${bad.join(",") || "nothing"}`);
    return args;
  }
  if (given.has("--chart") || given.has("--exclude")) throw new UsageError("--chart and --exclude are for --mode breadth");
  if (!MODES.includes(args.mode)) throw new UsageError("--mode pilot|gold|breadth is required");
  if (args.size === null || args.size < 1) throw new UsageError("--size N (N >= 1) is required");
  if (!args.seed) throw new UsageError("--seed is required");
  return args;
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** Returns the exit code: 0 done / in sync, 1 --check drift, 2 usage or input error. */
export function main(argv = process.argv.slice(2), { env = process.env, now = () => new Date(), stdout = (s) => process.stdout.write(s), stderr = (s) => process.stderr.write(s) } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    stderr(`sample: ${e.message}\n${USAGE}\n`);
    return 2;
  }
  const breadth = args.mode === BREADTH;
  const outPath = args.out ? resolvePath(process.cwd(), args.out) : pathOf(breadth ? "breadthSet" : "goldSet", env);
  const excludePath = breadth ? (args.exclude ? resolvePath(process.cwd(), args.exclude) : pathOf("goldSet", env)) : null;
  const daiPath = pathOf("dai", env);
  const discoverPath = pathOf("discover", env);

  let doc;
  let current = null;
  try {
    if (!existsSync(daiPath)) throw new Error(`${daiPath} does not exist (set RECOMMENDER_DAI_PATH)`);
    // The breadth set is disjoint from the gold set by construction, so a missing gold set is an error, not "exclude nothing".
    const goldKeys = breadth ? readJson(excludePath).shows?.map((row) => String(row.show_key)) : null;
    if (breadth && !Array.isArray(goldKeys)) throw new Error(`${excludePath} is not a gold set (no shows array)`);
    const existing = args.extend ? readJson(resolvePath(process.cwd(), args.extend)) : null;
    if (existing && !Array.isArray(existing.shows)) throw new Error(`${args.extend} is not a gold set (no shows array)`);
    current = existsSync(outPath) ? readFileSync(outPath, "utf8") : null;
    let currentBuiltAt = null;
    try {
      currentBuiltAt = current === null ? null : JSON.parse(current).built_at ?? null;
    } catch {
      currentBuiltAt = null;
    }
    const candidates = catalogueCandidates(loadSources({ env }), {
      dai: readJson(daiPath),
      discover: existsSync(discoverPath) ? readJson(discoverPath) : null,
      chartBands: breadth ? args.chart : null,
    });
    const build = (builtAt) =>
      breadth
        ? sampleBreadthSet({ candidates, chart: args.chart, exclude: goldKeys, builtAt })
        : sampleGoldSet({ candidates, mode: args.mode, size: args.size, retest: args.retest, isolated: args.isolated, holdout: args.holdout, seed: args.seed, existing, builtAt });
    doc = build(currentBuiltAt ?? "");
    if (args.check) {
      const same = current !== null && serializeGoldSet(doc) === current;
      stderr(same ? `sample: ${outPath} is current\n` : `sample: ${outPath} would change on a rerun with these arguments\n`);
      if (args.report) stdout(`${reportLines(doc).join("\n")}\n`);
      return same ? 0 : 1;
    }
    if (current !== null && serializeGoldSet(doc) === current) {
      stderr(`sample: ${outPath} unchanged (${doc.shows.length} shows)\n`);
    } else {
      doc = build(now().toISOString());
      const tmp = `${outPath}.tmp`;
      writeFileSync(tmp, serializeGoldSet(doc));
      renameSync(tmp, outPath);
      stderr(`sample: wrote ${outPath} (${doc.shows.length} shows)\n`);
    }
  } catch (e) {
    stderr(`sample: ${e.message}\n`);
    return 2;
  }
  if (!breadth && doc.shows.length < args.size) stderr(`sample: only ${doc.shows.length} catalogued shows have evidence; the set holds all of them\n`);
  if (args.report) stdout(`${reportLines(doc).join("\n")}\n`);
  return 0;
}

if (isEntryScript(import.meta.url)) process.exitCode = main();
