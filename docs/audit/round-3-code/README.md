# The 2026-09-25 audit, round 3: the code

Round 3 of the audit whose round 1 lives one directory up
([`../README.md`](../README.md)) and round 2 in [`../round-2/`](../round-2/README.md).
Rounds 1 and 2 read the listener-facing app. Round 3 reads the code: the whole
repository, not just the app. It exists because the founder asked for it:

> "deploy a fleet of agents looking for issues in the code base. Catalogue them, make a plan, then fix them all." (2026-09-25)

This directory is the **catalogue, the plan and the ledger**. The fixes are in
PR #835 (lanes L1-L6 and L8) and PR #821 (L7); `status.tsv` records what became
of every finding (see STATUS). Every finding went to an adversarial verifier that read the code
on origin/main. The directory is committed in the same run that produced it, per
`../README.md` § "WHY THIS DIRECTORY EXISTS AT ALL": round 1's findings were
nearly lost by living only in a temporary directory.

## THE AREAS

Sixteen: `app-1`, `app-2` and `app-3` (app.js and sw.js in three slices),
`player-core` and `player-rest` (player/), `search-api-css` (search-engine.js,
api/, styles.css), `gen` (backend/src/generation), `backend-rest` (the rest of
backend/), `ci-release` (.github, tools/ci, tools/release), `mobile-native`
(the Capacitor plugins and native shells, read, not run), `data-tools` (tools/),
`tests` (the suites themselves), and four cross-cutting lenses: `security`,
`data-integrity`, `perf` and `arch-drift`.

## THE NUMBERS

| stage | count |
|---|---:|
| raw findings | 216 |
| duplicates merged into another finding | 28 |
| dropped (not a defect, or restated a refuted round-1 row) | 2 |
| unique, sent to the verifier | 186 |
| **confirmed** | **174** |
| refuted | 6 |
| deliberate (covered by a ruling or a documented choice) | 6 |
| uncertain | 0 |

Confirmed, by the verifier's severity: **8 high**, 53 medium, 113 low.
The verifier often lowered the finder's severity. `findings.tsv` carries the
verifier's severity, and `findings-detail.md` carries both.

The high ones: `security-1`, `player-core-1`, `player-core-2`, `player-core-3`, `player-rest-1`, `gen-1`, `ci-release-2`, `mobile-native-1`.

The not-confirmed rows are kept, as in rounds 1 and 2, so they are not raised again:
`app-3-9` (refuted), `player-rest-3` (deliberate), `player-rest-6` (refuted), `search-api-css-13` (deliberate), `backend-rest-21` (deliberate), `ci-release-8` (refuted), `ci-release-14` (deliberate), `ci-release-16` (deliberate), `tests-9` (refuted), `data-integrity-9` (refuted), `arch-drift-8` (deliberate), `arch-drift-15` (refuted).

### By area

| area | verified | confirmed | high | medium | low |
|---|---:|---:|---:|---:|---:|
| app-1 | 16 | 16 | 0 | 7 | 9 |
| app-2 | 15 | 15 | 0 | 4 | 11 |
| app-3 | 13 | 12 | 0 | 5 | 7 |
| player-rest | 6 | 4 | 1 | 1 | 2 |
| search-api-css | 11 | 10 | 0 | 4 | 6 |
| ci-release | 16 | 13 | 1 | 4 | 8 |
| backend-rest | 22 | 21 | 0 | 5 | 16 |
| security | 7 | 7 | 1 | 1 | 5 |
| arch-drift | 12 | 10 | 0 | 2 | 8 |
| data-tools | 15 | 15 | 0 | 5 | 10 |
| player-core | 10 | 10 | 3 | 4 | 3 |
| gen | 16 | 16 | 1 | 6 | 9 |
| mobile-native | 9 | 9 | 1 | 2 | 6 |
| tests | 11 | 10 | 0 | 1 | 9 |
| data-integrity | 4 | 3 | 0 | 1 | 2 |
| perf | 3 | 3 | 0 | 1 | 2 |

