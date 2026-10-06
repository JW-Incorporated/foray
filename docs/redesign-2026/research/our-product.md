# 4a design record: product, differentiators, founder rulings, open questions, brand

Redesign 2026, Phase 1 research. Feeds `../design-brief.md`.

Sources are in-repo. Section and date references point to `docs/DECISIONS.md`.
Further references: `docs/ux/README.md`, `docs/ui-transition-plan.md` (D1-D11),
`docs/audit/status.tsv` (278 rows), `docs/brief/01_PROMPT.md`,
`docs/ux/foray-mockup.jsx` (tokens only). `docs/research/corpus/digests.md` has
nothing on audio UX; it covers podcast infrastructure, ASR, DAI, loudness and
legal topics.

## 1. What the product is, and for whom

4a was Foray until the 2026-08-21 rename. It is a personal AI podcast curator
that finds real, existing podcasts and arranges them for you. Live site:
jw-incorporated.github.io/foray. The shipping app is a Capacitor shell around a
vanilla-JS web player, with iOS and Android builds. The tagline kept in D11 is
"Podcasts, stitched around you."

- **Origin use case.** The original brief was one user in a car. A session is
  ready at the start of a commute and shows about 4 options. You pick by tap or
  voice. Intros and transitions are narrated. The brief calls for hands-free
  control, offline-first playback and car-safe UX: "No interaction may require
  reading the screen while playing."
- **Who it is for now.** The founders and their circle. Joey (CEO) uses Android
  and Wyatt (CTO) uses an iPhone. Both judge behaviour and outcomes, not code.
  The app is anonymous-first, with no login wall (ADR-0005, D2).
- **Posture.** 4a is a curator and client, not a host. It plays publisher
  enclosure URLs only. A foray is "seek-and-stop against the publisher's
  original enclosure" (Wyatt, 2026-08-11). It never produces a derived audio
  file, and copy must not imply that it does ("clipping", "stitching").
- **Listener model.** Interests are weighted and visible; the Interests screen
  has sliders (D6). State is observed, never declared. Commute length is a
  learned parameter and never appears in the UI.

## 2. Differentiators a design must make visible

1. **Forays.** A foray (lowercase common noun) is a timeline of segments
   alternating narration and source clips. The segment strip is the identity
   element and doubles as the scrubber. Bars are proportional to runtime, with a
   stable per-show colour from `--seg-c0..7`. Narration is violet. The current
   bar fills as it plays. A "Where this came from" credit block links out to the
   real shows. Resume is per foray. Forays are the whole point of the app, yet
   audit persona 83 found them "unexplained after one dismissible sheet, and
   there is only one to play". Narration plays at 1x (founder 2026-09-24: "1x
   for now, but maybe we change later. I recall 1x felt like 0.6x or so, it was
   very slow").
2. **Daily picks with why-lines.** Home is built from sections: greeting plus a
   play button, Jump back in, Forays for you, Playlists for you, and Suggested.
   Why-lines are 18 words or fewer and hooks 16 or fewer. A why-line states the
   actual reason for a pick. "Subject" replaces "topic".
3. **Stretch picks with bridges.** Each "for you" rail reserves at least one
   visibly labelled Stretch slot, with a required bridge line saying why the pick
   is suggested, which is never a taste match. Persona 67 notes the explanation
   is currently "the quietest line on the card".
4. **Exploration floor (about 30%).** The floor governs what gets queued. It is a
   hard limit and not open to challenge.
5. **Continuous playback for the car.** When an episode ends, play on: the rest
   of the list, then more of what fits. Hands-free is the case that matters. The
   lock screen and car controls were designed as a contract: a 15/30 seek pair,
   with a track pair only on headset or car routes. A paused 4a keeps the car's
   audio session. Now Playing and the lock screen are first-class design
   surfaces.
6. **Honesty over polish.** No dark patterns, no streaks, no infinite scroll, no
   fabricated matches. A search that misses says so.

## 3. Founder UI rulings (all open to challenge, per PLAN owner decision 1)

**Principles and positioning**
- **2026-07-08.** Discovery must feel like a "splatter", not a directory. A hard
  30% exploration floor; taxonomy is internal machinery; no two adjacent items
  share a branch. Reason: curiosity and anti-echo-chamber discovery.
