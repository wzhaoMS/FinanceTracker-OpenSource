import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { hashPassword } from '../auth/password.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { startIngressServers } from './server.js';
import { closeServers, rawRequest, releaseFixture, SERVE_HEADERS, socketFixture, TEST_ORIGIN, TEST_PORT, TEST_WEB_PORT } from './fixtures.js';
import type { IngressRefusal } from './types.js';

const TOKEN = 'ab'.repeat(32);
const PASSWORD = 'synthetic-ingress-password';
let refused: IngressRefusal | null = null;
const admission = { refusal: () => refused };
let release: ReturnType<typeof releaseFixture>;
let socket: ReturnType<typeof socketFixture>;
let servers: Server[];
let repo: SqliteStateRepo;
let built: ReturnType<typeof createApp>;
let cookie: string;
const directHeaders = [['Host', `127.0.0.1:${TEST_PORT}`]] as const;
beforeAll(async () => {
  release = releaseFixture();
  socket = socketFixture();
  repo = new SqliteStateRepo({ file: ':memory:' });
  built = createApp({
    repo, serviceToken: TOKEN, allowedOrigins: [TEST_ORIGIN, 'https://foreign.test'], snapshotsEnabled: false,
    scryptParams: { ln: 10, r: 8, p: 1 }, log: () => undefined,
    ingress: { mode: 'dist', release: release.release, publicOrigin: TEST_ORIGIN, admission },
  });
  built.users.createUser('tester', await hashPassword(PASSWORD, { ln: 10, r: 8, p: 1 }));
  const mask = process.umask(0o077);
  try {
    servers = await startIngressServers(built.app, [
      { mode: 'dist', listener: 'ingress', socketPath: socket.socketPath, publicOrigin: TEST_ORIGIN, admission },
      { mode: 'dist', listener: 'local', port: TEST_PORT, publicOrigin: TEST_ORIGIN, admission },
    ], { socketSafety: socket.safety });
  } finally { process.umask(mask); }
  const login = await rawRequest(socket.socketPath, 'POST', '/auth/login', [
    ...SERVE_HEADERS, ['Origin', TEST_ORIGIN], ['X-Holdr-Request', '1'], ['Content-Type', 'application/json'],
  ], JSON.stringify({ username: 'tester', password: PASSWORD }));
  expect(login.status).toBe(200);
  expect(login.headers['set-cookie']).toMatch(/^__Host-holdr_session=.+; Secure$/);
  cookie = login.headers['set-cookie'].split(';')[0];
});
beforeEach(() => { refused = null; });
afterAll(async () => {
  await closeServers(servers ?? []);
  repo.close();
  socket.cleanup();
  release.cleanup();
});

