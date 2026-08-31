import fs from 'fs';

const batch = JSON.parse(fs.readFileSync('/home/user/foray/data-local/classify-batch-fresh-2026-08-08-990b6098.json', 'utf8'));
const taxonomy = JSON.parse(fs.readFileSync('/home/user/foray/data/taxonomy.json', 'utf8'));

// Build taxonomy node map for validation
const nodeMap = {};
taxonomy.nodes.forEach(n => nodeMap[n.id] = n);

// Manual classification per show based on content
const classifications = {
  1434155196: { // The Financial Independence Show
    topics: [{ node: 'business/careers', confidence: 0.9 }, { node: 'economics', confidence: 0.6 }],
    display_title: 'The Financial Independence Show',
    blurb: 'Real stories of individuals pursuing financial independence through investing, entrepreneurship, and wealth building strategies.',
    rationale: 'Interview-based show about personal finance and achieving early retirement.'
  },
  1619832024: { // The Journey Is The Reward (dot) ORG
    topics: [{ node: 'travel', confidence: 0.85 }, { node: 'aviation', confidence: 0.7 }],
    display_title: 'The Journey Is The Reward',
    blurb: 'Travel adventures and airline miles chasing, featuring interviews with travelers and exploration of destinations worldwide.',
    rationale: 'Travel and airline loyalty focused podcast with interviews from frequent travelers.'
  },
  1620034368: { // Joke WRLD
    topics: [{ node: 'comedy/stand-up', confidence: 0.9 }],
    display_title: 'Joke WRLD',
    blurb: 'Comedy news updates and interviews with comedians covering the stand-up comedy scene and recent specials.',
    rationale: 'Comedy news and industry coverage podcast.'
  },
  1620038256: { // The Space Race
    topics: [{ node: 'space', confidence: 0.95 }, { node: 'science', confidence: 0.6 }],
    display_title: 'The Space Race',
    blurb: 'News and updates on space exploration including SpaceX, NASA, and Mars missions coverage.',
    rationale: 'Space exploration focused podcast covering missions and space industry news.'
  },
  1620059010: { // The Best of You
    topics: [{ node: 'health/mental', confidence: 0.85 }, { node: 'psychology', confidence: 0.7 }],
    display_title: 'The Best of You',
    blurb: 'Therapy-based guidance from Dr. Alison Cook addressing personal challenges with wisdom and compassion.',
    rationale: 'Mental health podcast with therapeutic guidance and personal development focus.'
  },
  1620064686: { // HappyCast
    topics: [{ node: 'sports/endurance', confidence: 0.9 }, { node: 'nature', confidence: 0.5 }],
    display_title: 'HappyCast',
    blurb: 'Trail running and outdoor community focused podcast discussing races, records, and trail building.',
    rationale: 'Podcast about trail running, outdoor sports, and trail community building.'
  },
  1620101952: { // The Coonhound Collective Podcast
    topics: [{ node: 'nature/pets', confidence: 0.85 }, { node: 'adventure', confidence: 0.6 }],
    display_title: 'The Coonhound Collective Podcast',
    blurb: 'Podcast covering coon hunting practices, hounds, training collars, and hunting dog community.',
    rationale: 'Hunting dog community podcast focused on coonhunting practices and breeds.'
  },
  1620223164: { // Law&Crime Sidebar
    topics: [{ node: 'true-crime', confidence: 0.9 }, { node: 'news/daily', confidence: 0.6 }],
    display_title: 'Law&Crime Sidebar',
    blurb: 'Deep analysis of major true crime stories and legal developments with unbiased commentary.',
    rationale: 'True crime news analysis podcast covering major cases and legal stories.'
  },
  1620620736: { // Medication Talk - Expert Insights on Drug Therapy & Patient Care
    topics: [{ node: 'medicine', confidence: 0.95 }],
    display_title: 'Medication Talk',
    blurb: 'Clinical pharmacy insights on drug therapy, kidney function, and hypertension treatment updates.',
    rationale: 'Pharmaceutical and clinical pharmacy education podcast for healthcare professionals.'
  },
  1621073052: { // First This
    topics: [{ node: 'health/mental', confidence: 0.9 }],
    display_title: 'First This',
    blurb: 'Ten-minute mindfulness and meditation episodes by Kathryn Nicolai for daily calm and inspiration.',
    rationale: 'Short mindfulness meditation podcast focused on mental wellness.'
  },
  1621075170: { // Tales from the Break Room
    topics: [{ node: 'true-crime', confidence: 0.9 }, { node: 'fiction', confidence: 0.4 }],
    display_title: 'Tales from the Break Room',
    blurb: 'True crime stories set in workplace contexts, exploring horrifying incidents during work hours.',
    rationale: 'True crime podcast with workplace setting narratives.'
  },
  1621122528: { // Kauffman Corner
    topics: [{ node: 'sports/baseball', confidence: 0.95 }],
    display_title: 'Kauffman Corner',
    blurb: 'Kansas City Royals coverage including game analysis, trades, and team developments.',
    rationale: 'MLB baseball podcast dedicated to Kansas City Royals coverage.'
  },
  1622204364: { // Fueled By Joy - Working Dog Podcast
    topics: [{ node: 'nature/pets', confidence: 0.85 }, { node: 'adventure', confidence: 0.6 }],
    display_title: 'Fueled By Joy - Working Dog Podcast',
    blurb: 'Interviews with hunting dog handlers and owners discussing training, breeds, and dog sports.',
    rationale: 'Working dog podcast featuring interviews with handlers and trainers.'
  },
  1622639964: { // Fostering Excellence in Agility
    topics: [{ node: 'nature/pets', confidence: 0.95 }],
    display_title: 'Fostering Excellence in Agility',
    blurb: 'Dog agility training podcast covering ring readiness, stamina, and training methodology.',
    rationale: 'Dog sports training podcast focused on agility competition preparation.'
  },
  1622892162: { // WNBA Gambling Podcast
    topics: [{ node: 'sports/basketball', confidence: 0.9 }],
    display_title: 'WNBA Gambling Podcast',
    blurb: 'WNBA betting analysis and daily picks from hosts Really Rell and Scott Reichel.',
    rationale: 'Sports gambling podcast providing WNBA betting analysis and daily picks.'
  },
  1622988198: { // A Little Bit Healthier | Hormone Balance, Brain Fog, Fatigue, Inflammation, Gut Health, Menopause & Weight Loss Resistance So
    topics: [{ node: 'health/mental', confidence: 0.7 }, { node: 'health/nutrition', confidence: 0.75 }],
    display_title: 'A Little Bit Healthier',
    blurb: 'Health podcast addressing hormone balance, brain fog, gut health, and menopause management.',
    rationale: 'Women\'s health podcast focused on hormones, fatigue, and metabolic wellness.',
    needs_review: true
  },
  1623088284: { // Research Bites Podcast
    topics: [{ node: 'nature/pets', confidence: 0.9 }, { node: 'science', confidence: 0.6 }],
    display_title: 'Research Bites Podcast',
    blurb: 'Applied animal behavior science explained for non-specialists covering dog welfare and cognition.',
    rationale: 'Animal behavior science podcast explaining research to general audiences.'
  },
  1623136416: { // 蜜獾吃书
    topics: [{ node: 'culture/books', confidence: 0.95 }],
    display_title: '蜜獾吃书',
    blurb: 'Chinese book podcast discussing literature, science, and philosophy with eclectic hosts.',
    rationale: 'Diverse book discussion podcast in Chinese covering literature and ideas.'
  },
  1623412008: { // The Pioneer Woman
    topics: [{ node: 'food/cooking-science', confidence: 0.95 }],
    display_title: 'The Pioneer Woman',
    blurb: 'Home cooking podcast from Ree Drummond featuring ranch recipes and Food Network content.',
    rationale: 'Home cooking podcast with ranch and comfort food recipes.'
  },
  1623649200: { // The Lore You Know
    topics: [{ node: 'culture/pop-culture', confidence: 0.9 }],
    display_title: 'The Lore You Know',
    blurb: 'Deep dives into TV show and video game lore covering Marvel, Neopets, and fantasy worlds.',
    rationale: 'Pop culture lore discussion podcast analyzing TV shows and gaming universes.'
  },
  1623855270: { // The Foreign Affairs Interview
    topics: [{ node: 'news/politics', confidence: 0.95 }],
    display_title: 'The Foreign Affairs Interview',
    blurb: 'Foreign Affairs magazine interviews with policymakers on global politics and cybersecurity.',
    rationale: 'International affairs and policy discussion podcast.'
  },
  1623866538: { // Charles Band's Full Moon Freakshow
    topics: [{ node: 'tv-film/interviews', confidence: 0.95 }],
    display_title: 'Charles Band\'s Full Moon Freakshow',
    blurb: 'Producer Charles Band interviews filmmakers and actors about B-movies and genre cinema.',
    rationale: 'Film interview podcast focused on horror and B-movie industry.'
  },
  1623931446: { // Healthy Teen Life
    topics: [{ node: 'health/nutrition', confidence: 0.8 }, { node: 'education', confidence: 0.6 }],
    display_title: 'Healthy Teen Life',
    blurb: 'Podcast for teens and parents covering nutrition, AI use in education, and college preparation.',
    rationale: 'Teen health and wellness podcast with parenting and education topics.'
  },
  1624571790: { // Everyday Wellness: Midlife Hormones, Menopause, and Science for Women 35+
    topics: [{ node: 'health/mental', confidence: 0.75 }, { node: 'health/nutrition', confidence: 0.75 }],
    display_title: 'Everyday Wellness',
    blurb: 'Women\'s health podcast addressing menopause, hormones, breast health, and midlife wellness.',
    rationale: 'Women\'s health podcast focused on midlife hormones and menopause science.',
    needs_review: true
  },
  1624978968: { // Bloodthirsty Hearts
    topics: [{ node: 'fiction/comedy', confidence: 0.9 }],
    display_title: 'Bloodthirsty Hearts',
    blurb: 'Audio comedy fiction about high schoolers encountering creatures at a fantasy convention.',
    rationale: 'Comedy fiction podcast with fantasy convention premise and creature encounters.'
  },
  1625564508: { // Daily Affirmations Meditation for Women
    topics: [{ node: 'health/mental', confidence: 0.95 }],
    display_title: 'Daily Affirmations Meditation for Women',
    blurb: 'Daily affirmation meditations providing calm, inspiration, and emotional balance for women.',
    rationale: 'Guided meditation podcast with affirmations for mindfulness and wellness.'
  },
  1625762664: { // Quantum Mechanics for the Working Professional
    topics: [{ node: 'science/physics', confidence: 0.95 }],
    display_title: 'Quantum Mechanics for the Working Professional',
    blurb: 'Informal quantum physics lessons with exercises for professionals seeking foundational understanding.',
    rationale: 'Physics education podcast teaching quantum mechanics to working professionals.'
  },
  1626878388: { // Stickesnack med Stickgäris
    topics: [{ node: 'craft', confidence: 0.95 }],
    display_title: 'Stickesnack med Stickgäris',
    blurb: 'Swedish knitting podcast celebrating yarn, knitting love, and crochet projects.',
    rationale: 'Knitting and fiber crafts podcast in Swedish.'
  },
  1627014612: { // ながら日経
    topics: [{ node: 'news/daily', confidence: 0.95 }],
    display_title: 'ながら日経',
    blurb: 'Daily ten-minute Japanese news podcast covering economy and current affairs while commuting.',
    rationale: 'Daily news podcast in Japanese with economic and business focus.'
  },
  1628192712: { // BV Interviews: A Podcast About Music
    topics: [{ node: 'music', confidence: 0.95 }],
    display_title: 'BV Interviews: A Podcast About Music',
    blurb: 'BrooklynVegan music interviews with musicians, producers, and comedians about music and touring.',
    rationale: 'Music industry interview podcast covering artists and creative process.'
  },
  1628371410: { // Behind the Wings
    topics: [{ node: 'aviation', confidence: 0.95 }, { node: 'history/military-modern', confidence: 0.5 }],
    display_title: 'Behind the Wings',
    blurb: 'Aviation museum podcast covering fighter jets, wildfire response aircraft, and Vietnam War planes.',
    rationale: 'Aviation history podcast focused on military and emergency response aircraft.'
  },
  1628410164: { // Clown Parade
    topics: [{ node: 'comedy/casual-hangs', confidence: 0.9 }],
    display_title: 'Clown Parade',
    blurb: 'Anthology comedy podcast series from Will Ferrell and friends featuring comedic storytelling.',
    rationale: 'Comedy anthology podcast with comedians telling humorous stories.'
  },
  1628696112: { // Basados Podcast
    topics: [{ node: 'tv-film/animation', confidence: 0.95 }],
    display_title: 'Basados Podcast',
    blurb: 'Spanish-language podcast discussing anime, manga, comics, and epic anime battles and rivalries.',
    rationale: 'Anime and manga discussion podcast in Spanish.'
  },
  1628848482: { // So There I Was
    topics: [{ node: 'aviation', confidence: 0.95 }],
    display_title: 'So There I Was',
    blurb: 'Aviation podcast featuring true pilot stories from fighter pilots and airline professionals.',
    rationale: 'Pilot storytelling podcast with true aviation narratives.'
  },
  1628949690: { // Real Life French
    topics: [{ node: 'education/language-learning', confidence: 0.95 }],
    display_title: 'Real Life French',
    blurb: 'French language learning podcast with real dialogues and natural vocabulary in everyday situations.',
    rationale: 'French language instruction podcast using real conversational scenarios.'
  },
  1629159648: { // The Lorehounds
    topics: [{ node: 'tv-film/reviews', confidence: 0.95 }],
    display_title: 'The Lorehounds',
    blurb: 'TV show deep-dives and reviews including House of the Dragon and Supergirl analysis.',
    rationale: 'TV show analysis and review podcast.'
  },
  1629368076: { // The Madness of Chartrulean
    topics: [{ node: 'fiction/sci-fi', confidence: 0.9 }],
    display_title: 'The Madness of Chartrulean',
    blurb: 'Science fiction audio drama imagining a tech-world messiah figure in futuristic world.',
    rationale: 'Science fiction audio drama exploring tech messianism and AI ethics.'
  },
  1629700152: { // You Gotta Try This
    topics: [{ node: 'travel', confidence: 0.85 }, { node: 'food', confidence: 0.7 }],
    display_title: 'You Gotta Try This',
    blurb: 'Food travel podcast featuring cuisine exploration and restaurant discovery across the United States.',
    rationale: 'Food and travel podcast sampling diverse American culinary experiences.'
  },
  1630160928: { // Serious Trouble
    topics: [{ node: 'news/commentary', confidence: 0.95 }, { node: 'society/law', confidence: 0.6 }],
    display_title: 'Serious Trouble',
    blurb: 'Legal commentary podcast from Josh Barro and Ken White discussing law with irreverent tone.',
    rationale: 'Law and legal commentary podcast with humor and analysis.'
  },
  1631079072: { // Late Arrivals: An Anaheim Ducks Podcast
    topics: [{ node: 'sports/hockey', confidence: 0.95 }],
    display_title: 'Late Arrivals: An Anaheim Ducks Podcast',
    blurb: 'Anaheim Ducks NHL podcast discussing team news, trades, and hockey developments.',
    rationale: 'NHL hockey podcast focused on Anaheim Ducks team coverage.'
  },
  1631178384: { // The Liminal Lands
    topics: [{ node: 'fiction/sci-fi', confidence: 0.9 }],
    display_title: 'The Liminal Lands',
    blurb: 'Science fiction audio series following a man searching for family in hostile parallel reality.',
    rationale: 'Science fiction audio drama with alternate reality premise.'
  },
  1631451096: { // The Curbsiders Addiction Medicine Podcast
    topics: [{ node: 'medicine', confidence: 0.95 }, { node: 'health/mental', confidence: 0.5 }],
    display_title: 'The Curbsiders Addiction Medicine Podcast',
    blurb: 'Addiction medicine education for healthcare professionals covering substance use disorders and treatment.',
    rationale: 'Medical education podcast focused on addiction medicine and patient care.'
  },
  1631745798: { // הגשה ראשונה - פודקאסט הטניס
    topics: [{ node: 'sports/tennis', confidence: 0.95 }],
    display_title: 'הגשה ראשונה - פודקאסט הטניס',
    blurb: 'Hebrew tennis podcast covering major tournaments like Wimbledon and French Open.',
    rationale: 'Tennis sports podcast in Hebrew with tournament coverage.'
  },
  1631980278: { // Bajrang Baan
    topics: [{ node: 'religion/hinduism', confidence: 0.95 }],
    display_title: 'Bajrang Baan',
    blurb: 'Hindu devotional podcast reciting Bajrang Baan, a prayer text honoring Hanuman.',
    rationale: 'Hindu religious devotional content podcast.'
  },
  1632291264: { // Advanced Spanish Podcast - Español Avanzado
    topics: [{ node: 'education/language-learning', confidence: 0.95 }],
    display_title: 'Advanced Spanish Podcast',
    blurb: 'Advanced Spanish language instruction with conversational lessons and cultural context.',
    rationale: 'Spanish language podcast for advanced learners.'
  },
  1632703134: { // 十亿个冷笑话｜1分钟笑话
    topics: [{ node: 'comedy/stand-up', confidence: 0.9 }],
    display_title: '十亿个冷笑话｜1分钟笑话',
    blurb: 'Chinese comedy podcast with one-minute jokes and humorous short stories daily.',
    rationale: 'Chinese comedy podcast with daily one-minute humor segments.'
  }
};

// Build results
const results = {
  batch_id: batch.batch_id,
  results: {}
};

batch.shows.forEach(show => {
  const id = show.apple_collection_id;
  const c = classifications[id];

  if (!c) {
    console.warn(`Missing classification for ${show.title}`);
    return;
  }

  results.results[id] = {
    topics: c.topics,
    needs_review: c.needs_review || false,
    rationale: c.rationale,
    display_title: c.display_title,
    blurb: c.blurb,
    model: 'claude-code-cron (tier 1)'
  };
});

const outputPath = `/home/user/foray/data-local/classify-results-${batch.batch_id}.json`;
fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
console.log(`Written ${Object.keys(results.results).length} classifications to ${outputPath}`);
