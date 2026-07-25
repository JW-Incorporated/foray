# ADR 0005: Identity & anonymous-first accounts

## Status
Accepted (2026-07-24). Foundational schema in
`backend/migrations/0013_app_users.sql`; Supabase-only auth/RLS in
`backend/migrations/supabase/`. Client + live API integration are follow-on work
(see "Consequences → what's next"). Supersedes the bare `user_id` placeholder
(`SEEDED_USER_ID` in `backend/src/cli/buildSession.ts`).

## Context
Foray's backend is already multi-tenant by construction — every table carries
`user_id` (hard constraint #7, `01_PROMPT.md`), and `taxonomy_nodes` /
`user_interests` / `events` / `saved_items` / `sessions` are all per-user. But
there is **no identity layer**: no `users`/accounts table, no auth, no live API.
`user_id` is a hardcoded seeded UUID, and the web client already mints a
client-side "profile id" and buffers events in `localStorage` "to sync to the
backend `events` table once it exists" (`DECISIONS.md` 2026-07-08/09).

The founders chose (2026-07-24): **anonymous-first, opt-in accounts**, with the
plumbing built so it scales seamlessly to native iOS/Android later
(`docs/curation/personalization-and-depth-plan.md` §4, Decision #1). Requirements:
1. A brand-new user gets a working, per-user identity with **zero friction** (no
   signup, no PII) — an anonymous account by default.
2. That anonymous identity can **later be upgraded** to a real account
   (email/OAuth) **without migrating any data** — the same id keeps all its
   interests/events/playlists.
3. The same identity model must work on **web today and native iOS/Android
   later** — no web-only assumptions.
4. Per-user data isolation must be enforced at the data layer, not just app code.

## Options considered
1. **Roll our own auth** (issue our own JWTs, a `users` table, password/OAuth
   handling, a Node API to mint anonymous ids). Full control, but we'd build and
   maintain auth, anonymous→permanent linking, token rotation, RLS-equivalent
   isolation, and native SDKs ourselves — months of undifferentiated work and a
   security surface we don't want to own.
2. **Firebase Auth.** Has anonymous auth + linking + native SDKs, but pushes us
   toward Firestore and a second data model; our data is already Postgres, and it
   splits identity (Firebase) from data (our Postgres) across two vendors.
3. **Supabase Auth (anonymous sign-in) on top of our existing Postgres.** ⭐
   Supabase *is* managed Postgres — our migrations already declare themselves
   "Supabase-compatible" (`0001_extensions.sql`) — plus first-class **anonymous
   sign-in**, **anonymous→permanent linking** (`updateUser`/`linkIdentity`, same
   `auth.uid()`, zero data migration), **Row-Level Security** keyed on
   `auth.uid()`, and official **Swift + Kotlin SDKs**. Our sister project
   (Swift2) already runs on Supabase, so the team knows it.

## Decision
Adopt **Supabase Auth with anonymous sign-in as Foray's identity layer.**

- **`user_id` becomes `auth.uid()`.** Every existing per-user table's `user_id`
  is the Supabase auth user id. No schema reshape needed — the columns already
  exist.
- **Anonymous by default.** On first run the client calls
  `supabase.auth.signInAnonymously()`; Supabase creates a real (anonymous)
  `auth.users` row and issues a session. This replaces the client-side "profile
  id" placeholder; the existing `localStorage` event buffer flushes to the
  `events` table under this id.
- **Opt-in upgrade, no migration.** When a user wants cross-device sync, they add
  an email or OAuth identity to the *same* anonymous user
  (`supabase.auth.updateUser({ email })` / `linkIdentity`). `auth.uid()` is
  unchanged, so every interest/event/playlist row is retained automatically. This
  is the entire payoff of anonymous-first over "guest data we later throw away."
- **Isolation via RLS.** Every user-scoped table gets `enable row level security`
  + a `auth.uid() = user_id` policy, so a client (web or native) using the
  public anon key can only ever read/write its own rows. The service role (used
  by the offline build/enrichment pipeline) bypasses RLS as today.
- **`app_users` profile table** (`0013`) holds app-level profile state that
  doesn't belong in Supabase's `auth.users` (persona seed, onboarding state,
  linked-provider flag, data-export/delete bookkeeping). Keyed 1:1 to the auth
  user id.
- **Portability preserved.** The portable schema (`0013`) stays in the main
  migration set (runs on bare local Postgres). The Supabase-specific pieces
  (RLS policies, the `auth.uid()` references, the anon-signup trigger) live in
  `backend/migrations/supabase/`, which the `migrate.ts` runner deliberately does
  **not** auto-apply (it globs only top-level `migrations/*.sql`) — they are
  applied to the Supabase project via its SQL editor / a separate deploy step.

## Consequences
**Good.**
- Zero-friction onboarding (anonymous account), no PII to start → stays "legally
  boring".
- The single hardest part of anonymous-first — *not losing data on upgrade* — is
  handled by Supabase's same-uid linking, for free.
- Native iOS/Android reuse the identical identity model via the Supabase Swift /
  Kotlin SDKs; no second identity system to build for the apps.
- RLS makes per-user isolation a data-layer guarantee, so a future public API is
  safe by default.

**Costs / what's next (follow-on, not in this ADR's scope).**
1. **Provision a Supabase project** (founder action — new project, matching the
   "one source of truth per project" preference; Swift2's is separate). Set
   `DATABASE_URL` (service role) for the pipeline and expose the project URL +
   anon key to the client. Then run `npm run migrate` (portable set) and apply
   `backend/migrations/supabase/*` in the project.
2. **Client integration** (web first): add `@supabase/supabase-js`, call
   `signInAnonymously()` on load, swap the placeholder profile id for
   `auth.uid()`, and point the existing `localStorage` event buffer at the
   `events` table. Respect the strict CSP (allowlist the Supabase project origin).
3. **Live per-user reads** eventually replace committed `data/*.json` for the
   personalized surfaces (the static JSON stays fine for the shared catalogue).
   This is the Step A/C work in the personalization plan.
4. The `SEEDED_USER_ID` placeholder is retired once the client provides a real
   `auth.uid()`.

**Risks.** RLS policies and the anon-signup trigger in
`backend/migrations/supabase/` are written to spec but **not yet verified against
a live project** — they must be reviewed and tested when the project is
provisioned before any real user data lands. Anonymous accounts can accumulate
(abandoned first-runs); Supabase's anonymous-user cleanup + our own retention job
should prune stale anonymous ids with no events.
