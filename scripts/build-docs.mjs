#!/usr/bin/env node
// Generate docs/index.html from results/corpus.json and results/handcheck.json.
//
// Nothing here is typed by hand. Every number on the page is read out of the measurement files,
// so the page cannot say one thing while the frozen record says another. scripts/check-docs.mjs
// rebuilds it and fails if the committed copy differs.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const corpus = JSON.parse(readFileSync(path.join(ROOT, 'results/corpus.json'), 'utf8'));
const handcheck = JSON.parse(readFileSync(path.join(ROOT, 'results/handcheck.json'), 'utf8'));

const RULES = [
  ['no-bare-timeout', 'a fixed sleep standing in for a condition nobody expressed'],
  ['no-unmocked-time', 'the clock deciding an assertion, by calendar, by race, or by machine speed'],
  ['no-unseeded-random', 'random input, so a failure names a value nobody can reproduce'],
  ['no-floating-promise', 'a promise nobody awaits, so its assertions run somewhere else or never'],
  ['no-unordered-assert', 'an order-sensitive assertion on a collection with no defined order'],
  ['no-live-network', 'a request to a real host, which fails on DNS, on a rate limit, and offline'],
];

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const perRule = {};
for (const v of handcheck.verdicts) {
  perRule[v.rule] = perRule[v.rule] || { flake: 0, intentional: 0, false: 0 };
  perRule[v.rule][v.v] += 1;
}

// Published npm packages the real flakes landed in. Vendor labels carry an @version and working
// repositories do not, which is what separates "a package other people install" from "a checkout
// on the machine this was measured on". Only the former belongs on a public page.
const packages = new Map();
for (const v of handcheck.verdicts) {
  if (v.v !== 'flake') continue;
  if (!/@[^/]*\//.test(v.file)) continue;
  const parts = v.file.split('/');
  const name = (parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]).split('@')[0]
    || parts[0].split('@')[0];
  const pretty = parts[0].startsWith('@') ? `${parts[0]}/${parts[1].split('@')[0]}` : name;
  packages.set(pretty, (packages.get(pretty) || 0) + 1);
}
const topPackages = [...packages.entries()].sort((a, b) => b[1] - a[1]);

const total = corpus.findings;
const fp = corpus.falsePositiveRatePercent;

const ruleRows = RULES.map(([id, blurb]) => {
  const c = perRule[id] || { flake: 0, intentional: 0, false: 0 };
  const n = c.flake + c.intentional + c.false;
  const rate = n ? ((c.false / n) * 100).toFixed(1) : '0.0';
  return `      <tr>
        <th scope="row"><a href="https://github.com/JesseRWeigel/no-flaky-test/blob/main/docs/rules/${id}.md"><code>${id}</code></a><span>${esc(blurb)}</span></th>
        <td class="num">${n}</td>
        <td class="num good">${c.flake}</td>
        <td class="num warn">${c.intentional}</td>
        <td class="num ${c.false ? 'bad' : ''}">${c.false}</td>
        <td class="num">${rate}%</td>
      </tr>`;
}).join('\n');

const packageRows = topPackages.map(([name, count]) =>
  `        <li><code>${esc(name)}</code><b>${count}</b></li>`).join('\n');

const byRuleRows = Object.entries(corpus.byRule).sort()
  .map(([id, n]) => `        <li><code>${esc(id)}</code><b>${n}</b></li>`).join('\n');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>eslint-plugin-no-flaky-test</title>
