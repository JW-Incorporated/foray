# tools/foraycorpus-export

The foray side of the corpus supply (G-10 / G-11; plan: `docs/roadmap/corpus.md`).

- **G-10 — export.** Reads Joey's corpus (`foraycorpus`, PostgreSQL on the
  tailnet, role `wyatt_readonly`) and turns it into versioned catalogue
  artifacts (show and episode metadata only, no transcript text), published as
  GitHub Releases with a committed pointer, the same way `tools/shows/` does.
- **G-11 — sync.** Mirrors the R2 bucket `foray-transcriptions` (the transcript
  farm writes it in foray's own layout) into `data-local/transcripts/`, then
  the existing warm step rebuilds the searchable index.

The directory is `tools/foraycorpus-export/`, not `tools/corpus/` (that one is
the research-corpus fetcher, an unrelated package).

## Credentials

Credentials are read from the environment or `R2_CREDENTIALS_FILE`, never from the tree.

| env name | what it is |
|---|---|
| `R2_ACCESS_KEY_ID` | R2 S3-API access key id (Object Read on `foray-transcriptions`) |
| `R2_SECRET_ACCESS_KEY` | its secret |
| `R2_S3_ENDPOINT` | the account's S3 endpoint URL |
| `R2_BUCKET` | bucket name; defaults to `foray-transcriptions` |
| `R2_CREDENTIALS_FILE` | path to a file outside the tree holding the four above (e.g. `~/.foray/r2-credentials`) |
| `FORAYCORPUS_DATABASE_URL` | Postgres connection string for the read-only corpus role |

No test reads, prints or writes a credential, opens a network connection or
connects to a database.

## Running the tests

```
npm ci --prefix tools/foraycorpus-export
npm test --prefix tools/foraycorpus-export -- config.test.mjs
```

`tools/ci/run-suites.mjs` finds this package by its `package.json` + `test`
script and runs `npm test -- <files>`, so the script must keep ending in
`node --test` (forwarding its arguments). `config.test.mjs` checks that.

## Modules

Add one paragraph per module as it lands.

- **`config.mjs`** (PKG-01): the one place that defines every path, R2 prefix
  (`transcripts/normalized`, `transcripts/raw`, `fingerprints`), env name, Postgres
  limit, release tag prefix and pointer path. It re-exports `safeKey` from
  `tools/segments/fetch-transcripts.mjs` and `CORPUS_UA` / `AUDIO_UA` /
  `CONTACT` from `tools/segments/politeness.mjs`. This package defines no
  identity strings of its own.
- **`mimes.mjs`, `row-source.mjs`, `fixtures/synthetic/`** (PKG-02): `mimes.mjs`
  is the package's only mime list: `TIMED_MIMES` / `PLAIN_MIMES` (corpus brief
  §2, leading-slash and `plain/txt` variants kept verbatim) and
  `classifyTranscriptMime` / `isTimedMime`, normalising with
  `normalizeMimeType` from `tools/segments/sweep-transcripts.mjs`; a null mime
  is `"other"`. `row-source.mjs` defines the row-source interface
  (`rows(table)` async generator, `counts()`, `describe()`) over the eight
  corpus tables in `TABLES`, and `jsonlRowSource(dir)` streams
  `<table>.jsonl` files line by line, throwing `RowSourceError`
  `MALFORMED_ROW` (with `file:line`) or `UNKNOWN_TABLE`.
  `fixtures/synthetic/` is a hand-written four-podcast corpus with
  `counts.json` (13 assets, 8 episodes, 4 English timed, 3 timed + audio);
  its README records which column lists are brief §1 and which are ASSUMED
  until PKG-03 confirms them.
- **`catalogue.mjs`** (PKG-04): `buildShows(source, { catalog })` streams the
  corpus tables once each and returns `{ rows, stats, chosenFeedByPodcast }`:
  one `shows.jsonl` row per English podcast (`english_candidate_status ===
  "yes"`), sorted by `corpus_podcast_id`, carrying the chosen feed (latest
  `last_success_at`, else the first), PodcastIndex id, `itunes_id`, feed and
  PodcastIndex categories, rights flags (`itunes:block` / `podcast:locked`
  raw `"yes"|"true"|"1"` → true), crawl state, and distinct-episode counts
  (`timed_transcript_episodes` via `isTimedMime`, `audio_episodes` from
  `alternate` audio assets). `foray_show_id` is the `data/catalog.json`
  `show_id` whose feed URL matches under `normalizeFeedUrl` from
  `tools/shows/identity.mjs`, else `String(itunes_id)`, else null. The caller
  passes the parsed catalog; the module never reads `data/`.
  `chosenFeedByPodcast` (internal podcast id → feed id) is what
  `episodes.mjs` takes as its injected Map.
