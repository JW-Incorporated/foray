import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DOSSIER_CONTROVERSY_CHARS,
  DOSSIER_NOTES_MAX_CHARS,
  DossierExternalResearcher,
  DossierFileSchema,
  DossierManifestSchema,
  __clearDossierCacheForTests
} from "../src/generation/DossierExternalResearcher";
import { createExternalResearcher } from "../src/generation/createExternalResearcher";
import { DefaultEvidenceGatherer } from "../src/generation/gatherEvidence";
import { DEFAULT_DOSSIER_DIR, DOSSIER_DIR_ENV, FlagValueError, dossierDir } from "../src/generation/generationFlags";
import { gateSelectedClaims, type PendingPage } from "../src/generation/writeNarration";
import type { ExternalResearchContext } from "../src/generation/ExternalResearcher";
import { validateDossier, validateManifest } from "../../tools/corpus/dossiers/schema.mjs";

/**
 * GV-69 (docs/roadmap/generation-v2.md, W3-21): the 'dossier' research route.
 * Outside facts come from local fetched-text dossiers (GV-30's build), with no
 * network and no file writes, through BM25 with two uncalibrated floors.
 *
 * The fixtures under fixtures/dossiers/ are SYNTHETIC (example.org urls,
 * invented text) and validate against GV-30's own schema
 * (tools/corpus/dossiers/schema.mjs), the contract the module's zod schema
 * mirrors. Offline: nothing here reaches a network; the only files written are
 * a test's own temp copies.
 */

const FIXTURES = path.resolve(__dirname, "fixtures", "dossiers");
const ctx: ExternalResearchContext = { userId: "founder-1" };

type Json = Record<string, unknown>;
function fixture(name: string): Json {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8")) as Json;
}
const MEDICINE = fixture("medicine.json");
const passages = (d: Json) => d.passages as Array<{ docId: string; text: string; contested?: boolean }>;
const JENNER = passages(MEDICINE)[0]!;
const CONTESTED = passages(MEDICINE).find((p) => p.contested === true)!;

function researcher(dir = FIXTURES): DossierExternalResearcher {
  return new DossierExternalResearcher({ dir });
}

/** A temp copy of the fixture directory a test may break. */
function tempCopy(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv69-dossiers-"));
  for (const f of fs.readdirSync(FIXTURES)) fs.copyFileSync(path.join(FIXTURES, f), path.join(dir, f));
  return dir;
}