<meta name="description" content="Six ESLint rules for the mechanisms that make JavaScript tests flaky, measured for false positives against ${corpus.corpusFiles} real test files.">
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfbfa; --fg: #1a1a19; --dim: #64645f; --line: #dededa;
    --card: #ffffff; --good: #1a7f4b; --warn: #9a6700; --bad: #b42318; --accent: #2b50aa;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14140f; --fg: #ececea; --dim: #9a9a92; --line: #2e2e28;
      --card: #1c1c17; --good: #4ec27f; --warn: #d9a441; --bad: #f2695c; --accent: #8ab0ff;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-text-size-adjust: 100%;
  }
  main { max-width: 62rem; margin: 0 auto; padding: 3rem 1.25rem 5rem; }
  h1 { font-size: clamp(1.8rem, 5vw, 2.6rem); line-height: 1.15; margin: 0 0 .4rem; letter-spacing: -.02em; }
  h2 { font-size: 1.25rem; margin: 3rem 0 .75rem; letter-spacing: -.01em; }
  p.lede { font-size: 1.1rem; color: var(--dim); margin: 0 0 2rem; max-width: 46rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .9em; }
  a { color: var(--accent); }
  .stats { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); margin: 0 0 1rem; }
  .stat { background: var(--card); border: 1px solid var(--line); border-radius: .6rem; padding: 1rem; }
  .stat b { display: block; font-size: 1.9rem; line-height: 1.1; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
  .stat span { color: var(--dim); font-size: .85rem; }
  .scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: .6rem; background: var(--card); }
  table { border-collapse: collapse; width: 100%; min-width: 40rem; }
  th, td { text-align: left; padding: .7rem .9rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  tbody tr:last-child th, tbody tr:last-child td { border-bottom: 0; }
  thead th { font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; color: var(--dim); font-weight: 600; }
  tbody th { font-weight: 600; }
  tbody th span { display: block; font-weight: 400; color: var(--dim); font-size: .85rem; margin-top: .15rem; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .good { color: var(--good); } .warn { color: var(--warn); } .bad { color: var(--bad); }
  ul.kv { list-style: none; padding: 0; margin: 0; display: grid; gap: .3rem;
          grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); }
  ul.kv li { display: flex; justify-content: space-between; gap: 1rem;
             background: var(--card); border: 1px solid var(--line); border-radius: .4rem; padding: .45rem .7rem; }
  ul.kv b { font-variant-numeric: tabular-nums; }
  pre { background: var(--card); border: 1px solid var(--line); border-radius: .6rem;
        padding: 1rem; overflow-x: auto; font-size: .88rem; line-height: 1.5; }
  footer { margin-top: 4rem; color: var(--dim); font-size: .85rem; border-top: 1px solid var(--line); padding-top: 1.25rem; }
  .note { color: var(--dim); font-size: .9rem; max-width: 46rem; }
</style>
</head>
<body>
<main>
  <h1>eslint-plugin-no-flaky-test</h1>
  <p class="lede">Six rules for the mechanisms that actually make JavaScript tests flaky. Every
  one of them was measured against ${corpus.corpusFiles.toLocaleString('en-US')} real test files
  before it shipped, and every finding it produced was read by hand.</p>

  <div class="stats">
    <div class="stat"><b>${corpus.corpusFiles.toLocaleString('en-US')}</b><span>test files measured</span></div>
    <div class="stat"><b>${corpus.corpusLines.toLocaleString('en-US')}</b><span>lines of real test code</span></div>
    <div class="stat"><b>${total}</b><span>findings, all hand-checked</span></div>
    <div class="stat"><b>${fp}%</b><span>measured false-positive rate</span></div>
  </div>
  <p class="note">The corpus is ${corpus.ownFiles} test files from working projects plus
  ${corpus.vendorFiles.toLocaleString('en-US')} shipped inside published npm packages,
  deduplicated by content hash. The second half matters more: it is test code written and
  reviewed by other people, so if a rule fires there the burden is on the rule.</p>

  <h2>What each rule found, and what it got wrong</h2>
  <div class="scroll">
    <table>
      <thead>
        <tr>
          <th scope="col">Rule</th>
          <th scope="col" class="num">Findings</th>
          <th scope="col" class="num">Real flake</th>
          <th scope="col" class="num">Deliberate</th>
          <th scope="col" class="num">False</th>
          <th scope="col" class="num">FP rate</th>
        </tr>
      </thead>
      <tbody>
${ruleRows}
      </tbody>
    </table>
  </div>
  <p class="note"><b>Real flake</b> is a mechanism that can fail intermittently and the author
  would want to know about. <b>Deliberate</b> means the code really is nondeterministic and the
  author put it there on purpose, almost always fuzz or chaos testing; the rule is right and the
  answer is a disable comment. <b>False</b> means the rule is wrong and no sequence of events can
  make that test fail. Only the last column counts against correctness.</p>

  <h2>Findings by message</h2>
  <ul class="kv">
${byRuleRows}
  </ul>

  <h2>Real flakes found in published packages</h2>
  <p class="note">These are not synthetic examples. Each is a genuine flake mechanism in a package
  installed on the machine this was measured on.</p>
  <ul class="kv">
${packageRows}
  </ul>

  <h2>Install</h2>
<pre><code>npm i -D eslint-plugin-no-flaky-test

// eslint.config.js
import noFlakyTest from 'eslint-plugin-no-flaky-test';

export default [
  {
    files: ['**/*.{test,spec}.{js,ts,tsx}', '**/__tests__/**'],
    ...noFlakyTest.configs.recommended,
  },
];</code></pre>

  <footer>
    <a href="https://github.com/JesseRWeigel/no-flaky-test">Source and rule documentation on GitHub</a>.
    Generated by <code>scripts/build-docs.mjs</code> from <code>results/corpus.json</code> and
    <code>results/handcheck.json</code>. MIT.
  </footer>
</main>
</body>
</html>
`;

const out = path.join(ROOT, 'docs', 'index.html');
writeFileSync(out, html);
console.log(`wrote docs/index.html (${corpus.corpusFiles} files, ${total} findings, ${fp}% false positives)`);
