'use strict';

const noBareTimeout = require('./rules/no-bare-timeout');
const noUnmockedTime = require('./rules/no-unmocked-time');
const noUnseededRandom = require('./rules/no-unseeded-random');
const noFloatingPromise = require('./rules/no-floating-promise');
const noUnorderedAssert = require('./rules/no-unordered-assert');
const noLiveNetwork = require('./rules/no-live-network');

const rules = {
  'no-bare-timeout': noBareTimeout,
  'no-unmocked-time': noUnmockedTime,
  'no-unseeded-random': noUnseededRandom,
  'no-floating-promise': noFloatingPromise,
  'no-unordered-assert': noUnorderedAssert,
  'no-live-network': noLiveNetwork,
};

const plugin = {
  meta: {
    name: 'eslint-plugin-no-flaky-test',
    version: require('../package.json').version,
  },
  rules,
};

// Flat config presets. `recommended` turns on everything as an error, which is the honest default
// for a plugin whose whole claim is that it does not fire on correct code. `warn` exists for
// dropping the plugin into a suite that already has flakes, so the build stays green while the
// backlog is worked through.
function preset(severity) {
  return {
    name: `no-flaky-test/${severity === 'error' ? 'recommended' : severity}`,
    plugins: { 'no-flaky-test': plugin },
    rules: Object.fromEntries(Object.keys(rules).map((id) => [`no-flaky-test/${id}`, severity])),
  };
}

plugin.configs = {
  recommended: preset('error'),
  warn: preset('warn'),
};

module.exports = plugin;
