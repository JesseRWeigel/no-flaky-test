import test from 'node:test';
import assert from 'node:assert/strict';
import { Linter } from 'eslint';
import plugin from '../lib/index.js';

const config = {
  plugins: { flaky: plugin },
  rules: { 'flaky/no-unseeded-random': 'error' },
};
const lint = source => new Linter().verify(source, config, { filename: 'signup.test.js' });

const generatedName = 'test("signup", () => signup(faker.person.firstName()));';

for (const [name, prefix] of [
  ['a comment', '// TODO: faker.seed(42)'],
  ['a string', 'const howToReproduce = "faker.seed(42)";'],
  ['a regex', 'const example = /faker.seed(42)/;'],
]) {
  test(`seeding text in ${name} does not suppress an unseeded faker call`, () => {
    const messages = lint(`${prefix}\n${generatedName}`);
    assert.deepEqual(messages.map(({ messageId, line }) => [messageId, line]), [['faker', 2]]);
  });
}

test('an actual faker seed call in a hook still suppresses the finding', () => {
  assert.deepEqual(lint(`beforeEach(() => faker.seed /* reproducible */ (42));\n${generatedName}`), []);
});

test('an actual faker seed call after the test declaration is also recognized', () => {
  assert.deepEqual(lint(`${generatedName}\nbeforeEach(() => faker.seed(42));`), []);
});
