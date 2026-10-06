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
  const motion = (kind, name, el, duration) => { try { window.__gatesMotion({ kind, name, selector: sel(el), duration }); } catch (_) {} };
  const dur = (a) => { try { const d = a.effect.getComputedTiming().duration; return typeof d === "number" ? d : 0; } catch (_) { return 0; } };
  document.addEventListener("animationstart", (e) => {
    const a = e.target.getAnimations().find((x) => x.animationName === e.animationName);
    motion("animation", e.animationName, e.target, a ? dur(a) : 0);
  }, true);
  document.addEventListener("transitionrun", (e) => {
    const a = e.target.getAnimations().find((x) => x.transitionProperty === e.propertyName);
    motion("transition", e.propertyName, e.target, a ? dur(a) : 0);
  }, true);
  const wa = Element.prototype.animate;
  Element.prototype.animate = function (kf, opts) {
    const d = typeof opts === "number" ? opts : (opts && opts.duration) || 0;
    motion("waapi", "animate()", this, typeof d === "number" ? d : 0);
    return wa.call(this, kf, opts);
  };
})();`;

/** Visible interactive elements with their hit boxes. Runs in the page. */
export function collectTapTargets() {
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
  const out = [];
  for (const el of document.querySelectorAll(SEL)) {
    if (el.disabled || el.closest("[inert]") || el.closest("[hidden]")) continue;
    if (!el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })) continue;
    let r = el.getBoundingClientRect();
    /* A checkbox/radio hidden behind its label is hit through the label. */
    if (el.labels && el.labels.length && (r.width < 2 || r.height < 2 || getComputedStyle(el).opacity === "0")) {
      const lr = [...el.labels].map((l) => l.getBoundingClientRect()).sort((a, b) => b.width * b.height - a.width * a.height)[0];
      if (lr) r = lr;
    }
    if (r.width === 0 && r.height === 0) continue;
    const cs = getComputedStyle(el);
    let inlineInText = false;
    if (el.tagName === "A" && cs.display === "inline" && el.parentElement) {
      const own = el.textContent.length;
      inlineInText = el.parentElement.textContent.trim().length > own + 1;
    }
    out.push({ selector: sel(el), tag: el.tagName.toLowerCase(), text: (el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || "").trim().replace(/\s+/g, " ").slice(0, 60), w: r.width, h: r.height, inlineInText });
  }
  return out;
}

export function measureOverflow() {
  const de = document.documentElement;
  const offenders = [];
  if (de.scrollWidth > de.clientWidth) {
    const sel = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + ([...el.classList][0] ? "." + [...el.classList][0] : "");
    for (const el of document.body.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > de.clientWidth + 0.5) offenders.push([r.right, sel(el)]);
    }
    offenders.sort((a, b) => b[0] - a[0]);
  }
  return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, offenders: offenders.slice(0, 3).map((o) => `${o[1]} (right ${Math.round(o[0])})`) };
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
