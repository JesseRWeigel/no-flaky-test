'use strict';

const { isTestFile, calleeName, tail, insideTestBody, testBlockKind } = require('../shared');

// A promise that nobody awaits keeps running after the test function returns. The runner has
// already moved on, so:
//
//   assertions inside it fire during a LATER test and are attributed to that test, or fire after
//   the whole file finishes and are swallowed;
//   the work it does (writes, inserts, mock setup) lands in the middle of an unrelated test;
//   the test passes whether the code works or not, because nothing it asserts is ever reached.
//
// The last one is the reason this rule is here. The others are noisy and get noticed. A test that
// passes without running its assertions is invisible, and stays invisible for years.
//
// No type information is available to an ESLint rule by default, so "returns a promise" cannot be
// decided in general. This rule takes three cases where it can be decided from syntax alone and
// declines the rest:
//
//   1. the callee is a function declared `async` in this same file;
//   2. an `expect(...)` chain containing `.resolves` or `.rejects`, which is always thenable;
//   3. an `async` callback handed to `forEach`, whose return value is discarded by definition.
//
// A fourth case was built and then deleted. It reported a call whose callee is `await`ed
// somewhere else in the same file, on the theory that inconsistency is evidence. It found 45
// sites across the vendor corpus and every one of the eight sampled by hand was wrong: chai's
// `expect(x).to.equal(y)` next to an `await expect(...)`, fastq's `queue.push(i)` which is
// deliberately fire and forget beside an awaited `queue.drained()`, and zod's
// `expect(() => f()).toThrow()`. The heuristic sounded strong and measured at zero precision, so
// it is gone rather than shipped behind a flag.

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'disallow promises in test bodies that are never awaited',
      url: 'https://github.com/JesseRWeigel/no-flaky-test/blob/main/docs/rules/no-floating-promise.md',
    },
    schema: [{ type: 'object', properties: {}, additionalProperties: false }],
    messages: {
      asyncCall: '{{name}}() is async and its promise is dropped. The test function returns before it finishes, so anything it asserts runs during a later test or not at all.',
      expectAsync: 'This expect(...).{{modifier}} assertion returns a promise and is not awaited. It passes whether the value resolves, rejects, or never settles.',
      forEachAsync: 'An async callback in .forEach() is never awaited, because forEach discards return values. The loop finishes immediately and the assertions inside run after the test ends. Use a for..of loop with await, or await Promise.all(items.map(...)).',
    },
  },

  create(context) {
    const filename = context.filename || context.getFilename();
    if (!isTestFile(filename)) return {};
    const sourceCode = context.sourceCode;

    /**
     * Is this callee an async function? Resolved through the scope manager rather than by name.
     * A flat set of names got this wrong on rfdc's test suite, where two different `it` blocks
     * each declare their own `fn`, one async and one not, and every call to the synchronous one
     * was reported. Scopes exist precisely so that does not happen.
     */
    function resolvesToAsync(node) {
      if (!node.callee || node.callee.type !== 'Identifier') return false;
      const scope = sourceCode.getScope(node);
      let variable = null;
      for (let s = scope; s && !variable; s = s.upper) {
        variable = s.variables.find((v) => v.name === node.callee.name) || null;
      }
      if (!variable || variable.defs.length === 0) return false;
      return variable.defs.some((def) => {
        if (def.node && def.node.type === 'FunctionDeclaration') return def.node.async === true;
        if (def.node && def.node.type === 'VariableDeclarator') {
          const init = def.node.init;
          return !!init && (init.type === 'ArrowFunctionExpression' ||
            init.type === 'FunctionExpression') && init.async === true;
        }
        return false;
      });
    }

    /**
     * A call that is given a callback is being handled, just not through its promise. Node's
     * older APIs and many libraries accept either form, and reporting the callback form is how
     * this rule produced its worst false positives: `writeFileAtomic(f, d, err => ...)` in
     * atomically's suite, `queue.push(i)` in fastq's, `utils.call(..., done)` in yggdrasil's.
     */
    function hasCallbackArgument(node) {
      return node.arguments.some((arg) =>
        arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression');
    }

    /** Is the value of this call consumed by something that handles the promise? */
    function isHandled(node) {
      let current = node;
      let parent = current.parent;
      while (parent) {
        switch (parent.type) {
          case 'AwaitExpression':
          case 'ReturnStatement':
          case 'ArrowFunctionExpression':   // concise body: `() => doThing()`
          case 'YieldExpression':
          case 'VariableDeclarator':
          case 'AssignmentExpression':
          case 'Property':
          case 'ArrayExpression':
          case 'SpreadElement':
          case 'ConditionalExpression':
          case 'LogicalExpression':
          case 'TSNonNullExpression':
          case 'TSAsExpression':
            return true;
          case 'MemberExpression':
          case 'OptionalMemberExpression': {
            // `foo().then(...)`, `foo().catch(...)`, `foo().finally(...)` are handled.
            const prop = parent.property;
            if (!parent.computed && prop && prop.type === 'Identifier' &&
                /^(then|catch|finally)$/.test(prop.name)) {
              return true;
            }
            current = parent;
            parent = parent.parent;
            continue;
          }
          case 'CallExpression':
          case 'OptionalCallExpression':
            if (parent.callee === current) { current = parent; parent = parent.parent; continue; }
            return true; // passed as an argument to something else, e.g. Promise.all([...])
          case 'ExpressionStatement':
            return false;
          case 'UnaryExpression':
            return parent.operator === 'void';
          default:
            current = parent;
            parent = parent.parent;
        }
      }
      return false;
    }

    return {
      CallExpression(node) {
        const ancestors = context.sourceCode.getAncestors(node);

        // Case 3: async callback to forEach. Checked anywhere in a test file, including at the
        // top level of a describe, because the hazard does not depend on being inside `it`.
        if (tail(calleeName(node)) === 'forEach') {
          const cb = node.arguments[0];
          if (cb && (cb.type === 'ArrowFunctionExpression' || cb.type === 'FunctionExpression') &&
              cb.async) {
            const hasAwait = context.sourceCode.getText(cb).includes('await');
            if (hasAwait) context.report({ node: cb, messageId: 'forEachAsync' });
          }
        }

        if (!insideTestBody(ancestors)) return;
        if (isHandled(node)) return;

        const name = calleeName(node);
        if (!name) return;

        // Never flag the runner's own block functions.
        if (testBlockKind(node)) return;

        if (hasCallbackArgument(node)) return;

        // Case 1: a function this file declares async.
        if (resolvesToAsync(node)) {
          context.report({ node, messageId: 'asyncCall', data: { name } });
        }
      },

      MemberExpression(node) {
        // Case 2: expect(x).resolves / .rejects with nothing awaiting the chain.
        if (node.computed) return;
        const prop = node.property;
        if (!prop || prop.type !== 'Identifier') return;
        if (prop.name !== 'resolves' && prop.name !== 'rejects') return;
        const base = node.object;
        if (!base || (base.type !== 'CallExpression' && base.type !== 'OptionalCallExpression')) {
          return;
        }
        if (tail(calleeName(base)) !== 'expect') return;

        // Find the outermost expression built on this chain and ask whether it is awaited.
        let top = node;
        while (top.parent && (top.parent.type === 'MemberExpression' ||
               top.parent.type === 'OptionalMemberExpression' ||
               ((top.parent.type === 'CallExpression' ||
                 top.parent.type === 'OptionalCallExpression') && top.parent.callee === top))) {
          top = top.parent;
        }
        const parent = top.parent;
        if (!parent) return;
        if (parent.type === 'AwaitExpression' || parent.type === 'ReturnStatement') return;
        if (parent.type === 'ArrowFunctionExpression') return;
        if ((parent.type === 'CallExpression' || parent.type === 'OptionalCallExpression') &&
            parent.callee !== top) return; // inside Promise.all([...]) and friends
        if (parent.type === 'ArrayExpression' || parent.type === 'VariableDeclarator') return;
        if (parent.type === 'MemberExpression' && !parent.computed && parent.property &&
            /^(then|catch|finally)$/.test(parent.property.name)) return;
        if (parent.type !== 'ExpressionStatement') return;
        context.report({ node, messageId: 'expectAsync', data: { modifier: prop.name } });
      },

    };
  },
};
