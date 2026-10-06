# Direction: Clarity ("The Board")

**Thesis.** A listening schedule you can read at arm's length: one grid, one
accent, numbers that line up. 4a stops looking like a feed of cards and starts
looking like a departures board for your day. (Builder values:
`BUILD-NOTES.md`.)

## 1. Mood

Airport signage, a Swiss railway timetable, an instrument panel. Paper and
ink by day, ink and black by night. A hard left edge, a right-aligned column
of times, hairlines instead of boxes. Colour is rationed: the artwork supplies
all of it, plus one signal accent marking exactly one thing per screen (the
thing you would tap in a moving car). Nothing is decorated; everything is
labelled. With the logo covered you know it by the board: ruled rows, mono
times on the right, a stitched timeline under every foray.

## 2. Typography (OFL, self-hosted)

One family, two faces: **Geist** (text) and **Geist Mono** (data), both OFL
1.1, variable, two woff2 files, about 160 KB. Mono carries every number that
must not jitter: durations, clocks, counts, positions, the date. Tabular
figures everywhere. Fallback if Geist hints badly on old Android WebViews:
Inter + JetBrains Mono (OFL).

Scale (size/line, weight): display 34/38 600; title 22/26 600; body-strong
17/22 560; body 17/24 400; label 15/20 500; caption 13/16 500; mono data-lg
22/26, data 15/20, data-sm 12/16; the Today date alone is set in mono at the
display size (34/38, 500), the board's masthead. Six sizes, three weights,
no italics. In a row the show name is caption (muted), the title body-strong,
the why-line body in **ink on every row**, never grey (r1 critique: the why
was grey everywhere but the stretch row, which inverted the hierarchy the
board exists for), and **it finishes**: the why runs under the data column
to the right gutter and takes up to three lines (r3 critique: a two-line
clamp in the 201px stack cut every one of forty hooks; a loud line that ends
in an ellipsis on every row is worse than a grey one that ends).
Fraunces + DM Sans is **overturned**: a board is set in one grotesk; the
character lives in the mono column.

## 3. Colour: light and dark, one accent

**Dark-only is overturned.** The board is designed twice and follows the
system (`color-scheme: light dark`) with an in-app override; neither scheme is
an inversion of the other.

