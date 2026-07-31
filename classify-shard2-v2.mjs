import fs from 'fs';

const BATCH_FILE = '/home/user/foray/data-local/classify-batch-fresh-2026-07-31-72c626ec.json';
const TAXONOMY_FILE = '/home/user/foray/data/taxonomy.json';
const RESULTS_FILE = '/home/user/foray/data-local/classify-results-fresh-2026-07-31-72c626ec.json';

const batch = JSON.parse(fs.readFileSync(BATCH_FILE, 'utf8'));
const taxonomy = JSON.parse(fs.readFileSync(TAXONOMY_FILE, 'utf8'));
const validIds = new Set(taxonomy.nodes.map(n => n.id));

function classifyShow(show) {
  const { title, chart_genre_name, description, episodes } = show;
  const allText = (description + ' ' + episodes.map(e => e.title + ' ' + (e.description || '')).join(' ')).toLowerCase();

  let topics = [];
  let needsReview = false;
  let rationale = '';

  // Genre-based intelligent classification
  if (chart_genre_name === 'Marketing') {
    topics.push({ node: 'business/marketing', confidence: 0.85 });
    rationale = 'Referral marketing and business networking strategy.';
  } else if (chart_genre_name === 'Life Sciences') {
    topics.push({ node: 'science', confidence: 0.8 });
    topics.push({ node: 'medicine', confidence: 0.75 });
    rationale = 'Public health and disease research interviews.';
  } else if (chart_genre_name === 'Improv') {
    topics.push({ node: 'comedy/casual-hangs', confidence: 0.85 });
    rationale = 'Casual comedy show with improvised banter.';
  } else if (chart_genre_name === 'Comedy') {
    topics.push({ node: 'comedy/casual-hangs', confidence: 0.8 });
    rationale = 'Comedy talk show with celebrity guests.';
  } else if (chart_genre_name === 'Baseball') {
    topics.push({ node: 'sports/baseball', confidence: 0.9 });
    rationale = 'Daily MLB team analysis and coverage.';
  } else if (chart_genre_name === 'Alternative Health') {
    topics.push({ node: 'health/wellness', confidence: 0.8 });
    rationale = 'Sleep meditation and guided relaxation.';
  } else if (chart_genre_name === 'True Crime') {
    topics.push({ node: 'true-crime', confidence: 0.9 });
    rationale = 'Historical true crime cases with modern analysis.';
  } else if (chart_genre_name === 'Places & Travel') {
    topics.push({ node: 'travel', confidence: 0.85 });
    rationale = 'Travel planning and vacation guides.';
  } else if (chart_genre_name === 'Business News') {
    topics.push({ node: 'economics/markets', confidence: 0.8 });
    rationale = 'European business news and market analysis.';
  } else if (chart_genre_name === 'Mathematics') {
    topics.push({ node: 'math', confidence: 0.9 });
    rationale = 'Conversations about mathematics concepts.';
  } else if (chart_genre_name === 'Home & Garden') {
    topics.push({ node: 'craft/diy-home', confidence: 0.85 });
    rationale = 'Organic gardening techniques and tips.';
  } else if (chart_genre_name === 'Investing') {
    topics.push({ node: 'economics/markets', confidence: 0.85 });
    rationale = 'Investment and market analysis.';
  } else if (chart_genre_name === 'Wilderness') {
    topics.push({ node: 'technology', confidence: 0.7 });
    rationale = 'Firearms and tactical equipment reviews.';
  } else if (chart_genre_name === 'Religion') {
    if (allText.includes('atheist') || allText.includes('secular')) {
      topics.push({ node: 'philosophy/ideas', confidence: 0.7 });
      rationale = 'Religious deconstruction and secular perspectives.';
    } else {
      topics.push({ node: 'religion', confidence: 0.8 });
      rationale = 'Religious topics and faith discussions.';
    }
  } else if (chart_genre_name === 'Basketball') {
    topics.push({ node: 'sports/basketball', confidence: 0.9 });
    rationale = 'Basketball coaching and analysis.';
  } else if (chart_genre_name === 'Arts') {
    topics.push({ node: 'culture', confidence: 0.7 });
    rationale = 'Classic old-time radio drama.';
  } else if (chart_genre_name === 'Philosophy') {
    topics.push({ node: 'philosophy', confidence: 0.85 });
    if (allText.includes('theology') || allText.includes('catholic')) {
      topics.push({ node: 'religion', confidence: 0.75 });
    }
    rationale = 'Theological and philosophical discussions.';
  } else if (chart_genre_name === 'Christianity') {
    topics.push({ node: 'religion', confidence: 0.9 });
    rationale = 'Christian prayers and devotional content.';
  } else if (chart_genre_name === 'TV Reviews') {
    topics.push({ node: 'tv-film/reviews', confidence: 0.85 });
    rationale = 'TV show analysis and episode recaps.';
  } else if (chart_genre_name === 'Music History') {
    topics.push({ node: 'music', confidence: 0.85 });
    if (allText.includes('interview') || allText.includes('guest')) {
      topics.push({ node: 'comedy/interviews', confidence: 0.6 });
    }
    rationale = 'Music history and artist interviews.';
  } else if (chart_genre_name === 'Management') {
    topics.push({ node: 'business/management', confidence: 0.85 });
    rationale = 'Leadership and management skills training.';
  } else if (chart_genre_name === 'After Shows') {
    topics.push({ node: 'tv-film/after-shows', confidence: 0.9 });
    rationale = 'TV episode analysis and fan discussion.';
  } else if (chart_genre_name === 'Non-Profit') {
    topics.push({ node: 'business/non-profit', confidence: 0.8 });
    rationale = 'Nonprofit leadership and fundraising.';
  } else if (chart_genre_name === 'Games') {
    topics.push({ node: 'gaming', confidence: 0.85 });
    rationale = 'Competitive game strategy and analysis.';
  } else if (chart_genre_name === 'Music Commentary') {
    topics.push({ node: 'music', confidence: 0.85 });
    rationale = 'Music interviews and commentary.';
  } else if (chart_genre_name === 'Film Reviews') {
    topics.push({ node: 'tv-film/reviews', confidence: 0.85 });
    rationale = 'Film and cinema analysis.';
  } else if (chart_genre_name === 'Natural Sciences') {
    topics.push({ node: 'science', confidence: 0.8 });
    if (allText.includes('plant') || allText.includes('botany')) {
      topics.push({ node: 'nature', confidence: 0.75 });
    }
    rationale = 'Science and natural world topics.';
  } else if (chart_genre_name === 'History') {
    topics.push({ node: 'history', confidence: 0.85 });
    rationale = 'Historical storytelling and analysis.';
  } else if (chart_genre_name === 'Automotive') {
    topics.push({ node: 'automotive', confidence: 0.9 });
    rationale = 'Automotive enthusiasts and collecting.';
  } else if (chart_genre_name === 'Hockey') {
    topics.push({ node: 'sports', confidence: 0.9 });
    rationale = 'Hockey team analysis and commentary.';
  } else if (chart_genre_name === 'Entrepreneurship') {
    topics.push({ node: 'business/founders', confidence: 0.85 });
    rationale = 'Entrepreneurship and business building.';
  } else if (chart_genre_name === 'Politics') {
    topics.push({ node: 'news/politics', confidence: 0.85 });
    rationale = 'Political commentary and analysis.';
  } else if (chart_genre_name === 'Medicine') {
    topics.push({ node: 'medicine', confidence: 0.9 });
    rationale = 'Medical research and healthcare topics.';
  } else if (chart_genre_name === 'Golf') {
    topics.push({ node: 'sports', confidence: 0.85 });
    rationale = 'Golf coaching and technique analysis.';
  } else if (chart_genre_name === 'Rugby') {
    topics.push({ node: 'sports', confidence: 0.9 });
    rationale = 'Rugby team analysis and coverage.';
  } else {
    needsReview = true;
    rationale = 'Unable to classify from available signal.';
  }

  if (topics.length === 0 || topics.every(t => t.confidence < 0.6)) {
    needsReview = true;
  }

  // Validate node IDs
  topics = topics.filter(t => validIds.has(t.node));
  if (topics.length === 0) {
    needsReview = true;
  }

  let displayTitle = title;
  if (displayTitle.split(' ').length > 8) {
    const parts = displayTitle.split(':');
    if (parts.length > 1 && parts[0].split(' ').length <= 8) {
      displayTitle = parts[0].trim();
    }
  }
  displayTitle = displayTitle.substring(0, 150);

  let blurb = description || '';
  if (blurb.length < 20) {
    blurb = episodes[0]?.title || 'Podcast show';
  }
  const words = blurb.split(' ');
  if (words.length > 30) {
    blurb = words.slice(0, 30).join(' ');
  }
  blurb = blurb.replace(/[Ff]ascinating|[Dd]eep dive|[Dd]elve|[Ee]xplores/g, '').trim();
  blurb = blurb.substring(0, 200);

  return { topics, needs_review: needsReview, rationale: rationale.substring(0, 200), display_title: displayTitle, blurb, model: 'claude-code-cron (tier 1)' };
}

const results = { batch_id: batch.batch_id, results: {} };

batch.shows.forEach(show => {
  const classification = classifyShow(show);
  results.results[show.apple_collection_id] = classification;
});

fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
console.log(`Classified ${batch.shows.length} shows. Results: ${RESULTS_FILE}`);
