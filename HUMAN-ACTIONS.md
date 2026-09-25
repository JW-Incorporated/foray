# Human actions — foray

<!-- ha-format: 2 -->

> **22 open.** Closed items are in `HUMAN-ACTIONS-DONE.md` — you never need it.
> To close one: reply `done` (or `skip <why>`) to its card in the project's human-action channel.
> Anything else you reply is forwarded to a thread on the card.

## #46 🔴 [BLOCKING] Nightly content has been stalled since 2026-09-14 — its Cloud routine is switched off (~5 min)
<!-- ha filed=2026-09-13 kind=default -->

**Why:** The original problem here — the two workflows not firing — is gone: both have run on schedule every day since 2026-09-13. They are red **on purpose**. The Cloud routine that turns each night's digest into a PR, `foray-nightly-enrich`, has been **disabled since its last run on 2026-09-13** (around the 2026-09-13 pause). So the 2026-09-14 digest (40 episodes) was never consumed, and every `nightly-refresh` run since has stopped at its overwrite guard (`OVERWRITE_WOULD_LOSE`) rather than throw those episodes away; `nightly-watch` then reports that run as failed. Nothing in the code is wrong and no secret is missing — this needs your decision, because turning the routine back on spends your Claude usage. Verified 2026-09-22 from the run logs of all eight failed runs and the routine's own state.

**Steps:**
1. Decide whether nightly content should resume. If yes, tell Claude "re-enable foray-nightly-enrich" (routine `trig_019yeYEFW8mZLHDXGQL3vD5x`), or switch it back on yourself in your claude.ai scheduled routines.
2. Clear the stranded 2026-09-14 digest, one of two ways:
   - **Accept losing those 40 episodes (quick):** Actions → `nightly-refresh` → Run workflow, tick **overwrite_unmerged_digest**. The next scan starts fresh.
   - **Keep them:** tell Claude "recover the 2026-09-14 nightly digest". It re-cuts the scan back to the 14th and opens `nightly/2026-09-14-recovery`, which is the branch name the guard looks for.

**Worked if:** the next scheduled `nightly-refresh` run is green, a `nightly/<date>` PR opens the same day, and `nightly-watch` is green that evening.

## #115 🟢 [UPGRADE] On a phone, check six player fixes from audit round 3 that no machine here can hear (~20 min)
<!-- ha filed=2026-09-25 kind=default -->

**Why:** Branch `r3fix/l3-player-and-native-tts` fixes narration and transport bugs that only a real speaker proves; unit tests carry the logic. Use a Foray with spoken narration, on the web player (Developer → web player on iOS).

**Steps:**
1. iOS: during a narration line press pause, then Next clip onto another line. The new line must be heard (mobile-native-1).
2. Android: open the voice picker mid-narration and Preview. The Foray must not skip the line (mobile-native-2).
3. Android, airplane mode, a network-only voice: narration must move on at once, not after a long silence (mobile-native-3).
4. iOS over Spotify: play a Foray to its end without pausing. Spotify must offer to resume (mobile-native-4).
5. Pause, or press Stop, while a rendered bridge line is still loading: nothing may start playing (player-core-2).
6. Screen locked, press Next during a slow start: the next clip must play, not stop (player-core-3).

**Worked if:** all six behave as written; paste Developer → Playback diagnostics → Copy into the card thread for any that do not.

## #114 🟡 [DECIDE] Drive the M1 car test on the next TestFlight build after `engine/m1` merges — the native player is its default (~3 drives)
<!-- ha filed=2026-09-24 kind=default -->

**Why:** On 2026-09-24 your car chose Spotify even though 4a held its audio session for 8 minutes (`docs/field-records/2026-09-24-car-baseline.md`): iOS goes back to the app whose audio last *played*, and in 4a that was the web view's process. The iOS app now plays episodes through its own native player, and card NE-27b made that the build default (`mobile/ENGINE_DEFAULT.json` says `native` with `episode`, `continuation` and `restore`; the Developer group can switch back to the web player). Whether the car now comes back to 4a can only be measured in your car. Nothing here can do it.

