# 4a current UI: critique (Redesign 2026, Phase 1 input)

Redesign 2026, Phase 1 research. Feeds `../design-brief.md`.

**Source:** harness renders in `data-local/redesign/shots/today/` (gitignored):
a contact sheet at 393x852, individual screens at 393x852, plus 375x667 for Now
Playing. Index: `data-local/redesign/shots/today/index.json`. Screens reviewed:
first-run intro sheet, Home (empty, returning, stress, with mini player), Search
(idle, results, no-results/fusion, browse pill), Create, Library (empty,
returning), Up Next, Playlists, Playlist detail, Foray list, Foray detail,
Category, Show, Episode, Interests, Now Playing (393 and 375, normal and
stress).

## Overall read

The app looks like one competent dark template applied the same way to every
screen: a purple-black background, rounded-rectangle cards with hairline
borders, a serif (Fraunces) for titles, a geometric sans (DM Sans) for body
text, lavender for primary actions and orange for "active/selected/progress".
Nothing is broken-ugly. The problem is that nothing is *designed*. Every screen
has the same visual weight: a card, a serif title and grey metadata, repeated.
Imagery is close to absent on the screens that matter most. Iconography mixes
Unicode glyphs with outline SVGs. The chrome (hamburger, tagline, refresh glyph,
a hairline rule under every page title) costs vertical space and adds nothing.
It reads as a well-kept web prototype, not a 2026 native app.

## Screen by screen

### First-run intro sheet
- **Meh:** a bottom sheet over a dimmed Home, so the first impression is the old
  Home behind it, not the brand. Two text cards with no illustration, motion or
  artwork. The only visual is a row of coloured dashes that means nothing yet.
  The orange 1px top border on the sheet clashes with the lavender CTA. The copy
  is a feature list ("Two things make it different:"), not a promise.
- **Keep:** short copy, "Skip for now" as an equal-height secondary button, and
  the foray definition sentence, which is clear.

### Home (returning / empty / stress)
- **Meh:** flat hierarchy. "Good afternoon *4a*" sits in small grey text with an
  italic logotype tacked on. The hero is a lavender pill ("Play The fusion
  reactor tour") that looks like a button, not a featured item, with no art,
  duration or reason. Three horizontal rails ("Jump back in", "Forays for you",
  "Playlists for you") are text-only cards with large empty interiors. On
  returning Home, "The fusion reactor tour" appears three times above the fold
  (hero, Jump back in, Playlists for you), and "Short histories" twice. Card
  heights in one rail differ (the progress bar makes card 2 taller). The rail
  peek cuts titles mid-word ("The types of ca"). The only artwork on Home is in
  "Suggested", below the fold. "Suggested" cards cram four type styles into one
  card (uppercase tracking label, serif title, sans subtitle, italic
  explanation). The ALL-CAPS metadata truncates ("2 HR 58 MIN").
- The foray "clip dots" (a row of coloured dots or dashes) are the one bespoke
  visual, but they read as a loading indicator or decoration because nothing
  explains the colours.
- **Keep:** the foray clip-strip idea, if it becomes a real visual signature
  (segments sized by duration and coloured by show). The STRETCH badge and its
  italic bridge line (product principle 1 made visible). The orange "2 of 4
  played" progress. The section order intent (resume, then new, then
  exploration).

### Search (idle, results, no-results, browse pill)
- **Meh:** the idle state is a wall of about 40 identical pills (Adventure ...
  Transport) with no imagery, colour coding or grouping, scrolling past the
  fold. "Followed shows ›" is a full-width outlined box that looks like a button
  but is styled as a weak secondary. The search field floats at the bottom (a
  good 2025/26 iOS pattern), but it is semi-transparent **without blur**, so on
  the browse-pill screen list text shows through it ("History" overlaps
  "Engineering History Podcast"): a legibility bug. The focused field gets a
  heavy 2px orange ring. Result rows are 64px of serif title beside the artwork,
  with no metadata (no episode count, subject or why). The "fusion" query says
  "No shows found for 'fusion'" while a category called "Fusion & energy
  systems" with 5 shows exists; the message contradicts the content. The
  "GENERATED FOR YOU" chip renders in uppercase **serif** here and uppercase
  sans on Home: two treatments of one component.
- **Keep:** bottom search-field placement, square artwork thumbnails with a
  consistent radius, and the shows-then-playlists grouping.

