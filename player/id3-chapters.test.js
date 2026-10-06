/* ID3 CHAP/CTOC chapters read from the MP3 itself (#1071).

   Every fixture is hand-built below from the ID3v2.3/2.4 frame layout, so the
   bytes say exactly what each test is about. TO SEE EACH ONE FAIL, the
   one-line mutation is in the test's own comment; all were run (see the PR). */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  parseId3Chapters, tagSize, createId3Reader, MAX_TAG_BYTES, MAX_CHAPTERS, CALL_TIMEOUT_MS,
} from "./id3-chapters.js";

/* ---------- fixture builders ---------- */

function cat(...parts) {
  const arrs = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
const be = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const ss = (n) => [(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f];
const latin1z = (s) => [...[...s].map((c) => c.charCodeAt(0)), 0];
const utf8 = (s) => [...new TextEncoder().encode(s)];

/** Insert 0x00 after every 0xFF — reversible, and what unsync decoding undoes. */
const unsyncEncode = (b) => Uint8Array.from([...b].flatMap((x) => (x === 0xff ? [0xff, 0x00] : [x])));

function frame(v, id, data, { flags = 0, plainSize = false } = {}) {
  const size = data.length;
  return cat(latin1z(id).slice(0, 4), v === 4 && !plainSize ? ss(size) : be(size), [0, flags], data);
}
const tit2 = (s, enc = 3) => cat([enc], enc === 3 ? utf8(s) : latin1z(s).slice(0, -1));
const chap = (v, id, startMs, subs = [], endMs = 0xffffffff) =>
  frame(v, "CHAP", cat(latin1z(id), be(startMs), be(endMs), be(0xffffffff), be(0xffffffff), ...subs));
const titled = (v, id, startMs, title) => chap(v, id, startMs, [frame(v, "TIT2", tit2(title))]);
const ctoc = (v, id, kids, { top = true, ordered = true } = {}) =>
  frame(v, "CTOC", cat(latin1z(id), [(top ? 2 : 0) | (ordered ? 1 : 0), kids.length], ...kids.map(latin1z)));

function tag(v, frames, { flags = 0, padding = 0, ext = null } = {}) {
  let body = cat(...(ext ? [ext] : []), ...frames, new Uint8Array(padding));
  if (v === 3 && flags & 0x80) body = unsyncEncode(body);
  return cat([0x49, 0x44, 0x33, v, 0, flags], ss(body.length), body);
}

/** Three chapters, CTOC in order, CHAPs in order. */
const basic = (v) => tag(v, [
  ctoc(v, "toc", ["c1", "c2", "c3"]),
  titled(v, "c1", 0, "Cold open"),
  titled(v, "c2", 61500, "The interview"),
  titled(v, "c3", 1800000, "Listener mail"),
], { padding: 64 });
const BASIC = [
  { secs: 0, title: "Cold open" },
  { secs: 61.5, title: "The interview" },
  { secs: 1800, title: "Listener mail" },
];

/* ---------- the parser ---------- */

test("v2.3: a CTOC and three CHAPs read as [{secs, title}] in start order", () => {
  /* MUTATION: read CHAP start as `u32(data, p + 4)` (the end time) -> every
     secs is 4294967.295 and this goes red. */
  assert.deepEqual(parseId3Chapters(basic(3)), BASIC);
  assert.equal(tagSize(basic(3)), basic(3).length - 10);
});

test("v2.4: frame sizes are syncsafe, so a subframe of 200 bytes still parses", () => {
  /* A 200-byte TIT2 makes the CHAP's syncsafe size differ from the same four
     bytes read plain (0x148 vs 200). MUTATION: in frames(), read v2.4 sizes
     with `u32` -> the CHAP runs past the tag, is cut, and this goes red. */
  const long = "x".repeat(199);
  const bytes = tag(4, [ctoc(4, "t", ["a", "b"]), titled(4, "a", 1000, long), titled(4, "b", 2000, "B")]);
  assert.deepEqual(parseId3Chapters(bytes), [{ secs: 1, title: long }, { secs: 2, title: "B" }]);
  assert.deepEqual(parseId3Chapters(basic(4)), BASIC);
});

test("v2.4 written iTunes-style (plain, not syncsafe, sizes) is still read", () => {
  /* A size byte with its high bit set cannot be syncsafe. MUTATION: drop the
     `!hasHigh(b, o + 4)` guard -> 0x00000080 reads as 0 and this goes red. */
  const title = "y".repeat(127); // TIT2 data 128 bytes: plain size 00 00 00 80
  const t2 = frame(4, "TIT2", tit2(title), { plainSize: true });
  const c = frame(4, "CHAP", cat(latin1z("a"), be(5000), be(0), be(0), be(0), t2), { plainSize: true });
  assert.deepEqual(parseId3Chapters(tag(4, [c])), [{ secs: 5, title }]);
});

test("CTOC decides membership and the result is in START order, not file order", () => {
  /* CHAPs stored c3, c1, c2; the CTOC lists c2, c1, sub, c3; an orphan CHAP
     no table names; a nested non-top-level CTOC ("sub") holding c4. Start
     time decides the order, because the card draws a timeline. MUTATIONS: delete the `out.sort(...)` line
     -> table order (c2 first) and red; `if (top !== null) {` ->
     `if (top !== null && false) {` (ignore the CTOC, every CHAP counts)
     -> the orphan appears and red; drop the
     `if (tocs.has(kid)) walk(...)` branch -> "sub" is looked up as a chapter,
     c4 is lost and red. */
  const bytes = tag(3, [
    titled(3, "c3", 30000, "Three"),
    titled(3, "orphan", 15000, "Not listed"),
    titled(3, "c1", 10000, "One"),
    ctoc(3, "sub", ["c4"], { top: false }),
    ctoc(3, "root", ["c2", "c1", "sub", "c3"]), // table order is not start order either
    titled(3, "c2", 20000, "Two"),
    titled(3, "c4", 40000, "Four"),
  ]);
  assert.deepEqual(parseId3Chapters(bytes).map((c) => c.title), ["One", "Two", "Three", "Four"]);
});

test("no CTOC at all: every CHAP is a chapter, sorted by start", () => {
  /* MUTATION: `if (top !== null)` -> `if (true)` (CTOC required) -> [] and red. */
  const bytes = tag(4, [titled(4, "b", 9000, "B"), titled(4, "a", 3000, "A")]);
  assert.deepEqual(parseId3Chapters(bytes), [{ secs: 3, title: "A" }, { secs: 9, title: "B" }]);
});

test("v2.3 whole-tag unsynchronisation is undone before frames are read", () => {
  /* The CHAP's 0xFFFFFFFF offsets and a 0xFF00 start become FF 00 FF 00 …
     on disk. MUTATION: delete `if (v === 3 && flags & 0x80) body = unsync(body)`
     -> sizes and times misread and this goes red. */
  const bytes = tag(3, [ctoc(3, "t", ["a"]), titled(3, "a", 0xff00, "Unsync")], { flags: 0x80 });
  assert.ok(bytes.length > tag(3, [ctoc(3, "t", ["a"]), titled(3, "a", 0xff00, "Unsync")]).length, "premise: the encoding grew the tag");
  assert.deepEqual(parseId3Chapters(bytes), [{ secs: 65.28, title: "Unsync" }]);
});

test("v2.4 per-frame unsynchronisation (frame flag 0x02) is undone per frame", () => {
  /* MUTATION: drop `(fmt & 0x02) ||` from the v2.4 branch -> the CHAP's
     data keeps its stuffed zeros, the start reads wrong and this goes red. */
  const v = 4;
  const raw = cat(latin1z("a"), be(0xff00), be(0xffffffff), be(0xffffffff), be(0xffffffff), frame(v, "TIT2", tit2("Per frame")));
  const enc = unsyncEncode(raw);
  const chapFrame = cat(latin1z("CHAP").slice(0, 4), ss(enc.length), [0, 0x02], enc);
  assert.deepEqual(parseId3Chapters(tag(4, [ctoc(4, "t", ["a"]), chapFrame])), [{ secs: 65.28, title: "Per frame" }]);
});

test("an extended header is skipped (v2.3: plain size excluding itself; v2.4: syncsafe size including itself)", () => {
  /* MUTATION: delete the `if (flags & 0x40) o = …` line -> the extended
     header is read as a frame id, parsing stops, [] and red. */
  const ext3 = cat(be(6), [0, 0], be(0)); // size 6 + 2 flag bytes + 4 padding size
  const ext4 = cat(ss(6), [1, 0]);
  assert.deepEqual(parseId3Chapters(tag(3, [ctoc(3, "t", ["a"]), titled(3, "a", 2000, "E3")], { flags: 0x40, ext: ext3 })), [{ secs: 2, title: "E3" }]);
  assert.deepEqual(parseId3Chapters(tag(4, [ctoc(4, "t", ["a"]), titled(4, "a", 4000, "E4")], { flags: 0x40, ext: ext4 })), [{ secs: 4, title: "E4" }]);
});

test("a truncated tag never yields a partial list: [] when a chapter the CTOC names is missing", () => {
  /* Cut in the middle of c3. MUTATION: delete the
     `if (ids.some((k) => !chaps.has(k))) return [];` line -> c1 and c2
     come back as if they were the whole list, and this goes red. */
  const whole = basic(3);
  const cutAt = whole.length - 64 - 20; // inside the last CHAP (64 bytes of padding follow it)
  assert.deepEqual(parseId3Chapters(whole.subarray(0, cutAt)), []);
  /* …but a cut in the padding loses nothing, so the list is whole. */
  assert.deepEqual(parseId3Chapters(whole.subarray(0, whole.length - 10)), BASIC);
});

test("a whole tag whose frames stop at a bad id before a chapter the CTOC names is [], not a partial list", () => {
  /* CTOC [a, b, c], CHAP a, CHAP b, a frame with the nonsense id "xxxx",
     then CHAP c. Frames stop at "xxxx" without the tag being cut. MUTATION:
     restore `(truncated || cut) &&` in front of `ids.some(...)` -> [A, B]
     comes back as the whole list and this goes red. */
  const v = 3;
  const junk = cat([0x78, 0x78, 0x78, 0x78], be(4), [0, 0], [1, 2, 3, 4]);
  const bytes = tag(v, [ctoc(v, "toc", ["a", "b", "c"]), titled(v, "a", 0, "A"), titled(v, "b", 1000, "B"), junk, titled(v, "c", 2000, "C")]);
  assert.deepEqual(parseId3Chapters(bytes), []);
});

test("v2.4 iTunes plain sizes with no high bit: when the syncsafe reading lands nowhere, the plain one is used", () => {
  /* TIT2 data 300 bytes (00 00 01 2C) and its CHAP 328 (00 00 01 48): no
     high bit, so they look syncsafe, but read that way they end mid-title on
     "xxxx". MUTATION: delete the
     `if (plain !== size && !landsAt(...) && landsAt(...)) size = plain;`
     line -> the CHAP ends inside its own title, b is never reached and this
     goes red ([] under the partial-CTOC rule). */
  const v = 4;
  const long = "x".repeat(299);
  const t2 = frame(v, "TIT2", tit2(long), { plainSize: true });
  const a = frame(v, "CHAP", cat(latin1z("a"), be(1000), be(0), be(0), be(0), t2), { plainSize: true });
  assert.equal(a.length - 10, 328, "premise: a plain size with no high bit");
  const bytes = tag(v, [ctoc(v, "t", ["a", "b"]), a, titled(v, "b", 2000, "B")], { padding: 16 });
  assert.deepEqual(parseId3Chapters(bytes), [{ secs: 1, title: long.slice(0, 200) }, { secs: 2, title: "B" }]);
});

test("a truncated tag with no CTOC is [] — nothing says the list is complete", () => {
  /* MUTATION: delete `if (truncated || cut) return [];` in the no-CTOC branch
     -> the two CHAPs that were read come back and this goes red. */
  const whole = tag(3, [titled(3, "a", 0, "A"), titled(3, "b", 1000, "B"), titled(3, "c", 2000, "C")]);
  assert.deepEqual(parseId3Chapters(whole.subarray(0, whole.length - 5)), []);
});

test("no tag, a v2.2 tag, a bad size byte and plain garbage are all [] — and nothing throws", () => {
  /* MUTATION: remove the try/catch around parseId3Chapters' body (or make
     its catch rethrow) -> the hostile array-like, whose `length` getter
     throws, escapes and this goes red. */
  const mp3Frame = Uint8Array.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(parseId3Chapters(mp3Frame), []);
  assert.equal(tagSize(mp3Frame), -1);
  const v22 = basic(3).slice(); v22[3] = 2;
  assert.deepEqual(parseId3Chapters(v22), []);
  const badSize = basic(3).slice(); badSize[7] = 0x80;
  assert.deepEqual(parseId3Chapters(badSize), []);
  const hostile = { get length() { throw new Error("hostile"); } };
  for (const junk of [null, undefined, "ID3", {}, 42, new Uint8Array(0), hostile]) assert.deepEqual(parseId3Chapters(junk), []);
  /* Seeded fuzz: flip bytes of a valid tag 2,000 times; every answer is an array. */
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const good = basic(4);
  for (let i = 0; i < 2000; i++) {
    const b = good.slice();
    for (let k = 0; k < 4; k++) b[10 + Math.floor(rnd() * (b.length - 10))] = Math.floor(rnd() * 256);
    const out = parseId3Chapters(i % 3 ? b : b.subarray(0, Math.floor(rnd() * b.length)));
    assert.ok(Array.isArray(out) && out.length <= MAX_CHAPTERS);
  }
});

test("at most MAX_CHAPTERS (500), the earliest ones", () => {
  /* MUTATION: return `out` instead of `out.slice(0, MAX_CHAPTERS)` -> 600 and red. */
  const frames = [];
  for (let i = 599; i >= 0; i--) frames.push(titled(4, `c${i}`, i * 1000, `T${i}`));
  const out = parseId3Chapters(tag(4, frames));
  assert.equal(out.length, MAX_CHAPTERS);
  assert.equal(out[0].secs, 0);
  assert.equal(out.at(-1).secs, 499);
});

test("titles: Latin-1, UTF-16 with either BOM, UTF-16BE and UTF-8; control characters folded; no TIT2 is null", () => {
  /* MUTATION: in text(), swap the BOM test (`0xff, 0xfe` -> le = false) -> the
     LE title decodes byte-swapped and this goes red. */
  const u16le = (s) => cat([1, 0xff, 0xfe], ...[...s].map((c) => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8]), [0, 0]);
  const u16be = (s, bom) => cat([bom ? 1 : 2], bom ? [0xfe, 0xff] : [], ...[...s].map((c) => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 0xff]));
  const v = 3;
  const bytes = tag(v, [
    chap(v, "a", 1000, [frame(v, "TIT2", cat([0], [0x43, 0x61, 0x66, 0xe9]))]), // "Café" in Latin-1
    chap(v, "b", 2000, [frame(v, "TIT2", u16le("Ünïcode"))]),
    chap(v, "c", 3000, [frame(v, "TIT2", u16be("Big end", true))]),
    chap(v, "d", 4000, [frame(v, "TIT2", u16be("No BOM", false))]),
    chap(v, "e", 5000, [frame(v, "TIT2", tit2("Ünder\u0007 \n the  hood"))]),
    chap(v, "f", 6000, []),
  ]);
  assert.deepEqual(parseId3Chapters(bytes).map((c) => c.title), ["Café", "Ünïcode", "Big end", "No BOM", "Ünder the hood", null]);
});

