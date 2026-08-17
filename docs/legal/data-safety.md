# Store data declarations — Google Play Data Safety + Apple App Privacy

**Status: DRAFT, derived from the code at `909adb5`. Not yet submitted.**
Part of issue #42 (MP8). Companion to [`privacy-policy.md`](./privacy-policy.md).

This file exists so that whoever fills in the two web forms is copying verified
answers rather than guessing. Every answer carries a one-line justification and a
code reference. **If you change the answer in a form, change it here in the same
PR** — a published declaration that no longer matches the code is a public,
binding, wrong statement.

Both stores define "collect" as **transmitted off the device**. Data that only
ever sits in `localStorage` or IndexedDB is *not* collected under either
definition. That is why §1 of the audit matters more than any other section: most
of what Foray knows is not declarable, and declaring it anyway would overstate
collection.

---

## The audit this rests on

Read `privacy-policy.md` §1–§4 for the full table. The three facts that decide
every answer below:

1. **20 `cp_*` storage keys live on the device**, each mirrored into both
   `localStorage` and IndexedDB (`player/durable-store.js` mirrors the whole
   `cp_` prefix; db `foray`, store `kv`).
2. **Exactly 5 of 18 event types are transmitted**, to one endpoint
   (`https://qjdllvqdcgacvujhclny.supabase.co`), keyed to an anonymous account.
   Mapping: `app.js:220–256`. Transmission: `app.js:258–284`, called from
   `app.js:664, 686, 999, 1776`.
3. **Audio streams directly from publisher CDNs** (`player/html-audio-backend.js:410`,
   URLs from `data/segment-sources.json`). No Foray server in the path; we
   receive nothing.

The client's CSP (`index.html:13`) allows connections to `'self'` and the
Supabase project only — so the transmitted set above is not merely what the code
does today, it is the *most* the browser would permit without a code change.

---

# Part A — Google Play Data Safety form

## A1. Does your app collect or share any of the required user data types?

**Yes.** The app transmits event rows to our own hosted database.

## A2. Data types — the full checklist

Answer every row; Play penalises omissions, and "not applicable" rows are the
ones a template gets wrong.

