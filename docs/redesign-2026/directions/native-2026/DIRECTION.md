# Native 2026

**Thesis:** the chrome belongs to the phone; only the content belongs to 4a.
Everything you tap is drawn as iOS 27 or Material 3 Expressive would draw it;
everything 4a *says* (a why-line, a Stretch bridge, a foray's stitching) is
drawn in a voice no system app has. Logo covered, you would still know it: the
one app whose system-grade rows carry a serif sentence explaining themselves,
and whose scrubber is a seam of several shows.

## Mood

Quiet confidence. White or true black, artwork doing the colour work, type
large and settled, chrome that floats and gets out of the way. Warmth from one
amber, podcast art and the serif sentences.

## Platform stance: per platform, one content layer

The shell is adaptive, chosen once at launch (`html[data-os="ios"|"android"]`;
the harness renders both, and every critique round ships both OS modes in both
schemes: critique r2 was the first time Android or light had been seen). The
shell includes the status bar the prototype draws: Android gets Android's. iOS: floating glass bars, collapsing large titles,
sheets with a grabber, bottom search, continuous corners, push/pop. Android:
tonal surfaces, a navigation bar with a pill indicator, top search,
shape-morphing controls, spring motion. The content components (hero card, pick
row, seam strip, bridge card, credits) are identical on both. Faux-iOS on
Android, or the reverse, is refused (brief §8).

## Typography (OFL only)

- **Text face: the system face first, Inter as the shipped fallback.** Stack
  `-apple-system, system-ui, "Inter"`: SF Pro on iOS, Roboto or the OEM face on
  Android, at no byte cost; the harness falls to self-hosted Inter (OFL,
  variable, metrics close to SF). Tabular numerals on clocks. **Web.**
- **Voice face: Newsreader (OFL, variable, optical size + italic)** for exactly
  three things: why-lines, Stretch bridges, narration lines (the sentence 4a
  says, in the credits and in Now Playing). Never titles or chrome. The rule
  is the brand: *serif means 4a is talking to you.* Fraunces is retired
  (overturns the type ruling): its wonk fights a system feel. **The voice is
  never ellipsized** (critique r3: every why-line in a row and the rail's
  bridge headline ended in "..."): rows grow to hold two lines of why-line,
  rail bridge sentences are 12 words or fewer at 17px, and a harness check
  fails the round on any clipped voice element.
- Scale: nine steps, Large Title 34/700 to Caption 12/400 (the iOS text styles,
  shared by Android); Voice 17 italic, bridge 19. Type follows the OS text size.

## Colour: light and dark, one accent (overturns dark-only)

A first-party app follows the system appearance; dark-only is a tell. Both
schemes ship, picked by `prefers-color-scheme`. iOS uses the system greys
(#F2F2F7 / white, #000 / #1C1C1E); Android uses warm M3 tonal surfaces. Every
text/background pair clears AA; the tightest is 4.54 (table in BUILD-NOTES).

**Accent rule, one line:** "4a amber" (#A85A00 light, #FFB24D dark) marks what
is interactive and what is current: play, selected tab, progress hairlines, a
follow state. Nothing else is amber: not eyebrows, not the STRETCH word, not
the `4a` mark, and not the seam strip (critique r2: amber on a warm clip bar
vanished; the strip shows progress by opacity and a `--label` playhead). The amber/violet split is retired
(overturns the palette ruling): authorship is carried by the serif voice and a
small `4a` mark, not a second accent, which today reads as two primaries. The
`--seg-c0..7` show palette stays as data colour.

**Now Playing is artwork-coloured** on both platforms (Web, cached canvas
extraction): one derivation, the cover's **vivid-first hue** (the most common
hue among pixels with real chroma, so a red apple on cream gives a maroon
room, not khaki) feeding an `oklch` gradient; iOS lays a blurred copy of the
art over it as texture, Android seeds its M3 tonal palette from the same hue,
as Google's own player does, but at the same chroma as iOS (critique r3: a
tone-6 surface at chroma 0.03 was grey-brown for every cover; the Android
dark room is now a gradient from `oklch(0.26 0.06 h)` to `oklch(0.15 0.04 h)`,
asserted at chroma >= 0.05 like iOS). For a foray the source is always the **current
clip's** artwork, never the composite (critique r1: averaging a collage gives
khaki; critique r2: a blurred pale cover under a black scrim gives khaki too).
The tint hands off with the clip.

## Materials and elevation

