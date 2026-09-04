const { summarize } = require("./_rt_lib.js");
// Area 5: show names typed into topic box
summarize("showname1", "lex fridman");
summarize("showname2", "huberman lab");
summarize("showname3", "planet money");
summarize("showname4", "the daily");
summarize("showname5", "smartless");
// ambiguous common word tests
summarize("amb1", "matrix");
summarize("amb2", "python");
summarize("amb3", "mercury");
summarize("amb4", "apple");
summarize("amb5", "energy");
