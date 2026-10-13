import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { actWritePromptParts, buildActWritePrompt, type ActWriteOutput } from "../src/generation/prompts/actWrite";
import { actVerifyPromptParts } from "../src/generation/prompts/actVerify";
import { joinParts } from "../src/generation/promptLayout";
import { WRITTEN_SEAM_JSON_SCHEMA } from "../src/generation/seamStream";
import type { ActWriteRequest, ClipBrief, SeamBrief } from "../src/generation/NarrationWriterBuilder";
import type { ActVerifyRequest } from "../src/generation/NarrationVerifierBuilder";
import type { EvidenceDoc } from "../src/generation/gatherEvidence";
import type { Voice } from "../src/types/spine";

/**
 * GV-50 (docs/roadmap/generation-v2.md, #1286; from W4-11 + W2-14, covers
 * R2-08, GP-05, R1-10): the act writer's and verifier's prompts as
 * [stable][foray][call] (promptLayout.ts), so the 9-11k-token writer prompt
 * opens with the same bytes for every act, round and Foray and SGLang's radix
 * cache reuses them; the 'jsonl' contract the streamed Chat writer (GV-84)
 * asks for; and the (empty) voice slot GV-99 fills. Offline: pure prompt
 * builders and hand-built requests. Each test names the mutation that turns
 * it red; every one was run.
 */

const voiceA: Voice = { style: "plain and curious", register: "a well-read friend", sentenceRhythm: "short, then long", narratorPresence: "light" };
const voiceB: Voice = { style: "dry, exact", register: "an engineer explaining", sentenceRhythm: "even", narratorPresence: "first person, sparing" };

const printDoc = (docId: string, title: string, text: string): EvidenceDoc => ({ docId, kind: "print", title, url: `https://example.org/${docId}`, text });
const tapeDoc = (docId: string, title: string, text: string): EvidenceDoc => ({ docId, kind: "tape", title, text });

const clip = (clipId: string, show: string, title: string, docId: string, opening: string): ClipBrief => ({
  clipId,
  segmentId: `seg-${clipId}-${show.length}`,
  itemId: `item-${clipId}-${title.length}`,
  show,
  title,
  docId,
  opening,
  durationSec: 95,
  intro: "full"
});

/** One Foray: its voice, and per act its title, seams, clips and documents. */
interface ForayFixture {
  voice: Voice;
  acts: Array<Omit<ActWriteRequest, "voice">>;
}

const forayA: ForayFixture = {
  voice: voiceA,
  acts: [
    {
      actTitle: "The walkway",
      seams: [
        { seamId: "s0", beats: [{ beatId: "b0", claim: "The hotel opened in a hurry.", mode: "Patch", kind: "account" }], introduces: "c0", intro: "full", band: [200, 600] },
        { seamId: "s1", beats: [{ beatId: "b1", claim: "A rod-hanger change doubled the load.", mode: "Carry", kind: "account" }], follows: "c0", band: [300, 900] }
      ],
      clips: [clip("c0", "Engineering Disasters", "The Hyatt collapse", "tape:seg-a", "So the first thing to understand is the drawings.")],
      documents: [printDoc("d0", "NBS report", "The connection as built carried double the load of the design."), tapeDoc("tape:seg-a", "Engineering Disasters — The Hyatt collapse", "So the first thing to understand is the drawings.")]
    },
    {
      actTitle: "Who signed off",
      seams: [{ seamId: "s0", beats: [{ beatId: "b2", claim: "The engineer of record lost his licence.", mode: "Patch", kind: "argument" }], introduces: "c0", intro: "light", band: [150, 500] }],
      clips: [clip("c0", "Engineering Disasters", "After the collapse", "tape:seg-b", "The board met in nineteen eighty-four.")],
      documents: [printDoc("d1", "Licensing board ruling", "The board revoked the licences of two engineers in 1984.")],
      frame: { actIntroduction: "Then the hearings.", actExit: "And that is who paid.", previousActExit: "That was the build.", startState: "knows it fell", endState: "knows who answered for it", actIndex: 1, totalActs: 2 }
    }
  ]
};

