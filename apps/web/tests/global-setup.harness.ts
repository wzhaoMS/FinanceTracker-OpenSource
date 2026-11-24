import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, expect, test, type FullConfig } from '@playwright/test';

import verifyDisposableStack from './global-setup';
import { verifyRunIdentity } from './stack-identity';

const RUN_ID = '0123456789abcdef0123456789abcdef';
const RUNNER_STACK = { ok: true, service: 'holdr-api', e2e: { runId: RUN_ID, disposableDataDir: true } };
const PRODUCTION = { ok: true, service: 'holdr-api', db: 'sqlite', accounts: 5, transactions: 141 };

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
interface Stub { url: string; requests: string[]; close: () => Promise<void> }

const stubs: Stub[] = [];

/** A loopback server standing in for whatever answers at WEB_URL. */
async function stub(handler: Handler): Promise<Stub> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const created: Stub = {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
  stubs.push(created);
  return created;
}

const json = (body: unknown, status = 200): Handler => (_req, res) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** Serves /health and an app page that, like Holdr's, first calls `<apiBase>/health`; `head` goes into its head. */
const app = (health: unknown, apiBase = '', head = ''): Handler => (req, res) => {
  if (req.url === '/health') return json(health)(req, res);
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><title>stub</title>${head}<script>fetch(${JSON.stringify(`${apiBase}/health`)})</script>`);
};

test.afterEach(async () => {
  await Promise.all(stubs.splice(0).map((created) => created.close()));
});

test.describe('verifyRunIdentity, through WEB_URL', () => {
  test('accepts the stack started for this run', async () => {
    const web = await stub(json(RUNNER_STACK));
    await expect(verifyRunIdentity(web.url, RUN_ID)).resolves.toBeUndefined();
    expect(web.requests).toEqual(['GET /health']);
  });

  test('refuses a production API, which reports no run identity', async () => {
    const web = await stub(json(PRODUCTION));
    await expect(verifyRunIdentity(web.url, RUN_ID)).rejects.toThrow(/reports no e2e run identity/);
  });

  test('refuses the stack of another run', async () => {
    const web = await stub(json({ ...RUNNER_STACK, e2e: { runId: 'f'.repeat(32), disposableDataDir: true } }));
    await expect(verifyRunIdentity(web.url, RUN_ID)).rejects.toThrow(/reports run identity "f{32}", not this run's/);
  });

  test('refuses a stack whose data directory is not disposable', async () => {
    const web = await stub(json({ ...RUNNER_STACK, e2e: { runId: RUN_ID, disposableDataDir: false } }));
    await expect(verifyRunIdentity(web.url, RUN_ID)).rejects.toThrow(/does not report a disposable data directory/);
  });

  test('refuses without HOLDR_E2E_RUN_ID, sending nothing', async () => {
    const web = await stub(json(RUNNER_STACK));
    await expect(verifyRunIdentity(web.url, undefined)).rejects.toThrow(/HOLDR_E2E_RUN_ID is not set/);
    expect(web.requests).toEqual([]);
  });

  test('refuses a /health that redirects, without following it', async () => {
    const elsewhere = await stub(json(RUNNER_STACK));
    const web = await stub((_req, res) => {
      res.writeHead(302, { location: `${elsewhere.url}/health` });
      res.end();
    });
    await expect(verifyRunIdentity(web.url, RUN_ID)).rejects.toThrow(/could not be fetched/);
    expect(elsewhere.requests).toEqual([]);
  });

  test('refuses an error, a non-JSON answer and an unreachable stack', async () => {
    const failing = await stub(json({ ok: false }, 503));
    await expect(verifyRunIdentity(failing.url, RUN_ID)).rejects.toThrow(/answered HTTP 503/);
    const html = await stub((_req, res) => res.end('<html>not the API</html>'));
    await expect(verifyRunIdentity(html.url, RUN_ID)).rejects.toThrow(/did not answer JSON/);
    const gone = await stub(json(RUNNER_STACK));
    await gone.close();
    await expect(verifyRunIdentity(gone.url, RUN_ID)).rejects.toThrow(/could not be fetched/);
  });
});

test.describe('global setup', () => {
  test.skip(!fs.existsSync(chromium.executablePath()), 'needs Chromium: npx playwright install chromium');

  const configFor = (url: string) => ({ projects: [{ use: { baseURL: url } }] }) as unknown as FullConfig;
  let savedRunId: string | undefined;

  test.beforeEach(() => {
    savedRunId = process.env.HOLDR_E2E_RUN_ID;
    process.env.HOLDR_E2E_RUN_ID = RUN_ID;
  });

  test.afterEach(() => {
    if (savedRunId === undefined) delete process.env.HOLDR_E2E_RUN_ID;
    else process.env.HOLDR_E2E_RUN_ID = savedRunId;
  });

  test('lets the suite run against the stack started for this run', async () => {
    const web = await stub(app(RUNNER_STACK));
    await expect(verifyDisposableStack(configFor(web.url))).resolves.toBeUndefined();
    expect(web.requests).toContain('GET /');
  });

  test('refuses a production stack before loading its app', async () => {
    const web = await stub(app(PRODUCTION));
    await expect(verifyDisposableStack(configFor(web.url))).rejects.toThrow(/reports no e2e run identity/);
    expect(web.requests).toEqual(['GET /health']);
  });

  test('refuses when the app cannot be loaded', async () => {
    const web = await stub((req, res) => (req.url === '/health' ? json(RUNNER_STACK)(req, res) : req.socket.destroy()));
    await expect(verifyDisposableStack(configFor(web.url))).rejects.toThrow(/the app could not be loaded/);
  });

  test('refuses an app whose API requests go to another origin, sending none there', async () => {
    const elsewhere = await stub(json(RUNNER_STACK));
    const web = await stub(app(RUNNER_STACK, elsewhere.url));
    await expect(verifyDisposableStack(configFor(web.url)))
      .rejects.toThrow(/sends its API requests to http:\/\/127\.0\.0\.1:\d+, not to WEB_URL/);
    expect(elsewhere.requests).toEqual([]);
  });

  test('refuses an app that contacts any other origin, sending nothing there', async () => {
    const elsewhere = await stub(json({}));
    const web = await stub(app(RUNNER_STACK, '', `<link rel="stylesheet" href="${elsewhere.url}/fonts.css">`));
    await expect(verifyDisposableStack(configFor(web.url)))
      .rejects.toThrow(/contacted another origin \(the origin guard refused it\): stylesheet http:\/\/127\.0\.0\.1:\d+\/fonts\.css/);
    expect(elsewhere.requests).toEqual([]);
  });

  test('refuses when nothing answers at WEB_URL', async () => {
    const gone = await stub(app(RUNNER_STACK));
    await gone.close();
    await expect(verifyDisposableStack(configFor(gone.url))).rejects.toThrow(/could not be fetched/);
  });
});