### Create
- **Meh:** two-thirds of the screen is empty. The segmented control has "Foray"
  disabled with a sentence apologising for it ("Custom Forays aren't available
  yet"), so a disabled half of the primary control is the first thing a user
  sees. The placeholder is truncated ("the semiconductor supply ch"). Only three
  suggestion chips. The tab bar gives Create (a ⊕ icon) equal rank with Home,
  Search and Library, for a screen this thin.
- **Keep:** the one-field "name a subject" interaction and the example chips. The
  concept is strong; the screen has no presence.

### Library
- **Meh:** a stack of uppercase-label sections, each with full-width text cards.
  Followed shows render as 130px-tall rows with a 44px thumbnail and a serif
  name, far too much height per item. The empty state is five sections of grey
  sentences, one with an underlined lavender link and one quoting a button label
  in straight quotes ("+ Up Next"). The ☆ in body copy is a Unicode glyph. No
  artwork grid, while 2026 libraries (Apple Podcasts, Pocket Casts, Spotify)
  lead with a dense art grid.
- **Keep:** the section set (Forays, Followed, Saved, Playlists, Up Next,
  History) and the honest empty-state copy pattern.

### Up Next
- **Meh:** the worst density in the app. Each row carries seven controls: ▶, ★,
  ⋮, Next, ↑, ↓ and ✕. The ✕ wraps onto its own line, orphaned at the left. Rows
  are about 210px tall, so three items fill the screen. ↑ and ↓ are Unicode
  arrows, not icons, and the disabled "Next" and ↑ on item 1 are near-invisible.
  No drag handle (arrow-button reorder is a 2015 pattern) and no artwork. The
  numbered circles are grey on grey. "Clear" sits top right with no visible
  confirmation affordance.
- **Keep:** the count subtitle ("5 queued") and the explicit queue position
  numbers.

### Playlists / Playlist detail
- **Meh:** Playlists is three text cards with "Build a playlist ›" as a ghost
  card on top, and no cover art (playlists could composite their episodes'
  artwork). Playlist detail repeats the Up Next anatomy: number, serif title
  wrapping to three lines, description, underlined show link and meta, then a ▶
  / ★ / "✓ Up Next" row. Every row has an orange outlined "✓ Up Next", so four
  identical orange buttons share the screen and steal the accent from what
  matters. The tab bar highlights **Create** here, while Playlists reached from
  Library highlights Library elsewhere: inconsistent nav state.
- **Keep:** the orange "1" marking the current position. The one-line episode
  descriptions are good editorial copy.

### Forays list / Foray detail
- **Meh:** forays, the product's signature, get a plain list of two text cards
  with no visual identity. The Foray detail route in the harness renders "That
  foray isn't available." under an empty page (likely a fixture gap, but the
  error state itself is a bare grey sentence on a black void).
- **Keep:** the explanatory paragraph.

### Category / Show / Episode
- **Meh:** Category is a list of show rows and nothing else: no description, no
  hero, no featured episode. Show page: a 440px square artwork, centred, then a
  centred orange "✓ Followed" pill, then a centred three-line grey explainer about
  what following does: UI apologising for itself. Episode rows below reuse the
  full card (title, an "E" box glyph for explicit, description, underlined show
  link, ▶ ☆ "+ Up Next"); the underlined show name on the show's own page is
  redundant. Episode page: the title is truncated in the header ("Dark...")
  beside a 44px boxed "‹" back button. The artwork repeats the show art at about
  530px. The action row is ▶ (circle), ★ (bare glyph), "✓ Up Next" (orange
  outline) and "Play next" (filled grey): four buttons in four styles. No
  artwork-derived colour, no hero treatment, no blurred backdrop.
- **Keep:** large artwork is the right instinct. The one-sentence episode summary
  is excellent. Showing the explicit marker is correct; it needs a real badge.

### Interests
- **Meh:** every subject is a full card (about 165px tall) with a slider at 50%
  and a "Back to 4a's pick" button, so 40+ near-identical cards to scroll. The
  sliders are orange-filled, making the screen a barcode of orange. The percent
  and reset button repeat in every row. It also edges against principle 2
  ("state observed, never declared"), so a redesign should treat it as a rarely
  visited tuning surface, not a list of 40 knobs.
- **Keep:** the per-row reset and the plain-language subtitle.

### Now Playing (393 and 375; normal and stress)
- **Meh:** a sheet under the persistent app header, so the hamburger, logotype,
  tagline and refresh glyph stay visible above the player. It is not immersive.
  The artwork is framed but nothing in the background derives from it. The
  scrubber has a heavy orange thumb on a grey track, with the times 40px below
  it. The transport uses "↺ 15" and "30 ↻" Unicode arrows in boxed squares,
  flanking a lavender circle. The second row has Stop (red outline text), 1×
  (grey box), ⏭ (Unicode) and Saved ✓ (lavender outline): four controls in four
  styles. The third row is a "Bookmark" box plus two bare lavender text links
  ("Up Next (5)", "Episode"). Three accent colours (orange, lavender, coral) in
  one control cluster. At **375x667 the play row is the last thing visible and
  the secondary controls are off-screen**. With a long title (stress), **the
  scrubber is at the fold and the play button is off-screen entirely**. A
  "uilab fixture" line shows the third text slot (a why/description line),
  styled no differently from metadata.
- **Keep:** the 15/30 skip asymmetry, the big circular primary play, the title in
  the display serif, the sheet grabber.

