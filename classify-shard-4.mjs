#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const batchPath = '/home/user/foray/data-local/classify-batch-fresh-2026-07-29-7406ac2a.json';
const batch = JSON.parse(fs.readFileSync(batchPath, 'utf-8'));

// Taxonomy node IDs for reference
const validNodes = new Set([
  'engineering', 'engineering/energy-fusion', 'engineering/precision-mfg', 'engineering/ai-robotics', 'engineering/disasters', 'engineering/energy-grid',
  'science', 'science/materials', 'science/storytelling', 'science/chemistry', 'science/physics',
  'history', 'history/military-ancient', 'history/technology', 'history/military-modern', 'history/archaeology',
  'craft', 'craft/instrument-making', 'craft/diy-home', 'craft/photography', 'craft/filmmaking', 'craft/woodworking',
  'business', 'business/startups', 'business/founders', 'business/careers', 'business/management', 'business/marketing', 'business/non-profit',
  'comedy', 'comedy/casual-hangs', 'comedy/stand-up', 'comedy/interviews',
  'architecture', 'architecture/infrastructure',
  'aviation', 'aviation/accidents',
  'espionage', 'espionage/cold-war-tech',
  'food', 'food/cooking-science', 'food/fermentation',
  'linguistics', 'linguistics/language',
  'math', 'math/puzzles',
  'medicine', 'medicine/biology', 'medicine/neuroscience',
  'music', 'music/theory-production', 'music/classical',
  'nature', 'nature/animal-cognition', 'nature/ocean-science', 'nature/earth-science', 'nature/paleontology', 'nature/pets', 'nature/weather',
  'sports', 'sports/biomechanics', 'sports/endurance', 'sports/soccer', 'sports/football', 'sports/baseball', 'sports/basketball', 'sports/hockey', 'sports/cricket', 'sports/rugby', 'sports/tennis', 'sports/golf', 'sports/wrestling', 'sports/volleyball', 'sports/fantasy',
  'space', 'space/rockets',
  'computing', 'computing/history',
  'economics', 'economics/markets',
  'psychology', 'psychology/decision-making',
  'nature/earth-science',
  'automotive', 'automotive/racing',
  'philosophy', 'philosophy/ideas',
  'news', 'news/politics', 'news/daily', 'news/commentary', 'news/tech',
  'true-crime',
  'religion', 'religion/christianity', 'religion/buddhism', 'religion/judaism', 'religion/islam', 'religion/hinduism', 'religion/spirituality',
  'kids-family', 'kids-family/stories', 'kids-family/education', 'kids-family/parenting',
  'fiction', 'fiction/sci-fi', 'fiction/drama', 'fiction/comedy',
  'tv-film', 'tv-film/reviews', 'tv-film/interviews', 'tv-film/history', 'tv-film/after-shows', 'tv-film/animation',
  'health', 'health/mental', 'health/fitness', 'health/nutrition', 'health/alternative', 'health/sexuality',
  'education', 'education/language-learning', 'education/how-to', 'education/courses', 'education/self-improvement',
  'personal-journals',
  'relationships',
  'hobbies',
  'travel',
  'cities', 'cities/urbanism',
  'culture', 'culture/mythology', 'culture/art', 'culture/books', 'culture/design', 'culture/fashion', 'culture/performing-arts', 'culture/pop-culture',
  'adventure', 'adventure/exploration',
  'gaming', 'gaming/design',
  'paranormal',
  'society', 'society/law', 'society/government',
  'transport', 'transport/maritime', 'transport/trains'
]);

const results = {
  batch_id: batch.batch_id,
  results: {}
};

