'use strict';

const { isTestFile, calleeName, collectFileFacts } = require('../shared');

// Unseeded randomness turns one test into a different test on every run. That is not always a
// problem, and the distinction matters more than the API does:
//
//   Random data that FEEDS the code under test is a lottery. Most draws pass, one draw in a
//   thousand hits the boundary the code gets wrong, and the failure arrives months later with no
//   reproduction and a stack trace pointing at a value nobody can recreate.
//   Random data used to build a unique name or key is fine. Nothing asserts on it.
//
// So the string-context carve-out from no-unmocked-time applies here too, and it is what keeps the
// rule quiet on the extremely common `?cacheBust=${Math.random()}` and `tmp-${Math.random()}`.
//
// crypto.randomUUID() is not reported by default. It exists to produce a value nobody looks at,
// and firing on every id in a fixture factory is how a rule gets switched off.

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'disallow unseeded randomness in test input',
      url: 'https://github.com/JesseRWeigel/no-flaky-test/blob/main/docs/rules/no-unseeded-random.md',
    },
    schema: [{
      type: 'object',
      properties: {
        reportUuid: { type: 'boolean' },
        allowInStringContext: { type: 'boolean' },
      },
      additionalProperties: false,
    }],
    messages: {
      random: 'Math.random() feeds this test a different value on every run, so a failure here is not reproducible. Use a fixed value, a table of cases, or a seeded generator.',
      uuid: '{{api}} produces a value that differs on every run. Fine for an opaque id, a problem if anything asserts on it.',
      faker: 'faker is used without faker.seed(), so the generated data differs on every run. Call faker.seed(<number>) in a beforeEach.',
    },
  },

  create(context) {
    const filename = context.filename || context.getFilename();
    if (!isTestFile(filename)) return {};
    const options = context.options[0] || {};
    const reportUuid = options.reportUuid === true;
    const allowInStringContext = options.allowInStringContext !== false;

    let facts = null;
    let fakerSeeded = null;
    function seeded() {
      if (facts === null) facts = collectFileFacts(context.sourceCode.ast);
      return facts.seededRandom;
    }
    function hasFakerSeed() {
      if (fakerSeeded === null) {
        fakerSeeded = /\bfaker\s*\.\s*seed\s*\(/.test(context.sourceCode.getText());
      }
      return fakerSeeded;
    }

    /**
     * `Math.random() ? a : b` with no comparison is not a coin flip, it is a way to make a value
     * that the type checker cannot fold away, and it takes the first branch every time (0 has
     * probability 2^-53). zod's suite uses it to widen an inferred type. `Math.random() > 0.5` is
     * a real coin flip and still reported, because the comparison is there.
     */
    function isBareCondition(node) {
      const parent = node.parent;
      if (!parent) return false;
      if (parent.type === 'ConditionalExpression' && parent.test === node) return true;
      if (parent.type === 'IfStatement' && parent.test === node) return true;
      return false;
    }

    function inStringContext(node) {
      const ancestors = context.sourceCode.getAncestors(node);
      for (let i = ancestors.length - 1; i >= 0; i--) {
        const a = ancestors[i];
        if (a.type === 'TemplateLiteral') return true;
        if (a.type === 'BinaryExpression' && a.operator === '+') {
          const other = a.left === (ancestors[i + 1] || node) ? a.right : a.left;
          if (other && other.type === 'Literal' && typeof other.value === 'string') return true;
        }
        if (a.type === 'CallExpression') {
          const name = calleeName(a);
          if (name && /(toString|String|toFixed)$/.test(name)) return true;
          if (name === 'Math.floor' || name === 'Math.round' || name === 'Math.ceil') continue;
          break;
        }
        if (a.type === 'ExpressionStatement' || a.type === 'VariableDeclarator') break;
      }
      return false;
    }

    return {
      CallExpression(node) {
        const name = calleeName(node);
        if (!name) return;
        const normalised = name.replace(/^(globalThis|global|window|self)\./, '');

        if (normalised === 'Math.random') {
          if (seeded()) return;
          if (allowInStringContext && inStringContext(node)) return;
          if (isBareCondition(node)) return;
          context.report({ node, messageId: 'random' });
          return;
        }

        if (/(^|\.)randomUUID$|(^|\.)randomBytes$|(^|\.)getRandomValues$|^randomUUID$/.test(normalised)) {
          if (!reportUuid) return;
          if (seeded()) return;
          if (allowInStringContext && inStringContext(node)) return;
          context.report({ node, messageId: 'uuid', data: { api: `${normalised}()` } });
          return;
        }

        // faker.person.firstName(), faker.number.int(), faker.helpers.arrayElement(...)
        const root = normalised.split('.')[0];
        if (root === 'faker' && normalised !== 'faker.seed' && normalised.includes('.')) {
          if (hasFakerSeed()) return;
          context.report({ node, messageId: 'faker' });
        }
      },

      // Deliberately no MemberExpression handler. An earlier version reported bare `Math.random`
      // used as a value, and the first real test suite it ran against contained
      // `assert.equal(Math.random, before.random)`, which is a test asserting that a stub was
      // removed, and `{ random: Math.random }`, which is that stub being saved. Both are correct
      // code and both were false positives. Passing `Math.random` itself somewhere is rare; being
      // wrong about it is not.
    };
  },
};
