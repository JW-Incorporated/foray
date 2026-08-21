# Feature-level product review — what must exist, what's worth adding

*Marketing round 2, desk 09. 2026-07-08. Grounded in what's actually shipped (app.js v3: 4-card menu, splatter with 30% exploration floor, series builder, search, stars, continue card, interests sliders, external playback handoff, PWA manifest) and verified 2026 competitor feature sets. Product principles supersede everything below. Does not re-argue 00/08; extends them.*

> **Name change since this memo — 2026-08-21.** The product is now **4a**
> (founder instruction; #302). Two passages below are copy meant to be published
> and have been updated to say so: the first-visit explainer card in §4 and the
> App Store listing draft in §5. The analysis prose everywhere else in this file
> still says "Foray" and is deliberately left as the July 2026 record. The
> stitched-audio unit the app assembles is still called a `foray`.

---

## 0. Watchlist alert first — two competitors moved into adjacent lanes this year

Before the matrix: two 2026 shipments are close enough to Foray's lane that they must be logged against the pre-committed R10 triggers.

1. **Spotify Prompted Playlists now include podcasts** (April 2026): type "interviews with founders who failed and rebuilt," get episodes from the whole catalog ([Spotify newsroom](https://newsroom.spotify.com/2026-04-07/prompted-playlist-for-podcasts-launch/), [MakeUseOf](https://www.makeuseof.com/spotifys-prompted-playlists-podcast-expansion/)). This is R12's series builder, at Spotify scale. Spotify also shipped **Studio**, a desktop app generating *synthetic* personal podcasts and daily briefings ([MacRumors](https://www.macrumors.com/2026/05/08/spotify-personal-podcasts-ai-agent/), [Digital Trends](https://www.digitaltrends.com/computing/spotifys-new-ai-app-can-generate-daily-briefings-and-personalized-podcasts-for-you/)) — generation, not curation, exactly the lane 01 predicted the AI wave would stay in.
2. **Snipd shipped "AI DJ"** (2026): curated *clips* from your subscribed shows, stitched with intros and segues, pitched as "get through an episode in 25% of the time"; roadmap includes a personalized agent and natural-language steering ([Snipd features](https://www.snipd.com/all-features), [AI for Founders interview](https://aiforfounders.co/podcast/podcast-dj-the-cliff-notes-for-your-podcast-queue)). This is the 01 watchlist item "Snipd ships anything resembling a daily menu" — partially tripped.

**Verdict against R10's pre-committed triggers: neither fires.** Spotify still doesn't honor negative feedback (its prompted playlists draw on the same one-way signal stack 01 documented); Apple shipped no drive/commute mode. Snipd's DJ unit is *clips of shows you already subscribe to* — compression of the known, not explained expansion into the unknown, and clip formats are the graveyard's most reliable death. No demoralization, no pivot. But both raise the bar for R12: Foray's series assembly must beat a prompted playlist on the two axes Spotify structurally can't do — **pedagogical ordering** and **stated reasons** — or it's a worse version of a free feature. Logged as R13 below.

---

## 1. Feature matrix — Foray today vs the field (verified July 2026)

### 1.1 What "Foray today" means in this table

The shipped web client (app.js v3), audited this morning:

- Four-card daily menu spanning four distinct topic branches, interests-weighted with jitter, per-slot "show me something different" and full re-deal
- Hand-written why-lines on curated picks (automated builder pending R1)
- The splatter: 12-item discovery surface with a hard 30% exploration floor and labeled wildcards
- Free-text series builder v1 (keyword+alias scoring, persisted quests with progress numbering)
- Search over the local pool; stars that feed the interest weights; saved shelf
- Continue card (last unfinished pick pins to top, 72h window, "done" button)
- Interests sliders (tune-the-splatter panel), taxonomy-driven
- External playback handoff: Apple Podcasts / Overcast / pod.link buttons, never hosts audio
- PWA manifest + apple-touch meta, but **no service worker** — offline currently white-screens
- 5000-event localStorage telemetry buffer with `builder` field (R1/R2 infrastructure)

### 1.2 Where the field moved in 2026 (one line each)

- **Overcast**: shipped transcripts in v2026.04, including for private/member feeds; AI summaries and auto-chapters on the public roadmap ([9to5Mac](https://9to5mac.com/2026/04/08/overcast-launches-podcast-transcripts-in-new-app-update-for-iphone/)). Still the Smart Speed / Voice Boost quality benchmark.
- **Pocket Casts**: playlists (its most-requested feature, v8.0), Liquid Glass redesign, CarPlay chapter artwork, tinted widgets, Wear OS speaker playback ([9to5Mac](https://9to5mac.com/2026/07/07/pocket-casts-update-brings-three-new-features-including-carplay-chapter-artwork/), [9to5Google](https://9to5google.com/2026/01/20/pocket-casts-wear-os-speaker/)).
- **Snipd**: AI DJ (curated clips + segues), YouTube import, CarPlay, lock-screen snip, auto-sync to Obsidian ([snipd.com/all-features](https://www.snipd.com/all-features)).
- **Castro**: back from the dead and shipping — cross-device sync, iPad app, major CarPlay updates, first-class sideloading, listening-stats tab ([castro.fm/blog](https://castro.fm/blog)).
- **Apple Podcasts**: iOS 26 brought Enhance Dialogue and 0.5–3× speeds; 26.2 added automatic chapters for all English shows and tappable podcast mentions ([Apple creators page](https://podcasters.apple.com/support/5549-iOS-26-whats-new-for-apple-podcasts), [MacRumors](https://www.macrumors.com/2025/11/04/ios-26-2-podcasts-app-update/)).
- **Spotify**: Prompted Playlists extended to podcasts, DJ in four new languages (94M users), Studio generating synthetic personal podcasts, weekly Listening Stats ([newsroom](https://newsroom.spotify.com/2026-04-07/prompted-playlist-for-podcasts-launch/), [TechCrunch](https://techcrunch.com/2026/05/12/spotify-launches-a-wrapped-style-recap-of-your-entire-listening-history/)).

The pattern across all six: 2026's shipping energy went to *transcripts, chapters, and AI-on-top-of-your-subscriptions*. Nobody moved toward explained episode-level curation of shows you don't follow. The lane 01 called vacant is still vacant; it just has closer neighbors.

### 1.3 The matrix

Sources: [Overcast transcripts, v2026.04](https://9to5mac.com/2026/04/08/overcast-launches-podcast-transcripts-in-new-app-update-for-iphone/) · [Pocket Casts 8.15 & June/July 2026 updates](https://9to5mac.com/2026/07/07/pocket-casts-update-brings-three-new-features-including-carplay-chapter-artwork/) · [Pocket Casts Wear OS speaker playback](https://9to5google.com/2026/01/20/pocket-casts-wear-os-speaker/) · [Snipd 2026 feature set](https://www.snipd.com/all-features) · [Castro 2026 releases: sync, iPad, CarPlay, sideloading](https://castro.fm/blog) · [Apple Podcasts iOS 26 / 26.2: Enhance Dialogue, 0.5–3× speeds, auto-chapters, podcast mentions](https://podcasters.apple.com/support/5549-iOS-26-whats-new-for-apple-podcasts), [MacRumors on 26.2](https://www.macrumors.com/2025/11/04/ios-26-2-podcasts-app-update/) · [Spotify Listening Stats](https://www.techtimes.com/articles/312576/20251108/spotify-expands-wrapped-like-stats-sharing-feature-friends-via-social-media-platforms.htm).

| Capability | Foray today (web) | Overcast | Pocket Casts | Snipd | Castro | Apple | Spotify | Class for Foray |
|---|---|---|---|---|---|---|---|---|
| Explained, episode-level daily menu | ✅ 4 cards + why-lines | — | — | clips only (DJ) | — | — | — | **DIFFERENTIATOR** (the product) |
| Bounded session, no autoplay/infinite feed | ✅ by construction | — | — | — | — | — | — | **DIFFERENTIATOR** (trust claim) |
| Exploration floor / anti-echo-chamber | ✅ 30% hard floor | — | — | — | — | — | — | **DIFFERENTIATOR** |
| Free-text series assembly | ✅ v1 keyword; semantic pending key | — | — | — | — | — | ✅ Prompted Playlists | **DIFFERENTIATOR — now contested** |
| Queue / up-next management | ⚠️ continue card only | ✅ | ✅ (+playlists v8.0) | ✅ | ✅ (inbox triage) | ✅ | ✅ | **TABLE-STAKES** (iOS v1, session-scoped) |
| Native playback + downloads/offline | ❌ handoff by design | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **TABLE-STAKES** (iOS v1; correct absence on web) |
| Speed control 0.5–3× | ❌ (n/a on web) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **TABLE-STAKES** (iOS v1) |
| Sleep timer | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **TABLE-STAKES** (iOS v1) |
| Silence trim / voice processing | ❌ | ✅ Smart Speed, Voice Boost | ✅ | — | ✅ Plus | ✅ Enhance Dialogue | — | **LATER** (M4+, quality bar high) |
| Chapters | ❌ | ✅ | ✅ | ✅ AI | ✅ Plus | ✅ auto (26.2) | partial | **TABLE-STAKES** (iOS v1; also feeds R11 intro-skip) |
| Transcripts (user-facing) | ❌ (pipeline-internal only) | ✅ 2026.04 | partial | ✅ core | — | ✅ | partial, no export | **LATER** — near-table-stakes by 2027 |
| Highlights / notes export (Obsidian etc.) | ❌ | — | — | ✅ core | — | — | — | **IRRELEVANT** (Snipd's lane) |
| Episode search | ✅ pool-scoped | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | TABLE-STAKES — present |
| Show-level discovery/browse | ✅ splatter | minimal | ✅ | ✅ | Pod Seek | ✅ "New" tab | ✅ | Present, differentiated |
| CarPlay / Android Auto | ❌ | ✅ | ✅ (+chapter art 7/26) | ✅ new 2026 | ✅ major 2026 update | ✅ | ✅ | **TABLE-STAKES for the wedge** (M6; entitlement early per 05) |
| Watch app | ❌ | ✅ | ✅ (+speaker playback) | — | — | ✅ | ✅ | **IRRELEVANT** for now |
| Widgets / Live Activities | ❌ | ✅ | ✅ (tinted, 6/26) | ✅ lock-screen | ✅ | ✅ | ✅ | LATER (M4) |
| OPML import/export | ❌ | ✅ | ✅ | ✅ | ✅ | — | — | **TABLE-STAKES at multi-user** (R9 stands) |
| Sharing episodes/clips | ❌ | ✅ clips | ✅ | ✅ snips | ✅ | ✅ | ✅ | **TABLE-STAKES** — gap, see §3.1 |
| Stats / year-in-review | ❌ (events logged) | minimal | ✅ Year in Podcasts | ✅ | ✅ stats tab | — | ✅ Wrapped + weekly | LATER — see §3.2 |
| Cross-device sync | ❌ localStorage | ✅ | ✅ | ✅ | ✅ new 2026 | ✅ | ✅ | TABLE-STAKES at multi-user (R2 backend implies it) |
| Video podcasts | ❌ | — | — | ✅ YouTube 2026 | — | ✅ Mac PiP (WWDC26) | ✅ | **IRRELEVANT** (audio-first, eyes-busy) |
| Streaks / engagement mechanics | ❌ | — | — | — | — | — | — | **PRINCIPLE-VIOLATION** — absence is the feature |
| Clip feed | ❌ | — | — | ⚠️ DJ adjacent | — | — | — | **PRINCIPLE-VIOLATION** (graveyard) |

Reading: Foray's differentiator rows are still uncontested except series assembly. Its table-stakes gaps are all *player* gaps — which is fine today because the web product deliberately isn't a player, and fatal at iOS v1 if unaddressed, because at iOS v1 Foray *becomes* a player.

## 2. Missing table-stakes — when each is actually needed

The web test phase and iOS v1 have different contracts with the user. On web, playback handoff means Overcast/Apple supply every player table-stake; Foray only owes a credible *menu*. On iOS, Foray plays the audio, and the retention research is unambiguous: playback reliability is the #1 deletion trigger (04), 21% of users abandon after one use, and one bug a day loses half of them ([CleverTap](https://clevertap.com/blog/app-uninstalls/), [Twinr](https://twinr.dev/blogs/why-users-abandon-apps/)).

| Missing table-stake | Web test? | iOS v1 (M3)? | Later? | Reasoning |
|---|---|---|---|---|
| Downloads/offline playback | No — handoff covers it | **Yes, non-negotiable** | — | The M0 audio spike exists for this; guideline 5.2.3 notes per R9 |
| Speed 0.5–3× | No | **Yes** | — | Apple made 3× the baseline in iOS 26; commuters live at 1.5×+ (session.json literally models it) |
| Sleep timer | No | **Yes** | — | ~1 hour of work in AVFoundation; its absence is a one-star review magnet in every competitor forum ([Pocket Casts forums](https://forums.pocketcasts.com/forums/topic/improve-sleep-timer-function/)) |
| Session queue / up-next | No | **Yes, session-scoped** | — | "What plays after this card" must be answerable without a screen. Bounded: the session is the queue; never an infinite Up Next |
| Chapters | No | **Yes (publisher markers)** | auto-chapters later | Prerequisite for R11's "start at first content chapter"; Apple now auto-generates, so absence reads as broken |
| Sharing a pick | **Yes (lite)** | Yes | — | §3.1 — the only table-stake that's also a growth channel |
| OPML import | No | At first multi-user release | ✓ | R9 unchanged; meaningless while Foray isn't holding subscriptions |
| Cross-device sync | No — single tester | No — single user | At multi-user | R2's `/events` backend is the first brick of it |
| User-facing transcripts | No | No | M4+ | Overcast/Apple/Snipd all have it, but Foray's transcripts serve *curation* first (Whisper tier-2, R8's load-bearing economics). Expose to users only when it costs nothing extra |
| Silence trim / voice boost | No | **No — explicitly cut from v1** | M4+ | Overcast loyalists call competitors' trims "badly edited" (04). Shipping a mediocre one damages the audio-quality story exactly where deletion risk is highest. Do it well or not at all |
| CarPlay | No | Entitlement applied-for, feature M6 | ✓ | Per 02/05: the wedge, not the identity; entitlement lead time is weeks |
| Watch app | No | No | Backlog, unscheduled | 0 evidence any persona needs it before CarPlay exists |

**The sharp version: iOS v1's table-stakes bill is exactly six items** — downloads, speed, sleep timer, session queue, chapters, share — plus the reliability bar. Everything else defers without deletion risk. That's a deliberately small bill because R1 (menu quality) is still the thing being tested.

## 3. Additive candidates — 13, with verdicts

Effort: S < 1 week, M = 1–3 weeks, L = month+. Verdicts assume R1 passes; if R1 fails, none of this matters.

**3.1 Share a pick ("look what Foray found me").**
- *What:* one tap → share sheet with episode link (pod.link universal) + the why-line as quote text.
- *Evidence:* word-of-mouth beats every algorithm on trust (00; 25–33% struggle with discovery and solve it by asking friends); every competitor ships sharing, so its absence reads as broken. The why-line makes Foray's share *better* than a bare link — it arrives pre-explained, the product demonstrating itself in one message.
- *Effort:* **S** on web (`navigator.share` + clipboard fallback), **S** on iOS.
- *Verdict:* **ship-with-iOS-v1, lite version in the web test now** — it's also how the friend-tester recruits tester #3.

**3.2 Weekly listening recap — stats without streaks.**
- *What:* a Sunday-evening card: hours listened, topics touched, and the headline Foray alone can write — "3 topics you'd never have picked yourself," the exploration floor made visible.
- *Evidence:* Pocket Casts' Year in Podcasts and Spotify's Wrapped + weekly Listening Stats prove strong appetite for reflective stats ([TechCrunch](https://techcrunch.com/2026/05/12/spotify-launches-a-wrapped-style-recap-of-your-entire-listening-history/), [ResetEra thread](https://www.resetera.com/threads/pocket-casts-app-your-year-in-podcasts-spotify-like-wrapped-stats.657007/), [TechTimes](https://www.techtimes.com/articles/312576/20251108/spotify-expands-wrapped-like-stats-sharing-feature-friends-via-social-media-platforms.htm)). Wrapped's virality is free acquisition without a single dark pattern.
- *Effort:* **M**, blocked on R2's durable events.
- *Verdict:* **later (post-R2 backend, pre-M7).** Strictly retrospective; no streaks, no guilt copy, no week-over-week comparison.

**3.3 Sleep timer.**
- *What/evidence:* covered in §2; universal in the field, absence is a one-star magnet.
- *Effort:* **S**. *Verdict:* **ship-with-iOS-v1.**

**3.4 Silence trimming.**
- *What:* Smart-Speed-class removal of dead air during local playback.
- *Principles check:* does **not** violate hard constraint #3 — client-side playback-time DSP on downloaded audio is a playback feature like speed, not rehosting/transforming served audio; Overcast/Pocket Casts/Castro have shipped it for a decade without legal event. Never marketed adjacent to ad-skipping (that phrase still triggers legal review per R9).
- *Evidence:* Overcast loyalists cite Smart Speed *by name* as why they stay, and call competitors' versions "badly edited" (04) — which is both the demand signal and the warning.
- *Effort:* **L** (DSP quality is the product).
- *Verdict:* **later (M4+), only if it meets the Overcast bar in blind listening; never in v1.**

**3.5 Transcripts/quotes, user-facing.**
- *What:* read-along transcript + quotable lines on the episode screen.
- *Evidence:* 2026 made this near-table-stakes — Overcast, Apple, Snipd all have it, Spotify partially. But Foray's transcripts exist to serve *curation* (Whisper tier-2; R8's load-bearing workstation economics), and the handoff/native-player split means nobody reads transcripts in Foray today.
- *Effort:* **M** (surfacing what the pipeline already produces).
- *Verdict:* **later** — expose when it costs nothing extra, don't build for it.

**3.6 Social / friend menus ("see what your friends' Forays dealt").**
- *Evidence against:* the graveyard's cause of death #1 (01: social layers killed Breaker and friends), and it leaks the private-taste intimacy the "it knows me" positioning depends on.
- *Verdict:* **reject.** The acceptable social surface is 3.1 — outbound, single-pick, user-initiated.

**3.7 Episode notes export to Obsidian/Notion.**
- *Evidence against:* Snipd owns this lane, does it well, and now auto-syncs to Obsidian ([Snipd features](https://www.snipd.com/all-features)). Foray answers "what should I play and why," not "what did I learn." A worse Snipd inside Foray dilutes both.
- *Verdict:* **reject (IRRELEVANT).** Revisit only if testers demonstrably copy why-lines out by hand.

**3.8 "Why did you pick this?" tap-through.**
- *What:* tap a why-line → one screen of provenance: "You starred two materials episodes; this bridges Damascus steel to fusion-grade alloys. Wildcard: this one ignored your weights."
- *Evidence:* explained diversity lifts satisfaction (00's core positioning evidence); Spotify's loudest user complaint is black-box feedback (01). Deepens the flagship claim at near-zero marginal cost because the session doc already carries the reasoning.
- *Effort:* **S–M**.
- *Verdict:* **ship-with-iOS-v1; design the session-doc field now** so the automated builder is forced to emit machine-readable provenance from its first R1 run.

**3.9 Offline/PWA improvements.**
- *What:* service worker caching the app shell + last session JSON so the menu survives a parking garage.
- *Evidence:* today the PWA white-screens offline (no service worker; `fetchJson` just fails) — and the friend-tester is on Android, where the PWA *is* the product. Performance/reliability failures are the top uninstall driver ([CleverTap](https://clevertap.com/blog/app-uninstalls/)).
- *Effort:* **S**.
- *Verdict:* **ship now, web-test phase** — a bug fix against the existing PWA promise, inside the P2 freeze's letter.

**3.10 Watch app.**
- *Evidence against:* zero persona evidence; high maintenance surface (Pocket Casts needed years plus a Wear OS speaker update to make theirs matter); the handoff/native-player question must settle first.
- *Verdict:* **reject for the roadmap horizon.**

**3.11 Widgets / Live Activities.**
- *What:* home-screen widget showing today's top card; Live Activity for now-playing.
- *Evidence:* the widget is the ritual cue (00's own-a-time-slot strategy) without sending a notification; every competitor ships widgets. Live Activities come nearly free with a real AVFoundation player.
- *Effort:* **M**.
- *Verdict:* **later (M4)** — retention polish, not retention cause.

**3.12 Mood-based session asks.**
- *What:* "I'm fried" → comfort-weighted deal; "make me work" → depth-weighted; "I've got 20 minutes" → time-boxed.
- *Principles check:* a momentary utterance is not declared config (principle 2 targets persistent state) — same class as R12's free-text ask.
- *Evidence:* ForayKit's intent grammar already exists for exactly this shape; Spotify's DJ requests and Snipd's planned natural-language steering confirm the interaction pattern has mainstream traction.
- *Effort:* **M**, sharing R12's plumbing.
- *Verdict:* **ship-with-iOS-v1** as the ask feature's first verbs.

**3.13 Family mode.**
- *What:* kid-safe pool + separate interest profiles.
- *Evidence:* already earmarked as an M7 paywall lever (R8); no evidence it matters before pricing exists.
- *Effort:* **L** (profiles imply accounts imply backend).
- *Verdict:* **later (M7).**

Also examined, rejected without a number: **comments/community** (graveyard, dark-pattern gravity), **notifications for new episodes** (43% of users kill notifications at 2–5/week — [CleverTap](https://clevertap.com/blog/app-uninstalls/); Foray's pull ritual is the alternative, not a deficiency), **video podcasts** (fights the eyes-busy medium; 01's Lesson from Podz).

## 4. Onboarding & the second user

The friend-tester on Android currently gets: cold page, four cards with no explanation of why they're these four, a "splatter" of unexplained provenance, and Play buttons that bounce them into another app. Every one of those is defensible product; unexplained, each reads as a bug. Research says the first session decides everything: day-1 meaningful action correlates with 2–3× retention, 70–90% of users are lost in session one, and a short welcome survey measurably personalizes from minute zero ([UXCam](https://uxcam.com/blog/10-apps-with-great-user-onboarding/), [UserGuiding stats roundup](https://userguiding.com/blog/user-onboarding-statistics), [Appcues](https://www.appcues.com/blog/8-user-onboarding-strategies)).

**Recommendation — one screen, one interview, one flag (total < 90 seconds):**

1. **First-visit explainer, one dismissible card, ≤ 40 words.** "4a is your personal podcast curator. Four picks a day, each with its reason. Playback happens in the app you already use — 4a never takes over your library." The last sentence pre-empts the handoff surprise *and* restates 04's "adds to what you have, never switch" rule.
2. **Interest seeding, one tap-through, skippable.** Show the taxonomy leaves as chips, "tap a few you're curious about lately" (3–7 taps), writes straight into the existing `cp_interests` store. This is a declared *prior*, observed thereafter — consistent with principle 2, which forbids declared *state*, not seeded starting points the sliders already expose. Skipping = defaults, exactly today's behavior.
3. **Name the wildcard once.** First splatter render includes a one-time line: "The wildcard ignored your tastes on purpose. That's not a bug — tell us when it hits." Converts the most confusing element into the brand's signature move. (Evidence: diversity *with a stated bridge* reads as intelligence, without one as error — 00.)

What converts skeptics in session one is not explanation volume, it's **one good pick played to the end**. Everything above exists to get the tester to tap Play once with correct expectations. Explicitly out of scope, with reasons:

- **No account, no email gate** — localStorage-only is a feature at this phase; a signup wall in front of a two-person test is pure friction (70–90% first-session loss is mostly friction).
- **No multi-screen tour** — carousel tours test as skip-fodder; the one card + one chip screen is the whole ceremony.
- **No "how it works" ML explanation** — the why-lines *are* the explanation, per positioning. Explaining the mechanism invites judging the mechanism instead of the picks.

Instrument all three steps (`onboarding_seen`, `interests_seeded` with chip count, latency-to-first-`picked`) — that makes this R1/R2 data-quality work, which is the honest justification for touching the frozen web client. Success metric for the second user, pre-committed: **a pick on 3 of the first 7 days, and at least one wildcard played in week one.** If the wildcard never gets played, the exploration floor has a presentation problem, not an existence problem — fix copy before touching the ratio.

## 5. App Store listing draft (M3; copy-rule compliant)

- **Name:** 4a
- **Subtitle (29/30 chars):** `Your personal podcast curator`
- **Promotional text (168/170 chars):** `Four picks a day, each with its reason. Real shows, real hosts, no infinite feed — a small menu built for your curiosity, with one wildcard you didn't see coming.`
- **Description, first paragraph:** `4a deals you four podcast episodes a day and tells you why each one is on your menu. Not a feed, not a chart, not another app shouting its favorites — a personal curator that learns what you're curious about, keeps roughly a third of every menu deliberately outside your lane, and always says the reason out loud. When the menu's done, it's done: no autoplay chain, no endless scroll, nothing designed to keep you here longer than the listening deserves.`
- **Keyword field (6 terms):** `podcast, curator, discovery, episodes, recommendations, listening`
- **Screenshot captions (5):**
  1. `Four picks. Each one explained.`
  2. `One wildcard ignores your tastes — on purpose.`
  3. `Say what you want to learn. Get a series, in order.`
  4. `The menu ends. Your time is yours.`
  5. `In the car: four options, one tap, eyes on the road.`

Compliance notes: no "AI podcast app" (R7 — and Snipd's own App Store name "AI Podcast Player" now anchors that phrase to a different product), no banned words, no commute-length framing, no unqualified "we'll surprise you" (the wildcard caption states its bridge). Third-party-AI disclosure and 5.2.3 review notes per R9 ride along at submission.

---

## Requirements & actions

Continuing from R12 in 08-REQUIREMENTS-DELTA.md. Tags: 🌐 web-test phase · 📱 M3 iOS v1 · ⏳ later milestone.

**R13 — Watchlist entries logged; R10 triggers NOT met; series-builder bar raised.** Spotify Prompted Playlists (podcasts, 4/2026) and Snipd AI DJ (clips, 2026) are recorded on the quarterly watchlist. Neither pre-committed trigger fired — no strategy change. Consequence for R12: semantic series assembly must beat a prompted playlist on pedagogical ordering + stated reasons, and those two axes get measured in the R1 blind test's series variant. New watchlist tripwires: Spotify adds explanations/negative-feedback honoring to prompted playlists; Snipd DJ moves from clips to full-episode menus.

**R14 — Web-test onboarding (narrow, justified exception to the P2 freeze).** 🌐 One dismissible explainer card (≤40 words, includes the handoff sentence), skippable taxonomy-chip interest seeding into `cp_interests`, one-time wildcard label. All three instrumented (`onboarding_seen`, `interests_seeded`, first-pick latency). Justification: an uncomprehending tester produces junk R1/R2 signal; this is instrumentation quality, not feature growth. Copy goes through the CI copy-rules gate.

**R15 — PWA offline shell.** 🌐 Service worker caching app shell + last-fetched `data/*.json`; menu must render in a dead zone. Classified as a bug fix against the existing PWA promise. Sleep on anything fancier (no background sync, no push).

**R16 — Share-a-pick.** 🌐 lite / 📱 first-class. Web: `navigator.share` (clipboard fallback) with pod.link URL + why-line as quote; `shared` event logged. iOS v1: share sheet on every card. This is the only feature that is simultaneously a table-stake, a principles-clean social surface, and an acquisition channel (word-of-mouth is the medium's trust king — 00).

**R17 — Provenance tap-through ("why did you pick this?").** 📱 UI at iOS v1; 🌐 schema now. The session doc gains a machine-readable `provenance` field per card (signals used, bridge, wildcard flag) that the automated builder must emit from its first R1 run — retrofitting explanations later would mean the blind test validated a builder that can't explain itself.

**R18 — iOS v1 player table-stakes bill, fixed at six.** 📱 Downloads (original enclosure URLs), 0.5–3× speed, sleep timer, session-scoped queue (the session is the queue; no infinite Up Next), publisher-marker chapters (feeds R11), share. Reliability bar above all of it (M0 spike). Explicitly excluded from v1: silence trim, voice processing, transcripts UI, watch app, widgets. Scope additions to this bill require reopening this document.

**R19 — Silence trimming deferred with a quality gate.** ⏳ M4+. Not a principle violation (client-side playback DSP ≈ speed control; no served-audio transformation, no ad targeting). Ship only if blind A/B against Overcast Smart Speed sounds native; never marketed within a sentence of ad-skipping (R9 legal rule applies to copy).

**R20 — Weekly recap, stats-without-streaks.** ⏳ post-R2 backend. Retrospective only; leads with exploration ("topics you'd never have picked"); banned: streaks, comparisons, guilt copy, week-over-week framing. Doubles as the first honest marketing asset when the corpus unfreezes.

**R21 — Mood/intent asks as the intent grammar's first verbs.** 📱 M3, shared plumbing with R12. Momentary utterances, never persisted as config (principle 2 compliant). Verb set v1: easy/comfort, depth, story, time-boxed ("I've got 20 minutes").

**R22 — Rejections recorded, with reasons.** Social/friend menus (graveyard cause #1; violates private-taste intimacy). Notes export to Obsidian/Notion (Snipd's lane; IRRELEVANT). Watch app (no persona evidence; unscheduled). New-episode push notifications (notification fatigue kills apps at 2–5/week; the pull ritual is the design). Video (fights the eyes-busy medium). [CONFLICTS-WITH-PRINCIPLES — noted, not recommended]: none of this round's candidates required a principles override; the only two engagement levers evidence supports elsewhere — streaks and clip feeds — stay rejected per 08.

**R23 — App Store listing copy locked as drafted in §5.** 📱 Strings enter `data/` (or an equivalent copy file) so the CI copy-rules test gates them like all other user-facing copy; changes require re-review against R7.

### Ranked actions for the web-test phase (this month, in order)

1. **R15 offline shell** — the friend-tester's PWA must not white-screen; every dead-zone failure poisons a day of retention signal.
2. **R14 onboarding trio** — before recruiting tester #3, not after.
3. **R16-lite share** — turns the two existing testers into the recruiting channel.
4. **R17 schema field** — one evening of work that the R1 blind test silently depends on.
5. **Nothing else.** The freeze holds; the next meaningful dollar still goes to the automated builder's menu quality and the iOS audio spike (P1 unchanged).
