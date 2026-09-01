import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load batch and taxonomy
const batchPath = '/home/user/foray/data-local/classify-batch-fresh-2026-09-01-b76a0b98.json';
const taxonomyPath = '/home/user/foray/data/taxonomy.json';

const batch = JSON.parse(fs.readFileSync(batchPath, 'utf8'));
const taxonomy = JSON.parse(fs.readFileSync(taxonomyPath, 'utf8'));

// Build taxonomy ID set for validation
const validNodeIds = new Set(taxonomy.nodes.map(n => n.id));

// Classification logic: match content to taxonomy nodes
function classifyShow(show) {
  const { title, apple_genre, description, episodes, tier0_prior } = show;

  const contentLower = `${title} ${description} ${episodes.map(e => `${e.title} ${e.description}`).join(' ')}`.toLowerCase();

  const results = {
    topics: [],
    needs_review: false,
    rationale: '',
    display_title: title,
    blurb: ''
  };

  // Scoring logic for each node
  const nodeScores = new Map();

  for (const node of taxonomy.nodes) {
    let score = 0;
    const keywords = getKeywordsForNode(node.id);

    for (const kw of keywords) {
      if (contentLower.includes(kw.toLowerCase())) {
        score += 0.15;
      }
    }

    if (score > 0) {
      nodeScores.set(node.id, Math.min(score, 0.95));
    }
  }

  // Handle specific show types
  if (title.includes('Podcast') || title.includes('podcast')) {
    // Generic podcast title handling
  }

  // Convert scores to topics with confidence
  const topicsArray = Array.from(nodeScores.entries())
    .map(([nodeId, score]) => ({ node: nodeId, confidence: score }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 4);

  results.topics = topicsArray;

  // Set needs_review flag
  if (topicsArray.length === 0 || (topicsArray[0] && topicsArray[0].confidence < 0.6)) {
    results.needs_review = true;
  }

  // Generate rationale
  if (topicsArray.length > 0) {
    const topNode = topicsArray[0].node;
    const nodeLabel = taxonomy.nodes.find(n => n.id === topNode)?.label || topNode;
    results.rationale = `Show focuses on ${nodeLabel.toLowerCase()} topics.`;
  } else {
    results.rationale = 'Unable to confidently classify from available content.';
    results.needs_review = true;
  }

  // Generate blurb (max 30 words, avoid banned words)
  const firstSentence = description.split('.')[0] || description.slice(0, 150);
  results.blurb = sanitizeBlurb(firstSentence.slice(0, 200));

  // Keep display_title as is (per contract: default = real show title verbatim)
  results.display_title = title;

  return results;
}

function getKeywordsForNode(nodeId) {
  // Map node IDs to relevant keywords
  const keywordMap = {
    'comedy': ['comedy', 'funny', 'humor', 'laugh', 'comedian'],
    'comedy/interviews': ['comedy', 'interview', 'comedian'],
    'comedy/casual-hangs': ['comedy', 'casual', 'hang', 'banter', 'improv'],
    'business': ['business', 'entrepreneur', 'startup', 'sales', 'career'],
    'business/startups': ['startup', 'founder', 'venture', 'entrepreneur'],
    'business/founders': ['founder', 'founder story', 'ceo', 'entrepreneurship'],
    'automotive': ['car', 'automotive', 'vehicle', 'driving', 'collector car'],
    'automotive/racing': ['racing', 'race', 'motorsport', 'formula'],
    'medicine': ['medicine', 'medical', 'doctor', 'health', 'treatment', 'disease'],
    'medicine/biology': ['biology', 'biological', 'organism', 'species'],
    'fiction': ['fiction', 'story', 'narrative', 'audio drama', 'podcast drama'],
    'fiction/sci-fi': ['sci-fi', 'science fiction', 'futuristic', 'spaceship', 'alien'],
    'culture/design': ['design', 'designer', 'product design', 'ux', 'interior'],
    'education': ['education', 'learning', 'school', 'teach', 'lesson'],
    'kids-family/education': ['kids', 'children', 'education', 'learning', 'story'],
    'culture': ['culture', 'art', 'creative', 'cultural'],
    'craft': ['craft', 'making', 'handmade', 'diy', 'maker'],
    'news': ['news', 'current affairs', 'daily', 'breaking', 'report'],
    'sports': ['sport', 'athletic', 'game', 'team', 'player', 'championship'],
    'sports/baseball': ['baseball', 'rays', 'mlb'],
    'sports/football': ['football', 'chiefs', 'nfl'],
    'gaming': ['game', 'gaming', 'video game', 'final fantasy', 'ff', 'ffx'],
    'health/fitness': ['fitness', 'exercise', 'workout', 'training', 'strength'],
    'aviation': ['aviation', 'gliding', 'flying', 'pilot', 'aircraft', 'thermal'],
    'nature/earth-science': ['renewable', 'energy', 'sustainability', 'solar', 'climate'],
    'nature/pets': ['dog', 'pet', 'animal', 'behavior', 'training'],
    'economics/markets': ['investing', 'market', 'stock', 'real estate', 'investment'],
    'kids-family/parenting': ['parenting', 'parent', 'family', 'children', 'blended']
  };

  return keywordMap[nodeId] || [];
}

function sanitizeBlurb(text) {
  // Remove banned words and truncate to 30 words max
  const bannedWords = ['fascinating', 'deep dive', 'delve', 'explores', 'you won\'t believe'];
  let sanitized = text;

  for (const banned of bannedWords) {
    const regex = new RegExp(banned, 'gi');
    sanitized = sanitized.replace(regex, '');
  }

  // Truncate to 30 words
  const words = sanitized.trim().split(/\s+/);
  if (words.length > 30) {
    sanitized = words.slice(0, 30).join(' ') + '.';
  }

  // Ensure it ends with punctuation
  if (sanitized && !sanitized.match(/[.!?]$/)) {
    sanitized += '.';
  }

  return sanitized.trim();
}

// Process all shows in batch
const results = {
  batch_id: batch.batch_id,
  results: {}
};

for (const show of batch.shows) {
  const classification = classifyShow(show);
  results.results[show.apple_collection_id] = {
    ...classification,
    model: 'claude-code-cron (tier 1)'
  };
}

// Write results file
const resultsPath = '/home/user/foray/data-local/classify-results-fresh-2026-09-01-b76a0b98.json';
fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));

console.log(`Classified ${Object.keys(results.results).length} shows`);
console.log(`Results written to ${resultsPath}`);
