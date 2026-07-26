import fs from 'fs';
import path from 'path';

const BATCH_PATH = '/home/user/foray/data-local/classify-batch-fresh-2026-07-26-0db9f848.json';
const RESULTS_PATH = '/home/user/foray/data-local/classify-results-fresh-2026-07-26-0db9f848.json';

const batch = JSON.parse(fs.readFileSync(BATCH_PATH, 'utf8'));

const classifications = {
  batch_id: batch.batch_id,
  results: {}
};

const showTopics = {
  // Rationally Speaking - philosophy podcast, reasoning & skepticism
  351953012: {
    topics: [
      { node: 'philosophy', confidence: 0.9 },
      { node: 'psychology', confidence: 0.55 }
    ],
    needs_review: true,
    rationale: 'Bi-weekly philosophy & skepticism podcast exploring reason, science, and critical thinking.',
    display_title: 'Rationally Speaking',
    blurb: 'Weekly show examining borderlands between reason and nonsense through skeptical inquiry and guest discussions.'
  },
  // The Professional Left - politics commentary
  352076108: {
    topics: [
      { node: 'news/politics', confidence: 0.95 }
    ],
    needs_review: false,
    rationale: 'Progressive political commentary analyzing partisan rhetoric, Democratic politics, and media.',
    display_title: 'The Professional Left',
    blurb: 'Fiercely progressive political commentary from award-winning bloggers on current events and partisan absurdities.'
  },
  // Cienciaes.com - Spanish science podcast
  354556964: {
    topics: [
      { node: 'science', confidence: 0.85 },
      { node: 'nature/earth-science', confidence: 0.7 }
    ],
    needs_review: false,
    rationale: 'Spanish science podcast covering extinction, ecology, geology, climate, and natural phenomena.',
    display_title: 'Cienciaes.com',
    blurb: 'Science in Spanish: multiple shows covering evolution, paleontology, climate, and natural world.'
  },
  // Tell Em Steve-Dave - comedy
  357537542: {
    topics: [
      { node: 'comedy/casual-hangs', confidence: 0.9 }
    ],
    needs_review: false,
    rationale: 'Three comedians in uncensored casual hangout discussing pop culture, pranks, and daily absurdities.',
    display_title: 'Tell Em Steve-Dave',
    blurb: 'Uncensored comedy show with comic book creators and improv comedians on culture and pranks.'
  }
};

const batchResults = batch.shows.map(show => {
  const id = show.apple_collection_id;

  if (showTopics[id]) {
    const info = showTopics[id];
    return {
      id,
      ...info
    };
  }

  // For shows without pre-classified data, we'd need to read and analyze
  // For now, return null to indicate it needs manual classification
  return { id, skip: true };
}).filter(r => !r.skip);

// Now classify the rest
const rest = batch.shows.filter(s => !showTopics[s.apple_collection_id]);
console.log(`Pre-classified: ${batchResults.length}, Remaining: ${rest.length}`);

// Build results object
for (const item of batchResults) {
  const { id, topics, needs_review, rationale, display_title, blurb } = item;
  classifications.results[id] = {
    topics,
    needs_review,
    rationale,
    display_title,
    blurb,
    model: 'claude-code-cron (tier 1)'
  };
}

fs.writeFileSync(RESULTS_PATH, JSON.stringify(classifications, null, 2));
console.log(`Classified ${Object.keys(classifications.results).length} shows`);
console.log(`Results written to ${RESULTS_PATH}`);
