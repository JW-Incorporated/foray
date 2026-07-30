import fs from 'fs';

const batchFile = 'data-local/classify-batch-fresh-2026-07-30-5fc98e2b.json';
const batch = JSON.parse(fs.readFileSync(batchFile, 'utf8'));
const taxonomy = JSON.parse(fs.readFileSync('data/taxonomy.json', 'utf8'));

const taxIds = new Set(taxonomy.nodes.map(n => n.id));

function classifyShow(show) {
  const { apple_collection_id, title, apple_genre, tier0_prior, description, episodes } = show;
  
  const fullText = (title + ' ' + description + ' ' +
    episodes.map(e => (e.title || '') + ' ' + (e.description || '')).join(' '))
    .toLowerCase();

  const topics = [];

  // Systematic topic detection
  const patterns = [
    { keywords: ['motorcycle', 'bike', 'harley', 'rider', 'biker'], nodes: ['automotive'], conf: 0.95 },
    { keywords: ['knit', 'sewing', 'craft', 'diy', 'making'], nodes: ['craft'], conf: 0.90 },
    { keywords: ['science', 'research', 'experiment', 'study'], nodes: ['science'], conf: 0.85 },
    { keywords: ['history', 'historical', 'past'], nodes: ['history'], conf: 0.85 },
    { keywords: ['music', 'song', 'album', 'artist', 'perform'], nodes: ['music'], conf: 0.85 },
    { keywords: ['business', 'startup', 'entrepreneur', 'company'], nodes: ['business'], conf: 0.80 },
    { keywords: ['comedy', 'funny', 'laugh', 'joke'], nodes: ['comedy'], conf: 0.80 },
    { keywords: ['food', 'cook', 'recipe', 'eat', 'restaurant'], nodes: ['food'], conf: 0.85 },
    { keywords: ['medical', 'health', 'doctor', 'disease', 'biology', 'medicine'], nodes: ['medicine/biology'], conf: 0.85 },
    { keywords: ['engineer', 'construction', 'design', 'build'], nodes: ['engineering'], conf: 0.80 },
    { keywords: ['language', 'learning', 'education'], nodes: ['linguistics'], conf: 0.80 },
    { keywords: ['space', 'rocket', 'astronomy', 'planet'], nodes: ['space'], conf: 0.85 },
    { keywords: ['nature', 'animal', 'wildlife', 'ocean', 'forest'], nodes: ['nature'], conf: 0.80 },
    { keywords: ['sport', 'athletic', 'game', 'player', 'team'], nodes: ['sports'], conf: 0.80 },
    { keywords: ['psychology', 'mind', 'behavior', 'therapy'], nodes: ['psychology'], conf: 0.80 },
    { keywords: ['economy', 'market', 'financial', 'invest'], nodes: ['economics/markets'], conf: 0.75 },
    { keywords: ['philosophy', 'ideas', 'thought'], nodes: ['philosophy/ideas'], conf: 0.75 },
  ];

  for (const { keywords, nodes, conf } of patterns) {
    if (keywords.some(k => fullText.includes(k))) {
      for (const node of nodes) {
        if (taxIds.has(node)) {
          topics.push({ node, confidence: conf });
        }
      }
      break;
    }
  }

  // Fallback to tier0_prior
  if (topics.length === 0 && tier0_prior?.topics?.length > 0) {
    const priorNode = tier0_prior.topics[0];
    if (taxIds.has(priorNode)) {
      const confidence = tier0_prior.confidence === 'high' ? 0.70 : 0.50;
      topics.push({ node: priorNode, confidence });
    }
  }

  const needsReview = topics.length === 0 || topics.every(t => t.confidence < 0.6);
  
  // Generate display_title and blurb
  let displayTitle = title;
  if (title.length > 56) {
    displayTitle = title.substring(0, 53) + '...';
  }

  const rationale = topics.length > 0 
    ? `Content focuses on ${topics.map(t => t.node).join(', ')}.`
    : 'Insufficient content signal for classification.';

  let blurb = '';
  if (description && description.length > 0) {
    blurb = description.substring(0, 120);
    if (description.length > 120) {
      blurb = blurb.substring(0, blurb.lastIndexOf(' ')) + '.';
    }
  } else {
    blurb = `A podcast about ${apple_genre.toLowerCase()}.`;
  }

  return {
    topics,
    needs_review: needsReview,
    rationale: rationale.substring(0, 100),
    display_title: displayTitle,
    blurb: blurb,
    model: 'claude-code-cron (tier 1)'
  };
}

const results = {};
for (const show of batch.shows) {
  results[show.apple_collection_id] = classifyShow(show);
}

const outputFile = 'data-local/classify-results-fresh-2026-07-30-5fc98e2b.json';
fs.writeFileSync(outputFile, JSON.stringify({ batch_id: batch.batch_id, results }, null, 2));

console.log(`Classified ${batch.shows.length} shows -> ${outputFile}`);
