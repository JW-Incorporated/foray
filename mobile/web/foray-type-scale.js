/* Dynamic Type for the iOS shell (audit round 2, a11y-1; founder question 5).
 *
 * THE CLAIM THIS MAKES TRUE. docs/DECISIONS.md (2026-09-23 §1) removed zoom from
 * the app and answered the listener who pinched to read small text with "the
 * answer to that is type size, not zoom, and Dynamic Type already scales the
 * page". It did not. WKWebView applies iOS Text Size only to text set in the
 * `-apple-system-*` font keywords, and styles.css sets none: the whole scale is
 * rem on an unset 16px root, `-webkit-text-size-adjust: 100%` pins it, and no
 * native code read the setting. So a listener with Larger Text on saw every line
 * at the default size and had lost the pinch that used to help. This file is the
 * bridge the ruling assumed.
 *
 * HOW IT READS THE SETTING WITHOUT NATIVE CODE. One hidden probe element set in
 * `font: -apple-system-body` resolves, in WKWebView, to the body text size the
 * listener chose: 17px at the default ("Large"), 21px at xxxLarge, up to 53px in
 * the accessibility sizes -- and WebKit re-resolves it when the setting changes,
 * because the keyword IS Dynamic Type. The probe's computed `font-size` divided
 * by the default is the factor; the root's `font-size` is set to 16px times it,
 * and every rem in styles.css follows. `--type-scale` is set beside it so a rule
 * for fixed-px chrome can grow with `calc(44px * var(--type-scale, 1))`
 * (styles.css is another lane's; the token is the hook).
 *
 * THE CLAMP. Apple's accessibility sizes reach 3.1x, and a 44px top bar cannot
 * hold that; 2x is where every row still fits its controls at phone width. Below
 * the default the page keeps its own scale: the tab labels are already 10.5px at
 * 1x and shrinking them for a listener who chose "Small" would trade one
 * accessibility problem for another.
 *
 * WHEN IT RE-MEASURES. A `ResizeObserver` on the probe: a changed body size
 * changes the probe's box, and the observer fires with no native hook and no
 * polling. `visibilitychange` re-measures on the way back from Settings for a
 * WebKit that repaints before it re-lays out. `refresh()` is exposed for a device
 * pass.
 *
 * WHERE IT APPLIES. The iOS shell only (`capacitor.getPlatform() === "ios"`).
 * Android's WebView applies the system font scale itself (`textZoom`, untouched by
 * `mobile/capacitor.config.json`), and on macOS Safari `-apple-system-body`
 * resolves to 13px -- installing there would SHRINK the web. Same
 * `isNativePlatform` discipline as `foray-audio-shell.js`'s `shellApplies`.
 *
 * NO INLINE STYLE ATTRIBUTE, ever: the page's CSP has no `'unsafe-inline'` for
 * styles. Every write here goes through the CSSOM (`el.style.prop = …`), which the
 * policy does not govern.
 *
 * WHAT HAS BEEN OBSERVED: nothing. `tools/mobile/foray-type-scale.test.mjs` drives
 * this against a fake document; whether a real WKWebView resolves the keyword
 * inside a Capacitor shell is the device check named in docs/DECISIONS.md.
 */

/** The one font keyword WKWebView scales with iOS Text Size. */
export const PROBE_FONT = "-apple-system-body";

/** styles.css's root: nothing sets `html { font-size }`, so the browser's 16px. */
export const BASE_ROOT_PX = 16;

/** The body size at Apple's default category ("Large"). The factor is measured
 *  against this, not against the first reading, so a launch at xxxLarge scales
 *  from the first paint. */
export const DEFAULT_BODY_PX = 17;

export const MIN_SCALE = 1;
export const MAX_SCALE = 2;

/** The root's `--type-scale` custom property. */
export const SCALE_PROPERTY = "--type-scale";

/** Only the iOS shell. Pure, so the suite tables it. */
export function typeScaleApplies(capacitor) {
  try {
    if (!capacitor || typeof capacitor.getPlatform !== "function") return false;
    if (typeof capacitor.isNativePlatform === "function" && !capacitor.isNativePlatform()) return false;
    return capacitor.getPlatform() === "ios";
  } catch (e) {
    return false;
  }
}

/** The factor for a measured body size: `bodyPx / 17`, clamped to [1, 2]. A
 *  reading that is not a positive number is the default (1), never a guess. */
export function scaleFor(bodyPx) {
  const n = Number(bodyPx);
  if (!Number.isFinite(n) || n <= 0) return 1;
  const raw = n / DEFAULT_BODY_PX;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, raw));
}

/** `"19.76px"` for 1.235: two decimals, so a re-measure that lands on the same
 *  size writes the same string and nothing re-lays out. */
export function rootFontSize(scale) {
  return `${Math.round(BASE_ROOT_PX * scale * 100) / 100}px`;
}

