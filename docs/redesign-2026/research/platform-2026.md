# Platform design state, late 2026, for 4a (Capacitor)

Redesign 2026, Phase 1 research. Feeds `../design-brief.md`.

Items marked (unverified) come from the researcher's own knowledge or were not
confirmed by a fetched page. Joey is on Android and Wyatt on iPhone; iPad is
out of scope.

## 1. iOS 27 and refined Liquid Glass

What changed at WWDC 2026 (June), per MacRumors, Tom's Guide and TweakTown:
- **Readability.** Glass now "more effectively diffuses complex content".
  Default transparency is lower. Elements get a darkened edge and brighter
  specular highlights for separation.
- **Clear-to-tinted slider.** Settings, Appearance, Liquid Glass. The user picks
  any level between More Clear, Default and More Tinted. This replaces iOS
  26.1's binary Clear/Tinted toggle.
- **Toolbars.** When content scrolls under floating bars, a uniform toolbar
  backing appears across the top so text stays legible.
- **Icons.** Rendered sharper, with optional refraction.
- **Adoption.** Existing apps get many improvements automatically on iOS 27,
  without recompiling. The design follows Reduce Transparency and Increase
  Contrast.
- **Tab bar and sheets** (iOS 26 behaviour that carries forward). The tab bar
  floats and minimises on scroll, and can carry a bottom accessory view: the
  native slot for a mini player. Sheets have a glass background that morphs
  between partial and full height, and can morph out of the presenting button.

Implications for 4a:
- The platform's own lesson is that glass over busy content failed on
  readability. Any 4a "glass" must be conservative: high tint, a solid
  fallback, and AA contrast.
- A WebView cannot follow the user's slider setting. Reading Reduce Transparency
  or Increase Contrast via `prefers-reduced-transparency` or `prefers-contrast`
  is the closest honest equivalent.
- Now Playing should follow the pattern of a mini player docked above the tab
  bar, expanding to a full sheet.

HIG sources: Apple's WWDC25 sessions "Get to know the new design system" (356),
"Build a UIKit app with the new design" (284) and "Build a SwiftUI app with the
new design" (323). The iOS 27 HIG pages themselves were not fetched; check them
for any 2026 deltas.

## 2. Android 16/17 and Material 3 Expressive

- M3 Expressive was introduced in May 2025 with Android 16. Android 17 extends
  it with blur and translucent elements, smoother motion, and redesigned system
  menus and Quick Settings (secondary sources; see the Samflux and Android
  Authority links).
- At I/O 2026 Material announced an Expressive layout system, new lists and
  menus, and a Compose-first direction. The official M3 blog page returned no
  body text, so details are unconfirmed.
- Expressive's character: spring-based motion, bolder shape and colour, larger
  type, emphasised containers.
- A Material-flavoured 4a would mean shape morphing, spring physics and tonal
  containers. That conflicts with Liquid Glass, so a direction must either
  choose per platform or choose a neutral language. This is a decision for the
  art directors.
- The Android System WebView tracks Chrome, so Joey's phone will be the most
  capable test surface.

## 3. WebView reality (Capacitor: WKWebView and Android System WebView)

| Feature | Credibility | Notes |
|---|---|---|
| `backdrop-filter` | Good (unverified for 2026) | Supported in WebKit (with `-webkit-`) and Chromium. GPU-heavy; keep the blurred area small and layers few. It blurs only web content behind it, not native content. Real glass refraction is not possible. |
| View Transitions, same-document | Good | Chrome/Edge 111+, Firefox 133+, Safari 18+ (caniuse, DEV, DebugBear). WKWebView inherits WebKit, so iOS 18+ should work (inferred, not confirmed). Cross-document is Chromium-only, irrelevant for an SPA. Always feature-detect and fall back. |
| CSS `linear()` easing (springs) | Good (unverified) | Shipped across engines in 2023-24. Generate spring curves offline and inline them as tokens. The cheap way to get Expressive- or iOS-like springs. Fixed-duration approximations, not interruptible physics. |
| Scroll-driven animations | Good on iOS 26+ | Safari 26 shipped them and 26.4 runs them on the compositor thread (WebKit blog). Chromium has had them since 115. Use for collapsing headers and mini-player reveal; guard with `@supports (animation-timeline: scroll())`. |
| Safe areas | Good | `env(safe-area-inset-*)` with `viewport-fit=cover`. Required for floating bars. |
| Dynamic Type | Weak | WKWebView does not follow system text size reliably. Use rem-based type, and possibly `-apple-system-body` where it works (unverified). Android honours font scale through WebView text zoom. Do not promise parity. |
| Rubber-band, momentum, sheet-drag physics | Mixed | Overscroll feels native; custom drag gestures need pointer-event care. Watch for conflicts with edge-swipe back. |

What reads as fake:
- Faux-iOS chrome on Android, or Android chrome on iOS.
- A static blur that does not follow scroll.
- Bounce or spring timing that ignores the user's reduce-motion setting.
- Hairline borders imitating glass edges that cannot respond to light.
- Hand-drawn lock-screen or status-bar imitations.