test("a chapter link (WXXX) and a linked picture (APIC \"-->\") are kept only when https; an embedded picture is never read", () => {
  /* MUTATION: make httpsOnly return its argument -> the http link is kept
     and this goes red. */
  const v = 4;
  const wxxx = (url) => frame(v, "WXXX", cat([0], [0x64, 0], latin1z(url).slice(0, -1))); // description "d"
  const apic = (mime, data) => frame(v, "APIC", cat([0], latin1z(mime), [3], [0], data));
  const bytes = tag(v, [
    chap(v, "a", 0, [frame(v, "TIT2", tit2("A")), wxxx("https://example.com/a"), apic("-->", latin1z("https://example.com/a.jpg").slice(0, -1))]),
    chap(v, "b", 1000, [frame(v, "TIT2", tit2("B")), wxxx("http://example.com/b"), apic("image/jpeg", [0xff, 0xd8, 0xff, 0xe0])]),
  ]);
  assert.deepEqual(parseId3Chapters(bytes), [
    { secs: 0, title: "A", url: "https://example.com/a", img: "https://example.com/a.jpg" },
    { secs: 1, title: "B" },
  ]);
});

/* ---------- the fetcher ---------- */

/** A fetch that serves `file` honouring a Range (or ignoring it), streaming in
    64 KB chunks, and records what it was asked. Only the local-file path
    (a downloaded episode) still uses fetch. */
