// Rule tests. Every invalid case is paired with a valid case that must NOT report, because a
// lint rule that fires on correct code is worse than no rule at all: it gets switched off, and
// the real findings go with it. The `valid` arrays here are the negative controls.

import test from 'node:test';
import assert from 'node:assert/strict';
import { RuleTester } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import plugin from '../lib/index.js';

const tester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
  },
});

// RuleTester throws on the first failure, so each run is wrapped in a node:test case to keep the
// failure attributable to one rule.
function run(name, cases) {
  test(name, () => {
    tester.run(name, plugin.rules[name], cases);
  });
}

const FILE = { filename: 'a.test.ts' };

run('no-bare-timeout', {
  valid: [
    // A timer that drives a mock and is awaited through the thing it resolves is deterministic.
    { ...FILE, code: `it('x', async () => { const p = new Promise(r => { emitter.on('done', r); }); setTimeout(() => emitter.emit('done'), 10); await p; });` },
    // Fake timers advanced explicitly.
    { ...FILE, code: `it('x', () => { vi.useFakeTimers(); vi.advanceTimersByTime(500); });` },
    // Waiting on a condition rather than on the clock.
    { ...FILE, code: `it('x', async () => { await waitFor(() => expect(el).toBeVisible()); });` },
    { ...FILE, code: `it('x', async () => { await page.waitForResponse('**/api'); });` },
    // setTimeout outside a test body, defining a helper, is reported at its call sites instead.
    { ...FILE, code: `const sleep = ms => new Promise(r => setTimeout(r, ms));` },
    // A delay inside a fixture that simulates slow work, with no assertion after it in the same
    // function. zod's codec tests and fastq's queue worker both look like this.
    { ...FILE, code: `it('x', async () => { const codec = { decode: async (s) => { await new Promise(r => setTimeout(r, 1)); return Number(s); } }; expect(await codec.decode('1')).toBe(1); });` },
    // A delayed VALUE rather than a sleep.
    { ...FILE, code: `it('x', async () => { const late = () => new Promise(r => setTimeout(() => r(true), 50)); expect(await late()).toBe(true); });` },
    // Not a test file at all.
    { filename: 'src/app.ts', code: `it('x', async () => { await new Promise(r => setTimeout(r, 500)); });` },
    // Zero delay allowed by option.
    {
      ...FILE,
      code: `it('x', async () => { await new Promise(r => setTimeout(r, 0)); expect(a).toBe(1); });`,
      options: [{ allowZeroDelay: true }],
    },
  ],
  invalid: [
    {
      ...FILE,
      code: `it('x', async () => { await new Promise(r => setTimeout(r, 500)); expect(a).toBe(1); });`,
      errors: [{ messageId: 'sleep' }],
    },
    {
      ...FILE,
      code: `const sleep = ms => new Promise(r => setTimeout(r, ms));\nit('x', async () => { await sleep(250); expect(el.visible).toBe(true); });`,
      errors: [{ messageId: 'sleep' }],
    },
    {
      ...FILE,
      code: `it('x', async () => { await page.waitForTimeout(150); });`,
      errors: [{ messageId: 'waitForTimeout' }],
    },
    {
      ...FILE,
      code: `it('x', (done) => { setTimeout(done, 100); });`,
      errors: [{ messageId: 'doneTimer' }],
    },
    {
      ...FILE,
      code: `it('x', async () => { await new Promise(r => setTimeout(r, 0)); expect(el.visible).toBe(true); });`,
      errors: [{ messageId: 'sleep' }],
    },
  ],
});

