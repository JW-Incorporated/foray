# Round 3 (code audit): dedup

216 raw findings from 16 areas. The dedup pass kept 186 unique findings, folded 28 duplicates into 23 of them, and dropped 2 before verification (186 + 28 + 2 = 216).

The kept id is the one in `findings.tsv`. A merged finding survives as an entry in the kept finding's `duplicates` and `merged_ids` fields in `findings-detail.md`.

## Clusters with merges (23)

| kept | merged | kept finding |
|---|---|---|
| app-1-2 | security-5, data-integrity-1 | Concurrent event syncs are not single-flighted: the same rows are POSTed twice and a fresh device can mint several anonymous accounts |
| app-1-10 | data-integrity-2 | Event sync with more than 500 rows re-sends already-accepted batches when a later batch fails, creating duplicate server rows |
| app-1-4 | security-6, data-integrity-3 | A transient failure of the refresh-token call signs the device up as a new anonymous user, orphaning the listener's identity |
| app-1-1 | data-integrity-5 | races-4 fix is incomplete: listener-action writes and first-run detection still run against an unhydrated store and permanently overwrite durable rows |
| app-1-8 | perf-4 | cp_saved keeps full untrimmed snapshots (publisher description and chapters) and is re-parsed once per rendered row |
| app-1-11 | perf-7 | Unbounded session caches: showEpisodesCache and state.itemIndex hold full episode descriptions for every show visited |
| app-2-14 | perf-9 | playerBridge leaks a 'forayplayer:ready' listener on every timed-out wait |
| app-2-15 | arch-drift-9 | Dead code in the search section: episodeDedupKey and showIndexFetchCount |
| app-1-16 | app-3-12 | showNameLink builds `#/show/<id>` without encodeURIComponent, while the router decodes the segment and the prefetch handler decodes the whole tail |
| app-3-2 | perf-1 | On the Vercel origin the service worker intercepts /api/* and keys its cache without the query string, so a slow or failing API call returns another query's results; those responses also survive Delete my data |
| app-3-4 | perf-5 | The service worker's activate deletes every CacheStorage bucket it does not own, including the app's own 'foray-shows-index-v1' shard cache, on every deploy |
| app-3-7 | perf-6 | The service worker strips the Range header when it refetches same-origin media, so the interlude jingle always gets a 200 full body (Safari expects 206) |
| player-rest-2 | data-integrity-6 | idb-tier (and event-log) cache an IDBDatabase handle forever and never reopen after the connection is closed |
| player-rest-4 | data-integrity-7 | listProgress over DurableStore is O(n²): key(i) and length rebuild the owned-key array on every call |
| search-api-css-4 | security-2 | TtlCache never evicts, and the show-scoped path has no rate limit: unbounded memory growth and outbound feed-fetch amplification |
| ci-release-11 | search-api-css-12, security-14, tests-12 | The CI `api` job installs with `npm install`, but Vercel installs with `npm ci`, so CI can pass on a lockfile/manifest mismatch that breaks the production deploy |
| ci-release-12 | security-4 | The iOS build paths (including the TestFlight release action) still use `npm install` under a stale 'no committed lockfile' comment, while Android uses `npm ci` |
| backend-rest-4 | security-7 | Catalog and pipeline tables have no RLS, so on Supabase the public anon key can insert or modify catalogue episodes |
| backend-rest-1 | arch-drift-1 | parseFeed throws on an out-of-range numeric entity, so a show's episode page returns HTTP 500 in production |
| ci-release-4 | mobile-native-9 | The build number is not monotonic: the run_number wrap (99 -> 1) on the same UTC day makes both stores reject every later release that day, and then the retry budget stops the trigger |
| security-1 | ci-release-1 | Hourly pr-hygiene sweep arms and merges fork PRs from outside contributors, and app.js, sw.js, player/ and mobile/ are all on the auto-merge allowlist |
| arch-drift-13 | search-api-css-9, security-13 | The live episodes endpoint's DB branch has drifted from its no-DB branch: no pagination, different response shape, and connect() can 500 |
| data-tools-7 | arch-drift-11 | Feed fetchers outside scan.mjs skip the M1 byte cap (and backfill-show has no timeout); fetch-limits' header wrongly claims refresh-feeds uses it |

The other 163 clusters are single findings with no duplicate.

## Dropped before verification (2)

| id | reason |
|---|---|
| player-core-11 | Scope note, not a defect: player/transport-policy.js and player/continuation.js simply do not exist on origin/main. |
| data-integrity-11 | Restates refuted round-1 qa 33: the 'Timings on this show are approximate' note (player/client.js:1982-1983) is evaluated with source: OWN and is intentionally empty on every DAI show per docs/curation/dai-playback-brief-2026-09-10.md, so the snapshot default changes nothing visible; the code is unchanged since the refutation. |