function fakeFetch(file, { ignoreRange = false } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, range: init.headers?.Range ?? null });
    const m = /^bytes=(\d+)-(\d+)$/.exec(init.headers?.Range ?? "");
    const slice = ignoreRange || !m ? file : file.subarray(Number(m[1]), Number(m[2]) + 1);
    let off = 0;
    let cancelled = false;
    let served = 0;
    fn.stats = () => ({ cancelled, served });
    return {
      status: ignoreRange || !m ? 200 : 206,
      body: {
        getReader: () => ({
          read: async () => {
            if (off >= slice.length) return { done: true, value: undefined };
            const value = slice.subarray(off, off + 65536);
            off += value.length;
            served += value.length;
            return { done: false, value };
          },
          cancel: () => { cancelled = true; },
        }),
      },
    };
  };
  fn.calls = calls;
  return fn;
}

/** A Capacitor bridge whose CapacitorHttp serves `file` as base64 (honouring
    the Range unless told otherwise) and records every request. */
function fakeBridge(file, { status, ignoreRange = false, fail = false, delayMs = 0 } = {}) {
  const asked = [];
  return {
    asked,
    nativePromise: async (plugin, method, opts) => {
      asked.push({ plugin, call: method, opts });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (fail) throw new Error("no plugin");
      const m = /^bytes=(\d+)-(\d+)$/.exec(opts.headers?.Range ?? "");
      const slice = ignoreRange || !m ? file : file.subarray(Number(m[1]), Number(m[2]) + 1);
      return { status: status ?? (ignoreRange || !m ? 200 : 206), headers: {}, data: Buffer.from(slice).toString("base64") };
    },
  };
}
const withAudio = (t) => cat(t, [0xff, 0xfb, 0x90, 0x64], new Uint8Array(4000));
const URL_A = "https://cdn.example.com/ep1.mp3";

