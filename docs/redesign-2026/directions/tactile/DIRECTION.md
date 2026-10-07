# Direction: Dial

**Thesis.** 4a as a beautifully made little radio: every foray is a band on
the dial, every pick is a station, and every control is something you can
press. Logo covered, you know it by the band (a coloured, stitched timeline
with a needle) and the keycaps (buttons with a lip that depress under your
thumb). Tokens and measurements are in `BUILD-NOTES.md`; every hard limit in
`PLAN.md` holds.

## Mood

A 1970s transistor radio rebuilt by a 2026 industrial designer: cream
enamel, persimmon and ultramarine paint, black rubber keys, a brushed-metal
needle. Everything sits on something. Playful in the hand, never cute in
the copy.

## Typography (OFL only, self-hosted)

- **Archivo** (OFL 1.1, variable: weight 100-900, width 62-125) for
  display, title and heading: every screen title, hero and episode title,
  section heading, every Find tile name (r4: the large tile alone was
  Archivo and the rest Bricolage, two faces on one screen) and the
  onboarding brand. It is a
  grotesque cut from late-nineteenth-century American jobbing type, which
  is the lettering on a tape-deck label or a dial's station plate: flat
  terminals, a straight-tailed `y`, a plain `g`, no bounce. Display runs
  width 92 at weight 700; title 94/650; heading 96/650. The slight
  condensing keeps the dense, chunky rhythm the direction had.
- **Bricolage Grotesque** (OFL 1.1, variable) for text: body, rows, labels,
  keycaps, chips, tags. At 15-17px its quirks are texture, not a voice, and
  its open shapes pair with Archivo (same grotesque skeleton, close
  x-height) so the two read as one family at a glance.
- **Azeret Mono** (OFL 1.1) for readouts only: clock, durations, counts,
  date. Tabular by nature, so the counter never jitters.

Scale (size/line, weight, width): display-xl 40/44 700 w92, display 32/36
700 w92, title 24/28 650 w94, heading 20/24 650 w96 (all Archivo); body-lg
17/24 500, body 15/21 500, label 13/16 700, micro 12/16 600 (Bricolage);
readout-lg 28/32 mono, readout 13/16 mono. Body never below 15px,
everything in `rem`, no all-caps labels.

**2026-10-06, after the owner's pick.** The owner chose Tactile and Ambient
to build, with one objection to Tactile: "the font choice used for the
headers and titles. It's sort of cartoonish." He was right, and the cause
is specific: Bricolage at weight 800 and width 90 has a curled `y`, a
hooked single-storey `g` and a bubble `a`, and at 32-40px those three
letters are a cartoon. The fix is a different face for the three large
roles, not a different Tactile: Archivo at 700/92 keeps the same line
breaks on every title in the r3 renders (the hero even gains a line at
393) with letterforms that look machine-cut. Trialled against IBM Plex
Sans, Instrument Sans, Chivo, Schibsted Grotesk, Saira and Barlow on the
real screens (`data-local/redesign/shots/tactile/r4/`, contact sheet
first); Saira went dashboard-gamer, Chivo and Schibsted went wide and
editorial (three lines where two fit), Barlow has softened corners, Plex
and Instrument are the two review candidates in BUILD-NOTES. Bricolage
stays for text sizes, where the pairing holds. Weight 800 is gone from the
app entirely: 700 at display is the heaviest anything gets. The r4 renders
confirmed it in both schemes (`critique-r4.md`): Archivo stays primary,
Plex costs the hero a line and reads instrument-panel, Instrument loses the
label-plate character and flattens the title-to-row step. Sentence-length
display lines balance (`text-wrap: balance`), so no headline ends on a
single word. **r5 closed the question** (`critique-r5.md`, measured in both
schemes at 375/393/412): Archivo is final, the alternates stay in the
prototype only as the owner's review switcher, and no further type round
is planned. What remains for Phase 3 is removing the switcher and
instancing the fonts.

Overturns Fraunces + DM Sans: a serif voice reads editorial; a radio reads
grotesque.

## Colour

