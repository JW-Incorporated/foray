# Who owns what — Foray

Foray is a two-founder, AI-first project run out of the `JW-Incorporated` org,
on the same operating model as our sister project Long Live (Swift2). This is the
one-page split of responsibility. It exists so decisions have a clear owner and
AI sessions know whose call a given question is.

## The two founders

### Joey — CEO / Product
Owns **what Foray is and whether it's good**:
- Product direction, scope, and priorities — what to build next and why.
- The content bar: whether the curation delights, whether a hook earns its place,
  whether a show belongs in the pool.
- The product principles (curiosity-first, anti-dark-pattern, legally-boring,
  the copy rules) — these are Joey's to set and are binding on everyone,
  including AI marketing findings.
- Final call on any product tradeoff.

### Wyatt — CTO / Engineering
Owns **whether Foray is well-built and safe to ship**:
- Architecture and data model (the static site + `data/*.json`, the backend
  boundaries, the iOS/ForayKit split).
- Code health: tests, CI, the Definition of Done, keeping the nightly pipeline
  reproducible and keyless.
- Release-readiness and deploys; secrets and infrastructure.
- Final call on any technical tradeoff.

Where a question is genuinely both (e.g. a feature that reshapes the data model
*and* the product), the founders decide together; AI presents options with a
recommendation rather than silently picking.

## How AI fits

- **Claude Code** is the planner and primary builder. It does the work and makes
  tactical calls without asking; it escalates the three things in `CLAUDE.md` →
  "Decision authority" (merge/deploy, secrets/infra, spend/product-direction).
- Humans review **behavior and outcomes**, not code line-by-line. A PR is judged
  by "does it do the right thing and is it safe," not by reading every diff.
- Scheduled agents (the nightly refresh, and future ones) are registered in
  `docs/agents/runners.md` with a versioned prompt in
  `docs/agents/runner-prompts/`. Adding or changing one is an engineering change
  (Wyatt's lane) that must stay within the product principles (Joey's lane).

## Working split in practice (today)

- Wyatt drives the migration to cloud automation, the repo/CI/infra, and the
  build lane.
- Joey drives what the curator should feel like and vets the content the nightly
  refresh proposes (the nightly agent opens a PR precisely so a human can look
  before it goes live).
- Both founders have admin on the repo. Neither pushes `main` directly — the
  branch-protection ruleset applies to everyone, by design.

## Merge authority (updated 2026-07-30)

Joey can direct Claude Code to merge a PR to `main` once required checks
(`backend`, `data-and-site`) are green, without waiting on a review from
Wyatt — for PRs scoped to product/content/UX (the prototype, copy, data,
curation). This was changed at Joey's request on the reasoning that if he
can click "merge" himself, routing the same call through Claude shouldn't
require more than his own approval.

This does **not** extend to anything touching architecture, infra, secrets,
CI/CD config, or release process — those stay Wyatt's final call per the
"Decision authority" rules in `CLAUDE.md`, unchanged.

**Flag for Wyatt:** this change was made unilaterally at Joey's instruction,
not discussed with Wyatt first. Wyatt should review this section and the
corresponding `CLAUDE.md` change and confirm he's fine with it — until then,
treat it as provisional.

## What actually requires a founder to merge (updated 2026-08-16)

The section above is about *authority*: whose call it is. This one is about
*mechanism*: what still lands on a human's desk after the machinery has done
everything it can. Wyatt approved this mechanism and the `.github/` changes it
needed — "Yes, make all those changes and merge the associated PRs."

**One rule, one implementation.** The allow/deny path lists live in
`tools/ci/path-policy.mjs` with a test suite. They used to be two heredocs
inside `.github/workflows/automerge-nightly.yml`, which meant they governed only
what GitHub Actions did — on 2026-08-16 two PRs were merged from a laptop with
`gh pr merge` and a founder token and went past them, because on that route
there was nothing to go past. The same module now backs both the auto-merge
decision and a `path-policy` status check that reports on every PR.

**A PR merges without a founder when** every changed path is in
`ALLOWED_PREFIXES` (`data/`, `docs/`, `player/`, `tools/`, `test/`,
`backend/test/`, `app.js`, `styles.css`, `search-engine.js`, `STATE.md`,
`HUMAN-ACTIONS.md`), it carries neither `hold` nor `founder-decision`, and
`AUTOMERGE_FREEZE` is unset. Required checks still gate it: nothing red merges.

**A PR needs a founder when** it touches a governed path
(`.github/`, `.claude/`, `CLAUDE.md`, `docs/DECISIONS.md`, `docs/adr/`,
**this file**, `docs/agents/routine-invariants.md`, `backend/src/`, `tools/ci/`)
or a path in neither list. Those PRs are labelled `needs-founder`
automatically and collect in `HUMAN-ACTIONS.md`, so the residue is one batched
glance rather than something anyone has to notice.

**`backend/test/` is on the merge-without-a-founder side, `backend/src/` is
explicitly on the other.** A test-only backend change cannot break production:
a wrong assertion turns the required `backend` check red and the PR cannot
merge at all. The blast radius is a red build, not a bad deploy.

**What `founder-approved` does, precisely.** It makes the `path-policy` *check*
green. It does **not** arm auto-merge on a governed path — a founder still
performs the merge. Say it that way and nowhere say "approval instead of
merge": letting a label auto-merge a change to `.github/` or `CLAUDE.md` would
be strictly more dangerous than requiring the click, and nobody has decided
that. The label's value is that the rule is stated, evaluated on every PR, and
recorded on the ones that pass it.

Be clear-eyed about the limit. It is a guardrail against accidents and a record
of intent, not a wall: both founders have admin and admin can override a
required check, and the check is satisfied by a label that anything with repo
write access can apply. It buys visibility and one consistent rule across both
merge routes. A signal an agent genuinely cannot produce would need CODEOWNERS
review from a founders-only team; that is a separate decision.

**Two mechanics worth knowing, because their absence caused real incidents:**

- Auto-merge, once armed, is **sticky**. Adding `hold` or pushing a commit that
  touches a governed path does not clear it. `automerge-decision` therefore
  *disarms* as well as arms, and the 6-hourly `pr-hygiene` sweep disarms
  anything the `AUTOMERGE_FREEZE` kill switch should have stopped — setting a
  repo variable fires no PR event, so the sweep is the only thing that can
  reach an already-armed PR.
- Arming is bound to the exact commit it judged (`--match-head-commit`), so a
  later push cannot ride an earlier approval.
