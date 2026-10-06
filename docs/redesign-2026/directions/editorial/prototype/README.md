# Edition prototype (round 4)

Round 4 (critique-r3, in priority order)
1. The page turn runs under the harness. The guard now freezes the playhead only (`tick`); a tap or drag-up on the ticker (`userOpen`) or `?motion=1` runs the full choreography (sheet on `--spring-sheet`, plate 40px to the large plate, red rule into the scrubber, title cross-fade, page behind at `scale(.96)` / 82%). `?np=...` route-opens stay instant so static renders repeat. Recorded by tapping with `?motion=1` at 25fps: `data-local/redesign/shots/editorial/r4/motion-393x852.webm`, script `r4/motion/record.mjs`, strips in `r4/motion/` (the open spans about eight frames, `motion-open-25fps-2.2-3.8s.png`).
2. The push is no longer a double exposure. `push-in` is opaque at 15% of 320ms (48ms; the brief allows 100ms, but at the brief's 31% the 25fps capture still caught an outgoing ghost at about 25% in the third frame), `vt-out` dims to 60% and moves 8px, `new` is above `old` (explicit `z-index`, and `mix-blend-mode: normal` so the UA's `plus-lighter` cannot add two opaque pages). The pop mirrors it: the leaving page stays opaque and on top until its last 42ms (`pop-out`), the list under it eases `.6 -> 1` (`pop-under`). `?vt=0` path gets the same `z-index`.
3. Hooks: the two splatter hooks are rewritten (`Databases dodge the hard distributed problems. Rust borrows the trick.` is 70 characters: the brief's own wording counts 73 by `[...s].length`, over its 72 limit, so `the hardest` became `the hard`; `Seven destroyers ran aground at Honda Point in one night, in 1923.` is 66). The first run of the new check then failed on a third hook at 375px (`Anansi ... trail of broken people in his wake.`, 72 characters, four lines in the narrow column), so it is now `Anansi the spider trickster, and the broken people in his wake.` (63). `fitHooks` marks an overflowing item `data-hook-overflow` and calls `console.error`; the harness reports it under `errors`. All six pass at 393, 375, 412 (`errors: 0`).
Should-fix done
- Browse has no deferral line. Commission submits to results: a chip tap, or Enter in the Commission field, or the `Or commission a playlist on [x]` chip opens results with `PLAYLISTS` first (the commissioned playlist is cut from the catalog by subject: salt -> History, bridges -> Engineering, fusion -> Science), then `SHOWS`, `EPISODES`. Every result page now orders Playlists, Shows, Episodes. State is in `S.commissioned`, never the URL, so `?q=fusion` still renders the `Nothing titled` state.
- Queued rows show `list-checks` (new glyph in `icons.js`, Phosphor Regular) in `addBtn` and in the cross-fade; no bare `check` remains in the app.
- The onboarding band carries the 48px `::before` fade (its rule stays; the fade ends 1px above it). Checked at 393x852, 375x667 and 412x915.
- A foray's meta is derived from its rule: `forayStrand` counts the distinct inks; `data.json` `more_forays` now carry `shows: 6` and `shows: 4`, and the tectonics plate has four different covers (it repeated one). The lead's meta and key already read `F.shows.length`.
- Browse's Followed grid: a viewport render scrolled to the grid shows 8 of 8 covers at all three sizes (`r4/checks/followed-*.png`, `followedImgs: 8`); the initials in the earlier full-page captures are image load timing on a tall page, not a wrong URL.
Art director's tune after round 4 (critique-r4 §2): `--spring-sheet` is stiffness 230 / damping 28 (was 260 / 28, which landed the sheet by 146ms while the plate was still in flight); the plate and the rule fly on the same `linear()` read from the stylesheet, the title fades in from 40%, and the rule travels the full 420ms then thickens and fades over 120ms. Re-recorded capture and tiles: `data-local/redesign/shots/editorial/r4-ad/motion/`.
Params: `?motion=1` is new (it persists for the session like the others and never writes the store).
Checks that a route list cannot reach are in `data-local/redesign/shots/editorial/r4/motion/check.mjs`.

# Round 3 (kept for the record)

Round 3 (critique-r2, in priority order)
1. 4:3 contact plates (Today lead, Foray detail, onboarding) are lead-and-column: `.plate--contact.is-lead`, `3fr 1fr` by three rows, so the first show is a full-height square and no cover is cropped. Square plates keep the 2x2.
2. Now Playing note clamps to two lines; one line only at `max-height: 700px`; hidden at 130% on short screens as before.
3. Plate region `padding-bottom: 8px`, `.np-scrub` margin 0: the plate sits about 27px over its rule.
4. No selection while dragging: `user-select: none` on the sheet header, plate region and anything inside a dragging panel, and `preventDefault()` on the drag's `pointerdown`. A Playwright run (393x852, drag to dismiss) reports no selection in any frame; injecting `user-select: text !important` on the sheet makes the same run select `Up next: Spolia`, so the check can fail.
5. Splatter hooks are authored (`hook` field in `data.json`, six items). The clause-cutter is gone; `fitHooks` only warns when a hook overflows three lines.
6. Fallback initials scale with the cell: `container-type: size`, `font-size: clamp(14px, 28cqh, 64px)`.
7. `--tint-h` is set, not transitioned.
Should-fix done: `UP NEXT · 5` in one run; `All forays` style feet (13px, `--ink-2`, `arrow-right`); Browse sub-line at 13px `--ink-3`; key line spacing; offline meta row inline; `fusion` empty state gains `Or commission a playlist on [fusion]`; the page turn cross-fades the title in place and flies only plate and rule.
Not done: the 375x667 onboarding veil `max-height` (the band's rule already lands at the lead plate's bottom edge there).

Open `index.html` over http (`npx serve .`) or directly; `data.js` is the file:// fallback copy of `data.json` (the one console error under file:// is the failed `fetch` before that fallback).
Routes: `#/home #/mini #/now-playing #/search #/library #/foray #/onboarding` (plus `#/colophon`).
Params on any route (render instructions only; they never write the store, only the Colophon controls do): `?scheme=paper|night`, `?text=130`, `?state=first-run|offline|loading|mid-listen`, `?dl=0` (offline lead not downloaded), `?np=paused|buffering|episode`, `?fstate=progress|finished|unavailable`, `?cur=foray` (Library with a foray playing), `?large=1`, `?kbd=1`, `?vt=0`, `?noart=1` (every plate falls back, to check the no-art treatment), `#/search?q=history`.

Round 2 (critique-r1, in priority order)
1. Up Next: numeral column stays 28px; the current row holds a red 16px glyph there (stitch for a foray, speaker for an episode), `PLAYING` slug above the title, 72px, red left rule. Same fix applied to the Contents current row.
2. Onboarding: `.first-actions` is a solid band; the veil is three pieces and the middle one (`.veil-cut`, 40%) sits over the lead plate only.
3. `--rule-strong` Paper `#8E887C`, Night `#66666E`; chips use `--rule`.
4. Now Playing at 130% on 375x667: tab and action labels are fixed 11px; note hidden and key line one line on short screens at 130%; plate is 200px there (harness check in `data-local/.../r2-check`). Action row columns are `auto` with space-between rather than five equal cells, because `UP NEXT · 5` is wider than a fifth of 375px. Plate region is a size container so the plate takes exactly the room left.
5. Today's key: `4a` first, shows after, capped at two lines, `+n shows` for the rest (measured in JS after fonts load).
6. Dateline: two block lines; offline adds a line above with `wifi-slash`.
7. No-art fallback: show ink at 16% over stock-2 with the initial in the ink (contact and grid cells), stock-2 and `--ink-3` initial for single plates. Every plate also carries its initial underneath the image, so a slow image never leaves blank stock. Images are no longer `loading="lazy"` (a full-page capture left them blank).
8. Hooks: the catalog hook is used whole; if three lines of the column cannot hold it, it is cut at the last clause boundary and ends with a full stop (measured in JS, `fitHooks`).
9. Segments are numbered 1-11 everywhere; narration rows carry the stitch glyph and no number.
10. Commission is a ruled box with `pencil-simple-line`; the pill is `.find` only.
11. Resume shows on a cold start (`?state=mid-listen`) or after Stop, never while the ticker shows the item; it has the 4px progress rule.
12. URL params never persist.
13. Stretch card has one red spine from the slug to the end of the note.
Should-fix items done: plate region aligned to end, foray Now Playing shows the segment title, `Where this came from` rows are links with no `Open`, meta orphans (duration is `nowrap`, show name ellipsizes), Followed grid `minmax(0,1fr)`, `Play the edition` hidden while loading, offline lead `DOWNLOADED` slug or disabled play with `cloud-slash`.

Motion
- `transform`/`opacity` only: the scrub/drag thickening, the cursor, the folio collapse (its skin scales, its height does not), the queue insert (neighbours slide, the new row fades in) all moved off `height`/`left`/`maxHeight`. Only colour transitions remain (chips, switch, `.find` border), as specified.
- The page turn now flies the plate, the title (15px to 24px as a scale) and the progress rule into the scrubber together, on the spring sheet. Row to detail uses View Transitions with a shared plate.
- A 10-second capture (ticker to Now Playing, drag down, row to detail and back) is in `data-local/redesign/shots/editorial/r2/motion-393x852.webm`.

Still deviating from BUILD-NOTES.md
- Playback is simulated; the playhead is frozen when `navigator.webdriver` is true so renders repeat.
- Data: 40 episodes sampled from `data/discover.json`; the foray is the published `capital-types-1`. Its shows' artwork comes from the public iTunes Search API. The four narration segments are a prototype stand-in. The two "More forays" borrow subject-neighbour artwork.
- Play and pause on the big circles use Phosphor Fill. Skip glyphs keep their numerals as `<text>`.
- Newsreader is ~278KB, over the 110KB budget; a Phase 3 subset closes that.
- Edge-swipe back, haptics, pull-to-refresh and the sticky scrubber on scroll are not built.
- Episode rows play on tap (no episode detail page).