test("native shell: CapacitorHttp's base64 arraybuffer answer, with a Range and the 4a User-Agent, cached per URL; fetch is never used", async () => {
  /* MUTATIONS: in load(), `typeof bridge?.nativePromise !== "function"` ->
     `true` -> nothing is read, [] and red; delete
     `if (cache.has(url)) return cache.get(url);` -> the second forUrl asks
     again and red. */
  const file = withAudio(basic(4));
  const bridge = fakeBridge(file);
  const fetchFn = fakeFetch(file);
  const r = createId3Reader({ fetchFn, getBridge: () => bridge, getDownloads: () => ({ userAgent: "4a/1.2.3 (+x)" }) });
  assert.deepEqual(await r.forUrl(URL_A), BASIC);
  assert.equal(fetchFn.calls.length, 0);
  assert.deepEqual(bridge.asked.map((a) => [a.plugin, a.call, a.opts.method, a.opts.url, a.opts.responseType, a.opts.headers.Range, a.opts.headers["User-Agent"]]), [
    ["CapacitorHttp", "request", "GET", URL_A, "arraybuffer", "bytes=0-9", "4a/1.2.3 (+x)"],
    ["CapacitorHttp", "request", "GET", URL_A, "arraybuffer", `bytes=0-${basic(4).length - 1}`, "4a/1.2.3 (+x)"],
  ]);
  assert.deepEqual(await r.forUrl(URL_A), BASIC);
  assert.equal(bridge.asked.length, 2, "the second answer came from memory");
});

