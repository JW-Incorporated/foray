const { summarize, run } = require("./_rt_lib.js");

// Area 2: word order / emphasis
summarize("order1a", "startup failure stories");
summarize("order1b", "failure startup stories");
summarize("order2a", "dog training tips");
summarize("order2b", "training dog tips");

// Area 3: typos / partial / plural-singular
summarize("typo1", "philosphy"); // missing o
summarize("typo2", "philosophy");
summarize("typo3", "econimics");
summarize("typo4", "economics");
summarize("plural1", "startup");
summarize("plural2", "startups");
summarize("plural3", "economy");
summarize("plural4", "economies");
summarize("partial1", "podcas"); // partial word
summarize("partial2", "histor");

// Area 4: obscure valid topic -> honest emptiness check
summarize("obscure1", "gregorian chant");
summarize("obscure2", "lichen ecology");
summarize("obscure3", "byzantine iconography");
summarize("obscure4", "octopus cognition");