// The beforeAll above loads a verified release and listens on a Unix-domain socket: macOS and Linux only. On Windows the
// release directory is refused on mode bits (Node reports every directory as 0o666, whatever its NTFS ACL); with every
// test skipped there, vitest skips the beforeAll too.
describe.skipIf(process.platform === 'win32')('profile-bound authentication and Origins', () => {
  it('shares a real app across socket and loopback, never enabling Express trust proxy', async () => {
    expect(built.app.get('trust proxy')).toBe(false);
    const me = await rawRequest(socket.socketPath, 'GET', '/auth/me', [...SERVE_HEADERS, ['Cookie', cookie]]);
    expect(me.status).toBe(200);
    const direct = await rawRequest(TEST_PORT, 'GET', '/auth/me', [...directHeaders, ['Cookie', cookie]]);
    expect(direct.status).toBe(401);
  });
  it('ignores direct cookies completely (no lookup, clearing or renewal)', async () => {
    const lookup = vi.spyOn(built.users, 'findSession').mockImplementation(() => { throw Error('cookie lookup must not run'); });
    try {
      for (const value of [cookie, '__Host-holdr_session=invalid', 'holdr_session=invalid']) {
        const response = await rawRequest(TEST_PORT, 'GET', '/accounts', [...directHeaders, ['Cookie', value]]);
        expect(response.status).toBe(401);
        expect(response.headers['set-cookie']).toBeUndefined();
      }
      expect(lookup).not.toHaveBeenCalled();
    } finally { lookup.mockRestore(); }
  });
  it('accepts the service token only on direct and only within its existing scope', async () => {
    const direct = await rawRequest(TEST_PORT, 'GET', '/accounts', [...directHeaders, ['Authorization', `Bearer ${TOKEN}`]]);
    expect(direct.status).toBe(200);
    expect(direct.headers['strict-transport-security']).toBeUndefined();
    expect(direct.headers['cache-control']).toBe('no-store');
    const socketResult = await rawRequest(socket.socketPath, 'GET', '/accounts', [...SERVE_HEADERS, ['Authorization', `Bearer ${TOKEN}`], ['Cookie', cookie]]);
    expect(socketResult.status).toBe(401);
    expect(JSON.parse(socketResult.body.toString())).toEqual({ error: 'Invalid credentials' });
    const scope = await rawRequest(TEST_PORT, 'POST', '/card-accounts', [...directHeaders, ['Authorization', `Bearer ${TOKEN}`], ['Content-Type', 'application/json']], '{}');
    expect(scope.status).toBe(403);
  });
  it('serves /release/attestation on direct only: the Serve socket never reaches it, whatever the credentials', async () => {
    for (const extra of [[], [['Cookie', cookie]], [['Authorization', `Bearer ${TOKEN}`]]] as [string, string][][]) {
      const response = await rawRequest(socket.socketPath, 'GET', '/release/attestation', [...SERVE_HEADERS, ...extra]);
      expect(response.status).toBe(404);
      expect(response.headers['x-holdr-error']).toBe('not-found');
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    // Direct ignores cookies, so only the token gets past requireAuth; this app was given no attestation (503).
    for (const extra of [[], [['Cookie', cookie]]] as [string, string][][]) {
      expect((await rawRequest(TEST_PORT, 'GET', '/release/attestation', [...directHeaders, ...extra])).status).toBe(401);
    }
    const service = await rawRequest(TEST_PORT, 'GET', '/release/attestation', [...directHeaders, ['Authorization', `Bearer ${TOKEN}`]]);
    expect(service.status).toBe(503);
    expect(service.headers['x-holdr-error']).toBe('attestation-unavailable');
    refused = 'ingress-unverified';
    const closed = await rawRequest(TEST_PORT, 'GET', '/release/attestation', [...directHeaders, ['Authorization', `Bearer ${TOKEN}`]]);
    expect(closed.status).toBe(503);
    expect(closed.headers['x-holdr-error']).toBe('ingress-unverified');
  });
  it.each(['ingress-unverified', 'ingress-refused'] as const)('closes socket/static and valid direct credentials on %s', async (code) => {
    refused = code;
    for (const target of ['/', '/assets/app-123.js', '/health', '/accounts']) {
      const response = await rawRequest(socket.socketPath, 'GET', target, [...SERVE_HEADERS, ['Cookie', cookie]]);
      expect(response.status).toBe(503);
      expect(response.headers['x-holdr-error']).toBe(code);
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    const token = await rawRequest(TEST_PORT, 'GET', '/accounts', [...directHeaders, ['Authorization', `Bearer ${TOKEN}`]]);
    expect(token.status).toBe(503);
    expect(token.headers['x-holdr-error']).toBe(code);
    expect((await rawRequest(TEST_PORT, 'GET', '/health', directHeaders)).status).toBe(200);
  });
  it.each(['/auth/login', '/auth/logout', '/auth/reverify', '/AUTH/LOGIN/'])('refuses browser authentication at %s on direct, regardless of credentials', async (target) => {
    for (const extra of [[], [['Authorization', `Bearer ${TOKEN}`]], [['Cookie', cookie]], [['Authorization', 'Bearer wrong']]] as [string, string][][]) {
      const response = await rawRequest(TEST_PORT, 'POST', target, [...directHeaders, ...extra, ['Origin', TEST_ORIGIN], ['X-Holdr-Request', '1']]);
      expect(response.status).toBe(403);
      expect(response.headers['x-holdr-error']).toBe('auth-not-on-local-listener');
    }
  });
  it('uses an empty Origin set on direct, even for the token', async () => {
    for (const authorization of [undefined, `Bearer ${TOKEN}`]) {
      const extra: [string, string][] = authorization ? [['Authorization', authorization]] : [];
      const response = await rawRequest(TEST_PORT, 'POST', '/accounts', [...directHeaders, ...extra, ['Origin', TEST_ORIGIN], ['X-Holdr-Request', '1']]);
      expect(response.status).toBe(403);
    }
    const noOrigin = await rawRequest(TEST_PORT, 'POST', '/accounts', [...directHeaders, ['Cookie', cookie], ['X-Holdr-Request', '1']]);
    expect(noOrigin.status).toBe(403);
  });
  it('ignores the generic allowlist on Serve and accepts only its configured HTTPS origin', async () => {
    const foreign = await rawRequest(socket.socketPath, 'POST', '/auth/login', [
      ...SERVE_HEADERS, ['Origin', 'https://foreign.test'], ['X-Holdr-Request', '1'],
    ]);
    expect(foreign.status).toBe(403);
  });
  it('preserves HoldrDevice/HoldrPair headers to the credential resolver (no cookie fallback)', async () => {
    for (const scheme of ['HoldrDevice', 'HoldrPair']) {
      const response = await rawRequest(socket.socketPath, 'GET', '/card-sync/capabilities', [
        ...SERVE_HEADERS, ['Authorization', `${scheme} synthetic`], ['Cookie', cookie],
      ]);
      expect(response.status).toBe(401);
      expect(JSON.parse(response.body.toString())).toEqual({ error: 'Invalid credentials' });
    }
  });
  it('returns authenticated API misses as JSON and never static/HTML', async () => {
    for (const target of ['/accounts/x/y/z', '/card-accounts/x/y/z', '/spending/unknown']) {
      const response = await rawRequest(socket.socketPath, 'GET', target, [...SERVE_HEADERS, ['Cookie', cookie]]);
      expect(response.status).toBe(404);
      expect(response.headers['x-holdr-error']).toBe('not-found');
      expect(JSON.parse(response.body.toString())).toEqual({ error: 'not-found' });
    }
    expect((await rawRequest(TEST_PORT, 'GET', '/', directHeaders)).status).toBe(404);
    expect((await rawRequest(TEST_PORT, 'POST', '/assets/app-123.js', directHeaders)).status).toBe(404);
  });
  it('break-glass uses local origins/non-Secure cookies, never the service token or HSTS', async () => {
    const localApp = createApp({
      repo, serviceToken: TOKEN, allowedOrigins: [TEST_ORIGIN], secureCookies: true, snapshotsEnabled: false,
      scryptParams: { ln: 10, r: 8, p: 1 }, log: () => undefined,
      ingress: { mode: 'local', release: release.release, ingressPort: TEST_WEB_PORT, admission },
    }).app;
    const localServers = await startIngressServers(localApp, [{ mode: 'local', listener: 'ingress', port: TEST_WEB_PORT, admission }]);
    const headers = [['Host', `localhost:${TEST_WEB_PORT}`]] as const;
    try {
      const document = await rawRequest(TEST_WEB_PORT, 'GET', '/', headers);
      expect(document.status).toBe(200);
      expect(document.headers['strict-transport-security']).toBeUndefined();
      const token = await rawRequest(TEST_WEB_PORT, 'GET', '/accounts', [...headers, ['Authorization', `Bearer ${TOKEN}`]]);
      expect(token.status).toBe(401);
      const login = await rawRequest(TEST_WEB_PORT, 'POST', '/auth/login', [
        ...headers, ['Origin', `http://localhost:${TEST_WEB_PORT}`], ['X-Holdr-Request', '1'], ['Content-Type', 'application/json'],
      ], JSON.stringify({ username: 'tester', password: PASSWORD }));
      expect(login.status).toBe(200);
      expect(login.headers['set-cookie']).toMatch(/^holdr_session=/);
      expect(login.headers['set-cookie']).not.toContain('Secure');
      const foreign = await rawRequest(TEST_WEB_PORT, 'POST', '/auth/logout', [...headers, ['Origin', TEST_ORIGIN], ['X-Holdr-Request', '1']]);
      expect(foreign.status).toBe(403);
    } finally { await closeServers(localServers); }
  });
});