### By category (confirmed)

The finders' categories, folded to their first word (`security/dos` counts as
`security`; `race` and `concurrency` count as `race-condition`). The exact
category of each row is in `findings.tsv`.

| category | confirmed |
|---|---:|
| correctness | 58 |
| error-handling | 22 |
| race-condition | 13 |
| security | 13 |
| resource-leak | 11 |
| duplicated-logic-drift | 10 |
| performance | 8 |
| dead-code | 7 |
| ci-tooling | 7 |
| stale-state | 3 |
| test-cannot-fail | 3 |
| tooling | 2 |
| data-loss | 2 |
| flaky-timing | 2 |
| resource-handling | 1 |
| i18n | 1 |
| stale-copy | 1 |
| test-quality | 1 |
| metrics | 1 |
| test-guard-weak | 1 |
| assertion-on-wrong-thing | 1 |
| harness-fidelity | 1 |
| slow-test | 1 |
| data-contract | 1 |
| privacy | 1 |
| duplicated-constant-drift | 1 |
| duplicated-constant | 1 |

## THE THIRTEEN CAUSES

`synthesis.md` §1 has the full text. Each cause names one rule that, once
promoted, retires the cluster. The themes cover 149 of the 174 confirmed ids
(an id can sit in more than one theme). The other 25 are one-off fixes with no
shared cause. Every confirmed id, themed or not, is in a lane.

| theme | confirmed ids |
|---|---:|
| R3-A. Async work that doesn't re-check who asked, and entry points that aren't single-flighted | 13 |
| R3-B. Transient failures are treated as definitive, and the wrong outcome gets cached or acted on | 13 |
| R3-C. External reads without a deadline over the whole body or a byte cap | 13 |
| R3-D. Unbounded work: caches, buffers, per-row re-parses and repaint rates | 15 |
| R3-E. Identity re-derived from a title, slug, counter or truncated value instead of minted once and carried | 14 |
| R3-F. One normaliser per concept, imported rather than copied (Unicode text, dates, durations, clocks, route hashes, quotes, constants) | 20 |
| R3-G. Untrusted text reaches a decoder that throws or a prototype lookup | 5 |
| R3-H. Gates that don't see the whole adversarial input, and credentials open by default | 15 |
| R3-I. CI and the release trigger read a different signal than production | 7 |
| R3-J. Writes onto an unsettled or partial base, and partial runs that replace instead of merge | 9 |
| R3-K. Transport commands don't enforce their postcondition | 9 |
| R3-L. The service worker touches more than it owns, and code and data can come from different generations | 6 |
| R3-M. Tests that cannot fail, or fail for timing reasons | 10 |

## WHAT IS HERE

| File | What it is |
|---|---|
| `synthesis.md` | The report: 13 root-cause themes, the fix-first shortlist, 5 founder questions, the 8-lane plan, the uncertain pile, coverage gaps |
| `findings.tsv` | One row per verified finding, 186 rows: `id, area, category, verdict, severity (verifier's), file:line, title, lane` |
| `findings-detail.md` | Full JSON per finding, including the verifier's reasoning and the merged duplicates |
| `dedup.md` | Which raw findings were merged into which, and the 2 dropped with the reason |
| `lanes.json` | The lane plan as data: `lane, scope, ids, brief`, with every confirmed id in exactly one lane |

`file:line` is against origin/main as the audit read it on 2026-09-25. Where a
finding named several files, `findings.tsv` shows the first and
`findings-detail.md` has the evidence for the rest.

## THE LANES

| lane | confirmed ids |
|---|---:|
| L1-app-data | 21 |
| L2-app-surface | 24 |
| L3-player-and-native-tts | 26 |
| L4-web-platform | 24 |
| L5-generation | 22 |
| L6-backend-rest | 22 |
| L7-ci-release-security | 18 |
| L8-data-tools | 17 |

