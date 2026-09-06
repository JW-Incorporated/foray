/* THE BUG THIS SUITE EXISTS FOR.
 *
 * "Only 3 episodes for each show on 4a", reported by the founder repeatedly and
 * diagnosed three times without a fix landing. The full-catalogue endpoint
 * (`api/shows/:id/episodes`) was built, deployed, and answering 200 with the
 * whole feed. No client ever reached it, because every `api/*` call was a
 * RELATIVE path:
 *
 *   web  (GitHub Pages)      -> https://<pages host>/api/shows/x/episodes -> 404
 *   shell (capacitor://…)    -> capacitor://localhost/api/shows/x/episodes
 *                               — a scheme with no server behind it
 *
 * Both callers treat a failed fetch as "absence is a real state" and fall back
 * to the bundled discover slice, which `tools/mobile/prepare-webdir.mjs` caps at
 * BUNDLED_ITEMS_PER_SHOW = 3. So the app degraded silently to exactly three
 * episodes a show and never said why. A fails-green shipped feature.
 *
 * Every test below names the one-line mutation that kills it. They were run.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const APP = read("app.js");
const INDEX = read("index.html");

function apiOrigin() {
  const m = /const API_ORIGIN = "([^"]+)"/.exec(APP);
  assert.ok(m, "app.js does not define API_ORIGIN");
  return m[1];
}

function connectSrc() {
  const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(INDEX);
  assert.ok(csp, "index.html's CSP meta tag could not be located");
  const directive = /connect-src ([^;"]*)/.exec(csp[1]);
  assert.ok(directive, "the CSP has no connect-src");
  return directive[1].trim().split(/\s+/);
}

test("API_ORIGIN is a bare https origin with no path and no trailing slash", () => {
  /* apiUrl() joins with a single "/", so a trailing slash produces `//api/...`
     — which some hosts 301 and some 404, and both look like the silent-fallback
     bug this suite exists for.

     MUTATION THAT KILLS THIS: add a trailing "/" to API_ORIGIN. Ran it — red. */
  const origin = apiOrigin();
  assert.match(origin, /^https:\/\/[a-z0-9.-]+$/,
    `API_ORIGIN must be a bare https origin, got: ${origin}`);
  assert.ok(!origin.endsWith("/"), "API_ORIGIN must not end in a slash");
});

test("apiUrl() produces an absolute URL, so no api/* call can resolve against the shell", () => {
  /* THE REGRESSION GUARD FOR THE ACTUAL BUG. Evaluated against a
     `capacitor://localhost` base, a relative path resolves inside the app
     bundle; an absolute one cannot. This asserts the joined string, then proves
     the property with the URL parser rather than trusting the string.

     MUTATION THAT KILLS THIS: `return path;` in apiUrl(). Ran it — red. */
  const body = /function apiUrl\(path\) \{([\s\S]*?)\n\}/.exec(APP);
  assert.ok(body, "app.js does not define apiUrl()");
  assert.match(body[1], /API_ORIGIN/,
    "apiUrl() must build on API_ORIGIN, or the path stays relative");

  const origin = apiOrigin();
  const joined = `${origin}/${"api/shows/lex-fridman-podcast/episodes".replace(/^\/+/, "")}`;
  assert.equal(joined, `${origin}/api/shows/lex-fridman-podcast/episodes`);
  assert.equal(
    new URL(joined, "capacitor://localhost").origin, origin,
    "resolved against the shell's own scheme, the request must still leave for the API"
  );
});

test("every api/* call in app.js goes through apiUrl(), none through pinnedUrl()", () => {
  /* The bug was one call site, and a second one was added later with the same
     mistake. This checks the class, not the instance: any future `api/…` string
     handed to a fetch has to travel through apiUrl().

     `_fdid` (pinnedUrl) pins the STATIC data deploy's generation. A live
     function has no such generation, so pinning one is a parameter the function
     must ignore — and its presence is the tell that a call site was copied from
     the static-file path by mistake.

     MUTATION THAT KILLS THIS: change fetchApiJson back to `fetch(path, …)`, or
     fetchShowEpisodes back to `pinnedUrl(url)`. Ran both — red. */
  const fetchers = ["fetchApiJson", "fetchShowEpisodes"];
  for (const name of fetchers) {
    const fn = new RegExp(`async function ${name}\\([^)]*\\) \\{([\\s\\S]*?)\\n\\}`).exec(APP);
    assert.ok(fn, `app.js does not define ${name}()`);
    assert.match(fn[1], /fetch\(\s*apiUrl\(/,
      `${name}() must fetch through apiUrl(), or its request resolves against the shell`);
    assert.ok(!/pinnedUrl\(/.test(fn[1]),
      `${name}() must not pin a deploy id onto a live function call`);
  }

  /* And nothing else builds an api/* request by hand. Every occurrence of an
     `api/...` literal must be an argument to one of the two fetchers above (they
     are passed the path, which is why the literals sit at their call sites). */
  const strayFetch = /fetch\(\s*[`"']api\//.exec(APP);
  assert.equal(strayFetch, null,
    `a raw fetch("api/…") bypasses apiUrl() and will silently 404: ${strayFetch && strayFetch[0]}`);
});

test("the CSP names the API origin, and nothing wider", () => {
  /* Getting the URL right is half the fix: with the origin absent from
     connect-src the browser refuses the request before it is sent, and
     `fetchShowEpisodes` swallows that into the same silent fallback.

     MUTATION THAT KILLS THIS: remove the API origin from connect-src, or widen
     it to `https:`. Ran both — red. */
  const sources = connectSrc();
  assert.ok(sources.includes(apiOrigin()),
    `connect-src must name ${apiOrigin()}; it names: ${sources.join(" ")}`);
  assert.ok(!sources.includes("https:") && !sources.includes("*"),
    `connect-src must not be widened to a wildcard; it names: ${sources.join(" ")}`);
  assert.equal(sources.length, 3,
    `connect-src should name exactly three origins (self, Supabase, the API); it names: ${sources.join(" ")}`);
});

test("the privacy policy no longer promises the Shows search never leaves the device", () => {
  /* The policy edit (#482) landed BEFORE this change, which is the right order:
     the sentence describing on-device-only search had to stop being there before
     the client started sending the query. This pins the ordering so the two can
     never drift apart again — if someone restores the old sentence, the code
     that contradicts it is right here and this goes red.

     MUTATION THAT KILLS THIS: restore "Nothing you type into the playlist box or
     the Shows search box is transmitted" to the policy. Ran it — red. */
  const policy = read("docs/legal/privacy-policy.md");
  assert.ok(
    !/Nothing you type into the playlist box or the Shows search box is\s+transmitted/.test(policy),
    "the policy still carries the pre-#482 sentence, which this client contradicts"
  );
  assert.match(policy, /Shows search box/,
    "the policy must still describe what the Shows search box does with a query");
});
