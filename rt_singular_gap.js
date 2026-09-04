const { run } = require("./rt_harness.js");

// Concepts that list ONLY the plural form as a term: does singular query
// fail to trigger concept expansion (hasConceptExpansion=false) even though
// plural works?
run("satellite");
run("satellites");
run("astronaut");
run("astronauts");
run("drone");
run("drones");
run("algorithm");
run("algorithms");
run("transistor");
run("transistors");
