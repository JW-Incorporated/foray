# Human actions — foray

<!-- ha-format: 2 -->

> **32 open.** Closed items are in `HUMAN-ACTIONS-DONE.md` — you never need it.
> To close one: reply `done` (or `skip <why>`) to its card in the project's human-action channel.
> Anything else you reply is forwarded to a thread on the card.

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

## #43 🔴 [BLOCKING] Rule on `docs/search-plan.md`'s privacy gate (G1) — it blocks four cards of the search rebuild
<!-- ha filed=2026-09-11 kind=keyword -->

**Why:** `docs/search-plan.md` (Hermes deck, written 2026-09-09) cuts
the Shows-search rebuild into cards S-01 through S-08 and cards them on the
`foray` Kanban board. §3 names five human gates (G1–G5); this item is **G1**,
the one gate that actually stops code from shipping. Quoting the plan exactly:
*"Unti

**Steps:**
1. Read `docs/search-plan.md` §3 (human gates table) and §S-07 for the full
2. Reply in the `#4a` Discord channel or comment directly on kanban card
3. If you pick C (recommended): no further action from you until S-03 lands
4. If you pick A or B outright: say so, and S-07's diffs will be finished and

**Worked if:** kanban card `t_c21e53c3` (foray board) has your decision
recorded in a comment, and cards S-02's network half, S-05, S-06, S-08 are no
longer waiting on this item.


---

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

## #39 🟡 [DECIDE] Decide how the shard-index client (S-05) reaches GitHub Release assets — CORS gap measured, not fixed
<!-- ha filed=2026-09-11 kind=keyword -->

