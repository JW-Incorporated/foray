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
