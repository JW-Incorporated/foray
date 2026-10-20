# CORNER CASES — treat as requirements, not trivia

Each item: the failure, and the required behavior. Add real examples to the fixture corpus as encountered.

## RSS / ingestion

1. **Tracking-prefix redirect chains.** Enclosure URLs are often `podtrac.com/.../chartable.com/.../real-cdn/file.mp3` — 2–5 redirects. Some prefix hosts reject HEAD requests or range requests. → Follow redirects with a sane cap (8); store both original and resolved URL; use GET with `Range: bytes=0-0` instead of HEAD to probe; the app downloads via the *original* URL (publishers count downloads there — we don't cheat their stats) unless it's broken.
2. **Dynamic ad insertion (DAI).** Same episode GUID serves different bytes per request: different ads, different total duration (±1–4 min), so any timestamp derived from one copy (transcript times, chapter offsets, my saved position if the file is re-fetched) misaligns on another copy. → (a) Once downloaded, **never re-fetch** an episode file while a saved position exists; positions are valid only against the local file. (b) Detect DAI: duration variance across fetches or known DAI hosts (Megaphone, Acast, Art19...) → set `dai_suspected`, which disables precise segment-jump features for that show. (c) Transcript-derived timestamps for DAI shows are approximate — present as "roughly minute 70," never hard-seek claims.
3. **GUID instability & duplicates.** Hosts migrate and regenerate GUIDs; feeds get republished; audio + video feeds of one show duplicate every episode; "rebroadcast" episodes duplicate old content with new GUIDs. → Composite identity: normalized(title) + published date ± 1 day + duration ± 90 s; dedup pass groups across feeds; menu never shows two members of a dedup group.
4. **Feed moves.** 301s and `<itunes:new-feed-url>` → update stored feed URL once, keep an audit trail; alert (log) if a feed redirects to a parked domain (dead show hijack).
5. **Malformed feeds.** Invalid XML that browsers tolerate, undeclared entities, CDATA soup, HTML (sometimes entire tracking pixels) inside descriptions, wrong `itunes:duration` formats (`HH:MM:SS`, `MM:SS`, bare seconds, or garbage). → Lenient parser; sanitize HTML → text for LLM input; recompute duration from the downloaded file when it matters and reconcile.
6. **Missing/false metadata.** No duration (common), enclosure `length=0`, `type="video/mp4"` in an "audio" feed, explicit flag missing. → Treat all metadata as hints; video enclosures either transcode-none (skip item) or play audio track (AVPlayer can, but battery/data cost — decide in ADR, default: skip video-only items and prefer the audio sibling feed).
7. **Enormous back catalogs.** 2,000+ episode feeds (JRE) = multi-MB XML. → First-sync cap; conditional GET; parse streaming, not DOM-load.
8. **Rate limits & politeness.** 429s, hosts that ban aggressive pollers. → Per-host (not per-feed) request budgets, exponential backoff, honest User-Agent with contact info.
9. **Private/premium feeds** (Patreon etc., token in URL). → Support them (I'll add some); the tokened URL is a secret: encrypt at rest, never log, never appears in analytics events.
10. **Geo/UA-gated enclosures.** Some CDNs 403 non-browser UAs or foreign IPs. → App downloads with a plausible UA; failures mark the episode unplayable-here and it's excluded from menus, with a visible reason in the episode detail.

## Playback & audio session (iOS)

11. **Phone call mid-episode.** Interruption began → persist position; ended with `shouldResume` → resume; without → stay paused but *ready* (lock screen shows correct state). Test: decline vs. answer vs. 20-min call (session may be deactivated by the OS — reactivate cleanly).
12. **Navigation prompts.** Maps ducks or pauses other audio depending on settings. With `.spokenAudio` mode, iOS may *pause* us for the prompt rather than duck. → Handle brief interruptions seamlessly (auto-resume, no TTS replay); if a transition TTS got trampled, either replay it if <50% played or just proceed — never replay episode audio.
13. **Bluetooth connect/disconnect races.** Car turns on mid-download / turns off mid-TTS / grabs the audio route 5 s after playback started on speaker. → Route-change handler is idempotent and debounced; "auto-resume on car reconnect" only for routes previously classified as car (persist known car route names).
14. **CarPlay vs. lock screen.** Before the CarPlay entitlement lands, verify the Now Playing surface is complete (artwork, chapter-ish titles for TTS items). When CarPlay ships: session picker must be a CPListTemplate reachable in ≤2 taps; obey CarPlay driver-distraction constraints.
15. **App killed / phone rebooted overnight.** Cold launch must restore: current session, queue position, item position, downloaded assets — from local store, before any network. Airplane-mode cold-launch is an acceptance test.
16. **Storage pressure.** iOS purges caches; user's phone is full. → Store session audio in Application Support (not Caches) with explicit LRU under our own cap; handle "file missing anyway" per the degrade path; surface storage usage in Settings.
17. **Sleep timer / end-of-commute.** Arriving mid-item is the normal case, not an edge: position save must be so reliable that yanking the phone off BT and pocketing it loses ≤ 15 s.
18. **Speed and TTS.** Per-show speed must NOT apply to TTS items (intros at 1.6× sound deranged). Rate resets to 1.0 for TTS, restores after.
19. **Duplicate audio outputs.** The classic bug: two AVPlayers alive after a fast skip → overlapping audio. The queue manager owns exactly one player; item swaps are serialized through the state machine; add an assertion/telemetry event if audio-playing state is ever entered twice without an exit.

## Voice

20. **Recognition in road noise / windows down.** Expect degraded STT. Tier-1 grammar should key on robust short words; prefer "next" aliases; if confidence low + no grammar hit, earcon-fail fast rather than guessing.
21. **Hold-to-talk while a TTS intro is playing.** Ducking our own TTS to hear a command about it ("skip this one") — the target of "skip" is ambiguous (intro vs. episode). Rule: during an intro, "skip" skips the *episode* being introduced (intent is obvious); "skip intro"/"just play" skips only the TTS.
22. **Homophones & show-name collisions** ("play the second one" vs "play the segment one"). Ordinals win; when fuzzy title match confidence is low, speak a 1-line confirm ("The Roman siege weapons one?") — accept "yes/yeah/yep."
23. **Siri intent while app cold.** App Intents must work from terminated state: intent handler starts audio session and playback without UI. Test from cold, on BT.
24. **Bluetooth mic quality trap.** Recording via car BT can drop A2DP to HFP → playback becomes phone-call quality for everyone in the car. If detected (route change to HFP during PTT), prefer iPhone mic capture while playback stays A2DP; verify per-car behavior and make the mic source a setting.

## Curation / content

25. **Feedback loop collapse.** Two weeks in, menus converge to 3 shows. → Exploration floor is not optional; fatigue penalties enforced; weekly self-audit job logs menu diversity metrics (distinct shows/topics per trailing 14 days) and alerts if below thresholds.
26. **Skip misattribution.** I skip a fusion episode because the *guest* is insufferable → system must not learn "less fusion." Skip signal weighting per curation spec; guest-level signal when Tier-1 extracted guests.
27. **Stale news.** A "this week in X" episode recommended 3 weeks late is embarrassing. Tier-1 evergreen-vs-timely tag; timely items hard-expire from candidate pools.
28. **Explicit content / kid in the car.** A "family mode" toggle (per-session flag at build or via voice "family mode on") filters `itunes:explicit` and comedy archetype. I have an infant; someday a talking kid.
29. **Very short commutes / traffic variance.** Commute ran long and the session is exhausted → auto-extend: queue next-best same-archetype item with transition TTS; if offline, fall back to any downloaded unplayed item; if nothing, speak "that's everything I had prepped" once, stop cleanly (never dead air with no explanation).
30. **The intro knows less than the audio.** Intro says "45 minutes on tokamaks" but the episode spends 30 min on sponsor reads and tangents → trust erosion. Where Tier-2 ran, intro claims must derive from transcript, not show notes; where only Tier-1 ran, intros hedge scope ("billed as...").
31. **Same episode, both saved-for-later and menu-picked.** Dedup at menu build against saved/played state; "saved" items get a periodic dedicated slot ("you saved this Tuesday — good fit for today's longer drive?").

## Backend / ops

32. **LLM output discipline.** All Claude calls that feed the pipeline return schema-validated JSON (retry once with error feedback, then dead-letter queue + alert). A malformed classification must never poison a session build.
33. **Cost runaway.** A bug queues 500 episodes for transcription overnight. → Hard daily budget in `cost_events`-aware middleware; Tier-2 requires a shortlist token minted by the curation engine (can't be invoked in bulk by accident).
34. **Session built, assets half-downloaded, commute starts.** Readiness is per-item: playback can start when item-1 of any card is local; the "ready" notification fires at first-item-ready, a second quieter state marks fully-ready. Never block "play" on 100%.
35. **Clock/timezone.** Cron builds keyed to my local time (DST!) and my calendar-esque schedule (weekday vs weekend commutes differ). Configurable, not hardcoded.
36. **Legal hygiene for the monetization phase** (bake in now): no rehosting episode audio **[withdrawn 2026-10-19 for published flagship episodes, founder ruling #1425; see DECISIONS 2026-10-19]**; no ad stripping; download counting via original URLs; honor feed removal (show deleted from directory/feed 410 → purge from catalog, keep my play history); OPML import/export so future users own their subscriptions; per-user private-feed secrecy (item 9).
