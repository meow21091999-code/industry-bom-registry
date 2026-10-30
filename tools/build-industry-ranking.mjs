#!/usr/bin/env node
/**
 * Industry BOM Registry — industry ranking builder
 *
 * Implements the scoring architecture in
 * "Industry-Level Investment Parameters & Scoring Architecture":
 *
 *   Category score (1–5)   = Σ(parameter weight × parameter score) ÷ Σ(weights of supported parameters)
 *   Overall score (0–100)  = Σ(category weight × category score ÷ 5)
 *   Evidence coverage (%)  = supported weight ÷ planned weight × 100
 *
 * Rules carried from the framework:
 *   • hierarchical, never a flat average across parameters
 *   • higher is better on every score — direction is normalised at scoring time
 *   • missing values are UNAVAILABLE, never imputed
 *   • coverage is reported alongside the score and is NOT a bonus or penalty
 *   • structural / current-opportunity / risk-adjusted are kept as separate lenses
 *
 * Reads:  ranking.config.json, industries/*.html (industry-score blocks)
 * Writes: industry-ranking.json, views/industries-ranked.html
 *
 *   node tools/build-industry-ranking.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = 'industries';
const OUT_JSON = 'industry-ranking.json';
const OUT_VIEW = 'views/industries-ranked.html';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// ---------------- parameters ----------------
const DEFAULTS = {
  categories: [
    { id: 'economics', name: 'Industry economics & value creation', weight: 0.20, lens: 'structural' },
    { id: 'opportunity', name: 'Market opportunity & structural growth', weight: 0.15, lens: 'structural' },
    { id: 'competitive', name: 'Competitive structure & moat', weight: 0.15, lens: 'structural' },
    { id: 'cycle', name: 'Current opportunity & cycle position', weight: 0.15, lens: 'current' },
    { id: 'valuation', name: 'Valuation & market expectations', weight: 0.15, lens: 'current' },
    { id: 'value_chain', name: 'Value-chain position & bottlenecks', weight: 0.10, lens: 'structural' },
    { id: 'capital', name: 'Capital intensity & financial quality', weight: 0.05, lens: 'structural' },
    { id: 'technology', name: 'Technology & innovation', weight: 0.05, lens: 'structural' },
  ],
  risk_category: { id: 'risk', name: 'Risk & resilience', lens: 'risk' },
  scale: {},
  provisional_below_coverage_pct: 60,
};

let P = DEFAULTS;
if (fs.existsSync('ranking.config.json')) {
  try {
    const raw = JSON.parse(fs.readFileSync('ranking.config.json', 'utf8'));
    P = { ...DEFAULTS, ...raw };
  } catch (e) {
    console.log('WARN ranking.config.json is not valid JSON — using defaults: ' + e.message);
  }
}

const CATS = P.categories;
const RISK = P.risk_category;
const WSUM = CATS.reduce((a, c) => a + c.weight, 0);
if (Math.abs(WSUM - 1) > 0.01) console.log(`WARN category weights sum to ${WSUM.toFixed(2)}, not 1.00.`);

const clean = s => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function titleOf(html, slug) {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  return m ? clean(m[1].replace(/&amp;/g, '&').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')) : slug;
}

let INDEX = '';
if (fs.existsSync('index.html')) INDEX = fs.readFileSync('index.html', 'utf8');
function groupOf(slug) {
  for (const g of INDEX.matchAll(/<span class="group__name">([\s\S]*?)<\/span>([\s\S]*?)(?=<span class="group__name">|<\/section>)/g)) {
    if (g[2].includes(`industries/${slug}.html`)) return clean(g[1].replace(/&amp;/g, '&'));
  }
  return '';
}

/** category score from parameters, else the stated score */
function categoryScore(cat) {
  const params = (cat.params || []).filter(p => p && p.score != null && !isNaN(p.score));
  if (params.length) {
    const ws = params.reduce((a, p) => a + (p.weight == null ? 1 : p.weight), 0);
    const s = params.reduce((a, p) => a + (p.weight == null ? 1 : p.weight) * Number(p.score), 0) / ws;
    return { score: clamp(s, 1, 5), from: 'parameters' };
  }
  if (cat.score != null && !isNaN(cat.score)) return { score: clamp(Number(cat.score), 1, 5), from: 'category' };
  return { score: null, from: null };
}

