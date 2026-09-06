# Plan: iOS and Android releases in lockstep

*Drafted 2026-09-06 from Wyatt's report: "I get all kinds of emails that 4a
updates in the App Store, but never the Play Store." Hermes card deck. Nothing
here is built yet.*

**Status:** proposed. Assumes the human actions (Play Console setup, a Play API
service account) will be late, so Track A ships real improvements with no human
in the loop and Track B flips the Play upload live when the gate clears.

---

## 0. What is actually happening (measured 2026-09-06, `main` @ `#452` merged)

The two stores are not out of sync. **One store is being uploaded to constantly
and the other has never been uploaded to by automation at all.**

| | iOS (`ios-build.yml`) | Android (`android-release.yml`) |
|---|---|---|
| Triggers | `workflow_dispatch` + **`pull_request`** on `mobile/**`, `tools/mobile/**`, `index.html`, `app.js`, `player/**` | `workflow_dispatch` + `pull_request` only when the release pipeline itself changes |
| Runs in the last 2 days | **17**, almost all `pull_request` from feature branches | 1 |
| Runs ever | many | **4** total; the only `workflow_dispatch` from `main` (2026-08-30) **failed** |
| Upload step | "Archive, export and upload to TestFlight", gated **only** on `steps.signing.outputs.ready == 'true'` | **none** — the signed `.aab` is stored as a GitHub Actions *artifact* for a founder to download and submit by hand (`docs/android-release.md` §5: "Unzip it. The file to submit is `foray-release.aab`") |
| Store credential | 6 App Store Connect / signing secrets, all present | 3 keystore secrets present; **no Play Console service-account secret exists** |
| Version per upload | `CFBundleVersion = run_number.run_attempt` (unique automatically); `MARKETING_VERSION` untouched at 1.0 | `versionCode` is a **manual dispatch input**; Play permanently rejects a reused one |
| Listing | live enough to receive TestFlight builds | `HUMAN-ACTIONS.md` **#26** (publish the Play listing) and **#30** (upload key + secrets) both **OPEN** |

Two consequences follow directly:

1. **The App Store emails are TestFlight processing notices for PR builds.** GitHub
   makes repo secrets available to same-repo `pull_request` runs, the upload
   step has no `event_name` guard, so every PR that touches the app ships a
   TestFlight build from an *unmerged branch*. That is the flood, and it is
   also wrong on its own terms: what TestFlight testers get is not `main`.
2. **Play never receives anything** because nothing uploads to it. Even if a
   founder did the manual upload, the `versionCode` is typed by hand and the
   only automated attempt from `main` failed.

"Lockstep" therefore needs three things, in this order: stop uploading PR
builds; derive one version for both platforms from one source; and add the Play
upload behind the same kind of "skip loudly until the secret exists" gate the
iOS side already uses.

## 1. Target

```
 tag v1.2.0 pushed to main   (or workflow_dispatch on main)
            │
   release.yml  ── one run, one SHA, one version ──┬── job ios:     archive → TestFlight
                                                   └── job android: bundleRelease → Play (internal track)
            │
   Release summary: "1.2.0 (build 4120): iOS uploaded ✔ · Android uploaded ✔"
   Both stores email once, for the same build. PR builds upload nowhere.
```

**Version rule, one source for both:** `mobile/VERSION` holds the marketing
version (`1.2.0`). The build number is a single monotonic integer derived at
release time and used as **both** `CFBundleVersion` and `versionCode` —
`YYYYMMDD` × 100 + run-of-day, so it is unique, increasing, human-readable and
recoverable from the date if the counter is ever lost. Play rejects any
`versionCode` it has already accepted, so monotonicity is a correctness
requirement, not tidiness.

**What stops:** `ios-build.yml` keeps building and running its simulator probes
on PRs, because that is CI. It **stops uploading** on `pull_request`. Uploads
happen only from `release.yml`.

## 2. Human gates (Track B waits on these; Track A does not)

| # | Who | What | Unblocks |
|---|---|---|---|
| G1 | Joey | **Publish the Play listing** — `HUMAN-ACTIONS.md` #26, everything is pre-written in `docs/store/play/` | Play can accept any build at all |
| G2 | Joey/Wyatt | In Play Console: **Setup → API access → link a Google Cloud project → create a service account** with the *Release manager* role, download its JSON key, add it as repo secret **`PLAY_SERVICE_ACCOUNT_JSON`** | R-03's Play upload goes live |
| G3 | Joey/Wyatt | **The first `.aab` for a brand-new app must be uploaded by hand in the Console** — Google's API refuses to create the initial release. One manual internal-testing upload, using the artifact from `android-release.yml`, with `versionCode` set to a value *below* what R-02 will generate (e.g. `1`), so automation never collides with it | R-03's first automated upload succeeds |
| G4 | Wyatt | Confirm release cadence: tag-driven (`v*`) with `workflow_dispatch` as the manual button. Default assumed below | R-03 trigger shape |
| G5 | Wyatt | Reconcile #30 — three keystore secrets already exist in the repo; mark it DONE or say what is still missing | R-06 bookkeeping |

