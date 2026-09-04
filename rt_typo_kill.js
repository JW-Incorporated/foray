const { run } = require("./rt_harness.js");

// Does a typo/unknown extra word wipe out an otherwise-strong 2-word match?
run("nuclear fusion");
run("nuclear fusion enrgy");
run("nuclear fusion podcast");   // "podcast" is stopword, should be stripped
run("nuclear fusion xyzzyplugh"); // nonsense third word
run("fusion");
run("fusions");                  // plural bug candidate
run("fusion energy");
run("fusion energies");
run("startup culture");
run("startup cultures");
