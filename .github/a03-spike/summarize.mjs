// A-03 spike (throwaway): print the headline fields of audio-spike.json.
import fs from "node:fs";

const r = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const samples = Array.isArray(r.samples) ? r.samples : [];
console.log(JSON.stringify({
  flag: r.flag,
  play: r.played,
  advancedSec: r.advancedSec,
  wallSec: r.wallSec,
  currentTimeAdvances: r.currentTimeAdvances,
  last: samples[samples.length - 1] ?? null,
  mediaSessionStates: r.mediaSessionStates,
  ourFocusEntries: r.ourFocusEntries,
  focusStack: r.focusStack,
  ourPlayers: r.ourPlayers,
}, null, 2));
