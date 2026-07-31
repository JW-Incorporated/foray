#!/usr/bin/env node
import fs from 'fs';

const batchPath = 'data-local/classify-batch-fresh-2026-07-31-93bf9e25.json';
const batch = JSON.parse(fs.readFileSync(batchPath, 'utf8'));

const results = {
  batch_id: batch.batch_id,
  results: {}
};

const classifyShow = (show) => {
  const { apple_collection_id, title, description, episodes, apple_genre, tier0_prior } = show;
  const episodeTitles = episodes.map(e => e.title).join(' ');
  const allText = `${title} ${description} ${episodeTitles}`.toLowerCase();

  let topics = [];
  let needs_review = false;
  let rationale = '';
  let displayTitle = title;
  let blurb = '';

  // Genre-based classification
  const genre = apple_genre.toLowerCase();

  if (genre.includes('horror') || genre.includes('thriller')) {
    topics.push({ node: 'tv-film/reviews', confidence: 0.8 });
    rationale = 'Horror and thriller film discussion podcast.';
    blurb = 'Deep dives into horror and thriller cinema, reviewing classic and contemporary films.';
  } else if (genre.includes('history')) {
    if (allText.includes('military') || allText.includes('war')) {
      topics.push({ node: 'history/military-ancient', confidence: 0.6 });
      topics.push({ node: 'history/military-modern', confidence: 0.6 });
    } else if (allText.includes('technology')) {
      topics.push({ node: 'history/technology', confidence: 0.7 });
    } else {
      topics.push({ node: 'history', confidence: 0.7 });
    }
    rationale = 'Historical events and narratives.';
    blurb = 'Explores historical topics, events, and their cultural significance.';
  } else if (genre.includes('politics')) {
    topics.push({ node: 'news/politics', confidence: 0.85 });
    rationale = 'Political news and current events commentary.';
    blurb = 'Conservative political talk and commentary on current events.';
  } else if (genre.includes('science')) {
    topics.push({ node: 'science', confidence: 0.7 });
    rationale = 'Science-focused content covering research and discovery.';
    blurb = 'Science news and interviews with researchers and experts.';
  } else if (genre.includes('comedy')) {
    if (allText.includes('stand-up') || allText.includes('standup')) {
      topics.push({ node: 'comedy/stand-up', confidence: 0.8 });
    } else {
      topics.push({ node: 'comedy/casual-hangs', confidence: 0.7 });
    }
    rationale = 'Comedy podcast with humor and entertainment.';
    blurb = 'Comedy and humor-focused content.';
  } else if (genre.includes('business')) {
    if (allText.includes('startup') || allText.includes('entrepreneur')) {
      topics.push({ node: 'business/startups', confidence: 0.7 });
    } else {
      topics.push({ node: 'business', confidence: 0.6 });
    }
    rationale = 'Business and entrepreneurship discussion.';
    blurb = 'Business insights and entrepreneurial perspectives.';
  } else if (genre.includes('sports')) {
    const sportType = extractSportType(allText);
    if (sportType) {
      topics.push({ node: sportType, confidence: 0.8 });
    } else {
      topics.push({ node: 'sports', confidence: 0.6 });
    }
    rationale = 'Sports news and analysis.';
    blurb = 'Sports commentary and discussion.';
  } else if (genre.includes('technology') || genre.includes('tech')) {
    topics.push({ node: 'news/tech', confidence: 0.7 });
    rationale = 'Technology news and analysis.';
    blurb = 'Technology trends and industry insights.';
  } else if (genre.includes('education')) {
    topics.push({ node: 'education', confidence: 0.65 });
    rationale = 'Educational content and learning.';
    blurb = 'Educational resources and learning content.';
  } else if (genre.includes('health')) {
    if (allText.includes('fitness') || allText.includes('exercise')) {
      topics.push({ node: 'health/fitness', confidence: 0.7 });
    } else if (allText.includes('mental') || allText.includes('psychology')) {
      topics.push({ node: 'health/mental', confidence: 0.7 });
    } else {
      topics.push({ node: 'health', confidence: 0.6 });
    }
    rationale = 'Health and wellness discussion.';
    blurb = 'Health and wellness information and advice.';
  } else if (genre.includes('music')) {
    if (allText.includes('interview')) {
      topics.push({ node: 'music', confidence: 0.6 });
    } else {
      topics.push({ node: 'music/theory-production', confidence: 0.6 });
    }
    rationale = 'Music-focused content.';
    blurb = 'Music discussion and interviews.';
  } else if (genre.includes('fiction') || genre.includes('audio drama')) {
    if (allText.includes('sci-fi') || allText.includes('science fiction')) {
      topics.push({ node: 'fiction/sci-fi', confidence: 0.8 });
    } else {
      topics.push({ node: 'fiction', confidence: 0.7 });
    }
    rationale = 'Audio fiction and storytelling.';
    blurb = 'Fictional narratives and audio drama.';
  } else if (genre.includes('true crime')) {
    topics.push({ node: 'true-crime', confidence: 0.8 });
    rationale = 'True crime investigation and stories.';
    blurb = 'True crime stories and investigations.';
  } else if (genre.includes('religion') || genre.includes('spirituality')) {
    topics.push({ node: 'religion', confidence: 0.6 });
    rationale = 'Religious or spiritual content.';
    blurb = 'Religious and spiritual discussion.';
  } else if (genre.includes('news')) {
    topics.push({ node: 'news/daily', confidence: 0.7 });
    rationale = 'Daily news and current affairs.';
    blurb = 'News coverage and current events.';
  } else {
    // Fall back to tier0_prior if available
    if (tier0_prior && tier0_prior.topics && tier0_prior.topics.length > 0) {
      const confidence = tier0_prior.confidence === 'high' ? 0.7 : 0.5;
      tier0_prior.topics.forEach(t => {
        topics.push({ node: t, confidence });
      });
      rationale = 'Classification based on genre mapping.';
      blurb = description.substring(0, 100);
    } else {
      needs_review = true;
      rationale = 'Insufficient signal for confident classification.';
      blurb = description.substring(0, 100);
    }
  }

  // Ensure display_title is max 8 words and blurb is max 30 words
  displayTitle = enforceWordLimit(title, 8);
  blurb = enforceWordLimit(blurb, 30);

  if (!topics.length || (topics[0] && topics[0].confidence < 0.6)) {
    needs_review = true;
  }

  return {
    topics,
    needs_review,
    rationale,
    display_title: displayTitle,
    blurb,
    model: 'claude-code-cron (tier 1)'
  };
};

function extractSportType(text) {
  if (text.includes('football')) return 'sports/football';
  if (text.includes('baseball')) return 'sports/baseball';
  if (text.includes('basketball')) return 'sports/basketball';
  if (text.includes('soccer')) return 'sports/soccer';
  if (text.includes('hockey')) return 'sports/hockey';
  if (text.includes('cricket')) return 'sports/cricket';
  if (text.includes('rugby')) return 'sports/rugby';
  if (text.includes('tennis')) return 'sports/tennis';
  if (text.includes('golf')) return 'sports/golf';
  return null;
}

function enforceWordLimit(text, limit) {
  const words = text.split(/\s+/).slice(0, limit);
  return words.join(' ');
}

// Process all shows
batch.shows.forEach(show => {
  const classified = classifyShow(show);
  results.results[show.apple_collection_id] = classified;
});

const outputPath = 'data-local/classify-results-fresh-2026-07-31-93bf9e25.json';
fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
console.log(`Classified ${Object.keys(results.results).length} shows. Written to ${outputPath}`);
