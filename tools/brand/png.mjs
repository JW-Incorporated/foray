/* Dependency-free PNG read/write. node:zlib does the compression; everything
   else here is the container and the per-scanline filters. 8-bit only, colour
   type 2 (RGB) and 6 (RGBA) only -- that is what our master is, and refusing
   the rest loudly beats decoding it wrongly and quietly. */
import zlib from "node:zlib";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let TAB = null;
function crcTable() {
  if (TAB) return TAB;
  TAB = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    TAB[n] = c;
  }
  return TAB;
}
function crc32(buf) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* IHDR plus a `tRNS` presence flag, WITHOUT decoding any pixels.

   Added for tools/mobile/inject-app-icon.mjs, and the reason it could not use
   decode() is the whole point: decode() normalises colour type 2 to RGBA and
   then reports `data` with an all-255 alpha channel, so the one question the
   App Store rejects an icon over -- "does this file carry an alpha channel?" --
   cannot be answered from its return value at all. It also throws on colour
   types 0 and 3 before a caller can say anything useful about them, and it does
   not look at `tRNS`, which adds transparency to a colour-type-2 image without
   changing the colour type.

   Deliberately a SECOND chunk walk rather than a refactor of decode(): decode's
   single pass collects IHDR and IDAT together, and the committed icons are
   byte-compared against its output by build-icons.test.mjs, so the cheap change
   here is the one that cannot alter them. */
export function header(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error("not a PNG");
  let p = 8, ihdr = null, transparency = false;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    if (type === "IHDR") {
      const d = buf.subarray(p + 8, p + 8 + len);
      if (d.length < 13) throw new Error("truncated IHDR");
      ihdr = {
        width: d.readUInt32BE(0), height: d.readUInt32BE(4),
        depth: d[8], colour: d[9], interlace: d[12],
      };
    } else if (type === "tRNS") transparency = true;
    else if (type === "IEND") break;
    p += 12 + len;
  }
  if (!ihdr) throw new Error("no IHDR");
  return { ...ihdr, transparency };
}

export function decode(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error("not a PNG");
  let p = 8, ihdr = null;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      ihdr = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        depth: data[8], colour: data[9], interlace: data[12],
      };
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  if (!ihdr) throw new Error("no IHDR");
  if (ihdr.depth !== 8) throw new Error(`unsupported bit depth ${ihdr.depth}`);
  if (ihdr.interlace !== 0) throw new Error("interlaced PNG unsupported");
  if (ihdr.colour !== 2 && ihdr.colour !== 6) throw new Error(`unsupported colour type ${ihdr.colour}`);

  const ch = ihdr.colour === 6 ? 4 : 3;
  const { width: w, height: h } = ihdr;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);

  let q = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[q++];
    const line = raw.subarray(q, q + stride); q += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
  }

  /* Normalise to RGBA so callers never branch on colour type. */
  if (ch === 4) return { width: w, height: h, data: out };
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0, j = 0; i < out.length; i += 3, j += 4) {
    rgba[j] = out[i]; rgba[j + 1] = out[i + 1]; rgba[j + 2] = out[i + 2]; rgba[j + 3] = 255;
  }
  return { width: w, height: h, data: rgba };
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/* `rgb: true` drops the alpha channel. Not an optimisation: the App Store
   rejects an icon that has one, and every icon this repo emits is opaque. */
export function encode({ width, height, data }, { rgb = false } = {}) {
  const ch = rgb ? 3 : 4;
  const stride = width * ch;

  /* Pack to the target channel count first, then filter. */
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(stride);
    if (rgb) {
      for (let x = 0; x < width; x++) {
        const s = (y * width + x) * 4, t = x * 3;
        row[t] = data[s]; row[t + 1] = data[s + 1]; row[t + 2] = data[s + 2];
      }
    } else {
      data.copy(row, 0, y * width * 4, (y + 1) * width * 4);
    }
    rows.push(row);
  }

  /* Adaptive per-scanline filtering, using the minimum-sum-of-absolute-
     differences heuristic from the PNG spec's own recommendation.

     This is not a micro-optimisation. Filtering every line with 0 (none) and
     letting zlib cope produced a 512px icon of 105.4 KB against the 8.7 KB one
     it replaced -- and both icons ship inside the mobile bundle, which is
     measured in hundreds of KB. A smooth gradient on a flat ground is close to
     the worst case for unfiltered PNG and close to the best case for Up/Paeth. */
  const filtered = Buffer.alloc(height * (stride + 1));
  const cand = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)];
  let prev = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const cur = rows[y];
    let best = 0, bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const out = cand[f];
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= ch ? cur[x - ch] : 0;
        const b = prev[x];
        const c = x >= ch ? prev[x - ch] : 0;
        let v;
        if (f === 0) v = cur[x];
        else if (f === 1) v = cur[x] - a;
        else if (f === 2) v = cur[x] - b;
        else if (f === 3) v = cur[x] - ((a + b) >> 1);
        else {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          v = cur[x] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
        out[x] = v & 0xff;
        /* Signed magnitude: bytes near 0 or 255 are both "small" deltas. */
        score += out[x] < 128 ? out[x] : 256 - out[x];
      }
      if (score < bestScore) { bestScore = score; best = f; }
    }
    filtered[y * (stride + 1)] = best;
    cand[best].copy(filtered, y * (stride + 1) + 1);
    prev = cur;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = ch === 3 ? 2 : 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = filtered;
  return Buffer.concat([
    SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
