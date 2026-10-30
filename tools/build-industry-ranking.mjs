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

const W = { growth: 0.50, capex: 0.20, rd: 0.15, cyclicity: 0.15 };

const clamp01 = x => Math.max(0, Math.min(1, x));
const sGrowth = v => (v == null || isNaN(v) ? null : clamp01(Number(v) / 25));
const sBand = v => (v == null || isNaN(v) ? null : clamp01((Number(v) - 1) / 4));
const sCyc = v => (v == null || isNaN(v) ? null : clamp01((5 - Number(v)) / 4));
// ratios are preferred; the 1–5 rating is the fallback
const sCapexPct = v => (v == null || isNaN(v) ? null : clamp01(Number(v) / 30));   // 0%→0, 30%+→1
const sRdPct = v => (v == null || isNaN(v) ? null : clamp01(Number(v) / 10));       // 0%→0, 10%+→1

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

  const capexScore = sCapexPct(score.capex_pct) ?? sBand(score.capex_intensity);
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
    composite: composite == null ? null : Math.round(composite * 1000) / 1000,
    coverage: Math.round(wSum * 100) / 100,
    partial: wSum < 0.999,
  });
}

rows.sort((a, b) => {
  if (a.composite == null && b.composite == null) return a.title.localeCompare(b.title);
  if (a.composite == null) return 1;
  if (b.composite == null) return -1;
  return b.composite - a.composite || a.title.localeCompare(b.title);
});
rows.forEach((r, i) => { r.rank = r.composite == null ? null : i + 1; });

const out = {
  registry: 'Industry BOM Registry',
  description:
    'Industry ranking. Growth-led composite over growth, capex intensity, R&D intensity and cyclicity, read from each entry page\'s industry-score block. DERIVED — regenerate with node tools/build-industry-ranking.mjs.',
  generated: new Date().toISOString().slice(0, 10),
  weights: W,
  anchors: { growth: '0%→0, 25%+→1 linear', bands: '1–5 → (x−1)/4', cyclicity: '1–5 → (5−x)/4 (inverted)' },
  counts: {
    industries: rows.length,
    scored: rows.filter(r => r.scored).length,
    partial: rows.filter(r => r.partial).length,
    unscored: rows.filter(r => !r.scored).length,
  },
  industries: rows,
};
fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 1) + '\n');

// ---------------- ranked view ----------------
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = v => (v == null || v === '' ? '<span class="dim">—</span>' : esc(v));

const trs = rows.map(r => {
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
<td class="c">${r.composite == null ? '<span class="chip">not scored</span>' : (r.partial ? `<span class="chip">partial ${Math.round(r.coverage * 100)}%</span>` : '<span class="chip chip--gold">full</span>')}</td>
</tr>`;
}).join('\n');

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
.table-scroll { overflow: auto; max-height: 70vh; }
</style></head><body><div class="container">
<header class="masthead">
  <div class="eyebrow">Industry BOM Registry &middot; derived view</div>
  <h1>Industries <span>ranked</span></h1>
  <div class="subtitle">${out.counts.scored} scored &middot; ${out.counts.partial} partial &middot; ${out.counts.unscored} not yet scored &middot; growth-led composite</div>
</header>

<div class="metric-cards">
  <div class="metric-card"><div class="metric-card__val">${out.counts.industries}</div><div class="metric-card__label">Industries</div><div class="metric-card__sub">in the registry</div></div>
  <div class="metric-card metric-card--gold"><div class="metric-card__val">${out.counts.scored}</div><div class="metric-card__label">Scored</div><div class="metric-card__sub">have a score block</div></div>
  <div class="metric-card"><div class="metric-card__val">${out.counts.partial}</div><div class="metric-card__label">Partial</div><div class="metric-card__sub">missing one or more fields</div></div>
  <div class="metric-card"><div class="metric-card__val">${out.counts.unscored}</div><div class="metric-card__label">Not yet scored</div><div class="metric-card__sub">backfill pending</div></div>
</div>

<div class="sec-head"><span class="sec-num">01</span><span class="sec-title">Ranked on the growth-led composite</span>
<span class="sec-note">growth 50% &middot; capex 20% &middot; R&amp;D 15% &middot; cyclicity 15% (inverted)</span></div>

<div class="table-wrap"><div class="table-scroll"><table class="data">
<thead><tr><th>#</th><th>Industry</th><th>Growth</th><th>Capex / rev</th><th>R&amp;D / rev</th><th>Cyclicity</th><th>Score</th><th>Coverage</th></tr></thead>
<tbody>
${trs}
</tbody></table></div></div>

<div class="footnote">
  Score = 0.50&middot;growth + 0.20&middot;capex + 0.15&middot;R&amp;D + 0.15&middot;cyclicity, over the fields a page actually carries.
  Growth is normalised 0%&rarr;0, 25%+&rarr;1; capex and R&amp;D are 1&ndash;5 &rarr; (x&minus;1)/4; cyclicity is inverted (5&minus;x)/4, so steadier industries score higher.
  A missing field is excluded, never imputed &mdash; pages carrying only some fields are marked <b>partial</b> and their score reflects only what is known.
  Values come from each entry page&rsquo;s own score block; every figure keeps its label. Generated ${out.generated}.
</div>
</div></body></html>`;

fs.mkdirSync('views', { recursive: true });
fs.writeFileSync(OUT_VIEW, html);

console.log(`industry-ranking.json — ${out.counts.scored} scored (${out.counts.partial} partial), ${out.counts.unscored} unscored of ${out.counts.industries}`);
if (problems.length) console.log('WARN:\n  ' + problems.join('\n  '));
