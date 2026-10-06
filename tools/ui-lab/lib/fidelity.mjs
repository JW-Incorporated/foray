/* Pure logic for fidelity.mjs (prototype-vs-implementation). No browser, no
 * network: screens.json in, boxes in, deltas and reports out, so it is unit-tested
 * with synthetic data (fidelity.test.mjs). The CLI is ../fidelity.mjs.
 *
 * WHAT IS COMPARED. A prototype and the app render different DATA (different
 * episodes, different artwork), so a pixel diff alone is dominated by content.
 * The structural half compares REGIONS instead: each region is a CSS selector on
 * each side (screens.json), measured as a bounding box in CSS px at the same
 * viewport. The delta is position and size: dx, dy, dw, dh (app minus prototype).
 * A region found on only one side is reported as such, never silently dropped.
 *
 * Fidelity is judged, not thresholded: nothing here decides pass/fail unless the
 * caller passes --max-region-delta (see failingRegions).
 */
import { PNG } from "pngjs";

const r1 = (n) => Math.round(n * 10) / 10;
const isBox = (b) => b && [b.x, b.y, b.w, b.h].every(Number.isFinite);

/** A region is "first" (the first visible match) or "all" (union of the matches plus their count). */
export const MODES = ["first", "all"];

/** Reduce the visible matches of one selector to a measurement. boxes: [{x,y,w,h}] in document order. */
export function summarizeMeasure(boxes, mode = "first") {
  const list = (boxes || []).filter(isBox).filter((b) => b.w > 0 && b.h > 0);
  if (!list.length) return { count: 0, box: null, item: null };
  const first = { x: r1(list[0].x), y: r1(list[0].y), w: r1(list[0].w), h: r1(list[0].h) };
  if (mode !== "all") return { count: list.length, box: first, item: { w: first.w, h: first.h } };
  const x0 = Math.min(...list.map((b) => b.x));
  const y0 = Math.min(...list.map((b) => b.y));
  const x1 = Math.max(...list.map((b) => b.x + b.w));
  const y1 = Math.max(...list.map((b) => b.y + b.h));
  return { count: list.length, box: { x: r1(x0), y: r1(y0), w: r1(x1 - x0), h: r1(y1 - y0) }, item: { w: first.w, h: first.h } };
}

/** Delta of two boxes, app minus prototype, in px. max is the largest absolute component. */
export function boxDelta(proto, app) {
  const d = { dx: r1(app.x - proto.x), dy: r1(app.y - proto.y), dw: r1(app.w - proto.w), dh: r1(app.h - proto.h) };
  d.max = Math.max(Math.abs(d.dx), Math.abs(d.dy), Math.abs(d.dw), Math.abs(d.dh));
  return d;
}

/** Compare one region's two measurements. status: both | prototype-only | app-only | neither. */
export function compareRegion(name, proto, app, mode = "first") {
  const p = proto && proto.box ? proto : null;
  const a = app && app.box ? app : null;
  const base = { name, mode, proto: proto || { count: 0, box: null, item: null }, app: app || { count: 0, box: null, item: null } };
  if (!p && !a) return { ...base, status: "neither" };
  if (p && !a) return { ...base, status: "prototype-only" };
  if (!p && a) return { ...base, status: "app-only" };
  const out = { ...base, status: "both", delta: boxDelta(p.box, a.box) };
  if (mode === "all") {
    out.countDelta = a.count - p.count;
    out.itemDelta = { dw: r1(a.item.w - p.item.w), dh: r1(a.item.h - p.item.h) };
    out.delta.max = Math.max(out.delta.max, Math.abs(out.itemDelta.dw), Math.abs(out.itemDelta.dh));
  }
  return out;
}

