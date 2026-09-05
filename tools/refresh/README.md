# Nightly refresh pipeline (`tools/refresh/`)

The committed, versioned successor to the old `data-local/*.mjs` machinery. Three
static scripts + two ephemeral data files. **Machinery is code (committed here);
per-night content is data (never code).** This is the whole point of the
consolidation: the old flow regenerated a `merge-YYYY-MM-DD.mjs` every night with
the hooks/tags baked into it — unversioned and impossible to run in the cloud.

## Stages

```
scan.mjs ──▶ fresh-pending.json ──▶ resolve.mjs ──▶ resolved.json ──▶ merge.mjs ──▶ data/discover.json
  (RSS)         (raw episodes)        (iTunes)      (the digest)      (+ edits.json)   data/item-tags.json
                                                          │
                                            agent authors edits.json
```

| Script | Keyless? | Role |
|--------|----------|------|
| `scan.mjs`    | ✅ | Poll curated RSS feeds, emit episodes newer than last run |
| `resolve.mjs` | ✅ (iTunes lookup) | Resolve `apple_track_id`, dedup, drop unresolvable/dupe/invalid-topic |
| `merge.mjs`   | ✅ | Apply agent-authored hooks/tags, enforce copy rules, write data files |
| `enclosure.mjs` | — | Shared audio-provenance helpers (not a stage) |
| `dai.mjs` | — | DAI host classification (not a stage) |
| `watch-nightly.mjs` | ✅ | **Not a stage.** Watches for the ABSENCE of a night — see below |
| `classify-dai.mjs` | ✅ | **One-shot, not nightly.** Classifies shows, stamps `dai_suspected` |
| `backfill-audio.mjs` | ✅ | **One-shot, not nightly.** Backfills audio onto pre-#21 items |
| `backfill-show.mjs` | ✅ | **One-shot, not nightly.** Emits a pending file for a NEWLY CURATED show |

## Audio provenance (issue #21)

Every episode carries a playable URL through all three stages:

