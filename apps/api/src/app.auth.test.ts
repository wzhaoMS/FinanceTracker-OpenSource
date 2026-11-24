import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express, Request } from 'express';

import { createApp } from './app.js';
import { hashPassword } from './auth/password.js';
import { LoginThrottle } from './auth/loginThrottle.js';
import {
  clientAddress,
  isDirectLoopback,
  isLoopbackHost,
  parseAllowedOrigins,
  parsePublicOrigin,
} from './auth/http.js';
import { hashToken } from './services/authRepo.js';
import type { LocalAuthRepo } from './services/localAuthRepo.js';
import { SqliteStateRepo } from './services/sqliteStateRepo.js';
import { listenLoopback } from './testing/loopback.js';

const FAST = { ln: 10, r: 8, p: 1 };
const ORIGIN = 'http://homeserver.local:8888';
const HTTPS_ORIGIN = 'https://holdr.example.ts.net';
const TOKEN = '5e'.repeat(32);
const PASSWORD = 'correct horse battery';
const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-10-16T12:00:00.000Z');

let clock = T0;
let repo: SqliteStateRepo | null = null;

afterEach(() => {
  repo?.close();
  repo = null;
  clock = T0;
});

interface Built {
  app: Express;
  users: LocalAuthRepo;
  logs: string[];
}

async function build(options: {
  users?: string[];
  throttle?: LoginThrottle;
  secureCookies?: boolean;
  origins?: string[];
  /** Reopen the same database (no new users) instead of starting empty. */
  reuseRepo?: boolean;
} = {}): Promise<Built> {
  const reuse = options.reuseRepo && repo !== null;
  if (!reuse) repo = new SqliteStateRepo({ file: ':memory:' });
  const logs: string[] = [];
  const { app, users } = createApp({
    repo: repo!,
    serviceToken: TOKEN,
    allowedOrigins: options.origins ?? [ORIGIN],
    secureCookies: options.secureCookies,
    snapshotsEnabled: false,
    now: () => clock,
    scryptParams: FAST,
    throttle: options.throttle,
    log: (message) => logs.push(message),
  });
  for (const username of reuse ? [] : options.users ?? ['alex']) {
    users.createUser(username, await hashPassword(PASSWORD, FAST), T0);
  }
  return { app, users, logs };
}

/** Headers a same-origin browser request through the web proxy carries. */
function fromBrowser<T extends request.Test>(test: T): T {
  return test.set('Origin', ORIGIN).set('X-Holdr-Request', '1');
}

function sessionSetCookie(res: request.Response): string | undefined {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  return header?.find((cookie) => cookie.startsWith('holdr_session='));
}

function cookiePair(setCookie: string | undefined): string {
  if (!setCookie) throw new Error('no session cookie');
  return setCookie.split(';')[0];
}

async function signIn(app: Express, username = 'alex', password = PASSWORD) {
  const res = await fromBrowser(request(await listenLoopback(app)).post('/auth/login')).send({ username, password });
  return { res, cookie: res.status === 200 ? cookiePair(sessionSetCookie(res)) : '' };
}

function account(id: string) {
  return { id, name: `Account ${id}`, cashBalance: 0, currency: 'USD' };
}

