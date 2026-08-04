'use strict';

const { isTestFile, calleeName, staticName, tail, insideTestBody } = require('../shared');

// A fixed delay is a bet that the machine finishes the work in under N milliseconds. Your laptop
// wins that bet; a shared CI runner under load loses it every few hundred runs. The test then
// fails with an assertion about state that simply had not arrived yet, which reads like a real
// regression and is not one.
//
// Narrow on purpose. `setTimeout` inside a test is not itself a problem: firing a mock's callback
// on a timer is normal and the test awaits the resulting promise, so it is deterministic. What is
// reported here is `setTimeout` used as a WAIT, where nothing downstream is tied to the timer and
// the delay is standing in for a condition nobody expressed.

/** `new Promise(res => setTimeout(res, N))` and the `function (res) { setTimeout(res, N) }` form. */
function sleepDelay(node) {
  if (node.type !== 'NewExpression') return null;
  // calleeName() answers null for a NewExpression, which silently disabled this whole branch
  // until a unit test asked for it. The constructor name comes from staticName().
  const ctor = (staticName(node.callee) || '').replace(/^(globalThis|global|window|self)\./, '');
  if (ctor !== 'Promise') return null;
  const fn = node.arguments[0];
  if (!fn || (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression')) {
    return null;
  }
  const resolveParam = fn.params[0];
  if (!resolveParam || resolveParam.type !== 'Identifier') return null;

  let call = null;
  if (fn.body.type === 'CallExpression') {
    call = fn.body;
  } else if (fn.body.type === 'BlockStatement') {
    const statements = fn.body.body.filter((s) => s.type !== 'EmptyStatement');
    if (statements.length !== 1) return null;
    const only = statements[0];
    if (only.type === 'ExpressionStatement' && only.expression.type === 'CallExpression') {
      call = only.expression;
    }
  }
  if (!call || tail(calleeName(call)) !== 'setTimeout') return null;

  // The timer must resolve the promise directly. `setTimeout(() => resolve(compute()), 50)` is
  // still a bare wait, so accept a callback whose only job is to call the resolve parameter.
  // `resolve()` with no argument is a sleep. `resolve(true)` after a delay is a mock producing a
  // value late, which is simulated latency rather than a guess about how long work takes, and
  // exponential-backoff and zod both do it on purpose.
  const cb = call.arguments[0];
  const resolvesDirectly =
    (cb && cb.type === 'Identifier' && cb.name === resolveParam.name) ||
    (cb && (cb.type === 'ArrowFunctionExpression' || cb.type === 'FunctionExpression') &&
      cb.body.type === 'CallExpression' && calleeName(cb.body) === resolveParam.name &&
      cb.body.arguments.length === 0);
  if (!resolvesDirectly) return null;

  const delay = call.arguments[1];
  if (!delay) return { ms: 0 };
  if (delay.type === 'Literal' && typeof delay.value === 'number') return { ms: delay.value };
  return { ms: null };
}


const ASSERTION = /^(expect|assert|should|ok|equal|strictEqual|notEqual|deepEqual|deepStrictEqual|is|same|toBe|toEqual|assertEquals|expectTypeOf)$/;

/** Does this subtree contain an assertion call? */
function containsAssertion(node) {
  if (!node || typeof node.type !== 'string') return false;
  if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
    const name = calleeName(node);
    const last = name ? name.split('.').pop() : null;
    if (last && ASSERTION.test(last)) return true;
    const method = node.callee && node.callee.type === 'MemberExpression' &&
      !node.callee.computed && node.callee.property &&
      node.callee.property.type === 'Identifier' ? node.callee.property.name : null;
    if (method && ASSERTION.test(method)) return true;
  }
  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === 'loc' || key === 'range') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (containsAssertion(child)) return true;
    } else if (value && typeof value.type === 'string' && containsAssertion(value)) {
      return true;
    }
  }
  return false;
}

/**
 * A fixed delay is only a hazard when something is asserted after it. The same expression inside
 * a fixture that simulates slow work is deliberate: zod's codec tests await a 1ms timer inside
 * `decode` to make it async, and fastq's queue worker does the same. Sixteen findings across the
 * vendor corpus were of that shape, and eight of them were fixtures.
 */