const rows = [];
const problems = [];

for (const f of fs.readdirSync(DIR).filter(x => x.endsWith('.html')).sort()) {
  const slug = f.replace('.html', '');
  const html = fs.readFileSync(path.join(DIR, f), 'utf8');
  const m = html.match(/<script type="application\/json" class="industry-score">([\s\S]*?)<\/script>/);

  const title = titleOf(html, slug);
  const group = groupOf(slug);
  const row = { slug, title, group };

  if (!m) { rows.push({ ...row, scored: false }); continue; }

  let block;
  try { block = JSON.parse(m[1]); }
  catch (e) { problems.push(`${slug}: score block is not valid JSON — ${e.message}`); rows.push({ ...row, scored: false }); continue; }

  // legacy 4-field block: keep it visible, but it does not fit the framework
  if (!block.categories) {
    rows.push({ ...row, scored: false, legacy: true, legacy_block: block });
    problems.push(`${slug}: legacy score block (growth/capex/R&D/cyclicity) — needs rescoring under the category framework`);
    continue;
  }

  const cats = {};
  let supportedW = 0;
  for (const c of CATS) {
    const got = categoryScore(block.categories[c.id] || {});
    cats[c.id] = { name: c.name, weight: c.weight, lens: c.lens, score: got.score, from: got.from,
      basis: (block.categories[c.id] || {}).basis || '' };
    if (got.score != null) supportedW += c.weight;
  }
  const riskGot = categoryScore(block.categories[RISK.id] || {});
  cats[RISK.id] = { name: RISK.name, weight: null, lens: 'risk', score: riskGot.score, from: riskGot.from,
    basis: (block.categories[RISK.id] || {}).basis || '' };

  // weighted score over a lens, renormalised by the weight actually supported
  const lens = which => {
    const set = CATS.filter(c => c.lens === which && cats[c.id].score != null);
    const w = set.reduce((a, c) => a + c.weight, 0);
    if (!w) return null;
    const s = set.reduce((a, c) => a + c.weight * cats[c.id].score, 0) / w;
    return { score: Math.round((s / 5) * 1000) / 10, coverage: Math.round((w / (which === 'structural'
      ? CATS.filter(c => c.lens === 'structural').reduce((a, c) => a + c.weight, 0)
      : CATS.filter(c => c.lens === 'current').reduce((a, c) => a + c.weight, 0))) * 100) };
  };

  const structural = lens('structural');
  const current = lens('current');
  const risk = cats[RISK.id].score;

  // overall = the framework's formula over every supported category, coverage-neutral
  const supported = CATS.filter(c => cats[c.id].score != null);
  const overall = supported.length
    ? Math.round((supported.reduce((a, c) => a + c.weight * cats[c.id].score, 0) / supported.reduce((a, c) => a + c.weight, 0) / 5) * 1000) / 10
    : null;

  // risk-adjusted: structural discounted by risk — a stated design choice, not from the framework
  const riskAdjusted = structural && risk != null
    ? Math.round((structural.score * (risk / 5)) * 10) / 10
    : null;

  const coverage = Math.round(supportedW * 100);
  rows.push({
    ...row, scored: true,
    as_of: block.as_of || '',
    categories: cats,
    structural, current, risk, risk_adjusted: riskAdjusted,
    overall, coverage,
    provisional: coverage < (P.provisional_below_coverage_pct ?? 60),
    notes: block.notes || '',
  });
}

// ---------------- ranks ----------------
const rankBy = (arr, key) => {
  const scored = arr.filter(r => r[key] != null).sort((a, b) => b[key] - a[key] || a.title.localeCompare(b.title));
  scored.forEach((r, i) => { r[key + '_rank'] = i + 1; });
};
rankBy(rows, 'overall');
rankBy(rows, 'structural_score');
rankBy(rows, 'current_score');
rankBy(rows, 'risk_adjusted');
// structural/current live inside objects — flatten for ranking and display
for (const r of rows) {
  if (r.structural) r.structural_score = r.structural.score;
  if (r.current) r.current_score = r.current.score;
}
rankBy(rows, 'structural_score');
rankBy(rows, 'current_score');
rankBy(rows, 'overall');

