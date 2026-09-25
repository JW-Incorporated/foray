/* The Playwright fixture server's sw.js follows the deploy (round-3 audit,
 * tests-1).
 *
 * A browser only re-runs a service worker's install() when the fetched sw.js
 * differs byte for byte from the registered copy. Production gets that from
 * the deploy build stamping BUILD_ID with the deploy id. The fixture server in
 * test/playwright/lib/server.mjs used to serve the copied sw.js verbatim, so a
 * spec's setFiles() "new deploy" never changed the worker's bytes, update() was
 * a no-op, and every "the old generation survives a new deploy" spec passed
 * without a second install ever running.
 *
 * The Playwright suite itself runs only in CI's `playwright` job (a real
 * Chromium). This suite pins the fixture half with plain HTTP, so a change that
 * stops stamping fails here, locally, with no browser.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const serverModule = import("./playwright/lib/server.mjs");
const startFixtureServer = async (files) => (await serverModule).startFixtureServer(files);

const SW = 'const CACHE_PREFIX = "foray-gen-";\nconst BUILD_ID = "unstamped";\nself.addEventListener("install", () => {});\n';

async function get(server, path) {
  const res = await fetch(server.baseUrl + path);
  return res.text();
}

test("the fixture serves sw.js stamped with the deploy id of the manifest it is serving", async () => {
  /* MUTATION: serve files["sw.js"] verbatim again (drop the stampSw branch in
     server.mjs) — BUILD_ID stays "unstamped" and this goes red. */
  const server = await startFixtureServer({ "sw.js": SW, "data/forays.json": '{"forays":["v1"]}' });
  try {
    const id1 = server.currentManifest().deploy_id;
    const sw1 = await get(server, "sw.js");
    assert.match(sw1, new RegExp(`const BUILD_ID = "${id1}";`));
    assert.ok(sw1.includes('self.addEventListener("install"'), "the rest of the worker is served unchanged");
  } finally {
    await server.close();
  }
});

test("a new deploy (setFiles) changes the worker's bytes, so a browser's update() really installs", async () => {
  const server = await startFixtureServer({ "sw.js": SW, "data/forays.json": '{"forays":["v1"]}' });
  try {
    const sw1 = await get(server, "sw.js");
    server.setFiles({ "data/forays.json": '{"forays":["v2"]}' });
    const id2 = server.currentManifest().deploy_id;
    const sw2 = await get(server, "sw.js");
    assert.notEqual(sw2, sw1, "identical bytes mean no install: the 'new deploy' specs would test nothing");
    assert.match(sw2, new RegExp(`const BUILD_ID = "${id2}";`));
  } finally {
    await server.close();
  }
});

test("a frozen manifest keeps the worker stamped with the frozen deploy id, as a torn deploy would serve it", async () => {
  const server = await startFixtureServer({ "sw.js": SW, "data/forays.json": '{"forays":["v1"]}' });
  try {
    server.setFiles({ "data/forays.json": '{"forays":["v2"]}' });
    server.freezeManifestNow();
    const frozen = server.currentManifest().deploy_id;
    server.setFiles({ "data/forays.json": '{"forays":["tampered"]}' });
    assert.match(await get(server, "sw.js"), new RegExp(`const BUILD_ID = "${frozen}";`));
  } finally {
    await server.close();
  }
});
