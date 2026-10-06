# Edition

**Thesis.** 4a is a daily listening edition: dated, typeset, and edited by a curator who signs every reason in red pencil.

Logo covered, you know it by three things: a masthead with a dateline instead of a greeting; editor's notes in italic beside a red margin rule; a foray drawn as a stitched rule with a table of contents. No podcast app looks like a well-made newspaper, and 4a's real asset, the why-line, is already editorial copy. Measurements: `BUILD-NOTES.md`.

## Mood

A good weekend paper on cream stock: calm, literate, confident. Generous margins, hairline rules, one spot colour used like a red pencil. Artwork is printed as plates inside the column, never bled. Nothing glows or bounces; things are set on the page. At night the stock turns to ink and the type to cream, the same page under a reading lamp. Not a skeuomorph: no texture, no page curl. The craft is proportion, rules and type.

## Rulings overturned, and why

- **Dark-only (U-01): overturned.** Paper (default) and Night, by `prefers-color-scheme` with an override. Print reads on paper; the car at night needs ink. Both are designed palettes.
- **Four tabs + drawer (D3): overturned.** Three sections: **Today**, **Browse**, **Library**. Create folds into Browse as the "Commission" line; a half-built screen does not earn a tab. The drawer goes; Interests, scheme and about live in a **Colophon** sheet behind the masthead.
- **No zoom: kept, conditionally.** Pinch stays off; type follows the OS text size (Web+), verified at 130%.
- **Accent roles (amber/violet): overturned.** One spot colour. **Red pencil** marks everything 4a authored: notes, Stretch slugs, narration, "Playing". The listener's own material is plain ink in bold weight: their things are the paper itself.
- **Type:** Fraunces and DM Sans kept; **Newsreader** (OFL) added as the reading face.
- **Seven radii, four elevations, card anatomy: overturned.** Three radii plus pill; elevation by rules and stock tones.
- **Home order and names:** "Suggested" becomes **Also today**; rails become numbered lists; an item appears once. The play button stays as `Play the edition`.
- **"Show my picks"** becomes **Open today's edition**. **"Daily"** stays: a dated edition is the honest form of daily.
- **Search:** field kept at the bottom; the A-Z wall becomes a subject index plus an artwork splatter.
- **Benchmark:** distinctive over Apple Podcasts. **Share sheet:** present, native. **Up Next:** played row still jumps to the top; reorder via an action sheet.
- **Car posture:** glance is Now Playing's default; a "Large print" switch enlarges transport. Automatic switching on a car route is Native, deferred, not faked.

Not challenged: the floor, seek-and-stop audio, continuous playback, the 15/30 pair.

## Typography (OFL, self-hosted)

| Role | Face, size/line, weight |
|---|---|
| Masthead | Fraunces italic opsz 144 WONK 1, 34/36, 600 (wordmark only) |
| Display-1 | Fraunces opsz 72, 30/34, 500 (lead headline, page titles, list numerals at 400) |
| Display-2 | Fraunces opsz 48, 24/28, 500 (Now Playing title, section heads) |
| Title | Fraunces opsz 24, 19/24, 500 (rows, cards) |
| Text / Note | Newsreader 16/24, 400; italic for editor's notes only; 14/20 for dense meta copy |
| Label | DM Sans caps, ls +0.08em, 12/16, 500 (kickers, tabs, slugs, folio) |
| Meta / Button | DM Sans `tabular-nums` 13/18, 400; buttons 15/20, 600 |

Fraunces at 19px and above, Newsreader 14 to 16, DM Sans 15 and below: no face enters another's band, so no mix is accidental. Minimum 12px, meta only. Type follows the OS text size, with one exemption: the 11px captions under the tab and Now Playing action glyphs are fixed (round 1 showed them overprinting at 130% on a 375px screen).

## Colour

**Paper:** page `#F7F3EC`, stock-2 `#EFE9DF`, ink `#17171A` (16.4:1), ink-2 `#4A4A52` (8.2:1), ink-3 `#6B6A72` (4.8:1, meta only), rule `#D9D2C5`, rule-strong `#8E887C` (3.2:1, rules that carry meaning), red pencil `#B5301C` (5.6:1), red wash at 8%.

**Night:** page `#141416`, stock-2 `#1C1C1F`, cream `#ECE7DC` (15.1:1), cream-2 `#B3AEA4` (8.4:1), cream-3 `#8A857C` (5.0:1), rule `#2B2B30`, rule-strong `#66666E` (3.3:1), red pencil `#F07A62` (6.5:1), red wash at 12%.

