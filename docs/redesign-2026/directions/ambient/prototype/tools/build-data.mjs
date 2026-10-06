// Builds prototype/data.json from the repo's real data. Run from the repo root:
//   node docs/redesign-2026/directions/ambient/prototype/tools/build-data.mjs
import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const rd = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const out = path.join(root, 'docs/redesign-2026/directions/ambient/prototype/data.json');

const disc = rd('data/discover.json').items;
const words = (s) => s.trim().split(/\s+/).length;
const SUBJECTS = {
  'Science & nature': { science: 'Physics and cosmos', nature: 'Wild places', medicine: 'How bodies work' },
  'People & society': { history: 'Stories from the past', psychology: 'How minds work', society: 'Community and change' },
  'Business & work': { business: 'Building companies', economics: 'Money and markets', engineering: 'How things get built' },
  'Arts & culture': { music: 'Sound and songwriting', culture: 'Culture and craft', food: 'Food and fire' },
  'Making & tech': { computing: 'Software and machines', craft: 'Making by hand', space: 'Space and flight' },
};
const topicToSubject = {};
for (const [g, m] of Object.entries(SUBJECTS)) for (const [k, n] of Object.entries(m)) topicToSubject[k] = { group: g, id: k, name: n };

const ok = disc.filter((x) => x.hook && words(x.hook) <= 16 && x.title.length <= 56 && !x.explicit && x.artwork_url &&
  x.duration_min >= 10 && x.duration_min <= 75 && x.topics && x.topics[0] && topicToSubject[x.topics[0].split('/')[0]]);
// newest first, one per show, round-robin across subjects
ok.sort((a, b) => (b.release_date || '').localeCompare(a.release_date || ''));
const byShow = new Set();
const buckets = {};
for (const x of ok) {
  if (byShow.has(x.show)) continue;
  byShow.add(x.show);
  const k = x.topics[0].split('/')[0];
  (buckets[k] = buckets[k] || []).push(x);
}
const picked = [];
const keys = Object.keys(topicToSubject);
for (let round = 0; picked.length < 40 && round < 6; round++)
  for (const k of keys) { const x = (buckets[k] || [])[round]; if (x && picked.length < 40) picked.push(x); }

const episodes = picked.map((x) => ({
  id: x.id, show: x.show, title: x.title.replace(/\s+/g, ' '), hook: x.hook, dur: x.duration_min,
  art: x.artwork_url, subject: x.topics[0].split('/')[0], date: x.release_date,
}));

// subjects with real show counts (from the whole pool) and 3 arts each
const subjects = [];
for (const [g, m] of Object.entries(SUBJECTS)) for (const [k, n] of Object.entries(m)) {
  const pool = disc.filter((x) => x.topics && x.topics.some((t) => t.split('/')[0] === k) && x.artwork_url);
  const shows = [...new Set(pool.map((x) => x.show))];
  const arts = []; const seen = new Set();
  for (const x of pool) { if (!seen.has(x.show) && arts.length < 4) { seen.add(x.show); arts.push(x.artwork_url); } }
  subjects.push({ id: k, name: n, group: g, shows: shows.length, arts });
}

// the Foray: capital-types-1, a published, multi-show foray in the repo
const F = rd('data/forays.json').forays.find((f) => f.id === 'capital-types-1');
const S = Object.fromEntries(rd('data/segments.json').segments.map((s) => [s.id, s]));
const SRC = Object.fromEntries(rd('data/segment-sources.json').sources.map((s) => [s.id, s]));
const breadth = rd('data/catalog-breadth.json').shows;
const artFor = (show) => {
  const d = disc.find((x) => x.show === show); if (d) return d.artwork_url;
  const b = breadth.find((x) => (x.title || '').toLowerCase().includes(show.toLowerCase())); return b ? b.artwork_url : null;
};
const segs = F.items.filter((i) => i.type === 'segment').map((i) => {
  const s = S[i.segment_id]; const src = SRC[s.item_id];
  return { show: src.show, ep: src.title, art: artFor(src.show), why: s.why, dur: Math.round(s.end_sec - s.start_sec), src_start: Math.round(s.start_sec), slot: i.slot };
});
// a 9-segment run covering four shows (three with real artwork, one monogram fallback)
const want = ['Y Combinator Startup Podcast', 'Run the Numbers', 'Acquiring Minds', 'The Bootstrapped Founder'];
const chosen = [];
for (const slot of F.slots.map((s) => s.id)) {
  for (const w of want) { const s = segs.find((x) => x.slot === slot && x.show === w && !chosen.includes(x)); if (s) chosen.push(s); }
}
const run = chosen.slice(0, 9);
// narration is prototype copy (the repo's capital foray is un-narrated); one bridge between show changes
const BRIDGES = [
  'Same question, now from a founder who never raised.',
  'Back to the venture side, and what the paperwork costs.',
  'And the other chair: no investors at all.',
  'Now the finance view: what a lender actually prices.',
  'Last, a buyer looks at the same money.',
];
const items = []; let b = 0;
run.forEach((s, i) => {
  if (i > 0 && run[i - 1].show !== s.show && b < BRIDGES.length) items.push({ type: 'narration', dur: 22, script: BRIDGES[b++] });
  items.push({ type: 'segment', ...s });
});
const foray = {
  id: F.id, title: F.title, subject: 'Building companies',
  why: 'Four chairs, one question: founder, finance lead, buyer, bootstrapper.',
  narrated: true, items,
};
// three more forays for the Library grid (bars only: show, seconds): two real ones with one and two shows, and a
// three-show one cut from the real seven-show capital foray (the three shows that have artwork), so round 3 can see every collage case
const lite = ['how-ai-actually-gets-built-3b83e1', 'beyond-the-algorithm-engineering-production-ai-s-e6533b', 'capital-types-1'].map((id) => {
  const f = rd('data/forays.json').forays.find((x) => x.id === id);
  let keep = null;
  if (id === 'capital-types-1') keep = ['Y Combinator Startup Podcast', 'Run the Numbers', 'Acquiring Minds'];
  const bars = f.items.map((i) => {
    if (i.type === 'narration') return { s: null, d: Math.round(i.script.split(/\s+/).length / 2.6) };
    const g = S[i.segment_id]; return { s: SRC[g.item_id].show, d: Math.round(g.end_sec - g.start_sec) };
  }).filter((b) => !keep || !b.s || keep.includes(b.s));
  const shows = [...new Set(bars.filter((b) => b.s).map((b) => b.s))].map((n) => ({ show: n, art: artFor(n) }));
  return { id, title: id === 'capital-types-1' ? 'Three chairs at the table' : f.title, shows, bars, mins: Math.round(bars.reduce((a, b) => a + b.d, 0) / 60) };
});
fs.writeFileSync(out, JSON.stringify({ built_from: 'data/discover.json, data/forays.json, data/segments.json', episodes, subjects, foray, forays_lite: lite }, null, 1));
console.log(episodes.length, 'episodes;', items.length, 'foray items;', [...new Set(items.filter((x) => x.type === 'segment').map((x) => x.show + (x.art ? '' : ' (no art)')))]);
