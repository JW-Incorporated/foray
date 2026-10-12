/* GV-30 (W3-19): the code-built dossier builder.
 *
 * Fixture-only: every request goes to an injected fetchImpl serving fixture
 * robots.txt and HTML, the clock is virtual (the fetcher's 2 s host spacing
 * costs no real time), output goes to a temp dir, and globalThis.fetch is
 * replaced by a thrower for the whole file so an un-injected request fails
 * the suite instead of reaching the network.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { USER_AGENT } from "../fetcher.mjs";
import { htmlToMarkdown } from "../extract.mjs";
import { MAX_PASSAGES_PER_NODE, buildDossiers, dossierPath, main, parseArgs, safeNodeId, targetsFor } from "./build.mjs";
import { VerbatimError, extractText } from "./passages.mjs";
import { DOSSIER_SCHEMA, validateDossier, validateManifest } from "./schema.mjs";
import { SeedError, assertSeedUrl, loadSeeds, loadTaxonomyNodes, parseSeeds, subjectTargets, titlesForNode, wikiUrlForTitle } from "./seeds.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_HTML = fs.readFileSync(path.join(HERE, "..", "fixtures", "dossiers", "article.html"));
const WIKI_ROBOTS = "User-agent: *\nDisallow: /w/\nDisallow: /api/\nAllow: /w/load.php?\n";
const ARTICLE = "https://en.wikipedia.org/wiki/Larkspur_Tokamak";
const T0 = Date.UTC(2026, 9, 12, 8, 0, 0);
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

let realFetch;
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`network call in a fixture-only suite: ${url}`);
  };
});
after(() => {
  globalThis.fetch = realFetch;
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

function makeRes(status, body = "", contentType = "text/html; charset=UTF-8") {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body);
  const h = new Map([["content-type", contentType], ["content-length", String(bytes.byteLength)]]);
  return {
    status,
    headers: { get: (k) => h.get(k.toLowerCase()) ?? null },
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () => bytes.slice().buffer,
  };
}

/* routes: exact URL -> [status, body, contentType?]. Unknown URLs are 404.
   Every request is logged with its headers. */
function rig(routes) {
  let t = T0;
  const log = [];
  const fetchImpl = async (url, opts) => {
    log.push({ url, ua: opts?.headers?.["user-agent"] });
    const r = routes[url];
    return r ? makeRes(...r) : makeRes(404, "<html><body>Wikipedia does not have an article with this exact name.</body></html>");
  };
  return { fetchImpl, log, now: () => t, sleep: async (ms) => { t += ms; } };
}

const made = [];
const tmpDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "gv30-dossiers-"));
  made.push(d);
  return d;
};

function bigArticle(tag, paragraphs) {
  const ps = Array.from({ length: paragraphs }, (_, i) => `<p>Paragraph ${i} of source ${tag} holds enough plain words to count as one passage.</p>`);
  return `<!DOCTYPE html><html><head><title>${tag} - Wikipedia</title></head><body><main><article>${ps.join("\n")}</article></main></body></html>`;
}

