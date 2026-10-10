/* Config constants for the PodcastIndex dump import pipeline (S-04a).
   Single source of truth so a future swap to Joey's own export (D3) is a
   one-line change here, not a hunt through import-dump.mjs.

   Also the one home of the small helpers import-dump.mjs, load-postgres.mjs
   and tools/poll/poll-episodes.mjs used to copy (CH2-12): the DATABASE_URL
   resolver, the streamed dump checksum, the curated-catalog reader and the
   unmapped-curated guard (bottom of this file).

   LIGHT ON PURPOSE. tools/poll/poll-episodes.mjs and
   tools/refresh/candidates.mjs import this file from the root `node --test`
   group, which has no pg-copy-streams and runs without --experimental-sqlite.
   Only node: builtins and ../segments/politeness.mjs belong here, never pg,
   pg-copy-streams or node:sqlite (tools/poll/poll-episodes.test.mjs walks
   the import graph). */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { UA as CLIENT_UA, CONTACT } from "../segments/politeness.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The public PodcastIndex bulk dump. D3 swap-ready: change this one value
    (and, if the shape differs, the row mapping in import-dump.mjs) to point
    at Joey's own export instead — nothing else in this pipeline names a URL
    ad hoc. */
export const DUMP_URL = "https://public.podcastindex.org/podcastindex_feeds.db.tgz";

/** PodcastIndex's dump host 403s the default fetch User-Agent with a
    179-byte non-gzip body (measured, docs/curation/catalogue-broadening.md).
    Reuses the project's one honest client identity rather than inventing an
    eleventh (politeness.mjs's own header on that count). */
export const DUMP_UA = CLIENT_UA;
export { CONTACT };

/** D1 ("in 4a" = alive, >= this many episodes, updated within this many
    months — 4a-shows-pipeline-plan.md §0). "Updated" is read from
    `newestItemPubdate` (the show's own most recent episode) rather than
    PodcastIndex's `lastUpdate` crawl timestamp — the latter reflects THEIR
    crawler's schedule, not the show's activity, and this pipeline cares
    whether the show itself is alive. Exported so re-confirming D1 against
    Joey's export (gate G6, card S-17) is a one-line change here. */
export const D1_MIN_EPISODES = 3;

/* How many curated shows may be absent from the dump before the import refuses
   to publish. NOT zero, and the first real run is why: PodcastIndex is 4.7M
   feeds, which is very large and still not everything, so a hand-curated show
   legitimately missing from it is a fact about the index, not a bug in us — and
   that show keeps working in the app regardless, because `data/catalog.json`
   is what the client ships. Failing the whole build for one such show would
   mean no show list at all for 4.7M shows because of one.

   A LARGE fraction missing is a different animal: that is the join breaking,
   which is precisely the failure this guard was written for. 5% of 220 is 11.
   The unmapped shows are named in the log and recorded in the manifest either
   way, so "tolerated" never means "unnoticed". */
export const MAX_UNMAPPED_CURATED_FRACTION = 0.05;
export const D1_MAX_MONTHS_STALE = 24;

export const CATALOG_PATH = join(ROOT, "data", "catalog.json");
export const POINTER_PATH = join(ROOT, "data", "shows-index-pointer.json");

/** S-04b: GitHub Release publishing. `REPO_SLUG` is read from the
    Actions-provided `GITHUB_REPOSITORY` env var when present (so a fork
    publishes to itself, never to this repo by accident) and falls back to
    this repo's slug for local/manual runs. `RELEASE_TAG_PREFIX` namespaces
    every release this pipeline creates so `gh release list` can tell them
    apart from `kokoro-fixture-*` and any other release in the repo. */
export const REPO_SLUG = process.env.GITHUB_REPOSITORY || "JW-Incorporated/foray";
export const RELEASE_TAG_PREFIX = "shows-index-";

/** data/shows-index-pointer.json is committed (not gitignored) — it is the
    D3-swap-ready config value the client reads to find the current
    release, per 4a-shows-pipeline-plan.md's origin-is-a-config-value
    design. Bumped whenever the pointer's own shape changes, independent of
    `manifest.json`'s `version`, and written by publish-release.mjs's
    buildPointer (it was dead until audit round 3, arch-drift-7, while
    buildPointer hard-coded 1).

      1  the original pointer: release tag, asset base, manifest, counts.
      2  S-04c: adds `shards_published` and `shard_releases` (the batch
         release ranges). Readers treat both as optional, so a v1 pointer
         still reads as "no shard releases". */
export const POINTER_SCHEMA_VERSION = 2;

