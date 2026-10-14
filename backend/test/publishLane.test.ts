import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  REVIEW_VERDICT_SCHEMA,
  candidateActCount,
  candidateSha256,
  laneCheck,
  laneGate,
  parseArgs,
  parseReviewVerdicts,
  renderedNarrationNotice,
  type ReviewVerdictRow
} from "../src/cli/publishForay";
import { EMPTY_JOB_PROGRESS, JobSnapshotSchema, progressWithEvent, snapshotFrom, type JobIdentity } from "../src/generation/jobSink";
import type { ItemReadyEvent } from "../src/generation/deliveryTimeline";
import type { FinalizeForayInput } from "../src/generation/finalizeForay";
// The verdict WRITER (GV-41). The lane check reads what it writes, so these
// tests build their verdict rows with it rather than by hand.
import { VERDICT_SCHEMA, actCount, appendVerdict, buildVerdict, sha256Of } from "../../tools/generation/review-queue.mjs";

/**
 * GV-81 (docs/roadmap/generation-v2.md, #1286; from W6-17; covers R2-19,
 * GP-07): the two lanes. An on-demand candidate (`meta.lane: "on-demand"`)
 * may not go on to publish-foray's gates without a pass review verdict for
 * every act, given on the sha-256 of the exact --input bytes, and `--force`
 * does not bypass that. A catalogue candidate publishes exactly as before.
 * Also the job row's https-only `audio_url` (the GV-74 review, #1366).
 * Offline: temp files and hand-built fixtures only.
 */

const ID = "grilling-history-abc123";
const SCORES = { onSubject: 4, flowsAtSeams: 4, oneNarrator: 5, nothingFalseOrOdd: 4 };
const AT = "2026-10-13T09:00:00Z";

function candidate(lane?: string, acts = 2): FinalizeForayInput {
  const items: unknown[] = [{ type: "narration", id: "prelude", script: "This Foray was generated.", mode: "marker" }];
  for (let a = 1; a <= acts; a++) {
    items.push({ type: "narration", id: `act-${a}-introduction`, script: `Act ${a} begins.`, mode: "bridge" });
    items.push({ type: "segment", segment_id: `seg-${a}` });
  }
  return {
    id: ID,
    title: "Grilling",
    topic: "food/grilling-bbq",
    summary: "s",
    slots: [],
    items: items as FinalizeForayInput["items"],
    runtimeSec: 600,
    ...(lane !== undefined ? { meta: { veracity: {} as never, lane: lane as never } } : {})
  };
}

const SHA = "a".repeat(64);
const row = (act: number, verdict: ReviewVerdictRow["verdict"] = "pass", over: Partial<ReviewVerdictRow> = {}): ReviewVerdictRow => ({
  schema: REVIEW_VERDICT_SCHEMA,
  forayId: ID,
  act,
  candidateSha256: SHA,
  verdict,
  lane: "on-demand",
  ...over
});

describe("GV-81 — parseArgs: --review-verdict", () => {
  it("parses --review-verdict, and is null without it", () => {
    /* MUTATION THAT KILLS THIS: read the flag as `--review-verdicts` (or not
       at all). The verdicts path never reaches the lane check. Ran it — red. */
    expect(parseArgs(["--input", "c.json", "--review-verdict", "data-local/review/verdicts.jsonl"]).reviewVerdict).toBe("data-local/review/verdicts.jsonl");
    expect(parseArgs(["--input", "c.json"]).reviewVerdict).toBeNull();
    /* --force still forces hold beside it (unchanged). */
    expect(parseArgs(["--input", "c.json", "--force", "--no-hold", "--review-verdict", "v.jsonl"])).toMatchObject({ force: true, hold: true, reviewVerdict: "v.jsonl" });
  });
});

