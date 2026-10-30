#!/usr/bin/env node
/**
 * Industry BOM Registry — industry ranking builder
 *
 * Reads the machine-readable score block from every entry page and writes:
 *   industry-ranking.json     (machine-readable, ranked)
 *   views/industries-ranked.html  (the ranked view)
 *
 *   node tools/build-industry-ranking.mjs
 *
 * Growth-led composite, fixed anchors so scores do not drift as entries are added:
 *   growth 50% · capex 20% · R&D 15% · cyclicity 15% (inverted)
 *   growth 0%→0, 25%+→1 linear · 1–5 fields → (x−1)/4 · cyclicity → (5−x)/4
 *
 * A null field is EXCLUDED (never imputed) and the page is marked partial.
 * Never guess a value to complete a score.
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = 'industries';
const OUT_JSON = 'industry-ranking.json';
const OUT_VIEW = 'views/industries-ranked.html';

const DEFAULTS = {
  weights: { growth: 0.50, capex: 0.20, rd: 0.15, cyclicity: 0.15 },
  anchors: { growth_max_pct: 25, capex_max_pct: 30, rd_max_pct: 10 },
  directions: { capex: 'barrier', cyclicity: 'inverted' },
  coverage_threshold: null,
};

let P = DEFAULTS;
if (fs.existsSync('ranking.config.json')) {
  try {
    const raw = JSON.parse(fs.readFileSync('ranking.config.json', 'utf8'));
    P = {
      weights: { ...DEFAULTS.weights, ...(raw.weights || {}) },
      anchors: { ...DEFAULTS.anchors, ...(raw.anchors || {}) },
      directions: { ...DEFAULTS.directions, ...(raw.directions || {}) },
      coverage_threshold: raw.coverage_threshold ?? null,
    };
  } catch (e) {
    console.log('WARN ranking.config.json is not valid JSON — using defaults: ' + e.message);
  }
}

const W = P.weights;
const sumW = Object.values(W).reduce((a, b) => a + b, 0);
if (Math.abs(sumW - 1) > 0.01) console.log(`WARN weights sum to ${sumW.toFixed(2)}, not 1.00 — the composite renormalises, so it still works, but the weights no longer read as shares.`);

const clamp01 = x => Math.max(0, Math.min(1, x));
const sGrowth = v => (v == null || isNaN(v) ? null : clamp01(Number(v) / P.anchors.growth_max_pct));
const sBand = v => (v == null || isNaN(v) ? null : clamp01((Number(v) - 1) / 4));
const sCyc = v => (v == null || isNaN(v) ? null : clamp01((5 - Number(v)) / 4));
// ratios are preferred; the 1–5 rating is the fallback
const sCapexPctRaw = v => (v == null || isNaN(v) ? null : clamp01(Number(v) / P.anchors.capex_max_pct));
const sRdPct = v => (v == null || isNaN(v) ? null : clamp01(Number(v) / P.anchors.rd_max_pct));
// capex reads as a moat by default ("barrier"); "drag" inverts it so heavy capital scores lower
const sCapexPct = v => {
  const x = sCapexPctRaw(v);
  return x == null ? null : (P.directions.capex === 'drag' ? 1 - x : x);
};
const sBandDir = (v, field) => {
  const x = sBand(v);
  return x == null ? null : (P.directions[field] === 'drag' ? 1 - x : x);
};

const clean = s => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function titleOf(html, slug) {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  return m ? clean(m[1].replace(/&amp;/g, '&').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')) : slug;
}

function groupOf(slug) {
  if (!fs.existsSync('index.html')) return '';
  const idx = fs.readFileSync('index.html', 'utf8');
  for (const g of idx.matchAll(/<span class="group__name">([\s\S]*?)<\/span>([\s\S]*?)(?=<span class="group__name">|<\/section>)/g)) {
    if (g[2].includes(`industries/${slug}.html`)) return clean(g[1].replace(/&amp;/g, '&'));
  }
  return '';
}

const rows = [];
const problems = [];

for (const f of fs.readdirSync(DIR).filter(x => x.endsWith('.html')).sort()) {
  const slug = f.replace('.html', '');
  const html = fs.readFileSync(path.join(DIR, f), 'utf8');
  const m = html.match(/<script type="application\/json" class="industry-score">([\s\S]*?)<\/script>/);

  let score = null;
  if (m) {
    try { score = JSON.parse(m[1]); }
    catch (e) { problems.push(`${slug}: score block is not valid JSON — ${e.message}`); }
  }

  const title = titleOf(html, slug);
  const group = groupOf(slug);

  if (!score) {
    rows.push({ slug, title, group, scored: false, composite: null, coverage: 0 });
    continue;
  }

  const capexScore = sCapexPct(score.capex_pct) ?? sBandDir(score.capex_intensity, 'capex');
  const rdScore = sRdPct(score.rd_pct) ?? sBand(score.rd_intensity);

  const parts = [
    { key: 'growth', w: W.growth, s: sGrowth(score.growth_pct) },
    { key: 'capex', w: W.capex, s: capexScore },
    { key: 'rd', w: W.rd, s: rdScore },
    { key: 'cyclicity', w: W.cyclicity, s: sCyc(score.cyclicity) },
  ].filter(p => p.s != null);

  const wSum = parts.reduce((a, p) => a + p.w, 0);
  const composite = wSum ? parts.reduce((a, p) => a + p.w * p.s, 0) / wSum : null;

  rows.push({
    slug, title, group,
    scored: true,
    growth_pct: score.growth_pct ?? null,
    growth_basis: score.growth_basis || '',
    capex_pct: score.capex_pct ?? null,
    capex_intensity: score.capex_intensity ?? null,
    capex_basis: score.capex_pct != null ? 'ratio' : (score.capex_intensity != null ? 'rating' : null),
    rd_pct: score.rd_pct ?? null,
    rd_intensity: score.rd_intensity ?? null,
    rd_basis: score.rd_pct != null ? 'ratio' : (score.rd_intensity != null ? 'rating' : null),
    cyclicity: score.cyclicity ?? null,
    basis: score.basis || '',
    as_of: score.as_of || '',
    fields_present: parts.map(p => p.key),
    composite: composite == null ? null : Math.round(composite * 1000) / 1000,
    coverage: Math.round(wSum * 100) / 100,
    coverage_pct: Math.round(wSum * 100),
    partial: wSum < 0.999,
  });
}

// group by coverage band: only like-for-like pages are compared
const TH = P.coverage_threshold == null ? 0 : Number(P.coverage_threshold);
const bands = new Map();
for (const r of rows) {
  let key;
  if (r.composite == null) key = 'unscored';
  else if (r.coverage < TH) key = 'below';      // scored, but on too little evidence to be ranked
  else key = r.coverage_pct;
  if (!bands.has(key)) bands.set(key, []);
  bands.get(key).push(r);
}
const isTail = k => k === 'unscored' || k === 'below';
const bandOrder = [...bands.keys()].sort((a, b) =>
  isTail(a) && isTail(b) ? (a === 'below' ? -1 : 1) : isTail(a) ? 1 : isTail(b) ? -1 : b - a);

const outBands = [];
for (const key of bandOrder) {
  const group = bands.get(key);
  group.sort((a, b) => (b.composite ?? -1) - (a.composite ?? -1) || a.title.localeCompare(b.title));
  const tail = isTail(key);
  group.forEach((r, i) => { r.rank = tail ? null : i + 1; });
  outBands.push({
    coverage_pct: tail ? null : key,
    label: key === 'unscored' ? 'Not yet scored'
      : key === 'below' ? `Below the ${Math.round(TH * 100)}% coverage threshold — not ranked`
      : `${key}% coverage`,
    fields: key === 'unscored' ? [] : group[0].fields_present,
    ranked: !tail,
    count: group.length,
    rows: group,
  });
}
rows.length = 0;
for (const b of outBands) rows.push(...b.rows);

const out = {
  registry: 'Industry BOM Registry',
  description:
    'Industry ranking. Growth-led composite over growth, capex intensity, R&D intensity and cyclicity, read from each entry page\'s industry-score block. DERIVED — regenerate with node tools/build-industry-ranking.mjs.',
  generated: new Date().toISOString().slice(0, 10),
  parameters: P,
  anchors: {
    growth: `0%→0, ${P.anchors.growth_max_pct}%+→1 linear`,
    capex_pct: `0%→0, ${P.anchors.capex_max_pct}%+→1 (${P.directions.capex === 'drag' ? 'heavier capital scores lower' : 'barrier reading, heavier scores higher'})`,
    rd_pct: `0%→0, ${P.anchors.rd_max_pct}%+→1`,
    bands: '1–5 → (x−1)/4',
    cyclicity: '1–5 → (5−x)/4 (inverted)',
  },
  counts: {
    industries: rows.length,
    scored: rows.filter(r => r.scored).length,
    partial: rows.filter(r => r.partial).length,
    unscored: rows.filter(r => !r.scored).length,
    below_threshold: rows.filter(r => r.composite != null && r.coverage < TH).length,
    ranked: rows.filter(r => r.rank != null).length,
  },
  bands: outBands.map(b => ({ label: b.label, fields: b.fields, count: b.count, ranked: b.ranked })),
  industries: rows,
};
fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 1) + '\n');

// ---------------- ranked view ----------------
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const FIELD_LABEL = { growth: 'growth', capex: 'capex', rd: 'R&D', cyclicity: 'cyclicity' };

function rowHtml(r) {
  const bar = r.composite == null ? '' :
    `<span class="scorebar"><span style="width:${Math.round(r.composite * 100)}%"></span></span>`;
  return `<tr>
<td class="c">${r.rank ?? '—'}</td>
<td><b>${esc(r.title)}</b><div class="slug">${esc(r.group || '')}</div></td>
<td class="c">${r.growth_pct == null ? '<span class="dim">—</span>' : esc(r.growth_pct) + '%'}</td>
<td class="c">${r.capex_pct != null ? esc(r.capex_pct) + '%' : (r.capex_intensity == null ? '<span class="dim">—</span>' : esc(r.capex_intensity) + '<span class="dim">/5</span>')}</td>
<td class="c">${r.rd_pct != null ? esc(r.rd_pct) + '%' : (r.rd_intensity == null ? '<span class="dim">—</span>' : esc(r.rd_intensity) + '<span class="dim">/5</span>')}</td>
<td class="c">${r.cyclicity == null ? '<span class="dim">—</span>' : esc(r.cyclicity)}</td>
<td class="c">${r.composite == null ? '<span class="dim">—</span>' : r.composite.toFixed(3)}${bar}</td>
</tr>`;
}

let n = 0;
const sections = outBands.map(b => {
  n += 1;
  const fieldList = b.fields.length ? b.fields.map(f => FIELD_LABEL[f] || f).join(' · ') : 'no score block yet';
  const note = b.coverage_pct == null
    ? `${b.count} industries · ${fieldList}`
    : `${b.count} ${b.count === 1 ? 'industry' : 'industries'} · scored on ${fieldList}`;
  return `<div class="sec-head"><span class="sec-num">${String(n).padStart(2, '0')}</span>
<span class="sec-title">${esc(b.label)}</span><span class="sec-note">${esc(note)}</span></div>
<div class="table-wrap"><div class="table-scroll"><table class="data">
<thead><tr><th>#</th><th>Industry</th><th>Growth</th><th>Capex / rev</th><th>R&amp;D / rev</th><th>Cyclicity</th><th>Score</th></tr></thead>
<tbody>
${b.rows.map(rowHtml).join('\n')}
</tbody></table></div></div>`;
}).join('\n\n');

const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Industries ranked — Industry BOM Registry</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../assets/registry.css">
<style>
/* page-specific layout only */
.dim { color: var(--text-dim); opacity: .6; }
.slug { font-family: var(--font-mono); font-size: 10px; color: var(--text-dim); margin-top: 2px; }
.scorebar { display: inline-block; width: 54px; height: 5px; background: var(--surface-recessed); border-radius: 3px; margin-left: 8px; vertical-align: middle; }
.scorebar > span { display: block; height: 100%; background: var(--gold); border-radius: 3px; }
.table-scroll { overflow: auto; max-height: 60vh; }
</style></head><body><div class="container">
<header class="masthead">
  <div class="eyebrow">Industry BOM Registry &middot; derived view</div>
  <h1>Industries <span>ranked</span></h1>
  <div class="subtitle">${out.counts.scored} scored across ${outBands.filter(b => b.coverage_pct != null).length} coverage bands &middot; ${out.counts.unscored} not yet scored &middot; growth-led composite</div>
