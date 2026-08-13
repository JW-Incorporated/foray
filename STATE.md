# STATE.md — active workstream announcements

New file (2026-08-12). Cross-session coordination board: any session running in
this repo announces long-running workstreams here so other sessions can route
around them on their next recon pass. Keep entries short; full plans live in
docs/. Completed workstreams move to their plan doc's retro section.

## Active workstreams

(none — see completed below)

## Completed workstreams

### corpus/embeddings — the embedding backfill: a measured NO (2026-08-13, COMPLETE)

Branch `corpus/embeddings` (migration 0003: `embedding_models` +
`chunk_embeddings`, replacing the single `chunks.embedding` column; the
quarantined runtime; `search --mode`; a three-mode eval). Ran end to end:
1256 vectors in ~1 minute, local, keyless, $0. **The answer is no — the default
search mode stays `keyword`, and the corpus is left on its original chunking
with no vectors stored.** Keyword beat both candidates on every metric in every
configuration; hybrid is −0.122 Recall@5, −0.028 MRR, −0.104 nDCG and loses one
gold query outright. Embeddings additionally require a re-chunk that costs
keyword a further 0.074 MRR. Full numbers, per query:
`docs/research/corpus/PLAN.md`'s 2026-08-13 retro. Embeddings do genuinely
answer paraphrase queries keyword cannot, which is why the capability is
committed rather than reverted — opt-in, ~65s to reproduce.
- **Caught in review, worth knowing:** the first draft of this verdict rested
  on a metric labelled `Recall@5` that was actually hit rate, pinning the
  baseline at 1.000 and making one gate unpassable by construction. Fixed,
  tested, re-measured; the conclusion held and got stronger.
- **Owned directories:** `tools/corpus/`, `docs/research/corpus/`.
- **Dependency note:** `tools/corpus/embed/` carries `@huggingface/transformers`
  (**373MB installed**, measured). It is a separate package.json; CI's
  `npm ci` in `tools/corpus` never installs it, the whole test suite runs on a
  stub embedder, and `search --mode keyword` works with it absent.
- **A real bug fixed on the way:** the corpus test suite was writing fixtures
  into the real `data-local/corpus/` archive, and since #161's
  `removeStaleArchives` was *deleting* real archived markdown on every
  `npm test`. Archive root is now a parameter alongside the DB.
- **Shared files touched, each its own commit:** `test/suite-integrity.test.js`
  (floors, tools/corpus 175 → 279), `docs/DECISIONS.md`, `CLAUDE.md`.
- **Out of scope, untouched:** `data/*.json`, `tools/segments|transcribe|refresh`,
  `backend/`, `app.js`, `.github/`.

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
