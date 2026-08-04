#!/usr/bin/env node
// Run the plugin over a corpus of real test files and print one JSON record per finding.
//
//   node scripts/scan.mjs --corpus ~/Projects            both halves, see collect-corpus.mjs
//   node scripts/scan.mjs --files a.test.ts b.test.ts    an explicit list
//
// Output carries labels (repository-relative path, or package name plus path inside the package),
// line numbers and rule ids. No source text, no absolute paths, so the result can be committed.

import { readFileSync, existsSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { collect } from './collect-corpus.mjs';

const require_ = createRequire(import.meta.url);
const HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/** Deepest directory containing every file, so ESLint's base path covers the whole corpus. */
function commonRoot(files) {
  if (files.length === 0) return process.cwd();
  let parts = path.dirname(files[0]).split(path.sep);
  for (const file of files.slice(1)) {
    const other = path.dirname(file).split(path.sep);
    let i = 0;
    while (i < parts.length && i < other.length && parts[i] === other[i]) i++;
    parts = parts.slice(0, i);
  }
  return parts.join(path.sep) || path.sep;
}

export async function makeLinter(files, pluginPath) {
  const { ESLint } = require_('eslint');
  const plugin = require_(pluginPath || path.join(HERE, 'lib/index.js'));
  const tsParser = require_('@typescript-eslint/parser');
  return {
    plugin,
    eslint: new ESLint({
      // cwd must contain every file being linted. ESLint 9 answers "File ignored because outside
      // of base path" for anything above it, and with warnIgnored suppressed that answer is
      // indistinguishable from a clean file: zero findings, zero errors, exit 0. The first run of
      // this script reported 305 files scanned and 0 problems for exactly that reason.
      cwd: commonRoot(files),
      overrideConfigFile: true,
      overrideConfig: [{
        // Without an explicit `files`, a flat config applies only to .js/.mjs/.cjs, and every
        // TypeScript file comes back as "ignored because no matching configuration was supplied".
        // Same silent shape as above; it cost a second wrong measurement before this line existed.
        files: ['**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}'],
        languageOptions: {
          parser: tsParser,
          parserOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            ecmaFeatures: { jsx: true },
          },
        },
        // noInlineConfig for two reasons. A file's own `// eslint-disable-next-line
        // @typescript-eslint/no-floating-promises` makes ESLint report "definition for rule was
        // not found" as a finding with that rule's id, which polluted the first vendor run with
        // 50 findings attributed to plugins that were never loaded. And a measurement of how
        // often these rules fire must not be silenced by disable comments written for other
        // plugins.
        linterOptions: { reportUnusedDisableDirectives: false, noInlineConfig: true },
        plugins: { 'no-flaky-test': plugin },
        rules: Object.fromEntries(
          Object.keys(plugin.rules).map((id) => [`no-flaky-test/${id}`, 'error']),
        ),
      }],
      ignore: false,
    }),
  };
}

/**
 * ESLint 9 ignores anything under a node_modules directory and no `ignores` pattern and no
 * `ignore: false` turns that off; every attempt returns "File ignored by default", which is the
 * same empty result as a clean file. The vendor half of the corpus lives in node_modules, so it
 * gets staged into a temporary tree first, keeping the path inside the package intact so the
 * rules still see `qs/test/parse.js` and treat it as a test.
 */
export function stage(entries) {
  if (entries.length === 0) return { entries, cleanup() {} };
  const root = mkdtempSync(path.join(tmpdir(), 'no-flaky-corpus-'));
  const staged = entries.map((entry, index) => {
    const safe = entry.label.replace(/\.\./g, '_');
    const target = path.join(root, String(index), safe);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(entry.path, target);
    return { path: target, label: entry.label };
  });
  return { entries: staged, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export async function lintAll(entries, pluginPath) {
  const { eslint } = await makeLinter(entries.map((e) => e.path), pluginPath);
  const findings = [];
  const notLinted = [];
  const parseFailures = [];
  let lines = 0;
  let scanned = 0;

  for (const entry of entries) {
    let source;
    try {
      source = readFileSync(entry.path, 'utf8');
    } catch {
      continue;
    }
    let results;
    try {
      results = await eslint.lintText(source, { filePath: entry.path, warnIgnored: true });
    } catch (err) {
      parseFailures.push({ file: entry.label, error: String(err.message).slice(0, 140) });
      continue;
    }
    let usable = true;
    for (const result of results) {
      for (const message of result.messages) {
        if (/File ignored/i.test(message.message || '')) {
          // Loud on purpose: an ignored file produces the same empty result as a clean one.
          notLinted.push({ file: entry.label, reason: message.message });
          usable = false;
          continue;
        }
        // noInlineConfig makes ESLint announce every disable comment it declined to honour. That
        // is expected here and says nothing about the file. Treated as a parse failure it threw
        // away 481 of 1600 vendor files while reporting them as unparseable, which is a wrong
        // number in the safe-looking direction.
        if (!message.ruleId && /has no effect because you have 'noInlineConfig'/.test(
          message.message || '')) {
          continue;
        }
        if (message.fatal || !message.ruleId) {
          parseFailures.push({ file: entry.label, error: String(message.message).slice(0, 140) });
          usable = false;
          continue;
        }
        findings.push({
          file: entry.label,
          line: message.line,
          column: message.column,
          rule: message.ruleId.replace('no-flaky-test/', ''),
          messageId: message.messageId,
        });
      }
    }
    if (usable) {
      scanned += 1;
      lines += source.split('\n').length;
    }
  }
  return { files: entries.length, scanned, lines, findings, notLinted, parseFailures };
}

async function main() {
  const argv = process.argv.slice(2);
  let corpus = null;
  let explicit = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--corpus') corpus = path.resolve(argv[++i]);
    else if (argv[i] === '--files') explicit = argv.slice(i + 1).map((p) => path.resolve(p));
  }
  if (!corpus && explicit.length === 0) {
    console.error('usage: scan.mjs --corpus <dir> | --files <file...>');
    process.exit(2);
  }

  let halves;
  if (explicit.length) {
    halves = { own: explicit.map((p) => ({ path: p, label: path.basename(p) })), vendor: [] };
  } else {
    if (!existsSync(corpus)) {
      console.error(`CORPUS MISSING: ${corpus} does not exist, so nothing was measured.`);
      process.exit(3);
    }
    halves = collect(corpus);
  }

  const own = await lintAll(halves.own);
  const stagedVendor = stage(halves.vendor);
  let vendor;
  try {
    vendor = await lintAll(stagedVendor.entries);
  } finally {
    stagedVendor.cleanup();
  }

  for (const half of [own, vendor]) {
    for (const item of half.notLinted) console.error(`NOT LINTED: ${item.file}: ${item.reason}`);
  }
  if (own.notLinted.length || vendor.notLinted.length) process.exitCode = 4;

  process.stdout.write(JSON.stringify({ own, vendor }, null, 2) + '\n');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
