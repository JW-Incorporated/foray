# Google Play listing — what to paste where

Everything the Play Console asks for on **Main store listing** and **Store
settings**, in this folder, in the order the form asks for it. Copy from here;
do not retype.

Play Console → your app → **Grow** → **Store presence** → **Main store listing**.

---

## 1. App name

Type it in. It is not in a file because it is two characters:

```
4a
```

Max 30 characters. Must match the app's own title (`index.html` says `4a`).

## 2. Short description

Field: **Short description** (80 characters max).
Paste the whole of **`short-description.txt`** — one line, 71 characters:

> Forays: one subject across many shows, plus new episodes picked for you

## 3. Full description

Field: **Full description** (4000 characters max).
Paste the whole of **`full-description.txt`** — 2946 characters.

**Rewritten 2026-10-07 (wave 16, issue #42)** to describe the app main ships:
Home's rails (Play, Jump back in, Forays for you, Playlists for you, and
Suggested with its Stretch slot), Forays, Create, in-app playback with chapters, Up Next
and Continuous playback (and the switch that turns it off), manual downloads
that wait for Wi-Fi, Save and Follow as the app words them, Share, Family mode
as `familySafe()` implements it, and "No account. No ads." The 2202-character
version described the retired four-card Home, a hand-off to Apple Podcasts,
"no autoplay chain" and audio that always needed a connection — all false
against main. Every privacy sentence in it was checked against
`docs/legal/privacy-policy.md` (the short version, §3 and §7); nothing new is
claimed there. Stretch is claimed for Suggested only: Forays for you draws a
Stretch pick only from a topic outside its top 60%, and the two published
Forays (business, engineering) are both top, so that row has none — the
intro sheet makes the same claim conditional (p-first-11), and a listing
cannot. `tools/store/play-listing.test.mjs` now fails if a retired
claim comes back, if Stretch is put on Forays for you while the published
Forays cannot produce one, or if a control the copy names by its in-app label stops
existing under that label.

Paste it as plain text. Play strips formatting, and the ALL-CAPS lines in the
file are the section headings — they are meant to survive as they are.

## 4. App icon

Field: **App icon**, 512 × 512 PNG.

Upload **`app-icon-512.png`** (512 × 512, 83,547 bytes).

**Do not upload `icon-512.png` from the repo root.** It is also 512 × 512 and it
is the wrong file — Play rejected it. Two reasons, both real:

- Play's spec is a **32-bit PNG (with alpha)**. `icon-512.png` is 24-bit RGB
  with no alpha channel, and it has to stay that way: **the App Store rejects an
  icon that carries an alpha channel**, and that same file is the App Store's
  icon, the PWA manifest's, the service worker's precache and the Android
  lock-screen artwork. The two stores want opposite files, so there are two
  files. `app-icon-512.png` is fully opaque — it has an alpha channel, nothing
  in it is transparent.
- The mark filled 41% of the height, floating in a cream band. Play masks icons
  with a 30% corner radius and shows them at about 48 px in a list, where that
  reads as a small logo in a box. `app-icon-512.png` crops the wordmark to the
  "4a" ligature — dropping the trailing waveform, which is an unreadable smudge
  at 48 px anyway — and fills 67% of the height.

Neither file has rounded corners or a drop shadow baked in, and neither should:
Play applies both itself, and pre-rounded artwork gets rounded twice.

## 5. Feature graphic

Field: **Feature graphic**, 1024 × 500.

Upload **`feature-graphic.png`** (1024 × 500, 99,174 bytes).

Required — Play will not let the listing go live without it.

## 6. Phone screenshots

Field: **Phone screenshots**. Play needs at least 2 and takes up to 8. Upload all
four, **in this order** — the first is the one shown in search results:

| # | File | What it shows |
| --- | --- | --- |
| 1 | `screenshot-1-daily-picks.jpg` | The home screen as it was on 2026-08-25: the intro banner and the four subject cards, one of them marked Stretch, with episode counts and runtimes. |
| 2 | `screenshot-2-built-playlist.jpg` | A playlist built from a typed subject ("the roman empire") — ten episodes across several shows. |
| 3 | `screenshot-3-queue.jpg` | Tapping a card: the episodes inside one subject queue, in order, with show and running time. |
| 4 | `screenshot-4-player.jpg` | The player under the "Roman Empire" playlist: scrubber, back 15 / forward 30, playback speed, and an "Open episode ↗" link out of the app. That link no longer exists — since 2026-09-02 every episode plays inside 4a and nothing hands off to another app. |

