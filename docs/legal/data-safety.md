# Store data declarations — Google Play Data Safety + Apple App Privacy

**Status: DRAFT, derived from the code at `909adb5`. Not yet submitted.**
Part of issue #42 (MP8). Companion to [`privacy-policy.md`](./privacy-policy.md).

**Changed since `909adb5`:** the in-app **Delete my data** control now exists, so
**A7's deletion answer is Yes** rather than No — the one answer in this file that
was a submission blocker. Nothing about what the app *collects* changed with it.

This file exists so that whoever fills in the two web forms is copying verified
answers rather than guessing. Every answer carries a one-line justification and a
code reference. **If you change the answer in a form, change it here in the same
PR** — a published declaration that no longer matches the code is a public,
binding, wrong statement.

**How to read a code reference here.** They name a declared symbol —
`app.js:toEventRow()`, `app.js:SB_ARCHETYPES`, `app.js:#pl-input` — not a line
number. Line numbers were used until 2026-08-19: there were 27 across this file
and `privacy-policy.md`, 23 of them here, and 26 of the 27 had gone stale without
anything reporting it, because a stale line number still lands on a line.
`test/legal-citations.test.js` now fails if a reference here names something the
code does not declare, if the set of event types the client transmits stops
matching `privacy-policy.md` §2, or if either document's event-type totals stop
matching the code. **No answer in this file changed with it.**

Both stores define "collect" as **transmitted off the device**. Data that only
ever sits in `localStorage` or IndexedDB is *not* collected under either
definition. That is why §1 of the audit matters more than any other section: most
of what 4a knows is not declarable, and declaring it anyway would overstate
collection.

---

## The audit this rests on

Read `privacy-policy.md` §1–§4 for the full table. The three facts that decide
every answer below:

1. **24 `cp_*` storage keys live on the device**, each mirrored into both
   `localStorage` and IndexedDB (`player/durable-store.js` mirrors the whole
   `cp_` prefix; db `foray`, store `kv`). Two of the 24 are diagnostics rather
   than a listener's data — `cp_storage_health` and `cp_diag` — and neither is
   transmitted.
2. **Exactly 4 of 22 event types are transmitted**, to one endpoint
   (`https://qjdllvqdcgacvujhclny.supabase.co`), keyed to an anonymous account.
   Mapping: `app.js:toEventRow()` — the five `case` arms that return a row are
   the whole transmitted set, and every other type falls to `return null`.
   Transmission: `app.js:trySyncEvents()`, called after a pick, after a play,
   after a thumb, and once on first render.
3. **Audio streams directly from publisher hosts** (`player/html-audio-backend.js:load()`;
   URLs from `data/segment-sources.json`, `data/session.json` and
   `data/discover.json`). **43 distinct first-hop hosts**, many of them
   measurement or ad-attribution prefixes that redirect onward, so the real chain
   is longer. No 4a server in the path; we receive nothing. See §A6 — this is
   the answer most likely to be got wrong in either direction.