/** Roll a screen's regions up: how many compared, how many missing, mean and worst delta. */
export function summarizeRegions(regions) {
  const both = regions.filter((r) => r.status === "both");
  const maxes = both.map((r) => r.delta.max);
  const worst = both.length ? both.reduce((w, r) => (r.delta.max > w.delta.max ? r : w)) : null;
  return {
    regions: regions.length,
    compared: both.length,
    prototypeOnly: regions.filter((r) => r.status === "prototype-only").length,
    appOnly: regions.filter((r) => r.status === "app-only").length,
    neither: regions.filter((r) => r.status === "neither").length,
    meanDelta: maxes.length ? r1(maxes.reduce((s, v) => s + v, 0) / maxes.length) : null,
    maxDelta: maxes.length ? Math.max(...maxes) : null,
    worst: worst ? worst.name : null,
  };
}

/** Regions that matched nothing on either side although both sides name a selector: a typo, not an empty state. */
export function brokenRegions(screens) {
  const out = [];
  for (const s of screens) for (const r of s.regions || []) if (r.broken) out.push({ screen: s.id, viewport: s.viewport, region: r.name, reason: "matched nothing on either side (check the selectors)" });
  return out;
}

/** The optional gate. A region fails when its worst component exceeds the limit, it exists on only one side, or it matched nothing on either side (broken selector). */
export function failingRegions(screens, maxRegionDelta) {
  if (maxRegionDelta == null) return [];
  const fails = [];
  for (const s of screens) {
    for (const r of s.regions || []) {
      if (r.broken) fails.push({ screen: s.id, viewport: s.viewport, region: r.name, reason: "matched nothing on either side" });
      else if (r.status === "both" && r.delta.max > maxRegionDelta) fails.push({ screen: s.id, viewport: s.viewport, region: r.name, reason: `delta ${r.delta.max}px > ${maxRegionDelta}px` });
      else if (r.status === "prototype-only" || r.status === "app-only") fails.push({ screen: s.id, viewport: s.viewport, region: r.name, reason: r.status });
    }
  }
  return fails;
}

/* ---------- screens.json ---------- */

