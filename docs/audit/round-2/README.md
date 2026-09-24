# The 2026-09-23 audit, round 2

Round 2 of the design and QA audit whose round 1 lives one directory up
([`../README.md`](../README.md)). It exists because the founder asked for it:

> "After all fixes are in, repeat this exercise again" (2026-09-23)

It ran on origin/main at 9730b5b — after round 1's lanes (PR #742), the release
lane (#739), the Foray-data lane (#741), qa 152 (#743), visual pass 1 (#744) and
the six 2026-09-23 founder reports (#746) had merged. Like round 1 it was told to
**flag, not fix**, and like round 1 every finding went to an adversarial verifier
that read the code at that commit.

Committed in the same change that produced it, per `../README.md` § "WHY THIS
DIRECTORY EXISTS AT ALL": round 1's findings were nearly lost by living only in
a temporary directory.

## THE LENSES

Eighteen: the ten round-1 QA areas again (touch, player, visual, a11y, races,
states, nav, copy, persist, honesty); three areas round 1 did not staff —
**search**, **perf**, and **native** (the iOS/Android shells, read not run); and
five personas (`p-car`, `p-impatient`, `p-switcher` — the Apple Podcasts
switcher, `p-first` — first launch, and `p-foray` — a Foray listener).
Verified findings per lens: player 10, native 8, p-impatient 9, copy 13, nav 8, visual 17, races 6, search 12, states 11, p-foray 10, honesty 11, p-car 4, perf 10, p-first 11, touch 10, a11y 10, persist 9, p-switcher 3.

## THE NUMBERS

| stage | count |
|---|---:|
| raw findings | 209 |
| duplicates merged into another finding | 30 |
| dropped (restated a refuted round-1 row or a recorded ruling) | 7 |
| unique, sent to the verifier | 172 |
| **confirmed** | **163** |
| refuted | 2 |
| deliberate (covered by a ruling or a documented choice) | 5 |
| uncertain (needs a device to settle) | 2 |

Confirmed by the verifier's severity: **5 high**, 70 medium, 88 low.
The verifier lowered the finder's severity often; `findings.tsv` carries the
verifier's, `findings-detail.md` carries both.

The not-confirmed rows are kept, as in round 1, so they are not re-raised:
`native-1` (uncertain), `states-1` (deliberate), `native-5` (deliberate), `states-12` (refuted), `native-6` (uncertain), `perf-9` (deliberate), `search-10` (deliberate), `p-foray-3` (deliberate), `p-foray-13` (refuted).

The high ones: `player-1`, `touch-1`, `persist-1`, `native-2`, `search-2`.

## THE HEADLINE

Round 1's fixes were mostly correct and mostly **local**. Nearly half of the
confirmed rows (76 of 163) name a round-1 fix as incomplete, or a second-order
interaction with one, in their `relation_to_round1` field: the rule was
promoted at the site named in the finding and nowhere else, or two independent round-1 fixes now meet somewhere neither
considered. That is round 1's "subtly off" shape, one level up. `synthesis.md`
§1 names fourteen causes (R2-A … R2-N); the lanes promote one rule per cause.

| theme | ids |
|---|---|
| R2-A. The machine settles and nothing repaints (incomplete round-1 fix of persona 47/57/73, qa 39/40; theme C/G shape) | player-1, p-impatient-4, player-7, player-10, p-car-8, p-impatient-6, races-3 |
| R2-B. A two-step operation whose second step does not know which item asked (round-1 theme B carried into the player) | races-1, p-impatient-1, p-impatient-2, player-3, races-2, races-3, races-7, persist-8 |
| R2-C. The modal owner exists but only Now Playing got the full contract (round-1 theme E, incomplete) | nav-5, touch-4, touch-2, touch-8, a11y-5, a11y-6, a11y-2, p-first-4, p-first-5, nav-2, nav-8 |
| R2-D. Touch was designed with a mouse (round-1 theme F, incomplete) | touch-1, touch-2, touch-3, touch-5, touch-6, touch-9, touch-10, touch-11, search-3, a11y-3 |
| R2-E. The Foray is a second-class episode (second order of persona 7 / persona 58) | player-7, player-8, player-10, copy-5, honesty-2, honesty-12, p-foray-8, states-11, player-4, player-5, player-11, p-foray-4, p-foray-2, native-2, native-3, native-10 |
| R2-F. Nothing owns 'played' or 'how long' (round-1 theme L, continued; persona 78 / qa 162 incomplete) | honesty-1, honesty-4, honesty-3, honesty-5, honesty-6, honesty-7, p-first-10, copy-2, honesty-13, states-11, p-foray-8, honesty-2, player-8 |
| R2-G. Loading and failure still rendered as fact where the round-1 convention was not applied (theme G, incomplete; 'no request waits forever' incomplete) | states-2, states-3, states-4, states-6, states-7, states-8, states-9, states-10, races-7, nav-9, search-4, search-12, p-impatient-4 |
| R2-H. Search is four passes and the painted list forgets what it knows (second order of #684 append-only stability and S-03 lazy index) | search-1, search-5, search-6, search-7, search-9, search-2, search-8, p-switcher-7, honesty-11, races-2 |
| R2-I. The boot path is serial and background work fights the listener (new; perf) | perf-1, perf-3, perf-4, perf-5, perf-6, perf-7, perf-2, races-4, p-first-2, nav-9 |
| R2-J. Delete my data is not a transaction (round-1 theme J, continued) | persist-1, persist-8, persist-2, persist-4, persist-5, persist-6, persist-7, persist-3, persist-9 |
| R2-K. Tokens exist; the rules read three steps of them (round-1 theme I / qa 51, 53, 55, 60 incomplete) | visual-8, visual-5, visual-12, visual-13, visual-14, visual-15, visual-11, visual-10, visual-9, visual-6, visual-2, visual-3, visual-16, visual-17, visual-4, visual-7, honesty-8, p-first-8, search-11, a11y-9 |
| R2-L. Copy has two narrators and four dialects (round-1 theme H, continued; qa 141/151 incomplete) | copy-1, copy-2, copy-6, copy-7, copy-8, copy-9, copy-10, copy-11, copy-12, copy-13, copy-14, copy-15, copy-5, p-foray-12, p-foray-5, p-first-11, states-9, states-10 |
| R2-M. The lock screen, the car and the Android shade are a surface nobody designed (new; second order of the 2026-09-23 lock-screen and steering-wheel fixes) | p-impatient-3, p-car-5, p-car-6, p-car-3, p-car-8, native-2, native-3, native-7, native-8, native-10, a11y-1, nav-2, p-impatient-7 |
| R2-N. First run and Up Next make promises the model cannot keep (second order of persona 14/44 and the continuous-playback fix) | p-first-1, p-first-3, p-first-7, p-first-6, p-first-12, p-foray-6, search-2, p-impatient-6, p-impatient-7, p-impatient-8, p-impatient-10, p-impatient-11, perf-10, honesty-3, copy-9 |

## WHAT IS HERE

| File | What it is |
|---|---|
| `synthesis.md` | The report: 14 root-cause themes, the felt shortlist, 11 founder questions, the 8-lane plan, the uncertain pile, coverage gaps |
| `findings.tsv` | One row per verified finding, 172 rows — `id, lens, verdict, severity (verifier's), file:line, title, lane` |
| `findings-detail.md` | Full JSON per finding, including the verifier's reasoning and the merged duplicates |
| `dedup.md` | Which raw findings were merged into which, and the 7 dropped with the reason |
| `lanes.json` | The lane plan as data: `lane, scope, ids, brief` — every confirmed id in exactly one lane |

`file:line` is against 9730b5b. Where a finding named several files,
`findings.tsv` shows the first; `findings-detail.md` has the full list.

## THE LANES

| lane | confirmed ids |
|---|---:|
| L1-player-transport | 23 |
| L2-sheets-drawer-gestures | 13 |
| L3-queue-and-native-surfaces | 18 |
| L4-search-create-playlists | 21 |
| L5-boot-states-storage | 24 |
| L6-navigation-firstrun-copy | 26 |
| L7-styles-touch-visual | 28 |
| L8-foray-surfaces | 10 |

Every confirmed id is in exactly one lane; no refuted, deliberate or uncertain
id is in a lane. Scopes, merge order and briefs are in `lanes.json` and
`synthesis.md` §4.

## STATUS

**Worked through, 2026-09-23** (PR #749, branch `r2fix/integration`). Every
row of `findings.tsv` has one row in [`status.tsv`](status.tsv) — `id, title,
disposition, where, note` — including the refuted, deliberate and uncertain
ones, which keep the verifier's verdict. `where` names the lane and its merge
commit; `test/audit-status.test.js` holds the ledger to one row per finding,
the kept verdicts, and this table.

The eight lanes merged into `r2fix/integration` in order L1 → L8. A
completeness sweep then re-verified every row a lane handed to another lane,
reported not-done, or that no lane was given. Six hand-offs had landed in
nobody's files and were finished there: the Foray page's speed button
(`player-9`), the loading look on the control that was tapped
(`p-impatient-4`), the current Up Next row's look (`p-impatient-6`), the px
chrome under Dynamic Type (`a11y-1` part b), Home's card artwork at its drawn
size (`perf-2`), and the car's clock during a network stall on both natives
(`p-car-8` — the shim clamped the page's rate 0 back to 1). `native-1` was
re-verified: `player-1` made its path reachable and `p-car-6` closes it, now
pinned.

| disposition | rows |
|---|---:|
| fixed | 159 |
| already-fixed | 0 |
| refuted (verifier) | 2 |
| deliberate (verifier) | 5 |
| uncertain (verifier, still needs a device) | 1 |
| refuted-now (re-verified: no longer holds) | 1 |
| deferred-founder | 3 |
| deferred-device | 0 |
| open | 1 |
| **all rows** | **172** |

"Fixed" means fixed in code with a test that fails without the fix (each new
rule mutation-checked, each new suite floored in `test/suite-integrity.test.js`),
not verified on a phone. Rows whose last step only a device can take say so in
their note: `p-car-3` (a 20 s call), `p-impatient-3` (which lock-screen pair iOS
draws), `native-2/3/7/8/10`, `a11y-1` (Larger Text at xxxLarge), `p-car-6`,
`p-car-8` (a dead zone), `search-3`/`search-8`. The Swift and the Java compile
only in CI.

### Founder questions (synthesis.md §3)

Defaults applied, each recorded in `docs/DECISIONS.md` where it is a ruling:
Q1 skip pair on the lock screen, track commands only on a headset/car/AirPlay
route (`p-impatient-3`); Q2 auto-resume after an OS interruption, guarded by the
record's lag and never undoing a listener's pause (`p-car-3`); Q3 a finished
episode or Foray leaves Jump back in and says Played on its own rows and page
(`player-8`, `honesty-2`); Q4 one playlist builder, on Create (`p-first-6`); Q5
the Dynamic Type bridge, DECISIONS sentence corrected (`a11y-1`); Q8 "Show my
picks" (`p-first-7`); Q9 remove-on-skip, with drag / Play next / Clear as one
follow-up card (`p-impatient-7`, `p-impatient-8`); Q10 Up Next link and Save in
the sheet, sleep timer parked (`p-switcher-5`); Q11 the shell reopens the last
route, the web stays bare-URL-means-Home (`nav-10`).

**Held for the founder — the two questions no default could answer:**

- **Q6, backups of the native Preferences copy** (`persist-6`): credential
  handling. Not implemented. The verifier adds that the WebView's localStorage
  and IndexedDB are backed up too, so excluding the Preferences suite alone
  would not be enough.
- **Q7, privacy-policy wording** (`persist-3`, and the inventory half of
  `persist-4`): three origins, Vercel as a processor, miss-only dropped. Drafted
  in lane L5's notes; no `docs/legal` edit made. (`nav-10`'s one new `cp_` key
  row is in its own commit, 24bdb11d, so it can be reverted if legal edits wait
  for Q7 too.)

### Still open, and why

- **`persist-9`** (low): `cp_pos:<id>` rows are never pruned and the native tier
  reads them one bridge call each. Re-verified live. The suggested 30-day prune
  would un-play episodes — "Played", "N played" and the next-up marker read
  those rows and nothing else keeps that fact — and the safe fix (one
  `cp_positions` map, a copy-never-delete migration) renames a key the privacy
  policy lists, so it waits on Q7 and on a ruling for how long "Played" lasts.
- **`p-impatient-8`** (deferred-founder, by Q9's default): drag-to-reorder,
  Play next and Clear Up Next are one follow-up card.
- **`native-6`** (uncertain): whether WebKit's delayed category change rewrites
  the app process's audio session. Needs a device record.
