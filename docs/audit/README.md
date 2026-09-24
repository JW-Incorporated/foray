# The 2026-09-22 design and QA audit

Two multi-agent fleets audited the app on 2026-09-22, at the founder's request:

> "I worry that the design of the 4a app is just subtly wrong in all kinds of
> ways, little bugs. Please plan and deploy a fleet of design and QA reviewers.
> The overall app is pretty good, but lots of little things feel subtly off,
> especially once you start diving into details."

and

> "Maybe also good to have several bots that pretend they are new users and flag
> things which are unintuitive, too different from apps like Apple Podcasts
> (excluding forays of course), or use language like 'beats' and so on."

They were told to **flag, not fix** — also the founder's instruction: *"The
agents should just flag loads of things to be fixed, afterwards you can make a
detailed plan and execute. Dont have the agents fix anything, just audit the
app."*

## ROUND 2 (2026-09-23)

The founder's follow-up — *"After all fixes are in, repeat this exercise
again"* — ran on 2026-09-23 against origin/main 9730b5b, after every round-1
lane had merged. It lives in [`round-2/`](round-2/README.md): 209 raw findings
from 18 lenses, 172 unique after dedup, **163 confirmed** (5 high), 2 refuted,
5 deliberate, 2 uncertain, grouped into 14 root causes and an 8-lane plan.
**Status: not yet worked through.** This directory's own ledger
(`status.tsv`) and the tables below are round 1 only.

## WHY THIS DIRECTORY EXISTS AT ALL

Because the findings were nearly lost. Both fleets reported in-conversation, and
nothing was written to the repo. The session was then compacted, and the only
surviving copies were in a **session-scoped temporary directory** — the sort
that is cleaned without warning — plus a raw transcript nobody would think to
grep. A later session went looking for "the issue list from those agent swarms"
and had to spend an agent recovering it.

That is CLAUDE.md § "Knowledge lives in the repo" failing in the most expensive
direction available: 259 reviewed findings, each with evidence and a fix sketch,
one `rm -rf` from gone. **Any future audit fleet commits its output in the same
change that produces it.**

## WHAT IS HERE

| File | What it is |
|---|---|
| `qa-synthesis.md` | The QA report: 12 root-cause themes (A–L), a 17-step fix order in 5 phases, an 8-item "felt" shortlist, the uncertain pile, coverage gaps |
| `qa-findings.tsv` | One row per QA finding, 193 rows — `area, verdict, severity, confidence, file:line, title, findJL, verdictJL` |
| `qa-findings-detail.md` | Full JSON per finding: `title, file, line, severity, user_visible, evidence, why_subtle, fix_sketch, suspected_deliberate` |
| `persona-synthesis.md` | The newcomer report: first-five-minutes walkthrough, jargon ledger, needless vs deliberate deviations from Apple Podcasts, explanation-debt table, a 35-item fix order in 5 tiers |
| `persona-findings.tsv` | One row per persona finding, 84 rows, same schema |
| `persona-findings-detail.md` | Full JSON per persona finding |
| `status.tsv` | What became of every finding, one row each (see STATUS below) |
| `round-2/` | The 2026-09-23 re-run: findings, dedup, synthesis, lane plan ([README](round-2/README.md)) |

`findJL` / `verdictJL` point into the corresponding `-detail.md` by journal line,
so a TSV row can always be expanded to its evidence.

## THE NUMBERS, AND WHAT THEY MEAN

**QA fleet** — 10 review areas (touch, player, visual, a11y, races, states, nav,
copy, persist, honesty), 20 findings each. Every finding was then put to an
adversarial verifier:

- **176 confirmed**
- 16 refuted
- 1 uncertain

**Persona fleet** — 6 personas (car, impatient, switcher, first-launch, jargon,
apple-loyalist), 14 complaints each:

- **67 real friction**
- 16 deliberate choice (the app is different on purpose, and that is fine)
- 1 already handled

The refuted and deliberate-choice rows are kept deliberately. A verdict of "this
is intentional" is worth as much as a bug when the next reader asks why the app
does something odd, and a refuted finding stops it being re-raised.

