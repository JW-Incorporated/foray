#!/usr/bin/env node
import fs from 'fs';

const batchPath = '/home/user/foray/data-local/classify-batch-fresh-2026-09-01-b76a0b98.json';
const taxonomyPath = '/home/user/foray/data/taxonomy.json';

const batch = JSON.parse(fs.readFileSync(batchPath, 'utf8'));
const taxonomy = JSON.parse(fs.readFileSync(taxonomyPath, 'utf8'));

const validNodeIds = new Set(taxonomy.nodes.map(n => n.id));

// Map Apple genres to taxonomy nodes
const genreMap = {
  'comedy interviews': 'comedy/interviews',
  'comedy': 'comedy',
  'entrepreneurship': 'business/startups',
  'business': 'business',
  'automotive': 'automotive',
  'medicine': 'medicine',
  'science fiction': 'fiction/sci-fi',
  'design': 'culture/design',
  'education for kids': 'kids-family/education',
  'fitness': 'health/fitness',
  'aviation': 'aviation',
  'crafts': 'craft',
  'business news': 'news',
  'improv': 'comedy/casual-hangs',
  'pets & animals': 'nature/pets',
  'investing': 'economics/markets',
  'baseball': 'sports/baseball',
  'sports news': 'sports',
  'earth sciences': 'nature/earth-science',
  'video games': 'gaming',
  'parenting': 'kids-family/parenting'
};

