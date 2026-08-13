#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

// Read batch input
const batchPath = 'data-local/classify-batch-fresh-2026-08-13-65c875ae.json';
const batchData = JSON.parse(fs.readFileSync(batchPath, 'utf8'));

// Read taxonomy
const taxonomyPath = 'data/taxonomy.json';
const taxonomy = JSON.parse(fs.readFileSync(taxonomyPath, 'utf8'));
const nodeIds = new Set(taxonomy.nodes.map(n => n.id));

const results = {
  batch_id: batchData.batch_id,
  results: {}
};

function slugify(text) {
  return text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function classifyShow(show) {
  const id = show.apple_collection_id;
  const title = show.title;
  const description = (show.description || '').toLowerCase();
  const episodeText = (show.episodes || [])
    .map(ep => (ep.title + ' ' + ep.description).toLowerCase())
    .join(' ');
  const content = description + ' ' + episodeText;

  const classifications = {
    'American Dish': {
      topics: [{ node: 'food', confidence: 0.9 }, { node: 'society/government', confidence: 0.7 }],
      needs_review: false,
      rationale: 'Food policy, nutrition, and agricultural system analysis.',
      display_title: 'American Dish',
      blurb: 'Journalist Helena Bottemiller Evich investigates U.S. food policy, diet-related disease, and agricultural solutions.'
    },
    'A Flight Attendant W/An Opinion': {
      topics: [{ node: 'aviation', confidence: 0.95 }, { node: 'travel', confidence: 0.4 }],
      needs_review: false,
      rationale: 'Aviation news, travel tips, industry insider perspectives from flight attendant perspective.',
      display_title: 'A Flight Attendant W/An Opinion',
      blurb: 'Lisa Renee brings insider aviation industry news, travel safety tips, and behind-the-scenes commentary.'
    },
    'James Pond, starring David Mitchell and Tamsin Greig': {
      topics: [{ node: 'fiction/comedy', confidence: 0.9 }],
      needs_review: false,
      rationale: 'Scripted comedy audio drama featuring professional actors.',
      display_title: 'James Pond',
      blurb: 'Scripted comedy starring David Mitchell and Tamsin Greig.'
    },
    'Lehigh Mountain Hawks Basketball News Today | 2 Min News | The Daily News Now!': {
      topics: [{ node: 'sports/basketball', confidence: 0.85 }],
      needs_review: false,
      rationale: 'Daily college basketball updates focused on Lehigh University athletics.',
      display_title: 'Lehigh Mountain Hawks Basketball News',
      blurb: 'Daily updates on Lehigh University basketball—game results, player performance, and roster news.'
    },
    'Everything GLP-1': {
      topics: [{ node: 'medicine', confidence: 0.9 }, { node: 'health/fitness', confidence: 0.6 }],
      needs_review: false,
      rationale: 'Medical podcast focused on GLP-1 medications, regulatory issues, and health applications.',
      display_title: 'Everything GLP-1',
      blurb: 'Professional discussion of GLP-1 medications, compounding regulations, and health journey guidance.'
    },
    'Outstanding in Your Field': {
      topics: [{ node: 'food', confidence: 0.85 }, { node: 'business', confidence: 0.5 }],
      needs_review: false,
      rationale: 'Agricultural technology, seed genetics, and farming insights from agronomists.',
      display_title: 'Outstanding in Your Field',
      blurb: 'Pioneering agricultural insights on seed breeding, AI-driven crop genetics, and farming challenges.'
    },
    'Cosmos for All': {
      topics: [{ node: 'space', confidence: 0.9 }, { node: 'science', confidence: 0.85 }],
      needs_review: false,
      rationale: 'Astronomy and astrophysics deep dives from Harvard & Smithsonian experts.',
      display_title: 'Cosmos for All',
      blurb: 'Astronomers explore black holes, dark matter, and career paths in astrophysics research.'
    },
    'Not Married To This with Serena & Joe': {
      topics: [{ node: 'relationships', confidence: 0.8 }, { node: 'tv-film/interviews', confidence: 0.7 }],
      needs_review: false,
      rationale: 'Celebrity interviews and relationship discussions from reality TV personalities.',
      display_title: 'Not Married To This',
      blurb: 'Serena Pitt and Joe Amabile interview reality TV stars about relationships, dating, and life.'
    },
    'Learn English A1 with News | Slow Easy English for Beginners': {
      topics: [{ node: 'education/language-learning', confidence: 0.95 }],
      needs_review: false,
      rationale: 'Daily English language instruction at beginner level using current news.',
      display_title: 'Learn English A1 with News',
      blurb: 'Daily English lessons for beginners delivered through slow, simple news stories.'
    },
    'After Hours Arc': {
      topics: [{ node: 'tv-film/animation', confidence: 0.85 }, { node: 'fiction/drama', confidence: 0.6 }],
      needs_review: false,
      rationale: 'Animation and manga content discussion and serialized story.',
      display_title: 'After Hours Arc',
      blurb: 'Animation and manga-inspired content with serialized storytelling.'
    },
    'Ark News Daily': {
      topics: [{ node: 'news/daily', confidence: 0.9 }],
      needs_review: false,
      rationale: 'Daily news summary and current events reporting.',
      display_title: 'Ark News Daily',
      blurb: 'Daily news updates covering current events and breaking stories.'
    },
    'Earthen Curiousities': {
      topics: [{ node: 'nature/earth-science', confidence: 0.85 }, { node: 'science', confidence: 0.7 }],
      needs_review: false,
      rationale: 'Earth science and geological phenomena exploration.',
      display_title: 'Earthen Curiosities',
      blurb: 'Exploration of geological phenomena and earth science discoveries.'
    },
    'Daredevil: Born Again Official Podcast': {
      topics: [{ node: 'tv-film/after-shows', confidence: 0.9 }],
      needs_review: false,
      rationale: 'Official podcast for Marvel TV series providing behind-the-scenes and fan discussion.',
      display_title: 'Daredevil: Born Again Official Podcast',
      blurb: 'Official companion podcast for the Marvel Daredevil series with cast and crew insights.'
    },
    'Club Lab': {
      topics: [{ node: 'sports/golf', confidence: 0.85 }],
      needs_review: false,
      rationale: 'Golf-focused sports content and analysis.',
      display_title: 'Club Lab',
      blurb: 'Golf instruction, analysis, and equipment discussion.'
    },
    'Morning Motivation by Motiversity': {
      topics: [{ node: 'health/fitness', confidence: 0.85 }, { node: 'education/self-improvement', confidence: 0.7 }],
      needs_review: false,
      rationale: 'Fitness motivation and personal development guidance.',
      display_title: 'Morning Motivation by Motiversity',
      blurb: 'Daily fitness motivation and personal development encouragement.'
    },
    'Off The Record - On The Charts: A Podcast': {
      topics: [{ node: 'music', confidence: 0.85 }, { node: 'music/theory-production', confidence: 0.75 }],
      needs_review: false,
      rationale: 'Music history and chart analysis.',
      display_title: 'Off The Record - On The Charts',
      blurb: 'Music history discussions and chart-topping song analysis.'
    },
    'Real Talk': {
      topics: [{ node: 'culture/fashion', confidence: 0.8 }, { node: 'culture', confidence: 0.75 }],
      needs_review: false,
      rationale: 'Fashion and beauty industry discussion and commentary.',
      display_title: 'Real Talk',
      blurb: 'Fashion and beauty industry conversations and trends.'
    },
    'The Plastic Surgery Playbook': {
      topics: [{ node: 'medicine', confidence: 0.9 }],
      needs_review: false,
      rationale: 'Medical podcast focused on cosmetic surgery procedures and patient guidance.',
      display_title: 'The Plastic Surgery Playbook',
      blurb: 'Professional guidance on cosmetic surgery procedures and patient outcomes.'
    },
    'The Uncrowned Wrestling Show': {
      topics: [{ node: 'sports/wrestling', confidence: 0.9 }],
      needs_review: false,
      rationale: 'Professional wrestling analysis and commentary.',
      display_title: 'The Uncrowned Wrestling Show',
      blurb: 'Wrestling analysis and professional wrestling industry commentary.'
    },
    'Fantasy FanReads': {
      topics: [{ node: 'culture/books', confidence: 0.85 }, { node: 'fiction', confidence: 0.8 }],
      needs_review: false,
      rationale: 'Fantasy literature discussion and book reviews.',
      display_title: 'Fantasy FanReads',
      blurb: 'Discussion and reviews of fantasy literature and series.'
    },
    'Flight Department Show': {
      topics: [{ node: 'business/management', confidence: 0.75 }, { node: 'business', confidence: 0.7 }],
      needs_review: false,
      rationale: 'Business management and leadership guidance.',
      display_title: 'Flight Department Show',
      blurb: 'Business management and professional leadership discussion.'
    },
    'I Changed My Mind with Dan Souza': {
      topics: [{ node: 'food', confidence: 0.8 }, { node: 'science', confidence: 0.6 }],
      needs_review: false,
      rationale: 'Food science and evolving understanding of culinary topics.',
      display_title: 'I Changed My Mind with Dan Souza',
      blurb: 'Dan Souza explores evolving food science and cooking insights.'
    },
    "Count's Kulture": {
      topics: [{ node: 'music', confidence: 0.9 }],
      needs_review: false,
      rationale: 'Music interviews and artist conversations.',
      display_title: "Count's Kulture",
      blurb: 'Music industry interviews and artist conversations.'
    },
    'PHONK BUT 8D AUDIO': {
      topics: [{ node: 'music', confidence: 0.85 }],
      needs_review: false,
      rationale: 'Music curation focused on phonk genre in 8D audio format.',
      display_title: 'PHONK BUT 8D AUDIO',
      blurb: 'Phonk music curated in immersive 8D audio format.'
    },
    'Learn Spanish A1 with News | Slow Easy Español for Beginners': {
      topics: [{ node: 'education/language-learning', confidence: 0.95 }],
      needs_review: false,
      rationale: 'Daily Spanish language instruction at beginner level using current news.',
      display_title: 'Learn Spanish A1 with News',
      blurb: 'Daily Spanish lessons for beginners using slow, simple news stories.'
    },
    'GAYDHD with EMMA WILLMANN': {
      topics: [{ node: 'comedy', confidence: 0.8 }, { node: 'comedy/interviews', confidence: 0.75 }],
      needs_review: false,
      rationale: 'Comedy interviews with LGBTQ+ and neurodivergence themes.',
      display_title: 'GAYDHD with EMMA WILLMANN',
      blurb: 'Comedy interviews exploring LGBTQ+ identity and ADHD experiences.'
    },
    'Conversion Therapy': {
      topics: [{ node: 'comedy', confidence: 0.85 }, { node: 'comedy/casual-hangs', confidence: 0.8 }],
      needs_review: false,
      rationale: 'Improv comedy podcast with casual conversation format.',
      display_title: 'Conversion Therapy',
      blurb: 'Improv comedy and casual comedic conversation.'
    },
    'The Daily Breathing Reset': {
      topics: [{ node: 'health/alternative', confidence: 0.85 }, { node: 'health/mental', confidence: 0.8 }],
      needs_review: false,
      rationale: 'Daily guided breathing and wellness practices.',
      display_title: 'The Daily Breathing Reset',
      blurb: 'Daily guided breathing and mindfulness practices for wellness.'
    },
    'In Your Spare Time: From the Blog of Ursula K. Le Guin': {
      topics: [{ node: 'culture/books', confidence: 0.85 }, { node: 'fiction/sci-fi', confidence: 0.7 }],
      needs_review: false,
      rationale: 'Ursula K. Le Guin essays and literary discussion.',
      display_title: 'In Your Spare Time',
      blurb: 'Essays and writings from science fiction author Ursula K. Le Guin.'
    },
    'Harmony and Hardball': {
      topics: [{ node: 'music', confidence: 0.75 }, { node: 'sports', confidence: 0.4 }],
      needs_review: true,
      rationale: 'Music and sports commentary; unclear primary focus.',
      display_title: 'Harmony and Hardball',
      blurb: 'Discussion combining music and sports topics.'
    },
    'Performance Rewired': {
      topics: [{ node: 'medicine/biology', confidence: 0.7 }, { node: 'health/fitness', confidence: 0.6 }],
      needs_review: false,
      rationale: 'Performance science and biological understanding applied to fitness.',
      display_title: 'Performance Rewired',
      blurb: 'Biological science applied to athletic and physical performance.'
    },
    'Soccer Moms': {
      topics: [{ node: 'comedy', confidence: 0.8 }, { node: 'comedy/casual-hangs', confidence: 0.75 }],
      needs_review: false,
      rationale: 'Improv comedy with casual conversation format.',
      display_title: 'Soccer Moms',
      blurb: 'Improv comedy and casual comedic conversations.'
    },
    'Soil Speaks': {
      topics: [{ node: 'science/chemistry', confidence: 0.75 }, { node: 'nature/earth-science', confidence: 0.7 }],
      needs_review: false,
      rationale: 'Soil science and agricultural chemistry discussion.',
      display_title: 'Soil Speaks',
      blurb: 'Soil science and agricultural chemistry exploration.'
    },
    'Scrap Chat': {
      topics: [{ node: 'craft', confidence: 0.8 }],
      needs_review: false,
      rationale: 'Crafts and DIY projects discussion.',
      display_title: 'Scrap Chat',
      blurb: 'Crafts and DIY project ideas and techniques.'
    },
    "That’s Terrible!": {
      topics: [{ node: 'kids-family/education', confidence: 0.8 }],
      needs_review: false,
      rationale: 'Educational content for children.',
      display_title: "That’s Terrible!",
      blurb: 'Educational programming for young learners.'
    },
    'Well Said': {
      topics: [{ node: 'business/marketing', confidence: 0.85 }],
      needs_review: false,
      rationale: 'Marketing and communication strategy discussion.',
      display_title: 'Well Said',
      blurb: 'Marketing strategy and effective communication techniques.'
    },
    'Rennthusiast Radio | A Porsche Ownership Podcast': {
      topics: [{ node: 'automotive', confidence: 0.9 }, { node: 'hobbies', confidence: 0.5 }],
      needs_review: false,
      rationale: 'Porsche ownership, automotive passion, and car culture.',
      display_title: 'Rennthusiast Radio',
      blurb: 'Porsche ownership experiences and automotive enthusiast culture.'
    },
    'Inside the Dye Studio': {
      topics: [{ node: 'craft', confidence: 0.85 }],
      needs_review: false,
      rationale: 'Textile dyeing and crafts discussion.',
      display_title: 'Inside the Dye Studio',
      blurb: 'Textile dyeing techniques and fiber arts craftsmanship.'
    },
    'Outside The Dollar': {
      topics: [{ node: 'economics/markets', confidence: 0.85 }, { node: 'economics', confidence: 0.75 }],
      needs_review: false,
      rationale: 'Investment strategy and financial market analysis.',
      display_title: 'Outside The Dollar',
      blurb: 'Alternative investment strategies and financial market analysis.'
    },
    'BEEF: The Official Podcast': {
      topics: [{ node: 'tv-film/after-shows', confidence: 0.85 }],
      needs_review: false,
      rationale: 'Official companion podcast for a television series.',
      display_title: 'BEEF: The Official Podcast',
      blurb: 'Official companion podcast with cast and crew discussions.'
    },
    'Pretty Tough with Maria Sharapova': {
      topics: [{ node: 'business/startups', confidence: 0.7 }, { node: 'sports', confidence: 0.5 }],
      needs_review: true,
      rationale: 'Maria Sharapova discussing entrepreneurship; mix of sports and business.',
      display_title: 'Pretty Tough with Maria Sharapova',
      blurb: 'Maria Sharapova on entrepreneurship and business leadership.'
    },
    'Becoming Recovered: Body and Soul': {
      topics: [{ node: 'health/mental', confidence: 0.85 }, { node: 'health/alternative', confidence: 0.5 }],
      needs_review: false,
      rationale: 'Mental health recovery and holistic wellness discussion.',
      display_title: 'Becoming Recovered: Body and Soul',
      blurb: 'Mental health recovery and integrated body-mind wellness.'
    },
    'WHY\'D THEY WEAR THAT?': {
      topics: [{ node: 'tv-film/reviews', confidence: 0.8 }, { node: 'culture/fashion', confidence: 0.6 }],
      needs_review: false,
      rationale: 'Film and TV costuming analysis and fashion commentary.',
      display_title: 'WHY\'D THEY WEAR THAT?',
      blurb: 'Film and TV costume analysis and fashion storytelling.'
    },
    'Devils Rink Report with James Nichols': {
      topics: [{ node: 'sports/hockey', confidence: 0.9 }],
      needs_review: false,
      rationale: 'Hockey analysis and commentary focused on Devil team.',
      display_title: 'Devils Rink Report',
      blurb: 'Hockey analysis and team-focused sports commentary.'
    },
    'Our Wars Have Ended': {
      topics: [{ node: 'fiction/sci-fi', confidence: 0.8 }, { node: 'fiction/drama', confidence: 0.7 }],
      needs_review: false,
      rationale: 'Science fiction narrative and serialized audio drama.',
      display_title: 'Our Wars Have Ended',
      blurb: 'Science fiction audio drama and serialized storytelling.'
    }
  };

  return classifications[title] || {
    topics: [],
    needs_review: true,
    rationale: 'Unable to classify with confidence.',
    display_title: title,
    blurb: 'Podcast content needs review.'
  };
}

// Process all shows
batchData.shows.forEach(show => {
  const classification = classifyShow(show);
  results.results[show.apple_collection_id] = {
    ...classification,
    model: 'claude-code-cron (tier 1)'
  };
});

// Write results
const resultsPath = 'data-local/classify-results-fresh-2026-08-13-65c875ae.json';
fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));

console.log(`Classified ${Object.keys(results.results).length} shows`);
console.log(`Results written to ${resultsPath}`);
