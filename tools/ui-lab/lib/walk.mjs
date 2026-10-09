/* The walker shared by shoot.mjs and a11y.mjs: boots a deterministic browser
 * context per (state, viewport), steps through the screens, and calls
 * `onShot(page, meta)` at each one. The consumer decides what to do there.
 *
 * DETERMINISM, in the order it is applied (init script, runs before app code):
 *   - Date starts at 2026-10-05T12:00:00Z and then runs at the real rate (a hard
 *     freeze breaks the app's own deadline/debounce arithmetic; relative labels
 *     such as "3 days ago" are stable because the start is pinned);
 *   - Math.random is a seeded PRNG;
 *   - Audio elements are recorded on window.__audios so playback can be pinned;
 *   - localStorage is seeded once per tab from the profile (seed.mjs);
 *   - --css is applied through a constructable stylesheet, which a strict CSP
 *     does not block (a <style> element would be);
 *   - service workers are blocked; locale, timezone and colour scheme are fixed;
 *   - screenshots run with animations disabled and the caret hidden.
 * The network is stubbed by stubs.mjs.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { chromium } from "playwright";
import { startServer } from "./server.mjs";
import { installStubs } from "./stubs.mjs";
import { loadFixtures, buildSeed, FIXED_NOW_ISO } from "./seed.mjs";
import { appStates } from "./states.mjs";
import { slug } from "./args.mjs";
import { SILENCE_SPEECH } from "./silence.mjs";

/** Repo root from tools/ui-lab/<script>.mjs's import.meta.url. */
export function repoRootFrom(importMetaUrl) {
  return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), "..", "..");
}

export function initScript({ seed, css }) {
  const fixed = Date.parse(FIXED_NOW_ISO);
  return `(() => {
    try {
      const FIXED = ${fixed}; const t0 = performance.now(); const RealDate = Date;
      const now = () => FIXED + (performance.now() - t0);
      class FDate extends RealDate {
        constructor(...a) { if (a.length === 0) super(now()); else super(...a); }
        static now() { return Math.floor(now()); }
      }
      FDate.UTC = RealDate.UTC; FDate.parse = RealDate.parse;
      window.Date = FDate;
      let s = 1337;
      Math.random = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      const RA = window.Audio; window.__audios = [];
      window.Audio = function (...a) { const el = new RA(...a); window.__audios.push(el); return el; };
      window.Audio.prototype = RA.prototype;
    } catch (e) { /* determinism is best-effort, never fatal */ }
    ${SILENCE_SPEECH}
    try {
      if (!sessionStorage.getItem("__uilab_seeded")) {
        const SEED = ${JSON.stringify(seed)};
        for (const k of Object.keys(SEED)) localStorage.setItem(k, JSON.stringify(SEED[k]));
        sessionStorage.setItem("__uilab_seeded", "1");
      }
    } catch (e) { /* storage blocked: render without a profile */ }
    try {
      const CSS = ${JSON.stringify(css || "")};
      if (CSS) { const sh = new CSSStyleSheet(); sh.replaceSync(CSS);
        const add = () => { document.adoptedStyleSheets = [...document.adoptedStyleSheets, sh]; };
        add(); }
    } catch (e) { /* no constructable sheets */ }
  })();`;
}

export async function settle(page, ms = 500) {
  await page.evaluate(async () => {
    try { await document.fonts.ready; } catch (_) { /* ignore */ }
    const imgs = Array.from(document.images);
    await Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 5000); }))));
  }).catch(() => {});
  await page.waitForTimeout(ms);
}

async function appReady(page) {
  await page.waitForFunction(
    () => Boolean(window.ForayPlayer) && Boolean(document.querySelector("#tab-bar .tab-btn")) && Boolean(document.querySelector("#view")?.children.length),
    null,
    { timeout: 45000 }
  );
}

async function gotoHash(page, hash) {
  const cur = await page.evaluate(() => location.hash || "#/");
  if (cur === hash) return false;
  await page.evaluate((h) => { location.hash = h; }, hash);
  return true;
}

/**
 * @param {object} o
 * @param {"app"|"url"} o.target
 * @param {string} o.repoRoot
 * @param {string} [o.url]        file path or http(s) URL (target url)
 * @param {string[]} [o.routes]   hash routes (target url)
 * @param {string} [o.css]        extra CSS text
 * @param {{w:number,h:number,name:string}[]} o.viewports
 * @param {string[]} [o.states]   subset of app state ids
 * @param {boolean} [o.remoteImages=true]
 * @param {string} [o.scheme="dark"]
 * @param {"reduce"|"no-preference"} [o.reducedMotion]  emulated prefers-reduced-motion (default: browser default)
 * @param {(page, getCurrent)=>Promise<void>} [o.onPage]  called once per new page, before navigation
 * @param {(page, meta)=>Promise<any>} onShot
 */
