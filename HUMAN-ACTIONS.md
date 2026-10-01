# Human actions — foray

<!-- ha-format: 2 -->

> **28 open.** Closed items are in `HUMAN-ACTIONS-DONE.md` — you never need it.
> To close one: reply `done` (or `skip <why>`) to its card in the project's human-action channel.
> Anything else you reply is forwarded to a thread on the card.

## #130 🟡 [DECIDE] Apply the event-retention migration to the production Supabase project (~10 min)
<!-- ha filed=2026-09-30 -->

**Why:** The privacy policy promises event rows are deleted after 90 days and empty anonymous accounts are pruned. Nothing deletes anything until this migration runs on the live project.
**Steps:**
1. Open https://supabase.com/dashboard/project/qjdllvqdcgacvujhclny/sql/new
2. Paste the whole file backend/migrations/supabase/0004_event_retention.sql from the foray repo, then click Run.
3. Reply done, or paste the error text if Run failed.

**Worked if:** `select jobname, active from cron.job where jobname like 'foray-prune-%';` returns 2 rows, both active = true.

## #129 🟡 [DECIDE] Read the Supabase project's region and paste it here (~2 min)
<!-- ha filed=2026-09-30 -->

**Why:** The privacy policy must say where user data is stored, and the region is not in the repo. Without it the policy republish (HA #13 ruling) cannot finish.
**Steps:**
1. Open https://supabase.com/dashboard/project/qjdllvqdcgacvujhclny/settings/general
2. Copy the value under Region (for example "East US (North Virginia)").
3. Reply with that value.

**Worked if:** you replied with the region, and the privacy policy section 3 names it.

## #46 🔴 [BLOCKING] Nightly content has been stalled since 2026-09-14 — its Cloud routine is switched off (~5 min)
<!-- ha filed=2026-09-13 kind=default -->

**Why:** The original problem here — the two workflows not firing — is gone: both have run on schedule every day since 2026-09-13. They are red **on purpose**. The Cloud routine that turns each night's digest into a PR, `foray-nightly-enrich`, has been **disabled since its last run on 2026-09-13** (around the 2026-09-13 pause). So the 2026-09-14 digest (40 episodes) was never consumed, and every `nightly-refresh` run since has stopped at its overwrite guard (`OVERWRITE_WOULD_LOSE`) rather than throw those episodes away; `nightly-watch` then reports that run as failed. Nothing in the code is wrong and no secret is missing — this needs your decision, because turning the routine back on spends your Claude usage. Verified 2026-09-22 from the run logs of all eight failed runs and the routine's own state.

**Steps:**
1. Decide whether nightly content should resume. If yes, tell Claude "re-enable foray-nightly-enrich" (routine `trig_019yeYEFW8mZLHDXGQL3vD5x`), or switch it back on yourself in your claude.ai scheduled routines.
2. Clear the stranded 2026-09-14 digest, one of two ways:
   - **Accept losing those 40 episodes (quick):** Actions → `nightly-refresh` → Run workflow, tick **overwrite_unmerged_digest**. The next scan starts fresh.
   - **Keep them:** tell Claude "recover the 2026-09-14 nightly digest". It re-cuts the scan back to the 14th and opens `nightly/2026-09-14-recovery`, which is the branch name the guard looks for.

**Worked if:** the next scheduled `nightly-refresh` run is green, a `nightly/<date>` PR opens the same day, and `nightly-watch` is green that evening.

**Spark note (2026-09-28):** under the Spark direction (`docs/DECISIONS.md` 2026-09-28) the nightly step moves to the Spark (Phase 5). Step 2, dropping or recovering the stranded 2026-09-14 digest, must be decided before the first Spark nightly runs, even if the routine stays off until then.

## #128 🟡 [DECIDE] Drive a Foray in the car on the first TestFlight build after `engine/m2` merges (~2 drives)
<!-- ha filed=2026-09-28 kind=default -->

**Why:** M2 moves Forays onto the iPhone's own player (clips, narration, jingle), as M1 did for episodes, which your car resumed on 2026-09-28. Only your car can show that a Foray survives seams, long pauses, calls and car buttons.

**Steps:**
1. Use build **2026092903** (or later). TestFlight → 4a → Automatic Updates off.
2. In the car, play a Foray with narration. Listen through at least two clip → narration → clip seams.
3. Pause from the car. Leave it 10+ minutes (or park). Press the car's play.
4. Take or make a phone call mid-Foray; hang up.
5. Press skip-back 15 and skip-forward 30 from the car, once each.
6. Check the car shows the title and a moving progress bar.
7. Parked: Developer → Playback diagnostics → Copy; paste here with the route.
8. If a Foray will not play or keeps stopping: Developer → Playback engine → Web, then restart 4a. Episodes and Forays go back to the web player. Say so here.

**Worked if:** every seam plays; after the pause and the call 4a resumes by itself or on one press; 15/30 move; title and progress bar show.

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

## #124 🟢 [UPGRADE] Note: R2 storage will pass the 10 GB free tier at about 650–700 Forays (~1 min)
<!-- ha filed=2026-09-28 kind=default -->

**Why:** You asked to be told before R2 costs money. Each Foray adds about 14 MB of narration (Heart + Echo), and old files are never deleted, because phones may still point at them. Past 10 GB it costs about $0.015 per GB a month: roughly $0.06 a month at 1,000 Forays and about $2 a month at 10,000. Downloads stay free.

**Steps:**
1. Reply `ok` to accept, or name the cap you want instead.

**Worked if:** you replied.

## #125 🟡 [DECIDE] Approve the privacy-policy rewrite for streamed narration, when its PR opens (~15 min)
<!-- ha filed=2026-09-28 kind=default -->

**Why:** With narration at `audio.jwlabs.ai`, 4a runs a server in the audio path. The privacy policy and data-safety notes say today that there is none and that "we never see it", and they describe the phone's voice list. Those sentences become false and must be rewritten before rendered narration reaches listeners (Phase 2). Legal wording under `docs/` would auto-merge, so the PR carries `hold` and waits for you.

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

## #116 🟡 [DECIDE] Apply the round-3 Supabase security migration to the production project (~10 min)
<!-- ha filed=2026-09-25 kind=default -->

**Why:** Round-3 code audit, question Q3. The fix lane adds a new numbered migration under `backend/migrations/`. It turns on row-level security for the catalogue and pipeline tables, adds per-table policies on `events`, `user_interests` and `taxonomy_nodes` (with event timestamps set by the server), and adds a delete policy on `learning_cursor` so **Delete my data** can remove that table's rows too. The code and the privacy-policy rows describing it land in the round-3 fix PR, but **nothing reaches the live database until you apply it**. You asked for this to be your follow-up (2026-09-25).

**Steps:**
1. Wait for the round-3 fix PR to merge. The migration is `backend/migrations/supabase/0003_rls_least_privilege.sql`.
2. Supabase dashboard → the 4a project → **SQL editor**. Paste that file's contents, read it, and run it (or `supabase db push` if you use the CLI).
3. Check it worked: **Table editor** shows RLS **enabled** on each table the migration names. As an anonymous user, the app still loads Home, and **Developer → Playback diagnostics** shows no `sync` or `events` errors.
4. Reply `done` (or paste any SQL error) here.

**Worked if:** RLS is on for every table the migration lists, the app still syncs events and interests, and Delete my data removes the `learning_cursor` rows (check in the Table editor after a test deletion).

## #109 🟡 [DECIDE] Mirror the approved privacy wording in the store listings, if they carry it (~10 min)
<!-- ha filed=2026-09-24 kind=default -->

**Why:** You approved the privacy-policy reconciliation on 2026-09-24 ("Approved", round-2 finding `persist-3`), and PR #749 applies it to `docs/legal/privacy-policy.md` and `docs/legal/data-safety.md`. You update the store listings yourself, so any copy of these sentences in App Store Connect or the Play Console is still the old wording. None of the form ANSWERS changed; Search history is still "No" on both. Only the wording changed.

**Steps:**
1. Wherever the privacy policy is published or pasted for either store, use the new text. Three changes, all in `docs/legal/privacy-policy.md`: §5 now says `connect-src` names **three** origins (the app, Supabase, and our API on Vercel, which receives the Shows search text with your IP address and user-agent); §4.3 gains the paragraph naming **Vercel** as the processor that answers Shows searches ("4a does not log the query"); the `cp_diag` row lists the search, now-playing, remote-command and native-session rows.
2. If the Play Data safety form or App Store Connect's App Privacy notes repeat the old "miss-only" sentence (a search that misses the local catalogue is looked up off-device), replace it with the sentence in `docs/legal/data-safety.md`'s two search-history rows: every settled Shows search is sent to 4a's API (Vercel) and is not logged as a search-history event.
3. If neither store carries these sentences, reply `skip none carried`.

**Worked if:** no store-facing text says "two origins" or "miss-only", and the published policy names Vercel.

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
2. App name: type 4a. Short description: paste docs/store/play/short-description.txt (73 chars). Full description: paste docs/store/play/full-description.txt (2202 chars, plain text).
3. App icon: upload docs/store/play/app-icon-512.png (512x512, 32-bit with alpha) -- NOT the repo-root icon-512.png, which Play rejects.
4. Feature graphic: upload docs/store/play/feature-graphic.png (1024x500).
5. Phone screenshots: upload all four docs/store/play/screenshot-*.jpg files (720x1280 each), in numeric order 1-4.
6. Save, then check Play Console shows no red warnings on Main store listing or App content, and submit the listing for review.
7. Confirm: 4a resolves in a Play search or on its own store URL once the review completes.

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