describe('sign-in', () => {
  it('logs a failed sign-in by the user\'s own name, never by what was typed', async () => {
    const { app, logs } = await build();
    expect((await signIn(app, 'ALEX', 'wrong password')).res.status).toBe(401);
    // A password typed into the name box: refused like any unknown name, and kept out of the log.
    expect((await signIn(app, 'Correct-Horse-7', PASSWORD)).res.status).toBe(401);
    expect(logs.filter((line) => line.includes('failed sign-in'))).toEqual([
      '[auth] failed sign-in for "alex" from 127.0.0.1',
      '[auth] failed sign-in for an unknown user name from 127.0.0.1',
    ]);
    expect(logs.join('\n')).not.toMatch(/horse/i);
  });

  it('issues an HttpOnly SameSite=Strict session cookie for 30 days and stores only its hash', async () => {
    const { app, logs } = await build();
    const { res, cookie } = await signIn(app);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: { username: 'alex' } });
    const setCookie = sessionSetCookie(res)!;
    expect(setCookie).toMatch(/^holdr_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000$/);
    const token = cookie.split('=')[1];
    const stored = repo!.internalGetDb().prepare('SELECT id, expires_at FROM local_sessions').all();
    expect(stored).toEqual([{ id: hashToken(token), expires_at: new Date(T0.getTime() + 30 * DAY).toISOString() }]);
    expect(logs.join('\n')).not.toContain(PASSWORD);
    expect(logs.join('\n')).not.toContain(token);
  });

  it('never lets request headers turn on Secure: that is configuration (HOLDR_PUBLIC_ORIGIN)', async () => {
    const { app } = await build();
    const res = await fromBrowser(request(await listenLoopback(app)).post('/auth/login'))
      .set('X-Forwarded-For', '192.168.24.20')
      .set('X-Forwarded-Proto', 'https')
      .set('Forwarded', 'proto=https')
      .send({ username: 'alex', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(sessionSetCookie(res)).not.toMatch(/Secure/);
  });

  it('matches usernames case-insensitively', async () => {
    const { app } = await build();
    expect((await signIn(app, '  ALEX ')).res.status).toBe(200);
  });

  it('gives the same generic answer for a wrong password and an unknown user', async () => {
    const { app, logs } = await build();
    const wrong = await signIn(app, 'alex', 'not the password');
    const unknown = await signIn(app, 'mallory', PASSWORD);
    for (const res of [wrong.res, unknown.res]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Invalid username or password' });
      expect(sessionSetCookie(res)).toBeUndefined();
    }
    expect(logs.join('\n')).not.toContain('not the password');
  });

  it('rejects malformed bodies with JSON errors', async () => {
    const { app } = await build();
    for (const body of [{}, { username: 'alex' }, { username: 'alex', password: 42 }, { username: '', password: 'x' }]) {
      const res = await fromBrowser(request(await listenLoopback(app)).post('/auth/login')).send(body);
      expect(res.status).toBe(400);
    }
    const broken = await fromBrowser(request(await listenLoopback(app)).post('/auth/login'))
      .set('Content-Type', 'application/json')
      .send('{"username": ');
    expect(broken.status).toBe(400);
    expect(broken.headers['content-type']).toMatch(/json/);
    expect(JSON.stringify(broken.body)).not.toMatch(/at .*\.js/);
  });

  it('ends any session the login request presented (no fixation)', async () => {
    const { app } = await build();
    const first = await signIn(app);
    const second = await fromBrowser(request(await listenLoopback(app)).post('/auth/login'))
      .set('Cookie', first.cookie)
      .send({ username: 'alex', password: PASSWORD });
    expect(second.status).toBe(200);
    expect(cookiePair(sessionSetCookie(second))).not.toBe(first.cookie);
    expect((await request(await listenLoopback(app)).get('/auth/me').set('Cookie', first.cookie)).status).toBe(401);
  });

  it('upgrades a weaker stored hash after a successful sign-in', async () => {
    repo = new SqliteStateRepo({ file: ':memory:' });
    const { app, users } = createApp({
      repo,
      serviceToken: TOKEN,
      allowedOrigins: [ORIGIN],
      snapshotsEnabled: false,
      now: () => clock,
      scryptParams: { ln: 11, r: 8, p: 1 },
      log: () => undefined,
    });
    users.createUser('alex', await hashPassword(PASSWORD, FAST), T0);
    expect((await signIn(app)).res.status).toBe(200);
    expect(users.findUser('alex')!.passwordHash.startsWith('$scrypt$ln=11,r=8,p=1$')).toBe(true);
    expect((await signIn(app)).res.status).toBe(200);
  });
});