/**
 * @param {object} env
 * @param {object} env.capacitor      `window.Capacitor`, or nothing
 * @param {Document} env.doc          the document to scale
 * @param {Function} env.getComputedStyle
 * @param {Function} [env.ResizeObserver]
 * @param {Function} [env.log]
 */
export function createTypeScale(env) {
  const capacitor = env.capacitor;
  const doc = env.doc;
  const computed = typeof env.getComputedStyle === "function" ? env.getComputedStyle : null;
  const Observer = typeof env.ResizeObserver === "function" ? env.ResizeObserver : null;
  const log = typeof env.log === "function" ? env.log : function () {};

  let installed = false;
  let probe = null;
  let observer = null;
  let visibilityHandler = null;
  let lastBodyPx = null;
  let lastScale = 1;

  function measure() {
    if (!probe || !computed) return null;
    try {
      const size = parseFloat(computed(probe).fontSize);
      return Number.isFinite(size) && size > 0 ? size : null;
    } catch (e) {
      log("foray-type-scale: could not read the probe", e);
      return null;
    }
  }

  /** Apply the factor for `bodyPx` to the root. Idempotent for the same size. */
  function apply(bodyPx) {
    const scale = scaleFor(bodyPx);
    lastBodyPx = bodyPx;
    lastScale = scale;
    const root = doc && doc.documentElement;
    if (!root || !root.style) return scale;
    try {
      if (scale === 1) {
        root.style.fontSize = "";
        if (typeof root.style.removeProperty === "function") root.style.removeProperty(SCALE_PROPERTY);
      } else {
        root.style.fontSize = rootFontSize(scale);
        if (typeof root.style.setProperty === "function") root.style.setProperty(SCALE_PROPERTY, String(scale));
      }
    } catch (e) {
      log("foray-type-scale: could not write the root font size", e);
    }
    return scale;
  }

  function refresh() {
    if (!installed) return lastScale;
    const size = measure();
    return size == null ? lastScale : apply(size);
  }

  function install() {
    if (installed) return false;
    if (!typeScaleApplies(capacitor)) return false;
    if (!doc || typeof doc.createElement !== "function" || !doc.body || !computed) return false;
    try {
      probe = doc.createElement("span");
      probe.setAttribute("aria-hidden", "true");
      /* CSSOM writes, never a `style` attribute (the CSP). Out of flow and
         invisible; its font-size is the only thing read. */
      const st = probe.style;
      st.position = "absolute";
      st.left = "-9999px";
      st.top = "0";
      st.visibility = "hidden";
      st.pointerEvents = "none";
      st.font = PROBE_FONT;
      probe.textContent = "A";
      doc.body.appendChild(probe);
    } catch (e) {
      log("foray-type-scale: could not place the probe", e);
      probe = null;
      return false;
    }
    installed = true;
    refresh();
    if (Observer) {
      try {
        observer = new Observer(function () { refresh(); });
        observer.observe(probe);
      } catch (e) {
        observer = null;
        log("foray-type-scale: no ResizeObserver; the size is read on visibility only", e);
      }
    }
    if (typeof doc.addEventListener === "function") {
      visibilityHandler = function () {
        try {
          if (doc.visibilityState === "visible") refresh();
        } catch (e) {
          log("foray-type-scale: visibility re-measure failed", e);
        }
      };
      doc.addEventListener("visibilitychange", visibilityHandler, false);
    }
    return true;
  }

  function uninstall() {
    if (!installed) return false;
    installed = false;
    try { if (observer) observer.disconnect(); } catch (e) { /* nothing to keep */ }
    observer = null;
    if (visibilityHandler && typeof doc.removeEventListener === "function") {
      doc.removeEventListener("visibilitychange", visibilityHandler, false);
    }
    visibilityHandler = null;
    try { if (probe && typeof probe.remove === "function") probe.remove(); } catch (e) { /* gone already */ }
    probe = null;
    apply(DEFAULT_BODY_PX);
    return true;
  }

  function inspect() {
    return { installed, bodyPx: lastBodyPx, scale: lastScale, observing: observer !== null };
  }

  return { install, uninstall, refresh, inspect };
}

/* Auto-install in the shell, the same shape as `foray-audio-shell.js`'s block:
   the file also ships to the web bundle's tests, where there is no window. */
if (typeof window !== "undefined" && typeof document !== "undefined") {
  const typeScale = createTypeScale({
    capacitor: window.Capacitor,
    doc: document,
    getComputedStyle: typeof window.getComputedStyle === "function" ? window.getComputedStyle.bind(window) : null,
    ResizeObserver: typeof window.ResizeObserver === "function" ? window.ResizeObserver : null,
    log: function (message, error) {
      if (window.console && window.console.warn) window.console.warn(message, error || "");
    },
  });
  window.ForayTypeScale = typeScale;
  const start = function () { typeScale.install(); };
  if (document.body) start();
  else if (typeof document.addEventListener === "function") document.addEventListener("DOMContentLoaded", start, { once: true });
}