const out = {
  registry: 'Industry BOM Registry',
  description: 'Industry ranking per "Industry-Level Investment Parameters & Scoring Architecture": hierarchical category scores (1–5), overall 0–100, evidence coverage reported, three lenses kept separate. DERIVED — regenerate with node tools/build-industry-ranking.mjs.',
  generated: new Date().toISOString().slice(0, 10),
  framework: {
    category_score: 'Σ(parameter weight × parameter score) ÷ Σ(weights of supported parameters)',
    overall_score: 'Σ(category weight × category score ÷ 5) × 100, renormalised over supported categories',
    coverage: 'supported category weight ÷ planned weight × 100',
    scale: P.scale,
    provisional_below_coverage_pct: P.provisional_below_coverage_pct,
  },
  parameters: { categories: CATS, risk_category: RISK },
  counts: {
    industries: rows.length,
    scored: rows.filter(r => r.scored).length,
    legacy: rows.filter(r => r.legacy).length,
    unscored: rows.filter(r => !r.scored).length,
    ranked: rows.filter(r => r.overall != null).length,
  },
  industries: rows,
};
fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 1) + '\n');

// ---------------- view ----------------
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (v, d = 1) => (v == null ? '<span class="dim">—</span>' : v.toFixed(d));

const ranked = rows.filter(r => r.overall != null).sort((a, b) => b.overall - a.overall);
const structuralRanked = rows.filter(r => r.structural_score != null).sort((a, b) => b.structural_score - a.structural_score);
const currentRanked = rows.filter(r => r.current_score != null).sort((a, b) => b.current_score - a.current_score);
const riskRanked = rows.filter(r => r.risk_adjusted != null).sort((a, b) => b.risk_adjusted - a.risk_adjusted);
const unscored = rows.filter(r => r.overall == null);

const table = (list, cols) => `<div class="table-wrap"><div class="table-scroll"><table class="data">
<thead><tr><th>#</th><th>Industry</th>${cols.map(c => `<th>${c.h}</th>`).join('')}</tr></thead>
<tbody>
${list.map((r, i) => `<tr>
<td class="c">${i + 1}</td>
<td><b>${esc(r.title)}</b><div class="slug">${esc(r.group || '')}</div></td>
${cols.map(c => `<td class="c">${c.f(r)}</td>`).join('')}
</tr>`).join('\n')}
</tbody></table></div></div>`;

const covCell = r => `${r.coverage}%${r.provisional ? '<span class="scale c4">provisional</span>' : ''}`;

const STRUCT_COLS = CATS.filter(c => c.lens === 'structural');
const CURRENT_COLS = CATS.filter(c => c.lens === 'current');
const sc = v => (v == null ? '<span class="dim">-</span>' : String(v));

