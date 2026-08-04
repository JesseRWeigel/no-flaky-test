// A single file that trips every rule, used by the sabotage layer of scripts/verify.sh as the
// thing whose output must visibly change before an attack counts for anything.
//
// It is deliberately flaky. That is the point. It is never executed, only linted.
//
// The correct counterparts live in test/corpus/correct.test.ts, and the sabotage layer watches
// both, because a rule can break by going silent or by starting to shout.

declare const it: (name: string, fn: (done: () => void) => unknown) => void;
declare const expect: (value: unknown) => any;
declare const assert: any;
declare const page: { waitForTimeout: (ms: number) => Promise<void> };
declare const fs: { readdirSync: (dir: string) => string[] };
declare const choices: (n: number) => number[];
declare const todayKey: () => string;
declare const work: () => void;
declare const row: { createdAt: number };
declare const el: { visible: boolean };

it('sleeps and then asserts', async () => {
  await new Promise((r) => setTimeout(r, 300));
  expect(el.visible).toBe(true);
});

it('waits on the playwright clock', async () => {
  await page.waitForTimeout(150);
});

it('ends on a timer', (done) => {
  setTimeout(done, 100);
});

it('encodes the day it runs on', () => {
  const now = new Date();
  const key = String(now.getFullYear()) + String(now.getMonth());
  expect(todayKey()).toBe(key);
});

it('races the clock', () => {
  expect(row.createdAt).toBe(Date.now());
});

it('bets on machine speed', () => {
  const start = Date.now();
  work();
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(50);
});

it('draws its input from a lottery', () => {
  const n = Math.floor(Math.random() * 100);
  expect(choices(n)).toContain(n);
});

const loadFixture = async () => { work(); };

it('drops a promise', () => {
  loadFixture();
});

it('never awaits a rejects assertion', () => {
  expect(loadFixture()).rejects.toThrow('boom');
});

it('asserts on the order of a directory listing', () => {
  assert.deepEqual(fs.readdirSync('/tmp/x'), ['a.txt', 'b.txt']);
});

it('calls a real host', async () => {
  await fetch('https://registry.npmjs.org/left-pad');
});
