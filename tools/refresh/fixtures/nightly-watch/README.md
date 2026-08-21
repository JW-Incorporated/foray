# The 2026-08-20 night, kept

Five files that reproduce the failure in issue #290 exactly, so that
`tools/refresh/watch-nightly.mjs` can be **shown** to fire rather than argued to.

A watchdog is the single most vacuity-prone thing to test: a fixture that looks
healthy makes every assertion pass while the alarm is wired to nothing. CLAUDE.md
§ "A green test is not evidence until you have broken it" names five rounds that
failed that way, each because the fixture was more forgiving than the real thing.
So **none of this is invented.** Every file is real data pulled out of this
repository's own history, and the two exceptions are marked below.

## What happened, in the four files

On 2026-08-20 the `nightly-refresh` Action ran, published a 29-episode digest to
`refresh-digest`, and logged success. The Claude Cloud agent that turns a digest
into a PR never ran — its account had hit a weekly usage limit. Every workflow
was green. Nothing reached `main`. The next morning the Action published again,
`resolved.json` is **replaced** rather than appended, and those 29 episodes left
the pipeline: 2026-08-19 ended up holding 10 episodes against the previous
Wednesday's 30.

| file | what it is | provenance |
|---|---|---|
| `digest-2026-08-20.json` | the digest that was published and never merged | the 29 episodes `#293` recovered — the 17 dated 08-19 and the 12 dated 08-20 — as they appear in `data/discover.json` at `81f7179` |
| `pulls-2026-08-20-miss.json` | every PR that existed at 21:40 UTC that evening | real `gh pr list --state all`, filtered on `createdAt` |
| `pulls-2026-08-20-healthy.json` | the same list plus the PR the agent never opened | **one synthetic row** (`#289`, `nightly/2026-08-20`), modelled field-for-field on the real `#284` one day earlier, and carrying a `_synthetic` field that says so |
| `discover-2026-08-20.json` | the published pool that evening | the last 80 items of `data/discover.json` at `dacf501`, the commit before the catch-up |
| `discover-2026-08-20-merged.json` | the same pool had the night merged | the file above, plus the digest's 29 |

Two things are **reconstructed** rather than recovered, because the real file is
gone — overwritten the next morning, which is the entire point of the incident:

- the `generated_at` (`2026-08-20T07:25:11.402Z`) is the hour the Action's run
  actually started, not a timestamp read off the file;
- of the 29 items, the 12 dated 08-20 are the ones #293 recovered for that day,
  and a few of them were published later on the 20th than 07:25 — so they could
  not literally have been in the real digest, though episodes exactly like them
  were. The count is real (29, matching the Action's log), the items are real,
  and the arrangement is the incident's shape rather than a photograph of it.

Nothing about either affects a verdict: the checker reads `generated_at` for its
date, and `id` / `apple_track_id` for the pool comparison.

The synthetic PR row in `pulls-2026-08-20-healthy.json` is the third and last
invention, and it labels itself in a `_synthetic` field.

## The three numbers everything rests on

- **29** episodes in the digest, matching the Action's own log line for that
  night (*"published digest: 29 resolved episodes"*).
- **0** of those 29 in `discover-2026-08-20.json`. If a single one were present,
  `DIGEST_CONSUMED` would carry the overwrite tests and `OVERWRITE_WOULD_LOSE`
  would be unreachable — a green suite proving nothing.
- **exactly one** row of difference between the two PR lists. Every green case in
  the suite is therefore one field away from a red one, which is what stops the
  passing tests from passing for some other reason.

`watch-nightly.test.mjs` asserts all three (`the committed fixtures really are
the 2026-08-20 failure`, `the pool fixtures differ by exactly the digest, and
nothing else`), so they are pinned rather than described.

## What was trimmed, and why it cannot flatter the checker

Items keep `id`, `show`, `title`, `apple_track_id` and `release_date`; the
`_description`, `audio_url` and `artwork_url` fields are dropped to keep the
fixtures readable. The checker reads exactly `generated_at`, `resolved[].id` and
`resolved[].apple_track_id` from a digest, and `items[].id` /
`items[].apple_track_id` from a pool — all five survive verbatim, so no trimmed
field could have changed a verdict.

## Regenerating

Don't, unless the incident's shape needs to change. These are a record, not
sample data, and `dacf501` / `9b1374b` / `81f7179` are the three commits the
whole reconstruction hangs on. If you must:

```sh
git show dacf501:data/discover.json   # pool before the catch-up
git show 9b1374b:data/discover.json   # after #291, before the recovery
git show 81f7179:data/discover.json   # after #293 — the 33 recovered episodes
```

The digest's 29 are the items in `81f7179` and not in `9b1374b` whose
`release_date` is 08-19 or 08-20.
