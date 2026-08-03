'use strict';

// Helpers shared by the rules. Everything here is deliberately conservative: when a rule cannot
// tell whether code is safe, it stays quiet. A lint rule that fires on correct code is turned off
// within a day, and then it catches nothing at all.

const TEST_FILE = /(^|[./\\])(test|tests|spec|specs|e2e|__tests__|__e2e__)([./\\]|$)|\.(test|spec)\.[cm]?[jt]sx?$/;

// A fixture is input to a test, not a test. Fixtures are deliberately strange: a fixture for a
// hydration checker calls Math.random() on purpose, and a fixture for a caching checker fetches a
// real URL on purpose. Reporting them is reporting the test's subject matter. Two of the eleven
// findings in the first clean corpus run were exactly this.
const FIXTURE = /(^|\/)(__)?fixtures?(__)?(\/|$)|(^|\/)[^/]*fixture[^/]*\.[cm]?[jt]sx?$|(^|\/)(__)?(mocks|snapshots)(__)?(\/)/i;

/** Is this path a test file? Rules only run inside test files, and never inside fixtures. */
function isTestFile(filename) {
  if (!filename || filename === '<input>' || filename === '<text>') return true;
  const normalised = filename.replace(/\\/g, '/');
  if (FIXTURE.test(normalised)) return false;
  return TEST_FILE.test(normalised);
}

/** Flatten `a.b.c` (and `a?.b.c`) into the string "a.b.c". Returns null for computed members. */
function staticName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
    if (node.computed) return null;
    const object = staticName(node.object);
    const property = staticName(node.property);
    if (object === null || property === null) return null;
    return `${object}.${property}`;
  }
  if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
    const callee = staticName(node.callee);
    return callee === null ? null : `${callee}()`;
  }
  return null;
}

/** The name of the function being called, e.g. "vi.useFakeTimers" for `vi.useFakeTimers()`. */
function calleeName(node) {
  if (!node || (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression')) {
    return null;
  }
  return staticName(node.callee);
}

/**
 * The last segment of a dotted name. `vi.useFakeTimers` -> `useFakeTimers`. Used so a rule keys
 * off the method rather than the runner global, which differs across vitest / jest / sinon and
 * across local aliases like `const { useFakeTimers } = vi`.
 */
function tail(name) {
  if (!name) return null;
  const parts = name.split('.');
  return parts[parts.length - 1];
}

const TEST_BLOCK = new Set(['it', 'test', 'fit', 'xit', 'xtest', 'bench']);
const HOOK_BLOCK = new Set([
  'beforeEach', 'afterEach', 'beforeAll', 'afterAll', 'before', 'after', 'setup', 'teardown',
]);

/** Is this call `it(...)`, `test.each(...)(...)`, `describe.only(...)` and so on? */
function testBlockKind(node) {
  const name = calleeName(node);
  if (!name) return null;
  const root = name.split('.')[0];
  const head = root.replace(/^x|^f/, '');
  if (TEST_BLOCK.has(root) || TEST_BLOCK.has(head)) return 'test';
  if (HOOK_BLOCK.has(root)) return 'hook';
  if (root === 'describe' || root === 'suite' || root === 'xdescribe' || root === 'fdescribe') {
    return 'describe';
  }
  // `test.each([...])('name', fn)` parses as a call whose callee is itself a call.
  if (node.callee && (node.callee.type === 'CallExpression' ||
      node.callee.type === 'OptionalCallExpression')) {
    return testBlockKind(node.callee);
  }
  return null;
}

/** Walk up the ancestor chain and report whether the node sits inside a test or hook body. */
function insideTestBody(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const node = ancestors[i];
    if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') continue;
    const kind = testBlockKind(node);
    if (kind === 'test' || kind === 'hook') return true;
  }
  return false;
}

/** True when the node is (transitively) inside a string-ish position: template or literal. */
function isInsideJsxAttributeName(node) {
  return node && (node.type === 'JSXIdentifier' || node.type === 'JSXMemberExpression');
}

/**
 * Collect facts about a whole test file in one pass, so per-node rules can ask "does this file
 * control the clock?" without each of them re-walking the tree.
 */
