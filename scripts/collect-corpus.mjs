#!/usr/bin/env node
// Build the list of test files to measure against, in two parts.
//
//   own      test files in the working repositories on this machine
//   vendor   test files that published npm packages ship inside node_modules
//
// The vendor half matters more for precision than the own half. It is test code written by other
// people, reviewed by other people, and depended on by a lot of projects. If a rule fires on it,
// the burden is on the rule. Files are deduplicated by content hash, because the same package is
// installed under a dozen projects here and counting it a dozen times would inflate every number.
//
// Nothing from either corpus is copied into this repository. Only counts, relative paths, and
// package names leave this script.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const TEST_NAME = /\.(test|spec)\.[cm]?[jt]sx?$/;
const TEST_DIR = /(^|\/)(test|tests|__tests__|e2e|spec|specs)(\/|$)/;
const CODE = /\.[cm]?[jt]sx?$/;
const SKIP = new Set([
  '.git', '.next', 'dist', 'build', 'coverage', '.venv', 'venv', '__pycache__', '.cache',
  '.turbo', 'worktrees', '.worktrees', '.nyc_output', 'flow-typed', 'browser',
]);

function walk(root, { intoNodeModules, onFile, maxDepth = 14 }) {
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    if (depth > maxDepth) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP.has(entry.name)) continue;
        if (entry.name === 'node_modules' && !intoNodeModules) continue;
        stack.push([full, depth + 1]);
      } else if (entry.isFile() && CODE.test(entry.name)) {
        onFile(full);
      }
    }
  }
}

const versionCache = new Map();
function versionOf(packageRoot) {
  if (versionCache.has(packageRoot)) return versionCache.get(packageRoot);
  let version = 'unknown';
  try {
    version = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version
      || 'unknown';
  } catch { /* a package without a readable manifest still counts, just without a version */ }
  versionCache.set(packageRoot, version);
  return version;
}

function isTestPath(rel, name) {
  return TEST_NAME.test(name) || TEST_DIR.test(`/${rel}`);
}

export function collect(root) {
  const own = [];
  const vendor = [];
  const seen = new Set();

  walk(root, {
    intoNodeModules: true,
    onFile(full) {
      const rel = path.relative(root, full).split(path.sep).join('/');
      const name = path.basename(full);
      if (!isTestPath(rel, name)) return;
      const inVendor = rel.includes('node_modules/');
      let size;
      try {
        size = statSync(full).size;
      } catch {
        return;
      }
      if (size > 400000) return;
      let text;
      try {
        text = readFileSync(full);
      } catch {
        return;
      }
      const hash = createHash('sha256').update(text).digest('hex');
      if (seen.has(hash)) return;
      seen.add(hash);
      if (inVendor) {
        const marker = rel.lastIndexOf('node_modules/');
        const after = rel.slice(marker + 'node_modules/'.length);
        const parts = after.split('/');
        const pkg = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
        // Two projects here install different versions of the same package, and their test files
        // differ, so both survive the content-hash dedup and would otherwise share a label. The
        // version disambiguates them and makes a finding traceable.
        const pkgRoot = full.slice(0, marker + 'node_modules/'.length + pkg.length);
        vendor.push({
          path: full,
          label: `${pkg}@${versionOf(pkgRoot)}/${parts.slice(pkg.split('/').length).join('/')}`,
        });
      } else {
        own.push({ path: full, label: rel });
      }
    },
  });

  own.sort((a, b) => a.label.localeCompare(b.label));
  vendor.sort((a, b) => a.label.localeCompare(b.label));
  return { own, vendor };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const root = path.resolve(process.argv[2] || path.join(process.env.HOME || '.', 'Projects'));
  const { own, vendor } = collect(root);
  process.stdout.write(JSON.stringify({ root, own, vendor }, null, 2) + '\n');
  console.error(`own ${own.length} files, vendor ${vendor.length} files (deduplicated)`);
}
