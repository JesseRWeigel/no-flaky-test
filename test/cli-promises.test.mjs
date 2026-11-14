import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('real ESLint CLI catches discarded promises and accepts the repaired test', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'flaky-cli-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const config = path.join(cwd, 'eslint.config.cjs');
  fs.writeFileSync(config, `const plugin = require(${JSON.stringify(path.join(root, 'lib/index.js'))});\nmodule.exports = [{ plugins: { flaky: plugin }, rules: { 'flaky/no-floating-promise': 'error' } }];\n`);
  const file = path.join(cwd, 'flow.test.js');
  const eslint = path.join(path.dirname(require.resolve('eslint/package.json')), 'bin/eslint.js');
  const run = () => spawnSync(process.execPath, [eslint, '--config', config, '--format', 'json', file], { cwd, encoding: 'utf8' });
  fs.writeFileSync(file, `async function load() {}\nit('flow', () => { const pending = load(); [1, 2].forEach(async n => load(n)); });`);
  let result = run();
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.deepEqual(JSON.parse(result.stdout)[0].messages.map(m => m.messageId).sort(), ['asyncCall', 'forEachAsync']);
  fs.writeFileSync(file, `async function load() {}\nit('flow', async () => { const pending = load(); await pending; await Promise.all([1, 2].map(async n => load(n))); });`);
  result = run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(JSON.parse(result.stdout)[0].messages.length, 0);
});
