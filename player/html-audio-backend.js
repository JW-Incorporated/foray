/* HtmlAudioBackend — the first PlayerBackend implementation (issue #24).

   Drives a single `<audio>` element. Ships to the web PWA today; the native
   backend (#28, AVPlayer / Media3) implements the same contract later and the
   queue manager never learns which one it is driving.

   ── The contract (mirrors ios/App/Player/PlayerBackend.swift) ─────────────
     async load(item, { startOffset })   resolve when ready to produce audio
     play() / pause()
     seek(seconds, { precise })
     setRate(rate)
     setVolume(v)                        0..1 — hold-to-talk ducking later
     get currentTime() / get duration()
     release()
     onItemEnded / onError               assigned by the manager

   ── Things that will bite, all load-bearing ───────────────────────────────

   ONE ELEMENT, FOR THE LIFETIME OF THE APP. Creating an element per item is
   the web equivalent of corner case #19's two-AVPlayers bug: the old one keeps
   decoding and you get two things audible at once. There is exactly one, and
   it is reused.

   NO `crossorigin` ATTRIBUTE. Podcast CDNs send no `Access-Control-Allow-
   Origin` (measured — see #20 §3). A media element loads cross-origin fine
   without CORS; setting the attribute turns a working no-cors load into a
   hard failure. The cost is that Web Audio cannot touch this element, so
   ducking uses `.volume` rather than a gain node — which is all the spec
   actually needs.

   `currentTime` BEFORE METADATA IS LOST. Assigning it while `readyState` is 0
   either throws or is silently discarded depending on the browser, so the
   start offset is applied after `loadedmetadata`, never optimistically.

   AUTOPLAY REJECTION IS NORMAL, NOT EXCEPTIONAL. `play()` returns a promise
   that rejects without a user gesture. It must be caught — an unhandled
   rejection here is a console error on every session start.
*/

const READY_ENOUGH = 3; // HAVE_FUTURE_DATA

export class HtmlAudioBackend {
  /**
   * @param {object} [opts]
   * @param {HTMLAudioElement} [opts.element] injected for tests
   * @param {Function} [opts.telemetry]
   */
  constructor({ element = null, telemetry = null } = {}) {
    const el = element ?? (typeof Audio !== "undefined" ? new Audio() : null);
    if (!el) throw new Error("HtmlAudioBackend requires an <audio> element");

    this.el = el;
    this._telemetry = telemetry;
    this.onItemEnded = null;
    this.onError = null;

    // `preload = auto` so the network fetch starts as soon as src is set,
    // rather than waiting for play() — that is most of the tap-to-audio budget.
    this.el.preload = "auto";
    // Deliberately NOT setting el.crossOrigin. See the header.

    this._currentItem = null;
    this._pendingRate = 1.0;
    this._released = false;

    this._onEnded = () => { if (this.onItemEnded) this.onItemEnded(); };
    this._onError = () => {
      const code = this.el.error?.code;
      this._emit(`audio.error code=${code ?? "?"} src=${short(this.el.currentSrc)}`);
      if (this.onError) this.onError(`media error ${code ?? "unknown"}`);
    };
    this.el.addEventListener("ended", this._onEnded);
    this.el.addEventListener("error", this._onError);
  }

  /* ---------- loading ---------- */

  /**
   * Point the element at an item and resolve once it can produce audio at the
   * requested offset. Rejects on a media error so the manager's degrade path
   * (corner case #6/#10) can run.
   */
  load(item, { startOffset = 0 } = {}) {
    if (this._released) return Promise.reject(new Error("backend released"));
    if (!item?.audio_url) return Promise.reject(new Error(`item ${item?.id} has no audio_url`));

    this._currentItem = item;

    return new Promise((resolve, reject) => {
      const el = this.el;
      let settled = false;

      const cleanup = () => {
        el.removeEventListener("loadedmetadata", onMeta);
        el.removeEventListener("canplay", onCanPlay);
        el.removeEventListener("error", onErr);
        el.removeEventListener("seeked", onSeeked);
      };
      const done = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const fail = (msg) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(msg));
      };

      const onErr = () => fail(`load failed (code ${el.error?.code ?? "?"}) for ${item.id}`);

      // Offset is applied here, not before: assigning currentTime at
      // readyState 0 is discarded, and doing it after playback starts would
      // let the episode's opening be briefly audible before the jump.
      const onMeta = () => {
        if (startOffset > 0 && Number.isFinite(startOffset)) {
          try { el.currentTime = startOffset; } catch (_) { /* browser refused; continue at 0 */ }
        }
      };
      const onSeeked = () => { if (el.readyState >= READY_ENOUGH) done(); };
      const onCanPlay = () => {
        // If we asked for an offset, wait until we are actually near it —
        // otherwise `canplay` can fire for the buffered head while the seek
        // is still resolving.
        if (startOffset > 0 && Math.abs(el.currentTime - startOffset) > 1) return;
        done();
      };

      el.addEventListener("loadedmetadata", onMeta);
      el.addEventListener("canplay", onCanPlay);
      el.addEventListener("seeked", onSeeked);
      el.addEventListener("error", onErr);

      el.src = item.audio_url;
      el.load();
    });
  }

  /* ---------- transport ---------- */

  play() {
    if (this._released) return;
    // Rate has to be re-applied after a load: assigning src resets
    // playbackRate to 1 in most browsers, so the manager's restoreRate effect
    // (which fires before startPlayback) would otherwise be undone by the load.
    this.el.playbackRate = this._pendingRate;
    const p = this.el.play();
    if (p && typeof p.catch === "function") {
      p.catch((err) => {
        // NotAllowedError = autoplay policy: the first play must come from a
        // real gesture. Surface it as state, never as an unhandled rejection.
        this._emit(`play.rejected ${err?.name ?? err}`);
        if (this.onError) this.onError(`play rejected: ${err?.name ?? err}`);
      });
    }
  }

  pause() { if (!this._released) this.el.pause(); }

  seek(seconds, { precise = false } = {}) {
    if (this._released) return;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return;
    // `precise` comes from seek-policy.js (#30). The element seeks the same
    // way either way — the flag is carried so it can be logged, and so a
    // future backend that supports approximate/fast seeking can use it.
    this._emit(`seek ${Math.round(seconds)}s precise=${precise}`);
    try { this.el.currentTime = seconds; } catch (_) { /* not seekable yet */ }
  }

  setRate(rate) {
    const r = typeof rate === "number" && rate > 0 ? rate : 1.0;
    this._pendingRate = r;
    if (!this._released) this.el.playbackRate = r;
  }

  /** 0..1. Ducking for hold-to-talk uses this rather than a Web Audio gain
      node, because no `crossorigin` means Web Audio cannot see this element. */
  setVolume(v) {
    if (this._released) return;
    this.el.volume = Math.min(1, Math.max(0, Number(v) || 0));
  }

  get currentTime() { return this.el?.currentTime ?? 0; }

  get duration() {
    const d = this.el?.duration;
    return typeof d === "number" && Number.isFinite(d) ? d : null;
  }

  get currentItem() { return this._currentItem; }

  release() {
    if (this._released) return;
    this._released = true;
    this.el.removeEventListener("ended", this._onEnded);
    this.el.removeEventListener("error", this._onError);
    this.el.pause();
    this.el.removeAttribute("src");
    this.el.load(); // drop the buffer rather than leaving it decoding
    this._currentItem = null;
  }

  _emit(m) { if (this._telemetry) this._telemetry(m); }
}

function short(u) {
  if (!u) return "";
  return String(u).slice(0, 60);
}