</header>

<div class="metric-cards">
  <div class="metric-card"><div class="metric-card__val">${out.counts.industries}</div><div class="metric-card__label">Industries</div><div class="metric-card__sub">in the registry</div></div>
  <div class="metric-card metric-card--gold"><div class="metric-card__val">${out.counts.scored}</div><div class="metric-card__label">Scored</div><div class="metric-card__sub">have a score block</div></div>
  <div class="metric-card"><div class="metric-card__val">${out.counts.partial}</div><div class="metric-card__label">Partial</div><div class="metric-card__sub">missing one or more fields</div></div>
  <div class="metric-card"><div class="metric-card__val">${out.counts.unscored}</div><div class="metric-card__label">Not yet scored</div><div class="metric-card__sub">backfill pending</div></div>
</div>

<p class="lead">Each coverage band is ranked <b>separately</b>. A page carrying only some of the four fields is never compared against a fully scored one &mdash; its score reflects only what is known, so mixing them in a single table would rank evidence rather than industries.</p>

${sections}

<div class="footnote">
  <b>Parameters in force</b> (${'ranking.config.json'}): ${Math.round(W.growth*100)}% growth &middot; ${Math.round(W.capex*100)}% capex &middot; ${Math.round(W.rd*100)}% R&amp;D &middot; ${Math.round(W.cyclicity*100)}% cyclicity, over the fields a page actually carries, then renormalised by their weight.
  Anchors: growth 0%&rarr;0 and ${P.anchors.growth_max_pct}%+&rarr;1; capex/revenue 0%&rarr;0 and ${P.anchors.capex_max_pct}%+&rarr;1 (${P.directions.capex === 'drag' ? 'read as a capital drag &mdash; heavier scores lower' : 'barrier reading &mdash; heavier scores higher'}); R&amp;D/revenue 0%&rarr;0 and ${P.anchors.rd_max_pct}%+&rarr;1; the 1&ndash;5 ratings &rarr; (x&minus;1)/4; cyclicity inverted (5&minus;x)/4.
  Where both a ratio and a rating exist the ratio is used. A missing field is excluded, never imputed.
  Values come from each entry page&rsquo;s own score block; every figure keeps its label. Generated ${out.generated}.
</div>
</div></body></html>`;

fs.mkdirSync('views', { recursive: true });
fs.writeFileSync(OUT_VIEW, html);

console.log(`industry-ranking.json — ${out.counts.scored} scored (${out.counts.partial} partial), ${out.counts.unscored} unscored of ${out.counts.industries}`);
console.log('bands: ' + outBands.map(b => `${b.label} (${b.count})`).join(' · '));
if (problems.length) console.log('WARN:\n  ' + problems.join('\n  '));
