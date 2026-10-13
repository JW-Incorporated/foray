/* Every table the portable migrations create has Row-Level Security on Supabase.
 *
 * WHY THIS EXISTS (PR #1045 review, PKG-02 / S-09)
 * The portable migrations (backend/migrations/*.sql) run on bare Postgres and
 * on Supabase alike, but RLS lives only in backend/migrations/supabase/ (it
 * needs Supabase's roles). So a new portable `create table` ships with no RLS
 * unless someone remembers the companion. On Supabase that means the public
 * anon key can write the table: audit finding backend-rest-4 found exactly that
 * for the 0016 catalogue, and 0017/0018 (shows_catalog, show_id_map) repeated
 * it until supabase/0004 was written. This suite makes the next one fail CI.
 *
 * It also pins the S-09 coupling text (docs/DECISIONS.md, STATE.md): the G1/G2
 * paragraph cited founder question 31 (Rights flags) for the "no DATABASE_URL
 * yet" ruling, which is question 6 (Postgres for shows), and did not say that
 * G2 includes supabase/0004.
 *
 * Static: no database. Applying supabase/ migrations to the live project is a
 * human step (gate G2; founder Q3 for 0003).
 *
 * Mutations that kill it (each run by hand on PR #1045):
 *   - delete the shows_catalog `enable row level security` line from 0004
 *     -> test 1 and test 2 fail;
 *   - add `create policy ... on public.show_id_map for select ...` to 0004
 *     -> test 2 fails (show_id_map must stay deny-all);
 *   - put "founder question 31" back in DECISIONS.md or STATE.md -> test 3 fails;
 *   - drop the supabase/0004 mention from either coupling paragraph -> test 3 fails.
 *
 * GV-59 (supabase/0007_generation_jobs.sql, D9) adds tests 4 and 5. Mutations
 * that kill them (each run by hand, 2026-10-13):
 *   - delete `alter table public.generation_jobs enable row level security;`
 *     from 0007 -> tests 4 and 5;
 *   - delete `revoke all on public.generation_job_authors from anon, authenticated;`
 *     -> test 4;
 *   - drop `on delete cascade` from generation_jobs.author_id -> test 5;
 *   - drop the `exists (select 1 from public.generation_job_authors ...)` clause
 *     from the insert policy -> test 5;
 *   - change the select policy to `using (true)` -> test 5;
 *   - drop `prompt = null,` from claim_generation_job -> test 5;
 *   - drop `skip locked` from the claim -> test 5;
 *   - drop `security definer` from the claim -> test 5;
 *   - add `create policy generation_jobs_peek on public.generation_jobs for select
 *     using (true);` (no `to` clause, so PUBLIC) -> test 5.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const MIG = path.join(ROOT, "backend/migrations");
const SUPA = path.join(MIG, "supabase");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const sqlOnly = (src) => src.replace(/--[^\n]*/g, "");
const sqlFiles = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith(".sql")).sort();

/** Tables created by the portable set (migrate.ts globs only top-level *.sql). */
function portableTables() {
  const out = new Set();
  for (const f of sqlFiles(MIG)) {
    const sql = sqlOnly(fs.readFileSync(path.join(MIG, f), "utf8"));
    for (const m of sql.matchAll(/create table (?:if not exists )?(?:public\.)?([a-z_][a-z0-9_]*)/gi)) {
      out.add(m[1].toLowerCase());
    }
  }
  return out;
}

const SUPA_SQL = sqlFiles(SUPA)
  .map((f) => sqlOnly(fs.readFileSync(path.join(SUPA, f), "utf8")))
  .join("\n");
const rlsOn = (t) => new RegExp(`alter table public\\.${t} enable row level security;`).test(SUPA_SQL);
const policiesOn = (t) => [...SUPA_SQL.matchAll(new RegExp(`create policy \\w+ on public\\.${t} for (\\w+) to ([\\w, ]+?) using`, "g"))];

