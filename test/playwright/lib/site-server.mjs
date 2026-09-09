/* A static origin serving the REAL site — index.html, styles.css, app.js,
 * search-engine.js, player/*.js and data/*.json straight off the repo root —
 * for the UI specs in test/playwright/tests/ (U-12/U-13, founder feedback
 * F17/F18).
 *
 * DELIBERATELY NOT `lib/server.mjs`. That one is an in-memory fixture whose
 * whole reason for existing is to recompute `deploy-manifest.json` per request
 * and to change what the origin serves mid-test, so sw.js's promotion state
 * machine has something to react to; it serves the minimal `fixture/app.js`
 * stand-in, which has no UI at all. These specs need the opposite: the actual
 * shipped markup, the actual stylesheet (the whole point of U-12 is a z-index
 * ladder) and the actual player module, unchanged, with nothing simulated.
 * Same runner, same config, same `npm test` — a different origin.
 *
 * TWO DEVIATIONS FROM THE BYTES ON DISK, both mechanical, both narrow:
 *
 *   1. `media-src https:` in index.html's CSP is widened to `media-src 'self'
 *      https:`. Episode audio in production comes from podcast CDNs over
 *      https, which is exactly what that directive is for (see index.html's
 *      own comment) — but a test cannot reach a CDN, and `data:`/`blob:` are
 *      blocked by the same directive, so the only way to give the real
 *      <audio> element something real to play is to serve it from this
 *      origin. Nothing else in the policy is touched, and the substitution is
 *      asserted to have happened (a CSP that silently stopped matching would
 *      otherwise turn into a mystery "audio never plays" failure).
 *   2. `/__fixture-audio.wav` is served in addition to the repo's own files —
 *      a generated, silent, 60-second PCM WAV. Silent because these specs are
 *      about what the CHROME does while something is loaded, and long enough
 *      that nothing can reach its end mid-test and pause itself.
 *
 * Service workers are blocked at the context level by the specs themselves
 * (`test.use({ serviceWorkers: "block" })`), so app.js's own registration
 * never runs here and cannot serve one test a cached copy of another's page.
 */
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..", "..");

/** Path the specs hand to `ForayPlayer.play({ audio_url })`. */
export const AUDIO_PATH = "__fixture-audio.wav";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".wav": "audio/wav",
};

/** A silent mono 8-bit PCM WAV of `seconds` at 8 kHz — small (8 KB/s) and
    playable by every browser without a codec. */
function silentWav(seconds = 60, rate = 8000) {
  const samples = seconds * rate;
  const buf = Buffer.alloc(44 + samples);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);      // PCM header size
  buf.writeUInt16LE(1, 20);       // format: PCM
  buf.writeUInt16LE(1, 22);       // channels
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28);    // byte rate (8-bit mono)
  buf.writeUInt16LE(1, 32);       // block align
  buf.writeUInt16LE(8, 34);       // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(samples, 40);
  buf.fill(128, 44);              // 8-bit PCM silence is 0x80, not 0x00
  return buf;
}

const AUDIO = silentWav();

/** index.html with the one CSP widening described in this file's header. */
function indexHtml() {
  const src = readFileSync(path.join(REPO_ROOT, "index.html"), "utf8");
  const widened = src.replace("media-src https:", "media-src 'self' https:");
  if (widened === src) {
    throw new Error(
      "site-server: index.html no longer contains `media-src https:` — the CSP " +
      "widening this fixture depends on stopped matching, so <audio> would be " +
      "blocked and every playback assertion would fail for the wrong reason"
    );
  }
  return widened;
}

/** Resolves a request path to a real file inside the repo, or null. Rejects
    anything that escapes the root, so a `..` in a URL cannot read the box. */
function resolveSafe(rel) {
  const full = path.resolve(REPO_ROOT, rel);
  const root = path.resolve(REPO_ROOT);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  if (!existsSync(full) || !statSync(full).isFile()) return null;
  return full;
}

/**
 * Starts the origin and resolves `{ baseUrl, close() }`. Every socket is
 * tracked so `close()` returns promptly even with a keep-alive connection
 * still open — the same reason `lib/server.mjs` tracks its own.
 */
export function startSiteServer() {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const rel = decodeURIComponent(url.pathname.replace(/^\/+/, "")) || "index.html";

    if (rel === AUDIO_PATH) {
      res.writeHead(200, {
        "content-type": TYPES[".wav"],
        "content-length": String(AUDIO.length),
        "accept-ranges": "none",
      });
      res.end(AUDIO);
      return;
    }
    if (rel === "index.html") {
      const body = indexHtml();
      res.writeHead(200, { "content-type": TYPES[".html"] });
      res.end(body);
      return;
    }
    const full = resolveSafe(rel);
    if (!full) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found: " + rel);
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(full).toLowerCase()] || "application/octet-stream",
    });
    res.end(readFileSync(full));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}/`,
        audioUrl: `http://127.0.0.1:${port}/${AUDIO_PATH}`,
        close() {
          for (const socket of sockets) socket.destroy();
          return new Promise((r) => server.close(r));
        },
      });
    });
  });
}
