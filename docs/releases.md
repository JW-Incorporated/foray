# How a release happens

*One page, for a founder. Full design/rationale: `docs/release-lockstep-plan.md`.
Running record of decisions: `docs/DECISIONS.md`.*

## The short version

Both stores are updated by **one workflow, one run, one version number.**
You either push a tag or click a button; you do not touch either app store
console for a routine release.

```
 you push a tag (v1.2.0) to main, or click "Run workflow" on main
            │
   release.yml runs once, from one commit ─┬─ iOS job:     archive → upload to TestFlight
                                            └─ Android job: bundle → upload to Play (internal track)
            │
   One summary: "1.2.0 (build 2609061+n): iOS uploaded ✔ · Android uploaded ✔"
   You get exactly one App Store email and one Play email, for the same build.
```

## How to trigger a release

- **Tag-driven (normal path):** push a tag matching `v*` (e.g. `v1.3.0`) to
  `main`. The workflow reads the version from that.
- **Manual button:** GitHub → **Actions → release → Run workflow**, on `main`,
  with a `bump` input (`patch` / `minor` / `major` / `none`).
- The workflow refuses to run from anything other than `main` or a tag on
  `main` — there is no way to accidentally release a feature branch.

## Where the version number comes from

- The marketing version you see in the stores (`1.2.0`) lives in one file:
  `mobile/VERSION`.
- The build number both stores use internally (iOS's `CFBundleVersion`,
  Android's `versionCode`) is computed automatically as one integer,
  `YYYYMMDD` × 100 + a same-day counter — always increasing, always unique,
  and readable back to a date if anything is ever lost. You never type it.

## What you will never see anymore

- **A store build from a pull request.** Every PR used to trigger a TestFlight
  upload from an unmerged branch — that was the source of the "App Store
  keeps emailing me, Play never does" complaint. PRs still build and test;
  they never upload. Only `release.yml`, run from `main`, uploads anywhere.

## The one-time setup this depends on

Three human actions have to happen before Android uploads work at all — see
`HUMAN-ACTIONS.md` for the exact steps and literals:

1. **#26 — publish the Play Store listing.** Play won't accept any build,
   automated or manual, until the listing exists.
2. **#41 — create the Play API service account** (Console → Setup → API
   access → link a Cloud project → create a service account with the
   **Release manager** role → download its JSON key → add it as the
   `PLAY_SERVICE_ACCOUNT_JSON` repo secret). This is what lets `release.yml`
   talk to Play at all.
3. **#42 — the first Android upload must be done by hand, at `versionCode 1`.**
   Google's API can update an existing release but cannot create an app's
   very first one — that's a Console-only click, once, ever. After that,
   every later `versionCode` the automation produces sits comfortably above
   `1`, so there's no collision.

Until all three are done, `release.yml` still uploads iOS normally and prints
a clear message explaining why the Android half was skipped — it does not
fail the run, and it does not silently do nothing either.

## If something looks wrong

- The release run's **Summary** tab always shows one table: version, build
  number, and iOS/Android result. If the two stores disagree — one uploaded
  and the other didn't, and both should have credentials by then — the run
  fails loudly instead of finishing quietly with only half the job done.
- The Android keystore (the signing key `.p12` file) is backed up per
  `HUMAN-ACTIONS.md` #30. If that key is ever lost with no backup, this app
  can never be updated on Play again — there's no "reset the key" for an app
  not enrolled in Play App Signing.
