# Native 2026: critique, round 2

Art director's pass over the round-2 prototype against `DIRECTION.md` and
`BUILD-NOTES.md`.

**Shots reviewed.** The builder's set (`data-local/redesign/shots/native-2026/r2`:
iOS, dark, default, 7 screens x 3 viewports) and a set I rendered myself
because the builder's again covered only iOS dark default:
`data-local/redesign/shots/native-2026/r2-ad/{ios-light,android-dark,android-light,ios-dark}`,
18 routes each at 393x852 (iOS dark also at 375x667), including every state
the r1 shoot plan asked for. **The r1 shoot commands were wrong, not the
builder:** `tools/ui-lab/shoot.mjs` refuses a file path with a query string
(`index.html?os=android` fails `existsSync`), so Android and light were
unshootable as written. I served the prototype over http
(`r2-ad/serve.mjs`, a 12-line static server) and shot
`http://127.0.0.1:8777/index.html?os=android`. Fix for round 3 is item 1.

**Verdict: not ready. A third round will materially improve it.** Round 2
fixed most of r1: the `4a` mark reads as two letters at 12px, the hero title
is three lines, `PickRow` is two-tier, composites read as one cover, Library
rows are 76px with legible progress, the foray hero is 240, credits are rows,
eyebrows are `--label-2`, the masonry staggers, the Now Playing art is the
current clip's cover and the subline carries "clip 3 of 10", fonts are
self-hosted. The platform shell is credible on iOS in both schemes; the
light scheme is the better of the two today. What is still off is
concentrated in three places: the lead foray's artwork is borrowed from the
wrong shows (a contradiction the judge will see in the first second), the
seam reads as morse code rather than a stitched timeline, and the Android
shell is a reskin with an iOS status bar. Below, in priority order.

Where seeing it built changed my mind, I say so; `DIRECTION.md` and
`BUILD-NOTES.md` are already edited (section "Direction changes" at the
end).

## What is right (keep)

- iOS shell, both schemes: large titles, glass tab bar and mini docked above
  it, grouped cards (white with one soft shadow in light; `#1C1C1E` on black in
  dark), inset separators, amber nav actions. Light reads as first-party.
- Home hero: eyebrow with the mark, 20/600 title at three lines, composite as
  one cover, strip, Newsreader why-line, 56px play with the "Play" label.