const forayB: ForayFixture = {
  voice: voiceB,
  acts: [
    {
      actTitle: "Labels",
      seams: [{ seamId: "s0", beats: [{ beatId: "b0", claim: "Benchmarks carry mislabelled images.", mode: "Carry", kind: "account" }], introduces: "c0", intro: "full", band: [250, 700] }],
      clips: [clip("c0", "Practical AI", "Episode 900", "tape:seg-c", "An audit found thousands of mislabelled images.")],
      documents: [printDoc("d9", "Label errors paper", "Label errors are numerous and pervasive in test sets.")]
    }
  ]
};

const requestFor = (foray: ForayFixture, actIndex: number): ActWriteRequest => ({ voice: foray.voice, ...foray.acts[actIndex]! });

/** Round n of one act, as writeAct.ts sends it: from round 2 every seam
 * carries its previous script, the verified ones FROZEN, the rest EDIT with
 * a fix line, and the retry note names what was rejected. */
function round(request: ActWriteRequest, n: 1 | 2 | 3): ActWriteRequest {
  if (n === 1) return request;
  return {
    ...request,
    retryNote: `Attempt ${n - 1} was rejected for: the prose does not carry beat ${request.seams[0]!.beats[0]?.beatId ?? "b0"}.`,
    seams: request.seams.map(
      (s, i): SeamBrief => (i === 0 ? { ...s, previousScript: `Round ${n - 1}'s draft of ${s.seamId}.`, notes: `round ${n} fix: carry the beat` } : { ...s, previousScript: `Verified ${s.seamId}.`, frozen: true })
    )
  };
}

/** Every request this file's stability tests feed the builder: two Forays, every act, rounds 1-3. */
function everyRequest(): Array<{ foray: ForayFixture; actIndex: number; n: 1 | 2 | 3; request: ActWriteRequest }> {
  const out: Array<{ foray: ForayFixture; actIndex: number; n: 1 | 2 | 3; request: ActWriteRequest }> = [];
  for (const foray of [forayA, forayB])
    foray.acts.forEach((_, actIndex) => {
      for (const n of [1, 2, 3] as const) out.push({ foray, actIndex, n, request: round(requestFor(foray, actIndex), n) });
    });
  return out;
}

const OUTPUTS: ActWriteOutput[] = ["json", "jsonl"];

/** A voice block standing in for GV-99's rendering of the founder-selected exemplar file. */
const VOICE_BLOCK_FIXTURE = [
  "VOICE CARD",
  "Plain words, one idea a sentence, the listener addressed as a friend.",
  "TWO SEAMS IN THIS VOICE (style only - never quote them, never reuse their facts)",
  "1 (bridge): It held for a year. Then the party.",
  "2 (handoff): Which leaves one question."
].join("\n");

