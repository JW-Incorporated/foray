# Afterglow

**Thesis:** the artwork is the light source. Every surface in 4a is lit by whatever is playing, and a foray is a row of lanterns, one per show.

Builder detail: `BUILD-NOTES.md`. Contrast proof: `contrast-check.mjs` and `prototype/tools/contrast-glow.mjs`. Critiques: `critique-r1.md`, `critique-r2.md`, `critique-r3.md`, `critique-r4.md` (ready; no direction change, two builder corrections in `BUILD-NOTES.md` §12).

## Mood

A room at dusk with one record sleeve propped against a lamp. Warm near-black, not purple-black: the darks carry a little red, the whites a little cream, so artwork is the only saturated thing until it bleeds into the chrome around it. Depth comes from light, not borders: a card is raised because its top edge catches a faint rim, never because a hairline outlines it. Glass is heavily tinted and small. Logo covered, you know it is 4a because the room is lit by the art, the colour changes as a foray moves from show to show, and the narration is the light itself.

## Typography

Both faces are already self-hosted and OFL: **Fraunces** (display) and **DM Sans** (text). The change is discipline, not replacement. Fraunces runs `opsz` auto, `SOFT 100`, `WONK 0`; italic only for why-lines and bridges. Tabular numerals wherever a number can change. Minimum 13px.

| Role | Face | Size/line | Weight |
|---|---|---|---|
| Display (player title, hero) | Fraunces | 32/36 | 500 |
| Title (screen, foray names) | Fraunces | 26/30 | 500 |
| Headline (cards, section heads) | Fraunces | 20/24 | 500 |
| Why-line, bridge | Fraunces italic | 17/24 | 400 |
| Body | DM Sans | 16/24 | 400 |
| Label (buttons, tabs, chips) | DM Sans | 14/18 | 600 |
| Caption, meta | DM Sans | 13/18 | 500 |

Seven styles; nothing else exists.

## Colour

**Dark-only is overturned.** Two rooms, **Dusk** (default) and **Dawn**, following `prefers-color-scheme` with an in-app override. Reason: an app lit by artwork works in daylight too, and a sunlit car is where a light scheme earns its keep; one scheme also reads to featuring editors as a choice not made. Now Playing has no scheme: it is always the artwork's room. Every other Room (Foray detail, onboarding) follows the scheme: in Dawn the same blurred artwork sits under a paper scrim, so a page in the navigation stack never turns into a dark screen inside a light app.

Neutrals are warm. Dusk: `bg0 #14110F`, `bg1 #1D1916`, `bg2 #272220`, `text #F5EEE4`, `text-2 #B9AFA3`, `text-3 #9A9188`. Dawn: `paper0 #F7F2EB`, `paper1 #FDFAF5`, `paper2 #EFE8DF`, `ink #1E1A17`, `ink-2 #5E564E`, `ink-3 #6B635A`. All 25 text pairs clear AA; the lowest is 4.86:1.

Three named colours, one rule each:

- **Glow** (dynamic): the current item's artwork colour, extracted and clamped. It tints the mini player, the tab-bar veil, the Now Playing room and the playing row. Never text: text sits on a scrim over it.
- **Ember** `#F0A64B` (Dawn `#8E520E`): the listener's own marks only: saved, followed, chosen, progress made. Today's amber ruling, kept.
- **Lamp** `#F3E7D3`: what 4a authored: narration segments, the Stretch label, the "4a picked this" eyebrow. **This overturns "violet = 4a authored."** A third hue fights the artwork; 4a's voice reads better as plain light, so a strip shows coloured shows joined by ivory narration, legible in greyscale.

Segment colours derive from each show's artwork, clamped to a lightness band and nudged 30 degrees when too close to a neighbour. `--seg-c0..7` remains the fallback.

## Materials and elevation