- `PickRow` two-tier with the why-line full width; the resume hairline.
- Now Playing: art = the current clip's cover; narration state shows the next
  show's cover with "4a Narration" in the voice face; paused shrinks the art;
  the episode variant (8px amber scrubber, "Playing from Ancient military
  history", show notes below the fold) is the best screen in the set. Play
  stays on screen at 375x667 in every state.
- Search: field as a 44px glass pill above the tab bar; "Build a playlist
  about history" as the first result on an `--accent-soft` card; the no-results
  card built from the taxonomy.
- Library: segmented control fits six labels at 375; foray rows 76 with
  played/unplayed opacity; Up Next rows with handle, number, `i-graphic_eq`
  and the tinted current row; the empty card with one action.
- States: first-run eyebrow and impersonal why-line; offline banner; loading
  skeletons; unavailable foray with the hatched strip and "Find something
  similar"; search empty.
- Onboarding: the block is centred; the headline is Newsreader 28.

## P0

### 1. Shoot every platform and scheme before the next critique (process)

Two rounds in, the Android shell and the light scheme had never been looked at
until I rendered them. Make the prototype read `os`, `scheme` and
`transparency` from the **hash query** as well as `location.search`
(`#/home?os=android&scheme=light`), because the harness drives hash routes and
cannot pass a search string on a file URL. Then the r1 route list works
unchanged on a file URL; no server needed. Shoot the full matrix (two OS x two
schemes x the 18 routes x three viewports) into `r3/<os>-<scheme>/` and put
the four contact sheets at the top of the builder's hand-off note. A round
that ships iOS dark default only is not reviewable.

### 2. The lead foray's artwork belongs to other shows

`data.json` notes it: five of the Barbecue foray's six shows are not in the
committed catalog, so their covers are "stand-ins from the same subject". The
stand-ins are Cider Chat, WhiskyCast, Beer In Front and Inside Winemaking (the
"Coffee, tea & drinks" cluster) and The Ancients. The result on screen:

- Home hero: "Barbecue: eight stories ..." over a composite of a cider show, a
  winemaking show and a beer show.
- Now Playing: Cider Chat's cover, captioned "Satay? Okay! · clip 3 of 10".
- "Where this came from": "Origin Stories" rows with The Ancients' cover, twice.

A judge reading the credits against the covers will conclude the app mislabels
shows. This is the one thing in the prototype that reads as broken rather than
unfinished. Fix, keyless and free: resolve the five real covers through the
iTunes Search API (`https://itunes.apple.com/search?term=<show>&entity=podcast`,
take `artworkUrl600`; a URL, not an image, so nothing is committed) and put
them in `show_art`. Also regenerate `art.h/c` for them. If any show cannot be
resolved, swap the lead foray for one whose shows are all in the catalog and
say so in the hand-off. The same stand-in rule applies to the "Forays for you"
rail: "The types of capital a startup can raise" shows This Week in Startups,
Lab to Market, How I Built This and Masters of Scale, none of which is among
its seven credited shows.

### 3. The seam reads as beads and morse code

In every strip (hero, rails, Library, Now Playing, foray detail) a 23-minute,
ten-clip foray renders as ten rounded blobs separated by "- -". The
narration "bars" are two 2px dashes, which at a glance is punctuation, and
the clip bars with 1-2 minute runtimes are circles. This is the signature
moment and it is the weakest element on the screen.

**Direction change.** Narration is no longer a bar between bars. It is **the
thread**: one continuous dashed hairline running the full width of the strip,
under the clips; clips are solid bars laid on the thread, and the thread shows
only in the gaps between them. Stitched, literally. Un-narrated forays have no
thread and a 2px gap. Values (`BUILD-NOTES.md` `SeamStrip` rewritten):

- Container `position: relative; display: flex; gap: 10px (lg) / 8 (md) / 6 (sm)`.
  `::before`: `position: absolute; inset: 50% 0 auto 0; height: 2px;
  transform: translateY(-50%); background: repeating-linear-gradient(90deg,
  currentColor 0 4px, transparent 4px 8px); opacity: .45; color: var(--label)`.
  No narration elements in the DOM; the slider's `aria-valuetext` still says
  "Narration" when the position falls in a gap.
- Clip bars: `flex: <seconds> 0 0` with `min-width: 10px` (lg) / 8 / 6;
  `--r-pill`; colour `--seg-c<n>`.
- Progress by opacity, not by amber: a strip with no progress shows every bar
  at 100%; once progress exists, played bars 100%, unplayed bars 40%, and the
  current bar is split at the playhead (its played part 100%, the rest 40%,
  via a `::after` overlay in `--bg` at 60% opacity sized `calc(100% - var(--p)
  * 100%)`). The playhead is a 2px `--label` hairline, 18px tall at lg (12 at
  md, none at sm), positioned at the fill's edge; during narration it sits on
  the thread in the gap. Remove the amber inner fill: amber on a tomato bar was
  invisible in the r2 shot, and amber on the strip breaks the one-line accent
  rule (amber marks interactive and current; the playhead and the opacity
  split carry "current").
- Library rows: the same rule ("9 of 22 played" = nine bars at 100%, the rest
  at 40%), no playhead.
- Onboarding loop: a clip bar's played part grows over 4 s, the playhead
  crosses the gap over 1 s, the next bar begins; still static at 40% under
  reduced motion.

### 4. The Android shell is iOS in a brown coat

The Android renders share the iOS status bar (notch glyphs, "9:41" in the
iOS weight and position), the iOS home-indicator bar, the iOS chevron-down on
Now Playing, 20px card corners, and a chips row that clips a selected chip
mid-word at the 16px gutter ("U" of Up Next). The nav bar with the pill
indicator and the labelled secondary row on Now Playing are right; the rest
says "iOS theme". Fix:

- Status bar under `data-os="android"`: time left at 14/500, three plain
  glyphs right (signal, wifi, battery outline), 24px tall; gesture handle
  108x4 at the bottom but no iOS rounded-battery shape. The harness frames the
  viewport; the prototype draws the bar, so this is the prototype's job.
- Shape: `--r-lg: 28` on the hero card, sheets and the mini (`BUILD-NOTES.md`
  1.7 already says so; the shot shows about 18). Cards `--r-md: 16`.
- Chips row: bleed to the screen edge (`margin: 0 calc(var(--gutter) * -1);
  padding: 0 var(--gutter); overflow-x: auto; scroll-padding: var(--gutter)`)
  so a clipped chip is cut by the edge, not by the gutter, and scroll the
  selected chip into view on load.
- Now Playing top-left glyph: `i-keyboard_arrow_down` at 24 inside a 48px
  target (M3), not the iOS chevron; context line 14/500 `--label-2`.
- Foray detail on Android: the hero mosaic is cropped to a 60px first row
  under an opaque app bar (shot `android-dark/default__foray`). Make the
  Android app bar transparent over the hero like iOS, with the back, share
  and overflow as 40px `--surface-2` circles; the mosaic keeps its full 240.
- Android Home: the top app bar is fine (22/400). Add the M3 pressed-state
  ripple on rows (`--fill` at 12%, 200ms) so taps feel Android; the static shot
  cannot show it but the lab build will.

### 5. Now Playing's room on iOS dark is still khaki

Cider Chat (pale yellow, red type) gives an olive-grey room in iOS dark
(`#3F3F30` where the title sits) because a blurred pale cover under a 45-72%
black scrim always lands on khaki. Android dark, which derives from the hue,
gives a deep brown-maroon for the same cover; light iOS gives a pleasant cream.
Two platforms, two different rooms for one cover, and the dark one is mud.

**Direction change: one derivation on both platforms.** Drop the blurred copy
as the colour source. The room is an `oklch` base from the cover's hue, and
the blurred art is a texture over it:

- Hue: dominant hue among pixels with chroma >= 0.10 (vivid-first, so the
  apple red wins over the cream), falling back to the dominant hue; chroma
  floor 0.04 as before.
- iOS dark: `linear-gradient(180deg, oklch(0.30 0.07 h) 0, oklch(0.16 0.04 h)
  100%)`; blurred art (`blur(48px) saturate(1.6)`) over it at 30% opacity;
  no black scrim. iOS light: `oklch(0.96 0.03 h)` to `oklch(0.90 0.05 h)`, art
  at 20%.
- Android keeps its tonal values (1.5), now from the same vivid-first hue.
- Harness assertion: on the Now Playing background sample at the title's
  y, oklch chroma >= 0.05 in dark (no greys) and `--label` contrast >= 7:1.
  Fixture covers: pure white, pure yellow, pure grey.

## P1

### 6. Foray detail title on top of a six-cover mosaic

The 28/700 title over "BEER IN FRONT" and a winemaker's face is legible only
because it is bold; the eyebrow sits on "BEER MEDIA GROUP PRESENTS" and the
status bar on The Ancients' white border. The r1 scrim fix did not rescue it,
and it will not: a 3x2 mosaic is busy by construction. **Direction change:**
the title moves **below** the mosaic. Hero 200px (`aspect-ratio: 393/200`),
3x2 tiles, scrim only for the top band (`rgba(0,0,0,.45) 0, rgba(0,0,0,0)
40%`) under the status bar and the nav chips. Then on `--bg`: eyebrow at +16,
title 28/700 clamp 2 at +4, meta at +8, the strip, the why-line, the action
row. Play lands at about y 520 at 393, 500 at 375: on screen without
scrolling. The hero stays the artwork moment; the title stops competing with
it.

### 7. Row trailing actions eat the title

`PickRow` ("Jump back in", Search episodes) carries a 44px play and a 44px
overflow, so at 393 the title column is 200px and both the title and the show
name ellipsize ("From high school... / 31 min · Masters of..."; "1 hr 1 min ·
The..."). **Trailing is one 44px play only, both platforms.** The overflow's
items (Play next, Add to Up Next, Save, Download, Share, Go to show) are the
`ContextMenu`'s, reached by long-press (iOS context menu / Android bottom
sheet), which the component list already specifies. That returns 44px and the
show name fits in three of the four shots. Library foray rows: drop the
chevron (the row is the target; Apple Podcasts' library rows carry none);
title gains 36px.

### 8. Two secondary-action treatments for one row component

Home hero: "Details" as a bare amber text button at the far right. Foray
detail: "Up Next" as a tonal pill with a queue glyph. Same action row, two
grammars. Use the tonal pill on both: 44px, `--fill` background, 17/600
`--label`, 16px side padding, glyph 20: Home "Details" (no glyph), detail
"Add to Up Next" with `i-playlist_add` (the current `queue_music` glyph reads
as "open the queue"). At 375 the pill is 150px and still leaves 20px to the
Play label.

### 9. Mini player hairline on Home

Confirmed on Library (an amber line at the mini's top-left, correct). On
Home's `#/mini` route it is not visible at 393; the "Forays for you" rail's
bridge card overlaps the mini's top edge. Give the mini `z-index` above
scrolled content (it already floats) and check `.mini-prog` is not clipped by
`overflow: hidden` on `.mini` with `--r-md`; put the hairline inside the
radius (`top: 0; left: var(--r-md); right: var(--r-md)`) or clip-path it.

### 10. Empty-state glyph

`i-foray` at 28px in the Library empty card reads as "---". A seam in
miniature does not survive 28px as a standalone symbol. Use `i-library_music`
(Forays, Playlists), `i-headphones` (Saved, History), `i-queue_music` (Up
Next); keep `i-foray` for 16px eyebrows only.

### 11. Fold line on Now Playing

At 393x852 the "Where this came from" header sits under the home indicator,
so the indicator underlines it. Add `padding-bottom: calc(env(safe-area-inset-
bottom) + 24px)` to the secondary row's section so the fold lands in the gap
above the header, not through it. Same for "Show notes".

## P2

12. **Stretch bridge card** is right (24px chip, fork + STRETCH in
    `--label-2`, Newsreader 19 headline). The chip is round because
    `--r-sm` (8) on 24px reads round; set the chip radius to 6 so it reads as
    a tiny cover, and draw the 12px stitch between chip and cover with the
    thread gradient from item 3 so the two "stitches" are one idea.
13. **Loading skeleton**: the hero skeleton is one blank 300px block. Use the
    real boxes (composite square, three title lines, strip, two why-line
    lines, play circle) so the content fades in with no shift.
14. **Onboarding glow** starts behind the status bar; begin it behind the
    card (`radial-gradient` centred on the card's centre, radius 60% of the
    viewport width, max `rgba(255,178,77,.06)`).
15. **Search idle**: the stagger is 28px; push the right column to 40px and
    make items 1, 4, 5 `1:1.25` so the two columns never share a horizontal
    edge in the first screen; at 375 the current render still aligns rows 2
    and 3.
16. **Now Playing speed label**: "1×" uses the multiplication sign; fine, but
    set it `tnum` so "1.25×" does not shift the row.
17. **Up Next Android rows**: the current row's `--accent-soft` tint is
    stronger than iOS's; use the Android value `--accent-container` at 35%
    opacity, not 100%, so the row stays a row and not a banner.
18. **The `4a` mark**: fixed; reads as two letters at 12px in every eyebrow
    and at 40px in narration rows. Close r1 #1.

## Checks for round 3 (hand-check and write into the hand-off)

- 375x667 play-button assertion in every Now Playing state (passes today;
  keep it).
- `?transparency=reduced` on Home and Now Playing, both schemes.
- The four contact sheets, and one shot per platform with the OS's real
  status bar.
- Item 2: every cover on Home, Now Playing and the credits belongs to the
  show named beside it. State it as a sentence in the hand-off, per foray.

## Direction changes made in this round

Edited by the art director so the builder reconciles one document, not two:

- `DIRECTION.md` §Signature moments and `BUILD-NOTES.md` `SeamStrip`: the
  narration stitch is one continuous dashed thread under the clips; progress
  by opacity (played 100%, unplayed 40%) with a `--label` playhead; no amber
  on the strip. The accent rule drops "the live segment".
- `DIRECTION.md` §Now Playing and `BUILD-NOTES.md` 1.5: the room colour is
  one `oklch` derivation on both platforms from a vivid-first hue; the blurred
  art is a texture, not the source.
- `BUILD-NOTES.md` §4.5 and `DIRECTION.md` §Foray detail: the title sits below
  a 200px mosaic, not on it.
- `BUILD-NOTES.md` `PickRow`, §4.4: trailing action is one play; overflow
  items live in the context menu; Library foray rows have no chevron.
- `BUILD-NOTES.md` `HeroCard`: the secondary action is a tonal pill on both
  the hero and the detail action row.
- `BUILD-NOTES.md` §0 and §8: `os`, `scheme`, `transparency` also read from
  the hash query; the shoot plan uses them; artwork for shows outside the
  catalog resolves through the iTunes Search API, never a stand-in.
- `BUILD-NOTES.md` §1.1/§1.2 note on the Android status bar and 1.7 corner
  values restated.