**All four screenshots are stale.** They were captured 2026-08-25, before
Home's rails replaced the four-card Home: `screenshot-1` shows that retired
Home and `screenshot-4` the deleted link-out, and `screenshot-2` and
`screenshot-3` predate six weeks of changes to the list rows and the player,
so check them against the app rather than assuming they still match. The
rewritten description does not lean on any of them. Recut them per `CAPTURE.md` in a
follow-up; the description does not wait on that, and a listing published
with these four is still accurate in its words and dated in its pictures.

All four are 720 × 1280 JPEG (9:16), which is what Play wants for a phone.

There are no tablet, Chromebook, TV or Wear screenshots in this package. Play
does not require them for a phone-only release; it will show a "no screenshots
for this form factor" warning on those tabs, which is expected and does not
block publishing.

## 7. Store settings (a different page)

Play Console → **Grow** → **Store presence** → **Store settings**.

- **App category** — Music & Audio.
- **Contact details** — the developer account's, not in this folder.

The developer account name shown on the listing is **JW Labs LLC**, which is
also how the full description signs off. If the Console shows anything else,
fix the account, not the copy.

## 8. App content — a different page again, and it blocks release

Play Console → **Policy and programs** → **App content**. Nothing here is in
this folder, but **the listing cannot go live until this page is complete**, so
do not stop after §7 thinking you are done. Every answer already exists:

- **Privacy policy URL** — `https://jwlabs.ai/4a/privacy/`
  (verified HTTP 200 on 2026-08-25; see `HUMAN-ACTIONS.md` #25. Use the
  `jwlabs.ai` spelling, never `jwlabs.dev`.)
- **Ads** — *No, my app does not contain ads.*
- **Data safety** — the whole questionnaire is answered, question by question and
  with Play's own checkbox names, in **`docs/legal/data-safety.md`**. Work from
  that file; do not answer it from memory.
- **Content rating** — fill in the IARC questionnaire. The app has no
  user-generated content, no in-app purchases and no social features.
- **Target audience and content** — not a children's app.

---

## What is deliberately not in this package

- **No promo video.** Optional, and there is nothing to link.
- **No tablet or other form-factor art.** See above.
- **Forays are in the copy now, under three limits that still hold.** Until
  2026-10-07 the copy said nothing about them (every Foray was a draft when it
  was written; `capital-types-1` was published 2026-08-30, and
  `how-ai-actually-gets-built-3b83e1` since). The rewrite describes a Foray in
  the app's own terms (`forayAbout()` in `app.js`: one subject, moments from
  several podcasts, each from the show's own feed) and still must not claim:

  1. **Scale.** "4a puts each Foray together by hand, so they arrive a few at a
     time" is the app's own line (the empty Forays page). No count, no
     "library", no "growing collection".
  2. **A narrator, host or guide.** One published Foray carries narration
     items and the other carries none, so `forayAbout()` says "with a narrator"
     only when one does. A listing cannot be conditional, so it says nothing
     either way (`docs/curation/foray2-capital.md` §11b for the history).
  3. **Background or offline playback of a Foray.** **#224** is open: a seam
     can stop playback with the screen off. The offline claim in the copy is
     scoped to downloaded episodes, which is what `player/download-store.js`
     covers; nothing downloads a Foray.
- **No mention of thumbs-up/down voting, its reason chips, or "more like this /
  less like this"** — but the reason has changed and it is worth being explicit
  because `https://jwlabs.ai/4a/features/` does describe them. Every one of those
  controls is rendered only by `renderForay()` in `app.js` and keyed to a segment,
  so they used to sit behind the same draft wall the forays did. **That wall is
  down**: they are reachable inside `capital-types-1`. This paragraph is now a
  choice rather than a constraint.
- **No promise of a daily cadence.** The header still says "a daily podcast
  picker", but Home's picks are re-dealt on load, not once a day, so the copy
  says nothing about days. If the picks are ever pinned to a real day, the
  copy can say so.

## Regenerating

- **App icon:** `node tools/store/build-play-icon.mjs`. Same rule — it is
  rendered from `tools/brand/4a-logo.png`, and hand-editing it turns the build
  red (`tools/store/play-listing.test.mjs`). It does **not** regenerate
  `icon-512.png`; that one comes from `node tools/brand/build-icons.mjs` and is
  a different file on purpose.
- **Feature graphic:** `node tools/store/build-feature-graphic.mjs`. It is
  rendered from `tools/brand/4a-logo.png`; never edit the PNG by hand, the build
  goes red (`tools/store/play-listing.test.mjs`).
- **Screenshots:** see `CAPTURE.md` in this folder.
- **Checks:** `node --test tools/store/play-listing.test.mjs`, or the whole
  suite with `npm test`.
