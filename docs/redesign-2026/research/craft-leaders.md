# Craft techniques from 2025-26 celebrated apps, for 4a (Capacitor)

Redesign 2026, Phase 1 research. Feeds `../design-brief.md`.

**Evidence caveat.** Source material was thin: Apple's winner blurbs, Apple's
Flighty profile, and search snippets. A fetch of the Airbnb Lava article
returned 403. Items marked **(S)** come from a source. Items marked **(J)** are
my judgment or standard practice, not claims about those apps. Specific
durations and spring values are (J) starting points to tune on device, not
measurements of any app.

## 1. What the sources actually say

**2026 Apple Design Awards** (36 finalists, six categories):
- **Tide Guide** (Visuals and Graphics): the palette changes to match the sky
  colour through the day. Hour-by-hour forecast, water temperature and swell
  height are shown "crisp, clear". (S)
- **Moonlitt** (Interaction): a 3D map where layer icons toggle the moon's path.
  Apple calls it "simple elegance". (S)
- **grug** (Delight and Fun): a scribbled, hand-drawn aesthetic, a custom
  hand-drawn status bar, and Home Screen widgets that deliver the content. (S)
- **Primary** (Social Impact): a spatial Vision Pro interface for news, with
  spatial video. Not relevant to a phone WebView app. (S)
- **Guitar Wiz** (Inclusivity): VoiceOver, Dynamic Type, Increase Contrast and
  Differentiate Without Color are all supported. (S)
- **Sago Mini** (Interaction): swipe controls that need no reading. (S)

**Flighty** (Apple "Behind the Design"): (S)
- Visual language borrowed from airport signage, one line per flight like a
  departure board.
- Live Activities and Dynamic Island. It switches to offline-capable progress
  displays before takeoff, because connectivity will be lost.
- Widgets, and shareable live status that works for non-users.
- The team made about 20 design variations at concept stage, including "bad"
  ideas.
- The 2025 Live Activity refresh uses a "glowing glass" look. A "black-light"
  effect is cited as a refined detail.

**Airbnb 2025 redesign** (S, search snippets only):
- "Lava" is a custom 3D animated icon format, effectively a tiny alpha-channel
  video, built because Lottie and normal video fell short.
- The direction moves away from flat minimalism toward tactile 3D, soft curves,
  lighting and drop shadows.

**Things 3** (S):
- The "Magic Plus" button is dragged to an insertion point in the list. It
  deforms slightly, like a liquid, as it moves, and the list opens a gap inline.
- Every gesture has a subtle animation that explains what is happening.

**Partiful:** animated backgrounds and custom fonts, with customisation that
stays manageable. The tone is deliberately playful rather than corporate. (S)

**Arc Search:** "Browse for me" reads several pages and builds a single
sectioned page. (S)

I found nothing usable on (Not Boring) or Retro in this pass.

## 2. Transferable techniques, with feasibility

Feasibility key: **Web** = fully in the WebView. **Web+** = WebView plus an
existing Capacitor plugin. **Native** = needs custom native code.

### Typography

1. **One distinctive display face plus a plain text face, with a tight size
   scale.** (J, general practice; Partiful and grug both lean on personality in
   type.) Self-host variable fonts. Use `font-variation-settings` to animate
   weight on state change, such as the active tab or the playing episode title.
   **Web**.
2. **Dynamic Type equivalence.** Guitar Wiz shows the bar. Size type in `rem`
   and test at 200%. On iOS, WKWebView follows system text size only if you opt
   in with `-apple-system-body` or the Capacitor text-zoom setting. **Web+**.
3. **Tabular numerals for times and durations** (`font-variant-numeric:
   tabular-nums`), so the scrubber and countdowns do not jitter. Same logic as
   Flighty's board-style readouts. **Web**.
4. **Hand-made character as the delight lever** (grug). Custom lettering or
   drawn marks on a few surfaces only, such as the empty state, onboarding and
   a splash. Use SVG or WOFF2. **Web**.

### Colour and material

