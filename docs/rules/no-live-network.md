# no-live-network

Disallow requests to real remote hosts from tests.

## Why this is flaky

A test that reaches the internet fails for reasons that have nothing to do with the code: the DNS
resolver on the runner, a rate limit, a certificate rotation, an outbound proxy, the service
having an incident, or no network at all on a train. It also fails **slowly**, which is worse. A
30 second connect timeout multiplied across a suite turns a two minute run into twenty, and by
then nobody runs the suite locally.

```js
const res = await fetch('https://registry.npmjs.org/left-pad', { signal: AbortSignal.timeout(8000) });
```

That is real, from a project on this machine. It is a deliberate integration check, and it is
still the reason that suite cannot run offline.

## What is reported

`messageId: live` — a request whose URL is a **literal**, or a template whose leading text is a
literal, pointing at a host that is not local, in a file with no visible interceptor. Covers
`fetch`, `axios.*`, `got`, `http.request`, `https.get`, `superagent`, `ky`, `new WebSocket`, and
`new EventSource`.

## What is deliberately not reported

- A URL built from a variable: `` fetch(`${base}/healthz`) ``. The overwhelmingly common case is a
  local test server on a port chosen at runtime, and guessing wrong there would fire on every
  integration test in the repository. The rule reports only what it can prove.
- localhost, `127.0.0.1`, `0.0.0.0`, `[::1]`, `*.local`, `host.docker.internal`, and any private
  address range.
- The reserved TLDs `.invalid`, `.test`, `.example` and `.localhost`, which never resolve and are
  used precisely because of that.
- Any file that installs an interceptor: an import of `msw`, `nock`, `fetch-mock`, `undici`, or
  `@pollyjs/core`; a call to `setupServer`, `nock()`, `setGlobalDispatcher`, `new MockAgent`; a
  `vi.mock('axios')`; `vi.stubGlobal('fetch', ...)`; or an assignment to `globalThis.fetch`.

## Fix

```js
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

const server = setupServer(
  http.get('https://registry.npmjs.org/left-pad', () => HttpResponse.json({ name: 'left-pad' })),
);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
```

If the request is the point, move it to a suite that is allowed to be online and exclude that
directory from this rule.

## Options

| option | default | effect |
|---|---|---|
| `allowHosts` | `[]` | hostnames that may be contacted for real |