**Steps:**
1. Wait for **the next TestFlight build after `engine/m1` merges into `main`**. Its `ios-archive --check` log must show `ForayEngineDefault=native`. Claude will reply on this card with that build's number. Test **only that build**, and turn TestFlight's Automatic Updates off for 4a so it cannot change mid-drive.
2. Follow `docs/native-engine-m1-car-test.md` from **Step 0**: the header check, the 10-minute desk pre-flight, then blocks 0-11 in the car. Each block ends with one **Developer → Playback diagnostics → Copy**, taken while parked.
3. Blocks **0 and 1** are the two failures from 2026-09-24: paused in the app, phone locked, the car connects and 4a resumes; and paused from the car, a long pause, play, and 4a resumes and stays.
4. Paste every Copy into this card's thread, one per block, each headed with its block number and the route (CarPlay, car Bluetooth, AirPods or speaker). M1 needs **three drives**.
5. If the build is unusable for daily listening, TestFlight → 4a → **Previous Builds** puts the old one back. You do not need Claude for that. Say so here.

**Worked if:** across three drives, `node tools/mobile/engine-report.mjs` over the Copies shows no `sessionActivated failed`, no `remote play handled=y` without audio, and no takeover except the negative control (block 7, which should go to Spotify). DV-12 and DV-13 pass, and blocks 0 and 1 play 4a.

## #109 🟡 [DECIDE] Mirror the approved privacy wording in the store listings, if they carry it (~10 min)
<!-- ha filed=2026-09-24 kind=default -->

**Why:** You approved the privacy-policy reconciliation on 2026-09-24 ("Approved", round-2 finding `persist-3`), and PR #749 applies it to `docs/legal/privacy-policy.md` and `docs/legal/data-safety.md`. You update the store listings yourself, so any copy of these sentences in App Store Connect or the Play Console is still the old wording. None of the form ANSWERS changed; Search history is still "No" on both. Only the wording changed.

**Steps:**
1. Wherever the privacy policy is published or pasted for either store, use the new text. Three changes, all in `docs/legal/privacy-policy.md`: §5 now says `connect-src` names **three** origins (the app, Supabase, and our API on Vercel, which receives the Shows search text with your IP address and user-agent); §4.3 gains the paragraph naming **Vercel** as the processor that answers Shows searches ("4a does not log the query"); the `cp_diag` row lists the search, now-playing, remote-command and native-session rows.
2. If the Play Data safety form or App Store Connect's App Privacy notes repeat the old "miss-only" sentence (a search that misses the local catalogue is looked up off-device), replace it with the sentence in `docs/legal/data-safety.md`'s two search-history rows: every settled Shows search is sent to 4a's API (Vercel) and is not logged as a search-history event.
3. If neither store carries these sentences, reply `skip none carried`.

**Worked if:** no store-facing text says "two origins" or "miss-only", and the published policy names Vercel.

## #45 🟡 [DECIDE] Run the voice-engine probe on your phone — the one measurement no machine here can take (K-01)
<!-- ha filed=2026-09-12 kind=default -->

**Why:** the platform voices came back "all so bad" (2026-09-11) and the picker is
cut down to Samantha as a stopgap. The real fix is our own neural voice bundled in
the app (`docs/bundled-voice-plan.md`). Everything downstream of that — the engine,
the player, which three voices ship — waits on ONE number nobody here can produce:
how fast a real phone synthesizes it, in how much memory, with the screen locked.
The go/no-go rule was written before the run so it cannot be read generously
afterwards: RTF ≤ 0.8 warm on the newest phone, ≤ 1.5 on the oldest tried, peak
memory ≤ 400 MB, and the passage completes with the screen locked.

**Status, 2026-09-13 (third attempt — most of the way there):** you ran this on
build **2026091316** and got

