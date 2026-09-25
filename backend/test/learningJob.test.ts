import { describe, it, expect, beforeEach } from "vitest";
import type { Client } from "pg";
import { runLearningJobForUser, runLearningJobForUsers } from "../src/curation/learningJob";
import { InMemoryEventStore, PostgresEventStore } from "../src/curation/eventStore";
import { InMemoryLearningCursorStore, PostgresLearningCursorStore } from "../src/curation/learningCursor";
import { InMemoryTaxonomyRepository, InMemoryInterestAuditRepository } from "../src/curation/learningRepository";
import type { ApplyDeps } from "../src/curation/interestLearning";

const USER = "22222222-2222-2222-2222-222222222222";
const FUSION = "engineering/energy-fusion";

describe("runLearningJobForUser — end to end over in-memory stores", () => {
  let eventStore: InMemoryEventStore;
  let cursorStore: InMemoryLearningCursorStore;
  let taxonomyRepo: InMemoryTaxonomyRepository;
  let auditRepo: InMemoryInterestAuditRepository;
  let applyDeps: ApplyDeps;

  beforeEach(() => {
    eventStore = new InMemoryEventStore();
    cursorStore = new InMemoryLearningCursorStore();
    taxonomyRepo = new InMemoryTaxonomyRepository();
    auditRepo = new InMemoryInterestAuditRepository();
    applyDeps = { taxonomyRepo, auditRepo, knownNodes: new Map([[FUSION, { label: "Fusion" }]]) };
  });

  it("processes a user's events, writes durable weight updates, and advances the cursor", async () => {
    await eventStore.record({
      user_id: USER,
      type: "finished",
      payload: { episode_slug: "e1", topics: [FUSION], percent_complete: 0.95, source: "observed" }
    });
    await eventStore.record({
      user_id: USER,
      type: "saved",
      payload: { episode_slug: "e2", topics: [FUSION] }
    });

    const result = await runLearningJobForUser(USER, { eventStore, cursorStore, applyDeps });

    expect(result.eventsProcessed).toBe(2);
    expect(result.cursorAdvancedTo).not.toBeNull();

    const node = await taxonomyRepo.getNode(USER, FUSION);
    expect(node?.weight).toBeGreaterThan(0);
    expect(auditRepo.all()).toHaveLength(2);

    const cursor = await cursorStore.get(USER);
    expect(cursor).toBeDefined();
  });

  it("is idempotent: a second run with no new events processes nothing and leaves state unchanged", async () => {
    await eventStore.record({
      user_id: USER,
      type: "finished",
      payload: { episode_slug: "e1", topics: [FUSION], percent_complete: 0.95, source: "observed" }
    });

    const first = await runLearningJobForUser(USER, { eventStore, cursorStore, applyDeps });
    expect(first.eventsProcessed).toBe(1);
    const weightAfterFirst = (await taxonomyRepo.getNode(USER, FUSION))?.weight;

    const second = await runLearningJobForUser(USER, { eventStore, cursorStore, applyDeps });
    expect(second.eventsProcessed).toBe(0);
    expect(second.cursorAdvancedTo).toBeNull();
    expect((await taxonomyRepo.getNode(USER, FUSION))?.weight).toBe(weightAfterFirst);
    expect(auditRepo.all()).toHaveLength(1); // no duplicate audit row from the second run
  });

  it("only processes events strictly after the cursor on a subsequent run", async () => {
    await eventStore.record({
      user_id: USER,
      type: "saved",
      payload: { episode_slug: "e1", topics: [FUSION] }
    });
    await runLearningJobForUser(USER, { eventStore, cursorStore, applyDeps });

    await eventStore.record({
      user_id: USER,
      type: "saved",
      payload: { episode_slug: "e2", topics: [FUSION] }
    });
    const second = await runLearningJobForUser(USER, { eventStore, cursorStore, applyDeps });

    expect(second.eventsProcessed).toBe(1);
    expect(auditRepo.all()).toHaveLength(2);
  });

  it("returns an empty result for a user with no events at all", async () => {
    const result = await runLearningJobForUser("no-such-user-yet", { eventStore, cursorStore, applyDeps });
    expect(result.eventsProcessed).toBe(0);
    expect(result.outcomes).toHaveLength(0);
  });
});

