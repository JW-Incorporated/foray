/* Client bootstrap — the only file that connects the player to the page (#25).

   app.js is a classic script; everything under player/ is ES modules. So this
   module owns the wiring and exposes a tiny surface on `window.ForayPlayer`,
   which app.js calls lazily on click. Module scripts are deferred, so app.js
   must never assume this exists at parse time — only at interaction time.

   This file also owns its own DOM (mini-player + Now Playing sheet), built with
   createElement/textContent rather than HTML strings. Episode titles come from
   third-party RSS, and DOM construction is safe by default in a way string
   concatenation is not. There is a strict CSP with no inline styles or scripts;
   all styling lives in styles.css.
*/

import { PlayerQueueManager } from "./queue-manager.js";
import { HtmlAudioBackend } from "./html-audio-backend.js";
import { PositionStore } from "./position-store.js";
import { SINGLE_ITEM } from "./queue-strategy.js";
import { seekPrecision, formatTimestamp, EXACT, OWN } from "./seek-policy.js";

const SEEK_BACK = 15;
const SEEK_FWD = 30;
const RATES = [1, 1.25, 1.5, 1.75, 2];

let manager = null;
let backend = null;
let positions = null;
let ui = null;

/* ---------- DOM ---------- */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function buildUI() {
  const root = el("div", "fp");
  root.id = "foray-player";
  root.hidden = true;

  /* mini bar */
  const bar = el("div", "fp-bar");
  const art = el("img", "fp-art");
  art.alt = "";
  const info = el("button", "fp-info");
  info.type = "button";
  info.setAttribute("aria-label", "Open player");
  const title = el("span", "fp-title");
  const show = el("span", "fp-show");
  info.append(title, show);

  const playBtn = el("button", "fp-play", "▶");
  playBtn.type = "button";
  playBtn.setAttribute("aria-label", "Play");

  const closeBtn = el("button", "fp-close", "✕");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Stop and close player");

  const progress = el("div", "fp-progress");
  const fill = el("div", "fp-fill");
  progress.append(fill);

  bar.append(art, info, playBtn, closeBtn);
  root.append(progress, bar);

  /* expanded sheet */
  const sheet = el("div", "fp-sheet");
  sheet.hidden = true;
  const sTitle = el("h2", "fp-s-title");
  const sShow = el("p", "fp-s-show");
  const sWhy = el("p", "fp-s-why");

  const scrub = el("input", "fp-scrub");
  scrub.type = "range";
  scrub.min = "0";
  scrub.max = "1000";
  scrub.value = "0";
  scrub.setAttribute("aria-label", "Seek");

  const times = el("div", "fp-times");
  const tNow = el("span", "fp-now", "0:00");
  const tLeft = el("span", "fp-left", "--:--");
  times.append(tNow, tLeft);

  const row = el("div", "fp-row");
  const backBtn = el("button", "fp-btn", `↺ ${SEEK_BACK}`);
  backBtn.type = "button";
  backBtn.setAttribute("aria-label", `Back ${SEEK_BACK} seconds`);
  const bigPlay = el("button", "fp-btn fp-big", "▶");
  bigPlay.type = "button";
  bigPlay.setAttribute("aria-label", "Play");
  const fwdBtn = el("button", "fp-btn", `${SEEK_FWD} ↻`);
  fwdBtn.type = "button";
  fwdBtn.setAttribute("aria-label", `Forward ${SEEK_FWD} seconds`);
  row.append(backBtn, bigPlay, fwdBtn);

  const row2 = el("div", "fp-row2");
  const rateBtn = el("button", "fp-rate", "1×");
  rateBtn.type = "button";
  rateBtn.setAttribute("aria-label", "Playback speed");
  const openLink = el("a", "fp-open", "Open episode ↗");
  openLink.target = "_blank";
  openLink.rel = "noopener";
  const collapse = el("button", "fp-collapse", "Close");
  collapse.type = "button";
  row2.append(rateBtn, openLink, collapse);

  const note = el("p", "fp-note");

  sheet.append(sTitle, sShow, sWhy, scrub, times, row, row2, note);
  root.append(sheet);
  document.body.append(root);

  return {
    root, bar, art, title, show, playBtn, closeBtn, fill, sheet,
    sTitle, sShow, sWhy, scrub, tNow, tLeft, bigPlay, backBtn, fwdBtn,
    rateBtn, openLink, collapse, info, note,
  };
}

/* ---------- state -> DOM ---------- */

let current = null;
let scrubbing = false;

function isPlaying() {
  return manager?.state?.type === "playing";
}

function render() {
  if (!ui || !current) return;
  const glyph = isPlaying() ? "❚❚" : "▶";
  ui.playBtn.textContent = glyph;
  ui.bigPlay.textContent = glyph;
  ui.playBtn.setAttribute("aria-label", isPlaying() ? "Pause" : "Play");
  ui.bigPlay.setAttribute("aria-label", isPlaying() ? "Pause" : "Play");

  const pos = backend?.currentTime ?? 0;
  const dur = backend?.duration ?? current.duration_sec ?? null;

  if (!scrubbing && dur) {
    ui.scrub.value = String(Math.round((pos / dur) * 1000));
    ui.fill.style.width = `${Math.min(100, (pos / dur) * 100)}%`;
  }
  ui.tNow.textContent = formatTimestamp(pos, EXACT);
  ui.tLeft.textContent = dur ? `-${formatTimestamp(Math.max(0, dur - pos), EXACT)}` : "--:--";
  syncCardButtons();
}

