# Featurability research: App Store and Google Play (2025-26)

Redesign 2026, Phase 1 research. Feeds `../design-brief.md`. `../PLAN.md`'s
limits shape the checklist: no icon work, no third-party imagery in the repo,
and a 44px tap-target floor.

Confidence labels: **[Official]** is Apple or Google text that was fetched.
**[3rd-party]** is an ASO-blog claim not verified against a primary source.

## 1. Apple: stated featuring criteria [Official]

Source: https://developer.apple.com/app-store/getting-featured/

Apple lists these factors:
- **User experience:** "cohesive, efficient, and valuable functionality that's
  helpful and easy to use."
- **UI design:** usability, appeal, "beautiful visuals or intuitive gestures and
  controls."
- **Innovation:** new technologies that solve a unique problem.
- **Uniqueness:** "a fresh approach to a familiar category that stands out from
  the crowd or defines a new genre."
- **Accessibility:** a great experience for a broad range of users, with
  well-integrated features.
- **Localization:** high-quality support for multiple languages with culturally
  relevant content.
- **Product page:** compelling screenshots, previews and descriptions, plus
  positive ratings and reviews.

Apple says all apps are eligible regardless of age or size. One ASO blog adds a
"4.5+ rating baseline" and "story and timeliness" as factors; treat both as
[3rd-party], not Apple text
(https://asomobile.net/en/blog/app-store-and-google-play-featuring-2026-how-to-get-into-editorial-collections/).

## 2. App Store Connect Featuring Nominations

Sources:
https://developer.apple.com/help/app-store-connect/manage-featuring-nominations/nominate-your-app-for-featuring/
and https://developer.apple.com/news/?id=nx3eotat (Nov 2024 launch of
nominations).

- **Types [Official]:** App Launch (a new app or a pre-order); App Enhancements
  (new features or a significant update); New Content (content, offers or
  In-App Events). The landing page also lists "developer stories" as a content
  type.
- **Required fields [Official]:** nomination name, type, description (what is
  changing, purpose, priority, objectives), and publish date or range.
- **Optional fields [Official]:** up to 10 related apps; platforms and
  countries; localizations; attached In-App Events (iPhone and iPad only); up
  to 5 supplemental URLs (documents, assets, TestFlight links); notes on
  accessibility and inclusivity.
- **Roles [Official]:** Account Holder, Admin, App Manager or Marketing.
- **Submission [Official]:** one at a time, or in bulk by CSV. CSV uploads submit
  immediately with no draft. Submitted nominations can be edited.