describe("GV-81 — laneCheck", () => {
  it("a catalogue candidate (no lane, or catalogue) passes with no verdicts at all", () => {
    /* MUTATION THAT KILLS THIS: treat an absent lane as on-demand. Every
       existing candidate would be refused. Ran it — red. */
    expect(laneCheck(candidate(), null, SHA)).toEqual({ ok: true, lane: "catalogue", problems: [] });
    expect(laneCheck(candidate("catalogue"), null, SHA)).toEqual({ ok: true, lane: "catalogue", problems: [] });
  });

  it("an on-demand candidate without --review-verdict is refused with a lane message", () => {
    /* MUTATION THAT KILLS THIS: return ok for an on-demand candidate when
       verdictRows is null. Ran it — red. */
    const r = laneCheck(candidate("on-demand"), null, SHA);
    expect(r.ok).toBe(false);
    expect(r.lane).toBe("on-demand");
    expect(r.problems.join(" ")).toMatch(/--review-verdict/);
  });

  it("a pass for every act on these bytes lets it through", () => {
    expect(laneCheck(candidate("on-demand"), [row(1), row(2)], SHA)).toEqual({ ok: true, lane: "on-demand", problems: [] });
  });

  it("a missing act is refused, naming the act", () => {
    /* MUTATION THAT KILLS THIS: require only one pass row (`some` instead of
       every act). Act 2 has none and the candidate would pass. Ran it — red. */
    const r = laneCheck(candidate("on-demand"), [row(1)], SHA);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(["act 2: no verdict"]);
  });

  it("a verdict given on other bytes (a sha mismatch) is refused", () => {
    /* MUTATION THAT KILLS THIS: drop the candidateSha256 comparison. A pass
       on an earlier, regenerated candidate would carry over. Ran it — red. */
    const other = "b".repeat(64);
    const r = laneCheck(candidate("on-demand"), [row(1), row(2, "pass", { candidateSha256: other })], SHA);
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/^act 2: the verdict was given on other bytes/);
  });

  it("the latest verdict wins: a later fail or fix withdraws an earlier pass, and a later pass restores it", () => {
    /* MUTATION THAT KILLS THIS: accept any pass row (`some(r => r.verdict ===
       "pass")`) instead of the latest. The withdrawn act would pass. Ran it —
       red. */
    expect(laneCheck(candidate("on-demand"), [row(1), row(2), row(2, "fail")], SHA).problems).toEqual(['act 2: the latest verdict on these bytes is "fail", not "pass"']);
    expect(laneCheck(candidate("on-demand"), [row(1), row(2, "fix"), row(2)], SHA).ok).toBe(true);
  });

  it("another Foray's verdicts do not count", () => {
    /* MUTATION THAT KILLS THIS: drop the forayId filter. Ran it — red. */
    const r = laneCheck(candidate("on-demand"), [row(1), row(2, "pass", { forayId: "another-foray-abc123" })], SHA);
    expect(r.problems).toEqual(["act 2: no verdict"]);
  });

  it("an unknown lane, and an on-demand candidate with no acts, are refused", () => {
    /* MUTATION THAT KILLS THIS: default any lane that is not "on-demand" to
       catalogue. A typo ("ondemand") would skip the review. Ran it — red. */
    const typo = laneCheck(candidate("ondemand"), null, SHA);
    expect(typo.ok).toBe(false);
    expect(typo.problems[0]).toMatch(/meta\.lane "ondemand" is not one of/);
    expect(laneCheck(candidate("on-demand", 0), [], SHA).ok).toBe(false);
  });

  it("counts acts exactly as the verdict writer (review-queue.mjs actCount) does", () => {
    for (const n of [0, 1, 3]) expect(candidateActCount(candidate(undefined, n))).toBe(actCount(candidate(undefined, n)));
    expect(REVIEW_VERDICT_SCHEMA).toBe(VERDICT_SCHEMA);
  });
});

describe("GV-81 — laneGate: the verdicts file as main reads it", () => {
  let dir: string;
  let file: string;
  let verdicts: string;
  const lines: { log: string[]; error: string[] } = { log: [], error: [] };
  const out = { log: (l: string) => lines.log.push(l), error: (l: string) => lines.error.push(l) };

  const writeCandidate = (c: FinalizeForayInput): Buffer => {
    fs.writeFileSync(file, `${JSON.stringify(c, null, 2)}\n`);
    return fs.readFileSync(file);
  };
  const verdict = (act: number, v: "pass" | "fail" | "fix" = "pass"): void =>
    appendVerdict(verdicts, buildVerdict({ row: { file }, act, verdict: v, scores: SCORES, lane: "on-demand", at: AT }));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-gv81-"));
    file = path.join(dir, `${ID}.json`);
    verdicts = path.join(dir, "verdicts.jsonl");
    lines.log.length = 0;
    lines.error.length = 0;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("an on-demand candidate without --review-verdict is refused even with --force, and says --force does not bypass it", () => {
    /* MUTATION THAT KILLS THIS: let `args.force` short-circuit the gate
       (`if (args.force) return true`). Ran it — red. */
    const bytes = writeCandidate(candidate("on-demand"));
    expect(laneGate({ reviewVerdict: null, force: true }, candidate("on-demand"), bytes, out)).toBe(false);
    expect(lines.error[0]).toMatch(/FAILED the lane check/);
    expect(lines.error.join("\n")).toMatch(/--force does not bypass the lane check/);
  });

  it("with the writer's own pass verdict for every act of these bytes it proceeds; editing one byte refuses it", () => {
    /* MUTATION THAT KILLS THIS: hash the parsed-and-restringified candidate
       instead of the file bytes. The writer hashes the bytes, so the shas
       never match and the reviewed candidate is refused. Ran it — red. */
    const c = candidate("on-demand");
    const bytes = writeCandidate(c);
    verdict(1);
    verdict(2);
    expect(sha256Of(bytes)).toBe(candidateSha256(bytes));
    expect(laneGate({ reviewVerdict: verdicts, force: false }, c, bytes, out)).toBe(true);
    expect(lines.error).toEqual([]);

    const edited = Buffer.concat([bytes, Buffer.from(" ")]);
    expect(laneGate({ reviewVerdict: verdicts, force: true }, c, edited, out)).toBe(false);
    expect(lines.error.join("\n")).toMatch(/act 1: the verdict was given on other bytes/);
  });

  it("an unreadable or malformed verdicts file refuses an on-demand candidate and is not read for a catalogue one", () => {
    /* MUTATION THAT KILLS THIS: swallow a malformed line (skip it) instead of
       refusing. Ran it — red. */
    const c = candidate("on-demand");
    const bytes = writeCandidate(c);
    expect(laneGate({ reviewVerdict: path.join(dir, "missing.jsonl"), force: false }, c, bytes, out)).toBe(false);
    fs.writeFileSync(verdicts, "{not json\n");
    expect(laneGate({ reviewVerdict: verdicts, force: false }, c, bytes, out)).toBe(false);
    expect(lines.error.join("\n")).toMatch(/--review-verdict could not be read: .*verdicts\.jsonl:1: not JSON/);
    expect(() => parseReviewVerdicts(`${JSON.stringify({ schema: "other/1", forayId: ID, act: 1, candidateSha256: SHA, verdict: "pass" })}\n`)).toThrow(/not a foray-review-verdict/);
    /* The catalogue lane never opens the file. */
    const cat = candidate();
    expect(laneGate({ reviewVerdict: verdicts, force: false }, cat, writeCandidate(cat), out)).toBe(true);
  });
});

