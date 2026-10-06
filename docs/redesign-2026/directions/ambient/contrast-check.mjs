// Contrast check for the Afterglow palette (docs/redesign-2026/directions/ambient).
// Run: node docs/redesign-2026/directions/ambient/contrast-check.mjs
// Prints the WCAG 2.x contrast ratio of every text/background pair the direction
// relies on. AA: 4.5 for text under 24px, 3.0 for larger text and UI parts.
const lum = (hex) => {
  const c = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(c.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const pairs = [
  // Dusk (dark scheme)
  ['text', '#F5EEE4', 'bg0', '#14110F'],
  ['text-2', '#B9AFA3', 'bg0', '#14110F'],
  ['text-3', '#9A9188', 'bg0', '#14110F'],
  ['ember', '#F0A64B', 'bg0', '#14110F'],
  ['lamp', '#F3E7D3', 'bg0', '#14110F'],
  ['text', '#F5EEE4', 'bg1', '#1D1916'],
  ['text-2', '#B9AFA3', 'bg1', '#1D1916'],
  ['text-3', '#9A9188', 'bg1', '#1D1916'],
  ['ember', '#F0A64B', 'bg1', '#1D1916'],
  ['text', '#F5EEE4', 'bg2', '#272220'],
  ['text-2', '#B9AFA3', 'bg2', '#272220'],
  ['text-3', '#9A9188', 'bg2', '#272220'],
  ['bg0 (ink on ember button)', '#14110F', 'ember', '#F0A64B'],
  ['bg0 (ink on lamp button)', '#14110F', 'lamp', '#F3E7D3'],
  ['text on darkest allowed glow tint', '#F5EEE4', 'glow-tint-max', '#4A3A33'],
  // Dawn (light scheme)
  ['ink', '#1E1A17', 'paper0', '#F7F2EB'],
  ['ink-2', '#5E564E', 'paper0', '#F7F2EB'],
  ['ink-3', '#6B635A', 'paper0', '#F7F2EB'],
  ['ember-dawn', '#8E520E', 'paper0', '#F7F2EB'],
  ['ink', '#1E1A17', 'paper2', '#EFE8DF'],
  ['ink-2', '#5E564E', 'paper2', '#EFE8DF'],
  ['ink-3', '#6B635A', 'paper2', '#EFE8DF'],
  ['ember-dawn', '#8E520E', 'paper2', '#EFE8DF'],
  ['white on ember-dawn button', '#FFFFFF', 'ember-dawn', '#8E520E'],
  ['ink on lightest allowed glow tint', '#1E1A17', 'glow-tint-max', '#D9C7B8'],
];
let fail = 0;
for (const [fn, f, bn, b] of pairs) {
  const r = ratio(f, b);
  const ok = r >= 4.5;
  if (!ok) fail++;
  console.log(`${ok ? 'AA  ' : 'FAIL'} ${r.toFixed(2).padStart(6)}  ${fn} ${f} on ${bn} ${b}`);
}
console.log(fail ? `${fail} pair(s) below 4.5` : 'all pairs >= 4.5');
