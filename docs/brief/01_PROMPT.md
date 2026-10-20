# MASTER PROMPT — "Foray" Podcast Curator

You are building **Foray**: a personal AI podcast curator with an iPhone app front end. One user for now (me), but architected so multi-user monetization later doesn't require a rewrite.

Read this file fully, then read the companion docs in this folder before writing any code:

- `02_ARCHITECTURE.md` — system design, stack, data model guidance
- `03_CURATION_SPEC.md` — scoring, serendipity, session assembly logic
- `04_VOICE_AUDIO_SPEC.md` — iOS audio engine, TTS intros, voice commands
- `05_CORNER_CASES.md` — catalog of known failure modes; treat as requirements
- `06_ROADMAP.md` — phased milestones with acceptance criteria; build in this order

## The product in one paragraph

I get in my car. The app already has a "session" built for my commute: it presents ~4 curated options ("a fusion energy deep-dive," "history of Roman siege weapons," "how Fender builds guitars," "casual comedy hang"). I pick one by tap or voice. It plays. A short generated audio intro tells me why it was picked and what to expect. When an episode/segment ends, another brief spoken transition bridges into the next item. I can talk to it hands-free-ish (hold-to-talk / Siri intent): "skip," "something different," "more like this," "save for later," "what is this?" It learns from what I finish, skip, and say. Content is real, existing podcasts pulled from open RSS — we are a *curator and client*, not a content host.

## Hard constraints (do not deviate)

