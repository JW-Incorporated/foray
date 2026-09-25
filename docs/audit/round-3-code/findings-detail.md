# Round 3 (code audit): full findings (2026-09-25)

One section per verified finding, in `findings.tsv` order. Each section holds the finder's full record (title, file, line, severity, scenario, evidence, fix_sketch, duplicates) and the adversarial verifier's `verdict`, `verdict_severity` and `verdict_reasoning`. `merged_ids` names the raw findings the dedup pass folded into this one; their one-line claims are not kept separately, the kept finding's evidence covers them. `lane` is the synthesis lane for a confirmed finding.

`file:line` is against origin/main as the audit read it on 2026-09-25. Check it before trusting it on a later tree.

## app-1-2: Concurrent event syncs are not single-flighted: the same rows are POSTed twice and a fresh device can mint several anonymous accounts

**confirmed** · verifier severity **medium** (finder: medium) · app-1 · race-condition · `app.js:560` · L1-app-data

```json
{
  "id": "app-1-2",
  "area": "app-1",
  "category": "race-condition",
  "title": "Concurrent event syncs are not single-flighted: the same rows are POSTed twice and a fresh device can mint several anonymous accounts",
  "file": "app.js",
  "line": 560,
  "severity": "medium",
  "scenario": "trySyncEvents() starts a new syncEventsOnce() on every call. The storage-waiting branch queues one waiter per call, and markStorageSettled runs every waiter synchronously. So each action taken while hydration was pending (the boot's session_shown sync, a play, a pick, a thumb) fires its own sync at the same moment. Each one awaits forayEventLog.unsynced(), gets the same rows and POSTs them. The events table has no unique key (event rows carry no client id, as the comment at 369-375 notes), so the server stores every row N times and the learning job double-counts thumbs and picks. On a first-ever launch with no cp_sb_session, each concurrent ensureAnonSession() calls /auth/v1/signup. That makes N anonymous users, the last lsSet wins, and rows posted under the other accounts are orphaned and cannot be removed by Delete my data. After settle the same thing happens without the queue: two thumbs taps, or a play landing while a slow refresh+POST sync is still in flight.",
  "evidence": "`if (storageWaiting()) return new Promise(resolve => afterStorageSettles(() => resolve(trySyncEvents())));` then `const run = syncEventsOnce(epoch); syncsInFlight.add(run);` (554-565). `syncsInFlight` is only read by deleteMyData. Nothing checks it before starting a new run. syncEventsOnce: `const unsynced = await window.forayEventLog.unsynced(); ... const s = await ensureAnonSession(epoch);` (572-574).",
  "fix_sketch": "Single-flight the sync. Keep `let syncRun = null, syncAgain = false`. If a run is in flight, set syncAgain and return syncRun. When it finishes, start one more run if syncAgain is set. For the pre-settle path, register at most one waiter, using a flag like saveInterestsPending. Also single-flight ensureAnonSession so two callers share one signup/refresh promise.",
  "duplicates": [
    "security-5",
    "data-integrity-1"
  ],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main myself and the finding holds. trySyncEvents() (app.js 554-565) starts a new syncEventsOnce(epoch) on every call. syncsInFlight is only added to and deleted from here. It is read only by deleteMyData, so nothing checks it before a new run starts. Before storage settles, each call does afterStorageSettles(() => resolve(trySyncEvents())). Nothing guards that the way saveInterests() guards its one waiter with saveInterestsPending (app.js 680-687), so the fix pattern already exists in the same file and this path simply lacks it. markStorageSettled (308-315) runs every queued waiter synchronously in one loop. Each run then awaits forayEventLog.unsynced(). In player/event-log.js 427-434, that call only returns the rows not yet marked synced. It does not lease or claim them, so concurrent runs read the same rows. markSynced runs only after all POSTs land, so overlapping runs each POST the same rows. The comment at app.js 369-375 says outright that \"event rows carry no client id, so the server stored every one twice\", so a double POST means duplicate server rows. ensureAnonSession (455-486) has no shared promise. With no cp_sb_session, two concurrent callers each reach /auth/v1/signup and each call lsSet, and the last write wins. The other account's rows are orphaned from the device's later Delete my data, which deletes as the stored session's user. The scenario is realistic. The boot path calls trySyncEvents() at 16630 right after session_shown. Plays (2743, 5293, 9179), picks (5182) and thumbs (11052) all call trySyncEvents() too. A tap during hydration, or a second action while a refresh+POST round-trip is still in flight, starts a concurrent run. Nothing in the code comments treats this as deliberate. Every guard present concerns deletion (epoch/localClears), not overlapping syncs. I found no mention of single-flighting in the docs. I rate it medium, not high. The duplicates skew the learning signal and orphan anonymous accounts, which touches the privacy promise of Delete my data. But there is no crash and no local data loss, and the multi-signup case needs concurrent syncs on a first launch.",
  "merged_ids": [
    "security-5",
    "data-integrity-1"
  ],
  "lane": "L1-app-data"
}
```

## app-1-10: Event sync with more than 500 rows re-sends already-accepted batches when a later batch fails, creating duplicate server rows

**confirmed** · verifier severity **low** (finder: low) · app-1 · correctness · `app.js:595` · L1-app-data

```json
{
  "id": "app-1-10",
  "area": "app-1",
  "category": "correctness",
  "title": "Event sync with more than 500 rows re-sends already-accepted batches when a later batch fails, creating duplicate server rows",
  "file": "app.js",
  "line": 595,
  "severity": "low",
  "scenario": "The rows are POSTed in chunks of 500. If chunk 1 succeeds and chunk 2 gets a 5xx or times out, the function returns without marking anything synced, and the next sync POSTs chunk 1 again. The events table has no client id or unique key, so those rows are stored twice. This happens after a long offline period, which is when a backlog of 500 or more rows builds up.",
  "evidence": "`for (let i = 0; i < rows.length; i += 500) { ... if (!res.ok) return; // don't advance the cursor — retry the whole batch next time }` (583-596), with markSynced only after the loop (601).",
  "fix_sketch": "After each successful chunk, mark synced the ids of the unsynced rows that chunk covered. Keep a parallel id array per chunk, including the local-only rows interleaved in it. Alternatively, add a client-generated event id with a unique constraint and use `Prefer: resolution=ignore-duplicates`.",
  "duplicates": [
    "data-integrity-2"
  ],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main myself and the finding holds. In app.js syncEventsOnce (about lines 567-605), `rows` comes from every unsynced event and is POSTed to /rest/v1/events in slices of 500. `if (!res.ok) return; // don't advance the cursor — retry the whole batch next time` exits without marking anything synced, and `markSynced(syncedIds)` runs only after the whole loop. A thrown fetch error, such as a network drop, hits the catch and also exits without marking. So if chunk 1 is accepted and chunk 2 fails, the next run POSTs chunk 1 again.\n\nThe server has nothing to dedupe the retry. In backend/migrations/0009_events.sql, events.id is a server-side `default gen_random_uuid()`, and there is no client id column or unique constraint. The client sends no id, and the only Prefer header is `return=minimal`, not `resolution=ignore-duplicates`.\n\nA backlog over 500 rows can really happen. player/event-log.js unsynced() returns every unsynced row from IndexedDB plus the ring, with no cap, and retention is pruned to 5000.\n\nNothing makes this deliberate. The comment says \"retry the whole batch\" on purpose, but it doesn't address partial success across chunks, and I found no DECISIONS.md entry accepting duplicate events.\n\nTwo other paths also exit after a partial send and also resend: syncOutlived mid-loop, and the dataDeletionInProgress / localClears check. Those are tied to deletion, where the server rows get deleted anyway.\n\nSeverity is low. It needs a backlog over 500 rows plus a failure partway through. The damage is duplicated analytics and learning-signal rows, which inflate the interest weights a little. There is no data loss or security impact.\n\nI didn't run the one test the task allowed. Reading the code was enough to settle it.",
  "merged_ids": [
    "data-integrity-2"
  ],
  "lane": "L1-app-data"
}
```

## app-1-4: A transient failure of the refresh-token call signs the device up as a new anonymous user, orphaning the listener's identity

**confirmed** · verifier severity **medium** (finder: medium) · app-1 · error-handling · `app.js:479` · L1-app-data

```json
{
  "id": "app-1-4",
  "area": "app-1",
  "category": "error-handling",
  "title": "A transient failure of the refresh-token call signs the device up as a new anonymous user, orphaning the listener's identity",
  "file": "app.js",
  "line": 479,
  "severity": "medium",
  "scenario": "sbAuth returns null for every non-2xx response and for network or parse errors, so ensureAnonSession cannot tell 'this refresh token is invalid' (a definitive 400 invalid_grant) from a 429/5xx/timeout on the token endpoint. The comment says a new user is created only when there is no token or the refresh fails, but any hiccup counts as a failure. If the refresh gets a 500 or 429 and the next call, /auth/v1/signup, succeeds, cp_sb_session is overwritten with a brand-new anonymous user. The listener's server-side history is split between two accounts, the old one can never be reached again, and Delete my data can no longer delete its rows. ADR-0005 treats this token as the listener's identity.",
  "evidence": "`async function sbAuth(path, body) { try { const res = await fetch(...); return res.ok ? await res.json() : null; } catch (_) { return null; } }` (445-454). `if (s && s.refresh_token) { const r = await sbAuth(\"/auth/v1/token?grant_type=refresh_token\", ...); ... if (r && r.access_token) {...return s;} } ... const r = await sbAuth(\"/auth/v1/signup\", {});` (479-497).",
  "fix_sketch": "Have sbAuth return `{ ok, status, body }`. Fall through to signup only when the refresh failed definitively (a 400/401 with error invalid_grant or refresh_token_not_found). On a network error, 429 or 5xx, return null and let the queued events retry on the next sync.",
  "duplicates": [
    "security-6",
    "data-integrity-3"
  ],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read app.js at origin/main and the finding holds. sbAuth (lines 445-454) returns `res.ok ? await res.json() : null` and also returns null from its catch. That means a 429, a 5xx, a network error or a JSON parse failure all look the same as a definitive invalid_grant. In ensureAnonSession (468-500), a refresh that returns null skips the `if (r && r.access_token)` branch. After the syncOutlived check, the code goes straight to `sbAuth(\"/auth/v1/signup\", {})`, and a successful signup is written over cp_sb_session with a new user_id. The existing guards do not cover this case. `sessionKeepable()` (persist-6) only handles an unreadable or unwritable vault. `storageWaiting()` in trySyncEvents (races-4) only handles storage that has not settled yet. `syncOutlived` only handles a deletion in progress. None of them stops a signup after a transient refresh error. The caller in syncEventsOnce does treat a null from ensureAnonSession as \"retry next time\", which is exactly the behavior the fix sketch wants for transient errors. Signup simply runs before that point is reached. This is not deliberate. The comment at line 466 says a new user is created only when \"the refresh fails\", and the comment near 13803 (existingAnonSession) says outright that a failed refresh followed by signup of a NEW account \"strand[s] the rows the 'remote before local' rule exists to keep reachable\". Line 105 says losing the token \"silently orphans them\" (ADR-0005). The codebase treats this outcome as a defect but only closed one path to it, the spent-token save in the delete flow. The transient-error path is still open. For the scenario to happen, the token endpoint has to fail transiently (429, 5xx or a timeout) and signup has to succeed right after. That is plausible, and it becomes more likely for a device offline past its token expiry that reconnects on a flaky network. There is a second path: a refresh that succeeds on the server but whose response is lost has already spent the token. Signup then orphans the account too, though the old token may be unrecoverable in that case anyway. The likelihood is moderate, but the impact is permanent split identity and incomplete Delete my data, so medium is the right severity. I did not run a test because the code path is unambiguous.",
  "merged_ids": [
    "security-6",
    "data-integrity-3"
  ],
  "lane": "L1-app-data"
}
```

## app-1-1: races-4 fix is incomplete: listener-action writes and first-run detection still run against an unhydrated store and permanently overwrite durable rows

**confirmed** · verifier severity **medium** (finder: high) · app-1 · correctness/data-loss · `app.js:1485` · L1-app-data

```json
{
  "id": "app-1-1",
  "area": "app-1",
  "category": "correctness/data-loss",
  "title": "races-4 fix is incomplete: listener-action writes and first-run detection still run against an unhydrated store and permanently overwrite durable rows",
  "file": "app.js",
  "line": 1485,
  "severity": "high",
  "scenario": "The code's own design case: localStorage has been swept (Safari ITP, storage pressure) and IndexedDB hydration takes longer than STORAGE_WAIT_MS (5 s). init() paints once the bound passes, while storageWaiting() stays true for up to 30 s. In that window a returning listener taps a star, adds to Up Next, plays an episode or follows a show. toggleStar reads savedMap(), which is the empty unhydrated memory, and writes {thisOneId} to cp_saved. durable-store property 2 ('a write this session is never clobbered by hydration', durable-store.js:66/1121) then marks cp_saved dirty, so hydration skips the durable copy and the whole Saved list is lost for good. The same happens to cp_history and cp_episode_snaps (recordHistory/rememberEpisode on the first play), cp_queue (saveQueueIds), cp_starred_shows, cp_lastpick and cp_shard_shows. Reads are affected too: route() -> renderHome -> offerHomeOnboarding -> isGenuineFirstTimeUser() reads cp_history/cp_saved/cp_playlists before hydration, so a returning listener can be shown the first-run Welcome/Preferences sheet. Its 'Show my picks' then calls redealAfterOnboardingPicks, which writes cp_seen and cp_recent_branches without the gate (5577-5579).",
  "evidence": "Only boot writes were gated (round-2 races-4 row: 'One storage gate ... for boot writes'). Ungated writers: `lsSet(\"cp_saved\", saved);` (1485), `lsSet(\"cp_history\", history.filter(...).concat(id).slice(-200));` (1655), `lsSet(EPISODE_SNAPS_KEY, next);` (2430), `const ok = lsSet(\"cp_queue\", ids);` (2249), `lsSet(\"cp_starred_shows\", starred);` (1562). Gate readers: `function isGenuineFirstTimeUser() { return (pickedHistory().length === 0 && Object.keys(savedMap()).length === 0 && playlists().length === 0); }` (5442-5447), and `function offerHomeOnboarding() { if (onboardingHeld || forayHoldsOnboarding()) return; ...` (5472-5474) does not consult storageWaiting().",
  "fix_sketch": "Do not let read-modify-write of cp_ collections happen while storageWaiting(). Option A, simplest: while it is true, have the mutating actions (toggleStar, toggleShowStar, addToQueue/remove/move, recordHistory, rememberEpisode) queue through afterStorageSettles and recompute from the settled store, with the UI painted optimistically from an in-memory overlay. Option B: disable these controls (or show a brief 'Loading your library…') until the store settles. In both cases return early from offerHomeOnboarding while storageWaiting(), and re-offer it from afterStorageSettles. Add a boot-path test: a slow hydrate holding cp_saved={a}, toggleStar('b') before the settle, then assert both a and b survive.",
  "duplicates": [
    "data-integrity-5"
  ],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main and the finding holds. In app.js, init() awaits storageReady(), which races hydration against STORAGE_WAIT_MS, set to 5000 (lines 317-325 and 16506). It then calls buildCards and route() while storageWaiting() can stay true for up to the 30 s ceiling (STORAGE_SETTLE_CEILING_MS). Only a few paths go through the gate: the event buffer and sync, saveInterests, the dealt-cards memory in buildCards (1750), and a loadInterests re-seed. The comment at 228-236 lists those and nothing else.\n\nThe listener-action writers go straight to the store:\n- toggleStar: `lsSet(\"cp_saved\", saved)` (1485), where saved comes from savedMap(), which calls lsGet.\n- recordHistory: `lsSet(\"cp_history\", ...)` (1655), built from pickedHistory().\n- saveQueueIds: `lsSet(\"cp_queue\", ids)` (2249).\n- rememberEpisode: `lsSet(EPISODE_SNAPS_KEY, next)` (2430).\n- redealAfterOnboardingPicks writes cp_seen and cp_recent_branches without the gate (5577-5579).\n\nlsSet goes to window.forayStorage.setItem. In player/durable-store.js, setItem adds the key to _dirty (line 505). hydrate then skips any dirty key (`if (this._dirty.has(k)) continue; // property 2: this session wins`, line 1121). So if localStorage was swept, _mem starts empty and a star tapped in the window writes {b}. The durable {a,...} copy is never adopted, and migration pushes {b} down, so the old Saved list is lost for good.\n\nisGenuineFirstTimeUser (5442) and offerHomeOnboarding (5472) never check storageWaiting(). A returning listener can therefore get the first-run sheet during the window.\n\nNothing documents this as deliberate. The durable-store header says outright that callers \"should still await hydrate() before their first write; _dirty is the belt to that braces\", and app.js's own races-4 comment describes this exact failure for boot writes.\n\nWhy medium rather than high: it needs three things at once. localStorage must be swept while IndexedDB survives, hydration must take longer than 5 s, and the user must act in that window before the 30 s ceiling. That combination is narrow, but when it happens the user's data is lost silently and cannot be recovered.\n\nI did not run the one allowed test; this verdict comes from reading the code only.",
  "merged_ids": [
    "data-integrity-5"
  ],
  "lane": "L1-app-data"
}
```

## app-1-8: cp_saved keeps full untrimmed snapshots (publisher description and chapters) and is re-parsed once per rendered row

**confirmed** · verifier severity **medium** (finder: medium) · app-1 · performance · `app.js:1481` · L1-app-data

```json
{
  "id": "app-1-8",
  "area": "app-1",
  "category": "performance",
  "title": "cp_saved keeps full untrimmed snapshots (publisher description and chapters) and is re-parsed once per rendered row",
  "file": "app.js",
  "line": 1481,
  "severity": "medium",
  "scenario": "toggleStar stores `{ ...snap }`. For a show-page episode, snapshot() carries `description: ep.description_text`, about 2.5 KB on average for Lex per the API's own measurement and unbounded in general, plus chapters. storableEpisode trims exactly this for cp_episode_snaps (EPISODE_SNAP_HOOK_MAX, 'the difference between ~200 KB and several MB'), but toggleStar never goes through it. With 100 or more saved episodes, cp_saved reaches hundreds of KB in the localStorage mirror tier (5 MB quota), and lsSet's refusal is ignored here. Every epRow calls starBtn -> isSaved -> savedMap() -> JSON.parse(whole cp_saved). A 100-row show page therefore parses around 30 MB of JSON per paint, and paintList runs again on each scoped-search result and on refresh. liveEpisode/storedEpisode parse cp_saved again for each non-pool id in rowsForIds.",
  "evidence": "`saved[id] = { ...snap, saved_at: new Date().toISOString() };` (1481); `function savedMap() { return lsGet(\"cp_saved\", {}); } function isSaved(id) { return id in savedMap(); }` (1470-1471); `function starBtn(id) { const on = isSaved(id); ...` (1505-1506); lsGet does `JSON.parse(store.getItem(key))` on every call (133).",
  "fix_sketch": "Store `storableEpisode(snap)` in cp_saved, and trim existing entries on the next write. Memoize the parsed maps, keyed on the raw string returned by store.getItem (or invalidated in the writer), so a render parses cp_saved once instead of once per row. Check the lsSet result in toggleStar and leave the star off if the write was refused.",
  "duplicates": [
    "perf-4"
  ],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main app.js and the finding holds. savedMap() at 1470 is `lsGet(\"cp_saved\", {})`, and lsGet at about line 130 calls JSON.parse(store.getItem(key)) on every call with no memo. isSaved goes through savedMap. starBtn at 1505 calls isSaved, and epRow at 9681 calls starBtn once per row. paintList at 4539 maps every visible episode through epRow, so a show page parses the whole cp_saved once per row. toggleStar at 1481 stores `{ ...snap, saved_at }` and never goes through storableEpisode at 2402. For a show-page row, fullCatalogueRowToEpRowItem at 3816 sets `hook: ep.description_text` and also passes the full description and chapters through snapshot(). A starred breadth episode therefore stores the publisher's full description twice, once as hook and once as description, plus the chapters. The EPISODE_SNAP_HOOK_MAX comment at 2389-2394 says outright that this is the difference between about 200 KB and several MB. toggleStar also ignores the result of lsSet at 1485. storedEpisode and liveEpisode (2435/2443) parse cp_saved again for each non-pool id in rowsForIds, which is how the Library's Saved section at 10559 renders.\n\nOne part is partly deliberate. The storedEpisode comment reads \"a star's first, because it may carry the full description\", so keeping the description in cp_saved is intended. Trimming it with storableEpisode would lose that on the episode page, so the fix should at least cap hook and chapters rather than drop description outright. Nothing documents or handles the repeated per-row parsing, and nothing in DECISIONS.md covers cp_saved size.\n\nOn impact, the finding's figure of about 30 MB per paint assumes 100 or more saved breadth episodes. That is a heavy user, but it's reachable, and it would mean hundreds of ms of jank per paint on a phone that grows linearly. The storage write failing silently only matters near the quota. Medium fits: this is performance and storage bloat, and it causes no data loss or crash.",
  "merged_ids": [
    "perf-4"
  ],
  "lane": "L1-app-data"
}
```

## app-1-11: Unbounded session caches: showEpisodesCache and state.itemIndex hold full episode descriptions for every show visited

**confirmed** · verifier severity **low** (finder: low) · app-1 · resource-leak · `app.js:3908` · L2-app-surface

```json
{
  "id": "app-1-11",
  "area": "app-1",
  "category": "resource-leak",
  "title": "Unbounded session caches: showEpisodesCache and state.itemIndex hold full episode descriptions for every show visited",
  "file": "app.js",
  "line": 3908,
  "severity": "low",
  "scenario": "showEpisodesCache keeps each visited show's first page, up to about 300 KB of JSON for 100 rows with description_text. Entries are deleted only when read after their TTL, so browsing 50 shows keeps around 15 MB alive for the whole session. Every row painted also snapshot()s into state.itemIndex with its full description, and nothing ever clears that. A long-lived WKWebView session (the car case) grows until the OS kills the web content process.",
  "evidence": "`function cacheShowEpisodes(show_id, payload) { showEpisodesCache.set(show_id, { ...payload, at: Date.now() }); }` (3908-3910), with expiry only in cachedShowEpisodes on read (3904). `state.itemIndex[id] = snap;` in snapshot() (949), with the comment 'nothing ever clears it' (955-956).",
  "fix_sketch": "Give showEpisodesCache an LRU bound (e.g. 10 shows) and sweep expired entries on insert. For itemIndex, avoid keeping `description` on list snapshots (fetch or keep it only for the episode page), or cap non-pool entries with an LRU.",
  "duplicates": [
    "perf-7"
  ],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read app.js at origin/main and the code does what the finding says. `showEpisodesCache` is a plain Map (line 3898). `cacheShowEpisodes` (3908-3910) inserts with no size bound and no sweep. An entry is removed only when `cachedShowEpisodes` reads it after the 30-minute TTL (3904). It is written both by the prefetch (3952) and by renderShow (4911). Each entry holds the full first page of episodes. `snapshot()` ends with `state.itemIndex[id] = snap` (949) and keeps `description`. `fullCatalogueRowToEpRowItem` (around 3816) snapshots every full-catalogue row and puts `description_text` into `hook`. The code's own comments say itemIndex is \"session-lived, nothing ever clears it\" (955) and \"grows with every rendered row\" (8425). The backend does select `description_text` (backend/src/catalog/showEpisodesStore.ts:102).\n\nThis is not a documented design choice. DECISIONS.md does not mention either cache. The comment block above the cache says \"In memory ... `state` dies with the tab, which is the right lifetime\". That picks in-memory over IndexedDB. It does not address a size limit. The itemIndex comments are about membership correctness (#276), not memory.\n\nThe impact is overstated, so the severity stays low. About 15 MB after 50 shows, even taken at face value, is far below where WebKit kills a web content process, which is hundreds of MB. Browsing 50 or more distinct shows in one car session is unlikely. Growth scales with the number of shows visited, not with time, and it resets on every reload. So the finding is a real unbounded-growth pattern and worth the cheap LRU fix. The claim that the OS will kill the web content process in the car is speculative.",
  "merged_ids": [
    "perf-7"
  ],
  "lane": "L2-app-surface"
}
```

## app-2-14: playerBridge leaks a 'forayplayer:ready' listener on every timed-out wait

**confirmed** · verifier severity **low** (finder: low) · app-2 · resource-leak · `app.js:10968` · L2-app-surface

```json
{
  "id": "app-2-14",
  "area": "app-2",
  "category": "resource-leak",
  "title": "playerBridge leaks a 'forayplayer:ready' listener on every timed-out wait",
  "file": "app.js",
  "line": 10968,
  "severity": "low",
  "scenario": "When the player module failed to load, each visit to #/forays or Library (and each Try again) calls playerBridge(). That adds a once-listener for an event that will never fire. The 5 s timeout resolves the promise but never removes the listener, so listeners and closures pile up for the session.",
  "evidence": "`window.addEventListener(\"forayplayer:ready\", finish, { once: true }); setTimeout(finish, PLAYER_WAIT_MS);`, and finish never calls removeEventListener.",
  "fix_sketch": "In finish(), `window.removeEventListener(\"forayplayer:ready\", finish)` and clear the timer. Or share one module-level promise across callers.",
  "duplicates": [
    "perf-9"
  ],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read app.js at origin/main, lines 10961-10971. The code is as the finding says. playerBridge() returns early only when window.ForayPlayer already exists. Otherwise it adds `window.addEventListener(\"forayplayer:ready\", finish, { once: true })` and `setTimeout(finish, PLAYER_WAIT_MS)`. finish() only sets `done` and resolves. It never removes the listener or clears the timer. If the module never publishes, the event never fires, so every timed-out call leaves one listener and its closure attached for the rest of the session. The functions called from the listed call sites (lines 9598, 10621, 11647 and 16674) each call playerBridge() again on every visit, with no shared promise. Nothing in the comment above the function, or in playerModuleFailed(), says the leak is intended or handles it. waitForStorage() at line 202 has the same shape, but it only runs once in practice. Impact is tiny: each leaked item is a small closure around an already-resolved promise. It only happens on the broken-deploy path, where the module failed to load, and it grows only with how often the user navigates. If a slow module does fire the event later, every waiting listener runs once, is removed, and does nothing because `done` is already set. So this is a real but cosmetic leak, and low severity is right.",
  "merged_ids": [
    "perf-9"
  ],
  "lane": "L2-app-surface"
}
```

## app-2-15: Dead code in the search section: episodeDedupKey and showIndexFetchCount

**confirmed** · verifier severity **low** (finder: low) · app-2 · dead-code · `app.js:8459` · L2-app-surface

```json
{
  "id": "app-2-15",
  "area": "app-2",
  "category": "dead-code",
  "title": "Dead code in the search section: episodeDedupKey and showIndexFetchCount",
  "file": "app.js",
  "line": 8459,
  "severity": "low",
  "scenario": "episodeDedupKey (singular) has no callers. Everything uses episodeDedupKeys, and it survives only in test comments. showIndexFetchCount is incremented and labelled 'test-visible', but no test or other code reads it (git grep finds only app.js). Both are maintenance traps that suggest behaviour that no longer exists.",
  "evidence": "git grep '\\bepisodeDedupKey\\b' finds only app.js:8459 plus comments in test/episode-search.test.js. git grep showIndexFetchCount finds only app.js:6858/6863.",
  "fix_sketch": "Delete both, or assert on showIndexFetchCount in the show-index test if 'fetched at most once' is meant to be pinned.",
  "duplicates": [
    "arch-drift-9"
  ],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main myself and the finding holds.\n\n- `git grep '\\bepisodeDedupKey\\b'` finds only its definition at app.js:8459 and two comments in test/episode-search.test.js (lines 596 and 645). No runtime code calls it.\n- `git grep showIndexFetchCount` finds only app.js:6858 (declaration, commented \"test-visible: the index is fetched at most once\") and app.js:6863 (increment). No test reads it, including through `vm.runInContext`.\n- The tests do load app.js into a node:vm context, so a test could read either name. None does: the tests call only `episodeDedupKeys`.\n- Nothing in docs/ mentions either name, so neither is documented as deliberate.\n\nOne mild reason to keep `episodeDedupKey`: the MUTATION note at test line 645 says to \"make `episodeDedupKeys` return `[episodeDedupKey(ep)]`\", which needs the singular function to exist. That is a manual mutation recipe, not a caller. It makes the function arguably intentional scaffolding, but it is still dead in production. `showIndexFetchCount`'s comment claims a test pins the behaviour, but no test does. That is a misleading comment, not a runtime bug. Neither has any user impact, so severity stays low.",
  "merged_ids": [
    "arch-drift-9"
  ],
  "lane": "L2-app-surface"
}
```

## app-1-16: showNameLink builds `#/show/<id>` without encodeURIComponent, while the router decodes the segment and the prefetch handler decodes the whole tail

**confirmed** · verifier severity **low** (finder: low) · app-1 · correctness · `app.js:3073` · L2-app-surface

```json
{
  "id": "app-1-16",
  "area": "app-1",
  "category": "correctness",
  "title": "showNameLink builds `#/show/<id>` without encodeURIComponent, while the router decodes the segment and the prefetch handler decodes the whole tail",
  "file": "app.js",
  "line": 3073,
  "severity": "low",
  "scenario": "parseShowRoute's contract is 'An id never carries a raw `/`: every producer encodes it' (4280), and showResultRow/starredShowRow do encode. showNameLink (and its copies at 11164/11252/11557) only HTML-escapes. An endpoint show_id containing '%', '/' or '#' either routes to the wrong id (safeDecode of a stray '%' returns '' and the page shows 'Show not found') or is split by the `/q/` matcher. bindShowPrefetch also decodes everything after `#/show/`, so any anchor carrying `/q/<query>` prefetches a nonexistent id.",
  "evidence": "`return id ? `<a class=\"show-link\" href=\"#/show/${esc(id)}\">${label}</a>` : label;` (3073) vs `href=\"#/show/${encodeURIComponent(entry.show_id)}\"` (1605). In bindShowPrefetch: `const id = safeDecode(href.slice(\"#/show/\".length));` (3964).",
  "fix_sketch": "Route every show link through one helper: `showRouteHash(id)` already exists (4288), so use `href=\"${esc(showRouteHash(id))}\"`. In bindShowPrefetch, use `parseShowRoute(href)?.id` instead of slicing.",
  "duplicates": [
    "app-3-12"
  ],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "At origin/main the inconsistency is real. showNameLink at app.js:3073 builds `href=\"#/show/${esc(id)}\"` with no encodeURIComponent, and so do the copies at 11164, 11252 and 11557. The other producers do encode: 1605, 6604 and showRouteHash at 4290. parseShowRoute (4280-4286) passes the segment through safeDecode, which returns \"\" on a malformed escape (3251-3253). Its comment says \"every producer encodes it\", so these four links break a stated contract. bindShowPrefetch (3964) also decodes the whole tail after `#/show/`.\n\nThe scenario is latent today, though:\n- **Ids:** the 220 curated show_ids in data/catalog.json and data/catalog-client.json contain none of %, /, # (grep found none). Breadth/Apple ids are String(collectionId), which is numeric (appleShowSearch.ts:143), so they are also safe.\n- **Prefetch:** the only use of showRouteHash with a `/q/` query is rewriteRouteInPlace (4790), which writes the address, not an anchor. So no `<a href=\"#/show/.../q/...\">` exists for bindShowPrefetch to mis-parse.\n\nI found nothing in DECISIONS.md or the comments that makes this deliberate. It is a real contract violation that would misroute only if an id with a reserved character appears. Severity is low, and the suggested fix (use showRouteHash everywhere, and parseShowRoute in the prefetch handler) is right.",
  "merged_ids": [
    "app-3-12"
  ],
  "lane": "L2-app-surface"
}
```

## app-3-2: On the Vercel origin the service worker intercepts /api/* and keys its cache without the query string, so a slow or failing API call returns another query's results; those responses also survive Delete my data

**confirmed** · verifier severity **medium** (finder: medium) · app-3 · correctness · `sw.js:781` · L4-web-platform

```json
{
  "id": "app-3-2",
  "area": "app-3",
  "category": "correctness",
  "title": "On the Vercel origin the service worker intercepts /api/* and keys its cache without the query string, so a slow or failing API call returns another query's results; those responses also survive Delete my data",
  "file": "sw.js",
  "line": 781,
  "severity": "medium",
  "scenario": "The same bundle and sw.js are served from foray-web-seven.vercel.app (README: 'production preview'), which is also API_ORIGIN, so every fetchApiJson and shard request is same-origin and handled by handleShell. cachePut stores each 200 response in the current generation cache under stripQuery(request): `/api/shows/search?q=a` and `?q=b` share one key, and so do `/api/episodes/search?show=X&q=...` for every show. When a later call takes longer than NET_TIMEOUT_MS (6 s, shorter than the page's 15 s API_DEADLINE_MS, and a Vercel cold start can exceed it) or returns 4xx/5xx, cachedShellFallback returns the cached body for a different query or show. Search then shows the wrong results, with no error. Separately, the shard and search responses cached there reveal what the listener searched for, and clearLocalData only deletes SHARD_CACHE_NAME. On this origin that brings back the trace persist-4 removed.",
  "evidence": "sw.js:755 `if (url.origin !== location.origin) return;` then sw.js:783 `else e.respondWith(handleShell(request, env, isCode(request, url)));` with no /api/ exclusion. sw.js:428-431 `if (!url.search) return request; return new Request(url.origin + url.pathname, ...)`. sw.js:661-662 `if (!fallback) return res || unavailable(request); if (!pin) return fallback.response;`. app.js:439 `const API_ORIGIN = \"https://foray-web-seven.vercel.app\";`. app.js:15987 `let API_DEADLINE_MS = 15000;`.",
  "fix_sketch": "In the fetch listener, return without calling respondWith for scope-relative `api/` paths, for example `if (url.pathname.startsWith(new URL('api/', self.registration.scope).pathname)) return;`. Better still, only put or serve paths the generation manifest tracks, plus a short explicit allowlist such as data/show-index.tsv. Add a sw-generation test where a second query times out and expect a 504, not the first query's body.",
  "duplicates": [
    "perf-1"
  ],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main and the finding holds. The Vercel deploy (vercel.json with outputDirectory dist, where tools/web/prepare-dist.mjs copies index.html, app.js and sw.js) serves the page and the API from the same origin, and app.js:439 sets API_ORIGIN to that origin. shouldRegisterServiceWorker only turns the worker off inside Capacitor, so it registers on that origin too.\n\nIn the fetch listener (sw.js:750-784), the only filters are method GET and same-origin (line 755). isData only matches \"/data/\", and isImmutableAsset only matches woff2/png. That sends every /api/* GET to handleShell(request, env, false). Nothing in sw.js mentions api/.\n\nfromOrigin (sw.js:469-495) caches any res.ok answer through cachePut. Timeouts come from NET_TIMEOUT_MS=6000 (line 168), which is shorter than API_DEADLINE_MS=15000. cachePut stores under stripQuery(request) (lines 428-432, 533). API URLs are not in the deploy manifest, so trackedHash is null and the write goes through. The sameValidators skip only matters when ETags match. So `api/shows/search?q=a`, `?q=b` and even `?id=X`, plus `api/episodes/search?show=..&q=..`, all share one key.\n\nWhen the origin times out or answers non-ok, handleShell calls cachedShellFallback. That returns matchGeneration(current, request), which also strips the query, and line 662 returns fallback.response unchanged. The page gets a 200 with a different query's body. The Vary: Origin header set in api/_lib/cors.ts does not stop the match, because both the stored and lookup Requests are header-less.\n\nThe callers do not check the response against the query they sent:\n- searchShowEpisodesScoped (app.js:4240) only checks for data, degraded and an episodes array.\n- resolveMissingShow's `?id=` fetch (4337) can get the body of a `?q=` search.\n\nA real 400 (for example \"q is required\") would also be replaced by the cached body.\n\nOn the privacy point, clearLocalData (13935-13990) deletes only SHARD_CACHE_NAME, stored keys and the event log. The foray-gen-<id> generation cache, which holds the api/shows/index shard responses and the last search bodies, is not cleared. That undoes persist-4's goal on this origin.\n\nI found no DECISIONS.md entry or code comment that makes this deliberate. The app.js:3998 comment only contrasts the native shell with a worker that has NET_TIMEOUT_MS.\n\nIt stays medium rather than high for two reasons:\n- It only affects the Vercel origin. The GitHub Pages origin is cross-origin to the API, and there the worker returns early.\n- A wrong answer needs a slow (over 6 s) or failing API call after an earlier success.",
  "merged_ids": [
    "perf-1"
  ],
  "lane": "L4-web-platform"
}
```

## app-3-4: The service worker's activate deletes every CacheStorage bucket it does not own, including the app's own 'foray-shows-index-v1' shard cache, on every deploy

**confirmed** · verifier severity **low** (finder: medium) · app-3 · resource-handling · `sw.js:345` · L4-web-platform

```json
{
  "id": "app-3-4",
  "area": "app-3",
  "category": "resource-handling",
  "title": "The service worker's activate deletes every CacheStorage bucket it does not own, including the app's own 'foray-shows-index-v1' shard cache, on every deploy",
  "file": "sw.js",
  "line": 345,
  "severity": "medium",
  "scenario": "app.js:7012 keeps Shows-search shards in the Cache Storage bucket `foray-shows-index-v1` so they survive reloads and answer searches offline (the S-04 design: 'in-memory + Cache Storage'). Each deploy's activate treats every name other than the pointer, pending and two retained generations as 'a prior architecture's leftovers' and deletes it. The persistent tier is therefore wiped on every deploy, and the first searches after a deploy re-download shards, or fail in a dead zone. CacheStorage is per-origin, not per-scope, so on jw-incorporated.github.io this worker (scope /foray/) also deletes the caches of any other Pages site on the same org origin.",
  "evidence": "sw.js:344-346 `const keys = await caches.keys(); const stale = keys.filter((k) => k !== POINTER_CACHE && k !== PENDING_CACHE && !keep.has(k)); await Promise.all(stale.map((k) => caches.delete(k)));`. app.js:7012 `const SHARD_CACHE_NAME = \"foray-shows-index-v1\";`.",
  "fix_sketch": "Only delete names this worker owns, those starting with CACHE_PREFIX ('foray-gen-'), plus an explicit list of legacy names from earlier versions of this app. Never delete unknown names. Add a sw-generation test: seed 'foray-shows-index-v1' and 'someone-else', activate, and assert both survive.",
  "duplicates": [
    "perf-5"
  ],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The code does what the finding says. At origin/main, sw.js activate (around lines 336-346) keeps only POINTER_CACHE ('foray-pointer'), PENDING_CACHE ('foray-pending') and CACHE_PREFIX+new and previous deployId ('foray-gen-*'). It then deletes every other name from caches.keys(), with no prefix filter: `keys.filter((k) => k !== POINTER_CACHE && k !== PENDING_CACHE && !keep.has(k))`. app.js:7012 defines SHARD_CACHE_NAME = \"foray-shows-index-v1\". The header comment at app.js ~6983-7011 describes it as a Cache Storage tier that \"survives a reload\", and it holds version-tagged entries. So every activate that promotes a pending generation (every deploy) wipes that bucket. Because CacheStorage is per-origin, any other same-origin Pages site's caches would be deleted too.\n\nNothing marks this as deliberate. The only comment says it removes \"a prior architecture's leftovers\", which is written with old foray-vN names in mind, not the app's own live bucket. No DECISIONS.md entry covers it and no test pins it. The only intentional deletion of this bucket is clearShardCache (app.js ~13982) for Delete-my-data, which is a separate path.\n\nI rate it low rather than medium because the impact is latent today. The committed data/shows-index-pointer.json has no shard_releases. An earlier audit (docs/audit/qa-findings-detail.md) found that every shard request 404s, so fetchShardRows returns [] and the bucket holds little or nothing on the shipped build. Even once shards publish, the damage is one re-fetch per shard after a deploy, plus a failed offline search only if the first search after a deploy happens with no connection. The versioned entries already treat a release change as a miss. The cross-site deletion needs another Pages site on the same org origin that uses CacheStorage, and I could not show one exists. The fix sketch (delete only names starting with 'foray-gen-' plus an explicit list of legacy names) is correct and cheap.",
  "merged_ids": [
    "perf-5"
  ],
  "lane": "L4-web-platform"
}
```

## app-3-7: The service worker strips the Range header when it refetches same-origin media, so the interlude jingle always gets a 200 full body (Safari expects 206)

**confirmed** · verifier severity **low** (finder: low) · app-3 · correctness · `sw.js:465` · L4-web-platform

```json
{
  "id": "app-3-7",
  "area": "app-3",
  "category": "correctness",
  "title": "The service worker strips the Range header when it refetches same-origin media, so the interlude jingle always gets a 200 full body (Safari expects 206)",
  "file": "sw.js",
  "line": 465,
  "severity": "low",
  "scenario": "On the GitHub Pages site the jingle's audio_url is same-origin (player/foray-queue.js:95 `https://jw-incorporated.github.io/foray/player/assets/interlude-placeholder.wav`), so the <audio> element's byte-range requests reach handleShell. networkFetch reissues them as `fetch(request.url, {cache:'no-cache'})`, which drops every request header including Range, so the page always receives a 200 with the full body; offline, the cached 200 copy is served. WebKit's media loader expects 206 answers to range requests coming through a service worker and has a history of stalling or refusing playback otherwise, which would fail the jingle between clips on iOS Safari. Needs one device check; the header drop itself is certain.",
  "evidence": "sw.js:465 `return isNavigation(request) ? fetch(request) : fetch(request.url, { cache: \"no-cache\" });`. No check of request.headers.get('range') or request.destination anywhere in the fetch listener.",
  "fix_sketch": "In the fetch listener, return without calling respondWith when `request.headers.has('range')` or `request.destination` is 'audio' or 'video', and let the network handle media. If an offline copy is wanted, answer ranges from the cached body with a constructed 206.",
  "duplicates": [
    "perf-6"
  ],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The finding holds at origin/main. In sw.js, the fetch listener (lines 750-784) returns early only for non-GET or cross-origin requests. It never checks the Range header or request.destination. A same-origin .wav fails the isData and isImmutableAsset tests (the latter matches only woff2/png), so it goes to handleShell. handleShell calls fromOrigin, which calls networkFetch. For anything that isn't a navigation, networkFetch runs `fetch(request.url, { cache: \"no-cache\" })` (sw.js:465). Building a new request from the bare URL drops every header, Range included, so the origin sends back a 200 with the full body. fromOrigin also writes that 200 into the generation cache, and handleShell serves it from there when offline. On the website the URL really is same-origin: player/foray-queue.js:95 JINGLE_ASSET_URL and player/interlude.js SITE_ROOT both point to https://jw-incorporated.github.io/foray/player/assets/interlude-placeholder.wav, which is inside the worker's /foray/ scope. Nothing in the comments or DECISIONS.md makes this deliberate. The networkFetch comment is only about navigations and redirect mode, and nothing handles ranges anywhere else. Why low: (1) The founders use the Capacitor native shell. shouldRegisterServiceWorker in app.js skips the service worker there, and from capacitor://localhost the jingle URL is cross-origin anyway, so their path never goes through this code. Only the GitHub Pages site in a browser, mainly iOS Safari, is exposed. (2) Whether WebKit actually refuses a 200 for an audio range request coming through a service worker is a platform-behaviour claim I did not check on a device. The header drop itself is certain. (3) If the jingle fails, the damage is limited: INTERLUDE_CEILING_SEC (asset length + 1.5 s) caps how long a seam is held, and start() refuses a jingle that isn't ready. The worst case is a missing or cut-short interlude, not stalled playback.",
  "merged_ids": [
    "perf-6"
  ],
  "lane": "L4-web-platform"
}
```

## player-rest-2: idb-tier (and event-log) cache an IDBDatabase handle forever and never reopen after the connection is closed

**confirmed** · verifier severity **medium** (finder: medium) · player-rest · error-handling · `player/idb-tier.js:68` · L3-player-and-native-tts

```json
{
  "id": "player-rest-2",
  "area": "player-rest",
  "category": "error-handling",
  "title": "idb-tier (and event-log) cache an IDBDatabase handle forever and never reopen after the connection is closed",
  "file": "player/idb-tier.js",
  "line": 68,
  "severity": "medium",
  "scenario": "Hazard 2 only clears `dbPromise` when `open()` rejects. A successful open is kept for the life of the page, even after the browser closes that connection. Safari/WKWebView does this when its IDB server process is lost after backgrounding ('Connection to Indexed Database server lost'); 'Clear site data' does it too, and the `close` event fires. After that, every `db.transaction(...)` throws InvalidStateError. `withStore` rejects every call and never retries. In DurableStore, five consecutive failures trip the circuit breaker and IDB is dropped for the rest of the session. On the web that leaves only localStorage, the evictable tier #40 exists to back up. event-log.js copies the same `open` memo (l.130-137), so every telemetry row after that point goes to the in-memory ring and is lost on reload. The Foray directory cache (`makeIdbTier({ dbName: DIRECTORY_DB_NAME })`) silently stops caching.",
  "evidence": "`const open = () => { if (!dbPromise) { dbPromise = openDb(...).catch((err) => { dbPromise = null; throw err; }); } return dbPromise; };` and `try { tx = db.transaction(storeName, mode); } catch (err) { reject(err); return; }`. Neither file sets a `db.onclose` or `db.onversionchange` handler.",
  "fix_sketch": "In openDb's onsuccess, set `db.onclose = () => { dbPromise = null; }` and `db.onversionchange = () => { db.close(); dbPromise = null; }`. In withStore, when `db.transaction` throws InvalidStateError, clear `dbPromise` and retry once on a fresh open. Apply the same change to event-log.js's copy, or share one helper.",
  "duplicates": [
    "data-integrity-6"
  ],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the code at origin/main and the finding holds.\n\n- **The open handle is cached forever.** In `player/idb-tier.js` (around l.66-75), `open()` sets `dbPromise` back to null only in the `.catch` of `openDb`. A successful open is kept for the life of the closure.\n- **No close handling anywhere.** `openDb` sets onupgradeneeded, onsuccess, onerror and onblocked on the request. It never sets `db.onclose` or `db.onversionchange`. A grep of player/ and docs/DECISIONS.md for onclose, versionchange and InvalidState finds nothing.\n- **No retry on a dead handle.** When `db.transaction()` throws, `withStore` rejects and returns. It does not retry, and it does not reset `dbPromise`. Every later call awaits the same dead handle.\n- **event-log.js has the same memo.** Its `open()` (around l.130-137) copies the pattern and cites \"idb-tier.js hazard 2\", which also covers failed opens only.\n- **The breaker drops IDB for the session.** In durable-store.js, `MAX_CONSECUTIVE_TIER_FAILURES = 5` takes the tier out of the write path. `_disabled.clear()` is called only during purge (around l.656-660), so nothing re-arms it in normal use.\n- **Not deliberate.** The header's hazard 2 is only about failed opens. Nothing in the comments or DECISIONS.md accepts a lost connection. The header even marks real iOS behaviour as \"AUDIT: unverified\".\n- **The scenario can happen.** WebKit's \"Connection to Indexed Database server lost\" after backgrounding is a documented iOS/WKWebView failure. The shipping app is a WKWebView shell whose durable tier on iOS is this IDB tier, since no Preferences tier is registered.\n\nTwo things make it less severe than it sounds:\n- `onversionchange` is mostly moot, because `DB_VERSION` is fixed at 1. That event would only fire when another context deletes the database.\n- localStorage keeps working, so nothing is lost immediately. What goes is the durable backup for the rest of the session, while telemetry falls back to the in-memory ring and is lost on reload.\n\nThat is a real resilience gap, but it is intermittent and the app still works, so medium is the right severity. No test run was needed.",
  "merged_ids": [
    "data-integrity-6"
  ],
  "lane": "L3-player-and-native-tts"
}
```

## player-rest-4: listProgress over DurableStore is O(n²): key(i) and length rebuild the owned-key array on every call

**confirmed** · verifier severity **low** (finder: low) · player-rest · performance · `player/foray-progress.js:190` · L3-player-and-native-tts

```json
{
  "id": "player-rest-4",
  "area": "player-rest",
  "category": "performance",
  "title": "listProgress over DurableStore is O(n²): key(i) and length rebuild the owned-key array on every call",
  "file": "player/foray-progress.js",
  "line": 190,
  "severity": "low",
  "scenario": "`listProgress` walks `storage.length` / `storage.key(i)`. On DurableStore, each `key(i)` runs `_ownedKeys()` = `[...this._mem.keys()].filter(...)`, which is O(n), so the loop is O(n²) in the number of `cp_` keys. Nothing ever prunes `cp_pos:<id>` rows (PositionStore.clear has no caller), so n grows with every episode ever opened. `lastPlayedForay()` and `forayResumeList()` (client.js:3713, 4448) call this on home render and boot.",
  "evidence": "Measured on origin/main modules in Node: 3,000 `cp_pos` rows plus 5 `cp_foray` rows makes `listProgress(store)` take 210 ms on desktop, several times that on a phone. durable-store.js:468-471: `key(i) { const keys = this._ownedKeys(); ... }`.",
  "fix_sketch": "Add a `keys(prefix)` / snapshot method to DurableStore and use it in listProgress, or cache `_ownedKeys()` and invalidate it on set/remove. Separately, cap or age out `cp_pos:*` rows (for example keep the most recent N).",
  "duplicates": [
    "data-integrity-7"
  ],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The code does what the finding says at origin/main. player/foray-progress.js:185-197 `listProgress` reads `storage.length` once and then calls `storage.key(i)` for every i. In player/durable-store.js:466-471, `length` and `key(i)` both call `_ownedKeys()`, and `_ownedKeys()` (line 815) is `[...this._mem.keys()].filter(k => k !== HEALTH_KEY)`, which rebuilds the whole array each time. That makes one walk O(n^2) in the number of owned `cp_` keys. `cp_pos:<id>` rows sit in the same `_mem` map. The comment at durable-store.js:464-465 says `listProgress` \"only ever walks cp_foray:\", but the walk still steps through every owned key to find those rows.\n\nclient.js:228 makes `storage` a DurableStore, and client.js:329 builds `forayProgress = new ForayProgressStore({ storage })`, so `lastPlayedForay()` (3712) and `forayResumeList()` (4444-4448) do go through this path. Nothing prunes `cp_pos` rows: `PositionStore.clear(id)` (position-store.js:102) has no non-test caller in player/. The one `.clear(forayId)` at client.js:4486 removes a Foray row, not a `cp_pos` row. I found nothing in DECISIONS.md or the comments that accepts this cost on purpose, and the comment suggests the author did not see it.\n\nI kept severity at low. n is one row per episode ever opened, so a realistic user has tens to a few hundred rows. At 300 rows the walk costs a couple of milliseconds. The 210 ms figure needs 3,000 rows, which is an extreme library. So this is a real scaling defect that gets worse slowly over time, but it is not a user-visible problem today. The fix is cheap: take one `_ownedKeys()` snapshot per walk, or add a `keys(prefix)` method.",
  "merged_ids": [
    "data-integrity-7"
  ],
  "lane": "L3-player-and-native-tts"
}
```

## search-api-css-4: TtlCache never evicts, and the show-scoped path has no rate limit: unbounded memory growth and outbound feed-fetch amplification

**confirmed** · verifier severity **medium** (finder: medium) · search-api-css · resource-leak · `api/episodes/searchCache.ts:43` · L4-web-platform

```json
{
  "id": "search-api-css-4",
  "area": "search-api-css",
  "category": "resource-leak",
  "title": "TtlCache never evicts, and the show-scoped path has no rate limit: unbounded memory growth and outbound feed-fetch amplification",
  "file": "api/episodes/searchCache.ts",
  "line": 43,
  "severity": "medium",
  "scenario": "TtlCache.set adds to a Map. An expired entry is deleted only when that same key is read again. episodeSearchCache stores every successful show-scoped answer, keyed by (show, limit, q), and the show-scoped branch (search.ts:376-409) never consults appleSearchBucket or any other limiter. A client or script looping `?show=lex-fridman-podcast&q=<random>` makes the function download a multi-MB third-party feed per request, and each answer is retained in a warm instance's memory indefinitely. appleShowCache and the Apple episode cache grow the same way, bounded only by the 20/min bucket. Every typeahead prefix of 3 or more characters adds an entry of up to 100 rows that is never pruned. This costs Vercel function time on a public, unauthenticated endpoint and makes Foray a request amplifier against podcast hosts.",
  "evidence": "searchCache.ts:43-45\n  set(key: string, value: T): void {\n    this.store.set(key, { value, expiresAt: this.clock.now() + this.ttlMs });\n  }\nThere is no size cap or sweep. search.ts:394 `await searchWithinShow(showScope, q, fetch)` has no bucket check, unlike the general path at 413 `if (!appleSearchBucket.tryConsume())`.",
  "fix_sketch": "Give TtlCache a maxEntries parameter (evict the oldest by Map insertion order on set, and sweep expired entries opportunistically). Rate-limit the show-scoped path per instance, keyed by show (for example, at most N feed fetches per show per minute). With the per-show feed cache from the previous finding, the fetch count stops depending on q at all.",
  "duplicates": [
    "security-2"
  ],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the code at origin/main and the finding holds. In api/episodes/searchCache.ts, TtlCache.set (lines 43-45) only calls Map.set. It has no size cap and no sweep. An expired entry is deleted only when get() reads that same key again. episodeSearchCache is a module-scope `new TtlCache<unknown>()` keyed by normalizeQueryKey(q, show, limit), so every distinct successful (show, limit, q) combination adds an entry of up to 100 rows. Nothing ever prunes an entry whose key is not read again.\n\nIn api/episodes/search.ts's handler, the show-scoped branch works like this:\n- It checks episodeSearchCache first.\n- It then checks episodeFeedFailureCache, which is keyed by show and only remembers failed feeds, for 90 seconds.\n- It then calls `searchWithinShow(showScope, q, fetch)`, with no appleSearchBucket or other limiter. appleSearchBucket.tryConsume() guards only the unscoped Apple path.\n\nsearchWithinShow calls fetchFeedConditional with `{etag: null, lastModified: null}`, so every fetch downloads the full feed. There is no per-show feed-body cache. A cache miss on a new q therefore always re-downloads and re-parses the whole third-party feed.\n\nNothing I found makes this deliberate. The file comments call the caches a per-instance \"hit-rate optimization\", and grep of docs/DECISIONS.md turns up nothing on cache eviction or rate-limiting this path. The code even notes that the feed fetch is \"NOT cheap\" (about 950 ms median).\n\nSome things limit the impact:\n- The show must exist in the local catalog. An unknown show_id returns early without any network fetch, but the catalog spans about 19.9k shows, so there are plenty of valid targets.\n- Feed bodies are capped at 20 MB (MAX_FEED_BYTES).\n- Successful answers get `Cache-Control: public, max-age=300`, but that edge cache does not help when q is randomised.\n- Vercel warm instances are recycled, so the memory growth is bounded by instance lifetime rather than truly indefinite. The cached payloads are also small next to the feed downloads.\n\nThe outbound amplification on a public, unauthenticated endpoint is the stronger half of the finding. The memory-leak half is real but minor in practice. Medium is the right severity.",
  "merged_ids": [
    "security-2"
  ],
  "lane": "L4-web-platform"
}
```

## ci-release-11: The CI `api` job installs with `npm install`, but Vercel installs with `npm ci`, so CI can pass on a lockfile/manifest mismatch that breaks the production deploy

**confirmed** · verifier severity **low** (finder: low) · ci-release · ci-tooling · `.github/workflows/ci.yml:80` · L7-ci-release-security

```json
{
  "id": "ci-release-11",
  "area": "ci-release",
  "category": "ci-tooling",
  "title": "The CI `api` job installs with `npm install`, but Vercel installs with `npm ci`, so CI can pass on a lockfile/manifest mismatch that breaks the production deploy",
  "file": ".github/workflows/ci.yml",
  "line": 80,
  "severity": "low",
  "scenario": "A PR bumps a dependency in api/package.json (or backend/package.json) without regenerating the lockfile. In the api job, `npm install` quietly resolves and rewrites the lock, and the tests pass on a tree that is not committed. vercel.json's installCommand `npm ci --prefix api ... && npm ci --omit=dev --prefix backend` refuses the out-of-sync lock, so the production build fails after merge. The job also tests whatever versions `npm install` floated to rather than the ones production pins.",
  "evidence": "ci.yml:80-81 `- run: npm install` / `- run: npm install --omit=dev --prefix ../backend`. api/package-lock.json and backend/package-lock.json are committed. vercel.json installCommand uses `npm ci` for both.",
  "fix_sketch": "Use `npm ci` and `npm ci --omit=dev --prefix ../backend` to mirror vercel.json exactly, and add `cache: npm` with both lockfiles as cache-dependency-path.",
  "duplicates": [
    "search-api-css-12",
    "security-14",
    "tests-12"
  ],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "This holds at origin/main, with one narrowing. In .github/workflows/ci.yml, lines 80-81 of the `api` job run `npm install` and `npm install --omit=dev --prefix ../backend`, with no setup-node npm cache. The job's own comment says it is \"mirroring vercel.json's installCommand exactly\". But vercel.json's installCommand is `npm ci --prefix api ... && npm ci --omit=dev --prefix backend ...`, so the comment's intent is not what the code does. It is a gap, not a deliberate choice. Both api/package-lock.json and backend/package-lock.json are committed. docs/DECISIONS.md mentions npm ci only for tools/mobile, and nothing there justifies `npm install` for api/.\n\nThe narrowing: the backend half of the scenario is already handled. The required `backend` job (ci.yml:32) runs `npm ci` in backend/, which fails when backend/package.json and backend/package-lock.json are out of sync, so a backend-only drift is caught before merge. The gap is real for api/: a change to api/package.json without a regenerated api/package-lock.json passes the `api` job, because `npm install` quietly rewrites the lock. That job is also not in protect-main's required checks, per its comment. Nothing else catches it before merge either: tools/web/vercel-should-build.mjs makes preview builds opt-in (since 2026-09-23), so the first `npm ci` that sees the mismatch is the production build after merge.\n\nImpact is a failed deploy, not a broken live site: Vercel keeps serving the previous deployment. It is also rare, since it only happens when api/ dependencies are edited by hand. Severity stays low. The fix sketch is right: switch both lines to `npm ci` and add the npm cache keyed on both lockfiles.",
  "merged_ids": [
    "search-api-css-12",
    "security-14",
    "tests-12"
  ],
  "lane": "L7-ci-release-security"
}
```

## ci-release-12: The iOS build paths (including the TestFlight release action) still use `npm install` under a stale 'no committed lockfile' comment, while Android uses `npm ci`

**confirmed** · verifier severity **low** (finder: low) · ci-release · ci-tooling · `.github/actions/ios-archive/action.yml:67` · L7-ci-release-security

```json
{
  "id": "ci-release-12",
  "area": "ci-release",
  "category": "ci-tooling",
  "title": "The iOS build paths (including the TestFlight release action) still use `npm install` under a stale 'no committed lockfile' comment, while Android uses `npm ci`",
  "file": ".github/actions/ios-archive/action.yml",
  "line": 67,
  "severity": "low",
  "scenario": "mobile/package-lock.json is committed (android-build.yml:251-258 documents fixing exactly this drift on the Android side). The iOS release action and ios-build.yml still run `npm install`. If package.json and the lock ever disagree, the TestFlight build silently resolves new @capacitor/* versions (^8.0.0 ranges) while the Android job in the same release run fails `npm ci` or uses the locked versions. 'One run, one SHA' then ships two different dependency trees, and npm lifecycle scripts from unpinned versions run in the job that later materialises the signing key.",
  "evidence": "ios-archive/action.yml:67 `npm install --no-audit --no-fund`. ios-build.yml:202-207 comment: 'There is no committed lockfile, so this is `npm install`'. android-bundle/action.yml:95 `npm ci --no-audit --no-fund`.",
  "fix_sketch": "Switch both iOS paths to `npm ci --no-audit --no-fund` and delete the stale comment. A test in tools/mobile/ios-workflow.test.mjs could pin 'no npm install under mobile/'.",
  "duplicates": [
    "security-4"
  ],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "Confirmed at origin/main. .github/actions/ios-archive/action.yml:67 runs `npm install --no-audit --no-fund` in mobile/. .github/workflows/ios-build.yml:199-207 does the same, under the comment \"There is no committed lockfile, so this is `npm install`, not `npm ci`\". That comment is false: mobile/package-lock.json is committed (blob e059fb99). Every Android path uses `npm ci`: android-bundle/action.yml:95, android-build.yml:266, and android-release.yml:234 and :781. android-build.yml:251-258 says outright that the \"no lockfile\" comment was copied from ios-build.yml and \"is not [true] any more\". tools/mobile/android-workflow.test.mjs:330-348 pins `npm ci` for Android and forbids `npm install` there. No iOS test does the same. Nothing in docs/DECISIONS.md or any comment makes the iOS difference deliberate; the only justification is the stale comment. Severity stays low for one reason: with a lockfile present, `npm install` keeps the locked versions as long as package.json still satisfies them. The two builds only resolve different trees when package.json and the lock disagree, and in that case Android's `npm ci` fails outright rather than silently shipping a second tree. So the realistic harm is a non-reproducible iOS build or a lockfile rewritten during CI, not routine divergence between the two platforms. The claim about lifecycle scripts from unpinned versions is only possible in that same drift case. The fix is still cheap and correct: use `npm ci` on both iOS paths, delete the stale comment, and add an iOS test like the Android one.",
  "merged_ids": [
    "security-4"
  ],
  "lane": "L7-ci-release-security"
}
```

## backend-rest-4: Catalog and pipeline tables have no RLS, so on Supabase the public anon key can insert or modify catalogue episodes

**confirmed** · verifier severity **medium** (finder: medium) · backend-rest · security · `backend/migrations/0016_catalog_show_episodes.sql:11` · L6-backend-rest

```json
{
  "id": "backend-rest-4",
  "area": "backend-rest",
  "category": "security",
  "title": "Catalog and pipeline tables have no RLS, so on Supabase the public anon key can insert or modify catalogue episodes",
  "file": "backend/migrations/0016_catalog_show_episodes.sql",
  "line": 11,
  "severity": "medium",
  "scenario": "On Supabase, tables in `public` get default grants to anon and authenticated and are exposed through PostgREST. The project's own linter flagged exactly this ('exposed via PostgREST with no RLS') for schema_migrations and learning_cursor, and supabase/0002 fixed only those two. catalog_show_episodes and catalog_show_feed_state (0016, written after that linter pass), plus shows/episodes/episode_enrichment/cost_events, are never RLS-enabled. Once 0016 is applied and DB mode is on, anyone holding the public anon key can upsert rows into catalog_show_episodes: attacker audio_url, HTML in description_html, or a fake show list. The endpoint serves those rows to every visitor, and they count as fresh because catalog_show_feed_state is writable too (set last_fetch_ok=true with a future last_fetched_at). DECISIONS.md says 'service-role-owned, no RLS (shared public catalogue data)': the intent was public READ, not public WRITE.",
  "evidence": "0016 creates both tables with no `enable row level security`. supabase/0001_auth_and_rls.sql:60-65 lists only 'app_users','taxonomy_nodes','user_interests','events','saved_items','sessions','session_items','subscriptions'; supabase/0002_linter_findings.sql:12-13 adds only schema_migrations and learning_cursor.",
  "fix_sketch": "Add supabase/0003: `alter table public.catalog_show_episodes enable row level security; create policy public_read on public.catalog_show_episodes for select to anon, authenticated using (true);`. Do the same for catalog_show_feed_state, with deny-all or select-only. Enable deny-all RLS on shows, episodes, episode_enrichment and cost_events. The service role bypasses RLS, so ingest keeps working, and this matches the DECISIONS.md intent of public read.",
  "duplicates": [
    "security-7"
  ],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the files at origin/main and the finding holds. backend/migrations/0016_catalog_show_episodes.sql creates catalog_show_episodes and catalog_show_feed_state in the default (public) schema. It has no `enable row level security` and no revoke of anon/authenticated grants. `git grep` finds no GRANT or REVOKE on tables anywhere in the repo's SQL. supabase/0001 enables RLS only on the 8 per-user tables, and supabase/0002 adds only schema_migrations and learning_cursor. No supabase/0003 exists.\n\nThe anon key really is public: app.js:416 ships `sb_publishable_0T8hpKCC_...`. On Supabase's default setup, public-schema tables get grants to anon and authenticated and are exposed through PostgREST. So without RLS, anyone with that key can insert, update or delete rows through /rest/v1/catalog_show_episodes.\n\nThe documents make it deliberate that there is no RLS, but not that the public can write. The 0016 comment and DECISIONS.md (~line 2480) say \"service-role-owned, no RLS (shared public catalogue data, not personal)\". That reasoning is only about privacy. It never considers anonymous writes, which differs from how 0002 handled the linter's no-RLS errors: it enabled deny-all RLS on the flagged tables. So this is an oversight, not a considered decision about writes.\n\nTwo parts of the scenario are wrong, which is why the severity stays medium:\n(1) The claim that attacker HTML in description_html reaches every visitor is overstated. api/shows/[show_id]/episodes.ts:158-187 drops description_html from the list response, and the comment there says \"NOTHING reads it\". The real vectors are audio_url (attacker audio or a tracking URL played in-app), title and description_text, and deleting or replacing a show's episode list. Freshness can be faked through catalog_show_feed_state (ingestShowFeed.ts:85 checks last_fetch_ok and the fetch time), which would stop the real feed from overwriting the fake rows.\n(2) The exposure depends on deployment. The supabase README says those migrations are \"NOT yet verified against a live project\", and I could not confirm that 0016 is applied to the live project. Oddly, 0002's comment says the linter flagged only 2 no-RLS tables, even though shows, episodes and cost_events have no RLS in the repo either. That suggests the live schema may differ from the repo, so live exposure is unverified.\n\nThe fix sketch is sound: enable RLS with a select-only policy, or deny-all with the service role doing the reads. The endpoint uses a service-role pg connection (showEpisodesStore.ts header), which bypasses RLS, so nothing breaks.",
  "merged_ids": [
    "security-7"
  ],
  "lane": "L6-backend-rest"
}
```

## backend-rest-1: parseFeed throws on an out-of-range numeric entity, so a show's episode page returns HTTP 500 in production

**confirmed** · verifier severity **medium** (finder: high) · backend-rest · correctness · `backend/src/feeds/html.ts:39` · L6-backend-rest

```json
{
  "id": "backend-rest-1",
  "area": "backend-rest",
  "category": "correctness",
  "title": "parseFeed throws on an out-of-range numeric entity, so a show's episode page returns HTTP 500 in production",
  "file": "backend/src/feeds/html.ts",
  "line": 39,
  "severity": "high",
  "scenario": "A feed contains a malformed numeric character reference such as `&#99999999;` or `&#x110000;` in an item title or description. fast-xml-parser v5 leaves numeric references alone, so decodeEntities calls String.fromCodePoint(99999999), which throws RangeError. parseItem and parseFeed have no try/catch around it, even though parseFeed documents 'Never throws on malformed input'. In production (no DATABASE_URL), api/shows/[show_id]/episodes.ts calls parseFeed(fetchResult.body) at line ~258 with no try/catch, so the Vercel function crashes and every visitor to that show gets a 500 instead of the degraded 200 the endpoint promises. The DB-mode path (ingestShowFeed.ts:137) throws the same way, and api/episodes/search.ts shares this parser.",
  "evidence": "Confirmed by running origin/main parser.ts through tsx: parseFeed(`<rss><channel><title>x</title><item><title>Bad &#99999999; title</title><guid>a</guid></item></channel></rss>`) -> THROWS \"Invalid code point 99999999\". Code: `const code = parseInt(entity.slice(2), 16); return Number.isFinite(code) ? String.fromCodePoint(code) : match;` (lines 38-39 and 42-43). Number.isFinite does not bound the value to 0x10FFFF.",
  "fix_sketch": "In decodeEntities, only decode when `code >= 1 && code <= 0x10FFFF && !(code >= 0xD800 && code <= 0xDFFF)`, and otherwise return U+FFFD or leave `match` unchanged. As a safety net, wrap parseItem in parseFeed so one bad item becomes a warning and is skipped. Add a regression test with `&#99999999;` and `&#x110000;`.",
  "duplicates": [
    "arch-drift-1"
  ],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I checked this against origin/main and the finding holds. In backend/src/feeds/html.ts at lines 38-39 and 42-43, decodeEntities uses only `Number.isFinite(code)` as a guard before calling `String.fromCodePoint(code)`. That check does not stop values above 0x10FFFF, and String.fromCodePoint throws RangeError on them.\n\nThe bad entity survives the earlier steps. lenientXmlPreprocess (parser.ts:56) keeps `&#\\d+;` and `&#x[0-9a-fA-F]+;` as they are. The file's own comment says fast-xml-parser (v5.11.1 installed) does not decode numeric references. In parseFeed, the only try/catch is around `xmlParser.parse`. The calls to decodeEntities for the channel title (line 202) and for each item title in parseItem (line 242) are unguarded, which breaks the \"Never throws on malformed input\" docstring.\n\nI copied the origin/main parser.ts, html.ts and duration.ts to scratch and ran them with the repo's tsx. `&#99999999;` threw \"Invalid code point 99999999\" and `&#x110000;` threw \"Invalid code point 1114112\".\n\nIn api/shows/[show_id]/episodes.ts, no-DB mode calls `parseFeed(fetchResult.body)` at line 258 with no try/catch around it. Only the fetch-error branch returns the degraded 200 that the comment describes, so a parse throw becomes an unhandled 500. The DB branch has only try/finally, so it would propagate the error as well.\n\nI found nothing in the code comments marking this as deliberate. I did not read docs/DECISIONS.md.\n\nI rate it medium, not high. The trigger needs a malformed entity in a feed on the curated show list, and it breaks only that show's episode page. Even so, it breaks that page completely on every visit, and a feed publisher controls the input.",
  "merged_ids": [
    "arch-drift-1"
  ],
  "lane": "L6-backend-rest"
}
```

## ci-release-4: The build number is not monotonic: the run_number wrap (99 -> 1) on the same UTC day makes both stores reject every later release that day, and then the retry budget stops the trigger

**confirmed** · verifier severity **medium** (finder: medium) · ci-release · correctness · `.github/workflows/release.yml:177` · L7-ci-release-security

```json
{
  "id": "ci-release-4",
  "area": "ci-release",
  "category": "correctness",
  "title": "The build number is not monotonic: the run_number wrap (99 -> 1) on the same UTC day makes both stores reject every later release that day, and then the retry budget stops the trigger",
  "file": ".github/workflows/release.yml",
  "line": 177,
  "severity": "medium",
  "scenario": "Release run_number is 31 today, and release-trigger dispatches every 2h plus retries. On the day run 99 (build YYYYMMDD99) and run 100 both happen, run 100 computes RUN_OF_DAY=1, giving build YYYYMMDD01, which is lower than a build already uploaded that day. App Store Connect rejects it ('bundle version must be higher than the previously uploaded version', which upload-retry.mjs classifies as PERMANENT), and Play rejects a lower versionCode. Every later run that day also fails. After 2 failures, triggerDecision returns HOLD_RETRY_BUDGET and stops dispatching until a human dispatch succeeds. docs/release-reliability-plan.md §3 records only the 'differ by a multiple of 99' collision and says it 'should be fixed'. The decreasing-number case is more likely and is not recorded.",
  "evidence": "`RUN_OF_DAY=$(( (${{ github.run_number }} - 1) % 99 + 1 ))` then `version.mjs pair --run-of-day \"$RUN_OF_DAY\"` -> YYYYMMDDnn. The header calls it 'WRAPPED (modulo 99, not clamped)'.",
  "fix_sketch": "Derive nn from today's runs instead of the lifetime counter. In the version job, count release.yml runs created since 00:00 UTC today (`gh api .../workflows/release.yml/runs?created=>=$(date -u +%F)`) and use count+1, failing loudly past 99. Or read the last uploaded build number and assert the new one is strictly greater before any macOS minutes are spent.",
  "duplicates": [
    "mobile-native-9"
  ],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the code at origin/main and the finding holds. At .github/workflows/release.yml:177, `RUN_OF_DAY=$(( (${{ github.run_number }} - 1) % 99 + 1 ))` is passed to `tools/mobile/version.mjs pair --run-of-day`, which produces YYYYMMDDnn. The header at lines 34-40 says it is \"WRAPPED (modulo 99, not clamped)\" and comes from the lifetime run_number. So run 99 gives nn=99 and run 100 gives nn=01. If both fall on the same UTC day, the second build number (YYYYMMDD01) is lower than one already uploaded that day.\n\nThis is not deliberate. docs/DECISIONS.md (2026-09-06, R-02) says the build number is \"a single monotonic integer\". It also says monotonicity is \"a correctness requirement, not a style preference\", because Play rejects a reused or lower versionCode. The wrap breaks that stated rule.\n\ndocs/release-reliability-plan.md §3 records only two problems: re-runs reusing the number, and runs that differ by a multiple of 99 colliding. It says \"This should be fixed\", but nothing handles the case where the number goes down.\n\nThe rest of the chain also holds. tools/release/upload-retry.mjs:80-82 lists \"bundle version must be higher than the previously uploaded version\" among its matched errors. In tools/release/watch-release.mjs, triggerDecision (around line 625) returns HOLD_RETRY_BUDGET once failuresSinceSuccess reaches RETRY_BUDGET, and its test (line 394) uses 2 failures. After that the trigger stops dispatching until someone intervenes. A hand dispatch the same day would also get a wrapped, lower nn and fail. It only recovers once the UTC date changes.\n\nThe scenario is realistic. `gh run list` shows run #31 on 2026-09-25, with runs 28-30 all on 2026-09-24. With release-trigger dispatching every 2h (cron \"47 */2 * * *\"), several runs a day is normal, so the 99→100 boundary is fairly likely to land on a day that already has a run. That happens roughly once every ~99 runs, about monthly at the current pace.\n\nTwo things soften it:\n- A wrap only hurts if a higher-nn build actually uploaded earlier that UTC day.\n- It heals itself at the next UTC midnight, because the date part increases. The stall still lasts until a person clears the retry-budget hold.\n\nMedium is the right severity: a release outage of up to a day that recurs, not data loss.",
  "merged_ids": [
    "mobile-native-9"
  ],
  "lane": "L7-ci-release-security"
}
```

## security-1: Hourly pr-hygiene sweep arms and merges fork PRs from outside contributors, and app.js, sw.js, player/ and mobile/ are all on the auto-merge allowlist

**confirmed** · verifier severity **high** (finder: high) · security · security/ci-supply-chain · `tools/ci/pr-triage.mjs:289` · L7-ci-release-security

```json
{
  "id": "security-1",
  "area": "security",
  "category": "security/ci-supply-chain",
  "title": "Hourly pr-hygiene sweep arms and merges fork PRs from outside contributors, and app.js, sw.js, player/ and mobile/ are all on the auto-merge allowlist",
  "file": "tools/ci/pr-triage.mjs",
  "line": 289,
  "severity": "high",
  "scenario": "The repo is PUBLIC (gh repo view: visibility PUBLIC). An outside user who has had one earlier PR approved (fork approval_policy is only 'first_time_contributors') opens a fork PR that changes only sw.js or app.js, for example to exfiltrate cp_sb_session or to install a persistent service worker. The required checks (backend, data-and-site) run green and protect-main requires 0 approvals, so GitHub reports mergeable_state=clean. The hourly pr-hygiene cron (`23 * * * *`) gathers every open PR, and planMergeability's ARM branch calls automergeDecision, which looks only at files, labels, freeze and base. It emits enable-auto, and the executor runs `gh pr merge --auto`, or merges directly on the 'clean status' error. The fork's code lands on main and Vercel deploys it to every listener. The event-driven automerge-nightly job deliberately skips forks (`head.repo.full_name == github.repository`), but the sweep fills that gap, as its own header says: \"the 6-hourly sweep runs with a write token and picks fork PRs up for everything that does not require pushing to their branch\".",
  "evidence": "pr-triage.mjs:289 `} else if (pr.state === \"clean\") { const decision = automergeDecision({ files: pr.files, labels: pr.labels, freeze, baseRef: ... }); if (decision.armed) actions.push({ kind: \"enable-auto\", ... })` - normalizePr computes `crossRepo` and `author`, but neither is consulted when arming. path-policy.mjs ALLOWED_PREFIXES includes \"app.js\", \"sw.js\", \"player/\", \"mobile/\", \"tools/\", \"data/\". Live ruleset protect-main: `required_approving_review_count: 0`, bypass_actors []. Live `actions/permissions/fork-pr-contributor-approval` = first_time_contributors.",
  "fix_sketch": "In automergeDecision (or in planMergeability before the ARM and direct-merge branches), refuse when `pr.crossRepo` is true or when the author is not on an explicit allowlist (github-actions[bot] plus the founder's agent identities), returning not('FOREIGN_AUTHOR', ...) with needsFounder=true. Add a pr-triage test that a clean fork PR touching only data/ produces no enable-auto action. Consider also setting the fork-approval policy to 'all_outside_collaborators'.",
  "duplicates": [
    "ci-release-1"
  ],
  "verdict": "confirmed",
  "verdict_severity": "high",
  "verdict_reasoning": "I read the code at origin/main myself, and the finding holds.\n\n1. **The arming code.** In tools/ci/pr-triage.mjs, planMergeability (from about line 243) skips only drafts and PRs whose base is not main. In the `else if (pr.state === \"clean\")` branch at line 289, it calls automergeDecision with only files, labels, freeze and baseRef, and pushes enable-auto when the result is armed. normalizePr computes pr.crossRepo (line 130) and pr.author (line 150), but only the update-branch path reads crossRepo (line 359: \"head is on a fork — cannot update\"). Nothing in the arming or disarming path looks at either field.\n\n2. **The policy check.** automergeDecision in path-policy.mjs (line 423) checks draft, base, freeze, blocking labels, empty or truncated file lists, and denied or unlisted paths. It has no author or fork check. ALLOWED_PREFIXES includes data/, docs/, player/, tools/, test/, mobile/, app.js and sw.js.\n\n3. **The workflow.** .github/workflows/pr-hygiene.yml runs on cron \"23 * * * *\" with contents: write and pull-requests: write. The job-level `if` skips fork PRs only for pull_request events. The header comment says the sweep \"picks fork PRs up\" on purpose. The Gather step lists every open PR with no fork filter. The enable-auto executor runs `gh pr merge --squash --auto`, and on the \"clean status\" error it merges directly.\n\n4. **Live settings I checked.** The repo is PUBLIC. The protect-main ruleset has required_approving_review_count 0, no bypass actors, and requires only the `backend` and `data-and-site` checks. The fork approval_policy is first_time_contributors.\n\n**What I looked for to refute it.** Nothing in docs/DECISIONS.md or in code comments covers forks or outside contributors. The comment on sw.js accepts the risk only for \"bot-authored\" changes, which assumes the author is an agent and does not cover outsiders. I found no other gate.\n\n**What limits the scenario.** A brand-new contributor's CI runs need a maintainer's approval first, so the required checks stay pending until then. Once someone approves that run, or once the person counts as a returning contributor, a green fork PR that touches only allowlisted paths is armed and merged within the hour with no human review. The ruleset also has a require_extra_approval_for_unattributed_changes flag. I don't know exactly what it does, and nothing suggests it gates fork PRs.\n\n**Severity: high.** The attack needs only a green PR from a returning contributor, and it lets outsider-written sw.js or app.js code reach main and the live deploy. I didn't run any test, since the logic is plain from reading the code.",
  "merged_ids": [
    "ci-release-1"
  ],
  "lane": "L7-ci-release-security"
}
```

## arch-drift-13: The live episodes endpoint's DB branch has drifted from its no-DB branch: no pagination, different response shape, and connect() can 500

**confirmed** · verifier severity **low** (finder: low) · arch-drift · duplicated-logic-drift · `api/shows/[show_id]/episodes.ts:277` · L4-web-platform

```json
{
  "id": "arch-drift-13",
  "area": "arch-drift",
  "category": "duplicated-logic-drift",
  "title": "The live episodes endpoint's DB branch has drifted from its no-DB branch: no pagination, different response shape, and connect() can 500",
  "file": "api/shows/[show_id]/episodes.ts",
  "line": 277,
  "severity": "low",
  "scenario": "The handler has two implementations of one endpoint. The no-DB branch paginates (PAGE_SIZE 100, `next_cursor`), reports `degraded`, and never returns a 500. The DB branch returns every episode unpaginated, has no `next_cursor` or `degraded`, adds `stale`, and runs `await client.connect()` before its try block, so an unreachable database is an unhandled 500. The branch is dormant today (no DATABASE_URL in production). Setting the env var would silently change the client contract: app.js treats a missing `next_cursor` as 'this is the whole show' and would render thousands of rows at once. It would also bring back the 500s the no-DB branch was written to avoid.",
  "evidence": "episodes.ts:263 `const { page, nextCursor } = paginate(episodes, cursor, PAGE_SIZE);` appears only in the no-DB branch. :276-278 `const client = new Client({ connectionString: databaseUrl }); await client.connect(); try {`. The DB response at :285-297 has `episodes: episodes.map(toListRow), source: \"db\", stale: ...` with no next_cursor/degraded.",
  "fix_sketch": "Build one response path: paginate the DB episode list with the same cursor, emit the same fields (`next_cursor`, `degraded`, `error`), and move `connect()` inside a try that degrades to the live branch or to a 200 with `degraded: true`. Add a contract test that runs both branches through one shape assertion.",
  "duplicates": [
    "search-api-css-9",
    "security-13"
  ],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read api/shows/[show_id]/episodes.ts at origin/main and the finding holds. The line numbers are off by about one: connect() is at 279, not 278. The no-DB branch (233-276) decodes a cursor, calls paginate(episodes, cursor, PAGE_SIZE=100), and returns next_cursor, degraded and error. On a feed failure it returns a 200 with degraded:true and never a 500. The DB branch (278-301) builds a Client and calls `await client.connect()` outside the try/finally. A connection failure therefore throws out of the handler as an unhandled 500, and the client is never ended. That branch then returns every row from store.episodesForShow() with no pagination. Its response has no next_cursor or degraded fields and adds `stale`. On the client, app.js:4016 maps `body.next_cursor || null`, and the comments at 3860 and 4475 say null means the whole show is loaded, so the client would take one unpaginated dump as the complete list.\n\nIt is not deliberate as a design contract. The file header (38-39) only says DB mode \"is unchanged from Stage 3b's original behavior\" and is \"currently dormant in production\". That shows the authors knew the branch had not been updated. It does not argue that the two response shapes should differ. Nothing in DECISIONS.md makes the divergence intentional; the only DATABASE_URL entries there are about an unrelated, unbuilt UserInterestsProvider.\n\nNothing else handles this case. The finding's own scenario needs someone to set DATABASE_URL in production, which is not the case today. The impact is latent, so the severity stays low.",
  "merged_ids": [
    "search-api-css-9",
    "security-13"
  ],
  "lane": "L4-web-platform"
}
```

## data-tools-7: Feed fetchers outside scan.mjs skip the M1 byte cap (and backfill-show has no timeout); fetch-limits' header wrongly claims refresh-feeds uses it

**confirmed** · verifier severity **low** (finder: medium) · data-tools · duplicated-logic-drift · `tools/classify/prepare-batch.mjs:211` · L8-data-tools

```json
{
  "id": "data-tools-7",
  "area": "data-tools",
  "category": "duplicated-logic-drift",
  "title": "Feed fetchers outside scan.mjs skip the M1 byte cap (and backfill-show has no timeout); fetch-limits' header wrongly claims refresh-feeds uses it",
  "file": "tools/classify/prepare-batch.mjs",
  "line": 211,
  "severity": "medium",
  "scenario": "fetch-limits.mjs was added so that 'a publisher can serve an extremely large or endless response' no longer exhausts memory. Only scan.mjs uses it. Several other paths still buffer an unbounded body with res.text(): the classify batch fetcher, which runs over thousands of breadth feeds; sweep-transcripts fetchFeed, which runs 1,000-feed sweeps and is also reused by measure-suspects; backfill-show fetchFeed, which also has no AbortController or timeout, so one hung feed hangs the backfill forever; and fetch-transcripts, whose MAX_BODY_BYTES is checked only after the full read. A misbehaving or endless feed OOMs the long sweep and loses the in-memory work since the last checkpoint. The header of fetch-limits.mjs says it is 'Used by both tools/refresh/scan.mjs and tools/refresh-feeds.mjs', but git grep finds no import in refresh-feeds.mjs.",
  "evidence": "prepare-batch.mjs:209-211 `const res = await fetch(url, {...signal}); if (!res.ok) throw ...; return await res.text();`; sweep-transcripts.mjs:280 `if (res.ok) return await res.text();`; backfill-show.mjs:277-280 `const res = await fetch(url, { headers: { \"User-Agent\": UA }, redirect: \"follow\" }); ... return res.text();`; fetch-transcripts.mjs:283-285 checks bytes only after `await res.text()`.",
  "fix_sketch": "Route every feed and transcript body read through fetch-limits' readBodyCapped/fetchFeedCapped, passing the caller's own AbortController and politeness headers. Give backfill-show a timeout. Fix the fetch-limits header, or wire refresh-feeds.mjs to it.",
  "duplicates": [
    "arch-drift-11"
  ],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read the code at origin/main, and the core facts are right. `git grep` shows only tools/refresh/scan.mjs imports fetch-limits.mjs. The other fetchers read the whole body with `res.text()`:\n- prepare-batch.mjs:209-211 (fetchText)\n- sweep-transcripts.mjs:280 (fetchFeed, which measure-suspects.mjs:64 imports and calls at line 1556)\n- backfill-show.mjs:277-280, which has no AbortController and no timeout at all\n- fetch-transcripts.mjs, which checks the declared Content-Length first but checks the actual byte count only after the full `res.text()` read\n\nNone of these carries a comment or a docs/DECISIONS.md entry saying the exemption is deliberate. The fetch-limits header itself says fetch paths bound time but not bytes, so the gap is known and was only partly fixed.\n\nWhy the severity is lower than claimed:\n1. prepare-batch (15s), sweep-transcripts (30s) and fetch-transcripts all pass an AbortController signal. In Node, that signal also aborts `res.text()` partway through the body. An endless chunked response is therefore cut off at the timeout. The OOM needs a publisher to push gigabytes within 15-30s, or a huge body that declares no Content-Length. That is possible but unlikely.\n2. backfill-show is a manual one-show tool that runs outside the nightly, per its header. A hang on its single feed fetch is real, but the operator sees it and can kill it. No in-memory sweep work is lost.\n3. The header claim is misleading rather than false. tools/refresh-feeds.mjs is a 31-line deprecated wrapper that spawns scan.mjs with the same arguments. It does not import fetch-limits, but everything it runs goes through the cap. The header text is stale and should be fixed.\n\nNet result: the gap is real and the fix sketch fits, but in practice the risk is low.",
  "merged_ids": [
    "arch-drift-11"
  ],
  "lane": "L8-data-tools"
}
```

## app-1-3: sameEpisodeList compares `id`, but show-episode rows only carry `guid`, so any same-length refresh counts as unchanged

**confirmed** · verifier severity **medium** (finder: medium) · app-1 · correctness · `app.js:4992` · L2-app-surface

```json
{
  "id": "app-1-3",
  "area": "app-1",
  "category": "correctness",
  "title": "sameEpisodeList compares `id`, but show-episode rows only carry `guid`, so any same-length refresh counts as unchanged",
  "file": "app.js",
  "line": 4992,
  "severity": "medium",
  "scenario": "The api/shows/:id/episodes rows are CatalogShowEpisode objects: show_id, guid, title and so on, with no `id` field (backend/src/catalog/showEpisodesStore.ts:20-33, toListRow in api/shows/[show_id]/episodes.ts). `a[i].id !== b[i].id` is therefore `undefined !== undefined`, which is always false, so two lists of the same length always compare equal. Any show with 100 or more episodes returns exactly PAGE_SIZE=100 rows, and so does any feed that caps its item count. On a revisit within the 30-minute cache TTL, the stale-while-revalidate refresh brings back a list with a new episode at the top, hits `if (cached && sameEpisodeList(cached.episodes, episodes)) return;`, and never repaints. The listener keeps seeing yesterday's list, which breaks the 'still sees today's' promise in the cache header. The in-show search fallback also filters the stale `loaded` while the cache already holds the new list. The unit test cannot catch this because its fixture uses `{ id }` rows (test/show-episodes-cache.test.js:85), a shape production never sends.",
  "evidence": "`function sameEpisodeList(a, b) { ... for (let i = 0; i < a.length; i += 1) if (a[i].id !== b[i].id) return false; return true; }` (4990-4994). Call site: `if (cached && sameEpisodeList(cached.episodes, episodes)) return;` (4929). The client itself builds row ids from `ep.guid` (3817).",
  "fix_sketch": "Compare the key the client actually uses: `const key = e => e && (e.guid ?? `${e.title}|${e.published_at}`)`, and compare key(a[i]) with key(b[i]). Change the test fixture to real API rows ({guid, title, published_at}) and add a case where a same-length list with a new head episode must repaint.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the code at origin/main and the finding holds. sameEpisodeList (app.js 4990-4994) compares `a[i].id !== b[i].id`. The rows come from fetchShowEpisodesUncached (app.js ~3984-4035), which passes `body.episodes` through unchanged, and the endpoint builds those rows with toListRow, which only strips description_html from a CatalogShowEpisode (show_id, guid, title, ...). No row has an `id`. Every comparison is therefore undefined !== undefined, which is false, so any two lists of the same length count as equal. Row ids are only built later, from `${show.show_id}--${ep.guid}`, in fullCatalogueRowToEpRowItem (3817); they never reach the cached or fetched arrays. The endpoint pages at PAGE_SIZE=100 (episodes.ts:145, paginate on the live path that production runs), so any show with 100 or more episodes returns exactly 100 rows on every call. When a new episode is published, the list is still 100 long. At line 4929, `cached` is the snapshot taken before the refresh, and `cached && sameEpisodeList(...)` returns early, so the new list is never painted. The cache itself was rewritten with the new list one line earlier (cacheShowEpisodes at 4911), so the screen and the cache disagree until the next visit. Nothing in the comments marks this as deliberate. The docstring says 'Ids only', which shows the intent was to compare episode identity, and the wrong field defeats that. The test fixture EPS builds `{ id, title }` rows (test line ~85), a shape the API never returns, so the unit test cannot catch this. Severity is medium: the refresh fails silently and the listener sees stale data. It does not lose data, and a full reload after the cache expires fixes it.",
  "merged_ids": [],
  "lane": "L2-app-surface"
}
```

## app-1-5: Show-scoped search rows for feeds without guids all get the id `<show>--null`, so they collide and tapping one row plays another row's audio

**confirmed** · verifier severity **medium** (finder: medium) · app-1 · correctness · `app.js:3817` · L2-app-surface

```json
{
  "id": "app-1-5",
  "area": "app-1",
  "category": "correctness",
  "title": "Show-scoped search rows for feeds without guids all get the id `<show>--null`, so they collide and tapping one row plays another row's audio",
  "file": "app.js",
  "line": 3817,
  "severity": "medium",
  "scenario": "The list endpoint substitutes a guid when a feed item has none (`ep.guid ?? noguid:${title}:${publishedAt ?? idx}`, episodes.ts:193). The show-scoped search endpoint does not (`guid: ep.guid`, api/episodes/search.ts:192), and ParsedEpisode.guid is `string | null` (backend/src/feeds/parser.ts:6). On a guid-less feed, every scoped-search result maps to `${show_id}--null`. Each snapshot() call overwrites state.itemIndex[\"x--null\"], so every row's ▶ plays the last row's audio_url. Every row also shows ❚❚ at once through isCurrent, and stars/Up Next/history all key on one shared id. The same episode also has one id in the list and a different id in search results, so a star made from one view does not show in the other.",
  "evidence": "`function fullCatalogueRowToEpRowItem(show, ep) { const id = `${show.show_id}--${ep.guid}`; return snapshot(id, {...}); }` (3816-3817). paintList feeds scopedResults through it: `const rows = visible.map((ep) => fullCatalogueRowToEpRowItem(show, ep));` (4545).",
  "fix_sketch": "Build the id from one shared function, e.g. `ep.guid || `noguid:${ep.title}:${ep.published_at ?? \"\"}``, matching the list endpoint's fallback. Better still, make api/episodes/search.ts mapLiveEpisode apply the same fallback so both endpoints agree. Add a test that two guid-less rows get distinct ids.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I checked each link in the chain at origin/main, and it holds.\n(1) backend/src/feeds/parser.ts:6 types guid as `string | null`. Lines 245-255 leave it null when an item has no <guid>; the parser only adds a warning (\"identity relies on composite key\") and supplies no fallback.\n(2) api/episodes/search.ts mapLiveEpisode (186-199) passes `guid: ep.guid` straight through. The show-scoped live path uses it at line 277. There is no noguid fallback anywhere in search.ts; a grep found none.\n(3) The list endpoint api/shows/[show_id]/episodes.ts:193 does apply a fallback: `ep.guid ?? `noguid:${ep.title}:${ep.publishedAt ?? idx}``. So the two endpoints disagree on the id for the same guid-less episode.\n(4) app.js searchShowEpisodesScoped (4240) returns data.episodes unchanged. The code puts them into scopedResults (4805), and paintList maps them through fullCatalogueRowToEpRowItem (4545).\n(5) fullCatalogueRowToEpRowItem (3816-3817) builds `${show.show_id}--${ep.guid}`, which becomes \"<id>--null\" when guid is null. snapshot() (897) writes `state.itemIndex[id] = snap`, so each row overwrites the one before it. The comments at 3808-3814 say bindPlay and toggleStar read state.itemIndex[id] first, so every row resolves to the last row's snapshot.\nNothing in the code comments or DECISIONS.md makes this deliberate. The fix belongs in mapLiveEpisode or the client id builder.\nI kept severity at medium rather than high because it only affects feeds that leave out <guid>, which is uncommon among real podcasts, and only in show-scoped search results. Where it happens, though, playback is wrong, and stars, Up Next and history are corrupted.",
  "merged_ids": [],
  "lane": "L2-app-surface"
}
```

## app-1-6: Generated playlists (#/playlist/gen-<leaf>) often say 'Playlist not found' after a reload or relaunch: an incomplete fix of qa 116

**confirmed** · verifier severity **medium** (finder: medium) · app-1 · correctness · `app.js:1849` · L1-app-data

```json
{
  "id": "app-1-6",
  "area": "app-1",
  "category": "correctness",
  "title": "Generated playlists (#/playlist/gen-<leaf>) often say 'Playlist not found' after a reload or relaunch: an incomplete fix of qa 116",
  "file": "app.js",
  "line": 1849,
  "severity": "medium",
  "scenario": "generatedPlaylistById recomputes generatedPlaylists(). That function drops any leaf whose parent root was dealt into a card slot this boot (`!slotBranches.has(n.parent)`), and keeps only the top 3 leaves by current interest weight. buildCards deals roots at random on every boot, with jitter and a recency penalty. So reloading, restoring or relaunching (relaunchRoute) on `#/playlist/gen-history/technology` gives 'Playlist not found.' whenever History is dealt this time, or once plays and thumbs have moved the leaf out of the top 3. A Jump back in card or a shared link to a generated playlist breaks the same way. qa 116 fixed exactly this for #/subject/ ('ANY REAL BRANCH IS ANSWERABLE') but not for gen- ids.",
  "evidence": "`.filter(n => n.parent !== null && !slotBranches.has(n.parent) && byTopic.has(n.id))` ... `if (out.length >= GENERATED_PLAYLIST_COUNT) break;` (1829-1846); `function generatedPlaylistById(id) { ... return generatedPlaylists().find(p => p.id === id) || null; }` (1849-1852); resolved at 9785 with a not-found page at 9792.",
  "fix_sketch": "Resolve a gen-<leaf> id deterministically from the catalogue alone, the way subjectItemsForBranch does for subjects. If the leaf exists and has at least GENERATED_PLAYLIST_MIN pool items, build that one playlist (newest first, excluding current slot items where possible) without applying the top-3 or slot-parent filters, which are only for choosing what Home shows.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main app.js and the finding holds. generatedPlaylists() (lines 1815-1848) filters leaves with `!slotBranches.has(n.parent)`, where slotBranches comes from state.cardSlots. It keeps only leaves with interest weight > 0, sorts them by weight, and stops at GENERATED_PLAYLIST_COUNT=3. generatedPlaylistById (1849-1852) just calls `generatedPlaylists().find(p => p.id === id)`. renderPlaylistDetail (9785) falls through to \"Playlist not found.\" (9792) when that returns null.\n\nbuildCards (1697-1753) re-deals up to 4 roots on every boot. It adds Math.random jitter, applies a recency penalty from cp_recent_branches, and picks a stretch branch. So on a reload or tab restore, or a native relaunch (relaunchRoute at 15383 restores LAST_ROUTE_KEY), `#/playlist/gen-<root>/<leaf>` stops resolving whenever that leaf's root is dealt this time. It also stops resolving whenever changed interests push the leaf out of the top 3, or below the 3-item minimum once slot items are excluded. Shared links fail the same way, since interests differ between listeners.\n\nThe subject route does handle this. subjectItemsForBranch (1778-1787) has an explicit catalogue fallback, and its comment says \"ANY REAL BRANCH IS ANSWERABLE\". The same audit added the gen-id encode/decode fix (2803-2811, 15136), which shows gen- routes are expected to be reloadable and reached from Jump back in. Nothing in docs/DECISIONS.md or the comments says the lookup is meant to be ephemeral. The D5/F14 comment says the list is \"resolvable by id for the detail page\", but that only holds within one deal. It is not handled elsewhere.\n\nSeverity is medium: the result is a broken page on reload or relaunch or from a shared link, but no data is lost.",
  "merged_ids": [],
  "lane": "L1-app-data"
}
```

## app-1-7: redealAfterOnboardingPicks undoes the first deal before that deal has been recorded when storage is still settling, and corrupts cp_recent_branches

**confirmed** · verifier severity **low** (finder: low) · app-1 · race-condition · `app.js:5578` · L1-app-data

```json
{
  "id": "app-1-7",
  "area": "app-1",
  "category": "race-condition",
  "title": "redealAfterOnboardingPicks undoes the first deal before that deal has been recorded when storage is still settling, and corrupts cp_recent_branches",
  "file": "app.js",
  "line": 5578,
  "severity": "low",
  "scenario": "buildCards records its deal through afterStorageSettles (1750-1753). While hydration is pending, that write is deferred. The first-run sheet opens over Home in that window, and 'Show my picks' runs redealAfterOnboardingPicks. It removes the last dealt.length entries from cp_recent_branches, but those are the previous session's entries, because the current deal has not been appended yet. It filters dealt ids out of a cp_seen that does not contain them yet, and then calls buildCards again. On settle both deferred closures fire, so the pre-pick deal is recorded as seen after all. That applies the -0.35 penalty and the seen demotion the redeal exists to avoid, and older legitimate history is deleted along the way.",
  "evidence": "`afterStorageSettles(() => { lsSet(\"cp_recent_branches\", lsGet(\"cp_recent_branches\", []).concat(dealtBranches).slice(-BRANCH_MEMORY)); rememberSeen(dealtIds); });` (1750-1753) vs `lsSet(\"cp_recent_branches\", recent.slice(0, Math.max(0, recent.length - dealt.length)));` (5578-5579) with no gate.",
  "fix_sketch": "Give each deal a token or epoch and have its deferred recorder skip when a newer deal has superseded it. The redeal then needs no undo of an unrecorded deal: it undoes only when the recorder has already run, which buildCards can flag on the slot set. At minimum, run the undo inside afterStorageSettles too, after the first deal's closure.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main:app.js and the core mechanism is real. buildCards (lines 1748-1753) records the deal inside afterStorageSettles. While storageWaiting() is true, that call only pushes the closure onto storageSettleWaiters (lines 303-306). Nothing cancels a queued closure, and markStorageSettled (lines 308-315) runs every queued closure in order.\n\nIn init(), `await storageP` is bounded at STORAGE_WAIT_MS (5s). If hydration overruns that, buildCards() at line 16591 runs with its recording deferred. route() then paints Home, which calls offerHomeOnboarding (line 9535), and the first-run sheet can open.\n\nredealAfterOnboardingPicks (lines 5573-5580) is ungated. It filters cp_seen and truncates cp_recent_branches right away, then calls buildCards again, which queues a second recorder. Once storage settles, both closures fire, so the pre-pick deal ends up in cp_recent_branches and cp_seen after all. That brings back the -0.35 penalty and the seen demotion that the function's own doc comment (lines 5556-5566) says the redeal exists to prevent. Nothing in the comment treats the settle-pending case as intended, and I found nothing else that handles it.\n\nThe history-corruption part is weaker than the finding claims. The sheet opens only when isGenuineFirstTimeUser() is true and cp_intro_dismissed is unset, so cp_recent_branches is usually empty or near-empty and the truncation usually deletes nothing. It can only delete real entries for a user who was dealt cards before but kept parking the sheet. Also, writes made before hydration may be overwritten when hydration lands anyway.\n\nThe trigger is narrow. It needs a first-run user whose storage hydration takes longer than 5s (the settle ceiling is 30s) and who taps \"Show my picks\" before it settles. The effect is a ranking penalty on the next deal, not data loss, so severity is low.",
  "merged_ids": [],
  "lane": "L1-app-data"
}
```

## app-1-9: With Continuous playback off, a finished episode is never removed from Up Next

**confirmed** · verifier severity **low** (finder: low) · app-1 · correctness · `app.js:2706` · L1-app-data

```json
{
  "id": "app-1-9",
  "area": "app-1",
  "category": "correctness",
  "title": "With Continuous playback off, a finished episode is never removed from Up Next",
  "file": "app.js",
  "line": 2706,
  "severity": "low",
  "scenario": "The Up Next model says the finished episode leaves Up Next (Apple parity), and that removal happens only in nextAfterEnded. advanceQueueOnEnded returns before reaching it when cp_autoadvance is false. A listener with continuous playback off who plays row 1 from Up Next and lets it finish still sees that row at the top with ▶. If they later turn continuous playback on, or press ⏭, planAfterEnded picks it as queuedNext and replays an episode they already finished.",
  "evidence": "`function advanceQueueOnEnded(id) { if (!autoAdvanceOn()) return; return playNextAfter(id, \"autoadvance\"); }` (2705-2708). The only removal is `if (plan.rest) saveQueueIds(plan.rest);` inside nextAfterEnded (2618).",
  "fix_sketch": "Always apply the removal: `const plan = planAfterEnded(id); if (plan.rest) saveQueueIds(plan.rest); if (!autoAdvanceOn()) { refreshEpisodeNavigation(); return; }`, then chain. Add a test for the off-switch case.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main app.js and the finding holds. At line 2705, advanceQueueOnEnded(id) does `if (!autoAdvanceOn()) return;` before it calls playNextAfter, then nextAfterEnded, then `if (plan.rest) saveQueueIds(plan.rest)` (line 2618). No other ended path removes the finished id from Up Next. onEpisodeEnded is wired only to advanceQueueOnEnded (line 16676). removeFromQueue (2338) runs only when the user taps dequeue (10456). playedFromUpNext moves the played row to the top and leaves it there, with the comment \"The played row stays until it ends\". So with cp_autoadvance off, the finished row stays at the top of Up Next.\n\nThis is not deliberate. The autoadvance comment (2490-2495) and DECISIONS.md 2026-09-14 describe cp_autoadvance only as the off-switch \"for anyone who wants silence at the end\". Separately, they say \"An episode that finishes leaves Up Next (Apple parity)\" and give the reason: \"Without the removal... would replay last week's finished list after any unrelated episode.\" DECISIONS.md line ~194 also says \"When c ends it leaves Up Next\". Nothing ties keeping the row to the off-switch. The bug is that the removal is nested inside the advance gate.\n\nOne part of the scenario is overstated. If the finished episode is still the player's current episode, ⏭ calls planAfterEnded(cur). That filters cur out of `rest`, so it would not replay that same episode. The stale head does get replayed in the realistic case: a later, different episode ends (or is skipped) with continuous playback on. Then queuedNext is the already-finished row, which is exactly the replay the comment warns about. The finished row also keeps showing at the top of Up Next with ▶.\n\nSeverity is low. It only affects users who turned continuous playback off, and the effect is a stale queue row or one wrong replay, not data loss. I did not run the test suite, because reading the code was enough.",
  "merged_ids": [],
  "lane": "L1-app-data"
}
```

## app-1-12: _bufferedEvents grows without bound for the session when the player module never loads

**confirmed** · verifier severity **low** (finder: low) · app-1 · resource-leak · `app.js:389` · L1-app-data

```json
{
  "id": "app-1-12",
  "area": "app-1",
  "category": "resource-leak",
  "title": "_bufferedEvents grows without bound for the session when the player module never loads",
  "file": "app.js",
  "line": 389,
  "severity": "low",
  "scenario": "If player/client.js 404s from a stale generation or throws, window.forayEventLog never exists. Every logEvent call then goes to the else branch and pushes into _bufferedEvents, and flushBufferedEvents never drains it. The session keeps every play, pick, queue and thumbs row in memory, and all of it is lost at close anyway.",
  "evidence": "`if (!storageWaiting() && window.forayEventLog && typeof window.forayEventLog.append === \"function\") {...} else { _bufferedEvents.push(row); }` (384-390).",
  "fix_sketch": "Cap the buffer (e.g. keep the last 500 rows) once deferredScriptsRan is true and no event log was published, or stop buffering then.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read app.js at origin/main and the code matches the finding. In logEvent (lines 384-390), if window.forayEventLog.append is missing, the row goes into `_bufferedEvents.push(row)`. flushBufferedEvents (398-409) returns early while the bridge is missing, so nothing ever drains the buffer. The buffer has no cap, and nothing clears it except the \"Delete my data\" path (line 13950).\n\nThe scenario can happen. index.html loads player/client.js as a `<script type=\"module\">` (line 122), and the app already has code for this exact failure: playerModuleFailed() (around line 10982) treats \"deferredScriptsRan && !window.ForayPlayer\" as a module that failed to fetch, parse or evaluate. So the authors expect it. That failure path does not stop buffering or bound it.\n\nThe storage-hydration ceiling (the storageWaiting/storageLate logic around line 251) only limits the storage wait. It does nothing when the module itself is absent. I found no comment or DECISIONS.md entry that makes unbounded growth deliberate. The comment on the buffer assumes the module will arrive and the buffer will be drained once. DECISIONS.md line 383 describes a 5000-event cap for the durable log (pruneToRetention(5000)), which this in-memory buffer does not follow.\n\nIt is low severity in practice:\n- Rows are small and only created by user actions.\n- With the player module gone, the app shows a module-failed state and playback cannot happen, so few play, queue or thumbs events can be logged.\n- Growth is limited to a single page lifetime.\n\nMemory use is realistically kilobytes, and the rows are lost at close anyway. Capping the buffer or stopping buffering once playerModuleFailed() is true would be a small hardening fix.",
  "merged_ids": [],
  "lane": "L1-app-data"
}
```

## app-1-13: branchChain sorts by `new Date(release_date || 0)`, so an unparseable date gives a NaN comparator: the bug dateValue() already fixed elsewhere

**confirmed** · verifier severity **low** (finder: low) · app-1 · correctness · `app.js:1670` · L1-app-data

```json
{
  "id": "app-1-13",
  "area": "app-1",
  "category": "correctness",
  "title": "branchChain sorts by `new Date(release_date || 0)`, so an unparseable date gives a NaN comparator: the bug dateValue() already fixed elsewhere",
  "file": "app.js",
  "line": 1670,
  "severity": "low",
  "scenario": "A malformed release_date in a pool item gives `Invalid Date - x = NaN`. Array.prototype.sort with an inconsistent comparator produces an engine-dependent order, so the Home card's lead episode for that branch can be arbitrary rather than the newest. dateValue() (2909-2912) was written for this exact case, and its comment says so, but branchChain was not migrated to it.",
  "evidence": "`const byRecency = (a, b) => new Date(b.release_date || 0) - new Date(a.release_date || 0);` (1670) vs `function dateValue(dateStr) { const t = dateStr ? new Date(dateStr).getTime() : NaN; return Number.isNaN(t) ? 0 : t; }` (2909).",
  "fix_sketch": "`const byRecency = (a, b) => dateValue(b.release_date) - dateValue(a.release_date);`",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "At origin/main, app.js:1670 is exactly `const byRecency = (a, b) => new Date(b.release_date || 0) - new Date(a.release_date || 0);`. It sorts the unseen, seen-not-played and played buckets in branchChain. For a present but unparseable string it gives Invalid Date, and subtracting gives NaN. dateValue() at 2909-2912 was written to fix this exact NaN case (its comment says so) and is used by episodesForShow (2918). branchChain was never switched over to it. Nothing in the comments or DECISIONS says the difference is on purpose.\n\nThe scenario is latent, though, not live. All 2167 items in data/discover.json on origin/main have a release_date that parses (0 missing, 0 unparseable). The pool producers, tools/refresh/scan.mjs:143 and backfill-show.mjs:207, write the date with `pub.toISOString().slice(0,10)`, and toISOString throws on an invalid Date, so the pipeline cannot write a malformed date. A missing date is already handled by `|| 0`.\n\nSo the code defect is real, the one-line fix is correct and matches the existing helper, and there is no user-visible effect with current data. Severity: low.",
  "merged_ids": [],
  "lane": "L1-app-data"
}
```

## app-1-14: prettyTitle drops every non-ASCII letter, so accented or non-Latin queries produce broken or generic playlist titles

**confirmed** · verifier severity **low** (finder: low) · app-1 · i18n · `app.js:1992` · L1-app-data

```json
{
  "id": "app-1-14",
  "area": "app-1",
  "category": "i18n",
  "title": "prettyTitle drops every non-ASCII letter, so accented or non-Latin queries produce broken or generic playlist titles",
  "file": "app.js",
  "line": 1992,
  "severity": "low",
  "scenario": "`split(/[^a-z0-9]+/)` treats é, ü, ñ and all non-Latin scripts as separators. 'Pokémon lore' becomes 'Pok Mon Lore', 'café culture' becomes 'Caf Culture', and a query in Japanese or Cyrillic becomes 'Playlist'. The saved playlist title is persisted, so the mangled name stays in Library.",
  "evidence": "`const raw = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);` (1992) and `w[0].toUpperCase() + w.slice(1)` (1995).",
  "fix_sketch": "Split on Unicode non-letters: `query.toLowerCase().split(/[^\\p{L}\\p{N}]+/u)`. Keep the stopword filter (ASCII words still match) and capitalise with `w.charAt(0).toLocaleUpperCase()`.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "At origin/main, app.js:1991-2001 has prettyTitle doing `query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)` and then `w[0].toUpperCase() + w.slice(1)`, with `|| \"Playlist\"` as the fallback. Because the split only keeps ASCII letters and digits, 'Pokémon lore' becomes 'Pok Mon Lore', 'café culture' becomes 'Caf Culture', and an all-Cyrillic or all-Japanese query leaves `raw` empty, so the title is 'Playlist'. The result is saved as `title: prettyTitle(query)` when the playlist is created (line 5121) and backfilled at line 2196. There is no rename feature, so the mangled title stays in Library. The comment block above the function covers only the word and character budget; it says nothing about wanting ASCII-only titles. docs/DECISIONS.md has nothing on this, and no other code fixes the title afterwards. Severity is low because it is cosmetic: the raw query is saved separately. Queries with no Latin text at all may not return results anyway if the search tokenizer is also ASCII-only, but accented Latin queries such as Pokémon or café can realistically produce a playlist with a broken title. The proposed fix (`/[^\\p{L}\\p{N}]+/u` plus `charAt(0).toLocaleUpperCase()`) is sound.",
  "merged_ids": [],
  "lane": "L1-app-data"
}
```

## app-1-15: retryCatalog repaints and refocuses whatever page is current when the retried fetch lands, even after the listener has left

**confirmed** · verifier severity **low** (finder: low) · app-1 · race-condition · `app.js:3183` · L2-app-surface

```json
{
  "id": "app-1-15",
  "area": "app-1",
  "category": "race-condition",
  "title": "retryCatalog repaints and refocuses whatever page is current when the retried fetch lands, even after the listener has left",
  "file": "app.js",
  "line": 3183,
  "severity": "low",
  "scenario": "The listener taps Try again on the failed Search/category list, then moves to Home or a show page before data/catalog-client.json answers (up to DATA_DEADLINE_MS). renderCurrentPage() re-renders that other page, which resets its scroll and discards in-page state such as a show page's in-progress search. pageDidPaint() then moves focus to its heading and announces it. races-7 fixed this for retryForayDocs, but this sibling retry was not changed.",
  "evidence": "`async function retryCatalog() { const catalog = await fetchJson(\"data/catalog-client.json\"); if (catalog) state.catalog = catalog; renderCurrentPage(); pageDidPaint(); }` (3180-3188).",
  "fix_sketch": "Capture `const isCurrent = renderToken()` (and the hash) before awaiting. After the await, update state.catalog but repaint only if the same render is still on screen.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The finding holds at origin/main. In app.js, lines 3180-3188, retryCatalog awaits fetchJson(\"data/catalog-client.json\") and then calls renderCurrentPage() and pageDidPaint() with no check that the page is still the same. fetchJson is bounded by a per-path deadline (15938-15950), so there is a real window of seconds in which the listener can navigate away. After that:\n- renderCurrentPage() (15108) rebuilds #view for whatever currentHash() now is. It also closes sheets inside #view, clears forayResume and bumps renderEpoch, so a show page's in-progress search input and its DOM state are thrown away.\n- pageDidPaint() calls landOnPage({navigated:false}). That only moves focus when the old focus left with the replaced DOM, and a repaint that wipes the focused input is exactly that case, so focus lands on the heading and the page is announced.\n\nThe sibling retryForayDocs (16068) was fixed for this in audit round 2, races-7. It captures renderToken() before the await and repaints only if stillHere(). Its comment describes this exact bug (\"used to renderCurrentPage() whatever was on screen... dropping that query and the keyboard\"). renderToken() (15400) already exists and would fix retryCatalog the same way.\n\nNothing marks the gap as deliberate. The only comment on retryCatalog is about nav-3 focus. Tests in test/navigation-memory.test.js:167-171 and test/load-states.test.js:235 cover only the same-page retry.\n\nSeverity stays low. It needs a failed catalog load, a tap on Try again, and navigating away before a slow or deadline-bounded response comes back. A repaint of Home with a newly loaded catalog is mostly harmless, apart from the lost scroll position and focus.",
  "merged_ids": [],
  "lane": "L2-app-surface"
}
```

## app-2-1: Home render overwrites the last-played episode's full itemIndex entry with the player's 7-field pointer, and it stays that way for the session

**confirmed** · verifier severity **medium** (finder: high) · app-2 · correctness/stale-state · `app.js:9293` · L2-app-surface

```json
{
  "id": "app-2-1",
  "area": "app-2",
  "category": "correctness/stale-state",
  "title": "Home render overwrites the last-played episode's full itemIndex entry with the player's 7-field pointer, and it stays that way for the session",
  "file": "app.js",
  "line": 9293,
  "severity": "high",
  "scenario": "Play an episode from a show page (it has publisher notes and chapters) or from the curated pool, then land on Home. That happens on every app open. Home calls lastEpisodeCard() twice per render, once via homePlayRails and once via jumpBackInV2Html, and each call runs snapshot(r.id, r) with no check on what is already stored. The pointer only carries id/title/show/artwork_url/audio_url/duration_min/duration_sec (player/episode-progress.js SNAPSHOT_FIELDS). So state.itemIndex[id] becomes {topics: [], description: null, chapters: null, release_date: null, explicit: null, show_id: null, hook: title}. fullPool() is now memoised (perf-10), so nothing re-snapshots and the entry does not recover. liveEpisode() returns itemIndex[id] for pool ids. Result: that episode's page (reached via 'Open episode' on the bar, or the Jump back in card) loses its notes, chapters, date, explicit badge and show link, and repeats the title as the hook line. Library rows lose their dates. Starring it writes the thin snapshot into cp_saved permanently, and boostTopics([]) does nothing. play_started logs topics: [], so the learning loop gets no signal for the episode the listener engages with most.",
  "evidence": "lastEpisodeCard(): `const r = player.lastEpisodeCard(); if (!r) return null; snapshot(r.id, r);`. Its sibling playerPointerEpisode (9879) already guards against this: `return state.itemIndex[r.id] || snapshot(r.id, r);` with the comment \"Never over a richer entry already in the index\". snapshot() always ends `state.itemIndex[id] = snap`, and liveEpisode reads `if (state.poolIds.has(id)) return state.itemIndex[id]`.",
  "fix_sketch": "In lastEpisodeCard, seed only when nothing is stored: `const item = state.itemIndex[r.id] || snapshot(r.id, r);` and pass `item` (or r) to the card. Add a regression test: a rich pool entry survives renderHomeV2 with a pointer for the same id.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the code at origin/main and the finding holds.\n\n- **The overwrite:** `lastEpisodeCard()` (app.js ~9284) calls `const r = player.lastEpisodeCard(); if (!r) return null; snapshot(r.id, r);` without checking what `state.itemIndex` already holds.\n- **What the pointer carries:** `player/client.js:3660` returns `{...rec, position_sec, percent, label}`, where `rec` comes from `readLastEpisode`. That record was built by `makeLastEpisode` using `episodeSnapshot`, which keeps only `SNAPSHOT_FIELDS = [id, title, show, artwork_url, audio_url, duration_min, duration_sec]` (`player/episode-progress.js:54`).\n- **What gets written:** `snapshot()` (app.js 897) always ends with `state.itemIndex[id] = snap`. From this pointer the entry comes out with `topics: []`, `hook: title`, and `show_id`, `description`, `chapters`, `release_date` and `explicit` all null.\n- **How often:** Home calls it on every render, through both `homePlayRails` (9041→9043) and `jumpBackInV2Html` (9222); each runs `jumpBackInEntries()`, which calls `lastEpisodeCard()`.\n- **Why it doesn't recover:** `fullPool()` is memoised on the `session`/`discover` identity (perf-10). A cache hit returns without re-snapshotting, so the pool entry stays thin until `state.discover` or `state.session` is replaced (a refresh). `hydrationPool()` only calls `fullPool` when `itemIndex` is empty.\n- **Who reads the thin entry:** `liveEpisode` returns `state.itemIndex[id]` for pool ids, and `resolveEpisode` returns `hydrationPool()[id]` first. So the episode page and other readers get the thin entry.\n- **The sibling guards; this one doesn't:** `playerPointerEpisode` (~9873) does `state.itemIndex[r.id] || snapshot(r.id, r)`, with the comment \"Never over a richer entry already in the index\". The docblock says `playerPointerEpisode` seeds \"exactly as lastEpisodeCard() seeds it\", which shows the unguarded version is an oversight, not a design choice.\n- **Is it deliberate?** No. The comment on the snapshot call only explains seeding for playback when the catalogue lacks the episode, and I found nothing saying an existing richer entry should be replaced.\n\n**Limits on impact:**\n- A show-page visit re-snapshots its rows, so the full data comes back until the next Home render.\n- A catalogue refresh rebuilds the pool.\n- The mini bar and playback itself still work, because `audio_url` is kept.\n- The damage is mostly lost display and ranking data (notes, chapters, date, explicit badge, topics signal) for the most-played episode. Starring it while it is thin writes the thin snapshot permanently.\n- I rate it medium rather than high: it is reliably triggered and visible, but it doesn't break playback or lose user data, apart from the star case.\n\n**Fix:** the proposed guard (`state.itemIndex[r.id] || snapshot(r.id, r)`) is correct and matches the sibling function.",
  "merged_ids": [],
  "lane": "L2-app-surface"
}
```

## app-2-2: Shows search paints every match with no cap: about 2,500 rows on the first keystroke, and the whole list is re-rendered on each later pass

**confirmed** · verifier severity **medium** (finder: medium) · app-2 · performance · `app.js:6932` · L2-app-surface

```json
{
  "id": "app-2-2",
  "area": "app-2",
  "category": "performance",
  "title": "Shows search paints every match with no cap: about 2,500 rows on the first keystroke, and the whole list is re-rendered on each later pass",
  "file": "app.js",
  "line": 6932,
  "severity": "medium",
  "scenario": "Type 't' in Search. localShowMatches calls SearchEngine.prefixSearchShows(query, showIndex) without a limit, and paintShowResults turns every row into markup through innerHTML. Measured against the committed data/show-index.tsv: 't' gives 2,497 prefix rows, 'th' 2,154, and 'the' 2,056 plus 1,099 more from the scan pass. 'pod' and 'dcast ' add about 2,500 scan rows on the debounce tick, and a shard pass can add thousands more (rankShardRows is uncapped too). appendShowResults / upgradeShowRows then rebuild the whole list's HTML up to about 6 times per query (scan, then the catalogue, directory and shard passes, each doing an upgrade and an append). mergeShowRows and upgradeShowRows run NFKD normalisation over every painted row on each pass. On a phone this is hundreds of milliseconds of main-thread work per keystroke and per pass, which is the jank the #684 work set out to remove. state.shardShowCache and state.breadthShowCache also gain an entry for every row and are never pruned.",
  "evidence": "`const fromIndex = SearchEngine.prefixSearchShows(query, showIndex)` (6932, limit defaults to 0 = all). `const scanned = SearchEngine.scanShowIndex(query, showIndex);` (7941). `results.innerHTML = shows.map(showResultRow).join(\"\")` (7486). The source's own comments say \"at one or two characters the local pass already returns 404-938 rows\".",
  "fix_sketch": "Cap what gets painted (for example the first 50 to 100 rows, with a 'Show more' button or incremental append), and pass a limit to prefixSearchShows/scanShowIndex/rankShardRows. Keep merges append-only by inserting only the new rows (insertAdjacentHTML) instead of rewriting innerHTML. Bound the breadth and shard show caches, or only seed the rows actually painted.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the code at origin/main and it does what the finding says.\n\n- app.js:6932 calls `localShowMatches` → `SearchEngine.prefixSearchShows(query, showIndex)` with no limit. In search-engine.js:2191 the signature is `limit = 0`, and 0 means all rows. `scanShowIndex` (search-engine.js:2210) also defaults to `limit = 0`, and `rankShardRows(query, rows)` (search-engine.js:2357) takes no limit at all.\n- `paintShowResults` (app.js:7445) does `results.innerHTML = shows.map(showResultRow).join(\"\")` over the full list, and nothing slices it first.\n- `appendShowResults` (app.js:7713) concatenates the rows already on screen with the new ones, then repaints the whole list through `paintShowResults`. The scan pass (7941), `mergeBreadth` (catalogue/directory) and the shard pass (8118-8121) all go through it. `mergeShowRows` and `upgradeShowRows` recompute `showDedupKeys` for every painted row on each pass.\n- `state.breadthShowCache` and `state.shardShowCache` are filled once per row received (7953, 8120) and are never pruned. The `SHARD_SHOWS_CAP` at 2882 bounds only the persisted remembered-shard map, not these in-memory caches.\n\nI ran the committed search-engine.js against data/show-index.tsv (10,113 rows) and got the finding's numbers exactly:\n\n| Query | Prefix rows | Scan rows |\n|---|---|---|\n| t | 2,497 | not run (scan needs 3+ characters) |\n| th | 2,154 | not run |\n| the | 2,056 | 1,099 |\n| pod | 22 | 2,512 |\n| dcast | 0 | 2,477 |\n\nIs it deliberate? Only partly. The comment above `appendShowResults` defends rewriting innerHTML wholesale instead of appending: it wants a single paint path, and the vm test stubs have no `insertAdjacentHTML`. The comment at 7917 acknowledges that 1-2 character queries return 404-938 rows locally (the real count is higher, up to 2,497 for 't'), but it uses that figure to justify the scan gate, not to argue for painting every row. I found no entry in docs/DECISIONS.md that rules out a cap on painted rows. So the rewrite-everything choice is intentional, but the missing cap is not justified anywhere.\n\nOn severity: it is a performance and jank problem, not a correctness or data-loss bug. The prefix and scan work took roughly 10-90 ms per query in Node on a desktop. Building thousands of rows of HTML through innerHTML, up to about 6 times per query, is where a phone would lose most of its time. That fits medium.",
  "merged_ids": [],
  "lane": "L2-app-surface"
}
```

## app-2-3: Leaving the Search page does not supersede its passes, so the debounce tick, three fetches and the multi-second playlist-CTA scan still run on the next page

**confirmed** · verifier severity **medium** (finder: medium) · app-2 · race/performance · `app.js:8268` · L2-app-surface

```json
{
  "id": "app-2-3",
  "area": "app-2",
  "category": "race/performance",
  "title": "Leaving the Search page does not supersede its passes, so the debounce tick, three fetches and the multi-second playlist-CTA scan still run on the next page",
  "file": "app.js",
  "line": 8268,
  "severity": "medium",
  "scenario": "On a cold start, type 'fridman'. Results paint and the Playlists section shows 'Still looking for playlists…' while whenIdle waits on searchDataSettled(). Tap a show result. showSearchToken is only bumped by a keystroke, a new Search mount (3665) or dismissShowSearch (3464), never by navigating away. So once the search documents land, the callback's `myToken !== showSearchToken` check still passes and createPlaylistCtaHtml -> topicSearchStatus runs the relaxation scan (documented at 1.3 to 8 s cold) on the main thread over the show page the listener just opened, then writes into a detached container. Likewise a debounce tick still pending when the listener taps away fires runShowSearchCostly: up to 3 network requests plus the index scan (up to 139 ms median) for a page no longer on screen.",
  "evidence": "`whenIdle(() => searchDataSettled().then(() => { if (myToken !== showSearchToken) { reportCtaMs(null); return; } ... cta = createPlaylistCtaHtml(query); ...` (8268-8274). A grep shows no reference to showSearchToken or showSearchDebounceTimer outside the search section except a comment.",
  "fix_sketch": "Call supersedeShowSearch() when the router leaves #/shows (the same place closeSheetsWithin runs before a render), or guard the debounce tick and the CTA callback with renderToken() / a check that the container is still connected (`container.isConnected`).",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the code at origin/main and the finding holds. The only calls to supersedeShowSearch() (6793) come from dismissShowSearch (3464) and a new Search mount (3665). The token is also bumped by a keystroke (8144) and by a submit (8182). renderCurrentPage (around 15105) is the router's render-for-navigation path. It runs closeSheetsWithin, bumps renderEpoch and resets fbTarget and forayResume, but it never touches showSearchToken or showSearchDebounceTimer. renderToken() only reads renderEpoch, and no search path consults it.\n\nThe CTA path works as described. renderPlaylistSearchResults captures `container` synchronously. It then calls whenIdle(() => searchDataSettled().then(...)) (8268), and the only guard inside is `myToken !== showSearchToken` (8269). That check still passes after the listener taps a show result. createPlaylistCtaHtml then runs topicSearchStatus, then scoredResultsFor, then SearchEngine.searchWithRelaxation (5096/5088). That is the scan the file's own comment documents at 1.3 to 8 s cold. It runs on the main thread while the show page is open, then writes into the detached container.\n\nThe pending 250 ms debounce tick (8151) is also only token-guarded, so tapping away inside that window still fires runShowSearchCostly with its fetches and index scan.\n\nSome mitigations exist, but none refutes the finding. The scan result is memoized in searchCache, so it is not fully wasted if the listener goes back to the same query. Paints that re-query the DOM with $() may no-op on the new page. Nothing in DECISIONS.md or the comments makes this deliberate. The comment on supersedeShowSearch even says it is meant to be called \"when the page that owned them is replaced\", and the router misses that case.\n\nReal impact: on the common path (a cold start and a show-name query that matches no playlist), the listener gets a multi-second main-thread freeze on the page they just opened. Medium fits. I did not run a test.",
  "merged_ids": [],
  "lane": "L2-app-surface"
}
```

## app-2-4: Starting an episode from a chapter or timestamp tap skips startEpisodePlay: no History entry, no play_started event, and the previous list's ⏮/⏭ chain stays in place

**confirmed** · verifier severity **medium** (finder: medium) · app-2 · correctness · `app.js:10210` · L2-app-surface

```json
{
  "id": "app-2-4",
  "area": "app-2",
  "category": "correctness",
  "title": "Starting an episode from a chapter or timestamp tap skips startEpisodePlay: no History entry, no play_started event, and the previous list's ⏮/⏭ chain stays in place",
  "file": "app.js",
  "line": 10210,
  "severity": "medium",
  "scenario": "Play episode A from a playlist, then open episode B's page and tap a chapter row or a timestamp in the notes. bindEpisodeSeeks calls window.ForayPlayer.play(item, {startOffset}) directly. It never calls recordHistory(B), so B never appears in Library > History or counts toward hasOpened/'N played'. It never logs play_started, so interest learning gets nothing. It never calls setPlayList, so state.playList/playChainId still describe A's playlist: continuous playback after B, and the ⏮/⏭ state from refreshEpisodeNavigation, work from the stale chain. startEpisodePlay's own header says it is the one start path so every control inherits these rules. There is also an isPlaying vs isCurrent mismatch: a current-but-paused episode gets a fresh play() instead of the seek the comment describes.",
  "evidence": "`if (!window.ForayPlayer.isPlaying(item.id)) { const ok = await window.ForayPlayer.play(item, { why: whyFor(item.id, item), startOffset: secs }); ... return; } await window.ForayPlayer.seekTo(secs);`. recordHistory is called only at 2740, 5161 and 5280, and setPlayList only at 5249.",
  "fix_sketch": "Route the non-current case through startEpisodePlay(item.id, item, { ctx: null, list: [] }) with a startOffset option added to it, so history, the event, the play list and failure reporting are shared. Use isCurrent to decide between 'seek only' and 'start'.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read app.js at origin/main and the core claim holds. In bindEpisodeSeeks (around line 10186-10240), when the episode is not playing, the handler calls window.ForayPlayer.play(item, { why, startOffset: secs }) directly and returns. It never calls logEvent(\"play_started\"), recordHistory or setPlayList. Only startEpisodePlay (line 5241) does all three, at lines 5249, 5279 and 5280, plus the auto-advance path at 2739/2740. player/client.js has no cp_history, play_started or recordHistory logic of its own, so nothing else makes up for it.\n\nThe scenario is easy to hit: tap a chapter row or a timestamp on an episode page that is not the current one. The episode then never lands in Library > History or the hasOpened/played counts, and interest learning never gets the event. startEpisodePlay's header says it is the start path \"from any in-app control\". The seek binding's comments explain only its play-then-seek ordering and startOffset. They give no reason to skip history or the event, and DECISIONS.md says nothing on this. So it is an oversight, not a deliberate choice.\n\nTwo parts of the finding are overstated:\n1. The stale chain is partly handled. setPlayList's comment and planAfterEnded continue the list only while the ending episode is the one the chain started (playChainId). So when B ends, playback most likely stops rather than running on through A's list. Only the ⏮/⏭ state from refreshEpisodeNavigation may stay stale, because setPlayList, which calls it, is never run.\n2. On isPlaying vs isCurrent: ForayPlayer.isPlaying(id) is false for a current but paused episode, so a paused-current episode gets a fresh play() at the stamp instead of a seek. That contradicts the comment, but the listener still lands at the timestamp, so the harm is small.\n\nOverall, the missing history and play_started event are real and visible to users, which makes this medium severity. I did not run a test.",
  "merged_ids": [],
  "lane": "L2-app-surface"
}
```

## app-2-5: loadShowIndex bounds only the response headers; a stalled body leaves showIndexPromise pending for the whole session (incomplete fix of states-4)

**confirmed** · verifier severity **low** (finder: medium) · app-2 · error-handling · `app.js:6879` · L2-app-surface

```json
{
  "id": "app-2-5",
  "area": "app-2",
  "category": "error-handling",
  "title": "loadShowIndex bounds only the response headers; a stalled body leaves showIndexPromise pending for the whole session (incomplete fix of states-4)",
  "file": "app.js",
  "line": 6879,
  "severity": "medium",
  "scenario": "On a captive portal or a cell dead zone, the index request gets its 200 headers inside DATA_DEADLINE_MS and then the body stalls. withDeadline wraps only fetch(), so `await res.text()` has no bound and the abort controller is never fired. The finally that clears showIndexPromise never runs, every later focus is handed the same hung promise, and the 10k-row index never loads for the session. That is exactly what states-4's fix claims it prevents ('a later focus retries'). fetchShardRows and fetchApiJson do put the body read inside the deadline.",
  "evidence": "`const res = await withDeadline(fetch(SHOW_INDEX_PATH, ...), DATA_DEADLINE_MS, () => { ctl.abort(); return null; }); if (!res || !res.ok) return null; const parsed = SearchEngine.parseShowIndex(await res.text());`",
  "fix_sketch": "Wrap fetch plus res.text() in one async function and put the deadline around that (as fetchApiJson does), aborting the controller on expiry.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main:app.js at lines 6860-6893. loadShowIndex wraps only `fetch(...)` in withDeadline, then runs `SearchEngine.parseShowIndex(await res.text())` outside it. withDeadline (line 15994) races the fetch promise against a timer and clears the timer once the fetch resolves. Headers are enough to resolve fetch, so a body that stalls after the 200 headers leaves `await res.text()` with no bound, and ctl.abort() never fires. Until the stack gives up on the socket, which can take a very long time, the `finally` that sets showIndexPromise = null does not run, and every later call to loadShowIndex gets the same pending promise.\n\nfetchJson and fetchApiJson (lines 15941 and 15965) do put `res.json()` inside the deadlined `attempt`, so the finding's contrast holds. It also contradicts the states-4 comment in the same function (\"the promise clears, and the next focus asks again\"). I found nothing in DECISIONS.md or the comments that makes this deliberate, and nothing else handles it: there is no service worker handling for show-index.\n\nWhy low rather than medium: per the header's rule 3, a missing index is a handled, degraded state. localShowMatches falls back to the curated 220 and the debounced breadth API still answers, so search keeps working. The bug also needs a body stall after the headers arrive, which is narrower than a stall before any response. The fix sketch is right: move res.text() inside one deadlined async attempt, as fetchApiJson does.",
  "merged_ids": [],
  "lane": "L2-app-surface"
}
```

## app-2-6: Clearing or changing a thumbs vote never reverses its interest nudge, so up, clear, up repeated drives a topic to 1.0

**confirmed** · verifier severity **low** (finder: low) · app-2 · correctness · `app.js:11049` · L2-app-surface

```json
{
  "id": "app-2-6",
  "area": "app-2",
  "category": "correctness",
  "title": "Clearing or changing a thumbs vote never reverses its interest nudge, so up, clear, up repeated drives a topic to 1.0",
  "file": "app.js",
  "line": 11049,
  "severity": "low",
  "scenario": "Tap 👍 on a Foray beat: nudgeTopics(+0.08). Tap it again to clear it: setFeedback(entry, null) deletes the vote but applies no opposite nudge and logs no event. Tap 👍 again: another +0.08. About 13 taps pin the topic at 1.0, reshaping Home's rails. Changing up to down with a non-subject reason ('Bad audio quality') also leaves the +0.08 in place. The event log only ever sees the 'up', never the retraction, so any server-side learning job counts retracted votes.",
  "evidence": "`if (!direction) delete all[segId]; else all[segId] = {...}; ... if (direction) { logEvent(\"thumbs\", ...); if (direction === \"up\" || reasons.some(r => TOPIC_REASONS.has(r))) nudgeTopics([entry.topic], direction === \"up\" ? 0.08 : -0.08); }`",
  "fix_sketch": "Read the previous vote before writing. Undo its nudge (apply the opposite amount if it moved interests) before applying the new one, and log a 'thumbs' event with direction 'cleared' when a vote is removed.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main:app.js and the finding holds. setFeedback (line 11023) runs `if (!direction) delete all[segId]` and does nothing else when a vote is cleared. The logEvent(\"thumbs\") call and the nudgeTopics call both sit inside `if (direction)`, so a clear never reverses the old nudge and never logs an event. The click handler at line 11460 clears the vote when you tap the thumb that is already on (`if (current === dir) return setFeedback(entry, null)`), and the next tap on 'up' goes straight to setFeedback(entry, 'up') and applies another +0.08. Tapping up, then again to clear, then up again therefore adds 0.08 each round. nudgeTopics (line 725) caps the value at 1 and also pushes the parent topic by PARENT_NUDGE_RATIO, so repeated taps pin the topic at 1.0. The finding's second case also holds: changing up to down with only non-subject reasons skips the nudge, so the earlier +0.08 stays. Down with a subject reason applies -0.08, which cancels it. The server learning job reads 'thumbs' events, and each re-vote logs a new 'up', so retracted votes are counted too. Nothing in docs/DECISIONS.md or the code comments says clearing a vote should leave its nudge in place. The comment at line 11458 only explains why a clear does not reopen the sheet. Severity is low: the effect is limited to one user's own localStorage interest profile, the user has to do it on purpose, and the result is Home rails ranked differently, with no data loss or security impact. The duplicated server-side learning signal is the more lasting part.",
  "merged_ids": [],
  "lane": "L2-app-surface"
}
```

## app-2-7: Episode-notes timestamp guard uses the rounded duration_min and ignores duration_sec, so real chapter stamps in the last minute render as dead text

**confirmed** · verifier severity **low** (finder: low) · app-2 · correctness/units · `app.js:10144` · L2-app-surface

```json
{
  "id": "app-2-7",
  "area": "app-2",
  "category": "correctness/units",
  "title": "Episode-notes timestamp guard uses the rounded duration_min and ignores duration_sec, so real chapter stamps in the last minute render as dead text",
  "file": "app.js",
  "line": 10144,
  "severity": "low",
  "scenario": "An episode has duration_sec = 3569 (59:29), and every producer sets duration_min = Math.round(sec/60) = 59, so durationSec becomes 3540. A chapter line '59:10 Outro' (3550 s) fails `secs > durationSec` and renders as plain text instead of a seek row. rowProgress already prefers duration_sec, and the Now Playing sheet shares the same tokeniser, so the two surfaces can disagree.",
  "evidence": "`const durationSec = item.duration_min ? item.duration_min * 60 : null;` vs rowProgress: `Number(item.duration_sec) > 0 ? Number(item.duration_sec) : (Number(item.duration_min) > 0 ? ... * 60 : null)`",
  "fix_sketch": "Use `Number(item.duration_sec) > 0 ? Number(item.duration_sec) : (item.duration_min ? item.duration_min * 60 + 59 : null)`, or share one helper with rowProgress.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The finding holds at origin/main. Line 10144 of app.js, in episodeDescriptionSectionHtml, reads `const durationSec = item.duration_min ? item.duration_min * 60 : null;` and never looks at duration_sec. The producers at lines 3840 and 8655/8680 set `duration_min = Math.round(duration_seconds/60)`, so an episode of 3569 s gets duration_min 59 and a guard of 3540. descChapterToken (line 10035) rejects `secs > durationSec`, and episodeDescriptionTokens (line 10103) uses the same inRange check. That means a '59:10 Outro' line (3550 s) renders as dead text. The fault only appears when the seconds round down, which puts the stamp within the last 29 seconds of the episode.\n\nThis is not deliberate. docs/DECISIONS.md (2026-09-23, \"One duration dialect\") says \"An episode's length is its duration_sec when it has one\", and episodeMinutes (line 1313) and rowProgress (line 9652) both prefer duration_sec. The comment on episodeDescriptionHtml presents the guard as an honesty check against stamps past the real end, and a rounded-down minute count defeats that intent.\n\nNothing else covers the gap. The Now Playing sheet (player/client.js around line 2027) calls the shared tokeniser with episodeDurationSec(), the player's actual duration, so the two surfaces can disagree about the same stamp. Severity is low: it only hits stamps in the final seconds of an episode (outro chapters), the stamp is still shown as text, and nothing crashes.",
  "merged_ids": [],
  "lane": "L2-app-surface"
}
```

## app-2-8: Linkifier cuts URLs that end in ')' , so Wikipedia-style links in show notes open the wrong page

**confirmed** · verifier severity **low** (finder: low) · app-2 · correctness · `app.js:9969` · L2-app-surface

```json
{
  "id": "app-2-8",
  "area": "app-2",
  "category": "correctness",
  "title": "Linkifier cuts URLs that end in ')' , so Wikipedia-style links in show notes open the wrong page",
  "file": "app.js",
  "line": 9969,
  "severity": "low",
  "scenario": "Notes contain https://en.wikipedia.org/wiki/Mercury_(planet). The last character class excludes ')', so the link becomes .../Mercury_(planet: a broken or wrong article. The ')' is left as trailing text.",
  "evidence": "`const DESC_TOKEN_RE = /(https?:\\/\\/[^\\s<>\"']*[^\\s<>\"'.,;:)\\]}])|.../g;`",
  "fix_sketch": "After matching, keep a trailing ')' when the URL has an unbalanced '(' (the usual GFM autolink rule), and trim it otherwise.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "At origin/main, app.js:9969 is `const DESC_TOKEN_RE = /(https?:\\/\\/[^\\s<>\"']*[^\\s<>\"'.,;:)\\]}])|.../g`. I ran the URL part of the regex in node on \"see https://en.wikipedia.org/wiki/Mercury_(planet) now\" and it matched 'https://en.wikipedia.org/wiki/Mercury_(planet'. That drops the closing ')'. episodeDescriptionTokens (around line 10096) uses m[1] as the href with only safeUrl() applied and never re-attaches a ')' when the '(' is unbalanced, so the ')' is left as plain text. Nothing else handles this case. The comment above the regex says leaving out trailing `.,;:)]}` is deliberate, but its stated reason is sentence punctuation (\"the full stop belongs to the sentence\"). It never mentions balanced parentheses in a URL, and docs/DECISIONS.md has nothing on linkifying or parentheses. So the Wikipedia breakage is a side effect nobody chose, not a decision. The effect is small: a wrong or missing page when someone taps a paren-ending link in show notes. Severity low.",
  "merged_ids": [],
  "lane": "L2-app-surface"
}
```

## app-2-9: 'Shows 4a vouches for' is not deterministic across locales: the base order uses a locale-sensitive localeCompare

**confirmed** · verifier severity **low** (finder: low) · app-2 · correctness/locale · `app.js:6659` · L2-app-surface

```json
{
  "id": "app-2-9",
  "area": "app-2",
  "category": "correctness/locale",
  "title": "'Shows 4a vouches for' is not deterministic across locales: the base order uses a locale-sensitive localeCompare",
  "file": "app.js",
  "line": 6659,
  "severity": "low",
  "scenario": "The comment promises every visitor sees the same set on the same day and that tests can pin it. Sorting the committed catalog-client.json ids with localeCompare gives a different base order under the lt, et and cs locales than under en/codepoint order (verified with Node Intl). The seeded shuffle then picks different shows for listeners with those device locales. CI runs in en, so the tests cannot catch it.",
  "evidence": "`.sort((a, b) => a.show_id.localeCompare(b.show_id));`",
  "fix_sketch": "Use a codepoint comparison: `(a, b) => (a.show_id < b.show_id ? -1 : a.show_id > b.show_id ? 1 : 0)`.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "At origin/main, app.js showsWeVouchFor sorts with `.sort((a, b) => a.show_id.localeCompare(b.show_id))` before seededShuffle. With no locale argument, localeCompare uses the runtime's default locale, which in a browser is the user's locale. The comment above it promises a deterministic base order so every visitor gets the same result and tests can pin it. I tested the 220 editorially-noted show_ids in data/catalog-client.json at origin/main with Node Intl. The sorted order matches codepoint order under en, sv, da, tr, de, fi, hu, pl and ja, but differs under lt, et, cs and sk (the finding missed sk). These languages have their own collation rules, such as the \"ch\" digraph in cs/sk and where \"y\" and \"z\" sort in lt/et. seededShuffle permutes by position, so a different base order gives different picks for those users. Tests pass a fixed `now` but run under the CI locale, so they cannot catch this. DECISIONS.md says nothing about locale collation. The same pattern appears elsewhere (for example line 4063, similarShows's show_id tiebreak), but nothing handles it. The impact is cosmetic: a small group of Lithuanian, Estonian, Czech and Slovak users see a different daily set of vouched shows. Severity is low.",
  "merged_ids": [],
  "lane": "L2-app-surface"
}
```

## app-2-10: Panel drag-to-dismiss doesn't capture the pointer; a mouse release off the panel leaves the drag stuck

**confirmed** · verifier severity **low** (finder: low) · app-2 · correctness · `app.js:6054` · L2-app-surface

```json
{
  "id": "app-2-10",
  "area": "app-2",
  "category": "correctness",
  "title": "Panel drag-to-dismiss doesn't capture the pointer; a mouse release off the panel leaves the drag stuck",
  "file": "app.js",
  "line": 6054,
  "severity": "low",
  "scenario": "On desktop (or anything that isn't touch), press on a .fy-panel and drag down fast enough that the pointer leaves the panel, then release over the scrim or outside the window. The panel never gets pointerup (there is no implicit capture for mouse), so `pointer` stays set and `drag` non-null. The panel stays displaced with .fy-panel-dragging, and every later pointerdown is ignored (`pointer != null`) until a pointercancel that may never come.",
  "evidence": "`panel.addEventListener(\"pointerdown\", (e) => { ... drag = g.start(...); pointer = e.pointerId; });` with no setPointerCapture. The Foray strip already does `strip.setPointerCapture(pointerId)` (12189).",
  "fix_sketch": "Call `panel.setPointerCapture?.(e.pointerId)` in pointerdown (in a try/catch), and handle `lostpointercapture` the same way as pointercancel.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read bindPanelDrag at origin/main (app.js around lines 6038-6103). pointerdown sets `drag = g.start(...)` and `pointer = e.pointerId` and never calls setPointerCapture. pointermove, pointerup and pointercancel are all listeners on the panel element itself. Nothing listens on the document or window, and there is no lostpointercapture or pointerleave handler. The only setPointerCapture in app.js is the Foray strip's (line 12189). Nothing in docs/DECISIONS.md or in any code comment makes the missing capture deliberate.\n\nWith a mouse, the browser does not capture the pointer implicitly. If the button is released over the scrim or outside the window, the panel never gets pointerup, and a mouse does not fire pointercancel. So `drag` and `pointer` stay set. The panel keeps its --fy-panel-dy offset and the .fy-panel-dragging class, and every later pointerdown hits the `pointer != null` guard and returns early. The state lives in the closure, which is bound once (`_dragBound`), and I found no close path that resets it, so the stuck state survives closing and reopening the panel.\n\nTouch pointers are captured implicitly, so on a phone this doesn't happen. That limits it to desktop mouse or pen, a secondary surface for this app, so the severity stays low. The suggested fix (call setPointerCapture in a try/catch, and treat lostpointercapture the same as pointercancel) matches what the strip already does.",
  "merged_ids": [],
  "lane": "L2-app-surface"
}
```

## app-2-11: Search CTA hands off to Create through location.hash plus setTimeout(0), racing the hashchange render

**confirmed** · verifier severity **low** (finder: low) · app-2 · race · `app.js:8347` · L2-app-surface

```json
{
  "id": "app-2-11",
  "area": "app-2",
  "category": "race",
  "title": "Search CTA hands off to Create through location.hash plus setTimeout(0), racing the hashchange render",
  "file": "app.js",
  "line": 8347,
  "severity": "low",
  "scenario": "Tapping 'Create a playlist about X' sets location.hash and queues a 0 ms timer that expects #cr-form to exist. hashchange is a separate queued task with no guaranteed order relative to a 0 ms timer, and on a slow WebView the route render may not have run. When the timer wins, `$(\"#cr-input\")` is null, the handler returns silently, and the listener lands on an empty Create page.",
  "evidence": "`location.hash = \"#/create\"; setTimeout(() => { const input = $(\"#cr-input\"); const form = $(\"#cr-form\"); if (!input || !form) return; ... }, 0);`",
  "fix_sketch": "Stash the pending query in module state (for example pendingCreateQuery) and have renderCreate consume it after binding the form, instead of relying on task ordering.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The code at origin/main matches the finding. In app.js lines 8342-8356, bindCreatePlaylistCta sets `location.hash = \"#/create\"` and then calls `setTimeout(() => { const input = $(\"#cr-input\"); const form = $(\"#cr-form\"); if (!input || !form) return; ... }, 0)`. #cr-form and #cr-input are created only by renderCreate() (line 10775). renderCreate() runs only when route() (line 15225) is called by the `hashchange` listener (line 16716), and route() does that render synchronously through renderCurrentPage() at line 15169. No other code paths hand off the query: there is no pendingCreateQuery or anything like it.\n\nThe comment above the function (lines 8333-8341) says the hashchange handler \"runs after this click handler returns\" and treats the 0 ms timer as coming after it. The HTML spec does not promise that order. The spec queues hashchange as a task on the DOM manipulation task source, and a timer callback belongs to the timer task source. The order between different task sources is up to each browser. So the comment's reasoning is wrong, and the timer running first is allowed by the spec. If it does, `$(\"#cr-input\")` is null, the guard returns without doing anything, and the listener lands on an empty Create page with no prefill and no build. Also, route() returns early when `!state.ready`, which is another way the elements can be missing.\n\nIn practice, current Chromium and WebKit usually run the queued hashchange before a 0 ms timer, so this will rarely happen, and when it does the only result is a lost convenience (the user can retype the subject). The comment shows the ordering was intended, but it was intended on a false assumption; I found no entry in DECISIONS.md or elsewhere that makes this safe. I did not run a test, because a jsdom run would not settle task-source ordering in a real WebView. The fix sketch holds up: stash the query in module state and have renderCreate consume it after binding the form. That removes the dependence on task order. The severity stays low.",
  "merged_ids": [],
  "lane": "L2-app-surface"
}
```

## app-2-12: Home computes every rail twice per render, including generatedPlaylists' full-pool scan and sort

**confirmed** · verifier severity **low** (finder: low) · app-2 · performance · `app.js:9041` · L2-app-surface

```json
{
  "id": "app-2-12",
  "area": "app-2",
  "category": "performance",
  "title": "Home computes every rail twice per render, including generatedPlaylists' full-pool scan and sort",
  "file": "app.js",
  "line": 9041,
  "severity": "low",
  "scenario": "Each renderHomeV2 calls homePlayHtml() -> homePlayRails(), which runs jumpBackInEntries (resolveParts plus a position-store read per row of every played playlist), foraysForYouPicks, playlistsForYouPicks (generatedPlaylists walks the whole ~2,100-item pool and sorts per leaf) and every subject queue. The rails then run all of these again. The intro popup calls foraysForYouPicks a third time. Home re-renders on directory refresh, onboarding redeal and returns to Home.",
  "evidence": "homePlayRails: `rails.push(jumpBackInEntries()...); const forays = foraysForYouPicks(); ... const { own, generated } = playlistsForYouPicks();` then renderHomeV2 calls `${homePlayHtml()} ... ${jumpBackInV2Html()} ${foraysForYouHtml()} ${playlistsForYouHtml()}`, each of which recomputes.",
  "fix_sketch": "Compute the picks once in renderHomeV2 and pass them to both homePlayTarget and the rail renderers.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main app.js and the finding holds. renderHomeV2 (line 9521) calls homePlayHtml(), which calls homePlayTarget(), which calls homePlayRails() (line 9041). homePlayRails builds every rail up front, before homePlayTarget starts looking for the first playable entry. That means it runs jumpBackInEntries() (resolveParts on each played playlist), foraysForYouPicks(), and playlistsForYouPicks(). playlistsForYouPicks calls generatedPlaylists() (line 1817), which buckets the whole poolFiltered() pool by topic and sorts each leaf's items. The same render then calls jumpBackInV2Html, foraysForYouHtml and playlistsForYouHtml, and each one recomputes its picks.\n\nThe comments on playlistsForYouPicks and foraysForYouPicks say the picks were shared so the button and the rails can't disagree. That covers keeping them consistent, not computing them twice, and nothing caches the results.\n\nOne detail in the finding is wrong. The subject queues (subjectQueueById per cardSlot) are computed only inside homePlayRails. suggestedHtml reads state.cardSlots directly, so that part runs once, not twice. The intro-popup call at line 6544 is a third call only when the popup actually shows.\n\nThe cost is a repeated O(pool) scan plus sorts on each Home render, and renders are infrequent. It wastes work but produces no wrong output, so severity is low.",
  "merged_ids": [],
  "lane": "L2-app-surface"
}
```

## app-2-13: Foray route links interpolate ids without encodeURIComponent, which has drifted from the other producers

**confirmed** · verifier severity **low** (finder: low) · app-2 · duplicated-logic-drift · `app.js:9396` · L2-app-surface

```json
{
  "id": "app-2-13",
  "area": "app-2",
  "category": "duplicated-logic-drift",
  "title": "Foray route links interpolate ids without encodeURIComponent, which has drifted from the other producers",
  "file": "app.js",
  "line": 9396,
  "severity": "low",
  "scenario": "forayCardV2Html, forayCreditHtml (11164) and citesHtml (11252) build `#/foray/${esc(id)}` / `#/show/${esc(showId)}`. showResultRow, jumpBackInCardHtml, libraryForaysHtml and playlistRoute all encodeURIComponent the id. An id containing '/', '#', '?' or '%' (playlistRoute's header records this exact bug for 'gen-history/technology') breaks routing or throws in the router's decode, but only from these three surfaces.",
  "evidence": "`<a class=\"hv2-foray-card...\" href=\"#/foray/${esc(foray.id)}\">` vs Library: `libSummaryRow(`/foray/${encodeURIComponent(f.id)}`, ...)`",
  "fix_sketch": "Add foray and show route helpers (like playlistRoute) that encode, and use them at every producer.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The inconsistency is real at origin/main, but the failure the finding describes can't happen with today's data, and one part of its claim is wrong.\n\nWhat holds:\n- app.js:9396 (forayCardV2Html) builds `href=\"#/foray/${esc(foray.id)}\"`. app.js:11164 (forayCreditHtml) and app.js:11252 (citesHtml) build `#/show/${esc(showId)}`. None of them call encodeURIComponent.\n- Other producers do encode: showResultRow at 6604 and 1605, jumpBackInCardHtml at 9344 (`esc(encodeURIComponent(c.id))`), libraryForaysHtml at 10542, playlistRoute at 2810, and showRouteHash at 4290.\n- The drift is wider than the three surfaces named. More unencoded producers exist at 3073 (show-link), 4122 (show-forays-row), 11557 (fy-credit outerHTML), 12976 (fy-home-row) and 13094 (fy-jbi-row).\n- The code states the rule this breaks. The comment on parseShowRoute (4277) says \"An id never carries a raw `/`: every producer encodes it\", and that is false for the show producers above. The playlistRoute header records the same kind of bug for playlists. So this is not deliberate; it is the drift the audit comments say they fixed.\n\nWhat is refuted:\n- \"Throws in the router's decode\" is wrong. forayRouteId (15066) and parseShowRoute both use safeDecode, which catches the URIError and returns \"\". A bad id falls through to the home screen, or to not-found for a show; the router does not throw.\n- The scenario can't happen with current data. All 7 top-level foray ids in data/forays.json are plain slugs with no `/ # ? % & space`, and so are all 220 show ids in data/catalog-client.json. Search-result show ids have the `pi:<n>` shape, and a `:` survives in a hash unencoded. So no link is broken today.\n\nThis is a latent consistency and hardening issue. A route helper would prevent a future \"Episode not found\"-style bug like the one documented at the episode route. It is not a live defect, so severity is low.",
  "merged_ids": [],
  "lane": "L2-app-surface"
}
```

## app-3-1: Foray page Play after the mini bar is closed restarts from the resume point captured at render time (or from 0), not from where the listener stopped, and then writes over their stored progress

**confirmed** · verifier severity **medium** (finder: high) · app-3 · stale-state · `app.js:12489` · L2-app-surface

```json
{
  "id": "app-3-1",
  "area": "app-3",
  "category": "stale-state",
  "title": "Foray page Play after the mini bar is closed restarts from the resume point captured at render time (or from 0), not from where the listener stopped, and then writes over their stored progress",
  "file": "app.js",
  "line": 12489,
  "severity": "high",
  "scenario": "The listener opens a Foray with no stored position, or with 'Jump back in at 10:00'. They play to 30:00, then close the mini bar. player/client.js:2601-2606 sends {index:-1} to the page, so paintForay goes cold and reads `state.forayResume`, which renderForay set once at render time. The clock shows 0:00 (or 10:00), the button says '▶ Play', and pressing it runs startOrResume(), which reads the `resume` closure that was also captured at render: start(0) or startAt(600). Playback begins 20 or 30 minutes back. The player saves a position about every 15 s, so the stored 30:00 is overwritten within seconds. Next, previous, the nudge buttons and row taps take the same cold path.",
  "evidence": "app.js:11728-11733 `const point = ...player.forayResume(r.id, {...}); ... state.forayResume = resume;` (read once per render). app.js:12489 `const startOrResume = () => resume ? startAt(resume.elapsedSec) : start(0);`. app.js:12756 `const resume = live ? null : state.forayResume;`. client.js on close: `wasForay.onChange({ forayId: ..., index: -1, ... elapsedSec: 0 ...})`.",
  "fix_sketch": "In paintForay, when the page moves from live to cold for this Foray (s.forayId === state.foray.id and s.index < 0 after a live tick), re-read `player.forayResume(r.id, {totalSec, itemCount, resolved: r, includeFinished: true})` into state.forayResume and repaint the banner. Have startOrResume read state.forayResume (or a mutable holder) instead of the bind-time closure. Add a test: play, advance, close the bar, press Play, and expect startElapsedSec to equal the stored position.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the code at origin/main and the finding holds.\n\n- **Where the resume point is set:** app.js:11728-11733 sets `state.forayResume` from `player.forayResume(...)` once, inside renderForay. That value is written again only in three places: #fy-restart (12494-12495, which sets it to null), the personalization wipe (14325) and renderCurrentPage (15115). Neither the player's tick path nor its close path refreshes it.\n- **What closing the bar does:** player/client.js stopAndClose sets `foray = null`, then calls `wasForay.onChange({forayId, index:-1, playing:false, running:false, elapsedSec:0, ...})`. `onChange` is just `paintForay(s)` (12467). It does not re-render the page.\n- **What the page shows:** in paintForay, `live` is false, so `resume = state.forayResume` (12756) and the clock reads `resume?.elapsedSec || 0`. That is the render-time value. The comment at 12750-12755 says this fallback is deliberate (\"the mini bar was just closed. Fall back to the stored resume point\"). But it assumes state.forayResume still holds the stored point, and after a play session it no longer does. So the intent is not the bug. The staleness is an oversight.\n- **What Play does:** `startOrResume` (12489) reads the `resume` parameter of bindForayTransport, a closure captured at bind time. It calls startAt(render-time elapsedSec), or start(0) when nothing was stored.\n- **Other buttons:** after the stop `playerHasForay(r)` is false, because `state.forayPlaying` is set to null when `live` is false. So Next, Prev and the back and forward nudges all fall back to startOrResume, as the finding says. Row taps and strip seeks are different: they go to an explicit index or time, which is intended.\n- **Why the stored progress is lost:** the player writes a position about every 15 s (client.js:4515 comment). A restart from the stale point overwrites the correct stored position.\n- **Already handled or tested?** I found no refresh elsewhere and no test covering close-then-Play. docs/DECISIONS.md does not mention it.\n\n**Severity:** I rate it medium rather than high. It needs the listener to stay on the same Foray page after closing the bar and then press a transport control. The stale clock (0:00 or 10:00) is visible before they press Play. And navigating away and back re-renders the page with the correct point. Still, it is a real loss of listening progress through an ordinary action.",
  "merged_ids": [],
  "lane": "L2-app-surface"
}
```

## app-3-3: The 'generation-changed' notice ('one version behind') is broadcast to pages that already loaded the new deploy, so returning visitors see it after every deploy

**confirmed** · verifier severity **medium** (finder: medium) · app-3 · correctness · `sw.js:354` · L4-web-platform

```json
{
  "id": "app-3-3",
  "area": "app-3",
  "category": "correctness",
  "title": "The 'generation-changed' notice ('one version behind') is broadcast to pages that already loaded the new deploy, so returning visitors see it after every deploy",
  "file": "sw.js",
  "line": 354,
  "severity": "medium",
  "scenario": "A deploy ships. A returning visitor opens 4a. The old worker serves everything network-first, so index.html, app.js and data/ all arrive live from the new deploy and the page is current. The browser's navigation-triggered update check installs the new sw.js (BUILD_ID changed); install calls skipWaiting, and activate runs clients.claim() and then tellClients('generation-changed') to every window. app.js shows the bar 'updated in the background, so what you're looking at is one version behind' without checking which version it is running. The bar sits over the Foray page's sticky transport (see the dismiss comment at app.js:16887). The message is only true for a tab that was already open before the deploy, or a page that fell back to the cache.",
  "evidence": "sw.js:353-355 `if (previousDeployId && previousDeployId !== newDeployId) { await tellClients(\"generation-changed\", { deployId: newDeployId }); }`. app.js:16935-16945 only reads msg.deployId for 'stale-shell', then calls `showShellNotice(msg.reason);` unconditionally.",
  "fix_sketch": "Give the page its own deploy id: have the deploy build stamp a `<meta name=\"foray-deploy-id\">` into index.html, as it already stamps BUILD_ID, or use the version from the forays-directory pointer. Show the generation-changed notice only when msg.deployId differs from that id, or when pinnedDeployId is set. Alternatively, have the worker send it only to clients that received a fallback.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the code at origin/main and the finding holds.\n\n- sw.js `activate` (lines 312-357) promotes the pending generation, calls `self.clients.claim()`, and then, if `previousDeployId && previousDeployId !== newDeployId`, calls `tellClients(\"generation-changed\", { deployId: newDeployId })`.\n- `tellClients` (around line 590) posts that message to every window from `clients.matchAll({type:\"window\"})`. It does not filter by fallback or pin.\n- In app.js (around lines 16921-16945), the message listener uses `msg.deployId` only for `stale-shell`. It calls `showShellNotice(msg.reason)` for any reason. `showShellNotice` checks only the per-page-load `shellNoticeDismissed` flag, then renders \"4a updated in the background, so what you're looking at is one version behind. Reload to get the current version.\" The page never compares against a deploy id of its own. `pinnedDeployId` is set only on fallback.\n\nThe scenario is reachable. The worker header's rule 1 makes every same-origin GET network-first, and non-navigation requests use `cache: \"no-cache\"`. So a returning visitor's index.html, app.js and data all come live from the new deploy. The browser's update check on navigation, or the `register()` call after paint, then fetches the byte-changed sw.js (BUILD_ID is stamped per deploy). `install` runs precache and then `skipWaiting`, and `activate` broadcasts. The listener is attached at the end of the script, so it is already listening when the message arrives after precache. The page therefore shows \"one version behind\" while it is running the current version.\n\nIs it deliberate? Only in part, and it rests on a wrong premise. The install comment says \"the load that installs a new worker is served by the OLD one either way … `activate` claims the open pages and then tells them they are a version behind.\" That treats \"served by the old worker\" as \"running old code\". That was true under the v4 cache-first policy, but under the current network-first design it is false. The message is only correct for tabs opened before the deploy, or for a page that fell back to the cache. docs/DECISIONS.md does not mention this. The existing test (sw-generation.test.js:539, \"carries the new deploy id, and only fires on a real change\") checks only that the broadcast happens. It does not check whether each client is actually behind, so nothing handles this case elsewhere.\n\nSeverity is medium. The false notice appears for most returning visitors after every deploy. It is fixed at the same offset as the Foray page's sticky transport and covers it until dismissed. It is dismissable, and pressing Reload is harmless, so no data is lost and nothing breaks. I did not run a test; reading the code was enough.",
  "merged_ids": [],
  "lane": "L4-web-platform"
}
```

## app-3-5: The generation pin is also applied to code that loaded live from a newer deploy, so new app.js reads the previous generation's data (the #233 mismatch)

**confirmed** · verifier severity **medium** (finder: medium) · app-3 · correctness · `app.js:34` · L4-web-platform

```json
{
  "id": "app-3-5",
  "area": "app-3",
  "category": "correctness",
  "title": "The generation pin is also applied to code that loaded live from a newer deploy, so new app.js reads the previous generation's data (the #233 mismatch)",
  "file": "app.js",
  "line": 34,
  "severity": "medium",
  "scenario": "The worker's pointer names G1 and deploy G2 has shipped (every first visit after a deploy looks like this). The navigation times out after 6 s or returns non-ok, so handleShell serves G1's index.html with `<meta name=\"foray-pin-deploy-id\" content=\"G1\">`. app.js and search-engine.js then load live from the origin, which is G2. app.js reads the meta tag and pins itself to G1, and every data/*.json request goes out with `?_fdid=G1`, which handleData serves from G1's cache and treats as authoritative. The result is G2 code reading G1 data: the pairing #233 was meant to prevent. The same happens when only search-engine.js falls back, because its prepended `self.__forayPinnedDeployId=\"G1\"` is read by a live app.js. The file header says this case is 'covered'.",
  "evidence": "app.js:34 `let pinnedDeployId = (typeof self !== \"undefined\" && self.__forayPinnedDeployId) || null;` and app.js:44-46 read the meta tag regardless of whether app.js itself came from the fallback. sw.js:663 `return stampPin(request, fallback.response, fallback.deployId);` applies to any code file. A fresh 200 for app.js is returned at sw.js:632 without any tagging.",
  "fix_sketch": "Make the fallback generation hold for the whole page load. In stampPin, rewrite the fallback HTML's `<script src>` and modulepreload URLs to carry `?_fdid=<id>`, and have handleShell serve code requests tagged `_fdid` from that generation, as handleData does for data. Alternatively, have app.js adopt a meta or global pin only when its own bytes carry the stamp; if the pin came only from the meta tag, reload once without it.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main and the finding holds. (1) app.js:34-48 takes `self.__forayPinnedDeployId`, or failing that the `<meta name=\"foray-pin-deploy-id\">` tag, and never checks whether app.js itself came from the fallback. The header comment calls the meta path the case \"where index.html/search-engine.js fell back but this file's own fetch was fresh\" and describes it as covered. That is intended behavior, but it is the flawed case: a fresh app.js is the newest deploy's code. (2) sw.js handleShell returns a fresh `res.ok` response unchanged (sw.js ~632). When a code file (navigation or search-engine.js) fails or times out, it calls `cachedShellFallback`, which serves from `currentDeployId()`, the worker's pointer generation. It then calls `stampPin(request, fallback.response, fallback.deployId)` (sw.js:663), which inserts the meta tag or prepends `self.__forayPinnedDeployId=...`. (3) handleData (sw.js ~727-734) treats a `_fdid`-tagged request as authoritative for that generation and never consults the origin. Scenario: G2 has deployed but the pointer is still G1 (the new worker has not activated). The navigation times out or returns non-ok while app.js answers live with G2 bytes. app.js then pins to G1 and reads G1 data: G2 code with G1 data, the pairing #233 exists to prevent. index.html loads search-engine.js and app.js as ordinary scripts with no generation tag in their URLs (index.html:119-120), so nothing keeps them in G1. docs and comments do not list this as a known residual gap. The only one they list is the deferred player/client.js. Mitigations: it needs the navigation to fail while the app.js fetch succeeds in the same load, which happens on flaky networks but is not the common case. The stale-shell message still shows a reload control. Real harm also requires G2 code that cannot read G1-shaped data. Medium is appropriate.",
  "merged_ids": [],
  "lane": "L4-web-platform"
}
```

## app-3-6: Retrying Delete my data after a 'device NOT fully clear' result reports the server rows wrongly ('never signed in' or 'NOT deleted') and can block the device clear

**confirmed** · verifier severity **medium** (finder: medium) · app-3 · error-handling · `app.js:13909` · L1-app-data

```json
{
  "id": "app-3-6",
  "area": "app-3",
  "category": "error-handling",
  "title": "Retrying Delete my data after a 'device NOT fully clear' result reports the server rows wrongly ('never signed in' or 'NOT deleted') and can block the device clear",
  "file": "app.js",
  "line": 13909,
  "severity": "medium",
  "scenario": "Run 1: every table DELETE succeeds and the sessions are revoked (logout?scope=global), but the local purge is incomplete. The sheet says 'This device is NOT fully clear… Close 4a fully and try again.' Run 2 has two outcomes. (a) If cp_sb_session was cleared but other keys remained, existingAnonSession returns null, and the sheet says 'This device was never signed in, so nothing on 4a's server could be reached.' That is false: the rows were deleted in run 1. (b) If cp_sb_session survived and its access token has expired, the refresh token was revoked in run 1, so the refresh fails, every DELETE returns 401, and the result is remote-failed: 'What 4a's server kept about you was NOT deleted. Nothing on this device was touched.' The device is left uncleared, and the only way out is 'Clear this device only', whose cost line says the server copy can no longer be deleted. That is also untrue, since it is already gone.",
  "evidence": "app.js:13909 `if (!session) return { ok: true, attempted: false, tables: [], deleted: 0 };`. app.js:14082-14083 `: !remote || !remote.attempted ? \"This device was never signed in, so nothing on 4a's server could be reached.\"`. app.js:13849 `return s;` (the expired token after a failed refresh). app.js:13913 revokes all refresh tokens on success.",
  "fix_sketch": "After a successful remote step, delete cp_sb_session first and on its own, so a retry never holds a revoked token. Record the remote success for the retry, for example as a non-cp session marker or a flag in the result the sheet keeps, and word the no-token case neutrally: 'No sign-in remains on this device; nothing on 4a's server is reachable from it.' Treat a refresh 400/401 after this module's own revocation as already done, not as remote-failed.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main app.js and the mechanics hold.\n\nWhat the code does:\n- deleteMyData (app.js ~14258-14310) runs deleteRemoteData, then clearLocalData.\n- On success, deleteRemoteData calls sbRevokeSessions, which is logout?scope=global (13913).\n- If the local clear then fails, the result is 'local-incomplete'. deletionMessage prints \"What 4a's server kept about you is deleted. This device is NOT fully clear... Close 4a fully and try again.\"\n- Nothing records that the remote step already succeeded. A retry runs deleteRemoteData from scratch.\n\nCase (a), readily reachable. clearLocalData sets rotatedSession=null and purges every cp_ key, including cp_sb_session. The run can still come back not-ok when the event-log purge fails, the shard cache delete throws (a scenario the tests themselves exercise at test/data-deletion.test.js:1734-1739), or storage is unverified. On retry, existingAnonSession sees no cp_sb_session and returns null. deleteRemoteData then returns {attempted:false}, and deletionMessage (14082-14083) says \"This device was never signed in, so nothing on 4a's server could be reached.\" That is false: the rows were deleted and the sessions revoked in run 1. It also breaks the function's own documented rule, \"IT CLAIMS ONLY WHAT WAS OBSERVED.\"\n\nCase (b), rarer but real. cp_sb_session survives, for example on the no-durable-tier path or when purge fails. If its access token has expired, the refresh with the revoked refresh token fails, and existingAnonSession returns the stale session (`return s;`, ~13849). Every DELETE then returns 401, giving DEL_FAILED and 'remote-failed'. The sheet says the server data was \"NOT deleted\", leaves the device untouched, and offers 'Clear this device only' with DD_DEVICE_ONLY_COST (\"can no longer be deleted\"). Both statements are untrue, because the data is already gone.\n\nI found nothing that makes this deliberate:\n- docs/DECISIONS.md does not address a retry after a local-incomplete run.\n- The tests cover retries after a failed table or a failed revocation (the token is kept on purpose). They do not cover a retry after a remote success followed by a local failure.\n\nSeverity: no data is exposed and the server rows really are deleted. The harm is false privacy messaging and, in case (b), a device left uncleared unless the user takes the misleadingly worded device-only path. Medium is a fair rating.",
  "merged_ids": [],
  "lane": "L1-app-data"
}
```

## app-3-8: The voice picker's subtitle says Preview plays 'at your playback speed', but auditions have been fixed at 1x since the 2026-09-24 ruling

**confirmed** · verifier severity **low** (finder: low) · app-3 · stale-copy · `app.js:14541` · L1-app-data

```json
{
  "id": "app-3-8",
  "area": "app-3",
  "category": "stale-copy",
  "title": "The voice picker's subtitle says Preview plays 'at your playback speed', but auditions have been fixed at 1x since the 2026-09-24 ruling",
  "file": "app.js",
  "line": 14541,
  "severity": "low",
  "scenario": "A listener at 1.5x opens Narration voice and reads that Preview uses their playback speed. Preview actually speaks at NARRATION_RATE (1x). The auditionVoiceRow docblock at app.js:14793-14801 records the change, but the visible copy was not updated.",
  "evidence": "app.js:14541 `\"Pick which voice reads 4a's narration. Tap Preview to hear it count to ten at your playback speed.\"`. player/client.js:4222-4223 `auditionVoice(text, voiceId) { return ttsBridge.speak(text, { rate: NARRATION_RATE, voice: voiceId }); }`.",
  "fix_sketch": "Change the copy to '…hear it count to ten, at the speed narration uses.' and add an assertion to the listener-copy test so this sentence and NARRATION_RATE cannot drift again.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "At origin/main, app.js:14541 still shows the subtitle \"Pick which voice reads 4a's narration. Tap Preview to hear it count to ten at your playback speed.\" But player/client.js:4222-4223 has auditionVoice speak at NARRATION_RATE, and player/queue-manager.js:226 sets NARRATION_RATE = 1. So Preview always plays at 1x, whatever the listener's playback speed. The code comments say the change was on purpose (founder ruling 2026-09-24). The AUDITION_LINE docblock at app.js:14509 says \"spoken at 1x, never the listener's playback speed\", and the auditionVoiceRow docblock at 14793-14801 says it \"used to speak at the current playback speed\". So the 1x behavior is intended and the visible copy is simply stale, not a deliberate choice. The phrase appears nowhere else on origin/main, so nothing else covers it. A listener at 1.5x who reads the subtitle would expect a 1.5x preview and hear 1x. This is a copy-accuracy problem with no functional harm, so severity is low.",
  "merged_ids": [],
  "lane": "L1-app-data"
}
```

## app-3-9: renderForay calls player.playbackRate() without checking it exists; with an older module the throw strands the Foray page with an unbound transport

**refuted** · verifier severity **low** (finder: low) · app-3 · error-handling · `app.js:12522`

```json
{
  "id": "app-3-9",
  "area": "app-3",
  "category": "error-handling",
  "title": "renderForay calls player.playbackRate() without checking it exists; with an older module the throw strands the Foray page with an unbound transport",
  "file": "app.js",
  "line": 12522,
  "severity": "low",
  "scenario": "The binder checks rateStops and setPlaybackRate but not playbackRate, then calls player.playbackRate() at bind time, outside guardForayTap. A module that has the first two but not the third (the skew these comments guard against everywhere else) throws inside bindForayTransport. The play, next and strip handlers are never bound, pageDidPaint never runs, and the rejection of the async renderForay goes unhandled. The page looks loaded, but its buttons do nothing.",
  "evidence": "app.js:12521-12522 `if (rateBtn && typeof player.rateStops === \"function\" && typeof player.setPlaybackRate === \"function\") { paintRateButton(player, player.playbackRate());`.",
  "fix_sketch": "Add `typeof player.playbackRate === \"function\"` to the condition, or call `paintRateButton(player, typeof player.playbackRate === 'function' ? player.playbackRate() : 1)`.",
  "duplicates": [],
  "verdict": "refuted",
  "verdict_severity": "low",
  "verdict_reasoning": "The code is as described. At origin/main, app.js:12521-12522 checks that rateStops and setPlaybackRate are functions, then calls player.playbackRate() unguarded, outside guardForayTap. A throw there would indeed abort bindForayTransport.\n\nThe failure needs a module that has rateStops and setPlaybackRate but no playbackRate, and no version of player/client.js has ever looked like that. In git history, playbackRate() and setPlaybackRate() both arrived in 095b67b1 (#242, 2026-08-17). rateStops() arrived later, in 03ed1c0c (#361, 2026-08-30). So every module old enough to lack playbackRate also lacks rateStops, and the rateStops check already excludes it. The skew the service-worker comments guard against is old module with new app.js, and every old module fails the existing check. On current main, playbackRate() is still defined (player/client.js ~4072).\n\nThe comment at app.js ~12841 says the same thing: \"an older module has no `playbackRate` either\". It treats a missing playbackRate as belonging to the pre-#242 modules, which the rateStops check already excludes.\n\nThe only other route would be a future module that drops playbackRate while keeping rateStops, which is a hypothetical regression, not a current defect. Adding the typeof check would be harmless consistency hardening, but the scenario as stated cannot happen with any real module version.",
  "merged_ids": [],
  "lane": null
}
```

## app-3-10: Voice sheet async races: overlapping Previews re-enable a voice that is still speaking, and an older refreshVoiceList can overwrite a newer one

**confirmed** · verifier severity **low** (finder: low) · app-3 · race-condition · `app.js:14805` · L1-app-data

```json
{
  "id": "app-3-10",
  "area": "app-3",
  "category": "race-condition",
  "title": "Voice sheet async races: overlapping Previews re-enable a voice that is still speaking, and an older refreshVoiceList can overwrite a newer one",
  "file": "app.js",
  "line": 14805,
  "severity": "low",
  "scenario": "(1) The listener taps Preview on Samantha, then on Daniel before Samantha finishes. voiceState.auditioning becomes Daniel. When Samantha's promise settles (or is cut off), its finally sets auditioning=null and repaints, so Daniel's button reads 'Preview' again while Daniel is still speaking, and a notice from the first run can overwrite the second's. (2) openVoiceSheet starts refreshVoiceList, and returning to the app fires a second one from visibilitychange. Whichever listVoices() resolves last wins, even if it is the older call, so a voice just downloaded in Settings can disappear from the list again.",
  "evidence": "app.js:14805 `voiceState.auditioning = id;` … app.js:14816-14818 `} finally { voiceState.auditioning = null; paintVoiceList(); }`. app.js:14751-14753 `const out = await player.listVoices(...); voiceState.voices = (out && out.voices) || [];` with no sequence check.",
  "fix_sketch": "In auditionVoiceRow, clear auditioning in finally only when `voiceState.auditioning === id`, and paint the notice only for the latest audition. In refreshVoiceList, capture `const seq = ++voiceRefreshSeq` and drop results when `seq !== voiceRefreshSeq`.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read the code at origin/main and both races are real. (1) In app.js, auditionVoiceRow (line 14802) sets `voiceState.auditioning = id` at 14805 and then sets it back to null in an unconditional `finally` at 14816-14818. The Preview button is disabled only when `voiceState.auditioning === id` (line 14620), so every other row can still be tapped during a preview. `player.auditionVoice` in player/client.js (around line 4222) just returns `ttsBridge.speak(...)` and does no sequencing. So when the first preview settles, whether it finishes or is cut off by the second speak, its finally clears auditioning while the second voice is still speaking. Daniel's button then goes back to 'Preview' and is enabled again, and the first call's paintVoiceNotice can overwrite the second's. (2) refreshVoiceList (line 14745) has no sequence guard. openVoiceSheet (line 14826) calls it, and so does the visibilitychange listener (line 14860) while the sheet is open, so two calls can overlap. If the older listVoices() resolves last, it overwrites voiceState.voices, and a voice that was just installed can disappear. That is exactly the case the visibilitychange comment says it exists for. No comment or guard treats either race as deliberate. Severity stays low: both are cosmetic or short-lived UI state. The list race also needs the resolves to come back out of order, which is unlikely, and the next refresh repairs it. I did not run a test; reading the code was enough.",
  "merged_ids": [],
  "lane": "L1-app-data"
}
```

## app-3-11: runVoiceProbe has no in-flight guard, so a second tap starts a second ~90 s probe alongside the first

**confirmed** · verifier severity **low** (finder: low) · app-3 · concurrency · `app.js:13668` · L1-app-data

```json
{
  "id": "app-3-11",
  "area": "app-3",
  "category": "concurrency",
  "title": "runVoiceProbe has no in-flight guard, so a second tap starts a second ~90 s probe alongside the first",
  "file": "app.js",
  "line": 13668,
  "severity": "low",
  "scenario": "The RUN button closes the drawer and opens the diagnostics sheet. A founder who reopens the drawer and taps RUN again, thinking it did not start, launches a second player.runVoiceProbe() while the first is running: two engine loads on a phone at once, and two runs writing to the same status line in whatever order they finish.",
  "evidence": "app.js:13656 `run.addEventListener(\"click\", () => runVoiceProbe());` and app.js:13668-13692 have no busy flag.",
  "fix_sketch": "Keep a module-level `voiceProbeRunning` promise. When it is set, reopen the sheet and return the existing promise; disable #voice-probe-run until it settles.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "This holds at origin/main. In app.js:13656, syncVoiceProbeRun wires `run.addEventListener(\"click\", () => runVoiceProbe())` with nothing to stop a second call. The function it calls, runVoiceProbe (app.js:13668-13692), opens the diagnostics sheet, sets the \"about 90 seconds\" status line and awaits player.runVoiceProbe(), with no busy flag and no disabling of the button. The player side has no guard either: player/client.js:4242 `async runVoiceProbe()` just awaits loadProbePassage() and runKokoroProbe({ tts: ttsBridge, ... }), and kokoro-probe.js calls itself pure, with no state of its own, so nothing lower down queues or merges the calls. docs/DECISIONS.md and the nearby comments do not say the missing guard is intended. The comments cover only the #225 promise guard and the no-flag entry point.\n\nThe scenario needs a few steps. openDiagSheet opens a sheet, so the founder has to close it, reopen the drawer and tap RUN again. That is plausible because for 90 seconds nothing else shows the probe is running. Opening the sheet again, even the ordinary way through the Playback diagnostics control, calls openDiagSheet, which sets `ui.status.textContent = \"\"` (app.js:14974). This erases the \"Running\" message, which makes a retap more likely.\n\nTwo probe runs then share the one ttsBridge engine. Each writes its own diag.voiceProbe record, and whichever finishes last overwrites the status line. On a phone, two runs that each pin the CPU at once could also skew the RTF numbers.\n\nI am keeping severity low. Only someone who has turned on the voice-probe switch can reach this, it is a measurement tool that is off by default, nothing is lost, and both records still go into diagnostics.",
  "merged_ids": [],
  "lane": "L1-app-data"
}
```

## app-3-13: init() has no catch after its first await, so a throw in boot leaves 'Loading 4a…' on screen for good, with ☰ and ↻ disabled, no Try again, and no service worker

**confirmed** · verifier severity **low** (finder: low) · app-3 · error-handling · `app.js:16764` · L1-app-data

```json
{
  "id": "app-3-13",
  "area": "app-3",
  "category": "error-handling",
  "title": "init() has no catch after its first await, so a throw in boot leaves 'Loading 4a…' on screen for good, with ☰ and ↻ disabled, no Try again, and no service worker",
  "file": "app.js",
  "line": 16764,
  "severity": "low",
  "scenario": "Only route() is wrapped. bootForayDirectory's bookkeeping, loadInterests(), buildCards() and restoreNowPlayingRibbon() run bare. lsGet returns whatever JSON is stored without checking its shape, so a stored `cp_seen` or `cp_recent_branches` that is not an array (older-build data or a corrupt restore) makes `new Set(obj)` or `.includes` throw inside buildCards. The rejection of `init()` is unhandled, markFirstPagePainted never fires (so the worker never registers), setBootChrome(true) never runs, and no hashchange listener is bound. The app stays dead until its storage is cleared.",
  "evidence": "app.js:16764 `init();` (no .catch). app.js:16591 `buildCards();` runs outside the try that wraps route() at 16605. app.js:1699-1706 `const seen = new Set(lsGet(\"cp_seen\", [])); ... recentBranches.includes(b)`. app.js:133 `return JSON.parse(store.getItem(key)) ?? fallback;`.",
  "fix_sketch": "Wrap the post-session body of init in try/catch. On failure, paint failedNoteHtml with Try again, still bind the drawer and hashchange wiring, and call markFirstPagePainted in a finally. Add `Array.isArray` guards where lsGet results are used as arrays (cp_seen, cp_recent_branches, cp_history).",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main:app.js myself and the mechanism holds. `init();` near line 16764 has no .catch. Inside init, only `route()` sits in a try/catch (the comment there covers only the first-route throw). bootForayDirectory, loadInterests(), buildCards(), enterForayFromQuery() and restoreNowPlayingRibbon() all run bare. There is no window unhandledrejection or onerror handler anywhere in app.js or the non-test JS. If any of them throws, the code that follows never runs: markFirstPagePainted() (so the service worker never registers, because it waits on firstPagePainted), the drawer, hashchange and refresh wiring, and setBootChrome(true) at about line 16706. The screen is left on BOOT_LOADING_HTML (\"Loading 4a…\") with #menu-btn and #refresh-btn disabled, which setBootChrome(false) set at the start of init. lsGet (line 133) returns any parsed JSON without checking its shape. buildCards (1699-1706) does `new Set(lsGet(\"cp_seen\", []))`, `new Set(pickedHistory())` and `recentBranches.includes(b)`. A stored non-iterable object or number would throw there, and the throw repeats on every launch until storage is cleared. Neither docs/DECISIONS.md nor any comment says this is deliberate; the route() comment shows the authors meant to keep the wiring alive after a throw. It is low severity because every in-app writer stores arrays for these keys (lines 1660, 1751, 5577-5579). So the trigger needs corrupted, foreign or very old storage, or some other unexpected throw in those bare calls. A stored string would not throw, since both Set and includes accept strings. The finding is real but unlikely to be hit.",
  "merged_ids": [],
  "lane": "L1-app-data"
}
```

## app-3-14: A service-worker test and comment claim a response that lands after the timeout 'warms' the generation cache, but cachePut makes that a no-op for every manifest-tracked file

**confirmed** · verifier severity **low** (finder: low) · app-3 · test-quality · `test/sw-generation.test.js:893` · L4-web-platform

```json
{
  "id": "app-3-14",
  "area": "app-3",
  "category": "test-quality",
  "title": "A service-worker test and comment claim a response that lands after the timeout 'warms' the generation cache, but cachePut makes that a no-op for every manifest-tracked file",
  "file": "test/sw-generation.test.js",
  "line": 893,
  "severity": "low",
  "scenario": "fromOrigin's comment (sw.js:165-167, 472-478) says a fetch that times out 'still writes to the cache when it lands'. The test proves it only with harness generations that have no __manifest__ entry, so every path is untracked. In production, app.js, player/*.js and data/* are tracked, and cachePut returns at `if (have) return;` without writing (the round-2 perf-6 change). The test passes while the production behaviour it names does not exist. It also waits with three fixed `setTimeout(r, 0)` ticks, so it depends on how many microtask hops the code takes.",
  "evidence": "test/sw-generation.test.js:893-912 `generations: { \"1\": { \"app.js\": \"APP@1\" } }` … `assert.equal(h.cachedBody(\"app.js\", \"foray-gen-1\"), \"APP@2\");`. sw.js:545-546 `if (expected) { if (have) return;`.",
  "fix_sketch": "Seed the harness generation with a __manifest__ entry and assert the real contract: a tracked file keeps its verified bytes, and an untracked one is written. Update the fromOrigin comment to say the warm-up only happens in the HTTP cache for tracked files. Replace the fixed tick count with awaiting the waitUntil promises the harness records.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main and the finding holds. precache() writes the generation manifest into every real generation cache (sw.js:268 `genCache.put(GEN_MANIFEST_KEY, ...)`), and cachePut's own comment says no untracked paths exist today. In cachePut (sw.js ~545), `if (expected) { if (have) return; ...}` returns without writing whenever a tracked file already has its verified copy. For app.js, player/* and data/*, that copy is always there after install. So a late fromOrigin response never reaches the generation's CacheStorage in production.\n\nThe test at test/sw-generation.test.js:893 seeds `generations: { \"1\": { \"app.js\": \"APP@1\" } }` with no `__manifest__` entry; the only test that seeds one is at line 1461. trackedHash therefore returns null and the untracked path writes APP@2, so the test passes on a code path production never takes.\n\nThe comments at sw.js:165-167 and 472-478 say the late response 'writes to the cache' so the next load is a cheap 304. That is only true of the browser HTTP cache, through fetch with cache:'no-cache'. It is not true of the generation cache the comment and the test describe.\n\nThe fixed three-tick wait is fragile in the way the finding says. No DECISIONS.md or comment makes this deliberate: the perf-6 comment made the write a no-op but did not update the fromOrigin comment or this test.\n\nImpact is only a misleading comment and test, not a runtime bug. Keeping the verified copy is the correct behaviour, so severity is low.",
  "merged_ids": [],
  "lane": "L4-web-platform"
}
```

## player-core-1: Pressing previous-clip after a failed Foray load marks the whole Foray Played and restarts it from clip 1

**confirmed** · verifier severity **high** (finder: high) · player-core · correctness · `player/queue-state.js:514` · L3-player-and-native-tts

```json
{
  "id": "player-core-1",
  "area": "player-core",
  "category": "correctness",
  "title": "Pressing previous-clip after a failed Foray load marks the whole Foray Played and restarts it from clip 1",
  "file": "player/queue-state.js",
  "line": 514,
  "severity": "high",
  "scenario": "A Foray segment's load fails and the manager goes to `idle`. This happens with a hidden-page load timeout, a 404, or `play.rejected NotAllowedError` on web iOS. The listener then presses ‹‹, the lock-screen previoustrack or #fy-prev. `forayPrevious` gets a null `forayPlayhead()` (or index 0), so `into` is Infinity and it calls `manager.skipToPrevious()`. The manager passes `E.skipToPrevious(null)`. In `handleSkip`, `currentItem(idle)` is null, so the code falls through to the 'queue genuinely exhausted' branch and returns `S.ended()`. On the next `render()`, `persistForayProgress` sees `ended` and calls `forayProgress.markFinished`, so a half-heard Foray becomes 'Played' and leaves Jump back in. The next ▶ press then hits `want && foray && state === ended` and calls `forayJump(0)`, which restarts from the beginning. For an ordinary episode, `ended` also fires `onEpisodeEnded`, which starts the next Up Next item.",
  "evidence": "queue-state.js:511-530 `const restart = direction === \"previous\" ? currentItem(state) : null; if (restart) {...} ... return [S.ended(), audible ? [...] : [done]];` Confirmed with node: `reduce(S.idle(), E.skipToPrevious(null))` -> `[{type:\"ended\"},[skip.previous.queueExhausted]]`. queue-manager.js:858-859 `this._armOffset(\"_forceNextOffset\", 0); return this._handle(E.skipToPrevious(null));`. client.js:1413-1428 `if (manager?.state?.type === \"ended\") { ... forayProgress.markFinished({...})`. client.js:4606-4612 `const into = pos == null ? Infinity : ...; ... else { await manager.skipToPrevious(); }`. No reducer test covers skipToPrevious from idle.",
  "fix_sketch": "In the reducer, make `skipToPrevious(null)` from idle or ended (no current item) a no-op or telemetry only, never `ended`. Also have `PlayerQueueManager.skipToPrevious` pass `refOf(this._currentItem())` explicitly, so from `idle` it takes the default 'fresh play' branch and reloads the current clip at its in-point. Add a queue-state test for skipToPrevious(null) in idle, and a client test for ‹‹ after a failed load.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "high",
  "verdict_reasoning": "I read the code at origin/main and the finding holds.\n\n1. **The reducer ends the queue.** In player/queue-state.js, `currentItem()` (lines 265-273) returns null for idle and ended. So in `handleSkip` (around lines 509-530), `skipToPrevious(null)` from idle skips the restart branch and returns `S.ended()` with only the `skip.previous.queueExhausted` telemetry. I ran the origin/main reducer in node: `reduce({type:\"idle\"}, {type:\"skipToPrevious\", item:null})` returned `[{\"type\":\"ended\"},[{\"type\":\"emitTelemetry\",\"message\":\"skip.previous.queueExhausted\"}]]`.\n\n2. **A failed load really does leave the manager idle.** The reducer maps any `error` event to `S.idle()`. The manager raises `E.error` from `backend.onError`, from an unknown ref, and from `_loadItem`'s catch (queue-manager.js lines 554, 1419, 1594).\n\n3. **Previous from that state reaches the reducer.** `PlayerQueueManager.skipToPrevious` (lines 853-861) calls `this._handle(E.skipToPrevious(null))` with no guard on state. In player/client.js, `forayPrevious` (around 4593) gets its position from `forayPlayhead()` (1220). That returns null when `manager.playheadItemId` (`_loadedId`) is not the current item's id, which is the case after a failed load. So `into` is Infinity and the call goes to `manager.skipToPrevious()`. The ‹‹ button (line 3260) and the lock-screen or car `previous` handler (`forayMediaSurface`, line 2659) both route to `forayPrevious`.\n\n4. **The Foray gets marked Played, then restarts.** `persistForayProgress` (around 1396-1430) sees `manager.state.type === \"ended\"` and calls `forayProgress.markFinished`, which overwrites the resume row. The next play press hits `if (want && foray && manager.state?.type === \"ended\") await ForayPlayer.forayJump(0)` (line 2510) and starts again from the beginning.\n\n**Not deliberate.** docs/DECISIONS.md line 217 and the manager's own doc comment say previous means \"restart item / previous\". Nothing documents ending the Foray from idle. The comment on the exhausted branch only covers the skip-next or end-of-queue case. I found no guard elsewhere: no disabling of `clipPrev` in idle and no state check in `forayPrevious`.\n\n**Severity.** It takes a failed load first, but those are realistic: an iOS NotAllowedError, a timeout, or a 404. After a failure, pressing previous is a natural way to retry, and it silently destroys the listener's resume progress and moves the Foray out of \"Jump back in\". I would keep it at high.\n\nThe one claim I did not trace is that `ended` triggers `onEpisodeEnded` and starts the next Up Next item for an ordinary episode. It looks plausible, and the Foray half is enough to confirm the finding.",
  "merged_ids": [],
  "lane": "L3-player-and-native-tts"
}
```

## player-core-2: Pause or Stop during a rendered narration bridge's load is ignored: the bridge starts playing anyway

**confirmed** · verifier severity **high** (finder: high) · player-core · race-condition · `player/queue-manager.js:2350` · L3-player-and-native-tts

```json
{
  "id": "player-core-2",
  "area": "player-core",
  "category": "race-condition",
  "title": "Pause or Stop during a rendered narration bridge's load is ignored: the bridge starts playing anyway",
  "file": "player/queue-manager.js",
  "line": 2350,
  "severity": "high",
  "scenario": "A segment reaches its out-point and the next item is a rendered TTS bridge, so the state is `transitioning`. `_playTransitionBridge` awaits `backend.load(bridge)`, which takes 5-11 s on a hidden page by the repo's own measurements. During that window the listener presses pause (car, lock screen or bar). The reducer goes to `interrupted(bridge)` and emits pausePlayback, which does nothing because the element is already paused. `pause()` does not bump the backend's `_loadSeq`, so the load resolves and `_playTransitionBridge` calls `this.backend.play()` unconditionally, and audio starts. The element's `playing` event then runs `_reconcileTowardsPlaying`: `_loadedId === bridge.id === state.item.id`, so it dispatches `elementResumed` and the machine flips to `playing`, fully undoing the pause. With Stop (`stopAndClose`), the state goes to `idle` and the UI and media session are torn down, then the bridge line plays with no player on screen.",
  "evidence": "queue-manager.js:2344-2351 `if (this._isSynthNarration(bridge)) { await this._speakNarration(bridge); this._beginSynthNarration(bridge); } else { await this.backend.load(bridge, { startOffset: 0 }); this._endSynthNarration(); this.backend.play(); }`. Nothing re-checks `this.state` or a load sequence after the await. The synth branch has the same shape: speak() starts the voice after a pause or stop that ran while `_loadedIsSynth` was still false.",
  "fix_sketch": "Capture a token before the await, e.g. `const seq = ++this._loadSeq` or the `state` object. After the await, bail (and for synth, stop the TTS) unless `this.state.type === \"transitioning\"` and `sameRef(this.state.to, refOf(bridge))`, and the seq is unchanged. Only then set `_loadedId` and call `backend.play()`.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "high",
  "verdict_reasoning": "I read origin/main myself and the finding holds. When a segment ends and the next item is a TTS bridge, the reducer moves to `transitioning(item, bridge)` and emits `playTransitionTTS`. In `player/queue-manager.js`, `_playTransitionBridge` (around lines 2328-2375) runs `await this.backend.load(bridge, { startOffset: 0 }); this._endSynthNarration(); this.backend.play();`. After that await, nothing checks `this.state`, a load sequence or a stop epoch again.\n\n**Nothing serializes a pause behind the load.** `_transport` only cuts the seam gap; it does not queue work. So `pause()` runs straight away. From `transitioning`, `handleInterruptionBegan` goes to `interrupted(state.to = bridge, true)` and emits `pausePlayback`, which calls `backend.pause()`. That call does two things, and neither cancels the load:\n- It bumps `_stopEpoch`, but `load()` in `html-audio-backend.js` (around lines 1488-1600) only checks `_loadSeq`, which `pause()` does not touch.\n- It pauses an element that is already paused. The \"pause.forced\" check in `pause()` does not fire either, because the element is not audible yet.\n\nSo the load resolves and `backend.play()` starts the bridge audio anyway. `_loadedId = bridge.id` is then set.\n\n**The flip back to `playing` is also real.** `_reconcileTowardsPlaying` requires `_loadedId === currentItem.id === state.item.id`. All three are the bridge here, because `currentIndex` was set to the bridge's index and `interrupted` holds `state.to`, which is the bridge. Once the outer `_handle` finishes and `_applying` drops to 0, an audible element makes it dispatch `elementResumed`, and the machine goes to `playing`.\n\n**Stop behaves the same way.** `handleStop` from `transitioning` goes to `idle` with `pausePlayback`, and the bridge then starts playing with no player on screen.\n\n**The normal load path is protected; this one is not.** In `_loadItem`, an `interrupted` state makes a stray `itemLoaded` get ignored, and the reducer's own comment on `loadingItem` says exactly that. The bridge path calls `play()` directly and skips that protection. The header of `queue-state.js` says bridge assets are \"presumed local\", but a rendered bridge is loaded from a URL, so that assumption does not hold. I found nothing in the code comments that treats this as intended behaviour.\n\n**The synth branch has the same gap.** `speak()` is accepted after a pause or stop that ran while `_loadedIsSynth` was still false. That pause went to `backend.pause()` instead of the TTS, and `_beginSynthNarration` then marks the line as speaking.\n\nI kept severity at high. The stop case plays audio after the listener closed the player, with no surface left to stop it. The pause case silently undoes a pause pressed from the car or the lock screen. The window is the whole bridge load, which can be long on a hidden page. I did not run a test.",
  "merged_ids": [],
  "lane": "L3-player-and-native-tts"
}
```

## player-core-3: An interrupted play() (AbortError) is reported as a fatal player error, which drops the listener's skip into idle

**confirmed** · verifier severity **high** (finder: high) · player-core · error-handling · `player/html-audio-backend.js:1779` · L3-player-and-native-tts

```json
{
  "id": "player-core-3",
  "area": "player-core",
  "category": "error-handling",
  "title": "An interrupted play() (AbortError) is reported as a fatal player error, which drops the listener's skip into idle",
  "file": "player/html-audio-backend.js",
  "line": 1779,
  "severity": "high",
  "scenario": "`startPlayback` calls `backend.play()`, and the element's play promise stays pending until audio actually flows. On a locked or hidden page, media tasks are delivered seconds apart. If the listener presses Next or a row in that window, the reducer emits pausePlayback then loadItem(B). `el.pause()` (or the new `src`) rejects the pending promise with `AbortError`. `_recoverFromRefusedHandover` returns false for a non-NotAllowedError, so the catch calls `onError('play rejected: AbortError')`. The manager wires that to `_handle(E.error(...))`, which from `loadingItem(B)` goes to `idle` + pausePlayback. B's load then resolves and dispatches `itemLoaded` in `idle`, which is ignored. The skip silently stops playback. Inside a Foray, the page also shows the standing error because the message matches `player.error`. A pause in the same window lands in `idle` instead of `interrupted` and paints 'could not start'.",
  "evidence": "html-audio-backend.js:1771-1780 `p.catch((err) => { if (this._recoverFromRefusedHandover(el, err)) return; this._emit(`play.rejected ...`); if (this.onError) this.onError(`play rejected: ${err?.name ?? err}`); });`. The recovery comment at 1316-1323 itself calls AbortError 'the ORDINARY rejection of a pending play() that a pause() or a fresh load() interrupted', and html-audio-backend.test.js:2315 asserts it 'reports'. queue-manager.js:554 `backend.onError = (msg) => this._handle(E.error(String(msg)));`. Confirmed with node: `reduce(S.loadingItem(seg), E.error(\"play rejected: AbortError\"))` -> idle + pausePlayback.",
  "fix_sketch": "In `play()`'s catch, treat `err.name === \"AbortError\"` as expected: emit telemetry only and never call `onError`. Alternatively, stamp `_loadSeq` or `_stopEpoch` at call time and suppress the report when either changed before the rejection. Update the test at html-audio-backend.test.js:2308-2315 accordingly.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "high",
  "verdict_reasoning": "I read origin/main myself and the finding holds.\n\n1. The backend reports every non-autoplay rejection. In player/html-audio-backend.js, play() (about lines 1755-1782) attaches a catch to el.play(). That catch returns early only when _recoverFromRefusedHandover returns true. The recovery returns false for anything other than NotAllowedError (line 1329: `if (err?.name !== \"NotAllowedError\") return false;`), so an AbortError goes on to `this.onError(\\`play rejected: ${err?.name ?? err}\\`)`. The call has no epoch or load-sequence guard: _stopEpoch and _loadSeq exist but play() never captures them.\n\n2. The manager gives that report no filter. queue-manager.js:554 is `backend.onError = (msg) => this._handle(E.error(String(msg)))`. _handle (line 1074) reduces straight away and has no stale-event filter.\n\n3. The reducer treats every error the same way. In queue-state.js:300-301, `case \"error\"` returns `[S.idle(), [F.pausePlayback(), F.emitTelemetry(...)]]` whatever state it arrives in. A later itemLoaded in idle only produces 'itemLoaded.ignored' telemetry (line 379).\n\n4. The scenario can happen. A state of playing is set before startPlayback runs, and the element's promise stays pending until the element actually starts playing, which can take a long time on a slow network or a backgrounded page. A skip from playing goes to loadingItem(B) and runs pausePlayback before loadItem (queue-state.js:333-341 pattern). Per the HTML spec, pause() queues a media-element task that rejects the pending play promises with AbortError. That task runs before B's load can finish, so the error lands in loadingItem(B), the machine drops to idle, and B's itemLoaded is ignored. A pause in the same window goes playing -> interrupted and is then overwritten to idle in the same way.\n\n5. It is not deliberate. The comment at lines 1316-1323 calls AbortError 'the ORDINARY rejection of a pending play() that a pause() or a fresh load() interrupted'. That comment only argues the recovery must not restart audio on an AbortError. It does not claim that reporting it as a fatal error is correct. The test at html-audio-backend.test.js:2315 asserts 'it reports, exactly as it did before this feature'. That assertion pins the old behaviour for regression purposes and does not show the report was designed. Elsewhere the code does treat AbortError as expected: notePlayGesture (lines 1737-1746) swallows the AbortError from its own prime. Nothing else in the player handles AbortError; git grep finds only those sites.\n\nSeverity: I kept it at high. A skip or pause pressed during the play-pending window silently stops the Foray and leaves the reducer in idle. The locked-screen or driving listener is the case this product is built around, and that listener cannot easily recover.\n\nI did not run a test; reading the code was enough.",
  "merged_ids": [],
  "lane": "L3-player-and-native-tts"
}
```

## player-core-4: A synth narration load superseded while speak() is in flight still marks itself loaded and keeps talking over the next item

**confirmed** · verifier severity **medium** (finder: medium) · player-core · race-condition · `player/queue-manager.js:1541` · L3-player-and-native-tts

```json
{
  "id": "player-core-4",
  "area": "player-core",
  "category": "race-condition",
  "title": "A synth narration load superseded while speak() is in flight still marks itself loaded and keeps talking over the next item",
  "file": "player/queue-manager.js",
  "line": 1541,
  "severity": "medium",
  "scenario": "A script-only narration item is loading, for example from a row tap, forayPrevious or a resume, and `_loadItem` awaits `_speakNarration`, a Capacitor bridge round trip. The synthesiser starts talking on accept. A Next or row tap in that window hits the reducer's `loadingItem` branch, which emits only `loadItem(C)` with no pausePlayback, and even a pause would have gone to the backend because `_loadedIsSynth` is still false. When speak() resolves, the stale call runs `_loadedId = item.id; _beginSynthNarration()` with no `_loadSeq` check. That sets `_loadedIsSynth = true` and starts the ticker; only after that does `_awaitSeamGap(seq)` notice the supersede. The narration voice keeps speaking over C. If C's load (for example a same-source seek) landed first, `_loadedIsSynth` stays true while C plays. Pause and startPlayback then go to the TTS bridge instead of the element, so the pause button does not stop C. Stop during this window also misses the voice because `wasSynth` was false.",
  "evidence": "queue-manager.js:1539-1543 `if (!resumingSpeech) { await this._speakNarration(item); this._loadedId = item.id; this._beginSynthNarration(item); }`. Contrast the backend branch at 1548-1559, which checks `if (this._loadSeq !== seq) return ...` straight after its await. queue-state.js:534-543: a skip in loadingItem emits only `loadItem` + telemetry.",
  "fix_sketch": "After `await this._speakNarration(item)`, check `if (this._loadSeq !== seq) { await this._ttsTransport(\"stop\"); return this._emit(\"load.superseded ...\"); }` before touching `_loadedId` or `_beginSynthNarration`. Mirror the same guard in `_playTransitionBridge`.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "The finding holds at origin/main. In player/queue-manager.js:1539-1543 the synth branch runs `await this._speakNarration(item); this._loadedId = item.id; this._beginSynthNarration(item);` and never compares `_loadSeq` with `seq`. The backend branch just below it (1548-1559) was given exactly that check in the 2026-09-22 audit, with a comment explaining the reason. `_beginSynthNarration` (1680) sets `_loadedIsSynth = true`, bumps `_speakSeq` and starts the ticker before `_awaitSeamGap(seq)` notices the load was superseded. That late check only skips `itemLoaded`. It stops no speech.\n\nAccording to `_speakNarration`'s own doc comment, speak() resolves on accept, so the voice is already talking while the call waits for the bridge's answer. Nothing on the superseding path silences it. The reducer's `loadingItem` skip branch (queue-state.js ~534-543) emits only `loadItem` and telemetry, with no pausePlayback. Even a pausePlayback would have gone to `backend.pause()`, because `_loadedIsSynth` is still false then. The newer backend load's `_endSynthNarration` clears the flag and the ticker but never calls the TTS stop. `stop()` reads `wasSynth = this._loadedIsSynth` (875) before the stale speak finishes, so it can miss the voice too.\n\nThe orderings work out like this:\n- If the stale speak resolves after C's load lands, `_loadedIsSynth` stays true while C plays. `pausePlayback` and `startPlayback` then go to the TTS bridge instead of the element, and `_loadedId` names the abandoned item.\n- If it resolves before C's load lands, C resets the flag, but the voice still talks over C.\n\n`_playTransitionBridge` (2345-2346) has the same shape. docs/audit/qa-findings-detail.md already flagged this synth half (\"worse, because it also sets `_loadedIsSynth`...\") next to the backend half. Only the backend half was fixed, so this was left out by mistake, not by design. I found nothing in docs/DECISIONS.md or the code that excuses it.\n\nI rate it medium rather than high because the window is short: one Capacitor round trip to accept the speak() call. It is reachable, though, by a skip or row tap during a narration load, and the result (a voice over the episode and a pause button that does not pause the episode) is clearly audible. The fix sketch is right: after the await, if `_loadSeq !== seq`, stop the TTS and return before stamping `_loadedId` or calling `_beginSynthNarration`, and do the same in `_playTransitionBridge`.",
  "merged_ids": [],
  "lane": "L3-player-and-native-tts"
}
```

## player-core-5: Scrubber and clocks freeze for the rest of the session if a drag returns to its starting value

**confirmed** · verifier severity **medium** (finder: medium) · player-core · stale-state · `player/client.js:3267` · L3-player-and-native-tts

```json
{
  "id": "player-core-5",
  "area": "player-core",
  "category": "stale-state",
  "title": "Scrubber and clocks freeze for the rest of the session if a drag returns to its starting value",
  "file": "player/client.js",
  "line": 3267,
  "severity": "medium",
  "scenario": "The `input` handler calls `paintScrubPreview()`, which sets `scrubbing = true`. Only the `change` handler resets it. Browsers (WebKit's dispatchFormControlChangeEventIfNeeded, and Chromium) fire `change` on a range input only when the committed value differs from the value at the start of the interaction. A thumb that is touched, wiggled and released on the same value out of 0-1000, which is common with a nervous touch, fires `input` but never `change`. `scrubbing` then stays true, and `paintPage`'s whole `if (!scrubbing)` block (fill width, slider value, both clocks, aria-valuetext) is skipped on every later render. The bar and sheet show a frozen position until the listener completes another scrub that changes the value.",
  "evidence": "client.js:3267 `ui.scrub.addEventListener(\"input\", () => paintScrubPreview());`. client.js:1867 `scrubbing = true;`. client.js:3268-3274 (the only reset) `ui.scrub.addEventListener(\"change\", async () => { ... scrubbing = false;`. client.js:1800 `if (!scrubbing) { ... ui.fill.style.width = ...; ui.scrub.value = ...; paintClocks(...) }`. The blur/pointerdown/keydown handlers touch only `scrubByPointer`.",
  "fix_sketch": "Also clear `scrubbing` on the slider's `pointerup`, `pointercancel` and `blur` (and `lostpointercapture`), then call `render()`. Alternatively, keep a `scrubStartValue` and treat a release with an unchanged value as 'no seek, stop previewing'.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I checked this against origin/main player/client.js and it holds. `scrubbing` is declared at line 1080. The only place that sets it true is paintScrubPreview (line 1867), which runs from the `input` listener at line 3267. The only place that sets it false is the `change` listener (line 3274). No other code resets it: grep finds just those lines, and the pointerdown, keydown and blur handlers (lines 3264-3266) only change `scrubByPointer`. paintPage wraps the fill width, the slider value, scrubLiveValue and paintClocks (both clocks and aria-valuetext) in `if (!scrubbing)` at line 1800. So once `scrubbing` sticks at true, the bar stops updating until a later `change` event.\n\nThe scenario can happen. Chromium and WebKit fire `change` on a range input only when the committed value differs from the value at the last change event. A drag that moves the thumb away and brings it back to the same integer (the slider is 0-1000) fires `input` events on the intermediate values but no `change` on release. The same happens on a slow drag with a nervous finger.\n\nI found no mitigation and no rationale for it. The comments (audit round 2 player-6, a11y-7) describe the preview as deliberate but assume `change` always ends it. The one `scrubbing` edge case the code handles is a `change` with no `input` before it, the reverse of this one. docs/DECISIONS.md mentions scrubbing only in unrelated contexts. I did not run a test.\n\nSeverity: medium. Playback and audio are unaffected, and any later scrub that changes the value clears the state. Until then, the visible progress bar, both clocks and the screen-reader value stay frozen for the rest of the session. That is noticeable and misleading.",
  "merged_ids": [],
  "lane": "L3-player-and-native-tts"
}
```

## player-core-6: Foray 'Next clip' silently skips narration clips, and ends the Foray early when the last item is narration

**confirmed** · verifier severity **medium** (finder: medium) · player-core · correctness · `player/client.js:4581` · L3-player-and-native-tts

```json
{
  "id": "player-core-6",
  "area": "player-core",
  "category": "correctness",
  "title": "Foray 'Next clip' silently skips narration clips, and ends the Foray early when the last item is narration",
  "file": "player/client.js",
  "line": 4581,
  "severity": "medium",
  "scenario": "`forayNext` paints intent as `currentIndex + 1` and calls `manager.skipToNext()`. `_skipToNext` uses `_nextItem(cursor, true)`, which skips every `kind: \"tts\"` item: the Swift 'bridge' rule, pinned by the queue-manager test 'skipToNext steps over a bridge'. In a Foray, narration lines are authored content (`foray-queue.js:311` builds them as `kind: \"tts\"`). The running order and now-playing briefly highlight the narration clip while the audio jumps past it. If the Foray's last playable item is a narration outro, Next from the penultimate clip is not blocked by `currentIndex >= last`. `_nextItem` then returns null, the reducer goes to `ended`, `persistForayProgress` marks the Foray finished, and the closing line is never heard.",
  "evidence": "client.js:4578-4582 `const last = foray.resolved.playable.length - 1; if (manager.currentIndex >= last) return; ... setForayIndex(manager.currentIndex + 1); await manager.skipToNext();`. queue-manager.js:836 `const next = this._nextItem(this._cursor(), true);`. queue-manager.js:2424-2427 `if (skipBridges && this.queue[i].kind === TTS) continue;`.",
  "fix_sketch": "Give the manager a skip that does not step over bridges (e.g. `skipToNext({ includeBridges: true })` or `skipToIndex(i)`) and use it from `forayNext`, keeping the Swift bridge-skip only for SINGLE_ITEM/pick queues. Alternatively, have `forayNext` call `manager.play(currentIndex + 1)` the way `forayPrevious` already calls `manager.play(index - 1)`.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I checked this against origin/main and it holds. In client.js at lines 4578-4583, forayNext guards on `manager.currentIndex >= playable.length - 1`, then calls `setForayIndex(manager.currentIndex + 1)` and then `await manager.skipToNext()`. In queue-manager.js at line 836, `_skipToNext` calls `this._nextItem(this._cursor(), true)`. At lines 2424-2427, `_nextItem` with skipBridges=true skips every item where `kind === TTS`. In foray-queue.js at line 311, authored Foray narration is pushed as `kind: \"tts\"`. So Next from a clip that has a narration item after it jumps over the narration. The painted index (+1) points at the narration while the audio moves to the item after it. If the narration is the last playable item, the guard does not stop the call because currentIndex is last-1. `_nextItem` then returns null, and `E.skipToNext(null)` goes to the end state. I found nothing in client.js comments or docs/DECISIONS.md saying Next is meant to skip Foray narration. The grep for bridge/narration-next shows only unrelated seam and Android-bridge entries. Nothing else in the path handles this either. forayPrevious and forayJump use `manager.play(index)` and bridge-aware stepping, but forayNext does not. The bridge-skip in skipToNext is the Swift transition-bridge rule, which was carried over without adjusting for Foray narration being authored content. Medium severity fits: Next is user-triggered, but the user silently loses an authored line, the UI shows a different item from what is playing, and the Foray can be marked finished early. I did not run a test; reading the code was enough.",
  "merged_ids": [],
  "lane": "L3-player-and-native-tts"
}
```

## player-core-7: stop() does not enforce silence the way pause() does (#689 drift survives Stop)

**confirmed** · verifier severity **medium** (finder: medium) · player-core · correctness · `player/queue-state.js:622` · L3-player-and-native-tts

```json
{
  "id": "player-core-7",
  "area": "player-core",
  "category": "correctness",
  "title": "stop() does not enforce silence the way pause() does (#689 drift survives Stop)",
  "file": "player/queue-state.js",
  "line": 622,
  "severity": "medium",
  "scenario": "`pause()` was hardened for #689: after the reducer runs, if `elementIsAudible` it forces `backend.pause()`, because a reducer in `interrupted` emits no pausePlayback. `stop()` has no such check, and `handleStop` from `interrupted` or `loadingItem` emits only telemetry. When the element is audible while the machine says `interrupted`, Stop moves the state to `idle` and never pauses the element. This is the drift #689 report 3 describes, and the bridge-load race above produces it too. `stopAndClose` then hides the bar and calls `media.release()`, so audio keeps playing with no in-page or lock-screen control. The Android notification's Stop (`remoteStop` close:true) takes the same path.",
  "evidence": "queue-state.js:622-623 `default: // loadingItem, interrupted — nothing audible to pause\\n return [S.idle(), [F.emitTelemetry(\"player.stopped\")]];` Confirmed with node: `reduce(S.interrupted(seg,false), E.stop())` -> `[idle, [player.stopped]]`. queue-manager.js:824-827 (pause only) `if (this.elementIsAudible) { this._emit(\"pause.forced ...\"); await this.backend.pause(); }`. queue-manager.js:879 (stop) has no equivalent.",
  "fix_sketch": "In `PlayerQueueManager.stop()`, after the `_transport(\"stop\")` call, do the same postcondition check: `if (this.elementIsAudible) await this.backend.pause();`. Also call `_ttsTransport(\"stop\")` whenever a synth line may be speaking, not only when `_loadedIsSynth` was true at entry.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main myself and the finding holds.\n\n1. The reducer does what the finding says. `player/queue-state.js` `handleStop`: in its `default` branch (`loadingItem`, `interrupted`) it returns `[S.idle(), [F.emitTelemetry(\"player.stopped\")]]` with no `pausePlayback`. The comment there says \"nothing audible to pause\", which assumes the state and the element agree.\n\n2. `pause()` has a guard that `stop()` lacks. `player/queue-manager.js` `pause()` (lines ~807-828) calls `backend.pause()` after `_handle` when `this.elementIsAudible` is true, and its comment says why: `interrupted` can be reached while the element is audible (#689 report 3), and the reducer then emits nothing. `stop()` (lines ~863-881) runs `_transport(\"stop\", () => this._handle(E.stop()))`, calls `_stopNarration()` only when `wasSynth`, then `_stopTimer()`. It never reads `elementIsAudible` and never calls `backend.pause()`.\n\n3. Nothing downstream catches it. `client.js` `stopAndClose()` does `flushPositions()`, `await manager.stop()`, `media.release()`, then hides `ui.root` and the sheet and sets `current = null`. `remoteStop` with `close:true` (the Android notification's Stop) goes to `stopAndClose` too. Nothing in that path pauses the element or clears its source. So an element that is audible while the machine says `interrupted` keeps playing after Stop, with the bar hidden and the media session released.\n\n4. The scenario is reachable. The `pause()` comment itself records that this drift happens. The `elementResumed` reconcile (interrupted -> playing) makes it rarer, since it needs the element's play event to reach the manager. It does not stop the drift that the `pause()` fix was written for.\n\n5. It is not deliberate. The only design note is the \"nothing audible\" comment, and the `pause()` postcondition that \"pause() is silence\" contradicts that assumption. Nothing I found says Stop is meant to skip that postcondition.\n\nSeverity is medium: it only happens after the drift has already occurred, but the result is audio playing with no control to stop it (the same class as L-05, which `stop()`'s own comment calls the worst version of F12). I did not run the tests; the reducer branch is plain enough to confirm by reading.",
  "merged_ids": [],
  "lane": "L3-player-and-native-tts"
}
```

## player-core-8: playForay drops the outgoing episode's and Foray's position (no flush), unlike play()

**confirmed** · verifier severity **low** (finder: low) · player-core · duplicated-logic-drift · `player/client.js:4323` · L3-player-and-native-tts

```json
{
  "id": "player-core-8",
  "area": "player-core",
  "category": "duplicated-logic-drift",
  "title": "playForay drops the outgoing episode's and Foray's position (no flush), unlike play()",
  "file": "player/client.js",
  "line": 4323,
  "severity": "low",
  "scenario": "`ForayPlayer.play()` calls `flushPositions()` before replacing the queue ('LEAVING IS A FLUSH, BOTH STORES', audit round 2 player-3). The reason given is that the reducer's `play` from `playing` emits no `savePosition`, and nothing writes while paused. `playForay()` has no such flush. It overwrites `foray` (so `persistForayProgress` can no longer write the outgoing Foray) and replaces the queue. Starting a Foray from an episode that is playing loses up to `POSITION_MIN_DELTA_SEC` (10 s) of the episode position. After pause-then-scrub, the whole scrub is lost. Switching Foray A to Foray B loses A's latest progress, which is up to the store's 5 s throttle, or a paused scrub.",
  "evidence": "client.js:3566 (play) `flushPositions();` before `foray = null` / `setQueueFromPick`. client.js:4317-4330 (playForay) `backend.notePlayGesture(); ... foray = { resolved, index: -1, ... }; ... const report = manager.setQueueFromForay(resolved.hydrated, ...)`, with no flush. queue-state.js:328-336: `play` from `playing` emits `pausePlayback, loadItem, telemetry` and no `savePosition`.",
  "fix_sketch": "Call `flushPositions()` at the top of `playForay`, before `foray` is reassigned and before `setQueueFromForay`, mirroring `play()`.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read the code at origin/main and the finding holds. In player/client.js, play() calls flushPositions() at line 3566 before `foray = null` and before the queue is replaced. The comment there, \"LEAVING IS A FLUSH, BOTH STORES (audit round 2, player-3)\", says this is deliberate. playForay() (starting around line 4303) has no such call. It runs notePlayGesture, then interlude.prime, then overwrites `foray = {resolved, index:-1,...}`, then calls manager.setQueueFromForay.\n\nOnce `foray` is overwritten with index -1, persistForayProgress returns early for the new Foray and can no longer reach the outgoing Foray's id. setQueueFromForay goes through loadQueue(), which only resets `queue` and `currentIndex = -1` and saves nothing, so the outgoing episode can no longer be written either.\n\nNothing upstream flushes on the way in. The app.js callers are startHomeForay (line 9155) and the start/startAt paths through guardForayStart (12484-12485). Both call playForay straight away with no stop or flush first, and they have to, because of the #225 rule that nothing may run between the tap and the call. A flush is synchronous, so adding one inside playForay would not break that rule. The only other paths that flush are pagehide/visibility, stopAndClose and native-session events, and none of them runs at this switch.\n\nThe comment on play() spells out the exact data-loss mechanism: a playing position can be up to about 10 s stale, and a scrub made while paused is never written by the reducer. That same loss happens here, and nothing in the code marks the omission as intentional. The loss is bounded (seconds, or one paused scrub), so severity is low. The fix is the one-line flushPositions() at the top of playForay, before `foray` is reassigned. I did not run a test.",
  "merged_ids": [],
  "lane": "L3-player-and-native-tts"
}
```

## player-core-9: Concurrent _handle calls can run a stale loadItem after a newer one, leaving the reducer's target different from what is loaded

**confirmed** · verifier severity **low** (finder: low) · player-core · race-condition · `player/queue-manager.js:1086` · L3-player-and-native-tts

```json
{
  "id": "player-core-9",
  "area": "player-core",
  "category": "race-condition",
  "title": "Concurrent _handle calls can run a stale loadItem after a newer one, leaving the reducer's target different from what is loaded",
  "file": "player/queue-manager.js",
  "line": 1086,
  "severity": "low",
  "scenario": "`_handle` sets `this.state` synchronously, then awaits each effect in turn. A skip from a playing synth narration item emits [savePosition, pausePlayback, loadItem(C)], and pausePlayback is `_pauseNarration`, which awaits a real Capacitor round trip. A second Next during that await reduces `loadingItem(C)` to `loadingItem(D)`, and its `loadItem(D)` runs immediately. The first skip's `loadItem(C)` then runs after it and claims a newer `_loadSeq`, so D's load is 'superseded'. C's load then dispatches `itemLoaded` into `loadingItem(D)`. The reducer becomes `playing(D)` and arms `setOutPoint(D.bounds.endSec)` on C's timeline, while `currentIndex` points at C: a wrong out-point on the wrong episode.",
  "evidence": "queue-manager.js:1076-1087 `const [next, effects] = reduce(this.state, event); this.state = next; ... for (const effect of effects) await this._perform(effect);`. queue-manager.js:1330 `if (this._loadedIsSynth) return this._pauseNarration();` (awaits `_ttsTransport(\"pause\")`). `_loadItem` never checks that `ref` still equals `this.state.target`.",
  "fix_sketch": "In `_loadItem`, drop the load if `this.state.type === \"loadingItem\" && !sameRef(this.state.target, ref)` (a newer transition has already chosen a different target). Alternatively, serialise `_handle` through a promise queue so one event's effects finish before the next event is reduced.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main and the race is real. Nothing serialises `_handle`. `_transport` (queue-manager.js ~734) only cuts or parks the seam beat and tracks the offset-arming token. It does not queue actions, so a second `skipToNext()` reduces against `this.state` while the first skip is still awaiting its effects (lines 1074-1087).\n\nThe scenario, step by step:\n1. The first skip runs from `playing` on a synth item. In queue-state.js, `handleSkip` emits [savePosition, pausePlayback, loadItem(C), telemetry]. `pausePlayback` maps to `_pauseNarration` (line 1330), which sets `_narrationPaused` and then awaits `_ttsTransport(\"pause\")`. That is a real Capacitor bridge round trip.\n2. A second Next during that await picks its target from `_cursor()`. That is `_targetIndex ?? currentIndex`, and `_targetIndex` is still C's index because only `_loadItem` clears it. So the target is D.\n3. The reducer's `loadingItem` branch replaces the target and emits [loadItem(D)] as its first effect. `_loadItem(D)` bumps `_loadSeq` synchronously, sets `currentIndex = D` and starts loading.\n4. The bridge returns, and the first skip's `_loadItem(C)` claims a newer seq and sets `currentIndex` back to C. `_loadItem` has no check that `ref` still matches `this.state.target`.\n5. D's load reaches the seq check after `backend.load` (or `_awaitSeamGap` on the synth path) and is dropped as superseded.\n6. C's load passes both checks and dispatches `itemLoaded`. `handleItemLoaded` in state `loadingItem(D)` builds its effects from `state.target`, which is D. The result is `playing(D)` plus `setOutPoint(D.bounds.endSec)` applied to C's timeline, with `currentIndex` on C.\n\nThe `_transport` comment and the \"fast double-skip serialisation\" comment in the reducer assume the second skip's load is the newest. Neither covers this ordering. No DECISIONS or comment rationale makes the behaviour deliberate.\n\nWhy severity is low: the window is one bridge round trip, and a second skip only lands in it when the first skip leaves from an unpaused synth narration item. `_pauseNarration` returns early when already paused, and the non-synth `backend.pause`/`_persistPosition` paths are effectively synchronous. Two human taps inside a few-to-tens-of-ms window are unlikely, though Android's emulated pause (stop plus bookkeeping) may widen it. When it does happen, the effect is serious (a wrong out-point on the wrong episode, and state disagreeing with `currentIndex`). The finding's fix is sound: in `_loadItem`, bail if the state is `loadingItem` with a different target, or serialise `_handle`.\n\nI did not run a test; this rests on reading the code.",
  "merged_ids": [],
  "lane": "L3-player-and-native-tts"
}
```

## player-core-10: Known-car-route auto-resume is dead code: routeChanged(available) is never called and _knownCarRoutes is never filled

**confirmed** · verifier severity **low** (finder: low) · player-core · dead-code · `player/queue-manager.js:1042` · L3-player-and-native-tts

```json
{
  "id": "player-core-10",
  "area": "player-core",
  "category": "dead-code",
  "title": "Known-car-route auto-resume is dead code: routeChanged(available) is never called and _knownCarRoutes is never filled",
  "file": "player/queue-manager.js",
  "line": 1042,
  "severity": "low",
  "scenario": "Corner case #13 says audio resumes when a known car route comes back, and the manager implements this policy. The only production caller, `onNativeSession`, calls `routeChanged` only with `{ oldDeviceUnavailable: true }` and never passes `routeName` or `isCarRoute`. So `_knownCarRoutes` stays empty and the auto-resume branch can never run. The route-available `E.routeChanged(false)` path is also unreachable. Readers and tests assume a behaviour that does not ship. The resume branch also never checks `_pausedByListener`, which `interruptionEnded` treats as load-bearing, so if it were wired it would resume a pause the listener made themselves.",
  "evidence": "client.js:470-474 `if (kind === \"routeChange\" && detail.reason === \"old-device-gone\") { manager.routeChanged({ oldDeviceUnavailable: true }) ...`. That is the only non-test caller (git grep). queue-manager.js:1028 `if (isCarRoute && routeName) this._knownCarRoutes.add(routeName);`. queue-manager.js:1042-1048 `if (!oldDeviceUnavailable && routeName && this._knownCarRoutes.has(routeName)) { ... await this._handle(E.play(refOf(item))); }`, with no `_pausedByListener` guard.",
  "fix_sketch": "Either wire the native `routeChange` new-device events through with the route name and a car flag, and add `!this._pausedByListener` to the resume condition, or delete the branch and `_knownCarRoutes` and update the header comment to say that reconnecting never resumes.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked this against origin/main and the finding holds.\n\n- **Only one production caller.** git grep finds one non-test call to `routeChanged`. It is in client.js:470-471, inside `onNativeSession`, and it runs only when `detail.reason === \"old-device-gone\"`. It passes just `{ oldDeviceUnavailable: true }`, with no `routeName` and no `isCarRoute`.\n- **The car-route set is never filled.** Because of that, the `_knownCarRoutes.add` at queue-manager.js:1028 never runs in production. The `else` branch that calls `E.routeChanged(false)` (line 1039) and the auto-resume block (lines 1042-1049) are unreachable.\n- **Only a test uses it.** queue-manager.test.js:323-331 is the one place that exercises the branch.\n- **Not a deliberate choice.** The client.js header comment (lines 442-444) says the route-change path \"can only stop audio, never start it\". docs/research/carplay-feasibility.md:86-89 describes the resume as a \"latent hook\" that nothing calls with `isCarRoute: true`. That is an acknowledgement that the hook is latent, not a DECISIONS.md ruling to keep dead code. I found nothing on car routes in DECISIONS.md.\n- **The native side does not rescue it.** ios/App/Player/PlayerQueueManager.swift:684-688 has its own `maybeAutoResumeForKnownCarRoute` in a separate Swift engine. That does not reach the JS manager, which gets only the \"old-device-gone\" route change.\n- **The `_pausedByListener` point is right but has no effect today.** The resume condition checks only `interrupted` and `wasPlaying`, not `_pausedByListener`. `interruptionEnded` (line 1015) says `wasPlaying` alone cannot tell a listener's own pause from an OS interruption. So if the branch were ever wired, it could resume a pause the listener made themselves. Since the branch cannot run, nothing a user does can trigger this today.\n\nSeverity is low. Nobody is affected in the current build: the effect is a misleading \"corner case #13 resumes for a known car\" policy and a test for behaviour that does not ship, plus a missing guard that matters only if someone wires the branch later. I did not run a test; reading the source was enough.",
  "merged_ids": [],
  "lane": "L3-player-and-native-tts"
}
```

## player-rest-1: One hung IndexedDB transaction stalls every later durable write, including the vault write of a refreshed auth token, and makes Delete my data hang

**confirmed** · verifier severity **high** (finder: high) · player-rest · correctness · `player/durable-store.js:893` · L3-player-and-native-tts

```json
{
  "id": "player-rest-1",
  "area": "player-rest",
  "category": "correctness",
  "title": "One hung IndexedDB transaction stalls every later durable write, including the vault write of a refreshed auth token, and makes Delete my data hang",
  "file": "player/durable-store.js",
  "line": 893,
  "severity": "high",
  "scenario": "iOS shell. The app comes back from the background and one IDB `put` never fires oncomplete/onerror/onabort. client.js:257-262 already documents that WKWebView does this. Every durable-store operation runs on the single serial `this._queue`: ordinary writes (`_enqueue`, l.1011), vault writes and removals of `cp_sb_session` (`_queueConfined`, l.881/893), the legacy move (l.1207) and `purge()` (`await this._queue`, l.678). `idb-tier.withStore` has no timeout (idb-tier.js:134-147), so the stuck op never settles and everything queued behind it waits forever. `canKeep('cp_sb_session')` still returns true (l.577), because `_unsaved` is only set after a vault op has failed, and a queued op has not failed. So app.js goes ahead with a Supabase refresh, which spends the old refresh token. The new token then sits in memory behind the stuck IDB op and never reaches the Keychain. When the app is killed, the next launch hydrates the spent token from the vault, and the listener becomes a new anonymous account. The same stall makes `store.purge()` never resolve, so the Delete my data sheet stays on 'Deleting…' with no way out (app.js clearStoredKeys awaits it with no bound). `event-log.purge()` has the same problem through its own `opQueue`. `_pending` and the queued closures, each holding its value string, grow without limit for the rest of the session.",
  "evidence": "Reproduced against origin/main durable-store.js with fake tiers: an IDB tier whose write never settles, plus a vault tier. `s.setItem('cp_pos:ep1','{}'); s.canKeep('cp_sb_session') -> true; s.setItem('cp_sb_session','NEW')`. After 200 ms: `vault holds: OLD pending: 2`, and `purge resolved: false`. Code: `this._queue = this._queue.then(async () => { try { await vault.write(key, value); ...` (l.893) shares one chain with `for (const t of this._liveAsync()) { try { await op(t); ...` (l.1011-1014). idb-tier.js: `tx.oncomplete = () => resolve(result); tx.onerror = ...; tx.onabort = ...` with no timer.",
  "fix_sketch": "(1) In idb-tier.withStore, race each transaction against a timeout of a few seconds. On timeout, reject, try `tx.abort()`, and drop the cached db promise. (2) In DurableStore, bound each queued op (Promise.race with a timeout that counts as a fault), so one tier can never stall the chain. (3) Give the vault its own queue instead of queuing it behind IDB and Preferences, or make `canKeep` return false while `_confinedInFlight` has the key. (4) Put a bound on purge's `await this._queue` and report `unverified` when it is hit.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "high",
  "verdict_reasoning": "I checked this against origin/main and reproduced it.\n\n**The code does what the finding says**\n- `durable-store.js` `_queueConfined` puts vault writes and removals of `cp_sb_session` on `this._queue` (l.~881/893).\n- `_enqueue` (l.~1011) puts ordinary IDB/Preferences writes on that same queue, one after another.\n- `idb-tier.js` `withStore` (l.134-147) settles only on oncomplete, onerror or onabort. It has no timer.\n- `openDb` does handle `onblocked`. Its comment says a promise that never settles is worse than an error. That reasoning was never applied to transactions.\n- `canKeep` (l.570-578) returns false only when the key is in `_unsaved` or the vault is disabled. A write that is queued but not yet run passes.\n- `purge()` calls `await this._queue` with no bound (l.~678).\n- `app.js` `clearStoredKeys` calls `await store.purge()` and `clearLocalData` awaits it, also with no bound. `withDeadline` is used for syncs in flight, but not for this.\n\n**Nothing on main handles it**\n- `client.js` bounds the field record's wait on hydration, and `app.js` bounds its hydrate wait at 5 s. Neither bounds the write queue.\n- No comment and no DECISIONS entry marks this as deliberate.\n- The repo's own comments say the trigger is real: `client.js` states that WKWebView IndexedDB can leave a transaction unsettled after the app has been in the background.\n\n**Reproduction** (origin/main `durable-store.js`, fake IDB tier whose write never settles, fake vault tier holding OLD):\n- After hydrate, `setItem('cp_pos:ep1')`, then `canKeep('cp_sb_session')` returned true.\n- `setItem('cp_sb_session','NEW')` followed by `purge()`: after 200 ms the vault still held OLD and purge had not resolved.\n\n**Consequence**\n- `ensureAnonSession` gets true from `canKeep` and goes ahead with the refresh, which spends the old refresh token.\n- The new token stays in memory only. After an app kill, the next launch reads the spent token from the Keychain, the refresh fails, and a new anonymous account is created. The listener's link to their data is lost.\n- Delete my data never finishes: it stays on 'Deleting…'.\n\nIt needs an IDB hang at the wrong moment, but the codebase itself records that hang as known to happen. The outcome is silent account loss plus a deletion flow that never completes, so high severity is justified.",
  "merged_ids": [],
  "lane": "L3-player-and-native-tts"
}
```

## player-rest-3: DiagnosticLog rewrites the whole 200-entry ring through every storage tier on every row and every seam stage

**deliberate** · verifier severity **low** (finder: medium) · player-rest · performance · `player/diagnostic-log.js:1784`

```json
{
  "id": "player-rest-3",
  "area": "player-rest",
  "category": "performance",
  "title": "DiagnosticLog rewrites the whole 200-entry ring through every storage tier on every row and every seam stage",
  "file": "player/diagnostic-log.js",
  "line": 1784,
  "severity": "medium",
  "scenario": "While a seam is open, `note()` calls `_stage()` for every telemetry line with a known root (load.*, play.*, audio.*, seam.*, ...), and `mediaEvent` does the same for waiting/stalled. Each `_stage` calls `this.log.save()`. That JSON.stringifies the full ring (up to 200 entries, each seam row carrying up to 12 stage objects, so tens of KB to about 100 KB) and hands it to `DurableStore.setItem`. That is a synchronous localStorage write, plus an IDB put and, in the shell, a Capacitor Preferences bridge call carrying the whole blob. `record()` (l.386), `_mediaRow` repeats (l.1198) and the tap/visibility coalescers (l.1295/1335) do the same. The result is main-thread stringify and localStorage work repeated at exactly the moment the next segment is loading, which is the latency this record exists to measure. It also queues tens of large writes on the durable serial queue ahead of position saves.",
  "evidence": "`_stage(name) { ... seam.stages.push({...}); while (seam.stages.length > STAGE_CAP) {...} this.log.save(); }`. `save() { ... this.storage.setItem(this.key, JSON.stringify(this._blob())); }`, where `_blob()` includes `entries: entries.slice()`.",
  "fix_sketch": "Coalesce saves: mark the ring dirty and save at most once per animation frame or idle callback (for example 250-500 ms), and always on visibilitychange/pagehide and when a seam closes. Keep the immediate synchronous save only for the seam-open row, where durability actually matters.",
  "duplicates": [],
  "verdict": "deliberate",
  "verdict_severity": "low",
  "verdict_reasoning": "The mechanics are accurate at origin/main. `_stage()` at player/diagnostic-log.js:1772-1785 pushes a stage and then calls `this.log.save()`. `save()` at l.438-453 runs `setItem(key, JSON.stringify(this._blob()))` on the whole ring. `_closeSeam`, `_mediaRow` repeats (l.1198) and the coalescers (l.1295/1335) also save. So the code does rewrite the whole ring on every stage.\n\nThis is a documented, deliberate trade-off, not an oversight. The file's header has a section called \"THE COST, STATED HONESTLY\" (l.114-138) that describes this exact cost: `save()` re-serialises the WHOLE ring 8 to 15 times per seam, the cost is highest at the end of a long drive, and a full ring is about 100 KB per write with a seam about every 100 seconds. It says STAGE_CAP was cut from 24 to 12 specifically to reduce this cost, and it cites the html-audio-backend.js:1534 warning about sync localStorage writes on the seam-critical path.\n\nThe same header then rejects the finding's proposed fix outright (l.129-134): \"WHAT IS NOT NEGOTIABLE IS THE PER-STAGE WRITE ITSELF. Debouncing would be the cheap fix and it would break the requirement: every stage of a seam is a separate point at which the page can be suspended, and a stage that was not written is a stage the record cannot report.\" The section \"IT MUST SURVIVE THE THING IT MEASURES\" (l.88-92) also requires the write to be durable at the moment of the event.\n\nThe finding adds two new points: the IDB/Capacitor tier fan-out, and the writes queuing ahead of position saves. Neither is quantified. The writes happen roughly 8-15 times about every 100 s, not continuously. The debounce fix it proposes is the one the authors considered and rejected.\n\nAt most there is a residual design disagreement, possibly worth a note about the non-localStorage tiers. It is not a defect.",
  "merged_ids": [],
  "lane": null
}
```

## player-rest-5: Transport click handlers drop the promise from async setRunning/forayNext/forayPrevious/foraySeek, so a rejection skips the repaint and leaves the Foray index stuck

**confirmed** · verifier severity **low** (finder: low) · player-rest · error-handling · `player/client.js:3260` · L3-player-and-native-tts

```json
{
  "id": "player-rest-5",
  "area": "player-rest",
  "category": "error-handling",
  "title": "Transport click handlers drop the promise from async setRunning/forayNext/forayPrevious/foraySeek, so a rejection skips the repaint and leaves the Foray index stuck",
  "file": "player/client.js",
  "line": 3260,
  "severity": "low",
  "scenario": "`ui.clipNext` → `ForayPlayer.forayNext()` first runs `setForayIndex(manager.currentIndex + 1)`, which sets `foray.pendingFrom`, and then awaits `manager.skipToNext()`. If that rejects (for example a backend pause/setRate throw inside `_handle`), `render()` never runs, the rejection is unhandled, and `syncForaySegment` keeps returning early on `index === foray.pendingFrom`. The page then shows the next clip as current while the old clip plays, and `forayPlayhead()` returns null (`manager.currentIndex !== foray.index`). So `persistForayProgress` records 'playhead-unknown' and stops saving the resume point until the manager moves. The play button (`toggle` → `setRunning`, l.3023) and scrub `change` (l.3268) handlers have the same no-catch shape; the restored-ribbon crash documented at l.2448 was one real instance of it.",
  "evidence": "`ui.clipPrev.addEventListener(\"click\", () => ForayPlayer.forayPrevious()); ui.clipNext.addEventListener(\"click\", () => ForayPlayer.forayNext());` and `const toggle = () => setRunning(!transportIsRunning());`, compared with the visibilitychange path, which does `reconcileOnReturn().catch(...)`.",
  "fix_sketch": "Wrap these handlers in a helper that `.catch`es, logs to diag (tapFailed/control), and always calls `render()` in a finally block. In forayNext/forayPrevious/foraySeek, reset `foray.pendingFrom` (or call `setForayIndex(manager.currentIndex, { pending: false })`) when the awaited manager call throws.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The code shape is as described at origin/main. In player/client.js, l.3260-3261 are `() => ForayPlayer.forayPrevious()` / `forayNext()` with no catch. `toggle` at l.3023 is the same, and so is the async scrub `change` at l.3268. By contrast, `visibilitychange` catches with `reconcileOnReturn().catch(...)`, and its comment says why. forayNext (l.4573) calls `setForayIndex(manager.currentIndex + 1)`, which sets `foray.pendingFrom` to the old index (l.1268), and then awaits `manager.skipToNext()` before `render()`. If anything after `setForayIndex` throws, pendingFrom is never cleared. `syncForaySegment` (l.1292) then keeps returning early while the manager stays on the old index, so foray.index points at the next clip and the old clip keeps playing. foraySeek and forayPrevious have the same shape.\n\nThe trigger the finding names does not hold up. I could not find a path by which the manager rejects:\n- **Backend calls are guarded.** HtmlAudioBackend.play, pause, seek and setRate all catch their own errors, and a play() rejection goes to onError.\n- **Load and bridge failures are caught.** `_loadItem` and `_playTransitionBridge` catch and dispatch E.error.\n- **TTS calls are caught.** `_ttsTransport` has a try/catch.\n- **Position saves are guarded.** `_persistPosition` goes to a position store that wraps its writes in try/catch.\n\nSo \"a backend pause/setRate throw inside `_handle`\" is not reachable today. The claim that \"render() never runs\" is also partly wrong. `onStateSettled: () => render()` (l.3378) repaints after every settled `_handle`, including nested ones, so the page only misses a repaint if `_handle` itself throws.\n\nThe failure is still possible from client-side code. `setForayIndex` calls `setNowPlaying` synchronously after setting pendingFrom, and a throw there leaves the index stuck before the manager is even asked to move. The l.2448 comment records a real client-side throw in one of these unguarded handlers (the restored-ribbon crash), so this class of bug has already happened once. Nothing in DECISIONS.md or the code comments says the missing catch is deliberate.\n\nI did not run a test. The finding holds as a real but unlikely gap, so low severity is right.",
  "merged_ids": [],
  "lane": "L3-player-and-native-tts"
}
```

## player-rest-6: Media-session playbackState/positionState dedupe is recorded before the write, so a failed write is never retried (the metadata fix was not applied to these two)

**refuted** · verifier severity **low** (finder: low) · player-rest · correctness · `player/media-session.js:725`

```json
{
  "id": "player-rest-6",
  "area": "player-rest",
  "category": "correctness",
  "title": "Media-session playbackState/positionState dedupe is recorded before the write, so a failed write is never retried (the metadata fix was not applied to these two)",
  "file": "player/media-session.js",
  "line": 725,
  "severity": "low",
  "scenario": "The metadata path was fixed to set `lastMetaKey` only after a successful write (l.720, 'poisoned the dedupe'). `playbackState` and `setPositionState` still record the key before attempting the write. If the shim's `playbackState` setter or `setPositionState` throws once (bridge not ready, native error), every later render computes the same key and skips the write. The lock screen or car keeps the stale state (for example still PLAYING after a pause) until the state value changes again.",
  "evidence": "`if (playbackState && playbackState !== lastState) { lastState = playbackState; const stateOk = attempt(() => { ms.playbackState = playbackState; return true; }) === true; ...` and `if (key !== lastPositionKey) { lastPositionKey = key; attempt(() => ms.setPositionState(positionState)); }`.",
  "fix_sketch": "Match the metadata branch: assign `lastState` only when `stateOk`, and `lastPositionKey` only when `setPositionState` returned without throwing.",
  "duplicates": [],
  "verdict": "refuted",
  "verdict_severity": "low",
  "verdict_reasoning": "The finding quotes the code correctly. At origin/main, player/media-session.js l.724-727 sets `lastState = playbackState` before the attempted write, and l.746-748 sets `lastPositionKey = key` before `attempt(() => ms.setPositionState(...))`. The metadata branch (l.718) only stamps its key after a successful write. So the asymmetry exists. The scenario it depends on, a single failed write that a retry would fix, cannot actually happen.\n\n(1) In the shipping native shell, `ms` is the shim in mobile/plugins/foray-audio/web/foray-media-session.js. Its `set playbackState` (l.1095-1099) only does three things: stores `str(value)`, calls `mirrorPlaybackState`, which wraps the WebKit write in its own try/catch and logs (l.1241-1248), and calls `scheduleFlush`, which catches both scheduling errors and flush errors (l.850-866). Its `setPositionState` (l.1101-1109) only copies three fields and calls `scheduleFlush`. None of these can throw to the caller. The native bridge write is deferred and asynchronous, so \"bridge not ready / native error\" never reaches `update()` as a synchronous throw. Even if a flush fails, the shim has already stored the new state and sends it on the next flush.\n\n(2) In a plain browser, assigning a valid enum string to `playbackState` does not throw. WebIDL enum setters silently ignore invalid values. `setPositionState` can throw a TypeError, but only for invalid input, which `mediaPositionState()` (l.440+) validates and clamps. If it did throw, the same input would throw again, so retrying would not help.\n\n(3) While audio plays, the position key changes every tenth of a second, so the position dedupe fixes itself on the next tick. Separately, `invalidate()` (l.769-773) resets `lastState` and `lastPositionKey`, and it runs on every play.\n\nThe metadata fix was motivated by a real field case in which the `MediaMetadata` constructor or WebKit's metadata setter can throw synchronously. The two setters in this finding have no such path. Changing them for consistency would be harmless but optional. It is not a reachable defect.",
  "merged_ids": [],
  "lane": null
}
```

## search-api-css-1: Modifier words are consumed as filters unconditionally: 'deep learning' returns 805 random long episodes with status ok

**confirmed** · verifier severity **medium** (finder: high) · search-api-css · correctness · `search-engine.js:723` · L4-web-platform

```json
{
  "id": "search-api-css-1",
  "area": "search-api-css",
  "category": "correctness",
  "title": "Modifier words are consumed as filters unconditionally: 'deep learning' returns 805 random long episodes with status ok",
  "file": "search-engine.js",
  "line": 723,
  "severity": "high",
  "scenario": "The listener types 'deep learning' into topic search. 'deep' is a duration_min(60) modifier, so it becomes a filter and is removed from the content tokens. 'learning' is in GENERIC_WORDS, so no content tokens are left. searchWithRelaxation then takes the zero-content path (line 1321) and returns the whole pool of episodes of 60 minutes or more, ranked by interestScore. classifyResults labels that 'ok'. Reproduced against origin/main's data/discover.json, item-tags.json and semantic-index.json: 805 results, status ok, top picks 'Biggest Mysteries in Physics: Antimatter' and 'FFmpeg: The Incredible Technology Behind Video'. The same shadowing hits 'deep sea' (filtered to 60 minutes or more), 'new york history' (restricted to the last 90 days, with no relaxation because a few recent items match), 'speed of light' ('light' becomes the comedy branch) and 'story' (a storytelling concept term that becomes the history branch filter, so the concept can never be reached). This breaks the engine's honesty principle: filler is presented as a confident answer.",
  "evidence": "search-engine.js:722-725\n  const contentTokens = tokens.filter(tok => {\n    if (mods[tok]) { filters.push(mods[tok]); return false; }\n    return true;\n  });\nsearch-engine.js:1321-1323 (zero groups: every filtered item is returned at rankFallback score). app.js:5083 `if (!interp.groups.length && !interp.filters.length) return null;` only bails out when there are no filters either. semantic-index modifiers: deep->duration_min 60, new->recency_days 90, light/easy->branch comedy, story->branch history (story is also a storytelling concept term).",
  "fix_sketch": "(1) When a query token is a modifier but also a concept term, or is adjacent to a content/generic token that forms a known concept, keep it as content and do not make it a filter; at minimum, check concept membership before `mods[tok]`. (2) If modifiers consumed every token only because GENERIC_WORDS stripped the rest (the original query had non-modifier words), treat the query as content, not as a pure-filter query, and return empty or thin rather than the whole pool. Add battery cases for 'deep learning', 'deep sea', 'speed of light' and 'story'.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the code at origin/main and the finding holds. In search-engine.js interpretQuery (lines 722-725), any token found in semantic.modifiers is turned into a filter and dropped from the content tokens, with no check for concept membership or neighbouring words. GENERIC_WORDS contains \"learn\" and \"learning\". The semantic index has deep->duration_min 60, new->recency_days 90, light/easy->branch comedy and story->branch history, and \"story\" is also a term in the storytelling concept. In searchWithRelaxation, when there are no groups, every episode that passes the filters is returned with the rankFallback score. app.js scoredResultsFor returns null only when there are no groups and no filters, so a query that was all filters goes straight into classifyResults.\n\nI ran the queries against origin/main's discover.json, item-tags.json and semantic-index.json:\n- \"deep learning\": groups=[], filters=[duration_min 60], 805 results, status ok, top picks the Antimatter and FFmpeg episodes. This matches the finding exactly.\n- \"story\": groups=[], filters=[branch history], 197 results, status ok. The storytelling concept can't be reached.\n- \"speed of light\": groups=[speed], filter branch comedy. It relaxed to \"all\" and returned 59 \"speed\" results, status ok, all sports-speed episodes. That is off-topic, but not because of the filter.\n\nTwo of the side examples are overstated. \"deep sea\" returns 13 results with status sparse, not a confident answer. \"new york history\" returns 7 results, sparse. The 90-day restriction does happen, but the page is flagged thin, not presented as a confident answer.\n\nNothing in docs/DECISIONS.md or the code comments protects this collision. Bare-modifier queries such as \"short\" are deliberate (see the rankFallback comment), but \"deep learning\" being swallowed is plainly not.\n\nI rate it medium, not high. The bug is real and breaks the honesty principle on plausible queries (\"deep learning\", \"story\"). But it only hits the fixed list of 28 modifier words, and several of the cited examples already come back as sparse.",
  "merged_ids": [],
  "lane": "L4-web-platform"
}
```

## search-api-css-2: 'constructor' in a topic query hits Object.prototype: the token is silently dropped, or the search throws a TypeError

**confirmed** · verifier severity **medium** (finder: medium) · search-api-css · correctness · `search-engine.js:723` · L4-web-platform

```json
{
  "id": "search-api-css-2",
  "area": "search-api-css",
  "category": "correctness",
  "title": "'constructor' in a topic query hits Object.prototype: the token is silently dropped, or the search throws a TypeError",
  "file": "search-engine.js",
  "line": 723,
  "severity": "medium",
  "scenario": "`mods` is the JSON-parsed `semantic.modifiers` object, a plain object with a prototype. tokenize lowercases and keeps [a-z0-9], so the token 'constructor' reaches `mods[tok]`, which returns `Object` (truthy). The Object function is pushed as a filter and the word is dropped. Query 'constructor' alone: groups=[] and filters=[Object], so the whole pool comes back ranked by interest. Query 'constructor theory' when nothing matches 'theory' under that filter: searchWithRelaxation evaluates `f.type.startsWith(\"duration\")` on the Object function (f.type is undefined) and throws 'Cannot read properties of undefined (reading startsWith)'. Reproduced with node on origin/main's search-engine.js and semantic-index.json.",
  "evidence": "search-engine.js:723 `if (mods[tok]) { filters.push(mods[tok]); return false; }`\nsearch-engine.js:1362 `if (!results.length && interp.filters.some(f => f.type.startsWith(\"duration\"))) {`\nnode repro: interpretQuery('constructor theory') -> groups ['theory'], filters [ [Function: Object] ]; searchWithRelaxation -> THREW Cannot read properties of undefined (reading 'startsWith')",
  "fix_sketch": "Use `Object.hasOwn(mods, tok) ? mods[tok] : undefined` (and the same for ALIASES/concepts lookups by token), or build `mods` as a Map or Object.create(null) at ctx load. Make the relaxation guard defensive: `typeof f?.type === \"string\" && f.type.startsWith(...)`. Add a test for 'constructor', 'constructor theory' and 'hasownproperty'.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I checked this against origin/main and it holds. In interpretQuery (search-engine.js:718-724), `mods` is `ctx.semantic?.modifiers || {}`. That is a plain object with a prototype, and the check `if (mods[tok]) { filters.push(mods[tok]); return false; }` has no own-property guard. tokenize (line 232) keeps lowercase [a-z0-9] tokens of 2 to 64 characters, and 'constructor' is not in STOPWORDS or GENERIC_WORDS, so it reaches that check.\n\nI ran a node repro on origin/main's search-engine.js and data/semantic-index.json:\n- interpretQuery('constructor') gives filters [[Function: Object]] and 0 groups.\n- interpretQuery('constructor theory') gives the same filter and 1 group.\n- searchWithRelaxation throws 'Cannot read properties of undefined (reading 'startsWith')' at line 1362 whenever the first attempt returns nothing. This happens every time with an empty pool, and in the real app whenever nothing matches under the bogus filter.\n\npassesFilters ignores a filter whose type it does not recognise. So the Object filter lets every item through: a bare 'constructor' returns the whole pool ranked by interest, and the word is silently dropped. 'hasownproperty' and 'tostring' did not reproduce, because those tokens are not in the vocabulary or are dropped some other way. 'constructor' is the case that matters.\n\napp.js:4349-4355 calls interpretQuery and then searchWithRelaxation on the live search path. I found no own-property guard or try/catch in the search engine, and no rationale in DECISIONS.md.\n\nA real user could plausibly type this: 'constructor theory' is a genuine physics topic. The result is either a thrown error on the search path or silently wrong results. Nothing is corrupted or exposed, so medium severity is right.",
  "merged_ids": [],
  "lane": "L4-web-platform"
}
```

## search-api-css-3: No per-show feed cache: every show-page search keystroke and every episode page re-downloads and re-parses the whole RSS feed

**confirmed** · verifier severity **medium** (finder: medium) · search-api-css · performance · `api/episodes/search.ts:265` · L4-web-platform

```json
{
  "id": "search-api-css-3",
  "area": "search-api-css",
  "category": "performance",
  "title": "No per-show feed cache: every show-page search keystroke and every episode page re-downloads and re-parses the whole RSS feed",
  "file": "api/episodes/search.ts",
  "line": 265,
  "severity": "medium",
  "scenario": "On a show page, runSearch (app.js:4800) calls /api/episodes/search?show=<id>&q=<query> on each debounced keystroke. Each distinct q misses episodeSearchCache (the key includes q), so searchWithinShow runs fetchFeedConditional plus parseFeed on the full feed again: 2 MB for Lex Fridman, with a measured 165-2082 ms origin floor. That is paid on every keystroke. api/shows/[show_id]/episodes.ts:238 does the same for each cursor page, so loading a 5-page show fetches and parses the same feed 5 times, which is the latency the founder complained about on 2026-09-21. The comment at search.ts:40 says 'Nothing in this file moves that number', but a short per-instance cache of the parsed episodes would remove it for every request after the first.",
  "evidence": "search.ts:265 `const fetchResult = await fetchFeedConditional(meta.feedUrl, { etag: null, lastModified: null }, {...})` runs on every cache miss keyed by `${show}::${limit}::${q}`.\nepisodes.ts:238 `const fetchResult = await fetchFeedConditional(meta.feedUrl, { etag: null, lastModified: null });` runs for every page request; only the CDN (per exact URL including cursor) caches.",
  "fix_sketch": "Add api/_lib/feedCache.ts: a TtlCache<ParsedFeed> keyed by show_id (about 5 minutes) that stores the parsed episodes plus the etag and last-modified values. Both handlers read through it, and a stale entry is revalidated with a conditional GET (the etag state this file currently throws away). Cap the entry count (LRU) so it stays bounded.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main and the finding holds. In api/episodes/search.ts, searchWithinShow at about line 265 calls fetchFeedConditional(meta.feedUrl, {etag:null, lastModified:null}) and then runs parseFeed on the whole body on every miss of episodeSearchCache. searchCache.ts:normalizeQueryKey builds that cache key as show::limit::q, so each new query text misses. Nothing caches the parsed feed per show. The only per-show memory is episodeFeedFailureCache (90 s), and it holds failures only. The episode list at api/shows/[show_id]/episodes.ts:238 does the same unconditional fetch and full parse for every cursor page before it paginates in memory. Its own header says nothing is kept between invocations and the CDN s-maxage=3600 (per exact URL) is the only saving, so the first load of each page, and each cursor, pays the origin fetch and parse again. I found no DECISIONS.md entry or comment that rejects a warm-instance parsed-feed cache. The search.ts:40 comment \"Nothing in this file moves that number\" is about the origin floor of a single fetch, not a ruling against caching. The repo already uses per-instance TtlCaches (episodeSearchCache, appleShowCache), so the fix sketch fits existing patterns. One correction to the scenario: app.js runSearch is debounced by 250 ms (onSearchInputChange), so the cost is paid per debounced pause or Enter, not per keystroke. That lowers the frequency, but each distinct query still re-downloads and re-parses the feed (up to about 2 MB, 165 to 2082 ms). I did not verify the claimed founder complaint of 2026-09-21. The issue is latency and wasted work, not incorrect results, so medium severity is appropriate.",
  "merged_ids": [],
  "lane": "L4-web-platform"
}
```

## search-api-css-5: Helper modules and api/test/*.mjs sit under api/ without a leading underscore, so Vercel deploys each one as a public function

**confirmed** · verifier severity **low** (finder: medium) · search-api-css · ci-tooling · `vercel.json:9` · L4-web-platform

```json
{
  "id": "search-api-css-5",
  "area": "search-api-css",
  "category": "ci-tooling",
  "title": "Helper modules and api/test/*.mjs sit under api/ without a leading underscore, so Vercel deploys each one as a public function",
  "file": "vercel.json",
  "line": 9,
  "severity": "medium",
  "scenario": "Vercel's zero-config api/ convention builds every supported source file under api/ as a serverless function unless the file or a parent directory starts with '_'. There is no .vercelignore on main. So api/episodes/appleBucket.ts, searchCache.ts, showIdMap.ts, api/shows/appleShowSearch.ts and the 11 api/test/*.test.mjs files all deploy as routes, each bundled with the 12.5 MB includeFiles catalogue (`api/**/*.ts`). A GET to /api/episodes/appleBucket errors with no valid default export. A GET to /api/test/episodes-search.test loads a node:test file, which registers its tests and runs them inside the function: it stubs globalThis.fetch and hits handlers. That is unauthenticated CPU spend, and more functions also add build minutes, which the founder flagged as the main cost of the Vercel bill. cors.ts already follows the correct `_lib` convention; the other helpers do not. Marked plausible: not confirmed against a live deployment's function list.",
  "evidence": "vercel.json:8-11 `\"functions\": { \"api/**/*.ts\": { \"includeFiles\": \"data/{catalog.json,catalog-breadth.json,shows-index-pointer.json}\" } }`\nFiles: api/episodes/appleBucket.ts, api/episodes/searchCache.ts, api/episodes/showIdMap.ts, api/shows/appleShowSearch.ts, api/test/*.test.mjs. None has an '_' prefix, and no .vercelignore exists (`git show origin/main:.vercelignore` reports that the path does not exist).",
  "fix_sketch": "Move the helpers to api/_lib/ (or api/episodes/_*.ts) and the tests to api/_test/ or out of api/, updating api/package.json's test glob, the vercel-bundle test's discovery and the imports. Alternatively, add a .vercelignore that excludes api/test/**. Then check the function list in a preview deployment's Functions tab.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked the repo at origin/main and the setup is as described. vercel.json uses framework:null and a functions glob `api/**/*.ts` whose includeFiles is data/{catalog.json,catalog-breadth.json,shows-index-pointer.json}. There is no .vercelignore; `git cat-file -e origin/main:.vercelignore` fails. Under api/ there are:\n- two helpers that already use the underscore convention: `_lib/cors.ts` and `_lib/episodeCursor.ts`\n- four real handlers: episodes/search.ts, shows/[show_id]/episodes.ts, shows/index/[...path].ts and shows/search.ts\n- four helpers with no underscore: episodes/appleBucket.ts, episodes/searchCache.ts, episodes/showIdMap.ts and shows/appleShowSearch.ts. None of them has an `export default`.\n- 11 `api/test/*.test.mjs` files\n\nVercel's zero-config rule builds every js/mjs/ts/tsx file under api/ as a function. It skips only paths that start with `_` or `.`, node_modules, and .d.ts files. It has no test-file exclusion. So the four helpers and the 11 tests become deployed functions, 19 in total instead of 4.\n\nNothing on main treats this as deliberate. docs/DECISIONS.md does not cover it. The `_lib` convention is already used for cors.ts and episodeCursor.ts, which shows the fix pattern is known. tools/web/vercel-should-build.mjs lists \"api/test/\" only so that changes there don't trigger builds. It does not stop those files from being deployed. api/package.json says Vercel \"auto-detects and bundles this directory's functions\".\n\nCorrections to the finding:\n1. The 12.5 MB includeFiles bundle applies only to the extra .ts helpers. The .mjs tests don't match the `api/**/*.ts` functions key, so they are traced and deployed without that data.\n2. The claim that a GET to a test route runs its tests is unproven. node:test does auto-run tests registered at top level. But the tests import `../episodes/search.ts` with a .ts extension, and whether that resolves inside the deployed Node runtime depends on the runtime version and how @vercel/node transpiles. The call may just return a module-load 500.\n3. Test routes stubbing globalThis.fetch would affect only their own instance, not the real handlers.\n4. Nothing was checked against a live deployment's function list.\n\nReal impact: about 15 junk public routes, extra build and bundle work, and noise at the function-count limit. Each junk route either errors (the helpers) or maybe runs unit tests. That is real waste and a hygiene problem, but not a security or correctness bug. So the finding is confirmed, with severity lowered to low.",
  "merged_ids": [],
  "lane": "L4-web-platform"
}
```

## search-api-css-6: Topic-search tokenizer does not fold diacritics, so accented queries split into junk 'thin' fragments

**confirmed** · verifier severity **low** (finder: low) · search-api-css · correctness · `search-engine.js:232` · L4-web-platform

```json
{
  "id": "search-api-css-6",
  "area": "search-api-css",
  "category": "correctness",
  "title": "Topic-search tokenizer does not fold diacritics, so accented queries split into junk 'thin' fragments",
  "file": "search-engine.js",
  "line": 232,
  "severity": "low",
  "scenario": "tokenize runs `q.toLowerCase().split(/[^a-z0-9]+/)`, and itemWordSet (line 438-439) splits catalogue text the same way. 'pokémon' becomes ['pok','mon'], 'café racer' becomes ['caf','racer'], and 'naïve bayes' becomes ['na','ve','bayes']; all of them are marked thin (verified with node). Because every thin token is required to match (searchWithRelaxation:1354), these queries collapse to empty or accidental fragment matches. Show search was fixed to fold (foldDiacritics, audit round 2 search-9), but the topic path was not, so the two search modes now treat the same input differently.",
  "evidence": "search-engine.js:232-235\nfunction tokenize(q) {\n  return q.toLowerCase().split(/[^a-z0-9]+/)\n    .filter(w => w.length > 1 && ...);\n}\nnode: interpretQuery('naïve bayes') -> tokens ['na(thin)','ve(thin)','bayes(thin)']",
  "fix_sketch": "Apply foldDiacritics() inside tokenize and inside itemWordSet (and to the text scoreMatch lowercases), so both the query and the corpus fold the same way. Add accented cases to test/search-matcher.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked this against origin/main and it holds. search-engine.js:232-235 `tokenize` runs `q.toLowerCase().split(/[^a-z0-9]+/)` with no fold, and `itemWordSet` (437-441) splits catalogue text the same way. `interpretQuery` (715) calls `tokenize` directly. The only caller, app.js:5082 `scoredResultsFor`, passes the raw query without folding it first. `foldDiacritics` (1833) exists and is exported, but only show search uses it (rankShows, shard functions, lines 2033-2366). Nothing in docs/DECISIONS.md says the topic path is meant to skip folding: the diacritic notes at lines 2780 and 3321 cover only show-index titles. I ran interpretQuery with node and reproduced the reported output: 'pokémon' gives [pok(thin), mon(thin)], 'café racer' gives [caf(thin), racer], and 'naïve bayes' gives [na, ve, bayes], all thin. searchWithRelaxation:1354 requires `thinMatched === thinAnchorCount`, so every one of those fragments has to match. One correction to the scenario: the query and the corpus split the same way, so 'pokémon' can still match a catalogue 'Pokémon' through the 'pok' and 'mon' fragments. It is not always empty. The real bugs are (a) a mismatch when one side is accented and the other is not ('pokemon' against 'Pokémon', or the reverse), which gives no match, and (b) 2-letter junk fragments such as 'na' and 've' that can match by accident. It only affects accented input in topic search. Show search already folds, so the fix is small. Low severity is right.",
  "merged_ids": [],
  "lane": "L4-web-platform"
}
```

## search-api-css-7: Index proxy marks unversioned URLs 'immutable' and fetches upstream with no timeout or size cap

**confirmed** · verifier severity **low** (finder: low) · search-api-css · correctness · `api/shows/index/[...path].ts:308` · L4-web-platform

```json
{
  "id": "search-api-css-7",
  "area": "search-api-css",
  "category": "correctness",
  "title": "Index proxy marks unversioned URLs 'immutable' and fetches upstream with no timeout or size cap",
  "file": "api/shows/index/[...path].ts",
  "line": 308,
  "severity": "low",
  "scenario": "/api/shows/index/manifest.json, top.json, id-map.json and shards/<pp>.json are served with `public, max-age=3600, immutable`, but the URL does not carry the release tag. The comment says 'content-addressed by the release tag', which is not true of these URLs. When the pointer is bumped to a new release, a browser that fetched without cache:'no-cache' keeps the previous release's manifest or top list for an hour and never revalidates. Only the shard fetch in app.js (7126) overrides this, with cache:'no-cache'. Separately, `fetch(upstreamUrl)` (line 265) has no AbortController, and `upstreamRes.arrayBuffer()` plus `zlib.gunzipSync` (277-280) are unbounded and synchronous. A hung GitHub redirect holds the function until the platform timeout, and an arrayBuffer() rejection mid-body is not caught, which produces a 500.",
  "evidence": "[...path].ts:308 `res.setHeader(\"Cache-Control\", \"public, max-age=3600, immutable\");`\n:265 `upstreamRes = await fetch(upstreamUrl);`\n:277 `const raw = Buffer.from(await upstreamRes.arrayBuffer());` sits outside any try.",
  "fix_sketch": "Drop `immutable` and use a short max-age or s-maxage, or put the release tag in the URL (for example ?v=<release_tag>) before claiming immutability. Wrap the fetch in an AbortController with a timeout of about 5 s. Move arrayBuffer() inside the try. Cap the bytes read, and use gunzipSync's maxOutputLength.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read the code at origin/main and it matches the finding. Most of the practical impact is latent, though.\n\nWhat holds:\n- Line 308 sets `public, max-age=3600, immutable` on every 200 response. The URL carries no release tag. The comment at 300-301 says the response is \"content-addressed by the release tag\", which is untrue of the URL: the tag only travels in the X-Shows-Index-Version header.\n- Line 265 calls `fetch(upstreamUrl)` with no AbortController or timeout.\n- Line 277 reads the body with `await upstreamRes.arrayBuffer()` outside any try. If the body stream fails partway, the rejection escapes the handler and the platform returns a 500, not the 502 `{available:false}` the file promises. The 279 try only covers gunzip and the toString call.\n- `zlib.gunzipSync` is unbounded and synchronous.\n- Nothing in docs/DECISIONS.md or the code comments justifies `immutable` here. The DECISIONS entries on immutability are about `?v=<version>`-tagged /data files, which carry a version in the URL. That supports the fix sketch.\n\nWhat weakens it:\n- The stale-manifest/top-list scenario has no caller today. A grep of origin/main (app.js, search-engine.js, sw.js, tools) finds exactly one client of `/api/shows/index/`: `fetchShardRows` at app.js:7126. That call uses `cache: \"no-cache\"`, which forces revalidation even when the response is marked immutable. manifest.json, top.json and id-map.json are never fetched by the client, so no user can see a stale copy yet. It becomes a real bug only when someone adds a fetch without no-cache.\n- Vercel's edge only caches function responses that carry s-maxage, so `max-age` alone should not produce a stale CDN copy. That is a platform behaviour I did not test.\n- The missing timeout is capped by the Vercel function timeout. On the client, the shard fetch is wrapped in `withDeadline(API_DEADLINE_MS)`, so the UI does not hang; only function time is wasted.\n- Upstream assets come from the repo's own GitHub releases. Their size is capped by the pipeline's SHARD_TOO_LARGE budget, which makes a harmful unbounded read or decompress unlikely.\n\nNet: the code defects are real (a misleading immutable header and comment, a 500 path that escapes the 502 contract, no upstream timeout), but they have little impact today. Severity: low.",
  "merged_ids": [],
  "lane": "L4-web-platform"
}
```

## search-api-css-8: showIdMap: release id-map fetch has no timeout, and one failure pins the fallback map for the instance's lifetime

**confirmed** · verifier severity **low** (finder: low) · search-api-css · error-handling · `api/episodes/showIdMap.ts:155` · L4-web-platform

```json
{
  "id": "search-api-css-8",
  "area": "search-api-css",
  "category": "error-handling",
  "title": "showIdMap: release id-map fetch has no timeout, and one failure pins the fallback map for the instance's lifetime",
  "file": "api/episodes/showIdMap.ts",
  "line": 155,
  "severity": "low",
  "scenario": "This is latent because data/shows-index-pointer.json on main has no id_map_url, but the code path exists for when it gains one. tryLoadReleaseIdMap calls `fetchImpl(pointer.id_map_url)` with no abort signal, and it runs inside the first general episode search of every cold instance, after a bucket slot has been consumed. A slow GitHub response stalls that search until the function times out. On any failure, loadShowIdMap caches the catalogue fallback as `cached`, so that warm instance never retries the release even after GitHub recovers.",
  "evidence": "showIdMap.ts:155 `const res = await fetchImpl(pointer.id_map_url);` has no signal.\n:187-189 `const fallback = loadCatalogFallback(); cached = { byCollectionId: fallback, source: ... }; return cached;`",
  "fix_sketch": "Add an AbortController timeout of about 2 s. When the source is 'catalog-fallback' because a release fetch failed (as opposed to having no pointer at all), cache it with a retry-after timestamp, for example retrying the release after 10 minutes.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The code at origin/main does what the finding says. At api/episodes/showIdMap.ts:155, `await fetchImpl(pointer.id_map_url)` is called with no AbortController or signal. At loadShowIdMap (:181-189), if tryLoadReleaseIdMap returns null for any reason (no pointer, !res.ok, a thrown error, or an empty map), the catalogue fallback is assigned to the module-level `cached`. Because line 178 returns `cached` unless forceReload is set, and search.ts:431 calls it with only `{ fetchImpl: fetch }`, a warm instance never tries the release again. No comment or DECISIONS entry says this is deliberate. The header comment even says the release is 'the intended long-term source', which a permanently pinned fallback works against.\n\nIt is less reachable than the finding says. The pointer file does exist on main now. It has version, export_version, release_tag, asset_base_url, manifest_url, published_at and counts, but no id_map_url. The only thing that writes the pointer is tools/shows/publish-release.mjs:buildPointer (lines 163-177), and it never emits id_map_url. So line 152 returns null on every call and the fetch cannot run in production. It would only become reachable if someone changed buildPointer, or edited the pointer by hand, to add that field. The header comment claiming the pointer file 'does not exist on main' is also out of date. Given the latent path is real, the defect is confirmed, and the severity stays low.",
  "merged_ids": [],
  "lane": "L4-web-platform"
}
```

## search-api-css-10: Dead CSS: rules for #pl-form/#pl-input, .cards4 and the ui-v2 utility classes match no markup

**confirmed** · verifier severity **low** (finder: low) · search-api-css · dead-code · `styles.css:909` · L4-web-platform

```json
{
  "id": "search-api-css-10",
  "area": "search-api-css",
  "category": "dead-code",
  "title": "Dead CSS: rules for #pl-form/#pl-input, .cards4 and the ui-v2 utility classes match no markup",
  "file": "styles.css",
  "line": 909,
  "severity": "low",
  "scenario": "The #pl-form playlist builder was removed from renderPlaylists (app.js:10627 'the #pl-form builder that lived here is gone'), and no template emits .cards4 or the ui-v2-surface/-surface-2/-text-muted/-text-faint/-mine/-authored classes. The rules remain: #pl-form, #pl-input and #pl-form button at 909-943; `body.ui-v2 #pl-form input/button/button:disabled` at 3869-3886; .cards4 at 743 with a hand-derived 352px floor; the utility classes at 235-247. Comments throughout the sheet still reason about them as live (for example, #cr-form 'reuses #pl-form's tokens'), which misleads the next editor, and test/ui-tokens may pin values nobody renders. Checked by extracting every class and id selector from comment-stripped styles.css and searching comment-stripped app.js, index.html, player/*.js and mobile/*.js.",
  "evidence": "styles.css:909 `#pl-form {`, :914 `#pl-input {`, :919 `#pl-form button {`, :943, :3869 `body.ui-v2 #pl-form input,`, :3879, :3885; :743 `.cards4 {`; :235-247 `body.ui-v2 .ui-v2-surface { ... }` and the other utility classes. In app.js, `pl-form`, `pl-input` and `cards4` appear only inside comments.",
  "fix_sketch": "Delete the #pl-form and #pl-input rules. Keep #cr-form's half of the shared selector lists (3870, 3880, 3886) and rewrite the #cr-form comments that point at #pl-form. Delete .cards4 and its comment block, and delete the unused ui-v2 utility classes or start using them. Re-run test/ui-tokens.test.js and the home IA test.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The finding holds at origin/main. In styles.css, #pl-form and #pl-input are styled at 909, 914, 919 and 943, and the `body.ui-v2 #pl-form` shared selectors sit at 3869, 3879 and 3885. `.cards4` is at 743, with its layout comment block at 676-732. The utility classes are at 235-247.\n\nOutside styles.css, I ran git grep across origin/main:\n- **pl-form and pl-input** appear in app.js only inside comments (5141, 6678, 8893, 10628, 10701). The other hits are the archive/legacy-ui pre-cutover files, docs, and one stub id list in player/foray-playback.test.js:959. That test stub creates fake elements; it is not markup. app.js:10628 says outright that \"the `#pl-form` builder that lived here is gone\".\n- **cards4** appears in app.js only inside comments (6616, 8876, 8881). The only template that emitted `<div class=\"cards4\">` is in the archived pre-cutover app.js. The live miniCard at app.js:5391 renders `.mini-card`, and no `.cards4` wraps it.\n- **The ui-v2 utility classes** (surface, surface-2, text-muted, text-faint, mine, authored) are not used in any live JS or HTML. I found no dynamically built class names either.\n\nNuances that do not refute the finding:\n1. `.ui-v2-text-faint` being unused is on purpose. test/ui-tokens.test.js lists it in FAINT_TEXT_EXCEPTIONS (\"A utility with no user\"), and a census test checks that nothing uses it. Deleting it means removing that exception entry and the census test too. The rule is still dead.\n2. A test comment (ui-tokens.test.js:106) calls `.ui-v2-mine` and `.ui-v2-authored` the \"only consumer\" of --amber and --violet. That is out of date: styles.css reads var(--amber) on 21 lines and var(--violet) on 37. Deleting them will not orphan the tokens, so the \"amber/violet split is actually consumed\" test still passes.\n\nThe effect is maintenance only: misleading comments such as \"#cr-form reuses #pl-form's tokens\" and a pinned exception, with no runtime bug. Severity stays low.",
  "merged_ids": [],
  "lane": "L4-web-platform"
}
```

## search-api-css-11: passesFilters recency: an episode with an unparseable release_date passes a 'new'/'today' filter, while one with no date fails it

**confirmed** · verifier severity **low** (finder: low) · search-api-css · correctness · `search-engine.js:963` · L4-web-platform

```json
{
  "id": "search-api-css-11",
  "area": "search-api-css",
  "category": "correctness",
  "title": "passesFilters recency: an episode with an unparseable release_date passes a 'new'/'today' filter, while one with no date fails it",
  "file": "search-engine.js",
  "line": 963,
  "severity": "low",
  "scenario": "`new Date(item.release_date || 0)` turns a missing date into the epoch, so the item is excluded, which is correct. A malformed or unparseable date string gives NaN, and `NaN / 86400000 > f.value` is false, so the item passes the recency filter and can show up under 'latest' or 'today' despite having no known date.",
  "evidence": "search-engine.js:962-965\n    if (f.type === \"recency_days\") {\n      const d = new Date(item.release_date || 0);\n      if ((Date.now() - d.getTime()) / 86400000 > f.value) return false;\n    }",
  "fix_sketch": "`const t = Date.parse(item.release_date); if (!Number.isFinite(t) || (Date.now() - t) / 86400000 > f.value) return false;`",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The code is as described. At origin/main, search-engine.js:957-968 `passesFilters` does `const d = new Date(item.release_date || 0); if ((Date.now() - d.getTime()) / 86400000 > f.value) return false;`. A missing or empty date becomes the epoch and is excluded. A non-empty string that won't parse gives `getTime()` = NaN, `NaN > f.value` is false, and the item passes the recency_days filter. I found nothing that makes this deliberate: no comment, and nothing about it in DECISIONS. I also found no guard for it elsewhere.\n\nIn practice it is latent, not live. The only production caller is app.js:5088 `scoredResultsFor`, which passes `poolFiltered()`, the curated discover.json pool. I checked every item in origin/main:data/discover.json: 2167 items, 0 with a missing release_date, 0 that fail to parse, and every one is in YYYY-MM-DD form. So no episode today can wrongly appear under \"new\"/\"today\". It would only happen if a malformed date got into the pool later, for example from an ingest or snapshot path that stores a raw feed string.\n\nThe fix sketch is correct and cheap: `Date.parse` plus a `Number.isFinite` guard. Severity is low: a defensive gap with no current effect on users.",
  "merged_ids": [],
  "lane": "L4-web-platform"
}
```

## search-api-css-13: episodes-search tests share the real-clock Apple bucket singleton and never reset it

**deliberate** · verifier severity **low** (finder: low) · search-api-css · test-flakiness · `api/test/episodes-search.test.mjs:32`

```json
{
  "id": "search-api-css-13",
  "area": "search-api-css",
  "category": "test-flakiness",
  "title": "episodes-search tests share the real-clock Apple bucket singleton and never reset it",
  "file": "api/test/episodes-search.test.mjs",
  "line": 32,
  "severity": "low",
  "scenario": "resetSharedState clears the id-map and failure caches but not `appleSearchBucket`, which is a module singleton on realClock with 20 calls per 60 s. The roughly 10 general-search tests that run before the burst test each consume a slot within the same minute. When a new general-path test is added (or the file is split or reordered), later tests start receiving `degraded: true, error: 'rate limit exceeded'` and fail with assertions that do not mention the bucket. The burst test's own `refused.length > 0` also depends on how many slots earlier tests already spent.",
  "evidence": "test file:32-39\nfunction resetSharedState() {\n  _resetShowIdMapCacheForTests();\n  episodeFeedFailureCache.clear();\n}\nappleBucket.ts:72 `export const appleSearchBucket = new SlidingWindowBucket(APPLE_BUCKET_CAPACITY, APPLE_BUCKET_WINDOW_MS);` uses realClock and has no reset hook.",
  "fix_sketch": "Export a test-only `_resetForTests()` on SlidingWindowBucket (clear the timestamps) and call it in resetSharedState, and do the same for episodeSearchCache. The burst test then starts from an empty bucket and can assert exactly 20 calls and 5 refused.",
  "duplicates": [],
  "verdict": "deliberate",
  "verdict_severity": "low",
  "verdict_reasoning": "The mechanics check out at origin/main. resetSharedState (api/test/episodes-search.test.mjs:32-39) clears only the id-map cache and episodeFeedFailureCache. appleSearchBucket (api/episodes/appleBucket.ts:72) is a module singleton on realClock, 20 calls per 60 s, with no reset hook. search.ts:413 consumes from it on every uncached general search.\n\nThe hazard is known and handled on purpose, though. A long comment sits right above the burst test: \"THIS TEST MUST STAY LAST IN THE FILE. It deliberately drains appleBucket.ts's 20/min bucket, which is module state shared by every test above it ... P-05's end-to-end test was appended below it and failed exactly this way before being moved above. Add new Apple-path tests ABOVE this comment.\" A second note (the ROUND 2 block, 2026-09-23) records moving two more tests above it for the same reason. The burst test's own comment also explains why it drives the bucket through the handler instead of importing appleBucket.ts: under tsx's ESM loader, separate test files can get separate module instances. So the fix sketch (import the bucket and reset it) is not obviously safe without checking that the test gets the same module instance search.ts uses.\n\nParts of the scenario are wrong. The finding says the burst test's `refused.length > 0` depends on how many slots earlier tests spent. It does not: 25 queries against a capacity of 20 always refuse at least 5, and more if earlier tests used slots. `appleCallCount <= 20` also holds either way. The finding also says adding a new general-path test causes failures. That happens only if the test goes below the burst test, which the comment forbids, or if Apple-path tests above it together pass 20 calls within one minute. Currently about 8-10 tests take the Apple path.\n\nWhat remains is a latent limit (over 20 Apple calls above the burst test) enforced by ordering and a comment rather than a reset. It is documented and deliberate, a test-only concern, and low severity.",
  "merged_ids": [],
  "lane": null
}
```

## gen-1: Web-search replies are parsed from the FIRST text block, so the JSON is missed and the re-ask (sent without the search tool) gets passages written from memory

**confirmed** · verifier severity **high** (finder: high) · gen · correctness · `backend/src/generation/AnthropicExternalResearcher.ts:206` · L5-generation

```json
{
  "id": "gen-1",
  "area": "gen",
  "category": "correctness",
  "title": "Web-search replies are parsed from the FIRST text block, so the JSON is missed and the re-ask (sent without the search tool) gets passages written from memory",
  "file": "backend/src/generation/AnthropicExternalResearcher.ts",
  "line": 206,
  "severity": "high",
  "scenario": "retrievePassages() and research() both call messages.create with the web_search tool. A reply that uses the tool usually looks like this: a text block ('I'll search for...'), then server_tool_use, then web_search_tool_result, then the final answer spread over one or more text blocks (text with citations is split into several blocks). `.find(b => b.type === 'text')` takes the first block, which is the preamble. parseLastJsonBlock fails on it, so reask() runs. The re-ask sends only the preamble as the assistant turn and passes NO `tools`, so the model cannot search. It answers 'reply with the JSON object only' from memory, making up 'verbatim' passages with plausible titles and URLs. These become kind:'print' evidence that the writer quotes and the verifier checks against, and they are published as cites. When the first block does hold JSON, a cited answer split across blocks still loses part of it. The tests only mock a single text block (AnthropicExternalResearcher.test.ts:39), so none of this is covered.",
  "evidence": "line 206: `const textBlock = response.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === \"text\");` (research() has the same line at 111). The re-ask at ~226 is `messages: [{role:'user',content:promptText},{role:'assistant',content:textBlock.text},{role:'user',content:reaskLine}]` and passes no `tools`. The prompt itself says 'respond with ONLY a single JSON object as your FINAL message'.",
  "fix_sketch": "Build the answer from the text blocks after the last web_search_tool_result block, concatenated in order, or from all text blocks joined, and then run parseLastJsonBlock on that. Handle stop_reason 'pause_turn' by continuing the turn. For retrieval, never re-ask without the tool: when the JSON is unparseable, return [] (a retrieval miss) rather than accept passages the model could not have copied. Add a test with a preamble text block, a tool_result block and a split final answer.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "high",
  "verdict_reasoning": "I read origin/main and the finding holds. In backend/src/generation/AnthropicExternalResearcher.ts, both research() (line 111) and retrievePassages() (line 206) call messages.create with the web_search_20250305 tool. Both then take `response.content.find(b => b.type === \"text\")`, which is the FIRST text block, and pass only that block's text to parseLastJsonBlock (lines 146 and 240).\n\nThe docstring on parseLastJsonBlock (parseWithRetry.ts:~143) says it expects the final JSON to be \"wrapped in prose around its web-search tool calls\". That assumes all of the prose arrives as one string. With server tools, the prose is actually split across several content blocks: text, then server_tool_use, then web_search_tool_result, then more text (and cited answers split into several text blocks). The later JSON is never seen. When the first block is a preamble like \"I'll search for…\", the parse fails and reask() runs.\n\nThe re-ask (lines 226-234, and 132-140 in research()) sends only `textBlock.text` as the assistant turn and passes no `tools`. The code comments confirm this is deliberate, but only as a cost decision: no USD_PER_SEARCH charge. So the model has neither the search results nor a search tool. In retrievePassages it is still told to return \"verbatim\" passages with a title and url, and it can only answer from memory. Those passages become print documents in gatherEvidence.ts:585.\n\nThe F-48 KNOWN GAP comment (lines 163-168) admits that the passages are the model's transcription of search results. It does not cover this no-search re-ask path, and neither does anything in DECISIONS.md that I found. No code elsewhere joins the text blocks or handles pause_turn.\n\nOn tests: backend/test/AnthropicExternalResearcher.test.ts:39 mocks only a single text block, so the multi-block shape is not covered. The finding cited the test file path slightly wrong; it lives under backend/test/, not src.\n\nSeverity: high. With the usual web-search reply shape, most retrievals probably go through the tool-less re-ask. That turns \"grounded evidence\" into passages written from memory, and the writer quotes them as print cites. The same first-text-block pattern exists in the enricher and other builders, but they don't use server tools, so they are less affected.",
  "merged_ids": [],
  "lane": "L5-generation"
}
```

## gen-2: Tape evidence window is truncated from the end, so any clip longer than about 100 s loses its tail from the verifier's and writer's view

**confirmed** · verifier severity **medium** (finder: medium) · gen · correctness · `backend/src/generation/gatherEvidence.ts:659` · L5-generation

```json
{
  "id": "gen-2",
  "area": "gen",
  "category": "correctness",
  "title": "Tape evidence window is truncated from the end, so any clip longer than about 100 s loses its tail from the verifier's and writer's view",
  "file": "backend/src/generation/gatherEvidence.ts",
  "line": 659,
  "severity": "medium",
  "scenario": "cueWindowText pads the clip by EVIDENCE_TAPE_WINDOW_SEC (90 s) on each side, joins the cues, then keeps only the first EVIDENCE_MAX_TAPE_CHARS (3000) characters. I measured 15.7 chars/s on 40 local transcripts, so 3000 chars is about 190 s: 90 s of pre-roll plus only the first ~100 s of the clip. The post-roll and the rest of the clip are dropped. Normal clips are 60 s or longer (D2_SHORT_SEC) and can run to 300 s or more, so a 180 s clip loses about its last 80 s. writeAct uses this text as the clip's `windowText`. The verifier is asked whether a beat is 'carried' by the clip, and whether a seam's statements rest on it, using a window that ends mid-clip. Beats the tape does carry near its end are refused, which costs retry rounds, seed-lost closures or unverified pages. The constant's own comment ('A 180-second window of speech is ~450 words') counted only the padding, not the clip.",
  "evidence": "`const from = startSec - windowSec; const to = endSec + windowSec; ... if (joined.length <= EVIDENCE_MAX_TAPE_CHARS) return joined; const cut = joined.slice(0, EVIDENCE_MAX_TAPE_CHARS);` with EVIDENCE_TAPE_WINDOW_SEC = 90 and EVIDENCE_MAX_TAPE_CHARS = 3000",
  "fix_sketch": "Always keep the clip span [startSec, endSec] whole. Shrink the pre-roll and post-roll symmetrically to fit the cap, or size the cap as clip chars plus a padding budget. If the clip alone is over the cap, trim the padding to zero first and only then cut the clip, marking the cut.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the code at origin/main and it does what the finding says. In backend/src/generation/gatherEvidence.ts (lines 641-662), cueWindowText collects every cue in [startSec-90, endSec+90], joins them, and when the text is longer than EVIDENCE_MAX_TAPE_CHARS (3000) keeps only the first 3000 characters, cut at a word boundary. It is cut from the end: it keeps the pre-roll and drops the tail of the clip and the post-roll.\n\nThis text reaches the writer and the verifier:\n- tapeEvidenceFor (line 476) makes it the tape doc.\n- writeAct.ts:344-351 takes that doc's text as the clip's windowText.\n- writeAct.ts:447 passes windowText to the verifier.\n- AnthropicNarrationVerifierBuilder.ts:281 shows it as the clip's \"Transcript window\".\n\nThe scenario can happen, and on current clip lengths it happens often. The constant's comment (\"A 180-second window of speech is ~450 words ... without truncating a normal window at all\") dates from when windows were 30-180 s. F-94/Q-01 (generation-run-2026-09-09.md) changed tape windows to 60-1,800 s. On the run-8 candidate that change raised the mean clip from 122 s to 213 s, and the longest to 671 s. At normal speech rates of about 15 chars/s, a 213 s clip plus 180 s of padding is about 5,900 chars, so roughly half the window is lost. Even a 60 s floor clip gives a 240 s window of about 3,600 chars, which is already over the cap.\n\nThis is not deliberate. foray-generation-requirements.md:1776-1779 records the 3000-char cap and the word-boundary trim, but only as a guard for the \"pathological case (a densely-cued episode)\". Nothing records a choice to drop clip tails. I found nothing elsewhere in the code that restores the full clip span.\n\nI rate it medium, not high: the clip opening (clipOpening, which needs the startAnchor near the start of the window) survives. The damage is that support for later statements is refused and quotes from late in the clip fail to match, which costs retries and leaves pages unverified. It does not corrupt data.",
  "merged_ids": [],
  "lane": "L5-generation"
}
```

## gen-3: Deepened slot titles are never pinned to the spine's, but items are keyed by the deepened title and `slots` by the spine's

**confirmed** · verifier severity **medium** (finder: medium) · gen · correctness · `backend/src/generation/runPipeline.ts:1241` · L5-generation

```json
{
  "id": "gen-3",
  "area": "gen",
  "category": "correctness",
  "title": "Deepened slot titles are never pinned to the spine's, but items are keyed by the deepened title and `slots` by the spine's",
  "file": "backend/src/generation/runPipeline.ts",
  "line": 1241,
  "severity": "medium",
  "scenario": "`slots = slotsFromSpine(spine)` builds slot ids from the SPINE's slot titles. Items get their `slot` from `slugifySlotTitle(item.slotTitle)` (forayItems.ts:356/369). That title comes from the written act, which comes from the sourced act, which comes from the DEEPENED act. The §4.4 prompt says 'Refine this act's slots'. validateDeepenedAct checks the slot COUNT but not the titles, and carryBeatSeeds/capArgumentBeats keep the deepened title. If Sonnet rewords a slot title ('Origins' becomes 'Origins of the practice'), every item in that slot declares a slot id that is not in `slots`. check-forays then fails with 'declares slot ..., which is not in `slots`'. With the default refusedPartial=abort this surfaces at that act's partial check, after all acts' narration has already been paid for (the ordering cost F-87 describes).",
  "evidence": "runPipeline.ts:1241 `const slots = slotsFromSpine(spine);` vs stitchAct.ts:181/199/232 `slotTitle: slot.title` (the written or deepened title) and forayItems.ts:356 `slot: slugifySlotTitle(item.slotTitle)`. AnthropicDeepenActBuilder.ts:188 `\"1. Refine this act's slots ...\"`. The schema accepts any `slots[].title`.",
  "fix_sketch": "In deepenOneActWithRetry (or carryBeatSeeds), restore every deepened slot's title to `act.slots[i].title` as is already done for seeded claims, or refuse a retitled slot in validateDeepenedAct. Better still, carry a stable slot id from the spine through deepen, source, write and stitch instead of re-slugifying titles in three places.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main and the finding holds.\n\n1. `runPipeline.ts:1241` sets `const slots = slotsFromSpine(spine)`. `slotsFromSpine` (477-499) builds each id as `slugifySlotTitle(slot.title)` from the pre-deepen spine. Its own comment (492-494) says the id stays the slug \"because stitchAct and partialProjection join items to slots by slugifying the spine's own slot.title\". That assumption is false for stitchAct.\n\n2. The deepened title reaches the items unchanged:\n   - `sourceBeats.ts:538` returns `{title: slot.title, ...}`, taking the title from the deepened act.\n   - `writeAct.ts:1094` carries it into the written slot.\n   - `stitchAct.ts:181/199/232` set `slotTitle: slot.title`.\n   - `forayItems.ts:356/369` build `slot: slugifySlotTitle(item.slotTitle)`.\n   - Nothing remaps item slots onto `slots[i].id`. Only partialProjection (202) uses `plan.slots[flatSlot].id`, and that covers only the projected items, not the real ones.\n\n3. `deepenActs.ts` has no guard on titles:\n   - `validateDeepenedAct` (spine.ts:277) checks slot count, claim shape, intro/exit and structure leaks, but not titles.\n   - `carryBeatSeeds` and `capArgumentBeats` both return `{title: slot.title, ...}` from the deepened slot. They restore claims and seeds, not titles.\n   - `DeepenedActSchema` accepts any title.\n   - The prompt (AnthropicDeepenActBuilder.ts:188) says \"Refine this act's slots and sharpen its beats ... Do NOT add or remove slots\". It never says to keep slot titles verbatim, and it lists \"the act's own title\" among the things the model may rewrite. The JSON shape asks the model to re-emit every slot title.\n   - Only StubDeepenActBuilder copies titles, so tests would not catch a reworded title.\n\n4. The failure path is real. check-forays.mjs:1039 raises `declares slot \"...\", which is not in \\`slots\\``. The partial candidate is built with `slots: slots.slice(...)` taken from the spine. With `refusedPartial === \"abort\"` that throws `RefusedPartialError` (runPipeline.ts:1457). The F-87 comment (1500-1510) confirms that by then every act's narration has started or been paid for. The final whole-Foray check would fail the same way.\n\nNothing in docs/DECISIONS.md or the code comments calls this deliberate.\n\nSeverity is medium, not high. The model may usually copy the titles, since committed Forays pass check-forays. But nothing enforces it, and when it happens the build fails loudly and late, after the narration spend, rather than corrupting data silently.\n\nSide note: `slotsFromSpine`'s `-2` suffix for duplicate slot titles has the same mismatch, because items never get the suffix.",
  "merged_ids": [],
  "lane": "L5-generation"
}
```

## gen-4: slotsFromSpine suffixes duplicate slot ids (-2) but items still use the unsuffixed slug

**confirmed** · verifier severity **medium** (finder: medium) · gen · correctness · `backend/src/generation/runPipeline.ts:489` · L5-generation

```json
{
  "id": "gen-4",
  "area": "gen",
  "category": "correctness",
  "title": "slotsFromSpine suffixes duplicate slot ids (-2) but items still use the unsuffixed slug",
  "file": "backend/src/generation/runPipeline.ts",
  "line": 489,
  "severity": "medium",
  "scenario": "Take a spine where act 1 and act 3 both have a slot titled 'Origins'. slotsFromSpine declares ids 'origins' and 'origins-2', as its comment promises. stitchAct and toForayItem stamp every item of BOTH slots with slugifySlotTitle('Origins') = 'origins'. check-forays then sees the 'origins' block play twice, non-contiguously ('slots are interleaved rather than contiguous'), and 'origins-2' owns no items. The Foray is refused after the spend. partialProjection uses `plan.slots[flatSlot].id` ('origins-2') for projected items, so the partial check projects a different Foray from the one that is built. The only test (runPipeline.test.ts:302) checks the slot list, not the items.",
  "evidence": "`let unique = id; let n = 2; while (seen.has(unique)) unique = `${id}-${n++}`;` in slotsFromSpine vs forayItems.ts:356 `slot: slugifySlotTitle(item.slotTitle)`",
  "fix_sketch": "Have slotsFromSpine return an (actIndex, slotIndex) to id map and pass it to ForayStitcher/stitchAct, so items take the declared id rather than re-slugifying the title. Or reject duplicate slot titles in the spine structural gate so the re-ask fixes it.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the code at origin/main and the finding holds. In runPipeline.ts, slotsFromSpine (around lines 477-500) declares a duplicate title as `${id}-2`. Its own comment says it does this because \"check-forays joins items to slots by it\". The comment then says the id \"stays the raw title's slug, because stitchAct and partialProjection join items to slots by slugifying the spine's own slot.title\". That is wrong for the suffixed case. forayItems.ts:356 and :369 stamp every item with `slot: slugifySlotTitle(item.slotTitle)`, and nothing in runPipeline, stitchForay or finalizeForay remaps an item's slot afterwards (grep found no other slot assignment). So items in both 'Origins' slots get 'origins', and 'origins-2' gets no items. tools/foray/check-forays.mjs:1338-1344 then reports \"slots are interleaved rather than contiguous\" whenever the two slots are not adjacent, which is the finding's cross-act example. partialProjection.ts:202 uses `plan.slots[flatSlot]?.id`, so it projects 'origins-2' while the built Foray uses 'origins', so the partial check and the final build disagree. Nothing stops duplicate titles earlier: spineStructure.ts and types/spine.ts check duplicate beat claims, not duplicate slot titles. The comment calls duplicate titles across acts legitimate, so this is not deliberate; the suffix logic was meant to handle it and it only half does. It needs the LLM to reuse a slot title in a non-adjacent slot, which is uncommon but possible, and the Foray is then refused after the full spend. I rate it medium. I did not run a test.",
  "merged_ids": [],
  "lane": "L5-generation"
}
```

## gen-5: Evidence prefetch caches transient retrieval failures as empty packs, so narration never asks again

**confirmed** · verifier severity **medium** (finder: medium) · gen · error-handling · `backend/src/generation/evidencePrefetch.ts:236` · L5-generation

```json
{
  "id": "gen-5",
  "area": "gen",
  "category": "error-handling",
  "title": "Evidence prefetch caches transient retrieval failures as empty packs, so narration never asks again",
  "file": "backend/src/generation/evidencePrefetch.ts",
  "line": 236,
  "severity": "medium",
  "scenario": "PrefetchingEvidenceGatherer.lookup deletes the memo entry only when inner.gather REJECTS ('narration will ask again'). But DefaultEvidenceGatherer.retrieveFor catches every retrieval error (a 429 or 529 after SDK retries, a network error, even a BudgetGuard refusal) and resolves {status:'failed', docs:[]}. gather() then resolves with an empty print pack, which is memoised for the rest of the run. writeActNarration gathers once per act, before all its rounds, so every retry round of that act works from zero print evidence. Seams are refused for lacking support until the rounds run out. The prefetch fans out 6 web-search calls at a time, so rate limiting there is a realistic trigger. The `failed` metric in the report also stays 0 for these, so the report hides it.",
  "evidence": "evidencePrefetch.ts:236 `const pending = this.inner.gather(beat, ctx).catch((err) => { this.memo.delete(key); throw err; });` vs gatherEvidence.ts:605 `} catch (err) { console.warn(`gatherEvidence: print retrieval failed ...`); return { status: \"failed\", query, docs: [] }; }`",
  "fix_sketch": "Pass the failure through. Either have gather() return a pack with a `retrievalFailed` flag that PrefetchingEvidenceGatherer does not memoise (and counts in `failed`), or rethrow non-budget errors from retrieveFor and let printEvidenceFor's two-query path keep its own .catch. Let budget errors (findBudgetError) propagate so the run stops at the right stage.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the code at origin/main and the finding holds.\n\n1. PrefetchingEvidenceGatherer.lookup (evidencePrefetch.ts ~236) removes the memo entry only when inner.gather rejects. Its doc comment says a failed gather is dropped \"so the next asker retries rather than inheriting the failure\", and the prefetch warning says \"narration will ask again\".\n2. DefaultEvidenceGatherer.retrieveFor (gatherEvidence.ts ~580-613) is documented as \"Never rejects\". It catches every error from researcher.retrievePassages and returns {status:'failed', docs:[]}. That includes SDK 429/529 errors, network errors, JSON-parse failures, and the BudgetGuard refusal, because AnthropicExternalResearcher.retrievePassages calls budgetGuard.checkAndRecord inside the try.\n3. printEvidenceFor handles the 'failed' status carefully for the disk cache (F-77: it does not write a verdict). But gather() still resolves with a pack that has no print docs. The in-memory memo in PrefetchingEvidenceGatherer then keeps that resolved promise for the whole run, and it never sees the status.\n4. The prefetch worker increments `failed` only in its catch, so these swallowed failures count as `prefetched`. The report hides them.\n5. writeAct.ts (lines ~311-331) gathers every beat's pack once, before the `for (let round...)` loop at line 394, and its comment says every gather there is a memo hit. So every round of that act uses the empty pack.\n\nThe retrieveFor comment says an empty pack after a failure is intended within one gather: pages degrade rather than invent citations. But the memo's own comment says a failure should not be inherited by the next asker, and the swallowed failure defeats that. Without the prefetch, narration's own gather would have made a fresh retrieval call. The prefetch runs retrievals several at a time, so transient rate limits are a realistic trigger. The disk cache correctly avoids caching failures, so a later run recovers; the damage is limited to the current run's pages. The finding's point about budget refusals also holds: they are swallowed here rather than stopping the run, though that behaviour comes from retrieveFor itself, not from the prefetch. Medium severity: pages silently lose their evidence for the rest of the run, with no crash and no way to see it in the report.",
  "merged_ids": [],
  "lane": "L5-generation"
}
```

## gen-6: Tier-2 item ids collide for episodes whose titles share 60 slug chars, so one episode's audio and transcript can be attributed to another

**confirmed** · verifier severity **medium** (finder: medium) · gen · correctness · `backend/src/generation/sourceBeats.ts:1738` · L5-generation

```json
{
  "id": "gen-6",
  "area": "gen",
  "category": "correctness",
  "title": "Tier-2 item ids collide for episodes whose titles share 60 slug chars, so one episode's audio and transcript can be attributed to another",
  "file": "backend/src/generation/sourceBeats.ts",
  "line": 1738,
  "severity": "medium",
  "scenario": "deriveItemId = `${show_id}--${slug(title).slice(0,60)}` with no disambiguation. On this machine's digests, 28 ids cover more than one guid across 5046 entries: Becker's Healthcare ('scott-becker-6-healthcare-news-stories-we-are-following-toda' covers 3 episodes) and 'the-bbq-central-show--the-best-moments...' (3). When tier 2 mints from two such episodes, `state.newSegmentSources.set(itemId, audioSource)` lets the last episode overwrite the first's audio row. buildCandidateFiles also drops a minted source whose id is already in data/segment-sources.json (`!registryIds.has(s.id)`). A segment cut from episode B's transcript then plays episode A's enclosure at B's timestamps. findDigestForItem and makeSegmentWindowText both resolve the id to the FIRST matching entry, so evidence text can also come from the wrong episode. The M3/M4 ledgers also treat the two episodes as one.",
  "evidence": "transcriptArchiveLookup.ts:1322-1331 `...slice(0, 60)...; return `${entry.show_id}--${slug || \"episode\"}`;` and sourceBeats.ts:1738 `if (audioSource) state.newSegmentSources.set(itemId, audioSource);` and makeSegmentWindowText `if (!byItemId.has(id)) byItemId.set(id, entry);`",
  "fix_sketch": "Make the tier-2 item id unique per guid: add a short hash of the guid when the slug is truncated or when another archive entry derives the same id (mirroring prepare-segment-batch's mintItemIds suffixing). As a guard, assert when newSegmentSources already holds a different episode_guid for the id.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the code at origin/main myself and the finding holds.\n\n- **The id is not unique per episode.** `deriveItemId` in `transcriptArchiveLookup.ts` returns `${show_id}--${slug(title).slice(0,60)}`. It never looks at the guid and never adds a suffix to tell episodes apart. Its docstring says it copies prepare-segment-batch's `mintItemIds` shape, but it leaves out that script's suffixing.\n- **The collisions are real.** I re-derived the ids over the loader's own input: the two committed digests plus `data-local/transcripts/corpus-digest.json`, using the same `cues>0` and `!span_implausible` filters. That is 5036 entries, and 27 ids cover more than one guid. Examples:\n  - `1452376188--scott-becker-6-healthcare-news-stories-we-are-following-toda` covers 3 episodes.\n  - `the-bbq-central-show--the-best-moments-of-the-bbq-central-show-in-10-minutes-or-le` covers 3 episodes.\n  - `loadTranscriptArchive` dedupes only on `show_id`+`guid`, so all of these episodes stay in the archive.\n- **Within one run, the second episode's audio row replaces the first's.** At `sourceBeats.ts:1738`, `state.newSegmentSources.set(itemId, audioSource)` overwrites the row keyed by the shared id, and nothing checks whether it holds a different `episode_guid`. `mintSegmentSource` takes the `itemId` it is given and does no check of its own. Segment ids (`mintSegmentId(itemId, start)`) differ only by start time, so segments from both episodes point at the same item id and therefore the same single audio row.\n- **Across runs, the new episode's audio row is dropped.** In `finalizeForay.ts:560`, a minted source whose id is already in `data/segment-sources.json` is filtered out (`!registryIds.has(s.id)`). A later segment cut from episode B then resolves to episode A's enclosure. `mintedPoolCollisions` only refuses rows at the same start, so it does not catch this.\n- **Evidence lookups take the first match.** `findDigestForItem` (`gatherEvidence.ts`) returns the first archive entry whose derived id matches. `makeSegmentWindowText` (`sourceBeats.ts:2492`, `if (!byItemId.has(id)) byItemId.set(id, entry)`) does the same.\n- **The M4 share cap counts the two episodes as one.** `m4ShareAllows(itemId)` is keyed on the item id.\n\nNothing in docs/DECISIONS.md or the code comments treats this as deliberate. A grep for collision found only the unrelated same-start rule (F-84) and the foray-id rule.\n\nWhy medium: the result is silently wrong audio, with no error raised, for the segment from the second episode. The trigger is fairly narrow: about 27 of roughly 5000 ids, and tier 2 has to pick a colliding episode. But the colliding shows publish recurring roundups with the same title every time (the Becker news round-up, the BBQ Central best-of), so the collision will happen in practice.",
  "merged_ids": [],
  "lane": "L5-generation"
}
```

## gen-7: Transcript body lookup's prefix fallback can return a different episode's body

**confirmed** · verifier severity **medium** (finder: medium) · gen · correctness · `backend/src/generation/transcriptArchiveLookup.ts:416` · L5-generation

```json
{
  "id": "gen-7",
  "area": "gen",
  "category": "correctness",
  "title": "Transcript body lookup's prefix fallback can return a different episode's body",
  "file": "backend/src/generation/transcriptArchiveLookup.ts",
  "line": 416,
  "severity": "medium",
  "scenario": "locate() first tries the writer's exact key `${corpusSafeKey(guid)}.json`. If that file is missing (the episode was never transcribed), it falls back to `[...files.keys()].find(f => f.startsWith(`${slug}-`))`. Files are named `<slug60>-<sha10>.json`, so for a guid 'ep-5' the fallback matches the body of guid 'ep-5-bonus' or 'ep 5 part 2' ('ep-5-bonus-<hash>.json'). bodyStat() then reports a body for an episode that has none, which inflates topic supply. The text index indexes the sibling's words under this guid. getCues() hands tier 2 the sibling's cues, and tier 2 mints a segment against THIS episode's enclosure at timestamps from the other transcript: wrong tape, with the wrong words in the verifier's evidence.",
  "evidence": "`const slug = guidSlug(guid); if (slug) { const byName = [...files.keys()].find((f) => f.startsWith(`${slug}-`) || f === `${slug}.json`); if (byName) return path.join(dir, files.get(byName)!); }`",
  "fix_sketch": "Keep the legacy fallback to the exact legacy names only (`${slug}.json`, or a verified hash-less name). When a prefix match is used, open the file and confirm its `guid` field equals the requested guid before returning it (the guid index below already does this). Also cache the negative result of locate().",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main:backend/src/generation/transcriptArchiveLookup.ts, and the finding holds. locate() at about line 402 first tries `files.get(`${corpusSafeKey(guid)}.json`)`. corpusSafeKey in transcriptCorpus.ts:68 builds `<slug60>-<sha1[0:10]>`. When that misses, locate() computes guidSlug(guid): the same lowercasing and replacement of non-alphanumeric runs with hyphens, truncated at 80. It then returns the first listed file where `f.startsWith(`${slug}-`) || f === `${slug}.json``. It never opens that file to check its guid. Only the third fallback, the guid index, checks the `guid` field.\n\nExample: guid 'ep-5' has slug 'ep-5', and 'ep-5-bonus-<hash>.json' starts with 'ep-5-'. The same happens with URL guids such as '.../episode-5' next to '.../episode-5-part-2'.\n\nThe miss case is real, not theoretical:\n- The module's own comment says only 1,346 of 1,718 archive digest entries had a body on disk, so locate() is regularly called for episodes with no body.\n- bodyStat, getCues and the source-provenance lookup (lines ~306, 328, 355) all go through locate().\n- The negative result is not cached, which is a minor cost on top.\n\nNo comment and no DECISIONS rationale justifies the loose prefix. The guidSlug doc comment says the fallback exists only for legacy bare-slug files (hash-less names). That justifies the `=== ${slug}.json` branch but not the `startsWith(`${slug}-`)` branch, which also matches hash-suffixed siblings.\n\nThe impact is as described. A sibling episode's cues and body stats get attributed to this guid, and tier 2 could mint a segment against this episode's enclosure at timestamps from the other transcript.\n\nI rated it medium, not high, because it needs one guid's slug to be a hyphen-bounded prefix of another guid's slug in the same show, while the first guid has no body. That is plausible for permalink or numbered guids, but it is not universal.",
  "merged_ids": [],
  "lane": "L5-generation"
}
```

## gen-8: Q-09 cross-act show memory is never wired, so every act re-introduces a show by name

**confirmed** · verifier severity **low** (finder: low) · gen · correctness · `backend/src/generation/writeNarration.ts:527` · L5-generation

```json
{
  "id": "gen-8",
  "area": "gen",
  "category": "correctness",
  "title": "Q-09 cross-act show memory is never wired, so every act re-introduces a show by name",
  "file": "backend/src/generation/writeNarration.ts",
  "line": 527,
  "severity": "low",
  "scenario": "writeActNarration's docs say `showsIntroduced` is returned per act and 'runPipeline carries it forward', so a show named in act 1 is not re-named in act 3. Nothing passes it: writeNarration builds the options without it, runPipeline narrates acts concurrently (G-32), and no caller in src sets it. Every act starts with an empty `showsHeard` set. validateSeam then requires the first full intro of each show in EVERY act to say the show's name, which is the 'says on Practical AI nine times' outcome Q-09 was meant to prevent. A writer that follows the Foray-wide intent and skips the name is refused, which costs a retry round.",
  "evidence": "writeNarration.ts:527 `{ writer, verifier, evidence, stats: options.stats, segmentSources: options.segmentSources, ground: options.ground?.() ?? [] }` has no showsIntroduced. `git grep showsIntroduced -- backend/src` finds only writeAct.ts's declaration and read.",
  "fix_sketch": "Clip order is fixed at sourcing time, so compute the Foray-wide 'first clip per canonical show' set once from sourced.acts before narration starts. Pass each act the shows first heard in EARLIER acts (deterministic, and safe under concurrency). Then correct the doc comment.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The finding holds at origin/main. writeAct.ts:212 declares `WriteActOptions.showsIntroduced`, and its doc comment says writeActNarration returns the set (`showsNamed`) and that runPipeline carries it forward. `git grep showsIntroduced -- backend/src` finds only the declaration (writeAct.ts:212) and the read (writeAct.ts:340). `git grep showsNamed` finds only that doc comment, so the return value it describes does not exist. writeNarration.ts:527 builds the options as `{ writer, verifier, evidence, stats, segmentSources, ground }` with no showsIntroduced. Acts are narrated concurrently through Promise.allSettled and createActGate (G-32), so there is no sequential point where the set could be carried. As a result `showsHeard` starts empty in every act, and the first clip of each show in each act gets `showFirstHeard: true`. validateSeam (writeAct.ts ~931) then requires that clip's full intro to say the show's name. docs/curation/listening-quality-plan.md (Q-09) says the set is meant to be Foray-wide and carried across acts, so this is an unimplemented intent, not a deliberate choice. Severity stays low: repetition is capped at once per act per show, about 3 to 4 times in a medium Foray, not nine. Also, because the writer prompt (AnthropicNarrationWriterBuilder.ts:378) gets the same showFirstHeard=true, the writer is told to name the show, so retry rounds would be rare. The real cost is the per-act re-naming that Q-09 meant to prevent, plus a doc comment that is wrong. The fix sketch holds up: clip order is fixed at sourcing time, so the earlier-acts set can be computed deterministically, which is safe under concurrency.",
  "merged_ids": [],
  "lane": "L5-generation"
}
```

## gen-9: Safety regexes reject ordinary documentary prompts, against the DECISIONS intent to avoid false positives

**confirmed** · verifier severity **low** (finder: low) · gen · correctness · `backend/src/generation/safetyCheck.ts:41` · L5-generation

```json
{
  "id": "gen-9",
  "area": "gen",
  "category": "correctness",
  "title": "Safety regexes reject ordinary documentary prompts, against the DECISIONS intent to avoid false positives",
  "file": "backend/src/generation/safetyCheck.ts",
  "line": 41,
  "severity": "low",
  "scenario": "Subject/intent co-occurrence still matches ordinary prompts. 'How the Catholic Church covered up the sexual abuse of children', 'How sex education for kids changed in the 1970s', 'How to survive a nuclear bomb' and 'Steps to peace after the Oklahoma City bomb' are all REJECTED (verified with node against the same regexes). The first two get the message 'there's no rephrasing that changes the answer'. The rejection is also checkpointed under 'understand', so a re-run returns it again. DECISIONS.md (§4.1 bullet) says a false positive is 'a confusing, un-appealable rejection with no recourse, so the rule leans conservative in that direction'.",
  "evidence": "`subject: /\\b(child|children|kid|kids|minor|...)\\b/i, intent: /\\b(sex|sexual|sexualiz\\w*|nude|naked|porn\\w*|erotic|explicit)\\b/i` and `intent: /\\b(how (?:to|do i|can i|would i)|instructions? for|recipe for|steps? to|...)\\b/i`",
  "fix_sketch": "Require intent phrases that request the content (e.g. 'write/generate ... sexual ... about a child', 'how to build/make a <weapon>') rather than any 'how to' or 'sexual' token. Add an allow-list of reporting and history framings (abuse, scandal, history of, survive, after). Add these prompts to the safetyCheck tests as must-pass cases.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "At origin/main, backend/src/generation/safetyCheck.ts RULES match the regexes quoted in the finding exactly. checkSafety rejects when the subject regex and the intent regex both match anywhere in the prompt. I ran node against those exact regexes and all four prompts in the finding came back true (rejected). The CSAM rule's intent list contains bare 'sex' and 'sexual', and its subject list contains 'children' and 'kids', so any documentary about abuse scandals or sex education trips it and gets the 'no rephrasing changes the answer' message. The weapons rule's intent list contains bare 'how to' and 'steps to', so 'How to survive a nuclear bomb' is rejected. understandPrompt.ts:37-43 returns outcome 'rejected' immediately. runPipeline checkpoints the understand result, but the check is deterministic, so a re-run would reject again anyway.\n\nThis is not deliberate. The file header comment and DECISIONS.md (the §4.1 co-occurrence bullet, around line 1960) both say the goal is to let historical and educational prompts through. They also say a false positive costs 'a confusing, un-appealable rejection with no recourse, so the rule leans conservative in that direction'. These prompts are exactly that kind of false positive.\n\nSome things soften it. This is phase-1 tooling that only the founder uses. The header says the term lists are expected to be refined over time. The weapons explanation does point users toward history and policy framings, though a history-framed prompt that contains 'how to' or 'steps to' still gets rejected. Nothing downstream is exposed, and the only cost is a wrongly rejected prompt, so low severity is right.",
  "merged_ids": [],
  "lane": "L5-generation"
}
```

## gen-10: Truncated (max_tokens) replies are silently repaired into valid JSON for continuity, deepen, spine and verifier

**confirmed** · verifier severity **low** (finder: low) · gen · error-handling · `backend/src/generation/AnthropicContinuityBuilder.ts:65` · L5-generation

```json
{
  "id": "gen-10",
  "area": "gen",
  "category": "error-handling",
  "title": "Truncated (max_tokens) replies are silently repaired into valid JSON for continuity, deepen, spine and verifier",
  "file": "backend/src/generation/AnthropicContinuityBuilder.ts",
  "line": 65,
  "severity": "low",
  "scenario": "The 2026-09-13 audit fixed truncation only in the narration WRITER (assertNotTruncated). The other builders never read stop_reason, and parseOrRepairJson closes open strings and brackets. The continuity call (MAX_OUTPUT_TOKENS 500, schema {nextIntroduction}) cut off mid-sentence becomes a valid introduction ending in a half sentence. validateSmoothedSeam only refuses it when it is under 50% of the original length, so a long cut-off intro is SPOKEN. The same applies to a deepened act cut off inside `exit` (4000 tokens; exit is the last field and is spoken verbatim).",
  "evidence": "AnthropicContinuityBuilder.ts:65-72 `const response = await this.client.messages.create({ model: MODEL, max_tokens: MAX_OUTPUT_TOKENS, ... }); recordUsage(response.usage); const textBlock = ...` with no stop_reason check. `git grep stop_reason` finds it only in AnthropicNarrationWriterBuilder.ts.",
  "fix_sketch": "Move assertNotTruncated into a shared helper and call it on every messages.create reply (original and re-ask) in Continuity, DeepenAct, Spine, Verifier, PromptUnderstander and ExternalResearcher. Or have parseWithRetry refuse repair when stop_reason === 'max_tokens'.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The finding holds at origin/main. `git grep stop_reason` over backend/src finds it only in AnthropicNarrationWriterBuilder.ts, at lines 165 and 194, where assertNotTruncated is called. AnthropicContinuityBuilder.ts:65-72 calls messages.create with max_tokens 500, then records usage and parses the text block. It never checks stop_reason, and neither does its re-ask. DeepenAct (4000), Spine, Verifier, PromptUnderstander and ExternalResearcher also pass max_tokens without checking stop_reason. The same code path handles all of them: parseWithRetry → attemptParse → parseOrRepairJson. parseOrRepairJson closes an open string and any open brackets, so a reply cut off inside nextIntroduction, or inside `exit` (the last field of RawDeepenedActSchema), parses as valid JSON and passes the zod check. The re-ask only runs when that parse fails, so it never runs here.\n\nNothing downstream catches it. validateSmoothedSeam (smoothSeam.ts:143) refuses an introduction only if it is empty, under 50% of the original length, or mentions the Foray's own structure. validateDeepenedAct (spine.ts:277) checks only that `exit` is not empty. A long, cut-off introduction or exit therefore passes and would be spoken.\n\nIt is not deliberate. The parseWithRetry comment (F-39) describes the repair as a fix for a missing final `}`, not for a reply the model never finished. The assertNotTruncated comment names this exact danger (\"A truncated reply parses as a SHORT act (parseOrRepairJson closes the brackets)\") but applies the fix only to the writer. docs/DECISIONS.md has nothing on truncation in these stages.\n\nSeverity stays low because hitting the limit is uncommon. 500 tokens is roughly 375 words, several times a normal introduction. Deepen's 4000 tokens has more exposure, since slots, beats and claims come before `exit`. When it does happen, a half sentence reaches the listener with no error.",
  "merged_ids": [],
  "lane": "L5-generation"
}
```

## gen-11: postSeedSpine.ts contains a raw NUL byte, so git treats it as binary: no diffs in PRs, invisible to git grep

**confirmed** · verifier severity **low** (finder: low) · gen · tooling · `backend/src/generation/postSeedSpine.ts:127` · L5-generation

```json
{
  "id": "gen-11",
  "area": "gen",
  "category": "tooling",
  "title": "postSeedSpine.ts contains a raw NUL byte, so git treats it as binary: no diffs in PRs, invisible to git grep",
  "file": "backend/src/generation/postSeedSpine.ts",
  "line": 127,
  "severity": "low",
  "scenario": "Line 127 has a literal U+0000 inside a template literal instead of the `\\u0000` escape. git detects the file as binary: the F-98 commit a2a2c75 shows `postSeedSpine.ts | Bin 0 -> 18962 bytes`, every later change shows 'Binary files differ', GitHub PR review renders no diff, and `git grep` reports only 'Binary file matches'. Reviewers and the audit fleet cannot see changes to the module that decides every beat's tape seed. It is the only binary-detected file in backend/src.",
  "evidence": "node scan: line 127 `const key = `${w.episodeId}<NUL>${Math.round(w.startSec)}`;`, and `git show --stat a2a2c75` shows `backend/src/generation/postSeedSpine.ts | Bin 0 -> 18962 bytes`",
  "fix_sketch": "Replace the raw byte with the escape sequence `\\u0000` (same runtime string). Optionally add a CI check that fails on control characters in *.ts, or `*.ts text diff` in .gitattributes.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked this against origin/main (b01ea3d6) and the finding holds. Line 127 of backend/src/generation/postSeedSpine.ts, shown with cat -v, reads `const key = `${w.episodeId}^@${Math.round(w.startSec)}`;`. The ^@ is a literal NUL byte, not the `\\u0000` escape.\n\n- **git sees it as binary:** `git grep` returns only \"Binary file origin/main:backend/src/generation/postSeedSpine.ts matches\". `git diff --numstat` from the empty tree to origin/main lists it as \"-  -\". It is the only file under backend/src that numstat shows as binary.\n- **The F-98 commit:** `git show --stat a2a2c75` shows `postSeedSpine.ts | Bin 0 -> 18962 bytes`, as claimed. It is still the only commit that touches the file, so the \"later changes show Binary files differ\" part hasn't happened yet. Any future edit will hit it.\n- **Not handled elsewhere:** .gitattributes at origin/main only has `-text` entries for fixtures, data files and tools/foray/*.mjs, plus `merge=union` for STATE.md. Nothing forces `*.ts` to diff as text, and no comment says the raw NUL is intentional.\n- **Runtime is fine:** JS reads a raw NUL in a template literal the same as `\\u0000`, so the key logic is correct.\n\nThe only impact is on review and grep visibility (PR diffs and `git grep` for this module), so severity stays low. The fix is simple: use the `\\u0000` escape and optionally add a CI or .gitattributes guard.",
  "merged_ids": [],
  "lane": "L5-generation"
}
```

## gen-12: finalizeForay throws, instead of returning ok:false, on pool collisions and duplicate ids, which bypasses refusedPartial 'continue' and can loop on resume

**confirmed** · verifier severity **low** (finder: low) · gen · error-handling · `backend/src/generation/finalizeForay.ts:517` · L5-generation

```json
{
  "id": "gen-12",
  "area": "gen",
  "category": "error-handling",
  "title": "finalizeForay throws, instead of returning ok:false, on pool collisions and duplicate ids, which bypasses refusedPartial 'continue' and can loop on resume",
  "file": "backend/src/generation/finalizeForay.ts",
  "line": 517,
  "severity": "low",
  "scenario": "buildCandidateFiles throws on mintedPoolCollisions, on a duplicate Foray id, and (through mintedSegmentRow) on a bad minted row. It runs inside finalize, which buildPartialCandidate calls at every act. The throw escapes as a plain Error, not RefusedPartialError. So `--continue-on-refused-partial` still dies at act 1, and the report cannot say which act was refused (refusedAtAct is null). The 'source' stage is checkpointed, so if the committed pool gained a row at the same start between sourcing and finalize (another Foray published during a budget-window wait), every in-process resume replays the banked sourcing and throws the same collision until someone runs --no-resume.",
  "evidence": "`const collisions = mintedPoolCollisions(...); if (collisions.length > 0) throw new Error(`finalizeForay: ${collisions.join(\"; \")}`);` inside the `check-forays` timing of finalizeForay",
  "fix_sketch": "Return these as checkForaysErrors (validation.ok=false) so both the partial gate and the final gate report them uniformly. When a collision is detected on a resumed run, drop the `source` checkpoint so the next attempt re-sources against the current pool.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main myself. In finalizeForay.ts, `buildCandidateFiles` throws a plain Error on a duplicate Foray id (line 508) and on `mintedPoolCollisions` (lines 517-518). It is called inside the `check-forays` timing of `finalizeForay` (line 580). `buildPartialCandidate` (partialCandidate.ts:181) calls `finalize` with no try/catch. So the Error escapes through the `onActReady` callback in runPipeline.ts, ahead of the `options.refusedPartial === \"abort\"` check at ~1424, and `--continue-on-refused-partial` makes no difference. In generateForays.ts, `classifyFailure` does not see a RefusedPartialError, so the kind becomes \"fatal\" and `refusedAtAct` is null (line 606). The `source` stage is checkpointed (`stage(\"source\", SourceCheckpointSchema...)`, ~1260). The mintedPoolCollisions doc comment names this very case (\"a checkpoint resumed against a pool that gained the row\").\n\nOne correction to the scenario: a plain Error is classed \"fatal\", and fatal failures are not retried inside the process. So the process does not loop through resumes. It stops that prompt once, with the checkpoint kept. The loop happens across invocations: each new CLI run resumes from the banked `source` checkpoint and throws the same collision until someone passes --no-resume or deletes the checkpoint.\n\nThe refusal is deliberate: F-84 says a colliding publish must not finish, and G-30 keeps the duplicate-id throw as a last line of defence. Nothing in the code or in DECISIONS.md says the throw is meant to bypass the partial gate and the refusedAtAct reporting. That is a side effect, not a stated choice. No data is corrupted and the run fails loudly. The costs are a vague \"fatal\" classification and a sticky checkpoint that needs a manual --no-resume, so the severity stays low.",
  "merged_ids": [],
  "lane": "L5-generation"
}
```

## gen-13: Foray id and topic are re-derived on every resume, so a resumed run publishes under a different id than its streamed partials

**confirmed** · verifier severity **low** (finder: low) · gen · stale-state · `backend/src/generation/runPipeline.ts:1234` · L5-generation

```json
{
  "id": "gen-13",
  "area": "gen",
  "category": "stale-state",
  "title": "Foray id and topic are re-derived on every resume, so a resumed run publishes under a different id than its streamed partials",
  "file": "backend/src/generation/runPipeline.ts",
  "line": 1234,
  "severity": "low",
  "scenario": "`startedAt = now()` is read after the spine stage and seeds forayId, and neither is checkpointed. generateForays resumes in-process after transient or budget-window failures, sometimes the next day. Each attempt mints a new forayId, so the partial file a listener was polling (lastPartialId) changes id mid-run. That breaks the 'listener polling the partial and the candidate that eventually replaces it have to be the same Foray' contract stated in the comment. Likewise the pre-spine topic decision (topicDecision, measured against the bodies on disk NOW) is recomputed, while research-shape and spine are resumed from a checkpoint filtered by the old topic. If the transcript farm added bodies in between, sourcing gates on a different topic from the one the spine was built for.",
  "evidence": "`const startedAt = now().toISOString(); ... const forayId = uniqueForayId(forayIdFor(mintedFrom, startedAt), ...)` and `topicDecision = decided.decision` are outside any `stage()` call",
  "fix_sketch": "Checkpoint a small `identity` stage ({startedAt, forayId, topic, basis}) the first time they are computed, and resume it like any other stage.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main and the finding holds.\n\n**The code does what the finding says.**\n- In runPipeline.ts, `startedAt = now().toISOString()` (line 1234) and `forayId = uniqueForayId(forayIdFor(mintedFrom, startedAt), ...)` (line 1240) are computed outside any `stage()`, and nothing saves them to the checkpoint.\n- `forayIdFor` (resolveTopic.ts:446) builds the id's suffix from sha1(title + \"\\n\" + timestamp), so a different `startedAt` gives a different id.\n- generateForays.ts does not pass `options.now`, so `now()` is the real wall clock.\n- The resume loop in generateForays.ts (around lines 580-620) calls `runPipeline` again in-process, after a backoff for transient failures or after `msUntilNextLocalDay` for budget-window failures. Each attempt reopens the same checkpoint but mints a fresh `forayId`.\n- Resumed `stitch:<i>` stages do not fire `onActReady`. The first act stitched after a resume rewrites the same `.partial.json` file under the new id. The finished candidate then also carries the new id.\n\n**It breaks a real lookup.** `generationStatus.readPartialCandidate` finds a partial by matching `candidate.id === forayId`, not by filename, and player-streaming-brief.md §2 says a listener only ever knows the Foray id. So a listener holding the pre-resume id gets `found:false` after the next act. That contradicts the comment at line 1227-1233, which says the listener polling the partial and the candidate that replaces it must be the same Foray.\n\n**The topic half is also real, but less likely to matter.**\n- `topicDecision` is recomputed on every attempt from supply measured now (`bodyStat` / archive).\n- `research-shape` and `spine` come back from the checkpoint built with the old topic, which filtered the map.\n- The checkpoint fingerprint covers only prompt, duration and `options.topic`, not the derived topic.\n- If the body supply changes between attempts, sourcing can gate on a different topic. This needs the supply to change within the resume window, which is plausible for a next-day budget-window resume.\n\n**Why it is not deliberate or handled elsewhere.** The comment explicitly wants one stable id, so this is an oversight, not a design choice. I found nothing in docs/DECISIONS.md that covers resume identity.\n\n**Why severity is low.** The status endpoint is still a future route (the partial file is read CLI-side only for now), and the wrong-topic case needs a rare change in supply. The fix sketch (checkpoint an identity stage holding startedAt, forayId and topic) is reasonable.",
  "merged_ids": [],
  "lane": "L5-generation"
}
```

## gen-14: Re-ask calls are not recorded in usageTracking in 5 of 7 builders, so pipelineTokens and report `calls` undercount

**confirmed** · verifier severity **low** (finder: low) · gen · metrics · `backend/src/generation/AnthropicDeepenActBuilder.ts:122` · L5-generation

```json
{
  "id": "gen-14",
  "area": "gen",
  "category": "metrics",
  "title": "Re-ask calls are not recorded in usageTracking in 5 of 7 builders, so pipelineTokens and report `calls` undercount",
  "file": "backend/src/generation/AnthropicDeepenActBuilder.ts",
  "line": 122,
  "severity": "low",
  "scenario": "The re-ask inside parseWithRetry is a full paid request (it re-sends the prompt). Only the Narration writer and verifier call recordUsage on it. Continuity, DeepenAct, Spine, PromptUnderstander (intent and clarity re-asks) and both ExternalResearcher calls do not. Each malformed reply undercounts meta.veracity.pipelineTokens (WS-B's KPI) and generateForays' `calls`. For example, a retrieval re-ask with 2000 output tokens goes missing. Counted per file: Continuity 2 creates, 1 record; Deepen 2/1; Spine 2/1; Researcher 5/2; Understander 5/3.",
  "evidence": "AnthropicDeepenActBuilder.ts:122 `const retryResponse = await this.client.messages.create({...});` followed directly by the text-block find, with no `recordUsage(retryResponse.usage)`",
  "fix_sketch": "Add recordUsage(retryResponse.usage) in every reask. Better, route all Anthropic calls through one helper that meters, records usage and checks stop_reason, so the seven copies cannot drift again.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read each builder at origin/main and the finding holds. In AnthropicDeepenActBuilder.ts, the reask closure calls `this.client.messages.create` at line 122, then goes straight to the text-block find at lines 131-133. There is no `recordUsage(retryResponse.usage)`. The same gap is in:\n- AnthropicContinuityBuilder.ts: the re-ask create is at line 90; the only recordUsage is at line 71.\n- AnthropicSpineBuilder.ts: the re-ask create is at line 145; the only recordUsage is at line 126.\n- AnthropicExternalResearcher.ts: the re-ask creates are at lines 132 and 226; recordUsage runs only at lines 110 and 205, for the initial calls.\n- AnthropicPromptUnderstander.ts: the re-ask creates are at lines 107 and 161; recordUsage runs only at lines 88, 142 and 226.\n\nAnthropicNarrationWriterBuilder.ts (line 191) and AnthropicNarrationVerifierBuilder.ts (line 160) do record retryResponse.usage. One detail is off: the Researcher has 4 real create calls, not 5. The fifth grep hit is a comment on line 119. The substance is unaffected.\n\nThis is not deliberate. The usageTracking.ts module doc says recordUsage is \"Called once, right after every real `client.messages.create(...)` in every `Anthropic*Builder`\", and it says pipelineTokens needs usage from EVERY model reply. parseWithRetry.ts has a BUDGET note calling a re-ask \"its own real, metered API call\". So the budget guard meters re-asks, but usage tracking does not. Nothing else records re-asks: recordUsage is only called at these call sites.\n\nImpact: each malformed-JSON re-ask in these five builders is missing from the pipelineTokens totals (input and output tokens) and from the `calls` count. The builders are uneven, which makes the metric harder to trust. Spend control is not affected because the budget guard does meter re-asks, and a re-ask only happens after a parse failure. That keeps the severity low.",
  "merged_ids": [],
  "lane": "L5-generation"
}
```

## gen-15: Transcript cue cache and caches keyed without `root` grow or go stale for the process lifetime

**confirmed** · verifier severity **low** (finder: low) · gen · resource-leak · `backend/src/generation/transcriptArchiveLookup.ts:311` · L5-generation

```json
{
  "id": "gen-15",
  "area": "gen",
  "category": "resource-leak",
  "title": "Transcript cue cache and caches keyed without `root` grow or go stale for the process lifetime",
  "file": "backend/src/generation/transcriptArchiveLookup.ts",
  "line": 311,
  "severity": "low",
  "scenario": "FileTranscriptCueProvider.cuesByKey keeps every parsed cue array forever. The batch driver shares one provider across all prompts, and a stale text-index rebuild calls getCues for EVERY body of a show (transcriptTextIndex.build), so one rebuild pins a whole corpus's cues (thousands of episodes) in memory for the rest of the batch. Separately, loadTaxonomyNodes(root) and loadSegmentPool() cache the first root's data and ignore later `root` arguments (loadTaxonomyNodes also ignores FORAY_SKIP_CATALOGUE_CACHE). runPipeline times the runtime pool with loadSegmentPool() (repo root) rather than deps.segmentPool or options.root, while finalize validates against `options.root`.",
  "evidence": "`this.cuesByKey.set(key, result);` (unbounded Map). resolveTopic.ts:182 `if (cachedNodes) return cachedNodes;` ignores `root`. runPipeline.ts:1357 `const runtimePool = mintedPool.length ? [...mintedPool, ...loadSegmentPool()] : loadSegmentPool();`",
  "fix_sketch": "Bound cuesByKey with a small LRU, and have the index builder read bodies without populating it. Key root-sensitive caches by root, and honour FORAY_SKIP_CATALOGUE_CACHE. Build runtimePool from `segmentPool` (the injected or loaded pool the run sourced against).",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read the code at origin/main. The main claim holds, but part of the secondary claim is wrong.\n\n1. Unbounded cue cache: confirmed. In transcriptArchiveLookup.ts, `FileTranscriptCueProvider.cuesByKey` is a plain Map. `getCues` stores every parsed result (including null) with `this.cuesByKey.set(key, result)` and never removes anything. generateForays.ts:783-788 creates one `cueProvider` for the whole batch and passes it as the text index's `bodies` (`new FileTranscriptTextIndex({ bodies: cueProvider })`). When a show's index cache is stale, `build()` (transcriptTextIndex.ts ~415-419) calls `this.bodies.getCues(entry)` on every body in that show. Each rebuilt show's full set of cue arrays then stays in memory until the batch ends. The class comment says \"Reads are cached per process; a batch run asks for the same episode from many beats.\" So per-process caching is intended, but nothing addresses how large the cache can get. The scenario can happen, and the corpus is large: the docs say about 1,346 bodies on disk.\n\n2. Caches that ignore `root`: partly confirmed.\n- Confirmed: `loadTaxonomyNodes(root)` in resolveTopic.ts returns `cachedNodes` whenever it is set, whatever `root` is passed. It also does not check FORAY_SKIP_CATALOGUE_CACHE, unlike its sibling loaders (catalogueLookup, segmentPoolLookup, audioSourceLookup, taxonomyFamily).\n- Inaccurate: `loadSegmentPool()` takes no `root` argument at all and does honour FORAY_SKIP_CATALOGUE_CACHE (segmentPoolLookup.ts:55). The problem is that it always reads the repo root, not that it keeps a stale earlier root.\n- Confirmed: runPipeline.ts:1357 builds `runtimePool` from `loadSegmentPool()`, not from `segmentPool` (`deps.segmentPool ?? loadSegmentPool()`, line 1055). Meanwhile `finalize(input, options.root)` and the other calls use `options.root`.\n\nImpact: production batch runs use the repo root, so the root and injection mismatches mainly matter for tests or a non-default root. They can make runtime seconds disagree with an injected pool. The memory growth only affects a long-running batch process on a machine that holds the corpus. It is a real inefficiency and inconsistency, not a correctness failure in the normal path. I found no decision or comment that justifies either the unbounded growth or ignoring `root`. Severity: low.",
  "merged_ids": [],
  "lane": "L5-generation"
}
```

## gen-16: runPhonemizer silently drops all phonemes on any subprocess failure, including ENOBUFS from spawnSync's 1 MB default buffer

**confirmed** · verifier severity **low** (finder: low) · gen · error-handling · `backend/src/generation/phonemize.ts:136` · L5-generation

```json
{
  "id": "gen-16",
  "area": "gen",
  "category": "error-handling",
  "title": "runPhonemizer silently drops all phonemes on any subprocess failure, including ENOBUFS from spawnSync's 1 MB default buffer",
  "file": "backend/src/generation/phonemize.ts",
  "line": 136,
  "severity": "low",
  "scenario": "spawnSync runs with the default maxBuffer (1 MiB) and python3 (not present by that name on stock Windows). If stdout overflows (a long Foray's phoneme JSON), python is missing, or the script exits non-zero, `res.status !== 0 || !res.stdout` returns an empty map. No log line is written and res.error/res.stderr are never surfaced. The Foray ships with no Kokoro phonemes and nothing says why.",
  "evidence": "`const res = spawnSync(python, [...], { cwd: repoRoot, input: JSON.stringify({ items: scripts }), encoding: \"utf8\" }); if (res.status !== 0 || !res.stdout) return empty;`",
  "fix_sketch": "Pass a generous maxBuffer (e.g. 64 MB). Log res.error?.code and a stderr excerpt when returning empty. Have the caller report 'phonemized N of M' so a total miss is visible.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The code at origin/main:backend/src/generation/phonemize.ts matches the finding. runPhonemizer calls spawnSync(python, [script, \"--json\", \"-\"], { cwd, input, encoding: \"utf8\" }) without setting maxBuffer, so the default 1 MiB applies. The interpreter defaults to FORAY_PYTHON || \"python3\". It then runs `if (res.status !== 0 || !res.stdout) return empty;`, and a JSON.parse failure also returns empty. Nothing is logged, and res.error and res.stderr are never read. If stdout goes past 1 MiB, spawnSync kills the child and sets error to ENOBUFS with a null status, so the function returns the empty map without saying why. The same happens when python3 is missing (ENOENT, status null).\n\nSome of this is deliberate. The doc comment says it \"NEVER THROWS\": a missing interpreter, a missing package, a non-zero exit and unparseable output are all meant to mean \"no phonemes\", and the fallback is the platform-voice path. The comment says nothing about hiding the reason, though. The file also exports phonemizedCount so a publish PR can report \"31 of 34 pages phonemized\". That count would show a total miss, but it gives no cause.\n\nTwo things lower the impact. First, nothing in production calls it yet: `git grep` at origin/main finds runPhonemizer, phonemizeItems and phonemizedCount only in backend/test/phonemize.test.ts. Today no Foray can actually ship without phonemes through this path. Second, the ENOBUFS case is unlikely for a 34-page Foray, where phoneme JSON would be in the hundreds of KB, not over 1 MiB. The python3-missing-on-Windows case is the realistic one.\n\nThe defect is real (no diagnostics, no maxBuffer) but latent, and the empty result on failure is intended. The severity stays low.",
  "merged_ids": [],
  "lane": "L5-generation"
}
```

## backend-rest-2: Learning cursor truncates Postgres microseconds to milliseconds, so the last event is re-applied on every run

**confirmed** · verifier severity **medium** (finder: medium) · backend-rest · correctness · `backend/src/curation/eventStore.ts:162` · L6-backend-rest

```json
{
  "id": "backend-rest-2",
  "area": "backend-rest",
  "category": "correctness",
  "title": "Learning cursor truncates Postgres microseconds to milliseconds, so the last event is re-applied on every run",
  "file": "backend/src/curation/eventStore.ts",
  "line": 162,
  "severity": "medium",
  "scenario": "events.ts defaults to now(), which has microsecond precision (for example 12:00:00.123456). PostgresEventStore.fetchSince turns each row into `new Date(row.ts).toISOString()` = 12:00:00.123Z, and learningJob.ts:39 stores that as the cursor. On the next run the query `ts > $2::timestamptz` is true for the same event (…123456 > …123000), so it is fetched and applied again. Each run of `npm run learn-interests` re-adds the last event's delta (for example +0.08 finished_strong), even when the user has no new activity, and writes a duplicate user_interests audit row. Weights drift toward +1 or -1. This is dormant until DATABASE_URL is set. The tests only use InMemoryEventStore, so they cannot catch it.",
  "evidence": "eventStore.ts:145-162: `select id, user_id, ts, ... where ... ts > $2::timestamptz or (ts = $2::timestamptz and id > ...)` then `ts: new Date(row.ts).toISOString()`. learningJob.ts:39: `await deps.cursorStore.set(userId, { lastEventTs: last.ts, lastEventId: last.id });`. learningCursor.ts:46 truncates the same way.",
  "fix_sketch": "Keep full precision end to end. Select `to_char(ts at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as ts_text` (or `ts::text`), use that string as the cursor, and store it. Alternatively, write events.ts truncated to milliseconds (`date_trunc('milliseconds', now())`). Add a Postgres-backed or precision-aware test where the cursor round-trips an event with a microsecond timestamp.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "The finding holds at origin/main. I read the code myself and did not run a test, since the mechanism is clear from the source.\n\n- **Where the timestamp comes from.** backend/migrations/0009_events.sql:9 defines `ts timestamptz not null default now()`, which Postgres stores to the microsecond. The only writer is PostgresEventStore.record (eventStore.ts:109). It never supplies ts, so every event gets the full-precision now().\n- **Where precision is lost.** fetchSince (eventStore.ts ~129-168) turns each row into `new Date(row.ts).toISOString()`. A JS Date only holds milliseconds, so this drops the last three digits. It does so whatever pg returns: a Date already holds only ms, and a string gets parsed to ms.\n- **How the cursor inherits it.** learningJob.ts:39 saves `last.ts` as the cursor. The learning_cursor column is timestamptz (0015). PostgresLearningCursorStore.get (learningCursor.ts:46) also passes the value through `new Date(...).toISOString()`, so the stored cursor stays truncated.\n- **Why the same event comes back.** On the next run the where clause `ts > $2::timestamptz` is true for the last event, because for example .123456 > .123000. The `(ts = $2 and id > $3)` tie-breaker never gets a chance to exclude it.\n- **Nothing downstream catches it.** A grep of backend/src/curation turns up no idempotency check on source_event_id. learningRepository.ts:174 just inserts a new audit row. So each `npm run learn-interests` run re-applies the last event's delta and writes a duplicate user_interests row.\n- **Not deliberate.** 0015_learning_cursor.sql says the (ts, id) cursor exists so boundary events are \"neither skipped nor reprocessed\", which this bug breaks. I found no ruling or comment excusing it.\n- **Only in-memory tests.** The job wiring in learnInterests.ts uses the Postgres stores, while the tests use the in-memory stores, so they cannot catch this.\n\nWhy medium rather than high: the bug is dormant. Nothing in backend/src calls PostgresEventStore.record yet, so no events are being written, and the CLI also needs DATABASE_URL. Once events do flow, it will trigger on essentially every run and quietly push interest weights toward the clamp. That is silent data corruption in personalization, so medium fits.",
  "merged_ids": [],
  "lane": "L6-backend-rest"
}
```

## backend-rest-3: Learning job trusts unvalidated event payloads: one malformed row crashes the run and stalls the user's cursor for good

**confirmed** · verifier severity **low** (finder: medium) · backend-rest · error-handling · `backend/src/curation/interestLearning.ts:118` · L6-backend-rest

```json
{
  "id": "backend-rest-3",
  "area": "backend-rest",
  "category": "error-handling",
  "title": "Learning job trusts unvalidated event payloads: one malformed row crashes the run and stalls the user's cursor for good",
  "file": "backend/src/curation/interestLearning.ts",
  "line": 118,
  "severity": "medium",
  "scenario": "The events table is client-writable under RLS (supabase/0001 own_rows_events, for all). PostgresEventStore.fetchSince casts rows `as PersistedEvent` without running parseEventRow, so zod's `topics: default([])` and the type checks never run. A `finished`/`picked`/`saved`/`card_shown` row with no `topics`, or with `topics` as a string, makes `p.topics.map` / `new Set(current.payload.topics)` throw a TypeError. runLearningJobForUser never advances the cursor, so every later run hits the same row again. learnInterests.ts loops over users with no try/catch, so all remaining users are skipped too. Earlier events in the batch were already written with no transaction, so a re-run applies them twice.",
  "evidence": "eventStore.ts:157-168 `result.rows.map((row) => ({ ... payload: row.payload }) as PersistedEvent)`; interestLearning.ts:118 `return p.topics.map((nodeId) => ...)`; learnInterests.ts:78 `for (const userId of users) { const result = await runLearningJobForUser(...) }` with no per-user catch; learningJob.ts:36-39 applies then sets the cursor, not in a transaction.",
  "fix_sketch": "In fetchSince, run each row through safeParseEventRow. Rows that fail are skipped with a warning (or routed to a dead-letter list) but the cursor still advances past them. Run each user's apply and cursor update inside one BEGIN/COMMIT on the shared client. Wrap each user in the CLI in try/catch and set exitCode=1 at the end.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main and the mechanism holds. Two things limit the impact.\n\nWhat the code does:\n- **No validation on read.** `PostgresEventStore.fetchSince` (eventStore.ts:157-169) casts each raw row `as PersistedEvent`. It never calls `parseEventRow` or `safeParseEventRow`, so zod's `topics: default([])` and the type checks don't run on the read path.\n- **The table accepts any payload.** `0009_events.sql` only checks the `type` enum. `payload` is unchecked jsonb with no constraint or trigger.\n- **Clients can write it.** The `own_rows_events` policy is `for all to authenticated`: first defined in supabase/0001, then recreated that way in supabase/0002. app.js:585 POSTs rows directly to `/rest/v1/events` with an anonymous-session token. Any anonymous user can therefore insert, for example, `{type:'finished', payload:{percent_complete:1}}` with no `topics`.\n- **The crash.** `deriveInterestDeltas` then reaches `p.topics.map` and throws a TypeError. The same happens for picked/saved/skipped_at/card_shown, and for card_shown in `computeCardIgnoredStreak`.\n- **The cursor never moves.** `runLearningJobForUser` (learningJob.ts:36-39) applies the batch before it sets the cursor, with no transaction and no catch. So a throw leaves the cursor where it was.\n- **Double-apply on re-run.** Events earlier in the batch have already been written through `setWeightAndConfidence` and `auditRepo.append` with no BEGIN/COMMIT. A re-run applies them again.\n- **Other users are skipped.** The per-user loop in learnInterests.ts:78 has no try/catch. The first failing user aborts the rest of the run, and top-level `main().catch` sets exitCode=1.\n- **Not deliberate.** Nothing in docs/DECISIONS.md or the code comments treats this as intended, and nothing handles it elsewhere.\n\nWhat limits the impact:\n1. **The shipped client doesn't produce such rows.** app.js's `toEventRow` always sends `topics: p.topics || []` for picked and saved. It drops thumbs rows that have no `node_id`, and it doesn't emit finished, skipped_at or card_shown at all. So a bad row needs a hand-crafted request or a future client bug.\n2. **The poison mostly hurts the sender.** A crafted row freezes the learning cursor for that user's own events. It reaches other users only in a multi-user `--user a --user b` run, where users listed after the poisoned one are skipped.\n3. **Nothing runs the job on a schedule.** `learn-interests` is a manual CLI whose default is a single seeded placeholder user. I found no cron or routine that calls it: `generateForay.ts` and DECISIONS.md:1953 only list it among the manually run CLIs.\n\nThe partial-batch double-apply is the most real integrity problem, but it only happens once something has already thrown. The bug is real but has limited reach today, so I rate it low. It should become medium once the job runs on a schedule over all users.",
  "merged_ids": [],
  "lane": "L6-backend-rest"
}
```

## backend-rest-5: own_rows policies are `for all`, so clients can rewrite the append-only interest audit log and forge learned weights or event timestamps

**confirmed** · verifier severity **low** (finder: medium) · backend-rest · security · `backend/migrations/supabase/0002_linter_findings.sql:48` · L6-backend-rest

```json
{
  "id": "backend-rest-5",
  "area": "backend-rest",
  "category": "security",
  "title": "own_rows policies are `for all`, so clients can rewrite the append-only interest audit log and forge learned weights or event timestamps",
  "file": "backend/migrations/supabase/0002_linter_findings.sql",
  "line": 48,
  "severity": "medium",
  "scenario": "The recreated own_rows_* policies grant FOR ALL (select/insert/update/delete) on user_interests, taxonomy_nodes and events. So an authenticated client can: (1) UPDATE or DELETE rows in user_interests, which 0006 calls an 'append-only ... inspectable audit trail'; (2) write taxonomy_nodes directly with any weight and source='inferred', contradicting principle #2 (state observed, never declared); (3) insert an events row with ts far in the future (for example 2099). After that row is processed the learning cursor jumps to 2099 and every real event (ts=now()) fails `ts > cursor`, so learning for that user is silently frozen for good. A client with a skewed clock that sends ts can do the same by accident.",
  "evidence": "supabase/0002_linter_findings.sql:42-60: `create policy %I on public.%I for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)` over 'taxonomy_nodes','user_interests','events',...; 0009_events.sql: `ts timestamptz not null default now()` with no guard on client-supplied values.",
  "fix_sketch": "Split the policies per table. events: insert and select only, and force `ts` server-side with a BEFORE INSERT trigger (`new.ts := now()`) or a check `ts <= now() + interval '5 minutes'`. user_interests: select only, since the service-role job is the only writer. taxonomy_nodes: select plus a narrowly scoped update for manual-edit if the product needs it, with source forced to 'manual-edit'.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The mechanics check out at origin/main. backend/migrations/supabase/0002_linter_findings.sql:38-59 recreates own_rows_* as `for all to authenticated using/with check ((select auth.uid()) = user_id)` on taxonomy_nodes, user_interests and events, plus five other tables. 0009_events.sql has `ts timestamptz not null default now()` and nothing guards a client-supplied value. The shipped client really does send device time: app.js toEventRow (line 514) builds `{ user_id, ts: e.ts, ... }` and POSTs it to /rest/v1/events. PostgresEventStore.fetchSince (eventStore.ts) selects `ts > cursor OR (ts = cursor AND id > cursorId)`, and learningJob.ts:39 moves the cursor to the last processed ts. So one row stamped in the future, whether forged or from a device clock set ahead, would stop all later real events from being learned for that user. user_interests (called append-only in 0006 and ADR-0003) and taxonomy_nodes can also be updated directly by the client.\n\nMitigations, and why I lowered severity from medium to low:\n(1) DELETE is partly intended. app.js ~13750 says the `for all` policy is relied on so the data-deletion control can DELETE the user's own rows (sbDeleteOwnRows). So the fix sketch's 'user_interests: select only' would break data deletion. Keep DELETE and remove only UPDATE and INSERT where they aren't needed.\n(2) Every effect stays inside the attacker's own account. RLS is still per user, so forged weights, a rewritten audit log or a frozen cursor only damage the attacker's own recommendations. No other user is affected.\n(3) The learning job is not scheduled anywhere. backend/package.json only has the manual script `learn-interests` and nothing in .github runs it. The supabase/README says these policies are 'NOT yet verified against a live project'. The cursor freeze can't happen in production today.\n\nThe one part a normal user could hit is the accidental clock-skew freeze, since the client sends device ts. It is worth fixing before the learning job goes live, either by setting ts server-side or clamping it, e.g. `least(ts, now())` in a trigger. I found no DECISIONS.md entry that deliberately allows UPDATE or INSERT on these tables.",
  "merged_ids": [],
  "lane": "L6-backend-rest"
}
```

## backend-rest-6: publish-foray adds the `hold` label in a second call after `gh pr create`, so a failed label call leaves a --force'd Foray auto-mergeable

**confirmed** · verifier severity **medium** (finder: medium) · backend-rest · correctness · `backend/src/cli/publishForay.ts:863` · L6-backend-rest

```json
{
  "id": "backend-rest-6",
  "area": "backend-rest",
  "category": "correctness",
  "title": "publish-foray adds the `hold` label in a second call after `gh pr create`, so a failed label call leaves a --force'd Foray auto-mergeable",
  "file": "backend/src/cli/publishForay.ts",
  "line": 863,
  "severity": "medium",
  "scenario": "automerge-nightly.yml arms auto-merge on the pull_request `opened` event, and hold is the only thing that disarms it for a data/-only PR. publishForay creates the PR first, then runs `gh pr edit --add-label hold` as a separate process. If that second call fails (network blip, rate limit, the label missing in a fork or fresh repo, an expired gh token), execFileSync throws. main() prints the error and exits, but the PR is already open with no hold. With --force, which the audit-A fix says must always carry hold, the unverified-narration Foray merges on green CI and ships to every phone. There is also a window between open and label where the arming run executes.",
  "evidence": "publishForay.ts:851-866: `const prUrl = run(\"gh\", [\"pr\",\"create\",\"--base\",\"main\",\"--title\",...,\"--body\",...]); ... if (args.hold) { run(\"gh\", [\"pr\", \"edit\", prUrl, \"--add-label\", \"hold\"]); }`",
  "fix_sketch": "Pass the label atomically: add `...(args.hold ? [\"--label\", \"hold\"] : [])` to the `gh pr create` args. Optionally create the PR as `--draft` and mark it ready only after the label is confirmed. If a separate label step is kept, catch its failure and close the PR, or at least exit non-zero with a loud 'PR is NOT held' message.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main myself and the finding holds. In backend/src/cli/publishForay.ts at lines 851-866, `gh pr create` runs with no `--label`, and only afterwards does `if (args.hold) run(\"gh\", [\"pr\",\"edit\",prUrl,\"--add-label\",\"hold\"])` run as a separate process. parseArgs (lines 182-220) forces `hold: true` whenever `--force` is given. Its header comment (lines 116-122) says a forced publish \"always carries hold\". The code does not keep that promise if the second gh call fails. In that case the throw reaches main().catch, which only prints the error and sets exitCode=1. Nothing closes the PR, removes the arming, or retries the label.\n\n.github/workflows/automerge-nightly.yml runs on `opened` with the base branch as main and the head in the same repo. tools/ci/path-policy.mjs puts `data/` on the auto-merge allowlist and treats only `hold`/`founder-decision` as blocking labels. So an unlabelled data-only publish PR gets auto-merge turned on when it opens, and GitHub merges it once the required checks pass.\n\nThe race window in the scenario is not a real problem. If the label call succeeds, the `labeled` event re-decides NOT ARMED and turns auto-merge off. The concurrency group also cancels the in-flight `opened` run. The real hole is only the path where the label call fails. Nothing else re-applies hold:\n- pr-hygiene/pr-triage only write the needs-founder and merge-conflict labels.\n- The spec doc (foray-generation-requirements.md:3656) describes the same two-step `gh pr edit` sequence.\n- No comment or doc marks the non-atomic design as deliberate.\n\nSeverity is medium, not high. The failure needs gh create to succeed and then gh edit to fail within seconds (a transient network, rate-limit or auth problem). The process also exits non-zero, so an operator watching the nightly might notice. The damage, though, is an unreviewed forced narration reaching every phone. The fix is cheap and fails closed: pass `--label hold` to `gh pr create`. A missing label would then stop the PR from being created at all.",
  "merged_ids": [],
  "lane": "L6-backend-rest"
}
```

## backend-rest-7: generate-forays rewrites report.json from this run only, dropping rows (and their publish records) for candidates it skipped as already built

**confirmed** · verifier severity **medium** (finder: medium) · backend-rest · data-loss · `backend/src/cli/generateForays.ts:831` · L6-backend-rest

```json
{
  "id": "backend-rest-7",
  "area": "backend-rest",
  "category": "data-loss",
  "title": "generate-forays rewrites report.json from this run only, dropping rows (and their publish records) for candidates it skipped as already built",
  "file": "backend/src/cli/generateForays.ts",
  "line": 831,
  "severity": "medium",
  "scenario": "The batch is designed to be re-run in the same --out directory. Prompts whose candidate file exists are skipped (lines 481-484) and never pushed into `report`. writeReport then writes report.json whole with `entries: report`. On a re-run after a crash or budget stop, the entries for every already-built candidate disappear, including the `publish` records (pr_url, base_sha, deploy_id) and `publish_refused` rows that publish-foray wrote onto those rows. After that, `publish-foray --report` prints 'No row for X — nothing recorded' for those candidates.",
  "evidence": "generateForays.ts:481-484 `if (fs.existsSync(file)) { console.log(`  skip ...`); return { skipped: true, file }; }`; main loop 809-812 `if (result.skipped) { skipped++; continue; }`; 833-856 `fs.writeFileSync(reportPath, JSON.stringify({ ..., entries: report }))`.",
  "fix_sketch": "Before writing, load any existing report.json and merge by prompt or file basename. Keep prior entries for skipped prompts, and preserve `publish` and `publish_refused` fields on entries that are being replaced. Alternatively write a per-run report file (report-<timestamp>.json) and leave report.json as a merged index.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read backend/src/cli/generateForays.ts at origin/main and it does what the finding says. In generateOneCandidate (around lines 480-484), a prompt whose candidate file already exists returns `{ skipped: true, file }` with no entry. The main loop (around lines 809-812) counts that as skipped and moves on without pushing anything into `report`. writeReport (lines 830-857) then calls fs.writeFileSync on `<out>/report.json` with `entries: report`. It never reads the existing report.json first, and I found no merge code anywhere in the CLI. The file's own comments say re-running in the same directory is intended: the skip is called \"the OUTER resume\".\n\npublishForay.ts writes `publish` records (the PR details) and `publish_refused` (lines 649-704) onto rows it finds by `file` in that same report.json. When a row is missing it prints \"No row for X in report — nothing recorded.\" (line 882).\n\nSo this sequence loses data: run the batch, publish some candidates with `--report`, then re-run in the same --out directory, for example after a crash, a budget stop or with new prompts added. The re-run silently drops every earlier row, including its publish and refusal records. Any later `publish-foray --report` call for those candidates then records nothing. I found nothing in DECISIONS.md or in code comments that makes this deliberate or handles it elsewhere.\n\nRating it medium rather than high because nothing reaches users: the published PRs still exist on GitHub, and the candidate files stay on disk. The loss is the audit trail and publish bookkeeping for the batch.",
  "merged_ids": [],
  "lane": "L6-backend-rest"
}
```

## backend-rest-8: warm-transcript-index --show X overwrites corpus-digest.json with only X's rows, dropping every other show from the archive

**confirmed** · verifier severity **low** (finder: medium) · backend-rest · data-loss · `backend/src/cli/warmTranscriptIndex.ts:346` · L6-backend-rest

```json
{
  "id": "backend-rest-8",
  "area": "backend-rest",
  "category": "data-loss",
  "title": "warm-transcript-index --show X overwrites corpus-digest.json with only X's rows, dropping every other show from the archive",
  "file": "backend/src/cli/warmTranscriptIndex.ts",
  "line": 346,
  "severity": "medium",
  "scenario": "reconcileCorpus with onlyShows=[X] returns rows for X only, and writeCorpusDigest replaces data-local/transcripts/corpus-digest.json with them. Every row a previous full warm wrote for the other shows is gone, so loadTranscriptArchive no longer searches thousands of episodes until someone re-runs a full warm. That is the exact 'digest records the last run, not the corpus' failure this tool's header blames on fetch-transcripts.mjs. Separately, when rows.length===0 the stale file is left in place and never pruned.",
  "evidence": "main(): `const { rows, perShow } = await reconcileCorpus({ offline: args.offline, onlyShows: args.shows }); if (rows.length === 0) {...} else { const bytes = writeCorpusDigest(rows); ...}`; writeCorpusDigest writes `{ transcripts: rows }` via tmp+rename (lines 312-330).",
  "fix_sketch": "When args.shows is non-empty, read the existing corpus-digest.json and keep rows whose show_id is not in args.shows, then add the new rows. Always rewrite (an empty list included) on a full run so stale rows are pruned. Add a test: a full warm followed by a --show warm keeps the other shows' rows.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read backend/src/cli/warmTranscriptIndex.ts at origin/main and the finding holds. In reconcileCorpus, the loop skips any show that is not in options.onlyShows, so a `--show X` run returns rows for X only. main() then calls writeCorpusDigest(rows), which writes a new file containing just `{..., transcripts: rows}` (tmp file, then rename). It never reads or merges the corpus-digest.json that is already there. So any rows an earlier full warm wrote for other shows are gone. transcriptArchiveLookup.ts:115 reads CORPUS_DIGEST_FILE together with the two committed digests. Once those rows are lost, the other shows' uncommitted bodies drop out of loadTranscriptArchive. The second claim is also correct: when rows.length === 0 the old file is left in place and never pruned. Nothing marks this as deliberate. No comment or doc says it is intended; the only other place corpus-digest is mentioned is the reader. The file header even shows `--show this-podcast-will-kill-you` as a normal way to run the tool, and it criticises fetch-transcripts.mjs for the same \"record of the last run\" problem. Why I rate it low rather than medium: (1) the file is machine-local and a full warm rebuilds it completely, so nothing is permanently lost; (2) it is not silent. At the end, main() runs corpusCoverage over loadTranscriptArchive() against the bodies on disk. The dropped shows then appear as blind spots and the command exits with code 1, so the operator is warned right away. Suggested fix: when --show is set, merge the new rows into the existing file, and always rewrite the file on a full run.",
  "merged_ids": [],
  "lane": "L6-backend-rest"
}
```

## backend-rest-9: ingestShowFeed is not atomic and breaks its 'never throws' contract: a NUL from `&#0;` or any failing row aborts the ingest mid-upsert

**confirmed** · verifier severity **low** (finder: medium) · backend-rest · error-handling · `backend/src/catalog/showEpisodesStore.ts:114` · L6-backend-rest

```json
{
  "id": "backend-rest-9",
  "area": "backend-rest",
  "category": "error-handling",
  "title": "ingestShowFeed is not atomic and breaks its 'never throws' contract: a NUL from `&#0;` or any failing row aborts the ingest mid-upsert",
  "file": "backend/src/catalog/showEpisodesStore.ts",
  "line": 114,
  "severity": "medium",
  "scenario": "lenientXmlPreprocess strips raw control characters before parsing, but decodeEntities later turns `&#0;` or `&#x0;` into U+0000 in titles and description_text. Postgres text rejects 0x00 ('invalid byte sequence for encoding \"UTF8\": 0x00'), so the per-row INSERT throws partway through the loop. Nothing is in a transaction: half the episodes are upserted, recordFeedFetch never runs, and ingestShowFeed (documented 'Never throws') rejects. The DB-mode handler then 500s. Because the feed state is never recorded, every request retries the fetch and fails the same way. Even when it works, a 400-episode show costs 400 sequential round trips inside one serverless request.",
  "evidence": "showEpisodesStore.ts:112-148 `for (const ep of episodes) { await this.client.query(`insert into catalog_show_episodes ... on conflict ...`) }` with no BEGIN/COMMIT. ingestShowFeed.ts:137-152 has no try/catch around parseFeed/upsertEpisodes/recordFeedFetch. Verified that decodeEntities(\"a&#0;b\") returns \"a\\u0000b\".",
  "fix_sketch": "Drop or replace code point 0 (and other C0 controls except tab, LF, CR) in decodeEntities/sanitizeHtmlToText. Upsert in one statement (`insert ... select * from unnest($1::text[], ...)` or a VALUES batch) inside BEGIN/COMMIT. Wrap parse and upsert in try/catch in ingestShowFeed, record last_fetch_ok=false with the error, and fall back to cached rows as the contract promises.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read the code at origin/main and the finding holds, but it matters less than claimed.\n\n**What the code does:**\n- In backend/src/catalog/showEpisodesStore.ts, PostgresShowEpisodesStore.upsertEpisodes (lines ~112-148) runs one INSERT ... ON CONFLICT per episode in a for-loop. There is no BEGIN/COMMIT, so a failing row leaves the earlier rows committed.\n- In backend/src/catalog/ingestShowFeed.ts, the fresh-body path calls parseFeed, upsertEpisodes and recordFeedFetch with no try/catch. That breaks the doc comment's promise (\"Never throws: a fetch or parse failure degrades to the last-good cached rows\"). When upsertEpisodes throws, recordFeedFetch never runs. The feed state keeps the prior etag and last_fetch_ok, so the next request fetches and fails again.\n- In api/shows/[show_id]/episodes.ts (line ~282), the DB-mode handler has only try/finally around ingestShowFeed, so the error becomes an unhandled 500.\n\n**The NUL path is real:**\n- lenientXmlPreprocess (backend/src/feeds/parser.ts:58-60) strips raw C0 control characters but leaves the `&#0;` entity text alone. Its bare-ampersand regex even whitelists `&#\\d+;`.\n- decodeEntities (backend/src/feeds/html.ts:35-47) calls String.fromCodePoint(0) without filtering. It is applied to item titles (parser.ts:242) and in sanitizeHtmlToText. Nothing strips U+0000 afterwards.\n- Postgres text columns reject 0x00.\n- A related trigger the finding does not mention: String.fromCodePoint throws a RangeError on out-of-range entities such as `&#99999999;`. That makes parseFeed itself throw on the same unprotected path.\n\n**Checked and ruled out:** I found no ADR/DECISIONS note or code comment calling this non-atomic, non-catching behavior deliberate.\n\n**Why severity is low:** the only production caller is the DB-mode branch of the episodes endpoint. Both the file header and the inline comment say it is \"currently dormant in production\": no DATABASE_URL is configured, so the no-DB live-parse path serves traffic. The bug is real and would bite as soon as DB mode is turned on, but it has no production impact today. The 400-round-trip performance point is accurate but secondary.",
  "merged_ids": [],
  "lane": "L6-backend-rest"
}
```

## backend-rest-10: An empty <guid></guid> becomes guid "" rather than null, so guid-less episodes collide on (show_id, "") and all but one are lost

**confirmed** · verifier severity **low** (finder: low) · backend-rest · correctness · `backend/src/feeds/parser.ts:252` · L6-backend-rest

```json
{
  "id": "backend-rest-10",
  "area": "backend-rest",
  "category": "correctness",
  "title": "An empty <guid></guid> becomes guid \"\" rather than null, so guid-less episodes collide on (show_id, \"\") and all but one are lost",
  "file": "backend/src/feeds/parser.ts",
  "line": 252,
  "severity": "low",
  "scenario": "Feeds that emit an empty guid element give fast-xml-parser \"\". The parser stores `item.guid.trim()` = \"\" and only warns. ingestShowFeed.episodeIdentity and api's toLiveEpisode both use `ep.guid ?? fallback`, and `??` does not catch \"\", so every such episode gets guid \"\". In DB mode the upsert on primary key (show_id, guid) collapses the whole back catalogue into the last row. In live mode, the (published_at, guid) keyset cursor loses its tiebreaker.",
  "evidence": "parser.ts:251-255 `} else if (typeof item.guid === \"string\") { guid = item.guid.trim(); guidIsPermalink = true; } if (!guid) warnings.push(\"missing guid ...\")`; ingestShowFeed.ts:43 `return ep.guid ?? `noguid:${ep.title}:${ep.publishedAt ?? idx}`;`",
  "fix_sketch": "Normalize in the parser: `guid = item.guid.trim() || null` (and the same for the textOf branch). Also make the identity fallback use `||` rather than `??`, and avoid the positional `idx` (it shifts when a new episode is prepended, which mints duplicate rows on every ingest).",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The finding holds at origin/main. In backend/src/feeds/parser.ts:251-253, a string guid is stored as `guid = item.guid.trim()` and is never turned into null. Line 255 only adds a warning (`if (!guid) warnings.push(...)`), and `guid` itself stays \"\".\n\nI ran the parser's own settings (fast-xml-parser with trimValues:true and parseTagValue:false) on `<guid></guid>`, `<guid>  </guid>` and `<guid/>`. All three came out as `{\"guid\":\"\"}`, so this string path is really taken. A `<guid isPermaLink=\"false\"></guid>` goes the object path instead, and there `textOf` returns null, so that case is fine.\n\nTwo callers fall back with `ep.guid ?? ...`, and `??` does not catch \"\":\n- backend/src/catalog/ingestShowFeed.ts:43\n- api/shows/[show_id]/episodes.ts:193\n\nSo every episode with an empty guid gets guid \"\". This is not deliberate. The comment just above ingestShowFeed.ts:43 says the fallback exists so items avoid \"colliding on an empty string\", which is exactly what goes wrong here.\n\nIn DB mode, PostgresShowEpisodesStore.upsertEpisodes inserts one row per query with `on conflict (show_id, guid) do update`. Each empty-guid episode therefore overwrites the one before, and only the last one written is kept. The in-memory store keys its Map on show_id+guid and collapses the same way. It does not throw, so the loss is silent.\n\nThe fix sketch is right: use `.trim() || null` in the parser, or `||` in both fallbacks. The positional `idx` fallback is also unstable when new episodes are added at the top of the feed. Severity is low because feeds that publish empty guid elements are uncommon, but when one does, most of that show's episodes are lost.",
  "merged_ids": [],
  "lane": "L6-backend-rest"
}
```

## backend-rest-11: decodeEntities looks named entities up on a plain object, so `&constructor;` becomes 'function Object() { [native code] }'

**confirmed** · verifier severity **low** (finder: low) · backend-rest · correctness · `backend/src/feeds/html.ts:45` · L6-backend-rest

```json
{
  "id": "backend-rest-11",
  "area": "backend-rest",
  "category": "correctness",
  "title": "decodeEntities looks named entities up on a plain object, so `&constructor;` becomes 'function Object() { [native code] }'",
  "file": "backend/src/feeds/html.ts",
  "line": 45,
  "severity": "low",
  "scenario": "NAMED_ENTITIES is an object literal, so `NAMED_ENTITIES[\"constructor\"]`, `[\"toString\"]`, `[\"valueOf\"]` and similar resolve through Object.prototype. A feed title or description containing `&constructor;` or `&toString;` has native function source text written into the catalogue text shown to listeners (and into the LLM input).",
  "evidence": "`return NAMED_ENTITIES[entity] ?? match;`. Verified: sanitizeHtmlToText(\"x &constructor; y\") returns \"x function Object() { [native code] } y\".",
  "fix_sketch": "Use `Object.hasOwn(NAMED_ENTITIES, entity) ? NAMED_ENTITIES[entity] : match`, or build the table with `Object.assign(Object.create(null), {...})` or a Map.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read the code at origin/main myself and the finding holds. In backend/src/feeds/html.ts, NAMED_ENTITIES is a plain object literal typed as Record<string,string>, and decodeEntities (line 45) does `return NAMED_ENTITIES[entity] ?? match;`. The regex `[a-zA-Z]+` matches names like constructor, toString and valueOf. Those names resolve through Object.prototype to functions, which are not nullish, so the replace callback turns them into function source text. I ran the same lookup in node: \"x &constructor; y\" becomes \"x function Object() { [native code] } y\", and &toString; becomes \"function toString() { [native code] }\". No comment or guard handles this, and it does not look deliberate. The table is meant as a small allowlist of entities.\n\nWhere it can happen: parser.ts:202 and :242 run feed channel and item titles through this function, sanitizeHtmlToText covers descriptions, and writeAct.ts:527/833 and writeNarration.ts:671-672 run LLM output through it. A feed can trigger it.\n\nWhy severity is low: the input has to contain an odd, non-standard entity. The output is only garbled text, not code execution or markup, because the injected text has no angle brackets and the strip loop runs afterwards anyway. Nothing else in the code handles this case. The fix is to check with Object.hasOwn or to build the table with a null prototype.",
  "merged_ids": [],
  "lane": "L6-backend-rest"
}
```

## backend-rest-12: ingestShowFeed records consecutive_failures but never reads it, so a dead feed is refetched (with a 15 s timeout) on every request

**confirmed** · verifier severity **low** (finder: low) · backend-rest · performance · `backend/src/catalog/ingestShowFeed.ts:82` · L6-backend-rest

```json
{
  "id": "backend-rest-12",
  "area": "backend-rest",
  "category": "performance",
  "title": "ingestShowFeed records consecutive_failures but never reads it, so a dead feed is refetched (with a 15 s timeout) on every request",
  "file": "backend/src/catalog/ingestShowFeed.ts",
  "line": 82,
  "severity": "low",
  "scenario": "freshEnough requires last_fetch_ok === true. After any failure every page view of that show runs fetchFeedConditional again with no backoff, and each request waits up to the 15 s timeout before serving the cached_stale rows. That is slow page loads for listeners and repeated hits on a failing publisher. The PolitenessBudget in feeds/politeness.ts, built for exactly this per-host backoff, is never used outside its tests (neither are resolveRedirectChain, computeIdentityKey, PodcastIndexClient or ItunesClient), so migration 0016's claim of 'ADR-0001's ... per-host politeness discipline' is not implemented on the only live fetch paths.",
  "evidence": "ingestShowFeed.ts:82-86 `const freshEnough = prior?.last_fetched_at !== null && ... && prior.last_fetch_ok === true && now() - ... < ttlMs;`, and consecutive_failures is only written (123-128). `git grep PolitenessBudget origin/main -- ':!*test*'` finds only politeness.ts.",
  "fix_sketch": "When last_fetch_ok is false, treat the cache as fresh for min(ttl, base*2^consecutive_failures) (for example 5 min doubling to 24 h) and serve cached_stale without fetching. Either wire PolitenessBudget in or delete the dead modules and fix the 0016 comment.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read the code at origin/main and the finding holds. In backend/src/catalog/ingestShowFeed.ts, lines 82-86, the cache counts as fresh only when `prior.last_fetch_ok === true`. After a failure, lines 121-128 write `last_fetch_ok: false` and bump `consecutive_failures`. The only place that reads the count back is line 123, which adds one to it. So once a fetch fails, every later request calls fetchFeedConditional again. That function in backend/src/feeds/conditionalGet.ts has a default 15 s timeout (`opts.timeoutMs ?? 15_000`, line 106), and nothing passes a shorter one. After that it serves cached_stale rows.\n\nThe dead-module claim also checks out. Outside tests and docs, PolitenessBudget appears only in its own file, politeness.ts. resolveRedirectChain, computeIdentityKey, PodcastIndexClient and ItunesClient appear only where they are defined. Migration 0016 line 36 says the table \"Mirrors ADR-0001's conditional-GET + per-host politeness discipline\", which the code does not do.\n\nI found no comment in the code and nothing in docs/DECISIONS.md saying the missing backoff is deliberate. The only backoff DECISIONS.md mentions is for the separate classify tooling.\n\nWhy the severity is low:\n(1) The DB path that calls ingestShowFeed is off in production today. api/shows/[show_id]/episodes.ts says so in its header and again next to the call: \"production has no DATABASE_URL configured today ... DB mode ... currently dormant\". Right now no listener can hit this.\n(2) In DB mode the response is sent with `Cache-Control: public, max-age=300, stale-while-revalidate=3600`, including cached_stale responses. That softens repeat hits from the same client or cache, though it does not cover the first request after the cache expires.\n(3) The no-DB path that production actually runs has no backoff either. It refetches live on every request and sets `no-store` after a failure. So the missing politeness is broader than this one file, but that path is not the one the finding names.\n\nThe bug is real and would show up as soon as DATABASE_URL is set. Today its impact is latent.",
  "merged_ids": [],
  "lane": "L6-backend-rest"
}
```

## backend-rest-13: BudgetGuard checks and records in separate awaited steps, so concurrent calls can all pass the cap

**confirmed** · verifier severity **low** (finder: low) · backend-rest · race-condition · `backend/src/cost/budgetGuard.ts:178` · L6-backend-rest

```json
{
  "id": "backend-rest-13",
  "area": "backend-rest",
  "category": "race-condition",
  "title": "BudgetGuard checks and records in separate awaited steps, so concurrent calls can all pass the cap",
  "file": "backend/src/cost/budgetGuard.ts",
  "line": 178,
  "severity": "low",
  "scenario": "checkAndRecord awaits sumUsdSince (and sumUsdBySession) before sink.record. When the pipeline runs narration acts concurrently (narrationConcurrency > 1), N calls interleave at those awaits, all read the same `spent`, all pass `spent + estimate <= cap`, and all record. Spend can pass the daily or per-Foray cap by up to (N-1) call estimates, which weakens the cap that corner case 33 is about.",
  "evidence": "`const spent = await this.sink.sumUsdSince(input.userId, since); if (Number.isFinite(cap) && spent + input.estimatedUsd > cap) throw ...; ... const spentThisEpisode = await this.sink.sumUsdBySession(input.sessionId); ... return this.sink.record(input);`",
  "fix_sketch": "Serialize check-and-record per guard with a promise-chain mutex (`this.lock = this.lock.then(() => doCheckAndRecord())`), or keep an in-process reserved-spend counter that is incremented synchronously before the first await and reconciled after record. For a future Postgres sink, do it in one transaction with `SELECT ... FOR UPDATE` or an advisory lock.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read the code at origin/main and it matches the finding. `BudgetGuard.checkAndRecord` in backend/src/cost/budgetGuard.ts awaits `sink.sumUsdSince`, compares `spent + estimatedUsd > cap`, then optionally awaits `sink.sumUsdBySession`, and only after that awaits `sink.record(input)`. There is no lock and no reservation. The in-memory sink methods in costEvents.ts are `async`, so every await gives other tasks a turn, even though the work is synchronous. If N calls start together, all N read `spent` before any of them has recorded.\n\nThe concurrency is real. In runPipeline.ts (around lines 1470-1510), comment G-32 says every act's narration starts at once through `createActGate(narrationActConcurrency())`. The default is 4, set by the `NARRATION_ACT_CONCURRENCY` env var. The acts share `defaultBudgetGuard` and the same sessionId. Evidence prefetch is a second concurrent fan-out.\n\nIt is not deliberate or handled anywhere I could find. Searching docs/DECISIONS.md and backend/src/cost for race, mutex, concurrency and overshoot turned up nothing that accepts or handles this race. The module's doc comment says the cap should be \"structurally impossible to bypass\". No other code serializes the guard.\n\nSeverity stays low. The overshoot is limited to about (concurrency − 1) × the per-call estimate. That is a few cents to tens of cents at the default of 4, against caps of dollars. The next call after the overshoot still sees the true total and throws, so spend cannot keep running on. For corner case 33 (a runaway overnight queue) the cap still works, just slightly loosely. I did not run a test, since the interleaving follows directly from reading the code.",
  "merged_ids": [],
  "lane": "L6-backend-rest"
}
```

## backend-rest-14: warm-transcript-index's feed fetch has no timeout, no size cap and a cache that never expires

**confirmed** · verifier severity **low** (finder: low) · backend-rest · resource-leak · `backend/src/cli/warmTranscriptIndex.ts:183` · L6-backend-rest

```json
{
  "id": "backend-rest-14",
  "area": "backend-rest",
  "category": "resource-leak",
  "title": "warm-transcript-index's feed fetch has no timeout, no size cap and a cache that never expires",
  "file": "backend/src/cli/warmTranscriptIndex.ts",
  "line": 183,
  "severity": "low",
  "scenario": "loadFeed uses a bare `fetch(feedUrl)` with no AbortController and no byte ceiling, unlike conditionalGet.ts, which has a 15 s timeout and a 20 MB cap for this reason. A publisher that stalls leaves the whole warm hanging indefinitely, and an endless response grows memory on a 16 GB machine this file says is shared with other agents. The cached XML is also reused forever, so episodes published after the first warm never get enclosure URLs or durations, and their rows stay searchable-only (not mintable) until someone deletes the cache file by hand.",
  "evidence": "`const res = await fetch(feedUrl, { headers: { \"user-agent\": DEFAULT_FEED_USER_AGENT } }); if (res.ok) { xml = await res.text(); ... fs.writeFileSync(cacheFile, xml, \"utf8\"); }` and `if (fs.existsSync(cacheFile)) xml = fs.readFileSync(cacheFile, \"utf8\");`",
  "fix_sketch": "Reuse fetchFeedConditional (timeout, byte cap, conditional GET) with the cached file's mtime or ETag. Refetch when the cache is older than N days, or when pending bodies have guids missing from the cached feed.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "At origin/main, loadFeed in backend/src/cli/warmTranscriptIndex.ts (around lines 168-200) matches the finding.\n- It reads the cache first: `if (fs.existsSync(cacheFile)) xml = fs.readFileSync(cacheFile, \"utf8\")`. It only fetches when `!xml`, so a cached feed is reused forever. Nothing checks its age, and there is no refetch path or conditional GET.\n- The fetch is a bare `await fetch(feedUrl, { headers: { \"user-agent\": DEFAULT_FEED_USER_AGENT } })` followed by `await res.text()`. It has no AbortController and no byte cap.\n- backend/src/feeds/conditionalGet.ts has exactly the guard this code is missing: fetchFeedConditional with timeoutMs defaulting to 15_000 and MAX_FEED_BYTES = 20 MB. Its comments say the cap exists because slow-drip or oversized responses can exhaust memory.\n- The file's header comment explains why the feed is fetched and cached (to join rows by guid and make them mintable). It does not say the cache is meant to be permanent, and nothing in DECISIONS.md or a code comment says so either. The same header stresses the 16 GB machine shared with other agents.\n- The stale-cache scenario can happen. Bodies for episodes published after the first warm show up later, their guids are missing from the cached XML, and the rows come out searchable-only until someone deletes the cache file by hand.\n\nTwo things soften it:\n- Node's built-in fetch (undici) has default header and body timeouts of about 300 s, so a fully stalled publisher is aborted after about 5 minutes rather than hanging forever. A slow trickle, or a response that never ends, still has no bound.\n- This is a CLI the founder runs by hand, not a server path. Feed URLs come from the committed catalogue. A failed fetch is caught and costs only that show's enclosure URLs.\n\nSo the finding holds, and the severity is low.",
  "merged_ids": [],
  "lane": "L6-backend-rest"
}
```

## backend-rest-15: sessionBuilder's dedup log names the wrong kept candidate (it can report keptId === droppedId)

**confirmed** · verifier severity **low** (finder: low) · backend-rest · correctness · `backend/src/curation/sessionBuilder.ts:108` · L6-backend-rest

```json
{
  "id": "backend-rest-15",
  "area": "backend-rest",
  "category": "correctness",
  "title": "sessionBuilder's dedup log names the wrong kept candidate (it can report keptId === droppedId)",
  "file": "backend/src/curation/sessionBuilder.ts",
  "line": 108,
  "severity": "low",
  "scenario": "groupDuplicates maps id to root (the smallest id), in candidate order. The loop keeps whichever group member comes first and drops later ones, but logs `keptId: root`. For duplicates arriving as [\"b\",\"a\"] (root \"a\"), it keeps b, drops a, and logs {keptId:\"a\", droppedId:\"a\"}. The build-session console and BuildSessionResult.droppedDuplicates then misreport which candidate survived.",
  "evidence": "`for (const [id, root] of groups.entries()) { if (seenRoots.has(root)) { dropSet.add(id); droppedDuplicates.push({ keptId: root, droppedId: id }); } else { seenRoots.add(root); } }`",
  "fix_sketch": "Track the survivor per root: `const kept = new Map<string,string>(); ... if (kept.has(root)) { drop; push({ keptId: kept.get(root)!, droppedId: id }) } else kept.set(root, id);`. Or deliberately keep the root member and drop the others.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read the code at origin/main and the finding holds. In backend/src/identity/dedup.ts, groupDuplicates fills `groups` by walking the candidates in order, so the Map's order is candidate order. The root of each group is the smallest id (union() makes the smaller id the parent). It then removes singleton groups but does not reorder anything. In backend/src/curation/sessionBuilder.ts (lines 105-114), the loop keeps the first member of each root it meets and drops the later ones, but it always pushes `{ keptId: root, droppedId: id }`. Take candidates [\"b\",\"a\"] that match: groups is b->a, a->a. b is seen first, so root \"a\" is added to seenRoots and b is kept. Then a gets dropped and the log says {keptId:\"a\", droppedId:\"a\"}. More generally, whenever the smallest id in a group does not come first in candidate order, the log names the wrong survivor. Nothing handles this elsewhere. I found no comment or DECISIONS entry saying it is deliberate. The code comment only says the root is the smallest id \"for determinism\". The effect is limited to reporting. droppedDuplicates is only used in backend/src/cli/buildSession.ts:150-151, where it is printed to the console. Which candidate is actually kept is decided correctly by dropSet, and the menu still never shows two members of the same group. So this is a real but low-severity bug in the diagnostic output.",
  "merged_ids": [],
  "lane": "L6-backend-rest"
}
```

## backend-rest-16: An unparseable release date is scored as 1970 (freshness 0) instead of the neutral 0.5 computeFreshness provides

**confirmed** · verifier severity **low** (finder: low) · backend-rest · correctness · `backend/src/curation/sessionBuilder.ts:149` · L6-backend-rest

```json
{
  "id": "backend-rest-16",
  "area": "backend-rest",
  "category": "correctness",
  "title": "An unparseable release date is scored as 1970 (freshness 0) instead of the neutral 0.5 computeFreshness provides",
  "file": "backend/src/curation/sessionBuilder.ts",
  "line": 149,
  "severity": "low",
  "scenario": "computeFreshness returns a neutral 0.5 for an invalid date. sessionBuilder replaces an invalid releaseDate with `new Date(0).toISOString()`, so the candidate is scored as 56 years old: freshness 0, about 0.1 total penalty at the default weights. Candidates whose research-doc date is free text ('circa 2019', 'unknown') silently lose slots.",
  "evidence": "`publishedAtIso: toIsoDateOrNull(c.releaseDate) ?? new Date(0).toISOString(),` vs scoring.ts:57 `if (Number.isNaN(published.getTime())) return 0.5; // unknown date — neutral`",
  "fix_sketch": "Pass the raw string (or \"\") through so computeFreshness's NaN branch runs, for example `publishedAtIso: toIsoDateOrNull(c.releaseDate) ?? \"\"`.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The finding holds on origin/main. sessionBuilder.ts:149 passes `toIsoDateOrNull(c.releaseDate) ?? new Date(0).toISOString()` to the scorer. toIsoDateOrNull (line 269) returns null for any string that `new Date()` cannot parse, so an unparseable date becomes 1970-01-01. computeFreshness (scoring.ts) has an explicit neutral branch, `if (Number.isNaN(published.getTime())) return 0.5; // unknown date — neutral`, but the epoch fallback means that branch never runs. The date instead scores as about 56 years old, which clamps freshness to 0 for both evergreen (10-year half-life) and timely content.\n\nThe scenario can happen. candidateExtractor's zod schema declares `release_date: z.string()` with no format check, and the value goes straight through to releaseDate, so free-text dates like \"unknown\" or \"circa 2019\" reach this code. The `// YYYY-MM-DD` note on the type is only a comment.\n\nI found nothing that makes this deliberate. There is no comment explaining the epoch fallback, and docs/DECISIONS.md says nothing about it. The dedup call at line 101 correctly keeps null, which suggests the scoring fallback was just a quick way to satisfy the string type.\n\nSeverity is low. Research docs normally carry real dates. The penalty is only the freshness weight times 0.5. Also, DECISIONS.md (around line 927) says the live client does not use server-side sessionBuilder scoring yet, so the effect is limited to the buildSession CLI output.\n\nThe proposed fix works: passing \"\" or the raw string makes `new Date(\"\")` invalid, so the NaN branch returns 0.5. I did not run a test, because reading the code was enough to settle it.",
  "merged_ids": [],
  "lane": "L6-backend-rest"
}
```

## backend-rest-17: The card-ignored penalty fires again on every card_shown after the 5th, and the streak is recomputed in O(n^2)

**confirmed** · verifier severity **low** (finder: low) · backend-rest · correctness · `backend/src/curation/interestLearning.ts:177` · L6-backend-rest

```json
{
  "id": "backend-rest-17",
  "area": "backend-rest",
  "category": "correctness",
  "title": "The card-ignored penalty fires again on every card_shown after the 5th, and the streak is recomputed in O(n^2)",
  "file": "backend/src/curation/interestLearning.ts",
  "line": 177,
  "severity": "low",
  "scenario": "computeCardIgnoredStreak counts every earlier overlapping card_shown back to the last pick and never resets after the penalty fires. The 5th, 6th, 7th and every later showing each apply -0.01, so a card shown 25 times is penalised 21 times rather than the spec's 'x5 -> gentle -'. applyEventBatch also calls events.slice(0, i) and walks it backwards for every card_shown, which is O(n^2) copying per 1000-event batch.",
  "evidence": "interestLearning.ts:177 `if ((ctx.ignoredCardShownCount ?? 0) < IGNORED_CARD_SHOWN_THRESHOLD) return [];` and :330 `computeCardIgnoredStreak(events.slice(0, i), event)`.",
  "fix_sketch": "Fire only when `streak % IGNORED_CARD_SHOWN_THRESHOLD === 0`, or reset the streak after a penalty. Keep a running per-topic streak map while iterating the batch instead of slicing and rescanning.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The finding holds against the code at origin/main. In backend/src/curation/interestLearning.ts:177 the check is `if ((ctx.ignoredCardShownCount ?? 0) < IGNORED_CARD_SHOWN_THRESHOLD) return [];`, so the penalty applies whenever the streak is 5 or more. computeCardIgnoredStreak (lines 202-217) walks back through the history and counts every earlier card_shown for the same user whose topics overlap. It stops only at an overlapping `picked` event and never resets after a penalty. The 6th, 7th and later showings therefore each apply another -0.01, durable. The count is also not strictly consecutive, because events that don't overlap are skipped with `continue`. applyEventBatch at line 330 calls `computeCardIgnoredStreak(events.slice(0, i), event)` for every card_shown, which is quadratic.\n\nNothing I found makes this deliberate. docs/curation/personalization-and-depth-plan.md:103 says \"Card shown, never picked x5 -> gentle - on that framing/topic\". The only batch test (backend/test/interestLearning.test.ts:295-308) has the comment \"only the 5th card_shown (streak == threshold) should produce a signal\", so the intent was equality. The test uses exactly 5 events and never checks a 6th. The only documented simplification is the batch-window limit on how far back the streak looks, not repeated firing.\n\nImpact is small, and that is why I kept severity low:\n(1) runLearningJobForUser (learningJob.ts) passes at most 1000 events per batch, and the streak does not carry across batches. That caps the repeated penalty within each window, and the O(n^2) cost is about 500k cheap comparisons, which is negligible.\n(2) Each extra hit is only -0.01.\n(3) Outside backend types and migrations, nothing in the non-doc tree seems to emit card_shown events, so the path looks latent in production for now.\n\nSuggested fix: fire only when `streak === IGNORED_CARD_SHOWN_THRESHOLD` (or when `streak % threshold === 0`). Optionally keep a running per-topic streak map instead of slicing the batch for each event.",
  "merged_ids": [],
  "lane": "L6-backend-rest"
}
```

## backend-rest-18: The INTERNAL_VOCABULARY 'Act N' rule only matches lower-case number words, so 'Act Two' passes the title/summary gate

**confirmed** · verifier severity **low** (finder: low) · backend-rest · correctness · `backend/src/copy/rules.js:105` · L6-backend-rest

```json
{
  "id": "backend-rest-18",
  "area": "backend-rest",
  "category": "correctness",
  "title": "The INTERNAL_VOCABULARY 'Act N' rule only matches lower-case number words, so 'Act Two' passes the title/summary gate",
  "file": "backend/src/copy/rules.js",
  "line": 105,
  "severity": "low",
  "scenario": "ACT_NUMBER is built from lower-case COUNT_WORDS, and the rule has no `i` flag. COUNT and POINTER use firstLetterEitherCase, but ACT_NUMBER does not. A Foray title or summary like 'In Act Two, the reactor fails' is not flagged by check-forays, and toListenerWords does not rewrite it. The narration side (narratorStructure.js numbered-piece, flag gi) does catch it, so the two gates disagree.",
  "evidence": "`const ACT_NUMBER = `(?:${COUNT_WORDS.slice(0, 10).join(\"|\")}|\\\\d{1,2})`;` and `new RegExp(`\\\\b[Aa]ct ${ACT_NUMBER}\\\\b`)`. Verified: INTERNAL_VOCABULARY.some(re => re.test(\"In Act Two, the story turns\")) === false, while \"In act two\" === true.",
  "fix_sketch": "Build ACT_NUMBER with `COUNT_WORDS.slice(0, 10).map(firstLetterEitherCase)`, matching COUNT, and add 'Act Two' / 'Act Three' cases to copyRules.test.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The finding holds at origin/main. In backend/src/copy/rules.js, ACT_NUMBER is built as `(?:${COUNT_WORDS.slice(0, 10).join(\"|\")}|\\\\d{1,2})`, using lower-case words only. The regex `\\b[Aa]ct ${ACT_NUMBER}\\b` has no `i` flag. COUNT and POINTER both go through firstLetterEitherCase, but ACT_NUMBER does not. The same ACT_NUMBER is reused in toListenerWords.\n\nI extracted the file and ran it in node:\n- \"In Act Two, the reactor fails\": no INTERNAL_VOCABULARY pattern matches, and toListenerWords returns changed:false.\n- \"In Act two\": matches, and is rewritten to \"In Part two\".\n- \"Act 2\": matches.\n\nNothing marks this as deliberate. The comment only says lower-case `act` is kept in the count and pointer shapes, to leave room for legislation such as \"two Acts\" and \"this Act\". The numbered-act shape already accepts [Aa], and its documented aim is to catch \"Act one\" / \"act 2\". Excluding \"Act Two\" matches neither of those aims and looks like an oversight. The only carve-out for legislation is the two-digit limit on years (the \"Clean Air Act 1956\" case).\n\n\"Act One\" / \"Act Two\" is also the natural capitalised form: the backend's own act titles in smoothSeam.test.ts and stitchForay.test.ts use it.\n\nSeverity is low. Summaries are free text and could leak it. For titles, the house-style rule asks for sentence case, which makes \"act two\" more likely there, although capitalised \"Act Two\" is still a plausible way to write it. The narration gate reportedly catches it, so only the title/summary copy gate is affected.",
  "merged_ids": [],
  "lane": "L6-backend-rest"
}
```

## backend-rest-19: publish-foray leaves the checkout stranded on the publish branch if commit, push or `gh pr create` fails

**confirmed** · verifier severity **low** (finder: low) · backend-rest · error-handling · `backend/src/cli/publishForay.ts:848` · L6-backend-rest

```json
{
  "id": "backend-rest-19",
  "area": "backend-rest",
  "category": "error-handling",
  "title": "publish-foray leaves the checkout stranded on the publish branch if commit, push or `gh pr create` fails",
  "file": "backend/src/cli/publishForay.ts",
  "line": 848,
  "severity": "low",
  "scenario": "Cleanup (restore files, switch back, delete the branch) covers the write and the suites gate but nothing after it. If commitPublish refuses (F-75 check), `git push` fails (auth, network) or `gh pr create` fails, the error propagates out of main(). The checkout is left on `generate/<id>` with a local commit, or with staged files. The next `publish-foray` for the same id then dies at `git switch -c` because the branch already exists, and assertDataFilesMatchMain may refuse because data/ now differs.",
  "evidence": "lines 848-860: `commitPublish(run, write.files, ...); run(\"git\", [\"push\", \"-u\", \"origin\", \"HEAD\"]); const prUrl = run(\"gh\", [\"pr\", \"create\", ...]);` with no try/finally, unlike the write step at 820-826.",
  "fix_sketch": "Wrap commit, push and PR creation in try/catch. On failure before a successful push: `git reset --hard origin/main` on the branch, then abandonPublishBranch(run, branch, previousRef). After a successful push, print the branch name and a resume command instead of deleting it.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main:backend/src/cli/publishForay.ts myself, and the finding holds. The write step (about lines 818-826) is wrapped in try/catch: it runs restoreDataFiles plus abandonPublishBranch and then rethrows. gateWrittenTree cleans up when the suites refuse (lines 554 and 560). After that, step 3b runs `commitPublish(...)`, `run(\"git\", [\"push\", \"-u\", \"origin\", \"HEAD\"])` and `run(\"gh\", [\"pr\",\"create\",...])` with no try/finally, so any throw goes straight up to `main().catch`, which only logs and sets exitCode=1.\n\nWhat each failure leaves behind:\n- A pre-commit hook or the commit itself fails: the checkout is on generate/<id> with the files staged.\n- One of commitPublish's F-75 checks fails, or push fails (auth, network): there is also a local commit.\n- `gh pr create` fails: the branch is already pushed.\n\nNothing switches back or deletes the branch in any of these cases. There is also no comment and no entry in DECISIONS.md saying this is intended. The abandonPublishBranch doc says it is for \"the never-pushed publish branch\" after a refusal, and nothing covers these later failures.\n\nCorrection to the re-run scenario: the second run fails first at step 0, assertDataFilesMatchMain (line 730, before cutPublishBranch). HEAD's data/ now differs from origin/main, so it throws the F-75 message. That message points to a manual `git checkout origin/main -- ...` fix, which does not clean up the stale branch. Even with data/ restored by hand, `git switch -c generate/<id>` would still fail because the branch exists. So the checkout really is stuck.\n\nSeverity is low. Push and gh failures are plausible (network or auth), and the F-75 check failing right after a clean cut from origin/main is unlikely. It is an operator CLI, nothing is lost, and the error message is printed, so recovery is a few manual git commands. After a successful push, leaving the branch in place is arguably the right behaviour, as the fix sketch notes.",
  "merged_ids": [],
  "lane": "L6-backend-rest"
}
```

## backend-rest-20: The real-data suites gate spawns `node --test` with no timeout, so one hung suite hangs publish-foray forever

**confirmed** · verifier severity **low** (finder: low) · backend-rest · resource-leak · `backend/src/cli/publishSuites.ts:165` · L6-backend-rest

```json
{
  "id": "backend-rest-20",
  "area": "backend-rest",
  "category": "resource-leak",
  "title": "The real-data suites gate spawns `node --test` with no timeout, so one hung suite hangs publish-foray forever",
  "file": "backend/src/cli/publishSuites.ts",
  "line": 165,
  "severity": "low",
  "scenario": "spawnSync is called without a `timeout`. A suite that leaves a handle open or waits on a never-resolving promise (the gate runs ~16 real-data suites with DOM shims) blocks the publish CLI indefinitely, with the three data files still written into the working tree on the publish branch. That is the half-written state gateWrittenTree exists to prevent.",
  "evidence": "`const r = spawnSync(cmd, [...args], { cwd: opts.cwd, encoding: \"utf8\", env: process.env, maxBuffer: 64 * 1024 * 1024 });`",
  "fix_sketch": "Add `timeout: 10 * 60_000, killSignal: \"SIGKILL\"` and pass `--test-timeout=120000` to node --test. r.error (ETIMEDOUT) is already turned into a '(runner)' failure, so the existing restore path runs.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "At origin/main, backend/src/cli/publishSuites.ts defaultSpawn (around line 165) calls spawnSync(cmd, args, { cwd, encoding: \"utf8\", env: process.env, maxBuffer: 64MB }) with no `timeout` or `killSignal`. runRealDataSuites spawns `node --test --test-reporter=tap <REAL_DATA_SUITES>` without `--test-timeout`, and node's default per-test timeout is Infinity. So a suite that never settles, or a test file whose child process keeps a handle open, blocks the synchronous spawn with no limit. I found no mitigation anywhere else. publishForay.ts has no SIGINT or process.on handler; its only `finally` is on the --dry-run path (line 795), and that one cannot run while spawnSync is blocking. When the operator hits Ctrl-C, restoreDataFiles never runs, so the three written data files stay in the working tree on the publish branch. Nothing in docs/DECISIONS.md or the code comments says the missing timeout is deliberate. The suggested fix is sound: with a spawnSync timeout, r.error (ETIMEDOUT) is already turned into a '(runner)' failure, ok becomes false, and the existing restore path runs. I kept severity low because the scenario is speculative. The same suites run in CI, so a hanging suite would normally show up there first. The CLI is also run by an operator who is watching it, so a hang is noticed and the damage is a dirty tree that can be recovered, not bad data being published.",
  "merged_ids": [],
  "lane": "L6-backend-rest"
}
```

## backend-rest-21: build-session crashes whenever DATABASE_URL is set, which is the same .env that migrate and learn-interests require

**deliberate** · verifier severity **low** (finder: low) · backend-rest · tooling · `backend/src/curation/createUserInterestsProvider.ts:21`

```json
{
  "id": "backend-rest-21",
  "area": "backend-rest",
  "category": "tooling",
  "title": "build-session crashes whenever DATABASE_URL is set, which is the same .env that migrate and learn-interests require",
  "file": "backend/src/curation/createUserInterestsProvider.ts",
  "line": 21,
  "severity": "low",
  "scenario": "env.ts loads the repo-root .env. Once a developer sets DATABASE_URL to run `npm run migrate` or `npm run learn-interests`, `npm run build-session` throws at createUserInterestsProvider() ('PostgresUserInterestsProvider does not exist yet') before building anything. The header calls this branch 'intentionally unreachable in practice today', but the two other CLIs make it reachable.",
  "evidence": "`if (env.databaseUrl === undefined) { return new InMemoryUserInterestsProvider(); } throw new Error(\"createUserInterestsProvider: DATABASE_URL is set but PostgresUserInterestsProvider does not exist yet ...\")`; buildSession.ts:127 calls it unconditionally.",
  "fix_sketch": "Until the Postgres provider exists, fall back to InMemoryUserInterestsProvider with a console warning (or gate it on an explicit USER_INTERESTS_PROVIDER=postgres flag) instead of throwing.",
  "duplicates": [],
  "verdict": "deliberate",
  "verdict_severity": "low",
  "verdict_reasoning": "The mechanics check out at origin/main. backend/src/config/env.ts loads the repo-root .env, then backend/.env with override. It sets databaseUrl from DATABASE_URL. `npm run migrate` (migrate.ts:26) and `npm run learn-interests` (learnInterests.ts:61) each do a dry run only when DATABASE_URL is unset, and they tell the user to put it in the repo-root .env to do real work. buildSession.ts calls createUserInterestsProvider() unconditionally, and that function throws whenever databaseUrl is defined. So once a developer sets DATABASE_URL for migrate or learn-interests, build-session fails before it builds anything. The header comment's claim that this branch is 'intentionally unreachable in practice today' is inaccurate.\n\nThe throw itself is deliberate and documented, though, and the suggested fix would undo it:\n- docs/DECISIONS.md:884 says the Postgres provider is 'designed ... env-gated on DATABASE_URL, but deliberately not built yet'.\n- DECISIONS.md:923 treats wiring it as an infra and secrets change that needs Wyatt's sign-off.\n- docs/curation/interest-survey-plan.md (around lines 277-284 and 806-812) calls the throw 'a genuine tripwire' and says 'The flip is loud, not silent'. It is cited as a privacy and store-submission safeguard against silently personalizing from a live database. The fix sketch proposes falling back silently to InMemory with a warning, which would remove that tripwire.\n- The error message already tells the user what to do: unset DATABASE_URL or implement the provider.\n- build-session is a manual dev CLI that no CI or cron runs, so the only effect is developer friction.\n\nWhat is left is a stale code comment ('unreachable in practice'), plus a possible improvement: use an explicit opt-in flag rather than DATABASE_URL, so the three CLIs stop colliding. The fail-loud behavior itself is intentional.",
  "merged_ids": [],
  "lane": null
}
```

## backend-rest-22: normalizeTitle removes every non-ASCII letter, so non-Latin titles never dedup and all collide on one identity key

**confirmed** · verifier severity **low** (finder: low) · backend-rest · correctness · `backend/src/identity/dedup.ts:26` · L6-backend-rest

```json
{
  "id": "backend-rest-22",
  "area": "backend-rest",
  "category": "correctness",
  "title": "normalizeTitle removes every non-ASCII letter, so non-Latin titles never dedup and all collide on one identity key",
  "file": "backend/src/identity/dedup.ts",
  "line": 26,
  "severity": "low",
  "scenario": "After NFKD and diacritic stripping, `.replace(/[^a-z0-9]+/g, \" \")` deletes CJK, Cyrillic, Greek, Arabic and similar letters. A title like '伊藤洋一のRound Up World Now' keeps only 'round up world now', and a fully non-Latin title becomes \"\". isSameEpisode then returns false for every such pair, so audio/video twins are never merged. computeIdentityKey gives '::<date>' for all of them, so the key idx_episodes_identity is built on collides across unrelated episodes. The catalogue has non-Latin shows (searchBreadthShows' own header cites one).",
  "evidence": "`.normalize(\"NFKD\").replace(/[̀-ͯ]/g, \"\").replace(/[^a-z0-9]+/g, \" \")` and `if (normalizeTitle(a.title).length === 0) return false;`",
  "fix_sketch": "Use Unicode classes, as anchorText.ts and searchBreadthShows.ts already do: `.replace(/[^\\p{L}\\p{N}]+/gu, \" \")` after lowercasing and stripping combining marks (`/\\p{M}/gu`).",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read backend/src/identity/dedup.ts at origin/main and the code does what the finding says. normalizeTitle (lines 18-29) lowercases, applies NFKD, strips U+0300-036F, and then runs `.replace(/[^a-z0-9]+/g, \" \")`, which deletes every CJK, Cyrillic, Greek or Arabic letter. A fully non-Latin title therefore becomes \"\". isSameEpisode line 74 (`if (normalizeTitle(a.title).length === 0) return false;`) means such a pair never matches. Neither docs/DECISIONS.md nor any code comment calls this deliberate. The comment says only \"strip punctuation\", and the tests cover ASCII and Latin diacritics (\"Café\").\n\nParts of the scenario need correcting:\n(1) The identity-key collision is latent today. computeIdentityKey has no caller in backend/src; git grep finds it only in dedup.ts and the tests. No backend/src code inserts into episodes or writes identity_key, so idx_episodes_identity has nothing colliding in it yet. It becomes a real problem only once an ingest path uses computeIdentityKey.\n(2) The only live consumer is the dedup safety net in sessionBuilder.ts (lines 96-116, groupDuplicates over the session candidates). A missed match there fails safe: a duplicate audio/video twin can appear in the menu, and nothing is lost.\n(3) Mixed titles bring a small risk of wrong merges. A title that keeps only its Latin or number tokens (for example the '...Round Up World Now' case, or '第5回' becoming '5') can match an unrelated episode. That also needs a published date within 1 day and a duration within 90s, so it is rare.\n\nThe core defect holds, is not intentional, and is not handled anywhere else. The impact today is limited to a menu-level dedup miss, so the severity stays low. The suggested Unicode-class fix is sound. I did not run a test, since reading the code was enough.",
  "merged_ids": [],
  "lane": "L6-backend-rest"
}
```

## ci-release-2: The path policy ignores renames (previous_filename), so moving a governed file to an allowlisted path auto-merges unread and passes path-policy

**confirmed** · verifier severity **high** (finder: high) · ci-release · security · `.github/workflows/automerge-nightly.yml:170` · L7-ci-release-security

```json
{
  "id": "ci-release-2",
  "area": "ci-release",
  "category": "security",
  "title": "The path policy ignores renames (previous_filename), so moving a governed file to an allowlisted path auto-merges unread and passes path-policy",
  "file": ".github/workflows/automerge-nightly.yml",
  "line": 170,
  "severity": "high",
  "scenario": "A bot PR runs `git mv CLAUDE.md docs/CLAUDE-old.md`, or moves docs/DECISIONS.md, docs/adr/*, tools/release/watch-release.mjs or tools/ci/path-policy.mjs somewhere under docs/ or tools/, optionally editing the contents too. The PR files API reports the entry as `filename: docs/CLAUDE-old.md, status: renamed, previous_filename: CLAUDE.md`. Every gatherer reads only `.filename`, so the policy sees one allowlisted path. The decision is ARMED, the path-policy check is CLEAN, `changed_files` still matches (1 == 1), and the governed file is deleted from main with no human involved. That defeats the core invariant that denied paths never land unread. The pr-hygiene sweep path has the same blind spot.",
  "evidence": "automerge-nightly.yml:170 `gh api --paginate \"repos/$REPO/pulls/$PR/files\" --jq '.[].filename' > changed-files.txt`. path-policy.yml:150 is the same. pr-hygiene.yml:161 `--jq '[.[].filename]'`. pr-triage.mjs:634 gatherPrs `--jq \"[.[].filename]\"`. pathPolicy() only ever sees the destination path.",
  "fix_sketch": "Emit both sides of a rename: `--jq '.[] | .filename, (.previous_filename // empty)'`, and the same in pr-hygiene and gatherPrs. Change the truncation check to compare the count of `.filename` entries (not total lines) with `changed_files`. Add path-policy tests where a rename out of CLAUDE.md or tools/ci/ yields DENIED_PATH / UNAPPROVED.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "high",
  "verdict_reasoning": "I read the code at origin/main and the finding holds. automerge-nightly.yml:170 and path-policy.yml:150 both build changed-files.txt with `gh api --paginate repos/$REPO/pulls/$PR/files --jq '.[].filename'`, and pr-hygiene.yml:161 uses `--jq '[.[].filename]'`. `git grep previous_filename` finds nothing anywhere at origin/main, so no gatherer reads the source side of a rename.\n\nFor a rename that git detects (similarity of 50% or more, so a pure `git mv` or a light edit), the GitHub PR files API returns one entry with the new path in `filename` and the old path only in `previous_filename`. `changed_files` also counts it as one file, so the truncation check (1 == 1) passes.\n\nIn tools/ci/path-policy.mjs, DENIED_PREFIXES includes CLAUDE.md, docs/DECISIONS.md, docs/adr/, docs/roles.md, tools/ci/ and tools/release/. ALLOWED_PREFIXES includes docs/ and tools/. So `git mv CLAUDE.md docs/CLAUDE-old.md` or `git mv docs/DECISIONS.md docs/archive/DECISIONS.md` shows the policy only an allowlisted destination. The decision is ARMED and the file leaves its governed path unread. That breaks the invariant that denied paths never land unread.\n\nNothing I found handles this elsewhere. There is no CODEOWNERS file at origin/main, no comment in the workflow, the policy module or docs/DECISIONS.md that accepts rename-blindness, and no test that covers renames.\n\nTwo limits apply. First, a rewrite heavy enough that git reports removed+added would list the old path and be denied. Second, renaming the policy module itself would probably fail other CI, because the policy runs from the default branch and ci.yml calls tools by name. Neither limit protects CLAUDE.md, DECISIONS.md, docs/adr/ or roles.md, which have no such backstop.\n\nSeverity is high because this bypasses the governance gate with no human in the loop. It does need a misbehaving or adversarial bot PR to trigger it. The fix sketch is sound: emit `.previous_filename // empty` as well, and count only `.filename` entries against `changed_files`.",
  "merged_ids": [],
  "lane": "L7-ci-release-security"
}
```

## ci-release-3: The release-signing secrets are repository-scoped, so the release guard is not a boundary: a tag or branch push runs its own guard code with access to the dist cert, the App Store Connect key and the Play key

**confirmed** · verifier severity **medium** (finder: medium) · ci-release · security · `.github/workflows/release.yml:133` · L7-ci-release-security

```json
{
  "id": "ci-release-3",
  "area": "ci-release",
  "category": "security",
  "title": "The release-signing secrets are repository-scoped, so the release guard is not a boundary: a tag or branch push runs its own guard code with access to the dist cert, the App Store Connect key and the Play key",
  "file": ".github/workflows/release.yml",
  "line": 133,
  "severity": "medium",
  "scenario": "`gh secret list` shows IOS_DIST_CERT_P12_BASE64, APP_STORE_CONNECT_PRIVATE_KEY_BASE64, ANDROID_KEYSTORE_B64 and PLAY_SERVICE_ACCOUNT_JSON as repo secrets. The only environments are github-pages, Preview and Production, and there is no `release` environment. No tag ruleset exists. For a `push: tags: v*` event, both release.yml and tools/mobile/release-ci.mjs come from the TAG's commit, so a `v9.9.9` tag on a commit that edits either one passes its own guard. Any branch push can also carry an `on: push` workflow that reads these secrets directly. path-policy.mjs denies tools/mobile/release-ci.mjs on the grounds that the guard is 'the only thing standing between an arbitrary dispatched ref/tag and a job that receives live IOS_DIST_CERT_P12_BASE64'. That premise does not hold while the secrets are repository-scoped.",
  "evidence": "release.yml:133-139 `run: node tools/mobile/release-ci.mjs release-guard \"$EVENT_NAME\" \"$REF\"` runs after `actions/checkout@v4` of the triggering ref. The ios and android jobs pass `${{ secrets.IOS_DIST_CERT_P12_BASE64 }}` etc. with no `environment:`. The protect-main ruleset is the only ruleset.",
  "fix_sketch": "Create a `release` environment whose deployment-branch policy allows only `main` and `v*` tags, and move the 8 signing/upload secrets into it. Add `environment: release` to release.yml's ios and android jobs. Add a tag ruleset restricting who can create `v*`. android-release.yml's documented same-repo pull_request key exposure then goes away too, because it can no longer see the Android secrets without the environment.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I checked this against origin/main and the live repo settings, and the finding holds.\n\n1. **The secrets are repository-scoped.** `gh secret list` shows all 11 signing and upload secrets as repo secrets, including IOS_DIST_CERT_P12_BASE64, APP_STORE_CONNECT_PRIVATE_KEY_BASE64, ANDROID_KEYSTORE_B64 and PLAY_SERVICE_ACCOUNT_JSON. The only environments are github-pages, Preview and Production. Preview and Production have no protection rules or branch policy, and there is no `release` environment.\n\n2. **The only ruleset is protect-main.** It targets the default branch only (pull_request, non_fast_forward, deletion, required_status_checks). There is no tag ruleset, so anyone with push access can create a `v*` tag on any commit.\n\n3. **The release jobs have no environment.** In release.yml, the `ios` and `android` jobs (lines 185-249) pass the signing secrets without any `environment:` key. The guard at lines 133-139 runs `node tools/mobile/release-ci.mjs` from the checkout of the triggering ref. On a tag push, both the workflow file and the guard script come from the tag's commit, so a tag on a commit that edits either one passes its own guard.\n\n4. **Branch pushes can reach the secrets too.** Any pusher can add an `on: push` workflow on a side branch that reads the repo secrets directly. android-release.yml itself documents that same-repo `pull_request` runs receive secrets (around lines 81-102).\n\n5. **The path-policy premise does not hold.** path-policy.mjs:134-153 denies release-ci.mjs because the guard is \"the only thing standing between an arbitrary dispatched ref/tag and a job that receives live IOS_DIST_CERT_P12_BASE64\". That is false while the secrets are repository-scoped. Denying the file only stops a neutered guard from merging to main; it does not stop the tag or side-branch paths. I found nothing in DECISIONS.md that accepts repo-scoped secrets as a deliberate choice.\n\n**Why medium, not high.** Exploiting this needs push access. The repo is public, but the only collaborators are 2 admins. Fork PRs don't receive secrets. The real risk is bot or agent sessions that push with founder credentials. That is exactly the threat the path-policy denial was meant to address, and this bypasses it. The repo's default workflow token permission is also `write`.\n\nI did not run a test; this was verified by reading the workflows at origin/main and the live settings through `gh`. The fix sketch holds: a `release` environment restricted to main and `v*` tags holding the secrets, `environment: release` on the ios and android jobs, and a tag ruleset for `v*`.",
  "merged_ids": [],
  "lane": "L7-ci-release-security"
}
```

## ci-release-5: `mobile/` is allowlisted wholesale, including the signing Gradle include, plugin build scripts and package manifests, which run inside the steps that hold the keystore password and the ASC key

**confirmed** · verifier severity **medium** (finder: medium) · ci-release · security · `tools/ci/path-policy.mjs:287` · L7-ci-release-security

```json
{
  "id": "ci-release-5",
  "area": "ci-release",
  "category": "security",
  "title": "`mobile/` is allowlisted wholesale, including the signing Gradle include, plugin build scripts and package manifests, which run inside the steps that hold the keystore password and the ASC key",
  "file": "tools/ci/path-policy.mjs",
  "line": 287,
  "severity": "medium",
  "scenario": "DENIED_PREFIXES denies tools/mobile/wire-signing.mjs because the next build step 'receives FORAY_KEYSTORE_PASSWORD'. But mobile/gradle/** (the actual signing include that Gradle evaluates), mobile/plugins/*/android/build.gradle, mobile/plugins/*/Package.swift and mobile/package.json / package-lock.json (which decide which npm code and lifecycle scripts run) all fall under ALLOWED 'mobile/'. In release.yml's android-bundle action, `./gradlew bundleRelease` runs with FORAY_KEYSTORE_PASSWORD in env and the decoded .p12 on disk. In ios-archive, `xcodebuild archive` runs plugin build phases with APP_STORE_CONNECT_PRIVATE_KEY_BASE64 and the cert password in env. So an agent PR editing those files auto-merges unread, and the next scheduled release-trigger dispatch executes it with the signing credentials. That is the exact exposure the tools/mobile entries were denied for.",
  "evidence": "ALLOWED_PREFIXES: `\"mobile/\",` (founder ruling 2026-09-05, about app code). DENIED entry: `\"tools/mobile/wire-signing.mjs\"` with the comment 'The build step right after it receives FORAY_KEYSTORE_PASSWORD'. android-bundle/action.yml:168-191 runs gradle with `FORAY_KEYSTORE_PASSWORD: ${{ inputs.android_keystore_password }}`.",
  "fix_sketch": "Keep mobile/ app code auto-mergeable, which respects the founder ruling, but add narrow DENIED entries: `mobile/gradle/`, `mobile/package.json`, `mobile/package-lock.json`, and the plugin build manifests (`mobile/plugins/` build.gradle / Package.swift, or deny `mobile/plugins/*/android/` and `*/Package.swift` via explicit files). Extend path-policy.test.mjs's gate-script scan to cover files evaluated by gradle/xcodebuild in secret-holding steps.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main myself and the finding holds. In tools/ci/path-policy.mjs, ALLOWED_PREFIXES includes \"mobile/\" (line 287, founder ruling 2026-09-05). DENIED_PREFIXES has no mobile/ entries. It only denies tools/mobile/wire-signing.mjs, inject-app-icon, inject-splash, release-ci, fetch-models, inject-models and tools/release/. So the following all auto-merge when green: mobile/gradle/foray-signing.gradle, mobile/package.json, mobile/package-lock.json, mobile/plugins/{foray-audio,foray-tts,foray-vault}/android/build.gradle, Package.swift and package.json.\n\n- **Android:** in .github/actions/android-bundle/action.yml, the \"bundleRelease\" step has FORAY_KEYSTORE_PASSWORD, FORAY_KEY_ALIAS and FORAY_KEYSTORE_PATH in env, with the decoded upload.p12 on disk. It runs `./gradlew foraySigningStatus` and `./gradlew bundleRelease`. Those evaluate mobile/gradle/foray-signing.gradle (it reads the secrets via System.getenv, per android-release.yml:321) and the plugin build.gradle files. Arbitrary Groovy in those files runs with the password in reach. The step's check that greps the log for the password does not stop exfiltration over the network.\n- **iOS:** ios-archive runs `npm install` in mobile/, so mobile/package.json and the lockfile decide which lifecycle scripts run. It then runs `npm run add:ios`, which is also defined by the allowlisted mobile/package.json. Later, `xcodebuild archive` runs with APP_STORE_CONNECT_PRIVATE_KEY_BASE64, IOS_DIST_CERT_PASSWORD and the P12 in env. That means allowlisted files shape the project that gets built with the signing secrets. The Package.swift manifests themselves run in SwiftPM's sandbox, so they are a weaker path. The gradle and npm-script paths are the concrete ones.\n- **Trigger:** release-trigger.yml dispatches release.yml on a cron (`47 */2 * * *`), with no human in between.\n\nThis is the same threat model the file's own comments give for denying wire-signing.mjs (\"The build step right after it receives FORAY_KEYSTORE_PASSWORD\") and upload-retry.mjs (\"runs inside the ios-archive step that holds the decoded App Store Connect key\"). The founder ruling in the \"mobile/\" comment is about app code. It does not discuss build or signing scripts. The comment says only that \"mobile/\" does not match \"tools/mobile/\". So this is an oversight, not a decision. DECISIONS.md, CODEOWNERS and the CI tooling have no compensating guard. The only other mention of mobile/gradle/** is a path trigger in android-release.yml.\n\nWhy medium and not high: exploiting it needs a malicious or compromised bot PR that passes CI, and the Android keystore secret is still latent (not installed) per the path-policy comments. The iOS/ASC credentials are described as live, so that exposure exists today. The proposed fix of narrow DENIED entries for mobile/gradle/, the mobile package manifests and the plugin build manifests is consistent with the file's existing pattern.",
  "merged_ids": [],
  "lane": "L7-ci-release-security"
}
```

## ci-release-6: release-trigger treats main as 'red' when an advisory, non-required ci.yml job fails (ios-kit, playwright), which blocks automatic releases

**confirmed** · verifier severity **medium** (finder: medium) · ci-release · correctness · `tools/release/watch-release.mjs:587` · L7-ci-release-security

```json
{
  "id": "ci-release-6",
  "area": "ci-release",
  "category": "correctness",
  "title": "release-trigger treats main as 'red' when an advisory, non-required ci.yml job fails (ios-kit, playwright), which blocks automatic releases",
  "file": "tools/release/watch-release.mjs",
  "line": 587,
  "severity": "medium",
  "scenario": "ci.yml runs on `push: branches: [main]`, including the non-required `ios-kit` (macOS) and advisory `playwright` jobs. When either fails, the run's conclusion is `failure`, so mainState() puts 'CI' in `failing` and triggerDecision returns HOLD_MAIN_RED. No release ships until a later main commit is fully green, and G3 then pages after 6h. This already happens: 3 of the last 10 main push runs of ci.yml failed, and in all three `ios-kit` failed. The docstring's premise, 'Main runs almost nothing on push today (Pages, and a commit status from the deploy host)', is false.",
  "evidence": "`for (const r of mainRuns) { if (r.event === \"schedule\" || r.event === \"workflow_dispatch\") continue; if (r.path.endsWith(\"/release.yml\")) continue; if (isInFlight(r)) building.push(r.name); else if (RED_RUN.has(r.conclusion)) failing.push(r.name); }`. It judges whole-run conclusions, not the required jobs. `gh api .../ci.yml/runs?branch=main&event=push`: runs 35950411353, 35900753042 failed with only ios-kit red.",
  "fix_sketch": "For ci.yml runs, fetch the jobs (or the head SHA's check-runs) and count only the required contexts (`backend`, `data-and-site`, reusing pr-triage's REQUIRED_CHECKS) as red or building. Or have release-trigger read `commits/{sha}/check-runs` filtered by those names. Fix the docstring as well.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the code at origin/main and the finding holds. In tools/release/watch-release.mjs, mainState() (lines 587-600) skips only schedule and workflow_dispatch runs and release.yml. Every other run on main's head SHA whose conclusion is failure, timed_out, startup_failure or action_required goes into `failing`, and it judges the whole run's conclusion, not individual jobs. release-trigger.yml (line 102) fetches `actions/runs?head_sha=$HEAD_SHA`, so push runs of ci.yml are included. ci.yml runs on `push: branches: [main]`. Its `ios-kit` job (macOS) is explicitly not required, per its own comment and DECISIONS.md around line 1114. `playwright` is marked \"ADVISORY-ONLY ... DELIBERATELY\". Either job failing turns the whole run's conclusion to `failure`, and triggerDecision then returns HOLD_MAIN_RED. The docstring's premise (\"Main runs almost nothing on push today (Pages, and a commit status...)\") is out of date. I found no comment or DECISIONS entry that deliberately treats advisory CI jobs as release blockers, and nothing else in the code handles the case. release.yml does not reference ForayKit or ios/, so a red ios-kit is not a real reason to hold the release.\n\nLive data: 3 of the last 10 main push runs of ci.yml failed. By their jobs: run 35950411353 had only ios-kit red, 35900753042 had only ios-kit red, and 35917301419 had ios-kit and data-and-site red. So in 2 of the 3, main was held red only because of the advisory ios-kit job.\n\nWhy medium, not high: the hold clears as soon as a later main commit is fully green (the last 6 were). Release-trigger's own runs still succeed, and nothing ships broken. The cost is delayed automatic releases, plus a possible G3 stall page if ios-kit stays red for a long time.",
  "merged_ids": [],
  "lane": "L7-ci-release-security"
}
```

## ci-release-7: The sweep's ARM path skips the truncated-file-list guard, so it re-arms PRs that automerge-nightly refused as TRUNCATED_FILE_LIST

**confirmed** · verifier severity **low** (finder: medium) · ci-release · security · `.github/workflows/pr-hygiene.yml:161` · L7-ci-release-security

```json
{
  "id": "ci-release-7",
  "area": "ci-release",
  "category": "security",
  "title": "The sweep's ARM path skips the truncated-file-list guard, so it re-arms PRs that automerge-nightly refused as TRUNCATED_FILE_LIST",
  "file": ".github/workflows/pr-hygiene.yml",
  "line": 161,
  "severity": "medium",
  "scenario": "A PR with more than 3000 changed files has its REST file list silently truncated. automerge-nightly compares the list against `changed_files` and passes `--truncated`, so the decision is NOT ARMED. pr-hygiene gathers the same truncated list, never compares counts, and planMergeability never passes `truncated` to automergeDecision. Once the PR is clean, the next hourly sweep plans `enable-auto` on a diff whose unseen file could be `.github/…` or `backend/src/…`. The guard exists on one merge path and not the other, the same two-copies drift path-policy.mjs was written to prevent.",
  "evidence": "pr-hygiene.yml:161 `files=$(gh api --paginate \"repos/$REPO/pulls/$n/files\" --jq '[.[].filename]' | jq -s 'add // []')`, with no changed_files check. pr-triage.mjs:304 `automergeDecision({ files: pr.files, labels: pr.labels, freeze, baseRef })`, with no `truncated`.",
  "fix_sketch": "In normalizePr, set `truncated = Number.isFinite(raw.changed_files) && raw.changed_files !== files.length` (the REST PR object already carries changed_files). Pass it to automergeDecision in both the arm and disarm calls and in planFounderQueue. Add a test.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The code gap is real at origin/main, but a check that is not required still makes it hard to reach in practice.\n\nWhat the code does:\n- pr-hygiene.yml (around line 160) fetches the file list with `gh api --paginate .../pulls/$n/files` and never compares it with `.changed_files`.\n- In tools/ci/pr-triage.mjs, `normalizePr` has no truncated field. All three `automergeDecision` calls leave out `truncated`, so it defaults to false: disarm at ~280, arm at ~304, `planFounderQueue` at ~451.\n- automerge-nightly.yml (lines 173-185) and path-policy.yml (lines 158-164) both compare the count and pass `--truncated`. So the guard is on two paths and missing from the sweep, which is the drift the finding describes.\n- Nothing in docs/DECISIONS.md or the comments says leaving it out is deliberate.\n\nWhy it is low, not medium:\n1. It needs a PR with more than 3000 changed files.\n2. The ARM branch runs only when `mergeable_state === \"clean\"`. On a truncated diff, path-policy.yml's `pathGate` counts the truncation as a governed item, so the verdict is UNAPPROVED. `PATH_POLICY_ENFORCE=1` is set, so that check goes red.\n3. The path-policy check is NOT required (per the path-policy.yml header, HUMAN-ACTIONS #1 step 2 is still open). A failing check that is not required makes GitHub report `unstable`, not `clean`, so the sweep will not arm the PR.\n\nWays it can still happen:\n- The PR carries `founder-approved`, which turns the path-policy check green.\n- The path-policy run was lost or never ran.\n- Someone switches ENFORCE off.\n\nWhichever of these happens, the sweep would arm a diff it only partly saw, with nothing required to stop the merge. The disarm half has the same gap: an already-armed PR is not disarmed on truncation.\n\nThe suggested fix is sound: set `truncated` in `normalizePr` from `changed_files` and pass it to all three calls. No test was run; this verdict comes from reading the code.",
  "merged_ids": [],
  "lane": "L7-ci-release-security"
}
```

## ci-release-8: A same-repo PR can edit automerge-nightly.yml to arm itself, because pull_request runs the PR's copy of the workflow

**refuted** · verifier severity **low** (finder: medium) · ci-release · security · `.github/workflows/automerge-nightly.yml:94`

```json
{
  "id": "ci-release-8",
  "area": "ci-release",
  "category": "security",
  "title": "A same-repo PR can edit automerge-nightly.yml to arm itself, because pull_request runs the PR's copy of the workflow",
  "file": ".github/workflows/automerge-nightly.yml",
  "line": 94,
  "severity": "medium",
  "scenario": "The header says 'A PR cannot influence the policy that judges it'. That holds only for the sparse checkout of tools/ci. For `pull_request` events GitHub runs the workflow YAML from the PR's merge commit. A same-repo PR can therefore change this file, for example by dropping the `if: steps.decide.outputs.armed == 'true'` gate or checking out its own head, and arm `gh pr merge --auto` on itself. path-policy (which would flag the .github/ change) is NOT a required check: the ruleset requires only backend and data-and-site, with 0 approvals. One caveat: GitHub may refuse a GITHUB_TOKEN-driven merge of a workflow-file change for lack of the `workflows` permission, which narrows but does not eliminate the risk (for example, editing pr-hygiene.yml to arm other PRs).",
  "evidence": "`on: pull_request: types: [opened, reopened, synchronize, labeled, unlabeled, ready_for_review, edited]` with `permissions: contents: write, pull-requests: write`. Ruleset 19713996: required_status_checks `backend`, `data-and-site` only.",
  "fix_sketch": "Switch automerge-nightly (and the PR-event half of pr-hygiene) to `pull_request_target`. That is safe here because both jobs already check out only the default branch's tools/ci with persist-credentials: false and never execute PR code. Also complete HUMAN-ACTIONS #1 step 2 by marking `path-policy` required.",
  "duplicates": [],
  "verdict": "refuted",
  "verdict_severity": "low",
  "verdict_reasoning": "The mechanism is real. At origin/main, .github/workflows/automerge-nightly.yml triggers on `pull_request` (types include synchronize/labeled/edited) with `contents: write, pull-requests: write`. For a same-repo PR, GitHub runs the PR's own copy of the YAML with a write-capable GITHUB_TOKEN. So the header line \"A PR cannot influence the policy that judges it\" protects only the sparse tools/ci checkout, not the workflow file. As a threat, though, the scenario does not hold:\n\n(1) Self-arming fails on its own terms. A PR that edits automerge-nightly.yml changes a workflow file. GitHub refuses to create or update workflow files with a GITHUB_TOKEN (it cannot hold the `workflows` permission), and auto-merge runs as the actor that enabled it (github-actions[bot]). So a PR armed by its own edited workflow cannot be merged by that token. The finding admits this.\n\n(2) The fallback does not escalate anything. Editing pr-hygiene.yml so it arms other PRs needs someone who can push a same-repo branch, which means repo write access. The ruleset needs 0 approvals and only `backend` and `data-and-site`, so that same actor can already run `gh pr merge` or `--auto` on any green PR directly. Routing it through an edited workflow gives them nothing they don't already have. Forks are excluded: fork PRs get a read-only token, and the job's `head.repo.full_name == github.repository` guard skips them.\n\n(3) The repo already treats this trust boundary as a known, deliberate choice. The path-policy.yml header says openly that an agent with write access can get past these gates, calling it \"a norm with a receipt, not a wall\". It also says path-policy is enforcing (PATH_POLICY_ENFORCE=1) but not yet required, and leaves that as an open human action. Stronger protection would need a human-only signal such as CODEOWNERS or a separate merge identity, which the repo explicitly puts off.\n\nWhat survives is a documentation overstatement in the automerge header comment, plus a low-cost hardening option: switching to `pull_request_target` is plausible because the job never runs PR code. It is not a medium-severity exploitable path.",
  "merged_ids": [],
  "lane": null
}
```

## ci-release-9: The shared concurrency groups with cancel-in-progress:false still drop runs: GitHub keeps one pending run per group and cancels the older one

**confirmed** · verifier severity **low** (finder: low) · ci-release · ci-tooling · `.github/workflows/pr-hygiene.yml:85` · L7-ci-release-security

```json
{
  "id": "ci-release-9",
  "area": "ci-release",
  "category": "ci-tooling",
  "title": "The shared concurrency groups with cancel-in-progress:false still drop runs: GitHub keeps one pending run per group and cancels the older one",
  "file": ".github/workflows/pr-hygiene.yml",
  "line": 85,
  "severity": "low",
  "scenario": "pr-hygiene uses one global group so that runs are serialized. With a run in progress, a queued hourly sweep is cancelled as soon as any PR's labeled/synchronize event queues behind it, and the replacement looks at only that one PR. The freeze disarm, the self-heal and the ARM half then skip that hour, and PR-event runs for other PRs are silently lost. release-watch.yml and release-trigger.yml share the `release-alarm` group the same way. When GitHub's multi-hour cron delays bunch them together, a pending trigger run can be cancelled by a later watch run, and the lost scheduled successes feed the 8h liveness gate (PEER_SILENT false alarms).",
  "evidence": "pr-hygiene.yml:93-94 `group: pr-hygiene` / `cancel-in-progress: false`, with a comment claiming it 'costs a little queueing'. release-watch.yml:51 and release-trigger.yml:50 `group: release-alarm`.",
  "fix_sketch": "Give the two release workflows separate groups (the sticky-issue race is already made idempotent by planIssue, or can take a lighter lock). For pr-hygiene, give the scheduled sweep its own group (`pr-hygiene-sweep`) and put PR events in per-PR groups. Keep the one-comment invariant by re-reading comments immediately before posting in the executor, or accept a rare duplicate comment.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read all three files at origin/main, and the pr-hygiene part of the finding holds. pr-hygiene.yml:93-94 puts every run in one global `group: pr-hygiene` with `cancel-in-progress: false`. The comment above it chose this on purpose to keep the one-comment invariant, and it assumes the only cost is \"a little queueing\". That assumption is wrong. GitHub allows at most one running and one pending run per concurrency group, and when a new run is queued it cancels the existing pending one. `cancel-in-progress: false` only protects the run that is already going.\n\nThe loss is real. A PR-event run, which sets ONE_PR and gets `--partial` with no `--sweep` at lines ~196-200, can replace a pending hourly sweep. That skips the full-list self-heal, the freeze handling and the ARM pass for that hour. A PR event for a different PR can also be dropped outright. This takes three runs arriving within about 30 seconds, which is plausible when agents open PRs with several labels or when bursts of labeled/synchronize events hit the :23 sweep. Labels written by the workflow's own GITHUB_TOKEN do not trigger new runs, so it cannot cascade itself into this.\n\nThe damage is limited, though. The next hourly sweep, at most about an hour later, picks up whatever was dropped, and nothing is lost for good.\n\nThe release half is overstated. release-watch.yml and release-trigger.yml do share `group: release-alarm`, so the same drop can happen. But livenessGate uses WATCHDOG_STALE_HOURS = TRIGGER_STALE_HOURS = 8 (watch-release.mjs:140-141). A PEER_SILENT false alarm would need about 4 consecutive trigger runs (every 2h) or about 8 watch runs (hourly) to be dropped. With runs this short, one dropped run is rare and a string of them is not realistic.\n\nI found nothing in DECISIONS.md or elsewhere that knowingly accepts the dropped-pending-run behaviour. The shared groups themselves are deliberate, but the comments show the pending-cancel side effect was not understood. Severity is low: the mechanism is real, but it causes at most a one-hour delay in PR hygiene and a mostly theoretical risk for the release alarm.",
  "merged_ids": [],
  "lane": "L7-ci-release-security"
}
```

## ci-release-10: The self-heal's dispatch guard treats ANY non-dispatch ci.yml run as coverage, so a cancelled or startup_failure run strands the PR permanently

**confirmed** · verifier severity **low** (finder: low) · ci-release · correctness · `tools/ci/pr-triage.mjs:191` · L7-ci-release-security

```json
{
  "id": "ci-release-10",
  "area": "ci-release",
  "category": "correctness",
  "title": "The self-heal's dispatch guard treats ANY non-dispatch ci.yml run as coverage, so a cancelled or startup_failure run strands the PR permanently",
  "file": "tools/ci/pr-triage.mjs",
  "line": 191,
  "severity": "low",
  "scenario": "The planner closed 'hole 3' by re-dispatching whenever a required check is missing from a 30-minute-old head. If that head's `pull_request` ci.yml run ended `cancelled` or `startup_failure` before creating the `backend`/`data-and-site` check runs (for example during a GitHub Actions incident), every hourly heal plans dispatch-ci. `dispatch-needed` then sees a `pull_request` run for the SHA, exits 1, and skips. The PR sits at 'Expected — waiting for status' forever, which is the stall this file exists to prevent.",
  "evidence": "`export function ciDispatchIsRedundant(runs = []) { return runs.some((r) => { const event = ...r.event; return event !== \"\" && event !== \"workflow_dispatch\"; }); }` ignores status and conclusion.",
  "fix_sketch": "Count a run as coverage only if it is in flight or completed with a conclusion other than cancelled / startup_failure / skipped. Better, since the planner already knows the check names are missing, have dispatch-ci for the self-heal bypass the redundancy guard when the matching run is completed.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The finding holds at origin/main. `ciDispatchIsRedundant` (tools/ci/pr-triage.mjs:191-196) returns true when any run's `event` is something other than \"\" or \"workflow_dispatch\". It never looks at `status` or `conclusion`. The executor in pr-hygiene.yml:329-337 runs `dispatch-needed` on `actions/workflows/ci.yml/runs?head_sha=$sha` and skips the dispatch when the exit code is 1.\n\nThe self-heal at pr-triage.mjs ~415-428 plans `dispatch-ci` whenever a required check is missing from a head older than 30 minutes. That makes the scenario real. Take a `pull_request` run that ended before its jobs were created: it leaves `backend`/`data-and-site` absent from the check-runs the gather step reads (pr-hygiene.yml:167). Every heal then plans a dispatch, the guard sees the `pull_request` run and skips it, and the PR stays stranded.\n\nThe comment at ~415-417 says the guard is meant to bound duplicate dispatches, \"if a run already exists for the head SHA\". Nothing in the code, the comments or DECISIONS.md considers a run that exists but produced no checks. So this is an oversight, not a deliberate choice, and nothing else in the planner or workflow handles it.\n\nWhy the severity stays low:\n- ci.yml has no `concurrency` block, so nothing cancels a run automatically. A cancel before job creation would need a manual cancel or a GitHub incident.\n- A `startup_failure` caused by an invalid ci.yml would break a dispatch as well, so skipping the dispatch loses nothing in that case.\n- A run cancelled after its jobs were created leaves check runs with a cancelled conclusion. Those checks are not \"missing\", so that case never reaches this path.\n- The problem clears on the next push, re-run or re-open.\n\nIn practice the stall needs an Actions-side failure that kills the run before its jobs exist, which is rare but possible.",
  "merged_ids": [],
  "lane": "L7-ci-release-security"
}
```

## ci-release-13: The TestFlight upload error message tells the reader to 'see altool-upload.log in this job's artifacts', but the release path never uploads it

**confirmed** · verifier severity **low** (finder: low) · ci-release · error-handling · `.github/actions/ios-archive/action.yml:370` · L7-ci-release-security

```json
{
  "id": "ci-release-13",
  "area": "ci-release",
  "category": "error-handling",
  "title": "The TestFlight upload error message tells the reader to 'see altool-upload.log in this job's artifacts', but the release path never uploads it",
  "file": ".github/actions/ios-archive/action.yml",
  "line": 370,
  "severity": "low",
  "scenario": "When altool fails permanently (duplicate build number, a signing problem), the step exits pointing at an artifact that does not exist. Neither the ios-archive composite nor release.yml's ios job has an upload-artifact step for $ART ($RUNNER_TEMP/ios-release). The only full record of the failure the retry loop was built for is discarded, which is what made the 2026-09-22 root cause hard to read. Only the `tail -20` of xcodebuild and the tee'd altool output survive, in a 90-day log.",
  "evidence": "`echo \"::error::TestFlight upload failed on attempt $attempt and will not be retried (${REASON:-unclassified}). See altool-upload.log in this job's artifacts.\"`, with `UPLOAD_LOG=\"$ART/altool-upload.log\"`. There is no `actions/upload-artifact` in ios-archive/action.yml or in release.yml's ios job.",
  "fix_sketch": "Add an `if: always()` `actions/upload-artifact@v4` step (path `${{ runner.temp }}/ios-release`, short retention) at the end of the composite. $ART holds only logs and plists; the .p12, .p8 and keychain live elsewhere in RUNNER_TEMP and HOME. Or fix the message to point at the job log.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "Confirmed at origin/main. In .github/actions/ios-archive/action.yml, line 53 sets ART=$RUNNER_TEMP/ios-release, line 350 sets UPLOAD_LOG=\"$ART/altool-upload.log\", and line 370 says \"See altool-upload.log in this job's artifacts.\" The composite has no actions/upload-artifact step. release.yml's ios job (lines 185-218) is checkout, a release-gate test, then the composite, with no upload step. The only upload-artifact steps in the repo are in the android-bundle action, android-build.yml, android-release.yml and ios-build.yml. The ios-build.yml one uploads ${{ runner.temp }}/ios-ci, not ios-release, and that workflow does not call the composite anyway. So when a failure is not retried, the message points the reader at an artifact that never exists. I found no comment or decision saying this is deliberate. One part of the finding overstates the impact: altool's output is piped through `tee \"$UPLOAD_LOG\"`, so the full text of the failing attempt is already in the job log. Only the file copy is lost, not the diagnostic content. What remains is a misleading error message plus toolchain.txt never being kept. Low severity. Either fix works: add an if: always() upload of runner.temp/ios-release with short retention, or change the message to point at the job log.",
  "merged_ids": [],
  "lane": "L7-ci-release-security"
}
```

## ci-release-14: crlf-guard's binary exemption is a hand-kept list, but the font list it guards is derived from the directory, so adding a font breaks every deploy build

**deliberate** · verifier severity **low** (finder: low) · ci-release · ci-tooling · `tools/ci/crlf-guard.mjs:46`

```json
{
  "id": "ci-release-14",
  "area": "ci-release",
  "category": "ci-tooling",
  "title": "crlf-guard's binary exemption is a hand-kept list, but the font list it guards is derived from the directory, so adding a font breaks every deploy build",
  "file": "tools/ci/crlf-guard.mjs",
  "line": 46,
  "severity": "low",
  "scenario": "generate-manifest.mjs and prepare-dist.mjs derive fontSources() from `fonts/*.woff2` 'so a new face cannot be forgotten'. crlf-guard only exempts the three fonts named in BINARY_LISTED, and its own comment says all three contain `\\r\\n` byte pairs, so a new woff2 almost certainly will too. Adding fonts/new-face.woff2 makes stampBuild throw 'CRLF line endings in files the deploy manifest hashes'. `data-and-site` (prepare-dist) goes red, and so do Pages and the Vercel build, with a misleading message telling the author to fix core.autocrlf.",
  "evidence": "`export const BINARY_LISTED = new Set([\"icon-180.png\", \"icon-512.png\", \"fonts/dm-sans-variable.woff2\", \"fonts/fraunces-italic-variable.woff2\", \"fonts/fraunces-variable.woff2\"]);` versus generate-manifest.mjs fontSources() `readdirSync(dir).filter((f) => f.endsWith(\".woff2\"))`.",
  "fix_sketch": "Exempt by binary extension for the derived directories (`/\\.(png|woff2)$/`), or have crlfOffenders take an `isBinary` predicate supplied by listedFiles(). Add a test that a fresh fonts/*.woff2 containing CRLF bytes is not flagged.",
  "duplicates": [],
  "verdict": "deliberate",
  "verdict_severity": "low",
  "verdict_reasoning": "The finding's description of the code is accurate at origin/main. BINARY_LISTED in tools/ci/crlf-guard.mjs (line 46) is a hand-kept set of 2 icons and 3 fonts. fontSources() in generate-manifest.mjs builds its list from fonts/*.woff2. crlfOffenders skips only the keys named in that set. So an unlisted new .woff2 with a \\r\\n byte pair would make stampBuild or prepare-dist fail with the misleading core.autocrlf message.\n\nTwo things weaken it, though.\n\n(1) The explicit list is a documented design choice. The comment above BINARY_LISTED says it is \"Kept as an explicit set rather than a suffix guess, for the same reason generate-manifest.mjs's SHELL is explicit: a new binary shell file must be classified deliberately, and a text file wrongly listed here would silently disable the guard for it.\" The finding's proposed fix, exempting by extension, is exactly the \"suffix guess\" the authors rejected.\n\n(2) The mismatch is already caught elsewhere, with a clear message. The test in test/boot-path.test.js titled \"perf-5: the CRLF guard knows the faces are binary...\" loops over every face fontSources() returns and asserts `BINARY_LISTED.has(f)`, failing with \"${f} is not classified binary\". It then asserts crlfOffenders(ROOT, faces) is empty. So a PR that adds fonts/new-face.woff2 without classifying it turns the test suite red and names the exact fix. That is the deliberate-classification tripwire working as designed; the gap is not silent. The fix sketch's \"add a test that a fresh fonts/*.woff2 is not flagged\" is effectively already covered by that test.\n\nWhat remains is minor: a developer who runs prepare-dist or a deploy build before the tests would see the misleading autocrlf text. That is a message-quality nit, not a latent failure that reaches production. I did not run the test because reading the code settles it.",
  "merged_ids": [],
  "lane": null
}
```

## ci-release-15: prepare-dist deletes whatever `--out` points at before building, so `--out .` or `--out ..` wipes the checkout, and a bare `--out` crashes

**confirmed** · verifier severity **low** (finder: low) · ci-release · correctness · `tools/web/prepare-dist.mjs:118` · L4-web-platform

```json
{
  "id": "ci-release-15",
  "area": "ci-release",
  "category": "correctness",
  "title": "prepare-dist deletes whatever `--out` points at before building, so `--out .` or `--out ..` wipes the checkout, and a bare `--out` crashes",
  "file": "tools/web/prepare-dist.mjs",
  "line": 118,
  "severity": "low",
  "scenario": "`node tools/web/prepare-dist.mjs --out .` (or any path resolving to ROOT or an ancestor) runs `rmSync(OUT, { recursive: true, force: true })` on the repo root, deleting the working tree including uncommitted work. `--out` as the last argument yields `args[indexOf+1] === undefined`, and `join(ROOT, undefined)` throws a TypeError instead of a usage error. CI uses `--out \"$RUNNER_TEMP/dist\"` safely. The risk is local and agent use of a script with a destructive default.",
  "evidence": "`const OUT_ARG = args.includes(\"--out\") ? args[args.indexOf(\"--out\") + 1] : \"dist\"; const OUT = isAbsolute(OUT_ARG) ? OUT_ARG : join(ROOT, OUT_ARG); ... rmSync(OUT, { recursive: true, force: true });`",
  "fix_sketch": "Validate OUT_ARG is a non-empty string. Refuse when OUT equals ROOT or is an ancestor of it (`!path.relative(OUT, ROOT).startsWith('..')`), or when it contains a `.git` directory. Print usage and exit 2.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read tools/web/prepare-dist.mjs at origin/main and the code matches the finding. `OUT_ARG = args.includes(\"--out\") ? args[args.indexOf(\"--out\") + 1] : \"dist\"`, then `OUT = isAbsolute(OUT_ARG) ? OUT_ARG : join(ROOT, OUT_ARG)`. Around line 118, the script calls `rmSync(OUT, { recursive: true, force: true })` with no guard between those lines. `join(ROOT, \".\")` equals ROOT, and `..` resolves to an ancestor, so `--out .` recursively deletes the checkout, including the .git directory and any uncommitted work. The header comment documents `--out X` as a supported option. Nothing in the file, docs/DECISIONS.md or the other callers restricts it. I found only three callers (vercel.json with the default `dist`, ci.yml with `$RUNNER_TEMP/dist`, and the docs), so no caller hits the bad path today.\n\nA bare `--out` does crash. The exception comes from `isAbsolute(undefined)`, which runs before `join` does (ERR_INVALID_ARG_TYPE). Either way it is an uncaught TypeError rather than a usage error, and it happens before the rmSync, so this half is harmless apart from the poor error message.\n\nI rate it low. Someone has to explicitly pass a root or ancestor path; the default and CI paths are safe. The downside of that mistake, though, is total loss of local work, and agents do run this script (DECISIONS.md tells people to use it for local site builds), so a guard that refuses when OUT is ROOT or an ancestor of it is worth adding.",
  "merged_ids": [],
  "lane": "L4-web-platform"
}
```

## ci-release-16: nightly-refresh's 'Restore scan state' treats any API failure as 'no state', silently resetting and then overwriting the seen-guid state (the fail-open the guard step was fixed for)

**deliberate** · verifier severity **low** (finder: low) · ci-release · error-handling · `.github/workflows/nightly-refresh.yml:220`

```json
{
  "id": "ci-release-16",
  "area": "ci-release",
  "category": "error-handling",
  "title": "nightly-refresh's 'Restore scan state' treats any API failure as 'no state', silently resetting and then overwriting the seen-guid state (the fail-open the guard step was fixed for)",
  "file": ".github/workflows/nightly-refresh.yml",
  "line": 220,
  "severity": "low",
  "scenario": "A transient 5xx, rate limit or token blip on `gh api contents/refresh-state.json` fails the pipeline under pipefail. The else branch writes `{\"seen\":{}}`, the scan runs from empty state, and the publish step PUTs the fresh file over the real history on refresh-digest. Separately, the contents API returns an empty `content` for files over 1 MB, so once refresh-state.json passes 1 MB (64 KB today and growing) every run 'restores' 0 bytes. The step above it was rewritten specifically to split 404 from transient errors ('I COULD NOT TELL MUST NOT BE SPELLED THE SAME WAY AS THERE IS NONE'), but this step was not.",
  "evidence": "`if gh api \"repos/$REPO/contents/refresh-state.json?ref=$DIGEST_BRANCH\" --jq .content 2>/dev/null | base64 -d > refresh-state.json; then ... else echo '{\"seen\":{}}' > refresh-state.json; echo \"no prior state ... starting fresh\"; fi`",
  "fix_sketch": "Reuse the fetch_digest pattern: retry, treat only 404 as 'no state', and fail the job otherwise. Fetch via the raw media type (`-H 'Accept: application/vnd.github.raw'`) or the git blobs API so files over 1 MB work. Validate that the restored file parses as JSON with a `seen` object.",
  "duplicates": [],
  "verdict": "deliberate",
  "verdict_severity": "low",
  "verdict_reasoning": "The code at origin/main matches the finding. In .github/workflows/nightly-refresh.yml lines 219-224, `set -euo pipefail` is on, and `if gh api .../contents/refresh-state.json?ref=$DIGEST_BRANCH --jq .content 2>/dev/null | base64 -d > refresh-state.json; then ... else echo '{\"seen\":{}}' ...` sends any gh failure (5xx, rate limit, token problem, or 404) to the \"starting fresh\" branch. The publish step then calls put_file on refresh-state.json (line 301), which overwrites the saved state on refresh-digest. So the fail-open is real, and it is not handled the way the guard step's fetch_digest handles it.\n\nThe failure is accepted on purpose, though, and does little harm:\n(1) The comment directly above the step (lines 210-213) accepts losing the state: \"Absent on the very first run — that's fine; resolve.mjs still dedups against published discover.json, so a lost state file can never produce a duplicate.\" The guard step's all-caps rule is there because a wrong verdict there permanently loses a digest nobody merged. Here, a reset state costs almost nothing.\n(2) scan.mjs runs with --window-hours 48, so starting from empty state only re-emits items from the last 48 hours. resolve.mjs drops the ones already in discover.json. Because the guard has already required the previous digest to be merged or landed, the only extra output is items the runner chose to skip (trailers, cross-promos). They can show up once more in one digest. That is noise, not data loss or duplicates.\n(3) The overwritten state loses nothing that matters. It is rebuilt from the feeds, and scan.mjs keeps the last 60 guids per show, so a single reset only widens re-emission to the 48-hour window.\n\nThe claim about files over 1 MB is mostly wrong. scan.mjs line 154 keeps at most 60 guids per show (`[...seen].slice(-60)`), so the file's size is set by the number of shows, not by elapsed time. It is 64,022 bytes on origin/refresh-digest now and will not keep growing past 1 MB unless the show list grows about 16 times. Even if the content API did return empty content, loadState() catches the JSON parse error and falls back to {seen:{}}, which is the same harmless reset.\n\nConclusion: the pattern exists and is inconsistent with the guard step, but the risk is known, documented in the step's comment, and limited by design. Worth a small cleanup, such as treating only 404 as \"no state\"; it is not a real bug.",
  "merged_ids": [],
  "lane": null
}
```

## ci-release-17: The PR gathers cap at 100 open PRs, so the AUTOMERGE_FREEZE kill switch never reaches armed PRs past the first 100

**confirmed** · verifier severity **low** (finder: low) · ci-release · correctness · `.github/workflows/pr-hygiene.yml:143` · L7-ci-release-security

```json
{
  "id": "ci-release-17",
  "area": "ci-release",
  "category": "correctness",
  "title": "The PR gathers cap at 100 open PRs, so the AUTOMERGE_FREEZE kill switch never reaches armed PRs past the first 100",
  "file": ".github/workflows/pr-hygiene.yml",
  "line": 143,
  "severity": "low",
  "scenario": "The sweep is the only thing that disarms already-armed PRs when AUTOMERGE_FREEZE is set, because setting a variable fires no PR event. During a large agent fan-out (the scenario the kill switch exists for), PRs beyond the newest 100 are never gathered. They stay armed and merge on green despite the freeze, and nothing reports the truncation. `gatherPrs` in pr-triage.mjs has the same `--limit 100`.",
  "evidence": "`numbers=$(gh pr list --repo \"$REPO\" --state open --limit 100 --json number --jq '.[].number')`. pr-triage.mjs:620 `\"--limit\", \"100\"`.",
  "fix_sketch": "Use `gh api --paginate repos/$REPO/pulls?state=open&per_page=100 --jq '.[].number'`, or a large `--limit` with an assertion that fewer came back than the limit. Log a loud warning or fail when the cap is hit.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The finding holds at origin/main. .github/workflows/pr-hygiene.yml:143 gathers PRs for the scheduled sweep with `gh pr list --repo \"$REPO\" --state open --limit 100 --json number --jq '.[].number'`. It has no pagination, no check for whether the cap was hit, and no warning. tools/ci/pr-triage.mjs:620 (gatherPrs) has the same `\"--limit\", \"100\"`.\n\nThe kill-switch dependency is written down in the repo itself:\n- pr-triage.mjs:276-278 says that setting a repo variable fires no PR event, so the 6-hourly sweep is the only thing that can reach an already-armed PR.\n- automerge-nightly.yml header (lines 29-31 and point 4) says: \"It only reaches ALREADY-ARMED PRs via the pr-hygiene sweep ... which disarms every open PR whose decision is NOT ARMED.\"\n\n`gh pr list` returns the newest PRs first, so an armed PR outside the newest 100 is never disarmed by the sweep. Nothing in docs/DECISIONS.md or the code comments treats the 100 cap as deliberate. The only other paths to disarm are the per-PR event runs (synchronize/labeled etc. in automerge-nightly and pr-hygiene), and those fire only if something happens to touch that particular PR. With protect-main in place, such a PR still needs green required checks, so a red PR cannot slip through.\n\nWhy the severity is low:\n- It needs more than 100 open PRs at once. The repo currently has 4 open (818 total ever), though the docs do name large agent fan-outs as the reason the kill switch exists.\n- The sweep already has a latency of up to 6 hours, so the freeze was never instant for armed PRs anyway.\n- Stranded PRs still have to pass the required CI checks before they can merge.\n\nThe fix sketch (use `gh api --paginate`, or assert on or warn about the cap) is sound.",
  "merged_ids": [],
  "lane": "L7-ci-release-security"
}
```

## mobile-native-1: iOS ForayTts.speak() queues behind a paused or still-speaking utterance, so after any skip away from a narration line the next narration is silent

**confirmed** · verifier severity **high** (finder: high) · mobile-native · correctness · `mobile/plugins/foray-tts/ios/Sources/ForayTtsPlugin/ForayTtsPlugin.swift:677` · L3-player-and-native-tts

```json
{
  "id": "mobile-native-1",
  "area": "mobile-native",
  "category": "correctness",
  "title": "iOS ForayTts.speak() queues behind a paused or still-speaking utterance, so after any skip away from a narration line the next narration is silent",
  "file": "mobile/plugins/foray-tts/ios/Sources/ForayTtsPlugin/ForayTtsPlugin.swift",
  "line": 677,
  "severity": "high",
  "scenario": "This happens on iOS during a Foray. A narration line N1 is speaking and the listener presses the lock-screen or car ◀◀/⏭, or skips in the app. The reducer's skip emits pausePlayback before loadItem (player/queue-state.js handleSkip), so queue-manager._pauseNarration calls ForayTts.pause, which runs pauseSpeaking(at: .word). N1 stays in AVSpeechSynthesizer's queue, paused. Then loadItem calls speak(N2). This happens for a restart-in-place of N1 (◀◀ sets forced=0, so resumingSpeech is false) and for the next narration item reached later, even after tape played in between, because _endSynthNarration never stops the synthesizer. AVSpeechSynthesizer.speak only enqueues, and the synthesizer is still paused, so nothing is heard. _beginSynthNarration sets _narrationPaused=false, so startPlayback never calls resume. Each later narration is silence until the page's deadline (1.5x the line's estimate + 10 s) advances it. The queue keeps growing. If the listener later presses pause and play, continueSpeaking plays the rest of the stale N1 first, and N1's didFinish then advances the wrong item. The same thing happens when a listener pauses a Foray during narration and taps a voice audition (client.js auditionVoice → speak): the audition is silent. Android does not have this bug because it speaks with QUEUE_FLUSH and emulates pause as stop(). The Web Speech fallback in foray-tts.js has the same queueing behaviour.",
  "evidence": "ForayTtsPlugin.swift:674-677: `try? AVAudioSession.sharedInstance().setCategory(...); try? ...setActive(true); synthesizer.speak(utterance)`. Nothing is stopped or flushed first. The pause at :800-802 is `synthesizer.isSpeaking && !synthesizer.isPaused ? synthesizer.pauseSpeaking(at: .word)`, which leaves the utterance queued. Android, ForayTtsPlugin.java:331/333: `tts.speak(..., TextToSpeech.QUEUE_FLUSH, ...)`. Web fallback, foray-tts.js:269: `speechSynth.speak(utter)` with no cancel(). queue-manager.js only calls _ttsTransport(\"stop\") from stop()/dispose (lines 612, 883, 1831).",
  "fix_sketch": "Give speak() replace semantics on every path, the way Android already behaves. In ForayTtsPlugin.swift speak(), when `synthesizer.isSpeaking || synthesizer.isPaused`, call `synthesizer.stopSpeaking(at: .immediate)` before `synthesizer.speak(utterance)`. That fires didCancel, not didFinish, so nothing advances. In foray-tts.js's web-speech branch, call `speechSynth.cancel()` before `speechSynth.speak(utter)`. Add an XCTest or pin that speak() while paused leaves the synthesizer speaking the new utterance. Add a queue-manager test: skip from a paused narration to another narration, then assert the plugin was told to flush.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "high",
  "verdict_reasoning": "I read the code at origin/main and the finding holds.\n\n1. ForayTtsPlugin.swift speak() (around lines 674-677) sets the AVAudioSession category and makes it active, then calls `synthesizer.speak(utterance)`. It does not call stopSpeaking or check isPaused/isSpeaking first. The comment next to it says speak() \"enqueues\". pause() uses `pauseSpeaking(at: .word)`, which leaves the utterance queued and the synthesizer paused. Only stop() calls stopSpeaking(.immediate).\n\n2. player/queue-manager.js has a `pausePlayback` effect. When `_loadedIsSynth` is true it calls `_pauseNarration()`, which sends `_ttsTransport(\"pause\")`. queue-state.js handleSkip sends `F.pausePlayback()` before `F.loadItem(...)` (lines 518-519 and 550-551). The `_pauseNarration` comment says outright that \"A skip, a stop and a second pause press all emit pausePlayback.\"\n\n3. In `_loadItem`, the synth branch works out `resumingSpeech = forced == null && same id && _narrationPaused`. Two cases make it false: skipping to a different item, and ◀◀, which sets forced=0. In both cases it calls `_speakNarration` → `this._tts.speak(...)`, and then `_beginSynthNarration`, which sets `_narrationPaused=false`. The following `startPlayback` then does nothing, because the flag is false. So on iOS the new utterance sits in the queue behind the paused one and is never heard.\n\n4. `_endSynthNarration` (used when a non-synth item loads) only clears the JS flags and the ticker. It never calls the transport's stop. So the stale paused utterance stays on the synthesizer across tape items, and the next narration is also silent. `_stopNarration` → \"stop\" runs only from stop()/dispose.\n\n5. tts-bridge.js speak() hands straight to the module, and foray-tts.js does the same. The web-speech branch calls `speechSynth.speak(utter)` with no cancel() before it. Nothing else flushes the queue either. I found no ruling in DECISIONS.md or in any comment that makes enqueue-behind-pause deliberate. The code's own comments assume a new speak() replaces the old utterance: \"a NEW utterance is never a paused one\". Android uses QUEUE_FLUSH, as the finding says.\n\nThe scenario needs only an ordinary listener action: skip or ◀◀ while a narration line is speaking. The result is silent narration for every later line on iOS, which is serious for the product. I did not check the exact deadline value or whether a stale didFinish from N1 would advance the wrong item. Those details are secondary, and the core defect holds without them.",
  "merged_ids": [],
  "lane": "L3-player-and-native-tts"
}
```

## mobile-native-2: The 'finished' TTS event carries no utterance identity, so a stale completion advances whichever narration is current

**confirmed** · verifier severity **medium** (finder: medium) · mobile-native · race-condition · `mobile/plugins/foray-tts/android/src/main/java/ai/jwlabs/foura/tts/ForayTtsPlugin.java:283` · L3-player-and-native-tts

```json
{
  "id": "mobile-native-2",
  "area": "mobile-native",
  "category": "race-condition",
  "title": "The 'finished' TTS event carries no utterance identity, so a stale completion advances whichever narration is current",
  "file": "mobile/plugins/foray-tts/android/src/main/java/ai/jwlabs/foura/tts/ForayTtsPlugin.java",
  "line": 283,
  "severity": "medium",
  "scenario": "There are three ways this goes wrong. (1) On Android, a voice audition is spoken while a narration line is loaded; client.js auditionVoice explicitly supports doing this mid-Foray. QUEUE_FLUSH cuts the narration (onStop), then the audition's onDone emits `finished`. queue-manager._onTtsFinished sees _loadedIsSynth and the current _speakSeq, so it advances past a narration line the listener never heard. (2) On either platform, N1 finishes naturally at about the same moment the listener skips to narration N2. didFinish/onDone for N1 is delivered to JS after _beginSynthNarration(N2) has bumped _speakSeq, and N2 is treated as finished and skipped at once. (3) On iOS, once finding 1's queued-behind-paused state exists, the resumed N1's didFinish is attributed to N2. The Swift doc comment says the page 'already tracks WHICH utterance is current and de-dupes a stray duplicate itself'. It does not: _onTtsFinished compares only against the current sequence number, so a finish from an older utterance cannot be told apart.",
  "evidence": "Java :264-299: `tts.setOnUtteranceProgressListener(new UtteranceProgressListener() { ... public void onDone(String utteranceId) { speaking = false; paused = false; notifyListeners(FINISHED_EVENT, new JSObject()); } })`. The utteranceId is ignored and the event is empty. Swift :241-243: `func speechSynthesizer(_:didFinish utterance:) { notifyListeners(Self.FINISHED_EVENT, data: JSObject()) }`. queue-manager.js:1973-1984: `const seq = this._speakSeq; if (this._advancedSpeakSeq === seq) return false; ... this._handleBackendItemEnded(END_NATURAL)`.",
  "fix_sketch": "Return an utterance token from speak(). On Android, return the UUID already generated; on iOS, keep an ObjectIdentifier/UUID for the AVSpeechUtterance. Echo the token in the `finished` payload, and on Android also ignore onDone for any id other than the current narration id. In queue-manager, store the token from _speakNarration's result and have _onTtsFinished drop any event whose token does not match. Give auditions a flag so their completion is never delivered as narration completion.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the code at origin/main and the finding holds.\n\n- **Android plugin:** `ForayTtsPlugin.java` (about lines 264-299) ignores `utteranceId` in `onDone` and sends `notifyListeners(FINISHED_EVENT, new JSObject())` with an empty payload. Every `speak()` call, auditions included, installs the same listener and speaks with QUEUE_FLUSH.\n- **iOS plugin:** `ForayTtsPlugin.swift:241-243` also sends an empty `finished` event. The doc comment at lines 231-235 claims the page \"already tracks WHICH utterance is current and de-dupes a stray duplicate itself\". That is only half true. `queue-manager.js` `_onTtsFinished` (lines 1973-1984) removes duplicates for the current `_speakSeq`. It cannot tell a finish for another utterance from a finish for the current one: the subscription at line 457 drops any payload, and the only guards are `_loadedIsSynth`, `_applying` and `_advancedSpeakSeq === _speakSeq`.\n- **Audition path:** `client.js:4222` `auditionVoice` calls the shared `ttsBridge.speak` directly. Its doc comment says an audition mid-Foray is supported and \"must never touch the queue\". `app.js:14802` `auditionVoiceRow` has no guard for \"a Foray is playing\".\n\n**Scenario 1 (Android) is real.** QUEUE_FLUSH cuts the narration line, and Android reports that through `onStop`, not `onDone`. When the audition finishes, its `onDone` sends `finished`. The manager still has `_loadedIsSynth` true and has not advanced this sequence number, so it calls `_handleBackendItemEnded(END_NATURAL)` and skips a narration line the listener never finished hearing.\n\n**iOS has a related problem.** Swift `speak()` (line 677) calls `synthesizer.speak` without stopping first, so the audition queues behind the narration line. The narration's `didFinish` advances the queue correctly. If the next item is also synthesized and has started by the time the audition's `didFinish` arrives, that event cuts it short.\n\n**Scenario 2 (the race with a skip) is mostly covered.** The `_applying > 0` guard drops events that arrive while the transition is running. An N1 finish would have to arrive after the transition has settled, which is a narrow window.\n\n**Scenario 3** depends on a different finding, which I did not check.\n\nI found nothing in the code comments that makes this deliberate or handles it elsewhere; I did not open `docs/DECISIONS.md`. The comments state the opposite intent: an audition must never touch the queue.\n\nI kept medium severity. The bug needs the user to open the voice picker and press Preview during synthesized narration. When it happens, it skips content without anyone asking.",
  "merged_ids": [],
  "lane": "L3-player-and-native-tts"
}
```

## mobile-native-3: Android TTS onError is a no-op, so an engine error leaves narration 'speaking' in silence until the page's deadline

**confirmed** · verifier severity **medium** (finder: medium) · mobile-native · error-handling · `mobile/plugins/foray-tts/android/src/main/java/ai/jwlabs/foura/tts/ForayTtsPlugin.java:301` · L3-player-and-native-tts

```json
{
  "id": "mobile-native-3",
  "area": "mobile-native",
  "category": "error-handling",
  "title": "Android TTS onError is a no-op, so an engine error leaves narration 'speaking' in silence until the page's deadline",
  "file": "mobile/plugins/foray-tts/android/src/main/java/ai/jwlabs/foura/tts/ForayTtsPlugin.java",
  "line": 301,
  "severity": "medium",
  "scenario": "On Android, a narration utterance fails inside the engine. Examples: resolveVoice picked a network-only voice (it falls back to network voices when no local one matches) and the car is in a dead zone, the TTS engine process died, or the synthesis failed. UtteranceProgressListener.onError fires, but the handler does nothing. `speaking` stays true, so state() keeps answering 'speaking', and no finished event is sent. The page's narration clock runs over silence until NARRATION_DEADLINE (1.5x the estimate + 10 s) treats the line as finished. For a 60 s bridge that is about 100 s of dead air with a 'Playing' UI, and the lock screen counts on. The comment 'completion is not awaited' predates L-03, which now does await completion through `finished`.",
  "evidence": "`@Override public void onError(String utteranceId) { /* completion is not awaited; see below */ }`. The API 21+ overload onError(String, int errorCode) is not overridden either, and nothing resets `speaking`.",
  "fix_sketch": "Override both onError overloads. Set speaking=false and paused=false, then emit either a distinct `error` event or `finished` with {error: code, utteranceId}, so queue-manager can skip or retry at once instead of waiting out the deadline. Mirror this on iOS with speechSynthesizer(_:didCancel:) only for cancels the plugin did not ask for, if that distinction is needed.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the file at origin/main and the finding holds.\n\n1. The handler really is a no-op. In ForayTtsPlugin.java at origin/main, line 302 reads `public void onError(String utteranceId) { /* completion is not awaited; see below */ }`. The API 21+ overload `onError(String, int)` is not overridden, and neither is `onStop`. Only `onDone` (lines 284-298) clears `speaking`/`paused` and calls `notifyListeners(FINISHED_EVENT, ...)`. Line 341 sets `speaking = true` when speak() returns SUCCESS. Nothing clears it on an engine error, so stateWord() (lines 729-733) keeps answering \"speaking\".\n\n2. The comment is stale. The \"see below\" comment (lines 305-315) now says completion IS reported, through onDone (L-03). So \"completion is not awaited\" is left over from before L-03. It is not a stated reason to ignore errors. The stop() javadoc (lines 694-698) intentionally does not raise FINISHED when the plugin itself calls stop(), and says stop() \"fires onError/nothing\". That covers only stops the plugin asked for, which stop() and pause() already handle by clearing the flags themselves. It is not a reason to ignore errors the engine raises on its own.\n\n3. The page's only fallback is the deadline, as the finding says. In player/queue-manager.js, `_tickNarration` (lines 1924-1932) treats the line as finished only once elapsed > narrationDeadlineSec = duration_sec x 1.5 + 10 s (lines 239-240 and 2533-2537). Reconciling state() cannot help here, because state() still answers \"speaking\". A 60 s line therefore gets up to about 100 s of silence while the UI shows Playing.\n\n4. The trigger can happen, but it is not common. resolveVoice (lines 523-546) prefers local voices. It picks a network-only voice only when every voice for the language needs a network, or when the page asks for one by name. Engine crashes and synthesis failures are other ways onError can fire. Because of that, and because the deadline limits the damage, this is not high severity. In a car, though, the listener hears up to 1.5x the line length plus 10 s of silence under a Playing UI, and the fix is small.\n\n5. A caveat for the fix, which does not change the verdict. pause() and stop() both call tts.stop(), and on older APIs or some engines that can fire onError. The new handler must skip the emit when the plugin started the stop: check that `speaking` is still true and `paused` is false, or compare the utteranceId against the current one. Otherwise a pause would advance the queue, which is the skip the stop() javadoc warns about.\n\nFile: C:/Users/wjduv/Desktop/Vibe Coding/foray/mobile/plugins/foray-tts/android/src/main/java/ai/jwlabs/foura/tts/ForayTtsPlugin.java (lines 284-302, 341, 523-546, 694-714); C:/Users/wjduv/Desktop/Vibe Coding/foray/player/queue-manager.js (lines 239-240, 1924-1932, 2533-2537).",
  "merged_ids": [],
  "lane": "L3-player-and-native-tts"
}
```

## mobile-native-4: A Foray that ends on narration never deactivates the app's audio session, contrary to the documented 'only the end of playback deactivates' rule

**confirmed** · verifier severity **low** (finder: low) · mobile-native · resource-leak · `mobile/plugins/foray-audio/ios/Sources/ForayAudioPlugin/ForayAudioPlugin.swift:592` · L3-player-and-native-tts

```json
{
  "id": "mobile-native-4",
  "area": "mobile-native",
  "category": "resource-leak",
  "title": "A Foray that ends on narration never deactivates the app's audio session, contrary to the documented 'only the end of playback deactivates' rule",
  "file": "mobile/plugins/foray-audio/ios/Sources/ForayAudioPlugin/ForayAudioPlugin.swift",
  "line": 592,
  "severity": "low",
  "scenario": "On iOS, the listener starts a Foray over Music or Spotify and never pauses it. Every narration line runs ForayTtsPlugin.speak → setActive(true) on the shared app-process session. When the Foray finishes, the page reports ended/none. sessionMove(.playing, .ended, holding: false) returns .none because this plugin never took the hold, so releaseSession(notifyOthers:) is never called. The app keeps an active, non-mixable .playback session after the Foray is over, and the app it interrupted is never sent .notifyOthersOnDeactivation. Design comment §2 promises exactly that notification ('Only the end of playback deactivates ... so the app that was interrupted may resume').",
  "evidence": "`case (_, .none), (_, .ended): return holding ? .releaseAndNotify : .none` (:592-593). The TTS plugin activates the session with `try? AVAudioSession.sharedInstance().setActive(true)` at ForayTtsPlugin.swift:675 and :816, and nothing ever deactivates it.",
  "fix_sketch": "On a transition into .ended/.none from .playing/.paused, release with .notifyOthersOnDeactivation whether or not this plugin holds the session, since narration activated the same shared instance. Keep the 'never from the playing path' rule, and add the case to testSessionMoveTable.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read the code at origin/main and the finding holds. In ForayAudioPlugin.swift, lines 592-593 read `case (_, .none), (_, .ended): return holding ? .releaseAndNotify : .none`. `holdsSession` becomes true only in holdSession(), which runs on a (.playing, .paused) transition the listener made, or on a re-hold. It is cleared on supersede. So if a Foray is never paused, or is paused and then resumed, `holding` is false when it ends, and releaseSession is never called.\n\nForayTtsPlugin.swift sets the session to `.playback`/`.spokenAudio` with no mix options and calls `setActive(true)` on the shared app-process instance (:675 speak, :816 resume). I searched the TTS plugin and all of mobile/ for deactivation. Nothing in the TTS plugin calls `setActive(false)` or uses `notifyOthersOnDeactivation`, and the only `setActive(false)` anywhere is releaseSession. So once the first narration line plays, the app's non-mixable session stays active after the Foray ends, and the app it interrupted (Music, Spotify) is never told it can resume.\n\nIs it deliberate? Partly, at the function level. The sessionMove docstring says \"a release is only ever attempted for one we made\". docs/ios-lock-screen.md §2.2 and DECISIONS describe releasing \"the hold\" on close or finish. None of them discusses the narration-activated session at the end of a Foray. Design comment §2 says \"Only the end of playback deactivates ... so the app that was interrupted may resume\", and in this path that promise is not kept.\n\nIt is not handled anywhere else. WebKit's media-process session only covers `<audio>` clips, not the app-process activation made for TTS.\n\nThe trigger is actually broader than \"ends on narration\". Any Foray that plays narration and is not paused at the end leaves the session active. The impact is limited, though. No audio is playing, the other app can be resumed by hand, and iOS will reclaim the session when the app is suspended. That makes it a lifecycle hygiene or UX gap rather than a functional failure, so the severity stays low.",
  "merged_ids": [],
  "lane": "L3-player-and-native-tts"
}
```

## mobile-native-5: Kokoro probe on Android leaks an ORT session per run and blocks every Capacitor plugin call while it runs

**confirmed** · verifier severity **low** (finder: low) · mobile-native · resource-leak · `mobile/plugins/foray-tts/android/src/main/java/ai/jwlabs/foura/tts/KokoroOrtProbeEngine.java:171` · L3-player-and-native-tts

```json
{
  "id": "mobile-native-5",
  "area": "mobile-native",
  "category": "resource-leak",
  "title": "Kokoro probe on Android leaks an ORT session per run and blocks every Capacitor plugin call while it runs",
  "file": "mobile/plugins/foray-tts/android/src/main/java/ai/jwlabs/foura/tts/KokoroOrtProbeEngine.java",
  "line": 171,
  "severity": "low",
  "scenario": "The founder runs the unlocked voice probe from the drawer more than once. Each kokoroProbe call builds a new engine (ForayTtsPlugin.java:888, since probeEngine is null in production). load() opens two 86 MB-model sessions, closes the second, and keeps the first in `session`, which is never closed. Each run therefore leaks one native OrtSession, and a few runs can OOM the app. The whole probe (two model loads plus four syntheses) also runs synchronously on Capacitor's single plugin thread on Android, and on the bridge's serial queue on iOS. If it runs mid-Foray, ForayAudio.setNowPlaying, ForayTts.speak/pause and ForayVault all stall for its duration: the lock screen freezes and narration or a pause press lags by seconds.",
  "evidence": "`session = makeSession();` (:171). There is no close()/release on the engine, and ForayTtsPlugin.kokoroProbe drops the engine reference when it returns. The loop `for (int i = 0; i < idLines.size(); i++) { double[] out = engine.synthesize(...) }` (ForayTtsPlugin.java:914) runs inside the @PluginMethod on the plugin thread. iOS does the same at ForayTtsPlugin.swift:974-1010.",
  "fix_sketch": "Make the engine Closeable and close `session` (and the env, if it is owned) in a finally block in kokoroProbe, or cache one engine in a static. Run the probe on its own executor or DispatchQueue and resolve the PluginCall from there, so the shared plugin thread stays free.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main and the finding holds. In KokoroOrtProbeEngine.load() (line ~171), `session = makeSession()` keeps the first session. Only the second session is closed. The engine has no close() or release() method, and the KokoroProbeEngine interface declares none. In ForayTtsPlugin.kokoroProbe (around line 887), `probeEngine` is a static that stays null on shipping builds, so every call runs `KokoroOrtProbeEngine.create(getContext())`. The comment there says the engine is \"dropped when this method returns\". Dropping the reference does not free the session: onnxruntime-android 1.20.0 is a real dependency in build.gradle, and its OrtSession is AutoCloseable and depends on close() to free native memory. So every probe run leaks one native session holding the ~82-86 MB model. The scenario can happen. The android-release and ios-archive workflows run fetch-models.mjs --fetch, so shipping builds carry the model. player/client.js runVoiceProbe is wired to the drawer, and its comment says it is \"deliberately independent of a live Foray\", so it can run mid-playback. The whole probe (two model loads plus synthesizing every passage line) runs synchronously inside the @PluginMethod, with no executor or thread hop. Capacitor Android dispatches plugin methods on one shared plugin HandlerThread, so calls to other plugins stall while it runs. I saw nothing in the code comments that makes the leak deliberate. The \"built on demand, dropped on return\" comment shows the author thought the engine was discarded, not that the leak was intended. Nothing else closes the session. I did not verify the iOS half in detail. Swift/ARC will likely release the ORT session when the engine goes away, so the leak is probably Android-only, but the blocking concern on iOS's bridge queue is plausible. Severity stays low: this is a founder-only diagnostic in the drawer, so it takes several repeated runs to cause an OOM, and a stall only happens if the founder starts the probe during a Foray.",
  "merged_ids": [],
  "lane": "L3-player-and-native-tts"
}
```

## mobile-native-6: iOS lock-screen artwork: one failed or timed-out fetch caches 'no artwork' for that URI for the rest of the item

**confirmed** · verifier severity **low** (finder: low) · mobile-native · error-handling · `mobile/plugins/foray-audio/ios/Sources/ForayAudioPlugin/ForayAudioPlugin.swift:857` · L3-player-and-native-tts

```json
{
  "id": "mobile-native-6",
  "area": "mobile-native",
  "category": "error-handling",
  "title": "iOS lock-screen artwork: one failed or timed-out fetch caches 'no artwork' for that URI for the rest of the item",
  "file": "mobile/plugins/foray-audio/ios/Sources/ForayAudioPlugin/ForayAudioPlugin.swift",
  "line": 857,
  "severity": "low",
  "scenario": "The car is in a dead zone when an episode or segment starts, or the artwork host is slow for 10 s. loadRemoteArtwork's completion receives data=nil and calls rememberArtwork(uri, nil), which stores (uri, nil). Every later applyNowPlayingInfo returns that cached nil (`if let cached = artworkCache, cached.uri == uri { return cached.item }`) and never retries. The lock screen and CarPlay show no artwork for the whole item, and for the whole Foray segment run when the show's artwork URI is the same. The full-size remote image is also kept decoded, whatever size MPMediaItemArtwork asks for.",
  "evidence": "```\nURLSession.shared.dataTask(with: request) { data, _, _ in ... self.artworkLoading.remove(uri)\n  let image = data.flatMap { UIImage(data: $0) }\n  _ = self.rememberArtwork(uri: uri, image: image)\n```\n(:857-862), then `if let cached = artworkCache, cached.uri == uri { return cached.item }` (:824).",
  "fix_sketch": "Cache only successes. On failure, record a retry-after timestamp, for example 30-60 s, instead of a permanent nil, and let artworkItem trigger a new load once it passes. Optionally downscale to a fixed bound, such as 600 px, before wrapping the image in MPMediaItemArtwork.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read the code at origin/main and it does what the finding says. In ForayAudioPlugin.swift, loadRemoteArtwork's completion runs on stateQueue. It computes `let image = data.flatMap { UIImage(data: $0) }` and calls `rememberArtwork(uri: uri, image: image)` whether or not the fetch worked (:857-862). A failed fetch, a timeout (artworkTimeoutSec = 10) or undecodable data therefore stores `(uri, nil)`. After that, artworkItem returns the cached nil at :824 and never calls loadRemoteArtwork again for that URI. The cache holds only one entry, so the stuck state clears only when a different artwork URI replaces it. Nothing retries for a same-URI segment run.\n\nThe code comments partly intend this. The doc comment at about :815 says \"a failed load is cached as none, so a dead URL costs one attempt and not one per write\". rememberArtwork adds that \"a nil image is cached too\". So caching failures was a deliberate choice, made to stop a request on every write after the 2026-09-23 stateQueue blocking fix. But the reasoning only considers a dead URL. It does not tell a permanent failure apart from a temporary one, such as a Wi-Fi-to-cellular switch as the car connects. That is exactly the moment the same comment names as the founder's key moment. A timed-out fetch then leaves the lock screen and CarPlay without artwork for the rest of the item. The proposed retry-after keeps the comment's goal of not fetching on every write.\n\nThe code confirms the side note too: MPMediaItemArtwork's handler returns the full-size image and ignores the requested size.\n\nThe impact is cosmetic only: no artwork, and playback and controls are unaffected. Severity is low.",
  "merged_ids": [],
  "lane": "L3-player-and-native-tts"
}
```

## mobile-native-7: Android DeviceOnlyVault cannot recover from a corrupt file: set/remove parse it first, so the vault stays broken permanently

**confirmed** · verifier severity **low** (finder: low) · mobile-native · error-handling · `mobile/plugins/foray-vault/android/src/main/java/ai/jwlabs/foura/vault/DeviceOnlyVault.java:55` · L3-player-and-native-tts

```json
{
  "id": "mobile-native-7",
  "area": "mobile-native",
  "category": "error-handling",
  "title": "Android DeviceOnlyVault cannot recover from a corrupt file: set/remove parse it first, so the vault stays broken permanently",
  "file": "mobile/plugins/foray-vault/android/src/main/java/ai/jwlabs/foura/vault/DeviceOnlyVault.java",
  "line": 55,
  "severity": "low",
  "scenario": "foray-vault.json becomes unparseable. Possible causes are storage corruption, a truncated restore of an earlier build's file, or a manual edit, since AtomicFile only protects against a torn write. read() then throws JSONException for every method, set() and remove() included. The web half treats every rejection as a fault of this tier, and ensureAnonSession refuses to refresh or sign up when the vault cannot keep the result. The listener's account can never be saved again, and 'Delete my data' cannot clear the row. Only uninstalling fixes it. Neither platform's vault has an executable test: foray-vault.test.mjs only pins source text, and Package.swift declares no testTarget.",
  "evidence": "`synchronized void set(String key, String value) ... { JSONObject rows = read(); rows.put(key, value); write(rows); }` and `return new JSONObject(new String(bytes, StandardCharsets.UTF_8));` (:55-58, :74). There is no fallback when parsing fails.",
  "fix_sketch": "In set()/remove(), catch JSONException from read() and treat it as an empty store: log the class name only, then overwrite through AtomicFile, or call file.delete() on remove. Keep get()/keys() rejecting so the store still reports 'could not look'. Add a Robolectric test for the corrupt-file case, and an XCTest target for KeychainVault.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The code at origin/main matches the finding. In DeviceOnlyVault.java, set() (lines 55-59) and remove() (lines 61-64) both call read() before they write. read() (lines 66-75) only falls back to an empty store in two cases: FileNotFoundException, and a zero-length file. For anything else it runs `new JSONObject(new String(bytes, UTF_8))`, which throws JSONException on non-JSON content. Nothing catches that exception, so every write and every removal fails once the file cannot be parsed. ForayVaultPlugin.java catches it in each method and rejects the call with \"ForayVault.<method> failed: JSONException\". The plugin's own comment says a rejection is \"a fault of this tier\". durable-store.js likewise tracks failed vault writes and removals as faults and holds on to the refresh token rather than spending it. So once the file is corrupt, the vault never recovers by itself. I found no DECISIONS.md entry or code comment that makes this deliberate. The comments cover get/keys reporting \"could not look\" instead of \"no account\", but they say nothing about write-side recovery. Nothing else in the code handles it either: a grep turned up no corruption handling or JSONException recovery anywhere in player/, docs/ or mobile/. The tests only check source text, and I did not run any. Severity stays low because the trigger is unlikely. The file lives in getNoBackupFilesDir(), so a backup restore can never bring it back, which rules out the finding's \"truncated restore\" cause. AtomicFile protects against a torn write. That leaves flash or filesystem corruption, or a manual edit on a rooted or debuggable device. Uninstalling is also not the only fix: clearing the app's storage in Android Settings removes the file too. When it does happen, though, the harm is real: the account can no longer be saved, and \"Delete my data\" cannot clear the stored row. The fix sketch is sound: in set()/remove(), treat a JSONException from read() as an empty store, and keep get()/keys() rejecting.",
  "merged_ids": [],
  "lane": "L3-player-and-native-tts"
}
```

## mobile-native-8: Android SSML path is latent-broken: overlapping lexicon matches duplicate text, and resume() speaks a substring of the SSML markup

**confirmed** · verifier severity **low** (finder: low) · mobile-native · correctness · `mobile/plugins/foray-tts/web/foray-tts.js:152` · L3-player-and-native-tts

```json
{
  "id": "mobile-native-8",
  "area": "mobile-native",
  "category": "correctness",
  "title": "Android SSML path is latent-broken: overlapping lexicon matches duplicate text, and resume() speaks a substring of the SSML markup",
  "file": "mobile/plugins/foray-tts/web/foray-tts.js",
  "line": 152,
  "severity": "low",
  "scenario": "Nothing passes lexiconEntries today, and only 1 of 83 hard-terms has an IPA value, so this path is dormant. It breaks as soon as it is wired. (a) findMatches collects matches per entry with no overlap resolution. For two terms where one contains the other, buildAndroidSsml emits `text.slice(o.start, o.end)` for both, so the shared words are spoken twice or inside nested phonemes. (b) On Android, lastSpokenText is the SSML string and resume() calls `lastSpokenText.substring(lastBoundary)`. The result starts mid-document without `<speak>` and can cut through a `<phoneme>` tag, so the engine reads the markup aloud or rejects it. onRangeStart offsets may also index the plain text rather than the markup.",
  "evidence": "foray-tts.js:152-156: `for (const o of overrides) { out += esc(text.slice(cursor, o.start)); out += `<phoneme ...>${esc(text.slice(o.start, o.end))}</phoneme>`; cursor = o.end; }`. There is no `if (o.start < cursor) continue`. ForayTtsPlugin.java:340 `lastSpokenText = ... androidSsml : text;` and :660 `String remainder = lastSpokenText.substring(from);`.",
  "fix_sketch": "In findMatches/buildIpaOverrides, sort by start then by longest match and drop any match that starts before the previous end. On Android, keep the plain text for resume and rebuild SSML for the remainder, or resume from the start of the utterance when SSML was used. Add a unit test with overlapping terms.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read both files at origin/main and the code does what the finding says.\n\n(a) Overlapping matches: in foray-tts.js, findMatches loops over every lexicon entry, collects every regex hit, and only sorts them by start. Nothing removes overlapping hits. buildAndroidSsml (lines ~152-156) then walks the overrides with `out += esc(text.slice(cursor, o.start)); out += <phoneme ...>${esc(text.slice(o.start,o.end))}</phoneme>; cursor = o.end;` and never checks `o.start < cursor`. Take two IPA-bearing terms where one contains the other, such as \"X\" and \"X Y\". Both match at the same start, so the shared text is emitted twice: a phoneme for X, then `text.slice(cursor, o.start)` with a negative span, which gives an empty string, then a phoneme for \"X Y\". The listener hears X twice.\n\n(b) Resuming from inside the markup: ForayTtsPlugin.java:340 stores the SSML string as lastSpokenText, and resume() at :660 speaks `lastSpokenText.substring(lastBoundary)`. The comment at :336-339 shows keeping the SSML string was a deliberate choice, made because onRangeStart offsets are into that string. Even so, the substring has no opening `<speak>`, and it can carry an unbalanced `</phoneme>` and `</speak>`, or start partway through a tag. The design comment does not cover this, and so does not excuse it. Whether onRangeStart offsets point into the markup or into the parsed text depends on the engine, so the boundary can also land in the wrong place. The class header (lines ~94-107) describes pause/resume only for plain text and never mentions SSML.\n\nWhy the severity stays low: the path is dormant in the app. The only code that passes lexiconEntries is in tests, fixtures and the README (tools/mobile/foray-tts.test.mjs, tts-fixture.mjs, README.md:209). With only one IPA-authored term, an overlap cannot happen yet. The behaviour is also documented as best-effort ('undocumented behaviour' per on-device-tts.md §2). It is a real latent defect that will show up once the lexicon is wired in and more IPA values are authored.",
  "merged_ids": [],
  "lane": "L3-player-and-native-tts"
}
```

## mobile-native-10: webview-probe's DevTools target fetch has no timeout, so a hung endpoint hangs the CI job past the probe deadline

**confirmed** · verifier severity **low** (finder: low) · mobile-native · ci-tooling · `tools/mobile/webview-probe.mjs:213` · L3-player-and-native-tts

```json
{
  "id": "mobile-native-10",
  "area": "mobile-native",
  "category": "ci-tooling",
  "title": "webview-probe's DevTools target fetch has no timeout, so a hung endpoint hangs the CI job past the probe deadline",
  "file": "tools/mobile/webview-probe.mjs",
  "line": 213,
  "severity": "low",
  "scenario": "In the Android emulator job, the forwarded DevTools port accepts the connection but never answers. That can happen while the WebView is starting, or when adb forward is half-up. `await fetch(`${endpoint}/json/list`)` never settles. The loop's `Date.now() < deadline` check is never reached again, so the job burns the whole workflow timeout instead of failing at --timeout-ms with the probe's diagnostic. Each evaluate() attempt can also add up to 30 s past the deadline.",
  "evidence": "`async function listTargets(endpoint) { const res = await fetch(`${endpoint}/json/list`); ... }` has no AbortSignal. probe() at :281-297 awaits it inside `while (Date.now() < deadline)`.",
  "fix_sketch": "Pass `signal: AbortSignal.timeout(Math.min(5000, deadline - Date.now()))` to fetch, and clamp evaluate's timeout to the remaining deadline.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The code at origin/main matches the finding. In tools/mobile/webview-probe.mjs, listTargets() at about line 212 calls `await fetch(`${endpoint}/json/list`)` with no AbortSignal. probe() awaits it inside `while (Date.now() < deadline)`, then calls evaluate() with a fixed 30000 ms timeout that is not clamped to the time left before the deadline. I found no comment or DECISIONS entry saying this is deliberate. The file does guard other stall modes carefully: the websocket 'close' handler and the NaN timeout-ms validation. In .github/workflows/android-release.yml (around line 1009) the probe step runs with --timeout-ms 120000 and has no step-level timeout-minutes. Only the job-level 75-minute timeout applies.\n\nThe finding overstates the impact, though. Node's built-in fetch (undici) has a default headersTimeout and bodyTimeout of 300 s. A port that accepts the connection and never answers therefore rejects after about 5 minutes. It does not burn the whole 75-minute job. The catch block records the error, the loop sees that the deadline has passed and breaks, and main still writes the --out JSON with a diagnostic. That diagnostic is a generic \"fetch failed\"/headers-timeout message rather than a clear stall message.\n\nThe trigger is also narrow. If the abstract socket does not exist, adb forward usually resets the connection at once, so fetch fails fast and is retried. Only a WebView DevTools server that accepts and then stalls would cause the hang. The real worst case is the probe finishing about 5.5 minutes past its 2-minute deadline (up to 300 s of fetch plus 30 s of evaluate), with a less specific error message.\n\nThe defect is real, but its effect is bounded and cosmetic, so severity is low. The fix sketch is sound: clamp the fetch with AbortSignal.timeout and clamp evaluate's timeout to the remaining deadline.",
  "merged_ids": [],
  "lane": "L3-player-and-native-tts"
}
```

## data-tools-1: Relay answers a fresh request with a previous run's stale reply file (ids restart at r0001, queue never cleared on start)

**confirmed** · verifier severity **medium** (finder: high) · data-tools · correctness · `tools/generation/relay.mjs:327` · L5-generation

```json
{
  "id": "data-tools-1",
  "area": "data-tools",
  "category": "correctness",
  "title": "Relay answers a fresh request with a previous run's stale reply file (ids restart at r0001, queue never cleared on start)",
  "file": "tools/generation/relay.mjs",
  "line": 327,
  "severity": "high",
  "scenario": "A keyless generation run is killed or crashes, or the driver exits, while requests are still parked. The answering session then writes queue/r0003.reply.txt, or a reply file is left unswept. start-run closes the relay but leaves every queue file in place. On the next run, createRelay() only runs mkdirSync, and mintId() starts again at r0001. The new run's third call is parked as r0003. Within 250 ms sweepReplies() finds the old r0003.reply.txt and resolves the new prompt with the previous run's answer. The pipeline parses it as a real model reply, so wrong content goes into a Foray without any error. The old rNNNN.request.* files also stay in queue/ with the same names as new requests, which misleads the human answerer. In done/, renameSync overwrites the earlier run's audit pair of the same id.",
  "evidence": "createRelay: `fs.mkdirSync(queueDir, { recursive: true }); ... let seq = 0;` / `function mintId() { seq += 1; return `r${String(seq).padStart(4, \"0\")}`; }` / sweepReplies: `const entry = pending.get(id); if (!entry || entry.answered) continue; ... answer(id, payload);`. Reproduced on origin/main: I seeded queue/r0001.reply.txt with 'STALE ANSWER FROM LAST RUN', then createRelay + park + sweepReplies printed `r0001 [{\"type\":\"text\",\"text\":\"STALE ANSWER FROM LAST RUN\\n\"}]`. Related: an idempotency or `x-request-id` header value is used directly as a file name (queueFile(id, ...)), with no sanitising, so `../` in it writes outside queue/.",
  "fix_sketch": "Make ids unique per process, e.g. `r${runStamp}-${seq}` where runStamp = Date.now().toString(36) or a random 6-char string. Alternatively, at createRelay, move any leftover queue/* into done/stale-<ts>/ before listening. Also sanitise header-derived ids to [A-Za-z0-9_-] (or hash them) before using them as file names. Add a test that seeds a stale reply file and asserts that a new park is not answered by it.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I checked this against origin/main tools/generation/relay.mjs and it holds.\n\n- **The code:** createRelay (lines 308-321) only runs mkdirSync on queue/ and done/ and sets `seq = 0`. mintId (327-330) returns r0001, r0002 and so on, so ids start again at r0001 in every process. Nothing in createRelay, listen() (651-666) or close() (668-672) sweeps or clears queue/.\n- **How a stale file gets picked up:** sweepReplies (514-537) takes the id from any `<id>.reply.txt/.json` in queue/ and answers the matching pending entry. It never checks that the file was written after the entry was parked.\n- **The only clearing path:** reset() (491-507) clears queue/, but only when someone sends POST /reset. start-run.mjs never calls it. It builds the relay, calls listen and later close, and does nothing to the queue.\n- **Not deliberate:** I found nothing in DECISIONS.md or the I-xx/F-xx notes that makes this intentional. I-23 is about the in-memory map, and I-10 is about dedupe within one run.\n- **Reproduced:** I seeded rd/queue/r0001.reply.txt with 'STALE', then called createRelay, park and sweepReplies. The new request r0001 resolved with `[{\"type\":\"text\",\"text\":\"STALE\"}]`.\n\n**What the scenario needs:** a leftover reply file. That happens if an answerer writes a reply after the relay or driver has died, or if a crash lands between the reply being written and the sweep. Human-paced answering makes that plausible: the run log's I-15 records the harness killing the background shell of a run while requests were parked. Leftover .request.* files after a crash are near-certain and will mislead the answerer. The overwrite of same-id audit pairs in done/ is also real.\n\n**The header-id path-traversal side note:** also real, but the relay listens only on 127.0.0.1 and the SDK sends no such header today.\n\n**Why medium rather than high:** it needs a crash or abandoned run plus a late or unswept reply, and it does not happen on a normal clean run. When it does happen, though, the result is silent wrong content with no error.",
  "merged_ids": [],
  "lane": "L5-generation"
}
```

## data-tools-2: Nightly resolve fuzzy-matches a new episode to a different (older) iTunes track, and the episode is then dropped for good

**confirmed** · verifier severity **medium** (finder: high) · data-tools · correctness · `tools/refresh/resolve.mjs:71` · L8-data-tools

```json
{
  "id": "data-tools-2",
  "area": "data-tools",
  "category": "correctness",
  "title": "Nightly resolve fuzzy-matches a new episode to a different (older) iTunes track, and the episode is then dropped for good",
  "file": "tools/refresh/resolve.mjs",
  "line": 71,
  "severity": "high",
  "scenario": "The nightly scan picks up a fresh episode, e.g. 'How to Build a Startup, Part 3', often within hours of publication, before the iTunes lookup has indexed it. matchTrack finds no exact match, and its substring and 60%-word-overlap fallbacks then match 'How to Build a Startup, Part 2'. The words longer than 3 chars, {build, startup, part}, overlap 100%, and 'Episode 12' likewise matches 'Episode 120' by substring. If Part 2 is already in the pool, the new episode is dropped as `dup trackId`. If it is not, it is published with the wrong apple_track_id/apple_episode_url, and with the wrong iTunes audio when RSS has none. scan.mjs has already added the guid to refresh-state `seen` (scan.mjs:152), so the dropped episode is never scanned again, and the loss is silent apart from one 'drop:' log line. A transient iTunes outage has the same effect for a whole show: lookup() swallows all 3 failures and returns [], so every episode of that show is dropped as 'no trackId match' and marked seen.",
  "evidence": "`hit = eps.find((e) => { const ne = norm(e.trackName); return ne && (ne.includes(nt) || nt.includes(ne)); });` ... `return bestScore >= 0.6 ? best : null;` then `if (existingTrackIds.has(trackId) || seenTrackThisRun.has(trackId)) { dropped.push({... reason: `dup trackId ${trackId}` }); continue; }`; lookup(): `catch (e) { /* retry */ } ... let data = { results: [] };`; scan.mjs:152 `seen.add(guid);` runs before resolve.",
  "fix_sketch": "Match on something that cannot collide. Prefer the RSS guid or enclosure URL against iTunes `episodeGuid`/`episodeUrl` (the lookup returns both), and only then an exact normalised title. Drop the substring and overlap fallbacks, or require a matching release date (±1 day) for them. When the lookup fails or the episode is not yet indexed, carry the item forward rather than dropping it: either do not mark it seen in scan, or have resolve write a `retry` list that scan re-emits the next night. Make a failed lookup (non-200 x3) fatal or reported per show, not the same as 'no match'.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the code at origin/main and it does what the finding says. matchTrack in tools/refresh/resolve.mjs (lines 71-90) tries an exact normalised title first, then a two-way substring match, then a word-overlap score (words longer than 3 chars, threshold >= 0.6). Take 'How to Build a Startup, Part 3' against 'How to Build a Startup, Part 2': norm gives 'how to build a startup part 3' and '... part 2'. Neither is a substring of the other, but the words {build, startup, part} overlap 3/3 = 1.0, so the older track is returned. 'episode 12' is a substring of 'episode 120', so that pair matches too. The lookup uses limit=25, so recent earlier parts are usually in the candidate list.\n\nWhat happens after a wrong match:\n- If that trackId is already in discover/session, the new episode is dropped as `dup trackId` (lines 110-112).\n- If not, it is published with the wrong apple_track_id and apple_episode_url. When RSS has no audio, it also gets the wrong iTunes audio (lines 137-141).\n\nlookup() (lines 55-69) swallows non-OK responses and exceptions three times, then returns []. An iTunes outage therefore turns into 'no trackId match' for every episode of that show.\n\nNothing carries dropped episodes forward:\n- scan.mjs:152 runs `seen.add(guid)` for every pending item.\n- nightly-refresh.yml runs scan (line 231), then resolve (line 237), then put_file refresh-state.json (line 301) whatever resolve dropped.\n- scan skips seen guids (scan.mjs:122).\nSo dropped episodes are never re-scanned, and the only trace is the 'drop:' log line.\n\nNothing marks this as deliberate. docs/adr/0002-episode-identity-and-dedup.md takes the opposite position for dedup: it says to require the whole normalised title to match, \"not a fuzzy/partial match — 'Part 1' vs 'Part 2' normalize differently and won't collide\". resolve.mjs breaks that rule. DECISIONS.md has no entry covering the fuzzy fallback.\n\nI rate it medium rather than high. It is a quality and completeness defect in the nightly discovery pipeline: episodes go missing or link to the wrong track. There is no crash, security issue, or user-data loss, the drop is logged, and most feeds supply RSS audio, which limits the wrong-audio case.",
  "merged_ids": [],
  "lane": "L8-data-tools"
}
```

## data-tools-3: Corpus fetcher throws out of fetchUrl when a body read times out mid-stream, aborting the whole ingest run

**confirmed** · verifier severity **medium** (finder: medium) · data-tools · error-handling · `tools/corpus/fetcher.mjs:210` · L8-data-tools

```json
{
  "id": "data-tools-3",
  "area": "data-tools",
  "category": "error-handling",
  "title": "Corpus fetcher throws out of fetchUrl when a body read times out mid-stream, aborting the whole ingest run",
  "file": "tools/corpus/fetcher.mjs",
  "line": 210,
  "severity": "medium",
  "scenario": "A research source is a large PDF, up to the 50 MB cap, on a slow host, or a server stalls after sending headers. The 30 s AbortSignal.timeout passed to fetch also covers reading the body. reader.read() (or res.arrayBuffer()) rejects with a TimeoutError, which is outside the retry try/catch, so fetchUrl throws even though its contract says it never throws for HTTP-level failures. ingestSource does not catch it, ingestMany loops with no try, and corpus.mjs main() fails, so every remaining source in the batch is skipped. No `documents` row records the failure. The robots.txt fetch has the same problem: `await res.text()` is inside robotsFor's try, but a hang there is also only bounded by the same signal.",
  "evidence": "`signal: AbortSignal.timeout(attemptTimeoutMs)` in rawGet; the body loop `for (;;) { const { done, value } = await reader.read(); ... }` sits after the attempt loop, with no try around it; ingest.mjs `for (const source of sources) { const r = await ingestSource(db, fetcher, source, opts); ... }`.",
  "fix_sketch": "Wrap the body read (both branches) in try/catch and return `{ ok:false, status: res.status, notes:[...notes, `body read failed: ${err.name}`] }`, or treat it as a retryable attempt. Use a separate, longer body timeout that scales with content-length. Also have ingestMany catch per source and record a failed documents row, so one bad source cannot end the run.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the code at origin/main and the finding holds. In tools/corpus/fetcher.mjs, rawGet passes `signal: AbortSignal.timeout(attemptTimeoutMs)` (30 s) to fetch. The retry try/catch (lines 157-174) only wraps getting the response headers. The body read happens later, outside any try: the `reader.read()` loop at lines 210-225 and `res.arrayBuffer()` at line 231. The docblock at lines 128-133 promises fetchUrl \"Never throws for HTTP-level failures\". I ran a small Node test in which a local server sends headers and then stalls. With fetch plus AbortSignal.timeout(500), getReader().read() rejects with TimeoutError, so the signal does cover the body read. A connection reset partway through the body would also reject in the same place. Nothing upstream catches it. ingestSource (ingest.mjs line 129) awaits fetcher.fetchUrl with no try and claims it \"never throws for fetch-level failures\". ingestMany (lines 381-389) loops with no try/catch. corpus.mjs's ingest case awaits ingestMany directly, and only the top-level main().catch catches the error: it logs `corpus: <msg>` and sets exitCode=1. So the rest of the batch is skipped and no failed documents row is written for that source. I found no comment or DECISIONS.md entry saying this is deliberate. The robots.txt part of the finding is only a minor side note: robotsFor wraps res.text() in a try, so a timeout there becomes robots=null (allow everything) rather than a crash. Severity is medium. This is an offline, re-runnable research tool and nothing is corrupted: sources already done keep their rows, and on a re-run the unchanged-hash check skips them. But one slow or stalled large PDF (up to the 50 MB cap cannot always be read within 30 s) ends the whole ingest run and does not record the failure.",
  "merged_ids": [],
  "lane": "L8-data-tools"
}
```

## data-tools-4: fetch-audio's resume identity check never runs: identity and bytes_expected are only written after a download completes

**confirmed** · verifier severity **medium** (finder: medium) · data-tools · correctness · `tools/transcribe/fetch-audio.mjs:690` · L8-data-tools

```json
{
  "id": "data-tools-4",
  "area": "data-tools",
  "category": "correctness",
  "title": "fetch-audio's resume identity check never runs: identity and bytes_expected are only written after a download completes",
  "file": "tools/transcribe/fetch-audio.mjs",
  "line": 690,
  "severity": "medium",
  "scenario": "A download is interrupted: timeout, network error or crash. The checkpoint gets only `{status:'failed', url, error}` (line 737/744). identity and bytes_expected are written only on 'complete' (727-732), and a completed file never resumes. prev is also loaded once before the retry loop. So every real resume calls verifyResumeResponse with prevIdentity=null and expectedBytes=null. For non-DAI items the check passes any 206 from the right offset, so a file that changed between attempts (re-encoded, re-stitched by an ad host not flagged dai_suspected, different ETag) is spliced into audio with a seam. Preventing that is the stated purpose of corner case #2. For dai_suspected items every resume is refused and the download restarts from 0.",
  "evidence": "`const prev = (await loadCheckpoint(checkpointPath)).episodes[item.id] || null;` (627, outside the loop); `resumePlan({ partialBytes: await fileSize(part), expectedBytes: prev?.bytes_expected ?? null })`; `prevIdentity: prev?.identity ?? null`; identity is persisted only in the success path `updateCheckpoint(item.id, { status: \"complete\", ..., identity, bytes_expected: written, ...})`.",
  "fix_sketch": "Write `{status:'partial', identity, bytes_expected: total}` to the checkpoint as soon as the first response headers are accepted, before streaming. Re-read the checkpoint entry at the top of each loop iteration instead of using the stale `prev`. Add a test: interrupt, then resume against a server whose ETag changed, and expect a restart.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main:tools/transcribe/fetch-audio.mjs and the finding holds. `prev` is loaded once before the retry loop. In fetchEpisode (~line 627) `prev = (await loadCheckpoint(...)).episodes[item.id]` runs outside the `for(;;)` loop, and the loop only reads it through `prev?.bytes_expected` (resumePlan, line 654) and `prev?.identity` (verifyResumeResponse, line 695). There are only two kinds of checkpoint write. The success path (727-732) writes identity and bytes_expected together with status \"complete\", and a completed file returns \"cached\" and never resumes. The failure paths write `{status:\"failed\", url, error, bump_attempt}` and nothing more. No write happens when headers are accepted or partway through a stream. updateCheckpoint merges against disk, but that does not help, because nothing ever writes identity for an in-progress file.\n\nSo both kinds of resume run with prevIdentity=null and expectedBytes=null:\n- A resume inside the same process, after a stream error or timeout: the generic catch backs off, retries, and the .part file is still there.\n- A resume in a new process after a crash: the entry is missing or has status \"failed\".\n\nIn verifyResumeResponse (408-424), the identity-mismatch check needs prevIdentity to be set, so for non-DAI items any 206 from the right offset is accepted and spliced, whatever the ETag. For dai_suspected items the strict branch always returns restart. That is safe but means DAI items never really resume.\n\nThe header comment for corner case #2 says the tool compares against \"what the checkpoint recorded\", and nothing in DECISIONS.md or elsewhere makes this deliberate. One small exception: an entry that was discarded after an earlier successful fetch still carries the old identity, because the merge keeps it. That is edge behaviour, not a design. The stated guard in corner case #2 never runs, but the harm is limited: a seamed splice needs a non-DAI host that changes the file between attempts, which is uncommon, and on DAI hosts the only cost is wasted bandwidth. Medium is the right severity.",
  "merged_ids": [],
  "lane": "L8-data-tools"
}
```

## data-tools-5: fetch-audio's 120 s abort timer covers the whole body stream, so long episodes cannot finish and DAI episodes never do

**confirmed** · verifier severity **medium** (finder: medium) · data-tools · correctness · `tools/transcribe/fetch-audio.mjs:664` · L8-data-tools

```json
{
  "id": "data-tools-5",
  "area": "data-tools",
  "category": "correctness",
  "title": "fetch-audio's 120 s abort timer covers the whole body stream, so long episodes cannot finish and DAI episodes never do",
  "file": "tools/transcribe/fetch-audio.mjs",
  "line": 664,
  "severity": "medium",
  "scenario": "`setTimeout(() => ctl.abort(), timeoutMs)` is armed before fetch and cleared only in finally, after pipeline() has streamed the whole file. A 170 MB three-hour episode needs about 1.4 MB/s to finish within 120 s. On a slower CDN or connection every attempt aborts mid-stream. Non-DAI items crawl forward through resume across MAX_ATTEMPTS=5, and fail once the bytes need more than 5×120 s. dai_suspected items restart from 0 on every resume (see the identity finding), so they can never complete, and the run reports HttpError after about 10 minutes of re-downloading the same bytes.",
  "evidence": "`const timer = setTimeout(() => ctl.abort(), timeoutMs);` ... `signal: ctl.signal` ... `await pipeline(Readable.fromWeb(res.body), meter, sink);` ... `finally { clearTimeout(timer); }`; the default `timeoutMs = 120_000`.",
  "fix_sketch": "Use the timeout for time-to-headers only: clear it once `res` arrives. Replace it with an idle or stall timer that resets on every chunk in `meter` (for example, abort after 30 s without bytes).",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main:tools/transcribe/fetch-audio.mjs (lines 607-755) and the finding holds. Line 664 arms `setTimeout(() => ctl.abort(), timeoutMs)` before `gate.run(host, () => fetch(..., { signal: ctl.signal }))`. The same controller governs the body read, and `ctl.signal` also aborts the body stream of a fetch in progress. The timer is cleared only in the catch and finally blocks, which run after `await pipeline(Readable.fromWeb(res.body), meter, sink)` and the rename/checkpoint. So the 120 s budget covers queueing in the host gate, getting the headers, and streaming the whole body. The default `timeoutMs = 120_000` is never overridden: neither the CLI main() nor any other caller I grepped passes timeoutMs. No comment or docs/DECISIONS.md entry explains the choice.\n\nWhen the timer fires, the resulting AbortError is not a FetchAudioError, so the generic branch handles it. It retries with backoff until `attempt >= MAX_ATTEMPTS (5)`, then throws HttpError, which confirms the \"HttpError after repeated attempts\" outcome.\n\nThe DAI claim also holds. `prev` is loaded from the checkpoint once, before the loop. `identity` is written to the checkpoint only on the success path, so a partial from an aborted attempt never has a recorded prevIdentity. On the next attempt, resumePlan returns \"resume\". verifyResumeResponse then hits `if (dai && !(prevIdentity && identity && prevIdentity === identity)) return { restart: true }`, deletes the .part and restarts from 0. A dai_suspected episode therefore has to download in a single ≤120 s window or it never completes. A non-DAI item can crawl forward by resuming, but only across 5 windows of 120 s.\n\nThere is an extra point the finding does not mention: time spent waiting in the HostGate queue also counts against the timer, which makes the problem worse when several episodes share one host.\n\nI kept severity at medium. This is an offline tool, not a user-facing path, and the failure is loud (named HttpError, checkpoint marked failed), not silent corruption. But on ordinary bandwidth it reliably blocks long episodes and DAI-hosted ones.",
  "merged_ids": [],
  "lane": "L8-data-tools"
}
```

## data-tools-6: 'Two bytes, no audio' probes download the whole episode when a host ignores Range

**confirmed** · verifier severity **low** (finder: medium) · data-tools · resource-leak · `tools/foray/verify-source-audio.mjs:76` · L8-data-tools

```json
{
  "id": "data-tools-6",
  "area": "data-tools",
  "category": "resource-leak",
  "title": "'Two bytes, no audio' probes download the whole episode when a host ignores Range",
  "file": "tools/foray/verify-source-audio.mjs",
  "line": 76,
  "severity": "medium",
  "scenario": "verify-source-audio sends `Range: bytes=0-1`. If a CDN, redirector or edge ignores Range and answers 200 with the full file, `await res.arrayBuffer()` downloads the entire episode, tens to hundreds of MB, before the script reports 'not 206'. That breaks the header's 'downloads two bytes per episode and no audio (product principle #3)'. decode-compare.mjs:496 does the same for its ranged cells (`if (ranged) await res.arrayBuffer()`) without checking that the response was actually 206. The siblings ad-inflation.mjs:270/293 and dai.mjs:176 correctly use res.body.cancel().",
  "evidence": "verify-source-audio.mjs:76 `await res.arrayBuffer().catch(() => {});` runs before the `res.status !== 206` check; decode-compare.mjs:496 `if (ranged) await res.arrayBuffer().catch(() => {}); else res.body?.cancel?.()...`.",
  "fix_sketch": "Drain only when `res.status === 206`, and otherwise call `res.body?.cancel()`. Or always cancel: a 2-byte body is not worth reading. Put this in one shared helper (e.g. politeness.mjs `discardBody(res)`) so the four probe tools cannot drift apart again.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read both files at origin/main and the finding holds.\n\nIn tools/foray/verify-source-audio.mjs, around lines 74-77, the script runs `await res.arrayBuffer().catch(() => {})` (commented \"Drain so the socket closes\") on every response. That happens before the `res.status !== 206` check. The file's own header expects this case: \"200 means the host ignored Range and is about to hand a player the whole file\". So on exactly the failure it is built to detect, it downloads the whole episode first. That contradicts its claim \"It downloads two bytes per episode and no audio (product principle #3)\".\n\nThe finding points at tools/foray/decode-compare.mjs, but that path does not exist. The code is at tools/transcribe/decode-compare.mjs, around line 496: `if (ranged) await res.arrayBuffer().catch(() => {}); else res.body?.cancel?.()...`. The ranged cells are drained without checking for 206, yet the doc comment on probeGrid says \"NOTHING HERE READS A BODY... this mode costs the four range bytes and no audio\". So the same flaw exists there, in both identity arms.\n\nThe sibling tools do cancel the body: tools/transcribe/ad-inflation.mjs lines 270 and 293 and tools/refresh/dai.mjs line 176. politeness.mjs has no shared discard helper. I found nothing in DECISIONS.md or in any comment that makes this deliberate, and nothing handles it elsewhere.\n\nI set severity to low, not medium. Both are manual, never-CI tools (the header says so), so the cost is wasted bandwidth and time per non-compliant host during an operator run. They produce no wrong result: the 200 is still reported as a FAIL. The fix sketch (cancel unless the response is 206, or always cancel, in one shared helper) is sound. No test run was needed.",
  "merged_ids": [],
  "lane": "L8-data-tools"
}
```

## data-tools-8: A driver killed by a signal is reported as success (exit code null becomes 0)

**confirmed** · verifier severity **low** (finder: low) · data-tools · error-handling · `tools/generation/start-run.mjs:183` · L5-generation

```json
{
  "id": "data-tools-8",
  "area": "data-tools",
  "category": "error-handling",
  "title": "A driver killed by a signal is reported as success (exit code null becomes 0)",
  "file": "tools/generation/start-run.mjs",
  "line": 183,
  "severity": "low",
  "scenario": "If the generation driver or the transcript warmer is killed by a signal (OOM killer, Task Manager, SIGKILL, or SIGINT forwarded by the launcher's own handler), the 'exit' event gives code=null and signal='SIGKILL'. Both launchers set `process.exitCode = code ?? 0`, so the wrapper exits 0 and prints 'driver exited null'. A caller that gates on the exit code, which warm-transcript-index documents explicitly ('passed through so a caller can gate a run on it'), treats the aborted run as clean.",
  "evidence": "start-run.mjs:180-183 `const code = await new Promise((resolve) => child.on(\"exit\", resolve)); ... process.exitCode = code ?? 0;`; warm-transcript-index.mjs:75-76, same pattern.",
  "fix_sketch": "Take both values: `child.on('exit', (code, signal) => resolve({code, signal}))`. Set `process.exitCode = code ?? (signal ? 128 + (os.constants.signals[signal] ?? 1) : 1)` and log the signal.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read both files at origin/main and the finding holds. In tools/generation/start-run.mjs (lines 180-183), the code resolves the child's 'exit' event with only its first argument (`child.on(\"exit\", resolve)`). It logs `driver exited ${code}` and sets `process.exitCode = code ?? 0`. In tools/generation/warm-transcript-index.mjs (around lines 72-76) the pattern is the same: `process.exitCode = code ?? 0`. The comment right above that line says the warmer's exit code is \"passed through so a caller can gate a run on it\", so the null-to-0 conversion goes against the file's own stated purpose.\n\nNode's 'exit' event passes code=null and a signal name whenever a signal ends the child. That happens with an external SIGKILL, the OOM killer, or Task Manager. It also happens with the launcher's own stop() handler, which calls child.kill(\"SIGINT\"); on Windows that kill is forceful and is reported as a signal with no exit code. So an aborted driver or warmer produces wrapper exit status 0 and the log line \"driver exited null\".\n\nI found no comment, and no entry in docs/DECISIONS.md, saying that `?? 0` is intentional, and nothing else handles the signal case. I kept severity low. These are manual run commands. The logged \"null\" is visible to a person running them by hand. The only practical harm is to a script or CI step that gates on the exit code, which the warmer's comment explicitly expects. The suggested fix is correct: capture the signal and map it to 128 + the signal number, or to 1 when the number is unknown.",
  "merged_ids": [],
  "lane": "L5-generation"
}
```

## data-tools-9: SizeOverrun/DiskBudget failures leave the .part file on disk while the ledger releases its bytes

**confirmed** · verifier severity **low** (finder: low) · data-tools · resource-leak · `tools/transcribe/fetch-audio.mjs:736` · L8-data-tools

```json
{
  "id": "data-tools-9",
  "area": "data-tools",
  "category": "resource-leak",
  "title": "SizeOverrun/DiskBudget failures leave the .part file on disk while the ledger releases its bytes",
  "file": "tools/transcribe/fetch-audio.mjs",
  "line": 736,
  "severity": "low",
  "scenario": "If a download goes past its ceiling (SizeOverrunError) or resize() throws DiskBudgetError, the catch updates the checkpoint and rethrows, but the .part (up to 1.5× the estimate) stays in audio-cache/. The outer finally calls ledger.release(item.id), so the resident cap that 'bounds the damage when cleanup stops being called' no longer counts those bytes. A run over many mis-declared episodes can leave far more than --max-resident-gb on disk. ResidentLedger.resize's comment says 'the caller aborts and deletes it', but nothing deletes it.",
  "evidence": "`if (e instanceof FetchAudioError) { await updateCheckpoint(item.id, { status: \"failed\", ... }); throw e; }` with no rm(part); `} finally { ledger.release(item.id); }`.",
  "fix_sketch": "On SizeOverrunError or DiskBudgetError, `await rm(part, { force: true })` before rethrowing, and mark the checkpoint `discarded`. Or keep the ledger reservation held until cleanup() runs.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "Checked tools/transcribe/fetch-audio.mjs at origin/main, lines 600-755. The finding is correct.\n- The meter generator throws SizeOverrunError once `written > ceiling`. The ceiling is max(reserved, total) × SIZE_OVERRUN_FACTOR, and the meter has already written up to that much to `part`.\n- The inner catch sees a FetchAudioError, calls `updateCheckpoint(... status: \"failed\" ...)` and rethrows. It never calls `rm(part)`.\n- The outer `finally { ledger.release(item.id); }` then drops the reservation. The ledger no longer counts bytes that are still on disk.\n- ResidentLedger.resize's doc comment says \"the caller aborts and deletes it\", but nothing in fetchEpisode or fetchAll deletes anything on these paths.\n- docs/DECISIONS.md and the tests have nothing that makes this deliberate. The only .part test covers the path suffix.\n\nTwo things soften it:\n1. The DiskBudgetError half is weaker than stated. resize() runs before createWriteStream, so a fresh download has no .part yet when it throws. A .part only survives on a resume attempt, and then it is the earlier partial.\n2. cleanup(episodeId) does delete the partial: it adds the target .part path from the url or the checkpoint entry. So a caller that runs cleanup on failed episodes gets the space back. But fetchAll only returns failed ids and never calls cleanup. The design pitch says the resident cap bounds the damage \"when cleanup stops being called\", and it does not cover these orphaned partials.\n\nA failed checkpoint also stores no bytes_expected. A later run therefore resumes a runaway partial instead of discarding it.\n\nReal disk-growth risk is modest: each leak is bounded to about 1.5× one episode and needs mis-declared feeds. Low severity.",
  "merged_ids": [],
  "lane": "L8-data-tools"
}
```

## data-tools-10: HostGate's minimum gap is not enforced between concurrent slots on the same host

**confirmed** · verifier severity **low** (finder: low) · data-tools · race-condition · `tools/transcribe/fetch-audio.mjs:479` · L8-data-tools

```json
{
  "id": "data-tools-10",
  "area": "data-tools",
  "category": "race-condition",
  "title": "HostGate's minimum gap is not enforced between concurrent slots on the same host",
  "file": "tools/transcribe/fetch-audio.mjs",
  "line": 479,
  "severity": "low",
  "scenario": "With perHost=2 (the default), two queued episodes on one CDN both pass #acquire together. Both read the same lastStart before either sets it, so both compute the same gap, sleep the same amount and start in the same millisecond. The same happens whenever two slots free at once. That is the burst corner case #8 says the gap prevents, and the unit test runs only perHost:1.",
  "evidence": "`const gap = this.minGapMs - (Date.now() - (this.lastStart.get(key) ?? -Infinity)); if (gap > 0) await sleep(gap); this.lastStart.set(key, Date.now());` The read and the write are separated by an await.",
  "fix_sketch": "Reserve the slot at the moment of the read, as politeness.awaitHostSlot does: `const at = Math.max(now, next.get(key) ?? 0); next.set(key, at + minGapMs); await sleep(at - now)`. Or reuse awaitHostSlot directly. Add a perHost:2 spacing test.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main:tools/transcribe/fetch-audio.mjs and the finding holds.\n\n- **The code does what the finding says.** In HostGate.run (lines 476-485), the gate reads `lastStart`, may `await sleep(gap)`, and only then calls `lastStart.set(key, Date.now())`. Nothing reserves the slot when the read happens.\n- **It happens on every normal run.** fetchAll (line 769) starts all items at once with `Promise.allSettled(items.map(fetchEpisode))`. DEFAULT_PER_HOST is 2 (line 114). So the first two same-host items both get past #acquire, which has no await when under the limit. Both read `lastStart` as undefined, so the gap is -Infinity and neither sleeps. Both set `lastStart` and start in the same tick. Any run with two or more episodes on one CDN therefore opens with two simultaneous requests.\n- **The mid-run case also holds.** If two slots free close together, both waiters can read the same `lastStart` and wake together.\n- **It is not deliberate.** The header comment (lines 27-28) and the class docstring (lines 463-466) say the gap applies \"between request starts\" on a host, to stop a burst. docs/DECISIONS.md does not mention it (git grep found no match). The fetchAll docstring says \"Sequential per host by construction\", but that is false when perHost=2.\n- **The test gap is real.** The gap test at fetch-audio.test.mjs:496 uses perHost:1. The perHost:2 test at line 472 sets minGapMs:0.\n\nSeverity stays low. The burst is limited to perHost requests (2 by default), and every later start is still spaced to within about the gap. The practical harm is one pair of simultaneous requests per host per run, not a burst of 40. The suggested fix is sound: reserve the next start time at the moment of the read, or reuse politeness.awaitHostSlot, which ad-inflation.mjs says is the one shared per-host gate.\n\nI did not run the one allowed test; reading the code was conclusive.",
  "merged_ids": [],
  "lane": "L8-data-tools"
}
```

## data-tools-11: backfill-audio / classify-dai write discover.json (and the DAI cache) before checking the session.json text patch, which can then throw

**confirmed** · verifier severity **low** (finder: low) · data-tools · error-handling · `tools/refresh/backfill-audio.mjs:318` · L8-data-tools

```json
{
  "id": "data-tools-11",
  "area": "data-tools",
  "category": "error-handling",
  "title": "backfill-audio / classify-dai write discover.json (and the DAI cache) before checking the session.json text patch, which can then throw",
  "file": "tools/refresh/backfill-audio.mjs",
  "line": 318,
  "severity": "low",
  "scenario": "Both scripts write data/discover.json first, then patch session.json with regexes and re-verify the result. If the verification throws (a block the regex could not reach, or classify-dai's `reparsed.episodes[id].dai_suspected !== ...` for a block with no audio_bytes), the run ends having rewritten discover.json and dai-classification.json but not session.json. The two client documents then disagree. Separately, the patched values are inserted with `txt.replace(re, `$1${fields}`)`, so a `$&`, `$'` or `$1` inside an audio_url is read as a replacement pattern. The re-verify catches that, but only by throwing after the partial write.",
  "evidence": "backfill-audio.mjs:317-335 `writeFileSync(join(ROOT, \"data\", \"discover.json\"), ...); ... const reparsed = JSON.parse(txt); for (...) { if (...) throw new Error(`session patch mismatch ...`) } ... writeFileSync(sessionPath, txt);`; classify-dai.mjs:133-169 has the same order.",
  "fix_sketch": "Compute and verify the patched session text first, and only then write all files. Use a replacer function, `txt.replace(re, (m, g1) => g1 + fields)`, so `$` sequences in URLs are literal.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The write order is as the finding says at origin/main. In tools/refresh/backfill-audio.mjs (lines 316-335), the non-dry branch writes data/discover.json first. Only after that does it run patchSessionText, JSON.parse the result and loop over the episodes, throwing \"session patch mismatch\" before session.json is written. tools/refresh/classify-dai.mjs (the non-DRY block around lines 133-169) is worse: it writes dai-classification.json and discover.json, then does the session text patch and the throwing check. The patches use `txt.replace(re, `$1${fields}`)` / `$1${e.dai_suspected}` with a template string, so a `$` pattern inside audio_url would be expanded. That `$` risk is theoretical, and the re-verify catches it anyway.\n\nThe throw can actually happen with today's data. Every session.json block is flat, with no nested braces, and already has audio_url, audio_bytes and dai_suspected, so the regexes can reach every block. The trigger is the documented `--force` mode (\"re-resolve everything\", line 7), which makes every session episode a target (line 133) and can give it a new audio_url. Several URLs are tracking-prefixed with changing query strings, for example mbmbam-821's claritaspod/podtrac-style chain. patchSessionText then skips any block that already has \"audio_url\" (the `already` guard, line 299), so the new value never reaches the text. The verify loop then throws a mismatch after discover.json has already been rewritten, which leaves discover.json and session.json disagreeing. The same thing happens without --force if a session block ever lacks duration_min or gains a nested object, because a missed id also fails the audio_url check before the WARN line runs.\n\nNothing in the code comments treats writing discover.json before this check as intended. The comment \"Never write a session.json we cannot prove...\" only protects session.json. I found no handling for this elsewhere.\n\nSeverity is low. These are manually run refresh tools, the damage is an uncommitted working-tree inconsistency that git diff shows and git checkout undoes, and nothing is corrupted. The fix sketch is right: build and verify the session text before any write, and use a replacer function.",
  "merged_ids": [],
  "lane": "L8-data-tools"
}
```

## data-tools-12: Startup launcher for the events server runs the stale commute-curator checkout, not this repo

**confirmed** · verifier severity **low** (finder: low) · data-tools · tooling · `scripts/events-server.vbs:4` · L5-generation

```json
{
  "id": "data-tools-12",
  "area": "data-tools",
  "category": "tooling",
  "title": "Startup launcher for the events server runs the stale commute-curator checkout, not this repo",
  "file": "scripts/events-server.vbs",
  "line": 4,
  "severity": "low",
  "scenario": "The Startup-folder launcher, whose installed copy ForayEventsServer.vbs is identical to the repo copy, does `cd` into '...\\Vibe Coding\\commute-curator', which is the pre-rename checkout and still exists on disk. At every login it runs that tree's tools/events-server.mjs and writes events to commute-curator/data-local/events. Changes to foray's tools/events-server.mjs never take effect, and path-policy's reason for denying that file ('scripts/events-server.vbs runs `node tools/events-server.mjs` at every login') is not true of this repo's copy. The listener also shares port 8787 with the generation relay's DEFAULT_PORT: on this machine the relay's 127.0.0.1:8787 bind succeeds next to the events server's 0.0.0.0:8787 (verified). So a run starts without error, and any tool that probes 127.0.0.1:8787 gets whichever server happens to be up.",
  "evidence": "`shell.CurrentDirectory = \"C:\\Users\\wjduv\\Desktop\\Vibe Coding\\commute-curator\"`; events-server.mjs `const PORT = 8787;`; relay.mjs `export const DEFAULT_PORT = 8787;`. netstat shows node PID 17328 on 0.0.0.0:8787 and [::]:8787, and a test bind of 127.0.0.1:8787 printed 'bound'.",
  "fix_sketch": "Derive the directory from the script's own location (WScript.ScriptFullName, then the parent of scripts/), re-install the Startup copy, and move the relay to a different default port (e.g. 8788). scripts/nightly-refresh.cmd is the launcher for a now-disabled task (ForayNightlyRefresh is Disabled). Mark it as historical or delete it.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked every part of this against origin/main and the machine, and it holds.\n\n- **Hardcoded path:** line 4 of scripts/events-server.vbs at origin/main hardcodes `shell.CurrentDirectory = \"C:\\Users\\wjduv\\Desktop\\Vibe Coding\\commute-curator\"`. It then runs `node tools\\events-server.mjs`, with its log going to that tree's data-local.\n- **Installed copy:** the Startup-folder copy ForayEventsServer.vbs is identical to the repo copy once CRLF line endings are ignored.\n- **The commute-curator tree:** it exists. It is a separate clone of the same repo (JW-Incorporated/foray), sitting on the feature branch fix/vouch-collapses-cards, and its last commit is from 2026-09-03. Its tools/events-server.mjs and data-local/events both exist.\n- **Stale code at login:** changes merged to foray/main's tools/events-server.mjs will not run at login unless someone updates that stale clone. The file happens to be byte-identical today, so there is no divergence in behaviour yet.\n- **Path-policy comment:** the comment in path-policy.mjs (lines 94-99) and its test says the launcher runs this file \"in the checkout that also holds the root .env\". That is inaccurate for the foray checkout. The deny rule itself is still sensible as a precaution, so this is a misleading comment, not a security gap.\n- **Shared port:** tools/generation/relay.mjs line 168 has `export const DEFAULT_PORT = 8787`, and tools/events-server.mjs line 22 has `const PORT = 8787`, listening on all interfaces. netstat shows PID 17328 on 0.0.0.0:8787 and [::]:8787. I did not re-run the finding's test bind to 127.0.0.1:8787. It is plausible on Windows, and the relay port can be overridden with --port or RELAY_PORT.\n- **Deliberate?** Nothing in docs/DECISIONS.md or in any comment says this is intended.\n\nThe severity is low: this is a dev-workstation launcher, the two copies of the events server are currently the same code, and the port clash only matters when the relay runs with its default port.",
  "merged_ids": [],
  "lane": "L5-generation"
}
```

## data-tools-13: sweep-transcripts' entity decoder throws RangeError on an out-of-range numeric entity (a third, drifted decoder)

**confirmed** · verifier severity **low** (finder: low) · data-tools · duplicated-logic-drift · `tools/segments/sweep-transcripts.mjs:137` · L8-data-tools

```json
{
  "id": "data-tools-13",
  "area": "data-tools",
  "category": "duplicated-logic-drift",
  "title": "sweep-transcripts' entity decoder throws RangeError on an out-of-range numeric entity (a third, drifted decoder)",
  "file": "tools/segments/sweep-transcripts.mjs",
  "line": 137,
  "severity": "low",
  "scenario": "A feed attribute or tag containing `&#99999999;` or `&#x110000;` reaches String.fromCodePoint(code) with code > 0x10FFFF, which throws RangeError inside the replace callback. That feed's parse fails and its transcript URLs are lost for the sweep. The `#x?[0-9a-f]+` pattern also accepts hex digits in decimal entities (`&#12ab;` decodes as code 12). tools/refresh/entities.mjs (range-checked, control characters mapped to space) and transcript-normalize.mjs (try/catch) already solve this, so there are three decoders with three behaviours.",
  "evidence": "`const code = key[1] === \"x\" ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10); return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;`",
  "fix_sketch": "Import decodeEntities from tools/refresh/entities.mjs (dependency-free) in sweep-transcripts and transcript-normalize, and delete the local copies.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read the code at origin/main and the finding holds. In tools/segments/sweep-transcripts.mjs, line 137 runs `Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole` with no upper-bound check, and the regex `/&(#x?[0-9a-f]+|[a-z]+);/gi` puts no length limit on the digits. I ran node and confirmed that String.fromCodePoint(99999999) throws a RangeError. Nothing in parseFeed catches it: attrOf and textOf call decodeEntities directly, and parseFeed calls both. The per-show try/catch (around line 527) turns the error into SweepError(\"UNEXPECTED\"), so the show is marked status \"error\" and loses every episode and transcript URL, even though only one bad entity caused it. The show is also only retried with --retry-failed. The hex-in-decimal quirk is real too: `&#12ab;` matches, and parseInt(\"12ab\", 10) gives 12. Surrogate code points such as `&#xD800;` also slip through as lone surrogates. No comment and no DECISIONS.md entry covers this. The header comment only explains why the parser uses a regex. tools/refresh/entities.mjs does range-check (0..0x10FFFF, rejects surrogates, turns control characters into spaces). transcript-normalize.mjs has its own fromCodePoint path, so saying there are three different decoders is fair. I did not look at transcript-normalize's error handling closely. Severity stays low: a real feed has to contain a malformed out-of-range numeric entity, which is rare. The damage is limited to that one show in an offline research sweep, and it shows up as an error row rather than silent data loss.",
  "merged_ids": [],
  "lane": "L8-data-tools"
}
```

## data-tools-14: Shows import always emits changed.json = every show (previousNewest hard-coded {}), so scan --source index is a full scan plus an unbounded candidates list

**confirmed** · verifier severity **low** (finder: low) · data-tools · dead-code · `tools/shows/import-dump.mjs:348` · L8-data-tools

```json
{
  "id": "data-tools-14",
  "area": "data-tools",
  "category": "dead-code",
  "title": "Shows import always emits changed.json = every show (previousNewest hard-coded {}), so scan --source index is a full scan plus an unbounded candidates list",
  "file": "tools/shows/import-dump.mjs",
  "line": 348,
  "severity": "low",
  "scenario": "runPipeline is always called with `previousNewest = {}`, and the CI runner never keeps state, so buildChanged marks every canonical show as changed on every weekly release. Any `scan.mjs --source index` run then selects every curated feed ('changed since last release') and emits every uncurated top.json show as a curation candidate into resolved.json. The feature does nothing useful, and while it looks like it works it adds a large candidates payload to the digest. The nightly workflow does not pass --source index today, so the impact is latent.",
  "evidence": "`const previousNewest = {}; // TODO(S-11 follow-up wiring): read from prior manifest's per-id snapshot once persisted; empty means \"everything counts as changed\"`",
  "fix_sketch": "Fetch the prior release's per-id newest snapshot (publish one as a release asset) and pass it in. Until then, have buildChanged write `changed: null` / `baseline: false`, and have scan treat a missing baseline as 'index unavailable' so it does not act on it.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The core claim holds at origin/main, but two details are overstated. On tools/shows/import-dump.mjs:351, main() hard-codes `const previousNewest = {}`, with a TODO saying the real snapshot is not wired yet. buildChanged (tools/shows/shard-build.mjs:110-123) pushes every canonical id when `prev == null`, so every weekly release writes a changed.json that lists every show. The known-gap note in docs/DECISIONS.md (~line 2797, \"Not yet wired: previousNewest ... empty on every run today ... wiring the real diff is a small follow-up\") accepts this only as \"correct for a first run\". Nothing was wired later: run-and-publish.mjs never passes previousNewest. S-11's `scan.mjs --source index` (tools/refresh/README.md) was then built to rely on changed.json meaning \"changed since last release\", which it never does. As a result, selectChangedCuratedShows picks every mapped curated feed, so the index path is a full scan labelled `index: {used: true}`, and that label is misleading. Two corrections: (1) The candidates list is NOT unbounded. curationCandidates in tools/refresh/candidates.mjs defaults to `limit = 50`, and scan.mjs:88 calls it without overriding that, so the extra digest payload is at most 50 entries, which is noise rather than bloat. (2) The impact is latent. .github/workflows/nightly-refresh.yml:231 runs `scan.mjs --window-hours 48` and docs/agents/runner-prompts/foray-nightly.md:60 runs `--window-hours 72`, and neither passes `--source index`. The first-run behaviour is documented as deliberate. The fact that it continues forever, and that S-11 was built on top of it, is a real unwired gap that is still missing from main. Severity stays low: the feature does nothing when enabled, but nobody enables it today, and even if someone did, the fallback is equivalent to a full scan and not a missed scan.",
  "merged_ids": [],
  "lane": "L8-data-tools"
}
```

## data-tools-15: resolve.mjs dedups ids against the trackId set (dead check)

**confirmed** · verifier severity **low** (finder: low) · data-tools · dead-code · `tools/refresh/resolve.mjs:121` · L8-data-tools

```json
{
  "id": "data-tools-15",
  "area": "data-tools",
  "category": "dead-code",
  "title": "resolve.mjs dedups ids against the trackId set (dead check)",
  "file": "tools/refresh/resolve.mjs",
  "line": 121,
  "severity": "low",
  "scenario": "`seenTrackThisRun.has(id)` asks whether a slug id like 'pre--some-title' is in a set that only ever holds numeric trackIds, so it is always false. The intended within-run id dedup works only because `existingIds.add(id)` happens a line later. Anyone who later changes that line loses the id dedup without noticing.",
  "evidence": "`if (existingIds.has(id) || seenTrackThisRun.has(id)) { dropped.push({... reason: `dup id ${id}` }); continue; } existingIds.add(id); seenTrackThisRun.add(trackId);`",
  "fix_sketch": "Delete the `|| seenTrackThisRun.has(id)` clause, or keep a separate seenIdsThisRun set, so the check means what it says.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read tools/refresh/resolve.mjs at origin/main, around line 121. `seenTrackThisRun` is only ever filled by `seenTrackThisRun.add(trackId)`, where trackId is the numeric iTunes trackId. It is also checked against trackId a few lines earlier, in the dup-trackId guard. The id check `if (existingIds.has(id) || seenTrackThisRun.has(id))` asks whether a string slug of the form `${pre}--${slugify(title)}` is in that set. A string never equals a number in a Set, so that clause is always false. The within-run id dedup still works, but only because `existingIds.add(id)` runs right after the check, so a second episode with the same slug in the same run hits `existingIds.has(id)`. No comment in the code explains the clause, and nothing suggests it is deliberate. It looks like a copy of the trackId guard above it. Behaviour today is correct: no wrong output and no duplicate ids. So this is dead, misleading code and a trap for anyone who later edits that line, not a live bug. Severity is low.",
  "merged_ids": [],
  "lane": "L8-data-tools"
}
```

## tests-1: Playwright 'new deploy' specs never install a second generation: sw.js bytes never change, so re-register()/update() is a no-op and the tests pass whatever sw.js does

**confirmed** · verifier severity **medium** (finder: medium) · tests · test-cannot-fail · `test/playwright/tests/partial-cache-population.spec.js:60` · L4-web-platform

```json
{
  "id": "tests-1",
  "area": "tests",
  "category": "test-cannot-fail",
  "title": "Playwright 'new deploy' specs never install a second generation: sw.js bytes never change, so re-register()/update() is a no-op and the tests pass whatever sw.js does",
  "file": "test/playwright/tests/partial-cache-population.spec.js",
  "line": 60,
  "severity": "medium",
  "scenario": "Four specs simulate a second deploy by calling server.setFiles() for data/forays.json and then register('sw.js') or reg.update(): partial-cache-population.spec.js:60-63 (one failing file voids the install), module-load-timeout.spec.js:77 (a rejected module leaves the old pointer), offline-reload.spec.js:64-68 (a page pinned to a superseded generation) and worker-restart-mid-request.spec.js:26-31 (the retained gen-1 read after a worker kill). The fixture serves sw.js byte-for-byte unchanged (copy-sw.mjs copies it verbatim, BUILD_ID stays \"unstamped\", and server.mjs never rewrites it). Per the SW spec, register() on an existing registration with the same script URL resolves straight away without an update. reg.update() byte-compares sw.js and skips install when the bytes match. So gen 2 never installs: 'old pointer untouched' and 'gen-1 still readable' hold trivially. If sw.js stopped keeping the previous generation, or promoted a half-populated install, these tests would stay green.",
  "evidence": "sw.js:115-121 says it outright: \"a browser only re-runs `install()` ... when the fetched `sw.js` bytes differ ... a browser that sees identical bytes skips `install()` entirely\". harness.mjs startServer: `\"sw.js\": fixtureFile(\"sw.js\")` is static. partial-cache-population.spec.js:60-63: `server.setFiles({ \"data/forays.json\": ... }); server.failOn(\"player/client.js\"); await page.evaluate(() => navigator.serviceWorker.register(\"sw.js\").catch(() => {}));`. None of the specs checks that a new worker ever reached 'installing'.",
  "fix_sketch": "In server.mjs, serve sw.js with its BUILD_ID replaced by the current computeManifest(files).deploy_id (what stampBuild does in production), so every setFiles() changes the sw.js bytes. In each 'new deploy' spec, add a premise assertion that a second worker appeared (reg.installing/waiting non-null, or a statechange to 'redundant' for the failure cases). For the retention specs, also assert a foray-gen-<gen2> cache exists before reading gen 1.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the code on origin/main and the finding holds. harness.mjs startServer loads sw.js once with fixtureFile(\"sw.js\") and passes it in as a static entry. server.mjs serves it from the `files` map exactly as given: nothing rewrites BUILD_ID, and setFiles() only merges data/forays.json. copy-sw.mjs copies the repo sw.js as-is, so BUILD_ID stays \"unstamped\".\n\nsw.js:115-134 says a browser only re-runs install() when the sw.js bytes change, and that identical bytes mean install() is skipped. That is also what the SW spec does. register() with the same script URL resolves at once with no update job. update() compares the bytes and treats an identical script as a no-op.\n\nThe four specs all hit this:\n- partial-cache-population.spec.js:60-63: setFiles + failOn + register(\"sw.js\").\n- module-load-timeout.spec.js:77: register(\"sw.js\") after registerAndActivate.\n- offline-reload.spec.js:64-66: reg.update().\n- worker-restart-mid-request.spec.js:26-30: reg.update().\n\nIn each one, gen 2 never starts installing. Their checks (pointer still equals oldManifest.deploy_id, no second foray-gen-* cache, gen-1 data still readable) would pass even with no all-or-nothing or retention logic in sw.js. None of them checks that a second worker ever reached installing or redundant. Two premises in the comments are wrong. partial-cache-population's comment says \"New deploy lands\" and names search-engine.js, but the code fails on player/client.js. The \"no other foray-gen cache\" check in that same spec passes only because no install ever runs.\n\nNothing I found says this is deliberate. DECISIONS.md only covers the BUILD_ID stamping in the deploy build, not a known fixture limitation. The node:vm tests in test/sw-generation.test.js still cover the same logic, so this is lost test value and false confidence, not a production bug. That is why I rated it medium.\n\nThe fix sketch works: serve sw.js with BUILD_ID replaced by computeManifest(files).deploy_id, and add a premise assertion in each spec that a second worker appeared. I did not run a test because reading the code settled it.",
  "merged_ids": [],
  "lane": "L4-web-platform"
}
```

## tests-2: boot-path perf-3 whenQuiet test depends on wall-clock timer order and fails when the process stalls ~45 ms

**confirmed** · verifier severity **low** (finder: medium) · tests · flaky-timing · `test/boot-path.test.js:595` · L1-app-data

```json
{
  "id": "tests-2",
  "area": "tests",
  "category": "flaky-timing",
  "title": "boot-path perf-3 whenQuiet test depends on wall-clock timer order and fails when the process stalls ~45 ms",
  "file": "test/boot-path.test.js",
  "line": 595,
  "severity": "medium",
  "scenario": "The test calls whenQuiet(fn, 40), sleeps 25 ms, calls noteInteraction(), sleeps 25 ms and asserts ran===0, then sleeps 60 ms and asserts ran===1. The rescheduled check lands at about t1+40, and only then does whenIdle arm setTimeout(fn, 0) (the harness has no requestIdleCallback). Suppose the process stalls from about t1+30 to t1+100, which happens with node --test running files in parallel on a loaded CI runner. When it resumes, the check (t1+40) and the test's sleep(60) (about t1+85) are both due. The check runs first and schedules fn at now+1, after the already-due sleep timer. The sleep resolves first and `assert.strictEqual(ran, 1)` fails. This suite runs in the required data-and-site check, so a stall turns unrelated PRs red.",
  "evidence": "boot-path.test.js:595-606: `m.ctx.whenQuiet(() => { ran += 1; }, 40); await sleep(25); m.ctx.noteInteraction(); await sleep(25); assert.strictEqual(ran, 0, ...); await sleep(60); assert.strictEqual(ran, 1, ...)`. app.js:7759-7765 whenQuiet: `const wait = lastInteractionAt + quietMs - Date.now(); if (wait > 0) { setTimeout(check, wait); return; } whenIdle(fn, 2000);` and whenIdle falls back to `setTimeout(fn, 0)`.",
  "fix_sketch": "Drive the clock rather than sleeping. Inject fake setTimeout/Date.now into the vm ctx (or use node:test mock.timers.enable({apis:['setTimeout','Date']}) with a ctx that forwards to the mocked globals), then mock.timers.tick(25), noteInteraction, tick(25) and assert 0, tick(41) and assert 1. At minimum, replace the final fixed sleep with a poll-until-ran loop that has a generous deadline.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read the code at origin/main and it matches the finding. In test/boot-path.test.js (lines 595-606), whenQuiet(fn, 40) is followed by sleep(25), noteInteraction(), sleep(25), assert ran===0, then sleep(60) and assert ran===1. The sleep helper (line 122) is a plain host setTimeout. The vm ctx's setTimeout (line 210) calls the same host setTimeout with unref, and the harness defines no requestIdleCallback. In app.js (7759-7784), check first runs at t0+40. It sees wait=25 and re-arms for about t0+65. Then whenIdle falls back to setTimeout(fn, 0), which is 1 ms in Node. The final sleep(60) is due at about t0+110.\n\nOn a normal run the margin is about 44 ms. If the process stalls across the window from about t0+65 to t0+110, the rescheduled check and the sleep timer are both due when it resumes. Node's processTimers handles the earlier expiry first, so check runs and arms fn at now+1. That timer is not due in the current pass, so the already-expired sleep timer resolves first and assert ran===1 fails.\n\nThe scenario is real. tools/ci/run-suites.mjs runs `node --test` over test/*.test.js, and by default that runs files in parallel processes, so a loaded runner can preempt a process for tens of ms. GC during a large vm mount can do the same. Nothing in DECISIONS.md or the test comments accepts this timing dependence, and nothing elsewhere handles it: the mount keeps real timers and there is no mocked clock or polling.\n\nI rate it low rather than medium. It is a test-only flake that needs a stall of about 45 ms in an exact window, and it has no effect on the product. It would show up as an occasional red required check that passes on rerun. The fix sketch holds: use mock timers, or poll until ran===1 with a deadline.",
  "merged_ids": [],
  "lane": "L1-app-data"
}
```

## tests-3: Search load-state tests order nested product timers against fixed real sleeps: a stall turns positive tests into flakes and the offline test into a vacuous pass

**confirmed** · verifier severity **low** (finder: medium) · tests · flaky-timing · `test/load-states.test.js:653` · L2-app-surface

```json
{
  "id": "tests-3",
  "area": "tests",
  "category": "flaky-timing",
  "title": "Search load-state tests order nested product timers against fixed real sleeps: a stall turns positive tests into flakes and the offline test into a vacuous pass",
  "file": "test/load-states.test.js",
  "line": 653,
  "severity": "medium",
  "scenario": "In load-states.test.js:647-660 the catalogue pass runs only after the 250 ms SHOW_SEARCH_DEBOUNCE_MS timer. mountSearch then arms the test's own sleep(catalogueDelayMs=50) at the moment the debounce fires, and the test waits a fixed sleep(450). If the debounce fires more than 150 ms late (loaded runner), the 50 ms delay lands after the already-due 450 ms timer and 'the catalogue's row lands' fails. offline-search.test.js:172-180 has the mirror problem. 'offline makes ZERO shard requests' asserts a negative after sleep(300) against the same 250 ms debounce. A regression that fires the shard request slightly later than the check passes silently, and its online control (line 182) flakes under the same stall. show-search-fallthrough.test.js (sleep(10)/sleep(20) after focus/submit, e.g. :320, :358) has the same pattern.",
  "evidence": "load-states.test.js:625 `return catalogueDelayMs ? sleep(catalogueDelayMs).then(() => answer) : answer;` and :651-654 `m.ctx.onShowSearchInput(\"huberman\"); ... await sleep(450); assert.match(m.view.querySelector(\"#sh-results\").innerHTML, /Huberman Lab/ ...)`. app.js:6769 `const SHOW_SEARCH_DEBOUNCE_MS = 250;`. offline-search.test.js:176-178 `m.type(\"science friday\"); await sleep(300); assert.strictEqual(m.shardCalls().length, 0, ...)`.",
  "fix_sketch": "Add a shared waitFor(predicate, {timeoutMs: 5000}) helper for positive outcomes. For negative outcomes, first wait for a positive 'the pass ran' signal (e.g. the debounce tick fired or the local pass painted a settled note) and then assert zero shard calls. Better still, run these harnesses on mock.timers so 250 ms is a tick() rather than a real wait.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read the code at origin/main and it matches the finding. In test/load-states.test.js, mountSearch's fetchImpl (line ~625) returns `sleep(catalogueDelayMs).then(() => answer)`. That timer is only armed when the catalogue fetch starts, which happens inside the app's 250 ms debounce callback (app.js:6769 `SHOW_SEARCH_DEBOUNCE_MS = 250`, :8150-8157, where setTimeout leads to runShowSearchCostly). The test arms a fixed `await sleep(450)` right after onShowSearchInput and then asserts the row. So the slack is 150 ms. If the event loop stalls so the debounce fires after t0+400, the 50 ms catalogue timer comes due after the test's 450 ms timer, and 'the catalogue's row lands' fails. offline-search.test.js:172-189 uses a fixed sleep(300) against the same 250 ms debounce for the offline negative and the online control, leaving only 50 ms of slack. show-search-fallthrough uses sleep(10) after focus. None of this is documented as deliberate, and there is no waitFor or mock.timers helper that covers it. run-suites.mjs runs `node --test` over many files, which by default runs files in parallel processes, so a loaded runner is realistic, especially on Windows CI.\n\nWhy I rated it low rather than medium: this is a flakiness risk that needs a stall of roughly 150 ms (50 ms for the offline and online tests) at a specific point. No evidence showed an observed flake. The 'vacuous pass' half is weak. The mutation the offline test names (checking onLine inside .then) still fires the request inside the 250 ms tick, so the test catches it. The only regression it would miss is one that delays the offline shard request past 300 ms while online stays under 300 ms, which is contrived. The online control does flake in the same direction, so under a stall the pair fails loudly rather than passing silently. The problem is real, but it hurts test robustness, not product correctness. I did not run the tests.",
  "merged_ids": [],
  "lane": "L2-app-surface"
}
```

## tests-4: No CI job sets timeout-minutes and the root node --test run has no --test-timeout, so one hung test holds the runner for 6 hours

**confirmed** · verifier severity **low** (finder: low) · tests · ci-tooling · `.github/workflows/ci.yml:20` · L7-ci-release-security

```json
{
  "id": "tests-4",
  "area": "tests",
  "category": "ci-tooling",
  "title": "No CI job sets timeout-minutes and the root node --test run has no --test-timeout, so one hung test holds the runner for 6 hours",
  "file": ".github/workflows/ci.yml",
  "line": 20,
  "severity": "low",
  "scenario": "The node:test default --test-timeout is Infinity. A test that leaves a ref'd handle open (the Playwright-style servers, a keep-alive setInterval like data-deletion.test.js:1616 when an await in between throws before clearInterval... or a product setInterval such as queue-manager.js:2447 under a harness that does not unref) keeps its file process alive forever. The job then runs to GitHub's 360-minute default. On ios-kit (macos-latest, billed at 10x) that is about 60 billed hours per hang. The required data-and-site check also sits pending for 6 h instead of failing quickly.",
  "evidence": "ci.yml: jobs backend, api, ios-kit, data-and-site and playwright have no `timeout-minutes`. run-suites.mjs commandsFor: `return { cwd: \".\", steps: [{ cmd: \"node\", args: [\"--test\", ...group.suites] }] };` has no --test-timeout. backend's vitest has testTimeout 10000, so only the node suites are exposed.",
  "fix_sketch": "Add `timeout-minutes` to each job (e.g. 30 for data-and-site/backend/api, 45 for ios-kit). Pass `--test-timeout=120000` in commandsFor for the root group, and have package test scripts accept it (or add it to their scripts). Update run-suites.test.mjs's expected argv.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main and the finding holds. .github/workflows/ci.yml defines five jobs: backend (line 20), api (50), ios-kit (84, macos-latest), data-and-site (185) and playwright (335). None of them sets `timeout-minutes`; a grep of the file for \"timeout\" returns nothing. tools/ci/run-suites.mjs:280 builds the root group's command as `[\"--test\", ...group.suites]` with no `--test-timeout`. The node:test default timeout is Infinity, and `node --test` waits for each file's child process to exit. So a test file that leaves a ref'd handle open would hang the job until GitHub's 360-minute default. The omission is not deliberate: other workflows set `timeout-minutes` on purpose (android-build, android-release, ios-build, release, release-trigger, release-watch, shows-import), and android-workflow.test.mjs and ios-workflow.test.mjs even assert that it is present. I found nothing about CI timeouts in docs/DECISIONS.md. Two caveats: the scenario is a latent hazard, not a hang that happens today, and the 10x macOS billing only applies if the repo is private. The cost is a stuck runner and a required check left pending for hours, which is annoying but not a correctness problem, so severity stays low.",
  "merged_ids": [],
  "lane": "L7-ci-release-security"
}
```

## tests-5: Timezone-sensitive date tests cannot fail in CI, because CI runs in UTC where local and UTC formatting are the same

**confirmed** · verifier severity **low** (finder: low) · tests · test-cannot-fail · `test/format-helpers.test.js:252` · L2-app-surface

```json
{
  "id": "tests-5",
  "area": "tests",
  "category": "test-cannot-fail",
  "title": "Timezone-sensitive date tests cannot fail in CI, because CI runs in UTC where local and UTC formatting are the same",
  "file": "test/format-helpers.test.js",
  "line": 252,
  "severity": "low",
  "scenario": "fmtDate({local:true}) and 'judge this year in UTC for a UTC release date' are only distinguishable off UTC. format-helpers.test.js computes its expected value with the machine's own local formatter (localDay). On a UTC runner, a fmtDate that ignored `local` and always used UTC would pass, as would the test's own named 'MUTATION 2: judge this year in local time'. tools/refresh/backfill-show.test.mjs:383-405 admits the same thing ('this mutation survives in CI. Run it as TZ=America/Los_Angeles') but never fixes it. The regressions these tests exist to catch go green on every PR.",
  "evidence": "format-helpers.test.js:249 `const localDay = (iso) => new Date(iso).toLocaleDateString(\"en-US\", {...})` and :260 `assert.strictEqual(ctx.fmtDate(\"2019-09-21T12:00:00.000Z\", { local: true }), localDay(...))`. backfill-show.test.mjs:394-397: \"KILLED BY: switching to a local-time formatter — BUT ONLY OFF UTC ... this mutation survives in CI\". No suite or workflow sets TZ (git grep '\\bTZ\\b' finds only this comment).",
  "fix_sketch": "Set `process.env.TZ = \"America/Los_Angeles\"` (or Pacific/Kiritimati for the east-of-UTC case) at the very top of these suites, before any Date use. Node re-reads TZ at runtime and the vm contexts share it. Then write literal expected strings instead of localDay(), or run the date block once per zone.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "Read at origin/main. test/format-helpers.test.js:249 defines localDay() with the machine's own toLocaleDateString, and :260 compares fmtDate(..., {local:true}) against it. On a UTC runner, a fmtDate that ignores `local` gives the same string, so that mutation survives. MUTATION 2 in the year test ('2025-12-31' with now=2026-01-01T02:00Z) also survives in UTC, because local now and UTC now are both 2026 there. It would only fail in a zone west of UTC. The local:true year cases use local-built Dates on both sides, so they cannot tell the two modes apart in UTC either. CI (.github/workflows/ci.yml) runs `npm test` on ubuntu-latest, which defaults to UTC. `git grep '\\bTZ\\b'` finds no TZ setting in any workflow or suite: the only hits are the backfill-show.test.mjs:396 comment, STATE.md:1340, and date format strings in nightly-refresh.yml. For backfill-show, the gap is acknowledged in the test comment and in STATE.md ('only fails off UTC ... names TZ=America/Los_Angeles as the way to reproduce it'). That makes it a known, named limitation there, not a fix. docs/DECISIONS.md has no ruling that accepts it. The format-helpers comment explains localDay as a fix for developers in Asia/Pacific zones, which is a choice about portability, not about CI coverage. The fix sketch is workable: set process.env.TZ at the top of the test, or run the suite under several zones. Severity is low because this is only a coverage gap in tests, not a product bug.",
  "merged_ids": [],
  "lane": "L2-app-surface"
}
```

## tests-6: suite-integrity floors have enough slack that large parts of some suites can be deleted without failing it

**confirmed** · verifier severity **low** (finder: low) · tests · test-guard-weak · `test/suite-integrity.test.js:518` · L7-ci-release-security

```json
{
  "id": "tests-6",
  "area": "tests",
  "category": "test-guard-weak",
  "title": "suite-integrity floors have enough slack that large parts of some suites can be deleted without failing it",
  "file": "test/suite-integrity.test.js",
  "line": 518,
  "severity": "low",
  "scenario": "The file exists so that deleting tests fails CI. 61 of 326 floors sit below the current count, with 194 tests of total slack. In the worst cases a bot PR could remove 8 of 15 politeness tests or 14 of 36 search-matcher tests with every check green: tools/segments/politeness.test.mjs 7 vs 15, test/search-matcher.test.js 22 vs 36, tools/segments/regrid-clean.test.mjs 25 vs 38, backend test/researchShape.test.ts 18 vs 31, tools/segments/measure-suspects.test.mjs 57 vs 69, backend test/deepenActs.test.ts 25 vs 33. That is the exact 'PR 1 weakens the gate' step the header describes.",
  "evidence": "suite-integrity.test.js:518 `\"test/search-matcher.test.js\": 22,` (36 `test(` lines at origin/main), :1813 `\"tools/segments/politeness.test.mjs\": 7,` (15), :1884 regrid-clean 25 (38), :2130 researchShape 18 (31). The count is `(src.match(/^\\s*test\\(/gm) || []).length` and it is only checked for `count >= floor`.",
  "fix_sketch": "Ratchet every floor to its current count now. Then add a check that fails when a suite's count exceeds its floor by more than a small margin (e.g. 2), with a message saying to raise the floor, so slack cannot build up again. Growing a suite then carries a one-line floor bump in the same PR.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked this at origin/main and it holds. The checks only assert `count >= floor`, at test/suite-integrity.test.js:2686 for backend suites and in the same form for the FLOORS map. The floors the finding quotes are what the code says: search-matcher 22 at :518, politeness.test.mjs 7 at :1813, measure-suspects 57 at :1875, regrid-clean 25 at :1884, researchShape 18 at :2130, deepenActs 25 at :2173. I counted `^\\s*test\\(` lines directly for three of them: search-matcher 36, politeness 15, regrid-clean 38. All three match the finding. So a PR can delete 14 search-matcher tests or 8 politeness tests and this file stays green. That is the \"PR 1 weakens the gate\" step its own header warns about, and these paths are in the auto-merge allowlist.\n\nIs the slack deliberate? Only in part. The header says \"ADDING tests is always fine and never requires touching this file\" and \"Raising a floor is encouraged\". That knowingly accepts slack when a suite grows, but it does not endorse slack as a defence. Many entries instead aim for \"zero slack\" and close drift when they find it, for example event-log 32 vs 20, queue-manager 143 vs 132 and merge-topics 17 vs 16, each fixed. So the uneven floors come from inconsistent upkeep, not a policy choice. docs/DECISIONS.md says nothing about accepting slack.\n\nI did not recount the totals (61 of 326 floors, 194 tests of slack). The individual examples I checked are accurate.\n\nSeverity is low. The file only makes deletion loud and cannot see gutted test bodies anyway. The two-PR attack still needs a later PR to land a real regression. The weekly merge audit also exists as a backstop.",
  "merged_ids": [],
  "lane": "L7-ci-release-security"
}
```

## tests-7: Placeholder tests that assert nothing pad the floors and read as coverage

**confirmed** · verifier severity **low** (finder: low) · tests · test-cannot-fail · `backend/test/partialCandidate.test.ts:69` · L7-ci-release-security

```json
{
  "id": "tests-7",
  "area": "tests",
  "category": "test-cannot-fail",
  "title": "Placeholder tests that assert nothing pad the floors and read as coverage",
  "file": "backend/test/partialCandidate.test.ts",
  "line": 69,
  "severity": "low",
  "scenario": "partialCandidate.test.ts's 'is always visibility: private' test only asserts `expect(true).toBe(true)`. If buildPartialCandidate started copying the request's own visibility (making a streamed partial public), this test would stay green, and it still counts toward BACKEND_FLOORS. player/diagnostic-record.test.js:615-626 is the same kind of test: a body of `assert.ok(true, \"see the three tests that follow\")` that inflates that suite's floor count by one.",
  "evidence": "partialCandidate.test.ts:69-74 `it(\"is always visibility: private, ...\", () => { expect(true).toBe(true); // documented by the type itself })`. diagnostic-record.test.js:625 `assert.ok(true, \"see the three tests that follow\");`.",
  "fix_sketch": "partialCandidate: build a candidate from a request carrying visibility 'public' and `expect(candidate.visibility).toBe(\"private\")`. diagnostic-record: turn the placeholder into a comment block above the three real tests and lower that floor by 1 in the same PR.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read both files at origin/main and the finding is accurate.\n\n1. backend/test/partialCandidate.test.ts:69-74. The test \"is always visibility: private, regardless of the request's own visibility field\" never calls buildPartialCandidate. Its only line is `expect(true).toBe(true); // documented by the type itself`. The suite has a committed floor in test/suite-integrity.test.js:2462 (`\"test/partialCandidate.test.ts\": 6`), so this empty test counts as one of the six.\n\n2. player/diagnostic-record.test.js. The test \"the stop rows come from the REAL element, not from typed strings\" consists of a long comment and `assert.ok(true, \"see the three tests that follow\")`. That suite is also floored, at 25 (suite-integrity.test.js:96). The suite-integrity checks do not appear to reject tautological assertions.\n\nThings that reduce the impact:\n- In backend/src/generation/partialCandidate.ts, `visibility: \"private\"` is a literal type on the PartialCandidate interface (line 77) and is hardcoded at line 242. Neither PartialActInfo nor PartialCandidateMeta has a visibility field, so the finding's exact scenario (\"started copying the request's own visibility\") would mean adding an input field and widening the literal type. Typechecking would push back on that.\n- The comment in the diagnostic-record test explains that it is a section header on purpose, so reviewers are not misled about what it covers.\n\nStill, neither test asserts anything. A runtime change, such as a cast or a spread that overrides visibility, would leave the partialCandidate test green. Each empty test also counts toward its suite's floor, which is exactly what the finding claims. Nothing in docs/DECISIONS.md or elsewhere excuses this: the in-file comments rely on the type rather than a test, which is not the same as deliberately accepting a zero-assertion test. The fix is cheap: build a candidate and assert that `candidate.visibility === \"private\"`, and turn the diagnostic-record placeholder into a comment with its floor lowered by 1. Severity is low because it is a coverage and hygiene issue that the type system already partly covers.",
  "merged_ids": [],
  "lane": "L7-ci-release-security"
}
```

## tests-8: The gitignore guard for audio-cache/ probes with .mp3, which the global *.mp3 rule already ignores, so it cannot detect the directory rule being removed

**confirmed** · verifier severity **low** (finder: low) · tests · assertion-on-wrong-thing · `tools/transcribe/fetch-audio.test.mjs:630` · L8-data-tools

```json
{
  "id": "tests-8",
  "area": "tests",
  "category": "assertion-on-wrong-thing",
  "title": "The gitignore guard for audio-cache/ probes with .mp3, which the global *.mp3 rule already ignores, so it cannot detect the directory rule being removed",
  "file": "tools/transcribe/fetch-audio.test.mjs",
  "line": 630,
  "severity": "low",
  "scenario": "'the download dir is gitignored' checks `audio-cache/anything.mp3`, and 'a real file inside the download dir stays invisible' writes gitignore-probe.mp3. Both stay green if the `audio-cache/` line is deleted from .gitignore, because `*.mp3` also matches. fetch-audio.mjs writes .aac/.mp4/.ogg/.oga/.wav files (AUDIO_EXTENSIONS) and audio-cache/checkpoint.json into that directory, and none of those is covered by a global pattern. A `git add -A` would stage them. decode-compare.test.mjs:727 has the same shape (probe.mp3 under data-local/).",
  "evidence": ".gitignore:24-28 `audio-cache/` `*.mp3` `*.m4a` `*.opus` `*.flac`. fetch-audio.mjs:94 `CHECKPOINT_PATH = join(DOWNLOAD_DIR, \"checkpoint.json\")`, :130 `AUDIO_EXTENSIONS = new Set([\".mp3\", \".m4a\", \".mp4\", \".aac\", \".ogg\", \".oga\", \".opus\", \".wav\", \".flac\"])`. fetch-audio.test.mjs:632 ``git check-ignore -v `${dirName}/anything.mp3` ``.",
  "fix_sketch": "Probe with names that only the directory rule can ignore: `audio-cache/checkpoint.json` and `audio-cache/x.aac`. Assert that check-ignore -v names the `audio-cache/` pattern specifically (match /audio-cache\\/\\s/ in the output), not just any .gitignore line. Do the same for data-local/decode-audio in decode-compare.test.mjs.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked this against origin/main and the finding holds. .gitignore ignores `audio-cache/` and also ignores `*.mp3`, `*.m4a`, `*.opus` and `*.flac` everywhere. In fetch-audio.test.mjs, 'the download dir is gitignored' runs `git check-ignore -v audio-cache/anything.mp3` and only checks that the output mentions `.gitignore`. The `*.mp3` line satisfies that on its own. 'a real file inside the download dir stays invisible' writes gitignore-probe.mp3, which `*.mp3` also hides from `git status`. So if someone deleted the `audio-cache/` line, both tests would still pass. That line is the only thing ignoring the other files fetch-audio.mjs writes into that directory: checkpoint.json (line 94) and .mp4/.aac/.ogg/.oga/.wav audio (AUDIO_EXTENSIONS, line 130). Nothing in docs/DECISIONS.md or the comments makes the .mp3 probe deliberate. The .gitignore comment says the directory rule exists to keep episodes out. decode-compare.test.mjs has the same problem: probe.mp3 sits under data-local/decode-audio, and `*.mp3` ignores it no matter what the `data-local/` rule says. Two things keep this at low severity. The `audio-cache/` line is there today, so nothing is broken yet. And the companion test 'NOTHING under the download dir is git-tracked' (`git ls-files -- audio-cache`) would still fail once any file there was staged or committed. That catches the mistake after a `git add` rather than preventing it, and only if the tests run before the commit. It is a real blind spot in a regression guard, not a live leak.",
  "merged_ids": [],
  "lane": "L8-data-tools"
}
```

## tests-9: showsWeVouchFor test passes if the function returns an empty array

**refuted** · verifier severity **low** (finder: low) · tests · test-cannot-fail · `test/show-page.test.js:954`

```json
{
  "id": "tests-9",
  "area": "tests",
  "category": "test-cannot-fail",
  "title": "showsWeVouchFor test passes if the function returns an empty array",
  "file": "test/show-page.test.js",
  "line": 954,
  "severity": "low",
  "scenario": "All three assertions are universal or negative: every result has a note, and show-blank and show-none are absent. If showsWeVouchFor regressed to returning [] (e.g. the date filter or the slice broke), the Home row 'Shows we vouch for' would disappear and this test would stay green. The fixture has exactly one qualifying show, but nothing asserts that it comes back.",
  "evidence": "show-page.test.js:967-969 `assert.ok(result.every((s) => s.editorial_note && s.editorial_note.trim()), ...); assert.ok(!result.some((s) => s.show_id === \"show-blank\"), ...); assert.ok(!result.some((s) => s.show_id === \"show-none\"), ...);`",
  "fix_sketch": "Add `assert.deepStrictEqual(result.map((s) => s.show_id), [\"show-a\"])` (or at least `result.length === 1`).",
  "duplicates": [],
  "verdict": "refuted",
  "verdict_severity": "low",
  "verdict_reasoning": "The literal observation is correct. At origin/main, test/show-page.test.js:954-970 has only a universal assertion (`every`) and two negative assertions (`!some`), so on its own it would pass if showsWeVouchFor returned []. But the risk the finding describes is already covered elsewhere, which the task says to check.\n\nThe very next test (show-page.test.js:972-980, \"caps at the given limit\") gives the function 20 noted shows and asserts `result.length === 8` with strictEqual. The regressions the finding names would all fail that test: returning [], a broken date filter or seed that empties the result, or a broken slice (e.g. slice(0,0)). The determinism and day-rotation tests (995+) also work on non-empty results. The day-rotation one uses notDeepStrictEqual, which fails if both days return [].\n\nSo the Home row \"Shows we vouch for\" cannot quietly disappear with the suite still green. The function at app.js:6655 is filter -> sort -> empty-guard -> seededShuffle -> slice. Any path that wrongly returns [] for noted shows turns the cap test red.\n\nWhat is left is test hygiene only. Adding `deepStrictEqual(result.map(s=>s.show_id), [\"show-a\"])` would make this one test self-contained, which is a nice-to-have. It is not a coverage gap. I did not need to run anything because the covering assertion is a plain strictEqual.",
  "merged_ids": [],
  "lane": null
}
```

## tests-10: The fake DOM in boot-path and load-states ignores attribute values in selectors, so [data-x="id"] returns the first element with data-x

**confirmed** · verifier severity **low** (finder: low) · tests · harness-fidelity · `test/boot-path.test.js:116` · L1-app-data

```json
{
  "id": "tests-10",
  "area": "tests",
  "category": "harness-fidelity",
  "title": "The fake DOM in boot-path and load-states ignores attribute values in selectors, so [data-x=\"id\"] returns the first element with data-x",
  "file": "test/boot-path.test.js",
  "line": 116,
  "severity": "low",
  "scenario": "Several app.js code paths select by value: `[data-star=\"${id}\"]` (app.js:1492), `[data-show-star=...]` (:1563), `[data-upnext=...]` (:5327), `[data-chip=\"${rootId}\"]` (:6470), `[data-seg-id=...]` (:11059). Under these two harnesses, each of those returns every element carrying the attribute. Code that repaints the wrong row, or a test that looks up a specific button by value, then passes or fails for the wrong reason. Today's direct test lookups only use bare [data-retry]/[data-reload]/[data-play], so this is latent until someone adds a value selector.",
  "evidence": "boot-path.test.js:116 and load-states.test.js:128: `if (tok.startsWith(\"[\")) { const name = tok.slice(1, -1).split(\"=\")[0]; return name in el.attrs; }`",
  "fix_sketch": "Parse `[name=\"value\"]` and compare `el.attrs[name] === value` when a value is present (strip the quotes). Better, move both copies into one shared test/helpers fake-DOM module so the fix lands once.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main myself and the finding holds. In both test/boot-path.test.js (around line 116) and test/load-states.test.js (around line 128), `matches()` handles a `[` token with `const name = tok.slice(1, -1).split(\"=\")[0]; return name in el.attrs;`. That throws away any `=\"value\"` part, so `[data-star=\"x\"]` matches every element that has data-star, and querySelector returns the first one in document order.\n\nNeither file has a comment saying this is deliberate or a known shortcut. The two fake-DOM copies are identical, so the fix would have to be made in both places.\n\nEvery direct lookup in the tests uses a bare attribute ([data-retry], [data-reload], [data-play]), an id, or .back. No current assertion depends on the value being compared, so nothing gives a wrong result today. The risk is latent: it only shows up if app code under these harnesses picks a row by value and a test then checks that the right row changed, or if someone adds a value-selector lookup to a test.\n\nSeverity is low because this is test-harness accuracy only, with no production effect and no test that currently misleads. One smaller point: the tokenizer splits on `.`, `#` and `[`, so an attribute value containing a `.` or `#` would also be mis-tokenized. That is the same class of problem.",
  "merged_ids": [],
  "lane": "L1-app-data"
}
```

## tests-11: boot-path 'hydration NEVER finishes' test spends at least 4 s of real time waiting out a hard-coded 4000 ms ceiling

**confirmed** · verifier severity **low** (finder: low) · tests · slow-test · `test/boot-path.test.js:428` · L1-app-data

```json
{
  "id": "tests-11",
  "area": "tests",
  "category": "slow-test",
  "title": "boot-path 'hydration NEVER finishes' test spends at least 4 s of real time waiting out a hard-coded 4000 ms ceiling",
  "file": "test/boot-path.test.js",
  "line": 428,
  "severity": "low",
  "scenario": "mount({ ceilingMs: 4000 }) followed by a loop of up to 80 x sleep(100) means every run of the required data-and-site suite waits at least 4 s of wall clock for STORAGE_SETTLE_CEILING_MS. The margin to the 8 s loop cap also narrows under load. The claim being tested (the ceiling opens the gate) does not depend on the size of the number.",
  "evidence": "boot-path.test.js:434 `const m = mount({ store, storageWaitMs: 20, ceilingMs: 4000 });` and :444 `for (let i = 0; i < 80 && m.ctx.storageWaiting(); i++) await sleep(100);`",
  "fix_sketch": "Use ceilingMs: 150 and poll with a deadline of about 3 s. Or assert on the armed ceiling timer through an injected setTimeout recorder, the way html-audio-backend.test.js records `asked` delays.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "At origin/main (b01ea3d), test/boot-path.test.js:435 calls `mount({ store, storageWaitMs: 20, ceilingMs: 4000 })` and line 444 polls `for (let i = 0; i < 80 && m.ctx.storageWaiting(); i++) await sleep(100);`. The store comes from storeOver and is never released, so hydrate() never resolves. The only way out is the setTimeout in app.js:260-268 (armStorageSettleCeiling). mount() sets STORAGE_SETTLE_CEILING_MS = 4000 at mount:234, and the timer is armed during boot, roughly when the 20 ms storage wait ends. So the test really does spend about 4 s of real time, minus however long booted() takes, before the gate opens. The 8 s loop cap leaves about 4 s of slack.\n\nNothing I found marks 4000 as deliberate. The app.js comment says only \"`let`, so a suite can shorten it\". DECISIONS.md says nothing about it, and docs/audit/round-2/status.tsv simply names the test. I did not run the test: the local checkout (HEAD ab8a056) does not have test/boot-path.test.js, and worktrees were off limits. This finding rests on reading the code only.\n\nOne caution about the proposed fix. The margin does have a real job, even though nobody wrote it down. The \"premise: still hydrating\" assert and the five-nudge waiter check run after `await m.booted()`. booted() can loop up to 600 settle ticks, and the mount() comment records that this timing differs between Windows and Linux CI. With a 150 ms ceiling, the timer could fire before those premise asserts on a slow runner, and the test would fail at random. Something like 500-1000 ms, or an injected timer recorder, would be safer.\n\nImpact: about 4 s of wall clock on each required-suite run. No correctness risk.",
  "merged_ids": [],
  "lane": "L1-app-data"
}
```

## security-3: ci.yml has no permissions block while the repo default token is write-all, so PR code and its dependencies run with a write token

**confirmed** · verifier severity **medium** (finder: medium) · security · security/ci-permissions · `.github/workflows/ci.yml:1` · L7-ci-release-security

```json
{
  "id": "security-3",
  "area": "security",
  "category": "security/ci-permissions",
  "title": "ci.yml has no permissions block while the repo default token is write-all, so PR code and its dependencies run with a write token",
  "file": ".github/workflows/ci.yml",
  "line": 1,
  "severity": "medium",
  "scenario": "The repo's default_workflow_permissions is 'write' and can_approve_pull_request_reviews is true (gh api .../actions/permissions/workflow). ci.yml declares no `permissions:`. Every push to main and every same-repo PR (every agent branch) therefore runs `npm ci`, `npm test`, `npx playwright install`, `node tools/...` and the backend/api test suites with a GITHUB_TOKEN that can write contents (branches, tags, releases), actions and PRs. If any devDependency is compromised (vitest, stryker, eslint, playwright, tsx), or an agent PR adds a malicious script, the token can overwrite the shows-index GitHub Release assets. The api/shows/index proxy relays those assets verbatim to every client. It can also push branches, dispatch workflows and approve PRs. Every other workflow in the repo scopes its permissions explicitly; ci.yml is the odd one out.",
  "evidence": "ci.yml top level: `on: push/pull_request/workflow_dispatch` then `jobs:` with no `permissions:` key (grep for 'permissions' in ci.yml finds nothing). Live: {\"default_workflow_permissions\":\"write\",\"can_approve_pull_request_reviews\":true}.",
  "fix_sketch": "Add `permissions: { contents: read }` at the top of ci.yml, plus the same in any other workflow that lacks it. Separately, flip the repository default to read-only and turn off 'Allow GitHub Actions to create and approve pull requests'; the workflows that need write access already declare it.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I checked this against origin/main myself. ci.yml has no `permissions:` key at any level; the only GITHUB_TOKEN mention is in a comment about the workflow_dispatch trigger. It runs on push to main, on pull_request and on workflow_dispatch. The other 13 workflows (android-build, android-release, automerge-nightly, ios-build, nightly-refresh, nightly-watch, pages, path-policy, pr-hygiene, release-trigger, release-watch, release, shows-import) each declare `permissions:`, so ci.yml is the only one without it. The live `gh api .../actions/permissions/workflow` call returns {\"default_workflow_permissions\":\"write\",\"can_approve_pull_request_reviews\":true}. ci.yml therefore inherits a write-all GITHUB_TOKEN on main pushes, same-repo PRs and dispatches. Fork PRs are still downgraded to read, but agent branches are same-repo. Nothing in docs/DECISIONS.md or in a comment makes this deliberate; the DECISIONS hits for token/permission are about unrelated topics. The workflow_dispatch comment explains why pr-hygiene can trigger CI, not why CI needs write access. As far as I can see, ci.yml only checks out code and runs tests and builds, so `contents: read` is enough. Two things keep this at medium rather than higher. First, exploiting it needs a compromised devDependency or a malicious PR, and an agent that can already push branches gains little from the push part. Second, the token only lasts as long as the job. Still, a write token that can replace release assets, dispatch workflows and approve PRs, handed to third-party test tooling on every PR, is a real hardening gap. The fix is easy and matches the pattern in every other workflow.",
  "merged_ids": [],
  "lane": "L7-ci-release-security"
}
```

## security-8: Generation relay on localhost accepts cross-site text/plain POSTs to /answer/:id (ids are sequential) and /reset, with no Origin or Host check

**confirmed** · verifier severity **low** (finder: low) · security · security/csrf-localhost · `tools/generation/relay.mjs:595` · L5-generation

```json
{
  "id": "security-8",
  "area": "security",
  "category": "security/csrf-localhost",
  "title": "Generation relay on localhost accepts cross-site text/plain POSTs to /answer/:id (ids are sequential) and /reset, with no Origin or Host check",
  "file": "tools/generation/relay.mjs",
  "line": 595,
  "severity": "low",
  "scenario": "During a keyless generation run, the relay listens on 127.0.0.1:8787 and the pipeline's Anthropic calls park there. Any web page open in the founder's browser can send a CORS 'simple' request, `fetch('http://127.0.0.1:8787/answer/r0003', {method:'POST', body:'...'})` with a text/plain body and no preflight. It can inject arbitrary model output into a parked spine or narration call, which lands in a generated Foray, or POST /reset to wipe the queue. Ids are `r0001`, `r0002`, ..., so they are trivially guessable. There is also no Host-header check, so DNS rebinding can read GET /pending/:id (the full prompts).",
  "evidence": "relay.mjs:329 `return \\`r${String(seq).padStart(4, \"0\")}\\`;`; :595 `if (req.method === \"POST\" && route.startsWith(\"/answer/\")) { ... payload = raw.trim().startsWith(\"{\") ? JSON.parse(raw) : { text: raw };` ; :608 `if (req.method === \"POST\" && route === \"/reset\") return json(res, 200, reset());` — no Origin/Host/Content-Type validation anywhere in the handler.",
  "fix_sketch": "Reject any request that carries an Origin header, or whose Host is not 127.0.0.1:<port> or localhost:<port>. Require `Content-Type: application/json` or a per-run bearer token (printed at startup and read by the answering session) on /answer and /reset. Mint ids with crypto.randomUUID.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read tools/generation/relay.mjs at origin/main and every part of the finding holds.\n\n- **Localhost binding.** The server listens on 127.0.0.1 (listen(), around line 654).\n- **Sequential ids.** mintId() returns `r${String(seq).padStart(4,\"0\")}` (line 329), giving r0001, r0002 and so on. logicalIdFor() uses a header id only when an idempotency header is present. The file's own comment (around line 80) says @anthropic-ai/sdk 0.68.0 never sends one, so in practice the ids are always the guessable sequential ones.\n- **Unchecked /answer.** The POST /answer/:id handler reads the raw body whatever its Content-Type. If the body does not start with '{' it wraps it as {text: raw}. It then calls answer(). answer() only checks that the id exists and has not been answered. It does not require the request to have been claimed first. The injected text becomes the model response handed back to the SDK caller, and it is also written to done/<id>.answer.txt.\n- **Unchecked /reset.** POST /reset calls reset() with no checks. That fails every parked call with a 503 and clears the queue.\n- **No other guards.** The handler never inspects Origin, Host or Content-Type, and has no token check.\n- **Not a documented decision.** The header comment explains why each behaviour exists (I-03, I-06, I-09, I-10, I-19, I-23, P-01, F-67). None of those rows accepts or discusses cross-origin or DNS-rebinding exposure, and a grep of docs found no such decision either.\n- **DNS rebinding.** With no Host check, a rebinding attack could read GET /pending/:id, which returns the full prompts.\n\nWhy the severity stays low:\n- The relay runs only during a keyless generation run.\n- An attacker would need a page open in the founder's browser at that moment.\n- Modern Chrome's Private/Local Network Access protections now block public-origin requests to loopback, or prompt for permission first. That leaves weaker coverage in other browsers and for DNS rebinding.\n- The worst outcomes are poisoned generated content and a disrupted run. There is no code execution, and the founder reviews the output.\n\nThe fix sketch is appropriate: reject requests that carry a foreign Origin or a non-loopback Host, require JSON or a per-run token on /answer and /reset, and mint ids with randomUUID.",
  "merged_ids": [],
  "lane": "L5-generation"
}
```

## security-9: Dead events-server binds every interface (the log says 127.0.0.1), accepts unauthenticated writes that fill the disk, over-reports what it stored, and uses the relay's port

**confirmed** · verifier severity **low** (finder: low) · security · security/dead-code · `tools/events-server.mjs:71` · L5-generation

```json
{
  "id": "security-9",
  "area": "security",
  "category": "security/dead-code",
  "title": "Dead events-server binds every interface (the log says 127.0.0.1), accepts unauthenticated writes that fill the disk, over-reports what it stored, and uses the relay's port",
  "file": "tools/events-server.mjs",
  "line": 71,
  "severity": "low",
  "scenario": "Nothing in app.js posts to :8787 any more (events go to Supabase), yet scripts/events-server.vbs is written to launch this server from the Startup folder. `server.listen(PORT, cb)` with no host binds :: / 0.0.0.0, so anyone on the same LAN or Wi-Fi can POST /events repeatedly (2 MB per request, append-only, no auth, no quota) and fill the workstation's disk, and can read GET /stats. The log line claims 127.0.0.1, which hides this. The response `accepted: events.length` counts rows beyond the 1000 actually written (`events.slice(0, 1000)`), so a client that trusted it would mark unwritten events as synced. PORT 8787 is also relay.mjs's DEFAULT_PORT, so on a machine where this server auto-starts, the generation relay's listen collides with it.",
  "evidence": "events-server.mjs:71 `server.listen(PORT, () => console.log(\\`Foray events server on http://127.0.0.1:${PORT} ...\\`))`; :49 `events.slice(0, 1000)` vs :52 `accepted: events.length`; relay.mjs:168 `export const DEFAULT_PORT = 8787;`",
  "fix_sketch": "Delete tools/events-server.mjs and scripts/events-server.vbs, and remove the Startup-folder entry on the workstation (the path-policy DENIED entry can go with it). If it must stay, pass host '127.0.0.1' to listen, report the written count, and move it off 8787.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "Every part of the finding holds at origin/main, and the server is running on this workstation right now.\n\n1. Binds every interface. tools/events-server.mjs:71 calls `server.listen(PORT, cb)` with no host, and the log line hardcodes `http://127.0.0.1:${PORT}`. On this machine, `netstat` shows PID 17328 (`node tools\\events-server.mjs`) listening on both 0.0.0.0:8787 and [::]:8787.\n\n2. It auto-starts. The Startup folder holds ForayEventsServer.vbs, the same content as scripts/events-server.vbs. That launcher runs the server from the old `commute-curator` checkout, not the foray checkout, but the code and behavior are the same.\n\n3. Writes without auth, and the count is wrong. POST /events has no auth or quota. Each body can be up to about 2 MB (the request is destroyed above that). It appends `events.slice(0, 1000)` to data-local/events/<profile>.jsonl but replies `accepted: events.length`, so it over-reports anything past 1,000 rows. GET /stats lists profile names and file sizes. CORS only limits which browsers can read the response; it does not stop the append.\n\n4. Nothing uses it any more. `EVENTS_ENDPOINT`/`127.0.0.1:8787` no longer appears in any client .js/.mjs/.html. docs/curation/events-client-integration-spec.md:122 says to retire that endpoint.\n\n5. Port clash. relay.mjs:168 sets `DEFAULT_PORT = 8787`, and `listen` binds 127.0.0.1:8787. With the events server already holding the wildcard on Windows (libuv binds exclusively), the relay would get EADDRINUSE unless `--port` or `RELAY_PORT` is set.\n\nNothing marks this as deliberate. The only related comment, in tools/ci/path-policy.mjs, puts the file on the DENIED list because it runs at login on the founder's workstation. That treats the file as a risk and does not justify how it binds.\n\nWhy severity stays low:\n- Windows Firewall normally blocks unsolicited inbound connections to node unless someone allowed them, so the LAN disk-fill needs that plus a hostile device on the same network. I did not check the firewall rules.\n- The relay collision has an easy workaround (`--port`/`RELAY_PORT`).\n- No client trusts `accepted` any more.\n\nThe fix sketch is sound: delete the server and its launcher, and remove the Startup entry and the DENIED entry.",
  "merged_ids": [],
  "lane": "L5-generation"
}
```

## security-10: The Apple rate buckets are shared by every caller per instance, so one client can use up the directory and episode search for all listeners

**confirmed** · verifier severity **low** (finder: low) · security · security/dos · `api/shows/search.ts:236` · L4-web-platform

```json
{
  "id": "security-10",
  "area": "security",
  "category": "security/dos",
  "title": "The Apple rate buckets are shared by every caller per instance, so one client can use up the directory and episode search for all listeners",
  "file": "api/shows/search.ts",
  "line": 236,
  "severity": "low",
  "scenario": "appleShowBucket and appleSearchBucket are module singletons with a capacity of 20 per 60 s. A single script sending `?q=<random>&fallthrough=1` (or unscoped episode searches) at more than 20/min misses the CDN on every unique q and drains the bucket. Every real listener on that warm instance then gets `fallthrough.error: rate limit exceeded` (catalogue rows only) or a degraded empty episode search. For show search, the failure response is even edge-cached for 10 s. There is no per-client limiting and no minimum q length.",
  "evidence": "appleShowSearch.ts `export const appleShowBucket = new SlidingWindowBucket(APPLE_BUCKET_CAPACITY, APPLE_BUCKET_WINDOW_MS);` and `if (!bucket.tryConsume()) return { shows: [], error: \"rate limit exceeded — try again shortly\" ...}`; search.ts:236 `const apple = await appleShowSearch(q, limit);`; appleBucket.ts `APPLE_BUCKET_CAPACITY = 20`.",
  "fix_sketch": "Put a small per-IP bucket (keyed on x-forwarded-for, or Vercel's firewall / rate-limit rules) in front of the shared Apple bucket. Require q to be at least 2 characters and at most 200 before spending a slot. Normalise q more aggressively (collapse whitespace, strip punctuation) so trivial variants share a cache key.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "Checked against origin/main and the finding holds. api/episodes/appleBucket.ts sets APPLE_BUCKET_CAPACITY=20 and APPLE_BUCKET_WINDOW_MS=60_000, and exports the module singleton appleSearchBucket. api/shows/appleShowSearch.ts:99 exports a second singleton, appleShowBucket, with the same limits. In api/shows/search.ts, the only thing that decides whether to call Apple is `fallthroughAsked` (line 214, then appleShowSearch at 236). The server has no minimum q length: the '>= 3 characters' floor exists only on the client, and a script can skip it. It also has no per-client or per-IP limit. The cache key only lowercases and trims q (appleShowCacheKey), so every distinct random q misses the cache and uses a slot. Once the bucket is drained, a real listener's show search returns only catalogue rows with fallthrough.error, marked `public, max-age=10`. An unscoped episode search returns `episodes: []` with degraded:true (episodes/search.ts:413). Things that soften it but do not refute it: (1) the per-instance limit is documented as deliberate ('HONEST LIMITATION'), but that note is about the lack of a global cap. No comment or DECISIONS.md entry treats the missing per-client limit as a choice. (2) Vercel may spread concurrent traffic across several warm instances, and each one has its own bucket, so one abuser may not reach every instance. (3) Show search still returns catalogue rows on failure, so the damage there is a degraded result, not an outage. (4) The finding says the failure is edge-cached for 10 s, but the header is `max-age` without `s-maxage`, and the file header says s-maxage was left out on purpose. Whether Vercel's CDN caches it at all is unclear, which is a minor inaccuracy. There is also a design tension: Apple's own limit applies per egress IP, so a per-IP limit in front would slow one abuser but would not raise the shared ceiling. Organic traffic above 20/min drains the bucket anyway. Overall this is a real but low-impact availability issue: it degrades search, but no data is lost.",
  "merged_ids": [],
  "lane": "L4-web-platform"
}
```

## security-11: UX prototype page with no CSP and unescaped innerHTML is served from the app's own origin, which holds the Supabase session

**confirmed** · verifier severity **low** (finder: low) · security · security/xss-same-origin · `tools/web/prepare-dist.mjs:130` · L4-web-platform

```json
{
  "id": "security-11",
  "area": "security",
  "category": "security/xss-same-origin",
  "title": "UX prototype page with no CSP and unescaped innerHTML is served from the app's own origin, which holds the Supabase session",
  "file": "tools/web/prepare-dist.mjs",
  "line": 130,
  "severity": "low",
  "scenario": "docs/ux/foray-m3-prototype.html is copied into the Vercel dist (EXTRAS) and is also published by Pages (which uploads `path: .`). It shares the app's origin, where cp_sb_session lives in localStorage/IndexedDB. The page has no Content-Security-Policy, uses inline scripts and inline styles, and builds markup with unescaped interpolation, e.g. `value=\"${S.onbTopic}\"` and `value=\"${S.topicQueryDraft||''}\"` rendered via innerHTML. Today this is reachable only by self-XSS (typed input). Any future change that seeds that state from the URL would give script execution on the token's origin, and the page opts out of every defence index.html has.",
  "evidence": "prepare-dist.mjs `const EXTRAS = [\"docs/ux/foray-m3-prototype.html\"];`; prototype line 796 `<input id=\"onbTopic\" ... value=\"${S.onbTopic}\">`, line 887 `value=\"${S.topicQueryDraft||''}\"`, line 1338 `document.getElementById('view').innerHTML = (V[r]||V.today)();`; `grep -c Content-Security-Policy` = 0.",
  "fix_sketch": "Serve the prototype from a separate origin (its own Vercel project or a gist) or drop it from EXTRAS. If it must stay, add a restrictive meta CSP and escape the interpolated values.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "Every claim checks out at origin/main. tools/web/prepare-dist.mjs has `const EXTRAS = [\"docs/ux/foray-m3-prototype.html\"]` and copies it into dist/, which vercel.json serves as the app's outputDirectory. That puts the prototype on the same origin as app.js, which stores `cp_sb_session` (app.js:471-487). index.html sets a strict meta CSP (script-src 'self', no unsafe-inline). The prototype has no CSP. It interpolates `value=\"${S.onbTopic}\"` (line 796) and `value=\"${S.topicQueryDraft||''}\"` (line 887) into markup without escaping, and that markup reaches innerHTML. vercel.json adds no CSP response header that would cover it.\n\nTwo things limit the risk. The comment above EXTRAS says the page is deliberately kept because Joey's prototype link is already shared publicly, but nothing in that comment or in DECISIONS.md says the missing CSP was a choice. And a grep of the prototype finds no read of location/hash/search/URLSearchParams and no localStorage access, so the only way to inject is the user typing into the field themselves (self-XSS). The same-origin exposure and the missing defences are real, but no attacker path exists today. It is a defence-in-depth gap, so the severity stays low.",
  "merged_ids": [],
  "lane": "L4-web-platform"
}
```

## security-12: Vercel deploy sends no frame-ancestors / X-Frame-Options / nosniff headers, and the meta CSP cannot supply frame-ancestors

**confirmed** · verifier severity **low** (finder: low) · security · security/headers · `vercel.json:13` · L4-web-platform

```json
{
  "id": "security-12",
  "area": "security",
  "category": "security/headers",
  "title": "Vercel deploy sends no frame-ancestors / X-Frame-Options / nosniff headers, and the meta CSP cannot supply frame-ancestors",
  "file": "vercel.json",
  "line": 13,
  "severity": "low",
  "scenario": "index.html's CSP is a <meta> tag, and browsers ignore frame-ancestors in meta CSP. vercel.json's headers block sets only Cache-Control and ACAO, so any site can frame https://foray-web-seven.vercel.app/ and clickjack controls such as Delete my data (drawer), playlist deletion or the thumbs feedback. There is also no X-Content-Type-Options: nosniff on the JSON/data routes.",
  "evidence": "vercel.json `\"headers\": [ { \"source\": \"/data/(.*)\", ... Cache-Control, Access-Control-Allow-Origin }, ... { \"source\": \"/player/(.*)\", ... Cache-Control } ]` — no Content-Security-Policy / X-Frame-Options / X-Content-Type-Options entry.",
  "fix_sketch": "Add a `{ \"source\": \"/(.*)\", \"headers\": [ {\"key\":\"Content-Security-Policy\",\"value\":\"frame-ancestors 'none'\"}, {\"key\":\"X-Content-Type-Options\",\"value\":\"nosniff\"}, {\"key\":\"Referrer-Policy\",\"value\":\"strict-origin-when-cross-origin\"} ] }` rule. Pin it in test/vercel-headers.test.js.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main and the finding holds. vercel.json's headers block has four rules: /data/(.*) (Cache-Control and ACAO:*), the versioned data JSON (immutable Cache-Control and ACAO), the app.js/search-engine.js/styles.css/sw.js rule and /player/(.*). Each one sets only Cache-Control or ACAO. None sets Content-Security-Policy, X-Frame-Options or X-Content-Type-Options.\n\nindex.html:35 sets the CSP only as a <meta http-equiv> tag, and it doesn't include frame-ancestors. It wouldn't help if it did, because browsers ignore frame-ancestors in a meta CSP.\n\nI searched all of origin/main with git grep for frame-ancestors, X-Frame, nosniff and clickjack, and for JS frame-busting (window.top, top !== self). Nothing matched. The repo has no _headers file and no middleware either. docs/DECISIONS.md makes no decision about framing. Its only mention of a response-header CSP (around line 1607) is about the Capacitor Android inline bridge, and it records that choice as deliberately left open. It doesn't accept clickjacking as a risk.\n\nSo any origin can put the app in an iframe. I'm keeping severity at low: the app has no login or credentials to steal, and the valuable targets are per-browser actions like \"Delete my data\", which sits behind a confirm step, so a clickjack would need several precisely placed clicks. The missing nosniff on the JSON routes is defence-in-depth only.",
  "merged_ids": [],
  "lane": "L4-web-platform"
}
```

## data-integrity-4: Family mode lets explicit content through: 157 pool episodes have no `explicit` flag, and show pages skip the filter entirely

**confirmed** · verifier severity **medium** (finder: medium) · data-integrity · data-contract · `app.js:1240` · L1-app-data

```json
{
  "id": "data-integrity-4",
  "area": "data-integrity",
  "category": "data-contract",
  "title": "Family mode lets explicit content through: 157 pool episodes have no `explicit` flag, and show pages skip the filter entirely",
  "file": "app.js",
  "line": 1240,
  "severity": "medium",
  "scenario": "poolFiltered hides only items with explicit === true, plus the comedy branch as a stand-in for 'older items that predate ratings'. On origin/main, 516 of the 2167 discover items have no `explicit` key. 157 of those are outside comedy and belong to shows that have explicitly-rated episodes in the same pool (Ancient History Fangirl 4 explicit + 3 unknown, Lex Fridman 2 + 6, Freakonomics, 20VC, This Week in Startups, Huberman and others), so Family Mode shows them. None of the 27 data/session.json episodes carries the flag either. episodesForShow (line 2913) and the other show-page and Library paths read state.discover.items directly and never call poolFiltered, so a listener with Family Mode on still sees and plays explicit-rated episodes from a show page. No CI invariant requires the field.",
  "evidence": "function poolFiltered() {\n  const pool = fullPool();\n  if (!familyMode()) return pool;\n  return pool.filter(i => i.explicit !== true && branchOf(i) !== \"comedy\");\n}\n...\nfunction episodesForShow(show) { const pool = (state.discover?.items || []); ... return pool.filter(it => wanted.has(it.show)) ... }  // no family check",
  "fix_sketch": "Decide the policy for an unknown flag. The safe choice is fail-closed: treat explicit !== false as hidden in Family Mode, or inherit catalog.json's show-level explicit. Backfill `explicit` on the 516 items (the refresh pipeline already has the iTunes contentAdvisoryRating) and add a CI invariant that every playable discover or session item carries a boolean `explicit`. Route show-page and Library lists through the same family predicate.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I checked this against origin/main and both parts hold.\n\n(1) The filter fails open on unknown ratings. poolFiltered (app.js 1240-1244) hides only items where `explicit === true` or the branch is comedy. The explicitBadge comment at 1245-1258 says the field is tri-state and that null means \"no badge\". That rule was written for the badge, not as a Family Mode policy. The comment at 1022 says only comedy's older items predate ratings. DECISIONS.md line 400 says the family-mode data prerequisite is met, but the data does not back that up.\n\n(2) The data has gaps. In data/discover.json, 516 of the 2167 items have no `explicit` key. 181 of those belong to shows that also have explicit-rated episodes in the pool. Non-comedy examples include Lex Fridman (2 explicit, 6 unknown), Ancient History Fangirl (4 explicit, 3 unknown), 20VC (19, 2), This Week in Startups (7, 2), Founders and The Rest Is History. The finding's figure of 157 after excluding comedy is plausible; I did not recompute branchOf myself.\n\n(3) Show pages skip the filter. episodesForShow (2913-2919) reads state.discover.items directly with no familyMode check. It feeds renderShow's curated episode list (4369) and the \"More from this show\" section on episode pages (9899). With Family Mode on, a listener on a show page still sees and can play episodes that are rated explicit, and those rows even show the \"E\" badge.\n\nI found nothing that handles this elsewhere and no decision that makes it deliberate. I left severity at medium: it is a hole in a child-safety setting, but those rows at least carry the visible explicit badge, and the main feed does filter known-explicit items. I did not check whether session.json episodes carry the flag.",
  "merged_ids": [],
  "lane": "L1-app-data"
}
```

## data-integrity-8: cp_lastpick is write-only: nothing reads it, but every pick still stores a full untrimmed episode snapshot

**confirmed** · verifier severity **low** (finder: low) · data-integrity · dead-code · `app.js:5180` · L2-app-surface

```json
{
  "id": "data-integrity-8",
  "area": "data-integrity",
  "category": "dead-code",
  "title": "cp_lastpick is write-only: nothing reads it, but every pick still stores a full untrimmed episode snapshot",
  "file": "app.js",
  "line": 5180,
  "severity": "low",
  "scenario": "The comment right above the write says the only reader (bannerHtml's Continue banner) was deleted, and Jump back in reads cp_last_episode instead. The key still gets a full liveEpisode() snapshot on every picked link, including a breadth episode's whole publisher description in `hook`, with none of the trimming storableEpisode applies to cp_episode_snaps. It is mirrored into every durable tier and disclosed in the privacy policy for no product purpose, which fails data minimisation and costs storage for nothing.",
  "evidence": "/* ... Nothing renders this record any more: the Continue banner that read it (`bannerHtml`) lost its caller at the U-11 cutover and was deleted ... */\nconst snap = liveEpisode(id);\nif (snap) {\n  lsSet(\"cp_lastpick\", { ...snap, ts: new Date().toISOString() });\n}",
  "fix_sketch": "Delete the write. Remove the key once (removeItem('cp_lastpick') after hydration) and update the privacy-policy row. If a pick record is still wanted, store storableEpisode(snap) at most.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The finding holds at origin/main. In app.js, `cp_lastpick` appears only three times: a comment at 5167, the write at 5180 (`lsSet(\"cp_lastpick\", { ...snap, ts })` with `snap = liveEpisode(id)`), and a historical comment at 9195. A repo-wide `git grep` of the non-archive .js, .json and .html files finds no other reader. The only remaining uses are tests and docs:\n- player/durable-store.test.js uses the key only as an arbitrary fixture name.\n- test/jump-back-in-kinds.test.js asserts that the rail does NOT need `cp_lastpick`.\n\nThe comment right above the write says itself that the only reader, bannerHtml, was deleted. liveEpisode (2443) returns the raw snapshot from `state.itemIndex` or from storage, so the write keeps the full `hook` and any description or chapters. storableEpisode (2402) exists and trims `hook` to EPISODE_SNAP_HOOK_MAX and nulls description and chapters, but this write path does not call it. Nothing makes the write deliberate: the comment only explains why partial snapshots are skipped, and it admits nothing renders the record any more.\n\nA second point strengthens the finding: docs/legal/privacy-policy.md:128 still says \"marking it Done sends `finished`\". The Done button went away with bannerHtml, so that row is stale too.\n\nSeverity stays low. The waste is one overwritten record of bounded size, with no correctness effect. The real problem is data minimisation and an out-of-date privacy-policy row.",
  "merged_ids": [],
  "lane": "L2-app-surface"
}
```

## data-integrity-9: No validator cross-checks the two copies of dai_suspected or that each shipped segment is actually queueable, so a flag drift silently drops tape

**refuted** · verifier severity **low** (finder: low) · data-integrity · data-contract · `tools/foray/check-forays.mjs:669`

```json
{
  "id": "data-integrity-9",
  "area": "data-integrity",
  "category": "data-contract",
  "title": "No validator cross-checks the two copies of dai_suspected or that each shipped segment is actually queueable, so a flag drift silently drops tape",
  "file": "tools/foray/check-forays.mjs",
  "line": 669,
  "severity": "low",
  "scenario": "segments.json carries its own dai_suspected, and merge-segments --check enforces the both-anchors rule against that copy. The player gates on the SOURCE row's flag in segment-sources.json and drops a DAI segment that lacks anchors or reference_duration_sec. check-forays only checks that each flag is a boolean and never compares the two or runs buildForayQueue. validateForayDocuments in the Foray directory reports such drops as warnings and adopts the set. So a source re-flagged as DAI by the nightly classify-dai (the flag is refreshed per show) would make segments vanish from a published Foray's audio with CI green. Today's data agrees: 0 of 255 mismatched.",
  "evidence": "check-forays.mjs: if (typeof s.dai_suspected !== \"boolean\") err(...)   // no cross-check with seg.dai_suspected\nforay-queue.js:367  if (episode.dai_suspected && !(nonEmpty(raw.start_anchor) && nonEmpty(raw.end_anchor))) return drop(\"DAI source without both anchors ...\");\nforay-queue.js:410  if (needsDriftCheck && !isNum(raw.reference_duration_sec)) return drop(...)",
  "fix_sketch": "In checkForays, error when seg.dai_suspected !== sources.get(seg.item_id).dai_suspected. For published Forays, run resolveForay and turn any `unplayable` entry into an error rather than letting it pass silently.",
  "duplicates": [],
  "verdict": "refuted",
  "verdict_severity": "low",
  "verdict_reasoning": "It is true that check-forays.mjs:669 only checks that the source flag is a boolean and never compares it with the segment's own copy. But the scenario the finding describes, where a segment silently drops out of a published Foray, is already blocked by other checks at origin/main.\n\n1. **Missing anchors.** In the per-Foray loop, check-forays.mjs around lines 1557-1595 runs `if (src.dai_suspected === true && !anchored) E(...)`. It does this for every played segment of every Foray, and `src` is the SOURCE row from segment-sources.json, the same row the player gates on. So if the nightly classify-dai job re-flags a source as DAI and a played segment lacks both anchors, check-forays reports an error. That is exactly the player's drop condition at foray-queue.js:367. The comment there (F-74 / #65) says this cross-check is deliberate. On top of that, check-forays.test.mjs:982-993 asserts against live data that every segment of a dai_suspected source carries both anchors.\n\n2. **Missing reference_duration_sec.** tools/segments/merge-segments.mjs:570 requires `reference_duration_sec` to be a number on every pool segment, and CI runs `merge-segments --check` (ci.yml:329). The player's second drop, at foray-queue.js:410, therefore cannot happen whatever the flag says.\n\n3. **Mismatched segment copy.** The player reads the source's flag, not `seg.dai_suspected`, so a mismatch between the two copies has no effect on playback. At most it is cosmetic drift.\n\n4. **Today's data.** All 255 segments have both anchors and a numeric reference_duration_sec, so a flag flip cannot make any of them unplayable.\n\nWhat remains is minor hygiene: the two flag copies are never compared, and resolveForay is not run as a catch-all for any future drop reason.",
  "merged_ids": [],
  "lane": null
}
```

## data-integrity-10: learning_cursor is a per-user server row that 'Delete my data' cannot delete

**confirmed** · verifier severity **low** (finder: low) · data-integrity · privacy · `backend/migrations/supabase/0002_linter_findings.sql:13` · L6-backend-rest

```json
{
  "id": "data-integrity-10",
  "area": "data-integrity",
  "category": "privacy",
  "title": "learning_cursor is a per-user server row that 'Delete my data' cannot delete",
  "file": "backend/migrations/supabase/0002_linter_findings.sql",
  "line": 13,
  "severity": "low",
  "scenario": "learning_cursor (0015) is keyed by user_id and records that user's last event timestamp and id. 0002 enables RLS on it with no policy, so the anonymous client cannot DELETE it, and SB_USER_TABLES (app.js:13788) does not list it. test/data-deletion pins that list only against 0001's policy loop. After a 'successful' deletion the row survives, tied to the account's user_id, even though the policy says the account is left an empty shell.",
  "evidence": "0015_learning_cursor.sql: create table if not exists learning_cursor (user_id uuid primary key, last_event_ts timestamptz not null, last_event_id uuid not null, ...)\n0002: alter table public.learning_cursor enable row level security;   -- no policy\napp.js:13788 const SB_USER_TABLES = [\"events\", \"saved_items\", \"user_interests\", \"sessions\", \"session_items\", \"subscriptions\", \"taxonomy_nodes\", \"app_users\"];",
  "fix_sketch": "Add an own-rows delete policy for learning_cursor and put it in SB_USER_TABLES before app_users. Alternatively, cascade it server-side (FK to app_users(user_id) on delete cascade). Extend the data-deletion test to enumerate every table with a user_id column, not just 0001's list.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "The finding holds at origin/main.\n- backend/migrations/0015_learning_cursor.sql creates learning_cursor(user_id uuid primary key, last_event_ts, last_event_id, updated_at). It has no FK to app_users or auth.users, so nothing cascades.\n- supabase/0002_linter_findings.sql:13 enables RLS on public.learning_cursor with no policy. Its comment says it is deliberately deny-all, because the table is backend-only bookkeeping written by the service-role learning job. An authenticated anonymous client therefore cannot DELETE its own row.\n- app.js:13788 SB_USER_TABLES omits learning_cursor. test/data-deletion.test.js only checks that list against the RLS policy migration, so it cannot catch this.\n- docs/legal/data-safety.md and HUMAN-ACTIONS #14 say the control deletes every row the account owns in every per-user table, leaving only the auth.users shell. #14's fix (delete from auth.users) would not remove the learning_cursor row either, because there is no FK.\n- Nothing in DECISIONS.md treats learning_cursor as exempt from deletion. The deny-all RLS was about the linter, not about deletion, so the gap is an oversight rather than a design choice.\n\nWhy severity is low:\n- The row only exists if the founder has run `npm run learn-interests`, a founder-run CLI, against the Supabase database for that user.\n- It holds only a timestamp and the uuid of an event that has already been deleted. That is minimal data, but it is still tied to the user_id and contradicts the published deletion promise.",
  "merged_ids": [],
  "lane": "L6-backend-rest"
}
```

## perf-2: A data file that times out is served from the previous deploy's cache to live new code, with no pin and no notice (the #233 mismatch)

**confirmed** · verifier severity **medium** (finder: medium) · perf · correctness · `sw.js:745` · L4-web-platform

```json
{
  "id": "perf-2",
  "area": "perf",
  "category": "correctness",
  "title": "A data file that times out is served from the previous deploy's cache to live new code, with no pin and no notice (the #233 mismatch)",
  "file": "sw.js",
  "line": 745,
  "severity": "medium",
  "scenario": "Deploy day on a slow connection. The new deploy's worker has not installed yet (it registers after first paint, at idle), so currentDeployId() still points at the previous generation G1. index.html and app.js answer live from the new generation G2. With no fallback there is no pin, so the page's data/*.json requests go out without a tag. data/discover.json (2.47 MB) or forays.json/segments.json changed in G2 and take longer than NET_TIMEOUT_MS (6 s). handleData then returns G1's cached copy as a plain 200. The page ends up running G2 code against G1 data, which is exactly the pairing the header says 'this file's central mechanism protects fully'. No stale-shell message is sent, so the 'showing last saved copy' bar never appears.",
  "evidence": "sw.js:737-747 `const res = await fromOrigin(request, env); … if (res && res.ok) return res; const current = await currentDeployId(); const cached = current ? await matchGeneration(current, request) : undefined; return cached || res || unavailable(request);`. Only handleShell's code path pins or notifies (sw.js:655-663).",
  "fix_sketch": "When an untagged data request falls back to the cache, pin the page: call env.waitUntil(tellClient(env.clientId, 'stale-shell', {deployId: current})) so the page tags its later data fetches and shows the reload bar. Alternatively, serve the fallback only when the page's code came from the same generation (e.g. check that the live app.js/manifest hash matches the current generation's), and otherwise return unavailable() so fetchJson's existing null/Try again path runs.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read origin/main myself and the finding holds. In sw.js handleData (lines 727-748), an untagged data request calls fromOrigin(), which gives up after NET_TIMEOUT_MS = 6000 (line 168). If the origin has not answered by then, it returns `matchGeneration(currentDeployId(), request)`, the copy from the pointer's generation, as a plain response. It sends no tellClient('stale-shell') and sets no pin. Pinning and notifying happen only in handleShell (lines 655-663), and only when the page's code falls back. So when app.js/index.html answer live, the page has no pinnedDeployId (app.js:34), and pinnedUrl leaves off `_fdid`.\n\nThe scenario is real. On deploy day the old worker still controls the page, and the pointer still names G1 until the new worker's install and activate finish. G2's app.js comes live from the origin; it is small and revalidates quickly. A changed large data file, such as discover.json, forays.json or segments.json, then takes longer than 6 s to download, and the worker serves G1's cached copy. G1 is the source: cachePut refuses to write G2 bytes into G1 because the tracked hash does not match, so the cache only holds G1's verified copy.\n\nThe page's own deadline does not prevent this. fetchJson uses DATA_DEADLINE_MS = 30000, and session.json gets 45000 (app.js:15929-15936). Both are longer than the worker's 6 s, so the worker's fallback wins and the page receives a 200 with G1's data.\n\nIt is not deliberate or already handled. The header (lines 68-89) and DECISIONS.md (the #404 review items 1-7) disclose only the player/client.js parallel-module race. The header explicitly claims that the app.js-vs-data/*.json pairing 'this file's central mechanism protects fully', and this path breaks that claim. No other code checks which generation data belongs to.\n\nThe same thing happens without a pending install: any load where the code revalidates quickly and a data file changed by the nightly pipeline crawls gets the old cached data. That fits the header's own note that data refreshes independently of a deploy.\n\nWhy medium: it needs a changed data file plus a slow link crossing the 6 s threshold, but when it happens it silently recreates the exact code/data mismatch #233 was opened to prevent, and no reload bar appears.",
  "merged_ids": [],
  "lane": "L4-web-platform"
}
```

## perf-3: Every 4 Hz player tick re-parses cp_saved and cp_queue and runs planAfterEnded, through EPISODE_NAVIGATION getters

**confirmed** · verifier severity **low** (finder: medium) · perf · performance · `player/client.js:2712` · L1-app-data

```json
{
  "id": "perf-3",
  "area": "perf",
  "category": "performance",
  "title": "Every 4 Hz player tick re-parses cp_saved and cp_queue and runs planAfterEnded, through EPISODE_NAVIGATION getters",
  "file": "player/client.js",
  "line": 2712,
  "severity": "medium",
  "scenario": "While an ordinary episode plays with the page visible, each timeupdate (about 4/s) runs render(), then paintPage(), then paintEpisodeSurface(). That function reads three things from app.js's EPISODE_NAVIGATION: `nav.next`, a getter that runs planAfterEnded(cur), which calls queueIds() (JSON.parse of cp_queue) and then isPlayableId/liveEpisode over the queue and the play list; `nav.upNextCount`, which parses cp_queue again; and `nav.isSaved(id)`, which JSON.parses all of cp_saved. cp_saved holds full snapshots, with the publisher description stored twice plus chapters (see the next finding). That is 12+ JSON.parse calls per second over blobs that can be hundreds of KB, for as long as audio plays with the screen on. It costs main-thread time and battery, and the result only changes when the queue or saved state changes. perf-7 gated this on document.hidden only, so a visible screen still pays in full. Any queued or listed id that is not playable also falls through to storedEpisode(), which parses cp_saved and cp_episode_snaps on every tick.",
  "evidence": "player/client.js:2712-2714 `hasNext = typeof nav.next === \"function\"; … count = Number(nav.upNextCount) || 0; … saved = … nav.isSaved(id) === true;`, called from paintPage (client.js:1709 onward). app.js EPISODE_NAVIGATION: `get next() { … if (!cur || !planAfterEnded(cur).nextId) return null; …}`, `get upNextCount() { return queueIds().length; }`, `isSaved(id) { return isSaved(id); }`. app.js:1470 `function savedMap() { return lsGet(\"cp_saved\", {}); }` and app.js:133 `JSON.parse(store.getItem(key))`.",
  "fix_sketch": "Compute the sheet's row2 state (hasNext, count, saved) only when it can change. The page already calls refreshEpisodeNavigation() after every queue or star edit and on setNowPlaying, so have that call push a snapshot {hasNext, upNextCount, saved} into the player, and let paintEpisodeSurface read the cached snapshot instead of the getters. Alternatively, memoize lsGet per key on the raw string: keep the last string and its parsed value, and re-parse only when getItem returns a different string.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked this against origin/main and the finding holds. In player/client.js, render() is registered on `timeupdate` at line 3489. At line 1709 it calls paintPage() only while the page is not hidden (the perf-7 gate). paintPage() then calls paintEpisodeSurface() unconditionally at line 1813. paintEpisodeSurface() (lines 2700-2723) reads `nav.next`, `nav.upNextCount` and `nav.isSaved(id)` every time it runs, and the doc comment above it says so on purpose: \"Every reading is a getter on the page's object, taken now\".\n\nThe app.js EPISODE_NAVIGATION at lines 2662-2687 matches the finding:\n- `get next()` calls planAfterEnded(cur), which calls queueIds(). That runs `lsGet(\"cp_queue\")`, a JSON.parse, and then isPlayableId over the queue and possibly the play list.\n- `get upNextCount()` calls queueIds() again, so cp_queue is parsed a second time.\n- `isSaved(id)` calls savedMap(), which is `lsGet(\"cp_saved\")`.\n- lsGet (line 130) does `JSON.parse(store.getItem(key))` with no memoization. The store is window.forayStorage (a durable store whose getItem returns the raw string), so the parse runs on every call.\n\nThat makes at least 3 JSON.parse calls per tick, 12 or more per second, whenever an ordinary episode plays with the page visible. isPlayableId → liveEpisode → storedEpisode() also parses cp_saved and cp_episode_snaps for any queued or listed id that is not in state.poolIds and not already cached with an audio_url. The finding's caveat is right: if such an id is found in storage it gets seeded into itemIndex, but an id that is not playable misses the cache and is re-parsed on every tick.\n\nNothing in DECISIONS.md or the comments justifies the re-parse cost. The \"getters, read now\" design is there so values are fresh, not to accept this cost. refreshEpisodeNavigation() already exists as a change signal the snapshot could use, so the fix sketch is workable.\n\nI rate it low rather than medium. For a typical user with a small queue and a few saved snapshots, these are sub-millisecond parses of tens of KB. The cost only becomes noticeable with a large cp_saved, and the finding says hundreds of KB but I did not verify that. The screen-off case, which dominates long listening such as in a car, is already skipped by perf-7. It is real, avoidable main-thread and battery waste while the screen is on, but not a correctness bug.",
  "merged_ids": [],
  "lane": "L1-app-data"
}
```

## perf-8: The Foray page repaints at 4 Hz while the document is hidden: notifyForay/paintForay is not gated the way paintPage is

**confirmed** · verifier severity **low** (finder: low) · perf · performance · `player/client.js:1719` · L3-player-and-native-tts

```json
{
  "id": "perf-8",
  "area": "perf",
  "category": "performance",
  "title": "The Foray page repaints at 4 Hz while the document is hidden: notifyForay/paintForay is not gated the way paintPage is",
  "file": "player/client.js",
  "line": 1719,
  "severity": "low",
  "scenario": "perf-7 made render() skip paintPage while document.hidden, but the Foray branch still runs notifyForay() on every tick. That calls app.js paintForay(s), which writes #fy-now textContent, paintSegFill's style.width, classList toggles on #fy-strip, setControlLabel on #fy-play, paintRateButton and paintForayNotice, 4 times a second with the screen off in a car for the length of a Foray. reconcileOnReturn already repaints in full when the page becomes visible again.",
  "evidence": "player/client.js:1709 `if (!(typeof document !== \"undefined\" && document.hidden === true)) paintPage(running);` versus client.js:1717-1719 `if (foray) { persistForayProgress(); notifyForay(); }`, where notifyForay does `foray.onChange(forayStateSnapshot())`, which is app.js:12467 `const onChange = (s) => paintForay(s);`.",
  "fix_sketch": "Skip notifyForay() while document.hidden, as paintPage already does. Keep persistForayProgress unconditional. Make sure the visibilitychange/reconcileOnReturn path calls notifyForay() once when the page comes back.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main directly and the finding holds. In player/client.js render(), line 1709 skips paintPage(running) while document.hidden, and the perf-7 comment says \"NOTHING ON THE PAGE IS PAINTED WHILE IT IS HIDDEN\". Lines 1717-1719 still call persistForayProgress() and then notifyForay() unconditionally. notifyForay (line 1377) calls foray.onChange(forayStateSnapshot()). In app.js, onChange at line 12467 is paintForay(s). paintForay writes #fy-now textContent, calls paintSegFill, sets #fy-resume.hidden, setControlLabel(#fy-play), toggles two classes on #fy-strip, and runs paintRateButton and paintForayFailure/paintForayNotice. All of that happens on every 4 Hz tick. The row loop is guarded by state.forayPainted, so the per-tick DOM work is only a handful of nodes.\n\nThe perf-7 comment lists the work that has to keep running while hidden: the media session, the resume row, and the end-of-episode signal. Foray page painting is not on that list. I found nothing in the comments or in docs/DECISIONS.md saying the Foray paint was left ungated on purpose, so this looks like an oversight in perf-7 rather than a deliberate choice.\n\nThe recovery path is already in place: reconcileOnReturn (client.js:2987), which runs on visibilitychange (line 3286), unconditionally calls render(), and render() calls notifyForay(). The fix therefore needs no extra call on return. One caveat for the fix: paintForay also sets app state (state.forayPlaying at app.js:12749), not just DOM. Skipping it while hidden would leave that flag stale until the return repaint. That is harmless in practice, because presses made while the page is hidden come through the player's own media-session path, and render() on return refreshes the flag.\n\nImpact is low: some wasted DOM writes (layout work is minimal while hidden) and a few extra writes to #fy-error, an aria-live region. paintForayNotice skips unchanged text, so the writes are limited. No correctness bug.",
  "merged_ids": [],
  "lane": "L3-player-and-native-tts"
}
```

## arch-drift-2: Publish gate uses a stricter quote normaliser than the narration gate, so quotes the writer accepted fail groundedQuoteRate

**confirmed** · verifier severity **medium** (finder: medium) · arch-drift · duplicated-logic-drift · `backend/src/generation/veracityMetrics.ts:74` · L5-generation

```json
{
  "id": "arch-drift-2",
  "area": "arch-drift",
  "category": "duplicated-logic-drift",
  "title": "Publish gate uses a stricter quote normaliser than the narration gate, so quotes the writer accepted fail groundedQuoteRate",
  "file": "backend/src/generation/veracityMetrics.ts",
  "line": 74,
  "severity": "medium",
  "scenario": "The narration writer's gate (`writeNarration.ts:740` -> `findHoldingDoc`) matches a web-source quote with `normalizeForQuoteMatch`. That function applies NFKC and folds curly quotes, dashes, ellipses and NBSP. The publish metric `computeGroundedQuoteRate` re-checks the same quote with its own `normalizeQuote`, which only collapses whitespace and lowercases. Web evidence text is full of typographic characters. If a model writes `don't` against a page that says `don’t`, or `-` against `—`, the page passes narration and is then counted as `ungrounded-quote`. groundedQuoteRate drops below 1, and `evaluateVeracityGate` makes publishForay refuse the PR. F-81 already fixed this exact drift for TAPE sources ('checked exactly as the narration gate checked it ... so a phrase narration accepted cannot be refused at publish for a punctuation difference the gate forgave'). The non-tape branch a few lines below still uses the old normaliser.",
  "evidence": "veracityMetrics.ts:74 `function normalizeQuote(s: string): string { return s.replace(/\\s+/g, \" \").trim().toLowerCase(); }` and :124 `const needle = normalizeQuote(source.quote); const grounded = needle.length > 0 && haystacks.some((h) => h.includes(needle));`. types/narration.ts:502 `normalizeForQuoteMatch` does `.normalize(\"NFKC\").replace(/[‘’ʼ′`´]/gu, \"'\").replace(/[“”″]/gu, '\"').replace(/[‐-―−]/gu, \"-\").replace(/[…]/gu, \"...\")...`, and findHoldingDoc (narration.ts:582) uses it.",
  "fix_sketch": "Delete `normalizeQuote`. For non-tape sources, count a quote as grounded when `findHoldingDoc(source.quote, page.evidence)` is non-null, the same predicate the writer gate used. Add a test with a curly-apostrophe document and a straight-apostrophe quote that asserts both gates agree.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "I read the code at origin/main and it does what the finding says.\n\n- **Publish metric.** In veracityMetrics.ts, `normalizeQuote` (line 74) only collapses whitespace, trims and lowercases. For non-tape sources, `computeGroundedQuoteRate` (around line 124) counts a quote as grounded only when `normalizeQuote(source.quote)` is a substring of `normalizeQuote(e.text)` for some held evidence doc.\n- **Writer gate.** `gateSelectedClaims` in writeNarration.ts (line 740) accepts a non-tape claim when `findHoldingDoc(claim.quote, [named])` finds it. `findHoldingDoc` (narration.ts:582) compares both sides through `normalizeForQuoteMatch`, which applies NFKC and folds curly quotes, dashes, ellipses and NBSP. Its doc comment says this forgiveness is deliberate (\"characters no reader hears\").\n- **The quote is not rewritten.** `sourcesFor` stores `claim.quote` exactly as the model wrote it. It is never replaced by the document's own span.\n- **Same text on both sides.** `evidenceCarriedBy` (writeAct.ts:1225) fills `page.evidence` from the same `seam.gate.evidence.docs` the gate checked, via `heldDocsOf`, so the publish check sees the same document text.\n- **No normalising on the way in.** gatherEvidence.ts only uses lowercase plus whitespace collapse, and only for a hash key and a search query. The document text itself keeps its typographic characters.\n\nSo a straight-apostrophe quote against a page with a curly apostrophe (or `-` against an em dash, `...` against `…`, or an NBSP) passes the writer gate. The publish metric then counts it as `ungrounded-quote`. groundedQuoteRate falls below 1, and `evaluateVeracityGate` (used by publishForay.ts:752) refuses to publish.\n\nThe F-81 comment fixes this drift for tape sources only, and the non-tape branch still uses the old normaliser. I found no note in DECISIONS.md or in the code comments saying the stricter publish check is intended. The gate comment says the opposite: that a quote the writer gate accepted should not be refused at publish over punctuation.\n\nI did not run a test; I checked this by reading the code. Severity is medium: the failure blocks publishing rather than letting bad content through, but on web sources with typographic punctuation it could block real candidates.",
  "merged_ids": [],
  "lane": "L5-generation"
}
```

## arch-drift-3: D13 shows dedupe key is ASCII-only, so every guid-less show with a non-Latin title and author collapses into one group

**confirmed** · verifier severity **medium** (finder: medium) · arch-drift · duplicated-logic-drift · `tools/shows/dedupe.mjs:19` · L8-data-tools

```json
{
  "id": "arch-drift-3",
  "area": "arch-drift",
  "category": "duplicated-logic-drift",
  "title": "D13 shows dedupe key is ASCII-only, so every guid-less show with a non-Latin title and author collapses into one group",
  "file": "tools/shows/dedupe.mjs",
  "line": 19,
  "severity": "medium",
  "scenario": "`groupKeyFor` falls back to `ta:${normalizeKey(title)}|${normalizeKey(author)}` when a row has no podcastGuid. `normalizeKey` removes everything outside `[a-z0-9]`. A Japanese, Chinese, Arabic, Cyrillic or Korean show without a guid therefore gets the key `ta:|`, and all such shows in the dump land in one group. `pickCanonical` keeps one and silently drops the rest from the shows index (reported only as `duplicates_collapsed`). The language filter is deliberately open (filter.mjs header), so these rows are meant to survive. The app's and API's title rules (`normaliseShowTitle`, `SHOW_WORD_BREAK`) use `\\p{L}\\p{N}` for exactly this reason. Reproduced on origin/main: three unrelated shows (`伊藤洋一のポッドキャスト`/`日本放送`, `Радио Свобода`/`РС`, `صوت`) -> `groups: 1, duplicates_collapsed: 2`.",
  "evidence": "dedupe.mjs:14-22 `.normalize(\"NFKD\").replace(/[̀-ͯ]/g, \"\").replace(/[^a-z0-9]+/g, \" \")`. :28-34 `const title = normalizeKey(row.title); const author = normalizeKey(row.itunesAuthor || row.itunesOwnerName || \"\"); return { key: `ta:${title}|${author}`, kind: \"title_author\" };` has no empty-key guard. backend/src/identity/dedup.ts has the same ASCII class but at least refuses empty titles (`if (normalizeTitle(a.title).length === 0) return false`).",
  "fix_sketch": "Use the Unicode classes the rest of the repo uses: `.replace(/[^\\p{L}\\p{N}]+/gu, \" \")`, with NFKD applied before lowercasing, matching normaliseShowTitle. When the normalised title is empty, key the row by its own id (`id:${row.id}`) so it never groups. Add the three-script fixture above as a test.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "medium",
  "verdict_reasoning": "The finding holds at origin/main. In tools/shows/dedupe.mjs, lines 14-22 (`normalizeKey`) lowercase the string, apply NFKD, strip combining marks, then `.replace(/[^a-z0-9]+/g, \" \")`, so any title written only in a non-Latin script comes out empty. `groupKeyFor` (lines 28-34) falls back to `ta:${title}|${author}` with no guard for an empty key. `applyD13Dedupe` groups rows by that key and keeps one canonical row per group. The only trace of the lost rows is the `duplicates_collapsed` count.\n\nI reproduced it. I ran the origin/main dedupe.mjs from the scratchpad, with `isCuratedRow` stubbed to return false, on three unrelated shows (a Japanese title and author, a Russian title and author, an Arabic title with no author). The result was `groups: 1, title_author_groups: 1, canonical_rows: 1, duplicates_collapsed: 2`.\n\nNothing makes this deliberate. docs/DECISIONS.md (around line 2779) describes the title+author fallback only as \"accent-folded, punctuation-collapsed\" and never says non-Latin titles should be dropped or merged. The same document, and the header of filter.mjs, say the language filter is left open on purpose, so these rows are meant to reach this stage. I found no guard elsewhere in the pipeline (import-dump.mjs calls `applyD13Dedupe` directly).\n\nSeverity stays medium. The fallback only applies to rows without a podcastGuid, and many Podcast Index rows have one. Where it does apply, every guid-less show with a non-Latin title and author silently collapses into one group. Titles that mix scripts are also affected: they reduce to their Latin fragment, so they can merge with unrelated shows that share that fragment. It is data loss in the shows index, but it does not crash anything and it only hits that subset of rows.",
  "merged_ids": [],
  "lane": "L8-data-tools"
}
```

## arch-drift-4: Jingle item runtime is hard-coded to 1.5 s and labelled MEASURED, but the asset it plays is the 3.0 s interlude file

**confirmed** · verifier severity **low** (finder: low) · arch-drift · duplicated-constant-drift · `player/foray-queue.js:102` · L3-player-and-native-tts

```json
{
  "id": "arch-drift-4",
  "area": "arch-drift",
  "category": "duplicated-constant-drift",
  "title": "Jingle item runtime is hard-coded to 1.5 s and labelled MEASURED, but the asset it plays is the 3.0 s interlude file",
  "file": "player/foray-queue.js",
  "line": 102,
  "severity": "low",
  "scenario": "F-90 pointed `JINGLE_ASSET_URL` at the same `interlude-placeholder.wav` that `interlude.js` plays, and foray-queue.test.js pins the two URLs equal. The duration constants were never reconciled. interlude.js pins `INTERLUDE_DURATION_SEC = 3.0` against the WAV header, while the jingle item says 1.5 s with `duration_source: DURATION_MEASURED`. The only shipped Foray with a `type: \"jingle\"` item therefore plays 3.0 s of audio while `itemRuntimeSec`, the segment-strip offsets, the Foray clock/resume math, check-forays' D1 runtime and backend `runtimeSecFor` all count 1.5 s. Every later segment's position drifts 1.5 s per jingle, and the provenance claims a measurement nobody took. A third copy lives in backend/src/generation/runPipeline.ts:504.",
  "evidence": "foray-queue.js:95 `JINGLE_ASSET_URL = \".../player/assets/interlude-placeholder.wav\"`; :102 `export const JINGLE_DURATION_SEC = 1.5;`; :334-335 `audio_url: JINGLE_ASSET_URL, duration_sec: JINGLE_DURATION_SEC, duration_source: DURATION_MEASURED`. interlude.js:103 `export const INTERLUDE_DURATION_SEC = 3.0;` (interlude.test.js:332 asserts the file measures 3.0 s). runPipeline.ts:504 `export const JINGLE_DURATION_SEC = 1.5;`.",
  "fix_sketch": "Derive the jingle length from the file it plays: set JINGLE_DURATION_SEC = 3.0, or split JINGLE_ASSET_PATH/DURATION into a leaf module both files import. Extend foray-queue.test.js to assert JINGLE_DURATION_SEC === INTERLUDE_DURATION_SEC alongside the URL check, and pin runPipeline's copy to it in a backend test. Then re-run check-forays so runtime_sec is restated.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked this against origin/main and it holds. In player/foray-queue.js, line 95 points JINGLE_ASSET_URL at .../player/assets/interlude-placeholder.wav. That is the same file interlude.js plays; the F-90 comment says so and says the test keeps the two URLs equal. Line 102 still sets JINGLE_DURATION_SEC = 1.5. Its doc comment says \"roughly 1-2 seconds (§4.8)\" and \"update this one constant the day the real asset is cut\". That comment was written for the TBD asset and was never updated when F-90 switched to the placeholder. Meanwhile interlude.js:103 sets INTERLUDE_DURATION_SEC = 3.0 and notes that interlude.test.js checks it against the WAV header. The jingle queue item at foray-queue.js:333-335 is emitted with duration_sec: JINGLE_DURATION_SEC and duration_source: DURATION_MEASURED. That label is wrong on its own terms, because the constant's own comment says \"Fixed rather than measured\". The same 1.5 is used in three more places: tools/foray/check-forays.mjs imports it (lines 1158/1160, timeline and runtime), backend/src/generation/runPipeline.ts:504 keeps its own copy, and runPipeline.ts:542 adds it to runtime. data/forays.json:1588 ships a real jingle item (jingle-cut-act-4-1), so this happens in live data. The media element plays the whole 3.0 s file to its ended event; nothing I found cuts it off at duration_sec. Every such jingle is therefore undercounted by 1.5 s in runtime, segment offsets and resume math. I found nothing in docs/DECISIONS.md or the code comments that treats the mismatch as intended; the comments point the other way. I kept severity at low: it is 1.5 s per jingle, there is one jingle item in shipped data, the asset is a placeholder, and the effect is clock/offset drift, not a playback failure. I did not run a test; reading the code was enough.",
  "merged_ids": [],
  "lane": "L3-player-and-native-tts"
}
```

## arch-drift-5: Four drifted copies of the itunes:duration parser in tools/ reject decimal seconds that the backend parser accepts

**confirmed** · verifier severity **low** (finder: low) · arch-drift · duplicated-logic-drift · `tools/refresh/enclosure.mjs:51` · L8-data-tools

```json
{
  "id": "arch-drift-5",
  "area": "arch-drift",
  "category": "duplicated-logic-drift",
  "title": "Four drifted copies of the itunes:duration parser in tools/ reject decimal seconds that the backend parser accepts",
  "file": "tools/refresh/enclosure.mjs",
  "line": 51,
  "severity": "low",
  "scenario": "`normDuration` is copy-pasted into scan.mjs:56, backfill-show.mjs:76 and harvest-episodes.mjs:40, and `durationSeconds` sits in enclosure.mjs:51. scan.mjs runs two of them on the same raw value (lines 144-145). None of them handles decimal seconds. A feed that emits `<itunes:duration>1834.5</itunes:duration>` gets `duration_min: null` and `duration_sec: null` from the nightly refresh, so the row shows no length and no progress label. backend/src/feeds/duration.ts `normalizeDuration` parses that same value (`floatMatch`) and also rejects out-of-range MM:SS components, which the tools copies accept (`12:75` -> 13 min).",
  "evidence": "enclosure.mjs:51-61: `if (/^\\d+$/.test(s)) return Number(s); const parts = s.split(\":\").map(Number); ... if (parts.length === 3) ...; if (parts.length === 2) ...; return null;` (a single decimal part falls through to null). scan.mjs:56-64 is the identical minutes variant. duration.ts: `const floatMatch = rawString.match(/^\\d+\\.\\d+$/); if (floatMatch) return { seconds: Math.round(parseFloat(rawString)) ... }`.",
  "fix_sketch": "Keep one parser: `durationSeconds` in enclosure.mjs, extended with the decimal and out-of-range rules from duration.ts. Delete the three `normDuration` copies and derive minutes with `minutesFromSeconds(durationSeconds(raw))` from check-durations.mjs, which merge.mjs already uses. Add a parity test against backend normalizeDuration's fixture table.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read the code at origin/main and ran the function; the finding holds.\n\n- **Decimal seconds are rejected.** In tools/refresh/enclosure.mjs:51, `durationSeconds` handles `/^\\d+$/` and then splits on \":\". A value like \"1834.5\" becomes a one-element array, so it falls through to `return null`. Importing the origin/main file and running it gave `durationSeconds(\"1834.5\") === null`.\n- **The three `normDuration` copies behave the same way.** They are at scan.mjs:56, backfill-show.mjs:76 (exported) and harvest-episodes.mjs:40, and each converts to minutes.\n- **scan.mjs runs two parsers on the same raw value.** Line 144 has `duration_min: normDuration(it[\"itunes:duration\"])`. Line 145 has `duration_sec: audio.duration_sec`, and that value comes from `durationSeconds` at enclosure.mjs:121. So a decimal duration yields null for both fields.\n- **Out-of-range components are accepted.** `durationSeconds(\"12:75\")` returned 795, which is 13 min. The backend returns null for it.\n- **The backend parser differs.** `normalizeDuration` in backend/src/feeds/duration.ts has an explicit `floatMatch` branch for decimal seconds (\"1834.5\") and rejects out-of-range components.\n\nI found nothing in docs/DECISIONS.md or in any code comment that makes this deliberate. The 2026-09-23 \"one duration dialect\" ruling is about display copy, not parsing. That ruling plus check-durations.mjs does show the project cares about `duration_min` and `duration_sec` being consistent, so drift here matters.\n\nNothing else handles decimals for these tools. The same `durationSeconds` is also imported by tools/segments/sweep-transcripts.mjs:242, so the gap reaches that tool as well.\n\nSeverity is low. Decimal itunes:duration values are uncommon. The result is a missing length label (null), not bad data; the `12:75` case is the only one that produces a slightly wrong number.",
  "merged_ids": [],
  "lane": "L8-data-tools"
}
```

## arch-drift-6: search-probe's normaliseTitle claims to be verbatim from the API/app rule but lacks the NFKD diacritic fold

**confirmed** · verifier severity **low** (finder: low) · arch-drift · duplicated-logic-drift · `tools/search-probe.mjs:374` · L8-data-tools

```json
{
  "id": "arch-drift-6",
  "area": "arch-drift",
  "category": "duplicated-logic-drift",
  "title": "search-probe's normaliseTitle claims to be verbatim from the API/app rule but lacks the NFKD diacritic fold",
  "file": "tools/search-probe.mjs",
  "line": 374,
  "severity": "low",
  "scenario": "`targetRank` finds a target show in the endpoint's results by comparing normalised titles. The comment says the rule is 'verbatim from api/shows/appleShowSearch.ts normaliseShowTitle and app.js's copy'. Both of those now apply `normalize(\"NFKD\")`, strip combining marks, and lowercase last (search-9, the mathematical-bold fix). The probe copy is the old rule. A target such as `Café …`, or a result Apple returns in a compatibility font, never equals the target key, so the probe reports the show as absent (rank null). That is a false search regression in the tool used to measure search quality. It is not pinned by the test that pins the other two copies (show-search-fallthrough.test.js).",
  "evidence": "search-probe.mjs:374-376 `export function normaliseTitle(title) { return String(title || \"\").toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, \" \").trim(); }` vs appleShowSearch.ts:175 / app.js:7241 `String(title || \"\").normalize(\"NFKD\").replace(/[̀-ͯ]/g, \"\").toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, \" \").trim()`.",
  "fix_sketch": "Copy the current expression into the probe and add search-probe.mjs to the file list test/show-search-fallthrough.test.js compares. Or have the probe import `normaliseShowTitle` from the API module via tsx, since it is a Node tool.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked this against origin/main and the divergence is real. tools/search-probe.mjs:370-376 has a doc comment saying the rule is \"verbatim from api/shows/appleShowSearch.ts's normaliseShowTitle and app.js's copy of it\", but the function body is `String(title||\"\").toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu,\" \").trim()`. appleShowSearch.ts:174 and app.js:7242 both use `.normalize(\"NFKD\").replace(/[̀-ͯ]/g,\"\").toLowerCase()...`, which folds diacritics and compatibility characters before lowercasing. The test that ties the two copies together (test/show-search-fallthrough.test.js:510, \"the two normalised-title rules are one rule\") compares only app.js and the API copy; the probe is not included. I found no entry in docs/DECISIONS.md and no code comment that explains the probe difference as deliberate. The comment's claim is simply stale.\n\nThe practical impact today is latent. targetRank is used at lines 269-270 for the index battery reach and at lines 409/412 for the parity battery. Every configured target is plain ASCII: The Daily, Dan Carlin's Hardcore History, This American Life, Planet Money, Science Vs, The Tim Ferriss Show, Lex Fridman Podcast, and Making Sense with Sam Harris. For those targets, both rules match the canonical ASCII result row the same way. The drift only matters in three cases:\n1. Someone adds a target with a diacritic, such as Café, and Apple returns it in a different form.\n2. A stylised-font duplicate of a target appears in the results. The app would treat it as the same show, while the probe would not count it, which could shift the reported rank.\n3. The target appears only in a compatibility-font form, so the probe reports it absent.\n\nThat makes this a real inconsistency and a false \"verbatim\" claim in a measurement tool, with no current false regression for the configured cases. Severity is low. The fix sketch is appropriate: copy the current expression into the probe and add the probe to the parity test, or import the API function directly.",
  "merged_ids": [],
  "lane": "L8-data-tools"
}
```

## arch-drift-7: POINTER_SCHEMA_VERSION is dead; buildPointer hard-codes version 1 even though S-04c changed the pointer's shape

**confirmed** · verifier severity **low** (finder: low) · arch-drift · dead-code/stale-comment · `tools/shows/config.mjs:71` · L8-data-tools

```json
{
  "id": "arch-drift-7",
  "area": "arch-drift",
  "category": "dead-code/stale-comment",
  "title": "POINTER_SCHEMA_VERSION is dead; buildPointer hard-codes version 1 even though S-04c changed the pointer's shape",
  "file": "tools/shows/config.mjs",
  "line": 71,
  "severity": "low",
  "scenario": "config.mjs says the pointer version is 'Bumped whenever the pointer's own shape changes' and exports POINTER_SCHEMA_VERSION = 1, but nothing reads it. `buildPointer` writes a literal `version: 1`. S-04c added `shards_published` and `shard_releases` without a bump, so the committed data/shows-index-pointer.json (no shard fields) and a new-shape pointer both say version 1. Any consumer that branches on `version` cannot tell them apart, and bumping the constant would change nothing.",
  "evidence": "config.mjs:66-71 comment plus `export const POINTER_SCHEMA_VERSION = 1;` has no importer anywhere (repo-wide grep). publish-release.mjs:163-176 `return { version: 1, export_version: exportVersion, ... shards_published: shardsPublished, shard_releases: shardReleases };`.",
  "fix_sketch": "Import POINTER_SCHEMA_VERSION in publish-release.mjs and use it in buildPointer. Bump it to 2 for the shard-range shape, or delete the constant and its comment if versioning is not wanted. Add a buildPointer test that asserts `version === POINTER_SCHEMA_VERSION`.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read origin/main and the facts in the finding are correct. In tools/shows/config.mjs, lines 66-71 say the pointer version is \"Bumped whenever the pointer's own shape changes\" and export `POINTER_SCHEMA_VERSION = 1`. A repo-wide `git grep` at origin/main finds it only on that line, so nothing imports it. In tools/shows/publish-release.mjs, `buildPointer` (about lines 163-177) returns a literal `version: 1` and also writes `shards_published` and `shard_releases` (S-04c). The committed data/shows-index-pointer.json says `version: 1` and has no shard fields, so pointers with two different shapes carry the same version, and bumping the constant would change nothing. docs/DECISIONS.md says nothing about the shows pointer schema version (its pointer-version mentions are about the forays directory's deploy_id), so nothing records this as deliberate.\n\nIt stays low severity because the S-04c change only adds fields. The reader in api/shows/index/[...path].ts declares both fields optional (`shard_releases?`, `shards_published?`) and treats an empty or missing `shard_releases` as a pre-S-04c pointer. That reader and api/episodes/showIdMap.ts never check the pointer's `version`. The finding's scenario (\"any consumer that branches on version cannot tell them apart\") is therefore hypothetical: no consumer today misbehaves. The real defect is a dead constant with a misleading contract comment and an unenforced versioning policy. I did not use the one allowed test run because reading the code settled the question.",
  "merged_ids": [],
  "lane": "L8-data-tools"
}
```

## arch-drift-8: Dead backend modules: feeds/redirect.ts, feeds/politeness.ts (with a stale DAI host list), clients/itunes.ts, clients/podcastIndex.ts, curation/ladderProgress.ts

**deliberate** · verifier severity **low** (finder: low) · arch-drift · dead-code · `backend/src/feeds/politeness.ts:102`

```json
{
  "id": "arch-drift-8",
  "area": "arch-drift",
  "category": "dead-code",
  "title": "Dead backend modules: feeds/redirect.ts, feeds/politeness.ts (with a stale DAI host list), clients/itunes.ts, clients/podcastIndex.ts, curation/ladderProgress.ts",
  "file": "backend/src/feeds/politeness.ts",
  "line": 102,
  "severity": "low",
  "scenario": "No production file (backend/src, api/, tools/) imports these five modules. Only their own tests do. They still carry behaviour claims: redirect.ts says it 'exists for dedup / DAI-host detection / broken-link fallback', and politeness.ts ships a hard-coded 6-host `KNOWN_DAI_HOSTS` that has drifted from the data-driven list the real DAI classifier uses (tools/refresh/dai.mjs `DAI_HOSTS = list.hosts...`, which also covers podtrac, pdst.fm and others). A future caller that reaches for `hostSuggestsDai` gets a different answer from the pipeline that actually classifies DAI, and the tests keep the dead copies looking maintained.",
  "evidence": "A module-importer scan of origin/main finds zero non-test importers for backend/src/clients/itunes.ts, clients/podcastIndex.ts, feeds/redirect.ts, curation/ladderProgress.ts. `feeds/politeness` is imported only by backend/test/politeness.test.ts. politeness.ts:102-109 `KNOWN_DAI_HOSTS = new Set([\"megaphone.fm\",\"traffic.megaphone.fm\",\"acast.com\",\"sphinx.acast.com\",\"art19.com\",\"rss.art19.com\"])`.",
  "fix_sketch": "Delete the five modules and their tests, or move them to archive/. If DAI host detection is needed in the backend, read the same host list tools/refresh/dai.mjs reads rather than keeping a second literal set.",
  "duplicates": [],
  "verdict": "deliberate",
  "verdict_severity": "low",
  "verdict_reasoning": "The facts in the finding are correct, but keeping these modules is a documented choice, so \"dead code to delete\" is the wrong reading.\n\nConfirmed at origin/main:\n- A git grep of import/require statements across .ts, .tsx, .js, .mjs and .cjs files finds that backend/src/feeds/redirect.ts, feeds/politeness.ts, clients/itunes.ts, clients/podcastIndex.ts and curation/ladderProgress.ts are each imported only by their own backend/test/*.test.ts file.\n- The tools/*/politeness.mjs imports belong to a different module, tools/segments/politeness.mjs.\n- politeness.ts:102-109 does hard-code the 6-host KNOWN_DAI_HOSTS set.\n- tools/refresh/dai.mjs:56 builds DAI_HOSTS from the data-driven `list.hosts`, so the two lists can drift.\n\nWhy it is deliberate:\n- backend/README.md \"Stubbed / not implemented\" says there is \"No ingest worker / scheduler ... the primitives it needs (conditional GET, politeness budget, dedup, parser) are built and tested; the orchestration loop is not. See ADR 0001.\"\n- The README directory guide lists the redirect resolver, the politeness budget and the iTunes/Podcast Index clients (\"both dry-run-safe\") as intended backend primitives.\n- docs/DECISIONS.md:877 says the \"backend PI client stays dry-run-optional\".\n- docs/DECISIONS.md:894 names backend/src/curation/ladderProgress.ts as \"the reference algorithm\", written once as a pure function, that \"the future client pass should port or call ... rather than re-deriving the rules\".\n- backend/fixtures/feeds/README.md:107 also refers to KNOWN_DAI_HOSTS as the seed for the future `dai_suspected` detection.\n\nSo these are staged, tested primitives for work that has not been built yet, not forgotten leftovers. Deleting them would go against DECISIONS 877/894 and ADR 0001's staging.\n\nWhat remains valid is a small nit. hostSuggestsDai has no caller today, so it causes no wrong behaviour now. Its fixed host list has drifted from the list the refresh pipeline actually uses. Whoever builds the ingest worker should point it at the same host list dai.mjs reads. Low severity.",
  "merged_ids": [],
  "lane": null
}
```

## arch-drift-10: Three clock formatters round differently, and seek-policy's 'ONLY approved way' comment is false

**confirmed** · verifier severity **low** (finder: low) · arch-drift · duplicated-logic-drift · `player/seek-policy.js:261` · L3-player-and-native-tts

```json
{
  "id": "arch-drift-10",
  "area": "arch-drift",
  "category": "duplicated-logic-drift",
  "title": "Three clock formatters round differently, and seek-policy's 'ONLY approved way' comment is false",
  "file": "player/seek-policy.js",
  "line": 261,
  "severity": "low",
  "scenario": "`formatTimestamp`'s doc says 'Render a timestamp for display. The ONLY approved way to show one.' The app actually uses three clock renderers: `hms` (Math.round) via formatTimestamp for episode Now Playing, `fmtClock` (Math.floor) in foray-resolve.js for Foray playheads, and `fmtChapterTime` (Math.round) in app.js for description chapter stamps. The same position can read differently depending on the surface. An episode at 3599.6 s of 3600 reads '1:00:00 of 1:00:00' while still playing. A Foray at 59.6 s reads '0:59' where an episode at the same second reads '1:00'. The approximate branch (`~68 min`) also does not follow the round-2 duration dialect ('1 hr 8 min'), though nothing calls it with APPROXIMATE today.",
  "evidence": "seek-policy.js:250-258 `function hms(totalSeconds) { const s = Math.max(0, Math.round(totalSeconds)); ...`. foray-resolve.js:736-744 `export function fmtClock(sec) { const total = isNum(sec) && sec > 0 ? Math.floor(sec) : 0; ...`. app.js:9917-9925 `function fmtChapterTime(seconds) { const s = Math.max(0, Math.round(Number(seconds) || 0)); ...`. client.js:1828/1837 picks fmtClock or formatTimestamp depending on Foray vs episode.",
  "fix_sketch": "Choose one rounding rule (floor is right for a live playhead) and apply it in hms, fmtClock and fmtChapterTime. Make fmtClock and formatTimestamp(EXACT) share one implementation, and pin fmtChapterTime to it the same way format-helpers.test.js pins fmtDur/fmtSpan. Reword the 'ONLY approved' comment to name the real set.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked the code at origin/main and it matches the finding. There is one path correction: the chapter formatter is in the root app.js, not player/app.js.\n\nWhat the code does:\n- seek-policy.js:250 `hms` uses Math.round, and the comment on `formatTimestamp` at line 261 says \"The ONLY approved way to show one.\"\n- foray-resolve.js:736 `fmtClock` uses Math.floor.\n- app.js:9917 `fmtChapterTime` uses Math.round.\n- client.js `paintClocks` (about lines 1826-1837) picks `fmtClock` with floor for a Foray and `formatTimestamp` with round for an episode.\n\nThe scenario holds. At 3599.6 s of a 3600 s episode, the position shows \"1:00:00\" and the remaining time is round(3600) - round(3599.6) = 0, while audio is still playing. At 59.6 s, a Foray shows 0:59 and an episode shows 1:00.\n\nArguments for refuting, and why they do not change the verdict:\n1. Part of the split is known and intended. The client.js comment above `paintClocks` says \"elapsed rounds (episode) or floors (Foray) on its own\". It then derives each countdown from its own clock so the two numbers add up. That solves the \"13 + 48 = 61\" problem inside each clock, but it does not make the two clocks agree with each other.\n2. The `fmtClock` doc says on purpose that it is separate from `formatTimestamp`: \"formatTimestamp exists for a position in one episode and deliberately signals imprecision, which is not this number's problem\". So having two formatters is a design choice. That same comment also shows the \"ONLY approved way\" comment in seek-policy is stale, which is the finding's second claim.\n3. `fmtChapterTime` formats publisher chapter start times, which are usually whole seconds, so its rounding almost never shows.\n\nThe minor claim also holds: the approximate branch outputs \"~68 min\", not \"1 hr 8 min\", and nothing passes APPROXIMATE to it today.\n\nI found no DECISIONS.md entry that settles the rounding rule. The worst visible effect is a clock that is off by less than one second, plus a false comment. It does not affect correctness or seeking, so severity is low.",
  "merged_ids": [],
  "lane": "L3-player-and-native-tts"
}
```

## arch-drift-12: api/*.ts is never type-checked: the backend typecheck gate added on 2026-09-12 does not cover the Vercel functions

**confirmed** · verifier severity **low** (finder: low) · arch-drift · ci-tooling · `.github/workflows/ci.yml:50` · L7-ci-release-security

```json
{
  "id": "arch-drift-12",
  "area": "arch-drift",
  "category": "ci-tooling",
  "title": "api/*.ts is never type-checked: the backend typecheck gate added on 2026-09-12 does not cover the Vercel functions",
  "file": ".github/workflows/ci.yml",
  "line": 50,
  "severity": "low",
  "scenario": "The api job runs `node --import tsx --test`. tsx strips types per file and never checks them, the problem the backend job's comment names ('vitest ... transpiles per file and never type-checks, so a signature change that breaks a caller vitest does not execute is green'). api/ has no tsconfig, and backend/tsconfig.json includes only `src` and `test`. The api handlers import backend modules directly (parseFeed, ingestShowFeed, fetchFeedConditional, searchBreadthShows). A backend signature change that breaks an api handler passes both CI jobs unless an api test happens to execute that path.",
  "evidence": "ci.yml:47 `- run: npm run typecheck` appears only in the backend job. api/package.json `\"test\": \"node --import tsx --test\"` has no typecheck script. `git ls-tree origin/main api/` shows no tsconfig. backend/tsconfig.json `\"include\": [\"src\", \"test\"]`.",
  "fix_sketch": "Add api/tsconfig.json (extend backend's, include `**/*.ts` and ../backend/src) with a `typecheck` script running `tsc --noEmit`, and call it in the api job before `npm test`.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I checked this against origin/main and it holds. In ci.yml, `npm run typecheck` (line 47) appears only in the `backend` job. The `api` job runs `npm install`, then `npm install --omit=dev --prefix ../backend`, then `npm test`, and nothing else. api/package.json has one script, `\"test\": \"node --import tsx --test\"`. tsx strips types without checking them, which is the same gap the backend job's comment describes for vitest. No tsconfig exists under api/: the only tsconfig files in the repo are backend/tsconfig.json and backend/tsconfig.build.json. backend/tsconfig.json has `\"include\": [\"src\", \"test\"]`, and no backend src or test file imports from api/, so tsc never reaches the api files even indirectly. The api handlers do import backend modules directly: episodes/search.ts imports fetchFeedConditional and parseFeed, shows/[show_id]/episodes.ts imports ingestShowFeed, PostgresShowEpisodesStore, fetchFeedConditional and parseFeed, and shows/search.ts imports searchBreadthShows and loadBreadthCatalog. So a backend signature change can break an api caller and still pass the typecheck, because backend's type gate never looks at api/.\n\nI found no deliberate exemption. The ci.yml api-job comment explains only why api is kept out of data-and-site discovery and out of the required checks. It says nothing about type-checking. Neither docs/DECISIONS.md nor any api file mentions typecheck or tsc. The only hint is a comment in api/test/import-closure.test.mjs that says an unresolved import \"would fail typecheck/build separately\". That assumes a typecheck that does not exist in CI.\n\nSeverity stays low for three reasons. First, api/test holds 11 test files, including end-to-end handler tests (episodes-search, episodes-no-db, shows-search-apple, vercel-bundle), so many call paths do run. Second, the api job is not a required check anyway. Third, Vercel's own build of the TypeScript functions may surface type errors, but that happens outside CI and I did not verify whether it blocks a deploy. The fix sketch is reasonable: add an api tsconfig that includes the api files plus ../backend/src and run `tsc --noEmit` before the tests.",
  "merged_ids": [],
  "lane": "L7-ci-release-security"
}
```

## arch-drift-14: API handlers restate the feed User-Agent literal instead of importing the backend constant the tools scan pins

**confirmed** · verifier severity **low** (finder: low) · arch-drift · duplicated-constant · `api/episodes/search.ts:57` · L4-web-platform

```json
{
  "id": "arch-drift-14",
  "area": "arch-drift",
  "category": "duplicated-constant",
  "title": "API handlers restate the feed User-Agent literal instead of importing the backend constant the tools scan pins",
  "file": "api/episodes/search.ts",
  "line": 57,
  "severity": "low",
  "scenario": "tools/segments/politeness.mjs documents that this exact UA string was spelled out ten times, and that one drifted copy (`Foray/0.1` with no contact) made a Buzzsprout edge answer 403 and left 423 transcripts unmeasurable. The fix consolidated tools/ and pinned backend's DEFAULT_FEED_USER_AGENT by test, but api/ still has two private copies. Both match today. Neither is covered by politeness.test.mjs's scan, which only walks tools/. Both api modules already import from backend/src, so the constant is one import away.",
  "evidence": "api/episodes/search.ts:57 `const EPISODE_USER_AGENT = \"Foray/0.1 (personal podcast client; contact wjduvall@gmail.com)\";`. api/shows/appleShowSearch.ts:91 `const SHOW_USER_AGENT = \"Foray/0.1 (personal podcast client; contact wjduvall@gmail.com)\";`. backend/src/feeds/userAgent.ts:19 `export const DEFAULT_FEED_USER_AGENT = ...`.",
  "fix_sketch": "Import DEFAULT_FEED_USER_AGENT from backend/src/feeds/userAgent in both api files and delete the literals. Extend the politeness UA scan to api/.",
  "duplicates": [],
  "verdict": "confirmed",
  "verdict_severity": "low",
  "verdict_reasoning": "I read the code at origin/main and the finding holds. api/episodes/search.ts:57 defines EPISODE_USER_AGENT as its own copy of the literal. It sends it to Apple on line 216 and passes it as userAgent to the feed fetch on line 267. api/shows/appleShowSearch.ts:91 defines SHOW_USER_AGENT as another copy, with the comment \"Verbatim from api/episodes/search.ts\", and sends it on line 360. backend/src/feeds/userAgent.ts:19 exports DEFAULT_FEED_USER_AGENT. That file has zero imports and was written so api/** can import it safely. All three strings match today.\n\nNothing protects the api copies. `git grep \"Foray/0.1\" -- api` finds only these two lines, so no api test pins them. The politeness.test.mjs scan runs only on `git ls-files tools/` (.mjs/.js). Its backend pin covers backend/src, not api/.\n\nI found nothing saying the copies are deliberate. DECISIONS.md has no ruling on it, and no comment gives a reason to keep them.\n\nOne detail in the finding is wrong. It says both api modules already import from backend/src. search.ts does (conditionalGet, parser). appleShowSearch.ts does not: it imports only from ../episodes. Either file can still import userAgent.ts with no dependency cost, so the fix is still trivial.\n\nSeverity is low: nothing has drifted yet and nothing is broken. The risk is that a future change edits one copy and not the others, which is the same failure behind #316.",
  "merged_ids": [],
  "lane": "L4-web-platform"
}
```

## arch-drift-15: diagnostic-record tests wait on real wall-clock sleeps with a 250 ms margin over the seam beat

**refuted** · verifier severity **low** (finder: low) · arch-drift · flaky-test · `player/diagnostic-record.test.js:299`

```json
{
  "id": "arch-drift-15",
  "area": "arch-drift",
  "category": "flaky-test",
  "title": "diagnostic-record tests wait on real wall-clock sleeps with a 250 ms margin over the seam beat",
  "file": "player/diagnostic-record.test.js",
  "line": 299,
  "severity": "low",
  "scenario": "`beat()` sleeps SEAM_GAP_SEC*1000 + 250 ms of real time (750 ms since #794) and then asserts that the seam completed (`seams.length === 1`, `lastStage === \"playing\"`). The player's seam timer is a real setTimeout(500) in this suite, with no scheduler injected. When a loaded CI runner delays the event loop past both deadlines, the two timers expire in the same timers phase. Any macrotask the seam path schedules after its 500 ms timer (load, play, `timeupdate` handling) then runs after the test's 750 ms callback, and the assertions read a half-finished seam. The file's own comment records a delivered tick of 1,825 ms against 250 ms nominal on this machinery. Nine tests use `beat()`. The neighbouring queue-manager and foray-playback suites drive the same beat with an injected scheduler.",
  "evidence": "diagnostic-record.test.js:299 `const beat = () => new Promise((r) => setTimeout(r, SEAM_GAP_SEC * 1000 + 250));`, used at 397, 442, 473, 497, 560, 722, 767, 844, 901. :391-392 comment: 'the widest delivered tick recorded here is 1,825 ms against 250 ms nominal'. Only the tests at 1008+ use `t.mock.timers`.",
  "fix_sketch": "Pass the manager a fake scheduler through bootClient (queue-manager already accepts `scheduler`), or use `t.mock.timers` and tick SEAM_GAP_SEC*1000 explicitly. Otherwise, poll for the seam row with a bounded wait instead of one fixed sleep.",
  "duplicates": [],
  "verdict": "refuted",
  "verdict_severity": "low",
  "verdict_reasoning": "The code is as the finding describes at origin/main. diagnostic-record.test.js:299 defines `beat` as a real setTimeout(SEAM_GAP_SEC*1000 + 250), where SEAM_GAP_SEC is 0.5. The nine tests the finding lists use it. bootClient passes no scheduler, so client.js:3340 builds the manager with REAL_SCHEDULER, which is a plain setTimeout (queue-manager.js:250-256).\n\nThe failure scenario does not hold under Node's timer semantics.\n\n1. **Arming order.** The test arms its 750 ms timer synchronously, right after crossTheBoundary. The product arms its seam timer (`_awaitSeamGap`, queue-manager.js:2127) later in the same macrotask's microtask chain, because the fake audio's load() resolves through queueMicrotask. The product timer is also for `seamGapRemainingMs`, which is at most 500 ms. Its expiry is therefore strictly earlier than the test's.\n\n2. **Nothing after the seam timer needs a macrotask.** After the seam timer fires, the rest of the seam is microtasks only: `finish` resolves the promise, then `await this._handle(E.itemLoaded())`, then play(). The fake's play() returns Promise.resolve() and fires `playing` from queueMicrotask. The diag writes go to a synchronous storage stub. The only other setTimeouts in html-audio-backend.js are load/seek failure deadlines and the out-point fine timer, and none of them is on the completion path. `timeupdate` is fired synchronously by the test itself, not by the player.\n\n3. **Node drains microtasks between timer callbacks.** Since Node 11, processTimers/listOnTimeout call runNextTicks() between lists and between callbacks. Suppose a loaded runner delays both timers into the same timers phase. The earlier 500 ms callback still runs first and its whole microtask chain drains, so the seam row is complete before the test's 750 ms callback runs.\n\nThe half-finished seam the finding describes would need a macrotask between the seam timer and `playing`, and none exists. The +250 ms margin is not load-bearing either: ordering alone guarantees correctness, whatever the actual delay.\n\nThe 1,825 ms comment is about the spacing of delivered `timeupdate` events in the real player. It explains why observedGapMs gets no budget assertion. It is not evidence about this ordering. The file header also says outright that the seam beat is the one real timer waited on, which makes it a deliberate design choice.\n\nThe only cost is about 0.75 s of wall-clock time per test, nine times, which is a speed matter and not a flake. I did not run the test: the local working tree differs from origin/main, and the rules allow no worktree.",
  "merged_ids": [],
  "lane": null
}
```