describe("GV-81 — renderedNarrationNotice", () => {
  it("names the draft-only rule when a narration item carries rendered audio, and says nothing otherwise", () => {
    /* MUTATION THAT KILLS THIS: count only `audio_url` (not a `voices` entry).
       A candidate stamped in Echo only would publish with no word of the rule.
       Ran it — red. */
    expect(renderedNarrationNotice(candidate().items)).toEqual([]);
    const stamped = [
      { type: "narration", id: "prelude", script: "x", mode: "marker", audio_url: "https://audio.jwlabs.ai/n/a.m4a" },
      { type: "narration", id: "act-1-introduction", script: "y", mode: "bridge", voices: { am_echo: { audio_url: "https://audio.jwlabs.ai/n/b.m4a" } } },
      { type: "segment", segment_id: "s", audio_url: "https://x.test/a.mp3" }
    ];
    const notice = renderedNarrationNotice(stamped);
    expect(notice).toHaveLength(1);
    expect(notice[0]).toMatch(/^2 narration item\(s\) carry rendered audio/);
    expect(notice[0]).toMatch(/RENDERED_NARRATION_ON_PUBLISHED/);
  });
});

describe("GV-81 — the job row serves https audio only (GV-74 review, #1366)", () => {
  const JOB: JobIdentity = { jobId: "job-1", authorId: "founder-1", lane: "on-demand" };
  const prelude = { type: "narration", id: "prelude", script: "This Foray was generated.", mode: "marker" } as const;
  const event: ItemReadyEvent = {
    forayId: ID,
    index: 0,
    itemId: "prelude",
    actIndex: -1,
    check: "prelude",
    servable: true,
    readyAtMs: 10,
    playStartSec: 0,
    durationSec: 3,
    item: prelude as unknown as ItemReadyEvent["item"]
  };
  const progress = progressWithEvent(EMPTY_JOB_PROGRESS, event);
  const rendered = (publicUrl: string) => [{ jobId: "j", itemId: "prelude", status: "rendered" as const, key: "n/p.m4a", publicUrl }];

  it("the schema refuses an http audio_url and accepts https", () => {
    /* MUTATION THAT KILLS THIS: put the schema back to /^https?:\/\// .
       Ran it — red. */
    const ok = snapshotFrom(JOB, progress, 0, AT, { policy: "phone-voice-first", results: rendered("https://audio.jwlabs.ai/n/p.m4a") })!;
    expect(ok.items[0]).toMatchObject({ audio_url: "https://audio.jwlabs.ai/n/p.m4a" });
    expect(ok.lane).toBe("on-demand");
    expect(JobSnapshotSchema.safeParse(ok).success).toBe(true);
    const http = { ...ok, items: [{ ...ok.items[0], audio_url: "http://audio.jwlabs.ai/n/p.m4a" }] };
    expect(JobSnapshotSchema.safeParse(http).success).toBe(false);
  });

  it("a rendered line whose public URL is http is served without it, as phone-voice, and the row stays valid", () => {
    /* MUTATION THAT KILLS THIS: drop the https check in the fold. The item
       carries the http audio_url, the row fails the schema and the sink
       refuses to publish it. Ran it — red. */
    const s = snapshotFrom(JOB, progress, 0, AT, { policy: "await-render", results: rendered("http://audio.jwlabs.ai/n/p.m4a") })!;
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).not.toHaveProperty("audio_url");
    expect(s.itemStates[0]).toEqual({ itemId: "prelude", check: "prelude", audio: "phone-voice" });
    expect(JobSnapshotSchema.safeParse(s).success).toBe(true);
  });
});
