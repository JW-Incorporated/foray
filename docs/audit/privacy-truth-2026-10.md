# Privacy policy vs code — truth audit (2026-10-07)

**Scope.** Every factual claim in `docs/legal/privacy-policy.md`, `docs/legal/data-safety.md`, the privacy sentences in `docs/store/**` (`play/full-description.txt`, `play/README.md`, `app-review-background-audio.md`) and the iOS privacy manifest injector `tools/mobile/inject-privacy-manifest.mjs`, checked against `main` at `22d816fc` (2026-10-07). Read-only: **no file under `docs/legal/` is changed by this PR**; every proposed sentence below waits for the founder's wording approval (founder question 34, HUMAN-ACTIONS #125 convention).

**Method.** Each claim was located in the code that makes it true or false and classified **TRUE** (cited `file:line` or `file:symbol`), **FALSE** (contradicting code cited), **STALE** (true when written, no longer — a snapshot that aged), or **UNVERIFIABLE** (depends on a dashboard setting, a platform default or a generated file the repo does not hold). The reverse direction was then walked: every network destination (`fetch`, `apiUrl(`, `CapacitorHttp`, native `URLSession`/`DownloadManager`), every `cp_` key written, every permission declared, every event type logged — looking for what the documents do not say. Finally every FALSE/undisclosed finding was re-checked as a skeptic against the code and dropped if it did not hold (§6 lists what was dropped).

