/* PKG-07 (docs/roadmap/corpus.md): the read-only Postgres row source, driven
   by a fake client (`{ query(text, params) }` recording every call). No test
   here opens a socket, connects to a database or reads a credential. Every
   pgRowSource below gets an explicit, invented connection string, so the
   default `process.env[PG_ENV]` is never evaluated. The fake client factory
   also means `pg` is never imported. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PG_STATEMENT_TIMEOUT_MS } from "./config.mjs";
import { SQL, pgRowSource } from "./pg-row-source.mjs";
import { RowSourceError, TABLES } from "./row-source.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "synthetic");
const FAKE_URL = "postgres://ro_user:s3cretpw@db.tailnet.example:5432/foraycorpus";

/** A fake pg client over in-memory tables, honouring the keyset SQL the
    module issues: `id > $1 ... LIMIT $2`, the tuple form
    `(a, b) > ($1, $2) ... LIMIT $3`, or a whole-table read. */
function fakeClient(tables = {}) {
  const calls = [];
  const client = {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      const table = Object.keys(SQL).find((t) => SQL[t] === text);
      if (!table) return { rows: [] };
      const all = tables[table] ?? [];
      if (/WHERE id > \$1/.test(text)) {
        const [after, limit] = params;
        return { rows: all.filter((r) => r.id > after).slice(0, limit) };
      }
      const tuple = text.match(/WHERE \((\w+), (\w+)\) > \(\$1, \$2\)/);
      if (tuple) {
        const [, a, b] = tuple;
        const [pa, pb, limit] = params;
        return { rows: all.filter((r) => r[a] > pa || (r[a] === pa && r[b] > pb)).slice(0, limit) };
      }
      return { rows: all };
    },
  };
  return client;
}

/* The transaction is opened read-only with the statement timeout before any
   data statement.
   Mutation that turns this red: in pg-row-source.mjs start() delete
   `await client.query("SET TRANSACTION READ ONLY");`. */
test("the first three statements are BEGIN, READ ONLY, statement_timeout", async () => {
  const client = fakeClient({ podcasts: [{ id: 1 }] });
  const source = pgRowSource({ connectionString: FAKE_URL, clientFactory: async () => client });
  const got = [];
  for await (const r of source.rows("podcasts")) got.push(r);
  assert.deepEqual(got, [{ id: 1 }]);
  assert.deepEqual(
    client.calls.slice(0, 3).map((c) => c.text),
    ["BEGIN", "SET TRANSACTION READ ONLY", `SET LOCAL statement_timeout = ${PG_STATEMENT_TIMEOUT_MS}`],
  );
  assert.equal(client.calls[3].text, SQL.podcasts);
  // A second table reuses the transaction: the trio is not issued again.
  for await (const _r of source.rows("assets"));
  assert.equal(client.calls.filter((c) => c.text === "BEGIN").length, 1);
});

/* Keyset pages until a short page, in order. episodes pages on id;
   episode_source_records pages on the (episode_id, feed_id) tuple, so two
   source records of one episode straddling a page boundary are neither lost
   nor repeated; feed_host_policies is one whole-table read.
   Mutation that turns this red: in pg-row-source.mjs rows() replace
   `if (rows.length < pageSize) return;` with `return;` (stop after the first
   page). */
