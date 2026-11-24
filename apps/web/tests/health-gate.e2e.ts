import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { request as apiRequest } from '@playwright/test';

import { expect, requireHealthyApi, test } from './fixtures';

// The precondition every live-API test relies on must fail loudly: a broken stack
// must never turn this write-enabled release suite into a green run of skips.

async function fakeHealth(status: number, body: string) {
  const server = http.createServer((_request, response) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const close = () => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close };
}

test('the API health gate fails on an unsuccessful /health', async () => {
  const cases = [
    [503, '{"ok":false,"error":"unavailable"}', /unhealthy: GET \/health answered 503/],
    [200, '{"ok":false}', /unhealthy: GET \/health answered 200/],
    [200, 'not json', /unhealthy: GET \/health answered 200 null/],
    [200, '{"ok":true,"schemaVersion":12}', /session is no longer valid/],
  ] as const;
  for (const [status, body, message] of cases) {
    const health = await fakeHealth(status, body);
    const context = await apiRequest.newContext({ baseURL: health.url });
    try {
      await expect(requireHealthyApi(context), `${status} ${body}`).rejects.toThrow(message);
    } finally {
      await context.dispose();
      await health.close();
    }
  }
});

test('the API health gate fails when the API is unreachable', async () => {
  const gone = await fakeHealth(200, '{"ok":true,"service":"holdr-api"}');
  await gone.close();
  const context = await apiRequest.newContext({ baseURL: gone.url });
  try {
    await expect(requireHealthyApi(context)).rejects.toThrow(/unreachable/);
  } finally {
    await context.dispose();
  }
});

test('the API health gate passes for the signed-in test stack', async ({ request }) => {
  await requireHealthyApi(request);
});
