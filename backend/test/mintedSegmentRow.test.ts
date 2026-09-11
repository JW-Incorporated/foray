import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generationBatchId, mintedSegmentRow } from "../src/generation/finalizeForay";
import { foldToAscii, mintedWhyErrors, whyFromClaim } from "../src/generation/mintedSegmentCopy";
import { FileTranscriptCueProvider } from "../src/generation/transcriptArchiveLookup";
import type { NewSegment } from "../src/types/tapeSourcing";

/**
 * F-78 (FD-07): a minted tier-2 row passes THE POOL GATE — `tools/segments/
 * merge-segments.mjs --check`, the CI check on `data/segments.json` — with no
 * hand-typed fields. The first generated Foray's ten rows were missing `why`,
 * `transcript_source`, `dai_suspected` and `batch_id`, and a person filled them
 * in to get PR #583 green.
 *
 * THE CHECK IS THE REAL CHECKER, RUN AS CI RUNS IT. Vitest cannot `import()` the
 * `.mjs` checkers on a checkout path containing a space (see
 * `RunPipelineDeps.finalize`), so the row is written to a temp `segments.json`
 * and `node tools/segments/merge-segments.mjs --check <file>` is spawned — the
 * exact command `ci.yml` runs — with `TAXONOMY_PATH` pointed at a one-node
 * taxonomy. Exit code and stderr are the oracle, not a reimplementation.
 *
 * MUTATIONS, ONE PER FIELD, each named for the field it kills:
 *   - drop `why`                         → "why: missing"
 *   - 19-word `why`                      → "words > 18"
 *   - banned phrase in `why`             → "banned phrase"
 *   - `transcript_source: "whisper"`     → "bad transcript_source"
 *   - `dai_suspected: "yes"` / missing   → "dai_suspected must be boolean"
 *   - drop `batch_id`                    → "batch_id is required"
 * Each mutation is applied to the row `mintedSegmentRow` produced, so a change
 * to the row builder that drops or mistypes a field turns the un-mutated case
 * red and the mutation cases stay green — exactly the failure F-78 was.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CHECKER = path.join(REPO_ROOT, "tools", "segments", "merge-segments.mjs");

const segment: NewSegment = {
  id: "practical-ai--building-durable-ai-agents#1552",
  itemId: "practical-ai--building-durable-ai-agents",
  startSec: 1551.865,
  endSec: 1586.415,
  referenceDurationSec: 2799,
  startAnchor: "lets say you picked something probably you have",
  endAnchor: "quick requests restful that just you know execute",
  confidence: "medium",
  why: whyFromClaim("Agent work is not a millisecond REST request, so the kick-off call blows past its timeout."),
  transcriptSource: "publisher"
};
const TOPIC = "engineering/ai-robotics";
const FORAY_ID = "beyond-the-algorithm-e6533b";
const sources = [{ id: segment.itemId, dai_suspected: true }];

function runChecker(rows: unknown[], dir: string): { ok: boolean; output: string } {
  const segmentsPath = path.join(dir, "segments.json");
  const taxonomyPath = path.join(dir, "taxonomy.json");
  fs.writeFileSync(segmentsPath, JSON.stringify({ version: 1, segments: rows }, null, 2));
  fs.writeFileSync(taxonomyPath, JSON.stringify({ nodes: [{ id: TOPIC }] }));
  try {
    const out = execFileSync(process.execPath, [CHECKER, "--check", segmentsPath], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, TAXONOMY_PATH: taxonomyPath },
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { ok: true, output: out };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { ok: false, output: `${err.stdout ?? ""}\n${err.stderr ?? ""}` };
  }
}

describe("mintedSegmentRow vs the pool gate (merge-segments.mjs --check)", () => {
  let dir = "";
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-fd07-"));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const row = () => mintedSegmentRow(segment, TOPIC, { batchId: generationBatchId(FORAY_ID), sources });

  it("carries every field the gate requires, from the mint, the source verdict and the Foray id", () => {
    expect(row()).toMatchObject({
      why: "Agent work is not a millisecond REST request, so the kick-off call blows past its timeout.",
      transcript_source: "publisher",
      dai_suspected: true,
      batch_id: "generation-beyond-the-algorithm-e6533b",
      source: "generation-tier-2",
      needs_review: true
    });
  });

  it("passes the real checker unmodified", () => {
    const result = runChecker([row()], dir);
    expect(result.output).toMatch(/ok .*1 segment/);
    expect(result.ok).toBe(true);
  });

  const mutations: Array<[field: string, mutate: (r: Record<string, unknown>) => void, expectedError: RegExp]> = [
    ["why (dropped)", (r) => delete r.why, /why: missing/],
    [
      "why (19 words)",
      (r) => (r.why = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen"),
      /why: 19 words > 18/
    ],
    ["why (banned phrase)", (r) => (r.why = "A deep dive into agent timeouts."), /why: banned phrase/],
    ["transcript_source (not in the vocabulary)", (r) => (r.transcript_source = "whisper"), /bad transcript_source/],
    ["transcript_source (dropped)", (r) => delete r.transcript_source, /bad transcript_source/],
    ["dai_suspected (a string)", (r) => (r.dai_suspected = "yes"), /dai_suspected must be boolean/],
    ["dai_suspected (dropped)", (r) => delete r.dai_suspected, /dai_suspected must be boolean/],
    ["batch_id (dropped)", (r) => delete r.batch_id, /batch_id is required/]
  ];

  for (const [field, mutate, expectedError] of mutations) {
    it(`is refused by the checker when ${field}`, () => {
      const mutated = row();
      mutate(mutated);
      const result = runChecker([mutated], dir);
      expect(result.ok).toBe(false);
      expect(result.output).toMatch(expectedError);
    });
  }
});

describe("mintedSegmentRow refuses what the gate would refuse, before anything is written", () => {
  const ctx = { batchId: generationBatchId(FORAY_ID), sources };

  it("never defaults dai_suspected: no source row for the item is an error, not false", () => {
    expect(() => mintedSegmentRow(segment, TOPIC, { ...ctx, sources: [] })).toThrow(/dai_suspected/);
    expect(() => mintedSegmentRow(segment, TOPIC, { ...ctx, sources: [{ id: segment.itemId, dai_suspected: undefined as unknown as boolean }] })).toThrow(
      /dai_suspected/
    );
  });

  it("reads the verdict from the row for THIS item, not the first row", () => {
    const other = { id: "some-other-episode", dai_suspected: true };
    const mine = { id: segment.itemId, dai_suspected: false };
    expect(mintedSegmentRow(segment, TOPIC, { ...ctx, sources: [other, mine] }).dai_suspected).toBe(false);
  });

  it("refuses a why the copy rules would refuse", () => {
    const banned: NewSegment = { ...segment, why: "You won't believe how agents time out." };
    expect(() => mintedSegmentRow(banned, TOPIC, ctx)).toThrow(/banned phrase/);
    const long: NewSegment = { ...segment, why: Array.from({ length: 19 }, (_, i) => `w${i}`).join(" ") };
    expect(() => mintedSegmentRow(long, TOPIC, ctx)).toThrow(/19 words > 18/);
  });

  it("refuses an empty batch_id", () => {
    expect(() => mintedSegmentRow(segment, TOPIC, { ...ctx, batchId: " " })).toThrow(/batch_id/);
  });
});

describe("whyFromClaim — the beat's claim, clamped to the pool's note", () => {
  it("keeps a claim of 18 words or fewer verbatim (ASCII already)", () => {
    const claim = "Agent work is not a millisecond REST request, so the kick-off call blows past its timeout.";
    expect(whyFromClaim(claim)).toBe(claim);
    expect(mintedWhyErrors("t", whyFromClaim(claim))).toEqual([]);
  });

  it("clamps at a word boundary to 18 words and drops the dangling separator", () => {
    const claim =
      "CoreWeave built straggler detection because across thousands of GPUs the only symptom of one bad node is the whole job slowing, which nobody notices for hours.";
    const why = whyFromClaim(claim);
    expect(why.split(" ")).toHaveLength(18);
    expect(why).toBe("CoreWeave built straggler detection because across thousands of GPUs the only symptom of one bad node is the");
    expect(claim.startsWith(why)).toBe(true); // a prefix, never a rewrite
    expect(mintedWhyErrors("t", why)).toEqual([]);
  });

  it("drops a trailing comma left at the cut rather than ending a note on it", () => {
    const eighteen = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen,";
    expect(whyFromClaim(`${eighteen} nineteen twenty`)).toBe(eighteen.slice(0, -1));
  });

  it("folds punctuation to ASCII: curly quotes, dashes, ellipsis, non-breaking spaces", () => {
    expect(foldToAscii("“Agents” don’t finish — they time out… slowly")).toBe('"Agents" don\'t finish - they time out... slowly');
    expect(whyFromClaim("The call blows past its timeout")).toBe("The call blows past its timeout");
  });

  it("swaps the four banned words a factual claim could contain, one word for one word, keeping case", () => {
    expect(whyFromClaim("Researchers explore why agents fail.")).toBe("Researchers cover why agents fail.");
    expect(whyFromClaim("Explores the fascinating delve into a deep dive.")).toBe("Covers the striking go into a close look.");
    expect(mintedWhyErrors("t", whyFromClaim("Explores the fascinating delve into a deep-dive."))).toEqual([]);
  });

  it("does not rewrite a marketing phrase — mintedWhyErrors refuses it instead", () => {
    const why = whyFromClaim("You won't believe what fits your drive.");
    expect(mintedWhyErrors("t", why).join("\n")).toMatch(/banned phrase/);
  });

  it("reports exactly the gate's copy errors", () => {
    expect(mintedWhyErrors("row", "")).toEqual(["row: why: missing"]);
    expect(mintedWhyErrors("row", undefined)).toEqual(["row: why: missing"]);
    expect(mintedWhyErrors("row", Array.from({ length: 19 }, () => "w").join(" "))).toEqual(["row: why: 19 words > 18"]);
  });
});

describe("FileTranscriptCueProvider.transcriptSource — provenance from the body the anchors were cut from", () => {
  let root = "";
  const entry = (guid: string) => ({ show_id: "show-a", show_title: "Show A", guid, title: "Ep", cues: 1 });

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "foray-fd07-bodies-"));
    const dir = path.join(root, "show-a-1234abcd");
    fs.mkdirSync(dir);
    const cues = [{ start_sec: 0, end_sec: 1, text: "hello there" }];
    fs.writeFileSync(path.join(dir, "fetched-1.json"), JSON.stringify({ show_id: "show-a", guid: "fetched", source_url: "https://pub.example/t.vtt", cues }));
    fs.writeFileSync(
      path.join(dir, "regenerated-1.json"),
      JSON.stringify({ show_id: "show-a", guid: "regenerated", source_url: null, regenerated_from: "raw/show-a-1234abcd/regenerated-1.srt", cues })
    );
    fs.writeFileSync(path.join(dir, "local-1.json"), JSON.stringify({ show_id: "show-a", guid: "local", cues }));
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("says publisher for a body fetched from the publisher's transcript URL", () => {
    expect(new FileTranscriptCueProvider(root).transcriptSource(entry("fetched"))).toBe("publisher");
  });

  it("says publisher for a body regenerated from the archive's raw publisher file", () => {
    expect(new FileTranscriptCueProvider(root).transcriptSource(entry("regenerated"))).toBe("publisher");
  });

  it("says asr-local for a body with no publisher provenance", () => {
    expect(new FileTranscriptCueProvider(root).transcriptSource(entry("local"))).toBe("asr-local");
  });

  it("says null when there is no body, the same answer as getCues", () => {
    const provider = new FileTranscriptCueProvider(root);
    expect(provider.transcriptSource(entry("missing"))).toBeNull();
    expect(provider.getCues(entry("missing"))).toBeNull();
  });
});
