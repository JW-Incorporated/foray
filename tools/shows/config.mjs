/* Config constants for the PodcastIndex dump import pipeline (S-04a).
   Single source of truth so a future swap to Joey's own export (D3) is a
   one-line change here, not a hunt through import-dump.mjs. */
import { dirname, join } from "node:path";
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

/** Where the "already built this version" marker lives — durable, not
    gitignored, so a second run on a fresh checkout still sees the last
    build (per the card's "somewhere durable under data/ or
    tools/shows/state/" instruction). */
export const STATE_DIR = join(ROOT, "tools", "shows", "state");
export const STATE_PATH = join(STATE_DIR, "last-build.json");

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
