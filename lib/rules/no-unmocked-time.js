'use strict';

const { isTestFile, calleeName, staticName, tail, collectFileFacts } = require('../shared');

// Reading the real clock inside a test is not by itself a bug. The first version of this rule
// assumed it was, reported every `Date.now()` and every `new Date()` in a file with no fake
// timers, and produced 37 findings across 305 real test files of which 26 were noise: things like
//
//     lastActivity: new Date().toISOString(),      // filling a required field in a fixture
//     createdAt: new Date(),                       // same
//     dueAt: new Date(Date.now() + 3600_000),      // an hour of slack, drift cannot reach it
//
// None of those can fail. A rule that reports them is off by the end of the week.
//
// What actually fails is one of three shapes, and the rule now reports only these:
//
//   CALENDAR   A clock read with a calendar field pulled out of it: getDate(), getMonth(),
//              toDateString(). The test then encodes today's date, and fails at midnight, on the
//              last day of a month, on the 29th of February, on a runner in another timezone, and
//              twice a year at the daylight-saving change.
//
//   RACE       A clock read sitting inside an assertion, so the expected value is being read at a
//              different instant from the actual one. `expect(row.createdAt).toBe(Date.now())`
//              fails whenever a millisecond passes between the two reads, which is rare on a fast
//              laptop and routine on a loaded runner.
//
//   ELAPSED    A difference between two clock reads compared against a threshold. That is a bet
//              on how fast the machine is, and CI is slower and noisier than a laptop by a factor
//              that varies run to run.
//
// Everything else is left alone.

