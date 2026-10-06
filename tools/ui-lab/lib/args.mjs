/* Tiny CLI parser: `--key value`, `--key=value`, bare `--flag` (true). */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const eq = a.indexOf("=");
    if (eq > 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

/** "393x852,375x667" -> [{w:393,h:852,name:"393x852"}, ...] */
export function parseViewports(spec, fallback) {
  const raw = (typeof spec === "string" && spec.trim() ? spec : fallback).split(",");
  return raw.map((s) => {
    const m = /^(\d+)x(\d+)$/.exec(s.trim());
    if (!m) throw new Error(`bad viewport "${s}" (want WxH, e.g. 393x852)`);
    return { w: Number(m[1]), h: Number(m[2]), name: `${m[1]}x${m[2]}` };
  });
}

export const slug = (s) =>
  String(s).replace(/^#\/?/, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "home";
