# 4a Redesign 2026: design brief for art directors

You are one of five art directors. Read this, then `PLAN.md` (binding), then the
research it draws on in `research/`: `our-product.md`, `today-critique.md`,
`podcast-apps.md`, `platform-2026.md`, `craft-leaders.md`,
`listening-contexts.md`, `featuring.md`. Where this brief summarises, the
research has the sources.

The goal: take 4a from "meh" to an app that looks and feels top-tier in 2026
and can credibly earn App Store and Google Play featuring. The research is
clear that **polish alone will not do it**. The category is consolidated, and
Apple and Pocket Casts already set the bar for glass and finish. 4a wins on
concept, so the design's first job is to make that concept impossible to miss.

## 1. Essence and audience

4a is a personal podcast curator. It finds real, existing podcasts and arranges
them for one listener: a small daily set of picks, each with a one-line reason,
and **forays**: single listening sessions built from segments of several shows,
joined by short narration. It is a curator and client, never a host. Audio
always plays from the publisher's own file, by seeking and stopping. Nothing is
rehosted, cut or re-encoded.

Born for the car. The original brief: "No interaction may require reading the
screen while playing." Playback continues when an episode ends (founder ruling,
2026-09-14). The lock screen, the notification and the car are where most
listening happens.

Audience today: the two founders (Joey on Android, Wyatt on iPhone) and the
people around them. Anonymous-first, no login wall. Tomorrow: curious adults
who want to hear things outside their usual lane, without an app that nags or
hooks them.

Voice: plain, honest, specific. The app speaks as "4a", never "we". A search
that misses says so. No streaks, no infinite scroll, no fabricated matches.

## 2. Hero screens: the job and the states

Design these six. Every one must work at 393x852, 375x667 and 412x915 (the
harness viewports in `tools/ui-lab/`), and with long titles.

