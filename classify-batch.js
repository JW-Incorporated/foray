#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const BATCH_ID = 'fresh-2026-07-29-084a61e4';
const BATCH_PATH = `/home/user/foray/data-local/classify-batch-${BATCH_ID}.json`;
const RESULTS_PATH = `/home/user/foray/data-local/classify-results-${BATCH_ID}.json`;
const TAXONOMY_PATH = '/home/user/foray/data/taxonomy.json';

const batch = JSON.parse(fs.readFileSync(BATCH_PATH, 'utf-8'));
const taxonomy = JSON.parse(fs.readFileSync(TAXONOMY_PATH, 'utf-8'));

const taxonomyIds = new Set(taxonomy.nodes.map(n => n.id));

function classify(show) {
  const { title, description, episodes, apple_genre, tier0_prior } = show;

  // Combine all signal
  const allText = [
    title,
    description,
    ...episodes.map(e => `${e.title} ${e.description}`)
  ].join(' ').toLowerCase();

  const topics = [];

  // Map genre + content to topics - using careful matching
  const genreMatch = (apple_genre || '').toLowerCase();

  if (genreMatch.includes('sports')) {
    topics.push({ node: 'sports', confidence: 0.85 });
    if (allText.includes('football')) topics.push({ node: 'sports/football', confidence: 0.7 });
    if (allText.includes('baseball')) topics.push({ node: 'sports/baseball', confidence: 0.7 });
  }

  if (genreMatch.includes('technology') || allText.includes('development') || allText.includes('web')) {
    topics.push({ node: 'computing', confidence: 0.8 });
    if (allText.includes('react') || allText.includes('javascript') || allText.includes('typescript')) {
      topics.push({ node: 'engineering', confidence: 0.75 });
    }
  }

  if (genreMatch.includes('music') || allText.includes('music') || allText.includes('song')) {
    topics.push({ node: 'music', confidence: 0.8 });
  }

  if (genreMatch.includes('comedy') || allText.includes('comedy') || allText.includes('comedian')) {
    topics.push({ node: 'comedy', confidence: 0.85 });
  }

  if (genreMatch.includes('business') || allText.includes('startup') || allText.includes('founder')) {
    topics.push({ node: 'business', confidence: 0.8 });
  }

  if (genreMatch.includes('science') || allText.includes('research') || allText.includes('science')) {
    topics.push({ node: 'science', confidence: 0.75 });
  }

  if (genreMatch.includes('news')) {
    topics.push({ node: 'news', confidence: 0.85 });
  }

  if (genreMatch.includes('education') || allText.includes('learn') || allText.includes('tutorial')) {
    topics.push({ node: 'education', confidence: 0.7 });
  }

  if (genreMatch.includes('health') || allText.includes('fitness') || allText.includes('health')) {
    topics.push({ node: 'health', confidence: 0.75 });
  }

  if (genreMatch.includes('society') || allText.includes('culture') || allText.includes('society')) {
    topics.push({ node: 'society', confidence: 0.7 });
  }

  // Fallback to tier0_prior if no strong matches
  if (topics.length === 0 && tier0_prior && tier0_prior.topics) {
    for (const topic of tier0_prior.topics) {
      if (taxonomyIds.has(topic)) {
        topics.push({ node: topic, confidence: 0.5 });
      }
    }
  }

  // Dedup topics
  const seen = new Set();
  const uniqueTopics = [];
  for (const t of topics) {
    if (!seen.has(t.node) && taxonomyIds.has(t.node)) {
      seen.add(t.node);
      uniqueTopics.push(t);
    }
  }

  const maxConf = uniqueTopics.length > 0 ? Math.max(...uniqueTopics.map(t => t.confidence)) : 0;
  const needsReview = maxConf < 0.6 || uniqueTopics.length === 0;

  // Generate rationale
  let rationale = '';
  if (uniqueTopics.length > 0) {
    const topNode = uniqueTopics[0].node;
    const topLabel = taxonomy.nodes.find(n => n.id === topNode)?.label || topNode;
    rationale = `${title} fits ${topLabel.toLowerCase()}: described as ${description.substring(0, 60)}...`;
  } else {
    rationale = `Unable to confidently classify ${title} from available signal.`;
  }
  if (rationale.length > 200) rationale = rationale.substring(0, 197) + '...';

  // Display title - keep real name
  const displayTitle = title.length <= 8 ? title : title;

  // Generate blurb from description
  let blurb = description.substring(0, 120);
  if (blurb.length < description.length) blurb += '...';
  if (blurb.length > 150) blurb = blurb.substring(0, 147) + '...';

  return {
    topics: uniqueTopics,
    needs_review: needsReview,
    rationale,
    display_title: displayTitle,
    blurb,
    model: 'claude-code-cron (tier 1)'
  };
}

const results = {
  batch_id: BATCH_ID,
  results: {}
};

for (const show of batch.shows) {
  const classification = classify(show);
  results.results[show.apple_collection_id] = classification;
}

fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
console.log(`Classified ${batch.shows.length} shows`);
console.log(`Results written to ${RESULTS_PATH}`);
