import { describe, it, expect } from "vitest";
import {
  audioReadyFor,
  audioStateFor,
  DEFAULT_AWAIT_RENDER_CAP_MS,
  isPublicAudioUrl,
  lexiconFromHints,
  NarrationRenderTracker,
  RENDER_JOB_ID_PATTERN,
  renderJobIdFor,
  renderJobsFor,
  renderReportOf,
  renderResultFromDone,
  type NarrationRenderClient,
  type RenderJob,
  type RenderResult
} from "../src/generation/narrationRender";
import { EMPTY_JOB_PROGRESS, JobSnapshotSchema, progressWithEvent, snapshotFrom, type JobIdentity, type JobProgress } from "../src/generation/jobSink";
import type { ItemReadyEvent } from "../src/generation/deliveryTimeline";
import type { ForayItem } from "../src/generation/forayItems";
import type { ItemCheck } from "../src/generation/itemReadiness";
import { PronunciationHintSchema, type PronunciationHint } from "../src/types/narration";

/**
 * GV-74 (docs/roadmap/generation-v2.md, #1286; from W6-07): the backend render
 * stage — render jobs from item-ready events in play order, the audio state
 * folded into the job snapshot (phone voice first), and the report's
 * `delivery.render` block. Offline: a fake render client, a fake clock (every
 * time is on the event or the done record), hand-built events. Each test names
 * the mutation it kills; every one was run against the source and went red.
 */

const FORAY = "the-history-of-grilling-a1b2c3";
const JOB: JobIdentity = { jobId: "job-1", authorId: "founder-1", lane: "catalogue" };
const AT = "2026-10-13T10:00:00.000Z";
const URL_BASE = "https://narration.example.test/n";

const narration = (id: string, script = `Line ${id}.`): ForayItem => ({ type: "narration", id, script, mode: "frame" });
const segment = (id: string): ForayItem => ({ type: "segment", segment_id: id });

/** prelude, act 0 (intro, tape, exit), act 1 (intro, tape, exit). */
const ITEMS: ForayItem[] = [
  narration("prelude", "This Foray was generated."),
  narration("act-1-introduction"),
  segment("show-a--ep-1#10"),
  narration("act-1-exit"),
  narration("act-2-introduction"),
  segment("show-b--ep-2#20"),
  narration("act-2-exit")
];
const ACT_OF = [-1, 0, 0, 0, 1, 1, 1];
const idOf = (item: ForayItem): string => (item.type === "segment" ? item.segment_id : (item as { id: string }).id);
const checkOf = (item: ForayItem, i: number): ItemCheck => (i === 0 ? "prelude" : item.type === "segment" ? "tape" : "unchecked-seam");

/** The fake clock: item i is ready at 1 s x i (ms since the attempt began). */
function event(index: number, servable = true): ItemReadyEvent {
  const item = ITEMS[index]!;
  return {
    forayId: FORAY,
    index,
    itemId: idOf(item),
    actIndex: ACT_OF[index]!,
    check: checkOf(item, index),
    servable,
    readyAtMs: 1000 * index,
    playStartSec: 50 * index,
    durationSec: 50,
    item,
    granularity: "act"
  };
}

/** A fake client: records every enqueue call and answers `results()` with
 * whatever the test put in `done`. */
class FakeRenderClient implements NarrationRenderClient {
  readonly calls: RenderJob[][] = [];
  done: RenderResult[] = [];
  async enqueue(jobs: RenderJob[]): Promise<void> {
    this.calls.push(jobs.map((j) => ({ ...j })));
  }
  async results(): Promise<RenderResult[]> {
    return this.done.map((r) => ({ ...r }));
  }
  get enqueued(): RenderJob[] {
    return this.calls.flat();
  }
}

const rendered = (job: RenderJob, extra: Partial<RenderResult> = {}): RenderResult => ({
  jobId: job.jobId,
  itemId: job.itemId,
  status: "rendered",
  key: `n/${job.itemId}.m4a`,
  publicUrl: `${URL_BASE}/${job.itemId}.m4a`,
  audioSec: 10,
  renderMs: 2000,
  queuedMs: 500,
  ...extra
});
const failed = (job: RenderJob): RenderResult => ({ jobId: job.jobId, itemId: job.itemId, status: "failed", renderMs: 100, queuedMs: 0 });

