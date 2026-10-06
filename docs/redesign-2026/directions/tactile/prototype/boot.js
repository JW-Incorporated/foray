/* Runs before first paint (loaded in <head>, no inline script under the CSP): ?theme=dark|light forces Bakelite or Cream so the screenshot harness can render both schemes. */
(function () {
  var m = (location.search || "").match(/[?&]theme=(dark|light)/);
  if (m) document.documentElement.setAttribute("data-theme", m[1]);
})();