describe("GV-50: the writer's stable part is the cacheable prefix", () => {
  it("stable is byte-identical across acts, rounds 1-3 and two Forays with different voices and documents, for each output contract", () => {
    /* MUTATION THAT KILLS THIS: prepend voiceLine(request) to `stable` in
       actWritePromptParts (the pre-GV-50 prompt had the voice line second).
       Ran it: red. Second: append the REJECTIONS line to `stable` when
       request.retryNote is set (a retry then changes the prefix). Ran it: red. */
    const requests = everyRequest();
    expect(requests).toHaveLength(9);
    for (const output of OUTPUTS) {
      const stables = new Set(requests.map(({ request }) => actWritePromptParts(request, { output }).stable));
      expect(stables.size).toBe(1);
      const stable = [...stables][0]!;
      for (const { request } of requests) {
        expect(stable).not.toContain(request.actTitle);
        expect(stable).not.toContain(request.voice.style);
        for (const doc of request.documents) expect(stable).not.toContain(doc.text);
        for (const s of request.seams) for (const b of s.beats) expect(stable).not.toContain(b.claim);
      }
      expect(stable).not.toContain("REJECTIONS SO FAR");
      expect(stable).not.toContain("ACT FRAME");
      expect(stable.startsWith('You are writing the narration of one act of an audio documentary ("Foray")')).toBe(true);
    }
  });

  it("foray is the voice line, identical for every act and round of one Foray and different between Forays", () => {
    /* MUTATION THAT KILLS THIS: move the `THE ACT YOU ARE WRITING: "<title>"`
       line from `call` to the top of `foray` (the foray part then differs per
       act). Ran it: red. */
    for (const foray of [forayA, forayB]) {
      const forays = new Set<string>();
      foray.acts.forEach((_, i) => {
        for (const n of [1, 2, 3] as const) forays.add(actWritePromptParts(round(requestFor(foray, i), n)).foray);
      });
      expect(forays.size).toBe(1);
      expect([...forays][0]).toContain(`style: ${foray.voice.style}`);
    }
    expect(actWritePromptParts(requestFor(forayA, 0)).foray).not.toBe(actWritePromptParts(requestFor(forayB, 0)).foray);
  });

  it("a retry round differs from round 1 only inside call, and call holds the title, the frame, the layout, the documents and the rejections", () => {
    /* MUTATION THAT KILLS THIS: move the "DOCUMENTS — the only things you
       may quote:" line out of `call` into the end of writeStable. Ran it:
       red. Second: drop the "" that opens the retry section in `call`. Ran
       it: red. */
    for (const foray of [forayA, forayB])
      foray.acts.forEach((_, i) => {
        const r1 = actWritePromptParts(round(requestFor(foray, i), 1));
        for (const n of [2, 3] as const) {
          const rn = actWritePromptParts(round(requestFor(foray, i), n));
          expect(rn.stable).toBe(r1.stable);
          expect(rn.foray).toBe(r1.foray);
          expect(rn.call).not.toBe(r1.call);
          expect(rn.call).toContain(`\n\nREJECTIONS SO FAR: Attempt ${n - 1} was rejected for`);
        }
      });
    const framed = actWritePromptParts(round(requestFor(forayA, 1), 2)).call;
    const order = ['THE ACT YOU ARE WRITING: "Who signed off"', "THE ACT, IN PLAY ORDER.", "ACT FRAME — this is act 2 of 2.", "SEAM s0 —", "DOCUMENTS — the only things you may quote:", "REJECTIONS SO FAR:"];
    const at = order.map((line) => framed.indexOf(line));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(framed.endsWith("keep every sentence that was not objected to.")).toBe(true);
    expect(actWritePromptParts(requestFor(forayA, 0)).call.endsWith(forayA.acts[0]!.documents[1]!.text)).toBe(true);
  });

  it("buildActWritePrompt is the three parts joined with the 'json' contract and an empty voice slot", () => {
    /* MUTATION THAT KILLS THIS: default `options.output` to "jsonl" in
       actWritePromptParts (the Anthropic writer then asks for JSONL its
       parser cannot read). Ran it: red. */
    for (const { request } of everyRequest()) {
      expect(buildActWritePrompt(request)).toBe(joinParts(actWritePromptParts(request, { output: "json" })));
      expect(actWritePromptParts(request)).toEqual(actWritePromptParts(request, { output: "json", voiceBlock: "" }));
    }
    expect(buildActWritePrompt(requestFor(forayA, 0))).toContain('{"seams": [{"seamId": string, "script": string, "claims": [');
  });
});

