#!/usr/bin/env node
// The README is a claim like any other. Twelve verify scripts in the sibling projects here pass
// without ever opening theirs, which means a project can report a screen of green checks while
// the README still says TODO.
//
// This one checks that:
//   the README exists, has a Status section, and that section contains verify.sh's success line;
//   every number the README states about the corpus matches results/corpus.json;
//   docs/index.html is exactly what scripts/build-docs.mjs produces from results/;
//   every rule has a docs page and the README links to it.

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let failed = 0;
const fail = (m) => { console.error(`FAIL  ${m}`); failed += 1; };
const ok = (m) => console.log(`ok    ${m}`);

const corpus = JSON.parse(readFileSync(path.join(ROOT, 'results/corpus.json'), 'utf8'));
const handcheck = JSON.parse(readFileSync(path.join(ROOT, 'results/handcheck.json'), 'utf8'));
const readmePath = path.join(ROOT, 'README.md');

if (!existsSync(readmePath)) {
  fail('README.md does not exist');
  process.exit(1);
}
const readme = readFileSync(readmePath, 'utf8');

// Scan the prose only. The Status section is pasted verify output, and this check's own name
// appears in it, so scanning the whole file makes the README fail because it succeeded.
const [prose, status] = readme.split(/^## Status/m);
if (/TODO|FIXME|XXX/.test(prose)) fail('README.md still contains a placeholder marker');
else ok('README.md prose has no placeholder markers left in it');

if (!status) fail('README.md has no ## Status section');
else if (!status.includes('VERIFY OK')) fail('the Status section does not contain verify.sh\'s success line');
else ok('README.md has a Status section carrying real verify output');

// Numbers the README is allowed to state about the measurement, and where they come from.
const claims = [
  [corpus.corpusFiles.toLocaleString('en-US'), 'test files in the corpus'],
  [String(corpus.findings), 'findings'],
  [String(corpus.verdicts.flake), 'real flake mechanisms'],
  [String(corpus.verdicts.intentional), 'deliberately nondeterministic'],
  [String(corpus.verdicts.false), 'false positives'],
  [`${corpus.falsePositiveRatePercent}%`, 'false-positive rate'],
  [String(corpus.vendorFiles.toLocaleString('en-US')), 'vendor files'],
];
for (const [value, what] of claims) {
  if (!readme.includes(value)) fail(`README.md never states ${value} (${what})`);
}
if (!failed) ok(`README.md states all ${claims.length} measured numbers, and they match results/corpus.json`);

// handcheck.json must cover exactly the frozen findings, so the rate above is not a guess.
if (handcheck.verdicts.length !== corpus.findings) {
  fail(`results/handcheck.json has ${handcheck.verdicts.length} verdicts for ${corpus.findings} findings`);
} else {
  ok(`${handcheck.verdicts.length} hand-checked verdicts for ${corpus.findings} findings, one each`);
}
const tally = { flake: 0, intentional: 0, false: 0 };
for (const v of handcheck.verdicts) tally[v.v] += 1;
for (const k of Object.keys(tally)) {
  if (tally[k] !== corpus.verdicts[k]) {
    fail(`handcheck says ${tally[k]} ${k}, corpus.json says ${corpus.verdicts[k]}`);
  }
}

// Rule docs.
const plugin = JSON.parse(execFileSync(process.execPath, ['-e',
  'console.log(JSON.stringify(Object.keys(require("./lib/index.js").rules)))'],
  { cwd: ROOT }).toString());
for (const id of plugin) {
  const doc = path.join(ROOT, 'docs/rules', `${id}.md`);
  if (!existsSync(doc)) { fail(`docs/rules/${id}.md is missing`); continue; }
  if (!readme.includes(`docs/rules/${id}.md`)) fail(`README.md does not link to docs/rules/${id}.md`);
}
if (!failed) ok(`${plugin.length} rule docs pages exist and are linked from the README`);

// docs/index.html must be exactly what the generator produces from the measurement files.
const pagePath = path.join(ROOT, 'docs/index.html');
const before = existsSync(pagePath) ? readFileSync(pagePath, 'utf8') : null;
execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-docs.mjs')], { cwd: ROOT });
const after = readFileSync(pagePath, 'utf8');
if (before === null) {
  fail('docs/index.html did not exist and has just been generated');
} else if (before !== after) {
  fail('docs/index.html is not what scripts/build-docs.mjs produces from results/; it has been regenerated');
} else {
  ok('docs/index.html is exactly what the measurement files produce');
}

// And the page has to actually contain the numbers, not merely be generated.
for (const value of [String(corpus.findings), `${corpus.falsePositiveRatePercent}%`]) {
  if (!after.includes(value)) fail(`docs/index.html does not contain ${value}`);
}

process.exit(failed ? 1 : 0);
