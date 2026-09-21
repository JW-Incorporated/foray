#!/usr/bin/env node
/* tools/shows/load-postgres.mjs — S-09: loads S-04a's parsed/canonical dump
   rows into Postgres (`shows_catalog` + `show_id_map`, migrations 0017-0018).
   Reuses `import-dump.mjs`'s `runPipeline` (fetch/parse/filter/dedupe/id-map
   are one pipeline, not reimplemented here) — this file's own job starts
   where that one's ends: taking `runPipeline`'s in-memory result and getting
   it into Postgres via COPY-into-staging -> upsert, the pattern the card
   asks for so a 50k+ row import doesn't run as tens of thousands of
   individual INSERTs.

   Inert in production per the card's own instruction: every entry point
   checks DATABASE_URL/SHOWS_DATABASE_URL and exits 0 naming the human gate
   when absent — the founders have not provisioned a production Postgres for
   the shows pipeline yet (see HUMAN-ACTIONS.md's Supabase-tier-sizing gate,
   fed by this file's own sizing report below).

   Usage:
     node tools/shows/load-postgres.mjs --dump-file PATH [--export-version V]
     node tools/shows/load-postgres.mjs --dump-file PATH --dry-run   # report only, no DB writes

   `--dump-file` mirrors import-dump.mjs's own flag: a fixture or a
   hand-downloaded/extracted sqlite db stands in for a real network fetch,
   so this file's own tests and CI's `db` job never touch the real 1.8GB
   dump either. */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { from as copyFrom } from "pg-copy-streams";
