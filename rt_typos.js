const { run } = require("./rt_harness.js");

// typos / plural / singular robustness
run("nuclear fusion energy");     // baseline known-good per comments
run("nuclear fusion enrgy");      // typo in broad word
run("nuclear fusoin energy");     // typo in specific word
run("fusions");                   // plural of a concept term
run("startup");
run("startups");                  // plural form
run("start up");                  // split compound
run("beekeepers");                // plural of thin word variant
run("ornithologist");             // different inflection of ornithology-ish word
run("bee keeping");                // split compound of thin word
