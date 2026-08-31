import fs from 'fs';

const batchPath = '/home/user/foray/data-local/classify-batch-fresh-2026-07-31-b56e0c11.json';
const resultsPath = '/home/user/foray/data-local/classify-results-fresh-2026-07-31-b56e0c11.json';

const batch = JSON.parse(fs.readFileSync(batchPath, 'utf8'));

const results = {
  batch_id: batch.batch_id,
  results: {}
};

function classifyShow(show) {
  const id = String(show.apple_collection_id);
  const title = show.title;
  const desc = (show.description || '').toLowerCase();
  const episodes = show.episodes || [];
  const episodeTexts = episodes.map(e => `${e.title} ${e.description}`).join(' ').toLowerCase();
  const fullText = `${title} ${desc} ${episodeTexts}`.toLowerCase();

  let topics = [];
  let needsReview = false;
  let rationale = '';
  let displayTitle = title;
  let blurb = '';

  // Classify based on title and content
  if (title.includes('Blazers') || fullText.includes('portland trail blazers')) {
    topics.push({ node: 'sports/basketball', confidence: 0.95 });
    rationale = 'Daily podcast analyzing Portland Trail Blazers roster, trades, and NBA news.';
    blurb = 'Expert local coverage of the Portland Trail Blazers and NBA.';
  } else if (title.includes('Rockets') && title.includes('Houston')) {
    topics.push({ node: 'sports/basketball', confidence: 0.95 });
    rationale = 'Daily analysis of Houston Rockets players, strategy, and NBA developments.';
    blurb = 'Daily Rockets analysis with local expertise and NBA coverage.';
  } else if (title === 'Everyday Tech') {
    topics.push({ node: 'news/tech', confidence: 0.9 });
    topics.push({ node: 'education/how-to', confidence: 0.6 });
    rationale = 'Consumer technology news, troubleshooting, and product reviews.';
    blurb = 'Weekly guide to consumer tech news, products, and solutions.';
  } else if (title.includes('Celtics')) {
    topics.push({ node: 'sports/basketball', confidence: 0.95 });
    rationale = 'Daily Boston Celtics game analysis and NBA basketball coverage.';
    blurb = 'NBC Sports coverage of Celtics games and NBA analysis.';
  } else if (title === 'Liberty Lockdown') {
    topics.push({ node: 'news/commentary', confidence: 0.7 });
    topics.push({ node: 'news/politics', confidence: 0.6 });
    rationale = 'Political news and libertarian commentary on current events.';
    blurb = 'Political analysis and current affairs commentary.';
    needsReview = true;
  } else if (title.includes('Raiders')) {
    topics.push({ node: 'sports/football', confidence: 0.95 });
    rationale = 'Daily Las Vegas Raiders NFL game analysis and roster coverage.';
    blurb = 'Daily NFL coverage of Las Vegas Raiders games and strategy.';
  } else if (title.includes('Buckeye') || title.includes('Ohio State')) {
    topics.push({ node: 'sports/football', confidence: 0.95 });
    rationale = 'Ohio State Buckeyes college football analysis and game coverage.';
    blurb = 'College football coverage of Ohio State Buckeyes.';
  } else if (title.includes('Panpsycast') || fullText.includes('philosophy')) {
    topics.push({ node: 'philosophy', confidence: 0.85 });
    topics.push({ node: 'philosophy/ideas', confidence: 0.8 });
    rationale = 'Philosophy discussions exploring diverse ideas and thinkers.';
    blurb = 'Philosophical discussions on ideas and human thought.';
  } else if (title.includes('Your Parenting')) {
    topics.push({ node: 'kids-family/parenting', confidence: 0.85 });
    topics.push({ node: 'education/self-improvement', confidence: 0.75 });
    rationale = 'Research-based parenting advice and child development strategies.';
    blurb = 'Research-backed parenting guidance for child development.';
  } else if (title.includes('American Banker')) {
    topics.push({ node: 'news/tech', confidence: 0.7 });
    topics.push({ node: 'economics/markets', confidence: 0.65 });
    rationale = 'Banking industry news and financial technology developments.';
    blurb = 'Banking sector and fintech industry news.';
  } else if (title === 'Behind the Mic') {
    topics.push({ node: 'comedy/interviews', confidence: 0.8 });
    topics.push({ node: 'culture/performing-arts', confidence: 0.7 });
    rationale = 'Interviews with performers, comedians, and entertainment professionals.';
    blurb = 'Behind-the-scenes interviews with comedians and performers.';
  } else if (title.includes('Beltway')) {
    topics.push({ node: 'sports/football', confidence: 0.9 });
    rationale = 'Washington football team coverage and NFL analysis.';
    blurb = 'Football coverage and Washington NFL team analysis.';
  } else if (title === 'Danger Dan\'s Talk Shop') {
    topics.push({ node: 'comedy/casual-hangs', confidence: 0.8 });
    rationale = 'Casual conversations, comedy banter, and entertainment.';
    blurb = 'Comedy conversations with celebrity guests.';
  } else if (title.includes('X-Cast') || title.includes('X-Files')) {
    topics.push({ node: 'tv-film/reviews', confidence: 0.85 });
    topics.push({ node: 'fiction/sci-fi', confidence: 0.8 });
    rationale = 'Episode-by-episode analysis and discussion of X-Files.';
    blurb = 'X-Files episode analysis and series discussion.';
  } else if (title.includes('Pacers')) {
    topics.push({ node: 'sports/basketball', confidence: 0.95 });
    rationale = 'Daily Indiana Pacers NBA game analysis and roster news.';
    blurb = 'Daily coverage of Indiana Pacers NBA games.';
  } else if (title.includes('Jazz')) {
    topics.push({ node: 'music', confidence: 0.9 });
    topics.push({ node: 'culture', confidence: 0.65 });
    rationale = 'Jazz music performances and radio series.';
    blurb = 'Jazz music programming and live performances.';
  } else if (title.includes('Habit')) {
    topics.push({ node: 'health/mental', confidence: 0.85 });
    topics.push({ node: 'education/self-improvement', confidence: 0.75 });
    rationale = 'Mental health strategies and behavioral habit formation.';
    blurb = 'Habit-building and mental health wellness advice.';
  } else if (title.includes('Suns') && title.includes('Phoenix')) {
    topics.push({ node: 'sports/basketball', confidence: 0.95 });
    rationale = 'Daily Phoenix Suns NBA game analysis and basketball coverage.';
    blurb = 'Daily coverage of Phoenix Suns NBA games.';
  } else if (title.includes('What If World')) {
    topics.push({ node: 'kids-family/stories', confidence: 0.95 });
    rationale = 'Imaginative storytelling and creative scenarios for children.';
    blurb = 'Creative storytelling and imaginative adventures for kids.';
  } else if (title.includes('Live Inspired')) {
    topics.push({ node: 'education/self-improvement', confidence: 0.9 });
    topics.push({ node: 'psychology', confidence: 0.7 });
    rationale = 'Motivation and personal development through inspiring stories.';
    blurb = 'Inspirational interviews and personal development.';
  } else if (title.includes('Playbook')) {
    topics.push({ node: 'business/management', confidence: 0.8 });
    topics.push({ node: 'sports', confidence: 0.65 });
    rationale = 'Leadership strategies from sports applied to business.';
    blurb = 'Leadership lessons from sports professionals.';
  } else if (title.includes('Home Service')) {
    topics.push({ node: 'business/startups', confidence: 0.85 });
    rationale = 'Business growth strategies for home service entrepreneurs.';
    blurb = 'Business strategies for home service entrepreneurs.';
  } else if (title.includes('Triathlon')) {
    topics.push({ node: 'sports/endurance', confidence: 0.95 });
    topics.push({ node: 'health/fitness', confidence: 0.75 });
    rationale = 'Triathlon training, racing, and endurance sport advice.';
    blurb = 'Triathlon training tips and endurance sports.';
  } else if (fullText.includes('dj') || fullText.includes('电音') || fullText.includes('瑾')) {
    topics.push({ node: 'music', confidence: 0.85 });
    rationale = 'Electronic dance music and DJ programming.';
    blurb = 'Electronic dance music and DJ mixes.';
  } else if (title === 'Griefcast') {
    topics.push({ node: 'health/mental', confidence: 0.95 });
    rationale = 'Conversations about grief, loss, and bereavement support.';
    blurb = 'Discussions about grief, loss, and emotional support.';
  } else if (title.includes('Wild Ideas')) {
    topics.push({ node: 'adventure/exploration', confidence: 0.9 });
    topics.push({ node: 'travel', confidence: 0.85 });
    rationale = 'Adventure travel stories and exploration of wild places.';
    blurb = 'Adventure travel stories and unique destinations.';
  } else if (title.includes('Tarot')) {
    topics.push({ node: 'paranormal', confidence: 0.85 });
    topics.push({ node: 'religion/spirituality', confidence: 0.7 });
    rationale = 'Tarot readings and spiritual divination practices.';
    blurb = 'Tarot readings and spiritual guidance.';
  } else if (title === 'Famous at Home') {
    topics.push({ node: 'culture/pop-culture', confidence: 0.85 });
    topics.push({ node: 'comedy/interviews', confidence: 0.65 });
    rationale = 'Interviews with celebrities and entertainment personalities.';
    blurb = 'Celebrity interviews and entertainment conversations.';
  } else if (title.includes('Hollywood') && title.includes('Levine')) {
    topics.push({ node: 'tv-film/reviews', confidence: 0.85 });
    topics.push({ node: 'culture/pop-culture', confidence: 0.75 });
    rationale = 'Film and television criticism and entertainment analysis.';
    blurb = 'Film and TV reviews with entertainment analysis.';
  } else if (title.includes('Clean Comedy')) {
    topics.push({ node: 'comedy/stand-up', confidence: 0.9 });
    rationale = 'Stand-up comedy performances and comedian interviews.';
    blurb = 'Family-friendly stand-up comedy shows.';
  } else if (title.includes('Retirement')) {
    topics.push({ node: 'economics/markets', confidence: 0.8 });
    topics.push({ node: 'education/self-improvement', confidence: 0.75 });
    rationale = 'Retirement planning, finances, and life strategy guidance.';
    blurb = 'Retirement planning and financial strategy.';
  } else if (title.includes('Fishing')) {
    topics.push({ node: 'hobbies', confidence: 0.9 });
    topics.push({ node: 'nature', confidence: 0.6 });
    rationale = 'Fishing techniques, locations, and outdoor recreation.';
    blurb = 'Fishing tips, techniques, and outdoor stories.';
  } else if (fullText.includes('السيرة') || fullText.includes('طارق')) {
    topics.push({ node: 'religion/islam', confidence: 0.9 });
    topics.push({ node: 'history', confidence: 0.65 });
    rationale = 'Islamic history and prophetic biography in Arabic.';
    blurb = 'Islamic history and teachings in Arabic.';
  } else if (title.includes('Rick and Morty') || fullText.includes('rick and morty')) {
    topics.push({ node: 'tv-film/reviews', confidence: 0.85 });
    topics.push({ node: 'fiction/sci-fi', confidence: 0.8 });
    rationale = 'Episode discussion and analysis of Rick and Morty.';
    blurb = 'Rick and Morty episode analysis and discussion.';
  } else if (title.includes('True Crime')) {
    topics.push({ node: 'true-crime', confidence: 0.95 });
    rationale = 'Unsolved crime cases and mystery investigations.';
    blurb = 'Unsolved true crime cases and investigation.';
  } else if (title === 'Peace Out Podcast') {
    topics.push({ node: 'religion/spirituality', confidence: 0.75 });
    topics.push({ node: 'education/self-improvement', confidence: 0.7 });
    rationale = 'Mindfulness, meditation, and spiritual peace practices.';
    blurb = 'Meditation and mindfulness for spiritual peace.';
    needsReview = true;
  } else if (title === 'AbdelRahman Murphy') {
    topics.push({ node: 'religion/islam', confidence: 0.95 });
    rationale = 'Islamic teachings, personal development, and spiritual guidance.';
    blurb = 'Islamic spiritual teachings and personal development.';
  } else if (title.includes('First Serve') || title.includes('Tennis')) {
    topics.push({ node: 'sports/tennis', confidence: 0.9 });
    rationale = 'Tennis coverage, player analysis, and match discussion.';
    blurb = 'Professional tennis coverage and analysis.';
  } else if (title === 'Bronzeville') {
    topics.push({ node: 'history', confidence: 0.85 });
    topics.push({ node: 'culture', frequency: 0.75 });
    rationale = 'Historical narratives and cultural stories from Bronzeville.';
    blurb = 'Historical storytelling and cultural narratives.';
  } else if (title.includes('Zen') || fullText.includes('buddhist')) {
    topics.push({ node: 'religion/buddhism', confidence: 0.95 });
    rationale = 'Zen Buddhist teachings, meditation, and dharma talks.';
    blurb = 'Zen Buddhist teachings and meditation guidance.';
  } else if (title.includes('Camino')) {
    topics.push({ node: 'travel', confidence: 0.9 });
    topics.push({ node: 'adventure/exploration', confidence: 0.8 });
    rationale = 'Pilgrimage journey stories and travel experiences.';
    blurb = 'Personal pilgrimage journey stories on the Camino.';
  } else if (title.includes('Bhagavad Gita')) {
    topics.push({ node: 'religion/hinduism', confidence: 0.95 });
    topics.push({ node: 'philosophy', confidence: 0.7 });
    rationale = 'Hindu scripture teachings and spiritual philosophy.';
    blurb = 'Bhagavad Gita and Hindu spiritual philosophy.';
  } else if (title.includes('Mountain Bike') || title.includes('Downtime')) {
    topics.push({ node: 'sports/endurance', confidence: 0.85 });
    topics.push({ node: 'hobbies', confidence: 0.75 });
    rationale = 'Mountain biking tips, techniques, and trail reviews.';
    blurb = 'Mountain biking tips and trail guidance.';
  } else if (title === 'NeoScum') {
    topics.push({ node: 'fiction/drama', confidence: 0.75 });
    topics.push({ node: 'fiction/sci-fi', confidence: 0.65 });
    rationale = 'Narrative fiction audio drama with cyberpunk themes.';
    blurb = 'Science fiction audio drama with narrative storytelling.';
    needsReview = true;
  } else if (title.includes('AT Parenting') || title.includes('OCD')) {
    topics.push({ node: 'kids-family/parenting', confidence: 0.9 });
    topics.push({ node: 'health/mental', confidence: 0.8 });
    rationale = 'Parenting strategies for children with OCD and anxiety.';
    blurb = 'Parenting guidance for raising children with anxiety.';
  } else if (title.includes('Abundant')) {
    topics.push({ node: 'business', confidence: 0.7 });
    topics.push({ node: 'education/self-improvement', confidence: 0.65 });
    rationale = 'Professional development and business practice guidance.';
    blurb = 'Professional development and business practice.';
    needsReview = true;
  } else if (title.includes('PHNX') || title.includes('Suns')) {
    topics.push({ node: 'sports/basketball', confidence: 0.95 });
    rationale = 'Phoenix Suns NBA basketball game and roster coverage.';
    blurb = 'Phoenix Suns NBA game coverage and analysis.';
  } else if (title.includes('DNA') || title.includes('Genetics')) {
    topics.push({ node: 'science', confidence: 0.9 });
    topics.push({ node: 'medicine/biology', confidence: 0.85 });
    rationale = 'Genetics research, DNA science, and hereditary biology.';
    blurb = 'Genetics research and DNA science education.';
  } else if (title.includes('Coaches')) {
    topics.push({ node: 'business/management', confidence: 0.85 });
    topics.push({ node: 'education/self-improvement', confidence: 0.75 });
    rationale = 'Coaching strategies and professional development guidance.';
    blurb = 'Coaching strategies and professional development.';
  } else if (title.includes('Ledge') || fullText.includes('houseplant')) {
    topics.push({ node: 'hobbies', confidence: 0.9 });
    topics.push({ node: 'nature', confidence: 0.65 });
    rationale = 'Houseplant care, gardening tips, and plant expertise.';
    blurb = 'Houseplant care and indoor gardening guidance.';
  } else {
    topics.push({ node: 'hobbies', confidence: 0.4 });
    needsReview = true;
    rationale = 'Insufficient signal for confident classification.';
    blurb = 'Podcast with varied content.';
  }

  // Ensure at least one topic
  if (!topics || topics.length === 0) {
    topics.push({ node: 'hobbies', confidence: 0.4 });
    needsReview = true;
  }

  // Check if all confidences are below 0.6
  if (topics.every(t => t.confidence < 0.6)) {
    needsReview = true;
  }

  // Enforce copy rules
  const titleWords = displayTitle.split(' ');
  if (titleWords.length > 8) {
    displayTitle = titleWords.slice(0, 8).join(' ');
  }

  const blurbWords = blurb.split(' ');
  if (blurbWords.length > 30) {
    blurb = blurbWords.slice(0, 30).join(' ') + '.';
  }

  results.results[id] = {
    topics,
    needs_review: needsReview,
    rationale,
    display_title: displayTitle,
    blurb,
    model: 'claude-code-cron (tier 1)'
  };
}

// Process all shows
batch.shows.forEach(show => classifyShow(show));

// Write results
fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
console.log(`Classified ${Object.keys(results.results).length} shows`);
console.log(`Results written to ${resultsPath}`);