const allEvents = (): ItemReadyEvent[] => ITEMS.map((_it, i) => event(i));
const progressOf = (evs: ItemReadyEvent[]): JobProgress => evs.reduce((p, ev) => progressWithEvent(p, ev), EMPTY_JOB_PROGRESS);

describe("renderJobsFor and the tracker — jobs in play order", () => {
  it("enqueues jobs in item-index order, narration only, and the first narration item has the lowest priority", async () => {
    /* MUTATION THAT KILLS THIS: set `priority` to the act index (ev.actIndex)
       instead of the item index. The prelude reads -1 and both act-0 lines
       share one priority, so the priorities are not the item indices. Ran it
       — red. Also killed: drop the `item.type !== "narration"` guard (tape
       segments become jobs). Ran it — red. */
    const client = new FakeRenderClient();
    const tracker = new NarrationRenderTracker(client);
    tracker.beginAttempt();
    for (const ev of allEvents()) await tracker.onItemReady(ev);
    const jobs = client.enqueued;
    expect(jobs.map((j) => j.itemId)).toEqual(["prelude", "act-1-introduction", "act-1-exit", "act-2-introduction", "act-2-exit"]);
    expect(jobs.map((j) => j.priority)).toEqual([0, 1, 3, 4, 6]);
    expect(Math.min(...jobs.map((j) => j.priority))).toBe(jobs[0]!.priority);
    for (const j of jobs) {
      expect(j.jobId).toMatch(RENDER_JOB_ID_PATTERN);
      expect(j.forayId).toBe(FORAY);
      expect(j.script).toBe((ITEMS.find((it) => idOf(it) === j.itemId) as { script: string }).script);
    }
  });

  it("makes no job for an unservable item, and never enqueues the same line twice", async () => {
    /* MUTATION THAT KILLS THIS: drop the `!ev.servable` early return. The
       unservable act-2 line becomes a job. Ran it — red. Also killed: drop
       the `!this.tracked.has(j.jobId)` filter (a resumed attempt re-emitting
       the prelude enqueues it again). Ran it — red. */
    expect(renderJobsFor(event(4, false))).toEqual([]);
    expect(renderJobsFor(event(2))).toEqual([]);
    const client = new FakeRenderClient();
    const tracker = new NarrationRenderTracker(client);
    tracker.beginAttempt();
    await tracker.onItemReady(event(0));
    tracker.beginAttempt();
    await tracker.onItemReady(event(0));
    await tracker.onItemReady(event(4, false));
    expect(client.enqueued.map((j) => j.itemId)).toEqual(["prelude"]);
  });

  it("job ids are id-safe, stable for the same line and new for a rewritten one", () => {
    /* MUTATION THAT KILLS THIS: leave the script out of the hashed text. A
       rewritten line keeps its id and is never rendered again. Ran it — red. */
    const a = renderJobIdFor(FORAY, 3, "act-1-exit", "One line.");
    expect(renderJobIdFor(FORAY, 3, "act-1-exit", "One line.")).toBe(a);
    expect(renderJobIdFor(FORAY, 3, "act-1-exit", "Another line.")).not.toBe(a);
    expect(renderJobIdFor("../../etc/passwd", 0, "x", "y")).toMatch(RENDER_JOB_ID_PATTERN);
    expect(renderJobIdFor("x".repeat(200), 0, "x", "y")).toMatch(RENDER_JOB_ID_PATTERN);
  });
  it("a resumed attempt that rewrites a line never serves the old line's render; await-render waits for the new one", async () => {
    /* MUTATION THAT KILLS THIS: in NarrationRenderTracker's `results`, return
       every tracked result (drop the current-job filter). The rewritten
       prelude is served with the OLD line's audio_url and audioKey, and reads
       "rendered" under await-render. Ran it — red. Also killed: in report(),
       pass every tracked job and result (the superseded render counts into
       narrationSec). Ran it — red. Also killed: set the item's current job
       only for a fresh job (the line rewritten back to its first script keeps
       pointing at the second job). Ran it — red. */
    const client = new FakeRenderClient();
    const tracker = new NarrationRenderTracker(client);
    tracker.beginAttempt();
    const first: ItemReadyEvent = { ...event(0), item: narration("prelude", "Old line.") };
    await tracker.onItemReady(first);
    const oldJob = client.enqueued[0]!;
    client.done = [rendered(oldJob, { publicUrl: `${URL_BASE}/old.m4a`, key: "k-old", audioSec: 4, renderMs: 1000, queuedMs: 0 })];
    await tracker.refresh();
    expect(tracker.results.map((r) => r.jobId)).toEqual([oldJob.jobId]);

    /* Attempt 2 re-runs the act and re-emits the prelude, rewritten. */
    tracker.beginAttempt();
    const second: ItemReadyEvent = { ...event(0), item: narration("prelude", "New rewritten line.") };
    await tracker.onItemReady(second);
    const newJob = client.enqueued[1]!;
    expect(newJob.jobId).not.toBe(oldJob.jobId);
    expect(tracker.results).toEqual([]);
    await tracker.refresh();
    expect(tracker.results).toEqual([]);
    const progress = progressOf([first, second]);
    const served = snapshotFrom(JOB, progress, 0, AT, { policy: "phone-voice-first", results: tracker.results })!;
    expect(served.items[0]).toEqual(second.item);
    expect(served.items[0]).not.toHaveProperty("audio_url");
    expect(served.itemStates[0]).toEqual({ itemId: "prelude", check: "prelude", audio: "phone-voice" });
    expect(audioStateFor("prelude", tracker.results, "await-render")).toBe("pending");
    const held = snapshotFrom(JOB, progress, 0, AT, { policy: "await-render", results: tracker.results })!;
    expect(held.items).toEqual([]);
    expect(held.delivery?.pausedAtIndex).toBe(0);
    expect(tracker.report()).toEqual({ firstRenderedMs: null, narrationSec: 0, renderWallSec: 0, realtimeFactor: null, failed: 0 });

    /* The new line's render answers: served with its own audio. */
    client.done = [...client.done, rendered(newJob, { publicUrl: `${URL_BASE}/new.m4a`, key: "k-new", audioSec: 6, renderMs: 2000, queuedMs: 0 })];
    await tracker.refresh();
    const after = snapshotFrom(JOB, progress, 0, AT, { policy: "await-render", results: tracker.results })!;
    expect(after.items[0]).toEqual({ ...second.item, audio_url: `${URL_BASE}/new.m4a` });
    expect(after.itemStates[0]).toMatchObject({ audio: "rendered", audioKey: "k-new" });
    expect(tracker.report()).toMatchObject({ narrationSec: 6, renderWallSec: 2 });

    /* Attempt 3 re-emits the first script: its job is current again, nothing is enqueued twice. */
    tracker.beginAttempt();
    await tracker.onItemReady(first);
    expect(client.enqueued).toHaveLength(2);
    expect(tracker.results.map((r) => r.jobId)).toEqual([oldJob.jobId]);
  });
});