## 3. The card deck

Conventions as in the other decks: the ask, owned files, dependencies,
acceptance (measured), sizing (S ≤ half day, M ≤ 2 days, L ≤ 5), governance,
whether a design comment precedes code. `.github/` and `tools/ci/` are
**DENIED** paths: every workflow card needs `founder-approved`, so batch them.
`tools/mobile/` is allowed except the denied signing scripts. Branch
`t_<card>/<slug>`. STATE.md entry per PR. Read first: `CLAUDE.md`,
`docs/android-release.md`, `docs/ios-ci.md`, `tools/mobile/ios-workflow.test.mjs`,
`tools/mobile/android-workflow.test.mjs` (these two **pin workflow properties by
regex** and will go red on any trigger change — update them in the same PR, never
loosen them silently).

### Track A — ships with no human gate

#### R-01 · Stop uploading PR builds to TestFlight — **S**
- **Ask:** in `ios-build.yml`, gate "Is signing configured?" and "Archive, export and upload to TestFlight" on `github.event_name != 'pull_request'` **in addition to** signing readiness. PR runs still build unsigned, still run probes, still upload their diagnostics artifact. Say in the step comment why: same-repo PRs receive secrets, so without this every PR shipped an unmerged branch to testers.
- **Owned:** `.github/workflows/ios-build.yml`, `tools/mobile/ios-workflow.test.mjs` (add the pin: the upload step's `if:` names `pull_request`; MUTATION: remove the clause → red).
- **Acceptance:** open a throwaway PR touching `app.js`; `ios-build` runs, the upload step shows **skipped**; no TestFlight email arrives. A `workflow_dispatch` on `main` still uploads.
- **Governance:** `.github/` → `founder-approved`. **This one alone ends the email flood and can land the same day.**

#### R-02 · One version for both platforms — **M** — *design comment first*
- **Ask:** `tools/mobile/version.mjs` exporting `readMarketingVersion()` (from a new tracked `mobile/VERSION`, seeded `1.0.0`) and `buildNumber({ now, runOfDay })` → integer `YYYYMMDDnn`. Both workflows read it. iOS: `MARKETING_VERSION` from the file (today hardcoded 1.0), `CURRENT_PROJECT_VERSION` from `buildNumber` (today `run_number.run_attempt`). Android: `FORAY_VERSION_NAME` and `FORAY_VERSION_CODE` env into `mobile/gradle/foray-signing.gradle`, which already reads `FORAY_VERSION_CODE` and validates it as a positive integer. **Never a manual `versionCode` input again.** Also expose `bumpMarketingVersion(part)` for the release script.
- **Owned:** `tools/mobile/version.mjs` + `.test.mjs` (floored), `mobile/VERSION`, `mobile/gradle/foray-signing.gradle` (versionName wiring only).
- **Acceptance:** tests pin monotonicity across a day boundary and two runs in one day; the same call from both workflow shells prints the identical pair; the `versionCode` fits Play's `int32` ceiling (it does: 2,099,123,199 < 2,147,483,647 — state that in the test).
- **Governance:** `tools/mobile/` allowed; `mobile/gradle/` is `mobile/` → allowed (auto-merge, post-#492).

#### R-03 · `release.yml` — one run, both stores, skip-loudly where a credential is missing — **L** — *design comment first; DECISIONS entry*
- **Ask:** new `.github/workflows/release.yml`. Triggers: `push: tags: ['v*']` and `workflow_dispatch` (inputs: `bump: patch|minor|major|none`). **Guard: refuses to run unless `github.ref` is `main` or a tag on `main`.** Job `version` computes the pair via R-02 and writes it to outputs. Jobs `ios` and `android` run **in parallel from the same SHA**, each reusing the existing build steps (factor the shared steps out of `ios-build.yml` / `android-release.yml` into composite actions under `.github/actions/` rather than copying 700 lines). `ios` uploads to TestFlight exactly as today. `android` uploads the signed `.aab` to the **internal testing** track with a pinned `r0adkll/upload-google-play@<sha>` reading `PLAY_SERVICE_ACCOUNT_JSON`; **when that secret is absent it does not fail — it prints a red-bold summary line naming G2/G3 and uploads the `.aab` as an artifact instead**, mirroring the iOS `signing-gate`'s three-outcome rule (all set → upload; none set → skip loudly; partial → fail). Final job `summary` writes one table: version, build number, iOS result, Android result, and **fails the run if the two stores disagree** (one uploaded, one didn't) once both credentials exist. `concurrency: release`, never cancel-in-progress.
- **Owned:** `.github/workflows/release.yml`, `.github/actions/ios-archive/`, `.github/actions/android-bundle/`, `tools/mobile/release-workflow.test.mjs` (pins: main-only guard, both jobs read R-02, Play step gated on the secret, summary fails on disagreement; each with a named mutation), `tools/ci/run-suites.mjs` picks the suite up automatically.
- **Dependencies:** R-01, R-02.
- **Acceptance:** `workflow_dispatch` on `main` with no Play secret → iOS uploads, Android says exactly why it did not and still leaves an `.aab` artifact, summary shows the mismatch **as a warning not a failure while the secret is documented-absent**. With the secret (Track B) → both upload, summary green, and **Wyatt receives one App Store email and one Play email for the same build number**.
- **Governance:** `.github/` → `founder-approved`. Batch this label with R-01 and R-05.

#### R-04 · Make `android-release` green from `main`, and find out why it wasn't — **S**
- **Ask:** the only `workflow_dispatch` of `android-release.yml` on `main` (2026-08-30) failed and nobody read why (the GitHub API was too slow to fetch the log while this plan was written). Read it. Fix the cause. Re-dispatch. The `.aab` it produces is also what G3's one manual upload uses.
- **Owned:** whatever the log names; likely `.github/workflows/android-release.yml` or `tools/mobile/wire-signing.mjs` (DENIED — founder label if touched).
- **Acceptance:** a green `workflow_dispatch` on `main` with an `.aab` artifact whose `FORAY_SIGNING_STATUS=keyed`.

#### R-05 · Retire the two old upload paths so there is exactly one — **S**
- **Ask:** once R-03 is green: `ios-build.yml` loses its upload step entirely (it is CI now, not release); `android-release.yml` becomes the PR-time check of the release pipeline only, or is folded into `release.yml` and deleted. Update both workflow test files; update `docs/ios-ci.md` and `docs/android-release.md` so §5's "download and submit by hand" becomes the exception path, not the process.
- **Dependencies:** R-03 merged and one green run.
- **Governance:** `.github/` → label (batch with R-03).

#### R-06 · Records and human-action bookkeeping — **S**
- **Ask:** `HUMAN-ACTIONS.md`: add G2 and G3 as new numbered items with every literal (Console menu path, role name `Release manager`, secret name `PLAY_SERVICE_ACCOUNT_JSON`, "first upload must be manual and must use versionCode 1"); reconcile #30 (three secrets exist); leave #26 OPEN but link it from G1. `docs/DECISIONS.md`: the version rule and the "no uploads from PRs" rule. New `docs/releases.md`: "how a release happens", one page, for a founder. Note the coordination item below.
- **Governance:** `HUMAN-ACTIONS.md`, `docs/` allowed; `docs/DECISIONS.md` → label (batch).

### Track B — one card per gate

| Card | Gate | Ask | Acceptance |
|---|---|---|---|
| **R-07 · Play upload goes live** — S | G1, G2, G3 | Add the secret; run `release.yml` once on `main` | Summary table green on both rows; Play Console internal track shows the build; both store emails arrive for one build number |
| **R-08 · Promote to a testing track with testers** — S | G1 | Decide internal vs closed track and add the founders' Google accounts as testers so Play actually *notifies* them (Play emails testers on the track, not the developer, for internal testing) | Wyatt's inbox gets the Play mail |

## 4. Coordination with the longlive agent

Swift2 (`longlive`) has **no mobile release workflows** — its `.github/workflows/`
is web, social and content jobs — so there is no pattern there to copy and the
two agents are solving different shapes. Two things worth sharing anyway:
R-02's version rule (one integer, `YYYYMMDDnn`, used as both build number and
versionCode) and R-03's "skip loudly on a missing credential, fail on store
disagreement" summary. If the other agent lands a reusable composite action
for the Play upload, R-03 should consume it rather than pin its own.

## 5. Sequencing

```
Day 0 (parallel):  R-01 (ends the flood)   R-02 (version)   R-04 (why did Android fail)
Then:              R-03 ← R-01, R-02
Then:              R-05 ← one green R-03 run     R-06 (any time after R-03 is designed)
Track B:           R-07 the day G1–G3 clear;  R-08 after
```

One label sitting covers R-01 + R-03 + R-05 + R-06's DECISIONS line if they are
batched; R-02 and R-04 need none.

## 6. Non-goals

- Publishing to the **production** track on either store. Internal/TestFlight
  only; promotion stays a founder click in each console.
- Changing what a "release" contains. This is plumbing for *when* and *how*
  builds reach the stores, not what is in them.
- Any App Store Connect API automation beyond the upload that already works.
