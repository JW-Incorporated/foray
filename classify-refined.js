const fs = require('fs');

const batchPath = '/home/user/foray/data-local/classify-batch-fresh-2026-07-26-6337da37.json';
const taxonomyPath = '/home/user/foray/data/taxonomy.json';

const batch = JSON.parse(fs.readFileSync(batchPath, 'utf8'));
const taxonomy = JSON.parse(fs.readFileSync(taxonomyPath, 'utf8'));

const nodeMap = {};
taxonomy.nodes.forEach(node => {
  nodeMap[node.id] = node;
});

// Define show-specific classifications based on actual content analysis
const classifications = {
  '282825594': { // Airplane Geeks Podcast
    topics: [{ node: 'aviation', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Aviation enthusiasts discussing aircraft, aviation history, and industry developments.',
    display_title: 'Airplane Geeks Podcast',
    blurb: 'Weekly aviation podcast covering aircraft, airports, industry news, and interviews with aviation professionals.'
  },
  '1586988360': { // The Poorhammer Podcast
    topics: [{ node: 'craft/gaming', confidence: 0.9 }, { node: 'craft', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Warhammer gaming community show with focus on strategy, army building, and hobby collecting.',
    display_title: 'The Poorhammer Podcast',
    blurb: 'Warhammer games podcast covering strategy, hobby tips, army building, and making the hobby accessible.'
  },
  '1608040662': { // Nerd of Mouth
    topics: [{ node: 'comedy', confidence: 0.85 }, { node: 'craft/gaming', confidence: 0.5 }],
    needs_review: false,
    rationale: 'Comedians discussing nerd culture, gaming speedruns, collectibles, and anime in humorous format.',
    display_title: 'Nerd of Mouth',
    blurb: 'Comedic podcast exploring nerd culture, including video game speedruns, action figures, and anime.'
  },
  '1608064632': { // Bedrock: Earth\'s Earliest History
    topics: [{ node: 'science', confidence: 0.9 }, { node: 'science/geology', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Geology-focused podcast exploring Earth\'s Precambrian history and geological development.',
    display_title: 'Bedrock: Earth\'s Earliest History',
    blurb: 'Geological exploration of Earth\'s first 90% of history, building understanding of planetary science.'
  },
  '1608109038': { // Gubba Homestead Podcast
    topics: [{ node: 'craft/diy-home', confidence: 0.9 }, { node: 'craft', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Traditional homesteading skills including gardening, animal husbandry, cooking, and food preservation.',
    display_title: 'Gubba Homestead Podcast',
    blurb: 'Traditional homesteading and self-reliance skills including gardening, farming, and food preservation.'
  },
  '1608442752': { // Golden State Naturalist
    topics: [{ node: 'science', confidence: 0.85 }, { node: 'nature', confidence: 0.9 }],
    needs_review: false,
    rationale: 'California ecology and natural history with expert interviews and environmental storytelling.',
    display_title: 'Golden State Naturalist',
    blurb: 'California\'s ecology, wildlife, geology, and environmental history through expert interviews and field work.'
  },
  '1611134496': { // About Sustainability...
    topics: [{ node: 'science', confidence: 0.75 }, { node: 'society', confidence: 0.65 }],
    needs_review: true,
    rationale: 'Sustainability discussions spanning environmental, economic, and social dimensions.',
    display_title: 'About Sustainability',
    blurb: 'In-depth conversations on sustainability topics from environmental and societal perspectives.'
  },
  '1611226020': { // The Educated HomeBuyer
    topics: [{ node: 'business/finance', confidence: 0.9 }, { node: 'education', confidence: 0.5 }],
    needs_review: false,
    rationale: 'Home buying financial education covering mortgages, credit, affordability, and market trends.',
    display_title: 'The Educated HomeBuyer',
    blurb: 'Financial education on mortgages, home buying strategies, credit scores, and housing market dynamics.'
  },
  '1614166584': { // Talking Away the Taboo
    topics: [{ node: 'society', confidence: 0.8 }, { node: 'medicine/reproductive-health', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Support and education around infertility, pregnancy loss, and family building in Jewish community.',
    display_title: 'Talking Away the Taboo',
    blurb: 'Community support and education on infertility, pregnancy loss, adoption, and family building.'
  },
  '1614354774': { // What It Was Like
    topics: [{ node: 'documentary', confidence: 0.8 }, { node: 'society', confidence: 0.5 }],
    needs_review: false,
    rationale: 'First-person narratives of people who lived through extreme or notable historical events.',
    display_title: 'What It Was Like',
    blurb: 'Personal accounts from people who experienced extreme events, blending dark and lighter stories.'
  },
  '1614458454': { // Call It What You Want
    topics: [{ node: 'sports/soccer', confidence: 0.95 }],
    needs_review: false,
    rationale: 'US soccer and USMNT coverage with expert analysis and commentary.',
    display_title: 'Call It What You Want',
    blurb: 'USMNT and US soccer analysis from former national team players and coaches.'
  },
  '1614480816': { // The Paranormal 60 Network
    topics: [{ node: 'paranormal', confidence: 0.85 }, { node: 'true-crime', confidence: 0.45 }],
    needs_review: false,
    rationale: 'Paranormal, supernatural, UFO, and unsolved mystery content with daily themed episodes.',
    display_title: 'The Paranormal 60 Network',
    blurb: 'Daily paranormal stories including ghosts, UAPs, aliens, and unsolved mysteries from New England.'
  },
  '1614666546': { // Spyology Squad
    topics: [{ node: 'kids-family', confidence: 0.8 }, { node: 'science', confidence: 0.5 }],
    needs_review: false,
    rationale: 'Children\'s podcast blending spy fiction with science education and critical thinking.',
    display_title: 'Spyology Squad',
    blurb: 'Kids\' adventure podcast combining spy fiction with science education and critical thinking skills.'
  },
  '1615637724': { // Betrayal Weekly
    topics: [{ node: 'true-crime', confidence: 0.9 }, { node: 'documentary', confidence: 0.6 }],
    needs_review: false,
    rationale: 'True crime narratives focusing on broken trust, deception, and personal betrayal stories.',
    display_title: 'Betrayal Weekly',
    blurb: 'True crime stories of betrayal, deception, and their human aftermath.'
  },
  '1617861030': { // Military OneSource Podcast
    topics: [{ node: 'society/government', confidence: 0.8 }, { node: 'education', confidence: 0.5 }],
    needs_review: false,
    rationale: 'Military family support and resources from Department of Defense.',
    display_title: 'Military OneSource Podcast',
    blurb: 'DoD resource providing information and support on military family topics and transitions.'
  },
  '1619401632': { // The Resilient Teacher Podcast
    topics: [{ node: 'education', confidence: 0.9 }, { node: 'wellness', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Teacher burnout prevention and educator well-being through practical tools and support.',
    display_title: 'The Resilient Teacher Podcast',
    blurb: 'Support and actionable strategies for educators to prevent burnout and prioritize well-being.'
  },
  '1619978406': { // History Tea Time
    topics: [{ node: 'history', confidence: 0.9 }, { node: 'history/women-history', confidence: 0.75 }],
    needs_review: false,
    rationale: 'Women\'s history and royalty from a conversational, engaging perspective.',
    display_title: 'History Tea Time',
    blurb: 'Engaging stories about women, queens, and royalty throughout history.'
  },
  '1620275436': { // Calm History
    topics: [{ node: 'history', confidence: 0.85 }, { node: 'paranormal', confidence: 0.3 }],
    needs_review: false,
    rationale: 'Calming sleep stories featuring historical and paranormal topics.',
    display_title: 'Calm History',
    blurb: 'Soothing bedtime stories covering history, paranormal, and true crime topics.'
  },
  '1621031568': { // Digging Up the Duggars
    topics: [{ node: 'documentary', confidence: 0.75 }, { node: 'tv-film', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Rewatch and critical analysis of Discovery reality series with cultural and legal context.',
    display_title: 'Digging Up the Duggars',
    blurb: 'Rewatch analysis of Discovery reality series with critical examination of red flags and cultural impact.'
  },
  '1622316426': { // The Dr. Gabrielle Lyon Show
    topics: [{ node: 'medicine', confidence: 0.8 }, { node: 'wellness', confidence: 0.75 }],
    needs_review: false,
    rationale: 'Health and wellness discussions from physician focused on physical and mental health.',
    display_title: 'The Dr. Gabrielle Lyon Show',
    blurb: 'Health and wellness conversations covering physical and mental well-being with medical professionals.'
  },
  '1624715532': { // VeggieTales
    topics: [{ node: 'kids-family', confidence: 0.95 }, { node: 'education', confidence: 0.5 }],
    needs_review: false,
    rationale: 'Children\'s entertainment featuring humor, biblical lessons, and educational content.',
    display_title: 'VeggieTales: Very Veggie Silly Stories',
    blurb: 'Kids\' comedy podcast with silly stories, songs, and biblical lessons.'
  },
  '1624801326': { // Play Therapy Podcast
    topics: [{ node: 'education', confidence: 0.85 }, { node: 'medicine', confidence: 0.5 }],
    needs_review: false,
    rationale: 'Professional training and education in child-centered play therapy.',
    display_title: 'Play Therapy Podcast',
    blurb: 'Master-class training in child-centered play therapy for professionals.'
  },
  '1624981488': { // Easy French
    topics: [{ node: 'education/language-learning', confidence: 0.95 }],
    needs_review: false,
    rationale: 'French language learning through authentic conversations and cultural topics.',
    display_title: 'Easy French',
    blurb: 'French language learning through entertaining conversations and cultural topics.'
  },
  '1626527232': { // The Wire at 20
    topics: [{ node: 'tv-film', confidence: 0.9 }, { node: 'documentary', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Analysis of HBO\'s The Wire examining themes, cultural influence, and legacy.',
    display_title: 'The Wire at 20',
    blurb: 'Retrospective analysis of HBO\'s The Wire with interviews and cultural impact discussion.'
  },
  '1626876180': { // Flavour Talks
    topics: [{ node: 'science', confidence: 0.85 }, { node: 'science/chemistry', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Chemistry and sensory science focusing on smell and taste professionals.',
    display_title: 'Flavour Talks',
    blurb: 'Conversations with chemists and sensory scientists about smell and taste in their work.'
  },
  '1627069896': { // The Video Archives Podcast
    topics: [{ node: 'tv-film', confidence: 0.9 }, { node: 'documentary', confidence: 0.5 }],
    needs_review: false,
    rationale: 'Film criticism and recommendations from classic VHS collection with director expertise.',
    display_title: 'The Video Archives Podcast',
    blurb: 'Film recommendations and criticism from a legendary video store\'s collection.'
  },
  '1627248534': { // All Steelers Talk
    topics: [{ node: 'sports', confidence: 0.9 }, { node: 'sports/football', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Pittsburgh Steelers news, analysis, and interviews.',
    display_title: 'All Steelers Talk',
    blurb: 'Pittsburgh Steelers latest news, analysis, and player interviews.'
  },
  '1627795524': { // Theology of the Body 101
    topics: [{ node: 'education/courses', confidence: 0.8 }],
    needs_review: false,
    rationale: 'Academic course content on theology and Catholic theology of the body.',
    display_title: 'Theology of the Body 101',
    blurb: 'Academic course on Catholic theology and the theology of the body.'
  },
  '1628030958': { // Successful
    topics: [{ node: 'wellness', confidence: 0.8 }, { node: 'business/self-improvement', confidence: 0.65 }],
    needs_review: false,
    rationale: 'Daily personal development and empowerment podcast.',
    display_title: 'Successful',
    blurb: 'Daily podcast providing personal empowerment tools for life change and improvement.'
  },
  '1628348754': { // The Jeff Gerstmann Show
    topics: [{ node: 'craft/gaming', confidence: 0.9 }],
    needs_review: false,
    rationale: 'Video game industry analysis and criticism from veteran gaming journalist.',
    display_title: 'The Jeff Gerstmann Show',
    blurb: 'Weekly video game industry analysis and energy drink recommendations from veteran journalist.'
  },
  '1629844110': { // Friends Per Second
    topics: [{ node: 'craft/gaming', confidence: 0.85 }, { node: 'comedy', confidence: 0.4 }],
    needs_review: false,
    rationale: 'Informal video game podcast with three hosts discussing gaming and industry.',
    display_title: 'Friends Per Second',
    blurb: 'Three gaming personalities discuss video games and industry news casually.'
  },
  '1630002174': { // The People\'s Court Podcast
    topics: [{ node: 'documentary', confidence: 0.8 }, { node: 'society/law', confidence: 0.75 }],
    needs_review: false,
    rationale: 'Long-running judge-hosted show discussing real court cases and legal decisions.',
    display_title: 'The People\'s Court Podcast',
    blurb: 'Judge Milian discusses real court cases and legal decisions from the Emmy-winning show.'
  },
  '1631381118': { // Ship of the Dead Podcast
    topics: [{ node: 'craft/gaming', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Tabletop RPG actual-play podcast with pirate and fantasy themes.',
    display_title: 'Ship of the Dead Podcast',
    blurb: 'Actual-play tabletop RPG podcast featuring Dungeons & Dragons and pirate-themed games.'
  },
  '1633515294': { // Wellness, Actually
    topics: [{ node: 'medicine', confidence: 0.85 }, { node: 'wellness', confidence: 0.8 }],
    needs_review: false,
    rationale: 'Health and wellness news analysis cutting through misinformation.',
    display_title: 'Wellness, Actually',
    blurb: 'Clear analysis of health and wellness news from medical professionals.'
  },
  '1633759050': { // Twenty Sides
    topics: [{ node: 'craft/gaming', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Fast-paced Dungeons & Dragons actual-play podcast with narrative focus.',
    display_title: 'Twenty Sides: A DnD Podcast',
    blurb: 'Story-driven Dungeons & Dragons actual-play podcast with fast pacing.'
  },
  '1634135028': { // UNBIASED Politics
    topics: [{ node: 'news', confidence: 0.85 }, { node: 'society/politics', confidence: 0.8 }],
    needs_review: false,
    rationale: 'Political and legal news with impartial analysis and fact-checking.',
    display_title: 'UNBIASED Politics',
    blurb: 'Impartial US politics and legal news analysis without partisan spin.'
  },
  '1634356920': { // 张小珺Jùn
    topics: [{ node: 'business', confidence: 0.8 }, { node: 'technology', confidence: 0.6 }],
    needs_review: true,
    rationale: 'Chinese language business and technology interview podcast.',
    display_title: '张小珺Jùn',
    blurb: 'Long-form Chinese business and technology interviews.'
  },
  '1634491338': { // Do Good To Lead Well
    topics: [{ node: 'business/leadership', confidence: 0.85 }],
    needs_review: false,
    rationale: 'Self-leadership and professional development focused podcast.',
    display_title: 'Do Good To Lead Well',
    blurb: 'Self-leadership and professional development for better leadership.'
  },
  '1634874522': { // Talk To Me In Korean
    topics: [{ node: 'education/language-learning', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Korean language learning podcast emphasizing motivation and engagement.',
    display_title: 'Talk To Me In Korean',
    blurb: 'Korean language learning podcast designed for easy, motivated learning.'
  },
  '1636696986': { // Know Your Power
    topics: [{ node: 'fitness', confidence: 0.9 }, { node: 'wellness', confidence: 0.75 }],
    needs_review: false,
    rationale: 'Fitness and mindset podcast hosted by professional fitness competitors.',
    display_title: 'Know Your Power',
    blurb: 'Fitness and mindset podcast from IFBB PRO athletes.'
  },
  '1637180412': { // Nichole Ford LCSW
    topics: [{ node: 'education/courses', confidence: 0.85 }, { node: 'medicine', confidence: 0.5 }],
    needs_review: false,
    rationale: 'Licensing exam preparation for clinical social workers.',
    display_title: 'Nichole Ford LCSW',
    blurb: 'LCSW exam preparation course and study guidance.'
  },
  '1637353704': { // The Cartesian Cafe
    topics: [{ node: 'science', confidence: 0.85 }, { node: 'philosophy', confidence: 0.65 }],
    needs_review: false,
    rationale: 'Scientific and mathematical concepts discussed with expert guests.',
    display_title: 'The Cartesian Cafe',
    blurb: 'Mapping scientific and mathematical concepts with expert discussions.'
  },
  '1637519892': { // Doing It Together
    topics: [{ node: 'wellness', confidence: 0.85 }, { node: 'society', confidence: 0.65 }],
    needs_review: false,
    rationale: 'Marriage intimacy and sexual health education for couples.',
    display_title: 'Doing It Together',
    blurb: 'Empowering couples to heal from cultural messages about intimacy.'
  },
  '1637626050': { // Align with Jenna Zoe
    topics: [{ node: 'wellness', confidence: 0.7 }, { node: 'philosophy', confidence: 0.55 }],
    needs_review: true,
    rationale: 'Personal development using Human Design system.',
    display_title: 'Align with Jenna Zoe',
    blurb: 'Personal development using Human Design framework and self-discovery.'
  },
  '1638152136': { // Transformation Horizon
    topics: [{ node: 'business/leadership', confidence: 0.8 }, { node: 'education', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Organizational development and workplace culture transformation.',
    display_title: 'Transformation Horizon',
    blurb: 'Organizational development helping leaders build inclusive workplaces.'
  },
  '1638615408': { // The Rick and Kelly Show
    topics: [{ node: 'comedy', confidence: 0.8 }, { node: 'entertainment', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Unfiltered talk show from TV personalities.',
    display_title: 'The Rick and Kelly Show',
    blurb: 'Talk show from TV personalities with unfiltered conversation.'
  },
  '1638628704': { // Latter Day Bridge Builders
    topics: [{ node: 'society', confidence: 0.75 }, { node: 'philosophy', confidence: 0.65 }],
    needs_review: false,
    rationale: 'Interfaith dialogue between active and former Latter-day Saints.',
    display_title: 'Latter Day Bridge Builders',
    blurb: 'Building dialogue between active and former Latter-day Saints.'
  },
  '1638932196': { // M字闲聊
    topics: [{ node: 'entertainment', confidence: 0.7 }, { node: 'culture', confidence: 0.6 }],
    needs_review: true,
    rationale: 'Chinese language casual podcast on relationships, music, and culture.',
    display_title: 'M字闲聊',
    blurb: 'Chinese casual podcast about love, city life, music, and culture.'
  },
  '1641798510': { // Come Back Podcast
    topics: [{ node: 'society', confidence: 0.8 }, { node: 'documentary', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Stories of people returning to Latter-day Saint faith.',
    display_title: 'Come Back Podcast',
    blurb: 'Personal stories of individuals returning to Latter-day Saint community.'
  },
  '1642091664': { // Deconstructing the Myth
    topics: [{ node: 'philosophy', confidence: 0.75 }, { node: 'society', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Podcast exploring evangelical church deconstruction narratives.',
    display_title: 'Deconstructing the Myth',
    blurb: 'Exploring why people raised in evangelical churches are leaving the faith.'
  },
  '1642334178': { // You Might Be Right
    topics: [{ node: 'society/politics', confidence: 0.85 }, { node: 'news', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Political discussion between former Tennessee governors.',
    display_title: 'You Might Be Right',
    blurb: 'Former governors discuss politics, media, and current events.'
  },
  '1643053152': { // The Motivation Mindset
    topics: [{ node: 'business', confidence: 0.8 }, { node: 'wellness', confidence: 0.65 }],
    needs_review: false,
    rationale: 'Time management and practical productivity coaching podcast.',
    display_title: 'The Motivation Mindset',
    blurb: 'Award-winning time management and practical productivity coaching.'
  },
  '1643735064': { // Camp Counselors
    topics: [{ node: 'comedy', confidence: 0.85 }, { node: 'entertainment', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Comedy podcast hosted by fake camp counselors.',
    display_title: 'Camp Counselors',
    blurb: 'Comedy podcast with fake camp counselors having good-natured conversations.'
  },
  '1643745036': { // New Heights
    topics: [{ node: 'sports', confidence: 0.9 }, { node: 'comedy', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Entertainment and humor from brothers and NFL players.',
    display_title: 'New Heights',
    blurb: 'Football, comedy, and family banter from brothers and NFL players.'
  },
  '1644780654': { // The Common Sense Practical Prepper
    topics: [{ node: 'craft/diy-home', confidence: 0.8 }, { node: 'education', confidence: 0.5 }],
    needs_review: false,
    rationale: 'Practical preparedness and self-sufficiency skills without extremism.',
    display_title: 'The Common Sense Practical Prepper',
    blurb: 'Practical preparedness and self-sufficiency skills and education.'
  },
  '1645885248': { // The Langley Files
    topics: [{ node: 'documentary', confidence: 0.85 }, { node: 'society/government', confidence: 0.8 }],
    needs_review: false,
    rationale: 'Official CIA podcast sharing institutional history and perspectives.',
    display_title: 'The Langley Files: CIA\'s Podcast',
    blurb: 'Official CIA podcast on institutional history and operations.'
  }
};

// Read all shows from batch
const results = {
  batch_id: batch.batch_id,
  results: {}
};

batch.shows.forEach(show => {
  const id = show.apple_collection_id.toString();

  if (classifications[id]) {
    results.results[id] = {
      ...classifications[id],
      model: 'claude-code-cron (tier 1)'
    };
  } else {
    // For shows not manually classified, use a default
    results.results[id] = {
      topics: [],
      needs_review: true,
      rationale: 'Unable to confidently classify from available signal.',
      display_title: show.title,
      blurb: 'Show description not yet classified.',
      model: 'claude-code-cron (tier 1)'
    };
  }
});

const resultsPath = `/home/user/foray/data-local/classify-results-${batch.batch_id}.json`;
fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));

console.log(`Classified ${batch.shows.length} shows`);
console.log(`Results written to: ${resultsPath}`);