describe("GV-50: the voice slot (decision 17: empty unless a selected exemplar file is supplied)", () => {
  it("is empty by default: stable ends with the output contract", () => {
    /* MUTATION THAT KILLS THIS: append a default voice card to `stable` when
       no voiceBlock is passed (`options.voiceBlock ?? "VOICE CARD"`). Ran
       it: red. */
    for (const output of OUTPUTS) {
      const { stable } = actWritePromptParts(requestFor(forayA, 0), { output });
      expect(stable).not.toContain("VOICE CARD");
      expect(stable).not.toContain("SEAMS IN THIS VOICE");
      const lastLine = stable.split("\n").at(-1)!;
      expect(lastLine.startsWith("{")).toBe(true);
    }
  });

  it("a supplied block lands at the end of stable after a blank line, byte-stable across acts, rounds and Forays, and changes nothing else", () => {
    /* MUTATION THAT KILLS THIS: put the voice block into `foray` instead of
       `stable` (it is then sent as user text and is not part of the
       cross-Foray prefix). Ran it: red. Second: place it at the top of
       stable, before the role line. Ran it: red. */
    for (const output of OUTPUTS) {
      const stables = new Set<string>();
      for (const { request } of everyRequest()) {
        const plain = actWritePromptParts(request, { output });
        const voiced = actWritePromptParts(request, { output, voiceBlock: VOICE_BLOCK_FIXTURE });
        expect(voiced.stable).toBe(`${plain.stable}\n\n${VOICE_BLOCK_FIXTURE}`);
        expect(voiced.foray).toBe(plain.foray);
        expect(voiced.call).toBe(plain.call);
        stables.add(voiced.stable);
      }
      expect(stables.size).toBe(1);
    }
  });
});

describe("GV-50: the 'jsonl' output contract (GV-84's streamed writer)", () => {
  const jsonl = () => actWritePromptParts(requestFor(forayA, 0), { output: "jsonl" });
  const json = () => actWritePromptParts(requestFor(forayA, 0), { output: "json" });

  it("names every required field of WRITTEN_SEAM_JSON_SCHEMA, the claims' and the hints' included, and says one seam per line in listening order", () => {
    /* MUTATION THAT KILLS THIS: hard-code JSONL_LINE_FIELDS as
       "seamId, script, claims, usedClaims" (pronunciationHints dropped, the
       schema no longer read). Ran it: red. */
    const { stable } = jsonl();
    const contract = stable.slice(stable.indexOf("Respond in JSONL"));
    expect(contract).toContain("one seam object per line, in listening order, s0 first, nothing else on the line");
    const required = WRITTEN_SEAM_JSON_SCHEMA.required ?? [];
    expect([...required].sort()).toEqual(["claims", "pronunciationHints", "script", "seamId", "usedClaims"]);
    expect(contract).toContain(`these fields: ${required.join(", ")}`);
    for (const field of required) expect(contract).toContain(`"${field}"`);
    const nested = [WRITTEN_SEAM_JSON_SCHEMA.properties?.claims?.items, WRITTEN_SEAM_JSON_SCHEMA.properties?.pronunciationHints?.items];
    for (const item of nested) {
      expect(item?.required?.length).toBeGreaterThan(0);
      for (const field of item!.required!) expect(contract).toContain(`"${field}"`);
    }
    expect(contract).not.toContain('{"seams"');
    expect(contract).not.toContain("a single JSON object");
  });

  it("differs from the json prompt only in the contract lines: rules, foray and call are the same bytes", () => {
    /* MUTATION THAT KILLS THIS: move the "Also list any hard-to-pronounce..."
       line out of writeStable into outputContract's 'json' branch only (the
       jsonl writer then never lists hints). Ran it: red. */
    const a = json();
    const b = jsonl();
    expect(b.foray).toBe(a.foray);
    expect(b.call).toBe(a.call);
    const head = (s: string, marker: string) => s.slice(0, s.indexOf(marker));
    expect(head(b.stable, "Respond in JSONL")).toBe(head(a.stable, "Respond with ONLY a single JSON object"));
    expect(head(a.stable, "Respond with ONLY")).toContain("Also list any hard-to-pronounce or foreign words");
  });
});

