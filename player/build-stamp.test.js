/* Which build made this record? (founder report 3, 2026-09-22)

   `player/build-stamp.js` reads the two numbers a pasted diagnostics record
   needs to be placed against a release: the web deploy id, and in the shell the
   native build number. These pin where each comes from on each host, that every
   value is admitted by shape, and that nothing here can throw into a boot. */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BUILD_STAMP_FILE, DEPLOY_MANIFEST_FILE, BUILD_STAMP_WAIT_MS, deployIdOf, buildStampDoc, nativeBuildOf, readBuildStamp,
} from "./build-stamp.js";

/** A fetch that answers from a table, and records what it was asked. */
function fetchFrom(table) {
  const asked = [];
  const fetchJson = async (url) => {
    asked.push(url);
    if (!(url in table)) throw new Error("404");
    return table[url];
  };
  return { fetchJson, asked };
}

test("the shell reads the bundled stamp AND asks the binary for its build number", async () => {
  /* KILLING MUTATION: drop the `nativePromise("App", "getInfo")` call — the
     record then carries the web half only, which cannot tell two store builds
     of the same commit apart (the 2026-09-22 failed-upload case exactly). */
  const { fetchJson, asked } = fetchFrom({ [BUILD_STAMP_FILE]: { deploy_id: "2b808ec9d50c5b98" } });
  const capacitor = {
    nativePromise: async (plugin, method) => {
      assert.equal(plugin, "App");
      assert.equal(method, "getInfo");
      return { build: "2026092224", version: "1.4.0", name: "4a", id: "ai.jwlabs.foura" };
    },
  };
  const stamp = await readBuildStamp({ inShell: true, fetchJson, capacitor });
  assert.deepEqual(stamp, { shell: true, web: "2b808ec9d50c5b98", native: "2026092224", version: "1.4.0" });
  assert.deepEqual(asked, [BUILD_STAMP_FILE], "the shell has no manifest to ask");
});

test("the website reads the manifest, and prefers the generation the worker PINNED the page to", async () => {
  /* A page the service worker served from a retained generation is running that
     generation's code, not the manifest's newest. KILLING MUTATION: read the
     manifest first. */
  const { fetchJson, asked } = fetchFrom({ [DEPLOY_MANIFEST_FILE]: { deploy_id: "aaaaaaaaaaaaaaaa" } });
  assert.deepEqual(
    await readBuildStamp({ inShell: false, fetchJson, pinned: "bbbbbbbbbbbbbbbb" }),
    { shell: false, web: "bbbbbbbbbbbbbbbb", native: null, version: null },
  );
  assert.deepEqual(asked, [], "a pinned page does not need to ask");
  assert.equal((await readBuildStamp({ inShell: false, fetchJson })).web, "aaaaaaaaaaaaaaaa");
});

test("nothing here throws: a missing file, a throwing bridge and no fetch all read as unknown", async () => {
  const boom = { nativePromise: async () => { throw new Error("plugin not implemented"); } };
  assert.deepEqual(
    await readBuildStamp({ inShell: true, fetchJson: async () => { throw new Error("404"); }, capacitor: boom }),
    { shell: true, web: null, native: null, version: null },
  );
  assert.deepEqual(await readBuildStamp({}), { shell: false, web: null, native: null, version: null });
});

test("every value is admitted by SHAPE — the record is pasted into issues", () => {
  /* KILLING MUTATION: return the raw value from `deployIdOf`. */
  assert.equal(deployIdOf("2B808EC9D50C5B98"), "2b808ec9d50c5b98");
  assert.equal(deployIdOf("https://evil.example/?q=1"), null);
  assert.equal(deployIdOf(""), null);
  assert.deepEqual(nativeBuildOf({ build: 2026092224, version: "1.4.0" }), { build: "2026092224", version: "1.4.0" });
  assert.deepEqual(nativeBuildOf({ build: "Wyatt's iPhone", version: null }), { build: null, version: null });
});

test("the bundle's stamp is the manifest's id alone, and a manifest with none stops the build", () => {
  assert.deepEqual(buildStampDoc({ deploy_id: "2b808ec9d50c5b98", files: { "app.js": "sha256:00" } }),
    { deploy_id: "2b808ec9d50c5b98" });
  assert.throws(() => buildStampDoc({ files: {} }), /no usable deploy_id/);
});

test("a bridge that never answers cannot cost the row: the web half is stamped, the native half is `?`", { timeout: 5000 }, async () => {
  /* 2026-09-23: the founder's record had no build row at all. `client.js`
     writes the row when this promise settles, so a `getInfo` that never came
     back meant no row — not even the web half, which had already been read.
     KILLING MUTATION: drop `withinMs` around the native call. This test times
     out instead of finishing (the `timeout` above is what makes the hang a
     failure rather than a stuck suite). */
  const { fetchJson } = fetchFrom({ [BUILD_STAMP_FILE]: { deploy_id: "2b808ec9d50c5b98" } });
  const hung = { nativePromise: () => new Promise(() => {}) };
  const stamp = await readBuildStamp({ inShell: true, fetchJson, capacitor: hung, timeoutMs: 20 });
  assert.deepEqual(stamp, { shell: true, web: "2b808ec9d50c5b98", native: null, version: null });
});

test("the bound is PER HALF: a bundle read that hangs still lets the binary answer", { timeout: 5000 }, async () => {
  /* The other order. A stamp file the WebView never serves must not take the
     native build number with it — that number is the one that separates two
     store builds of the same commit.
     KILLING MUTATION: bound only the native call. This times out. */
  const fetchJson = () => new Promise(() => {});
  const capacitor = { nativePromise: async () => ({ build: "2026092326", version: "1.4.0" }) };
  const stamp = await readBuildStamp({ inShell: true, fetchJson, capacitor, timeoutMs: 20 });
  assert.deepEqual(stamp, { shell: true, web: null, native: "2026092326", version: "1.4.0" });
  assert.equal(BUILD_STAMP_WAIT_MS, 5000, "the shipped bound matches app.js's wait on hydration");
});
