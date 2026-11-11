#!/usr/bin/env node
/**
 * Industry BOM Registry - company master list view builder
 *
 * Writes views/companies-master-list.html from companies.json. Before this tool
 * existed the view was built ad hoc, so it silently drifted (it still showed
 * 491 companies / 73 industries long after companies.json had moved on).
 * Regenerate it with the same run that regenerates companies.json:
 *
 *   node tools/build-companies.mjs && node tools/build-companies-view.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = 'companies.json';
const OUT = 'views/companies-master-list.html';
const CSS_VERSION = '20261026c';

const d = JSON.parse(readFileSync(SRC, 'utf8'));
const rows = d.companies || [];
const counts = d.counts || {};

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const EXP_ORDER = ['direct', 'indirect', 'conglomerate', 'supplier'];
const EXP_LABEL = { direct: 'Direct player', indirect: 'Indirect', conglomerate: 'Conglomerate', supplier: 'Supplier / upstream' };
const expSort = (a, b) => {
  const ia = EXP_ORDER.indexOf(a), ib = EXP_ORDER.indexOf(b);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
};

// ---- headline figures ------------------------------------------------------
const industries = [...new Set(rows.flatMap((r) => (r.industries || []).map((i) => i.slug)))];
const widest = rows[0];

const STYLE = `<style>
/* Page-specific LAYOUT only — every component comes from assets/registry.css. */
.q { font-family:var(--font-mono); font-size:12px; padding:8px 12px; border:1px solid var(--border); border-radius:7px; background:var(--surface); color:var(--text); min-width:260px; }
.table-scroll { overflow:auto; max-height:640px; }
.tiers .tag { font-size:11px; padding:3px 10px; }
.tiers { padding:12px 16px 16px; display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:14px; }
.tier-list { list-style:none; margin:6px 0 0; padding:0; }
.tier-list li { font-size:13.5px; line-height:1.5; padding:2px 0 2px 12px; position:relative; color:var(--text-dim); }
.tier-list li::before { content:''; position:absolute; left:0; top:9px; width:4px; height:4px; border-radius:50%; background:var(--border-bright); }
.tk { font-family:var(--font-mono); font-size:11px; color:var(--text-dim); }
.nd { font-size:12px; color:var(--text-dim); opacity:.85; }
</style>`;

let out = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Company master list \u2014 Industry BOM Registry</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../assets/registry.css?v=${CSS_VERSION}">
${STYLE}</head><body>
<div style="max-width:1180px;margin:0 auto 18px;font-family:'IBM Plex Mono',monospace;font-size:12px;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;">
  <span><a href="../index.html" style="color:var(--blue);text-decoration:none;border-bottom:1px solid var(--border);">&larr; Industry BOM Registry</a>
  <span style="color:var(--text-dim);">&nbsp;/&nbsp;Company master list</span></span>
  <a href="industries-ranked.html" style="color:var(--blue);text-decoration:none;border-bottom:1px solid var(--border);">Industries ranked &rarr;</a>
</div>
<div class="container">

<header class="masthead">
  <div class="eyebrow">Industry BOM Registry &middot; derived view</div>
  <h1>Company <span>Master List</span></h1>
  <div class="subtitle">${counts.companies} companies &middot; ${counts.industries} industries &middot; ${counts.mappings} node mappings &middot; ranked by breadth, then direct-player position</div>
</header>

<div class="metric-cards">
  <div class="metric-card"><div class="metric-card__val">${counts.companies}</div><div class="metric-card__label">Companies</div><div class="metric-card__sub">unique, across the registry</div></div>
  <div class="metric-card"><div class="metric-card__val">${counts.industries}</div><div class="metric-card__label">Industries</div><div class="metric-card__sub">entry pages mined</div></div>
  <div class="metric-card metric-card--gold"><div class="metric-card__val">${counts.mappings}</div><div class="metric-card__label">Node mappings</div><div class="metric-card__sub">company &times; node mentions</div></div>
  <div class="metric-card metric-card--gold"><div class="metric-card__val">${counts.multi_industry}</div><div class="metric-card__label">Multi-industry</div><div class="metric-card__sub">companies in 2+ industries</div></div>
  <div class="metric-card"><div class="metric-card__val">${widest ? (widest.industries_count || 0) : 0}</div><div class="metric-card__label">Widest footprint</div><div class="metric-card__sub">${widest ? esc(widest.name) : '&mdash;'}</div></div>
</div>

<div class="sec-head"><span class="sec-num">01</span><span class="sec-title">Ranked master list</span><span class="sec-note">click a column header to sort</span></div>
<div class="toolbar"><input class="q" type="search" id="q" placeholder="filter by company, ticker, industry or node&hellip;"><span class="sec-note" id="count"></span></div>
<div class="table-wrap"><div class="table-scroll"><table class="data" id="tbl">
<thead><tr><th>#</th><th>Company</th><th>Ticker</th><th>Industries</th><th>Direct in</th><th>Nodes</th><th>Industries &amp; position</th></tr></thead>
<tbody>`;

