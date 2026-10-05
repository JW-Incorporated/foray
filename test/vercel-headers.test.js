/* The `headers` block of `vercel.json`, pinned — because the phone path depends
 * on one line of it that nothing else in the repo can see.
 *
 * WHY THIS EXISTS (FD-06, docs/foray-directory-plan.md)
 * The Capacitor shell reads the Foray directory — `data/forays-directory.json`
 * and the three data files it names — from the live origin
 * (`https://foray-web-seven.vercel.app`) at boot and on foreground
 * (`player/foray-directory.js`, PR #610). The shell's own origin is
 * `capacitor://localhost`, so every one of those fetches is CROSS-ORIGIN, and a
 * response without `Access-Control-Allow-Origin` is one the WebView hands back
 * to `fetch()` as a network error. #610 measured what that looks like: the
 * refresh reports `offline`, the bundled seed keeps playing, and the feature is
 * inert on a phone while every test stays green. `api/**` handlers set the
 * header in code (`api/_lib/cors.ts`); static files get it ONLY from
 * `vercel.json`, and until this suite existed nothing read that file's
 * `headers` at all (`api/test/vercel-bundle.test.mjs` pins `functions`, not
 * `headers`).
 *
 * WHAT IS PINNED
 *   1. Every header rule whose `source` matches the pointer path or one of the
 *      three file paths the committed pointer names sends
 *      `Access-Control-Allow-Origin: *`. `*` is right here: the files are
 *      static, public JSON, fetched with a plain GET and no credentials — the
 *      same bytes any browser can read from the site.
 *   2. The header is scoped to `/data/`: no rule outside it carries any
 *      `Access-Control-*` header. The policy sentence this PR adds promises a GET
 *      of static JSON; widening CORS to the app shell or `/player/` is a
 *      different decision and should read as one.
 *   3. #606's `Cache-Control` split survives: bare `data/` paths always
 *      revalidate (`max-age=0, must-revalidate`), and only a request carrying a
 *      `?v=` query gets the one-year `immutable` header. The bare path changes
 *      on every deploy, so an immutable header on it would poison exactly the
 *      client this suite exists for (the shell has no service worker to bypass
 *      the HTTP cache).
 *   4. The versioned rule is listed AFTER the bare rule. Vercel applies every
 *      matching rule and a later rule wins for the same key; reversed, the
 *      bare-path rule would override the immutable header and the `?v=` copy
 *      would silently stop being long-lived.
 *
 * The four paths are read out of `data/forays-directory.json` rather than typed
 * here, so the suite pins the paths the shell actually fetches — a renamed file
 * in the pointer is checked against the rules the day it lands.
 *
 * MUTATIONS, each run and red:
 *   - drop `Access-Control-Allow-Origin` from the `/data/(.*)` rule → test 1
 *     red, naming the pointer path (the header is gone for every path; the
 *     versioned rule alone cannot cover the bare-path fetches the shell makes).
 *   - drop it from the `?v=` rule only → test 1 red for the three files: the
 *     later rule matches too, and a matching rule without the header is a
 *     rule that would drop it the day the two rules stop merging.
 *   - add `Access-Control-Allow-Origin: *` to the `/(app.js|…)` rule → test 2 red.
 *   - delete `has: [{ type: "query", key: "v" }]` from the immutable rule →
 *     test 3 red (a bare path would match an immutable rule), and test 4 red
 *     too, because no versioned rule is left to order.
 *   - swap the two `/data/` rules → test 4 red.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

const CORS_KEY = "access-control-allow-origin";
const CACHE_KEY = "cache-control";

/** `vercel.json`'s `source` values in this repo are plain regex groups
 *  (`/data/(.*)`, `/data/(forays|segments|segment-sources)\.json`), matched by
 *  Vercel against the pathname WITHOUT the query string. Anchored both ends. */
function sourceMatches(source, pathname) {
  return new RegExp(`^${source}$`).test(pathname);
}

function headerValue(rule, key) {
  const hit = (rule.headers || []).find((h) => String(h.key).toLowerCase() === key);
  return hit ? String(hit.value) : null;
}

function hasQuery(rule, key) {
  return (rule.has || []).some((c) => c.type === "query" && c.key === key);
}

function directoryPaths() {
  const pointer = read("data/forays-directory.json");
  const files = Object.values(pointer.files || {});
  assert.equal(files.length, 3, "data/forays-directory.json should name exactly three files");
  return ["data/forays-directory.json", ...files];
}

