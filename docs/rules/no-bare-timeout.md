# no-bare-timeout

Disallow fixed-duration sleeps used as a substitute for waiting on a condition.

## Why this is flaky

`await new Promise(r => setTimeout(r, 200))` is a bet that the work finishes in under 200
milliseconds. Your laptop wins that bet every time. A CI runner shares a physical core with three
other jobs, has a cold filesystem cache, and is throttled after the first minute, so it loses the
bet somewhere between one run in fifty and one run in two thousand.

When it loses, the test fails on an assertion about state that had simply not arrived yet. The
failure looks like a regression, someone spends an afternoon on it, and the fix is to raise the
number, which makes the suite slower and moves the cliff rather than removing it.

The version with no delay at all is the same bet with a smaller stake. `setTimeout(fn, 0)` runs
after the current macrotask, which is not the same as after the pending I/O, so a single tick is
enough on a fast machine and not enough on a loaded one.

## What is reported

- `messageId: sleep` — `await new Promise(r => setTimeout(r, N))`, or a call to a helper defined
  in the same file as exactly that, **when an assertion follows it in the same function**.
- `messageId: waitForTimeout` — `page.waitForTimeout(N)`. Playwright's own documentation says not
  to use it.
- `messageId: doneTimer` — `setTimeout(done, N)` in a mocha-style test or hook. The test ends on
  the timer rather than on the thing it is testing, so if the work takes longer the assertions
  never run.

## What is deliberately not reported

A delay inside a fixture that simulates slow work, with no assertion after it in the same
function. zod's codec tests await a 1ms timer inside `decode` so that `decode` is genuinely
async; fastq's queue worker does the same. Fourteen of the sixteen findings this rule produced on
the vendor corpus before the boundary check existed were fixtures like that.

A timer that resolves with a **value**, `new Promise(r => setTimeout(() => r(true), 50))`, is a
mock producing a result late rather than a guess about how long real work takes.

`setTimeout` that drives an event or a mock callback, where the test awaits the promise the
callback settles. That is deterministic: the await is tied to the work, not to the clock.

## Fix

```js
// instead of
await new Promise((r) => setTimeout(r, 300));
expect(screen.getByRole('alert')).toBeVisible();

// wait for the condition
await waitFor(() => expect(screen.getByRole('alert')).toBeVisible());

// or drive the clock yourself
vi.useFakeTimers();
vi.advanceTimersByTime(300);
```

## Options

| option | default | effect |
|---|---|---|
| `allowZeroDelay` | `false` | do not report a delay of exactly 0 |
| `sleepHelpers` | `[]` | extra function names to treat as sleeps, for helpers imported from elsewhere |
