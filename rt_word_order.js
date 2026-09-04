const { run } = require("./rt_harness.js");

// Word order sensitivity: OR-semantics scorer should be largely order-
// insensitive by design (bag of tokens) -- verify that holds, and check
// whether swapping emphasis (which noun leads) changes top result meaningfully
// even though it "shouldn't" matter under bag-of-words. This documents
// current (by-design) behavior rather than necessarily a bug.
run("startup founders");
run("founders startup");
run("nuclear energy fusion");
run("energy fusion nuclear");
run("crime junkie");
run("junkie crime");