**Why:** S-04b publishes the shard index as GitHub Release
assets. Measured against a real release already in this repo
(`kokoro-fixture-t_f3c788ca`): a download URL
(`github.com/<owner>/<repo>/releases/download/<tag>/<asset>`) redirects
(302) to a presigned URL on `release-assets.githubusercontent.com` (an

**Steps:**
1. Read docs/DECISIONS.md's 2026-09-05 'S-04b' entry: GitHub Release asset URLs redirect to release-assets.githubusercontent.com with no CORS headers, so a client fetch() fails as shipped.
2. Choose option (a): front release assets with a CORS-capable proxy (e.g. a Cloudflare Worker or an object-storage mirror the pipeline also uploads to).
3. Or choose option (b): route the fetch through this repo's own api/ layer as a same-origin proxy, matching the pattern api/shows/[show_id]/episodes.ts already uses.
4. Say which option in a comment on this item or on the S-05 kanban card, since S-05 (the shard-index client) cannot start its CSP connect-src change without this call.
5. Worked-if is already set: S-05's design doc or PR states which option it picked and why, and any CSP change lands in that same PR.

**Worked if:** S-05's design doc (or its PR) states which option it picked
and why, and the CSP change (if any) lands in that same PR per the
project's existing rule.


---

## #35 🟡 [DECIDE] Merge PR #429 (Stage 3b full-catalogue RSS ingestion) — first Vercel serverless function, needs Wyatt's architecture sign-off
<!-- ha filed=2026-09-11 kind=default -->

**Why:** `t_a36252bb` ("remove the listen-elsewhere link-out, play everything in-app") depends on `t_567b570f` shipping real `audio_url`s at scale. That work is done and reviewed (round 3, 216/216 local tests pass, GitHub CI green) in PR #429, but it is genuinely gated on a human decision, not just a routine

**Steps:**
1. Read the "For Wyatt: one thing to look at specifically" section at the top of PR #429: https://github.com/JW-Incorporated/foray/pull/429
2. Decide: is reusing the existing Vercel project + existing Supabase service-role connection an acceptable way to stand up the first live backend endpoint, or do you want a different shape?
3. If acceptable: add the `founder-approved` label (or ask Hermes to add it) and merge (or authorize Hermes to merge) the PR.
4. If not acceptable: say what should change; the implementing lane will revise.

**Worked if:** PR #429 is merged to `main` (or explicitly redirected), unblocking `t_a36252bb`.

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
1. TODO — steps needed

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

## #27 🟡 [DECIDE] Rebase (or reconfigure) five of the six classify shard branches onto `main`, past PR #203
<!-- ha filed=2026-09-11 kind=default -->

**Why:** PR #203 (2026-08-16) fixed the classify shard key from
`Number(id) % N` (2.20x unbalanced) to `fnv1a32(String(id)) % N` and merged to
`main`. Measured 2026-08-31, **five of the six live shard branches
(`origin/reclassify-0,1,2,4,5`) never received that fix** — they forked from
`origin/reclassify` on

**Steps:**
1. Run: git fetch origin 'refs/heads/reclassify-*:refs/remotes/origin/reclassify-*' to pull the six shard branches.
2. Dry-run the merge tool: node tools/classify/reconcile-shards.mjs --dry-run — it reports the numbers without writing anything.
3. Review the printed stats, especially cross_shard_conflicts (about 30 shows resolved by newest classified_at).
4. If the numbers look right, run it for real: node tools/classify/reconcile-shards.mjs (writes data/breadth-classification.json, still needs a PR to land).
5. Commit and open a PR with the result (data/ auto-merges on green CI per this repo's merge_authority: agent).
6. Confirm the fix: re-run node tools/classify/reconcile-shards.mjs --dry-run afterward and check every shard reports shard_key hashed, not hashed+legacy.

**Worked if:** a fresh dry-run of `node tools/classify/reconcile-shards.mjs
--dry-run` some time after this ships reports `shard_key hashed` (not
`hashed+legacy`) for all six branches, meaning every branch's own new

## #26 🟡 [DECIDE] Publish the Play Store listing from `docs/store/play/`
<!-- ha filed=2026-09-11 kind=default -->

**Why:** Every asset Play requires for 4a now exists and is checked
in — the 1024x500 feature graphic, four 720x1280 phone screenshots, the short and
full descriptions. None of it reaches the store without a founder in the Play
Console: it needs the developer account's identity and login, and it is a
click-t

**Steps:**
1. TODO — steps needed

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

## #23 🟡 [DECIDE] Apply `founder-approved` to PR #297, so something watches for a dark night
<!-- ha filed=2026-09-11 kind=default -->

**Why:** On 2026-08-20 and 2026-08-21 the nightly content pipeline
produced nothing and every workflow in the list was green (#290). The Action did
its half both nights and logged *"published digest: 29 resolved episodes"* both
nights; the Cloud agent that turns a digest into a PR had hit a weekly usage
limi

**Steps:**
1. TODO — steps needed

**Worked if:** (not stated in the legacy item -- needs a real Worked-if)

## #22 🟡 [DECIDE] Rule on the alcohol Foray's product mode, and on three narration rules that collide
<!-- ha filed=2026-09-11 kind=keyword -->

**Why:** (not stated in the legacy item -- needs a real Why)

**Steps:**
1. TODO — steps needed

**Worked if:** one of A, B or C is written into `docs/DECISIONS.md` with a date.
That file is on `DENIED_PREFIXES`, so the entry needs a separate PR carrying the
`founder-approved` label; it was deliberately not add

## #21 🟡 [DECIDE] After the next drive, copy the playback diagnostics out of the drawer
<!-- ha filed=2026-09-11 kind=default -->

**Why:** Two reports came out of your car in one
evening and neither carried a number, so each one restarted the diagnosis — #224
has been escalated, downgraded on one clean test, and re-escalated on a failure.
Five changes have shipped into the seam and transport area (#227, #235, #239,
#260, #266) with no

**Steps:**
1. Before the drive, open the app's menu (☰) → **Playback diagnostics** → **Clear
2. Drive. Play a Foray with the screen off, as usual. Nothing else to do.
3. Afterwards, same menu → **Playback diagnostics** → **Copy**, and paste it into

**Worked if:** one pasted record from a real drive. **The single most valuable
line in it is a seam that says `NEVER STARTED`** — that is #224, with the stage it
reached and the deadline it was measured against, whi

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

## #19 🟡 [DECIDE] Get an Apple Developer account and add seven secrets, so CI can put a build on TestFlight
<!-- ha filed=2026-09-11 kind=default -->

**Why:** #38 built the iOS build in CI, and **it works without any of this**: `.github/workflows/ios-build.yml` compiles the shell unsigned on every run, for both the simulator and a real device's architecture, and that is deliberate — an unsigned build that always runs is worth more than a signing job that

**Steps:**
1. Join the Apple Developer Program at **`https://developer.apple.com/programs/enroll/`** ($99/year). Apple may take a day or two to approve.
2. In **App Store Connect** (`https://appstoreconnect.apple.com`) → **Users and Access** → **Integrations** → **App Store Connect API** → **+**, create a key with the **App Manager** role. You get three
3. In the developer portal → **Certificates, Identifiers & Profiles**:
4. Base64-encode the three files. On a Mac:
5. At **`https://github.com/JW-Incorporated/foray/settings/secrets/actions`**, click **New repository secret** seven times and create **exactly these names** (the workflow reads these and no others — a t
6. Run the workflow: **`https://github.com/JW-Incorporated/foray/actions/workflows/ios-build.yml`** → **Run workflow**.

**Worked if:** a run of `ios-build` shows `state=ready` at the "Is signing configured?" step and a build appears in App Store Connect → TestFlight. If it gets as far as `altool` and then fails, that is the expected

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
1. TODO — steps needed

**Worked if:** #40 says whether it gates the first public release, and the status below says DONE.


---

## #16 🟡 [DECIDE] On a Mac: generate the iOS shell, add one `Info.plist` line, and build it
<!-- ha filed=2026-09-11 kind=default -->

**Why:** (not stated in the legacy item -- needs a real Why)

**Steps:**
1. Install the toolchain, if it is not there. Xcode must be from the App Store, opened once so it accepts its licence. **Do not install CocoaPods — Capacitor 8 does not use it.**
2. Install the shell's dependencies and build the web bundle:
3. Generate the iOS project:
4. **Add the background-audio key.** This is the single most important step, and it is the *entire* iOS background-audio requirement — no plugin, no Swift, no audio-session code. Open `mobile/ios/App/App
5. Open and run it:
6. **The five things to report back**, in one comment on #36:
7. Does the app launch and show the four cards?
8. **In the Safari Web Inspector console (Safari → Develop → your device → App), type `Capacitor` and press enter. Is it defined, or does it say "Can't find variable"?** This is the single most important
9. See the pre-migration item text at commit 275b35e7c023aea1b9b94f28b9f2596ea4502d0b (legacy HUMAN-ACTIONS.md, item #16).

**Worked if:** there is a comment on #36 answering the four questions in step 6, and `mobile/ios/` is committed with `UIBackgroundModes: audio` in its `Info.plist`.

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

## #11 🟡 [DECIDE] Put a Foray on a real phone with the screen off — the one test no machine here can run
<!-- ha filed=2026-09-11 kind=default -->

**Why:** (not stated in the legacy item -- needs a real Why)

**Steps:**
1. On your phone, open exactly this:
2. Press **Play**. Let one segment start (they are ~1–3 minutes each).
3. **Lock the phone** (side button) and put it in your pocket. Keep listening.
4. After about 15 minutes, unlock and look at the running order.
5. Also say whether the audio **stopped** at any point, and roughly when.
6. **New, 2026-08-17 — and this is now the most useful thing you can report.**

**Worked if:** there is a written note on #35 saying, for at least one real phone: whether audio continued with the screen locked, for how long, and whether segments kept advancing. Three sentences is a complete res

## #10 🟡 [DECIDE] Make the six classify routines land their own work (they open no PR)
<!-- ha filed=2026-09-11 kind=default -->

**Why:** Each routine commits to **`origin/reclassify-<N>`** and

**Steps:**
1. TODO — steps needed

**Worked if:** `data/breadth-classification.json` on `main` gains
`classify-agent-tier1` rows within 48 hours without anyone running a command
locally — either from six `classify/*` PRs, or from one
`classify/reconc

## #8 🟡 [DECIDE] Listen to Foray #2, and rule on one number the cut budget cost us
<!-- ha filed=2026-09-11 kind=keyword -->

**Why:** (not stated in the legacy item -- needs a real Why)

**Steps:**
1. **Listen to it end to end.** Play it at
2. **Then rule on the cut budget.** The rolling cut budget (rule D1, "no more

**Worked if:** you say one of exactly three things — "publish it", "publish it
and raise N", or "here is what I heard that the rules missed".


---

## #7 🟡 [DECIDE] Confirm the fleet's target list stays the chart-200 catalogue
<!-- ha filed=2026-09-11 kind=default -->

**Why:** Before spending four weeks classifying 17,875 shows, confirm
they are the right 17,875 — because the list has a hard, measured ceiling and
this is a decision about what we are choosing not to see.

`data/catalog-breadth.json` is, by construction, "the top 200 of each of 110
Apple genre charts" — `CH

**Steps:**
1. Read `docs/agents/fleet-review-2026-08.md` §1.
2. Reply **"keep the list"** (recommended) or **"broaden first"**, and change
3. Either way, one thing is worth knowing and does not need a decision: a show

**Worked if:** nobody re-opens "should we have classified a different list?" in
week three.


---

## #6 🟡 [DECIDE] Decide: add the usability fields before the four-week run, or after
<!-- ha filed=2026-09-11 kind=keyword -->

**Why:** This is a sequencing decision, and it is cheap now and
expensive later — which is the only reason it is here rather than being decided
by a session.

The fleet records 14 fields per show — nine describing subject or display copy,
five recording provenance. **None of them records whether a show is *u

**Steps:**
1. Read `docs/agents/fleet-review-2026-08.md` §5 — it is one table of fields
2. Reply with either **"schema first"** or **"blitz first"** and change the
3. If **schema first**, expect the engineering PR to also carry: `--shard`

**Worked if:** a session can start the four-week run without having to guess
whether it will need to be run twice.


---

## #5 🟡 [DECIDE] Give each of the six classify routines its own `--shard i/6`
<!-- ha filed=2026-09-11 kind=default -->

**Why:** `tools/classify/prepare-batch.mjs` supports sharding
(`--shard i/N` — take only the shows that shard owns, by a hashed, stable key).

**Steps:**
1. Open <https://claude.ai/settings/automations> on the account that owns the
2. For each of the six routines, set the schedule and the shard argument as
3. Then set the full command each routine should run — copy it literally, changing only
4. **Do not guess the shard string.** It must read `0/6`, `1/6`, `2/6`, `3/6`,

**Worked if:** within one 8-hour window, **six different** `classify/*` PRs have
merged, and no two of them classified the same show. Quick check after a day:
`git log origin/main --oneline -- data/breadth-classific

## #3 🟡 [DECIDE] Reconcile the two silence numbers: 0.5 s in the brief, 2.0 s in the rules
<!-- ha filed=2026-09-11 kind=default -->

**Why:** Two committed documents give different numbers for the
silence at a seam, and as of this change the player implements one of them, so
the other is now wrong in a way a reader cannot detect:

- `docs/brief/04_VOICE_AUDIO_SPEC.md`, line 12: *"Transitions: hard cuts are
  fine; add ~0.5 s of silence pa

**Steps:**
1. Listen first (item #2). This is a judgement about a sound.
2. Pick one of three:
3. 0 s…", "an unbridged segment-to-segment auto-advance…"),
4. Whichever you pick, delete the "does not decide" bullet in

**Worked if:** `04_VOICE_AUDIO_SPEC.md` and `segment-length-rules.md` can both
be read start to finish without coming away with two different answers to "how
much silence goes at a seam".

## #2 🟡 [DECIDE] Listen to Foray #1 end to end, then decide whether to publish it
<!-- ha filed=2026-09-11 kind=keyword -->

**Why:** Foray #1 — the 61-minute history of grilling — is now real
data (`data/forays.json`, issue #182), and every number about it is a property
of timestamps and transcripts. **Nobody has heard it.** It is committed as
`"status": "draft"`, which by the same rule that governs ladders means no client
may ev

**Steps:**
1. Read the running order: `docs/curation/grilling-foray.md` §2 (32 rows, in
2. Listen. **There is a player now** — #111 / #128 / #133 landed, so this is no
3. Decide. If it holds together, change **one word** in `data/forays.json`:

**Worked if:** either `data/forays.json` says `"status": "published"` on
`grilling-history-1`, or there is a written note saying what a listener heard
that the rules did not catch.

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
