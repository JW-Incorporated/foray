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

**Do #4 first.** #4 asks whether the six routines are alive. This item assumes
they are, and fixes a separate defect that has been costing 5/6 of their output
the whole time they *were* alive. Both are needed; neither substitutes.

**Why it matters.** `tools/classify/prepare-batch.mjs` supports sharding
(`--shard i/N` — take only shows where `Number(id) % N === i`). **The six
routines do not pass it.** All six run one shared prompt file with one literal
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

4. **Do not guess the shard string.** `--shard` currently fails *open*: a
   malformed value (`6/6`, `abc`, `0/0`, or a missing value) silently reverts to
   the full unsharded catalogue with no warning, recreating exactly the bug this
   item fixes. It must read `0/6`, `1/6`, `2/6`, `3/6`, `4/6`, `5/6` — one each,
   no duplicates, none of them `6/6`.

**One thing to expect, and it is not a fault.** Until an engineering PR lands the
matching prompt fix, an agent that re-reads `classify-batch.md` will still use
`--batch-size 40`, so early batches may come in around 40 rather than 50–60. The
sharding benefit does not depend on that; the four-week timeline does. A session
is picking it up.

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
