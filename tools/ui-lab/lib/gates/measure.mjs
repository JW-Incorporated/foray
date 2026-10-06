/* Browser-side measurement for gates.mjs. Everything here runs in the page (or
 * drives it through Playwright) and returns plain data for rules.mjs to judge.
 * No rule decisions live in this file except what counts as "visible" and
 * "interactive". */
import { SHEET_OPENERS } from "./config.mjs";

/** Init script: record CSP violations and (under reduced motion) any motion
 *  that actually runs. Reports through the exposed bindings, so records
 *  survive a navigation. */
export const INIT_SCRIPT = `(() => {
  const sel = (el) => {
    if (!el || !el.tagName) return "?";
    const parts = [];
    for (let n = el, i = 0; n && n.nodeType === 1 && i < 3; n = n.parentElement, i++) {
      let s = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(s + "#" + n.id); break; }
      const c = [...n.classList].slice(0, 2).join(".");
      if (c) s += "." + c;
      parts.unshift(s);
    }
    return parts.join(" > ");
  };
  document.addEventListener("securitypolicyviolation", (e) => {
    try { window.__gatesCsp({ directive: e.violatedDirective, blocked: e.blockedURI || e.sample || "inline", source: (e.sourceFile || "") + (e.lineNumber ? ":" + e.lineNumber : "") }); } catch (_) {}
  });
  const motion = (kind, name, el, duration, pseudo) => { try { window.__gatesMotion({ kind, name, selector: sel(el) + (pseudo || ""), duration }); } catch (_) {} };
  const dur = (a) => { try { const d = a.effect.getComputedTiming().duration; return typeof d === "number" ? d : 0; } catch (_) { return 0; } };
  /* document.getAnimations() includes animations on ::before/::after; el.getAnimations() does not.
     The event's target is the originating element, its pseudoElement says which pseudo. */
  const find = (e, pred) => document.getAnimations().find((a) => a.effect && a.effect.target === e.target && (a.effect.pseudoElement || "") === (e.pseudoElement || "") && pred(a));
  document.addEventListener("animationstart", (e) => {
    const a = find(e, (x) => x.animationName === e.animationName);
    motion("animation", e.animationName, e.target, a ? dur(a) : 0, e.pseudoElement);
  }, true);
  document.addEventListener("transitionrun", (e) => {
    const a = find(e, (x) => x.transitionProperty === e.propertyName);
    motion("transition", e.propertyName, e.target, a ? dur(a) : 0, e.pseudoElement);
  }, true);
  const wa = Element.prototype.animate;
  Element.prototype.animate = function (kf, opts) {
    const d = typeof opts === "number" ? opts : (opts && opts.duration) || 0;
    motion("waapi", "animate()", this, typeof d === "number" ? d : 0);
    return wa.call(this, kf, opts);
  };
})();`;

/** Visible interactive elements, each hit-tested where a thumb would land. Runs in the page.
 *  `hits` is a 5x5 grid over the min x min square centred on the element (clipped to the viewport;
 *  clipped-out samples are dropped). A sample hits when elementFromPoint returns the element, a
 *  descendant (pseudo-elements hit-test as their element) or its label; a sibling is a miss.
 *  `centerHit` is whether the centre sample hits (false = covered by something else). */
export function collectTapTargets(min) {
  const SEL = 'a[href], a:not([href])[tabindex], button, [role="button"], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex^="-"]), summary';
  const sel = (el) => {
    const parts = [];
    for (let n = el, i = 0; n && n.nodeType === 1 && i < 3; n = n.parentElement, i++) {
      let s = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(s + "#" + n.id); break; }
      const c = [...n.classList].slice(0, 2).join(".");
      if (c) s += "." + c;
      parts.unshift(s);
    }
    return parts.join(" > ");
  };
  const sx = window.scrollX, sy = window.scrollY;
  const half = min / 2 - 1, offs = [-half, -half / 2, 0, half / 2, half];
  const out = [];
  for (const el of document.querySelectorAll(SEL)) {
    if (el.disabled || el.closest("[inert]") || el.closest("[hidden]")) continue;
    if (!el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })) continue;
    let r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const ih = window.innerHeight, iw = window.innerWidth;
    /* Always centre it: a control half under the fixed tab bar or mini player is tappable once scrolled, and a fixed one does not move. */
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hits = [];
    let centerHit = null;
    for (const dy of offs) for (const dx of offs) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= iw || y >= ih) continue;
      const t = document.elementFromPoint(x, y);
      const ok = Boolean(t && (el === t || el.contains(t) || (el.labels && [...el.labels].some((l) => l.contains(t)))));
      hits.push(ok);
      if (dx === 0 && dy === 0) centerHit = ok;
    }
    const cs = getComputedStyle(el);
    let inlineInText = false;
    if (el.tagName === "A" && cs.display === "inline" && el.parentElement) {
      inlineInText = el.parentElement.textContent.trim().length > el.textContent.length + 1;
    }
    out.push({ selector: sel(el), tag: el.tagName.toLowerCase(), text: (el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || "").trim().replace(/\s+/g, " ").slice(0, 60), w: r.width, h: r.height, inlineInText, hits, centerHit });
  }
  window.scrollTo(sx, sy);
  return out;
}

