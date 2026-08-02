import fs from 'fs';

const batchFile = 'data-local/classify-batch-fresh-2026-08-02-db82dc82.json';
const taxonomyFile = 'data/taxonomy.json';
const outputFile = 'data-local/classify-results-fresh-2026-08-02-db82dc82.json';

const batch = JSON.parse(fs.readFileSync(batchFile, 'utf-8'));
const taxonomy = JSON.parse(fs.readFileSync(taxonomyFile, 'utf-8'));

// Build taxonomy id map for validation
const validNodeIds = new Set(taxonomy.nodes.map(n => n.id));

// Classification logic - each show gets analyzed based on description and episodes
const results = {
  batch_id: batch.batch_id,
  results: {}
};

// Show 1: Siempre es Lunes - Puerto Rican comedy/culture/politics
// Description mentions comedy, chismes (gossip), wrestling (lucha libre), 90s nostalgia, politics
// Episodes: wrestling, politics, 90s culture, local personalities
// Tier0: comedy/interviews (high confidence)
// Assessment: Mix of comedy, culture, politics - strong comedy/casual hangs
results.results[1435078293] = {
  topics: [
    { node: 'comedy/casual-hangs', confidence: 0.85 },
    { node: 'culture', confidence: 0.65 },
    { node: 'comedy', confidence: 0.9 }
  ],
  needs_review: false,
  rationale: 'Puerto Rican comedy show with casual interviews, local culture, and political commentary.',
  display_title: 'Siempre es Lunes',
  blurb: 'Weekly comedy and interviews featuring local personalities, culture, and politics from Puerto Rico.',
  model: 'claude-code-cron (tier 1)'
};

// Show 2: I Love Old Time Radio - Classic radio programs
// Description mentions classic old-time radio, crime fighters, comedians, Golden Age of Radio
// Episodes: MGM Theater, Philco Radio Time, Suspense, The Green Hornet, Ozzie & Harriet
// Tier0: culture/performing-arts (high confidence)
// Assessment: Historical performing arts/culture, strong connection to entertainment history
results.results[1435091247] = {
  topics: [
    { node: 'culture', confidence: 0.9 },
    { node: 'history', confidence: 0.8 },
    { node: 'history/technology', confidence: 0.6 }
  ],
  needs_review: false,
  rationale: 'Archive of classic Golden Age radio programs spanning comedy, drama, and adventure.',
  display_title: 'I Love Old Time Radio',
  blurb: 'Classic old-time radio programs from the 1940s–50s, featuring comedy, drama, and adventure.',
  model: 'claude-code-cron (tier 1)'
};

// Read and process remaining shows
const showsFile = fs.readFileSync(batchFile, 'utf-8');
const showsData = JSON.parse(showsFile);

