/* Afterglow car posture (Redesign 2026, ambient). `<html data-posture="car">` is the whole state: ui/car.css and the
   Afterglow tokens read it, and nothing else stores it, so it can never outlive the sheet it opened (player/client.js
   ends it whenever Now Playing collapses or playback stops).

   WAYS IN
     - a 600ms hold on the mini row (`bindPress`, called by player/client.js on the bar). The Bluetooth-route observer
       that will also enter it is Native and not built; this is the manual path.
     - `?posture=car` in the page URL (the harness's way in; `fromSearch`). Now Playing then opens by itself as soon as
       something is loaded (client.js asks `active()`).
   WAY OUT
     - the car chip at the top of Now Playing (`adopt`), or collapsing the sheet.

   Classic script, no storage, no network. Anything dynamic reaches the DOM through textContent / setAttribute; the sprite
   reference crosses safeUrl() like every other href. */

const AG_CAR_HOLD_MS = 600;
const AG_CAR_SLOP_PX = 10;

function agCarRoot(doc) {
  return (doc || document).documentElement;
}

function agCarActive(doc) {
  return agCarRoot(doc)?.getAttribute?.("data-posture") === "car";
}

/* `?posture=car` and nothing else turns it on from the URL; any other value (or none) is not car posture. */
function agCarFromSearch(search) {
  try { return new URLSearchParams(String(search || "")).get("posture") === "car"; } catch (_) { return false; }
}

/* The medium haptic hook. Haptics are a Phase 5 item (no @capacitor/haptics in mobile/ yet): this calls the plugin only
   when the native shell has put it on the page, so on the web and in the lab it is a quiet no-op. A throwing plugin
   never blocks the posture change. */
function agCarHaptic() {
  try { window.Capacitor?.Plugins?.Haptics?.impact?.({ style: "MEDIUM" }); } catch (_) { /* a haptic is garnish */ }
}

function agCarEnter(doc) {
  const root = agCarRoot(doc);
  if (!root || agCarActive(doc)) return false;
  root.setAttribute("data-posture", "car");
  agCarSyncChip();
  return true;
}

function agCarLeave(doc) {
  const root = agCarRoot(doc);
  if (!root || !agCarActive(doc)) return false;
  root.removeAttribute("data-posture");
  agCarSyncChip();
  return true;
}

/* The chip is the one control that says posture is on and ends it. Its state is read from the attribute, so entering
   and leaving by any path repaints it. */
let agCarChips = [];
function agCarSyncChip() {
  const on = agCarActive();
  for (const chip of agCarChips) chip.setAttribute("aria-pressed", on ? "true" : "false");
}

/* Hold detection on the mini row. The two transport buttons keep their own jobs and never start a press; a finger that
   drifts more than SLOP_PX is scrolling or swiping, not holding; and the click that ends a hold is swallowed in the
   CAPTURE phase, before the title button or the artwork can turn it into a toggle that closes what the hold just opened.
   `opts.onHold` runs once per hold. Timers are injectable so the suite can drive the clock. */
function agCarBindPress(bar, opts = {}) {
  const hold = opts.hold ?? AG_CAR_HOLD_MS;
  const slop = opts.slop ?? AG_CAR_SLOP_PX;
  const isControl = opts.isControl || (() => false);
  const set = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clear = opts.clearTimer || ((id) => clearTimeout(id));
  let timer = null;
  let fired = false;
  let origin = null;
  const cancel = () => {
    if (timer !== null) { clear(timer); timer = null; }
  };
  bar.addEventListener("pointerdown", (e) => {
    if ((e.button ?? 0) !== 0 || isControl(e.target)) return;
    fired = false;
    origin = { x: e.clientX ?? 0, y: e.clientY ?? 0 };
    cancel();
    timer = set(() => {
      timer = null;
      fired = true;
      opts.onHold?.();
    }, hold);
  });
  bar.addEventListener("pointermove", (e) => {
    if (timer === null || !origin) return;
    if (Math.abs((e.clientX ?? 0) - origin.x) > slop || Math.abs((e.clientY ?? 0) - origin.y) > slop) cancel();
  });
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) bar.addEventListener(type, cancel);
  /* A held artwork would otherwise raise the browser's image menu on top of the sheet. */
  bar.addEventListener("contextmenu", (e) => e.preventDefault?.());
  bar.addEventListener("click", (e) => {
    if (!fired) return;
    fired = false;
    e.preventDefault?.();
    e.stopPropagation?.();
  }, true);
  return { cancel };
}

/* The chip: sprite glyph + "Car", 44px tall, shown by CSS only while posture is on, pressed because it is on. It sits
   between the close chevron and the dots, which stay visible in the car to balance it (ui/now-playing.js openDetail ends
   posture before it opens the detail the dots lead to). */
function agCarAdopt(ui) {
  if (!ui?.grabZone || ui.carChip) return ui;
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "ag-np-car-chip t-label";
  chip.setAttribute("aria-label", "Car mode on. Leave car mode");
  chip.setAttribute("aria-pressed", agCarActive() ? "true" : "false");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  svg.setAttribute("class", "icon icon-20");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  use.setAttribute("href", safeUrl("ui/icons.svg#i-car"));
  svg.append(use);
  chip.append(svg, document.createTextNode("Car"));
  /* Leaving posture hides this very chip (car.css: display none once data-posture is gone), and focus on a control that
     stops rendering falls to <body> inside the still-open modal sheet. Hand it to the close chevron, which is always
     shown and is the sheet's own way out (Play as the fallback). */
  chip.addEventListener("click", () => {
    agCarLeave();
    const stable = ui.closeBtn || ui.playBtn;
    if (stable && typeof stable.focus === "function") stable.focus();
  });
  if (ui.moreMenuBtn) {
    ui.grabZone.insertBefore(chip, ui.moreMenuBtn);
  } else {
    ui.grabZone.append(chip);
  }
  ui.carChip = chip;
  agCarChips.push(chip);
  return ui;
}

/* The harness's way in, applied as the script loads so the very first paint already has the Dock out of the way. */
if (typeof location !== "undefined" && agCarFromSearch(location.search)) agCarEnter();

window.AfterglowCar = {
  HOLD_MS: AG_CAR_HOLD_MS,
  SLOP_PX: AG_CAR_SLOP_PX,
  active: agCarActive,
  enter: agCarEnter,
  leave: agCarLeave,
  fromSearch: agCarFromSearch,
  haptic: agCarHaptic,
  bindPress: agCarBindPress,
  adopt: agCarAdopt,
};
