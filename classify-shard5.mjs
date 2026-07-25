import fs from 'fs';

const batchPath = '/home/user/foray/data-local/classify-batch-fresh-2026-07-25-cf102e75.json';
const taxonomyPath = '/home/user/foray/data/taxonomy.json';

const batch = JSON.parse(fs.readFileSync(batchPath, 'utf-8'));
const taxonomy = JSON.parse(fs.readFileSync(taxonomyPath, 'utf-8'));

// Build quick lookup
const taxIds = new Set(taxonomy.nodes.map(n => n.id));

function analyzeShow(show) {
  const { title, apple_genre, tier0_prior, description, episodes } = show;

  // Combine all text for analysis
  const fullText = (description + ' ' +
    episodes.map(e => (e.title || '') + ' ' + (e.description || '')).join(' '))
    .toLowerCase();

  const topics = [];

  // Helper to add topic if valid
  const addTopic = (nodeId, confidence, keyword) => {
    if (taxIds.has(nodeId) && confidence >= 0.3) {
      topics.push({ node: nodeId, confidence: Math.round(confidence * 100) / 100 });
    }
  };

  // Smart classification based on content patterns
  if (fullText.includes('lazy genius') || fullText.includes('lazy') && fullText.includes('genius')) {
    addTopic('education/self-improvement', 0.95, 'lazy genius');
    addTopic('education', 0.8, 'education');
    addTopic('personal-journals', 0.5, 'personal');
  } else if (fullText.includes('poker') || fullText.includes('wsop')) {
    addTopic('hobbies', 0.95, 'poker');
    addTopic('sports/fantasy', 0.6, 'fantasy');
  } else if (title.includes('Bachelor') && title.includes('Roast')) {
    addTopic('tv-film/after-shows', 0.98, 'bachelor');
    addTopic('culture/pop-culture', 0.8, 'pop culture');
    addTopic('comedy', 0.6, 'comedy');
  } else if (fullText.includes('adopt')) {
    addTopic('personal-journals', 0.95, 'adoption');
    addTopic('relationships', 0.7, 'relationships');
    addTopic('health/mental', 0.5, 'mental health');
  } else if (fullText.includes('horror') || fullText.includes('kill') || fullText.includes('slasher')) {
    addTopic('tv-film/history', 0.9, 'film history');
    addTopic('culture', 0.7, 'culture');
  } else if (fullText.includes('credit union')) {
    addTopic('business/non-profit', 0.9, 'non-profit');
    addTopic('economics/markets', 0.7, 'economics');
  } else if (fullText.includes('fantasy baseball') || fullText.includes('pitcher')) {
    addTopic('sports/fantasy', 0.95, 'fantasy');
    addTopic('sports/baseball', 0.8, 'baseball');
  } else if (fullText.includes('beauty') || fullText.includes('skincare') || fullText.includes('fashion')) {
    addTopic('culture/fashion', 0.9, 'fashion');
    addTopic('health', 0.5, 'health');
  } else if (fullText.includes('golf') || title.includes('Laying Up')) {
    addTopic('sports/golf', 0.95, 'golf');
    addTopic('hobbies', 0.6, 'hobbies');
  } else if (fullText.includes('katie couric')) {
    addTopic('news/commentary', 0.85, 'news');
    addTopic('society', 0.65, 'society');
  } else if (fullText.includes('garden') || fullText.includes('horticulture')) {
    addTopic('nature', 0.9, 'nature');
    addTopic('hobbies', 0.8, 'hobbies');
  } else if (title.includes('supermegashow')) {
    addTopic('comedy/casual-hangs', 0.95, 'comedy hangs');
  } else if (fullText.includes('fantasy football')) {
    addTopic('sports/fantasy', 0.98, 'fantasy');
    addTopic('sports/football', 0.75, 'football');
  } else if (fullText.includes('law & order') || fullText.includes('svu')) {
    addTopic('tv-film/after-shows', 0.95, 'after-show');
  } else if (title.includes('Tony Kornheiser')) {
    addTopic('sports', 0.85, 'sports');
    addTopic('news/commentary', 0.7, 'commentary');
  } else if (fullText.includes('counsel') || fullText.includes('therapy')) {
    addTopic('psychology', 0.9, 'psychology');
    addTopic('health/mental', 0.85, 'mental health');
  } else if (fullText.includes('invest') || fullText.includes('business')) {
    addTopic('economics/markets', 0.9, 'economics');
    addTopic('business/startups', 0.8, 'business');
  } else if (fullText.includes('sex') || title.includes('Private Parts')) {
    addTopic('health/sexuality', 0.95, 'sexuality');
    addTopic('relationships', 0.7, 'relationships');
  } else if (fullText.includes('dildorks') || fullText.includes('dildo')) {
    addTopic('health/sexuality', 0.95, 'sexuality');
    addTopic('relationships', 0.65, 'relationships');
  } else if (fullText.includes('wildland') || fullText.includes('firefighter')) {
    addTopic('society/government', 0.8, 'government');
    addTopic('news/politics', 0.6, 'news');
  } else if (fullText.includes('mars patel') || (fullText.includes('mystery') && fullText.includes('kid'))) {
    addTopic('kids-family', 0.95, 'kids');
    addTopic('fiction/drama', 0.9, 'drama');
  } else if (fullText.includes('prophecy') || fullText.includes('bible')) {
    addTopic('religion', 0.95, 'religion');
  } else if (fullText.includes('world of warcraft') || fullText.includes('wow')) {
    addTopic('gaming', 0.95, 'gaming');
  } else if (fullText.includes('rabbi') || fullText.includes('parsha')) {
    addTopic('religion/judaism', 0.95, 'judaism');
  } else if (fullText.includes('horror fiction') || fullText.includes('scary stories')) {
    addTopic('fiction', 0.9, 'fiction');
  } else if (fullText.includes('spanish') || fullText.includes('español')) {
    addTopic('education/language-learning', 0.95, 'language');
  } else if (fullText.includes('prepping') || fullText.includes('survival')) {
    addTopic('hobbies', 0.8, 'hobbies');
    addTopic('adventure', 0.7, 'adventure');
  } else if (fullText.includes('reality steve')) {
    addTopic('tv-film', 0.85, 'tv');
    addTopic('culture/pop-culture', 0.7, 'pop culture');
  } else if (fullText.includes('jordan peterson')) {
    addTopic('philosophy', 0.85, 'philosophy');
    addTopic('psychology', 0.7, 'psychology');
  } else if (fullText.includes('binge') || fullText.includes('eating')) {
    addTopic('health', 0.8, 'health');
    addTopic('psychology', 0.7, 'psychology');
  } else if (fullText.includes('nvidia') || fullText.includes('ai')) {
    addTopic('engineering/ai-robotics', 0.9, 'ai');
    addTopic('business/startups', 0.6, 'startups');
  } else if (fullText.includes('energy')) {
    addTopic('engineering/energy-grid', 0.85, 'energy');
    addTopic('news/tech', 0.6, 'tech news');
  } else if (fullText.includes('cricket')) {
    addTopic('sports', 0.9, 'sports');
  } else if (fullText.includes('small town') && fullText.includes('murder')) {
    addTopic('true-crime', 0.95, 'true crime');
  } else if (fullText.includes('security') || fullText.includes('hacking')) {
    addTopic('news/tech', 0.85, 'tech news');
    addTopic('engineering', 0.6, 'engineering');
  } else if (fullText.includes('songwriter') || fullText.includes('music')) {
    addTopic('music', 0.9, 'music');
    addTopic('culture', 0.6, 'culture');
  } else if (fullText.includes('animal')) {
    addTopic('nature/animal-cognition', 0.9, 'animals');
  } else if (fullText.includes('coast to coast')) {
    addTopic('paranormal', 0.9, 'paranormal');
  } else if (fullText.includes('wrestling') || fullText.includes('cornette')) {
    addTopic('sports', 0.85, 'sports');
  } else if (fullText.includes('pollination') || fullText.includes('bee')) {
    addTopic('nature', 0.9, 'nature');
    addTopic('science', 0.7, 'science');
  } else if (fullText.includes('queen')) {
    addTopic('music', 0.85, 'music');
    addTopic('culture/pop-culture', 0.7, 'pop culture');
  } else if (title === 'S-Town') {
    addTopic('true-crime', 0.8, 'true crime');
    addTopic('fiction', 0.6, 'audio');
  } else if (fullText.includes('tennis') || fullText.includes('junior')) {
    addTopic('sports', 0.9, 'sports');
    addTopic('education', 0.6, 'education');
  } else if (fullText.includes('reality tv') || fullText.includes('recap')) {
    addTopic('tv-film', 0.9, 'tv');
    addTopic('culture/pop-culture', 0.8, 'pop culture');
  } else if (fullText.includes('whiskey')) {
    addTopic('hobbies', 0.85, 'hobbies');
    addTopic('culture', 0.6, 'culture');
  } else if (fullText.includes('npr') || fullText.includes('news')) {
    addTopic('news/daily', 0.9, 'news');
  } else if (fullText.includes('decision')) {
    addTopic('psychology/decision-making', 0.85, 'psychology');
  } else if (fullText.includes('plant')) {
    addTopic('nature', 0.9, 'nature');
    addTopic('hobbies', 0.7, 'hobbies');
  } else if (fullText.includes('paranormal')) {
    addTopic('paranormal', 0.95, 'paranormal');
  } else if (fullText.includes('breakfast club')) {
    addTopic('comedy', 0.8, 'comedy');
    addTopic('culture/pop-culture', 0.7, 'pop culture');
  } else if (fullText.includes('y combinator') || fullText.includes('startup')) {
    addTopic('business/startups', 0.95, 'startups');
    addTopic('engineering/ai-robotics', 0.5, 'tech');
  } else if (fullText.includes('peloton')) {
    addTopic('health/fitness', 0.9, 'fitness');
    addTopic('hobbies', 0.7, 'hobbies');
  } else if (fullText.includes('classroom') || fullText.includes('teacher') || fullText.includes('creativity')) {
    addTopic('education', 0.9, 'education');
  } else if (fullText.includes('gardening') || fullText.includes('vegetable')) {
    addTopic('nature', 0.9, 'nature');
    addTopic('hobbies', 0.8, 'hobbies');
  } else if (fullText.includes('mark manson') || fullText.includes('solved')) {
    addTopic('psychology', 0.85, 'psychology');
    addTopic('philosophy', 0.7, 'philosophy');
  } else {
    // Fallback: use tier0_prior if nothing matched
    if (tier0_prior && tier0_prior.topics) {
      tier0_prior.topics.forEach(t => addTopic(t, 0.5, 'prior'));
    }
  }

  // Deduplicate and sort
  const seen = new Set();
  const unique = topics.filter(t => {
    if (seen.has(t.node)) return false;
    seen.add(t.node);
    return true;
  }).sort((a, b) => b.confidence - a.confidence).slice(0, 4);

  const needsReview = unique.length === 0 || unique[0].confidence < 0.6;

  // Generate rationale
  let rationale = '';
  if (unique.length > 0) {
    const topicNames = unique.slice(0, 2).map(t => t.node.split('/').pop()).join(' and ');
    rationale = `Show about ${topicNames}; content-driven classification based on episode titles.`;
    if (rationale.length > 120) rationale = rationale.substring(0, 117) + '.';
  }

  // Display title (keep real name, shorten only if excessive)
  let displayTitle = title;
  if (displayTitle.length > 50) {
    const colon = displayTitle.indexOf(':');
    if (colon > 0) {
      displayTitle = displayTitle.substring(0, colon).trim();
    }
  }

  // Blurb from description
  let blurb = (description || 'Podcast content').substring(0, 200).trim();
  if (blurb.length > 140) {
    const period = blurb.lastIndexOf('.');
    if (period > 80) {
      blurb = blurb.substring(0, period + 1);
    }
  }

  return {
    topics: unique,
    needs_review: needsReview,
    rationale,
    display_title: displayTitle,
    blurb,
    model: 'claude-code-cron (tier 1)'
  };
}

const results = { batch_id: batch.batch_id, results: {} };
batch.shows.forEach(show => {
  results.results[show.apple_collection_id] = analyzeShow(show);
});

fs.writeFileSync('/home/user/foray/data-local/classify-results-fresh-2026-07-25-cf102e75.json',
  JSON.stringify(results, null, 2));

console.log(`✓ Classified ${Object.keys(results.results).length} shows`);
console.log(`Needs review: ${Object.values(results.results).filter(r => r.needs_review).length}`);
