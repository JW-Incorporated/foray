/* rebuild-index.mjs (PKG-14, docs/roadmap/corpus.md §3 "PKG-14 ·
   rebuild-index.mjs launcher"): the warm arguments built from a sync state,
   and the warmer launcher the sync-then-warm run spawns.

   No network and no real spawn: warmArgsFor is pure, and the launcher is
   only checked to exist on disk. The floor for this suite lives in
   test/suite-integrity.test.js. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { ROOT } from "./config.mjs";
import { WARM_LAUNCHER, warmArgsFor } from "./rebuild-index.mjs";

/* A sync state's `shows` block as sync-r2.mjs writes it: keyed by
   localDirFor(show_id) = safeKey(show_id) = '<slug>-<10 hex>', or by the R2
   name for an unmapped directory (no hash). Insertion order is deliberately
   not sorted. */
const STATE = {
  shows: {
    "zebra-talk-abcdef0123": { show_id: "zebra-talk", via: "catalog-feed", bodies: 2 },
    "being-an-engineer-0123456789": { show_id: "being-an-engineer", via: "queue-title", bodies: 3 },
    "being-an-engineer-fedcba9876": { show_id: "Being an Engineer", via: "identity", bodies: 1 },
    "nothing-synced-1111111111": { show_id: "nothing-synced", via: "queue-title", bodies: 0 },
    "unmapped-farm-dir": { show_id: null, via: "unmapped", bodies: 4 },
  },
};

test("one --show pair per synced show with bodies, hash-stripped, deduped and sorted; none when no show has bodies", () => {
  /* Mutations this kills: emitting one `--show` whose value is every id joined
     (["--show", "being-an-engineer,unmapped-farm-dir,zebra-talk"]); emitting the
     raw state key ("being-an-engineer-0123456789", which the warmer's
     showId filter never matches); dropping the dedupe (two being-an-engineer
     pairs); dropping the `bodies > 0` filter (nothing-synced appears); dropping
     the sort (zebra-talk first). */
  assert.deepEqual(warmArgsFor(STATE, { offline: false }), [
    "--show",
    "being-an-engineer",
    "--show",
    "unmapped-farm-dir",
    "--show",
    "zebra-talk",
  ]);
  /* Mutation: dropping the `bodies > 0` filter makes this one --show pair,
     and main() would spawn a warm of one empty show instead of skipping. */
  assert.deepEqual(warmArgsFor({ shows: { "nothing-synced-1111111111": { bodies: 0 } } }, { offline: false }), []);
});

test("--offline passes through to the warmer after the --show pairs", () => {
  /* Mutation this kills: dropping the `if (offline) args.push("--offline")`
     line (the warmer would then fetch RSS feeds during reconcile). */
  assert.deepEqual(warmArgsFor(STATE, { offline: true }), [
    "--show",
    "being-an-engineer",
    "--show",
    "unmapped-farm-dir",
    "--show",
    "zebra-talk",
    "--offline",
  ]);
});

test("the spawned warmer launcher is an absolute path that exists", () => {
  /* Mutation this kills: pointing WARM_LAUNCHER at a file that is not there
     (e.g. "warm-index.mjs") or at a relative path that only resolves from the
     repo root. */
  assert.ok(isAbsolute(WARM_LAUNCHER), WARM_LAUNCHER);
  assert.equal(WARM_LAUNCHER, join(ROOT, "tools", "generation", "warm-transcript-index.mjs"));
  assert.ok(existsSync(WARM_LAUNCHER), WARM_LAUNCHER);
});