import { Readable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";

import { CATALOG_PATH, MAX_UNMAPPED_CURATED_FRACTION } from "./config.mjs";
import { runPipeline } from "./import-dump.mjs";

export const SHOWS_DATABASE_URL_VARS = ["SHOWS_DATABASE_URL", "DATABASE_URL"];

/** Reads the first configured DB URL env var that is actually set — the
    card's own "checks for DATABASE_URL/SHOWS_DATABASE_URL" language, with
    SHOWS_DATABASE_URL taking priority so this pipeline can point at a
    different Postgres than the main backend's without a global env change. */
export function resolveDatabaseUrl(env = process.env) {
  for (const name of SHOWS_DATABASE_URL_VARS) {
    const v = env[name];
    if (v && v.trim()) return { url: v.trim(), varName: name };
  }
  return { url: null, varName: null };
}

/** One row shaped for the `shows_catalog` staging COPY — plain values,
    tab-delimited-safe (COPY's own text format escapes tabs/newlines/`\`
    itself when given via the client's copy-from stream, so this only needs
    to hand it the right JS values in the right column order). */
function toCatalogRow(row, { curatedIds, exportVersion }) {
  return {
    pi_id: Number(row.id),
    title: row.title ?? "",
    author: row.itunesAuthor || row.itunesOwnerName || null,
    itunes_id: row.itunesId != null ? Number(row.itunesId) : null,
    feed_url: row.url ?? "",
    image_url: row.imageUrl ?? null,
    episode_count: Number.isFinite(Number(row.episodeCount)) ? Number(row.episodeCount) : null,
    popularity_score: Number.isFinite(Number(row.popularityScore)) ? Number(row.popularityScore) : null,
    explicit: row.explicit == null ? null : !!row.explicit,
    language: row.language ?? null,
    dead: row.dead === 1 || row.dead === true,
    newest_item_at: Number.isFinite(Number(row.newestItemPubdate))
      ? new Date(Number(row.newestItemPubdate) * 1000).toISOString()
      : null,
    curated: curatedIds.has(Number(row.id)),
    category1: row.category1 ?? null,
    category2: row.category2 ?? null,
    category3: row.category3 ?? null,
    export_version: exportVersion,
  };
}

const CATALOG_COLUMNS = [
  "pi_id", "title", "author", "itunes_id", "feed_url", "image_url",
  "episode_count", "popularity_score", "explicit", "language", "dead",
  "newest_item_at", "curated", "category1", "category2", "category3",
  "export_version",
];

/** Postgres COPY text-format escaping for one field: backslash, tab and
    newline are the only bytes COPY's TEXT format requires escaped; NULL is
    the literal two-char sequence `\N`. */
function copyEscape(value) {
  if (value === null || value === undefined) return "\\N";
  let s;
  if (typeof value === "boolean") s = value ? "t" : "f";
  else s = String(value);
  return s.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

function rowToCopyLine(row) {
  return CATALOG_COLUMNS.map((c) => copyEscape(row[c])).join("\t");
}

/** Streams `rows` into a fresh, unlogged staging table via COPY (fast path
    for 50k+ rows), then upserts staging -> shows_catalog in one statement.
    UNLOGGED because the staging table is scratch for the duration of one
    load — no WAL needed, and it is dropped at the end regardless of
    outcome. */
export async function loadCatalogRows(client, rows, { exportVersion }) {
  await client.query("begin");
  try {
    await client.query(`
      create unlogged table if not exists shows_catalog_staging (
        pi_id bigint, title text, author text, itunes_id bigint, feed_url text,
        image_url text, episode_count integer, popularity_score double precision,
        explicit boolean, language text, dead boolean, newest_item_at timestamptz,
        curated boolean, category1 text, category2 text, category3 text,
        export_version text
      )
    `);
    await client.query("truncate shows_catalog_staging");

    const copyStream = client.query(
      copyFrom(`COPY shows_catalog_staging (${CATALOG_COLUMNS.join(", ")}) FROM STDIN WITH (FORMAT text)`)
    );
    const lines = rows.map((r) => rowToCopyLine(r) + "\n").join("");
    await streamPipeline(Readable.from([lines]), copyStream);

    const upsertResult = await client.query(`
      insert into shows_catalog (
        pi_id, title, author, itunes_id, feed_url, image_url, episode_count,
        popularity_score, explicit, language, dead, newest_item_at, curated,
        category1, category2, category3, export_version, updated_at
      )
      select pi_id, title, author, itunes_id, feed_url, image_url, episode_count,
             popularity_score, explicit, language, dead, newest_item_at, curated,
             category1, category2, category3, export_version, now()
      from shows_catalog_staging
      on conflict (pi_id) do update set
        title = excluded.title,
        author = excluded.author,
        itunes_id = excluded.itunes_id,
        feed_url = excluded.feed_url,
        image_url = excluded.image_url,
        episode_count = excluded.episode_count,
        popularity_score = excluded.popularity_score,
        explicit = excluded.explicit,
        language = excluded.language,
        dead = excluded.dead,
        newest_item_at = excluded.newest_item_at,
        curated = excluded.curated,
        category1 = excluded.category1,
        category2 = excluded.category2,
        category3 = excluded.category3,
        export_version = excluded.export_version,
        updated_at = now()
      returning (xmax = 0) as inserted
    `);

    // RETIREMENT (fresh-context review finding, 2026-09-15; corrected per
    // Fable ruling after second rejection, 2026-09-15): shows_catalog
    // reflects the FULL canonical set of ONE import run, not an
    // append-only log — a show that fails D1 on a later run (goes dead,
    // ages out, or loses a dedupe tie-break) must stop being searchable,
    // not linger with stale values forever. Retiring by
    // `export_version <> current` is WRONG: export_version can legitimately
    // repeat across two runs of the SAME dump bytes (the `local:` fallback
    // hashes the file; the real remote path reuses the upstream
    // `Last-Modified` header until a new dump is published) while D1's
    // staleness filter depends on wall-clock `now`, not the dump's
    // contents — so a byte-identical re-import after a show crosses D1's
    // 24-month cutoff would keep the same export_version, match nothing
    // in the `<>` predicate, and never retire. The correct ground truth is
    // an anti-join against THIS run's actual staging rows (still alive
    // here — dropped only after this delete), not a version-label
    // comparison.
    //
    // show_id_map may still reference a retiring pi_id (a curated show
    // whose dedupe winner moved to a DIFFERENT pi_id this run) — the FK
    // from show_id_map to shows_catalog is ON DELETE RESTRICT, so those
    // stale mappings must be cleared first, using the SAME anti-join
    // ground truth; `loadIdMap` (called right after this function
    // returns) re-inserts the current run's correct mapping for every
    // curated show, so this never leaves a curated show unmapped.
    await client.query(`
      delete from show_id_map
      where pi_id in (
        select pi_id from shows_catalog s
        where not exists (select 1 from shows_catalog_staging st where st.pi_id = s.pi_id)
      )
    `);
    const retiredResult = await client.query(`
      delete from shows_catalog s
      where not exists (select 1 from shows_catalog_staging st where st.pi_id = s.pi_id)
      returning pi_id
    `);

    await client.query("drop table shows_catalog_staging");
    await client.query("commit");

    const inserted = upsertResult.rows.filter((r) => r.inserted).length;
    const updated = upsertResult.rows.length - inserted;
    return { total: upsertResult.rows.length, inserted, updated, retired: retiredResult.rowCount };
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

/** Upserts `show_id_map` (curated slug -> pi_id) from `import-dump.mjs`'s
    `buildIdMap` result. Small (≤220 today), plain upserts rather than a
    COPY-staging round trip. */
export async function loadIdMap(client, idMap, { exportVersion }) {
  const entries = Object.entries(idMap);
  await client.query("begin");
  try {
    for (const [showId, piId] of entries) {
      await client.query(
        `insert into show_id_map (show_id, pi_id, export_version, mapped_at)
         values ($1, $2, $3, now())
         on conflict (show_id) do update set
           pi_id = excluded.pi_id,
           export_version = excluded.export_version,
           mapped_at = now()`,
        [showId, piId, exportVersion]
      );
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
  return { mapped: entries.length };
}

/** Backfills `catalog_show_episodes.pi_id` / `catalog_show_feed_state.pi_id`
    for any row still null — the exact UPDATE...FROM 0019's migration itself
    runs, re-executed here so a row that was an orphan when 0019 first
    applied (because show_id_map was empty at migration time — no import had
    ever run yet) gets resolved the moment a real import populates
    show_id_map with its show_id (fresh-context review finding, 2026-09-15:
    the migration's one-shot pass can never see mappings that arrive later;
    this makes the backfill re-runnable on every load rather than a single
    missed opportunity). Idempotent — only touches rows where pi_id is
    still null, so a row already resolved is never re-written.

    KNOWN LIMITATION (third review pass, Fable ruling, 2026-09-15): this
    does NOT reconcile a row whose pi_id is already set but has gone STALE
    — a curated show's slug remapping to a different pi_id across import
    runs (D13's dedupe winner changing, or a feed migrating to a new
    PodcastIndex id while the old id survives D1's 24-month window) leaves
    that row's episodes/feed-state attached to the OLD pi_id forever. Ruled
    deliberately deferred, not fixed here: (1) nothing shipped by this card
    reads or writes these tables by pi_id yet — `search-shows.mjs` never
    touches them, and `PostgresShowEpisodesStore` explicitly stays on
    `legacy_show_id` (see that file's own note) — so today this column is
    write-only plumbing with no consumer, and drift in it has zero
    observable effect; (2) the "obvious" one-line fix (`is distinct from`
    instead of `is null`) is UNSAFE to rush: `idx_csfs_pi_id` and
    `idx_cse_pi_id_guid` are unique indexes, so reconciling into a pi_id
    that already has rows (the exact group-split case that causes drift)
    would raise a unique-violation and crash the whole load rather than
    silently drift — trading a latent, consumer-less bug for a pipeline
    outage. A correct fix needs merge/collision semantics (which row wins,
    what happens to the loser's polling history) and belongs to the future
    card that actually rewires `PostgresShowEpisodesStore` onto `pi_id`. */
export async function backfillLegacyShowIdKeys(client) {
  const episodes = await client.query(
    `update catalog_show_episodes e set pi_id = m.pi_id
     from show_id_map m
     where m.show_id = e.legacy_show_id and e.pi_id is null
     returning e.legacy_show_id`
  );
  const feedState = await client.query(
    `update catalog_show_feed_state f set pi_id = m.pi_id
     from show_id_map m
     where m.show_id = f.legacy_show_id and f.pi_id is null
     returning f.legacy_show_id`
  );
  return { episodes_backfilled: episodes.rowCount, feed_state_backfilled: feedState.rowCount };
}

/** Reads the prior release's per-pi_id `newest_item_at` snapshot straight
    from `shows_catalog` (the durable store this loader itself maintains),
    so `changed.json`'s diff has a real baseline on every run after the
    first — fresh-context review finding, 2026-09-15: `runPipeline` was
    being called with an always-empty `previousNewest`, so every canonical
    row reported as "changed" on every single run, including a byte-
    identical re-import of the same dump. Called BEFORE `loadCatalogRows`
    upserts the current run's values, so it reflects the PREVIOUS run's
    state, not the one about to be written. Returns a plain object keyed by
    pi_id (string, matching Postgres's bigint-as-string return shape) to
    epoch seconds, the same unit `buildChanged`/`newestItemPubdate` use. */
export async function fetchPreviousNewest(client) {
  const result = await client.query(
    `select pi_id, newest_item_at from shows_catalog where newest_item_at is not null`
  );
  const previousNewest = {};
  for (const row of result.rows) {
    previousNewest[String(row.pi_id)] = Math.floor(new Date(row.newest_item_at).getTime() / 1000);
  }
  return previousNewest;
}

/** `changed_in_dump` reasons: for each pi_id in `changed` (S-04a's
    `buildChanged` output — ids whose newest_item_at advanced since the
    previous release), records WHY it is flagged, so a consumer (S-10's
    poller) gets an actual reason string rather than a bare id list. Kept
    as a plain array here rather than a table — this is a per-run report,
    not durable state (the durable "did this change" answer lives in
    shows_catalog.newest_item_at itself, which the next load overwrites). */
export function buildChangedInDumpReasons(canonicalRows, changedIds) {
  const changedSet = new Set(changedIds.map(Number));
  const byId = new Map(canonicalRows.map((r) => [Number(r.id), r]));
  const reasons = [];
  for (const id of changedIds) {
    const row = byId.get(Number(id));
    reasons.push({
      pi_id: Number(id),
      reason: row ? "newest_item_pubdate_advanced" : "present_in_changed_set_row_missing",
      newest_item_at: row && Number.isFinite(Number(row.newestItemPubdate))
        ? new Date(Number(row.newestItemPubdate) * 1000).toISOString()
        : null,
    });
  }
  return reasons.filter((r) => changedSet.has(r.pi_id));
}

/** Bytes/row × in_4a count sizing report (card's acceptance: "feeds a later
    human gate on Supabase tier sizing"). Measures the actual encoded row
    size via the COPY line length this file itself produces — the real
    on-the-wire representation, not a guess. */
export function sizingReport(rows, { exportVersion }) {
  if (rows.length === 0) {
    return { row_count: 0, avg_bytes_per_row: 0, estimated_total_bytes: 0, export_version: exportVersion };
  }
  const sampleSize = Math.min(rows.length, 5000);
  let totalBytes = 0;
  for (let i = 0; i < sampleSize; i++) {
    totalBytes += Buffer.byteLength(rowToCopyLine(rows[i]), "utf8");
  }
  const avgBytesPerRow = totalBytes / sampleSize;
  return {
    row_count: rows.length,
    sampled: sampleSize,
    avg_bytes_per_row: Math.round(avgBytesPerRow),
    estimated_total_bytes: Math.round(avgBytesPerRow * rows.length),
    export_version: exportVersion,
  };
}

async function loadCuratedShows() {
  const raw = JSON.parse(await readFile(CATALOG_PATH, "utf8"));
  const shows = Array.isArray(raw) ? raw : raw.shows;
  if (!Array.isArray(shows)) throw new Error(`${CATALOG_PATH} did not parse to an array or {shows:[...]}`);
  return shows;
}

/** Fail-closed on an incomplete id-map, mirroring import-dump.mjs's
    `writeBuildOutput` guard (fresh-context review finding, 2026-09-15:
    `runPipeline` alone does not enforce this — the check lives in
    `writeBuildOutput`, which this loader never calls — so this file was
    silently able to commit a dump missing most curated shows straight to
    Postgres and print LOAD_COMPLETE). Throws ImportError-shaped so the
    caller's existing FATAL/exit-1 handling in `main()` covers it without a
    special case. */
export function checkMissingMapping(result) {
  const curatedTotal = result.curatedTotal ?? (result.missing.length + Object.keys(result.idMap).length);
  const unmappedFraction = curatedTotal > 0 ? result.missing.length / curatedTotal : 0;
  if (unmappedFraction > MAX_UNMAPPED_CURATED_FRACTION) {
    const err = new Error(
      `${result.missing.length} of ${curatedTotal} curated show(s) did not resolve to a pi_id ` +
        `(${(unmappedFraction * 100).toFixed(1)}%, over the ${(MAX_UNMAPPED_CURATED_FRACTION * 100).toFixed(0)}% ceiling) — ` +
        `refusing to load into Postgres: ` +
        result.missing.map((m) => `${m.show_id} (${m.title})`).join(", ")
    );
    err.code = "ID_MAP_INCOMPLETE";
    throw err;
  }
  if (result.missing.length > 0) {
    console.warn(
      `WARN: ${result.missing.length} of ${curatedTotal} curated show(s) are not in this dump ` +
        `(under the ${(MAX_UNMAPPED_CURATED_FRACTION * 100).toFixed(0)}% ceiling, loading continues): ` +
        result.missing.map((m) => `${m.show_id} (${m.title})`).join(", ")
    );
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  const dumpFileArg = get("--dump-file");
  const dryRun = argv.includes("--dry-run");

  const { url: databaseUrl, varName } = resolveDatabaseUrl();
  if (!databaseUrl) {
    console.log(
      "NO-OP: neither SHOWS_DATABASE_URL nor DATABASE_URL is set. " +
      "This pipeline is inert in production until Postgres is provisioned " +
      "(HUMAN-ACTIONS.md: Supabase tier sizing gate, fed by this file's own sizing report)."
    );
    process.exit(0);
  }

  if (!dumpFileArg) {
    console.error("FATAL: --dump-file is required (this pipeline never fetches the real dump itself here — see import-dump.mjs for that step).");
    process.exit(1);
  }

  const curatedShows = await loadCuratedShows();

  const { Client } = await import("pg");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // Real previous-release baseline for changed.json's diff, read BEFORE
    // this run's values overwrite them — see fetchPreviousNewest's own doc
    // comment for why this replaced the always-empty {} that used to go
    // into runPipeline here.
    const previousNewest = dryRun ? {} : await fetchPreviousNewest(client);

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dumpFileArg, { readOnly: true });
    let result;
    try {
      result = runPipeline(db, { curatedShows, previousNewest });
    } finally {
      db.close();
    }

    checkMissingMapping(result);

    const bytes = await readFile(dumpFileArg);
    const exportVersion = get("--export-version") || `local:${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}`;

    const curatedIds = new Set(Object.values(result.idMap));
    const catalogRows = result.canonical.map((row) => toCatalogRow(row, { curatedIds, exportVersion }));
    const changedReasons = buildChangedInDumpReasons(result.canonical, result.changed);
    const sizing = sizingReport(catalogRows, { exportVersion });

    console.log(`parsed ${result.canonical.length} canonical rows (export_version ${exportVersion})`);
    console.log(`sizing report: ${JSON.stringify(sizing)}`);
    console.log(`changed_in_dump: ${changedReasons.length} row(s) flagged: ${JSON.stringify(changedReasons)}`);

    if (dryRun) {
      console.log("DRY_RUN: not writing to Postgres");
      return;
    }

    const loadResult = await loadCatalogRows(client, catalogRows, { exportVersion });
    console.log(
      `shows_catalog: ${loadResult.inserted} inserted, ${loadResult.updated} updated, ` +
      `${loadResult.retired} retired (via ${varName})`
    );
    const idMapResult = await loadIdMap(client, result.idMap, { exportVersion });
    console.log(`show_id_map: ${idMapResult.mapped} curated show(s) mapped`);
    const backfillResult = await backfillLegacyShowIdKeys(client);
    console.log(
      `legacy_show_id backfill: ${backfillResult.episodes_backfilled} episode row(s), ` +
      `${backfillResult.feed_state_backfilled} feed-state row(s)`
    );
  } finally {
    await client.end();
  }

  console.log("LOAD_COMPLETE");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  });
}
