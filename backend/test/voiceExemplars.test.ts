import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* The prompt builder (prompts/actWrite.ts) and the report (generateForays.ts)
   read the founder-selected file from the repository root. The committed
   file is empty until the founder's listen (decision 17), so a flag-on test
   points the mode-gated readers at a tmp root instead: the mock passes every
   export through and only supplies the root when the caller gives none. */
const testRoot = vi.hoisted(() => ({ current: undefined as string | undefined }));
vi.mock("../src/generation/voiceExemplars", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/generation/voiceExemplars")>();
  return {
    ...actual,
    writerVoiceExemplars: (source?: Record<string, string | undefined>, root?: string) => actual.writerVoiceExemplars(source, root ?? testRoot.current),
    writerExemplarsLever: (source?: Record<string, string | undefined>, root?: string) => actual.writerExemplarsLever(source, root ?? testRoot.current)
  };
});

import {
  VOICE_BLOCK_END,
  VOICE_EXEMPLARS_REL,
  VoiceExemplarsFileSchema,
  WRITER_EXEMPLARS_ENV,
  clearVoiceExemplarsCache,
  exemplarProvenance,
  loadVoiceExemplars,
  voicePrefixBlock,
  withExemplarPrefix,
  writerExemplarsLever,
  writerExemplarsMode,
  writerVoiceExemplars,
  type VoiceExemplarsFile
} from "../src/generation/voiceExemplars";
import { FlagValueError } from "../src/generation/generationFlags";
import { actWritePromptParts, buildActWritePrompt, seamEditPromptParts } from "../src/generation/prompts/actWrite";
import { ISO_TIMESTAMP_RE, joinParts, type PromptParts } from "../src/generation/promptLayout";
import type { ActWriteRequest, ActWriteResult, NarrationBuildContext, SeamEditRequest } from "../src/generation/NarrationWriterBuilder";
import { writeNarration } from "../src/generation/writeNarration";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import type { EvidenceBeat, EvidenceDoc, EvidenceGatherer, EvidencePack } from "../src/generation/gatherEvidence";
import type { SourcedAct } from "../src/types/tapeSourcing";
import type { Voice } from "../src/types/spine";
import { DEFAULT_MAX_RESUMES, generateOneCandidate, type CliArgs } from "../src/cli/generateForays";
import { FileTranscriptCueProvider } from "../src/generation/transcriptArchiveLookup";

/**
 * GV-99 (docs/roadmap/generation-v2.md, #1286; from W7-06, covers R2-17): the
 * founder-selected voice card and exemplar seams in the Qwen writer's cached
 * static prefix, behind FORAY_WRITER_EXEMPLARS (default off). Offline: tmp
 * roots, hand-built requests, the stub writer and verifier, and a scripted
 * pipeline for the report row. Each test names the mutation that turns it
 * red; every one was run.
 */

const VOICE_CARD = "Plain words, one idea a sentence. Talk to one listener, a well-read friend in the passenger seat. Let the tape carry the drama; the narration only points.";
const EXEMPLAR_A = "It held for a year. Then the hotel threw a party, and the walkways filled with people watching the dancers below.";
const EXEMPLAR_B = "Which leaves the question the engineers never put on paper: who checks the change after the drawing leaves the office?";

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

function selectedFile(overrides: Partial<VoiceExemplarsFile> = {}): VoiceExemplarsFile {
  return {
    version: 1,
    voiceCard: { text: VOICE_CARD, words: wordCount(VOICE_CARD) },
    exemplars: [
      {
        role: "act-introduction",
        text: EXEMPLAR_A,
        forayId: "the-hyatt-walkway-ab12cd34",
        itemIds: ["act-0-introduction"],
        sourceKind: "candidate",
        provenance: "qwen-pipeline",
        selectedBy: "Wyatt",
        listenedOn: "2026-10-18"
      },
      {
        role: "bridge",
        text: EXEMPLAR_B,
        forayId: "who-signed-off-ef56ab78",
        itemIds: ["n-3", "n-4"],
        sourceKind: "committed",
        provenance: "claude-pipeline-historic",
        selectedBy: "Wyatt",
        listenedOn: "2026-10-18"
      }
    ],
    ...overrides
  };
}