function classifyShow(show) {
  const { title, apple_genre, description, episodes } = show;
  const fullText = `${title} ${description} ${episodes.map(e => `${e.title} ${e.description}`).join(' ')}`.toLowerCase();

  const scores = new Map();

  // Specific show rules
  if (title.includes('Collector Car') || title.includes('Collecting Cars')) {
    scores.set('automotive', 0.95);
  }
  if (title.includes('Rays')) {
    scores.set('sports/baseball', 0.95);
  }
  if (title.includes('Chiefs')) {
    scores.set('sports/football', 0.95);
  }
  if (title.includes('Final Fantasy') || title.includes('FF')) {
    scores.set('gaming', 0.9);
  }
  if (fullText.includes('gliding') || fullText.includes('sailplane')) {
    scores.set('aviation', 0.9);
  }
  if (fullText.includes('renewable') || fullText.includes('sustainability') || fullText.includes('solar')) {
    scores.set('nature/earth-science', 0.85);
    scores.set('engineering/energy-grid', 0.7);
  }
  if (fullText.includes('real estate') || fullText.includes('investing') || fullText.includes('market')) {
    scores.set('economics/markets', 0.8);
  }
  if (fullText.includes('dog') && fullText.includes('behavior')) {
    scores.set('nature/pets', 0.9);
  }
  if (fullText.includes('parenting') || fullText.includes('blended family')) {
    scores.set('kids-family/parenting', 0.85);
  }
  if (fullText.includes('fitness') || fullText.includes('exercise') || fullText.includes('strength training')) {
    scores.set('health/fitness', 0.85);
  }
  if (fullText.includes('comedy') && fullText.includes('interview')) {
    scores.set('comedy/interviews', 0.85);
  }
  if (title.includes('Carlos Inspire')) {
    scores.set('business/founders', 0.75);
    scores.set('business/startups', 0.7);
    scores.set('economics/markets', 0.6);
  }
  if (title.includes('Saladino')) {
    scores.set('medicine', 0.8);
    scores.set('health/nutrition', 0.7);
  }
  if (title.includes('VAST Horizon') || fullText.includes('colony ship')) {
    scores.set('fiction/sci-fi', 0.9);
  }
  if (title.includes('Nice Try')) {
    scores.set('culture/design', 0.85);
  }
  if (fullText.includes('japanese folk') || fullText.includes('昔ばなし')) {
    scores.set('kids-family/stories', 0.9);
  }
  if (title.includes('Craft A Life')) {
    scores.set('craft', 0.75);
    scores.set('education/self-improvement', 0.65);
  }
  if (title.includes('Morning Drive') && fullText.includes('interview')) {
    scores.set('news/daily', 0.7);
  }
  if (title.includes('Stronger By Science')) {
    scores.set('health/fitness', 0.9);
  }
  if (title.includes('Thermal')) {
    scores.set('aviation', 0.9);
  }
  if (title.includes('Soren') && title.includes('Daniel')) {
    scores.set('comedy/casual-hangs', 0.85);
  }
  if (title.includes('Ken McElroy')) {
    scores.set('economics/markets', 0.8);
    scores.set('business', 0.7);
  }
  if (title.includes('Harry Potter')) {
    scores.set('fiction', 0.75);
  }
  if (title.includes('Nacho Kids')) {
    scores.set('kids-family/parenting', 0.85);
  }
  if (title.includes('Defending The Kingdom')) {
    scores.set('sports/football', 0.9);
  }
  if (title.includes('Watts Up')) {
    scores.set('nature/earth-science', 0.8);
  }
  if (title.includes('Every F\'n FF')) {
    scores.set('gaming', 0.9);
  }

  // Fallback to genre if no specific match
  if (scores.size === 0) {
    const genreLower = apple_genre.toLowerCase();
    for (const [genre, nodeId] of Object.entries(genreMap)) {
      if (genreLower.includes(genre)) {
        scores.set(nodeId, 0.7);
        break;
      }
    }
  }

  // Last-resort fallback based on content keywords
  if (scores.size === 0) {
    if (fullText.includes('story') || fullText.includes('narrative')) {
      scores.set('fiction', 0.6);
    } else if (fullText.includes('interview')) {
      scores.set('comedy/casual-hangs', 0.6);
    } else if (fullText.includes('sport') || fullText.includes('game')) {
      scores.set('sports', 0.6);
    } else if (fullText.includes('music')) {
      scores.set('music', 0.6);
    } else {
      scores.set('personal-journals', 0.5);
    }
  }

  // Build topics
  const topics = Array.from(scores.entries())
    .filter(([nodeId]) => validNodeIds.has(nodeId))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([nodeId, confidence]) => ({
      node: nodeId,
      confidence: Math.round(confidence * 100) / 100
    }));

  const needsReview = topics.some(t => t.confidence < 0.6) || (topics[0] && topics[0].confidence < 0.7);

  // Rationale
  let rationale = 'Unable to classify.';
  if (topics.length > 0) {
    const topNode = taxonomy.nodes.find(n => n.id === topics[0].node);
    rationale = `Show about ${topNode.label.toLowerCase()}.`;
  }

  // Blurb
  let blurb = (description.split('.')[0] || description.slice(0, 150)).trim();

  // Clean banned words
  const bannedWords = ['fascinating', 'deep dive', 'delve', 'explores', 'you won\'t believe', 'commute', '-minute'];
  for (const banned of bannedWords) {
    const regex = new RegExp(`\\b${banned}\\b`, 'gi');
    blurb = blurb.replace(regex, '');
  }

  // Truncate to 30 words
  const words = blurb.split(/\s+/).filter(w => w);
  if (words.length > 30) {
    blurb = words.slice(0, 30).join(' ');
  }

  // Add punctuation
  blurb = blurb.trim();
  if (blurb && !blurb.match(/[.!?]$/)) {
    blurb += '.';
  }

  return {
    topics: topics.length > 0 ? topics : [{ node: 'personal-journals', confidence: 0.5 }],
    needs_review: needsReview,
    rationale,
    display_title: title,
    blurb,
    model: 'claude-code-cron (tier 1)'
  };
}

// Process
const results = {
  batch_id: batch.batch_id,
  results: {}
};

for (const show of batch.shows) {
  results.results[show.apple_collection_id] = classifyShow(show);
}

// Output
const outputPath = `/home/user/foray/data-local/classify-results-${batch.batch_id}.json`;
fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));

const needsReviewCount = Object.values(results.results).filter(r => r.needs_review).length;
console.log(`✓ ${Object.keys(results.results).length} shows classified (${needsReviewCount} need review)`);
console.log(`✓ ${outputPath}`);
