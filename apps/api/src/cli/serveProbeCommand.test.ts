import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http, { type Server } from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { captureIo } from '../control/testControl.js';
import { scratchDir, shortDir, writePrivate } from '../control/testDirs.js';
import { closeServers, releaseFixture, TEST_ADMISSION, TEST_ORIGIN } from '../ingress/fixtures.js';
import { startIngressServers } from '../ingress/server.js';
import type { SocketSafety } from '../ingress/server.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { runServeProbe } from './serveProbeCommand.js';

const TOKEN = 'be'.repeat(32);
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** A self-signed certificate for the test origin's name (LibreSSL's openssl, config-file form). */
function certificate(dir: string) {
  const config = path.join(dir, 'req.cnf');
  fs.writeFileSync(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=holdr.test\n'
    + '[ext]\nsubjectAltName=DNS:holdr.test\nbasicConstraints=critical,CA:TRUE\n');
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', path.join(dir, 'key.pem'),
    '-out', path.join(dir, 'cert.pem'), '-config', config], { stdio: 'ignore' });
  return { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) };
}

/**
 * The real Holdr app in `dist` on its serve socket, behind an HTTPS front that does what Tailscale Serve does for a
 * `unix:` target: TLS for the origin's name, `Host: localhost`, and the original host in `X-Forwarded-Host`.
 */
async function stack(options: { front?: 'serve' | 'vite' } = {}) {
  const scratch = scratchDir('probe');
  const socketDir = shortDir();
  const release = releaseFixture();
  cleanups.push(scratch.cleanup, socketDir.cleanup, release.cleanup);
  const socketPath = path.join(socketDir.dir, 's');
  const repo = new SqliteStateRepo({ file: ':memory:' });
  cleanups.push(() => repo.close());
  const { app } = createApp({
    repo, serviceToken: TOKEN, allowedOrigins: [TEST_ORIGIN], snapshotsEnabled: false,
    ingress: { mode: 'dist', release: release.release, publicOrigin: TEST_ORIGIN, admission: TEST_ADMISSION },
  });
  const safety: SocketSafety = { async beforeListen() {}, async afterListen() {} };
  const mask = process.umask(0o077);
  let servers: Server[];
  try {
    servers = await startIngressServers(app, [
      { mode: 'dist', listener: 'ingress', socketPath, publicOrigin: TEST_ORIGIN, admission: TEST_ADMISSION },
    ], { socketSafety: safety });
  } finally { process.umask(mask); }
  cleanups.push(() => closeServers(servers));
  const tls = certificate(scratch.dir);
  const front = https.createServer(tls, (req, res) => {
    if (options.front === 'vite') { res.statusCode = 200; res.end('<!doctype html>vite'); return; }
    const upstream = http.request({
      socketPath, method: req.method, path: req.url,
      headers: { ...req.headers, host: 'localhost', 'x-forwarded-host': req.headers.host, 'x-forwarded-proto': 'https', 'x-forwarded-for': '100.101.102.103' },
    }, (answer) => { res.writeHead(answer.statusCode ?? 502, answer.headers); answer.pipe(res); });
    upstream.on('error', () => { res.statusCode = 502; res.end(); });
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => { front.closeAllConnections(); front.close(() => resolve()); }));
  const tokenFile = path.join(scratch.dir, 'service-token');
  writePrivate(tokenFile, `${TOKEN}\n`);
  const port = (front.address() as { port: number }).port;
  return { release, tokenFile, transport: { host: '127.0.0.1', port, ca: tls.cert } };
}

describe.skipIf(process.platform !== 'darwin')('holdr-ingress serve-probe (§8.2 step 11)', () => {
  it('passes against the real app behind a Serve-like HTTPS front, printing statuses only', async () => {
    const t = await stack();
    const capture = captureIo();
    const code = await runServeProbe(['--origin', TEST_ORIGIN, '--token-file', t.tokenFile, '--release-dir', t.release.dir], capture.io, t.transport);
    expect(capture.err()).toBe('');
    expect(code).toBe(0);
    expect(capture.out().split('\n').filter(Boolean)).toEqual([
      'serve-probe: ok   GET / = release index.html (status 200)',
      'serve-probe: ok   GET /health = production schema (status 200)',
      'serve-probe: ok   GET /auth/me with the service token = 401 (status 401)',
      'serve-probe: ok   GET / with Host 127.0.0.1:4000 = 421 (status 421)',
      'serve-probe: ok   POST /auth/logout without a session = 204 (status 204)',
      'serve-probe: ok   HEAD /@vite/client = 404 not-found (status 404)',
    ]);
    expect(capture.out()).not.toContain(TOKEN);
  }, 30_000);

  it('fails when something else answers the name (a Vite-like server), and refuses bad arguments', async () => {
    const t = await stack({ front: 'vite' });
    const capture = captureIo();
    expect(await runServeProbe(['--origin', TEST_ORIGIN, '--token-file', t.tokenFile, '--release-dir', t.release.dir], capture.io, t.transport)).toBe(1);
    expect(capture.err()).toContain('E0I_SERVE_PROBE (6 probe(s) failed)');
    expect(capture.out()).not.toContain(TOKEN);
    const usage = captureIo();
    expect(await runServeProbe(['--origin', TEST_ORIGIN], usage.io)).toBe(64);
    const plain = captureIo();
    expect(await runServeProbe(['--origin', 'http://holdr.test', '--token-file', t.tokenFile, '--release-dir', t.release.dir], plain.io)).toBe(1);
    expect(plain.err()).toContain('E0I_PUBLIC_ORIGIN');
  }, 30_000);

  it('verifies the certificate: an untrusted one fails every probe', async () => {
    const t = await stack();
    const capture = captureIo();
    const code = await runServeProbe(['--origin', TEST_ORIGIN, '--token-file', t.tokenFile, '--release-dir', t.release.dir], capture.io,
      { host: t.transport.host, port: t.transport.port });
    expect(code).toBe(1);
    expect(capture.out()).toContain('FAIL GET / = release index.html (status none)');
  }, 30_000);
});