**Overturns dark-only.** Dial ships two authored schemes, following the
system with an in-app override: **Cream** (light, default) and **Bakelite**
(warm dark). Neither inverts the other. Reason: enamel and paper are the
material, and a tactile object is seen in daylight. Dark remains for the car
at night. Now Playing is artwork-tinted in both.

Accent roles keep the founders' rule but change the paint: **persimmon**
(`#C93F14` cream / `#FF6A3A` bakelite) is the listener's own: play, saved,
chosen, followed. **Ultramarine** (`#2B45C8` / `#8EA0FF`) is what 4a
authored: narration, bridges, generated-for-you, the floor. Never both on
one control. Ink on paper 15:1, secondary ink 6.3:1, tertiary 4.8:1, white
on persimmon 5.0:1, white on ultramarine 7.5:1; full table in BUILD-NOTES.
Segment colours `--seg-c0..7` become eight enamels at or above 3:1 on both
surfaces, never the only carrier of meaning: every bar gets a station label.

## Materials and elevation (Web)

1. **Paper** (0): the page.
2. **Card** (1): raised enamel, two-layer shadow (1px contact line, soft
   24px).
3. **Keycap** (2): a button with a 3px lower lip in a darker tone of its own
   colour; pressed, it drops 2px and the lip shrinks to 1px.
4. **Well** (inset): the band, scrubber tracks, segmented controls.

**Deck** (3): the floating tab dock with the mini player attached, and
sheets. Tinted enamel at 84% over a 20px blur, solid fallback, opaque under
`prefers-reduced-transparency`. No other blur anywhere. Radii: 8, 14, 22,
pill.

## Iconography

**Phosphor Icons**, Bold weight (MIT), 24px, one inline SVG sprite; Fill
weight for the active tab. Seven custom marks on the same grid: skip-15,
skip-30, band (the foray mark), needle, bridge (the Stretch mark),
narration, knob (a filled disc with a groove pointer and two end-stop dots,
nothing above the disc; two earlier versions with a mark at 12 o'clock read
as a stopwatch, and the fallback if this one fails at the pick is Phosphor
`faders`). No Unicode glyphs.

## Motion (Web)

Springs, not eases, as `linear()` tokens (physics in BUILD-NOTES):
`--spring-snap` 220ms, slight overshoot (keycaps, chips); `--spring-settle`
320ms, critically damped (tab indicator, detents, list gaps);
`--spring-sheet` 480ms, 4% overshoot (the Now Playing sheet); `--ease-quick`
160ms (fades, colour).

Three key transitions:

1. **The deck opens (mini → Now Playing).** The mini player's artwork is the
   shared element (View Transitions, FLIP fallback). It grows into the hero
   while the mini bar's 3px progress line stretches into the full dial band
   and the dock sinks below the safe area. Finger-tracked while dragging,
   handed to `--spring-sheet` on release, interruptible both ways.
2. **The card takes the stage (row → player).** The Play keycap depresses
   with an impact haptic, the artwork flies into the mini player slot, and
   the band draws itself left to right in 280ms.
3. **Detent (tab change, add to Up Next).** The dock indicator slides on
   `--spring-settle` and the icon fills. Adding to Up Next sends an artwork
   chip into the Yours tab; its count badge ticks up.

Reduced motion, one block: durations to 1ms, fades keep 120ms, the band
appears without drawing, keycaps recolour instead of depressing, sheets fade
in place.

## Haptics (Web+, `@capacitor/haptics`)

Impact on play, skip, save and add-to-queue; selection on every detent
(segment boundaries while scrubbing, chapter ticks, tab change, dial
steps); success on bookmark; rigid on swipe-dismiss, with undo. Never on
scroll, never twice in 100ms, silent when the OS says so.

## Layout and density

4px base, 16px gutters at all three viewports, 12px gaps. Rows: shows 56px,
Up Next 64px, episodes 72px. Three-column art grid. A Library viewport
shows 8-10 rows, not 3-5. Keycaps 48px (56 and 80 in the transport).
Content runs under the deck.

## Information architecture and rulings overturned

**Three tabs, no drawer: Today, Find, Yours.** The floating deck carries
them with the mini player docked on top. It narrows to icons on
scroll-down.

