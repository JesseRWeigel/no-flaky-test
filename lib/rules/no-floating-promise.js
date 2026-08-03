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
// decided in general. This rule takes four cases where it can be decided from syntax alone and
// declines the rest:
//
//   1. the callee is a function declared `async` in this same file;
//   2. an `expect(...)` chain containing `.resolves` or `.rejects`, which is always thenable;
//   3. an `async` callback handed to `forEach`, whose return value is discarded by definition;
//   4. the same callee is `await`ed somewhere else in this file and not here.
//
// Case 4 is the useful one in practice. It needs no type information and no list of known APIs,
// and inconsistency inside one file is very strong evidence.

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'disallow promises in test bodies that are never awaited',
      url: 'https://github.com/JesseRWeigel/no-flaky-test/blob/main/docs/rules/no-floating-promise.md',
    },
    schema: [{
      type: 'object',
      properties: {
        checkInconsistentAwait: { type: 'boolean' },
      },
      additionalProperties: false,
    }],
    messages: {
      asyncCall: '{{name}}() is async and its promise is dropped. The test function returns before it finishes, so anything it asserts runs during a later test or not at all.',
      expectAsync: 'This expect(...).{{modifier}} assertion returns a promise and is not awaited. It passes whether the value resolves, rejects, or never settles.',
      forEachAsync: 'An async callback in .forEach() is never awaited, because forEach discards return values. The loop finishes immediately and the assertions inside run after the test ends. Use a for..of loop with await, or await Promise.all(items.map(...)).',
      inconsistent: '{{name}}() is awaited elsewhere in this file (line {{line}}) and not here, so this call almost certainly returns a promise that is being dropped.',
    },
  },

  create(context) {
    const filename = context.filename || context.getFilename();
    if (!isTestFile(filename)) return {};
    const options = context.options[0] || {};
    const checkInconsistent = options.checkInconsistentAwait !== false;

    const asyncFns = new Set();          // functions declared async in this file
    const awaitedNames = new Map();      // callee name -> first line where it is awaited
    const floating = [];                 // candidate calls, judged after the whole file is seen

    function recordAsyncName(node) {
      if (!node.async) return;
      if (node.id && node.id.type === 'Identifier') asyncFns.add(node.id.name);
      const parent = node.parent;
      if (parent && parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
        asyncFns.add(parent.id.name);
      }
      if (parent && parent.type === 'Property' && parent.key && parent.key.type === 'Identifier') {
        asyncFns.add(parent.key.name);
      }
      if (parent && parent.type === 'MethodDefinition' && parent.key &&
          parent.key.type === 'Identifier') {
        asyncFns.add(parent.key.name);
      }
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
      FunctionDeclaration: recordAsyncName,
      FunctionExpression: recordAsyncName,
      ArrowFunctionExpression: recordAsyncName,

      AwaitExpression(node) {
        const name = calleeName(node.argument);
        if (name && !awaitedNames.has(name)) {
          awaitedNames.set(name, node.loc.start.line);
        }
      },

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

        const last = tail(name);

        // Case 1: a function this file declares async.
        if (asyncFns.has(name) || (name === last && asyncFns.has(last))) {
          context.report({ node, messageId: 'asyncCall', data: { name } });
          return;
        }

        // Case 4 is deferred: the file has not been fully read yet.
        if (checkInconsistent) floating.push({ node, name });
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

      'Program:exit'() {
        if (!checkInconsistent) return;
        for (const { node, name } of floating) {
          const line = awaitedNames.get(name);
          if (line === undefined) continue;
          if (line === node.loc.start.line) continue;
          context.report({ node, messageId: 'inconsistent', data: { name, line } });
        }
      },
    };
  },
};
