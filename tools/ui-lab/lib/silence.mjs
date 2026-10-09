/* Every Playwright page the redesign tooling renders speaks at volume zero.
 * The app narrates with the Web Speech API (mobile/plugins/foray-tts/web/foray-tts.js,
 * player/tts-bridge.js -> speechSynthesis.speak). On Windows, Chromium speaks through
 * the OS SAPI voice, which Playwright's default --mute-audio does NOT silence, so an
 * automated render was audible on the owner's PC. The real speak() is still called, so
 * onstart/onend/boundary fire and the narration state machine behaves as before.
 * Used inside init-script template strings (walk.mjs initScript, gates/measure.mjs). */
export const SILENCE_SPEECH = `try {
    const ss = window.speechSynthesis;
    if (ss && typeof ss.speak === 'function') {
      const real = ss.speak.bind(ss);
      ss.speak = (u) => { try { u.volume = 0; } catch (_) {} return real(u); };
    }
  } catch (e) { /* no speech API */ }`;
