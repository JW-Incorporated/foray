/* ui/boot.js — Boot: starts init() and registers the service worker. MUST load last.
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init(). */


init();

if ("serviceWorker" in navigator && shouldRegisterServiceWorker(window)) {
  /* AFTER THE FIRST PAINT (round-2 audit, perf-4). Registered here, at script
     end, the worker's install — every file in the manifest — ran while init()
     was still fetching the boot documents, on the first visit of every
     listener. It waits for the first page and then for an idle moment. */
  firstPagePainted.then(() => whenIdle(() => {
    navigator.serviceWorker.register("sw.js").catch(() => { /* progressive */ });
  }));
  /* Feature-detected rather than assumed: `navigator.serviceWorker` is somebody
     else's object, and a page that threw here would lose everything below it. */
  if (typeof navigator.serviceWorker.addEventListener === "function") {
    navigator.serviceWorker.addEventListener("message", (e) => {
      const msg = e && e.data;
      if (!msg || msg.source !== "foray-sw") return;
      /* By the time this fires, `pinnedDeployId` is already set synchronously
         (see the top of this file) if this load fell back at all — this
         assignment is now a REDUNDANT confirmation, not the establishing
         write, kept only as a safety net for a message that legitimately
         arrives with a different id than the synchronous read found (there is
         no such path today, but it costs nothing and a future one should not
         have to remember this). A `deployId` of null (an unretained/unknown
         generation on the worker's side) intentionally does not clear an
         already-set pin — see sw.js's `handleData` fail-safe for the matching
         reasoning.

         `pin: false` (round-3 audit, app-3-5) is a fallback of a file that does
         not read data (search-engine.js, a player module) while this app.js
         may well be live: the notice goes up, the pin does not, or new code
         would be paired with the previous generation's data. A worker from
         before that field sends none, which keeps the old meaning (pin). */
      /* "generation-changed" is broadcast to every open page on each
         promotion (round-3 audit, app-3-3). A page that is not pinned and
         already runs the announced deploy loaded it live and is current:
         telling it "one version behind" was false after every deploy, and the
         bar covers the Foray transport. A pinned page, or one that cannot
         name its own deploy, is still told. */
      if (msg.reason === "generation-changed" && !pinnedDeployId && pageDeployId && msg.deployId === pageDeployId) return;
      const adoptsPin = msg.reason === "stale-shell" && msg.pin !== false;
      if (adoptsPin && msg.deployId) pinnedDeployId = msg.deployId;
      /* FD-01: the web's pinned-generation path records the same fact the shell's
         boot row does — where the documents came from, and which deploy id. */
      if (adoptsPin) {
        const tag = `sw-cache@${pinnedDeployId || "unknown"}`;
        noteDataSource({
          phase: "stale-shell", source: "sw-cache", version: pinnedDeployId || "unknown",
          files: { forays: tag, segments: tag, sources: tag },
        });
      }
      showShellNotice(msg.reason);
    });
  }
}
