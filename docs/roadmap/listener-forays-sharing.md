# Phase 2 plan — listener-requested Forays and sharing (package PH2), revision 2

Written 2026-09-25 against `origin/main` @ `ecb6bfa3` (foray; "feat(playlists): save a generated playlist… (#839)", one commit past the reviewer's `9442bba7`). Read-only survey; every path and symbol below was re-checked with `git show origin/main:<path>` / `git grep` on that commit. **Line numbers are hints only** — every edit anchors on a unique literal (grep it) because `app.js` moves hundreds of lines per audit round.

**Revision notes (reviewer problems → what changed).** Baseline restamped and all line-only anchors replaced by grep anchors. HUMAN-ACTIONS renumbered (#119 Path B rulings, #120 contact address, #121 apply migrations; `main` already has #117/#118). Migrations renumbered (`0004_content_reports.sql`, `0005_blocked_authors.sql`; `0003_rls_least_privilege.sql` exists). PH2-14: path fixed to `backend/src/curation/createUserInterestsProvider.ts`, pg `Client` shape, depends-on 10, Wave 2. PH2-19: relay default port is the imported `DEFAULT_PORT` (8788); relay floor 33. Legal-citations sequencing: PH2-01 no longer touches totals; PH2-03 and PH2-11 carry their own legal edits. Share/report binding anchored on `bindFeedback(r);`, markup on `id="fy-error"`. Delete policy folded into PH2-10; PH2-12 only issues the DELETE. `app.js` chain now 02 → 08 → 03 → 04 → 05 → 11 → 20 → 12 → 21 → 22 with distinct FLOORS anchors. PH2-13 is opus (compliance judgement) and cites `safetyCheck.ts` on `main`. PH2-06 splits the manifest bump (human merge) from the `app.js` branch. PH2-20 states the join keys (`id` for both) and drops its stop clause. `shareBtn` takes a payload. PH2-05 declaration written exactly (`--text-dim`, `--fs-sm`). One reviewer item rejected in part: PH2-09 does **not** file #121 (that would put two Wave-1 tasks in `HUMAN-ACTIONS.md` at once); PH2-10 files #121 and depends on PH2-09.

## 1. Goal, done-definition, dependencies, founder questions

**Goal.** Let a listener (a) share a published Foray or an episode with one tap, and (b) ask 4a for a Foray of their own, in a chosen length, without 4a becoming an unmoderated UGC host in Apple's eyes. **Done when:** the share control is live on the Foray page and the episode page in the web build and both shells; the four App Store Guideline 1.2 pieces exist (prompt-side content gate + founder publish gate, an in-app report that reaches a human, an operator-side block for abusive authors, a published contact address); a keyless, loopback-only generation service exists with tests and is one founder ruling away from being pointed at a host; the Create tab's Foray half can be enabled by configuration, takes a length tier, and lands the finished Foray privately in the requester's Library. The public catalogue still requires the founder's publish (`backend/src/cli/publishForay.ts`); that gate is not weakened.

**What ships early vs what waits.** Stream A (share, PH2-01..06) and stream C's client half (report sheet, runbook, HUMAN-ACTIONS) have no dependency on generation and ship first. Stream B's client picker and stream D's service/client are *built* now but stay dark until the four Path B rulings (host, spend, review-gate exception, CSP) in `docs/curation/foray-generation-requirements.md` §8.8 (line 4004) are given.

**Dependencies.**
- The Q4 safety rewrite ("the safety check keys on intent, not topic words") is **already on `main`**: `backend/src/generation/safetyCheck.ts` @ `ecb6bfa3` is the version to trust. The 8 commits still unmerged on `origin/r3fix/integration` (thumbs replace-vote app-2-6, ledger docs, api clientLimit) are **not** a PH2 dependency.
- Native engine M2-M4 (`docs/native-engine-plan.md`): not a dependency. Progressive (act-by-act) playback of a generating Foray is out of this package; a requested Foray is delivered whole, so nothing here touches the player's queue or the native engine.
- Credentials (founder): an `ANTHROPIC_API_KEY` for the service (or the keyless relay, `tools/generation/relay.mjs`); Supabase admin to apply two migrations (same shape as HUMAN-ACTIONS #116, line 63); the tailnet host if Path B decision 1 is "hermes-vm".
- Devices: one iPhone and one Android phone for PH2-06.
- Other packages: none blocking. Notifications (#761) and Up Next tools (#762) are untouched.
- Founder's machine load (2026-09-25: "too much running in parallel"): §4 caps concurrency at three agents.

**Open founder questions (defaults proposed; filed as HUMAN-ACTIONS #119/#120 by PH2-09).**
1. Share-link origin: `https://jw-incorporated.github.io/foray/` (the Pages deploy; `app.js` already prints it for `?foray=` links, grep `jw-incorporated.github.io/foray/?foray=`) or `https://jwlabs.ai`? **Default: Pages URL.**
2. HUMAN-ACTIONS #31 ruling (line 226): build all four Guideline 1.2 pieces before the Foray toggle is enabled for anyone but the founders? **Default: yes** — PH2-21 refuses to enable without PH2-10/11/12/14 merged and #120 answered.
3. Path B decision 1, host: hermes-vm on the tailnet vs the founder's box. **Default: hermes-vm.**
4. Path B decision 2, spend: **Default:** `--budget-usd 10` per Foray (the D0 proposal in `docs/curation/generation-kpis.md`), 3 requests per author per day, $50/day global; the service refuses beyond the caps.
5. Path B decision 3, review gate: **Default:** a listener-requested Foray is `visibility: "private"` — only its author can open it; the public catalogue still needs the founder's `publish-foray`. No exception to generation-architecture §1.3 for the catalogue.
6. Path B decision 4, CSP: follows from 3; `index.html` `connect-src` gains exactly one origin (PH2-23).
7. Length tiers: the mockup says ~20/~40/~75 min; the backend's `DURATION_SHAPE_BUDGETS` (`backend/src/types/spine.ts` line 28) targets ~15/~60/up-to-180. **Default:** the backend's three tiers in the one duration dialect (`docs/DECISIONS.md` 2026-09-23 entry, line 422: "45 min", "1 hr"): "~15 min", "~1 hr", "up to 3 hr"; offer `short` and `medium` at launch, `long` hidden until a keyed run's cost is measured.
8. The developer contact address (`docs/legal/privacy-policy.md` §9 line 583, the `TODO(founder)` at 587; Play "Contact details", `docs/store/play/README.md` line 93). **Default:** a JW Labs LLC mailbox the founder creates; 4a shows it in Settings once it exists.
9. Does "block abusive users" need a listener-facing block? 4a has no user-to-user surface. **Default: operator-side only** (a `blocked_authors` table the service consults).

## 2. Task table

| id | title | executor | why-opus | depends-on | size |
|---|---|---|---|---|---|
| PH2-01 | Sharing legal gate (#126) answered + share-origin ruling (DECISIONS + policy §5 sentence) | opus | legal judgement; `docs/DECISIONS.md` is DENIED | — | S |
| PH2-02 | Pure share helpers in `app.js` + `test/share-links.test.js` | qwen | — | — | S |
| PH2-03 | Share control + Foray page mount (#690) + `shared` legal rows | qwen | — | 01, 02, 08 | S |
| PH2-04 | Episode page mount (#71 share-a-pick) | qwen | — | 03 | XS |
| PH2-05 | Styles + listener-copy pins for the share strings | qwen | — | 04 | XS |
| PH2-06 | Device check of Web Share / clipboard in both shells | opus | device measurement; `mobile/package.json` is DENIED_PATTERNS | 05 merged + a build | S |
| PH2-07 | Runtime target per tier (§8.11) reported by the pipeline | opus | `backend/src/` DENIED | — | S |
| PH2-08 | Length picker helpers (`LENGTH_TIERS`, `lengthPickerHtml`) + tests, not mounted | qwen | — | 02 | S |
| PH2-09 | HUMAN-ACTIONS #119 (Path B rulings), #120 (contact address), sequencing step on #31 | qwen | — | — | XS |
| PH2-10 | Supabase migration `0004_content_reports.sql` (insert-own + delete-own) + HUMAN-ACTIONS #121 | opus | security/RLS; `backend/migrations/` human merge | 09 | S |
| PH2-11 | Client report sheet + local queue (`cp_reports_pending`) + `report_sent` legal rows | qwen | — | 05 | S |
| PH2-12 | Report sync to Supabase + purge DELETE + privacy/data-safety rows | opus | credentials/auth flow, legal docs | 10, 11, 20 | S |
| PH2-13 | `docs/curation/ugc-moderation-runbook.md` | opus | App Store compliance judgement (§0, §6, SLA) | — | XS |
| PH2-14 | `0005_blocked_authors.sql` + `authorGate.ts` | opus | security; `backend/src/` DENIED | 10 | S |
| PH2-15 | Generation service skeleton: `node:http`, loopback, `/healthz`, `GET /generation/:id/status` | opus | `backend/src/` DENIED; security posture | — | S |
| PH2-16 | `POST /generation` submit route, one-at-a-time job queue, blocked-author check | opus | `backend/src/` DENIED; spend guard | 14, 15 | S |
| PH2-17 | Supabase bearer auth + persisted per-author daily quota | opus | credentials/security | 16 | S |
| PH2-18 | `GET /generation/:id/bundle` (finished private Foray as `{foray, segments, segment_sources}`) | opus | `backend/src/` DENIED | 16 | S |
| PH2-19 | `tools/generation/serve.mjs` launcher (relay + service) | qwen | — | 15 | S |
| PH2-20 | Client pure helpers: `mergeForayBundle`, `buildForayRequest`, `parseGenerationStatus` | qwen | — | 11 | S |
| PH2-21 | Create tab Foray mode: submit, poll, land (config-gated) | opus | product/UX judgement, copy | 08, 12, 18, 20, 23 | S |
| PH2-22 | Own Forays: durable bundle store, "Your Forays" in Library, unlock rule | opus | cross-cutting (resolver visibility rule, durable store) | 21 | S |
| PH2-23 | CSP `connect-src` + generation-origin config hook in `index.html` | opus | `index.html` human-merge; CSP | founder Q3-Q6 (#119) | XS |
| PH2-24 | DECISIONS entry recording the Path B rulings + STATE.md entry | opus | `docs/DECISIONS.md` DENIED | founder Q3-Q6 (#119) | XS |
| PH2-25 | Docs: pipeline-status, requirements §8.8, brief §0, curation/ux README pointers | qwen | — | 18, 21 | XS |

25 tasks: 15 opus, 10 qwen.

### Conventions every task must follow ("the conventions block")
- Worktree with LF: `git -C "<repo>" -c core.autocrlf=false worktree add ../foray-<task-id> -b ph2/<task-id> origin/main`. Never run `format:write` repo-wide.
- Never commit `deploy-manifest.json` or `data/forays-directory.json` (gitignored build outputs, issue #701). `sw.js` `BUILD_ID` stays the literal `"unstamped"`.
- A new `test/*.test.js`, `player/**/*.test.js` or `tools/**/*.test.mjs` suite needs an entry in `FLOORS` in `test/suite-integrity.test.js` (`const FLOORS = {` at line 54; entry form `"<path>": <count>, // <why>`), in the same PR, inserted after the anchor line the task names. Run `node --test test/suite-integrity.test.js` after adding it.
- A test that names a Foray uses `tools/foray/fixtures/frozen/data/*.json` (published id: `capital-types-1`; draft ids: `grilling-history-1`, `grilling-history-2`, `what-engineers-actually-do-all-day-e08236`), never live `data/forays.json`.
- One test process at a time: root suites `node --test test/<file>.test.js`; backend `cd backend && npm test -- test/<file>.test.ts` (vitest); never two runners concurrently.
- `node --check app.js` after any `app.js` edit. No inline handlers/styles (strict CSP); every interpolation through `esc()` (line 98), every href/src through `safeUrl()` (line 103).
- Copy in `app.js` speaks as "4a", never "we" (`test/listener-copy.test.js`); no "fascinating", "deep dive", "delve", "explores".
- Every new `cp_` localStorage key gets a row in `docs/legal/privacy-policy.md` §1's key table (line 59; rows like `cp_playlists` at line 133) in the same PR; `node --test test/legal-citations.test.js` and `node --test test/data-deletion.test.js` are gates.
- PRs open as **DRAFT**, title given per task, body opens with a 1-2 sentence TL;DR. Do not arm any wake-up or poll the PR afterwards.
- Commits end with the trailer lines your harness supplies (this session's: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_017FFM7M73d6sEYQiHroVesz`).
- DENIED for auto-merge (`tools/ci/path-policy.mjs` `DENIED_PREFIXES` line 61, incl. `backend/src/` at 75; `DENIED_PATTERNS` line 237, incl. `mobile/package.json` at 246): `backend/src/`, `docs/DECISIONS.md`, `docs/adr/`, `.github/`, `CLAUDE.md`, `tools/ci/`, `mobile/package*.json`; `api/`, `index.html`, `backend/migrations/` are unlisted and wait for a human. A qwen task never edits any of these; if it would have to, stop.

## 3. Task sections

### PH2-01 — Sharing legal gate (#126) answered and the share-origin ruling
**Executor:** opus — legal reasoning; edits `docs/DECISIONS.md` (DENIED).
**Context:** `docs/DECISIONS.md` lines 797-812 (2026-09-10 entry; line 807 "Issue #126 (C10) deferred: social sharing stays out"); `docs/product/2026-08-scope.md` line 115 (row 13, "revisit hard when generated output leaves the account that made it"); `docs/marketing/09-product-feature-review.md` lines 114 and 251 (R16 share-a-pick: `navigator.share` + clipboard fallback, `shared` event); `docs/legal/privacy-policy.md` §2 (line 221), §5 (line 445); `test/legal-citations.test.js` lines 560-760 (the event-type derivation and the test "both documents' event-type totals are the numbers the code produces" at line 705, whose comment at 713 says adding `logEvent("shared", {})` makes both documents wrong); `app.js:toEventRow` (line 674; `default: return null` = local only).
**Exact change:**
1. DECISIONS entry "2026-09-2x (sharing opens for published Forays and episodes; #126 gate answered)": the shared object is either a Foray already in the public catalogue or an episode's public page; nothing generated leaves the account that made it (private Forays from PH2-22 have no share control); no third party is contacted by 4a (the OS share sheet is the device's); the `shared` and `report_sent` events are local-only. State that the memo trigger is therefore not tripped and social graph / "Shared with you" remain out. Record `PUBLIC_SITE_ORIGIN = "https://jw-incorporated.github.io/foray/"` unless the founder answers Q1 otherwise.
2. `docs/legal/privacy-policy.md` §5: one sentence — sharing hands a public link to the device's share sheet and records nothing about who received it.
3. **Do not** touch §1's local-only event list or either document's "N of M" totals: `legal-citations` derives the set from `logEvent("…")` calls in `app.js`, so those edits must travel with the emitters (PH2-03 adds `shared`, PH2-11 adds `report_sent`). Put in the PR body the exact text those two tasks will paste: the §1/§2 event-row wording for `shared` and `report_sent`, and the sentence pattern for the totals (read it from the current §2 sentence the test locates via "policy §2's local-only-count sentence").
**Tests to add:** none; `test/legal-citations.test.js` is the gate.
**Commands:** `node --test test/legal-citations.test.js` → green (docs edited, `app.js` unedited); `node --test test/human-actions-integrity.test.js` → green.
**Do not touch:** `app.js`, `styles.css`, `index.html`, `docs/legal/data-safety.md`.
**Stop and escalate if:** the founder's answer to Q1 is anything but the two origins named; or the §5 sentence alone turns `legal-citations` red.
**Definition of done:** DRAFT PR "docs(legal): sharing gate answered (#126), share origin, local-only share/report events" with the DECISIONS entry, the §5 sentence, the PR-body text block; commands green; human merge.

### PH2-02 — Pure share helpers in `app.js`
**Executor:** qwen.
**Context:** `app.js:esc` (line 98), `safeUrl` (103), `toEventRow` (674), `resolveEpisode(id)` (10967), `const state = {` (67), the Pages origin literal (grep `jw-incorporated.github.io/foray/?foray=`, ~line 11987), `player/foray-resolve.js` `PUBLISHED = "published"` (line 40) and `forayVisibility` (134); `test/episode-page.test.js` `function loadApp()` (line 24: node:vm harness that evaluates `app.js` and exposes top-level functions); `test/suite-integrity.test.js` `FLOORS` (line 54) and the line `"test/episode-page.test.js": 8,` (405).
**Exact change (all in `app.js`, one new block placed directly above the line beginning `/* ---------- Forays (#128) ----------`, the only such comment):**
1. `const PUBLIC_SITE_ORIGIN = "https://jw-incorporated.github.io/foray/";`
2. `function shareUrlForForay(id)` → `null` when `id` is not a non-empty string; else `PUBLIC_SITE_ORIGIN + "#/foray/" + encodeURIComponent(id)`.
3. `function shareUrlForEpisode(id)` → same rule with `#/episode/`.
4. `function sharePayloadForForay(r)`: `r` is the resolver result (`r.id`, `r.title`, `r.foray.status`, `r.foray.summary`). Return `null` unless `r && r.foray && r.foray.status === "published"` and `shareUrlForForay(r.id)` is non-null. Else `{ kind: "foray", id: r.id, title: r.title, text: (r.foray.summary || r.title), url }`.
5. `function sharePayloadForEpisode(item)`: `null` unless `item && item.id && item.title`. `text` = `[item.title, item.show].filter(Boolean).join(" — ")` + (`item.hook` ? `"\n" + item.hook` : `""`). Return `{ kind: "episode", id: item.id, title: item.title, text, url: shareUrlForEpisode(item.id) }`.
6. `function sharePayloadFor(kind, id)`: `kind === "foray"` → `state.foray && state.foray.id === id ? sharePayloadForForay(state.foray) : null`; `kind === "episode"` → `sharePayloadForEpisode(resolveEpisode(id))`; else `null`. (Used by the click handler only; render-time markup takes a payload, see PH2-03.)
7. No change to `toEventRow`: a `shared` event must fall through to `default: return null`.
**Tests to add:** `test/share-links.test.js` (harness copied from `test/episode-page.test.js:loadApp`):
- "a published Foray shares its public page" — `sharePayloadForForay({id:"a b", title:"T", foray:{status:"published", summary:"S"}})` → url `https://jw-incorporated.github.io/foray/#/foray/a%20b`, text `"S"`. Mutation: `#/foray/` → `#/forays/`.
- "a draft Foray has no share payload" — status `"draft"` → `null`. Mutation: delete the status check.
- "a Foray with no summary shares its title". Mutation: `r.foray.summary || r.title` → `r.foray.summary`.
- "an episode's text is title, show, then hook on its own line". Mutation: drop the hook.
- "an episode without a show still shares". Mutation: remove `.filter(Boolean)` → text `"T — undefined"`.
- "ids are URL-encoded" — id `"x#1/2"` → `x%231%2F2`. Mutation: remove `encodeURIComponent`.
- "an unknown kind is null". Mutation: return the episode branch for unknown kinds.
- "the shared event never leaves the device" — `toEventRow({type:"shared", payload:{kind:"foray", id:"x"}}, "u")` → `null`. Mutation: add `case "shared"` returning a row.
`FLOORS`: insert `"test/share-links.test.js": 8, // PH2-02 share helpers` directly after the line `"test/episode-page.test.js": 8,`.
**Commands:** `node --check app.js`; `node --test test/share-links.test.js` → 8 pass; `node --test test/suite-integrity.test.js`; `node --test test/legal-citations.test.js`; `node --test test/listener-copy.test.js` — all green.
**Do not touch:** `player/`, `toEventRow`, `index.html`, `styles.css`, any legal doc, `logEvent` calls (none added here).
**Stop and escalate if:** `resolveEpisode` or `state` are not visible to the vm harness; `legal-citations` goes red; any suite outside the list fails.
**Definition of done:** DRAFT PR "feat(share): pure share helpers (#690, #71)"; commands green; no UI change.

### PH2-03 — Share control, Foray page mount (#690), and the `shared` legal rows
**Executor:** qwen.
**Context:** `app.js:starBtn` (1837) and `bindStars` (6244: the `_bound` guard, `preventDefault`/`stopPropagation`); `renderForay`'s markup — grep `<div class="fy-clips">` (~13002) and the line `<p class="fy-error" id="fy-error" role="status" aria-live="polite" hidden></p>` directly after it; the only `bindFeedback(r);` call (~13029, inside `renderForay`); `state.foray = r;` (~12878, set before the markup); `controlLabelAttr` (1746), `setControlLabel` (1727); the clipboard-in-gesture comment (grep `WebKit grants clipboard writes only within`, ~16607); `test/create-page.test.js` `makeEl` (line 50) and `_fire` (74); `test/foray-surfaces.test.js` `loadApp(bridge, { showDrafts, created })` (line 74: loads the frozen fixture and the real resolver); `test/draft-forays-switch.test.js`; `test/legal-citations.test.js` line 705 test and its comment (713); `docs/legal/privacy-policy.md` §1 (59) / §2 (221); `docs/legal/data-safety.md`; PH2-01's PR body (the row text); PH2-02's helpers.
**Exact change (`app.js`):**
1. `function shareBtn(payload)`: returns `""` when `payload` is falsy; else `<button type="button" class="share-btn" data-share-kind="${esc(payload.kind)}" data-share-id="${esc(payload.id)}" aria-label="Share">Share</button>`. Callers pass a payload computed from what they are rendering — never from `state`.
2. `function shareStatusHtml()` → `<p class="share-status" id="share-status" role="status" aria-live="polite" hidden></p>`.
3. `function shareNow(payload, statusEl)` (returns a Promise; called synchronously from the click handler):
   - (a) If `typeof navigator.share === "function"` and (`typeof navigator.canShare !== "function"` or `navigator.canShare({ url: payload.url })`): `navigator.share({ title: payload.title, text: payload.text, url: payload.url })`; on resolve `logEvent("shared", { kind: payload.kind, id: payload.id, via: "sheet" })`; on rejection with `err && err.name === "AbortError"` do nothing; any other rejection → (b).
   - (b) If `navigator.clipboard && typeof navigator.clipboard.writeText === "function"`: call `writeText(payload.text + "\n" + payload.url)` **before any `await`** in the no-sheet path; on resolve `statusEl.textContent = "Link copied"; statusEl.hidden = false; logEvent("shared", {…, via: "clipboard"})`; on rejection → (c).
   - (c) `statusEl.textContent = "Copy this link: " + payload.url; statusEl.hidden = false;`.
4. `function bindShare(scope)`: for each `[data-share-id]` in `scope` without `_bound`: set `_bound = true`; click listener `preventDefault()`, `stopPropagation()`, `sharePayloadFor(btn.dataset.shareKind, btn.dataset.shareId)`, return if `null`, else `shareNow(payload, $("#share-status"))`.
5. Foray page: directly after the `<p class="fy-error" id="fy-error" …></p>` line insert `` `<div class="fy-actions">${shareBtn(sharePayloadForForay(r))}${shareStatusHtml()}</div>` `` — emitted even when the button is empty (PH2-11's Report shares the status element). Directly after the `bindFeedback(r);` line add `bindShare($("#view"));`.
6. Legal (same PR, mechanical, text from PH2-01's PR body): add `shared` where §1 (and §2's "Not sent" list, test at line 752) enumerates local-only event types; raise the "N of M" totals by one in **both** `docs/legal/privacy-policy.md` and `docs/legal/data-safety.md` (the test comment at 713-714 gives the arithmetic).
**Tests to add:** `test/share-button.test.js` (harness: `test/create-page.test.js`'s `makeEl`/`_fire` DOM + `test/foray-surfaces.test.js`'s frozen-fixture loading):
- "a tap opens the system sheet with title, text and url" — fake `navigator.share` records its argument; assert three keys. Mutation: pass `{url}` only.
- "without a sheet the link is copied inside the tap" — `navigator.share` undefined; fake `writeText` sets a flag; assert true immediately after `_fire("click")`, no `await`. Mutation: `await Promise.resolve()` before `writeText`.
- "a dismissed sheet is silent" — `share` rejects `{name:"AbortError"}`; status hidden, `writeText` not called. Mutation: remove the `AbortError` branch.
- "a failed sheet falls back to the clipboard" — rejects `{name:"NotAllowedError"}`; `writeText` called. Mutation: swallow all errors.
- "no clipboard, no sheet: the link is shown" — status starts with `Copy this link: https://`. Mutation: leave status hidden.
- "Share appears on capital-types-1 and not on grilling-history-2" — render `#/foray/capital-types-1` and `#/foray/grilling-history-2` with `showDrafts: true`; `.share-btn` present/absent. Mutation: drop the `published` check.
- "Share does not read state.foray at render time" — set `state.foray = null` after `renderForay` assigns it (stub via the harness: wrap the render so `state.foray` is nulled before markup, or assert `shareBtn(sharePayloadForForay(r))` markup while `state.foray` is `null`); `.share-btn` still present. Mutation: `shareBtn` reads `sharePayloadFor("foray", r.id)` instead of the payload.
- "bindShare binds once" — call twice, fire once, `share` called once. Mutation: remove `_bound`.
`FLOORS`: insert `"test/share-button.test.js": 8, // PH2-03 share control` directly after PH2-02's `"test/share-links.test.js": 8,` line.
**Commands:** `node --check app.js`; `node --test test/share-button.test.js` → 8; `node --test test/share-links.test.js`; `node --test test/foray-surfaces.test.js`; `node --test test/foray-ribbon-restore.test.js`; `node --test test/draft-forays-switch.test.js`; `node --test test/listener-copy.test.js`; `node --test test/legal-citations.test.js`; `node --test test/suite-integrity.test.js` — all green.
**Do not touch:** `player/`, `index.html`, `styles.css` (PH2-05), the episode page (PH2-04), `toEventRow`, `bindForayTransport`.
**Stop and escalate if:** `legal-citations` cannot be made green by the §1/§2 row and the two totals alone; any suite outside the list fails.
**Definition of done:** DRAFT PR "feat(share): Share on the Foray page (#690)"; all commands green.

### PH2-04 — Episode page mount (#71 share-a-pick)
**Executor:** qwen.
**Context:** `app.js:renderEpisode(id)` (11362); its `.ep-actions` line (grep `<div class="ep-actions">${item.audio_url ? playBtn(item) : notPlayableNote()}${starBtn(item.id)}${upNextBtn(item.id, item)}</div>`, ~11396); its binding block ending `bindEpisodeSeeks($("#view"), item);` (~11405, unique); `epRow` (10763); `test/episode-page.test.js`.
**Exact change:** 1. Inside `.ep-actions` append `${shareBtn(sharePayloadForEpisode(item))}` after `upNextBtn(...)`; emit `${shareStatusHtml()}` as the next sibling after the `.ep-actions` div. 2. Directly after `bindEpisodeSeeks($("#view"), item);` add `bindShare($("#view"));`. 3. `epRow` gets **no** share control (control-density rule in the `upNextBtn` comment, ~1849).
**Tests to add:** in `test/share-button.test.js`: "the episode page carries Share and one status line" — render `#/episode/<id>` with the harness fixture as `test/episode-page.test.js` does; assert one `.share-btn[data-share-kind="episode"]` and one `#share-status`. Mutation: remove the mount. "an episode row has no Share" — `epRow` output has no `share-btn`. Mutation: add `shareBtn` to `epRow`. Floor 8 → 10.
**Commands:** `node --check app.js`; `node --test test/share-button.test.js` → 10; `node --test test/episode-page.test.js`; `node --test test/episode-page-publish-date-description-chapters.test.js`; `node --test test/suite-integrity.test.js`.
**Do not touch:** `epRow`, `player/`, `styles.css`, Home rails, legal docs.
**Stop and escalate if:** `bindEpisodeSeeks($("#view"), item);` is not inside `renderEpisode` (report where its controls are bound).
**Definition of done:** DRAFT PR "feat(share): Share on the episode page (#71)"; commands green.

### PH2-05 — Styles and copy pins for Share
**Executor:** qwen.
**Context:** `styles.css`: `.fy-clips { margin-top: 4px; }` (2416), the `.fy-clip` block just above it (~2405-2414: `min-width: 44px; min-height: 44px; padding: 0 8px; border: 0; background: none; color: var(--text-dim); font: inherit; font-size: var(--fs-sm); font-weight: 600;`), `.ep-actions` (2170), `.note { color: var(--text-dim); font-size: var(--fs-md); … }` (933), the `--fs-*` tokens (52-58); `test/listener-copy.test.js` (how strings are pinned) and its `FLOORS` line `"test/listener-copy.test.js": 22,` (459).
**Exact change:** 1. Directly after `.fy-clips { margin-top: 4px; }` add exactly:
```
.fy-actions { display: flex; align-items: center; justify-content: center; gap: 12px; margin-top: 12px; flex-wrap: wrap; }
.share-btn, .report-btn { min-width: 44px; min-height: 44px; padding: 0 8px; border: 0; background: none; color: var(--text-dim); font: inherit; font-size: var(--fs-sm); font-weight: 600; cursor: pointer; }
.share-btn:hover, .share-btn:active, .report-btn:hover, .report-btn:active { color: var(--text); }
.share-status { color: var(--text-dim); font-size: var(--fs-sm); margin: 6px 0 0; text-align: center; flex-basis: 100%; }
```
No `--muted`, no bare px font sizes, no new colour tokens. 2. `test/listener-copy.test.js`: one test "share copy speaks as 4a": the literals `"Link copied"` and `"Copy this link: "` exist in `app.js` and no line containing `share-status` or those literals matches `/\bwe\b/i`. Mutation: `"Link copied"` → `"We copied the link"`. Floor 22 → 23 (edit the existing line, no insertion).
**Commands:** `node --test test/listener-copy.test.js` → 23; `node --test test/share-button.test.js`; `node --test test/suite-integrity.test.js`.
**Do not touch:** any colour token definition; `app.js` logic.
**Stop and escalate if:** `.fy-clip`'s declarations differ from those quoted (copy what is there and say so in the PR).
**Definition of done:** DRAFT PR "style(share): share/report controls and status line"; green.

### PH2-06 — Device check of Web Share and clipboard inside the shells
**Executor:** opus — device measurement; `mobile/package.json` is a DENIED_PATTERNS path (human merge).
**Context:** `mobile/package.json` (no `@capacitor/share` today), `docs/mobile-shell.md`, `api/_lib/cors.ts` lines 33-38 (`capacitor://localhost`, `https://localhost`), `app.js` clipboard-in-gesture comment (~16607), `docs/field-records/2026-09-24-car-baseline.md` (record format).
**Exact change:** Build the shell (`docs/mobile-shell.md`) from a branch with PH2-03..05 merged. On iPhone and Android: tap Share on `capital-types-1` and on an episode; record which branch ran (sheet / clipboard / shown link). Write `docs/field-records/<date>-share-shells.md` with the table. If the sheet does not open on a shell: **PR A** (auto-mergeable): in `app.js:shareNow` step (a) prefer `window.Capacitor?.Plugins?.Share?.share({title, text, url})` when present (one branch; falls through to the web path when absent) + test; **PR B** (human merge): add `@capacitor/share` to `mobile/package.json` and the lockfile, body names PR A.
**Tests to add:** only with PR A: `test/share-button.test.js` "the shell's Share plugin is preferred" (fake `window.Capacitor.Plugins.Share`; mutation: delete the branch). Floor +1.
**Commands:** as PH2-03 plus the shell build.
**Do not touch:** native Swift/Kotlin; `ios/`.
**Stop and escalate if:** the clipboard is refused on both shells (the "Copy this link" fallback becomes the product; a founder should see it).
**Definition of done:** field record committed (DRAFT PR "docs(field): share sheet on both shells"); PR A / PR B only if needed.

### PH2-07 — Runtime target per tier, reported by the pipeline (§8.11)
**Executor:** opus — `backend/src/` DENIED.
**Context:** `backend/src/types/spine.ts` lines 23-39 (`DurationTierSchema`, `DURATION_SHAPE_BUDGETS`, `SHAPE_TOLERANCE = 0.15`); `docs/curation/foray-generation-requirements.md` §2.4 (326; "The runtime target itself is never checked" at ~344) and §8.11 (4053); `backend/src/generation/runPipeline.ts` `RunPipelineOutcome` (315) and the `runtime_sec` comment (526); `backend/src/cli/generateForays.ts:summarize` (187); `backend/test/buildSpine.test.ts`.
**Exact change:** 1. `spine.ts`: `export const DURATION_RUNTIME_TARGET_SEC: Record<DurationTier, number> = { short: 900, medium: 3600, long: 10800 }`, `export const RUNTIME_TOLERANCE = 0.15`, `export function runtimeTierVerdict(runtimeSec: number, tier: DurationTier): { ok: boolean; target: number; low: number; high: number }` — `short`/`medium`: `low = target*0.85`, `high = target*1.15`; `long`: `low = DURATION_RUNTIME_TARGET_SEC.medium*1.15`, `high = 10800*1.15`; `ok = runtimeSec >= low && runtimeSec <= high`. 2. `runPipeline.ts`: the `generated` outcome gains `runtimeVerdict` from the candidate's `runtime_sec` and `request.duration`; print one line `runtime <m> min (<tier>: ok|outside <low>-<high> s)`. Not fatal. 3. `summarize` appends the phrase. 4. Requirements §2.4 last paragraph: say what is now reported; §8.11: "reported since PH2-07, not enforced".
**Tests to add:** `backend/test/runtimeTier.test.ts`: three bands, boundaries inclusive (mutation: `>=` → `>`); `long` accepts 2 h and refuses 55 min (mutation: `target*0.85` for long); `summarize` includes the phrase (mutation: drop it).
**Commands:** `cd backend && npm test -- test/runtimeTier.test.ts`; `cd backend && npm test -- test/generateForays.test.ts test/buildSpine.test.ts`; `cd backend && npm run typecheck`.
**Do not touch:** `DURATION_SHAPE_BUDGETS`, `finalizeForay.ts` gates.
**Stop and escalate if:** the `generated` outcome's candidate carries no `runtime_sec`.
**Definition of done:** DRAFT PR "feat(generation): report runtime against the tier target (§8.11)"; human merge.

### PH2-08 — Length picker helpers (not mounted)
**Executor:** qwen.
**Context:** `app.js` Create block: `const CREATE_SUBJECT_SUGGESTIONS = [` (11822), `function createToggleHtml()` (11826), `renderCreate` (11918); `lsGet`/`lsSet` (147/157); `docs/DECISIONS.md` 2026-09-23 entry (422; the "One duration dialect" bullet ~437); `backend/src/types/spine.ts` line 23; `test/create-page.test.js` (test 5: the ~20/~40/~75 options are NOT shown); `docs/legal/privacy-policy.md` §1 key table (row form at line 133); `test/suite-integrity.test.js` line `"test/create-page.test.js": 13,` (1176).
**Exact change (`app.js`, directly above `function createToggleHtml()`):**
1. `const LENGTH_TIERS = [ { id: "short", label: "Short", sub: "~15 min" }, { id: "medium", label: "Medium", sub: "~1 hr" }, { id: "long", label: "Long", sub: "up to 3 hr" } ];`
2. `function selectedLengthTier()` → `lsGet("cp_create_length", "medium")` if it is a known id, else `"medium"`.
3. `function setLengthTier(id)` → no-op unless known; else `lsSet("cp_create_length", id)`.
4. `function lengthPickerHtml(selected = selectedLengthTier(), tiers = LENGTH_TIERS)` → `<div class="cr-length" role="radiogroup" aria-label="Foray length">` + per tier `<button type="button" class="cr-length-btn${on ? " is-on" : ""}" role="radio" data-cr-length="${esc(t.id)}" aria-checked="${on}">${esc(t.label)} <span class="cr-length-sub">${esc(t.sub)}</span></button>` + `</div>`.
5. `function bindLengthPicker(scope)`: click on `[data-cr-length]` → `setLengthTier`, repaint `is-on`/`aria-checked` on siblings. Nothing calls it yet.
6. Privacy policy §1 table: row `cp_create_length` | The Foray length you last picked on Create (`short`, `medium` or `long`) | **No**.
**Tests to add:** `test/create-length.test.js` (create-page harness): three radios, exactly one `aria-checked="true"` (mutation: all on); unknown stored value → `medium` (mutation: return raw); a tap stores and repaints (mutation: skip `lsSet`); "the client's tier ids equal the backend's enum" — read `backend/src/types/spine.ts`, regex `DurationTierSchema = z\.enum\(\[([^\]]+)\]\)`, compare sorted ids (mutation: `long` → `deep`); each `sub` matches `/^(~\d+ (min|hr)|up to \d+ hr)$/` (mutation: `"~60 minutes"`). `FLOORS`: insert `"test/create-length.test.js": 5, // PH2-08 length tiers` directly after the line beginning `"test/create-page.test.js": 13,`.
**Commands:** `node --check app.js`; `node --test test/create-length.test.js` → 5; `node --test test/create-page.test.js` (unchanged); `node --test test/listener-copy.test.js`; `node --test test/legal-citations.test.js`; `node --test test/data-deletion.test.js`; `node --test test/suite-integrity.test.js`.
**Do not touch:** `renderCreate`'s markup, `createToggleHtml`, `styles.css`.
**Stop and escalate if:** `test/create-page.test.js` test 5 goes red; `data-deletion` demands a ledger entry the §1 row does not satisfy (report the assertion text).
**Definition of done:** DRAFT PR "feat(create): length tier helpers for Foray mode (#174), unmounted".

### PH2-09 — HUMAN-ACTIONS items for the founder decisions
**Executor:** qwen.
**Context:** `HUMAN-ACTIONS.md` lines 1-30 (format v2 header; line 5 `> **25 open.**`), `## #118` (22) and `## #117` (34) — **already taken**, `## #116 🟡 [DECIDE] …` (63) with its `<!-- ha filed=2026-09-25 kind=default -->` marker and **Why/Steps/Worked if** as the model, `## #31` (226); `test/human-actions-integrity.test.js`; requirements §8.8 (4004-4028: the four decisions); `docs/legal/privacy-policy.md` §9 (583, `TODO(founder)` 587); `docs/store/play/README.md` line 93.
**Exact change:**
1. Compute the next ids: `git grep -h -o -E "^## #[0-9]+" origin/main -- HUMAN-ACTIONS.md | tr -dc '0-9\n' | sort -n | tail -1` (expect 118) and `git grep -h -o -E "^- #[0-9]+" origin/main -- HUMAN-ACTIONS-DONE.md | tr -dc '0-9\n' | sort -n | tail -1` (expect 110); use max+1 = **119** and max+2 = **120**.
2. `## #119 🟡 [DECIDE] Phase 2 Forays: the four Path B rulings — host, spend, review gate, CSP (~10 min)`, marker `<!-- ha filed=2026-09-25 kind=default -->`; **Why:** two sentences citing requirements §8.8; **Steps:** the four questions with the defaults from §1 Q3-Q6, each "reply `default` or your answer"; **Worked if:** "the answers are in `docs/DECISIONS.md` (PH2-24) and `index.html`'s `connect-src` names the service origin (PH2-23)".
3. `## #120 🟡 [DECIDE] A public contact address for 4a (Guideline 1.2, both stores, privacy policy §9) (~15 min)`: **Why:** the four 1.2 requirements (quote #31's step); **Steps:** create the mailbox; reply with it; an agent updates policy §9 and the Play "Contact details"; **Worked if:** the address is in `docs/legal/privacy-policy.md` §9 and mail reaches the founder.
4. In #31 append a step `8. Proposed sequencing (PH2 plan, 2026-09-25): build all four before the Create tab's Foray option is enabled for anyone but the founders; reports land in a Supabase table (#121 applies the migrations); blocking is operator-side; contact is #120.`
5. Header count = `grep -c "^## #" HUMAN-ACTIONS.md` after the edit (expect **27**).
**Tests to add:** none. **Commands:** `node --test test/human-actions-integrity.test.js` → green.
**Do not touch:** `HUMAN-ACTIONS-DONE.md`, `docs/DECISIONS.md`; do **not** file #121 (PH2-10 does).
**Stop and escalate if:** the computed ids are not 119/120 (then use the computed values and say so in the PR body — the other tasks cite "the Path B rulings item PH2-09 filed" by title as well as number).
**Definition of done:** DRAFT PR "docs(human-actions): #119 Path B rulings, #120 contact address, #31 sequencing".

### PH2-10 — Supabase migration for content reports
**Executor:** opus — RLS/security; `backend/migrations/` human merge.
**Context:** `backend/migrations/supabase/0001_auth_and_rls.sql`, `0002_linter_findings.sql`, `0003_rls_least_privilege.sql` (exists — the next number is **0004**), `README.md` (apply procedure); HUMAN-ACTIONS #116 (line 63) as the item template; `app.js:syncEventsOnce`/`trySyncEvents` (736) — the client already inserts into `events` with the anon session's bearer.
**Exact change:** 1. `backend/migrations/supabase/0004_content_reports.sql`: `create table public.content_reports (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade, created_at timestamptz not null default now(), target_kind text not null check (target_kind in ('foray','episode')), target_id text not null check (char_length(target_id) <= 200), reasons text[] not null default '{}', note text check (note is null or char_length(note) <= 280), status text not null default 'open' check (status in ('open','actioned','dismissed')));` `alter table public.content_reports enable row level security;` exactly two policies: `create policy content_reports_insert_own on public.content_reports for insert to authenticated with check (auth.uid() = user_id);` and `create policy content_reports_delete_own on public.content_reports for delete to authenticated using (auth.uid() = user_id);` **no** select/update policy; index on `(status, created_at)`. 2. README: apply step; daily review query `select id, created_at, target_kind, target_id, reasons, note from public.content_reports where status = 'open' order by created_at;`; note that `on delete cascade` covers account deletion and the delete-own policy serves the client's Delete-my-data (PH2-12). 3. `HUMAN-ACTIONS.md`: `## #121 🔴 [BLOCKING] Apply migrations 0004_content_reports.sql (and 0005 when filed) to the production project (~10 min)` in #116's shape (verify 121 is free with PH2-09's command; PH2-09 must be merged first); header count +1 (expect 28).
**Tests to add:** `backend/test/contentReportsMigration.test.ts`: file exists; contains `enable row level security`; exactly two `create policy` lines; insert policy contains `with check (auth.uid() = user_id)`; delete policy contains `using (auth.uid() = user_id)`; no line matches `/for (select|update)/i` (mutation: add a select policy); the `note` check is 280 (mutation: 2800).
**Commands:** `cd backend && npm test -- test/contentReportsMigration.test.ts`; `node --test test/human-actions-integrity.test.js`.
**Do not touch:** production; `0001`-`0003`.
**Stop and escalate if:** the README's apply procedure requires a service-role key in the repo; #121 is taken.
**Definition of done:** DRAFT PR "feat(supabase): content_reports table (Guideline 1.2 reporting)"; human merge; #121 filed.

### PH2-11 — Client report sheet, local queue, and the `report_sent` legal rows
**Executor:** qwen.
**Context:** `app.js:feedbackSheetHtml` (12582: ids `fy-sheet`, `fy-scrim`, `fy-sheet-note` maxlength 200, `fy-sheet-go`), `openFeedbackSheet` (12603), `closeFeedbackSheet` (12615), `setChipPressed` (12626), `sheetPicks` (12631), `syncSheetCta` (12635), `bindFeedback(r)` (12642), `openSheet(wrap, opts = {})` (6864), `closeSheet` (7083), `closeSheetsWithin` (7132), `lsGet`/`lsSet`, `logEvent` (481); in `renderForay`'s markup the line `${feedbackSheetHtml()}` (~13014) and the `bindFeedback(r);` call (~13029) followed by PH2-03's `bindShare($("#view"));`; PH2-03's `.fy-actions` div; `test/create-page.test.js` harness; `test/legal-citations.test.js` line 705 test; `docs/legal/privacy-policy.md` §1 (event list and `cp_` key table), `docs/legal/data-safety.md` totals; PH2-01's PR body text.
**Exact change (`app.js`, new block directly after the end of `bindFeedback`, before the next top-level `function`):**
1. `const REPORT_REASONS = ["Hateful or harassing", "Sexual content", "Dangerous or violent", "Misleading or false", "Spam or off-topic", "Something else"];`
2. `function reportSheetHtml()` — `feedbackSheetHtml`'s structure with ids `rp-sheet`, `rp-scrim`, `rp-sheet-title`, `rp-sheet-sub`, chips from `REPORT_REASONS` with `data-rchip`, `<input id="rp-sheet-note" type="text" maxlength="280" placeholder="What's wrong, in your own words" aria-label="What's wrong">`, `#rp-sheet-cancel`, `#rp-sheet-go` (disabled; label "Send report").
3. `let rpTarget = null;` `function openReportSheet(target)` (`{kind, id, title}`): set `rpTarget`; title `Report this ${target.kind === "episode" ? "episode" : "foray"}`; sub `About ${target.title}. 4a reads every report.`; clear chips/note; `openSheet(sheet, { onRequestClose: closeReportSheet })`. `closeReportSheet()` mirrors `closeFeedbackSheet` (dismiss records nothing).
4. `function queueReport(row)`: `row = { kind, id, reasons: string[], note: string (trimmed, sliced to 280), ts: ISO }`; list = `lsGet("cp_reports_pending", [])`; push; `slice(-20)`; `lsSet`. Then `logEvent("report_sent", { kind: row.kind, id: row.id })` and, if `typeof trySyncReports === "function"`, call it (PH2-12 defines it).
5. `function submitReport()`: needs `rpTarget` and (a picked chip or a non-empty note); `queueReport`; `#share-status` text `Thanks — 4a will look at it.`, unhide; `closeReportSheet()`.
6. `function reportBtn(kind, id, title)` → `<button type="button" class="report-btn" data-report-kind="…" data-report-id="…" data-report-title="…">Report</button>` (all through `esc()`); `bindReports(scope)` like `bindShare` → `openReportSheet`; chip/cancel/go/scrim wiring mirrors `bindFeedback`'s second half.
7. Mount: inside `.fy-actions` after `${shareBtn(...)}`: `${reportBtn("foray", r.id, r.title)}` (drafts included); `${reportSheetHtml()}` on the line directly after `${feedbackSheetHtml()}`; `bindReports($("#view"));` directly after `bindShare($("#view"));`.
8. Legal (same PR): `report_sent` added to §1's local-only event list and §2's "Not sent" list; both documents' totals +1 (PH2-01's PR body text); §1 key table row `cp_reports_pending` | Reports you sent that have not reached 4a yet (kind, id, reasons, your note, time); at most 20; cleared once sent | **No**.
**Tests to add:** `test/report-sheet.test.js` (create-page harness, frozen fixture Foray page): "Report opens the sheet named for the target" — episode target says "episode" (mutation: hard-code "foray"); "Send stays disabled until a reason or a note" (mutation: `go.disabled = false`); "dismissing writes nothing" (mutation: queue on close); "sending writes one row of the stated shape" — keys `kind,id,reasons,note,ts` (mutation: drop `reasons`); "the note is trimmed and capped at 280" (mutation: remove `slice`); "the queue keeps the last 20" (mutation: remove `slice(-20)`); "report_sent stays on the device" — `toEventRow({type:"report_sent", payload:{}}, "u")` is `null` (mutation: add a case); "grilling-history-2 has Report but no Share" (mutation: gate `reportBtn` on published). `FLOORS`: insert `"test/report-sheet.test.js": 8, // PH2-11 report sheet` directly after PH2-03's `"test/share-button.test.js": …` line.
**Commands:** `node --check app.js`; `node --test test/report-sheet.test.js` → 8; `node --test test/share-button.test.js`; `node --test test/foray-surfaces.test.js`; `node --test test/listener-copy.test.js`; `node --test test/legal-citations.test.js`; `node --test test/data-deletion.test.js`; `node --test test/suite-integrity.test.js`.
**Do not touch:** `feedbackSheetHtml`/thumbs code, `toEventRow`, network code, `styles.css` beyond reusing `.fy-sheet` classes.
**Stop and escalate if:** `openSheet`'s options are not `{ onRequestClose }` (read lines 6864-6900 and report); `legal-citations` cannot be made green by the event rows and totals alone.
**Definition of done:** DRAFT PR "feat(moderation): Report sheet on the Foray page (Guideline 1.2)"; green.

### PH2-12 — Report sync, purge DELETE, and the legal rows
**Executor:** opus — auth/credential flow in the client, legal documents.
**Context:** `app.js` `const SB_URL`/`SB_KEY` (528-529), `ensureAnonSession(epoch = deletionEpoch)` (616), `let deletionEpoch = 0;` (459), `trySyncEvents` (736) and the `syncEventsOnce` it calls (`syncOutlived`, `syncsInFlight`), the delete-my-data path (`git grep -n "deletionEpoch" -- app.js`), `docs/legal/privacy-policy.md` §2 (221), §7 (498); `docs/legal/data-safety.md` A1 table row "App activity — Other user-generated content" (line 99: already **Yes / not shared**, cites the thumbs note); `test/legal-citations.test.js`; PH2-10's table (delete-own policy exists); PH2-11's queue.
**Exact change:** 1. `trySyncReports()` + `syncReportsOnce(epoch)` modelled on the events pair: read `cp_reports_pending`; empty → return; `ensureAnonSession(epoch)`; POST `${SB_URL}/rest/v1/content_reports` rows `{ user_id: s.user_id, target_kind: r.kind, target_id: r.id, reasons: r.reasons, note: r.note || null }` (`Prefer: return=minimal`); on `res.ok` remove exactly those rows (rows added meanwhile stay); on failure keep all; register in `syncsInFlight`; honour `syncOutlived`. 2. Call `trySyncReports()` beside every `trySyncEvents()` call site (boot/foreground). 3. Delete-my-data: before the `events` DELETE, `DELETE ${SB_URL}/rest/v1/content_reports?user_id=eq.<id>` (the policy is in 0004); clear `cp_reports_pending` in the local purge. 4. Privacy policy §2: row "Reports you send" (kind, id, reasons, note ≤ 280; when: Send report; where: Supabase; retention: until you delete your data); §7 lists the table; §1's `cp_reports_pending` row (PH2-11) gains "sent as soon as 4a is online". Data-safety A1 row 99: extend the "how" cell to name the report (`content_reports`, `#rp-sheet-note`, `maxlength=280`).
**Tests to add:** `test/report-sheet.test.js`: "a synced report leaves the queue; a failed POST keeps it" (fake fetch 201/500; mutation: clear on failure); "rows queued during the POST survive" (mutation: `lsSet([])`); "delete-my-data purges reports" (fake fetch records the DELETE; mutation: drop it). Floor 8 → 11. `legal-citations` green with the new rows.
**Commands:** `node --check app.js`; `node --test test/report-sheet.test.js` → 11; `node --test test/data-deletion.test.js`; `node --test test/legal-citations.test.js`; `node --test test/suite-integrity.test.js`.
**Do not touch:** `SB_KEY`, `index.html` (Supabase origin already in `connect-src`), migrations.
**Stop and escalate if:** the purge path cannot host a second DELETE without reordering the epoch checks.
**Definition of done:** DRAFT PR "feat(moderation): reports reach Supabase; purge and legal rows"; green; body says #121 must be applied before the POST succeeds in production.

### PH2-13 — UGC moderation runbook
**Executor:** opus — §0 and §6 are App Store Guideline 1.2 compliance judgement and the SLA is a policy proposal; XS.
**Context:** `docs/curation/generation-architecture.md` §1.3 (166), `HUMAN-ACTIONS.md` #31 (226), `player/foray-resolve.js:forayVisibility` (134), `tools/foray/check-forays.test.mjs` test "exactly the named Forays are published, and no other" (258), `backend/src/cli/publishForay.ts` header, `backend/src/generation/safetyCheck.ts` on `main` @ `ecb6bfa3` (the intent-keyed Q4 version), `docs/curation/README.md`.
**Exact change:** write `docs/curation/ugc-moderation-runbook.md` with sections: **0. Why** (§1.3 quote, the four 1.2 pieces); **1. Content filtering** — `checkSafety` in `safetyCheck.ts` on `main`, the founder publish gate (`publish-foray`), the D-tier editorial rules in `tools/foray/check-forays.mjs`; **2. Reports** — the sheet (PH2-11), the table (PH2-10), the daily query, SLA "read within 24 h, act within 72 h" marked *proposal*; **3. Takedown** — numbered: branch; set the Foray's `status` to `"draft"` in `data/forays.json`; update the named-published list in `tools/foray/check-forays.test.mjs`; `node --test tools/foray/check-forays.test.mjs`; DRAFT PR `moderation: withdraw <id>`; the resolver hides it when the deploy lands; for a private Foray (PH2-22) delete the candidate file on the service host and mark the report `actioned`; **4. Blocking** — `blocked_authors` (PH2-14), how to insert a row; **5. Contact** — HUMAN-ACTIONS #120; **6. What Apple sees** — one paragraph per requirement → mechanism. Bullet in `docs/curation/README.md`.
**Tests to add:** none. **Commands:** `node tools/ci/run-suites.mjs --list` (no suite touched).
**Do not touch:** code, `data/`.
**Stop and escalate if:** `check-forays.test.mjs` line 258's test does not pin the published set by name (drop step 3 and say so).
**Definition of done:** DRAFT PR "docs(curation): UGC moderation runbook".

### PH2-14 — Blocked authors: migration and `authorGate.ts`
**Executor:** opus — security; `backend/src/` DENIED.
**Context:** PH2-10 merged (0004, #121); `backend/src/cli/migrate.ts` (line 3 `import { Client } from "pg"` — how a `Client` is built from `DATABASE_URL`); `backend/src/curation/createUserInterestsProvider.ts` (gated on `DATABASE_URL`; factory shape); `backend/src/curation/eventStore.ts` (`import type { Client } from "pg"`; a store taking a `Client`); `backend/src/config/env.ts`; `backend/test/createPromptUnderstander.test.ts` (factory test style).
**Exact change:** 1. `backend/migrations/supabase/0005_blocked_authors.sql`: `create table public.blocked_authors (user_id uuid primary key references auth.users(id) on delete cascade, reason text, blocked_at timestamptz not null default now()); alter table public.blocked_authors enable row level security;` — no policies (service role only). README apply step; append `0005` to HUMAN-ACTIONS #121's steps (count unchanged). 2. `backend/src/generation/authorGate.ts`: `export interface AuthorGate { isBlocked(authorId: string): Promise<boolean> }`; `export class StubAuthorGate` (always `false`); `export class PgAuthorGate` constructed with a `{ query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }> }` (the pg `Client` shape) running `select 1 from public.blocked_authors where user_id = $1`; `export function createAuthorGate(env = process.env): AuthorGate` → `PgAuthorGate` over a `Client` built as `cli/migrate.ts` builds it when `DATABASE_URL` is set, else `StubAuthorGate`. `runPipeline.ts` unchanged.
**Tests to add:** `backend/test/authorGate.test.ts`: stub never blocks; Pg gate with a fake `query` returns `true` for one row / `false` for none (mutation: invert); factory picks the stub without `DATABASE_URL` (mutation: always Pg); migration has RLS and no `create policy` (mutation: add one).
**Commands:** `cd backend && npm test -- test/authorGate.test.ts`; `cd backend && npm run typecheck`; `node --test test/human-actions-integrity.test.js`.
**Do not touch:** `runPipeline.ts`, `safetyCheck.ts`, `0001`-`0004`.
**Stop and escalate if:** `DATABASE_URL` is not the env name `migrate.ts` reads.
**Definition of done:** DRAFT PR "feat(generation): author gate for blocked authors"; human merge.

### PH2-15 — Generation service skeleton
**Executor:** opus — `backend/src/` DENIED; binding/security posture.
**Context:** `backend/src/generation/generationStatus.ts` (`readPartialCandidate(candidateDir, forayId, requestingUserId): GenerationStatusOutcome`, line 62; header lines 1-40), `docs/curation/player-streaming-brief.md` §2 (99: `found:false` and `authorized:false` both → 404), `backend/src/cli/generateForays.ts:parseArgs` (124; `--out` default `data-local/foray-candidates`), `backend/package.json` scripts (lines 11-20), `tools/generation/start-run.mjs` header.
**Exact change:** 1. `backend/src/service/generationServer.ts`: `export interface ServerDeps { candidateDir: string; authenticate(req): Promise<{ userId: string } | null>; authorGate: AuthorGate; now?: () => number }`; `export function createHandler(deps)` → `(req, res) => void`: `GET /healthz` → `200 {"ok":true}`; `GET /generation/:id/status` → 401 when `authenticate` returns null; else `readPartialCandidate` → `404 {"error":"not found"}` for not-found and unauthorised, `200 {candidate}` otherwise; anything else 404. Body limit 8 KiB (413); JSON only; `Cache-Control: no-store`. 2. `export function startServer({ port, host = "127.0.0.1", ...deps })` — throws on a non-loopback `host` unless `GENERATION_BIND_PUBLIC=1`. 3. `backend/src/cli/serveGeneration.ts` + script `"serve-generation": "tsx src/cli/serveGeneration.ts"`; `--port` (default 8790), `--out`; authenticate stub reads `x-debug-user` only when `NODE_ENV !== "production"` (PH2-17 replaces it). Import `AuthorGate` type from PH2-14 if merged, else define the interface locally and note it.
**Tests to add:** `backend/test/generationServer.test.ts` (real `node:http`, port 0): healthz 200; status 401 without auth; 404 for a foreign author's partial (temp dir fixture `authorId: "other"`; mutation: 403); 200 for the author; non-loopback refused (mutation: drop the check); oversized body 413.
**Commands:** `cd backend && npm test -- test/generationServer.test.ts test/generationStatus.test.ts`; `cd backend && npm run typecheck`.
**Do not touch:** `runPipeline.ts`, `api/`.
**Stop and escalate if:** `readPartialCandidate`'s outcome union lacks `found`/`authorized` discriminants as the brief describes.
**Definition of done:** DRAFT PR "feat(service): generation status server, loopback-only"; human merge.

### PH2-16 — Submit route and the job queue
**Executor:** opus — `backend/src/` DENIED; spend guard.
**Context:** PH2-15; `backend/src/cli/generateForays.ts`: `generateOneCandidate` (510, exported), `classifyFailure` (254), `candidateFilename(prompt)` (170); `backend/src/types/generation.ts` line 17 `visibility: z.literal("catalogue")`; requirements §2.3; `backend/test/generateForaysArgs.test.ts`, `backend/test/understandPrompt.test.ts` (grep `"catalogue"`); `docs/curation/generation-kpis.md` cost row.
**Exact change:** 1. `visibility: z.enum(["catalogue", "private"])`; every test pinning the literal asserts both. 2. `POST /generation` body `{ prompt: string, duration: "short"|"medium"|"long" }` → `{ prompt, duration, author_id: userId, visibility: "private" }`; 400 on schema failure; 403 `{"error":"unavailable"}` when `authorGate.isBlocked(userId)`; 429 when the per-author UTC-day count ≥ `MAX_PER_AUTHOR_PER_DAY` (env, default 3); else mint `forayId` via `candidateFilename`'s slug+hash, push a job, `202 { id, status_url: "/generation/<id>/status" }`. 3. Queue: one running job (array + `running` flag); each job calls `generateOneCandidate` with `out = candidateDir`, `budgetUsd` from `GENERATION_BUDGET_USD` (default 10), `dryRun: false`; job state `{ state: "queued"|"running"|"done"|"failed", error?: string }` in memory, mirrored to `<candidateDir>/<id>.job.json`. 4. Status route: no partial yet → `200 { state }` from the job file for the author, 404 otherwise.
**Tests to add:** `backend/test/generationSubmit.test.ts` with an injected fake `runJob`: 202 + id; second submit `queued` while the first is `running`; blocked author 403 (mutation: 200); fourth submit 429 (mutation: flip `>=`); 400 on `duration: "huge"`; built request has `visibility: "private"` (mutation: `"catalogue"`).
**Commands:** `cd backend && npm test -- test/generationSubmit.test.ts test/generationServer.test.ts test/generateForaysArgs.test.ts test/understandPrompt.test.ts`; `cd backend && npm run typecheck`; `cd backend && npm test` once at the end.
**Do not touch:** `publishForay.ts`, `safetyCheck.ts`.
**Stop and escalate if:** `generateOneCandidate` cannot be called without the CLI's notify plumbing (then add one thin exported wrapper in `generateForays.ts`, nothing more).
**Definition of done:** DRAFT PR "feat(service): submit route and one-at-a-time job queue"; human merge.

### PH2-17 — Supabase bearer auth and persisted quota
**Executor:** opus — credentials.
**Context:** `app.js` 528-529 (`SB_URL`, publishable key) and `syncEventsOnce`'s `Authorization: Bearer`; Supabase `GET /auth/v1/user` (bearer + `apikey`); PH2-15's `authenticate` seam; PH2-16's counter.
**Exact change:** 1. `backend/src/service/supabaseAuth.ts`: `createSupabaseAuthenticator({ url, anonKey, fetch, cacheMs = 300000 })` → `authenticate(req)`: read `Authorization: Bearer <jwt>`; GET `${url}/auth/v1/user` with `apikey: anonKey` + bearer; 200 → `{ userId: body.id }`; else `null`; cache by token hash for `cacheMs`. `serveGeneration.ts` reads `SUPABASE_URL`, `SUPABASE_ANON_KEY`; refuses to start in production without both. No service-role key. 2. Quota → `<candidateDir>/quota.json` (`{ "<day>": { "<userId>": n } }`), pruned to the last 2 days.
**Tests to add:** `backend/test/supabaseAuth.test.ts` (fake fetch): valid → userId; 401 → null; cached second call makes no fetch (mutation: drop cache); missing header → null; quota persists across two handler instances on one dir (mutation: memory only).
**Commands:** `cd backend && npm test -- test/supabaseAuth.test.ts test/generationSubmit.test.ts`; `cd backend && npm run typecheck`.
**Do not touch:** the client's auth code.
**Stop and escalate if:** the anon key cannot call `/auth/v1/user` with a user bearer.
**Definition of done:** DRAFT PR "feat(service): Supabase bearer auth and daily quota"; human merge.

### PH2-18 — Bundle route for a finished private Foray
**Executor:** opus — `backend/src/` DENIED.
**Context:** `backend/src/generation/finalizeForay.ts` (the minting helpers `publishForay.ts` imports at its lines 5-18: `mintedSegmentRow`, `mintedPoolCollisions`, `foraysReferencing`), the candidate file `generateOneCandidate` writes (`<out>/<slug>-<hash>.json`), `player/foray-resolve.js` (indexes `doc.segments` by `id` line 84 and `doc.sources` by `id` line 89; items reference `segment_id`; top-level shapes `{version, built_at, notes, forays|segments|sources}` at 555-556), `tools/foray/fixtures/frozen/data/segments.json` / `segment-sources.json` row shapes.
**Exact change:** `GET /generation/:id/bundle`: authenticate; locate the finished candidate by `id` (never filename); 404 unless it exists and `authorId === userId`; build `{ foray: <forays.json row, status "private", generated: true>, segments: [<minted rows, segments.json shape>], segment_sources: [<segment-sources.json shape>] }` with the same functions `publishForay.ts` uses; `mintedPoolCollisions` against the committed pool must be empty else 409 (ids logged). `Cache-Control: private, no-store`. Document the shape as `docs/curation/player-streaming-brief.md` §6 (after §5, line 186).
**Tests to add:** `backend/test/generationBundle.test.ts`: author gets 200 with the three keys and every item `segment_id` present in `segments` (mutation: drop a row); other user 404; collision → 409 (mutation: ignore); `foray.status === "private"` (mutation: `"draft"`).
**Commands:** `cd backend && npm test -- test/generationBundle.test.ts test/finalizeForay.test.ts`; `cd backend && npm run typecheck`.
**Do not touch:** `data/*.json`, `publishForay.ts`.
**Stop and escalate if:** the candidate file lacks the fields `mintedSegmentRow` needs.
**Definition of done:** DRAFT PR "feat(service): private bundle route"; human merge.

### PH2-19 — `tools/generation/serve.mjs` launcher
**Executor:** qwen.
**Context:** `tools/generation/start-run.mjs` (whole file: line 65 `import { createRelay, DEFAULT_DIR, DEFAULT_PORT } from "./relay.mjs"`, line 90 `port: Number(val("--port", process.env.RELAY_PORT ?? DEFAULT_PORT))`, `RELAY_PLACEHOLDER_KEY` (34), child spawn, teardown); `tools/generation/relay.mjs` line 187 `export const DEFAULT_PORT = 8788;` (8787 was the retired events server — never use it); `tools/generation/warm-transcript-index.test.mjs`; `test/suite-integrity.test.js` line `"tools/generation/relay.test.mjs": 33,` (1442).
**Exact change:** 1. `tools/generation/serve.mjs`: `export function parseArgs(argv, env = process.env)` → `{ port: 8790, relayPort: Number(env.RELAY_PORT ?? DEFAULT_PORT), out: "data-local/foray-candidates", keyed: false, relayOnly: false, passthrough: [] }` from `--port`, `--relay-port`, `--out`, `--keyed` (skip the relay; require `ANTHROPIC_API_KEY`), `--relay-only`, and everything after `--`. 2. `export function childArgs(args)` → `["run", "serve-generation", "--prefix", "backend", "--", "--port", String(args.port), "--out", args.out, ...args.passthrough]`. 3. `main()`: start the relay as `start-run.mjs` does unless `keyed`; same env; spawn `npm` with `childArgs`; teardown copied verbatim. 4. Header comment: purpose and one-line usage.
**Tests to add:** `tools/generation/serve.test.mjs`: defaults — `relayPort === 8788` and equals the imported `DEFAULT_PORT` (mutation: 8787); `--keyed` disables the relay (mutation: ignore flag); `childArgs` order and passthrough after `--` (mutation: drop `--`); `--out` reaches the child (mutation: hard-code). `FLOORS`: insert `"tools/generation/serve.test.mjs": 4, // PH2-19 launcher` directly after the line beginning `"tools/generation/relay.test.mjs": 33,`.
**Commands:** `node --test tools/generation/serve.test.mjs` → 4; `node --test tools/generation/relay.test.mjs` → 33; `node --test test/suite-integrity.test.js`; `node tools/ci/run-suites.mjs --list` shows the suite.
**Do not touch:** `relay.mjs`, `start-run.mjs`, `backend/`.
**Stop and escalate if:** PH2-15's merged script is not named `serve-generation`.
**Definition of done:** DRAFT PR "feat(generation): serve.mjs launcher for the generation service".

### PH2-20 — Client pure helpers: merge a bundle, build a request, parse a status
**Executor:** qwen.
**Context:** `app.js:renderForay` (grep `player.resolve(state.forays`; note `segmentsDoc: state.segments, sourcesDoc: state.segmentSources`), `player/foray-resolve.js` lines 84 (`indexBy(doc?.segments, "id")`), 89 (`indexBy(doc?.sources, "id")`), 555-556 (document shapes), `PUBLISHED` (40); the frozen fixture files (top-level `{ version, built_at, notes, forays }`, `{ …, segments }`, `{ …, sources }`); `backend/src/types/generation.ts` `GenerationRequestSchema` (15-17); `test/foray-surfaces.test.js` `loadApp` (74); PH2-08's `LENGTH_TIERS`; PH2-11's FLOORS line.
**Exact change (`app.js`, new block directly below PH2-02's share helpers, still above the `Forays (#128)` comment):**
1. `function mergeForayBundle(docs, bundle)`: `docs = { forays, segments, sources }` (the three loaded documents), `bundle = { foray, segments: [], segment_sources: [] }`. Returns **new** document objects, never mutating: `bundle.foray` replaces a same-`id` row in `forays.forays` or is appended; each `bundle.segments[i]` is appended to `segments.segments` unless a committed row with the same `id` exists — identical content (`JSON.stringify` equal) is skipped, different content throws `new Error("segment id collision: " + id)`; `bundle.segment_sources` maps onto `sources.sources` with the same `id` rule. Missing/invalid bundle → return `docs` unchanged.
2. `function buildForayRequest(prompt, tier)`: trim; empty or > 200 chars → `null`; tier not in `LENGTH_TIERS` ids → `null`; else `{ prompt, duration: tier, visibility: "private" }`.
3. `function parseGenerationStatus(json)` → `{ state: "queued"|"running"|"done"|"failed"|"unknown", ready: state === "done" }`; accepts `{state}` and a partial (`json.candidate` present → `"running"`).
**Tests to add:** `test/foray-bundle.test.js` (frozen fixture + real resolver as `foray-surfaces` loads it): merge appends a new Foray and its rows and `player.resolve` resolves it with `unlocked: [id]` (mutation: append segments to `sources`); same-id Foray replaced not duplicated (mutation: always append); collision throws (mutation: overwrite); identical duplicate skipped; inputs not mutated (frozen inputs; mutation: `push` on input); `buildForayRequest` null cases; the `"private"` literal (mutation: `"catalogue"`); status parse of both shapes. `FLOORS`: insert `"test/foray-bundle.test.js": 8, // PH2-20 bundle helpers` directly after PH2-11's `"test/report-sheet.test.js": …` line.
**Commands:** `node --check app.js`; `node --test test/foray-bundle.test.js` → 8; `node --test test/foray-surfaces.test.js`; `node --test test/suite-integrity.test.js`.
**Do not touch:** `player/foray-resolve.js`, `renderForay`, state loading.
**Stop and escalate if:** any suite outside the list fails.
**Definition of done:** DRAFT PR "feat(create): bundle merge and request helpers for Foray mode".

### PH2-21 — Create tab Foray mode: submit, poll, land
**Executor:** opus — product/UX judgement (states, copy); decides the origin hook's client side.
**Context:** `app.js` Create block (`CREATE_SUBJECT_SUGGESTIONS` 11822 → `renderCreate` 11918 and the `paintCreatePending` (11860) / `whenSearchDataReady` (2336) pattern), `statusPageHtml` (1410), `renderEpoch` (17040; incremented at 16759), `logEvent`, `test/create-page.test.js` (tests 3-5 **rewritten deliberately**: the Foray option is enabled only when the origin is configured), PH2-08/PH2-20 helpers, PH2-23's hook, `docs/ui-transition-plan.md` D8, `docs/DECISIONS.md` 2026-09-23 lane L4 entry (3354), privacy policy §1 key table.
**Exact change:** 1. `state.generationOrigin` = the value PH2-23 exposes, else `null`; `createToggleHtml()` enables the Foray button iff `state.generationOrigin` **and** `MODERATION_READY` (a constant `true` only once PH2-10/11/12/14 are on `main`; until then today's disabled copy). 2. Foray form: prompt input (`maxlength="200"`), `lengthPickerHtml()` limited to `short`/`medium` unless `showDraftsOn()` (the test track shows `long`), Build → `buildForayRequest` → `fetch(origin + "/generation", { method: "POST", headers: { Authorization: "Bearer " + s.access_token, "Content-Type": "application/json" }, body })` via `ensureAnonSession`. 3. `idle → submitting → waiting(id) → ready | failed`; poll `/generation/<id>/status` every 15 s only while Create is on screen (clear on `renderEpoch` change); on `done` GET the bundle → `mergeForayBundle` → PH2-22's store → `location.hash = "#/foray/" + encodeURIComponent(id)`. Persist `{id, ts}` in `cp_foray_requests` (§1 row in the same PR) so a returning listener sees "Building… check back in a few minutes" and one poll fires on render. 4. Copy per `listener-copy`: 429 → "You've asked for three today — tomorrow brings more"; 401/403 → "Custom Forays aren't available for this account"; network failure → `statusPageHtml`'s retry pattern.
**Tests to add:** `test/create-foray-mode.test.js` (create-page harness, fake fetch): toggle disabled without origin (mutation: ignore origin); enabled with origin + `MODERATION_READY`; submit posts exact body and bearer (mutation: drop `visibility`); `done` fetches the bundle and navigates (mutation: navigate on `running`); leaving the page stops polling (mutation: keep timer); 429 copy. `FLOORS`: new line after PH2-20's; `"test/create-page.test.js"` count updated with the rewrite.
**Commands:** `node --check app.js`; `node --test test/create-foray-mode.test.js`; `node --test test/create-page.test.js`; `node --test test/create-length.test.js`; `node --test test/home-information-architecture.test.js`; `node --test test/listener-copy.test.js`; `node --test test/legal-citations.test.js`; `node --test test/suite-integrity.test.js`.
**Do not touch:** `player/`, the playlist half of Create, `index.html`.
**Stop and escalate if:** #119 is unanswered (build behind the gate, do not enable); `MODERATION_READY` prerequisites are not merged.
**Definition of done:** DRAFT PR "feat(create): Foray mode behind the generation-origin gate"; green; body lists the rulings it waits on.

### PH2-22 — Own Forays: durable store, "Your Forays", unlock rule
**Executor:** opus — cross-cutting (visibility rule, durable storage).
**Context:** `player/durable-store.js` (tier diagram lines 20-63), `app.js:unlockedForays()` (12010: `forayParam()` → at most one id), `forayViewOpts` (12076), `showDraftsOn` (12034), `player/foray-resolve.js:forayVisibility` (134) and `listableForays`, `renderLibrary` (11678), `renderForay`'s draft note (grep `Draft — not published. You opened it by name`, ~12886), `test/draft-forays-switch.test.js`, `test/data-deletion.test.js` `STORE_LEDGER` (1472) and its test "every store the app opens is in the deletion ledger" (1482).
**Exact change:** 1. Bundles stored through the durable store under `foray_bundles` (IndexedDB tier; never `localStorage`); `myForayIds()` reads the ids. 2. `unlockedForays()` → `[...(forayParam() ? [forayParam()] : []), ...myForayIds()]`; the draft note gains a `status === "private"` variant: "Yours — only you can open it." 3. On boot, after the three documents load, merge stored bundles via `mergeForayBundle`. 4. Library: section "Your Forays" (newest first) above the Foray list; hidden when empty. 5. No share control for private Forays (PH2-02's rule). 6. Delete-my-data clears `foray_bundles`; `STORE_LEDGER` entry `deleted`. 7. Privacy policy §1: one row for `foray_bundles` (stays on device).
**Tests to add:** `test/own-forays.test.js`: a stored bundle resolves and lists under "Your Forays" (mutation: skip merge); not in the public list (mutation: `status: "published"`); no Share (mutation: allow private); deletion clears it; `#/forays` HTML byte-identical to today's with no bundles (mutation: alter the public rule). FLOORS line after PH2-21's.
**Commands:** `node --check app.js`; `node --test test/own-forays.test.js`; `node --test test/draft-forays-switch.test.js`; `node --test test/data-deletion.test.js`; `node --test test/legal-citations.test.js`; `node --test test/suite-integrity.test.js`; `node --test "player/*.test.js"` if `player/durable-store.js` changes.
**Do not touch:** `player/foray-resolve.js` visibility semantics.
**Stop and escalate if:** the durable store has no tier suited to ~100 KB objects.
**Definition of done:** DRAFT PR "feat(forays): your own Forays in Library"; green.

### PH2-23 — CSP and the generation-origin configuration hook
**Executor:** opus — `index.html` human-merge; CSP.
**Context:** `index.html` line 35 (`connect-src 'self' https://qjdllvqdcgacvujhclny.supabase.co https://foray-web-seven.vercel.app`), `test/legal-citations.test.js` (policy's connect-src count pinned to `index.html`), `docs/legal/privacy-policy.md` §4 (346) / §5 (445), `tools/mobile/prepare-webdir.mjs`, `test/app-security.test.js`, `test/boot-path.test.js`.
**Exact change:** after #119 is answered: add the service origin to `connect-src`; expose it as `<meta name="foray-generation-origin" content="…">` read by `app.js` at boot (no inline script; no extra fetch on the boot path — state this reasoning in the PR body); update policy §4/§5 origin sentences and `data-safety.md`; the shell picks it up through `prepare-webdir.mjs` unchanged.
**Tests to add:** `legal-citations` origin count adjusts; `app-security` and `boot-path` unchanged and green.
**Commands:** `node --test test/legal-citations.test.js`; `node --test test/app-security.test.js`; `node --test test/boot-path.test.js`.
**Do not touch:** `script-src`, `style-src`.
**Stop and escalate if:** #119 unanswered.
**Definition of done:** DRAFT PR "chore(csp): generation service origin"; human merge.

### PH2-24 — DECISIONS record of the Path B rulings
**Executor:** opus — `docs/DECISIONS.md` DENIED.
**Context:** `docs/DECISIONS.md` 2026-09-25 entry style (lines 5-14), requirements §8.8 (4004), `STATE.md` "Active workstreams" format, HUMAN-ACTIONS #119 (PH2-09).
**Exact change:** one entry "listener-requested Forays: host, spend, review gate, CSP" quoting the founder verbatim from #119's reply, one paragraph per ruling, plus the private-Foray reading of §1.3; §8.8 gets a "closed by" line; `STATE.md` entry for the `ph2/*` branch prefix and owned files.
**Commands:** `node --test test/human-actions-integrity.test.js`; `node tools/ci/run-suites.mjs --list`.
**Stop and escalate if:** the founder's words are relayed second-hand — verify against #119's reply.
**Definition of done:** DRAFT PR "docs(decisions): Path B rulings"; human merge.

### PH2-25 — Docs status updates
**Executor:** qwen.
**Context:** `docs/curation/generation-pipeline-status.md` (header; its "UPDATE 2026-09-05" strike-through pattern), requirements §8.8 (4004), `docs/curation/player-streaming-brief.md` §0 (9-11: "There is **no live HTTP service**"), `docs/curation/README.md`, `docs/ux/README.md` line 68 (`ShareSheet` row).
**Exact change:** after PH2-18 and PH2-21 merge: rewrite the "no HTTP server" paragraphs to name `backend/src/service/generationServer.ts`, its routes (read the merged code), the loopback default and `tools/generation/serve.mjs`; keep the original sentences struck through; `docs/ux/README.md` row → "built (PH2-03/04), share sheet only; 'Shared with you' still out"; README bullets for the runbook and the brief's §6.
**Commands:** `node tools/ci/run-suites.mjs --list`; `git diff --stat` shows only `docs/`.
**Do not touch:** `docs/DECISIONS.md`, `docs/adr/`.
**Stop and escalate if:** route names differ from the merged code (read the code, not this plan).
**Definition of done:** DRAFT PR "docs(curation): generation service and sharing status".

## 4. Sequencing

**Concurrency cap (founder, 2026-09-25: the box is bogged down by parallel agents): at most three agents running at once; each wave is a queue, not a burst.** Prefer finishing the `app.js` chain link that is next over starting another parallel task.

`app.js` is one file: every task that edits it runs **serially**, each rebased on the previous merge: **02 → 08 → 03 → 04 → 05 → 11 → 20 → 12 → 21 → 22** (05 edits only `styles.css` and the FLOORS/listener-copy tests but sits in the chain because of `FLOORS`). `HUMAN-ACTIONS.md` is serial too: 09 → 10 → 14. Each FLOORS insertion has its own anchor (02 after `episode-page`; 08 after `create-page`; 03 after 02's line; 11 after 03's; 20 after 11's; 21/22 after 20's; 19 after `relay.test.mjs`), so rebases are clean.

- **Wave 1 (three at a time, in this order):** PH2-02 (qwen), PH2-09 (qwen), PH2-01 (opus); then PH2-08 (qwen, after 02 merges), PH2-15 (opus), PH2-07 (opus); then PH2-13 (opus), PH2-10 (opus, after 09 merges).
- **Wave 2:** PH2-03 (after 01 + 02 + 08 merge) → PH2-04 → PH2-05; PH2-14 (after 10); PH2-19 (after 15).
- **Wave 3:** PH2-11 (after 05); PH2-16 (after 14 + 15); PH2-06 (after 05 merged, needs a shell build; opus, device time).
- **Wave 4:** PH2-20 (after 11); PH2-17 and PH2-18 (after 16, one at a time under the cap).
- **Wave 5:** PH2-12 (after 10 + 11 + 20).
- **Wave 6 (gated on HUMAN-ACTIONS #119 answered):** PH2-23 and PH2-24; then PH2-21 (after 08, 12, 18, 20, 23), then PH2-22, then PH2-25.

Ships early with no ruling: PH2-01..06 (share), PH2-07, PH2-08, PH2-09, PH2-10/11/14 (moderation plumbing), PH2-13, PH2-15/16/17/18/19 (dark service). Waits on rulings: PH2-12's production effect (#121 applied), PH2-21..25 (#119, #120).
