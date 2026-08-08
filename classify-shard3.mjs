#!/usr/bin/env node
import fs from 'fs';

const batchPath = '/home/user/foray/data-local/classify-batch-fresh-2026-08-08-32bf3174.json';
const taxonomyPath = '/home/user/foray/data/taxonomy.json';
const resultsPath = '/home/user/foray/data-local/classify-results-fresh-2026-08-08-32bf3174.json';

const batch = JSON.parse(fs.readFileSync(batchPath, 'utf8'));
const taxonomy = JSON.parse(fs.readFileSync(taxonomyPath, 'utf8'));

// Helper to validate node IDs
const validNodes = new Set(taxonomy.nodes.map(n => n.id));

// Classification logic for each show
const classifications = {
  1556168961: { // King von rip
    topics: [],
    needs_review: true,
    rationale: "Insufficient signal; unclear description.",
    display_title: "King von rip",
    blurb: "Minimal show information available."
  },
  1560394221: { // don't listen to this...
    topics: [],
    needs_review: true,
    rationale: "Placeholder podcast with no real content.",
    display_title: "don't listen to this, i didn't mean to make it",
    blurb: "Abandoned podcast with no meaningful episodes."
  },
  1651887483: { // Jets @ Noon
    topics: [
      { node: "sports/hockey", confidence: 0.95 },
      { node: "sports", confidence: 0.9 }
    ],
    needs_review: false,
    rationale: "Daily Winnipeg Jets hockey podcast with game analysis.",
    display_title: "Jets @ Noon",
    blurb: "Daily Winnipeg Jets news, analysis, and listener calls."
  },
  1653747327: { // Investing Experts
    topics: [
      { node: "economics/markets", confidence: 0.9 },
      { node: "business", confidence: 0.75 }
    ],
    needs_review: false,
    rationale: "Stock analysis and market trends from financial experts.",
    display_title: "Investing Experts",
    blurb: "Deep analysis of stocks, markets, and tax strategies."
  },
  1653893811: { // The Bulletin
    topics: [
      { node: "news/commentary", confidence: 0.85 },
      { node: "religion/christianity", confidence: 0.7 }
    ],
    needs_review: false,
    rationale: "Christian perspectives on current events and culture.",
    display_title: "The Bulletin",
    blurb: "Faith and culture analysis for Christian listeners."
  },
  1654061097: { // World Cup Gambling Podcast
    topics: [
      { node: "sports/soccer", confidence: 0.9 },
      { node: "sports", confidence: 0.8 }
    ],
    needs_review: false,
    rationale: "Premier League betting analysis and picks.",
    display_title: "World Cup Gambling Podcast",
    blurb: "Soccer betting predictions and Premier League analysis."
  },
  1654325061: { // Magic Woods
    topics: [
      { node: "kids-family/stories", confidence: 0.9 },
      { node: "fiction", confidence: 0.75 }
    ],
    needs_review: false,
    rationale: "Fantasy audio drama for children with animal characters.",
    display_title: "Magic Woods",
    blurb: "Serialized fantasy stories for kids and families."
  },
  1654480107: { // Géométrie spectrale
    topics: [
      { node: "math", confidence: 0.85 },
      { node: "science", confidence: 0.7 }
    ],
    needs_review: false,
    rationale: "Advanced mathematical lecture series from Collège de France.",
    display_title: "Géométrie spectrale",
    blurb: "Spectral geometry lectures in French from academia."
  },
  1654580481: { // Mostly knitting podcast
    topics: [
      { node: "craft", confidence: 0.9 },
      { node: "craft/woodworking", confidence: 0.4 }
    ],
    needs_review: false,
    rationale: "Monthly knitting and fiber crafts podcast from Norway.",
    display_title: "Mostly knitting podcast",
    blurb: "Monthly knitting projects and fiber art discussion."
  },
  1654662855: { // Past The Barb
    topics: [
      { node: "adventure/exploration", confidence: 0.8 },
      { node: "sports/endurance", confidence: 0.7 }
    ],
    needs_review: false,
    rationale: "Outdoor fishing and hunting adventures with humor.",
    display_title: "Past The Barb",
    blurb: "Unfiltered outdoor adventure and fishing stories."
  },
  1654808379: { // The Guerilla Cricket Podcast
    topics: [
      { node: "sports/cricket", confidence: 0.95 },
      { node: "sports", confidence: 0.85 }
    ],
    needs_review: false,
    rationale: "Independent cricket commentary and analysis.",
    display_title: "The Guerilla Cricket Podcast",
    blurb: "Live cricket commentary and tournament analysis."
  },
  1654955859: { // The Willetts Podcast
    topics: [
      { node: "health/fitness", confidence: 0.9 },
      { node: "health/nutrition", confidence: 0.65 }
    ],
    needs_review: false,
    rationale: "Evidence-based fitness and transformation for women.",
    display_title: "The Willetts Podcast",
    blurb: "Fitness and relationship guidance from coaches."
  },
  1655108265: { // Design Emergency
    topics: [
      { node: "culture/design", confidence: 0.9 },
      { node: "culture", confidence: 0.75 }
    ],
    needs_review: false,
    rationale: "Design projects tackling social and environmental challenges.",
    display_title: "Design Emergency",
    blurb: "Design solutions to climate, refugee, and tech issues."
  },
  1655488497: { // Binge Eating Breakthrough
    topics: [
      { node: "health/nutrition", confidence: 0.85 },
      { node: "health/mental", confidence: 0.8 }
    ],
    needs_review: false,
    rationale: "Coaching on mindset and recovery from binge eating.",
    display_title: "Binge Eating Breakthrough",
    blurb: "Evidence-based strategies for eating disorder recovery."
  },
  1656086331: { // Organizations Win Championships
    topics: [
      { node: "sports/basketball", confidence: 0.9 },
      { node: "sports", confidence: 0.8 }
    ],
    needs_review: false,
    rationale: "Chicago Bulls analysis and NBA basketball strategy.",
    display_title: "Organizations Win Championships",
    blurb: "Chicago Bulls strategy and team-building analysis."
  },
  1656711321: { // Things Unseen with Sinclair B. Ferguson
    topics: [
      { node: "religion/christianity", confidence: 0.95 },
      { node: "religion", confidence: 0.9 }
    ],
    needs_review: false,
    rationale: "Daily Christian devotional and spiritual reflection.",
    display_title: "Things Unseen with Sinclair B. Ferguson",
    blurb: "Weekday Christian devotions on faith and renewal."
  },
  1656841305: { // The Sunday Shakeout
    topics: [
      { node: "sports/endurance", confidence: 0.9 },
      { node: "health/fitness", confidence: 0.75 }
    ],
    needs_review: false,
    rationale: "Stories of high school and professional distance runners.",
    display_title: "The Sunday Shakeout",
    blurb: "Interviews with elite distance runners and athletes."
  },
  1657433961: { // Occult Disney
    topics: [
      { node: "tv-film/animation", confidence: 0.85 },
      { node: "culture/mythology", confidence: 0.6 }
    ],
    needs_review: false,
    rationale: "Symbolic analysis and conspiracy theories in Disney films.",
    display_title: "Occult Disney",
    blurb: "Analysis of symbolism and mythology in Disney films."
  },
  1657743495: { // The Juniper Lab
    topics: [
      { node: "sports/endurance", confidence: 0.9 },
      { node: "health/nutrition", confidence: 0.85 }
    ],
    needs_review: false,
    rationale: "Nutrition and fueling strategies for ultrarunning.",
    display_title: "The Juniper Lab",
    blurb: "Ultrarunning nutrition, fueling, and endurance training."
  },
  1657976631: { // LP Giobbi - Femme House Radio
    topics: [
      { node: "music", confidence: 0.9 },
      { node: "culture/pop-culture", confidence: 0.6 }
    ],
    needs_review: false,
    rationale: "Weekly house music radio featuring underrepresented artists.",
    display_title: "LP Giobbi - Femme House Radio",
    blurb: "House music showcasing female and BIPOC DJs."
  },
  1658188227: { // RV LIFE Podcast
    topics: [
      { node: "travel", confidence: 0.9 },
      { node: "hobbies", confidence: 0.75 }
    ],
    needs_review: false,
    rationale: "RV lifestyle, travel, maintenance, and community.",
    display_title: "RV LIFE Podcast",
    blurb: "RV travel tips, maintenance, and lifestyle advice."
  },
  1658664345: { // Die Hard On A Blank
    topics: [
      { node: "tv-film/reviews", confidence: 0.9 },
      { node: "tv-film/history", confidence: 0.8 }
    ],
    needs_review: false,
    rationale: "Analysis of action films influenced by Die Hard.",
    display_title: "Die Hard On A Blank",
    blurb: "Action cinema analysis from Die Hard's influence."
  },
  1658815629: { // Coffee & Comic Books
    topics: [
      { node: "tv-film/animation", confidence: 0.75 },
      { node: "culture/pop-culture", confidence: 0.7 }
    ],
    needs_review: false,
    rationale: "Book club discussion of indie and alternative comics.",
    display_title: "Coffee & Comic Books",
    blurb: "Twice-monthly indie and alternative comic discussions."
  },
  1659702465: { // Gym World Worldwide
    topics: [
      { node: "business/startups", confidence: 0.85 },
      { node: "health/fitness", confidence: 0.75 }
    ],
    needs_review: false,
    rationale: "Fitness business entrepreneurship and gym ownership.",
    display_title: "Gym World Worldwide",
    blurb: "Fitness industry interviews and gym business insights."
  },
  1659713043: { // The Spirit Underground
    topics: [
      { node: "religion/buddhism", confidence: 0.8 },
      { node: "religion/spirituality", confidence: 0.85 }
    ],
    needs_review: false,
    rationale: "Buddhist meditation and abolitionist liberation practices.",
    display_title: "The Spirit Underground",
    blurb: "Buddhist spirituality and social liberation practices."
  },
  1660231257: { // Naturebang
    topics: [
      { node: "nature", confidence: 0.9 },
      { node: "science", confidence: 0.85 },
      { node: "nature/animal-cognition", confidence: 0.7 }
    ],
    needs_review: false,
    rationale: "Science storytelling about nature and consciousness.",
    display_title: "Naturebang",
    blurb: "Natural world storytelling with philosophical inquiry."
  },
  1660425825: { // 2 Be Better
    topics: [
      { node: "relationships", confidence: 0.9 },
      { node: "psychology/decision-making", confidence: 0.65 }
    ],
    needs_review: false,
    rationale: "Personal growth through relationship and emotional work.",
    display_title: "2 Be Better",
    blurb: "Relationship and personal growth coaching discussions."
  },
  1660658805: { // Severed
    topics: [
      { node: "tv-film/reviews", confidence: 0.95 },
      { node: "tv-film", confidence: 0.9 }
    ],
    needs_review: false,
    rationale: "Scene-by-scene breakdown of the show Severance.",
    display_title: "Severed",
    blurb: "Detailed analysis of the TV show Severance."
  },
  1661843985: { // Dysregulated Kids
    topics: [
      { node: "kids-family/parenting", confidence: 0.9 },
      { node: "health/mental", confidence: 0.75 }
    ],
    needs_review: false,
    rationale: "Science-based parenting for behavioral and emotional challenges.",
    display_title: "Dysregulated Kids",
    blurb: "Parenting guidance for behavioral and anxiety challenges."
  },
  1662039081: { // Doing Life with Ken and Tabatha
    topics: [
      { node: "relationships", confidence: 0.85 },
      { node: "religion/christianity", confidence: 0.7 }
    ],
    needs_review: false,
    rationale: "Christian marriage and relationship advice from coaches.",
    display_title: "Doing Life with Ken and Tabatha",
    blurb: "Christian marriage and faith-based relationship guidance."
  },
  1662385167: { // T-Time with Tori Totlis
    topics: [
      { node: "sports/golf", confidence: 0.95 },
      { node: "sports", confidence: 0.85 }
    ],
    needs_review: false,
    rationale: "Women's golf tips, mindset, and tournament coverage.",
    display_title: "T-Time with Tori Totlis",
    blurb: "Women's golf instruction and tournament interviews."
  },
  1663920021: { // TennisWorthy
    topics: [
      { node: "sports/tennis", confidence: 0.95 },
      { node: "sports", confidence: 0.85 }
    ],
    needs_review: false,
    rationale: "Tennis greatness through interviews and historical analysis.",
    display_title: "TennisWorthy",
    blurb: "Tennis champions share mindset and Hall of Fame insights."
  },
  1664751885: { // ポッドのPodcast
    topics: [
      { node: "tv-film/animation", confidence: 0.9 },
      { node: "culture/pop-culture", confidence: 0.8 }
    ],
    needs_review: false,
    rationale: "NieR:Automata anime episode discussion from Japanese voice actor.",
    display_title: "ポッドのPodcast",
    blurb: "NieR:Automata anime episode discussion in Japanese."
  },
  1664893659: { // אש!
    topics: [
      { node: "comedy/casual-hangs", confidence: 0.8 },
      { node: "culture/pop-culture", confidence: 0.7 }
    ],
    needs_review: false,
    rationale: "Raw conversation and humor in Hebrew with guest interviews.",
    display_title: "אש!",
    blurb: "Unfiltered Hebrew podcast with philosophy and humor."
  },
  1665360345: { // GOAT Golf
    topics: [
      { node: "sports/golf", confidence: 0.95 },
      { node: "sports", confidence: 0.85 }
    ],
    needs_review: false,
    rationale: "Global golf coverage with players, photographers, and architects.",
    display_title: "GOAT Golf",
    blurb: "Golf interviews with players and course architects worldwide."
  },
  1666065141: { // Between Two Lips
    topics: [
      { node: "health/sexuality", confidence: 0.9 },
      { node: "health", confidence: 0.8 }
    ],
    needs_review: false,
    rationale: "Women's pelvic health and sexual wellness coaching.",
    display_title: "Between Two Lips",
    blurb: "Women's pelvic health and sexual wellness education."
  },
  1666309191: { // I Hate It Here
    topics: [
      { node: "business/management", confidence: 0.9 },
      { node: "business", confidence: 0.75 }
    ],
    needs_review: false,
    rationale: "Candid HR and workplace culture discussions.",
    display_title: "I Hate It Here",
    blurb: "Honest HR professional insights and workplace culture."
  },
  1666371615: { // Threshold Moments
    topics: [
      { node: "religion/spirituality", confidence: 0.8 },
      { node: "psychology/decision-making", confidence: 0.65 }
    ],
    needs_review: false,
    rationale: "Personal stories of life transitions and authentic living.",
    display_title: "Threshold Moments",
    blurb: "Stories of personal transformation and life thresholds."
  },
  1666969227: { // Aphantasia Experiments
    topics: [
      { node: "medicine/neuroscience", confidence: 0.8 },
      { node: "science", confidence: 0.75 },
      { node: "psychology/decision-making", confidence: 0.6 }
    ],
    needs_review: false,
    rationale: "Exploring aphantasia, consciousness, and intuition through experiments.",
    display_title: "Aphantasia Experiments",
    blurb: "Consciousness and brain research through personal experiments."
  },
  1667079507: { // The Perfume Connosieur
    topics: [
      { node: "culture/fashion", confidence: 0.85 },
      { node: "hobbies", confidence: 0.7 }
    ],
    needs_review: false,
    rationale: "Luxury perfume reviews and fragrance expertise.",
    display_title: "The Perfume Connosieur",
    blurb: "Designer perfume reviews and fragrance expertise."
  }
};

const results = {
  batch_id: batch.batch_id,
  results: {}
};

for (const show of batch.shows) {
  const id = show.apple_collection_id;
  const classification = classifications[id];

  if (classification) {
    results.results[id] = {
      topics: classification.topics,
      needs_review: classification.needs_review,
      rationale: classification.rationale,
      display_title: classification.display_title,
      blurb: classification.blurb,
      model: "claude-code-cron (tier 1)"
    };
  }
}

fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
console.log(`Classified ${Object.keys(results.results).length} shows`);