test("web (no native bridge): native app only, so [] and the publisher's URL is never fetched", async () => {
  /* Founder ruling #1071 ("native app only"); the CSP connect-src names no
     publisher host, so a WebView fetch could only raise a CSP violation.
     MUTATION: restore the web fallback in load(),
     `if (typeof bridge?.nativePromise !== "function") return fetchFn ?
     chaptersVia((want) => viaFetch(fetchFn, url, want)) : null;` -> the fake
     fetch is called (and answers BASIC) and this goes red. */
  const fetchFn = fakeFetch(withAudio(basic(4)));
  const r = createId3Reader({ fetchFn, isOnline: () => true });
  assert.deepEqual(await r.forUrl(URL_A), []);
  assert.deepEqual(await createId3Reader({ fetchFn, getBridge: () => ({}) }).forUrl(URL_A), []);
  assert.equal(fetchFn.calls.length, 0, "nothing was asked of the publisher");
  /* A bridge that arrives after a first call is used: the web [] was not cached. */
  let bridge = null;
  const late = createId3Reader({ fetchFn, getBridge: () => bridge });
  assert.deepEqual(await late.forUrl(URL_A), []);
  bridge = fakeBridge(withAudio(basic(4)));
  assert.deepEqual(await late.forUrl(URL_A), BASIC);
});

test("native: a 200 (the host ignored Range) is never parsed; [] is cached for the URL, one request per session", async () => {
  /* The 200 body is the whole file, chapters and all. MUTATIONS: in
     viaNative, `if (res.status !== 206)` -> `if (res.status !== 206 &&
     res.status !== 200)` -> the 200 is parsed, chapters come back and red;
     `{ track.noRange(url); return NO_RANGE; }` -> `return null;` -> the miss
     is not cached, the second forUrl asks again and red. */
  const file = withAudio(basic(4));
  const bridge = fakeBridge(file, { ignoreRange: true });
  const r = createId3Reader({ getBridge: () => bridge });
  assert.deepEqual(await r.forUrl(URL_A), []);
  assert.equal(bridge.asked.length, 1, "the header read alone; the tag is not asked for");
  assert.deepEqual(await r.forUrl(URL_A), []);
  assert.equal(bridge.asked.length, 1, "no second request for that URL");
  /* Any other non-206 is the same final answer. */
  const refused = fakeBridge(file, { status: 403 });
  const r2 = createId3Reader({ getBridge: () => refused });
  assert.deepEqual(await r2.forUrl(URL_A), []);
  assert.deepEqual(await r2.forUrl(URL_A), []);
  assert.equal(refused.asked.length, 1);
});

