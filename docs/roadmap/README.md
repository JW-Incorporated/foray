# Roadmap hand-off plans (qwen / opus tagged)

Nine packages, planned 2026-09-25 against `origin/main` (`ecb6bfa3` for most; each plan states its own baseline). Each plan was written by a planning agent, checked task by task by a hand-off-safety reviewer, and revised; the file here is the revised plan, unedited.

## The founder's ask

> "spin up fable agents to make detailed plans for the rest of the roadmap. By 'detailed plans' I mean ones that we can hand off to an army of quen agents. Maybe good to also flag what we should do on opus instead of quen."

> "plan them to a very granular level, one that we can safely hand off."

— Wyatt, 2026-09-25. Out of scope by his ruling: the public store launch ("Ignore the public store launch"), and the native iOS engine milestones M2–M4, which have their own deck (`docs/native-engine-plan.md`) except where a package depends on them.

While the plans were being committed, he also said: "I think we likely have a bit too much running in parallel, computer is starting to get bogged down a bit. throttle yourself/ some agents to free up some memory here". The concurrency rule under "How to hand off" follows from that.

## The executor rule: when a task is opus, not qwen

Qwen agents are capable coders, but they must not be given judgement, ambiguity, security work, native or device work, or anything they cannot verify by running a command. A task is **opus** when it needs any of the following:

- product, UX or copy judgement, or a choice between designs;
- security, credentials, auth, RLS, or spend (keys, caps, outbound traffic to third-party hosts);
- Swift, Java or other native code, or a measurement on a device;
- a **DENIED** path in `tools/ci/path-policy.mjs`: `.github/`, `.claude/`, `CLAUDE.md`, `docs/DECISIONS.md`, `docs/adr/`, `docs/roles.md`, `backend/src/`, `tools/ci/`, `tools/release/`, the listed `tools/mobile/*` files, `mobile/**/package.json`, `Package.swift`, `*.gradle` and the other DENIED_PATTERNS. Unlisted paths such as `api/`, `index.html` and `backend/migrations/` also wait for a human merge;
- prompt or LLM design;
- a cross-cutting refactor;
- diagnosing from field records (CI logs, run reports, probe data) or curating data by hand.

Everything else is **qwen**. A qwen task has an exact change, named tests with the mutation that turns each one red, exact commands, a do-not-touch list, and stop-and-escalate conditions. If a qwen agent finds it must make a judgement call or edit a DENIED path, it stops.

## Packages