function headerRules() {
  const rules = read("vercel.json").headers;
  assert.ok(Array.isArray(rules) && rules.length > 0, "vercel.json has no `headers` rules at all");
  return rules;
}

test("every rule that serves the Foray directory sends Access-Control-Allow-Origin: * — the header that makes the phone path live", () => {
  const rules = headerRules();
  const missing = [];
  for (const rel of directoryPaths()) {
    const pathname = `/${rel}`;
    const matching = rules.filter((r) => sourceMatches(r.source, pathname));
    assert.ok(matching.length > 0, `no vercel.json header rule matches ${pathname}`);
    for (const r of matching) {
      if (headerValue(r, CORS_KEY) !== "*") missing.push(`${pathname} ← source "${r.source}"`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    "a rule that serves a directory file does not send `Access-Control-Allow-Origin: *`. " +
      "The Capacitor shell fetches these cross-origin from capacitor://localhost; without the " +
      "header its refresh reports `offline` and the bundled seed keeps playing forever:\n" +
      missing.join("\n")
  );
});

test("Access-Control-* headers are scoped to /data/ — no other rule carries one", () => {
  const offenders = headerRules()
    .filter((r) => !r.source.startsWith("/data/"))
    .flatMap((r) =>
      (r.headers || [])
        .filter((h) => String(h.key).toLowerCase().startsWith("access-control-"))
        .map((h) => `source "${r.source}" sends ${h.key}: ${h.value}`)
    );
  assert.deepEqual(
    offenders,
    [],
    "CORS is a promise about static public JSON under /data/ (privacy policy §2); " +
      "widening it is a separate decision:\n" + offenders.join("\n")
  );
});

test("#606's Cache-Control split is intact: bare data paths revalidate, only ?v= copies are immutable", () => {
  const rules = headerRules();
  for (const rel of directoryPaths()) {
    const pathname = `/${rel}`;
    for (const r of rules.filter((x) => sourceMatches(x.source, pathname))) {
      const cc = headerValue(r, CACHE_KEY);
      assert.ok(cc, `rule "${r.source}" matches ${pathname} but sets no Cache-Control`);
      if (/immutable/.test(cc)) {
        assert.ok(
          hasQuery(r, "v"),
          `rule "${r.source}" serves ${pathname} as immutable without requiring a ?v= query — ` +
            "the bare path changes every deploy and the shell has no service worker to bypass a poisoned HTTP cache"
        );
      } else {
        assert.match(cc, /max-age=0/, `bare-path rule "${r.source}" must be max-age=0`);
        assert.match(cc, /must-revalidate/, `bare-path rule "${r.source}" must revalidate`);
      }
    }
  }
  // The pointer is never immutable: it is the thing that changes.
  const pointerImmutable = rules.filter(
    (r) => sourceMatches(r.source, "/data/forays-directory.json") && /immutable/.test(headerValue(r, CACHE_KEY) || "")
  );
  assert.deepEqual(pointerImmutable.map((r) => r.source), [], "the pointer must never be served immutable");
  // And the three files DO have an immutable copy reachable with ?v=.
  const pointer = read("data/forays-directory.json");
  for (const rel of Object.values(pointer.files)) {
    const versioned = rules.find(
      (r) => sourceMatches(r.source, `/${rel}`) && hasQuery(r, "v") && /immutable/.test(headerValue(r, CACHE_KEY) || "")
    );
    assert.ok(versioned, `/${rel}?v=<version> has no immutable rule — #606's long-lived copy is gone`);
  }
});

test("the ?v= (immutable) rule is listed after the bare /data/ rule, so it wins for the same key", () => {
  const rules = headerRules();
  const bare = rules.findIndex((r) => sourceMatches(r.source, "/data/forays-directory.json") && !r.has);
  const versioned = rules.findIndex((r) => hasQuery(r, "v") && /immutable/.test(headerValue(r, CACHE_KEY) || ""));
  assert.ok(bare >= 0, "no bare /data/ rule found");
  assert.ok(versioned >= 0, "no ?v= immutable rule found");
  assert.ok(
    versioned > bare,
    `the ?v= rule (index ${versioned}) must come after the bare /data/ rule (index ${bare}): ` +
      "Vercel applies every matching rule and the later one wins for the same header key"
  );
});