test("a fixture article becomes a schema-valid dossier of verbatim passages with full source records", async () => {
  const out = tmpDir();
  const r = rig({ "https://en.wikipedia.org/robots.txt": [200, WIKI_ROBOTS, "text/plain"], [ARTICLE]: [200, FIXTURE_HTML] });
  const { manifest, dossiers } = await buildDossiers({
    targets: [{ id: "engineering/energy-fusion", label: "Fusion & energy systems", urls: [ARTICLE] }],
    outDir: out,
    fetchImpl: r.fetchImpl,
    sleep: r.sleep,
    now: r.now,
  });
  const file = path.join(out, "engineering__energy-fusion.json");
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(onDisk, dossiers[0]);
  assert.deepEqual(validateDossier(onDisk), []);
  assert.equal(onDisk.builder, "code");
  assert.equal(onDisk.version, 1);

  // Source record: url, retrievedAt, raw sha256, license, publication, title.
  assert.equal(onDisk.sources.length, 1);
  const [src] = onDisk.sources;
  assert.equal(src.url, ARTICLE);
  assert.equal(src.retrievedAt.slice(0, 10), "2026-10-12");
  assert.equal(src.sha256, sha256(FIXTURE_HTML));
  assert.equal(src.license, "CC BY-SA 4.0");
  assert.equal(src.publication, "Wikipedia");
  assert.equal(src.title, "Larkspur Tokamak");

  // Every passage is the verbatim slice of the independently re-extracted text.
  const text = extractText(htmlToMarkdown(FIXTURE_HTML.toString("utf8"), ARTICLE).markdown);
  assert.equal(onDisk.passages.length, 5);
  onDisk.passages.forEach((p, n) => {
    assert.equal(text.slice(p.offset, p.offset + p.text.length), p.text);
    assert.ok(text.includes(p.text));
    assert.equal(p.docId, `dossier:engineering/energy-fusion:${src.sourceId}:${n}`);
    assert.ok(p.text.length <= 1500);
  });

  // Requests: robots.txt first, then the article, all with the corpus UA, none elsewhere.
  assert.deepEqual(r.log.map((l) => l.url), ["https://en.wikipedia.org/robots.txt", ARTICLE]);
  assert.ok(r.log.every((l) => l.ua === USER_AGENT));

  // Manifest: file, sha256 of the written bytes, counts.
  assert.deepEqual(validateManifest(manifest), []);
  const entry = manifest.nodes["engineering/energy-fusion"];
  assert.equal(entry.file, "engineering__energy-fusion.json");
  assert.equal(entry.sha256, sha256(fs.readFileSync(file)));
  assert.equal(entry.passages, 5);
  assert.equal(entry.sources, 1);
  assert.deepEqual(entry.missing, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8")), manifest);
});

test("a 404 and a robots.txt refusal are recorded per node as missing, and a node with nothing gets no file", async () => {
  const out = tmpDir();
  const blocked = "https://example.org/private/fusion";
  const r = rig({
    "https://en.wikipedia.org/robots.txt": [200, WIKI_ROBOTS, "text/plain"],
    "https://example.org/robots.txt": [200, "User-agent: *\nDisallow: /private/\n", "text/plain"],
    [ARTICLE]: [200, FIXTURE_HTML],
  });
  const gone = "https://en.wikipedia.org/wiki/No_such_article";
  const { manifest } = await buildDossiers({
    targets: [
      { id: "craft", label: "Craft & making", urls: [gone, blocked] },
      { id: "engineering", label: "Engineering", urls: [gone, ARTICLE] },
    ],
    outDir: out,
    fetchImpl: r.fetchImpl,
    sleep: r.sleep,
    now: r.now,
  });
  assert.deepEqual(manifest.nodes.craft.missing, [
    { url: gone, status: 404, reason: "http 404" },
    { url: blocked, status: -1, reason: "blocked by robots.txt" },
  ]);
  assert.equal(manifest.nodes.craft.file, null);
  assert.equal(manifest.nodes.craft.sha256, null);
  assert.equal(manifest.nodes.craft.passages, 0);
  assert.equal(fs.existsSync(dossierPath(out, "craft")), false);
  assert.ok(!r.log.some((l) => l.url === blocked), "a robots-refused page is never requested");

  const eng = JSON.parse(fs.readFileSync(dossierPath(out, "engineering"), "utf8"));
  assert.deepEqual(eng.missing, [{ url: gone, status: 404, reason: "http 404" }]);
  assert.equal(eng.sources.length, 1);
  assert.equal(manifest.nodes.engineering.passages, 5);
  assert.deepEqual(validateManifest(manifest), []);
});

test("at most 120 passages per node, in document order, and later seeds are not fetched once full", async () => {
  const out = tmpDir();
  const a = "https://en.wikipedia.org/wiki/Alpha";
  const b = "https://en.wikipedia.org/wiki/Beta";
  const c = "https://en.wikipedia.org/wiki/Gamma";
  const r = rig({
    "https://en.wikipedia.org/robots.txt": [200, WIKI_ROBOTS, "text/plain"],
    [a]: [200, bigArticle("Alpha", 100)],
    [b]: [200, bigArticle("Beta", 100)],
    [c]: [200, bigArticle("Gamma", 100)],
  });
  const { dossiers } = await buildDossiers({
    targets: [{ id: "history", label: "History", urls: [a, b, c] }],
    outDir: out,
    fetchImpl: r.fetchImpl,
    sleep: r.sleep,
    now: r.now,
  });
  const d = dossiers[0];
  assert.equal(MAX_PASSAGES_PER_NODE, 120);
  assert.equal(d.passages.length, 120);
  assert.equal(d.passages.filter((p) => p.text.includes("source Alpha")).length, 100);
  assert.equal(d.passages.filter((p) => p.text.includes("source Beta")).length, 20);
  assert.match(d.passages[0].text, /^Paragraph 0 of source Alpha/);
  assert.match(d.passages[100].text, /^Paragraph 0 of source Beta/);
  assert.match(d.passages[119].text, /^Paragraph 19 of source Beta/);
  assert.deepEqual(d.sources.map((s) => s.url), [a, b]);
  assert.ok(!r.log.some((l) => l.url === c), "the node was full before Gamma");
  assert.deepEqual(validateDossier(d), []);
});

test("the builder refuses a passage that is not a verbatim slice and writes nothing", async () => {
  const out = tmpDir();
  const r = rig({ "https://en.wikipedia.org/robots.txt": [200, WIKI_ROBOTS, "text/plain"], [ARTICLE]: [200, FIXTURE_HTML] });
  const retype = (text) => [{ text: text.slice(0, 60).replace("Larkspur", "Larksp0r"), offset: 0 }];
  await assert.rejects(
    buildDossiers({
      targets: [{ id: "engineering", label: "Engineering", urls: [ARTICLE] }],
      outDir: out,
      fetchImpl: r.fetchImpl,
      sleep: r.sleep,
      now: r.now,
      passagesFor: (text) => retype(text.slice(text.indexOf("The Larkspur"))),
    }),
    VerbatimError
  );
  assert.deepEqual(fs.readdirSync(out), []);
});

test("the manifest merges across runs, and a rebuilt node with no passage loses its stale file", async () => {
  const out = tmpDir();
  const routes = { "https://en.wikipedia.org/robots.txt": [200, WIKI_ROBOTS, "text/plain"], [ARTICLE]: [200, FIXTURE_HTML] };
  const run = (targets, rr = rig(routes)) => buildDossiers({ targets, outDir: out, fetchImpl: rr.fetchImpl, sleep: rr.sleep, now: rr.now });
  await run([{ id: "engineering", label: "Engineering", urls: [ARTICLE] }]);
  await run([{ id: "history", label: "History", urls: [ARTICLE] }]);
  let m = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
  assert.deepEqual(Object.keys(m.nodes).sort(), ["engineering", "history"]);
  for (const [id, e] of Object.entries(m.nodes)) {
    assert.equal(e.sha256, sha256(fs.readFileSync(path.join(out, e.file))), id);
    assert.equal(e.passages, JSON.parse(fs.readFileSync(path.join(out, e.file), "utf8")).passages.length);
  }
  // The article is gone on the next build of "history".
  await run([{ id: "history", label: "History", urls: [ARTICLE] }], rig({ "https://en.wikipedia.org/robots.txt": [200, WIKI_ROBOTS, "text/plain"] }));
  m = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
  assert.equal(m.nodes.history.file, null);
  assert.equal(fs.existsSync(dossierPath(out, "history")), false);
  assert.equal(m.nodes.engineering.passages, 5, "other nodes' entries are kept");
  assert.deepEqual(validateManifest(m), []);
});

test("the builder never constructs a Wikipedia /w/ or /api/ URL, for any real taxonomy node", () => {
  const nodes = loadTaxonomyNodes();
  assert.ok(nodes.length > 100);
  const seeds = loadSeeds(undefined, { nodeIds: new Set(nodes.map((n) => n.id)) });
  for (const node of nodes) {
    for (const url of titlesForNode(node, seeds)) {
      const u = new URL(url);
      assert.equal(u.protocol, "https:");
      if (u.hostname.endsWith("wikipedia.org")) {
        assert.equal(u.hostname, "en.wikipedia.org");
        assert.match(u.pathname, /^\/wiki\/[^/]+$/, `${node.id}: ${url}`);
        assert.doesNotMatch(u.pathname, /^\/(w|api)\//);
        assert.equal(u.search, "");
      }
    }
  }
  assert.equal(titlesForNode({ id: "engineering/energy-fusion", label: "Fusion & energy systems" })[0], "https://en.wikipedia.org/wiki/Fusion_%26_energy_systems");
  // Titles that would leave /wiki/ are refused, not normalised.
  for (const bad of ["..", ".", "  "]) assert.throws(() => wikiUrlForTitle(bad), SeedError);
  assert.equal(new URL(wikiUrlForTitle("../w/api.php")).pathname, "/wiki/..%2Fw%2Fapi.php");
  for (const bad of [
    "https://en.wikipedia.org/w/index.php?title=Fusion",
    "https://en.wikipedia.org/w/api.php?action=parse",
    "https://en.wikipedia.org/api/rest_v1/page/html/Fusion",
    "https://de.wikipedia.org/API/x",
    "https://en.wikipedia.org/wiki/Fusion?action=raw",
    "http://example.org/a",
  ]) {
    assert.throws(() => assertSeedUrl(bad), SeedError, bad);
  }
});

test("a /w/ URL handed straight to the builder is refused before any request", async () => {
  const r = rig({});
  await assert.rejects(
    buildDossiers({
      targets: [{ id: "engineering", label: "Engineering", urls: ["https://en.wikipedia.org/w/index.php?title=Fusion&action=raw"] }],
      outDir: tmpDir(),
      fetchImpl: r.fetchImpl,
      sleep: r.sleep,
      now: r.now,
    }),
    SeedError
  );
  assert.deepEqual(r.log, []);
});

test("seeds: committed seeds.json is valid; a Wikipedia URL overrides the label, others are extras", () => {
  const nodes = loadTaxonomyNodes();
  const ids = new Set(nodes.map((n) => n.id));
  assert.doesNotThrow(() => loadSeeds(undefined, { nodeIds: ids }));
  const node = { id: "engineering/energy-fusion", label: "Fusion & energy systems" };
  const seeds = parseSeeds(
    {
      _notes: "comment keys are skipped",
      "engineering/energy-fusion": ["https://en.wikipedia.org/wiki/Fusion_power", "https://www.iter.org/proj/inafewlines"],
      engineering: ["https://www.iter.org/proj/inafewlines"],
    },
    { nodeIds: ids }
  );
  assert.deepEqual(titlesForNode(node, seeds), ["https://en.wikipedia.org/wiki/Fusion_power", "https://www.iter.org/proj/inafewlines"]);
  assert.deepEqual(titlesForNode({ id: "engineering", label: "Engineering" }, seeds), [
    "https://en.wikipedia.org/wiki/Engineering",
    "https://www.iter.org/proj/inafewlines",
  ]);
  assert.throws(() => parseSeeds({ "not/a-node": ["https://example.org/"] }, { nodeIds: ids }), /not a taxonomy node/);
  assert.throws(() => parseSeeds({ engineering: "https://example.org/" }, { nodeIds: ids }), /array of URL strings/);
  assert.throws(() => parseSeeds({ engineering: ["https://en.wikipedia.org/w/index.php?title=X"] }, { nodeIds: ids }), /disallowed by robots/);
  // Every taxonomy id fits the dossier schema's node_id pattern, and file stems are unique.
  const pattern = new RegExp(DOSSIER_SCHEMA.properties.node_id.pattern);
  for (const id of ids) assert.match(id, pattern);
  assert.equal(new Set([...ids].map(safeNodeId)).size, ids.size);
});

test("schema.mjs rejects a source without a license, an over-cap passage and a malformed docId", () => {
  const good = {
    version: 1,
    node_id: "engineering",
    label: "Engineering",
    built_at: "2026-10-12T08:00:00.000Z",
    builder: "code",
    sources: [{ sourceId: "0123456789ab", url: ARTICLE, publication: "Wikipedia", title: "T", retrievedAt: "2026-10-12T08:00:00.000Z", sha256: "a".repeat(64), license: "CC BY-SA 4.0" }],
    passages: [{ docId: "dossier:engineering:0123456789ab:0", sourceId: "0123456789ab", text: "Some text.", offset: 0 }],
    missing: [],
  };
  assert.deepEqual(validateDossier(good), []);
  const noLicense = structuredClone(good);
  delete noLicense.sources[0].license;
  assert.ok(validateDossier(noLicense).some((e) => /missing license/.test(e)));
  const long = structuredClone(good);
  long.passages[0].text = "x".repeat(1501);
  assert.ok(validateDossier(long).some((e) => /longer than 1500/.test(e)));
  const badId = structuredClone(good);
  badId.passages[0].docId = "engineering:0";
  assert.ok(validateDossier(badId).some((e) => /docId/.test(e)));
  const extra = structuredClone(good);
  extra.summary = "a model's retelling";
  assert.ok(validateDossier(extra).some((e) => /unexpected summary/.test(e)));
  // The GV-65 selection pass records its model and time; that file validates.
  const selected = structuredClone(good);
  Object.assign(selected, { builder: "qwen-select", model: "local-worker", selected_at: "2026-10-13T02:00:00.000Z" });
  selected.passages[0].contested = true;
  assert.deepEqual(validateDossier(selected), []);
  assert.ok(validateDossier({ ...selected, selected_at: "last night" }).some((e) => /selected_at: not a date-time/.test(e)));
});

test("CLI: --all | --node | --subjects, and an offline end-to-end run records a missing label page", async () => {
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(["--all", "--node", "engineering"]), /exclusive/);
  assert.throws(() => parseArgs(["--node"]), /needs a value/);
  assert.throws(() => parseArgs(["--bogus"]), /unknown argument/);
  assert.equal(parseArgs(["--all"]).all, true);
  assert.equal(targetsFor(parseArgs(["--all"])).length, loadTaxonomyNodes().length);
  assert.throws(() => targetsFor(parseArgs(["--node", "nope"])), /not a node/);

  const dir = tmpDir();
  const subjects = path.join(dir, "subjects.json");
  fs.writeFileSync(subjects, JSON.stringify({ "The Larkspur Tokamak": [ARTICLE] }));
  const ts = targetsFor(parseArgs(["--node", "engineering/energy-fusion", "--subjects", subjects]));
  assert.deepEqual(ts, [
    { id: "engineering/energy-fusion", label: "Fusion & energy systems", urls: ["https://en.wikipedia.org/wiki/Fusion_%26_energy_systems"] },
    { id: "subject/the-larkspur-tokamak", label: "The Larkspur Tokamak", urls: [ARTICLE] },
  ]);
  assert.throws(() => subjectTargets({ "A b": [ARTICLE], "a-b": [ARTICLE] }), /share the id/);
  assert.throws(() => subjectTargets({ x: [] }), /lists no URL/);

  const out = path.join(dir, "out");
  const r = rig({ "https://en.wikipedia.org/robots.txt": [200, WIKI_ROBOTS, "text/plain"], [ARTICLE]: [200, FIXTURE_HTML] });
  const lines = [];
  const { manifest } = await main(["--node", "engineering/energy-fusion", "--subjects", subjects, "--out", out], {
    fetchImpl: r.fetchImpl,
    sleep: r.sleep,
    now: r.now,
    hostGate: null,
    log: (s) => lines.push(s),
  });
  assert.equal(manifest.nodes["engineering/energy-fusion"].missing[0].status, 404);
  assert.equal(manifest.nodes["subject/the-larkspur-tokamak"].passages, 5);
  assert.ok(fs.existsSync(path.join(out, "subject__the-larkspur-tokamak.json")));
  assert.match(lines.at(-1), /built 2 node\(s\).*1 with no passage: engineering\/energy-fusion/);
  assert.ok(r.log.every((l) => l.url.startsWith("https://en.wikipedia.org/")));
});
