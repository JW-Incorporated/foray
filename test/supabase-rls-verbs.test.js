/* The Supabase RLS policies, pinned against the verbs the client really uses.
 *
 * WHY THIS EXISTS (round-3 code audit, lane L6: backend-rest-4, backend-rest-5,
 * data-integrity-10)
 * supabase/0003_rls_least_privilege.sql narrows every per-user table from a
 * `for all` policy to exactly the verbs the shipped client needs. That is the
 * right rule and a dangerous edit: "Delete my data" issues one DELETE per table,
 * and a DELETE that RLS filters down to zero rows still answers 204. A verb
 * missed in the migration is therefore a deletion that reports success and
 * deletes nothing, and no other suite would notice.
 *
 * So the client's verbs are DERIVED from app.js (every `/rest/v1/` call site),
 * the policies are PARSED from the migration, and the two are compared both
 * ways: every verb the client uses is granted, and nothing the client does not
 * use is granted to it.
 *
 * Static: no database. Applying 0003 to the live project is founder Q3.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const MIGRATION = "backend/migrations/supabase/0003_rls_least_privilege.sql";

/** Comments stripped: app.js discusses these endpoints at length in prose. */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:/])\/\/[^\n]*/g, "$1");
}
const sqlOnly = (src) => src.replace(/--[^\n]*/g, "");

const APP = codeOnly(read("app.js"));
const SQL = sqlOnly(read(MIGRATION));

const PER_USER_TABLES = [...APP.matchAll(/const SB_USER_TABLES = \[([\s\S]*?)\];/g)]
  .flatMap((m) => [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]));

const VERB_OF_METHOD = { GET: "select", POST: "insert", PATCH: "update", PUT: "update", DELETE: "delete" };

/**
 * table -> Set(verb) the client uses, read from every `/rest/v1/` call in
 * app.js. A literal table (`"/rest/v1/events"`) takes the method named in the
 * same fetch; the `${table}` template is sbDeleteOwnRows, which runs over
 * SB_USER_TABLES. Any other shape fails loudly so a new call site has to be
 * taught to this suite (and to the migration).
 */
function clientVerbs() {
  const out = new Map();
  const add = (t, v) => {
    if (!out.has(t)) out.set(t, new Set());
    out.get(t).add(v);
  };
  const sites = [...APP.matchAll(/\/rest\/v1\/(\$\{table\}|[a-z_]+)/g)];
  assert.ok(sites.length >= 2, "no /rest/v1/ call sites found in app.js");
  for (const m of sites) {
    const after = APP.slice(m.index, m.index + 400);
    const method = /method:\s*"([A-Z]+)"/.exec(after);
    assert.ok(method, `a /rest/v1/ call with no explicit method: ${after.slice(0, 80)}`);
    const verb = VERB_OF_METHOD[method[1]];
    assert.ok(verb, `unknown method ${method[1]}`);
    if (m[1] === "${table}") {
      assert.strictEqual(verb, "delete", "the only templated table call is sbDeleteOwnRows");
      for (const t of PER_USER_TABLES) add(t, "delete");
    } else {
      add(m[1], verb);
    }
  }
  return out;
}

/** table -> [{name, verb, roles}] from the migration's `create policy` lines. */
function policies() {
  const out = new Map();
  for (const m of SQL.matchAll(/create policy (\w+) on public\.(\w+) for (\w+) to ([\w, ]+?) (?:using|with check)/g)) {
    const [, name, table, verb, roles] = m;
    if (!out.has(table)) out.set(table, []);
    out.get(table).push({ name, verb, roles: roles.split(/,\s*/) });
  }
  return out;
}

const rlsEnabled = (t) => new RegExp(`alter table public\\.${t} enable row level security;`).test(SQL);

test("the client's verbs are what this suite thinks they are", () => {
  const verbs = clientVerbs();
  assert.deepStrictEqual([...verbs.get("events")].sort(), ["delete", "insert"]);
  assert.ok(PER_USER_TABLES.includes("learning_cursor"), "data-integrity-10: Delete my data must reach learning_cursor");
  for (const t of PER_USER_TABLES) assert.ok(verbs.get(t).has("delete"), `${t}: Delete my data deletes it`);
});