function followedByAssertion(node) {
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if (parent.type === 'BlockStatement' || parent.type === 'Program') {
      const index = parent.body.indexOf(current);
      if (index !== -1) {
        for (let i = index + 1; i < parent.body.length; i++) {
          if (containsAssertion(parent.body[i])) return true;
        }
      }
      // Stop at the function boundary. Looking past it finds the assertions in the surrounding
      // `test()` body, which are not after this sleep in any meaningful sense, and that is why
      // zod's codec fixtures and fastq's queue worker kept being reported.
      const owner = parent.parent;
      if (owner && /^(ArrowFunctionExpression|FunctionExpression|FunctionDeclaration)$/
          .test(owner.type)) {
        return false;
      }
    }
    current = parent;
  }
  return false;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'disallow fixed-duration sleeps as a substitute for waiting on a condition',
      url: 'https://github.com/JesseRWeigel/no-flaky-test/blob/main/docs/rules/no-bare-timeout.md',
    },
    schema: [{
      type: 'object',
      properties: {
        allowZeroDelay: { type: 'boolean' },
        sleepHelpers: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    }],
    messages: {
      sleep: 'Fixed {{delay}} sleep. On a loaded CI runner the work may not be finished when the timer fires. Wait for the condition instead (waitFor, an event, a returned promise), or drive the clock with fake timers.',
      waitForTimeout: 'page.waitForTimeout() is a fixed sleep and races the page. Use an auto-retrying wait such as expect(locator).toBeVisible() or page.waitForResponse().',
      doneTimer: 'setTimeout(done, {{delay}}) ends the test on a timer rather than on the thing it is testing. If the work takes longer than {{delay}}ms the assertions never run, or run against half-built state.',
    },
  },

  create(context) {
    const filename = context.filename || context.getFilename();
    if (!isTestFile(filename)) return {};
    const options = context.options[0] || {};
    const allowZeroDelay = options.allowZeroDelay === true;
    const helpers = new Set(options.sleepHelpers || []);

    // A local `const sleep = ms => new Promise(r => setTimeout(r, ms))` makes every `await sleep(n)`
    // in the file a bare wait. Collect those definitions so the call sites can be reported at the
    // place that actually chose the number.
    const localSleeps = new Set();

    function describe(ms) {
      return ms === null ? 'sleep' : `${ms}ms`;
    }

    function reportSleep(node, info) {
      if (info.ms === 0 && allowZeroDelay) return;
      if (!followedByAssertion(node)) return;
      context.report({ node, messageId: 'sleep', data: { delay: describe(info.ms) } });
    }

    return {
      VariableDeclarator(node) {
        if (!node.init || node.id.type !== 'Identifier') return;
        const fn = node.init;
        if (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression') return;
        const body = fn.body.type === 'BlockStatement'
          ? (fn.body.body.find((s) => s.type === 'ReturnStatement') || {}).argument
          : fn.body;
        if (body && sleepDelay(body)) localSleeps.add(node.id.name);
      },

      FunctionDeclaration(node) {
        if (!node.id) return;
        const ret = node.body.body.find((s) => s.type === 'ReturnStatement');
        if (ret && ret.argument && sleepDelay(ret.argument)) localSleeps.add(node.id.name);
      },

      NewExpression(node) {
        const info = sleepDelay(node);
        if (!info) return;
        const ancestors = context.sourceCode.getAncestors(node);
        // A sleep helper defined at module scope is reported at its call sites, not at the
        // definition, so the number the author picked is what gets flagged.
        if (!insideTestBody(ancestors)) return;
        reportSleep(node, info);
      },

      CallExpression(node) {
        const name = calleeName(node);
        const last = tail(name);
        const ancestors = context.sourceCode.getAncestors(node);

        if (last === 'waitForTimeout') {
          context.report({ node, messageId: 'waitForTimeout' });
          return;
        }

        if ((last && (localSleeps.has(last) || helpers.has(last))) && insideTestBody(ancestors)) {
          const arg = node.arguments[0];
          const ms = arg && arg.type === 'Literal' && typeof arg.value === 'number'
            ? arg.value
            : null;
          reportSleep(node, { ms });
          return;
        }

        // Mocha's `it('x', done => { setTimeout(done, 500); })`.
        if (last === 'setTimeout' && node.arguments[0] &&
            node.arguments[0].type === 'Identifier' && insideTestBody(ancestors)) {
          const cbName = node.arguments[0].name;
          const isDone = ancestors.some((a) =>
            (a.type === 'ArrowFunctionExpression' || a.type === 'FunctionExpression') &&
            a.params.some((p) => p.type === 'Identifier' && p.name === cbName &&
              /^(done|cb|callback|next)$/.test(p.name)));
          if (isDone) {
            const delay = node.arguments[1];
            const ms = delay && delay.type === 'Literal' ? delay.value : 'a';
            context.report({ node, messageId: 'doneTimer', data: { delay: ms } });
          }
        }
      },
    };
  },
};
