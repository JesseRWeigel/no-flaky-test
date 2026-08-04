# eslint-plugin-no-flaky-test

Six ESLint rules for the mechanisms that actually make JavaScript tests flaky, each one **measured
for false positives against 1,912 real test files** before it shipped.

**[Measured results](https://jesserweigel.github.io/no-flaky-test/)**

```bash
npm i -D eslint-plugin-no-flaky-test
```

```js
// eslint.config.js
import noFlakyTest from 'eslint-plugin-no-flaky-test';

export default [
  {
    files: ['**/*.{test,spec}.{js,ts,tsx}', '**/__tests__/**'],
    ...noFlakyTest.configs.recommended,
  },
];
```

No runtime dependencies. ESLint 8.57+ or 9. Works on JavaScript and, with
`@typescript-eslint/parser`, on TypeScript. Needs no type information.

## The problem is precision, not detection

Detecting `Math.random()` in a test file is trivial. The hard part is not reporting the 27 places
where it is completely fine, because a rule that fires on correct code is switched off inside a
week and takes every real finding with it.

So the measurement is the deliverable. The rules were run over **1,912 test files, 277,942 lines**:
312 from working projects and **1,600 shipped inside published npm packages**, deduplicated by
content hash. The second half is the one that counts. It is test code written and reviewed by
other people, so when a rule fires there the burden is on the rule.

That produced **102 findings, and all 102 were read by hand** and given a verdict in
[`results/handcheck.json`](results/handcheck.json). Not a sample. All of them.

| verdict | count | meaning |
|---|---|---|
| real flake | 73 | a mechanism that can fail intermittently; the author would want to know |
| deliberate | 20 | the code really is nondeterministic and the author meant it, almost always fuzz testing |
| false | 9 | the rule is wrong; no sequence of events can make that test fail |

**Measured false-positive rate: 8.8%**, and it is not spread evenly:

| rule | findings | real flake | deliberate | false | FP rate |
|---|---:|---:|---:|---:|---:|
| [`no-floating-promise`](docs/rules/no-floating-promise.md) | 20 | 20 | 0 | 0 | 0.0% |
| [`no-bare-timeout`](docs/rules/no-bare-timeout.md) | 10 | 10 | 0 | 0 | 0.0% |
| [`no-unordered-assert`](docs/rules/no-unordered-assert.md) | 3 | 3 | 0 | 0 | 0.0% |
| [`no-live-network`](docs/rules/no-live-network.md) | 1 | 1 | 0 | 0 | 0.0% |
| [`no-unmocked-time`](docs/rules/no-unmocked-time.md) | 28 | 27 | 0 | 1 | 3.6% |
| [`no-unseeded-random`](docs/rules/no-unseeded-random.md) | 40 | 12 | 20 | 8 | 20.0% |

`no-unseeded-random` is the weak one and the docs page says so rather than burying it. Half its
findings are deliberate fuzzing in lezer, atomically, browserify-zlib and prismarine-world, where
the rule is correct and the author does not want it changed.

## What it found in code other people shipped

These are not invented examples.

**`zod` never runs its OpenAPI 3.0 validation.** Fourteen call sites across two published versions:

```js
test('nullable openapi-3.0', () => {
  const jsonSchema = z.toJSONSchema(schema, { target: 'openapi-3.0' });
  validateOpenAPI30Schema(jsonSchema);        // declared async, never awaited
  expect(jsonSchema).toMatchInlineSnapshot(`...`);
});
```

`validateOpenAPI30Schema` is `async (s) => Promise<true>`. The promise is dropped, the test
function returns, and the validation has never executed. The snapshot below it passes, so the
test is green and always has been.

**`resolve` asserts a 50ms wall-clock budget**, fourteen times across five files and three
published versions:

```js
t.ok(new Date() - start < 50, 'resolve.sync timedout');
```

**`@jspm/core` sorted one line and forgot the next:**

```js
assert.deepStrictEqual(fs.readdirSync('/').sort(), ['dev', 'usr', 'home', 'tmp'].sort());
assert.deepStrictEqual(fs.readdirSync('/usr'), ['bin']);   // reported
```

**`minecraft-protocol` throws if two packets arrive more than one millisecond apart.**
**`pg-protocol` drops the same async helper five times.** **`simple-update-notifier` has an
unawaited `expect(...).rejects`,** which passes whether the promise resolves, rejects, or never
settles.

## What the rules refuse to report, and why

Every one of these is a carve-out that exists because the first version of the rule was wrong
about real code, and the corpus said so.

**Object key order is not unordered.** `Object.keys`, `Object.entries`, `Set` and `Map` iteration,
and `Promise.all` all have orders defined by the language. A rule that fired on them would be
wrong far more often than right, so `no-unordered-assert` covers only directory listings, globs,
and `Promise.race`/`Promise.any`.

**A clock read in a fixture is not a flake.** The first version of `no-unmocked-time` reported
every `Date.now()` and `new Date()` in a file without fake timers: 37 findings, 26 of them noise
like `lastActivity: new Date().toISOString()` filling a required field. It now reports three
shapes that can actually fail, and stays quiet when the value is offset by more than a second,
when it is a `||` default, or when it feeds a shape assertion such as `toBeInstanceOf(Date)`.

**A callback is a way of handling a promise.** `writeFileAtomic(f, d, err => ...)` in
`atomically`, `utils.call(..., done)` in `yggdrasil`. Reporting those was the worst thing
`no-floating-promise` ever did.

**Fixtures are not tests.** A fixture for a hydration checker calls `Math.random()` on purpose and
a fixture for a caching checker fetches a real URL on purpose. Paths under `fixtures/`, `__mocks__/`
and files named `*fixture*` are skipped entirely.

**`Math.random() > 0` is not a coin flip.** `Math.random()` returns a value in `[0, 1)`, so both
that and a bare `Math.random() ? a : b` take the same branch every time. zod uses the trick to
widen an inferred type.

## Things measurement proved wrong

**A whole rule was deleted.** `no-floating-promise` originally had a fourth case: report a call
whose callee is `await`ed somewhere else in the same file, on the theory that inconsistency inside
one file is strong evidence. It found 45 sites and **all eight sampled by hand were false
positives**: chai's `expect(x).to.equal(y)` next to an `await expect(...)`, fastq's deliberately
fire-and-forget `queue.push(i)` next to an awaited `queue.drained()`. It measured at zero
precision. It is gone rather than shipped behind a flag.

**Name-based lookup was wrong.** `rfdc`'s suite declares `const fn = async () => {}` in one `it`
block and `function fn () {}` in another. A flat set of async function names reported every call
to the synchronous one. Resolving through ESLint's scope manager fixed it.

**Argument position does not tell you which side is expected.** `no-unmocked-time` assumed
argument 0 was the actual value, and reported `t.equal(false, whichTypedArray(new Date()), 'msg')`
in four separate packages, where the clock is input and the expected value comes first. It now
uses the presence of a literal in another argument slot instead.

**Reporting bare `Math.random` as a value was a net loss.** The first suite it met contained
`assert.equal(Math.random, before.random)`, a test asserting that a stub had been removed. The
handler was deleted.

**The measurement itself was wrong three times before it was right**, in ways that all looked like
success:

- ESLint 9 answers *"File ignored because outside of base path"* for any file above `cwd`, and
  with `warnIgnored` suppressed that is indistinguishable from a clean file. The first run
  reported 305 files scanned and **zero problems**.
- A flat config with no `files` key applies only to `.js`/`.mjs`/`.cjs`. Every TypeScript file
  came back as *"ignored because no matching configuration was supplied"*. Same silent shape.
- ESLint ignores `node_modules` unconditionally, and no `ignores` pattern turns it off, so the
  entire 1,600-file vendor corpus reported clean. It is staged into a temporary tree now.

Each of those was caught only because `scan.mjs` treats *"file was not linted"* as a loud failure
rather than as an empty result.

## Verification

```bash
npm install
bash scripts/verify.sh
```

Ten layers. The ones doing real work:

- **Negative controls.** 26 invalid fixtures against **56 valid ones that must stay silent**,
  and `test/corpus/correct.test.ts` is a whole file of correct code using every construct the
  rules look for, which must produce exactly zero findings. Two rules were found dead by these
  tests: `calleeName()` returns null for a `new` expression, which had silently disabled the
  entire sleep detector, and it returns null for `[1, 2].forEach(...)`, which had disabled the
  async-forEach detector.
- **An independent scanner.** `scripts/oracle.mjs` shares no code with `lib/`. It is a
  hand-written tokenizer that decides, per line, whether a construct is in real code or only
  inside a string or a comment. Every finding must be confirmed present in the code stream, and
  none may land on a trigger that exists only when quoted. The corpus contains **7,561 quoted-only
  trigger lines**, so that check has plenty of opportunity to fail; a regex-based implementation
  would report them. Independence is proved by walking the import graph with the module resolver's
  own rules, not by grep.
- **The packed tarball.** `npm pack`, install into a fresh directory, then load the plugin from
  the installed copy, assert it resolves out of `node_modules`, assert the docs pages shipped, and
  run it over both a flaky and a correct sample. A missing entry in `package.json` `files` ships a
  broken package and nothing in the working tree notices.
- **Eight sabotages**, each proved to have applied *and* to have changed what the plugin reports
  before anything is concluded about whether the checks noticed. Four make a rule go silent and
  four make it over-report, because those are different failures and the second is the one that
  gets a plugin uninstalled.
- **The frozen record.** `results/corpus.json` names every file measured and every finding
  produced. Any change to the rules that alters a finding fails the build until the new finding is
  read by hand and given a verdict.
- **The README and the page.** `scripts/check-docs.mjs` fails if any number here disagrees with
  `results/`, or if `docs/index.html` is not exactly what `scripts/build-docs.mjs` produces from
  the measurement files.

The corpus check **fails rather than skips** when there is no corpus on the machine, and says what
to set `FLAKY_CORPUS` to. A skipped check reports the same success as one that ran.

## Rules

| rule | what it reports |
|---|---|
| [`no-bare-timeout`](docs/rules/no-bare-timeout.md) | a fixed sleep standing in for a condition nobody expressed |
| [`no-unmocked-time`](docs/rules/no-unmocked-time.md) | the clock deciding an assertion, by calendar, by race, or by machine speed |
| [`no-unseeded-random`](docs/rules/no-unseeded-random.md) | random input, so a failure names a value nobody can reproduce |
| [`no-floating-promise`](docs/rules/no-floating-promise.md) | a promise nobody awaits, so its assertions run elsewhere or never |
| [`no-unordered-assert`](docs/rules/no-unordered-assert.md) | an order-sensitive assertion on a collection with no defined order |
| [`no-live-network`](docs/rules/no-live-network.md) | a request to a real host, which fails on DNS, on a rate limit, and offline |

Each page explains the flake mechanism, what the rule deliberately does not report, and how to
fix it. `configs.recommended` turns all six on as errors; `configs.warn` turns them on as
warnings, for dropping into a suite that already has flakes.

## Known limits

- **No type information.** `no-floating-promise` can only decide "returns a promise" from syntax,
  so it catches functions declared `async` in the same file, `expect().resolves/.rejects`, and
  async `forEach` callbacks. It will not catch an unawaited call into an imported library. If you
  already run `@typescript-eslint/no-floating-promises` with type information, that rule is
  strictly better for this one hazard; keep both, they overlap without conflicting.
- **`no-live-network` only reports literal URLs.** A request built from a variable is left alone,
  because the common case is a local test server on a runtime port and guessing wrong there would
  fire on every integration test in the repository.
- **The corpus is one machine's.** 1,912 files across 267 npm packages is enough to find the
  false-positive classes documented above, and it is not a random sample of all JavaScript.
- **`no-unseeded-random` at 20% is the honest number.** If your suite fuzzes on purpose, disable
  it in the fuzzer file rather than globally.

## Status

`bash scripts/verify.sh`, run from a clean shell on 2026-08-04:

```
0. environment
        node v24.13.0
        eslint 9.39.5
        parser 8.66.0
  ok    node, eslint and the TypeScript parser are present

1. the plugin loads and exposes what it claims
        no-bare-timeout, no-unmocked-time, no-unseeded-random, no-floating-promise, no-unordered-assert, no-live-network
  ok    6 rules, both presets

2. unit suite (every invalid case paired with a valid negative control)
        ℹ tests 9
        ℹ pass 9
        ℹ fail 0
  ok    9 test cases passed, covering 82 rule fixtures
  ok    26 invalid fixtures, each paired against 56 valid ones that must stay quiet

3. the rules against real test suites
        corpus: 1912 test files, 277942 lines
                312 from working repositories, 1600 shipped by npm packages
        findings: 102
                   4  no-bare-timeout/doneTimer
                   3  no-bare-timeout/sleep
                   3  no-bare-timeout/waitForTimeout
                  19  no-floating-promise/asyncCall
                   1  no-floating-promise/expectAsync
                   1  no-live-network/live
                   5  no-unmocked-time/calendar
                  23  no-unmocked-time/elapsed
                   3  no-unordered-assert/listing
                  40  no-unseeded-random/random
        independent scanner: 102/102 findings confirmed present in code
                7420 lines in the corpus carry a trigger only inside a string or comment
                (a regex-based implementation would report those; none of them was reported)
        hand-checked: 102/102 findings judged individually
                73 real flake mechanisms
                20 correctly detected, deliberately nondeterministic
                9 false positives
        false-positive rate: 8.8%
        frozen record: 1912 files, 1912 still present
        findings match the frozen record exactly: 102 findings
  ok    findings on the real corpus match the frozen record

4. the independent scanner has teeth
        independent scanner: 102/102 findings confirmed present in code
                7420 lines in the corpus carry a trigger only inside a string or comment
  ok    every finding confirmed by a second implementation

5. the scanner shares no code with the rules
        1 modules reachable from scripts/oracle.mjs, none of them under lib/
        scripts/oracle.mjs
  ok    the scanner is independent, proved by import graph

6. the same corpus produces the same findings twice
        1912 files pinned
  ok    two runs are byte for byte identical (102 findings)

7. the packed tarball works from an installed copy
        eslint-plugin-no-flaky-test-0.1.0.tgz (33 KB)
        resolved from node_modules/eslint-plugin-no-flaky-test/lib/index.js
        flaky sample: no-flaky-test/no-bare-timeout, no-flaky-test/no-unseeded-random
        correct sample: 0 findings
  ok    the packed plugin loads, reports, and stays quiet on correct code from an install

8. sabotage
        timeout-rule-disabled      findings 11 -> 8, unit 1, corpus 1
  ok    sabotage "timeout-rule-disabled" is caught
        random-rule-never-reports  findings 11 -> 10, unit 1, corpus 1
  ok    sabotage "random-rule-never-reports" is caught
        clock-control-always-assumed findings 11 -> 8, unit 1, corpus 1
  ok    sabotage "clock-control-always-assumed" is caught
        floating-promise-scope-ignored findings 11 -> 10, unit 1, corpus 1
  ok    sabotage "floating-promise-scope-ignored" is caught
        string-context-carve-out-removed findings 11 -> 12, unit 1, corpus 1
  ok    sabotage "string-context-carve-out-removed" is caught
        sort-no-longer-clears-a-listing findings 11 -> 12, unit 1, corpus 1
  ok    sabotage "sort-no-longer-clears-a-listing" is caught
        interceptors-not-detected  findings 11 -> 12, unit 1, corpus 0
  ok    sabotage "interceptors-not-detected" is caught
        test-file-detection-inverted findings 11 -> 0, unit 1, corpus 1
  ok    sabotage "test-file-detection-inverted" is caught

9. the README and the docs say what was actually measured
        ok    README.md prose has no placeholder markers left in it
        ok    README.md has a Status section carrying real verify output
        ok    README.md states all 7 measured numbers, and they match results/corpus.json
        ok    102 hand-checked verdicts for 102 findings, one each
        ok    6 rule docs pages exist and are linked from the README
        ok    docs/index.html is exactly what the measurement files produce
  ok    README, docs pages and docs/index.html agree with results/

10. hygiene
  ok    no absolute home paths in tracked files
  ok    no credential-shaped strings in tracked files
  ok    no dependencies or tarballs are tracked
  ok    no tracked file over 400 KB
        32 tracked files, none contain NUL
  ok    no tracked file is binary to the secret scan

23 passed, 0 failed
VERIFY OK
```

Task DEVT-030 from [722 things to build](https://github.com/JesseRWeigel/722-things-to-build).

MIT.