test("native: a 200 that lands after the deadline still closes the URL, and no second request starts while one is running", async () => {
  /* A Range-ignoring host can take longer than the deadline to send the whole
     file. MUTATIONS: delete `if (track.inFlight.has(url)) return null;` ->
     the call made while the first is running asks again and red; delete
     `if (noRangeUrls.has(url)) return [];` -> after the late 200 a third
     call asks again and red. */
  const bridge = fakeBridge(withAudio(basic(4)), { ignoreRange: true, delayMs: 80 });
  const r = createId3Reader({ getBridge: () => bridge, timeoutMs: 20 });
  assert.deepEqual(await r.forUrl(URL_A), [], "the deadline answered");
  assert.deepEqual(await r.forUrl(URL_A), []);
  assert.equal(bridge.asked.length, 1, "the first request is still running: no second one");
  await new Promise((res) => setTimeout(res, 120));
  assert.deepEqual(await r.forUrl(URL_A), []);
  assert.equal(bridge.asked.length, 1, "the late 200 closed the URL for the session");
});

test("a tag over the 1 MB cap: the Range asks for only the first MAX_TAG_BYTES, and a CTOC read whole still answers", async () => {
  /* A 1.2 MB PRIV frame after the chapters. MUTATION: drop `Math.min(…,
     MAX_TAG_BYTES)` in chaptersVia -> the second Range asks for the whole
     1.2 MB tag and this goes red. The second file puts c3 past the cap: []
     (the partial-CTOC rule, reached through the fetcher). */
  const big = frame(4, "PRIV", new Uint8Array(1_200_000));
  const early = tag(4, [ctoc(4, "toc", ["c1", "c2", "c3"]), titled(4, "c1", 0, "Cold open"), titled(4, "c2", 61500, "The interview"), titled(4, "c3", 1800000, "Listener mail"), big]);
  const b1 = fakeBridge(withAudio(early));
  assert.deepEqual(await createId3Reader({ getBridge: () => b1 }).forUrl(URL_A), BASIC);
  assert.equal(b1.asked[1].opts.headers.Range, `bytes=0-${MAX_TAG_BYTES - 1}`);

  const late = tag(4, [ctoc(4, "toc", ["c1", "c2", "c3"]), titled(4, "c1", 0, "A"), titled(4, "c2", 1000, "B"), big, titled(4, "c3", 2000, "C")]);
  const b2 = fakeBridge(withAudio(late));
  assert.deepEqual(await createId3Reader({ getBridge: () => b2 }).forUrl(URL_A), []);
});

test("a local file served without Range support: the read stops at the bytes it wanted and cancels the body", async () => {
  /* The local-file path still uses fetch. MUTATION: in viaFetch,
     `while (n < want)` -> `while (true)` -> the whole 3 MB file is pulled
     through (and set() overflows into a RangeError, a failed read) and this
     goes red. */
  const file = withAudio(cat(basic(3), new Uint8Array(3_000_000)));
  const fetchFn = fakeFetch(file, { ignoreRange: true });
  const downloads = { recordFor: () => ({ status: "done", path: "/data/files/ep1.mp3", webSrc: "https://localhost/_capacitor_file_/data/files/ep1.mp3" }) };
  assert.deepEqual(await createId3Reader({ fetchFn, getDownloads: () => downloads }).forUrl(URL_A, { id: "ep1" }), BASIC);
  const { cancelled, served } = fetchFn.stats();
  assert.equal(cancelled, true);
  assert.ok(served < 200_000, `served ${served} bytes`);
});

test("no tag: one 10-byte read, [] and cached", async () => {
  /* MUTATION: in chaptersVia, `return head.length >= 10 ? [] : null` ->
     `return null` -> the no-tag answer is not cached, the second forUrl reads
     again and this goes red. */
  const bridge = fakeBridge(Uint8Array.from([0xff, 0xfb, 0x90, 0x64, ...new Uint8Array(100)]));
  const r = createId3Reader({ getBridge: () => bridge });
  assert.deepEqual(await r.forUrl(URL_A), []);
  assert.deepEqual(await r.forUrl(URL_A), []);
  assert.deepEqual(bridge.asked.map((a) => a.opts.headers.Range), ["bytes=0-9"]);
});

test("only https audio, and no request at all while offline (retried once online)", async () => {
  /* MUTATIONS: delete `if (isOnline() === false) return null;` -> the offline
     call asks and this goes red; `!isHttps(url)` -> `false` in forUrl ->
     the http:// URL is asked for (online) and this goes red. */
  const bridge = fakeBridge(withAudio(basic(3)));
  let online = true;
  const r = createId3Reader({ getBridge: () => bridge, isOnline: () => online });
  for (const bad of ["http://cdn.example.com/ep1.mp3", "file:///x.mp3", "", null, 7]) assert.deepEqual(await r.forUrl(bad), []);
  assert.equal(bridge.asked.length, 0, "only https is ever asked for");
  online = false;
  assert.deepEqual(await r.forUrl(URL_A), []);
  assert.equal(bridge.asked.length, 0, "nothing left the phone");
  online = true;
  assert.deepEqual(await r.forUrl(URL_A), BASIC, "the offline [] was not cached");
});