Five materials, lit from above. **Base**: opaque. **Raised** (cards, rows): a 6% Lamp overlay, a 1px top rim at 10% Lamp, two-layer warm shadow. **Veil**, the only glass: `backdrop-filter: blur(20px) saturate(140%)` under a tint of bg mixed 28% with Glow; the Dock (tab bar + mini player, and the Discover field, one surface) and sheet headers only; solid under `prefers-reduced-transparency`, `prefers-contrast: more` and `@supports not`. Content runs under the Dock and fades to bg behind it; it is never sliced by the Dock's edge. **Room**: Now Playing's backdrop, the artwork at 64px blur under a vertical scrim over a base of bg0 mixed 15% with Glow. The scrim is set in pixels from the top, so every line of text starts in the mid zone whatever the screen height: the lower part is at least as dark as `#4A3A33` (text on it 9.4:1) and never neutral; the Dawn Room uses the same stops toward paper. An unavailable foray turns its lamp down: the Room dims with the collage. **Lit art**: any artwork of 104px or more casts its own colour, not a black shadow: a soft glow in that art's extracted colour, radius 40 at 104, 64 at 160, 96 at 280 and above. The sleeve is the lamp. **The Dock casts upward**: on any page without its own light (Discover, Library, and Today below the wash) a 260px radial in Glow at 14% (Dawn 9%) rises from the Dock's top edge behind the content, so the thing that is playing lights the page it is on; nothing is tinted when nothing plays. No hairline borders anywhere.

## Iconography

**Phosphor** (MIT), 24px grid, Regular for inert, **Fill** for the active tab and toggled states (played, saved, downloaded), so a state change is a fill, never only a colour. Three custom glyphs on the same grid: play, back-15, forward-30 (arc plus numerals). One sprite, `currentColor`, no Unicode glyphs.

## Motion

Springs as `linear()` tokens; transform and opacity only. `--m-micro 160ms` (toggles, fills), `--m-ui 280ms` (rows, chips, tab recede), `--m-sheet 420ms`, `--m-room 560ms` (the player, any Glow change, via `@property` colours). One reduced-motion block swaps every transform for a 200ms crossfade, steps the strip fill and freezes the Room.

1. **Mini to Now Playing (the lamp turns up).** The 44px artwork is a shared element (View Transitions, FLIP fallback) growing into the full-bleed Room while the mini player's tint blooms outward to fill the screen; the tab bar sinks. Drag-to-dismiss tracks the finger and springs home.
2. **Pick to play (the light moves).** Tapping play on a card: its artwork drops into the mini slot and the chrome's Glow crossfades to the new colour.
3. **Foray strip lighting (the lanterns).** On Foray detail the strip draws in from the left, bars lighting in sequence. In playback the current bar fills and the Room shifts to that segment's show, returning to lamp-warm neutral for narration.

## Haptics (Web+)

Light impact on play/pause and add to Up Next; selection tick when scrubbing crosses a segment or chapter boundary; medium impact once when the mini-player drag passes its open threshold; success notification on bookmark and download complete. None at handoff.

## Layout and density

4px base. Gutter 16px at 375, 20px from 393. Content runs under the chrome with safe-area insets. Artwork: 44 (mini), 56 (queue), 72 (episode row), 104 (grid tile), 160 (hero), full-bleed. A collage never crops a square: four shows are a 2x2; two or three are full squares overlapping inside the cell, the first show's square always complete and on top (it is the show the Room is lit by), the others peeking out behind it; one is the art. Rows: episode 96px (the why-line gets two lines; it is the product's main copy), queue and followed show 64px, so 7-8 items per viewport. Art grids are 3-up everywhere, so show names never cut. Rails survive only for Playlists; picks are a vertical list, so titles never cut.

## Information architecture

**Overturns 4 tabs + drawer.** Three tabs, **Today, Discover, Library**, no drawer. Create folds into Discover's single field, which both searches and builds a playlist from a subject: the one-field interaction was Create's good part; the tab was a thin screen holding a disabled control. Settings, Tuning (ex-Interests) and About sit behind one button at the top of Today. The tab bar and the mini player are one floating **Dock** (one Veil surface, rows divided by a rim, no gaps) that recedes on scroll; on Discover the search field is the Dock's top row and the tab row recedes to icons, keeping the bottom-field ruling without three stacked bars.