describe("GV-50: the verifier's parts", () => {
  const verifyRequest = (foray: ForayFixture, actIndex: number, frozenFirst = false): ActVerifyRequest => {
    const act = foray.acts[actIndex]!;
    return {
      actTitle: act.actTitle,
      voice: foray.voice,
      beats: act.seams.flatMap((s) => s.beats),
      seams: act.seams.map((s, i) => ({
        seamId: s.seamId,
        script: `The script of ${s.seamId} in ${act.actTitle}.`,
        selected: i === 0 ? ["k0"] : [],
        carries: s.beats.map((b) => b.beatId),
        ...(s.follows ? { follows: s.follows } : {}),
        ...(s.introduces ? { introduces: s.introduces, intro: s.intro ?? "full" } : {}),
        ...(frozenFirst && i === 0 ? { frozen: true } : {})
      })),
      clips: act.clips.map((c) => ({ ...c, windowText: `Window of ${c.clipId}: ${c.opening}` })),
      sources: [{ id: "k0", kind: "claim", claimText: `A claim of ${act.actTitle}.`, quote: act.documents[0]!.text, publication: act.documents[0]!.title, contested: false, selectedBy: "s0", docId: act.documents[0]!.docId }],
      documents: act.documents
    };
  };

  it("stable is byte-identical across acts, rounds and two unrelated Forays; foray is empty; the seams to judge are named only in call", () => {
    /* MUTATION THAT KILLS THIS: put the judged seam ids back into question 2
       (`stable: VERIFY_STABLE.replace("named on the SEAMS TO JUDGE line
       below", judged.join(", ") || "none")`, the pre-GV-50 wording). Ran
       it: red. */
    const stables = new Set<string>();
    for (const foray of [forayA, forayB])
      foray.acts.forEach((act, i) => {
        for (const frozenFirst of [false, true]) {
          const parts = actVerifyPromptParts(verifyRequest(foray, i, frozenFirst));
          stables.add(parts.stable);
          expect(parts.foray).toBe("");
          expect(parts.call.startsWith(`THE ACT YOU ARE VERIFYING: "${act.actTitle}"`)).toBe(true);
          expect(parts.stable).not.toContain(act.actTitle);
          const judged = act.seams.filter((_, k) => !(frozenFirst && k === 0)).map((s) => s.seamId);
          expect(parts.call).toContain(`\nSEAMS TO JUDGE: ${judged.join(", ") || "none"}\n`);
        }
      });
    expect(stables.size).toBe(1);
    const stable = [...stables][0]!;
    expect(stable).toContain("named on the SEAMS TO JUDGE line below");
    expect(stable).toContain("follow from SOME act source below");
    expect(stable).not.toContain("Transcript window");
    expect(stable.split("\n").at(-1)!.startsWith('{"beats": [{"beatId": string, "carried": boolean')).toBe(true);
  });

  it("every clip's whole transcript window is in call (R2-12's evidence), never in the cacheable part", () => {
    /* MUTATION THAT KILLS THIS: drop the `Transcript window:` line from
       actVerifyLayout. Ran it: red. */
    const req = verifyRequest(forayA, 0);
    const parts = actVerifyPromptParts(req);
    for (const c of req.clips) {
      expect(parts.call).toContain(`  Transcript window:\n${c.windowText}`);
      expect(parts.stable).not.toContain(c.windowText);
    }
  });
});

describe("GV-50: the prompt modules are provider-neutral", () => {
  it("prompts/actWrite.ts and prompts/actVerify.ts import no Anthropic SDK and no Anthropic module", () => {
    /* MUTATION THAT KILLS THIS: import `createMessage` from "../anthropicCall"
       in prompts/actWrite.ts. Ran it: red. */
    for (const file of ["actWrite.ts", "actVerify.ts"]) {
      const source = readFileSync(join(__dirname, "../src/generation/prompts", file), "utf8");
      const imports = source.split("\n").filter((l) => l.startsWith("import "));
      expect(imports.length).toBeGreaterThan(0);
      for (const line of imports) {
        expect(line).not.toMatch(/@anthropic-ai|anthropicCall|Anthropic[A-Za-z]*Builder/);
      }
    }
  });
});
