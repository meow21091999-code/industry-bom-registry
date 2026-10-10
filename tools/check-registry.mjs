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
 *   - uses a component class whose selector is defined NOWHERE
 *     (neither in the shared stylesheet nor in the page's own <style>)
 *     — so a component can never ship unstyled.
 *
 * Run this BEFORE reporting a run done. Never publish a failing page.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

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
  'footnote'
]);

const CANONICAL_SAMPLES = ['metric-card', 'metric-cards', 'digest', 'digest__item', 'metric-modal'];
const INDEX_FORBIDDEN = ['metric-card', 'metric-cards', 'metric-modal'];

function collectFiles(args) {
  const out = [];
  const roots = args.length ? args : ['index.html', 'industries'];
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

let failures = 0;
for (const file of files) {
  const html = readFileSync(file, 'utf8');
  const isIndex = basename(file) === 'index.html';
  const problems = [];

  if (!/registry\.css/.test(html)) {
    problems.push('does not link the shared stylesheet (assets/registry.css)');
  }

  const used = classesInMarkup(html);
  const bad = [...used].filter(c => ALIASES.has(c));
  if (bad.length) problems.push('deprecated alias classes: ' + bad.join(', '));

  if (/\[cite:[^\]]+\]/.test(html)) {
    problems.push('contains [cite:...] markers (must be plain prose)');
  }

  if (isIndex) {
    const forbidden = [...used].filter(c => INDEX_FORBIDDEN.includes(c));
    if (forbidden.length) problems.push('index must not carry metric-card / metric-modal classes: ' + forbidden.join(', '));
  } else if (!CANONICAL_SAMPLES.some(c => used.has(c))) {
    problems.push('entry page has no canonical component classes (metric-card / digest / metric-modal)');
  }

  // component-CSS resolution: every used component class must be defined somewhere
  const pageDefined = classesInCss(inlineStyle(html));
  const unstyled = [...used].filter(c => KNOWN_COMPONENTS.has(c) && !sharedDefined.has(c) && !pageDefined.has(c));
  if (unstyled.length) problems.push('component classes with no CSS defined anywhere (would render unstyled): ' + unstyled.join(', '));

  if (problems.length) {
    failures++;
    console.log('FAIL  ' + file);
    problems.forEach(p => console.log('        - ' + p));
  } else {
    console.log('PASS  ' + file);
  }
}

console.log('\n' + files.length + ' file(s) checked, ' + failures + ' failed.');
process.exit(failures ? 1 : 0);
