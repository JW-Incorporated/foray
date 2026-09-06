# Plan: transition the 4a UI to Joey's design

*Drafted 2026-09-06 from Wyatt's brief and his answers to eleven scoping
questions. Hermes card deck. Nothing here is built yet.*

**Status:** proposed. Slots into the existing UI epic **#102** (cards C1–C12,
cut from this same mockup in August). Where a C-card already exists this deck
names it; three of those cards were founder **gates**, and Wyatt's answers
resolve them (§1). Hermes should close or repoint the C-cards rather than run
two decks.

**The source of truth for the look is `docs/ux/foray-mockup.jsx`** (Joey,
adopted 2026-08-13, PR #158), rendered live at the artifact Wyatt reviewed. The
older `docs/ux/foray-m3-prototype.html` contributes exactly one screen: the
Interests page. Both predate the rename to **4a**; every brand string follows
§1 D11.

---

## 0. The brief, verbatim

> The Home page looks good, let's leave out the Shared with you section for
> now. From top to bottom: "Jump back in", "Forays for you", "Playlists for
> you", and "Episodes for you." The search and create pages are great, though
> we need to add playlists in there. In the old .html version there was a page
> for interests, with a sliding scale which you can adjust… let's figure out
> how to add that in. I also really like the look and feel of the latest UI
> mockup.

## 1. Decisions (Wyatt, 2026-09-06)

| # | Decision | Resolves |
|---|---|---|
| D1 | **The "for you" sections include stretch recommendations.** Product principle #1's ~30% exploration floor stays: "Forays for you" and "Episodes for you" each reserve at least one *visibly labelled* stretch pick. | gate **#123** (C3) — keep the floor |
| D2 | **No login wall.** Anonymous-first per ADR-0005 stands. Welcome + Preferences run as a skippable first-run flow; account linking is not in scope. | gate **#125** (C6) — anonymous |
| D3 | **Adopt the mockup's four-tab bar**: Home · Search · Create · Library. This reverses #467's menu-page Home, deliberately. | new |
| D4 | **Fonts: self-host** Fraunces + DM Sans as woff2 with `font-src 'self'`. No Google Fonts origin. | **#127** (C1) option 1 |
| D5 | **"Playlists for you"** = the listener's own recent playlists first, then two or three generated from their interests via the existing subject queues, labelled as generated. No new backend. | new |
| D6 | **Interests page: sliders on, history off.** Per-topic weight sliders the listener can drag to overrule; no "recent signals" feed, no evidence log. **Fix the leaf-only bug first.** | new |
| D7 | Search gains a **Playlists** results section beside Shows and Episodes. Create gets a **Foray | Playlist** toggle where Playlist is today's builder restyled. | **#135** (C7) + new |
| D8 | **Foray generation stays out** of the UI for now. The Create screen ships Playlist creation only; the Foray half of the toggle is not built. | new |
| D9 | **Incremental**, behind a `cp_ui_v2` flag, tokens first, one screen per card, so TestFlight can compare old and new. | new |
| D10 | Out of scope: share sheet and everything social (**#126** deferred); the full/mini player gets a token restyle only, its logic is owned by the iOS-audio work; **Library is Joey's #374**. | confirmed |
| D11 | Wordmark and product name → **4a**. Tagline **"Podcasts, stitched around you."** kept. | new |

## 2. What exists today, and the architectural constraint

The client is `app.js` + `styles.css`, vanilla JS, hash routes, **no
framework, no build step, dependency-free root**, strict CSP (`style-src
'self'` — **no inline styles**; no `font-src`, so web fonts are blocked today).
Every escape goes through `esc()`, every URL through `safeUrl()`. The mockup is
React with inline styles and a Google-Fonts `@import`. **The design is ported,
not the code**: React is not added (Joey's own instruction with the mockup),
inline styles become token-driven classes, fonts become self-hosted files.

Today's Home is exactly four cards and a menu page (#467, three days old).
Today's interests: `loadInterests()` seeds **leaf nodes only** from
`data/taxonomy.json`, stores weights in `cp_interests`, and `nudgeTopics()`
moves them on plays and thumbs; there is no page to see or set them. A
declared interest in a root node (e.g. `true-crime`) is silently discarded on
the next save — that is the bug D6 names.

The mockup's data contract (from `docs/ux/README.md`): a Foray is a flat
timeline of segments alternating narrator/source, each with `dur` — the
`SegmentStrip` (C2, #128) is the one component that makes a Foray legible as a
different object from an episode, and Home's Foray cards need it.

## 3. The card deck

Conventions: the ask; owned vs shared files; dependencies; **measured**
acceptance; sizing (S ≤ ½ day, M ≤ 2 days, L ≤ 5); governance; design comment
first where marked. Every card ships behind `cp_ui_v2` until U-11. Every card
runs `node tools/ci/run-suites.mjs` and keeps `test/app-security.test.js`'s
invariants (esc/safeUrl, no inline styles) green. Reviewer pass **before push**
on auto-merge paths (`app.js`, `styles.css`, `search-engine.js`, `test/`,
`data/` all auto-merge). `index.html` is unlisted → human merge; batch every
`index.html` touch into U-01.

Read first: `CLAUDE.md`; this file; `docs/ux/README.md`; issues #102, #123,
#125, #126, #127, #128, #132, #135; `docs/adr/0005-identity-and-accounts.md`;
`test/home-layout.test.js` and `test/home-information-architecture.test.js`
(they pin today's Home and will need rewriting, not deleting).

#### U-01 · Design tokens, fonts, brand — the foundation (C1 / #127) — **M** — *design comment first*
- **Ask:** map the mockup's `T` object onto `styles.css` custom properties under a `body.ui-v2` scope: `--bg #151119`, `--surface #1F1A26`, `--surface2 #2A2333`, `--line #332B3E`, `--text #F4F0E8`, `--muted #9C93A8`, `--faint #6E6579`, **`--amber #F2A33C` = the listener's own material, `--violet #A78BFA` = what 4a authored** (#127 explains why that split must survive intact). Type: Fraunces (display, italic wordmark) + DM Sans (body), **self-hosted woff2 under `fonts/`**, `@font-face` in `styles.css`, and `font-src 'self'` added to the CSP in `index.html` — nothing wider. Dark is the design; keep the two existing `prefers-color-scheme: light` blocks working as token overrides so nothing regresses for light-mode users. Wordmark and every "Foray"-as-product-name string in chrome → **4a**; tagline kept. `test/legal-citations.test.js`'s CSP pin gains the directive.
- **Owned:** `styles.css` (tokens + fonts), `fonts/*.woff2`, `index.html` (CSP), `test/ui-tokens.test.js` (new, floored: every token defined on the scope; no hex literal from the palette appears outside the token block — MUTATION: hardcode one → red), `test/legal-citations.test.js`.
- **Acceptance:** with `cp_ui_v2` on, the app renders in the two faces with no fallback (measured in headless Chrome via `document.fonts.check`); mobile bundle stays under `tools/mobile/prepare-webdir.mjs`'s 3 MB budget with the fonts included (report the delta; subset to Latin if needed); CSP has no new origin.
- **Governance:** `index.html` → human merge (the CSP line); everything else auto-merges.

#### U-02 · The `cp_ui_v2` flag and the tab bar shell — **M**
- **Ask:** a localStorage flag `cp_ui_v2` (default off; a Settings toggle; TestFlight builds default **on**). Under it: the four-tab bar (Home / Search / Create / Library, lucide-equivalent icons drawn as inline SVG classes, not a library), tab state in the hash router, the mini-player docked above the bar exactly as the mockup stacks them. The menu page and drawer stay reachable from a Settings entry rather than as primary nav. **Must compose with #488's real back-stack**: switching tabs is not a "back" step; deep links land on the right tab.
- **Owned:** `app.js` (router, `renderTabBar`), `styles.css`, `test/tab-bar.test.js`, `test/back-navigation.test.js` (extend).
- **Acceptance:** all 13 existing routes still resolve with the flag on and off; ‹ behaviour from #488 unchanged; the bar and mini-player never overlap content (the N1 feedback bug, measured at inset 59 px like `test/home-layout.test.js` does).

#### U-03 · Home: four sections, with the floor (C3 / #123 resolved by D1) — **L** — *design comment first; DECISIONS entry*
- **Ask:** replace the four cards (flag on) with, top to bottom: greeting; **Jump back in** (`forayResumeRows()` + episode resume, horizontal scroller); **Forays for you** (`data/forays.json` published Forays as cards carrying a `SegmentStrip` — see U-04); **Playlists for you** (D5: own recent from `cp_playlists`, then 2–3 generated from `state.interests` against the subject queues, badged *Generated for you*); **Episodes for you** (`buildCards()`'s ranked discover-pool picks). **The floor:** "Forays for you" and "Episodes for you" each reserve ≥1 slot for a stretch pick, rendered with a visible *Stretch* label and its bridge line (copy rule: stretch picks must state their bridge). Row reasons ("Because you finish every Odd Lots") are allowed but never on the stretch slot. "Shared with you" and "Build your own" are not built.
- **Owned:** `app.js` (`renderHome` v2), `styles.css`, `test/home-v2.test.js` (floored; pins section order, the stretch slot's presence and label, the generated-playlist badge — MUTATION each), rewrite `test/home-layout.test.js`/`home-information-architecture.test.js` for the flag-on shape rather than deleting them.
- **Dependencies:** U-01, U-02, U-04 (strip).
- **Acceptance:** at inset 0 and 59 px, all four sections render with real data; the stretch slot is present in both "for you" sections on 20 consecutive seeded renders; DECISIONS records #123 as resolved "floor kept, sections adopted".

#### U-04 · `SegmentStrip` (C2 / #128) — **M**
- **Ask:** the proportional coloured-bar component: one bar per segment, width by duration, colour by source show from the existing `--seg-c0..7` palette, **violet for narration** (already `--seg-narration`). Pure function `segmentStripHtml(items)` over a Foray's items; used by Home's Foray cards (U-03) and the show/episode restyle (U-08). Degrades to nothing for a Foray with no segments.
- **Owned:** `player/segment-strip.js` + `.test.js` (floored), `styles.css`.
- **Acceptance:** widths sum to 100% ± rounding for the four committed Forays; colours are stable per show across renders; reduced-motion respected.

#### U-05 · Search restyle + Playlists section (C7 / #135, D7) — **M**
- **Ask:** restyle the Shows page to tokens (field, browse pills, show grid). Results gain a **Playlists** section under Shows and Episodes: the listener's own playlists matching the query (#470's `playlistMatchesQuery` already exists) plus generated candidates from D5's generator, badged. **Ranking is presentation-only**: `node tools/test-search.mjs` must pass unchanged and no `search-engine.js` scoring changes. The "Create a playlist about X" CTA appears when a query has no strong result (the #135 CTA, retargeted from Foray to Playlist per D8).
- **Owned:** `app.js` (`renderShowSearchResults` v2), `styles.css`, `test/show-search.test.js` (extend), `test/search-playlists.test.js` (new, floored).
- **Acceptance:** search battery unchanged; a query matching an own playlist shows it; offline behaviour from D9-earlier (shows search) unchanged.

#### U-06 · Create = Playlist creation (D7, D8) — **M**
- **Ask:** the mockup's Create screen, restyled, with the **Foray | Playlist** toggle rendered but the Foray option **disabled with honest copy** ("Custom Forays aren't available yet"), so the affordance is visible without promising the feature. Playlist mode is today's `buildPlaylist()` flow in the new chrome: subject field, the mockup's building/ready states reused for the local build, result opens the playlist. The mockup's ~20/~40/~75 lengths are Foray-specific and **not** shown for playlists.
- **Owned:** `app.js` (`renderCreate`), `styles.css`, `test/create-page.test.js` (floored; MUTATION: enable the Foray option → red).
- **Acceptance:** building a playlist from Create produces the same `cp_playlists` entry as building from the old Playlists page; the disabled Foray option is not focusable as a control.

#### U-07 · Interests page with sliders, and the root-node bug (D6) — **M** — *design comment first*
- **Ask:** **Bug first, its own commit:** `loadInterests()`/`saveInterests()` seed and persist **every** taxonomy node (roots and leaves), so a root-level interest survives a save; `nudgeTopics()` propagates to the parent at a damped rate (state the ratio; default 0.5). Then the page at `#/interests`, reachable from Settings and from Preferences (U-09): one row per node the listener has a non-default weight on plus the roots, grouped by root; each row = name, path, current weight, a **slider** the listener drags to overrule (range **0–1**, matching today's clamped model — not the old prototype's −1..1, because `nudgeTopics` clamps at zero and a negative floor would be a different design), a *Reset to learned* control. **No history feed, no evidence log** (D6). Keyboard-operable (`role="slider"`, arrow keys), `touch-action: pan-y` so it does not fight scrolling — the old prototype fixed exactly that bug twice.
- **Owned:** `app.js` (`renderInterests`, `loadInterests`, `saveInterests`, `nudgeTopics`), `styles.css`, `test/interests-page.test.js` (floored), `test/interests-roots.test.js` (the bug: seed a root weight, save, reload → still there; MUTATION: restore `leafNodes()` → red).
- **Acceptance:** dragging a slider changes what `buildCards()` ranks on the next Home render (assert by seeding two nodes and flipping which is higher); a root interest set in Preferences is present after `saveInterests()`; all sliders operable by keyboard.

#### U-08 · Show, Episode and player chrome restyled to tokens (C12 partial) — **M**
- **Ask:** presentation-only pass over `renderShow`, `renderEpisode`, `renderForays`, `renderQueue`, `renderPlaylists`/`renderPlaylistDetail` and the mini/full player **CSS**: tokens, type, spacing, the `SegmentStrip` on Foray pages. **No logic changes in `player/`**; its markup is owned by the iOS-audio work, so this card touches `styles.css` classes for the player and nothing in `player/*.js`. If a needed hook is missing, file it against that owner rather than reaching in.
- **Owned:** `styles.css`, `app.js` (class names only where a token class must replace an old one), `test/show-page*.test.js` (assert nothing behavioural changed).
- **Acceptance:** every existing page test passes with the flag on; a diff of `player/*.js` is empty.

#### U-09 · Welcome + Preferences as a skippable first run (C4 / #132, D2) — **M**
- **Ask:** the mockup's Welcome (two value props, the second illustrated with a live `SegmentStrip`) and Preferences (interest chips + "type a subject yourself") as a first-run sheet, **skippable at every step**, gated on the existing `cp_intro_dismissed`. Preferences writes to `state.interests` through the fixed U-07 path (roots included). **Not built:** "Continue with Apple/Google", "Import subscriptions/listening history" (connectors; C5). The N3 feedback item — "re-open the interests prompt later" — is satisfied by the Settings entry to `#/interests`.
- **Owned:** `app.js`, `styles.css`, `test/first-time-onboarding.test.js` (extend).
- **Dependencies:** U-01, U-04, U-07.
- **Acceptance:** a fresh profile sees Welcome once; skipping at step 1 or 2 lands on Home with default weights; picking three chips changes the first Home render's ranking.

#### U-10 · Library tab = Joey's #374 — **S** (plus the rebase)
- **Ask:** rebase and land **#374** (Joey's Library screen: saved, history, playlists, Up Next), then point U-02's Library tab at `#/library`. The rebase conflicts in `app.js` and `index.html` are nav-integration decisions; resolve them **toward the tab bar** and say so in the PR. Restyle to tokens only if the rebase is trivial; otherwise a follow-up.
- **Governance:** `index.html` → human merge; the PR is Joey's — note the rebase in its body and let him see it.
- **Acceptance:** Library tab opens his screen; his own tests pass.

#### U-11 · Cutover and records — **S**
- **Ask:** after every card above is green on TestFlight for a week: default `cp_ui_v2` on for everyone, delete the four-card Home and the menu-as-primary-nav code paths, delete the flag. DECISIONS entries: #123 resolved (floor kept), #125 resolved (anonymous-first stands), #126 deferred, D3 (tab bar reverses #467), D4 (self-hosted fonts). Close or repoint C1, C2, C3, C4, C7 issues; leave C6/C10/C11 open with a pointer here. `docs/ux/README.md` gains a "what shipped vs the mockup" table.
- **Governance:** `docs/DECISIONS.md` → `founder-approved`.

## 4. Gates

| # | Who | What | Blocks |
|---|---|---|---|
| G1 | Joey | Read this deck; the Home floor mix (D1) and the tab bar (D3) are product calls Wyatt made — Joey should see them before U-03 ships | U-03 |
| G2 | Wyatt | Merge click for U-01's `index.html` CSP line and U-10's `index.html` | U-01, U-10 |
| G3 | Joey | #374 rebase lands under his name | U-10 |
| G4 | Wyatt | DECISIONS label at U-11 | U-11 |

## 5. Sequencing

```
U-01 tokens/fonts/brand ──┬── U-02 flag + tab bar ──┬── U-03 Home ← U-04 strip
                          │                         ├── U-05 Search
                          │                         ├── U-06 Create
                          │                         ├── U-07 Interests (bug commit first, can start day 0)
                          │                         └── U-08 restyle
                          └── U-04 SegmentStrip (day 0, independent)
U-09 Welcome/Prefs ← U-04, U-07          U-10 Library ← U-02 (+ Joey's rebase)
U-11 cutover last
```

Day 0 in parallel: U-01, U-04, and U-07's bug-fix commit. Everything else
fans out from U-02.

## 6. Non-goals

- Adding React or any framework, a build step, or a runtime dependency to the root.
- Foray generation in the UI (D8). The pipeline exists; its key and segment pool do not.
- Social, sharing, friends, "Wyatt sent you a Foray" (#126).
- Accounts, login, connectors (#125, C5).
- Changing search ranking, playback logic, or anything under `player/*.js`.
- An interests **history** or evidence feed (D6).