Every confirmed id is in exactly one lane, and no refuted or deliberate id is in
a lane. Scopes, the ordering constraints, the cross-lane edits each lane is
allowed, and the collision map with the unmerged `engine/m1` branch are in
`lanes.json` and `synthesis.md` §4.

## FOUNDER QUESTIONS

Product, spend, legal and credential calls only. Every other decision has a
default in its lane brief.

- Q1 (product): Family Mode and unrated episodes (data-integrity-4). 516 of 2,167 pool items have no `explicit` flag, and 157 of them belong to shows with explicit-rated episodes in the pool. Family Mode shows them today, and show pages skip the filter entirely. Should an unrated episode be hidden in Family Mode (fail-closed), or inherit its show's catalogue rating and be hidden only if the show is rated explicit? DEFAULT if unanswered: inherit the show-level rating when there is one, otherwise hide. Family Mode gets stricter and some clean episodes disappear from it until the refresh pipeline backfills the flag.
- Q2 (credentials/admin, only you can do these): (a) create a `release` GitHub environment limited to main and v* tags, move the 8 signing/upload secrets (IOS_DIST_CERT_P12_BASE64, APP_STORE_CONNECT_PRIVATE_KEY_BASE64, ANDROID_KEYSTORE_B64, PLAY_SERVICE_ACCOUNT_JSON, etc.) into it, and add a tag ruleset restricting who can create v* (ci-release-3). Until then any tag or branch push can run code that reads the signing keys. (b) Set the repo default workflow token to read-only and turn off 'Allow GitHub Actions to create and approve pull requests' (security-3). (c) Set the fork-PR approval policy to 'all outside collaborators', and until the security-1 fix merges, consider setting AUTOMERGE_FREEZE, because the hourly sweep can currently auto-merge a returning outsider's fork PR that touches app.js/sw.js. DEFAULT if unanswered: the lanes land every code-side fix. The release-environment PR is prepared with the hold label and does nothing until you create the environment, because adding `environment: release` first would break every release.
- Q3 (credentials + legal text): the new Supabase migration (RLS on the catalogue and pipeline tables, per-table policies on events/user_interests/taxonomy_nodes with server-set event timestamps, and a delete policy on learning_cursor so Delete my data can remove it) needs applying to the production Supabase project, which only you can do. It also makes the privacy policy accurate in two places: cp_lastpick is no longer stored, and learning_cursor is now deleted. OK to apply the migration after the PR merges, and OK for the lane to edit those two privacy-policy rows? DEFAULT: the PR adds the migration file and the policy edits; nothing reaches production until you apply it.
- Q4 (content policy, child-safety adjacent): gen-9 found that the generation safety check rejects ordinary documentary prompts ('How the Catholic Church covered up the sexual abuse of children', 'How sex education for kids changed in the 1970s', 'How to survive a nuclear bomb'), with an 'un-appealable' message, against DECISIONS.md's stated aim of avoiding false positives. Loosening it means allow-listing reporting and history framings in a category where a false negative is serious. Do you want it loosened, and should any topics stay hard-refused whatever the framing? DEFAULT if unanswered: no change to the regexes; the prompts are recorded as documented, skipped cases pending your ruling.
- Q5 (product, car behaviour): player-core-10 found that 'resume when a known car route comes back' (corner case #13) is dead code on the web player. It never fires, and if wired as written it would also resume a pause you made yourself. The native iOS engine on engine/m1 is taking over route policy. Should 4a auto-resume when the car reconnects, and should that be the native engine's job? DEFAULT if unanswered: delete the dead JS branch, document 'reconnecting never resumes' for the web/Android path, and leave the decision to the native engine.

## STATUS

**Worked through, 2026-09-25.** Every row of `findings.tsv` has one row in
[`status.tsv`](status.tsv) (`id, title, disposition, where, note`), including
the refuted and deliberate ones, which keep the verifier's verdict. `where`
names the lane, its merge into `r3fix/integration` and the commits;
`test/audit-status.test.js` holds the ledger to one row per finding, the kept
verdicts, and this table.

Lanes L1-L6 and L8 merged into `r3fix/integration` (PR #835) in that order,
followed by a review round of fixes on the merged tree. L7 (CI, release,
security) is its own PR, #821, because every file it touches is a
founder-merge path; its release-environment half is the held draft PR #822. A
completeness sweep then checked every row a lane reported as not done or left
to a founder ruling, and every row no lane reported (there were none). Two
were still live and were finished on the integration branch:

- `gen-9`: L5 applied the "no change" default before the founder ruled
  **loosen** on Q4. The safety check now keys on intent, not topic words
  (`cf0161c1`).
- `app-2-6`: L2 fixed the device half. The sweep did the event half: a changed
  or withdrawn thumbs vote reaches the learning job with the vote it replaces
  (`0b3ea310`). The privacy policy's `thumbs` row names the new field.

| disposition | rows | of which L7 (#821 / #822) |
|---|---:|---:|
| fixed | 172 | 16 |
| already-fixed | 0 | 0 |
| refuted (verifier) | 6 | 0 |
| deliberate (verifier) | 6 | 0 |
| refuted-now | 0 | 0 |
| deferred-founder | 1 | 1 |
| deferred-device | 0 | 0 |
| open | 1 | 1 |
| **all rows** | **186** | **18** |

The two L7 rows that are not fixed: `ci-release-3` waits for the founder to
create the `release` environment (HUMAN-ACTIONS #115; the code is held in
#822), and `tests-6` (ratchet every floor to its exact count) lands last by
design, once #835 and #821 have merged. #821 needs a rebase over #835:
`arch-drift-12` edits `api/episodes/appleBucket.ts`, which L4 moved to
`api/_lib/`.

"Fixed" means fixed in code with a test that fails without the fix (each new
rule mutation-checked, each new suite floored in `test/suite-integrity.test.js`),
not verified on a phone or in production. Steps only a person can take:

- HUMAN-ACTIONS #117: six phone checks (`mobile-native-1` to `-4`,
  `player-core-2`, `player-core-3`). The Swift and the Java compile only in CI.
- HUMAN-ACTIONS #118: remove the retired events server from the Windows
  Startup folder (`data-tools-12`, `security-9`).
- HUMAN-ACTIONS #116: apply `backend/migrations/supabase/0003_rls_least_privilege.sql`
  to production (`backend-rest-4`, `backend-rest-5`, `data-integrity-10`).
  Until then the new policies exist only in the repo.
- `app-3-7`: one iOS Safari check that the jingle still plays now that ranged
  and media requests bypass the service worker.
- `search-api-css-5`: a Vercel preview's Functions list should show only the
  four handlers.

### The founder questions

| question | outcome |
|---|---|
| Q1 Family mode and unrated episodes (`data-integrity-4`) | **Default applied, no ruling yet.** An unrated episode inherits its show's catalogue rating (trusted only when the show's own episodes agree); with none it is hidden. He can overrule it. The 516-item `explicit` backfill is a separate data PR. |
| Q2 signing secrets behind a `release` environment (`ci-release-3`, `security-3`) | **Ruled 2026-09-25: a founder follow-up**, HUMAN-ACTIONS #115. The code is held in #822 until the environment exists. |
| Q3 the Supabase RLS migration and two privacy-policy rows | **Ruled: a founder follow-up**, HUMAN-ACTIONS #116. The migration file and the `cp_lastpick` row landed; production is untouched until he applies it. |
| Q4 the generation safety check (`gen-9`) | **Ruled: loosen.** Done in the sweep: documentary, history, education and survival framings pass; sexual content involving minors and operational instructions for weapons or attacks stay refused whatever the framing. |
| Q5 resume when a known car route reconnects (`player-core-10`) | **Ruled: yes, and the native engine owns it.** The dead web-player branch is deleted; the engine's side is card NE-38r. |
