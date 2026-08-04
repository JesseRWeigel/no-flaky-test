# no-unmocked-time

Disallow the three real-clock patterns that make a test fail on the calendar, on a race, or on
machine speed.

## Why this is flaky

Reading the clock in a test is not by itself a problem, and the first version of this rule assumed
it was. It reported every `Date.now()` and every `new Date()` in a file without fake timers, which
came to 37 findings across 305 real test files, of which 26 were noise:

```js
lastActivity: new Date().toISOString(),   // filling a required field in a fixture
createdAt: new Date(),                    // same
dueAt: new Date(Date.now() + 3600_000),   // an hour of slack, drift cannot reach it
```

None of those can fail. The rule now reports three specific shapes that can.

**CALENDAR.** A clock read with a calendar field pulled out of it.

```js
const now = new Date();
const expected = `${now.getMonth() + 1}/${now.getDate()}`;
expect(getCurrentGameDate()).toBe(expected);
```

Two reads of the clock at two instants. It fails when the day rolls over between them, and it
fails on any runner in a different timezone from the author's, and on 29 February, and at both
daylight-saving transitions. Three of the four findings in the local corpus were this exact shape.

**RACE.** A clock read used as the expected value in an equality assertion.

```js
expect(row.createdAt).toBe(Date.now());
```

One millisecond between the two reads and the test fails. That is rare on a laptop and routine on
a loaded runner.

**ELAPSED.** The difference between two clock reads compared against a threshold.

```js
const start = Date.now();
resolve.sync('./x');
t.ok(new Date() - start < 50, 'resolve.sync timedout');
```

That is `resolve`'s own suite, in five files across three published versions. It is a bet on how
fast the machine is, and CI is slower than a laptop by a factor that changes run to run.

## What is deliberately not reported

- Anything in a file that controls the clock: `vi.useFakeTimers`, `jest.useFakeTimers`,
  `vi.setSystemTime`, `MockDate.set`, `vi.spyOn(Date, 'now')`, `Date.now = ...`.
- A clock value offset by a constant of at least `toleranceMs` (1000 by default). An hour of slack
  cannot be crossed by drift.
- `x || new Date()` and `function f(d = new Date())`. That is a default, not the value the test
  uses.
- A clock value handed to a **shape** assertion. `expect(parse(new Date().toISOString()))
  .toBeInstanceOf(Date)` passes for every instant there has ever been, and zod's suite has 47 of
  them.
- A clock value on the **actual** side of an assertion whose expected side is a literal. tape
  suites write `t.equal(false, whichTypedArray(new Date()), 'msg')` with the expected value first.

## Fix

```js
vi.useFakeTimers();
vi.setSystemTime(new Date('2024-03-15T12:00:00Z'));
// or pass the instant in
expect(getCurrentGameDate(new Date('2024-03-15'))).toBe('03/15');
```

For an elapsed-time assertion, assert on the number of calls or on the order of events rather than
on the wall clock.

## Options

| option | default | effect |
|---|---|---|
| `toleranceMs` | `1000` | a constant offset at least this large suppresses the finding |
