const { run } = require("./rt_harness.js");

// Candidate thin-anchor-outvoted-by-broad-word queries, analogous to the
// fixed "Electrical Circuit Design Dummies" class but with different terms.
const queries = [
  "Beekeeping History Explained",
  "Origami Science Basics",
  "Taxidermy Comedy Special",
  "Blacksmithing Business Podcast",
  "Falconry Health Stories",
  "Cheese Making Science",
  "Calligraphy Art History",
  "Bonsai Business Talk",
  "Astrology Comedy Show",
  "Knitting Health Tips",
  "Whittling Startup Stories",
  "Beekeeping Design Talk",
  "Fermentation Science History",
  "Pottery Business Story",
  "Chess Comedy History",
];

for (const q of queries) run(q);