iOS, three materials. **Glass** (tab bar, mini player, nav backing once content
scrolls under it, sheets): blur 20px, saturate 180%, tint at 78% dark / 85%
light, solid under `prefers-reduced-transparency` and `prefers-contrast`: the
iOS 27 "more tinted" end of the slider.
**Grouped** content: cards on base, no borders, no shadow in dark, one in
light. **Sheet**: 20px top radius, grabber, shadow. Android: no blur; tonal
levels 0 to 3, shape scale 12 / 16 / 28 / pill, a shadow only on the FAB-class
play. Glass stays small and only where it moves with scroll.

## Iconography

**Material Symbols Rounded (Apache 2.0)**, weight 400, optical size 24, outline
and fill variants in one SVG sprite of about 40 symbols: a credible SF Symbols
stand-in on iOS (SF cannot be shipped), exact on Android. Selected tab icons
fill on both (iOS 26+ and M3 agree). No Unicode glyphs; back is the platform's
chevron or arrow from the sprite, plus three custom glyphs (`4a`, `stretch`,
`foray`). **Web.**

## Motion language

Three `linear()` springs (Web): snappy ≈ 320ms, default ≈ 450ms, gentle ≈
600ms (Android: M3 spatial fast / default / slow), plus 150-200ms ease-out for
colour and opacity. Nothing blocks input.

1. **Mini player to Now Playing.** iOS: the mini bar is the sheet's seed; its
   artwork is a shared element (View Transitions, FLIP fallback) growing from
   40px to full width while the glass bar stretches into the sheet and the tab
   bar drops away; drag-down returns it, interruptible. Android: M3 container
   transform, radius 28 to 0, same shared artwork.
2. **Row to player.** Play on any card flies its artwork into the mini player;
   the Up Next badge bumps once when queueing.
3. **Push and pop.** iOS: slide with 30% parallax and edge-swipe back (Web+,
   `@capgo/capacitor-transitions`, unchecked; fallback a crossfade). Android:
   shared-axis X. The tab bar minimises on scroll down and returns on scroll up
   (scroll-driven animation behind `@supports`).

One `prefers-reduced-motion` block swaps every spring for a 120ms fade and
disables parallax, shape morphs and the strip's fill animation.

## Haptic moments (Web+, `@capacitor/haptics`)

Play/pause (impact), scrub snap at a chapter or segment boundary (selection),
foray hand-off from clip to narration (one tick), bookmark (success), add to
Up Next (light impact with the badge bump), context menu open (impact). Tab
change: none on iOS, selection on Android.

## Layout grid and density

16px gutters, 8px spacing scale, 44px minimum targets. Rows: show 56, episode
72, Up Next 64, credits 56; 8-10 rows per viewport on list screens (today:
3-5). Rail cards 168px wide with square art; the Home hero is full width.

## Information architecture and rulings overturned

**Three tabs, no drawer: Home, Search, Library** (overturns D3). Create loses
its tab: its one field becomes the Search field's second job (typing a subject
offers "Build a playlist about ...") plus a `+` on Library. The drawer's
contents (Interests, settings, about) move to a settings glyph top-right on
Home, where first-party apps keep them. The mini player docks to the tab bar
(iOS accessory) or above the navigation bar (Android).

Also overturned:
- **Dark-only, Fraunces + DM Sans, amber/violet roles, seven radii and four
  elevations:** reasons above.
- **No zoom:** upheld only while type follows the OS text size (Android text
  zoom; iOS via the `-apple-system-body` bridge, both Web+, verified on device
  in Phase 3). If the iOS bridge fails, pinch zoom returns.
- **A-Z show list:** art-led browse clusters instead (see Search).
- **Interests as sliders:** a short "what 4a has noticed" list with per-row
  Less / More, behind settings; state stays observed.
- **No share sheet:** native share added (a 4.2 defence; gate withdrawn).
- **"Suggested":** renamed "More picks". "Stretch" and "Show my picks" stay.
- **Car posture:** no mode. The glance posture *is* Now Playing's default; a
  car Bluetooth route (media-session route events, Web+, else nothing) only
  enlarges the transport one step.

Upheld: Apple Podcasts as the chrome benchmark, played row to top in Up Next,
bottom search on iOS.

## Signature moments

**The seam.** A foray's strip is a stitched timeline: one solid bar per clip,
width proportional to runtime, colour from the show's stable `--seg-c`, laid
on **the thread**: one continuous dashed hairline running the full width
under the clips, visible only in the gaps between them. Narration is the
thread showing through, legible without colour (critique r2: short dashed
bars between clips read as morse code; a single thread reads as stitching).
An un-narrated foray has no thread and the bars nearly touch. Progress is
opacity: played bars at 100%, unplayed at 40%, the current bar split at a
2px `--label` playhead that sits on the thread during narration; a strip
with no progress shows every bar at 100%. It is the scrubber. Tapping a clip
bar raises a chip with that show's art and name; a show name is written under
a bar only when the whole name fits, never truncated. "Where this came from"
is a list of 56px rows in play order (art, show, clip length), each linking to
the show (changed from a tile row in critique r1: tiles clipped and repeated).