describe("audio state — phone voice first", () => {
  const job = renderJobsFor(event(1))[0]!;

  it("a failed render or an un-uploaded file reads phone-voice; only a confirmed upload reads rendered", () => {
    /* MUTATION THAT KILLS THIS: return "rendered" for any rendered status,
       public URL or not. The un-uploaded file reads "rendered". Ran it — red. */
    expect(audioStateFor(job.itemId, [failed(job)], "phone-voice-first")).toBe("phone-voice");
    expect(audioStateFor(job.itemId, [failed(job)], "await-render")).toBe("phone-voice");
    expect(audioStateFor(job.itemId, [rendered(job, { publicUrl: undefined })], "await-render")).toBe("phone-voice");
    expect(audioStateFor(job.itemId, [rendered(job)], "phone-voice-first")).toBe("rendered");
    expect(audioStateFor(job.itemId, [], "phone-voice-first")).toBe("phone-voice");
    expect(audioStateFor(job.itemId, [], "await-render")).toBe("pending");
  });

  it("await-render holds readiness until a result arrives; phone-voice-first does not", () => {
    /* MUTATION THAT KILLS THIS: make audioStateFor ignore the policy (no
       result reads "pending" under both). phone-voice-first then holds first
       audio. Ran it — red. */
    expect(audioReadyFor(job.itemId, [], "phone-voice-first")).toBe(true);
    expect(audioReadyFor(job.itemId, [], "await-render")).toBe(false);
    expect(audioReadyFor(job.itemId, [failed(job)], "await-render")).toBe(true);
    expect(audioReadyFor(job.itemId, [rendered(job)], "await-render")).toBe(true);
  });
});

