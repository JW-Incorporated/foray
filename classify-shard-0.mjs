import fs from 'fs';

const batchFile = '/home/user/foray/data-local/classify-batch-fresh-2026-07-28-783dbae1.json';
const taxonomyFile = '/home/user/foray/data/taxonomy.json';
const batch = JSON.parse(fs.readFileSync(batchFile, 'utf8'));
const taxonomy = JSON.parse(fs.readFileSync(taxonomyFile, 'utf8'));

const validNodeIds = new Set(taxonomy.nodes.map(n => n.id));

const results = {
  batch_id: batch.batch_id,
  results: {}
};

// Classification logic for each show
const classify = (show) => {
  const { apple_collection_id, title, description, episodes, tier0_prior } = show;

  // Prepare signal: description + episode titles/descriptions
  const episodeSignal = episodes
    .map(e => `${e.title} ${e.description || ''}`.toLowerCase())
    .join(' ');
  const signal = `${description} ${episodeSignal}`.toLowerCase();

  // Helper to check keywords
  const has = (keywords) => keywords.some(k => signal.includes(k.toLowerCase()));

  let topics = [];
  let needs_review = false;
  let rationale = '';
  let display_title = title;
  let blurb = '';

  // Classification rules per show
  if (title.includes('Marathon Handbook')) {
    topics = [
      { node: 'sports/endurance', confidence: 0.95 },
      { node: 'health/fitness', confidence: 0.85 }
    ];
    rationale = 'Running training, marathons, race prep and fitness guidance.';
    blurb = 'Weekly running podcast with training tips, race coverage, and interviews with elite athletes.';
  } else if (title === 'بودكاست آن') {
    topics = [
      { node: 'society', confidence: 0.85 },
      { node: 'psychology', confidence: 0.7 }
    ];
    needs_review = true;
    rationale = 'Arabic social commentary and psychological interviews with thinkers.';
    blurb = 'Arab voices discussing society, identity, family and cultural change.';
  } else if (title === 'Kinsey Schofield Unfiltered') {
    topics = [
      { node: 'culture/pop-culture', confidence: 0.9 },
      { node: 'news/commentary', confidence: 0.75 }
    ];
    rationale = 'Royal family drama and celebrity gossip with daily pop culture commentary.';
    blurb = 'Daily royal and celebrity news with analysis and expert guests.';
  } else if (title === 'Deep Dive: Space Mysteries Unveiled') {
    topics = [
      { node: 'space', confidence: 0.95 },
      { node: 'science/physics', confidence: 0.9 }
    ];
    rationale = 'Cosmology, black holes, quantum physics and frontier astronomy exploration.';
    blurb = 'Explores cosmic mysteries: black holes, quantum enigmas, and the search for life beyond Earth.';
  } else if (title === 'DOUBLE COVERAGE PODCAST') {
    // Mixed sports content with UFC/MMA and boxing
    topics = [
      { node: 'sports', confidence: 0.75 }
    ];
    needs_review = true;
    rationale = 'Multi-sport coverage spanning football, UFC, MMA and boxing with athlete interviews.';
    blurb = 'Sports podcast covering combat sports, boxing, and other athletic pursuits.';
  } else if (title === 'پادکست اتاق تراپی | The Therapy Room') {
    topics = [
      { node: 'health/mental', confidence: 0.9 },
      { node: 'psychology', confidence: 0.85 }
    ];
    rationale = 'Clinical psychology, therapeutic techniques, relationship dynamics with licensed therapists.';
    blurb = 'Psychology podcast with clinical therapists discussing real relationships and mental health.';
  } else if (title === 'Midnight Shadows') {
    // Description says horror/mysteries, but episodes are grammar lessons - mismatch
    topics = [
      { node: 'education', confidence: 0.65 }
    ];
    needs_review = true;
    rationale = 'Feed description claims horror stories, but episodes teach English grammar and language.';
    blurb = 'Misleading title; actually teaches English language, grammar and reading skills.';
  } else if (title === 'The Zooquarium Podcast') {
    topics = [
      { node: 'nature/animal-cognition', confidence: 0.85 },
      { node: 'kids-family/education', confidence: 0.8 }
    ];
    rationale = 'Animal biology, ecosystems, and wildlife education from scientist and artist educators.';
    blurb = 'Animal science and ecosystems explained for families, merging education with creative storytelling.';
  } else if (title === 'Curse of: America\'s Next Top Model') {
    topics = [
      { node: 'tv-film', confidence: 0.8 },
      { node: 'society', confidence: 0.75 }
    ];
    rationale = 'Reality TV investigation: hidden costs of ANTM, contestant interviews, cultural critique.';
    blurb = 'Documentary-style investigation into ANTM legacy, contestant experiences, and reality TV ethics.';
  } else if (title === 'Tides of Lore') {
    topics = [
      { node: 'gaming/design', confidence: 0.85 },
      { node: 'fiction', confidence: 0.7 }
    ];
    rationale = 'World of Warcraft lore analysis: novels, game narratives, character storylines.';
    blurb = 'Deep-dive into World of Warcraft lore, story arcs, and game narratives.';
  } else if (title === 'Dark Frights Horror News With Jimmy Star') {
    topics = [
      { node: 'tv-film/reviews', confidence: 0.9 },
      { node: 'culture', confidence: 0.6 }
    ];
    rationale = 'Horror film and TV news, indie horror reviews, director interviews and genre coverage.';
    blurb = 'Horror news and film reviews with indie horror coverage and industry guests.';
  } else if (title === 'School of Practice') {
    topics = [
      { node: 'education/how-to', confidence: 0.9 }
    ];
    rationale = 'K-12 teaching strategies, classroom community building, grading and differentiation methods.';
    blurb = 'Research-backed teaching strategies in 15-minute episodes for classroom improvement.';
  } else if (title === 'Jane Austen Stories') {
    topics = [
      { node: 'fiction/drama', confidence: 0.95 },
      { node: 'culture/books', confidence: 0.75 }
    ];
    rationale = 'Narrated Jane Austen novels, specifically Pride and Prejudice, regency drama fiction.';
    blurb = 'Jane Austen classics narrated by Julie Andrews: Pride and Prejudice full-cast production.';
  } else if (title === 'A Podcast About Leadership') {
    topics = [
      { node: 'business/management', confidence: 0.95 }
    ];
    rationale = 'Leadership development, executive challenges, neuroscience and organizational culture.';
    blurb = 'Leadership insights from business leaders, psychologists, and neuroscience experts.';
  } else if (title === 'Home Grown with Martha and Jamie') {
    topics = [
      { node: 'craft/diy-home', confidence: 0.9 },
      { node: 'food', confidence: 0.5 }
    ];
    rationale = 'Urban gardening, vegetable growing, sustainability, seasonal cultivation techniques.';
    blurb = 'Gardening podcast for growers: practical tips from seed to harvest, seasonal advice.';
  } else if (title === 'Dark Romance Porn Stories') {
    topics = [
      { node: 'health/sexuality', confidence: 0.95 },
      { node: 'relationships', confidence: 0.6 }
    ];
    rationale = 'Erotic audio stories, dark romance fantasy scenarios, adult fiction content.';
    blurb = 'Erotic audio fiction stories exploring intimate fantasies and dark romance themes.';
  } else if (title === 'SIS: Sisters in Survivorship') {
    topics = [
      { node: 'health/mental', confidence: 0.8 },
      { node: 'society', confidence: 0.75 }
    ];
    rationale = 'Black women\'s breast cancer survivorship, advocacy, medical guidance and support.';
    blurb = 'Podcast amplifying Black women navigating breast cancer: survivor stories and medical insight.';
  } else if (title.includes('Lets Rap About it')) {
    topics = [
      { node: 'music', confidence: 0.85 },
      { node: 'culture/pop-culture', confidence: 0.7 }
    ];
    rationale = 'Hip-hop culture, music trends, viral topics, NYC hip-hop insider perspectives.';
    blurb = 'Hip-hop podcast with unfiltered culture commentary and trending topic reactions.';
  } else if (title === 'Hungry Dogs with James Patterson') {
    topics = [
      { node: 'personal-journals', confidence: 0.85 },
      { node: 'culture', confidence: 0.7 }
    ];
    rationale = 'Author James Patterson interviews notable figures: authors, musicians, politicians.';
    blurb = 'Bestselling author James Patterson interviews notable creators and leaders.';
  } else if (title === 'Mostly Thriving Podcast with Amanda + TJ') {
    topics = [
      { node: 'personal-journals', confidence: 0.85 },
      { node: 'relationships', confidence: 0.8 }
    ];
    rationale = 'Married couple discuss parenting, mental health, business, marriage and life balance.';
    blurb = 'Married hosts share raw conversations about parenting, business, marriage and mental health.';
  } else if (title === 'The Gospel Proclaimed') {
    topics = [
      { node: 'religion/christianity', confidence: 0.95 }
    ];
    rationale = 'Biblical preaching and theology: Genesis commentary and Christian scriptural interpretation.';
    blurb = 'Christian preaching podcast: theological study of Scripture and gospel messages.';
  } else if (title === 'Boring History For Sleep | Gentle Storytelling And Ambient Sounds (Official)') {
    topics = [
      { node: 'history', confidence: 0.8 },
      { node: 'tv-film/history', confidence: 0.7 }
    ];
    rationale = 'Historical storytelling with ambient sounds for sleep: ancient civilizations, war history.';
    blurb = 'Calming history stories with ambient sounds: ancient civilizations to modern times.';
  } else if (title === 'TWRS-Leadership Straight, No Chaser') {
    topics = [
      { node: 'business/management', confidence: 0.8 }
    ];
    rationale = 'Leadership advice and workplace culture guidance with direct, no-nonsense approach.';
    blurb = 'Practical leadership and workplace culture guidance without corporate jargon.';
  } else if (title === 'Tier1 Podcast') {
    topics = [];
    needs_review = true;
    rationale = 'Insufficient data to classify.';
    blurb = 'Unknown podcast content; insufficient episode data available.';
  } else if (title === 'Today in Geography') {
    topics = [
      { node: 'education', confidence: 0.8 },
      { node: 'society/government', confidence: 0.5 }
    ];
    rationale = 'Geography education, world places, cultures and locations learning.';
    blurb = 'Daily geography lessons and world cultures education.';
  } else if (title === 'The Sailing Podcast') {
    topics = [
      { node: 'sports', confidence: 0.75 },
      { node: 'adventure', confidence: 0.7 }
    ];
    rationale = 'Sailing sport, nautical navigation, maritime adventure and sailing techniques.';
    blurb = 'Sailing techniques, maritime adventure and navigation for water sports enthusiasts.';
  } else if (title === 'Vegas Law') {
    topics = [
      { node: 'society/law', confidence: 0.85 }
    ];
    rationale = 'Legal topics, law commentary, Nevada legal system and attorney perspectives.';
    blurb = 'Legal insights and law commentary from attorney hosts.';
  } else if (title === 'Twenty Something with Olivia Burnett') {
    topics = [
      { node: 'personal-journals', confidence: 0.8 },
      { node: 'relationships', confidence: 0.75 }
    ];
    rationale = 'Life in your twenties: relationships, careers, personal growth and young adult experiences.';
    blurb = 'Personal stories and advice for navigating your twenties: love, work, life.';
  } else if (title === 'Talkin\' Schmitt') {
    topics = [];
    needs_review = true;
    rationale = 'Insufficient episode data to classify.';
    blurb = 'Podcast with limited available content information.';
  } else if (title === 'Bearing Scars') {
    topics = [
      { node: 'society', confidence: 0.7 }
    ];
    needs_review = true;
    rationale = 'Show title and content unclear from available data.';
    blurb = 'Show with limited description and episode information.';
  } else if (title === '⚡️MENOPUNKS PODCAST ⚡️') {
    topics = [
      { node: 'health', confidence: 0.85 },
      { node: 'culture/pop-culture', confidence: 0.6 }
    ];
    rationale = 'Menopause health, women\'s wellness, humor and cultural commentary on aging.';
    blurb = 'Podcast discussing menopause, women\'s health, and cultural perspectives on aging.';
  } else if (title === 'Save the Therapist') {
    topics = [
      { node: 'health/mental', confidence: 0.85 },
      { node: 'society', confidence: 0.6 }
    ];
    rationale = 'Mental health, therapy practices, therapist wellness and psychological support.';
    blurb = 'Mental health podcast addressing therapy, wellbeing, and therapist perspectives.';
  } else if (title === 'The Rest Is Science') {
    topics = [
      { node: 'science', confidence: 0.9 }
    ];
    rationale = 'General science podcast covering research, discoveries and scientific topics.';
    blurb = 'Science podcast exploring research, discoveries and scientific inquiry.';
  } else if (title === 'Okay, But... Birds') {
    topics = [
      { node: 'nature/animal-cognition', confidence: 0.9 },
      { node: 'education', confidence: 0.6 }
    ];
    rationale = 'Bird biology, ornithology, wildlife observation and avian science.';
    blurb = 'Bird science and ornithology: species behavior, ecology and wildlife watching.';
  } else if (title === 'Selling Sanity') {
    topics = [
      { node: 'business/marketing', confidence: 0.8 },
      { node: 'health/mental', confidence: 0.6 }
    ];
    rationale = 'Marketing and wellness intersection, business psychology and consumer behavior.';
    blurb = 'Podcast exploring marketing, business strategy and mental health intersections.';
  } else if (title === 'Rachel Maddow Presents: Burn Order') {
    topics = [
      { node: 'news/politics', confidence: 0.85 },
      { node: 'true-crime', confidence: 0.7 }
    ];
    rationale = 'Political investigation and current affairs with Rachel Maddow.';
    blurb = 'Political investigation and news analysis from Rachel Maddow.';
  } else if (title === 'Game Over with Max Kellerman and Rich Paul') {
    topics = [
      { node: 'sports', confidence: 0.85 }
    ];
    rationale = 'Sports commentary, basketball insights and sports industry discussion.';
    blurb = 'Sports podcast with expert commentary on basketball and sports industry.';
  } else if (title === 'Bigger Than Belief') {
    topics = [
      { node: 'religion', confidence: 0.8 }
    ];
    rationale = 'Religion, spirituality and faith-based discussion.';
    blurb = 'Religious and spiritual perspectives and faith discussions.';
  } else if (title === 'Old Bull/ Young Bull: The Charlie\'s Fly Box Podcast') {
    topics = [
      { node: 'hobbies', confidence: 0.85 },
      { node: 'sports', confidence: 0.6 }
    ];
    rationale = 'Fly fishing hobby, technique, rivers and outdoor recreation discussion.';
    blurb = 'Fly fishing podcast: techniques, rivers, and fishing adventures.';
  } else if (title === 'Open Exam Prep') {
    topics = [
      { node: 'education', confidence: 0.9 }
    ];
    rationale = 'Educational exam preparation guidance and study strategies.';
    blurb = 'Exam preparation guidance and study strategies for standardized tests.';
  } else if (title === 'Decisions That Built a Business') {
    topics = [
      { node: 'business/founders', confidence: 0.85 }
    ];
    rationale = 'Founder interviews and business decision-making history from entrepreneurs.';
    blurb = 'Founder interviews exploring key business decisions and entrepreneurial journeys.';
  } else if (title === 'Very Vehicular') {
    topics = [
      { node: 'automotive', confidence: 0.85 },
      { node: 'hobbies', confidence: 0.6 }
    ];
    rationale = 'Automotive culture, car discussion and vehicle enthusiast content.';
    blurb = 'Automotive podcast exploring cars, vehicles and driving culture.';
  } else if (title === 'Let\'s Talk Blood Cancer, The Patients\' Podcast') {
    topics = [
      { node: 'health', confidence: 0.9 },
      { node: 'society', confidence: 0.6 }
    ];
    rationale = 'Blood cancer patient experiences, medical information and survivor stories.';
    blurb = 'Patient stories and medical information about blood cancer and survivorship.';
  } else if (title === 'Media Monitor') {
    topics = [
      { node: 'news', confidence: 0.75 }
    ];
    rationale = 'Media criticism and monitoring of news and journalism trends.';
    blurb = 'Critical analysis of media, news coverage and journalism.';
  } else if (title === 'Slightly Above Average Podcast') {
    topics = [
      { node: 'culture/pop-culture', confidence: 0.7 }
    ];
    needs_review = true;
    rationale = 'Podcast content unclear from available data.';
    blurb = 'Podcast with limited content information available.';
  } else if (title === 'Plaintext with Rich') {
    topics = [
      { node: 'computing', confidence: 0.8 },
      { node: 'news/tech', confidence: 0.75 }
    ];
    rationale = 'Technology and computing topics, tech industry commentary.';
    blurb = 'Technology and computing podcast exploring tech industry and innovation.';
  } else if (title === 'The BIG T') {
    topics = [];
    needs_review = true;
    rationale = 'Show content and focus unclear from available data.';
    blurb = 'Podcast with insufficient information for classification.';
  } else if (title === 'Butch Queen After Dark') {
    topics = [
      { node: 'culture/pop-culture', confidence: 0.8 },
      { node: 'lgbtq', confidence: 0.75 }
    ];
    needs_review = true;
    rationale = 'LGBTQ+ culture and entertainment podcast; genre context needed.';
    blurb = 'LGBTQ+ culture and entertainment podcast with community focus.';
  } else if (title === 'Insurance Exam Prep') {
    topics = [
      { node: 'education', confidence: 0.85 },
      { node: 'business', confidence: 0.6 }
    ];
    rationale = 'Insurance licensing and exam preparation educational content.';
    blurb = 'Exam preparation for insurance licensing and professional certifications.';
  } else if (title === 'Unearthing Optimism') {
    topics = [
      { node: 'society', confidence: 0.75 },
      { node: 'philosophy/ideas', confidence: 0.7 }
    ];
    rationale = 'Philosophy of optimism, positive perspectives and cultural hope.';
    blurb = 'Podcast exploring optimism, hope, and positive perspectives on society.';
  } else if (title === 'They Call Her Mother Podcast: Faith, Family and Legacy') {
    topics = [
      { node: 'personal-journals', confidence: 0.8 },
      { node: 'religion', confidence: 0.7 }
    ];
    rationale = 'Women\'s experiences, family, faith and personal narratives.';
    blurb = 'Stories of mothers, family, faith and personal legacy.';
  } else if (title === 'The Forward Party Podcast') {
    topics = [
      { node: 'news/politics', confidence: 0.85 }
    ];
    rationale = 'Political movement discussion and commentary from The Forward Party.';
    blurb = 'Political podcast from The Forward Party exploring policy and governance.';
  } else if (title === 'MCAT King Personalized MCAT Prep and Medical School Coaching') {
    topics = [
      { node: 'education', confidence: 0.9 },
      { node: 'health', confidence: 0.5 }
    ];
    rationale = 'Medical school preparation, MCAT exam strategies and pre-med coaching.';
    blurb = 'MCAT preparation and medical school coaching for pre-med students.';
  } else if (title === 'THE BURNOUT ROOM') {
    topics = [
      { node: 'health/mental', confidence: 0.85 },
      { node: 'business/management', confidence: 0.6 }
    ];
    rationale = 'Burnout prevention, mental health at work and workplace wellbeing.';
    blurb = 'Mental health podcast addressing workplace burnout and wellbeing.';
  } else if (title === 'The Interface') {
    topics = [
      { node: 'news/tech', confidence: 0.8 },
      { node: 'computing', confidence: 0.75 }
    ];
    rationale = 'Technology news and computing topics with cultural commentary.';
    blurb = 'Technology and computing news with cultural perspectives.';
  } else {
    // Fallback for any unhandled shows
    topics = [];
    needs_review = true;
    rationale = 'Show not explicitly classified in batch processor.';
    blurb = 'Podcast awaiting manual classification.';
  }

  // Validate node IDs
  topics = topics.filter(t => validNodeIds.has(t.node));

  // Set needs_review if top confidence < 0.6 or no valid topics
  if (topics.length === 0 || (topics[0] && topics[0].confidence < 0.6)) {
    needs_review = true;
  }

  // Ensure display_title <= 8 words and blurb <= 30 words
  const titleWords = display_title.split(/\s+/).length;
  const blurbWords = blurb.split(/\s+/).length;

  if (titleWords > 8) {
    display_title = display_title.split(/\s+/).slice(0, 8).join(' ');
  }

  if (blurbWords > 30) {
    blurb = blurb.split(/\s+/).slice(0, 30).join(' ') + '...';
  }

  return {
    topics,
    needs_review,
    rationale,
    display_title,
    blurb,
    model: 'claude-code-cron (tier 1)'
  };
};

// Classify all shows
for (const show of batch.shows) {
  const classified = classify(show);
  results.results[show.apple_collection_id] = classified;
}

// Write results file
const resultsPath = `/home/user/foray/data-local/classify-results-${batch.batch_id}.json`;
fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
console.log(`Classified ${Object.keys(results.results).length} shows`);
console.log(`Results written to ${resultsPath}`);
