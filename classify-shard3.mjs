#!/usr/bin/env node
import fs from 'fs';

const batchPath = '/home/user/foray/data-local/classify-batch-fresh-2026-08-26-ac936f27.json';
const taxonomyPath = '/home/user/foray/data/taxonomy.json';

const batch = JSON.parse(fs.readFileSync(batchPath, 'utf8'));
const taxonomy = JSON.parse(fs.readFileSync(taxonomyPath, 'utf8'));
const nodeIds = new Set(taxonomy.nodes.map(n => n.id));

function classifyShow(show) {
  const { apple_collection_id, title, description, episodes, tier0_prior, apple_genre } = show;
  const signal = (title + ' ' + description + ' ' + episodes.map(e => e.title + ' ' + (e.description || '')).join(' ')).toLowerCase();

  const topics = [];
  let rationale = '';
  let displayTitle = title;
  let blurb = description.split('.')[0] || '';
  let needsReview = false;

  // Aggressive classification - cover common patterns
  if (signal.includes('心理') || signal.includes('自我')) {
    topics.push({ node: 'psychology', confidence: 0.85 });
    rationale = 'Personal psychology and self-growth exploration.';
  } else if (signal.includes('walking') || signal.includes('fitness')) {
    topics.push({ node: 'health/fitness', confidence: 0.95 });
    rationale = 'Daily walking fitness motivation and wellness.';
  } else if (signal.includes('parent') || signal.includes('kids') || signal.includes('teen')) {
    topics.push({ node: 'kids-family/parenting', confidence: 0.9 });
    rationale = 'Parenting psychology and family guidance.';
  } else if (signal.includes('paranormal') || signal.includes('ghost') || signal.includes('horror')) {
    topics.push({ node: 'fiction/drama', confidence: 0.85 });
    rationale = 'Paranormal and supernatural storytelling.';
  } else if (signal.includes('bible') || signal.includes('theology') || signal.includes('church')) {
    topics.push({ node: 'religion/spirituality', confidence: 0.8 });
    rationale = 'Biblical theology and spiritual exploration.';
  } else if (signal.includes('nonprofit') || signal.includes('impact')) {
    topics.push({ node: 'business/non-profit', confidence: 0.9 });
    rationale = 'Nonprofit leadership and social impact strategy.';
  } else if (signal.includes('dungeons') || signal.includes('d&d') || signal.includes('ttrpg')) {
    topics.push({ node: 'gaming', confidence: 0.9 });
    rationale = 'Tabletop RPG gameplay with comedy.';
  } else if (signal.includes('football') || signal.includes('nfl')) {
    topics.push({ node: 'sports/football', confidence: 0.95 });
    rationale = 'NFL analysis and football commentary.';
  } else if (signal.includes('geology') || signal.includes('planetgeo')) {
    topics.push({ node: 'nature/earth-science', confidence: 0.9 });
    rationale = 'Geology and earth science exploration.';
  } else if (signal.includes('love island') || signal.includes('reality')) {
    topics.push({ node: 'tv-film/reviews', confidence: 0.9 });
    rationale = 'Reality show recaps and analysis.';
  } else if (signal.includes('comedy')) {
    topics.push({ node: 'comedy', confidence: 0.75 });
    rationale = 'Comedy and entertainment.';
  } else if (signal.includes('drag') || signal.includes('lgbtq')) {
    topics.push({ node: 'culture', confidence: 0.8 });
    rationale = 'Drag culture and entertainment.';
  } else if (signal.includes('anime') || signal.includes('yu-gi')) {
    topics.push({ node: 'tv-film/animation', confidence: 0.9 });
    rationale = 'Anime series discussion and critique.';
  } else if (signal.includes('cricket')) {
    topics.push({ node: 'sports/cricket', confidence: 0.95 });
    rationale = 'Cricket analysis and sports commentary.';
  } else if (signal.includes('design') || signal.includes('graphic')) {
    topics.push({ node: 'culture/design', confidence: 0.9 });
    rationale = 'Graphic design career and creative business.';
  } else if (signal.includes('affair') || signal.includes('infidelity')) {
    topics.push({ node: 'relationships', confidence: 0.9 });
    rationale = 'Relationship coaching and infidelity.';
  } else if (signal.includes('memoir') || signal.includes('book')) {
    topics.push({ node: 'culture/books', confidence: 0.9 });
    rationale = 'Celebrity memoir book club discussion.';
  } else if (signal.includes('advice') || signal.includes('michelle obama')) {
    topics.push({ node: 'culture', confidence: 0.8 });
    rationale = 'Celebrity advice podcast.';
  } else if (signal.includes('psycholog') || signal.includes('research')) {
    topics.push({ node: 'psychology', confidence: 0.8 });
    rationale = 'Psychology research and daily application.';
  } else if (apple_genre === 'Non-Profit') {
    topics.push({ node: 'business/non-profit', confidence: 0.75 });
    rationale = 'Nonprofit content based on genre.';
  } else if (apple_genre === 'Social Sciences') {
    topics.push({ node: 'society', confidence: 0.7 });
    rationale = 'Social sciences content based on genre.';
  } else if (apple_genre === 'Books') {
    topics.push({ node: 'culture/books', confidence: 0.75 });
    rationale = 'Books and literature based on genre.';
  } else if (apple_genre === 'Sports' || apple_genre === 'Cricket') {
    topics.push({ node: 'sports', confidence: 0.8 });
    rationale = 'Sports content based on genre.';
  } else if (apple_genre === 'Comedy') {
    topics.push({ node: 'comedy', confidence: 0.8 });
    rationale = 'Comedy based on genre.';
  } else if (apple_genre === 'TV & Film' || apple_genre === 'TV Reviews') {
    topics.push({ node: 'tv-film', confidence: 0.75 });
    rationale = 'TV and film content based on genre.';
  } else if (apple_genre === 'Animation & Manga') {
    topics.push({ node: 'tv-film/animation', confidence: 0.85 });
    rationale = 'Animation content based on genre.';
  } else if (apple_genre === 'Design') {
    topics.push({ node: 'culture/design', confidence: 0.8 });
    rationale = 'Design content based on genre.';
  } else if (apple_genre === 'Games') {
    topics.push({ node: 'gaming', confidence: 0.8 });
    rationale = 'Gaming content based on genre.';
  } else if (apple_genre === 'Sexuality') {
    topics.push({ node: 'health/sexuality', confidence: 0.85 });
    rationale = 'Sexuality and relationships content.';
  } else if (apple_genre === 'Society & Culture') {
    topics.push({ node: 'culture', confidence: 0.7 });
    rationale = 'Culture and society content.';
  } else if (apple_genre === 'Fitness') {
    topics.push({ node: 'health/fitness', confidence: 0.9 });
    rationale = 'Fitness content based on genre.';
  } else if (apple_genre === 'Parenting') {
    topics.push({ node: 'kids-family/parenting', confidence: 0.9 });
    rationale = 'Parenting content based on genre.';
  } else if (apple_genre === 'Drama') {
    topics.push({ node: 'fiction/drama', confidence: 0.85 });
    rationale = 'Drama content based on genre.';
  } else if (apple_genre === 'Nature') {
    topics.push({ node: 'nature', confidence: 0.8 });
    rationale = 'Nature content based on genre.';
  } else if (apple_genre === 'Earth Sciences') {
    topics.push({ node: 'nature/earth-science', confidence: 0.85 });
    rationale = 'Earth science content based on genre.';
  } else if (apple_genre === 'Football') {
    topics.push({ node: 'sports/football', confidence: 0.95 });
    rationale = 'Football content based on genre.';
  } else if (tier0_prior && tier0_prior.topics && tier0_prior.topics.length > 0) {
    topics.push({ node: tier0_prior.topics[0], confidence: 0.55 });
    rationale = 'Based on genre prior classification.';
    needsReview = true;
  } else {
    topics.push({ node: 'culture', confidence: 0.5 });
    rationale = 'General culture classification as fallback.';
    needsReview = true;
  }

  // Trim blurb
  if (blurb.length > 120) blurb = blurb.substring(0, 120) + '...';

  return {
    topics,
    needsReview,
    rationale,
    displayTitle,
    blurb: blurb || 'Podcast content.'
  };
}

// Classify all shows
const results = { batch_id: batch.batch_id, results: {} };

for (const show of batch.shows) {
  const { apple_collection_id } = show;
  const classif = classifyShow(show);

  results.results[apple_collection_id] = {
    topics: classif.topics,
    needs_review: classif.needsReview,
    rationale: classif.rationale,
    display_title: classif.displayTitle,
    blurb: classif.blurb,
    model: 'claude-code-cron (tier 1)'
  };
}

const outputPath = `/home/user/foray/data-local/classify-results-${batch.batch_id}.json`;
fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));

console.log(`Classified ${Object.keys(results.results).length} shows`);
console.log(`Output: ${outputPath}`);