Credible tactics:
- Be confidently web-native: strong typography, artwork-led colour, and tinted
  solid surfaces with a restrained blur.
- Use motion tokens (`linear()` springs) and View Transitions for shared-element
  moves, for example a cover moving from card to Now Playing.
- Ship one reduced-motion block (hard limit).

## 4. Cheap native touches through Capacitor

Official `@capacitor/*` plugins:
- **Haptics.** Impact, selection and notification feedback. Use on play/pause,
  scrubber snap, bookmark and tab change. The cheapest "feels native" win.
  Android feedback is coarser.
- **Status Bar.** Style and overlay, per theme. Dark-only means a light-content
  style.
- **Share.** The native share sheet, for existing deep links such as
  `#/episode/<id>?t=N`.
- **Media session and lock screen.** Capawesome's and Capgo's
  `capacitor-media-session` (also `vrwarp/capacitor-media-session`) provide
  lock-screen and notification controls, metadata, artwork and media keys. High
  value for a podcast app: Now Playing and Control Center on iOS, the media
  notification on Android. Check whether the current app already uses it before
  adding anything.
- **Others worth listing** (unverified): keyboard resize, app badge, local
  notifications, native context menus via community plugins.

## 5. App Review Guideline 4.2

- Official text: "Your app should include features, content, and UI that elevate
  it beyond a repackaged website." 4.2.2: "Other than catalogs, apps shouldn't
  primarily be marketing materials, advertisements, web clippings, content
  aggregators, or a collection of links." (Apple's App Review Guidelines.)
- Reviewers reject wrappers that load a responsive site with no native
  navigation, offline behaviour, push, or device integration (MobiLoud, AscAuto,
  appcompliance.io).
- 4a is a content-curation app, so the 4.2.2 "content aggregator" wording is the
  exposure. The redesign should show:
  - **Native integration.** Lock-screen and Control Center playback, haptics,
    share sheet, background audio, offline downloads (shipped, PQ-19) and
    local-file playback.
  - **App-specific UX.** Tab bar and sheet patterns, gestures and transitions
    that do not look like a website in a frame.
  - **Original value.** Curation and recommendation logic, session building,
    bookmarks and timestamp deep links. Reviewer notes should say the curation
    is the product, not a link list.
  - **Performance.** Instant launch, no white flash, no browser chrome, offline
    behaviour.
- Design reduces risk, but reviewer notes and demonstrable native features carry
  most of it.

## Open items for later phases

1. Confirm `backdrop-filter` and `linear()` support floors against caniuse or
   MDN (not fetched).
2. Read the live iOS 27 HIG pages on tab bars, sheets and Now Playing.
3. Get the Google I/O 2026 M3 specifics from the primary source (the fetch
   returned empty).
4. Test View Transitions on a real WKWebView; support is inferred from Safari.

## Sources

- https://www.macrumors.com/2026/06/10/how-liquid-glass-is-changing-in-ios-27/
- https://www.tomsguide.com/phones/iphones/ios-27-has-a-bunch-of-changes-including-a-refined-liquid-glass-design-but-how-much-has-changed-from-ios-26
- https://www.tweaktown.com/news/112090/apple-is-adding-a-liquid-glass-slider-in-ios-27-after-a-year-of-user-complaints-about-readability/index.html
- https://www.techradar.com/phones/ios/liquid-glass-isnt-going-anywhere-in-ios-27-but-theres-good-news-for-its-readability
- https://twit.tv/posts/tech/ios-27-upgrades-liquid-glass-and-toolbar-changes-you-should-know
- https://developer.apple.com/videos/play/wwdc2025/356/
- https://developer.apple.com/videos/play/wwdc2025/284/
- https://developer.apple.com/videos/play/wwdc2025/323/
- https://m3.material.io/blog/whats-new-at-io26
- https://www.androidauthority.com/google-material-3-expressive-features-changes-availability-supported-devices-3556392/
- https://blog.google/products-and-platforms/platforms/android/material-3-expressive-android-wearos-launch/
- https://www.samflux.com/2026/05/android-17-material-3-expressive-and.html
- https://caniuse.com/view-transitions
- https://www.debugbear.com/blog/view-transitions-spa-without-framework
- https://webkit.org/blog/17333/webkit-features-in-safari-26-0/
- https://webkit.org/blog/17862/webkit-features-for-safari-26-4/
- https://webkit.org/blog/17101/a-guide-to-scroll-driven-animations-with-just-css/
- https://github.com/ionic-team/capacitor-plugins
- https://capawesome.io/docs/sdks/capacitor/media-session/
- https://capgo.app/plugins/capacitor-media-session/
- https://developer.apple.com/app-store/review/guidelines/
- https://www.mobiloud.com/blog/app-store-review-guidelines-webview-wrapper/
- https://ascauto.org/rejections/guideline-4-2
- https://appcompliance.io/blog/apple-guideline-4-2-minimum-functionality/
