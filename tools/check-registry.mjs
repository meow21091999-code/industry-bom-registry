#!/usr/bin/env node
/**
 * Industry BOM Registry — conformance checker (machine check)
 *
 * Usage:  node tools/check-registry.mjs [paths...]
 * Default: checks ./index.html and ./industries/*.html
 *
 * Fails (exit 1) when a page:
 *   - does not link the shared stylesheet (assets/registry.css)
 *   - uses a DEPRECATED alias class (registry-design-language.md §0)
 *   - contains leaked [cite:...] markers
 *   - is an ENTRY page with no canonical component classes
 *   - is the INDEX page but carries metric-card / metric-modal classes
 *   - carries a Regulatory calendar section (removed from the registry)
 *   - has an industry-score block with no rendered .scorecard, or two scorecards
 *   - puts a section after the sources footer, or a score block inside the diagram template
 *   - uses a component class whose selector is defined NOWHERE
 *     (neither in the shared stylesheet nor in the page's own <style>)
 *     — so a component can never ship unstyled.
 *
 * Run this BEFORE reporting a run done. Never publish a failing page.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import vm from 'node:vm';

const SHARED_CSS = 'assets/registry.css';

const ALIASES = new Set([
  'kpi-row', 'kpi', 'kpi--gold', 'kpi--high', 'kpi__val', 'kpi__label', 'kpi__sub', 'kpi-c', 'kpi-v', 'kpi-l', 'mc',
  'dg', 'dg__b', 'dg__h', 'digest__block',
  'mdov', 'mdp', 'mdp__k', 'mdp__v', 'mdp__l', 'mdp__s', 'mdp__x', 'metric-modal__card'
]);

// Every component class a page may use — each MUST resolve to a defined selector.
const KNOWN_COMPONENTS = new Set([
  'container', 'masthead', 'eyebrow', 'subtitle', 'scope-bar', 'chip', 'chip--gold', 'chip--high',
  'sec-head', 'sec-num', 'sec-title', 'sec-note', 'animate',
  'metric-cards', 'metric-card', 'metric-card--gold', 'metric-card--high', 'metric-card__val', 'metric-card__label', 'metric-card__sub',
  'digest', 'digest__item', 'digest__h',
  'diagram-shell', 'diagram-shell__hint', 'mermaid-wrap', 'zoom-controls', 'zoom-label', 'mermaid-viewport', 'mermaid-canvas', 'legend', 'legend-item', 'legend-swatch',
  'ladder', 'rung', 'rung--1', 'rung--2', 'rung--3', 'rung--4', 'rung__label', 'rung__body', 'mini',
  'map-layout', 'map-nodes', 'node-btn', 'node-btn__name', 'node-btn__meta', 'is-active',
  'dot', 'dot--high', 'dot--med', 'dot--low', 'dot--none', 'flag', 'flag--gap', 'flag--bott',
  'map-panel', 'map-panel__kicker', 'map-panel__title', 'map-panel__fn', 'map-panel__row',
  'co', 'co__name', 'co__ticker', 'co__tags', 'co__mat', 'co__ev',
  'tag', 'tag--direct', 'tag--indirect', 'tag--supplier', 'tag--conglomerate', 'nocov', 'near',
  'table-wrap', 'table-scroll', 'data', 'c', 'cell-d', 'cell-i', 'cell-s', 'cell-c', 'cell-x',
  'bn', 'bn__risk', 'bn__opp', 'bn__h', 'bn__title', 'callout',
  'metric-modal', 'metric-modal__backdrop', 'metric-modal__panel', 'metric-modal__close',
  'metric-modal__kicker', 'metric-modal__val', 'metric-modal__label', 'metric-modal__bullets',
  'footnote',
  'scorecard', 'scorecard__group', 'scorecard__group--structural', 'scorecard__group--current',
  'scorecard__group--risk', 'scorecard__h', 'sc-total', 'sc-row', 'sc-name', 'sc-wt',
  'sc-basis', 'sc-val', 'sc-val--null', 'scorecard__foot'
]);

const CANONICAL_SAMPLES = ['metric-card', 'metric-cards', 'digest', 'digest__item', 'metric-modal'];
const INDEX_FORBIDDEN = ['metric-card', 'metric-cards', 'metric-modal'];

// The nine score-block categories. All nine live INSIDE categories{} — risk included
// (it carries no weight, but it is a category and the ranking builder reads it there).
const SCORE_CATEGORIES = ['economics', 'opportunity', 'competitive', 'cycle', 'valuation',
  'value_chain', 'capital', 'technology', 'risk'];
const VALUE_CAPTURE_PARAMS = ['op_share', 'pricing_power', 'roic', 'barriers',
  'bottleneck', 'pool_growth', 'cash_conversion', 'switching'];

function collectFiles(args) {
  const out = [];
  const roots = args.length ? args : ['index.html', 'industries', 'views'];
  for (const r of roots) {
    if (!existsSync(r)) continue;
    if (statSync(r).isDirectory()) {
      for (const f of readdirSync(r)) if (f.endsWith('.html')) out.push(join(r, f));
    } else if (r.endsWith('.html')) {
      out.push(r);
    }
  }
  return out;
}

function classesInMarkup(html) {
  const set = new Set();
  const re = /class\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(html))) m[1].split(/\s+/).forEach(c => c && set.add(c));
  return set;
}

function classesInCss(css) {
  const set = new Set();
  const re = /\.([a-zA-Z_][\w-]*)/g;
  let m;
  while ((m = re.exec(css))) set.add(m[1]);
  return set;
}

function inlineStyle(html) {
  let css = '';
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(html))) css += m[1] + '\n';
  return css;
}

// classes defined by the shared stylesheet
let sharedDefined = new Set();
if (existsSync(SHARED_CSS)) {
  sharedDefined = classesInCss(readFileSync(SHARED_CSS, 'utf8'));
} else {
  console.log('WARN  shared stylesheet ' + SHARED_CSS + ' not found — component-CSS check will rely on page styles only.');
}

const files = collectFiles(process.argv.slice(2));
if (!files.length) {
  console.log('No HTML files found to check (looked for index.html and industries/*.html).');
  process.exit(0);
}

// Bracket-matched slice of a JS array literal, string-aware.
function extractArray(s, startIdx) {
  let depth = 0, inStr = null, esc = false;
  for (let i = startIdx; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) return s.slice(startIdx, i + 1); }
  }
  return null;
}

let failures = 0;
let warned = 0;
let scoreBlockPages = 0;   // pages carrying an industry-score block
for (const file of files) {
  const html = readFileSync(file, 'utf8');
  const isIndex = basename(file) === 'index.html';
  const isView = file.includes('views/');
  const problems = [];
  const warnings = [];   // non-blocking: reported, but does not fail the page

  if (/class="industry-score"/.test(html)) scoreBlockPages++;

  if (!/registry\.css/.test(html)) {
    problems.push('does not link the shared stylesheet (assets/registry.css)');
  }

  const used = classesInMarkup(html);
  const bad = [...used].filter(c => ALIASES.has(c));
  if (bad.length) problems.push('deprecated alias classes: ' + bad.join(', '));

  if (/\[cite:[^\]]+\]/.test(html)) {
    problems.push('contains [cite:...] markers (must be plain prose)');
  }

  if (/<div class="co__ticker"/.test(html)) {
    problems.push('company ticker must be a <span> inside .co__name, not a separate <div>');
  }

  // the score block must sit at the real end of the document. Inserting at the first </body>
  // lands it inside openInNewTab's template literal, where its </script> kills the diagram module.
  {
    const t0 = html.indexOf('const html = `<!DOCTYPE html>');
    const t1 = html.indexOf('</body></html>`;');
    const sc = html.indexOf('class="industry-score"');
    if (t0 > 0 && t1 > t0 && sc > t0 && sc < t1) {
      problems.push('industry-score block is inside the openInNewTab template — it breaks the diagram script');
    }
  }

  // the sources footer is the last thing on the page — nothing may sit below it
  {
    const foot = html.search(/<p class="footnote[^"]*"[^>]*>\s*Sources/);
    if (foot > 0 && html.indexOf('<section', foot) > 0) {
      problems.push('a section appears after the sources footer — sources must be the last thing on the page');
    }
    const n = (html.match(/class="scorecard"/g) || []).length;
    if (n > 1) problems.push(`duplicate scorecard sections (${n})`);
  }

  // a page carrying a score block must RENDER it — machine-readable alone is invisible to a reader
  if (/class="industry-score"/.test(html) && !/class="scorecard"/.test(html)) {
    problems.push('has an industry-score block but no .scorecard section — the scores are never shown');
  }

  // the Regulatory calendar section was REMOVED from the registry — it must not come back
  if (/sec-title\s*"[^>]*>\s*Regulatory calendar/i.test(html)) {
    problems.push('carries a Regulatory calendar section — that section is REMOVED from the registry');
  }

  // every entry page should be scored; unscored pages are a warning until the backfill clears them
  if (!isIndex && !isView && !/class="industry-score"/.test(html)) {
    warnings.push('no industry-score block — the industry scorecard is not scored yet (backfill pending)');
  }

  // NAVIGATION: every page below the root must carry a way back to the register.
  // An entry page or a derived view with no breadcrumb is a dead end — the reader
  // arrives from the index and cannot return without the browser's back button.
  if (!isIndex && !/href="\.\.\/index\.html"/.test(html)) {
    problems.push('no breadcrumb link back to the register (href="../index.html") — the page is a dead end');
  }

  // SCORE-BLOCK SCHEMA: the nine categories must sit INSIDE categories{}, risk included.
  // Five pages once carried "risk" as a TOP-LEVEL key: they rendered correctly but
  // build-industry-ranking.mjs reads block.categories[risk], so those five silently
  // lost their resilience score and dropped out of the risk-adjusted ranking.
  if (/class="industry-score"/.test(html)) {
    const m = html.match(/<script[^>]*class="industry-score"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) {
      problems.push('industry-score block could not be read (malformed <script class="industry-score">)');
    } else {
      let block = null;
      try {
        block = JSON.parse(m[1]);
      } catch (e) {
        problems.push('industry-score block is not valid JSON: ' + String(e.message).slice(0, 70));
      }
      if (block) {
        const cats = block.categories || {};
        const missing = SCORE_CATEGORIES.filter((c) => !(c in cats));
        if (missing.length) {
          problems.push('industry-score block is missing categor' + (missing.length > 1 ? 'ies ' : 'y ') +
            missing.join(', ') + ' inside categories{} — score them (null with a basis is allowed) rather than omitting them');
        }
        const stray = SCORE_CATEGORIES.filter((c) => c in block);
        if (stray.length) {
          problems.push('industry-score block carries ' + stray.join(', ') + ' at the TOP LEVEL — ' +
            'every category must sit inside categories{} or the ranking builder will not read it');
        }
        for (const c of SCORE_CATEGORIES) {
          if (cats[c] && typeof cats[c] === 'object' && !('basis' in cats[c])) {
            problems.push('industry-score category ' + c + ' has no basis line');
          }
        }
        if (!block.confidence || typeof block.confidence !== 'object') {
          warnings.push('score block has no confidence object (evidence 1-5 + primary_source_pct) — predates the rule');
        } else {
          const ev = block.confidence.evidence;
          const pct = block.confidence.primary_source_pct;
          if (!(Number.isInteger(ev) && ev >= 1 && ev <= 5)) {
            problems.push('confidence.evidence must be an integer 1-5 (found ' + JSON.stringify(ev) + ')');
          }
          if (!(typeof pct === 'number' && pct >= 0 && pct <= 100)) {
            problems.push('confidence.primary_source_pct must be 0-100 (found ' + JSON.stringify(pct) + ')');
          }
        }
        if (Array.isArray(block.value_capture)) {
          block.value_capture.forEach((n, i) => {
            const label = (n && n.node) ? '"' + n.node + '"' : '#' + i;
            if (!n || !n.node) problems.push('value_capture entry ' + label + ' has no node name');
            const params = (n && n.params) || {};
            const have = VALUE_CAPTURE_PARAMS.filter((k) => k in params);
            if (have.length < 4) {
              problems.push('value_capture node ' + label + ' carries only ' + have.length +
                ' of the 8 parameters (at least 4 are required)');
            }
            const outOfRange = have.filter((k) => !(typeof params[k] === 'number' && params[k] >= 1 && params[k] <= 5));
            if (outOfRange.length) {
              problems.push('value_capture node ' + label + ' has parameters outside the 1-5 scale: ' + outOfRange.join(', '));
            }
            if (!n || !n.basis) problems.push('value_capture node ' + label + ' has no basis line');
          });
        }
      }
    }
  }

  // data-script integrity: NODES must be declared once and parse.
  // A duplicated or malformed NODES kills the page's whole company-map script,
  // and the page then silently contributes nothing to companies.json.
  if (!isIndex && !isView) {
    const decls = (html.match(/(?:const|let|var)\s+NODES\s*=/g) || []).length;
    if (decls === 0) {
      problems.push('no NODES declaration - the company map has no data');
    } else if (decls > 1) {
      problems.push('NODES is declared ' + decls + ' times - a duplicate declaration breaks the page script');
    } else {
      const m = html.match(/(?:const|let|var)\s+NODES\s*=\s*/);
      const b = html.indexOf('[', m.index + m[0].length - 1);
      const arr = b >= 0 ? extractArray(html, b) : null;
      if (!arr) {
        problems.push('NODES array is unterminated (unbalanced brackets) - the company map cannot parse');
      } else {
        try {
          const nodes = vm.runInNewContext('(' + arr + ')', {}, { timeout: 2000 });
          if (!Array.isArray(nodes)) problems.push('NODES is not an array');
        } catch (e) {
          problems.push('NODES does not parse: ' + String((e && e.message) || e).slice(0, 90));
        }
      }
    }
  }

  if (isIndex) {
    const forbidden = [...used].filter(c => INDEX_FORBIDDEN.includes(c));
    if (forbidden.length) problems.push('index must not carry metric-card / metric-modal classes: ' + forbidden.join(', '));
  } else if (!isView && !CANONICAL_SAMPLES.some(c => used.has(c))) {
    problems.push('entry page has no canonical component classes (metric-card / digest / metric-modal)');
  }

  if (!isIndex && !isView && !/Market\s*&(?:amp;)?\s*growth/i.test(html)) {
    warnings.push('missing the MANDATORY Market & growth digest block (backfill pending)');
  }

  // component-CSS resolution: every used component class must be defined somewhere
  const pageDefined = classesInCss(inlineStyle(html));
  const unstyled = [...used].filter(c => KNOWN_COMPONENTS.has(c) && !sharedDefined.has(c) && !pageDefined.has(c));
  if (unstyled.length) problems.push('component classes with no CSS defined anywhere (would render unstyled): ' + unstyled.join(', '));

  if (problems.length) {
    failures++;
    console.log('FAIL  ' + file);
    problems.forEach(p => console.log('        - ' + p));
  } else if (warnings.length) {
    warned++;
    console.log('WARN  ' + file);
    warnings.forEach(w => console.log('        ~ ' + w));
  } else {
    console.log('PASS  ' + file);
  }
}

