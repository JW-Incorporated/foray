/* Chapters from the MP3 itself: the ID3 CHAP/CTOC frames a publisher embeds
 * at the front of the episode's audio file (issue #1071).
 *
 * FOUNDER RULING (#1071, Wyatt 2026-10-05, "Phone reads the MP3
 * (Recommended)"): when an episode is opened or played, the phone reads just
 * the first bytes of the publisher's own audio file for its chapters. No 4a
 * server is involved, nothing is rehosted, nothing is stored on disk.
 *
 * Two halves, both total (nothing here throws or rejects):
 *   - `parseId3Chapters(bytes)` — pure. An ID3v2.3/2.4 tag (syncsafe sizes,
 *     unsynchronisation, extended header) in, `[{secs, title}]` out, sorted by
 *     start, at most MAX_CHAPTERS. A chapter may also carry `url` (its WXXX
 *     link) and `img` (an APIC that is a link, MIME "-->"), https only; an
 *     embedded picture is never decoded. Garbage, v2.2, a missing tag: [].
 *   - `createId3Reader(env)` — the fetcher. A Range GET of bytes 0-9 reads the
 *     header, then a second one reads the tag, never more than MAX_TAG_BYTES.
 *     In the native shell it goes through Capacitor's built-in CapacitorHttp
 *     plugin (`Capacitor.nativePromise`, the call download-bridge.js and
 *     durable-store.js make — no import, no bundle), which is not subject to
 *     CORS; on the web it is plain `fetch`, and a host without CORS headers is
 *     a silent []. https audio only; no request at all while offline. A
 *     downloaded episode (pass `{ id }`) is read from its local file when the
 *     download store has one, which needs no network.
 *
 * A TRUNCATED TAG (cut short, or longer than the cap) gives chapters only when
 * a top-level CTOC was read whole and every chapter it names was found: a
 * partial list would paint its last chapter running to the end of the
 * episode, which is worse than no chapters.
 *
 * TIMES ARE APPROXIMATE ON DAI-STITCHED SHOWS: the bytes this read gets can
 * come from a different stitch than the one playing (seek-policy FOREIGN).
 * CH-1 marks them; this module only reports what the tag says.
 *
 * Cache: in memory, per URL, for the session. Deliberately not localStorage —
 * a new stored key would need a privacy-policy row.
 *
 * Published as `window.ForayId3Chapters = { forUrl(url, { id }?) }` by
 * client.js, for the episode page's chapter card (CH-1). Nothing in this card
 * is visible to a listener. */

export const MAX_TAG_BYTES = 1024 * 1024;
export const MAX_CHAPTERS = 500;
export const CALL_TIMEOUT_MS = 10_000;
const MAX_CACHE = 200;
const MAX_TITLE = 200;

/* ---------- the pure parser ---------- */

const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
const u32 = (b, o) => ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
const hasHigh = (b, o) => ((b[o] | b[o + 1] | b[o + 2] | b[o + 3]) & 0x80) !== 0;

/** Undo unsynchronisation: every 0xFF 0x00 pair loses its 0x00. */
function unsync(b) {
  const out = new Uint8Array(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i++) {
    out[n++] = b[i];
    if (b[i] === 0xff && b[i + 1] === 0x00) i++;
  }
  return out.subarray(0, n);
}

/** The tag's declared length past its 10-byte header, or -1 when `b` does not
    start with a v2.3/v2.4 header. Exported for the fetcher's first read. */
