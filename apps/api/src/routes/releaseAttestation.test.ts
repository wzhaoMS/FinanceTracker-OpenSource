import path from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import type { HoldrAuth } from '../auth/http.js';
import { hashPassword } from '../auth/password.js';
import { computeReleaseAttestation, type ReleaseAttestation } from '../release/apiAttestation.js';
import { syntheticAttestationInput, syntheticTree } from '../release/attestation.testSupport.js';
import { parseApiAttestation, type ApiReleaseAttestation } from '../release/codeIdentity.mjs';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { listenLoopback } from '../testing/loopback.js';
import { createReleaseAttestationRouter } from './releaseAttestation.js';

const FAST = { ln: 10, r: 8, p: 1 };
const ORIGIN = 'http://127.0.0.1:5173';
const TOKEN = '7a'.repeat(32);
const PASSWORD = 'correct horse battery';
const PATH = '/release/attestation';
const BEARER = { Authorization: `Bearer ${TOKEN}` };
/** What the web proxy, Tailscale Serve or any other relay adds (auth/http.ts isProxiedRequest). */
const FORWARDING = ['X-Forwarded-For', 'X-Forwarded-Host', 'X-Forwarded-Proto', 'X-Forwarded-Port', 'Forwarded', 'X-Real-IP',
  'Via', 'Tailscale-User-Login'];
const OTHER_METHODS = ['HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'];
type Verb = 'get' | 'head' | 'options' | 'post' | 'put' | 'patch' | 'delete';

let repo: SqliteStateRepo | null = null;
afterEach(() => {
  repo?.close();
  repo = null;
});

async function build(options: { attestation?: ReleaseAttestation; users?: string[] } = {}): Promise<Express> {
  repo = new SqliteStateRepo({ file: ':memory:' });
  const { app, users } = createApp({
    repo, serviceToken: TOKEN, allowedOrigins: [ORIGIN], snapshotsEnabled: false, scryptParams: FAST,
    log: () => undefined, releaseAttestation: options.attestation,
  });
  for (const username of options.users ?? ['alex']) users.createUser(username, await hashPassword(PASSWORD, FAST));
  return app;
}

/** An attestation computed the way index.ts computes one, over a synthetic tree. */
async function readyAttestation() {
  const tree = await syntheticTree();
  const state = computeReleaseAttestation(() => syntheticAttestationInput(tree));
  if (state.status !== 'ready') throw new Error(`unavailable: ${state.code}`);
  return state;
}

async function signIn(app: Express): Promise<string> {
  const res = await request(await listenLoopback(app)).post('/auth/login')
    .set('Origin', ORIGIN).set('X-Holdr-Request', '1').send({ username: 'alex', password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).find((value) => value.startsWith('holdr_session='))!.split(';')[0];
}

/** What a caller sees: status, body and every header but the date. */
function seen(res: request.Response) {
  const { date: _date, ...headers } = res.headers;
  return { status: res.status, body: res.text, headers };
}

function stringLeaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(stringLeaves);
  return [];
}

