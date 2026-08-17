# Foray — Privacy Policy

**Status: DRAFT — not yet published, not yet reviewed by a lawyer.**
Every `TODO(founder)` below is a fact only a founder can supply. Do not publish
this to a store listing with any of them unresolved.

Last updated: 2026-08-17 · Applies to: the Foray web app
(https://jw-incorporated.github.io/foray/) and the iOS/Android app built from the
same code.

This document was written by reading the shipped code, not from a template.
Every claim below has a file and line reference in
[`data-safety.md`](./data-safety.md), which answers Google Play's and Apple's
declaration forms question by question. If you change what the app collects,
change both files in the same PR.

---

## The short version

Foray is a podcast curator. It picks episodes and assembles them into a "Foray" —
an ordered run of segments drawn from real podcast episodes.

- **Most of what Foray knows about you never leaves your device.** Your topic
  interests, your play positions, your history, your playlists and your settings
  are stored locally and are not transmitted.
- **Five kinds of event are sent to our database**: which episode you picked,
  which you finished, which you saved, your thumbs up/down feedback (including
  any note you type), and the fact that a session was shown to you. They are
  stored against an anonymous account that contains no name, email or phone
  number.
- **Audio plays straight from each publisher's own servers.** We never rehost or
  proxy podcast audio. That means the publisher — and the download-measurement
  service they use — sees your IP address and your app/browser user-agent
  directly. **We never see it.**
- **We do not use advertising, ad tracking, analytics SDKs, or crash reporters.**
  There is no third-party SDK in the app at all.
- **We do not sell or share your data**, and we do not track you across other
  companies' apps or websites.

---

## 1. What stays on your device

Foray keeps its state under keys beginning `cp_`. **Each key is written to two
places on your device**: `localStorage` and an IndexedDB database (name `foray`,
object store `kv`). The second copy exists because browsers evict `localStorage`
— Safari clears script-writable storage after about seven days without a visit —
and losing it would silently orphan your profile. `localStorage` is kept as a
mirror, not a staging area; nothing is deleted to migrate it.
(`player/durable-store.js`, `player/idb-tier.js`.)

The app also asks the browser to mark its storage as persistent
(`navigator.storage.persist()`), and records the answer rather than assuming it.

| Key | What it holds | Does it leave your device? |
|---|---|---|
| `cp_interests` | A weight from 0 to 1 for each topic in the taxonomy — the learned interest profile | **No** |
| `cp_history` | The last 200 episode ids you picked | **No** (but see `picked` in §2) |
| `cp_seen` | Episode ids already shown to you, so they are not repeated | **No** |
| `cp_saved` | The episodes you saved | **No** (but see `saved` in §2) |
| `cp_lastpick` | A snapshot of the last episode you picked | **No** |
| `cp_playlists` | Playlists you built, including the text you typed to build them | **No** |
| `cp_quests` | A legacy key, migrated once into `cp_playlists` | **No** |
| `cp_recent_branches` | Which topic branches you recently came from | **No** |
| `cp_foray:<id>` | Where you are inside a given Foray, and which segment you were in | **No** |
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

The web app also keeps a Cache Storage bucket named `foray-v4` holding the app
shell and the catalogue JSON files, so the app renders in a dead zone (`sw.js`).
**It never caches podcast audio**, because the service worker ignores every
request that is not to our own origin.

## 2. What leaves your device, exactly

The app buffers events locally and periodically sends some of them to our
database (Supabase — see §3). **Thirteen of the eighteen event types the app
records never leave the device.** The buffer is trimmed to the most recent 5,000
entries.

**Sent** (`toEventRow`, `app.js:220–256`). Every row carries your anonymous
account id and a timestamp:

| Event | Fields sent |
|---|---|
| `picked` | Episode slug, its topic ids, which external app you opened it in, and which of the four menu archetypes it came from |
| `finished` | Episode slug, topic ids, and a completion marker. Marked `manual_stopgap` because on the web you press Done — the app cannot observe real playback in an external app |
| `saved` | Episode slug, topic ids |
| `thumbs` | Up or down; the taxonomy node it applies to; optionally the episode slug, segment id and Foray id; the reason codes you selected; **and the free-text note you typed** (a single line, up to 200 characters) |
| `session_shown` → stored as `session_built` | A session key and which builder produced it |

**Not sent — recorded only on your device:** `play_started`, `position` (your
play position, written every 15 seconds), `foray_play`, `foray_restart`,
`foray_progress_drift`, `source_opened`, `saved`'s counterpart `unsaved`,
`playlist_built`, `playlist_removed`, `player_pref`, `family_mode`,
`refreshed_all`, `storage_fault`.

Two things worth calling out plainly, because a generic policy would hide them:

- **The note is free text you wrote**, and it is transmitted. Do not type
  anything into it you would not want stored on our server.
- **Two of the fixed thumbs-down reason codes are "Leans too far left" and
  "Leans too far right."** These describe how *the episode* struck you, not your
  own politics, and Foray never asks for your political views. But a record that
  you marked something as too far left or right is a signal about content you
  reacted to, it is transmitted, and you should know that before you use it.

**Nothing you type into the playlist box is transmitted.** That search runs
entirely on your device against files already downloaded
(`search-engine.js`); playlist events are local-only.

## 3. The anonymous account

Foray has no signup, no password, no email and no profile. On the first page load
that produces an event, the app asks Supabase — our hosted database provider — to
create an **anonymous account**. Supabase issues a user id and a token, which are
stored in `cp_sb_session` on your device. Every row we store is keyed to that id,
and the database's row-level security means a client holding your token can only
read and write your own rows (`backend/migrations/supabase/0001_auth_and_rls.sql`).

That account contains **no name, no email address, no phone number and no
password**. It is an opaque identifier. If you clear the app's storage, the token
is gone and the app creates a new anonymous account the next time it needs one —
the old rows remain but nothing on your device points to them any more.

Because it is an ordinary network request, **Supabase necessarily observes the IP
address it came from**, as any server does.

> TODO(founder): the Supabase project's **region / hosting jurisdiction**, and
> whether a data-processing agreement is in place. Needed for the policy to state
> where data is stored, and required if EU users are in scope.

> TODO(founder): **how long event rows are retained.** ADR-0005 anticipates a
> retention job pruning stale anonymous ids with no events; it is not built. The
> policy cannot state a retention period until one is chosen.

## 4. What your device contacts directly — and we never see

**This is the most important thing about how Foray is built, and it cuts both
ways.**

Product principle 3 says we never rehost, proxy or transform episode audio. The
app honours that literally: it sets an `<audio>` element's `src` to the
publisher's own enclosure URL and plays it
(`player/html-audio-backend.js:410`). There is no Foray server in the path.

The upside is real: **we cannot build a listening profile out of your audio
requests, because they never touch us.** The corresponding disclosure is equally
real: **your device talks straight to the publisher's host, so that host sees
your IP address, your user-agent, and which episode you requested, at the time
you requested it.** What they do with it is governed by their privacy policy, not
ours.

Hosts the currently-shipped Forays stream from
(`data/segment-sources.json`):

`traffic.libsyn.com` · `dts.podtrac.com` · `mgln.ai` · `www.buzzsprout.com` ·
`content.rss.com` · `anchor.fm` · `media.transistor.fm` · `media.blubrry.com` ·
`2.gum.fm`

Several of these are **podcast download-measurement services** — `dts.podtrac.com`,
`mgln.ai` and `2.gum.fm` are prefix/redirect services a publisher puts in front
of their audio to count downloads. Requesting the audio means passing through
them. They measure on the **publisher's** behalf: we have no account with them,
send them nothing, and receive nothing back. This list will change as the
catalogue grows; it is a snapshot, not a closed set.

The app also loads **cover artwork over HTTPS from publisher and Apple-hosted
image URLs**, which reveals the same kind of request metadata to those hosts.

Finally, the web app is served from **GitHub Pages**, so GitHub serves the page
and the catalogue files and sees those requests. In the native app the shell and
catalogue are bundled, so this does not apply there.

## 5. What Foray does not do

Verified by reading the client, not by assertion. The app's Content Security
Policy (`index.html:13`) permits network connections to exactly two places: its
own origin, and our Supabase project. Anything else is blocked by the browser.

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
- **Nothing you do is sent to an AI provider.** Foray uses AI in its own
  build pipeline to classify public podcast metadata and write recommendation
  copy. That runs on our machines against public feed data, **not on your data
  and not from your device**; the app itself makes no AI API call, and the CSP
  could not permit one.

## 6. Children

Foray is a general-audience podcast app and is not directed to children. We do
not ask for, or knowingly collect, anyone's age. "Family mode" is only a local
content filter that hides explicit-rated episodes — it collects nothing and sends
nothing.

> TODO(founder): the **target age rating** to declare in each store, and whether
> to opt in to Google Play's Families policy. This is a listing decision, not a
> code fact.

## 7. How to delete your data

**On your device.** Everything in §1 is cleared by clearing the app's site data.
There is currently **no in-app "clear my data" button** — this is an honest gap,
not an omission from this document.

- **Web:** clear site data for the Foray origin in your browser's settings. This
  removes all `cp_` keys from `localStorage`, the IndexedDB database `foray`, and
  the `foray-v4` cache.
- **iOS / Android app:** deleting the app removes its local storage.

**On our server.** Clearing local storage discards your token, which stops the
app writing anything further — but it does **not** delete rows already sent, and
because the account is anonymous, a lost token cannot be recovered to reach them.

The database policy is already permissive enough for a client to delete its own
rows (the row-level-security policy is `for all`, covering delete), so this is a
missing feature rather than a missing capability.

> TODO(founder): **decide whether to build a delete path**, and publish a data
> deletion URL. Google Play's Data Safety form asks whether users can request
> deletion and wants a URL; answering "yes" today would be false. See
> `data-safety.md` § Security practices.

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
