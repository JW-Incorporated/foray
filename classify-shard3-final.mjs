import fs from 'fs';

// Load the batch input
const batchPath = '/home/user/foray/data-local/classify-batch-fresh-2026-08-27-91f8e77c.json';
const batchData = JSON.parse(fs.readFileSync(batchPath, 'utf-8'));

// Classify all shows
const results = {
  batch_id: batchData.batch_id,
  results: {}
};

// Classification logic for each show
const classifications = {
  1638199777: {
    topics: [
      { node: 'medicine/neuroscience', confidence: 0.85 },
      { node: 'medicine', confidence: 0.75 }
    ],
    needs_review: false,
    rationale: 'Medical education for critical care fundamentals and intensive treatment.',
    display_title: 'ICUedu',
    blurb: 'Medical education covering emergency critical care management, ventilation, and intensive care clinical decision-making.'
  },
  1638615408: {
    topics: [
      { node: 'society', confidence: 0.7 }
    ],
    needs_review: true,
    rationale: 'Daily celebrity commentary and personal anecdotes without defined topical focus.',
    display_title: 'The Rick and Kelly Show',
    blurb: 'Daily news and celebrity commentary from Fox News and Bravo TV personalities.'
  },
  1639961270: {
    topics: [
      { node: 'medicine', confidence: 0.9 }
    ],
    needs_review: false,
    rationale: 'Audio board review course for medical students on family medicine topics.',
    display_title: 'High Yield Family Medicine',
    blurb: 'Concise medical education for family medicine board exams with practice questions.'
  },
  1640142466: {
    topics: [
      { node: 'sports/endurance', confidence: 0.85 },
      { node: 'adventure', confidence: 0.6 }
    ],
    needs_review: false,
    rationale: 'Trail running stories and culture celebrating athletes, writers, and outdoor personalities.',
    display_title: 'The Trailhead',
    blurb: 'Trail running culture with interviews exploring the people, stories, and personalities of the sport.'
  },
  1640311112: {
    topics: [
      { node: 'society/law', confidence: 0.75 },
      { node: 'society', confidence: 0.65 }
    ],
    needs_review: true,
    rationale: 'Family discussion of politics using therapeutic approaches, politically partisan framing.',
    display_title: 'The Necessary Conversation',
    blurb: 'Family members discuss current political events and policy from differing perspectives.'
  },
  1641383288: {
    topics: [
      { node: 'history/military-modern', confidence: 0.9 },
      { node: 'history', confidence: 0.8 }
    ],
    needs_review: false,
    rationale: 'Deep military history of WWII Pacific campaigns with historian and military perspectives.',
    display_title: 'The Unauthorized History of the Pacific War',
    blurb: 'Detailed military history of WWII Pacific theater tactics, strategies, and historical analysis.'
  },
  1641539908: {
    topics: [
      { node: 'sports', confidence: 0.75 },
      { node: 'culture', confidence: 0.65 }
    ],
    needs_review: false,
    rationale: 'Golf entertainment and Christian faith discussion with PGA Tour professionals.',
    display_title: 'Bible Caddie Podcast',
    blurb: 'Golf banter and Bible study hosted by PGA Tour professionals exploring faith and sport.'
  },
  1642245118: {
    topics: [
      { node: 'culture', confidence: 0.75 }
    ],
    needs_review: false,
    rationale: 'Religious education for LDS missionaries and returned missionaries on faith practice.',
    display_title: 'Preach My Gospel Podcast',
    blurb: 'Faith-based education for missionaries covering spiritual preparation and post-mission transition.'
  },
  1642258990: {
    topics: [
      { node: 'space', confidence: 0.95 },
      { node: 'science', confidence: 0.8 }
    ],
    needs_review: false,
    rationale: 'Daily space news and astronomy discoveries with current missions and discoveries.',
    display_title: 'Astronomy Daily',
    blurb: 'Daily space news covering recent astronomy discoveries, missions, and cosmic events.'
  },
  1643026594: {
    topics: [
      { node: 'society', confidence: 0.7 }
    ],
    needs_review: true,
    rationale: 'Paranormal eyewitness accounts and conspiracy stories without scientific framework.',
    display_title: 'Tinfoil Tales',
    blurb: 'Eyewitness accounts of paranormal phenomena including cryptids, UFOs, and unexplained events.'
  },
  1643053152: {
    topics: [
      { node: 'psychology', confidence: 0.85 },
      { node: 'society', confidence: 0.6 }
    ],
    needs_review: false,
    rationale: 'Time management and productivity tools for adults with ADHD and stress reduction.',
    display_title: 'The Motivation Mindset',
    blurb: 'Practical time management and stress-reduction strategies for daily productivity and focus.'
  },
  1643163707: {
    topics: [
      { node: 'culture', confidence: 0.8 }
    ],
    needs_review: false,
    rationale: 'Grief exploration through interviews with notable individuals about loss experiences.',
    display_title: 'All There Is with Anderson Cooper',
    blurb: 'Intimate conversations about grief, loss, and healing with prominent individuals.'
  },
  1643307527: {
    topics: [
      { node: 'society', confidence: 0.75 },
      { node: 'business', confidence: 0.65 }
    ],
    needs_review: false,
    rationale: 'Long-form interviews with power players across tech, business, media, and politics.',
    display_title: 'On with Kara Swisher',
    blurb: 'In-depth interviews with business and technology leaders on industry and cultural trends.'
  },
  1645873147: {
    topics: [
      { node: 'society', confidence: 0.8 }
    ],
    needs_review: false,
    rationale: 'Practical classroom management strategies and teacher support for educators.',
    display_title: 'The Unteachables Podcast',
    blurb: 'Classroom management strategies and teacher support for secondary educators and leaders.'
  },
  1646783869: {
    topics: [
      { node: 'culture', confidence: 0.7 },
      { node: 'society', confidence: 0.65 }
    ],
    needs_review: true,
    rationale: 'Investigative documentary series examining spiritual influence and narcissism dynamics.',
    display_title: 'WTF is on my Mind?!',
    blurb: 'Investigative stories examining cult dynamics, narcissism, and high-control organizations.'
  },
  1647637080: {
    topics: [
      { node: 'society', confidence: 0.75 },
      { node: 'society/law', confidence: 0.65 }
    ],
    needs_review: true,
    rationale: 'True crime and fertility industry ethics investigated through family impact stories.',
    display_title: 'BioHacked: Family Secrets',
    blurb: 'True crime and fertility industry ethics told through stories of donor-conceived families.'
  },
  1648228034: {
    topics: [
      { node: 'business', confidence: 0.85 },
      { node: 'space', confidence: 0.6 }
    ],
    needs_review: false,
    rationale: 'Technology trends and future impact with futurist entrepreneur and venture capitalist.',
    display_title: 'Moonshots with Peter Diamandis',
    blurb: 'Technology trends and exponential breakthroughs impacting business and society.'
  },
  1648315417: {
    topics: [
      { node: 'society', confidence: 0.75 },
      { node: 'history', confidence: 0.6 }
    ],
    needs_review: true,
    rationale: 'Investigative journalism on war correspondent death with unclear circumstances.',
    display_title: 'Pig Iron',
    blurb: 'Investigative journalism investigating a war correspondent death and complex circumstances.'
  },
  1650142740: {
    topics: [
      { node: 'gaming', confidence: 0.9 }
    ],
    needs_review: false,
    rationale: 'Rapid-fire trivia questions covering diverse topics without extended host commentary.',
    display_title: 'No Chit Chat Trivia',
    blurb: 'Fast-paced trivia questions across movies, television, music, sports, and general knowledge.'
  },
  1652237240: {
    topics: [
      { node: 'society', confidence: 0.75 }
    ],
    needs_review: true,
    rationale: 'UFO disclosure news and whistleblower interviews without scientific verification.',
    display_title: 'It\'s a Very Exciting Time',
    blurb: 'UFO disclosure discussions and UAP (unidentified aerial phenomena) news coverage.'
  },
  1652494328: {
    topics: [
      { node: 'culture', confidence: 0.85 }
    ],
    needs_review: false,
    rationale: 'Stories of saints, mystics, and visionaries from religious and spiritual traditions.',
    display_title: 'The Flowered Path',
    blurb: 'Stories of saints, folk saints, mystics, and visionaries across spiritual traditions.'
  },
  1652941051: {
    topics: [
      { node: 'society', confidence: 0.8 }
    ],
    needs_review: false,
    rationale: 'In-depth investigative reporting on major celebrity scandals and controversial figures.',
    display_title: 'Infamous',
    blurb: 'Investigative journalism examining explosive celebrity scandals and powerful figures.'
  },
  1655062070: {
    topics: [
      { node: 'society', confidence: 0.75 }
    ],
    needs_review: false,
    rationale: 'Long-form conversations with veterans about military service and post-military careers.',
    display_title: 'Military Retirement Podcast',
    blurb: 'Conversations with military veterans about service, retirement, and life transitions.'
  },
  1657299416: {
    topics: [
      { node: 'culture', confidence: 0.75 }
    ],
    needs_review: true,
    rationale: 'Multimedia reviews and interviews without clear subject focus or coherent topic.',
    display_title: 'Nostalgic Canuck',
    blurb: 'Multimedia review show with occasional interviews on various cultural topics.'
  },
  1658287076: {
    topics: [
      { node: 'society', confidence: 0.8 }
    ],
    needs_review: false,
    rationale: 'Home organization and decluttering strategies rooted in Christian faith principles.',
    display_title: 'Organized On Purpose',
    blurb: 'Faith-based home organization and decluttering strategies for Christian families.'
  },
  1658397502: {
    topics: [
      { node: 'society', confidence: 0.75 }
    ],
    needs_review: false,
    rationale: 'Think-tank discussions on defense, deterrence, and strategic policy analysis.',
    display_title: 'The NIDS View',
    blurb: 'Defense and deterrence discussions from think-tank analysts and strategy professionals.'
  },
  1662104886: {
    topics: [
      { node: 'business', confidence: 0.85 },
      { node: 'society', confidence: 0.65 }
    ],
    needs_review: false,
    rationale: 'Nonprofit fundraising and marketing strategies for community organizations.',
    display_title: 'Purpose & Profit Club',
    blurb: 'Nonprofit fundraising and marketing tactics to double results and community engagement.'
  },
  1662280027: {
    topics: [
      { node: 'society', confidence: 0.8 }
    ],
    needs_review: false,
    rationale: 'Teacher support covering classroom management, burnout, and student engagement.',
    display_title: 'Enjoy Teaching Again',
    blurb: 'Classroom management and SEL strategies to reduce teacher burnout and engagement.'
  },
  1663554880: {
    topics: [
      { node: 'society', confidence: 0.8 }
    ],
    needs_review: false,
    rationale: 'Daily celebrity gossip and reality TV recap with unfiltered commentary.',
    display_title: 'Daily Dose of Dana',
    blurb: 'Daily celebrity drama and reality TV recap with entertaining cultural commentary.'
  },
  1663649339: {
    topics: [
      { node: 'society', confidence: 0.75 }
    ],
    needs_review: false,
    rationale: 'Quick health and life tips from AARP for adults of all ages.',
    display_title: 'Today\'s Tips from AARP',
    blurb: 'Quick practical tips on health, finance, and happiness for adults at any age.'
  },
  1665823746: {
    topics: [
      { node: 'music', confidence: 0.85 },
      { node: 'business', confidence: 0.65 }
    ],
    needs_review: false,
    rationale: 'Artist interviews on success stories, creative survival, and industry experience.',
    display_title: 'Artist Friendly with Joel Madden',
    blurb: 'Artist interviews exploring success stories, creative challenges, and industry insights.'
  },
  1666678354: {
    topics: [
      { node: 'business', confidence: 0.85 },
      { node: 'economics', confidence: 0.75 }
    ],
    needs_review: false,
    rationale: 'Economic analysis of everyday consumer products and business decisions.',
    display_title: 'The Economics of Everyday Things',
    blurb: 'Economic analysis of everyday consumer products revealing surprising business stories.'
  },
  1666708976: {
    topics: [
      { node: 'sports/endurance', confidence: 0.8 }
    ],
    needs_review: false,
    rationale: 'Motivational stories of extraordinary achievement for inspiration and endurance.',
    display_title: 'Keep Hammering Collective',
    blurb: 'Motivational interviews with outliers and achievers inspiring daily perseverance.'
  },
  1668446687: {
    topics: [
      { node: 'nature', confidence: 0.85 }
    ],
    needs_review: false,
    rationale: 'Holistic pet health and wellness practices from a veterinary perspective.',
    display_title: 'Naturally Healthy Pets Podcast',
    blurb: 'Holistic pet health and wellness strategies from veterinary experts.'
  },
  1671039476: {
    topics: [
      { node: 'culture', confidence: 0.75 }
    ],
    needs_review: true,
    rationale: 'Comedy commentary on internet culture and personalities without consistent focus.',
    display_title: 'Guys: With Bryan Quinby',
    blurb: 'Comedy commentary investigating internet culture and various online personalities.'
  },
  1671374807: {
    topics: [
      { node: 'culture', confidence: 0.8 }
    ],
    needs_review: false,
    rationale: 'Wellness and spirituality resources for individuals, families, and communities.',
    display_title: 'Living Compass Spirituality',
    blurb: 'Spirituality and wellness resources for personal relationships and community.'
  },
  1671380024: {
    topics: [
      { node: 'sports', confidence: 0.85 }
    ],
    needs_review: false,
    rationale: 'Behind-the-scenes coverage of Milwaukee Brewers team and players.',
    display_title: 'Brewers All Access',
    blurb: 'Behind-the-scenes access to Milwaukee Brewers team, players, and staff coverage.'
  },
  1671873182: {
    topics: [
      { node: 'culture', confidence: 0.75 }
    ],
    needs_review: true,
    rationale: 'Comedy and personal stories about dating and intimate relationships.',
    display_title: 'Intimacy Coordinator',
    blurb: 'Comedy and candid stories about dating, relationships, and intimate experiences.'
  },
  1672092973: {
    topics: [
      { node: 'culture', confidence: 0.9 }
    ],
    needs_review: false,
    rationale: 'Overview of Hinduism history, practices, and contemporary faith expressions.',
    display_title: 'All About Hinduism',
    blurb: 'Comprehensive overview of Hinduism history, practices, and contemporary expressions.'
  },
  1673844450: {
    topics: [
      { node: 'business', confidence: 0.8 }
    ],
    needs_review: false,
    rationale: 'Nonprofit endowment and foundation management for mission-driven organizations.',
    display_title: 'Mission + Markets',
    blurb: 'Nonprofit endowment strategies exploring investment, governance, and mission alignment.'
  },
  1675312085: {
    topics: [
      { node: 'nature', confidence: 0.85 },
      { node: 'craft', confidence: 0.6 }
    ],
    needs_review: false,
    rationale: 'Garden design and horticulture advice from leading gardening experts.',
    display_title: 'Talking Gardens',
    blurb: 'Garden design tips and expert interviews on plants and gardening practices.'
  },
  1676099257: {
    topics: [
      { node: 'economics', confidence: 0.8 }
    ],
    needs_review: true,
    rationale: 'Chinese language personal finance podcast for women emphasizing money strategies.',
    display_title: '搞钱女孩',
    blurb: 'Personal finance stories and wealth strategies from women pursuing financial independence.'
  },
  1676542133: {
    topics: [
      { node: 'culture', confidence: 0.8 }
    ],
    needs_review: false,
    rationale: 'Bravo television show discussion and entertainment analysis.',
    display_title: 'Turtle Time',
    blurb: 'Relaxed Bravo television discussion and analysis with friends.'
  },
  1676817109: {
    topics: [
      { node: 'society', confidence: 0.75 }
    ],
    needs_review: false,
    rationale: 'Weekly documentary stories of true crime, history, and mysteries.',
    display_title: 'The Compendium',
    blurb: 'Weekly true crime and historical stories told completely in single episodes.'
  },
  1676849476: {
    topics: [
      { node: 'society', confidence: 0.75 }
    ],
    needs_review: false,
    rationale: 'Interviews with people wrongfully portrayed in headlines seeking second chances.',
    display_title: 'Miss Understood',
    blurb: 'Interviews with people wrongly portrayed in media seeking to change their narrative.'
  },
  1676984700: {
    topics: [
      { node: 'economics', confidence: 0.85 }
    ],
    needs_review: false,
    rationale: 'Credit card points optimization and travel rewards strategy for professionals.',
    display_title: 'Point Me to First Class',
    blurb: 'Credit card rewards and points strategies for professionals seeking travel opportunities.'
  },
  1677424942: {
    topics: [
      { node: 'society/law', confidence: 0.85 }
    ],
    needs_review: false,
    rationale: 'Healthcare policy and legislation analysis for real-world patient impacts.',
    display_title: 'DC EKG',
    blurb: 'Healthcare policy analysis and legislation impacts on patients and providers.'
  },
  1678330734: {
    topics: [
      { node: 'culture', confidence: 0.75 }
    ],
    needs_review: false,
    rationale: 'Reality TV personality life events and entertainment industry commentary.',
    display_title: 'When Reality Hits',
    blurb: 'Reality TV personality discussing off-camera life, relationships, and entertainment.'
  },
  1679458321: {
    topics: [
      { node: 'gaming', confidence: 0.9 }
    ],
    needs_review: false,
    rationale: 'Card game strategy and tips for Marvel Champions enthusiasts.',
    display_title: 'Winning Hand',
    blurb: 'Card game strategy, tips, and deck discussions for Marvel Champions players.'
  },
  1679696860: {
    topics: [
      { node: 'sports', confidence: 0.9 }
    ],
    needs_review: false,
    rationale: 'Fantasy football analysis covering best ball, dynasty, and seasonal strategies.',
    display_title: 'Legendary Upside',
    blurb: 'Fantasy football analysis covering best ball, dynasty, and analytical strategies.'
  },
  1679872468: {
    topics: [
      { node: 'culture', confidence: 0.8 }
    ],
    needs_review: false,
    rationale: 'Bible-based nature and science education for curious children and families.',
    display_title: 'Nat Theo',
    blurb: 'Bible-based nature science education for children exploring creation and faith.'
  },
  1680633614: {
    topics: [
      { node: 'computing', confidence: 0.85 }
    ],
    needs_review: false,
    rationale: 'Daily artificial intelligence news covering ethics, business, and technology.',
    display_title: 'The AI Daily Brief',
    blurb: 'Daily artificial intelligence news covering tools, ethics, and technology trends.'
  },
  1681407595: {
    topics: [
      { node: 'culture', confidence: 0.75 }
    ],
    needs_review: false,
    rationale: 'Reality TV recap with Gen X perspective and cultural analysis.',
    display_title: 'Little Miss Recap',
    blurb: 'Reality TV recaps with Gen X perspective on culture and life choices.'
  },
  1681880668: {
    topics: [
      { node: 'nature', confidence: 0.85 }
    ],
    needs_review: false,
    rationale: 'Pet health and environmental sustainability from holistic veterinary perspective.',
    display_title: 'Better Humans, Better Planet',
    blurb: 'Pet health and environmental sustainability approaches for healthier pets.'
  },
  1683302878: {
    topics: [
      { node: 'sports', confidence: 0.85 }
    ],
    needs_review: false,
    rationale: 'Las Vegas Raiders insider analysis and football network podcast.',
    display_title: 'Raiders Insider',
    blurb: 'Las Vegas Raiders insider analysis and professional football news coverage.'
  }
};

// Map all batch shows to results
for (const show of batchData.shows) {
  const id = show.apple_collection_id;
  if (classifications[id]) {
    results.results[id] = {
      ...classifications[id],
      model: 'claude-code-cron (tier 1)'
    };
  }
}

// Write results
const resultsPath = '/home/user/foray/data-local/classify-results-fresh-2026-08-27-91f8e77c.json';
fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));

console.log(`Classified ${Object.keys(results.results).length} shows.`);
console.log(`Results written to ${resultsPath}`);