| field | source | notes |
|---|---|---|
| `audio_url` | RSS `<enclosure url>`, iTunes `episodeUrl` as fallback | **original, pre-redirect** |
| `audio_type` | enclosure `@_type` | video-only items are skipped (corner case #6) |
| `audio_bytes` | enclosure `@_length` | `0` means unknown → stored as `null` |
| `duration_sec` | `itunes:duration`, normalised | exact; `duration_min` stays for copy |

Three rules that are easy to get wrong and expensive to discover late:

1. **RSS is authoritative, iTunes is a fallback.** Not the other way round. The
   iTunes lookup only returns recent episodes — at `limit=25` it reaches back
   about a year, at `limit=200` roughly three. Most of the catalogue is recent
   so an iTunes-first strategy *looks* fine in aggregate while failing on the
   back catalogue, which is where the hand-curated session content lives.

2. **Never substitute the resolved CDN URL.** Corner case #1: publishers count
   downloads at the prefix host. We store and play the URL they published. The
   RSS enclosure and iTunes `episodeUrl` genuinely differ for the same episode
   (`content.blubrry` vs `ins.blubrry`), which is another reason RSS wins.

3. **A null `audio_url` is fine; a malformed one is not.** Items with no
   playable URL stay in discovery and link out to Apple Podcasts (see issue
   #25). CI warns on nulls and *fails* on a non-https or tokened URL — corner
   case #9, a tokened URL is a secret and must never reach a public data file.

## Dynamic ad insertion (issue #22)

`dai_suspected` on every playable item gates seek precision in #30: exact
hard-seek and chapter jumps for a static file, *"roughly minute 70"* for a
stitched one (corner case #2).

**The host list is the only signal.** #22 also proposed probing an enclosure
twice and comparing total length. Measured across six shows — three on
known-DAI hosts, three static, ~6s apart — every single one returned a
byte-identical total. Zero discrimination. And the measurement was wrong in
principle, not merely underpowered: DAI is *designed* to serve a stable file to
a given listener so that resume works. The bytes vary across listeners and long
time gaps, never between two requests from one IP. Dropped.

> Corollary for #30: because a listener's own copy is stable, a position or
> bookmark **they** created is reliable for them. The misalignment risk is
> against timestamps from a *different* copy — chapter marks authored on the
> un-stitched master, or transcript times from a separate fetch.

**Classification follows redirects.** ~38% of the catalogue sits behind
download-measurement prefixes that hide the origin: `pdst.fm` resolves to
`dcs-cached.megaphone.fm`, so 108 items look neutral and are actually Megaphone.
We resolve only to *look* — corner case #1's rule about playing the publisher's
declared URL is untouched.

```bash
node tools/refresh/classify-dai.mjs --dry-run
node tools/refresh/classify-dai.mjs                # resolve unclassified shows
node tools/refresh/classify-dai.mjs --reclassify   # re-apply the host list, no network
node tools/refresh/classify-dai.mjs --recheck      # re-resolve everything
```

Verdicts cache per **show** in `data/dai-classification.json`, so a normal run
resolves nothing it has seen and the nightly costs nothing. `merge.mjs` stamps
new episodes from that cache.

**Maintaining the list** (`dai-hosts.json`) is the lever. Every entry needs a
real justification — a test enforces it, because an unexplained entry is one
nobody can safely remove later. After editing, run `--reclassify`; re-resolving
220 shows over the network to apply a one-line change would be absurd.

Current state on this branch: **141 of 220 shows are DAI**, leaving **509 items
eligible for precise seeking**. (`main` at `9b1374b` is 139 of 213 and 489 —
the seven shows and 28 items of #279 are the difference.) **Both numbers move
every night**, so do not quote them: `classify-dai.mjs --reclassify --dry-run`
prints the live figures and touches no network. This line carried `326` from #47
until #279 without anyone re-running it, which is the whole argument for naming
the command instead of a number.

Re-run `--reclassify` after adding shows to
`data/catalog.json`: `merge.mjs` reads this cache and stamps `false` for a show
it has never seen, so seven shows added in #279 landed 28 items with
`dai_suspected: false` and two of them (art19, Megaphone) were wrong until
`classify-dai.mjs` ran.

### Adding a newly curated show's episodes

`scan.mjs` cannot do this. It reads the newest **10** items of each feed inside a
**48-hour** window — correct for a nightly, useless for a show added today whose
whole back catalogue is older and deeper than both limits.

```bash
node tools/refresh/backfill-show.mjs --show cider-chat --dry-run
node tools/refresh/backfill-show.mjs --show cider-chat --match 495 --match 489
node tools/refresh/backfill-show.mjs --show cider-chat --show whiskycast --newest 40
```

It emits the **same shape** `scan.mjs` emits, so the rest of the pipeline is
reused unchanged:

```bash
PENDING_PATH=data-local/backfill-pending.json \
  RESOLVED_PATH=data-local/resolved.json node tools/refresh/resolve.mjs
# agent authors data-local/edits.json from resolved.json
node tools/refresh/merge.mjs
node tools/refresh/classify-dai.mjs        # <- do not skip this, see above
```

Three things about it that are easy to get wrong:

- **`--newest` defaults to 25 to match `resolve.mjs`'s `limit=25` lookup**, not to
  the feed. Rows deeper than the iTunes window resolve to no trackId and are
  dropped, correctly — the trackId is the only trustworthy duplicate guard.
  Measured 2026-08-19: Cider Chat at `limit=25` reaches 2026-01-21, at `limit=200`
  it reaches 2022-03-23.
- **`--match` filters INSIDE the `--newest` window, never past it**, so a match
  cannot produce rows the resolve step can only drop.
- **Zero matches is an error, not an empty run.** A typo'd `show_id` and a feed
  with nothing to backfill must never look the same to the operator.

It writes `data-local/backfill-pending.json`, **not** `fresh-pending.json`, and it
never reads or writes `refresh-state.json` — stamping the nightly's seen-guid
state with episodes nobody has merged is how a backfill would silently cost you
the next night's real episodes.

### Backfilling audio

```bash
node tools/refresh/backfill-audio.mjs --dry-run     # report only
node tools/refresh/backfill-audio.mjs              # write data files
node tools/refresh/backfill-audio.mjs --force      # re-resolve everything
```

Idempotent and re-runnable; skips items that already have `audio_url` unless
`--force`. Fetches each **show** feed once, then matches all of that show's
items. Coverage is reported separately for 2026+ and pre-2026 — a single
blended number hides exactly the failure mode described in rule 1 above.

The **judgment step** (writing hooks + tags) is the only non-deterministic part.
It is performed by an agent (Claude Code locally today, a Claude Cloud scheduled
agent after migration) and its entire output is `edits.json` — a data file.

## `edits.json` contract

The agent reads `resolved.json` (each item carries `_description`, the episode's
real blurb) and writes, for every item it wants to publish:

```json
{
  "<item-id>": {
    "hook": "<=16 words, grounded in the real description",
    "tags": ["5-to-12", "lowercase-hyphenated", "tags"],
    "topics": ["nature/earth-science", "history/technology"]
  }
}
```

Rules (mirrored in `merge.mjs`'s preflight AND the CI gate — keep in sync with
`backend/test/copyRules.test.ts`):

- Hook ≤ 16 words. Banned: `fascinating`, `deep dive`, `delve`, `explores`,
  clickbait withholding, any commute-length framing.
- 5–12 tags, each `^[a-z0-9]+(-[a-z0-9]+)*$`; reuse existing vocabulary in
  `data/item-tags.json` where it applies.
- A resolved item with **no** edit is skipped (the agent may deliberately omit a
  cross-promo/trailer that slipped through). Items already in `discover.json` are
  skipped — `merge.mjs` is idempotent and safe to re-run.

### `topics` — optional, and the only per-episode topic seam (#292)

`scan.mjs` and `backfill-show.mjs` both seed an episode's topics from its
**show's** `taxonomy_node_ids` in `data/catalog.json`. **Omit `topics` and that
seed stands**, which is the right answer for a single-subject show: *Engines of
Our Ingenuity* really is `history/technology` on all 38 episodes, *The Race F1
Podcast* really is `automotive/racing`. Supply `topics` and it **replaces** the
seed outright for that one episode.

Be slow to conclude a show is single-subject. *Odd Lots* looks like the safe case
and is not — 22 episodes on `economics/markets` include *How the Invention of
Rope Gave Us Modern Civilization* and *Architect Norman Foster on Why the West
Struggles to Build Big*. Read the episodes, not the show's premise.

It is applied in `merge.mjs` — the single point where the nightly and the
backfill converge — so the two pipelines cannot disagree about it. Rules and the
reasoning behind each live in `topics.mjs`; the short version:

- every id must exist in `data/taxonomy.json` (a bad id **fails the run** in
  preflight; it is never filtered away, which would silently restore the show
  default);
- `[]` is **refused**. `resolve.mjs` drops an episode with no valid topic, so an
  empty override would remove the episode from the catalogue rather than relabel
  it, and the product rule is **label, never exclude**;
- the first topic is the item's **branch** for discovery diversity
  (`branchOf` in `search-engine.js`), so put the primary subject first.

Before deciding whether a show needs overrides, read it:

```
node tools/refresh/topic-uniformity.mjs                       # N of M shows carry one label
node tools/refresh/topic-uniformity.mjs --show "Radiolab"     # one show, episode by episode
```

That report **exits 0 and is not a gate**, deliberately: a uniform label is a
defect on a show that ranges and a truth on a show that does not, and no
arithmetic separates them. Only reading the episodes does.

## The watchdog (`watch-nightly.mjs`, issue #290)

Everything above is the pipeline. This is the thing that notices when half of it
does not happen.

On 2026-08-20 and 2026-08-21 the Cloud agent did not run — its account had hit a
weekly usage limit. The Action succeeded both nights and logged *"published
digest: 29 resolved episodes"* both nights. Every workflow was green and nothing
reached `main`. The only symptom was an **absence**, and nothing watched for one.

The runner prompt already guards the mirror image: step 2 refuses a digest older
than 12 hours, because a stale digest holds only items already in
`discover.json`, so `merge.mjs` reports "0 items added" — *"a silently skipped
night that looks like a successful one"*. That is this bug's reasoning applied to
a missing **Action**. This module applies it to a missing **agent**, on the same
12-hour clock. Together they say: a digest must be *consumed* within 12h of being
*made*, and whichever half fails to hold up its end goes red.

Two modes:

```sh
# "did last night produce a PR?" — scheduled, hours after the agent should be done
node tools/refresh/watch-nightly.mjs --mode absence \
     --digest resolved.json --pulls pulls.json

# "would publishing now destroy an unmerged digest?" — run by the Action BEFORE it publishes
node tools/refresh/watch-nightly.mjs --mode overwrite \
     --digest prior-resolved.json --pulls pulls.json --discover data/discover.json
```

`--mode overwrite` is the one that matters. `resolved.json` is **replaced** each
night, not appended, so the moment data is actually lost is when a digest is
about to be overwritten while its predecessor never merged. It fires only when
both signals agree — no `nightly/<date>` PR open or merged, **and** not one of
that digest's episodes in the pool — because the runner is told to drop
cross-promos, trailers and encores, so "some items never landed" is a healthy
night and only "none of them landed" is unambiguous.

Because it runs before the publish step, **detecting is preventing**: the job
fails with `resolved.json` and `refresh-state.json` untouched, so the unmerged
digest survives and tonight's episodes are still unseen. Nothing needs
recovering; a human just has to look.

The flip side is that a red guard stalls the pipeline until its verdict changes,
so the way out is printed in the failing run's own summary rather than left to be
worked out: re-cut the digest (do **not** retry the runner against it — it is
over 12h old by then and step 2 refuses it), and name the recovery branch after
the **digest's** date, `nightly/<date>-recovery`, because that is the string the
guard looks for. `--window-hours` is computed from the digest's age, since the 72
in #293's runbook is right for a one-day-old digest and silently too small for
one stranded over a weekend. If the episodes are genuinely gone from the feeds,
`nightly-refresh` takes an `overwrite_unmerged_digest` dispatch input — the only
way past the guard, and deliberately a decision with someone's name on it.

Every input is a file the caller fetched — no network, no dependencies — which is
what lets `watch-nightly.test.mjs` replay the real 2026-08-20 night from
`fixtures/nightly-watch/` and prove the alarm fires.

### A third mode, added by S-01: did the Action itself fail?

`absence` and `overwrite` are both shaped around the digest/PR handoff, and
neither one answers "did today's scheduled `nightly-refresh` run succeed at
all" — a run that fails inside its own scan/resolve/publish steps can still
leave a perfectly healthy PREVIOUS night's digest sitting there merged, which
reads as green to both of the checks above. That is the same blind spot #290
was about, one layer closer to the metal: "the job I can see finished" is not
"the job did what it was for".

```sh
# "did today's scheduled nightly-refresh run succeed?" — independent of any digest/PR state
node tools/refresh/watch-nightly.mjs --mode run-failed --runs runs.json
```

`runs.json` is `gh run list --workflow nightly-refresh.yml --event schedule
--json databaseId,event,status,conclusion,createdAt`. Only `event: schedule`
rows count — a manual `workflow_dispatch` retry (someone exercising
`overwrite_unmerged_digest` by hand, say) must not stand in for the run the
cron was supposed to make. `nightly-watch.yml` runs this check **and** the
`absence` check every evening; either one failing turns the job red, because
they are answering different questions and a green answer to one must never
paper over a red answer to the other.

## Running locally

```sh
node tools/refresh/scan.mjs --window-hours 48     # ~10 min, ~213 feeds
node tools/refresh/resolve.mjs                     # writes data-local/resolved.json
# agent authors data-local/edits.json from resolved.json
node tools/refresh/merge.mjs                        # writes data/discover.json + item-tags.json,
                                                    # then regenerates deploy-manifest.json + sw.js
cd backend && npx vitest run test/copyRules.test.ts test/poolIntegrity.test.ts
```

**On a Windows `core.autocrlf=true` checkout the last step of `merge.mjs` refuses**
(`tools/ci/crlf-guard.mjs`): the data files are written, then the manifest step
exits 1 with `DO NOT COMMIT`. That is correct — the manifest hashes bytes on
disk and a CRLF checkout would hash bytes we never ship. Either run the merge
on an LF checkout (the nightly's Linux runner is one), or commit the two data
files and let `.github/workflows/manifest-autofix.yml` restamp the manifest on
the PR — knowing that its `github-actions[bot]` commit then needs an approving
review from someone other than the PR's author (HUMAN-ACTIONS #37).

## Path overrides (used by the cloud split)

All intermediate paths are env-configurable so the same scripts run unchanged in
GitHub Actions (ephemeral workspace) and locally (`data-local/`):

| Env | Default | Set by |
|-----|---------|--------|
| `STATE_PATH`    | `data-local/refresh-state.json` | Action (persisted via cache/artifact) |
| `PENDING_PATH`  | `data-local/fresh-pending.json` | Action |
| `RESOLVED_PATH` | `data-local/resolved.json`      | Action publishes this to the digest branch |
| `EDITS_PATH`    | `data-local/edits.json`         | Cloud agent writes this |
| `MERGE_DISCOVER_PATH` | `data/discover.json`      | Tests only — the nightly writes the real file. Setting EITHER `MERGE_*` var to a path other than the real file also skips the deploy-manifest step (`manifest-step.mjs`): a redirected run changed nothing the manifest describes. Setting it to the real path is not a redirect and does not skip |
| `MERGE_TAGS_PATH`     | `data/item-tags.json`     | Tests only — the nightly writes the real file |

**The `MERGE_` prefix is load-bearing, not tidiness.** `tools/classify/root-dumping-report.mjs`
has its own live `DISCOVER_PATH`, and its documented workflow has you exporting it
in a shell. An unprefixed name here would mean one exported variable feeding one
tool and being silently ignored by the other — and the one that ignores it
**writes `data/discover.json` in place**, so the operator believes they are
writing to a scratch file while the real catalogue is overwritten. Use the exact
names in this table; a near-miss fails open, not closed.

## Cloud topology (Hybrid — see `docs/` migration plan)

1. **GitHub Actions cron** runs `scan.mjs` + `resolve.mjs`, publishes
   `resolved.json` to a dedicated digest branch (no secrets, no LLM).
2. **Claude Cloud scheduled agent** reads the digest, authors `edits.json`, runs
   `merge.mjs`, validates, and opens a PR against protected `main`.
3. A human (or an integrity check) merges the PR; GitHub Pages deploys.
