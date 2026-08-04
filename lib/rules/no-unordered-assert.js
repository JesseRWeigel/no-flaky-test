'use strict';

const { isTestFile, calleeName, tail } = require('../shared');

// An order-sensitive assertion on a collection that has no defined order passes on the machine it
// was written on and fails somewhere else. `fs.readdir` returns entries in whatever order the
// filesystem hands them over: ext4 returns hash order, APFS and NTFS usually return something
// close to alphabetical, and tmpfs returns creation order. So
//
//   assert.deepEqual(await readdir(dir), ['a.txt', 'b.txt'])
//
// is a test of the developer's filesystem, and it will fail in a container, on a colleague's Mac,
// or after an unrelated change alters the order files were created in.
//
// The interesting part of this rule is what it does NOT report, because the obvious candidates
// turn out to be defined by the language:
//
//   Object.keys / Object.entries / for..in over string keys is insertion order per ES2015.
//   Set and Map iteration is insertion order.
//   Promise.all preserves the order of its input regardless of settle order.
//   querySelectorAll is document order.
//
// Every one of those is deterministic, and a rule that fired on them would be wrong far more often
// than right. What is left is genuinely unordered: directory listings, glob results, and
// Promise.race / Promise.any, whose result is decided by whichever promise wins.

const UNORDERED_CALLS = new Set([
  'readdir', 'readdirSync', 'glob', 'globSync', 'sync', 'globby', 'fg',
]);
const UNORDERED_FULL = new Set([
  'Promise.race', 'Promise.any',
]);

