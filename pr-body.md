## Summary
Stage 3 of docs/episode-pages-plan.md (§3 table, §4 Stage 3) — the last stage of the episode-pages plan. Stage 2 (#369) is merged.

- `epRow()`'s title is now a link to `#/episode/${item.id}`. Existing ▶/star/up-next/external controls are unchanged.
- `archivedRow()`'s title is now a link to `#/episode/${item.id}` too (works for aged-out parts via the same `cp_saved` fallback `renderEpisode()` already uses).
- `bannerHtml()` (the continue/resume banner) is now an in-app link to `#/episode/${c.id}` instead of `target="_blank"` to `playLink(c)` — the play-vs-external decision now lives on the episode page itself (Stage 2), so the banner no longer has to choose.
- Added `.ep-title-link` CSS (inherits color, no underline except on `:active`) to match the existing `.show-link` pattern.

## Regression risk
PR #357 established one play control per row. This PR adds a title link ONLY — no changes to play button / star / external-link logic. New test explicitly re-checks the PR #357 invariant.

## Tests
- New `test/episode-row-links.test.js` (5 tests): title links on epRow/archivedRow, banner in-app link, and regression checks that play/star/up-next/external controls are byte-for-byte unchanged.
- Floored the new suite in `test/suite-integrity.test.js`.
- `node --check app.js` — pass
- `node --test test/` — 434/434 pass
- `node --test player/*.test.js` (run from `player/`) — 1003/1003 pass

## Naming
App is "4a"; a stitched-audio unit is a "foray" — no naming changes in this PR.
