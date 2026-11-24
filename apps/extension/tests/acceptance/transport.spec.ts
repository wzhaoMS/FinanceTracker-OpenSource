/**
 * The acceptance suite's transport, on every platform: the acceptance build
 * (production id) reaches https://holdr.test only through the egress gate's
 * one CONNECT tunnel, trusts exactly the synthetic Holdr's throwaway key (and
 * no other), sends its device calls with the production extension origin and
 * no cookie, and the Serve stand-in forwards them as Tailscale Serve would.
 * A loopback echo server stands in for Holdr here; acceptance.spec.ts puts
 * E2c behind the same transport on macOS.
 */
import { rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { openExtension, runDirectory, type ExtensionSession } from '../e2e/support/browser.js';
import { EgressGate } from '../e2e/support/gate.js';
import { ACCEPTANCE_ID, ACCEPTANCE_PATH, HOLDR_TUNNEL, REPO_ROOT } from './harness.js';
import { selfSignedIdentity } from './selfSigned.js';
import { startServeStandIn } from './serve.js';

test('transport: the production-id build reaches https://holdr.test only through the tunnel, trusting only the pinned throwaway key', async () => {
  const seen: http.IncomingHttpHeaders[] = [];
  const echo = http.createServer((req, res) => {
    seen.push({ ...req.headers, ':method': req.method, ':path': req.url });
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
  const upstream = { port: (echo.address() as AddressInfo).port };
  const pinned = selfSignedIdentity('holdr.test');
  const unpinned = selfSignedIdentity('other.test');
  const holdr = await startServeStandIn({ identity: pinned, publicHost: 'holdr.test', upstream });
  const stranger = await startServeStandIn({ identity: unpinned, publicHost: 'other.test', upstream });
  const gate = await EgressGate.start(new Map(), new Map([[HOLDR_TUNNEL, holdr.port], ['other.test:443', stranger.port]]));
  const profileDir = join(runDirectory(REPO_ROOT), 'p', 'transport');
  let session: ExtensionSession | null = null;
  try {
    await gate.probe();
    session = await openExtension({
      path: ACCEPTANCE_PATH,
      id: ACCEPTANCE_ID,
      proxyPort: gate.port,
      profileDir,
      extraArgs: [`--ignore-certificate-errors-spki-list=${pinned.spkiSha256}`],
    });
    // A device call from the extension's worker, as its Holdr client makes it.
    const worker = await session.liveWorker();
    const answer = await worker.evaluate(async () => {
      const response = await fetch('https://holdr.test/card-sync/runs', {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json', 'X-Holdr-Client': 'extension-v1' },
        body: '{}',
      });
      return { status: response.status, body: await response.text() };
    });
    expect(answer).toEqual({ status: 200, body: '{"ok":true}' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      ':method': 'POST',
      ':path': '/card-sync/runs',
      host: 'localhost',
      'x-forwarded-host': 'holdr.test',
      'x-forwarded-proto': 'https',
      'x-forwarded-for': '100.101.102.103',
      origin: `chrome-extension://${ACCEPTANCE_ID}`,
      'x-holdr-client': 'extension-v1',
    });
    expect(seen[0].cookie).toBeUndefined();
    expect(seen[0].forwarded).toBeUndefined();
    expect(seen[0].via).toBeUndefined();

    // The browser trusts the pinned key and no other, even behind a tunnel the gate allows.
    const page = await session.context.newPage();
    expect((await page.goto('https://holdr.test/ping'))?.status()).toBe(200);
    await expect(page.goto('https://other.test/ping')).rejects.toThrow(/ERR_CERT_AUTHORITY_INVALID/);
    // (Chromium also fetches the page's favicon on its own.)
    const asked = (paths: string[]) => paths.filter((path) => path !== '/favicon.ico');
    expect(asked(seen.map((request) => String(request[':path'])))).toEqual(['/card-sync/runs', '/ping']);
    // Every other destination is still refused, plain HTTP and HTTPS alike.
    const other = await session.context.newPage();
    expect((await other.goto('http://example.com/'))?.status()).toBe(403);
    await expect((await session.context.newPage()).goto('https://example.com/')).rejects.toThrow(/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY|ERR_/);
    expect(gate.leaks()).toEqual([]);
    expect(asked(holdr.requests.map((request) => request.path))).toEqual(['/card-sync/runs', '/ping']);
    expect(holdr.requests.every((request) => request.status === 200)).toBe(true);
    expect(stranger.requests).toEqual([]);
  } finally {
    await session?.close();
    await gate.close();
    await holdr.close();
    await stranger.close();
    await new Promise<void>((resolve) => echo.close(() => resolve()));
    if (process.env.E3_E2E_KEEP !== '1') rmSync(profileDir, { recursive: true, force: true });
  }
});
