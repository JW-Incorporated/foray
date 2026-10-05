# ADR 0009: Release signing secrets — the one place CI holds keys

## Status

**Accepted, as a record of what already runs.** Written 2026-10-05 for issue
#798 ("Owed records"). It decides nothing new. CI signing was built across
ten PRs between 2026-08-17 and 2026-09-25 (§7). Every one of them that changed a
workflow was merged by a founder, and all but one (#494, which Joey merged
without the label) carried the `founder-approved` label. No ADR was written for
it. Meanwhile `CLAUDE.md` still called the repo's automation
"deliberately keyless", which stopped being true of the release path on
2026-08-26, when the first signing secret was set. This file is that missing
record. `CLAUDE.md` now carves out the exception and points here.

**One amendment is pending.** It moves every secret below into a protected
`release` environment: `HUMAN-ACTIONS.md` #115, founder ruling 2026-09-25 Q2
(`docs/DECISIONS.md`), code side on PR #822 (held). When it lands, update §3
and the "where it lives" column in §2. Nothing else here changes.

## Context

The repo's automation was keyless by design. The 2026-07-24 org migration
(`docs/DECISIONS.md`) made the nightly refresh "a keyless GitHub Action" that
publishes "a credential-free digest". Podcast Index was dropped as a required
dependency rather than hold its credentials (DECISIONS 2026-07-11).
The cloud agents hold no credential. The Spark calls Claude through "the
keyless relay", and the founder alone places any secret on that box (DECISIONS
2026-09-28, D3 and D8). `CLAUDE.md`'s decision-authority item 1
says this repo's cloud automation stays keyless.

The app stores do not accept that. Apple installs nothing that is not signed by
a distribution certificate. Google Play accepts only a bundle signed with the
app's upload key. Each store's upload API also needs its own credential. Until
the first signing secret was set on 2026-08-26, every build CI made was unsigned
and could not be installed or submitted (`docs/ios-ci.md` "The build is unsigned, and that is the point";
`docs/android-release.md` §0).

## Decision