run('no-unmocked-time', {
  valid: [
    // Fixture filler. Nothing asserts on it. This is the single commonest shape in real suites.
    { ...FILE, code: `it('x', () => { const row = { createdAt: new Date().toISOString() }; expect(row.id).toBe(1); });` },
    { ...FILE, code: `it('x', () => { const c = { createdAt: new Date() }; expect(c.name).toBe('a'); });` },
    // An hour of slack: millisecond drift cannot reach it.
    { ...FILE, code: `it('x', () => { const d = new Date(Date.now() + 3600000); expect(isDue(d)).toBe(false); });` },
    { ...FILE, code: `it('x', () => { const d = new Date(Date.now() - 1000 * 60 * 60 * 24); expect(isDue(d)).toBe(true); });` },
    // The file controls the clock, so these reads are reads of a fake clock.
    { ...FILE, code: `beforeEach(() => vi.useFakeTimers());\nit('x', () => { expect(f()).toBe(Date.now()); });` },
    { ...FILE, code: `vi.spyOn(Date, 'now').mockReturnValue(0);\nit('x', () => { const n = Date.now(); expect(n).toBe(0); });` },
    // A default parameter, not the value the test uses.
    { ...FILE, code: `function badge(d, ref) { const now = ref || new Date(); return now.getFullYear(); }\nit('x', () => { expect(badge('a', new Date(0))).toBe(1970); });` },
    // Clock as input to a shape assertion. No instant can make this fail.
    { ...FILE, code: `it('x', () => { expect(parse(new Date().toISOString())).toBeInstanceOf(Date); });` },
    { ...FILE, code: `it('x', () => { t.equal(false, isRegExp(new Date()), 'not a regexp'); });` },
    // An explicit instant.
    { ...FILE, code: `it('x', () => { const d = new Date('2020-01-01'); expect(d.getFullYear()).toBe(2020); });` },
  ],
  invalid: [
    {
      ...FILE,
      code: `it('x', () => { const now = new Date(); const key = String(now.getMonth()); expect(todayKey()).toBe(key); });`,
      errors: [{ messageId: 'calendar' }],
    },
    {
      ...FILE,
      code: `it('x', () => { const d = new Date(); const day = new Date(d); expect(day.getDate()).toBe(1); });`,
      errors: [{ messageId: 'calendar' }],
    },
    {
      ...FILE,
      code: `it('x', () => { expect(row.createdAt).toBe(Date.now()); });`,
      errors: [{ messageId: 'race' }],
    },
    {
      ...FILE,
      code: `it('x', () => { const start = Date.now(); work(); const ms = Date.now() - start; expect(ms).toBeLessThan(50); });`,
      errors: [{ messageId: 'elapsed' }],
    },
    {
      ...FILE,
      code: `it('x', () => { const start = performance.now(); work(); assert.ok(performance.now() - start < 20); });`,
      errors: [{ messageId: 'elapsed' }],
    },
  ],
});

run('no-unseeded-random', {
  valid: [
    // Uniqueness, not test input.
    { ...FILE, code: `it('x', () => { const dir = 'tmp-' + Math.random(); expect(mk(dir)).toBe(true); });` },
    { ...FILE, code: `it('x', () => { const url = \`/a?cb=\${Math.random()}\`; expect(url).toContain('/a'); });` },
    // Seeded.
    { ...FILE, code: `import seedrandom from 'seedrandom';\nit('x', () => { expect(f(Math.random())).toBe(1); });` },
    { ...FILE, code: `vi.spyOn(Math, 'random').mockReturnValue(0.5);\nit('x', () => { expect(f(Math.random())).toBe(1); });` },
    // Constant conditions dressed up as randomness.
    { ...FILE, code: `it('x', () => { const v = Math.random() ? 'a' : undefined; expect(typeof v).toBe('string'); });` },
    { ...FILE, code: `it('x', () => { const v = Math.random() > 0 ? 'a' : undefined; expect(typeof v).toBe('string'); });` },
    // Shape-only assertion: every draw behaves the same.
    { ...FILE, code: `it('x', () => { expect(() => schema.parse(Math.random())).toThrow(); });` },
    // crypto.randomUUID is off by default.
    { ...FILE, code: `it('x', () => { const id = crypto.randomUUID(); expect(save(id)).toBe(true); });` },
    // faker with a seed.
    { ...FILE, code: `beforeEach(() => faker.seed(1));\nit('x', () => { expect(f(faker.person.firstName())).toBe(1); });` },
  ],
  invalid: [
    {
      ...FILE,
      code: `it('x', () => { const n = Math.floor(Math.random() * 100); expect(choices(n)).toContain(n); });`,
      errors: [{ messageId: 'random' }],
    },
    {
      ...FILE,
      code: `it('x', () => { expect(clamp(Math.random() * 10)).toBeLessThan(10); });`,
      errors: [{ messageId: 'random' }],
    },
    {
      ...FILE,
      code: `it('x', () => { if (Math.random() > 0.5) { expect(a).toBe(1); } });`,
      errors: [{ messageId: 'random' }],
    },
    {
      ...FILE,
      code: `it('x', () => { const id = crypto.randomUUID(); expect(save(id)).toBe(true); });`,
      options: [{ reportUuid: true }],
      errors: [{ messageId: 'uuid' }],
    },
    {
      ...FILE,
      code: `it('x', () => { expect(f(faker.person.firstName())).toBe(1); });`,
      errors: [{ messageId: 'faker' }],
    },
  ],
});

