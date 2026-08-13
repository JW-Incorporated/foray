# STATE.md — active workstream announcements

New file (2026-08-12). Cross-session coordination board: any session running in
this repo announces long-running workstreams here so other sessions can route
around them on their next recon pass. Keep entries short; full plans live in
docs/. Completed workstreams move to their plan doc's retro section.

## Active workstreams

### corpus/embeddings — the embedding backfill pass (2026-08-13)

Running the experiment PLAN.md left open: local, keyless, $0 semantic search
over the corpus (`Xenova/bge-small-en-v1.5`, 384-dim q8 ONNX on CPU), measured
against the committed gold set in all three modes side by side. Landing as two
PRs: `corpus/embeddings-schema` (migration 0003 + vector storage) then
`corpus/embeddings-backfill` (the runtime, `search --mode`, three-mode eval).
**The default mode flips only if the numbers earn it** — keyword already
answers 15/15, so a negative result is a valid outcome and gets written down
either way.
- **Owned directories:** `tools/corpus/`, `docs/research/corpus/`.
- **Heads-up for reviewers:** this adds ~250MB of `onnxruntime-node`, isolated
  behind its own `tools/corpus/embed/package.json`. Base corpus tooling, the
  whole test suite and `search --mode keyword` work with it absent, and CI
  never installs it.
- **Shared files touched, each its own commit:** `test/suite-integrity.test.js`
  (floors), `docs/DECISIONS.md` (schema + model choice).
- **Out of scope, untouched:** `data/*.json`, `tools/segments|transcribe|refresh`,
  `backend/`, `app.js`, `.github/`.

## Completed workstreams

### corpus/refetch-weak-sources — recover the 8 weakest corpus sources (2026-08-13, COMPLETE)

PR: `corpus/refetch-weak-sources`. Recovered both dead links (source 12 AES
TD1004, source 52 LLM-as-a-Judge survey — repointed to a CC0 arXiv preprint,
redistribution verdict flips deny→allow) and 4 of 6 "thin" sources (2, 14, 33,
34, 39) via a new browser-rendered-capture ingestion route
(`corpus ingest-captured`, `tools/corpus/README.md#rendered-html-route`).
Source 37 (TTS Arena V2) stays honestly thin — cross-origin sandboxed iframe,
recorded not hidden. Also fixed a real bug: the manifest loader forked a
duplicate source on a URL edit instead of updating in place; fixed with
`corpus repoint-url`. Corpus: 52/54 → 54/54 ingested, 558 chunks. Full detail:
`docs/research/corpus/PLAN.md`'s 2026-08-13 retro.
- **Owned directories this touched:** `tools/corpus/`, `docs/research/corpus/`.
- **Shared files touched, each its own commit:** `docs/research/foray-research-dossier.md`
  (the two URL repoints), `test/suite-integrity.test.js` (isolated floor-bump
  commit), `CLAUDE.md` (corpus section refreshed to match).
- **Out of scope, untouched:** `data/*.json`, `tools/segments|transcribe|refresh`,
  `backend/`, `app.js`, `.github/`.

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