5. **Time-of-day or content-driven palette** (Tide Guide). Drive CSS custom
   properties from the clock, or from the current artwork's dominant colour for
   the player. Transition with `@property`-registered colours. Extract the
   colour once on a canvas and cache it. **Web**.
6. **Glass and blur** (Flighty, and Apple's current material language).
   `backdrop-filter: blur() saturate()` works in WKWebView. It costs GPU and
   battery on long scrolling lists, so limit it to the nav bar, the mini player
   and sheets. It will not match true Liquid Glass refraction. **Web** for the
   approximation, **Native** for the real material.
7. **Depth through light, not just shadow** (Airbnb's soft lighting). Layered
   gradients plus two-layer shadows (one tight, one diffuse). **Web**.
8. **Dark mode as a designed palette, not an inversion.** `prefers-color-scheme`
   plus an in-app override. **Web**.

### Motion

9. **Springs, not eases.** CSS `linear()` can encode a spring curve (J,
   supported in current WebKit). Alternatively use the Web Animations API or
   Motion's spring helpers. Starting points to tune: sheets about 350-450 ms,
   small state changes 150-220 ms, slight overshoot only on playful elements.
   **Web**.
10. **Shared-element transitions** from the episode row artwork to the player
    artwork. The View Transitions API makes this a few lines in modern WebKit.
    For older WebViews, use FLIP with the Web Animations API. A Capacitor plugin
    (`@capgo/capacitor-transitions`) offers iOS-style push and pop plus an
    edge-swipe-back gesture that tracks the finger. **Web** (or **Web+** with
    the plugin).
11. **Gesture-following, interruptible motion.** Things' liquid button follows
    the finger. Use pointer events with `touch-action` set correctly, drive
    transforms directly while dragging, and hand off to a spring on release.
    Never block on an animation finishing. **Web**.
12. **Insert-with-gap list changes** (Things Magic Plus). Animate height and
    `translateY` of neighbours when an item is added, removed or reordered.
    Applies to queue reordering. **Web**.
13. **Honour `prefers-reduced-motion`** by swapping motion for fades. **Web**.
14. **Keep motion off the main thread.** Animate only `transform` and
    `opacity`; avoid animating layout properties. (J) **Web**.
15. **Animated icons.** Airbnb's Lava is a custom alpha video. In a WebView the
    cheap equivalents are small Lottie or Rive files, or animated SVG. Alpha
    video is risky: iOS plays HEVC-with-alpha in Safari but Android WebView does
    not, so test both. Use sparingly on a few hero moments. **Web** for Lottie,
    Rive and SVG; alpha video is **Web** on iOS only, with caveats.

### Haptics

16. **Pair selection, impact and notification haptics with specific moments**
    (J, standard iOS practice): a selection tick when scrubbing past chapters or
    segments, a light impact on play and pause, a success notification when a
    download completes. The official Capacitor Haptics plugin covers impact
    styles, notification and selection feedback. **Web+**.
17. **Custom haptic patterns** (Core Haptics sharpness and intensity). Only via a
    third-party plugin with a typed pattern API, or custom native code.
    **Native**, or **Web+** with a third-party plugin. Weak return; skip it
    unless the player needs a signature moment.
18. **Haptics only where the web has no equivalent**, gated behind the system
    setting. (J) The `navigator.vibrate` fallback does nothing on iOS. **Web+**.

### Empty and loading states

19. **Skeletons that match the final layout**, with a shimmer that respects
    reduced motion. **Web**.
20. **Empty states as character moments** (grug's drawn tone, Partiful's
    playfulness). One illustration, one line of copy, one action. Must obey 4a's
    copy rules (no "fascinating", no "deep dive"). **Web**.
21. **Graceful degradation made visible** (Flighty's offline-ready progress
    display). Downloaded episodes should play with no spinner, and the UI should
    clearly show which items are available offline. **Web+** (download and
    local-file playback already exist).
22. **Optimistic UI:** change state immediately, reconcile later. **Web**.

### Onboarding

23. **Show the product, not a tutorial.** (J) Open on a real example surface, ask
    for as little as possible, and let observed behaviour fill the rest. This
    matches 4a's "state observed, never declared" principle. **Web**.
24. **Concept breadth before polish** (Flighty's ~20 variants). A process
    technique: generate many layouts for Home and the player before choosing.
    **n/a**.
25. **Arc Search's "Browse for me" pattern:** one request becomes one assembled
    page with sections. For 4a, a "why this pick" or bridge explanation card for
    stretch picks fits product principle 4. **Web**.

### Delight details

26. **Surfaces outside the app** carry much of the craft in Flighty and grug:
    widgets, Live Activities, Dynamic Island. These need native code (WidgetKit,
    ActivityKit). For a podcast app the lock screen and Control Center player
    come from the media session, which Capacitor can drive through a
    media-session plugin. Live Activities and widgets are **Native**.
27. **Chrome-level whimsy** such as grug's hand-drawn status bar is possible only
    by styling content under a transparent status bar. **Web**.
28. **Dynamic, living colour** (Tide Guide) is the cheapest high-impact delight
    for 4a, since podcast artwork already supplies the colour. **Web**.

## 3. Summary for the plan

**Do in the WebView** (high value, low risk): variable-font display type,
tabular numerals, artwork-driven palette, spring motion via `linear()`, View
Transitions or FLIP shared-element moves from row to player, interruptible
gestures, skeleton and empty-state character, reduced-motion support.

**Do through plugins:** haptics (Capacitor Haptics), iOS-style navigation
transitions and swipe-back (`@capgo/capacitor-transitions`; check maintenance
and compatibility with the current Capacitor version first), media session
controls.

**Needs native code:** real Liquid Glass materials, Core Haptics patterns,
widgets and Live Activities, anything spatial. Defer unless the founders want
them.

**Risks:** `backdrop-filter` and large blurs on older Android WebViews; View
Transitions support varies by WebView version, so ship the FLIP fallback; alpha
video differs by platform; animation tuning must be tested on a physical
device, not a desktop browser.

**What would improve this research:** the Airbnb Lava engineering write-up
(403 here), Apple's per-winner developer interviews, and hands-on screen
recordings of Things, Flighty and Partiful to measure real durations. Not Boring
and Retro were not covered.

## Sources

- [Apple reveals 2026 Apple Design Award winners](https://www.apple.com/newsroom/2026/06/apple-reveals-winners-of-the-2026-apple-design-awards/)
- [Meet the 2026 Apple Design Award Winners (App Store)](https://apps.apple.com/us/mac/story/id1896834601)
- [Meet the 2026 Apple Design Award Finalists (App Store)](https://apps.apple.com/us/iphone/story/id1896567319)
- [MacRumors on the 2026 ADA winners](https://www.macrumors.com/2026/06/02/apple-design-award-winners-2026/)
- [Behind the Design: Flighty (Apple Developer)](https://developer.apple.com/news/?id=970ncww4)
- [Flighty Live Activity "glowing glass" announcement](https://x.com/Flighty/status/1967632929343017412)
- [Airbnb's "Lava" icon format (Medium, search snippet only)](https://medium.com/@waldobear002/airbnbs-new-lava-icon-format-a-technical-deep-dive-b2604626c7e0)
- [Airbnb Summer 2025 update (Medium)](https://medium.com/design-bootcamp/airbnb-summer-2025-update-heres-what-s-new-and-why-it-matters-0ced2338b921)
- [Things 3: Beauty and Delight in a Task Manager (MacStories)](https://www.macstories.net/reviews/things-3-beauty-and-delight-in-a-task-manager/)
- [Design Critique: Partiful (Pratt)](https://ixd.prattsi.org/2025/02/design-critique-partiful/)
- [Arc Search "Browse for me" (TechCrunch)](https://techcrunch.com/2024/01/28/arcs-new-iphone-browser-wants-to-be-your-search-companion)
- [Cap-go/capacitor-transitions](https://github.com/Cap-go/capacitor-transitions)
- [Capacitor Haptics plugin (Capawesome)](https://capawesome.io/docs/sdks/capacitor/haptics/)
- [Motion view animations](https://motion.dev/docs/animate-view)