describe("snapshotFrom with the render stage's results", () => {
  const jobs = allEvents().flatMap((ev) => renderJobsFor(ev));
  const byItem = (id: string): RenderJob => jobs.find((j) => j.itemId === id)!;

  it("without render results the snapshot is GV-44's: every item pending, no audio_url", () => {
    /* MUTATION THAT KILLS THIS: default `audio` to a phone-voice-first
       JobAudio inside snapshotFrom. The default row's items read
       "phone-voice". Ran it — red. */
    const s = snapshotFrom(JOB, progressOf(allEvents()), 0, AT)!;
    expect(s.itemStates.every((st) => st.audio === "pending")).toBe(true);
    expect(JSON.stringify(s)).not.toContain("audio_url");
  });

  it("a failed render marks the item phone-voice and the item still appears, without audio_url", () => {
    /* MUTATION THAT KILLS THIS: hold an item whose render failed (treat
       "phone-voice" like "pending" in servablePrefix). The failed line and
       everything after it leave the row. Ran it — red. */
    const results = [rendered(byItem("prelude")), failed(byItem("act-1-introduction"))];
    for (const policy of ["phone-voice-first", "await-render"] as const) {
      const s = snapshotFrom(JOB, progressOf(allEvents().slice(0, 3)), 0, AT, { policy, results })!;
      expect(s.items.map(idOf)).toEqual(["prelude", "act-1-introduction", "show-a--ep-1#10"]);
      expect(s.itemStates[1]).toEqual({ itemId: "act-1-introduction", check: "unchecked-seam", audio: "phone-voice" });
      expect(s.items[1]).not.toHaveProperty("audio_url");
      expect(s.items[0]).toEqual({ ...ITEMS[0], audio_url: `${URL_BASE}/prelude.m4a` });
      expect(s.itemStates[0]).toEqual({ itemId: "prelude", check: "prelude", audio: "rendered", audioKey: "n/prelude.m4a" });
      expect(JobSnapshotSchema.safeParse(s).success).toBe(true);
    }
  });

  it("await-render holds the prefix at the first narration line with no result; phone-voice-first serves it", () => {
    /* MUTATION THAT KILLS THIS: drop the `state === "pending"` hold in
       servablePrefix. await-render serves act 1's exit before its render
       answered. Ran it — red. */
    const results = [rendered(byItem("prelude")), rendered(byItem("act-1-introduction"))];
    const held = snapshotFrom(JOB, progressOf(allEvents()), 0, AT, { policy: "await-render", results })!;
    expect(held.items.map(idOf)).toEqual(["prelude", "act-1-introduction", "show-a--ep-1#10"]);
    expect(held.delivery).toMatchObject({ servableThrough: 3, itemsGenerated: 7, pausedAtIndex: 3 });
    expect(JobSnapshotSchema.safeParse(held).success).toBe(true);

    const first = snapshotFrom(JOB, progressOf(allEvents()), 0, AT, { policy: "phone-voice-first", results })!;
    expect(first.items).toHaveLength(7);
    expect(first.itemStates.filter((st) => st.audio === "phone-voice").map((st) => st.itemId)).toEqual(["act-1-exit", "act-2-introduction", "act-2-exit"]);
    expect(first.delivery?.pausedAtIndex).toBeNull();
  });

  it("never writes audio_url unless the done record carries public_url", () => {
    /* MUTATION THAT KILLS THIS: in renderResultFromDone, fall back to the
       entry key as the public URL when public_url is missing. The
       un-uploaded line gets an audio_url. Ran it — red. Also killed: drop
       isPublicAudioUrl's scheme check (a `file:` URL reaches the row). Ran
       it — red. GV-82 (GV-74 review): https only — loosen the regex back to
       `https?` and the cleartext `http://` URL reaches the row. Ran it — red. */
    const prelude = byItem("prelude");
    const intro = byItem("act-1-introduction");
    const done = (job: RenderJob, extra: Record<string, unknown> = {}) => ({
      job_id: job.jobId,
      status: "rendered",
      entry: { key: `n/${job.itemId}.m4a`, duration_sec: 4.2 },
      timings: { queued_ms: 10, render_ms: 900, audio_sec: 4.2 },
      ...extra
    });
    const noUrl = renderResultFromDone(prelude, done(prelude))!;
    const badUrl = renderResultFromDone(intro, done(intro, { public_url: "file:///tmp/x.m4a" }))!;
    const exit = byItem("act-1-exit");
    const httpUrl = renderResultFromDone(exit, done(exit, { public_url: "http://narration.example.test/n/act-1-exit.m4a" }))!;
    expect(noUrl).not.toHaveProperty("publicUrl");
    expect(badUrl).not.toHaveProperty("publicUrl");
    expect(httpUrl).not.toHaveProperty("publicUrl");
    expect(isPublicAudioUrl("http://narration.example.test/n/x.m4a")).toBe(false);
    expect(isPublicAudioUrl(`${URL_BASE}/x.m4a`)).toBe(true);
    const s = snapshotFrom(JOB, progressOf(allEvents().slice(0, 4)), 0, AT, { policy: "await-render", results: [noUrl, badUrl, httpUrl] })!;
    expect(s.items).toHaveLength(4);
    expect(JSON.stringify(s)).not.toContain("audio_url");
    expect(s.itemStates.filter((st) => st.audio !== "pending").map((st) => st.audio)).toEqual(["phone-voice", "phone-voice", "phone-voice"]);

    const uploaded = renderResultFromDone(prelude, done(prelude, { public_url: `${URL_BASE}/prelude.m4a` }))!;
    expect(uploaded).toMatchObject({ status: "rendered", publicUrl: `${URL_BASE}/prelude.m4a`, key: "n/prelude.m4a", audioSec: 4.2, renderMs: 900, queuedMs: 10 });
    expect(renderResultFromDone(prelude, done(intro))).toBeNull();
    expect(renderResultFromDone(prelude, { job_id: prelude.jobId, status: "failed", error: "boom", timings: {} })).toEqual({ jobId: prelude.jobId, itemId: "prelude", status: "failed" });
    /* A failed record that somehow carries a URL still writes none. */
    expect(renderResultFromDone(prelude, { job_id: prelude.jobId, status: "failed", public_url: `${URL_BASE}/x.m4a` })).not.toHaveProperty("publicUrl");
  });

  it("the schema takes an http(s) audio_url on a narration item only", () => {
    /* MUTATION THAT KILLS THIS: widen the segment schema too (or drop the
       URL regex). A segment with audio_url, or a non-URL, validates. Ran it
       — red. */
    const s = snapshotFrom(JOB, progressOf(allEvents().slice(0, 3)), 0, AT, { policy: "phone-voice-first", results: [rendered(byItem("prelude"))] })!;
    expect(JobSnapshotSchema.safeParse(s).success).toBe(true);
    expect(JobSnapshotSchema.safeParse({ ...s, items: [s.items[0], s.items[1], { ...s.items[2], audio_url: `${URL_BASE}/x.m4a` }] }).success).toBe(false);
    expect(JobSnapshotSchema.safeParse({ ...s, items: [{ ...s.items[0], audio_url: "not a url" }, s.items[1], s.items[2]] }).success).toBe(false);
  });
});

