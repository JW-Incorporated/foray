#!/usr/bin/env node
import fs from 'fs';

const batchFile = '/home/user/foray/data-local/classify-batch-fresh-2026-07-28-67d30fee.json';
const batch = JSON.parse(fs.readFileSync(batchFile, 'utf-8'));
const batchId = batch.batch_id;

const results = {
  batch_id: batchId,
  results: {}
};

// Classification judgments for each show
const classifications = [
  {
    id: 137002798,
    topics: [{ node: 'business/management', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Practical accounting and management guidance for CFOs and controllers.',
    display_title: 'Accounting Best Practices',
    blurb: 'Weekly discussion of accounting principles, management practices, and GAAP for financial professionals.'
  },
  {
    id: 142891498,
    topics: [{ node: 'culture/art', confidence: 0.8 }, { node: 'music', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Weekly artist and musician interviews from Aquarium Drunkard.',
    display_title: 'Transmissions',
    blurb: 'Interviews with musicians, artists, and filmmakers exploring their work and creative process.'
  },
  {
    id: 156274672,
    topics: [{ node: 'gaming', confidence: 0.95 }, { node: 'gaming/design', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Weekly Nintendo news and classic game discussion from enthusiast community.',
    display_title: 'Radio Free Nintendo',
    blurb: 'Nintendo World Report staff discuss the latest releases and classic games weekly.'
  },
  {
    id: 164829166,
    topics: [{ node: 'linguistics/language', confidence: 0.9 }, { node: 'education', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Daily etymology and usage lessons from Merriam-Webster lexicographers.',
    display_title: 'Word of the Day',
    blurb: 'Daily word definitions, etymology, and usage from Merriam-Webster experts.'
  },
  {
    id: 182469910,
    topics: [{ node: 'fiction/drama', confidence: 0.85 }, { node: 'true-crime', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Archived thrillers featuring mystery, espionage, and psychological drama.',
    display_title: 'Thrillers Old Time Radio',
    blurb: 'Classic Old Time Radio mystery and espionage dramas with psychological twist.'
  },
  {
    id: 185237578,
    topics: [{ node: 'aviation', confidence: 0.95 }],
    needs_review: false,
    rationale: 'General aviation news and enthusiast conversation.',
    display_title: 'Uncontrolled Airspace',
    blurb: 'News and conversation about general aviation flying and pilot community.'
  },
  {
    id: 203424910,
    topics: [{ node: 'fiction/drama', confidence: 0.85 }],
    needs_review: false,
    rationale: 'Audio fiction vampire saga with gothic themes and family intrigue.',
    display_title: 'Underwood and Flinch',
    blurb: 'Gothic fiction series about vampire guardianship and family obligation.'
  },
  {
    id: 212039902,
    topics: [{ node: 'comedy/interviews', confidence: 0.75 }, { node: 'tv-film', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Horror genre commentary and interviews with independent horror creators.',
    display_title: 'Without Your Head',
    blurb: 'Live Thursday night horror podcast with interviews and genre discussion.'
  },
  {
    id: 215510110,
    topics: [{ node: 'hobbies', confidence: 0.85 }, { node: 'nature', confidence: 0.65 }],
    needs_review: false,
    rationale: 'Weekly gardening and plant care advice for home owners.',
    display_title: 'KSL Greenhouse',
    blurb: 'Saturday gardening show with expert tips and listener gardening questions.'
  },
  {
    id: 218143996,
    topics: [{ node: 'sports', confidence: 0.9 }],
    needs_review: false,
    rationale: 'Daily sports talk with former NFL veteran.',
    display_title: 'Carmen and Jurko',
    blurb: 'Daily sports talk roundtable hosted by ten-year NFL veteran John Jurkovic.'
  },
  {
    id: 253212700,
    topics: [{ node: 'craft', confidence: 0.9 }, { node: 'craft/diy-home', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Knitting community podcast with personal stories and shared experiences.',
    display_title: 'Knit Picks Podcast',
    blurb: 'Knitting community shares triumphs and challenges from fiber arts hobby.'
  },
  {
    id: 262361074,
    topics: [{ node: 'music', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Reggae and dancehall music podcast with classic and contemporary selections.',
    display_title: 'Sounds of the Caribbean',
    blurb: 'Roots reggae, conscious dancehall, lovers rock, and classic Caribbean music.'
  },
  {
    id: 263456080,
    topics: [{ node: 'math', confidence: 0.9 }, { node: 'education', confidence: 0.75 }],
    needs_review: false,
    rationale: 'Mathematical research and discovery made accessible for general audience.',
    display_title: 'Maths on the Move',
    blurb: 'Interviews with math researchers explaining current discoveries in mathematical science.'
  },
  {
    id: 268003768,
    topics: [{ node: 'health', confidence: 0.85 }, { node: 'health/alternative', confidence: 0.65 }],
    needs_review: false,
    rationale: 'Medical and alternative health information for informed health decisions.',
    display_title: 'The People\'s Pharmacy',
    blurb: 'Evidence-based information on medical and alternative treatment options.'
  },
  {
    id: 268557178,
    topics: [{ node: 'business/management', confidence: 0.85 }, { node: 'business/careers', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Leadership and workplace communication coaching for professional development.',
    display_title: 'Modern Mentor',
    blurb: 'Leadership guidance on communication, work-life balance, and professional growth.'
  },
  {
    id: 270054094,
    topics: [{ node: 'culture/books', confidence: 0.9 }, { node: 'culture/art', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Daily audio recordings of classic and contemporary poetry.',
    display_title: 'Audio Poem of the Day',
    blurb: 'Classic and contemporary poems read by actors and poets daily.'
  },
  {
    id: 271206562,
    topics: [{ node: 'religion/christianity', confidence: 0.9 }, { node: 'education', confidence: 0.65 }],
    needs_review: false,
    rationale: 'Biblical teaching and Christian life guidance from evangelical preacher.',
    display_title: 'Living on the Edge',
    blurb: 'Biblical guidance on faith, marriage, parenting, and Christian living.'
  },
  {
    id: 273537688,
    topics: [{ node: 'religion/christianity', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Catholic homilies based on weekly Scripture readings.',
    display_title: 'Sunday Homilies',
    blurb: 'Catholic priest delivers weekly homilies based on Sunday Mass readings.'
  },
  {
    id: 276157864,
    topics: [{ node: 'craft/filmmaking', confidence: 0.9 }, { node: 'tv-film', confidence: 0.8 }],
    needs_review: false,
    rationale: 'Interviews with professional editors in film, TV, and documentary.',
    display_title: 'Art of the Cut',
    blurb: 'Conversations with film, TV, and documentary editors about their craft.'
  },
  {
    id: 280383574,
    topics: [{ node: 'business/management', confidence: 0.85 }, { node: 'business/careers', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Executive coaching tips for workplace perception and leadership.',
    display_title: 'Look & Sound of Leadership',
    blurb: 'Executive coaching guidance for professional presentation and perception.'
  },
  {
    id: 286362280,
    topics: [{ node: 'religion/buddhism', confidence: 0.85 }, { node: 'health/mental', confidence: 0.75 }],
    needs_review: false,
    rationale: 'Buddhist philosophy applied to recovery and mental health healing.',
    display_title: '12-Step Buddhist Podcast',
    blurb: 'Buddhist methods and teachings integrated with recovery and trauma healing.'
  },
  {
    id: 293597632,
    topics: [{ node: 'tv-film', confidence: 0.95 }, { node: 'culture/pop-culture', confidence: 0.8 }],
    needs_review: false,
    rationale: 'Fan podcast analyzing The Andy Griffith Show and Mayberry nostalgia.',
    display_title: 'Two Chairs No Waiting',
    blurb: 'Andy Griffith Show fan podcast with interviews and Mayberry community.'
  },
  {
    id: 296092576,
    topics: [{ node: 'culture/books', confidence: 0.75 }, { node: 'culture/pop-culture', confidence: 0.8 }],
    needs_review: false,
    rationale: 'Comics industry news and comic book reviews from critics.',
    display_title: 'House to Astonish',
    blurb: 'Comics news and reviews from industry critics and comic culture.'
  },
  {
    id: 297409792,
    topics: [{ node: 'fiction/sci-fi', confidence: 0.85 }, { node: 'fiction/drama', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Audio fiction trilogy blending science fiction and horror.',
    display_title: 'The Infected Trilogy',
    blurb: 'Science fiction horror audio drama from New York Times bestselling author.'
  },
  {
    id: 305590390,
    topics: [{ node: 'education/language-learning', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Spanish language learning with news content for intermediate students.',
    display_title: 'News in Slow Spanish',
    blurb: 'Spanish learning course with real news and grammar for intermediate level.'
  },
  {
    id: 309303712,
    topics: [{ node: 'health', confidence: 0.8 }, { node: 'education/courses', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Pharmacy industry network with interviews and professional development.',
    display_title: 'Pharmacy Podcast Network',
    blurb: 'Network of podcasts for pharmacy professionals covering industry topics.'
  },
  {
    id: 310512556,
    topics: [{ node: 'hobbies', confidence: 0.6 }, { node: 'culture/fashion', confidence: 0.5 }],
    needs_review: true,
    rationale: 'Podcast based on men\'s underwear blog community.',
    display_title: 'Brief Talk Podcast',
    blurb: 'Men\'s underwear blog podcast community.'
  },
  {
    id: 314020330,
    topics: [{ node: 'health', confidence: 0.85 }, { node: 'health/mental', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Emergency medicine education for critical care in ED settings.',
    display_title: 'EMCrit FOAM Feed',
    blurb: 'Emergency department critical care medical education and practice discussion.'
  },
  {
    id: 319637902,
    topics: [{ node: 'religion/hinduism', confidence: 0.9 }, { node: 'philosophy', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Hindu spiritual teachings from the Bhagavad Gita with philosophy.',
    display_title: 'Bhagavad Gita Discourses',
    blurb: 'Teachings from the Bhagavad Gita exploring Hindu spirituality and philosophy.'
  },
  {
    id: 327055102,
    topics: [{ node: 'sports/soccer', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Manchester City football club fan podcast with weekly recaps.',
    display_title: 'Blue Moon Podcast',
    blurb: 'Manchester City weekly news, match recaps, and exclusive interviews.'
  },
  {
    id: 336682714,
    topics: [{ node: 'hobbies', confidence: 0.85 }, { node: 'nature/pets', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Aquarium keeping hobby guide for freshwater and saltwater tanks.',
    display_title: 'Aquariumania',
    blurb: 'Tropical aquarium hobby guide with fish care and tank setup tips.'
  },
  {
    id: 336829720,
    topics: [{ node: 'religion/buddhism', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Buddhist teachings and dharma talks from Amaravati temple.',
    display_title: 'Amaravati Podcast',
    blurb: 'Buddhist dharma talks from Amaravati temple community.'
  },
  {
    id: 341410942,
    topics: [{ node: 'religion/judaism', confidence: 0.95 }, { node: 'education', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Weekly Torah portion study with verse-by-verse Jewish education.',
    display_title: 'Shnayim Mikra',
    blurb: 'Weekly Torah portion review with expert Jewish educational commentary.'
  },
  {
    id: 341813080,
    topics: [{ node: 'economics/markets', confidence: 0.9 }, { node: 'business', confidence: 0.8 }],
    needs_review: false,
    rationale: 'Financial insider commentary on market movement and investment analysis.',
    display_title: 'Wall Street Unplugged',
    blurb: 'Market analysis and investment ideas from thirty-year Wall Street veteran.'
  },
  {
    id: 343172752,
    topics: [{ node: 'business', confidence: 0.75 }, { node: 'comedy/interviews', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Long-running daily interview show with CEOs, authors, and thought leaders.',
    display_title: 'The Chris Voss Show',
    blurb: 'Daily interviews with CEOs, authors, and newsmakers for nearly two decades.'
  },
  {
    id: 347874892,
    topics: [{ node: 'economics/markets', confidence: 0.9 }],
    needs_review: false,
    rationale: 'Daily stock market analysis and investment recommendations.',
    display_title: 'Best Stocks Now',
    blurb: 'Daily market and stock analysis with investment recommendations.'
  },
  {
    id: 348852826,
    topics: [{ node: 'space', confidence: 0.95 }, { node: 'science', confidence: 0.8 }],
    needs_review: false,
    rationale: 'Astronomy and space science from Naked Scientists network.',
    display_title: 'Naked Astronomy',
    blurb: 'Space science and astronomy from the Naked Scientists network.'
  },
  {
    id: 365878132,
    topics: [{ node: 'religion/islam', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Quranic recitation from renowned Islamic scholar.',
    display_title: 'الشيخ أحمد العجمي',
    blurb: 'Quranic recitation from Islamic scholar Ahmed Al-Ajmi.'
  },
  {
    id: 369757090,
    topics: [{ node: 'fiction', confidence: 0.85 }, { node: 'culture/books', confidence: 0.8 }],
    needs_review: false,
    rationale: 'Literary podcast analyzing H.P. Lovecraft with voice actors and music.',
    display_title: 'H.P. Lovecraft Literary Podcast',
    blurb: 'Lovecraft stories read by voice actors with atmospheric sound and expert analysis.'
  },
  {
    id: 372985372,
    topics: [{ node: 'travel', confidence: 0.9 }, { node: 'culture/pop-culture', confidence: 0.65 }],
    needs_review: false,
    rationale: 'Bangkok expat community conversation about city life and culture.',
    display_title: 'The Bangkok Podcast',
    blurb: 'Bangkok residents explore city life, food, and cultural curiosities weekly.'
  },
  {
    id: 375385132,
    topics: [{ node: 'news/tech', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Weekly technology industry news and trends from expert journalists.',
    display_title: 'Tech News Weekly',
    blurb: 'Weekly technology news and in-depth analysis from tech journalists.'
  },
  {
    id: 382998388,
    topics: [{ node: 'tv-film', confidence: 0.95 }, { node: 'culture/pop-culture', confidence: 0.8 }],
    needs_review: false,
    rationale: 'Fan podcast analyzing The Walking Dead and spinoff series.',
    display_title: 'Walking Dead \'Cast',
    blurb: 'Character-driven analysis of The Walking Dead and spinoff shows.'
  },
  {
    id: 385017460,
    topics: [{ node: 'sports', confidence: 0.85 }, { node: 'comedy/interviews', confidence: 0.65 }],
    needs_review: false,
    rationale: 'Professional wrestler interviews about wrestling career and lifestyle.',
    display_title: 'Art of Wrestling',
    blurb: 'Pro wrestler interviews covering industry struggles and achievements.'
  },
  {
    id: 386170702,
    topics: [{ node: 'health', confidence: 0.9 }, { node: 'education/courses', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Medical research summaries from New England Journal of Medicine.',
    display_title: 'NEJM This Week',
    blurb: 'Weekly summaries of medical research published in leading journal.'
  },
  {
    id: 395503030,
    topics: [{ node: 'travel', confidence: 0.85 }, { node: 'hobbies', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Theme park and cruise travel planning with family focus.',
    display_title: 'MouseChat Podcast',
    blurb: 'Disney, Universal, cruise, and family travel planning podcast.'
  },
  {
    id: 402306412,
    topics: [{ node: 'news/commentary', confidence: 0.9 }, { node: 'news/politics', confidence: 0.85 }],
    needs_review: false,
    rationale: 'Daily political commentary and long-form interviews.',
    display_title: 'Majority Report',
    blurb: 'Daily political analysis and long-form interviews from independent perspective.'
  },
  {
    id: 409349218,
    topics: [{ node: 'religion/islam', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Complete Quran recitation from Islamic scholar.',
    display_title: 'سعد الغامدي',
    blurb: 'Full Quranic recitation from prominent Islamic scholar Saad Al-Ghamdi.'
  },
  {
    id: 415068220,
    topics: [{ node: 'hobbies', confidence: 0.85 }, { node: 'automotive', confidence: 0.8 }],
    needs_review: false,
    rationale: 'Jeep enthusiast podcast with restoration, off-roading, and lifestyle.',
    display_title: 'Jeep Talk Show',
    blurb: 'Jeep ownership, off-roading, and restoration from passionate community.'
  },
  {
    id: 417396316,
    topics: [{ node: 'hobbies', confidence: 0.85 }, { node: 'automotive/racing', confidence: 0.8 }],
    needs_review: false,
    rationale: 'Vintage motorcycle restoration, riding, and culture.',
    display_title: 'Cleveland Moto',
    blurb: 'Vintage motorcycle culture, wrenching, and riding community.'
  },
  {
    id: 425659636,
    topics: [{ node: 'religion/christianity', confidence: 0.9 }, { node: 'health/mental', confidence: 0.6 }],
    needs_review: false,
    rationale: 'Christian television ministry on daily living and faith.',
    display_title: 'Joyce Meyer Daily',
    blurb: 'Daily Christian ministry on faith and everyday living.'
  },
  {
    id: 429307630,
    topics: [{ node: 'news/tech', confidence: 0.9 }, { node: 'computing', confidence: 0.8 }],
    needs_review: false,
    rationale: 'Android device news, apps, and technology from long-running show.',
    display_title: 'All About Android',
    blurb: 'Android news, apps, and technology from enthusiast team.'
  },
  {
    id: 430247008,
    topics: [{ node: 'religion/spirituality', confidence: 0.8 }, { node: 'culture', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Indian spiritual teachings and cultural wisdom.',
    display_title: 'Baba Gonesh Podcast',
    blurb: 'Indian spiritual teachings and cultural wisdom from guru perspective.'
  },
  {
    id: 430621876,
    topics: [{ node: 'sports/baseball', confidence: 0.95 }],
    needs_review: false,
    rationale: 'Toronto Blue Jays baseball game recaps and fan discussion.',
    display_title: 'Blue Jays Talk',
    blurb: 'Toronto Blue Jays game recaps, calls, and fan interaction daily.'
  },
  {
    id: 431258512,
    topics: [{ node: 'travel', confidence: 0.85 }, { node: 'hobbies', confidence: 0.7 }],
    needs_review: false,
    rationale: 'Universal Orlando resort news, reviews, and interviews.',
    display_title: 'Unofficial Universal Podcast',
    blurb: 'Universal Orlando resort news, reviews, and exclusive interviews.'
  }
];

// Map classifications to results using apple_collection_id
for (const cls of classifications) {
  results.results[cls.id] = {
    topics: cls.topics,
    needs_review: cls.needs_review,
    rationale: cls.rationale,
    display_title: cls.display_title,
    blurb: cls.blurb,
    model: 'claude-code-cron (tier 1)'
  };
}

const outputPath = `/home/user/foray/data-local/classify-results-${batchId}.json`;
fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
console.log(`CLASSIFY_RESULTS_WRITTEN: ${outputPath}`);