## THE TWELVE ROOT CAUSES

From `qa-synthesis.md`. Two thirds of the 176 collapse into these, and the
recurring shape is **not** that the architecture is wrong — it is that a correct
fix was written once, at the call site that hurt, and never promoted to the rule.
That is what "subtly off" turned out to be.

- **A** The curated 220 pool is used as the identity test for "a real episode"
- **B** Async work does not know which page asked for it
- **C** A rule exists in one module while the running code bypasses it
- **D** Two names for one truth (`aria-label` vs `textContent`)
- **E** Nothing owns "a modal is open"
- **F** Tap targets sized by eye
- **G** Loading and failure rendered as fact
- **H** Sticky copy outliving its subject
- **I** The v2 redesign is a layer over v1, with v1 showing through
- **J** Durability designed but not finished
- **K** Back/forward guessed, because the URL is not the source of truth
- **L** Two models of the same object, so the numbers disagree

Theme **A** is the one to read first: `state.poolIds.has(id)` is the identity
test in five places, and since show pages gained the full catalogue most episodes
a listener touches are not in that pool — so the app classifies its own working
episodes as gone. Six bugs, three of them the highest-severity items in the whole
report, and the fix is two functions and about ten lines.

## STATUS

**Worked through, 2026-09-22/23.** Every finding has a row in
[`status.tsv`](status.tsv) — `src, tsvRow, title, disposition, where, note` —
including the refuted and deliberate ones, which keep the verifier's verdict.
`src` + `tsvRow` name a line of `qa-findings.tsv` / `persona-findings.tsv`
(1-based). `where` names the lane, the merge or PR, and the commits.

The work was split into eight lanes. L1–L6 are merged into
`audit-fix/integration` (PR #742); L7 (release reliability, from its own brief
rather than audit rows) is PR #739; L8 (Foray data) is PR #741. A completeness
sweep then re-verified, on the integration branch, every row a lane handed to
another lane and every row no lane was given, and fixed the six still live
(qa 79, 80, 161, 163, 168, 169).

| disposition | QA | persona | total |
|---|---:|---:|---:|
| fixed | 176 | 64 | 240 |
| already-fixed (before the lanes, or when audited) | 1 | 3 | 4 |
| refuted (verifier) | 16 | — | 16 |
| deliberate (verifier) | — | 16 | 16 |
| deferred-founder | 0 | 1 | 1 |
| deferred-device | 0 | 0 | 0 |
| open | 0 | 0 | 0 |
| **all rows** | **193** | **84** | **277** |

"Fixed" means fixed in code with a test that fails without the fix (each new
rule mutation-checked, each new suite floored in `test/suite-integrity.test.js`),
not verified on a phone. Where only a device can confirm something, the row's
note says so: the notched-inset change (qa 13), the native Preferences tier
(qa 172), and how VoiceOver voices the new focus and live regions (qa 80).

### Still open, and why

- **qa 152** was the last open row: `data/session.json`'s `fit_line` /
  `archetype_label` carried commute framing and no test gated them. Fixed
  2026-09-23 (PR #743): the four fit-lines are plain duration statements (the
  shape `sessionBuilder.ts` already emits), the label is "Go deep",
  `COMMUTE_FRAMING` in `backend/src/copy/rules.js` names the shapes `BANNED`
  missed, and `copyRules.test.ts` reads every string on a card, with
  `sessionBuilder.test.ts` gating the generator's own output.