### Mini player and tab bar
- **Meh:** the mini player is a separate bar stacked on the tab bar, with a serif
  title truncated with "..." and a lone "↺ 15" Unicode glyph beside a large
  lavender play circle. The tab icons are outline SVGs (house, magnifier, ⊕, and
  a *document* icon for Library, which reads as "Files"). The active state is an
  orange icon plus orange label, while primary buttons are lavender, so the app
  has two "primary" colours. No blur or translucency, just flat bars with
  hairline borders.
- **Keep:** four tabs is a reasonable count. Artwork in the mini player.

### Global chrome
- The header ("☰ 4a a daily podcast picker ↻") is on every screen. The tagline
  is permanent marketing copy in the nav bar. "↻" is a Unicode refresh with no
  pull-to-refresh equivalent. On Home the logotype leaves the header and moves
  into the greeting, so the header differs by screen. Every page title has a
  hairline divider under it. The 44px boxed "‹" back button is a Unicode chevron
  in a card, not a platform back affordance. No large-title collapse, no
  safe-area-aware status-bar treatment, and no difference between iOS and
  Android.

## The 10 biggest problems, ranked by impact

1. **Imagery is almost absent where it matters.** Home's hero and rails, Forays,
   Playlists, Up Next and Create are text-only cards. A podcast app's main asset
   is artwork, and today it appears only in show lists and detail pages. Fix:
   art on every episode/playlist/foray surface, composite covers for playlists
   and forays, artwork-tinted backgrounds.
2. **Now Playing is not immersive and breaks at small sizes.** The app header
   stays visible, the controls are mismatched (four button styles, three accent
   colours, Unicode transport glyphs), and at 375x667 the controls fall below
   the fold (the stress title pushes play off-screen). This is the screen
   featuring editors judge first.
3. **Flat hierarchy on Home.** The hero is a button-shaped pill, every rail has
   equal weight, and the same playlist repeats three times above the fold.
   Nothing says "this is today's pick, and here is why", which is the product's
   core promise.
4. **Row and card density is badly tuned.** Up Next rows carry seven controls
   with an orphaned ✕ (about 210px each). Interests uses about 165px per slider
   card. Followed-show rows are 130px for a name. List screens show 3-5 items
   per viewport where 7-10 is normal.
5. **Unicode glyphs in place of an icon system.** ‹ › ↻ ↺ ↑ ↓ ✕ ★ ☆ ⏭ ✓ and a
   boxed "E" sit next to outline SVG tab icons, with mismatched weights,
   baselines and optical sizes. One SVG sprite at a consistent stroke weight
   fixes this app-wide.
6. **Two competing accent colours with no rule.** Lavender is the primary CTA;
   orange marks the active tab, selection, progress, sliders, follow state and
   "✓ Up Next"; coral appears for Stop. Orange outline buttons repeat four times
   per playlist screen, so the accent stops meaning anything.
7. **Chrome that wastes space and looks like a website.** A permanent tagline
   header, a ☰ drawer plus a tab bar, a ↻ refresh glyph, a boxed back button,
   hairline rules under every title, and no large-title collapse, blur or
   translucency. None of it fits iOS 26/27 Liquid Glass or Material 3
   Expressive.
8. **Forays, the signature feature, have no visual identity.** A plain text card
   with an unexplained row of coloured dots. Create opens with "Foray" disabled
   and an apology. The differentiator looks like the least finished part of the
   app.
9. **Inconsistent components and states.** The "GENERATED FOR YOU" chip is serif
   in one place and sans in another. Four button styles share one action row.
   The active tab is wrong on Playlist detail (Create). The header differs on
   Home. The search bar is translucent without blur, so content bleeds through
   it. "No shows found for 'fusion'" sits next to a Fusion category.
10. **Empty, error and explainer states are bare grey sentences.** The Library
    empty state, "That foray isn't available.", the centred three-line explainer
    under Follow, and the idle-Search wall of 40 identical pills. Honest, but no
    illustration, no next step, no browse structure and no warmth.

## What to carry forward into any direction

- The serif/sans pairing: a good editorial voice that needs a scale and
  discipline, not replacement.
- The dark base, if retained. It suits listening, but the owner decisions allow
  challenging dark-only.
- The bottom-anchored search field, the 15/30 skip asymmetry, and the big
  circular play.
- Editorial copy: one-sentence episode summaries, the STRETCH bridge lines, and
  the "2 of 4 played" progress.
- The foray clip-strip concept, promoted into a real, legible visual signature.

## Harness gaps noticed (for the Phase 0a owner)

- The Foray detail route renders "That foray isn't available" under the
  returning fixture (probably a missing seed).
- The drawer (☰) has no shot.
- "uilab fixture" text leaks into the Now Playing description slot.
- No shots with the keyboard open, no light-mode shots, and no native
  safe-area/status-bar framing. All renders are browser viewports, so platform
  fit was judged without real system chrome.
