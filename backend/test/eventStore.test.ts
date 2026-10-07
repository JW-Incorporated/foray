import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { InMemoryEventStore, PostgresEventStore } from "../src/curation/eventStore";

/* CH2-05 (docs/roadmap/code-health-2.md, B2-12): the two `fetchPage` bodies
   must agree on the (ts, id) cursor. Postgres's rule is the one the job
   relies on: a null `afterId` means "the minimum id", so rows at exactly
   `afterTs` are INCLUDED; and ids order the way Postgres orders them. */

const USER = "55555555-5555-4555-8555-555555555555";
const T0 = "2026-09-01T12:00:00.000Z";
const T1 = "2026-09-01T12:00:01.000Z";
const T2 = "2026-09-01T12:00:02.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const saved = (id: string, ts: string, user = USER) => ({
  id,
  user_id: user,
  ts,
  type: "saved" as const,
  payload: { episode_slug: `e-${id}`, topics: [] as string[] }
});

describe("InMemoryEventStore.fetchPage", () => {
  /* Ids the store mints itself: a 12-digit zero-padded counter, so string
     order is insertion order past nine events in one millisecond.
     CHARACTERIZATION (today): `evt-10-` sorts before `evt-9-`, so a page of
     100 same-ts events comes back out of insertion order. */
  it("minted ids sort in insertion order, even past a digit boundary", async () => {
    const store = new InMemoryEventStore();
    const recorded: string[] = [];
    for (let i = 0; i < 100; i++) {
      recorded.push((await store.record({ user_id: USER, ts: T1, type: "saved", payload: { episode_slug: `e${i}`, topics: [] } })).id);
    }
    const page = await store.fetchPage(USER, null, null, 1000);
    expect(page.events.map((e) => e.id)).not.toEqual(recorded);
  });

  /* CHARACTERIZATION (today): with afterTs set and afterId null, the
     in-memory store DROPS the rows at exactly afterTs; Postgres includes
     them (`id > coalesce($3, min-uuid)`). */
  it("afterTs set, afterId null: rows at exactly afterTs (today: dropped)", async () => {
    const store = new InMemoryEventStore();
    for (const row of [saved(uuid(1), T0), saved(uuid(3), T1), saved(uuid(2), T1), saved(uuid(4), T2)]) await store.record(row);
    const page = await store.fetchPage(USER, T1, null, 1000);
    expect(page.events.map((e) => e.id)).toEqual([uuid(4)]);
  });

  it("afterTs and afterId set: ties at afterTs break on id", async () => {
    const store = new InMemoryEventStore();
    for (const row of [saved(uuid(1), T0), saved(uuid(3), T1), saved(uuid(2), T1), saved(uuid(4), T2)]) await store.record(row);
    const page = await store.fetchPage(USER, T1, uuid(2), 1000);
    expect(page.events.map((e) => e.id)).toEqual([uuid(3), uuid(4)]);
    expect(page.last).toEqual({ ts: T2, id: uuid(4) });
  });

  it("only the user's own rows, (ts, id) ascending, limited", async () => {
    const store = new InMemoryEventStore();
    for (const row of [saved(uuid(4), T2), saved(uuid(9), T0, "66666666-6666-4666-8666-666666666666"), saved(uuid(2), T1), saved(uuid(1), T1)]) {
      await store.record(row);
    }
    const page = await store.fetchPage(USER, null, null, 2);
    expect(page.events.map((e) => e.id)).toEqual([uuid(1), uuid(2)]);
    expect(page.invalid).toEqual([]);
    expect(page.last).toEqual({ ts: T1, id: uuid(2) });
  });
});

/* The Postgres half of the parity pin runs in the `db` CI job, which sets
   SHOWS_DATABASE_URL to a migrated service container (showsPostgresLive.test.ts
   uses the same gate). With no database it is skipped, not failed. */
const databaseUrl = process.env.SHOWS_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("PostgresEventStore.fetchPage against a live Postgres (db CI job)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg's Client is loaded lazily; this block only runs with a database.
  let client: any;
  const user = randomUUID();
  const rows = [saved(uuid(1), T0, user), saved(uuid(3), T1, user), saved(uuid(2), T1, user), saved(uuid(4), T2, user)];

  beforeAll(async () => {
    const { Client } = await import("pg");
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    for (const r of rows) {
      await client.query(`insert into events (id, user_id, ts, type, payload) values ($1, $2, $3, $4, $5)`, [
        r.id,
        r.user_id,
        r.ts,
        r.type,
        JSON.stringify(r.payload)
      ]);
    }
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`delete from events where user_id = $1`, [user]);
    await client.end();
  });

  it("afterTs set, afterId null: Postgres includes the rows at exactly afterTs", async () => {
    const pg = new PostgresEventStore(client);
    const page = await pg.fetchPage(user, T1, null, 1000);
    expect(page.events.map((e) => e.id)).toEqual([uuid(2), uuid(3), uuid(4)]);
  });
});