**The bridge.** A Stretch pick is the only card with two artworks: the pick's
art and a 24px chip of the familiar show it is adjacent to, **sitting on the
cover's bottom-left corner** (never hanging beneath it: critique r3, a chip
on a vertical stitch under the cover read as a pin and pushed the card's text
36px below its neighbours'), joined by a short horizontal stitch of the same
dashed thread the seam uses. The bridge sentence is the card's headline,
Newsreader 19px in rows and on the detail, 17px in the 168px rail card,
under the `stretch` fork icon, never cut. No longer the quietest line.

**The hand-off.** Mini player to Now Playing, above.

## Hero screens

**Home.** iOS large title "Today" collapsing into a glass bar with a settings
glyph; Android top app bar. Order: the full-width **hero card**, the day's
foray (or the resume item when mid-listen): four-tile artwork composite, title,
length, seam strip, why-line in Newsreader, one amber play; **Forays for you**
rail; **Playlists for you** rail with composited covers; **More picks** as 72px
rows (art, title, show, why-line). A bridge card sits in every rail. First run:
a real foray whose why-line cites nothing personal. Offline: a thin banner,
downloaded items lead. Loading: skeletons.

**Now Playing (full).** Edge-to-edge artwork colour; a sheet on iOS, full
screen on Android. Art at width minus 48px, shrinking to 60% when paused
(spring). For a foray the art is the **current clip's show artwork** (the
composite stays on Home, rails and Library); on hand-off it crossfades to the
next show and the room's tint follows, so the listener always sees which show
is talking. The mini player carries the same image, so the shared element is
one picture. Title, then show name with "clip 3 of 10", then the seam strip
(foray) or an 8px scrubber (episode), tabular times beneath. Transport: 15
back, 64px amber play, 30 forward. Second row: speed, sleep, bookmark, share,
Up Next with count. Below the fold: chapters or credits, show notes, **Up Next**
with the next item's why-line ("Next: ... because ..."). At 375x667 the title
clamps to two lines and the art steps down so play stays on screen.

**Mini player.** 56px glass (iOS) or container-high (Android): 40px art,
one-line title, show, play/pause, 30 forward, a 2px progress hairline on top.

**Search / Discover.** Field at the bottom in glass (iOS) or a top search bar
(Android). Idle is a "splatter", not 40 pills: six art-led clusters (a 2x2
artwork tile plus subject name) in an irregular two-column masonry, no two
neighbours sharing a branch. Typing: Shows, Episodes, Playlists, with "Build a
playlist about ..." first when the query reads as a subject. No results: "No
shows match 'fusion'. The subject Fusion & energy systems has 5 shows."

**Library.** Segments (iOS) or chips (Android) for Forays, Shows, Saved,
Playlists, Up Next, History; Shows is a three-column artwork grid, the rest
56-72px rows. Up Next: 64px rows with art, a two-line title, an amber position
number plus a `playing` glyph on the current row, swipe actions (move to top;
remove with undo), overflow for move up/down (`…` on iOS, `⋮` and a leading
drag handle on Android only: critique r3, the iOS rows had borrowed both).
Empty: one card per section, one action.

**Foray detail.** Hero composite of the shows' art (a 200px 3x2 mosaic, no
text on it: critique r2, a title over six covers never had ground), then on
the base: eyebrow, title, "24 min · 3 shows · made today", the seam strip with
show names under each bar, the why-line, a large play (Resume with "12 min
left"; a "Played" tick when done) with "Add to Up Next" as a tonal pill,
credits.
Un-narrated: no dashes, a footnote that clips play back to back. Unavailable:
the reason and "Find something similar".

**Onboarding, first screen.** A full screen, not a sheet: a live scaled-down
hero card animating its strip, "Podcasts, stitched around you" in Newsreader
28px, one sentence, two equal-height buttons, "Show my picks" (amber) and
"Skip for now". Returning after skip goes straight to Home.

## Problems fixed and risks

All ten problems in brief §5 are addressed; the mapping is in BUILD-NOTES.
Risks: blur cost on older Androids (solid fallback), the iOS text-size bridge
(zoom returns if it fails), View Transitions in WKWebView (FLIP fallback).
