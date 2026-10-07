import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { decodeEntities as decodeLive } from "../src/feeds/html";
import { parseFeed } from "../src/feeds/parser";

/* CH2-09 (docs/roadmap/code-health-2.md, B1-05). Feed text is decoded in two
   places: backend/src/feeds/html.ts (the live API — every parsed title and
   show note) and tools/refresh/entities.mjs (the catalogue — every title the
   nightly writes into data/). They used to disagree (13 names vs ~70, one
   pass vs a fixed point, a C0 control dropped vs spaced), so the live episode
   list showed "Caf&eacute;" for a title data/discover.json already carried as
   "Café". One table (backend/src/feeds/entitiesTable.json) and one code-point
   rule now; this suite holds both decoders to the shared fixture. */

const BACKEND = path.join(__dirname, "..");
const ROOT = path.join(BACKEND, "..");

interface EntityCase {
  name: string;
  input: string;
  expected: string;
}

const fixture = JSON.parse(fs.readFileSync(path.join(BACKEND, "fixtures", "entities.json"), "utf8")) as {
  cases: EntityCase[];
};

type Decode = (s: string) => string;

async function catalogueDecoder(): Promise<Decode> {
  const mod = (await import(pathToFileURL(path.join(ROOT, "tools", "refresh", "entities.mjs")).href)) as {
    decodeEntities: Decode;
  };
  return mod.decodeEntities;
}

/** One row per input the two decoders disagree on, printed as a table so a red run says what differs. */
function diffRows(inputs: { name: string; input: string }[], decodeCatalogue: Decode) {
  const rows: { case: string; input: string; live: string; catalogue: string }[] = [];
  for (const { name, input } of inputs) {
    const live = decodeLive(input);
    const catalogue = decodeCatalogue(input);
    if (live !== catalogue) rows.push({ case: name, input, live: JSON.stringify(live), catalogue: JSON.stringify(catalogue) });
  }
  if (rows.length) console.table(rows);
  return rows;
}

describe("one entity table, one code-point rule (CH2-09)", () => {
  it("the live decoder and the catalogue decoder agree on every fixture case", async () => {
    /* MUTATION: map a control code point to "" in html.ts (the old C0 rule)
       while entities.mjs spaces it -> the C0 row prints and this goes red. */
    expect(fixture.cases.length).toBeGreaterThanOrEqual(10);
    expect(diffRows(fixture.cases, await catalogueDecoder())).toEqual([]);
  });

  it("both decoders produce the fixture's expected text", async () => {
    /* MUTATION: drop the fixed-point loop from both decoders -> "Grant &#038; Lee". */
    const decodeCatalogue = await catalogueDecoder();
    for (const c of fixture.cases) {
      expect(decodeLive(c.input), `live: ${c.name}`).toBe(c.expected);
      expect(decodeCatalogue(c.input), `catalogue: ${c.name}`).toBe(c.expected);
    }
  });

  it("every name in the shared table decodes, and decodes the same in both", async () => {
    /* MUTATION: build html.ts's name pattern from a hard-coded subset -> "&eacute;" survives live. */
    const table = JSON.parse(
      fs.readFileSync(path.join(BACKEND, "src", "feeds", "entitiesTable.json"), "utf8")
    ) as Record<string, string>;
    const names = Object.keys(table);
    expect(names.length).toBeGreaterThanOrEqual(70);
    const inputs = names.map((n) => ({ name: n, input: `x&${n};y` }));
    expect(diffRows(inputs, await catalogueDecoder())).toEqual([]);
    for (const n of names) expect(decodeLive(`&${n};`), n).toBe(table[n]);
  });

  it("neither module carries a name map of its own: both read entitiesTable.json", () => {
    /* MUTATION: re-add a local `{ amp: "&", ... }` map to either file -> red. */
    const live = fs.readFileSync(path.join(BACKEND, "src", "feeds", "html.ts"), "utf8");
    const catalogue = fs.readFileSync(path.join(ROOT, "tools", "refresh", "entities.mjs"), "utf8");
    expect(live).toMatch(/^import \* as \w+ from "\.\/entitiesTable\.json";$/m);
    expect(catalogue).toContain("backend/src/feeds/entitiesTable.json");
    for (const src of [live, catalogue]) {
      expect(src).not.toMatch(/\b(?:amp|hellip|eacute)\s*:\s*["']/);
    }
  });
});

describe("html.ts survives the deployed function's CommonJS compile (S-02 class)", () => {
  it("loads and decodes when transpiled to CommonJS with or without esModuleInterop", async () => {
    /* MUTATION: `import ENTITY_TABLE from "./entitiesTable.json"` (a default
       import) -> without interop it reads require(...).default, undefined,
       and the module throws at load: every api/ function would 500. */
    const ts = await import("typescript");
    const src = fs.readFileSync(path.join(BACKEND, "src", "feeds", "html.ts"), "utf8");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ch2-09-"));
    try {
      fs.copyFileSync(path.join(BACKEND, "src", "feeds", "entitiesTable.json"), path.join(dir, "entitiesTable.json"));
      for (const esModuleInterop of [true, false]) {
        const js = ts.transpileModule(src, {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop }
        }).outputText;
        const file = path.join(dir, `html-${esModuleInterop}.js`);
        fs.writeFileSync(file, js);
        const load = createRequire(file);
        const mod = load(file) as { decodeEntities: (s: string) => string };
        expect(mod.decodeEntities("Caf&eacute; &amp;#038; Co &default;"), `esModuleInterop=${esModuleInterop}`).toBe(
          "Café & Co &default;"
        );
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000); // importing the TypeScript compiler alone can take most of the 10 s default on a cold runner
});

describe("the live parser shows what data/ carries (B1-05)", () => {
  it("an ordinary title with a named accent decodes all the way, like data/discover.json", () => {
    /* MUTATION: drop "eacute" from the shared table -> "Caf&eacute; & Co" on the live list again. */
    const feed = parseFeed(
      `<rss><channel><title>Caf&eacute; &amp; Co</title>` +
        `<item><title>Caf&eacute; &amp; Co, episode 1</title><guid>a</guid></item></channel></rss>`
    );
    expect(feed!.title).toBe("Café & Co");
    expect(feed!.episodes.map((e) => e.title)).toEqual(["Café & Co, episode 1"]);
  });

  it("a CDATA title's double-encoded &amp;#038; decodes to a bare ampersand", () => {
    /* MUTATION: decode one pass instead of to a fixed point -> "Grant &#038; Lee". */
    const feed = parseFeed(
      `<rss><channel><title>T</title>` +
        `<item><title><![CDATA[Grant &amp;#038; Lee]]></title><guid>a</guid></item>` +
        `<item><title>Grant &amp;#038; Lee</title><guid>b</guid></item></channel></rss>`
    );
    expect(feed!.episodes.map((e) => e.title)).toEqual(["Grant & Lee", "Grant & Lee"]);
  });
});