/* Round-3 audit, lane L6: backend-rest-2 (the cursor keeps Postgres's
   microseconds) and backend-rest-3 (a malformed row is skipped once, one
   user's failure neither double-applies nor stops the others).

   FakePg models the two things that matter about real Postgres + node-pg:
   timestamptz compares at MICROSECOND precision, and a timestamptz column
   comes back as a JS Date (milliseconds). A query that asks for the
   `to_char(...)` text alias gets the full value; one that does not gets the
   truncated Date, exactly as pg would hand it over. */
// eslint-disable-next-line security/detect-unsafe-regex -- anchored, bounded, test-only.
const MICRO_RE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?Z$/;
function toMicros(v: unknown): bigint {
  const s = v instanceof Date ? v.toISOString() : String(v);
  const m = MICRO_RE.exec(s);
  if (!m) throw new Error(`FakePg: unparseable timestamp ${s}`);
  return BigInt(Date.parse(`${m[1]}Z`)) * 1000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}
function microsText(us: bigint): string {
  const ms = Number(us / 1000n);
  return `${new Date(ms).toISOString().slice(0, 19)}.${(us % 1_000_000n).toString().padStart(6, "0")}Z`;
}

interface FakeRow {
  id: string;
  user_id: string;
  ts: bigint;
  type: string;
  payload: unknown;
  archetype?: string | null;
}

class FakePg {
  events: FakeRow[] = [];
  cursors = new Map<string, { ts: bigint; id: string }>();
  log: string[] = [];

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    const verb = sql.trim().split(/\s+/)[0]!.toLowerCase();
    this.log.push(verb);
    if (/from events/.test(sql)) {
      const [userId, afterTs, afterId, limit] = params as [string, string | null, string | null, number];
      const after = afterTs === null ? null : toMicros(afterTs);
      const rows = this.events
        .filter((e) => e.user_id === userId)
        .filter((e) => after === null || e.ts > after || (e.ts === after && e.id > (afterId ?? "")))
        .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1))
        .slice(0, limit);
      return {
        rows: rows.map((e) => ({
          id: e.id,
          user_id: e.user_id,
          ...(/as ts_text/.test(sql) ? { ts_text: microsText(e.ts) } : { ts: new Date(Number(e.ts / 1000n)) }),
          type: e.type,
          session_id: null,
          episode_id: null,
          archetype: e.archetype ?? null,
          payload: e.payload
        }))
      };
    }
    if (/insert into learning_cursor/.test(sql)) {
      const [userId, ts, id] = params as [string, string, string];
      this.cursors.set(userId, { ts: toMicros(ts), id });
      return { rows: [] };
    }
    if (/from learning_cursor/.test(sql)) {
      const c = this.cursors.get(params[0] as string);
      if (!c) return { rows: [] };
      return {
        rows: [
          /as last_event_ts_text/.test(sql)
            ? { last_event_ts_text: microsText(c.ts), last_event_id: c.id }
            : { last_event_ts: new Date(Number(c.ts / 1000n)), last_event_id: c.id }
        ]
      };
    }
    return { rows: [] };
  }
}

