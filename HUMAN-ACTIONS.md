# HUMAN-ACTIONS.md — anything only a founder can do

The one place owner actions live (PR #171). If a session finds something that
needs Joey's or Wyatt's identity, login, payment method, approval, or a click in
a UI an agent cannot reach, it goes here the moment it is identified — never in
a chat message, never in a variant filename.

**How to use it.** Each item has a `**Status:** OPEN` line. Change that one word
to `DONE`, `SKIP` (add a few words why) or `BLOCKED` (tried, something stopped
you). Do not cut, paste or move the block — the next session that opens this
file files it for you, keeping its number. Item numbers are stable IDs: never
reused, never renumbered, so "#1" means the same thing forever, including after
it is filed under `DONE`.

---

## OPEN

### 1. Decide whether `path-policy` should block, and make it required

**Tag:** `[UPGRADE]` · **Time:** ~3 minutes · **Owner:** Wyatt

**Why it matters.** The allow/deny path list used to live inside the auto-merge
workflow, so it governed only what GitHub Actions did. On 2026-08-16 two PRs
were merged from a laptop with `gh pr merge` and a founder token and went
straight past it — not by defeating the deny-list, but because on that route
there was nothing to defeat. The policy is now one tested module
(`tools/ci/path-policy.mjs`) reported as a status check named `path-policy` on
every PR. Today it is **report-only**: it says loudly in the PR's checks when a
PR touches a governed path (`.github/`, `CLAUDE.md`, `docs/adr/`, `docs/roles.md`,
`backend/src/`, `tools/ci/`) without a founder's `founder-approved` label, but it
stays green. These two steps make it actually block.

**Read this before doing it — it is a real trade, not a formality.**

- What you gain: both merge routes answer to the same rule, and every PR that
  touches a governed path says so on its own face instead of only in a workflow
  log nobody opens.
- What you do **not** gain, stated plainly because an earlier draft of this
  entry got it wrong: applying `founder-approved` makes the *check* green, it
  does **not** auto-merge the PR. You still click merge. Letting a label
  auto-merge a change to `.github/` or `CLAUDE.md` would be more dangerous than
  requiring the click, and nobody has decided that — if you want that trade,
  say so and it can be built, but it should not arrive as a side effect.
- What you do NOT gain: this is not a lock. You both have admin, and an admin
  can override a required check — that is supported and sometimes correct.
  Bluntly: the check is satisfied by a label, and an agent with write access to
  this repo can apply a label. So it is a guardrail against accidents and a
  record of intent, not a wall against a determined agent.
- The recommendation from the session that built it: **do it.** The honest
  version of this check, used consistently, is worth more than an absolute block
  nobody can operate. If you later want a signal an agent genuinely cannot
  produce, the next step is CODEOWNERS review from a founders-only team — a
  bigger change, and worth its own decision.

**Step 1 is already done.** `PATH_POLICY_ENFORCE=1` was set on 2026-08-16, so the
check now fails loudly on a governed path. Only step 2 — making it *required* —
is outstanding, and it is deliberately parked. Read the prerequisite first.

> **PREREQUISITE, added 2026-08-16: let one nightly refresh PR pass through
> `path-policy` first.**
>
> `path-policy` went live at 17:11Z. The most recent nightly content PR merged
> on 2026-08-14, so **no bot-authored PR has ever been through this check.** That
> matters more than it sounds, because of what "required" changes:
>
> - Today, if the workflows do not run on a PR, the consequence is that
>   auto-merge never arms and the PR waits. Annoying, recoverable.
> - Once required, the same silence means the PR **can never merge at all** —
>   and `protect-main` has **zero bypass actors**, so not even a founder can
>   click through it without editing the ruleset.
>
> This is not hypothetical. On 2026-08-16, PR #192 sat with **no CI checks at
> all** for hours because it was conflicting with `main`; nothing ran and nothing
> said why. Had `path-policy` been required, the nightly content pipeline could
> have stalled the same way overnight with no way through.
>
> **Do this after the next nightly refresh PR (≈11:45 UTC) shows a green
> `path-policy` in its checks.** That is the evidence that bot PRs get the check
> at all. One observation is enough.

**Steps.**

1. ~~Turn on enforcement~~ — **done 2026-08-16.** For reference:

   ```
   gh variable set PATH_POLICY_ENFORCE --repo JW-Incorporated/foray --body 1
   ```

   To turn it back off at any time: `gh variable delete PATH_POLICY_ENFORCE --repo JW-Incorporated/foray`

2. Add `path-policy` to the required checks on `main`. Click path:
   **github.com/JW-Incorporated/foray** → **Settings** → **Rules** → **Rulesets**
   → **protect-main** → **Require status checks to pass** → **Add checks** →
   type `path-policy` → select it → **Save changes**.

   The existing required checks are `backend` and `data-and-site`; leave both.
   Leave **Require branches to be up to date before merging** OFF — it is off
   today, and turning it on would re-block PRs every time `main` moves.

**Worked if:** open any PR that edits a file under `.github/`. Its checks list
shows `path-policy` **failing** with "GOVERNED PATHS — NOT APPROVED (blocking)",
and the merge button is disabled. Add the `founder-approved` label to that PR;
within about a minute `path-policy` re-runs by itself (no push needed) and goes
green.

**Status:** OPEN

### 2. Listen to Foray #1 end to end, then decide whether to publish it

**Tag:** `[BLOCKING]` · **Time:** ~65 minutes of listening + 1 minute of edit · **Owner:** Joey

**Why it matters.** Foray #1 — the 61-minute history of grilling — is now real
data (`data/forays.json`, issue #182), and every number about it is a property
of timestamps and transcripts. **Nobody has heard it.** It is committed as
`"status": "draft"`, which by the same rule that governs ladders means no client
may ever surface it. Only a founder flips that. `docs/curation/segment-length-rules.md`
§10 is explicit that the listening is the experiment that should move the
pacing numbers, and §9 of `docs/curation/grilling-foray.md` says the first
person to listen will find things no rule caught.

Two known defects to listen for specifically, both recorded in
`docs/curation/grilling-foray.md` §4:

- **TAV-3** and **MOSS-4** open mid-clause — a listener hears a fragment for the
  first second or two.
- **TAV-2** opens *"Mrs Glass is famous for one other thing"* and the actual
  claim arrives about 4 s in, at the edge of what the rules allow.

There are **no narration bridges yet**, so nothing explains who is speaking or
why the subject moved. Expect that; it is the next workstream, not a defect in
this one. What each of the 31 transitions now has instead is **2.0 s of
silence** — the audiobook section-break beat, added because an instant cut from
one room to another reads as a glitch rather than as an edit. Judge that beat
while you listen: 2.0 s is a convention, not a measurement, and yours is the
first pair of ears on it. If it feels long, or too short, say so — it is one
number (`SEAM_GAP_SEC` in `player/seam-gap.js`) and item #3 below is the
decision that owns it.

**Steps.**

1. Read the running order: `docs/curation/grilling-foray.md` §2 (32 rows, in
   listening order, with what each one contributes).
2. Listen. **There is a player now** — #111 / #128 / #133 landed, so this is no
   longer a manual pass with a podcast app and a list of timestamps. Open:

   ```
   https://jw-incorporated.github.io/foray/?foray=grilling-history-1
   ```

   That link is the keyless way into the draft: it unlocks this one Foray for
   that one page load, is not persisted, and does not publish anything. Press
   **Play** and it runs all 32 segments in order, each starting and stopping at
   its own timestamp, with the 2.0 s beat between them. The strip along the top
   is a scrubber — click anywhere in it to jump to that point in the hour — and
   it remembers where you stopped, so this does not have to be one sitting.

   (The fallback still works if the page will not load: every source episode's
   audio URL is in `data/segment-sources.json` (`sources[].audio_url`) and each
   segment's in and out points are `start_sec` / `end_sec` in
   `data/segments.json`.)
3. Decide. If it holds together, change **one word** in `data/forays.json`:

   ```
   "status": "draft"     ->     "status": "published"
   ```

   in the `"grilling-history-1"` block, and open a PR with it. If it does not,
   say what was wrong and leave it `draft` — a note in the PR or the issue is
   enough; a session will re-cut it.

**Worked if:** either `data/forays.json` says `"status": "published"` on
`grilling-history-1`, or there is a written note saying what a listener heard
that the rules did not catch.

**Status:** OPEN

### 3. Reconcile the two silence numbers: 0.5 s in the brief, 2.0 s in the rules

**Tag:** `[UPGRADE]` · **Time:** ~5 minutes, after item #2

**Why it matters.** Two committed documents give different numbers for the
silence at a seam, and as of this change the player implements one of them, so
the other is now wrong in a way a reader cannot detect:

- `docs/brief/04_VOICE_AUDIO_SPEC.md`, line 12: *"Transitions: hard cuts are
  fine; add ~0.5 s of silence padding around TTS items."*
- `docs/curation/segment-length-rules.md` §6b: *"Silence. **≥ 2.0 s** of
  padding, against the ~0.5 s standard from `04_VOICE_AUDIO_SPEC.md`."*

The rules doc already argues the divergence is deliberate — 0.5 s is right for
*joining* audio around a narration line, 2.0 s is what it takes to *mark an
edit* (§2e, the audiobook section-break convention) — and its own §10 lists the
reconciliation as undecided, *"a spec change [that] needs Wyatt, since it
touches the player."* It now touches the player: `player/seam-gap.js` ships
2.0 s at every unbridged segment-to-segment seam. Nothing about the 0.5 s TTS
padding changed, because no narration exists to pad.

Left alone, the next person to implement bridges reads the brief, uses 0.5 s,
and two parts of the same transition disagree by 4x.

**Steps.**

1. Listen first (item #2). This is a judgement about a sound.
2. Pick one of three:
   - **Keep both, and say so.** Add one line to
     `docs/brief/04_VOICE_AUDIO_SPEC.md` line 12: the 0.5 s is padding around a
     TTS item; an unbridged seam is 2.0 s per `segment-length-rules.md` §6b.
     This is the recommendation — the two numbers do different jobs, and it is
     the only one of the three that touches no code.
   - **Move the number**, or **drop the beat** (which is the same edit with a
     zero). Just say what it should be — you do not have to make the change.
     For whoever does: it is `SEAM_GAP_SEC` in `player/seam-gap.js`, and
     changing it means updating the tests that pin the current value, which
     is deliberate rather than friction — the number is meant to be hard to
     move by accident. They are `player/seam-gap.test.js` ("the merged rule is
     2.0 s…", "an unbridged segment-to-segment auto-advance…"),
     `player/queue-manager.test.js` ("an unbridged segment-to-segment seam
     holds 2.0 s…", "the beat is observable in telemetry…") and
     `player/foray-playback.test.js` ("every one of Foray #1's 31 seams…").
     The `seamGapSec: 0` *constructor option* is already covered by a test and
     needs nothing changed to use — that is the quick way to A/B it by ear
     before committing to a number.
3. Whichever you pick, delete the "does not decide" bullet in
   `docs/curation/segment-length-rules.md` §10 that names this divergence.

**Worked if:** `04_VOICE_AUDIO_SPEC.md` and `segment-length-rules.md` can both
be read start to finish without coming away with two different answers to "how
much silence goes at a seam".

**Status:** OPEN

---

### 5. Give each of the six classify routines its own `--shard i/6`

**Tag:** `[BLOCKING]` · **Time:** ~15 minutes · **Owner:** Wyatt

> ## UPDATE 2026-08-17 — the premise is refuted. Do not do this. ~~15 minutes~~ 0.
>
> **All six routines are sharding correctly. There is no duplicate work.** This
> item asked Wyatt to establish that from the routine UI because "the diagnosis
> comes from reading the code, not the git record". It is now established **from
> the git record**, so no one has to look.
>
> The six `reclassify-<N>` branches hold **17,427 agent classifications, and each
> branch's own work is a clean slice of `Number(id) % 6`: 0 of 17,427 rows sit
> outside their branch's residue, and 0 ids are claimed by two branches** —
> sustained over **24 active classify days** (2026-07-25 .. 08-17), **~2,900 rows
> per shard on average** (1,476 / 3,176 / 2,952 / 3,294 / 3,247 / 3,282 — shard 0
> is the outlier because `main` already held its earlier work).
> Independently: that is **~726 shows/day**, against this item's own prediction of
> ~774/day *with* sharding wired and 129/day without.
>
> **What that does and does not prove.** It proves a `Number(id) % 6` partition is
> in force per branch; ~2,900 rows all landing in one residue by chance is not
> credible. It does **not** show *which mechanism* produces the slice — the git
> record cannot see the routine's command line, and the repo root still contains
> `classify-shard-0.mjs`, a stale one-off with a hardcoded `/home/user/...` path,
> i.e. proof that another route to the same slice has existed. So: something
> correct is in place. That is enough, because the action this item proposes is to
> **overwrite** it.
>
> So, in this item's own words — *"If the routines already pass `--shard`, this
> item is moot and the throughput problem is elsewhere; say so rather than
> proceeding."* Saying so. **There is no duplicate work and there never was**;
> the throughput problem was that none of the output reached `main` (item #10).
>
> **Acting on this item would now cause the damage it was meant to prevent:**
> step 2 overwrites the cron phase and shard argument of six routines that are
> already correct, and step 4 warns that `--shard` fails open on a malformed
> value — so a typo during an unnecessary edit is exactly how six working shards
> become six unsharded ones.
>
> Also answered, for free: **#4 ("are the six routines alive?") is yes** — all
> six, with commits through 2026-08-17 00:52 UTC.
>
> Left `OPEN` because only the owner changes a Status word (`CLAUDE.md`
> § HUMAN-ACTIONS.md).
>
> **One thing #203 changed about this, stated honestly.** #203 shipped the
> balanced key and the fail-loud parse *in the repo*, and those only reach the
> fleet if the routines really do invoke `prepare-batch.mjs --shard` — which, per
> the caveat above, the git record cannot show. So this item is no longer *purely*
> moot: doing step 1 would confirm #203's fix is live. It is still not worth it, on
> the numbers rather than on moot-ness.
>
> **Recommended: `SKIP`.** The remaining backlog is **509 shows (2.6%)**, roughly
> nine more shard-runs — a throughput fix has almost nothing left to speed up, and
> step 2 edits six live configs through a flag that used to fail open.
> Evidence: `tools/classify/reconcile-shards.mjs --dry-run` prints the per-branch
> off-lane count, and `tools/classify/reconcile-shards.test.mjs` pins the check.

**Do #4 first.** #4 asks whether the six routines are alive. This item assumes
they are, and fixes a separate defect that has been costing 5/6 of their output
the whole time they *were* alive. Both are needed; neither substitutes.

> **Updated 2026-08-16 by the engineering PR (`feat/fleet-cataloguing`).** Three
> things this item used to warn about are now fixed in the repo, and the values
> in the table below are unchanged by them:
>
> - **The shard key is now hashed** (`fnv1a32(String(id)) % N`), not
>   `Number(id) % N`. You still type `--shard 0/6`; the difference is only in
>   which shows each shard gets, and it is what stops shard0 from running dry
>   around day 12 with a sixth of the fleet idle.
> - **A malformed `--shard` now exits with an error** instead of silently running
>   the full unsharded catalogue. Step 4's warning still applies — get it right —
>   but a typo now fails loudly rather than quietly costing six times the work.
> - **The prompt's `--batch-size 40` is now 60**, so the "one thing to expect"
>   note at the end of this item no longer applies: batches should come in at
>   the intended size from the first run.
>
> Nothing here changes what you have to do. Same six values, same six crons.

**Why it matters.** `tools/classify/prepare-batch.mjs` supports sharding
(`--shard i/N` — take only the shows that shard owns, by a hashed, stable key).
**The six routines do not pass it.** All six run one shared prompt file with one literal
command that has no `--shard`, so the shard number exists only in the routine
*name*. Batch selection is fully deterministic, so **all six shards select the
identical batch, in the identical order** — reproduced by simulation against the
real catalogue. Five of every six runs are duplicate work that is thrown away.

Measured throughput was **129 shows/day**; with the flag wired it is ~774/day.
That is the difference between finishing the 17,875 remaining shows in **~24
days** and in **~139 days** — and it costs **no extra runs and no extra tokens**,
because the spend is already being paid six times for the same shows.

**One honest caveat, so you know what you are confirming.** The duplicate-work
diagnosis comes from reading the code and the committed prompt, **not** from the
git record — and the routines are demonstrably *not* running the committed
command (33 of 37 batches merged more than the prompt's `--batch-size 40`, up to
56). So step 1 below — copying out what a routine actually executes — is what
confirms or refutes this. (Item #4's step 3 asks only whether each routine exists
and when it last ran, not what command it runs, so it does not answer this.) If the routines already pass `--shard`, this item is
moot and the throughput problem is elsewhere; say so rather than proceeding.

Full analysis: `docs/agents/fleet-review-2026-08.md` §0 and §4.

Steps:

1. Open <https://claude.ai/settings/automations> on the account that owns the
   routines (Wyatt's). **Before changing anything, copy out — into a reply, or
   into this file — the exact command and schedule each of the six currently
   runs.** That is the one piece of evidence nobody in the repo has, it settles
   whether the diagnosis above is right, and it is lost the moment you overwrite
   it. If any of them already contains `--shard`, stop and say so.
2. For each of the six routines, set the schedule and the shard argument as
   below. **Every routine keeps its 8h period and its 3 runs/day — only the
   phase changes.** Shard0 and shard1 change minute only (assuming they sit at the
   `:00`-offset convention — `runners.md` records only "Every 8h", so read the
   current value before you overwrite it); **shards 2–5 change
   the hour field as well** (`0,8,16` → `2,10,18` → `4,12,20`). The stagger
   exists so that only one classify PR is ever open at a time; two concurrent
   ones conflict on the same two lines of
   `data/breadth-classification.json` by construction.

   | Routine | Cron (UTC) | Shard argument |
   |---|---|---|
   | `foray-classify-shard0` | `10 0,8,16 * * *` | `--shard 0/6` |
   | `foray-classify-shard1` | `50 0,8,16 * * *` | `--shard 1/6` |
   | `foray-classify-shard2` | `10 2,10,18 * * *` | `--shard 2/6` |
   | `foray-classify-shard3` | `50 2,10,18 * * *` | `--shard 3/6` |
   | `foray-classify-shard4` | `10 4,12,20 * * *` | `--shard 4/6` |
   | `foray-classify-shard5` | `50 4,12,20 * * *` | `--shard 5/6` |

3. Then set the full command each routine should run — copy it literally, changing only
   the `0/6` to match the table:

   ```
   node tools/classify/prepare-batch.mjs --shard 0/6 --batch-size 60 --mode fresh --progress data/classify-progress.json
   ```

   If the routine has no place to put extra arguments and only accepts a prompt,
   say so and a session will commit six per-shard prompt files
   (`docs/agents/runner-prompts/classify-batch-shard0.md` … `shard5.md`) so you
   only have to change one **path** per routine instead.

4. **Do not guess the shard string.** It must read `0/6`, `1/6`, `2/6`, `3/6`,
   `4/6`, `5/6` — one each, no duplicates, **none of them `6/6`** (shards are
   0-indexed). As of 2026-08-16 a malformed value makes the run exit with an
   error instead of silently reverting to the full unsharded catalogue, so a typo
   shows up as a failed run rather than as six times the work. Before that fix it
   failed open, which is the bug this item exists to close.

**The prompt fix has landed**, so nothing about batch size is outstanding:
`classify-batch.md` now says `--batch-size 60` and carries the shard flag, and
`docs/agents/runners.md` records the intended cron and argument per routine.

**Worked if:** within one 8-hour window, **six different** `classify/*` PRs have
merged, and no two of them classified the same show. Quick check after a day:
`git log origin/main --oneline -- data/breadth-classification.json` shows
several batches per day rather than one, and the `classify-agent-tier1` count in
`data/breadth-classification.json` is climbing by ~770/day rather than ~130.

**Status:** OPEN

---

### 6. Decide: add the usability fields before the four-week run, or after

**Tag:** `[BLOCKING]` · **Time:** ~10 minutes to decide · **Owner:** Joey (with
Wyatt on the cost)

> **Mostly answered 2026-08-16, and the question got much smaller.** Wyatt cut the
> scope — *"I just want it to flag transcripts, not go overboard"* — and the
> transcript flag itself has now landed (`feat/fleet-cataloguing`), which is the
> "schema first" answer for the one field that was worth it. So there is no
> second four-week pass hanging over this any more.
>
> What was dropped, deliberately, and is **not** waiting on you: the enclosure
> host, `<language>`, feed liveness, and `format`/`depth`/`expertise_sourced`
> content-shape labelling. All free or nearly free, all recommended by the review,
> none of them asked for. If any of them turns out to be wanted later it is a
> small PR, and the argument for it should be a use for the field rather than the
> fact that it is cheap.
>
> **One framing correction worth carrying forward, because the review has it
> wrong:** the review ranks transcript availability as the #1 binding constraint.
> It is not a constraint at all — we make our own transcripts (measured rate and
> source: `docs/curation/transcription-scale-plan.md` §1). A missing transcript
> is therefore a **cost**, not a blocker, which is exactly why flagging
> it is useful and why nothing filters on it. The one thing that genuinely gates
> today is a bounded ad delta, per ADR-0008.
>
> Nothing below needs doing unless you want one of the dropped fields.

**Why it matters.** This is a sequencing decision, and it is cheap now and
expensive later — which is the only reason it is here rather than being decided
by a session.

The fleet records 14 fields per show — nine describing subject or display copy,
five recording provenance. **None of them records whether a show is *usable*.**
The measured
evidence that this is the binding gap: of the nine episodes in the ASR queue we
actually want, **ads blocked zero, transcript availability blocked all nine, and
content shape rejected 6h 02m of audio — more than the entire funded queue.**

The fix is nearly free, and that is the point. The fleet **already downloads
each show's full RSS feed** and throws away everything except the description
and recent episode titles. `<podcast:transcript>` tags, the audio host,
`<language>` and the newest `<pubDate>` are in bytes already on the wire — no
extra request, no extra token. And `data/taxonomy.json` already defines the
vocabulary for "explanatory versus chat" (`episode_attributes.format`, with
`"hang"` as the chat value) which the classifier does not emit.

**The decision.** Schema first, or blitz first?

- **Schema first (recommended).** One engineering PR, ~1 day of delay. Four
  weeks of runs produce both the subject tags *and* the usability record.
- **Blitz first.** Starts a day sooner and needs a **second** four-week pass
  over all 19,787 shows later to collect signal that was on the wire the first
  time and discarded — plus a deliberate progress reset, because the pipeline
  skips any show it has already classified.

Rationale and the exact field list: `docs/agents/fleet-review-2026-08.md` §3
and §5.

Steps:

1. Read `docs/agents/fleet-review-2026-08.md` §5 — it is one table of fields
   with a one-line reason each.
2. Reply with either **"schema first"** or **"blitz first"** and change the
   status below. No other detail is needed; a session will do the rest.
3. If **schema first**, expect the engineering PR to also carry: `--shard`
   failing loudly instead of open, `chart_rank` ordering within bucket, a
   terminal `feed_dead` state, and deletion of two stray root scripts
   (`classify-shard-0.mjs`, `classify-shows.mjs`).

**Worked if:** a session can start the four-week run without having to guess
whether it will need to be run twice.

**Status:** OPEN

---

### 7. Confirm the fleet's target list stays the chart-200 catalogue

**Tag:** `[UPGRADE]` · **Time:** ~5 minutes · **Owner:** Joey

**Why it matters.** Before spending four weeks classifying 17,875 shows, confirm
they are the right 17,875 — because the list has a hard, measured ceiling and
this is a decision about what we are choosing not to see.

`data/catalog-breadth.json` is, by construction, "the top 200 of each of 110
Apple genre charts" — `CHART_LIMIT = 200`, and the maximum `chart_rank` present
anywhere is 200. Those 19,787 US shows are **0.42%** of PodcastIndex's 4.71M
feeds; the whole catalogue including 18 international storefronts (138,480 feeds)
is **2.94%**. When one sourcing pass went outside it, **88.6%** of the
food/history feeds it found were not in our catalogue at all — including The
Moreish Podcast, which Foray #1 now uses.

**The review's recommendation is to keep it as-is for these four weeks**, and to
be clear about why, because one earlier document argued the opposite:

- `grilling-foray-sourcing.md` §5.2 found that chart rank predicts ad injection
  (top-25 are 33% ad-free vs 71% at ranks 26–200) and concluded the harvest
  "selects against us". That argued for re-pointing the harvest.
- **ADR-0008 then removed ads as a rejection reason entirely** (2026-08-16, the
  day before this review), and the transcript sweep runs the *other* way: the
  ad-injecting shows carry **13.3%** transcript coverage against **0.2%** for
  ad-free shows, a **64.5×** difference — and transcripts, not ads, are what cost
  1.33× realtime of CPU.

So the case for changing the list rests on a gate that no longer exists, and
changing it would give up the half of our free-transcript inventory ADR-0008 just
unlocked. Broadening is a real workstream, with its own measured verdict (the
PodcastIndex dump is "a research tool, not an ingest path") — it just should not
happen *during* the four weeks, because it resets the denominator and "have we
finished?" stops having an answer.

Steps:

1. Read `docs/agents/fleet-review-2026-08.md` §1.
2. Reply **"keep the list"** (recommended) or **"broaden first"**, and change
   the status below.
3. Either way, one thing is worth knowing and does not need a decision: a show
   absent from `catalog-breadth.json` has **not** been assessed and rejected —
   it has never been seen.

**Worked if:** nobody re-opens "should we have classified a different list?" in
week three.

**Status:** OPEN

---

### 8. Listen to Foray #2, and rule on one number the cut budget cost us

**[BLOCKING]** for publishing Foray #2 — **~55 min of listening plus one
decision.** Foray #2 (`capital-types-1`, 22 segments, 51:22) is authored,
green, and `status: "draft"`, so no client surfaces it. Write-up:
`docs/curation/foray2-capital.md`.

Two things, and they are best done in one sitting because the second is a
judgement you can only make with the thing in your ears.

1. **Listen to it end to end.** Play it at
   `https://jw-incorporated.github.io/foray/?foray=capital-types-1`. Nothing in
   either Foray has ever been heard by anyone; every number in both write-ups is
   a property of timestamps. Listen for the two things the rules cannot check:
   whether a segment ends before its speaker has finished a thought, and whether
   the eight slots read as one argument or as eight unrelated interviews.
2. **Then rule on the cut budget.** The rolling cut budget (rule D1, "no more
   than 6 segment starts in any 10 minutes") forced **four finished segments out
   of the running order, and three of them are among the ten best passages in
   the batch** — including the 59-second close of the friends-and-family slot,
   where Heidi Roizen asks a founder how he would feel if his in-laws lost
   everything. They were dropped for being **short**, not for being weak. The
   number is marked "judgement" in `docs/curation/segment-length-rules.md` §5c,
   so it is yours to move.

   - If the Foray sounds like it jumps around, D1 is right and this is the price.
   - If it sounds unhurried and you find yourself wishing it had more, say
     "raise N to 8 for every length" and the four segments come back at a cost of
     about six and a half minutes.

**Worked if:** you say one of exactly three things — "publish it", "publish it
and raise N", or "here is what I heard that the rules missed".

**Status:** OPEN

---

### 9. Bump the service-worker cache to `foray-v5` so the storage change lands in one go

**[UPGRADE]** — **~2 minutes, one word in one file, but it needs a founder merge**
because `sw.js` is not in the auto-merge allowlist (`tools/ci/path-policy.mjs`).

Issue #40's durable-storage change (`player/durable-store.js`) moves every `cp_`
key — interests, thumbs, playback positions, where a listener is inside a
61-minute Foray, and the anonymous session token that is their only identity —
from evictable `localStorage` into IndexedDB, with `localStorage` kept as a
mirror. Nothing is renamed and nothing is deleted, so this is safe either way.

**Why bump anyway.** `app.js` is in the service worker's precached shell and is
served **cache-first**, so a returning visitor runs the PREVIOUS `app.js` for one
load and picks up the new one on the load after. That is the normal cost of every
`app.js` change and nobody has bumped for it. It is worth bumping for this one
because a storage migration is the one kind of change where having some tabs on
the old code and some on the new is worth avoiding: the old code writes only to
`localStorage`, the new code migrates it, and a crisp cutover means the migration
runs once instead of racing itself.

1. Open `sw.js` at the repo root.
2. Line 7 reads:

   ```
   const CACHE = "foray-v4";
   ```

   Change it to:

   ```
   const CACHE = "foray-v5";
   ```

3. Commit on a branch, open a PR, and merge it once `data-and-site` and
   `backend` are green. The `activate` handler already deletes every cache whose
   name is not the current one, so nothing else has to change.

**Worked if:** after deploying, hard-reload
<https://jw-incorporated.github.io/foray/>, click something (a suggestion, the
family-mode toggle — anything that stores state), then type `forayStorageHealth()`
in the browser console. You want **`ok: true`** and **`tiers.idb.writes` greater
than 0**, with `durableTiers: ["idb"]`.

Read those three together, because two of them can lie on their own:

- `durableTiers: ["idb"]` with `writes: 0` means IndexedDB *exists* but has never
  committed anything. That is what Safari private mode looks like.
- `ok: false` means at least one write or read failed; `faults` says which tier
  and why.
- `durableTiers: []` means this browser has no IndexedDB (or it failed enough
  times to be dropped) and the listener is on the localStorage mirror only —
  which is the pre-#40 behaviour, not a regression.

The click matters: nothing is written until something happens.

**Status:** OPEN

---

### 10. Make the six classify routines land their own work (they open no PR)

**Tag:** `[BLOCKING]` · **Time:** ~10 minutes · **Owner:** Wyatt

**Read #5's update block first — it replaces #5, and this is the real problem
it turned out to be.** The six routines are alive, correctly sharded, and
productive. What they do not do is get their output to `main`.

**Why it matters.** Each routine commits to **`origin/reclassify-<N>`** and
**opens no pull request**, even though §8 of
`docs/agents/runner-prompts/classify-batch.md` tells it to create a
`classify/<date>-<batch_id>` branch and run `gh pr create`. The committed prompt
and the live routine configuration disagree. Consequence: **17,427 real
classifications accumulated on six branches over three weeks while `main` stayed
at 1,851**, and every signal a human or an agent would check — no open classify
PR, no new `classify/*` branch since 2026-08-03, a frozen count in
`data/breadth-classification.json` — said the fleet was dead. PR #198 read those
signals and filed exactly that conclusion.

This PR reconciles the backlog by hand
(`tools/classify/reconcile-shards.mjs`, 1,851 → 19,278). **That is a one-off
catch-up, not a fix.** Every batch after 2026-08-17 accumulates off `main` again.

**Pick (b) unless you have a reason not to. (a) is not currently safe** — see the
warning under it.

- **(a) Make the routines open PRs.** In each of the six routines' instructions,
  replace the commit-and-push step with §8 of `classify-batch.md` verbatim. The
  `classify/*` prefix is already auto-merge allowlisted, so the PRs land
  themselves on green. Six edits, and the stagger in #5's table matters here:
  two concurrent classify PRs conflict on the same lines by construction.
  **Not safe today, and this is a real blocker, not a caveat.** A classify batch
  merging onto `main` rewrites `provenance` in
  `data/breadth-classification.json`, and three gate tests in
  `tools/classify/reconcile-shards.test.mjs` read the reconciliation record
  there. The provenance-clobbering half is fixed in this PR
  (`merge-results.mjs` now spreads rather than replaces) and the tests now
  tolerate an absent record — but **verify both are on `main` before choosing
  (a)**, or the first classify PR is red, auto-merge cannot act on it, and the
  fleet stops reaching `main` again: the exact disease this work cured.
- **(b) Leave the routines alone and schedule the reconciler.** One new routine,
  daily, whose whole job is:
  ```
  git fetch origin 'refs/heads/reclassify-*:refs/remotes/origin/reclassify-*'
  node tools/classify/reconcile-shards.mjs
  ```
  then commit `data/breadth-classification.json` on a `classify/reconcile-<date>`
  branch and `gh pr create`. Keyless, deterministic, idempotent — a day with no
  new shard work produces no diff and no PR. **Recommended:** it touches none of
  the six working configurations, and it keeps working if a seventh shard is ever
  added.

**Do not "fix" this by editing the prompt file.** The routines are not reading
it for this step — that is the whole finding. A doc change here would look like a
fix and change nothing.

**Two things to size this against, so it is not over-prioritised.** The backlog
is now **509 shows (2.6% of 19,787)**, ~nine shard-runs — not another 17,000; the
shards are running out of work, which is why `reclassify-4` has not committed
since 08-13. (Per-lane remainders depend on WHICH key: under the retired
`Number(id) % 6` they are 38/41/335/40/21/34; under the hashed key #203 shipped —
what every future run uses — 87/87/80/70/86/99. Quote the second.) And the reconciliation raised the **tier-2
escalate queue from 301 to 2,917** shows (`--mode escalate` selects
`classify-agent-tier1 && needs_review`): 1,275 of those are flagged only for a
copy-rule miss on the display fields, 1,642 for the classification itself.
**Nothing escalates on its own** — the six routines run `--mode fresh`, so the
queue is latent. But a deliberate tier-2 pass is now a ~10× bigger job than the
last time anyone sized it, and tier 2 fetches transcripts, so that is a spend
decision (CLAUDE.md decision authority #3) and not one to stumble into.

**Worked if:** `data/breadth-classification.json` on `main` gains
`classify-agent-tier1` rows within 48 hours without anyone running a command
locally — either from six `classify/*` PRs, or from one
`classify/reconcile-*` PR.

**Status:** OPEN

---

### 11. Put a Foray on a real phone with the screen off — the one test no machine here can run

**Tag:** `[BLOCKING]` for any store submission · **Time:** ~5 minutes to start, then a 15-minute walk · **Owner:** Joey (an iPhone) and/or Wyatt (an Android phone) — either one alone is worth doing

**Why it matters.** #35 asked whether `<audio>` in a Capacitor WebView survives backgrounding. It now has an answer — `docs/research/mp1-background-audio.md` — but **no part of that answer came from a device.** iOS could not be tested at all (this is a Windows machine; iOS cannot be built on it), and the Android emulator route was tried and failed: the SDK went on, a throwaway Capacitor app was built around our real player code, the APK was pushed — and the emulator never finished booting well enough to install it. Three attempts, about 75 minutes, not one line of output. §6.2 of that document has the detail.

An emulator is also not a phone for the two things that decide the Android answer — **power management and audio focus** — so even a successful emulator run would not have closed this.

**The specific claim at stake, because it decides a lot of work.** On iOS, background JS timers are aligned to ~1 second, so the player's precise stop relies on the `timeupdate` media event still firing while backgrounded. That is an *inference* from WebKit's source, not something anyone has run. If it holds, a segment stops within about a quarter-second of where it should. If it does not, **the segment plays on into the rest of the source episode — a median of 15.6 minutes of the wrong content** (measured over the real Foray data), with the app still showing the Foray and its clock still counting. That is the difference between "ship the shell with a caveat" and "the shell needs a native audio backend on both platforms".

**Steps — five minutes, no tooling, either platform.**

1. On your phone, open exactly this:

   ```
   https://jw-incorporated.github.io/foray/?foray=grilling-history-1
   ```

2. Press **Play**. Let one segment start (they are ~1–3 minutes each).
3. **Lock the phone** (side button) and put it in your pocket. Keep listening.
4. After about 15 minutes, unlock and look at the running order.

   **Report one thing above all: did it move on through new segments, or did it keep playing one episode?** If the highlighted row is still an early one after 15 minutes of listening, that is the exact failure this is about, and saying so is the whole result.

5. Also say whether the audio **stopped** at any point, and roughly when.

**Read this before drawing a conclusion from step 4.** A browser tab is **not** the same as an app. This test is genuinely informative about the engine's timer behaviour, and it is the reason it is worth five minutes — but it **cannot** settle app-level backgrounding, because a browser tab is not subject to it. A clean pass here does not mean the packaged app will pass.

**The version that actually settles it needs a build**, which does not exist yet: #36's Capacitor scaffold plus one `Info.plist` line. Say the word and a session will produce a TestFlight build (iOS) or an APK (Android) of the throwaway spike app, which logs the numbers directly instead of asking you to judge by ear.

**Worked if:** there is a written note on #35 saying, for at least one real phone: whether audio continued with the screen locked, for how long, and whether segments kept advancing. Three sentences is a complete result.

**Status:** OPEN

---

### 12. Decide: does Android's native audio backend land before the Play release?

**Tag:** `[BLOCKING]` for the store sequencing · **Time:** ~10 minutes to decide · **Owner:** Wyatt (architecture)

**Why it matters.** #34 plans to wrap the web app in a Capacitor shell and ship both stores, **Google Play first**, because Play is more lenient about webviews and Android builds on Windows today. The MP1 research (`docs/research/mp1-background-audio.md`) does not overturn that, but it found that on *audio* the two platforms come out the opposite way round, and the consequence is a sequencing decision only you should make.

- **iOS turns out to be the easy one.** Background audio costs **one line in `Info.plist`** (`UIBackgroundModes: audio`). No plugin, no Swift, no `NativeAudioBackend` — WebKit already configures the audio session itself, and a plain `<audio>` element is deliberately exempt from its background and screen-lock restrictions. Verified in WebKit's source. #35's own method section assumed native code was needed here; it is not.
- **Android is the hard one, for two reasons that both need native code.** A `mediaPlayback` foreground service is required to stop the OS freezing or killing the app — and from Android 15, to hold audio focus at all, which matters because Capacitor 8 generates `targetSdk 36`. And **`navigator.mediaSession` is switched off in Android WebView by Chromium itself**, so lock-screen and steering-wheel controls are *impossible* from JavaScript at any price. `docs/brief/04_VOICE_AUDIO_SPEC.md` calls those controls "the baseline hands-free interface" that "must be flawless before any voice work".
- **No maintained Capacitor plugin fills the gap.** The one that fits exactly is pinned to Capacitor 6 and was last published in **August 2024**; we are on Capacitor 8.

So the recommendation is: **Android's half of #28 lands before any Play release, not after.** Once you are writing a Media3 `MediaSessionService` for the lock screen — which #27 forces regardless — you have already built most of it, and letting it also *play* the audio removes a second source of truth for transport state.

**One caveat on the evidence, stated plainly:** none of this was measured on a device (item #11). The Android conclusion rests on Chromium's source plus measurements of the same engine on the desktop; the iOS conclusion rests on Apple's and WebKit's documentation. The parts that decide *this* item — the foreground-service requirement and MediaSession being disabled — are the best-supported findings in the document, both from primary sources.

**The decision.** Reply with one of:

- **"Native Android before Play"** (recommended). #28's Android half moves onto the critical path. Slower to a store listing; the first release behaves like a podcast app.
- **"Ship the shell to Play first, native after."** Faster to a listing. The first release has no lock-screen controls on Android and can be frozen or killed in the background by the OS — in practice an internal or closed-testing track, not a public launch.
- **"Neither — iOS first."** The audio picture genuinely favours iOS. This cuts against #34's Play-first reasoning (App Store 4.2 review risk, and iOS needs the Actions macOS runners to build), so it is a real trade, not a free win.

**Steps.**

1. Read §9 and §10 of `docs/research/mp1-background-audio.md` — two short sections, one table.
2. Reply with one of the three phrases above and change the status below. A session will re-scope #28, #27 and #34 to match.

**Worked if:** #28 and #27 say the same thing about Android as #34's milestone order does, and nobody has to re-derive it.

**Status:** OPEN

---

### 13. Six facts only you can supply before the privacy policy can be published

**Tag:** `[BLOCKING]` for any store submission · **Time:** ~20 minutes to answer five of them; the sixth is a decision · **Owner:** Wyatt (infra facts), Joey (listing + legal-entity decisions)

**Why it matters.** `docs/legal/privacy-policy.md` and `docs/legal/data-safety.md` now exist and are written **from the code**, not from a template — the Data Safety and App Privacy forms can be filled in by copying verified answers. Everything derivable from the software is answered. What is left is six facts no agent can invent, and a policy published with an invented one is a public, binding false statement. Each is marked `TODO(founder)` in those two files.

**Two things the audit found that are worth knowing before you read further.**

1. **The app does transmit.** Every page load creates an anonymous Supabase account and sends an event row, and a thumbs-down sends the free-text note you typed. That is not what an earlier reading of the code assumed, and it is why the declarations answer "Yes" rather than "No" to collection.
2. **Playback reaches 43 hosts, and some of them are ad-attribution services.** Because we never proxy audio (product principle 3), a listener's IP and user-agent go straight to whatever the publisher put in their enclosure URL — and publishers commonly chain several measurement prefixes. One URL in our own catalogue routes through five before the audio. Alongside download counters like Podtrac there are advertising-attribution vendors (Podsights, Chartable, Podscribe, Claritas and others), three of which are in the default home cards. **We receive nothing from any of them and have no relationship with them**, so the store declarations are still "no collection, no sharing" — the reasoning is set out in `data-safety.md` §A6 — but the privacy policy now discloses it in full, because the alternative is a policy that quietly implies otherwise. Nothing here needs a decision from you; it needs you not to be surprised by it, and it is the one paragraph a lawyer should read first.

**Steps — answer each in a reply, or edit it straight into the file.**

1. **Legal entity name** to name as data controller. (`privacy-policy.md` §9.)
2. **A privacy contact address.** Both stores require a working contact, and Play's Data Safety form requires a public privacy-policy URL. Nothing was invented.
3. **The Supabase project's region / hosting jurisdiction**, and whether a data-processing agreement exists. Needed to say where data is stored, and required if EU users are in scope. (§3.)
4. **Retention:** how long event rows are kept. Nothing in the code ever deletes one, and no retention job exists (ADR-0005 anticipated one).
5. **Geo-availability:** US-only listing, or accept GDPR obligations day one? `docs/marketing/05-legal-risk-memo.md` §5 sets out the trade; it is still unresolved and it changes what the policy must promise.
6. **The one build decision: a delete control.** ~~There is **no in-app way to clear your data** today~~ — **BUILT, nothing to decide here any more.** The menu now carries **Delete my data**: it clears both storage tiers (enumerated and verified, not from a list) and issues an authenticated delete of that account's rows in every per-user table, remote first so a network failure cannot strand the rows. Play's deletion answer is **Yes** — `docs/legal/data-safety.md` §A7. Two residues, both real and neither blocking this item: the **deletion URL** the form also wants (a hosting task, and item 2 above covers the same page), and the empty **auth user row** a client cannot delete, which is new item **14**.

**Two things to verify in the Supabase dashboard while you are there** — neither is knowable from the repo, and both are listed as open questions in `data-safety.md`:

- Whether **anonymous sign-in is enabled** on the project. If it is off, every sync silently no-ops and buffers locally forever. The declarations are written as though it is on, which is the correct posture for shipped code either way.
- Whether the **RLS policies are actually applied and verified**. ADR-0005's own Risks section says they were written to spec but never verified against a live project, and they live in `backend/migrations/supabase/`, which the migration runner deliberately never auto-applies — someone has to paste them into the Supabase SQL editor, and nothing in the repo records whether anyone did. The per-user isolation claim in the policy depends entirely on it.

**Also worth a lawyer's eye, flagged rather than decided:** two of the nine thumbs-down reason chips are "Leans too far left" and "Leans too far right", and the selected chip is transmitted. They record a reaction to an *episode*, not the listener's own politics — so Apple's "Sensitive Info" and Play's "Political or religious beliefs" are both answered **No**, which is the defensible reading. It is disclosed in the policy regardless.

**Worked if:** `docs/legal/privacy-policy.md` contains no `TODO(founder)` markers, and the answers in `docs/legal/data-safety.md` can be pasted into both forms without a judgement call left in them.

**Status:** OPEN

---

### 14. Delete the empty anonymous accounts a client cannot delete itself

**Tag:** `[UPGRADE]` · **Time:** ~15 minutes in the Supabase dashboard, once · **Owner:** Wyatt

**Why it matters.** The in-app **Delete my data** control (now built) deletes every row an account owns, in every per-user table, and discards the token so the next event creates a **new** anonymous account rather than re-attaching. What it cannot delete is the `auth.users` row itself: that needs the Admin API and a **service-role key**, and a key that can delete any account cannot ship inside a public web page — this repo's automation is deliberately keyless (CLAUDE.md decision-authority item 2), and putting one in `app.js` would be strictly worse for privacy than leaving the row.

So after a deletion the account is an **empty shell**: no name, no email, no phone number, no password, no `app_users` row, no events. Both store declarations and the privacy policy say exactly that rather than implying the account is gone. This item is what would let them say more.

**The honest framing:** this is not a data-protection hole — an identifier with nothing attached to it is not personal data in any practical sense, and it is disclosed. It matters for two narrower reasons: an Apple reviewer reading guideline 5.1.1(v) strictly may want the account record itself removed, and the table otherwise grows one dead row per deletion forever.

**Steps.**

1. In the Supabase dashboard, open **SQL Editor** and add a `security definer` function that deletes the caller's own auth user — the standard shape is `delete from auth.users where id = auth.uid();` inside a function owned by a privileged role, exposed as an RPC (e.g. `create function public.delete_own_account() returns void`), with `grant execute on function public.delete_own_account() to authenticated;`.
2. Tell whoever picks up the follow-up (or reply here) that it exists, and the client will call `POST /rest/v1/rpc/delete_own_account` as the last step of the deletion — **after** the row deletes, since the token dies with the account. It is ~10 lines in `app.js` and one more `SB_USER_TABLES`-style pin in `test/data-deletion.test.js`.
3. Decide whether the same function should also cascade the per-user tables. It does not need to — the client already deletes them — but it makes the server-side path complete on its own, which matters if a deletion request ever arrives by email instead of through the app.
4. While in there: consider a **retention job** for anonymous accounts with no events at all (item 13, step 4, needs a number for the policy either way). The same sweep can collect shells from before this function existed.

**Worked if:** calling the RPC as an ordinary anonymous user removes that user from `auth.users` and returns success, and calling it cannot remove anybody else's (test it twice, with two different anonymous tokens). Then `docs/legal/data-safety.md` §A7 and `privacy-policy.md` §7 can drop the "the account row stays" paragraph — and both must be updated in the same change that ships the client call, per the standing rule in §8 of the policy.
### 15. Rule on the app's permanent bundle id

**Tag:** `[BLOCKING]` for any store submission · **Time:** ~2 minutes · **Owner:** Wyatt (architecture)

**Why it matters.** The bundle id is the app's identity in both stores and it is **permanent once published** — changing it after a release means a brand-new listing, a new URL, and zero installs carried over. It is now written into a file and into a test, so it will not drift by accident, but nobody has actually agreed to it.

**The recommendation** (from #36, unchanged): **`com.jwincorporated.foray`**. It matches the GitHub org that owns the repo and pays the Actions bill.

**The one thing to know before saying yes.** `ios/project.yml` — the old SwiftUI scaffold — says `com.wjduvall.foray`, which predates the org. That is a **different app** and it has never been published, so there is nothing to migrate. As of #36 that directory is reference material, not the shipping app (`docs/mobile-shell.md` §1); the shipping app is the Capacitor shell in `mobile/`. Leaving the two ids different is fine and is the current state.

**Steps.**

1. Open `mobile/capacitor.config.json`. Line 2 reads:

   ```json
   "appId": "com.jwincorporated.foray",
   ```

2. Reply either **"confirmed"**, or with the id you want instead.
3. If you want a different one, a session changes it in exactly two places — that file and the pinned assertion in `tools/mobile/shell-invariants.test.mjs` ("the app id is pinned, because it is permanent once published"). Do not change one without the other; the test exists so that the change cannot be quiet.

**Worked if:** the status below says DONE and `mobile/capacitor.config.json`'s `appId` is the id you intend to publish under, forever.

**Status:** OPEN

---

### 16. On a Mac: generate the iOS shell, add one `Info.plist` line, and build it

**Tag:** `[BLOCKING]` for iOS · **Time:** ~30 minutes the first time (mostly Xcode and CocoaPods downloading) · **Owner:** whoever has the Mac

**Why it matters.** #36 committed the shell's configuration, the `webDir` build and the guard tests, but **no native project has been generated and nothing has been compiled** — this is a Windows machine. Everything about a *running* app is therefore unverified, including one CSP change that is reasoned from WebKit's behaviour rather than observed. One session on a Mac converts the whole thing from "should work" to "does".

**Do item #15 first** if you can — the bundle id is baked into the generated project, and changing it afterwards means regenerating.

**Steps.** All of these run from the repo root unless stated.

1. Install the toolchain, if it is not there:

   ```bash
   brew install cocoapods
   ```

   Xcode itself must be from the App Store, opened once so it accepts its licence.

2. Install the shell's dependencies and build the web bundle:

   ```bash
   cd mobile
   npm install
   npm run prepare:webdir
   ```

   **Worked if:** it prints something like `webDir ready: mobile/www  (30 files, 2.52 MB of 3.00 MB)`. If it prints a size *error* instead, stop and report it — that guard is doing its job and the fix is not to raise the cap.

3. Generate the iOS project:

   ```bash
   npm run add:ios
   ```

   This creates `mobile/ios/`. It does **not** touch the repo's `ios/` directory — that is the old SwiftUI scaffold and it must stay untouched (`docs/mobile-shell.md` §1).

4. **Add the background-audio key.** This is the single most important step, and it is the *entire* iOS background-audio requirement — no plugin, no Swift, no audio-session code. Open `mobile/ios/App/App/Info.plist` and add, inside the top-level `<dict>`:

   ```xml
   <key>UIBackgroundModes</key>
   <array>
       <string>audio</string>
   </array>
   ```

   In Xcode's UI the same thing is: select the **App** target → **Signing & Capabilities** → **+ Capability** → **Background Modes** → tick **Audio, AirPlay, and Picture in Picture**.

5. Open and run it:

   ```bash
   npm run open:ios
   ```

   In Xcode: select the **App** scheme, pick your device, set your team under **Signing & Capabilities** (it is blank on purpose — no Apple Team ID is committed), then Run.

6. **The five things to report back**, in one comment on #36:
   1. Does the app launch and show the four cards?
   2. **In the Safari Web Inspector console (Safari → Develop → your device → App), type `Capacitor` and press enter. Is it defined, or does it say "Can't find variable"?** This is the single most important line of output in this whole item. Capacitor injects its bridge as an **inline script**, and the page's CSP is `script-src 'self'` with no `'unsafe-inline'`. If the bridge is blocked, the bridge is gone, all four plugins are dead, and the app silently starts caching itself. iOS probably injects in a way that bypasses the CSP; Android probably does not. Report the exact answer either way, plus **any console error containing the words "Content Security Policy"** — quote it verbatim.
   3. **Are the app icons visible?** The other change made blind: the CSP had to gain `'self'` for `img-src`, because the iOS shell's origin is `capacitor://localhost` and the app's own bundled icons match neither `https:` nor `data:`. If you see a CSP error mentioning an image, say so.
   4. Start a Foray, press play, **lock the phone for 15 minutes.** Does audio continue, and does the running order keep advancing through segments? (This is the real version of item #11, the one a browser tab cannot answer.)
   5. Does the app pick up a new build, or does it seem to serve stale content? It should not cache — the shell deliberately does not register the service worker — and this is the check that confirms it.

7. Commit `mobile/ios/` when it works. Capacitor's own guidance is to commit the generated project, and it keeps CI from needing a `cap add` step.

**Worked if:** there is a comment on #36 answering the four questions in step 6, and `mobile/ios/` is committed with `UIBackgroundModes: audio` in its `Info.plist`.

**Note added by #38 (2026-08-17) — steps 1–4 and 6.2 no longer need a Mac, but this item is not done, and TWO of the steps below are wrong as written.**

`.github/workflows/ios-build.yml` now does the toolchain install, `npm run add:ios`, the `Info.plist` edit (via a unit-tested script, not by hand) and an **unsigned build of both the simulator and the arm64 device target** on a GitHub macOS runner. All of that is **verified working** — run [32021861601](https://github.com/JW-Incorporated/foray/actions/runs/32021861601) reported `** BUILD SUCCEEDED` for both, and `PlistBuddy` read the background-audio key back out of the generated plist. Full detail in `docs/ios-ci.md`.

**Two corrections to the steps above, found by that run:**

1. **Step 1 is wrong: `brew install cocoapods` is not needed.** Capacitor 8's iOS template uses **Swift Package Manager**. `cap add ios` writes a `Package.swift` and runs no `pod install`, and there is **no `App.xcworkspace`** — so if you open anything by hand it is **`mobile/ios/App/App.xcodeproj`**, not a workspace. Xcode resolves the local package itself.
2. **Step 6.2 is answered.** `window.Capacitor` **is defined** in the iOS shell: `typeof` is `object`, `isNativePlatform()` returns `true`, `getPlatform()` returns `"ios"`, nine plugins are registered, and there were **zero** CSP violations and zero "Content Security Policy" lines in the system log. So our `script-src 'self'` does **not** block Capacitor's bridge on iOS. You do not need to type anything into a console for this one. (Android is a different mechanism and is still open — item #18.)

**Step 6.4 now has a Simulator answer, and it is the good one — but it is the WEAK direction of the evidence.** In the backgrounded Simulator the segment's stop-point fired **4.5 milliseconds** late, with 15 seconds of genuinely hidden playback and 61 measurements behind it, and the `timeupdate` event that drives it kept running at ~252 ms while the ordinary page timers next to it were throttled to 1 second. That is the inference `docs/research/mp1-background-audio.md` §8 called its most load-bearing one, and it held. **A Simulator models neither power management nor true suspension, so this cannot promise a real phone will do the same** — a *failure* there would have settled it; a pass only removes one way of being wrong. Your 15 minutes with the screen off is still the test that counts.

**What is still genuinely yours, and a simulator cannot do:** steps 6.1, 6.3, 6.4 and 6.5 are *device* questions. A simulator models neither power management nor true suspension, so however cleanly CI runs, only a real phone with the screen off answers 6.4. Plus step 7 (whether to commit `mobile/ios/` — note there is no `Podfile.lock`, so plugin versions would be pinned only by `Package.swift` and an uncommitted `mobile/package-lock.json`) and the app id in #15.

**Read the workflow's job summary before spending the 30 minutes.** It may have found the failure for you already; it found two.

**Status:** OPEN

---

### 17. Decide: does the app ship with data frozen at build time?

**Tag:** `[BLOCKING]` for a public release · **Time:** ~5 minutes to decide · **Owner:** Joey (product)

**Why it matters.** The app bundles `data/*.json` — the session, the discover pool, the taxonomy, the Foray running orders. That is what makes it work offline in a cell dead zone, which is the founding constraint. But **the bundle is a snapshot taken when the app was built, and nothing in the app refreshes it.** The web site picks up the nightly regeneration immediately; a shipped app would show its build day's picks forever, until someone shipped a new build.

For a product whose promise is "four picks, every day", that is the difference between a demo and the actual thing.

**This is #40's remaining half** ("data freshness"), whose web half already landed in #204. It is not new work discovered late — it is a known, scoped piece — but #36 makes it concrete, because it is now the specific reason a store build would feel wrong.

**The decision.** Reply with one of:

- **"#40 before any public release"** (recommended). The app fetches fresh data on launch with the bundled copy as the offline fallback. This is one issue, already designed. A closed-testing or internal track can ship before it.
- **"Ship frozen, refresh later."** Acceptable only for an internal/TestFlight build where everyone knows. Do not put this on a public listing: the four cards would be visibly stale within a week and the product would read as broken rather than as unfinished.

**Answer this together with item #12** if you are answering either — both are "what must be true before a store listing", and a single sitting settles the release shape.

**Worked if:** #40 says whether it gates the first public release, and the status below says DONE.

**Status:** OPEN

---

### 18. On Android: settle whether our CSP kills Capacitor's bridge

**Tag:** `[BLOCKING]` for Android · **Time:** ~45 minutes, most of it downloads · **Owner:** Wyatt (or anyone with an Android phone and a USB cable)

**Why it matters.** This is the **top open risk** in the whole native-app change, and it can be settled by reading one line in a console.

Capacitor injects its native bridge (`native-bridge.js`, the app config, and every plugin's JavaScript) into the page as an **inline `<script>`**. Foray's page carries a strict CSP — `script-src 'self'`, with no `'unsafe-inline'`, permanently and deliberately. If Android's WebView applies that CSP to the injected script, the script is blocked, and three things follow at once:

1. `window.Capacitor` never exists, so all four installed plugins are dead;
2. **the service worker registers inside the app** — because with no bridge to ask, the page sees an origin of `https://localhost`, which is indistinguishable from the real website. That is the "app won't update after a store release" bug;
3. anything later built on a Capacitor plugin (native storage for #40, downloads for #29) silently does nothing.

iOS is probably unaffected — it injects via a mechanism that runs outside the document's CSP — so this is likely an Android-only problem, and **nobody has tested it.** MP1's Android spike built an APK around a few player modules and two tone files, not the real page, so it never carried this CSP. `docs/mobile-shell.md` §5 has the full reasoning and the two possible fixes, neither of which is a one-token change.

**Steps.** No Android Studio needed, and **do not use an emulator** — MP1 spent ~75 minutes proving one will not boot on this hardware. A real phone over USB is faster and is the only thing that answers the question anyway.

1. Install **JDK 21** (Capacitor 8 dies on JDK 17 with `invalid source release: 21`) and the Android **platform tools** (for `adb`).
2. Build the app:

   ```bash
   cd mobile
   npm install
   npm run add:android
   cd android
   ./gradlew assembleDebug
   ```

   The APK lands at `mobile/android/app/build/outputs/apk/debug/app-debug.apk`.

3. Turn on **Developer options → USB debugging** on the phone, plug it in, and install:

   ```bash
   adb install -r app/build/outputs/apk/debug/app-debug.apk
   ```

4. Open the app on the phone. On the computer, open Chrome and go to **`chrome://inspect`**, then click **inspect** under the Foray app.
5. **In that console, type `Capacitor` and press enter.** Report which you get:
   - an object → **the bridge survived the CSP.** The risk is closed and the shell works as designed. Say so; it is the good outcome.
   - `Uncaught ReferenceError: Capacitor is not defined` → **the bridge is blocked.** Also copy any error containing "Content Security Policy". This is the outcome that changes the shell's shape, and finding it here costs 45 minutes instead of a rejected store build.
6. Either way, also say whether the four cards render and whether search works.

**Worked if:** there is a comment on #36 quoting what `Capacitor` evaluated to in the Android console, plus any CSP error text verbatim.

**Note added by #38 (2026-08-17) — iOS came out CLEAN, and that does not help you here.** `.github/workflows/ios-build.yml` booted the iOS Simulator and read `typeof window.Capacitor` off the real page under the real CSP: it is `object`, nine plugins registered, zero CSP violations. So on iOS the bridge survives.

**That is not evidence about Android, and the difference is the whole point of this item.** WKWebView injects via `WKUserScript`, which runs outside the document's CSP — which is exactly why iOS was expected to pass. Android's WebView injects an **inline `<script>` into the served HTML**, where a `<meta>` CSP does apply. The iOS result confirms the *mechanism* explanation in `docs/mobile-shell.md` §5, and that explanation is precisely the reason to expect Android to behave differently. **This stays open**, and one console line on a phone still settles it.

One iOS finding that does bear on your step 6, though: `navigator.serviceWorker` **does not exist at all** on `capacitor://localhost`, so the "app silently starts caching itself" half of the risk is impossible on iOS by construction. On Android the shell origin is `https://localhost`, where the API does exist — so that half of the concern is Android-specific too, and real.

**Status:** OPEN

---

### 19. Get an Apple Developer account and add seven secrets, so CI can put a build on TestFlight

**Tag:** `[BLOCKING]` for any iOS tester build · **Time:** ~20 minutes of clicking, plus up to 48 hours of Apple's review of the membership itself · **Owner:** whoever will own the Apple Developer Program membership · **Cost:** **$99/year** — this is a spend decision, so it is the founders' call and not an agent's (CLAUDE.md decision-authority item 3)

**Why it matters.** #38 built the iOS build in CI, and **it works without any of this**: `.github/workflows/ios-build.yml` compiles the shell unsigned on every run, for both the simulator and a real device's architecture, and that is deliberate — an unsigned build that always runs is worth more than a signing job that never does. But an unsigned build **cannot be installed on a phone**. Everything past "it compiles" — TestFlight, a tester, the locked-screen test that items #11 and #16 actually want — needs an Apple identity, and no amount of engineering substitutes for it.

**Decide first, in one line:** is $99/year worth spending now, or does iOS wait? If it waits, mark this `SKIP` with a few words and the workflow keeps doing the unsigned build; nothing breaks. Do **#15** (the permanent bundle id) before this either way — the App ID you register here is the one you live with.

**Steps.**

1. Join the Apple Developer Program at **`https://developer.apple.com/programs/enroll/`** ($99/year). Apple may take a day or two to approve.
2. In **App Store Connect** (`https://appstoreconnect.apple.com`) → **Users and Access** → **Integrations** → **App Store Connect API** → **+**, create a key with the **App Manager** role. You get three things, and the `.p8` file **downloads exactly once**:
   - the **Key ID** (10 characters)
   - the **Issuer ID** (a UUID, shown above the key list)
   - the file `AuthKey_<KeyID>.p8`
3. In the developer portal → **Certificates, Identifiers & Profiles**:
   - **Identifiers → +** → App IDs → App → Bundle ID **`com.jwincorporated.foray`** exactly (this is #15's value; if #15 rules differently, use that instead and say so here). Tick **Background Modes** under Capabilities.
   - **Certificates → +** → **Apple Distribution**. Follow Apple's instructions to create the CSR, download the `.cer`, open it so it lands in your Keychain, then in **Keychain Access** right-click the certificate → **Export** → `.p12`, and set a password. Keep both the file and the password.
   - **Profiles → +** → **App Store Connect** distribution profile for that App ID and that certificate. Download the `.mobileprovision`.
   - Note your **Team ID** (10 characters, top right of the developer portal, or under Membership details).
4. Base64-encode the three files. On a Mac:

   ```bash
   base64 -i Certificates.p12 | pbcopy
   base64 -i Foray_AppStore.mobileprovision | pbcopy
   base64 -i AuthKey_ABC1234567.p8 | pbcopy
   ```

5. At **`https://github.com/JW-Incorporated/foray/settings/secrets/actions`**, click **New repository secret** seven times and create **exactly these names** (the workflow reads these and no others — a typo means the gate reports the secret as missing):

   | Secret name | Value |
   |---|---|
   | `IOS_DIST_CERT_P12_BASE64` | base64 of the `.p12` |
   | `IOS_DIST_CERT_PASSWORD` | the password you set when exporting the `.p12` |
   | `IOS_PROVISIONING_PROFILE_BASE64` | base64 of the `.mobileprovision` |
   | `APPLE_TEAM_ID` | your 10-character Team ID |
   | `APP_STORE_CONNECT_KEY_ID` | the 10-character Key ID |
   | `APP_STORE_CONNECT_ISSUER_ID` | the Issuer ID UUID |
   | `APP_STORE_CONNECT_PRIVATE_KEY_BASE64` | base64 of the `AuthKey_*.p8` |

6. Run the workflow: **`https://github.com/JW-Incorporated/foray/actions/workflows/ios-build.yml`** → **Run workflow**.

**Two things to know before you start.**

- **Set all seven or none.** The workflow deliberately **fails** when only some are set, rather than skipping the upload quietly — a green run with no build on TestFlight is the failure nobody notices for a release cycle. So if you get interrupted halfway, either finish or delete what you added.
- **The upload path has never executed.** Every line of the archive/export/upload step is written from Apple's documentation, because no one here has ever had an account to test it against. Treat the first run as debugging, not as a release, and expect one or two fixes. Said plainly rather than discovered later.

**Worked if:** a run of `ios-build` shows `state=ready` at the "Is signing configured?" step and a build appears in App Store Connect → TestFlight. If it gets as far as `altool` and then fails, that is the expected first-run outcome and the log is the useful part — paste it and a session will fix the step.

**Status:** OPEN

---

### 20. Revoke one leaked anonymous Supabase session, and delete one CI artifact

**Tag:** `[BLOCKING]` for nothing, but do it today · **Time:** ~5 minutes ·
**Owner:** Wyatt (it is a credential, so CLAUDE.md decision-authority item 2 puts
it with a founder and not with an agent)

**Why it matters.** The `ios-shell-evidence` artifact of run
**32036295743** shipped the iOS Simulator's whole `localStorage` into a **public**
repo, and `cp_sb_session` was in it, decodable. It contains:

- an `access_token` — ES256 JWT, `role: authenticated`, `is_anonymous: true`,
  one-hour lifetime, **already expired**;
- a **`refresh_token`**, which does **not** expire on a timer and can be exchanged
  for fresh access tokens until it is revoked. **This is the part that still
  matters.**
- the project ref `qjdllvqdcgacvujhclny` and the user id
  `04ac9215-4acd-4067-8a1e-cf6797ace0f3`.

Per this file's own item on deleting user data, `cp_sb_session` is the **only**
credential that can reach that account's server rows. The blast radius is genuinely
small — a throwaway anonymous account created by a Simulator on a CI runner, whose
rows are a handful of probe events — but it is not zero while the refresh token
lives, and "small" is not a reason to leave a live credential in public.

**The leak itself is already fixed in the PR that files this** (the artifact now
redacts every non-probe value and no longer uploads the raw SQLite store), so this
item is *containment of the one that got out*, not a code change.

**Steps.**

1. In the Supabase dashboard for project **`qjdllvqdcgacvujhclny`**, open
   **Authentication → Users**, find user **`04ac9215-4acd-4067-8a1e-cf6797ace0f3`**
   (it will show as an anonymous user), and **delete** it. Deleting the user
   revokes its refresh token, which is the point — signing it out alone may leave
   the token usable depending on your session settings.
2. **Then** delete the artifact: open
   **`https://github.com/JW-Incorporated/foray/actions/runs/32036295743`** and use
   the artifact's **⋯ → Delete** control on `ios-shell-evidence` (3.5 MB).
   **ORDER MATTERS, AND SO DOES THE DELAY.** Do step 1 first — deleting the
   artifact does not revoke anything, and anyone who already downloaded it still
   has the token. And do not delete the artifact until `docs/ios-ci.md` §4c has
   landed on `main`: right now that artifact is the **only** place the 9,153 ms seam
   measurement exists, and deleting it first orphans every citation in these docs.
3. While you are in the dashboard, it is worth confirming that **anonymous sign-in
   is still intended to be enabled** (item #13's second verification note asks the
   same question for a different reason).

**Worked if:** requesting a token refresh with that `refresh_token` returns an
error rather than a new session, and the run page shows no `ios-shell-evidence`
artifact.

**Status:** OPEN

---

<!-- BEGIN generated:waiting-on-you -->

### Waiting on a founder (auto-maintained)

Generated by `node tools/ci/pr-triage.mjs waiting --write`, and re-rendered
into the run summary of `.github/workflows/pr-hygiene.yml` on every sweep.
Live, always-current view: <https://github.com/JW-Incorporated/foray/pulls?q=is%3Apr+is%3Aopen+label%3Aneeds-founder>

Everything the merge machinery could not land on its own ends up here, so
the residue is one batched glance instead of something anyone has to notice.

**Nothing is waiting on a founder right now.**

<!-- END generated:waiting-on-you -->

Two notes on the block above, both worth knowing:

- **It is generated. Do not hand-edit between the markers** — the next run
  replaces everything in there. Anything you want to keep goes outside them.
- **It is refreshed on demand, not on a timer.** The scheduled sweep cannot
  commit it: `main` is protected with zero bypass, and a PR opened by the
  Actions token triggers no workflows, so its required checks would never run
  and it could never merge. A personal access token would fix that and break
  "this repo's cloud automation is deliberately keyless" (CLAUDE.md
  decision-authority item 2), which is not a trade worth making for a list. So
  the always-current view is the link above and the `pr-hygiene` run summary;
  any session brings the committed copy up to date with one idempotent command:

  ```
  node tools/ci/pr-triage.mjs waiting --write
  ```

---

## DONE

*(Nothing filed yet. Finished items move here with the date they were done and
keep their number — the history is how we stop re-asking.)*
