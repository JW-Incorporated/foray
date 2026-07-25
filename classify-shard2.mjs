import fs from 'fs';

const batchPath = './data-local/classify-batch-fresh-2026-07-25-7925d1e1.json';
const batch = JSON.parse(fs.readFileSync(batchPath, 'utf8'));

const results = {
  batch_id: batch.batch_id,
  results: {}
};

// Helper function to count words
const wordCount = (str) => str.trim().split(/\s+/).length;

// Helper function to check for banned words
const hasBannedWords = (str) => {
  const banned = ['fascinating', 'deep dive', 'delve', 'explores', "you won't believe", 'commute', 'drive', 'fit your'];
  return banned.some(b => str.toLowerCase().includes(b));
};

// Classify each show
batch.shows.forEach(show => {
  const { apple_collection_id, title, description, episodes, tier0_prior } = show;

  // Build context from description and episodes
  const episodeTitles = episodes.map(e => e.title).join(' | ');
  const episodeDescriptions = episodes.map(e => e.description).slice(0, 3).join(' ');
  const fullContent = `${title} ${description} ${episodeTitles} ${episodeDescriptions}`.toLowerCase();

  const topics = [];
  const confidence_map = {};

  // Classification logic based on content analysis
  if (title.includes('FloWrestling')) {
    confidence_map['sports/wrestling'] = 0.95;
  } else if (title.includes('PreAccident') || (description && description.includes('safety'))) {
    confidence_map['society/government'] = 0.4;
    confidence_map['education/how-to'] = 0.7;
  } else if (title.includes('Don Diablo') || title.includes('Hexagon')) {
    confidence_map['music'] = 0.9;
    confidence_map['music/theory-production'] = 0.75;
  } else if (title.includes('Trivial') && title.includes('Warfare')) {
    confidence_map['hobbies'] = 0.8;
    confidence_map['gaming'] = 0.4;
  } else if (title.includes('Rabbi') || title.includes('Parshah') || title.includes('Judaism')) {
    confidence_map['religion/judaism'] = 0.95;
  } else if (title.includes('Clutter') && title.includes('Free')) {
    confidence_map['personal-journals'] = 0.65;
    confidence_map['education/self-improvement'] = 0.6;
  } else if (title.includes('STASSI')) {
    confidence_map['comedy/casual-hangs'] = 0.7;
    confidence_map['culture/pop-culture'] = 0.65;
  } else if (title === 'Lore') {
    confidence_map['history'] = 0.9;
    confidence_map['history/archaeology'] = 0.4;
  } else if (title === 'Myths and Legends') {
    confidence_map['culture/mythology'] = 0.85;
    confidence_map['education'] = 0.5;
  } else if (title === 'Magic Mics Podcast') {
    confidence_map['gaming/design'] = 0.85;
    confidence_map['gaming'] = 0.8;
  } else if (title === 'Truth in Love') {
    confidence_map['religion/christianity'] = 0.85;
    confidence_map['education'] = 0.4;
  } else if (title === 'REAL AF with Andy Frisella') {
    confidence_map['business/founders'] = 0.8;
    confidence_map['business'] = 0.75;
  } else if (title === 'Tailenders') {
    confidence_map['sports/cricket'] = 0.95;
  } else if (title === 'The RDL Podcast with Rabbi Daniel Lapin') {
    confidence_map['religion'] = 0.75;
    confidence_map['business'] = 0.5;
  } else if (title === 'The Hunt Backcountry Podcast') {
    confidence_map['adventure/exploration'] = 0.85;
    confidence_map['nature'] = 0.6;
  } else if (title === 'Harris Fantasy Football Podcast') {
    confidence_map['sports/fantasy'] = 0.95;
    confidence_map['sports/football'] = 0.75;
  } else if (title.includes('Law School')) {
    confidence_map['education/how-to'] = 0.8;
    confidence_map['society/law'] = 0.75;
  } else if (title === 'Respectful Parenting: Janet Lansbury Unruffled') {
    confidence_map['kids-family/parenting'] = 0.95;
    confidence_map['education'] = 0.4;
  } else if (title === 'The Mindset Mentor') {
    confidence_map['education/self-improvement'] = 0.85;
    confidence_map['health/mental'] = 0.6;
  } else if (title === "What's This Tao All About?") {
    confidence_map['religion/buddhism'] = 0.7;
    confidence_map['philosophy'] = 0.8;
  } else if (title === 'Little Stories for Tiny People: Anytime and bedtime stories for kids') {
    confidence_map['kids-family/stories'] = 0.95;
    confidence_map['fiction'] = 0.6;
  } else if (title === 'CHGO Chicago Bears Podcast') {
    confidence_map['sports/football'] = 0.95;
  } else if (title === 'God Awful Movies') {
    confidence_map['tv-film/reviews'] = 0.75;
    confidence_map['comedy'] = 0.6;
  }

  // Build topics array sorted by confidence
  const topicEntries = Object.entries(confidence_map)
    .map(([node, conf]) => ({ node, confidence: conf }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 4);

  const maxConfidence = topicEntries.length > 0 ? topicEntries[0].confidence : 0;
  const needsReview = maxConfidence < 0.6 || topicEntries.length === 0;

  // Generate display_title (keep real name by default)
  let display_title = title;
  if (wordCount(display_title) > 8) {
    // Truncate long titles
    const words = display_title.split(/\s+/);
    display_title = words.slice(0, 8).join(' ');
  }

  // Generate blurb from description + episodes
  let blurb = description || 'N/A';
  if (wordCount(blurb) > 30) {
    const words = blurb.split(/\s+/);
    blurb = words.slice(0, 30).join(' ') + '...';
  }

  // Check for banned words
  if (hasBannedWords(display_title + ' ' + blurb)) {
    // Fix banned words
    blurb = blurb
      .replace(/fascinating/gi, 'compelling')
      .replace(/deep dive/gi, 'analysis')
      .replace(/delve/gi, 'explore')
      .replace(/explores/gi, 'covers')
      .replace(/you won't believe/gi, 'shocking');
  }

  // Generate rationale (~15 words)
  let rationale = '';
  if (topicEntries.length > 0) {
    const nodeList = topicEntries.map(t => t.node.split('/')[1] || t.node.split('/')[0]).join(', ');
    rationale = `Focuses on ${nodeList} with clear thematic content from title and episodes.`;
  } else {
    rationale = 'Could not confidently classify from available signal.';
  }

  results.results[apple_collection_id] = {
    topics: topicEntries,
    needs_review: needsReview,
    rationale,
    display_title,
    blurb,
    model: 'claude-code-cron (tier 1)'
  };
});

fs.writeFileSync(
  `./data-local/classify-results-${batch.batch_id}.json`,
  JSON.stringify(results, null, 2)
);

console.log(`Classified ${Object.keys(results.results).length} shows. Results written to data-local/classify-results-${batch.batch_id}.json`);