Also overturned: **Interests as sliders** becomes three states per subject (less, 4a's pick, more) inside Tuning, nearer to "observed". **No share sheet** becomes native share of the timestamp link. **"Suggested"** becomes **"Off your path"**, the section that makes the floor visible. **Home order**: hero, Keep listening, Today's picks, Playlists, Off your path. **Benchmark**: a distinctive look, not Apple Podcasts. Kept: no-zoom (type compensates; OS scale followed on Android), 15/30, "Show my picks", played-row-to-top. **Car posture**: observed on a car Bluetooth route (Native; meanwhile, long-press the mini player): tab bar hidden, 88px play, type 1.25x.

Platform stance: one neutral language. Springs and fills read Expressive on Android; veils and the sheet read Glass on iOS; neither is imitated.

## Signature moments

**The room changes colour mid-session.** A foray is stitched from several shows, and Afterglow shows it without a word: when playback crosses a segment boundary the whole player shifts to the next show's artwork and colour, and the show name surfaces for three seconds in Lamp, then sinks back. The strip above the scrubber is the map: bars sized by runtime, coloured from each show's art, narration as thin ivory lights, the current bar filling, wide bars carrying a 20px thumbnail. Tapping a bar seeks. "Where this came from" sits below as the real shows' artworks.

**The bridge, drawn.** A Stretch pick is a card with two artworks joined by a lit line: the familiar show left, the stretch right, the bridge sentence in Fraunces italic between them, a Lamp pill reading "Stretch". The quietest line becomes the structure.

**The floor, shown.** "Off your path" opens with one line: "About a third of each day sits outside your usual subjects. This is today's third."

## Hero screens

**Today.** The hero's Glow lights the top 48% radially from the collage, with a tight hot spot centred on the collage itself, fading into bg0. Hero: today's foray (or first pick) as a 160px 2x2 collage of its shows' art beside the Title (26px, four lines max, never an ellipsis), duration, "4 shows" and a 56px Ember play; the why-line runs full width under the pair. Then "Keep listening" (one 72px row, progress as a rim on the art) only when mid-listen; "Today's picks" as 4-6 episode rows with one Stretch card among them; "Playlists for you" as 2-up composite covers; "Off your path". First run: the hero reads "4a found today's picks. No account, no setup." Offline: cached art stays, unplayable rows dim. Loading: skeletons with a slow lamp sweep.

**Now Playing.** Room backdrop. The glance posture fits 375x667: artwork 280px (220 on short screens, 180 under a three-line title), Display title clamped to three lines, show, why-line in Lamp italic, the strip (foray) or a thin track (episode), tabular times, then 15, an 88px play, 30 in the thumb zone. Scrolling reveals the detail posture: speed, sleep, bookmark, share; chapters or segments; show notes collapsed to four lines; Up Next peek with the next item's art and reason. End of item: the next artwork slides in as the Room crossfades. **Mini player:** 64px Veil, 44px art, DM Sans title, 48px play, 44px forward-30, a 2px Glow progress line on its top edge.

**Discover.** No pill wall. Idle: subjects as 2-up tiles each carrying a 56px 2x2 collage of its shows, under five broad heads; followed shows live in Library only (they were here in round 1 and pushed the subjects below the fold). Field at the bottom in Veil. Results grouped Shows, Episodes, Playlists, each row with art and one meta line. No result: "Nothing named 'fusion'. 'Fusion & energy systems' is a subject, five shows."

**Library.** A 3-up art grid of forays (compact tiles: collage with its strip along the bottom edge and a Lamp "Foray" pill) and followed shows (clean art, no badge: everything here is followed, so a mark would say nothing; the followed badge lives where the state varies, in Discover results and "Where this came from"), then Saved, Playlists, Up Next, History as 64px rows. Up Next: the current row marked by a Fill glyph and the word "Playing"; a trailing menu with Move up, Move down, Remove; undo toast. Empty: one line, one button per section.

**Foray detail.** Room from the first show's art, following the scheme. Subject eyebrow in Lamp, Title, duration and show count, the strip at 48px with thumbnails on a dark sill (the first show's bars are by construction close to its own Room), "Why 4a made this" in italic, "Where this came from" as artwork rows, then the segment list. Button: Play, Resume or Play again. Un-narrated: no ivory lights, one caption. Unavailable: the lamp goes down, the collage and the Room dim together, one line, "Find similar".

**Onboarding.** One screen, a Room built from four real artworks; a strip draws itself in while the colour moves through those shows. The sleeves sit in the Room's bright zone near the top, the copy follows them, the buttons hold the bottom, and a tall screen's surplus opens between copy and buttons, never above the sleeves: the lamp stands in its own light. Copy: "Hear things outside your lane. 4a picks a few podcasts a day and says why." Buttons: "Show my picks" (Ember), "Skip for now". After skip: Today, no sheet.

