/* The in-page half of dock-check.mjs: functions handed to `page.evaluate`, so each one is SELF-CONTAINED (no
 * closure over this module) and returns plain JSON. The shapes are what lib/dock-rules.mjs reads. */

/** Everything the Dock's geometry rules need, in one pass. `expect` = { field, mini } is what the screen under
 *  test must show; it is carried through so the evaluators know the intent. */
export function measureDock(expect) {
  const q = (s) => document.querySelector(s);
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: +r.top.toFixed(2), bottom: +r.bottom.toFixed(2), left: +r.left.toFixed(2), right: +r.right.toFixed(2), width: +r.width.toFixed(2), height: +r.height.toFixed(2) };
  };
  const shown = (el) => {
    if (!el || el.hidden) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const layer = q("#dock-layer");
  const dock = q("#dock");
  /* Colour probes: a throwaway span inside the Dock's own scope paints each token, so what the page computed
     (not what a stylesheet says) is compared with what an element actually showed. */
  const probe = (decl) => {
    const s = document.createElement("span");
    s.style.setProperty(decl[0], decl[1]);
    layer.appendChild(s);
    const out = getComputedStyle(s)[decl[0] === "color" ? "color" : "backgroundColor"];
    s.remove();
    return out;
  };
  const colours = {
    text: probe(["color", "var(--text)"]), text2: probe(["color", "var(--text-2)"]),
    ember: probe(["background-color", "var(--ember)"]), glow: probe(["background-color", "var(--glow)"]),
  };
  const rows = ["dock-field", "dock-mini", "tab-bar"].map((id) => {
    const el = document.getElementById(id);
    return { id, rect: rect(el), visible: shown(el), rim: el ? getComputedStyle(el).boxShadow !== "none" : false };
  });
  const dcs = getComputedStyle(dock);
  const mini = q("#dock-mini .fp-bar") && shown(q("#dock-mini")) ? (() => {
    const bar = q("#dock-mini .fp-bar");
    const title = bar.querySelector(".fp-title");
    const show = bar.querySelector(".fp-show");
    const fill = q("#dock-mini .fp-fill");
    const prog = q("#dock-mini .fp-progress");
    const tcs = getComputedStyle(title);
    const lh = parseFloat(tcs.lineHeight) || title.getBoundingClientRect().height;
    return {
      rect: rect(q("#dock-mini")),
      art: rect(bar.querySelector(".fp-art")), play: rect(bar.querySelector(".fp-play")), skip: rect(bar.querySelector(".fp-skip")),
      info: rect(bar.querySelector(".fp-info")),
      titleLines: Math.max(1, Math.round(title.getBoundingClientRect().height / lh)),
      titleFont: `${tcs.fontWeight} ${tcs.fontSize} ${tcs.fontFamily.split(",")[0]}`,
      titleFontIsLabel: tcs.fontWeight === "600" && parseFloat(tcs.fontSize) === 14,
      showText: (show.textContent || "").trim(),
      playBg: getComputedStyle(bar.querySelector(".fp-play")).backgroundColor,
      skipBg: getComputedStyle(bar.querySelector(".fp-skip")).backgroundColor,
      running: bar.querySelector(".fp-play").dataset.running || null,
      progress: { fillWidth: fill.getBoundingClientRect().width, rect: rect(prog), ariaHidden: prog.getAttribute("aria-hidden"), fillBg: getComputedStyle(fill).backgroundColor },
      region: { role: bar.getAttribute("role"), label: bar.getAttribute("aria-label") },
    };
  })() : null;
  const tabEls = [...document.querySelectorAll("#tab-bar .tab-btn")];
  const first = tabEls[0];
  const href = (el) => (el && el.querySelector("use") ? el.querySelector("use").getAttribute("href") : null);
  const tabs = {
    items: tabEls.map((a) => ({
      key: a.dataset.tabKey, rect: rect(a), current: a.getAttribute("aria-current") === "page", color: getComputedStyle(a).color,
      onOpacity: +getComputedStyle(a.querySelector(".tab-glyph-on")).opacity, offOpacity: +getComputedStyle(a.querySelector(".tab-glyph-off")).opacity,
      fillHref: href(a.querySelector(".tab-glyph-on")), regularHref: href(a.querySelector(".tab-glyph-off")),
    })),
    iconBox: first ? rect(first.querySelector(".tab-glyphs")) : { width: 0, height: 0 },
    labelOpacity: first ? +getComputedStyle(first.querySelector(".tab-label")).opacity : 1,
  };
  const fadeEl = q(".dock-fade");
  const fcs = fadeEl ? getComputedStyle(fadeEl) : null;
  const fbs = fadeEl ? getComputedStyle(fadeEl, "::before") : null;   // the cast's copy inside the fade
  const castEl = q("#dock-cast");
  const ccs = castEl ? getComputedStyle(castEl) : null;
  /* Every visible text run OUTSIDE the Dock: its client rect and the opacity it is painted at. */
  const text = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const s = (n.data || "").trim();
    if (!s) continue;
    const el = n.parentElement;
    if (!el || el.closest("#dock-layer, #dock-cast, script, style, noscript, [hidden], [inert]")) continue;
    let opacity = 1;
    let hidden = false;
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden") { hidden = true; break; }
      opacity *= parseFloat(cs.opacity);
    }
    if (hidden || opacity === 0) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) {
      if (r.width < 1 || r.height < 1) continue;
      text.push({ text: s.slice(0, 40), top: +r.top.toFixed(2), bottom: +r.bottom.toFixed(2), left: +r.left.toFixed(2), right: +r.right.toFixed(2), opacity });
    }
  }
  const safeProbe = document.createElement("div");
  safeProbe.style.setProperty("padding-bottom", "env(safe-area-inset-bottom, 0px)");
  document.body.appendChild(safeProbe);
  const safeBottom = parseFloat(getComputedStyle(safeProbe).paddingBottom) || 0;
  safeProbe.remove();
  return {
    expect, viewport: { w: innerWidth, h: innerHeight }, safeBottom,
    scheme: matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark",
    receded: document.body.classList.contains("dock-receded") || document.body.classList.contains("sh-compose"),
    dock: rect(dock), dockStyle: { radius: parseFloat(dcs.borderTopLeftRadius), backdrop: dcs.backdropFilter || dcs.webkitBackdropFilter || "", overflow: dcs.overflow },
    rows, mini, tabs, colours,
    fade: fadeEl ? {
      present: true, rect: rect(fadeEl), display: fcs.display, backgroundImage: fcs.backgroundImage, pointerEvents: fcs.pointerEvents, ariaHidden: fadeEl.getAttribute("aria-hidden"),
      /* the gradient's last px stop: where it reaches the page colour */
      castCopy: fbs && fbs.content !== "none" && fbs.content !== "normal" ? { display: fbs.display, backgroundImage: fbs.backgroundImage, mask: fbs.maskImage || fbs.webkitMaskImage || "none" } : null,
      stopPx: (() => { const n = [...fcs.backgroundImage.matchAll(/(\d+(?:\.\d+)?)px/g)].map((x) => Number(x[1])); return n.length ? n[n.length - 1] : 0; })(),
    } : { present: false },
    cast: castEl ? { state: castEl.dataset.state, display: ccs.display, backgroundImage: ccs.backgroundImage, rect: rect(castEl), ariaHidden: castEl.getAttribute("aria-hidden") } : { state: null, display: "none", backgroundImage: "", rect: { bottom: 0 }, ariaHidden: null },
    text,
  };
}

/** The recede sequence, run in the page that is already on a tall-tab page with enough height to scroll. Each step
 *  scrolls the window, waits for the transition, and reads whether the Dock is receded. Returns the facts the
 *  recede evaluator reads, including the transition's own duration and easing as computed. */
export async function runRecedeSequence() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const receded = () => document.body.classList.contains("dock-receded");
  const go = async (y) => { window.scrollTo(0, y); await wait(120); };
  await go(0);
  await wait(350);
  const out = {};
  await go(30); await go(60);
  out.at60Receded = receded();
  await go(90); await go(120);
  out.at120Receded = receded();
  await go(119);
  out.after1pxUpReceded = receded();
  await go(260);
  out.afterRescrollReceded = receded();
  await go(0);
  out.atTopReceded = receded();
  const bar = document.getElementById("tab-bar");
  const cs = getComputedStyle(bar);
  const props = cs.transitionProperty.split(",").map((s) => s.trim());
  const i = props.indexOf("height");
  out.durationMs = i < 0 ? -1 : parseFloat(cs.transitionDuration.split(",")[i]) * 1000;
  out.easing = i < 0 ? "" : cs.transitionTimingFunction.split(/,(?![^(]*\))/)[i].trim();
  return out;
}
