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

> Four podcast queues at a time, not an endless feed. No account, no ads.

## 3. Full description

Field: **Full description** (4000 characters max).
Paste the whole of **`full-description.txt`** — 2202 characters.

Paste it as plain text. Play strips formatting, and the ALL-CAPS lines in the
file are the section headings — they are meant to survive as they are.

## 4. App icon

Field: **App icon**, 512 × 512 PNG.

**This one is not in this folder.** It is `icon-512.png` in the repo root,
already the right size and format. Upload that file.

## 5. Feature graphic

Field: **Feature graphic**, 1024 × 500.

Upload **`feature-graphic.png`** (1024 × 500, 99,174 bytes).

Required — Play will not let the listing go live without it.

## 6. Phone screenshots

Field: **Phone screenshots**. Play needs at least 2 and takes up to 8. Upload all
four, **in this order** — the first is the one shown in search results:

| # | File | What it shows |
| --- | --- | --- |
| 1 | `screenshot-1-daily-picks.jpg` | The home screen: the intro banner and the four subject cards, one of them marked Stretch, with episode counts and runtimes. |
| 2 | `screenshot-2-built-playlist.jpg` | A queue assembled from a typed request ("the roman empire") — ten episodes across several shows. |
| 3 | `screenshot-3-queue.jpg` | Tapping a card: the episodes inside one subject queue, in order, with show and running time. |
| 4 | `screenshot-4-player.jpg` | The player: scrubber, back 15 / forward 30, playback speed, and the hand-off to another podcast app. |

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
- **No mention of forays** in the copy. A foray is the app's stitched sequence of
  segments from several shows, and it is the most interesting thing 4a does —
  but every foray in `data/forays.json` is `status: "draft"`, and a draft is
  reachable only by opening its id in the URL. Nobody who installs from Play can
  browse to one. Describing forays in the listing would be advertising a feature
  the store's own visitors cannot use, so the copy stays on what ships. **Publish
  a foray and this listing should be rewritten** — it is the strongest thing
  there would be to say.
- **No mention of thumbs-up/down voting, its reason chips, or "more like this /
  less like this"**, for the same reason and it is worth being explicit about it
  because `https://jwlabs.ai/4a/features/` does describe them. Every one of those
  controls is rendered only by `renderForay()` in `app.js` and keyed to a segment,
  so they live behind the same draft wall the forays do. Publishing a foray
  unlocks this paragraph too.
- **No promise of a daily cadence**, beyond the app's own "a daily podcast
  picker" subtitle visible in the screenshots. The four subjects are re-rolled on
  every page load, not once a day — measured on the live site 2026-08-25 — so the
  copy says "come back for a fresh set" and "tap refresh for a different four",
  both of which are true today. If the picks are ever pinned to a real day, the
  copy can say so.

## Regenerating

- **Feature graphic:** `node tools/store/build-feature-graphic.mjs`. It is
  rendered from `tools/brand/4a-logo.png`; never edit the PNG by hand, the build
  goes red (`tools/store/play-listing.test.mjs`).
- **Screenshots:** see `CAPTURE.md` in this folder.
- **Checks:** `node --test tools/store/play-listing.test.mjs`, or the whole
  suite with `npm test`.
