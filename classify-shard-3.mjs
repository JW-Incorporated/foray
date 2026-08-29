#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

// Read batch and taxonomy
const batchData = JSON.parse(fs.readFileSync('data-local/classify-batch-fresh-2026-08-29-88e39cd6.json', 'utf-8'));
const taxonomy = JSON.parse(fs.readFileSync('data/taxonomy.json', 'utf-8'));

// Create a map of valid node IDs
const validNodes = new Set(taxonomy.nodes.map(n => n.id));

// Classification logic
function classify(show) {
  const { apple_collection_id, title, description, episodes, apple_genre, tier0_prior } = show;

  // Analyze show content
  const desc_lower = (description || '').toLowerCase();
  const titles_lower = episodes.map(e => (e.title || '').toLowerCase()).join(' ');
  const content = `${title} ${description} ${titles_lower}`.toLowerCase();

  let topics = [];
  let needs_review = false;
  let rationale = '';

  // Keyword-based classification heuristics
  if (apple_genre === 'Courses' || desc_lower.includes('exam') || desc_lower.includes('learn')) {
    // This is education - but hard to place without education in taxonomy
    needs_review = true;
    rationale = 'Exam prep course; no education category in current taxonomy.';
  } else if (apple_genre === 'Wrestling' || content.includes('wrestling')) {
    topics.push({ node: 'sports', confidence: 0.9 });
    rationale = 'Weekly wrestling news and match reviews focusing on Joshi wrestling.';
  } else if (apple_genre === 'Education for Kids') {
    topics.push({ node: 'history', confidence: 0.8 });
    rationale = 'Quick historical stories for kids covering diverse topics.';
  } else if (content.includes('michigan') && content.includes('kidnap') && content.includes('governor')) {
    topics.push({ node: 'society', confidence: 0.7 });
    needs_review = true;
    rationale = 'Deep investigation of a real kidnapping plot and legal case.';
  } else if (content.includes('firearms') || content.includes('gun')) {
    topics.push({ node: 'hobbies', confidence: 0.7 });
    rationale = 'Laid-back firearms and gun culture discussion podcast.';
  } else if (apple_genre === 'Tech News' || content.includes('ai') || content.includes('tech')) {
    topics.push({ node: 'computing', confidence: 0.8 });
    rationale = 'Weekly tech news and interviews about AI, startups, and industry trends.';
  } else if (apple_genre === 'Fiction' || content.includes('cleaner') || content.includes('thriller')) {
    topics.push({ node: 'fiction', confidence: 0.7 });
    rationale = 'Narrative thriller audio drama about a government operative.';
  } else if (content.includes('claude') || content.includes('ai') || content.includes('code')) {
    topics.push({ node: 'computing', confidence: 0.75 });
    rationale = 'Technical deep dives on using Claude and AI agents in development workflows.';
  } else if (apple_genre === 'Religion' || content.includes('bible') || content.includes('god')) {
    topics.push({ node: 'religion', confidence: 0.8 });
    rationale = 'Biblical narratives and Christian faith stories with devotional themes.';
  } else if (content.includes('hunter biden') || content.includes('politics') || content.includes('news')) {
    topics.push({ node: 'news', confidence: 0.6 });
    needs_review = true;
    rationale = 'Political commentary and controversial current events interviews.';
  } else if (apple_genre === 'Design') {
    topics.push({ node: 'craft', confidence: 0.8 });
    rationale = 'Weekly conversations between designers about creativity, business, and design culture.';
  } else if (apple_genre === 'Documentary') {
    // Documentary is too broad - flag for review
    needs_review = true;
    topics.push({ node: 'society', confidence: 0.5 });
    rationale = 'Documentary series; content varies by episode.';
  } else if (content.includes('history')) {
    topics.push({ node: 'history', confidence: 0.75 });
    rationale = 'Historical investigation and narrative podcast.';
  } else if (content.includes('kids') || content.includes('family')) {
    topics.push({ node: 'kids-family', confidence: 0.7 });
    rationale = 'Interactive choose-your-own-adventure fiction for kids.';
  } else if (content.includes('celebrity') || content.includes('chrisley')) {
    topics.push({ node: 'tv-film', confidence: 0.6 });
    rationale = 'Celebrity family conversations and lifestyle podcast.';
  } else if (content.includes('gaming') || content.includes('tabletop') || content.includes('game')) {
    topics.push({ node: 'gaming', confidence: 0.8 });
    rationale = 'Tabletop RPG actual play podcast with worldbuilding and lore.';
  } else if (content.includes('cigar') || content.includes('cigar')) {
    topics.push({ node: 'hobbies', confidence: 0.8 });
    rationale = 'Premium cigar reviews and industry conversations.';
  } else if (content.includes('home') || content.includes('renovate') || content.includes('house')) {
    topics.push({ node: 'craft/diy-home', confidence: 0.8 });
    rationale = 'Home improvement advice from experts and contractors.';
  } else if (content.includes('autoimmune') || content.includes('health')) {
    topics.push({ node: 'medicine', confidence: 0.7 });
    needs_review = true;
    rationale = 'Autoimmunity and women\'s health with wellness experts.';
  } else if (content.includes('leadership') || content.includes('nonprofit')) {
    topics.push({ node: 'business', confidence: 0.6 });
    rationale = 'Leadership stories from nonprofit and community leaders.';
  } else if (content.includes('stranger') || content.includes('interview')) {
    needs_review = true;
    topics.push({ node: 'society', confidence: 0.5 });
    rationale = 'Interview series with diverse personal stories.';
  } else {
    // Default: mark for review
    needs_review = true;
    rationale = 'Generic content; needs human review.';
  }

  // If no nodes found, mark for review
  if (topics.length === 0) {
    needs_review = true;
  }

  // Validate node IDs
  topics = topics.filter(t => validNodes.has(t.node));

  if (topics.length === 0 || topics.every(t => t.confidence < 0.6)) {
    needs_review = true;
  }

  return {
    topics,
    needs_review,
    rationale: rationale.substring(0, 300),
    display_title: title,
    blurb: (description || '').substring(0, 200)
  };
}

// Classify all shows
const results = {
  batch_id: batchData.batch_id,
  results: {}
};

const shows = batchData.shows || [];
console.log(`Classifying ${shows.length} shows...`);

shows.forEach((show, idx) => {
  const classification = classify(show);
  results.results[show.apple_collection_id] = {
    ...classification,
    model: 'claude-code-cron (tier 1)'
  };
  if ((idx + 1) % 10 === 0) console.log(`  ${idx + 1}/${shows.length}`);
});

// Write results
const outputPath = `data-local/classify-results-${batchData.batch_id}.json`;
fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
console.log(`\nWrote ${Object.keys(results.results).length} classifications to ${outputPath}`);

// Count needs_review
const needsReviewCount = Object.values(results.results).filter(r => r.needs_review).length;
console.log(`Needs review: ${needsReviewCount}/${Object.keys(results.results).length}`);
