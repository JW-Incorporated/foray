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

**Not yet worked through.** A handful of the highest-severity items were fixed
separately before this directory existed, because the founder hit them in the
field first rather than because they were on this list — the restored ribbon
publishing no media handlers (both fleets flagged it) among them.

Nothing here should be treated as still-true without checking: these are findings
against the tree as of 2026-09-22, and every `file:line` needs verifying before
it is acted on.
