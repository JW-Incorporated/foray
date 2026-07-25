import fs from 'fs';
import path from 'path';

const BATCH_FILE = 'data-local/classify-batch-fresh-2026-07-25-b7dd4c1c.json';
const RESULTS_FILE = 'data-local/classify-results-fresh-2026-07-25-b7dd4c1c.json';

const batch = JSON.parse(fs.readFileSync(BATCH_FILE, 'utf-8'));

const results = {
  batch_id: batch.batch_id,
  results: {}
};

// Classification mappings based on show content
const classifications = {
  1201927184: { // History of the 90s
    topics: [
      { node: "history", confidence: 0.95 },
      { node: "culture/pop-culture", confidence: 0.7 }
    ],
    needs_review: false,
    rationale: "Decade retrospective covering events, culture, and entertainment from 1990s America.",
    display_title: "History of the 90s",
    blurb: "Weekly journey through defining stories, events, and cultural moments of the 1990s."
  },
  1204523870: { // Ali on the Run Show
    topics: [
      { node: "sports/endurance", confidence: 0.95 },
      { node: "health/fitness", confidence: 0.85 }
    ],
    needs_review: false,
    rationale: "Interviews with endurance athletes and runners discussing training and life decisions.",
    display_title: "Ali on the Run Show",
    blurb: "Conversations with inspiring runners and endurance athletes sharing their journeys and experiences."
  },
  1205144996: { // Drinking From the Toilet
    topics: [
      { node: "nature/pets", confidence: 0.95 },
      { node: "education/how-to", confidence: 0.6 }
    ],
    needs_review: false,
    rationale: "Behind-the-scenes look at dog training methods, behavior, and learning with honest discussion.",
    display_title: "Drinking From the Toilet",
    blurb: "Real talk about dog training, behavior, and the reality of working with canine learners."
  },
  1211894042: { // Yaqeen Podcast
    topics: [
      { node: "religion/islam", confidence: 0.95 }
    ],
    needs_review: false,
    rationale: "Islamic lectures and discussions on topics important to Muslim audiences.",
    display_title: "Yaqeen Podcast",
    blurb: "Islamic lectures and conversations exploring faith, scholarship, and spirituality."
  },
  1217040140: { // Learn Italian with Joy of Languages
    topics: [
      { node: "education/language-learning", confidence: 0.95 },
      { node: "linguistics/language", confidence: 0.8 }
    ],
    needs_review: false,
    rationale: "Bite-sized Italian language lessons for travelers and learners.",
    display_title: "Learn Italian with Joy of Languages",
    blurb: "Practical Italian phrases and grammar lessons for travelers and learners."
  },
  1217923682: { // Law Enforcement Talk
    topics: [
      { node: "true-crime", confidence: 0.8 },
      { node: "society", confidence: 0.75 }
    ],
    needs_review: false,
    rationale: "True crime and trauma stories from law enforcement, first responders, and victims.",
    display_title: "Law Enforcement Talk",
    blurb: "Crime investigations and trauma narratives told by those who lived them."
  },
  1223782070: { // Aviation News Talk
    topics: [
      { node: "aviation", confidence: 0.95 }
    ],
    needs_review: false,
    rationale: "General aviation news, safety tips, interviews, and technical discussions for pilots.",
    display_title: "Aviation News Talk",
    blurb: "Aviation safety, pilot experiences, and technical flying discussions for GA enthusiasts."
  },
  1223826362: { // Gayish Podcast
    topics: [
      { node: "comedy", confidence: 0.75 },
      { node: "relationships", confidence: 0.8 },
      { node: "culture", confidence: 0.7 }
    ],
    needs_review: false,
    rationale: "Award-winning show breaking down gay stereotypes with humor and irreverent discussion.",
    display_title: "Gayish Podcast",
    blurb: "Comedy and conversation exploring LGBTQ+ culture and identity with humor and honesty."
  },
  1224204194: { // Science & Futurism with Isaac Arthur
    topics: [
      { node: "science", confidence: 0.9 },
      { node: "space", confidence: 0.8 },
      { node: "engineering", confidence: 0.7 }
    ],
    needs_review: false,
    rationale: "Long-term human future through space exploration, technology, and speculative science.",
    display_title: "Science & Futurism with Isaac Arthur",
    blurb: "Space colonization, advanced technology, and speculative futures grounded in real science."
  },
  1224965828: { // The Late-Round Fantasy Football Podcast
    topics: [
      { node: "sports/fantasy", confidence: 0.95 }
    ],
    needs_review: false,
    rationale: "Fantasy football strategy and analysis for building winning draft strategies.",
    display_title: "The Late-Round Fantasy Football Podcast",
    blurb: "Analytical fantasy football strategy and draft advice for finding breakout candidates."
  },
  1225096382: { // The House of Pod
    topics: [
      { node: "medicine", confidence: 0.8 },
      { node: "science", confidence: 0.8 },
      { node: "comedy", confidence: 0.6 }
    ],
    needs_review: false,
    rationale: "Humor-focused medical podcast by GI doctor discussing health topics and public health.",
    display_title: "The House of Pod",
    blurb: "Medical topics and public health discussions blended with humor and expert perspective."
  },
  1227699368: { // Tifo Football Podcast
    topics: [
      { node: "sports/soccer", confidence: 0.95 }
    ],
    needs_review: false,
    rationale: "Tactical, historical, and geopolitical analysis of soccer and football.",
    display_title: "Tifo Football Podcast",
    blurb: "Deep tactical and historical breakdown of soccer's strategy, history, and geopolitics."
  },
  1233359606: { // Alison Wonderland - Radio Wonderland
    topics: [
      { node: "music", confidence: 0.9 },
      { node: "music/theory-production", confidence: 0.7 }
    ],
    needs_review: false,
    rationale: "Weekly electronic music show featuring DJ mixes and interviews with music producers.",
    display_title: "Alison Wonderland - Radio Wonderland",
    blurb: "Weekly electronic music show featuring new releases, guest mixes, and throwback tracks."
  },
  1236253646: { // Oliver Heldens presents Heldeep Radio
    topics: [
      { node: "music", confidence: 0.9 }
    ],
    needs_review: false,
    rationale: "House and electronic music radio show with upfront tracks and label releases.",
    display_title: "Heldeep Radio",
    blurb: "Weekly house and electronic music show featuring upfront releases from Heldeep Records."
  },
  1237796990: { // History Unplugged Podcast
    topics: [
      { node: "history", confidence: 0.9 },
      { node: "education/courses", confidence: 0.5 }
    ],
    needs_review: false,
    rationale: "History interviews and call-in show with resident historian answering audience questions.",
    display_title: "History Unplugged Podcast",
    blurb: "Historical interviews and expert Q&A exploring history's overlooked stories and figures."
  },
  1237931798: { // Where Should We Begin
    topics: [
      { node: "psychology", confidence: 0.8 },
      { node: "relationships", confidence: 0.85 },
      { node: "health/mental", confidence: 0.7 }
    ],
    needs_review: false,
    rationale: "Psychotherapy sessions with real people discussing relationships and personal struggles.",
    display_title: "Where Should We Begin?",
    blurb: "Real therapy sessions exploring relationships, identity, and personal challenges."
  },
  1239901676: { // Discovery Mountain
    topics: [
      { node: "kids-family/stories", confidence: 0.95 },
      { node: "religion/christianity", confidence: 0.8 }
    ],
    needs_review: false,
    rationale: "Bible-based audio adventure stories for kids about faith and personal growth.",
    display_title: "Discovery Mountain",
    blurb: "Faith-based audio adventures for kids exploring values, courage, and spiritual lessons."
  },
  1242630512: { // Escape This Podcast
    topics: [
      { node: "gaming", confidence: 0.8 },
      { node: "hobbies", confidence: 0.7 }
    ],
    needs_review: false,
    rationale: "Blend of escape room puzzles and tabletop role-playing games with hosts.",
    display_title: "Escape This Podcast",
    blurb: "Mix of escape room puzzles and tabletop role-playing with comedic hosts."
  },
  1245763628: { // The Rachel Hollis Podcast
    topics: [
      { node: "education/self-improvement", confidence: 0.85 },
      { node: "psychology", confidence: 0.7 }
    ],
    needs_review: false,
    rationale: "Self-improvement and personal growth advice blended with wisdom and practical guidance.",
    display_title: "The Rachel Hollis Podcast",
    blurb: "Personal growth and self-improvement wisdom for designing a life that feels good."
  },
  1247300054: { // Cleared Hot
    topics: [
      { node: "society", confidence: 0.7 },
      { node: "culture", confidence: 0.6 }
    ],
    needs_review: true,
    rationale: "Military veteran's perspective on growth, discomfort, and personal challenges.",
    display_title: "Cleared Hot",
    blurb: "Conversations exploring military experience, leadership, and personal transformation."
  },
  1251213764: { // Petros And Money
    topics: [
      { node: "sports", confidence: 0.9 }
    ],
    needs_review: false,
    rationale: "Daily sports talk and commentary covering NFL, NBA, and sports news.",
    display_title: "Petros And Money",
    blurb: "Daily sports commentary and analysis covering football, basketball, and current events."
  },
  1252638476: { // Brooke and Jeffrey: Second Date Update
    topics: [
      { node: "comedy", confidence: 0.8 },
      { node: "relationships", confidence: 0.7 }
    ],
    needs_review: false,
    rationale: "Comedy show calling people who ghosted dates to uncover the real reason why.",
    display_title: "Brooke and Jeffrey: Second Date Update",
    blurb: "Humorous dating comedy show calling ghosters to reveal why dates went wrong."
  },
  1253053148: { // The Power Trip
    topics: [
      { node: "comedy", confidence: 0.8 },
      { node: "sports", confidence: 0.6 }
    ],
    needs_review: false,
    rationale: "Morning show mixing sports, movies, music, and comedy with personality-driven segments.",
    display_title: "The Power Trip",
    blurb: "Morning show blending sports, movies, music, and comedy with local Minneapolis focus."
  },
  1253186678: { // Syntax - Tasty Web Development Treats
    topics: [
      { node: "computing", confidence: 0.95 },
      { node: "engineering/ai-robotics", confidence: 0.4 }
    ],
    needs_review: false,
    rationale: "Web development deep dives on frameworks, tools, and industry trends.",
    display_title: "Syntax",
    blurb: "Web development insights on frameworks, tools, and modern coding practices."
  }
};

// Add more shows (continuing from existing classifications)
const additionalShows = [
  {
    id: 1254198976,
    data: {
      topics: [{ node: "news/tech", confidence: 0.9 }],
      needs_review: false,
      rationale: "Technology news and industry trends.",
      display_title: "Tech News",
      blurb: "Latest technology news and industry developments."
    }
  }
];

// Process all shows in batch
for (const show of batch.shows) {
  const id = show.apple_collection_id;
  
  if (classifications[id]) {
    results.results[id] = {
      ...classifications[id],
      model: "claude-code-cron (tier 1)"
    };
  } else {
    // Skip shows without explicit classification
    console.log(`Skipping show ${id}: ${show.title} (no classification defined)`);
  }
}

fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
console.log(`Classified ${Object.keys(results.results).length} shows to ${RESULTS_FILE}`);