One accent, **Signal** (`#E8491D` light / `#FF7A4D` dark), marking one thing
per screen: the primary play control, the current position, the live row.
Text on Signal is always the scheme's base black (4.7:1 light, 7.6:1 dark);
small Signal text on paper uses `accent-ink #B4330C` (6.1:1). The amber/violet
roles are **overturned**: "yours" versus "4a's" is said in a label ("Picked by
4a", "You saved this"), not in a hue a new user cannot decode. Neutrals: ink
18.4:1 / 17.4:1, muted 6.7:1 / 7.7:1, faint 3.5:1 / 4.3:1 (never text). Eight
show colours for the strip, retuned per scheme so every bar clears 3:1 on both
backgrounds; narration bars are **hatched neutral**, so the strip reads
without colour.

Now Playing does **not** tint from the artwork. The brief recommends it; the
reason to differ: letting artwork bleed into the chrome makes every screen a
different colour and every text pair a runtime contrast calculation. Artwork
framed by a hairline on paper is the identity.

## 4. Materials and elevation

Two levels, three surfaces: **base** (paper), **raised** (the sheet: same
colour, a hairline, a 24px top radius), and the **dock** (tab bar + mini
player as **one** floating capsule: mini on top, a hairline, tab bar below, no
gap). The dock is **solid** (`#FFFFFF` / `#161618`), not translucent: round 2
tested the blurred tint at 2x and row text still read through it, and the
direction already declined faux glass, so the fallback became the rule
(r2 ruling 1). Nothing in the app blurs. One shadow in the app, on the dock.
No card fills: hairlines separate rows, space separates groups.

## 5. Iconography

**Lucide** (ISC), about 32 glyphs in one inline SVG sprite: 20px, 1.75px
stroke, round caps. Transport glyphs are custom on the same grid: play, pause,
15-back and 30-forward with the number in Geist Mono inside the arc. No
Unicode glyphs; the explicit marker is a 16px mono badge.

## 6. Motion

Fast, flat, legible. Durations 120 / 200 / 320 / 480ms; one standard ease
`cubic-bezier(.2,0,0,1)` and one `linear()` spring with mild overshoot. Only
`transform` and `opacity` animate (**Web**). Key transitions:

1. **Mini player → Now Playing.** The sheet rises over the dock (the dock
   stays painted beneath it); the 44px artwork and the title are shared
   elements (FLIP; View Transitions dropped in r3 so there is one path to
   test) travelling to their full-size slots while the rest of the sheet's
   content fades in from below. 480ms spring, driven and interruptible by
   the drag (**Web**). The dismiss is the same path back at 320ms on the
   standard ease: the two elements fly home, the content fades out in the
   first 120ms, the scrim fades with the sheet, and nothing else moves. An
   empty art slot or a close button sliding over the dock is a defect
   (r3 critique).
2. **Row → Foray detail.** The 4px strip under the row travels and scales
   into the 24px timeline; the page fades in beneath it. 320ms (**Web**;
   edge-swipe back via `@capgo/capacitor-transitions`, **Web+**).
3. **Today collapses.** Scrolling shrinks the display date into the caption
   header, scroll-driven behind `@supports` (**Web**).

One `prefers-reduced-motion` block replaces all three with 120ms cross-fades
and freezes the strip fill.

## 7. Haptics (Web+, `@capacitor/haptics`)

Light impact on play/pause; selection tick at each segment or chapter
boundary while scrubbing; medium impact on 15/30 skip; success notification on
bookmark and "added to Up Next". Nothing on scroll.

## 8. Grid and density

4px base, 8px rhythm. Gutter 20px (16px at 375). The **data column** is the
right 72px, where every time, count and position lives, right-aligned in mono,
on the row's first line; the why-line passes beneath it to the right gutter.
Rows: episode 112px with a two-line why, 136px with three (caption show,
one-line title, the why); lead 160px / 184px (eyebrow, show line, two-line
title, the why, strip); stretch 136px / 160px (adds the bridge line); resume
80px, show 56px, queue 64px, segment 48px. Target density, **re-measured in
round 3**: the lead plus **two full board rows and the third row's title at
393×852, three at 412×915, one and the second's title at 375×667**. Round 2
had lead + four / four / two on 112px rows whose why-lines were cut at seven
words on every row; four rows that stop mid-clause are not denser than three
that finish, and the board's claim is legibility at arm's length, not row
count. (Round 1 promised seven to nine on a 72px row that a three-line stack
of 17px text cannot produce.) Thumbnails 56px in rows, one 6px radius.
Durations of an hour or more are one mono line, `3h 05m` (minutes padded so
the `h` aligns down the column); under an hour, `37 min`.

## 9. Information architecture, and the rulings overturned

**Three tabs: Today, Find, Library. No drawer.** The Create tab is
**overturned**: "name a subject" becomes the first row of Find (one field, one
job); the Foray option returns when custom forays ship. The drawer is
**overturned**: settings, interests and downloads sit behind the 44px "You"
button on Today. Find keeps its bottom field (reach); the A-Z show wall is
**overturned** for a subjects board with counts.

Also overturned: **no zoom** (pinch-zoom returns; WCAG 1.4.4 outweighs a stray
zoom); **card anatomy** (rows, not cards; three radii, two elevations, one
pill); **Home section order** (picks, resume, forays; "Suggested" becomes
"Picked for you"); **no share sheet** (native share; the gate was withdrawn);
**interests as sliders** (an observed weight table with less/more steppers).
Kept: "Show my picks", "Stretch", the daily framing, the 15/30 pair.

**Platform stance:** one neutral language on both phones, native details per
platform (haptics, status bar, back gesture, share); no faux glass on Android,
no Material containers on iOS. **Car posture:** glance mode appears
automatically on a car Bluetooth route (**Web+**, observed, never declared).

## 10. Signature moments

**The board.** Today is a ruled list, not a carousel. Each pick is one row:
artwork, show, title, the why-line as the largest text in the row, a mono
duration in the data column. The lead row carries the Signal play control.
Above the list, one honest mono stat: "6 picks · 2 outside your usual lane",
the exploration floor made visible: observed, not hidden.

**The stitched timeline.** Every foray carries a strip: bars proportional to
runtime, one stable colour per show, narration as hatched neutral gaps. Under
a row it is 4px; on detail it is a 24px ruler with 5-minute ticks and a legend
table (chip, show, segments, minutes). In Now Playing it **is** the scrubber:
the current bar fills left to right, the readout says "3 of 8 · Satay Okay ·
4:12 left", a tick fires at each boundary. That is what makes a foray visibly
its own kind of thing.

**The bridge, loudest line on the row.** A stretch pick opens with a mono
line in Signal, `fusion → materials science`, then the show name as a caption,
the title, then the bridge sentence in body: "You care how alloys behave under
stress; ancient smiths solved carbon control blind." Never below the title,
never grey. The show name stays in the stack: the data column is for numbers,
and a proper noun broken over two 12px lines there was the one accident in
round 1.

**Signal's budget.** Besides the global mini-player play, a screen spends
Signal on one control (the lead play, Resume, Show my picks) and the live mark
(playhead, the word "Now", the bridge). Text buttons are ink with a chevron;
"Later" is muted. If a screen has two Signal buttons, one is wrong.

## 11. Hero screens

**Today.** Date in display mono ("Mon 5 Oct"), a 44px "You" button, the stat
line, then the board: lead row (160–184px, 72px art, the 44px Signal play
circle with the duration under it, eyebrow "Today's lead", then the show line
in ink, which for a foray reads "Foray · 7 shows", then a two-line title, the
why running under the circle column to the right gutter, the strip at the
same width), rows at 112–136px under caption heads in this order: Resume (only when
something is mid-play; 80px rows with a 2px progress line under the art and
"28 min · left" in the data column), **Forays for you** (4px strip; the strip
must be inside the first viewport at 393×852 whenever a foray exists, and when
today's session carries one the lead row may be the foray), then Picked for
you; one Stretch row per section. Mid-play, the lead keeps the 44px circle
(labelled "Resume") and its data column reads the remaining time; the word
never goes in the 72px column. First run: "Picked to start", no stat line
(nothing observed yet). Offline: saved rows marked, the rest dimmed (text
muted, bridge muted, art at half opacity). Loading: a skeleton of the same
rows, hairlines included. Stress: board titles clamp to one line, the lead's
to two, why-lines to **three** (they span the data column, so three lines
hold a 16-word hook; a clamp that fires on every row is a layout fault, not
a stress rule); durations never truncate.

**Now Playing, full.** Sheet, grabber, 44px close. Artwork sized
`min(100vw - 40px, 56dvh - 175px, 390px)` (r2 ruling 2: 300px at 852, 198px
at 667, 337px at 915), so at 375x667 with a long title the transport stays in
the thumb zone and at 393x852 the control row stays on screen. Title clamps
to two lines, show, why-line (three lines; two at viewports 700px high or
less, never one: r3 found a one-line why reading "Venture money is one option
of eight; see…", which says nothing).
Scrubber: 6px track, 44px hit area, mono elapsed left and remaining right on
one baseline; for a foray the track is the strip. Transport: 15-back 56px,
play 72px Signal, 30-forward 56px. Scrolling the sheet reveals the detail
posture: segments or chapters table, a 44px control row (speed, sleep,
bookmark, share, Up Next), show notes clamped to four lines, "Up next: title ·
why · in 4:12". Buffering replaces the clock with the word, no spinner; at the
end the Up next line rises into the title slot.

**Mini player.** 64px, one capsule with the tab bar: 44px art, title and
show, play/pause 48px, 30-forward 44px, a 2px progress line on the top edge.
One landmark: "Now playing: title, show".

**Find.** Field at the bottom above the mini player. Idle: subjects board
(name, mono show count), Shows you follow, Recent. Typing: Shows / Episodes /
Playlists, each head with a count. No results: "Nothing for 'fusion'. Fusion &
energy systems has 5 shows", with that row under it, so the message never
contradicts the screen.

**Library.** A 3-up artwork grid of followed shows (names in caption over two
lines, so "Lex Fridman Podcast" wraps rather than truncates), then tables with
counts: Forays (strip under each), Saved, Playlists, Up Next, History. Up Next
rows 64px: mono position, art, title, the time in the data column, "35 min"
over "left" when the item is started and the plain duration when it is not
(a bare number cannot say which it is); the playing row has a Signal left
rule and the word "Now"; the Up Next count is the items after the one
playing, the same number everywhere. Reorder by move up / down / remove,
with undo.

**Foray detail.** Display title, subject, mono "22 min · 8 segments · 6
shows", the 24px timeline, "Why for you", a Signal "Play" / "Resume at 9:40" /
"Play again", then the legend table, which is also "Where this came from".
Unavailable: timeline greyed, "Not available right now; the shows are still
here". Un-narrated: no hatched gaps, "No narration yet".

**Onboarding, first screen.** The product, not a tutorial: a real three-row
board from `session.json` (two rows at viewports 700px high or less, and
there the headline drops to the title size so the budget closes; every
why-line finishes, because the reason is the pitch), the headline "Each
morning, 4a picks a few episodes and says why." (11 words), a sample strip
with the foray definition, "Show my picks" in Signal, "Later" as text. The sample rows carry **no bridge**: nothing is
observed yet, and a bridge claims a lane 4a has not seen; Stretch appears on
Today once there is one. After skip: "Your picks are ready".

## 12. Featurability, risks, problems fixed

Distinctive idea in three seconds: the board, the timeline. Idiom: neutral,
with a stated reason. Native interaction: sheets, haptics, share, lock screen,
edge-swipe (**Web+**). Accessibility: a label on every control, rem type with
zoom restored, `prefers-contrast` strengthens hairlines, meaning never by
colour alone (hatching, words, position), one reduced-motion block, 44px
targets, AA everywhere. Every empty, offline and error state is a row with an
action.

**Risks.** (1) One accent, no tint and a solid dock can read cold beside
glass-heavy competitors; artwork density and the timeline are the answer.
(2) Geist hinting on old Android WebViews; fallback named. (3) The three
transitions are FLIP only (View Transitions dropped in round 3: one path on
two WebViews); round 2 showed the FLIP must own the artwork end to end (the
composite is drawn when play starts, never during the transition) and round
3 that the sheet's own art slot must be invisible while a flyer is in the
air, in both directions.

**Of the ten problems, all ten:** 1 art on every row; 2 one transport, play
always on screen; 3 one lead row; 4 72/64/56px rows; 5 one sprite; 6 one
accent; 7 no header, no drawer; 8 the timeline; 9 one row, one chip, three
radii; 10 designed states with an action.
