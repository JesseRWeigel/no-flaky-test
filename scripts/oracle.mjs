#!/usr/bin/env node
// An independent second opinion on where the flaky constructs are.
//
// This file shares NO code with lib/. It does not import the rules, the plugin, ESLint, or the
// parser. It reads bytes and runs a hand-written scanner that understands strings, template
// literals, regular expressions and comments well enough to say, for each line, whether a
// construct appears in real CODE or only inside a string or a comment.
//
// That distinction is the whole point. A rule set implemented with regular expressions would
// report `assert.deepEqual(apis.sort(), ['Date.now()', 'new Date()'])` and
// `expectApi('/nostore', "fetch(..., { cache: 'no-store' })")`, both of which are real lines from
// real test files on this machine that are testing a static analyser and contain no clock read
// and no request at all. An AST-based rule cannot make that mistake, and this scanner exists to
// PROVE it did not, using a different implementation that could be wrong in different ways.
//
// The checks built on it, in scripts/check-corpus.mjs:
//
//   1. every line the plugin reports must contain that rule's trigger in the code stream;
//   2. no line the plugin reports may have its trigger only inside a string or a comment;
//   3. check 2 must have real opportunities to fail, counted and printed, otherwise it is
//      vacuous and says nothing.

import { readFileSync } from 'node:fs';

/**
 * Split a source file into two parallel line arrays: what is code, and what is inside a string,
 * template chunk, regex literal or comment. Both keep the original line numbering, so a lookup by
 * line works against either.
 */
export function split(source) {
  const lines = source.split('\n');
  const code = lines.map(() => '');
  const quoted = lines.map(() => '');

  let line = 0;
  let i = 0;
  const n = source.length;
  // Stack so `${ ... }` inside a template can contain another template.
  const templates = [];
  let state = 'code';
  let quote = '';
  let prevSignificant = '';

  const push = (target, ch) => {
    if (ch === '\n') return;
    if (target === 'code') code[line] += ch;
    else quoted[line] += ch;
  };

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '\n') {
      line += 1;
      i += 1;
      if (state === 'line-comment') state = 'code';
      continue;
    }

    switch (state) {
      case 'code': {
        if (ch === '/' && next === '/') { state = 'line-comment'; i += 2; continue; }
        if (ch === '/' && next === '*') { state = 'block-comment'; i += 2; continue; }
        if (ch === '"' || ch === "'") { state = 'string'; quote = ch; i += 1; continue; }
        if (ch === '`') { state = 'template'; templates.push('template'); i += 1; continue; }
        if (ch === '}' && templates.length && templates[templates.length - 1] === 'expr') {
          templates[templates.length - 1] = 'template';
          state = 'template';
          i += 1;
          continue;
        }
        if (ch === '/' && isRegexStart(prevSignificant)) { state = 'regex'; i += 1; continue; }
        push('code', ch);
        if (!/\s/.test(ch)) prevSignificant = ch;
        i += 1;
        continue;
      }
      case 'line-comment':
      case 'block-comment': {
        if (state === 'block-comment' && ch === '*' && next === '/') {
          state = 'code'; i += 2; continue;
        }
        push('quoted', ch);
        i += 1;
        continue;
      }
      case 'string': {
        if (ch === '\\') { push('quoted', ch); i += 2; continue; }
        if (ch === quote) { state = 'code'; prevSignificant = quote; i += 1; continue; }
        push('quoted', ch);
        i += 1;
        continue;
      }
      case 'regex': {
        if (ch === '\\') { i += 2; continue; }
        if (ch === '[') { // a `/` inside a character class does not end the literal
          while (i < n && source[i] !== ']') {
            if (source[i] === '\n') line += 1;
            i += 1;
          }
          i += 1;
          continue;
        }
        if (ch === '/') { state = 'code'; prevSignificant = '/'; i += 1; continue; }
        push('quoted', ch);
        i += 1;
        continue;
      }
      case 'template': {
        if (ch === '\\') { push('quoted', ch); i += 2; continue; }
        if (ch === '`') { templates.pop(); state = templates.length ? 'template' : 'code'; i += 1; continue; }
        if (ch === '$' && next === '{') {
          templates[templates.length - 1] = 'expr';
          state = 'code';
          i += 2;
          continue;
        }
        push('quoted', ch);
        i += 1;
        continue;
      }
      default:
        i += 1;
    }
  }
  return { code, quoted, lines: lines.length };
}

// A `/` starts a regex literal unless the previous significant character could end an expression.
function isRegexStart(prev) {
  if (prev === '') return true;
  return !/[A-Za-z0-9_$)\]}]/.test(prev);
}

/**
 * The syntactic trigger for each rule: what must be physically present on the reported line, or
 * within a couple of lines of it, for the report to be about anything at all.
 */
export const TRIGGERS = {
  'no-bare-timeout': /setTimeout|waitForTimeout|\b(sleep|wait|delay|pause)\s*\(/,
  'no-unmocked-time': /Date\s*\.\s*now|new\s+Date|performance\s*\.\s*now/,
  'no-unseeded-random': /Math\s*\.\s*random|randomUUID|randomBytes|getRandomValues|faker\s*\./,
  'no-floating-promise': /[\w$)\]]\s*\(|\.\s*(rejects|resolves)\b|forEach/,
  'no-unordered-assert': /readdir|glob|Promise\s*\.\s*(race|any)|\[\s*\d+\s*\]/,
  'no-live-network': /fetch|axios|got|http|request|WebSocket|EventSource/,
};

/** Lines where the rule's trigger appears in code, and lines where it appears only when quoted. */
export function scan(path) {
  const source = readFileSync(path, 'utf8');
  const { code, quoted, lines } = split(source);
  const out = {};
  for (const [rule, pattern] of Object.entries(TRIGGERS)) {
    const inCode = new Set();
    const onlyQuoted = new Set();
    for (let l = 0; l < lines; l++) {
      const hitCode = pattern.test(code[l]);
      const hitQuoted = pattern.test(quoted[l]);
      if (hitCode) inCode.add(l + 1);
      else if (hitQuoted) onlyQuoted.add(l + 1);
    }
    out[rule] = { inCode, onlyQuoted };
  }
  return out;
}

// Only act as a CLI when run directly. Imported as a module, argv belongs to somebody else, and
// reading argv[2] here made `check-corpus.mjs --corpus x` try to open a file called "--corpus".
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2]) {
  const result = scan(process.argv[2]);
  for (const [rule, sets] of Object.entries(result)) {
    process.stdout.write(`${rule}: code ${[...sets.inCode].join(',')} | quoted-only ${[...sets.onlyQuoted].join(',')}\n`);
  }
}
