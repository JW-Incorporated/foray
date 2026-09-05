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
    `manifest.json`'s `version`. */
export const POINTER_SCHEMA_VERSION = 1;

/** Local scratch for the downloaded archive + extracted db + build output.
    Gitignored (data-local/), never committed — same pattern as
    tools/transcribe and tools/segments. */
export const DOWNLOAD_DIR = join(ROOT, "data-local", "shows-import");
export const BUILD_OUT_DIR = join(ROOT, "data-local", "shows-import", "out");

/** §3.2 size budgets, enforced as tests per the card's acceptance criteria.
    p95, not a per-shard hard ceiling — a handful of dense prefixes (common
    English letter pairs) are expected to run larger. */
export const MAX_SHARD_GZ_P95_BYTES = 400 * 1024;
export const MAX_TOP_JSON_BYTES = 250 * 1024;
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
