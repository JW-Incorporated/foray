import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RetrievalService } from "../src/cli/retrievalServer";
import type { CueStore } from "../src/generation/manifestBodySource";
import {
  HydratingCueProvider,
  PrecomputedTextIndex,
  RemoteRetrieval,
  transcriptSourceOfBody,
  type RetrievalFetch,
  type RetrievalFetchInit,
  type RetrievalSearchRequest
} from "../src/generation/retrievalClient";
import { familyGateAllows, nodesForArchiveEntry } from "../src/generation/taxonomyFamily";
import { FileTranscriptCueProvider, type TranscriptCue, type TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";
import { corpusSafeKey } from "../src/generation/transcriptCorpus";
import {
  FileTranscriptTextIndex,
  type TranscriptTextCandidate,
  type TranscriptTextIndex
} from "../src/generation/transcriptTextIndex";

/**
 * GV-29 (docs/roadmap/generation-v2.md, from W3-10): the backend retrieval
 * client. RemoteRetrieval talks to the GV-16 retrieval server through an
 * INJECTED fetch: the fake below routes each request into an in-process
 * `RetrievalService` (the server's own logic, no HTTP) over a synthetic corpus
 * held in memory, or replays canned JSON. Nothing reaches a network, no model
 * is involved, and the only files written are the index caches of the
 * synthetic corpus under a tmp dir.
 *
 * The synthetic episodes sit under REAL catalogue show ids so the taxonomy
 * lineage gate runs over committed data/catalog.json: the two history shows
 * are in the lineage of history/military-ancient, the engineering one is not.
 */

const TOPIC = "history/military-ancient";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gv29-client-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const cue = (text: string, i: number): TranscriptCue => ({ text, start_sec: i * 10, end_sec: i * 10 + 8, speaker: null });

interface Episode {
  row: TranscriptDigestEntry;
  cues: TranscriptCue[];
  stat: { mtimeMs: number; size: number };
}
let n = 0;
function ep(show: string, guid: string, title: string, texts: string[]): Episode {
  n += 1;
  return {
    row: { show_id: show, show_title: show, guid, title, cues: texts.length },
    cues: texts.map(cue),
    stat: { mtimeMs: 1_760_000_000_000 + n, size: 2000 + n * 13 }
  };
}

const EPISODES: Episode[] = [
  ep("hardcore-history", "hh-1", "The Punic wars", ["hannibal crossed the alps with elephants", "carthage and rome fought three wars"]),
  ep("hardcore-history", "hh-2", "Bronze age collapse", ["the sea peoples and the bronze age collapse", "hannibal is not in this one"]),
  ep("fall-of-civilizations", "https://example.com/foc/ep-3-rome/", "Rome", ["the fall of rome and the legions", "elephants at the gates of rome"]),
  ep("titans-of-nuclear", "tn-1", "Fusion", ["fusion reactors and the tokamak", "elephants are not reactors"]),
  ep("titans-of-nuclear", "tn-2", "Fission", ["fission and the legions of engineers", "rome was not built with uranium"])
];
const ARCHIVE: TranscriptDigestEntry[] = EPISODES.map((e) => e.row);
const keyOf = (e: TranscriptDigestEntry): string => `${e.show_id}\u0000${e.guid}`;
const lineageIsUsable = (entry: TranscriptDigestEntry): boolean => familyGateAllows(TOPIC, nodesForArchiveEntry(entry));

function memoryStore(): CueStore & { bodyStat(entry: TranscriptDigestEntry): { mtimeMs: number; size: number } | null } {
  const byKey = new Map(EPISODES.map((e) => [keyOf(e.row), e]));
  return {
    getCues: (entry) => byKey.get(keyOf(entry))?.cues ?? null,
    readCuesUncached: (entry) => byKey.get(keyOf(entry))?.cues ?? null,
    transcriptSource: (entry) => (byKey.has(keyOf(entry)) ? "asr-local" : null),
    bodyStat: (entry) => byKey.get(keyOf(entry))?.stat ?? null
  };
}

const quiet = { info: () => undefined, error: () => undefined };
let serviceCount = 0;
function service(): RetrievalService {
  serviceCount += 1;
  return new RetrievalService({
    loadArchive: () => ({ rows: ARCHIVE, generatedAt: null }),
    loadManifest: () => null,
    createCueStore: memoryStore,
    indexRoot: path.join(tmp, `index-${serviceCount}`),
    logger: quiet
  });
}

/** The same search, run locally: what every remote answer must equal. */
function localIndex(): FileTranscriptTextIndex {
  return new FileTranscriptTextIndex({ archive: ARCHIVE, bodies: memoryStore(), cache: false });
}

interface Call {
  method: string;
  url: URL;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}
type Reply = { status?: number; json: unknown } | "hang" | "network-error";

/**
 * The fake fetch. `route` may answer a request itself (canned JSON, a hang, a
 * refusal); otherwise it goes to the in-process server. Tracks requests in
 * flight so the hydration cap can be asserted.
 */
function fakeFetch(options: { svc?: RetrievalService; route?: (call: Call) => Reply | undefined; delayMs?: number } = {}) {
  const calls: Call[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchFn: RetrievalFetch = async (url: string, init: RetrievalFetchInit) => {
    const call: Call = {
      method: init.method,
      url: new URL(url),
      body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      headers: init.headers
    };
    calls.push(call);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      let reply = options.route?.(call);
      if (reply === undefined) reply = serve(options.svc, call);
      if (reply === "network-error") throw new TypeError("fetch failed");
      if (reply === "hang") return await new Promise<never>(() => undefined);
      const status = reply.status ?? 200;
      const text = JSON.stringify(reply.json);
      return { ok: status >= 200 && status < 300, status, text: async () => text };
    } finally {
      inFlight -= 1;
    }
  };
  return { fetchFn, calls, maxInFlight: () => maxInFlight };
}

function serve(svc: RetrievalService | undefined, call: Call): Reply {
  if (!svc) return { status: 500, json: { error: "no server" } };
  try {
    const route = call.url.pathname;
    if (route === "/v1/episodes") return { json: svc.episodes() };
    if (route === "/v1/scopes") return { json: svc.createScope(call.body?.episodes) };
    if (route === "/v1/search") return { json: { results: svc.search(call.body?.scopeId, call.body?.queries) } };
    if (route === "/v1/cues") return { json: svc.cues(call.url.searchParams.get("show_id"), call.url.searchParams.get("guid")) };
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500;
    return { status, json: { error: String(error) } };
  }
  return { status: 404, json: { error: "not found" } };
}

function client(fetchFn: RetrievalFetch, extra: Partial<ConstructorParameters<typeof RemoteRetrieval>[0]> = {}): RemoteRetrieval {
  /* https: the client refuses to send a token over plain http to any host
     but this machine (GV-95, from the GV-29 review). */
  return new RemoteRetrieval({ baseUrl: "https://retrieval.test/", token: "t0ken", fetchFn, archive: ARCHIVE, ...extra });
}

/** A candidate list in the comparable shape (entry by key, numbers exact). */
const view = (list: TranscriptTextCandidate[]) =>
  list.map((c) => ({ key: keyOf(c.entry), score: c.score, matchedTerms: c.matchedTerms, rank: c.rank, idf: c.idf ? [...c.idf] : null }));

const LINEAGE_QUERIES = ["hannibal elephants alps", "rome legions", "bronze age collapse sea peoples", "the the and"];
const ALL_QUERIES = ["elephants rome", "fusion tokamak reactors legions"];

describe("RemoteRetrieval + PrecomputedTextIndex: prepared answers equal a local search", () => {
  it("the synthetic lineage is what the taxonomy says: two history shows in, the engineering show out", () => {
    expect(ARCHIVE.filter(lineageIsUsable).map((e) => e.show_id)).toEqual(["hardcore-history", "hardcore-history", "fall-of-civilizations"]);
  });

  it("lineage scope: every prepared (text, limit) search returns exactly the local candidates, scores, ranks and idf", async () => {
    /* MUTATION THAT KILLS THIS: register the lineage scope as "all" in
       prepareScope (the engineering show then leaks into lineage answers), or
       map candidates by guid alone. Ran the first: red. */
    const fake = fakeFetch({ svc: service() });
    const retrieval = client(fake.fetchFn);
    expect(await retrieval.prepareScope(TOPIC)).toBe(true);
    const requests: RetrievalSearchRequest[] = [];
    for (const text of LINEAGE_QUERIES) for (const limit of [1, 8]) requests.push({ scope: "lineage", text, limit });
    expect(await retrieval.prepare(requests)).toBe(requests.length);
    const index = new PrecomputedTextIndex(retrieval);
    const local = localIndex();
    for (const { text, limit } of requests) {
      const remote = index.search(text, { limit, isUsable: lineageIsUsable });
      expect(view(remote)).toEqual(view(local.search(text, { limit, isUsable: lineageIsUsable })));
      expect(remote.every((c) => ARCHIVE.includes(c.entry))).toBe(true);
    }
    /* "elephants" is also spoken in the engineering show, which the lineage scope keeps out. */
    expect(index.search("hannibal elephants alps", { limit: 8, isUsable: lineageIsUsable }).map((c) => c.entry.guid)).toEqual([
      "hh-1",
      "hh-2",
      ARCHIVE[2]!.guid
    ]);
    expect(index.stats()).toMatchObject({ prepared: 8, hits: 9, misses: 0, degraded: 0, unmapped: 0 });
  });

  it("'all' scope: a search with no isUsable reads the 'all' answer, equal to an unfiltered local search; the scope follows isUsable", async () => {
    /* MUTATION THAT KILLS THIS: pick the scope the other way round (isUsable
       present -> 'all'). Ran it: red. */
    const fake = fakeFetch({ svc: service() });
    const retrieval = client(fake.fetchFn);
    await retrieval.prepareScope(TOPIC);
    await retrieval.prepare(ALL_QUERIES.map((text) => ({ scope: "all" as const, text, limit: 50 })));
    const index = new PrecomputedTextIndex(retrieval);
    const local = localIndex();
    for (const text of ALL_QUERIES) expect(view(index.search(text, { limit: 50 }))).toEqual(view(local.search(text, { limit: 50 })));
    expect(index.search("elephants rome", { limit: 50 }).map((c) => c.entry.show_id)).toContain("titans-of-nuclear");
    /* The same text with a predicate is a lineage question nobody prepared. */
    expect(index.search("elephants rome", { limit: 50, isUsable: lineageIsUsable })).toEqual([]);
    expect(index.stats()).toMatchObject({ hits: 3, misses: 1 });
  });

  it("carries the idf: one shared map per answer, and the idf of a zero-hit query is kept", async () => {
    /* MUTATION THAT KILLS THIS: build a fresh idf Map per candidate, or drop the
       result's idf when it has no candidates. Ran the second: red. */
    const retrieval = client(fakeFetch({ svc: service() }).fetchFn);
    await retrieval.prepareScope(TOPIC);
    await retrieval.prepare([
      { scope: "lineage", text: "rome legions", limit: 8 },
      { scope: "lineage", text: "tokamak", limit: 8 }
    ]);
    const hits = new PrecomputedTextIndex(retrieval).search("rome legions", { limit: 8, isUsable: lineageIsUsable });
    expect(hits.length).toBe(2);
    expect(hits[0]?.idf).toBe(hits[1]?.idf);
    expect([...(hits[0]?.idf ?? [])]).toEqual([...localIndex().searchWithIdf("rome legions", { isUsable: lineageIsUsable }).idf]);
    /* tokamak exists only in the engineering show: no lineage hit, idf still there? The local rule says the
       idf map is filled only from matched terms, so it is empty, and the stored answer says the same. */
    const zero = retrieval.answerFor("lineage", 8, "tokamak");
    expect(zero?.candidates).toEqual([]);
    expect([...(zero?.idf ?? [])]).toEqual([...localIndex().searchWithIdf("tokamak", { limit: 8, isUsable: lineageIsUsable }).idf]);
    /* A canned server idf with zero candidates survives the mapping. */
    const canned = client(
      fakeFetch({
        route: (call) =>
          call.url.pathname === "/v1/scopes"
            ? { json: { scopeId: "s" } }
            : call.url.pathname === "/v1/search"
              ? { json: { results: [{ candidates: [], idf: { tokamak: 1.25 } }] } }
              : undefined
      }).fetchFn
    );
    await canned.prepareScope(TOPIC);
    await canned.prepare([{ scope: "all", text: "tokamak", limit: 8 }]);
    expect([...(canned.answerFor("all", 8, "tokamak")?.idf ?? [])]).toEqual([["tokamak", 1.25]]);
  });

  it("filters the stored list by isUsable, slices to limit and re-ranks; unknown episodes are dropped and counted; hints ride on a side map", async () => {
    /* MUTATION THAT KILLS THIS: return the stored list unfiltered, or skip the
       slice. Ran both: red. */
    const [a, b, c] = [ARCHIVE[0]!, ARCHIVE[2]!, ARCHIVE[1]!];
    const wire = (e: TranscriptDigestEntry, score: number, rank: number) => ({ show_id: e.show_id, guid: e.guid, score, matchedTerms: 2, rank });
    const fake = fakeFetch({
      route: (call) => {
        if (call.url.pathname === "/v1/scopes") return { json: { scopeId: `scope-${String(call.body?.episodes === "all")}` } };
        if (call.url.pathname === "/v1/search")
          return {
            json: {
              results: [
                {
                  candidates: [
                    { ...wire(a, 3, 0), via: "both", passage: { passageId: "p1" } },
                    { show_id: "nobody", guid: "ghost", score: 2.5, matchedTerms: 2, rank: 1 },
                    wire(b, 2, 2),
                    wire(c, 1, 3)
                  ],
                  idf: { rome: 0.5 }
                }
              ]
            }
          };
        return undefined;
      }
    });
    const retrieval = client(fake.fetchFn, { mode: "hybrid" });
    await retrieval.prepareScope(TOPIC);
    await retrieval.prepare([{ scope: "lineage", text: "rome", limit: 2 }]);
    const index = new PrecomputedTextIndex(retrieval);
    const onlyHardcore = (e: TranscriptDigestEntry): boolean => e.show_id === "hardcore-history";
    expect(index.search("rome", { limit: 2, isUsable: onlyHardcore }).map((x) => [x.entry.guid, x.rank])).toEqual([
      ["hh-1", 0],
      ["hh-2", 1]
    ]);
    expect(index.search("rome", { limit: 2, isUsable: () => true }).map((x) => x.entry.guid)).toEqual(["hh-1", b.guid]);
    expect(retrieval.stats().unmapped).toBe(1);
    expect(retrieval.hintsFor("lineage", 2, "rome").get(a)).toEqual({ via: "both", passage: { passageId: "p1" } });
    expect(retrieval.hintsFor("lineage", 2, "rome").has(b)).toBe(false);
    const search = fake.calls.find((x) => x.url.pathname === "/v1/search");
    expect(search?.body).toMatchObject({ scopeId: "scope-false", mode: "hybrid" });
    expect(search?.headers.authorization).toBe("Bearer t0ken");
  });

  it("dedups and batches: one request per scope per 256 queries, nothing re-sent, and bm25 sends no mode", async () => {
    /* MUTATION THAT KILLS THIS: drop the already-stored skip in prepare (the
       second prepare re-sends every query). Ran it: red. */
    const fake = fakeFetch({ svc: service() });
    const retrieval = client(fake.fetchFn);
    await retrieval.prepareScope(TOPIC);
    const requests: RetrievalSearchRequest[] = [];
    for (let i = 0; i < 300; i += 1) requests.push({ scope: "lineage", text: `rome legions ${i}`, limit: 8 });
    requests.push(...requests.slice(0, 50));
    requests.push({ scope: "all", text: "rome legions 1", limit: 8 }, { scope: "all", text: "rome legions 1", limit: 8 });
    expect(await retrieval.prepare(requests)).toBe(301);
    const searches = fake.calls.filter((x) => x.url.pathname === "/v1/search");
    expect(searches.map((x) => (x.body?.queries as unknown[]).length).sort((p, q) => p - q)).toEqual([1, 44, 256]);
    expect(searches.every((x) => !("mode" in (x.body ?? {})))).toBe(true);
    const sent = searches.flatMap((x) => (x.body?.queries as Array<{ text: string }>).map((q) => `${String(x.body?.scopeId)}|${q.text}`));
    expect(new Set(sent).size).toBe(sent.length);
    expect(await retrieval.prepare(requests)).toBe(0);
    expect(fake.calls.filter((x) => x.url.pathname === "/v1/search").length).toBe(3);
    /* Limits the server refuses are never sent; a non-positive one is answered locally, as the index does. */
    expect(await retrieval.prepare([{ scope: "all", text: "x", limit: 500 }, { scope: "all", text: "x", limit: 0 }])).toBe(1);
    expect(retrieval.stats().unprepared).toBe(1);
    expect(new PrecomputedTextIndex(retrieval).search("x", { limit: 0 })).toEqual([]);
  });

  it("an unprepared (scope, limit, text) key falls back and is counted as a miss", async () => {
    /* MUTATION THAT KILLS THIS: key answers by text alone (drop the limit
       from precomputedKey). Ran it: red. */
    const retrieval = client(fakeFetch({ svc: service() }).fetchFn);
    await retrieval.prepareScope(TOPIC);
    await retrieval.prepare([{ scope: "lineage", text: "rome legions", limit: 8 }]);
    const asked: string[] = [];
    const fallback: TranscriptTextIndex = {
      enabled: true,
      search: (q) => {
        asked.push(q);
        return [];
      }
    };
    const index = new PrecomputedTextIndex(retrieval, { fallback });
    index.search("rome legions", { limit: 1, isUsable: lineageIsUsable });
    index.search("rome  legions", { limit: 8, isUsable: lineageIsUsable });
    index.search("rome legions", { limit: 8 });
    expect(asked).toEqual(["rome legions", "rome  legions", "rome legions"]);
    expect(index.stats()).toMatchObject({ hits: 0, misses: 3 });
    expect(new PrecomputedTextIndex(retrieval).search("never asked")).toEqual([]);
  });

  it("degrades, never throws: a timeout, a refused connection or an HTTP error is recorded and the searches fall back", async () => {
    /* MUTATION THAT KILLS THIS: drop the deadline race in call() (a deaf fetch
       then never settles and the test times out), or rethrow in the catch.
       Ran the first: red. */
    const hanging = client(
      fakeFetch({ svc: service(), route: (call) => (call.url.pathname === "/v1/search" ? "hang" : undefined) }).fetchFn,
      { timeoutMs: 30 }
    );
    expect(await hanging.prepareScope(TOPIC)).toBe(true);
    expect(await hanging.prepare([{ scope: "lineage", text: "secret claim about hannibal", limit: 8 }])).toBe(0);
    expect(new PrecomputedTextIndex(hanging).search("secret claim about hannibal", { isUsable: lineageIsUsable })).toEqual([]);
    expect(hanging.stats()).toMatchObject({ degraded: 1, misses: 1, reasons: ["search: timeout after 30 ms"] });

    const refused = client(fakeFetch({ route: () => "network-error" }).fetchFn);
    expect(await refused.prepareScope(TOPIC)).toBe(false);
    expect(await refused.loadManifest()).toBe(false);
    expect(await refused.prepare([{ scope: "lineage", text: "secret claim", limit: 8 }])).toBe(0);
    expect(await refused.hydrate([ARCHIVE[0]!])).toBe(0);
    expect(refused.bodyStat(ARCHIVE[0]!)).toBeNull();
    const reasons = refused.stats().reasons;
    expect(reasons).toEqual([
      "scopes: network error (TypeError)",
      "scopes: network error (TypeError)",
      "episodes: network error (TypeError)",
      "search: scope 'lineage' is not registered",
      "cues: network error (TypeError)"
    ]);
    expect(reasons.join(" ")).not.toMatch(/secret/);

    const broken = client(fakeFetch({ route: () => ({ status: 500, json: { error: "x" } }) }).fetchFn);
    expect(await broken.loadManifest()).toBe(false);
    expect(broken.stats().reasons).toEqual(["episodes: HTTP 500"]);
  });

  it("never sends the bearer token over plain http to a non-loopback host; https, loopback http and a token-less client are sent", async () => {
    /* GV-95 (GV-29 review, #1286 wave 5). MUTATION THAT KILLS THIS: drop the
       tokenInClear check in call() (the LAN client then sends its token).
       Ran it: red. */
    const lanFake = fakeFetch({ svc: service() });
    const lan = new RemoteRetrieval({ baseUrl: "http://retrieval.lan:7311", token: "t0ken", fetchFn: lanFake.fetchFn, archive: ARCHIVE });
    expect(await lan.loadManifest()).toBe(false);
    expect(await lan.prepareScope(TOPIC)).toBe(false);
    expect(await lan.hydrate([ARCHIVE[0]!])).toBe(0);
    expect(await lan.health()).toBeNull();
    expect(lanFake.calls).toHaveLength(0);
    expect(lan.stats().reasons[0]).toBe("episodes: refused: the bearer token would travel over plain http to a non-loopback host (use https)");
    expect(lan.stats().reasons.join(" ")).not.toMatch(/t0ken/);

    for (const baseUrl of ["https://retrieval.example", "http://127.0.0.1:7311", "http://localhost:7311", "http://[::1]:7311"]) {
      const fake = fakeFetch({ svc: service() });
      const r = new RemoteRetrieval({ baseUrl, token: "t0ken", fetchFn: fake.fetchFn, archive: ARCHIVE });
      expect(await r.loadManifest()).toBe(true);
      expect(fake.calls[0]!.headers.authorization).toBe("Bearer t0ken");
    }
    /* No token, nothing secret to leak: plain http to the LAN is sent. */
    const open = fakeFetch({ svc: service() });
    const tokenless = new RemoteRetrieval({ baseUrl: "http://retrieval.lan:7311", fetchFn: open.fetchFn, archive: ARCHIVE });
    expect(await tokenless.loadManifest()).toBe(true);
    expect(open.calls[0]!.headers.authorization).toBeUndefined();
  });

  it("answers() tells a stored answer from a miss, without searching or counting; a miss with a real fallback is answered", async () => {
    /* GV-95 (GV-29 review: a miss read as a search that ran). MUTATION THAT
       KILLS THIS: return true from answers() unconditionally. Ran it: red. */
    const retrieval = client(fakeFetch({ svc: service() }).fetchFn);
    await retrieval.prepareScope(TOPIC);
    await retrieval.prepare([{ scope: "lineage", text: "rome legions", limit: 8 }]);
    const index = new PrecomputedTextIndex(retrieval);
    expect(index.answers("rome legions", { limit: 8, isUsable: lineageIsUsable })).toBe(true);
    expect(index.answers("rome legions", { limit: 1, isUsable: lineageIsUsable })).toBe(false);
    expect(index.answers("rome legions", { limit: 8 })).toBe(false);
    expect(index.answers("never asked")).toBe(false);
    expect(index.stats()).toMatchObject({ hits: 0, misses: 0 });
    expect(new PrecomputedTextIndex(retrieval, { fallback: localIndex() }).answers("never asked")).toBe(true);
  });

  it("debug builds check once per lineage scope that the caller's predicate admits exactly that scope", async () => {
    /* MUTATIONS THAT KILL THIS: compare sizes only (the swapped predicate has
       the same size); verify once per index instead of once per prepareScope
       (the reused index never checks the second scope, which stays at 1). Ran
       both: red. */
    const retrieval = client(fakeFetch({ svc: service() }).fetchFn);
    await retrieval.prepareScope(TOPIC);
    await retrieval.prepare([{ scope: "lineage", text: "rome", limit: 8 }]);
    new PrecomputedTextIndex(retrieval, { verifyScopes: true }).search("rome", { limit: 8, isUsable: lineageIsUsable });
    expect(retrieval.stats().scopeMismatches).toBe(0);
    /* Same size, different set: the engineering show swapped in for one history show. */
    const swapped = (e: TranscriptDigestEntry): boolean => e.show_id === "titans-of-nuclear" || e.guid === "hh-1";
    const index = new PrecomputedTextIndex(retrieval, { verifyScopes: true });
    index.search("rome", { limit: 8, isUsable: swapped });
    index.search("rome", { limit: 8, isUsable: swapped });
    expect(retrieval.stats().scopeMismatches).toBe(1);
    /* The next Foray: a new lineage scope, the same index. The history
       predicate no longer matches the engineering topic's scope, and the
       check runs again for it (once). */
    await retrieval.prepareScope("engineering/energy-fusion");
    await retrieval.prepare([{ scope: "lineage", text: "rome", limit: 8 }]);
    index.search("rome", { limit: 8, isUsable: lineageIsUsable });
    index.search("rome", { limit: 8, isUsable: lineageIsUsable });
    expect(retrieval.stats().scopeMismatches).toBe(2);
  });

  it("prepareScope drops the previous Foray's answers: its lineage keys miss and fall back", async () => {
    /* MUTATION THAT KILLS THIS: remove `this.answers.clear()` from
       prepareScope (the next topic's lineage search reads the history topic's
       answer, whose key has no topic in it). Ran it: red. */
    const retrieval = client(fakeFetch({ svc: service() }).fetchFn);
    await retrieval.prepareScope(TOPIC);
    await retrieval.prepare([
      { scope: "lineage", text: "rome legions", limit: 8 },
      { scope: "all", text: "rome legions", limit: 8 }
    ]);
    expect(retrieval.answerFor("lineage", 8, "rome legions")?.candidates.length).toBe(2);
    expect(await retrieval.prepareScope("engineering/energy-fusion")).toBe(true);
    expect(retrieval.answerFor("lineage", 8, "rome legions")).toBeUndefined();
    expect(retrieval.answerFor("all", 8, "rome legions")).toBeUndefined();
    expect(retrieval.stats().prepared).toBe(0);
    const asked: string[] = [];
    const fallback: TranscriptTextIndex = {
      enabled: true,
      search: (q) => {
        asked.push(q);
        return [];
      }
    };
    const engineering = (e: TranscriptDigestEntry): boolean => familyGateAllows("engineering/energy-fusion", nodesForArchiveEntry(e));
    const index = new PrecomputedTextIndex(retrieval, { fallback });
    expect(index.search("rome legions", { limit: 8, isUsable: engineering })).toEqual([]);
    expect(asked).toEqual(["rome legions"]);
    expect(index.stats()).toMatchObject({ hits: 0, misses: 1 });
    /* Asked again under the new scope, the answer is the engineering show's. */
    await retrieval.prepare([{ scope: "lineage", text: "rome legions", limit: 8 }]);
    expect(index.search("rome legions", { limit: 8, isUsable: engineering }).map((c) => c.entry.show_id)).toEqual(["titans-of-nuclear"]);
  });
});

describe("HydratingCueProvider: bodies fetched ahead, read synchronously", () => {
  it("bodyStat answers from the manifest (null for an unknown episode or before the manifest loads)", async () => {
    /* MUTATION THAT KILLS THIS: answer bodyStat from the hydrated bodies
       instead of the manifest. Ran it: red. */
    const retrieval = client(fakeFetch({ svc: service() }).fetchFn);
    const provider = new HydratingCueProvider(retrieval);
    expect(provider.bodyStat(ARCHIVE[0]!)).toBeNull();
    expect(await retrieval.loadManifest()).toBe(true);
    for (const e of EPISODES) expect(provider.bodyStat(e.row)).toEqual(e.stat);
    expect(provider.bodyStat({ ...ARCHIVE[0]!, guid: "not-an-episode" })).toBeNull();
    expect(provider.bodyStat({ ...ARCHIVE[0]!, show_id: "unknown-show" })).toBeNull();
    /* The permalink guid maps through the locate rule's writer key. */
    expect(retrieval.episodeFor(ARCHIVE[2]!)?.guid).toBe(ARCHIVE[2]!.guid);
    /* A manifest row with no archive entry is still a manifest row; a malformed one is counted. */
    const odd = client(fakeFetch({ route: () => ({ json: [{ show_id: "x", guid: "y" }] }) }).fetchFn);
    await odd.loadManifest();
    expect(odd.stats().unmapped).toBe(1);
  });

  it("getCues reads hydrated bodies; unhydrated is null and a hydrationMiss; a 404 is 'no body', not a miss", async () => {
    /* MUTATION THAT KILLS THIS: let getCues of an unhydrated entry return null
       without counting. Ran it: red. */
    const fake = fakeFetch({ svc: service() });
    const retrieval = client(fake.fetchFn);
    const provider = new HydratingCueProvider(retrieval);
    const ghost: TranscriptDigestEntry = { ...ARCHIVE[0]!, guid: "ghost" };
    expect(await retrieval.hydrate([ARCHIVE[0]!, ARCHIVE[0]!, ARCHIVE[2]!, ghost])).toBe(2);
    expect(fake.calls.filter((c) => c.url.pathname === "/v1/cues").length).toBe(3);
    expect(fake.calls.every((c) => c.headers["accept-encoding"] === "gzip")).toBe(true);
    expect(provider.getCues(ARCHIVE[0]!)).toEqual(EPISODES[0]!.cues);
    expect(provider.getCues(ARCHIVE[2]!)).toEqual(EPISODES[2]!.cues);
    expect(provider.getCues(ghost)).toBeNull();
    expect(provider.transcriptSource(ghost)).toBeNull();
    expect(retrieval.stats()).toMatchObject({ hydrated: 2, hydrationAbsent: 1, hydrationMisses: 0 });
    expect(provider.getCues(ARCHIVE[1]!)).toBeNull();
    expect(provider.transcriptSource(ARCHIVE[1]!)).toBeNull();
    expect(retrieval.stats().hydrationMisses).toBe(1);
    /* Already held: not fetched again. */
    expect(await retrieval.hydrate([ARCHIVE[0]!])).toBe(0);
    expect(fake.calls.filter((c) => c.url.pathname === "/v1/cues").length).toBe(3);
  });

  it("never has more than 8 hydration requests in flight, across overlapping hydrate calls, and fetches each body once", async () => {
    /* MUTATIONS THAT KILL THIS: skip acquireCuesSlot in hydrateOne (20 in
       flight); restore the old per-call pool of min(concurrency, queue)
       workers (16 in flight once two calls overlap, and the shared guids are
       sent twice); drop the bodiesInFlight lookup (the 10 shared guids are
       requested twice). Ran all three: red. */
    const many: TranscriptDigestEntry[] = Array.from({ length: 20 }, (_, i) => ({ ...ARCHIVE[0]!, guid: `bulk-${i}` }));
    const fake = fakeFetch({ delayMs: 5, route: () => ({ json: { cues: [{ text: "a b c", start_sec: 0, end_sec: 1 }] } }) });
    const retrieval = client(fake.fetchFn);
    expect(await retrieval.hydrate(many)).toBe(20);
    expect(fake.maxInFlight()).toBe(8);

    /* Two calls at once, sharing 10 guids not yet held: still 8 in flight, and
       the shared ones are fetched by whichever call asked first. */
    const overlap = fakeFetch({ delayMs: 5, route: () => ({ json: { cues: [{ text: "a b c", start_sec: 0, end_sec: 1 }] } }) });
    const shared = client(overlap.fetchFn);
    const first = Array.from({ length: 20 }, (_, i) => ({ ...ARCHIVE[0]!, guid: `o-${i}` }));
    const second = Array.from({ length: 20 }, (_, i) => ({ ...ARCHIVE[0]!, guid: `o-${i + 10}` }));
    const [a, b] = await Promise.all([shared.hydrate(first, { pin: false }), shared.hydrate(second)]);
    expect(a + b).toBe(30);
    expect(overlap.maxInFlight()).toBe(8);
    const guids = overlap.calls.map((c) => c.url.searchParams.get("guid"));
    expect(guids.length).toBe(30);
    expect(new Set(guids).size).toBe(30);
    /* A joined body is pinned when the joining call asked for a pin. */
    expect(shared.stats()).toMatchObject({ hydrated: 30, pinned: 20 });
    const provider = new HydratingCueProvider(shared);
    for (const e of [...first, ...second]) expect(provider.getCues(e)).not.toBeNull();
  });

  it("proves the cap: with every reply held, exactly 8 /v1/cues requests are in flight across two hydrate calls, and each released reply admits exactly one more, first queued first", async () => {
    /* GV-95 (GV-29 review: the timing-based test above does not prove the
       limit). Nothing here depends on a clock: every reply is held until the
       test releases it. MUTATIONS THAT KILL THIS: `<=` for `<` in
       acquireCuesSlot (9 in flight); skip acquireCuesSlot (25 in flight);
       hand a freed slot to the newest waiter (pop for shift: o-0's turn goes
       to o-4). Ran all three: red. */
    const held: Array<() => void> = [];
    const started: string[] = [];
    let released = 0;
    const fetchFn: RetrievalFetch = async (url) => {
      started.push(String(new URL(url).searchParams.get("guid")));
      await new Promise<void>((resolve) => held.push(resolve));
      return { ok: true, status: 200, text: async () => JSON.stringify({ cues: [{ text: "a b c", start_sec: 0, end_sec: 1 }] }) };
    };
    const flush = async () => {
      for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    };
    const retrieval = client(fetchFn, { timeoutMs: 60_000 });
    const first = Array.from({ length: 20 }, (_, i) => ({ ...ARCHIVE[0]!, guid: `bulk-${i}` }));
    const second = Array.from({ length: 5 }, (_, i) => ({ ...ARCHIVE[0]!, guid: `o-${i}` }));
    const a = retrieval.hydrate(first);
    await flush();
    expect(started).toEqual(first.slice(0, 8).map((e) => e.guid));
    const b = retrieval.hydrate(second);
    await flush();
    expect(started.length).toBe(8);
    const releaseOne = async () => {
      held.shift()!();
      released += 1;
      await flush();
    };
    await releaseOne();
    expect(started.length).toBe(9);
    expect(started[8]).toBe("bulk-8");
    while (released < 25) {
      expect(started.length - released).toBe(Math.min(8, 25 - released));
      await releaseOne();
    }
    expect(await a).toBe(20);
    expect(await b).toBe(5);
    /* First queued, first served: the second call's bodies went last. */
    expect(started.slice(20)).toEqual(second.map((e) => e.guid));
    expect(new Set(started).size).toBe(25);
  });

  it("pins bodies for the run under a memory bound, evicting least recently used unpinned bodies first", async () => {
    /* MUTATION THAT KILLS THIS: evict the oldest body whether pinned or not
       (b would survive and a pinned a would go first). Ran it: red. */
    const body = { cues: [{ text: "x".repeat(80), start_sec: 0, end_sec: 1 }], source_url: "https://example.com/t" };
    const size = Buffer.byteLength(JSON.stringify(body));
    const fake = fakeFetch({ route: () => ({ json: body }) });
    const retrieval = client(fake.fetchFn, { maxBodyBytes: size * 2 + 1 });
    const provider = new HydratingCueProvider(retrieval);
    const [a, b, c, d] = ["a", "b", "c", "d"].map((g) => ({ ...ARCHIVE[0]!, guid: g }));
    await retrieval.hydrate([a!]);
    await retrieval.hydrate([b!], { pin: false });
    await retrieval.hydrate([c!], { pin: false });
    /* b was the least recently used unpinned body. */
    expect(provider.getCues(b!)).toBeNull();
    expect(provider.getCues(a!)).not.toBeNull();
    expect(retrieval.stats()).toMatchObject({ evictions: 1, evictedPinned: 0, pinned: 1, heldBytes: size * 2 });
    /* End of run: pins drop; a was just read, so c is now the oldest. */
    retrieval.unpinAll();
    provider.getCues(a!);
    await retrieval.hydrate([d!]);
    expect(provider.getCues(c!)).toBeNull();
    expect(provider.getCues(a!)).not.toBeNull();
    expect(retrieval.stats()).toMatchObject({ evictions: 2, evictedPinned: 0, pinned: 1 });
    /* Pins alone over the bound: the oldest pin goes too, and says so. */
    const tight = client(fakeFetch({ route: () => ({ json: body }) }).fetchFn, { maxBodyBytes: size * 2 + 1 });
    await tight.hydrate([a!]);
    await tight.hydrate([b!]);
    await tight.hydrate([c!]);
    expect(tight.stats()).toMatchObject({ evictions: 1, evictedPinned: 1, pinned: 2, heldBytes: size * 2 });
  });

  it("transcriptSource matches FileTranscriptCueProvider's rule on the same body JSON", async () => {
    /* MUTATION THAT KILLS THIS: let the inference win over a stated
       transcript_source, or coerce an out-of-vocabulary one instead of
       throwing. Ran the first: red. */
    const bodies: Record<string, Record<string, unknown>> = {
      publisher: { source_url: "https://example.com/t.vtt" },
      regenerated: { regenerated_from: "raw/show/x.vtt" },
      regeneratedElsewhere: { regenerated_from: "elsewhere/x.vtt" },
      stated: { transcript_source: "apple-podcasts", source_url: "https://example.com/t.vtt" },
      statedNull: { transcript_source: null, source_url: "  " },
      local: {},
      wire: { transcript_source: "publisher" },
      bad: { transcript_source: "made-up" }
    };
    const root = path.join(tmp, "normalized");
    const showDir = path.join(root, "parity-show-0123456789");
    fs.mkdirSync(showDir, { recursive: true });
    const entries = Object.keys(bodies).map((guid) => ({ show_id: "parity-show", show_title: "p", guid, title: guid, cues: 1 }));
    const json = (guid: string) => ({ show_id: "parity-show", guid, cues: [{ text: `cue for ${guid}`, start_sec: 0, end_sec: 2 }], ...bodies[guid] });
    for (const e of entries) fs.writeFileSync(path.join(showDir, `${corpusSafeKey(e.guid)}.json`), JSON.stringify(json(e.guid)));
    const file = new FileTranscriptCueProvider(root);
    const retrieval = new RemoteRetrieval({
      baseUrl: "http://retrieval.test",
      archive: entries,
      fetchFn: fakeFetch({ route: (call) => ({ json: json(String(call.url.searchParams.get("guid"))) }) }).fetchFn
    });
    const provider = new HydratingCueProvider(retrieval);
    await retrieval.hydrate(entries);
    for (const e of entries) {
      expect(provider.getCues(e)).toEqual(file.getCues(e));
      if (e.guid === "bad") {
        expect(() => file.transcriptSource(e)).toThrow(/made-up/);
        expect(() => provider.transcriptSource(e)).toThrow(/made-up/);
        continue;
      }
      expect(provider.transcriptSource(e)).toBe(file.transcriptSource(e));
    }
    expect(entries.map((e) => (e.guid === "bad" ? "throws" : provider.transcriptSource(e)))).toEqual([
      "publisher",
      "publisher",
      "asr-local",
      "apple-podcasts",
      "asr-local",
      "asr-local",
      "publisher",
      "throws"
    ]);
    expect(transcriptSourceOfBody(null)).toBe("asr-local");
  });
});

describe("RemoteRetrieval: the manifest's shows and /healthz (GV-95)", () => {
  it("manifestShows counts each show's manifest rows, sorted by show id; health maps /healthz and degrades to null", async () => {
    /* MUTATION THAT KILLS THIS: count manifestShows from the archive instead
       of the manifest (an archive-only row would count). Ran it: red. */
    const healthz = { indexVersion: 7, shows: 3, episodes: 5, archiveGeneratedAt: "2026-10-01T00:00:00.000Z" };
    const retrieval = client(
      fakeFetch({ svc: service(), route: (call) => (call.url.pathname === "/healthz" ? { json: healthz } : undefined) }).fetchFn,
      { archive: [...ARCHIVE, { ...ARCHIVE[0]!, guid: "archive-only" }] }
    );
    expect(retrieval.manifestShows()).toEqual([]);
    expect(await retrieval.loadManifest()).toBe(true);
    expect(retrieval.manifestShows()).toEqual([
      { dirName: "fall-of-civilizations", showId: "fall-of-civilizations", episodes: 1 },
      { dirName: "hardcore-history", showId: "hardcore-history", episodes: 2 },
      { dirName: "titans-of-nuclear", showId: "titans-of-nuclear", episodes: 2 }
    ]);
    expect(await retrieval.health()).toEqual(healthz);

    const broken = client(fakeFetch({ route: () => ({ status: 500, json: { error: "x" } }) }).fetchFn);
    expect(await broken.health()).toBeNull();
    expect(broken.stats().reasons).toEqual(["healthz: HTTP 500"]);
  });
});

describe("retrievalClient.ts: the module itself", () => {
  it("contains no fs write call and does not import fs", () => {
    /* MUTATION THAT KILLS THIS: add `import * as fs from "fs"` and an
       fs.writeFileSync of a stored answer. Ran it: red. */
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "generation", "retrievalClient.ts"), "utf8");
    expect(source).not.toMatch(/\b(writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|mkdirSync|renameSync|copyFileSync)\b/);
    expect(source).not.toMatch(/from\s+["'](node:)?fs(\/promises)?["']/);
    expect(source).not.toMatch(/require\(\s*["'](node:)?fs["']\s*\)/);
  });
});
