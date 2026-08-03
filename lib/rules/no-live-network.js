'use strict';

const { isTestFile, calleeName, tail, collectFileFacts, staticName } = require('../shared');

// A test that reaches a real host on the internet fails for reasons that have nothing to do with
// the code: the DNS resolver on the CI runner, a rate limit, a certificate rotation, the service
// having an incident, an outbound proxy, or no network at all on an aeroplane. It also fails
// slowly, which is worse, because a 30 second connect timeout multiplied across a suite turns a
// two minute run into twenty.
//
// The rule reports only what it can prove: a request whose URL is a literal (or a template whose
// leading text is a literal) pointing at a host that is not local, in a file with no visible
// interceptor. A URL built from a variable is left alone, because the overwhelmingly common case
// is a local test server on a port chosen at runtime, and guessing wrong there would fire on every
// integration test in the repo.

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1|host\.docker\.internal|[a-z0-9-]+\.local|\d+\.\d+\.\d+\.\d+)$/i;
const PRIVATE_IP = /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/;

const REQUEST_CALLS = new Set([
  'fetch', 'get', 'post', 'put', 'patch', 'delete', 'head', 'request', 'got', 'axios',
]);

function hostOf(text) {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)/i.exec(text.trim());
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  if (scheme !== 'http' && scheme !== 'https' && scheme !== 'ws' && scheme !== 'wss') return null;
  let authority = match[2];
  const at = authority.lastIndexOf('@');
  if (at !== -1) authority = authority.slice(at + 1);
  return authority.replace(/:\d+$/, '');
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'disallow requests to real remote hosts from tests',
      url: 'https://github.com/JesseRWeigel/no-flaky-test/blob/main/docs/rules/no-live-network.md',
    },
    schema: [{
      type: 'object',
      properties: {
        allowHosts: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    }],
    messages: {
      live: 'This test calls {{host}} over the real network and the file installs no interceptor. It will fail on DNS, on a rate limit, behind a proxy, and offline, none of which is a bug in your code. Intercept it (msw, nock, undici MockAgent) or move it to a suite that is allowed to be online.',
    },
  },

  create(context) {
    const filename = context.filename || context.getFilename();
    if (!isTestFile(filename)) return {};
    const options = context.options[0] || {};
    const allowHosts = new Set((options.allowHosts || []).map((h) => h.toLowerCase()));

    let facts = null;
    function intercepted() {
      if (facts === null) facts = collectFileFacts(context.sourceCode.ast);
      return facts.networkIntercepted;
    }

    function literalUrl(node) {
      if (!node) return null;
      if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
      if (node.type === 'TemplateLiteral') {
        const head = node.quasis[0];
        // Only the leading static chunk is known. That is enough to read the host when the
        // template is `https://api.example.com/${id}`, and not enough when it is `${base}/x`,
        // which is exactly the case that must stay quiet.
        return head && head.value.cooked ? head.value.cooked : null;
      }
      if (node.type === 'NewExpression' && staticName(node.callee) === 'URL') {
        return literalUrl(node.arguments[0]);
      }
      if (node.type === 'TSAsExpression' || node.type === 'TSNonNullExpression') {
        return literalUrl(node.expression);
      }
      return null;
    }

    function check(node, urlNode) {
      const raw = literalUrl(urlNode);
      if (!raw) return;
      const host = hostOf(raw);
      if (!host) return;
      if (LOCAL_HOST.test(host) && !/^\d+\.\d+\.\d+\.\d+$/.test(host)) return;
      if (PRIVATE_IP.test(host)) return;
      if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && !PRIVATE_IP.test(host)) {
        // A public literal IP is as remote as a hostname.
      } else if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
        return;
      }
      if (allowHosts.has(host.toLowerCase())) return;
      if (/\.(invalid|test|example|localhost)$/i.test(host)) return; // reserved, never resolves
      if (intercepted()) return;
      context.report({ node, messageId: 'live', data: { host } });
    }

    return {
      CallExpression(node) {
        const full = calleeName(node);
        const last = tail(full);
        if (!last || !REQUEST_CALLS.has(last)) return;

        // `expect(x).get` and similar are not requests; require either a bare `fetch`/`got` or a
        // member call on something that looks like a client.
        if (last !== 'fetch' && last !== 'got' && last !== 'axios' && full && full.includes('.')) {
          const root = full.split('.')[0];
          if (!/^(axios|got|http|https|superagent|request|client|api|supertest|ky|undici)$/i.test(root)) {
            return;
          }
        }
        check(node, node.arguments[0]);
      },

      NewExpression(node) {
        if (staticName(node.callee) !== 'WebSocket' && staticName(node.callee) !== 'EventSource') {
          return;
        }
        check(node, node.arguments[0]);
      },
    };
  },
};
