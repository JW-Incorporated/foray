import fs from 'fs';

const batchFile = 'data-local/classify-batch-fresh-2026-07-29-930a283f.json';
const resultsFile = 'data-local/classify-results-fresh-2026-07-29-930a283f.json';

const batch = JSON.parse(fs.readFileSync(batchFile, 'utf-8'));
const taxonomy = JSON.parse(fs.readFileSync('data/taxonomy.json', 'utf-8'));

const results = {
  batch_id: batch.batch_id,
  results: {}
};

// Classification function - returns { topics, needs_review, rationale, display_title, blurb, model }
function classify(show) {
  const { title, description, episodes, tier0_prior, apple_genre } = show;

  const id = show.apple_collection_id;

  const classifications = {
    1206119204: {
      topics: [{ node: "economics/markets", confidence: 0.95 }, { node: "business", confidence: 0.85 }],
      needs_review: false,
      rationale: "Professional investment strategies and market analysis from institutional portfolio managers.",
      display_title: "Capital Ideas Podcast",
      blurb: "Investment insights from Capital Group's portfolio managers covering markets, economics, and strategies."
    },
    1209851600: {
      topics: [{ node: "space", confidence: 0.95 }, { node: "science", confidence: 0.85 }],
      needs_review: false,
      rationale: "Astronomy education and interviews with astrophysicists on celestial phenomena.",
      display_title: "The Urban Astronomer Podcast",
      blurb: "Astronomy education and expert interviews explaining how we observe and understand the universe."
    },
    1210481852: {
      topics: [{ node: "sports/fantasy", confidence: 0.95 }],
      needs_review: false,
      rationale: "Dynasty fantasy football strategy, rankings, and roster analysis.",
      display_title: "The FF Dynasty",
      blurb: "Dynasty fantasy football strategy, rankings, and trade analysis for competitive players."
    },
    1210505372: {
      topics: [{ node: "sports/rugby", confidence: 0.95 }],
      needs_review: false,
      rationale: "Rugby league analysis and bold commentary on professional teams and players.",
      display_title: "Six Tackles With Gus",
      blurb: "Rugby league commentary and insider analysis from former player Phil Gould."
    },
    1210879676: {
      topics: [{ node: "medicine", confidence: 0.95 }, { node: "health", confidence: 0.9 }],
      needs_review: false,
      rationale: "Emergency medicine education from working ER physicians covering current cases and procedures.",
      display_title: "Emergency Medical Minute",
      blurb: "Real emergency department medicine: educational insights from working ER physicians."
    },
    1211894042: {
      topics: [{ node: "religion/islam", confidence: 0.95 }],
      needs_review: false,
      rationale: "Islamic lectures and theological discussions on faith and spirituality.",
      display_title: "Yaqeen Podcast",
      blurb: "Islamic scholarship and spiritual discussions from Yaqeen Institute for Islamic Research."
    },
    1212071900: {
      topics: [{ node: "sports/football", confidence: 0.95 }, { node: "culture/pop-culture", confidence: 0.6 }],
      needs_review: false,
      rationale: "Daily sports talk show focusing on professional football and general sports culture.",
      display_title: "Covino & Rich",
      blurb: "Daily sports commentary covering professional football, culture, and lifestyle topics."
    },
    1212814934: {
      topics: [{ node: "music", confidence: 0.85 }, { node: "culture", confidence: 0.75 }],
      needs_review: false,
      rationale: "Music artist interviews combined with exploration of craft beverages and culture.",
      display_title: "BREWtally Speaking Podcast",
      blurb: "Conversations with musicians and creators, blending music culture with beverage culture."
    },
    1215365810: {
      topics: [{ node: "sports/football", confidence: 0.95 }],
      needs_review: false,
      rationale: "Florida State football news, recruiting analysis, and team coverage.",
      display_title: "On The Bench: FSU Football",
      blurb: "Florida State football news, recruiting updates, and in-depth team analysis."
    },
    1215420422: {
      topics: [{ node: "religion/christianity", confidence: 0.95 }, { node: "education", confidence: 0.7 }],
      needs_review: false,
      rationale: "Scholarly biblical interpretation and theology discussions for modern audiences.",
      display_title: "The Bible For Normal People",
      blurb: "Accessible biblical scholarship exploring how the Bible developed and what it means."
    },
    1217040140: {
      topics: [{ node: "education/language-learning", confidence: 0.95 }, { node: "travel", confidence: 0.7 }],
      needs_review: false,
      rationale: "Practical Italian language lessons designed for travelers and learners.",
      display_title: "Learn Italian with Joy",
      blurb: "Bite-sized Italian lessons and phrases for travelers and language learners."
    },
    1217923682: {
      topics: [{ node: "true-crime", confidence: 0.9 }, { node: "society", confidence: 0.8 }],
      needs_review: false,
      rationale: "True crime and trauma narratives from law enforcement and first responders.",
      display_title: "Law Enforcement Talk",
      blurb: "Crime investigations and personal stories from law enforcement and first responders."
    },
    1218431966: {
      topics: [{ node: "medicine", confidence: 0.85 }, { node: "health", confidence: 0.8 }, { node: "comedy", confidence: 0.6 }],
      needs_review: false,
      rationale: "Medical education and health commentary from a practicing emergency physician with humor.",
      display_title: "The ZDoggMD Show",
      blurb: "Medical commentary and health discussions blended with humor from ER physician host."
    },
    1220571848: {
      topics: [{ node: "kids-family", confidence: 0.9 }, { node: "kids-family/education", confidence: 0.95 }],
      needs_review: false,
      rationale: "Homeschooling advice and family life discussions for large families.",
      display_title: "Raising Arrows",
      blurb: "Homeschooling strategies and encouragement for parents raising large families."
    },
    1223764016: {
      topics: [{ node: "economics/markets", confidence: 0.95 }, { node: "business", confidence: 0.9 }],
      needs_review: false,
      rationale: "Institutional investment perspectives and hedge fund strategy from capital allocators.",
      display_title: "Capital Allocators",
      blurb: "Insights into institutional investing strategies and portfolio management decisions."
    },
    1223772536: {
      topics: [{ node: "health/nutrition", confidence: 0.95 }, { node: "medicine", confidence: 0.8 }],
      needs_review: false,
      rationale: "Celiac disease education and gluten-free living advice from medical perspective.",
      display_title: "Celiac Straight Talk",
      blurb: "Celiac disease information and gluten-free living guidance from health professionals."
    },
    1223774438: {
      topics: [{ node: "culture/pop-culture", confidence: 0.9 }, { node: "fiction", confidence: 0.9 }],
      needs_review: false,
      rationale: "Deep analysis of X-Men comics exploring characters, storytelling, and cultural impact.",
      display_title: "Battle Of The Atom",
      blurb: "In-depth analysis of X-Men comics, characters, and storylines for fans and newcomers."
    },
    1223782070: {
      topics: [{ node: "aviation", confidence: 0.95 }, { node: "hobbies", confidence: 0.7 }],
      needs_review: false,
      rationale: "General aviation news, pilot experiences, and safety discussions for aviation enthusiasts.",
      display_title: "Aviation News Talk",
      blurb: "Aviation news, pilot stories, and safety discussions for general aviation enthusiasts."
    },
    1223826362: {
      topics: [{ node: "culture", confidence: 0.8 }, { node: "comedy", confidence: 0.85 }, { node: "relationships", confidence: 0.7 }],
      needs_review: false,
      rationale: "LGBTQ+ comedy and culture discussions breaking stereotypes with irreverent humor.",
      display_title: "Gayish Podcast",
      blurb: "Comedy and conversation exploring LGBTQ+ culture and identity with wit and honesty."
    },
    1224121640: {
      topics: [{ node: "philosophy/ideas", confidence: 0.85 }, { node: "education", confidence: 0.8 }],
      needs_review: false,
      rationale: "Political theory and philosophy analysis reviewing contemporary political frameworks.",
      display_title: "The Political Theory Review",
      blurb: "Analysis of political theory and philosophy shaping contemporary policy discussions."
    },
    1224204194: {
      topics: [{ node: "science", confidence: 0.9 }, { node: "space", confidence: 0.85 }, { node: "engineering", confidence: 0.75 }],
      needs_review: false,
      rationale: "Long-term human future through space exploration and advanced technology speculation.",
      display_title: "Science & Futurism",
      blurb: "Space colonization, advanced technology, and speculative futures grounded in real science."
    },
    1224965828: {
      topics: [{ node: "sports/fantasy", confidence: 0.95 }],
      needs_review: false,
      rationale: "Fantasy football strategy focused on late-round draft picks and overlooked players.",
      display_title: "The Late-Round Fantasy Football",
      blurb: "Fantasy football strategy and analysis focused on finding late-round draft value."
    },
    1225096382: {
      topics: [{ node: "medicine", confidence: 0.85 }, { node: "health", confidence: 0.85 }, { node: "comedy", confidence: 0.65 }],
      needs_review: false,
      rationale: "Medical and health topics explained through humor by a practicing gastroenterologist.",
      display_title: "The House of Pod",
      blurb: "Medical topics and health discussions from a doctor's perspective with comedic flair."
    },
    1226660198: {
      topics: [{ node: "health", confidence: 0.85 }, { node: "health/fitness", confidence: 0.9 }, { node: "science", confidence: 0.7 }],
      needs_review: false,
      rationale: "Biohacking and energy optimization through sleep, nutrition, and performance science.",
      display_title: "The Energy Blueprint Podcast",
      blurb: "Optimization strategies for sleep, energy levels, and physical performance."
    },
    1226904668: {
      topics: [{ node: "business", confidence: 0.85 }, { node: "business/startups", confidence: 0.85 }, { node: "engineering", confidence: 0.7 }],
      needs_review: false,
      rationale: "Product development and commercialization from research stage to market launch.",
      display_title: "Proof to Product",
      blurb: "Taking innovations from lab research to commercial products and market applications."
    },
    1227313058: {
      topics: [{ node: "religion/buddhism", confidence: 0.95 }, { node: "religion/spirituality", confidence: 0.9 }],
      needs_review: false,
      rationale: "Buddhist dharma teachings and meditation talks from Columbus Karma Thegsum Choling.",
      display_title: "Dharma Talks at Columbus KTC",
      blurb: "Buddhist teachings and guided meditation talks exploring dharma practice and wisdom."
    },
    1227316154: {
      topics: [{ node: "travel", confidence: 0.9 }, { node: "culture", confidence: 0.85 }, { node: "history", confidence: 0.75 }],
      needs_review: false,
      rationale: "Paris culture, history, and travel tips for visitors and lovers of French culture.",
      display_title: "The Earful Tower: Paris",
      blurb: "Paris travel, culture, and history for visitors and Francophiles seeking deeper insights."
    },
    1227699368: {
      topics: [{ node: "sports/soccer", confidence: 0.95 }],
      needs_review: false,
      rationale: "Soccer tactical analysis, historical context, and geopolitical football discussion.",
      display_title: "Tifo Football Podcast",
      blurb: "Deep tactical and historical breakdown of soccer's strategy, culture, and context."
    },
    1228587782: {
      topics: [{ node: "sports/tennis", confidence: 0.95 }],
      needs_review: false,
      rationale: "Professional tennis news, match analysis, and insider commentary from ATP tour.",
      display_title: "The ATP Tennis Radio Podcast",
      blurb: "Professional tennis news, match analysis, and insider stories from the ATP tour."
    },
    1228753412: {
      topics: [{ node: "food", confidence: 0.85 }, { node: "nature", confidence: 0.8 }],
      needs_review: false,
      rationale: "Sustainable agricultural practices and rural farming strategies for modern farmers.",
      display_title: "AcresUSA: Tractor Time",
      blurb: "Sustainable and regenerative agriculture practices for family farms and rural communities."
    },
    1231126178: {
      topics: [{ node: "kids-family", confidence: 0.95 }, { node: "kids-family/parenting", confidence: 0.95 }],
      needs_review: false,
      rationale: "Parenting advice and strategies for talking to children about difficult life topics.",
      display_title: "How To Talk To Kids About Anything",
      blurb: "Practical parenting advice for talking to children about tough topics and emotions."
    },
    1232009882: {
      topics: [{ node: "true-crime", confidence: 0.95 }, { node: "culture/pop-culture", confidence: 0.6 }],
      needs_review: false,
      rationale: "True crime podcast with entertainment focus and pop culture analysis of crime cases.",
      display_title: "True Crime Obsessed",
      blurb: "True crime stories and analysis blended with pop culture commentary and humor."
    },
    1233212546: {
      topics: [{ node: "health/alternative", confidence: 0.8 }, { node: "health", confidence: 0.8 }],
      needs_review: true,
      rationale: "Homeopathic health approaches and natural remedies, primarily aimed at parents.",
      display_title: "Joette Calabrese Podcast",
      blurb: "Natural health approaches and homeopathic remedies for families and wellness."
    },
    1233359606: {
      topics: [{ node: "music", confidence: 0.95 }, { node: "music/theory-production", confidence: 0.8 }],
      needs_review: false,
      rationale: "Electronic music radio show featuring DJ mixes and new electronic music releases.",
      display_title: "Alison Wonderland - Radio",
      blurb: "Electronic music show featuring new releases, DJ mixes, and independent producers."
    },
    1233966392: {
      topics: [{ node: "education/self-improvement", confidence: 0.85 }, { node: "culture", confidence: 0.7 }],
      needs_review: false,
      rationale: "Planning and productivity discussion for people interested in organization systems.",
      display_title: "Planner Girl Chatter",
      blurb: "Planning, productivity, and organization strategies for living a structured life."
    },
    1234304336: {
      topics: [{ node: "hobbies", confidence: 0.85 }, { node: "education", confidence: 0.75 }, { node: "nature", confidence: 0.75 }],
      needs_review: false,
      rationale: "Deer hunting education and wildlife management information for hunters.",
      display_title: "Deer University",
      blurb: "Deer hunting tips, wildlife management, and hunting education for sportsmen."
    },
    1236253646: {
      topics: [{ node: "music", confidence: 0.95 }, { node: "music/theory-production", confidence: 0.85 }],
      needs_review: false,
      rationale: "House and electronic music radio show featuring new releases and label showcases.",
      display_title: "Heldeep Radio",
      blurb: "Weekly house and electronic music show featuring upfront releases and new artists."
    },
    1237796990: {
      topics: [{ node: "history", confidence: 0.95 }, { node: "education", confidence: 0.75 }],
      needs_review: false,
      rationale: "Historical interviews and expert Q&A uncovering overlooked historical stories.",
      display_title: "History Unplugged Podcast",
      blurb: "Historical interviews and expert conversations exploring overlooked and untold history."
    },
    1237931798: {
      topics: [{ node: "psychology", confidence: 0.9 }, { node: "relationships", confidence: 0.95 }, { node: "health/mental", confidence: 0.8 }],
      needs_review: false,
      rationale: "Real therapy sessions with couples exploring relationships and personal challenges.",
      display_title: "Where Should We Begin?",
      blurb: "Intimate real therapy sessions exploring relationships, identity, and life challenges."
    },
    1239901676: {
      topics: [{ node: "kids-family/stories", confidence: 0.95 }, { node: "religion/christianity", confidence: 0.85 }],
      needs_review: false,
      rationale: "Bible-based audio adventure stories for children emphasizing faith and values.",
      display_title: "Discovery Mountain",
      blurb: "Faith-based audio adventures for kids exploring values, courage, and spiritual growth."
    },
    1241195252: {
      topics: [{ node: "gaming/design", confidence: 0.85 }, { node: "business", confidence: 0.8 }],
      needs_review: false,
      rationale: "Game design analysis and mechanics discussion from mobile and video game industry.",
      display_title: "Deconstructor of Fun",
      blurb: "Game design analysis and mechanics exploring what makes games engaging and addictive."
    },
    1241259434: {
      topics: [{ node: "culture/pop-culture", confidence: 0.9 }, { node: "tv-film", confidence: 0.95 }],
      needs_review: false,
      rationale: "DC superhero film and TV series discussion and analysis from studio perspective.",
      display_title: "DC Studios Podcast",
      blurb: "DC superhero universe discussion and behind-the-scenes insights into DC Studios films."
    },
    1242126464: {
      topics: [{ node: "travel", confidence: 0.85 }, { node: "culture", confidence: 0.85 }, { node: "history", confidence: 0.75 }],
      needs_review: false,
      rationale: "Barcelona culture, history, travel, and local life for visitors and residents.",
      display_title: "The Barcelona Podcast",
      blurb: "Barcelona culture, history, and travel insights for visitors and city enthusiasts."
    },
    1242630512: {
      topics: [{ node: "gaming", confidence: 0.9 }, { node: "gaming/design", confidence: 0.75 }],
      needs_review: false,
      rationale: "Escape room games and puzzle-based entertainment discussion and reviews.",
      display_title: "Escape This Podcast",
      blurb: "Escape room games, puzzle games, and immersive entertainment discussion and reviews."
    },
    1243452578: {
      topics: [{ node: "comedy", confidence: 0.85 }, { node: "comedy/casual-hangs", confidence: 0.8 }, { node: "culture", confidence: 0.6 }],
      needs_review: false,
      rationale: "Comedy and conversational banter between hosts discussing current events and culture.",
      display_title: "The Luke and Pete Show",
      blurb: "Comedy and conversation covering current events, culture, and pop culture topics."
    },
    1245763628: {
      topics: [{ node: "education/self-improvement", confidence: 0.85 }, { node: "business/startups", confidence: 0.75 }],
      needs_review: false,
      rationale: "Personal growth, productivity, and lifestyle advice from author and entrepreneur.",
      display_title: "The Rachel Hollis Podcast",
      blurb: "Personal growth and productivity advice from author and entrepreneur Rachel Hollis."
    },
    1247300054: {
      topics: [{ node: "history/military-modern", confidence: 0.85 }, { node: "news/politics", confidence: 0.75 }],
      needs_review: false,
      rationale: "Military and veteran interviews exploring service experiences and warrior culture.",
      display_title: "Cleared Hot",
      blurb: "Military and veteran interviews sharing service stories and insights into warrior culture."
    },
    1251213764: {
      topics: [{ node: "sports/football", confidence: 0.85 }, { node: "sports", confidence: 0.85 }],
      needs_review: false,
      rationale: "Sports talk and debate with focus on betting, fantasy, and professional sports.",
      display_title: "Petros And Money",
      blurb: "Sports commentary and analysis covering professional teams, fantasy, and sports betting."
    },
    1252638476: {
      topics: [{ node: "relationships", confidence: 0.8 }, { node: "comedy", confidence: 0.8 }, { node: "culture", confidence: 0.65 }],
      needs_review: false,
      rationale: "Dating advice and comedic relationship stories from radio hosts.",
      display_title: "Brooke and Jeffrey",
      blurb: "Dating and relationship advice with comedy and real listener stories from radio hosts."
    }
  };

  if (classifications[id]) {
    return {
      ...classifications[id],
      model: "claude-code-cron (tier 1)"
    };
  }

  return null;
}

let classified = 0;
let skipped = 0;

batch.shows.forEach(show => {
  const classification = classify(show);
  if (classification) {
    results.results[show.apple_collection_id] = classification;
    classified++;
  } else {
    skipped++;
  }
});

fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));

console.log(`Classification complete!`);
console.log(`Classified: ${classified}`);
console.log(`Skipped: ${skipped}`);
console.log(`Results written to: ${resultsFile}`);