- **2026-07-08.** Commute length is demoted from a setting to a learned
  parameter. Reason: state is observed, not declared.
- **2026-08-06.** The first visual pass was a legibility fix, not a redesign. The
  founder deferred "what makes this any different... other than it looks
  shitty" to a bigger pass. Reason: a first-visit user said "I don't have any
  clue what this app does", so a subject card now heads with the subject, not an
  episode title.
- **2026-08-11.** Seek-and-stop playback only, no derived audio. Reason: legal
  posture.
- **2026-08-21.** The app is renamed 4a and the unit stays "foray". Reason: one
  meaning per word.

**The 2026-09 redesign (ui-v2)**
- **2026-09-06, U-01.** Dark-only ui-v2 tokens, Fraunces plus DM Sans
  self-hosted, amber for the listener's own material and violet for what 4a
  authored. No light palette. Reason: the mockup's single palette, and the CSP
  rules out Google Fonts.
- **2026-09-06, D3.** A four-tab bar: Home, Search, Create, Library. It reversed
  #467's menu-page Home. Reason: adopt the mockup.
- **2026-09-06, D1.** The floor is kept in the redesign (gate #123).
- **2026-09-06, D2.** No login wall.
- **2026-09-06, D5/D6/D7.** Playlists for you are generated from subject queues.
  Interests use sliders with no history feed. Search has a Playlists section.
- **2026-09-06, D8.** Custom foray generation is out of the UI for now; Create
  ships playlists only.
- **2026-09-06, D10.** No share sheet and no social layer ("Shared with you").
  The legal-review share gate was withdrawn 2026-10-05, tracked on #1071.
- **2026-09-06, U-11.** Cutover now, with no TestFlight soak (Joey's override).
- **2026-09-06, D9.** The build was incremental, token-first and behind a flag.
  The flag is now retired.

**Visual pass (Wyatt, 2026-09-23: "the visual changes - have at them.")**
- Type by role; a Fraunces italic wordmark; one eyebrow style; one pill shape;
  one artwork treatment; a seven-step radius scale; four elevations; a two-tier
  episode row; a back-15 on the mini bar; the seek pair stays the seek pair
  inside a foray; stretched-link cards; the sheet's boxed "Close" removed.
- Apple Podcasts on iOS is the stated benchmark.
- Dark stays the design. `color-scheme: dark` is declared and the focus ring is
  authored, so an OS set to Light changes nothing.

**Interaction, copy and later rulings**
- **2026-09-23, Wyatt.** Zoom is removed entirely: viewport meta,
  `touch-action`, a gesture guard and Android `zoomEnabled: false`. This
  reverses 2026-09-17. The named cost is that small text can no longer be
  pinched, so type size must compensate. The Dynamic Type bridge is unconfirmed
  on device.
- **2026-09-23, Wyatt.** The drawer closes whenever a control with a destination
  is used. Toggles keep it open (Joey, 2026-08-31).
- **2026-09-23, Wyatt.** The lock screen and the app share 15/30 from one
  source. The lock screen draws the skip pair; the track pair appears only on
  headset or car routes. A paused 4a holds its audio session, so a paused
  session keeps the car.
- **2026-09-23, copy.** In-app copy speaks as "4a", never "we/us/our". Durations
  read "45 min / 1 hr 5 min"; the colon clock is for scrubbers only. A date shows
  its year only when it is not this year. "Subject" replaces "topic". No browser
  words. A zero count is not shown.
- **2026-09-23, Q8 and Q11.** The last onboarding button is "Show my picks". The
  native shell reopens the last page.
- **2026-09-24 (PR #749).** "Episodes for you" is renamed "Suggested" (Wyatt).
  Home gets a play button that starts the first playable item. "Follow" is the
  verb for shows (Wyatt: "Follow and let's add notifications to the roadmap",
  #761). Up Next jumps the played row to the top and removes nothing (Wyatt:
  "disagree, reverse this"). Drag-to-reorder is deferred until after the native
  engine (#762). Foray titles use sentence case with no period; "?" and "!" are
  allowed.
- **2026-09-14, Joey.** Continuous playback is wanted and "no autoplay chains"
  is struck: "This isn't TikTok, we aren't hooking children here, I just want
  more podcasts to play while I'm in the car and can't pick something out for
  myself."
- **2026-09-24, Wyatt.** Narration plays at 1x. Any foray may be published,
  including un-narrated ones, as a "temporary issue" while 4a spins up.

Not covered by any ruling: the mockup's ShowScreen, ShareSheet, Login and
PlayerBridge screens, cover-art generation, and offline downloads. The audit
marked offline downloads "deliberate" even though the brief required
offline-first playback.

## 4. Open design questions never resolved

From the audit and from entries that deferred them.

- The one `deferred-founder` item: no play button on first-run Home (persona
  44). Wyatt answered half of it with the Home play button (2026-09-24, #749).
- A founder-owned visual identity pass. 2026-08-06 deferred it and the
  2026-09-23 pass only partly delivered it. Whether the target is "Apple
  Podcasts grammar" or a distinctive look is open. The owner's "meh" in PLAN.md
  points to the second.
- The Search tab: persona 53/74 found an A-Z list of 220 shows with the field at
  the bottom. Naming was fixed; field position and the A-Z list remain founder
  rulings.
- Create is a primary tab with only half its function built (persona
  26/38/52/77, "deliberate"). Does it earn a tab slot?
- Follow and star have no consequence yet (persona 31/72). Notifications are on
  the roadmap (#761).
- A narrated, published, deterministic foray catalogue. Only one foray is
  playable (persona 83, 55, 14). Foray generation is excluded from the UI (D8).
- First-run Home tells a new listener about "usual subjects" they do not have
  (persona 41/46).
- An undoable Start over (persona 12), and whether spoken narration follows the
  listener's speed (qa 28).
- Whether to rename "Stretch" (persona 67).
- Whether the "daily" framing is honest. The tagline is a founder question
  (qa 149).
- Dynamic Type versus the zoom removal. The compensation is unverified on
  device.
- A narrator voice. Wyatt on the platform voices: "those voices were all so bad.
  Samantha was the least worst". The plan is a bundled Kokoro voice; result
  unmeasured.
- A light palette. No decision exists; ui-v2 is dark-only.
- Share links, now unblocked (#1071), and any Shared with you layer.
- A Show page. It has no data behind it (no follower counts or descriptions).

## 5. Brand state

- **Name.** "4a" on every display surface (pinned by `test/app-name.test.js`).
  Wordmark in Fraunces italic. Identifiers stay Foray (bundle id
  `dev.jwlabs.foura`, `cp_foray:` keys, `?foray=` links, the repo and Pages
  URL). The app icon is out of scope for this effort.
- **Type.** Fraunces (roman and italic) as the display face and DM Sans as the
  text face. Both are self-hosted Latin-subset variable woff2 files under
  `fonts/`, roughly 212KB, with `font-src 'self'`.
- **Palette (mockup and ui-v2).** bg `#151119`, surface `#1F1A26`, surface2
  `#2A2333`, line `#332B3E`, text `#F4F0E8`, muted `#9C93A8`, faint `#6E6579`,
  amber `#F2A33C`, violet `#A78BFA`, good `#4ADE80`. Nine `--*` tokens sit under
  `body.ui-v2`. Amber is the listener's own material (picks, saves, chosen
  controls). Violet is what 4a authored (narration, generated-for-you badges,
  bridges). The audit found the split broken once: "Generated for you" was amber
  on Home and violet on Search; it was fixed to violet.
- **Shape and system.** A seven-step radius scale, four elevations, one pill and
  one eyebrow style, and 44px tap targets. Tokens are pinned by
  `test/ui-tokens.test.js`, `card-anatomy`, `transport-controls` and
  `tap-targets`.
- **Voice.** Plain, honest and specific. 4a speaks as "4a". Copy bans
  "fascinating", "deep dive", "delve" and "explores". Stretch picks must state
  their bridge.
- **Hard limits for any direction.** `esc()` and `safeUrl()`, strict CSP, `cp_`
  storage keys, WCAG AA contrast, one reduced-motion block, and the product
  principles in CLAUDE.md. Founder rulings may be challenged; these may not.
