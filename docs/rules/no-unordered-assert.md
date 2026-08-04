# no-unordered-assert

Disallow order-sensitive assertions on collections that have no defined order.

## Why this is flaky

`fs.readdir` returns entries in whatever order the filesystem hands them over. ext4 returns hash
order, APFS and NTFS usually return something close to alphabetical, tmpfs tends to return
creation order, and an overlay filesystem in a container can return something else again. So:

```js
var containers = fs.readdirSync(out);
t.deepEqual(containers, ['a-files', 'b-files']);
```

is a test of the developer's filesystem. That is `tar-fs`, twice in one function. It passes on
macOS and can fail in a container, on a colleague's machine, or after an unrelated change alters
the order the files were created in.

`@jspm/core` has the version that makes the point best:

```js
assert.deepStrictEqual(fs.readdirSync('/').sort(), ['dev', 'usr', 'home', 'tmp'].sort());
assert.deepStrictEqual(fs.readdirSync('/usr'), ['bin']);
```

The author sorted one line and forgot the next.

## What is not unordered, despite appearances

Most of the obvious candidates turn out to be defined by the language, and a rule that fired on
them would be wrong far more often than right:

| looks unordered | actually |
|---|---|
| `Object.keys`, `Object.entries` | insertion order for string keys, per ES2015 |
| `Set` and `Map` iteration | insertion order |
| `Promise.all` | the order of its input, whatever order things settle in |
| `querySelectorAll` | document order |

What is left is genuinely unordered: directory listings, glob results, and `Promise.race` /
`Promise.any`, whose result is decided by whichever promise wins.

## What is reported

- `messageId: listing` — an order-sensitive assertion (`toEqual`, `deepEqual`, `deepStrictEqual`,
  `toStrictEqual`, `toMatchObject`) on a value that came from `readdir`, `readdirSync`, `glob`, or
  `globSync`, directly or through order-preserving steps like `.map()` and `.filter()`.
- `messageId: index` — indexing into such a value and asserting on the element.
- `messageId: race` — asserting on the identity of the winner of `Promise.race` or `Promise.any`.

## What is deliberately not reported

- Anything with `.sort()` or `.toSorted()` anywhere in the chain.
- `expect(...).toEqual(expect.arrayContaining([...]))`, which is the correct way to assert on an
  unordered collection.
- `.length`, `toHaveLength`, `toContain`, and iteration with `for..of`. None of them depend on
  order.
- `files[0]` in a file that also asserts the listing has exactly one entry. With one entry there
  is only one order, and `jake`'s suite does this twice.

## Fix

```js
assert.deepEqual(fs.readdirSync(out).sort(), ['a-files', 'b-files']);
expect(await readdir(dir)).toEqual(expect.arrayContaining(['a.txt']));
```

## Options

| option | default | effect |
|---|---|---|
| `extraUnorderedSources` | `[]` | extra function names whose result has no defined order |
