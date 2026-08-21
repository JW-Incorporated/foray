# 4a — Privacy Policy

**Status: DRAFT — not yet published, not yet reviewed by a lawyer.**
Every `TODO(founder)` below is a fact only a founder can supply. Do not publish
this to a store listing with any of them unresolved.

Last updated: 2026-08-19 · Applies to: the **4a** web app
(https://jw-incorporated.github.io/foray/) and the iOS/Android app built from the
same code. The app was formerly Foray. That is why the word is still in this URL
and in the names of the local database and the cache bucket §1 describes:
renaming the database would orphan data already on your device, and renaming the
other two would break saved links and make every listener re-download the app
shell, for no benefit to you. Separately, a "foray" is what the app calls one
assembled run of segments — that is the sense the `cp_foray:` keys in §1 use,
and it is unchanged.

This document was written by reading the shipped code, not from a template.
Every claim below has a file and line reference in
[`data-safety.md`](./data-safety.md), which answers Google Play's and Apple's
declaration forms question by question. If you change what the app collects,
change both files in the same PR.

---

## The short version

4a is a podcast curator. It picks episodes and assembles them into a "foray" —
an ordered run of segments drawn from real podcast episodes.

- **Most of what 4a knows about you never leaves your device.** Your topic
  interests, your play positions, your history, your playlists and your settings
  are stored locally and are not transmitted.
- **Five kinds of event are sent to our database**: which episode you picked,
  which you finished, which you saved, your thumbs up/down feedback (including
  any note you type), and the fact that a session was shown to you. They are
  stored against an anonymous account that contains no name, email or phone
  number.
- **Audio plays straight from each publisher's own servers.** We never rehost or
  proxy podcast audio. That means the publisher — and the measurement or
  ad-attribution services the publisher has put in front of their own audio —
  sees your IP address and your app/browser user-agent directly. **We never see
  it.** This is the most important thing to understand about how 4a works, and
  §4 explains it properly, including who those third parties actually are.
- **4a itself contains no advertising, ad tracking, analytics SDK or crash
  reporter.** There is no third-party SDK in the app at all. That is a statement
  about our code, not a claim that nobody observes your playback — see §4.
- **We do not sell or share your data**, and we do not track you across other
  companies' apps or websites.
- **You can delete all of it from inside the app** — the menu's **Delete my
  data**. It clears both storage layers on your device and deletes your rows on
  our server, and it tells you if it could not. §7 is exact about what it reaches
  and what it cannot.

---

## 1. What stays on your device

4a keeps its state under keys beginning `cp_`. **Nearly every key is written to
two places on your device**: `localStorage` and an IndexedDB database (name
`foray`, object store `kv`). The second copy exists because browsers evict
`localStorage` — Safari clears script-writable storage after about seven days
without a visit — and losing it would silently orphan your profile.
`localStorage` is kept as a mirror, not a staging area; nothing is deleted to
migrate it. (`player/durable-store.js`, `player/idb-tier.js`.)

Two honest qualifications to "two places". The diagnostic record
`cp_storage_health` is deliberately **never** written to IndexedDB — a failing
durable write is exactly what it records, so queueing it there could make the
diagnostic the outage (`player/durable-store.js:_recordHealth()` mirrors the
record into the synchronous tiers only). And until the player module has loaded,
writes go to plain `localStorage` only; if that module fails to load, they stay
there for the session (`app.js:storageBackend()`).

**Two of these keys are diagnostics rather than your data**, and neither is
transmitted. `cp_storage_health` records storage failures. `cp_diag` records how
the audio player behaved — see its row below — and exists because two playback
faults were reported from a car with no measurements attached, so there was
nothing to diagnose them with. It is capped, the oldest entries are dropped
first, and the drawer's **Playback diagnostics** is where you read it, copy it or
clear it (`player/diagnostic-log.js`).

The app also asks the browser to mark its storage as persistent
(`navigator.storage.persist()`), and records the answer rather than assuming it.

| Key | What it holds | Does it leave your device? |
|---|---|---|
| `cp_interests` | A weight from 0 to 1 for each topic in the taxonomy — the learned interest profile | **No** |
| `cp_history` | The last 200 episode ids you picked or played in the app | **No** (but see `picked` in §2) |
| `cp_seen` | Episode ids already shown to you, so they are not repeated | **No** |
| `cp_saved` | The episodes you saved | **No** (but see `saved` in §2) |
| `cp_lastpick` | A snapshot of the last episode you picked | **No** (but marking it Done sends `finished` — §2) |
| `cp_playlists` | Playlists you built, including the text you typed to build them. Since 2026-08-19 each part also keeps a copy of the episode's own details — its id, title, show name, length, Apple Podcasts ids and topic ids — so a playlist still lists what is in it after the episode leaves 4a's catalogue. It deliberately does **not** copy the audio URL or the artwork URL | **No** |
| `cp_quests` | A legacy key, migrated once into `cp_playlists` | **No** |
| `cp_recent_branches` | Which topic branches you recently came from | **No** |
| `cp_foray:<id>` | Where you are inside a given foray, and which segment you were in | **No** |
| `cp_pos:<id>` | Your position in seconds inside an individual episode | **No** |
| `cp_rate` | Your playback speed | **No** |
| `cp_player` | Which external podcast app you prefer to open episodes in | **No** |
| `cp_family` | Family mode on/off — a local content filter that hides explicit-rated episodes | **No** |
| `cp_intro_dismissed` | Whether you dismissed the intro card | **No** |
| `cp_foray_feedback` | Your per-segment thumbs: direction, reason codes, any note you typed, timestamp | **Yes, via `thumbs`** — see §2 |
| `cp_events` | A rolling buffer of the last 5,000 events | **Partly** — 5 of the 18 event types are sent; see §2 |
| `cp_synced_ts` | A bookmark recording which events have already been sent | **No** |
| `cp_profile_id` | A random local id (e.g. `p-a1b2c3d4...`) generated on this device | **No** — it is stamped on local events but is **not** included in anything sent |
| `cp_sb_session` | The access and refresh token for your anonymous account, and its user id | It **is** your credential for our database — see §3 |
| `cp_storage_health` | A diagnostic record of storage failures, for troubleshooting | **No** |
| `cp_diag` | A playback diagnostic record, capped at the most recent 200 entries: how long each seam between two segments took, the load deadline in force, out-point overshoot, stops (a lost audio route, an interruption), which resume point was written and read back, when the app went to the background and for how long, and any press of a play or transport control that failed — with the *class* of the error (for example `NotAllowedError`, meaning your browser held the audio back), never its message, and with a count when the same press fails repeatedly. It holds no audio, no URLs, no account id and no device names — when it records that a known audio route came back, it records only *that* one was recognised, never which | **No** — it is never transmitted; the drawer's **Playback diagnostics** shows it and lets you copy or clear it |

The web app also keeps a Cache Storage bucket named `foray-v5` holding the app
shell and the catalogue JSON files, so the app renders in a dead zone (`sw.js`).
**It never caches podcast audio**, because the service worker ignores every
request that is not to our own origin.

## 2. What leaves your device, exactly

The app buffers events locally and periodically sends some of them to our
database (Supabase — see §3). **Thirteen of the eighteen event types the app
records never leave the device.** The buffer is trimmed to the most recent 5,000
entries.

**Sent** (`app.js:toEventRow()`). Every row carries your anonymous account id
and a timestamp:

| Event | Fields sent |
|---|---|
| `picked` | Episode slug, its topic ids, an `app` label, and a context label. See the note below — both labels carry less about you than their names suggest |
| `finished` | Episode slug, topic ids, and a completion marker. Marked `manual_stopgap` because on the web you press Done — the app cannot observe real playback in an external app |
| `saved` | Episode slug, topic ids |
| `thumbs` | Up or down; the taxonomy node it applies to; optionally the episode slug, segment id and foray id; the reason codes you selected; **and the free-text note you typed** (a single line, up to 200 characters) |
| `session_shown` → stored as `session_built` | A session key and which builder produced it |

**Not sent — recorded only on your device:** `play_started`, `position` (your play
position; stored about every 15 seconds, recorded as an event at most once a
minute per episode — `player/position-store.js:save()`), `foray_play`,
`foray_restart`, `foray_progress_drift`, `source_opened`, `saved`'s counterpart
`unsaved`, `playlist_built`, `playlist_removed`, `player_pref`, `family_mode`,
`refreshed_all`, `storage_fault`.

**The `picked` row's two labels are narrower than they sound**, and we would
rather say so than let the field names imply more collection than happens:

- The **`app` label is a hardcoded constant.** It reads a `data-app` attribute
  that nothing in the app ever sets, so it is always the literal string
  `"Apple Podcasts"` (`app.js:bindPickLogging()`). It does **not** report which
  podcast app you actually use, and your stored preference (`cp_player`) is never
  transmitted.
- The **context label** is filtered against a five-value allowlist
  (`app.js:SB_ARCHETYPES`), but the only values the app ever produces are
  `continue` — you resumed something — or a subject/playlist label that the
  filter discards. So in practice this field is `"continue"` or empty. It does
  not reveal which recommendation archetype you were shown.

Two things worth calling out plainly, because a generic policy would hide them:

- **The note is free text you wrote**, and it is transmitted. Do not type
  anything into it you would not want stored on our server.
- **Two of the fixed thumbs-down reason codes are "Leans too far left" and
  "Leans too far right."** These describe how *the episode* struck you, not your
  own politics, and 4a never asks for your political views. But a record that
  you marked something as too far left or right is a signal about content you
  reacted to, it is transmitted, and you should know that before you use it.

**Nothing you type into the playlist box is transmitted.** That search runs
entirely on your device against files already downloaded
(`search-engine.js`); playlist events are local-only.

## 3. The anonymous account

4a has no signup, no password, no email and no profile. On the first page load
that produces an event, the app asks Supabase — our hosted database provider — to
create an **anonymous account**. Supabase issues a user id and a token, which are
stored in `cp_sb_session` on your device. Every row we store is keyed to that id,
and the database's row-level security means a client holding your token can only
read and write your own rows (`backend/migrations/supabase/0001_auth_and_rls.sql`).

That account contains **no name, no email address, no phone number and no
password**. It is an opaque identifier. If you clear the app's storage, the token
is gone and the app creates a new anonymous account the next time it needs one —
the old rows remain but nothing on your device points to them any more.

**That is exactly why the delete control in §7 deletes the rows first and the
token second.** It also cuts the link deliberately: after a deletion the app
starts a new anonymous account rather than re-attaching you to the old one. The
old account row itself stays, because removing it needs an administrative key we
do not ship in a public web page — §7 says so plainly.

Because it is an ordinary network request, **Supabase necessarily observes the IP
address it came from**, as any server does.

> TODO(founder): the Supabase project's **region / hosting jurisdiction**, and
> whether a data-processing agreement is in place. Needed for the policy to state
> where data is stored, and required if EU users are in scope.

> TODO(founder): **how long event rows are retained.** ADR-0005 anticipates a
> retention job pruning stale anonymous ids with no events; it is not built. The
> policy cannot state a retention period until one is chosen.

## 4. What your device contacts directly — and we never see

**This is the most important thing about how 4a is built, and it cuts both
ways.**

Product principle 3 says we never rehost, proxy or transform episode audio. The
app honours that literally: it sets an `<audio>` element's `src` to the
publisher's own enclosure URL and plays it
(`player/html-audio-backend.js:load()`). There is no 4a server in the path.

The upside is real: **we cannot build a listening profile out of your audio
requests, because they never touch us.** The corresponding disclosure is equally
real: **your device talks straight to the publisher's host, so that host sees
your IP address, your user-agent, and which episode you requested, at the time
you requested it.** What they do with it is governed by their privacy policy, not
ours.

### 4.1 How many parties, and who they are

As of 2026-08-17 the catalogue the app downloads points at **43 distinct hosts**
for audio, across the three data files the app fetches on load
(`data/segment-sources.json` — the assembled forays; `data/session.json` — the
home cards; `data/discover.json` — the recommendation pool, ~1,480 playable
items). Anything with a play button plays this way.

```
2.gum.fm  anchor.fm  aphid.fireside.fm  api.substack.com  archive.org
audioboom.com  cdn.simplecast.com  chrt.fm  claritaspod.com  clrtpod.com
content.rss.com  dts.podtrac.com  episodes.captivate.fm  episodes.castos.com
feeds.soundcloud.com  injector.simplecastaudio.com  mcdn.podbean.com
media.blubrry.com  media.transistor.fm  mgln.ai  op3.dev  pdcn.co  pdrl.fm
pdst.fm  pfx.vpixl.com  pinecast.com  podcasts.captivate.fm  podtrac.com
prefix.up.audio  prfx.byspotify.com  pscrb.fm  redirect.zencastr.com
rss.art19.com  s.gum.fm  sphinx.acast.com  static1.squarespace.com
stitcher.simplecastaudio.com  tracking.swap.fm  traffic.libsyn.com
traffic.megaphone.fm  traffic.omny.fm  www.buzzsprout.com  www.podtrac.com
```

This list is **generated from the data files, and it changes when the catalogue
does.** Treat it as accurate for the date above, and regenerate it rather than
editing it by hand.

### 4.2 Many of these are measurement and ad-attribution services

This is the part a template would never tell you, and it is the honest reason
this section is long.

A publisher typically does not point at their audio file directly. They put one
or more **prefix services** in front of it, each of which logs the request and
then redirects to the next. Your device follows every hop, so **each one sees
your IP address and user-agent.** A real URL from our own catalogue:

```
https://2.gum.fm/op3.dev/e/pdcn.co/e/pdst.fm/e/dts.podtrac.com/redirect.mp3/media.transistor.fm/…
```

That is **five** intermediaries before the audio. Another:
`mgln.ai/e/1143/media.blubrry.com/content.blubrry.com/…`.

Some of these prefixes count downloads (`podtrac.com`, `op3.dev`). **Others are
advertising-attribution services** whose purpose is to connect a podcast
impression to later behaviour — `pdst.fm`, `pdcn.co` and `pdrl.fm` (Podsights),
`chrt.fm` (Chartable), `pscrb.fm` (Podscribe), `claritaspod.com` and
`clrtpod.com` (Claritas), `prfx.byspotify.com`, `tracking.swap.fm`,
`pfx.vpixl.com`, and the `gum.fm` hosts.

**We want to be exact about what that does and does not mean.**

- These services are in the path because **the publisher put them there**, as
  part of the enclosure URL published in their RSS feed. We do not add them, we
  have no account or contract with any of them, we send them nothing, and we
  receive nothing back. They measure for the publisher and their advertisers, not
  for us.
- So when §5 says the app does not use ad tracking, that is true of 4a: there is
  no ad code, no ad identifier and no ad SDK in this app. It is **not** a claim
  that no advertising-related party ever observes your playback request — because
  once you play an episode from its own source, some do.
- The alternative would be to proxy audio through our own servers, which would
  hide you from the publisher and expose your entire listening behaviour to
  **us** instead. We deliberately do not do that (product principle 3). We think
  the trade is the right one, and you should know it is a trade.

Because every hop is a redirect decided at request time, **we cannot enumerate
the full chain in advance** — the list in §4.1 is the first hop of each URL, and
the real chain can be longer.

### 4.3 Artwork, and the page itself

The app also loads **cover artwork over HTTPS from publisher and Apple-hosted
image URLs**, which reveals the same kind of request metadata to those hosts.

Finally, the web app is served from **GitHub Pages**, so GitHub serves the page
and the catalogue files and sees those requests. In the native app the shell and
catalogue are bundled, so this does not apply there.

## 5. What 4a does not do

Verified by reading the client, not by assertion. The app's Content Security
Policy (`index.html`) is the structural reason most of this list is not merely
a promise: **`connect-src` names only two origins** — the app's own, and our
Supabase project — so any data-sending request of the kind an API call, an
analytics beacon or a crash report needs is blocked by the browser unless the
policy is changed in code.

To be precise rather than flattering: the same policy also allows `img-src https:`
and `media-src https:`, which is *any* HTTPS host. That is exactly how §4's audio
and artwork work, and it means the CSP is not a total network seal. It is a tight
bound on the channel that would carry data *out*.

- **No advertising and no ad tracking.** No ad SDK, no ad identifier, no IDFA
  prompt.
- **No analytics or product-measurement service.** No Google Analytics,
  Firebase, Amplitude, Mixpanel, Sentry or equivalent.
- **No crash reporting.**
- **No third-party SDKs of any kind**, and no bundled libraries that phone home.
- **No location access, no camera, no microphone, no contacts, no calendar, no
  photos, no notifications.** The app requests no device permissions. There is no
  call to `geolocation`, `getUserMedia` or the contacts APIs anywhere in the
  client.
- **No device fingerprinting.** We do not collect a device id, advertising id,
  screen size, timezone or language list.
- **No sale of data, and no sharing for anyone else's advertising.**
- **Nothing you do is sent to an AI provider.** 4a uses AI in its own build
  pipeline to classify public podcast metadata and write recommendation copy. That
  runs on our machines against public feed data, **not on your data**. The app
  itself makes no AI API call, and `connect-src` would block one.
  - For completeness, because it is the likeliest way this could change: the
    build pipeline *has* a code path that could include listener-derived interest
    labels in a prompt, and today it is not wired up — it runs against a fixed
    placeholder id with no database connection
    (`backend/src/cli/buildSession.ts`, and `docs/DECISIONS.md` records the
    decision not to stand it up). If that changes, this sentence changes with it;
    see `data-safety.md` § What would change these answers.

## 6. Children

4a is a general-audience podcast app and is not directed to children. We do
not ask for, or knowingly collect, anyone's age. "Family mode" is only a local
content filter that hides explicit-rated episodes — it collects nothing and sends
nothing.

> TODO(founder): the **target age rating** to declare in each store, and whether
> to opt in to Google Play's Families policy. This is a listing decision, not a
> code fact.

## 7. How to delete your data

**Use the button.** Open the menu (☰) and choose **Delete my data**. The sheet
lists what the deletion covers, and you confirm by typing `DELETE` (capitals
optional) — one stray tap cannot trigger it.

**What it deletes:**

- **Everything on this device.** Every `cp_` key in §1, in **both** places they
  are kept: `localStorage` and the IndexedDB database `foray`. The control
  enumerates the two stores and then re-reads them to check they are empty, so a
  key added to the app in future is covered without anyone updating a list. If
  either store refuses, or cannot be read to confirm, **the app tells you the
  device is not fully clear** rather than claiming it is.
- **Your rows on our server.** One authenticated `DELETE` per per-user table,
  filtered to your own account id — the `events` rows in §2 (including any note
  you typed), the account's own `app_users` row, and the other per-user tables the
  database defines, whether or not they hold anything of yours. Row-level security
  means the request can only ever reach your rows.

**What it deletes in what order, and why that matters.** The server rows go
first. Your token (`cp_sb_session`) is the only thing that can reach them, and
clearing your device destroys it — so if the server cannot be reached, **the app
tells you your rows were not deleted and leaves your device untouched** so you
can try again. It will not report success for something it did not do. (If you
would rather clear this device anyway, the sheet offers that as a separate
choice, and says plainly that the server rows remain.)

**What it cannot delete, stated rather than implied:**

- **The anonymous account row itself.** Deleting a Supabase auth user requires an
  administrative key, which cannot ship inside a public web page. So the row
  remains — with no name, email, phone number or password, and, after the
  deletion, with no rows attached to it. What the button does do is **cut the
  link**: your token and local id are deleted with everything else, so the app
  creates a **new** anonymous account the next time it needs one rather than
  re-attaching you to the old one. We are pursuing a server-side path to remove
  the empty account row as well.
- **Anything the publisher and their measurement services already saw.** §4 is
  the detail: playing audio revealed your IP address and user-agent to the
  publisher's host and to any prefix services in front of it. **We never received
  that data and cannot delete it.** Their privacy policies govern it, not ours.
- **Rows sent from a device whose storage you had already cleared.** Without that
  token the account cannot be identified, so those rows cannot be reached — by
  you or by us. This is the cost of having no signup, and it is the reason to use
  the button rather than the browser's site-data screen.

**Clearing site data still works** and is the belt to this braces — in your
browser's settings for the origin the web app is served from,
`jw-incorporated.github.io` (web), or by deleting the app (iOS / Android). It
removes the local copies but **not** the server rows, for the reason in the
paragraph above.

The `foray-v5` Cache Storage bucket is not touched by the button: it holds the
app shell and the catalogue files (§1), which are the same for every listener and
say nothing about you.

> TODO(founder): publish a **data-deletion URL** for the store listings. The
> in-app control answers Play's "can users request deletion" question, but the
> form also wants a public web page describing it — see `data-safety.md` § A8.

## 8. Changes to this policy

If the app starts collecting something new, this document and
[`data-safety.md`](./data-safety.md) must be updated **in the same change**, and
the store declarations resubmitted. `data-safety.md` § "What would change these
answers" lists the specific changes that would invalidate a published
declaration.

## 9. Who we are, and how to reach us

> TODO(founder): the **legal entity name** to name as data controller.

> TODO(founder): a **privacy contact address**. Both stores require a working
> contact; Google Play's Data Safety form requires a privacy policy URL, and
> Apple requires one in App Store Connect. No address is invented here.

> TODO(founder): where this policy will be **publicly hosted** (a store listing
> needs a URL, not a file in a repo), and its **effective date**.

> TODO(founder): the **geo-availability decision** — US-only listing versus
> accepting GDPR obligations from day one. `docs/marketing/05-legal-risk-memo.md`
> §5 sets out the trade; it is unresolved, and it changes what this policy must
> promise (access, portability, erasure, a lawful basis).

> TODO(founder): **legal review.** This draft is written from the code by an
> engineer, not a lawyer. It is accurate about behaviour; it is not a
> professional opinion about sufficiency under any particular law.
