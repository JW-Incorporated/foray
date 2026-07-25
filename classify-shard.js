const fs = require('fs');
const path = require('path');

// Load batch, taxonomy
const batchPath = process.argv[2];
const taxonomyPath = 'data/taxonomy.json';

const batch = JSON.parse(fs.readFileSync(batchPath, 'utf-8'));
const taxonomy = JSON.parse(fs.readFileSync(taxonomyPath, 'utf-8'));

// Build a map of valid node IDs
const validNodeIds = new Set();
taxonomy.nodes.forEach(node => {
  validNodeIds.add(node.id);
});

// Classification logic
function classifyShow(show) {
  const { title, description, episodes, apple_genre, tier0_prior } = show;

  // Build full signal text from description + recent episodes
  let signal = (description || '').toLowerCase();
  if (episodes && Array.isArray(episodes)) {
    episodes.forEach(ep => {
      if (ep.title) signal += ' ' + (ep.title || '').toLowerCase();
      if (ep.description) signal += ' ' + (ep.description || '').toLowerCase();
    });
  }

  // Topic assignment logic
  const topics = [];
  let confidence = 0;

  // Use tier0_prior as a starting point, validate against signal
  if (tier0_prior && tier0_prior.topics && tier0_prior.topics.length > 0) {
    const priorTopic = tier0_prior.topics[0];

    // Check if prior is in valid nodes
    if (validNodeIds.has(priorTopic)) {
      // Analyze signal to confirm/adjust
      const priorConf = analyzeNodeFit(signal, priorTopic, taxonomy);

      if (priorConf >= 0.7) {
        topics.push({ node: priorTopic, confidence: priorConf });
        confidence = priorConf;
      } else if (priorConf >= 0.5) {
        topics.push({ node: priorTopic, confidence: priorConf });
        confidence = priorConf;
      } else {
        // Signal doesn't match prior well; look for better fit
        const bestFit = findBestNodeFit(signal, taxonomy);
        if (bestFit && bestFit.confidence >= 0.5) {
          topics.push(bestFit);
          confidence = bestFit.confidence;
        } else if (bestFit && bestFit.confidence >= 0.4) {
          // Weak fit but still something
          topics.push(bestFit);
          confidence = bestFit.confidence;
        }
      }
    }
  } else {
    // No prior; find best fit directly
    const bestFit = findBestNodeFit(signal, taxonomy);
    if (bestFit && bestFit.confidence >= 0.5) {
      topics.push(bestFit);
      confidence = bestFit.confidence;
    }
  }

  // If no strong match found, try secondary nodes
  if (topics.length === 0 || confidence < 0.6) {
    // Look for additional related nodes
    const secondaryFits = findSecondaryFits(signal, taxonomy).slice(0, 2);
    secondaryFits.forEach(fit => {
      if (fit.confidence >= 0.4) {
        topics.push(fit);
      }
    });
  }

  const needsReview =
    (topics.length === 0) ||
    (topics[0].confidence < 0.6) ||
    (tier0_prior && tier0_prior.confidence === 'high' && topics[0]?.node !== tier0_prior.topics[0]);

  // Generate display_title (default = real title)
  let displayTitle = title;
  if (title.length > 50 || title === title.toUpperCase()) {
    displayTitle = title.split(':')[0].trim().substring(0, 40).trim();
  }

  // Word count check
  const wordCount = displayTitle.split(/\s+/).length;
  if (wordCount > 8) {
    displayTitle = displayTitle.split(/\s+/).slice(0, 8).join(' ');
  }

  // Generate blurb grounded in signal
  let blurb = generateBlurb(title, description, episodes);
  if (blurb.length > 150) {
    blurb = blurb.substring(0, 147) + '...';
  }

  return {
    topics: topics.slice(0, 4),
    needs_review: needsReview,
    rationale: generateRationale(signal, topics),
    display_title: displayTitle,
    blurb: blurb,
    model: 'claude-code-cron (tier 1)'
  };
}

function analyzeNodeFit(signal, nodeId, taxonomy) {
  // Simple keyword matching for now
  const node = taxonomy.nodes.find(n => n.id === nodeId);
  if (!node) return 0;

  const label = (node.label || '').toLowerCase();
  const keywords = extractKeywords(label);

  let matchCount = 0;
  keywords.forEach(kw => {
    if (signal.includes(kw)) matchCount++;
  });

  return Math.min(1, 0.3 + (matchCount / Math.max(1, keywords.length)) * 0.7);
}

function extractKeywords(text) {
  return text.split(/[\s/]+/).filter(w => w.length > 2);
}

function findBestNodeFit(signal, taxonomy) {
  let best = null;
  let bestScore = 0;

  taxonomy.nodes.forEach(node => {
    const score = analyzeNodeFit(signal, node.id, taxonomy);
    if (score > bestScore) {
      bestScore = score;
      best = { node: node.id, confidence: score };
    }
  });

  return best && bestScore >= 0.4 ? best : null;
}

function findSecondaryFits(signal, taxonomy) {
  const scores = taxonomy.nodes.map(node => ({
    node: node.id,
    confidence: analyzeNodeFit(signal, node.id, taxonomy)
  }));
  return scores.filter(s => s.confidence >= 0.3).sort((a, b) => b.confidence - a.confidence);
}

function generateRationale(signal, topics) {
  if (topics.length === 0) {
    return 'Unable to determine primary topic from available signal.';
  }
  const topNode = topics[0];
  return `Primary focus: ${topNode.node.replace(/[/-]/g, ' ')}. Confidence ${Math.round(topNode.confidence * 100)}%.`;
}

function generateBlurb(title, description, episodes) {
  let blurb = (description || '').substring(0, 120);

  // If description is empty, build from episodes
  if (!blurb && episodes && episodes.length > 0) {
    const epTitles = episodes.slice(0, 3).map(e => e.title).filter(t => t).join(', ');
    if (epTitles) {
      blurb = `Recent episodes: ${epTitles.substring(0, 100)}.`;
    }
  }

  if (!blurb) {
    blurb = `Podcast series titled ${title}.`;
  }

  return blurb.trim();
}

// Main
const results = {
  batch_id: batch.batch_id,
  results: {}
};

batch.shows.forEach(show => {
  const classification = classifyShow(show);
  results.results[show.apple_collection_id] = classification;
});

const outputPath = `data-local/classify-results-${batch.batch_id}.json`;
fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
console.log(`Classified ${Object.keys(results.results).length} shows -> ${outputPath}`);