function syncCardButtons() {
  // Reflect play state on the originating card so the page and the bar agree.
  document.querySelectorAll("[data-play]").forEach((b) => {
    const on = current && b.dataset.play === current.id && isPlaying();
    if (on) b.dataset.playing = "1"; else delete b.dataset.playing;
    b.textContent = on ? "❚❚" : "▶";
  });
}

function setNowPlaying(item, why) {
  current = item;
  ui.root.hidden = false;
  document.body.classList.add("fp-open");
  ui.title.textContent = item.title || "";
  ui.show.textContent = item.show || "";
  ui.sTitle.textContent = item.title || "";
  ui.sShow.textContent = item.show || "";
  ui.sWhy.textContent = why || item.hook || "";
  if (item.artwork_url) {
    ui.art.src = item.artwork_url;
    ui.art.hidden = false;
  } else {
    ui.art.hidden = true;
  }
  if (item.apple_episode_url) {
    ui.openLink.href = item.apple_episode_url;
    ui.openLink.hidden = false;
  } else {
    ui.openLink.hidden = true;
  }

  // Honest scrub affordance. On an ad-stitched feed our own playhead is
  // reliable for this listener (#22's corollary), so scrubbing is exact — but
  // any timestamp we might later show from chapters is not. Say nothing when
  // it's exact; say something plain when it isn't.
  const { precision } = seekPrecision(item, { isLocalFile: false, source: OWN });
  ui.note.textContent = precision === EXACT ? "" : "Timings on this show are approximate.";
  render();
}

/* ---------- wiring ---------- */

function bind() {
  const toggle = async () => {
    if (isPlaying()) await manager.pause();
    else await manager.resume();
    render();
  };
  ui.playBtn.addEventListener("click", toggle);
  ui.bigPlay.addEventListener("click", toggle);

  ui.closeBtn.addEventListener("click", async () => {
    await manager.stop();
    ui.root.hidden = true;
    ui.sheet.hidden = true;
    document.body.classList.remove("fp-open", "fp-expanded");
    current = null;
    syncCardButtons();
  });

  const setExpanded = (open) => {
    ui.sheet.hidden = !open;
    document.body.classList.toggle("fp-expanded", open);
  };
  ui.info.addEventListener("click", () => setExpanded(ui.sheet.hidden));
  ui.collapse.addEventListener("click", () => setExpanded(false));

  ui.backBtn.addEventListener("click", async () => {
    await manager.seek(Math.max(0, (backend.currentTime ?? 0) - SEEK_BACK), { precise: true });
    render();
  });
  ui.fwdBtn.addEventListener("click", async () => {
    await manager.seek((backend.currentTime ?? 0) + SEEK_FWD, { precise: true });
    render();
  });

  ui.scrub.addEventListener("input", () => { scrubbing = true; });
  ui.scrub.addEventListener("change", async () => {
    const dur = backend?.duration ?? current?.duration_sec;
    if (dur) await manager.seek((Number(ui.scrub.value) / 1000) * dur, { precise: true });
    scrubbing = false;
    render();
  });

  ui.rateBtn.addEventListener("click", () => {
    const cur = Number(localStorage.getItem("cp_rate")) || 1;
    const next = RATES[(RATES.indexOf(cur) + 1) % RATES.length];
    localStorage.setItem("cp_rate", String(next));
    backend.setRate(next);
    ui.rateBtn.textContent = `${next}×`;
  });

  // Corner case #17: pocketing the phone must not lose the position. This is
  // the path that actually matters on mobile — beforeunload is unreliable there.
  const flush = () => { if (current && isPlaying()) manager._persistPosition(); };
  document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });
  window.addEventListener("pagehide", flush);
}

function ensureBooted() {
  if (manager) return;

  positions = new PositionStore({
    onSave: (id, seconds, meta) => {
      // Ride the existing event pipeline; app.js owns it.
      if (typeof window.forayLogEvent === "function") {
        window.forayLogEvent("position", { episode_id: id, seconds, duration: meta.duration ?? null });
      }
    },
  });

  backend = new HtmlAudioBackend();
  manager = new PlayerQueueManager({
    backend,
    positionStore: positions,
    strategy: SINGLE_ITEM,
    telemetry: (m) => { if (/error|rejected/i.test(m)) console.warn("[player]", m); },
  });

  ui = buildUI();
  bind();

  backend.setRate(Number(localStorage.getItem("cp_rate")) || 1);
  ui.rateBtn.textContent = `${Number(localStorage.getItem("cp_rate")) || 1}×`;

  backend.el.addEventListener("timeupdate", render);
  backend.el.addEventListener("play", render);
  backend.el.addEventListener("pause", render);
}

/* ---------- public surface ---------- */

const ForayPlayer = {
  /** True when this item can play in-app. app.js uses it to decide whether to
      show a play button or fall back to the Apple Podcasts link (#25 note). */
  canPlay(item) {
    return Boolean(item && item.audio_url);
  },

  /** Play one episode. SINGLE_ITEM strategy: the queue is this episode and
      nothing follows it (CLAUDE.md principle 1 — no autoplay chains). */
  async play(item, { why = "" } = {}) {
    if (!this.canPlay(item)) return false;
    ensureBooted();
    setNowPlaying(item, why);
    manager.setQueueFromPick(item);
    await manager.play(0);
    render();
    return true;
  },

  isPlaying(id) {
    return isPlaying() && current?.id === id;
  },
};

window.ForayPlayer = ForayPlayer;
export default ForayPlayer;