describe('GET /release/attestation', () => {
  it('answers 401 without credentials, as every protected path does, known or not', async () => {
    const app = await build({ attestation: await readyAttestation() });
    for (const target of [PATH, '/release/unknown', '/accounts']) {
      const res = await request(await listenLoopback(app)).get(target);
      // Status and body together: the app's error handler answers a thrown 4xx error with that status's own text, never this.
      expect([res.status, res.body], target).toEqual([401, { error: 'Sign in required' }]);
    }
  });

  it('answers 503 setup-required before the first user exists, while the service token still gets the attestation', async () => {
    const attestation = await readyAttestation();
    const app = await build({ attestation, users: [] });
    const anonymous = await request(await listenLoopback(app)).get(PATH);
    expect(anonymous.status).toBe(503);
    expect(anonymous.body).toMatchObject({ setupRequired: true });
    const service = await request(await listenLoopback(app)).get(PATH).set(BEARER);
    expect([service.status, service.text]).toEqual([200, attestation.body]);
  });

  it('serves the service token on direct loopback the exact bytes computed at startup, the same on every request', async () => {
    const attestation = await readyAttestation();
    const app = await build({ attestation });
    const first = await request(await listenLoopback(app)).get(PATH).set(BEARER);
    expect(first.status).toBe(200);
    expect(first.text).toBe(attestation.body);
    expect(first.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(first.headers['content-length']).toBe(String(Buffer.byteLength(attestation.body)));
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.headers.etag).toBeUndefined();
    // The gate's own parser takes it as it is.
    expect(parseApiAttestation(JSON.parse(first.text))).toEqual(attestation.attestation);
    // pid and startedAt never change for the process's life: every answer is the same bytes, never a 304.
    for (const extra of [{}, { 'If-None-Match': '*' }, { 'If-Modified-Since': 'Wed, 31 Dec 2099 00:00:00 GMT' }]) {
      const again = await request(await listenLoopback(app)).get(PATH).set(BEARER).set(extra);
      expect([again.status, again.text]).toEqual([200, attestation.body]);
    }
  });

  it('refuses a signed-in session exactly as a path no route serves, for every method, and never with 401', async () => {
    const app = await build({ attestation: await readyAttestation() });
    const cookie = await signIn(app);
    for (const method of ['GET', ...OTHER_METHODS]) {
      const send = async (target: string) => seen(await request(await listenLoopback(app))[method.toLowerCase() as Verb](target)
        .set('Cookie', cookie).set('Origin', ORIGIN).set('X-Holdr-Request', '1'));
      const attested = await send(PATH);
      expect([attested.status, attested.body ?? ''], method).toEqual([404, method === 'HEAD' ? '' : '{"error":"not-found"}']);
      expect(attested, method).toEqual(await send('/release/unknown'));
    }
    const get = await request(await listenLoopback(app)).get(PATH).set('Cookie', cookie);
    expect(get.body).toEqual({ error: 'not-found' });
    expect(get.headers['x-holdr-error']).toBe('not-found');
  });

  it('never serves a forwarded, proxied or non-loopback request: the ingress answers 404 before authentication', async () => {
    const app = await build({ attestation: await readyAttestation() });
    // identify would refuse this token with 401, and clear this unknown session cookie, if either reached it.
    const stale = `holdr_session=${'ab'.repeat(32)}`;
    const variants: Array<Record<string, string>> = [
      ...FORWARDING.map((name) => ({ [name]: name === 'Forwarded' ? 'for=192.168.24.20' : '192.168.24.20' })),
      { Host: 'holdr.example.ts.net' }, { Host: 'homeserver.local:4000' }, { Host: '192.168.24.20:4000' },
    ];
    for (const headers of variants) {
      for (const credentials of [BEARER, { Cookie: stale }]) {
        const res = await request(await listenLoopback(app)).get(PATH).set(credentials).set(headers);
        const label = `${JSON.stringify(headers)} ${Object.keys(credentials)[0]}`;
        expect(res.status, label).toBe(404);
        expect(res.body, label).toEqual({ error: 'not-found' });
        expect(res.headers['x-holdr-error'], label).toBe('not-found');
        expect(res.headers['set-cookie'], label).toBeUndefined();
      }
    }
    // Without them, the same cookie reaches identify, which clears it, and requireAuth answers.
    const direct = await request(await listenLoopback(app)).get(PATH).set('Cookie', stale);
    expect(direct.status).toBe(401);
    expect(direct.headers['set-cookie']).toBeDefined();
  });

  it('answers every method but GET with 404, also for the service token, and names no allowed method', async () => {
    const app = await build({ attestation: await readyAttestation() });
    for (const method of OTHER_METHODS) {
      const res = await request(await listenLoopback(app))[method.toLowerCase() as Verb](PATH).set(BEARER);
      expect(res.status, method).toBe(404);
      expect(res.headers['x-holdr-error'], method).toBe('not-found');
      expect(res.headers.allow, method).toBeUndefined();
      expect(res.text ?? '', method).toBe(method === 'HEAD' ? '' : '{"error":"not-found"}');
    }
  });

  it('refuses device credentials, like any bearer but the service token', async () => {
    const app = await build({ attestation: await readyAttestation() });
    for (const scheme of ['HoldrDevice', 'HoldrPair']) {
      const res = await request(await listenLoopback(app)).get(PATH).set('Authorization', `${scheme} synthetic`);
      expect(res.status, scheme).toBe(401);
      expect(res.body, scheme).toEqual({ error: 'Invalid credentials' });
    }
  });

  it('answers 503 attestation-unavailable when none was computed, while every other route keeps working', async () => {
    const failed = computeReleaseAttestation(() => { throw new Error('synthetic failure'); });
    for (const attestation of [undefined, failed]) {
      const app = await build({ attestation });
      const res = await request(await listenLoopback(app)).get(PATH).set(BEARER);
      expect([res.status, res.text]).toEqual([503, '{"error":"attestation-unavailable"}']);
      expect(res.headers['x-holdr-error']).toBe('attestation-unavailable');
      expect((await request(await listenLoopback(app)).get('/health')).status).toBe(200);
      expect((await request(await listenLoopback(app)).get('/auth/me').set(BEARER)).body).toEqual({ service: true });
      expect((await request(await listenLoopback(app)).get('/accounts').set(BEARER)).status).toBe(200);
      repo?.close();
      repo = null;
    }
  });

  it('is value-free: no token anywhere, and no path but the identity fields', async () => {
    const attestation = await readyAttestation();
    const app = await build({ attestation });
    const res = await request(await listenLoopback(app)).get(PATH).set(BEARER);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(TOKEN);
    expect(JSON.stringify(res.headers)).not.toContain(TOKEN);
    const body = JSON.parse(res.text) as ApiReleaseAttestation;
    const identityPaths = new Set([body.runtime.execPath, body.entry, ...body.preloads]);
    const paths = stringLeaves(body).filter((value) => path.isAbsolute(value));
    expect(paths.length).toBe(identityPaths.size);
    for (const value of paths) expect(identityPaths.has(value), value).toBe(true);
  });
});