test("rows() pages by keyset until a short page and yields every row in order", async () => {
  const episodes = [101, 102, 103, 104, 105].map((id) => ({ id, podcast_id: 1 }));
  const esr = [
    { episode_id: 101, feed_id: 11 },
    { episode_id: 101, feed_id: 12 },
    { episode_id: 102, feed_id: 11 },
    { episode_id: 102, feed_id: 12 },
    { episode_id: 103, feed_id: 11 },
  ];
  const hosts = [{ host: "a.example", state: "normal", reason: null }];
  const client = fakeClient({ episodes, episode_source_records: esr, feed_host_policies: hosts });
  const source = pgRowSource({ connectionString: FAKE_URL, clientFactory: async () => client, pageSize: 2 });

  const gotEpisodes = [];
  for await (const r of source.rows("episodes")) gotEpisodes.push(r.id);
  assert.deepEqual(gotEpisodes, [101, 102, 103, 104, 105]);
  const epCalls = client.calls.filter((c) => c.text === SQL.episodes);
  assert.match(SQL.episodes, /WHERE id > \$1 ORDER BY id LIMIT \$2$/);
  assert.deepEqual(
    epCalls.map((c) => c.params),
    [
      [0, 2],
      [102, 2],
      [104, 2],
    ],
  );

  const gotEsr = [];
  for await (const r of source.rows("episode_source_records")) gotEsr.push(`${r.episode_id}/${r.feed_id}`);
  assert.deepEqual(gotEsr, ["101/11", "101/12", "102/11", "102/12", "103/11"]);
  assert.deepEqual(
    client.calls.filter((c) => c.text === SQL.episode_source_records).map((c) => c.params),
    [
      [0, 0, 2],
      [101, 12, 2],
      [102, 12, 2],
    ],
  );

  const gotHosts = [];
  for await (const r of source.rows("feed_host_policies")) gotHosts.push(r);
  assert.deepEqual(gotHosts, hosts);
  assert.deepEqual(
    client.calls.filter((c) => c.text === SQL.feed_host_policies).map((c) => c.params),
    [undefined],
  );
});

/* Each table's SELECT list is exactly that table's PKG-02 column list, read
   from the keys of the first row of fixtures/synthetic/<table>.jsonl. The
   fixture README records which lists are ASSUMED. No `*` and no extra
   column, so a column the plan never confirmed cannot reach an export.
   Mutation that turns this red: in pg-row-source.mjs SQL.assets add `*` —
   `"id, owner_type, ..."` → `"*, id, owner_type, ..."`. */
test("every table's SQL selects only the PKG-02 columns", () => {
  assert.deepEqual(Object.keys(SQL).sort(), [...TABLES].sort());
  for (const table of TABLES) {
    const m = SQL[table].match(/^SELECT (.+?) FROM (\w+)(?: |$)/);
    assert.ok(m, `${table}: unparsable SQL ${SQL[table]}`);
    assert.equal(m[2], table);
    const firstLine = readFileSync(join(FIXTURE, `${table}.jsonl`), "utf8").split("\n")[0];
    const columns = m[1].split(",").map((s) => s.trim());
    assert.deepEqual(columns, Object.keys(JSON.parse(firstLine)), table);
  }
});

/* describe() names the source without the connection string's user,
   password or host. A connection error is rethrown as PG_CONNECT with the
   password stripped.
   Mutation that turns this red: in pg-row-source.mjs describe() return
   `pg:${connectionString}` (and, separately, drop `redactSecrets(...)` from
   the PG_CONNECT rethrow). */
test("describe() and connection errors never carry the password", async () => {
  const source = pgRowSource({ connectionString: FAKE_URL, clientFactory: async () => fakeClient() });
  const d = source.describe();
  assert.match(d, /^pg:/);
  for (const secret of ["s3cretpw", "ro_user", "db.tailnet.example", FAKE_URL]) assert.equal(d.includes(secret), false, secret);

  const failing = pgRowSource({
    connectionString: FAKE_URL,
    clientFactory: async () => ({
      async connect() {
        throw new Error(`connection to ${FAKE_URL} refused`);
      },
      async query() {
        throw new Error("unreachable");
      },
    }),
  });
  await assert.rejects(
    async () => {
      for await (const _r of failing.rows("podcasts"));
    },
    (e) => e instanceof RowSourceError && e.code === "PG_CONNECT" && !e.message.includes("s3cretpw") && e.message.includes(":***@"),
  );
});

/* An unknown table is refused before any statement is issued.
   Mutation that turns this red: in pg-row-source.mjs rows() delete the
   `if (!TABLES.includes(table)) throw ...` line (the generator then opens
   the transaction, issuing the trio, and fails on the missing KEYSET entry
   with a TypeError instead of UNKNOWN_TABLE). */
test('rows("nope") throws UNKNOWN_TABLE', async () => {
  const client = fakeClient();
  const source = pgRowSource({ connectionString: FAKE_URL, clientFactory: async () => client });
  await assert.rejects(
    async () => {
      for await (const _r of source.rows("nope"));
    },
    (e) => e instanceof RowSourceError && e.code === "UNKNOWN_TABLE",
  );
  assert.deepEqual(client.calls, []);
});