- **qa 78** was deferred-device (buttons nested inside anchors); visual pass 1
  (PR #744) made the Jump back in and subject cards stretched-link cards and
  deleted the unreachable Continue banner, so it is fixed — still worth a look on
  a phone, as the PR body says.
- **deferred-founder** (1): persona 44. It is one of the
  questions below. Of the seven this line used to list, qa 28 was answered on
  2026-09-24 ("1x for now") and fixed in PR #777, persona 56 and 82 were fixed
  by the 2026-09-24 rename (question 10), and persona 14 by publishing a
  narrated Foray (question 19). qa 146 and persona 65 were answered the same day
  ("Sentence case, no period, though ? And ! Are allowed"; "Accept the ones that
  are currently there; update our foray generation scripting to avoid making more
  in the future") and fixed on `fix/generator-vocabulary-title-style`. Questions 5, 6 and 16–18 were answered on 2026-09-23
  (`docs/DECISIONS.md`, "the visual changes - have at them"): qa 43, 47, 51,
  54, 59, 60 and persona 10, 40, 58 are fixed in visual pass 1 (PR #744).

### Founder questions

Playback
1. Spoken (synthesized) narration plays at the listener's speed; `resetRateForTTS`
   says that is deliberate, while pre-rendered narration and corner case #18 say
   1.0x. Which? Either way the `rate.deferred … plays at 1.0x` log line is wrong
   for spoken lines (qa 28). **Answered 2026-09-24:** "1x for now, but maybe we
   change later. I recall 1x felt like 0.6x or so, it was very slow." Fixed on
   `fix/narration-1x`: spoken lines and the voice Preview are 1x.
2. When a call, Siri or a navigation prompt ends and iOS says audio may resume,
   should 4a resume by itself like Apple Podcasts? Doing it safely first needs
   #699 §1 (telling a chosen pause from an interruption).
3. A head unit's STOP now pauses and keeps the controls; the Android
   notification's own Stop still closes the player. OK?
4. Founder report 2 (stops while backgrounded): if the next field record shows
   stops on a healthy element with background rows and no interruption rows, the
   cause is native (WebKit's audio session) and needs a native card and a device.
5. Inside a Foray the two buttons beside play are previous/next clip, not ↺15 /
   30↻. Keep the nudges inside a Foray too and move clip navigation elsewhere?
   That redesigns the Foray transport on three surfaces (persona 58).
6. Mini player: add a back-15 (or forward-30) button beside play (persona 10)?
7. "Start over" on a Foray: keep the stored resume point until the new position
   passes it, so a mis-tap can be undone (persona 12)?
8. Now Playing has three dismiss affordances (✕, Close, drag): collapse to one
   chevron plus drag (persona 79)?

Continuous playback and Home
9. Continuous playback plays Up Next, then the rest of the list you started from,
   then stops. Is #691's "then more of what fits" the next step?
10. "Episodes for you" (your name, from the ui-transition brief) holds subject
    cards. Make the cards episode-shaped, or rename the section "Subjects for
    you" (persona 56, 82)? **Answered 2026-09-24: "Rename it 'Suggested'"**
    (`docs/DECISIONS.md`, 2026-09-24).
11. Should Home's subject cards get a one-tap play that starts "Starts with …"
    and continues through the subject list (persona 44)? The code's rationale
    today says sequence cards are only a way in.
12. The header tagline "a daily podcast picker" promises a daily cadence Home
    does not have (it re-deals every load). Keep, drop "daily", or seed the deal
    by day (qa 149)?
13. Create: remove the permanently disabled Foray half of the toggle until
    custom Forays exist, or keep it visible as D8 says (persona 26)?
14. Starred shows are now "Followed shows" with Follow/Followed, per the
    Apple-parity vocabulary ruling (Joey's A2.4 said "starred"). Confirm, given
    following pushes no new episodes (the page says so).
15. The playlist check behind "Create a playlist about …" now says it is still
    working but still locks the page on a phone. Worth a Web Worker card
    (persona 28)?

Look and feel (R12: these visibly change the app)
16. Typography: Home's "Episodes for you" titles (Georgia 1.2rem beside
    Fraunces), the topbar wordmark (the `.wordmark` rule is unused), and the
    Georgia section labels. Convert all to Fraunces (qa 43, 47, 51)?
17. Consolidate the two "Generated for you" badge shapes, the two subject-pill
    components, one artwork treatment and a radius scale (qa 45, 54, 59, 60)?
18. Episode rows leave ~114px for the title at 390px: icon-only "+ Up Next" at
    phone width, or controls on a second line as Up Next rows now have
    (persona 40)?

Data and release
19. Only 1 of 8 Forays is published, and it has no narration although
    onboarding promises a narrator. Publish a narrated Foray after a listen, or
    hedge the onboarding sentence (persona 14, 83)? **Answered 2026-09-24:
    "Publish any foray so that the statement is correct; this is a temporary
    issue while we are spinning up and will soon be irrelevant."**
    `how-ai-actually-gets-built-3b83e1` is published (branch
    `data/publish-narrated-foray`); persona 14 is fixed.
20. HUMAN-ACTIONS #2 ("listen to Foray #1") no longer applies now that
    grilling-history-1 is retired: skip it, or point it at grilling-history-2?
21. House style for Foray titles and summaries (sentence case, a summary ends
    with a period)? Once set it is enforced in `check-forays.mjs` and the
    generator's `forayCopy` (qa 146). The narrator's spoken "act" needs a
    generation run (persona 65).
22. HUMAN-ACTIONS #46: re-enable the `foray-nightly-enrich` Cloud routine
    (disabled since 2026-09-13, and the only reason nightly-refresh and
    nightly-watch are red), and clear the stranded 2026-09-14 digest by losing
    its 40 episodes or recovering them?
23. PR #739 adds two scheduled release workflows; the trigger dispatches
    `release.yml` at most every 3h when release-relevant commits wait
    (RETRY_BUDGET=2). OK to merge?
24. After the next TestFlight/Play build, check that
    `window.forayStorageHealth().durableTiers` lists `['native','idb']` and that
    resume and the anonymous account survive a relaunch (qa 172).
25. The Developer group sits directly above Delete my data (which stays the
    drawer's last item). Want Developer last instead?

### Rulings applied

- **R1**: a real episode is a pool member OR a held snapshot with `audio_url`
  (`liveEpisode`); queue, play and save all write the same snapshot.
- **R2**: continuous playback is on by default, named "Continuous playback",
  Up Next first then the chosen list; the car's next/previous come from the page
  (`setEpisodeNavigation`); the stale "no autoplay chains" comments are updated.
- **R3**: listener vocabulary. A Foray's pieces are clips, its sections parts;
  shows are Follow/Followed, episodes Save/Saved; lowercase "this foray" per
  DECISIONS 2026-08-21. Raw developer strings (tags, keys, error classes,
  taxonomy ids, resolver reasons) never reach the screen.
- **R4**: loading claims nothing; a failure says so and offers Try again wired
  to the same fetch; empty only after the source answered; a count and its rows
  come from one source; a failed play says so and the retry is the same press.
- **R5**: one `openSheet`/`closeSheet` owner for every sheet, Now Playing
  included (focus in/out, inert, Tab trap, Escape, single instance).
- **R6**: Forays and Followed shows are Library sections; the drawer uses the
  tab bar's names; the Search field's position and tile behaviour stand.
- **R7**: "Open in" deleted with everything it governed.
- **R8**: founder tools in one collapsed Developer group; no hidden unlock.
- **R9**: the header ↻ refreshes the current page in place.
- **R10**: the durability claim is made true (native Preferences tier), not
  amended.
- **R11**: Delete my data deletes every store the code opens, re-reads to
  confirm, and reports failures in plain words.
- **R12**: only ≤2px accidental duplicates consolidated in the lanes; typography,
  badges, pills, artwork and a radius scale were founder questions, answered on
  2026-09-23 and shipped as visual pass 1 (PR #744; `docs/DECISIONS.md`).
- **R13**: 44px hit areas through one zero-specificity rule, so visual sizes
  do not jump; Stop gets the danger colour and moves away from Close.
- **R14**: founder rulings and in-code rationales were read before touching
  anything they cover (#699 before the native session, Joey's tap-to-seek, D7/D8,
  "Episodes for you", the Jump back in play button), and kept.
- Sweep additions: `--faint` is for disabled states and borders only (text and
  live controls read `--muted`, pinned in `test/ui-tokens.test.js`); a route
  names the document after its page heading and lands lost focus on it.

Nothing here should be treated as still true of a later tree without checking:
`file:line` in the finding TSVs is against 2026-09-22.