// ---- repo-level checks: derived artefacts must match the pages on disk ----
const industryPages = files.filter(f => f.includes('industries/') && !basename(f).startsWith('index'));
const repoProblems = [];
if (industryPages.length) {
  const n = industryPages.length;
  const checkDerived = (path, label) => {
    if (!existsSync(path)) { repoProblems.push(label + ' is missing — run its builder'); return; }
    try {
      const d = JSON.parse(readFileSync(path, 'utf8'));
      const c = d.counts || {};
      const declared = c.industries != null ? c.industries : (Array.isArray(d.industries) ? d.industries.length : null);
      if (declared != null && declared !== n) {
        repoProblems.push(label + ' is STALE: it lists ' + declared + ' industries, the registry has ' + n + ' — regenerate');
      }
      // the industry count can match while the SCORED count is stale — that is how
      // 25 newly-scored pages stayed unranked. Compare the scored count too.
      if (label === 'industry-ranking.json' && c.scored != null && c.scored !== scoreBlockPages) {
        repoProblems.push('industry-ranking.json is STALE: it reports ' + c.scored + ' scored pages, but ' + scoreBlockPages +
          ' pages carry a score block — regenerate with node tools/build-industry-ranking.mjs');
      }
    } catch (e) {
      repoProblems.push(label + ' is not valid JSON: ' + String(e.message).slice(0, 70));
    }
  };
  checkDerived('industry-ranking.json', 'industry-ranking.json');
  checkDerived('companies.json', 'companies.json');
  if (existsSync('index.html')) {
    const idx = readFileSync('index.html', 'utf8');
    if (!idx.includes('views/industries-ranked.html')) {
      repoProblems.push('index.html does not link views/industries-ranked.html — the industry ranking is unreachable');
    }
    if (!idx.includes('views/companies-master-list.html')) {
      repoProblems.push('index.html does not link views/companies-master-list.html — the company list is unreachable');
    }
  }
  const pageSlugs = industryPages.map((p) => basename(p).replace(/\.html$/, ''));

  // ---- register coverage: an entry page nobody can reach is an orphan ------ 
  // (four pages once sat on disk, live and correct, with no row in index.html —
  // invisible to every reader and every link check that only walks the index.)
  if (existsSync('index.html')) {
    const idxHtml = readFileSync('index.html', 'utf8');
    const linkedSlugs = new Set([...idxHtml.matchAll(/href="industries\/([A-Za-z0-9._-]+)\.html/gi)].map((m) => m[1]));
    const unlisted = pageSlugs.filter((s) => !linkedSlugs.has(s));
    if (unlisted.length) {
      repoProblems.push('index.html does not list ' + unlisted.length + ' entry page(s): ' + unlisted.join(', ') +
        ' — an unlisted page is unreachable from the register');
    }
    const dead = [...linkedSlugs].filter((s) => !pageSlugs.includes(s));
    if (dead.length) {
      repoProblems.push('index.html links ' + dead.length + ' page(s) that do not exist: ' + dead.join(', '));
    }
  }

  // ---- node index: every page indexed, and lineage symmetric both ways ------ 
  if (existsSync('registry-nodes.json')) {
    try {
      const nd = JSON.parse(readFileSync('registry-nodes.json', 'utf8'));
      const entries = nd.entries || [];
      const inIndex = new Set(entries.map((e) => e.slug));
      const missingFromIndex = pageSlugs.filter((s) => !inIndex.has(s));
      if (missingFromIndex.length) {
        repoProblems.push('registry-nodes.json has no entry for ' + missingFromIndex.length + ' page(s): ' +
          missingFromIndex.join(', ') + ' — lineage lookup and node matching cannot see them');
      }
      const indexOrphans = [...inIndex].filter((s) => !pageSlugs.includes(s));
      if (indexOrphans.length) {
        repoProblems.push('registry-nodes.json lists ' + indexOrphans.length + ' slug(s) with no page: ' + indexOrphans.join(', '));
      }
      const asSlugs = (x) => !x ? [] : (Array.isArray(x) ? x.map((i) => (typeof i === 'string' ? i : i.slug)) : (typeof x === 'string' ? [x] : [x.slug]));
      const bySlug = new Map(entries.map((e) => [e.slug, e]));
      const oneWay = [];
      for (const e of entries) {
        for (const parent of asSlugs(e.derived_from)) {
          const p = bySlug.get(parent);
          if (!p) { oneWay.push(e.slug + ' -> missing parent ' + parent); continue; }
          if (!asSlugs(p.drill_downs).includes(e.slug)) oneWay.push(e.slug + ' derived_from ' + parent + ' but ' + parent + '.drill_downs omits it');
        }
        for (const child of asSlugs(e.drill_downs)) {
          const c = bySlug.get(child);
          if (!c) { oneWay.push(e.slug + ' drill_downs -> missing child ' + child); continue; }
          if (!asSlugs(c.derived_from).includes(e.slug)) oneWay.push(e.slug + ' drill_downs ' + child + ' but ' + child + '.derived_from omits it');
        }
      }
      if (oneWay.length) {
        repoProblems.push('registry-nodes.json lineage is one-way for ' + oneWay.length + ' relation(s): ' +
          oneWay.slice(0, 4).join('; ') + (oneWay.length > 4 ? ' (+' + (oneWay.length - 4) + ' more)' : ''));
      }
    } catch (e) {
      repoProblems.push('registry-nodes.json is not valid JSON: ' + String(e.message).slice(0, 70));
    }
  }

  // ---- derived VIEW freshness: the view carries its own copy of the counts -- 
  if (existsSync('views/companies-master-list.html') && existsSync('companies.json')) {
    try {
      const view = readFileSync('views/companies-master-list.html', 'utf8');
      const cc = (JSON.parse(readFileSync('companies.json', 'utf8')).counts) || {};
      const sub = (view.match(/<div class="subtitle">([^<]*)/) || [, ''])[1];
      const m2 = sub.match(/(\d+)\s+companies\s*&middot;\s*(\d+)\s+industries\s*&middot;\s*(\d+)\s+node mappings/);
      if (!m2) {
        repoProblems.push('views/companies-master-list.html headline is unreadable — regenerate with node tools/build-companies-view.mjs');
      } else if (+m2[1] !== cc.companies || +m2[2] !== cc.industries || +m2[3] !== cc.mappings) {
        repoProblems.push('views/companies-master-list.html is STALE: it reports ' + m2[1] + ' companies / ' + m2[2] +
          ' industries / ' + m2[3] + ' node mappings, companies.json has ' + cc.companies + ' / ' + cc.industries +
          ' / ' + cc.mappings + ' — regenerate with node tools/build-companies-view.mjs');
      }
    } catch (e) {
      repoProblems.push('companies.json is not valid JSON: ' + String(e.message).slice(0, 70));
    }
  }

  if (repoProblems.length) {
    failures++;
    console.log('FAIL  repo (derived artefacts)');
    repoProblems.forEach(p => console.log('        - ' + p));
  }
}

console.log('\n' + files.length + ' file(s) checked, ' + failures + ' failed, ' + warned + ' warning(s).');
process.exit(failures ? 1 : 0);