1. **Stack**: Backend = Node.js + TypeScript worker/API, Supabase (Postgres + storage + auth), Anthropic API for classification/summarization/intent fallback. iOS app = SwiftUI, min iOS 17, Swift Concurrency. This matches infrastructure and patterns I already run — reuse them.
2. **RSS-native**: All podcast discovery/resolution via Podcast Index API + iTunes Search API + direct RSS. **Never** depend on the Spotify API for anything. Spotify-only content gets a deep-link handoff card at most (second-class citizen).
3. **The app streams/downloads episode audio directly from the publisher's enclosure URL.** Our backend never proxies, rehosts, caches, or transforms episode audio. Never strip or skip ads programmatically. We must remain a legally boring podcast client — this is what keeps monetization viable later. (Our own generated TTS assets live in Supabase Storage; that's the only audio we serve.) **[Superseded 2026-10-19 by founder ruling (#1425, DECISIONS 2026-10-19): 4a may store, cut and publish clip audio as podcast episodes, with attribution. The app itself still streams from the publisher.]**
4. **Thin client**: all curation, enrichment, TTS generation, and LLM calls happen server-side. The only API keys on the phone are for our own backend. On-device intelligence is limited to: speech-to-text (SFSpeechRecognizer), a local intent grammar, and fallback TTS (AVSpeechSynthesizer).
5. **Offline-first playback**: a built session must be fully playable with zero connectivity — episodes and TTS intros pre-downloaded on WiFi/before departure. I drive through cell dead zones; a session that stalls is a failed session.
6. **Car-safe UX**: every action reachable while driving must work eyes-free via voice or lock-screen/steering-wheel controls. Big tap targets on the session picker. No interaction may *require* reading the screen while playing.
7. **user_id on every table and every API route from day one**, even though there's one user. Single-tenant shortcuts in schema are forbidden; single-tenant shortcuts in ops (no billing, no signup flow) are fine.
8. **Cost discipline**: LLM/TTS/transcription spend must be metered, logged per-operation to a `cost_events` table, and capped with a configurable daily budget. Cheap-first cascade: metadata-only classification → transcript-based enrichment only for shortlisted candidates.

## Decisions already made (don't relitigate, but flag if you hit a wall)

- **Voice input**: hold-to-talk button (big, reachable) using on-device SFSpeechRecognizer, plus App Intents so Siri can invoke core commands truly hands-free ("Hey Siri, skip this," "Hey Siri, something different"). **No wake word** — not reliably possible for third-party iOS apps in background; don't burn time on it.
- **Intent handling**: two-tier. Tier 1 = local deterministic grammar for the ~10 core commands (<300 ms, offline). Tier 2 = free-text utterances go to backend → Claude → structured intent JSON. Unrecognized while offline → polite earcon + "saved that for later."
- **TTS intros**: generated server-side at session-build time (pick one high-quality TTS API; abstract behind an interface), stored in Supabase Storage, downloaded with the session. On-device AVSpeechSynthesizer is the fallback when an asset is missing, never the primary. Loudness-normalize intros to ≈ -16 LUFS so they don't blast between episodes.
- **Session cadence**: sessions are built by scheduled job (cron: pre-morning-commute and pre-evening-commute, times configurable) and on-demand via API. Push notification when the morning session is ready and downloaded.
- **Long episodes** (2–3 h shows vs a 25-min commute): default model is **resume-across-sessions** — a partially played episode becomes a first-class "continue" card in the next session menu. Segment-level entry points (jump to the interesting 20 minutes) are a later phase and only for shows with verified chapter data. See corner-cases doc for why (dynamic ad insertion breaks timestamps).
- **Player**: custom queue manager over AVPlayer (not AVQueuePlayer) — we need mixed local/remote items, per-item start offsets, per-show playback speed, and inserted TTS items. See `04_VOICE_AUDIO_SPEC.md`.
- **CarPlay**: apply for the CarPlay audio entitlement early (approval takes weeks), but do **not** block any milestone on it. Lock screen + Bluetooth AVRCP controls work in every car and ship first.

## Things YOU must think through and decide (with care, documented in an ADR file)

For each of these, write a short Architecture Decision Record in `docs/adr/` explaining options considered and why you chose what you chose:

1. **Feed polling strategy** — polite conditional-GET polling cadence per feed (release-pattern aware: daily shows vs weekly), ETag/Last-Modified handling, backoff on 429/5xx, WebSub where offered. How new-episode latency trades against politeness.
2. **Episode identity & dedup** — GUIDs are unreliable (hosts regenerate them; audio and video feeds of the same show duplicate content). Design a composite identity strategy and a same-show/cross-feed dedup pass.
3. **Transcript acquisition ladder** — order of preference among: `<podcast:transcript>` tag, publisher-hosted transcripts, YouTube captions for simulcast shows, Whisper (decide API vs. running it on my always-on workstation — I have one; design the interface so the compute location is swappable). Decide *when* an episode earns transcription (it should be: shortlisted by metadata score AND needed for ranking or segment framing).
4. **DAI (dynamic ad insertion) detection & handling** — how to detect that a show's audio shifts between fetches, and what that disables (precise timestamp jumping) vs. what still works. See corner-cases doc.
5. **The exact taxonomy representation** for my interests — flat tags vs. hierarchical vs. embedding-space — and how voice feedback ("more like this," "less politics") mutates it. Must be inspectable and hand-editable by me in the app.
6. **iOS download manager** — background URLSession config, storage budget with LRU eviction, retry policy, partial-download resume, and the "is the session fully ready?" state machine that gates the "ready" notification.
7. **Audio session choreography** — exact AVAudioSession category/option transitions for: normal playback, hold-to-talk (record while ducking playback), nav-prompt ducking from other apps, phone-call interruption recovery, Bluetooth route changes (car off/on). This is the highest-polish-risk area; prototype it before building UI around it.
8. **Testing strategy for feed parsing** — build a fixture corpus of ≥20 real-world weird feeds (I'll help collect; corner-cases doc lists categories) and make the parser test suite run against it in CI.
9. **Migration/versioning** for session format — the session JSON the app downloads will evolve; version it from v1.

## What "excellent curation" means (the soul of the product — do not treat as an afterthought)

The four-option menu must feel like a sharp friend who knows me, not a relevance sort. Requirements in `03_CURATION_SPEC.md`, but the essence:

- **Variety by construction**: the 4 slots are drawn from distinct archetypes (deep-learn / stretch-adjacent / narrative / comfort), not the top-4 of one ranked list.
- **A serendipity floor**: some fraction of recommendations must come from outside my demonstrated-interest cluster, chosen because they're *excellent and adjacent*, with the intro explaining the bridge ("you liked the metallurgy episode — this one on Damascus steel forging is the same itch").
- **The one-line 'why'** shown on each card and spoken in the intro is generated per-recommendation and must reference *my* context, not generic praise.
- **Skips teach, but carefully**: a skip is evidence against the episode, weak evidence against the topic. Don't collapse my taste graph because I skipped one boring guest.

## Working style expected from you

- Build in the milestone order in `06_ROADMAP.md`; each milestone has acceptance criteria — meet them before moving on.
- Backend gets integration tests around the feed parser, dedup, session builder, and cost metering. iOS gets unit tests for the player queue state machine and intent grammar; UI polish comes after audio correctness.
- When a real-world feed breaks an assumption, add it to the fixture corpus and fix forward.
- Keep a running `docs/DECISIONS.md` changelog and per-topic ADRs. Instrument everything: every session built, every card shown, every skip/finish/voice command lands in an `events` table — this is both the learning signal and my product analytics for the monetization phase.
- Ask me (the user) when a decision is taste-dependent (voice persona, intro verbosity, visual design). Decide yourself when it's engineering.
