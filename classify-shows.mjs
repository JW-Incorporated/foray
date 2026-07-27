import fs from 'fs';

const batchPath = 'data-local/classify-batch-fresh-2026-07-27-9b4e54b5.json';
const resultsPath = 'data-local/classify-results-fresh-2026-07-27-9b4e54b5.json';

const batch = JSON.parse(fs.readFileSync(batchPath, 'utf-8'));

const classifications = {
  "1716436908": {
    topics: [{ node: "philosophy/ideas", confidence: 0.85 }, { node: "science", confidence: 0.75 }],
    needs_review: false,
    rationale: "Italian podcast exploring humanity's future through science, philosophy, bioethics.",
    display_title: "Icaro",
    blurb: "Explores human existence amid technological change through expert conversations on science, philosophy, and bioethics."
  },
  "1721774790": {
    topics: [{ node: "news", confidence: 0.7 }, { node: "news/commentary", confidence: 0.65 }],
    needs_review: true,
    rationale: "Chinese commentary show covering entertainment, tech, policy with casual analysis.",
    display_title: "Old Wang's Here",
    blurb: "Chinese-language commentary on entertainment, technology, and current events."
  },
  "1731784296": {
    topics: [{ node: "personal-journals", confidence: 0.8 }, { node: "psychology", confidence: 0.65 }],
    needs_review: false,
    rationale: "Host Yang Tianzhen discusses life stories and personal growth with various guests.",
    display_title: "天真不天真",
    blurb: "Candid conversations with guests exploring personal growth, choices, and life changes."
  },
  "1731934092": {
    topics: [{ node: "education/courses", confidence: 0.75 }, { node: "business", confidence: 0.7 }],
    needs_review: false,
    rationale: "Stock trading technical analysis course teaching Chan Theory for trading systems.",
    display_title: "Chan Theory 108 Lessons",
    blurb: "Practical stock trading technical analysis course based on Chan Theory system."
  },
  "1732158444": {
    topics: [{ node: "education/self-improvement", confidence: 0.85 }, { node: "psychology", confidence: 0.7 }],
    needs_review: false,
    rationale: "Self-development coach Liv Merima shares strategies for personal growth and relationships.",
    display_title: "Busy Glowing Up",
    blurb: "Self-development strategies on relationships, energy management, and personal transformation."
  },
  "1734094890": {
    topics: [{ node: "personal-journals", confidence: 0.9 }, { node: "society", confidence: 0.6 }],
    needs_review: false,
    rationale: "Former NFL player Tim Green interviews guests using AI voice restoration tech.",
    display_title: "Nothing Left Unsaid",
    blurb: "Intimate conversations between Tim Green and guests about life, loss, and legacy."
  },
  "1734318570": {
    topics: [{ node: "psychology", confidence: 0.9 }, { node: "education", confidence: 0.75 }],
    needs_review: false,
    rationale: "UBC professor hosts research experts discussing psychotherapy, counseling, mental health.",
    display_title: "Psychotherapy and Applied Psychology",
    blurb: "In-depth discussions with research experts on psychotherapy, counseling practices, and mental health."
  },
  "1734495150": {
    topics: [{ node: "health/sexuality", confidence: 0.85 }, { node: "relationships", confidence: 0.8 }],
    needs_review: false,
    rationale: "Dr. Saida Désilets and Aaron Michael share insights on sensuality and relationship intimacy.",
    display_title: "Embodied Love Lounge",
    blurb: "Evidence-based guidance on intimacy, sensuality, and relationship skills twice monthly."
  },
  "1735146600": {
    topics: [{ node: "business/non-profit", confidence: 0.85 }, { node: "society", confidence: 0.8 }],
    needs_review: false,
    rationale: "Every Neighborhood Partnership explores urban ministry and community-building practices.",
    display_title: "What's Good In The Neighborhood",
    blurb: "Stories and practices of community leaders building change through faith, proximity, and service."
  },
  "1736221446": {
    topics: [{ node: "music", confidence: 0.8 }, { node: "health/mental", confidence: 0.75 }],
    needs_review: false,
    rationale: "SOMA Sound curates ambient music and nature soundscapes for relaxation and healing.",
    display_title: "Sleep & Relaxation Music to Calm the Nervous System",
    blurb: "Healing music and nature soundscapes designed to ease anxiety, insomnia, and chronic stress."
  },
  "1736746980": {
    topics: [{ node: "sports/baseball", confidence: 0.95 }],
    needs_review: false,
    rationale: "Boston Red Sox analysis and commentary from team of devoted fans and analysts.",
    display_title: "Section 10",
    blurb: "Fresh analysis and commentary on Boston Red Sox baseball all season long."
  },
  "1737442386": {
    topics: [{ node: "kids-family/parenting", confidence: 0.9 }, { node: "relationships", confidence: 0.65 }],
    needs_review: false,
    rationale: "Two new parents discuss parenting challenges, relationships, and trending topics.",
    display_title: "Two Parents & A Podcast",
    blurb: "Candid conversations between new parents about raising kids, relationships, and life balance."
  },
  "1738072194": {
    topics: [{ node: "business/non-profit", confidence: 0.8 }, { node: "society/law", confidence: 0.7 }],
    needs_review: false,
    rationale: "San Luis Obispo Diversity Coalition explores systemic racism and DEI practices.",
    display_title: "SLO Equity Podcast",
    blurb: "Stories and solutions for equity, diversity, and inclusion in San Luis Obispo County."
  },
  "1738121304": {
    topics: [{ node: "comedy", confidence: 0.9 }, { node: "tv-film", confidence: 0.65 }],
    needs_review: false,
    rationale: "The Lonely Island and Seth Meyers revisit iconic SNL Digital Shorts episodes.",
    display_title: "The Lonely Island and Seth Meyers Podcast",
    blurb: "Deep dives into SNL Digital Shorts with creators Andy Samberg, Akiva Schaffer, Jorma Taccone."
  },
  "1738650060": {
    topics: [{ node: "business/marketing", confidence: 0.9 }, { node: "education/how-to", confidence: 0.7 }],
    needs_review: false,
    rationale: "Shannon McKinstrie teaches practical social media content strategies and growth tactics.",
    display_title: "Good Content with Shannon McKinstrie",
    blurb: "Practical social media content strategies and growth hacks for building online presence."
  },
  "1739798946": {
    topics: [{ node: "gaming", confidence: 0.8 }, { node: "gaming/design", confidence: 0.75 }],
    needs_review: false,
    rationale: "Smosh ensemble casts improv-based D&D campaign with comedy and storytelling.",
    display_title: "Sword AF",
    blurb: "Comedy improv-based Dungeons & Dragons campaign starring Smosh cast members."
  },
  "1741589082": {
    topics: [{ node: "culture/fashion", confidence: 0.95 }],
    needs_review: false,
    rationale: "Lauren Sherman covers fashion industry news, M&A drama, and behind-scenes insights.",
    display_title: "Fashion People",
    blurb: "Industry insider coverage of fashion business, trends, and behind-the-scenes drama."
  },
  "1741770858": {
    topics: [{ node: "true-crime", confidence: 0.85 }, { node: "society/law", confidence: 0.75 }],
    needs_review: false,
    rationale: "48 Hours correspondent examines true crime cases involving family secrets and violence.",
    display_title: "Blood is Thicker",
    blurb: "True crime investigations of family murders with motives rooted in money and betrayal."
  },
  "1742220252": {
    topics: [{ node: "nature/earth-science", confidence: 0.85 }, { node: "business", confidence: 0.6 }],
    needs_review: false,
    rationale: "JM Fortier and Chris Moran interview sustainable agriculture and market gardening experts.",
    display_title: "The Market Gardener Podcast",
    blurb: "Conversations with organic farming leaders on regenerative agriculture and sustainable food systems."
  },
  "1742298222": {
    topics: [{ node: "tv-film", confidence: 0.75 }, { node: "news/commentary", confidence: 0.7 }],
    needs_review: false,
    rationale: "English-language Chinese entertainment and pop culture commentary with humor.",
    display_title: "What's Popping",
    blurb: "Chinese-English entertainment news and pop culture commentary with sharp analysis."
  },
  "1743709932": {
    topics: [{ node: "hobbies", confidence: 0.7 }, { node: "personal-journals", confidence: 0.65 }],
    needs_review: true,
    rationale: "PRCA radio host interviews professional rodeo athletes and behind-the-scenes figures.",
    display_title: "Sound Check 920 Rodeo",
    blurb: "Stories from professional rodeo community including athletes, announcers, and organizers."
  },
  "1743817782": {
    topics: [{ node: "religion/christianity", confidence: 0.85 }, { node: "society", confidence: 0.65 }],
    needs_review: false,
    rationale: "Evergreen Church Tulsa shares faith-based transformation stories from congregants.",
    display_title: "The Grove",
    blurb: "Real-life stories of faith, redemption, and transformation from Evergreen Church community."
  },
  "1744384134": {
    topics: [{ node: "sports/baseball", confidence: 0.95 }],
    needs_review: false,
    rationale: "Atlanta Braves in-season analysis and commentary from dedicated baseball journalists.",
    display_title: "Hammer Territory",
    blurb: "Detailed Atlanta Braves coverage and game analysis throughout the season."
  },
  "1745112120": {
    topics: [{ node: "fiction", confidence: 0.5 }],
    needs_review: true,
    rationale: "Fiction show; limited description data prevents confident classification.",
    display_title: "MSA",
    blurb: ""
  },
  "1745786646": {
    topics: [{ node: "paranormal", confidence: 0.65 }, { node: "news/commentary", confidence: 0.6 }],
    needs_review: true,
    rationale: "Host Paige Carter examines conspiracy theories; brief desc limits confidence.",
    display_title: "Conspiracy Files with Paige Carter",
    blurb: ""
  },
  "1747970256": {
    topics: [{ node: "comedy/interviews", confidence: 0.7 }, { node: "personal-journals", confidence: 0.6 }],
    needs_review: true,
    rationale: "Comedy interviews; minimal signal prevents confident multi-label classification.",
    display_title: "None of Your Business Podcast",
    blurb: ""
  },
  "1748507034": {
    topics: [{ node: "education/courses", confidence: 0.8 }, { node: "health", confidence: 0.75 }],
    needs_review: false,
    rationale: "Cardiology board exam review course for medical professionals.",
    display_title: "Hu Said: Cardiology Board Review Series",
    blurb: "Board review and cardiology education for medical professionals preparing for certification."
  },
  "1751241474": {
    topics: [{ node: "sports", confidence: 0.6 }],
    needs_review: true,
    rationale: "Sports-focused show; brief description limits topic specificity.",
    display_title: "All Out with Jon Dean",
    blurb: ""
  },
  "1752293730": {
    topics: [{ node: "sports/volleyball", confidence: 0.85 }, { node: "kids-family", confidence: 0.7 }],
    needs_review: false,
    rationale: "Junior club volleyball podcast by TNT covering youth sports and competition.",
    display_title: "Bump Set Mic",
    blurb: "Junior club volleyball coverage from TNT featuring youth athletes and competition."
  },
  "1752980028": {
    topics: [{ node: "hobbies", confidence: 0.5 }, { node: "personal-journals", confidence: 0.45 }],
    needs_review: true,
    rationale: "Minimal signal; insufficient description for confident classification.",
    display_title: "Free Castin'",
    blurb: ""
  },
  "1753141662": {
    topics: [{ node: "education", confidence: 0.5 }, { node: "business", confidence: 0.45 }],
    needs_review: true,
    rationale: "Registry-related show; brief description limits topic specificity.",
    display_title: "Registry Insider",
    blurb: ""
  },
  "1753725894": {
    topics: [{ node: "music", confidence: 0.6 }, { node: "hobbies", confidence: 0.5 }],
    needs_review: true,
    rationale: "Collaboration-focused; insufficient detail for confident classification.",
    display_title: "Collaborate & Listen",
    blurb: ""
  },
  "1754124558": {
    topics: [{ node: "gaming", confidence: 0.75 }, { node: "gaming/design", confidence: 0.65 }],
    needs_review: false,
    rationale: "Chess strategy and analysis for competitive players and enthusiasts.",
    display_title: "NextLevelChess",
    blurb: "Chess strategy, analysis, and competitive gameplay for dedicated chess players."
  },
  "1754424612": {
    topics: [{ node: "health/sexuality", confidence: 0.85 }, { node: "relationships", confidence: 0.8 }],
    needs_review: false,
    rationale: "Research-backed guide to sex and relationships with expert perspectives.",
    display_title: "Pleasure Project",
    blurb: "Evidence-based exploration of sexuality and relationship dynamics with experts."
  },
  "1754592060": {
    topics: [{ node: "personal-journals", confidence: 0.5 }],
    needs_review: true,
    rationale: "Limited description; cannot determine dominant topic with confidence.",
    display_title: "The Jefferson Fisher Podcast",
    blurb: ""
  },
  "1755126066": {
    topics: [{ node: "hobbies", confidence: 0.5 }, { node: "food", confidence: 0.45 }],
    needs_review: true,
    rationale: "Minimal signal; unclear content focus from available data.",
    display_title: "Serving Pancakes",
    blurb: ""
  },
  "1756793568": {
    topics: [{ node: "comedy", confidence: 0.75 }, { node: "personal-journals", confidence: 0.65 }],
    needs_review: false,
    rationale: "Comedy-focused interview show with Trinity the Tuck and Shontelle Sparkles.",
    display_title: "I Live for This",
    blurb: "Comedy interviews and personal stories with hosts Trinity the Tuck and Shontelle Sparkles."
  },
  "1760994588": {
    topics: [{ node: "health/mental", confidence: 0.75 }, { node: "psychology", confidence: 0.7 }],
    needs_review: false,
    rationale: "Support group discussions around sobriety and recovery.",
    display_title: "Sober Talk Live",
    blurb: "Live recovery and sobriety discussions building community support and accountability."
  },
  "1761265290": {
    topics: [{ node: "education/self-improvement", confidence: 0.8 }, { node: "kids-family/parenting", confidence: 0.75 }],
    needs_review: false,
    rationale: "Self-care and organization strategies for stay-at-home mothers.",
    display_title: "Habit Stacking Mom",
    blurb: "Routines, organization, and self-improvement strategies for busy parents."
  },
  "1762037892": {
    topics: [{ node: "health/sexuality", confidence: 0.75 }, { node: "relationships", confidence: 0.7 }],
    needs_review: false,
    rationale: "Southern community focused on non-traditional relationship lifestyles.",
    display_title: "Southern Swingers",
    blurb: "Open relationships and alternative lifestyle community from the American South."
  },
  "1762447440": {
    topics: [{ node: "psychology", confidence: 0.65 }, { node: "health/mental", confidence: 0.6 }],
    needs_review: true,
    rationale: "ADHD or neurodivergence focus; title suggests hyperfocus theme.",
    display_title: "Hyperfixed",
    blurb: ""
  },
  "1762689264": {
    topics: [{ node: "comedy", confidence: 0.5 }, { node: "personal-journals", confidence: 0.45 }],
    needs_review: true,
    rationale: "Minimal description limits confident classification.",
    display_title: "FriedEggs Podcast",
    blurb: ""
  },
  "1763113032": {
    topics: [{ node: "nature", confidence: 0.7 }, { node: "hobbies", confidence: 0.65 }],
    needs_review: false,
    rationale: "Gardening-focused podcast for women interested in plants and growing.",
    display_title: "Garden Girls Podcast",
    blurb: "Women's gardening podcast covering plant knowledge and gardening tips."
  },
  "1763641854": {
    topics: [{ node: "culture", confidence: 0.5 }, { node: "news/commentary", confidence: 0.45 }],
    needs_review: true,
    rationale: "Farsi-language podcast; title translates to 'Colorful' but lacks detailed signal.",
    display_title: "Ba Ziya Podcast",
    blurb: ""
  },
  "1765605600": {
    topics: [{ node: "hobbies", confidence: 0.6 }, { node: "education/how-to", confidence: 0.55 }],
    needs_review: true,
    rationale: "Problem-solving focus; limited detail prevents confident classification.",
    display_title: "We Fixed It, You're Welcome",
    blurb: ""
  },
  "1766302914": {
    topics: [{ node: "business/startups", confidence: 0.65 }, { node: "education", confidence: 0.6 }],
    needs_review: true,
    rationale: "Innovation lab focus; minimal description limits classification.",
    display_title: "Big Ideas Lab",
    blurb: ""
  },
  "1766669814": {
    topics: [{ node: "food/cooking-science", confidence: 0.65 }, { node: "culture", confidence: 0.55 }],
    needs_review: true,
    rationale: "Food-focused but limited detail on specific angle.",
    display_title: "Butter",
    blurb: ""
  },
  "1768118412": {
    topics: [{ node: "news", confidence: 0.5 }, { node: "education", confidence: 0.45 }],
    needs_review: true,
    rationale: "Title 'The Signal' generic; insufficient description.",
    display_title: "The Signal",
    blurb: ""
  },
  "1768289604": {
    topics: [{ node: "history", confidence: 0.75 }, { node: "religion/christianity", confidence: 0.7 }],
    needs_review: false,
    rationale: "Focuses on theologian Dietrich Bonhoeffer's life and ideas.",
    display_title: "The Rise of Bonhoeffer",
    blurb: "Historical exploration of theologian Dietrich Bonhoeffer's life, thought, and legacy."
  },
  "1768313154": {
    topics: [{ node: "comedy/casual-hangs", confidence: 0.7 }, { node: "news/commentary", confidence: 0.55 }],
    needs_review: false,
    rationale: "NYC radio morning show mixing entertainment and light commentary.",
    display_title: "Hollywood Hamilton & The KTU Morning Crew",
    blurb: "New York City radio morning show with entertainment, interviews, and comedy."
  },
  "1768893342": {
    topics: [{ node: "health/nutrition", confidence: 0.7 }, { node: "education/how-to", confidence: 0.65 }],
    needs_review: false,
    rationale: "Dermatology and skincare education from approved experts.",
    display_title: "Derm Approved",
    blurb: "Expert dermatology advice and skincare guidance from licensed professionals."
  },
  "1769701746": {
    topics: [{ node: "health/nutrition", confidence: 0.65 }, { node: "culture", confidence: 0.6 }],
    needs_review: true,
    rationale: "Wellness brand focus; unclear on primary topic.",
    display_title: "GlowLab with Susan Yara",
    blurb: ""
  },
  "1770745380": {
    topics: [{ node: "personal-journals", confidence: 0.7 }, { node: "society", confidence: 0.6 }],
    needs_review: false,
    rationale: "Interview podcast featuring stranger conversations on benches.",
    display_title: "Strangers on a Bench",
    blurb: "In-depth conversations with strangers about life, experiences, and perspectives."
  },
  "1771757364": {
    topics: [{ node: "news", confidence: 0.5 }, { node: "education", confidence: 0.45 }],
    needs_review: true,
    rationale: "Generic title; minimal descriptive signal.",
    display_title: "The Signal Sitdown",
    blurb: ""
  }
};

const results = {
  batch_id: batch.batch_id,
  results: {}
};

batch.shows.forEach(show => {
  const collectionId = String(show.apple_collection_id);
  const classification = classifications[collectionId];

  if (classification) {
    results.results[collectionId] = {
      topics: classification.topics,
      needs_review: classification.needs_review,
      rationale: classification.rationale,
      display_title: classification.display_title,
      blurb: classification.blurb,
      model: "claude-code-cron (tier 1)"
    };
  }
});

fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
console.log(`Classification complete: ${Object.keys(results.results).length} shows classified`);
console.log(`Results written to ${resultsPath}`);