- **`episodes.mjs`** (PKG-05): `buildEpisodes(source, { podcastIds,
  chosenFeedByPodcast })` is an async generator of `{ podcast_id, rows }`,
  one row per episode, newest first, with the guid from the source record on
  the chosen feed, the chosen transcript (`pickTranscriptAsset`: vtt > srt >
  x-subrip > json > other timed, else the first plain, classified by
  `classifyTranscriptMime`) plus the other transcript assets as
  `transcript_alternates`, `chapters_url` (an `asset_type: "chapters"` asset),
  the first `alternate` audio asset and the sorted `asset_ids`. It takes the
  chosen-feed Map injected and does not import `catalogue.mjs`.
  `writeEpisodesFile(outDir, showKey, rows)` writes
  `episodes/<safeKey(showKey)>.jsonl` via a tmp file + rename; the show key is
  `foray_show_id ?? corpus_podcast_id` (`showKeyOf(showRow)`). A path-shaped
  key (`/`, `\`, `.`, `..`, empty) is refused, and the resolved path must
  stay under `episodes/` (the `startsWith(base + sep)` guard from
  `tools/segments/fetch-transcripts.mjs` `transcriptPath`).
- **`manifest.mjs`, `delta.mjs`** (PKG-06): `delta.mjs` holds the export's
  high-water mark in a state file (`readState` gives
  `{version:1, last_export_version, high_water:{max_asset_id, max_episode_updated_at}}`,
  defaults when the file is absent, `DeltaError CORRUPT_STATE` when it does not
  parse). `computeHighWater(source)` streams `assets` and `episodes` once each.
  `isChanged(episodeRow, hw)` is true when an episodes.jsonl row has a strictly
  newer `updated_at` or an asset id above `max_asset_id`. `episodes.updated_at`
  is ASSUMED until PKG-03 confirms it, so a null one makes that half false and
  never throws, and the asset-id half works alone. Timestamps compare as
  instants, not strings. `manifest.mjs` `buildManifest` lists every file of a
  version directory with `bytes`, streamed `sha256` (`hashFile`) and `rows`,
  plus counts, high-water mark, delta and overlap. `computeSourceCounts` gives
  `feeds_known`, `feeds_crawled` (non-null `last_success_at`) and `inserts_30d`
  (`updated_at`, else `source_published_at`, at or after `built_at` − 30 d).
  `writeLatest` writes `latest.json` last. It first re-hashes every listed file
  against the manifest (`ManifestError FILE_MISMATCH` otherwise) and writes
  tmp + rename. Both modules write through `writeJsonAtomic` from
  `tools/segments/sweep-transcripts.mjs`, whose CLI is guarded.
- **`pg-row-source.mjs`** (PKG-07): `pgRowSource({ connectionString =
  process.env.FORAYCORPUS_DATABASE_URL, clientFactory, pageSize })` has the
  `jsonlRowSource` interface (`rows(table)`, `counts()`, `describe()`) plus
  `close()`. On first use it opens one transaction: `BEGIN`, `SET TRANSACTION
  READ ONLY`, `SET LOCAL statement_timeout = 300000`. `rows` pages by keyset
  with plain `query`, `PG_PAGE_SIZE` rows a page, stopping at a short page. It
  uses `id` for podcasts, podcast_feeds, podcast_source_records, episodes and
  assets. It uses the tuples `(episode_id, feed_id)` for
  episode_source_records and `(podcast_source_record_id, feed_id)` for
  podcast_source_links, and reads feed_host_policies whole. The exported
  frozen `SQL` map selects exactly PKG-02's column lists. Its header marks
  podcast_source_records, podcast_source_links, feed_host_policies and
  `episodes.updated_at` as ASSUMED until PKG-03. `counts()` gives
  `pg_class.reltuples` estimates, not exact counts. `describe()` is
  `pg:<host redacted>/<db>`. A connection error is rethrown as
  `RowSourceError PG_CONNECT` with the password replaced by `***`. `pg` is
  imported only inside the default client factory, so the tests (a fake client)
  need no `node_modules`. Rows pass through unchanged, and pg returns int8 as a
  string.
- **`overlap.mjs`** (PKG-09): `computeOverlap(showRows, breadthDoc)` counts
  how much of the breadth tier the corpus already carries. Its inputs are
  `buildShows` rows and `data/catalog-breadth.json`'s parsed object or its
  `shows` array. It returns `{breadth_shows, matched_by_itunes_id,
  matched_by_feed_url_only, unmatched}`, and each breadth show counts once,
  itunes first. `apple_collection_id` is compared with `itunes_id` as strings,
  because pg's int8 arrives as a string. Otherwise the breadth `feed_url`,
  normalised with `normalizeFeedUrl` from `tools/shows/identity.mjs`, is
  compared with `feed_url_normalized`. A null or blank id or feed never
  matches. The CLI is `node tools/foraycorpus-export/overlap.mjs --shows
  <shows.jsonl> [--breadth data/catalog-breadth.json]` and prints the JSON.
  PKG-08 wires `--breadth` into the exporter.
- **`r2-client.mjs`** (PKG-11): `loadR2Credentials({ env, readFile, homedir })`
  takes the `R2_ENV` names when key id, secret and endpoint are all set, else
  the file named by `R2_CREDENTIALS_FILE`, else `~/.foray/r2-credentials`.
  The file is `key = value` lines. Keys are lowercased and matched against the
  farm's alias table (`ALIASES`), so the dashboard spelling (`Access_Key_ID`)
  and the `R2_ACCESS_KEY_ID=` lines HUMAN-ACTIONS #138 asks for both resolve.
  The bucket defaults to `DEFAULT_BUCKET`. A miss throws `R2Error
  NO_CREDENTIALS` naming the sources tried and no value. The secret is
  non-enumerable, and `toJSON()` redacts the key id. `createR2Client` builds
  the farm's client: region `auto`, path-style, and both checksum options
  `WHEN_REQUIRED`. It leaves the SDK's own User-Agent alone. `listPrefix` follows
  `NextContinuationToken`. `getObject` reads the body with
  `Body.transformToByteArray()` (64 MB cap, `TOO_LARGE`) and returns the
  farm's `sha256` metadata as `sha256Meta`. The SDK is imported lazily, and
  the tests inject a fake client and `S3Client` class.
- **`show-map.mjs`** (PKG-12): `buildShowMap({ queue, catalog, breadth })`
  maps each R2 show directory the farm wrote to a foray `show_id`. It returns
  `{ map, collisions }`. The farm names a directory `safeKey(String(
  podcastindex_feed_id))`, or `safeKey(slugify(title))` when the row has no
  PodcastIndex id. `slugify` is the farm's `forayfmt.py` port: NFKD, drop
  non-ASCII, lowercase, `[^a-z0-9]+` → `-`, trim, empty → `show`. Both
  directories of a `data/transcription-queue.json` row map to one show. That
  show is the `data/catalog.json` show with the same `normalizeFeedUrl` feed
  (`catalog-feed`), else `String(apple_collection_id)` (`breadth-apple`),
  else the title slug (`queue-title`). Every catalog `show_id` and every
  `data/breadth-transcript-yield.json` id also maps to itself, raw and
  `safeKey`'d (`identity`, the #831 forward contract). The first writer wins,
  and each dropped mapping is listed in `collisions`. `resolveShowDir` returns
  null for an unknown directory. `localDirFor(show_id)` is `safeKey(show_id)`,
  the name `transcriptPath` writes and `transcriptArchiveLookup.ts` `showDir`
  finds by prefix. `normalizeFeedUrl` and `safeKey` are imported, and the
  caller parses the data files.
- **`catalog-adapter.mjs`** (PKG-31): `catalogAdapter(showRows, {
  breadthOld, catalog, harvestedAt })` turns `buildShows` rows into
  `data/catalog-breadth.json`-shaped rows and returns `{ shows, report }`.
  Rows are skipped, and counted, when they have no `itunes_id`
  (`skipped_no_apple_id`), when either rights flag is set (`skipped_rights`,
  founder ruling 31 in `docs/roadmap/README.md`), when `language` is neither
  `en*` nor null (`skipped_language`), or when they repeat an apple id. A row
  carries the old file's 18 keys: the plan's 17 plus `taxonomy_node_ids`,
  which `breadthCatalog.ts` reads. Then come the additive
  `timed_transcript_episodes` and `audio_episodes`. The chart fields and
  `taxonomy_node_ids` are copied from the old breadth row with the same
  `apple_collection_id`, else null and `[]`. `in_curated` is true only when
  `foray_show_id` is a `data/catalog.json` `show_id`, so the numeric
  `String(itunes_id)` fallback never counts. The report adds `new_vs_old`,
  `dropped_vs_old` and `feed_url_changed`. The CLI (`--shows <shows.jsonl>
  [--breadth] [--catalog] [--out] [--harvested-at]`) writes the envelope
  minified to `data-local/corpus-export/catalog-breadth-corpus.json` and
  refuses an `--out` under `data/`.
