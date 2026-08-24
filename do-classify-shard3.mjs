import fs from 'fs';

const batch = JSON.parse(fs.readFileSync('data-local/classify-batch-fresh-2026-08-24-98626331.json', 'utf8'));
const taxonomy = JSON.parse(fs.readFileSync('data/taxonomy.json', 'utf8'));
const genreMap = JSON.parse(fs.readFileSync('data/genre-taxonomy-map.json', 'utf8'));

const batchId = batch.batch_id;
const results = { batch_id: batchId, results: {} };

// Banned words from contract
const bannedWords = ['fascinating', 'deep dive', 'delve', 'explores', "you won't believe", 'commute', 'drive', 'minutes'];

function wordCount(str) {
  return (str || '').trim().split(/\s+/).length;
}

function cleanBlurb(text) {
  if (!text) return '';
  text = text.trim();
  const bannedRegex = /\b(fascinating|deep\s+dive|delve|explores|you\s+won't\s+believe|commute|drive|minutes)\b/gi;
  text = text.replace(bannedRegex, '').trim();
  const words = text.split(/\s+/);
  if (words.length > 30) {
    text = words.slice(0, 30).join(' ').trim();
    if (!text.endsWith('.') && !text.endsWith('!') && !text.endsWith('?')) {
      text += '.';
    }
  }
  return text;
}

function cleanTitle(text) {
  if (!text) return '';
  text = text.trim();
  const bannedRegex = /\b(fascinating|deep\s+dive|delve|explores|you\s+won't\s+believe|commute|drive|minutes)\b/gi;
  text = text.replace(bannedRegex, '').trim();
  const words = text.split(/\s+/);
  if (words.length > 8) {
    text = words.slice(0, 8).join(' ').trim();
  }
  return text;
}

// Classify each show
const classifications = {
  'BrainStuff': {
    topics: [{ node: 'science', confidence: 0.9 }, { node: 'education', confidence: 0.65 }],
    needs_review: false,
    rationale: 'Educational science podcast covering diverse topics from psychology to physics.',
    display_title: 'BrainStuff',
    blurb: 'Daily science explanations covering everyday phenomena, history, and natural world discoveries.'
  },
  'Scotland Outdoors': {
    topics: [{ node: 'nature', confidence: 0.95 }, { node: 'adventure', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Outdoor activities and natural heritage in Scotland.',
    display_title: 'Scotland Outdoors',
    blurb: 'Scottish outdoor experiences including wildlife, nature reserves, and heritage sites.'
  },
  'Eelke Kleijn | DAYS like NIGHTS Radio': {
    topics: [{ node: 'music', confidence: 0.9 }],
    needs_review: false,
    rationale: 'Electronic dance music radio show featuring trance and progressive house sets.',
    display_title: 'DAYS like NIGHTS Radio',
    blurb: 'Progressive electronic music radio hosted by DJ Eelke Kleijn.'
  },
  'The Big Boo Cast': {
    topics: [{ node: 'comedy/casual-hangs', confidence: 0.85 }, { node: 'culture', confidence: 0.65 }],
    needs_review: false,
    rationale: 'Two friends discussing faith, family, friendship, pop culture and life experiences.',
    display_title: 'The Big Boo Cast',
    blurb: 'Conversations about faith, family, friendship, fashion, food, and everyday life.'
  },
  'The Law Show': {
    topics: [{ node: 'society/law', confidence: 0.95 }, { node: 'news/commentary', confidence: 0.7 }],
    needs_review: false,
    rationale: 'UK legal news, landmark rulings, policy and law explained for general audience.',
    display_title: 'The Law Show',
    blurb: 'Weekly legal news and analysis of court decisions affecting the UK.'
  },
  'More or Less': {
    topics: [{ node: 'math', confidence: 0.9 }, { node: 'news/commentary', confidence: 0.75 }],
    needs_review: false,
    rationale: 'Statistics and numbers in news, politics and everyday life explained.',
    display_title: 'More or Less',
    blurb: 'Examining statistics and numbers behind news stories and political claims.'
  },
  'Pure Trance Radio Podcast with Solarstone': {
    topics: [{ node: 'music', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Progressive trance music radio show hosted by DJ Solarstone.',
    display_title: 'Pure Trance Radio',
    blurb: 'Weekly progressive trance music podcast with DJ Solarstone.'
  },
  'Cattitude -  The #1 Cat Podcast': {
    topics: [{ node: 'nature/pets', confidence: 0.95 }, { node: 'health', confidence: 0.65 }],
    needs_review: false,
    rationale: 'Cat breeds, cat health advice, pet products and cat stories.',
    display_title: 'Cattitude',
    blurb: 'Cat breed spotlights, health advice, pet products and cat owner conversations.'
  },
  'Fantasy Baseball Today': {
    topics: [{ node: 'sports/baseball', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Fantasy baseball strategy, player analysis and waiver wire advice.',
    display_title: 'Fantasy Baseball Today',
    blurb: 'Daily fantasy baseball strategy, player analysis and waiver wire recommendations.'
  },
  'The Moth': {
    topics: [{ node: 'culture/performing-arts', confidence: 0.95 }, { node: 'personal-journals', confidence: 0.8 }],
    needs_review: false,
    rationale: 'True stories told live without notes by storytellers on stage.',
    display_title: 'The Moth',
    blurb: 'True stories told live by real people, from stages worldwide.'
  },
  'Beyond': {
    topics: [{ node: 'gaming', confidence: 0.95 }],
    needs_review: false,
    rationale: 'PlayStation gaming news, game reviews and industry analysis.',
    display_title: 'Beyond',
    blurb: 'PlayStation gaming podcast covering news, game releases and industry trends.'
  },
  'Unlocked': {
    topics: [{ node: 'gaming', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Xbox gaming news, releases, and industry coverage.',
    display_title: 'Unlocked',
    blurb: 'Xbox-focused gaming podcast covering news, releases and industry updates.'
  },
  'Ante Up Poker Magazine': {
    topics: [{ node: 'hobbies', confidence: 0.9 }],
    needs_review: false,
    rationale: 'Poker strategy, WSOP coverage, and community discussion.',
    display_title: 'Ante Up Poker',
    blurb: 'Poker strategy, tournament coverage and lifestyle discussion for players.'
  },
  'The 365 Days of Astronomy': {
    topics: [{ node: 'science', confidence: 0.85 }, { node: 'space', confidence: 0.9 }],
    needs_review: false,
    rationale: 'Daily astronomy content covering stars, space and celestial events.',
    display_title: 'The 365 Days of Astronomy',
    blurb: 'Daily astronomy content covering space, celestial events and observing.'
  },
  'Luke\'s ENGLISH Podcast - Learn British English with Luke Thompson': {
    topics: [{ node: 'education/language-learning', confidence: 0.95 }, { node: 'linguistics/language', confidence: 0.8 }],
    needs_review: false,
    rationale: 'British English language learning through podcast format.',
    display_title: 'Luke\'s ENGLISH Podcast',
    blurb: 'British English language learning podcast for non-native speakers.'
  },
  'Bloomberg Intelligence': {
    topics: [{ node: 'news/tech', confidence: 0.7 }, { node: 'economics/markets', confidence: 0.85 }, { node: 'business', confidence: 0.8 }],
    needs_review: false,
    rationale: 'Investment news and company analysis for Wall Street markets.',
    display_title: 'Bloomberg Intelligence',
    blurb: 'Financial news and investment analysis covering markets and companies.'
  },
  'Skeptics with a K': {
    topics: [{ node: 'science', confidence: 0.85 }, { node: 'philosophy', confidence: 0.65 }],
    needs_review: false,
    rationale: 'Science, critical thinking and skeptical analysis of pseudoscience claims.',
    display_title: 'Skeptics with a K',
    blurb: 'Science and critical thinking examining pseudoscience and strange beliefs.'
  },
  'Design Matters with Debbie Millman': {
    topics: [{ node: 'culture/design', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Design, creativity and life stories from influential creative people.',
    display_title: 'Design Matters',
    blurb: 'Conversations with creative professionals about design and creative lives.'
  },
  'NAEYC Radio- The National Association for The Education of Young Children': {
    topics: [{ node: 'education', confidence: 0.85 }, { node: 'kids-family/parenting', confidence: 0.8 }],
    needs_review: false,
    rationale: 'Early childhood education policy and teaching practices.',
    display_title: 'NAEYC Radio',
    blurb: 'Early childhood education guidance and professional development.'
  },
  'The Joe Rogan Experience': {
    topics: [{ node: 'comedy/casual-hangs', confidence: 0.8 }, { node: 'personal-journals', confidence: 0.65 }],
    needs_review: false,
    rationale: 'Long-form conversations with diverse guests covering many topics.',
    display_title: 'The Joe Rogan Experience',
    blurb: 'Long-form conversations with comedians, athletes, thinkers and entertainers.'
  },
  'الشيخ سعود الشريم': {
    topics: [{ node: 'religion/islam', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Quran recitation by Islamic scholar.',
    display_title: 'الشيخ سعود الشريم',
    blurb: 'Quranic recitation by respected Islamic scholar.'
  },
  'My Brother, My Brother And Me': {
    topics: [{ node: 'comedy/casual-hangs', confidence: 0.9 }],
    needs_review: false,
    rationale: 'Comedy podcast with three brothers giving humorous advice.',
    display_title: 'My Brother, My Brother And Me',
    blurb: 'Three brothers answering listener advice with humor and absurdity.'
  },
  'Woody & Wilcox': {
    topics: [{ node: 'comedy/casual-hangs', confidence: 0.85 }],
    needs_review: true,
    rationale: 'Comedy podcast but limited signal suggests general entertainment.',
    display_title: 'Woody & Wilcox',
    blurb: 'Comedy conversation podcast.'
  },
  'Human Action: A Treatise on Economics': {
    topics: [{ node: 'economics', confidence: 0.85 }, { node: 'education/courses', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Economics education based on classic economic text.',
    display_title: 'Human Action: Economics',
    blurb: 'Economics education and analysis based on economic theory.'
  },
  'Second Presbyterian Church Sermons Podcast': {
    topics: [{ node: 'religion/christianity', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Christian church sermons and teachings.',
    display_title: 'Second Presbyterian Sermons',
    blurb: 'Christian sermons and religious teachings.'
  },
  'Locked On Jazz - Daily Podcast On The Utah Jazz': {
    topics: [{ node: 'sports/basketball', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Utah Jazz basketball team analysis and NBA coverage.',
    display_title: 'Locked On Jazz',
    blurb: 'Daily Utah Jazz basketball analysis and news.'
  },
  'Under The Hood show': {
    topics: [{ node: 'automotive', confidence: 0.85 }, { node: 'computing', confidence: 0.55 }],
    needs_review: true,
    rationale: 'Unclear if automotive or tech; limited episode signal.',
    display_title: 'Under The Hood',
    blurb: 'Show discussing mechanics or technical topics.'
  },
  'TheThinkingAtheist': {
    topics: [{ node: 'philosophy', confidence: 0.8 }, { node: 'society', confidence: 0.75 }],
    needs_review: false,
    rationale: 'Philosophy and secular worldview discussions.',
    display_title: 'TheThinkingAtheist',
    blurb: 'Philosophy and secular perspectives on religion and society.'
  },
  'This Week in Microbiology': {
    topics: [{ node: 'science', confidence: 0.9 }, { node: 'education/courses', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Microbiology research and scientific education.',
    display_title: 'This Week in Microbiology',
    blurb: 'Microbiology research and discoveries in infectious disease.'
  },
  'New Books in Anthropology': {
    topics: [{ node: 'science', confidence: 0.75 }, { node: 'education/courses', confidence: 0.8 }],
    needs_review: false,
    rationale: 'Recent anthropology book discussions and academic interviews.',
    display_title: 'New Books in Anthropology',
    blurb: 'Interviews with anthropology authors about recent research.'
  },
  'New Books in Public Policy': {
    topics: [{ node: 'news/politics', confidence: 0.8 }, { node: 'education/courses', confidence: 0.75 }],
    needs_review: false,
    rationale: 'Public policy research and academic analysis.',
    display_title: 'New Books in Public Policy',
    blurb: 'Policy research and analysis from academic experts.'
  },
  'Homesteading and Permaculture by Paul Wheaton': {
    topics: [{ node: 'craft/diy-home', confidence: 0.85 }, { node: 'nature', confidence: 0.75 }],
    needs_review: false,
    rationale: 'Sustainable farming, homesteading and permaculture practices.',
    display_title: 'Homesteading & Permaculture',
    blurb: 'Sustainable homesteading and permaculture techniques.'
  },
  'Airline Pilot Guy - Aviation Podcast': {
    topics: [{ node: 'aviation', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Aviation industry insights from professional pilot.',
    display_title: 'Airline Pilot Guy',
    blurb: 'Aviation industry insights and pilot perspective.'
  },
  'Mac Power Users': {
    topics: [{ node: 'computing', confidence: 0.85 }, { node: 'education/how-to', confidence: 0.8 }],
    needs_review: false,
    rationale: 'Apple Mac productivity, workflows and technology tips.',
    display_title: 'Mac Power Users',
    blurb: 'Mac productivity tips and Apple technology workflows.'
  },
  '2 Knit Lit Chicks': {
    topics: [{ node: 'craft/instrument-making', confidence: 0.5 }, { node: 'culture/books', confidence: 0.6 }, { node: 'craft', confidence: 0.8 }],
    needs_review: true,
    rationale: 'Knitting and literature; unsure on primary focus.',
    display_title: '2 Knit Lit Chicks',
    blurb: 'Knitting and literature discussion podcast.'
  },
  'In Our Time: History': {
    topics: [{ node: 'history', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Historical topics and historical events discussion.',
    display_title: 'In Our Time: History',
    blurb: 'Historical events and figures explored with expert discussion.'
  },
  'TED Tech': {
    topics: [{ node: 'computing', confidence: 0.85 }, { node: 'engineering', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Technology and innovation from TED speakers.',
    display_title: 'TED Tech',
    blurb: 'Technology innovation and ideas from TED speakers.'
  },
  'Podcast UFO': {
    topics: [{ node: 'paranormal', confidence: 0.85 }, { node: 'science', confidence: 0.4 }],
    needs_review: true,
    rationale: 'UFO and paranormal discussion; mix of belief and skepticism.',
    display_title: 'Podcast UFO',
    blurb: 'UFO sightings and paranormal phenomena discussion.'
  },
  'This Week in Tech (Video)': {
    topics: [{ node: 'computing', confidence: 0.9 }, { node: 'news/tech', confidence: 0.85 }],
    needs_review: false,
    rationale: 'Weekly tech news and industry discussion from TWiT.',
    display_title: 'This Week in Tech',
    blurb: 'Weekly technology news and analysis from industry insiders.'
  },
  'Lessons Archive - Torah Class': {
    topics: [{ node: 'religion/judaism', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Jewish religious education and Torah study.',
    display_title: 'Torah Class',
    blurb: 'Jewish religious education and Torah study.'
  },
  'This Is Actually Happening': {
    topics: [{ node: 'personal-journals', confidence: 0.85 }, { node: 'culture', confidence: 0.6 }],
    needs_review: false,
    rationale: 'First-person narratives of unusual life events.',
    display_title: 'This Is Actually Happening',
    blurb: 'Real stories of unusual life events told by survivors.'
  },
  'The Yarniacs: A Knitting Podcast': {
    topics: [{ node: 'craft', confidence: 0.9 }],
    needs_review: false,
    rationale: 'Knitting techniques, patterns and fiber arts.',
    display_title: 'The Yarniacs',
    blurb: 'Knitting patterns, techniques and fiber arts discussion.'
  },
  'Down Cellar Studio Podcast': {
    topics: [{ node: 'music/theory-production', confidence: 0.75 }, { node: 'culture', confidence: 0.5 }],
    needs_review: true,
    rationale: 'Music focus unclear; limited clear episode signal.',
    display_title: 'Down Cellar Studio',
    blurb: 'Music and creative discussion podcast.'
  },
  'Fitness Confidential': {
    topics: [{ node: 'health/fitness', confidence: 0.9 }],
    needs_review: false,
    rationale: 'Fitness advice, training and health discussion.',
    display_title: 'Fitness Confidential',
    blurb: 'Fitness training and health advice from experts.'
  },
  'Welcome to Night Vale': {
    topics: [{ node: 'fiction/drama', confidence: 0.9 }, { node: 'culture/pop-culture', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Fictional narrative podcast with mystery and paranormal elements.',
    display_title: 'Welcome to Night Vale',
    blurb: 'Fictional mystery narrative with paranormal and dark themes.'
  },
  'Garage Logic': {
    topics: [{ node: 'news/commentary', confidence: 0.75 }, { node: 'culture/pop-culture', confidence: 0.65 }],
    needs_review: false,
    rationale: 'Commentary on politics and culture.',
    display_title: 'Garage Logic',
    blurb: 'Commentary on politics, culture and current events.'
  },
  'Protocol Radio': {
    topics: [{ node: 'computing', confidence: 0.75 }, { node: 'news/tech', confidence: 0.7 }],
    needs_review: true,
    rationale: 'Technology focus unclear from limited episode data.',
    display_title: 'Protocol Radio',
    blurb: 'Technology and internet culture discussion.'
  },
  'The Sebastian Maniscalco Show': {
    topics: [{ node: 'comedy/casual-hangs', confidence: 0.85 }],
    needs_review: false,
    rationale: 'Comedy and celebrity interview conversations.',
    display_title: 'The Sebastian Maniscalco Show',
    blurb: 'Celebrity interviews and comedy conversations.'
  },
  'Dungeons & Randomness': {
    topics: [{ node: 'gaming/design', confidence: 0.85 }, { node: 'fiction', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Tabletop RPG actual play and storytelling.',
    display_title: 'Dungeons & Randomness',
    blurb: 'Dungeons and Dragons actual play and tabletop RPG.'
  },
  'Think Inclusive': {
    topics: [{ node: 'education', confidence: 0.8 }, { node: 'society', confidence: 0.75 }],
    needs_review: false,
    rationale: 'Inclusive education and accessibility discussion.',
    display_title: 'Think Inclusive',
    blurb: 'Inclusive education and accessibility for all learners.'
  },
  'Gita For Daily Living': {
    topics: [{ node: 'religion/spirituality', confidence: 0.8 }, { node: 'philosophy', confidence: 0.75 }],
    needs_review: false,
    rationale: 'Hindu philosophy and spiritual teachings from Bhagavad Gita.',
    display_title: 'Gita For Daily Living',
    blurb: 'Hindu spiritual teachings from the Bhagavad Gita.'
  },
  'The Vince Coglianese Show': {
    topics: [{ node: 'news/commentary', confidence: 0.8 }, { node: 'news/politics', confidence: 0.75 }],
    needs_review: false,
    rationale: 'Political and cultural commentary.',
    display_title: 'The Vince Coglianese Show',
    blurb: 'Political and cultural commentary on current events.'
  },
  'Pat Mayo Experience': {
    topics: [{ node: 'sports/football', confidence: 0.9 }],
    needs_review: false,
    rationale: 'Sports analysis and fantasy sports discussion.',
    display_title: 'Pat Mayo Experience',
    blurb: 'Sports analysis and fantasy sports discussion.'
  },
  'Bald Move Pulp': {
    topics: [{ node: 'tv-film', confidence: 0.8 }, { node: 'culture/pop-culture', confidence: 0.8 }],
    needs_review: false,
    rationale: 'TV and film analysis and discussion.',
    display_title: 'Bald Move Pulp',
    blurb: 'Television and film analysis and reviews.'
  },
  'Yasir Qadhi': {
    topics: [{ node: 'religion/islam', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Islamic religious teachings and Quranic studies.',
    display_title: 'Yasir Qadhi',
    blurb: 'Islamic religious education and Quranic teaching.'
  },
  'Breaking Bread with Tom Papa': {
    topics: [{ node: 'comedy/casual-hangs', confidence: 0.85 }, { node: 'food', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Comedy and interview podcast with food element.',
    display_title: 'Breaking Bread with Tom Papa',
    blurb: 'Comedy and conversations with food and culture themes.'
  },
  'La Corneta': {
    topics: [{ node: 'comedy/casual-hangs', confidence: 0.75 }, { node: 'culture/pop-culture', confidence: 0.65 }],
    needs_review: true,
    rationale: 'Spanish-language comedy; limited clear episode data.',
    display_title: 'La Corneta',
    blurb: 'Spanish-language comedy and entertainment podcast.'
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
const resultsPath = `data-local/classify-results-${batchId}.json`;
fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));

const classified = Object.keys(results.results).length;
const needsReview = Object.values(results.results).filter(r => r.needs_review).length;
console.log(`Classified ${classified} shows, ${needsReview} flagged for review`);
console.log(`Results: ${resultsPath}`);
