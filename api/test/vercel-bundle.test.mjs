// Regression test for the "data/catalog.json not bundled with deployed
// function" production bug (kanban t_7d1a82d2, follow-up to S-02/t_4bd3c0a3).
//
// WHY THIS EXISTS
// `api/shows/[show_id]/episodes.ts` and `api/shows/search.ts` both read
// `data/catalog.json` / `data/catalog-breadth.json` off disk at runtime via a
// repo-root-relative path (`findRepoRoot()` walk-up in episodes.ts;
// `REPO_ROOT`-relative `readJson()` in backend/src/catalog/breadthCatalog.ts,
// used by search.ts). Vercel's bundler does NOT include a file that's only
// reached via a dynamic `readFileSync`/`join()` call at runtime — it needs
// either a statically analyzable literal path, or an explicit
// `vercel.json` `functions.<glob>.includeFiles` entry. Every existing test
// exercises these handlers against the LOCAL filesystem (real repo checkout),
// which always has `data/catalog*.json` present regardless of what actually
// ships in the deployed bundle — that's exactly why this shipped broken
// without any test catching it (confirmed via direct curl against
// production: every real show_id 404'd as "unknown show_id").
//
// This suite can't spin up an actual Vercel build (no deploy access from a
// CI runner), so it asserts the next best thing: `vercel.json`'s `functions`
// config declares an `includeFiles` glob, that glob is anchored under the
// SAME `api/shows/**` functions that read the catalogue at runtime, and the
// glob pattern actually matches both catalogue files as they exist on disk
// today. If a future refactor renames a catalogue file, moves the function,
// or accidentally narrows/removes this glob, this test fails loudly instead
// of silently reintroducing the bundling gap.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");

const CATALOG_FILES = ["data/catalog.json", "data/catalog-breadth.json"];

/** Minimal brace+star glob matcher — just enough for the one pattern this
 * repo actually uses (`data/catalog*.json`, or a `{a,b}` alternation form).
 * Not a general-purpose glob library; if the pattern grows more exotic than
 * this, that's a signal to pull in a real glob dependency instead of
 * hand-rolling more of one here. */
function globToRegExp(glob) {
  // Expand a single top-level `{a,b,c}` alternation, if present.
  const braceMatch = glob.match(/^(.*)\{([^}]+)\}(.*)$/);
  if (braceMatch) {
    const [, prefix, alts, suffix] = braceMatch;
    const alternatives = alts.split(",").map((a) => `${prefix}${a}${suffix}`);
    return new RegExp(`^(?:${alternatives.map((a) => globToRegExp(a).source.slice(1, -1)).join("|")})$`);
  }
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

// Path-style glob matcher for vercel.json's `functions` KEYS specifically --
// these use `**` to mean "zero or more path segments" (per Vercel's own
// docs: a pattern like api/star-star/star.ts matches both api/hello.ts and
// api/hello/world.ts), which is different from globToRegExp()'s flat
// `*` -> `.*` substitution above (that flat form would wrongly require a
// literal `/` to exist even when `**` matches nothing -- caught in review:
// it silently failed to prove that the api/shows/** functions glob covers
// api/shows/search.ts, which has no extra path segment, and only passed
// because it was OR'd against episodes.ts instead of actually being
// asserted). A `**` immediately followed by a slash collapses to an
// optional non-capturing group here specifically so a zero-segment match
// doesn't leave a dangling required slash.
function functionKeyToRegExp(glob) {
  const escaped = glob
    .replace(/\*\*\//g, "@@DOUBLESTAR_SLASH@@")
    .replace(/\*\*/g, "@@DOUBLESTAR@@")
    .replace(/\*/g, "@@STAR@@")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/@@DOUBLESTAR_SLASH@@/g, "(?:.*/)?")
    .replace(/@@DOUBLESTAR@@/g, ".*")
    .replace(/@@STAR@@/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

function loadVercelConfig() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
}

test("vercel.json declares includeFiles for api/shows/** covering both catalogue files", () => {
  const config = loadVercelConfig();
  assert.ok(config.functions, "vercel.json has no `functions` config at all — " +
    "data/catalog*.json will not be bundled with any deployed function, and " +
    "every real show_id / search query 404s or degrades in production.");

  const TARGETS = ["api/shows/[show_id]/episodes.ts", "api/shows/search.ts"];
  const matchingKeys = Object.keys(config.functions).filter((key) => {
    const re = functionKeyToRegExp(key);
    return TARGETS.some((target) => re.test(target));
  });
  assert.ok(
    matchingKeys.length > 0,
    "no vercel.json `functions` key matches api/shows/[show_id]/episodes.ts " +
      "or api/shows/search.ts — both read data/catalog*.json at runtime and " +
      "need an includeFiles entry, or they 404/degrade in production."
  );

  // Every target file must be covered by AT LEAST ONE matching key's
  // includeFiles glob — not just "some key matched something". A key that
  // only covers episodes.ts (e.g. a future narrower glob) would otherwise
  // let search.ts silently lose its catalogue bundling.
  for (const target of TARGETS) {
    const coveringKeys = matchingKeys.filter((key) => functionKeyToRegExp(key).test(target));
    assert.ok(
      coveringKeys.length > 0,
      `no vercel.json functions key's glob actually matches "${target}" — ` +
        "it reads data/catalog*.json at runtime and needs includeFiles coverage."
    );
  }

  for (const key of matchingKeys) {
    const includeFiles = config.functions[key]?.includeFiles;
    assert.ok(
      typeof includeFiles === "string" && includeFiles.length > 0,
      `vercel.json's functions["${key}"] has no includeFiles glob — ` +
        "data/catalog*.json will not be bundled with this function."
    );

    const re = globToRegExp(includeFiles);
    for (const file of CATALOG_FILES) {
      assert.ok(
        re.test(file),
        `vercel.json's functions["${key}"].includeFiles ("${includeFiles}") ` +
          `does not match "${file}" — this file will be missing from the ` +
          "deployed function bundle, reproducing the exact production 404 " +
          "this test guards against."
      );
      assert.ok(
        fs.existsSync(path.join(ROOT, file)),
        `${file} does not exist in the repo — the includeFiles glob points ` +
          "at a file that isn't there."
      );
    }
  }
});

test("both catalogue files loadShowIndex()/breadthCatalog.ts read still exist at their expected paths", () => {
  for (const file of CATALOG_FILES) {
    assert.ok(
      fs.existsSync(path.join(ROOT, file)),
      `${file} is missing — episodes.ts's findRepoRoot()/loadShowIndex() and ` +
        "backend/src/catalog/breadthCatalog.ts's readJson() both expect it " +
        "at this repo-root-relative path."
    );
  }
});