```
voiceProbe kokoro-probe/cpu  rtf cold 0.00 warm 0.00  load 467ms/388ms  peak 290.9MB  locked=n  batt —  over 77.4s
```

**Most of that is real and it is the first time any of it existed.** The weights
reached your phone, the model loaded in 467 ms cold / 388 ms warm, and it peaked at
290.9 MB — comfortably under the 400 MB ceiling. **Nothing you did was wrong.**

The two RTF zeroes were ours, not yours: the app was dividing the synthesis time by
an audio length it had **estimated** rather than one the phone had **rendered**, so
a synthesis that produced nothing came out as `0.00` — which happens to beat every
ceiling in the go rule. That is fixed (#685): the phone now reports the audio it
actually made, an impossibly fast RTF is rejected as a failed measurement instead of
celebrated, and if synthesis produces nothing the line says
`could not measure: synthesis-failed/<which failure>` in plain words. **A `could not
measure` line on the next run is a useful result, not a wasted trip — paste it.**

One clause is still completely untested: `locked=n` means the phone was never
locked, so we do not know whether our voice keeps speaking with the screen off.
That is one of the four go/no-go conditions.

**Steps:**
1. Install the first TestFlight (or Play internal) build numbered **higher than 2026091316**. Nothing at or below that number can produce a trustworthy measurement — 2026091316 is the build that reported the two zeroes — so check the build number before you start.
2. Open the menu, tap **Developer** at the bottom of Settings, turn on **"Voice engine probe"**, and tap **"Run the voice engine probe"**.
3. **Lock the phone immediately — within a second or two, and in any case BEFORE the passage finishes.** It runs about 78 seconds. This is not tidiness: whether synthesis survives the lock screen is one of the four go/no-go clauses, the app can only report the weaker fact that it was not frontmost when the last line ended, and locking in time is what turns that into the real answer. Locking late reads as a FAILURE, not as a missing number — so if you mistime it, say so and run it again rather than sending the record.
4. When the passage stops, unlock, tap **Copy** in the sheet that is already open, and paste the whole record here.
5. Do the same on Joey's Pixel 10 Pro, and on the oldest phone either of you can find — say which record is which phone and which OS version.
6. If a record says "could not measure" rather than giving numbers, paste it anyway and stop there. `model-absent` means the build did not fetch the weights; `engine-absent` means it fetched them but the runtime did not load; `synthesis-failed/…` means both worked and the inference itself did not, and the part after the slash names which. All three are build problems, not phone ones, and all three are ours to fix. Likewise an `rtf … 0.00!` with an exclamation mark, or `over 0.0s` — those mean the run measured nothing and we need the line, not a re-run.

**Worked if:** a pasted diagnostics record carrying a `voiceProbe` line with real
numbers on it, one per phone, each labelled with the device and OS version. Those
numbers go into `docs/research/on-device-tts.md` §10 and decide K-04.
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

## #40 🟡 [DECIDE] Download one Enhanced iPhone voice, then re-listen to the narration test
<!-- ha filed=2026-09-11 kind=default -->

**Why:** #29 came back with two results, and the second one has been
misread. The locked-screen question passed. The other observation was that the voice
was "much worse than the original test" — the original being the Kokoro fixture. That
was taken as evidence about on-device TTS. It was not: `ForayTtsPlugi

**Steps:**
1. On the iPhone, open **Settings → Accessibility → Spoken Content → Voices → English**.
2. Pick a voice and tap the **download arrow** beside it. Any Enhanced or Premium voice
3. Write down the exact names of every voice that now shows as downloaded. That is the
4. Open **4a**, tap the menu, and choose **Narration voice**. Find the voice you
5. **Report:** does it sound meaningfully better than what you heard on 2026-09-05?

**Worked if:** there is a written note saying which voice was downloaded and whether the
narration sounded better with it. Both halves are needed — "sounds better" without the
voice name cannot be reproduced, and th

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

## #31 🟡 [DECIDE] Before phase 2 is scheduled: build the four App Store Guideline 1.2 UGC-moderation requirements
<!-- ha filed=2026-09-11 kind=default -->

**Why:** `docs/curation/generation-architecture.md` §1.3 already says this in
the engineering docs: *"The moment a stranger's prompt produces content other users can
hear, 4a hosts user-generated content and App Store Guideline 1.2 applies: content
filtering, a mechanism to report objectionable content, a wa

**Steps:**
1. Read docs/curation/generation-architecture.md §1.3: phase 2 is the moment any user's prompt (not just Wyatt/Joey's) produces a Foray other users can hear.
2. The four required App Store Guideline 1.2 pieces, none of which exist yet: (1) content filtering on generated Forays.
3. (2) a mechanism for a user to report objectionable content.
4. (3) a way to block abusive users.
5. (4) published developer contact information in the app/store listing.
6. Decide who builds each of the four, and file/update a kanban card scoping them before phase 2 is scheduled on the roadmap.
7. Reply with the ruling (e.g. 'build all four before phase 2 starts', or a different sequencing) so this item can close.

**Worked if:** (not stated in the legacy item -- needs a real Worked-if)

## #28 🟡 [DECIDE] Run the new AMD/Vulkan transcription path on your actual RX 6700 XT and report the numbers
<!-- ha filed=2026-09-11 kind=default -->

**Why:** `tools/transcribe` §3 only ever worked for NVIDIA cards
— CUDA is NVIDIA-proprietary, and `faster-whisper`/`ctranslate2` (the whole
CPU/CUDA stack) has no AMD support at all, not even a slow one. Your RX 6700
XT could not use the GPU path that existed before this change; it would
either error outrig

**Steps:**
1. Follow `tools/transcribe/README.md` §3b exactly — download a
2. **Confirm the GPU actually engaged.** The run's console output should
3. Paste the JSON line the script prints at the end (starts with
4. If it errors, paste the exact error — most likely failure modes are (a)

**Worked if:** you have a real `realtime_multiple` number for your RX 6700
XT on at least one model size, and the Vulkan device line confirms the GPU
(not the CPU) produced it.

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
2. App name: type 4a. Short description: paste docs/store/play/short-description.txt (73 chars). Full description: paste docs/store/play/full-description.txt (2202 chars, plain text).
3. App icon: upload docs/store/play/app-icon-512.png (512x512, 32-bit with alpha) -- NOT the repo-root icon-512.png, which Play rejects.
4. Feature graphic: upload docs/store/play/feature-graphic.png (1024x500).
5. Phone screenshots: upload all four docs/store/play/screenshot-*.jpg files (720x1280 each), in numeric order 1-4.
6. Save, then check Play Console shows no red warnings on Main store listing or App content, and submit the listing for review.
7. Confirm: 4a resolves in a Play search or on its own store URL once the review completes.

**Worked if:** the Play Console shows the listing as complete with no red
warnings on Main store listing or App content, and `4a` resolves in a Play search
or on its own store URL.

## #24 🟡 [DECIDE] Amend ADR-0008: a ranged GET can be lied to as well, and 5,461 transcripts rest on that
<!-- ha filed=2026-09-11 kind=default -->

**Why:** ADR-0008 §"What is actually measured, and how" says, in as
many words: *"**HEAD requests lie** on ad-inserting hosts: they return the
ad-free master's `Content-Length` while a real GET delivers the assembled file.
The first version of this scan used HEAD, reported 18 of 18 shows byte-stable,
and was

**Steps:**
1. **Does ADR-0008 get amended, and by whom?** `docs/adr/` is a governed path, so
2. **What do we spend to settle the other four flightcast shows?** ~~Six~~
3. **Do we now distrust the ranged GET everywhere, or only where it has been
4. **Around the House with Eric G carries 313 s of undeclared audio, and

**Worked if:** (not stated in the legacy item -- needs a real Worked-if)

## #22 🟡 [DECIDE] Rule on the alcohol Foray's product mode, and on three narration rules that collide
<!-- ha filed=2026-09-11 kind=keyword -->

**Why:** (not stated in the legacy item -- needs a real Why)

**Steps:**
1. Read docs/curation/alcohol-forms-coverage.md §1: rule whether SYSK-register general-interest shows count as usable tape for this Foray.
2. If OUT: the report becomes 1 strong / 4 thin / 58 empty. If IN as thin: it stays 1 strong / 15 thin / 47 empty. State which.
3. Read docs/curation/narration-craft.md §2d (Carry-by-default vs Carry-by-design) and §2e (merge rule for chained empty beats) -- these collide for this narration-heavy Foray.
4. Rule: when a Carry-by-design beat (never droppable) sits in a chain that would exceed the 180s hard max, does it force an early split or absorb neighbors first.
5. Write the ruling into docs/DECISIONS.md with a date, in its own PR carrying founder-approved (docs/DECISIONS.md is on DENIED_PREFIXES).

**Worked if:** one of A, B or C is written into `docs/DECISIONS.md` with a date.
That file is on `DENIED_PREFIXES`, so the entry needs a separate PR carrying the
`founder-approved` label; it was deliberately not add

## #20 🟡 [DECIDE] Revoke one leaked anonymous Supabase session, and delete one CI artifact
<!-- ha filed=2026-09-11 kind=default -->

**Why:** The `ios-shell-evidence` artifact of run

**Steps:**
1. In the Supabase dashboard for project **`qjdllvqdcgacvujhclny`**, open
2. **Then** delete the artifact: open
3. While you are in the dashboard, it is worth confirming that **anonymous sign-in

**Worked if:** requesting a token refresh with that `refresh_token` returns an
error rather than a new session, and the run page shows no `ios-shell-evidence`
artifact.

---

## #18 🟡 [DECIDE] On Android: settle whether our CSP kills Capacitor's bridge
<!-- ha filed=2026-09-11 kind=default -->

**Why:** This is the **top open risk** in the whole native-app change, and it can be settled by reading one line in a console.

Capacitor injects its native bridge (`native-bridge.js`, the app config, and every plugin's JavaScript) into the page as an **inline `<script>`**. Foray's page carries a strict CSP

**Steps:**
1. Install **JDK 21** (Capacitor 8 dies on JDK 17 with `invalid source release: 21`) and the Android **platform tools** (for `adb`).
2. Build the app:
3. Turn on **Developer options → USB debugging** on the phone, plug it in, and install:
4. Open the app on the phone. On the computer, open Chrome and go to **`chrome://inspect`**, then click **inspect** under the Foray app.
5. **In that console, type `Capacitor` and press enter.** Report which you get:
6. Either way, also say whether the four cards render and whether search works.

**Worked if:** there is a comment on #36 quoting what `Capacitor` evaluated to in the Android console, plus any CSP error text verbatim.

## #17 🟡 [DECIDE] Decide: does the app ship with data frozen at build time?
<!-- ha filed=2026-09-11 kind=keyword -->

**Why:** The app bundles `data/*.json` — the session, the discover pool, the taxonomy, the Foray running orders. That is what makes it work offline in a cell dead zone, which is the founding constraint. But **the bundle is a snapshot taken when the app was built, and nothing in the app refreshes it.** The we

**Steps:**
1. Read GitHub issue #40 (MP6: data freshness) -- design already written: bundle a snapshot, fetch fresh data/*.json on launch, cached-fresh -> bundled -> error precedence.
2. Decide: does the first public store release ship with #40's fetch-refresh built (data updates without a store release), or ship frozen (bundle only, fast-follow later).
3. If frozen for v1: confirm that's acceptable given the app's offline-first promise, and note the fast-follow timeline.
4. If #40 is required before release: it needs the CSP connect-src widened to the Pages data origin (docs/mobile-shell.md §3) plus a kanban card.
5. Reply with the ruling so this item and GitHub issue #40 can both be closed/marked DONE.

**Worked if:** #40 says whether it gates the first public release, and the status below says DONE.

---

## #14 🟡 [DECIDE] Delete the empty anonymous accounts a client cannot delete itself
<!-- ha filed=2026-09-11 kind=default -->

**Why:** The in-app **Delete my data** control (now built) deletes every row an account owns, in every per-user table, and discards the token so the next event creates a **new** anonymous account rather than re-attaching. What it cannot delete is the `auth.users` row itself: that needs the Admin API and a **

**Steps:**
1. In the Supabase dashboard, open **SQL Editor** and add a `security definer` function that deletes the caller's own auth user — the standard shape is `delete from auth.users where id = auth.uid();` ins
2. Tell whoever picks up the follow-up (or reply here) that it exists, and the client will call `POST /rest/v1/rpc/delete_own_account` as the last step of the deletion — **after** the row deletes, since
3. Decide whether the same function should also cascade the per-user tables. It does not need to — the client already deletes them — but it makes the server-side path complete on its own, which matters i
4. While in there: consider a **retention job** for anonymous accounts with no events at all (item 13, step 4, needs a number for the policy either way). The same sweep can collect shells from before thi

**Worked if:** calling the RPC as an ordinary anonymous user removes that user from `auth.users` and returns success, and calling it cannot remove anybody else's (test it twice, with two different anonymous tokens).

## #13 🟡 [DECIDE] Six facts only you can supply before the privacy policy can be published
<!-- ha filed=2026-09-11 kind=default -->

**Why:** `docs/legal/privacy-policy.md` and `docs/legal/data-safety.md` now exist and are written **from the code**, not from a template — the Data Safety and App Privacy forms can be filled in by copying verified answers. Everything derivable from the software is answered. What is left is six facts no agent

**Steps:**
1. **Legal entity name** to name as data controller. (`privacy-policy.md` §9.)
2. **A privacy contact address.** Both stores require a working contact, and Play's Data Safety form requires a public privacy-policy URL. Nothing was invented.
3. **The Supabase project's region / hosting jurisdiction**, and whether a data-processing agreement exists. Needed to say where data is stored, and required if EU users are in scope. (§3.)
4. **Retention:** how long event rows are kept. Nothing in the code ever deletes one, and no retention job exists (ADR-0005 anticipated one).
5. See the pre-migration item text at commit 275b35e7c023aea1b9b94f28b9f2596ea4502d0b (legacy HUMAN-ACTIONS.md, item #13).

**Worked if:** `docs/legal/privacy-policy.md` contains no `TODO(founder)` markers, and the answers in `docs/legal/data-safety.md` can be pasted into both forms without a judgement call left in them.

---

## #12 🟡 [DECIDE] Decide: does Android's native audio backend land before the Play release?
<!-- ha filed=2026-09-11 kind=keyword -->

**Why:** #34 plans to wrap the web app in a Capacitor shell and ship both stores, **Google Play first**, because Play is more lenient about webviews and Android builds on Windows today. The MP1 research (`docs/research/mp1-background-audio.md`) does not overturn that, but it found that on *audio* the two pla

**Steps:**
1. Read §9 and §10 of `docs/research/mp1-background-audio.md` — two short sections, one table.
2. Reply with one of the three phrases above and change the status below. A session will re-scope #28, #27 and #34 to match.

**Worked if:** #28 and #27 say the same thing about Android as #34's milestone order does, and nobody has to re-derive it.

---

## #8 🟡 [DECIDE] Listen to Foray #2, and rule on one number the cut budget cost us
<!-- ha filed=2026-09-11 kind=keyword -->

**Why:** (not stated in the legacy item -- needs a real Why)

**Steps:**
1. **Listen to it end to end.** Play it at
2. **Then rule on the cut budget.** The rolling cut budget (rule D1, "no more

**Worked if:** you say one of exactly three things — "publish it", "publish it
and raise N", or "here is what I heard that the rules missed".

---

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
