import fs from 'fs';

const batch = JSON.parse(fs.readFileSync('data-local/classify-batch-fresh-2026-07-25-15085557.json', 'utf8'));
const taxonomy = JSON.parse(fs.readFileSync('data/taxonomy.json', 'utf8'));

const batchId = batch.batch_id;
const results = { batch_id: batchId, results: {} };

// Banned words from contract
const bannedWords = ['fascinating', 'deep dive', 'delve', 'explores', "you won't believe", 'commute', 'drive', 'minutes'];

// Helper to count words
function wordCount(str) {
  return (str || '').trim().split(/\s+/).length;
}

// Clean blurb: truncate to 30 words max, remove banned words
function cleanBlurb(text) {
  if (!text) return '';
  text = text.trim();

  // Remove banned words
  const bannedRegex = /\b(fascinating|deep\s+dive|delve|explores|you\s+won't\s+believe|commute|drive|minutes)\b/gi;
  text = text.replace(bannedRegex, '').trim();

  // Truncate to 30 words
  const words = text.split(/\s+/);
  if (words.length > 30) {
    text = words.slice(0, 30).join(' ').trim();
    if (!text.endsWith('.') && !text.endsWith('!') && !text.endsWith('?')) {
      text += '.';
    }
  }

  return text;
}

// Clean title: max 8 words, remove banned words
function cleanTitle(text) {
  if (!text) return '';
  text = text.trim();

  // Remove banned words
  const bannedRegex = /\b(fascinating|deep\s+dive|delve|explores|you\s+won't\s+believe|commute|drive|minutes)\b/gi;
  text = text.replace(bannedRegex, '').trim();

  // Truncate to 8 words
  const words = text.split(/\s+/);
  if (words.length > 8) {
    text = words.slice(0, 8).join(' ').trim();
  }

  return text;
}

// Classifications for each show
const classifications = {
  'Solve This Murder': {
    topics: [{ node: 'fiction', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Interactive whodunit mystery game podcast.',
    display_title: 'Solve This Murder',
    blurb: 'Play along solving original murder mysteries with clues and suspects.'
  },
  'Creator Upload': {
    topics: [{ node: 'culture/pop-culture', confidence: 0.8 }, { node: 'business', confidence: 0.65 }],
    needs_review: false,
    rationale: 'Creator economy trends, YouTube, content strategies.',
    display_title: 'Creator Upload',
    blurb: 'Creator economy news covering YouTube, streaming, and content creation.'
  },
  'Daily Wisdom - Walking The Path with The Buddha': {
    topics: [{ node: 'religion/buddhism', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Buddhist teachings, meditation, enlightenment path.',
    display_title: 'Daily Wisdom with Buddha',
    blurb: 'Buddhist teachings on meditation and the path to enlightenment.'
  },
  '硅谷101': {
    topics: [{ node: 'computing', confidence: 0.85 }, { node: 'business/startups', confidence: 0.75 }],
    needs_review: false,
    rationale: 'Silicon Valley tech trends: AI, robotics, startups.',
    display_title: '硅谷101',
    blurb: 'Silicon Valley analysis of AI, robotics, and startup trends.'
  },
  'Identity/Crisis': {
    topics: [{ node: 'religion/judaism', confidence: 0.9 }, { node: 'society', confidence: 0.65 }],
    needs_review: false,
    rationale: 'Contemporary Jewish life, values, identity issues.',
    display_title: 'Identity/Crisis',
    blurb: 'Jewish values and contemporary issues affecting Jewish communities.'
  },
  'Teaching With Power': {
    topics: [{ node: 'religion', confidence: 0.85 }, { node: 'education', confidence: 0.7 }],
    needs_review: false,
    rationale: 'LDS scripture teaching methods and discussions.',
    display_title: 'Teaching With Power',
    blurb: 'LDS scripture teaching ideas for study and discussion.'
  },
  'The Deep End w/Taylor Welch': {
    topics: [{ node: 'religion/spirituality', confidence: 0.85 }, { node: 'philosophy', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Spiritual topics, unconventional beliefs, faith questions.',
    display_title: 'The Deep End',
    blurb: 'Conversations about taboo topics challenging spiritual beliefs.'
  },
  'The PedsDocTalk Podcast: Child Health, Development & Parenting—From a Pediatrician Mom': {
    topics: [{ node: 'kids-family/parenting', confidence: 0.95 }, { node: 'health', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Pediatric parenting guidance, child development, health.',
    display_title: 'PedsDocTalk Podcast',
    blurb: 'Expert pediatric advice on child development and parenting.'
  },
  'Video Gamers Podcast': {
    topics: [{ node: 'gaming', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Video game reviews, opinions, rankings, recommendations.',
    display_title: 'Video Gamers Podcast',
    blurb: 'Gaming opinions on latest games, favorites, and recommendations.'
  },
  'TFL Car Chat': {
    topics: [{ node: 'automotive', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Car reviews, automotive trends, off-road vehicles.',
    display_title: 'TFL Car Chat',
    blurb: 'Car reviews and automotive news covering trends and vehicles.'
  },
  'SLP Nerdcast': {
    topics: [{ node: 'education/courses', confidence: 0.9 }, { node: 'health', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Speech pathology continuing education and clinical topics.',
    display_title: 'SLP Nerdcast',
    blurb: 'Speech pathology continuing education and clinical topics.'
  },
  'All-In with Chamath, Jason, Sacks & Friedberg': {
    topics: [{ node: 'computing', confidence: 0.75 }, { node: 'business', confidence: 0.75 }, { node: 'news', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Tech, business, politics, and current events.',
    display_title: 'All-In Podcast',
    blurb: 'Tech, business, political, and current events discussion.'
  },
  'Palabra Plena, con Gabriel Rolón': {
    topics: [{ node: 'philosophy', confidence: 0.55 }, { node: 'psychology', confidence: 0.5 }],
    needs_review: true,
    rationale: 'Spanish-language philosophical and life reflections.',
    display_title: 'Palabra Plena',
    blurb: 'Spanish-language philosophical and personal reflections podcast.'
  },
  'The Single Greatest Choice: For Single Women Exploring Solo Motherhood by Choice (SMBC), Fertility, and Having a Baby on Thei': {
    topics: [{ node: 'personal-journals', confidence: 0.85 }, { node: 'health', confidence: 0.65 }],
    needs_review: false,
    rationale: 'Solo motherhood, fertility, parenting by choice.',
    display_title: 'The Single Greatest Choice',
    blurb: 'Stories and advice for women choosing solo motherhood.'
  },
  'Timcast IRL': {
    topics: [{ node: 'news/commentary', confidence: 0.8 }, { node: 'society', confidence: 0.65 }],
    needs_review: false,
    rationale: 'Politics, culture, current events analysis.',
    display_title: 'Timcast IRL',
    blurb: 'News analysis and cultural commentary on current events.'
  },
  'The Intercooler': {
    topics: [{ node: 'automotive', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Cars, driving, motorsport, racing commentary.',
    display_title: 'The Intercooler',
    blurb: 'Cars, driving, and motorsport journalism and analysis.'
  },
  'The Balanced, Beautiful and Abundant Show- Rebecca Whitman': {
    topics: [{ node: 'education/self-improvement', confidence: 0.75 }, { node: 'health', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Mindset coaching, wellness, entrepreneurship guidance.',
    display_title: 'Balanced Beautiful Abundant',
    blurb: 'Mindset coaching and wellness for high-achieving entrepreneurs.'
  },
  'Terrestrials': {
    topics: [{ node: 'nature', confidence: 0.95 }, { node: 'kids-family/education', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Family-friendly nature stories and animal biology.',
    display_title: 'Terrestrials',
    blurb: 'Nature stories and animal science for families.'
  },
  'アフター6ジャンクション 2': {
    topics: [{ node: 'culture', confidence: 0.65 }, { node: 'hobbies', confidence: 0.55 }],
    needs_review: true,
    rationale: 'Japanese culture and entertainment podcast.',
    display_title: 'アフター6ジャンクション',
    blurb: 'Japanese culture and entertainment discussion podcast.'
  },
  'RuggaMatrix America - GoffRugbyReport': {
    topics: [{ node: 'sports/rugby', confidence: 0.95 }],
    needs_review: false,
    rationale: 'American rugby news, coaching, team development.',
    display_title: 'RuggaMatrix America',
    blurb: 'American rugby news, coaching, and team discussions.'
  },
  'Founder\'s Story': {
    topics: [{ node: 'business/founders', confidence: 0.95 }, { node: 'business', confidence: 0.8 }],
    needs_review: false,
    rationale: 'Founder interviews, startup journeys, entrepreneurship.',
    display_title: 'Founder\'s Story',
    blurb: 'Real conversations with founders about building companies.'
  },
  'The Jesse Kelly Show': {
    topics: [{ node: 'news/commentary', confidence: 0.85 }, { node: 'news/politics', confidence: 0.75 }],
    needs_review: false,
    rationale: 'Political and cultural commentary, current events.',
    display_title: 'The Jesse Kelly Show',
    blurb: 'Political commentary and cultural analysis podcast.'
  },
  'Sunday Papers': {
    topics: [{ node: 'comedy/stand-up', confidence: 0.9 }],
    needs_review: false,
    rationale: 'Stand-up comedy recordings and performances.',
    display_title: 'Sunday Papers',
    blurb: 'Stand-up comedy performances and recordings.'
  },
  'Broken Simulation with Sam Tripoli and Johnny Woodard': {
    topics: [{ node: 'comedy/stand-up', confidence: 0.8 }, { node: 'news', confidence: 0.5 }],
    needs_review: true,
    rationale: 'Comedy and cultural commentary podcast.',
    display_title: 'Broken Simulation',
    blurb: 'Comedy with cultural and political commentary.'
  },
  'Wild Times: Wildlife Education': {
    topics: [{ node: 'nature', confidence: 0.9 }, { node: 'education', confidence: 0.75 }],
    needs_review: false,
    rationale: 'Wildlife education, animal behavior, ecology.',
    display_title: 'Wild Times',
    blurb: 'Wildlife education and animal behavior science.'
  },
  'History of the Second World War': {
    topics: [{ node: 'history/military-modern', confidence: 0.95 }, { node: 'history', confidence: 0.85 }],
    needs_review: false,
    rationale: 'WWII history, military events, historical analysis.',
    display_title: 'WWII History',
    blurb: 'World War II history and military analysis.'
  },
  'Pop Apologists': {
    topics: [{ node: 'culture/pop-culture', confidence: 0.8 }, { node: 'philosophy', confidence: 0.5 }],
    needs_review: false,
    rationale: 'Pop culture criticism and philosophical analysis.',
    display_title: 'Pop Apologists',
    blurb: 'Pop culture criticism and philosophical analysis.'
  },
  'The Hunter Williams Podcast': {
    topics: [{ node: 'health/fitness', confidence: 0.8 }],
    needs_review: false,
    rationale: 'Fitness, training, health topics.',
    display_title: 'The Hunter Williams',
    blurb: 'Fitness, training, and health discussion.'
  },
  'Family Lore': {
    topics: [{ node: 'history', confidence: 0.7 }, { node: 'personal-journals', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Family histories, genealogy, personal stories.',
    display_title: 'Family Lore',
    blurb: 'Family history stories and genealogy.'
  },
  'Rabbit Hole': {
    topics: [{ node: 'news/tech', confidence: 0.75 }, { node: 'computing', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Technology stories and investigative journalism.',
    display_title: 'Rabbit Hole',
    blurb: 'Technology investigative journalism and stories.'
  },
  'The Sevan Podcast': {
    topics: [{ node: 'education/self-improvement', confidence: 0.7 }, { node: 'health', confidence: 0.55 }],
    needs_review: false,
    rationale: 'Self-improvement and wellness discussions.',
    display_title: 'The Sevan Podcast',
    blurb: 'Self-improvement and wellness discussion podcast.'
  },
  'Hot Wife Podcast and the Swinger Lifestyle': {
    topics: [{ node: 'health/sexuality', confidence: 0.85 }, { node: 'relationships', confidence: 0.75 }],
    needs_review: false,
    rationale: 'Consensual non-monogamy and lifestyle topics.',
    display_title: 'Hot Wife Podcast',
    blurb: 'Consensual non-monogamy and relationship discussions.'
  },
  'Law School': {
    topics: [{ node: 'education/courses', confidence: 0.85 }, { node: 'society/law', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Law school education and legal studies.',
    display_title: 'Law School',
    blurb: 'Law school education and legal studies.'
  },
  'Blue Canary: For Cops By a Cop': {
    topics: [{ node: 'society/law', confidence: 0.75 }, { node: 'education', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Police training and law enforcement topics.',
    display_title: 'Blue Canary',
    blurb: 'Police training and law enforcement podcast.'
  },
  'Bible Brothers: A Comedy Podcast About The Bible': {
    topics: [{ node: 'religion/christianity', confidence: 0.75 }, { node: 'comedy', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Comedy discussions about biblical content.',
    display_title: 'Bible Brothers',
    blurb: 'Comedy discussions and jokes about biblical content.'
  },
  'Modern Miss Mason': {
    topics: [{ node: 'education/how-to', confidence: 0.75 }, { node: 'kids-family/parenting', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Educational parenting methods and guidance.',
    display_title: 'Modern Miss Mason',
    blurb: 'Educational parenting methods and guidance.'
  },
  'The Social Work Lens': {
    topics: [{ node: 'society', confidence: 0.8 }, { node: 'education', confidence: 0.65 }],
    needs_review: false,
    rationale: 'Social work perspectives and social issues.',
    display_title: 'The Social Work Lens',
    blurb: 'Social work perspectives on social issues.'
  },
  '30 Minutes to President\'s Club | No-Nonsense Sales': {
    topics: [{ node: 'business', confidence: 0.8 }, { node: 'business/careers', confidence: 0.75 }],
    needs_review: false,
    rationale: 'Sales training and career development.',
    display_title: 'President\'s Club Sales',
    blurb: 'Sales training and career development coaching.'
  },
  'Men, Sex, and Pleasure with Cam Fraser': {
    topics: [{ node: 'health/sexuality', confidence: 0.9 }, { node: 'relationships', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Sexual health and pleasure for men.',
    display_title: 'Men Sex & Pleasure',
    blurb: 'Sexual health and pleasure discussion for men.'
  },
  'What More Can I Say?': {
    topics: [{ node: 'culture/pop-culture', confidence: 0.7 }, { node: 'news', confidence: 0.5 }],
    needs_review: true,
    rationale: 'Entertainment news and pop culture discussion.',
    display_title: 'What More Can I Say',
    blurb: 'Entertainment news and pop culture podcast.'
  },
  'Series 7 Exam Tutor\'s Podcast': {
    topics: [{ node: 'education/courses', confidence: 0.9 }, { node: 'business', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Financial certification exam preparation.',
    display_title: 'Series 7 Exam Tutor',
    blurb: 'Financial certification exam preparation and tutoring.'
  },
  'Behind the Bima': {
    topics: [{ node: 'religion/judaism', confidence: 0.85 }],
    needs_review: false,
    rationale: 'Jewish synagogue life and community.',
    display_title: 'Behind the Bima',
    blurb: 'Jewish synagogue life and community discussions.'
  },
  'Irregular Warfare Podcast': {
    topics: [{ node: 'society/government', confidence: 0.75 }, { node: 'history', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Military and government strategy analysis.',
    display_title: 'Irregular Warfare',
    blurb: 'Military and government strategy analysis podcast.'
  },
  'Natural Disaster Podcast (Tornadoes)': {
    topics: [{ node: 'nature/weather', confidence: 0.9 }, { node: 'nature/earth-science', confidence: 0.8 }],
    needs_review: false,
    rationale: 'Tornado science, meteorology, natural disasters.',
    display_title: 'Natural Disaster Podcast',
    blurb: 'Tornado science and meteorology podcast.'
  },
  'Mike Birbiglia\'s Working It Out': {
    topics: [{ node: 'comedy/interviews', confidence: 0.9 }],
    needs_review: false,
    rationale: 'Comedy interviews with comedians and artists.',
    display_title: 'Mike Birbiglia\'s Show',
    blurb: 'Comedy interviews with comedians and entertainers.'
  },
  'The Saad Truth with Dr. Saad': {
    topics: [{ node: 'psychology', confidence: 0.75 }, { node: 'education', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Psychology and behavioral science discussions.',
    display_title: 'The Saad Truth',
    blurb: 'Psychology and behavioral science discussions.'
  },
  'The Hoffman Podcast': {
    topics: [{ node: 'personal-journals', confidence: 0.65 }, { node: 'psychology', confidence: 0.55 }],
    needs_review: true,
    rationale: 'Personal stories and reflections podcast.',
    display_title: 'The Hoffman Podcast',
    blurb: 'Personal stories and reflections podcast.'
  },
  'Reddit Stories Podcast - Mr. Redder': {
    topics: [{ node: 'personal-journals', confidence: 0.75 }],
    needs_review: false,
    rationale: 'Personal stories from Reddit.',
    display_title: 'Reddit Stories Podcast',
    blurb: 'Personal stories from Reddit community.'
  },
  'The Addiction Psychologist': {
    topics: [{ node: 'health', confidence: 0.8 }, { node: 'psychology', confidence: 0.75 }],
    needs_review: false,
    rationale: 'Addiction psychology and mental health.',
    display_title: 'The Addiction Psychologist',
    blurb: 'Addiction psychology and mental health insights.'
  },
  'Game To Love Tennis Podcast': {
    topics: [{ node: 'sports/tennis', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Tennis sport discussion and instruction.',
    display_title: 'Game To Love Tennis',
    blurb: 'Tennis sport discussion and instruction.'
  },
  'Doctors of Running Podcast': {
    topics: [{ node: 'sports/endurance', confidence: 0.9 }, { node: 'health', confidence: 0.75 }],
    needs_review: false,
    rationale: 'Running training and sports science.',
    display_title: 'Doctors of Running',
    blurb: 'Running training and sports science podcast.'
  },
  'An Oral History of The Office': {
    topics: [{ node: 'tv-film', confidence: 0.9 }, { node: 'culture', confidence: 0.65 }],
    needs_review: false,
    rationale: 'Behind-the-scenes stories from the TV show.',
    display_title: 'The Office History',
    blurb: 'Behind-the-scenes stories from popular TV show.'
  },
  'For Heaven\'s Sake': {
    topics: [{ node: 'religion/judaism', confidence: 0.8 }, { node: 'society', confidence: 0.5 }],
    needs_review: false,
    rationale: 'Jewish community and cultural discussions.',
    display_title: 'For Heaven\'s Sake',
    blurb: 'Jewish community and cultural discussions.'
  },
  'Restored Truths': {
    topics: [{ node: 'religion', confidence: 0.75 }, { node: 'religion/spirituality', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Religious teachings and spiritual guidance.',
    display_title: 'Restored Truths',
    blurb: 'Religious teachings and spiritual guidance podcast.'
  },
  'Critical Role & Sagas of Sundry': {
    topics: [{ node: 'gaming/design', confidence: 0.8 }, { node: 'fiction', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Tabletop RPG gameplay and storytelling.',
    display_title: 'Critical Role',
    blurb: 'Tabletop RPG gameplay and storytelling podcast.'
  }
};

// Apply classifications to results
batch.shows.forEach((show) => {
  const classification = classifications[show.title];
  if (classification) {
    results.results[show.apple_collection_id] = {
      ...classification,
      display_title: cleanTitle(classification.display_title),
      blurb: cleanBlurb(classification.blurb),
      model: 'claude-code-cron (tier 1)'
    };
  }
});

// Write results file
fs.writeFileSync(`data-local/classify-results-${batchId}.json`, JSON.stringify(results, null, 2));
const classified = Object.keys(results.results).length;
const needsReview = Object.values(results.results).filter(r => r.needs_review).length;
console.log(`Classified ${classified} shows (${needsReview} flagged for review)`);
console.log(`Results: data-local/classify-results-${batchId}.json`);
