# Security review, 2026-10

A defensive review of the team's own code, done so it can be fixed. It reads the code as of `main` at
`9fffb085` (2026-10-09).

**Scope:**
- `api/**`
- `backend/src/**` and `backend/migrations/**`
- `.github/workflows/**` and `.github/actions/**`
- `tools/ci/path-policy.mjs`
- `player/incoming-link.js`, `player/id3-chapters.js` and the share-link builders

`app.js`, `styles.css` and `index.html` were read for context only. They are frozen for the UI revamp, so
anything found there is reported here and not changed. Foray generation is out of scope.

**Method:**
1. Each candidate issue was written down with its `file:line`, a concrete scenario and a severity.
2. A skeptic pass then tried to refute each one.
3. Only findings that survived the skeptic pass appear in the table.

Issues the round-3 audit already found and fixed (`docs/audit/round-3-code/`, lane L7) were checked
again but are not counted again. Two examples are `security-1` (fork PRs auto-merging) and `ci-release-2`
(renames dodging the policy).

## Verified findings

| ID | Severity | Where | Finding | Status |
|---|---|---|---|---|
| SEC-01 | **Medium** | `api/shows/[show_id]/episodes.ts:177`, `api/_lib/feedCache.ts:82`, `backend/src/feeds/conditionalGet.ts:120` | **SSRF through feed URLs.** A `pi:` show's feed URL comes from a PodcastIndex row, and anyone can submit a feed to PodcastIndex. Before the fix, the only check was `^https?://`, and `fetch` followed up to 20 redirects to any host. A submitted feed could name, or redirect to, `127.0.0.1` (the Lambda runtime API on Vercel's hosts), `169.254.169.254` or a private name. The function would then send that request from inside the deployment. The attacker cannot read the response (a non-feed body fails to parse), but the request should never be made. | **Fixed in PR #1212**: every hop is checked (scheme, host name, IP range, DNS answers) and redirects are followed by hand, capped at 8. Still open: DNS rebinding (see D-1) and the dormant DB branch (`ingestShowFeed`, `backend/src`, used only when `DATABASE_URL` is set). |
| SEC-02 | Low | `api/shows/[show_id]/episodes.ts:166`, `api/shows/index/[...path].ts:127`, `api/_lib/showsIndexRelease.ts:388` | **Unmetered shard reads.** Each `pi:` lookup that misses re-downloads, gunzips and parses a whole shard (caps: 16 MB fetched, 64 MB inflated). Only resolved rows are cached, there is no negative cache and no per-client budget. The shard proxy also fetches upstream on every request. One client looping over made-up `pi:<n>?k=<key>` requests makes the function do a full shard read each time. This costs money and function time; it does not expose data. | Reported. Suggested fix: keep each fetched shard per warm instance for a few minutes (bounded, as `feedCache` does), and meter `pi:` misses per `clientKey`. Low, so no PR this round. |
| SEC-03 | Low | `tools/ci/path-policy.mjs:386` (`"tools/"` in ALLOWED) vs `vercel.json:3-5` | **Deploy-defining scripts can auto-merge.** `tools/web/prepare-dist.mjs` is Vercel's `buildCommand` and `tools/web/vercel-should-build.mjs` is its `ignoreCommand`. Both sit under the allowlisted `tools/`, so an agent PR can change them and merge unread. `vercel.json`, which names them, is not allowlisted. Most of the risk is the same as `app.js`, which is allowlisted on purpose. The new part is that these scripts run inside Vercel's build, which has the project's build-time environment variables. | Founder decision (F-3). Adding them to `DENIED_PREFIXES` tightens the policy but means every change to them needs a founder label. |
| SEC-04 | Low | `tools/ci/path-policy.mjs:61-270` | **RLS definitions are not governed.** `backend/migrations/` (including `supabase/*.sql`, the RLS and grants), `api/` and `vercel.json` are neither allowed nor denied. So the bots never auto-merge them, but the `path-policy` check passes them as CLEAN, and under the 2026-09-21 ruling an agent can merge them once checks are green. A migration that loosens a policy needs no founder look. `backend/src/` is denied with a defence-in-depth argument that applies equally to the RLS files. | Founder decision (F-3). |
| SEC-05 | Low (settings) | Pages settings of `JW-Incorporated/jwlabs.dev` (custom domain `jwlabs.ai`) | **HTTPS not enforced on jwlabs.ai.** `https_enforced: false`, checked through the API on 2026-10-09. `https://jwlabs.ai` is in the API's CORS allowlist (`api/_lib/cors.ts:39`) and is named as a web origin of the app. A visitor who reaches `http://jwlabs.ai` gets a page that anyone on the network path can change. | Settings item S-1. |
| SEC-06 | Low (settings) | `protect-main` ruleset | **Two checks are not required.** Required checks are `backend`, `data-and-site`, `engine-parity` and `ios-gate`, checked through the API on 2026-10-09. `path-policy` is not required (HUMAN-ACTIONS #1, still open), so a governed-path PR without `founder-approved` goes red but can still be merged. The `api` job (`ci.yml:138`, which runs `api/`'s suites and typecheck) is not required either, so a PR that turns `api/` red can merge. | Settings item S-2. |
| SEC-07 | Low (accepted risk, restated) | `.github/workflows/android-release.yml:149-165,295-297` | **Release secrets reach PR-branch code.** A same-repo PR that touches the release pipeline paths runs the PR's own code with the Android upload-key secrets. Fork PRs get no secrets, so only someone with write access can do this. This is round 3's `ci-release-3` (the signing secrets are scoped to the repo), and ADR-0009 accepted it. It is listed again because the composite-action move in CH2-17 widened the path list. | Settings item S-3 (move the secrets into a protected Environment). |

### Refuted or clean (skeptic pass)

- **Script injection in workflows.** No `run:` step puts a PR title, branch name, issue body, comment or
  commit message into a `${{ }}` expression.
  - The one input interpolated into `run:` is `release.yml:195` `inputs.bump`. It is a `choice` input
    that only someone with write access can dispatch.
  - `ci.yml:327` interpolates `head.sha`, which is hex.
  - Values from outside reach scripts through `env:`.
- **`pull_request_target` / `workflow_run`.** Neither is used.
- **Write-token workflows.** The ones triggered by `pull_request` (`automerge-nightly`, `pr-hygiene`,
  `path-policy`) check out the default branch with `persist-credentials: false`. A fork PR gets a
  read-only token.
- **`tools/ci/approve-parked-runs.mjs`.** It approves only `pull_request` runs whose `head_sha` is the
  commit the workflow itself just pushed. A fork that reuses that SHA runs identical code.
- **Path policy gaps.**
  - Renames are covered (`previous_filename` is fed to the policy in all three callers).
  - Truncated file lists are covered.
  - Case-folding is covered on the deny side.
  - `..`, backslash and NUL are covered.
  - The `test/suite-integrity.test.js` floor file is allowlisted on purpose, and its own header says so.
- **Shard-index proxy.** No path traversal or open relay: the path is matched exactly against an
  allowlist (`showsIndexRelease.ts:185,192`), the upstream base comes from the committed pointer, and
  reads and gunzip are capped.
- **CORS.**
  - `applyCors` echoes the origin only from an exact allowlist, sets `Vary: Origin`, and never allows
    credentials.
  - No API response sets `s-maxage`, so the CDN does not cache across origins.
  - There is no redirect endpoint, so there is no open redirect.
- **Client IP spoofing.** `clientKey` trusts the first `X-Forwarded-For` hop, but Vercel overwrites that
  header at its edge.
- **Supabase RLS.**
  - Every table created in `backend/migrations/0002-0018` has RLS on, through
    `supabase/0001`, `0002`, `0003`, `0004` and `0005`.
  - Client writes are scoped with `(select auth.uid()) = user_id`.
  - Catalogue tables are read-only to `anon` and `authenticated`.
  - The SECURITY DEFINER functions pin `search_path` and revoke `execute` from client roles.
  - `content_reports` grants insert column by column.
  - No `service_role` key appears anywhere in the client or the API.
- **String-built SQL.** None in `backend/src`. Queries are parameterised, and the one interpolation
  (`eventStore.ts:199`, `TS_TEXT_SQL`) is a constant.
- **`player/incoming-link.js`.**
  - Exact `https` + host match, with no port, no user info and path `/` only.
  - The route must match `^#\/\S*$` and be at most 2048 characters.
  - `?foray=` is URL-encoded.
  - The WHATWG URL parser percent-encodes `"<>` and backtick in the fragment.
- **`player/id3-chapters.js`.**
  - Every frame size is bounds-checked before slicing.
  - The tag read is capped at 1 MB.
  - The CTOC walk is guarded against cycles and depth.
  - Chapter `url`/`img` must be `https:`.
  - Any parse error returns `[]`.
- **Share links (`app.js:5925`).** Ids and keys go through `encodeURIComponent`, inside fixed origins.

## Deferred and settings recommendations

**Engineering, deferred:**
- **D-1.** Pin the feed connect to the address the guard checked. That means an undici `Agent` with a
  `connect.lookup` that refuses non-public addresses, which closes DNS rebinding for SEC-01. It needs
  `undici` as an `api/` dependency.
- **D-2.** SEC-02: a per-instance shard cache plus per-client metering of `pi:` misses.
- **D-3.** Put the same guard on `backend/src/catalog/ingestShowFeed.ts` before `DATABASE_URL` is ever
  set in production. `backend/src/` is governed, so this needs a founder label.

**Settings (founder only; agents do not touch GitHub or Vercel settings):**
- **S-1.** In `jwlabs.dev` → Settings → Pages, turn on **Enforce HTTPS** for `jwlabs.ai` (SEC-05).
- **S-2.** Add `path-policy` (HUMAN-ACTIONS #1) and `api` to the required checks on `protect-main`
  (SEC-06).
- **S-3.** Move the signing secrets (ANDROID_*, IOS_*, APP_STORE_CONNECT_*, PLAY_SERVICE_ACCOUNT_JSON) from
  repository secrets into a `release` Environment limited to `main` and `v*` tags. Then add that
  environment to the jobs that use them, which is a governed `.github/` change. The PR runs of
  `android-release.yml` would then need a reviewer or would run unsigned (SEC-07, round-3
  `ci-release-3`).

**Founder decision:**
- **F-3.** Whether to add `tools/web/prepare-dist.mjs`, `tools/web/vercel-should-build.mjs`, `vercel.json`
  and `backend/migrations/` to `DENIED_PREFIXES` (SEC-03, SEC-04). This tightens the policy, but every
  change to those paths would then need the `founder-approved` label.

## Fix PRs

- #1212: SEC-01, `fix(api): feed fetches reach only public addresses, on every redirect`. New suite
  `api/_test/feed-guard.test.mjs`; six named mutations were run and all were killed. `api/` is not
  floored in `test/suite-integrity.test.js` (it is unlisted, so always a human merge), so no floor
  changes.
