# tools/passage-index

The retrieval side of Generation v2 (plan: `docs/roadmap/generation-v2.md`,
tracking issue #1286). This package builds the search indexes wherever the
transcripts live: the founder PC's `data-local/transcripts/normalized/`, or
the `foray-transcriptions` R2 bucket streamed on the Spark. It holds one body
in memory at a time, so the bucket (about 1 TB) never needs a local mirror.

Later cards add the retrieval server, the passage store and embeddings, the
hybrid merge, the legacy whisper source and the nightly chain to this
directory. Add one section per module as it lands.

## Running the tests

```
npm test --prefix tools/passage-index -- sources.test.mjs stream-index.test.mjs
```

The package has no dependencies. It imports `tools/foraycorpus-export/`
(`r2-client.mjs`, `sync-r2.mjs`, `show-map.mjs`, `inventory.mjs`), whose AWS
SDK import is lazy, and the tests inject the SDK's command classes, a fake S3
client, `statfs` and a recording indexer. No test opens a network connection,
reads a credential or needs `backend/node_modules`.

`tools/ci/run-suites.mjs` finds this package by its `package.json` and `test`
script and runs `npm test -- <files>`, so the script must keep ending in
`node --test` and forwarding its arguments. `stream-index.test.mjs` checks
that. `--experimental-sqlite` is in the script for the passage store that a
later card adds (node:sqlite is behind a flag on Node 22.x).

## stream-index.mjs: the stream indexer (GV-09, W3-05)

```
node tools/passage-index/stream-index.mjs --source local|r2 [--show x] [--full]
  [--passages-out f] [--index-root d] [--cue-cache d --cue-cache-gb n]
  [--staged-out f] [--manifest-dir d] [--normalized-root d] [--min-free-gb n]
```

It builds three things from a stream of transcript bodies:

- the per-show BM25 caches in `data-local/transcripts/index/`, byte-compatible
  with the ones `FileTranscriptTextIndex` builds from a local mirror;
- the staged digest rows (`data-local/passage-index/staged-digest.jsonl`) for
  bodies the committed digests do not describe yet;
- the passages (`--passages-out`), once GV-12 adds that flag to the backend
  indexer.

The steps of a run:

1. **List.** `--source local` walks the normalized tree. `--source r2` lists
   `transcripts/normalized/` with ListObjectsV2 only, and nothing else.
2. **Choose shows.** With `--full`, every listed show is rebuilt. Otherwise
   only the shows that changed since the last run are rebuilt: a file was
   added or removed, or a file's size or etag changed (mtime when there is no
   etag). `--show` narrows the run to one show, named by its show_id or its
   directory name. A show is always re-streamed whole, because the index
   keeps its postings per show.
3. **Guard the disk**, before any body is read or fetched. The estimate is
   0.4x the bytes of the bodies to stream for postings, plus 1.1x when
   `--passages-out` is set, plus the most the cue cache can take. The guard
   is `ensureDiskSpace` from `tools/foraycorpus-export/inventory.mjs`. It
   refuses with `DISK_SPACE` and exit code 2 when free space minus the
   estimate is under `--min-free-gb` (default 20). `--min-free-gb 0` turns the
   guard off.
4. **Stream.** One `backend/src/cli/indexBodies.ts` child (GV-05) is spawned
   through `backend/node_modules`' tsx, the same way
   `tools/generation/warm-transcript-index.mjs` starts the warmer. It gets one
   JSONL `body` record per body and an `end-show` record after each show. The
   launcher waits for the child's summary line for a show before it starts
   the next one.
5. **Commit the manifest** after each show (below).

**R2 bodies.** Each object is fetched once. It must match the farm's
`sha256` metadata, parse, and pass sync-r2's `bodyShapeError`. An object that
fails is quarantined with sync-r2's reason codes (`SHA_MISMATCH`, `BAD_JSON`,
`BAD_SHAPE:<field>`, `PATH_ESCAPE`, `TOO_LARGE`, `NO_BODY`), reported and
skipped, and the run goes on. A GET that fails for any other reason is
reported as `GET_FAILED:<name>` and not remembered, so the next run retries
that show. Each R2 directory is mapped to a foray show_id with
`tools/foraycorpus-export/show-map.mjs`. A directory the map does not know
keeps its R2 name, exactly as `sync-r2.mjs` handles it, and is reported.
`stat.mtimeMs` is the object's LastModified.

**Local bodies.** The walk is the listing `FileTranscriptCueProvider` makes:
every `*.json` file, with the show_id taken from the directory name minus its
`-<10 hex>` suffix. `stat` is the file's own stat, so the caches are fresh to
a local `FileTranscriptTextIndex`.

**Manifest** (`data-local/passage-index/`):

- `episodes.jsonl` has one row per streamed body:
  `{show_id, fileName, bodyGuid, cues, lastEndSec, size, mtimeMs, origin, indexedAt}`.
  `origin` is `{kind: "local", key: "<dir>/<file>", sha256}` or
  `{kind: "r2", key, etag, sha256}`.
- `quarantine.jsonl` has one row per object refused for a reason the same
  bytes would give again: `{show_id, fileName, size, mtimeMs, origin, reason, at}`.
  It keeps an unchanged bad object from re-streaming its whole show every
  night.

Both files are rewritten through a tmp file and a rename after each show.

**Cue cache.** `--cue-cache d --cue-cache-gb n` also keeps each streamed body,
byte for byte, at `d/<local dir>/<fileName>`, laid out like
`transcripts/normalized/`. The cache is bounded by bytes and evicts the least
recently used body first, ordered by file mtime when the cache is opened and
then by write order. The remote cue store (GV-54) reads through it.

**What it writes.** The caches, the staged rows, the manifest and, only when
set, the passages and the cue cache. Nothing else. No body is written outside
the cue cache.

`indexBodies` appends staged rows, so a re-streamed show appends its rows
again. Readers keep the first row per guid.

**Exit codes.** 0 when the run is done (quarantines are reported, not fatal),
1 when the indexer reported a problem or failed, 2 on `DISK_SPACE`.

**Running it.**

- On the founder PC: `--source local --full`, once. After that, the delta.
- On the Spark: `--source r2 --full` with the R2 read key
  (`R2_CREDENTIALS_FILE`, see `tools/foraycorpus-export/README.md`), then
  nightly. The Spark is shared (OQ-07), so run it niced, for example
  `nice -n 10 node tools/passage-index/stream-index.mjs --source r2`.
- The tsx child needs `backend/node_modules` on the machine that runs it.

Re-streaming a whole show costs up to about 306 MB for the largest show.