// ---- section 01: one row per company --------------------------------------
for (const c of rows) {
  const inds = [...(c.industries || [])].sort((a, b) => a.name.localeCompare(b.name));
  const chips = inds.slice(0, 3).map((i) => {
    const exps = (i.positions || []).map((p) => p.exposure).sort(expSort);
    return `<span class="chip">${esc(i.name)} <b>${esc(exps.join('/'))}</b></span>`;
  }).join('');
  const more = inds.length > 3 ? `<span class="chip">+${inds.length - 3} more</span>` : '';
  const hay = [c.name, c.ticker, ...inds.map((i) => i.name + ' ' + (i.positions || []).map((p) => p.exposure + ' ' + (p.nodes || []).join(' ')).join(' '))].join(' ').toLowerCase();
  out += `<tr data-name="${esc(hay)}" data-ind="${c.industries_count || 0}" data-direct="${c.direct_count || 0}" data-nodes="${c.nodes_count || 0}">`
    + `<td class="c">${c.rank}</td><td><b>${esc(c.name)}</b></td><td class="c">${esc(c.ticker || '&mdash;')}</td>`
    + `<td class="c">${c.industries_count || 0}</td><td class="c">${c.direct_count || 0}</td><td class="c">${c.nodes_count || 0}</td>`
    + `<td>${chips}${more}</td></tr>`;
}

out += `</tbody></table></div></div>

<div class="sec-head"><span class="sec-num">02</span><span class="sec-title">By industry &mdash; where each company sits</span><span class="sec-note">direct &middot; indirect &middot; conglomerate &middot; supplier</span></div>`;

// ---- section 02: one group per industry -----------------------------------
const byIndustry = new Map();
for (const c of rows) {
  for (const ind of c.industries || []) {
    if (!byIndustry.has(ind.slug)) byIndustry.set(ind.slug, { name: ind.name, members: [] });
    byIndustry.get(ind.slug).members.push({ company: c, positions: ind.positions || [] });
  }
}

for (const [, ind] of [...byIndustry.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
  const byExp = new Map();
  for (const m of ind.members) {
    for (const p of m.positions) {
      if (!byExp.has(p.exposure)) byExp.set(p.exposure, []);
      byExp.get(p.exposure).push({ name: m.company.name, ticker: m.company.ticker, nodes: p.nodes || [] });
    }
  }
  let tiers = '';
  for (const exp of [...byExp.keys()].sort(expSort)) {
    const list = byExp.get(exp).sort((a, b) => a.name.localeCompare(b.name));
    tiers += `<div><div class="tag tag--${esc(exp)}">${EXP_LABEL[exp] || esc(exp)} &middot; ${list.length}</div><ul class="tier-list">`
      + list.map((x) => `<li><b>${esc(x.name)}</b> <span class="tk">${esc(x.ticker || '&mdash;')}</span> <span class="nd">${esc(x.nodes.join('; '))}</span></li>`).join('')
      + `</ul></div>`;
  }
  out += `<section class="group"><button class="group__head" aria-expanded="false"><span class="chev"></span><span class="group__name">${esc(ind.name)}</span><span class="group__count">${ind.members.length}</span></button><div class="group__panel"><div class="inner"><div class="tiers">${tiers}</div></div></div></section>`;
}

out += `

<div class="footnote">Derived from the published registry's company maps (${counts.industries} entry pages). Position = the exposure recorded on each node: direct = the company itself plays at that node; indirect = indirect exposure; conglomerate = via a diversified parent; supplier = upstream component or material. Rank sorts by number of industries, then industries where the company is a direct player, then node breadth. Generated ${d.generated}.</div>

</div>
<script>
const rows=[...document.querySelectorAll('#tbl tbody tr')],q=document.getElementById('q'),cnt=document.getElementById('count');
function apply(){const v=q.value.toLowerCase().trim();let n=0;rows.forEach(r=>{const ok=!v||r.dataset.name.includes(v);r.style.display=ok?'':'none';if(ok)n++;});cnt.textContent=n+' of '+rows.length+' shown';}
q.addEventListener('input',apply);apply();
let dir={};
document.querySelectorAll('#tbl th').forEach((th,i)=>th.addEventListener('click',()=>{
 const tb=document.querySelector('#tbl tbody');dir[i]=!dir[i];const d=dir[i]?1:-1;
 rows.sort((a,b)=>{const num=[0,3,4,5].includes(i);const x=num?+a.children[i].innerText:a.children[i].innerText.toLowerCase();const y=num?+b.children[i].innerText:b.children[i].innerText.toLowerCase();return (num?(x-y):(x<y?-1:x>y?1:0))*d;});
 rows.forEach(r=>tb.appendChild(r));
}));
document.querySelectorAll('.group__head').forEach(h=>h.addEventListener('click',()=>{const g=h.closest('.group');g.classList.toggle('open');h.setAttribute('aria-expanded',g.classList.contains('open'));}));
</script></body></html>
`;

writeFileSync(OUT, out);
console.log(`companies view written - ${rows.length} rows, ${byIndustry.size} industry groups`);