Segment inks, stable per show, 3:1+ on the page: teal `#1F6F8B`, ochre `#B8862B`, violet `#6B4FA0`, green `#2E7D4F`, umber `#8C5A2B`, cobalt `#3B5BA5`, magenta `#A3366F`, olive `#5B6B2B`; Night lifts each 18%. Narration is red pencil **hatched** at 45°: pattern as well as colour.

Artwork tint (Web): Now Playing and detail pages take the artwork's dominant hue as a 6% (Paper) / 10% (Night) wash, extracted once on canvas and cached. The page stays stock; the art stays a plate.

## Materials and elevation

- **0, page.** Flat stock; sections divided by 1px rules, not cards.
- **1, inset.** Stock-2 with a rule: plate backing, fields, chips.
- **2, sheet.** Page colour, 12px top radius, two-layer shadow; the page behind scales to 0.96 and dims 18%.
- **3, floating chrome.** Folio bar, ticker and search field only: page at 86% with `backdrop-filter: blur(20px) saturate(1.2)`, solid under `prefers-reduced-transparency`. Blur nowhere else.

Plates: 4px radius, 1px inner rule at 10% ink.

## Iconography

**Phosphor** (MIT), Regular weight, 24px frame, one sprite; Fill weight for the active tab only. Custom glyphs at the same 1.5px stroke: skip-15 and skip-30 (open arc, numeral inside), the **stitch** mark (three short rules joined by a red thread; the foray glyph) and the explicit badge (ruled "E"). No Unicode glyphs.

## Motion

Calm and interruptible; overshoot never above 2%. Tokens `--t-micro 120ms`, `--t-state 200ms`, `--t-page 320ms`, `--t-sheet 420ms`, `--ease-out cubic-bezier(.2,.7,.2,1)`, `--spring-sheet` as `linear()`. Only `transform` and `opacity` animate. One `prefers-reduced-motion` block swaps every transition for a 150ms fade.

1. **Ticker to Now Playing, the page turn.** The 56px ticker expands into the sheet on `--spring-sheet`; the 40px plate is a shared element (View Transitions, FLIP fallback) landing in the large plate; the progress rule stretches into the scrubber; the title cross-fades 15 to 24px. Drag-to-dismiss follows the finger, then the spring.
2. **Row to detail.** Push: incoming slides 24px and is opaque within 100ms, outgoing parallaxes 8px and dims to 60%, 320ms; the plate is shared. Two headlines are never readable at once (round 3 showed a double exposure). Edge-swipe back tracks the finger (Web+).
3. **Add to Up Next.** The plate shrinks toward the Library tab while the queue opens a 60px gap and the count rolls like a numeral wheel. Remove reverses, with undo.

## Haptics (Web+)

Light impact on play, pause and bookmark; selection tick when the scrubber crosses a segment or chapter; medium impact when one item ends and the next begins; success on "Added to Up Next" and download complete. Never on scroll.

## Grid and density

20px margins, 12px gutter, four columns, 4px baseline, 8px steps, measure 34em. Rows: episode 64px, queue 60px, show 56px, foray 80px; seven to ten items per viewport.

## Information architecture

A floating folio bar: **Today** (`newspaper`), **Browse** (`magnifying-glass`), **Library** (`bookmarks-simple`), labels under icons, minimising on downward scroll. The ticker docks above it when something plays. The masthead "4a" opens the Colophon (scheme, large print, interests as a short ranked list, about). No drawer, no title rules, no refresh glyph: pull to refresh.

## Signature moments

**The front page.** Today opens on a masthead and a dateline: `MONDAY 5 OCTOBER · YOUR EDITION · 3 PICKS · 1 STRETCH · 1 HR 40 MIN`. The exploration floor is printed in the dateline every day: the honest, visible form of the ~30% rule. Every why-line is an **editor's note**, Newsreader italic beside a 2px red margin rule, second in loudness only to the headline.

**The stitched rule.** A foray is a horizontal rule of segments proportional to runtime, each in its show's ink, narration hatched red. Beneath it a **key** (swatch, show name) and, on detail, **Contents**: numeral, segment title, show, dot leaders, time at the right; narrated lines read "4a" in red. The same rule is the scrubber in Now Playing, the current bar filling under a red cursor, the key line reading `3 of 7 · Hard Fork · 6 min left`. The plate is a contact of the shows' artwork: 2×2 where the plate is square (Now Playing, rows, grids); at 4:3 (lead, detail) the first show fills a square at the left and the next three stack in a column at the right, so no cover is ever cropped (round 2 beheaded every typographic cover at 4:3). A foray is visibly neither an episode nor a playlist.

