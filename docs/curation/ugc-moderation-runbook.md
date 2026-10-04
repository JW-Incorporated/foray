# UGC moderation runbook (App Store Guideline 1.2)

**Written 2026-10-04 against `origin/main` @ `d1f9f969`** for card PH2-13 of
`docs/roadmap/listener-forays-sharing.md`. It is the operator's procedure for
content filtering, reports, takedown, blocking and contact, plus the reading of
Guideline 1.2 that decides what has to exist before which step of phase 2.

**Later rulings win over the PH2 plan.** This runbook follows `docs/DECISIONS.md`
2026-09-28 **D9** (on-demand generation is a Supabase `generation_jobs` queue,
founder-only first; the phone never calls the Spark) and 2026-09-30 **HA #31**
(the order of the four pieces) and **HA #13** (contact `help@jwlabs.ai`). The
plan's HTTP generation service (PH2-15..18: `POST /generation`, a loopback
server, bundles fetched from it) is superseded by D9, so nothing below depends
on it. Where a step needs a table or worker that is not on `main` yet, the step
says so. Do not treat it as running.

**Status words used below.** *Live*: on `main` and in force. *Planned*: a card
exists and nothing is on `main`. *Proposal*: a policy number that no founder has
ruled on.

## 0. Why

`docs/curation/generation-architecture.md` §1.3, the blockquote under the phase
table:

> **Phase 2 changes what 4a is to Apple.** The moment a stranger's prompt produces content other
> users can hear, 4a hosts user-generated content and App Store Guideline 1.2 applies: content
> filtering, a mechanism to report objectionable content, a way to block abusive users, and
> published developer contact information.

The four pieces, and the 2026-09-30 ruling on their order (HA #31, now in
`HUMAN-ACTIONS-DONE.md`):

| # | Guideline 1.2 piece | 4a's mechanism | Status | Must exist before |
|---|---|---|---|---|
| 1 | Published developer contact | `help@jwlabs.ai` (§5) | Live on jwlabs.ai and in policy §9; not shown in the app | already due ("now") |
| 2 | Content filtering | `checkSafety` on the prompt (live); an output-side filter extending `safetyCheck.ts` (planned); founder review of anything published (live) (§1) | partial | **any non-founder prompt, even a private one** |
| 3 | Report objectionable content | report sheet → `content_reports` → daily review (§2) | planned | **the first shared non-founder Foray** |
| 4 | Block abusive users | `blocked_authors`, enforced where a job enters the queue (§4) | planned | **the first shared non-founder Foray** (one card with 3) |

**What counts as UGC here.** The ruling's line: *"A private-to-prompter Foray is
not UGC and may ship first."* A Foray is UGC in Apple's sense when a non-founder
prompted it **and** someone other than that prompter can hear it. So there are
three states:

- **Today.** Only the founders prompt (D9 "founder-only first"). Every catalogue
  Foray goes out through `publish-foray` as a PR carrying `hold` (D7), and a
  founder takes the label off. 4a hosts no UGC. Pieces 2-4 are not yet owed.
- **Private on-demand.** A non-founder may prompt, and only they can open the
  result. This is not UGC, but piece 2's output-side filter is owed first: the
  ruling says "before any non-founder prompt, even private".
- **Shared on-demand.** A non-founder's Foray is reachable by anyone else, by
  link, by listing, or by promotion to the catalogue. All four pieces are owed.
  This is a submission blocker: a build that can do this does not go to App
  Review without them.

## 1. Content filtering

Three layers. Only the first two run before anything is played.

