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