describe("renderReportOf — delivery.render (MT-09)", () => {
  it("is populated from fake results: first rendered time, narration and render seconds, realtime factor, failures", async () => {
    /* MUTATION THAT KILLS THIS: leave the queued time out of firstRenderedMs
       (enqueue + render only). The first rendered line reads 500 ms early.
       Ran it — red. Also killed: count failed jobs' render time into
       renderWallSec. Ran it — red. */
    const client = new FakeRenderClient();
    const tracker = new NarrationRenderTracker(client);
    tracker.beginAttempt();
    for (const ev of allEvents()) await tracker.onItemReady(ev);
    const [prelude, intro, exit] = client.enqueued;
    client.done = [
      rendered(prelude!, { audioSec: 6, renderMs: 3000, queuedMs: 500 }),
      rendered(intro!, { audioSec: 30, renderMs: 6000, queuedMs: 2000, publicUrl: undefined }),
      failed(exit!),
      /* another run's record in the same spool: never counted */
      { jobId: "someone-else.i0.0000000000000000", itemId: "prelude", status: "rendered", audioSec: 999, renderMs: 1 }
    ];
    await tracker.refresh();
    expect(tracker.results).toHaveLength(3);
    expect(tracker.report()).toEqual({ firstRenderedMs: 3500, narrationSec: 36, renderWallSec: 9, realtimeFactor: 4, failed: 1 });
  });

  it("nothing rendered reads null times and zero seconds, never a made-up factor", () => {
    expect(renderReportOf([], [], 1)).toEqual({ firstRenderedMs: null, narrationSec: 0, renderWallSec: 0, realtimeFactor: null, failed: 0 });
  });

  it("firstRenderedMs counts only the final attempt's jobs (an earlier attempt's clock started elsewhere)", () => {
    /* MUTATION THAT KILLS THIS: drop the `tracked.attempt === finalAttempt`
       condition. Attempt 1's prelude (at 3.5 s on ITS clock) wins. Ran it —
       red. */
    const [p] = renderJobsFor(event(0));
    const [i] = renderJobsFor(event(1));
    const tracked = [
      { job: p!, enqueuedAtMs: 0, attempt: 1 },
      { job: i!, enqueuedAtMs: 20_000, attempt: 2 }
    ];
    const r = renderReportOf(tracked, [rendered(p!, { renderMs: 3000, queuedMs: 500 }), rendered(i!, { renderMs: 1000, queuedMs: 0 })], 2);
    expect(r.firstRenderedMs).toBe(21_000);
    expect(r.narrationSec).toBe(20);
  });
});

