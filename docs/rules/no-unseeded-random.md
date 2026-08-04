# no-unseeded-random

Disallow unseeded randomness in test input.

## Why this is flaky

Random data that feeds the code under test is a lottery. Most draws pass. One draw in a thousand
hits the boundary the code gets wrong, and the failure arrives months later, on someone else's
branch, with a stack trace pointing at a value nobody can recreate. The test is then quarantined
rather than fixed, because there is nothing to debug.

```js
for (let i = 0; i < 20; i++) {
  const correct = Math.floor(Math.random() * 100) - 50;
  expect(generateChoices(correct)).toContain(correct);
}
```

That is real code from a local project. If `generateChoices` is wrong at exactly `-50`, this test
finds it roughly once every fifty runs and never tells you which value did it.

`messageId: random` covers `Math.random()`. `messageId: faker` covers any `faker.*` call in a file
that never calls `faker.seed()`. `messageId: uuid` covers `crypto.randomUUID()` and friends, and
is **off by default**.

## What is deliberately not reported

- Randomness that only builds a unique name or key: `` `tmp-${Math.random()}` ``,
  `'?cb=' + Math.random()`. Nothing asserts on it.
- Files that seed: `vi.spyOn(Math, 'random')`, an import of `seedrandom` or `pure-rand`, a
  `faker.seed(n)` call.
- `Math.random() ? a : b` and `Math.random() > 0 ? a : b`. Neither is a coin flip. `Math.random()`
  returns a value in `[0, 1)`, so both take the same branch every time; zod uses the trick to
  widen an inferred type.
- A random value inside a **shape** assertion: `expect(() => schema.parse(Math.random()))
  .toThrow()` behaves identically for every number.
- `crypto.randomUUID()` unless `reportUuid` is on. It exists to produce a value nobody looks at.

## The honest caveat

This is the noisiest of the six rules, and the reason is not a bug. Of the 39 findings on the
vendor corpus, **20 are deliberate randomised testing**: lezer's incremental-parse fuzzer,
atomically's simulated unstable filesystem, browserify-zlib's random byte pipes,
prismarine-world's random world fills. The rule is correct about all of them and the authors do
not want them changed.

If your suite fuzzes on purpose, put a file-level disable at the top of the fuzzer and keep the
rule on everywhere else. That is a better outcome than turning the rule off, because the twelve
accidental cases in the same corpus, including zod's own `Mocker`, are the ones worth finding.

## Fix

```js
// a table beats a lottery
for (const correct of [-50, -1, 0, 1, 49]) {
  expect(generateChoices(correct)).toContain(correct);
}

// or seed it, so a failure is reproducible
import seedrandom from 'seedrandom';
beforeEach(() => { Math.random = seedrandom('fixed-seed'); });
```

## Options

| option | default | effect |
|---|---|---|
| `reportUuid` | `false` | also report `crypto.randomUUID`, `randomBytes`, `getRandomValues` |
| `allowInStringContext` | `true` | keep quiet when the value only becomes part of a string |
