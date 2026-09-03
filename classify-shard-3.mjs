#!/usr/bin/env node

import fs from 'fs';

const batchPath = '/home/user/foray/data-local/classify-batch-fresh-2026-09-03-a031bc07.json';
const taxonomyPath = '/home/user/foray/data/taxonomy.json';
const resultsPath = '/home/user/foray/data-local/classify-results-fresh-2026-09-03-a031bc07.json';

const batch = JSON.parse(fs.readFileSync(batchPath, 'utf8'));
const taxonomy = JSON.parse(fs.readFileSync(taxonomyPath, 'utf8'));

// Create node lookup
const nodeById = {};
taxonomy.nodes.forEach(n => {
  nodeById[n.id] = n;
});

// Classification logic
function classifyShow(show) {
  const title = show.title.trim();
  const desc = (show.description || '').toLowerCase();
  const episodes = show.episodes || [];
  const tier0 = show.tier0_prior?.topics || [];

  // Build signal from episodes
  const episodeText = episodes
    .map(e => `${e.title || ''} ${e.description || ''}`.toLowerCase())
    .join(' ');

  const signal = `${title.toLowerCase()} ${desc} ${episodeText}`;

  // Classify based on content patterns and tier0 prior
  const topics = [];
  let needsReview = false;
  let rationale = '';

  // Pattern-based classification - simple but precise matching
  if (signal.includes('classical') || signal.includes('orchestra') || signal.includes('music')) {
    if (signal.includes('children') || signal.includes('kids') || signal.includes('education')) {
      topics.push({ node: 'education', confidence: 0.8 });
      topics.push({ node: 'music', confidence: 0.75 });
      rationale = 'Educational classical music program for children.';
    } else if (signal.includes('theory') || signal.includes('production')) {
      topics.push({ node: 'music/theory-production', confidence: 0.7 });
      rationale = 'Music theory and production focused.';
    } else {
      topics.push({ node: 'music', confidence: 0.8 });
      rationale = 'Music-focused content.';
    }
  }

  if (signal.includes('photography') || signal.includes('photograph')) {
    topics.push({ node: 'craft/photography', confidence: 0.85 });
    if (signal.includes('street')) rationale = 'Street and documentary photography.';
  }

  if (signal.includes('spanish') || signal.includes('language') || signal.includes('español')) {
    topics.push({ node: 'education/language-learning', confidence: 0.9 });
    topics.push({ node: 'linguistics/language', confidence: 0.7 });
    rationale = 'Spanish language learning and Latin American culture.';
  }

  if (signal.includes('hockey') || signal.includes('predators')) {
    topics.push({ node: 'sports/hockey', confidence: 0.95 });
    rationale = 'Nashville Predators hockey analysis.';
  }

  if (signal.includes('overlanding') || signal.includes('adventure') || signal.includes('offroad') || signal.includes('4x4')) {
    topics.push({ node: 'adventure/exploration', confidence: 0.85 });
    topics.push({ node: 'travel', confidence: 0.7 });
    rationale = 'Overland adventure travel and guides.';
  }

  if (signal.includes('wrestling') || signal.includes('ring of honor') || signal.includes('roh')) {
    topics.push({ node: 'sports/wrestling', confidence: 0.95 });
    rationale = 'Ring of Honor wrestling show-by-show review.';
  }

  if (signal.includes('marketing') || signal.includes('consumer insights') || signal.includes('brand')) {
    topics.push({ node: 'business/marketing', confidence: 0.85 });
    rationale = 'Marketing strategy and consumer insights.';
  }

  if (signal.includes('cricket') || signal.includes('women\'s cricket')) {
    topics.push({ node: 'sports/cricket', confidence: 0.95 });
    rationale = 'Women\'s cricket news and interviews.';
  }

  if (signal.includes('plant') || signal.includes('houseplant') || signal.includes('garden') || signal.includes('horticulture')) {
    topics.push({ node: 'craft/diy-home', confidence: 0.8 });
    rationale = 'Houseplant care and gardening.';
  }

  if (signal.includes('football') || signal.includes('nfl')) {
    topics.push({ node: 'sports/football', confidence: 0.9 });
    rationale = 'NFL history and current season analysis.';
  }

  if (signal.includes('fiction') || signal.includes('drama') || signal.includes('audio drama') || signal.includes('podcast')) {
    if (signal.includes('monster') || signal.includes('shadow') || signal.includes('mystery')) {
      topics.push({ node: 'fiction/drama', confidence: 0.8 });
      rationale = 'Audio drama with mystery and supernatural elements.';
    }
  }

  if (signal.includes('interview') || signal.includes('career') || signal.includes('job')) {
    if (!topics.some(t => t.node.includes('career'))) {
      topics.push({ node: 'business/careers', confidence: 0.85 });
      rationale = 'Career and job interview advice.';
    }
  }

  if (signal.includes('business') || signal.includes('acquisition') || signal.includes('entrepreneurs') || signal.includes('startup')) {
    if (!topics.some(t => t.node.includes('business'))) {
      topics.push({ node: 'business/startups', confidence: 0.8 });
      rationale = 'Business acquisitions and entrepreneurship.';
    }
  }

  if (signal.includes('comedy') || signal.includes('stand-up') || signal.includes('jokes')) {
    topics.push({ node: 'comedy/stand-up', confidence: 0.85 });
    rationale = 'Comedy and stand-up commentary.';
  }

  if (signal.includes('tennis')) {
    topics.push({ node: 'sports/tennis', confidence: 0.95 });
    rationale = 'Tennis tournament analysis and coverage.';
  }

  if (signal.includes('astronomy') || signal.includes('space') || signal.includes('planet') || signal.includes('moon') || signal.includes('star')) {
    topics.push({ node: 'space', confidence: 0.85 });
    rationale = 'Astronomy and night sky observation.';
  }

  if (signal.includes('motherhood') || signal.includes('parenting') || signal.includes('christian mom')) {
    topics.push({ node: 'kids-family/parenting', confidence: 0.9 });
    rationale = 'Christian parenting and faith-building guidance.';
  }

  // Check if no topics were assigned - use tier0 prior
  if (topics.length === 0) {
    needsReview = true;
    if (tier0.length > 0) {
      topics.push({ node: tier0[0], confidence: 0.4 });
      rationale = `Unable to classify confidently; genre suggests ${tier0[0]}.`;
    } else {
      topics.push({ node: 'news', confidence: 0.3 });
      rationale = 'Unable to determine classification.';
    }
  }

  // Check for low confidence
  if (topics.every(t => t.confidence < 0.6)) {
    needsReview = true;
  }

  // Keep real title unchanged
  let displayTitle = title;
  const titleWords = displayTitle.split(/\s+/);
  if (titleWords.length > 8) {
    displayTitle = titleWords.slice(0, 8).join(' ');
  }

  // Create blurb from description
  let blurb = desc;
  if (blurb.length > 150) {
    blurb = blurb.substring(0, 150);
    const lastPeriod = blurb.lastIndexOf('.');
    if (lastPeriod > 0) blurb = blurb.substring(0, lastPeriod + 1);
  }
  const blurbWords = blurb.split(/\s+/).filter(w => w.length > 0);
  if (blurbWords.length > 30) {
    blurb = blurbWords.slice(0, 30).join(' ') + '.';
  }

  return {
    topics: topics,
    needs_review: needsReview,
    rationale: rationale,
    display_title: displayTitle,
    blurb: blurb.trim() || desc.substring(0, 100),
    model: 'claude-code-cron (tier 1)'
  };
}

const results = {
  batch_id: batch.batch_id,
  results: {}
};

let needsReviewCount = 0;
for (const show of batch.shows) {
  const classified = classifyShow(show);
  results.results[show.apple_collection_id] = classified;
  if (classified.needs_review) needsReviewCount++;
}

fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
console.log(`✓ Classified ${Object.keys(results.results).length} shows`);
console.log(`✓ needs_review: ${needsReviewCount}`);
console.log(`✓ Results: ${resultsPath}`);