let warn: ReturnType<typeof vi.spyOn>;
const temps: string[] = [];
beforeEach(() => {
  __clearDossierCacheForTests();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("the fixtures and the schema mirror", () => {
  /* MUTATION THAT KILLS THIS: drop `.strict()` from the passage object in
     DossierFileSchema (an extra key then passes zod while schema.mjs refuses
     it). Ran: red (the "unexpected key" variant disagreed). */
  it("the fixtures validate against GV-30's schema.mjs, and the zod mirror agrees with it on broken variants", () => {
    const manifest = fixture("manifest.json");
    expect(validateManifest(manifest)).toEqual([]);
    expect(DossierManifestSchema.safeParse(manifest).success).toBe(true);
    for (const name of ["medicine.json", "engineering.json"]) {
      const dossier = fixture(name);
      expect(validateDossier(dossier), name).toEqual([]);
      expect(DossierFileSchema.safeParse(dossier).success, name).toBe(true);
    }

    const broken: Array<[string, (d: Json) => void]> = [
      ["unexpected passage key", (d) => ((passages(d)[0] as Json).extra = 1)],
      ["bad docId", (d) => (passages(d)[0]!.docId = "print:x")],
      ["over-long text", (d) => (passages(d)[0]!.text = "x".repeat(1501))],
      ["http url", (d) => ((d.sources as Json[])[0]!.url = "http://example.org/a")],
      ["missing passages", (d) => delete d.passages],
      ["wrong builder", (d) => (d.builder = "claude")],
      ["bad date", (d) => (d.built_at = "yesterday")]
    ];
    for (const [label, breakIt] of broken) {
      const d = structuredClone(MEDICINE);
      breakIt(d);
      expect(validateDossier(d).length, `schema.mjs: ${label}`).toBeGreaterThan(0);
      expect(DossierFileSchema.safeParse(d).success, `zod: ${label}`).toBe(false);
    }
  });
});

describe("retrievePassages", () => {
  /* MUTATION THAT KILLS THIS: title `source.title` alone (no publication).
     Ran: red. And text with its whitespace doubled (not the fetched bytes):
     red. */
  it("a claim matching a medicine passage returns it, titled publication — source title, with url and retrievedAt", async () => {
    const found = await researcher().retrievePassages(
      { claim: "Jenner tested the smallpox vaccine on James Phipps in 1796", maxPassages: 3, maxChars: 1500 },
      ctx
    );
    expect(found).toEqual([
      {
        docId: JENNER.docId,
        title: "Example Encyclopedia — Edward Jenner (synthetic)",
        url: "https://example.org/medicine/edward-jenner",
        retrievedAt: "2026-10-01T12:00:00Z",
        text: JENNER.text
      }
    ]);
  });

  /* MUTATION THAT KILLS THIS: scope() ignoring ctx.topicNodeIds (always all
     passages). Ran: red (the medicine claim came back under an engineering
     lineage). */
  it("only lineage-scoped dossiers are searched when topicNodeIds is set; absent means every dossier", async () => {
    const r = researcher();
    const medicineClaim = { claim: "Jenner tested the smallpox vaccine on James Phipps in 1796", maxPassages: 3, maxChars: 1500 };
    const bridgeClaim = { claim: "Wind drove the Tacoma Narrows bridge deck into twisting oscillations", maxPassages: 3, maxChars: 1500 };
    expect(await r.retrievePassages(medicineClaim, { ...ctx, topicNodeIds: ["engineering", "engineering/bridges"] })).toEqual([]);
    expect((await r.retrievePassages(medicineClaim, { ...ctx, topicNodeIds: ["medicine"] })).map((p) => p.docId)).toEqual([JENNER.docId]);
    expect(await r.retrievePassages(bridgeClaim, { ...ctx, topicNodeIds: ["medicine"] })).toEqual([]);
    const unscoped = await r.retrievePassages(bridgeClaim, ctx);
    expect(unscoped[0]?.docId).toBe("dossier:engineering:9a8b7c6d5e4f:0");
  });

  /* MUTATION THAT KILLS THIS: DOSSIER_MIN_TERMS = 1. Ran: red (the
     one-word claim returned Jenner's passages; its idf share alone clears
     the share floor). */
  it("a claim sharing a single content word is under the matched-terms floor and returns []", async () => {
    expect(await researcher().retrievePassages({ claim: "Jenner's life", maxPassages: 3, maxChars: 1500 }, ctx)).toEqual([]);
  });

  /* MUTATION THAT KILLS THIS: DOSSIER_MIN_SHARE = 0. Ran: red (two common
     words in a claim about physics returned the vaccination passages). */
  it("two shared common words in a claim about something else are under the idf-share floor and return []", async () => {
    const claim = "smallpox vaccination quantum chromodynamics gluon confinement lattice simulations supercomputers";
    expect(await researcher().retrievePassages({ claim, maxPassages: 3, maxChars: 1500 }, ctx)).toEqual([]);
  });

  /* MUTATION THAT KILLS THIS: drop `.slice(0, max)` (every passage over the
     floors returned). Ran: red. And drop the text's `.slice(0, maxChars)`:
     red (full text). */
  it("maxPassages and maxChars are honoured", async () => {
    const r = researcher();
    const claim = "Jenner cowpox smallpox vaccination";
    const all = await r.retrievePassages({ claim, maxPassages: 10, maxChars: 1500 }, ctx);
    expect(all.length).toBeGreaterThan(2);
    const two = await r.retrievePassages({ claim, maxPassages: 2, maxChars: 40 }, ctx);
    expect(two.map((p) => p.docId)).toEqual(all.slice(0, 2).map((p) => p.docId));
    for (const p of two) {
      expect(p.text.length).toBeLessThanOrEqual(40);
      expect(all.find((a) => a.docId === p.docId)!.text.startsWith(p.text)).toBe(true);
    }
    expect(await r.retrievePassages({ claim, maxPassages: 0, maxChars: 40 }, ctx)).toEqual([]);
  });
});

describe("research", () => {
  /* MUTATION THAT KILLS THIS: notes built from `passage.text.slice(0, 100)`
     (a summary, not the passage). Ran: red. */
  it("notes are the best passages verbatim after their titles, capped; controversies open the contested passages", async () => {
    const result = await researcher().research("Jenner smallpox vaccine cowpox", { ...ctx, topicNodeIds: ["medicine"] });
    expect(result.notes.startsWith(`Example Encyclopedia — Edward Jenner (synthetic): ${JENNER.text}`)).toBe(true);
    expect(result.notes.length).toBeLessThanOrEqual(DOSSIER_NOTES_MAX_CHARS);
    expect(result.notes.split("\n\n").length).toBeLessThanOrEqual(3);
    expect(result.controversies).toEqual([CONTESTED.text.slice(0, DOSSIER_CONTROVERSY_CHARS)]);
  });

  /* MUTATION THAT KILLS THIS: drop the `r.matched > 0` requirement for an
     unscoped contested passage. Ran: red (the medicine controversy was
     handed to a bridge topic). */
  it("unscoped, a contested passage sharing no word with the topic is not a controversy of it", async () => {
    const result = await researcher().research("Tacoma Narrows bridge collapse", ctx);
    expect(result.notes).toContain("Tacoma Narrows Bridge collapsed");
    expect(result.controversies).toEqual([]);
  });
});

describe("loading: read-only, once per process, never fatal", () => {
  /* MUTATION THAT KILLS THIS: store the loaded set only when it has
     passages (a missing dir is re-read, and re-warned, on every call). Ran:
     red (two warnings). */
  it("a missing directory gives an empty set and a single warning, like the Null researcher", async () => {
    const r = researcher(path.join(os.tmpdir(), "gv69-no-such-dossier-dir"));
    expect(await r.retrievePassages({ claim: "Jenner tested the smallpox vaccine", maxPassages: 3, maxChars: 1500 }, ctx)).toEqual([]);
    expect(await r.research("smallpox vaccine", ctx)).toEqual({ notes: "", controversies: [] });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/no dossier directory/);
  });

  /* MUTATION THAT KILLS THIS: `return empty` instead of `continue` on a file
     that fails the schema (one bad dossier blanks the set). Ran: red. */
  it("a dossier that fails the schema is skipped and logged; the others still serve", async () => {
    const dir = tempCopy();
    temps.push(dir);
    const bad = fixture("medicine.json");
    bad.builder = "claude";
    fs.writeFileSync(path.join(dir, "medicine.json"), JSON.stringify(bad));
    const r = researcher(dir);
    expect(await r.retrievePassages({ claim: "Jenner tested the smallpox vaccine on James Phipps in 1796", maxPassages: 3, maxChars: 1500 }, ctx)).toEqual([]);
    const bridge = await r.retrievePassages({ claim: "Wind drove the Tacoma Narrows bridge deck into twisting oscillations", maxPassages: 3, maxChars: 1500 }, ctx);
    expect(bridge.length).toBeGreaterThan(0);
    expect(warn.mock.calls.map((c) => String(c[0])).some((m) => /skipped medicine\.json/.test(m))).toBe(true);
  });

  /* MUTATION THAT KILLS THIS: drop the per-directory cache in set() (read
     on every call). Ran: red (the second call read the emptied directory). */
  it("the directory is read once per process: a later change on disk is not re-read", async () => {
    const dir = tempCopy();
    temps.push(dir);
    const r = researcher(dir);
    const request = { claim: "Jenner tested the smallpox vaccine on James Phipps in 1796", maxPassages: 3, maxChars: 1500 };
    expect((await r.retrievePassages(request, ctx)).length).toBe(1);
    fs.rmSync(path.join(dir, "medicine.json"));
    expect((await researcher(dir).retrievePassages(request, ctx)).length).toBe(1);
  });

  /* MUTATION THAT KILLS THIS: add `fs.writeFileSync(` (or a `fetch(`) call
     to DossierExternalResearcher.ts. Ran: red. */
  it("the module source has no fetch, http or fs-write call", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../src/generation/DossierExternalResearcher.ts"), "utf8");
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/["'](node:)?(https?|net|tls|http2|dgram)["']/);
    expect(source).not.toMatch(/\baxios\b|\bundici\b/);
    expect(source).not.toMatch(/\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdir|mkdirSync|rename|renameSync|unlink|unlinkSync|rm|rmSync|copyFile|copyFileSync)\s*\(/);
    expect(source).not.toMatch(/anthropicCall|@anthropic-ai/);
  });
});

describe("routing and the directory flag", () => {
  /* MUTATION THAT KILLS THIS: resolve a relative FORAY_DOSSIER_DIR against
     process.cwd() (vitest runs from backend/). Ran: red. */
  it("dossierDir(): unset is data-local/dossiers under the repo root, relative is the repo root's, blank throws naming only the variable", () => {
    const repoRoot = path.resolve(__dirname, "..", "..");
    expect(dossierDir({})).toBe(path.join(repoRoot, "data-local", "dossiers"));
    expect(DEFAULT_DOSSIER_DIR).toBe(path.join(repoRoot, "data-local", "dossiers"));
    expect(dossierDir({ [DOSSIER_DIR_ENV]: "backend/test/fixtures/dossiers" })).toBe(FIXTURES);
    let err: unknown;
    try {
      dossierDir({ [DOSSIER_DIR_ENV]: "   " });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FlagValueError);
    expect((err as FlagValueError).variable).toBe("FORAY_DOSSIER_DIR");
  });

  /* MUTATION THAT KILLS THIS: build the Null researcher for the 'dossier'
     built-in. Ran: red. */
  it("FORAY_STAGE_RESEARCH=dossier builds the dossier researcher, reading FORAY_DOSSIER_DIR", () => {
    const saved = process.env[DOSSIER_DIR_ENV];
    process.env[DOSSIER_DIR_ENV] = FIXTURES;
    try {
      const built = createExternalResearcher({ FORAY_STAGE_RESEARCH: "dossier" });
      expect(built).toBeInstanceOf(DossierExternalResearcher);
      expect(built.providerName).toBe("dossier");
      expect((built as DossierExternalResearcher).dir).toBe(FIXTURES);
    } finally {
      if (saved === undefined) delete process.env[DOSSIER_DIR_ENV];
      else process.env[DOSSIER_DIR_ENV] = saved;
    }
  });
});

describe("through the evidence gatherer", () => {
  /* MUTATION THAT KILLS THIS: retrievePassages returning a 100-char snippet
     instead of the passage up to maxChars. Ran: red (the quote is not a
     verbatim span of any document held). Also: not passing docId (the
     gatherer mints print:<hash>). Ran: red. */
  it("a Carry beat gets print documents, and a quote taken from a fixture passage passes gateSelectedClaims", async () => {
    const gatherer = new DefaultEvidenceGatherer({ researcher: researcher(), cacheDir: null });
    const claim = "How Jenner proved the smallpox vaccine worked on James Phipps";
    const pack = await gatherer.gather({ claim, kind: "account", requiresEvidence: true }, { ...ctx, topicNodeIds: ["medicine"] });
    const print = pack.docs.filter((d) => d.kind === "print");
    expect(print.map((d) => d.docId)).toContain(JENNER.docId);
    expect(pack.printSkipped).toBeUndefined();
    const doc = print.find((d) => d.docId === JENNER.docId)!;
    expect(doc.title).toBe("Example Encyclopedia — Edward Jenner (synthetic)");
    expect(doc.url).toBe("https://example.org/medicine/edward-jenner");

    const page: PendingPage = { pageId: "act1-p1", beatIndex: 0, claim, mode: "Carry", evidence: pack };
    const gate = gateSelectedClaims(
      [{ claimText: "The boy did not fall ill when exposed", quote: "When Phipps was later exposed to smallpox, he did not fall ill.", docId: JENNER.docId, contested: false }],
      page
    );
    expect(gate.issues).toEqual([]);
    expect(gate.valid).toHaveLength(1);
  });
});
