/* PHASE A — does Capacitor's injected bridge survive our CSP on iOS? (#38)
 *
 * Loaded by the REAL index.html, from the REAL bundle, under the REAL CSP. It is
 * an EXTERNAL script on purpose: `script-src 'self'` allows it, so the probe
 * does not need the `'unsafe-inline'` whose absence it exists to measure.
 *
 * Deliberately a classic script and deliberately ES5-flavoured: it must not fail
 * for a reason of its own. Nothing here can throw out of the top-level, because
 * an exception would be indistinguishable from the bridge being blocked.
 *
 * THE REPORTING CHANNEL. A WKWebView on a CI runner has no console anyone can
 * type into, so the page writes its own verdict to `localStorage` and the
 * workflow reads WebKit's local-storage database out of the app container.
 * `console.log` is used as well, which only reaches the system log IF the bridge
 * is alive (Capacitor's native-bridge patches console and forwards it) — so
 * seeing those lines is itself corroborating evidence, and not seeing them
 * proves nothing on its own.
 */
(function () {
  var KEY = "foray_probe_bridge";
  var out = {
    phase: "bridge",
    startedAtWall: Date.now(),
    href: String(location.href),
    protocol: String(location.protocol),
    userAgent: String(navigator.userAgent),
    cspViolations: [],
    capacitorType: "undefined",
  };

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(out)); } catch (e) { /* nothing to do */ }
    try { console.log("FORAY_PROBE_BRIDGE " + JSON.stringify(out)); } catch (e) {}
  }

  /* Registered as early as we can, though be honest about the limit: WKWebView
     injects the bridge via WKUserScript at document start, which is BEFORE this
     file runs, so a violation caused by the bridge itself would already have
     fired and cannot be caught here. `capacitorType` is the real answer;
     violations are a bonus for anything blocked later. */
  try {
    document.addEventListener("securitypolicyviolation", function (e) {
      out.cspViolations.push({
        directive: String(e.effectiveDirective || e.violatedDirective || ""),
        blockedURI: String(e.blockedURI || ""),
        sample: String(e.sample || "").slice(0, 200),
      });
      save();
    });
  } catch (e) {}

  function snapshot() {
    try { out.capacitorType = typeof window.Capacitor; } catch (e) { out.capacitorType = "threw"; }
    out.isNativePlatform = null;
    out.platform = null;
    out.pluginNames = [];
    try {
      if (window.Capacitor && typeof window.Capacitor.isNativePlatform === "function") {
        out.isNativePlatform = window.Capacitor.isNativePlatform();
      }
    } catch (e) { out.isNativePlatform = "threw: " + e.message; }
    try {
      if (window.Capacitor && typeof window.Capacitor.getPlatform === "function") {
        out.platform = window.Capacitor.getPlatform();
      }
    } catch (e) { out.platform = "threw: " + e.message; }
    try {
      if (window.Capacitor && window.Capacitor.Plugins) {
        out.pluginNames = Object.keys(window.Capacitor.Plugins);
      }
    } catch (e) {}
    out.hasServiceWorkerApi = !!navigator.serviceWorker;
  }

  snapshot();
  save();

  /* The consequence of the bridge question, measured rather than reasoned:
     `docs/mobile-shell.md` invariant 3 says the shell must have ZERO service
     worker registrations. If the bridge is blocked, app.js sees no native signal
     — and on the iOS `capacitor://` origin the second signal should still save
     it. This is the number that says whether it did. */
  function checkWorkers(done) {
    try {
      if (!navigator.serviceWorker || !navigator.serviceWorker.getRegistrations) {
        /* NOT 0. On `capacitor://localhost` the API may legitimately be absent,
           and 0 would then be true by construction — which the verdict would have
           rendered as "0 registrations, invariant 3 holding": a pass drawn from an
           absence, the exact shape this whole workflow is written to refuse.
           `hasServiceWorkerApi` (set in snapshot()) is what tells the two apart. */
        out.swRegistrations = null;
        return done();
      }
      navigator.serviceWorker.getRegistrations().then(
        function (rs) { out.swRegistrations = rs.length; done(); },
        function (e) { out.swRegistrationsError = String(e && e.message); done(); }
      );
    } catch (e) { out.swRegistrationsError = String(e && e.message); done(); }
  }

  /* WHICH MEASUREMENT THIS RUN IS FOR.
     `install-probe.mjs` generates `probe-phase.js`, a one-line assignment, and it
     is loaded DYNAMICALLY rather than from a second tag in index.html: `PROBE_TAG`
     is pinned verbatim by install-probe.test.mjs because "external, not inline" is
     the property the bridge measurement rests on, and this is still an external
     same-origin script that `script-src 'self'` allows.

     The default is the ORIGINAL phase, so a missing or blocked phase file degrades
     to the behaviour this file has always had rather than to no navigation at all —
     a probe that lands nowhere is a green run that measured nothing. */
  var PHASES = { outpoint: "probe-outpoint.html", seam: "probe-seam.html" };
  var DEFAULT_PHASE = "outpoint";

  function phaseTarget() {
    var name = DEFAULT_PHASE;
    try {
      if (typeof window.FORAY_PROBE_PHASE === "string" && PHASES[window.FORAY_PROBE_PHASE]) {
        name = window.FORAY_PROBE_PHASE;
      }
    } catch (e) {}
    out.phaseChosen = name;
    return PHASES[name];
  }

  function loadPhaseFile(done) {
    /* ONCE, WHATEVER HAPPENS. WebKit does fire `error` for a missing or blocked
       script, but a callback that can be reached by neither `load` nor `error` would
       leave the page sitting on the bridge probe forever — a green run that measured
       nothing, which is the exact outcome the surrounding comment claims to prevent.
       A 3 s deadline costs nothing and removes the possibility. */
    var settled = false;
    function once(reason) {
      if (settled) return;
      settled = true;
      if (reason) out.phaseFileProblem = reason;
      done();
    }
    var timer = setTimeout(function () { once("timeout"); }, 3000);
    function finish(reason) { clearTimeout(timer); once(reason); }
    try {
      var s = document.createElement("script");
      s.src = "probe-phase.js";
      s.onload = function () { finish(null); };
      s.onerror = function () { finish("error"); };
      document.head.appendChild(s);
    } catch (e) { finish("threw: " + (e && e.message)); }
  }

  /* One late re-check, because a bridge could in principle be injected after
     document start, and then hand over to the measurement phase. 3 s is long
     enough for app.js's own service-worker registration to have happened. */
  setTimeout(function () {
    snapshot();
    out.recheckedAfterMs = 3000;
    checkWorkers(function () {
      loadPhaseFile(function () {
        var target = phaseTarget();
        out.finishedAtWall = Date.now();
        save();
        try {
          if (location.pathname.indexOf(target) < 0) location.replace(target);
        } catch (e) {}
      });
    });
  }, 3000);
})();
