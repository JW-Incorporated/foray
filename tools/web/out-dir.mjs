/* Where `prepare-dist.mjs` may build (round-3 audit, ci-release-15).
 *
 * prepare-dist starts by deleting its output directory, recursively. `--out`
 * used to be taken as given, so `--out .` or `--out ..` deleted the checkout
 * (uncommitted work included), and a bare `--out` crashed with a TypeError.
 * Agents run this script for local site builds, so the destructive default
 * needs a guard, not a convention.
 *
 * Refused: a missing or empty value, the repo root or any ancestor of it, and
 * any directory holding a `.git` (another checkout or worktree). Everything
 * else (the default `dist`, CI's `$RUNNER_TEMP/dist`) is fine.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export const USAGE = "usage: node tools/web/prepare-dist.mjs [--out <dir>]   (default: dist)";

/**
 * -> { out } (an absolute path that is safe to delete and rebuild), or
 *    { error } (why not; the caller prints it with USAGE and exits 2).
 */
export function resolveOutDir(argv, root) {
  const at = argv.indexOf("--out");
  const arg = at >= 0 ? argv[at + 1] : "dist";
  if (typeof arg !== "string" || arg.trim() === "" || arg.startsWith("--")) {
    return { error: "--out needs a directory" };
  }
  const out = resolve(isAbsolute(arg) ? arg : join(root, arg));
  const rootAbs = resolve(root);
  const up = relative(out, rootAbs);
  /* `relative(out, root)` is "" when they are the same directory, and does not
     climb ("..") when `out` contains `root`: both mean deleting `out` deletes
     the checkout. On Windows a different drive gives an absolute path, which
     is not an ancestor. */
  if (up === "" || (!up.startsWith("..") && !isAbsolute(up))) {
    return { error: `--out ${arg} is the repository root or one of its ancestors; refusing to delete it` };
  }
  if (existsSync(join(out, ".git"))) {
    return { error: `--out ${arg} holds a .git (a checkout); refusing to delete it` };
  }
  return { out };
}
