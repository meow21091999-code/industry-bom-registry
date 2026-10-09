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
 *   - carries no canonical component classes at all (entry pages only; the index is exempt)
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

const files = collectFiles(process.argv.slice(2));
if (!files.length) {
  console.log('No HTML files found to check (looked for index.html and industries/*.html).');
  process.exit(0);
}

let failures = 0;
for (const file of files) {
  const html = readFileSync(file, 'utf8');
  const problems = [];

  if (!/registry\.css/.test(html)) {
    problems.push('does not link the shared stylesheet (assets/registry.css)');
  }

  const cls = classesIn(html);
  const bad = [...cls].filter(c => ALIASES.has(c));
  if (bad.length) problems.push('deprecated alias classes: ' + bad.join(', '));

  if (/\[cite:[^\]]+\]/.test(html)) {
    problems.push('contains [cite:...] markers (must be plain prose)');
  }

  const isEntryPage = /(^|[\\/])industries[\\/]/.test(file);
  if (isEntryPage && !CANONICAL_SAMPLES.some(c => cls.has(c))) {
    problems.push('no canonical component classes found (metric-card / digest / metric-modal)');
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