1. **Signing and store upload happen in GitHub Actions, and only there.**
   `release.yml` is the only workflow that uploads to either store (DECISIONS
   2026-09-06, R-03; R-05 #533 removed the second path). `android-release.yml`
   is the PR-time check of the Android release pipeline. It can sign a bundle,
   but it never uploads one.
2. **Everything else stays keyless.** The Claude cloud routines, the nightly
   pipeline, the Spark and every other workflow read none of the secrets below.
   No agent session holds, prints or handles their values. A founder sets them
   (only a repository admin can).
3. **A missing secret is a supported state, never a crash.** §4 lists the
   outcome for each platform.
4. **A key never lands anywhere a reader can download it.** §5 covers this.
   The repo is public, and GitHub masks secrets in the web log but never in
   artifacts.

## 1. Why CI, and not a founder's laptop

The other option was to sign by hand on a founder's machine and upload through
Xcode or the Play Console. No record weighs that option explicitly. It was
passed over in practice when #220 and #346 merged with founder approval. The
reasoning that does survive is about where the keys may live, not whether CI
holds them:

- HA #19, as #220 wrote it: "an unsigned build that always runs is worth more
  than a signing job that never does". So the build stays unsigned and always
  runs, and only the upload waits on the secrets.
- `android-release.yml`'s header (#346): `android-build.yml` "READS NO SECRET,
  so it runs on any fork". The credentials went into a separate, rarely
  triggered file so that this stays true.

Exposure is limited by keeping the key-holding files few and stating who can
reach them (§3), not by keeping keys out of CI. The manual path still exists as
the exception (`docs/android-release.md` §3).

## 2. The inventory

Eleven secrets, all read by `release.yml` (lines ~341–347 for iOS, ~384–387 for
Android, passed into `.github/actions/ios-archive` and
`.github/actions/android-bundle`). `android-release.yml` reads the three
keystore secrets itself (lines ~287, 336–337). The "set" dates come from
`gh secret list` on 2026-10-05.

| Secret | What it is | Read by | Set | The original lives |
|---|---|---|---|---|
| `IOS_DIST_CERT_P12_BASE64` | Apple Distribution certificate + private key, `.p12`, base64 | release.yml → ios-archive | 2026-09-03 | Exported from the Keychain of the Mac that made the CSR (`HUMAN-ACTIONS.md` #19 step 3) |
| `IOS_DIST_CERT_PASSWORD` | The `.p12` export password | release.yml → ios-archive | 2026-09-03 | Wherever #19's operator kept it; not recorded in the repo |
| `IOS_PROVISIONING_PROFILE_BASE64` | App Store distribution profile for `ai.jwlabs.foura`, base64 | release.yml → ios-archive | 2026-09-03 | Re-downloadable from the Apple developer portal at any time |
| `APPLE_TEAM_ID` | The 10-character team id. An identifier, not a secret | release.yml → ios-archive | 2026-09-03 | Apple developer portal → Membership |
| `APP_STORE_CONNECT_KEY_ID` | App Store Connect API key id | release.yml → ios-archive (`altool --upload-app`) | 2026-09-03 | App Store Connect → Users and Access → Integrations |
| `APP_STORE_CONNECT_ISSUER_ID` | The team's API issuer UUID | release.yml → ios-archive | 2026-09-03 | Same page; it does not change when a key is replaced |
| `APP_STORE_CONNECT_PRIVATE_KEY_BASE64` | The `AuthKey_<id>.p8`, base64. Role **App Manager** (#19 step 2) | release.yml → ios-archive | 2026-09-03 | **Downloadable exactly once.** Only the copy #19's operator saved, plus this secret |
| `ANDROID_KEYSTORE_B64` | The upload key `foura-upload.p12` (PKCS12, RSA 4096, valid to 2054-01-11), base64 | release.yml → android-bundle; android-release.yml | 2026-08-26 | Off-repo on Wyatt's machine, path in `docs/android-release.md` §1. Its SHA-256 is pinned in `android-release.yml` as `EXPECTED_SIGNER_SHA256` |
| `ANDROID_KEYSTORE_PASSWORD` | The store password. PKCS12 has one password, so there is no `ANDROID_KEY_PASSWORD` (`docs/android-release.md` §2) | both | 2026-08-26 | With the key (HA #30: password manager + offline copy) |
| `ANDROID_KEY_ALIAS` | `foura-upload`. An identifier, not a secret | both | 2026-08-26 | `docs/android-release.md` §1 |
| `PLAY_SERVICE_ACCOUNT_JSON` | Google Cloud service-account JSON key. Invited to the Play account with *Release apps to testing tracks* on 4a, no production or financial rights (HA #41) | release.yml → android-bundle (`r0adkll/upload-google-play`, pinned by SHA) | 2026-09-06 | The JSON downloads once from Google Cloud → IAM → Service Accounts → Keys. A new key can be minted at any time |

All other `secrets.` references in `.github/` are the per-run `GITHUB_TOKEN`.
No workflow besides these two reads a stored secret.

## 3. Where they live, and who can reach them

**Today, all eleven are repository-level Actions secrets.** No `release`
environment exists yet. The repo's environments are `github-pages`, `Preview`
and `Production`, as `gh api repos/JW-Incorporated/foray/environments` showed
on 2026-10-05. So any workflow on any branch pushed to this repository can read
them, and so can a same-repo `pull_request` run. `android-release.yml`'s header
accepts the PR-run case in so many words ("WHO CAN REACH THE KEY"). The
round-3 audit (`ci-release-3`) called the branch-push case "a real exposure,
not a theoretical one" because the repo is public. The fix is HA #115 plus
PR #822. Until it lands, the trust boundary is the repo's write list.

**Who can rotate.** Rotation has two halves, and different people hold each.

- *Replacing the GitHub secret* needs repository admin, or ownership of the
  `JW-Incorporated` org. On 2026-10-05 the repository admins are the two
  founder accounts, `wjduvall-cmd` (Wyatt) and `sffan15-sys` (Joey). Agents
  never do this (`CLAUDE.md` decision-authority item 1). Use
  `gh secret set NAME --repo JW-Incorporated/foray < file`, from a file, so the
  value never enters a shell history (`docs/android-release.md` §2).
- *Minting a new credential at the source*:
  - **Android upload key:** Wyatt holds it (HA #30, "Owner: Wyatt (he holds the
    key)").
  - **Play service account:** whoever owns the Google Cloud project that holds
    `play-uploader`, plus a Play Console Owner/Admin for the invite. HA #41
    names Joey as the Play developer account owner.
  - **Apple certificate, profile and API key:** an Account Holder or Admin on
    JW Labs LLC's Apple Developer membership. **The repo does not record which
    founder holds that role.** Whoever next rotates an Apple credential should
    add it here.

## 4. When a secret is absent

| Platform | Outcome | Where it is enforced |
|---|---|---|
| Android, no `ANDROID_KEYSTORE_B64` | **An unsigned bundle, and a green job.** This is the supported state on every fork and every fork PR. `android-release.yml` exports an empty key path. Its signature step then **verifies** that the bundle has zero signature blocks: a signature with no key supplied fails the job: "something signed this and we do not know with what". The run summary says "**This bundle cannot be submitted.**" | `android-release.yml` "Materialise the upload key" (~274–318), signature step (~490–558), summary (~590–615); the same branch in `.github/actions/android-bundle` |
| Android, key present, no `PLAY_SERVICE_ACCOUNT_JSON` | The bundle is signed. The Play upload is skipped loudly, the `.aab` is uploaded as a run artifact, and the release is not failed | `tools/mobile/release-ci.mjs` `playReadiness()`; DECISIONS 2026-09-06 (R-03) |
| iOS | Three outcomes over the seven Apple secrets. All present → archive, export, upload. None → skip the upload loudly, not a failure. **Some → fail**, because "a skipped upload on a green run is invisible" | `tools/mobile/ios-ci.mjs` `signingReadiness()`; `docs/ios-ci.md` |
| Both | `release.yml`'s summary fails the run when both stores have `ready` credentials and only one uploaded, or when either is `partial` | DECISIONS 2026-09-06 (R-03) |

## 5. How a key is handled inside a run

These are pinned by mutation-tested assertions in
`tools/mobile/android-workflow.test.mjs`,
`tools/mobile/release-workflow.test.mjs`, `tools/mobile/ios-workflow.test.mjs`
and `tools/ci/path-policy.test.mjs`.

- Decoded keys go under `$RUNNER_TEMP`, **beside** the uploaded artifact
  directory and never inside it. A shred step runs with `if: always()` before
  the artifact upload (`docs/android-release.md` §2.1).
- Passwords reach Gradle as environment variables only, never as a `-P`
  property, which would put them in argv. `signingReport` is never run. The
  Gradle log is searched for the password and destroyed if the password is in
  it. The password must be at least 12 characters so that search cannot
  false-positive.
- iOS archives in three steps, and none of the secret-holding steps writes into
  the artifact directory. The `altool` log is copied out with long base64-shaped
  runs redacted (`ios-archive/action.yml`, #821).
- Code that executes inside a secret-holding step counts as a credential
  surface. Gradle scripts, SwiftPM manifests and plugin build manifests under
  `mobile/` are on `DENIED_PATTERNS` in `tools/ci/path-policy.mjs` (#821,
  `ci-release-5`), so an agent PR cannot change what runs next to the keystore
  without a founder label.
- Store builds never come from a pull request (DECISIONS 2026-09-06, R-01,
  #494).

## 6. Recovery when a credential is lost or leaked

The rule for a leak is the same everywhere: **revoke at the source first, then
replace the secret.** Deleting a GitHub secret does not un-leak a key.

- **App Store Connect API key (`.p8`).** If it is lost, revoke it in App Store
  Connect → Users and Access → Integrations, create a new key with the App
  Manager role, and replace `APP_STORE_CONNECT_KEY_ID` and
  `APP_STORE_CONNECT_PRIVATE_KEY_BASE64`. The issuer id stays. Nothing already
  uploaded is affected. The only cost is that uploads fail until the secrets
  are replaced. The new `.p8` also downloads only once, so save it in two
  places before closing the page.
- **Apple Distribution certificate (`.p12` or its password).** Revoke it and
  issue a new one (HA #19 step 3). Then regenerate the App Store provisioning
  profile, which embeds the certificate, and replace all three of
  `IOS_DIST_CERT_P12_BASE64`, `IOS_DIST_CERT_PASSWORD` and
  `IOS_PROVISIONING_PROFILE_BASE64` together. The signing gate fails on a
  half-replaced set by design. Distribution certificates are valid for one
  year. These were set on 2026-09-03, so the first forced rotation comes
  around then in 2027. Read the real expiry date in the developer portal
  rather than trusting this estimate.
- **Android upload key.** This is the one that can be irreversible.
  - *Lost, with a backup:* re-set the three secrets from the backup
    (`docs/android-release.md` §2).
  - *Lost with no backup* (file and password both gone): updates need Google's
    upload-key reset. The Play account owner requests it in the Play Console
    with a newly generated key's certificate. It "takes days", and it exists
    only for apps enrolled in Play App Signing (`docs/android-release.md` §1.1,
    §3.2). After the reset, `EXPECTED_SIGNER_SHA256` in `android-release.yml`
    must change to the new fingerprint, and that is a governed `.github/` edit.
    The comment beside it says "DO NOT EDIT IT TO MATCH" until the reason is
    known.
  - *Leaked:* the same reset, done urgently.

  **Two facts this depends on are not recorded anywhere in the repo.** The
  repo does not say whether 4a is enrolled in Play App Signing. Google requires
  it for new apps published as bundles, and android-release.md §3.2 says to
  accept it, but no record confirms it was done. The repo also does not say
  whether HA #30's two off-repo backups exist. The 2026-09-06 reconciliation
  says that only Wyatt can attest to this. Both should be confirmed before
  they are needed.
- **Play service account JSON.** Delete the key in Google Cloud → IAM →
  Service Accounts → Keys, create a new one, and replace
  `PLAY_SERVICE_ACCOUNT_JSON`. Until then `release.yml` takes the "Play
  absent" branch in §4: iOS still ships and the `.aab` is kept as an artifact.
  If the account was removed from the Play Console, re-invite it with HA #41's
  three permissions.

## 7. Provenance

| When | What | Record |
|---|---|---|
| 2026-08-17 | iOS: the gated TestFlight upload and the seven Apple secrets were designed, and HA #19 was filed | PR #220 (`founder-approved`, merged by Wyatt) |
| 2026-08-26 | The three Android keystore secrets were set | `gh secret list`; HA #30 reconciliation, 2026-09-06 |
| 2026-08-30 | `android-release.yml`: a signed `.aab` from secrets, the pinned upload-key fingerprint, unsigned-when-absent | PR #346 (`founder-approved`, merged by Wyatt) |
| 2026-09-03 | The seven Apple secrets were set. The first signed iOS run, then manual signing so the distribution profile is used, and TestFlight unblocked | `gh secret list`; PRs #457 and #460 (`founder-approved`, merged by Wyatt) |
| 2026-09-05 | No store upload from a PR build (R-01) | PR #494 (merged by Joey); DECISIONS 2026-09-06 |
| 2026-09-05 | `release.yml`: one run, both stores, skip loudly when a credential is missing (R-03) | PR #501 (`founder-approved`, merged by Joey); DECISIONS 2026-09-06 |
| 2026-09-06 | `PLAY_SERVICE_ACCOUNT_JSON` set; HA #41 and #42 done; the first automated Play upload, run 34045806385 | PRs #516 and #518; `docs/releases.md` |
| 2026-09-09 | `release.yml` became the only upload path (R-05) | PR #533 (`founder-approved`, merged by Wyatt) |
| 2026-09-25 | Round-3 security lane: secret-holding steps split apart, credential-adjacent build files made DENIED | PR #821 (`founder-approved`, merged by Wyatt) |
| 2026-09-25 | Founder ruling Q2: the signing secrets go behind a protected `release` environment, as a founder follow-up | DECISIONS 2026-09-25; HA #115 (open); PR #822 (held) |

## Consequences

- `CLAUDE.md`'s "deliberately keyless" now has a stated scope: cloud
  automation stays keyless, and release signing in CI is this ADR's exception.
  A new credential in CI outside §2 is a new decision. It needs a founder and
  an amendment to this file, not a silent addition.
- A known gap, recorded and not fixed here (#822 holds `release.yml`, and this
  record changes no workflow): only `android-release.yml` checks the signer
  against `EXPECTED_SIGNER_SHA256`. The composite that `release.yml` uses
  (`.github/actions/android-bundle`) runs `jarsigner -verify` but does not pin
  the fingerprint. On the release path, a bundle signed with the wrong key is
  therefore caught by Play at upload, not by CI.
