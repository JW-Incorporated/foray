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
