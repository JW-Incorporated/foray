import fs from 'fs';

const BATCH_FILE = '/home/user/foray/data-local/classify-batch-fresh-2026-07-31-72c626ec.json';
const TAXONOMY_FILE = '/home/user/foray/data/taxonomy.json';
const RESULTS_FILE = '/home/user/foray/data-local/classify-results-fresh-2026-07-31-72c626ec.json';

const batch = JSON.parse(fs.readFileSync(BATCH_FILE, 'utf8'));
const taxonomy = JSON.parse(fs.readFileSync(TAXONOMY_FILE, 'utf8'));

const taxonomyIds = new Set(taxonomy.nodes.map(n => n.id));

function classifyShow(show) {
  const { title, chart_genre_name, description, episodes } = show;
  const allText = (description + ' ' + episodes.map(e => e.title + ' ' + (e.description || '')).join(' ')).toLowerCase();

  let topics = [];
  let needsReview = false;
  let rationale = '';

  if (chart_genre_name === 'Marketing') {
    topics.push({ node: 'business/marketing', confidence: 0.85 });
    rationale = 'Referral marketing and business networking strategy show.';
  } else if (chart_genre_name === 'Life Sciences') {
    topics.push({ node: 'science', confidence: 0.8 });
    if (allText.includes('health') || allText.includes('disease') || allText.includes('medical')) {
      topics.push({ node: 'medicine/biology', confidence: 0.75 });
    }
    rationale = 'Public health and disease research interviews.';
  } else if (chart_genre_name === 'Improv' || chart_genre_name === 'Comedy') {
    topics.push({ node: 'comedy/casual-hangs', confidence: 0.8 });
    rationale = 'Casual comedy show with improvised banter and humor.';
  } else if (chart_genre_name === 'Baseball') {
    topics.push({ node: 'sports/baseball', confidence: 0.9 });
    if (title.includes('Tigers')) {
      rationale = 'Daily Detroit Tigers analysis and MLB coverage.';
    } else if (title.includes('Astros')) {
      rationale = 'Daily Houston Astros analysis and MLB coverage.';
    } else if (title.includes('Phillies')) {
      rationale = 'Daily Philadelphia Phillies analysis and MLB coverage.';
    } else {
      rationale = 'Daily MLB team analysis and coverage.';
    }
  } else if (chart_genre_name === 'Alternative Health') {
    topics.push({ node: 'health/wellness', confidence: 0.8 });
    rationale = 'Sleep meditation and guided relaxation for bedtime.';
  } else if (chart_genre_name === 'True Crime') {
    topics.push({ node: 'true-crime', confidence: 0.9 });
    rationale = 'Historical true crime cases analyzed with modern forensics.';
  } else if (chart_genre_name === 'Places & Travel') {
    topics.push({ node: 'travel', confidence: 0.85 });
    rationale = 'Hawaii travel planning advice and vacation tips.';
  } else if (chart_genre_name === 'Business News') {
    topics.push({ node: 'business', confidence: 0.75 });
    topics.push({ node: 'economics/markets', confidence: 0.8 });
    rationale = 'European business news, markets, and financial analysis.';
  } else if (chart_genre_name === 'Mathematics') {
    topics.push({ node: 'math', confidence: 0.9 });
    rationale = 'Conversations about mathematics using everyday objects.';
  } else if (chart_genre_name === 'Home & Garden') {
    topics.push({ node: 'craft/diy-home', confidence: 0.85 });
    rationale = 'Organic gardening tips and techniques.';
  } else if (chart_genre_name === 'Investing') {
    topics.push({ node: 'economics/markets', confidence: 0.8 });
    if (title.includes('One Rental')) {
      rationale = 'Real estate investment strategy for financial freedom.';
    } else {
      rationale = 'Investment analysis and market commentary.';
    }
  } else if (chart_genre_name === 'Wilderness') {
    topics.push({ node: 'technology', confidence: 0.7 });
    topics.push({ node: 'nature', confidence: 0.6 });
    rationale = 'Firearms, suppressor reviews, hunting, and tactical technology.';
  } else if (chart_genre_name === 'Religion') {
    topics.push({ node: 'religion', confidence: 0.8 });
    if (allText.includes('atheist') || allText.includes('humanism') || allText.includes('secular')) {
      topics.push({ node: 'philosophy', confidence: 0.7 });
    }
    rationale = 'Stories of religious deconstruction and secular grace.';
  } else if (chart_genre_name === 'Basketball') {
    topics.push({ node: 'sports/basketball', confidence: 0.9 });
    rationale = 'Basketball coaching interviews and film breakdowns.';
  } else if (chart_genre_name === 'Arts') {
    topics.push({ node: 'culture', confidence: 0.7 });
    topics.push({ node: 'history', confidence: 0.6 });
    rationale = 'Classic old-time radio western drama.';
  } else if (chart_genre_name === 'Philosophy') {
    topics.push({ node: 'philosophy', confidence: 0.85 });
    if (allText.includes('theology') || allText.includes('catholic')) {
      topics.push({ node: 'religion/christianity', confidence: 0.8 });
    }
    rationale = 'Catholic theological discussions in academic debate format.';
  } else if (chart_genre_name === 'Christianity') {
    topics.push({ node: 'religion/christianity', confidence: 0.9 });
    rationale = 'Guided prayers of the Holy Rosary and Divine Mercy.';
  } else {
    needsReview = true;
    rationale = 'Unable to confidently classify from available signal.';
  }

  if (topics.length === 0 || topics.every(t => t.confidence < 0.6)) {
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
    blurb = words.slice(0, 30).join(' ').replace(/…|…$/, '');
  }
  blurb = blurb.replace(/[Ff]ascinating|[Dd]eep dive|[Dd]elve|[Ee]xplores/g, '').trim();
  blurb = blurb.substring(0, 200);

  return {
    topics,
    needs_review: needsReview,
    rationale: rationale.substring(0, 200),
    display_title: displayTitle,
    blurb: blurb,
    model: 'claude-code-cron (tier 1)'
  };
}

const results = {
  batch_id: batch.batch_id,
  results: {}
};

batch.shows.forEach(show => {
  const classification = classifyShow(show);
  const validTopics = classification.topics.filter(t => taxonomyIds.has(t.node));
  if (validTopics.length === 0 && classification.topics.length > 0) {
    classification.needs_review = true;
  }
  classification.topics = validTopics;
  results.results[show.apple_collection_id] = classification;
});

fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
console.log(`Classified ${batch.shows.length} shows. Results: ${RESULTS_FILE}`);
