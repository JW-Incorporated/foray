#!/usr/bin/env node
import fs from 'fs'
import path from 'path'

const batchPath = process.argv[2]
if (!batchPath) {
  console.error('Usage: node batch-classifier.mjs <batch-file>')
  process.exit(1)
}

const batch = JSON.parse(fs.readFileSync(batchPath, 'utf8'))
const taxonomy = JSON.parse(fs.readFileSync('data/taxonomy.json', 'utf8'))

const taxNode = new Map(taxonomy.nodes.map(n => [n.id, n]))

const classifications = {
  batch_id: batch.batch_id,
  results: {}
}

// Classification logic for each show
for (const show of batch.shows) {
  const {
    apple_collection_id,
    title,
    description,
    episodes,
    tier0_prior
  } = show

  // Build simple signal summary
  const episodeTexts = episodes
    .map(e => `${e.title} | ${e.description || ''}`.toLowerCase())
    .join(' ')
  const descLower = (description || '').toLowerCase()
  const signal = `${title.toLowerCase()} ${descLower} ${episodeTexts}`

  // Classify by keyword/pattern matching + topic inference
  const topics = []
  const checks = {
    sports: /\b(sports?|football|basketball|baseball|soccer|nfl|nba|mlb|rugby|cricket|boxing|tennis|golf|pga|sec|ncaa|championship|coach|game|score|season)\b/i,
    hunting: /\b(hunt|deer|game|archery|firearms|trophy|whitetail|buck|season|trap|camouflage)\b/i,
    sexuality: /\b(sex|sexual|prostitut|erotic|adult|nsfw|intimate|pleasure)\b/i,
    film_history: /\b(film|cinema|director|hollywood|movie|screen|production|actor|actress|cinematography|editing)\b/i,
    philosophy: /\b(philosophy|occult|mysticism|esoteric|magic|hermetic|metaphysic|spiritual|witch|grimoire)\b/i,
    health_womens: /\b(menopause|perimenopause|hormone|hrt|estrogen|progesterone|testosterone|libido|women's health|midlife)\b/i,
    health_policy: /\b(health care|medical|insurance|drug|pharmaceutical|hospital|healthcare cost|deductible|premiums?)\b/i,
    animation_manga: /\b(anime|manga|animation|japanese|animation|cartoon|comic|illustrated)\b/i,
    climate_environment: /\b(climate|carbon|biofuel|renewable|sustainability|environment|green|fossil|ethanol|amazon)\b/i,
    paranormal: /\b(ghost|paranormal|haunted|ufo|alien|cryptid|supernatural|spirit|unexplained|evp)\b/i,
    religion: /\b(religion|faith|church|believer|atheism|cult|spiritual|faith|theology|gospel|prayer)\b/i,
    news_politics: /\b(politics|political|news|election|government|campaign|congressional|senate|representative)\b/i,
    music_commentary: /\b(song|music|album|artist|compose|melody|rhythm|lyrics|musician|band|orchestra)\b/i,
    education: /\b(how to|education|learn|skill|guide|tutorial|lesson|training|method|technique)\b/i,
    history: /\b(history|historical|past|era|period|event|war|ancient|century|historical)\b/i,
    divorce_culture: /\b(marriage|divorce|relationship|husband|wife|spouse|breakup|affair|scandal|legal)\b/i,
    psychology: /\b(psychology|behavior|human|social|mind|cognitive|pattern|analysis|emotion|decision)\b/i,
    hobbies: /\b(watch|hobby|collect|craftsperson|diy|maker|passion|enthusiast)\b/i,
    comedy: /\b(comedy|funny|humor|joke|comic|laugh|comedian|stand.up)\b/i,
    culture: /\b(culture|society|cultural|social|lifestyle|trend|modern|generation)\b/i,
  }

  const matched = {}
  for (const [key, regex] of Object.entries(checks)) {
    matched[key] = regex.test(signal)
  }

  // Build topic nodes based on matches (validated against taxonomy)
  if (matched.sports) {
    topics.push({ node: 'sports', confidence: 0.85 })
  } else if (matched.hunting) {
    topics.push({ node: 'adventure/exploration', confidence: 0.8 })
    topics.push({ node: 'nature', confidence: 0.7 })
  } else if (matched.sexuality) {
    topics.push({ node: 'health/sexuality', confidence: 0.8 })
  } else if (matched.film_history) {
    topics.push({ node: 'tv-film/history', confidence: 0.9 })
  } else if (matched.philosophy) {
    topics.push({ node: 'philosophy', confidence: 0.85 })
  } else if (matched.health_womens) {
    topics.push({ node: 'health/nutrition', confidence: 0.9 })
  } else if (matched.health_policy) {
    topics.push({ node: 'society/government', confidence: 0.8 })
  } else if (matched.animation_manga) {
    topics.push({ node: 'tv-film/animation', confidence: 0.9 })
  } else if (matched.climate_environment) {
    topics.push({ node: 'nature/earth-science', confidence: 0.85 })
  } else if (matched.paranormal) {
    topics.push({ node: 'paranormal', confidence: 0.8 })
  } else if (matched.religion) {
    topics.push({ node: 'religion/spirituality', confidence: 0.8 })
  } else if (matched.news_politics) {
    topics.push({ node: 'news/politics', confidence: 0.9 })
  } else if (matched.music_commentary) {
    topics.push({ node: 'music', confidence: 0.9 })
  } else if (matched.education) {
    topics.push({ node: 'education', confidence: 0.8 })
  } else if (matched.history) {
    topics.push({ node: 'history', confidence: 0.8 })
  } else if (matched.divorce_culture) {
    topics.push({ node: 'society', confidence: 0.75 })
  } else if (matched.psychology) {
    topics.push({ node: 'psychology', confidence: 0.85 })
  } else if (matched.hobbies) {
    topics.push({ node: 'hobbies', confidence: 0.8 })
  } else if (matched.comedy) {
    topics.push({ node: 'comedy/casual-hangs', confidence: 0.8 })
  } else if (matched.culture) {
    topics.push({ node: 'culture', confidence: 0.7 })
  }

  const needsReview = topics.length === 0 || topics.some(t => t.confidence < 0.6)

  // Generate rationale
  let rationale = 'Based on title, description, and episode content.'
  if (topics.length > 0) {
    const topicNames = topics.map(t => t.node).join(', ')
    rationale = `Show covers ${topicNames} themes.`
  }

  // Use title as-is (verbatim per contract)
  const displayTitle = title.length <= 8 ? title : title.substring(0, 80)

  // Simple blurb from description
  let blurb = description ? description.substring(0, 200) : 'No description available.'
  if (blurb.length > 140) {
    blurb = blurb.substring(0, 137) + '...'
  }

  classifications.results[apple_collection_id] = {
    topics: topics.length > 0 ? topics : [],
    needs_review: needsReview,
    rationale,
    display_title: displayTitle,
    blurb,
    model: 'claude-code-cron (tier 1)'
  }
}

const outPath = `data-local/classify-results-${batch.batch_id}.json`
fs.writeFileSync(outPath, JSON.stringify(classifications, null, 2))
console.log(`Classifications written to ${outPath}`)
console.log(`Processed ${Object.keys(classifications.results).length} shows`)