test("every table a portable migration creates has RLS enabled by a supabase/ migration", () => {
  const tables = portableTables();
  assert.ok(tables.has("shows_catalog") && tables.has("show_id_map"), "the scan must see 0017/0018's tables");
  assert.ok(tables.size >= 15, `only ${tables.size} tables found; the create-table scan is broken`);
  const missing = [...tables].filter((t) => !rlsOn(t)).sort();
  assert.deepStrictEqual(missing, [], `no RLS on Supabase for: ${missing.join(", ")} (add a backend/migrations/supabase/ companion)`);
});

test("supabase/0004: shows_catalog is public read, never public write; show_id_map is deny-all", () => {
  const sql = sqlOnly(read("backend/migrations/supabase/0004_rls_shows_catalog.sql"));
  for (const t of ["shows_catalog", "show_id_map"]) {
    assert.match(sql, new RegExp(`alter table public\\.${t} enable row level security;`), `${t}: RLS must be enabled in 0004`);
    assert.match(sql, new RegExp(`revoke insert, update, delete, truncate on public\\.${t} from anon, authenticated;`), `${t}: no client write grants`);
  }
  const sc = policiesOn("shows_catalog");
  assert.deepStrictEqual(sc.map((m) => m[1]), ["select"], "shows_catalog: one select policy, nothing else");
  assert.deepStrictEqual(sc[0][2].split(/,\s*/).sort(), ["anon", "authenticated"]);
  assert.strictEqual(policiesOn("show_id_map").length, 0, "show_id_map: service-role only, no policy");
});

test("the S-09 G1/G2 coupling text cites question 6 (Postgres for shows) and names supabase/0004", () => {
  const roadmap = read("docs/roadmap/README.md");
  const q = (n) => (new RegExp(`^${n}\\. \\*\\*([^*]+)\\*\\*`, "m").exec(roadmap) || [])[1];
  assert.strictEqual(q(6), "Postgres for shows");
  assert.strictEqual(q(31), "Rights flags");
  for (const doc of ["docs/DECISIONS.md", "STATE.md"]) {
    const src = read(doc).replace(/\s+/g, " ");
    const at = src.indexOf("column legacy_show_id does not exist");
    assert.ok(at > 0, `${doc}: the S-09 coupling paragraph is missing`);
    const para = src.slice(Math.max(0, at - 900), at + 900);
    assert.match(para, /founder question 6 in `docs\/roadmap\/README\.md`/, `${doc}: the DATABASE_URL ruling is question 6`);
    assert.doesNotMatch(para, /founder question 31/, `${doc}: question 31 is Rights flags`);
    assert.match(para, /backend\/migrations\/supabase\/0004_rls_shows_catalog\.sql/, `${doc}: G2 must name the RLS companion`);
  }
});

/** `create table if not exists public.<t>` in one supabase/ file. */
const supaTablesIn = (sql) => [...sql.matchAll(/create table if not exists (?:public\.)?([a-z_][a-z0-9_]*)/g)].map((m) => m[1]);

test("every table a supabase/ migration creates has RLS on in that same file, and starts from no client grants", () => {
  /* 0005 and 0007 create tables of their own (Supabase-only, they reference
     auth.users). Neither the portable scan above nor any later file covers
     them, so the file that creates a table must switch RLS on for it and
     revoke Supabase's default anon/authenticated grants before granting back. */
  const created = [];
  for (const f of sqlFiles(SUPA)) {
    const sql = sqlOnly(fs.readFileSync(path.join(SUPA, f), "utf8"));
    for (const t of supaTablesIn(sql)) {
      created.push(t);
      assert.match(sql, new RegExp(`alter table public\.${t} enable row level security;`), `${f}: ${t} has no RLS in the file that creates it`);
      assert.match(sql, new RegExp(`revoke all on public\.${t} from anon, authenticated;`), `${f}: ${t} keeps Supabase's default client grants`);
    }
  }
  for (const t of ["content_reports", "generation_jobs", "generation_job_authors"]) assert.ok(created.includes(t), `the scan must see ${t}`);
});