// Assertions whose failure depends on element order.
const ORDERED_ASSERT = /^(toEqual|toStrictEqual|toMatchObject|toMatchInlineSnapshot|deepEqual|deepStrictEqual|sameMembers|equal|eql)$/;
// Chain steps that preserve order, so the hazard survives them.
const ORDER_PRESERVING = /^(map|filter|slice|concat|flat|flatMap|reverse|join)$/;

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'disallow order-sensitive assertions on collections with no defined order',
      url: 'https://github.com/JesseRWeigel/no-flaky-test/blob/main/docs/rules/no-unordered-assert.md',
    },
    schema: [{
      type: 'object',
      properties: {
        extraUnorderedSources: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    }],
    messages: {
      listing: '{{source}}() has no defined order. On ext4 it is hash order, on APFS it is close to alphabetical, in a container it may be creation order, so this assertion is about the filesystem it ran on. Add .sort() before comparing.',
      index: '{{source}}() has no defined order, so [{{index}}] is not a stable element. Sort first, or assert on membership.',
      race: '{{source}} resolves with whichever promise settles first, which is a timing decision. Asserting on the identity of the winner is a bet on scheduling.',
    },
  },

  create(context) {
    const filename = context.filename || context.getFilename();
    if (!isTestFile(filename)) return {};
    const options = context.options[0] || {};
    const extra = new Set(options.extraUnorderedSources || []);

    function unorderedSource(node) {
      if (!node) return null;
      if (node.type === 'AwaitExpression') return unorderedSource(node.argument);
      if (node.type === 'TSNonNullExpression' || node.type === 'TSAsExpression') {
        return unorderedSource(node.expression);
      }
      if (node.type === 'Identifier') return null;
      if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return null;

      const full = calleeName(node);
      if (full && (UNORDERED_FULL.has(full) || extra.has(full))) return full;

      const last = tail(full);
      if (last && (UNORDERED_CALLS.has(last) || extra.has(last))) {
        // `glob.sync(...)` reads as `sync`, which is too generic on its own.
        if (last === 'sync' && !/glob/i.test(full || '')) return null;
        return full;
      }

      // Walk back through order-preserving transforms: readdir(d).map(f).filter(g) is still
      // whatever order readdir gave. A .sort() anywhere makes it defined, so stop and report
      // nothing.
      if (node.callee && (node.callee.type === 'MemberExpression' ||
          node.callee.type === 'OptionalMemberExpression') && !node.callee.computed) {
        const method = node.callee.property && node.callee.property.name;
        if (method === 'sort' || method === 'toSorted') return null;
        if (method && ORDER_PRESERVING.test(method)) return unorderedSource(node.callee.object);
      }
      return null;
    }

    // Resolve `const files = readdirSync(d)` so the assertion two lines later still sees it.
    const bindings = new Map();
    const lengthOne = new Set();

    function assertsLengthOne(name) {
      return lengthOne.has(name);
    }

    function sourceOf(node) {
      const direct = unorderedSource(node);
      if (direct) return direct;
      let inner = node;
      while (inner && (inner.type === 'AwaitExpression' || inner.type === 'TSNonNullExpression' ||
             inner.type === 'TSAsExpression')) {
        inner = inner.argument || inner.expression;
      }
      if (inner && inner.type === 'Identifier') return bindings.get(inner.name) || null;
      if (inner && (inner.type === 'CallExpression' || inner.type === 'OptionalCallExpression') &&
          inner.callee && (inner.callee.type === 'MemberExpression') && !inner.callee.computed) {
        const method = inner.callee.property && inner.callee.property.name;
        if (method === 'sort' || method === 'toSorted') return null;
        if (method && ORDER_PRESERVING.test(method)) return sourceOf(inner.callee.object);
      }
      return null;
    }

    return {
      Program(node) {
        // One pass up front, because the length assertion can sit either side of the index.
        const walk = (n) => {
          if (!n || typeof n.type !== 'string') return;
          if (n.type === 'CallExpression' || n.type === 'OptionalCallExpression') {
            const method = tail(calleeName(n));
            const args = [...n.arguments];
            if (n.callee && n.callee.type === 'MemberExpression' && n.callee.object &&
                n.callee.object.type === 'CallExpression' &&
                tail(calleeName(n.callee.object)) === 'expect') {
              args.push(...n.callee.object.arguments);
            }
            const isOne = (a) => a && a.type === 'Literal' && a.value === 1;
            const lengthOf = (a) => (a && a.type === 'MemberExpression' && !a.computed &&
              a.property && a.property.name === 'length' && a.object &&
              a.object.type === 'Identifier') ? a.object.name : null;
            if (method && /^(equal|strictEqual|deepEqual|deepStrictEqual|toBe|toEqual|toHaveLength|is)$/.test(method)) {
              const names = args.map(lengthOf).filter(Boolean);
              const ones = args.some(isOne);
              if (names.length && (ones || method === 'toHaveLength')) {
                for (const name of names) lengthOne.add(name);
              }
            }
          }
          for (const key of Object.keys(n)) {
            if (key === 'parent' || key === 'loc' || key === 'range') continue;
            const value = n[key];
            if (Array.isArray(value)) value.forEach((c) => c && c.type && walk(c));
            else if (value && typeof value.type === 'string') walk(value);
          }
        };
        walk(node);
      },

      VariableDeclarator(node) {
        if (node.id.type !== 'Identifier' || !node.init) return;
        const source = unorderedSource(node.init);
        if (source) bindings.set(node.id.name, source);
      },

      CallExpression(node) {
        const full = calleeName(node);
        const method = tail(full);
        if (!method || !ORDERED_ASSERT.test(method)) return;

        // Jest / Vitest: expect(actual).toEqual(expected)
        // Node assert / Chai: assert.deepEqual(actual, expected)
        let actual = null;
        let expected = null;
        if (node.callee && node.callee.type === 'MemberExpression' &&
            node.callee.object && (node.callee.object.type === 'CallExpression') &&
            tail(calleeName(node.callee.object)) === 'expect') {
          actual = node.callee.object.arguments[0];
          expected = node.arguments[0];
        } else if (node.arguments.length >= 2) {
          actual = node.arguments[0];
          expected = node.arguments[1];
        } else {
          return;
        }
        if (!actual) return;

        // An expected side of `expect.arrayContaining([...])` is a membership check, which is the
        // correct way to assert on an unordered collection.
        if (expected && (expected.type === 'CallExpression') &&
            /arrayContaining|setOf|members/i.test(calleeName(expected) || '')) {
          return;
        }

        const source = sourceOf(actual);
        if (!source) return;
        if (UNORDERED_FULL.has(source)) {
          context.report({ node: actual, messageId: 'race', data: { source } });
        } else {
          context.report({ node: actual, messageId: 'listing', data: { source } });
        }
      },

      MemberExpression(node) {
        // files[0] where files came from a directory listing.
        if (!node.computed) return;
        const index = node.property;
        if (!index || index.type !== 'Literal' || typeof index.value !== 'number') return;
        const source = sourceOf(node.object);
        if (!source) return;
        if (UNORDERED_FULL.has(source)) return;
        // `assert.equal(1, res.length); assert.equal('hello.txt', res[0])` is correct: with one
        // entry there is only one order. jake's suite does exactly this twice, and both were
        // false positives until this check existed.
        if (node.object.type === 'Identifier' && assertsLengthOne(node.object.name)) return;
        // Only complain when the element is being asserted on, not when it is being used.
        let cursor = node;
        for (let i = 0; i < 6 && cursor.parent; i++) {
          cursor = cursor.parent;
          const name = tail(calleeName(cursor));
          if (name === 'expect' || (name && ORDERED_ASSERT.test(name)) ||
              (name && /^(ok|equal|strictEqual|match)$/.test(name))) {
            context.report({
              node, messageId: 'index', data: { source, index: index.value },
            });
            return;
          }
        }
      },
    };
  },
};
