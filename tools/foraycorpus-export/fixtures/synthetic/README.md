# Synthetic corpus fixture (PKG-02)

Synthetic, hand-written 2026-09-25; column lists for podcasts/podcast_feeds/episodes/episode_source_records/assets are brief §1; the lists for podcast_source_records, podcast_source_links, feed_host_policies and the column episodes.updated_at are ASSUMED and confirmed by PKG-03; replaced for validation by `fixtures/scrubbed-2026-09/` (PKG-03).

Nothing here was copied from the corpus database. Every id, URL, title and
hash is invented; URLs use `example.org` except where a row needs a realistic
host (`api.omny.fm` transcripts and `traffic.omny.fm` audio on show A).

## Files and columns

One JSON object per line, one file per table. The column lists for the
first five tables are subsets of the brief's §1 lists
(`docs/curation/corpus-integration-brief.md:29-35`). The last three files and
`episodes.updated_at` are ASSUMED (taken from foray-db's models by the
planner, not in the brief).

| file | rows | columns |
|---|---|---|
| `podcasts.jsonl` | 4 | id, public_id, canonical_title, description, declared_language, english_candidate_status, explicit, author, site_url, image_url, status |
| `podcast_feeds.jsonl` | 4 | id, podcast_id, current_url, normalized_url, url_hash, status, last_success_at, last_attempt_at, crawl_rank, crawl_tier, categories, itunes_block_raw, podcast_locked_raw |
| `podcast_source_records.jsonl` | 4 | id, source_record_id, itunes_id, extra_source_json (ASSUMED) |
| `podcast_source_links.jsonl` | 4 | podcast_source_record_id, feed_id, podcast_id (ASSUMED) |
| `episodes.jsonl` | 8 | id, public_id, podcast_id, canonical_title, description, source_published_at, duration_seconds, explicit, status, updated_at (`updated_at` ASSUMED) |
| `episode_source_records.jsonl` | 8 | episode_id, feed_id, guid_raw, guid_hash, title_raw, description_raw, pub_date_parsed, duration_parsed_seconds |
| `assets.jsonl` | 13 | id, owner_type, owner_id, asset_type, url, mime_type, language, relation, declared_byte_length |
| `feed_host_policies.jsonl` | 2 | host, state, reason (ASSUMED) |

`row-source.test.mjs` reads the `rows` column of this table and checks every
file against it, so a row added or dropped must be recorded here.

## Content

| podcast | id | english_candidate_status | episodes | assets | feed | itunes_id |
|---|---|---|---|---|---|---|
| A | 1 | yes | 101-103 | each: `text/vtt` transcript + `alternate` `audio/mpeg` on `traffic.omny.fm`; plus one `chapters` asset (`application/json+chapters`) on 101 | 11, crawled | 111 |
| B | 2 | yes | 104-105 | `text/plain` transcript only | 12, not crawled, `itunes_block_raw: "yes"` | null |
| C | 3 | no | 106-107 | `text/vtt` transcript | 13, crawled | 333 |
| D | 4 | yes | 108 | `application/srt` + `application/json` transcripts, no audio | 14, not crawled, `podcast_locked_raw: "true"` | 444 |

Episode `updated_at` and asset `id` both increase with row order (episodes
101-108, assets 1001-1013), so PKG-06's delta has a high-water mark to key on.
Asset 1002 (A's first audio) carries a `declared_byte_length`; every other
asset has null, as every audio row in the real corpus does (brief §3).

## counts.json derivation

- `podcasts` 4; `podcasts_english` 3 (A, B, D).
- `episodes` 8.
- `assets` 13 = A 3 × (vtt + audio) 6 + A chapters 1 + B 2 plain + C 2 vtt + D srt + json 2.
- `episodes_english_timed` 4 = A 3 + D 1 (B is plain, C is not English; D's
  two timed assets count once, it is distinct episodes).
- `episodes_english_timed_audio` 3 = A 3.
- `feeds` 4; `feeds_crawled` 2 = A, C (non-null `last_success_at`).