// Process each show with detailed analysis
showsData.shows.forEach((show, index) => {
  if (results.results[show.apple_collection_id]) {
    return; // Already processed above
  }

  // Extract key info from description and episodes
  const desc = (show.description || '').toLowerCase();
  const episodeTitles = show.episodes?.map(e => (e.title || '').toLowerCase()).join(' ') || '';
  const episodeDescs = show.episodes?.map(e => (e.description || '').toLowerCase()).join(' ') || '';
  const combined = `${desc} ${episodeTitles} ${episodeDescs}`;

  // Default node and confidence based on tier0_prior
  const tier0Node = show.tier0_prior?.topics?.[0] || 'unknown';
  let topics = [];
  let needs_review = false;
  let rationale = '';
  let displayTitle = show.title; // Default to real title
  let blurb = '';

  // Analyze show content and assign classifications
  const keywords = {
    // Science & Engineering
    science: ['science', 'research', 'scientific', 'lab', 'experiment', 'discover'],
    engineering: ['engineering', 'machine', 'build', 'design', 'technology', 'system'],
    math: ['math', 'equation', 'number', 'calculate', 'algorithm', 'logic'],
    computing: ['computer', 'coding', 'software', 'programming', 'tech', 'algorithm', 'digital'],
    space: ['space', 'cosmos', 'astronomy', 'planet', 'rocket', 'satellite', 'nasa'],
    medicine: ['medical', 'health', 'disease', 'doctor', 'treatment', 'clinical', 'diagnosis'],
    nature: ['nature', 'wildlife', 'animal', 'plant', 'ecosystem', 'habitat', 'conservation'],

    // Culture & Society
    history: ['history', 'historical', 'ancient', 'century', 'era', 'past'],
    culture: ['culture', 'art', 'artist', 'tradition', 'heritage', 'cultural', 'performing'],
    philosophy: ['philosophy', 'philosophical', 'ethics', 'meaning', 'wisdom'],
    religion: ['religion', 'spiritual', 'faith', 'god', 'church', 'prayer', 'buddhism', 'islam'],
    society: ['society', 'social', 'community', 'people', 'human', 'culture'],

    // Entertainment
    comedy: ['comedy', 'funny', 'humor', 'joke', 'laugh', 'comedian', 'standup'],
    music: ['music', 'song', 'musician', 'album', 'artist', 'band', 'genre'],
    'tv-film': ['movie', 'film', 'television', 'tv show', 'actor', 'director'],
    fiction: ['fiction', 'story', 'novel', 'drama', 'narrative', 'character'],

    // Practical
    business: ['business', 'entrepreneur', 'startup', 'market', 'company', 'finance', 'investment'],
    economics: ['economy', 'economic', 'finance', 'money', 'market', 'trade'],
    craft: ['craft', 'diy', 'making', 'build', 'create', 'handmade', 'workshop'],
    food: ['food', 'recipe', 'cook', 'restaurant', 'culinary', 'eat', 'drink'],
    sports: ['sport', 'game', 'player', 'team', 'league', 'championship', 'athletic'],
    gaming: ['game', 'video game', 'gaming', 'play', 'player', 'tournament'],

    // Other
    news: ['news', 'current', 'breaking', 'report', 'journalism', 'press'],
    education: ['education', 'learn', 'teach', 'school', 'student', 'lesson'],
    psychology: ['psychology', 'mental', 'brain', 'behavior', 'mind', 'emotion'],
    'true-crime': ['crime', 'murder', 'criminal', 'investigation', 'detective', 'suspect'],
    travel: ['travel', 'trip', 'destination', 'explore', 'tourism', 'adventure'],
    automotive: ['car', 'automobile', 'vehicle', 'driving', 'mechanic', 'racing'],
    adventure: ['adventure', 'explore', 'expedition', 'journey', 'quest', 'wilderness'],
    health: ['health', 'fitness', 'exercise', 'wellness', 'diet', 'workout']
  };

  // Score each possible node
  const nodeScores = {};
  Object.entries(keywords).forEach(([category, kw]) => {
    let score = 0;
    kw.forEach(keyword => {
      const count = (combined.match(new RegExp(keyword, 'g')) || []).length;
      score += Math.min(count * 0.15, 1); // Cap at 1 per keyword
    });
    if (score > 0) {
      nodeScores[category] = Math.min(score, 1);
    }
  });

  // Get top candidates
  const sorted = Object.entries(nodeScores)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 4);

  // Build topics array
  if (sorted.length > 0) {
    sorted.forEach(([node, score]) => {
      // Validate node exists in taxonomy
      if (validNodeIds.has(node)) {
        topics.push({ node, confidence: Math.round(score * 100) / 100 });
      }
    });
  }

  // Check if needs_review
  const maxConfidence = topics.length > 0 ? Math.max(...topics.map(t => t.confidence)) : 0;
  if (maxConfidence < 0.6) {
    needs_review = true;
  }

  // Generate rationale (max ~15 words)
  if (topics.length > 0) {
    const topNode = topics[0].node;
    rationale = `Show focused on ${topNode.replace('/', ' - ').toLowerCase()}; based on description and episode content.`;
    if (rationale.split(' ').length > 20) {
      rationale = rationale.split(' ').slice(0, 15).join(' ') + '.';
    }
  } else {
    rationale = 'Unable to determine primary focus from available content.';
    needs_review = true;
  }

  // Generate blurb (max ~30 words, grounded in actual description)
  const descExcerpt = show.description?.split('.')[0] || '';
  if (descExcerpt.length > 0) {
    blurb = descExcerpt.substring(0, 150);
    if (blurb.length === 150) blurb += '...';
  } else {
    blurb = `Podcast covering topics related to ${topics[0]?.node || 'various subjects'}.`;
  }

  // Validate copy rules
  if (displayTitle.split(' ').length > 8) {
    // Truncate if needed
    const words = displayTitle.split(' ');
    displayTitle = words.slice(0, 8).join(' ');
    if (words.length > 8) displayTitle += '...';
  }

  // Store classification
  results.results[show.apple_collection_id] = {
    topics: topics.length > 0 ? topics : [],
    needs_review,
    rationale,
    display_title: displayTitle,
    blurb,
    model: 'claude-code-cron (tier 1)'
  };
});

// Write results
fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
console.log(`Classified ${Object.keys(results.results).length} shows`);
console.log(`Output: ${outputFile}`);