**The Stretch slug.** A red small-caps `STRETCH` on its own hairline above the title; the editor's note opens with the bridge ("Adjacent to your energy picks: the grid side of the same story"). The loudest line on the card, never the quietest: the card's red margin rule runs the full height of its text, slug to note, so the Stretch card is the one with a red spine (revised after round 1, where the slug alone read quieter than the title). **The page turn** (motion 1) is the delight editors see first.

## Hero screens

Full measurements per screen and state are in `BUILD-NOTES.md`.

**Today.** Masthead, dateline (two set lines, never a line opening with `·`), rule. Mid-listen: a `RESUME` row with a red ribbon mark, hidden while the ticker already shows that item. Lead: kicker, Display-1 headline, 4:3 plate over the stitched rule, key capped at two lines plus `+n shows` so the editor's note stays on the first screen, editor's note, meta with a 56px ink play circle. **Also today**: a numbered list (Fraunces numeral, 64px plate, title, note), one Stretch slot guaranteed. **More forays**, **Your subjects**, footer `Assembled 6:12 this morning · Why these?`. First run reads `FIRST EDITION`; offline adds `OFFLINE · DOWNLOADED ONLY`; loading is a skeleton of rules.

**Now Playing.** Full sheet on tinted stock. Plate `min(100vw − 40px, 38vh)`, so transport never leaves a 375×667 screen. Scrubber (stitched rule for forays, plain for episodes, 44px hit area) tight under the plate, clocks, Display-2 title (clamp 2), then the show for an episode or the current segment's title for a foray (the key line already names the show), editor's note at two lines (one line only on screens 700px and shorter). Segments are numbered without narration: `9 of 11`, never `9 of 15`. Lower third: skip-15 56px, play 80px ink circle, skip-30 56px, then a labelled 44px row: `1×`, `Sleep`, `Bookmark`, `Up Next · 5`, `More`. Scroll up for Contents, Where this came from, show notes, Up Next peek. Large print: play 96, skips 64.

**Ticker (mini).** 56px blurred page, red progress rule along the top, 40px plate, title, play 44, skip-30 44. Tap or drag up opens; swipe down stops, with undo.

**Browse.** **Commission** as a ruled box with a pencil glyph (the pill is the search field's alone) with three chips; a subject typed or tapped opens its results with the playlist first. No line about what comes later (round 3: it read as an apology). **Off your beaten path**, six plates in a two-column splatter, no two from one branch, each with an authored hook (a hook is written, never cut from a description; ≤ 72 characters so three lines hold it in the narrow column); **Subjects**, a two-column index; **Followed** grid. No results: "Nothing titled 'fusion'. Subjects that touch it:" then the Fusion row.

**Library.** Forays (80px rows), Up Next (60px rows, numeral, plate, `…` action sheet; the current row marked by a red `Playing` slug above its title, a red glyph in the numeral column so every plate keeps one x, and a left rule), Followed grid, Saved, Playlists, History. Empty: one Fraunces sentence per section, next step linked.

**Foray detail.** Kicker `A FORAY · 43 MIN · 4 SHOWS`, headline, the stitched rule at 12px with its key, note, play, **Contents**, **Where this came from**. States: `Resume at 18:40` over the rule; `Played Tuesday · Play again`; un-narrated, "No narration yet. Segments play back to back."; unavailable, a ruled notice with `Browse similar`.

**Onboarding.** The real first edition, live, under a 70% page veil: masthead, `FIRST EDITION`, one promise in Display-1, "A daily listening edition, set from real podcasts, around you," one note, "About a third is picked to stretch you. 4a says why, every time." `Open today's edition`; `Not now`, on a solid band the veiled page fades into over 48px, never a rule cutting a line of type.

## Feasibility, risks, fixes

Web: type, schemes, rules, plates, tint extraction, chrome blur, `linear()` springs, View Transitions with FLIP fallback, dot leaders. Web+: haptics, status bar, share, media session, text zoom, edge-swipe back. Native, deferred: car-route detection, real Liquid Glass. Risks: three families (Latin subsets, about 300KB); Paper on OLED in a dark car (Night follows the OS); dot leaders with long titles (one-line clamp, fixed time column). It addresses all ten listed problems: plates everywhere, a bounded immersive sheet, one lead and no repeats, 56 to 80px rows, one sprite, one red, masthead and folio for chrome, the stitched rule, one note style, typographic empty states.
