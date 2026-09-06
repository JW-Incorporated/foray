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

### 1. Make `path-policy` a required check on `main`

**Tag:** `[UPGRADE]` · **Time:** ~3 minutes · **Owner:** Wyatt

**Why it matters.** The allow/deny path list used to live inside the auto-merge
workflow, so it governed only what GitHub Actions did. On 2026-08-16 two PRs
were merged from a laptop with `gh pr merge` and a founder token and went
straight past it — not by defeating the deny-list, but because on that route
there was nothing to defeat. The policy is now one tested module
(`tools/ci/path-policy.mjs`) reported as a status check named `path-policy` on
every PR. It **blocks today**: since 2026-08-16 it fails a PR that
touches a governed path (`.github/`, `CLAUDE.md`, `docs/adr/`, `docs/roles.md`,
`backend/src/`, `tools/ci/`) without a founder's `founder-approved` label. What is
left is making it *required*, so a PR cannot merge while it is failing.

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
>
> **SATISFIED 2026-08-19.** The nightly refresh merged as **#284** at 11:45Z with
> `path-policy` **SUCCESS** in its checks, alongside `backend`, `data-and-site`,
> `automerge-decision`, `triage`, `ios-kit` and Vercel. Bot-authored PRs do get the
> check, which is the thing this was parked on. **Nothing is waiting on it now —
> step 2 is a founder click.**

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

**Added 2026-08-18, and it makes the decision smaller rather than larger.**
Narration items now carry a real duration into runtime accounting
(`docs/narrator-pipeline.md` §1.1), and that work needed **neither** number:
the 2.0 s beat is wall clock the manager spends between two items and has never
been part of authored runtime, and the 0.5 s padding is baked into the asset —
so a *measured* `duration_sec` carries it for free and an *estimated* one
deliberately does not guess it. `SEAM_GAP_SEC` is untouched at 2.0 s.
**This strengthens option one, "keep both, and say so"**: the two numbers are
now demonstrably in different systems, not just arguably.

One thing to settle alongside it while you have the brief open, and it is
narrower than it looks. `04_VOICE_AUDIO_SPEC.md` budgets a transition at **≤ 8 s**;
`docs/curation/narration-craft.md` §0 and §2b have **already ruled** for 8 s "or
12 s when the extra words are a required attribution, correction or structural
signpost", on the argument that naming a source properly costs 8-12 words before
the bridge says anything, so an 8 s ceiling makes a *required* attribution the
thing that gets cut. That reasoning looks right and is not being re-litigated
here. What is open is only that **nothing enforces either number** — the checker
gates narration-craft's 180 s hard max and nothing else, because a transition
budget needs a `mode` field the schema does not have. So the decision is: write
the 12 s exception into `04_VOICE_AUDIO_SPEC.md` so the brief stops contradicting
the ruling, and say whether the exception is worth a `mode` field to make
checkable.

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

> ## CHANGED 2026-08-30 — Foray #2 was PUBLISHED before this item was done, on your instruction. The listening is still owed.
>
> You asked for one Foray to be taken across the line so the Play listing could
> describe Forays without describing something no visitor can reach.
> `capital-types-1` is that Foray — `data/forays.json` now says
> `"status": "published"`, so `listForays` returns it to a visitor who did not
> ask for it by id. That was verified against the real documents through the real
> `player/foray-resolve.js`, but **not observed in a browser** — see the cold-load
> race in `foray2-capital.md` §11c. Why it was chosen
> over the other three, on measurements rather than taste, is
> `docs/curation/foray2-capital.md` §11a.
>
> **This item is therefore no longer blocking a publish; it is now a check on one
> that has already happened.** That is a weaker position than the one it was
> written for, and it is worth saying plainly: **the first Foray a stranger can
> reach is one nobody has listened to end to end.** Not "never heard" — item #11
> below records Wyatt playing this exact Foray on a phone on 2026-08-17, and that
> run is where the #224 evidence comes from. What has never happened is the
> sitting this item asks for. Every number in its write-up is a property of
> timestamps. Step 1 below is unchanged and is now the highest-value hour
> anybody can spend on this product. If it does not hold up, one word in
> `data/forays.json` reverts it and `tools/foray/check-forays.test.mjs` will tell
> you if you miss a step.
>
> **Two things to know before you listen**, both in `foray2-capital.md` §11b–c:
> rule **X1** ("a cross-episode seam always carries narration") is unmet at all 10
> of its cross-episode seams and **cannot** be met by any Foray in the repo without
> ElevenLabs spend you have not authorised; and **#224** is open, so on a phone
> with the screen off expect it to stop at a seam.

**[BLOCKING]** ~~for publishing Foray #2~~ **for trusting the published Foray #2** —
**~55 min of listening plus one decision.** Foray #2 (`capital-types-1`, 22
segments, 51:22) is authored, green, and — as of 2026-08-30 —
`status: "published"`. Write-up: `docs/curation/foray2-capital.md`.

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

