import { describe, it, expect } from "vitest";
import { JOB_SNAPSHOT_SCHEMA, type JobSnapshot } from "../src/generation/jobSink";
import type { ForayItem } from "../src/generation/forayItems";
import { bodyHasPromptKey, SupabaseJobSink, type JobSinkFetch } from "../src/cli/supabaseJobSink";

/**
 * GV-59 (docs/roadmap/generation-v2.md, #1286; W6-18; D9): the Supabase job
 * sink, against a FAKE PostgREST that evaluates the same filters the real one
 * would (id, author_id, seq=lt, status=in) over one in-memory generation_jobs
 * row. Offline: no network, no key, no Supabase. Each test names the mutation
 * it kills; every one was run against the source and went red.
 */

const BASE = "https://example-ref.supabase.co";
const KEY = "service-key-SECRET-123";
const JOB = "0b9c7a52-5c4e-4c11-9a1e-7f0d2b6c8e41";
const AUTHOR = "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b";
const OTHER = "11111111-2222-4333-8444-555555555555";
const FORAY = "the-history-of-grilling-a1b2c3";
const AT = "2026-10-13T10:00:00.000Z";

const narration = (id: string): ForayItem => ({ type: "narration", id, script: `Line ${id}.`, mode: "frame" });

/** A valid snapshot serving the first `n` items. */
function snap(seq: number, n: number, extra: Partial<JobSnapshot> = {}): JobSnapshot {
  const items = Array.from({ length: n }, (_v, i) => narration(i === 0 ? "prelude" : `item-${i}`));
  return {
    schema: JOB_SNAPSHOT_SCHEMA,
    jobId: "driver-minted-id",
    forayId: FORAY,
    authorId: AUTHOR,
    lane: "on-demand",
    status: "running",
    seq,
    updatedAt: AT,
    title: "Fire, smoke and time",
    topic: "food/grilling-bbq",
    summary: "How people learned to cook with smoke.",
    acts: [],
    items,
    itemStates: items.map((it) => ({ itemId: (it as { id: string }).id, check: "unchecked-seam" as const, audio: "pending" as const })),
    runtimeSecSoFar: 10 * n,
    ...extra
  };
}

interface Row {
  id: string;
  author_id: string;
  status: string;
  seq: number;
  snapshot: unknown;
  prompt: string | null;
}

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** One generation_jobs row behind a PostgREST look-alike. */
function fakePostgrest(row: Row, opts: { failWith?: number; failOn?: "GET" | "PATCH" } = {}) {
  const calls: Call[] = [];
  const fetch: JobSinkFetch = async (url, init) => {
    calls.push({ method: init.method, url, headers: init.headers, body: init.body });
    if (opts.failWith && (!opts.failOn || opts.failOn === init.method)) return { ok: false, status: opts.failWith, json: async () => ({ message: `echo ${init.body ?? ""}` }) };
    const u = new URL(url);
    expect(u.pathname).toBe("/rest/v1/generation_jobs");
    const p = u.searchParams;
    const eq = (k: keyof Row) => !p.has(k) || p.get(k) === `eq.${row[k]}`;
    const seqOk = !p.has("seq") || row.seq < Number(/^lt\.(\d+)$/.exec(p.get("seq")!)![1]);
    const statusOk = !p.has("status") || /^in\.\((.*)\)$/.exec(p.get("status")!)![1]!.split(",").includes(row.status);
    const match = eq("id") && eq("author_id") && seqOk && statusOk;
    if (init.method === "GET") {
      return { ok: true, status: 200, json: async () => (match ? [{ author_id: row.author_id, seq: row.seq, snapshot: row.snapshot }] : []) };
    }
    if (!match) return { ok: true, status: 200, json: async () => [] };
    Object.assign(row, JSON.parse(init.body!));
    return { ok: true, status: 200, json: async () => [{ seq: row.seq }] };
  };
  return { fetch, calls, patches: () => calls.filter((c) => c.method === "PATCH") };
}

const claimedRow = (over: Partial<Row> = {}): Row => ({ id: JOB, author_id: AUTHOR, status: "claimed", seq: 0, snapshot: null, prompt: null, ...over });
const sinkOver = (fetch: JobSinkFetch, jobId = JOB) => new SupabaseJobSink({ baseUrl: BASE, serviceKey: KEY, jobId, fetch, clock: () => new Date(AT) });