export async function walk(o, onShot) {
  const remoteImages = o.remoteImages !== false;
  const results = [];
  const errors = [];
  const stubLog = [];
  let server = null;
  let entryUrl;

  if (o.target === "app") {
    server = await startServer(o.repoRoot);
    entryUrl = server.entryUrl;
  } else if (/^https?:\/\//i.test(o.url || "")) {
    entryUrl = o.url;
  } else {
    if (!o.url || !existsSync(path.resolve(o.url))) throw new Error(`--url "${o.url}" is not an existing file/dir or an http(s) URL`);
    server = await startServer(o.url);
    entryUrl = server.entryUrl;
  }
  const stripHash = (u) => u.split("#")[0];
  const base = stripHash(entryUrl);

  let plan; // [{id, seedName, description, steps}]
  let fx = null;
  if (o.target === "app") {
    fx = loadFixtures(o.repoRoot);
    plan = appStates(fx);
    if (o.states && o.states.length) plan = plan.filter((s) => o.states.includes(s.id));
    if (!plan.length) throw new Error("no matching --states; known: " + appStates(fx).map((s) => s.id).join(", "));
  } else {
    const routes = o.routes && o.routes.length ? o.routes : [""];
    plan = [{ id: "default", seed: "empty", description: "static prototype", steps: routes.map((r) => ({ label: slug(r || "index"), route: r })) }];
  }

  const browser = await chromium.launch();
  try {
    const runOne = async (vp, st) => {
      const context = await browser.newContext({
        viewport: { width: vp.w, height: vp.h },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        serviceWorkers: "block",
        locale: "en-US",
        timezoneId: "UTC",
        colorScheme: o.scheme || "dark",
        ...(o.reducedMotion ? { reducedMotion: o.reducedMotion } : {}),
      });
      const seed = o.target === "app" ? buildSeed(st.seed, fx) : {};
      await context.addInitScript(initScript({ seed, css: o.css }));
      const stubs = await installStubs(context, { localOrigins: server ? [new URL(server.baseUrl).origin] : [], remoteImages });
      const page = await context.newPage();
      let current = { state: st.id, label: "boot", route: "", viewport: vp.name };
      if (o.onPage) await o.onPage(page, () => current); // gates.mjs: per-page listeners
      page.on("pageerror", (e) => errors.push({ ...current, kind: "pageerror", message: String(e && e.message || e).slice(0, 300) }));
      page.on("console", (m) => { if (m.type() === "error") errors.push({ ...current, kind: "console", message: (m.text() + " " + (m.location().url || "")).slice(0, 300) }); });
      try {
        let first = true;
        for (const step of st.steps) {
          current = { state: st.id, label: step.label, route: step.route, viewport: vp.name };
          if (o.target === "app") {
            if (first) {
              await page.goto(base + (step.route || "#/"), { waitUntil: "load" });
              await appReady(page);
              await settle(page, 900);
              first = false;
            } else {
              const moved = await gotoHash(page, step.route);
              if (moved) await settle(page, 700);
            }
            if (step.ready) await page.waitForSelector(step.ready, { timeout: 15000 }).catch(() => {});
          } else {
            await page.goto("about:blank");
            await page.goto(base + (step.route || ""), { waitUntil: "load" });
            await settle(page, 600);
          }
          if (step.run) await step.run(page, { fx });
          await settle(page, 400);
          const meta = { state: st.id, label: step.label, route: step.route || "", viewport: vp.name, w: vp.w, h: vp.h };
          const extra = await onShot(page, meta);
          results.push({ ...meta, ...(extra || {}) });
        }
      } finally {
        stubLog.push(...stubs.log);
        await context.close();
      }
    };

    // Viewports run concurrently (one context each); states within a viewport run in order.
    await Promise.all(o.viewports.map(async (vp) => {
      for (const st of plan) {
        try { await runOne(vp, st); }
        catch (e) { errors.push({ state: st.id, viewport: vp.name, kind: "walk-failure", message: String(e && e.message || e).slice(0, 400) }); }
      }
    }));
  } finally {
    await browser.close();
    if (server) await server.close();
  }
  return { results, errors, stubLog, states: plan.map((s) => ({ id: s.id, description: s.description })) };
}

export function readCss(file) {
  if (!file) return "";
  return readFileSync(path.resolve(file), "utf8");
}