function collectFileFacts(programNode) {
  const facts = {
    fakeTimers: false,       // vi.useFakeTimers / jest.useFakeTimers / sinon.useFakeTimers
    systemTimeSet: false,    // vi.setSystemTime / jest.setSystemTime / MockDate.set
    dateMocked: false,       // vi.spyOn(Date, 'now'), jest.spyOn(Date, 'now'), Date.now = ...
    seededRandom: false,     // spyOn(Math, 'random') or an imported seeded generator
    networkIntercepted: false, // msw / nock / fetch-mock / undici MockAgent / vi.mock of fetch
    localOnly: true,         // set false when a literal non-local URL appears
  };

  const SEEDED_PRNG = /^(seedrandom|pure-rand|@faker-js\/faker|chance|random-seed|prando|mersenne-twister|alea)/;
  const INTERCEPTORS = /^(msw|msw\/node|nock|fetch-mock|@mswjs\/interceptors|undici|nise|jest-fetch-mock|vitest-fetch-mock|@pollyjs\/core)/;

  const walk = (node, parent) => {
    if (!node || typeof node.type !== 'string') return;

    if (node.type === 'ImportDeclaration' && node.source && typeof node.source.value === 'string') {
      const src = node.source.value;
      if (SEEDED_PRNG.test(src)) facts.seededRandom = true;
      if (INTERCEPTORS.test(src)) facts.networkIntercepted = true;
      if (/mockdate/i.test(src)) facts.systemTimeSet = true;
      if (/@sinonjs\/fake-timers|^sinon$/.test(src)) facts.fakeTimers = false; // import alone proves nothing
    }

    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      const name = calleeName(node);
      const last = tail(name);
      if (last === 'useFakeTimers' || last === 'install') {
        if (last === 'useFakeTimers') facts.fakeTimers = true;
        else if (/FakeTimers|clock/i.test(name || '')) facts.fakeTimers = true;
      }
      if (last === 'setSystemTime') facts.systemTimeSet = true;
      if (name === 'MockDate.set' || name === 'mockdate.set') facts.systemTimeSet = true;
      if (name === 'require' && node.arguments[0] && node.arguments[0].type === 'Literal') {
        const src = String(node.arguments[0].value);
        if (SEEDED_PRNG.test(src)) facts.seededRandom = true;
        if (INTERCEPTORS.test(src)) facts.networkIntercepted = true;
        if (/mockdate/i.test(src)) facts.systemTimeSet = true;
      }
      if (last === 'spyOn' && node.arguments.length >= 2) {
        const target = staticName(node.arguments[0]);
        const prop = node.arguments[1];
        const key = prop && (prop.type === 'Literal' ? String(prop.value) : null);
        if (target === 'Date' && (key === 'now' || key === null)) facts.dateMocked = true;
        if (target === 'globalThis.Date' || target === 'global.Date') facts.dateMocked = true;
        if (target === 'Math' && (key === 'random' || key === null)) facts.seededRandom = true;
        if ((target === 'globalThis' || target === 'global' || target === 'window') &&
            key === 'fetch') {
          facts.networkIntercepted = true;
        }
      }
      // vi.mock('node-fetch'), jest.mock('axios'), vi.stubGlobal('fetch', ...)
      if ((last === 'mock' || last === 'doMock' || last === 'unstable_mockModule') &&
          node.arguments[0] && node.arguments[0].type === 'Literal') {
        const target = String(node.arguments[0].value);
        if (/fetch|axios|got|superagent|undici|http|request/i.test(target)) {
          facts.networkIntercepted = true;
        }
        if (/mockdate|date/i.test(target)) facts.systemTimeSet = true;
      }
      if (last === 'stubGlobal' && node.arguments[0] && node.arguments[0].type === 'Literal') {
        const key = String(node.arguments[0].value);
        if (key === 'fetch' || key === 'XMLHttpRequest') facts.networkIntercepted = true;
        if (key === 'Date') facts.dateMocked = true;
        if (key === 'Math') facts.seededRandom = true;
      }
      // setupServer(...) from msw, nock(...), interceptors that are called without an import we
      // recognised (a local re-export, for example).
      if (last === 'setupServer' || last === 'setupWorker' || last === 'createFetchMock') {
        facts.networkIntercepted = true;
      }
      if (last === 'setGlobalDispatcher' || last === 'MockAgent') facts.networkIntercepted = true;
    }

    if (node.type === 'NewExpression') {
      const name = staticName(node.callee);
      if (tail(name) === 'MockAgent') facts.networkIntercepted = true;
    }

    // `global.fetch = vi.fn()`, `Date.now = () => 0`, `Math.random = seeded`
    if (node.type === 'AssignmentExpression' && node.operator === '=') {
      const target = staticName(node.left);
      if (target) {
        const t = target.replace(/^(globalThis|global|window|self)\./, '');
        if (t === 'fetch' || t === 'XMLHttpRequest') facts.networkIntercepted = true;
        if (t === 'Date.now' || t === 'Date') facts.dateMocked = true;
        if (t === 'Math.random') facts.seededRandom = true;
      }
    }

    for (const key of Object.keys(node)) {
      if (key === 'parent' || key === 'loc' || key === 'range') continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child.type === 'string') walk(child, node);
        }
      } else if (value && typeof value.type === 'string') {
        walk(value, node);
      }
    }
  };

  walk(programNode, null);
  return facts;
}

module.exports = {
  isTestFile,
  staticName,
  calleeName,
  tail,
  testBlockKind,
  insideTestBody,
  isInsideJsxAttributeName,
  collectFileFacts,
};