/** #1033: the prior-release baseline for changed.json. Every top-level
    release ships this asset — one `{ "<pi_id>": newest_item_at epoch
    seconds }` map over that build's canonical rows, gzipped — and the NEXT
    run downloads it from the committed pointer's `asset_base_url` (public,
    no token) and hands it to `buildChanged` as `previousNewest`. ~884k ids,
    a few MB gzipped. The decompressed cap is a guard against a hostile or
    corrupt asset, not a budget: the real map is ~20MB of JSON. */
export const NEWEST_SNAPSHOT_ASSET = "newest-snapshot.json.gz";
export const NEWEST_SNAPSHOT_VERSION = 1;
export const MAX_NEWEST_SNAPSHOT_BYTES = 256 * 1024 * 1024;
export const NEWEST_SNAPSHOT_FETCH_TIMEOUT_MS = 120_000;

/** S-04c: shard publishing. GitHub Releases hard-caps a single release at
    1,000 total assets (confirmed via GitHub's own docs and a real HTTP 422
    "file_count limited to 1000 assets per release" against this repo, see
    publish-release.mjs's own header). The real build carries ~1,298 shard
    files, so they are split across MULTIPLE releases instead of coarsening
    shard granularity (see this card's own kanban body for why: a coarser
    first-char bucket would multiply the per-shard payload a listener's
    device fetches on every keystroke, which is the exact cost sharding
    exists to avoid — splitting release COUNT is free on the client, since
    the client only ever fetches the one shard it needs regardless of which
    release it lives on).

    900, not 1000: headroom under the hard ceiling for a future dump that
    grows past 1,298 keys without silently tripping the 1,000 limit again on
    the SAME batch boundary this constant already committed to (the
    partition is recomputed fresh every run from whatever shard_inventory
    the current build produced, so growth only ever adds another batch, it
    never risks exceeding 1,000 on an existing one). */
export const MAX_SHARD_ASSETS_PER_RELEASE = 900;

/** Local scratch for the downloaded archive + extracted db + build output.
    Gitignored (data-local/), never committed — same pattern as
    tools/transcribe and tools/segments. */
export const DOWNLOAD_DIR = join(ROOT, "data-local", "shows-import");
export const BUILD_OUT_DIR = join(ROOT, "data-local", "shows-import", "out");

/** §3.2 size budgets, enforced as tests per the card's acceptance criteria.
    p95, not a per-shard hard ceiling — a handful of dense prefixes (common
    English letter pairs) are expected to run larger.

    MEASURED against the real PodcastIndex dump (2026-09-15, 4,728,574 total
    rows / 891,141 canonical rows / 1,298 shards, see
    t_30a53ba2's task receipt for the full run): p95 shard gzip size is
    2,046,984 bytes (~2.0MB). The original 400KB budget was a pre-launch
    guess that turned out ~5x too tight for real title/author token
    frequency — common tokens like "podcast" (177K rows), "the" (170K),
    "and" (59K) fan a row into many shards and a handful of 2-char prefixes
    (po, th, an, co, ma, de …) legitimately carry 60K-215K rows each, which
    no amount of 3/4-char sub-sharding meaningfully shrinks (measured:
    "pod" still 191,901 rows, "podc" still 184,705 — the bloat is the whole
    token recurring across hundreds of thousands of titles, not prefix
    coarseness). Sub-sharding the top offenders further was evaluated and
    rejected: it would multiply the shard count (and therefore
    request/cache-entry count) for a shrink of a few percent at best on the
    worst buckets, for no client benefit — the client already only fetches
    the one shard matching what the user typed.

    Set to 2.5MB: ~28% headroom over the measured 2,046,984B p95, room for
    the dump to grow before this trips again, while still bounding the
    reasonable common case (only 158 of 1,298 shards / ~12% measured over
    the old 400KB, none anywhere near 2.5MB except the extreme top of the
    distribution this constant does not gate — see p99/max in the same
    receipt). Revisit with fresh measurements if a future run's p95
    approaches this number again. */
export const MAX_SHARD_GZ_P95_BYTES = 2.5 * 1024 * 1024;

/** MEASURED against the same real dump run referenced above:
    curated (219 resolved of 220) + TOP_N_BY_POPULARITY (2000) = 2,219 rows
    at ~278 bytes/row uncompressed (top.json is shipped uncompressed, not
    gzipped like the shards) comes to 616,389 bytes — the original 250KB
    budget assumed a much smaller top.json than TOP_N_BY_POPULARITY = 2000
    actually produces once every row carries the full shard row shape
    ({id,t,a,i,u,img,n,c}) rather than a smaller "top list" projection.
    Raising the budget rather than shrinking TOP_N_BY_POPULARITY or the row
    shape: this file is fetched once per client session (not per shard
    search keystroke), 616KB uncompressed is well within normal fetch
    budgets for that access pattern, and every consumer already reads the
    same {id,t,a,i,u,img,n,c} row shape as the shards — trimming top.json's
    shape alone would be a second row shape to maintain for no measured
    problem. Set to 900KB: ~49% headroom over the measured 616,389B so a
    modest curated-list or TOP_N growth doesn't immediately retrip this. */
