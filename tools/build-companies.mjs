#!/usr/bin/env node
/**
 * Industry BOM Registry — companies index builder
 *
 * Derives companies.json from the entry pages. Never hand-edit companies.json:
 * run `node tools/build-companies.mjs` after every publish that adds or edits
 * an entry, so the index can never drift from the pages.
 *
 * Source of truth: the NODES array inside each industries/<slug>.html page —
 *   { n: company name, t: listing string ("NSE/BSE: TICKER"), e: exposure, ... }
 * grouped by the node's `name`.
 *
 * Usage:  node tools/build-companies.mjs                        # every entry page
 *         node tools/build-companies.mjs --slug=<slug>[,<slug>]  # just the published entry
 *
 * MERGE SEMANTICS: the existing companies.json is the base. For every page the
 * builder upserts that page's (company -> exposure -> nodes) positions and
 * leaves every other row untouched, then recomputes the counts. Merging rather
 * than rebuilding keeps the registry's curated name normalisation intact (some
 * group entities are recorded under one canonical row across pages) while
 * guaranteeing the index can never drift from the pages.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'industries';
const OUT = 'companies.json';

const ENTITIES = {
  '&amp;': '&', '&mdash;': '—', '&ndash;': '–', '&middot;': '·', '&rarr;': '→',
  '&rsquo;': '’', '&lsquo;': '‘', '&ldquo;': '“', '&rdquo;': '”', '&nbsp;': ' ',
  '&lt;': '<', '&gt;': '>', '&#8377;': '₹',
};
const decode = (s) => String(s || '').replace(/&[a-z#0-9]+;/gi, (m) => (ENTITIES[m] !== undefined ? ENTITIES[m] : m));
const norm = (s) => decode(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();

function industryName(html) {
  const m = html.match(/<h1>([\s\S]*?)<\/h1>/);
  if (!m) return null;
  return decode(m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function nodesArray(html) {
  const m = html.match(/NODES\s*=\s*\[/);
  if (!m) return [];
  const start = html.indexOf('[', m.index);
  let depth = 0, q = null, esc = false, end = -1;
  for (let k = start; k < html.length; k++) {
    const c = html[k];
    if (q) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) { end = k; break; } }
  }
  if (end < 0) return [];
  const literal = html.slice(start, end + 1);
  try { return new Function('return ' + literal)(); } catch (e) { console.error('eval fail', e.message); return []; }
}

function symbolOf(ticker) {
  if (!ticker) return null;
  const m = String(ticker).match(/:\s*([A-Za-z0-9&\-.]+)\s*$/);
  return m ? m[1].toUpperCase() : null;
}

// ---- base: existing index -------------------------------------------------
let base = { companies: [] };
if (existsSync(OUT)) {
  try { base = JSON.parse(readFileSync(OUT, 'utf8')); } catch (e) { console.error('existing companies.json unreadable — starting fresh'); }
}
const rows = base.companies || [];
const byNorm = new Map(rows.map((r) => [norm(r.name), r]));
const bySymbol = new Map(rows.filter((r) => r.symbol).map((r) => [r.symbol, r]));

const seenSlugs = new Set();
const touched = new Set();

const onlySlugs = process.argv.slice(2)
  .filter((a) => a.startsWith('--slug='))
  .flatMap((a) => a.replace('--slug=', '').split(','))
  .filter(Boolean);

for (const file of readdirSync(DIR).filter((f) => f.endsWith('.html')).sort()) {
  const slug = file.replace(/\.html$/, '');
  if (onlySlugs.length && !onlySlugs.includes(slug)) continue;
  const html = readFileSync(join(DIR, file), 'utf8');
  const industry = industryName(html) || slug;
  const nodes = nodesArray(html);
  if (!nodes.length) continue;
  seenSlugs.add(slug);

  // company -> exposure -> Set(node names)
  const perCompany = new Map();
  for (const node of nodes) {
    for (const c of node.companies || []) {
      if (!c || !c.n) continue;
      const key = decode(c.n).trim();
      if (!perCompany.has(key)) perCompany.set(key, { ticker: c.t || null, positions: new Map() });
      const rec = perCompany.get(key);
      if (!rec.ticker && c.t) rec.ticker = c.t;
      const exp = (c.e || 'direct').toLowerCase();
      if (!rec.positions.has(exp)) rec.positions.set(exp, new Set());
      rec.positions.get(exp).add(decode(node.name));
    }
  }

  for (const [name, rec] of perCompany) {
    let row = byNorm.get(norm(name));
    if (!row) {
      const sym = symbolOf(rec.ticker);
      if (sym && bySymbol.has(sym)) row = bySymbol.get(sym);
    }
    if (!row) {
      row = { name, ticker: rec.ticker, symbol: symbolOf(rec.ticker), industries_count: 0, direct_count: 0, nodes_count: 0, industries: [] };
      rows.push(row);
      byNorm.set(norm(name), row);
      if (row.symbol) bySymbol.set(row.symbol, row);
    }
    if (!row.ticker && rec.ticker) row.ticker = rec.ticker;
    if (!row.symbol && rec.ticker) row.symbol = symbolOf(rec.ticker);

    const positions = [...rec.positions.entries()].map(([exposure, nodeset]) => ({
      exposure,
      nodes: [...nodeset].sort(),
    }));
    positions.sort((a, b) => a.exposure.localeCompare(b.exposure));

    const existing = (row.industries || []).findIndex((i) => i.slug === slug);
    const record = { name: industry, slug, positions };
    if (existing >= 0) row.industries[existing] = record;
    else (row.industries = row.industries || []).push(record);
    touched.add(row);
  }
}

// ---- recompute derived counts --------------------------------------------
for (const row of rows) {
  row.industries = (row.industries || []).sort((a, b) => a.name.localeCompare(b.name));
  row.industries_count = row.industries.length;
  let direct = 0, nodesCount = 0;
  for (const ind of row.industries) {
    for (const pos of ind.positions || []) {
      if (pos.exposure === 'direct') direct += (pos.nodes || []).length;
      nodesCount += (pos.nodes || []).length;
    }
  }
  row.direct_count = direct;
  row.nodes_count = nodesCount;
}

rows.sort((a, b) => b.industries_count - a.industries_count || b.nodes_count - a.nodes_count || a.name.localeCompare(b.name));

const mappings = rows.reduce((s, c) => s + (c.industries || []).reduce((t, i) => t + (i.positions || []).reduce((u, p) => u + (p.nodes || []).length, 0), 0), 0);
const multi = rows.filter((c) => c.industries_count > 1).length;
const prevCounts = base.counts || {};

const out = {
  registry: 'Industry BOM Registry',
  description:
    'Company index. Every company mentioned across the registry, the industries it appears in, and its position (exposure) in each. DERIVED from the entry pages by tools/build-companies.mjs — regenerate on every publish, never hand-edit.',
  generated: new Date().toISOString().slice(0, 10),
  counts: {
    companies: rows.length,
    industries: new Set(rows.flatMap((r) => (r.industries || []).map((i) => i.slug))).size,
    mappings,
    multi_industry: multi,
    rank_changes: prevCounts.rank_changes || 0,
  },
  companies: rows,
};

writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
console.log(`companies.json written — ${rows.length} companies, ${seenSlugs.size} industries, ${mappings} mappings, ${touched.size} rows touched`);
