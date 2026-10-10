# Human actions — foray

<!-- ha-format: 2 -->

> **34 open.** Closed items are in `HUMAN-ACTIONS-DONE.md` — you never need it.
> To close one: reply `done` (or `skip <why>`) to its card in the project's human-action channel.
> Anything else you reply is forwarded to a thread on the card.

## #153 🟡 [DECIDE] Approve the "4a Tactile" lab-build change: label PR #1254 (~2 min)
<!-- ha filed=2026-10-09 -->

**Why:** The lab-build workflow holds the app-signing setup, so changes to it need a founder's OK. PR #1254 sends Tactile builds to the new 4a Tactile app and names 4a Lab "4a Ambient". Merged before #151 and #152 are done, every Tactile lab build fails on purpose.
**Steps:**
1. Finish #151 (Apple) and #152 (Play) first.
2. github.com/JW-Incorporated/foray/pull/1254 → read the TL;DR at the top.
3. Labels (right column) → add `founder-approved`. Claude merges it once the checks are green.
**Worked if:** PR #1254 shows merged, and the next Tactile lab build lands as "4a Tactile" in TestFlight and on Play.

## #152 🟢 [UPGRADE] Google Play: set up the separate "4a Tactile" Android app (~10 min)
<!-- ha filed=2026-10-09 -->