run('no-floating-promise', {
  valid: [
    { ...FILE, code: `const load = async () => {};\nit('x', async () => { await load(); });` },
    { ...FILE, code: `const load = async () => {};\nit('x', () => load());` },
    { ...FILE, code: `const load = async () => {};\nit('x', () => { return load(); });` },
    { ...FILE, code: `const load = async () => {};\nit('x', () => { load().catch(() => {}); });` },
    { ...FILE, code: `const load = async () => {};\nit('x', async () => { await Promise.all([load(), load()]); });` },
    // Two different `fn` in two scopes, one async and one not. The synchronous one is correct.
    { ...FILE, code: `it('a', async () => { const fn = async () => {}; await fn(); });\nit('b', () => { function fn() {} fn(); });` },
    // A callback is a way of handling completion.
    { ...FILE, code: `const load = async (cb) => {};\nit('x', (done) => { load(() => done()); });` },
    { ...FILE, code: `it('x', async () => { await expect(f()).rejects.toThrow(); });` },
    { ...FILE, code: `it('x', () => expect(f()).resolves.toBe(1));` },
    // forEach with a synchronous callback is fine.
    { ...FILE, code: `it('x', () => { [1, 2].forEach((n) => { expect(n).toBeGreaterThan(0); }); });` },
    // An async forEach callback with no await inside cannot be dropping anything interesting.
    { ...FILE, code: `it('x', () => { [1, 2].forEach(async (n) => { record(n); }); });` },
  ],
  invalid: [
    {
      ...FILE,
      code: `const load = async () => {};\nit('x', () => { load(); });`,
      errors: [{ messageId: 'asyncCall' }],
    },
    {
      ...FILE,
      code: `async function load() {}\nit('x', function () { load(); });`,
      errors: [{ messageId: 'asyncCall' }],
    },
    {
      ...FILE,
      code: `it('x', () => { expect(f()).rejects.toThrow('boom'); });`,
      errors: [{ messageId: 'expectAsync' }],
    },
    {
      ...FILE,
      code: `it('x', () => { [1, 2].forEach(async (n) => { await check(n); expect(n).toBe(1); }); });`,
      errors: [{ messageId: 'forEachAsync' }],
    },
  ],
});

run('no-unordered-assert', {
  valid: [
    { ...FILE, code: `it('x', () => { assert.deepEqual(fs.readdirSync(d).sort(), ['a', 'b']); });` },
    { ...FILE, code: `it('x', () => { const f = fs.readdirSync(d); assert.equal(f.length, 2); });` },
    { ...FILE, code: `it('x', () => { const f = fs.readdirSync(d); assert.equal(1, f.length); assert.equal('a', f[0]); });` },
    { ...FILE, code: `it('x', async () => { expect(await readdir(d)).toEqual(expect.arrayContaining(['a'])); });` },
    { ...FILE, code: `it('x', () => { for (const n of fs.readdirSync(d)) check(n); });` },
    // Object key order and Set iteration order are defined by the language, so these are correct.
    { ...FILE, code: `it('x', () => { expect(Object.keys(o)).toEqual(['a', 'b']); });` },
    { ...FILE, code: `it('x', () => { expect([...new Set(['a', 'b'])]).toEqual(['a', 'b']); });` },
    { ...FILE, code: `it('x', async () => { expect(await Promise.all([a(), b()])).toEqual([1, 2]); });` },
  ],
  invalid: [
    {
      ...FILE,
      code: `it('x', () => { assert.deepEqual(fs.readdirSync(d), ['a', 'b']); });`,
      errors: [{ messageId: 'listing' }],
    },
    {
      ...FILE,
      code: `it('x', async () => { const f = await readdir(d); expect(f).toEqual(['a', 'b']); });`,
      errors: [{ messageId: 'listing' }],
    },
    {
      ...FILE,
      code: `it('x', () => { const f = fs.readdirSync(d).map(String); expect(f).toEqual(['a', 'b']); });`,
      errors: [{ messageId: 'listing' }],
    },
    {
      ...FILE,
      code: `it('x', () => { const f = fs.readdirSync(d); expect(f[2]).toBe('c'); });`,
      errors: [{ messageId: 'index' }],
    },
  ],
});