1. **Prompt-side: `checkSafety(prompt)` in `backend/src/generation/safetyCheck.ts`.**
   *Live.* It runs first in `understandPrompt.ts`, before any spend. It is pure
   and synchronous: no LLM, no network, and a rejection is final. It refuses
   three categories, keyed on intent and not on topic words (founder ruling Q4,
   2026-09-25; the module header lists the cases that must pass):
   sexual content involving minors, operational instructions for mass-casualty
   weapons or attacks, and targeted harassment of a named private individual.
   Every case has a test in `backend/test/safetyCheck.test.ts`. Prompts are
   discarded after understanding (`understandPrompt.ts`, "NO PERSISTENCE, BY
   CONSTRUCTION"). Moderation therefore works on the **output** and the
   author id, never on the prompt.

   **The gap to state plainly.** The check is narrow by design. It does not
   refuse hate speech, harassment of public figures, sexual content between
   adults, self-harm, or misinformation. Those are four of the six reasons the
   report sheet offers (PH2-11). This is acceptable while a founder writes every
   prompt and reviews every published Foray. It is not acceptable as Apple's
   "filtering" for strangers, and that is why layer 2 exists.

2. **Output-side filter, extending `safetyCheck.ts`.** *Planned.* This is
   the kanban card "UGC gate, step 2 (filter)", whose text is in
   generation-architecture §1.3. It checks the generated **output**: every
   narration script, the title, the summary and the why-lines. Those are the
   only words in a Foray that 4a writes; clips are third-party publishers' own
   audio from the catalogue. The card is done when a failing output blocks
   playback and is logged, with a test that breaks it. In the D9 design the
   worker runs it before it writes an act's manifest into the job row, so a
   failing act never reaches the phone. **Recommendation** (compliance
   judgement, not ruled): the output check should cover at least the report
   sheet's reason list (hateful or harassing, sexual, dangerous or violent), not
   only `checkSafety`'s three categories. Apple's "filtering objectionable
   material" is read against what a listener would call objectionable, not
   against 4a's own short list.

3. **Founder review before the catalogue.** *Live.*
   `backend/src/cli/publishForay.ts` (`npm run publish-foray`) is the only way
   a Foray becomes `published`. It validates through `tools/foray/check-forays.mjs`
   and `check-narration.mjs`, runs the real-data suites, and opens a PR that
   carries `hold` by default. `--force` implies `hold`, and `--no-hold` next to
   it is refused. D7 keeps `hold` on every catalogue Foray, so a founder takes
   the label off before `automerge-nightly.yml` can merge it.
   `tools/foray/check-forays.test.mjs`'s test "exactly the named Forays are
   published, and no other" pins the published set by id, so a status flip
   cannot slip through as a side effect. **What `check-forays.mjs` is and is
   not.** Its D-tier rules (D1 cut budget per 600 s, D2 short runs, D4 quote
   share) and the p-foray-5 caption rule on published Forays are listening and
   ad-safety gates. They are **not** content-safety filters, and the runbook
   never cites them to Apple as one.

## 2. Reports

*Planned: nothing below is on `main` yet.* Report and block ship as **one
card** (HA #31), and that card must land before the first shared non-founder
Foray.

- **The sheet** (PH2-11). A "Report" control on every Foray page, drafts and
  private Forays included. It offers six reasons: Hateful or harassing, Sexual
  content, Dangerous or violent, Misleading or false, Spam or off-topic,
  Something else. There is a free-text note of up to 280 characters. The sheet
  is titled for its target ("Report this foray" or "Report this episode") and
  says "4a reads every report." A sent report queues locally in
  `cp_reports_pending` (at most 20) until it syncs, and the `report_sent` event
  stays on the device.
- **The table** (PH2-10, `content_reports`). The client inserts its own rows
  with the anonymous session's bearer (PH2-12). RLS allows insert-own and
  delete-own only. There is **no** select or update policy, so no client, and
  no agent without the founder's credentials, can read a report. `on delete
  cascade` from `auth.users` covers account deletion, and delete-own serves
  Delete my data. **Migration number:** PH2-10 calls it `0004`, and the Spark
  assessment (§3.6) also claims `0004` for `0004_generation_jobs.sql`. Whichever
  lands second renumbers. Cite the table by name, not by file.
- **Email counts as a report.** Anything that reaches `help@jwlabs.ai`
  about a Foray or episode gets the same clock. Log it as a row so the queue
  stays the single record:

  ```sql
  insert into public.content_reports (user_id, target_kind, target_id, reasons, note)
  values ('<the founder''s own auth uid>', 'foray', '<id>', '{"email"}', '<sender, date, one line>');
  ```

- **The daily review.** A founder runs this in the Supabase SQL editor:

  ```sql
  select id, created_at, target_kind, target_id, reasons, note
  from public.content_reports
  where status = 'open'
  order by created_at;
  ```

  Each row ends in one of two states:

  ```sql
  update public.content_reports set status = 'actioned' where id = '<report id>';   -- taken down (§3) and/or author blocked (§4)
  update public.content_reports set status = 'dismissed' where id = '<report id>';  -- read, no action; say why in the PR or log line
  ```

- **SLA: read within 24 h, act within 72 h.** *Proposal, not ruled.* "Act"
  means the takedown PR is merged and deployed (§3), or the report is
  dismissed. Guideline 1.2 asks for "timely responses to concerns" and gives no
  number. Until a founder rules, 24/72 is the working target, and a miss goes in
  the PR body, never quietly. **The exception: sexual content involving a
  minor.** Remove it first, the same day, by row deletion (§3, A2). Tell the
  founder directly, keep no copy beyond what the takedown needs, and get legal
  advice on any reporting obligation. This runbook does not give that advice.
- **Who reads it.** A founder. No agent holds read access, and none should be
  given it for this purpose. Reports carry free text from strangers, and the
  2026-09-21 merge rule does not extend to production credentials (`CLAUDE.md`
  decision authority).

## 3. Takedown

There are two kinds of Foray, and a takedown differs for each.

### A. A catalogue Foray (a row in `data/forays.json`)

**Pick the level first, because `draft` does not hide a Foray from everyone.**
`player/foray-resolve.js` `forayVisibility` shows a non-published Foray to
anyone who opens it by id (`?foray=<id>`, via `app.js` `forayParam`). It also
shows drafts on any device whose drawer switch "Show draft Forays"
(`cp_show_drafts`) is on, and that switch is not founder-gated.

- **A1. Delist** (quality, accuracy, a wrong clip; nothing objectionable): set
  `status` to `"draft"`. The Foray leaves every list and stays openable by
  id.
- **A2. Remove** (objectionable content): delete the Foray's row from
  `data/forays.json`. Only this makes it unreachable. Leave the `segments.json`
  and `segment-sources.json` rows it referenced unless `check-forays.mjs`
  objects. They point at publishers' audio and are not the objectionable part.
  If any removed narration item carried an `audio_url` on `audio.jwlabs.ai`
  (D6, the public `foray-narration` bucket), that object stays fetchable until
  it is deleted. Deleting it needs the R2 write key, which lives only on the
  founder's machine (HUMAN-ACTIONS #120), so it is a founder step.

**Steps:**

1. Branch from `origin/main` in a worktree (the PH2 conventions block), named
   `moderation/withdraw-<id>`.
2. Make the A1 or A2 edit to `data/forays.json`. Do not touch
   `deploy-manifest.json` or `data/forays-directory.json`; they are build
   outputs (issue #701).
3. If the Foray was `published`, take its id out of the array in
   `tools/foray/check-forays.test.mjs`'s test "exactly the named Forays are
   published, and no other". Find it with
   `git grep -n "exactly the named Forays" tools/foray/check-forays.test.mjs`;
   line numbers drift. The test pins the published set by id, so the edit is
   required, and it records the withdrawal. **Watch the next test**, "a
   published Foray has a narrator between its clips". It goes red when the
   withdrawn Foray was the only narrated published one. At this revision that
   Foray is `how-ai-actually-gets-built-3b83e1`; `capital-types-1` has no
   narration. The takedown wins. In the same PR, either publish another
   narrated Foray through `publish-foray` (a founder's call), or rewrite that
   assertion to its conditional form: `app.js` `forayAbout()` already drops
   the narrator clause when no published Foray carries narration. Never revert
   the takedown to keep a suite green.
4. Run `node --test tools/foray/check-forays.test.mjs` and
   `node tools/foray/check-forays.mjs`. Both must be green.
5. Open a DRAFT PR titled `moderation: withdraw <id>`. The body cites the
   report id(s), A1 or A2, and the reason in one line. Mark it ready and merge
   it when green (the 2026-09-21 rule). The 72 h clock stops at the deploy, not
   at the PR. A takedown never carries `hold`.
6. **How it reaches phones** (FD-06, 2026-09-11). Vercel deploys `main`, the
   pointer `data/forays-directory.json` changes, and every phone adopts the new
   Foray directory at its next launch or return to foreground. No store build
   is needed, and the resolver hides the Foray from then on. **Two residues,
   for A2 only.** A device that stays offline keeps its cached set until it
   reaches the network. A fresh install plays the package's bundled seed
   before its first fetch. `data/` never triggers a release
   (`tools/release/watch-release.mjs` `releaseTier`), so after an A2 removal
   dispatch `release.yml` by hand to take the Foray out of the seed.
7. Mark the report(s) `actioned` (§2).

### B. A private on-demand Foray (D9: a `generation_jobs` row)

*Planned: neither the `generation_jobs` table nor the worker is on `main`.* In
D9's design a private Foray is a job row holding the act manifests
(`PartialCandidate`) plus that job's narration files in R2. Nothing of it is in
`data/`. Taking one down:

1. Put the row in a withdrawn state and null its manifest. The column names
   come from the `generation_jobs` migration, so rewrite this step with the
   real SQL in the PR that lands it.
2. Delete that job's narration objects from `foray-narration`. This is a
   founder step, for the same reason as A2.
3. Mark the report `actioned`. If the author has more than one such report, go
   to §4.

**A requirement this places on the on-demand client card** (recorded here
because the runbook depends on it): the app treats the job row as the source of
truth for a private Foray. It must forget a Foray whose row is withdrawn or
gone, and must not keep playing it from a durable on-device copy. Without that,
step 1 does not reach the phone. The plan's PH2-22 stored bundles durably on
device with no such check.

## 4. Blocking

*Planned.* This ships in the same card as §2 (HA #31).

- **Today the allowlist is the block.** D9's queue is founder-only first:
  `generation_jobs` admits an allowlist of founder accounts (Spark assessment
  §3.6). Nobody else can enqueue a job, so nobody else needs blocking yet.
- **When the allowlist widens: `blocked_authors`** (PH2-14:
  `user_id uuid primary key`, `reason`, `blocked_at`, RLS on, **no**
  policies, so service role only). D9 removed the HTTP service where PH2-14
  put the check, so the check moves to the queue's front door. **Proposal:**
  the `generation_jobs` insert policy refuses a row whose author is in
  `blocked_authors`, so the block holds even when the worker is wrong. The
  worker checks again at claim time, as defence in depth.
- **To block.** A founder, in the Supabase SQL editor. The author id is the
  `author_id` that every generated Foray records (generation-architecture §1.3;
  `GenerationRequestSchema` in `backend/src/types/generation.ts`):

  ```sql
  insert into public.blocked_authors (user_id, reason)
  values ('<author uuid>', 'report <id>: <one line>');
  ```

  To unblock, run `delete from public.blocked_authors where user_id = '<author uuid>';`.
  Then review that author's shared Forays and take down any that are
  objectionable (§3). A block stops new jobs and does not remove old work.
- **Two weaknesses to settle when PH2-14 is built.** (1) Accounts are anonymous
  Supabase users. A blocked author who uses Delete my data or reinstalls comes
  back with a new id. The per-author daily cap limits the damage, and
  it is one reason the allowlist should widen slowly. (2) PH2-14's
  `references auth.users(id) on delete cascade` means a block **disappears** when
  the blocked account is deleted. Keeping the row conflicts with Delete my
  data's promise, and dropping the cascade is a privacy decision.
  `docs/legal/privacy-policy.md` must say which choice was made, in the same PR.
- **No listener-facing block.** 4a has no user-to-user surface: no comments, no
  follows, no messages. Blocking is therefore operator-side (PH2 founder
  question 9, default). If a listener-to-listener surface ever ships, revisit
  this.

## 5. Contact

**`help@jwlabs.ai`** (HA #13, 2026-09-30; one address for privacy and developer
contact, shared with HA #31). The address is live:

- `docs/legal/privacy-policy.md` §9 names it.
- It is the `mailto:` on 25 of the 26 jwlabs.ai pages
  (`docs/jwlabs-dev-domain-inventory.md`).
- It is the Apple enrollment work email (`docs/apple-enrollment-website.md`).

The card "UGC gate, step 1 (contact)" is done when the address resolves from
the support page, the App Store listing and the privacy policy. The store
listings' contact fields live in the developer accounts, not in this repo
(`docs/store/play/README.md`, "Contact details"), so a founder confirms them.
**Recommendation:** show the address in the app's Settings as well, so a
listener can find it without leaving 4a. Apple's wording is "easily reach you".
The PH2 plan (HUMAN-ACTIONS #120) assumed a mailbox the founder had yet to
create. HA #13 answered that, and today's #120 is an unrelated Spark item.

## 6. What Apple sees

**Content filtering.** Nothing a stranger types reaches a listener unfiltered.
`checkSafety` refuses the prompt before any spend. The output-side filter
checks every generated word (narration, title, summary, why-lines) before an act
is written where a phone can read it. A failing act is never played, and it is
logged. Nothing reaches the shared catalogue without a founder taking the
`hold` label off its PR. Clip audio is never generated: it is the publishers'
own episodes, chosen from a curated catalogue. Until the output-side filter
ships, only the founders can prompt.

**Report objectionable content.** Every Foray page carries a Report control with
six reasons and a note. A report reaches a database table that only the
founders can read, and they review it daily. The proposed target is to read
within 24 hours and act within 72. Acting means removing the Foray from the
directory every installed app reads at launch, and that needs no app update.
Reports by email to `help@jwlabs.ai` go into the same queue.

**Block abusive users.** The operator blocks an author account, and from then on
the database refuses any new generation request from it. The author's existing
shared Forays are reviewed and removed where warranted. 4a has no feature
through which one listener can reach another, so there is nothing for a
listener-side block to block.

**Published contact.** `help@jwlabs.ai` appears in the privacy policy, on
jwlabs.ai and in the store listings, and (recommended) in Settings.

**What is not claimed.** Today the report sheet, the block table, the
output-side filter and the on-demand queue are planned, not shipped. This is
true, and Guideline 1.2 does not bite today, because every Foray anyone can hear
was prompted and reviewed by a founder (§0). A build that lets a non-founder's
Foray be heard by anyone else does not go to review until all four rows of
the §0 table read *Live*. Prompt privacy (Guideline 5.1.2(i): consent before a
prompt goes to a third-party AI, and the new store-label rows) is a separate gate
in the Spark assessment §3.6. It is not covered here.