**Why:** You chose to use both redesign directions live, side by side. Tactile gets its own lab app so it installs next to 4a Lab (which becomes "4a Ambient") and the real 4a. Nothing about the real app changes.
**Steps:**
1. Play Console → Create app → Name `4a Tactile`, App, Free → accept the declarations.
2. Testing → Internal testing → Testers: add the same email list 4a Lab uses (Joey's Google account). Save the opt-in link.
3. Users and permissions: grant the service account CI uses for 4a "Release to testing tracks" on 4a Tactile.
4. Play may require the first bundle of a new app to be uploaded by hand. If so, the session supplies the file and the clicks.
**Worked if:** the opt-in link installs "4a Tactile" from the Play Store beside 4a Lab and the real 4a.

## #151 🟢 [UPGRADE] Apple: set up the separate "4a Tactile" iOS app (~20 min)
<!-- ha filed=2026-10-09 -->

**Why:** You chose to use both redesign directions live, side by side. Tactile gets its own TestFlight app so Wyatt can keep it installed next to 4a Lab (which becomes "4a Ambient") and the real 4a. Nothing about the real app changes.
**Steps:**
1. developer.apple.com → Account → Identifiers → + → App IDs → App. Description `4a Tactile`, Explicit ID `ai.jwlabs.foura.lab.tactile`, no capabilities → Register.
2. appstoreconnect.apple.com → Apps → + → New App: iOS, `4a Tactile` (if taken `4a Tactile by JW`), English (U.S.), that bundle ID, SKU `4a-tactile`, Full Access.
3. Profiles → + → App Store Connect distribution, that App ID, the Apple Distribution cert 4a Lab uses, name `4a Tactile App Store` → Download.
4. PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\Downloads\4a_Tactile_App_Store.mobileprovision")) | Set-Clipboard`
5. github.com/JW-Incorporated/foray/settings/secrets/actions → New repository secret `IOS_LAB_TACTILE_PROVISIONING_PROFILE_BASE64`, paste.
6. 4a Tactile → TestFlight → Internal Testing → +: group `Founders`, add Joey and Wyatt, automatic distribution.
**Worked if:** the first Tactile lab build appears in TestFlight as "4a Tactile" and installs beside 4a Lab and the real 4a.

## #150 🟡 [DECIDE] Approve privacy-policy sentences for `card_shown` and observed `finished`/`skipped_at`, and say yes or no to a `"top"` archetype (~10 min)
<!-- ha filed=2026-10-07 kind=default -->

**Why:** The catalogue package (`docs/roadmap/catalogue-personalization.md` §PKG-18 and §PKG-19) makes three more event types leave the phone: `card_shown` (a Home card was dealt to you) and, from the in-app player, `finished` and `skipped_at`. Each is a new kind of data sent to our database, so the privacy policy (`docs/legal/privacy-policy.md`) and the store audit (`docs/legal/data-safety.md`) have to say so in the same PR, and changing a privacy-policy sentence needs your approval (`docs/roadmap/README.md` Q34). The sentences are quoted below as they would land. Nothing is changed yet: neither PR exists, and this item edits no file under `docs/legal/`. The contract for all three already exists in `backend/src/types/events.ts` (`EventTypeSchema`, `CardShownPayloadSchema`, `SkippedAtPayloadSchema`, `FinishedPayloadSchema`) and `docs/curation/events-client-integration-spec.md` §1.2 and §4. The first-run events (`onboarding_seen`, `interests_seeded`, `persona_picked`, `onboarding_skipped`) are not here; they are already with you under #70.

The counts below are computed the way `test/legal-citations.test.js` computes them, on `main` at `43446c00` (2026-10-07): the app records **23** event types (every `logEvent("…")` literal in `app.js` plus every `forayLogEvent("…")` in `player/client.js`) and **4** are transmitted (`picked`, `saved`, `thumbs`, `session_shown`). The plan's own numbers are older; do not use them. All three new types are transmitted, so the local-only count stays at nineteen whatever order the two PRs land in.

Sentence 1, a new row in `docs/legal/privacy-policy.md` §2's **Sent** table (PKG-18):

> | `card_shown` | Episode slug, its topic ids, and which Home slot the card was dealt into (`top` or `stretch`). Logged once per card each time Home deals a new set, not on every redraw. It records that the card was put in front of you, not that you looked at it or tapped it |

Sentence 1 also makes two existing sentences untrue, so the same PR rewrites them. Policy §2, the note on `picked`'s context label (today: "filtered against a five-value allowlist … It does not reveal which recommendation archetype you were shown"):

> - The **context label** is filtered against a six-value allowlist (`app.js:SB_ARCHETYPES`), but the only values `picked` ever produces are `continue` — you resumed something — or a subject/playlist label that the filter discards. So in practice this field is `"continue"` or empty. The Home slot a card was dealt into is sent separately, by `card_shown` (`top` or `stretch`).

And `docs/legal/data-safety.md` A2, the **App activity — App interactions** row's last sentence (today: "… so it is `"continue"` or null in practice — it does not report which recommendation archetype you saw."):

> … so it is `"continue"` or null in practice. `card_shown` does report the Home slot a card was dealt into (`top` or `stretch`).

Sentence 2, two new rows in the same **Sent** table (PKG-19). `finished` is sent only when 4a's own player saw the episode end; `skipped_at` only when you switch to a different episode before 85% of the current one has played. Neither is ever sent for a Foray clip:

> | `finished` | Episode slug, its topic ids, how much of it had played (`percent_complete`, 1 for an episode that ran to its end) and `source: "observed"` — 4a's own player saw it end. On iPhone with Continuous playback on, an episode that runs out and moves to the next one sends no `finished` row |
> | `skipped_at` | Episode slug, its topic ids, how many seconds of it had played when you switched to a different episode (`elapsed_seconds`) and its length (`duration_seconds`). Sent only when you switch before 85% of it has played. Not sent when the iPhone player moves on without the app (Continuous playback, or "next" from a car or the lock screen at the end of Up Next) |

Sentence 3, the count sentences. Which numbers apply depends on which PR lands first; each PR writes the row that matches `main` when it merges:

| State of `main` | `privacy-policy.md` §2 (bold sentence, ~line 230) | `data-safety.md` fact 2 (~line 44) | `data-safety.md` (~line 46) |
|---|---|---|---|
| Today (`43446c00`) | Nineteen of the twenty-three event types the app records never leave the device. | Exactly 4 of 23 event types are transmitted | the four `case` arms |
| PKG-18 merged, PKG-19 not | **Nineteen of the twenty-four event types the app records never leave the device.** | **Exactly 5 of 24 event types are transmitted** | the five `case` arms |
| PKG-19 merged, PKG-18 not | **Nineteen of the twenty-five event types the app records never leave the device.** | **Exactly 6 of 25 event types are transmitted** | the six `case` arms |
| Both merged | **Nineteen of the twenty-six event types the app records never leave the device.** | **Exactly 7 of 26 event types are transmitted** | the seven `case` arms |

Three more places list the transmitted events by name, and they are already wrong today: they name `finished`, which `toEventRow` does not send. The policy's summary bullet (~line 37, today "**Five kinds of event are sent to our database**: which episode you picked, which you finished, …"); `data-safety.md` A2 **App interactions** (~line 96, "The five transmitted events are interactions: picked, finished, saved, thumbs, session shown"); and Apple's **Usage Data — Product Interaction** and **Other Usage Data** rows (~lines 305 and 307, "picked / finished / saved / thumbs / session shown" and "the five mapped types"). Proposed, once both PRs have merged:

> - **Seven kinds of event are sent to our database**: which episode you picked, which Home cards were shown to you, which episodes 4a's player saw you finish or switch away from part-way, which you saved, your thumbs up/down feedback (including any note you type), and the fact that a session was shown to you. They are stored against an anonymous account that contains no name, email or phone number.

> The seven transmitted events are interactions: picked, card shown, finished, skipped, saved, thumbs, session shown (`app.js:toEventRow()`).

> picked / card shown / finished / skipped / saved / thumbs / session shown (`app.js:toEventRow()`). … Nothing beyond the seven mapped types.

If only PKG-18 has merged, the same three read "Five kinds" / "five" and name card shown instead of finished and skipped. Whichever PR merges first also fixes today's `finished` overstatement.

Sentence 4, a separate yes or no (catalogue Q6): add `"top"` to `ArchetypeSlotSchema` (`backend/src/types/events.ts:44`, today `"deep-learn"`, `"stretch"`, `"narrative"`, `"comfort"`, `"continue"`). Home deals by role `top`/`stretch`, and the contract accepts only those five archetypes, so without `"top"` a top-slot `card_shown` has no valid archetype. The proposed default is `docs/roadmap/README.md` item 28, which is a PROPOSAL, not a ruling. No migration is involved: `events.archetype` is unconstrained `text` (`backend/migrations/0009_events.sql:20`); the check in `0008_session_items.sql:12` is on a different table. If you say no, PKG-18 can send only the `stretch` card, and Sentence 1 changes to say so.

For whoever builds PKG-18/19 (not part of the approval): `test/legal-citations.test.js` classifies a type as sent by calling `toEventRow` with one fixed payload (`FAT_PAYLOAD`), which has no `archetype`, `percent_complete`, `source`, `elapsed_seconds` or `duration_seconds`. A mapping that requires those fields will be classified local-only unless that payload gains them. Its number-word table also stops at `twenty-four`; `twenty-five` and `twenty-six` need adding.

**Steps:**
1. Read Sentences 1 to 3 and decide Sentence 4.
2. Reply `approved` (Sentences 1–3) plus `top: yes` or `top: no`, or say what to change. Claude puts the approved wording in the PKG-18 and PKG-19 PRs.

**Worked if:** each sentence above is approved or reworded, Sentence 4 has a yes or no, and when PKG-18 and PKG-19 merge, `docs/legal/` on `main` says what was approved here.

## #149 🟢 [UPGRADE] On a phone, check the download manager against the #29 acceptance list (~20 min)
<!-- ha filed=2026-10-06 kind=default -->

**Why:** Offline downloads are merged (#1020, #1052, #1068, #1073) and unit-tested, but nobody has run them on a phone, and five of #29's acceptance asks can only be proven there: background download, airplane-mode playback, exact bookmarks on a downloaded `dai_suspected` episode, the missing-file fallback, and that the download fetches the publisher's original URL. iPhone only: the Android half waits for the Android native engine (your ruling D-A3, 2026-09-29; #127). The Wi-Fi-only, 2 GB, manual-only behaviour being checked is the default from `docs/roadmap/README.md` question 17, still a proposal, not a ruling. Automatic download of a session's picks is not built (manual-only downloads are the `docs/roadmap/README.md` question 17 default, a proposal, not a ruling), so this check does not cover it. The offline "earcon and advance" path is built (#1145), and step 4's "Offline variant" in `docs/downloads-device-check.md` (line 168) checks it.

**Steps:**
1. Install the first TestFlight build containing #1073 (`3a9dfefa`), or any later one, and turn TestFlight's Automatic Updates off for 4a.
2. Run `docs/downloads-device-check.md` step by step (steps 0 to 7). Step 3's second half needs a second day. Step 4 needs a Mac with Xcode and a development build, and step 6 needs Proxyman or Charles. Mark a step "not run" if you lack those.
3. Post one comment on issue #29 with pass, fail or not run for each step and the build number from Developer → Playback diagnostics → Copy. Add a Copy for any fail.
4. Also, while the phone is out: `docs/share-device-check.md` (~10 min). Nobody has tapped Share on a phone yet (#71). It needs a build at or after `292af726` (#1146), newer than step 1's, so install the latest TestFlight build first. Post its table as one comment on issue #71. Shared links opening in Safari, not 4a, is expected until #145.

**Worked if:** issue #29 has a comment with a result for all eight steps on a named build, and steps 1, 2, 3, 5, 6 and 7 pass. If you ran step 4, issue #71 has its table.

## #148 🟡 [DECIDE] Pick which 4a redesign directions to build (~15 min)
<!-- ha filed=2026-10-05 kind=default -->

**Why:** Phase 2 produced five phone-sized directions. Building starts only once you pick; Claude recommends two. The checkpoint page has a vote mode for passing the phone around.

**Steps:**
1. Open the checkpoint (compare + vote): https://claude.ai/artifact/56qxbdHQ9V5LYyR8r5qCyE
2. Try each on your phone: Tactile https://claude.ai/artifact/6N8mk5PZJc32D8shdHw7GK , Ambient https://claude.ai/artifact/SAQuPQZudiWo3y3eDViZiW , Editorial https://claude.ai/artifact/KJ216C5n7Yu927WKEVY6WD , Native 2026 https://claude.ai/artifact/GnXudytwoQVx57t98wNwGc , Clarity https://claude.ai/artifact/1YAp1DjBVKMzZEgKpkW6UY
3. Recommended: build Tactile and Ambient (15/15 and 12/15 wins, each beat every other direction 3-0; only Tactile passed the art director; Ambient's gaps are small CSS fixes; two different bets, same 3-tab no-drawer IA). Editorial is third. The judge is calibrated only for wide gaps.
4. Reply in a Claude session with the directions to build.

**Worked if:** you have named the directions to build in a Claude session.

## #145 🟡 [DECIDE] Turn on Associated Domains for the iPhone app, so shared links open in 4a (~10 min)
<!-- ha filed=2026-10-05 kind=default -->

**Why:** You asked for shared links to open straight in the app (#1071). The website half is done: `https://foray-web-seven.vercel.app/.well-known/apple-app-site-association` now names the app (Team `D9N628AFHS`, `ai.jwlabs.foura`). The app half needs one line in its entitlements, and Apple refuses to sign a build with that line until the capability is on for the App ID. So only you can flip it, and the line goes in after you do. Until then nothing changes: links open Safari as today.

**Steps:**
1. developer.apple.com → **Certificates, Identifiers & Profiles** → **Identifiers** → `ai.jwlabs.foura`.
2. Tick **Associated Domains** → **Save** → **Confirm**. Leave every other capability as it is.
3. **Profiles** → the App Store profile for `ai.jwlabs.foura` (it now shows **Invalid**) → **Edit** → **Save** → **Download**.
4. GitHub → `JW-Incorporated/foray` → **Settings** → **Secrets and variables** → **Actions** (or the `release` environment, if #115 is done) → `IOS_PROVISIONING_PROFILE_BASE64` → **Update**. Paste the downloaded file as base64 (Mac: `base64 -i <file>.mobileprovision | pbcopy`; Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("<file>.mobileprovision")) | Set-Clipboard`).
5. Reply `done`. Claude then adds `applinks:foray-web-seven.vercel.app` to the app's entitlements and ships it in the next TestFlight build.

**Worked if:** the next TestFlight build signs, and tapping a `https://foray-web-seven.vercel.app/#/show/…` link in Messages or Notes opens 4a on that show.

## #146 🟡 [DECIDE] Copy the Play App Signing fingerprint, so shared links open in the Android app (~5 min)
<!-- ha filed=2026-10-05 kind=default -->

**Why:** Same feature as #145, for Android (#1071). The app already asks Android to open `https://foray-web-seven.vercel.app/` links. Android only agrees once the website publishes `/.well-known/assetlinks.json` with the fingerprint of the key Google signs the app with. Google holds that key (Play App Signing), so its fingerprint is only shown in Play Console. A fingerprint is public, not a secret. The upload key's fingerprint is already in the repo; this is the other one.

**Steps:**
1. Play Console → **4a** → **Test and release** → **Setup** → **App integrity** → **App signing** tab.
2. Under **App signing key certificate**, copy the **SHA-256 certificate fingerprint** (32 pairs like `AB:CD:…`).
3. Paste it here, in a reply to this card. Claude publishes `assetlinks.json` with it.

**Worked if:** on an Android phone with a Play build, tapping a `https://foray-web-seven.vercel.app/#/show/…` link opens 4a without asking which app to use.

## #147 🟢 [UPGRADE] Optional, later: give share links your own address, such as `4a.jwlabs.ai` (~20 min)
<!-- ha filed=2026-10-05 kind=default -->

**Why:** Shared links use `foray-web-seven.vercel.app` for now (your answer on #1071). A custom domain reads better in a message and survives a move away from Vercel. Nothing waits on it. Once it is live, Claude changes one constant (`SHARE_ORIGIN` in `player/incoming-link.js`) and the two site files, and a #145-style entitlement line.

**Steps:**
1. Pick the address (for example `4a.jwlabs.ai`).
2. Vercel → the project that serves `foray-web-seven.vercel.app` → **Settings** → **Domains** → **Add** → type it → follow Vercel's DNS instruction in Cloudflare (`jwlabs.ai`'s DNS), with the record **DNS only** (grey cloud), not proxied.
3. Reply with the address once Vercel shows **Valid Configuration**.

**Worked if:** `https://<your address>/.well-known/apple-app-site-association` opens in a browser and shows the same text as the `foray-web-seven.vercel.app` one.

## #144 🟡 [DECIDE] Add the `founder-approved` label to PR #1087, so the 4a Lab build can run (~2 min)
<!-- ha filed=2026-10-05 -->

**Why:** The "4a Lab" workflow only becomes runnable once it is on `main`. PR #1087 adds only that file and its tests, but it touches governed paths, so it cannot auto-merge without your label. Until then no lab build reaches either phone.

**Steps:**
1. Open https://github.com/JW-Incorporated/foray/pull/1087 and check the checks are green.
2. Right sidebar → **Labels** → choose `founder-approved`.
3. Reply `done` here. The PR then merges; nothing builds until someone presses Run workflow.

**Worked if:** `.github/workflows/lab-build.yml` is on `main`, and Actions → **lab-build** shows a **Run workflow** button.

## #141 🟡 [DECIDE] Approve four privacy-policy sentences for bookmarks, downloads and followed-show alerts (~5 min)
<!-- ha filed=2026-10-04 kind=default -->

**Why:** The player-features plan (`docs/roadmap/player-features.md` §1, founder question 6) adds new rows to the privacy policy's §1 table of what stays on your phone. Changing a privacy-policy sentence needs your approval (`docs/roadmap/README.md` Q34), and these rows sit on a path that would otherwise merge without a review window. So each one is quoted below as written and waits here for your yes. Sentence 1 is in the bookmarks PR (branch `feat/w2-pq-12-14-bookmarks`, issue #30). Sentence 2, the downloads row, is already on `main`: it landed in commit 6ff25eda (PQ-16, #29) without an approval item, so it is quoted here too. Sentences 3 and 4 are in the followed-shows PR (branch `health/ch-pq-26-27`, PQ-26/27, issue #761). Only the PQ-23 §7 sentence on deleting downloaded audio (if it adds one) is left for a later PR to append here.

Sentence 1, the new `cp_bookmarks` row in `docs/legal/privacy-policy.md` §1 (bookmarks stay on the device, with no new event type, under `docs/roadmap/README.md` Q19):

> | `cp_bookmarks` | Bookmarks you set inside episodes — for each episode id, the second you marked, when you set it, an optional label you typed, and the episode's length at that moment (so a bookmark on an ad-stitched show can be shown as approximate if its copy changes). Set from the Now Playing sheet; listed on the episode page. Never sent, never synced | **No** |

Sentence 2, the `cp_downloads` row in `docs/legal/privacy-policy.md` §1, already on `main` since 6ff25eda (PQ-16, #29):

> | `cp_downloads` | Which episodes you downloaded for offline listening, each one's download state and size, the file's location on this device, the episode's length as downloaded, and your "download over cellular" setting. The audio files themselves sit in the app's own storage on the device (Application Support on iPhone, the app's files directory on Android), are never backed up, and are deleted by "Delete my data" and by removing the download | **No** |

Sentence 3, the changed `cp_starred_shows` row in §1 (it said "No notifications"; followed shows now get an "N new" mark in Library, and no phone notification):

> | `cp_starred_shows` | A per-device map of shows you followed from a show page (the Follow button; the key keeps its older "starred" name) — a lightweight favorite, separate from episode saves (`cp_saved`). For each show it also keeps whether new-episode alerts are on (on unless you turn them off on the show's page), when 4a last checked the show for new episodes, the newest publish date that check found, the newest one you have seen, and how many are new. New episodes are marked in your Library on this device only; there is no phone notification. The check asks our API for the show's latest episodes (§4.3). No auto-download, following a show never adds its new episodes anywhere, and never changes what 4a surfaces to you elsewhere | **No** |

Sentence 4, added to §4.3's Vercel paragraph (the same PR also points `data-safety.md`'s "§2 states it" at §4.3, where it is now true):

> Opening a show's page, and the check for new episodes of the shows you follow (`app.js:checkFollowedShows()`, while 4a is open, at most once every six hours per show; a check that failed is tried again the next time 4a is opened), ask the same API for that show's latest episodes: the request carries the show's id and the usual request metadata, and nothing about you.

**Steps:**
1. Read the sentence(s) above.
2. Reply `approved`, or say what to change. Claude makes the change on the PR that carries the sentence, or, for a sentence already on `main`, in a small follow-up PR.

**Worked if:** every sentence quoted here is approved or reworded, and the policy on `main` says the same thing.

**ADDENDUM — Sentences 5-9: the same rows once phone alerts ship (PQ-28..30), to be applied only by PQ-30.** Phone alerts are the iPhone half (PQ-28) and the Android half (PQ-29) of `mobile/plugins/foray-notify`, switched on by PQ-30 (`docs/roadmap/player-features.md` §PQ-28, §PQ-29, §PQ-30; founder question 6 in §1). None of the three is on `main` today (2026-10-09). **Sentences 3 and 4 above stay exactly what `main` says until PQ-30 merges.** Sentences 5-9 are drafted now so you can read them early; PQ-30's PR applies them, and no earlier PR does. They describe PQ-28/29 as `player-features.md` specifies them. If the merged code differs, PQ-30 changes the wording to match the code and brings the changed sentence back here before applying it. Edits to `docs/legal/` and `docs/store/` happen only in PQ-30.

Sentence 5, the `cp_starred_shows` row in `docs/legal/privacy-policy.md` §1 (line 140 today), replacing Sentence 3 once PQ-30 merges. Only the sentence about notifications changes: a phone alert comes only when alerts are on for that show AND you allowed notifications when the phone asked.

> | `cp_starred_shows` | A per-device map of shows you followed from a show page (the Follow button; the key keeps its older "starred" name) — a lightweight favorite, separate from episode saves (`cp_saved`). For each show it also keeps whether new-episode alerts are on (on unless you turn them off on the show's page), when 4a last checked the show for new episodes, the newest publish date that check found, the newest one you have seen, and how many are new. New episodes are marked in your Library on this device. In the iPhone and Android apps, your phone also shows a notification naming the show and its new episode, but only when alerts are on for that show and you allowed 4a's notifications when your phone asked. Your phone makes that notification itself; nothing is sent to anyone to make it. The check asks our API for the show's latest episodes (§4.3). No auto-download, following a show never adds its new episodes anywhere, and never changes what 4a surfaces to you elsewhere | **No** |

Sentence 6, added to §4.3's Vercel paragraph directly after Sentence 4 (Sentence 4 itself stays):

> In the iPhone and Android apps, your phone also runs that check in the background while 4a is closed, for the shows you follow that have alerts on. On an iPhone it uses Apple's background app refresh (`BGAppRefreshTask`): at most about once every six hours, and only when iOS chooses to run it, which can be much less often. On Android it uses the system's `WorkManager`: every six hours, on any network connection, Wi-Fi or mobile data (`NetworkType.CONNECTED`). The background check sends the same request as the check in the open app, the show's id and the usual request metadata, and nothing about you.

Sentence 7, the §5 bullet that says "no notifications" (line ~501 today: "**No location access, no camera, no microphone, no contacts, no calendar, no photos, no notifications.** The app requests no device permissions."). Issue #1163 item 8 (M3) already proposes a rewrite of this whole bullet, verbatim in `docs/audit/privacy-truth-2026-10.md` §M3. Sentence 7 is only a DELTA on that rewrite, so it is not repeated here. Once alerts ship, three phrases in M3's proposed bullet change:

- M3 says: "4a sends no push or reminder notifications, and has no server that could." Becomes: "4a sends no push or reminder notifications from a server, and has no server that could. The only notification about what to listen to is a new-episode alert, which your phone makes itself after its background check (§4.3), only for a show you follow with alerts on, and only if you allowed notifications."
- M3 says: "saying no only hides those controls, and nothing else changes." Becomes: "saying no hides those controls and new-episode alerts, and nothing else changes."
- M3 says: "That is the only device permission the app asks for, and on an iPhone it asks for none." Becomes: "That is the only device permission the app asks for. On an iPhone it is also the only one: 4a asks for it the first time you turn on new-episode alerts for a show, and saying no leaves that show's alerts off."

If M3 has not been approved when PQ-30 opens, `main`'s bullet ("no notifications. The app requests no device permissions.") would be false on both phones. PQ-30 then waits for M3 plus this delta, or carries both for your approval.

Sentence 8, `docs/legal/data-safety.md` rows: **none.** `grep -i notif docs/legal/data-safety.md` finds no notification row on `main` (2026-10-09), so no data-safety row changes. Alerts add no data type: the background check sends what §4.3 already lists. One exception: if #1163 item 8's proposed A2 row "**Permissions (Android)**" (M3) is on `main` before PQ-30, its "for the lock-screen controls" becomes "for the lock-screen controls and new-episode alerts", and its "iOS asks for no permission." becomes "iOS asks only for the notification permission, the first time you turn on a show's new-episode alerts."

Sentence 9, `docs/store/play/full-description.txt` (the Play listing, HA #26):

- Line 22 says: "Follow a show to keep it one tap away in your Library, marked when it has new episodes. Following queues nothing and sends no phone notification." Becomes: "Follow a show to keep it one tap away in your Library, marked when it has new episodes. If you allow notifications, your phone can also tell you when a show you follow has a new episode; turn that off per show. Following queues nothing."
- Line 34 says: "4a keeps no streaks, has no infinite scroll, and sends no notifications to pull you back in." Becomes: "4a keeps no streaks, has no infinite scroll, and sends no notifications to pull you back in. The only alert is a new episode of a show you follow, and only with that show's alerts on."

To answer Sentences 5-9, reply `approved 5-9`, or say what to change, any time before PQ-30 opens. For **Worked if**, Sentences 5-9 count once they are approved or reworded. The policy on `main` says them only after PQ-30 merges.

## #134 🟡 [DECIDE] G6 — Re-confirm D1's liveness/count/recency filter, and settle the language question
<!-- ha filed=2026-10-04 kind=default -->

**Why:** The shows pipeline's filter D1 shipped as a default (`dead != 1`, `episodeCount >= 3`, updated within 24 months), with the language column stored but never applied, pending "re-confirm with Joey's export in hand". `tools/shows/filter.mjs` (S-04a) names this open gate in its own header. Gate G6 of the shows-pipeline plan (`docs/roadmap/shows-search.md`); the plan gives it no default, so it is your call.

**Steps:**
1. Once G7 (Joey's export, #135) lands, ask Claude to run S-04's importer against it and produce fresh per-filter counts.
2. Review those counts and confirm or adjust the liveness thresholds.
3. Decide whether English becomes a catalogue-level filter (non-English shows leave the list entirely) or stays a tape-level concern only (ADR-0008 flags this as unsettled); see `docs/product/suggested-shows-requirements.md` §4.3.

**Worked if:** a decision is recorded here and card S-17 (unclaimed) applies it.

## #135 🟡 [DECIDE] G7 — Joey's PodcastIndex export: format, location, cadence (D3)
<!-- ha filed=2026-10-04 kind=default -->

**Why:** Every shows-pipeline card from S-04a on builds against the **public** PodcastIndex dump as a stand-in. The source is one config value (`DUMP_URL` in `tools/shows/config.mjs`), so swapping in Joey's own export is cheap once it exists. Nothing is blocked today, but G6 (#134) cannot be settled until this lands. Gate G7 of the shows-pipeline plan; no default, so it is a question for you and Joey.

**Steps:**
1. With Joey, decide the export's format (SQLite, CSV or Parquet, keeping the dump's column names), where it lands, and how often it refreshes. If Joey's corpus export (the corpus package, `docs/roadmap/corpus.md`) is meant to be this export, say that instead.
2. Say which here.

**Worked if:** card S-16 can start: swap the source URL and check the column contract.

## #137 🟡 [DECIDE] Search listening test (P-07): five searches on your phone (~10 min)
<!-- ha filed=2026-10-04 kind=default -->

**Why:** The search deck (`docs/search-parity-plan.md`) ends with P-07. The question is not a number: it is whether you find the show you meant without thinking about it. Every search fix so far was measured by a machine; none has been judged on your phone. Each miss you find becomes a test case.

**Steps:**
1. Use the next TestFlight build after 2026093002 (ruled default). Claude writes its number here when it uploads; any later build is fine.
2. Open the Shows page. Do five searches for shows you would actually look for, your choice. Type each one; do not paste.
3. For each, note: what you typed, the show you meant, its position in the list (1 = top) or "not found", and whether you found it without thinking (yes or no).
4. After the fifth: Developer → Playback diagnostics → Copy. (Each search writes one `search` line with timings and hit counts, never the words you typed, so the words come from your notes.)
5. Paste your notes and the Copy here. Claude files them as `docs/field-records/<date>-search-p07.md` from `docs/field-records/TEMPLATE-search-p07.md` (or fill the template yourself).

**Worked if:** the record has five rows. Every "no" becomes a `PARITY_CASES` or `SCAN_REACH_CASES` entry in `tools/search-probe.mjs` through a follow-up task.

## #138 🟡 [DECIDE] Get a read-only key for the transcripts bucket from Joey, and put it in one file on the PC and on hermes-vm (~15 min, with Joey)
<!-- ha filed=2026-10-04 kind=default -->

**Why:** `tools/foraycorpus-export/sync-r2.mjs` is on main and copies the farm's transcripts from R2 `foray-transcriptions`; its first live run (PKG-15) needs a read-only S3 key. Proposed default, `docs/roadmap/README.md` Q3, not a ruling.

**Steps:**
1. Joey: Cloudflare → **R2** → **Manage R2 API Tokens** → **Create API token**: name `foray-corpus-read`, **Object Read only**, bucket `foray-transcriptions` only. Send Wyatt the key ID, secret and S3 endpoint by password manager.
2. Wyatt, PC: save `C:\Users\wjduv\.foray\r2-credentials` (no `.txt`) with `R2_ACCESS_KEY_ID=`, `R2_SECRET_ACCESS_KEY=`, `R2_S3_ENDPOINT=` (values after `=`) and `R2_BUCKET=foray-transcriptions`, one per line.
3. On hermes-vm: the same four lines in `~/.foray/r2-credentials`, then `chmod 600 ~/.foray/r2-credentials`.
4. Never paste the key into a chat, issue or PR. Reply `done` only.

**Worked if:** on the PC, `node tools/foraycorpus-export/sync-r2.mjs --dry-run` prints `objects_seen` above 0 without asking for anything.

## #139 🟡 [DECIDE] Get hermes-vm ready to run the weekly corpus export (~20 min)
<!-- ha filed=2026-10-04 kind=default -->

**Why:** The exporter and its weekly wrapper `tools/foraycorpus-export/weekly.mjs` are on main and need this host. Proposed default, `docs/roadmap/README.md` Q2, not a ruling: weekly cron as `wyatt_readonly`, Releases plus a pointer PR.

**Steps:**
1. On hermes-vm, check `wyatt_readonly` reaches `foraycorpus` (100.79.104.9, tailnet): `psql "<connection string>" -c "select 1"`.
2. Put `FORAYCORPUS_DATABASE_URL=<connection string>` as the one line of `~/.foray/foraycorpus.env`, then `chmod 600 ~/.foray/foraycorpus.env`.
3. `gh auth login`, token for `JW-Incorporated/foray` only (Contents + Pull requests: Read and write, 90 days), then `gh auth setup-git`; set git's global `user.name`/`user.email` if unset.
4. Clone the repo to `~/foray`, run `crontab -e` and add: `0 6 * * 1 cd ~/foray && git pull --ff-only && npm ci --prefix tools/foraycorpus-export && set -a && . ~/.foray/foraycorpus.env && set +a && node tools/foraycorpus-export/weekly.mjs >> ~/.foray/corpus-export.log 2>&1`
5. Reply `done`. Do not paste the connection string or the token anywhere.

**Worked if:** after the next Monday 06:00, `~/.foray/corpus-export.log` ends with a `POINTER_PR:` line naming a draft PR.

## #130 🟡 [DECIDE] Drive the M3 test on the first TestFlight build after `engine/m3` merges (~2 drives)
<!-- ha filed=2026-09-30 kind=default -->

**Why:** M3 makes the car-resume rules final: 4a relaunching after iOS closed it (DV-7a), a car switched off and on, and the provisional timings. Only your car can show them; the pastes settle the values.

**Steps:**
1. Use build **2026100502** (or later; 2026100402 also works). It also shows "4a" as the album when there is none (#1007). It also carries the clip-load retry (#981), approximate loads for CBR clips (#980) and skip during narration (#979), so the M2 failures are re-tested here. TestFlight → 4a → Automatic Updates off.
2. Follow `docs/native-engine-m3-drive-test.md`: step 0, then the 10-minute desk pre-flight.
3. DV-7a: play, pause, Developer → Simulate system termination, then lock the phone (4a closes itself). Press the car's play.
4. DV-7b: force-quit 4a from the app switcher, then press the car's play. Note who plays.
5. Switch the car off while 4a plays; wait 10+ min; switch it on. Then pause in the app, off and on again.
6. Battery: an hour native, an hour on Developer → Playback engine: Web (Settings → Battery).
7. Parked, after each block: Developer → Playback diagnostics → Copy; paste here with the route.

**Worked if:** after the simulated termination the car's play starts 4a (`launch=background`), and a paused 4a stays paused when the car comes back.

## #119 🔴 [BLOCKING] Create the public narration bucket `foray-narration` at `audio.jwlabs.ai` (~30 min)
<!-- ha filed=2026-09-28 kind=default -->

**Why:** You ruled "Defaults" on the Spark direction (2026-09-28, `docs/DECISIONS.md`): narration is rendered once off the phone and streamed like a clip. The files need a public home that is **not** the private transcripts bucket (D6). This is Phase 1's first step, and the first Heart-narrated Foray waits on it. Only you can change Cloudflare.

**Steps:**
1. Cloudflare dashboard, in the **same account that holds `jwlabs.ai`** → **R2** → **Create bucket**. Name it exactly `foray-narration`. Leave the location on Automatic.
2. Open the bucket → **Settings** → **Custom Domains** → **Connect Domain** → type `audio.jwlabs.ai` → Continue → Connect. Leave the **r2.dev** public URL **off**.
3. Same Settings page → **CORS policy** → **Add CORS policy** → paste this and save:
   `[{"AllowedOrigins":["capacitor://localhost","https://localhost","https://jw-incorporated.github.io","https://foray-web-seven.vercel.app"],"AllowedMethods":["GET","HEAD"],"AllowedHeaders":["*"],"MaxAgeSeconds":86400}]`
4. Go to the **jwlabs.ai** site → **Caching** → **Cache Rules** → **Create rule**. Name it `narration immutable`. When: **Hostname equals `audio.jwlabs.ai`**. Then: **Eligible for cache**, Edge TTL **"Use cache-control header if present"**, Browser TTL **"Respect origin"**. Deploy. (Our files say `immutable`, so they are cached for a year and most listens never touch R2.)
5. Never make `foray-transcriptions` public, and never put narration in it. Never turn on **Logpush** for `audio.jwlabs.ai` (the privacy policy relies on there being no per-listener logs).
6. Reply `done`.

**Worked if:** opening `https://audio.jwlabs.ai/` in a browser shows an error page from Cloudflare/R2 (404 is fine while the bucket is empty), not "site can't be reached".

## #120 🔴 [BLOCKING] Make a write key for `foray-narration` and put it in one file on your PC (~10 min)
<!-- ha filed=2026-09-28 kind=default -->

**Why:** The first narration upload runs on your PC (Phase 1), before the Spark is set up. Uploading needs a key, and keys never go in the repo, GitHub or Vercel: only a machine where you put one can write to the bucket (D8). Rendering needs no key and can run anywhere; the upload step (`tools/narration/upload-narration.mjs`) reads the file below and nothing else, and it refuses to run inside GitHub Actions.

**Steps:**
1. Cloudflare → **R2** → **Manage R2 API Tokens** (right side of the R2 page) → **Create API token**. Name: `foray-narration-pc-phase1`. Permissions: **Object Read & Write**. Under **Specify bucket(s)** choose **Apply to specific buckets only** → `foray-narration`. Create.
2. Keep that page open. You need the **Access Key ID**, the **Secret Access Key**, and your **Account ID** (shown on the R2 overview page).
3. On the PC, open File Explorer, type `%USERPROFILE%` in the address bar, press Enter, and make a new folder named `.foray` (so the folder is `C:\Users\wjduv\.foray`).
4. Open Notepad and type these five lines, putting your values after the first three `=` signs (no spaces, no quotes):
   ```
   R2_NARRATION_ACCOUNT_ID=
   R2_NARRATION_ACCESS_KEY_ID=
   R2_NARRATION_SECRET_ACCESS_KEY=
   R2_NARRATION_BUCKET=foray-narration
   NARRATION_PUBLIC_BASE=https://audio.jwlabs.ai
   ```
5. **File → Save As**, open that `.foray` folder, set **Save as type** to **All files**, name it `r2-narration.env`, and save. (If Notepad names it `r2-narration.env.txt`, rename it.)
6. Do **not** paste the key into any chat, issue or PR. Reply `done` only.
7. Later: when the Spark takes over uploads (#121), delete this token in Cloudflare and delete the file.

**Worked if:** the first narration upload Claude runs on your PC finds the file and writes to `foray-narration` without asking you for anything.

## #121 🟡 [DECIDE] Set up the DGX Spark: first boot, network, and its own keys (~2 h, with Joey)
<!-- ha filed=2026-09-28 kind=default -->

**Why:** Phase 3 moves generation and rendering onto the Spark. Joey does the physical care and OS upkeep, **you alone place the secrets**, and agents change the box only through merged PRs plus a `spark-live` tag you move (D8). Not needed for the first listen: Phases 1 and 2 run on the PC.

**Steps:**
1. Decide where the Spark lives, and confirm Joey has hands on it.
2. First boot of DGX OS: turn on **full-disk encryption** at install, then install all updates.
3. Plug it into the router with a cable, and give it a fixed address (a **DHCP reservation** in your router's settings).
4. Optional spend: a UPS (about $100–150).
5. Create a non-root user for the service (for example `foray`). Install **Tailscale** and allow admin SSH with keys only. Do **not** forward any ports on your router.
6. In Cloudflare, create three R2 tokens, each limited to one bucket: **Object Read & Write** on `foray-narration`; **Object Read** on `foray-transcriptions` (not Joey's farm token); **Object Read & Write** on a new **private** bucket `foray-ops` (create it; it holds backups).
7. Put those tokens on the Spark in the file that the Spark runbook (`docs/ops/spark.md`, written in Phase 3) names, readable only by root. Claude will note the exact path on this card when the runbook lands. Keep a copy in your password manager.
8. Then revoke the PC token from #120.

**Worked if:** you can SSH to the Spark over Tailscale, nothing on the internet can reach it directly, and the runbook's check command reports all three tokens present.

## #122 🟡 [DECIDE] Make a GitHub key for the Spark that can only open PRs (~5 min)
<!-- ha filed=2026-09-28 kind=default -->

**Why:** The Spark opens the held PRs for new Forays and narration. Its key must be able to do that and nothing more: no admin, no Actions, no secrets. Needed at Phase 3.

**Steps:**
1. GitHub → your picture → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. Name `foray-spark`. Expiration **90 days**. Resource owner **JW-Incorporated**. Repository access **Only select repositories** → `foray`.
3. Repository permissions: **Contents: Read and write**, **Pull requests: Read and write**, **Issues: Read and write**. Leave everything else at **No access** (especially Administration, Actions, Secrets and Workflows).
4. Generate. If the organization asks you to approve the token, approve it.
5. Put it only on the Spark, in the file the Spark runbook names (as in #121). Never in the repo or a chat. Set a reminder to renew it in 90 days.
6. Reply `done`.

**Worked if:** a test PR opened from the Spark appears on the `foray` repo, and the token cannot open the repo's Settings.

## #123 🟡 [DECIDE] Log Claude Code in on the Spark, and confirm your plan allows it to run unattended (~10 min)
<!-- ha filed=2026-09-28 kind=default -->

**Why:** The Spark writes Forays by asking Claude through the "relay", answered by Claude Code on your subscription at $0 extra (D3). It runs on a schedule with no one watching, so check first that your plan allows that. A capped API key comes later, for unattended daily runs or on-demand.

**Steps:**
1. Check that your Claude plan's terms and usage limits allow an automated, recurring pipeline. If they do not, say so here: the capped key then moves from "later" to "now".
2. On the Spark, as the user the runbook names for the relay, run `claude` and sign in with your account.
3. Later (optional spend, when you want unattended daily runs or on-demand): in the Anthropic Console, make a workspace `spark-generation` with a **hard monthly spend limit**, create a key there, and put it on the Spark in a root-only file. Not now.
4. Reply `done`.

**Worked if:** the runbook's relay check on the Spark answers one test request.

## #125 🟡 [DECIDE] Approve the privacy-policy rewrite for streamed narration, when its PR opens (~15 min)
<!-- ha filed=2026-09-28 kind=default -->

**Why:** With narration at `audio.jwlabs.ai`, 4a runs a server in the audio path. The privacy policy and data-safety notes say today that there is none and that "we never see it", and they describe the phone's voice list. Those sentences become false and must be rewritten before rendered narration reaches listeners (Phase 2). Since 2026-10-05 `docs/legal/` is a governed path, so the PR never auto-merges and its `path-policy` check stays red until your `founder-approved` label is on it (it also carries `hold`).

**Steps:**
1. When Claude posts the PR link here, read the changed sentences in `docs/legal/privacy-policy.md`, `docs/legal/data-safety.md` and `docs/legal/third-party-notices.md`.
2. Reply `approved`, or say what to change.
3. If the App Store or Play privacy answers repeat the old sentences, update them the same way (as in #109).

**Worked if:** the PR merges with your approval, and no store text still says 4a has no server in the audio path.

## #126 🟢 [UPGRADE] Tell Joey what moves to the Spark (~5 min)
<!-- ha filed=2026-09-28 kind=default -->

**Why:** Joey's work converges on the Spark, and he looks after the box (D8).

**Steps:**
1. Tell Joey, in your own words: narration is now rendered centrally and streamed from `audio.jwlabs.ai`; his Spark benchmark decides CPU versus GPU rendering; the nightly content step (#760) and, last of all, the transcript farm move to the Spark (D10); his rig and the AMD path (#28) retire after that; foray-db's Apple-transcript engine (#831) could run there too; he does physical care under the runbook, and you place all keys.
2. Reply `done`.

**Worked if:** Joey has acknowledged it.

## #127 🟢 [UPGRADE] Android device pass (Joey's Pixel) — not issued yet: waits for the Android native engine (~30 min per milestone)
<!-- ha filed=2026-09-29 kind=default -->

**Why:** Replaces the Android half of #11, closed on iPhone evidence; no human has run 4a on Android. Founder ruling D-A3 (2026-09-29): no device pass and no request to Joey until the Android native engine is fully operational, after A-42.

**Steps:**
1. Nothing yet. Do not ask Joey. A session edits this item when A-42 (`docs/plans/android-assessment.md` §5) has landed and issues the pass.
2. Then Joey, on the Pixel 10 Pro: install the latest build from the Play internal-testing opt-in link (#44).
3. Run `docs/android-device-pass.md` (the A-14 script) step by step, writing pass or fail for each.
4. Paste each Developer → Playback diagnostics → Copy into the `docs/field-records/` template the script names.

**Worked if:** a filled Android device-pass record for a build carrying A-42 is in `docs/field-records/`.

## #117 🟢 [UPGRADE] On a phone, check six player fixes from audit round 3 that no machine here can hear (~20 min)
<!-- ha filed=2026-09-25 kind=default -->

**Why:** Branch `r3fix/l3-player-and-native-tts` fixes narration and transport bugs that only a real speaker proves; unit tests carry the logic. Use a Foray with spoken narration, on the web player (Developer → web player on iOS).

**Steps:**
1. iOS: during a narration line press pause, then Next clip onto another line. The new line must be heard (mobile-native-1).
2. Android: open the voice picker mid-narration and tap Preview. The picker must say "Preview is unavailable while the narrator is on a line." and the Foray must keep speaking that line, not skip it (mobile-native-2; a preview would cut the line off, so it is refused).
3. Android, airplane mode, a network-only voice: narration must move on at once, not after a long silence (mobile-native-3).
4. iOS over Spotify: play a Foray to its end without pausing. Spotify must offer to resume (mobile-native-4).
5. Pause, or press Stop, while a rendered bridge line is still loading: nothing may start playing (player-core-2).
6. Screen locked, press Next during a slow start: the next clip must play, not stop (player-core-3).

**Worked if:** all six behave as written; paste Developer → Playback diagnostics → Copy into the card thread for any that do not.

## #115 🔴 [BLOCKING] Put the app-signing and store-upload secrets behind a protected `release` environment (~15 min)
<!-- ha filed=2026-09-25 kind=default -->

**Why:** Round-3 code audit, finding `ci-release-3` (`docs/audit/round-3-code/`). The signing and upload secrets (the iOS distribution certificate, the App Store Connect key, the Android keystore, the Play service account and their passwords) are **repository** secrets, and there is no tag ruleset. So any branch push can carry a workflow that reads them, and a `v*` tag on a commit that edits `release.yml` or `tools/mobile/release-ci.mjs` passes its own guard. The repo is public, which makes this a real exposure, not a theoretical one. Only an admin can change these settings, and moving the secrets means re-entering them. You asked for this to be your follow-up (2026-09-25). The code side (`environment: release` on the release jobs) is prepared in the round-3 security PR, and it stays inactive until this is done, because switching it on first would break every release.

**Steps:**
1. GitHub → foray → **Settings → Environments → New environment**, named `release`. Under **Deployment branches and tags**, choose **Selected branches and tags** and add `main` and the tag pattern `v*`.
2. In that environment, **add each signing and upload secret again** with the same name and value: everything `gh secret list` shows for iOS signing (`IOS_DIST_CERT_P12_BASE64` and its password, the provisioning profile, `APP_STORE_CONNECT_KEY_ID` / `ISSUER_ID` / `PRIVATE_KEY_BASE64`) and Android (`ANDROID_KEYSTORE_B64` and its passwords and alias, `PLAY_SERVICE_ACCOUNT_JSON`). Then **delete the repository-level copies** under Settings → Secrets and variables → Actions.
3. **Settings → Rules → Rulesets → New tag ruleset**: target `v*`, restrict creation to admins.
4. Recommended while you're there (security-3 and security-1): **Settings → Actions → General**: set **Workflow permissions** to *Read repository contents*, untick **Allow GitHub Actions to create and approve pull requests**, and set **Fork pull request workflows** to *Require approval for all outside collaborators*.
5. Reply `done` here. Claude then turns on `environment: release` in `release.yml` and cuts one release to prove signing still works.

**Worked if:** `gh secret list` no longer shows the signing and upload secrets at repo level, `gh api repos/JW-Incorporated/foray/environments/release` exists, and the next release run (with `environment: release`) uploads to both stores.

**Check:** `node tools/ops/release-env-check.mjs` (read-only; needs an admin `gh` token) prints READY and exits 0 only when steps 1-3 are all done. Do not merge PR #822 until it does (exit 1 = not done yet, exit 2 = could not read a setting).

## #116 🟡 [DECIDE] Apply the round-3 Supabase security migration to the production project (~10 min)
<!-- ha filed=2026-09-25 kind=default -->

**Why:** Round-3 code audit, question Q3. The fix lane adds a new numbered migration under `backend/migrations/`. It turns on row-level security for the catalogue and pipeline tables, adds per-table policies on `events`, `user_interests` and `taxonomy_nodes` (with event timestamps set by the server), and adds a delete policy on `learning_cursor` so **Delete my data** can remove that table's rows too. The code and the privacy-policy rows describing it land in the round-3 fix PR, but **nothing reaches the live database until you apply it**. You asked for this to be your follow-up (2026-09-25).

**Steps:**
0. Supabase dashboard → the 4a project → **SQL editor**: paste `backend/migrations/supabase/verify-applied.sql` and run it. It is read-only, so it is safe on production. It returns one row per migration, `applied` = `yes`/`partial`/`no`, plus what is missing. Apply only the migrations below that read `no` or `partial`, and paste the result here when you reply.
1. Wait for the round-3 fix PR to merge. The migration is `backend/migrations/supabase/0003_rls_least_privilege.sql`.
2. Supabase dashboard → the 4a project → **SQL editor**. Paste that file's contents, read it, and run it (or `supabase db push` if you use the CLI).
3. Check it worked: re-run `verify-applied.sql`; `supabase/0003_rls_least_privilege.sql` reads `yes`. **Table editor** shows RLS **enabled** on each table the migration names. As an anonymous user, the app still loads Home, and **Developer → Playback diagnostics** shows no `sync` or `events` errors.
4. Also apply `backend/migrations/supabase/0005_content_reports.sql` the same way, once its PR (PH2-10, the `content_reports` table for the Report sheet) merges. It needs nothing else, so it can go in the same sitting. Check: re-run `verify-applied.sql`; `supabase/0005_content_reports.sql` reads `yes`, and **Table editor** shows `content_reports` with RLS **enabled** and three policies. (Note `0004_rls_shows_catalog.sql` is also unapplied: it waits for gate G2, after the portable 0017-0019, so leave it for that step.)
5. Also apply `backend/migrations/supabase/0006_event_retention.sql` the same way, once its PR (#951, the 90-day retention job, founder ruling HA #13) merges. It needs only 0001-0003, so it can go in the same sitting. Until it runs, the privacy policy's 90-day retention paragraph stays a draft and nothing deletes an event row. Check: re-run `verify-applied.sql`; `supabase/0006_event_retention.sql` reads `yes`, and `select jobname, active from cron.job where jobname like 'foray-prune-%';` returns 2 rows, both `active = true`. Once it runs, #14 can be closed: the job removes the empty anonymous accounts.
6. Reply `done` with the final `verify-applied.sql` result (or paste any SQL error) here.

**Worked if:** `verify-applied.sql` reads `yes` for 0001-0003, 0005 and 0006 (0004 waits for gate G2, so it may still read `no`). RLS is on for every table the migration lists, the app still syncs events and interests, and Delete my data removes the `learning_cursor` rows (check in the Table editor after a test deletion). `content_reports` exists with RLS on. The two `foray-prune-%` cron jobs exist and are active.

## #44 🟡 [DECIDE] Add the founders as Play testers, so Play actually emails you (R-08)
<!-- ha filed=2026-09-11 kind=default -->

**Why:** `release.yml` has uploaded every build since 2026-09-06 to
Play's internal testing track (latest: run 34381675121, build 2026090908,
`Successfully committed`) and Apple mails you for each one — but Google Play
mails the **testers on the track, not the developer account**, and the track
has no tester

**Steps:**
1. Decide the track. **Internal testing** (up to 100 testers, no review,
2. **Play Console** → `4a` → **Release → Testing → Internal testing →
3. Same tab, **Copy link** under *How testers join your test*. Open it while
4. Optional but useful: install the build from that link once, so the next
5. Replace the two placeholders above with the real addresses (or say which

**Worked if:** the next `release.yml` run on `main` (a `v*` tag or *Run
workflow*) produces **one App Store email and one Play email for the same
build number** in your inbox. That is R-07's third acceptance item an

## #34 🟡 [DECIDE] Type the new App Store Connect listing name into Apple's dashboard
<!-- ha filed=2026-09-11 kind=default -->

**Why:** Apple rejected the App Store Connect submission because the
bare name **`4a`** is already taken by another app/reservation (App Store
"Name" must be globally unique). Founder decision, 2026-09-02 (Discord): the
listing name becomes **`4a: Podcast Curator`**. This is an App Store Connect
web-dashboar

**Steps:**
1. Open App Store Connect → My Apps → (the 4a app record) → App Information.
2. In the **Name** field, enter exactly: `4a: Podcast Curator`
3. Save.

**Worked if:** App Store Connect shows the new name and the "name already in
use" submission error is gone.

---

## #33 🟡 [DECIDE] Enable leaked-password protection in Supabase Auth settings
<!-- ha filed=2026-09-11 kind=default -->

**Why:** The Supabase database linter flagged that leaked-password
protection (the HaveIBeenPwned check on new/changed passwords) is off. This is
a toggle in the Supabase dashboard's Authentication settings — not a database
migration, so no worker/agent can apply it.

**Steps:**
1. Open the Supabase dashboard for this project.
2. Go to **Authentication** → **Settings** (Auth providers/Policies page,
3. Enable **"Leaked password protection"** (the HaveIBeenPwned check).
4. Save.

**Worked if:** the toggle shows enabled, and the Supabase linter no longer
lists this WARN on a re-run of Advisors → Security.

---

## #26 🟡 [DECIDE] Publish the Play Store listing from `docs/store/play/`
<!-- ha filed=2026-09-11 kind=default -->

**Why:** Every asset Play requires for 4a now exists and is checked
in — the 1024x500 feature graphic, four 720x1280 phone screenshots, the short and
full descriptions. None of it reaches the store without a founder in the Play
Console: it needs the developer account's identity and login, and it is a
click-t

**Steps:**
1. Open Play Console -> your app (4a) -> Grow -> Store presence -> Main store listing.
2. App name: type 4a. Full description: paste docs/store/play/full-description.txt (2946 chars, plain text). Rewritten in wave 16 (2026-10-07, issue #42): the 2202-char text described the retired four-card Home; the new one describes the shipped app (Forays, Home's rails, Up Next with Continuous playback, downloads, Family mode). The four screenshots are still the 2026-08-25 ones and are stale; a recut is a separate follow-up (docs/store/play/README.md §6).
3. Short description: paste docs/store/play/short-description.txt (71 chars). New in wave 15: "Forays: one subject across many shows, plus new episodes picked for you" (replaces the "stitched" line).
4. App icon: upload docs/store/play/app-icon-512.png (512x512, 32-bit with alpha) -- NOT the repo-root icon-512.png, which Play rejects.
5. Feature graphic: upload docs/store/play/feature-graphic.png (1024x500).
6. Phone screenshots: upload all four docs/store/play/screenshot-*.jpg files (720x1280 each), in numeric order 1-4.
7. Save, then check Play Console shows no red warnings on Main store listing or App content, and submit the listing for review.
8. Confirm: 4a resolves in a Play search or on its own store URL once the review completes.

**Worked if:** the Play Console shows the listing as complete with no red
warnings on Main store listing or App content, and `4a` resolves in a Play search
or on its own store URL.

## #14 🟡 [DECIDE] Delete the empty anonymous accounts a client cannot delete itself
<!-- ha filed=2026-09-11 kind=default -->

**Why:** The in-app **Delete my data** control (now built) deletes every row an account owns, in every per-user table, and discards the token so the next event creates a **new** anonymous account rather than re-attaching. What it cannot delete is the `auth.users` row itself: that needs the Admin API and a **

**Steps:**
1. In the Supabase dashboard, open **SQL Editor** and add a `security definer` function that deletes the caller's own auth user — the standard shape is `delete from auth.users where id = auth.uid();` ins
2. Tell whoever picks up the follow-up (or reply here) that it exists, and the client will call `POST /rest/v1/rpc/delete_own_account` as the last step of the deletion — **after** the row deletes, since
3. Decide whether the same function should also cascade the per-user tables. It does not need to — the client already deletes them — but it makes the server-side path complete on its own, which matters i
4. While in there: consider a **retention job** for anonymous accounts with no events at all (item 13, step 4, needs a number for the policy either way). The same sweep can collect shells from before thi

**Worked if:** calling the RPC as an ordinary anonymous user removes that user from `auth.users` and returns success, and calling it cannot remove anybody else's (test it twice, with two different anonymous tokens).

## #1 🟡 [DECIDE] Make `path-policy` a required check on `main`
<!-- ha filed=2026-09-11 kind=default -->

**Why:** The allow/deny path list used to live inside the auto-merge
workflow, so it governed only what GitHub Actions did. On 2026-08-16 two PRs
were merged from a laptop with `gh pr merge` and a founder token and went
straight past it — not by defeating the deny-list, but because on that route
there was no

**Steps:**
1. ~~Turn on enforcement~~ — **done 2026-08-16.** For reference:
2. Add `path-policy` to the required checks on `main`. Click path:

**Worked if:** open any PR that edits a file under `.github/`. Its checks list
shows `path-policy` **failing** with "GOVERNED PATHS — NOT APPROVED (blocking)",
and the merge button is disabled. Add the `founder-appr
