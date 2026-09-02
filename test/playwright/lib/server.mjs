/* Minimal single-origin HTTP server standing in for GitHub Pages, for the
 * Playwright browser-integration suite in test/playwright/tests/.
 *
 * Deliberately not a static file server: `deploy-manifest.json` is computed
 * ON EVERY REQUEST from whatever `files` map is currently set, using the SAME
 * sha256/deploy_id derivation tools/ci/generate-manifest.mjs uses for the real
 * site (see computeManifest below) — so a test can call `setFiles()` mid-run
 * to simulate a new deploy landing on the origin, exactly as GitHub Pages
 * content changes under a live worker, with no separate manifest-regeneration
 * step to keep in sync.
 *
 * TRACKED lists only the four files this fixture's sw.js pin logic actually
 * needs to reason about (the full SHELL/RUNTIME_DATA lists in
 * tools/ci/generate-manifest.mjs are a real-site concern, not a protocol
 * one) — this file exists to drive sw.js's install/activate/fetch state
 * machine, not to reproduce the production manifest contents.
 */
import http from "node:http";
import crypto from "node:crypto";

export const TRACKED = ["index.html", "app.js", "player/client.js", "data/forays.json"];

function computeManifest(files) {
  const entries = TRACKED.filter((k) => files[k] !== undefined).map((k) => {
    const hash = crypto.createHash("sha256").update(files[k]).digest("hex");
    return [k, "sha256:" + hash];
  });
  const filesObj = Object.fromEntries(entries);
  const lines = entries.map(([k, v]) => `${k}:${v}`).sort().join("\n") + "\n";
  const deployId = crypto.createHash("sha256").update(lines).digest("hex").slice(0, 16);
  return { deploy_id: deployId, files: filesObj };
}

function contentType(p) {
  if (p.endsWith(".html")) return "text/html; charset=utf-8";
  if (p.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (p.endsWith(".json")) return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}

/**
 * @param {Record<string,string>} initialFiles Extra static files served
 *   verbatim (e.g. the fixture's own app.js/index.html, and sw.js), keyed by
 *   root-relative path. May overlap TRACKED — those entries also count
 *   toward the manifest.
 */
export function startFixtureServer(initialFiles) {
  let files = { ...initialFiles };
  /* Normally deploy-manifest.json is computed LIVE from `files` on every
     request — see the header above. That makes an ordinary setFiles() call
     unable to produce a genuine hash mismatch: the manifest and the file
     content always change together, self-consistently, no matter what a
     test mutates. freezeManifestNow() snapshots the CURRENT computed
     manifest and serves that snapshot from then on, so a test can change
     `files` afterward (a torn deploy: the origin now answers with bytes
     that do not match what the frozen manifest recorded) without the
     manifest silently following along. unfreezeManifest() returns to the
     normal live-computed behaviour. */
  let manifestOverride = null;
  /* Paths currently hung (request never answers — MODULE LOAD TIMEOUT) or
     forced to fail (a plain connection reset — PARTIAL CACHE POPULATION's
     "mid-manifest fetch failure" case). Both keyed by root-relative path,
     both cleared with setFiles()/replaceFiles() implicitly NOT clearing them
     (a test controls them explicitly via hangOn()/failOn()/clearFaults()) so
     a test can change file CONTENT mid-run without accidentally un-hanging a
     path it is still relying on staying hung. */
  const hungPaths = new Set();
  const failPaths = new Set();
  /* Every socket this server has ever accepted, so close() can force them
     shut. Plain server.close() waits for in-flight connections to end on
     their own — and a hungOn() request never does, by design — which would
     hang test cleanup (a `finally { await server.close() }`) forever on
     exactly the tests that most need to close cleanly. */
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const p = decodeURIComponent(url.pathname.replace(/^\//, "")) || "index.html";

    if (hungPaths.has(p)) {
      // Never write a response. The client's own NET_TIMEOUT_MS (sw.js) or
      // the test's explicit race is what ends this, not the server.
      return;
    }
    if (failPaths.has(p)) {
      req.socket.destroy();
      return;
    }
    if (p === "deploy-manifest.json") {
      const manifest = manifestOverride || computeManifest(files);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(manifest));
      return;
    }
    if (Object.prototype.hasOwnProperty.call(files, p)) {
      res.writeHead(200, { "content-type": contentType(p) });
      res.end(files[p]);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found: " + p);
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
        /** Merge new file contents in (a "new deploy landing"). */
        setFiles(next) {
          files = { ...files, ...next };
        },
        /** Replace the whole file set. */
        replaceFiles(next) {
          files = { ...next };
        },
        /** Path(s) that never answer from now on, until clearFaults(). */
        hangOn(...paths) {
          for (const p of paths) hungPaths.add(p);
        },
        /** Path(s) whose connection is reset from now on, until clearFaults(). */
        failOn(...paths) {
          for (const p of paths) failPaths.add(p);
        },
        clearFaults() {
          hungPaths.clear();
          failPaths.clear();
        },
        /** Snapshot the CURRENT live manifest and keep serving that snapshot
            regardless of later setFiles()/replaceFiles() calls — see this
            function's header for why an ordinary mutation can't produce a
            real hash mismatch on its own. */
        freezeManifestNow() {
          manifestOverride = computeManifest(files);
        },
        unfreezeManifest() {
          manifestOverride = null;
        },
        currentManifest() {
          return manifestOverride || computeManifest(files);
        },
        close() {
          // Force-destroy any sockets still open (a hungOn() request that
          // never got a response) before closing, so a test that used
          // hangOn() and forgot clearFaults() before close() still tears
          // down instead of hanging the whole run — see the `sockets`
          // comment above.
          for (const socket of sockets) socket.destroy();
          return new Promise((r) => server.close(r));
        },
      });
    });
  });
}