describe('sessions', () => {
  it('GET /auth/me answers 401 when signed out and the username when signed in', async () => {
    const { app } = await build();
    expect((await request(await listenLoopback(app)).get('/auth/me')).status).toBe(401);
    const { cookie } = await signIn(app);
    const me = await request(await listenLoopback(app)).get('/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ user: { username: 'alex' } });
  });

  it('logout deletes the session and clears the cookie', async () => {
    const { app } = await build();
    const { cookie } = await signIn(app);
    const out = await fromBrowser(request(await listenLoopback(app)).post('/auth/logout')).set('Cookie', cookie);
    expect(out.status).toBe(204);
    expect(sessionSetCookie(out)).toMatch(/^holdr_session=; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0$/);
    expect(repo!.internalGetDb().prepare('SELECT COUNT(*) AS n FROM local_sessions').get()).toEqual({ n: 0 });
    expect((await request(await listenLoopback(app)).get('/accounts').set('Cookie', cookie)).status).toBe(401);
    expect((await fromBrowser(request(await listenLoopback(app)).post('/auth/logout'))).status).toBe(204);
  });

  it('expires after 30 days without use and clears the stale cookie', async () => {
    const { app } = await build();
    const { cookie } = await signIn(app);
    clock = new Date(T0.getTime() + 30 * DAY - 1000);
    expect((await request(await listenLoopback(app)).get('/accounts').set('Cookie', cookie)).status).toBe(200);
    clock = new Date(T0.getTime() + 61 * DAY);
    const expired = await request(await listenLoopback(app)).get('/accounts').set('Cookie', cookie);
    expect(expired.status).toBe(401);
    expect(sessionSetCookie(expired)).toMatch(/Max-Age=0/);
    expect(repo!.internalGetDb().prepare('SELECT COUNT(*) AS n FROM local_sessions').get()).toEqual({ n: 0 });
  });

  it('slides the 30-day expiry forward on use, at most once an hour', async () => {
    const { app } = await build();
    const { cookie } = await signIn(app);
    clock = new Date(T0.getTime() + 30 * 60_000);
    expect(sessionSetCookie(await request(await listenLoopback(app)).get('/auth/me').set('Cookie', cookie))).toBeUndefined();
    clock = new Date(T0.getTime() + 29 * DAY);
    const renewed = await request(await listenLoopback(app)).get('/auth/me').set('Cookie', cookie);
    expect(renewed.status).toBe(200);
    expect(sessionSetCookie(renewed)).toBe(`${cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`);
    clock = new Date(T0.getTime() + 58 * DAY);
    expect((await request(await listenLoopback(app)).get('/auth/me').set('Cookie', cookie)).status).toBe(200);
  });

  it('a password reset or user removal on the server ends existing sessions', async () => {
    const { app, users } = await build({ users: ['alex', 'casey'] });
    const alex = await signIn(app, 'alex');
    const casey = await signIn(app, 'casey');
    users.setPasswordHash('alex', await hashPassword('a brand new password', FAST), { revokeSessions: true });
    expect((await request(await listenLoopback(app)).get('/auth/me').set('Cookie', alex.cookie)).status).toBe(401);
    users.removeUser('casey');
    expect((await request(await listenLoopback(app)).get('/auth/me').set('Cookie', casey.cookie)).status).toBe(401);
  });

  it('ignores forged and malformed cookies', async () => {
    const { app } = await build();
    for (const cookie of ['holdr_session=' + '0'.repeat(64), 'holdr_session=', 'holdr_session', 'other=1']) {
      expect((await request(await listenLoopback(app)).get('/accounts').set('Cookie', cookie)).status, cookie).toBe(401);
    }
  });
});

/** What Tailscale Serve adds when it proxies https://<machine>.<tailnet>.ts.net to the loopback web port. */
const SERVE_HEADERS = {
  'X-Forwarded-For': '100.101.1.2',
  'X-Forwarded-Proto': 'https',
  'X-Forwarded-Host': 'holdr.example.ts.net',
  'Tailscale-User-Login': 'alex@example.com',
  'Tailscale-User-Name': 'Alex',
  'Tailscale-Headers-Info': 'https://tailscale.com/s/serve-headers',
};

function secureSetCookie(res: request.Response): string | undefined {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  return header?.find((cookie) => cookie.startsWith('__Host-holdr_session='));
}

describe('HTTPS mode (HOLDR_PUBLIC_ORIGIN is https)', () => {
  const buildHttps = () => build({ secureCookies: true, origins: [HTTPS_ORIGIN, 'http://127.0.0.1:8888'] });
  const fromHttpsPage = <T extends request.Test>(test: T): T =>
    test.set(SERVE_HEADERS).set('Origin', HTTPS_ORIGIN).set('X-Holdr-Request', '1');
  const signInHttps = async (app: Express, password = PASSWORD) => {
    const res = await fromHttpsPage(request(await listenLoopback(app)).post('/auth/login')).send({ username: 'alex', password });
    return { res, cookie: res.status === 200 ? cookiePair(secureSetCookie(res)) : '' };
  };

  it('issues a __Host- cookie (Secure, Path=/, no Domain) and reads only that name', async () => {
    const { app } = await buildHttps();
    const { res, cookie } = await signInHttps(app);
    expect(res.status).toBe(200);
    expect(sessionSetCookie(res)).toBeUndefined();
    expect(secureSetCookie(res)).toMatch(
      /^__Host-holdr_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure$/,
    );
    expect(secureSetCookie(res)).not.toMatch(/domain/i);
    expect((await request(await listenLoopback(app)).get('/auth/me').set(SERVE_HEADERS).set('Cookie', cookie)).body)
      .toEqual({ user: { username: 'alex' } });
    const plainName = cookie.replace('__Host-holdr_session=', 'holdr_session=');
    expect((await request(await listenLoopback(app)).get('/auth/me').set('Cookie', plainName)).status).toBe(401);

    clock = new Date(T0.getTime() + 2 * DAY);
    const renewed = await request(await listenLoopback(app)).get('/auth/me').set('Cookie', cookie);
    expect(secureSetCookie(renewed)).toBe(`${cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure`);
    const out = await fromHttpsPage(request(await listenLoopback(app)).post('/auth/logout')).set('Cookie', cookie);
    expect(out.status).toBe(204);
    expect(secureSetCookie(out)).toBe('__Host-holdr_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure');
    expect((await request(await listenLoopback(app)).get('/auth/me').set('Cookie', cookie)).status).toBe(401);
  });

  it('does not honour a session that was issued over plain HTTP', async () => {
    const plain = await build();
    const { cookie } = await signIn(plain.app);
    const token = cookie.split('=')[1];
    const { app } = await build({ secureCookies: true, origins: [HTTPS_ORIGIN], reuseRepo: true });
    const res = await request(await listenLoopback(app)).get('/accounts').set(SERVE_HEADERS).set('Cookie', `__Host-holdr_session=${token}`);
    expect(res.status).toBe(401);
    expect(secureSetCookie(res)).toMatch(/; Max-Age=0; Secure$/);
    expect(repo!.internalGetDb().prepare('SELECT COUNT(*) AS n FROM local_sessions').get()).toEqual({ n: 0 });
  });

  it('accepts mutations only from the exact https origin', async () => {
    const { app } = await buildHttps();
    const { cookie } = await signInHttps(app);
    for (const origin of [
      'http://holdr.example.ts.net',
      'https://holdr.example.ts.net:8443',
      'http://holdr.example.ts.net:8888',
      'https://other.example.ts.net',
      'https://holdr.example.ts.net.evil.example',
    ]) {
      const res = await request(await listenLoopback(app)).post('/accounts').set(SERVE_HEADERS).set('Cookie', cookie)
        .set('Origin', origin).set('X-Holdr-Request', '1').send(account('x'));
      expect(res.status, origin).toBe(403);
    }
    expect((await fromHttpsPage(request(await listenLoopback(app)).post('/accounts')).set('Cookie', cookie).send(account('ok'))).status).toBe(201);
  });

  it('treats requests relayed by Tailscale Serve as remote, never as trusted local callers', async () => {
    const { app } = await buildHttps();
    const bearer = `Bearer ${TOKEN}`;
    // Serve keeps the browser's Host even if a forwarding header went missing.
    for (const headers of [SERVE_HEADERS, { 'Tailscale-User-Login': 'alex@example.com' }, { Host: 'holdr.example.ts.net' }]) {
      const res = await request(await listenLoopback(app)).get('/accounts').set(headers).set('Authorization', bearer);
      expect(res.status, JSON.stringify(headers)).toBe(401);
    }
    // Throttling keys on the tailnet address Serve reported, not on loopback.
    const from = async (ip: string, username: string, password = 'wrong password') =>
      fromHttpsPage(request(await listenLoopback(app)).post('/auth/login')).set('X-Forwarded-For', ip).send({ username, password });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await from('100.101.1.2', `guess${attempt}`)).status).toBe(401);
    }
    expect((await from('100.101.1.2', 'alex', PASSWORD)).status).toBe(429);
    expect((await from('100.101.1.3', 'alex', PASSWORD)).status).toBe(200);
  });
});

