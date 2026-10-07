# Share device check — the script (PH2-06, #71)

The founder's phone check of sharing (issue #71;
`docs/roadmap/listener-forays-sharing.md` PH2-06). The code is merged: share
links on shows, episodes, playlists, Suggested cards and published Forays
(SH-1, #1084), the native share plugin `@capacitor/share` (#1077), Share on
the Now Playing sheet (SH-2, #1143), and links that open on a fresh device
(#1141, #1146). Unit tests in `test/share-links.test.js` prove the rules. No
one has yet shared from a real phone. #71's status comment of 2026-10-07
(item 4, "No device record") names that gap. This script fills it, one share
surface at a time.

HUMAN-ACTIONS #149 links here as one extra step ("Also, while the phone is
out"). There is no separate item for it.

## What the app does when you tap Share

`app.js` `shareTo` tries four ways to deliver a link, in this order. Each row
of the record names the one that ran:

| delivery | what you see | when it runs |
|---|---|---|
| **sheet** | the phone's own share sheet (Messages, Notes, Copy …) | in the app: the Capacitor Share plugin; in a browser: `navigator.share` (Web Share) |
| **clipboard** | **"Link copied"** beside the button for about 4 seconds; on the Now Playing sheet the button itself reads **"Link copied ✓"** for 1.5 seconds (#1143) | no share sheet exists (most desktop browsers) |
| **shown link** | **"Copy this link"** beside the button, with the link in a selected read-only field | no sheet, and the clipboard was refused |
| **cancelled** | nothing more: no second sheet, no note | you closed the sheet without choosing. A cancel ends it; it is not a failure to fall back from |

In the app, the plugin and Web Share open the same iOS sheet, so the record
says "sheet" without telling them apart.

## Before it can be run

These are preconditions, not steps for the founder.

1. **A build with #1146.** A TestFlight build from `main` at or after
   `292af726` (#1146, 2026-10-06). It contains #1084, #1077, #1143 and #1141.
   The build HUMAN-ACTIONS #149 starts from (#1073, `3a9dfefa`) is older and
   has no Share on the Now Playing sheet, so run this after #149's own steps
   and install the latest TestFlight build first if needed.
2. **The website serves the same code.** The links open on
   `https://foray-web-seven.vercel.app/` (`PUBLIC_WEB_ORIGIN`). Its production
   deploy must be at or after `292af726`, or the cold opens of step 9 test
   older code. The session that asks for this run checks that, not the
   founder.
3. **A fresh browser for the cold opens.** A Safari **Private** tab on the
   same iPhone has no 4a state, so it counts as a fresh device. A second phone
   or a computer's private window works too.
4. **A desktop browser with no share sheet, for step 8.** Firefox on the PC.
   Chrome, Edge and Safari on a computer may open a share sheet instead.
5. **Android.** The Android app is not checked here. The founder ruled on
   2026-09-29 (D-A3, `docs/plans/android-assessment.md`) that no Android device
   pass happens until the Android native engine is fully operational (#127,
   not issued). When #127 is issued, the session that issues it adds this
   script's app steps (1 to 6) to it. Step 10, Android **Chrome** (the website,
   #71 acceptance line 1), runs only if an Android phone of your own is at
   hand. Never ask Joey for it.

## What this script does not check

Each of these is a gap or an open question in #71, written down so a pass here
is not read as more than it is.

- **Links open the website, not the app.** Tapping a shared link in Messages
  or Notes opens Safari (or Chrome) on `foray-web-seven.vercel.app`, even with
  4a installed. That is expected until HUMAN-ACTIONS #145 (iOS) and #146
  (Android) are done. Record it as "web". It is not a failure.
- **No `shared` event is logged** (#71 status item 1; #1084 logs nothing on
  purpose). There is nothing to see.
- **The share text is the title only** (and the show, for an episode). It
  carries no why-line (#71 status item 3, a founder decision). Record what
  landed; this script does not judge the wording.
- **The "shown link" delivery cannot be forced on a phone.** It runs only when
  the clipboard is refused. `test/share-links.test.js` covers it. Record it if
  you see it.
- **pod.link** is used only for a `pi:` show with no shard key. No step aims
  at it.

## Rules for every step

- **Record the build.** Before step 1, in the app: menu → **Developer** →
  **Playback diagnostics** → **Copy**. The header's `build=<number>` is the
  build under test. TestFlight → 4a → turn **Automatic Updates off**.
- **Collect every link in one place.** In the share sheet choose **Notes** →
  a new note called "share check", and **Add to** that note each time after
  the first. Messages to yourself works too.
- **Fill one row per share** in a copy of the table in
  `docs/field-records/TEMPLATE-share-shells.md`: surface, platform, delivery
  (from the table above), the URL exactly as it landed in Notes or Messages,
  and the cold-open result (step 9). Write any note shown beside the button,
  word for word, in the row.
- **Post the table as one comment on issue #71**, with the build number. For a
  fail, add a Developer → Playback diagnostics → Copy taken right after it.

## The steps

All links start `https://foray-web-seven.vercel.app/#/`.

1. **A published Foray, in the app.** Open the Foray *The types of capital a
   startup can raise* (`capital-types-1`) and tap **Share** in its header.
   *Expected:* the iOS share sheet opens with the Foray's title. Save to Notes.
   The URL is `…/#/foray/capital-types-1`.
   Then tap **Share** again and close the sheet without choosing anything.
   *Expected:* nothing else happens. A second sheet, "Link copied" or a link
   field after a cancel is a fail: the cancel was read as an error. Write a
   second row with delivery "cancelled".

2. **An episode page.** Open an episode from Home and tap **Share** in its row
   of buttons (beside Play next).
   *Expected:* the sheet; the text is the episode's title · its show; the URL
   is `…/#/episode/<id>`. Keep this episode for step 5.

3. **A show page.** On that episode's page, tap the show's name under the
   title, then tap **Share** beside **+ Follow** (or **✓ Followed**).
   *Expected:* the sheet; the text is the show's title; the URL is
   `…/#/show/<id>`.

4. **A Suggested card, then its playlist.** On Home under **Suggested**, tap
   **Share** on a card.
   *Expected:* the sheet. The card shares the episode it starts with (its
   "Starts with …" line), so the URL is that episode's `…/#/episode/<id>`.
   Then open the card (its playlist page) and tap **Share** at the top.
   *Expected:* the sheet; the text is the playlist's title; the URL is
   `…/#/playlist/shared~<letters>`. The letters carry the queue's title and
   episodes, so someone else can open the same list.

5. **The Now Playing sheet.** Play the episode from step 2, open the Now
   Playing sheet and tap **Share**.
   *Expected:* the sheet, with the same URL as step 2. Then play the Foray
   from step 1, open Now Playing and tap **Share** again.
   *Expected:* the URL is the Foray's, `…/#/foray/capital-types-1`, never the
   episode its current segment comes from.

6. **An episode of a show found by search (#1141, #1146).** Shows → search for
   a show that is not on Home → open one of its episodes → **Share**.
   *Expected:* the sheet; the URL is `…/#/episode/<id>`, sometimes with
   `/k/<letters>` after the id, or the show's `…/#/show/<id>` when the episode
   cannot be linked on its own. Write down which.

7. **iPhone Safari, the website (#71 acceptance line 1).** In Safari open
   `https://foray-web-seven.vercel.app/#/foray/capital-types-1` and tap
   **Share**. Then open an episode page and tap **Share**. Close one of these
   sheets once without choosing.
   *Expected:* the iOS share sheet both times (Web Share); the same URLs as in
   the app; a closed sheet does nothing more.

8. **The clipboard, on the PC (#71 acceptance line 2).** In Firefox open the
   same Foray link and tap **Share**.
   *Expected:* **"Link copied"** beside the button for about 4 seconds. Paste
   into Notepad: the URL alone. Then play an episode, open the Now Playing
   sheet and tap **Share**.
   *Expected:* the button reads **"Link copied ✓"** for 1.5 seconds, then
   **Share** again. If a share sheet opens instead, write "sheet" and try
   another browser. If the clipboard is refused on the Now Playing sheet,
   nothing shows on screen. That message is only spoken, because the sheet's
   button gets no note beside it. Write "nothing visible" in that row.

9. **Cold opens (#1141, #1146).** Open each URL from Notes in a **Safari
   Private tab** (tabs button → **Private**), long-pressing the link → Copy,
   then pasting it into the address bar. Or open it on a second device.
   *Expected, for each:* the page opens on its own, with no "not found" and no
   empty list:
   - a Foray: the Foray page *The types of capital a startup can raise*, with
     Play;
   - an episode: that episode's page, with its title and Play;
   - a show: the show's page and its episodes;
   - a playlist (`shared~`): the playlist page, reading **Shared playlist**,
     with the same episodes in the same order.
   Then, on the iPhone with 4a installed, tap one link in Notes (not Private).
   *Expected:* it opens in **Safari, not 4a**. That is right until #145, as
   "What this script does not check" says. Write "web".

10. **Android Chrome (optional; precondition 5).** On an Android phone of your
    own, repeat step 7 in Chrome, then step 9's cold opens in an **Incognito**
    tab.
    *Expected:* Android's share sheet; the same URLs; every page opens. If no
    Android phone is at hand, write "not run (no Android phone; D-A3)".

## How it is judged

- **#71 acceptance line 1** (native sheet on iOS Safari and Android Chrome):
  step 7 opens the sheet. Step 10 does the same on Android, or is "not run",
  which leaves the Android half of line 1 open.
- **#71 acceptance line 2** (clipboard confirms visibly): step 8 shows "Link
  copied" and "Link copied ✓".
- **The app:** steps 1 to 6 open the sheet and step 1's cancel does nothing
  more.
- **Cold opens:** every URL in step 9 opens its page in a Private tab.
  "Web, not the app" is the expected result, not a failure.
- **Stop and escalate** (PH2-06): if the app opens no sheet *and* the
  clipboard is refused, so that "Copy this link" is what a listener gets, the
  founder should see it. If the app opens no sheet but copies the link, the
  build lacks the plugin (#1077): a session follow-up, not a founder one.

A session copies the #71 comment into
`docs/field-records/<YYYY-MM-DD>-share-shells.md` from the template. #71 itself
stays open while its items 1 and 3 wait on a founder decision.
