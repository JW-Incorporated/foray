# Runner prompt — breadth-catalog classification batch (Claude Code cron routine)

This is the versioned prompt for the breadth-catalog reclassification agent
(`docs/adr/0006-podcast-classification-methodology.md`). It runs
**unattended, on a schedule, on the Claude Max plan** — no Anthropic API
key, no per-token dollar cost. The constraint is the plan's weekly usage,
which the orchestrator paces across multiple runs over roughly two weeks
to cover the ~19,787-show US breadth catalog. Be conservative and honest
about uncertainty — a wrong tag that looks confident is worse than an
admitted `needs_review`.

Read `CLAUDE.md` first (product principles, copy rules — binding), then
`docs/adr/0006-podcast-classification-methodology.md` and
`docs/curation/breadth-classification-methodology-plan.md` for the full
methodology this batch executes one slice of. **You do not need to re-read
those every run** once you're familiar with them — but do re-read this
file every run; it's the operational contract.

## Why this exists

`data/breadth-classification.json` is not trusted today: the prior pass
classified shows from Apple genre + title alone (no description, no
episode content), and produced confirmed wrong tags (e.g. *Science
Friday*, a general-science show, tagged `medicine/biology`). You are
replacing that, one batch at a time, using real signal: each show's actual
description and a sample of its recent episodes.

## The pipeline you sit in

1. **`tools/classify/prepare-batch.mjs`** (deterministic, keyless, no LLM
   — already run for you, or you run it yourself as step 1 below) selects
   the next batch of shows and fetches each one's RSS feed for signal
   (description + recent episode titles/descriptions). It writes a batch
   **input** file.
2. **You** (this prompt) read that file and classify every show in it.
   You write a batch **results** file — pure data, your classification
   judgment, nothing else.
3. **`tools/classify/merge-results.mjs`** (deterministic, keyless)
   validates your output (taxonomy node ids exist, confidence is a real
   number, copy rules on `display_title`/`blurb`) and merges it into
   `data/breadth-classification.json`, replacing whatever was there
   before for each show you classified.

## Steps (follow exactly)

1. **Prepare a batch**, if one doesn't already exist for you to read
   (check whether you were handed a specific batch input path — if so,
   skip to step 2):
   ```sh
   node tools/classify/prepare-batch.mjs --batch-size 40 --mode fresh \
     --progress data/classify-progress.json
   ```
   Use `--mode escalate` instead when the orchestrator specifically asks
   for a Tier-2 escalation pass (re-examining shows a prior Tier-1 batch
   flagged `needs_review`) rather than a fresh batch. **Always pass
   `--progress data/classify-progress.json`** for a real (non-test) run —
   this is a tracked file so progress survives between routine
   invocations; the default `data-local/` path is untracked and only for
   local experimentation.

   If the script prints `CLASSIFY_BATCH_EMPTY`, there is nothing to do —
   stop, do not open a PR.

2. **Load reference data once**: `data/taxonomy.json` (the full node list
   — every `node` you emit must be an id that exists here) and skim
   `data/genre-taxonomy-map.json` for context (each show's batch entry
   already carries its Tier-0 prior computed from this map — you don't
   need to recompute it).

