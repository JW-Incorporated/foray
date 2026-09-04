const { summarize } = require("./_rt_lib.js");
// filters / duration parsing edge cases
summarize("dur1", "short episodes about space");
summarize("dur2", "something under 20 minutes about cooking");
summarize("dur3", "long episode about ai safety");
summarize("dur-only", "short");
summarize("dur-none-topic", "cheese under 5 minutes"); // thin anchor + duration filter relax path
summarize("neg1", "not about politics");
summarize("neg2", "anything but comedy");
