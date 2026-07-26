const fs = require('fs');

const batchPath = '/home/user/foray/data-local/classify-batch-fresh-2026-07-26-6337da37.json';
const taxonomyPath = '/home/user/foray/data/taxonomy.json';

const batch = JSON.parse(fs.readFileSync(batchPath, 'utf8'));
const taxonomy = JSON.parse(fs.readFileSync(taxonomyPath, 'utf8'));

const nodeMap = {};
taxonomy.nodes.forEach(node => {
  nodeMap[node.id] = node;
});

// Define show-specific classifications with CORRECT taxonomy nodes
const classifications = {
  '282825594': { // Airplane Geeks Podcast
    topics: [{ node: 'aviation', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Aviation enthusiasts discussing aircraft, aviation history, and industry developments.',
    display_title: 'Airplane Geeks Podcast',
    blurb: 'Weekly aviation podcast covering aircraft, airports, industry news, and interviews.'
  },
  '1586988360': { // The Poorhammer Podcast
    topics: [{ node: 'gaming', confidence: 0.9 }, { node: 'culture/pop-culture', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Warhammer gaming community show with focus on strategy, army building, and hobby collecting.',
    display_title: 'The Poorhammer Podcast',
    blurb: 'Warhammer games podcast covering strategy, hobby tips, and army building.'
  },
  '1608040662': { // Nerd of Mouth
    topics: [{ node: 'comedy', confidence: 0.85 }, { node: 'gaming', confidence: 0.5 }],
    needs_review: false,
    rationale: 'Comedians discussing nerd culture, gaming speedruns, collectibles, and anime.',
    display_title: 'Nerd of Mouth',
    blurb: 'Comedic podcast exploring nerd culture, video game speedruns, and anime.'
  },
  '1608064632': { // Bedrock
    topics: [{ node: 'science', confidence: 0.9 }, { node: 'nature/earth-science', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Geology-focused podcast exploring Earth\'s Precambrian history.',
    display_title: 'Bedrock: Earth\'s Earliest History',
    blurb: 'Geological exploration of Earth\'s first 90% of history and planetary science.'
  },
  '1608109038': { // Gubba Homestead
    topics: [{ node: 'craft/diy-home', confidence: 0.9 }],
    needs_review: false,
    rationale: 'Traditional homesteading skills including gardening, animal husbandry, and food preservation.',
    display_title: 'Gubba Homestead Podcast',
    blurb: 'Traditional homesteading skills including gardening, farming, and preservation.'
  },
  '1608442752': { // Golden State Naturalist
    topics: [{ node: 'science', confidence: 0.85 }, { node: 'nature', confidence: 0.9 }],
    needs_review: false,
    rationale: 'California ecology and natural history with expert interviews.',
    display_title: 'Golden State Naturalist',
    blurb: 'California\'s ecology, wildlife, and environmental history through expert interviews.'
  },
  '1611134496': { // About Sustainability
    topics: [{ node: 'science', confidence: 0.75 }, { node: 'society', confidence: 0.65 }],
    needs_review: true,
    rationale: 'Sustainability discussions spanning environmental, economic, and social dimensions.',
    display_title: 'About Sustainability',
    blurb: 'In-depth conversations on sustainability from various perspectives.'
  },
  '1611226020': { // The Educated HomeBuyer
    topics: [{ node: 'economics', confidence: 0.9 }, { node: 'education', confidence: 0.5 }],
    needs_review: false,
    rationale: 'Home buying financial education covering mortgages, credit, and market trends.',
    display_title: 'The Educated HomeBuyer',
    blurb: 'Financial education on mortgages, home buying strategies, and credit scores.'
  },
  '1614166584': { // Talking Away the Taboo
    topics: [{ node: 'society', confidence: 0.8 }, { node: 'health/sexuality', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Support and education around infertility, pregnancy loss, and family building.',
    display_title: 'Talking Away the Taboo',
    blurb: 'Community support and education on infertility, pregnancy loss, and adoption.'
  },
  '1614354774': { // What It Was Like
    topics: [{ node: 'personal-journals', confidence: 0.8 }, { node: 'society', confidence: 0.5 }],
    needs_review: false,
    rationale: 'First-person narratives of people who lived through extreme or notable events.',
    display_title: 'What It Was Like',
    blurb: 'Personal accounts from people who experienced extreme historical events.'
  },
  '1614458454': { // Call It What You Want
    topics: [{ node: 'sports/soccer', confidence: 0.95 }],
    needs_review: false,
    rationale: 'US soccer and USMNT coverage with expert analysis and commentary.',
    display_title: 'Call It What You Want',
    blurb: 'USMNT and US soccer analysis from former national team players.'
  },
  '1614480816': { // The Paranormal 60
    topics: [{ node: 'paranormal', confidence: 0.85 }, { node: 'true-crime', confidence: 0.45 }],
    needs_review: false,
    rationale: 'Paranormal, supernatural, UFO, and unsolved mystery content.',
    display_title: 'The Paranormal 60 Network',
    blurb: 'Daily paranormal stories including ghosts, UAPs, aliens, and mysteries.'
  },
  '1614666546': { // Spyology Squad
    topics: [{ node: 'kids-family', confidence: 0.8 }, { node: 'science', confidence: 0.5 }],
    needs_review: false,
    rationale: 'Children\'s podcast blending spy fiction with science education.',
    display_title: 'Spyology Squad',
    blurb: 'Kids\' adventure podcast combining spy fiction with science education.'
  },
  '1615637724': { // Betrayal Weekly
    topics: [{ node: 'true-crime', confidence: 0.9 }],
    needs_review: false,
    rationale: 'True crime narratives focusing on broken trust and personal betrayal.',
    display_title: 'Betrayal Weekly',
    blurb: 'True crime stories of betrayal, deception, and human aftermath.'
  },
  '1617861030': { // Military OneSource
    topics: [{ node: 'society/government', confidence: 0.8 }, { node: 'education', confidence: 0.5 }],
    needs_review: false,
    rationale: 'Military family support and resources from Department of Defense.',
    display_title: 'Military OneSource Podcast',
    blurb: 'DoD resource providing information on military family topics.'
  },
  '1619401632': { // The Resilient Teacher
    topics: [{ node: 'education', confidence: 0.9 }, { node: 'health/mental', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Teacher burnout prevention and educator well-being support.',
    display_title: 'The Resilient Teacher Podcast',
    blurb: 'Support and strategies for educators to prevent burnout and prioritize well-being.'
  },
  '1619978406': { // History Tea Time
    topics: [{ node: 'history', confidence: 0.9 }],
    needs_review: false,
    rationale: 'Women\'s history and royalty from a conversational perspective.',
    display_title: 'History Tea Time',
    blurb: 'Engaging stories about women, queens, and royalty throughout history.'
  },
  '1620275436': { // Calm History
    topics: [{ node: 'history', confidence: 0.85 }, { node: 'paranormal', confidence: 0.3 }],
    needs_review: false,
    rationale: 'Calming sleep stories featuring historical and paranormal topics.',
    display_title: 'Calm History',
    blurb: 'Soothing bedtime stories covering history, paranormal, and true crime.'
  },
  '1621031568': { // Digging Up the Duggars
    topics: [{ node: 'tv-film', confidence: 0.75 }, { node: 'true-crime', confidence: 0.5 }],
    needs_review: false,
    rationale: 'Rewatch and critical analysis of Discovery reality series.',
    display_title: 'Digging Up the Duggars',
    blurb: 'Critical rewatch analysis of Discovery reality series with cultural commentary.'
  },
  '1622316426': { // Dr. Gabrielle Lyon
    topics: [{ node: 'medicine', confidence: 0.8 }, { node: 'health', confidence: 0.75 }],
    needs_review: false,
    rationale: 'Health and wellness discussions from physician on physical and mental health.',
    display_title: 'The Dr. Gabrielle Lyon Show',
    blurb: 'Health and wellness conversations covering physical and mental well-being.'
  },
  '1624715532': { // VeggieTales
    topics: [{ node: 'kids-family', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Children\'s entertainment featuring humor, biblical lessons, and education.',
    display_title: 'VeggieTales: Very Veggie Silly Stories',
    blurb: 'Kids\' comedy podcast with silly stories, songs, and biblical lessons.'
  },
  '1624801326': { // Play Therapy Podcast
    topics: [{ node: 'education/courses', confidence: 0.85 }, { node: 'health/mental', confidence: 0.5 }],
    needs_review: false,
    rationale: 'Professional training and education in child-centered play therapy.',
    display_title: 'Play Therapy Podcast',
    blurb: 'Master-class training in child-centered play therapy for professionals.'
  },
  '1624981488': { // Easy French
    topics: [{ node: 'education/language-learning', confidence: 0.95 }],
    needs_review: false,
    rationale: 'French language learning through authentic conversations.',
    display_title: 'Easy French',
    blurb: 'French language learning through entertaining conversations and topics.'
  },
  '1626527232': { // The Wire at 20
    topics: [{ node: 'tv-film', confidence: 0.9 }, { node: 'tv-film/history', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Analysis of HBO\'s The Wire examining themes and cultural influence.',
    display_title: 'The Wire at 20',
    blurb: 'Retrospective analysis of HBO\'s The Wire with interviews and cultural impact.'
  },
  '1626876180': { // Flavour Talks
    topics: [{ node: 'science', confidence: 0.85 }, { node: 'science/chemistry', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Chemistry and sensory science focusing on smell and taste professionals.',
    display_title: 'Flavour Talks',
    blurb: 'Conversations with chemists and sensory scientists about smell and taste.'
  },
  '1627069896': { // The Video Archives Podcast
    topics: [{ node: 'tv-film', confidence: 0.9 }, { node: 'tv-film/reviews', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Film criticism and recommendations from a legendary video store collection.',
    display_title: 'The Video Archives Podcast',
    blurb: 'Film recommendations and criticism from a legendary video store.'
  },
  '1627248534': { // All Steelers Talk
    topics: [{ node: 'sports', confidence: 0.9 }, { node: 'sports/football', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Pittsburgh Steelers news, analysis, and interviews.',
    display_title: 'All Steelers Talk',
    blurb: 'Pittsburgh Steelers latest news, analysis, and player interviews.'
  },
  '1627795524': { // Theology of the Body 101
    topics: [{ node: 'education/courses', confidence: 0.8 }, { node: 'religion/christianity', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Academic course content on Catholic theology of the body.',
    display_title: 'Theology of the Body 101',
    blurb: 'Academic course on Catholic theology and theology of the body.'
  },
  '1628030958': { // Successful
    topics: [{ node: 'education/self-improvement', confidence: 0.8 }, { node: 'business', confidence: 0.5 }],
    needs_review: false,
    rationale: 'Daily personal development and empowerment podcast.',
    display_title: 'Successful',
    blurb: 'Daily podcast providing personal empowerment tools for life change.'
  },
  '1628348754': { // The Jeff Gerstmann Show
    topics: [{ node: 'gaming', confidence: 0.9 }],
    needs_review: false,
    rationale: 'Video game industry analysis and criticism from veteran journalist.',
    display_title: 'The Jeff Gerstmann Show',
    blurb: 'Weekly video game industry analysis from veteran gaming journalist.'
  },
  '1629844110': { // Friends Per Second
    topics: [{ node: 'gaming', confidence: 0.85 }, { node: 'comedy', confidence: 0.4 }],
    needs_review: false,
    rationale: 'Informal video game podcast with three hosts discussing gaming.',
    display_title: 'Friends Per Second',
    blurb: 'Three gaming personalities discuss video games and industry news.'
  },
  '1630002174': { // The People\'s Court
    topics: [{ node: 'society/law', confidence: 0.8 }, { node: 'true-crime', confidence: 0.5 }],
    needs_review: false,
    rationale: 'Judge-hosted show discussing real court cases and legal decisions.',
    display_title: 'The People\'s Court Podcast',
    blurb: 'Judge discusses real court cases and legal decisions from Emmy-winning show.'
  },
  '1631381118': { // Ship of the Dead
    topics: [{ node: 'gaming', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Tabletop RPG actual-play podcast with pirate and fantasy themes.',
    display_title: 'Ship of the Dead Podcast',
    blurb: 'Actual-play tabletop RPG podcast featuring Dungeons & Dragons.'
  },
  '1633515294': { // Wellness, Actually
    topics: [{ node: 'medicine', confidence: 0.85 }, { node: 'health', confidence: 0.8 }],
    needs_review: false,
    rationale: 'Health and wellness news analysis cutting through misinformation.',
    display_title: 'Wellness, Actually',
    blurb: 'Clear analysis of health and wellness news from medical professionals.'
  },
  '1633759050': { // Twenty Sides
    topics: [{ node: 'gaming', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Fast-paced Dungeons & Dragons actual-play podcast with narrative focus.',
    display_title: 'Twenty Sides: A DnD Podcast',
    blurb: 'Story-driven Dungeons & Dragons actual-play podcast.'
  },
  '1634135028': { // UNBIASED Politics
    topics: [{ node: 'news/politics', confidence: 0.85 }, { node: 'news/commentary', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Political and legal news with impartial analysis and fact-checking.',
    display_title: 'UNBIASED Politics',
    blurb: 'Impartial US politics and legal news analysis without partisan spin.'
  },
  '1634356920': { // 张小珺
    topics: [{ node: 'business', confidence: 0.8 }, { node: 'computing', confidence: 0.6 }],
    needs_review: true,
    rationale: 'Chinese language business and technology interview podcast.',
    display_title: '张小珺Jùn',
    blurb: 'Long-form Chinese business and technology interviews.'
  },
  '1634491338': { // Do Good To Lead Well
    topics: [{ node: 'business/management', confidence: 0.85 }],
    needs_review: false,
    rationale: 'Self-leadership and professional development focused podcast.',
    display_title: 'Do Good To Lead Well',
    blurb: 'Self-leadership and professional development for better leadership.'
  },
  '1634874522': { // Talk To Me In Korean
    topics: [{ node: 'education/language-learning', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Korean language learning podcast emphasizing motivation.',
    display_title: 'Talk To Me In Korean',
    blurb: 'Korean language learning podcast designed for easy, motivated learning.'
  },
  '1636696986': { // Know Your Power
    topics: [{ node: 'health/fitness', confidence: 0.9 }, { node: 'sports', confidence: 0.5 }],
    needs_review: false,
    rationale: 'Fitness and mindset podcast hosted by professional fitness competitors.',
    display_title: 'Know Your Power',
    blurb: 'Fitness and mindset podcast from IFBB PRO athletes.'
  },
  '1637180412': { // Nichole Ford LCSW
    topics: [{ node: 'education/courses', confidence: 0.85 }, { node: 'health/mental', confidence: 0.5 }],
    needs_review: false,
    rationale: 'Licensing exam preparation for clinical social workers.',
    display_title: 'Nichole Ford LCSW',
    blurb: 'LCSW exam preparation course and study guidance.'
  },
  '1637353704': { // The Cartesian Cafe
    topics: [{ node: 'science', confidence: 0.85 }, { node: 'math', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Scientific and mathematical concepts discussed with expert guests.',
    display_title: 'The Cartesian Cafe',
    blurb: 'Mapping scientific and mathematical concepts with expert discussions.'
  },
  '1637519892': { // Doing It Together
    topics: [{ node: 'health/sexuality', confidence: 0.85 }, { node: 'relationships', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Marriage intimacy and sexual health education for couples.',
    display_title: 'Doing It Together',
    blurb: 'Empowering couples to heal from cultural messages about intimacy.'
  },
  '1637626050': { // Align with Jenna Zoe
    topics: [{ node: 'philosophy', confidence: 0.7 }, { node: 'education/self-improvement', confidence: 0.55 }],
    needs_review: true,
    rationale: 'Personal development using Human Design system.',
    display_title: 'Align with Jenna Zoe',
    blurb: 'Personal development using Human Design framework for self-discovery.'
  },
  '1638152136': { // Transformation Horizon
    topics: [{ node: 'business/management', confidence: 0.8 }, { node: 'education', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Organizational development and workplace culture transformation.',
    display_title: 'Transformation Horizon',
    blurb: 'Organizational development helping leaders build inclusive workplaces.'
  },
  '1638615408': { // The Rick and Kelly Show
    topics: [{ node: 'comedy', confidence: 0.8 }, { node: 'comedy/casual-hangs', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Unfiltered talk show from TV personalities.',
    display_title: 'The Rick and Kelly Show',
    blurb: 'Talk show from TV personalities with unfiltered conversation.'
  },
  '1638628704': { // Latter Day Bridge Builders
    topics: [{ node: 'religion', confidence: 0.75 }, { node: 'philosophy', confidence: 0.65 }],
    needs_review: false,
    rationale: 'Interfaith dialogue between active and former Latter-day Saints.',
    display_title: 'Latter Day Bridge Builders',
    blurb: 'Building dialogue between active and former Latter-day Saints.'
  },
  '1638932196': { // M字闲聊
    topics: [{ node: 'culture/pop-culture', confidence: 0.7 }, { node: 'music', confidence: 0.6 }],
    needs_review: true,
    rationale: 'Chinese language casual podcast on relationships, music, and culture.',
    display_title: 'M字闲聊',
    blurb: 'Chinese casual podcast about love, city life, music, and culture.'
  },
  '1641798510': { // Come Back Podcast
    topics: [{ node: 'religion', confidence: 0.8 }, { node: 'personal-journals', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Stories of people returning to Latter-day Saint faith.',
    display_title: 'Come Back Podcast',
    blurb: 'Personal stories of individuals returning to Latter-day Saint community.'
  },
  '1642091664': { // Deconstructing the Myth
    topics: [{ node: 'philosophy', confidence: 0.75 }, { node: 'religion', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Podcast exploring evangelical church deconstruction narratives.',
    display_title: 'Deconstructing the Myth',
    blurb: 'Exploring why people raised in evangelical churches are leaving faith.'
  },
  '1642334178': { // You Might Be Right
    topics: [{ node: 'news/politics', confidence: 0.85 }, { node: 'news/commentary', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Political discussion between former Tennessee governors.',
    display_title: 'You Might Be Right',
    blurb: 'Former governors discuss politics, media, and current events.'
  },
  '1643053152': { // The Motivation Mindset
    topics: [{ node: 'education/self-improvement', confidence: 0.8 }, { node: 'business', confidence: 0.5 }],
    needs_review: false,
    rationale: 'Time management and practical productivity coaching podcast.',
    display_title: 'The Motivation Mindset',
    blurb: 'Award-winning time management and practical productivity coaching.'
  },
  '1643735064': { // Camp Counselors
    topics: [{ node: 'comedy', confidence: 0.85 }, { node: 'comedy/casual-hangs', confidence: 0.7 }],
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
    rationale: 'Practical preparedness and self-sufficiency skills education.',
    display_title: 'The Common Sense Practical Prepper',
    blurb: 'Practical preparedness and self-sufficiency skills and education.'
  },
  '1645885248': { // The Langley Files
    topics: [{ node: 'society/government', confidence: 0.85 }, { node: 'history', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Official CIA podcast sharing institutional history and perspectives.',
    display_title: 'The Langley Files: CIA\'s Podcast',
    blurb: 'Official CIA podcast on institutional history and operations.'
  }
};

// Process all shows
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
  }
});

const resultsPath = `/home/user/foray/data-local/classify-results-${batch.batch_id}.json`;
fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));

console.log(`Classified ${Object.keys(classifications).length} shows`);
console.log(`Results written to: ${resultsPath}`);
