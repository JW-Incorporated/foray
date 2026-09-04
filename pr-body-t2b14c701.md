## Summary
Requirement B3/Q6 from Joey's marked-up requirements doc:

> somewhere on the show page, we should have some mention of 'used in the
> following forays'. It should be obvious that it's not from the show,
> perhaps in the footer or something like that. And yes, each foray links
> each show and ID.

Two independent fixes:

### 1. Show page: "Used in the following forays" footer
`renderShow` now renders a clearly-separated `<footer class="show-forays">`
band listing every Foray that draws on the show, computed by
`foraysUsingShow()` — the reverse direction of `foraySourcesHtml`'s own join
(`data/forays.json` -> `data/segments.json` -> `data/segment-sources.json`).

- Never interleaved with the show's own episode list — sits after every
  `epRow`, behind a rule + uppercase label + explanatory note, per the
  requirements doc's B1 rule (forays stay visually distinct from episodes
  everywhere).
- Respects the same draft-visibility rule the Foray home screen already
  keeps (`player/foray-resolve.js`'s `forayVisibility`): an unpublished
  Foray is named only once the visitor unlocked it by id (`?foray=`), never
  by default.
- Renders nothing at all when no Foray uses the show (absence is a real,
  renderable state — Stage 1's own rule, reused here).

### 2. Fixed: `foraySourcesHtml` did not actually link each show to its show page
Verified against the current code: the credit block's show name linked
**only** to the external Apple Podcasts page, never to `#/show/:show_id` —
the requirements doc flagged this as unverified ("predates Stage 4; not
verified in this pass") and it turned out to still be missing. Fixed by
routing the show-name text through the existing `showNameLink()` helper
(same one `epRow`/`archivedRow`/`renderEpisode` already use), while keeping
the Apple Podcasts "↗" open-external link as its own separate control.

## Naming
App is always **4a**; a stitched-audio unit is always a **foray**.

## Testing
- 5 new cases added to `test/show-page.test.js`: footer presence with a
  published Foray, hidden for an unpublished/non-unlocked Foray, shown once
  unlocked by id, absent when no Foray uses the show, and never interleaved
  with the episode list above it.
- `player/foray-sources.test.js` (22 existing cases) still green against the
  `showNameLink`-routed markup.
- Full suite run: three pre-existing SIGKILL timeouts under this sandbox's
  resource limits (`data-topic-integrity`, `data-deletion`,
  `drawer-settings-toggle`) reproduce identically against `origin/main` with
  no changes applied, and each passes cleanly in isolation — unrelated to
  this change.