/** Geometry, not scrollWidth: styles.css clips html/body with `overflow-x: clip`, which pins
 *  scrollWidth to clientWidth and hides every overflow. Reports the OUTERMOST visible element
 *  whose box leaves the viewport, ignoring (a) descendants of a horizontally scrollable
 *  container (carousels) and (b) elements clipped by an ancestor that is itself inside the
 *  viewport. html/body are never treated as that clipping ancestor: they are the backstop. */
export function measureOverflow() {
  const iw = window.innerWidth;
  const de = document.documentElement;
  const sel = (el) => {
    const parts = [];
    for (let n = el, i = 0; n && n.nodeType === 1 && i < 3; n = n.parentElement, i++) {
      let s = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(s + "#" + n.id); break; }
      const c = [...n.classList].slice(0, 2).join(".");
      if (c) s += "." + c;
      parts.unshift(s);
    }
    return parts.join(" > ");
  };
  const out = new Set();
  const offenders = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (!el.checkVisibility({ visibilityProperty: true })) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (!(r.right > iw + 1 || r.left < -1)) continue;
    let skip = false;
    for (let a = el.parentElement; a && a !== document.body && a !== de; a = a.parentElement) {
      if (out.has(a)) { skip = true; break; } // a descendant of an offender: report the outermost only
      const ox = getComputedStyle(a).overflowX;
      if (ox === "auto" || ox === "scroll") { skip = true; break; } // carousel: scrolls on purpose
      if (ox === "hidden" || ox === "clip") {
        const ar = a.getBoundingClientRect();
        if (ar.left >= -1 && ar.right <= iw + 1) { skip = true; break; } // clipped inside the viewport
      }
    }
    if (skip) continue;
    out.add(el);
    offenders.push({ selector: sel(el), left: Math.round(r.left), right: Math.round(r.right) });
  }
  return { innerWidth: iw, scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, offenders: offenders.slice(0, 12) };
}

/** The topmost visible [role=dialog], described; null when none is open. */
async function openDialog(page) {
  return page.evaluate((openers) => {
    const dialogs = [...document.querySelectorAll('[role="dialog"], dialog[open]')].filter((d) => d.checkVisibility({ visibilityProperty: true }) && !d.hidden && d.getBoundingClientRect().width > 0);
    const d = dialogs[dialogs.length - 1];
    if (!d) return null;
    const hit = openers.find((o) => d.matches(o.dialog) || d.closest(o.dialog));
    return { selector: hit ? hit.dialog : (d.id ? "#" + d.id : "[role=dialog]"), known: Boolean(hit) };
  }, SHEET_OPENERS);
}

const IN_DIALOG = (dialogSel) => (sel) => {
  const d = document.querySelector(sel.d);
  const a = document.activeElement;
  const desc = a && a !== document.body ? a.tagName.toLowerCase() + (a.id ? "#" + a.id : "") + ([...a.classList][0] ? "." + [...a.classList][0] : "") : "body";
  return { inside: Boolean(d && a && d.contains(a)), at: desc };
};

/** Run the focus script against an open dialog. Closes the dialog (Escape,
 *  then its close control). Returns a trace for evaluateSheetFocus, or null. */
export async function traceSheet(page) {
  const open = await openDialog(page);
  if (!open) return null;
  const cfg = SHEET_OPENERS.find((o) => o.dialog === open.selector) || { dialog: open.selector, opener: null, close: null };
  const probe = () => page.evaluate(IN_DIALOG(cfg.dialog), { d: cfg.dialog });
  const first = await probe();
  const tabs = [];
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(40);
    tabs.push(await probe());
  }
  const isOpen = () => page.evaluate((s) => { const d = document.querySelector(s); return Boolean(d && !d.hidden && d.checkVisibility({ visibilityProperty: true }) && d.getBoundingClientRect().width > 0); }, cfg.dialog);
  let closedBy = null;
  await page.keyboard.press("Escape");
  await page.waitForTimeout(700);
  if (!(await isOpen())) closedBy = "escape";
  else if (cfg.close) {
    const c = page.locator(cfg.close).first();
    if (await c.count()) { await c.click({ timeout: 1500 }).catch(() => c.evaluate((el) => el.click())); /* a stuck actionability wait must not read as "cannot close" */ await page.waitForTimeout(700); if (!(await isOpen())) closedBy = "control"; }
  }
  let returnedToOpener = false, activeAfter = "body";
  if (closedBy && cfg.opener) {
    const r = await page.evaluate((o) => {
      const op = document.querySelector(o); const a = document.activeElement;
      return { ok: Boolean(op && a && (a === op || op.contains(a))), at: a && a !== document.body ? a.tagName.toLowerCase() + (a.id ? "#" + a.id : "") + ([...a.classList][0] ? "." + [...a.classList][0] : "") : "body" };
    }, cfg.opener);
    returnedToOpener = r.ok; activeAfter = r.at;
  }
  return { dialog: open.selector, focusedIn: first.inside, tabs, closed: Boolean(closedBy), closedBy, returnChecked: Boolean(closedBy && cfg.opener), returnedToOpener, activeAfter };
}