function detailedTable(list) {
  // each lens heading spans its own parameters AND that lens's score, so the total sits inside its group
  const head1 = `<tr>
    <th rowspan="2">#</th>
    <th rowspan="2">Industry</th>
    <th colspan="${STRUCT_COLS.length + 1}" class="grp grp-struct">Structural attractiveness</th>
    <th colspan="${CURRENT_COLS.length + 1}" class="grp grp-current">Current opportunity</th>
    <th rowspan="2" class="grp-start">Risk</th>
    <th rowspan="2">Risk-adj</th>
    <th rowspan="2">Overall</th>
    <th rowspan="2">Coverage</th>
  </tr>
  <tr>
    ${STRUCT_COLS.map(c => `<th class="cat">${c.id}<div class="wt">${Math.round(c.weight * 100)}%</div></th>`).join('')}
    <th class="cat cat-tot grp-struct">structural score</th>
    ${CURRENT_COLS.map((c, j) => `<th class="cat${j === 0 ? ' grp-start' : ''}">${c.id}<div class="wt">${Math.round(c.weight * 100)}%</div></th>`).join('')}
    <th class="cat cat-tot grp-current">current score</th>
  </tr>`;

  const body = list.map((r, i) => `<tr>
    <td class="c">${i + 1}</td>
    <td><b>${esc(r.title)}</b><div class="slug">${esc(r.group || '')}</div></td>
    ${STRUCT_COLS.map(c => `<td class="c">${sc(r.categories[c.id] ? r.categories[c.id].score : null)}</td>`).join('')}
    <td class="c tot">${num(r.structural_score)}</td>
    ${CURRENT_COLS.map((c, j) => `<td class="c${j === 0 ? ' grp-start' : ''}">${sc(r.categories[c.id] ? r.categories[c.id].score : null)}</td>`).join('')}
    <td class="c tot">${num(r.current_score)}</td>
    <td class="c grp-start">${num(r.risk, 0)}</td>
    <td class="c">${num(r.risk_adjusted)}</td>
    <td class="c tot">${num(r.overall)}</td>
    <td class="c">${covCell(r)}</td>
  </tr>`).join('\n');

  return `<div class="table-wrap"><div class="table-scroll"><table class="data detail">
  <thead>${head1}</thead><tbody>
  ${body}
  </tbody></table></div></div>`;
}

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
.scale { display: inline-block; font-family: var(--font-mono); font-size: 9px; letter-spacing: .3px; margin-left: 5px; padding: 0 5px; border-radius: 3px; border: 1px solid; white-space: nowrap; }
.scale.c1 { color: var(--green); border-color: var(--green); background: var(--green-dim); }
.scale.c2 { color: var(--blue); border-color: var(--blue); background: var(--blue-dim); }
.scale.c3 { color: var(--gold); border-color: var(--gold); background: var(--gold-dim); }
.scale.c4, .scale.c5 { color: var(--high); border-color: var(--high); background: var(--high-dim); }
.table-scroll { overflow: auto; max-height: 60vh; }
.legend-table td { font-size: 11.5px; line-height: 1.45; vertical-align: top; min-width: 130px; }
.legend-table .lvnum { display: inline-block; font-family: var(--font-mono); font-size: 9.5px; font-weight: 700; margin-right: 5px; padding: 0 5px; border-radius: 3px; border: 1px solid currentColor; }
.legend-table .lv1 { color: var(--high); } .legend-table .lv2 { color: var(--gold); }
.legend-table .lv3 { color: var(--blue); } .legend-table .lv4 { color: var(--green); } .legend-table .lv5 { color: var(--green); }
table.data.detail th.grp { text-align: center; font-size: 9.5px; letter-spacing: .8px; border-bottom: 1px solid var(--border-bright); }
table.data.detail th.grp-struct { background: var(--blue-dim); color: var(--blue); }
table.data.detail th.grp-current { background: var(--gold-dim); color: var(--gold); }
table.data.detail th.cat { text-align: center; font-size: 9px; font-weight: 600; }
table.data.detail .wt { font-weight: 400; opacity: .65; font-size: 8.5px; }
table.data.detail th.cat-tot { font-weight: 700; letter-spacing: .4px; border-left: 1px solid var(--border-bright); }
table.data.detail th.cat-tot.grp-struct { background: var(--blue-dim); color: var(--blue); }
table.data.detail th.cat-tot.grp-current { background: var(--gold-dim); color: var(--gold); }
table.data.detail td.tot { font-weight: 700; color: var(--text); }
table.data.detail .grp-start { border-left: 1px solid var(--border-bright); }
/* two header rows cannot both be sticky at top:0 - the shared rule would stack them on
   top of each other. This table's header scrolls with the content instead. */
table.data.detail thead th { position: static; }
table.data.detail td { padding: 6px 7px; }
</style></head><body><div class="container">
<header class="masthead">
  <div class="eyebrow">Industry BOM Registry &middot; derived view</div>
  <h1>Industries <span>ranked</span></h1>
  <div class="subtitle">${out.counts.ranked} ranked &middot; ${out.counts.unscored} not yet scored &middot; hierarchical category scoring, overall 0&ndash;100</div>
</header>

<div class="metric-cards">
  <div class="metric-card"><div class="metric-card__val">${out.counts.industries}</div><div class="metric-card__label">Industries</div><div class="metric-card__sub">in the registry</div></div>
  <div class="metric-card metric-card--gold"><div class="metric-card__val">${out.counts.ranked}</div><div class="metric-card__label">Ranked</div><div class="metric-card__sub">have a category score</div></div>
  <div class="metric-card"><div class="metric-card__val">${out.counts.legacy}</div><div class="metric-card__label">Legacy blocks</div><div class="metric-card__sub">need rescoring</div></div>
  <div class="metric-card"><div class="metric-card__val">${out.counts.unscored}</div><div class="metric-card__label">Not yet scored</div><div class="metric-card__sub">backfill pending</div></div>