test("supabase/0007: generation_jobs is author-only, founders-first, cascades with the account, and the claim discards the prompt (GV-59, D9)", () => {
  const sql = sqlOnly(read("backend/migrations/supabase/0007_generation_jobs.sql")).replace(/\s+/g, " ");
  // RLS on both tables.
  for (const t of ["generation_jobs", "generation_job_authors"]) assert.match(sql, new RegExp(`alter table public\.${t} enable row level security;`));
  // The owner column cascades with the account, on both tables.
  assert.match(sql, /create table if not exists public\.generation_jobs \( id uuid primary key default gen_random_uuid\(\), author_id uuid not null references auth\.users\(id\) on delete cascade,/);
  assert.match(sql, /create table if not exists public\.generation_job_authors \( author_id uuid primary key references auth\.users\(id\) on delete cascade,/);
  // An author selects its own rows, and only them.
  assert.match(sql, /create policy generation_jobs_select_own on public\.generation_jobs for select to authenticated using \(\(select auth\.uid\(\)\) = author_id\);/);
  // An author inserts only as itself, only a fresh queued on-demand job, and only when allowlisted.
  const insert = /create policy generation_jobs_insert_allowlisted on public\.generation_jobs for insert to authenticated with check \((.*?)\);/.exec(sql);
  assert.ok(insert, "the allowlist insert policy");
  for (const clause of ["(select auth.uid()) = author_id", "status = 'queued'", "lane = 'on-demand'", "seq = 0", "snapshot is null", "worker is null", "exists (select 1 from public.generation_job_authors a where a.author_id = (select auth.uid()))"]) {
    assert.ok(insert[1].includes(clause), `insert policy is missing: ${clause}`);
  }
  // No policy anywhere in 0007 is for anon, for PUBLIC (no `to` clause) or for
  // all (no `for`, or `for all`): every one names one verb and `to authenticated`.
  assert.doesNotMatch(sql, /create policy \w+ on public\.\w+ for \w+ to [\w, ]*\banon\b/);
  assert.doesNotMatch(sql, /create policy \w+ on public\.\w+ for all\b/);
  assert.strictEqual(
    (sql.match(/create policy \w+ on public\.\w+ for (?:select|insert|update|delete) to authenticated (?:using|with check) \(/g) || []).length,
    (sql.match(/create policy\b/g) || []).length,
    "every 0007 policy is `for <verb> to authenticated`"
  );
  // The claim: one statement that locks with SKIP LOCKED, NULLs the prompt and returns the one it held.
  const claim = /create or replace function public\.claim_generation_job\(p_worker text\) (.*?) \$\$(.*?)\$\$;/.exec(sql);
  assert.ok(claim, "claim_generation_job(p_worker text)");
  assert.match(claim[1], /\bsecurity definer\b/);
  assert.match(claim[1], /set search_path = public, pg_temp/);
  assert.match(claim[2], /where j\.status = 'queued'/);
  assert.match(claim[2], /for update skip locked/);
  assert.match(claim[2], /set status = 'claimed', prompt = null,/);
  assert.match(claim[2], /returning g\.id, g\.author_id, g\.tier, g\.lane, picked\.prompt/);
  assert.strictEqual((claim[2].match(/;/g) || []).length, 1, "the claim is ONE statement: the prompt is returned by the update that NULLs it");
  assert.match(claim[2], /^ with picked as \(.*\) update public\.generation_jobs g .*; $/, "one WITH ... UPDATE ... RETURNING");
  assert.match(sql, /revoke execute on function public\.claim_generation_job\(text\) from anon, authenticated, public;/);
  // And no other path keeps a prompt past 'queued'.
  assert.match(sql, /constraint generation_jobs_prompt_only_while_queued check \(prompt is null or status = 'queued'\)/);
  assert.match(sql, /if new\.status <> 'queued' then new\.prompt := null; end if;/);
});