/** True when a key named `prompt` appears anywhere in the JSON. */
const hasPromptKey = (v: unknown): boolean =>
  Array.isArray(v) ? v.some(hasPromptKey) : v && typeof v === "object" ? Object.entries(v).some(([k, x]) => k === "prompt" || hasPromptKey(x)) : false;

describe("SupabaseJobSink (GV-59)", () => {
  it("publishes one guarded PATCH per snapshot, seq increasing, and no body carries a prompt", async () => {
    /* Mutations: drop `&seq=lt.${seq}` from the PATCH url, or send `prompt`
       in the body -> red. */
    const row = claimedRow();
    const pg = fakePostgrest(row);
    const sink = sinkOver(pg.fetch);
    for (const [seq, n] of [[1, 1], [2, 2], [3, 4]] as const) await sink.publish(snap(seq, n));

    const patches = pg.patches();
    expect(patches.map((c) => JSON.parse(c.body!).seq)).toEqual([1, 2, 3]);
    for (const [i, c] of patches.entries()) {
      const p = new URL(c.url).searchParams;
      expect(p.get("id")).toBe(`eq.${JOB}`);
      expect(p.get("author_id")).toBe(`eq.${AUTHOR}`);
      expect(p.get("seq")).toBe(`lt.${i + 1}`);
      expect(p.get("status")).toBe("in.(claimed,running)");
      expect(c.headers.Prefer).toBe("return=representation");
      expect(c.headers.Authorization).toBe(`Bearer ${KEY}`);
      const body = JSON.parse(c.body!);
      expect(Object.keys(body).sort()).toEqual(["seq", "snapshot", "status"]);
      expect(body.snapshot.jobId).toBe(JOB);
    }
    for (const c of pg.calls) {
      if (c.body !== undefined) expect(hasPromptKey(JSON.parse(c.body))).toBe(false);
    }
    expect(row).toMatchObject({ status: "running", seq: 3, prompt: null });
    expect((row.snapshot as JobSnapshot).items).toHaveLength(4);
    expect(sink.lastOutcome()).toBe("written");
  });

  it("a stale publish (lower seq than the row's) is a no-op because of the guard", async () => {
    /* Mutation: drop the seq guard from the PATCH url -> the laggard's seq 2
       overwrites the row at seq 5 (red). */
    const row = claimedRow();
    const pg = fakePostgrest(row);
    const laggard = sinkOver(pg.fetch);
    await laggard.publish(snap(1, 1));
    /* Another process moved the row on meanwhile. */
    const newer = snap(5, 3, { jobId: JOB });
    Object.assign(row, { seq: 5, snapshot: newer });

    await laggard.publish(snap(2, 2));
    expect(pg.patches()).toHaveLength(2);
    expect(laggard.lastOutcome()).toBe("unchanged");
    expect(row.seq).toBe(5);
    expect(row.snapshot).toEqual(newer);
    expect(laggard.lastSnapshot()!.seq).toBe(1);
  });

  it("never revives a job the author cancelled", async () => {
    /* Mutation: drop the `status=in.(claimed,running)` guard -> the row
       reads "running" again (red). */
    const row = claimedRow();
    const pg = fakePostgrest(row);
    const sink = sinkOver(pg.fetch);
    await sink.publish(snap(1, 1));
    row.status = "cancelled";
    await sink.publish(snap(2, 2));
    await sink.close("complete");
    expect(row.status).toBe("cancelled");
    expect(row.seq).toBe(1);
    expect(sink.lastOutcome()).toBe("unchanged");
  });

  it("refuses a body with a prompt key at any depth, before anything is sent", async () => {
    /* Two gates: the strict snapshot schema refuses the snapshot, and the
       body scan (bodyHasPromptKey) catches a prompt key at any depth should
       a schema ever loosen. Mutation: make bodyHasPromptKey return false ->
       the direct assertions below go red. */
    const pg = fakePostgrest(claimedRow());
    const sink = sinkOver(pg.fetch);
    const leaky = snap(1, 2);
    (leaky.items[1] as Record<string, unknown>).prompt = "tell me about grilling";
    await expect(sink.publish(leaky)).rejects.toThrow(/prompt/);
    expect(pg.patches()).toHaveLength(0);
    for (const c of pg.calls) expect(c.body ?? "").not.toContain("tell me about grilling");

    expect(bodyHasPromptKey({ status: "running", snapshot: { items: [{ type: "narration", Prompt: "x" }] } })).toBe(true);
    expect(bodyHasPromptKey([{ a: [{ prompt: null }] }])).toBe(true);
    expect(bodyHasPromptKey({ status: "running", seq: 2, snapshot: snap(2, 3) })).toBe(false);
  });

  it("refuses another author's row, and a snapshot naming another author, without writing", async () => {
    /* Mutation: drop the author check in publish -> the snapshot is sent
       (the server's author_id filter would then be the only guard) (red). */
    const pg = fakePostgrest(claimedRow({ author_id: OTHER }));
    await expect(sinkOver(pg.fetch).publish(snap(1, 1))).rejects.toThrow(/another author/);
    expect(pg.patches()).toHaveLength(0);

    const pg2 = fakePostgrest(claimedRow());
    const sink = sinkOver(pg2.fetch);
    await sink.publish(snap(1, 1));
    await expect(sink.publish(snap(2, 2, { authorId: OTHER }))).rejects.toThrow(/another author/);
    expect(pg2.patches()).toHaveLength(1);
  });

  it("a resumed process continues the row's seq and never serves less than the row does", async () => {
    /* Mutations: drop the seq offset from carry (seqOffset 0) -> its first
       write is seq 1 under a row at 3, a guard no-op forever (red); drop the
       floor -> the one-item snapshot replaces the row's two (red). */
    const prior = snap(3, 2, { jobId: JOB });
    const row = claimedRow({ status: "running", seq: 3, snapshot: prior });
    const pg = fakePostgrest(row);
    const sink = sinkOver(pg.fetch);

    await sink.publish(snap(1, 1));
    expect(sink.lastOutcome()).toBe("floor");
    expect(pg.patches()).toHaveLength(0);
    expect(row.snapshot).toEqual(prior);

    await sink.publish(snap(2, 3));
    expect(row.seq).toBe(5);
    expect((row.snapshot as JobSnapshot).items).toHaveLength(3);
    expect(pg.calls.filter((c) => c.method === "GET")).toHaveLength(1);
  });

  it("close writes the final snapshot with the run's outcome; aborted reads failed", async () => {
    /* Mutation: close the last snapshot as "complete" whatever the outcome
       -> red. */
    const row = claimedRow();
    const sink = sinkOver(fakePostgrest(row).fetch);
    await sink.publish(snap(1, 2));
    await sink.close("aborted", "budget-stop");
    expect(row.status).toBe("failed");
    expect(row.seq).toBe(2);
    expect((row.snapshot as JobSnapshot).closed).toEqual({ outcome: "aborted", detail: "budget-stop" });

    const row2 = claimedRow();
    const sink2 = sinkOver(fakePostgrest(row2).fetch);
    await sink2.publish(snap(1, 1));
    await sink2.close("complete");
    expect(row2).toMatchObject({ status: "complete", seq: 2 });
  });

  it("close with no snapshot anywhere moves only status and seq, so a claimed job does not read claimed forever", async () => {
    /* Mutation: return early from close when there is no snapshot (the
       FileJobSink rule) -> the row stays "claimed" (red). */
    const row = claimedRow();
    const pg = fakePostgrest(row);
    await sinkOver(pg.fetch).close("failed", "error", { forayId: FORAY, authorId: AUTHOR });
    expect(row).toMatchObject({ status: "failed", seq: 1, snapshot: null });
    expect(JSON.parse(pg.patches()[0]!.body!)).toEqual({ status: "failed", seq: 1 });
  });

  it("validates its inputs and never puts the key in an error", async () => {
    /* Mutation: append JSON.stringify(this.headers()) to the HTTP error ->
       the key reaches the message (red). */
    expect(() => sinkOver(fakePostgrest(claimedRow()).fetch, "job-1")).toThrow(/uuid/);
    expect(() => new SupabaseJobSink({ baseUrl: `${BASE}/rest/v1`, serviceKey: KEY, jobId: JOB, fetch: fakePostgrest(claimedRow()).fetch })).toThrow(/origin/);
    expect(() => new SupabaseJobSink({ baseUrl: BASE, serviceKey: "", jobId: JOB, fetch: fakePostgrest(claimedRow()).fetch })).toThrow(/service key/);

    for (const failOn of ["GET", "PATCH"] as const) {
      const failing = fakePostgrest(claimedRow(), { failWith: 500, failOn });
      const err = await sinkOver(failing.fetch).publish(snap(1, 1)).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/HTTP 500/);
      expect((err as Error).message).not.toContain(KEY);
      expect((err as Error).message).not.toContain("echo");
    }
  });
});