</div>

<div class="sec-head"><span class="sec-num">00</span><span class="sec-title">How to read the scores</span>
<span class="sec-note">1 = very unattractive &rarr; 5 = highly attractive, on every parameter</span></div>
<div class="table-wrap"><div class="table-scroll" style="max-height:none"><table class="data legend-table">
<thead><tr><th>Score</th><th>Meaning</th></tr></thead><tbody>
${Object.entries(P.scale || {}).map(([k, v]) => `<tr><td class="c"><span class="lvnum lv${k}">${k}</span></td><td>${esc(v)}</td></tr>`).join('\n')}
</tbody></table></div></div>

<div class="sec-head"><span class="sec-num">01</span><span class="sec-title">Overall industry score</span>
<span class="sec-note">every category score shown, grouped under its lens</span></div>
${detailedTable(ranked)}

<div class="sec-head"><span class="sec-num">02</span><span class="sec-title">Structural attractiveness</span>
<span class="sec-note">durable 5&ndash;10 year economics &middot; opportunity, economics, competitive, value chain, capital, technology</span></div>
${table(structuralRanked, [{ h: 'Structural', f: r => num(r.structural_score) }, { h: 'Coverage', f: r => num(r.structural ? r.structural.coverage : null, 0) + '%' }])}

<div class="sec-head"><span class="sec-num">03</span><span class="sec-title">Current investment opportunity</span>
<span class="sec-note">cycle position and valuation &mdash; a different question from structural quality</span></div>
${table(currentRanked, [{ h: 'Current', f: r => num(r.current_score) }, { h: 'Coverage', f: r => num(r.current ? r.current.coverage : null, 0) + '%' }])}

<div class="sec-head"><span class="sec-num">04</span><span class="sec-title">Risk-adjusted opportunity</span>
<span class="sec-note">structural score &times; (risk &divide; 5) &mdash; our formula, not the framework's</span></div>
${table(riskRanked, [{ h: 'Risk-adj', f: r => num(r.risk_adjusted) }, { h: 'Risk (1–5)', f: r => num(r.risk, 1) }])}

<div class="sec-head"><span class="sec-num">05</span><span class="sec-title">Not yet scored</span>
<span class="sec-note">${unscored.length} industries &mdash; backfill pending</span></div>
<div class="table-wrap"><div class="table-scroll"><table class="data">
<thead><tr><th>Industry</th><th>Status</th></tr></thead><tbody>
${unscored.map(r => `<tr><td><b>${esc(r.title)}</b><div class="slug">${esc(r.group || '')}</div></td><td>${r.legacy ? '<span class="scale c4">legacy block — needs rescoring</span>' : '<span class="dim">no score block</span>'}</td></tr>`).join('\n')}
</tbody></table></div></div>

<div class="footnote">
  <b>Framework</b>: category score = &Sigma;(parameter weight &times; parameter score) &divide; &Sigma;(weights of supported parameters);
  overall = &Sigma;(category weight &times; category score &divide; 5) &times; 100, renormalised over the categories that are actually supported.
  Coverage = supported category weight &divide; planned weight. A missing value is shown as UNAVAILABLE and never imputed &mdash; coverage is reported next to the score and is
  neither a bonus nor a penalty. Scores below ${P.provisional_below_coverage_pct}% coverage are marked provisional.
  Structural, current-opportunity and risk-adjusted are separate lenses: an industry can be structurally excellent and currently expensive.
  Risk-adjusted uses structural &times; (risk &divide; 5), which is our construction, not the framework's.
  Generated ${out.generated}.
</div>
</div></body></html>`;

fs.mkdirSync('views', { recursive: true });
fs.writeFileSync(OUT_VIEW, html);

console.log(`industry-ranking.json — ${out.counts.ranked} ranked, ${out.counts.legacy} legacy, ${out.counts.unscored} unscored of ${out.counts.industries}`);
if (problems.length) console.log('WARN:\n  ' + problems.join('\n  '));
