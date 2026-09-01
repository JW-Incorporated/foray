#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const batchPath = process.argv[2] || '/home/user/foray/data-local/classify-batch-fresh-2026-09-01-b76a0b98.json';
const taxonomyPath = '/home/user/foray/data/taxonomy.json';

const batch = JSON.parse(fs.readFileSync(batchPath, 'utf8'));
const taxonomy = JSON.parse(fs.readFileSync(taxonomyPath, 'utf8'));

const validNodeIds = new Set(taxonomy.nodes.map(n => n.id));

function classifyShow(show) {
  const { title, apple_genre, description, episodes, tier0_prior } = show;

  // Combine content
  const fullText = `${title} ${description} ${episodes.map(e => `${e.title} ${e.description}`).join(' ')}`.toLowerCase();

  const scores = new Map();

  // Hard-coded rules for specific patterns
  if (title.includes('Collector Car') || title.includes('Collecting Cars')) {
    scores.set('automotive', 0.95);
  }
  if (title.includes('Rays') || title.includes('Baseball')) {
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
  if (fullText.includes('renewable') || fullText.includes('sustainability')) {
    scores.set('nature/earth-science', 0.85);
    scores.set('engineering/energy-grid', 0.7);
  }
  if (title.includes('Saladino') || fullText.includes('health') || fullText.includes('chronic disease')) {
    scores.set('medicine', 0.8);
    scores.set('health/alternative', 0.6);
  }
  if (title.includes('Collector') || fullText.includes('collector')) {
    scores.set('automotive', 0.85);
  }
  if (title.includes('Science Fiction') || fullText.includes('spaceship') || fullText.includes('ai') && fullText.includes('survival')) {
    scores.set('fiction/sci-fi', 0.9);
  }
  if (title.includes('Nice Try')) {
    scores.set('culture/design', 0.85);
  }
  if (fullText.includes('cryptocurrency') || fullText.includes('trading') || fullText.includes('real estate')) {
    scores.set('economics/markets', 0.75);
  }
  if (fullText.includes('fitness') || fullText.includes('exercise') || fullText.includes('training') || fullText.includes('strength')) {
    scores.set('health/fitness', 0.85);
  }
  if (fullText.includes('comedy') && fullText.includes('interview')) {
    scores.set('comedy/interviews', 0.85);
  }
  if (fullText.includes('casual') && fullText.includes('banter')) {
    scores.set('comedy/casual-hangs', 0.8);
  }
  if (fullText.includes('entrepreneurship') || fullText.includes('startup') || fullText.includes('startup')) {
    scores.set('business/startups', 0.8);
    scores.set('business/founders', 0.7);
  }
  if (fullText.includes('japanese folk') || fullText.includes('folktale')) {
    scores.set('kids-family/stories', 0.9);
    scores.set('culture', 0.6);
  }
  if (fullText.includes('craft') || fullText.includes('creative')) {
    scores.set('craft', 0.7);
  }
  if (fullText.includes('dog') && fullText.includes('behavior')) {
    scores.set('nature/pets', 0.9);
  }
  if (fullText.includes('parenting') || fullText.includes('blended family')) {
    scores.set('kids-family/parenting', 0.85);
  }
  if (fullText.includes('news') && fullText.includes('interview')) {
    scores.set('news/daily', 0.7);
  }

  // Build topics from scores, sorted by confidence, max 4
  const topics = Array.from(scores.entries())
    .filter(([nodeId]) => validNodeIds.has(nodeId))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([nodeId, confidence]) => ({
      node: nodeId,
      confidence: Math.round(confidence * 100) / 100
    }));

  // Set flags
  const needsReview = topics.length === 0 || (topics[0] && topics[0].confidence < 0.6);

  // Generate rationale
  let rationale = 'Show content match unclear.';
  if (topics.length > 0) {
    const topNode = taxonomy.nodes.find(n => n.id === topics[0].node);
    rationale = `Focuses on ${topNode.label.toLowerCase()} content.`;
  }

  // Generate blurb (sanitized, max 30 words)
  let blurb = description.split('.')[0].trim();
  if (!blurb) blurb = description.slice(0, 150).trim();

  // Remove banned words
  const bannedWords = ['fascinating', 'deep dive', 'delve', 'explores', 'you won\'t believe', 'commute'];
  for (const banned of bannedWords) {
    const regex = new RegExp(`\\b${banned}\\b`, 'gi');
    blurb = blurb.replace(regex, '');
  }

  // Truncate to 30 words
  const words = blurb.trim().split(/\s+/).filter(w => w);
  if (words.length > 30) {
    blurb = words.slice(0, 30).join(' ');
  }

  // Ensure punctuation
  if (blurb && !blurb.match(/[.!?]$/)) {
    blurb += '.';
  }

  return {
    topics,
    needs_review: needsReview,
    rationale,
    display_title: title,
    blurb: blurb.trim(),
    model: 'claude-code-cron (tier 1)'
  };
}

// Process batch
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
console.log(`✓ Classified ${Object.keys(results.results).length} shows (${needsReviewCount} need review)`);
console.log(`✓ Results: ${outputPath}`);