// I will manually classify based on descriptions and episodes
const classifications = [
  // 1. Radio Fitness Revolucionario - fitness + health-focused
  { id: 881260378, topics: [{ node: 'health/fitness', confidence: 0.95 }, { node: 'science', confidence: 0.65 }], needs_review: false, rationale: 'Fitness and health advice with scientific backing on nutrition, exercise, longevity markers.', display_title: 'Radio Fitness Revolucionario', blurb: 'Expert-led fitness podcast covering nutrition, training, longevity, and health optimization.' },

  // 2. Celtics Beat - basketball
  { id: 908834698, topics: [{ node: 'sports/basketball', confidence: 0.95 }], needs_review: false, rationale: 'Weekly Boston Celtics analysis and NBA coverage with expert guests.', display_title: 'Celtics Beat', blurb: 'In-depth daily analysis of the Boston Celtics and NBA news.' },

  // 3. القارئ محمد صديق المنشاوي - Quranic recitation
  { id: 974305006, topics: [{ node: 'religion/islam', confidence: 0.95 }], needs_review: false, rationale: 'Complete Quran recitation by respected Saudi Arabian Qari with melodious recitation style.', display_title: 'محمد صديق المنشاوي', blurb: 'Full Quran recitation with Tajweed rules by acclaimed Islamic scholar.' },

  // 4. Six O'Clock News - daily news
  { id: 977602870, topics: [{ node: 'news/daily', confidence: 0.95 }], needs_review: false, rationale: 'BBC daily news brief covering UK and international stories.', display_title: 'Six O\'Clock News', blurb: 'BBC Radio 4 daily news bulletin with national and international coverage.' },

  // 5. RuPaul's Drag Race Recap - TV/drag culture
  { id: 978207706, topics: [{ node: 'tv-film/after-shows', confidence: 0.90 }, { node: 'culture/pop-culture', confidence: 0.85 }], needs_review: false, rationale: 'Irreverent recap and critique of RuPaul\'s Drag Race episodes with rotating hosts.', display_title: 'RuPaul\'s Drag Race Recap', blurb: 'Smart, hilarious breakdown of Drag Race episodes with cultural commentary.' },

  // 6. Federalist Radio Hour - politics/news
  { id: 983782306, topics: [{ node: 'news/politics', confidence: 0.90 }], needs_review: false, rationale: 'Conservative-leaning political commentary and analysis with policy experts.', display_title: 'Federalist Radio Hour', blurb: 'In-depth political conversations with reporters and policy thinkers.' },

  // 7. The Mom Hour - parenting
  { id: 986178502, topics: [{ node: 'kids-family/parenting', confidence: 0.95 }], needs_review: false, rationale: 'Practical advice and encouragement for mothers navigating parenting challenges.', display_title: 'The Mom Hour', blurb: 'Real conversations about motherhood, parenthood, and family life.' },

  // 8. What Healthy Couples Know - relationships
  { id: 988410790, topics: [{ node: 'relationships', confidence: 0.90 }, { node: 'health/mental', confidence: 0.65 }], needs_review: false, rationale: 'Psychotherapist-hosted relationship advice covering trust, respect, conflict patterns.', display_title: 'What Healthy Couples Know', blurb: 'Relationship advice grounded in therapy and psychology from 35+ years experience.' },

  // 9. Berkeley Zen Center Dharma Talks - Buddhism
  { id: 992015074, topics: [{ node: 'religion/buddhism', confidence: 0.95 }], needs_review: false, rationale: 'Weekly Zen Buddhism talks and classes from Berkeley Zen Center and Shogakuji Temple.', display_title: 'Berkeley Zen Center Dharma Talks', blurb: 'Lectures on Zen Buddhism practice and philosophy from Berkeley Zen Center.' },

  // 10. All the Books! - books/reading
  { id: 993284374, topics: [{ node: 'culture/books', confidence: 0.95 }], needs_review: false, rationale: 'Weekly recommendations of new book releases for all genres and audiences.', display_title: 'All the Books!', blurb: 'Weekly recommendations of new book releases and reading suggestions.' },

  // 11. Snabbanan - sports (Swedish, multi-sport)
  { id: 994162888, topics: [{ node: 'sports/endurance', confidence: 0.85 }, { node: 'sports', confidence: 0.75 }], needs_review: false, rationale: 'Swedish sports podcast covering elite athletes in swimming, skiing, track and field.', display_title: 'Snabbanan', blurb: 'Swedish sports podcast with elite athlete interviews across Olympic sports.' },

  // 12. In This League Fantasy Football - fantasy sports
  { id: 994353832, topics: [{ node: 'sports/fantasy', confidence: 0.95 }], needs_review: false, rationale: 'Fantasy football analysis, mock drafts, and rankings for NFL season.', display_title: 'In This League Fantasy Football', blurb: 'Fantasy football strategy, rankings, and player analysis.' },

  // 13. Locked On Hornets - basketball
  { id: 995386468, topics: [{ node: 'sports/basketball', confidence: 0.95 }], needs_review: false, rationale: 'Daily Charlotte Hornets and NBA analysis with expert local coverage.', display_title: 'Locked On Hornets', blurb: 'Daily Hornets and NBA coverage with insider analysis and news.' },

  // 14. Robot or Not? - philosophy/language
  { id: 997930288, topics: [{ node: 'philosophy/ideas', confidence: 0.85 }, { node: 'computing', confidence: 0.60 }], needs_review: true, rationale: 'Semantic debate show on whether everyday objects and concepts qualify as robots; also touches on language/definitions.', display_title: 'Robot or Not?', blurb: 'Philosophical debate about the definition of robots and everyday objects.' },

  // 15. History Quest: History for Kids - kids/history
  { id: 1001995420, topics: [{ node: 'kids-family/education', confidence: 0.90 }, { node: 'history', confidence: 0.85 }], needs_review: false, rationale: 'Educational podcast series for kids about historical eras (WWII, Victorian era) through immersive storytelling.', display_title: 'History Quest', blurb: 'Educational history podcast for kids using immersive storytelling.' },

  // 16. Making Movies is HARD!!! - filmmaking
  { id: 1006416952, topics: [{ node: 'craft/filmmaking', confidence: 0.95 }, { node: 'tv-film', confidence: 0.75 }], needs_review: false, rationale: 'Indie filmmakers discuss production challenges, rejection, and creative process.', display_title: 'Making Movies is HARD!!!', blurb: 'Indie filmmakers discuss production challenges and creative struggles.' },

  // 17. Crazy Love Podcast - Christianity
  { id: 1007053996, topics: [{ node: 'religion/christianity', confidence: 0.95 }], needs_review: false, rationale: 'Christian teaching and ministry talks by Francis Chan, bestselling author.', display_title: 'Crazy Love Podcast', blurb: 'Christian teaching and ministry from author Francis Chan.' },

  // 18. Book Club for Kids - kids/books
  { id: 1016037208, topics: [{ node: 'kids-family/education', confidence: 0.90 }, { node: 'culture/books', confidence: 0.85 }], needs_review: false, rationale: 'Award-winning show where kids discuss new books with celebrity readers and author interviews.', display_title: 'Book Club for Kids', blurb: 'Young readers discuss new books with guest celebrities and authors.' },

  // 19. Rule Breaker Investing - investing
  { id: 1017325738, topics: [{ node: 'economics/markets', confidence: 0.90 }, { node: 'business', confidence: 0.70 }], needs_review: false, rationale: 'Stock market investing advice and analysis from Motley Fool founder David Gardner.', display_title: 'Rule Breaker Investing', blurb: 'Stock investing strategy and analysis from Motley Fool founder.' },

  // 20. Cop Doctors - comedy fiction
  { id: 1017583072, topics: [{ node: 'fiction/comedy', confidence: 0.90 }, { node: 'comedy', confidence: 0.75 }], needs_review: false, rationale: 'Comedic vignette series about two characters who are cops and doctors simultaneously.', display_title: 'Cop Doctors', blurb: 'Short comedic fiction about dual-career protagonists.' },

  // 21. PwC's accounting podcast - business/accounting
  { id: 1017833470, topics: [{ node: 'business', confidence: 0.80 }, { node: 'news', confidence: 0.65 }], needs_review: false, rationale: 'Accounting, financial reporting, and regulatory developments for business professionals.', display_title: 'PwC\'s Accounting Podcast', blurb: 'Professional accounting and financial reporting developments.' },

  // 22. Dragon Friends - comedy/D&D
  { id: 1018714948, topics: [{ node: 'comedy/casual-hangs', confidence: 0.85 }, { node: 'gaming/design', confidence: 0.70 }], needs_review: false, rationale: 'Australian comedians playing Dungeons and Dragons campaign with improvised humor.', display_title: 'Dragon Friends', blurb: 'Australian comedians playing D&D with improvised humor and storytelling.' },

  // 23. Abdullah Ali Jabir - Islam/Quran
  { id: 1020163774, topics: [{ node: 'religion/islam', confidence: 0.95 }], needs_review: false, rationale: 'Quran recitation by acclaimed Saudi Arabian Imam with refined Tajweed technique.', display_title: 'Abdullah Ali Jabir', blurb: 'Quran recitation by revered Islamic scholar with classical technique.' }
];

// Continue adding more classifications...
console.log('Read batch with', batch.shows.length, 'shows');
console.log('Adding classifications for', classifications.length, 'shows');

for (const c of classifications) {
  results.results[c.id] = {
    topics: c.topics,
    needs_review: c.needs_review,
    rationale: c.rationale,
    display_title: c.display_title,
    blurb: c.blurb,
    model: 'claude-code-cron (tier 1)'
  };
}

console.log('Classification template created with', Object.keys(results.results).length, 'entries');
console.log('Verify these need_review flags:', Object.values(results.results).filter(r => r.needs_review).length, 'total');