const CLOCK_READS = new Set(['Date.now', 'performance.now']);
const CALENDAR_ACCESSORS = new Set([
  'getDate', 'getDay', 'getMonth', 'getFullYear', 'getYear', 'getHours', 'getMinutes',
  'getSeconds', 'getTimezoneOffset', 'toDateString', 'toLocaleDateString', 'toLocaleString',
  'toLocaleTimeString', 'toTimeString', 'getUTCDate', 'getUTCDay', 'getUTCMonth',
  'getUTCFullYear', 'getUTCHours',
]);
const ASSERTIONS = /^(expect|assert|assertEquals|ok|equal|strictEqual|notEqual|deepEqual|deepStrictEqual|toBe|toEqual|toStrictEqual|toBeCloseTo|toBeLessThan|toBeLessThanOrEqual|toBeGreaterThan|toBeGreaterThanOrEqual|toMatch|toContain|should|expectTypeOf)$/;
// Only these can be decided by the exact instant. `toBeInstanceOf(Date)` cannot, and zod's own
// suite is full of `expect(schema.parse(new Date().toISOString())).toBeInstanceOf(Date)`, where
// the clock is input to the thing under test and the assertion is about shape. Reporting those
// produced 47 findings in one package that no amount of drift could ever fail.
const VALUE_MATCHERS = /^(toBe|toEqual|toStrictEqual|toBeCloseTo|toBeLessThan|toBeLessThanOrEqual|toBeGreaterThan|toBeGreaterThanOrEqual|toMatch|toMatchSnapshot|toMatchInlineSnapshot|equal|strictEqual|deepEqual|deepStrictEqual|notEqual|assertEquals)$/;
const COMPARISONS = new Set(['<', '>', '<=', '>=', '===', '==', '!==', '!=']);

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'disallow the three real-clock patterns that make a test fail on the calendar, on a race, or on machine speed',
      url: 'https://github.com/JesseRWeigel/no-flaky-test/blob/main/docs/rules/no-unmocked-time.md',
    },
    schema: [{
      type: 'object',
      properties: {
        toleranceMs: { type: 'number' },
      },
      additionalProperties: false,
    }],
    messages: {
      calendar: '{{api}} then .{{accessor}}() encodes the day this test runs on. It fails at midnight, on the last day of a month, on 29 February, in another timezone, and at the daylight-saving change. Set the clock (vi.setSystemTime, jest.setSystemTime, MockDate) or pass an explicit instant.',
      race: '{{api}} inside an assertion reads the clock at a different instant from the value being compared. One millisecond of drift fails the test, which happens on a loaded runner and almost never on a laptop.',
      elapsed: 'A measured duration compared against a threshold is a bet on how fast the machine is. CI is slower than a laptop by a factor that changes run to run, so this fails intermittently and tells you nothing about the code.',
    },
  },

  create(context) {
    const filename = context.filename || context.getFilename();
    if (!isTestFile(filename)) return {};
    const options = context.options[0] || {};
    const toleranceMs = typeof options.toleranceMs === 'number' ? options.toleranceMs : 1000;
    const sourceCode = context.sourceCode;

    let facts = null;
    function controlled() {
      if (facts === null) facts = collectFileFacts(sourceCode.ast);
      return facts.fakeTimers || facts.systemTimeSet || facts.dateMocked;
    }

    /** Fold `1000 * 60 * 60` and friends. Returns null when any leaf is not a number literal. */
    function fold(node) {
      if (!node) return null;
      if (node.type === 'Literal' && typeof node.value === 'number') return node.value;
      if (node.type === 'UnaryExpression' && node.operator === '-') {
        const inner = fold(node.argument);
        return inner === null ? null : -inner;
      }
      if (node.type === 'BinaryExpression') {
        const left = fold(node.left);
        const right = fold(node.right);
        if (left === null || right === null) return null;
        switch (node.operator) {
          case '+': return left + right;
          case '-': return left - right;
          case '*': return left * right;
          case '/': return right === 0 ? null : left / right;
          default: return null;
        }
      }
      return null;
    }

    /** Is this node a read of the real clock? Returns a label, or null. */
    function clockRead(node) {
      if (!node) return null;
      if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
        const name = (calleeName(node) || '').replace(/^(globalThis|global|window|self)\./, '');
        if (CLOCK_READS.has(name)) return `${name}()`;
        return null;
      }
      if (node.type === 'NewExpression') {
        const name = (staticName(node.callee) || '')
          .replace(/^(globalThis|global|window|self)\./, '');
        if (name === 'Date' && node.arguments.length === 0) return 'new Date()';
      }
      return null;
    }

    /** `new Date()` used as the right side of `x || new Date()` is a default, not the test's value. */
    function isFallbackDefault(node) {
      const parent = node.parent;
      if (!parent) return false;
      if (parent.type === 'LogicalExpression' && (parent.operator === '||' ||
          parent.operator === '??') && parent.right === node) {
        return true;
      }
      if (parent.type === 'AssignmentPattern' && parent.right === node) return true;
      if (parent.type === 'ConditionalExpression' && parent.test !== node) return true;
      return false;
    }

    /** Walk outward through wrappers that keep the value a clock instant. */
    function outward(node) {
      let current = node;
      for (let i = 0; i < 6; i++) {
        const parent = current.parent;
        if (!parent) return current;
        if (parent.type === 'NewExpression' && staticName(parent.callee) === 'Date' &&
            parent.arguments[0] === current) {
          current = parent; continue;
        }
        if ((parent.type === 'CallExpression' || parent.type === 'OptionalCallExpression') &&
            parent.callee.type === 'MemberExpression' && parent.callee.object === current &&
            !parent.callee.computed && parent.callee.property.name === 'getTime') {
          current = parent; continue;
        }
        if (parent.type === 'TSAsExpression' || parent.type === 'TSNonNullExpression') {
          current = parent; continue;
        }
        return current;
      }
      return current;
    }

    /** Magnitude of a constant offset applied right at the read site, or null. */
    function offsetAt(node) {
      const value = outward(node);
      const parent = value.parent;
      if (!parent || parent.type !== 'BinaryExpression') return null;
      if (parent.operator !== '+' && parent.operator !== '-') return null;
      const other = parent.left === value ? parent.right : parent.left;
      const folded = fold(other);
      return folded === null ? null : Math.abs(folded);
    }

    /** The calendar accessor applied directly to this value, if any. */
    function calendarAccessorOn(node) {
      const value = outward(node);
      const parent = value.parent;
      if (!parent || parent.type !== 'MemberExpression' || parent.computed) return null;
      const name = parent.property && parent.property.name;
      return CALENDAR_ACCESSORS.has(name) ? name : null;
    }

    /**
     * The nearest enclosing assertion, as {matcher}. `expect(a).toBe(b)` is two nested calls, so
     * the matcher is read from whichever call the node sits inside: for `expect(...)` the matcher
     * is the method chained onto it.
     */
    function enclosingAssertion(node) {
      let current = node;
      let parent = current.parent;
      for (let i = 0; i < 12 && parent; i++) {
        if ((parent.type === 'CallExpression' || parent.type === 'OptionalCallExpression') &&
            parent.arguments.includes(current)) {
          const name = tail(calleeName(parent));
          if (name && ASSERTIONS.test(name)) {
            if (name === 'expect' || name === 'assert') {
              // Inside `expect(x)`: x is the actual value and the matcher is chained onto it.
              const chained = parent.parent;
              if (chained && chained.type === 'MemberExpression' && !chained.computed &&
                  chained.property && chained.property.type === 'Identifier') {
                return { matcher: chained.property.name, side: 'actual' };
              }
              return { matcher: name, side: 'actual' };
            }
            // `expect(a).toBe(b)` reaches here with b, and `assert.equal(a, b)` with either.
            // Argument 0 of a two-argument assertion is the actual value; anything else is the
            // expected value.
            const index = parent.arguments.indexOf(current);
            const isExpect = parent.callee && parent.callee.type === 'MemberExpression' &&
              parent.callee.object && parent.callee.object.type === 'CallExpression' &&
              tail(calleeName(parent.callee.object)) === 'expect';
            // Argument order is not a reliable signal on its own. tape suites write
            // `t.equal(false, whichTypedArray(new Date()), 'msg')` with the expected value first,
            // and reading position alone reported four packages' worth of that shape. A literal
            // in any other argument slot is the expected value, which makes this one the actual.
            const otherIsLiteral = parent.arguments.some((arg, i) =>
              i !== index && arg && arg.type === 'Literal');
            const side = !otherIsLiteral && (isExpect || index > 0) ? 'expected' : 'actual';
            return { matcher: name, side };
          }
        }
        current = parent;
        parent = parent.parent;
      }
      return null;
    }

    function insideAssertion(node) {
      return enclosingAssertion(node) !== null;
    }

    function inComparison(node) {
      let current = node;
      let parent = current.parent;
      for (let i = 0; i < 4 && parent; i++) {
        if (parent.type === 'BinaryExpression' && COMPARISONS.has(parent.operator)) return true;
        current = parent;
        parent = parent.parent;
      }
      return false;
    }

    /** The variable a node initialises, if it is `const x = <node>` (through wrappers). */
    function declaredBy(node) {
      const value = outward(node);
      let current = value;
      for (let i = 0; i < 4 && current.parent; i++) {
        if (current.parent.type === 'VariableDeclarator' && current.parent.init === current) {
          const declared = sourceCode.getDeclaredVariables(current.parent);
          return declared.length === 1 ? declared[0] : null;
        }
        if (current.parent.type === 'BinaryExpression' ||
            current.parent.type === 'TSAsExpression') {
          current = current.parent;
          continue;
        }
        return null;
      }
      return null;
    }

    const clockVars = new Set();   // variables holding a raw clock instant
    const reads = [];
    const elapsed = [];            // BinaryExpression nodes that subtract two clock instants
    const subtractions = [];

    /** `const day = new Date(d)` where `d` is a clock instant: day is one too. */
    function derivedVariable(identifier) {
      let current = identifier;
      for (let i = 0; i < 4 && current.parent; i++) {
        const parent = current.parent;
        if (parent.type === 'NewExpression' && staticName(parent.callee) === 'Date' &&
            parent.arguments[0] === current) { current = parent; continue; }
        if ((parent.type === 'CallExpression') && parent.callee.type === 'MemberExpression' &&
            parent.callee.object === current && !parent.callee.computed &&
            parent.callee.property.name === 'getTime') { current = parent; continue; }
        if (parent.type === 'VariableDeclarator' && parent.init === current) {
          const declared = sourceCode.getDeclaredVariables(parent);
          return declared.length === 1 ? declared[0] : null;
        }
        return null;
      }
      return null;
    }

    function isClockValued(node) {
      if (!node) return false;
      if (clockRead(node)) return true;
      let inner = node;
      while (inner && (inner.type === 'TSAsExpression' || inner.type === 'TSNonNullExpression')) {
        inner = inner.expression;
      }
      if (!inner) return false;
      if ((inner.type === 'CallExpression') && inner.callee.type === 'MemberExpression' &&
          !inner.callee.computed && inner.callee.property.name === 'getTime') {
        return isClockValued(inner.callee.object);
      }
      if (inner.type === 'Identifier') {
        const scope = sourceCode.getScope(inner);
        const found = resolve(scope, inner.name);
        return found !== null && clockVars.has(found);
      }
      return false;
    }

    function resolve(scope, name) {
      for (let s = scope; s; s = s.upper) {
        const variable = s.variables.find((v) => v.name === name);
        if (variable) return variable;
      }
      return null;
    }

    return {
      'CallExpression, NewExpression'(node) {
        const api = clockRead(node);
        if (!api) return;
        reads.push({ node, api });
        const variable = declaredBy(node);
        if (variable && offsetAt(node) === null) clockVars.add(variable);
      },

      BinaryExpression(node) {
        if (node.operator === '-') subtractions.push(node);
      },

      'Program:exit'() {
        if (controlled()) return;
        const reported = new Set();

        // A clock instant handed to `new Date(...)` is still a clock instant, and a test that
        // copies today's date and then walks backwards day by day is the commonest form of the
        // calendar bug. Propagate through a few hops so `const d = new Date()` reaches
        // `const day = new Date(d); day.getFullYear()`.
        for (let hop = 0; hop < 3; hop++) {
          let grew = false;
          for (const variable of [...clockVars]) {
            for (const ref of variable.references) {
              if (!ref.identifier) continue;
              const derived = derivedVariable(ref.identifier);
              if (derived && !clockVars.has(derived)) { clockVars.add(derived); grew = true; }
            }
          }
          if (!grew) break;
        }

        // ELAPSED: any subtraction of two clock instants, whether written inline as
        // `Date.now() - started` or as `endTime - startTime` over two named reads.
        for (const diff of subtractions) {
          if (!isClockValued(diff.left) || !isClockValued(diff.right)) continue;
          if (!elapsed.includes(diff)) elapsed.push(diff);
        }
        for (const diff of elapsed) {
          if (!thresholded(diff)) continue;
          context.report({ node: diff, messageId: 'elapsed' });
          reported.add(diff);
        }

        for (const { node, api } of reads) {
          if (isFallbackDefault(node)) continue;
          if (reported.has(node)) continue;
          const enclosingElapsed = elapsed.find((d) => contains(d, node));
          if (enclosingElapsed) continue;

          // A clock value handed to a shape assertion decides nothing, whatever is pulled out of
          // it. `expect(parse(new Date().toISOString())).toBeInstanceOf(Date)` passes on every
          // date there has ever been.
          const assertion = enclosingAssertion(node);
          const shapeOnly = assertion !== null && !VALUE_MATCHERS.test(assertion.matcher);
          if (shapeOnly) continue;

          const accessor = calendarAccessorOn(node);
          if (accessor) {
            context.report({ node, messageId: 'calendar', data: { api, accessor } });
            continue;
          }
          const variable = declaredBy(node);
          if (variable && offsetAt(node) === null) {
            const found = calendarAccessorReachedFrom(variable);
            if (found) {
              context.report({ node, messageId: 'calendar', data: { api, accessor: found } });
              continue;
            }
          }

          const magnitude = offsetAt(node);
          if (magnitude !== null && magnitude >= toleranceMs) continue;
          // The clock must be the EXPECTED value for the race to exist. A clock read on the
          // actual side is input to the code under test, and `t.equal(isRegExp(new Date()),
          // false)` cannot fail however long the test takes. Reporting the actual side produced
          // 24 findings across the vendor corpus and the six checked by hand were all of that
          // shape, in qs, get-proto and reflect.getprototypeof.
          if (assertion && assertion.side === 'expected' &&
              VALUE_MATCHERS.test(assertion.matcher)) {
            context.report({ node, messageId: 'race', data: { api } });
          }
        }

        /** Chase a clock variable through `new Date(x)` copies looking for a calendar accessor. */
        function calendarAccessorReachedFrom(start) {
          const seen = new Set([start]);
          let frontier = [start];
          for (let hop = 0; hop < 4 && frontier.length; hop++) {
            const next = [];
            for (const variable of frontier) {
              for (const ref of variable.references) {
                if (!ref.identifier || ref.init) continue;
                const accessor = calendarAccessorOn(ref.identifier);
                if (accessor) return accessor;
                const derived = derivedVariable(ref.identifier);
                if (derived && !seen.has(derived)) { seen.add(derived); next.push(derived); }
              }
            }
            frontier = next;
          }
          return null;
        }

        /** Does a measured duration end up compared against anything? */
        function thresholded(diff) {
          if (inComparison(diff) || insideAssertion(diff)) return true;
          let frontier = [];
          const variable = declaredByExpr(diff);
          if (variable) frontier.push(variable);
          for (let hop = 0; hop < 3 && frontier.length; hop++) {
            const next = [];
            for (const v of frontier) {
              for (const ref of v.references) {
                if (!ref.identifier || ref.init) continue;
                if (inComparison(ref.identifier) || insideAssertion(ref.identifier)) return true;
                const derived = declaredByExpr(ref.identifier);
                if (derived) next.push(derived);
              }
            }
            frontier = next;
          }
          return false;
        }

        function declaredByExpr(node) {
          let current = node;
          for (let i = 0; i < 5 && current.parent; i++) {
            if (current.parent.type === 'VariableDeclarator' && current.parent.init === current) {
              const declared = sourceCode.getDeclaredVariables(current.parent);
              return declared.length === 1 ? declared[0] : null;
            }
            if (current.parent.type === 'BinaryExpression' ||
                current.parent.type === 'TSAsExpression' ||
                current.parent.type === 'CallExpression') {
              current = current.parent;
              continue;
            }
            return null;
          }
          return null;
        }

        function contains(ancestor, node) {
          for (let current = node; current; current = current.parent) {
            if (current === ancestor) return true;
          }
          return false;
        }
      },
    };
  },
};