**Home (today's picks).** Job: in two seconds, say "here is what 4a picked for
you today, and why", and offer one obvious way to start listening. Today's
sections are greeting plus play, Jump back in, Forays for you, Playlists for
you, Suggested; the order is yours to argue. States: first run (no history, no
"usual subjects" to cite), returning, mid-listen (something to resume), stress
(long titles, many items), offline, loading.

**Now Playing, full and mini.** Job: the immersive listening surface, and the
screen editors judge first. A glance posture (artwork, title, show, one large
play/pause, 15 back / 30 forward, a thick scrubber) and a detail posture
(chapters or foray segments, speed, sleep timer, bookmark, show notes, Up Next
peek). The mini player is always reachable above the tab bar, opens Now
Playing, and carries play/pause plus one skip. States: episode, foray (segment
strip as scrubber, narration vs source clip, "Where this came from" credits),
paused, buffering, offline/downloaded, end of item handing off to the next,
375x667 with a long title (play must stay on screen), maximum text size.

**Search / Discover.** Job: find a named thing fast, and browse without a
directory feel ("a splatter, not a directory"). States: idle (today a wall of
~40 identical pills), typing, results (shows, episodes, playlists), no results
(must be honest and must not contradict visible content), keyboard open.

**Library.** Job: everything the listener owns or chose: forays, followed shows,
saved, playlists, Up Next, history. Dense, artwork-led, scannable. States:
empty (first run), returning, many items. Up Next is part of this job: reorder
without dragging (move up/down, remove, undo), rows of 56px or more, the
current row marked by more than colour.

**Foray detail.** Job: make a foray legible as its own kind of thing (not an
episode, not a playlist) before you press play: its subject, its length, the
shows it draws from, the shape of its segments, and why it was made for you.
States: unplayed, in progress (resume), finished, un-narrated (allowed for now),
unavailable (today a bare grey sentence).

**Onboarding, first screen.** Job: a promise, not a feature list, and value in
under a minute with no account. Show the product rather than a tutorial. The
last button is "Show my picks" (founder ruling, open to challenge). States:
first launch, returning after skip.

## 3. Differentiators the design must make visible

No competitor has these. Each needs a designed form, not a line of grey text.

1. **Forays as joined segments.** The segment strip is the identity element:
   bars proportional to runtime, a stable colour per show (`--seg-c0..7`),
   narration distinct, the current bar filling as it plays, doubling as the
   scrubber. Visually it is a stitched timeline. In copy, never imply a derived
   audio file ("clipping", "stitching" as an audio process); the tagline
   "Podcasts, stitched around you" is the founders' call.
2. **Why-lines.** Every pick carries one human-readable reason, 18 words or
   fewer (hooks 16 or fewer). It must read as content, not metadata.
3. **Stretch picks with bridges.** Every "for you" rail reserves at least one
   labelled Stretch slot whose bridge line says why it is adjacent, never "you
   like this". Today the bridge is "the quietest line on the card". Fix that.
4. **The exploration floor (~30%).** A guaranteed share of unfamiliar material.
   No app makes this visible. It can be a designed, honest feature rather than
   a hidden ranking rule. The floor itself is a hard limit.
5. **Continuous playback.** When an item ends, 4a keeps going: the rest of the
   list, then more of what fits, chosen under the floor. Show what plays next,
   and why, in the player and in the OS metadata.

## 4. What "top-tier 2026" means, concretely

From `podcast-apps.md`, `platform-2026.md` and `craft-leaders.md`:

- **Floating, receding chrome.** Tab bar that floats and minimises on scroll,
  mini player docked to it as an accessory, Now Playing expanding as a sheet
  (iOS 26/27, Pocket Casts). Content runs under the chrome.
- **Conservative glass.** iOS 27 reduced default transparency because glass over
  busy content failed on readability. High tint, solid fallback, AA contrast,
  honour `prefers-reduced-transparency` and `prefers-contrast`.
- **Artwork-led colour.** Now Playing takes its palette from the artwork, edge to
  edge, with a contrast-safe scrim (Apple, Pocket Casts, Tide Guide's living
  colour). Podcast art is 4a's free source of colour.
- **Material 3 Expressive on Android:** springs, bolder shape and colour, larger
  type, emphasised containers. A direction picks per-platform idioms or one
  neutral language, and says which.
- **Springs, shared elements, interruptible gestures.** Row artwork flies into
  the player. Lists open gaps on insert. Nothing blocks on an animation.
- **Native touches:** haptics on play, scrub snaps and bookmark; native share;
  complete lock-screen and notification controls.
- **Queue as first-class, with live feedback** (count badge, add animation).
- **Transcript and chapters as navigation** are now expected; design the slot even
  if the data arrives later.
- **One icon family**, one type scale, one accent rule.

## 5. The 10 biggest problems in today's UI

Ranked by impact (`today-critique.md`):

1. Imagery almost absent where it matters: Home hero and rails, forays,
   playlists, Up Next and Create are text-only cards.
2. Now Playing is not immersive and breaks small: app header stays visible, four
   button styles, three accents, Unicode transport glyphs; at 375x667 play falls
   off-screen with a long title.
3. Flat hierarchy on Home: a button-shaped hero, equal rails, the same playlist
   three times above the fold; nothing says "today's pick, and why".
4. Badly tuned density: Up Next rows ~210px with seven controls, Interests cards
   ~165px, followed-show rows 130px.
5. Unicode glyphs instead of an icon system.
6. Two competing accents with no rule (lavender CTA, orange for everything
   else, coral for Stop).
7. Website chrome: permanent tagline header, drawer plus tab bar, refresh glyph,
   boxed back button, rules under every title, no blur or large-title collapse.
8. Forays, the signature, have no visual identity; Create opens on a disabled
   "Foray" option and an apology.
9. Inconsistent components: one chip in two typefaces, wrong active tab on
   Playlist detail, a translucent search bar without blur, a "no results"
   message contradicting a visible category.
10. Empty, error and explainer states are bare grey sentences.

Worth keeping: the serif/sans voice, the bottom search field, the 15/30 skip
asymmetry, the big circular play, the episode summaries, the Stretch bridge,
"2 of 4 played", and the clip-strip concept.

## 6. Hard limits

These are in `PLAN.md` under "Hard limits still in force" and **no direction
may challenge them**: `esc()`/`safeUrl()`, strict CSP (no inline styles or
scripts), `cp_` storage keys, product principles 1-4 (exploration floor, no
streaks, no infinite scroll, state observed not declared, legally boring audio,
copy rules: why ≤18 words, hooks ≤16, banned words, no "we/us/our", "subject"
not "topic"), 44px tap targets, focus management in sheets, one reduced-motion
block covering every transition, WCAG AA contrast, no third-party imagery
committed to the public repo, no paid services, free/OFL fonts only
(self-hosted; CSP is `font-src 'self'`). The app icon is out of scope.

## 7. Founder rulings now open to challenge

Owner decision 1: any of these may be overturned, **explicitly**, in your
direction's brief, with the reason. The owner decides at the pick.

- **Dark-only** (U-01). No light palette exists.
- **IA:** four tabs (Home, Search, Create, Library) plus a drawer (D3). Does
  Create earn a tab? Does the drawer earn its place next to a tab bar?
- **No zoom** (2026-09-23). It costs WCAG 1.4.4/1.4.10; keeping it means type
  must compensate and Dynamic Type is unconfirmed on device.
- **Palette and accent roles:** amber = the listener's own, violet = what 4a
  authored.
- **Type:** Fraunces + DM Sans. (Replacing them is allowed; OFL only.)
- **Card anatomy:** two-tier episode row, stretched-link cards, one pill, one
  eyebrow, seven radii, four elevations.
- **Home section order** and the "Suggested" name; the Home play button.
- **Search:** A-Z show list, field position.
- **Interests as sliders** (D6), which edges against "state observed".
- **Copy and naming:** "Stretch", the "daily" framing, the tagline, "Show my
  picks".
- **Benchmark:** "Apple Podcasts on iOS" (2026-09-23) vs a distinctive look.
- **No share sheet** (D10; legal gate withdrawn 2026-10-05, #1071).
- **Up Next behaviour:** played row jumps to top; drag-to-reorder deferred.
- **Car posture:** whether a large-control glance mode appears automatically on
  a car Bluetooth route (observed) or by toggle.

Not open: the rulings that restate a hard limit (the floor, seek-and-stop
audio, continuous playback being allowed, the 15/30 pair shared with the lock
screen).

## 8. WebView feasibility envelope

4a is a Capacitor app: your design renders in WKWebView (iOS) and Android
System WebView. Design inside this envelope (`platform-2026.md`,
`craft-leaders.md`). Tag every technique in your brief **Web**, **Web+**
(existing Capacitor plugin) or **Native**.

**Credible (Web):** strong variable-font typography with tabular numerals;
artwork-derived colour via cached canvas extraction and `@property` colour
transitions; small, restrained `backdrop-filter` on the tab bar, mini player and
sheets only; spring motion as `linear()` tokens; same-document View Transitions
with a FLIP fallback; scroll-driven animations behind `@supports`; safe-area
insets with `viewport-fit=cover`; layered gradients and two-layer shadows;
skeletons; optimistic UI; SVG or Lottie/Rive accents used sparingly.

**Credible (Web+):** haptics (`@capacitor/haptics`); status bar style; native
share sheet; media session (lock screen, Control Center, Android media
notification, artwork, position, all action handlers); iOS-style push/pop and
edge-swipe back (`@capgo/capacitor-transitions`, compatibility unchecked).

**Native, out of scope unless the owner asks:** real Liquid Glass refraction,
Core Haptics patterns, widgets, Live Activities, CarPlay/Android Auto templates.

**What reads as fake (avoid):** faux-iOS chrome on Android or the reverse; a
static blur that does not follow scroll; hairline borders pretending to be glass
edges; motion that ignores reduce-motion; hand-drawn status-bar or lock-screen
imitations; Dynamic Type parity promises. Blur and animation must be tested on
a phone, not a desktop browser.

**Guideline 4.2 risk:** a content-curation app in a WebView is exposed to "web
clippings, content aggregators". Native navigation patterns, lock-screen
playback, haptics, offline downloads and visible original curation are the
defence. Design must not look like a website in a frame.

## 9. Featurability checklist

From `featuring.md` (Apple's stated criteria, ADA categories, Google's quality
pillars). Your direction should answer each design-owned item:

1. One distinctive idea visible in the first 3 seconds of Home and Now Playing.
2. Current platform idiom (Liquid Glass / M3 Expressive) or a stated reason to
   differ.
3. Platform-native interaction: standard gestures, sheets, haptics, share, lock
   screen.
4. A signature moment of delight (for example the row-to-player transition or
   the foray strip coming alive).
5. One cohesive system: type, colour, motion and artwork as a single theme.
6. Accessibility you can list feature by feature: screen reader labels, text
   scaling, increased contrast, meaning not carried by colour alone, reduced
   motion, 44px targets, AA contrast.
7. Designed offline, slow-network, empty and error states; no dead ends.
8. First run with no account and value in under a minute.
9. No dark patterns.
10. Screens that make strong store screenshots: the first 2-3 must sell the
    concept with a short, benefit-led caption, on real UI.

(Performance, vitals, localisation, ratings and nomination timing are later
work; do not make them harder.)

## 10. What each director owes

Output goes in `docs/redesign-2026/directions/<name>/` (lowercase, one word or
hyphenated). Two parts.

**A. `brief.md` (at most 1,500 words):**
- A name and a one-paragraph thesis: the point of view, and what makes it
  recognisable with the logo covered.
- **Rulings overturned:** an explicit list from section 7, each with its reason.
  "None" is a valid answer; silence is not.
- Tokens: type (OFL faces, scale, weights), palette with the AA contrast ratio
  of every text/background pair, accent rule, radii, elevation/material, motion
  tokens (durations and `linear()` springs) and the reduced-motion substitute.
- iOS vs Android stance (shared language or per-platform).
- How each of the five differentiators in section 3 is made visible.
- The signature moment, and the car/glance posture decision.
- Each technique tagged Web / Web+ / Native, and the top three risks.
- Which of the 10 problems in section 5 it fixes, and how.

**B. A clickable prototype** (`prototype/index.html` plus its CSS/JS):
- The six hero screens from section 2, linked so the flow can be clicked: Home →
  Foray detail → Now Playing (full ↔ mini), Search, Library (with Up Next),
  Onboarding first screen.
- The listed states for each, selectable (for example by a query parameter), so
  the harness can render them.
- **Real data:** `data/catalog-client.json`, `data/discover.json`,
  `data/session.json`, not lorem ipsum. Copy rules apply.
- **Real artwork, never committed:** load podcast artwork from its published
  URL at runtime. No downloaded images in the repo.
- Written as if under the app's CSP: no inline `style=` or `<script>`, fonts
  self-hosted, one `prefers-reduced-motion` block, so Phase 3 can port it.
- Renders correctly at 393x852, 375x667 and 412x915, including long-title
  stress.

**Process.** Three critique-and-revise rounds, then a pairwise, provenance-blind
judge ranking against today's 4a and the other directions. Read
`judge/rubric.md` (twelve dimensions) before you start. The owner then picks
about two directions to build.

Make the call, write down why, and keep going. No questions.