describe('Tailscale Funnel', () => {
  it('refuses every request tailscaled marks as coming from the public internet', async () => {
    const { app } = await build();
    const { cookie } = await signIn(app);
    for (const path of ['/health', '/auth/me', '/accounts']) {
      const res = await request(await listenLoopback(app)).get(path).set('Cookie', cookie).set('Tailscale-Funnel-Request', '?1');
      expect(res.status, path).toBe(403);
    }
    const login = await fromBrowser(request(await listenLoopback(app)).post('/auth/login')).set('Tailscale-Funnel-Request', '?1')
      .send({ username: 'alex', password: PASSWORD });
    expect(login.status).toBe(403);
    expect(sessionSetCookie(login)).toBeUndefined();
  });
});

describe('login throttling', () => {
  it('backs off per username after repeated failures and answers 429 with Retry-After', async () => {
    const { app } = await build();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await signIn(app, 'alex', `wrong ${attempt}`)).res.status).toBe(401);
    }
    const locked = await signIn(app, 'alex', PASSWORD);
    expect(locked.res.status).toBe(429);
    expect(locked.res.headers['retry-after']).toBe('1');
    expect(locked.res.body).toMatchObject({ retryAfterSeconds: 1 });

    clock = new Date(T0.getTime() + 1000);
    expect((await signIn(app, 'alex', 'wrong again')).res.status).toBe(401);
    const longer = await signIn(app, 'alex', PASSWORD);
    expect(longer.res.status).toBe(429);
    expect(longer.res.headers['retry-after']).toBe('2');

    clock = new Date(T0.getTime() + 3000);
    expect((await signIn(app, 'alex', PASSWORD)).res.status).toBe(200);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await signIn(app, 'alex', `wrong ${attempt}`)).res.status).toBe(401);
    }
  });

  it('locks a username across client addresses but not other users', async () => {
    const { app } = await build({ users: ['alex', 'casey'] });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await fromBrowser(request(await listenLoopback(app)).post('/auth/login'))
        .set('X-Forwarded-For', `192.168.24.${10 + attempt}`)
        .send({ username: 'alex', password: 'wrong password' });
      expect(res.status).toBe(401);
    }
    expect((await signIn(app, 'alex')).res.status).toBe(429);
    expect((await signIn(app, 'casey')).res.status).toBe(200);
  });

  it('locks a client address that tries many usernames', async () => {
    const { app } = await build({ users: ['alex'] });
    const from = async (ip: string, username: string, password = 'wrong password') =>
      fromBrowser(request(await listenLoopback(app)).post('/auth/login')).set('X-Forwarded-For', ip).send({ username, password });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await from('100.101.1.2', `guess${attempt}`)).status).toBe(401);
    }
    expect((await from('100.101.1.2', 'alex', PASSWORD)).status).toBe(429);
    expect((await from('100.101.1.3', 'alex', PASSWORD)).status).toBe(200);
  });

  it('uses only the hop appended by the local proxy, so a spoofed X-Forwarded-For does not help', async () => {
    const { app } = await build();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const res = await fromBrowser(request(await listenLoopback(app)).post('/auth/login'))
        .set('X-Forwarded-For', `6.6.6.${attempt}, 192.168.24.50`)
        .send({ username: `guess${attempt}`, password: 'wrong password' });
      expect(res.status).toBe(401);
    }
    const res = await fromBrowser(request(await listenLoopback(app)).post('/auth/login'))
      .set('X-Forwarded-For', '1.2.3.4, 192.168.24.50')
      .send({ username: 'alex', password: PASSWORD });
    expect(res.status).toBe(429);
  });
});

