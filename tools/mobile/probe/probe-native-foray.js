/* The committed 3-segment local-file Foray the NATIVE probe plays (card NE-36).
 *
 * Raw authored items, exactly the shape a curated Foray carries (`type:
 * "segment"`, `start_sec`/`end_sec`, an inline `audio_url` so no catalogue is
 * needed), built by the REAL `buildForayQueue` in the page and handed to the
 * engine with `engineSend playForay`. The files are the generated tones
 * `install-probe.mjs` writes next to this module; the base is the installed
 * bundle's `file:///…/public/` (see `--audio-base`), because the engine's
 * AVPlayer opens the file itself and a `capacitor://` URL means nothing to it.
 *
 * THE LENGTHS ARE THE WORKFLOW'S TIMELINE, not decoration
 * (ios-build.yml, "Run the native-engine probe"): the Foray starts about 5 s after launch, the app
 * is backgrounded at 15 s, the WebContent process is killed at about 140 s and the
 * app comes back at about 148 s. So:
 *   - both seams (about 55 s and 106 s in) fall inside the hidden window;
 *   - the kill lands in segment 3, mid-Foray, not after it;
 *   - the Foray is still running (it ends about 196 s in) when the restarted page
 *     pauses it for the reload clobber check.
 * Segment 3 goes back to file A at a new in-point (55 s): a third file of 90 s
 * would cost a fourth tone in a bundle every phase ships, and the seam is the
 * engine's either way (a fresh AVPlayerItem at a new in-point).
 * `install-probe.test.mjs` pins every `end_sec` inside its tone.
 */

export const PROBE_FORAY_ID = "probe-native-foray";

/** Seconds of each segment, in order, for the tests and the page's record. */
export const PROBE_FORAY_SEGMENTS = [
  { item_id: "probe-native-a", file: "probe-tone.wav", start_sec: 0, end_sec: 50 },
  { item_id: "probe-native-b", file: "probe-tone-b.wav", start_sec: 0, end_sec: 50 },
  { item_id: "probe-native-c", file: "probe-tone.wav", start_sec: 55, end_sec: 145 },
];

/** The authored Foray, with every file resolved against `audioBase`. */
export function probeForay(audioBase) {
  return {
    id: PROBE_FORAY_ID,
    title: "Native engine probe",
    items: PROBE_FORAY_SEGMENTS.map((s, i) => ({
      type: "segment",
      item_id: s.item_id,
      audio_url: audioBase + s.file,
      start_sec: s.start_sec,
      end_sec: s.end_sec,
      title: `Probe segment ${i + 1}`,
      show: "Foray probe",
    })),
  };
}

/** The fallback when this binary does not advertise `foray` yet (the M2 flip,
 *  NE-37, turns it on): one episode on file A, so the lane, Now Playing, the
 *  WebContent kill and the reload clobber check still run. The seam assertion
 *  then reads `no-coverage`, never a pass. */
export function probeEpisode(audioBase) {
  return {
    item: {
      id: "probe-native-episode", kind: "episode", audio_url: audioBase + "probe-tone.wav",
      title: "Probe episode", show: "Foray probe", duration_sec: 150,
    },
    startSec: 0,
    lastEpisodeRow: { id: "probe-native-episode", title: "Probe episode" },
  };
}
