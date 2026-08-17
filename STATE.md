# STATE.md — active workstream announcements

New file (2026-08-12). Cross-session coordination board: any session running in
this repo announces long-running workstreams here so other sessions can route
around them on their next recon pass. Keep entries short; full plans live in
docs/. Completed workstreams move to their plan doc's retro section.

## Active workstreams

### Foray #2 authoring — the types of capital available to startups (2026-08-16, one PR, no follow-up)

- **What:** `feat/foray2-capital`. Foray #2 authored end to end: **22 segments,
  51:22**, eight arc slots, eight episodes, `capital-types-1` in
  `data/forays.json` with `status: "draft"`. Write-up:
  `docs/curation/foray2-capital.md`.
- **Owned files:** `data/segments.json` (+26, pool now 62),
  `data/segment-sources.json` (+8, now 17), `data/forays.json` (+1 Foray),
  `docs/curation/foray2-capital.md` (new),
  `tools/foray/check-forays.test.mjs`. **Out of scope:**
  `data/breadth-classification.json` and `data/genre-taxonomy-map.json` (PR
  #198 owns those), anything under `player/`, `app.js`, `styles.css`.
- **Two findings other sessions need.**
  (1) **`findAnchorOccurrences()` returns the CUE's span, not the anchor's** —
  `buildTranscriptIndex()` stamps every token with its cue's start/end. Taking
  its return value as a segment boundary ends segments mid-sentence; nine of
  this batch's sixteen ASR segments did until it was fixed against the word
  stream. **Foray #1 went through the same helper and should be re-checked.**
  `docs/curation/foray2-capital.md` §4.
  (2) **The Full Ratchet injects ads mid-roll**, confirmed from our own audio
  (identical ~26.5 s Ramp pre-roll on four 2014 episodes, and a second read at
  ~1,786 s of ep 235). Four already-transcribed episodes — 17, 18, 40, 235,
  2 h 55 m — are therefore authorable but **not playable**, and the arc lost its
  taxonomy spine and its corporate-VC slot. Do not queue a feed for ASR on a
  PADDABLE tier alone; PADDABLE means authorable. §6.1.
- **Heads-up — the six Foray-#1 snapshot tests in
  `tools/foray/check-forays.test.mjs` are now generalised** (per-Foray pins
  instead of whole-file counts). A third Foray should not need to touch that
  file.

### Foray UI #3 — the seam beat, and the strip becomes a scrubber (2026-08-16, one PR, no follow-up)

- **What:** `feat/foray-seams`. (1) **The seam silence.** Foray #1 has no
  narration, so all 31 of its transitions were butt-cuts — one voice stopping
  mid-room-tone and another starting on the same sample. Every unbridged
  segment-to-segment seam now gets **2.0 s** of silence
  (`docs/curation/segment-length-rules.md` §6b / §2e, the audiobook
  section-break convention). (2) **The strip is a scrubber**: a click on it is a
  position in the hour, cold or playing — `foraySeek` was implemented, tested
  and called by nothing. (3) **The live bar fills** as its segment plays, which
  is also how the beat becomes visible.
- **New files:** `player/seam-gap.js` + test (the pure "is this a seam, and how
  long" rule).
- **Shared files it touches:** `player/queue-manager.js` (the beat's clock),
  `player/client.js` (`gap` in the snapshot, `segmentAt` on the bridge),
  `app.js`, `styles.css`, `player/queue-manager.test.js`,
  `player/foray-playback.test.js`, `test/suite-integrity.test.js` (one new
  floor, two raised), `HUMAN-ACTIONS.md` (#3), `docs/ux/README.md`,
  `docs/curation/segment-length-rules.md` §10, this file. **Nothing in `data/`,
  nothing in `tools/`, nothing in `index.html`, nothing in `sw.js`** — no cache
  bump is needed, the shell is unchanged. Foray #1 stays `status: "draft"`.
- **`player/queue-state.js` IS UNCHANGED, on purpose.** The beat is a timer, and
  the reducer models no timers (same reason the 15 s position timer lives in the
  manager). No new state, no new event, no further damage to the "diffable by
  eye against the Swift" promise.
- **Heads-up — the beat has a clock, and tests must inject it.** Any suite that
  constructs `PlayerQueueManager` and drives an auto-advance will otherwise wait
  a real 2.0 s per seam. Pass `scheduler` (`{ nowMs, schedule }`) — both suites
  above have an `INSTANT_SCHEDULER` and a `manualScheduler()` to copy. Do NOT
  assert on wall clock; #195 already cost this repo that lesson.
- **Heads-up — a fake `load()` that resolves synchronously hides real bugs.**
  Reviewing this PR found one that way: cutting a beat used to resolve the
  waiting load's supersession check immediately, which against any load that
  takes real time armed an out-point the replacement `load()` then cleared,
  leaving a segment playing to the end of its whole source episode. Fixed
  (`_transport` releases a parked wait only after the action's own effects are
  done, so `_loadSeq` has moved if it was going to), and pinned by tests using
  an `AsyncLoadBackend` whose `load` resolves a few microtasks later. **If you
  add a player test about ordering, use that backend, not the synchronous
  one.** The `INSTANT_SCHEDULER`s now use `queueMicrotask` for the same reason.
- **Heads-up — `manager.inSeamGap` is a fourth play state.** `isPlaying()` is
  false during a beat (it is structurally `loadingItem`), so every play/pause
  control in `player/client.js` goes through `isRunning()` instead. A control
  that branches on `isPlaying()` will say "Pause" and start audio. There is
  also an `onSeamGapChange` hook, and it is not optional for a surface: a beat
  fires no media events, so without it nothing repaints for the whole 2 s.
- **Heads-up — the strip's DOM changed shape.** `.fy-seg` now contains
  `<i class="fy-seg-fill">`, and a click on `#fy-strip` with `clientX` is a
  seek, not a segment jump. A coordinate-less click still falls back to the
  segment. `.fy-seg.is-played` / `.is-playing` moved from `background` to
  `border-color`; the fill carries the colour now.
- **Heads-up — the two silence specs still disagree.** `04_VOICE_AUDIO_SPEC.md`
  line 12 says 0.5 s (padding around a TTS item); `segment-length-rules.md` §6b
  says ≥ 2.0 s (marking an edit). The player implements 2.0 s. Reconciling the
  documents is a founder call and is `HUMAN-ACTIONS.md` #3 — do not quietly pick
  one while doing something else.
- **Not built, on purpose:** narration bridges (no audio exists), the mockup's
  peek/expand running order, per-show colour, cover art, and anything with a new
  empty screen behind it. A library screen stays premature — one Foray exists
  and it is a draft.
- **Related:** #111, #128, #133, #65.

### Foray UI #2 — resume, feedback, credit (2026-08-16, one PR, no follow-up)

- **What:** `feat/foray-ui-2`. Three features from `docs/ux/foray-mockup.jsx`,
  built as design *intent* in the vanilla stack (no React, no deps, no fonts —
  the ruling in `docs/ux/README.md` is unchanged and this does not port that
  file). (1) **Resume across sessions**: closing the tab 20 minutes into Foray #1
  no longer costs the hour — the Foray's own clock is stored per Foray, the page
  opens on it, and the home screen gets the mockup's "Jump back in" rail.
  (2) **Per-segment thumbs** with the mockup's asymmetry: up is one tap, down
  opens the reason sheet and only commits on submit. This is the first `thumbs`
  event the client has ever emitted — the shape is
  `docs/curation/events-client-integration-spec.md` §2's, not a new one.
  (3) **"Where this came from"**: the publisher credit block per Foray.
- **New files:** `player/foray-progress.js` + test (the resume store, pure),
  `player/foray-sources.js` + test (the credit grouping and the show link, pure).
- **Shared files it touches:** `app.js`, `styles.css`, `player/client.js`,
  `player/foray-playback.test.js` (six resume tests against the real Foray),
  `test/suite-integrity.test.js` (two floors, isolated final commit),
  `docs/ux/README.md`, this file. **Nothing in `data/`, nothing in `tools/`,
  nothing in `index.html`.** Foray #1 stays `status: "draft"`.
- **Heads-up — the running order's DOM changed shape.** `.fy-row` used to BE the
  play button; a thumb inside a button is invalid HTML, so the row is now a
  container and `.fy-jump` is the button. `data-fy` and the `is-playing` /
  `is-played` classes moved with it. Anything keying on `.fy-row.is-playing`
  needs `.fy-jump.is-playing`.
- **Heads-up — a stored position is NOT an unlock.** The home rail is gated
  through the same `listableForays` rule as everything else, so a draft's
  progress is remembered and simply not advertised without `?foray=` in the URL.
  Do not "fix" that; it is the leak `player/foray-resolve.js` closed on purpose.
- **Heads-up — the Foray page now has an interactivity test, and it is load
  bearing.** `player/foray-playback.test.js` mounts `app.js` in a `node:vm`
  against a small binding harness and asserts the transport RESPONDS, not just
  that the page renders. It exists because a `ReferenceError` in one binder threw
  before `bindForayTransport` and left the whole page inert while every suite
  stayed green and `node --check` passed. If you add a binder to `renderForay`,
  add it to that harness's selector vocabulary or the test stops covering it.
- **Timing convention for `player/html-audio-backend.test.js`** — the only suite
  in the root group on a real clock. It flaked once in four runs while a
  transcription job saturated all 16 cores: two hard-coded precision budgets
  (50 ms and 100 ms out-point overshoot) are claims about the SCHEDULER, and a
  starved scheduler is late by more than that. Reproduced deliberately — the
  pre-fix file fails exactly those two under 16-core load, the fixed one passes.
  The budget is now **a fraction of the tick interval the run actually
  delivered**, which is the naive `if (currentTime >= end)` cost measured under
  the same load, so both sides stretch together. **Do not re-hardcode a
  millisecond budget here, and do not compare against the NOMINAL tick** — a
  first attempt added measured jitter to a 50 ms constant and capped it at the
  250 ms nominal interval, but a genuinely broken fine watch measures 90–133 ms,
  which fits inside the budget a loaded box produces. It would have passed a real
  regression. Any precision assertion here has to be relative to a cost measured
  in the same run.
- **Not built, on purpose:** `CreateScreen` (on-demand Forays), narrator bridges
  (no audio exists), generated cover art, and the full `ShowScreen` (no
  description or follower data exists for four of the five shows).
- **Related:** #128, #133, #111, #65.

### Foray UI — Foray #1 plays in the browser (2026-08-16, one PR, no follow-up)

- **What:** `feat/foray-ui`, issues #128 / #133 / #111. The web app gets a Foray
  surface: the 32-segment running order rendered slot by slot with show,
  length and why-line, a transport (play/pause, previous/next segment, elapsed
  across the WHOLE Foray), click-to-jump, and the played/playing state on every
  row. `app.js` now loads `data/forays.json`, `data/segments.json` and
  `data/segment-sources.json`, and survives any of them 404ing.
- **Open it at:** `https://jw-incorporated.github.io/foray/?foray=grilling-history-1`
  — Foray #1 is `status: "draft"`, so it is NOT listed for an ordinary visitor
  and nothing here publishes it (that stays HUMAN-ACTIONS.md #2). `?foray=<id>`
  is the keyless way in: it unlocks that one id for that one page load, is not
  persisted, and after the first render the route is the ordinary
  `#/foray/<id>`.
- **New files:** `player/foray-resolve.js` (the pure forays+segments+sources
  join, the draft rule and the position maths), `player/foray-resolve.test.js`,
  `player/foray-playback.test.js` (Foray #1 end to end against a fake backend
  and the REAL data files).
- **Shared files it touches:** `app.js`, `styles.css`, `player/client.js`,
  `test/suite-integrity.test.js` (two floors, isolated final commit), this file.
  **Nothing in `data/`, nothing in `tools/`, nothing in `index.html`** — the CSP,
  the script tags and the service worker are unchanged.
- **Heads-up:** `player/client.js`'s "Open episode" link was class `fp-open`,
  which `<body>` also carries while the mini-player is up — so that rule was
  colouring every uncoloured element on the page accent-blue by inheritance. It
  is `fp-openep` now. Cosmetic, but it was real and it is fixed here.
- **Not verified:** actual audio. Every podcast CDN in the source registry was
  unreachable from the machine this was built on, so playback is proven against
  a fake backend (32 segments, in order, each at its own in-point, each stopping
  at its own out-point) and by the real UI driving the real manager — not by ear.

### Foray #2 sourcing — types of capital & startup funding (2026-08-16, one docs PR, no follow-up)

- **What:** `docs/foray2-capital-sourcing`. Sourcing and a work order only —
  **nothing was transcribed and no audio was downloaded.**
  `docs/curation/foray2-capital-sourcing.md` (the shortlist, 16 arc slots) and
  `docs/curation/foray2-asr-manifest.json` (35 episodes, 18.95 h, **17.23
  CPU-hours** at 1.1x; priority 1 alone is 9 episodes / 6.37 h / **5.79
  CPU-hours**).
- **Owned files:** those two, plus this entry. **Touched nothing** in `data/`,
  `player/`, `app.js`, `tools/` or `backend/`.
- **Three findings other sourcing passes should reuse:**
  1. **The 20% relative cap bites hard on short shows, and it is easy to miss.**
     VC Minute (`rss.buzzsprout.com/1970319.rss`) looked like the find of the
     pass: 275 episodes of 60–290 s, **24 probed at ratio 1.0000** (N=2), all
     shipping timed **VTT + SRT + JSON** with speaker labels, zero ASR. But
     `segment-length-rules.md` §0 caps a segment at ≤ 20% of its source, so
     **10 of those 24 cap out below the 30 s hard floor and can yield no
     compliant segment at all**, and the other 14 top out at 30–51 s — `quote`
     tier, never the 75–180 s band. With D4's quote budget that is **≤ 7
     segments, ~5 min of an hour.** If you are sourcing sub-10-minute shows,
     compute `0.2 × duration` before you count the hours.
  2. **NCI's SBIR Innovation Lab is dead audio and it does not look dead.** 16
     agency-published SRTs that fetch 200 and read cleanly; **every enclosure
     tested 404s** — 3 of its 26 episodes, each × 3 URL shapes × 2 UAs, against a
     same-host Libsyn control returning 206. BBQ Nation again, except a
     transcript-availability screen would have admitted it. **Fetch one enclosure
     before believing a feed.**
  3. **Per-episode ad deltas, not per-show.** The Full Ratchet's Libsyn insert
     measures 12.4 s, 22.8 s, 29.3 s and **136.7 s** across 14 episodes of one
     feed — `summariseShow()`'s median would have been wrong for every row. Three
     prefix chains injected nothing on the episodes measured:
     `2.gum.fm→op3.dev→pdcn.co→pdst.fm→podtrac` (Bootstrapped Founder),
     `pscrb.fm` (Capital Allocators), `prfx.byspotify.com` (Startups For the Rest
     of Us).
- **Related:** ADR-0008 (the rule applied), `docs/curation/segment-length-rules.md`
  (the 75–180 s band and the relative cap above), `docs/curation/grilling-foray.md`
  (the 12% yield this was sized against).

### Foray data layer — the running order becomes data (2026-08-16, one PR, no follow-up)

- **What:** `feat/foray-data`, issues #182 and #134. Foray #1's 32-segment
  running order moves out of the markdown table in
  `docs/curation/grilling-foray.md` §2 and into **`data/forays.json`**
  (`kind: deep-dive`, ordered `items`, segment ids not inlined timestamps). The
  nine source episodes get **`data/segment-sources.json`** so a segment's
  timestamps resolve to audio — deliberately NOT `data/discover.json`, which is
  machine-owned and is the recommendation pool. `tools/foray/check-forays.mjs`
  makes the tier-A ordering rules (D1, D2, D3, D4, D5, M3, M4) fail CI.
- **Owned directories:** `tools/foray/`. **Owned files:** `data/forays.json`,
  `data/segment-sources.json`.
- **Shared files it touches:** `test/suite-integrity.test.js` (one new floor,
  in its own final commit so a rebase is trivial),
  `docs/curation/grilling-foray.md`, this file. **Nothing under `player/`.**
- **Heads-up for the player/UI track:** `data/forays.json` is `status: "draft"`
  and must not be surfaced until a founder flips it, same rule as ladders.
  Neither new file is fetched by `app.js` yet, and `snapshot()`'s whitelist
  drops anything it does not name — see the PR body for the short list of what
  a client still has to add.
- **Related:** #128, #133, #111, #65.

### merge mechanics — near-zero founder merges (2026-08-16, one PR, no follow-up)

- **What:** `ci/zero-founder-merges`. The path allow/deny policy moves out of
  `.github/workflows/automerge-nightly.yml` into `tools/ci/path-policy.mjs`
  (tested), `backend/test/` is allowlisted while `backend/src/` and `tools/ci/`
  are denied, `enable-automerge` is renamed `automerge-decision` and now reports
  ARMED / NOT ARMED with the reason, a new `pr-hygiene` workflow auto-updates
  behind PRs and labels + comments-once on conflicts, and `HUMAN-ACTIONS.md`
  now exists as the batched "waiting on you" list.
- **Owned files:** `.github/workflows/*`, `tools/ci/path-policy*`,
  `tools/ci/pr-triage*`, `HUMAN-ACTIONS.md`.
- **Shared files it touches:** `test/suite-integrity.test.js` (two new floors),
  `docs/roles.md` (merge-authority section), this file.
- **Heads-up:** `HUMAN-ACTIONS.md` is now auto-merge-allowlisted, so filing an
  owner action no longer costs a founder merge. The generated block in it is
  owned by `node tools/ci/pr-triage.mjs waiting --write` — do not hand-edit
  between its markers.
- **Status:** PR open, not merged. `path-policy` ships report-only; making it
  block is Wyatt's call (HUMAN-ACTIONS.md #1).

### transcription — self-hosted ASR feasibility (Wyatt's Claude, started 2026-08-11)

- **What:** the T-packages of epic #115 — can we transcribe episodes ourselves,
  and is the output good enough to anchor segments?
- **Status:** **T1 (#116) is measured and answered** — the environment installs
  clean, word timestamps are exact, and throughput is **1.33x realtime for
  `base.en`** / 0.53x for `small.en` / ~0.15x for `medium.en`, at only ~2.4
  effective threads of 16. That makes a ~20-episode pilot a weekend and the
  406-episode curated non-DAI pool ~308 hours, i.e. **not feasible on a laptop**
  — so **T7 (#118, GPU host) is a prerequisite for scale, not an optimisation.**
  T2 (#117, WER + timestamp drift) is next; **T4/T5 stay on hold until it
  reports.**
- **Branch prefix:** `spike/*`, `feat/t*` — PRs only.
- **Owned directories:** `tools/transcribe/`.
- **Shared files it touches:** `STATE.md` (this entry) — note that STATE.md is
  in neither the auto-merge ALLOWED nor DENIED list, so a PR touching it waits
  for a human.
- **Heads-up for other sessions — this one is physical, not just a merge
  conflict:** a whisper run pins this laptop for tens of minutes and **two
  concurrent runs starve each other** (measured: 0.23 effective threads each,
  neither finishing). Anything CPU-heavy running alongside a run also
  invalidates its timing numbers — this cost several hours of remeasurement.
  Check for a live `python.exe` running `bench.py` before starting long local
  jobs.
- **Related:** epic #115, ADR-0004 (transcript acquisition ladder), ADR-0007
  (segment anchoring).

### sourcing policy — the ad gate is GONE (2026-08-16, one docs PR, no follow-up)

- **Read this if you are doing any sourcing pass.** Wyatt ruled 2026-08-16 that
  *"ads should not be a blocking issue as long as we can find the approximate
  right timestamp."* **Do not reject a show on ad ratio.** New rule in
  `docs/adr/0008-ad-tolerance-and-timestamp-precision.md`: measure the delta in
  **seconds**, over **N ≥ 2 probes of the SAME episode**, and take the max. The pad
  is `delta_max + margin` — an **upper bound, never a point estimate**. The pad
  controls only the STOP: a pad smaller than the listener's ad load stops early and
  **truncates the segment**; a generous one just adds tail. Admit if
  `pad ≤ 120 s` — which in practice means **well under 120 s of raw delta** (Gastropod's
  66 s delta already produces a 100 s pad). Above that, author the segment now (anchors are durable per
  ADR-0007) and play it once the anchor-resolution rung exists.
  `AD_FREE_THRESHOLD = 1.01` is a label, not a verdict.
- **Measured, and it is why N ≥ 2 is mandatory:** two probes of one Gastropod
  episode, hours apart from the same client, differed by **33.4 s** (+66.1 / +32.7).
  The delta is a property of the *request*, not the episode. **No episode in this repo
  has ever been probed twice**, so no recorded ratio bounds this — and the recorded
  ratios are medians across *different* episodes, which is a different axis again.
- **Second ruling, same day:** a narrator (our script, ElevenLabs audio) will
  cover what no podcast does — braai, Filipino lechon — and is sanctioned in
  principle, but *"let's wait before we deliver that feature."* **Design only.
  Build nothing, add no dependency, spend nothing.** Recorded on #107; #64/#66/#174
  are where the design lives.
- **Branch:** `docs/ad-tolerance-and-narrator` — docs only, and it **waits for a
  founder** because `docs/adr/` and `docs/DECISIONS.md` are auto-merge DENIED.
- **Owned files:** `docs/adr/0008-*`, `docs/DECISIONS.md`, plus superseded-notes
  in `docs/curation/grilling-foray-sourcing.md` and
  `docs/curation/catalogue-broadening.md`. Touched nothing in `data/`.

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
