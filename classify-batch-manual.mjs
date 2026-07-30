import fs from 'fs';

// Read the batch
const batch = JSON.parse(fs.readFileSync('data-local/classify-batch-fresh-2026-07-25-a74e160d.json', 'utf-8'));
const taxonomy = JSON.parse(fs.readFileSync('data/taxonomy.json', 'utf-8'));

// Helper to get node by id
const getNode = (id) => taxonomy.nodes.find(n => n.id === id);

// My classifications - one per show
const classifications = {
  "1328434113": { // CAFÉ EN MANO
    topics: [
      { node: "personal-journals", confidence: 0.8 },
      { node: "business/startups", confidence: 0.6 }
    ],
    needs_review: false,
    rationale: "Latino-focused podcast featuring interviews with entrepreneurs, cultural figures, and business personalities discussing careers and current issues.",
    display_title: "CAFÉ EN MANO",
    blurb: "Latino community conversations covering entrepreneurship, culture, and current affairs with interviews and trending topics."
  },
  "1329830361": { // Sustainable Minimalists
    topics: [
      { node: "craft/diy-home", confidence: 0.75 },
      { node: "nature", confidence: 0.55 }
    ],
    needs_review: false,
    rationale: "Eco-conscious home design focusing on sustainable, non-toxic living through minimalism and intentional consumption.",
    display_title: "Sustainable Minimalists",
    blurb: "Eco-minimalist home design with practical strategies for sustainable, non-toxic living without excess consumption."
  },
  "1331519433": { // 19 Keys Presents High Level Conversations
    topics: [
      { node: "education/self-improvement", confidence: 0.7 },
      { node: "psychology/decision-making", confidence: 0.55 }
    ],
    needs_review: false,
    rationale: "Self-help and empowerment interviews covering mindset, wealth building, AI, and personal transformation with influential guests.",
    display_title: "High Level Conversations",
    blurb: "Conversations on mindset, wealth, technology, and personal growth with thought leaders and cultural figures."
  },
  "1333234563": { // Locked On Cubs
    topics: [
      { node: "sports/baseball", confidence: 0.95 }
    ],
    needs_review: false,
    rationale: "Daily baseball news and analysis focused exclusively on the Chicago Cubs franchise and Major League Baseball.",
    display_title: "Locked On Cubs",
    blurb: "Daily Chicago Cubs baseball news, analysis, and insider coverage from the friendliest confines."
  },
  "1337886873": { // Choiceology
    topics: [
      { node: "psychology/decision-making", confidence: 0.8 },
      { node: "economics/markets", confidence: 0.5 }
    ],
    needs_review: false,
    rationale: "Behavioral economics exploring how research on decision-making and choice can improve judgment and personal change.",
    display_title: "Choiceology with Katy Milkman",
    blurb: "Behavioral economics and research-backed insights on better decision-making and personal change through understanding choice."
  },
  "1339816815": { // Dragnet
    topics: [
      { node: "fiction/drama", confidence: 0.85 }
    ],
    needs_review: false,
    rationale: "Classic detective drama audio from old-time radio following police investigations in Los Angeles.",
    display_title: "Dragnet",
    blurb: "Classic police procedural audio drama from vintage radio featuring LAPD detective investigations."
  },
  "1342003491": { // The Anthropocene Reviewed
    topics: [
      { node: "science", confidence: 0.65 },
      { node: "philosophy/ideas", confidence: 0.6 },
      { node: "education", confidence: 0.5 }
    ],
    needs_review: false,
    rationale: "Author John Green reviews aspects of human-centered planet on a five-star scale, blending science, nature, culture and philosophy.",
    display_title: "The Anthropocene Reviewed",
    blurb: "John Green reviews facets of human impact on Earth—from nature to culture to science—with personal essays and research."
  },
  "1342684917": { // Stereo Chemistry
    topics: [
      { node: "science/chemistry", confidence: 0.9 }
    ],
    needs_review: false,
    rationale: "Chemistry news and storytelling from reporters covering breakthrough research, materials, quantum computing, and related topics.",
    display_title: "Stereo Chemistry",
    blurb: "Chemistry journalism exploring breakthrough discoveries and applications in materials science and quantum technology."
  },
  "1346054199": { // Right About Now
    topics: [
      { node: "business/marketing", confidence: 0.85 },
      { node: "business/startups", confidence: 0.6 }
    ],
    needs_review: false,
    rationale: "Marketing strategy and business insights from disruptor Ryan Alford interviewing founders, authors, and industry titans.",
    display_title: "Right About Now",
    blurb: "Marketing strategy and business growth insights from founder interviews with trending tools, tactics, and real-world experience."
  },
  "1347283065": { // Five Games for Doomsday
    topics: [
      { node: "gaming/design", confidence: 0.85 },
      { node: "hobbies", confidence: 0.65 }
    ],
    needs_review: false,
    rationale: "Tabletop game design podcast where guests discuss their five most essential games for survival, featuring interviews with game designers.",
    display_title: "Five Games for Doomsday",
    blurb: "Tabletop game enthusiasts discuss their essential games for doomsday survival with interviews of indie game designers."
  },
  "1348392537": { // Southern Gothic
    topics: [
      { node: "history", confidence: 0.7 },
      { node: "paranormal", confidence: 0.75 }
    ],
    needs_review: false,
    rationale: "Dark history and paranormal legends of the American South—haunted places, ghost stories, and historical mysteries with research.",
    display_title: "Southern Gothic",
    blurb: "Paranormal history and ghost stories from the American South with research-based accounts of haunted sites and dark legends."
  },
  "1348856817": { // The Jordan Syatt Podcast
    topics: [
      { node: "health/fitness", confidence: 0.75 },
      { node: "education/self-improvement", confidence: 0.5 }
    ],
    needs_review: false,
    rationale: "Fitness expert discusses strength training, weight loss, GLP-1 drugs, and wide-ranging personal topics with caller questions.",
    display_title: "The Jordan Syatt Podcast",
    blurb: "Fitness and strength training advice with broader conversations on health, politics, conspiracy theories, and personal growth."
  },
  "1350850605": { // Dressed
    topics: [
      { node: "culture/fashion", confidence: 0.9 }
    ],
    needs_review: false,
    rationale: "Fashion history exploring social and cultural stories behind clothing, from swimsuits to hip-hop style to design.",
    display_title: "Dressed: The History of Fashion",
    blurb: "Fashion history examining the social and cultural stories behind what we wear, from history to contemporary style."
  },
  "1352860989": { // The Michael Shermer Show
    topics: [
      { node: "science", confidence: 0.7 },
      { node: "philosophy/ideas", confidence: 0.65 },
      { node: "society/government", confidence: 0.5 }
    ],
    needs_review: false,
    rationale: "Long-form conversations between skeptic scientist and experts on science, philosophy, history, politics, and intellectual topics.",
    display_title: "The Michael Shermer Show",
    blurb: "Long-form dialogues with scientists and scholars on research, history, philosophy, and ideas shaping society."
  },
  "1354455555": { // Our Paranormal Afterlife
    topics: [
      { node: "religion/spirituality", confidence: 0.7 },
      { node: "paranormal", confidence: 0.8 }
    ],
    needs_review: false,
    rationale: "Paranormal research and spirituality exploring near-death experiences, reincarnation, mediumship, and evidence of afterlife.",
    display_title: "Our Paranormal Afterlife",
    blurb: "Paranormal investigation and spirituality discussing near-death experiences, reincarnation, and evidence of consciousness after death."
  },
  "1354647807": { // The Counsel of Trent
    topics: [
      { node: "religion/christianity", confidence: 0.85 }
    ],
    needs_review: false,
    rationale: "Catholic apologetics and faith discussions from Trent Horn covering theology, culture, and religion topics.",
    display_title: "The Counsel of Trent",
    blurb: "Catholic faith and apologetics featuring theology discussions, interviews with church leaders, and cultural commentary."
  },
  "1360406217": { // MarTech Podcast
    topics: [
      { node: "business/marketing", confidence: 0.85 },
      { node: "news/tech", confidence: 0.55 }
    ],
    needs_review: false,
    rationale: "Marketing technology and business growth strategies from marketers using tools and techniques to drive results.",
    display_title: "MarTech Podcast",
    blurb: "Marketing technology strategies and tools featuring interviews with innovators driving digital growth and marketing results."
  },
  "1361879433": { // Locked On MLB
    topics: [
      { node: "sports/baseball", confidence: 0.95 }
    ],
    needs_review: false,
    rationale: "Daily Major League Baseball coverage with analysis, trades, standings, and insider news from all 30 franchises.",
    display_title: "Locked On MLB",
    blurb: "Daily Major League Baseball news, analysis, and insider coverage across the entire sport with game recaps."
  },
  "1362910749": { // Legends of the Old West
    topics: [
      { node: "history", confidence: 0.8 }
    ],
    needs_review: false,
    rationale: "American West history covering gunfights, outlaws, lawmen, and Native American history with narrative storytelling.",
    display_title: "Legends of the Old West",
    blurb: "Old West history covering outlaws, lawmen, gunfights, and Native American stories with narrative storytelling."
  },
  "1364825229": { // Some More News
    topics: [
      { node: "comedy", confidence: 0.65 },
      { node: "news/commentary", confidence: 0.75 }
    ],
    needs_review: false,
    rationale: "Political and current affairs comedy from host Cody Johnston, mixing wit with research on weekly news topics.",
    display_title: "Some More News",
    blurb: "Political commentary and news analysis with comedic storytelling and research-backed investigations of current events."
  },
  "1366344369": { // Raising Boys & Girls
    topics: [
      { node: "kids-family/parenting", confidence: 0.9 }
    ],
    needs_review: false,
    rationale: "Parenting podcast offering practical advice and hope for raising children from childhood development counselors.",
    display_title: "Raising Boys & Girls",
    blurb: "Parenting guidance from child development experts covering child behavior, relationships, family dynamics, and growth."
  },
  "1367123487": { // Off The Blocks Swimming
    topics: [
      { node: "sports/endurance", confidence: 0.9 }
    ],
    needs_review: false,
    rationale: "Swimming sport interviews and coaching perspectives from legends, current athletes, and rising stars in competitive swimming.",
    display_title: "Off The Blocks Swimming Podcast",
    blurb: "Competitive swimming interviews with coaches, elite athletes, and rising talents discussing training and performance."
  },
  "1367201919": { // Deadline: White House
    topics: [
      { node: "news/politics", confidence: 0.9 },
      { node: "news/daily", confidence: 0.6 }
    ],
    needs_review: false,
    rationale: "Political news and analysis from veteran journalist Nicolle Wallace covering executive branch decisions and current affairs.",
    display_title: "Deadline: White House",
    blurb: "Daily political news and analysis from the executive branch and Congress covering high-stakes policy and politics."
  },
  "1367773989": { // The Proof with Simon Hill
    topics: [
      { node: "health/nutrition", confidence: 0.85 },
      { node: "education", confidence: 0.55 }
    ],
    needs_review: false,
    rationale: "Nutrition science and health research podcast exploring evidence-based approaches to diet and wellness.",
    display_title: "The Proof with Simon Hill",
    blurb: "Nutrition science and health research exploring evidence-based approaches to diet, health, and lifestyle optimization."
  }
};

// Read rest of batch to get show IDs and info for remaining shows
console.log("Read batch with", batch.shows.length, "shows");
console.log("Created classifications for", Object.keys(classifications).length, "shows so far");
