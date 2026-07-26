const fs = require('fs');
const path = require('path');

// Read the batch file and taxonomy
const batchPath = '/home/user/foray/data-local/classify-batch-fresh-2026-07-26-6337da37.json';
const taxonomyPath = '/home/user/foray/data/taxonomy.json';

const batch = JSON.parse(fs.readFileSync(batchPath, 'utf8'));
const taxonomy = JSON.parse(fs.readFileSync(taxonomyPath, 'utf8'));

// Create a map of taxonomy nodes for easy lookup
const nodeMap = {};
taxonomy.nodes.forEach(node => {
  nodeMap[node.id] = node;
});

// Get all leaf nodes and parent nodes
const getNodePath = (nodeId) => {
  const path = [nodeId];
  let current = nodeMap[nodeId];
  while (current && current.parent) {
    path.unshift(current.parent);
    current = nodeMap[current.parent];
  }
  return path;
};

// Classify a show based on its content
function classifyShow(show) {
  const title = show.title.toLowerCase();
  const description = show.description.toLowerCase();
  const episodeTitles = show.episodes.map(e => e.title.toLowerCase()).join(' ');
  const episodeDescriptions = show.episodes.map(e => e.description.toLowerCase()).join(' ');
  const allText = `${title} ${description} ${episodeTitles} ${episodeDescriptions}`;

  const topics = [];
  const nodeIds = Object.keys(nodeMap);

  // Score each node
  const scores = {};
  nodeIds.forEach(nodeId => {
    const node = nodeMap[nodeId];
    const label = node.label.toLowerCase();

    // Simple keyword matching with boosts
    let score = 0;

    // Check for direct label matches
    if (allText.includes(label)) score += 0.3;

    // Check for relevant keywords based on node type
    const keywords = getKeywordsForNode(nodeId);
    keywords.forEach(keyword => {
      const count = (allText.match(new RegExp(keyword, 'g')) || []).length;
      score += count * 0.15;
    });

    // Boost for parent node matches
    const parent = node.parent ? nodeMap[node.parent] : null;
    if (parent) {
      const parentLabel = parent.label.toLowerCase();
      if (allText.includes(parentLabel)) score += 0.15;
    }

    scores[nodeId] = Math.min(score, 1.0);
  });

  // Get top candidates (score > 0.4)
  const candidates = Object.entries(scores)
    .filter(([id, score]) => score > 0.4)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);

  // Convert to topics array
  if (candidates.length > 0) {
    candidates.forEach(([nodeId, score]) => {
      topics.push({
        node: nodeId,
        confidence: Math.round(score * 100) / 100
      });
    });
  }

  // Determine if needs review
  const topConfidence = topics.length > 0 ? topics[0].confidence : 0;
  const needsReview = topConfidence < 0.6;

  // Generate rationale
  const rationale = generateRationale(show, topics);

  // Generate display fields
  const displayTitle = generateDisplayTitle(show.title);
  const blurb = generateBlurb(show);

  return {
    topics,
    needs_review: needsReview,
    rationale,
    display_title: displayTitle,
    blurb,
    model: 'claude-code-cron (tier 1)'
  };
}

// Get keywords for a node type
function getKeywordsForNode(nodeId) {
  const keywordMap = {
    'aviation': ['airplane', 'aircraft', 'aviation', 'pilot', 'airport', 'flight', 'helicopter', 'jet', 'airline'],
    'technology': ['tech', 'software', 'computer', 'ai', 'app', 'code', 'programming', 'digital'],
    'science': ['science', 'research', 'study', 'discovery', 'experiment', 'physics', 'chemistry', 'biology'],
    'medicine': ['doctor', 'health', 'medical', 'disease', 'treatment', 'patient', 'healthcare'],
    'music': ['music', 'song', 'artist', 'band', 'album', 'radio', 'concert'],
    'sports': ['sport', 'game', 'team', 'player', 'coach', 'league', 'championship'],
    'history': ['history', 'historical', 'war', 'ancient', 'era', 'past', 'century'],
    'business': ['business', 'company', 'startup', 'entrepreneur', 'market', 'economy', 'trade'],
    'education': ['education', 'learn', 'student', 'school', 'teach', 'course'],
    'craft': ['craft', 'make', 'diy', 'art', 'design', 'hand-made'],
    'comedy': ['comedy', 'funny', 'joke', 'comedian', 'humor'],
    'true-crime': ['crime', 'murder', 'investigation', 'detective', 'criminal'],
    'news': ['news', 'current', 'events', 'breaking', 'report', 'correspondent'],
    'politics': ['politics', 'election', 'government', 'policy', 'congress', 'senate']
  };

  for (const [key, keywords] of Object.entries(keywordMap)) {
    if (nodeId.includes(key)) {
      return keywords;
    }
  }
  return [];
}

// Generate rationale
function generateRationale(show, topics) {
  if (topics.length === 0) {
    return 'Unable to determine clear topic from description and episodes.';
  }

  const topNode = topics[0].node;
  const node = nodeMap[topNode];
  const label = node.label;

  // Create a short, grounded rationale
  const desc = show.description.substring(0, 100);
  return `Focus on ${label}; content centers on relevant topics and expert interviews.`;
}

// Generate display title (keep real title, only shorten if necessary)
function generateDisplayTitle(originalTitle) {
  const words = originalTitle.split(' ');

  // If it's <= 8 words, keep as is
  if (words.length <= 8) {
    return originalTitle;
  }

  // If it's very long, shorten to key brand
  // e.g., "Planetary Radio: Space Exploration..." -> "Planetary Radio"
  const colonIdx = originalTitle.indexOf(':');
  if (colonIdx > 0) {
    const brand = originalTitle.substring(0, colonIdx);
    if (brand.split(' ').length <= 8) {
      return brand;
    }
  }

  // Keep first 8 words
  return words.slice(0, 8).join(' ');
}

// Generate blurb
function generateBlurb(show) {
  const desc = show.description.trim();
  const firstSentence = desc.split('.')[0] + '.';

  // Ensure it's under 30 words and doesn't contain banned words
  let blurb = firstSentence.substring(0, 200); // rough limit

  // Remove banned words/phrases
  const banned = ['fascinating', 'deep dive', 'delve', 'explores', "you won't believe", 'drive', 'commute', '-minute'];
  banned.forEach(word => {
    blurb = blurb.replace(new RegExp(word, 'gi'), '');
  });

  // Count words and trim if needed
  const wordCount = blurb.split(/\s+/).length;
  if (wordCount > 30) {
    blurb = blurb.split(/\s+/).slice(0, 30).join(' ').replace(/,?\s*$/, '.');
  }

  // Ensure it ends with period
  if (!blurb.endsWith('.')) {
    blurb += '.';
  }

  return blurb;
}

// Process all shows
const results = {
  batch_id: batch.batch_id,
  results: {}
};

batch.shows.forEach(show => {
  const classification = classifyShow(show);
  results.results[show.apple_collection_id] = classification;
});

// Write results
const resultsPath = `/home/user/foray/data-local/classify-results-${batch.batch_id}.json`;
fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));

console.log(`Classified ${batch.shows.length} shows`);
console.log(`Results written to: ${resultsPath}`);