export function tagSize(b) {
  if (!b || b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return -1;
  if ((b[3] !== 3 && b[3] !== 4) || hasHigh(b, 6)) return -1;
  return syncsafe(b, 6);
}

/** Text up to (not including) a terminator of `enc`'s width, from `o`; returns
    [text, offset after the terminator]. */
function text(b, o, enc, end = b.length) {
  const wide = enc === 1 || enc === 2;
  let i = o;
  if (wide) { while (i + 1 < end && (b[i] || b[i + 1])) i += 2; } else { while (i < end && b[i]) i++; }
  const raw = b.subarray(o, Math.min(i, end));
  let s = "";
  if (enc === 3) s = new TextDecoder("utf-8").decode(raw);
  else if (wide) {
    let le = false; // no BOM: big-endian, as the spec says
    let k = 0;
    if (enc === 1 && raw.length >= 2) {
      if (raw[0] === 0xff && raw[1] === 0xfe) { le = true; k = 2; } else if (raw[0] === 0xfe && raw[1] === 0xff) k = 2;
    }
    for (; k + 1 < raw.length; k += 2) s += String.fromCharCode(le ? raw[k] | (raw[k + 1] << 8) : (raw[k] << 8) | raw[k + 1]);
  } else for (const c of raw) s += String.fromCharCode(c);
  return [s, Math.min(i + (wide ? 2 : 1), end)];
}

const clean = (s) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
const httpsOnly = (s) => (/^https:\/\/[^\s]+$/i.test(s) ? s : null);

/** Frames in b[o, end): [{id, data}], for one tag version. Stops at padding,
    a nonsense id or a frame that runs past the end (and says so). */
function frames(b, o, end, v, tagUnsync) {
  const out = [];
  let cut = false;
  while (o + 10 <= end) {
    const id = String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    /* iTunes wrote v2.4 sizes unsynchsafe for years: a size byte with its high
       bit set cannot be syncsafe, so read it plain. */
    const size = v === 4 && !hasHigh(b, o + 4) ? syncsafe(b, o + 4) : u32(b, o + 4);
    const fmt = b[o + 9];
    const start = o + 10;
    if (start + size > end) { cut = true; break; }
    let data = b.subarray(start, start + size);
    o = start + size;
    if (v === 3) {
      if (fmt & 0xc0) continue; // compressed / encrypted
      if (fmt & 0x20) data = data.subarray(1); // grouping id
    } else {
      if (fmt & 0x0c) continue; // compressed / encrypted
      if (fmt & 0x40) data = data.subarray(1); // grouping id
      if (fmt & 0x01) data = data.subarray(4); // data length indicator
      if ((fmt & 0x02) || tagUnsync) data = unsync(data);
    }
    out.push({ id, data });
  }
  return { list: out, cut };
}

/** A CHAP/CTOC's subframes, read for a title and the two link kinds. */
function subInfo(b, o, v) {
  const info = { title: null, url: null, img: null };
  for (const { id, data } of frames(b, o, b.length, v, false).list) {
    if (!data.length) continue;
    if (id === "TIT2") info.title = clean(text(data, 1, data[0])[0]) || null;
    else if (id === "WXXX") info.url = httpsOnly(text(data, text(data, 1, data[0])[1], 0)[0]);
    else if (id === "APIC") {
      const [mime, p] = text(data, 1, 0);
      if (mime === "-->") info.img = httpsOnly(text(data, text(data, p + 1, data[0])[1], 0)[0]);
    }
  }
  return info;
}

/**
 * `[{secs, title, url?, img?}]` from the bytes at the front of an MP3 — the
 * whole tag, or as much of it as was read. Never throws.
 * @param {Uint8Array|ArrayBuffer} input
 */
export function parseId3Chapters(input) {
  try {
    let b = input instanceof Uint8Array ? input : new Uint8Array(input);
    const size = tagSize(b);
    if (size < 0) return [];
    const v = b[3];
    const flags = b[5];
    const declaredEnd = 10 + size;
    const truncated = b.length < declaredEnd;
    b = b.subarray(0, Math.min(b.length, declaredEnd));
    let body = b.subarray(10);
    if (v === 3 && flags & 0x80) body = unsync(body);
    let o = 0;
    if (flags & 0x40) o = v === 3 ? 4 + u32(body, 0) : syncsafe(body, 0);
    const { list, cut } = frames(body, o, body.length, v, v === 4 && !!(flags & 0x80));

    const chaps = new Map();
    const tocs = new Map();
    let top = null;
    for (const { id, data } of list) {
      if (id !== "CHAP" && id !== "CTOC") continue;
      const [elId, p] = text(data, 0, 0);
      if (id === "CHAP") {
        if (p + 16 > data.length) continue;
        chaps.set(elId, { secs: u32(data, p) / 1000, ...subInfo(data, p + 16, v) });
      } else {
        if (p + 2 > data.length) continue;
        const kids = [];
        let q = p + 2;
        for (let i = 0; i < data[p + 1] && q < data.length; i++) {
          const [kid, next] = text(data, q, 0);
          kids.push(kid);
          q = next;
        }
        tocs.set(elId, kids);
        if (data[p] & 0x02 && top === null) top = elId;
      }
    }

    /* The top-level CTOC names what is a chapter (through any nested tables);
       without one, every CHAP is. */
    let ids;
    if (top !== null) {
      ids = [];
      const seen = new Set();
      const walk = (tocId, depth) => {
        if (seen.has(tocId) || depth > 8) return;
        seen.add(tocId);
        for (const kid of tocs.get(tocId) ?? []) {
          if (tocs.has(kid)) walk(kid, depth + 1);
          else ids.push(kid);
        }
      };
      walk(top, 0);
      if ((truncated || cut) && ids.some((k) => !chaps.has(k))) return [];
    } else {
      if (truncated || cut) return [];
      ids = [...chaps.keys()];
    }

    const out = [];
    for (const k of new Set(ids)) {
      const c = chaps.get(k);
      if (!c || !Number.isFinite(c.secs)) continue;
      const row = { secs: c.secs, title: c.title };
      if (c.url) row.url = c.url;
      if (c.img) row.img = c.img;
      out.push(row);
    }
    out.sort((x, y) => x.secs - y.secs);
    return out.slice(0, MAX_CHAPTERS);
  } catch (_) {
    return [];
  }
}

/* ---------- the fetcher ---------- */

function isHttps(url) {
  try { return new URL(url).protocol === "https:"; } catch (_) { return false; }
}

function fromBase64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Plain fetch with a Range, reading at most `want` bytes even when the host
    ignores the Range and sends the whole file. */
async function viaFetch(fetchFn, url, want) {
  const res = await fetchFn(url, { headers: { Range: `bytes=0-${want - 1}` }, credentials: "omit", cache: "no-store" });
  if (!res || (res.status !== 206 && res.status !== 200)) return null;
  const reader = res.body?.getReader?.();
  if (!reader) return res.status === 206 ? new Uint8Array(await res.arrayBuffer()).subarray(0, want) : null;
  const out = new Uint8Array(want);
  let n = 0;
  while (n < want) {
    const { done, value } = await reader.read();
    if (done) break;
    const take = Math.min(value.length, want - n);
    out.set(value.subarray(0, take), n);
    n += take;
  }
  try { reader.cancel(); } catch (_) { /* nothing to release */ }
  return out.subarray(0, n);
}

/** CapacitorHttp, the plugin every Capacitor app carries built in. Its
    arraybuffer answer crosses the bridge as base64. */
async function viaNative(bridge, url, want, userAgent) {
  const headers = { Range: `bytes=0-${want - 1}` };
  if (userAgent) headers["User-Agent"] = userAgent;
  const res = await bridge.nativePromise("CapacitorHttp", "request", { url, method: "GET", headers, responseType: "arraybuffer" });
  if (!res || (res.status !== 206 && res.status !== 200)) return null;
  const d = res.data;
  const bytes = typeof d === "string" ? fromBase64(d) : d instanceof ArrayBuffer || ArrayBuffer.isView(d) ? new Uint8Array(d.buffer ?? d, d.byteOffset ?? 0, d.byteLength) : null;
  return bytes ? bytes.subarray(0, want) : null;
}

/**
 * @param {object}   [env]
 * @param {Function} [env.fetchFn]      fetch, or a fake
 * @param {Function} [env.getBridge]    () => window.Capacitor or null, read per call
 * @param {Function} [env.isOnline]     () => boolean | null (null: unknown, try)
 * @param {Function} [env.getDownloads] () => window.forayDownloads or null
 * @param {number}   [env.timeoutMs]
 */
export function createId3Reader({
  fetchFn = typeof fetch === "function" ? fetch : null,
  getBridge = () => null,
  isOnline = () => null,
  getDownloads = () => null,
  timeoutMs = CALL_TIMEOUT_MS,
} = {}) {
  const cache = new Map();

  /** One read of `want` bytes, raced against the deadline; null on any failure. */
  const read = (get) => new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    Promise.resolve().then(get).then((b) => resolve(b instanceof Uint8Array ? b : null), () => resolve(null)).finally(() => clearTimeout(t));
  });

  /** Header, then tag, through `get(want)`; null when the transport failed. */
  async function chaptersVia(get) {
    const head = await read(() => get(10));
    if (!head) return null;
    const size = tagSize(head);
    if (size < 0) return head.length >= 10 ? [] : null;
    const tag = await read(() => get(Math.min(10 + size, MAX_TAG_BYTES)));
    return tag ? parseId3Chapters(tag) : null;
  }

  function localSrc(id) {
    try {
      const d = getDownloads();
      const rec = id != null && typeof d?.recordFor === "function" ? d.recordFor(id) : null;
      if (!rec || rec.status !== "done" || typeof rec.path !== "string") return null;
      const src = d.bridge?.fileSrc?.({ path: rec.path }) ?? rec.webSrc;
      return typeof src === "string" && src && !src.startsWith("file:") ? src : null;
    } catch (_) { return null; }
  }

  async function load(url, id) {
    const local = localSrc(id);
    if (local && fetchFn) {
      const got = await chaptersVia((want) => viaFetch(fetchFn, local, want));
      if (got) return got;
    }
    if (isOnline() === false) return null; // not cached: try again once online
    const bridge = getBridge();
    if (typeof bridge?.nativePromise === "function") {
      let ua = null;
      try { ua = getDownloads()?.userAgent ?? null; } catch (_) { /* no UA */ }
      return chaptersVia((want) => viaNative(bridge, url, want, ua));
    }
    return fetchFn ? chaptersVia((want) => viaFetch(fetchFn, url, want)) : null;
  }

  return {
    /** The episode's chapters, `[]` when it has none or they cannot be read. */
    forUrl(url, { id } = {}) {
      if (typeof url !== "string" || !isHttps(url)) return Promise.resolve([]);
      if (cache.has(url)) return cache.get(url);
      const p = load(url, id).then((r) => {
        if (r === null) cache.delete(url); // a failed transport is retried next time
        return r ?? [];
      }, () => { cache.delete(url); return []; });
      cache.set(url, p);
      if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
      return p;
    },
    /** For tests and a sign-out: forget every answer. */
    clear: () => cache.clear(),
  };
}