| Play data type | Collected? | Shared? | Justification + reference |
|---|---|---|---|
| **Location** (approximate or precise) | **No** | No | No geolocation call anywhere in the client. No permission requested. |
| **Personal info — Name** | **No** | No | Never asked. No signup. |
| **Personal info — Email address** | **No** | No | Never asked. Anonymous accounts only (ADR-0005). |
| **Personal info — User IDs** | **Yes** | No | Every transmitted row carries the Supabase anonymous account id (`toEventRow`, `app.js:222`). It is opaque and holds no PII. |
| **Personal info — Address / Phone / Race / Political or religious beliefs / Sexual orientation** | **No** | No | Never asked. See the note in A5 on the two thumbs-down reason codes — they are content feedback, not a declared belief. |
| **Personal info — Other info** | **No** | No | — |
| **Financial info** | **No** | No | No payments, no IAP, no billing code in the repo. |
| **Health and fitness** | **No** | No | — |
| **Messages** | **No** | No | No messaging feature. |
| **Photos and videos** | **No** | No | No camera or photo-library access. |
| **Audio files** (voice/sound recordings, music, other) | **No** | No | The app **plays** third-party audio; it never records, uploads or stores audio. No `getUserMedia`. Playback is a direct fetch from the publisher (A6). |
| **Files and docs** | **No** | No | — |
| **Calendar** | **No** | No | — |
| **Contacts** | **No** | No | — |
| **App activity — App interactions** | **Yes** | No | The five transmitted events are interactions: picked, finished, saved, thumbs, session shown (`app.js:223–255`). |
| **App activity — In-app search history** | **No** | No | The playlist box (`app.js:779`, `maxlength=120`) is searched entirely on-device by `search-engine.js`; `playlist_built`/`playlist_removed` are local-only (they fall to `toEventRow`'s `default: return null`). Stored in `cp_playlists`, never sent. |
| **App activity — Installed apps** | **No** | No | Not enumerated. `cp_player` records *your stated preference* for an external app and is local-only; the `picked` row's `app` field is that preference label (e.g. "Apple Podcasts"), not a scan of your device. |
| **App activity — Other user-generated content** | **Yes** | No | The thumbs-down free-text note is transmitted (`app.js:994`; input `#fy-sheet-note`, `app.js:1087`, up to 200 chars). |
| **App activity — Other actions** | **Yes** | No | Thumbs direction and the fixed reason codes (`app.js:966–970`, sent at `app.js:246`). |
| **Web browsing history** | **No** | No | The app cannot see your browsing. |
| **App info and performance — Crash logs** | **No** | No | **No crash reporter.** Nothing bundled, nothing sent. |
| **App info and performance — Diagnostics** | **No** | No | `cp_storage_health` records storage-tier faults **on the device only**; `storage_fault` is a local-only event type. Never transmitted. |
| **App info and performance — Other app performance data** | **No** | No | — |
| **Device or other IDs** | **No** | No | No advertising id, no device id, no fingerprinting. `cp_profile_id` is a locally-generated random string (`app.js:152–159`) and is **deliberately not included** in any transmitted row — `toEventRow` never copies it. |

## A3. For each collected type — the follow-up questions

Applies to **User IDs**, **App interactions**, **Other user-generated content**
and **Other actions** (the four "Yes" rows above).

- **Is this data processed ephemerally?** **No.** Rows are stored in the `events`
  table for later curation work.
- **Is collection required or optional?** **Required** for App interactions,
  User IDs and Other actions — the app syncs without asking. **Optional** for
  Other user-generated content (the note): it is only sent if you type one, and
  a thumbs-down commits only on submit (`app.js:1161`).
  - *Honest caveat for the founder:* Play's "optional" means the user can use the
    app without providing it. That is true of the note. It is **not** true of the
    others — there is no opt-out or consent gate for event sync today; the first
    load emits `session_shown` and syncs it (`app.js:1775–1776`). If you would
    rather answer "optional" across the board, that requires building a toggle
    first. See § What would change these answers.
- **Purposes** (check these, and only these):
  - **App functionality** — resume, saved items, and the feedback record.
  - **Personalization** — thumbs and plays move the interest weights that pick
    your menu (`nudgeTopics`, `app.js:305`).
  - **Do NOT check:** Analytics, Advertising or marketing, Developer
    communications, Fraud prevention, Account management. None apply. There is no
    analytics pipeline and no ad code.

## A4. Is any of this data shared with third parties?

**No** — under Play's definition. Play excludes transfers to a **service provider
processing on the developer's behalf**. Supabase is our hosted database, not a
recipient with its own purpose. We send data to nobody else: the CSP permits no
other endpoint (`index.html:13`).

## A5. Two judgement calls a founder should see rather than inherit

1. **The political-slant reason codes.** Two of the nine fixed thumbs-down chips
   are "Leans too far left" and "Leans too far right" (`app.js:966–970`), and the
   selected chip is transmitted. These record a reaction to *an episode*, not a
   declaration of the listener's own politics, and the app never asks for
   political views — so the "Political or religious beliefs" row above is
   answered **No**. That is the defensible reading, but it is a reading. It is
   disclosed in the privacy policy §2 regardless, which is the conservative
   choice. **Worth a lawyer's eye** (see the review TODO in the policy).
2. **Listening history is sensitive in practice even where no form says so.**
   `docs/marketing/05-legal-risk-memo.md` §5 makes this point and it still holds:
   a full listening history can imply politics, health or religion the way
   browsing history can. Neither store forces a stricter tier for it, and the
   mitigation is the product's existing posture — first-party curation only, no
   sale, no ad network.

## A6. Playback from publisher CDNs — why it is not a Play "sharing" answer

Playing a segment points an `<audio>` element at the publisher's own URL
(`player/html-audio-backend.js:410`). Your device therefore reveals its **IP
address and user-agent** to that host — including `dts.podtrac.com`, `mgln.ai`
and `2.gum.fm`, which are download-measurement prefixes operated for the
**publisher**.

This is **not** declared as collection or sharing, for three reasons:

1. **We receive nothing.** Neither collection nor sharing is satisfied by data we
   never obtain — and by design we cannot: there is no Foray server in the audio
   path (product principle 3).
2. **IP address is not one of Play's declarable data types.** It is not in
   "Device or other IDs", which enumerates IMEI, MAC, Widevine, Firebase
   installation and advertising identifiers.
3. **It is inherent to playing audio from its source**, exactly as a browser
   loading any URL, and it is not a transfer we perform.

It **is** disclosed prominently in the privacy policy §4, because that is where
a user is entitled to learn it and because both stores expect the policy to be
complete even where the form has no checkbox. Do not let the absence of a form
field become an absence of disclosure.

## A7. Security practices section

- **Is data encrypted in transit?** **Yes.** Every request is HTTPS
  (`app.js:173` `https://…supabase.co`; the CSP forbids cleartext, and audio is
  `media-src https:`).
- **Do you provide a way for users to request that their data be deleted?**
  **No, today.** Answering yes would be false: there is **no in-app delete or
  reset control**, and no deletion URL. Local data is cleared through browser or
  OS settings; server rows have no reachable delete path.
  - The capability exists at the data layer — the row-level-security policy is
    `for all`, which covers delete
    (`backend/migrations/supabase/0001_auth_and_rls.sql`) — so this is a missing
    feature, not a missing permission.
  - > TODO(founder): **build a delete path, or answer No and publish that.**
    Google Play expects a deletion URL where applicable, and this is the single
    biggest gap between the app and a clean declaration. Recommended: a settings
    control that clears both storage tiers and issues one authenticated
    `DELETE /rest/v1/events?user_id=eq.<uid>`.
- **Independent security review?** **No.** None has been done. Do not check it.
- **Committed to Play Families policy?** > TODO(founder) — a listing decision.
  The app is general-audience and collects no age (policy §6).

## A8. Data deletion + policy URLs

> TODO(founder): the **privacy policy URL** and the **data-deletion URL** the form
> requires. `privacy-policy.md` must be hosted somewhere public first — a path in
> a GitHub repo is not an acceptable answer for a store listing.

---

# Part B — Apple App Privacy (App Store Connect)

Apple's definition of "collect" is narrower than a plain reading: transmitting
data off the device **in a way that lets you or your partners access it for
longer than the real-time request needs**. Same conclusion as Play — the local
`cp_` keys are not collected.

## B1. Do you or your third-party partners collect data from this app?

**Yes.**

## B2. Data types

| Apple category | Collected? | Justification |
|---|---|---|
| **Contact Info** (name, email, phone, address, other) | **No** | Never asked; anonymous accounts only. |
| **Health & Fitness** | **No** | — |
| **Financial Info** | **No** | No payments or IAP. |
| **Location** (precise or coarse) | **No** | No geolocation call; no permission requested. |
| **Sensitive Info** | **No** | Apple's category covers racial/ethnic data, sexual orientation, pregnancy, disability, religious or political *belief*, biometric and genetic data. Foray asks for none. See A5 for the slant-chip judgement. |
| **Contacts** | **No** | — |
| **User Content — Other User Content** | **Yes** | The free-text thumbs-down note is transmitted (`app.js:994`). |
| **User Content** — photos, videos, audio, gameplay, customer support | **No** | None exist. The app plays third-party audio; it records and uploads none. |
| **Browsing History** | **No** | Not accessible to the app. |
| **Search History** | **No** | Playlist search is on-device and never transmitted (`search-engine.js`; playlist events are local-only). |
| **Identifiers — User ID** | **Yes** | The Supabase anonymous account id on every row (`app.js:222`). |
| **Identifiers — Device ID** | **No** | No IDFA, IDFV, or fingerprint. `cp_profile_id` is local-only and never transmitted. |
| **Purchases** | **No** | — |
| **Usage Data — Product Interaction** | **Yes** | picked / finished / saved / thumbs / session shown (`app.js:223–255`). |
| **Usage Data — Advertising Data** | **No** | No ads anywhere. |
| **Usage Data — Other Usage Data** | **No** | Nothing beyond the five mapped types. |
| **Diagnostics** (crash, performance, other) | **No** | No crash reporter; `storage_fault` and `cp_storage_health` never leave the device. |
| **Surroundings** / **Body** | **No** | No sensors, camera or microphone. |
| **Other Data** | **No** | — |

## B3. For each collected type — linkage, tracking, purpose

Applies to **User ID**, **Product Interaction** and **Other User Content**.

- **Linked to the user's identity?** **Yes** — all three. Each row is keyed to the
  anonymous account id, so it is linked to *an* identity even though that
  identity holds no PII. Apple's question is about linkage, not about whether the
  identity is a real name; answering "not linked" would be wrong.
- **Used for tracking?** **No** — all three. Apple defines tracking as linking
  your data with third-party data for targeted advertising or ad measurement, or
  sharing it with a data broker. Foray does none: no ad SDK, no data broker, no
  third-party recipient at all. **Therefore the app needs no App Tracking
  Transparency prompt.**
- **Purposes:** **App Functionality** and **Product Personalization** only. Not
  Third-Party Advertising, not Developer's Advertising or Marketing, not
  Analytics.

## B4. Apple-specific items that are easy to get wrong

- **`PrivacyInfo.xcprivacy` (privacy manifest).** Required for the app and for
  any bundled third-party SDK on Apple's "commonly used SDK" list.
  **The web client bundles no third-party SDK** — no `@supabase/supabase-js`; the
  Supabase calls are raw `fetch` precisely to satisfy the strict CSP
  (`app.js:172` comment). So no SDK manifest is inherited **today**.
  - > TODO(founder): if the native shell ever adds the Supabase Swift SDK or any
    Capacitor plugin, each needs its own manifest entry. `docs/marketing/05-legal-risk-memo.md`
    flagged a Supabase-SDK manifest as a checklist item; that item is **not
    applicable to the current code** and would only become applicable then.
  - **Required Reason APIs:** the client uses none of the categories Apple
    requires a declared reason for (no file-timestamp, disk-space, active-keyboard
    or user-defaults access from native code). A Capacitor shell should be
    re-checked against the list, since plugins can pull them in.
- **Rule 5.1.2 / third-party AI disclosure.** The legal memo treats this as a
  live obligation. **On the current code it is not:** no user data reaches an AI
  provider, and the CSP could not permit it. AI is used in our **build pipeline**
  on public podcast metadata, off-device. Do not build a consent screen naming an
  AI vendor for a data flow that does not exist — but see § What would change
  these answers, because one planned feature does create it.
- **Account deletion (App Store guideline 5.1.1(v)).** Applies to apps that let
  you *create an account*. Foray creates an anonymous account with no user
  action, which is arguably outside the rule — but the safe posture is the same
  delete control Play wants. Build it once, satisfy both.
  - > TODO(founder): confirm this reading, or just build the control.

---

# Part C — Where the native app's answers differ

The Capacitor shell is **not on `main`** as of `909adb5`; it lives on the
unmerged branch `feat/capacitor-shell` (PR #209), which is also behind `main`.
Treat this section as a forecast to re-verify at submission, not as a
description of shipped code. Store declarations are about the **app**, so these
are the answers that will actually be submitted.

| Aspect | Web | Native shell | Effect on the declarations |
|---|---|---|---|
| Event sync to Supabase | Yes | **Yes — unchanged.** The shell keeps `connect-src … supabase.co` in its CSP. | **None.** Every "Yes" above still applies. |
| Service worker / `foray-v4` cache | Registered | **Not registered** — `shouldRegisterServiceWorker()` returns false for `capacitor:`/`ionic:` origins and native platforms | None (that cache was never declarable — same-origin app shell). |
| Catalogue JSON | Fetched from GitHub Pages | **Bundled in the app** (`tools/mobile/prepare-webdir.mjs`) | Slightly *fewer* third parties: GitHub no longer sees catalogue requests. |
| App origin | `https://…github.io` | `capacitor://localhost` (iOS) / `https://localhost` (Android) | None. It is why the shell widens `img-src` to include `'self'`. |
| Audio from publisher CDNs | Direct | **Direct — unchanged** | §A6 applies identically. |
| Local storage tiers | localStorage + IndexedDB | **Same**, inside the WebView | None. |

**To re-verify before submitting:** that the shell adds no plugin which collects
anything (each Capacitor plugin can), and that `connect-src` still names only
Supabase.

---

# What would change these answers

Each of these silently invalidates a published declaration. **If you build one,
update this file and `privacy-policy.md` in the same PR and resubmit both
forms.**

| Change | What flips |
|---|---|
| **Adding an analytics SDK** (Firebase, Amplitude, GA…) | Play: `Analytics` purpose on existing types, probably `Device or other IDs` **Yes**, and likely `Shared: Yes` (an analytics vendor is usually not a mere service provider). Apple: `Analytics` purpose, `Device ID` **Yes**, and a `PrivacyInfo.xcprivacy` SDK entry. Possibly `Used for tracking: Yes` → an **ATT prompt**. The "no analytics" claim in policy §5 becomes false. |
| **Adding a crash reporter** (Sentry, Crashlytics…) | Play: `Crash logs` and probably `Diagnostics` → **Yes**. Apple: `Diagnostics` → **Yes**, plus an SDK privacy manifest. Crash payloads can carry incidental content, so re-check `Other User Content`. |
| **Backend sync of the rest of local state** — positions, interests, history, playlists | The largest change. Play: `Other actions` broadens; `In-app search history` becomes **Yes** if `cp_playlists` queries sync. Apple: `Search History` **Yes**; `Product Interaction` widens. Policy §1's "does it leave your device" column must be rewritten row by row — it is the column most likely to go stale. |
| **A live per-user API replacing static `data/*.json`** | Our server would then observe request patterns per user — a new collection surface with no checkbox, and it needs its own policy paragraph. `docs/DECISIONS.md` records this was deliberately *not* built. |
| **ElevenLabs narration** (sanctioned in principle, build deferred) | If narration is **pre-generated** from our scripts and shipped as audio files, **nothing changes** — no user data leaves. If it is generated **per user or per request** from anything user-derived, then user data reaches a third-party AI vendor: Apple **rule 5.1.2 disclosure and explicit consent before first transmission**, naming the vendor; a new third-party recipient in the policy; and Play `Shared: Yes`. The distinction is the whole disclosure question — decide it deliberately. |
| **Any AI call made from the device** | Same as above, plus the CSP must be widened — which is the tripwire. A new `connect-src` entry in `index.html` is a privacy change and should be reviewed as one. |
| **Ads or any monetization** | Advertising data, ad identifiers, tracking, ATT prompt, `Shared: Yes`, and a conflict with product principle 1. |
| **Asking for an email to link the anonymous account** (ADR-0005's opt-in upgrade) | Play `Personal info — Email address` **Yes**; Apple `Contact Info — Email` **Yes**. Also makes account deletion unambiguously required (5.1.1(v)). |
| **Adding a new podcast host to the catalogue** | No declaration changes, but policy §4's host list is a snapshot and should be refreshed. |
| **Widening the CSP `connect-src`** | Treat as a privacy change by default. It is the narrowest, most reliable tripwire in the codebase: the client cannot transmit anywhere the CSP does not name. |

---

# Open questions — could not be determined from the code

Flagged rather than guessed. None of these blocks filling in the forms, but each
is a fact the answers assume.

1. **Whether the Supabase project is accepting anonymous sign-ups right now.**
   `docs/DECISIONS.md` refers to "the now-provisioned Supabase project", and the
   client carries a real project URL and publishable key — so the declarations
   are written as though transmission happens, which is the conservative and
   correct posture for shipped code. But anonymous sign-in is a project setting
   that cannot be read from this repo; if it is disabled, `ensureAnonSession()`
   returns null and events buffer locally forever (`app.js:265`). **Verify in the
   Supabase dashboard.** This changes nothing about what to declare — the code
   attempts it — but it changes whether rows exist today.
2. **Whether the RLS policies are live and verified.** ADR-0005's own Risks
   section says they were "written to spec but **not yet verified against a live
   project**", and `0014` is recorded as not applied. The per-user isolation claim
   in policy §3 depends on them. **Verify before any real user data lands.**
3. **Retention.** No retention job exists; ADR-0005 anticipates one. Nothing in
   the code deletes an event row, ever.
4. **How many anonymous accounts already exist** — i.e. whether real user data is
   already in the table from development and testing. Not knowable from the repo.
5. **Whether the events table has ever received a `note`.** Free text already
   transmitted would be existing user content under an unpublished policy.
6. **Play's exact treatment of a publisher CDN request.** §A6 sets out our
   reasoning and it is sound, but it is an interpretation of Play's data-type
   list rather than a quote from it. The disclosure in policy §4 is what protects
   the user either way.