describe("GV-82 — pronunciation hints into the job's render lexicon", () => {
  const GDANSK: PronunciationHint = { word: "Gdansk", hint: "guh-DANSK", ipa: "ɡədˈænsk" };

  it("PronunciationHintSchema takes an optional ipa and still takes every pre-GV-82 hint", () => {
    /* MUTATION THAT KILLS THIS: make `ipa` required. The writer's existing
       {word, hint} output stops parsing. Ran it — red. Also killed: drop
       `ipa` from the strict schema (the IPA hint is refused as an unknown
       key). Ran it — red. Also killed: drop `.min(1)` (an empty ipa parses
       and would reach the render job). Ran it — red. */
    expect(PronunciationHintSchema.safeParse({ word: "koji", hint: "KOH-jee" }).success).toBe(true);
    expect(PronunciationHintSchema.parse({ word: "Gdansk", hint: "guh-DANSK", ipa: " ɡədˈænsk " })).toEqual({ word: "Gdansk", hint: "guh-DANSK", ipa: "ɡədˈænsk" });
    expect(PronunciationHintSchema.safeParse({ word: "Gdansk", hint: "x", ipa: "  " }).success).toBe(false);
    expect(PronunciationHintSchema.safeParse({ word: "Gdansk", hint: "x", ipa: "ɡ", extra: 1 }).success).toBe(false);
  });

  it("renderJobsFor maps every hint with ipa into job.lexicon; hints without it change nothing, job id included", async () => {
    /* MUTATION THAT KILLS THIS: map hints without ipa too (lexiconFromHints
       drops the `!ipa` guard). The plain hint becomes a pin with an empty
       IPA. Ran it — red. Also killed: hash the lexicon into the job id even
       when it is empty (a hint-free job's id moves from today's). Ran it —
       red. Also killed: leave the lexicon out of the job id (a line whose
       pins changed keeps its old id and is never re-rendered). Ran it —
       red. Also killed: in the tracker's onItemReady, ignore
       opts.pronunciationHints (the enqueued job has no lexicon). Ran it —
       red. */
    const ev = event(1);
    const plain = renderJobsFor(ev)[0]!;
    expect(plain).not.toHaveProperty("lexicon");
    /* origin/main's id for this line before GV-82 (computed with that file). */
    expect(plain.jobId).toBe("the-history-of-grilling-a1b2c3.i1.b0a914135defdd02");
    expect(renderJobIdFor(FORAY, 1, "act-1-introduction", "Line act-1-introduction.", [])).toBe(plain.jobId);
    const noIpa = renderJobsFor(ev, { pronunciationHints: [{ word: "koji", hint: "KOH-jee" }] })[0]!;
    expect(noIpa).toEqual(plain);

    const hinted = renderJobsFor(ev, {
      pronunciationHints: [{ word: "koji", hint: "KOH-jee" }, GDANSK, { word: "gdansk", hint: "dup", ipa: "ɡdˈænsk" }, { word: " Lodz ", hint: "WOOJ", ipa: " wˈuʤ " }]
    })[0]!;
    expect(hinted.lexicon).toEqual([
      { term: "Gdansk", ipa: "ɡədˈænsk" },
      { term: "Lodz", ipa: "wˈuʤ" }
    ]);
    expect(hinted.jobId).not.toBe(plain.jobId);
    expect(hinted.jobId).toMatch(RENDER_JOB_ID_PATTERN);
    expect(renderJobsFor(ev, { pronunciationHints: [GDANSK] })[0]!.jobId).toBe(renderJobIdFor(FORAY, 1, "act-1-introduction", "Line act-1-introduction.", [{ term: "Gdansk", ipa: "ɡədˈænsk" }]));
    expect(lexiconFromHints(undefined)).toEqual([]);
    /* An explicit lexicon entry for a term wins over a hint for the same term. */
    expect(renderJobsFor(ev, { lexicon: [{ term: "GDANSK", ipa: "ɡdˈænsk" }], pronunciationHints: [GDANSK] })[0]!.lexicon).toEqual([{ term: "GDANSK", ipa: "ɡdˈænsk" }]);

    const client = new FakeRenderClient();
    const tracker = new NarrationRenderTracker(client);
    tracker.beginAttempt();
    await tracker.onItemReady(ev, { pronunciationHints: [GDANSK] });
    await tracker.onItemReady(event(3));
    expect(client.enqueued.map((j) => j.lexicon)).toEqual([[{ term: "Gdansk", ipa: "ɡədˈænsk" }], undefined]);
  });
});

