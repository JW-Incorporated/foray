#!/usr/bin/env node
import fs from 'fs';

const batch = JSON.parse(fs.readFileSync('data-local/classify-batch-fresh-2026-08-05-b4486c60.json', 'utf8'));

function classify(show) {
  const { apple_collection_id: id, title, description, episodes, apple_genre } = show;
  
  const desc = (description || '').toLowerCase();

  const topics = [];

  // Genre-based classification with correct taxonomy nodes
  if (apple_genre === 'Mathematics' || title.includes('concept')) {
    topics.push({ node: 'science', confidence: 0.8 });
  } else if (apple_genre === 'Stand-Up' || desc.includes('stand-up') || title.includes('ゲイと女')) {
    topics.push({ node: 'comedy', confidence: 0.85 });
  } else if (apple_genre === 'Running') {
    topics.push({ node: 'sports/endurance', confidence: 0.9 });
  } else if (apple_genre === 'TV Reviews') {
    topics.push({ node: 'tv-film/reviews', confidence: 0.85 });
  } else if (apple_genre === 'Earth Sciences' || apple_genre === 'Geography') {
    topics.push({ node: 'nature/earth-science', confidence: 0.85 });
  } else if (apple_genre === 'Golf') {
    topics.push({ node: 'sports/golf', confidence: 0.9 });
  } else if (apple_genre === 'Language Learning') {
    topics.push({ node: 'education/language-learning', confidence: 0.85 });
  } else if (apple_genre === 'Fashion & Beauty') {
    topics.push({ node: 'culture/fashion', confidence: 0.8 });
  } else if (apple_genre === 'Astronomy') {
    topics.push({ node: 'science', confidence: 0.75 });
  } else if (apple_genre === 'Games') {
    topics.push({ node: 'gaming', confidence: 0.85 });
  } else if (apple_genre === 'Islam') {
    topics.push({ node: 'religion/islam', confidence: 0.95 });
  } else if (apple_genre === 'Pets & Animals') {
    topics.push({ node: 'nature/pets', confidence: 0.9 });
  } else if (apple_genre === 'Soccer') {
    topics.push({ node: 'sports/soccer', confidence: 0.9 });
  } else if (apple_genre === 'Music Commentary') {
    topics.push({ node: 'music', confidence: 0.85 });
  } else if (apple_genre === 'Chemistry') {
    topics.push({ node: 'science/chemistry', confidence: 0.85 });
  } else if (apple_genre === 'Buddhism') {
    topics.push({ node: 'religion/buddhism', confidence: 0.9 });
  } else if (apple_genre === 'Mental Health') {
    topics.push({ node: 'health/mental', confidence: 0.85 });
  } else if (apple_genre === 'Places & Travel') {
    topics.push({ node: 'travel', confidence: 0.85 });
  } else if (apple_genre === 'Marketing') {
    topics.push({ node: 'business/marketing', confidence: 0.85 });
  } else if (apple_genre === 'Education for Kids') {
    topics.push({ node: 'kids-family/education', confidence: 0.85 });
  } else if (apple_genre === 'Personal Journals') {
    topics.push({ node: 'personal-journals', confidence: 0.75 });
  } else if (apple_genre === 'Film History') {
    topics.push({ node: 'tv-film/history', confidence: 0.85 });
  } else if (apple_genre === 'Nutrition') {
    topics.push({ node: 'health/nutrition', confidence: 0.85 });
  } else if (apple_genre === 'Automotive') {
    topics.push({ node: 'automotive/racing', confidence: 0.8 });
  } else if (apple_genre === 'TV & Film') {
    topics.push({ node: 'tv-film', confidence: 0.9 });
  } else if (apple_genre === 'Wrestling') {
    topics.push({ node: 'sports/wrestling', confidence: 0.9 });
  } else if (apple_genre === 'Technology') {
    topics.push({ node: 'computing', confidence: 0.85 });
  } else if (apple_genre === 'True Crime') {
    topics.push({ node: 'true-crime', confidence: 0.9 });
  } else if (apple_genre === 'Hinduism') {
    topics.push({ node: 'religion/hinduism', confidence: 0.9 });
  } else if (apple_genre === 'Animation & Manga') {
    topics.push({ node: 'tv-film/animation', confidence: 0.85 });
  } else if (apple_genre === 'Fitness') {
    topics.push({ node: 'health/fitness', confidence: 0.85 });
  } else if (apple_genre === 'Visual Arts') {
    topics.push({ node: 'culture/art', confidence: 0.85 });
  } else if (apple_genre === 'Comedy Interviews') {
    topics.push({ node: 'comedy/interviews', confidence: 0.85 });
  } else {
    topics.push({ node: 'society', confidence: 0.6 });
  }

  // Determine needs_review
  const needsReview = topics.length === 0 || topics.every(t => t.confidence < 0.6);

  // Rationale
  let rationale = title.substring(0, 50);

  // Display title: keep real title
  let displayTitle = title.substring(0, 60);

  // Blurb: grounded in description
  let blurb = desc.substring(0, 120).trim();
  if (!blurb || blurb.length < 10) {
    blurb = `Show about ${apple_genre.toLowerCase()}.`;
  }

  return {
    topics,
    needs_review: needsReview,
    rationale,
    display_title: displayTitle,
    blurb: blurb.substring(0, 180),
    model: 'claude-code-cron (tier 1)'
  };
}

const results = {
  batch_id: batch.batch_id,
  results: {}
};

batch.shows.forEach((show, idx) => {
  results.results[show.apple_collection_id] = classify(show);
});

const resultsPath = `data-local/classify-results-${batch.batch_id}.json`;
fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
console.log(`Classified ${batch.shows.length} shows, written to ${resultsPath}`);
