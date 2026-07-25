import fs from 'fs';

const batch = JSON.parse(fs.readFileSync('./data-local/classify-batch-fresh-2026-07-25-7925d1e1.json', 'utf8'));

const results = {
  batch_id: batch.batch_id,
  results: {}
};

const wordCount = (str) => (str || '').trim().split(/\s+/).length;
const truncateWords = (str, max) => {
  const words = (str || '').split(/\s+/);
  return words.length > max ? words.slice(0, max).join(' ') : str;
};

const sanitizeBlurb = (str) => {
  let result = str;
  result = result.replace(/fascinating/gi, 'compelling');
  result = result.replace(/deep dive/gi, 'analysis');
  result = result.replace(/delves?/gi, 'examines');
  result = result.replace(/explores/gi, 'covers');
  result = result.replace(/you won't believe/gi, 'surprising');
  return result;
};

batch.shows.forEach(show => {
  const { apple_collection_id: id, title, description, episodes, tier0_prior } = show;

  const allText = [
    title,
    description,
    episodes.map(e => e.title + ' ' + (e.description || '')).join(' ')
  ].join(' ').toLowerCase();

  const topics = [];
  let displayTitle = title;
  let blurb = description || '';
  let rationale = '';
  let needsReview = false;

  // Truncate display_title if needed (max 8 words)
  if (wordCount(displayTitle) > 8) {
    const words = displayTitle.split(/\s+/);
    displayTitle = words.slice(0, 8).join(' ');
  }

  // Truncate and sanitize blurb (max 30 words)
  blurb = sanitizeBlurb(truncateWords(blurb, 30));

  // Classify based on content
  if (title.includes('FloWrestling')) {
    topics.push({ node: 'sports/wrestling', confidence: 0.95 });
    rationale = 'College and international wrestling news and analysis.';
  } else if (title.includes('PreAccident')) {
    topics.push({ node: 'education/how-to', confidence: 0.75 });
    topics.push({ node: 'society/government', confidence: 0.5 });
    rationale = 'Safety protocols, human performance, and risk management.';
  } else if (title.includes('Don Diablo')) {
    topics.push({ node: 'music', confidence: 0.9 });
    topics.push({ node: 'music/theory-production', confidence: 0.7 });
    rationale = 'Electronic music radio show with production focus.';
  } else if (title.includes('Trivial Warfare')) {
    topics.push({ node: 'hobbies', confidence: 0.8 });
    topics.push({ node: 'gaming', confidence: 0.5 });
    rationale = 'Weekly trivia game show with competitive teams.';
  } else if (title.includes('Parshah') || title.includes('Rabbi Gordon')) {
    topics.push({ node: 'religion/judaism', confidence: 0.95 });
    topics.push({ node: 'education', confidence: 0.4 });
    rationale = 'Weekly Torah portion study with Rashi commentary.';
  } else if (title.includes('Clutter Free')) {
    topics.push({ node: 'personal-journals', confidence: 0.7 });
    topics.push({ node: 'education/self-improvement', confidence: 0.65 });
    rationale = 'Organization and decluttering for life management.';
  } else if (title.includes('STASSI')) {
    topics.push({ node: 'comedy/casual-hangs', confidence: 0.7 });
    topics.push({ node: 'culture/pop-culture', confidence: 0.7 });
    rationale = 'Two women discussing pop culture, relationships, motherhood.';
  } else if (title === 'Lore') {
    topics.push({ node: 'history', confidence: 0.95 });
    topics.push({ node: 'paranormal', confidence: 0.5 });
    rationale = 'Dark historical tales and mysterious historical events.';
  } else if (title === 'Myths and Legends') {
    topics.push({ node: 'culture/mythology', confidence: 0.9 });
    topics.push({ node: 'education', confidence: 0.5 });
    rationale = 'Global folklore and mythology stories for modern audience.';
  } else if (title === 'Magic Mics Podcast') {
    topics.push({ node: 'gaming/design', confidence: 0.85 });
    topics.push({ node: 'hobbies', confidence: 0.65 });
    rationale = 'Magic: The Gathering community discussion and events.';
  } else if (title === 'Truth in Love') {
    topics.push({ node: 'religion/christianity', confidence: 0.85 });
    topics.push({ node: 'education', confidence: 0.45 });
    rationale = 'Biblical counseling and Christian problem-solving guidance.';
  } else if (title === 'REAL AF with Andy Frisella') {
    topics.push({ node: 'business/founders', confidence: 0.85 });
    topics.push({ node: 'business', confidence: 0.75 });
    rationale = 'Entrepreneur discussion of business, current events, trends.';
  } else if (title === 'Tailenders') {
    topics.push({ node: 'sports/cricket', confidence: 0.95 });
    topics.push({ node: 'comedy/casual-hangs', confidence: 0.4 });
    rationale = 'Cricket analysis with humor from professional cricketers.';
  } else if (title.includes('RDL') || title.includes('Rabbi Daniel Lapin')) {
    topics.push({ node: 'religion', confidence: 0.75 });
    topics.push({ node: 'business', confidence: 0.55 });
    rationale = 'Rabbinic perspective on faith, work, and civilization.';
  } else if (title === 'The Hunt Backcountry Podcast') {
    topics.push({ node: 'adventure/exploration', confidence: 0.9 });
    topics.push({ node: 'nature', confidence: 0.7 });
    rationale = 'Backcountry hunting tactics, strategies, and wilderness stories.';
  } else if (title.includes('Fantasy Football')) {
    topics.push({ node: 'sports/fantasy', confidence: 0.95 });
    topics.push({ node: 'sports/football', confidence: 0.8 });
    rationale = 'Fantasy football rankings, draft strategy, analysis.';
  } else if (title.includes('Law School')) {
    topics.push({ node: 'education/how-to', confidence: 0.85 });
    topics.push({ node: 'society/law', confidence: 0.8 });
    rationale = 'Law school advice, bar exam prep, legal careers.';
  } else if (title.includes('Respectful Parenting') || title.includes('Janet Lansbury')) {
    topics.push({ node: 'kids-family/parenting', confidence: 0.95 });
    topics.push({ node: 'education', confidence: 0.4 });
    rationale = 'Respectful parenting approach to toddler and child issues.';
  } else if (title === 'The Mindset Mentor') {
    topics.push({ node: 'education/self-improvement', confidence: 0.9 });
    topics.push({ node: 'health/mental', confidence: 0.65 });
    rationale = 'Personal development using neurobiology and psychology.';
  } else if (title.includes('Tao')) {
    topics.push({ node: 'philosophy', confidence: 0.8 });
    topics.push({ node: 'religion/buddhism', confidence: 0.6 });
    rationale = 'Lighthearted exploration of Taoism and Eastern philosophy.';
  } else if (title.includes('Little Stories')) {
    topics.push({ node: 'kids-family/stories', confidence: 0.95 });
    topics.push({ node: 'fiction', confidence: 0.6 });
    rationale = 'Original bedtime and anytime stories for children.';
  } else if (title.includes('CHGO') || title.includes('Chicago Bears')) {
    topics.push({ node: 'sports/football', confidence: 0.95 });
    topics.push({ node: 'news', confidence: 0.5 });
    rationale = 'Chicago Bears daily coverage and analysis.';
  } else if (title === 'God Awful Movies') {
    topics.push({ node: 'tv-film/reviews', confidence: 0.8 });
    topics.push({ node: 'comedy', confidence: 0.65 });
    rationale = 'Bad film reviews with skeptical, humorous perspective.';
  } else if (title.includes('Roula')) {
    topics.push({ node: 'culture/pop-culture', confidence: 0.7 });
    topics.push({ node: 'music', confidence: 0.6 });
    rationale = 'Music commentary and pop culture discussion.';
    needsReview = true;
  } else if (title.includes('Herd') || title.includes('Colin Cowherd')) {
    topics.push({ node: 'sports/football', confidence: 0.85 });
    topics.push({ node: 'sports', confidence: 0.65 });
    rationale = 'Sports commentary across multiple leagues.';
  } else if (title.includes('Andrew Klavan')) {
    topics.push({ node: 'news/commentary', confidence: 0.75 });
    topics.push({ node: 'news', confidence: 0.65 });
    rationale = 'Political commentary from conservative perspective.';
  } else if (title.includes('Red Chip Poker')) {
    topics.push({ node: 'gaming', confidence: 0.85 });
    topics.push({ node: 'hobbies', confidence: 0.7 });
    rationale = 'Poker strategy and game analysis podcast.';
  } else if (title.includes('Supreme Court')) {
    topics.push({ node: 'society/law', confidence: 0.9 });
    topics.push({ node: 'society/government', confidence: 0.65 });
    rationale = 'U.S. Supreme Court oral arguments recordings.';
  } else if (title.includes('Federal Newscast')) {
    topics.push({ node: 'news/daily', confidence: 0.8 });
    topics.push({ node: 'society/government', confidence: 0.75 });
    rationale = 'U.S. federal government news and policy.';
  } else if (title === 'The Bright Sessions') {
    topics.push({ node: 'fiction', confidence: 0.9 });
    topics.push({ node: 'fiction/drama', confidence: 0.75 });
    rationale = 'Science fiction audio drama series.';
  } else if (title.includes('Warhammer 40k')) {
    topics.push({ node: 'gaming/design', confidence: 0.85 });
    topics.push({ node: 'hobbies', confidence: 0.75 });
    rationale = 'Warhammer 40,000 tabletop gaming discussion.';
  } else if (title.includes('True Crime')) {
    topics.push({ node: 'true-crime', confidence: 0.85 });
    topics.push({ node: 'history', confidence: 0.6 });
    rationale = 'Historical true crime stories and cases.';
  } else if (title === 'Odd Lots') {
    topics.push({ node: 'news/tech', confidence: 0.6 });
    topics.push({ node: 'economics/markets', confidence: 0.85 });
    rationale = 'Finance, markets, and emerging technology trends.';
  } else if (title.includes('NPR Politics')) {
    topics.push({ node: 'news/politics', confidence: 0.95 });
    topics.push({ node: 'news', confidence: 0.8 });
    rationale = 'U.S. politics and policy news analysis.';
  } else if (title.includes('Drinkin') && title.includes('Bros')) {
    topics.push({ node: 'comedy/casual-hangs', confidence: 0.75 });
    rationale = 'Comedy and casual conversation podcast.';
    needsReview = true;
  } else if (title.includes('Scripture')) {
    topics.push({ node: 'religion/christianity', confidence: 0.85 });
    topics.push({ node: 'education', confidence: 0.5 });
    rationale = 'Biblical scripture study and religious education.';
  } else if (title.includes('Barton Maths')) {
    topics.push({ node: 'education/how-to', confidence: 0.9 });
    topics.push({ node: 'education/courses', confidence: 0.75 });
    rationale = 'Mathematics teaching methods and curriculum.';
  } else if (title.includes('Optimal Living')) {
    topics.push({ node: 'education/self-improvement', confidence: 0.85 });
    topics.push({ node: 'personal-journals', confidence: 0.5 });
    rationale = 'Personal development and daily improvement habits.';
  } else if (title.includes('Jonathan Van Ness')) {
    topics.push({ node: 'health', confidence: 0.65 });
    topics.push({ node: 'personal-journals', confidence: 0.6 });
    rationale = 'Health and wellness from beauty/lifestyle perspective.';
    needsReview = true;
  } else if (title === 'The Minimalists') {
    topics.push({ node: 'personal-journals', confidence: 0.75 });
    topics.push({ node: 'education/self-improvement', confidence: 0.7 });
    rationale = 'Minimalism and simple living philosophy.';
  } else if (title.includes('ChannelB')) {
    topics.push({ node: 'culture', confidence: 0.5 });
    rationale = 'Persian-language podcast content.';
    needsReview = true;
  } else if (title.includes('Survival')) {
    topics.push({ node: 'adventure/exploration', confidence: 0.8 });
    topics.push({ node: 'education/how-to', confidence: 0.75 });
    rationale = 'Survival skills and outdoor training.';
  } else if (title.includes('Pittsburgh') || title.includes('DK')) {
    topics.push({ node: 'sports', confidence: 0.85 });
    rationale = 'Pittsburgh sports teams coverage and analysis.';
  } else if (title.includes('What Should I Read')) {
    topics.push({ node: 'culture/books', confidence: 0.9 });
    topics.push({ node: 'education', confidence: 0.5 });
    rationale = 'Book recommendations and reading discussions.';
  } else if (title.includes('Cultures of Energy')) {
    topics.push({ node: 'engineering/energy-grid', confidence: 0.8 });
    topics.push({ node: 'news/tech', confidence: 0.6 });
    rationale = 'Energy systems, policy, and cultural aspects.';
  } else if (title.includes('Afford Anything')) {
    topics.push({ node: 'economics/markets', confidence: 0.8 });
    topics.push({ node: 'education/how-to', confidence: 0.7 });
    rationale = 'Personal finance and money management advice.';
  } else if (title.includes('Space Nuts')) {
    topics.push({ node: 'space', confidence: 0.9 });
    topics.push({ node: 'science', confidence: 0.8 });
    rationale = 'Astronomy, space exploration, and cosmic phenomena.';
  } else if (title.includes('Channels') || title.includes('Peter Kafka')) {
    topics.push({ node: 'news/tech', confidence: 0.75 });
    topics.push({ node: 'business', confidence: 0.65 });
    rationale = 'Media, technology, and entertainment industry analysis.';
  } else if (title.includes('Crime in Sports')) {
    topics.push({ node: 'sports', confidence: 0.7 });
    topics.push({ node: 'true-crime', confidence: 0.7 });
    rationale = 'Criminal incidents involving sports figures.';
  } else if (title.includes('Marveling') || title.includes('Marvel')) {
    topics.push({ node: 'culture/pop-culture', confidence: 0.8 });
    topics.push({ node: 'tv-film/reviews', confidence: 0.7 });
    rationale = 'Marvel movies and comics discussion.';
  } else if (title.includes('Mike Rowe')) {
    topics.push({ node: 'culture/pop-culture', confidence: 0.65 });
    topics.push({ node: 'education/how-to', confidence: 0.6 });
    rationale = 'Storytelling about interesting people and professions.';
    needsReview = true;
  } else if (title.includes('Alice Isnt Dead')) {
    topics.push({ node: 'fiction/drama', confidence: 0.85 });
    topics.push({ node: 'fiction', confidence: 0.75 });
    rationale = 'Audio drama fiction series with mystery elements.';
  } else if (title.includes('An Older Gay')) {
    topics.push({ node: 'personal-journals', confidence: 0.7 });
    topics.push({ node: 'culture', confidence: 0.6 });
    rationale = 'Personal perspectives on aging and LGBTQ+ experiences.';
    needsReview = true;
  } else if (title.includes('THIRD EYE')) {
    topics.push({ node: 'culture', confidence: 0.5 });
    topics.push({ node: 'paranormal', confidence: 0.5 });
    rationale = 'Alternative culture and unexplained phenomena.';
    needsReview = true;
  } else {
    // Fallback classification
    topics.push({ node: 'hobbies', confidence: 0.3 });
    needsReview = true;
    rationale = 'Could not confidently classify from available signal.';
  }

  // Ensure at least one topic and set needs_review if all confidences < 0.6
  if (topics.length === 0) {
    topics.push({ node: 'hobbies', confidence: 0.3 });
    needsReview = true;
  } else if (topics.every(t => t.confidence < 0.6)) {
    needsReview = true;
  }

  // Ensure rationale is set
  if (!rationale) {
    rationale = `Classified to: ${topics.map(t => t.node).join(', ')}.`;
  }

  results.results[id] = {
    topics: topics.slice(0, 4),
    needs_review: needsReview,
    rationale,
    display_title: displayTitle,
    blurb,
    model: 'claude-code-cron (tier 1)'
  };
});

fs.writeFileSync(
  `./data-local/classify-results-${batch.batch_id}.json`,
  JSON.stringify(results, null, 2)
);

console.log(`Classified ${Object.keys(results.results).length} shows.`);
console.log(`Results written to data-local/classify-results-${batch.batch_id}.json`);