- **Lead time:** the ASC help page says a **minimum of 3 weeks**. Apple's
  featuring page says a minimum of 2 weeks and recommends up to 3 months. The
  sources conflict, so plan for the stricter figure: submit at least 3 weeks
  out, ideally 8-12 weeks. Editorial planning reportedly runs 8-12 weeks ahead
  [3rd-party: https://www.apptweak.com/en/aso-blog/how-to-get-your-app-featured-on-the-app-store].
- **After selection [Official]:** Apple emails a request for promotional artwork,
  so read its promo-art guidelines in advance. Apps featured on the Today tab
  get an App Store Connect notification plus Apple-designed shareable assets.
- **Writing the description [3rd-party]:** explain what changed, why it matters,
  and the backstory or accessibility work. Editors value the human side.
- **Implication for 4a:** a nomination needs a real shipped, TestFlight-able
  build. Lab builds are a separate app id, so nominate the production app near
  its redesign release.

## 3. Apple Design Awards

Source: https://developer.apple.com/design/awards/ (2026 page). ADA is separate
from editorial featuring, but it shows what Apple's design team rewards.
[Official]

Six categories, one app and one game winner each:
1. **Delight and Fun:** memorable, engaging, satisfying experiences enhanced by
   Apple technologies.
2. **Inclusivity:** a great experience for all, reflecting varied backgrounds,
   abilities and languages.
3. **Innovation:** state-of-the-art, novel use of Apple technologies that sets
   the app apart in its genre.
4. **Interaction:** intuitive interfaces and effortless controls tailored to the
   platform.
5. **Social Impact:** improves lives and shines a light on crucial issues.
6. **Visuals and Graphics:** stunning imagery, skilfully drawn interfaces,
   high-quality animation, with distinctive and cohesive themes.

Winner signals from the 2026 page:
- Inclusivity: Guitar Wiz, praised for VoiceOver, Dynamic Type, Increased
  Contrast and Differentiate Without Color.
- Interaction: Moonlitt, built with SwiftUI and Liquid Glass.
- Visuals: Tide Guide, using Liquid Glass and custom animation.

The 2025 awards (https://developer.apple.com/design/awards/2025/) gave
Inclusivity to Speechify, an audio app, and listed Moises, a music app, as an
Innovation finalist.

Pattern: winners adopt the current platform design language and Apple
technologies, and accessibility is itemised feature by feature.

## 4. Google Play

Sources: https://developer.android.com/quality [Official]. Vitals thresholds and
Editors' Choice details are [3rd-party] unless noted.

- **Four pillars [Official]:** Core Value, User Experience, Technical Quality,
  Privacy and Security.
- **Good vs great [Official]:** "great" apps, the ones Google features, are also
  delightful to use, make the most of premium devices and are designed for
  safety.
- **Form factors [Official]:** featuring weighs quality across every supported
  form factor (large screens, foldables, Wear, TV, Auto). Phone-only is
  acceptable only if the app does not claim other form factors.
- **Vitals targets [3rd-party]:** user-perceived crash rate below 1.09%; ANR rate
  below 0.47%; excessive partial wake locks below 5% of sessions; measured over
  a 28-day window.
- **Editors' Choice [3rd-party]:** hand-curated for quality, UI, long-term
  popularity and innovative use of Android features. There is no application
  form. A median rating of about 4.5 was reported before the award
  (https://sensortower.com/blog/how-top-developer-and-editors-choice-badges-showcase-googles-favorite-apps).
- **Nomination route [3rd-party, unverified]:** Play Console, Grow, Store
  presence, Promotional content (the older Featuring / "Promote" flow). An
  account manager exists for larger developers only. Lead time is reportedly
  4-6 weeks.
- **Gap:** Material 3 Expressive and edge-to-edge could not be confirmed as
  stated featuring criteria. Both are inference, not Google text.

## 5. What editorial stories highlighted for podcast and audio apps

Evidence here is thin. Searches returned no Apple or Google editorial text about
podcast apps in 2025-26.
- Overcast carries Apple "Editors' Choice" status on its App Store page. Pocket
  Casts was App of the Day in June 2019
  (https://apps.apple.com/us/app/overcast-podcast-app/id888422857). Both are old
  and are search-snippet evidence only.
- Recent audio recognition: Speechify won ADA Inclusivity in 2025 on
  accessibility, and Moises was an Innovation finalist for ML stem separation.
  Both show Apple rewarding a distinct capability plus accessibility depth over
  generic player polish.
- Gap: Today-tab story texts for podcast apps were not retrievable. A follow-up
  could fetch the App Store Awards 2025 pages
  (https://www.apple.com/newsroom/2025/12/apple-unveils-the-winners-of-the-2025-app-store-awards/).

## 6. Store assets that convert (2026 conventions)

All [3rd-party] unless noted. Sources:
https://theapplaunchpad.com/blog/app-store-screenshot-guidelines/,
https://appscreenshotstudio.com/blog/app-store-preview-videos-the-2026-conversion-guide,
https://www.applaunchflow.com/blog/google-play-promo-video-requirements-2026,
https://support.google.com/googleplay/android-developer/answer/9866151 [Official
help page].

**App Store screenshots:**
- Only the first 2-3 appear in search results, so front-load the strongest.
- Short, benefit-led captions, not feature names.
- Real in-app UI.
- High contrast and bold colour reportedly convert better.

**App Store preview video:**
- 15-30 seconds, up to 3 per localization.
- iPhone size 886x1920 (per the cited blogs); H.264 or ProRes; at most 500 MB.
- Autoplays muted, so use legible overlays and show touch.
- Hero action in the first 3 seconds, with no logo or fade intro.
- Apple restricts previews to real in-app footage. Confirm against the current
  App Review guidelines before building one.

**Google Play:**
- JPEG or 24-bit PNG with no alpha; each side 320-3,840 px; at most 8 MB.
- Featuring eligibility reportedly needs at least 4 screenshots at 1080 px or
  more, including one 16:9 landscape image of at least 1920x1080.
- Feature graphic is 1024x500 and mandatory.
- Promo video is a YouTube link under 30 seconds, ads disabled, at least 80%
  real app footage.

Verify all specs against the official Play Console and App Store Connect help
pages before the Phase 5 store kit. Blog numbers drift.

## 7. Featurability checklist for 4a design

Each item maps to a stated criterion above.

1. Adopt the current platform design language (iOS Liquid Glass, Android
   Material 3 Expressive). ADA winners did; the Android half is inference.
2. Make one distinctive idea visible in the first 3 seconds: "a fresh approach
   to a familiar category", which for 4a is curated, anti-echo-chamber
   discovery.
3. Use platform-native interaction: standard gestures, sheets, haptics, and
   system share / Now Playing / Lock Screen / CarPlay / Android Auto
   integration.
4. Give a signature moment of delight, such as a Now Playing transition. Delight
   is its own ADA category.
5. Use a cohesive, distinctive visual theme: type, colour, motion and artwork
   treated as one system (the ADA Visuals criterion).
6. Test accessibility and list it feature by feature: VoiceOver/TalkBack,
   Dynamic Type or font scale, Increased Contrast, Differentiate Without Color,
   reduced motion, 44px targets, AA contrast. State it in the nomination.
7. Show which Apple technology or Android feature the app uses well (App
   Intents, widgets, Live Activities, Media3). Innovation is judged on novel use
   of platform technology.
8. Perform: cold start, scroll and player responsiveness with no jank. Meet Play
   vitals (crash under 1.09%, ANR under 0.47%).
9. No crashes or dead ends. Offline and slow-network states are designed, not
   defaulted.
10. Localize at least the store listing and key UI. Localization is a stated
    Apple factor; 4a is English-only today.
11. Support all claimed form factors on Android, or claim only phone. iPad is
    out of scope per PLAN.
12. Keep privacy and security clean: a privacy label and no dark patterns. This
    matches Google's fourth pillar and our product principles.
13. Keep the first-run experience quick, with no forced account and value in
    under a minute.
14. Reach a strong rating (4.5 or better) before nominating [3rd-party
    threshold]. Seed it through TestFlight and honest in-app prompts.
15. Have a story: why it exists, what is new, a developer backstory. Use
    "Developer story" and "New Content" nominations and In-App Events.
16. Nominate a real release (App Launch or App Enhancements) at least 3 weeks
    ahead, ideally 8-12. Include a TestFlight link in the supplemental URLs.
17. Prepare Apple's promo artwork, requested after selection, in advance (the
    icon is out of scope for this effort).
18. Screenshot set: 2-3 hero shots with benefit captions on real UI. Use only our
    own renders, and keep third-party imagery out of the public repo.
19. Preview video: 15-30 seconds, hero action first, readable muted, real
    footage only.
20. Play assets: 4 or more screenshots at 1080 px or higher including one 16:9,
    a feature graphic, and a YouTube promo video that is at least 80% real
    footage.

## Caveats

- Several ASO claims are unverified third-party blogs, as labelled.
- Apple's own pages disagree on minimum lead time (2 versus 3 weeks).
- No primary evidence was found on how editors have written about podcast apps
  recently.
- Editorial featuring is discretionary. No checklist guarantees it, and Apple
  states no numeric thresholds.
