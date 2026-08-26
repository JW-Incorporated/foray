# Shipping the Android app to Google Play

The operational half of `.github/workflows/android-release.yml`. That file
carries the engineering argument; this one is what a human does.

Reads on from `docs/android-shell-build.md` (#37, the build), #245
(`android-build.yml`, the build on a runner), `docs/android-native-code.md`
(#244) and `docs/android-lock-screen.md` (#27).

---

## 0. What changed, in one paragraph

Before this, the repo could build an Android **APK** and had never run it. Play
does not accept an APK for a new listing — it requires an **Android App Bundle**
(`.aab`) — nothing was signed, and no app the repo produced had ever been
started on any device or emulator. `android-release.yml` adds all three: a
`bundleRelease` that produces a verified `.aab`, a signing config that reads the
upload key from GitHub Secrets, and an emulator job that installs the app,
starts it, and reads the running WebView back over Chrome DevTools.

---

## 1. The upload key

**It already exists. Do not generate another one.** Generating a second key does
not replace the first; it produces an app Play will refuse as "signed with the
wrong key".

| | |
|---|---|
| File | `C:\Users\wjduv\Documents\JW Labs\android-signing\foura-upload.p12` |
| Format | **PKCS12** (not JKS) |
| Alias | `foura-upload` |
| Key | RSA 4096 |
| Certificate | `CN=JW Labs LLC, O=JW Labs LLC, ST=California, C=US`, valid to 2054-01-11 |
| SHA-256 | `92:92:D8:5B:96:32:05:B4:00:45:BC:26:FC:00:9A:C4:10:B1:12:F6:85:C6:88:75:82:32:48:04:DA:1F:8C:19` |

It lives **outside every git repository**, deliberately, and nothing in this
repo will ever contain it. The fingerprint above is public — Play displays the
same value on its App Signing page — and it is pinned in
`android-release.yml` as `EXPECTED_SIGNER_SHA256`, so a bundle signed by
anything else fails the build instead of failing the upload form.

### 1.1 The one thing that is genuinely irreversible: back it up

**If this file and its password are both lost, the app can never be updated
again.** Not "with difficulty" — the Play listing becomes read-only for you, and
recovery means Google's key-reset process, which requires the app to be enrolled
in Play App Signing and takes days. There is no equivalent for the upload key on
an unenrolled app.

So, before the first upload, the file and its password must exist in **at least
two places that do not fail together**:

- a password manager entry holding **both** the password and an attachment of
  the `.p12` itself (1Password, Bitwarden and Dashlane all take file
  attachments), and
- one offline copy — an encrypted USB stick, or a second machine — that is not
  synced to the same account as the first.

A copy in the same cloud drive as the original is one account compromise, or one
accidental "delete this folder", away from being no copy at all.

### 1.2 Verifying it, without generating anything

Read-only, and safe to run any time:

```bash
keytool -list -v -storetype PKCS12 -keystore "C:\Users\wjduv\Documents\JW Labs\android-signing\foura-upload.p12"
```

The `SHA256:` line it prints must equal the fingerprint in the table above. If it
does not, stop — the file is not the upload key, and signing with it would
produce a bundle Play rejects.

---

## 2. The three GitHub Secrets

Repository → Settings → Secrets and variables → Actions.

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_B64` | base64 of `foura-upload.p12` |
| `ANDROID_KEYSTORE_PASSWORD` | the store password |
| `ANDROID_KEY_ALIAS` | `foura-upload` |

**Three, not four.** There is no `ANDROID_KEY_PASSWORD`: a PKCS12 store has one
password, and `keytool` refuses to give a PKCS12 entry a key password that
differs from the store password. A fourth secret would be a second source of
truth for a value that is not allowed to disagree, and its failure mode is a
`keystore password was incorrect` that points at the wrong one of the two.

Set them from files rather than by typing, so the values never appear in a
terminal, a shell history, or a transcript:

```bash
# from the directory holding the key, on the machine that holds it
base64 -w0 foura-upload.p12 > keystore.b64
gh secret set ANDROID_KEYSTORE_B64 --repo JW-Incorporated/foray < keystore.b64
gh secret set ANDROID_KEYSTORE_PASSWORD --repo JW-Incorporated/foray < password.txt
printf 'foura-upload' | gh secret set ANDROID_KEY_ALIAS --repo JW-Incorporated/foray
rm keystore.b64 password.txt
```

`base64 -w0` matters: a wrapped encoding still decodes, but a *truncated* one
decodes to a file Gradle rejects with a message about keystore format, twenty
minutes into a build.

**The password must be at least 12 characters**, and the build refuses to
proceed if it is shorter — not as security theatre, but because the leak scan in
§2.1 is a substring search over the Gradle log. A short password collides with
ordinary build output by coincidence, and the check would then delete a clean
log and report a leak that did not happen. A password that cannot be told apart
from log text is not doing its job anyway.

### 2.1 What the workflow does with them

- The base64 is decoded to `$RUNNER_TEMP/android-keys/upload.p12` — a **sibling**
  of the directory that gets uploaded as an artifact, never a child of it, so no
  widening of the upload path can publish the key.
- The password reaches Gradle as an **environment variable** only. It is never a
  `-P` property, because a Gradle property is in the process's argv and
  therefore in `ps` and in anything that echoes the command line. `signingReport`
  — which prints signing configuration by design — is never run.
- The build log is searched for the password before anything reads it back, and
  destroyed rather than uploaded if it is in there. GitHub masks secrets in the
  web log and **not** in downloadable artifacts.
- A step with `if: always()` shreds the key directory, on failure as well as
  success.

Every one of those is pinned by a test in
`tools/mobile/android-workflow.test.mjs`, and each of those tests was verified
by making the mutation it names and watching the suite go red.

### 2.2 Without the secrets, the build still works

On a fork, or on a PR from a contributor, the secrets are unavailable and the
job produces an **unsigned** bundle rather than failing. That is deliberate: it
is what keeps the pipeline runnable by anyone. The run's summary says in so many
words that the artefact cannot be submitted, and the workflow *verifies* the
unsigned case as well as the signed one — a bundle that carries a signature
block when no key was supplied fails the job, because something signed it and we
do not know with what.

---

## 3. Producing a bundle to submit

1. Actions → **android-release** → **Run workflow**.
2. Fill in **version_code** and **version_name**.
3. Wait ~25 minutes for `android-bundle`.
4. Open the run, scroll to **Artifacts**, download **`foray-android-release`**.
5. Unzip it. The file to submit is **`foray-release.aab`**.

The same zip carries the evidence: `aab-entries.txt` (every entry in the
bundle), `aab-capacitor.plugins.json`, `signer-cert.txt`, `jarsigner.txt`, and
the full Gradle log.

### 3.1 versionCode is the thing that will bite on the second upload

Capacitor's template hardcodes `versionCode 1` into `mobile/android/app/build.gradle`
— a **generated** file, rewritten by `cap add android` on every build, so an
edit to it does not survive. **Play permanently refuses a versionCode it has
already accepted.**

So the workflow takes it as an input and `mobile/gradle/foray-signing.gradle`
applies it. Leave it blank and you get `1`, which is correct exactly once.
Thereafter: increment it, every single time, even for a build that replaces a
rejected one.

`version_name` is the string users see (`1.0.0`). It has no uniqueness rule and
can repeat.

### 3.2 Play App Signing

When the listing is created, Play will offer **Play App Signing** — Google holds
the key that signs what users install, and the key above becomes the *upload*
key: the one you sign with, which Play verifies and then re-signs with its own.
**Take it.** It is what makes a lost upload key recoverable at all, and the
recovery path referenced in §1.1 exists only for enrolled apps.

---

## 4. The smoke test, and exactly what it settles

The `android-smoke` job builds the debug APK, boots an API-34 emulator on the
runner, installs the app, starts `MainActivity`, and then reads the live page
over the Chrome DevTools protocol (`tools/mobile/webview-probe.mjs`).

**What it proves, by execution rather than inference:**

- the app installs and `am start` reports `Status: ok`;
- the WebView is on the app's own bundled `index.html` — not `about:blank`, not
  `chrome-error://chromewebdata/`;
- `app.js` **ran**, under the real CSP: `<main id="view">` is empty in the
  committed HTML and has children in the running app;
- `window.Capacitor` exists — the injected Android bridge survived
  `script-src 'self'`, which `docs/mobile-shell.md` calls the top open risk of
  the whole native change and which `docs/android-shell-build.md` §3 had only
  ever inferred from source;
- `Capacitor.nativePromise("ForayAudio", "state", {})` answers with
  `platform: "android"`, which is set in `ForayAudioPlugin.java` and nowhere
  else — so the bridge round-trips into our own native code;
- the process is still alive afterwards, with the **same pid** (a restarted
  process is a crashed one), and the log carries no `FATAL EXCEPTION`.

**What it does not prove, and cannot:**

- **Anything about backgrounded playback.** `docs/research/mp1-background-audio.md`
  §6.4 is a section on precisely this: an emulator never enters Doze, has no
  reason to freeze a cached app, cannot show OEM battery managers, and has no
  real audio routing, telephony or Bluetooth. `HUMAN-ACTIONS.md` #11 is the
  device pass, and it stays open.
- **The lock screen.** Media3 session, transport buttons, notification
  permission: none of it is touched here.
- **The release configuration, directly.** DevTools is reachable only on a
  debuggable build, so the probe reads the debug APK. That stands in for the
  release build only while the two compile the same code — Capacitor's template
  sets `minifyEnabled false`, so today they do, and the job **asserts** that
  rather than assuming it. If a future template turns R8 on, the job goes red
  with the two ways out spelled in the step.

### 4.1 It is deliberately not a required check, and it is not on every PR

A cold emulator boot is the only genuinely flaky thing in this repo. MP1 §6.2
measured a cold API-36 image failing to reach a usable framework in ~35 minutes,
across three attempts. On a GitHub runner with KVM enabled and an API-34 image
it is much better than that, and it is still the step most likely to fail for
reasons that have nothing to do with the app.

So:

- **not required** — `protect-main` requires `backend`, `data-and-site` and
  `path-policy`, and neither of these jobs is named like any of them;
- **not on every PR** — the `pull_request` trigger fires only when the release
  pipeline itself changes (`android-release.yml`, `mobile/gradle/**`,
  `wire-signing.mjs`, `webview-probe.mjs`). Ordinary `mobile/**` changes are
  covered by `android-build.yml`, which stays fast, credential-free and
  emulator-free;
- **not able to block a bundle** — `android-smoke` does not `needs:`
  `android-bundle` in either direction, so a flaked AVD never stands between the
  founder and a submittable `.aab`. That independence is asserted by a test.

A flaky required check is worse than no check. This one is advisory: its verdict
is read by a human before a submission.

---

## 5. Where the signing config lives, and why it is not in the generated project

`mobile/android/` is **not committed** (`mobile/.gitignore`). `cap add android`
regenerates `app/build.gradle` from Capacitor's template on every machine and
every CI run, and that template has no `signingConfigs` block. Editing the
generated file is therefore not a fix — the next generation throws the edit away
without a word.

So the decision lives in the tracked **`mobile/gradle/foray-signing.gradle`**, and
`tools/mobile/wire-signing.mjs` copies it into the generated project and appends
one `apply from:` line to `app/build.gradle` after generation. The workflow then
runs the script a second time with `--check`, which re-reads both files off disk
and fails if either half is missing — because a build that is silently not
applying the signing config produces an unsigned bundle and prints
`BUILD SUCCESSFUL`.

It is filed under `mobile/` rather than `tools/` on purpose. `tools/` is on
`ALLOWED_PREFIXES` in `tools/ci/path-policy.mjs`, so a PR touching only `tools/`
auto-merges the moment checks go green; `mobile/` is unlisted and always waits
for a human. A file that decides which key signs the app should not be one green
tick from landing unread.
