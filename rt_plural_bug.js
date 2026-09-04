const { run } = require("./rt_harness.js");

// Bare plural queries for concept terms whose plural isn't itself listed
// as a concept-vocabulary term (singular works, plural silently thin-fails)
run("energy");
run("energies");
run("fusion");
run("fusions");
run("culture");
run("cultures");
run("reactor");
run("reactors");
run("founder");
run("founders");     // "founders" IS in vocab per dump above
run("entrepreneur");
run("entrepreneurs"); // IS in vocab
