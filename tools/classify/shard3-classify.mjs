#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const batchPath = path.join(__dirname, '../../data-local/classify-batch-fresh-2026-09-06-ca9f5dd7.json');
const batch = JSON.parse(fs.readFileSync(batchPath, 'utf8'));

const results = {
  batch_id: batch.batch_id,
  results: {}
};

const shows = {
  'The Wright Report': {
    topics: [{node: 'news/politics', confidence: 0.9}, {node: 'news/commentary', confidence: 0.7}],
    rationale: 'News and politics podcast hosted by former CIA officer covering current events.',
    displayTitle: 'The Wright Report',
    blurb: 'Daily news analysis with former CIA analyst covering current events and politics.'
  },
  'Rooted Agritourism': {
    topics: [{node: 'business/startups', confidence: 0.8}, {node: 'craft/diy-home', confidence: 0.6}],
    rationale: 'Farm business entrepreneur guide for agritourism and value-added agriculture.',
    displayTitle: 'Rooted Agritourism',
    blurb: 'Rural entrepreneurs building sustainable, story-driven farm businesses and agritourism.'
  },
  'The Not Ready for Prime Time Project: An SNL Retrospective': {
    topics: [{node: 'tv-film/reviews', confidence: 0.85}, {node: 'comedy', confidence: 0.7}],
    rationale: 'Deep retrospective analysis of Saturday Night Live history and episodes.',
    displayTitle: 'The Not Ready for Prime Time Project',
    blurb: 'Episode-by-episode retrospective analysis and deep dive into Saturday Night Live history.'
  },
  'Girls Rewatch: Sex and the City': {
    topics: [{node: 'tv-film/reviews', confidence: 0.85}, {node: 'culture/pop-culture', confidence: 0.7}],
    rationale: 'Episode-by-episode rewatch and discussion of the TV series Sex and the City.',
    displayTitle: 'Girls Rewatch: Sex and the City',
    blurb: 'Rewatch and discussion series covering episodes of Sex and the City TV show.'
  },
  'Aviation News Recap': {
    topics: [{node: 'aviation', confidence: 0.85}, {node: 'news/daily', confidence: 0.5}],
    rationale: 'Daily recap and news coverage related to aviation industry and events.',
    displayTitle: 'Aviation News Recap',
    blurb: 'Daily recap of aviation industry news, accidents, and aerospace developments.'
  },
  'PharmaSource Podcast': {
    topics: [{node: 'medicine', confidence: 0.8}, {node: 'business', confidence: 0.5}],
    rationale: 'Pharmaceutical industry news and business coverage.',
    displayTitle: 'PharmaSource Podcast',
    blurb: 'Pharmaceutical industry news, drug development, and healthcare business coverage.'
  },
  'The Fueled & Free Podcast': {
    topics: [{node: 'health/fitness', confidence: 0.75}],
    rationale: 'Health and fitness focused podcast covering wellness and nutrition.',
    displayTitle: 'The Fueled & Free Podcast',
    blurb: 'Health, fitness, and wellness podcast covering nutrition and lifestyle topics.'
  },
  'Leveraging AI': {
    topics: [{node: 'engineering/ai-robotics', confidence: 0.8}, {node: 'business', confidence: 0.6}],
    rationale: 'Covers applications of AI technology and business implications.',
    displayTitle: 'Leveraging AI',
    blurb: 'Artificial intelligence applications, business strategy, and technology innovation.'
  },
  'Film Generations': {
    topics: [{node: 'tv-film/history', confidence: 0.85}, {node: 'culture', confidence: 0.6}],
    rationale: 'Explores film history and generational approaches to cinema.',
    displayTitle: 'Film Generations',
    blurb: 'Film history and cinema across different generations and eras.'
  },
  'The Podcast of Jewish Ideas': {
    topics: [{node: 'religion/judaism', confidence: 0.85}, {node: 'philosophy/ideas', confidence: 0.6}],
    rationale: 'Explores Jewish theology, philosophy, and intellectual traditions.',
    displayTitle: 'The Podcast of Jewish Ideas',
    blurb: 'Jewish philosophy, theology, and intellectual traditions and ideas.'
  },
  'Networth and Chill with Your Rich BFF': {
    topics: [{node: 'economics/markets', confidence: 0.75}, {node: 'business', confidence: 0.6}],
    rationale: 'Financial advice and wealth-building discussions in casual format.',
    displayTitle: 'Networth and Chill with Your Rich BFF',
    blurb: 'Financial advice, wealth-building, and investment strategies in casual format.'
  },
  'The Tedcast - A Deep Dive Podcast About The Bear': {
    topics: [{node: 'tv-film/reviews', confidence: 0.85}],
    rationale: 'Episode-by-episode breakdown and analysis of the TV series The Bear.',
    displayTitle: 'The Tedcast - The Bear Deep Dive',
    blurb: 'Detailed episode analysis and discussion of the TV series The Bear.'
  },
  'Complete Performance Audio Experience': {
    topics: [{node: 'music/theory-production', confidence: 0.5}],
    rationale: 'Audio-focused content on performance and sound production.',
    displayTitle: 'Complete Performance Audio Experience',
    blurb: 'Audio production, performance recording, and sound engineering.'
  },
  'Canal Street Dreams': {
    topics: [{node: 'culture/pop-culture', confidence: 0.5}],
    rationale: 'Cultural or location-based content; specific focus requires review.',
    displayTitle: 'Canal Street Dreams',
    blurb: 'Cultural podcast with New Orleans/location themes.',
    needsReview: true
  },
  'To the White Sea': {
    topics: [{node: 'adventure/exploration', confidence: 0.5}],
    rationale: 'Geographic or travel-themed content with adventure elements.',
    displayTitle: 'To the White Sea',
    blurb: 'Adventure or travel narrative podcast.',
    needsReview: true
  },
  'Performance Neurology with Josh Turknett, MD': {
    topics: [{node: 'medicine/neuroscience', confidence: 0.8}, {node: 'health/fitness', confidence: 0.5}],
    rationale: 'Medical podcast on neurology and brain-based performance optimization.',
    displayTitle: 'Performance Neurology',
    blurb: 'Neurology and brain science for optimal performance and health.'
  },
  'Galactic Horrors': {
    topics: [{node: 'fiction/sci-fi', confidence: 0.75}, {node: 'fiction', confidence: 0.6}],
    rationale: 'Science fiction horror audio drama or story series.',
    displayTitle: 'Galactic Horrors',
    blurb: 'Science fiction horror stories and audio drama series.'
  },
  'Little Curiosities With Kendall Long': {
    topics: [{node: 'education', confidence: 0.65}],
    rationale: 'General curiosities show with educational elements.',
    displayTitle: 'Little Curiosities With Kendall Long',
    blurb: 'Curiosity-driven educational stories and interesting topics.'
  },
  'Jason On Firms Podcast': {
    topics: [{node: 'society/law', confidence: 0.75}, {node: 'business', confidence: 0.5}],
    rationale: 'Law firm business and legal practice management podcast.',
    displayTitle: 'Jason On Firms',
    blurb: 'Law firm operations and business management for legal professionals.'
  },
  'Librivox Audiobooks': {
    topics: [{node: 'culture/books', confidence: 0.85}],
    rationale: 'Public domain audiobook recordings and serialized literature.',
    displayTitle: 'Librivox Audiobooks',
    blurb: 'Public domain audiobooks and classic literature recordings.'
  },
  'Spritz & Scrums - Italian Rugby Podcast': {
    topics: [{node: 'sports/rugby', confidence: 0.85}],
    rationale: 'Italian rugby news, analysis, and match coverage.',
    displayTitle: 'Spritz & Scrums',
    blurb: 'Italian rugby news, analysis, and competitive match coverage.'
  },
  'Boats & Bros Podcast': {
    topics: [{node: 'transport/maritime', confidence: 0.6}, {node: 'hobbies', confidence: 0.5}],
    rationale: 'Maritime-themed casual discussion podcast.',
    displayTitle: 'Boats & Bros Podcast',
    blurb: 'Casual discussion about boats and maritime topics.',
    needsReview: true
  },
  'Enjoy Your Piping! With Gary West': {
    topics: [{node: 'music/theory-production', confidence: 0.75}, {node: 'craft', confidence: 0.6}],
    rationale: 'Bagpipe instruction, technique, and music performance.',
    displayTitle: 'Enjoy Your Piping!',
    blurb: 'Bagpipe playing instruction and technique guidance.'
  },
  'The Inflammation Code': {
    topics: [{node: 'health/fitness', confidence: 0.75}, {node: 'medicine', confidence: 0.6}],
    rationale: 'Health podcast on inflammation, diet, and wellness science.',
    displayTitle: 'The Inflammation Code',
    blurb: 'Health science covering inflammation, nutrition, and wellness strategies.'
  },
  'Bone to Pick Podcast': {
    topics: [{node: 'comedy/casual-hangs', confidence: 0.7}],
    rationale: 'Casual discussion podcast with conversational format.',
    displayTitle: 'Bone to Pick Podcast',
    blurb: 'Casual discussion and conversation format podcast.'
  },
  'Tom Talks Junior Cricket Coaching Podcast': {
    topics: [{node: 'sports/cricket', confidence: 0.8}, {node: 'education', confidence: 0.5}],
    rationale: 'Cricket coaching guidance focused on youth players.',
    displayTitle: 'Tom Talks Junior Cricket Coaching',
    blurb: 'Cricket coaching techniques and youth development strategies.'
  },
  'Evidence-Based Pilates Podcast': {
    topics: [{node: 'health/fitness', confidence: 0.85}],
    rationale: 'Pilates instruction and fitness science evidence-based approach.',
    displayTitle: 'Evidence-Based Pilates Podcast',
    blurb: 'Pilates instruction grounded in fitness science and research.'
  },
  'The Women\'s Hoops Show': {
    topics: [{node: 'sports/basketball', confidence: 0.85}],
    rationale: 'Women\s basketball news, analysis, and game coverage.',
    displayTitle: 'The Women\'s Hoops Show',
    blurb: 'Women\'s basketball news, analysis, and game commentary.'
  },
  'The Dr. Joey Munoz Show': {
    topics: [{node: 'psychology', confidence: 0.7}, {node: 'health/mental', confidence: 0.6}],
    rationale: 'Psychology and personal development discussions.',
    displayTitle: 'The Dr. Joey Munoz Show',
    blurb: 'Psychology, personal development, and mental health topics.'
  },
  'The Boundary Line | Hello Vikatan': {
    topics: [{node: 'culture', confidence: 0.5}],
    rationale: 'Tamil language content; specific topic requires review.',
    displayTitle: 'The Boundary Line | Hello Vikatan',
    blurb: 'Tamil language cultural podcast.',
    needsReview: true
  },
  'NO DRAWS PODCAST': {
    topics: [],
    rationale: 'Title unclear; content and format unknown.',
    displayTitle: 'NO DRAWS PODCAST',
    blurb: 'Content classification uncertain from available information.',
    needsReview: true
  },
  'Awakening Process 101': {
    topics: [{node: 'religion/spirituality', confidence: 0.7}, {node: 'psychology', confidence: 0.5}],
    rationale: 'Spiritual awakening and personal transformation podcast.',
    displayTitle: 'Awakening Process 101',
    blurb: 'Spiritual awakening and personal transformation guidance.'
  },
  'The Barbell Mamas Podcast | Pregnancy, Postpartum, Pelvic Health': {
    topics: [{node: 'health/fitness', confidence: 0.75}, {node: 'health/sexuality', confidence: 0.6}],
    rationale: 'Fitness and health podcast for pregnant and postpartum women.',
    displayTitle: 'The Barbell Mamas Podcast',
    blurb: 'Fitness, pregnancy, postpartum health and pelvic floor guidance for women.'
  },
  'Dice Exploder': {
    topics: [{node: 'gaming/design', confidence: 0.75}, {node: 'craft', confidence: 0.6}],
    rationale: 'Tabletop gaming design philosophy and dice game mechanics.',
    displayTitle: 'Dice Exploder',
    blurb: 'Tabletop game design philosophy and mechanics analysis.'
  },
  'Rewilding the World with Ben Goldsmith': {
    topics: [{node: 'nature', confidence: 0.8}, {node: 'adventure/exploration', confidence: 0.6}],
    rationale: 'Environmental conservation and wildlife rewilding projects.',
    displayTitle: 'Rewilding the World',
    blurb: 'Environmental conservation and wildlife rewilding project stories.'
  },
  'Fingal\'s Cave - A Podcast for all dedicated Pink Floyd Fans': {
    topics: [{node: 'culture/pop-culture', confidence: 0.75}, {node: 'music', confidence: 0.6}],
    rationale: 'Deep-dive discussion of Pink Floyd music, albums, and history.',
    displayTitle: 'Fingal\'s Cave - Pink Floyd Fans',
    blurb: 'Deep-dive Pink Floyd music history and album analysis.'
  },
  'Pure Binaural Beats: Theta Frequency for Hemi-Sync, focus, study and meditation. By: Nature\'s Frequency FM | Binaural ASMR': {
    topics: [{node: 'health/mental', confidence: 0.6}],
    rationale: 'Audio-based meditation and focus tool; minimal narrative content.',
    displayTitle: 'Pure Binaural Beats',
    blurb: 'Binaural beats audio for meditation, focus, and study.',
    needsReview: true
  },
  'The Core 7 Podcast: Fun TV Discussions coming every week!': {
    topics: [{node: 'tv-film/reviews', confidence: 0.8}, {node: 'culture/pop-culture', confidence: 0.6}],
    rationale: 'Weekly casual discussion and reviews of TV shows.',
    displayTitle: 'The Core 7 Podcast',
    blurb: 'Weekly casual TV show discussion and pop culture commentary.'
  },
  'DERELICT': {
    topics: [{node: 'adventure/exploration', confidence: 0.4}],
    rationale: 'Title unclear; specific content focus requires review.',
    displayTitle: 'DERELICT',
    blurb: 'Content classification needs review.',
    needsReview: true
  },
  'Punching Up: A Nintendo Podcast': {
    topics: [{node: 'gaming/design', confidence: 0.8}, {node: 'culture/pop-culture', confidence: 0.6}],
    rationale: 'Nintendo video game discussion, analysis, and news.',
    displayTitle: 'Punching Up',
    blurb: 'Nintendo video game discussion, news, and analysis.'
  },
  'Elevated Frequencies': {
    topics: [{node: 'music', confidence: 0.55}, {node: 'health/mental', confidence: 0.5}],
    rationale: 'Music or frequency-based wellness content.',
    displayTitle: 'Elevated Frequencies',
    blurb: 'Music or frequency-based wellness and audio content.',
    needsReview: true
  },
  '1on1 with Papi Chulo [Episodes 101-150]': {
    topics: [{node: 'comedy/casual-hangs', confidence: 0.6}],
    rationale: 'Interview and conversation format podcast.',
    displayTitle: '1on1 with Papi Chulo',
    blurb: 'One-on-one interviews and conversations.'
  },
  'The Case Against Kouri Richins': {
    topics: [{node: 'true-crime', confidence: 0.85}],
    rationale: 'True crime podcast covering criminal case.',
    displayTitle: 'The Case Against Kouri Richins',
    blurb: 'True crime deep-dive investigation of criminal case.'
  },
  'Functional Medicine Institute': {
    topics: [{node: 'medicine', confidence: 0.8}, {node: 'health', confidence: 0.7}],
    rationale: 'Functional medicine research, practice, and health science.',
    displayTitle: 'Functional Medicine Institute',
    blurb: 'Functional medicine research, practice, and patient health strategies.'
  },
  'The Oberman Law Firm Podcast': {
    topics: [{node: 'society/law', confidence: 0.8}, {node: 'business', confidence: 0.4}],
    rationale: 'Legal advice and law firm business content.',
    displayTitle: 'The Oberman Law Firm Podcast',
    blurb: 'Legal advice and law firm business guidance.'
  },
  'Classic & Curious': {
    topics: [{node: 'culture', confidence: 0.5}, {node: 'history', confidence: 0.5}],
    rationale: 'General classical and curious interest topics.',
    displayTitle: 'Classic & Curious',
    blurb: 'Classical and curious topics.',
    needsReview: true
  },
  'Pals in Palaeo': {
    topics: [{node: 'nature/paleontology', confidence: 0.85}],
    rationale: 'Paleontology and fossil science discussion.',
    displayTitle: 'Pals in Palaeo',
    blurb: 'Paleontology and fossil science podcast.'
  },
  'מתחת לכל ביקורת': {
    topics: [{node: 'culture', confidence: 0.4}],
    rationale: 'Hebrew language podcast; specific content classification requires review.',
    displayTitle: 'מתחת לכל ביקורת',
    blurb: 'Hebrew language podcast.',
    needsReview: true
  },
  'Under the Surface Podcast': {
    topics: [{node: 'culture/pop-culture', confidence: 0.5}],
    rationale: 'Title suggests depth exploration; specific topic requires review.',
    displayTitle: 'Under the Surface Podcast',
    blurb: 'In-depth exploration of cultural topics.',
    needsReview: true
  }
};

batch.shows.forEach(show => {
  const id = show.apple_collection_id;
  const title = show.title;
  const classData = shows[title] || {
    topics: [],
    rationale: 'Classification pending review.',
    displayTitle: title,
    blurb: 'Classification pending.',
    needsReview: true
  };

  const needsReview = classData.needsReview ||
                      classData.topics.length === 0 ||
                      (classData.topics[0] && classData.topics[0].confidence < 0.6);

  results.results[id] = {
    topics: classData.topics,
    needs_review: needsReview,
    rationale: classData.rationale,
    display_title: classData.displayTitle,
    blurb: classData.blurb,
    model: 'claude-code-cron (tier 1)'
  };
});

fs.writeFileSync('data-local/classify-results-fresh-2026-09-06-ca9f5dd7.json', JSON.stringify(results, null, 2));
console.log('Results file created with', Object.keys(results.results).length, 'shows');