describe("learning job over Postgres-shaped stores (round 3)", () => {
  const U1 = "33333333-3333-4333-8333-333333333333";
  const U2 = "44444444-4444-4444-8444-444444444444";
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const saved = (n: number, user: string, tsText: string): FakeRow => ({
    id: id(n),
    user_id: user,
    ts: toMicros(tsText),
    type: "saved",
    payload: { episode_slug: `e${n}`, topics: [FUSION] }
  });
  let pg: FakePg;
  let deps: Parameters<typeof runLearningJobForUser>[1];
  let auditRepo: InMemoryInterestAuditRepository;
  beforeEach(() => {
    pg = new FakePg();
    auditRepo = new InMemoryInterestAuditRepository();
    deps = {
      eventStore: new PostgresEventStore(pg as unknown as Client),
      cursorStore: new PostgresLearningCursorStore(pg as unknown as Client),
      applyDeps: { taxonomyRepo: new InMemoryTaxonomyRepository(), auditRepo, knownNodes: new Map([[FUSION, { label: "Fusion" }]]) }
    };
  });

  it("the cursor round-trips microseconds, so the last event is not re-applied on the next run (backend-rest-2)", async () => {
    pg.events.push(saved(1, U1, "2026-09-01T12:00:00.123456Z"), saved(2, U1, "2026-09-01T12:00:00.123789Z"));
    const first = await runLearningJobForUser(U1, deps);
    expect(first.eventsProcessed).toBe(2);
    expect(first.cursorAdvancedTo!.ts).toBe("2026-09-01T12:00:00.123789Z");
    const second = await runLearningJobForUser(U1, deps);
    expect(second.eventsProcessed).toBe(0);
    expect(auditRepo.all()).toHaveLength(2);
  });

  it("a malformed row is skipped with a reason, and the cursor moves past it (backend-rest-3)", async () => {
    pg.events.push(
      saved(1, U1, "2026-09-01T12:00:00.100000Z"),
      { id: id(2), user_id: U1, ts: toMicros("2026-09-01T12:00:00.200000Z"), type: "finished", payload: { episode_slug: "e2", percent_complete: 1, topics: "nope" } },
      { id: id(3), user_id: U1, ts: toMicros("2026-09-01T12:00:00.300000Z"), type: "picked", payload: { episode_slug: "e3" }, archetype: "stretch" },
      { id: id(4), user_id: U1, ts: toMicros("2026-09-01T12:00:00.400000Z"), type: "picked", payload: { episode_slug: "e4" } }
    );
    const first = await runLearningJobForUser(U1, deps);
    // The saved row, and the pick whose slot rode the row's archetype column
    // (topics default to []). The pick with no slot anywhere breaks the contract.
    expect(first.eventsProcessed).toBe(2);
    expect(first.invalidEvents.map((e) => e.id)).toEqual([id(2), id(4)]);
    expect(first.invalidEvents[0]!.reason).toMatch(/topics/);
    expect(first.cursorAdvancedTo!.id).toBe(id(4));
    const second = await runLearningJobForUser(U1, deps);
    expect(second.eventsProcessed).toBe(0);
    expect(second.invalidEvents).toEqual([]);
  });

  it("a batch that ends on a malformed row still advances the cursor past it", async () => {
    pg.events.push({ id: id(9), user_id: U1, ts: toMicros("2026-09-01T12:00:01.000000Z"), type: "saved", payload: { topics: 7 } });
    const first = await runLearningJobForUser(U1, deps);
    expect(first.eventsProcessed).toBe(0);
    expect(first.cursorAdvancedTo).toEqual({ ts: "2026-09-01T12:00:01.000000Z", id: id(9) });
    expect((await runLearningJobForUser(U1, deps)).cursorAdvancedTo).toBeNull();
  });

  it("apply and cursor move run inside the caller's transaction; a throw leaves the cursor where it was", async () => {
    pg.events.push(saved(1, U1, "2026-09-01T12:00:00.100000Z"), saved(2, U1, "2026-09-01T12:00:00.200000Z"));
    const steps: string[] = [];
    const transaction = async <T,>(fn: () => Promise<T>): Promise<T> => {
      steps.push("begin");
      try {
        const out = await fn();
        steps.push("commit");
        return out;
      } catch (err) {
        steps.push("rollback");
        throw err;
      }
    };
    let appends = 0;
    const flaky = {
      append: async (...args: Parameters<InMemoryInterestAuditRepository["append"]>) => {
        appends += 1;
        if (appends === 2) throw new Error("db hiccup");
        return auditRepo.append(...args);
      }
    } as unknown as InMemoryInterestAuditRepository;
    await expect(runLearningJobForUser(U1, { ...deps, applyDeps: { ...deps.applyDeps, auditRepo: flaky }, transaction })).rejects.toThrow(/db hiccup/);
    expect(steps).toEqual(["begin", "rollback"]);
    expect(pg.cursors.has(U1)).toBe(false);

    const ok = await runLearningJobForUser(U1, { ...deps, transaction });
    expect(steps.slice(2)).toEqual(["begin", "commit"]);
    expect(ok.eventsProcessed).toBe(2);
  });

  it("one user's failure is recorded and the next user still runs (the CLI then exits non-zero)", async () => {
    pg.events.push(saved(1, U1, "2026-09-01T12:00:00.100000Z"), saved(2, U2, "2026-09-01T12:00:00.100000Z"));
    const broken = {
      ...deps,
      cursorStore: {
        get: async (u: string) => {
          if (u === U1) throw new Error("cursor read failed");
          return deps.cursorStore.get(u);
        },
        set: (u: string, c: { lastEventTs: string; lastEventId: string }) => deps.cursorStore.set(u, c)
      }
    };
    const summary = await runLearningJobForUsers([U1, U2], broken);
    expect(summary.failures).toEqual([{ userId: U1, error: "cursor read failed" }]);
    expect(summary.results.map((r) => [r.userId, r.eventsProcessed])).toEqual([[U2, 1]]);
  });
});