The client's CSP (`index.html`) sets `connect-src 'self'` plus the Supabase
project plus our own API origin (`https://foray-web-seven.vercel.app`, the
Vercel project that serves `api/shows/*` and `api/episodes/*`), so the
transmitted set above is the *most* the browser would permit for a data-sending
request without a code change. What that API entry carries is a show id, or a
typed search query — the privacy policy §2 states it; no account id and no
event goes with it. Note it also allows
`img-src https:` and `media-src https:` — any HTTPS host — which is how audio and
artwork load. The CSP bounds outbound *data*, not all network access.

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
| **Personal info — User IDs** | **Yes** | No | Every transmitted row carries the Supabase anonymous account id (`app.js:toEventRow()` stamps `user_id` on every row it builds). It is opaque and holds no PII. |
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
| **App activity — App interactions** | **Yes** | No | The five transmitted events are interactions: picked, finished, saved, thumbs, session shown (`app.js:toEventRow()`). The `picked` row's `context` field is filtered against a five-value allowlist (`app.js:SB_ARCHETYPES`) but the app only ever produces `continue` or a value the filter discards, so it is `"continue"` or null in practice — it does not report which recommendation archetype you saw. |
| **App activity — In-app search history** | **No** | No | The playlist box (`app.js:#pl-input`, `maxlength=120`) is searched entirely on-device by `search-engine.js`; `playlist_built`/`playlist_removed` are local-only (they fall to `toEventRow`'s `default: return null`). Stored in `cp_playlists`, never sent — which since #276 also holds a copy of each saved episode’s title, show, length, topic ids and Apple Podcasts ids, so an aged-out part still renders. That is catalogue metadata about episodes, not search history about you, and none of it leaves the device either. The Shows search box (`app.js:#sh-input`) works the same way for anything already in 4a's local catalogue; when a search misses the local catalogue it looks the query up against a shard/index off-device (HUMAN-ACTIONS.md #38, `privacy-policy.md` §2) — that miss-only lookup is not a search-history event and is not logged, but it is a network transmission of what you typed, so this row is worth a lawyer's eye once shard/API-backed Shows search ships. |
| **App activity — Installed apps** | **No** | No | Nothing is enumerated. `cp_player` (your preferred external app) is local-only and never transmitted. The `picked` row carries an `app` field, but it reads a `data-app` attribute **nothing in the app ever sets**, so it is always the hardcoded literal `"Apple Podcasts"` regardless of your preference (`app.js:bindPickLogging()`) — it reports nothing about you or your device. |
| **App activity — Other user-generated content** | **Yes** | No | The thumbs-down free-text note is transmitted (`app.js:toEventRow()`; typed into `app.js:#fy-sheet-note`, `maxlength=200`). |
| **App activity — Other actions** | **Yes** | No | Thumbs direction and the fixed reason codes (`app.js:FB_CHIPS`, sent by `app.js:toEventRow()`). |
| **Web browsing history** | **No** | No | The app cannot see your browsing. |
| **App info and performance — Crash logs** | **No** | No | **No crash reporter.** Nothing bundled, nothing sent. |
| **App info and performance — Diagnostics** | **No** | No | Two local-only records, neither transmitted. `cp_storage_health` records storage-tier faults; `storage_fault` is a local-only event type. `cp_diag` (#264) records how the audio player behaved — seam durations, load deadlines, out-point overshoot, stops, resume decisions, background/foreground transitions with their durations, and taps on the transport that failed (#225) — capped at 200 entries, oldest dropped first, readable and clearable from the drawer's **Playback diagnostics** (`player/diagnostic-log.js`). It holds no audio, no URLs, no account id and no device names: only numbers matched by an explicit pattern, authored segment ids, stage names from a fixed vocabulary, and the error *class* of a failed tap (e.g. `NotAllowedError` — the name of the error type, never its message) — a telemetry line's text is never stored, and a recognised audio route is recorded as a fact rather than by name. It is deliberately OUTSIDE the `cp_events` pipeline, so no code path can send it. |
| **App info and performance — Other app performance data** | **No** | No | — |
| **Device or other IDs** | **No** | No | No advertising id, no device id, no fingerprinting. `cp_profile_id` is a locally-generated random string (`app.js:profileId()`) and is **deliberately not included** in any transmitted row — `toEventRow` never copies it. |

## A3. For each collected type — the follow-up questions

Applies to **User IDs**, **App interactions**, **Other user-generated content**
and **Other actions** (the four "Yes" rows above).

- **Is this data processed ephemerally?** **No.** Rows are stored in the `events`
  table for later curation work.
- **Is collection required or optional?** **Required** for App interactions,
  User IDs and Other actions — the app syncs without asking. **Optional** for
  Other user-generated content (the note): it is only sent if you type one, and
  a thumbs-down commits only on submit (`app.js:bindFeedback()`).
  - *Honest caveat for the founder:* Play's "optional" means the user can use the
    app without providing it. That is true of the note. It is **not** true of the
    others — there is no opt-out or consent gate for event sync today; the first
    load emits `session_shown` and syncs it (`app.js:init()`). If you would
    rather answer "optional" across the board, that requires building a toggle
    first. See § What would change these answers.
- **Purposes** (check these, and only these):
  - **App functionality** — resume, saved items, and the feedback record.
  - **Personalization** — thumbs and plays move the interest weights that pick
    your menu (`app.js:nudgeTopics()`).
  - **Do NOT check:** Analytics, Advertising or marketing, Developer
    communications, Fraud prevention, Account management. None apply. There is no
    analytics pipeline and no ad code.

## A4. Is any of this data shared with third parties?

**No** — under Play's definition. Play excludes transfers to a **service provider
processing on the developer's behalf**. Supabase is our hosted database, not a
recipient with its own purpose. We send data to nobody else: the CSP permits no
other endpoint (`index.html`).

## A5. Two judgement calls a founder should see rather than inherit

1. **The political-slant reason codes.** Two of the nine fixed thumbs-down chips
   are "Leans too far left" and "Leans too far right" (`app.js:FB_CHIPS`), and the
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

Playing anything points an `<audio>` element at the publisher's own URL
(`player/html-audio-backend.js:load()`). Your device therefore reveals its **IP
address and user-agent** to that host.

**Know the real scale before you answer this.** It is not a handful of CDNs:
**43 distinct first-hop hosts** across the three catalogue files the app fetches,
and because most publishers front their audio with redirecting prefix services,
the actual chain is longer than one hop. One real URL from our catalogue passes
through five intermediaries before reaching the audio:
`2.gum.fm → op3.dev → pdcn.co → pdst.fm → dts.podtrac.com → media.transistor.fm`.

**And several of those are advertising-attribution services, not just download
counters** — `pdst.fm`/`pdcn.co`/`pdrl.fm`, `chrt.fm`, `pscrb.fm`,
`claritaspod.com`/`clrtpod.com`, `prfx.byspotify.com`, `tracking.swap.fm`,
`pfx.vpixl.com`, the `gum.fm` hosts. Three of them appear in `data/session.json`,
the default home cards — so this is the shipped default path, not an edge case.
`index.html` already says as much in the CSP's own comment: "~41 different
podcast CDNs that we neither control nor can enumerate."

**Our answer: not declared as collection, and not declared as sharing.** The
reasoning, with the strong parts separated from the interpretive ones:

1. **We receive nothing. This is the reason that does the work, and it is a
   fact.** Both stores' definitions turn on data the developer or its partners can
   access. There is no 4a server in the audio path and there cannot be
   (product principle 3), so there is nothing for us to collect and no recipient
   we transferred anything to. The prefix operators are the **publisher's**
   vendors, chosen by the publisher in their own RSS enclosure URL; we have no
   account, contract or data feed with any of them.
2. **It is inherent to playing media from its source**, the same way a browser
   loading any URL reveals the requester to the host. It is not a transfer we
   perform.
3. **Interpretive, and flagged as such:** IP address is not among Play's
   enumerated declarable data types — it is absent from "Device or other IDs",
   which lists IMEI, MAC, Widevine, Firebase installation and advertising
   identifiers. Treat this as our reading, not a quotation: Play's list is
   illustrative rather than closed, and IP-derived location has been treated as
   declarable in some configurations. **Do not rest the answer on this point** —
   rest it on (1). This is Open Question 6.

**It is disclosed at length in the privacy policy §4 regardless**, naming the
hosts and the attribution vendors explicitly, because that is where a user is
entitled to learn it and because both stores expect the policy to be complete
even where the form has no checkbox. **Do not let the absence of a form field
become an absence of disclosure** — that is the one move that would turn a
defensible position into a misleading one.

One consequence to keep straight when filling in the forms: "4a contains no ad
tracking" is true of **our** code and is the right answer to the advertising
questions. It is not the same statement as "no advertising-related party sees
your playback", which would be false. The policy draws that distinction; keep it
drawn.

## A7. Security practices section

- **Is data encrypted in transit?** **Yes.** Every request is HTTPS — the one
  endpoint is `app.js:SB_URL`, an `https://…supabase.co` literal; the CSP forbids
  cleartext, and audio is `media-src https:`.
- **Do you provide a way for users to request that their data be deleted?**
  **Yes.** The app's menu (☰) carries **Delete my data** — the control built in
  #42, `app.js:deleteMyData()`. Play's question is about in-app deletion of
  *account data*, and this deletes both halves of it:
  - **On the device:** every `cp_` key, in **both** tiers, enumerated from the
    tiers themselves and re-read afterwards to verify
    (`DurableStore.purge()`, `player/durable-store.js`). No hard-coded key list —
    that is what produced the 11-vs-20 undercount this document rests on.
  - **On the server:** one authenticated `DELETE` per per-user table, filtered to
    `user_id=eq.<uid>` — `events` first (the only table this client writes), and
    `app_users` last. The row-level-security policy is `for all`, so a client can
    always delete its own rows; the missing piece was the request, not the
    permission.
  - **Order and failure behaviour are part of the answer.** `cp_sb_session` is
    the only credential that can reach those rows, so a remote failure stops the
    run, leaves the device untouched and says the rows were **not** deleted. It
    never reports a success it did not achieve. (Pinned by
    `test/data-deletion.test.js`.)
  - **What it does NOT delete, and both stores should be told the same thing:**
    the Supabase **auth user row** itself, which needs the admin API and a
    service-role key that cannot ship in a public client. The row is left holding
    no name, email, phone number or password, with its `app_users` row and all its
    events deleted, and the device's token discarded so the next event creates a
    **new** anonymous account. Removing the empty shell is a server-side job:
    `HUMAN-ACTIONS.md` #14. It also cannot delete what the publisher CDNs and
    ad-attribution prefixes already observed — see §A6; the control's own UI says
    so rather than implying otherwise.
  - Confirmation is a typed `DELETE`, so a stray tap cannot trigger it — relevant
    to Play only in that a deletion control that fires accidentally is its own
    kind of data-loss complaint.
- **Independent security review?** **No.** None has been done. Do not check it.
- **Committed to Play Families policy?** > TODO(founder) — a listing decision.
  The app is general-audience and collects no age (policy §6).

## A8. Data deletion + policy URLs

The **in-app** half of this is now built (see A7). The form additionally wants a
**public URL** describing deletion, which is a hosting task, not a code one.

> TODO(founder): the **privacy policy URL** and the **data-deletion URL** the form
> requires. `privacy-policy.md` must be hosted somewhere public first — a path in
> a GitHub repo is not an acceptable answer for a store listing. Its §7 is already
> written as the deletion page: it describes the control, the order it works in,
> and what it cannot reach.

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
| **Sensitive Info** | **No** | Apple's category covers racial/ethnic data, sexual orientation, pregnancy, disability, religious or political *belief*, biometric and genetic data. 4a asks for none. See A5 for the slant-chip judgement. |
| **Contacts** | **No** | — |
| **User Content — Other User Content** | **Yes** | The free-text thumbs-down note is transmitted (`app.js:toEventRow()`). |
| **User Content** — photos, videos, audio, gameplay, customer support | **No** | None exist. The app plays third-party audio; it records and uploads none. |
| **Browsing History** | **No** | Not accessible to the app. |
| **Search History** | **No** | Playlist search is on-device and never transmitted (`search-engine.js`; playlist events are local-only). Shows search (`app.js:#sh-input`) is the same for anything already in 4a's local catalogue; a search that misses the local catalogue looks the query up against a shard/index off-device (HUMAN-ACTIONS.md #38, `privacy-policy.md` §2) — that transmits what you typed, though it is not logged as a search-history event. |
| **Identifiers — User ID** | **Yes** | The Supabase anonymous account id on every row (`app.js:toEventRow()`). |
| **Identifiers — Device ID** | **No** | No IDFA, IDFV, or fingerprint. `cp_profile_id` is local-only and never transmitted. |
| **Purchases** | **No** | — |
| **Usage Data — Product Interaction** | **Yes** | picked / finished / saved / thumbs / session shown (`app.js:toEventRow()`). |
| **Usage Data — Advertising Data** | **No** | No ads anywhere. |
| **Usage Data — Other Usage Data** | **No** | Nothing beyond the five mapped types. |
| **Diagnostics** (crash, performance, other) | **No** | No crash reporter; `storage_fault`, `cp_storage_health` and `cp_diag` never leave the device. |
| **Surroundings** / **Body** | **No** | No sensors, camera or microphone. |
| **Other Data** | **No** | — |

## B3. For each collected type — linkage, tracking, purpose

Applies to **User ID**, **Product Interaction** and **Other User Content**.

- **Linked to the user's identity?** **Yes** — all three. Each row is keyed to the
  anonymous account id, so it is linked to *an* identity even though that
  identity holds no PII. Apple's question is about linkage, not about whether the
  identity is a real name; answering "not linked" would be wrong.
- **Used for tracking?** **No** — all three. Apple defines tracking as linking
  *the data you collect* with third-party data for targeted advertising or ad
  measurement, or sharing it with a data broker. 4a does none: no ad SDK, no
  data broker, and no third party receives anything from us. **Therefore the app
  needs no App Tracking Transparency prompt.**
  - Read together with §A6: the publisher's own attribution prefixes do observe
    the playback request. That does not make this answer Yes — Apple's question is
    about what *we* do with data *we* collect, and we neither obtain those
    requests nor combine anything with third-party data. It is still disclosed in
    the policy. If 4a ever integrated an attribution vendor itself, or received
    reporting back from one, this answer would flip and an ATT prompt would be
    required.
- **Purposes:** **App Functionality** and **Product Personalization** only. Not
  Third-Party Advertising, not Developer's Advertising or Marketing, not
  Analytics.

## B4. Apple-specific items that are easy to get wrong

- **`PrivacyInfo.xcprivacy` (privacy manifest).** Required for the app and for
  any bundled third-party SDK on Apple's "commonly used SDK" list.
  **The web client bundles no third-party SDK** — no `@supabase/supabase-js`; the
  Supabase calls are raw `fetch` precisely to satisfy the strict CSP
  (every request is a hand-written `fetch`: `app.js:sbAuth()` for auth,
  `app.js:trySyncEvents()` for the event insert, `app.js:sbDeleteOwnRows()` for
  the deletion — and `package.json` declares no dependencies and no build
  step). So no SDK manifest is inherited **today**.
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
  provider from the app, and `connect-src` would block a call from the device. AI
  runs in our **build pipeline**, off-device, in two places: (1) the ingest/build
  stage, on public podcast metadata; and (2) the generation pipeline's §4.1
  prompt-understanding stage (`backend/src/generation/AnthropicPromptUnderstander.ts`,
  invoked via `backend/src/cli/generateForay.ts`, plus its siblings
  `AnthropicSpineBuilder.ts`, `AnthropicDeepenActBuilder.ts`, and
  `AnthropicExternalResearcher.ts`), which sends the founder's free-text creation
  prompt to Anthropic (`claude-haiku-4-5`) for clarity/intent extraction. Today's
  actual sender for (2) is the founder, not a listener — Phase 1 generation is
  founder-only (§1.3, run from a CLI by Wyatt and Joey) — and that prompt text is
  provably not persisted anywhere (`backend/test/promptNoPersistence.test.ts`
  structurally greps the whole `generation/` stage for persistence primitives).
  Do not build a consent screen naming an AI vendor for a data flow that does not
  exist for a real listener today.
  - **But it is one env var away, not one feature away.** The pipeline already
    has a prompt field for listener context and it is currently fed a placeholder;
    see the `userInterestsProvider` row in § What would change these answers. If
    that is ever wired up, 5.1.2 applies and the memo's checklist item becomes
    live. Re-check this before every submission rather than trusting this
    paragraph.
  - **A second, independent tripwire: generation opening to non-founder users.**
    The day Phase 2 lets a real listener (not the founder) submit the free-text
    creation prompt described above, their prompt text reaching Anthropic becomes
    a live Rule 5.1.2 disclosure obligation on its own — regardless of whether
    `userInterestsProvider` is ever wired up. Re-check this document at that point
    too, not just the listener-context field.
- **Account deletion (App Store guideline 5.1.1(v)).** Applies to apps that let
  you *create an account*. 4a creates an anonymous account with no user
  action, which is arguably outside the rule — but the safe posture is the same
  delete control Play wants. Build it once, satisfy both.
  - **The control now exists** (A7), which is the "build it once" half. Read the
    limit honestly before answering Apple: it deletes every row keyed to the
    account and discards the credential, but **not the auth user record**, which
    needs a service-role key. If a reviewer reads 5.1.1(v) as requiring the
    account record itself to go, the remaining work is server-side
    (`HUMAN-ACTIONS.md` #14), not client-side.
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
| Service worker / `foray-gen-<deploy_id>` caches | Registered | **Not registered** — `shouldRegisterServiceWorker()` returns false for `capacitor:`/`ionic:` origins and native platforms | None (that cache family was never declarable — same-origin app shell). |
| Catalogue JSON | Fetched from GitHub Pages | **Bundled in the app** (`tools/mobile/prepare-webdir.mjs`) | Slightly *fewer* third parties: GitHub no longer sees catalogue requests. |
| App origin | `https://…github.io` | `capacitor://localhost` (iOS) / `https://localhost` (Android) | None. It is why the shell widens `img-src` to include `'self'`. |
| Audio from publisher CDNs | Direct | **Direct — unchanged** | §A6 applies identically. |
| Local storage tiers | localStorage + IndexedDB | **Same**, inside the WebView | None. |

**To re-verify before submitting:** that the shell adds no plugin which collects
anything (each Capacitor plugin can), and that `connect-src` still names only
Supabase and our own API origin — `test/legal-citations.test.js` asserts that
list exactly, reading both origins out of `app.js` rather than restating them.

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
| **Wiring the Postgres `userInterestsProvider` into the build pipeline** | **The likeliest silent invalidation, and it needs no client change at all.** `backend/src/enrich/AnthropicEnricher.ts:buildWhyLinePrompt()` already sends `Listener context: …` in the why-line prompt; `sessionBuilder.ts` builds that from `resolveEffectiveTaxonomy()`, whose first tier is observed `taxonomy_nodes` rows — i.e. derived from the very `events` table the client POSTs to. Today it is inert: `buildSession.ts` passes a fixed placeholder id and no provider, and `createUserInterestsProvider.ts` is gated on `DATABASE_URL` (`docs/DECISIONS.md` records the decision not to stand it up). Setting that env var would send event-derived interest labels to a third-party AI vendor **with no CSP change and no code review of the client** — so there is no tripwire. That triggers Apple rule 5.1.2 disclosure and consent, a new third-party recipient in the policy, and Play `Shared: Yes`. |
| **Any AI call made from the device** | Same as above, plus `connect-src` must be widened — which *is* a tripwire. A new `connect-src` entry in `index.html` is a privacy change and should be reviewed as one. |
| **Ads or any monetization** | Advertising data, ad identifiers, tracking, ATT prompt, `Shared: Yes`, and a conflict with product principle 1. |
| **Asking for an email to link the anonymous account** (ADR-0005's opt-in upgrade) | Play `Personal info — Email address` **Yes**; Apple `Contact Info — Email` **Yes**. Also makes account deletion unambiguously required (5.1.1(v)). |
| **Adding a new podcast host to the catalogue** | No declaration changes, but policy §4's host list is a snapshot and should be refreshed. |
| **Widening the CSP `connect-src`** | Treat as a privacy change by default. It is the narrowest reliable tripwire in the **client**: no `fetch`, XHR or WebSocket can reach an origin `connect-src` does not name. It bounds outbound data only — `img-src https:` and `media-src https:` already permit any HTTPS host, and a change on the **server** side (the row above) has no tripwire at all. |

---

# Open questions — could not be determined from the code

Flagged rather than guessed. None of these blocks filling in the forms, but each
is a fact the answers assume.

1. **Whether the Supabase project is accepting anonymous sign-ups right now.**
   `docs/DECISIONS.md` refers to "the now-provisioned Supabase project", and the
   client carries a real project URL and publishable key — so the declarations
   are written as though transmission happens, which is the conservative and
   correct posture for shipped code. But anonymous sign-in is a project setting
   that cannot be read from this repo; if it is disabled,
   `app.js:ensureAnonSession()` returns null and events buffer locally forever.
   **Verify in the Supabase dashboard.** This changes nothing about what to
   declare — the code attempts it — but it changes whether rows exist today.
2. **Whether the RLS policies are live and verified.** ADR-0005's own Risks
   section says they were "written to spec but **not yet verified against a live
   project**". They live in `backend/migrations/supabase/0001_auth_and_rls.sql`,
   which the migration runner deliberately does **not** auto-apply — it globs only
   top-level `migrations/*.sql`, so they must be run by hand in the Supabase SQL
   editor. Nothing in the repo records whether that was done. The per-user
   isolation claim in policy §3 depends entirely on it. **Verify before any real
   user data lands.** (Weak circumstantial evidence that migrations generally have
   not all been pushed: `0014` in the *portable* set is recorded as not applied in
   `docs/DECISIONS.md`. Different directory and different series — it says nothing
   about RLS directly.)
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