**Counts.** 93 claim rows checked: **76 TRUE · 9 FALSE (five distinct mismatches, M1–M5) · 2 STALE (one mismatch, M6) · 6 UNVERIFIABLE**, plus **6 undisclosed** data flows (3 material — two of them folded into M2/M3's wording — and 3 low) and 3 latent tripwires that are not mismatches today. The three root-level suites that guard these documents (`test/legal-citations.test.js`, `test/data-deletion.test.js`, `test/event-sync-mapping.test.js`) are green — 115/115 — which is why §7 says what they do not check.

---

## 1. Claims and verdicts

Line numbers are `main` at `22d816fc`. "PP" = `privacy-policy.md`, "DS" = `data-safety.md`.

### 1.1 Events: what is sent and what stays local

| # | Claim (where) | Verdict | Evidence |
|---|---|---|---|
| 1 | PP §2 Sent table: exactly `picked`, `saved`, `thumbs`, `session_shown`→`session_built` are transmitted | **TRUE** | `app.js:682-721` `toEventRow()` — four `case` arms return a row; `default: return null` |
| 2 | PP short version: "**Five kinds of event** are sent … which episode you picked, **which you finished**, which you saved, thumbs, session shown" | **FALSE** | Same function: no `finished` arm. `logEvent("finished"` appears nowhere in `app.js`/`player/`. Known: HUMAN-ACTIONS #150, issue #1163 item 7, PR #1184 |
| 3 | DS A2 *App interactions*: "The five transmitted events are interactions: picked, finished, saved, thumbs, session shown" | **FALSE** | As #2 |
| 4 | DS B2 *Product Interaction*: "picked / finished / saved / thumbs / session shown" | **FALSE** | As #2 |
| 5 | DS B2 *Other Usage Data*: "Nothing beyond the five mapped types" | **FALSE** | Four mapped types |
| 6 | DS point 2: "Exactly 4 of 23 event types are transmitted" | **TRUE** | 23 distinct `logEvent(` types enumerated: picked, saved, thumbs, session_shown, play_started, position (`player/continuation.js:279`), foray_play, foray_restart, foray_progress_drift, source_opened, unsaved, playlist_built, playlist_saved, playlist_removed, family_mode, autoadvance_pref, voice_pref, refreshed_all, storage_fault, queued, unqueued, show_starred, show_unstarred |
| 7 | PP §2 "Nineteen of the twenty-three event types … never leave the device" | **TRUE** | 23 − 4; pinned by `test/legal-citations.test.js` §2 |
| 8 | PP §2: every row carries the anonymous account id and a timestamp | **TRUE** | `app.js:684` `{ user_id, ts, type, archetype, payload }` |
| 9 | PP §2 `picked` fields: slug, topics, `app` label, context label | **TRUE** | `app.js:687` |
| 10 | PP §2 / DS A2: the `app` label is always the literal `"Apple Podcasts"` because nothing sets `data-app` | **TRUE** | `app.js:7010` `a.dataset.app \|\| "Apple Podcasts"`; `grep data-app app.js index.html` → no setter |
| 11 | PP §2: context filtered by a five-value allowlist `SB_ARCHETYPES` | **TRUE** | `app.js:676` five values |
| 12 | PP §2 `thumbs` fields incl. `replaces`, reasons, note, segment_id, foray_id; `cleared` without `replaces` dropped | **TRUE** | `app.js:695-715` |
| 13 | PP §2: note is a single line, up to 200 characters | **TRUE** | `app.js:14842` `#fy-sheet-note maxlength="200"` |
| 14 | DS A5: nine fixed thumbs-down chips incl. "Leans too far left/right" | **TRUE** | `app.js:14409-14413` `FB_CHIPS` (9) |
| 15 | PP §2: `session_shown` stored as `session_built` with session key and builder | **TRUE** | `app.js:717` |
| 16 | DS point 2: `trySyncEvents()` called after a pick, after a play, after a thumb, once on first render | **TRUE** | `app.js:7024, 7165, 14484/14487, 20856` (also `4036/4055/11368`) |
| 17 | PP §1: `cp_profile_id` is stamped on local events but never sent | **TRUE** | `app.js:497` `row.profile = profileId()` on the local row; `toEventRow()` never copies it |
| 18 | PP §2: `position` recorded about every 15 s, as an event at most once a minute per episode | **TRUE** | `player/queue-manager.js:294` `POSITION_INTERVAL_MS = 15_000`; `player/position-store.js:33` `POSITION_EVENT_EVERY_SEC = 60` |
| 19 | PP §1: event queue is its own IndexedDB db `foray_events`, store `events`, capped at 5,000, rows deleted once sent | **TRUE** | `player/event-log.js:73,75,80` `DB_NAME`, `STORE_NAME`, `DEFAULT_RETENTION = 5000` |
| 20 | PP §2: the POST carries only the rows | **TRUE** | `app.js:797-805` `fetch(SB_URL + "/rest/v1/events", { body: JSON.stringify(chunk.rows) })` |
| 21 | PP §7: the deletion itself is not logged | **TRUE** | `app.js:18286-18290` (comment + no `logEvent` on the path) |
| 22 | PP §5: Share records no event and sends nothing to us | **TRUE** | `app.js:6038-6045` `navigator.share` / clipboard; no `logEvent` in `shareTo` |

### 1.2 Storage: the `cp_` keys and the native stores

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 23 | PP §1: every `cp_` key named in the table is one the code writes, and the table names every key the code writes | **TRUE** | Code inventory (33 names incl. 2 retired) equals the 33 table rows; `test/data-deletion.test.js` derives the same inventory. (`cp_voice_ios`/`cp_voice_android` appear only in a comment, `player/client.js:2960`) |
| 24 | DS "The audit this rests on" point 1: "**23 `cp_*` storage keys** live on the device … Two of the 23 are diagnostics" | **FALSE (stale count)** | 33 rows in PP §1 (31 live + `cp_lastpick`, `cp_voice_probe` retired). The number has not been updated since the bookmarks/downloads/queue/snaps/shard/starred/last_route/engine_applied/storage_stale rows were added |
| 25 | PP §1: two tiers, `localStorage` + IndexedDB db `foray` store `kv` | **TRUE** | `player/idb-tier.js:43,45` |
| 26 | PP §1: third copy in the app's preferences store on iOS/Android | **TRUE** | `player/durable-store.js:309` `preferencesTier()` |
| 27 | PP §1: `cp_sb_session` kept only in the device-only vault; iOS Keychain `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`; Android `getNoBackupFilesDir()` | **TRUE** | `player/durable-store.js:401` `vaultTier()`; `foray-vault/ios/.../KeychainVault.swift:60`; `foray-vault/android/.../ForayVaultPlugin.java:40` |
| 28 | PP §3: a fresh install empties its own Keychain on first open | **TRUE** | `ForayVaultPlugin.swift:32` `vault.forgetIfReinstalled(defaults: UserDefaults.standard)` |
| 29 | PP §1: `cp_storage_health` never written to IndexedDB | **TRUE** | `player/durable-store.js:1150` `_ownedKeys()` hides it; `_recordHealth` mirrors to synchronous tiers |
| 30 | PP §1: `cp_storage_stale` kept only in the durable tiers, never `localStorage` | **TRUE** | `player/durable-store.js:96,1779-1784` |
| 31 | PP §1: `cp_lastpick`, `cp_voice_probe` retired and deleted on next start | **TRUE** | `app.js:7035` `RETIRED_STORAGE_KEYS` |
| 32 | PP §1: `cp_history` last 200 ids | **TRUE** | `app.js:2294` `.slice(-200)` |
| 33 | PP §1: `cp_shard_shows` last 50 | **TRUE** | `app.js:4278` `SHARD_SHOWS_CAP = 50` |
| 34 | PP §1: `cp_last_route` never written in a web browser | **TRUE** | `app.js:19542` `if (!isNativeShell()) return;` |
| 35 | PP §1: `cp_starred_shows` check at most every six hours per show, failed checks retried next open | **TRUE** | `player/show-alerts.js:71` `CHECK_INTERVAL_MS = 6 * 3600 * 1000`; `app.js:2057-2075` |
| 36 | PP §1: `cp_diag` capped at 200, readable/clearable from Developer → Playback diagnostics | **TRUE** | `player/diagnostic-log.js:154` `DIAG_CAP = 200` |
| 37 | PP §1 `cp_diag` row: "no audio, no URLs, no account id and no device names" | **TRUE, incomplete** | Holds; but the record also keeps the OS name and version parsed from the WebView user-agent (`player/diagnostic-log.js:1077-1092` `buildStampOf`: `os`, `platform`; `player/build-stamp.js:91`). Not a device name; not listed. See §3 U4 |
| 38 | PP §1: `navigator.storage.persist()` requested and the answer recorded | **TRUE** | `player/durable-store.js:204-223` |
| 39 | PP §1: native player writes `cp_pos:`, `cp_foray:`, `cp_last_episode` (`OWNED_PREFIXES`) | **TRUE** | `player/engine-contract.js` `OWNED_PREFIXES`; `EngineKeys.swift` `Rows.ownedPrefixes` |
| 40 | PP §1: exactly eight `ForayEngine.` values, named | **TRUE** | `foray-engine-core/.../Persist/EngineKeys.swift` `EnginePrivateKey` — the same 8 names |
| 41 | PP §1: `diag.jsonl` capped at 2,000 rows, free text cut to 40 chars, excluded from backup | **TRUE** | `DiagRing.swift:37` `capacity = 2_000`; `DiagGate.swift:45` `nowPlayingTextMax = 40`; `EngineDiagnostics.swift:103` `isExcludedFromBackup = true` |
| 42 | PP §1: `knownRoutes` at most 8, salted one-way hashes | **TRUE** | `RouteResume.swift:54` `knownCap = 8`; `Seams.swift:331-370` |
| 43 | PP §1: strikes switch to the web player at three failed starts | **TRUE** | `EngineConstants.swift:141` `strikeLimit = 3` |
| 44 | PP §1: build decides the starting player (`mobile/ENGINE_DEFAULT.json`); Android stays on the web lane | **TRUE** | `ENGINE_DEFAULT.json` ios `mode: native`, android `mode: js` |
| 45 | PP §1 `cp_downloads`: files in Application Support (iOS) / app files dir (Android), never backed up, deleted by Delete my data | **TRUE** | `foray-downloads/ios/.../DownloadStore.swift:105` `isExcludedFromBackup`; `android/.../DownloadStore.java:119` `getNoBackupFilesDir()`; `app.js` `clearDownloads` inside `clearLocalData()` |
| 46 | PP §1: Cache Storage buckets `foray-gen-<deploy_id>` (up to two), `foray-pointer`, `foray-pending`; never caches audio; ignores non-own-origin requests | **TRUE** | `sw.js:118,141,142,356-362`; fetch handler `sw.js:901-920` `if (url.origin !== location.origin) return;` and `isRangeOrMedia` |
| 47 | PP §1: the `cp_` rows ride the phone's own backups (iCloud / Google) | **UNVERIFIABLE (Android)** | iOS: app container is backed up by default, and the policy excludes the right things. Android: depends on `android:allowBackup` in the **generated** `mobile/android/.../AndroidManifest.xml`, which is not in the repo and which no injector sets (`grep allowBackup tools/mobile mobile/plugins` → only the unrelated A-05 helper). Capacitor's template defaults to `true`, so the claim is probably right, but nothing here pins it |

### 1.3 Network destinations

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 48 | PP §5 / DS: CSP `connect-src` names exactly `'self'`, the Supabase project and `https://foray-web-seven.vercel.app` | **TRUE** | `index.html:35`; `app.js:536,560` `SB_URL`, `API_ORIGIN` |
| 49 | PP §5: `img-src https:` and `media-src https:` are any HTTPS host | **TRUE** | `index.html:35` |
| 50 | PP §4: audio plays from the publisher's enclosure URL; no 4a server in the path | **TRUE today** | `player/html-audio-backend.js:load()`; see latent L1 (narration host) |
| 51 | PP §4.1: "**43 distinct hosts** for audio" across the three files, listed | **STALE** | Recount by `audio_url`/`enclosure_url` field over the same three files: **44**; one new host `api.riverside.com` (in `data/discover.json`), none gone. The policy itself says to regenerate rather than trust the date |
| 52 | DS A6: "43 distinct first-hop hosts" | **STALE** | As #51 |
| 53 | PP §4.1: artwork from publisher and Apple-hosted image URLs | **TRUE** | artwork fields resolve to `is1-ssl.mzstatic.com` plus publisher hosts in `cp_episode_snaps` |
| 54 | PP §2: Shows search text is sent to our server (`API_ORIGIN`) whether or not the show was on the device | **TRUE** | `app.js:10143, 10205` |
| 55 | PP §2: "and, **when nothing we hold matches at all**, on to Apple's public podcast directory" | **FALSE** | The gate was removed by P-02 (`api/shows/search.ts:56-84` header, `:215,238`): the server passes the text to Apple whenever the client sends `fallthrough=1`, and the client sends it on **every** settled Shows search of ≥ 3 characters (`app.js:9313` `SHOW_DIRECTORY_MIN_QUERY_LENGTH = 3`; `app.js:10205`, comment "THE FLOOR IS THE ONLY GATE"). Separately, the same box's episode half (`app.js:10995` → `api/episodes/search?q=`) queries `itunes.apple.com/search?entity=podcastEpisode` (`api/episodes/search.ts:63`) for every query. Apple sees the text from Vercel's address, not the device's |
| 56 | PP §2: debounced 250 ms; repeated query answered from memory | **TRUE** | `app.js:6613-6659`; `showDirectoryQueryCache`, `searchCache` (`app.js:6881`) |
| 57 | PP §2: "sends **once**" per settled query | **FALSE (minor)** | Three requests per uncached settled query: `api/shows/search?q=` (10143), `api/shows/search?q=&fallthrough=1` (10205), `api/episodes/search?q=` (10995). Once per endpoint, not once |
| 58 | PP §2: what is sent is the text and nothing else — no account id, no device id | **TRUE** | `fetchApiJson` → `fetchJsonAt(apiUrl(path))` (`app.js:20155`): plain GET, no headers beyond the browser's |
| 59 | PP §2: directory pointer `data/forays-directory.json` fetched from `API_ORIGIN` on launch and each foreground | **TRUE** | `app.js:20217, 20382, 20874-20876` `refreshForayDirectory("boot"/"foreground")` |
| 60 | PP §4.3: opening a show's page and the follow check ask the API for the show's episodes; carries the show id | **TRUE** | `fetchShowEpisodes` → `api/shows/[show_id]/episodes.ts`; `app.js:2070` |
| 61 | PP §4.3: Vercel acts as processor, sees query text and metadata; "4a does not log the query" | **TRUE (code) / UNVERIFIABLE (platform)** | No `console.*` in `api/**/*.ts` outside tests. But `api/_lib/clientLimit.ts:50-60` keys an in-memory rate-limit bucket on the caller's IP (`x-forwarded-for`), and Vercel's own function logs record request paths — whether `?q=` survives in those logs is a dashboard setting the repo cannot see |
| 62 | PP §4.3: native app fetches chapter list / audio head from the publisher directly | **TRUE** | `app.js:12608-12616` `item.chapters_url` via `CapacitorHttp` (native only) |
| 63 | PP §3: anonymous account created via Supabase on first event; token stored in `cp_sb_session` | **TRUE** | `app.js:633-671` `sbAuth("/auth/v1/signup", {})`; first render emits `session_shown` + sync (`app.js:20855-20856`) |
| 64 | PP §3: Supabase region `us-east-1` | **UNVERIFIABLE from code** | Founder-supplied: HUMAN-ACTIONS-DONE #129 (2026-10-04). Accept as recorded |
| 65 | PP §3: "Supabase processes this data under Supabase's standard DPA" (+ TODO) | **UNVERIFIABLE** | Not in the repo; the TODO already says so |
| 66 | PP §3: RLS means a client reaches only its own rows (`0001_auth_and_rls.sql`) | **UNVERIFIABLE (liveness)** | Policies exist (`0001` `for all`, `0003` least-privilege). HUMAN-ACTIONS #116 says `0003-0006` are **not applied**; whether `0001` is applied is DS Open Question 2. The code is right; the live project is not knowable here |
| 67 | PP §5: no `geolocation`, `getUserMedia`, contacts, no fingerprinting (device id, screen size, timezone, language list) | **TRUE** | `grep` over `app.js`/`player/*.js` finds none; `app.js:1789` `timeZone = "UTC"` is a formatter option; `navigator.userAgent` is read only for the local diagnostic stamp (#37) |
| 68 | PP §5: no third-party SDK, no analytics, no crash reporter, no AI call from the device | **TRUE** | root `package.json` has no dependencies; `mobile/package.json` deps are Capacitor core plugins plus this repo's own `file:` plugins; CSP |
| 69 | PP §5: share link holds public ids, title and up to 50 catalogue episode ids, never the playlist's own id | **TRUE** | `app.js:5930-5961` `shareLinkFor()` |
| 70 | PP §5 / DS A7: audio download via original enclosure URL, user-agent `4a/<build> (+site)` | **TRUE** | `player/download-bridge.js:143-150` `userAgentFor()` |

### 1.4 Permissions and notifications

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 71 | PP §5: "**no notifications.** The app requests **no device permissions**." | **FALSE (Android)** | `mobile/plugins/foray-audio/android/src/main/AndroidManifest.xml:43` declares `android.permission.POST_NOTIFICATIONS` (manifest comment: "POST_NOTIFICATIONS IS NOW DECLARED"); `ForayAudioPlugin.java:448-480` `requestNotifications()` shows the system permission dialog on API 33+; `mobile/plugins/foray-audio/web/foray-audio-shell.js:184,474-510` asks once after the first accepted `play()` (`askNotifications` defaults true; shell is Android-only, `:140`). The app also shows the system **playback notification** with transport controls (`PlaybackKeepAliveService.java:659-679`) and a visible **download-progress notification** (`foray-downloads/android/.../DownloadStore.java:313` `VISIBILITY_VISIBLE`). iOS: no permission asked, no notification — TRUE there |
| 72 | PP §1 `cp_starred_shows`: "there is no phone notification" for new episodes | **TRUE** | `player/show-alerts.js` marks a badge only; no `Notification`/`LocalNotifications` anywhere |
| 73 | `full-description.txt`: "sends no notifications to pull you back in"; "Following … sends no phone notification" | **TRUE** | As #72; the Android playback/download notifications are not re-engagement |
| 74 | DS A2 Location/Photos/Audio files/Contacts "No permission requested" (per row) | **TRUE** | No such permission in any plugin manifest; `foray-tts` manifest says none needed |
| 75 | DS B4: web client uses no Required Reason API; native declares `UserDefaults` CA92.1 and `SystemBootTime` 35F9.1, no file-timestamp, disk-space or keyboard API | **TRUE** | `tools/mobile/inject-privacy-manifest.mjs` `ACCESSED_API_TYPES` with evidence files re-grepped by its test |
| 76 | DS B4: manifest says `NSPrivacyTracking` false, no tracking domains, three collected types linked/not-tracking, two purposes | **TRUE** | injector `COLLECTED_DATA_TYPES`, `PURPOSES`, `:161-163`, `--check` asserts `:283-285` |
| 77 | DS B4: Capacitor plugins bundled: app, core, ios/android, preferences, share, splash-screen, status-bar | **TRUE** | `mobile/package.json` |
| 78 | `app-review-background-audio.md`: `UIBackgroundModes: audio`; jingle 3 s bundled, ceiling 4.5 s; silence node off | **TRUE** | `tools/mobile/inject-background-audio.mjs`; `player/interlude.js`; `EngineConfig.silenceNodeEnabled = false` (pinned by `tools/audio/interlude-asset.test.mjs`) |

### 1.5 Deletion and retention

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 79 | PP §7: typed `DELETE` confirmation, capitals optional | **TRUE** | `app.js:18166-18168` `deleteConfirmed()` `.toUpperCase() === "DELETE"` |
| 80 | PP §7: server rows first; a remote failure leaves the device untouched and says so; device-only offered separately | **TRUE** | `app.js:18210-18300` `deleteMyData()` |
| 81 | PP §7: one authenticated `DELETE` per per-user table — `events`, `app_users`, "and the other per-user tables" | **TRUE** | `app.js:17684-17687` `SB_USER_TABLES` = events, saved_items, user_interests, sessions, session_items, subscriptions, taxonomy_nodes, learning_cursor, app_users; `sbDeleteOwnRows` `app.js:17759` |
| 82 | DS A7: `events` is "the only table this client writes" | **TRUE** | Only `rest/v1/events` is POSTed; `app_users` is inserted by the server trigger (`supabase/0001_auth_and_rls.sql:19`) |
| 83 | PP §7: signs the account out everywhere after the rows (`sbRevokeSessions`) | **TRUE** | `app.js:17800-17810` `POST /auth/v1/logout?scope=global`; ordered after tables in `deleteRemoteData()` |
| 84 | PP §7: the event queue is emptied and re-read | **TRUE** | `clearLocalData()` → `clearEventLog` (verified by `test/data-deletion.test.js`) |
| 85 | PP §7: native player told to stop without saving, then delete `ForayEngine.` values and the diag file | **TRUE** | `player/durable-store.js:496` `engineDataDeletion()`; `player.stopForDataDeletion()` in `deleteMyData` |
| 86 | PP §7: the auth user row itself cannot be deleted by the client | **TRUE** | No admin call exists; HUMAN-ACTIONS #14 |
| 87 | PP §7: sheet says publisher/ad hosts' observations cannot be deleted | **TRUE** | `app.js:18083` |
| 88 | PP §3: 90-day event retention and empty-account prune by a daily job (`0006_event_retention.sql`), with the draft note that it is not yet applied | **TRUE as drafted** | `supabase/0006_event_retention.sql` `interval '90 days'`, `cron.schedule(... '17 3 * * *')`, `'37 3 * * *'`; HUMAN-ACTIONS #116 open → not live. The draft note is exactly right |
| 89 | DS A7: `learning_cursor` delete policy not known live → "unconfirmed" handling | **TRUE** | `app.js:17703` `SB_DELETE_UNVERIFIED` |
| 90 | DS Part C header: "The Capacitor shell is **not on `main`** as of `909adb5`; it lives on the unmerged branch `feat/capacitor-shell` (PR #209)" | **FALSE (stale)** | `mobile/` is on `main` with its own `package.json`, plugins and CI; CLAUDE.md calls it "the shipping native app" |
| 91 | DS A2 Diagnostics: `cp_diag` is "deliberately OUTSIDE the `cp_events` pipeline" | **TRUE (stale name)** | True in substance; the queue is `foray_events` since 2026-09 (PP §1 says so) |
| 92 | PP §6 / DS: Family mode is a local filter, collects nothing | **TRUE** | `cp_family` local; `family_mode` event local-only (#6) |
| 93 | PP §5: build pipeline AI paths inert — placeholder id, no `DATABASE_URL` | **UNVERIFIABLE (env)** | `backend/src/cli/buildSession.ts` passes the placeholder; whether `DATABASE_URL` is set anywhere is an environment fact. DS already names this as the likeliest silent invalidation |

---

## 2. Confirmed mismatches (FALSE / STALE), with the fix

For each: the sentence as it stands, why it is wrong, and **either** a corrected sentence (verbatim, for founder approval) **or** the code change that would make the existing sentence true. Code is preferred where the policy describes intended behaviour; here every mismatch is one where the code is the deliberate state and the prose aged, so the fix is wording in all six — with the code alternative named where one exists.

### M1 — `finished` is described as transmitted (claims #2-#5)

- **Code:** `app.js:682-721` sends four types. `finished` is PKG-19 work, parked on HUMAN-ACTIONS #150.
- **Code alternative:** land PKG-19 (observed `finished` with `percent_complete`), which would make these four passages true — but #150 says that needs its own approved sentences first, so the wording fix is the one that can land now.
- **Proposed wording, PP "The short version", second bullet (verbatim):**

  > - **Four kinds of event are sent to our database**: which episode you picked, which you saved, your thumbs up/down feedback (including any note you type), and the fact that a session was shown to you. They are stored against an anonymous account that contains no name, email or phone number.

- **Proposed wording, DS A2 *App interactions* (first sentence of the justification cell):**

  > The four transmitted events are interactions: picked, saved, thumbs, session shown (`app.js:toEventRow()`).

- **Proposed wording, DS B2 *Product Interaction* justification:**

  > picked / saved / thumbs / session shown (`app.js:toEventRow()`).

- **Proposed wording, DS B2 *Other Usage Data* justification:**

  > Nothing beyond the four mapped types.

### M2 — The Apple directory pass is not conditional on an empty catalogue (claims #55, #57)

- **Code:** `app.js:10205` sends `fallthrough=1` on every settled Shows search of ≥ 3 characters (`SHOW_DIRECTORY_MIN_QUERY_LENGTH`, `app.js:9313`); `api/shows/search.ts:215,238` calls Apple whenever asked; `api/episodes/search.ts:63` calls `itunes.apple.com/search` for the same box's episode half (`app.js:10995`). The old "only when nothing matched" gate was removed by P-02 on measurement (`api/shows/search.ts` header).
- **Code alternative:** restore the server-side gate (`results.length === 0`). Rejected by the P-02 measurement in that header (every one of 25 queries gained rows); not recommended.
- **Proposed wording, PP §2, replacing the sentence "and 4a **also** sends the text you typed … so a show we have never listed can still be found." through "the code never had one." (verbatim):**

  > and 4a **also** sends the text you typed to our own server (`app.js:API_ORIGIN`) so it can search the full catalogue. For any search of three or more characters our server then passes the same text on to Apple's public podcast directory (`itunes.apple.com`) — once for shows and once for episodes — so a show or episode we have never listed can still be found. **It does this whether or not our own catalogue matched, and whether or not the show was already on your device.** There is no "only if we cannot find it" condition; an earlier version of this policy said there was, and the code dropped that condition on 2026-09-12 after measuring that the directory added results to every query tried. The request to Apple is made by our server, so Apple sees our server's address and the text you typed, not your device's address.

- **Proposed wording, PP §2, replacing "It is not sent per keystroke either: 4a waits until you stop typing (250 ms) and sends once, and a query you repeat …" (verbatim):**

  > It is not sent per keystroke either: 4a waits until you stop typing (250 ms) and then asks our server once for shows, once for the directory pass and once for episodes; a query you repeat in the same session is answered from memory without asking again.

- **DS A2 *In-app search history* and B2 *Search History*** already say "every settled Shows search is sent to 4a's API" — no change needed there, but add after "(Vercel)" in both cells: `, which passes it on to Apple's directory (§2)`.

### M3 — "No notifications. The app requests no device permissions." (claim #71)

- **Code:** Android declares and, after the first play, asks for `POST_NOTIFICATIONS` (`foray-audio/android/.../AndroidManifest.xml:43`; `ForayAudioPlugin.java:448`; `foray-audio-shell.js:474-510`). The playback notification carries the lock-screen controls (`PlaybackKeepAliveService.java:659-679`); Android's `DownloadManager` shows a download-progress notification (`DownloadStore.java:313`). iOS asks for nothing.
- **Code alternative:** drop the runtime request (the manifest comment records that #244 ran without it). Cost: no lock-screen transport controls on Android 13+. Not recommended — the permission is what the lock screen needs, and the honest fix is to say so.
- **Proposed wording, PP §5, replacing the bullet "**No location access, no camera, no microphone, no contacts, no calendar, no photos, no notifications.** The app requests no device permissions. There is no call to `geolocation`, `getUserMedia` or the contacts APIs anywhere in the client." (verbatim):**

  > - **No location access, no camera, no microphone, no contacts, no calendar, no photos.** There is no call to `geolocation`, `getUserMedia` or the contacts APIs anywhere in the client. **Notifications:** 4a sends no push or reminder notifications, and has no server that could. On Android the app shows the system's playback notification — the lock-screen transport controls — while audio plays, and the system's download-progress notification while an episode downloads. To show the first of those on Android 13 and later it asks for the notification permission once, after the first time you press play (`mobile/plugins/foray-audio/android/src/main/AndroidManifest.xml`); saying no only hides those controls, and nothing else changes. That is the only device permission the app asks for, and on an iPhone it asks for none.

- **Proposed wording, DS, new row at the end of A2 (so the Play form's permission question is answered from this file, verbatim):**

  > | **Permissions (Android)** | n/a | n/a | `POST_NOTIFICATIONS` (runtime, asked once after the first play, for the lock-screen controls), `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK` and `WAKE_LOCK` (install-time, no prompt) — all in `mobile/plugins/foray-audio/android/src/main/AndroidManifest.xml`. None reads data; none is a Play data type. iOS asks for no permission. |

### M4 — "23 `cp_*` storage keys" (claim #24)

- **Code / docs:** PP §1 lists 33 keys (31 live, 2 retired); `test/data-deletion.test.js` derives the inventory from the source and would pin a number if one were stated.
- **Proposed wording, DS "The audit this rests on" point 1, first sentence (verbatim):**

  > 1. **Thirty-one live `cp_*` storage keys live on the device** (plus two retired ones the app deletes on launch — the policy's §1 table names all thirty-three), each live key mirrored into both `localStorage` and IndexedDB (`player/durable-store.js` mirrors the whole `cp_` prefix; db `foray`, store `kv`). Two of them are diagnostics rather than a listener's data — `cp_storage_health` and `cp_diag` — and neither is transmitted.

- Also DS A7 bullet "that is what produced the 11-vs-20 undercount" is history and can stay.

### M5 — "The Capacitor shell is not on `main`" (claim #90)

- **Proposed wording, DS Part C first paragraph (verbatim):**

  > The Capacitor shell is on `main` under `mobile/` (merged from PR #209) and is the shipping app (CLAUDE.md § Layout). The table below describes shipped code; re-verify it at each submission all the same, because store declarations are about the **app**, and these are the answers that will actually be submitted.

### M6 — Host list snapshot: 43 → 44 (claims #51, #52)

- **Data:** `api.riverside.com` now appears as an audio host in `data/discover.json`. Nothing was removed.
- **Proposed wording, PP §4.1 first sentence:** "As of 2026-10-07 the catalogue the app downloads points at **44 distinct hosts** for audio" — and add `api.riverside.com` to the block list after `anchor.fm`. **DS A6:** "**44 distinct first-hop hosts**".
- **Code alternative (recommended alongside):** a test that regenerates this list from the three data files and fails when the policy's block differs — the policy already says the list "is generated from the data files"; nothing in `test/` does the generating. The recount script is in §8.

---

## 3. Undisclosed: what the code does that the documents do not say

| ID | Flow | Where | Severity | Proposed disclosure |
|---|---|---|---|---|
| **U1** | **The search box on a show's own page** ("Search this show's episodes", `app.js:6268`) sends the typed text **and the show's id** to our API; the API then fetches that show's own live feed server-side and filters it | `app.js:5756` `searchShowEpisodesScoped()` → `api/episodes/search?show=&q=`; `api/episodes/search.ts` | **Material** — a third text input whose contents leave the device; the policy names only the Shows box and the playlist box | PP §2, new paragraph after the Shows-search paragraph (verbatim): **"The search box on a show's own page works the same way:** what you type there is sent to our server together with that show's id (`app.js:searchShowEpisodesScoped()`), and our server reads the show's own feed to search every episode, not just the ones already on your screen. Nothing about you goes with it, and it is not stored." |
| **U2** | Apple's directory receives the Shows-box text on every ≥ 3-character search, for shows **and** episodes, via our server | `api/shows/search.ts`, `api/episodes/search.ts:63` | **Material** — folded into M2's wording | See M2 |
| **U3** | Android: a playback notification and a download-progress notification are shown; a runtime permission is asked | See M3 | **Material** — folded into M3 | See M3 |
| U4 | `cp_diag` keeps the OS name and version parsed from the WebView user-agent (`os`, `platform`) in its build stamp | `player/diagnostic-log.js:1077-1092`; `player/build-stamp.js:91` | Low — local only, never sent | PP §1 `cp_diag` row, append before the final cell: "It also records which operating system and version the app is running on (for example iOS 17.5), read from the browser's own identification string — a software version, not a device name." |
| U5 | Shows index shards are fetched from our API by a key derived from the first characters of the show title typed or opened (`shardKeyForShow`), as a plain static GET | `app.js:9223` `api/shows/index/shards/<key>.json`; `app.js:5895` | Low — two characters of a title, no identifier | PP §2, after the forays-directory sentence: "The same origin also serves the catalogue's search index in pieces; opening a show from the wider directory fetches the piece named by the first letters of its title, as a plain GET." |
| U6 | The API's rate limiter keys an in-memory bucket on the caller's IP | `api/_lib/clientLimit.ts:50-60` | Low — PP §4.3 already says Vercel sees request metadata | Optional, PP §4.3: "…and uses your IP address only to rate-limit abusive callers, in memory, never written down." |

---

## 4. Latent tripwires (true today, one change from false)

| ID | What | Evidence | Already tracked |
|---|---|---|---|
| L1 | **Narration streamed from `audio.jwlabs.ai`** (a Cloudflare R2 bucket on a JW Labs domain) would put a 4a-controlled server in the audio path: that host would see the device's IP, user-agent and which Foray's narration it fetched. The client is ready for it — `player/engine-contract.js:229` `NARRATION_PUBLIC_BASE`, `player/queue-manager.js:2109` (a narration line with an `audio_url`), the `cp_diag` narration-fallback row that records the host — but **no published Foray carries a narration `audio_url` today** (157 narration items in `data/forays.json`; fields `type,id,script,mode,slot` only), so PP §4 "There is no 4a server in the path" and "we never see it" are still true. | `tools/foray/check-forays.mjs:284`; `docs/DECISIONS.md:722`; `docs/curation/generation-architecture.md:59` | HUMAN-ACTIONS #125 (rewrite waits for the PR). The first rendered-narration data PR must carry it |
| L2 | `0006_event_retention.sql` not applied: until it is, no event row is ever deleted. PP §3 carries the right draft note. | HUMAN-ACTIONS #116 | Yes |
| L3 | PKG-18 `card_shown` and PKG-19 `finished`/`skipped_at` would each change §2's Sent table, the "nineteen of twenty-three" totals, and the `archetype` disclosure. | HUMAN-ACTIONS #150 | Yes |

---

## 5. Store copy and the manifest injector

- `docs/store/play/full-description.txt` — every privacy sentence checked (no account, no ads, no analytics SDK, publishers' own servers, "Most of what 4a knows about you stays on your phone", Delete my data clears/deletes/tells you, no notifications to pull you back): **all TRUE** against #63, #68, #50, #80, #72. The one nuance is M3's Android playback notification, which the sentence "sends no notifications to pull you back in" does not contradict.
- `docs/store/play/README.md` §8 "Content rating — no user-generated content": thumbs notes are transmitted free text (DS A2 *Other user-generated content* says **Yes**). For the IARC form "user-generated content" means content shown to other users, which a private note is not, so the README is defensible — but it and DS answer the same words differently; worth one line in the README saying why.
- `tools/mobile/inject-privacy-manifest.mjs` — declares exactly DS B2/B3's three types, linked, not tracking, two purposes, `NSPrivacyTracking` false, no tracking domains, and the two Required Reason categories with per-file evidence re-grepped by its test. **TRUE** on every point. It inherits M1 only indirectly (Product Interaction is still a collected type whether four or five events are mapped), so it needs no change.

---

## 6. The skeptic pass — what was checked again and what was dropped

Every FALSE/undisclosed candidate was re-opened against the code before it was kept:

- **Kept M1** after confirming no other mapper exists (`grep "case \"finished\""`, `logEvent("finished"` → none) and that `backend/migrations/0009_events.sql`'s type check merely *permits* `finished` server-side.
- **Kept M2** after confirming the client never consults local results before sending `fallthrough=1` (`app.js:10189-10205`, "`shown` is deliberately not consulted"), and that the server's only gates are `fallthroughAsked` and the length floor (`api/shows/search.ts:215,238`). The Apple rate limiter and 1-hour cache mean not every search *reaches* Apple, which the wording above reflects ("passes the same text on").
- **Kept M3** after confirming the Android shell is actually shipped (`tools/mobile/prepare-webdir.mjs:338` copies `foray-audio-shell.js` into the bundle), is Android-gated (`:140`), and defaults `askNotifications` to true (`:184`).
- **Kept M4/M5/M6** as plain recounts.
- **Kept U1** after confirming the input is rendered on `main` (`app.js:6268`) and the request is unconditional when the API is reachable (`:5756`).
- **Dropped:** `cp_voice_ios` / `cp_voice_android` as undisclosed keys — they exist only in a comment explaining why one key is used (`player/client.js:2960`).
- **Dropped:** `cp_events` / `cp_synced_ts` as still-live keys — comments and historical references only; the queue is `foray_events` (`player/event-log.js:73`).
- **Dropped:** "narration host undisclosed" as a *current* mismatch — no data row carries a narration `audio_url` yet (L1).
- **Dropped:** `navigator.userAgent` as fingerprinting — read for the local diagnostic stamp only (#37/U4) and for the download `User-Agent` the publisher would see anyway.
- **Dropped:** `content_reports` (`supabase/0005`) as an undisclosed transmission — no client code references it (`grep content_reports app.js player/` → none); the table exists ahead of a feature.
- **Dropped:** the `app_users` row as a client write — the server trigger inserts it (`0001_auth_and_rls.sql:19`); DS's "the only table this client writes" stands.
- **Dropped:** `cp_profile_id` "stamped on local events" as false — `profile: null` at creation is filled when the row leaves the buffer (`app.js:497`).

---

## 7. Why the guard tests did not catch these

`test/legal-citations.test.js` §2 **executes** `toEventRow()` and checks the §2 Sent table and the "nineteen"/"twenty-three" number words. It does not read the short version's "Five kinds of event", DS A2/B2's "five transmitted events", the Apple-pass sentence, the §5 permissions bullet, DS's "23 keys", or Part C's "not on main". Three cheap pins would close most of this, in a follow-up (not in this PR, which must stay documentation-only and must not turn CI red against the current docs):

1. In the §2 totals test, also assert that every number-word immediately preceding "kinds of event", "transmitted events" or "mapped types" in either document equals the executed sent-count (4).
2. Assert the policy's §4.1 host block equals the recount in §8 below (the policy already says it is generated).
3. Assert the DS "storage keys" count equals the `cp_` inventory `test/data-deletion.test.js` already derives.

---

## 8. Reproduction

```sh
# the four sent types
node -e 'const s=require("fs").readFileSync("app.js","utf8");console.log([...s.matchAll(/case "([a-z_]+)":/g)].map(m=>m[1]).slice(0,4))'
# the 23 recorded types
grep -o 'logEvent("[a-z_]*"' app.js | sort -u | wc -l   # 21, + "storage_fault" (player/client.js:289) + "position" (player/continuation.js:279) = 23
# audio hosts in the three files the policy names (44 on 2026-10-07; new: api.riverside.com)
node -e '
const fs=require("fs");const F=["audio_url","enclosure_url"];const all=new Set();
const walk=(o)=>{if(Array.isArray(o))return o.forEach(walk);if(o&&typeof o==="object")for(const[k,v]of Object.entries(o)){if(F.includes(k)&&/^https?:\/\//.test(v))all.add(new URL(v).hostname);else walk(v);}};
for(const f of["data/segment-sources.json","data/session.json","data/discover.json"])walk(JSON.parse(fs.readFileSync(f,"utf8")));
console.log(all.size,[...all].sort().join(" "))'
# policy key rows
grep -c '^| `cp_' docs/legal/privacy-policy.md   # 33
# Android permissions
grep uses-permission mobile/plugins/*/android/src/main/AndroidManifest.xml
# the guard suites
node --test test/legal-citations.test.js test/data-deletion.test.js test/event-sync-mapping.test.js
```
