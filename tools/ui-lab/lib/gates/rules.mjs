/* Pure rule evaluation for gates.mjs: synthetic measurements in, violations
 * out. No browser, no DOM, so gates.test.mjs can run anywhere.
 *
 * A violation is { gate, screen, id, detail, count }. `screen` is
 * "<state>/<label>"; `id` is stable across runs (a selector or a normalised
 * message), because the known-debt list matches on gate + screen + id. */
import { MIN_TAP_PX, TAP_TOLERANCE_PX, TAP_EXEMPTIONS, MIN_MOTION_MS, MAX_REDUCED_CROSSFADE_MS, IGNORED_FAILED_REQUESTS, CONSOLE_COVERED_ELSEWHERE } from "./config.mjs";

export const GATES = ["errors", "requests", "csp", "tap-targets", "reduced-motion", "overflow", "sheet-focus", "contrast"];

const v = (gate, screen, id, detail, count = 1) => ({ gate, screen, id, detail, count });

/** Collapse volatile digits/hosts so the same error keys the same across runs. */
export const normalizeMessage = (m) => String(m).replace(/https?:\/\/[^/\s]+/g, "").replace(/\d{3,}/g, "N").replace(/\s+/g, " ").trim().slice(0, 160);

/** Group violations that share (gate, screen, id) into one with a count. */
export function dedupe(list) {
  const map = new Map();
  for (const x of list) {
    const k = `${x.gate}\u0000${x.screen}\u0000${x.id}`;
    const cur = map.get(k);
    if (cur) cur.count += x.count; else map.set(k, { ...x });
  }
  return [...map.values()];
}

/** errors: console errors and uncaught page errors, from the walker. */
export function evaluateErrors(errors) {
  const out = [];
  for (const e of errors) {
    if (e.kind === "walk-failure") continue; // reported separately; it is not a screen
    const screen = `${e.state}/${e.label}`;
    if (e.kind === "console" && CONSOLE_COVERED_ELSEWHERE.some((c) => c.pattern.test(e.message))) continue;
    out.push(v("errors", screen, `${e.kind}:${normalizeMessage(e.message)}`, e.message));
  }
  return dedupe(out);
}

/** requests: failed same-origin requests. `r` = { screen, url, status|null, failure|null, sameOrigin } */
export function evaluateRequests(reqs) {
  const out = [];
  for (const r of reqs) {
    if (!r.sameOrigin) continue;
    const failed = r.failure || (r.status != null && r.status >= 400);
    if (!failed) continue;
    let p = r.url; try { p = new URL(r.url).pathname; } catch (_) { /* keep raw */ }
    if (IGNORED_FAILED_REQUESTS.some((i) => i.pattern.test(p))) continue;
    out.push(v("requests", r.screen, `${r.failure ? "failed" : r.status} ${p}`, `${r.url} -> ${r.failure || r.status}`));
  }
  return dedupe(out);
}

/** csp: securitypolicyviolation events. `c` = { screen, directive, blocked, source } */
export function evaluateCsp(events) {
  return dedupe(events.map((c) => v("csp", c.screen, `${c.directive} ${String(c.blocked).slice(0, 80)}`, `${c.directive} blocked ${c.blocked}${c.source ? " at " + c.source : ""}`)));
}

/** tap-targets. `els` = [{selector,text,w,h,tag,inlineInText,hits:boolean[],centerHit}], visible interactive
 *  elements already hit-tested in the page (measure.mjs collectTapTargets).
 *  Pass = a tap lands on the element across the whole min x min square: every sample hits (an `::after`
 *  that extends the hit area counts, a neighbour overlapping it does not). An element whose own box is
 *  already min x min passes on size, but must not be covered at its centre. (A 44px round button's
 *  corner samples fall outside its radius; that is why size alone is accepted.) */
export function evaluateTapTargets(screen, els, { min = MIN_TAP_PX, tol = TAP_TOLERANCE_PX, exemptions = TAP_EXEMPTIONS } = {}) {
  const out = [];
  const q = (n) => Math.floor(n / 4) * 4; // size bucket: a regression changes the key
  for (const e of els) {
    if (exemptions.inlineTextLinks && e.tag === "a" && e.inlineInText) continue;
    if (exemptions.selectors.some((s) => s.id === e.selector)) continue;
    const boxOk = e.w + tol >= min && e.h + tol >= min;
    const hits = e.hits || [];
    const misses = hits.filter((h) => !h).length;
    const bucket = `${q(e.w)}x${q(e.h)}`;
    if (boxOk) {
      if (e.centerHit !== false) continue;
      out.push(v("tap-targets", screen, `${e.selector} ${bucket} covered`, `${Math.round(e.w)}x${Math.round(e.h)} but another element is on top at its centre "${(e.text || "").slice(0, 40)}"`));
      continue;
    }
    if (hits.length > 0 && misses === 0) continue; // the hit area reaches min x min (pseudo-element extension)
    out.push(v("tap-targets", screen, `${e.selector} ${bucket}`, `${Math.round(e.w * 10) / 10}x${Math.round(e.h * 10) / 10}, ${hits.length ? `${misses}/${hits.length} samples in the ${min}px square miss it` : "not measurable"} "${(e.text || "").slice(0, 40)}"`));
  }
  return dedupe(out);
}

