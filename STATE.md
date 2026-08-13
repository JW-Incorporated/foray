# STATE.md — active workstream announcements

New file (2026-08-12). Cross-session coordination board: any session running in
this repo announces long-running workstreams here so other sessions can route
around them on their next recon pass. Keep entries short; full plans live in
docs/. Completed workstreams move to their plan doc's retro section.

## Active workstreams

(none — see completed below)

## Completed workstreams

### corpus — research corpus ingestion (Joey's Claude, 2026-08-12, COMPLETE)

Done same day: 52/54 dossier sources ingested (480 chunks as first ingested,
~272k est. tokens; the chunker later stopped emitting bare `---` page-break
chunks, so the same 52 sources now rebuild as **451** — 29 junk chunks gone,
no source lost), searchable via `node tools/corpus/corpus.mjs search "..."`. Reports:
`docs/research/corpus/coverage.md` + `dead-links.md`. Retro in the plan doc.
Follow-up (`corpus/corpus-visibility`): the corpus itself stays machine-local,
but `docs/research/corpus/digests.md` + `corpus-index.json` carry the research
into every checkout — per-source digests we wrote, plus a redistribution
verdict for each source. Rationale: `docs/DECISIONS.md`, 2026-08-12 part 2.
PR #149 (ci.yml step to execute the corpus suites) landed 2026-08-12 —
CI/CD is Wyatt's call; he approved verbally by phone, relayed by Joey in
session (provenance recorded in the PR body and merge commit). The 156
corpus tests now run in `data-and-site` on every PR. The embedding
backfill is a future, separate pass.

- **What:** scrape + archive every source in `docs/research/foray-research-dossier.md`
  (~57 sources, 9 areas) into a migration-managed SQLite corpus with FTS5
  search, for later agent context / retrieval experiments / embedding backfill.
- **Branch prefix:** `corpus/*` — never commits to main directly, PRs only.
- **Owned directories:** `tools/corpus/` (new), `docs/research/corpus/` (new).
  DB + raw archives live in `data-local/corpus/` (already gitignored — nothing
  fetched is committed).
- **Shared files it will touch, each as its own isolated commit:**
  `test/suite-integrity.test.js` (mandatory floors for new tools/ suites),
  `docs/DECISIONS.md` (schema decision entry per workflow rule 4).
  Everything else stays inside owned directories.
- **Explicitly out of scope:** `data/*.json`, `tools/segments/`,
  `tools/transcribe/`, `tools/refresh/`, `backend/`, `app.js`, `.github/`
  (a ci.yml test step will be proposed as a separate PR left for Wyatt).
- **Plan:** `docs/research/corpus/PLAN.md`.
