#!/usr/bin/env node
// Measure the rules against the real corpus and check three things that can each be wrong on
// their own:
//
//   1. the findings still match results/corpus.json exactly, so a change that silently alters
//      what the rules report cannot pass;
//   2. every finding is confirmed by scripts/oracle.mjs, an independent scanner that shares no
//      code with lib/, including the negative half: no finding may sit on a line whose trigger
//      exists only inside a string or a comment;
//   3. every finding has a hand-checked verdict in results/handcheck.json, and the false-positive
//      rate printed here is computed from those verdicts rather than asserted.
//
// Usage:
//   node scripts/check-corpus.mjs --corpus ~/Projects            check against the frozen record
//   node scripts/check-corpus.mjs --corpus ~/Projects --freeze   rewrite the frozen record

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect } from './collect-corpus.mjs';
import { lintAll, stage } from './scan.mjs';
import { scan as oracleScan, TRIGGERS } from './oracle.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const FROZEN = path.join(ROOT, 'results', 'corpus.json');
const HANDCHECK = path.join(ROOT, 'results', 'handcheck.json');

function key(f) {
  return `${f.file}:${f.line}:${f.rule}:${f.messageId}`;
}

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exitCode = 1;
}

async function main() {
  const argv = process.argv.slice(2);
  const freeze = argv.includes('--freeze');
  const idx = argv.indexOf('--corpus');
  const corpus = idx === -1 ? null : path.resolve(argv[idx + 1]);

  if (!corpus || !existsSync(corpus)) {
    // A check that cannot run has to say so. Reporting success here would mean the frozen numbers
    // in the README were never compared against anything.
    console.error('COULD NOT RUN: no corpus.');
    console.error(`  ${corpus || '(--corpus not given)'} does not exist.`);
    console.error('  This check measures the rules against real test suites on disk. Without them');
    console.error('  nothing is measured, so this is a failure and not a skip. Point --corpus at a');
    console.error('  directory of JavaScript or TypeScript projects, or run scripts/verify.sh with');
    console.error('  FLAKY_CORPUS set.');
    process.exit(2);
  }

  const halves = collect(corpus);
  const own = await lintAll(halves.own);
  const stagedVendor = stage(halves.vendor);
  let vendor;
  try {
    vendor = await lintAll(stagedVendor.entries);
  } finally {
    stagedVendor.cleanup();
  }

  for (const half of [own, vendor]) {
    for (const item of half.notLinted) fail(`not linted: ${item.file}: ${item.reason}`);
    for (const item of half.parseFailures) fail(`parse failure: ${item.file}: ${item.error}`);
  }

  const allFindings = [...own.findings, ...vendor.findings];
  const presentLabels = [...halves.own, ...halves.vendor].map((e) => e.label);
  const files = halves.own.length + halves.vendor.length;
  const lines = own.lines + vendor.lines;

  // Other work on this machine adds and removes test files while this project is being built, so
  // the corpus is not the same set twice. Comparing a whole-corpus total against a frozen total
  // would then fail for reasons that have nothing to do with the rules. The frozen record names
  // the exact files it measured, and the comparison runs over the files present in both. Files on
  // only one side are counted and printed rather than silently folded in.
  const frozenRecord = existsSync(FROZEN) ? JSON.parse(readFileSync(FROZEN, 'utf8')) : null;
  const scope = freeze || !frozenRecord ? null : new Set(frozenRecord.corpusLabels);
  const findings = scope ? allFindings.filter((f) => scope.has(f.file)) : allFindings;

  const byRule = {};
  for (const f of findings) {
    const id = `${f.rule}/${f.messageId}`;
    byRule[id] = (byRule[id] || 0) + 1;
  }

  console.log(`corpus: ${files} test files, ${lines} lines`);
  console.log(`        ${halves.own.length} from working repositories, ${halves.vendor.length} shipped by npm packages`);
  console.log(`findings: ${findings.length}`);
  for (const [id, count] of Object.entries(byRule).sort()) {
    console.log(`        ${String(count).padStart(4)}  ${id}`);
  }

  // ---- 2. the independent scanner ------------------------------------------------------------
  const paths = new Map();
  for (const e of [...halves.own, ...halves.vendor]) paths.set(e.label, e.path);

  let confirmed = 0;
  let quotedOnlyOpportunities = 0;
  const unconfirmed = [];
  const quotedOnlyReports = [];
  const oracleCache = new Map();
  const oracleFor = (label) => {
    if (!oracleCache.has(label)) oracleCache.set(label, oracleScan(paths.get(label)));
    return oracleCache.get(label);
  };

  for (const f of findings) {
    const sets = oracleFor(f.file)[f.rule];
    // The reported node can start a line or two above the trigger token, for example a rule that
    // reports at the enclosing declaration. A window of two lines each way is enough and still
    // far short of "anywhere in the file".
    let inCode = false;
    let quotedOnly = false;
    for (let l = f.line - 2; l <= f.line + 2; l++) {
      if (sets.inCode.has(l)) inCode = true;
      if (sets.onlyQuoted.has(l)) quotedOnly = true;
    }
    if (inCode) confirmed += 1;
    else if (quotedOnly) quotedOnlyReports.push(f);
    else unconfirmed.push(f);
  }

  // The negative half has to have had a chance to fail, otherwise it proves nothing.
  for (const [label, p] of paths) {
    if (!p) continue;
    let sets;
    try {
      sets = oracleFor(label);
    } catch {
      continue;
    }
    for (const rule of Object.keys(TRIGGERS)) {
      quotedOnlyOpportunities += sets[rule].onlyQuoted.size;
    }
  }

  console.log(`independent scanner: ${confirmed}/${findings.length} findings confirmed present in code`);
  console.log(`        ${quotedOnlyOpportunities} lines in the corpus carry a trigger only inside a string or comment`);
  console.log('        (a regex-based implementation would report those; none of them was reported)');
  if (unconfirmed.length) {
    fail(`${unconfirmed.length} findings the independent scanner cannot find any trigger for`);
    for (const f of unconfirmed.slice(0, 5)) console.error(`      ${key(f)}`);
  }
  if (quotedOnlyReports.length) {
    fail(`${quotedOnlyReports.length} findings land on a trigger that exists only inside a string or comment`);
    for (const f of quotedOnlyReports.slice(0, 5)) console.error(`      ${key(f)}`);
  }
  if (quotedOnlyOpportunities < 20) {
    fail(`only ${quotedOnlyOpportunities} quoted-only trigger lines in the whole corpus; the string-vs-code check is close to vacuous`);
  }

  // ---- 3. hand-checked verdicts --------------------------------------------------------------
  const handcheck = JSON.parse(readFileSync(HANDCHECK, 'utf8'));
  const verdictFor = new Map();
  for (const v of handcheck.verdicts) {
    const k = `${v.file}:${v.line}:${v.rule}`;
    if (!verdictFor.has(k)) verdictFor.set(k, []);
    verdictFor.get(k).push(v.v);
  }
  const counts = { flake: 0, intentional: 0, false: 0 };
  const unjudged = [];
  const seen = new Map();
  for (const f of findings) {
    const k = `${f.file}:${f.line}:${f.rule}`;
    const list = verdictFor.get(k);
    const used = seen.get(k) || 0;
    if (!list || used >= list.length) {
      unjudged.push(k);
      continue;
    }
    counts[list[used]] += 1;
    seen.set(k, used + 1);
  }
  let stale = 0;
  for (const [k, list] of verdictFor) {
    const used = seen.get(k) || 0;
    if (used < list.length) stale += list.length - used;
  }
  if (unjudged.length) {
    fail(`${unjudged.length} findings have no hand-checked verdict in results/handcheck.json`);
    for (const k of unjudged.slice(0, 5)) console.error(`      ${k}`);
  }
  if (stale) {
    fail(`${stale} verdicts in results/handcheck.json no longer correspond to a finding`);
  }

  const judged = counts.flake + counts.intentional + counts.false;
  const fpRate = judged ? (counts.false / judged) * 100 : 0;
  console.log(`hand-checked: ${judged}/${findings.length} findings judged individually`);
  console.log(`        ${counts.flake} real flake mechanisms`);
  console.log(`        ${counts.intentional} correctly detected, deliberately nondeterministic`);
  console.log(`        ${counts.false} false positives`);
  console.log(`false-positive rate: ${fpRate.toFixed(1)}%`);

  // ---- 1. the frozen record ------------------------------------------------------------------
  if (freeze) {
    const record = {
      corpusFiles: files,
      ownFiles: halves.own.length,
      vendorFiles: halves.vendor.length,
      corpusLines: lines,
      findings: findings.length,
      byRule,
      verdicts: counts,
      falsePositiveRatePercent: Number(fpRate.toFixed(1)),
      keys: findings.map(key).sort(),
      corpusLabels: presentLabels.slice().sort(),
    };
    writeFileSync(FROZEN, JSON.stringify(record, null, 2) + '\n');
    console.log(`froze results/corpus.json (${files} files, ${findings.length} findings)`);
    return;
  }

  const frozen = frozenRecord;
  const present = new Set(presentLabels);
  const shared = frozen.corpusLabels.filter((l) => present.has(l));
  const missing = frozen.corpusLabels.length - shared.length;
  const extra = presentLabels.filter((l) => !scope.has(l)).length;
  console.log(`frozen record: ${frozen.corpusLabels.length} files, ${shared.length} still present`);
  if (extra) console.log(`        ${extra} files on disk are newer than the frozen record and are not compared`);
  if (shared.length < frozen.corpusLabels.length * 0.9) {
    console.error('COULD NOT COMPARE: too little of the frozen corpus is still on this machine.');
    console.error(`  frozen ${frozen.corpusLabels.length} files, ${shared.length} found, ${missing} gone.`);
    console.error('  The numbers in the README were measured against files that are no longer here,');
    console.error('  so this is a failure and not a pass. Re-measure with --freeze after reading');
    console.error('  the new findings by hand, or run against the original corpus.');
    process.exit(3);
  }
  if (missing) console.log(`        ${missing} frozen files are gone; their findings are not required`);

  // Multiset comparison, not set comparison. Three findings share the line
  // prismarine-world/test/test.js:67, because three Math.random() calls sit on it, and a Set
  // collapsed them into one and reported 98 where there are 102.
  const bag = (keys) => {
    const m = new Map();
    for (const k of keys) m.set(k, (m.get(k) || 0) + 1);
    return m;
  };
  const nowBag = bag(findings.map(key));
  const frozenBag = bag(frozen.keys.filter((k) => present.has(k.split(':')[0])));
  const added = [];
  const removed = [];
  for (const [k, count] of nowBag) {
    const was = frozenBag.get(k) || 0;
    for (let i = was; i < count; i++) added.push(k);
  }
  for (const [k, count] of frozenBag) {
    const now = nowBag.get(k) || 0;
    for (let i = now; i < count; i++) removed.push(k);
  }
  if (added.length || removed.length) {
    fail(`findings changed on the frozen corpus: ${added.length} new, ${removed.length} gone`);
    for (const k of added.slice(0, 6)) console.error(`      + ${k}`);
    for (const k of removed.slice(0, 6)) console.error(`      - ${k}`);
  } else {
    console.log(`findings match the frozen record exactly: ${findings.length} findings`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