- **4 tabs + drawer (D3).** Create does not earn a tab: half its control is
  disabled and the screen is two-thirds empty. "Name a subject" becomes the
  Find field's second job. The drawer's contents go behind one knob button
  at the top right of Today and Yours; tab bar plus drawer is website chrome.
- **Dark-only (U-01).** See Colour.
- **No zoom (2026-09-23).** Restored. The layout is fluid, so pinch-zoom
  costs nothing; WCAG 1.4.4 and 1.4.10 are worth more than a gesture guard.
- **Palette and type.** Changed as above; the amber/violet role rule is kept.
- **Card anatomy.** Four materials replace seven radii and four elevations.
- **Home order and "Suggested".** Resume, Today's foray, Also today,
  Playlists for you, the floor gauge. "Suggested" becomes "Also today".
- **Search A-Z list.** Replaced by a subject mosaic. The bottom field stays.
- **Interests sliders (D6).** Demoted to a rarely visited Dials screen
  behind the knob button; each knob has a "4a's setting" detent.
- **"Show my picks".** Becomes "Play today's foray": value in under a minute
  means hearing it.
- **No share sheet (D10).** Native share on episodes and forays (Web+).
- **Benchmark.** Distinctive, not Apple Podcasts.
- **Car posture.** Observed: on a car Bluetooth route (Web+ if a plugin
  exposes it, else Native) Now Playing switches to Glance: 96px play,
  secondary row hidden. A keycap pins it manually.

Kept: Up Next's played row jumps to the top, 15/30, the bottom search
field. Platform stance: one shared language. Springs and bold
containers read as M3 Expressive; the floating deck and sheet read as iOS
26/27. iOS adds edge-swipe back (Web+).

## Signature moments

**1. The band.** A foray is drawn as a radio-dial band inside a well: bars
proportional to runtime, one enamel per show, narration as short ultramarine
hatched ticks between bars, a needle as the playhead. Station codes (two
letters per show, `OS`, `BR`, `MP`; single initials collided on real data in
r1) sit under the bars, one code per run of adjacent bars from one show (r3
change: an un-narrated band labelled `BR BR`), so colour is never alone. The current bar fills from
a 40% tint to full as it plays. It is 8px on Home cards, 44px with codes in
Foray detail, and the 56px scrubber in Now Playing, where the needle snaps
to segment boundaries with a haptic detent and a readout bubble names the
show and time. "Where this came from" lists each show beside its colour and
code. In Now Playing the set warms to the station: the sheet's tint is the
enamel of the show under the needle and crosses to the next show's as the
needle does (r1 change: averaging a collage gave grey).

**2. The bridge.** A Stretch pick is a two-ended card: the bridge sentence
**first, as the card's headline** (16 words or fewer; r2 change: at 345px
the arc has no room for the words, and reason-then-ends reads stronger),
then what the listener already knows (small artwork, left), an ultramarine
arc that draws itself with **a dot at each end** (the same two-dots-and-an-
arc as the bridge mark; a single dot read as an arrowhead pointing the
wrong way in r2), and the stretch pick (artwork, right). The Stretch tag
carries the bridge mark. Nothing on the card is quieter than the reason.

**3. New ground.** The exploration floor is a gauge at the foot of Today,
drawn in the band's own language so it can never be mistaken for a
setting: a well, one bar, the unfamiliar share as ultramarine hatching (the
narration hatch: authored by 4a) from the left to about a third, the band
needle at that point with its cap above the well, and a mono readout "1 in
3". "About a third of today sits outside your usual subjects. 4a keeps it
that way." (r2 change: a pill with a solid fill and a thumb read as a
slider.)

## Hero screens

**Today.** Display-xl "Today", mono date, knob button. A Resume card only
mid-listen, with a persimmon "Resume" tag and the mini player's 48px key
(r2 change: the card had no word for its state and a key shape of its
own). **Today's foray** hero: title display 32, the band, three
overlapping show discs, mono "about 22 min · 4 shows", the why-line at
body-lg, an 80px Play keycap. "Also today": three pick rows with why-lines,
one the bridge card. "Playlists for you" as composite-art cards. The gauge.
First run: "4a starts with wide bets. Each listen narrows the dial."
Offline: undownloaded items get a grey lip and "Needs a connection".

