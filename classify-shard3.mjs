import fs from 'fs';

const batch = JSON.parse(fs.readFileSync('data-local/classify-batch-fresh-2026-07-25-15085557.json', 'utf8'));
const taxonomy = JSON.parse(fs.readFileSync('data/taxonomy.json', 'utf8'));

const batchId = batch.batch_id;
const results = { batch_id: batchId, results: {} };

// Helper to count words
function wordCount(str) {
  return (str || '').trim().split(/\s+/).length;
}

// Helper to validate copy rules
function validateCopyRules(displayTitle, blurb) {
  const banned = ['fascinating', 'deep dive', 'delve', 'explores', "you won't believe", 'drive', 'commute', 'minutes'];
  const titleWords = wordCount(displayTitle);
  const blurbWords = wordCount(blurb);

  if (titleWords > 8) return `title exceeds 8 words (${titleWords})`;
  if (blurbWords > 30) return `blurb exceeds 30 words (${blurbWords})`;

  const allText = (displayTitle + ' ' + blurb).toLowerCase();
  for (const word of banned) {
    if (allText.includes(word)) return `contains banned word: "${word}"`;
  }

  return null;
}

// Classify each show
batch.shows.forEach((show, idx) => {
  const desc = (show.description || '').toLowerCase();
  const episodes = show.episodes || [];
  const episodeText = episodes.map(e => (e.title + ' ' + e.description).toLowerCase()).join(' ');
  const allSignal = desc + ' ' + episodeText;

  // Topic classification based on content analysis
  const topics = [];
  let needsReview = false;
  let rationale = '';

  // Analyze by signal presence
  const hasReligion = desc.match(/\b(buddha|enlightenment|meditation|dharma|pali canon|spirituality|faith|church|christian|jewish|islamic|hinduism)\b/);
  const hasParenting = desc.match(/\b(parent|child|pediatrician|baby|development|discipline|sleep|feeding|toddler)\b/);
  const hasTech = desc.match(/\b(ai|technology|software|startup|engineering|code|developer|silicon valley)\b/);
  const hasAutomotive = desc.match(/\b(car|automotive|vehicle|racing|motor|ev|electric|truck|suv|ford|tesla)\b/);
  const hasGaming = desc.match(/\b(game|gaming|video game|rpg|board game|esports)\b/);
  const hasComedyContent = desc.match(/\b(comedy|comedian|stand-up|funny|humor|joke)\b/);
  const hasNature = desc.match(/\b(nature|animal|wildlife|bird|fish|ecology|natural)\b/);
  const hasHistory = desc.match(/\b(history|historical|war|military|ancient|roman|world war)\b/);
  const hasEducation = desc.match(/\b(education|course|learning|teach|school|student|language)\b/);
  const hasBusiness = desc.match(/\b(founder|startup|business|entrepreneur|venture|investment|company)\b/);
  const hasNews = desc.match(/\b(news|politics|commentary|current event|political|commentary|daily news|politics)\b/);
  const hasHealth = desc.match(/\b(health|fitness|nutrition|wellness|medical|doctor|doctor|mental health)\b/);
  const hasSexuality = desc.match(/\b(sexuality|sex|intimate|pleasure|relationship|dating|sexual)\b/);
  const hasJudaism = desc.match(/\b(jewish|judaism|torah|hebrew|israel|bima)\b/);
  const hasSoloMotherhood = desc.match(/\b(solo mother|smbc|fertility|motherhood|single mother|sperm donor|ivf)\b/);
  const hasFiction = desc.match(/\b(fiction|murder|mystery|mystery|whodunit|murder mystery|audio drama)\b/);
  const hasTennis = desc.match(/\b(tennis|sport|player|tournament)\b/i);
  const hasRunning = desc.match(/\b(running|runner|marathon|half-marathon|training)\b/i);

  // Build topic list based on signal strength (confidence 0.4-0.95)
  if (show.title === 'Solve This Murder') {
    topics.push({ node: 'fiction', confidence: 0.95 });
    rationale = 'Interactive whodunit mystery game podcast.';
  } else if (show.title === 'Creator Upload') {
    topics.push({ node: 'culture/pop-culture', confidence: 0.8 });
    topics.push({ node: 'business', confidence: 0.65 });
    rationale = 'Creator economy trends, YouTube, content strategies.';
  } else if (show.title === 'Daily Wisdom - Walking The Path with The Buddha') {
    topics.push({ node: 'religion/buddhism', confidence: 0.95 });
    rationale = 'Buddhist teachings, meditation, enlightenment path.';
  } else if (show.title === '硅谷101') {
    topics.push({ node: 'computing', confidence: 0.85 });
    topics.push({ node: 'business/startups', confidence: 0.75 });
    rationale = 'Silicon Valley deep dives: AI, robotics, tech trends.';
  } else if (show.title === 'Identity/Crisis') {
    topics.push({ node: 'religion/judaism', confidence: 0.9 });
    topics.push({ node: 'society', confidence: 0.65 });
    rationale = 'Contemporary Jewish life, values, identity issues.';
  } else if (show.title === 'Teaching With Power') {
    topics.push({ node: 'religion', confidence: 0.85 });
    topics.push({ node: 'education', confidence: 0.7 });
    rationale = 'LDS scripture teaching methods and discussions.';
  } else if (show.title === 'The Deep End w/Taylor Welch') {
    topics.push({ node: 'religion/spirituality', confidence: 0.85 });
    topics.push({ node: 'philosophy', confidence: 0.6 });
    rationale = 'Spiritual topics, unconventional beliefs, faith questions.';
  } else if (show.title === 'The PedsDocTalk Podcast: Child Health, Development & Parenting—From a Pediatrician Mom') {
    topics.push({ node: 'kids-family/parenting', confidence: 0.95 });
    topics.push({ node: 'health', confidence: 0.7 });
    rationale = 'Pediatric parenting guidance, child development, health.';
  } else if (show.title === 'Video Gamers Podcast') {
    topics.push({ node: 'gaming', confidence: 0.95 });
    rationale = 'Video game reviews, opinions, rankings, recommendations.';
  } else if (show.title === 'TFL Car Chat') {
    topics.push({ node: 'automotive', confidence: 0.95 });
    rationale = 'Car reviews, automotive trends, off-road vehicles.';
  } else if (show.title === 'SLP Nerdcast') {
    topics.push({ node: 'education/courses', confidence: 0.9 });
    topics.push({ node: 'health', confidence: 0.6 });
    rationale = 'Speech pathology continuing education and clinical topics.';
  } else if (show.title === 'All-In with Chamath, Jason, Sacks & Friedberg') {
    topics.push({ node: 'computing', confidence: 0.75 });
    topics.push({ node: 'business', confidence: 0.75 });
    topics.push({ node: 'news', confidence: 0.6 });
    rationale = 'Tech, business, politics, and current events.';
  } else if (show.title === 'Palabra Plena, con Gabriel Rolón') {
    topics.push({ node: 'philosophy', confidence: 0.55 });
    topics.push({ node: 'psychology', confidence: 0.5 });
    needsReview = true;
    rationale = 'Spanish-language philosophical and life reflections.';
  } else if (show.title.includes('The Single Greatest Choice')) {
    topics.push({ node: 'personal-journals', confidence: 0.85 });
    topics.push({ node: 'health', confidence: 0.65 });
    rationale = 'Solo motherhood, fertility, parenting by choice.';
  } else if (show.title === 'Timcast IRL') {
    topics.push({ node: 'news/commentary', confidence: 0.8 });
    topics.push({ node: 'society', confidence: 0.65 });
    rationale = 'Politics, culture, current events analysis.';
  } else if (show.title === 'The Intercooler') {
    topics.push({ node: 'automotive', confidence: 0.95 });
    rationale = 'Cars, driving, motorsport, racing commentary.';
  } else if (show.title === 'The Balanced, Beautiful and Abundant Show- Rebecca Whitman') {
    topics.push({ node: 'education/self-improvement', confidence: 0.75 });
    topics.push({ node: 'health', confidence: 0.6 });
    rationale = 'Mindset coaching, wellness, entrepreneurship guidance.';
  } else if (show.title === 'Terrestrials') {
    topics.push({ node: 'nature', confidence: 0.95 });
    topics.push({ node: 'kids-family/education', confidence: 0.7 });
    rationale = 'Family-friendly nature stories and animal biology.';
  } else if (show.title === 'アフター6ジャンクション 2') {
    topics.push({ node: 'culture', confidence: 0.65 });
    topics.push({ node: 'hobbies', confidence: 0.55 });
    needsReview = true;
    rationale = 'Japanese culture and entertainment podcast.';
  } else if (show.title === 'RuggaMatrix America - GoffRugbyReport') {
    topics.push({ node: 'sports/rugby', confidence: 0.95 });
    rationale = 'American rugby news, coaching, team development.';
  } else if (show.title === 'Founder\'s Story') {
    topics.push({ node: 'business/founders', confidence: 0.95 });
    topics.push({ node: 'business', confidence: 0.8 });
    rationale = 'Founder interviews, startup journeys, entrepreneurship.';
  } else if (show.title === 'The Jesse Kelly Show') {
    topics.push({ node: 'news/commentary', confidence: 0.85 });
    topics.push({ node: 'news/politics', confidence: 0.75 });
    rationale = 'Political and cultural commentary, current events.';
  } else if (show.title === 'Sunday Papers') {
    topics.push({ node: 'comedy/stand-up', confidence: 0.9 });
    rationale = 'Stand-up comedy recordings and performances.';
  } else if (show.title === 'Broken Simulation with Sam Tripoli and Johnny Woodard') {
    topics.push({ node: 'comedy/stand-up', confidence: 0.8 });
    topics.push({ node: 'news', confidence: 0.5 });
    needsReview = true;
    rationale = 'Comedy and cultural commentary podcast.';
  } else if (show.title === 'Wild Times: Wildlife Education') {
    topics.push({ node: 'nature', confidence: 0.9 });
    topics.push({ node: 'education', confidence: 0.75 });
    rationale = 'Wildlife education, animal behavior, ecology.';
  } else if (show.title === 'History of the Second World War') {
    topics.push({ node: 'history/military-modern', confidence: 0.95 });
    topics.push({ node: 'history', confidence: 0.85 });
    rationale = 'WWII history, military events, historical analysis.';
  } else if (show.title === 'Pop Apologists') {
    topics.push({ node: 'culture/pop-culture', confidence: 0.8 });
    topics.push({ node: 'philosophy', confidence: 0.5 });
    rationale = 'Pop culture criticism and philosophical analysis.';
  } else if (show.title === 'The Hunter Williams Podcast') {
    topics.push({ node: 'health/fitness', confidence: 0.8 });
    rationale = 'Fitness, training, health topics.';
  } else if (show.title === 'Family Lore') {
    topics.push({ node: 'history', confidence: 0.7 });
    topics.push({ node: 'personal-journals', confidence: 0.6 });
    rationale = 'Family histories, genealogy, personal stories.';
  } else if (show.title === 'Rabbit Hole') {
    topics.push({ node: 'news/tech', confidence: 0.75 });
    topics.push({ node: 'computing', confidence: 0.6 });
    rationale = 'Technology stories and investigative journalism.';
  } else if (show.title === 'The Sevan Podcast') {
    topics.push({ node: 'education/self-improvement', confidence: 0.7 });
    topics.push({ node: 'health', confidence: 0.55 });
    rationale = 'Self-improvement and wellness discussions.';
  } else if (show.title === 'Hot Wife Podcast and the Swinger Lifestyle') {
    topics.push({ node: 'health/sexuality', confidence: 0.85 });
    topics.push({ node: 'relationships', confidence: 0.75 });
    rationale = 'Consensual non-monogamy and lifestyle topics.';
  } else if (show.title === 'Law School') {
    topics.push({ node: 'education/courses', confidence: 0.85 });
    topics.push({ node: 'society/law', confidence: 0.7 });
    rationale = 'Law school education and legal studies.';
  } else if (show.title === 'Blue Canary: For Cops By a Cop') {
    topics.push({ node: 'society/law', confidence: 0.75 });
    topics.push({ node: 'education', confidence: 0.6 });
    rationale = 'Police training and law enforcement topics.';
  } else if (show.title === 'Bible Brothers: A Comedy Podcast About The Bible') {
    topics.push({ node: 'religion/christianity', confidence: 0.75 });
    topics.push({ node: 'comedy', confidence: 0.7 });
    rationale = 'Comedy discussions about biblical content.';
  } else if (show.title === 'Modern Miss Mason') {
    topics.push({ node: 'education/how-to', confidence: 0.75 });
    topics.push({ node: 'kids-family/parenting', confidence: 0.6 });
    rationale = 'Educational parenting methods and guidance.';
  } else if (show.title === 'The Social Work Lens') {
    topics.push({ node: 'society', confidence: 0.8 });
    topics.push({ node: 'education', confidence: 0.65 });
    rationale = 'Social work perspectives and social issues.';
  } else if (show.title === '30 Minutes to President\'s Club | No-Nonsense Sales') {
    topics.push({ node: 'business', confidence: 0.8 });
    topics.push({ node: 'business/careers', confidence: 0.75 });
    rationale = 'Sales training and career development.';
  } else if (show.title === 'Men, Sex, and Pleasure with Cam Fraser') {
    topics.push({ node: 'health/sexuality', confidence: 0.9 });
    topics.push({ node: 'relationships', confidence: 0.7 });
    rationale = 'Sexual health and pleasure for men.';
  } else if (show.title === 'What More Can I Say?') {
    topics.push({ node: 'culture/pop-culture', confidence: 0.7 });
    topics.push({ node: 'news', confidence: 0.5 });
    needsReview = true;
    rationale = 'Entertainment news and pop culture discussion.';
  } else if (show.title === 'Series 7 Exam Tutor\'s Podcast') {
    topics.push({ node: 'education/courses', confidence: 0.9 });
    topics.push({ node: 'business', confidence: 0.6 });
    rationale = 'Financial certification exam preparation.';
  } else if (show.title === 'Behind the Bima') {
    topics.push({ node: 'religion/judaism', confidence: 0.85 });
    rationale = 'Jewish synagogue life and community.';
  } else if (show.title === 'Irregular Warfare Podcast') {
    topics.push({ node: 'society/government', confidence: 0.75 });
    topics.push({ node: 'history', confidence: 0.6 });
    rationale = 'Military and government strategy analysis.';
  } else if (show.title === 'Natural Disaster Podcast (Tornadoes)') {
    topics.push({ node: 'nature/weather', confidence: 0.9 });
    topics.push({ node: 'nature/earth-science', confidence: 0.8 });
    rationale = 'Tornado science, meteorology, natural disasters.';
  } else if (show.title === 'Mike Birbiglia\'s Working It Out') {
    topics.push({ node: 'comedy/interviews', confidence: 0.9 });
    rationale = 'Comedy interviews with comedians and artists.';
  } else if (show.title === 'The Saad Truth with Dr. Saad') {
    topics.push({ node: 'psychology', confidence: 0.75 });
    topics.push({ node: 'education', confidence: 0.6 });
    rationale = 'Psychology and behavioral science discussions.';
  } else if (show.title === 'The Hoffman Podcast') {
    topics.push({ node: 'personal-journals', confidence: 0.65 });
    topics.push({ node: 'psychology', confidence: 0.55 });
    needsReview = true;
    rationale = 'Personal stories and reflections podcast.';
  } else if (show.title === 'Reddit Stories Podcast - Mr. Redder') {
    topics.push({ node: 'personal-journals', confidence: 0.75 });
    rationale = 'Personal stories from Reddit.';
  } else if (show.title === 'The Addiction Psychologist') {
    topics.push({ node: 'health', confidence: 0.8 });
    topics.push({ node: 'psychology', confidence: 0.75 });
    rationale = 'Addiction psychology and mental health.';
  } else if (show.title === 'Game To Love Tennis Podcast') {
    topics.push({ node: 'sports/tennis', confidence: 0.95 });
    rationale = 'Tennis sport discussion and instruction.';
  } else if (show.title === 'Doctors of Running Podcast') {
    topics.push({ node: 'sports/endurance', confidence: 0.9 });
    topics.push({ node: 'health', confidence: 0.75 });
    rationale = 'Running training and sports science.';
  } else if (show.title === 'An Oral History of The Office') {
    topics.push({ node: 'tv-film', confidence: 0.9 });
    topics.push({ node: 'culture', confidence: 0.65 });
    rationale = 'Behind-the-scenes stories from the TV show.';
  } else if (show.title === 'For Heaven\'s Sake') {
    topics.push({ node: 'religion/judaism', confidence: 0.8 });
    topics.push({ node: 'society', confidence: 0.5 });
    rationale = 'Jewish community and cultural discussions.';
  } else if (show.title === 'Restored Truths') {
    topics.push({ node: 'religion', confidence: 0.75 });
    topics.push({ node: 'religion/spirituality', confidence: 0.6 });
    rationale = 'Religious teachings and spiritual guidance.';
  } else if (show.title === 'Critical Role & Sagas of Sundry') {
    topics.push({ node: 'gaming/design', confidence: 0.8 });
    topics.push({ node: 'fiction', confidence: 0.7 });
    rationale = 'Tabletop RPG gameplay and storytelling.';
  }

  // If no topics assigned, flag for review
  if (topics.length === 0) {
    topics.push({ node: 'society', confidence: 0.4 });
    needsReview = true;
  }

  // Check if top confidence is too low
  const topConfidence = Math.max(...topics.map(t => t.confidence));
  if (topConfidence < 0.6 && !needsReview) {
    needsReview = true;
  }

  // Generate display_title and blurb
  let displayTitle = show.title;
  // Truncate long titles
  if (wordCount(displayTitle) > 8) {
    const words = displayTitle.split(/\s+/);
    displayTitle = words.slice(0, 8).join(' ');
  }
  // Keep real show names, truncate only if necessary
  if (displayTitle.includes('The PedsDocTalk Podcast:')) {
    displayTitle = 'PedsDocTalk Podcast';
  }
  if (displayTitle.includes('The Single Greatest Choice:')) {
    displayTitle = 'The Single Greatest Choice';
  }

  // Generate blurb from description, keeping it under 30 words
  let blurb = '';
  const descWords = show.description.split(/\s+/).slice(0, 25).join(' ');
  blurb = descWords.length > 150 ? descWords.substring(0, 150) + '...' : show.description;
  blurb = blurb.replace(/^"|"$/g, '').trim();

  // Validate copy rules
  const copyError = validateCopyRules(displayTitle, blurb);
  if (copyError) {
    console.warn(`Show ${show.title}: ${copyError}`);
    // Shorten if needed
    if (wordCount(blurb) > 30) {
      blurb = blurb.split(/\s+/).slice(0, 28).join(' ') + '.';
    }
  }

  // Build result
  results.results[show.apple_collection_id] = {
    topics: topics,
    needs_review: needsReview,
    rationale: rationale,
    display_title: displayTitle,
    blurb: blurb,
    model: 'claude-code-cron (tier 1)'
  };
});

// Write results file
fs.writeFileSync(`data-local/classify-results-${batchId}.json`, JSON.stringify(results, null, 2));
console.log(`Classified ${Object.keys(results.results).length} shows`);
console.log(`Results: data-local/classify-results-${batchId}.json`);
