/* REVIEW TOOL ONLY. Remove before Phase 3 (delete this file, font-preview.css,
   their two tags in index.html, the "REVIEW ONLY" block at the end of tokens.css,
   and the Plex and Instrument @font-face lines plus fonts/ibm-plex-sans-latin.woff2
   and fonts/instrument-sans-latin.woff2).

   What it does: a floating "Aa" button cycles the display/title/heading face
   between Archivo (the art director's pick), IBM Plex Sans and Instrument Sans
   by setting data-display-font on <html>; tokens.css swaps --font-display and
   its weight/width/tracking tokens. Text and mono roles never change.
   Persists in localStorage under cp_display_font_preview (try/catch).
   CSP-safe: no inline script or style, classes and attributes only.
   Hidden for screenshots with ?review=off, or <html data-review="off">.
   ?font=archivo|plex|instrument forces a face (used by the shooter). */
(function () {
  var FACES = [
    { id: "archivo", name: "Archivo" },
    { id: "plex", name: "IBM Plex Sans" },
    { id: "instrument", name: "Instrument Sans" }
  ];
  var KEY = "cp_display_font_preview";
  var root = document.documentElement;

  function find(id) { for (var i = 0; i < FACES.length; i++) if (FACES[i].id === id) return i; return -1; }
  function read() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function write(v) { try { localStorage.setItem(KEY, v); } catch (e) { /* private window */ } }

  var q = (location.search || "");
  var qf = q.match(/[?&]font=(archivo|plex|instrument)/);
  var qOff = /[?&]review=off/.test(q);
  var cur = find(qf ? qf[1] : read());
  if (cur < 0) cur = 0;
  function apply() {
    if (cur === 0) root.removeAttribute("data-display-font"); else root.setAttribute("data-display-font", FACES[cur].id);
  }
  apply();                                  /* before first paint: this file loads in <head> */
  if (qOff) root.setAttribute("data-review", "off");

  document.addEventListener("DOMContentLoaded", function () {
    var btn = document.createElement("button");
    btn.type = "button"; btn.className = "fp-btn";
    btn.textContent = "Aa";
    var toast = document.createElement("div");
    toast.className = "fp-toast"; toast.setAttribute("role", "status");
    function label() { btn.setAttribute("aria-label", "Font preview. Current display font: " + FACES[cur].name + ". Tap to switch."); }
    label();
    var t = null;
    btn.addEventListener("click", function () {
      cur = (cur + 1) % FACES.length; apply(); write(FACES[cur].id); label();
      toast.textContent = "Display font: " + FACES[cur].name;
      toast.classList.add("show"); clearTimeout(t);
      t = setTimeout(function () { toast.classList.remove("show"); }, 2200);
    });
    document.body.appendChild(btn); document.body.appendChild(toast);
  });
})();
