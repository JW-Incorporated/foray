import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Round-3 audit gen-11: postSeedSpine.ts carried a raw NUL byte inside a
 * template literal (instead of the `\u0000` escape). The runtime string was
 * the same, but git classified the file as binary: PRs showed no diff for
 * the module that decides every beat's tape seed, and `git grep` saw only
 * "Binary file matches". Any C0 control byte other than tab, LF and CR in a
 * source file does the same, so none is allowed under backend/src.
 */
function* sourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (/\.(ts|js|mjs|cjs)$/.test(entry.name)) yield full;
  }
}

describe("backend source files are text (gen-11)", () => {
  it("no backend/src file holds a raw control byte other than tab, LF or CR", () => {
    const root = path.join(__dirname, "..", "src");
    const offenders: string[] = [];
    for (const file of sourceFiles(root)) {
      const bytes = fs.readFileSync(file);
      const i = bytes.findIndex((b) => b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d);
      if (i >= 0) {
        const line = bytes.subarray(0, i).toString("utf8").split("\n").length;
        offenders.push(`${path.relative(root, file)}:${line} (byte 0x${bytes[i]!.toString(16).padStart(2, "0")})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