export const MAX_TOP_JSON_BYTES = 900 * 1024;
export const TOP_N_BY_POPULARITY = 2000;

/** The `podcasts` table columns this pipeline reads, exactly as named in
    4a-shows-pipeline-plan.md §3.1. `newestEnclosureUrl`/
    `newestEnclosureDuration` are deliberately absent — the plan documents
    them as describing only the newest item and explicitly "ignored" here. */
export const DUMP_COLUMNS = [
  "id", "url", "podcastGuid", "itunesId", "title", "itunesAuthor",
  "itunesOwnerName", "description", "imageUrl", "language", "dead",
  "episodeCount", "lastUpdate", "newestItemPubdate", "oldestItemPubdate",
  "popularityScore", "explicit", "host",
  "category1", "category2", "category3", "category4", "category5",
  "category6", "category7", "category8", "category9", "category10",
];

/* ------------------------------------------------------ shared helpers -- */

export class ImportError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ImportError";
    this.code = code;
    this.details = details;
  }
}

/** The env vars that point this pipeline at a Postgres, in priority order:
    SHOWS_DATABASE_URL first so the shows pipeline can use a different
    database than the main backend without a global env change. */
export const DATABASE_URL_VARS = ["SHOWS_DATABASE_URL", "DATABASE_URL"];

/** The first configured DB URL that is actually set. A blank or
    whitespace-only value counts as UNSET (a runner env that templates an
    empty secret must read as "no database", not as a database called " "):
    every CLI that asks "is a database configured?" asks it here. */
export function resolveDatabaseUrl(env = process.env) {
  for (const name of DATABASE_URL_VARS) {
    const v = env[name];
    if (v && v.trim()) return { url: v.trim(), varName: name };
  }
  return { url: null, varName: null };
}

/** sha256 hex of a file, STREAMED. The real PodcastIndex db is ~4.7GB
    uncompressed, over node:fs/promises readFile's 2GiB ceiling
    (ERR_FS_FILE_TOO_LARGE), so a whole-file read crashes on exactly the dump
    the --dump-file path exists for (t_30a53ba2; T1-03). */
export async function checksumFile(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/** The curated shows in data/catalog.json (an array, or `{ shows: [...] }`). */
export async function loadCuratedShows(path = CATALOG_PATH) {
  const raw = JSON.parse(await readFile(path, "utf8"));
  const shows = Array.isArray(raw) ? raw : raw.shows;
  if (!Array.isArray(shows)) throw new ImportError("BAD_CATALOG", `${path} did not parse to an array or {shows:[...]}`);
  return shows;
}

/** Fail closed on an incomplete id-map, before anything is written (shards
    by import-dump.mjs, rows by load-postgres.mjs). Over
    MAX_UNMAPPED_CURATED_FRACTION it throws ImportError ID_MAP_INCOMPLETE;
    under it, it names the unmapped shows on `warn` and the run continues
    (see MAX_UNMAPPED_CURATED_FRACTION's note). Returns `{ curatedTotal }`
    for the manifest. */
export function checkMissingMapping(result, { warn = console.warn } = {}) {
  const curatedTotal = result.curatedTotal || (result.missing.length + Object.keys(result.idMap).length);
  const unmappedFraction = curatedTotal > 0 ? result.missing.length / curatedTotal : 0;
  const ceiling = `${(MAX_UNMAPPED_CURATED_FRACTION * 100).toFixed(0)}%`;
  const names = result.missing.map((m) => `${m.show_id} (${m.title})`).join(", ");
  if (unmappedFraction > MAX_UNMAPPED_CURATED_FRACTION) {
    throw new ImportError(
      "ID_MAP_INCOMPLETE",
      `${result.missing.length} of ${curatedTotal} curated show(s) did not resolve to a dump row ` +
        `(${(unmappedFraction * 100).toFixed(1)}%, over the ${ceiling} ceiling — ` +
        `that is the join breaking, not the index being incomplete): ${names}`,
      { missing: result.missing, curatedTotal },
    );
  }
  if (result.missing.length > 0) {
    warn(
      `WARN: ${result.missing.length} of ${curatedTotal} curated show(s) are not in this dump ` +
        `(under the ${ceiling} ceiling, so the run continues; they keep working from data/catalog.json): ${names}`,
    );
  }
  return { curatedTotal };
}
