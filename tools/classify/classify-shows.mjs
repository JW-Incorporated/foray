import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const batchFile = process.argv[2] || '/home/user/foray/data-local/classify-batch-fresh-2026-08-08-990b6098.json';

const batch = JSON.parse(fs.readFileSync(batchFile, 'utf8'));
const taxonomy = JSON.parse(fs.readFileSync('/home/user/foray/data/taxonomy.json', 'utf8'));

// Build taxonomy lookup
const nodeMap = {};
taxonomy.nodes.forEach(n => nodeMap[n.id] = n);

function analyzeShow(show) {
  const { title, description, episodes, tier0_prior, apple_genre } = show;
  const text = `${title} ${description} ${episodes.map(e => `${e.title} ${e.description}`).join(' ')}`.toLowerCase();

  const scores = {};

  // Default broad categories based on content
  const keywords = {
    'business/careers': ['career', 'job', 'work', 'employment', 'entrepreneurship', 'business', 'startup', 'founder'],
    'business/startups': ['startup', 'founder', 'venture', 'entrepreneur', 'tech company'],
    'space': ['space', 'mars', 'spacex', 'nasa', 'rocket', 'astronaut', 'moon', 'starship'],
    'space/rockets': ['spacex', 'rocket', 'launch', 'starship'],
    'comedy/stand-up': ['comedy', 'stand-up', 'comedian', 'joke', 'funny', 'humor', 'laugh'],
    'travel': ['travel', 'trip', 'journey', 'vacation', 'airline', 'hotel'],
    'aviation': ['airline', 'flight', 'aviation', 'pilot'],
    'engineering': ['engineering', 'manufacturing', 'technology', 'tech'],
    'nature': ['nature', 'animal', 'wildlife', 'environment', 'ocean', 'earth'],
    'science': ['science', 'research', 'study', 'discovery', 'scientific'],
    'education': ['education', 'learn', 'course', 'lesson', 'teaching'],
    'news/politics': ['politics', 'political', 'government', 'election', 'policy'],
    'history': ['history', 'historical', 'past', 'ancient', 'war'],
    'culture/books': ['book', 'literature', 'author', 'writing'],
    'health': ['health', 'fitness', 'wellness', 'exercise', 'diet'],
    'music': ['music', 'song', 'musician', 'artist', 'album'],
    'true-crime': ['crime', 'murder', 'criminal', 'investigation'],
  };

  // Score each potential category
  Object.entries(keywords).forEach(([cat, words]) => {
    let score = 0;
    words.forEach(w => {
      const count = (text.match(new RegExp(w, 'g')) || []).length;
      score += count;
    });
    if (score > 0) scores[cat] = score;
  });

  // Sort by score and get top matches
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);

  const topics = [];
  const seenParents = new Set();

  // Get top 2-4 unique parent categories
  sorted.slice(0, 6).forEach(([nodeId, score]) => {
    const node = nodeMap[nodeId];
    if (!node) return;

    const parent = node.parent ? node.parent.split('/')[0] : nodeId.split('/')[0];
    if (seenParents.has(parent)) return;
    seenParents.add(parent);

    const confidence = Math.min(0.5 + (score / 10), 0.95);
    if (confidence >= 0.3) {
      topics.push({
        node: nodeId,
        confidence: parseFloat(confidence.toFixed(2))
      });
    }
  });

  // Use tier0_prior if no strong matches
  if (topics.length === 0 && tier0_prior?.topics?.length > 0) {
    topics.push({
      node: tier0_prior.topics[0],
      confidence: 0.5
    });
  }

  const needsReview = topics.length === 0 || Math.max(...topics.map(t => t.confidence)) < 0.6;

  // Create rationale
  const topTopic = topics.length > 0 ? topics[0].node.split('/')[0] : 'general';
  const rationale = `Podcast about ${topTopic} based on title and episode content.`.substring(0, 100);

  // Keep real title, enforce word limit
  const displayTitle = title.split(' ').slice(0, 8).join(' ');

  // Create blurb from description (first sentence, max 30 words)
  let blurb = description.split('.')[0].replace(/&#\d+;/g, '').trim();
  const words = blurb.split(/\s+/);
  if (words.length > 30) {
    blurb = words.slice(0, 30).join(' ') + '.';
  } else if (!blurb.endsWith('.')) {
    blurb += '.';
  }

  return {
    topics: topics.length > 0 ? topics : [],
    needs_review: needsReview || topics.length === 0,
    rationale,
    display_title: displayTitle,
    blurb: blurb.substring(0, 150)
  };
}

const results = {
  batch_id: batch.batch_id,
  results: {}
};

batch.shows.forEach(show => {
  const classification = analyzeShow(show);
  results.results[show.apple_collection_id] = {
    topics: classification.topics,
    needs_review: classification.needs_review,
    rationale: classification.rationale,
    display_title: classification.display_title,
    blurb: classification.blurb,
    model: 'claude-code-cron (tier 1)'
  };
});

const outputPath = `/home/user/foray/data-local/classify-results-${batch.batch_id}.json`;
fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
console.log(`Classified ${Object.keys(results.results).length} shows -> ${outputPath}`);