const roots: string[] = [];
function rootWith(content: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "gv99-"));
  roots.push(root);
  if (content !== null) {
    const file = join(root, VOICE_EXEMPLARS_REL);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

beforeEach(() => {
  clearVoiceExemplarsCache();
  testRoot.current = undefined;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  testRoot.current = undefined;
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/* ------------------------------------------------------------ requests */

const voiceA: Voice = { style: "plain and curious", register: "a well-read friend", sentenceRhythm: "short, then long", narratorPresence: "light" };
const voiceB: Voice = { style: "dry, exact", register: "an engineer explaining", sentenceRhythm: "even", narratorPresence: "first person, sparing" };

/** Act `i` of a Foray: its own title, seams, clip, documents and (after act 0) frame. */
function actRequest(foray: "A" | "B", i: number): ActWriteRequest {
  const tag = `${foray}${i}`;
  return {
    voice: foray === "A" ? voiceA : voiceB,
    actTitle: `Act ${i} of Foray ${foray}: the ${tag} turn`,
    seams: [
      { seamId: "s0", beats: [{ beatId: `b${i}`, claim: `Claim ${tag} the documents carry.`, mode: "Patch", kind: "account" }], introduces: "c0", intro: "full", band: [200, 600] },
      { seamId: "s1", beats: [], follows: "c0", band: [0, 300] }
    ],
    clips: [
      { clipId: "c0", segmentId: `seg-${tag}`, itemId: `item-${tag}`, show: `Show ${foray}`, title: `Episode ${tag}`, docId: `tape:seg-${tag}`, opening: `The opening of ${tag}.`, durationSec: 90, intro: "full" }
    ],
    documents: [{ docId: `d-${tag}`, kind: "print", title: `Report ${tag}`, url: `https://example.org/${tag}`, text: `The report ${tag} says the connection carried double the load.` }],
    ...(i > 0
      ? { frame: { actIntroduction: `Then ${tag}.`, actExit: `And so ${tag}.`, previousActExit: "That was before.", startState: "knows the start", endState: "knows the end", actIndex: i, totalActs: 4 } }
      : {})
  };
}

/** Round 2 of an act, as writeAct.ts sends it: previous scripts, FROZEN/EDIT, a retry note. */
function round2(request: ActWriteRequest): ActWriteRequest {
  return {
    ...request,
    retryNote: "Attempt 1 was rejected for: the prose does not carry the beat.",
    seams: request.seams.map((s, i) => (i === 0 ? { ...s, previousScript: "Round 1's draft.", notes: "carry the beat" } : { ...s, previousScript: "Verified.", frozen: true }))
  };
}

function editRequest(request: ActWriteRequest): SeamEditRequest {
  const [s0, s1] = request.seams;
  return {
    voice: request.voice,
    actTitle: request.actTitle,
    seams: [{ ...s0!, previousScript: "Round 1's draft.", notes: "carry the beat" }],
    neighbours: [{ seamId: s1!.seamId, script: "Verified." }],
    clips: request.clips,
    documents: request.documents,
    retryNote: "Attempt 1 was rejected for: the prose does not carry the beat."
  };
}

/* ------------------------------------------------------------ the module */

describe("GV-99: the exemplar file, the flag and the block", () => {
  it("the schema accepts the selector's file and refuses an over-long or miscounted card, a third exemplar, an unselected or undated exemplar and an unknown role", () => {
    /* MUTATION THAT KILLS THIS: make `selectedBy` optional, or drop the
       listenedOn regex, or `.max(MAX_EXEMPLARS)`, from the schema. Ran each:
       red. */
    expect(VoiceExemplarsFileSchema.safeParse(selectedFile()).success).toBe(true);
    expect(VoiceExemplarsFileSchema.safeParse({ version: 1, voiceCard: null, exemplars: [] }).success).toBe(true);
    const long = Array.from({ length: 61 }, (_, i) => `w${i}`).join(" ");
    const refused: unknown[] = [
      selectedFile({ voiceCard: { text: long, words: 61 } }),
      selectedFile({ voiceCard: { text: VOICE_CARD, words: 3 } }),
      selectedFile({ exemplars: [...selectedFile().exemplars, selectedFile().exemplars[0]!] }),
      { ...selectedFile(), exemplars: [{ ...selectedFile().exemplars[0]!, selectedBy: undefined }] },
      { ...selectedFile(), exemplars: [{ ...selectedFile().exemplars[0]!, selectedBy: "  " }] },
      { ...selectedFile(), exemplars: [{ ...selectedFile().exemplars[0]!, listenedOn: undefined }] },
      { ...selectedFile(), exemplars: [{ ...selectedFile().exemplars[0]!, listenedOn: "18 Oct 2026" }] },
      { ...selectedFile(), exemplars: [{ ...selectedFile().exemplars[0]!, role: "opening" }] },
      { ...selectedFile(), version: 2 }
    ];
    for (const file of refused) expect(VoiceExemplarsFileSchema.safeParse(file).success, JSON.stringify(file).slice(0, 120)).toBe(false);
  });

  it("the loader reads once per root, hashes the bytes with LF line endings, and returns null (warning once) for a missing, non-JSON, empty, invalid or unselected file", () => {
    /* MUTATION THAT KILLS THIS: return the parsed file for an empty one
       (voiceCard null, no exemplars), or drop the cache (the rewritten
       file is read again), or hash the raw CRLF bytes. Ran each: red. */
    const warn = vi.mocked(console.warn);
    const text = json(selectedFile());
    const root = rootWith(text);
    const loaded = loadVoiceExemplars(root);
    expect(loaded?.file).toEqual(selectedFile());
    expect(loaded?.fileSha).toBe(createHash("sha256").update(text).digest("hex"));
    writeFileSync(join(root, VOICE_EXEMPLARS_REL), json({ version: 1, voiceCard: null, exemplars: [] }));
    expect(loadVoiceExemplars(root)).toBe(loaded);
    expect(loadVoiceExemplars(rootWith(text.replace(/\n/g, "\r\n")))?.fileSha).toBe(loaded?.fileSha);

    const unselected = { ...selectedFile(), exemplars: [{ ...selectedFile().exemplars[0]!, selectedBy: undefined, listenedOn: undefined }] };
    const nulls = [rootWith(null), rootWith("{ not json"), rootWith(json({ version: 1, voiceCard: null, exemplars: [] })), rootWith(json({ version: 1 })), rootWith(json(unselected))];
    for (const r of nulls) expect(loadVoiceExemplars(r)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(nulls.length);
    for (const r of nulls) expect(loadVoiceExemplars(r)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(nulls.length);
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual(nulls.map(() => expect.stringContaining("the writer's voice slot stays empty")));
  });

  it("FORAY_WRITER_EXEMPLARS is off by default, on or off when set, and a malformed value throws naming only the variable; off never reads the file", () => {
    /* MUTATION THAT KILLS THIS: default to 'on', or read the file whatever
       the mode in writerVoiceExemplars / writerExemplarsLever. Ran both:
       red. */
    expect(writerExemplarsMode({})).toBe("off");
    expect(writerExemplarsMode({ [WRITER_EXEMPLARS_ENV]: "on" })).toBe("on");
    expect(writerExemplarsMode({ [WRITER_EXEMPLARS_ENV]: " off " })).toBe("off");
    for (const bad of ["1", "true", "ON", ""]) {
      let error: unknown;
      try {
        writerExemplarsMode({ [WRITER_EXEMPLARS_ENV]: bad });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(FlagValueError);
      expect((error as Error).message).toContain(WRITER_EXEMPLARS_ENV);
      if (bad.length > 0) expect((error as Error).message).not.toContain(`"${bad}"`);
    }
    const root = rootWith(json(selectedFile()));
    expect(writerVoiceExemplars({}, root)).toBeNull();
    expect(writerExemplarsLever({}, root)).toBeUndefined();
    expect(writerExemplarsLever({ [WRITER_EXEMPLARS_ENV]: "off" }, root)).toBeUndefined();
    expect(writerVoiceExemplars({ [WRITER_EXEMPLARS_ENV]: "on" }, root)?.file).toEqual(selectedFile());
  });

  it("the block is the card, the seams heading and each exemplar with its role, then the fixed end line, and carries no id, date, selector or timestamp", () => {
    /* MUTATION THAT KILLS THIS: print an exemplar's forayId in the block,
       or drop the end line. Ran both: red. */
    const block = voicePrefixBlock(selectedFile());
    expect(block).toBe(
      [
        "VOICE CARD",
        VOICE_CARD,
        "",
        "TWO SEAMS IN THIS VOICE (style only - never quote them, never reuse their facts)",
        `1 (act-introduction): ${EXEMPLAR_A}`,
        `2 (bridge): ${EXEMPLAR_B}`,
        "",
        VOICE_BLOCK_END
      ].join("\n")
    );
    for (const absent of ["the-hyatt-walkway-ab12cd34", "who-signed-off", "act-0-introduction", "n-3", "Wyatt", "2026-10-18", "qwen-pipeline", "candidate"]) expect(block).not.toContain(absent);
    expect(ISO_TIMESTAMP_RE.test(block)).toBe(false);
    const one = voicePrefixBlock(selectedFile({ voiceCard: null, exemplars: [selectedFile().exemplars[1]!] }));
    expect(one).toBe(["ONE SEAM IN THIS VOICE (style only - never quote it, never reuse its facts)", `1 (bridge): ${EXEMPLAR_B}`, "", VOICE_BLOCK_END].join("\n"));
  });

  it("withExemplarPrefix appends the block to the end of stable only, the same bytes whatever foray and call parts it is given; null leaves the parts untouched", () => {
    /* MUTATION THAT KILLS THIS: append the block to `foray` instead of
       `stable`. Ran it: red. */
    const loaded = { file: selectedFile(), fileSha: "sha" };
    const parts = (foray: string, call: string): PromptParts => ({ stable: "RULES\nmore rules", foray, call });
    const a = withExemplarPrefix(parts("voice A", "act 0 call"), loaded);
    const b = withExemplarPrefix(parts("voice B", "act 3 call, round 2"), loaded);
    expect(a.stable).toBe(`RULES\nmore rules\n\n${voicePrefixBlock(selectedFile())}`);
    expect(b.stable).toBe(a.stable);
    expect([a.foray, a.call, b.foray, b.call]).toEqual(["voice A", "act 0 call", "voice B", "act 3 call, round 2"]);
    const plain = parts("f", "c");
    expect(withExemplarPrefix(plain, null)).toBe(plain);
    expect(exemplarProvenance(null)).toEqual({ mode: "unavailable", exemplarIds: [], fileSha: null });
    expect(exemplarProvenance(loaded)).toEqual({ mode: "on", exemplarIds: ["the-hyatt-walkway-ab12cd34:act-0-introduction", "who-signed-off-ef56ab78:n-3"], fileSha: "sha" });
  });
});

/* ------------------------------------------------------------ the call site */

describe("GV-99: the Qwen writer's prompt (prompts/actWrite.ts)", () => {
  const requests = (): ActWriteRequest[] => [actRequest("A", 0), actRequest("A", 3), round2(actRequest("A", 0)), round2(actRequest("A", 3)), actRequest("B", 0), round2(actRequest("B", 3))];

  it("flag off, or on with an empty, unselected or missing file: every writer prompt is byte-identical to the prompt without this card", () => {
    /* MUTATION THAT KILLS THIS: accept an empty file in the loader, or
       ignore the mode in `voiced` (always read as 'on'). Ran both: red. */
    const without = (req: ActWriteRequest, output?: "jsonl") => actWritePromptParts(req, { output, voiceBlock: "" });
    const unselected = { ...selectedFile(), exemplars: [{ ...selectedFile().exemplars[0]!, selectedBy: undefined }], voiceCard: null };
    const cases: Array<[string | undefined, string | undefined]> = [
      [undefined, rootWith(json(selectedFile()))],
      ["off", rootWith(json(selectedFile()))],
      ["on", rootWith(json({ version: 1, voiceCard: null, exemplars: [] }))],
      ["on", rootWith(json(unselected))],
      ["on", rootWith(null)],
      /* The committed file itself (the repository root): still empty. */
      ["on", undefined]
    ];
    for (const [mode, root] of cases) {
      clearVoiceExemplarsCache();
      vi.unstubAllEnvs();
      if (mode !== undefined) vi.stubEnv(WRITER_EXEMPLARS_ENV, mode);
      testRoot.current = root;
      for (const req of requests()) {
        expect(actWritePromptParts(req)).toEqual(without(req));
        expect(actWritePromptParts(req, { output: "jsonl" })).toEqual(without(req, "jsonl"));
        expect(seamEditPromptParts(editRequest(req), { output: "jsonl" })).toEqual(seamEditPromptParts(editRequest(req), { output: "jsonl", voiceBlock: "" }));
      }
    }
  });

  it("flag on: the block ends `stable`, byte-identical for act 0 and act 3, round 1 and round 2, two Forays and the seam edit, with no Foray id, act title or timestamp; foray and call are unchanged", () => {
    /* MUTATION THAT KILLS THIS: drop the `voiced(...)` wrapper from
       actWritePromptParts, or from seamEditPromptParts -- no block. Ran
       both: red. */
    vi.stubEnv(WRITER_EXEMPLARS_ENV, "on");
    testRoot.current = rootWith(json(selectedFile()));
    const block = voicePrefixBlock(selectedFile());
    const stables = new Set<string>();
    for (const req of requests()) {
      const voiced = actWritePromptParts(req);
      const plain = actWritePromptParts(req, { voiceBlock: "" });
      expect(voiced.stable).toBe(`${plain.stable}\n\n${block}`);
      expect(voiced.foray).toBe(plain.foray);
      expect(voiced.call).toBe(plain.call);
      expect(voiced.stable).not.toContain(req.actTitle);
      stables.add(voiced.stable);
      expect(seamEditPromptParts(editRequest(req)).stable).toBe(voiced.stable);
    }
    expect(stables.size).toBe(1);
    const [stable] = [...stables];
    expect(ISO_TIMESTAMP_RE.test(stable!)).toBe(false);
    for (const id of ["Foray A", "Foray B", "seg-A", "d-A0", "item-B3"]) expect(stable).not.toContain(id);
    /* The jsonl contract's stable carries the same block. */
    expect(actWritePromptParts(actRequest("A", 3), { output: "jsonl" }).stable.endsWith(`\n\n${block}`)).toBe(true);
  });

  it("flag on: the Anthropic writer's single-string prompt never carries the block, and an explicit voiceBlock wins", () => {
    /* MUTATION THAT KILLS THIS: let buildActWritePrompt pass no options
       (it would read the flag like the Qwen writer). Ran it: red. */
    const req = actRequest("A", 3);
    const before = buildActWritePrompt(req);
    vi.stubEnv(WRITER_EXEMPLARS_ENV, "on");
    testRoot.current = rootWith(json(selectedFile()));
    expect(buildActWritePrompt(req)).toBe(before);
    expect(buildActWritePrompt(req)).not.toContain("VOICE CARD");
    expect(joinParts(actWritePromptParts(req))).toContain("VOICE CARD");
    expect(actWritePromptParts(req, { voiceBlock: "MINE" }).stable.endsWith("\n\nMINE")).toBe(true);
    vi.stubEnv(WRITER_EXEMPLARS_ENV, "yes");
    expect(() => actWritePromptParts(req)).toThrow(FlagValueError);
  });
});

/* ------------------------------------------------------------ the quote gate */

const NBS: EvidenceDoc = {
  docId: "print:nbs-143",
  kind: "print",
  title: "National Bureau of Standards, Building Science Series 143 (1982)",
  url: "https://nvlpubs.nist.gov/nistpubs/Legacy/BSS/nbsbuildingscience143.pdf",
  text:
    "The box beam-hanger rod connections were not checked for adequacy at any stage of the design. " +
    "The as-built connection could support about sixty percent of the load required by the Kansas City Building Code. " +
    "Investigators traced the change to a shop drawing produced by the fabricator and approved without calculation."
};

const narration = (claim: string) => ({ sourcing: "narration" as const, claim, exploration: false, narration: { mode: "Patch" as const, reason: "t" } });

function twoBeatAct(): SourcedAct {
  return {
    title: "Act 1: The connection",
    slots: [{ title: "Opening", beats: [narration("The connection was never checked for adequacy at any stage."), narration("Investigators traced the change to a fabricator's shop drawing.")] }]
  };
}

const printGatherer: EvidenceGatherer = {
  async gather(beat: EvidenceBeat): Promise<EvidencePack> {
    return { purpose: beat.claim, beatKind: "account", docs: [NBS] };
  }
};

describe("GV-99: an exemplar is style, never a source", () => {
  it("a quote copied from exemplar text is refused by the existing quote gate (the exemplars are not in request.documents), whatever docId it cites", async () => {
    /* MUTATION THAT KILLS THIS: skip the verbatim-span check in
       gateSelectedClaims (writeNarration.ts) -- the copied quote is kept and
       the retry note never names it. Ran it: red. */
    vi.stubEnv(WRITER_EXEMPLARS_ENV, "on");
    testRoot.current = rootWith(json(selectedFile()));
    const copied = EXEMPLAR_B;
    const writer = new StubNarrationWriterBuilder();
    const verifier = new StubNarrationVerifierBuilder();
    const seen: ActWriteRequest[] = [];
    const realWrite = writer.writeAct.bind(writer);
    writer.writeAct = async (request, ctx) => {
      seen.push(request);
      const reply: ActWriteResult = await realWrite(request, ctx);
      if (seen.length > 1) return reply;
      /* Round 1: the writer lifts a whole exemplar sentence as a quote, once
         citing the act's real document and once a made-up exemplar doc. */
      return {
        seams: reply.seams.map((s, i) =>
          i === 0
            ? {
                ...s,
                claims: [
                  ...s.claims,
                  { claimText: "The engineers never put the check on paper.", quote: copied, docId: NBS.docId, contested: false },
                  { claimText: "The hotel threw a party.", quote: EXEMPLAR_A, docId: "exemplar-1", contested: false }
                ]
              }
            : s
        )
      };
    };
    const ctx: NarrationBuildContext = { userId: "founder-1" };
    const voice: Voice = { style: "well-read friend", register: "conversational", sentenceRhythm: "varied", narratorPresence: "medium" };
    await writeNarration([twoBeatAct()], { writer, verifier, evidence: printGatherer }, voice, ctx);

    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const request of seen) {
      for (const doc of request.documents) {
        expect(doc.text).not.toContain(copied);
        expect(doc.text).not.toContain(EXEMPLAR_A);
      }
      expect(request.documents.some((d) => d.docId === "exemplar-1")).toBe(false);
    }
    expect(seen[1]!.retryNote).toContain("the quote is not a verbatim span of any document provided");
    expect(seen[1]!.retryNote).toContain('cites docId "exemplar-1", which is not one of the documents provided');
    /* The prompt the Qwen writer would have sent for that act carried the
       exemplar, in `stable` only. */
    const parts = actWritePromptParts(seen[0]!);
    expect(parts.stable).toContain(copied);
    expect(parts.call).not.toContain(copied);
  });
});

/* ------------------------------------------------------------ the report */

describe("GV-99: report.json rows carry levers.exemplars", () => {
  function cliArgs(out: string): CliArgs {
    return {
      prompts: null,
      out,
      duration: "short",
      limit: null,
      dryRun: true,
      authorId: "founder-1",
      budgetUsd: null,
      noResume: true,
      maxResumes: DEFAULT_MAX_RESUMES,
      continueOnRefusedPartial: false,
      notify: null
    };
  }

  async function rowLevers(): Promise<unknown> {
    const dir = mkdtempSync(join(tmpdir(), "gv99-report-"));
    roots.push(dir);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await generateOneCandidate({ prompt: "How the Hyatt walkways fell", topic: "engineering/failures" }, { ...cliArgs(dir), maxResumes: 0 }, {
      cueProvider: new FileTranscriptCueProvider(),
      /* A scripted pipeline: it fails at once, so the row is written
         without a model, a network or a corpus. */
      runPipeline: async () => {
        throw new Error("scripted failure");
      }
    });
    expect(result.skipped).toBe(false);
    return result.skipped ? undefined : result.entry?.levers;
  }

  it("flag on: the row records mode, the selected exemplar ids and the file's sha; on with the empty file: 'unavailable'; off: no exemplars key", async () => {
    /* MUTATION THAT KILLS THIS: leave `exemplars` out of `levers` in
       generateForays.ts. Ran it: red. */
    const text = json(selectedFile());
    testRoot.current = rootWith(text);
    vi.stubEnv(WRITER_EXEMPLARS_ENV, "on");
    expect(await rowLevers()).toEqual({
      exemplars: { mode: "on", exemplarIds: ["the-hyatt-walkway-ab12cd34:act-0-introduction", "who-signed-off-ef56ab78:n-3"], fileSha: createHash("sha256").update(text).digest("hex") }
    });
    clearVoiceExemplarsCache();
    testRoot.current = rootWith(json({ version: 1, voiceCard: null, exemplars: [] }));
    expect(await rowLevers()).toEqual({ exemplars: { mode: "unavailable", exemplarIds: [], fileSha: null } });
    vi.stubEnv(WRITER_EXEMPLARS_ENV, "off");
    expect(await rowLevers()).toEqual({});
    vi.unstubAllEnvs();
    expect(await rowLevers()).toEqual({});
  }, 60_000);
});
