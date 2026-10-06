# Downloads device check — the script (PQ-24, #29)

The founder's phone check of offline downloads (issue #29;
`docs/roadmap/player-features.md` PQ-24). The code is merged: the iOS plugin
(PQ-20, #1020), the plugin declaration and Android store (PQ-21/22, #1052), the
Download UI (PQ-18, #1068) and playing from the downloaded file (PQ-19, #1073).
Unit tests prove the rules. No one has yet checked them on a real phone. This
script does that, one #29 acceptance ask at a time.

HUMAN-ACTIONS #149 asks for this check and links here. It names **the first
TestFlight build containing #1073 (`3a9dfefa`)**. Any later TestFlight build
from `main` contains it too. The build number is the one in the Copy header
(see "Rules for every step"). Write it down; this file does not guess it.

## Before it can be run

These are preconditions, not steps for the founder.

1. **A build with #1073.** A TestFlight build from `main` at or after
   `3a9dfefa` (PQ-19, 2026-10-05). The Download control (PQ-18) and the
   `ForayDownloads` plugin with its AppDelegate background-session hook (#1052)
   are older, so they are in it too.
2. **iPhone only.** Android is deferred. HUMAN-ACTIONS #127 (the Android device
   pass) is not issued: the founder ruled on 2026-09-29 (D-A3,
   `docs/plans/android-assessment.md`) that no Android device pass happens
   until the Android native engine is fully operational. The Android download
   store (#1052) is checked then, with this script's steps adapted.
3. **A `dai_suspected` show with long episodes.** Pick a show marked
   `"dai": true` in `data/catalog-client.json` whose episodes run past 1:07:30
   (step 3 bookmarks that point). On 2026-10-06 that includes *Fall of
   Civilizations Podcast*, *Conan O'Brien Needs a Friend* and *SmartLess*.
   Use one episode of it for steps 1 to 4 ("the episode").
4. **For step 4: a Mac with Xcode and a development build.** Xcode's
   Devices window can open an app's container (Download Container / Replace
   Container) only for a development-signed build installed from Xcode, never
   for a TestFlight build. Without one, step 4 is recorded as "not run (no
   development build)" and the missing-file path stays proven by unit tests
   only.
5. **For step 6: a proxy that can read HTTPS.** Proxyman or Charles on a Mac,
   with the phone's Wi-Fi proxy pointed at it and the proxy's root certificate
   installed and trusted on the phone (Settings → General → About →
   Certificate Trust Settings). Proxyman's iPhone app also works without a Mac.
   SSL proxying must be on for the podcast's hosts, or only the host name is
   shown.

## What this script does not check, because it is not built

Each of these is a gap in #29, written down so a pass here is not read as more
than it is.

- **Automatic download of a session's picks is not built.** Downloads start
  only when the listener taps Download. Whether picks should download by
  themselves is a policy call #29 keeps for Joey and Wyatt.
- **With no network, "drop the item with an earcon and advance" is not
  built.** When a downloaded file is missing, the player streams instead. With
  no network that stream fails and the bar shows its usual load error. Step 4
  therefore runs online; its offline variant only records what happens.
- **The download policy is a proposal, not a ruling.** Manual downloads, Wi-Fi
  only ("Download over cellular" off), and a 2 GB cap are the default the
  code implements from `docs/roadmap/README.md` question 17
  (`docs/roadmap/player-features.md` §1 question 2). No founder has ruled on
  it. This script checks the default works; it does not settle it.
- **The iOS plugin writes no diagnostics row.** Developer → Playback
  diagnostics says nothing about downloads, so step 6 needs a proxy.

## Rules for every step

- **Record the build.** Before step 1: menu → **Developer** → **Playback
  diagnostics** → **Copy**. The header's `build=<number>` is the build under
  test. TestFlight → 4a → turn **Automatic Updates off** so it does not change
  mid-check.
- **Write pass, fail or not run for each step**, with what you saw when it is
  not a pass. Put them in one comment on issue #29, each headed with the step
  number. For a fail, add a Developer → Playback diagnostics → Copy taken right
  after it.
- **Downloads exist only in the app.** The web player has no Download control
  (CORS rules downloads out on the web).

## Step 0 — at home, 2 minutes

1. Settings drawer → **Download over cellular**: it is **off** (the default).
   Leave it off.
2. Library → **Downloads**: note the usage line. With nothing downloaded it
   reads "0 episodes downloaded".

## The steps

1. **Background download (#29: "progress visible; survives backgrounding").**
   On Wi-Fi, open the episode's page and tap **Download**. When it reads
   **Downloading NN%**, go to the Home Screen and lock the phone for at least
   2 minutes, or until a long episode has had time to finish. Unlock and reopen
   4a.
   *Expected:* the control went "Download queued" → "Downloading NN%" while
   the app was open; after reopening it reads **Downloaded ✓**, and Library →
   Downloads lists the episode. If it still reads "Downloading NN%" with a
   higher number, wait in the app and record how long it took to finish.

2. **Airplane mode (#29: "downloaded episodes play, seek and scrub").**
   Turn **Airplane Mode on**, and turn **Wi-Fi off** if it stays on. Play the
   episode. Drag the scrubber to a point near the end, then back to the
   middle. Press **↺15** and **30↻** a few times. Lock the phone: the lock
   screen shows the episode, the show and its artwork, and its skip buttons
   read 15 and 30. Pause and play from the lock screen.
   *Expected:* it plays with no network at all; every scrub and skip lands and
   plays on within a second; the lock-screen controls work. Leave Airplane
   Mode on for step 3's first half.

3. **Bookmarks seek exactly on a downloaded copy (#29: "including
   `dai_suspected` shows").** Still offline, scrub the episode to about
   **1:07:30** and press **Bookmark** in the Now Playing sheet ("Bookmarked.").
   Open the episode's page.
   *Expected:* under **Bookmarks** the row reads **"At 1:07:3x"** (the exact
   second you marked), not "Around minute 68". Tap it: playback jumps to that
   second. Write down the episode's total length the player shows.
   Then, **on another day** (so the publisher can serve a different ad load):
   turn Airplane Mode off, tap **Downloaded ✓** on the episode's page to remove
   the download, play the episode streamed for 10 seconds, and open its page
   again.
   *Expected:* if the streamed copy's length differs from the downloaded one
   by more than 30 seconds, the row reads **"Around minute 68"** (the
   approximate wording; `player/seek-policy.js` `DRIFT_TOLERANCE_SEC = 30`).
   If the two lengths are within 30 seconds, it still reads "At 1:07:3x", and
   that is also correct. Write down both lengths either way.

4. **Missing-file degrade (#29: "delete a file behind the player, hit play, it
   degrades").** Needs precondition 4. Download the episode again and wait for
   **Downloaded ✓**. In Xcode → Window → **Devices and Simulators** → the
   phone → 4a → **Download Container**. In the downloaded package (Show Package
   Contents), open `AppData/Library/Application Support/foray-downloads/`.
   `index.json` there names each episode's file; each file is the SHA-256 of
   the episode id plus `.bin` (`DownloadPolicy.fileName`). Delete that `.bin`
   file only, leave `index.json`, then **Replace Container** with the edited
   package. Reopen 4a online and press play on the episode.
   *Expected:* the episode **streams**, from where it was; the
   episode page's control is back to **Download** (the row is now `missing`);
   Library → Downloads no longer lists it, and the usage line no longer counts
   it. The app also says **"Downloaded copy missing — streaming instead."**
   (exact string, `app.js` `surface.onMissing`). That message is spoken to the
   screen reader, not shown on screen: hear it with VoiceOver on, or count the
   visible signs above as the pass. It is said once; the player never loops.
   *Offline variant (record only, no pass or fail):* repeat with Airplane
   Mode on before pressing play. The stream cannot start, and the bar shows
   its usual load error. Write down what the bar says and whether anything
   advanced. The earcon-and-advance behaviour #29 describes is not built.

5. **Cellular is opt-in (#29: "cellular download is opt-in and
   respected").** Settings drawer → **Download over cellular** is off. Turn
   **Wi-Fi off** with cellular data on (LTE or 5G showing), open a different
   episode's page, and tap **Download**.
   *Expected:* the app says "Downloading on Wi-Fi." (spoken, like step 4's
   message), and the control reads **Download queued** and stays that way for
   at least 2 minutes. Then turn Wi-Fi back on: within a minute or two it
   moves to **Downloading NN%** and finishes. Remove that download afterwards.

6. **The download uses the original URL (#29: "checked by inspecting the real
   request").** Needs precondition 5. With the proxy recording, tap
   **Download** on an episode not yet downloaded.
   *Expected, in the proxy:* the first request for the audio is a `GET` of the
   episode's **original enclosure URL**, the `url` in the `<enclosure>` of the
   show's RSS feed, measurement prefixes (for example Podtrac or Chartable)
   included. It carries `Range: bytes=0-0` (the plugin's one-byte probe) and a
   `User-Agent` starting `4a/`. Any redirects follow from that host. A second
   `GET` with no `Range` header, the transfer itself, fetches the URL the
   probe was redirected to, with the same `User-Agent`. No audio request goes
   to a 4a address (`foray-web-seven.vercel.app`, `*.jwlabs.ai`, Supabase).
   Write down the first URL and the feed's enclosure URL side by side.

7. **The Library's usage line matches the phone (#29: "Settings usage matches
   reality").** With two or three episodes downloaded, read Library →
   Downloads: "X.X GB of 2 GB used · N episodes". Then read the real size, in
   one of two ways:
   - **With Xcode** (precondition 4): Download Container, and add up the
     sizes of the `.bin` files in `foray-downloads/`.
   - **Without Xcode:** Settings → General → iPhone Storage → 4a →
     **Documents & Data**, once before downloading anything and once after;
     the increase is the downloads plus a little else the app stored.
   The app counts in units of 1024³ bytes; Finder and iPhone Storage count in
   units of 1000³ bytes, so 1.0 GB in the app is 1.07 GB in Finder.
   *Expected:* the app's figure × 1.07 is within 0.1 GB of the real size.
   The 2 GB cap's eviction (the least recently played download goes first,
   an episode with an unfinished position never does) is proven by unit tests
   in `player/download-store.test.js`. Checking it here would mean
   downloading more than 2 GB; do it only if convenient, and record which
   episode disappeared.

## How it is judged

Steps 1, 2, 3, 5, 6 and 7 must pass on the build named in the record. Step 4
passes, or is "not run" only for want of a development build. Its offline
variant and the second half of step 3 are recorded, not judged on one
wording. When every step is in the #29 comment, the device-check asks in #29
can be ticked. #29 itself stays open while automatic download of picks and
the offline earcon-and-advance path are unbuilt.
