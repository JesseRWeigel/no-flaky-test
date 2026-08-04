#!/usr/bin/env bash
# Verification for eslint-plugin-no-flaky-test.
#
# A lint rule has two ways of being wrong and only one of them is obvious.
#
#   It can MISS. Someone notices eventually, when a flake reaches CI.
#   It can FIRE ON CORRECT CODE. Nobody debugs that; they turn the rule off, and every real
#   finding goes with it. This is the failure that ends a plugin, so most of the work below is
#   about it: negative controls in the unit suite, and a hand-checked verdict for every single
#   finding on 1900 real test files.
#
# Layers:
#   1  environment
#   2  unit suite, every invalid case paired with a valid case that must stay quiet
#   3  the rules against ~1900 real test files, compared against a frozen record
#   4  an independent scanner, sharing no code with lib/, confirms every finding is real code
#   5  the independence proved by walking the import graph rather than by grep
#   6  determinism: the same corpus produces the same findings twice
#   7  the packed tarball installed elsewhere and run from the installed copy
#   8  sabotages, each proved to have applied AND to have changed the output first
#   9  README and docs agree with the measured numbers
#  10  hygiene
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"
CORPUS="${FLAKY_CORPUS:-$HOME/Projects}"

pass=0; fail=0
ok()  { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "0. environment"
node --version | sed 's/^/        node /'
if [ ! -d node_modules/eslint ]; then
  bad "node_modules is missing. Run: npm install"
  echo "VERIFY FAILED"; exit 1
fi
node -p "'eslint ' + require('eslint/package.json').version" | sed 's/^/        /'
node -p "'parser ' + require('@typescript-eslint/parser/package.json').version" | sed 's/^/        /'
ok "node, eslint and the TypeScript parser are present"

echo
echo "1. the plugin loads and exposes what it claims"
if node -e "
const p = require('./lib/index.js');
const ids = Object.keys(p.rules);
if (ids.length !== 6) throw new Error('expected 6 rules, found ' + ids.length);
for (const [id, rule] of Object.entries(p.rules)) {
  if (typeof rule.create !== 'function') throw new Error(id + ' has no create()');
  if (!rule.meta.messages || Object.keys(rule.meta.messages).length === 0) {
    throw new Error(id + ' has no messages');
  }
}
if (!p.configs.recommended || !p.configs.warn) throw new Error('missing configs');
console.log(ids.join(', '));
" >"$TMP/load.log" 2>&1; then
  sed 's/^/        /' "$TMP/load.log"; ok "6 rules, both presets"
else
  bad "the plugin does not load"; sed 's/^/        /' "$TMP/load.log"
fi

echo
echo "2. unit suite (every invalid case paired with a valid negative control)"
if node --test "test/**/*.test.mjs" >"$TMP/unit.log" 2>&1; then
  # node --test prints its summary with an information glyph, not with '#'. Matching '^# pass'
  # found nothing and printed "ok    unit tests passed" with an empty count, which is a claim
  # about a number that was never read.
  grep -E '(tests|pass|fail) [0-9]+' "$TMP/unit.log" | head -3 | sed 's/^/        /'
  units=$(grep -oE '(^|[^a-z])pass [0-9]+' "$TMP/unit.log" | grep -oE '[0-9]+' | head -1)
  assertions=$(grep -cE '^\s+(\.\.\.FILE|\{ \.\.\.FILE|\{ filename:)' test/rules.test.mjs)
  if [ -z "$units" ]; then
    bad "the unit suite passed but its test count could not be read from the output"
  else
    ok "$units test cases passed, covering $assertions rule fixtures"
  fi
else
  bad "unit suite"; grep -E '✖|AssertionError|Error' "$TMP/unit.log" | head -10 | sed 's/^/        /'
fi

# The count of negative controls is a claim like any other, so it is counted rather than asserted.
# The first version of this counter matched the valid and invalid blocks together and reported the
# total as if it were all negative controls.
counts=$(node -e "
const t = require('fs').readFileSync('test/rules.test.mjs', 'utf8');
let valid = 0, invalid = 0;
for (const b of t.matchAll(/(valid|invalid): \[([\s\S]*?)\n  \],/g)) {
  const n = (b[2].match(/\{ \.\.\.FILE|\{ filename:|^      \.\.\.FILE/gm) || []).length;
  if (b[1] === 'valid') valid += n; else invalid += n;
}
console.log(valid + ' ' + invalid);
" 2>/dev/null)
valid_cases=${counts%% *}
invalid_cases=${counts##* }
if [ "${valid_cases:-0}" -ge 40 ] && [ "${invalid_cases:-0}" -ge 20 ] &&
   [ "${valid_cases:-0}" -gt "${invalid_cases:-0}" ]; then
  ok "$invalid_cases invalid fixtures, each paired against $valid_cases valid ones that must stay quiet"
else
  bad "fixtures are unbalanced: ${valid_cases:-0} valid, ${invalid_cases:-0} invalid. Every rule needs correct code proving it does not fire."
fi

echo
echo "3. the rules against real test suites"
if [ ! -d "$CORPUS" ]; then
  bad "no corpus at $CORPUS, so nothing was measured. Set FLAKY_CORPUS to a directory of JS/TS projects."
else
  node scripts/check-corpus.mjs --corpus "$CORPUS" >"$TMP/corpus.log" 2>&1
  rc=$?
  sed 's/^/        /' "$TMP/corpus.log"
  if [ "$rc" -eq 0 ]; then
    ok "findings on the real corpus match the frozen record"
  else
    bad "the corpus check failed (exit $rc)"
  fi
fi

echo
echo "4. the independent scanner has teeth"
# Proved by construction inside check-corpus.mjs, but the numbers matter, so read them back.
if grep -q 'findings confirmed present in code' "$TMP/corpus.log" 2>/dev/null; then
  grep -E 'independent scanner|only inside a string' "$TMP/corpus.log" | sed 's/^/        /'
  ok "every finding confirmed by a second implementation"
else
  bad "the independent scanner did not run"
fi

echo
echo "5. the scanner shares no code with the rules"
if node -e "
const fs = require('fs');
const path = require('path');
// Walk the import graph of scripts/oracle.mjs the way the module loader would, and fail if any
// reachable module lives under lib/. A grep for the string 'lib/' would miss a transitive import
// and would also trip over the word appearing in a comment.
const seen = new Set();
const stack = ['scripts/oracle.mjs'];
const tainted = [];
while (stack.length) {
  const file = path.normalize(stack.pop());
  if (seen.has(file)) continue;
  seen.add(file);
  if (file.startsWith('lib' + path.sep) || file.startsWith('lib/')) { tainted.push(file); continue; }
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
  const specs = [
    ...src.matchAll(/^\s*import\s[^;]*?from\s+['\"]([^'\"]+)['\"]/gm),
    ...src.matchAll(/^\s*import\s+['\"]([^'\"]+)['\"]/gm),
    ...src.matchAll(/\brequire\(\s*['\"]([^'\"]+)['\"]\s*\)/g),
    ...src.matchAll(/\bimport\(\s*['\"]([^'\"]+)['\"]\s*\)/g),
  ].map((m) => m[1]);
  for (const spec of specs) {
    if (!spec.startsWith('.')) continue;
    stack.push(path.join(path.dirname(file), spec));
  }
}
if (tainted.length) throw new Error('oracle.mjs reaches ' + tainted.join(', '));
console.log(seen.size + ' modules reachable from scripts/oracle.mjs, none of them under lib/');
console.log([...seen].sort().join(', '));
" >"$TMP/imports.log" 2>&1; then
  sed 's/^/        /' "$TMP/imports.log"; ok "the scanner is independent, proved by import graph"
else
  bad "$(cat "$TMP/imports.log")"
fi

echo
echo "6. the same corpus produces the same findings twice"
if [ -d "$CORPUS" ]; then
  # Pin the file list first. Other agents write to this machine's projects while verify runs, so
  # two --corpus scans seconds apart can differ for reasons that are nothing to do with the rules.
  node -e "
import('./scripts/collect-corpus.mjs').then((m) => {
  const halves = m.collect(process.argv[1]);
  require('fs').writeFileSync(process.argv[2], JSON.stringify(halves));
  console.log(halves.own.length + halves.vendor.length + ' files pinned');
});
" "$CORPUS" "$TMP/list.json" | sed 's/^/        /'
  node scripts/scan.mjs --list "$TMP/list.json" >"$TMP/run1.json" 2>/dev/null
  node scripts/scan.mjs --list "$TMP/list.json" >"$TMP/run2.json" 2>/dev/null
  if cmp -s "$TMP/run1.json" "$TMP/run2.json"; then
    ok "two runs are byte for byte identical ($(node -p "
      const d=require('$TMP/run1.json');(d.own.findings.length+d.vendor.findings.length)+' findings'"))"
  else
    bad "the scan is not reproducible"
    diff <(node -p "JSON.stringify(require('$TMP/run1.json').own.findings)") \
         <(node -p "JSON.stringify(require('$TMP/run2.json').own.findings)") | head -5 | sed 's/^/        /'
  fi
else
  bad "no corpus, so reproducibility was not checked"
fi

echo
echo "7. the packed tarball works from an installed copy"
# A missing entry in package.json "files" ships a plugin that cannot load, and nothing in the
# working tree notices, because everything here resolves from source.
PACKDIR="$TMP/pack"
mkdir -p "$PACKDIR"
if npm pack --pack-destination "$PACKDIR" >"$TMP/pack.log" 2>&1; then
  TARBALL="$(ls "$PACKDIR"/*.tgz 2>/dev/null | head -1)"
  if [ -z "$TARBALL" ]; then
    bad "npm pack produced no tarball"
  else
    printf '        %s (%s KB)\n' "$(basename "$TARBALL")" "$(( $(stat -c%s "$TARBALL") / 1024 ))"
    CONSUMER="$TMP/consumer"
    mkdir -p "$CONSUMER"
    ( cd "$CONSUMER" && npm init -y >/dev/null 2>&1 &&
      npm install --no-audit --no-fund --silent "$TARBALL" \
        "$ROOT/node_modules/eslint" "$ROOT/node_modules/@typescript-eslint/parser" \
        >"$TMP/install.log" 2>&1 )
    if [ ! -d "$CONSUMER/node_modules/eslint-plugin-no-flaky-test" ]; then
      bad "installing the tarball failed"; tail -5 "$TMP/install.log" | sed 's/^/        /'
    else
      cat > "$CONSUMER/check.mjs" <<'JS'
import { ESLint } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
const plugin = require_('eslint-plugin-no-flaky-test');
const where = require_.resolve('eslint-plugin-no-flaky-test');
if (!where.includes('node_modules')) throw new Error('resolved to source, not the install: ' + where);
// The docs pages must ship too: the message urls point at them and a rule with no docs is a rule
// nobody can act on.
const fs = require_('node:fs');
const path = require_('node:path');
const root = path.dirname(path.dirname(where));
for (const id of Object.keys(plugin.rules)) {
  const doc = path.join(root, 'docs', 'rules', id + '.md');
  if (!fs.existsSync(doc)) throw new Error('the tarball does not contain docs/rules/' + id + '.md');
}
const eslint = new ESLint({
  overrideConfigFile: true,
  overrideConfig: [{
    files: ['**/*.{js,mjs,ts}'],
    languageOptions: { parser: tsParser, parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
    ...plugin.configs.recommended,
  }],
});
const bad = `
it('flaky', async () => {
  await new Promise((r) => setTimeout(r, 300));
  const n = Math.floor(Math.random() * 10);
  expect(choices(n)).toContain(n);
});
`;
const good = `
it('fine', async () => {
  await waitFor(() => expect(el).toBeVisible());
  for (const n of [1, 2, 3]) expect(choices(n)).toContain(n);
});
`;
const badResult = await eslint.lintText(bad, { filePath: 'x.test.ts' });
const goodResult = await eslint.lintText(good, { filePath: 'y.test.ts' });
const ids = badResult[0].messages.map((m) => m.ruleId).sort();
if (ids.length < 2) throw new Error('installed copy found nothing in flaky code: ' + JSON.stringify(badResult[0].messages));
if (goodResult[0].messages.length !== 0) {
  throw new Error('installed copy fired on correct code: ' + JSON.stringify(goodResult[0].messages));
}
console.log('resolved from ' + where.slice(where.indexOf('node_modules')));
console.log('flaky sample: ' + ids.join(', '));
console.log('correct sample: 0 findings');
JS
      if ( cd "$CONSUMER" && node check.mjs ) >"$TMP/consumer.log" 2>&1; then
        sed 's/^/        /' "$TMP/consumer.log"
        ok "the packed plugin loads, reports, and stays quiet on correct code from an install"
      else
        bad "the installed tarball does not work"; tail -8 "$TMP/consumer.log" | sed 's/^/        /'
      fi
    fi
  fi
else
  bad "npm pack failed"; tail -5 "$TMP/pack.log" | sed 's/^/        /'
fi

echo
echo "8. sabotage"
# Each sabotage is proved to have APPLIED and to have CHANGED what the plugin reports, before
# anything is concluded about whether the checks noticed. An attack that quietly did nothing looks
# exactly like a check that works, and it will talk you into weakening a check that was fine.
BASE="$TMP/base.json"
node scripts/scan.mjs --files test/corpus/sabotage.test.ts test/corpus/correct.test.ts >"$BASE" 2>/dev/null

attack() {
  local name="$1" file="$2" old="$3" new="$4"
  local dir="$TMP/attack-$name"
  rm -rf "$dir"; mkdir -p "$dir"
  tar -cf - --exclude=.git --exclude=node_modules --exclude='*.tgz' -C "$ROOT" . | tar -xf - -C "$dir"
  ln -s "$ROOT/node_modules" "$dir/node_modules"

  if ! node -e "
const fs = require('fs');
const [file, old, neu] = process.argv.slice(1);
const t = fs.readFileSync(file, 'utf8');
if (!t.includes(old)) { console.error('SABOTAGE DID NOT APPLY: pattern absent from ' + file); process.exit(1); }
if (old === neu) { console.error('SABOTAGE IS A NO-OP'); process.exit(1); }
fs.writeFileSync(file, t.replace(old, neu));
" "$dir/$file" "$old" "$new" 2>"$TMP/apply-$name.log"; then
    bad "sabotage \"$name\" did not apply, so it proves nothing"
    sed 's/^/        /' "$TMP/apply-$name.log"
    return
  fi

  # Did it change what the plugin says? If not, stop here and say so.
  if ! ( cd "$dir" && node scripts/scan.mjs --files test/corpus/sabotage.test.ts \
         test/corpus/correct.test.ts ) \
       >"$TMP/out-$name.json" 2>/dev/null; then
    ok "sabotage \"$name\" is caught (the plugin no longer runs)"
    return
  fi
  if cmp -s "$TMP/out-$name.json" "$BASE"; then
    bad "sabotage \"$name\" applied but changed no output, so it proves nothing"
    return
  fi
  local before after
  before=$(node -p "require('$BASE').own.findings.length")
  after=$(node -p "require('$TMP/out-$name.json').own.findings.length")

  local urc crc
  ( cd "$dir" && node --test "test/**/*.test.mjs" ) >"$TMP/$name-unit.log" 2>&1; urc=$?
  if [ -d "$CORPUS" ]; then
    ( cd "$dir" && node scripts/check-corpus.mjs --corpus "$CORPUS" ) >"$TMP/$name-corpus.log" 2>&1
    crc=$?
  else
    crc=0
  fi
  printf '        %-26s findings %s -> %s, unit %s, corpus %s\n' "$name" "$before" "$after" "$urc" "$crc"
  if [ "$urc" -ne 0 ] || [ "$crc" -ne 0 ]; then
    ok "sabotage \"$name\" is caught"
  else
    bad "sabotage \"$name\" changed the output and nothing noticed"
  fi
}

# Make a rule miss.
attack "timeout-rule-disabled" "lib/rules/no-bare-timeout.js" \
  "    if (!isTestFile(filename)) return {};" \
  "    if (!isTestFile(filename)) return {}; if (1) return {};"
attack "random-rule-never-reports" "lib/rules/no-unseeded-random.js" \
  "          context.report({ node, messageId: 'random' });" \
  "          if (false) context.report({ node, messageId: 'random' });"
attack "clock-control-always-assumed" "lib/rules/no-unmocked-time.js" \
  "      return facts.fakeTimers || facts.systemTimeSet || facts.dateMocked;" \
  "      return true;"
attack "floating-promise-scope-ignored" "lib/rules/no-floating-promise.js" \
  "      if (!variable || variable.defs.length === 0) return false;" \
  "      if (!variable || variable.defs.length === 0) return false; return false;"
# Make a rule over-report. This is the direction that gets a plugin uninstalled, and the negative
# controls in the unit suite are what catch it.
attack "string-context-carve-out-removed" "lib/rules/no-unseeded-random.js" \
  "          if (allowInStringContext && inStringContext(node)) return;" \
  "          if (false) return;"
attack "sort-no-longer-clears-a-listing" "lib/rules/no-unordered-assert.js" \
  "        if (method === 'sort' || method === 'toSorted') return null;" \
  "        if (method === 'sort' || method === 'toSorted') return unorderedSource(node.callee.object);"
attack "interceptors-not-detected" "lib/shared.js" \
  "      if (last === 'setupServer' || last === 'setupWorker' || last === 'createFetchMock') {" \
  "      if (last === '__never__') {"
attack "test-file-detection-inverted" "lib/shared.js" \
  "  return TEST_FILE.test(normalised);" \
  "  return !TEST_FILE.test(normalised);"

echo
echo "9. the README and the docs say what was actually measured"
if node scripts/check-docs.mjs >"$TMP/docs.log" 2>&1; then
  sed 's/^/        /' "$TMP/docs.log"; ok "README, docs pages and docs/index.html agree with results/"
else
  bad "the README or docs disagree with the measured numbers"
  sed 's/^/        /' "$TMP/docs.log"
fi

echo
echo "10. hygiene"
if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  hits=$(git -C "$ROOT" grep -In -e "/home/$(id -un)" -- . 2>/dev/null | grep -v '^scripts/verify.sh' || true)
  if [ -z "$hits" ]; then ok "no absolute home paths in tracked files"
  else bad "absolute home paths found"; printf '%s\n' "$hits" | head -5 | sed 's/^/        /'; fi

  keys=$(git -C "$ROOT" grep -In -E 'sk-[A-Za-z0-9]{20}|ghp_[A-Za-z0-9]{36}|AKIA[0-9A-Z]{16}' -- . 2>/dev/null || true)
  if [ -z "$keys" ]; then ok "no credential-shaped strings in tracked files"
  else bad "possible credential"; printf '%s\n' "$keys" | head -3 | sed 's/^/        /'; fi

  if [ -z "$(git -C "$ROOT" ls-files | grep -E 'node_modules|\.tgz$' || true)" ]; then
    ok "no dependencies or tarballs are tracked"
  else bad "build output is tracked"; fi

  big=$(git -C "$ROOT" ls-files | while read -r f; do
          [ -f "$f" ] && [ "$(stat -c%s "$f")" -gt 400000 ] && echo "$f"; done || true)
  if [ -z "$big" ]; then ok "no tracked file over 400 KB"
  else bad "large tracked files"; printf '%s\n' "$big" | head -3 | sed 's/^/        /'; fi

  # One NUL byte makes git and grep treat a file as binary, and the two scans above then skip it
  # entirely while reporting the same "nothing found" as a scan that read it.
  if node -e "
const { execFileSync } = require('child_process');
const fs = require('fs');
const files = execFileSync('git', ['-C', process.argv[1], 'ls-files', '-z'])
  .toString('binary').split('\0').filter(Boolean);
const bad = files.filter((f) => {
  try { return fs.readFileSync(require('path').join(process.argv[1], f)).includes(0); }
  catch { return false; }
});
if (bad.length) { console.error('files containing NUL, invisible to the scans above: ' + bad.join(', ')); process.exit(1); }
console.log(files.length + ' tracked files, none contain NUL');
" "$ROOT" >"$TMP/nul.log" 2>&1; then
    sed 's/^/        /' "$TMP/nul.log"; ok "no tracked file is binary to the secret scan"
  else bad "$(cat "$TMP/nul.log")"; fi
else
  bad "not a git repository"
fi

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || { echo "VERIFY FAILED"; exit 1; }
echo "VERIFY OK"