run('no-live-network', {
  valid: [
    { ...FILE, code: `it('x', async () => { await fetch('http://localhost:3000/a'); });` },
    { ...FILE, code: `it('x', async () => { await fetch(\`\${base}/healthz\`); });` },
    { ...FILE, code: `it('x', async () => { await fetch('http://127.0.0.1:8080/a'); });` },
    { ...FILE, code: `import { setupServer } from 'msw/node';\nit('x', async () => { await fetch('https://api.example.com/a'); });` },
    { ...FILE, code: `import nock from 'nock';\nit('x', async () => { await fetch('https://registry.npmjs.org/left-pad'); });` },
    // setupServer() re-exported from a local helper, so there is no msw import to recognise.
    { ...FILE, code: `const server = setupServer();\nit('x', async () => { await fetch('https://api.example.com/v1'); });` },
    { ...FILE, code: `const agent = new MockAgent();\nit('x', async () => { await fetch('https://api.example.com/v1'); });` },
    { ...FILE, code: `globalThis.fetch = vi.fn();\nit('x', async () => { await fetch('https://api.stripe.com/v1'); });` },
    { ...FILE, code: `it('x', async () => { await fetch('http://example.invalid/a'); });` },
  ],
  invalid: [
    {
      ...FILE,
      code: `it('x', async () => { await fetch('https://registry.npmjs.org/left-pad'); });`,
      errors: [{ messageId: 'live' }],
    },
    {
      ...FILE,
      code: `it('x', async () => { await axios.get('https://api.github.com/repos/a/b'); });`,
      errors: [{ messageId: 'live' }],
    },
    {
      ...FILE,
      code: `it('x', async () => { await fetch(\`https://api.example.org/users/\${id}\`); });`,
      errors: [{ messageId: 'live' }],
    },
  ],
});

test('the recommended config turns on every rule', () => {
  const ids = Object.keys(plugin.rules).map((id) => `no-flaky-test/${id}`);
  assert.deepEqual(Object.keys(plugin.configs.recommended.rules).sort(), ids.sort());
  for (const severity of Object.values(plugin.configs.recommended.rules)) {
    assert.equal(severity, 'error');
  }
  for (const severity of Object.values(plugin.configs.warn.rules)) {
    assert.equal(severity, 'warn');
  }
});

test('every rule has a docs page, a url, and a message for every messageId', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const [id, rule] of Object.entries(plugin.rules)) {
    const doc = path.join(here, '..', 'docs', 'rules', `${id}.md`);
    assert.ok(existsSync(doc), `missing docs/rules/${id}.md`);
    assert.equal(rule.meta.docs.url, `https://github.com/JesseRWeigel/no-flaky-test/blob/main/docs/rules/${id}.md`);
    const text = readFileSync(doc, 'utf8');
    for (const messageId of Object.keys(rule.meta.messages)) {
      assert.ok(text.includes(messageId), `docs/rules/${id}.md does not mention ${messageId}`);
    }
    // The flake mechanism has to be written down, which is the whole point of the docs page.
    assert.ok(/## Why this is flaky/.test(text), `docs/rules/${id}.md has no mechanism section`);
  }
});

test('the whole-file controls behave', async () => {
  const { lintAll } = await import('../scripts/scan.mjs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));

  // correct.test.ts uses every construct the rules look for, written correctly. Expression-level
  // tests can miss a rule that only over-reports in a larger file, and over-reporting is the
  // failure that gets a lint plugin uninstalled.
  const good = await lintAll([{ path: path.join(here, 'corpus/correct.test.ts'), label: 'correct.test.ts' }]);
  assert.equal(good.parseFailures.length, 0, JSON.stringify(good.parseFailures));
  assert.equal(good.notLinted.length, 0, JSON.stringify(good.notLinted));
  assert.deepEqual(good.findings, [], 'correct.test.ts must produce no findings');

  // sabotage.test.ts is deliberately flaky and must trip all six rules.
  const bad = await lintAll([{ path: path.join(here, 'corpus/sabotage.test.ts'), label: 'sabotage.test.ts' }]);
  assert.equal(bad.parseFailures.length, 0, JSON.stringify(bad.parseFailures));
  const rules = new Set(bad.findings.map((f) => f.rule));
  assert.equal(rules.size, 6, `expected all six rules to fire, got ${[...rules].sort().join(', ')}`);
  assert.equal(bad.findings.length, 11, `expected 11 findings, got ${bad.findings.length}`);
});