**Now Playing (full).** Edge-to-edge tint under a paper scrim: for a foray
the current station's enamel, for an episode the artwork's colour (Web,
cached canvas extraction; a low-chroma result falls back to the show's enamel
and a kept one is floored at chroma 0.10, since r3's mauve read as grey under
the Cream scrim). Artwork 280px, shrinking to 200 at 375x667
and 160 under a three-line title. Title 24/28, show name, the band as
scrubber with a mono counter. Transport in the lower third (15, Play at 80,
30), pinned above the safe area so play never leaves the screen. Second
row: speed (a rotary chip with 0.1x detents), sleep ("Sleep · Off"),
bookmark, Up Next as an icon with its count badge. Foray: the needle on a tick shows a "4a narration" chip, on a bar the
show chip with its swatch. Scrolling reveals the detail posture: "Up next"
with its why-line, segments by slot, chapters, show notes.

**Mini player.** 64px on the deck: artwork 44, one-line title, show, a 3px
band along the top edge, Play keycap 48, 30-forward 44. One landmark.

**Find.** Field at the bottom above the deck, placeholder "Search, or name
a subject"; the readout line under the title says "Type any subject and 4a
builds a playlist" (r1 change: a separate "Name a subject" keycap repeated
the field). Idle: a mosaic of subject tiles in three sizes with composite
artwork, shuffled under the floor, no two neighbours from one branch.
Typing: live rows for shows, episodes, playlists. No results: "No shows
match 'fusion'. Fusion & energy systems has 5." with that tile.

**Yours.** A chip strip: Forays, Shows, Saved, Playlists, Up Next, History.
Shows as an art grid, forays as band cards, Up Next rows with artwork, a
needle icon plus "Playing" on the current row, and a ⋯ icon button (not a
keycap: keys are for actions that change playback or the collection; a menu
opener is quiet) revealing Move up, Move down, Remove, with undo. Episode
rows everywhere trail one Play keycap; "+ Up Next" is a text action on the
meta line (r1 change: two trailing keycaps cost the title its width).

**Onboarding.** One screen, no account. A real foray's band draws itself
from live show artwork and the needle moves, with the counter running in
the readout row under the band (never top-right, where it reads as a status
bar). "Podcasts, stitched around
you." Sub: "4a picks real shows each day and lines up the best parts into
one listen." Keycap "Play today's foray"; text button "Just show me".
After a skip: static band, keycap "Play". First run on Today: the line "4a
starts with wide bets. Each listen narrows the dial." takes the why-line's
slot; it never sits beside a "Because you follow…" line, which a first-run
listener cannot have earned.

**Foray detail.** Title display-xl, the 44px band with station labels, mono
"about 22 min · 4 shows · 8 segments", summary, why-line, show discs with
names, segments grouped by slot title. One extended Play keycap (56, icon +
"Play" + mono runtime) pinned at the bottom right (r2 change: an 80px key
beside a label pill read as two controls). In progress: needle in place,
"Resume" + "12:40". Finished: "Played", "Start over". Un-narrated: no
ticks, "No narration yet on this one". Unavailable: an empty well with no
station labels, a lifted needle, "This foray isn't available right now.",
keycaps "Try another foray" and "Yours".

## Risks

Fixes all ten problems in the brief. Risks: (1) the keycap depress must be
tuned on a phone or it reads as 2012 skeuomorphism (r2: the six-frame
capture shows a 2px drop with the lip going 3→1 and no colour change, and
it reads as a key in stills; the hand test moves to the Lab build); (2) two
schemes double the contrast audit and screenshot matrix (r2: Bakelite shot
in full, holds by eye; r3: every new screen holds too); (3) `backdrop-filter`
and View Transitions on older Android WebViews; the fallbacks are not
optional. After r3 the direction is at its prototype ceiling
(`critique-r3.md`); what remains is a build-time pass, not another round.
