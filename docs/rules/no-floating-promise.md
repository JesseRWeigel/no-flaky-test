# no-floating-promise

Disallow promises in test bodies that are never awaited.

## Why this is flaky

A promise nobody awaits keeps running after the test function returns. The runner has already
moved on, so one of three things happens, and the third is the reason this rule exists:

- assertions inside it fire during a **later** test and are attributed to that test;
- the work it does, a write, an insert, a mock setup, lands in the middle of an unrelated test;
- **the test passes whether the code works or not**, because nothing it asserts is ever reached.

The first two are noisy and get noticed. The third is invisible, and stays invisible for years.

Real example, from `zod`'s own suite, in every published 4.x version on this machine:

```js
test('nullable openapi-3.0', () => {
  const jsonSchema = z.toJSONSchema(schema, { target: 'openapi-3.0' });
  validateOpenAPI30Schema(jsonSchema);          // declared `async`, never awaited
  expect(jsonSchema).toMatchInlineSnapshot(`...`);
});
```

`validateOpenAPI30Schema` is `async (s) => Promise<true>`. The OpenAPI validation it performs has
never run in fourteen call sites. The snapshot assertion below it passes, so the test is green.

`pg-protocol` has the same shape five times over, and `simple-update-notifier` has the
`expect(...).rejects` version, which passes whether the promise resolves, rejects, or never
settles at all.

## What is reported

No type information is available to an ESLint rule by default, so "returns a promise" cannot be
decided in general. Three cases can be decided from syntax alone:

- `messageId: asyncCall` — the callee resolves, **through the scope manager**, to a function
  declared `async` in this file.
- `messageId: expectAsync` — an `expect(...)` chain containing `.resolves` or `.rejects` that
  nothing awaits or returns.
- `messageId: forEachAsync` — an `async` callback passed to `.forEach()`, which discards return
  values by definition, when that callback contains an `await`.

## What is deliberately not reported

- A call given a **callback**. `writeFileAtomic(f, d, err => ...)` is handling completion, just
  not through a promise. Many libraries accept either form, and this carve-out removed the worst
  false positives the rule ever produced.
- Anything awaited, returned, assigned, spread, put in an array, given to `Promise.all`, or
  chained with `.then` / `.catch` / `.finally`.
- A **fourth heuristic that was built and then deleted**: reporting a call whose callee is awaited
  somewhere else in the same file. It found 45 sites and all eight sampled by hand were wrong.
  Chai's `expect(x).to.equal(y)` beside an `await expect(...)`, fastq's deliberately
  fire-and-forget `queue.push(i)` beside an awaited `queue.drained()`. It measured at zero
  precision, so it is gone rather than shipped behind a flag.

Name-based lookup was also wrong and is gone. `rfdc`'s suite declares `const fn = async () => {}`
in one `it` block and `function fn () {}` in another, and a flat set of names reported every call
to the synchronous one.

## Fix

```js
await validateOpenAPI30Schema(jsonSchema);
await expect(getDistVersion('x', 'latest')).rejects.toThrow('...');
for (const item of items) await check(item);       // instead of items.forEach(async ...)
```
