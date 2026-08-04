// The negative control for the whole plugin, at file scale rather than at expression scale.
//
// Every construct below is one the rules are looking for, written the way it should be written.
// The plugin must report exactly nothing here. A sabotage that makes a rule over-report shows up
// as findings in this file, which is the failure mode that gets a lint plugin uninstalled and the
// one the expression-level tests can miss.

declare const it: (name: string, fn: () => unknown) => void;
declare const beforeEach: (fn: () => unknown) => void;
declare const expect: (value: unknown) => any;
declare const assert: any;
declare const vi: any;
declare const fs: { readdirSync: (dir: string) => string[] };
declare const waitFor: (fn: () => unknown) => Promise<void>;
declare const choices: (n: number) => number[];
declare const todayKey: (now: Date) => string;
declare const work: () => void;
declare const el: { visible: boolean };
declare const mkdir: (name: string) => boolean;
declare const isDue: (d: Date) => boolean;
declare const parseDate: (s: string) => Date;
declare const setupServer: (...handlers: unknown[]) => { listen(): void; close(): void };

// An interceptor is installed, so a remote URL below is never a real request.
const server = setupServer();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2024-03-15T12:00:00Z'));
});

it('waits for a condition rather than for a duration', async () => {
  await waitFor(() => expect(el.visible).toBe(true));
});

it('drives the clock instead of reading it', () => {
  const now = new Date();
  expect(todayKey(now)).toBe('2024-03-15');
});

it('uses an explicit instant', () => {
  const d = new Date('2020-01-01T00:00:00Z');
  expect(d.getFullYear()).toBe(2020);
});

it('leaves an hour of slack, which drift cannot cross', () => {
  expect(isDue(new Date(Date.now() + 1000 * 60 * 60))).toBe(false);
});

it('fills a fixture field without asserting on it', () => {
  const record = { id: 7, createdAt: new Date().toISOString() };
  expect(record.id).toBe(7);
});

it('feeds the clock to a shape assertion', () => {
  expect(parseDate(new Date().toISOString())).toBeInstanceOf(Date);
});

it('uses a table instead of a lottery', () => {
  for (const n of [-50, -1, 0, 1, 49]) expect(choices(n)).toContain(n);
});

it('uses randomness only for a unique name', () => {
  const dir = `tmp-${Math.random()}`;
  expect(mkdir(dir)).toBe(true);
});

const loadFixture = async () => { work(); };

it('awaits the promise it creates', async () => {
  await loadFixture();
});

it('returns the promise it creates', () => loadFixture());

it('awaits a rejects assertion', async () => {
  await expect(loadFixture()).rejects.toThrow('boom');
});

it('hands completion to a callback', () => {
  const withCallback = (cb: () => void) => cb();
  withCallback(() => expect(el.visible).toBe(true));
});

it('sorts a directory listing before comparing it', () => {
  assert.deepEqual(fs.readdirSync('/tmp/x').sort(), ['a.txt', 'b.txt']);
});

it('checks membership rather than order', () => {
  expect(fs.readdirSync('/tmp/x')).toEqual(expect.arrayContaining(['a.txt']));
});

it('counts entries, which has no order', () => {
  const files = fs.readdirSync('/tmp/x');
  expect(files.length).toBe(2);
});

it('relies on orders the language defines', () => {
  expect(Object.keys({ b: 1, a: 2 })).toEqual(['b', 'a']);
  expect([...new Set(['b', 'a'])]).toEqual(['b', 'a']);
});

it('talks to a local server', async () => {
  const res = await fetch('http://127.0.0.1:8080/healthz');
  expect(res).toBeDefined();
});

it('reaches a remote host that an interceptor is standing in front of', async () => {
  server.listen();
  const res = await fetch('https://api.example.com/v1/things');
  expect(res).toBeDefined();
  server.close();
});

it('builds its url at runtime, so the host is unknown', async () => {
  const base = 'http://localhost:1234';
  const res = await fetch(`${base}/healthz`);
  expect(res).toBeDefined();
});
