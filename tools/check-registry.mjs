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
 *   - has a malformed class token (two class names concatenated without a space)
 *   - contains leaked [cite:...] markers
 *   - is an entry page with no canonical component classes at all (the index is exempt)
 *   - the register index carrying metric-card components (it is a plain listing)
 *   - is an entry page that carries a component's MARKUP but not its CSS — i.e. a
 *     canonical component selector that is missing from both the page and the
 *     shared stylesheet (the "sections render unstyled" bug)
 *
 * Run this BEFORE reporting a run done. Never publish a failing page.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ALIASES = new Set([
  // metric cards
  'kpi-row', 'kpi', 'kpi--gold', 'kpi--high', 'kpi__val', 'kpi__label', 'kpi__sub', 'kpi-c', 'kpi-v', 'kpi-l', 'mc',
  // digest
  'dg', 'dg__b', 'dg__h', 'digest__block',
  // popup
  'mdov', 'mdp', 'mdp__k', 'mdp__v', 'mdp__l', 'mdp__s', 'mdp__x', 'metric-modal__card'
]);

const CANONICAL_SAMPLES = ['metric-card', 'metric-cards', 'digest', 'digest__item', 'metric-modal'];

// Component selectors every ENTRY page must define — in its own <style> OR in the
// shared stylesheet. A page that renders a component without its CSS fails here.
const REQUIRED_CSS = [
  '.sec-head', '.sec-title', '.sec-note',
  '.mermaid-wrap', '.legend',
  '.ladder', '.rung',
  '.map-layout', '.map-nodes', '.map-panel', '.node-btn',
  'table.data', '.table-wrap', '.table-scroll',
  '.cell-d', '.cell-i', '.cell-s', '.cell-c', '.cell-x',
  '.bn', '.bn__risk', '.bn__opp', '.bn__h', '.bn__title',
  '.callout', '.footnote'
];

const SHARED_CSS_PATH = 'assets/registry.css';
const sharedCss = existsSync(SHARED_CSS_PATH) ? readFileSync(SHARED_CSS_PATH, 'utf8') : '';

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

function classesIn(html) {
  const set = new Set();
  const re = /class\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(html))) m[1].split(/\s+/).forEach(c => c && set.add(c));
  return set;
}

// Class tokens in real MARKUP only (script/style stripped) — used to catch
// two class names concatenated without a space, e.g. "digest__itemdigest__item--gold".
function markupClasses(html) {
  const stripped = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
                       .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  const set = new Set();
  const re = /class\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(stripped))) m[1].split(/\s+/).forEach(c => c && set.add(c));
  return set;
}
const CLASS_TOKEN_RE = /^[a-z][a-z0-9-]*(__[a-z0-9-]+)?(--[a-z0-9-]+)?$/;

function inlineCss(html) {
  const re = /<style[^>]*>([\s\S]*?)<\/style>/g;
  let m, out = '';
  while ((m = re.exec(html))) out += '\n' + m[1];
  return out;
}

const files = collectFiles(process.argv.slice(2));
if (!files.length) {
  console.log('No HTML files found to check (looked for index.html and industries/*.html).');
  process.exit(0);
}

let failures = 0;
for (const file of files) {
  const html = readFileSync(file, 'utf8');
  const problems = [];
  const isEntryPage = /(^|[\\/])industries[\\/]/.test(file);

  if (!/registry\.css/.test(html)) {
    problems.push('does not link the shared stylesheet (assets/registry.css)');
  }

  const cls = classesIn(html);
  const bad = [...cls].filter(c => ALIASES.has(c));
  if (bad.length) problems.push('deprecated alias classes: ' + bad.join(', '));

  const malformed = [...markupClasses(html)].filter(c => !CLASS_TOKEN_RE.test(c));
  if (malformed.length) problems.push('malformed class token(s) — two classes concatenated without a space?: ' + malformed.join(', '));

  if (/\[cite:[^\]]+\]/.test(html)) {
    problems.push('contains [cite:...] markers (must be plain prose)');
  }

  if (isEntryPage && !CANONICAL_SAMPLES.some(c => cls.has(c))) {
    problems.push('no canonical component classes found (metric-card / digest / metric-modal)');
  }

  if (!isEntryPage) {
    // The register index is a plain listing — it must not carry metric cards.
    const banned = ['metric-card', 'metric-cards', 'metric-modal'].filter(c => cls.has(c));
    if (banned.length) problems.push('the register index must not carry metric-card components (found: ' + banned.join(', ') + ')');
  }

  if (isEntryPage) {
    const css = inlineCss(html) + '\n' + sharedCss;
    const missing = REQUIRED_CSS.filter(sel => !css.includes(sel));
    if (missing.length) {
      problems.push('missing component CSS (markup present but no rule, in page or shared stylesheet): ' + missing.join(', '));
    }
  }

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