| package | plan | tasks | opus | qwen | sizes (XS / S / M) | depends on |
|---|---|---:|---:|---:|---|---|
| Player features (#762 Up Next tools, #691 tail, #30 bookmarks, #29 downloads, #761 alerts) | [player-features.md](player-features.md) | 30 | 10 | 20 | 7 / 19 / 4 | Native engine M1 as the iOS default (already true). Six plugin PRs need founder merges. Founder: push provider, download policy, privacy wording. |
| Ops and repo hygiene (shows-import red, release re-runs, #309/#312/#129/#255, flaky waits, worktree GC, #760) | [ops-hygiene.md](ops-hygiene.md) | 17 | 9 | 8 | 10 / 7 / 0 | Founder merges for `.github/` and `tools/ci/`. Founder: #129 as an Action, stranded digest, rig token, worktree cleanup. |
| Generation correctness + G-deck (#704, #706, #709, #710, #712, G-02, G-21a/b, G-37a–d, G-42b, G-20) | [generation.md](generation.md) | 29 | 23 | 6 | 8 / 20 / 1 | An Anthropic Console key (D1) for the keyed runs. `backend/src/` is DENIED, hence the opus-heavy split. Founder: D4, D7, D11, #709 tier, #712 seed-lost. |
| Corpus supply (foray-db → R2 → foray; G-03, G-10…G-16, G-19; #578, #73, #279) | [corpus.md](corpus.md) | 40 | 18 | 22 | 6 / 34 / 0 | An R2 read key, the hermes-vm tailnet host and the `foraycorpus` read-only role. Founder: export host, rights flags, probe egress, catalogue waves. |
| Bundled neural voice (Kokoro K-01…K-08, HA #45, NE-42) | [kokoro-voice.md](kokoro-voice.md) | 24 | 13 | 11 | 4 / 16 / 4 | The HA #45 phone record, the H2 audition ranking, and a phonemizer host (misaki + espeak-ng). Founder: phonemizer host, audition, minimum device. |
| Ad-inserted shows (G-40 ad-pad tier, G-41 locate step, ADR-0008 amendment) | [dai.md](dai.md) | 19 | 6 | 13 | 8 / 11 / 0 | D5 (gates only the flip). HA #24 answers. Two RSS fetches and ranged-GET probes run from the PC. |
| Shows pipeline tail + search polish (#714, #729, S-10 poller, P-04/P-07/P-09/P-10) | [shows-search.md](shows-search.md) | 18 | 9 | 9 | 5 / 12 / 1 | A fresh change-index pointer (PKG-00). The live poller waits on G1/G3 (a shows Postgres). Founder: G8, G9, P-09 loser, P-10 option. |
| Catalogue and personalization (#547 labels, breadth subjects, personas, ladders, events) | [catalogue-personalization.md](catalogue-personalization.md) | 22 | 8 | 14 | 9 / 13 / 0 | Human merges for `backend/src/` (PKG-09, PKG-18) and `docs/DECISIONS.md`. Founder: `label_scope`, breadth subjects, the intl file, the `card_shown` archetype. |
| Listener-requested Forays and sharing (#690, #71, Guideline 1.2, Path B) | [listener-forays-sharing.md](listener-forays-sharing.md) | 25 | 15 | 10 | 7 / 18 / 0 | Sharing ships on its own. The generation service is built dark until the four Path B rulings (host, spend, review gate, CSP) and a public contact address. |
| **Total** | | **224** | **111** | **113** | **64 / 150 / 10** | |

Sizes: XS under an hour, S under half a day, M under two days of agent work.

## Founder questions (deduplicated, with proposed defaults)

Every task proceeds on the default unless a ruling overrides it. Where two packages ask the same thing, it is asked once here and both packages are named.

**Credentials, hosts and spend**
1. **Anthropic key and caps** (generation D1; listener Path B spend): a Console key, not a claude.ai login, in `backend/.env` on the founder's PC, with a Console spend limit. `DAILY_BUDGET_USD=25`, `EPISODE_BUDGET_USD=10`. For listener-requested Forays: $10 per Foray, 3 requests per author per day, $50 per day overall.
2. **Where things run** (corpus Q2 export host; listener Path B host; kokoro phonemizer host; ops #760 rig): the corpus export runs weekly by cron on **hermes-vm** as `wyatt_readonly` and publishes as GitHub Releases with a pointer. The listener generation service also runs on hermes-vm. The phonemizer runs on the generation host or cloud env; until that is decided the records say "pending". The nightly judgement step moves to a rig with a fine-grained PAT (Contents + Pull requests, write, 90 days), installed only on the rig.
3. **R2 read credential** (corpus Q1): Joey issues an S3 key pair with Object Read on `foray-transcriptions`. Wyatt stores it outside the tree at `~/.foray/r2-credentials`.
4. **Outbound probes** (corpus Q4; dai DAI-08): 2-byte ranged GETs under `ForayBot`, at least 1.2 s apart per host, from hermes-vm or the PC, never at the same time as the crawler. Go.
5. **Push provider for new-episode alerts** (player): none. Use on-device background refresh plus local notifications. APNs/FCM would need keys and a feed-watching server, which is new spend.
6. **Postgres for shows** (shows-search G1/G2/G3/G8): not yet; only the live poller (PKG-10) waits on it. Storage stays `in_4a`-only until the sizing report prints bytes per row. The watchlist is N = 5,000, under 40,000 requests a week, with a daily dry-run workflow.
7. **CoreML/NNAPI spend** (kokoro K-08): deferred until the CPU numbers are in; skipped if CPU passes with at least a 25% margin.
8. **Decode-and-compare on RedCircle 5-4** (dai), and the two ~60 MB decodes per flightcast show (HA #24 Q2): not now.

**Product and publishing**
9. **Publish gates** (generation D4; listener Path B review gate): build `--hold auto` but keep `hold` as the default until two keyed Forays have passed. The draft → published flip stays a human keystroke. A listener-requested Foray is `private` (author-only); the public catalogue still needs `publish-foray`.
10. **CSP** (listener Path B): `connect-src` gains exactly the one generation-service origin.
11. **Duration tiers** (generation #709; listener length tiers): when the tape cannot fill the requested tier, produce the next shorter tier and say so in `tierDecision`. Offer short (~15 min) and medium (~1 hr) at launch; hide long (up to 3 hr) until a keyed run's cost is measured.
12. **Seed-lost-only seams** (generation #712): they count as verified; `seedLostBeats` and `seedLostPages` stay visible.
13. **F-58 spoken-line rules** (generation D7): warn only.
14. **Bench key in Actions** (generation D11): no key. The host runs the bench; Actions only compares.
15. **Ad pad before the locate step** (dai D5/OQ2): yes; flip `AD_PAD_SHIPPED` once the probe data is on main. For the locate step, ASR comes before Chromaprint. Margin = observed spread, N = 2, ceiling 120 s. DAI shows play in the app and are skipped on the web. Locate prefetch runs on Wi-Fi only.
16. **ADR-0008 amendment** (dai, HA #24): amend. Distrust the ranged GET on the flightcast hosts only. Around the House stays `unknown`.
17. **Download policy** (player): manual, per episode, Wi-Fi only (cellular switch off), a 2 GB cap with LRU eviction that never evicts an episode in progress, and no prefetch.
18. **Continuous-playback tail** (player): every third tail pick is the stretch subject. The existing switch turns off the whole chain.
19. **Bookmarks** (player): stay on the device and log no new event type.
20. **Alerts per followed show** (player): on when you follow, with a per-show switch.
21. **Android player** (player): stays on the JS player. **Kokoro on Android** (kokoro): ships with iOS.
22. **Voice audition** (kokoro): an opus agent renders the clips to a private release, the founders rank them, and the three winners are bundled. Lexicon IPA stays with espeak's guesses except for terms the founders flag. If the oldest phone fails RTF ≤ 1.5, ship with a minimum-device line. HA #45: re-run once on the next build. The picker heading is unchanged.
23. **Family Mode, unrated episodes** (catalogue Q1): confirm the rule #835 shipped (unrated inherits the show's rating, else hidden; comedy hidden).
24. **`label_scope: "general"`** (catalogue Q2): yes. Generators refuse to inherit a general show's label, and the nightly requires per-episode topics for those shows.
25. **Breadth shows get subjects** (catalogue Q3): yes, for confidence other than low and not `needs_review`.
26. **Delete `data/catalog-breadth-intl.json.gz`** (catalogue Q4): yes.
27. **#217 Gershwin jazz tag** (catalogue Q5): re-measure, and tag only if "the history of jazz" keeps 3 results.
28. **`card_shown` archetype** (catalogue Q6): add `"top"` to `ArchetypeSlotSchema`.
29. **`fusion-101` ladder** (catalogue Q7): stays draft until the relabel pass lands.
30. **Search ranking** (shows-search): P-09: inside a match tier, unranked curated shows may sort below ranked curated shows, never below breadth. P-10: accept (option 3) unless coverage is at least 80% and `daily` would lead with no regressions. P-04: keep the `chart_rank ≤ 100` cut. P-07: the listening test runs on the next TestFlight build. The new `db` CI job is not a required check yet.
31. **Rights flags** (corpus Q3): shows with `itunes:block` or `podcast:locked` are excluded from the app catalogue and from sourcing. Apple-sourced bodies are used.
32. **Catalogue waves** (corpus Q5, #279 drinks and #73 true crime/computing): agents prepare candidate PRs, and the PR is the founder's review.
33. **Sharing** (listener): links use the Pages origin `https://jw-incorporated.github.io/foray/`. Build all four Guideline 1.2 pieces before the Foray option is enabled for anyone but the founders. Blocking abusive users is operator-side only. A JW Labs LLC mailbox is the public contact address.

**Legal wording**
34. **Privacy-policy sentences** (player bookmarks/downloads/alerts; listener share/report; catalogue personas/`card_shown`/observed events): each package files its sentences for one `[DECIDE]` approval. The exact wording is in each plan.

**Repo and machine**
35. **Worktree cleanup** (ops Q4): remove the ~208 worktrees whose PR merged, and their branches. Prune the stale `%TEMP%` entries and delete the 47 stray files under `.claude/worktrees/`. Keep anything dirty and every branch that has no PR. A dry-run listing comes first.
36. **Stranded 2026-09-14 nightly digest** (ops Q2): drop it.
37. **#129 merge audit** (ops Q1): a keyless weekly GitHub Action that comments on #129, not a Cloud routine.
38. **Concurrency** (dai Q8, and the founder's message above): one local agent at a time until the founder says otherwise.

## Things the plans do not know about each other (read before dispatching)

Each plan was written on its own, so an opus dispatcher must reconcile these overlaps:

- **HUMAN-ACTIONS ids collide.** Several plans hard-code the "next free" id (#117, #119, #120, #121, #119–#124). Main already uses #117 and #118. **Ignore the numbers in the plans.** Re-derive the next free id when each task starts (the command is in shows-search's conventions block) and cite items by title.
- **The shows-import repair is in two packages.** ops OPS-01…03 and shows-search PKG-00 both fix the failing `shows-import.yml` run. Run OPS-01/OPS-02. PKG-00 is satisfied once the pointer is fresh; shows-search PKG-07 waits on it.
- **`tools/build-catalog-client.mjs` and the `test/show-page.test.js` exact-key pin** are edited by catalogue PKG-02 (`label_scope`) and shows-search PKG-11b (`chart_rank`). Run them one after the other. Whichever lands second also adds its field to `expectedKeys`.
- **Ad-pad data is modelled twice.** corpus PKG-16…22 (`data/dai-measurements.json`, `ad_pad_sec` on minted rows, a check-forays ceiling rule) overlaps dai DAI-02…09 (`data/ad-pad-probes.json`, stamped `ad_*` on segment-sources, check-forays `ad_*` invariants). Land the dai package's check-forays and hydration tasks first. An opus reviewer then rescopes corpus PKG-19…22 onto the same fields before they are dispatched.
- **`app.js` is shared** by player-features, catalogue-personalization, listener-forays-sharing, kokoro-voice (KV-09/10) and dai (DAI-07b via `player/client.js`). Across packages, only one `app.js` task is in flight at a time, and each one rebases on the last merge.
- **Legal counts are pinned.** `test/legal-citations.test.js` pins the privacy-policy and data-safety event-type totals, and `test/data-deletion.test.js` pins the `cp_` key-family count. Tasks that add a `logEvent` type or a `cp_` key are in player, catalogue and listener, and they must run one at a time. Each one recomputes the totals from the test's failure message, not from the number written in its plan.
- **`backend/src/cli/generateForays.ts`** is edited by generation GEN-07/14/18, listener PH2-07/16 and corpus PKG-23/24. Serialize those edits.
- **Suite floors.** Almost every code task adds or raises a line in `test/suite-integrity.test.js`. The conflicts are one line each; rebase and keep both lines.

## Suggested overall order

1. **Free the machine and turn CI green first.** ops OPS-12 → OPS-13 (worktree GC, founder Q35), OPS-01 → OPS-02 (shows-import), OPS-05/06, OPS-04.
2. **The critical path to a keyed Foray.** generation GEN-01…06 (qwen, allowed lanes) with GEN-07/08/10/11–14 (opus); founder D1 → GEN-23 → key placed → GEN-16 → GEN-17 → GEN-18 → GEN-26.
3. **Small, independent, testable wins.** dai DAI-01…11 in its listed serial order. catalogue wave 1 (PKG-01, 08, 02, 17, 11, 12). listener share stream PH2-01…05.
4. **Player features wave 1** (pure modules PQ-01/03/05/09/10/12/16/25), then the serial `app.js` chain. **kokoro-voice** KV-01…07 and KV-17 alongside, since they touch disjoint files.
5. **Corpus scaffolding** PKG-01…09 and PKG-11…14 (qwen), then the opus field runs once the credentials exist.
6. **Shows-search** PKG-01/03/05/11a/11b/12, then the governed halves (PKG-02/04), the poller dry-run (PKG-06…09) and the ranking rule (PKG-13).
7. **Gated work last:** player native plugins (Wave 4 founder merges), kokoro native chains after HA #45, listener Path B service/client after the four rulings, corpus topic assignment and catalogue waves, and catalogue event plumbing (PKG-18/19).

Within each package, follow the plan's own §4 sequencing; it names which tasks share files.

## How to hand off

- **One task per Qwen agent.** Dispatch only tasks tagged `qwen`; opus tasks go to an Opus agent.
- **The task section is the whole prompt.** Give the agent the full `### <ID> · …` section, plus the package's conventions block (every plan has one, near its task table: worktree command, never commit `deploy-manifest.json` / `data/forays-directory.json`, `sw.js` `BUILD_ID` stays `"unstamped"`, new suites get a floor, Foray fixtures come from `tools/foray/fixtures/frozen/`, one test process at a time, commit trailers). Give it nothing else.
- **Line numbers are hints.** Every agent re-locates each cited symbol on `origin/main` with `git grep` / `git show` before editing. A symbol that is missing is a stop condition.
- **PRs open as DRAFT.** Agents never apply `founder-approved`, `hold` or any other label, and never merge.
- **An Opus reviewer merges.** An Opus agent reads each draft against its task section: the named tests exist, each named mutation was run and went red, nothing in the do-not-touch list changed. Then it marks the PR ready and merges when CI is green. Anything on a DENIED or human-merge path waits for the founder.
- **Concurrency.** Until the founder lifts it, run one local agent at a time on the founder's box (CI-only work may overlap). When the cap lifts, a package's own §4 cap still applies (some allow two or three), and the cross-package rules above always apply.