describe('the attestation router on its own', () => {
  async function bare(principal: HoldrAuth | undefined, attestation?: ReleaseAttestation): Promise<Express> {
    const app = express();
    app.use((req, _res, next) => {
      req.holdrAuth = principal;
      next();
    });
    app.use(createReleaseAttestationRouter(attestation));
    app.use((_req, res) => { res.status(418).end(); });
    return app;
  }

  it('checks the service principal and the direct loopback connection itself, whatever identified the caller', async () => {
    const attestation = await readyAttestation();
    const service = await bare({ kind: 'service' }, attestation);
    expect((await request(await listenLoopback(service)).get(PATH)).text).toBe(attestation.body);
    for (const name of FORWARDING) {
      const res = await request(await listenLoopback(service)).get(PATH).set(name, '192.168.24.20');
      expect(res.status, name).toBe(404);
    }
    expect((await request(await listenLoopback(service)).get(PATH).set('Host', 'holdr.example.ts.net')).status).toBe(404);
    const session = await bare({ kind: 'session', userId: 'u1', username: 'alex', sessionId: 's1' }, attestation);
    expect((await request(await listenLoopback(session)).get(PATH)).status).toBe(404);
    expect((await request(await listenLoopback(await bare(undefined, attestation))).get(PATH)).status).toBe(404);
  });

  it('answers 503 without an attestation, and leaves every other path to the routes after it', async () => {
    const service = await bare({ kind: 'service' });
    expect((await request(await listenLoopback(service)).get(PATH)).status).toBe(503);
    for (const target of ['/release', '/release/other', `${PATH}/more`, '/accounts']) {
      expect((await request(await listenLoopback(service)).get(target)).status, target).toBe(418);
    }
  });
});