> ## UPDATE 2026-08-17 — the edit is written; what is left is the merge and one console check. ~~2 minutes~~ ~1 minute.
>
> **`sw.js` now reads `const CACHE = "foray-v5";`**, carried by the #233 PR
> rather than as a change of its own. Steps 1 and 2 below are done.
>
> **AND THE MERGE HAPPENED, 2026-08-19.** This note used to end "the merge this
> item warns about is still yours ... `founder-approved` plus a click". It is not
> outstanding: the bump landed in **#241** (`ccd3c64`, *"Serve app.js, player/*.js
> and data/*.json from one generation (#233)"*), and `git show main:sw.js`
> confirms `foray-v5` on `main`. **Nothing about the bump is waiting on a
> founder.** What remains is the `forayStorageHealth()` console check below,
> which measures IndexedDB and which no test here can observe.
>
> **Read this before treating the item as closed, because the premise below was
> only half right.** This item says a returning visitor "runs the PREVIOUS
> `app.js` for one load", and calls that "the normal cost of every `app.js`
> change". It was not only a cost — it was a live defect (#233): the previous
> `app.js` ran against the CURRENT `data/*.json`, because the shell was
> cache-first while `data/` was network-first. So the bump was necessary and not
> sufficient, and the same PR removes the split policy that caused it. The
> storage-migration argument for bumping is unchanged and still correct.
>
> **What is still worth your minute:** the `forayStorageHealth()` check under
> "Worked if" below, after the deploy. That measures IndexedDB, which nothing in
> this PR touches and no test here can observe.
>
> Left `OPEN` because only the owner changes a Status word (`CLAUDE.md`
> § HUMAN-ACTIONS.md).

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

1. ~~Open `sw.js` at the repo root.~~ **Done — merged in #241 (`ccd3c64`).**
   `sw.js` on `main` reads `const CACHE = "foray-v5";` today. Steps 1 and 2 are
   history and are kept only so the diff below is legible. Cited by symbol
   rather than line number, per #281: the constant is `CACHE`, not "line 7".
2. It used to read:

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

**Status:** DONE — 2026-09-01. The `foray-v5` bump merged in #241 and `sw.js`
on `main` confirms it (`sw.js:82-85`); nothing about it is waiting on a
founder. The `forayStorageHealth()` console check above is a manual spot-check
a founder can still run at leisure, not a gate on this item.

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

> **Update, 2026-08-31:** the reconciler ran again (18 days after the first,
> 19,278 → 19,677 agent-classified shows), and it now blocks on a second
> problem that (b) does not fix by itself — see #27. Recommendation (b) below
> is unchanged and still correct; #27 is a prerequisite for it to keep
> working cleanly rather than a reason to prefer (a).

**Status:** OPEN

---

### 27. Rebase (or reconfigure) five of the six classify shard branches onto `main`, past PR #203

**Tag:** `[BLOCKING]` · **Time:** ~15 minutes, or a cloud-routine config change · **Owner:** Wyatt

**Why it matters.** PR #203 (2026-08-16) fixed the classify shard key from
`Number(id) % N` (2.20x unbalanced) to `fnv1a32(String(id)) % N` and merged to
`main`. Measured 2026-08-31, **five of the six live shard branches
(`origin/reclassify-0,1,2,4,5`) never received that fix** — they forked from
`origin/reclassify` on 2026-07-25 and have not merged or rebased onto `main`
since, so their committed `tools/classify/prepare-batch.mjs` is still the
pre-#203 file and computes the old, unbalanced key on every run, indefinitely.
(`origin/reclassify-3` is the exception: it has #203's code, apparently
copied in rather than merged — worth understanding, but not a problem by
itself.)

**This did not lose or misclassify any data — `reconcile-shards.mjs` was
fixed in the same change that found this (see `docs/agents/runners.md`'s
2026-08-31 update block) to correctly reconcile branches running either key,
indefinitely.** So this is not urgent in the sense of blocking today's
reconcile. It is real technical debt: the fleet will keep running an
unbalanced shard key that PR #203 measured as 2.20x skewed (shard0 would idle
around day 12 while shard3 still has 1.8x its share of work), and every future
reconcile has to keep reasoning about two shard keys instead of one.

**Two ways to actually fix it, pick one:**
- **Rebase the five branches onto `main`** (or a common ancestor that already
  has #203), so their `prepare-batch.mjs` starts computing the balanced key
  going forward. This is a repo operation an agent could do, EXCEPT the
  branches are driven by six always-on cloud routines that commit to them
  directly — a rebase done by hand here could be overwritten or conflict with
  the next scheduled run. **This needs Wyatt's judgment on whether the cloud
  routines can be safely paused for the rebase, which is outside what this
  repo's agents can see or control** (per CLAUDE.md decision authority #2,
  the routine configuration itself is Wyatt's Claude Cloud account, not this
  repo).
- **Point each routine's cloud config at code that already has #203** —
  functionally the same fix, applied at the routine-configuration layer
  instead of the branch layer. Whichever of #5/#10's `HUMAN-ACTIONS.md`
  history is current for "how these routines are configured" is the starting
  point.

**Worked if:** a fresh dry-run of `node tools/classify/reconcile-shards.mjs
--dry-run` some time after this ships reports `shard_key hashed` (not
`hashed+legacy`) for all six branches, meaning every branch's own new work is
using the current key exclusively.

**Status:** OPEN

---

### 11. Put a Foray on a real phone with the screen off — the one test no machine here can run

> **RUN A SECOND TIME, 2026-08-17, and both faults it found are now fixed.** Wyatt drove with the
> screen off. First result: *"Off screen play worked well, it didn't get hung up"* — which settled
> the entitlement question, because the Simulator's ~30 s suspension came from an **unsigned** build
> being unable to hold `com.apple.runningboard.assertions.webkit`. Second result, on the harder
> `capital-types-1` (**10 of 21 cross-episode seams** against `grilling-history-2`'s 5 of 9): it
> stopped at a seam and then resumed to the wrong place. The stop is **#224**; the transport lying
> about playing and the fabricated resume position were **#263**, fixed in **#266**.
>
> **What is still worth a phone:** two consecutive cross-episode seams with the screen off, on a
> build at or after `813bcc2`, and this time with the local diagnostic record open (**#264**) so the
> result carries seam durations instead of an anecdote. Android remains untested on a device.

**Tag:** `[BLOCKING]` for any store submission · **Time:** ~5 minutes to start, then a 15-minute walk · **Owner:** Joey (an iPhone) and/or Wyatt (an Android phone) — either one alone is worth doing

> **Substantially answered 2026-08-17. Wyatt ran this on a real phone and it FAILED — filed as #224.** The failure was not the one this item was written to catch. Read the two paragraphs below before running it again; what remains to test is narrower and specific.

**What the phone actually showed.** Wyatt played `grilling-history-1` in mobile Safari: *"The transitions worked ok while my phone was unlocked, but when my screen was off then it would just pause."* Traced cause, and it is ours rather than the platform's: at a seam the page is hidden **and silent**, which is the throttled state; the next segment's load then crosses `LOAD_SETTLE_TIMEOUT_MS = 10_000` in `player/html-audio-backend.js`, and `player/queue-manager.js:470` turns a load rejection into `E.error` → idle + pause. ~~**PR #227 (`c1c4e69`) is the fix**~~ — **NO. Corrected 2026-08-21 (#294): the prefetch never shipped, and #224 is still open.** `player/client.js` constructs `new HtmlAudioBackend({ telemetry: onTelemetry })` with no `prefetch` flag, so the warm element is never created. Two independent things block turning it on. **First, the premise above is wrong**: "the window in which a hidden page is provably *not* throttled" is the exact inference `player/html-audio-backend.js` §prefetch exists to retract — **media-element loads are throttled by VISIBILITY, DOM timers by AUDIBILITY**, and a warm load was measured taking +3.47 s *while audio was audible*. The 111 ms figure that made audibility look sufficient measured timers, not loads. **Second**, re-deriving the lead against hidden numbers gives 22 s of wall clock, and the window divides by playback rate — 22 s at 1x but **44 s at 2x**, against a **30 s hard floor** on segment length. Above **1.36x** a floor-length segment cannot fund the warm load, and the window still opens, so the seam pays the cold fallback *and* spends the bytes. **So expect the stop to still happen on a phone.** That is not a reason to skip the test — it is the reason to run it: #224 has never been reproduced with instrumentation, and the gate for re-opening the prefetch is a measurement of a hidden load completing inside an affordable lead, not another inference.

**The claim this item was written to settle came out the other way, and that part is closed.** The fear was that `timeupdate` would stop firing while backgrounded, letting a segment run a median **15.6 minutes** into the wrong episode. It fires. Measured in the iOS Simulator on a macOS runner (run 32026332637, and again in 32036295743): out-point overshoot **0.004–0.021 s** across a **15.03 s** genuinely hidden window, 61–62 hidden `timeupdate` samples at ~252 ms, hidden DOM timers at ~1000 ms, `resumedAtWall: null`. So **no native audio backend is needed on iOS**, and #28's iOS half is not the critical path. A simulator is still not a phone, and `SIMULATOR_CAVEAT` in `tools/mobile/ios-ci.mjs` says so on every report.

**What is still worth a phone, and it is now one specific thing.** Play a Foray across **at least two consecutive cross-episode seams with the screen off**, on `main` at or after `c1c4e69`. 16 of this Foray's 31 seams are cross-episode and pay a load; the other 15 are same-episode seeks and prove less. Two matters because the seam probe's own floor is `MIN_HIDDEN_TRANSITIONS = 2` — one transition can succeed inside WebKit's 5 s audible-activity grace (measured: `Starting timer to clear audible activity in 5 seconds`, `clearAudibleActivity` 5.006 s later) and the next still fail. **Android remains entirely untested on a device**, and an emulator is not a phone for the two things that decide it — power management and audio focus. The original emulator attempt failed outright: three boots, ~75 minutes, no output, recorded in §6.2 rather than dressed up.

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
6. **New, 2026-08-17 — and this is now the most useful thing you can report.**
   At each change of voice, does it sound like a **short deliberate pause** (about
   two seconds) or like the **app stopped and came back**? Say roughly how long
   the longest one felt. Why it is worth a sentence: the gap between two segments
   was measured at **9.2 seconds** on a backgrounded iOS Simulator (run
   32036295743) against the 2.0 seconds it is supposed to be, and all of the
   excess was the next episode loading after the pause had already started. The
   player now loads the next segment 12 seconds early, while the current one is
   still playing, so those gaps should be short. **Your ear is the acceptance
   test** — nothing on this machine can hear it.

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

> **NOW BLOCKING SOMETHING LIVE, 2026-08-23.** Wyatt has the D-U-N-S and is enrolling in
> both stores. Item **#19** says it plainly: *"Do #15 (the permanent bundle id) before this
> either way — the App ID you register here is the one you live with."* Registering an App ID
> is the moment this stops being reversible.
>
> **One thing changed since this was written.** The app is now called **4a** (#302); the
> proposed id read `com.jwincorporated.foray`. Ruled 2026-08-24 as `dev.jwlabs.foura`, and
> **re-ruled 2026-08-25: `ai.jwlabs.foura`**, after `jwlabs.ai` was bought and made the
> primary company domain with `jwlabs.dev` demoted to a redirect. A bundle id is
> invisible to users, and this one names the org that owns the repo and pays the Actions bill —
> but it should be a decision rather than an accident. The stitched-audio unit is still a
> *foray*, so the word is not retired either way.

**Tag:** `[BLOCKING]` for any store submission · **Time:** ~2 minutes · **Owner:** Wyatt (architecture)

**Why it matters.** The bundle id is the app's identity in both stores and it is **permanent once published** — changing it after a release means a brand-new listing, a new URL, and zero installs carried over. It is now written into a file and into a test, so it will not drift by accident, but nobody has actually agreed to it.

**RULED 2026-08-25: `ai.jwlabs.foura`.** Reverse-DNS of **`jwlabs.ai`**, which the company bought
and is making its primary domain; `jwlabs.dev` becomes a redirect. This replaces the 2026-08-24
ruling of `dev.jwlabs.foura` — same reasoning, newer domain, and a bundle id outlives a domain, so
it should name the one the company intends to keep. The old `com.jwincorporated` implied a domain
it does not hold at all. `foura` rather than `4a` because Capacitor uses one `appId` for the iOS
bundle id **and** the Android `applicationId`, and Android package segments must begin with a
letter, so a `4a` segment will not build — `ai` does, because it starts with a letter.

**The one thing to know before saying yes.** `ios/project.yml` — the old SwiftUI scaffold — says `com.wjduvall.foray`, which predates the org. That is a **different app** and it has never been published, so there is nothing to migrate. As of #36 that directory is reference material, not the shipping app (`docs/mobile-shell.md` §1); the shipping app is the Capacitor shell in `mobile/`. Leaving the two ids different is fine and is the current state.

**Steps.**

1. Open `mobile/capacitor.config.json`. Line 2 reads:

   ```json
   "appId": "ai.jwlabs.foura",
   ```

2. Reply either **"confirmed"**, or with the id you want instead.
3. If you want a different one, a session changes the id itself in **three** places — that file, the pinned assertion in `tools/mobile/shell-invariants.test.mjs` ("the app id is pinned, because it is permanent once published"), and `APP_ID` in `.github/workflows/ios-build.yml`, which is what `simctl` is given. This item said "exactly two" through two renames; `APP_ID` was the third all along, kept in sync by hand each time, and as of 2026-08-25 a test derives it from the config so a miss cannot be quiet. **A change to the reverse-DNS *prefix* is bigger than two lines**, because the Android plugin's Java package shares it: the 2026-08-25 move to `ai.jwlabs` touched 19 files, including a `git mv` of the Java source tree, `APP_ID` in `.github/workflows/ios-build.yml` and two fully-qualified needles in `.github/workflows/android-build.yml`. Still cheap, still not two lines.

**CONFIRMED BY WYATT 2026-09-03.** Asked directly, while assembling the App Store
submission kit, whether `ai.jwlabs.foura` is the id to publish under forever: *"bundle
ID is correct"*. That is the reply step 2 asks for, so this item is closed. Nothing in
`mobile/capacitor.config.json` changed — the value was already right; what was missing
was the ruling on it. The App ID registration in #19 can now proceed against
`ai.jwlabs.foura`, and that registration is the irreversible step.

**Worked if:** the status below says DONE and `mobile/capacitor.config.json`'s `appId` is the id you intend to publish under, forever.

**Status:** DONE (2026-09-03)

---

### 16. On a Mac: generate the iOS shell, add one `Info.plist` line, and build it

> **STATUS IS STALE — read the obsolescence box below before doing anything.** CI has built this
> on `macos-latest` and succeeded: simulator Debug **and** arm64 device Release, unsigned. Nothing
> here needs a Mac any more; what remains is **signing**, which is item **#19**.

**Tag:** no longer blocking for the build · **Time:** ~0 minutes — CI does this now · **Owner:** nobody; kept for the signing step only

> **Largely obsolete as of 2026-08-17 — do not follow the steps below as written; two of them are wrong.** PR #220 landed `.github/workflows/ios-build.yml`, a `macos-latest` job that does everything this item describes, and **it has already succeeded**: `BUILD SUCCEEDED` for the iOS Simulator (Debug) **and** for an arm64 device (Release, unsigned), with `window.Capacitor` present, 9 plugins loaded, **0 CSP violations**, and `UIBackgroundModes = ["audio"]` verified by Apple's own plist parser. Run it with `gh workflow run ios-build.yml --ref main -f probes=true`; ~8 minutes, free while the repo is public.
>
> **The steps below already carry their own correction — see the note under step 1: Capacitor 8 iOS is SwiftPM, so `brew install cocoapods` is unnecessary and there is no `App.xcworkspace`.** One thing that note does not cover: the CSP change is **no longer** "reasoned from WebKit's behaviour rather than observed" as the paragraph above claims — it was measured in-page at **0 violations**, from the `foray_probe_bridge` record. Incidentally `navigator.serviceWorker` does not exist at all under `capacitor://localhost`, so the stale-cache class of bug is impossible there by construction.

**What actually still needs a Mac, or rather an Apple account:** nothing for building. **Signing and TestFlight** need an Apple Developer account and secrets — that is item **#19**, and it is the real remaining gate. A device test with the screen off is item **#11**.

**Do item #15 first** if you regenerate by hand — the bundle id is baked into the generated project, and changing it afterwards means regenerating.

**Steps, for reference only — CI is the supported path.** All of these run from the repo root unless stated.

1. Install the toolchain, if it is not there. Xcode must be from the App Store, opened once so it accepts its licence. **Do not install CocoaPods — Capacitor 8 does not use it.**

2. Install the shell's dependencies and build the web bundle:

   ```bash
   cd mobile
   npm install
   npm run prepare:webdir
   ```

   **Worked if:** it prints something like `webDir ready: mobile/www  (35 files, 1.96 MB of 3.00 MB)`, followed by a `sliced:` line showing `data/discover.json` inside its own budget. If it prints a size *error* instead, stop and report it — that guard is doing its job and the fix is not to raise the cap. A `budget` error names one knob, `BUNDLED_ITEMS_PER_SHOW`; that one is safe to lower and `docs/mobile-shell.md` §3 says what it costs.

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

> **ANSWERED BY INFERENCE, NOT BY MEASUREMENT, 2026-08-17 (#232).** Our CSP does **not** block
> Capacitor's bridge: on 8.5.0 `Bridge.loadWebView()` prefers `WebViewCompat.addDocumentStartJavaScript`
> and nulls the injector, and on the fallback path the script lands at `indexOf("<head>")`, ahead of
> the CSP meta. **Nothing was executed in a WebView** — no emulator, no device — so this stays open
> as a measurement even though the reasoning is solid. Do not upgrade it to a measurement.

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

**Note added by #27's Android half (2026-08-18) — the same 45 minutes now answers four more questions, so read this before you do step 5.** `docs/android-lock-screen.md` §8.1 has the full list; the short version is that while you have that console open, these cost seconds each and every one of them is currently **unverified**:

- **`navigator.mediaSession.forayPolyfill`** → `true` means our stand-in for the switched-off API installed. If instead you get a `mediaSession` object with **no** `forayPolyfill` property, then **this WebView ships the real MediaSession API** and MP1 §5.4's central Android claim is wrong — which would be the most valuable thing anyone has found on this hardware. Say so loudly.
- **`window.ForayMediaSession.peek()`** → the exact payload the lock screen was last told. Compare it with what the screen actually shows.
- **`await Capacitor.nativePromise("ForayAudio", "state", {})`** → `running`, `sessionActive`, `notificationsEnabled`, `notificationPermission`. "The lock screen is blank" has at least three causes and only one of them is a bug in the code; those four fields tell them apart.
- **Then lock the phone and press each button** — play, pause, next, previous, the scrubber. Nothing about any of that has ever been observed. Also say whether a notification permission prompt appeared on your first play, because that is the one user-visible change in that branch and a founder may want it moved.

**Note added by the Play release work (`android-release.yml`) — the BRIDGE half of this item is now measurable in CI, and the rest of it is not.** The
`android-smoke` job boots an emulator on a GitHub runner, installs the app, and reads the live page over Chrome DevTools: `window.Capacitor`,
`Capacitor.nativePromise("ForayAudio", "state", {})`, and whether `app.js` rendered into `<main id="view">` at all. If that job is green, the top open risk in
this item — does our `script-src 'self'` block Capacitor's injected inline bridge on Android — is answered **by execution**, not by inference, and the answer is
in the run's own summary and its `webview-probe.json` artifact.

**That does not close this item, and the reason is not caution.** `docs/research/mp1-background-audio.md` §6.4 says which layers an emulator is faithful to
and which it is not: the **Chromium** layer is the same WebView with the same page scheduler, which is exactly the layer the CSP question lives in — so the
bridge verdict transfers. The layers it cannot reproduce are the ones every *other* question here lives in: Doze never engages, the cached-app freezer has no
reason to fire, OEM battery managers are untestable by construction, and there is no real audio routing, telephony or Bluetooth. The lock screen, the transport
buttons, the notification prompt and backgrounded playback are all still one phone and five minutes away, and nothing in CI will ever reach them.

**And the "do not use an emulator" instruction above still stands for YOU.** MP1 §6.2's ~75 minutes was this laptop, under WHPX, on an API-36 image. The CI job
pins API 34 and enables KVM explicitly — which is §6.3's own practical recommendation for exactly this case — and it is still the flakiest thing in the repo.
A phone over USB remains the faster and better instrument on your desk.

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
   - **Identifiers → +** → App IDs → App → Bundle ID **`ai.jwlabs.foura`** exactly (this is #15's ruling, re-ruled 2026-08-25 when `jwlabs.ai` became the primary domain — it is **not** the `dev.jwlabs.foura` an older read of #15 would have given you). Tick **Background Modes** under Capabilities.
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

> **FOUNDER REPORTS THE REVOKE IS DONE, 2026-08-17.** Wyatt: *"I did that urgent step on supabase but nothing else."*
> So the leaked anonymous session is revoked and **the credential half of this item is closed**.
> The artifact deletion is **still open**, and is now hygiene rather than urgent: the token it
> carried is inert. Delete artifact `9290947062` only **after** the numbers it holds are quoted in
> committed docs — for a while it was the only place the seam measurement existed.

**Tag:** `[BLOCKING]` · **Time:** ~5 minutes ·
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
   is still intended to be enabled** (item #13's *first* verification note asks the
   same question for a different reason).

**Worked if:** requesting a token refresh with that `refresh_token` returns an
error rather than a new session, and the run page shows no `ios-shell-evidence`
artifact.

**Status:** OPEN

---

### 21. After the next drive, copy the playback diagnostics out of the drawer

**Tag:** unblocks #224, #239 and every seam constant we are currently guessing at · **Time:** ~30 seconds after a drive · **Owner:** Wyatt (the only listener with a car)

**Why this exists, and it is short.** Two reports came out of your car in one
evening and neither carried a number, so each one restarted the diagnosis — #224
has been escalated, downgraded on one clean test, and re-escalated on a failure.
Five changes have shipped into the seam and transport area (#227, #235, #239,
#260, #266) with no field measurement between them, and #239's 20-second
hidden-load deadline was derived from a simulator loading a **local bundled
file**. Your car says that does not bound a cold cross-episode fetch on cellular.
So the player now writes down what it measures, and #264 is the mechanism. **This
item is the only way that record reaches anyone.**

**Steps.**

1. Before the drive, open the app's menu (☰) → **Playback diagnostics** → **Clear
   the record**. Optional, and it only makes the drive under test easier to find —
   the buffer holds about three Forays and drops the oldest first, so nothing is
   lost if you skip it.
2. Drive. Play a Foray with the screen off, as usual. Nothing else to do.
3. Afterwards, same menu → **Playback diagnostics** → **Copy**, and paste it into
   the issue or a message. It is plain text and about one line per event.

**What is in it, so you know what you are pasting.** Per seam: how long the gap
actually was, whether it was a cross-episode load or a seek inside one file, the
load deadline in force, and the last stage it reached if it never completed. Plus
out-point overshoot, external stops with the state the player landed in, resume
decisions including the ones that refused to write, every background/foreground
transition with its duration, and any press of a play or transport control that
failed — with the *class* of the error (for example `NotAllowedError`, meaning
the browser held the audio back), never its message, and with a count when the
same failure repeats. **It never leaves the device
on its own** — there is no consent gate on the existing event pipeline, so this
record deliberately does not ride it (`docs/legal/privacy-policy.md` §1,
`cp_diag`). Copying it is you choosing to send it. It contains no audio, no URLs
and no account id.

**Worked if:** one pasted record from a real drive. **The single most valuable
line in it is a seam that says `NEVER STARTED`** — that is #224, with the stage it
reached and the deadline it was measured against, which is the difference between
"the beat's timer never fired" and "the load never settled". Two different bugs,
two different fixes, and nothing here can tell them apart without this.

**Status:** OPEN

---

<!-- BEGIN generated:waiting-on-you -->

### Waiting on a founder (auto-maintained)

Generated by `node tools/ci/pr-triage.mjs waiting --write`, and re-rendered
into the run summary of `.github/workflows/pr-hygiene.yml` on every sweep.
Live, always-current view: <https://github.com/JW-Incorporated/foray/pulls?q=is%3Apr+is%3Aopen+label%3Aneeds-founder>

Everything the merge machinery could not land on its own ends up here, so
the residue is one batched glance instead of something anyone has to notice.

| PR | What it is | Why it needs you |
| --- | --- | --- |
| [#288](https://api.github.com/repos/JW-Incorporated/foray/pulls/288) | The Android build stops belonging to one machine: a Linux CI job, and a recipe for rebuilding the toolchain (#245) | Touches governed path `.github/workflows/android-build.yml` (matched DENIED `.github/`). |
| [#297](https://api.github.com/repos/JW-Incorporated/foray/pulls/297) | Wire the #290 watchdog in: one workflow to report the absence, one guard to stop the loss | Touches governed path `.github/workflows/nightly-refresh.yml` (matched DENIED `.github/`) and 1 more. |
| [#300](https://api.github.com/repos/JW-Incorporated/foray/pulls/300) | Topics were a per-show default nobody could appeal, so 77 of 99 substantial shows wore one label (#292) | Touches governed path `tools/test-search.mjs` (matched DENIED `tools/test-search.mjs`). |
| [#305](https://api.github.com/repos/JW-Incorporated/foray/pulls/305) | Record the 4a rename where decisions live, and stop the ADR re-seeding the ambiguity | Touches governed path `docs/DECISIONS.md` (matched DENIED `docs/DECISIONS.md`) and 1 more. |

To let a whole category of these merge unread instead, add its path to
`ALLOWED_PREFIXES` in `tools/ci/path-policy.mjs` — that is what #167/#168
did for `STATE.md`, and it converts a recurring merge into a one-line diff.

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

### 22. Rule on the alcohol Foray's product mode, and on three narration rules that collide

**[BLOCKING]** for any alcohol narration beyond the one built thread —
**~25 min of reading plus four decisions.** Everything below is set out with the
arithmetic in `docs/curation/narration-architecture.md`; §10a is the one that
matters and §13 is the list. Nothing has been generated and nothing has been
voiced, so all four are free to decide either way today.

**1. The product mode for alcohol.** The catalogue cannot fund this Foray as a
tape-led product. Measured, from `docs/curation/alcohol-forms-coverage.md`'s own
figures: 1 strong / 15 thin / 47 empty beats, 27.9 minutes of tape at the most
generous reading, and Act I — the education that was asked for — with no strong
tape at all. At the 25 % narration target the Foray is **179 seconds over before
a single empty beat is carried**; at the 35 % ceiling it funds **two** carried
beats of forty-seven, and Act I needs thirteen. Written in full it is **72.9 %
narrator**, against a 40 % line that `narration-craft.md` calls "an essay with
clips. Not a Foray." Three options, and the recommendation is B:

  - **A.** Ship a tape-led alcohol Foray: ~18 beats of 63, ~43 minutes, legal
    under every rule — **and with no Act I**, so it does not answer the request.
  - **B.** Declare a second product mode: narration-led, ~70 % narrator, tape as
    evidence rather than substance, a name that is not "Foray", and the editorial
    gate in `docs/curation/narration-architecture.md` §§5-7 as the price of
    admission.
  - **C.** Do not ship alcohol yet. Note that the coverage report says
    transcription cannot fix it — its whole queue would move six beats.

**Worked if:** one of A, B or C is written into `docs/DECISIONS.md` with a date.
That file is on `DENIED_PREFIXES`, so the entry needs a separate PR carrying the
`founder-approved` label; it was deliberately not added to the narration PR,
which would have lost that PR its auto-merge.

**2. Is a two-ended range one number or two?** `narration-craft.md` §5d allows
one number per sentence and three per narration item. Four sentences in the built
thread carry a range — *"between sixty-three and seventy degrees Celsius"*,
*"eighteen to twenty per cent"*. The architecture doc reads a range as **one**
numeric expression, on §5d's own stated reasoning that "a spoken number cannot be
re-read". If that reading is wrong, beat 7's core claim — the mash-temperature
dial — cannot be spoken at all. **Worked if:** one line in
`docs/curation/narration-craft.md` §5d saying which.

**3. The numbers cap against a quantitative act.** Separately from #2: the cap of
three numeric facts per narration item is written for an 8-second transition and
binds hardest on exactly the beats the alcohol spine designed to be quantitative.
It already cost the built thread one sourced, pinned, relevant fact. Beats 4 and
5 merge under another rule and carry five numeric facts between them, so **no
arrangement of them satisfies the cap.** The proposal is to restate it as a
density rule — one numeric fact per sentence, and one per twenty seconds of item,
minimum three. **Worked if:** the cap in §5d is either restated or confirmed
as-is with the consequence accepted.

**4. Two more, both in `docs/curation/narration-architecture.md` §13.** Whether
§2e's two-consecutive-narration-item cap bends for a chain (Act I has eight
consecutive empty beats and no assembly that §4c permits), and whether "U5
evidence-class attribution" — *"the reading rests on the genome rather than on any
record"* — is an acceptable substitute for the on-air source naming that the
never-read-references ruling removed. The second is the one that decides whether
a narration beat is honest, because it is now the only thing a listener hears
about where a claim came from.

**Status:** OPEN

---

### 23. Apply `founder-approved` to PR #297, so something watches for a dark night

**Tag:** `[APPROVAL]` · **Time:** ~2 minutes · **Owner:** Wyatt or Joey

**Why it matters.** On 2026-08-20 and 2026-08-21 the nightly content pipeline
produced nothing and every workflow in the list was green (#290). The Action did
its half both nights and logged *"published digest: 29 resolved episodes"* both
nights; the Cloud agent that turns a digest into a PR had hit a weekly usage
limit and simply did not run. The only symptom was an absence, and nothing in the
system watched for one. The second miss then overwrote the first night's digest —
`resolved.json` is replaced, not appended — and 2026-08-19 ended up holding 10
episodes against the previous Wednesday's 30. #293 recovered 17 by hand.

The checker landed in **#296** (merged, fully allowlisted). It is a command, not
a schedule, until the two workflow files in **#297** merge: `nightly-watch.yml`,
which goes red on a digest older than 12h with no `nightly/<date>` PR, and a
guard in `nightly-refresh.yml` that refuses to publish over an unmerged digest.

**What to do.** Apply the `founder-approved` label to
https://github.com/JW-Incorporated/foray/pull/297 and merge it. Every other check
on that PR is green; `path-policy` is red because `.github/` is a governed path
and `PATH_POLICY_ENFORCE=1` is live, which is the check doing its job.

**What you are approving.** Two workflow files. One new scheduled job at 21:40
UTC that only ever reads, and one new first step in `nightly-refresh` that can
fail the job before the scan. That second one is the one worth a moment: while it
is red, the pipeline publishes nothing. That is deliberate — it is what stops the
data loss — and it has an escape hatch, an `overwrite_unmerged_digest` dispatch
input for the case where the stranded episodes have aged out of the feeds. The
failing run prints the recovery steps, including the branch name that clears it.

**Until this merges**, a missed night is still invisible. The fallback is manual:
`node tools/refresh/watch-nightly.mjs --mode absence --digest <digest> --pulls
<pr-list> --discover data/discover.json` (see `tools/refresh/README.md`).

**Status:** OPEN

---

### 24. Amend ADR-0008: a ranged GET can be lied to as well, and 5,461 transcripts rest on that

**Tag:** `[DECISION]` · **Time:** ~15 minutes to read, four rulings · **Owner:** Wyatt

**Why it matters.** ADR-0008 §"What is actually measured, and how" says, in as
many words: *"**HEAD requests lie** on ad-inserting hosts: they return the
ad-free master's `Content-Length` while a real GET delivers the assembled file.
The first version of this scan used HEAD, reported 18 of 18 shows byte-stable,
and was completely wrong… **No conclusion in this ADR rests on a HEAD
request.**"* The 2-byte ranged GET was adopted as the honest replacement, and
every measurement since — 526 ranged GETs across 58 feeds — has been read as if
it cannot be lied to.

**It can.** On 2026-08-23 a decode-and-compare run (PR for #114) asked one Diary
Of A CEO enclosure how big it is four ways. Three cells agree; one does not:

| identity | request | reported length |
|---|---|---|
| `ForayBot/0.1` (our probe) | ranged | 67,510,022 |
| `ForayBot/0.1` | unranged | 67,510,022 |
| `Foray/0.1` (our client) | ranged | 67,510,022 |
| **`Foray/0.1`** | **unranged** | **68,884,898** |

Only an unranged request from a client identity is served the assembled file,
and two independent full downloads under that identity delivered exactly
68,884,898 bytes — 1,374,876 bytes, **114.6 s of audio at the file's 96 kbps**,
that the origin declares and does not send. The decoded file runs 139 s past its
own publisher transcript's last cue.

Two things make this hard to argue with. The difference is in the
`Content-Length` **header**, before any body is read, with no `Content-Encoding`
and no `Transfer-Encoding` — so it is not a download bug. And the short number
is not a compressed version of the long one: `67,510,022 × 8 ÷ 96,000 =
5,625.8 s` against a feed declaring **5,626 s**. It is the ad-free master, to a
fraction of a second.

**Our probe identity is the one being shown the master.** That host carries
**5,461 timed transcripts, 47% of the anchorable corpus.**

**What is already done and needs no ruling.** The measurement is committed
(`data/decode-and-compare.json`, including the four-cell grid, reproducible with
`--probe-grid`), `measure-suspects.mjs` now lets a decode overrule the byte
screen and records both verdicts, and every flightcast show is back to
`unresolved` except the one measured carrying undeclared audio, which is
`drop`. Nothing is
admitted on evidence now known to be blind.

**Updated after the probe grid was run over the six shows this item left open
(#324 follow-up).** Two of them — Success Story and Right About Now — are served
a longer file on the `client`/unranged cell and are now `drop`; the other four
returned one length in each of their episodes' four cells and stay `unresolved`.
Corpus figures:
`measured_clean` **5,381** (unchanged), `measured_unresolved` **3,452**, net
**8,833**, **60.9%** measured. The net fell by 1,914. Read the percentage with
care: the numerator did not move, the denominator shrank.

**A note on wording.** Below, "carries undeclared audio" is meant literally and
is all that was measured. Nothing in this work detects, locates or classifies an
advertisement, and it cannot — it counts frames (R11, product principle 3). The
extra seconds could be ads, a longer outro, a bonus segment or a different cut;
what makes them matter is that our authored timestamps do not account for
them.

**The four things only a founder should decide.**

1. **Does ADR-0008 get amended, and by whom?** `docs/adr/` is a governed path, so
   no agent can touch it. The sentence at risk is "No conclusion in this ADR
   rests on a HEAD request" — still true as written, and now misleading, because
   the reader's takeaway was "ranged GETs are safe" and on at least one platform
   they are not. The ADR's §3 remedy half-covers it ("where the feed declares
   `length="0"`, only a decode works"); what it does not say is that a length a
   host *does* report can be the master's.

2. **What do we spend to settle the other four flightcast shows?** ~~Six~~
   **Four**: Bankless (1,150), The Game with Alex Hormozi (1,141), The Wild
   Sovereign Soul Show (551) **and The Secret To Success (564)** — **3,406**
   transcripts.

   **The cheaper option below was run, and it answered two of the six.** The
   probe grid caught Success Story (1,264) and Right About Now (650) being
   served a longer file on the `client`/unranged cell, on 3 of 3 episodes each —
   #323's signature exactly. Both are `drop`; 1,914 transcripts left the
   anchorable count for 72 requests and no downloads. **This question is now
   about 3,406 transcripts, not 5,320, and the four that remain are the ones the
   grid could NOT settle** — their cells agree, which admits nothing on a host
   whose byte figures are master lengths.

   That last one is the surprise and it is the clearest illustration of what the
   instrument failure costs. The Secret To Success has a probe-corroborated
   decode showing **no excess audio**, and it is still `unresolved`: its host was
   caught delivering more than it declares, so its five ranged-GET samples are
   master lengths that cannot admit anything, and a single clean decode is below
   the two-sample floor. One more download of that show would recover 564
   transcripts on evidence we already know how to read. The remaining
   instrument that works is a full download, ADR-0008 wants **N ≥ 2 of the same
   episode**, and the committed override needs **2 decoded-clean episodes**
   before a show on this host can be admitted — so 4 downloads a show. That is
   **~16 downloads for the four, roughly 1 GB**, against ~24 (~1.2 GB) for the
   original six; The Secret To Success already has one of its four, so ~15 in
   practice. The grid removed a third of the shows, not two thirds of the
   budget, and the two figures are stated the same way on purpose.
   The alternative is leaving 3,406 transcripts permanently `unresolved`, which
   is honest, costs nothing, and never ends.

   ~~Cheaper option worth pricing first:~~ **Spent, and it is why the number
   above is 3,406.** `--probe-grid`, driven over the bucket by
   `regrid-clean.mjs --disposition unresolved --host flightcast`, cost 72
   requests and no audio and gave a per-show answer: 2 vary, 4 do not. As
   predicted it could not replace the downloads for the four whose cells agree —
   a grid that agrees is still only screened, not measured — but it removed 1,914
   transcripts from the question for the price of a rounding error, and it tells
   us how many downloads are left to buy.

3. **Do we now distrust the ranged GET everywhere, or only where it has been
   caught?** The shipped code takes the narrow reading: a host is blind only once
   a decode has caught it delivering more than it declared, and every other host
   keeps its byte evidence. The wide reading — treat every `Content-Range` total
   as unverified until a download or a probe grid corroborates it — would put
   ~4,000 more transcripts back into `unresolved` and turn a kilobyte scan into a
   gigabyte one. The narrow reading is what the evidence supports; the wide one
   is what a cautious reading of *two consecutive instrument failures* (HEAD,
   then ranged GET) would justify. Note the probe grid makes the wide reading
   much cheaper than it was when this question was first framed.

   **New evidence, and it does not decide this — it prices it.** The grid has
   now been run over 30 shows across both buckets (24 `recover` in #324, 6
   `unresolved` here). Two vary; 27 do not; one origin cannot be asked. Every
   varying show is on `atelier.flightcast.com`, the host already caught — so
   nothing yet argues for widening beyond it. But *within* that host the split
   is 2 of 6, which is the sharpest available argument that "caught" has to mean
   caught **per show** and not per hostname, whichever reading you take. This
   ruling is still yours.

4. **Around the House with Eric G carries 313 s of undeclared audio, and
   nothing consumes that fact.** Decoded 2593.33 s against a feed declaring
   2280 s and a transcript ending at 2279.2 s — 2.6× the ADR-0008 120 s ceiling,
   on a show whose feed-declared `length` is a computed 192 kbps placeholder (the
   #319 Enormocast `5242880` shape) that made the byte ratio read **0.758** and
   put the discrepancy underneath the floor rather than above the ceiling. The show is a curated `data/catalog.json`
   entry, so it is in neither breadth measurement file and the decode override
   never sees it. It is already excluded from transcript selection by
   `dai: true` plus `verdict: unknown`, so nothing is wrongly admitted today —
   but the finding should be routed into `data/dai-classification.json` or the
   show should be dropped explicitly, rather than being correct by accident.

**What to do.** Read `tools/transcribe/README.md` §5 (six downloads, the numbers,
the probe grid, and the two controls that separate the origin from its ad-tech
chain), then rule on 1–4. Nothing is blocked on this: the corpus figures are
already correct and conservative. What is blocked is knowing whether **3,406**
transcripts are usable — and one download of The Secret To Success would settle
564 of them.

**Status:** OPEN

---

### 25. Buy the company domain before writing either store listing — DONE

**Tag:** `[DONE 2026-08-25]` · **Owner:** nobody · **Cost:** $0 more

> **RESOLVED, AND THE ANSWER IS "DO NOT BUY ANYTHING".** `jwlabs.dev` was purchased
> 2026-08-24 — a historical fact, and the reason nothing further needs buying.
> **The live site, though, is `jwlabs.ai`**, bought 2026-08-25 and now the primary
> domain: it is built, deployed and verified live, and `jwlabs.dev` 301-redirects to
> it, path and query preserved. The three URLs a store listing needs already exist,
> in exactly the path shape this item specified, and they are the `jwlabs.ai` ones:
>
> | store field | URL | verified |
> |---|---|---|
> | Privacy Policy URL (both stores, required) | `https://jwlabs.ai/4a/privacy/` | HTTP 200, re-checked 2026-08-25 |
> | Support URL (Apple, required) | `https://jwlabs.ai/4a/support/` | HTTP 200, re-checked 2026-08-25 |
> | Marketing URL (optional) | `https://jwlabs.ai/4a/` | HTTP 200, re-checked 2026-08-25 |
>
> **Copy those exact URLs into a listing. Never the `jwlabs.dev` spellings.**
> Measured again from this machine on 2026-08-25: each `jwlabs.ai` URL above returns
> **200**, and each `jwlabs.dev` equivalent returns **301** to it. A `.dev` URL in a
> published listing therefore resolves only for as long as one Cloudflare redirect
> rule survives on a zone kept alive for that redirect alone — and both stores
> re-check these URLs for the life of the app, which makes that a compliance failure
> rather than a broken link. (This table first read `jwlabs.dev` … `HTTP 200`, which
> was **true when it was written**: `jwlabs.ai` was not registered until later the
> same day. It went stale at the cutover; it was never wrong.)
>
> **`jwincorporated.com` must NOT be bought**, and the illustrative block below is
> left as written only as the record of what was proposed. Three reasons, and they
> compound:
>
> 1. **It names a company that does not exist.** The legal entity is **JW Labs LLC**,
>    filed in California 2026-07-26. "JW Incorporated" was never the entity; it was an
>    error that propagated into this file, the website and — most seriously — the
>    published privacy policy, which named it as the **data controller**.
> 2. **The requirement is already met**, at no further cost, on a domain that matches
>    the entity name — and so does the app id, `ai.jwlabs.foura` (#15). The two are no
>    longer the same TLD: the app id moved to `ai.jwlabs` on 2026-08-25 when `jwlabs.ai`
>    became the primary domain and `jwlabs.dev` became a redirect. **That does not
>    reopen this item.** The store fields want a URL that resolves and a domain
>    associated with the organisation, not a domain that spells the bundle id; both
>    domains are JW Labs LLC's. The three URLs above **have** now been re-pointed at
>    `jwlabs.ai`, so there is no decision left for whoever writes the listing: use the
>    table as written. A 301 would satisfy both stores on the day, but it is a
>    dependency on a redirect rule rather than an address, which is why the table no
>    longer offers the choice.
> 3. **It would manufacture the exact defect Apple rejected us for.** Apple declined
>    enrollment `DVNC3U5GMU` in part because the website's domain was not associated
>    with the organisation. Buying a domain whose name does not match the entity
>    recreates that, deliberately, after paying to fix it.
>
> A consumer-facing `.com` remains a reasonable *marketing* purchase some day — but
> then `jwlabs.com` or similar, matching the entity. It blocks nothing and no store
> requires it. Every URL above is `https://` and HTTPS works, which is what both
> stores want — but **that is now a convention, not an enforcement, and it used to be
> an enforcement.** While these pages were on `.dev` they were HTTPS-only for free,
> because `.dev` is HSTS-preloaded. **`.ai` is not preloaded**, and measured
> 2026-08-25 `http://jwlabs.ai/` returns **200 in cleartext** — no redirect to HTTPS,
> and no `Strict-Transport-Security` header on the HTTPS response. So Cloudflare's
> "Always Use HTTPS" is off and nothing upgrades a plaintext visitor. Worth a
> founder's click before a listing points a store at a privacy policy over `http`;
> tracked separately as the website repo's `https_enforced: false`.
>
> **Two live dependencies, recorded because both are invisible from this repo:**
>
> 1. **`jwlabs.ai` is served by GitHub Pages *through Cloudflare*, and the proxy is
>    load-bearing.** Cloudflare terminates TLS; the Pages origin behind it presents
>    `CN=*.github.io`, because GitHub issued no certificate for the custom domain —
>    verified 2026-08-25, `gh api repos/JW-Incorporated/jwlabs.dev/pages` reports
>    `https_certificate: null` and `https_enforced: false`. Turning the `jwlabs.ai`
>    DNS records grey brings back a certificate error on the live company site.
>    Details in that repo's README, "How this is served".
> 2. **The `jwlabs.dev` zone must keep resolving to Cloudflare.** Pages spends its one
>    custom domain on `jwlabs.ai`, so `jwlabs.dev` is no longer served by Pages at
>    all. The only things answering on it are the Cloudflare 301 rule — which is what
>    keeps every stale `.dev` URL in the wild alive, including the one on the Apple
>    enrollment record — and the still-working `help@jwlabs.dev` alias. Deleting the
>    zone, or greying its records, takes out both at once.

**Why it matters.** Both stores require a **Privacy Policy URL**; Apple also requires a
**Support URL**. Those URLs must stay live for the life of the app — both stores re-check
them after publication, and a dead one is a compliance problem rather than a cosmetic one.

**The org will ship more than one app.** `JW-Incorporated` already holds `foray`, `swift2`
and `starter-kit`. That makes this a company-level decision, not a 4a one.

**What is wrong with what exists today.** The only public URL is
`jw-incorporated.github.io/foray/docs/legal/privacy-policy.md`. It returns 200 — Pages serves
the repo root, so the file is reachable — but it bakes in three things you do not want
permanently attached to 4a's legally-required privacy URL:

- the repo name **foray**, for an app now called **4a**;
- a **code host's domain** the company does not own;
- a raw `.md` path, which browsers render as unformatted text.

**Privacy policies are per-app, not per-company.** 4a's describes `cp_` keys, IndexedDB and an
anonymous session token. When a second app ships with different data handling, one shared
policy is wrong in the direction stores care about. So: company domain, per-app paths.

```
jwincorporated.com/            company — who you are, the app list
jwincorporated.com/4a/         app page      -> Marketing URL (optional)
jwincorporated.com/4a/privacy  policy        -> Privacy Policy URL (required)
jwincorporated.com/4a/support  contact + FAQ -> Support URL (Apple, required)
```

> *(An earlier 2026-08-25 note offering a choice between two domains is superseded
> by the resolution above: the choice was made and the site is live.)*

**Why the order matters, and it is the whole reason this is filed.** The free alternative is a
GitHub org Pages site (a repo named exactly `jw-incorporated.github.io`; there is none today —
`jw-incorporated.github.io/` returns **404**). That works, but if a real domain is added later,
**every URL changes**, and you would be editing live store listings for two apps to chase them.
Buying first and pointing the domain at the Pages repo via `CNAME` means the listings are
written once.

**Steps.**

1. Buy a domain. Reply with it.
2. A session builds the static site — no dependencies, same CSP discipline as the app — and
   renders 4a's existing `docs/legal/privacy-policy.md` and `data-safety.md` as real pages.
   Those documents already exist and were renamed to 4a in #304.
3. The listing fields in **#42** then have stable URLs to quote.

**Worked if:** the three URLs above resolve, and #42's listing draft quotes them.

**Status:** OPEN

### 26. Publish the Play Store listing from `docs/store/play/`

**Tag:** `[BLOCKING]` · **Time:** ~40 minutes, plus IARC and Data safety · **Owner:** Joey

**Why it matters.** Every asset Play requires for 4a now exists and is checked
in — the 1024x500 feature graphic, four 720x1280 phone screenshots, the short and
full descriptions. None of it reaches the store without a founder in the Play
Console: it needs the developer account's identity and login, and it is a
click-through UI no agent can reach. The package was assembled so that this is
copying, not writing.

**Everything you need is in one file: `docs/store/play/README.md`.** It is
ordered the way the Console's form is, names the field for every value, and says
which of the two pages each one lives on. The literals, so they are also here:

| field | value |
|---|---|
| App name | `4a` |
| Short description | `docs/store/play/short-description.txt` (71 chars) |
| Full description | `docs/store/play/full-description.txt` (2202 chars) |
| App icon (512) | `docs/store/play/app-icon-512.png` — **not** the `icon-512.png` in the repo root, which Play rejected (24-bit, and the mark filled 41% of the square). README §4 says why there are two. |
| Feature graphic | `docs/store/play/feature-graphic.png` |
| Phone screenshots | the four `docs/store/play/screenshot-*.jpg`, in filename order |
| Category | Music & Audio |
| Privacy policy URL | `https://jwlabs.ai/4a/privacy/` |
| Ads | **No, my app does not contain ads.** |
| Data safety | answer from `docs/legal/data-safety.md`, question by question |

**Two things that will otherwise catch you out.**

- **"Main store listing" is not the whole form.** The listing cannot go live
  until **Policy and programs → App content** is complete: Data safety, the IARC
  content-rating questionnaire, the ads declaration, target audience, and the
  privacy policy URL. README §8 covers it. This is the step that turns a
  40-minute job into an afternoon, so start it early.
- ~~**Nothing in the copy mentions forays**, and that is deliberate rather than an
  oversight. Every Foray in `data/forays.json` is `status: "draft"` and reachable
  only by opening its id in the URL, so a Play visitor cannot get to one;
  advertising it would be advertising a feature they cannot use.~~
  **CHANGED 2026-08-30 — the premise is gone, and the copy is now the thing that
  is out of date.** `capital-types-1` is `status: "published"`, so it is listed on
  the home screen for an ordinary visitor and a Play visitor **can** get to it.
  The same now applies to the thumbs-up/down voting and its reason chips, which
  are rendered only inside a Foray. **So this listing is now worth rewriting** —
  a Foray is the strongest thing there is to say about the app, and the copy does
  not say it.

  **Three things the copy must not claim**, because they are not true:
  *(a)* not "Forays", plural, as a browsable library — there is exactly **one**
  published, 51 minutes, on how a startup raises money, and the other three are
  still drafts; *(b)* nothing about narration, a host or a guide — a Foray is
  edited tape with a 2.0 s beat between segments and **no narration audio exists
  anywhere in the repo** (`foray2-capital.md` §11b); *(c)* nothing that promises
  reliable background playback, because **#224** is open and item #11 below
  records that on a phone with the screen off it is expected to stop at a seam.
  The reasoning behind what is deliberately absent is in README's "What is
  deliberately not in this package".

**Do not retype any of the copy.** The character counts above are asserted
against the files by `tools/store/play-listing.test.mjs`, so what is in the file
is what fits the field. Paste whole files.

**Worked if:** the Play Console shows the listing as complete with no red
warnings on Main store listing or App content, and `4a` resolves in a Play search
or on its own store URL.

**See also:** items **#41** (Play Console API access + service account, so
automated uploads can reach this listing) and **#42** (the mandatory first
manual upload) both depend on this listing existing — `docs/release-lockstep-plan.md`
G1/G2/G3.

**Status:** OPEN

---
---

### 30. Back up the Android upload key, and install its three secrets

> **Renumbered from #26, 2026-09-01.** #26 was already in use for "Publish the
> Play Store listing" (above); item numbers are stable IDs and are never
> reused (see the rule at the top of this file), so this action — added later
> under the same number by mistake — takes the next unused ID instead. Any
> reference elsewhere in the repo to "HUMAN-ACTIONS.md #26" meaning the
> upload-key backup has been updated to #30.

**Tag:** `[BLOCKING]` for any Play upload · **Time:** ~10 minutes · **Owner:** Wyatt (he holds the key)

**Why it matters.** There are now two halves to the Play path and only one of
them is done. `.github/workflows/android-release.yml` produces a verified,
signed `.aab` — but only if it can reach the upload key, and the key is a file on
one Windows machine.

**The irreversible part is the backup, not the secrets.** The secrets can be
re-set in thirty seconds from the key. The key cannot be re-created from
anything: if `foura-upload.p12` and its password are both lost, **this app can
never be updated again**, and recovery means Google's key-reset process, which
only exists for apps already enrolled in Play App Signing. Everything else on
this list is a delay; this one is a wall.

**Steps.**

1. **Back the key up, in two places that do not fail together.**
   `C:\Users\wjduv\Documents\JW Labs\android-signing\foura-upload.p12` plus its
   password go into a password-manager entry *with the file attached*, and one
   offline copy — an encrypted stick or a second machine — not synced to the same
   account. A second copy in the same cloud drive is not a second copy.
2. **Verify it is the right file** (read-only, generates nothing):

   ```bash
   keytool -list -v -storetype PKCS12 -keystore "C:\Users\wjduv\Documents\JW Labs\android-signing\foura-upload.p12"
   ```

   The `SHA256:` line must be
   `92:92:D8:5B:96:32:05:B4:00:45:BC:26:FC:00:9A:C4:10:B1:12:F6:85:C6:88:75:82:32:48:04:DA:1F:8C:19`.
   That value is also pinned in the workflow, so a mismatch here means the build
   will refuse the file rather than sign with it.
3. **Set the three secrets**, from files rather than by typing them, so the
   values never enter a shell history or a transcript. `docs/android-release.md`
   §2 has the exact `gh secret set` lines. The names are
   `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_ALIAS` —
   **three, not four**: a PKCS12 store has one password, so there is no
   `ANDROID_KEY_PASSWORD`.
4. Run **Actions → android-release → Run workflow** with `version_code: 1`.
   Nothing in the run needs to be watched; the summary states whether the bundle
   is signed and submittable, and names the artifact to download.
5. When the Play listing is created, **accept Play App Signing.** It is what
   makes step 1's worst case survivable at all.

**Worked if:** an `android-release` run reports signature **signed** on its
summary page, and you can say where the two backups are without looking.

**Reconciled 2026-09-06 (kanban card R-06).** `gh secret list` on this repo
confirms all three secrets exist and were set together on 2026-08-26:
`ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`. That
closes steps 1–3 above from the automation's point of view — an
`android-release` workflow run can sign a bundle today. Marked **DONE** on
that basis. Two things are **not** verified by this reconciliation and are
not this item's job: (a) whether the two *physical/off-repo* backups in step 1
(password manager + offline copy) actually exist — only Wyatt, who holds the
key, can attest to that, and no automated check can; (b) `docs/release-lockstep-plan.md`
records that the only `workflow_dispatch` of `android-release.yml` from `main`
(2026-08-30) **failed** — that is tracked separately as R-04 in the same plan,
not reopened here, because it is a pipeline-health question, not a
missing-secret one.

**Status:** DONE (secrets confirmed present 2026-09-06; physical key-backup
attestation and the 2026-08-30 failed run are tracked elsewhere, see above).

---

### 41. Play Console: create the API service account for automated uploads (G2)

**Tag:** `[BLOCKING]` for R-03's automated Play upload · **Time:** ~10 minutes ·
**Owner:** Joey/Wyatt · **Depends on:** #26 (the Play listing must exist first)

**Why it matters.** `docs/release-lockstep-plan.md` (R-03) adds an automated
Android upload to Play's internal testing track, the same way the iOS workflow
already uploads to TestFlight. That upload authenticates as a Google Cloud
service account, not a person, and nothing in this repo can create that
account — it is a click-through flow in the Play Console tied to the
developer account's identity.

**Steps, with the exact menu path.**

1. In the **Play Console**, open the app (`4a`), then go to
   **Setup → API access**.
2. If no Google Cloud project is linked yet, follow the prompt to **link (or
   create) a Google Cloud project** — Play Console does this step for you.
3. Under that linked project, **create a new service account** (Play Console
   deep-links you straight into the Google Cloud IAM console for this step).
4. Back in Play Console's **API access** page, grant the new service account
   access to this app with the role **`Release manager`** — this is the
   minimum role that can upload and manage releases without also granting
   store-listing or financial-data access.
5. In Google Cloud IAM, generate a **JSON key** for that service account and
   download it.
6. Add the whole JSON file as a GitHub repo secret named exactly
   **`PLAY_SERVICE_ACCOUNT_JSON`** — from the file, not retyped
   (`gh secret set PLAY_SERVICE_ACCOUNT_JSON < path/to/key.json`), so the key
   material never enters a shell history or a transcript.

**Worked if:** the Play Console's API access page shows the service account
listed with **Release manager** access to `4a`, and
`gh secret list` shows `PLAY_SERVICE_ACCOUNT_JSON` present. That is what
unblocks R-03's Play upload job — until this secret exists, `release.yml`'s
Android job is written to skip loudly rather than fail (see
`docs/release-lockstep-plan.md` R-03), so nothing breaks in the meantime, but
nothing uploads either.

**Status:** OPEN

---

### 42. The first Play upload for `4a` must be done by hand, with versionCode 1 (G3)

**Tag:** `[BLOCKING]` for R-03's automated Play upload to ever succeed ·
**Time:** ~10 minutes · **Owner:** Joey/Wyatt · **Depends on:** #26 (listing),
#41 (service account) — do this one **last**, after both.

**Why it matters.** Google's Play Developer API can update an *existing*
release but cannot create the very first one for a brand-new app — that step
is Console-UI-only, no API path exists. Until one build has been uploaded by
hand, the automated `release.yml` job (R-03) has nothing to attach an update
to and will fail every time it runs, regardless of how correctly the service
account is configured.

**Steps.**

1. Run **Actions → android-release → Run workflow** (or reuse the artifact
   from item #30's step 4) to produce a signed `.aab`.
2. In the **Play Console**, open `4a` → **Release → Testing → Internal
   testing** → **Create new release**, and upload that `.aab` by hand.
3. **The first upload must be manual, and it must use `versionCode 1`** —
   set that explicitly if the Console does not infer it from the bundle.
   This value must sit **below** whatever `docs/release-lockstep-plan.md`
   R-02's automated version scheme (`YYYYMMDDnn`, e.g. `2609061` and up)
   will generate next, so the first automated upload never collides with
   this manual one. Using `1` guarantees that with room to spare.
4. Roll it out to the internal testing track and confirm the release shows
   as **live** on that track in the Console (an app with zero prior Play
   releases needs this one accepted before the API will touch it at all).

**Worked if:** the Play Console's Internal testing track shows one release at
`versionCode 1`, and a subsequent `release.yml` run (R-03/R-07, once #41's
secret exists) can upload `versionCode 2` and higher without Google's API
rejecting it as "no existing release to update."

**Status:** OPEN

---

### 28. Run the new AMD/Vulkan transcription path on your actual RX 6700 XT and report the numbers

**Tag:** `[BLOCKING]` for AMD-GPU throughput numbers · **Time:** ~20 minutes (mostly download/setup) · **Owner:** Joey (his machine, his GPU)

**Why this exists.** `tools/transcribe` §3 only ever worked for NVIDIA cards
— CUDA is NVIDIA-proprietary, and `faster-whisper`/`ctranslate2` (the whole
CPU/CUDA stack) has no AMD support at all, not even a slow one. Your RX 6700
XT could not use the GPU path that existed before this change; it would
either error outright or (worse) silently run CPU speed while claiming
`--device cuda`. §3b adds a real second engine — whisper.cpp with a Vulkan
backend — chosen specifically because Vulkan runs on AMD cards including
RDNA2 (your 6700 XT) without AMD's own ROCm toolkit, which does not
officially support the 6700 XT at all.

**What is proven vs. not.** This sandbox has no AMD GPU (it has no GPU of
any kind), so everything that could be checked here *was* checked: the new
`bench_whispercpp.py` script and a from-source CPU build of whisper.cpp
were run end-to-end against a real audio sample, produced a correct
transcript, and printed the same JSON shape `bench.py` already produces —
so the code path itself is not broken. **What was not, and could not be,
checked here:** whether the Vulkan backend actually engages your GPU, and
how fast it runs. Every throughput number anyone gives you for this path
until you run it yourself is a claim from someone else's card, not a
measurement of yours.

**Steps.**

1. Follow `tools/transcribe/README.md` §3b exactly — download a
   Vulkan-enabled `whisper-cli.exe` (prebuilt, no compiling needed for most
   people), grab one `ggml-base.en.bin` model file, and run
   `bench_whispercpp.py` against one podcast episode (any episode already on
   your machine from earlier testing works, or fetch one the same way §1
   describes).
2. **Confirm the GPU actually engaged.** The run's console output should
   show a line like `ggml_vulkan: 0 = AMD Radeon RX 6700 XT (...)` near the
   top. If you only see CPU info, stop and say so — that means the setup
   grabbed a CPU-only build by mistake, not that the GPU path doesn't work.
3. Paste the JSON line the script prints at the end (starts with
   `{"audio": ...`) into a comment on this repo's kanban board or wherever
   you're reporting back. That line alone has everything needed to update
   §3b's "expected, not measured" numbers with real ones.
4. If it errors, paste the exact error — most likely failure modes are (a)
   `whisper-cli.exe` can't find its DLLs (they must sit next to the .exe,
   not just be downloaded), or (b) an old/mismatched GPU driver not
   supporting Vulkan 1.3 (a driver update from AMD's site fixes this).

**Worked if:** you have a real `realtime_multiple` number for your RX 6700
XT on at least one model size, and the Vulkan device line confirms the GPU
(not the CPU) produced it.

**Status:** OPEN

---

### 29. Test whether on-device narration survives a locked screen on a real iPhone

**Tag:** `[BLOCKING]` for `Foray_Generation_Architecture.md` §1.2/§9.1 · **Time:** ~5 minutes once a build exists, then a 40-second listen · **Owner:** whoever has the iPhone

**Why it matters.** `Foray_Generation_Architecture.md` §9.1 flags this as the single
highest-priority open question in the whole generation-architecture spec: *"Measure
this before anything else in this document is built."* `docs/research/mp1-background-audio.md`
already measured that a plain `<audio>` element survives a locked screen on iOS
(0.0045 s out-point overshoot) — but `AVSpeechSynthesizer` (the native TTS plugin,
`mobile/plugins/foray-tts/`) is a different API, and nobody has measured whether it
gets the same treatment. `docs/research/on-device-tts.md` §9 (added 2026-09-01) worked
through everything documentation alone can settle: `AVSpeechSynthesizer` *can*
inherit the app's background-audio grant by default (`usesApplicationAudioSession = true`,
per Apple's WWDC20 session 10022), but *"will use"* is not *"will configure"* — so
whether it actually holds up on a locked phone is genuinely unknown without a device
test, even now that the plugin claims the session itself (see below). The Web Speech API path
(`speechSynthesis`, no native plugin) has no such documented mechanism at all and is
the weaker candidate either way.

**Which version you are testing (both prerequisites have landed).** `on-device-tts.md`
§9.4 asked for one plugin fix before this test, so that a failure could not just mean
"the audio session was never activated". Both of these are now in `main`:

1. **The audio-session fix — landed 2026-09-01, PR #389.** `ForayTtsPlugin.swift`
   now calls `AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio,
   options: [])` and `setActive(true)` immediately before `synthesizer.speak(utterance)`.
2. **A speech-rate fix found while building this test.** The plugin was assigning the
   player's speed multiplier straight onto `AVSpeechUtterance.rate`. Those are different
   scales: the player's `1` means "normal speed", but `AVSpeechUtterance.rate = 1.0` is
   `AVSpeechUtteranceMaximumSpeechRate` — the fastest the synthesiser goes. Every
   narration line would have been read at top speed, which would have made this test
   unreadable and its result meaningless. `ForayTtsPlugin.utteranceRate(playbackMultiplier:)`
   now maps `1` onto `AVSpeechUtteranceDefaultSpeechRate`.

So report this as **the fixed plugin**, not the unfixed one. Neither fix has been heard
on a device — only compiled — which is part of what you are checking.

**What was built for you.** `data/forays.json` now carries one Foray,
`tts-locked-screen-check`, titled **"On-device narration, screen off"**. Its first item
is a single spoken line of about **99 seconds** that names a marker every ten seconds
("Marker one, ten seconds… Marker nine, ninety seconds"), so **whichever marker you hear
last IS the measurement** — you do not have to time anything. It is a `draft`, so the
public website never lists it; the native app lists it because
`withDiagnosticUnlock()` in `player/foray-resolve.js` unlocks that one id when
`window.Capacitor` exists. The line is the FIRST item and the queue does not yet advance
past a spoken item, so nothing else will start playing over it — that is deliberate.

**Steps.**

1. **Get the build.** Two ways, in order of preference:
   - The `ios-build` run for the PR that added this already tried to upload to
     TestFlight (it triggers on `player/**` and `mobile/**`). Open TestFlight on the
     iPhone and look for a new build of **`4a`**.
   - If nothing is there, go to
     `https://github.com/JW-Incorporated/foray/actions/workflows/ios-build.yml`,
     press **Run workflow**, branch **`main`**, leave `probes` as-is, press the green
     **Run workflow** button, and wait for the job **`ios-shell`** to finish.
   - **Expect this to be the hard part.** The TestFlight upload has never once
     succeeded end to end (item #19). If the run is red at the step
     **"Archive, export and upload to TestFlight"**, that is a separate problem — paste
     the failing step's log and stop here; nothing below is testable yet.
2. **Install it** from TestFlight on the iPhone and open **`4a`**.
3. **On the home screen, find the row that reads `foray · draft` above the title
   "On-device narration, screen off"** and tap it. If that row is not there, the build
   predates this change — check the build number against the PR.
4. Turn the **ringer/volume up** so you can hear it in your pocket, then press the big
   **play** button. Within a second or two a voice starts: *"This is the on-device
   narration test for Foray. Lock the phone now and keep listening."*
5. **Lock the phone immediately** (side button) and put it in your pocket. Keep
   listening — the whole point is that you can hear exactly where it stops.
6. **Listen for at least 40 seconds.** The line names its own markers, so you do not
   need a stopwatch: you want to get past *"Marker three, thirty seconds"* at minimum.
7. Unlock and note two things:
   - **the last marker you heard** (or "it never stopped" — the line ends with
     *"Marker nine, ninety seconds"* and then a closing sentence);
   - **whether the voice came back on its own** when you unlocked, or stayed silent.
     A voice that resumes was paused by the system; a voice that never returns was
     stopped, and those are different problems with different fixes.
8. **Report back in this exact form:** `native TTS plugin (session + rate fixes),
   locked screen, last marker heard = <N or "none — played through">, resumed on
   unlock = <yes / no>.`

**A five-minute thing you can do right now, which answers a DIFFERENT question.** Open
`https://jw-incorporated.github.io/foray/?foray=tts-locked-screen-check` in a **Private
Browsing** tab in Safari on the iPhone (private, so the service worker cannot serve you
an old copy of the player), tap the same play button, and lock the phone. That plays the
same line through the **Web Speech API**, not the native plugin — `on-device-tts.md` §9.2
expects it to stop, and it is the weaker candidate either way. It is not a substitute for
steps 1-8. It is worth doing because it proves the whole chain (data → player → speech)
works before you spend time on the build, and because "the weak path also survived" would
be genuinely surprising and worth knowing.

**Worked if:** there's a written result saying whether the test line played to
completion with the screen locked — same reporting bar item #11 already set for the
`<audio>` case.

**When it is answered, delete the instrument.** The Foray in `data/forays.json`,
`DIAGNOSTIC_FORAY_ID` and `withDiagnosticUnlock()` in `player/foray-resolve.js`, their
call sites in `player/client.js`, and the tests that name them all go in one commit.
None of it should be in the App Store build.

---

### RESULT (Wyatt, 2026-09-05): locked screen, **it continued all the way through.**

Run on a TestFlight build off `main` — the first build carrying #463's player/plugin
wiring, and carrying #389's explicit `AVAudioSession.setCategory(.playback,
mode: .spokenAudio)` + `setActive(true)`. So this is the FIXED plugin, not the
unfixed one this item warned about.

**`AVSpeechSynthesizer` keeps speaking with the screen locked.** That answers
`Foray_Generation_Architecture.md` §9.1's "measure this before anything else in this
document is built": on-device narration is a viable delivery path on iOS, and
`docs/research/on-device-tts.md`'s reasoning from `usesApplicationAudioSession`
holds up on a real device.

**Three things the run surfaced that it was not looking for.** All three are
engineering work, not founder actions; they are recorded here because this is where
the evidence landed.

1. **The rate mapping is badly wrong — 1.5x played at roughly 3x.** This is the
   measurement `utteranceRate(playbackMultiplier:)`'s own comment said it was
   waiting for: *"NOT PERCEPTUALLY LINEAR... 1.5 here is 'half again faster than
   default' in the framework's units, not a measured 1.5x wall-clock speed-up.
   Measuring that needs a device, which is the same limit HUMAN-ACTIONS #29 exists
   for."* It now has a device. The function multiplies
   `AVSpeechUtteranceDefaultSpeechRate` (0.5) by the playback multiplier, so 1.5x
   asks for rate 0.75 — and Apple's curve from 0.5 to 1.0 spans normal speech to
   unusably fast, so 0.75 lands near 3x. The listener's speed control is therefore
   lying to them. **Do not treat one data point as a calibration curve**: it fixes
   the shape of the error, not the exact mapping, and a corrected version needs a
   second device reading to confirm.
2. **The voice is much worse than the Kokoro acceptance fixture.** Cause is one
   line: `ForayTtsPlugin.swift` sets a voice only when a `lang` is passed, via
   `AVSpeechSynthesisVoice(language:)`, which returns the system DEFAULT for that
   language — the compact/legacy formant tier. `on-device-tts.md` §1 already noted
   Apple's catalogue "spans multiple synthesis tiers (compact/legacy formant-style
   voices through modern neural 'Enhanced'/'Premium' voices, downloaded per-language
   on demand)" and nothing in the plugin ever asks for one. Selecting the best
   installed tier is small; whether it closes the gap to Kokoro is a listening test,
   not a code question, because those voices are per-device downloads and are not
   guaranteed present.
3. **4a still has no lock-screen controls.** Confirmed by inspection on `main`: no
   `MPRemoteCommandCenter` and no `MPNowPlayingInfoCenter` anywhere under `mobile/`,
   the shipping Capacitor shell. The only matches in the repo are under `ios/App/`,
   which `CLAUDE.md` classifies as reference material rather than the app. Same gap
   as founder-feedback F5/F7, and unchanged by this test: audio surviving the lock
   screen and the lock screen offering transport controls are two different
   mechanisms, and only the first was measured here.

**The instrument stays for now**, deliberately, against the deletion note above:
findings 1 and 2 are both re-measured with the same 99-second counting line, and
deleting it before they are fixed would mean rebuilding it to check the fix. It must
still be gone before an App Store build.

**Status:** DONE (2026-09-05)

---
### 31. Before phase 2 is scheduled: build the four App Store Guideline 1.2 UGC-moderation requirements

**Tag:** `[BLOCKING]` for scheduling phase 2 (any-user prompting) · **Time:** its own future engineering card, not a quick action · **Owner:** Joey/Wyatt (decision to schedule phase 2), engineering (the build)

**Why it matters.** `docs/curation/generation-architecture.md` §1.3 already says this in
the engineering docs: *"The moment a stranger's prompt produces content other users can
hear, 4a hosts user-generated content and App Store Guideline 1.2 applies: content
filtering, a mechanism to report objectionable content, a way to block abusive users, and
published developer contact information. None of the four exist. This is a
submission-blocking discovery for phase 2 and it belongs in `HUMAN-ACTIONS.md` the day
phase 2 is scheduled — not the day it ships."* A 2026-09-02 review confirmed none of the
11 marketing/legal documents (including `docs/marketing/05-legal-risk-memo.md`, the
dedicated legal-risk-scoping memo) named this gap either, so it existed only in one
engineering doc where a founder scheduling phase 2 from the marketing/legal corpus alone
would not see it. `05-legal-risk-memo.md` §2 now carries the same four-item list (added
2026-09-02) — this item is the corresponding founder-facing tripwire.

**Today (phase 1, founder-prompted, founder-reviewed before publish): not applicable.**
4a is not hosting UGC in Apple's sense yet — do not build the moderation system now.

**The moment phase 2 (any user's prompt reaching the shared catalogue) is scheduled**,
this item blocks it: all four of content filtering, a report-content mechanism, a
user-blocking mechanism, and published developer contact info must exist before that
build reaches App Review, or it is an expected rejection. When phase 2 is scheduled,
open the engineering card for the moderation system itself against this item.

**Status:** OPEN — dormant until phase 2 is scheduled; re-read this item the day that decision is made.

---

### 32. Rule on the 2026-07-08 marketing-corpus freeze: still in effect, needs a formal exception process, or should be lifted

**Tag:** `[BLOCKING]` for further marketing-corpus work · **Time:** ~5 minutes · **Owner:** the owner (founder strategic call)

**Why it matters.** `07-premortem.md` and `08-REQUIREMENTS-DELTA.md` (both
2026-07-08) issued a standing order: "Marketing corpus is frozen until
there's a retention curve for it to describe." (also recorded in
`docs/DECISIONS.md`, 2026-07-08 "night 2" entry.) A Fable-driven review on
2026-09-02 found the freeze has been repeatedly worked around without
founder sign-off:

- `docs/marketing/09-product-feature-review.md` (dated 2026-07-08, edited
  2026-08-21 per its own banner) extends the corpus with R13-R23 and
  self-grants a freeze exception ("R14 — narrow, justified") instead of
  requesting one, and locks App Store listing copy into CI via R23.
- `docs/marketing/10-category-coverage.md` (dated 2026-07-09, numbered
  after both freeze documents) issues new curation orders with no freeze
  acknowledgment.
- `docs/marketing/06-naming-study.md` was edited 2026-08-21 without citing
  a freeze exception.
- A live Google Play store listing was drafted and captured
  (`docs/store/play/`, captured 2026-08-25) — new external go-to-market
  surface, well after the freeze. (Separately tracked for publication at
  item #26 above — that item assumes the corpus is publishable; this item
  is the prior question of whether it should be.)

Per Fable ruling FR-t_437143f8-1 (classification-only consult, recorded on
kanban card t_437143f8, board=foray): this is an explicit founder-issued
strategic gate (CLAUDE.md: "Humans make strategic decisions; AI executes")
with no local written exception process, so it is human-only
(`explicit_project_human_gates`) — Fable cannot resolve it, only certify
that it needs you. Per the ruling, all further marketing-corpus work stays
paused pending your call.

**The decision (pick one).**
- **A — freeze still stands.** Nothing above was authorized; the
  self-granted exceptions get flagged/reverted as needed and
  marketing-corpus work stays paused until an explicit retention curve
  exists.
- **B — define a formal exception process.** State who can grant an
  exception and on what grounds (e.g. legal/safety corrections should
  probably always be exempt) so future narrow needs don't require a full
  freeze lift.
- **C — lift the freeze.** Work has already continued past it in
  practice; formally end it and let marketing-corpus work resume under
  normal review, not freeze rules.

**Worked if:** you record A, B, or C (and, for B, the exception rule) as a
dated entry in `docs/DECISIONS.md`, and this item is marked `DONE`.

**Resolved 2026-09-02: C — lift the freeze.** Joey, via Discord, 2026-09-02:
`HA32=C`. Confirmed by Wyatt 2026-09-03. An earlier draft of this line described
the ruling as *inferred* from PR #444 and an abandoned branch rather than given;
that was wrong, and `docs/DECISIONS.md`'s 2026-09-02 entry records the correction
and why it is kept visible. Marketing-corpus work resumes under ordinary review.

**Status:** DONE

---

### 33. Enable leaked-password protection in Supabase Auth settings

**Tag:** `[UPGRADE]` · **Time:** ~2 minutes · **Owner:** the owner (dashboard-only toggle)

**Why it matters.** The Supabase database linter flagged that leaked-password
protection (the HaveIBeenPwned check on new/changed passwords) is off. This is
a toggle in the Supabase dashboard's Authentication settings — not a database
migration, so no worker/agent can apply it.

**Steps.**
1. Open the Supabase dashboard for this project.
2. Go to **Authentication** → **Settings** (Auth providers/Policies page,
   named "Password Security" or similar depending on dashboard version).
3. Enable **"Leaked password protection"** (the HaveIBeenPwned check).
4. Save.

**Worked if:** the toggle shows enabled, and the Supabase linter no longer
lists this WARN on a re-run of Advisors → Security.

**Status:** OPEN

---

### 34. Type the new App Store Connect listing name into Apple's dashboard

**Tag:** `[BLOCKING]` for App Store submission · **Time:** ~2 minutes · **Owner:** Joey or Wyatt (App Store Connect access)

**Why it matters.** Apple rejected the App Store Connect submission because the
bare name **`4a`** is already taken by another app/reservation (App Store
"Name" must be globally unique). Founder decision, 2026-09-02 (Discord): the
listing name becomes **`4a: Podcast Curator`**. This is an App Store Connect
web-dashboard field — it is not stored anywhere in this repo (no `ios/`
project or `Info.plist` exists here yet), so no agent can type it in. The repo
side of this (the listing-copy draft in
`docs/marketing/09-product-feature-review.md` §5, R23) has already been
updated to record the new name and note the scope explicitly: this does
**not** change the app's home-screen display name (`CFBundleDisplayName`,
stays `4a`) or any internal `4a`/`foray` naming convention — only the store
"Name" metadata field.

**Steps.**
1. Open App Store Connect → My Apps → (the 4a app record) → App Information.
2. In the **Name** field, enter exactly: `4a: Podcast Curator`
3. Save.

**Also flagging, not deciding:** Google Play's separate listing name field
(`docs/store/play/README.md` §1, Play Console → Grow → Store presence → Main
store listing → App name) currently says plain `4a` and was not the app that
hit Apple's collision. Left as-is pending a founder call on whether it should
match (`4a: Podcast Curator`) for cross-store consistency or stay `4a` since
Play has no known naming conflict. If you want it changed, say so and it's a
one-line dashboard edit, same as this item.

**Worked if:** App Store Connect shows the new name and the "name already in
use" submission error is gone.

**Status:** OPEN

---

### 36. Label PR #450 `founder-approved` (touches the `tools/test-search.mjs` gate)

**Tag:** `[UPGRADE]` · **Time:** ~1 minute · **Owner:** Joey or Wyatt

**Why it matters.** PR #450 fixes the H-severity buildPlaylist caching bug
(kanban t_838a13c0): cold-session playlist searches cost 6.6-8.1s and even
warm-ctx repeated queries cost 3.4-6s, with no loading-state affordance on
the submit button. The fix adds real caching (`search-engine.js`'s
`corpusDF`/`tagCount` reverse indexes and `primeVocabulary`, `app.js`'s
`buildPlaylist` `searchCache`), a `Building…` disabled-button state, and —
because scope item 4 asked for it — new timing assertions in
`tools/test-search.mjs`'s own battery so this class of regression can't
silently return. That last file is one of the two test-suite files
`DENIED_PREFIXES` protects (alongside `tools/validate-semantic-index.mjs`)
specifically because it IS the gate CI reads to decide "is search quality
still honest" — so `path-policy` correctly refuses to auto-merge this PR
without a human eyeball on the new assertions, same as every other PR that
has ever touched this file.

**What changed there, in one paragraph:** a new §11 block asserting (a)
`primeVocabulary` finishes in well under 5s (measured ~0.3s), (b) a query
against a primed ctx answers in well under 500ms (measured ~1-7ms), and (c)
a repeated identical query against the same ctx is markedly cheaper the
second time (proves the DF memoization is actually being reused, not just
present). All three are generous multiples of measured cost, chosen to catch
an algorithmic regression rather than flake on CI hardware variance — see
the inline comments in the file for the exact numbers.

**Steps.**
1. Open PR #450: https://github.com/JW-Incorporated/foray/pull/450
2. Skim the new §11 section in `tools/test-search.mjs` (search the diff for
   "11. perf regression") — confirm the assertions genuinely test what they
   claim and the thresholds aren't so loose they're vacuous.
3. Apply the `founder-approved` label. The `path-policy` check re-runs
   automatically on the label change; no push needed.
4. Once `path-policy` and the rest of CI (`CI`, `data-and-site`, etc.) are
   green, the PR is mergeable — foray's `merge_authority` is `agent`, so no
   further founder action is needed to merge it; I'll self-merge once every
   required check passes.

**Worked if:** the `path-policy` check on PR #450 flips from `UNAPPROVED
(blocking)` to passing.

**Decision (2026-09-03, founder):** done — reviewed §11 assertions in
`tools/test-search.mjs`, thresholds are generous multiples of measured
cost (not vacuous), applied `founder-approved`, `path-policy` and all
other CI went green, PR #450 auto-merged to `main` (`db25f8b`).

**Status:** DONE (2026-09-03)

---

### 35. Merge PR #429 (Stage 3b full-catalogue RSS ingestion) — first Vercel serverless function, needs Wyatt's architecture sign-off

**Tag:** `[BLOCKING]` for the "universal in-app playability" card · **Time:** ~10 minutes review · **Owner:** Wyatt (per `docs/roles.md` / registry `architecture_infra_ci_secrets` human gate)

**Why it matters.** `t_a36252bb` ("remove the listen-elsewhere link-out, play everything in-app") depends on `t_567b570f` shipping real `audio_url`s at scale. That work is done and reviewed (round 3, 216/216 local tests pass, GitHub CI green) in PR #429, but it is genuinely gated on a human decision, not just a routine merge:

- PR #429 adds **the first Vercel serverless function** in this repo (`api/shows/[show_id]/episodes.ts`). `vercel.json` was previously static-build-only by deliberate choice (see `docs/DECISIONS.md`, 2026-07-xx entry naming "standing up a live backend" as reserved for Wyatt).
- The implementing worker could not reach Fable for an architecture consult on this point (sandbox OOM at every heap size tried) and proceeded on the lowest-new-infra option: reuses the existing Vercel project, reuses the existing Supabase service-role connection (no new secrets), scoped its own minimal `api/package.json`.
- Registry `merge_authority` is `agent` for the foray project generally, but `human_gates` explicitly includes `architecture_infra_ci_secrets` — this PR is exactly that case.
- GitHub also currently blocks auto-merge on this PR with a `needs-founder` label and a failing `path-policy` check (expected — it's a governed path awaiting the founder-approved label), so nothing merges without your action either way.

**Steps.**
1. Read the "For Wyatt: one thing to look at specifically" section at the top of PR #429: https://github.com/JW-Incorporated/foray/pull/429
2. Decide: is reusing the existing Vercel project + existing Supabase service-role connection an acceptable way to stand up the first live backend endpoint, or do you want a different shape?
3. If acceptable: add the `founder-approved` label (or ask Hermes to add it) and merge (or authorize Hermes to merge) the PR.
4. If not acceptable: say what should change; the implementing lane will revise.

**Worked if:** PR #429 is merged to `main` (or explicitly redirected), unblocking `t_a36252bb`.

**Status:** OPEN


### 37. Merge PR #443 by hand, and rule on the new nightly/deploy-manifest.json collision — DONE

**Tag:** `[DONE 2026-09-03]` · **Owner:** nobody · **Time:** 0

> **RESOLVED.** Step 1: PR #443 was closed and relanded as
> [PR #459](https://github.com/JW-Incorporated/foray/pull/459), which merged
> 2026-09-03. Step 2: the founder ruled, verbatim, *"Auto fix, I am not trying to
> do daily manual reviews."* Implemented as options **1 and 3 together** (either
> alone leaves nightly PRs stuck — see the `docs/DECISIONS.md` entry dated
> 2026-09-03, which also records a second blocker this item did not know about:
> the `github-actions[bot]` fixup commit itself made the PR unmergeable under
> `protect-main`'s `require_extra_approval_for_unattributed_changes`):
> `tools/refresh/merge.mjs` now regenerates `deploy-manifest.json` + `sw.js`
> itself so the nightly's first commit is already correct and no bot commit is
> ever pushed, and both files are on `ALLOWED_PREFIXES` so auto-merge arms. The
> ruleset was not weakened and no bypass actor was added.
> `docs/agents/runner-prompts/foray-nightly.md` steps 5 and 7 now describe it.
> **Worked if:** the next `nightly/*` PR merges with no human click and carries
> no `github-actions[bot]` commit.

**Why it matters.** `data-and-site` failed on
[PR #443](https://github.com/JW-Incorporated/foray/pull/443) (a nightly-refresh
recovery run, +91 episodes) because `deploy-manifest.json`'s per-file content
hashes go stale whenever a shipped file changes, and the nightly always
changes `data/discover.json` + `data/item-tags.json`, both of which are on the
manifest's watched list. A `github-actions[bot]` auto-fix step regenerated
`deploy-manifest.json` and `sw.js` (its `BUILD_ID` companion) and pushed
directly to the PR branch — CI is green now. But `deploy-manifest.json` and
`sw.js` are not on `ALLOWED_PREFIXES` in `tools/ci/path-policy.mjs`, so
`path-policy` reports `NOT ARMED` / `UNLISTED_PATH` and auto-merge will not
fire, even though every required check is green. Per `CLAUDE.md`'s note on
"ungoverned" vs. "auto-mergeable": these two paths are on neither list, they
fail safe to a human, and it's all-or-nothing — the whole PR waits, not just
the two files.

**The recurring part:** the manifest mechanism (`tools/ci/generate-manifest.mjs`,
M4, landed 2026-08-31) means this will hit *every* future nightly-refresh PR
the same way, not just this one — the bot's auto-fix will keep making CI
green, but auto-merge will keep declining to act on it. `docs/agents/runner-prompts/foray-nightly.md`
doesn't mention this at all yet.

**Steps.**
1. Open [PR #443](https://github.com/JW-Incorporated/foray/pull/443), confirm
   `backend` + `data-and-site` are green (they were as of this writing), and
   click **Merge**.
2. Decide how nightly PRs should handle this going forward — options, not a
   recommendation:
   - Add `deploy-manifest.json` and `sw.js` to `ALLOWED_PREFIXES` (the
     `tools/ci/path-policy.mjs` fix `#167`/`#168` used for `STATE.md`) so
     these two land unread whenever a bot or nightly PR touches only them
     alongside already-allowed paths.
   - Or leave it governed and accept that every nightly-refresh PR now needs
     a manual merge click, and update the runbook to say so.
   - Or teach `tools/refresh/merge.mjs` to call `generate-manifest.mjs --write`
     itself, so the manifest is never stale on the PR's first commit (does not
     by itself fix the `ALLOWED_PREFIXES` question above).

**Worked if:** PR #443 is merged, and a decision is recorded (in
`docs/DECISIONS.md` per the workflow rule on anything expensive to reverse,
or right here) on which of the three options above applies to future nightly
PRs.

**Status:** DONE (2026-09-03) — see the RESOLVED block above.

---

### 38. Edit the privacy policy's absolute no-transmission sentence before shard/API-backed Shows search ships (G5)

**Tag:** `[GATE]` · **Time:** ~10 minutes · **Owner:** Wyatt

**Why it matters.** `docs/legal/privacy-policy.md` §2 currently says, verbatim:

> **Nothing you type into the playlist box or the Shows search box is transmitted.**

That is true today: `search-engine.js` runs entirely on-device, and the only
thing app.js currently sends off-device from the Shows page is the FULL-
CATALOGUE BREADTH lookup (kanban t_8d1a6a58's `api/shows/search`), which is a
separate, already-disclosed feature from the typed search box itself. The
`4a-shows-pipeline-plan.md` (S-04/S-05) replaces on-device search with a
shard-backed and/or API-backed index, which necessarily transmits what a
user types into `#sh-input` to resolve a shard or hit the API. Shipping that
change while the sentence above still stands is a false statement in a
published legal document.

**The mechanical tripwire (S-08, this item's G5).** `test/release-gates.test.js`
fails CI and the first step of `ios-build.yml` / `android-release.yml`
whenever a `SHOWS_SEARCH_OFF_DEVICE` flag is on (set as a source constant in
`app.js`/`search-engine.js`, or as a `SHOWS_SEARCH_OFF_DEVICE=true` workflow
env var) **and** the sentence above is still present. This lets S-05 merge
its shard search behind the flag off, but blocks any release build from
starting with the flag on until this item is resolved.

**Steps.**
1. Decide the accurate replacement wording with Wyatt — likely scoped to
   "on-device unless you search a show or episode we don't already have,
   which looks up a shard/index off your device" (exact wording is a
   founder call, not an agent one: it is a legal-accuracy question about
   what a listener is told, not a code fact).
2. Edit the sentence in `docs/legal/privacy-policy.md` §2 (and reconcile
   `docs/legal/data-safety.md` if it repeats the claim — `test/legal-citations.test.js`
   checks cross-document consistency separately).
3. Flip `SHOWS_SEARCH_OFF_DEVICE` on (S-15 in the pipeline plan) once the
   edit lands — `test/release-gates.test.js` re-verifies the combination is
   now safe.

**Worked if:** `test/release-gates.test.js` passes with the flag on and the
new sentence in place, and fails if either reverts alone.

**Status:** DONE (2026-09-05)

**Decision line:** Joey authorized an agent to draft the replacement wording
itself and ship it without a stop-and-review cycle (Discord, 2026-09-0x):
"have a fable agent on low effort draft the necessary wording and put that in
place. Legal counsel is regularly reviewing every word on the website, so no
need to stop and tell us to review it." This overrides this item's original
"exact wording is a founder call" framing for this one wording decision;
legal counsel's regular review of the site is the safety net.

`docs/legal/privacy-policy.md` §2's absolute sentence was replaced with
wording that keeps the on-device promise for the playlist box and for Shows
search when the show/episode is already in 4a's local catalogue, and
discloses that a Shows search miss looks the typed query up against a
shard/index off-device. `docs/legal/data-safety.md`'s two repeats of the same
claim (Play's "In-app search history" row and Apple's "Search History" row)
were reconciled to match. `test/legal-citations.test.js` and
`test/release-gates.test.js` both pass; `test/release-gates.test.js`'s core
gate now passes regardless of `SHOWS_SEARCH_OFF_DEVICE`'s value, because the
old absolute sentence the gate watches for is gone.

**`SHOWS_SEARCH_OFF_DEVICE` itself was deliberately NOT flipped in this PR.**
Nothing in `app.js` or `search-engine.js` performs a shard/API-backed Shows
search yet (S-04's shard-index release and S-05's client wiring haven't
shipped) — flipping the flag now would declare a feature live that doesn't
exist in the client. Flipping it is S-05/S-15's job, once the real off-device
Shows search path lands; this item only had to make the flip *safe* to do at
that point, which it now is.

---

### 39. Decide how the shard-index client (S-05) reaches GitHub Release assets — CORS gap measured, not fixed

**Tag:** `[INFO]` (no gate — S-05 has not shipped a client fetch yet) · **Time:** ~10 minutes to read, decision itself depends on S-05's design · **Owner:** whoever picks up S-05

**Why it matters.** S-04b publishes the shard index as GitHub Release
assets. Measured against a real release already in this repo
(`kokoro-fixture-t_f3c788ca`): a download URL
(`github.com/<owner>/<repo>/releases/download/<tag>/<asset>`) redirects
(302) to a presigned URL on `release-assets.githubusercontent.com` (an
Azure Blob Storage-backed CDN). **Neither the redirect response nor the
final asset response sends an `Access-Control-Allow-Origin` header.** A
browser `fetch()` from the app's origin (`capacitor://localhost` on iOS,
`https://localhost` on Android, or the web origin) to a Release asset URL
**will fail the browser's CORS check as GitHub serves it today** — this
was verified with `curl -H "Origin: capacitor://localhost"` against both
hops of the real redirect chain, and with a standalone `OPTIONS`
preflight against the resolved asset URL (`405`, no CORS headers either).

Widening the CSP's `connect-src` to name `release-assets.githubusercontent.com`
is **necessary but not sufficient** — `connect-src` only controls which
origins the page may ask; it does nothing about whether the *server*
answers with the CORS header the browser then requires, and GitHub's
server does not.

**What does work, measured the same way:** `raw.githubusercontent.com`
and `cdn.jsdelivr.net` both send `access-control-allow-origin: *` — but
only for files **committed to git**, not Release uploads. `cdn.jsdelivr.net`
returns a `404` for a real Release asset requested by its GitHub-release
URL shape (confirmed against `kokoro-fixture-t_f3c788ca`'s own assets).

**Options for S-05, in rough order of effort:**
- **Route through `api/` as a same-origin proxy** (recommended starting
  point) — matches the pattern `api/shows/[show_id]/episodes.ts` already
  uses for no-DB mode: the client's own origin stays in `connect-src`,
  and the Vercel function fetches the Release asset server-side (no CORS
  concern server-to-server) and streams it back. No new infra.
- **Front the Release assets with a CORS-capable CDN/proxy** (e.g. a
  Cloudflare Worker, or mirroring the built shards to an S3/R2 bucket
  configured with CORS headers) — more infra, but removes the API-layer
  hop from the client's read path.
- **Commit the shard index to git instead of Release assets** — would get
  free CORS via `raw.githubusercontent.com`/jsDelivr, but reopens the
  repo-bloat problem GitHub Releases exist to avoid (see
  `docs/DECISIONS.md`'s S-04b entry for the sizing reasoning). Not
  recommended without a strong reason to prefer it.

**No CSP change lands in this card (S-04b) or is owed by it** — S-03/#36's
own rule (`docs/mobile-shell.md` §3) is that `connect-src` widens with the
code that needs it, not in advance. This item exists so S-05 does not
discover the CORS gap by shipping a client that silently fails to fetch.

**Worked if:** S-05's design doc (or its PR) states which option it picked
and why, and the CSP change (if any) lands in that same PR per the
project's existing rule.

**Status:** OPEN.

---

### 40. Download one Enhanced iPhone voice, then re-listen to the narration test

**Tag:** `[BLOCKING]` for judging on-device narration at all · **Time:** ~3 minutes of taps
plus one download, then the same 100-second listen as #29 · **Owner:** whoever has the iPhone

**Why it matters.** #29 came back with two results, and the second one has been
misread. The locked-screen question passed. The other observation was that the voice
was "much worse than the original test" — the original being the Kokoro fixture. That
was taken as evidence about on-device TTS. It was not: `ForayTtsPlugin.swift` was
asking iOS for the SYSTEM DEFAULT voice, which is the compact/legacy tier — the robotic
one — while the same free catalogue also carries neural "Enhanced" and "Premium"
voices. The plugin now asks for the best tier installed. **But those voices are
per-language downloads and a stock iPhone does not have them**, so on a phone that has
never been to the settings screen below, this change is completely inaudible and a
re-listen would produce the same verdict for a different reason.

So: download one, then listen. Until that happens nobody — including us — knows what
on-device narration actually sounds like, and a product decision about server-side vs.
on-device synthesis is resting on a comparison against the worst voice iOS ships.

**Steps.**

1. On the iPhone, open **Settings → Accessibility → Spoken Content → Voices → English**.
2. Pick a voice and tap the **download arrow** beside it. Any Enhanced or Premium voice
   is fine; **Ava** and **Samantha** are the usual English (US) ones, and Samantha has
   the small advantage that it is the same name as the default, so the plugin's
   tie-break will prefer it. The download is free and is typically 100–500 MB.
   (If the list shows only one entry per name with no download arrow, that voice is
   already installed — note which and move on.)
3. Write down the exact names of every voice that now shows as downloaded. That is the
   ground truth this repo does not have.
4. Install/launch the shell build with this change in it, open the
   **"On-device narration, screen off"** Foray (the same one #29 used), and listen to
   the first ~20 seconds.
5. **Report:** does it sound meaningfully better than what you heard on 2026-09-05?
   Better/same/worse, in your own words — no scale needed. If it sounds identical,
   say so, because that is the informative answer: it would mean the plugin is not
   picking up the downloaded voice and there is a second bug.

**Values written out, so nothing has to be guessed:**
- Settings path: `Settings → Accessibility → Spoken Content → Voices → English`
- Foray title in the app: **On-device narration, screen off** (id `tts-locked-screen-check`)
- The plugin call that would confirm what the phone actually has:
  `window.Capacitor.nativePromise("ForayTts", "listVoices", { lang: "en-US" })` —
  there is no UI for this yet, so it is only reachable from a Safari Web Inspector
  console attached to the device. Skip it unless step 5 comes back "identical"; the
  human answer to step 5 is the one that matters.

**Worked if:** there is a written note saying which voice was downloaded and whether the
narration sounded better with it. Both halves are needed — "sounds better" without the
voice name cannot be reproduced, and the voice name without a verdict answers nothing.

**Status:** OPEN.

---

## DONE

*(Finished items move here with the date they were done and keep their
number — the history is how we stop re-asking.)*

Item #38 (privacy policy no-transmission sentence, G5) is DONE as of
2026-09-05 — its `### 38.` heading, full detail, and decision line are kept
in place above rather than duplicated here, since this is the file's first
completed item and moving the block would cost more diff than it's worth.

Item #29 (on-device narration with the screen locked) is DONE as of
2026-09-05 — the result is recorded under its own `### 29.` heading above, for
the same reason: the answer is only legible next to the steps that produced it.
**Answer: it continued all the way through** — plus three defects the run
surfaced, listed there.