describe("GV-82 — await-render is bounded (GV-74 review)", () => {
  it("an unanswered job holds the item until the cap, then reads phone-voice; a late real result still wins; phone-voice-first never times out", async () => {
    /* MUTATION THAT KILLS THIS: drop the timed-out results from the
       `results` getter. The intro stays pending past the cap. Ran it — red.
       Also killed: compare `now - at > cap` (the item still waits at exactly
       the cap). Ran it — red. Also killed: report() over `results` (the
       timeout counts as a failed render). Ran it — red. Also killed: drop the
       policy check (phone-voice-first results carry a made-up failure). Ran
       it — red. */
    let now = 1_000_000;
    const client = new FakeRenderClient();
    const tracker = new NarrationRenderTracker(client, "await-render", { awaitRenderCapMs: 5_000, nowMs: () => now });
    tracker.beginAttempt();
    for (const ev of allEvents().slice(0, 2)) await tracker.onItemReady(ev);
    const [preludeJob, introJob] = client.enqueued;
    client.done = [rendered(preludeJob!)];
    await tracker.refresh();
    const progress = progressOf(allEvents().slice(0, 2));

    now += 4_999;
    expect(audioStateFor("act-1-introduction", tracker.results, "await-render")).toBe("pending");
    expect(snapshotFrom(JOB, progress, 0, AT, { policy: "await-render", results: tracker.results })!.items).toHaveLength(1);

    now += 1;
    expect(tracker.results.find((r) => r.itemId === "act-1-introduction")).toEqual({ jobId: introJob!.jobId, itemId: "act-1-introduction", status: "failed", timedOut: true });
    const served = snapshotFrom(JOB, progress, 0, AT, { policy: "await-render", results: tracker.results })!;
    expect(served.items).toHaveLength(2);
    expect(served.itemStates.map((st) => st.audio)).toEqual(["rendered", "phone-voice"]);
    expect(tracker.report().failed).toBe(0);

    client.done = [...client.done, rendered(introJob!)];
    await tracker.refresh();
    expect(audioStateFor("act-1-introduction", tracker.results, "await-render")).toBe("rendered");
    expect(tracker.results.some((r) => r.timedOut)).toBe(false);

    const free = new NarrationRenderTracker(new FakeRenderClient(), "phone-voice-first", { awaitRenderCapMs: 0, nowMs: () => now });
    free.beginAttempt();
    await free.onItemReady(event(1));
    expect(free.results).toEqual([]);
    expect(DEFAULT_AWAIT_RENDER_CAP_MS).toBe(30_000);
    expect(() => new NarrationRenderTracker(client, "await-render", { awaitRenderCapMs: Number.NaN })).toThrow(/awaitRenderCapMs/);
  });

  it("a job whose enqueue throws is bounded too: pending before the cap, phone-voice at it, and a later event still retries the enqueue", async () => {
    /* The driver catches a failed enqueue and only warns, so no worker can
       ever answer that job. MUTATION THAT KILLS THIS: record enqueuedWallMs
       only after `await this.client.enqueue(fresh)` returns (the pre-fix
       order). The intro has no start time, stays pending at 5000 ms. Ran it
       — red. Also killed: set `tracked` before the enqueue (the retry sees
       the job as already enqueued and sends nothing). Ran it — red. */
    let now = 1_000_000;
    class ThrowOnceClient extends FakeRenderClient {
      failNext = false;
      override async enqueue(jobs: RenderJob[]): Promise<void> {
        if (this.failNext) {
          this.failNext = false;
          throw new Error("spool dir is not writable");
        }
        return super.enqueue(jobs);
      }
    }
    const client = new ThrowOnceClient();
    const tracker = new NarrationRenderTracker(client, "await-render", { awaitRenderCapMs: 5_000, nowMs: () => now });
    tracker.beginAttempt();
    await tracker.onItemReady(event(0));
    const [preludeJob] = client.enqueued;
    client.failNext = true;
    await expect(tracker.onItemReady(event(1))).rejects.toThrow(/not writable/);
    client.done = [rendered(preludeJob!)];
    await tracker.refresh();
    const progress = progressOf(allEvents().slice(0, 2));

    now += 4_999;
    expect(audioStateFor("act-1-introduction", tracker.results, "await-render")).toBe("pending");
    expect(snapshotFrom(JOB, progress, 0, AT, { policy: "await-render", results: tracker.results })!.items).toHaveLength(1);

    now += 1;
    expect(audioStateFor("act-1-introduction", tracker.results, "await-render")).toBe("phone-voice");
    const served = snapshotFrom(JOB, progress, 0, AT, { policy: "await-render", results: tracker.results })!;
    expect(served.itemStates.map((st) => st.audio)).toEqual(["rendered", "phone-voice"]);

    // A later event for the same line retries the enqueue (the failed job was
    // never tracked), and the cap keeps its first-attempt clock.
    const retried = await tracker.onItemReady(event(1));
    expect(retried).toHaveLength(1);
    expect(client.enqueued.map((j) => j.itemId)).toEqual([preludeJob!.itemId, "act-1-introduction"]);
    expect(audioStateFor("act-1-introduction", tracker.results, "await-render")).toBe("phone-voice");
  });
});