/** reduced-motion. `recs` = [{kind,name,selector,duration}] recorded under reducedMotion: reduce. */
export function evaluateReducedMotion(screen, recs, { minMs = MIN_MOTION_MS } = {}) {
  const out = [];
  for (const r of recs) {
    if (!(r.duration > minMs)) continue;
    const crossfade = r.kind === "transition" && ["opacity", "color", "background-color"].includes(r.name);
    if (crossfade && r.duration <= MAX_REDUCED_CROSSFADE_MS) continue;
    out.push(v("reduced-motion", screen, `${r.kind}:${r.name || "?"}:${r.selector}`, `${r.kind} ${r.name || ""} ${Math.round(r.duration)}ms on ${r.selector}`));
  }
  return dedupe(out);
}

/** overflow. m = { viewport, innerWidth, scrollWidth, clientWidth, offenders:[{selector,left,right}] }.
 *  Geometry first: styles.css clips html/body (`overflow-x: clip`), which pins scrollWidth to clientWidth,
 *  so scrollWidth alone can never fire on the app. It stays as a backstop for pages without that clip. */
export function evaluateOverflow(screen, m) {
  const out = (m.offenders || []).map((o) => v("overflow", screen, `overflow@${m.viewport} ${o.selector}`, `${o.selector} spans ${o.left}..${o.right} in a ${m.innerWidth || m.clientWidth}px viewport at ${m.viewport}`));
  if (!out.length && m.scrollWidth > m.clientWidth) out.push(v("overflow", screen, `overflow@${m.viewport} scrollWidth`, `scrollWidth ${m.scrollWidth} > clientWidth ${m.clientWidth} at ${m.viewport}`));
  return out;
}

/** sheet-focus. t = { dialog, focusedIn, tabs:[{inside,at}], closed, closedBy, returnChecked, returnedToOpener, activeAfter } | null */
export function evaluateSheetFocus(screen, t) {
  if (!t) return [];
  const out = [];
  const id = (k) => `${k} ${t.dialog}`;
  if (!t.focusedIn) out.push(v("sheet-focus", screen, id("focus-not-moved-in"), `focus stayed outside ${t.dialog} after it opened`));
  const escaped = t.tabs.filter((x) => !x.inside);
  if (escaped.length) out.push(v("sheet-focus", screen, id("tab-escapes"), `${escaped.length}/${t.tabs.length} Tab presses left ${t.dialog}; first landed on ${escaped[0].at}`));
  if (!t.closed) out.push(v("sheet-focus", screen, id("cannot-close"), `neither Escape nor the close control closed ${t.dialog}`));
  else if (t.returnChecked && !t.returnedToOpener) out.push(v("sheet-focus", screen, id("focus-not-returned"), `after closing (${t.closedBy}) focus was on ${t.activeAfter}, not the opener`));
  return out;
}

/** contrast: axe color-contrast violation nodes. `nodes` = [{target,summary}] */
export function evaluateContrast(screen, nodes) {
  return dedupe(nodes.map((n) => v("contrast", screen, n.target, n.summary || "")));
}

/** Known-debt matching. allow = { allow:[{gate,screen,id}] }; screen "*" matches any. */
export function splitByAllow(violations, allow) {
  const entries = (allow && allow.allow) || [];
  const matches = (x, a) => a.gate === x.gate && a.id === x.id && (a.screen === "*" || a.screen === x.screen);
  const fresh = [], known = [];
  for (const x of violations) (entries.some((a) => matches(x, a)) ? known : fresh).push(x);
  const stale = entries.filter((a) => !violations.some((x) => matches(x, a)));
  return { fresh, known, stale };
}

export function toAllowList(violations, note) {
  const sorted = [...violations].sort((a, b) => a.gate.localeCompare(b.gate) || a.screen.localeCompare(b.screen) || a.id.localeCompare(b.id));
  return { version: 1, note, allow: sorted.map((x) => ({ gate: x.gate, screen: x.screen, id: x.id, detail: x.detail.slice(0, 140) })) };
}

export function countsByGate(violations) {
  const c = Object.fromEntries(GATES.map((g) => [g, 0]));
  for (const x of violations) c[x.gate] = (c[x.gate] || 0) + 1;
  return c;
}

export function renderMarkdown({ fresh, known, stale, screens, meta }) {
  let md = `# UI gates report\n\n${meta}\n\n${screens} screens. **${fresh.length} new violation(s)**, ${known.length} known debt, ${stale.length} stale allow entr${stale.length === 1 ? "y" : "ies"}.\n\n`;
  const all = [...fresh.map((x) => ({ ...x, s: "NEW" })), ...known.map((x) => ({ ...x, s: "known" }))];
  md += `| Gate | New | Known |\n|---|---|---|\n`;
  for (const g of GATES) md += `| ${g} | ${fresh.filter((x) => x.gate === g).length} | ${known.filter((x) => x.gate === g).length} |\n`;
  for (const g of GATES) {
    const rows = all.filter((x) => x.gate === g);
    if (!rows.length) continue;
    md += `\n## ${g}\n`;
    const byScreen = new Map();
    for (const r of rows) { if (!byScreen.has(r.screen)) byScreen.set(r.screen, []); byScreen.get(r.screen).push(r); }
    for (const [screen, rs] of byScreen) {
      md += `\n### ${screen}\n\n`;
      for (const r of rs) md += `- [${r.s}] \`${r.id.slice(0, 110)}\`${r.count > 1 ? ` x${r.count}` : ""} - ${r.detail.slice(0, 200)}\n`;
    }
  }
  if (stale.length) md += `\n## Stale allow entries (fixed? remove them)\n\n${stale.map((a) => `- ${a.gate} | ${a.screen} | \`${a.id}\``).join("\n")}\n`;
  return md;
}