describe('CSRF and Origin checks', () => {
  it('rejects state-changing requests with a missing, foreign or null Origin', async () => {
    const { app } = await build();
    const { cookie } = await signIn(app);
    const cases: Array<[string, Record<string, string>]> = [
      ['missing origin', { 'X-Holdr-Request': '1' }],
      ['foreign origin', { Origin: 'http://evil.example', 'X-Holdr-Request': '1' }],
      ['null origin', { Origin: 'null', 'X-Holdr-Request': '1' }],
      ['other port', { Origin: 'http://homeserver.local:4000', 'X-Holdr-Request': '1' }],
      ['missing header', { Origin: ORIGIN }],
      ['wrong header value', { Origin: ORIGIN, 'X-Holdr-Request': 'true' }],
    ];
    for (const [label, headers] of cases) {
      const res = await request(await listenLoopback(app)).post('/accounts').set('Cookie', cookie).set(headers).send(account(label.replace(/ /g, '-')));
      expect(res.status, label).toBe(403);
    }
    expect((await request(await listenLoopback(app)).get('/accounts').set('Cookie', cookie)).body.accounts).toEqual([]);
    const ok = await fromBrowser(request(await listenLoopback(app)).post('/accounts')).set('Cookie', cookie).send(account('ok'));
    expect(ok.status).toBe(201);
  });

  it('applies the same checks to login and logout', async () => {
    const { app } = await build();
    expect((await request(await listenLoopback(app)).post('/auth/login').send({ username: 'alex', password: PASSWORD })).status).toBe(403);
    expect((await request(await listenLoopback(app)).post('/auth/login').set('Origin', 'http://evil.example').set('X-Holdr-Request', '1')
      .send({ username: 'alex', password: PASSWORD })).status).toBe(403);
    expect((await request(await listenLoopback(app)).post('/auth/login').set('Origin', ORIGIN)
      .send({ username: 'alex', password: PASSWORD })).status).toBe(403);
    const { cookie } = await signIn(app);
    expect((await request(await listenLoopback(app)).post('/auth/logout').set('Cookie', cookie).set('Origin', 'http://evil.example')
      .set('X-Holdr-Request', '1')).status).toBe(403);
    expect((await request(await listenLoopback(app)).get('/auth/me').set('Cookie', cookie)).status).toBe(200);
  });

  it('never sends CORS headers, so other origins cannot read responses', async () => {
    const { app } = await build();
    const { cookie } = await signIn(app);
    const res = await request(await listenLoopback(app)).get('/accounts').set('Cookie', cookie).set('Origin', 'http://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('service token', () => {
  it('authenticates direct local callers with Authorization: Bearer, within its scope (auth/serviceScope.ts)', async () => {
    const { app } = await build();
    const bearer = `Bearer ${TOKEN}`;
    expect((await request(await listenLoopback(app)).get('/accounts').set('Authorization', bearer)).status).toBe(200);
    expect((await request(await listenLoopback(app)).get('/auth/me').set('Authorization', bearer)).body).toEqual({ service: true });
    const created = await request(await listenLoopback(app)).post('/accounts').set('Authorization', bearer).send(account('script'));
    expect([created.status, created.body.code]).toEqual([403, 'principal-not-allowed']);
    const health = await request(await listenLoopback(app)).get('/health').set('Authorization', bearer);
    expect(health.body).toMatchObject({ ok: true, accounts: 0 });
  });

  it('is refused when the request came through a proxy', async () => {
    const { app } = await build();
    for (const header of ['X-Forwarded-For', 'X-Forwarded-Host', 'X-Forwarded-Proto', 'X-Forwarded-Port', 'Forwarded', 'X-Real-IP', 'Via', 'Tailscale-User-Login']) {
      const res = await request(await listenLoopback(app)).get('/accounts').set('Authorization', `Bearer ${TOKEN}`).set(header, '192.168.24.20');
      expect(res.status, header).toBe(401);
    }
  });

  it('rejects wrong or malformed credentials without falling back to the cookie', async () => {
    const { app } = await build();
    const { cookie } = await signIn(app);
    for (const authorization of [`Bearer ${'0'.repeat(64)}`, 'Bearer', `Basic ${TOKEN}`, `Bearer ${TOKEN} extra`, TOKEN]) {
      const res = await request(await listenLoopback(app)).get('/accounts').set('Cookie', cookie).set('Authorization', authorization);
      expect(res.status, authorization).toBe(401);
    }
    expect((await request(await listenLoopback(app)).get(`/accounts?token=${TOKEN}`)).status).toBe(401);
    expect((await request(await listenLoopback(app)).get('/accounts').set('Cookie', `holdr_session=${TOKEN}`)).status).toBe(401);
  });

  it('still rejects a foreign Origin on mutations', async () => {
    const { app } = await build();
    const res = await request(await listenLoopback(app)).post('/card-imports/preview?cardAccountId=card-acct-x').set('Authorization', `Bearer ${TOKEN}`)
      .set('Origin', 'http://evil.example').set('Content-Type', 'application/json').send('{}');
    expect([res.status, res.body]).toEqual([403, { error: 'Cross-origin request rejected' }]);
  });
});

describe('before the first user exists', () => {
  it('protected routes answer 503 with the CLI command, while health and the service token keep working', async () => {
    const { app } = await build({ users: [] });
    const data = await request(await listenLoopback(app)).get('/accounts');
    expect(data.status).toBe(503);
    expect(data.body).toMatchObject({ setupRequired: true });
    expect(data.body.message).toContain('npm run holdr-user -- add <username>');
    const mutation = await fromBrowser(request(await listenLoopback(app)).post('/accounts')).send(account('x'));
    expect(mutation.status).toBe(503);
    const me = await request(await listenLoopback(app)).get('/auth/me');
    expect(me.status).toBe(401);
    expect(me.body).toMatchObject({ setupRequired: true });
    const login = await signIn(app, 'alex');
    expect(login.res.status).toBe(503);
    expect(login.res.body.message).toContain('holdr-user');
    expect((await request(await listenLoopback(app)).get('/health')).body).toEqual({ ok: true, schemaVersion: repo!.schemaVersion() });
    expect((await request(await listenLoopback(app)).get('/accounts').set('Authorization', `Bearer ${TOKEN}`)).status).toBe(200);
  });
});

describe('GET /health', () => {
  it('reports only ok and schemaVersion without a session, the details with one', async () => {
    const { app } = await build();
    const anonymous = await request(await listenLoopback(app)).get('/health');
    expect(anonymous.status).toBe(200);
    expect(anonymous.body).toEqual({ ok: true, schemaVersion: repo!.schemaVersion() });
    const { cookie } = await signIn(app);
    const full = await request(await listenLoopback(app)).get('/health').set('Cookie', cookie);
    expect(Object.keys(full.body).sort()).toEqual(
      ['accounts', 'db', 'ok', 'schemaVersion', 'service', 'snapshots', 'transactions'].sort(),
    );
  });
});

describe('GET /health on a disposable e2e stack', () => {
  it('shows the run identity with or without a session, re-checked on every call, and no data without one', async () => {
    repo = new SqliteStateRepo({ file: ':memory:' });
    let checks = 0;
    const runId = 'ab'.repeat(16);
    const { app, users } = createApp({
      repo,
      serviceToken: TOKEN,
      allowedOrigins: [ORIGIN],
      snapshotsEnabled: false,
      now: () => clock,
      scryptParams: FAST,
      log: () => undefined,
      e2eIdentity: () => {
        checks += 1;
        return { runId, disposableDataDir: checks < 3 };
      },
    });
    users.createUser('alex', await hashPassword(PASSWORD, FAST), T0);
    const anonymous = await request(await listenLoopback(app)).get('/health');
    expect(anonymous.body).toEqual({ ok: true, schemaVersion: repo.schemaVersion(), e2e: { runId, disposableDataDir: true } });
    const { cookie } = await signIn(app);
    const full = await request(await listenLoopback(app)).get('/health').set('Cookie', cookie);
    expect(full.body).toMatchObject({ service: 'holdr-api', accounts: 0, e2e: { runId, disposableDataDir: true } });
    const changed = await request(await listenLoopback(app)).get('/health');
    expect(changed.body.e2e).toEqual({ runId, disposableDataDir: false });
    expect(checks).toBe(3);
    expect((await request(await listenLoopback(app)).get('/accounts')).status).toBe(401);
  });
});

describe('request helpers', () => {
  const fake = (remoteAddress: string, headers: Record<string, string> = {}) =>
    ({ socket: { remoteAddress }, headers: { host: '127.0.0.1:4000', ...headers } }) as unknown as Request;

  it('trusts forwarding headers only from a loopback peer', () => {
    expect(clientAddress(fake('::ffff:127.0.0.1', { 'x-forwarded-for': '192.168.24.20' }))).toBe('192.168.24.20');
    expect(clientAddress(fake('::1', { 'x-forwarded-for': '6.6.6.6, 100.64.1.2' }))).toBe('100.64.1.2');
    expect(clientAddress(fake('192.168.24.30', { 'x-forwarded-for': '6.6.6.6' }))).toBe('192.168.24.30');
    expect(clientAddress(fake('127.0.0.1', { 'x-forwarded-for': 'not-an-ip' }))).toBe('127.0.0.1');
  });

  it('counts only a loopback peer with a loopback Host and no forwarding headers as a direct local caller', () => {
    expect(isDirectLoopback(fake('127.0.0.1'))).toBe(true);
    expect(isDirectLoopback(fake('::1', { host: '[::1]:4000' }))).toBe(true);
    expect(isDirectLoopback(fake('127.0.0.1', { host: 'localhost:14000' }))).toBe(true);
    expect(isDirectLoopback(fake('127.0.0.1', { 'x-forwarded-for': '127.0.0.1' }))).toBe(false);
    expect(isDirectLoopback(fake('127.0.0.1', { 'tailscale-user-login': 'alex@example.com' }))).toBe(false);
    expect(isDirectLoopback(fake('127.0.0.1', { host: 'holdr.example.ts.net' }))).toBe(false);
    expect(isDirectLoopback(fake('127.0.0.1', { host: '' }))).toBe(false);
    expect(isDirectLoopback(fake('192.168.24.30'))).toBe(false);
  });

  it('recognizes loopback Host headers exactly', () => {
    for (const host of ['127.0.0.1', '127.0.0.1:4000', 'localhost', 'LOCALHOST:4000', '[::1]:4000', '127.8.9.10:1']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of [undefined, '', 'homeserver.local:4000', 'holdr.example.ts.net', 'localhost.evil.example',
      '127.0.0.1.nip.io', 'evil@127.0.0.1', '[::2]:4000', '100.64.100.50:4000', '127.0.0.1:4000/x']) {
      expect(isLoopbackHost(host), String(host)).toBe(false);
    }
  });

  it('parses HOLDR_PUBLIC_ORIGIN strictly', () => {
    expect(parsePublicOrigin(' https://Holdr.example.ts.net/ ')).toBe(HTTPS_ORIGIN);
    expect(parsePublicOrigin('https://holdr.example.ts.net:443')).toBe(HTTPS_ORIGIN);
    expect(parsePublicOrigin('http://127.0.0.1:8888')).toBe('http://127.0.0.1:8888');
    for (const value of ['', 'holdr.example.ts.net', 'https://holdr.example.ts.net/app',
      'https://user104@example.com', 'https://h.example?x=1', 'https://h.example#x', 'ftp://h.example', 'https://']) {
      expect(parsePublicOrigin(value), value).toBeNull();
    }
  });

  it('normalizes the WEB_ORIGIN allowlist', () => {
    expect(parseAllowedOrigins(' http://homeserver.local:8888/ ,https://h.example:443,ftp://x, not a url,,http://127.0.0.1:8888'))
      .toEqual(['http://homeserver.local:8888', 'https://h.example', 'http://127.0.0.1:8888']);
  });
});
