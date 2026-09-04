const { summarize, run } = require("./_rt_lib.js");

// Hunt: specific term with df just ABOVE THIN_ANCHOR_DF (0.002) so not
// classified "thin" but still narrow -> can it get outvoted by broad co-word
// under OR semantics and return garbage dominated by the broad word?
const candidates = [
  "beekeeping design",
  "dog design",
  "surfboard design",
  "falconry design",
  "taxidermy design",
  "welding design",
  "knitting design",
  "calligraphy design",
  "mercury design",
  "python design",
  "matrix design",
];
for (const q of candidates) summarize("outvote-hunt", q);