## Risks and tags

Palette extraction is **Web**, but publisher art often lacks CORS, so the primary palette is precomputed per show in the nightly refresh; the runtime canvas is an upgrade, a hash hue the fallback. Veil blur is **Web**, costly on Android WebView, so it covers at most 130px. Glow tints are **Web**, clamped so text contrast never depends on the art. Shared-element moves: **Web**. Haptics, share, media session, status bar: **Web+**. Car route observation: **Native**.

Critique problems fixed: 1-8 and 10 directly; 9 via the component inventory.

## Changed after round 1 (2026-10-05, art director, see `critique-r1.md`)

Decisions made on seeing the build, each already folded into the text above and into `BUILD-NOTES.md`:

1. **Dock.** Mini player and tab bar are one Veil surface; on Discover the field is its top row and the tabs recede to icons. Three stacked floating bars ate a third of a 375x667 screen and content showed through the gaps.
2. **Room base is Glow-tinted** (bg0 mixed 15% with Glow), and the backdrop is the blurred artwork with the Glow gradient only as its fallback. The round-1 gradient-only Room read as a flat colour band.
3. **Glow mixes raised** to 28% on Veil and 18% on the playing row, Dusk Glow lightness 0.66; at 18/12 the tint was below perception.
4. **Today's wash is radial from the collage** at 60/40, so the light visibly comes from the art.
5. **Why-lines get two lines** in rows; episode rows 96px.
6. **Art grids are 3-up** everywhere; "Shows you follow" leaves Discover (Library owns it). Subject tiles carry a 56px 2x2 collage instead of a three-art stack.
7. **Library forays are compact tiles**, not the full ForayCard.
8. **Strip:** thumbnails only on Foray detail, in their own row under the bars; the current bar is taller, never ringed.
9. **Now Playing:** the eyebrow above the title holds only the transient "Now: <show>" caption; artwork grows up to 320 on tall screens instead of leaving a gap.
10. **Hero:** title at 26px, why-line full width under the pair (the builder's layout, kept).
11. Wordmark appears on onboarding as well as the Today header.

## Changed after round 2 (2026-10-05, art director, see `critique-r2.md`)

Each already folded into the text above and into `BUILD-NOTES.md` §10:

1. **Rooms follow the scheme, except Now Playing.** Foray detail and onboarding get a paper scrim in Dawn. A dark page between two light pages read as a second app.
2. **Lit art** is the fifth material: artwork casts its own colour, never a black shadow. The round-2 build had the lamp throwing a shadow onto the wall it lights.
3. **The Room scrim is set in pixels from the top**, so the eyebrow, title and caption always sit in the mid zone; round 2 put them on near-pure artwork colour at under 3:1.
4. **Today's wash gets a hot spot** centred on the collage; the even radial still read as a band.
5. **Collages never crop a square**; two and three shows overlap full squares.
6. **Hero title: four lines max**, never an ellipsis (26/30 beside a 160 collage is four lines for an ordinary title; the arithmetic in round 1 was wrong).
7. **Library's followed badge is gone**; the badge appears only where the state varies.
8. **Foray detail's strip sits on a sill**; an unavailable foray dims its Room with its collage.
9. **The Dock has a bottom fade** behind it, so content is never sliced by its edge.
10. **Max text size** (>= 1.2x) hides the why-line in the glance posture and shrinks the handle to the chevron, so Play and the handle stay on a 375x667 screen; the harness asserts it at 1.3x.

## Changed after round 3 (2026-10-05, art director, see `critique-r3.md`)

Each already folded into the text above and into `BUILD-NOTES.md` §11:

1. **The Dock casts upward.** Discover and Library were the only unlit rooms; a Glow radial rising from the Dock lights whichever page the playing item is on.
2. **Onboarding stands in its own light.** Sleeves top-anchored in the bright zone, buttons bottom-anchored, surplus between copy and buttons; the round-3 centred group left the brightest band empty on tall phones.
3. **The first show's collage square is always whole** and on top; round 3 hid the show the Room is lit by behind the others.
