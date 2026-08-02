#!/usr/bin/env node
import fs from 'fs';

const batchPath = 'data-local/classify-batch-fresh-2026-08-02-db82dc82.json';
const taxonomyPath = 'data/taxonomy.json';
const outputPath = 'data-local/classify-results-fresh-2026-08-02-db82dc82.json';

const batch = JSON.parse(fs.readFileSync(batchPath, 'utf-8'));
const taxonomy = JSON.parse(fs.readFileSync(taxonomyPath, 'utf-8'));

const validNodeIds = new Set(taxonomy.nodes.map(n => n.id));

const results = {
  batch_id: batch.batch_id,
  results: {}
};

// Manual classifications based on description + episodes analysis
const classifications = [
  {
    id: 1435078293,
    title: 'Siempre es Lunes',
    topics: [{node: 'comedy', confidence: 0.9}, {node: 'culture', confidence: 0.7}],
    needs_review: false,
    rationale: 'Puerto Rican comedy show with casual interviews, culture, and politics.',
    display_title: 'Siempre es Lunes',
    blurb: 'Weekly comedy featuring local Puerto Rican culture, wrestling, and political commentary.'
  },
  {
    id: 1435091247,
    title: 'I Love Old Time Radio',
    topics: [{node: 'culture', confidence: 0.9}, {node: 'history', confidence: 0.75}],
    needs_review: false,
    rationale: 'Archive of classic Golden Age radio programs from 1940s–50s.',
    display_title: 'I Love Old Time Radio',
    blurb: 'Classic old-time radio programs from the 1940s–50s with comedy, drama, and adventure.'
  },
  {
    id: 1435217865,
    title: 'Women of Impact',
    topics: [{node: 'society', confidence: 0.8}, {node: 'culture', confidence: 0.65}],
    needs_review: false,
    rationale: 'Interviews with influential women across various fields and professions.',
    display_title: 'Women of Impact',
    blurb: 'Interviews with influential women sharing their stories and impact across careers.'
  },
  {
    id: 1435720647,
    title: 'The Well Of Sound',
    topics: [{node: 'music', confidence: 0.9}, {node: 'history', confidence: 0.6}],
    needs_review: false,
    rationale: 'Explores music history, composition, and musical traditions.',
    display_title: 'The Well Of Sound',
    blurb: 'Podcast examining music history, composition techniques, and musical traditions.'
  },
  {
    id: 1435805049,
    title: 'Locked On Wolverines',
    topics: [{node: 'sports', confidence: 0.95}, {node: 'education', confidence: 0.3}],
    needs_review: false,
    rationale: 'Daily coverage of University of Michigan football and basketball.',
    display_title: 'Locked On Wolverines',
    blurb: 'Daily podcast covering Michigan Wolverines football and basketball news and analysis.'
  },
  {
    id: 1435996305,
    title: 'On The Ball with Ric Bucher',
    topics: [{node: 'sports', confidence: 0.95}],
    needs_review: false,
    rationale: 'Basketball commentary and analysis from sports journalist Ric Bucher.',
    display_title: 'On The Ball with Ric Bucher',
    blurb: 'Basketball news and analysis with veteran sports journalist Ric Bucher.'
  },
  {
    id: 1436054787,
    title: 'America 2.0',
    topics: [{node: 'society', confidence: 0.75}, {node: 'news', confidence: 0.65}],
    needs_review: false,
    rationale: 'Explores American culture, society, and contemporary issues.',
    display_title: 'America 2.0',
    blurb: 'Examining contemporary American culture, society, and cultural transformation.'
  },
  {
    id: 1436269131,
    title: 'Gaze At the National Parks',
    topics: [{node: 'travel', confidence: 0.8}, {node: 'nature', confidence: 0.75}],
    needs_review: false,
    rationale: 'Guide to exploring America\'s national parks and wilderness.',
    display_title: 'Gaze At the National Parks',
    blurb: 'Explore America\'s national parks with travel guides and nature insights.'
  },
  {
    id: 1436449587,
    title: 'Not Today Cancer',
    topics: [{node: 'health', confidence: 0.9}, {node: 'medicine', confidence: 0.7}],
    needs_review: false,
    rationale: 'Cancer awareness, support, and wellness from alternative health perspective.',
    display_title: 'Not Today Cancer',
    blurb: 'Cancer awareness and wellness support with alternative health approaches.'
  },
  {
    id: 1436511777,
    title: 'House Guest with Kenzie Elizabeth',
    topics: [{node: 'relationships', confidence: 0.8}, {node: 'society', confidence: 0.6}],
    needs_review: false,
    rationale: 'Conversations about relationships, personal stories, and life experiences.',
    display_title: 'House Guest with Kenzie Elizabeth',
    blurb: 'Personal conversations about relationships and life experiences.'
  },
  {
    id: 1436881257,
    title: 'Artful Painter',
    topics: [{node: 'culture', confidence: 0.85}, {node: 'craft', confidence: 0.7}],
    needs_review: false,
    rationale: 'Visual arts, painting techniques, and artist interviews.',
    display_title: 'Artful Painter',
    blurb: 'Exploring painting techniques and interviews with visual artists.'
  },
  {
    id: 1436998731,
    title: 'Código Misterio',
    topics: [{node: 'religion', confidence: 0.7}, {node: 'paranormal', confidence: 0.6}],
    needs_review: true,
    rationale: 'Spanish-language exploration of spirituality and mysterious phenomena.',
    display_title: 'Código Misterio',
    blurb: 'Spanish-language podcast exploring spiritual and mysterious topics.'
  },
  {
    id: 1437029685,
    title: 'Creative Voyage Podcast',
    topics: [{node: 'culture', confidence: 0.8}, {node: 'craft', confidence: 0.75}],
    needs_review: false,
    rationale: 'Creative practices, design thinking, and artistic pursuits.',
    display_title: 'Creative Voyage Podcast',
    blurb: 'Exploring creative practices and design thinking for artists and makers.'
  },
  {
    id: 1437360249,
    title: 'Dark Dice',
    topics: [{node: 'fiction', confidence: 0.9}, {node: 'gaming', confidence: 0.65}],
    needs_review: false,
    rationale: 'Fantasy audio drama based on tabletop gaming campaigns.',
    display_title: 'Dark Dice',
    blurb: 'Audio drama series featuring fantasy storytelling and tabletop gaming campaigns.'
  },
  {
    id: 1437834171,
    title: 'The Great Indoors',
    topics: [{node: 'culture', confidence: 0.75}, {node: 'hobbies', confidence: 0.7}],
    needs_review: false,
    rationale: 'Indoor design, home decoration, and domestic living spaces.',
    display_title: 'The Great Indoors',
    blurb: 'Exploring interior design and home decoration for better living spaces.'
  },
  {
    id: 1437953157,
    title: 'The Tolkien Professor',
    topics: [{node: 'culture', confidence: 0.85}, {node: 'fiction', confidence: 0.8}],
    needs_review: false,
    rationale: 'Tolkien scholarship, literary analysis, and fantasy worldbuilding.',
    display_title: 'The Tolkien Professor',
    blurb: 'In-depth analysis of Tolkien\'s works and literary significance.'
  },
  {
    id: 1439737935,
    title: 'Basic Folk',
    topics: [{node: 'music', confidence: 0.95}, {node: 'culture', confidence: 0.6}],
    needs_review: false,
    rationale: 'Folk music genre, singer-songwriters, and traditional music.',
    display_title: 'Basic Folk',
    blurb: 'Folk music interviews and discussions with singer-songwriters.'
  },
  {
    id: 1439938731,
    title: 'American Perfumer',
    topics: [{node: 'craft', confidence: 0.85}, {node: 'culture', confidence: 0.65}],
    needs_review: false,
    rationale: 'Perfume crafting, fragrance design, and olfactory artistry.',
    display_title: 'American Perfumer',
    blurb: 'Exploring the craft of perfume-making and fragrance design.'
  },
  {
    id: 1440327855,
    title: 'Childish',
    topics: [{node: 'kids-family', confidence: 0.85}, {node: 'education', confidence: 0.65}],
    needs_review: false,
    rationale: 'Parenting advice, child development, and family dynamics.',
    display_title: 'Childish',
    blurb: 'Parenting perspectives and child development from various experts.'
  },
  {
    id: 1441470249,
    title: 'The Spokesman Speaks: Ag Insights for Your Farm',
    topics: [{node: 'business', confidence: 0.85}, {node: 'nature/earth-science', confidence: 0.75}],
    needs_review: false,
    rationale: 'Agricultural economy, farming practices, and sustainable agriculture.',
    display_title: 'The Spokesman Speaks',
    blurb: 'Agricultural economy and sustainable farming practices for farmers.'
  },
  {
    id: 1441557261,
    title: 'Low Carb MD Podcast',
    topics: [{node: 'medicine', confidence: 0.9}, {node: 'health', confidence: 0.85}],
    needs_review: false,
    rationale: 'Medical perspective on low-carb diets and nutritional medicine.',
    display_title: 'Low Carb MD Podcast',
    blurb: 'Medical doctors discuss low-carbohydrate nutrition and health benefits.'
  },
  {
    id: 1441680063,
    title: 'Nitzotzos: Inspiration to Keep Your Spark',
    topics: [{node: 'religion', confidence: 0.9}, {node: 'philosophy', confidence: 0.65}],
    needs_review: false,
    rationale: 'Jewish spiritual teachings and inspirational lessons from Rabbi Burg.',
    display_title: 'Nitzotzos',
    blurb: 'Jewish spiritual inspiration with Rabbi Mordechai Burg.'
  },
  {
    id: 1441969737,
    title: 'The Rogue Agronomist',
    topics: [{node: 'nature', confidence: 0.9}, {node: 'science', confidence: 0.8}],
    needs_review: false,
    rationale: 'Soil science, agricultural ecology, and sustainable farming.',
    display_title: 'The Rogue Agronomist',
    blurb: 'Soil science and sustainable agricultural practices from an expert agronomist.'
  },
  {
    id: 1442273607,
    title: 'Everything Under The Sun',
    topics: [{node: 'kids-family', confidence: 0.9}, {node: 'education', confidence: 0.85}],
    needs_review: false,
    rationale: 'Educational content for children covering diverse topics.',
    display_title: 'Everything Under The Sun',
    blurb: 'Educational podcast for children covering science, culture, and nature.'
  },
  {
    id: 1442464821,
    title: 'Mitch Unfiltered',
    topics: [{node: 'sports', confidence: 0.95}, {node: 'society', confidence: 0.4}],
    needs_review: false,
    rationale: 'Football commentary and sports analysis from host Mitch.',
    display_title: 'Mitch Unfiltered',
    blurb: 'Unfiltered football commentary and sports analysis.'
  },
  {
    id: 1443447819,
    title: 'Pretending to be People',
    topics: [{node: 'comedy', confidence: 0.9}, {node: 'fiction', confidence: 0.7}],
    needs_review: false,
    rationale: 'Improvisation-based comedy with character-driven storytelling.',
    display_title: 'Pretending to be People',
    blurb: 'Improvisation-based comedy featuring character-driven storytelling.'
  },
  {
    id: 1444357023,
    title: 'BBC Earth Podcast',
    topics: [{node: 'nature', confidence: 0.95}, {node: 'science', confidence: 0.75}],
    needs_review: false,
    rationale: 'Natural world, wildlife, and environmental science from BBC.',
    display_title: 'BBC Earth Podcast',
    blurb: 'Wildlife and natural world from BBC featuring science and conservation.'
  },
  {
    id: 1444490547,
    title: 'Furbo | فوربو',
    topics: [{node: 'business', confidence: 0.85}, {node: 'economics', confidence: 0.65}],
    needs_review: false,
    rationale: 'Business strategy, marketing, and entrepreneurial insights.',
    display_title: 'Furbo',
    blurb: 'Business and marketing strategies for entrepreneurs.'
  },
  {
    id: 1444501971,
    title: 'The Dharma Podcast',
    topics: [{node: 'religion', confidence: 0.95}, {node: 'philosophy', confidence: 0.7}],
    needs_review: false,
    rationale: 'Hindu philosophy, spiritual teachings, and dharma practices.',
    display_title: 'The Dharma Podcast',
    blurb: 'Hindu philosophy and spiritual teachings exploring dharma and practice.'
  },
  {
    id: 1445368869,
    title: 'Sound By Nature',
    topics: [{node: 'nature', confidence: 0.9}, {node: 'music', confidence: 0.5}],
    needs_review: false,
    rationale: 'Natural soundscapes, field recordings, and environmental audio.',
    display_title: 'Sound By Nature',
    blurb: 'Natural soundscapes and field recordings from the environment.'
  },
  {
    id: 1446211545,
    title: 'Directo MARCA',
    topics: [{node: 'sports', confidence: 0.95}, {node: 'news', confidence: 0.6}],
    needs_review: false,
    rationale: 'Spanish-language sports news and live coverage.',
    display_title: 'Directo MARCA',
    blurb: 'Spanish-language sports news and live coverage.'
  },
  {
    id: 1446336657,
    title: 'Buzzcast',
    topics: [{node: 'computing', confidence: 0.85}, {node: 'news', confidence: 0.75}],
    needs_review: false,
    rationale: 'Technology news, startup trends, and innovation coverage.',
    display_title: 'Buzzcast',
    blurb: 'Technology news and startup trends with industry updates.'
  },
  {
    id: 1446371409,
    title: 'The Most Dwanderful Real Estate',
    topics: [{node: 'business', confidence: 0.9}, {node: 'economics', confidence: 0.65}],
    needs_review: false,
    rationale: 'Real estate business strategies, investment, and entrepreneurship.',
    display_title: 'The Most Dwanderful Real Estate',
    blurb: 'Real estate business and entrepreneurship strategies.'
  },
  {
    id: 1447316085,
    title: 'Creative Queso Podcast',
    topics: [{node: 'craft', confidence: 0.85}, {node: 'culture', confidence: 0.6}],
    needs_review: false,
    rationale: 'Crafting, DIY projects, and creative making.',
    display_title: 'Creative Queso Podcast',
    blurb: 'Crafting projects and DIY creative pursuits.'
  },
  {
    id: 1448104149,
    title: 'Daily Sales Tips',
    topics: [{node: 'business', confidence: 0.9}, {node: 'education', confidence: 0.7}],
    needs_review: false,
    rationale: 'Sales techniques, business development, and professional growth.',
    display_title: 'Daily Sales Tips',
    blurb: 'Sales techniques and business development strategies.'
  },
  {
    id: 1448144055,
    title: 'Lets Talk Dubs Classic',
    topics: [{node: 'automotive', confidence: 0.95}, {node: 'culture', confidence: 0.5}],
    needs_review: false,
    rationale: 'Classic Volkswagen vehicles, maintenance, and enthusiast culture.',
    display_title: 'Lets Talk Dubs Classic',
    blurb: 'Classic Volkswagen discussions and automotive enthusiast community.'
  },
  {
    id: 1448263089,
    title: 'The Baton: A John Williams',
    topics: [{node: 'music', confidence: 0.9}, {node: 'tv-film', confidence: 0.8}],
    needs_review: false,
    rationale: 'Analysis of John Williams\'s film scores and composition.',
    display_title: 'The Baton: A John Williams Journey',
    blurb: 'Exploring John Williams\'s legendary film scores and compositions.'
  },
  {
    id: 1448530203,
    title: 'Talking Precision Medicine',
    topics: [{node: 'medicine', confidence: 0.95}, {node: 'science', confidence: 0.8}],
    needs_review: false,
    rationale: 'Precision medicine, genomics, and personalized healthcare.',
    display_title: 'Talking Precision Medicine',
    blurb: 'Precision medicine and genomics in personalized healthcare.'
  },
  {
    id: 1448833161,
    title: 'BJJ Mental Models',
    topics: [{node: 'sports', confidence: 0.9}, {node: 'psychology', confidence: 0.65}],
    needs_review: false,
    rationale: 'Brazilian Jiu-Jitsu techniques, mental strategies, and martial arts.',
    display_title: 'BJJ Mental Models',
    blurb: 'Brazilian Jiu-Jitsu techniques and mental strategies for martial arts.'
  },
  {
    id: 1449325923,
    title: 'GeniusBrain',
    topics: [{node: 'comedy', confidence: 0.8}, {node: 'society', confidence: 0.65}],
    needs_review: false,
    rationale: 'Comedy interviews and conversational humor.',
    display_title: 'GeniusBrain',
    blurb: 'Comedy interviews and humorous conversations.'
  },
  {
    id: 1449365067,
    title: 'Talkin\' Giants',
    topics: [{node: 'sports', confidence: 0.95}, {node: 'news', confidence: 0.4}],
    needs_review: false,
    rationale: 'New York Giants football coverage and NFL analysis.',
    display_title: 'Talkin\' Giants',
    blurb: 'New York Giants football news and NFL analysis.'
  },
  {
    id: 1449372657,
    title: 'Fallout Lorecast',
    topics: [{node: 'gaming', confidence: 0.95}, {node: 'fiction', confidence: 0.8}],
    needs_review: false,
    rationale: 'Fallout video game lore, narrative, and universe analysis.',
    display_title: 'Fallout Lorecast',
    blurb: 'Deep lore analysis of the Fallout video game series.'
  },
  {
    id: 1449434247,
    title: 'Marginal Gains Cycling',
    topics: [{node: 'sports', confidence: 0.9}, {node: 'health', confidence: 0.65}],
    needs_review: false,
    rationale: 'Cycling sport, training, and athletic performance.',
    display_title: 'Marginal Gains Cycling',
    blurb: 'Cycling techniques, training, and athletic performance discussion.'
  },
  {
    id: 1449936525,
    title: 'Random Order Podcast',
    topics: [{node: 'comedy', confidence: 0.9}, {node: 'fiction', confidence: 0.6}],
    needs_review: false,
    rationale: 'Improvisation-based comedy and spontaneous storytelling.',
    display_title: 'Random Order Podcast',
    blurb: 'Improvisation-based comedy and spontaneous creative storytelling.'
  },
  {
    id: 1450115847,
    title: 'Soaring the sky a glider',
    topics: [{node: 'aviation', confidence: 0.95}, {node: 'sports', confidence: 0.5}],
    needs_review: false,
    rationale: 'Glider flying, aviation techniques, and pilot experiences.',
    display_title: 'Soaring the sky',
    blurb: 'Glider flying and aviation experiences from experienced pilots.'
  },
  {
    id: 1450285761,
    title: 'HLTV Confirmed',
    topics: [{node: 'gaming', confidence: 0.95}, {node: 'sports', confidence: 0.6}],
    needs_review: false,
    rationale: 'Counter-Strike esports, competitive gaming, and pro teams.',
    display_title: 'HLTV Confirmed',
    blurb: 'Counter-Strike esports news and competitive gaming coverage.'
  }
];

// Add classifications to results
classifications.forEach(c => {
  results.results[c.id] = {
    topics: c.topics,
    needs_review: c.needs_review,
    rationale: c.rationale,
    display_title: c.display_title,
    blurb: c.blurb,
    model: 'claude-code-cron (tier 1)'
  };
});

// Write output
fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
console.log(`Classified ${Object.keys(results.results).length} shows`);
console.log(`Output written to: ${outputPath}`);
