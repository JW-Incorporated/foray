# Legacy UI archive (pre U-11 cutover)

Snapshot of `app.js`, `styles.css`, and `index.html` as they stood immediately
before the U-11 cutover (docs/ui-transition-plan.md), taken 2026-09-06 —
**founder override** (Joey, via Discord, kanban card `t_a3f01c8a`): retire the
old (flag-off / `cp_ui_v2`-off) UI screens now rather than waiting out the
planned week of TestFlight soak time. This override supersedes the "wait a
full week" plan recorded in `docs/ui-transition-plan.md` U-11; do not treat
that wait as still required.

## What changed

`ui2On()` in `app.js` now always returns `true` — the `cp_ui_v2` localStorage
flag, its Settings toggle, the native-shell-default fallback, and every
flag-off code path (the old four-card Home render, the old menu-only nav
without the four-tab bar, the interim Playlists→Library link, the old
`#/shows` page without the browse-pills row, the old Search page without the
Playlists section) are retired. New users and existing users alike now only
ever see the new (`ui-v2`) design. There is no way to opt back into the old
UI from within the running app.

## What's here

- `app.js.pre-cutover-2026-09-06` — the full application source exactly as it
  was before this cutover's edits, including every flag-off branch, the old
  `renderHome()` four-card implementation, the Settings toggle wiring
  (`bindUi2Control`), and the tab-bar off-branch.
- `styles.css.pre-cutover-2026-09-06` — matching stylesheet.
- `index.html.pre-cutover-2026-09-06` — matching markup (topbar, drawer).

These are inert reference copies. Nothing in the live app imports, requires,
or executes anything under `archive/`.

## How to restore the old UI in a worst-case scenario

1. Diff the archived `app.js.pre-cutover-2026-09-06` against the current
   `app.js` to see exactly what changed (the `ui2On()` body, `renderHome()`,
   `bindUi2Control()`, the tab-bar's off-branch, and a handful of
   `if (!ui2On())` guards that became unconditional).
2. To bring back a REAL, user-facing flag (not just revert to old-only): copy
   the archived `ui2On()` implementation back in, restore the deleted
   `renderHome()` v1 branch and `bindUi2Control()` body, and re-add the
   `cp_ui_v2` Settings toggle. All of that code is intact in the archived
   file — it was moved here, not rewritten or deleted from history.
3. To go back to the OLD UI only (no flag, just revert the cutover): replace
   the current `app.js`/`styles.css`/`index.html` with the archived copies
   wholesale, then re-apply any unrelated commits that landed after
   2026-09-06 by hand (the archive is a point-in-time snapshot, not a
   maintained branch).
4. Either path needs a new PR and review like any other change — this
   archive is a recovery aid, not a live rollback switch.

## Provenance

- Founder directive: Joey, Discord, 2026-09-06, following up on the
  visual-overhaul cutover card, explicitly overriding the "wait a full
  TestFlight week" plan in `docs/ui-transition-plan.md` U-11.
- Kanban card: `t_a3f01c8a` ("Cutover NOW (founder override): retire old UI
  screens to an archive, skip the TestFlight week").
- See `STATE.md` for the workstream entry recording this cutover.