3. **Classify every show in the batch.** For each entry in the batch
   file's `shows` array, using `title`, `apple_genre`/`chart_genre_name`,
   `tier0_prior` (the genre-map guess — a *prior*, not ground truth),
   `description`, and `episodes` (recent titles + descriptions):

   - **Multi-label, per-node confidence.** A show can legitimately span
     multiple nodes (e.g. `science` + `medicine/biology` + `education`).
     Assign each candidate node a confidence 0–1 reflecting how well the
     show's *actual* content (not just its genre) fits that node. Don't
     pad the list — 1–4 nodes is typical; a narrowly-focused show may
     genuinely have just one.
   - **Weigh the Tier-0 prior, don't defer to it.** It's a genre-derived
     guess that is often too coarse (this is the whole reason this
     pipeline exists — see Science Friday above). If the description and
     episodes point somewhere more specific or different from the prior,
     trust the actual content.
   - **`needs_review: true`** whenever (a) every candidate node's
     confidence is below **0.6**, or (b) your top node's top-level branch
     genuinely conflicts with a high-confidence Tier-0 prior (e.g. prior
     says `engineering` confidently, you land on a narrow, unrelated leaf
     — this is exactly the fusion/fission/general-engineering confusion
     pattern issue #12 documented; when in doubt on an adjacent-node
     call, flag it rather than force a specific pick). **Never resolve
     genuine ambiguity by guessing** — flag it and move on. A human will
     review the `needs_review` pile; that pile being non-trivial is
     expected and fine, not a failure.
   - **`rationale`**: one short sentence (~15 words) — what the show is
     actually about, in your own words from the real signal, not a
     restatement of the genre.
   - **Escalation batches (`mode: "escalate"` in the batch file, `tier: 2`)**:
     each show carries `prior_result` (what Tier-1 concluded and why it
     was flagged) and, when available, `transcript_excerpts` (real
     transcript text from 2–3 recent episodes — the *only* case this
     pipeline uses transcript content, per ADR-0006 §"Rejected
     Alternatives"). Weigh the disagreement explicitly: is the Tier-0
     prior right, was Tier-1 right, or is this show genuinely ambiguous
     and should stay `needs_review: true` even after a second look? A
     Tier-2 pass ending in `needs_review: true` is a legitimate, expected
     outcome for a genuinely hard show — do not force a confident answer
     just because this is the second attempt.

4. **Generate the two Foray-authored display fields** (same call, same
   show — you're already reading its description and episodes):
   - **`display_title`**: **DEFAULT = the real show title, kept VERBATIM.**
     Rewriting is the rare exception, not the norm. Keep good real titles
     exactly as they are — `Sound Opinions` → `Sound Opinions`,
     `The Dice Tower` → `The Dice Tower`, `Real Time with Bill Maher` →
     `Real Time with Bill Maher`. Only change it when the real title is
     genuinely long, cryptic, ALL-CAPS, or clickbait — and even then keep
     the real brand: `Planetary Radio: Space Exploration, Astronomy and
     Science` → `Planetary Radio` (shorten, brand kept). **NEVER replace a
     real show name with a generic category** — `Sound Opinions` →
     `Music Criticism`, `Real Time with Bill Maher` → `Political
     Commentary`, `The Dice Tower` → `Board Game Show` are all WRONG: they
     destroy the show's identity. A generic descriptor is worse than the
     original title. When in any doubt, keep the real title unchanged.
   - **`blurb`**: 1–2 sentences, grounded strictly in the real
     description/episodes you just read. Never fabricate, never
     exaggerate, never claim something the source material doesn't
     support.
   - **Copy rules (both fields, hard constraints — `merge-results.mjs`
     re-checks these and will null out + flag anything that fails, so
     get it right the first time):**
     - `display_title` ≤ **8 words**. `blurb` ≤ **30 words**.
     - Banned in either: "fascinating", "deep dive", "delve", "explores",
       "you won't believe", any commute-length framing ("fits your
       drive", "your commute", "-minute drive"), clickbait withholding
       ("we can't get into it here...").

5. **Write the results file** (path convention:
   `data-local/classify-results-<batch_id>.json`, next to the batch input
   — `data-local/` is fine here, it's a hop to `merge-results.mjs`, not a
   persisted artifact) matching this exact schema:
   ```json
   {
     "batch_id": "<copy verbatim from the batch input file>",
     "results": {
       "<apple_collection_id>": {
         "topics": [{"node": "science", "confidence": 0.85}, {"node": "medicine/biology", "confidence": 0.4}],
         "needs_review": false,
         "rationale": "General-audience science news show; occasional biology/medicine segments.",
         "display_title": "Science Friday",
         "blurb": "Weekly science news and interviews covering research, technology, and the natural world.",
         "model": "claude-code-cron (tier 1)"
       }
     }
   }
   ```
   One entry per show you classified. It is fine to omit a show entirely
   if you genuinely cannot form any judgment even after reading its
   signal (e.g. the fetched description is empty/garbage) — `merge-results.mjs`
   reports missing entries rather than failing the batch, and that show
   stays eligible for a future batch.

6. **Merge** (this is committed machinery — do not edit it, just run it):
   ```sh
   node tools/classify/merge-results.mjs \
     --batch data-local/classify-batch-<id>.json \
     --results data-local/classify-results-<id>.json
   ```
   Set `PROGRESS_PATH=data/classify-progress.json` (same tracked path you
   used in step 1) and `BREADTH_CLASSIFICATION_PATH` only if it isn't
   already the default `data/breadth-classification.json`. If it reports
   validation errors for specific shows, that's expected occasionally
   (e.g. a typo'd node id) — it skips just those and merges the rest; you
   don't need to fix and re-run unless the skip count looks systematically
   wrong (e.g. every show failed the same way — that suggests a schema
   mistake in your results file worth fixing before opening a PR).

7. **Sanity-check before opening a PR.** Spot-read a handful of merged
   entries in `data/breadth-classification.json` — do the topics, the
   `needs_review` flags, and the display fields look right? If something
   is structurally off (e.g. the merge script errored, or most of the
   batch came out `needs_review: true` for no evident reason), STOP,
   leave things uncommitted, and leave a note for a daytime human session
   rather than opening a PR with output you don't trust.

8. **Open a PR — never push to `main`.**
   ```sh
   git switch -c "classify/$(date -u +%F)-<batch_id>"
   git add data/breadth-classification.json data/classify-progress.json
   git commit   # message: "Classify batch <batch_id>: N shows (tier 1|2)" + co-author trailer
   git push -u origin HEAD
   gh pr create --base main --title "Classify batch <batch_id>: N shows" \
     --body "Breadth-catalog reclassification, batch <batch_id> (tier <N>). See docs/adr/0006-podcast-classification-methodology.md."
   ```
   Do NOT merge it yourself unless the repo's automerge policy for
   `classify/*` branches explicitly covers it (check
   `docs/agents/runners.md` / `.github/workflows/` — if no automerge rule
   exists for this branch prefix yet, leave the PR open for human review).

## Hard constraints

- Touch ONLY `data/breadth-classification.json` and
  `data/classify-progress.json` (both exclusively via
  `merge-results.mjs`/`prepare-batch.mjs`), plus your own ephemeral
  `data-local/classify-*.json` working files. **Never touch
  `data/catalog.json` or `data/discover.json`** — the curated tier's
  hand-authored tags always win; this pipeline only fills/corrects the
  breadth tier, never overrides curated data. No schema changes, no
  dependency changes, no edits to `tools/classify/*` or
  `backend/src/copy/rules.js`.
- Never push to `main`; never force-push.
- Never guess. A show with no confident node is `topics: []` (or your
  best-effort low-confidence guess with the node explicitly marked low
  confidence) plus `needs_review: true` — visible and auditable, never a
  plausible-looking wrong label forced to look decisive.
- Never fabricate `display_title`/`blurb` content not grounded in the
  actual description/episodes you read.

## Notes

- No API keys, no `ANTHROPIC_API_KEY`, no Batch API, no per-call dollar
  cost — you ARE the classifier; there's no separate model call to make.
  `tools/classify/prepare-batch.mjs` and `tools/classify/merge-results.mjs`
  are both keyless, deterministic Node scripts (RSS fetch + JSON
  validation) — the only judgment in this pipeline is yours.
- Full episode transcripts are deliberately **not** part of your signal
  except on `mode: "escalate"` (tier 2) batches, and only for the 2–3
  most recent episodes when a `<podcast:transcript>` tag already existed
  in the feed (free — no extra fetch cost). Don't ask for or expect full
  transcripts on tier-1 batches; per ADR-0006 this is a deliberate cost/
  scope decision, not an oversight.
- Version this prompt: if the steps or schema change, bump and record it
  in `docs/agents/runners.md` (the orchestrator owns registering this as
  a scheduled routine there once pacing is decided — this prompt file is
  the contract, not the schedule).
