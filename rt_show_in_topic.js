const { run } = require("./rt_harness.js");

// Show-name-shaped queries typed into the TOPIC box (buildPlaylist/interpretQuery path)
run("Lex Fridman Podcast");
run("Huberman Lab");
run("Crime Junkie");
run("The Daily");        // stopword-collision show name from show-pages-plan.md example
run("On Being");         // "on" is a stopword
run("Radiolab");
run("SmartLess");
run("smartless");