test("every verb the client uses on a table is granted by a policy (Delete my data cannot silently 204)", () => {
  const pol = policies();
  for (const [table, verbs] of clientVerbs()) {
    assert.ok(rlsEnabled(table), `${table}: RLS must be enabled`);
    const granted = new Set((pol.get(table) || []).map((p) => p.verb));
    for (const v of verbs) {
      assert.ok(granted.has(v), `${table}: the client uses ${v} but no policy grants it`);
      // A filtered DELETE reads the rows it matches, so SELECT policies apply to it too.
      if (v === "delete") assert.ok(granted.has("select"), `${table}: a filtered DELETE also needs a SELECT policy`);
    }
  }
});

test("nothing the client does not use is granted: no `for all`, no UPDATE, INSERT only where the client inserts (backend-rest-5)", () => {
  const pol = policies();
  const verbs = clientVerbs();
  for (const t of PER_USER_TABLES) {
    const mine = pol.get(t) || [];
    assert.ok(mine.length > 0, `${t}: no policies`);
    for (const p of mine) {
      assert.deepStrictEqual(p.roles, ["authenticated"], `${p.name}: per-user rows are for the signed-in owner only`);
      assert.notStrictEqual(p.verb, "all", `${p.name}: 'for all' is what this migration removes`);
      assert.notStrictEqual(p.verb, "update", `${p.name}: no client updates a per-user row`);
      if (p.verb === "insert") assert.ok(verbs.get(t).has("insert"), `${p.name}: the client never inserts into ${t}`);
    }
    assert.match(SQL, new RegExp(`drop policy if exists own_rows_${t} on public\\.${t};`), `${t}: the old for-all policy must be dropped`);
    assert.match(SQL, new RegExp(`revoke update, truncate on public\\.${t} from anon, authenticated;`));
  }
  const ui = (pol.get("user_interests") || []).map((p) => p.verb).sort();
  assert.deepStrictEqual(ui, ["delete", "select"], "user_interests is an append-only audit log the job alone writes");
  const tn = (pol.get("taxonomy_nodes") || []).map((p) => p.verb).sort();
  assert.deepStrictEqual(tn, ["delete", "select"], "no client weight writes to taxonomy_nodes");
});

test("the shared catalogue is public read, never public write (backend-rest-4)", () => {
  const pol = policies();
  for (const t of ["catalog_show_episodes", "catalog_show_feed_state"]) {
    assert.ok(rlsEnabled(t), `${t}: RLS must be enabled`);
    const mine = pol.get(t) || [];
    assert.deepStrictEqual(mine.map((p) => p.verb), ["select"], `${t}: select only`);
    assert.match(SQL, new RegExp(`revoke insert, update, delete, truncate on public\\.${t} from anon, authenticated;`));
  }
});

test("pipeline tables are deny-all: RLS on, no policy, no client write grants", () => {
  const pol = policies();
  for (const t of ["shows", "episodes", "episode_enrichment", "cost_events"]) {
    assert.ok(rlsEnabled(t), `${t}: RLS must be enabled`);
    assert.strictEqual((pol.get(t) || []).length, 0, `${t}: service-role only`);
    assert.match(SQL, new RegExp(`revoke insert, update, delete, truncate on public\\.${t} from anon, authenticated;`));
  }
});

test("events.ts is stamped by the server on insert, so a client clock cannot freeze the learning cursor (backend-rest-5)", () => {
  assert.match(SQL, /new\.ts := clock_timestamp\(\);/);
  assert.match(SQL, /create trigger events_force_server_ts\s+before insert on public\.events\s+for each row execute function public\.events_force_server_ts\(\);/);
});

test("the migration is additive: 0003 exists alongside the applied 0001/0002, which are untouched by it", () => {
  const names = fs.readdirSync(path.join(ROOT, "backend/migrations/supabase")).filter((n) => n.endsWith(".sql")).sort();
  assert.deepStrictEqual(names.slice(0, 3), ["0001_auth_and_rls.sql", "0002_linter_findings.sql", "0003_rls_least_privilege.sql"]);
});
