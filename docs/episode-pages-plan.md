# Plan: in-app episode pages — stop "Open episode" from leaving 4a

*2026-08-31. Requested by Joey during live iPhone testing: the mini-player's
"Open episode ↗" link always opens Apple Podcasts in a new tab, regardless of
whether the episode is playable in-app. Planning only — no implementation in
this change. See kanban card for full ask.*

## 0. Relationship to `docs/show-pages-plan.md` (PR #358, merged)

**Verdict: episode pages are a sibling route (`#/episode/:id`) built the same
way Stage 1 of the show-pages plan builds `#/show/:id` — not folded into that
PR, but sharing its pattern and, once it ships, its navigation surface.**

Reasons to keep them siblings rather than one PR:
- They answer different questions ("what is this one episode" vs "what has
  this show published") and gate on different data. An episode page needs
  only fields already on every `discover.json`/`cp_saved` item; a show page
  needs `catalog.json`, a new fetch, and (per that plan's Stage 3) an
  unresolved founder call on RSS ingestion. Coupling them would block the
  episode-page fix — the one Joey flagged as "app suicide" — on an unrelated
  open question.
- `#/episode/:id` is useful standalone today: every row that names an episode
  (`epRow`, `archivedRow`, the continue banner, the mini-player) already has
  full episode data in `state.itemIndex`/`cp_saved` and needs no new fetch.
  `#/show/:id` needs `catalog.json` wired in first (show-pages Stage 1).
- Once both exist, an episode page's show-name text links to `#/show/:id`
  exactly like show-pages Stage 4 wires other rows — one small follow-up, not
  a redesign of either page.

Sequencing recommendation: this plan's Stage 1 (episode page + mini-player
fix) can ship independently and immediately — it doesn't depend on show-pages
landing first. The only merge point is Stage 3 below (linking show names from
the episode page), which wants `#/show/:id` to exist, so it is sequenced
after show-pages Stage 1 lands, not before.

## 1. The `#/episode/:id` route

New route, same pattern as `#/foray/:id` and `#/playlist/:id` in `app.js`'s
`route()`:

```
else if ((m = /^#\/episode\/(.+)$/.exec(h))) renderEpisode(m[1]);
```

`renderEpisode(id)` needs an item record. Today episode data lives in three
places depending on context — `state.itemIndex` (hydrated from
`discover.json`/session pool), `cp_saved` (starred/playlist snapshots), and
`cp_history`. Resolution order: `state.itemIndex[id]` first (freshest), then
a `cp_saved` snapshot lookup as fallback (covers aged-out parts, same pattern
`archivedRow` already uses) — no new fetch, no new data file.

**What it shows**, all data already on the item record:
- Artwork (`artwork_url`), title, show name (text, not yet a link — see
  Stage 3), duration (`fmtDur(item.duration_min)`).
- Description/hook (`item.hook`) — same field the player sheet's `sWhy`
  already shows.
- In-app ▶ (`playBtn(item)`, reused unchanged) when `audio_url` exists.
- Star toggle (`starBtn(item.id)`, reused unchanged from `epRow`).
- **Not found state**: unknown id renders a "Episode not found" message, not
  a crash — mirrors `renderPlaylistDetail`'s existing guard.

No new CSS component needed beyond a page wrapper — the header/body reuse the
existing artwork/title/show typographic classes already in `styles.css` for
the player sheet and playlist detail.

**Acceptance criteria:**
- Visiting `#/episode/<valid id>` (via `state.itemIndex` or a `cp_saved`
  snapshot) renders artwork, title, show, duration, hook/description, the ▶
  button when `audio_url` exists, and a working star toggle.
- Visiting `#/episode/<unknown id>` renders a "not found" state, not a crash.
- `node --test "test/*.test.js"` and `node --check app.js` pass; a new test
  covers the route match, the two data-source lookups, and the not-found
  case, per CLAUDE.md workflow rule 3.

## 2. Episodes 4a cannot play in-app (no `audio_url`)

**Recommendation: the episode page still renders fully — title, show,
artwork, duration, hook — and shows one explicit, honestly-labelled
"Listen in your podcast app ↗" link in place of the ▶ button. It stays an
external link, but it is now a clearly-scoped last resort on a page the
listener already trusts to be "inside 4a," not a bare, unlabelled "Open
episode" that reads as if it were in-app navigation.**

Why this and not something else:
- Product principle #3 ("legally boring") means 4a categorically cannot play
  audio it has no `audio_url` for — this is a fact about the episode, not a
  UI choice, and pretending otherwise would be dishonest to the listener.
- The founder complaint was never "don't link to Apple Podcasts, ever" — it
  was that a navigation action (open something about this episode) and a
  playback action (this specific audio isn't ours to serve) were
  indistinguishable. Splitting them fixes that: tapping into an episode
  always stays in 4a; only tapping "play" on the ~unresolvable few leaves,
  and it says so before it does.
- This matches the existing `playBtn()`/`external` fallback pattern
  `epRow`/`archivedRow` already use for rows (PR #357) — the episode page is
  the same rule applied to the one place that currently breaks it (the
  mini-player's unconditional link).

Rejected alternative: hiding the play affordance entirely for unplayable
episodes. Rejected because it silently under-delivers — a listener who
specifically wants that episode has no path to it at all, which is worse
than an honest, clearly-labelled external link.

## 3. Every call site that changes

| Site | File | Current behavior | New behavior |
|---|---|---|---|
| Mini-player "Open episode ↗" | `player/client.js` — `openLink`, `fp-openep` (built ~L363, wired ~L722) | Always `target="_blank"` to `item.apple_episode_url` whenever that field exists, regardless of in-app playability | Relabel "Episode ↗" and repoint to `#/episode/${id}` (in-app hash route, not `target="_blank"`) — mirrors how `forayLink`/"Back to the running order" already does an in-app hash route from this same sheet. `hidden` toggles on episode id existing (should basically always be visible now, since it no longer depends on `apple_episode_url`). |
| `epRow()` external "Play" link-out | `app.js` ~L1149 | `target="_blank"` to `playLink(item)` when no `audio_url` | Row's episode title becomes a link to `#/episode/${item.id}`; the external `Play` control's *label* changes to "Listen in your podcast app ↗" so it reads as a last resort rather than a peer of the ▶ button (behavior otherwise unchanged — this is a copy/semantics fix, not a new control) |
| `archivedRow()` "Open" link-out | `app.js` ~L1191 | `target="_blank"` to `playLink(item)`, only shown when `apple_collection_id` exists | Same as above: link the title to `#/episode/${item.id}` (works even for aged-out parts via the `cp_saved` snapshot lookup in §1), relabel the external control "Listen in your podcast app ↗" |
| Continue banner | `app.js` `bannerHtml()` ~L996 | Whole banner is one `target="_blank"` link to `playLink(c)` | Whole banner becomes an in-app link to `#/episode/${c.id}`; the ▶ semantics (does it play or open Apple) move into the episode page per §2, so the banner itself never has to choose |
| `mini-card` (topic subject queues) | `app.js` `miniCard()` ~L1023 | Links to `#/subject/:branch` already (in-app) — not part of this fix | No change — flagged for completeness per the card's ask, not in scope |
| Show-page rows (once show-pages Stage 1 lands) | `app.js` `renderShow()` (not yet built) | N/A | Reuse `epRow`/`archivedRow` unchanged — they'll already point at `#/episode/:id` by the time that page exists, so no extra work there |

Not changed by this plan: `app.js` L1626 (`fy-src-head`, a foray's *source
material* link, not an episode) and the RSS-feed link in `playLink()`'s
Pocket Casts branch — both are genuinely external destinations with no in-app
equivalent, out of scope for "episode pages."

## 4. Staged rollout

### Stage 1 — episode page + mini-player fix (the flagged bug)
- Add `#/episode/:id` route and `renderEpisode()` (§1).
- Fix the mini-player's `openLink` to route in-app instead of `target="_blank"`
  (§3, row 1) — this alone resolves Joey's specific complaint.
- No changes yet to `epRow`/`archivedRow`/banner link targets.
- Ships independently; does not need show-pages.

**Acceptance criteria:** tapping "Episode ↗" in the mini-player never leaves
4a; it always lands on `#/episode/:id` for the currently loaded item.

### Stage 2 — honest "listen elsewhere" fallback for unplayable episodes
- Episode page renders the labelled external link per §2 when `audio_url` is
  absent.
- Relabel the `epRow`/`archivedRow`/banner external controls (§3 rows 2–4)
  to "Listen in your podcast app ↗" for consistency, without yet changing
  what they link to.

**Acceptance criteria:** an episode with no `audio_url` still renders a full
episode page; its only external control is clearly labelled as leaving 4a.

### Stage 3 — wire remaining rows to the episode page
- `epRow`/`archivedRow`/banner titles become in-app links to `#/episode/:id`
  (§3 rows 2–4), on top of the existing ▶/external controls which keep their
  current behavior unchanged (regression risk called out explicitly — same
  caution show-pages Stage 4 names for PR #357's rows).
- Once show-pages Stage 1 (`#/show/:id`) lands, episode page's show-name text
  becomes a link to it — small follow-up, not blocking this stage.

**Acceptance criteria:** every row that names an episode links to that
episode's page; no change to existing ▶/external control behavior (verify by
re-running the PR #357 row regression tests).

## 5. Files touched (all stages)

- `player/client.js` — `openLink` build/wiring (Stage 1).
- `app.js` — `route()`, new `renderEpisode()` (Stage 1); `epRow`, `archivedRow`,
  `bannerHtml()` markup and labels (Stages 2–3).
- `styles.css` — episode-page layout (reuses existing typographic classes
  where possible).
- `test/*.test.js` — new route/render/not-found coverage (Stage 1), row-link
  regression coverage (Stage 3).
- `docs/DECISIONS.md` — entry recording the "episode page always renders
  even without playback; external link is last-resort only" call once
  approved (§2), since it is the one genuinely reversible-but-costly product
  decision in this plan.

## 6. What this plan does NOT include

- No implementation. Once approved, Stage 1 becomes its own child card
  (created separately, per the parent card's instruction).
- No change to `mini-card`'s existing in-app `#/subject/:branch` links, or to
  `fy-src-head`'s foray-source link — both already correct or genuinely
  external with no in-app equivalent.
- No dependency on show-pages Stage 3 (RSS ingestion) — episode pages need no
  new data source at any stage.