test("native: a rejected call is a silent [], not cached", async () => {
  /* MUTATION: drop `if (r === null) cache.delete(url);` -> the failure is
     remembered, the second call does not ask and this goes red. */
  const bridge = fakeBridge(withAudio(basic(3)), { fail: true });
  const r = createId3Reader({ getBridge: () => bridge });
  assert.deepEqual(await r.forUrl(URL_A), []);
  assert.deepEqual(await r.forUrl(URL_A), []);
  assert.equal(bridge.asked.length, 2, "tried again");
});

test("native: a call that never answers is [] at the deadline", async () => {
  /* MUTATION: in read(), delete the setTimeout -> the hung call never
     settles, the test's own race fires and this goes red. */
  const hung = createId3Reader({ getBridge: () => ({ nativePromise: () => new Promise(() => {}) }), timeoutMs: 20 });
  const out = await Promise.race([hung.forUrl(URL_A), new Promise((res) => setTimeout(() => res("hung"), 500))]);
  assert.deepEqual(out, []);
});

test("a downloaded episode is read from its local file, offline, without touching the remote URL", async () => {
  /* MUTATION: in load(), `const local = localSrc(id);` -> `= null` -> the
     offline call reads nothing and this goes red. */
  const file = withAudio(basic(3));
  const fetchFn = fakeFetch(file);
  const bridge = fakeBridge(file);
  const downloads = {
    recordFor: (id) => (id === "ep1" ? { status: "done", path: "/data/files/ep1.mp3", webSrc: null } : null),
    bridge: { fileSrc: ({ path }) => `capacitor://localhost/_capacitor_file_${path}` },
  };
  const r = createId3Reader({ fetchFn, getBridge: () => bridge, isOnline: () => false, getDownloads: () => downloads });
  assert.deepEqual(await r.forUrl(URL_A, { id: "ep1" }), BASIC);
  assert.deepEqual([...new Set(fetchFn.calls.map((c) => c.url))], ["capacitor://localhost/_capacitor_file_/data/files/ep1.mp3"]);
  assert.equal(bridge.asked.length, 0, "the publisher was not asked");
  /* Not downloaded (or not done): the remote rules apply, so offline is []. */
  assert.deepEqual(await createId3Reader({ fetchFn: fakeFetch(file), getBridge: () => bridge, isOnline: () => false, getDownloads: () => downloads }).forUrl(URL_A, { id: "ep2" }), []);
  assert.equal(bridge.asked.length, 0);
});

test("CH-27 characterization: a downloaded episode opens at bridge.fileSrc before the stored webSrc, and a file: URL is never fetched", async () => {
  /* What the local read opens is download-store.readSource's rule (CH-27,
     P2-18). MUTATIONS: in readSource, swap the order to `record.webSrc ??
     fileSrc(...)` -> the stale stored URL is fetched and the first assert goes
     red; drop the `file:` refusal -> the file:// URL is fetched and the second
     goes red. */
  const file = withAudio(basic(3));
  const rec = { status: "done", path: "/data/files/ep1.mp3", webSrc: "https://localhost/_capacitor_file_/stale/ep1.mp3" };
  const fetchA = fakeFetch(file);
  assert.deepEqual(await createId3Reader({
    fetchFn: fetchA, isOnline: () => false,
    getDownloads: () => ({ recordFor: () => rec, bridge: { fileSrc: ({ path }) => `https://localhost/_capacitor_file_${path}` } }),
  }).forUrl(URL_A, { id: "ep1" }), BASIC);
  assert.deepEqual([...new Set(fetchA.calls.map((c) => c.url))], ["https://localhost/_capacitor_file_/data/files/ep1.mp3"]);

  const fetchB = fakeFetch(file);
  const asFile = { ...rec, webSrc: "file:///data/files/ep1.mp3" };
  assert.deepEqual(await createId3Reader({ fetchFn: fetchB, isOnline: () => false, getDownloads: () => ({ recordFor: () => asFile }) })
    .forUrl(URL_A, { id: "ep1" }), []);
  assert.equal(fetchB.calls.length, 0, "a file: URL is refused: the WebView's fetch cannot open it");
});