/** Validate and normalise a screens.json. Throws with a message naming the screen. */
export function parseScreens(json, label = "screens.json") {
  const fail = (m) => { throw new Error(`${label}: ${m}`); };
  if (!json || typeof json !== "object" || !json.screens || typeof json.screens !== "object") fail('missing "screens" object');
  const screens = [];
  const routes = new Map();
  for (const [id, s] of Object.entries(json.screens)) {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) fail(`screen id "${id}" must match [A-Za-z0-9._-]+`);
    const route = s && s.prototype && s.prototype.route;
    if (typeof route !== "string" || !/^(#|\?)/.test(route)) fail(`screen "${id}": prototype.route must be a string starting with # or ?`);
    if (routes.has(route)) fail(`screen "${id}" reuses the route of "${routes.get(route)}" (one screen per route)`);
    routes.set(route, id);
    let app = null;
    if (s.app != null) {
      if (typeof s.app.state !== "string" || typeof s.app.step !== "string") fail(`screen "${id}": app must be null or { state, step }`);
      app = { state: s.app.state, step: s.app.step };
    }
    const regions = [];
    for (const [name, r] of Object.entries(s.regions || {})) {
      if (!r || typeof r.prototype !== "string" || !r.prototype) fail(`screen "${id}" region "${name}": prototype selector required`);
      if (r.app != null && (typeof r.app !== "string" || !r.app)) fail(`screen "${id}" region "${name}": app selector must be a string or null`);
      const mode = r.mode || "first";
      if (!MODES.includes(mode)) fail(`screen "${id}" region "${name}": mode must be one of ${MODES.join("|")}`);
      regions.push({ name, prototype: r.prototype, app: r.app || null, mode });
    }
    screens.push({ id, title: s.title || id, route, app, regions, note: s.note || "" });
  }
  if (!screens.length) fail("no screens");
  return { direction: json.direction || null, screens };
}

/** Which screens to run, and what to shoot on each side. only: array of ids or null. */
export function planRun(parsed, only = null) {
  const wanted = only && only.length ? only : null;
  if (wanted) {
    const known = new Set(parsed.screens.map((s) => s.id));
    const bad = wanted.filter((w) => !known.has(w));
    if (bad.length) throw new Error(`unknown --screens: ${bad.join(", ")}; known: ${[...known].join(", ")}`);
  }
  const screens = parsed.screens.filter((s) => !wanted || wanted.includes(s.id));
  const protoRoutes = screens.map((s) => s.route);
  const appScreens = screens.filter((s) => s.app);
  const appStates = [...new Set(appScreens.map((s) => s.app.state))];
  const appKey = (state, step) => `${state}/${step}`;
  /* several screens may share one app step (e.g. Now Playing paused/episode): key -> [ids] */
  const appByKey = new Map();
  for (const s of appScreens) {
    const k = appKey(s.app.state, s.app.step);
    appByKey.set(k, [...(appByKey.get(k) || []), s.id]);
  }
  const noApp = screens.filter((s) => !s.app).map((s) => s.id);
  return { screens, protoRoutes, appStates, appByKey, appKey, noApp };
}

/** Selector map for one side of a screen: { regionName: selector }. Regions without a selector on that side are omitted. */
export function selectorsFor(screen, side) {
  const m = {};
  for (const r of screen.regions) if (r[side]) m[r.name] = r[side];
  return m;
}

/** Compare a screen's two measurement sets ({name: {count, box, item}}) in the screen's region order. */
export function compareScreen(screen, protoMeasures, appMeasures, bothSides = (r) => r.app != null) {
  return screen.regions.map((r) => {
    const c = compareRegion(r.name, protoMeasures && protoMeasures[r.name], appMeasures && appMeasures[r.name], r.mode);
    if (c.status === "neither" && bothSides(r)) c.broken = true;
    return c;
  });
}

/** Every app.state/app.step in screens.json must exist in lib/states.mjs. known: { state: [step labels] }. Returns problem strings. */
export function validateAppRefs(parsed, known) {
  const problems = [];
  for (const s of parsed.screens) {
    if (!s.app) continue;
    const steps = known[s.app.state];
    if (!steps) problems.push(`screen "${s.id}": unknown app state "${s.app.state}" (known: ${Object.keys(known).join(", ")})`);
    else if (!steps.includes(s.app.step)) problems.push(`screen "${s.id}": state "${s.app.state}" has no step "${s.app.step}" (known: ${steps.join(", ")})`);
  }
  return problems;
}

/** Skips that are a fault (a shot that should exist is missing), as opposed to "no app equivalent yet". */
export function failingSkips(skipped, maxRegionDelta) {
  if (maxRegionDelta == null) return [];
  return skipped.filter((k) => k.fault).map((k) => ({ screen: k.id, viewport: k.viewport || null, region: "-", reason: `skipped: ${k.reason}` }));
}

/* ---------- images ---------- */

/** Two same-height PNGs side by side with a gap of `gap` px of mid-grey. Different heights are padded at the bottom. */
export function sideBySide(bufA, bufB, gap = 16) {
  const a = PNG.sync.read(bufA);
  const b = PNG.sync.read(bufB);
  const h = Math.max(a.height, b.height);
  const out = new PNG({ width: a.width + gap + b.width, height: h });
  for (let i = 0; i < out.data.length; i += 4) { out.data[i] = 90; out.data[i + 1] = 90; out.data[i + 2] = 90; out.data[i + 3] = 255; }
  const blit = (src, x0) => {
    for (let y = 0; y < src.height; y++) {
      const from = y * src.width * 4;
      src.data.copy(out.data, (y * out.width + x0) * 4, from, from + src.width * 4);
    }
  };
  blit(a, 0);
  blit(b, a.width + gap);
  return PNG.sync.write(out);
}

/* ---------- reports ---------- */

const fmtBox = (b) => (b ? `${b.x},${b.y} ${b.w}x${b.h}` : "-");
const fmtDelta = (d) => (d ? `${d.dx >= 0 ? "+" : ""}${d.dx}, ${d.dy >= 0 ? "+" : ""}${d.dy}, w ${d.dw >= 0 ? "+" : ""}${d.dw}, h ${d.dh >= 0 ? "+" : ""}${d.dh}` : "-");

export function buildReport({ direction, run, against, viewports, screens, skipped, maxRegionDelta, errors }) {
  const fails = [...failingRegions(screens, maxRegionDelta), ...failingSkips(skipped, maxRegionDelta)];
  const broken = brokenRegions(screens);
  const pcts = screens.map((s) => s.pixel && s.pixel.pct).filter((v) => typeof v === "number");
  return {
    direction, run, against, viewports,
    summary: {
      screens: screens.length,
      skipped: skipped.length,
      meanPixelPct: pcts.length ? Number((pcts.reduce((s, v) => s + v, 0) / pcts.length).toFixed(2)) : null,
      gated: maxRegionDelta != null,
      maxRegionDelta: maxRegionDelta ?? null,
      failingRegions: fails.length,
      brokenRegions: broken.length,
    },
    screens, skipped, failures: fails, broken, errors: errors || [],
  };
}

export function renderMarkdown(report) {
  const s = report.summary;
  const L = [
    `# Fidelity: ${report.direction} (${report.against})`, "",
    `Run \`${report.run}\`, viewports ${report.viewports.join(", ")}. ${s.screens} screens compared, ${s.skipped} skipped. ` +
      (s.meanPixelPct == null ? "" : `Mean pixel diff ${s.meanPixelPct}%. `) +
      (s.gated ? `Gate: region delta <= ${s.maxRegionDelta}px, ${s.failingRegions} failing.` : "No gate (fidelity is judged, not thresholded)."),
    "", "Pixel diff is dominated by content (different data and artwork); read the region deltas for layout. Deltas are app minus prototype, CSS px.", "",
    "| screen | viewport | pixel diff % | regions compared | missing (proto-only / app-only) | worst region | worst px |", "|---|---|---|---|---|---|---|",
  ];
  for (const x of report.screens) {
    const sm = x.summary;
    L.push(`| ${x.id} | ${x.viewport} | ${x.pixel ? x.pixel.pct : "-"} | ${sm.compared}/${sm.regions} | ${sm.prototypeOnly} / ${sm.appOnly} | ${sm.worst || "-"} | ${sm.maxDelta ?? "-"} |`);
  }
  for (const x of report.screens) {
    L.push("", `## ${x.id} @ ${x.viewport}`, "", `${x.title}. Prototype \`${x.prototypeRoute}\`; app \`${x.appRef || "none"}\`.`, "",
      "| region | status | prototype box | app box | delta (dx, dy, dw, dh) | count p/a |", "|---|---|---|---|---|---|");
    for (const r of x.regions) {
      L.push(`| ${r.name} | ${r.status} | ${fmtBox(r.proto.box)} | ${fmtBox(r.app.box)} | ${r.delta ? fmtDelta(r.delta) : "-"} | ${r.proto.count}/${r.app.count} |`);
    }
  }
  if (report.broken && report.broken.length) {
    L.push("", "## Broken regions (matched nothing on either side)", "");
    for (const f of report.broken) L.push(`- ${f.screen} @ ${f.viewport}, region ${f.region}`);
  }
  if (report.skipped.length) {
    L.push("", "## Skipped", "");
    for (const k of report.skipped) L.push(`- ${k.id}: ${k.reason}${k.fault ? " (FAULT)" : ""}`);
  }
  if (report.failures.length) {
    L.push("", "## Gate failures", "");
    for (const f of report.failures) L.push(`- ${f.screen} @ ${f.viewport || "-"}, region ${f.region}: ${f.reason}`);
  }
  if (report.errors.length) {
    L.push("", "## Harness errors", "");
    for (const e of report.errors.slice(0, 20)) L.push(`- ${e.kind || "error"} ${e.state || ""} ${e.message}`);
  }
  return L.join("\n") + "\n";
}
