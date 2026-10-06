/* A throwaway static origin for the harness. Serves either the repo root (the
 * current app) or any directory / single HTML file (a Phase 2 prototype).
 *
 * Prior art: test/playwright/lib/site-server.mjs. Same two mechanical
 * deviations for the real app, and for the same reasons:
 *   1. index.html's `media-src https:` is widened to `media-src 'self' https:`
 *      so the real <audio> element can play the silent fixture served from this
 *      origin. Applied only when the string is present; a prototype that has no
 *      such CSP is served untouched. Nothing else in the policy changes.
 *   2. `/__fixture-audio.wav` is a generated silent 60 s PCM WAV.
 * The network stub (stubs.mjs) also answers every https audio request with the
 * same WAV, so playback of real catalogue enclosure URLs never leaves the box.
 */
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";

export const AUDIO_PATH = "__fixture-audio.wav";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".wav": "audio/wav",
};

/** A silent mono 8-bit PCM WAV: small (8 KB/s) and playable without a codec. */
export function silentWav(seconds = 60, rate = 8000) {
  const samples = seconds * rate;
  const buf = Buffer.alloc(44 + samples);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples, 40);
  buf.fill(128, 44);
  return buf;
}
export const AUDIO = silentWav();

/**
 * @param {string} target  a directory, or an .html file (its directory is served
 *                         and the file is the entry page)
 * @returns {Promise<{baseUrl:string, entryUrl:string, audioUrl:string, close():Promise<void>}>}
 */
export function startServer(target) {
  const abs = path.resolve(target);
  const isFile = existsSync(abs) && statSync(abs).isFile();
  const root = isFile ? path.dirname(abs) : abs;
  const entry = isFile ? path.basename(abs) : "index.html";
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    let rel = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    if (rel === "") rel = entry;
    if (rel === AUDIO_PATH) {
      res.writeHead(200, { "content-type": TYPES[".wav"], "content-length": String(AUDIO.length), "accept-ranges": "none" });
      res.end(AUDIO);
      return;
    }
    let full = path.resolve(root, rel);
    if (full !== root && !full.startsWith(root + path.sep)) { res.writeHead(403).end("forbidden"); return; }
    if (existsSync(full) && statSync(full).isDirectory()) full = path.join(full, "index.html");
    if (!existsSync(full) || !statSync(full).isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found: " + rel);
      return;
    }
    const ext = path.extname(full).toLowerCase();
    let body = readFileSync(full);
    if (ext === ".html") {
      const text = body.toString("utf8").replace("media-src https:", "media-src 'self' https:");
      body = Buffer.from(text, "utf8");
    }
    res.writeHead(200, { "content-type": TYPES[ext] || "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const baseUrl = `http://127.0.0.1:${port}/`;
      resolve({
        port,
        baseUrl,
        entryUrl: baseUrl + (isFile ? entry : ""),
        audioUrl: `${baseUrl}${AUDIO_PATH}`,
        close() {
          for (const s of sockets) s.destroy();
          return new Promise((r) => server.close(r));
        },
      });
    });
  });
}