test("CH-27: a done row with an empty path is a missing download, so the chapter reader fetches nothing local", async () => {
  /* download-store normalises `done` without a path to `missing` (it plays the
     stream); the reader used to gate on `typeof path === "string"` and asked
     fileSrc for "", fetching the shell's file root and spending the 10 s
     deadline on every episode page open. MUTATION: put the inline gate back in
     localSrc (`typeof rec.path !== "string"` instead of readSource) -> the
     empty path is fetched and this goes red. */
  const fetchFn = fakeFetch(withAudio(basic(3)));
  const downloads = {
    recordFor: () => ({ status: "done", path: "", webSrc: null }),
    bridge: { fileSrc: ({ path }) => `https://localhost/_capacitor_file_${path}` },
  };
  assert.deepEqual(await createId3Reader({ fetchFn, isOnline: () => false, getDownloads: () => downloads }).forUrl(URL_A, { id: "ep1" }), []);
  assert.equal(fetchFn.calls.length, 0);
});

test("client.js publishes window.ForayId3Chapters from this module, reading the bridge per call", () => {
  /* A text pin: the module is reachable only through client.js. MUTATION:
     delete the `window.ForayId3Chapters = createId3Reader({` line -> red. */
  const src = fs.readFileSync(new URL("./client.js", import.meta.url), "utf8");
  assert.match(src, /import \{ createId3Reader \} from "\.\/id3-chapters\.js";/);
  assert.match(src, /window\.ForayId3Chapters = createId3Reader\(\{\s*getBridge: \(\) =>/);
});

/* ---------- CH-33: the transport rules app.js's JSON read takes from here ---------- */

test("CH-33: the reader publishes its deadline — the module's 10 s unless configured — for app.js's chapters JSON read", () => {
  /* app.js readDeviceChapters races the podcast:chapters JSON request against
     this, not a literal of its own (A2-10). MUTATION: drop
     `CALL_TIMEOUT_MS: timeoutMs,` from the returned object -> undefined; red.
     MUTATION 2: publish the module constant instead of `timeoutMs` -> the
     configured reader reports 10000; red. */
  assert.equal(CALL_TIMEOUT_MS, 10_000);
  assert.equal(createId3Reader().CALL_TIMEOUT_MS, CALL_TIMEOUT_MS);
  assert.equal(createId3Reader({ timeoutMs: 25 }).CALL_TIMEOUT_MS, 25);
});

test("CH-33: shellUserAgent() is the downloads surface's User-Agent, read per call, null when absent or throwing — and the MP3 Range read sends the same", async () => {
  /* MUTATION: `shellUserAgent` returns null always -> red on the first
     assertion (and on the native read's header). MUTATION 2: read the UA once
     at createId3Reader time -> the late-arriving surface is missed; red. */
  let dl = null;
  const file = withAudio(basic(4));
  const bridge = fakeBridge(file);
  const r = createId3Reader({ getBridge: () => bridge, getDownloads: () => dl });
  assert.equal(r.shellUserAgent(), null, "no downloads surface yet");
  dl = { userAgent: "4a/9.9 (+late)" };
  assert.equal(r.shellUserAgent(), "4a/9.9 (+late)", "read per call: the surface can arrive after the reader");
  await r.forUrl(URL_A);
  assert.deepEqual(bridge.asked.map((a) => a.opts.headers["User-Agent"]), ["4a/9.9 (+late)", "4a/9.9 (+late)"]);
  const throwing = createId3Reader({ getDownloads: () => { throw new Error("not yet"); } });
  assert.equal(throwing.shellUserAgent(), null);
});

/* ---------- CH-40 characterization (code-health P2-05) ---------- */

/** Run `body` with the global timers wrapped; answers the `ms` of every timer
    still armed when it returns (a timer that fired or was cleared is gone). */
async function liveTimersAfter(body) {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const live = new Map();
  globalThis.setTimeout = (fn, ms, ...args) => {
    const h = realSet(() => { live.delete(h); fn(...args); }, ms);
    live.set(h, ms);
    return h;
  };
  globalThis.clearTimeout = (h) => { live.delete(h); return realClear(h); };
  try { await body(); } finally { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; }
  return [...live.values()];
}

test("CH-40 characterization: a read answered in time leaves no live deadline, and a transport that rejects is swallowed to [], never a throw", async () => {
  /* read()'s contract: null on the clock (the test above), null on a
     rejection, the bytes otherwise; the deadline is cleared on settle.
     MUTATION: drop `.finally(() => clearTimeout(t))` in read() -> the
     header's and the tag's 4321 ms deadlines are still live. */
  const file = withAudio(basic(4));
  const bridge = fakeBridge(file);
  let got = null;
  const live = await liveTimersAfter(async () => {
    got = await createId3Reader({ getBridge: () => bridge, timeoutMs: 4321 }).forUrl(URL_A);
  });
  assert.deepEqual(got, BASIC);
  assert.deepEqual(live.filter((ms) => ms === 4321), [], "both reads' deadlines are cleared");
  const failing = fakeBridge(file, { fail: true });
  assert.deepEqual(await createId3Reader({ getBridge: () => failing, timeoutMs: 4321 }).forUrl(URL_A), []);
});
