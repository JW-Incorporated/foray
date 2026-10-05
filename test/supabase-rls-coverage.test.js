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
